/**
 * L2 adapter layer — config loader (fail-closed, no secrets).
 *
 * Config file: `agent-commons.adapters.json` in the server working directory,
 * **gitignored** (it names runtime model ids, which §4.4 treats as sensitive on a
 * public repo). The loader fails closed on any parse or validation error
 * (design §6.2): bad config is treated as if NO config exists — the server logs
 * one safe line at startup and behaves as if the default path were configured.
 *
 * Forbidden-field rule (design §5, extended per the design review's guardrail note): any field
 * named `key`, `token`, `secret`, `password`, or `credential` — at ANY nesting
 * depth, in ANY case (Key, API_KEY, apiKey, etc.) — rejects the whole file.
 * Credentials are never in repo or config; future real adapters inherit them
 * from the environment, like `model_bridge.py:1` already does.
 *
 * Env override: `AGENT_COMMONS_ADAPTER=<name>` is a convenience override
 * equivalent to setting every slot's adapter to that name (useful for fully
 * offline local runs).
 *
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { foundingCohort } from "../../shared/cohort";

export type SlotConfig = {
  adapter?: string;
  runtimeModel?: string;
};

export type AdaptersConfig = {
  version: number;
  defaultAdapter?: string;
  adapters?: Record<string, { fixtures?: string }>;
  slots?: Record<string, SlotConfig>;
};

const FORBIDDEN_FIELD_NAMES = new Set(["key", "token", "secret", "password", "credential"]);
const KNOWN_SLOT_IDS: Set<string> = new Set(foundingCohort.map((m) => m.id) as string[]);

/**
 * Tokenize a field name for credential-word matching. Splits on:
 *   - non-alphanumeric separators: `_`, `-`, `.`, whitespace, etc.
 *   - camelCase boundaries: a lowercase/digit followed by an uppercase letter
 *   - acronym → TitleCase boundaries: a run of uppercase letters followed by
 *     an uppercase + lowercase pair (so "APIKey" → "API" + "Key")
 * Then lowercases each token. Reject only when a token EQUALS one of the
 * forbidden words; substring matches inside a single token are NOT rejected,
 * so benign names like `keyword`, `monkey`, `passkey`, `tokenize`, `primarykey`,
 * `passwordless`, `secretonly`, `credentials-free` are accepted, while
 * `key`, `Key`, `API_KEY`, `apiKey`, `OPENAI_API_KEY`, `my_secret`, `token`,
 * `password`, `credential` are rejected.
 */
function tokenizeFieldName(name: string): string[] {
  const withBoundaries = name
    .replace(/[^a-zA-Z0-9]+/g, " ")        // separators → spaces
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase: lower/digit → upper
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2"); // acronym + TitleCase
  return withBoundaries.split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
}

function isForbiddenFieldName(name: string): boolean {
  for (const token of tokenizeFieldName(name)) {
    if (FORBIDDEN_FIELD_NAMES.has(token)) return true;
  }
  return false;
}

function hasForbiddenField(value: unknown, depth = 0): boolean {
  if (depth > 20) return false; // bail out on pathological nesting
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasForbiddenField(item, depth + 1));
  const obj = value as Record<string, unknown>;
  return Object.entries(obj).some(([k, v]) => {
    if (isForbiddenFieldName(k)) return true;
    return hasForbiddenField(v, depth + 1);
  });
}

function isValidSlotId(id: string): boolean {
  return KNOWN_SLOT_IDS.has(id);
}

