import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CLOSED_CONSOLE_ALLOWLIST } from "./adapters/l10-env";
import { L10_APP_CONTROL_ALLOWLIST } from "./dotenv-guard";
import { L10_BIN_ENV_NAMES } from "./adapters/config";

// The console launch path (server/index.ts) rebuilds process.env from
// CLOSED_CONSOLE_ALLOWLIST before the app loads. These tests run the real
// index.ts in a child process and swap only "./app" for a stub that
// reports what the L10 resolver sees after that rebuild.

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const routeNames = Object.values(L10_BIN_ENV_NAMES) as string[];

test("every L10 route env name survives the console env rebuild and is never a .env name", () => {
  for (const name of routeNames) {
    assert.ok((CLOSED_CONSOLE_ALLOWLIST as readonly string[]).includes(name), `${name} missing from CLOSED_CONSOLE_ALLOWLIST`);
    assert.ok(!L10_APP_CONTROL_ALLOWLIST.includes(name), `${name} must not be settable from .env`);
  }
});

type Report = { route: string; codex: string; grok: string; present: string[]; unlistedProbe: boolean };

function launch(processEnvExtra: Record<string, string>, dotenv: string | null): Report {
  const dir = mkdtempSync(join(tmpdir(), "console-route-env-"));
  try {
    const cwd = join(dir, "cwd");
    const bin = join(dir, "bin");
    mkdirSync(cwd);
    mkdirSync(bin);
    if (dotenv !== null) writeFileSync(join(cwd, ".env"), dotenv.replaceAll("@DIR@", dir));
    for (const name of ["claude", "codex", "grok"]) writeFileSync(join(bin, name), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    writeFileSync(join(dir, "ledger.jsonl"), "");

    const configUrl = pathToFileURL(join(root, "server/adapters/config.ts")).href;
    const stub = join(dir, "app-stub.mjs");
    writeFileSync(stub, [
      `const cfg = await import(${JSON.stringify(configUrl)});`,
      `const r = cfg.getResolvedL10Binaries();`,
      `const route = cfg.getClaudeRouteResolution();`,
      `const names = Object.values(cfg.L10_BIN_ENV_NAMES);`,
      `process.stdout.write("ROUTE-ENV " + JSON.stringify({`,
      `  route: route.status === "enabled" ? "enabled" : route.reason,`,
      `  codex: r.codex.status, grok: r.grok.status,`,
      `  present: names.filter((n) => process.env[n] !== undefined),`,
      `  unlistedProbe: process.env.AC_UNLISTED_PROBE !== undefined,`,
      `}) + "\\n");`,
    ].join("\n"));
    const hooks = join(dir, "hooks.mjs");
    writeFileSync(hooks, [
      `const STUB = ${JSON.stringify(pathToFileURL(stub).href)};`,
      `export async function resolve(specifier, context, next) {`,
      `  if ((specifier === "./app" || specifier === "./app.ts") && String(context.parentURL).endsWith("/server/index.ts")) {`,
      `    return { url: STUB, shortCircuit: true };`,
      `  }`,
      `  return next(specifier, context);`,
      `}`,
    ].join("\n"));
    const register = join(dir, "register.mjs");
    writeFileSync(register, `import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(hooks).href)});\n`);

    const env: Record<string, string> = {
      HOME: dir,
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      TMPDIR: dir,
      NODE_ENV: "development",
      TSX_TSCONFIG_PATH: join(root, "tsconfig.json"),
      AC_UNLISTED_PROBE: "1",
      ...Object.fromEntries(Object.entries(processEnvExtra).map(([k, v]) => [k, v.replaceAll("@DIR@", dir)])),
    };
    const tsxLoader = pathToFileURL(join(root, "node_modules/tsx/dist/loader.mjs")).href;
    const child = spawnSync(process.execPath, ["--import", tsxLoader, "--import", pathToFileURL(register).href, join(root, "server/index.ts")], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 60000,
    });
    assert.equal(child.status, 0, `index.ts launch failed:\n${child.stderr}\n${child.stdout}`);
    const line = child.stdout.split("\n").find((l) => l.startsWith("ROUTE-ENV "));
    assert.ok(line, `no ROUTE-ENV line:\n${child.stdout}\n${child.stderr}`);
    return JSON.parse(line.slice("ROUTE-ENV ".length)) as Report;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("console launch keeps the L10 route names from the process env and enables the Claude route", () => {
  const got = launch({
    AGENT_COMMONS_CLAUDE_BIN: "@DIR@/bin/claude",
    AGENT_COMMONS_CODEX_BIN: "@DIR@/bin/codex",
    AGENT_COMMONS_GROK_BIN: "@DIR@/bin/grok",
    AGENT_COMMONS_MODEL_LEDGER: "@DIR@/ledger.jsonl",
    AGENT_COMMONS_WITNESS_SEATS: "seat-a,seat-b",
  }, null);
  assert.equal(got.route, "enabled");
  assert.equal(got.codex, "enabled");
  assert.equal(got.grok, "enabled");
  assert.deepEqual([...got.present].sort(), [...routeNames].sort());
  assert.equal(got.unlistedProbe, false, "a name outside the allowlist must still be dropped");
});

test("console launch ignores L10 route names that arrive only through .env", () => {
  const got = launch({}, [
    "AGENT_COMMONS_CLAUDE_BIN=@DIR@/bin/claude",
    "AGENT_COMMONS_MODEL_LEDGER=@DIR@/ledger.jsonl",
    "AGENT_COMMONS_WITNESS_SEATS=seat-a",
    "",
  ].join("\n"));
  assert.equal(got.route, "claude bin unset");
  assert.deepEqual(got.present, []);
});
