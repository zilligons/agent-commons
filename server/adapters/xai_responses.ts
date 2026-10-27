import { AdapterFailure, type AdapterRequest, type AdapterResultLive, type AdapterUsage, type ModelAdapter } from "./types";
import { assertAccountingPermit, markAccountingDispatchStarted } from "./l10-admission";
import { L10_MAX_RUN_TOKENS } from "./l10-limits";
import { providerActivation, providerJSON } from "./provider_http";

const ORIGIN = "https://api.x.ai/v1";
// Archived Forge transport: the active release roster must not retarget xAI.
const MODEL = "grok-4.7";
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
type Options = { fetchImpl?: typeof fetch; apiKey?: string; providerRequestsEnabled?: boolean };
type BoundInput = { prompt: string; maxCompletionTokens: number; slotId?: string; runtimeModel?: string;
  timeoutMs?: number; signal?: { cancelled(): boolean } };
type Quote = { prompt: string; ceiling: number; reportedInputTokens: number; expires: number; used: boolean };

/** Reported text-token preflight, not a proven complete inference input bound:
 * tokenize-text omits inference framing. Actual usage above this quote remains
 * ACCOUNTING_OVERRUN; model context metadata does not determine reservations.
 * Metadata: https://docs.x.ai/developers/rest-api-reference/inference/models
 * Tokenizer: https://docs.x.ai/developers/rest-api-reference/inference/other
 * Usage: https://docs.x.ai/developers/rest-api-reference/inference/responses
 */
export class XAIResponsesAdapter implements ModelAdapter {
  readonly name = "xai-responses";
  readonly makesLiveCalls = true;
  private quote: Quote | null = null;
  constructor(private readonly options: Options = {}) {}

  readonly metering = {
    version: 1 as const,
    coversInternalCalls: true as const,
    bounds: async (input: BoundInput) => {
      this.quote = null;
      if (input.slotId && input.slotId !== "release" || input.runtimeModel && input.runtimeModel !== MODEL)
        throw new AdapterFailure("MODEL_UNAVAILABLE", "Archived xAI Responses requires its frozen grok-4.7 model", null, false);
      if (typeof input.prompt !== "string" || !count(input.maxCompletionTokens) || input.maxCompletionTokens < 1 || input.maxCompletionTokens > 24000)
        throw new AdapterFailure("INVALID_REQUEST", "Invalid xAI Responses completion bound", null, false);
      if (input.signal?.cancelled()) throw new AdapterFailure("CANCELLED", "Cancelled before xAI model metadata request", null, false);
      const key = providerActivation("xai", this.options);
      const { data } = await providerJSON({ url: ORIGIN + "/models", method: "GET",
        headers: { Authorization: "Bearer " + key }, timeoutMs: Math.min(input.timeoutMs ?? 10000, 10000),
        signal: input.signal, fetchImpl: this.options.fetchImpl });
      const models = Array.isArray(data.data) ? data.data : [];
      const metadata = models.find((entry: any) => entry?.id === MODEL) ??
        models.find((entry: any) => typeof entry?.id === "string" && Array.isArray(entry.aliases) &&
          entry.aliases.every((alias: unknown) => typeof alias === "string") && entry.aliases.includes(MODEL));
      if (!metadata)
        throw new AdapterFailure("MODEL_UNAVAILABLE", "xAI catalog does not contain the frozen model or an explicit alias", null, false);
      const { data: tokenized } = await providerJSON({ url: ORIGIN + "/tokenize-text", method: "POST",
        headers: { Authorization: "Bearer " + key }, body: { model: MODEL, text: input.prompt },
        timeoutMs: Math.min(input.timeoutMs ?? 10000, 10000), signal: input.signal, fetchImpl: this.options.fetchImpl,
        maxResponseBytes: 32 * 1024 * 1024 });
      if (!Array.isArray(tokenized.token_ids) || !tokenized.token_ids.every((token: any) =>
        token && typeof token === "object" && !Array.isArray(token) && count(token.token_id) &&
        typeof token.string_token === "string" && Array.isArray(token.token_bytes) &&
        token.token_bytes.every((byte: unknown) => count(byte) && byte <= 255)))
        throw new AdapterFailure("USAGE_INVALID", "xAI tokenizer returned malformed token objects", null, false);
      const reportedInputTokens = tokenized.token_ids.length;
      const totalTokensUpper = reportedInputTokens + input.maxCompletionTokens;
      if (!Number.isSafeInteger(totalTokensUpper) || totalTokensUpper >= L10_MAX_RUN_TOKENS)
        throw new AdapterFailure("BUDGET_EXHAUSTED", "xAI reported text-token preflight and output ceiling exceed the shared budget", null, false);
      this.quote = { prompt: input.prompt, ceiling: input.maxCompletionTokens, reportedInputTokens,
        expires: Date.now() + 30000, used: false };
      return { promptTokensUpper: reportedInputTokens, totalTokensUpper };
    },
  };