function validateConfig(raw: unknown): AdaptersConfig | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) return null;
  if (hasForbiddenField(obj)) return null;
  const slots = obj.slots as Record<string, unknown> | undefined;
  if (slots !== undefined) {
    if (typeof slots !== "object" || slots === null || Array.isArray(slots)) return null;
    for (const [slotId, slotConfig] of Object.entries(slots)) {
      if (!isValidSlotId(slotId)) return null;
      if (slotConfig === null || typeof slotConfig !== "object" || Array.isArray(slotConfig)) return null;
      const sc = slotConfig as Record<string, unknown>;
      if (sc.adapter !== undefined && typeof sc.adapter !== "string") return null;
      if (sc.runtimeModel !== undefined && typeof sc.runtimeModel !== "string") return null;
    }
  }
  const adapters = obj.adapters as Record<string, unknown> | undefined;
  if (adapters !== undefined) {
    if (typeof adapters !== "object" || adapters === null || Array.isArray(adapters)) return null;
    for (const entry of Object.values(adapters)) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
      const e = entry as Record<string, unknown>;
      if (e.fixtures !== undefined && typeof e.fixtures !== "string") return null;
    }
  }
  if (obj.defaultAdapter !== undefined && typeof obj.defaultAdapter !== "string") return null;
  return obj as unknown as AdaptersConfig;
}

/**
 * Load the adapters config from `agent-commons.adapters.json` in the server
 * working directory. Returns null on absence, parse error, or validation failure
 * (fail-closed: treat as no config).
 */
export function loadAdaptersConfig(cwd: string = process.cwd()): AdaptersConfig | null {
  const path = `${cwd}/agent-commons.adapters.json`;
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null; // malformed JSON → treated as absent
  }
  return validateConfig(raw);
}

/**
 * Resolve the adapter name for a given slot id. Returns null when the default
 * path (preview-bridge) should be used.
 */
export function resolveAdapterForSlot(
  slotId: string,
  config: AdaptersConfig | null,
): string | null {
  const envOverride = process.env.AGENT_COMMONS_ADAPTER;
  if (envOverride) return envOverride;
  if (!config) return null;
  const slot = config.slots?.[slotId];
  if (slot?.adapter) return slot.adapter;
  return config.defaultAdapter ?? null;
}

/**
 * Resolve the runtime model for a given slot id. On the default path this is
 * always the slot's historical model (config cannot relabel the default path).
 */
export function resolveRuntimeModel(
  slotId: string,
  historicalModel: string,
  config: AdaptersConfig | null,
): string {
  if (!config) return historicalModel;
  const slot = config.slots?.[slotId];
  if (slot?.runtimeModel) return slot.runtimeModel;
  return historicalModel;
}

/**
 * L10 binary + witness-seats resolution (brief rev 2 item P + rev 4 R3).
 * The four env vars AGENT_COMMONS_CLAUDE_BIN / _CODEX_BIN / _GROK_BIN /
 * _MODEL_LEDGER are read here, validated, and frozen. Each path value MUST
 * be an absolute path to an existing regular file (symlinks that resolve
 * to a regular file are accepted). A value that is unset, empty, whitespace,
 * relative, missing, a directory, or not a regular file returns a
 * `disabled` reason and the route is off. The resolver never searches PATH
 * and never falls back to a user default. The four names are intentionally
 * NOT in L10_APP_CONTROL_ALLOWLIST — a .env line setting any of them is
 * ignored (process env only).
 *
 * Brief rev 4 R3: AGENT_COMMONS_WITNESS_SEATS (comma-separated, non-empty
 * tokens) names the seats the Claude witness must match. It is resolved
 * once at startup, frozen, and reported in the snapshot. The name is also
 * NOT in L10_APP_CONTROL_ALLOWLIST (process env only). No default — unset
 * means the Claude route is disabled (R2 closes the route when seats are
 * unset).
 *
 * `getResolvedL10Binaries()` memoizes the snapshot so buildL10Argv, the
 * spawn gates, and the witness seat matcher read the SAME frozen value.
 */
export const L10_BIN_ENV_NAMES = Object.freeze({
  claude: "AGENT_COMMONS_CLAUDE_BIN",
  codex: "AGENT_COMMONS_CODEX_BIN",
  grok: "AGENT_COMMONS_GROK_BIN",
  modelLedger: "AGENT_COMMONS_MODEL_LEDGER",
  witnessSeats: "AGENT_COMMONS_WITNESS_SEATS",
} as const);

export type L10BinaryKey = keyof typeof L10_BIN_ENV_NAMES;

export type L10BinaryResolution =
  | { status: "enabled"; path: string }
  | { status: "disabled"; reason: string };

