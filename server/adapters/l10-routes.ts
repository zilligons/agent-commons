/**
 * L10 — frozen slot->literal map and exact argv contracts (design v3 §a; L10
 * seam-review items 1 + 2). One module that owns the four CLI routes'
 * exact argv shapes; the rest of the lane uses these constants.
 *
 * argv[0] is the configured binary from getResolvedL10Binaries() (frozen at
 * startup). When the route is disabled (unconfigured / invalid path),
 * buildL10Argv throws MODEL_UNAVAILABLE with a static reason — the same
 * call is read by the spawn gates in l10-process.ts, so the contract is
 * enforced ONCE.
 *
 */

import { foundingCohort } from "../../shared/cohort";
import { AdapterFailure } from "./types";
import { getResolvedL10Binaries, type L10BinaryKey } from "./config";

/**
 * Frozen slot -> runtime model literal map. v3 §a: the frozen literals are
 * the only source of live model arguments. Config, environment overrides,
 * transcripts and model output MUST NEVER supply a model argument.
 */
export const L10_FROZEN_LITERALS = Object.freeze({
  continuity: "claude-fable-5-1",
  collaboration: "claude-opus-5-5",
  security: "claude-sonnet-5-5",
  governance: "gpt-6.1-sol",
  release: "gemini-4-argon",
  integration: "gemini-3.8-flash",
  sustainability: "gpt-5.6-terra", // Exact ID verified through the provider model catalogue.
} as const);

/**
 * R17 P1: Unconditional Claude model gate. Derived from the three Claude slots of L10_FROZEN_LITERALS.
 * Only {claude-fable-5-1, claude-opus-5-5, claude-sonnet-5-5} are permitted on the Claude route.
 */
export const CLAUDE_ALLOWED_MODELS: readonly string[] = Object.freeze([
  L10_FROZEN_LITERALS.continuity,
  L10_FROZEN_LITERALS.collaboration,
  L10_FROZEN_LITERALS.security,
] as const);

/** All founding slots are eligible through their frozen metered provider routes. */
export const L10_LIVE_ELIGIBLE_SLOTS = Object.freeze([
  "continuity", "collaboration", "security", "governance", "release",
  "integration", "sustainability",
] as const);

/** Eligibility does not bypass transport metering, credential or permit checks. */
export function assertSlotEligibleForL10(slotId: string): void {
  if (!L10_LIVE_ELIGIBLE_SLOTS.includes(slotId as typeof L10_LIVE_ELIGIBLE_SLOTS[number])) {
    throw new AdapterFailure(
      "MODEL_UNAVAILABLE",
      `slot ${slotId} is not L10-live-eligible`,
      null,
      false,
    );
  }
  // The slot must exist in the founding cohort.
  const member = foundingCohort.find((m) => m.id === slotId);
  if (!member) {
    throw new AdapterFailure("MODEL_UNAVAILABLE", `unknown slot: ${slotId}`, null, false);
  }
}

/**
 * Map a historical cohort model id to the frozen runtime literal for a
 * slot. The frozen literal is the ONLY source of a live model argument
 * (v3 §a R2); this function exists so callers can ask "what literal does
 * this slot admit" without reading the map directly. The `historical`
 * argument is validated against the cohort's declared model mapping:
 * a historical id that does not belong to the slot returns null rather
 * than a literal (guard-shaped no-op removed per the security reviewer C5 — implement
 * or delete).
 */
const HISTORICAL_BY_SLOT: Record<string, string> = {
  continuity: "claude_fable_5_1",
  collaboration: "claude_opus_5_5",
  security: "claude_sonnet_5_5",
  governance: "gpt_6_1_sol",
  release: "gemini_4_argon",
  integration: "gemini_3_8_flash",
  sustainability: "gpt_5_6_terra",
};

export function historicalToRuntime(historical: string, slotId: string): string | null {
  if (HISTORICAL_BY_SLOT[slotId] !== historical) return null;
  const expected = L10_FROZEN_LITERALS[slotId as keyof typeof L10_FROZEN_LITERALS];
  return expected === undefined ? null : expected;
}

