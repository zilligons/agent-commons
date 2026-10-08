import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { generateVaultKey } from "@uuaid/sdk";
import { initialize, loadRuntime } from "../src/config.mjs";

const PREFIX = Buffer.from("uvk_");
// Representations this scanner checks, and only these: the 4-byte uvk_ prefix,
// the full vault-key string, the 64-byte ASCII hex suffix, and the decoded
// 32-byte key. Base64, split fragments, and other encodings are not claimed.

function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...filesUnder(path));
    else if (stat.isFile()) out.push(path);
  }
  return out;
}

function containsPrefix(dir) {
  return filesUnder(dir).some((path) => readFileSync(path).includes(PREFIX));
}

function scan(home, vaultKey) {
  const full = Buffer.from(vaultKey);
  const material = Buffer.from(vaultKey.slice(PREFIX.length));
  const raw = Buffer.from(vaultKey.slice(PREFIX.length), "hex");
  assert.equal(material.length, 64);
  assert.equal(raw.length, 32);
  const files = filesUnder(home);
  const rels = files.map((path) => relative(home, path));
  for (const name of ["commons.db", "config.json", "local-secret", "identity.json"]) {
    assert.ok(rels.includes(name), `missing ${name}`);
  }
  for (const path of files) {
    const rel = relative(home, path);
    const buf = readFileSync(path);
    assert.equal(buf.includes(PREFIX), false, `uvk_ persisted in ${rel}`);
    assert.equal(buf.includes(full), false, `vault key persisted in ${rel}`);
    assert.equal(buf.includes(material), false, `vault-key material persisted in ${rel}`);
    assert.equal(buf.includes(raw), false, `vault-key raw material persisted in ${rel}`);
  }
  return rels;
}

function changedFiles(left, right) {
  const names = filesUnder(left).map((path) => relative(left, path)).sort();
  const rightNames = filesUnder(right).map((path) => relative(right, path)).sort();
  assert.deepEqual(rightNames, names);
  return names.filter((name) => !readFileSync(join(left, name)).equals(readFileSync(join(right, name))));
}

test("scratch-home continuity session does not persist the vault key", async () => {
  let home = null;
  let store = null;
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      home = mkdtempSync(join(tmpdir(), "l7-custody-"));
      initialize({ home, target: "local", name: "custody fixture" });
      if (!containsPrefix(home)) break;
      rmSync(home, { recursive: true, force: true });
      home = null;
    }
    assert.ok(home, "fixture home contained uvk_ before the continuity session");
    const loaded = loadRuntime(home);
    store = loaded.store;
    const vaultKey = generateVaultKey();
    assert.match(vaultKey, /^uvk_[0-9a-f]{64}$/);
    let saved = null;
    let used = 0;
    const client = {
      async saveMemory(agent, key, text, presented) {
        assert.equal(presented, vaultKey);
        used += 1;
        saved = text;
        return { agent, key, content_hash: "ab".repeat(32), size_bytes: Buffer.byteLength(text), replaced: false };
      },
      async loadMemory(_agent, _key, presented) {
        assert.equal(presented, vaultKey);
        used += 1;
        return saved;
      },
    };
    const href = process.env.L7_CONTINUITY_MODULE
      ? pathToFileURL(process.env.L7_CONTINUITY_MODULE).href
      : new URL("../src/continuity.mjs", import.meta.url).href;
    const { ContinuityMemory } = await import(href);
    const memory = new ContinuityMemory({ keychain: loaded.keychain, store, client, vaultKey });
    memory.remember("note", { text: "custody fixture" });
    const pushed = await memory.push();
    const pulled = await memory.pull();
    assert.equal(pushed.relation, "pushed");
    assert.equal(pulled.relation, "in-sync");
    assert.equal(used, 2);
    assert.equal(memory.status().durable, true);
    assert.equal(JSON.stringify(memory.status()).includes("uvk_"), false);
    assert.equal(JSON.stringify(memory.snapshot()).includes("uvk_"), false);
    const openRels = scan(home, vaultKey);
    assert.ok(openRels.includes("commons.db-wal"), "live commons.db-wal missing from the open custody manifest");
    assert.ok(openRels.includes("commons.db-shm"), "live commons.db-shm missing from the open custody manifest");
    store.close();
    store = null;
    const closedRels = scan(home, vaultKey);
    assert.ok(closedRels.includes("commons.db"));
    assert.ok(closedRels.length >= 4);
  } finally {
    store?.close();
    if (home) rmSync(home, { recursive: true, force: true });
  }
});

test("scratch-copy custody scanner sees a one-property sidecar leak", () => {
  const leak = process.env.L7_SCRATCH_LEAK ?? "";
  assert.ok(["", "wal", "shm", "raw"].includes(leak), "unknown scratch leak");
  const vaultKey = generateVaultKey();
  assert.match(vaultKey, /^uvk_[0-9a-f]{64}$/);
  const ascii = Buffer.from(vaultKey.slice(PREFIX.length));
  const raw = Buffer.from(vaultKey.slice(PREFIX.length), "hex");
  const benign = Buffer.alloc(ascii.length, 0x61);
  const zeros = Buffer.alloc(raw.length, 0);
  assert.equal(benign.equals(ascii), false, "benign journal collided with the hex suffix");
  assert.equal(zeros.equals(raw), false, "zero raw file collided with the decoded key");
  assert.equal(raw.includes(PREFIX), false, "decoded key collided with the prefix");
  const parent = mkdtempSync(join(tmpdir(), "l7-scratch-"));
  try {
    const control = join(parent, "control");
    const copy = join(parent, "copy");
    mkdirSync(control);
    writeFileSync(join(control, "commons.db"), Buffer.from("not-a-database"));
    writeFileSync(join(control, "config.json"), Buffer.from("{}\n"));
    writeFileSync(join(control, "local-secret"), Buffer.from("scratch-secret"));
    writeFileSync(join(control, "identity.json"), Buffer.from("{}\n"));
    writeFileSync(join(control, "commons.db-wal"), benign);
    writeFileSync(join(control, "commons.db-shm"), benign);
    writeFileSync(join(control, "raw.key"), zeros);
    cpSync(control, copy, { recursive: true });
    const target = { wal: "commons.db-wal", shm: "commons.db-shm", raw: "raw.key" }[leak];
    if (target) {
      const next = leak === "raw" ? raw : ascii;
      assert.equal(next.length, readFileSync(join(copy, target)).length);
      writeFileSync(join(copy, target), next);
      assert.deepEqual(changedFiles(control, copy), [target]);
    } else {
      assert.deepEqual(changedFiles(control, copy), []);
    }
    const rels = scan(copy, vaultKey);
    assert.deepEqual(rels.slice().sort(), [
      "commons.db",
      "commons.db-shm",
      "commons.db-wal",
      "config.json",
      "identity.json",
      "local-secret",
      "raw.key",
    ]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
