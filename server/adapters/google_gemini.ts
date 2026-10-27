import { AdapterFailure, type AdapterRequest, type AdapterResultLive, type AdapterUsage, type ModelAdapter } from "./types";
import { assertAccountingPermit, markAccountingDispatchStarted } from "./l10-admission";
import { L10_FROZEN_LITERALS } from "./l10-routes";
import { L10_MAX_COMPLETION_TOKENS, L10_MAX_RUN_TOKENS } from "./l10-limits";
import { providerActivation, providerJSON } from "./provider_http";

const ORIGIN = "https://generativelanguage.googleapis.com/v1beta";
const SLOTS = ["integration", "release"] as const;
type Slot = typeof SLOTS[number];
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
type Options = { fetchImpl?: typeof fetch; apiKey?: string; providerRequestsEnabled?: boolean };
type BoundInput = Parameters<NonNullable<ModelAdapter["metering"]>["bounds"]>[0];
type Quote = { slot: Slot; model: string; prompt: string; ceiling: number; inputTokens: number; body: Record<string, unknown>; expires: number; used: boolean };

/** One tool-free, single-candidate Gemini REST request, with no continuation.
 * Preflight is the provider-reported count, not a proven error-free upper bound:
 * https://ai.google.dev/api/tokens
 * Output limits include thinking; usage counts thoughts separately from candidates:
 * https://ai.google.dev/gemini-api/docs/generate-content/thinking
 * https://ai.google.dev/api/generate-content
 */
export class GoogleGeminiAdapter implements ModelAdapter {
  readonly name = "google-gemini";
  readonly makesLiveCalls = true;
  private readonly quotes = new Map<string, Quote>();
  constructor(private readonly options: Options = {}) {}

  readonly metering = {
    version: 1 as const,
    coversInternalCalls: true as const,
    bounds: async (input: BoundInput) => {
      const key = providerActivation("google", this.options);
      if (input.slotId) this.quotes.delete(input.slotId);
      const slot = input.slotId as Slot;
      const model = SLOTS.includes(slot) ? L10_FROZEN_LITERALS[slot] : null;
      if (!model || !model.startsWith("gemini-") || input.runtimeModel !== undefined && input.runtimeModel !== model) {
        throw new AdapterFailure("MODEL_UNAVAILABLE", "Gemini requires an exact frozen Google slot and model", null, false);
      }
      if (typeof input.prompt !== "string" || !count(input.maxCompletionTokens) || input.maxCompletionTokens < 1 || input.maxCompletionTokens > L10_MAX_COMPLETION_TOKENS) {
        throw new AdapterFailure("INVALID_REQUEST", "Invalid Gemini completion bound", null, false);
      }
      if (input.signal?.cancelled()) throw new AdapterFailure("CANCELLED", "Cancelled before Gemini token count", null, false);
      const body = { contents: [{ role: "user", parts: [{ text: input.prompt }] }], tools: [],
        generationConfig: { candidateCount: 1, maxOutputTokens: input.maxCompletionTokens } };
      const { data } = await providerJSON({ url: `${ORIGIN}/models/${encodeURIComponent(model)}:countTokens`, method: "POST",
        headers: { "x-goog-api-key": key }, body: { generateContentRequest: { model: `models/${model}`, ...body } },
        timeoutMs: Math.min(input.timeoutMs ?? 10000, 10000), signal: input.signal, fetchImpl: this.options.fetchImpl });
      if (!count(data.totalTokens)) throw new AdapterFailure("METERING_BOUND_UNAVAILABLE", "Gemini preflight token count is missing or invalid", null, false);
      const totalTokensUpper = data.totalTokens + input.maxCompletionTokens;
      if (!Number.isSafeInteger(totalTokensUpper) || totalTokensUpper >= L10_MAX_RUN_TOKENS) {
        throw new AdapterFailure("BUDGET_EXHAUSTED", "Gemini preflight count and output ceiling exceed the run budget", null, false);
      }
      this.quotes.set(slot, { slot, model, prompt: input.prompt, ceiling: input.maxCompletionTokens, inputTokens: data.totalTokens,
        body, expires: Date.now() + 30000, used: false });
      return { promptTokensUpper: data.totalTokens, totalTokensUpper };
    },
  };

