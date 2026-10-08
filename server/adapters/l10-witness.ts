/**
 * L10 — shared witness + envelope normalizer (rework 3, item R5; v3 R1 +
 * §e L130-131). ONE module used by the adapters AND the harness (v3
 * L118: same modules). Two responsibilities:
 *
 * 1. witnessFromOffset: read model-ledger.jsonl from a PRE-SPAWN byte
 *    offset and correlate the CHILD pid (never the parent process.pid —
 *    an earlier observer recorded the harness correlating its own pid while
 *    the fixture child had a different pid and still passing) + lane
 *    "max" + seat (configured via AGENT_COMMONS_WITNESS_SEATS) + req/eff
 *    == frozen literal, on rows appended AFTER the offset. Never searches
 *    the whole log.
 *
 * 2. normalizeCliEnvelope: parse the CLI's structured JSON envelope and
 *    extract actualModel + usage through a DECLARED field path. A
 *    normalizer NEVER derives the model from plain stdout text (a prior
 *    slice derived actualModel from stdout lines).
 *
 * Brief rev 4 R3: the seat list is the configured
 * AGENT_COMMONS_WITNESS_SEATS, NOT a hard-coded constant. Tests pass the
 * seats via the resolver snapshot; the witness reads the SAME frozen
 * seats as the route.
 *
 */
import { readFileSync, existsSync } from "node:fs";
import type { AdapterUsage } from "./types";
import { getResolvedL10Binaries } from "./config";

export type WitnessVerdict = "OK" | "ROUTE_WITNESS_MISSING" | "ROUTE_WITNESS_MISMATCH" | "NOT_EVALUATED";

export type WitnessResult = {
  verdict: WitnessVerdict;
  present: boolean;
  match: boolean;
  /** The correlated row's values when present (for the report row —
   *  a prior slice omitted pid/lane/seat/req/eff from the report). */
  correlated?: { pid: number; lane: string; seat: string; req: string; eff: string };
};

/**
 * Read `ledgerPath` from byte `offset`; correlate a row appended AFTER
 * the offset with childPid + lane:"max" + seat in the configured
 * AGENT_COMMONS_WITNESS_SEATS + req/eff == literal. Rows for other
 * pids are ignored. A matching-pid row with wrong lane/seat/model
 * is MISMATCH (an explicit wrong witness); no matching row is
 * MISSING. A configured but missing/unreadable/empty/malformed
 * ledger also returns MISSING (brief rev 4 R2 fail closed).
 * is MISSING (v3: unreadable/malformed witness → ROUTE_WITNESS_MISSING).
 */
/**
 * F1 (rework 18): Parse ledger timestamp in either seconds (10-digit integer)
 * or milliseconds (13-digit integer), normalizing both to milliseconds.
 * Any other shape fails closed (returns null).
 */
export function normalizeLedgerTimestamp(ts: unknown): number | null {
  if (ts === undefined || ts === null) return null;
  let num: number;
  if (typeof ts === "number") {
    num = ts;
  } else if (typeof ts === "string") {
    const trimmed = ts.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    num = Number(trimmed);
  } else {
    return null;
  }
  if (!Number.isSafeInteger(num)) return null;

  // 10 digits: seconds (e.g. 1_000_000_000 to 9_999_999_999) -> convert to ms
  if (num >= 1_000_000_000 && num <= 9_999_999_999) {
    return num * 1000;
  }
  // 13 digits: milliseconds (e.g. 1_000_000_000_000 to 9_999_999_999_999) -> keep as ms
  if (num >= 1_000_000_000_000 && num <= 9_999_999_999_999) {
    return num;
  }
  return null;
}

export interface WitnessWindowOptions {
  launchTimeMs?: number;
  settleTimeMs?: number;
  maxAgeMs?: number;
  allowFixtureTs?: boolean;
}