/**
 * Build the exact argv for a slot, byte-for-byte per v3 §a (rework 1 C5).
 * Noninteractive flags, frozen model literal, no tools, restricted mode.
 * The prompt is NEVER in argv (passed on STDIN, v3 §g.3 R5). Same argv in
 * CONTROL and MUTANT (only HOME/config/login isolation differs).
 *
 * §a frozen contracts:
 *   Claude: <configured bin> --print --model <lit> --input-format
 *     text --output-format json --tools "" --strict-mcp-config
 *     --mcp-config '{"mcpServers":{}}' --permission-mode dontAsk --permission-prompts
 *     none --no-session-persistence --restricted
 *     (prompt on STDIN via --input-format text; NO trailing positional)
 *   Codex:  <configured bin> exec --model gpt-6.1-sol --json
 *     --ephemeral --ignore-user-config --strict-config --sandbox
 *     read-only --color never --skip-git-repo-check -
 *     (trailing "-" = read prompt from stdin)
 *   Release/Argon uses the metered Gemini HTTP route. No CLI argv is
 *     defined for that slot; this builder must refuse it before spawn.
 *
 * argv[0] is the frozen resolved binary from getResolvedL10Binaries(). When
 * the route is disabled (the env var is unset / empty / whitespace /
 * relative / missing / not a regular file), buildL10Argv throws
 * MODEL_UNAVAILABLE with the resolver's static reason. l10-process.ts
 * gates read the SAME frozen value, so a disabled route never reaches the
 * spawn boundary.
 */
function resolveBinaryOrThrow(key: "claude" | "codex", slotId: string): string {
  const r = getResolvedL10Binaries()[key];
  if (r.status === "enabled") return r.path;
  throw new AdapterFailure(
    "MODEL_UNAVAILABLE",
    `l10 route for ${slotId} disabled: AGENT_COMMONS_${key.toUpperCase()}_BIN is ${r.reason}`,
    null,
    false,
  );
}

export function buildL10Argv(opts: { slotId: string; cwd?: string; stdinPath?: string }): string[] {
  const slotId = opts.slotId;
  assertSlotEligibleForL10(slotId);
  const literal = L10_FROZEN_LITERALS[slotId as keyof typeof L10_FROZEN_LITERALS];
  if (!literal) {
    throw new AdapterFailure("MODEL_UNAVAILABLE", `no frozen literal for slot ${slotId}`, null, false);
  }
  if (slotId === "continuity" || slotId === "collaboration" || slotId === "security") {
    // Claude wrapper (v3 §a L38-39), byte-for-byte; ends at --restricted.
    return [
      resolveBinaryOrThrow("claude", slotId),
      "--print",
      "--model", literal,
      "--input-format", "text",
      "--output-format", "json",
      "--tools", "",
      "--strict-mcp-config",
      "--mcp-config", "{\"mcpServers\":{}}",
      "--permission-mode", "dontAsk",
      "--permission-prompts", "none",
      "--no-session-persistence",
      "--restricted",
    ];
  }
  if (slotId === "governance") {
    // Codex wrapper (v3 §a L40), byte-for-byte; trailing "-" = stdin.
    return [
      resolveBinaryOrThrow("codex", slotId),
      "exec",
      "--model", literal,
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--strict-config",
      "--sandbox", "read-only",
      "--color", "never",
      "--skip-git-repo-check",
      "-",
    ];
  }
  if (slotId === "release") {
    throw new AdapterFailure(
      "MODEL_UNAVAILABLE",
      "Argon uses the metered Gemini HTTP transport; no release CLI route is defined",
      null,
      false,
    );
  }
  throw new AdapterFailure("MODEL_UNAVAILABLE", `unknown slot ${slotId}`, null, false);
}

/**
 * R5 (rework 5): validate model literal through the real adapter gate.
 * Refuses missing, empty, config-sourced, or invalid model literals with
 * static reason MODEL_UNAVAILABLE.
 */
export function assertValidModelLiteral(model: unknown, slotId?: string): string {
  if (model === undefined || model === null) {
    throw new AdapterFailure("MODEL_UNAVAILABLE", "missing model literal", null, false);
  }
  if (typeof model !== "string" || model.trim() === "") {
    throw new AdapterFailure("MODEL_UNAVAILABLE", "empty model literal", null, false);
  }
  if (model.startsWith("config:") || model.includes("config")) {
    throw new AdapterFailure("MODEL_UNAVAILABLE", "config-sourced model refused", null, false);
  }
  if (slotId) {
    assertSlotEligibleForL10(slotId);
    const expected = L10_FROZEN_LITERALS[slotId as keyof typeof L10_FROZEN_LITERALS];
    if (model !== expected) {
      throw new AdapterFailure("MODEL_UNAVAILABLE", `invalid model literal: ${model} does not match ${expected}`, null, false);
    }
  } else {
    const valid = Object.values(L10_FROZEN_LITERALS).filter(Boolean) as string[];
    if (!valid.includes(model as string)) {
      throw new AdapterFailure("MODEL_UNAVAILABLE", `invalid model literal: ${model}`, null, false);
    }
  }
  return model as string;
}
