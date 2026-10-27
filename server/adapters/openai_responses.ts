import { createHash } from "node:crypto";
import { AdapterFailure, type AdapterRequest, type AdapterResultLive, type AdapterUsage, type AdapterProviderUsage, type ModelAdapter } from "./types";
import { assertAccountingPermit, markAccountingDispatchStarted } from "./l10-admission";
import { L10_FROZEN_LITERALS } from "./l10-routes";
import { L10_MAX_OUTPUT_BYTES, L10_MAX_RUN_TOKENS } from "./l10-limits";
import { getProviderCredential } from "./provider_credentials";
import { providerHTTPFailure, providerTransportFailure } from "./provider_diagnostics";

const ORIGIN = "https://api.openai.com/v1";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
type Options = { fetchImpl?: typeof fetch; apiKey?: string; providerRequestsEnabled?: boolean };
type Quote = { model: string; prompt: string; ceiling: number; inputTokens: number; body: Record<string, unknown>; expires: number; used: boolean };

/** A single tool-free Responses request, never a CLI/provider chain.
 * Exact count: https://developers.openai.com/api/docs/guides/token-counting
 * max_output_tokens includes visible output and hidden reasoning tokens.
 */
export class OpenAIResponsesAdapter implements ModelAdapter {
  readonly name = "openai-responses";
  readonly makesLiveCalls = true;
  private readonly quotes = new Map<string, Quote>();
  constructor(private readonly options: Options = {}) {}

  private activation(): string {
    // Runtime-only lookup. This task never inspects credential stores or values.
    const key = this.options.apiKey ?? getProviderCredential("AGENT_COMMONS_OPENAI_API_KEY");
    if (!key || !key.trim()) throw new AdapterFailure("CREDENTIAL_MISSING", "AGENT_COMMONS_OPENAI_API_KEY is required for OpenAI Responses routes", null, false);
    const enabled = this.options.providerRequestsEnabled ?? process.env.AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED === "1";
    if (!enabled) throw new AdapterFailure("PROVIDER_DISPATCH_DISABLED", "Provider requests are disabled; explicit runtime activation is required", null, false);
    return key;
  }

  readonly metering = {
    version: 1 as const,
    coversInternalCalls: true as const,
    bounds: async (input: {prompt: string;maxCompletionTokens: number;slotId?:string;runtimeModel?:string;timeoutMs?:number;signal?:{cancelled():boolean}}) => {
      const slotId = input.slotId ?? "governance";
      this.quotes.delete(slotId);
      const model = slotId === "governance" ? L10_FROZEN_LITERALS.governance :
        slotId === "sustainability" ? L10_FROZEN_LITERALS.sustainability : null;
      if (!model || input.runtimeModel && input.runtimeModel !== model)
        throw new AdapterFailure("MODEL_UNAVAILABLE", "Responses route requires the frozen OpenAI model for its exact slot", null, false);
      if (typeof input.prompt !== "string" || !count(input.maxCompletionTokens) || input.maxCompletionTokens < 16 || input.maxCompletionTokens > 24000)
        throw new AdapterFailure("INVALID_REQUEST", "Invalid Responses completion bound", null, false);
      if (input.signal?.cancelled()) throw new AdapterFailure("CANCELLED", "Cancelled before token count", null, false);
      const key = this.activation();
      const { data: availableModel } = await this.request("/models/" + encodeURIComponent(model), undefined, key,
        Math.min(input.timeoutMs ?? 10000,10000), input.signal, "GET");
      if (availableModel.id !== model)
        throw new AdapterFailure("MODEL_MISMATCH", "Provider model metadata differs from the frozen model", null, false);
      const body = { model, input: input.prompt, tools: [], tool_choice: "none", truncation: "disabled" };
      const { data } = await this.request("/responses/input_tokens", body, key, Math.min(input.timeoutMs ?? 10000,10000),input.signal);
      if (data.object !== "response.input_tokens" || !count(data.input_tokens))
        throw new AdapterFailure("USAGE_INVALID", "Provider input-token count is missing or invalid", null, false);
      const totalTokensUpper = data.input_tokens + input.maxCompletionTokens;
      if (!Number.isSafeInteger(totalTokensUpper) || totalTokensUpper >= L10_MAX_RUN_TOKENS)
        throw new AdapterFailure("BUDGET_EXHAUSTED", "Exact input count and output bound exceed the run budget", null, false);
      this.quotes.set(slotId, { model, prompt: input.prompt, ceiling: input.maxCompletionTokens, inputTokens: data.input_tokens,
        body, expires: Date.now()+30000, used: false });
      return { promptTokensUpper: data.input_tokens, totalTokensUpper };
    },
  };

