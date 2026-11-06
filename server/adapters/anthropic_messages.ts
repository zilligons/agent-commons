import { AdapterFailure, type AdapterRequest, type AdapterResultLive, type AdapterUsage, type ModelAdapter } from "./types";
import { assertAccountingPermit, markAccountingDispatchStarted } from "./l10-admission";
import { L10_FROZEN_LITERALS } from "./l10-routes";
import { L10_MAX_COMPLETION_TOKENS, L10_MAX_RUN_TOKENS } from "./l10-limits";
import { providerActivation, providerJSON } from "./provider_http";

const ORIGIN = "https://api.anthropic.com/v1";
const VERSION = "2023-06-01";
const SLOTS = ["continuity", "collaboration", "security"] as const;
type Slot = typeof SLOTS[number];
type Options = { fetchImpl?: typeof fetch; apiKey?: string; providerRequestsEnabled?: boolean };
type BoundInput = Parameters<NonNullable<ModelAdapter["metering"]>["bounds"]>[0];
type Quote = { slot: Slot; model: string; prompt: string; ceiling: number; inputTokens: number;
  body: Record<string, unknown>; expires: number; used: boolean };
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** One tool-free Messages call using a provider-reported preflight count.
 * https://platform.claude.com/docs/en/build-with-claude/token-counting
 * Anthropic documents this count as an estimate, not a guaranteed upper bound.
 * The authorized reservation uses that count; measured overruns still fail closed.
 */
export class AnthropicMessagesAdapter implements ModelAdapter {
  readonly name = "anthropic-messages";
  readonly makesLiveCalls = true;
  private readonly quotes = new Map<string, Quote>();
  constructor(private readonly options: Options = {}) {}

  readonly metering = {
    version: 1 as const,
    coversInternalCalls: true as const,
    bounds: async (input: BoundInput) => {
      const key = providerActivation("anthropic", this.options);
      if (input.slotId) this.quotes.delete(input.slotId);
      const slot = input.slotId as Slot;
      if (!SLOTS.includes(slot) || input.runtimeModel !== undefined && input.runtimeModel !== L10_FROZEN_LITERALS[slot]) {
        throw new AdapterFailure("MODEL_UNAVAILABLE", "Messages route requires an exact frozen Anthropic slot and model", null, false);
      }
      const model = L10_FROZEN_LITERALS[slot];
      if (typeof input.prompt !== "string" || !count(input.maxCompletionTokens) || input.maxCompletionTokens < 1 || input.maxCompletionTokens > L10_MAX_COMPLETION_TOKENS) {
        throw new AdapterFailure("INVALID_REQUEST", "Invalid Messages completion bound", null, false);
      }
      if (input.signal?.cancelled()) throw new AdapterFailure("CANCELLED", "Cancelled before Messages token count", null, false);
      const body = { model, messages: [{ role: "user", content: input.prompt }], tools: [] };
      const { data } = await providerJSON({
        url: `${ORIGIN}/messages/count_tokens`, method: "POST", headers: this.headers(key), body,
        timeoutMs: Math.min(input.timeoutMs ?? 10000, 10000), signal: input.signal, fetchImpl: this.options.fetchImpl,
      });
      if (!count(data.input_tokens)) {
        throw new AdapterFailure("METERING_BOUND_UNAVAILABLE", "Provider preflight input-token count is missing or invalid", null, false);
      }
      const totalTokensUpper = data.input_tokens + input.maxCompletionTokens;
      if (!Number.isSafeInteger(totalTokensUpper) || totalTokensUpper >= L10_MAX_RUN_TOKENS) {
        throw new AdapterFailure("BUDGET_EXHAUSTED", "The provider preflight count and output ceiling exceed the run budget", null, false);
      }
      this.quotes.set(slot, { slot, model, prompt: input.prompt, ceiling: input.maxCompletionTokens,
        inputTokens: data.input_tokens, body, expires: Date.now() + 30000, used: false });
      return { promptTokensUpper: data.input_tokens, totalTokensUpper };
    },
  };

