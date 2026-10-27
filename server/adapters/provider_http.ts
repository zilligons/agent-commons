import { createHash } from "node:crypto";
import { AdapterFailure, type AdapterMetrics } from "./types";
import { L10_MAX_OUTPUT_BYTES } from "./l10-limits";
import { getProviderCredential } from "./provider_credentials";
import { providerHTTPFailure, providerTransportFailure } from "./provider_diagnostics";

export type ProviderOptions = { fetchImpl?: typeof fetch; apiKey?: string; providerRequestsEnabled?: boolean };
const KEY_NAMES = {
  anthropic:["AGENT_COMMONS_ANTHROPIC_API_KEY"],
  xai:["AGENT_COMMONS_XAI_API_KEY"],
  google:["AGENT_COMMONS_GOOGLE_API_KEY", "AGENT_COMMONS_GEMINI_API_KEY"],
} as const;

/** Runtime activation only; neither a credential-store reader nor a logger. */
export function providerActivation(provider:keyof typeof KEY_NAMES, options:ProviderOptions):string {
  const names=KEY_NAMES[provider];
  const key=options.apiKey??names.map(name=>getProviderCredential(name)).find(value=>value?.trim());
  if(!key||!key.trim())throw new AdapterFailure("CREDENTIAL_MISSING",`${names.join(" or ")} is required for this provider route`,null,false);
  const enabled=options.providerRequestsEnabled??process.env.AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED==="1";
  if(!enabled)throw new AdapterFailure("PROVIDER_DISPATCH_DISABLED","Provider requests require explicit runtime activation",null,false);
  return key;
}

/** Bounded, single-attempt HTTP. Refusals never expose provider bodies/headers. */
export async function providerJSON(input:{url:string;method:"GET"|"POST";headers:Record<string,string>;
  body?:Record<string,unknown>;timeoutMs:number;signal?:{cancelled():boolean};fetchImpl?:typeof fetch;
  maxResponseBytes?:number;
}):Promise<{data:any;raw:string;metrics:AdapterMetrics}> {
  if(!Number.isFinite(input.timeoutMs)||input.timeoutMs<=0)throw new AdapterFailure("TIMEOUT","Provider deadline exhausted",null,false);
  if(input.signal?.cancelled())throw new AdapterFailure("CANCELLED","Cancelled before provider request",null,false);
  const maxBytes=input.maxResponseBytes??L10_MAX_OUTPUT_BYTES;
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>32*1024*1024)
    throw new AdapterFailure("INVALID_REQUEST","Invalid provider response byte bound",null,false);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),Math.min(input.timeoutMs,80000));
  const poll=setInterval(()=>{if(input.signal?.cancelled())controller.abort();},50);
  try {
    const response=await(input.fetchImpl??fetch)(input.url,{method:input.method,headers:{"Content-Type":"application/json",...input.headers},
      ...(input.body?{body:JSON.stringify(input.body)}:{}),signal:controller.signal,redirect:"error"});
    if(!response.ok)throw await providerHTTPFailure(response);
    const reader=response.body?.getReader();
    if(!reader)throw new AdapterFailure("USAGE_INVALID","Provider response body is missing",null,false);
    const chunks:Uint8Array[]=[];let length=0;
    while(true){
      const {value,done}=await reader.read();if(done)break;
      length+=value.byteLength;
      if(length>maxBytes){await reader.cancel();throw new AdapterFailure("OUTPUT_OVERFLOW","Provider response exceeded its byte bound",null,false);}
      chunks.push(value);
    }
    const raw=Buffer.concat(chunks).toString("utf8");let data;
    try{data=JSON.parse(raw);}catch{throw new AdapterFailure("USAGE_INVALID","Provider response is not JSON",null,false);}
    if(!data||typeof data!=="object"||Array.isArray(data))throw new AdapterFailure("USAGE_INVALID","Provider response is not an object",null,false);
    return {data,raw,metrics:{exitCode:0,stdoutBytes:length,stdoutSha256:createHash("sha256").update(raw).digest("hex"),
      stderrBytes:0,stderrSha256:createHash("sha256").update("").digest("hex")}};
  }catch(error){
    if(error instanceof AdapterFailure)throw error;
    throw providerTransportFailure(error,{cancelled:input.signal?.cancelled()===true,timedOut:controller.signal.aborted,timeoutMs:Math.min(input.timeoutMs,80000)});
  }finally{clearTimeout(timer);clearInterval(poll);}
}
