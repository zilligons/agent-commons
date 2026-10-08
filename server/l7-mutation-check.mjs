// Runs both poles of the custody and derivation tests against scratch copies.
// One property changes per mutant. The worktree sources are not modified.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The server preload points TMPDIR at a directory inside node_modules. A scratch
// tree there is not a reliable module root, so mutants are staged in /tmp.
process.env.TMPDIR = "/tmp";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = join(root, "packages/agent-commons");
const realSrc = join(pkg, "src");
const keychainPath = join(realSrc, "vendor/pillar/identity/keychain.mjs");
const continuityPath = join(realSrc, "continuity.mjs");
const networkPath = join(root, "server/network.ts");
const staged = [];

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  delete env.L7_CONTINUITY_MODULE;
  delete env.L7_KEYCHAIN_MODULE;
  delete env.L7_NETWORK_MODULE;
  delete env.L7_DB_HOME;
  delete env.L7_SCRATCH_LEAK;
  return { ...env, ...extra };
}

function run(args, cwd, env) {
  return spawnSync(process.execPath, args, { cwd, env, encoding: "utf8", timeout: 90000 });
}

function finish(label, control, mutant, signature) {
  const controlText = `${control.stdout}${control.stderr}`;
  const mutantText = `${mutant.stdout}${mutant.stderr}`;
  assert.equal(control.status, 0, `${label} CONTROL\n${controlText}`);
  assert.doesNotMatch(controlText, signature);
  assert.equal(mutant.status, 1, `${label} MUTANT\n${mutantText}`);
  assert.match(mutantText, signature);
  console.log(`KNOW ${label}: CONTROL rc=0; MUTANT rc=1; signature ${signature}`);
}

function stageContinuity(stored) {
  const dir = mkdtempSync(join(tmpdir(), "l7-cont-"));
  staged.push(dir);
  for (const name of readdirSync(realSrc)) {
    const from = join(realSrc, name);
    if (name === "continuity.mjs") copyFileSync(from, join(dir, name));
    else symlinkSync(from, join(dir, name));
  }
  const path = join(dir, "continuity.mjs");
  const before = "    this.#vaultKey = vaultKey;\n";
  const source = readFileSync(path, "utf8");
  assert.equal(source.split(before).length - 1, 1, "continuity assignment is not unique");
  writeFileSync(path, source.replace(before, `${before}    if (vaultKey !== null) this.store.set("debug-vault-key", ${stored});\n`));
  return path;
}

function stageKeychain() {
  const dir = mkdtempSync(join(tmpdir(), "l7-key-"));
  staged.push(dir);
  // Symlink pkg/node_modules so the staged keychain.mjs can resolve @noble/curves
  // the same way the worktree copy can. Without the link the import walks up to
  // /tmp and / and ERR_MODULE_NOT_FOUND before reaching packages/agent-commons/node_modules.
  symlinkSync(join(pkg, "node_modules"), join(dir, "node_modules"));
  const path = join(dir, "keychain.mjs");
  const before = "  const b = h.slice(0, 16);";
  const source = readFileSync(keychainPath, "utf8");
  assert.equal(source.split(before).length - 1, 1, "keychain slice is not unique");
  writeFileSync(path, source.replace(before, "  const b = h.slice(0, 15);"));
  return path;
}

function stageServer() {
  const dir = mkdtempSync(join(tmpdir(), "l7-srv-"));
  staged.push(dir);
  cpSync(join(root, "server"), join(dir, "server"), { recursive: true });
  cpSync(join(root, "tsconfig.json"), join(dir, "tsconfig.json"));
  cpSync(join(root, "package.json"), join(dir, "package.json"));
  for (const name of ["packages", "shared", "node_modules"]) symlinkSync(join(root, name), join(dir, name));
  const path = join(dir, "server/network.ts");
  const before = '.digest("hex").slice(0, 32)';
  const source = readFileSync(path, "utf8");
  assert.equal(source.split(before).length - 1, 1, "network slice is not unique");
  writeFileSync(path, source.replace(before, '.digest("hex").slice(0, 30)'));
  return dir;
}

const beforeHashes = [continuityPath, keychainPath, networkPath].map((path) => readFileSync(path));
try {
  const custodyArgs = ["--test", "--test-name-pattern", "does not persist the vault key", "test/custody.negative.test.mjs"];
  const scratchArgs = ["--test", "--test-name-pattern", "scratch-copy custody scanner", "test/custody.negative.test.mjs"];
  const vendorArgs = ["--test", "--test-name-pattern", "recorded vectors match vendored", "test/derivation-parity.test.mjs"];
  const serverArgs = ["--import", "tsx", "--test", "--test-name-pattern", "recorded vectors match server", "server/derivation-parity.test.ts"];

  const custodyControl = run(custodyArgs, pkg, cleanEnv());
  finish("custody-prefix", custodyControl, run(custodyArgs, pkg, cleanEnv({ L7_CONTINUITY_MODULE: stageContinuity("vaultKey") })), /uvk_ persisted in/);
  finish("custody-material", custodyControl, run(custodyArgs, pkg, cleanEnv({ L7_CONTINUITY_MODULE: stageContinuity("vaultKey.slice(4)") })), /vault-key material persisted in/);
  const scratchControl = run(scratchArgs, pkg, cleanEnv());
  finish("custody-journal", scratchControl, run(scratchArgs, pkg, cleanEnv({ L7_SCRATCH_LEAK: "wal" })), /vault-key material persisted in commons\.db-wal/);
  finish("custody-shm", scratchControl, run(scratchArgs, pkg, cleanEnv({ L7_SCRATCH_LEAK: "shm" })), /vault-key material persisted in commons\.db-shm/);
  finish("custody-raw", scratchControl, run(scratchArgs, pkg, cleanEnv({ L7_SCRATCH_LEAK: "raw" })), /vault-key raw material persisted in raw\.key/);
  finish(
    "derivation-vendor",
    run(vendorArgs, pkg, cleanEnv()),
    run(vendorArgs, pkg, cleanEnv({ L7_KEYCHAIN_MODULE: stageKeychain() })),
    /vendored derivation mismatch/,
  );
  finish(
    "derivation-server",
    run(serverArgs, root, cleanEnv()),
    run(serverArgs, stageServer(), cleanEnv()),
    /server derivation mismatch/,
  );
} finally {
  for (const dir of staged) rmSync(dir, { recursive: true, force: true });
  const after = [continuityPath, keychainPath, networkPath].map((path) => readFileSync(path));
  for (let i = 0; i < beforeHashes.length; i += 1) {
    assert.ok(beforeHashes[i].equals(after[i]), "worktree source changed during the mutation check");
  }
}