  async call(req: AdapterRequest): Promise<AdapterResultLive> {
    assertAccountingPermit(req.accountingPermit);
    const q = this.quotes.get(req.slotId);
    if (!q || q.used || Date.now() >= q.expires || req.slotId !== q.slot || req.runtimeModel !== q.model || req.prompt !== q.prompt ||
      req.limits.maxCompletionTokens !== q.ceiling || req.limits.maxTotalTokens !== q.inputTokens + q.ceiling ||
      req.limits.maxCliModelCalls !== 1 || req.reservation.promptTokensUpper !== q.inputTokens ||
      req.reservation.totalTokens !== q.inputTokens + q.ceiling) {
      throw new AdapterFailure("INVALID_REQUEST", "Messages request differs from its one-use metering quote", null, false);
    }
    if (req.signal.cancelled()) throw new AdapterFailure("CANCELLED", "Cancelled before Messages dispatch", null, false);
    const key = providerActivation("anthropic", this.options);
    const body = { ...q.body, max_tokens: q.ceiling, stream: false };
    q.used = true;
    markAccountingDispatchStarted(req.accountingPermit);
    const { data, metrics } = await providerJSON({ url: `${ORIGIN}/messages`, method: "POST", headers: this.headers(key), body,
      timeoutMs: req.timeoutMs, signal: req.signal, fetchImpl: this.options.fetchImpl });
    const u = data.usage;
    const readTokens = u?.cache_read_input_tokens ?? 0;
    const writeTokens = u?.cache_creation_input_tokens ?? 0;
    if (!u || !count(u.input_tokens) || !count(u.output_tokens) || !count(readTokens) || !count(writeTokens)) {
      throw new AdapterFailure("USAGE_INVALID", "Messages response lacks complete valid token usage", null, false);
    }
    const promptTokens = u.input_tokens + readTokens + writeTokens;
    const totalTokens = promptTokens + u.output_tokens;
    if (!Number.isSafeInteger(promptTokens) || !Number.isSafeInteger(totalTokens)) {
      throw new AdapterFailure("USAGE_INVALID", "Messages usage exceeds safe integer bounds", null, false);
    }
    const usage: AdapterUsage = { promptTokens, completionTokens: u.output_tokens, totalTokens,
      coversInternalCalls: true, source: "provider-response", fieldPath: "usage" };
    const actualModel = typeof data.model === "string" ? data.model : "";
    const fail = (code: string, message: string): never => {
      const error = new AdapterFailure(code, message, null, false);
      Object.assign(error, { accountingObservation: { usage, metrics, actualModel, outcomeCode: code } });
      throw error;
    };
    if (promptTokens > q.inputTokens || u.output_tokens > q.ceiling || totalTokens > req.reservation.totalTokens) {
      fail("ACCOUNTING_OVERRUN", "Messages usage exceeded its provider-count reservation");
    }
    if (actualModel !== q.model) fail("MODEL_MISMATCH", "Messages returned a different model");
    if (data.type !== "message" || data.role !== "assistant" || !Array.isArray(data.content)) {
      fail("UNEXPECTED_OUTPUT", "Messages response is not an assistant message");
    }
    let text = "";
    for (const part of data.content) {
      if (part?.type === "text" && typeof part.text === "string") text += part.text;
      else if (part?.type !== "thinking" && part?.type !== "redacted_thinking") {
        fail("UNEXPECTED_OUTPUT", "Messages tool use or other unexpected content is forbidden");
      }
    }
    if (data.stop_reason !== "end_turn" && data.stop_reason !== "max_tokens" && data.stop_reason !== "stop_sequence") {
      fail("UNEXPECTED_OUTPUT", "Messages stopped for an unsupported reason");
    }
    if (!text) fail("EMPTY_RESPONSE", "Messages returned no visible text");
    return { kind: "live", text, actualModel, modelEvidence: { source: "provider-response", fieldPath: "model" }, usage, metrics };
  }

  private headers(key: string): Record<string, string> {
    return { "x-api-key": key, "anthropic-version": VERSION };
  }
}
