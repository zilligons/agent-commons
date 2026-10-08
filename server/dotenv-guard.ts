/**
 * L10 — guarded dotenv loader (rework 2, item D1; v3 §c L77).
 *
 * The application may read local app controls from a `.env` file in the
 * launch cwd, but it MUST NOT use `import "dotenv/config"`: that auto-
 * import mutates process.env with whatever the file carries, injecting
 * §c refused names into the console AFTER the bootstrap scrub proved it
 * clean (mechanism verified by the security reviewer with dotenv 16.6.1).
 *
 * This loader instead:
 *   1. parses the file WITHOUT mutating process.env,
 *   2. rejects any §c refused name (including any empty-valued name) as
 *      terminal ENV_REFUSED — names only, never values,
 *   3. applies only the allowed keys, and only for names not already set
 *      in the console env (same precedence as dotenv: existing wins).
 *
 * Side-effect-free module: the guard runs only when applyDotenvGuarded()
 * is called (from server/app.ts at application evaluation, i.e. AFTER the
 * bootstrap scrub), or by the two-pole test.
 *
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scrubEnv } from "./adapters/l10-env";

/** Minimal .env parser: KEY=VALUE lines, `#` comments, optional quotes.
 *  Does NOT handle multi-line values or command substitution — those are
 *  out of scope for app controls, and a line that does not match the
 *  KEY=VALUE shape is ignored (never executed). */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export type DotenvGuardResult =
  | { ok: true; applied: string[]; skippedExisting: string[] }
  | { ok: false; code: "ENV_REFUSED"; refusedNames: string[] };

/**
 * Parse `.env` at `cwd`, reject §c names, apply the rest. Pure with
 * respect to process.env when `env` is supplied (the test drives it with
 * a scratch env object).
 */
/**
 * R1 (rework 5, v3 §c L71): the .env guard applies ONLY an explicit
 * app-control allowlist. Names outside the allowlist (BASH_ENV,
 * NODE_OPTIONS, arbitrary UNLISTED names like FOO=bar) are NOT applied
 * to process.env — they are listed as `unlisted` and ignored. A
 * §c-classified name is refused (terminal ENV_REFUSED), as before.
 * The previous "apply every unclassified name" policy is replaced.
 */
export const L10_APP_CONTROL_ALLOWLIST: readonly string[] = Object.freeze([
  "NODE_ENV", "PORT",
  "AGENT_COMMONS_OFFLINE", "AGENT_COMMONS_ADAPTER",
  "AGENT_COMMONS_STUB_FIXTURES", "AGENT_COMMONS_PRIVATE_PREVIEW",
  "AGENT_COMMONS_PREVIEW_ORIGINS", "AGENT_COMMONS_BIND_ALL",
] as const);

export function applyDotenvGuarded(opts: {
  cwd?: string;
  file?: string;
  env?: NodeJS.ProcessEnv;
  allowlist?: readonly string[];
} = {}): DotenvGuardResult & { unlisted?: string[] } {
  const cwd = opts.cwd ?? process.cwd();
  const path = join(cwd, opts.file ?? ".env");
  const env = opts.env ?? process.env;
  if (!existsSync(path)) return { ok: true, applied: [], skippedExisting: [] };
  const parsed = parseDotenv(readFileSync(path, "utf8"));
  // Reject §c refused names (a classified name is refused whether its
  // value is present or empty per v3 L61). Unclassified names are NOT
  // refused here — they're checked against the allowlist below.
  const { refused } = scrubEnv(Object.fromEntries(Object.entries(parsed)));
  if (refused.length > 0) {
    return { ok: false, code: "ENV_REFUSED", refusedNames: refused };
  }
  const allow = new Set(opts.allowlist ?? L10_APP_CONTROL_ALLOWLIST);
  const applied: string[] = [];
  const skippedExisting: string[] = [];
  const unlisted: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (!allow.has(k)) { unlisted.push(k); continue; }
    if (env[k] !== undefined) { skippedExisting.push(k); continue; }
    env[k] = v;
    applied.push(k);
  }
  return { ok: true, applied, skippedExisting, unlisted };
}

/**
 * Launch-time wrapper: terminal ENV_REFUSED on a refused name in `.env`
 * (v3 §c L77). Names only, never values.
 */
export function applyDotenvGuardedOrExit(opts: { cwd?: string; file?: string } = {}): void {
  const r = applyDotenvGuarded(opts);
  if (!r.ok) {
    console.error(`ENV_REFUSED: §c refused names in ${opts.file ?? ".env"}: ${r.refusedNames.join(",")}`);
    process.exit(64);
  }
}