export function witnessFromOffset(
  ledgerPath: string,
  offset: number,
  childPid: number,
  literal: string,
  windowOpts?: WitnessWindowOptions,
): WitnessResult {
  // Brief rev 4 R2: the witness fails closed. A configured ledger that is
  // missing, unreadable, empty, or malformed gives ROUTE_WITNESS_MISSING
  // (the same verdict f7ebb86 returned). The "ledger unset" / "seats unset"
  // cases are STARTUP-time decisions (getClaudeRouteResolution disables the
  // Claude route) — the witness never runs in that case. An empty
  // ledgerPath reaching the witness is treated as missing.
  if (ledgerPath === "" || ledgerPath === undefined || ledgerPath === null) {
    return { verdict: "ROUTE_WITNESS_MISSING", present: false, match: false };
  }
  let raw: string;
  try {
    if (!existsSync(ledgerPath)) return { verdict: "ROUTE_WITNESS_MISSING", present: false, match: false };
    raw = readFileSync(ledgerPath, "utf8");
  } catch {
    return { verdict: "ROUTE_WITNESS_MISSING", present: false, match: false };
  }
  if (raw.trim() === "") return { verdict: "ROUTE_WITNESS_MISSING", present: false, match: false };
  // Read the configured seats from the SAME frozen resolver snapshot as
  // the rest of the route (brief rev 4 R3: no hard-coded seat list).
  const seatR = getResolvedL10Binaries().witnessSeats;
  if (seatR.status !== "enabled") {
    return { verdict: "ROUTE_WITNESS_MISSING", present: false, match: false };
  }
  const configuredSeats = seatR.seats;
  const after = Buffer.from(raw, "utf8").subarray(offset).toString("utf8");
  let sawWrong = false;

  for (const line of after.split("\n").filter(Boolean)) {
    let row: { ts?: number | string; pid?: number; lane?: string; seat?: string; req?: string; eff?: string };
    try { row = JSON.parse(line); } catch { return { verdict: "ROUTE_WITNESS_MISSING", present: false, match: false }; }
    if (row.pid !== childPid) continue;
    const laneOk = row.lane === "max";
    const seatOk = typeof row.seat === "string" && configuredSeats.includes(row.seat);
    const modelOk = row.req === literal && row.eff === literal;

    let timeOk = true;
    if (windowOpts?.launchTimeMs !== undefined) {
      if (row.ts === undefined || row.ts === null) {
        timeOk = false;
      } else if (row.ts === "fixture") {
        timeOk = !!windowOpts.allowFixtureTs;
      } else {
        const rowTime = normalizeLedgerTimestamp(row.ts);
        if (rowTime === null) {
          timeOk = false;
        } else {
          const launchTimeMs = windowOpts.launchTimeMs;
          const settleTimeMs = windowOpts.settleTimeMs ?? Date.now();
          if (rowTime < launchTimeMs - 5000 || rowTime > settleTimeMs + 5000) {
            timeOk = false;
          }
        }
      }
    }

    if (laneOk && seatOk && modelOk && timeOk) {
      return {
        verdict: "OK", present: true, match: true,
        correlated: { pid: row.pid, lane: row.lane!, seat: row.seat!, req: row.req!, eff: row.eff! },
      };
    }
    sawWrong = true;
  }
  if (sawWrong) return { verdict: "ROUTE_WITNESS_MISMATCH", present: true, match: false };
  return { verdict: "ROUTE_WITNESS_MISSING", present: false, match: false };
}

/**
 * Normalize a CLI JSON envelope into actualModel + usage. The envelope
 * MUST be structured JSON (the real CLIs emit JSON with --output-format
 * json); a plain-text stdout is NOT an envelope and yields
 * { ok:false, code:"MODEL_EVIDENCE_MISSING" } — the model never comes
 * from plain text.
 *
 * Field paths (declared per route; the fixture fixtures shape like the
 * real envelopes):
 *   claude: top-level "model"; usage at "usage" {prompt_tokens, completion_tokens}
 *   codex:  top-level "model"; usage at "usage" {prompt_tokens, completion_tokens}
 *   grok:   top-level "model"; usage at "usage" {prompt_tokens, completion_tokens}
 */