export type L10WitnessSeatsResolution =
  | { status: "enabled"; seats: readonly string[] }
  | { status: "disabled"; reason: string };

export type L10Binaries = Readonly<{
  claude: L10BinaryResolution;
  codex: L10BinaryResolution;
  grok: L10BinaryResolution;
  modelLedger: L10BinaryResolution;
  witnessSeats: L10WitnessSeatsResolution;
}>;

function classifyPath(value: string | undefined): L10BinaryResolution {
  if (value === undefined) return { status: "disabled", reason: "unset" };
  if (value === "") return { status: "disabled", reason: "empty" };
  const trimmed = value.trim();
  if (trimmed === "") return { status: "disabled", reason: "whitespace" };
  if (trimmed !== value) return { status: "disabled", reason: "whitespace" };
  if (!trimmed.startsWith("/")) return { status: "disabled", reason: "relative" };
  let st;
  try {
    st = statSync(trimmed);
  } catch {
    return { status: "disabled", reason: "missing" };
  }
  if (st.isDirectory()) return { status: "disabled", reason: "is-directory" };
  if (!st.isFile()) return { status: "disabled", reason: "not-regular-file" };
  return { status: "enabled", path: trimmed };
}

function classifySeats(value: string | undefined): L10WitnessSeatsResolution {
  if (value === undefined) return { status: "disabled", reason: "unset" };
  const tokens = value.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  if (tokens.length === 0) return { status: "disabled", reason: "no-tokens" };
  // Brief rev 4 R3: no default, no synthetic. Tokens must be non-empty
  // strings (no validation on charset; the env owner chooses the
  // seat names — tests use synthetic tokens).
  return { status: "enabled", seats: Object.freeze(tokens) };
}

export function resolveL10Binaries(env: NodeJS.ProcessEnv): L10Binaries {
  return Object.freeze({
    claude: classifyPath(env[L10_BIN_ENV_NAMES.claude]),
    codex: classifyPath(env[L10_BIN_ENV_NAMES.codex]),
    grok: classifyPath(env[L10_BIN_ENV_NAMES.grok]),
    modelLedger: classifyPath(env[L10_BIN_ENV_NAMES.modelLedger]),
    witnessSeats: classifySeats(env[L10_BIN_ENV_NAMES.witnessSeats]),
  });
}

let cached: L10Binaries | null = null;

export function getResolvedL10Binaries(): L10Binaries {
  if (cached === null) cached = resolveL10Binaries(process.env);
  return cached;
}

/** Test-only: clear the memoized snapshot. The next getResolvedL10Binaries
 *  call re-reads process.env. Never call from production code. */
export function _resetL10BinariesForTest(): void {
  cached = null;
}

/** Test-only: install a fixed snapshot. The next getResolvedL10Binaries
 *  call returns it. Pass null to clear. */
export function _setL10BinariesForTest(snap: L10Binaries | null): void {
  cached = snap;
}

/**
 * Brief rev 4 R2: the Claude live route is ENABLED only when the CLI
 * binary, the model ledger, and the witness seats all resolve. Any one
 * missing (unset / disabled for a reason) DISABLES the Claude route
 * with a static reason. Decided at startup like the binaries; never
 * re-evaluated mid-run.
 */
export type ClaudeRouteResolution =
  | { status: "enabled"; path: string; ledgerPath: string; seats: readonly string[] }
  | { status: "disabled"; reason: string };

export function getClaudeRouteResolution(): ClaudeRouteResolution {
  const r = getResolvedL10Binaries();
  if (r.claude.status !== "enabled") return { status: "disabled", reason: `claude bin ${r.claude.reason}` };
  if (r.modelLedger.status !== "enabled") return { status: "disabled", reason: `model ledger ${r.modelLedger.reason}` };
  if (r.witnessSeats.status !== "enabled") return { status: "disabled", reason: `witness seats ${r.witnessSeats.reason}` };
  return {
    status: "enabled",
    path: r.claude.path,
    ledgerPath: r.modelLedger.path,
    seats: r.witnessSeats.seats,
  };
}
