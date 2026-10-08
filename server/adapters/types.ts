/**
 * L2 adapter layer — type contract (pre-code, per the project design §4).
 * L10 — extended type contract for live CLIs (per the project design
 *   §e L128-130 + §g.2). The seam is
 *   `CohortConsole.callForSlot(member, prompt, generation, timeoutMs)`.
 *
 * On the default path (no config, no AGENT_COMMONS_ADAPTER) it delegates to
 * `CohortConsole.call(model, prompt, generation, timeoutMs)` — the unchanged
 * spawn of `python server/cohort_bridge.py` — so the three existing test stubs
 * at server/cohort.test.ts:21,34,45 (which stub `c.call`) keep working.
 *
 */

/** L2 base fields (every adapter MUST consume these). */
export type AdapterRequestBase = {
  readonly slotId: string;          // cohort member id, e.g. "continuity" (never used to pick a model)
  readonly historicalModel: string; // member.model from shared/cohort.ts — the slot's declared model
  readonly runtimeModel: string;    // the model id the adapter will actually call (config; = historicalModel on the default path)
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly signal: { cancelled: () => boolean }; // generation/cancellation check; adapters poll like cohort.ts:187
};

/** L10 §e L128: per-call slot reservation. */
export type AdapterLimits = {
  readonly maxCompletionTokens: number;
  readonly maxTotalTokens: number;
  readonly maxCliModelCalls: 1; // off in slice 1
};

/** L10 §e L128: reservation covers prompt+gen. */
export type AdapterReservation = {
  readonly id: string;
  readonly promptTokensUpper: number;
  readonly totalTokens: number;
};

/** L10 live adapter request — frozen map + reservation + run id. */
export type AdapterRequest = AdapterRequestBase & {
  readonly runId: string;
  readonly callId: string;
  readonly limits: AdapterLimits;
  readonly reservation: AdapterReservation;
};

/** L2 base result — every adapter returns this at minimum. */
export type AdapterResult = { readonly text: string };

/** R7 (rework 3, v3 §e L130-131): usage as reported by the child envelope.
 *  v3's naming is prompt/completion; internal-call coverage records
 *  whether the numbers include the CLI's own internal calls or only the
 *  primary call. source + fieldPath locate the values in the envelope so
 *  a reviewer can re-derive them. Missing/partial values propagate as
 *  null (the seam DOES NOT estimate). */
export type AdapterUsage = {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
  readonly coversInternalCalls: boolean;
  readonly source: "cli-envelope";
  readonly fieldPath: string;
};

/** R7 (rework 3): the discriminated result. A live adapter returns
 *  { kind:"live", ... } with the observed model, evidence, usage and
 *  metrics; an offline stub returns { kind:"offline", text }. The seam
 *  (callForSlot) returns the typed result, never a bare string. */
export type AdapterResultLive = AdapterResult & {
  readonly kind: "live";
  readonly actualModel: string;
  readonly modelEvidence: AdapterModelEvidence;
  readonly usage: AdapterUsage | null;
  readonly metrics: AdapterMetrics;
};
export type AdapterResultOffline = AdapterResult & { readonly kind: "offline" };
export type AdapterResultTyped = AdapterResultLive | AdapterResultOffline;

/** L10 §e L130 — observation of the actual model the child reported. */
export type AdapterModelEvidence = {
  readonly source: "cli-envelope";   // future: "host-cookie", "wrapper-banner"
  readonly fieldPath: string;        // e.g. "stop_reason.model" for Anthropic envelopes
};

/** L10 §g.2 — diagnostics are exit code + byte counts + sha256; no model
 *  stdout/stderr bytes ever enter these fields. */
export type AdapterMetrics = {
  readonly exitCode: number;
  readonly stdoutBytes: number;
  readonly stdoutSha256: string;
  readonly stderrBytes: number;
  readonly stderrSha256: string;
};

/** L10 live extension: the observed model, the evidence, and the metrics
 *  a live CLI child returned. The L2 `text` field stays at the top level
 *  so callForSlot can continue to read `.text` without rewriting cohort.ts.
 *  An adapter that ran a live child returns AdapterResult & AdapterLiveExtras;
 *  an offline stub returns AdapterResult (text only).
 *
 *  Missing actualModel or modelEvidence is `MODEL_EVIDENCE_MISSING`; a
 *  child whose evidence proves a different model is `MODEL_MISMATCH`. */
export type AdapterLiveExtras = {
  readonly actualModel: string;
  readonly modelEvidence: AdapterModelEvidence;
  readonly usage: AdapterUsage | null;
  readonly metrics: AdapterMetrics;
};

export type AdapterErrorShape = {
  code: string;                 // one of the 9 ERROR_MESSAGES keys in cohort_bridge.py:6-16
  message: string;              // safe, static text — never headers, URLs, key material
  transportStatus: string | null;
  retryable: boolean;
};

/**
 * The exact error shape AdapterFailure already has (cohort.ts:12-14) and
 * recordAdapter already consumes (cohort.ts:106-112). Moved here from cohort.ts
 * so adapters can throw it without importing the console. cohort.ts re-exports.
 */
export class AdapterFailure extends Error {
  public poisonNotRecorded?: string;
  public pollerError?: Error;
  public observerError?: Error;
  constructor(
    public code: string,
    message: string,
    public transportStatus: string | null = null,
    public retryable = false,
    /** R9 (rework 3): safe failure metadata — exit/count/hash only, NEVER
     *  stream bodies. Populated on overflow/timeout rejections so the
     *  caller can record the same diagnostic shape a close would have
     *  produced. */
    public diagnostics?: { exitCode: number | null; stdoutBytes: number; stdoutSha256: string; stderrBytes: number; stderrSha256: string },
    poisonNotRecorded?: string,
  ) {
    super(message);
    this.name = "AdapterFailure";
    if (poisonNotRecorded) {
      this.poisonNotRecorded = poisonNotRecorded;
    }
  }
}

export interface ModelAdapter {
  readonly name: string;                    // "preview-bridge" | "stub" | future names
  readonly makesLiveCalls: boolean;         // stub=false, preview-bridge=true, future real adapters=true
  call(req: AdapterRequest): Promise<AdapterResultTyped>; // throws AdapterFailure-compatible error on failure
}