/**
 * L10 — closed child-env builder (design v3 §b; L10 seam-review item 3).
 *
 * Every L10 adapter spawns a CLI child with this env. The env is built from
 * a frozen common list (§b common child list: HOME, PATH, USER, TERM, LANG,
 * TMPDIR, TZ) plus route-specific additions. The parent env is NEVER
 * inherited as a starting set; only the names on the allowlist appear in
 * the child. Anything not on the allowlist is dropped, including credential
 * families (§c: AWS_/XAI_/GOOGLE_ prefixes; every name containing API_KEY
 * or ending _TOKEN; named routing/credential singles; presence of an empty
 * string counts). The `AGENT_COMMONS_OPERATOR_TOKEN` is held in a private
 * closure and never enters the child env (owed to the security reviewer B1 review).
 *
 * This module is the closed-list builder; the refusal predicate is
 * implemented in l10-routes (which is invoked at the spawn tripwire).
 *
 */
import { readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { getResolvedL10Binaries } from "./config";

export const COMMON_CHILD_ENV = Object.freeze([
  "HOME", "PATH", "USER", "TERM", "LANG", "TMPDIR", "TZ",
] as const);

export const L10_REFUSED_PREFIXES = Object.freeze([
  "AWS_", "XAI_", "GOOGLE_",
] as const);

/**
 * Every name the v3 §c predicate catches by exact equality. This is the
 * "named singles" list from v3 L61 plus 5 expansion names; it complements
 * the prefix rules above. Lowercase compare. Empty-string presence
 * counts as a refusal per v3 L61.
 */
export const L10_REFUSED_SINGLES = Object.freeze([
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_BASE_URL", "ANTHROPIC_API_BASE_URL",
  "CLAUDE_AGENT_API_BASE_URL", "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_OAUTH_TOKEN",
  "VERTEX_LOCATION",
  "OPENAI_BASE_URL", "OPENAI_API_BASE", "OPENAI_ORG_ID", "OPENAI_ORGANIZATION",
  "OPENROUTER_BASE_URL", "OPENROUTER_API_BASE",
  "GROK_WS_ORIGIN", "GROK_WS_URL",
  "CLI_CHAT_PROXY_BASE_URL",
  // Expansion names (per the seam-review note 2 / v3 §c L61-65). Names
  // already covered by the prefix family (AWS_/XAI_/GOOGLE_) are listed
  // for documentation here and tested via the prefix rule.
  "ANTHROPIC_API_KEY",
] as const);

/** R2 (rework 3): frozen trusted values per v3 §b L48. Callers do not
 *  override PATH/USER/TERM/LANG/TZ; HOME comes from the pole policy, and
 *  TMPDIR is created mode 700 under the owned run dir and proven. */
export const L10_FROZEN_PATH = "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
export const L10_FROZEN_USER = userInfo().username;
export const L10_FROZEN_TERM = "dumb";
export const L10_FROZEN_LANG = "en_US.UTF-8";
export const L10_FROZEN_TZ = "America/Los_Angeles";
/** Grok keeps the REAL executable in BOTH poles (v3 §b route table).
 *  Brief rev 2: the value is the frozen resolved Grok binary
 *  (AGENT_COMMONS_GROK_BIN env var, set by the operator to an absolute
 *  path to the real Grok binary). When unconfigured, the GROK_REAL
 *  child-env key is OMITTED (not set to a default). */
export function getL10GrokReal(): string | null {
  const r = getResolvedL10Binaries().grok;
  return r.status === "enabled" ? r.path : null;
}

/** Route pole policy (v3 §b route table + the review's R2): which HOME each pole
 *  uses and which route additions are present per pole. */
export type L10Pole = "CONTROL" | "MUTANT";

export class L10EnvBuilderError extends Error {
  constructor(message: string) { super(message); this.name = "L10EnvBuilderError"; }
}

/**
 * R2 (rework 3): build the closed child env for a route with frozen
 * trusted values and explicit pole policy.
 *
 * - PATH/USER/TERM/LANG/TZ are the frozen constants above; callers cannot
 *   override them (the slice-1 builder accepted arbitrary values — a
 *   caller could pass a hostile PATH straight through).
 * - HOME comes from the pole policy: Claude CONTROL uses the real account
 *   home (os.userInfo().homedir — not os.homedir() and never a hard-coded
 *   literal; brief rev 2 §Nit), every other case uses the supplied
 *   scratch/real home.
 * - Codex MUTANT has NO CODEX_HOME key at all (v3 §b: "CODEX_HOME
 *   entirely unset" in the mutant).
 * - Grok keeps the configured GROK_REAL (AGENT_COMMONS_GROK_BIN) in BOTH
 *   poles (never derived from the pole's HOME; when unconfigured, the
 *   GROK_REAL key is OMITTED).
 * - TMPDIR is created mode 700 under the supplied run dir and its
 *   location+mode are proven (mkdirSync recursive + stat check); a
 *   caller-supplied tmpdir outside the run dir is rejected.
 * - Unsupported `additions` are REJECTED (the slice-1 builder copied
 *   arbitrary keys into the child; one refused key survived). The only
 *   permitted addition names are the route's documented fields.
 */
export function buildChildEnv(opts: {
  route: "claude" | "codex" | "grok" | "antigravity";
  runId: string;
  home: string;
  pole?: L10Pole;
  runDir: string;
  additions?: Record<string, string>;
}): Readonly<Record<string, string>> {
  if (!opts.runDir || typeof opts.runDir !== "string") {
    throw new L10EnvBuilderError("runDir is required and must be an owned directory");
  }
  let runDirSt;
  try {
    runDirSt = statSync(opts.runDir);
  } catch (e) {
    throw new L10EnvBuilderError(`runDir ${opts.runDir} must exist: ${(e as Error).message}`);
  }
  if (!runDirSt.isDirectory()) {
    throw new L10EnvBuilderError(`runDir ${opts.runDir} must be a directory`);
  }

  const pole: L10Pole = opts.pole ?? "CONTROL";
  // Claude CONTROL uses the REAL home (no scratch-HOME pole for Claude).
  // The home comes from os.userInfo().homedir (the real account's home,
  // independent of $HOME) — brief rev 2: never a hard-coded user path.
  const home = (opts.route === "claude" && pole === "CONTROL") ? userInfo().homedir : opts.home;

  // TMPDIR: created mode 700 under the owned run dir and proven.
  const tmpdir = join(opts.runDir, "tmp");
  mkdirSync(tmpdir, { recursive: true, mode: 0o700 });
  const st = statSync(tmpdir);
  if (!st.isDirectory() || (st.mode & 0o777) !== 0o700) {
    throw new L10EnvBuilderError(`TMPDIR ${tmpdir} must be a mode-700 directory (mode=${(st.mode & 0o777).toString(8)})`);
  }

  const base: Record<string, string> = {
    HOME: home,
    PATH: L10_FROZEN_PATH,
    USER: L10_FROZEN_USER,
    TERM: L10_FROZEN_TERM,
    LANG: L10_FROZEN_LANG,
    TMPDIR: tmpdir,
    TZ: L10_FROZEN_TZ,
  };

  // Route additions per pole policy.
  if (opts.route === "claude") {
    base.CLAUDE_CONFIG_DIR = join(home, ".claude");
  } else if (opts.route === "codex") {
    // Codex MUTANT: NO CODEX_HOME key at all (v3 §b).
    if (pole !== "MUTANT") base.CODEX_HOME = join(home, ".codex");
  } else if (opts.route === "grok") {
    // Grok: GROK_REAL is the configured binary in BOTH poles. When
    // unconfigured (resolver disabled), the GROK_REAL key is OMITTED
    // (not set to a default).
    const grokReal = getL10GrokReal();
    if (grokReal !== null) base.GROK_REAL = grokReal;
  }

  // Constrain additions to the route+pole's exact trusted values.
  if (opts.additions) {
    for (const [k, v] of Object.entries(opts.additions)) {
      if (refusedReason(k) !== null || v === "") {
        throw new L10EnvBuilderError(`addition ${k} is refused`);
      }
      if (opts.route === "claude") {
        if (k !== "CLAUDE_CONFIG_DIR") {
          throw new L10EnvBuilderError(`unsupported child-env addition for claude: ${k}`);
        }
        const trusted = join(home, ".claude");
        if (v !== trusted) {
          throw new L10EnvBuilderError(`addition CLAUDE_CONFIG_DIR value ${v} does not match trusted value ${trusted}`);
        }
        base.CLAUDE_CONFIG_DIR = v;
      } else if (opts.route === "codex") {
        if (pole === "MUTANT") {
          throw new L10EnvBuilderError(`unsupported child-env addition for codex MUTANT: ${k}`);
        }
        if (k !== "CODEX_HOME") {
          throw new L10EnvBuilderError(`unsupported child-env addition for codex: ${k}`);
        }
        const trusted = join(home, ".codex");
        if (v !== trusted) {
          throw new L10EnvBuilderError(`addition CODEX_HOME value ${v} does not match trusted value ${trusted}`);
        }
        base.CODEX_HOME = v;
      } else if (opts.route === "grok") {
        if (k !== "GROK_REAL") {
          throw new L10EnvBuilderError(`unsupported child-env addition for grok: ${k}`);
        }
        const trusted = getL10GrokReal();
        if (trusted === null || v !== trusted) {
          throw new L10EnvBuilderError(`addition GROK_REAL value ${v} does not match trusted value ${trusted ?? "<unconfigured>"}`);
        }
        base.GROK_REAL = v;
      } else {
        throw new L10EnvBuilderError(`unsupported child-env addition for ${opts.route}: ${k}`);
      }
    }
  }
  return Object.freeze(base);
}

/**
 * Refusal predicate per v3 §c. A name is refused if:
 *   - it has an L10_REFUSED_PREFIX, OR
 *   - it equals (case-insensitive) one of L10_REFUSED_SINGLES, OR
 *   - it contains "API_KEY" or ends with "_TOKEN" (substring family), OR
 *   - it is the empty string (presence counts per v3 L61).
 *
 * Returns the matched reason (the first reason found) or null when the
 * name is clean. Use this for the startup scrub, the spawn tripwire,
 * the config-env check, and the harness; one predicate drives them all
 * (v3 L63). The empty-string case is checked at the caller because
 * `process.env` keys are always non-empty strings — caller checks the
 * VALUE being empty.
 */
export function refusedReason(name: string): string | null {
  if (name === "") return "empty";
  const upper = name.toUpperCase();
  for (const prefix of L10_REFUSED_PREFIXES) {
    if (upper.startsWith(prefix)) return `prefix:${prefix}`;
  }
  for (const single of L10_REFUSED_SINGLES) {
    if (upper === single.toUpperCase()) return `single:${single}`;
  }
  if (upper.includes("API_KEY") || upper.endsWith("_TOKEN")) return "family:API_KEY/_TOKEN";
  return null;
}

/**
 * Scrub the current process.env against the refusal predicate and return
 * the sorted list of refused NAMES (NEVER values; per v3 L73). Use this at
 * startup BEFORE any application import. The scrub is best-effort: it
 * drops names it can drop, but cannot drop names the OS pinned. Names
 * that the OS cannot drop are still listed in the inventory so the
 * caller can refuse dispatch.
 *
 * C7 (rework 1) + R10 (rework 3b): the empty-value clause in v3 §c L61
 * ("presence includes an empty string") is about §c REFUSED names: a
 * name classified by the predicate (prefix/single/family) is refused
 * even when its value is empty. An UNCLASSIFIED empty-valued name is
 * NOT a §c name — npx/npm inject empty npm_config_* names into every
 * child they launch, and refusing those made the harness unrunnable
 * under npx (an earlier R10 measurement). The documented launch form is
 * env -i allowlist + `node --import tsx`, but the predicate is now
 * precise regardless: classification first, empty-value as a presence
 * amplifier on classified names only. Unclassified empty names are
 * dropped from the CHILD env by the closed builders (allowlist
 * construction), not by this refusal predicate.
 */
export function scrubEnv(env: NodeJS.ProcessEnv = process.env): { refused: string[]; kept: string[] } {
  const refused: string[] = [];
  const kept: string[] = [];
  for (const name of Object.keys(env)) {
    // refusedReason is value-blind: a classified name is refused whether
    // its value is present or empty (v3 L61 presence clause). An
    // unclassified name is kept regardless of its value — emptiness is
    // not a §c classification.
    if (refusedReason(name) !== null) {
      refused.push(name);
    } else {
      kept.push(name);
    }
  }
  refused.sort();
  kept.sort();
  return { refused, kept };
}

/**
 * D2 (rework 2, v3 §c L73 second half): the spawn-time TRIPWIRE. Called
 * before EVERY child spawn (spawnClaudeL10Child, the three Python sites,
 * the harness). After bootstrap, any refused name present in the console
 * env — including an empty value — is terminal ENV_REFUSED before any
 * child exists. The bootstrap proves a point in time; this is the
 * detector for anything mutated afterwards.
 *
 * R1 (rework 3): the SAME predicate/config gate now runs on BOTH the
 * parent (console env) and the child env immediately before every
 * sanctioned spawn. A refused name in the child env is a builder defect,
 * not a console leak, but the tripwire refuses both identically.
 *
 * Throws EnvRefusedError carrying the refused NAMES (never values).
 * Spawn sites call it bare (uncaught → process dies before the child
 * exists — the terminal behavior v3 specifies); the two-pole test
 * catches it to assert the refusal without exiting the test runner.
 */
export class EnvRefusedError extends Error {
  readonly code = "ENV_REFUSED";
  constructor(public readonly refusedNames: string[], public readonly surface: "parent" | "child") {
    // R10(c): NAMES only, and the rendered list is capped — the first 20
    // names plus a count. A credential-laden lane shell can carry 100+
    // refused names; the diagnostic must stay one bounded line.
    const shown = refusedNames.slice(0, 20).join(",");
    const more = refusedNames.length > 20 ? ` (+${refusedNames.length - 20} more, total ${refusedNames.length})` : ` (total ${refusedNames.length})`;
    super(`ENV_REFUSED: §c refused names in ${surface} env at spawn time: ${shown}${more}`);
    this.name = "EnvRefusedError";
  }
}

export function assertSpawnTripwire(env: NodeJS.ProcessEnv = process.env, surface: "parent" | "child" = "parent"): void {
  const { refused } = scrubEnv(env);
  if (refused.length > 0) throw new EnvRefusedError(refused, surface);
}

/**
 * R1 (rework 3, v3 §b/§c): construct the closed console env — never filter
 * the parent. Names outside the §c refused families but also outside the
 * closed allowlist (BASH_ENV, ENV, NODE_OPTIONS, LD_/DYLD_ preload
 * hooks, PS4, PROMPT_COMMAND, SHELLOPTS, BASHOPTS, CDPATH, IFS, shell
 * functions) must NOT survive a spawn boundary. This builder constructs
 * the child env from the allowlist ONLY; anything not on the list is
 * absent by construction.
 *
 * The allowlist is the v3 §b common list plus route additions and the
 * validated app-control names (NODE_ENV, PORT, AGENT_COMMONS_OFFLINE,
 * AGENT_COMMONS_ADAPTER, AGENT_COMMONS_STUB_FIXTURES,
 * AGENT_COMMONS_PRIVATE_PREVIEW, AGENT_COMMONS_PREVIEW_ORIGINS,
 * AGENT_COMMONS_BIND_ALL). Values come from the caller, never from
 * unvalidated parent overrides.
 */
export const CLOSED_CONSOLE_ALLOWLIST = Object.freeze([
  "HOME", "PATH", "USER", "TERM", "LANG", "TMPDIR", "TZ",
  "NODE_ENV", "PORT",
  "AGENT_COMMONS_OFFLINE", "AGENT_COMMONS_ADAPTER",
  "AGENT_COMMONS_STUB_FIXTURES", "AGENT_COMMONS_PRIVATE_PREVIEW",
  "AGENT_COMMONS_PREVIEW_ORIGINS", "AGENT_COMMONS_BIND_ALL",
  "AGENT_COMMONS_L10_TRIAL_TURNS",
] as const);

/**
 * Names that must NEVER survive a spawn boundary even though they are
 * not §c credential families: shell/preload execution hooks. Checked
 * explicitly so a future allowlist edit cannot silently re-admit them.
 */
export const SPAWN_HOOK_DENYLIST = Object.freeze([
  "BASH_ENV", "ENV", "NODE_OPTIONS", "PS4", "PROMPT_COMMAND",
  "SHELLOPTS", "BASHOPTS", "CDPATH", "IFS", "PYTHONSTARTUP",
  "DYLD_INSERT_LIBRARIES", "DYLD_PRINT_LIBRARIES", "LD_PRELOAD", "LD_LIBRARY_PATH",
] as const);

export function buildClosedConsoleEnv(source: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  const deny = new Set<string>(SPAWN_HOOK_DENYLIST);
  for (const name of CLOSED_CONSOLE_ALLOWLIST) {
    if (deny.has(name)) continue; // belt-and-suspenders; allowlist contains none today
    const v = source[name];
    if (v !== undefined && v !== "") out[name] = v;
  }
  return Object.freeze(out);
}

/**
 * Read the JSON config of a route (Claude settings.json, codex config.toml,
 * grok auth.json) and surface only the presence of refused names — NEVER
 * the value. Used by the spawn-time config-precondition check. The
 * expectation is that real configs carry no §c names today; the harness
 * uses this to assert the precondition.
 *
 * C6 (rework 1): any parse failure is CONFIG_UNVERIFIED, never []. The
 * slice-1 implementation returned [] on any read/parse error — a fail-
 * OPEN that made the Codex TOML route permanently "clean" regardless of
 * whether its config could even be read. §d L91/L95 requires parser
 * failures to yield CONFIG_UNVERIFIED.
 */
export function configEnvRefusedNames(filePath: string): string[] | { code: "CONFIG_UNVERIFIED"; reason: string } {
  // R9 (rework 3): reasons are STATIC — no parser error text (it carries
  // an excerpt of the malformed input), no config body fragments. Safe
  // metadata only: which file, which failure class.
  if (!existsSync(filePath)) return { code: "CONFIG_UNVERIFIED", reason: "config file absent" };
  // Format gate: JSON only in this slice; TOML and any other format are
  // unsupported → CONFIG_UNVERIFIED (never parsed-and-trusted).
  if (!filePath.endsWith(".json")) {
    return { code: "CONFIG_UNVERIFIED", reason: "unsupported config format (json only in this slice)" };
  }
  let rawText: string;
  try { rawText = readFileSync(filePath, "utf8"); }
  catch { return { code: "CONFIG_UNVERIFIED", reason: "config unreadable" }; }
  let raw: unknown;
  try { raw = JSON.parse(rawText); }
  catch { return { code: "CONFIG_UNVERIFIED", reason: "config parse failure" }; }
  // Shape gate: the effective config must be a single JSON object.
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { code: "CONFIG_UNVERIFIED", reason: "config shape unsupported (object required)" };
  }
  const out: string[] = [];
  walkKeys(raw, (k) => { if (refusedReason(k) !== null) out.push(k); });
  return Array.from(new Set(out)).sort();
}

function walkKeys(value: unknown, visit: (k: string) => void): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const v of value) walkKeys(v, visit); return; }
  for (const k of Object.keys(value as Record<string, unknown>)) {
    visit(k);
    walkKeys((value as Record<string, unknown>)[k], visit);
  }
}
