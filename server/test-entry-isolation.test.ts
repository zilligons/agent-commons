import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(new URL("../package.json", import.meta.url));
const loader = require.resolve("tsx");
const entries = [
  "adapters/l10-r3.test.ts",
  "adapters/l10-r5.test.ts",
  "adapters/l10-limits.test.ts",
  "adapters/integration.test.ts",
  "cohort.test.ts",
  "engine.test.ts",
  "network.test.ts",
  "offline.test.ts",
  "provider-credentials.test.ts",
  "adapters/l10-r7.test.ts",
];
const tsconfig = fileURLToPath(new URL("../tsconfig.json", import.meta.url));

function fixture({ stopAtIsolation = false, memoryRunner = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "test-entry-isolation-"));
  const counter = join(home, "db-resolutions.txt");
  writeFileSync(counter, "");
  const isolation = join(home, "isolation-resolutions.txt");
  writeFileSync(isolation, "");
  const tripwire = join(home, "db-tripwire.mjs");
  writeFileSync(tripwire, `import {registerHooks} from "node:module";
import {appendFileSync} from "node:fs";
registerHooks({resolve(specifier,context,nextResolve){
  if(${stopAtIsolation} && /(?:^|\\/)offline-test-home\\.mjs$/.test(specifier)){
    appendFileSync(${JSON.stringify(isolation)},"1\\n");
    process.exit(65);
  }
  const resolved = new URL(specifier, context.parentURL || "file:///").pathname;
  const database = specifier === "better-sqlite3" || specifier === "node:sqlite" || resolved.includes("/better-sqlite3/") || /\\/storage(?:\\.[cm]?[jt]s)?$/.test(resolved);
  if(database && (!${memoryRunner} || specifier === "better-sqlite3")){
    appendFileSync(${JSON.stringify(counter)},"1\\n");
    throw new Error("DATABASE_RESOLUTION_BLOCKED");
  }
  return nextResolve(specifier,context);
}});
`);
  const env = { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: home, NODE_ENV: "test", TZ: "America/Los_Angeles",
    TSX_TSCONFIG_PATH: tsconfig, AGENT_COMMONS_OFFLINE: "1", AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED: "0",
    PYTHONDONTWRITEBYTECODE: "1" };
  const run = (args: string[]) => spawnSync(process.execPath, ["--import", pathToFileURL(tripwire).href,
    "--import", loader, ...args], { cwd: home, env, encoding: "utf8", maxBuffer: 1024 * 1024 });
  const resolutions = () => readFileSync(counter, "utf8").split("\n").filter(Boolean).length;
  const isolations = () => readFileSync(isolation, "utf8").split("\n").filter(Boolean).length;
  return { home, run, resolutions, isolations };
}

for (const entry of entries) {
  const path = fileURLToPath(new URL(entry, import.meta.url));
  test(`${entry}: direct execution refuses before storage or SQLite resolution`, () => {
    const f = fixture();
    try {
      const direct = f.run([path]);
      assert.ifError(direct.error);
      assert.equal(direct.signal, null);
      assert.equal(direct.status, 64);
      assert.match(direct.stderr, /TEST_RUNNER_REQUIRED/);
      assert.equal(f.resolutions(), 0);
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });

  test(`${entry}: node test entry reaches memory isolation before application storage`, () => {
    const f = fixture({ stopAtIsolation: true });
    try {
      // Stop at the isolation import itself. Hazardous test bodies never run in
      // this ordering check, and every storage/driver import remains blocked.
      const result = f.run(["--test", "--test-reporter=tap", path]);
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /exitCode: 65/);
      assert.equal(f.isolations(), 1);
      assert.equal(f.resolutions(), 0);
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });
}

test("storage and both SQLite import forms are blocked before unguarded code can open a database", () => {
  const targets = [
    "better-sqlite3",
    "node:sqlite",
    new URL("../node_modules/better-sqlite3/lib/index.js", import.meta.url).href,
    new URL("./storage.ts", import.meta.url).href,
  ];
  for (const target of targets) {
    const f = fixture();
    try {
      // These are module-resolution controls, never destructive test mutants.
      // The hook throws before the imported module or any constructor runs.
      const unguarded = join(f.home, "unguarded.mjs");
      writeFileSync(unguarded, `await import(${JSON.stringify(target)});\n`);
      const detected = f.run([unguarded]);
      assert.ifError(detected.error);
      assert.equal(detected.signal, null);
      assert.equal(detected.status, 1);
      assert.match(detected.stderr, /DATABASE_RESOLUTION_BLOCKED/);
      assert.equal(f.resolutions(), 1);
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  }
});

test("R7 node test entry installs memory isolation without NODE_OPTIONS", () => {
  const f = fixture({ memoryRunner: true });
  try {
    const entry = fileURLToPath(new URL("./adapters/l10-r7.test.ts", import.meta.url));
    const result = f.run(["--test", "--test-reporter=tap", entry]);
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^# tests 1$/m);
    assert.match(result.stdout, /^# pass 1$/m);
    assert.match(result.stdout, /^# fail 0$/m);
    assert.equal(f.resolutions(), 0);
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});
