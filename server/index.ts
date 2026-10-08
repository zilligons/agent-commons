/**
 * L10 — launch bootstrap. The ONLY launch entry (dev: `tsx server/index.ts`;
 * build: esbuild `server/index.ts` → `dist/index.cjs`; start: `node
 * dist/index.cjs`). Imports ONLY Node builtins and the side-effect-free
 * env-policy/bootstrap modules, scrubs §c refused names, PROVES the
 * resulting env clean, VALIDATES the effective controllable app config
 * (.env via dotenv-guard with the v3 §c L71 app-control allowlist), then
 * dynamically imports the application (server/app.ts).
 *
 * ESM evaluates ALL static imports before the first body statement, so a
 * scrub placed beside static application imports is a no-op (the security reviewer B1,
 * proven both poles on a scratch ESM probe). The boundary therefore has
 * exactly two files: this bootstrap (no application static imports) and
 * app.ts (all application imports, dynamic-import target only).
 *
 * R1 (rework 5): the bootstrap CONSTRUCTS the closed console env via
 * buildClosedConsoleEnv (BASH_ENV, NODE_OPTIONS, etc. are absent by
 * construction) and uses it for the application. The .env guard is now
 * allowlist-scoped (v3 §c L71: HOME/PATH/USER/TERM/LANG/TMPDIR/TZ +
 * NODE_ENV/PORT/AGENT_COMMONS_*) — the BASH_ENV file mutant applies
 * neither BASH_ENV nor the refused key; only the allowed keys are
 * applied. Effective controllable config is checked before the
 * application evaluation. v3 §c L77: no automatic `import
 * "dotenv/config"`.
 *
 */
import { scrubAndProve, buildClosedConsoleEnv } from "./bootstrap";
import { applyDotenvGuarded } from "./dotenv-guard";

const survivors = scrubAndProve();
if (survivors !== null) {
  // Static, safe message: NAMES only, never values (v3 §c L73).
  console.error(`ENV_REFUSED: §c refused names survive scrub: ${survivors.join(",")}`);
  process.exit(64);
}

// R1 (rework 5 + rework 6): the closed console env is CONSTRUCTED from the
// v3 §b allowlist (not inherited from the parent). Names outside the
// allowlist — BASH_ENV, NODE_OPTIONS, DYLD_*/LD_* preload hooks,
// npm_config_*, unlisted names — are absent by construction.
// We replace the live process.env contents with the constructed closed
// environment so the application actually observes the closed environment.
const closedConsole = buildClosedConsoleEnv(process.env);
for (const k of Object.keys(process.env)) {
  if (!Object.prototype.hasOwnProperty.call(closedConsole, k)) {
    delete process.env[k];
  }
}
for (const [k, v] of Object.entries(closedConsole)) {
  process.env[k] = v;
}

// v3 §c L71: validate the effective controllable app config (.env) —
// allowed keys applied to the live process.env, unclassified names
// reported as unlisted, §c names terminal. This runs BEFORE the
// application is evaluated; the app's first code is the dynamic
// import below.
const dotenvResult = applyDotenvGuarded({ env: process.env });
if (!dotenvResult.ok) {
  console.error(`ENV_REFUSED: §c refused names in .env: ${dotenvResult.refusedNames.join(",")}`);
  process.exit(64);
}

(async () => {
  await import("./app");
})();