  async call(req: AdapterRequest): Promise<AdapterResultLive> {
    assertAccountingPermit(req.accountingPermit);
    const q=this.quotes.get(req.slotId);
    if (!q || q.used || Date.now()>q.expires || req.runtimeModel!==q.model || req.prompt!==q.prompt ||
      req.limits.maxCompletionTokens!==q.ceiling || req.limits.maxTotalTokens!==q.inputTokens+q.ceiling ||
      req.limits.maxCliModelCalls!==1 || req.reservation.promptTokensUpper!==q.inputTokens ||
      req.reservation.totalTokens!==q.inputTokens+q.ceiling)
      throw new AdapterFailure("INVALID_REQUEST", "Responses request differs from its exact metering quote", null, false);
    if (req.signal.cancelled()) throw new AdapterFailure("CANCELLED", "Cancelled before provider dispatch", null, false);
    const key=this.activation();
    q.used=true;
    markAccountingDispatchStarted(req.accountingPermit);
    const {data,raw}=await this.request("/responses",{...q.body,service_tier:"default",max_output_tokens:q.ceiling,store:false,stream:false,background:false},key,req.timeoutMs,req.signal);
    const metrics={exitCode:0,stdoutBytes:Buffer.byteLength(raw),stdoutSha256:hash(raw),stderrBytes:0,stderrSha256:hash("")};
    const u=data.usage;
    if (!u || !count(u.input_tokens) || !count(u.output_tokens) || !count(u.total_tokens) ||
      !Number.isSafeInteger(u.input_tokens+u.output_tokens) || u.total_tokens!==u.input_tokens+u.output_tokens)
      throw new AdapterFailure("USAGE_INVALID", "Provider response lacks complete token usage", null, false);
    // Detail counts are subsets of input/output; never double-charge them.
    for(const [details,field,upper] of [
      [u.input_tokens_details,"cached_tokens",u.input_tokens],
      [u.input_tokens_details,"cache_write_tokens",u.input_tokens],
      [u.output_tokens_details,"reasoning_tokens",u.output_tokens],
    ] as const) {
      if(details?.[field]!==undefined&&(!count(details[field])||details[field]>upper))
        throw new AdapterFailure("USAGE_INVALID", "Provider usage breakdown is invalid", null, false);
    }
    const usage:AdapterUsage={promptTokens:u.input_tokens,completionTokens:u.output_tokens,totalTokens:u.total_tokens,
      coversInternalCalls:true,source:"provider-response",fieldPath:"usage"};
    const providerUsage:AdapterProviderUsage={input_tokens:u.input_tokens,output_tokens:u.output_tokens,total_tokens:u.total_tokens,
      input_tokens_details:{cached_tokens:u.input_tokens_details?.cached_tokens??null,
        cache_write_tokens:u.input_tokens_details?.cache_write_tokens??null},
      output_tokens_details:{reasoning_tokens:u.output_tokens_details?.reasoning_tokens??null}};
    const actualModel=typeof data.model==="string"?data.model:"";
    const fail=(code:string,message:string):never=>{
      const error=new AdapterFailure(code,message,null,false);
      Object.assign(error,{accountingObservation:{usage,metrics,actualModel,outcomeCode:code,providerUsage}});
      throw error;
    };
    if(u.input_tokens>q.inputTokens||u.output_tokens>q.ceiling||u.total_tokens>req.reservation.totalTokens)
      fail("ACCOUNTING_OVERRUN","Provider usage exceeded its proven reservation");
    if(actualModel!==q.model)fail("MODEL_MISMATCH","Provider returned a different model");
    if(data.status!=="completed")fail("INCOMPLETE_RESPONSE","Provider response did not complete");
    let text="";
    if(Array.isArray(data.output)) for(const item of data.output) {
      if(item?.type==="reasoning")continue; // already included in usage.output_tokens
      if(item?.type!=="message")fail("UNEXPECTED_OUTPUT","Tool or other unexpected output is forbidden");
      if(Array.isArray(item.content))for(const part of item.content) {
        if(part?.type==="output_text"&&typeof part.text==="string")text+=part.text;
        else if(part?.type!=="refusal")fail("UNEXPECTED_OUTPUT","Unexpected provider content type");
      }
    }
    if(!text)fail("EMPTY_RESPONSE","Provider returned no visible text");
    return {kind:"live",text,actualModel,modelEvidence:{source:"provider-response",fieldPath:"model"},usage,metrics,providerUsage};
  }

  private async request(path:string,body:Record<string,unknown>|undefined,key:string,timeoutMs:number,signal?:{cancelled():boolean},method:"GET"|"POST"="POST"):Promise<{data:any;raw:string}> {
    if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new AdapterFailure("TIMEOUT","Provider deadline exhausted",null,false);
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),Math.min(timeoutMs,80000));
    const poll=setInterval(()=>{if(signal?.cancelled())controller.abort();},50);
    try {
      const response=await (this.options.fetchImpl??fetch)(ORIGIN+path,{
        method,headers:{"Content-Type":"application/json",Authorization:"Bearer "+key},
        ...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal,redirect:"error",
      });
      if(!response.ok)throw await providerHTTPFailure(response);
      const reader=response.body?.getReader();
      if(!reader)throw new AdapterFailure("USAGE_INVALID","Provider response body is missing",null,false);
      const chunks:Uint8Array[]=[];let length=0;
      while(true){
        const {value,done}=await reader.read();if(done)break;
        length+=value.byteLength;
        if(length>L10_MAX_OUTPUT_BYTES){await reader.cancel();throw new AdapterFailure("OUTPUT_OVERFLOW","Provider response exceeds the bounded output size",null,false);}
        chunks.push(value);
      }
      const raw=Buffer.concat(chunks).toString("utf8");let data;
      try{data=JSON.parse(raw);}catch{throw new AdapterFailure("USAGE_INVALID","Provider response is not valid JSON",null,false);}
      if(!data||typeof data!=="object"||Array.isArray(data))throw new AdapterFailure("USAGE_INVALID","Provider response is not an object",null,false);
      return {data,raw};
    }catch(error){
      if(error instanceof AdapterFailure)throw error;
      throw providerTransportFailure(error,{cancelled:signal?.cancelled()??false,timedOut:controller.signal.aborted,timeoutMs});
    }finally{clearTimeout(timer);clearInterval(poll);}
  }
}