export function normalizeCliEnvelope(stdoutText: string, opts: { route: "claude" | "codex" | "grok" }):
  | { ok: true; actualModel: string; modelEvidence: { source: "cli-envelope"; fieldPath: string }; usage: AdapterUsage | null }
  | { ok: false; code: "MODEL_EVIDENCE_MISSING" | "MODEL_MISMATCH" | "MODEL_EVIDENCE_AMBIGUOUS"; reason: string } {
  if (opts.route === "codex") {
    const lines = stdoutText.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) {
      return { ok: false, code: "MODEL_EVIDENCE_MISSING", reason: "stdout is empty; no JSONL events" };
    }
    let actualModel: string | null = null;
    let fieldPath = "";
    let usage: AdapterUsage | null = null;

    for (const line of lines) {
      let evt: unknown;
      try { evt = JSON.parse(line); } catch { continue; }
      if (evt === null || typeof evt !== "object" || Array.isArray(evt)) continue;
      const obj = evt as Record<string, unknown>;

      // Documented in OpenAI non-interactive mode (codex exec --json):
      // Named events with declared model field:
      // - turn.completed / response.completed / turn.started / response.done: obj.model or obj.response.model
      // - Standalone / fixture event: obj.model
      if (typeof obj.type === "string") {
        if (
          obj.type === "turn.completed" ||
          obj.type === "response.completed" ||
          obj.type === "turn.started" ||
          obj.type === "response.done"
        ) {
          const resp = (obj.response && typeof obj.response === "object") ? (obj.response as Record<string, unknown>) : null;
          const candidate = (typeof obj.model === "string" && obj.model.trim())
            ? obj.model.trim()
            : (typeof resp?.model === "string" && resp.model.trim() ? resp.model.trim() : null);
          if (candidate) {
            actualModel = candidate;
            fieldPath = obj.model ? `${obj.type}.model` : `${obj.type}.response.model`;
          }
          const u = (obj.usage ?? resp?.usage) as Record<string, unknown> | undefined;
          if (u && typeof u === "object") {
            const pt = u.prompt_tokens;
            const ct = u.completion_tokens;
            usage = {
              promptTokens: typeof pt === "number" ? pt : null,
              completionTokens: typeof ct === "number" ? ct : null,
              totalTokens: (typeof pt === "number" && typeof ct === "number") ? pt + ct : null,
              coversInternalCalls: u.covers_internal_calls === true,
              source: "cli-envelope",
              fieldPath: obj.usage ? `${obj.type}.usage` : `${obj.type}.response.usage`,
            };
          }
        }
      } else if (typeof obj.model === "string" && obj.model.trim() !== "") {
        actualModel = obj.model.trim();
        fieldPath = "model";
        const u = obj.usage as Record<string, unknown> | undefined;
        if (u && typeof u === "object") {
          const pt = u.prompt_tokens;
          const ct = u.completion_tokens;
          usage = {
            promptTokens: typeof pt === "number" ? pt : null,
            completionTokens: typeof ct === "number" ? ct : null,
            totalTokens: (typeof pt === "number" && typeof ct === "number") ? pt + ct : null,
            coversInternalCalls: u.covers_internal_calls === true,
            source: "cli-envelope",
            fieldPath: "usage",
          };
        }
      }
    }

    if (!actualModel) {
      return { ok: false, code: "MODEL_EVIDENCE_MISSING", reason: "no declared model field in codex jsonl stream" };
    }
    return {
      ok: true,
      actualModel,
      modelEvidence: { source: "cli-envelope", fieldPath },
      usage,
    };
  }

  if (opts.route === "claude") {
    let env: unknown;
    try { env = JSON.parse(stdoutText); }
    catch { return { ok: false, code: "MODEL_EVIDENCE_MISSING", reason: "stdout is not a structured JSON envelope" }; }
    if (env === null || typeof env !== "object" || Array.isArray(env)) {
      return { ok: false, code: "MODEL_EVIDENCE_MISSING", reason: "envelope is not a JSON object" };
    }
    const obj = env as Record<string, unknown>;

    // 1. Require type === "result", is_error !== true, and string result
    if (obj.type !== "result") {
      return { ok: false, code: "MODEL_EVIDENCE_MISSING", reason: `envelope type is "${obj.type}", expected "result"` };
    }
    if (obj.is_error === true) {
      return { ok: false, code: "MODEL_EVIDENCE_MISSING", reason: "envelope indicates error (is_error: true)" };
    }
    if (typeof obj.result !== "string") {
      return { ok: false, code: "MODEL_EVIDENCE_MISSING", reason: "envelope has no string result field" };
    }

    // 2. actualModel comes from modelUsage keys (fieldPath "modelUsage")
    const modelUsage = obj.modelUsage;
    if (!modelUsage || typeof modelUsage !== "object" || Array.isArray(modelUsage)) {
      return { ok: false, code: "MODEL_EVIDENCE_MISSING", reason: "envelope has no modelUsage object" };
    }
    const keys = Object.keys(modelUsage as Record<string, unknown>);
    if (keys.length === 0) {
      return { ok: false, code: "MODEL_EVIDENCE_MISSING", reason: "modelUsage has no keys" };
    }
    if (keys.length > 1) {
      return {
        ok: false,
        code: "MODEL_EVIDENCE_AMBIGUOUS",
        reason: `modelUsage has multiple model keys: [${keys.join(", ")}]`,
      };
    }
    const actualModel = keys[0];

    // 3. Usage: return null unless every modelUsage entry carries integer inputTokens and outputTokens
    let usage: AdapterUsage | null = null;
    let inputTokensSum = 0;
    let outputTokensSum = 0;
    let validUsage = true;

    for (const k of keys) {
      const entry = (modelUsage as Record<string, unknown>)[k];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        validUsage = false;
        break;
      }
      const rec = entry as Record<string, unknown>;
      const inp = rec.inputTokens;
      const out = rec.outputTokens;
      if (typeof inp !== "number" || !Number.isInteger(inp) || typeof out !== "number" || !Number.isInteger(out)) {
        validUsage = false;
        break;
      }
      inputTokensSum += inp;
      outputTokensSum += out;
    }

    if (validUsage) {
      usage = {
        promptTokens: inputTokensSum,
        completionTokens: outputTokensSum,
        totalTokens: inputTokensSum + outputTokensSum,
        coversInternalCalls: true,
        source: "cli-envelope",
        fieldPath: "modelUsage",
      };
    }

    return {
      ok: true,
      actualModel,
      modelEvidence: { source: "cli-envelope", fieldPath: "modelUsage" },
      usage,
    };
  }

  let env: unknown;
  try { env = JSON.parse(stdoutText); }
  catch { return { ok: false, code: "MODEL_EVIDENCE_MISSING", reason: "stdout is not a structured JSON envelope" }; }
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    return { ok: false, code: "MODEL_EVIDENCE_MISSING", reason: "envelope is not a JSON object" };
  }
  const obj = env as Record<string, unknown>;
  const model = obj.model;
  if (typeof model !== "string" || model === "") {
    return { ok: false, code: "MODEL_EVIDENCE_MISSING", reason: "envelope has no model field" };
  }
  const u = obj.usage as Record<string, unknown> | undefined;
  let usage: AdapterUsage | null = null;
  if (u && typeof u === "object") {
    const pt = u.prompt_tokens;
    const ct = u.completion_tokens;
    usage = {
      promptTokens: typeof pt === "number" ? pt : null,
      completionTokens: typeof ct === "number" ? ct : null,
      totalTokens: (typeof pt === "number" && typeof ct === "number") ? pt + ct : null,
      coversInternalCalls: u.covers_internal_calls === true,
      source: "cli-envelope",
      fieldPath: "usage",
    };
  }
  return {
    ok: true,
    actualModel: model,
    modelEvidence: { source: "cli-envelope", fieldPath: "model" },
    usage,
  };
}
