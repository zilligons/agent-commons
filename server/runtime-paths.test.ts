import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import { resolveRuntimePaths } from "./runtime-paths";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const loader = require.resolve("tsx");
// Explicit private fixture databases need the real driver, not memory isolation.
const Database = require(new URL("../node_modules/better-sqlite3/lib/index.js", import.meta.url).pathname);

test("development defaults resolve from source; explicit roots reject relative and empty paths", () => {
  const paths = resolveRuntimePaths({});
  assert.equal(resolve(paths.appDir), resolve(root));
  assert.equal(resolve(paths.dataDir), resolve(root));
  assert.equal(paths.databasePath, join(root, "commons.db"));
  for (const name of ["AGENT_COMMONS_DATA_DIR", "AGENT_COMMONS_APP_DIR"]) {
    for (const value of ["", "relative", "../elsewhere", "null\0path"])
      assert.throws(() => resolveRuntimePaths({ [name]: value }), new RegExp(name));
    assert.throws(() => resolveRuntimePaths({ NODE_ENV: "production", [name]: root }), /explicit absolute directory/);
  }
  assert.deepEqual(resolveRuntimePaths({ NODE_ENV: "production", AGENT_COMMONS_APP_DIR: "/app", AGENT_COMMONS_DATA_DIR: "/data" }), {
    appDir: "/app", dataDir: "/data", databasePath: "/data/commons.db", production: true,
  });
});

test("CommonJS production paths work without evaluating import.meta.url fallback", () => {
  const home = mkdtempSync(join(tmpdir(), "agentc-cjs-paths-"));
  try {
    const bundle = join(home, "runtime-paths.cjs");
    buildSync({ entryPoints: [join(root, "server/runtime-paths.ts")], outfile: bundle, bundle: true,
      platform: "node", format: "cjs", logLevel: "silent" });
    const source = `const p=require(${JSON.stringify(bundle)}).resolveRuntimePaths();process.stdout.write(JSON.stringify(p));`;
    const env = { PATH: "/usr/bin:/bin", HOME: home, TZ: "America/Los_Angeles", NODE_ENV: "production",
      AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED: "0",
      AGENT_COMMONS_APP_DIR: join(home, "app"), AGENT_COMMONS_DATA_DIR: join(home, "data") };
    const result = spawnSync(process.execPath, ["-e", source], { cwd: home, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).databasePath, join(home, "data/commons.db"));
    const { AGENT_COMMONS_APP_DIR: _removed, ...missingApp } = env;
    const missing = spawnSync(process.execPath, ["-e", source], { cwd: home, env: missingApp, encoding: "utf8" });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /AGENT_COMMONS_APP_DIR must be an explicit absolute directory/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("production storage refuses a missing database and opens an existing fixture from its data root", () => {
  const home = mkdtempSync(join(tmpdir(), "agentc-storage-paths-"));
  try {
    const app = join(home, "app"), data = join(home, "data"), cwd = join(home, "other-cwd");
    for (const dir of [app, data, cwd]) mkdirSync(dir);
    const env = { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: home, TZ: "America/Los_Angeles", NODE_ENV: "production",
      AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED: "0",
      AGENT_COMMONS_APP_DIR: app, AGENT_COMMONS_DATA_DIR: data, TSX_TSCONFIG_PATH: join(root, "tsconfig.json") };
    const source = `await import(${JSON.stringify(new URL("./storage.ts", import.meta.url).href)});`;
    const run = () => spawnSync(process.execPath, ["--import", loader, "--input-type=module", "-e", source], {
      cwd, env, encoding: "utf8", maxBuffer: 1024 * 1024,
    });
    const missing = run();
    assert.equal(missing.status, 1);
    assert.equal(existsSync(join(data, "commons.db")), false);
    assert.equal(existsSync(join(cwd, "commons.db")), false);
    const fixture = new Database(join(data, "commons.db"));
    fixture.exec("CREATE TABLE snapshots (id TEXT PRIMARY KEY, data TEXT NOT NULL); INSERT INTO snapshots VALUES ('preserved', '{\"value\":7}')");
    fixture.close();
    const existing = run();
    assert.equal(existing.status, 0, existing.stderr);
    const verified = new Database(join(data, "commons.db"), { readonly: true });
    assert.deepEqual(verified.prepare("SELECT data FROM snapshots WHERE id = 'preserved'").get(), { data: '{"value":7}' });
    verified.close();
    assert.equal(existsSync(join(cwd, "commons.db")), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