  async call(req: AdapterRequest): Promise<AdapterResultLive> {
    assertAccountingPermit(req.accountingPermit);
    const q = this.quotes.get(req.slotId);
    if (!q || q.used || Date.now() >= q.expires || req.slotId !== q.slot || req.runtimeModel !== q.model || req.prompt !== q.prompt ||
      req.limits.maxCompletionTokens !== q.ceiling || req.limits.maxTotalTokens !== q.inputTokens + q.ceiling ||
      req.limits.maxCliModelCalls !== 1 || req.reservation.promptTokensUpper !== q.inputTokens || req.reservation.totalTokens !== q.inputTokens + q.ceiling) {
      throw new AdapterFailure("INVALID_REQUEST", "Gemini request differs from its one-use preflight quote", null, false);
    }
    if (req.signal.cancelled()) throw new AdapterFailure("CANCELLED", "Cancelled before Gemini dispatch", null, false);
    const key = providerActivation("google", this.options);
    q.used = true;
    markAccountingDispatchStarted(req.accountingPermit);
    const { data, metrics } = await providerJSON({ url: `${ORIGIN}/models/${encodeURIComponent(q.model)}:generateContent`, method: "POST",
      headers: { "x-goog-api-key": key }, body: q.body, timeoutMs: req.timeoutMs, signal: req.signal, fetchImpl: this.options.fetchImpl });
    const u = data.usageMetadata;
    const thoughts = u?.thoughtsTokenCount ?? 0;
    const toolPrompt = u?.toolUsePromptTokenCount ?? 0;
    const cached = u?.cachedContentTokenCount ?? 0;
    if (!u || !count(u.promptTokenCount) || !count(u.candidatesTokenCount) || !count(u.totalTokenCount) ||
      !count(thoughts) || !count(toolPrompt) || !count(cached) || cached > u.promptTokenCount) {
      throw new AdapterFailure("USAGE_INVALID", "Gemini response lacks complete valid token usage", null, false);
    }
    const promptTokens = u.promptTokenCount + toolPrompt;
    const completionTokens = u.candidatesTokenCount + thoughts;
    const totalTokens = promptTokens + completionTokens;
    if (!Number.isSafeInteger(promptTokens) || !Number.isSafeInteger(completionTokens) || !Number.isSafeInteger(totalTokens) || totalTokens !== u.totalTokenCount) {
      throw new AdapterFailure("USAGE_INVALID", "Gemini token usage totals are inconsistent", null, false);
    }
    const usage: AdapterUsage = { promptTokens, completionTokens, totalTokens, coversInternalCalls: true,
      source: "provider-response", fieldPath: "usageMetadata" };
    const actualModel = typeof data.modelVersion === "string" ? data.modelVersion : "";
    const fail = (code: string, message: string): never => {
      const error = new AdapterFailure(code, message, null, false);
      Object.assign(error, { accountingObservation: { usage, metrics, actualModel, outcomeCode: code } });
      throw error;
    };
    if (promptTokens > q.inputTokens || completionTokens > q.ceiling || totalTokens > req.reservation.totalTokens) {
      fail("ACCOUNTING_OVERRUN", "Gemini usage exceeded its provider-count reservation");
    }
    if (actualModel !== q.model) fail("MODEL_MISMATCH", "Gemini returned a different model version");
    if (toolPrompt !== 0 || !Array.isArray(data.candidates) || data.candidates.length !== 1) {
      fail("UNEXPECTED_OUTPUT", "Gemini tool use or multiple candidates are forbidden");
    }
    const candidate = data.candidates[0];
    if (candidate?.finishReason !== "STOP" && candidate?.finishReason !== "MAX_TOKENS") {
      fail("UNEXPECTED_OUTPUT", "Gemini stopped for an unsupported reason");
    }
    if (candidate.content?.role !== "model" || !Array.isArray(candidate.content.parts)) {
      fail("UNEXPECTED_OUTPUT", "Gemini response content is malformed");
    }
    let text = "";
    for (const part of candidate.content.parts) {
      if (typeof part?.text !== "string" || Object.keys(part).some(key => !["text", "thought", "thoughtSignature"].includes(key))) {
        fail("UNEXPECTED_OUTPUT", "Gemini tool or non-text content is forbidden");
      }
      if (part.thought !== undefined && typeof part.thought !== "boolean") fail("UNEXPECTED_OUTPUT", "Gemini thought marker is invalid");
      if (!part.thought) text += part.text;
    }
    if (!text) fail("EMPTY_RESPONSE", "Gemini returned no visible text");
    return { kind: "live", text, actualModel, modelEvidence: { source: "provider-response", fieldPath: "modelVersion" }, usage, metrics };
  }
}
