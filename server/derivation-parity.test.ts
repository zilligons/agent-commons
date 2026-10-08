import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const vectorsPath = join(root, "packages/agent-commons/test/fixtures/derivation-vectors.json");
const vectors = JSON.parse(readFileSync(vectorsPath, "utf8")).vectors;

const keychainHref = process.env.L7_KEYCHAIN_MODULE
  ? pathToFileURL(process.env.L7_KEYCHAIN_MODULE).href
  : pathToFileURL(join(root, "packages/agent-commons/src/vendor/pillar/identity/keychain.mjs")).href;
const { localIdFromKey } = await import(keychainHref);

test("recorded vectors match vendored localIdFromKey", () => {
  assert.equal(vectors.length, 3);
  for (const vector of vectors) {
    const got = localIdFromKey(Buffer.from(vector.rawPublicHex, "hex"));
    assert.equal(got, vector.localId, `vendored derivation mismatch for ${vector.id}`);
  }
});

test("recorded vectors match server network identity", () => {
  const home = mkdtempSync(join(tmpdir(), "l7-deriv-"));
  try {
    symlinkSync(join(root, "packages"), join(home, "packages"), "dir");
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_TEST_CONTEXT;
    env.L7_DB_HOME = home;
    env.L7_VECTORS = vectorsPath;
    env.L7_NETWORK_MODULE = pathToFileURL(join(here, "network.ts")).href;
    env.TSX_TSCONFIG_PATH = join(root, "tsconfig.json");
    const child = spawnSync(process.execPath, ["--import", "tsx", join(here, "derivation-parity-probe.mjs")], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 60000,
    });
    assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
    const line = child.stdout.trim().split("\n").filter(Boolean).at(-1);
    const got = JSON.parse(line ?? "");
    assert.equal(got.length, vectors.length);
    for (const vector of vectors) {
      const row = got.find((item: { id: string }) => item.id === vector.id);
      assert.ok(row, vector.id);
      assert.equal(row.publicKeyHex, vector.rawPublicHex, `server fed a different key for ${vector.id}`);
      assert.equal(row.uuaid, vector.uuaid, `server derivation mismatch for ${vector.id}`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