  async call(req: AdapterRequest): Promise<AdapterResultLive> {
    assertAccountingPermit(req.accountingPermit);
    const quote = this.quote;
    if (!quote || quote.used || Date.now() > quote.expires || req.slotId !== "release" || req.runtimeModel !== MODEL ||
      req.prompt !== quote.prompt || req.limits.maxCompletionTokens !== quote.ceiling ||
      req.limits.maxTotalTokens !== quote.reportedInputTokens + quote.ceiling || req.limits.maxCliModelCalls !== 1 ||
      req.reservation.promptTokensUpper !== quote.reportedInputTokens || req.reservation.totalTokens !== quote.reportedInputTokens + quote.ceiling)
      throw new AdapterFailure("INVALID_REQUEST", "xAI Responses request differs from its reported text-token preflight quote", null, false);
    if (req.signal.cancelled()) throw new AdapterFailure("CANCELLED", "Cancelled before xAI provider dispatch", null, false);
    const key = providerActivation("xai", this.options);
    quote.used = true;
    markAccountingDispatchStarted(req.accountingPermit);
    const { data, metrics } = await providerJSON({ url: ORIGIN + "/responses", method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: { model: MODEL, input: quote.prompt, tools: [], tool_choice: "none", max_output_tokens: quote.ceiling,
        store: false, stream: false, background: false, truncation: "disabled" },
      timeoutMs: req.timeoutMs, signal: req.signal, fetchImpl: this.options.fetchImpl });
    const u = data.usage;
    if (!u || !count(u.input_tokens) || !count(u.output_tokens) || !count(u.total_tokens) ||
      !Number.isSafeInteger(u.input_tokens + u.output_tokens) || u.total_tokens !== u.input_tokens + u.output_tokens)
      throw new AdapterFailure("USAGE_INVALID", "xAI response lacks complete token usage", null, false);
    for (const [details, field, upper] of [
      [u.input_tokens_details, "cached_tokens", u.input_tokens],
      [u.output_tokens_details, "reasoning_tokens", u.output_tokens],
    ] as const) {
      if (details?.[field] !== undefined && (!count(details[field]) || details[field] > upper))
        throw new AdapterFailure("USAGE_INVALID", "xAI usage breakdown is invalid", null, false);
    }
    const usage: AdapterUsage = { promptTokens: u.input_tokens, completionTokens: u.output_tokens, totalTokens: u.total_tokens,
      coversInternalCalls: true, source: "provider-response", fieldPath: "usage" };
    const actualModel = typeof data.model === "string" ? data.model : "";
    const fail = (code: string, message: string): never => {
      const error = new AdapterFailure(code, message, null, false);
      Object.assign(error, { accountingObservation: { usage, metrics, actualModel, outcomeCode: code } });
      throw error;
    };
    if (u.input_tokens > quote.reportedInputTokens || u.output_tokens > quote.ceiling || u.total_tokens > req.reservation.totalTokens)
      fail("ACCOUNTING_OVERRUN", "xAI usage exceeded its reported text-token preflight reservation");
    if (u.num_server_side_tools_used !== undefined && (!count(u.num_server_side_tools_used) || u.num_server_side_tools_used !== 0))
      fail("UNEXPECTED_OUTPUT", "xAI server-side tools are forbidden on this bounded route");
    if (actualModel !== MODEL) fail("MODEL_MISMATCH", "xAI returned a different model");
    if (data.status !== "completed") fail("INCOMPLETE_RESPONSE", "xAI response did not complete");
    let text = "";
    if (Array.isArray(data.output)) for (const item of data.output) {
      if (item?.type === "reasoning") continue;
      if (item?.type !== "message") fail("UNEXPECTED_OUTPUT", "xAI tool or unexpected output is forbidden");
      if (Array.isArray(item.content)) for (const part of item.content) {
        if (part?.type === "output_text" && typeof part.text === "string") text += part.text;
        else if (part?.type !== "refusal") fail("UNEXPECTED_OUTPUT", "Unexpected xAI response content");
      }
    }
    if (!text) fail("EMPTY_RESPONSE", "xAI returned no visible text");
    return { kind: "live", text, actualModel, modelEvidence: { source: "provider-response", fieldPath: "model" }, usage, metrics };
  }
}
