
// Run both poles on scratch source copies; one-property mutations only.
// Live transport/UI is out of scope here.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
mkdirSync(join(root, "dist"), { recursive: true });
const scratch = mkdtempSync(join(root, "dist", ".offline-mutant-"));
function run(home, kind) {
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
  if (kind === "ttl") {
    env.NODE_OPTIONS = `--import=${join(home, "server/offline-test-home.mjs")}`;
    env.TSX_TSCONFIG_PATH = join(home, "tsconfig.json");
    return spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-name-pattern=one-hour", "server/cohort.offline.test.ts"],
      { cwd: home, env, encoding: "utf8", timeout: 15000 });
  }
  delete env.NODE_OPTIONS;
  return spawnSync("python3", ["-m", "unittest", "cohort_bridge_test.ErrorDiagnosticsTests.test_empty_response_runtime_error"],
    { cwd: join(home, "server"), env, encoding: "utf8", timeout: 15000 });
}
try {
  cpSync(join(root, "server"), join(scratch, "server"), { recursive: true });
  cpSync(join(root, "tsconfig.json"), join(scratch, "tsconfig.json"));
  cpSync(join(root, "package.json"), join(scratch, "package.json"));
  for (const name of ["packages", "shared", "docs"]) symlinkSync(join(root, name), join(scratch, name), "dir");
  mkdirSync(join(scratch, "node_modules"));
  for (const name of readdirSync(join(root, "node_modules"))) {
    if (name.startsWith(".offline-")) continue;
    symlinkSync(join(root, "node_modules", name), join(scratch, "node_modules", name));
  }
  const mutations = [
    { kind: "ttl", path: "server/cohort.ts", before: "Date.now()-Date.parse(known.checkedAt)<3600000", after: "Date.now()-Date.parse(known.checkedAt)<3600001", signature: /3 !== 7/ },
    { kind: "empty", path: "server/cohort_bridge.py", before: "str(details or error)", after: 'str(details or "")', signature: /TRANSPORT_ERROR.*EMPTY_RESPONSE/ },
  ];
  for (const mutation of mutations) {
    const control = run(root, mutation.kind);
    assert.equal(control.status, 0, control.stdout + control.stderr);
    const path = join(scratch, mutation.path);
    const source = readFileSync(path, "utf8");
    assert.equal(source.split(mutation.before).length - 1, 1, "Mutate exactly one source occurrence");
    writeFileSync(path, source.replace(mutation.before, mutation.after));
    const mutant = run(scratch, mutation.kind);
    assert.equal(mutant.status, 1, mutant.stdout + mutant.stderr);
    assert.match(mutant.stdout + mutant.stderr, mutation.signature);
    writeFileSync(path, source);
    console.log(`KNOW ${mutation.kind}: CONTROL rc=0; MUTANT rc=1; detected single-property mutation in ${mutation.path}`);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
