/**
 * Adapted from pillar test/unit/keychain-strict-ed25519.test.mjs
 * Source sha256: e115b19e6881d5a64d0a87b7f6ba0bbac05f7aa1290778bca68447fda3a9a5ae (pillar commit 2ef548d)
 *
 * Changes made for agent-commons layout (Item 3, C3):
 * 1. Adjusted import paths: Keychain and helpers from ../src/vendor/pillar/identity/keychain.mjs,
 *    envelope methods from ../src/vendor/pillar/net/envelope.mjs, and vectors fixture from ./fixtures/ed25519-small-order.vectors.json.
 * 2. In withMutant(), placed temporary mutant trees under os.tmpdir() using mkdtempSync rather than next to test/ or src/.
 * 3. Symlinked packages/agent-commons/node_modules into the temporary directory so @noble/curves resolves in ESM.
 * 4. Cleaned up temporary mutant directories in withMutant() finally block.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, cpSync, rmSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { Keychain, isStrictEd25519PublicKey, localIdFromKey } from "../src/vendor/pillar/identity/keychain.mjs";
import { seal, open, decrypt } from "../src/vendor/pillar/net/envelope.mjs";

const SRC = new URL("../src/vendor/pillar/", import.meta.url);
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/ed25519-small-order.vectors.json", import.meta.url), "utf-8"));

const IDENTITY = "01" + "00".repeat(31);
/** R = the identity point, S = 0. Verifies under OpenSSL for any message when A is the identity point. */
const FORGED_SIG = "01" + "00".repeat(31) + "00".repeat(32);
/** A point of order 8 (canonical encoding). */
const T8 = "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a";
const MESSAGES = ["", "a", "pillar", "x".repeat(97)].map((s) => Buffer.from(s, "utf-8"));

function torsionPoints() {
  const t = ed25519.Point.fromHex(T8, true);
  const out = [];
  let p = ed25519.Point.ZERO;
  for (let k = 0; k < 8; k++) {
    out.push(p.toHex());
    p = p.add(t);
  }
  return out;
}

/** Little-endian encodings of y = p + j (j = 0, 1), with and without the sign bit: non-canonical small-order points. */
function nonCanonicalSmallOrder() {
  const P = (1n << 255n) - 19n;
  const out = [];
  for (const y of [P, P + 1n]) {
    for (const sign of [0n, 1n]) {
      let v = y | (sign << 255n);
      const b = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) {
        b[i] = Number(v & 0xffn);
        v >>= 8n;
      }
      out.push(b.toString("hex"));
    }
  }
  return out;
}

function honestKeychain() {
  const kc = Object.create(Keychain.prototype);
  kc._identity = Keychain.generate();
  return kc;
}

function dropRule(text, rule) {
  const lines = text.split("\n");
  const hits = lines.filter((l) => l.includes(`// @rule ${rule}`)).length;
  assert.equal(hits, 1, `marker "${rule}" must appear exactly once`);
  return lines.filter((l) => !l.includes(`// @rule ${rule}`)).join("\n");
}

let mutantN = 0;
/**
 * Load copies of keychain.mjs and envelope.mjs with the named rule lines
 * dropped. The copies live in a temporary mirror in os.tmpdir() (never inside
 * src/ or test/, which other tests walk in parallel), with node_modules symlinked.
 */
async function withMutant({ keychain = [], envelope = [] }, fn) {
  const tmpBase = mkdtempSync(join(tmpdir(), `ac-mutant-${process.pid}-${mutantN++}-`));
  const src = join(tmpBase, "pillar");
  cpSync(fileURLToPath(SRC), src, { recursive: true });
  const pkgNodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));
  symlinkSync(pkgNodeModules, join(tmpBase, "node_modules"), "dir");
  try {
    const kPath = join(src, "identity/keychain.mjs");
    const ePath = join(src, "net/envelope.mjs");
    let k = readFileSync(kPath, "utf-8");
    for (const r of keychain) k = dropRule(k, r);
    let e = readFileSync(ePath, "utf-8");
    for (const r of envelope) e = dropRule(e, r);
    writeFileSync(kPath, k);
    writeFileSync(ePath, e);
    const K = await import(pathToFileURL(kPath).href);
    const E = await import(pathToFileURL(ePath).href);
    return await fn({ Keychain: K.Keychain, open: E.open });
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
}

/** An envelope "from" the identity-point uuaid, built with no private key (the forge). */
function forgedEnvelope(recipientKc) {
  const honest = seal(honestKeychain(), {
    recipient: recipientKc._identity.uuaid,
    recipientPublicKey: recipientKc._identity.publicKeyHex,
    payload: { text: "forged" },
  });
  const sender = `uuaid:foundation:agent:${localIdFromKey(Buffer.from(IDENTITY, "hex"))}`;
  const { transportSignature: _s, ...body } = honest;
  return {
    ...body,
    sender,
    transportSignature: { alg: "ed25519", keyId: sender, publicKey: IDENTITY, signature: FORGED_SIG, created: body.createdAt },
  };
}

// ───────────────────────────────────────────────────────── the key rule itself ──

test("isStrictEd25519PublicKey: an honest key passes, in either case", () => {
  const id = Keychain.generate();
  assert.equal(isStrictEd25519PublicKey(id.publicKeyHex), true);
  assert.equal(isStrictEd25519PublicKey(id.publicKeyHex.toUpperCase()), true);
});

test("isStrictEd25519PublicKey: all 8 small-order points are refused", () => {
  const pts = torsionPoints();
  assert.equal(new Set(pts).size, 8, "8 distinct torsion points");
  for (const hex of pts) {
    assert.equal(ed25519.Point.fromHex(hex, true).isSmallOrder(), true, `${hex} is small order`);
    assert.equal(isStrictEd25519PublicKey(hex), false, `${hex} refused`);
  }
});

test("isStrictEd25519PublicKey: non-canonical encodings (y >= p) are refused", () => {
  for (const hex of nonCanonicalSmallOrder()) assert.equal(isStrictEd25519PublicKey(hex), false, `${hex} refused`);
});

test("isStrictEd25519PublicKey: a mixed-order key (honest + torsion) is refused", () => {
  const honest = ed25519.Point.fromHex(Keychain.generate().publicKeyHex, false);
  const mixed = honest.add(ed25519.Point.fromHex(T8, true)).toHex();
  assert.equal(isStrictEd25519PublicKey(mixed), false);
});

test("isStrictEd25519PublicKey: junk is refused without throwing", () => {
  for (const x of [undefined, null, 7, "", "zz".repeat(32), "00".repeat(31), "00".repeat(33)]) {
    assert.equal(isStrictEd25519PublicKey(x), false);
  }
});

test("vector 3s2: the identity-point member key derives its uuaid, so only the strict rule refuses it", () => {
  const v = FIXTURE["3s2-small-order-member-key"];
  assert.equal(`uuaid:foundation:agent:${localIdFromKey(Buffer.from(v.key, "hex"))}`, v.uuaid);
  assert.equal(isStrictEd25519PublicKey(v.key), false);
});

// ──────────────────────────────────────────── verifyDetached (14 call sites) ──

test("verifyDetached: an honest signature still verifies", () => {
  const kc = honestKeychain();
  const msg = Buffer.from("hello", "utf-8");
  assert.equal(Keychain.verifyDetached(kc._identity.publicKeyHex, msg, kc.sign(msg)), true);
  assert.equal(Keychain.verifyDetached(kc._identity.publicKeyHex, Buffer.from("other"), kc.sign(msg)), false);
});

test("keychain.strict-key — vector 1s (identity-point signer): CONTROL refused, MUTANT verifies", async () => {
  const v = FIXTURE["1s-small-order-signer"];
  const preimage = Buffer.from(v.signingPreimageHex, "hex");
  const sig = Buffer.from(v.signature, "hex");
  assert.equal(Keychain.verifyDetached(v.publicKey, preimage, sig), false, "CONTROL");
  await withMutant({ keychain: ["keychain.strict-key"] }, ({ Keychain: K }) => {
    assert.equal(K.verifyDetached(v.publicKey, preimage, sig), true, "MUTANT: OpenSSL alone accepts 1s");
  });
});

test("keychain.strict-key — every torsion key: CONTROL refuses every forged signature, MUTANT accepts some", async () => {
  const pts = torsionPoints();
  const trial = (K) => {
    const accepted = new Set();
    for (const A of pts) {
      for (const R of pts) {
        const sig = Buffer.from(R + "00".repeat(32), "hex");
        for (const m of MESSAGES) {
          let ok = false;
          try { ok = K.verifyDetached(A, m, sig); } catch (_e) { ok = false; }
          if (ok) accepted.add(A);
        }
      }
    }
    return accepted;
  };
  assert.equal(trial(Keychain).size, 0, "CONTROL: no torsion key verifies anything");
  await withMutant({ keychain: ["keychain.strict-key"] }, ({ Keychain: K }) => {
    const n = trial(K).size;
    console.log(`  MUTANT: ${n} of 8 torsion keys verify a forged signature under OpenSSL alone`);
    assert.ok(n >= 1, "MUTANT: OpenSSL alone accepts at least one torsion key");
  });
});

// ─────────────────────────────────────────────── open() / openDelegated() ──

test("an honest envelope still opens and decrypts", () => {
  const to = honestKeychain();
  const env = seal(honestKeychain(), { recipient: to._identity.uuaid, recipientPublicKey: to._identity.publicKeyHex, payload: { text: "hi" } });
  assert.deepEqual(open(env), { ok: true });
  assert.equal(decrypt(to, env).text, "hi");
});

test("envelope.open-strict-key + keychain.strict-key — the forged envelope: CONTROL refused at both layers, MUTANT opens", async () => {
  const to = honestKeychain();
  const env = forgedEnvelope(to);
  assert.deepEqual(open(env), { ok: false, reason: "weak-publicKey" }, "CONTROL");
  await withMutant({ keychain: ["keychain.strict-key"] }, ({ open: o }) => {
    assert.deepEqual(o(env), { ok: false, reason: "weak-publicKey" }, "open() alone still refuses it");
  });
  await withMutant({ envelope: ["envelope.open-strict-key"] }, ({ open: o }) => {
    assert.deepEqual(o(env), { ok: false, reason: "bad-signature" }, "verifyDetached alone still refuses it");
  });
  await withMutant({ keychain: ["keychain.strict-key"], envelope: ["envelope.open-strict-key"] }, ({ open: o }) => {
    assert.deepEqual(o(env), { ok: true }, "MUTANT: both checks gone, the forgery opens");
    assert.equal(decrypt(to, env).text, "forged", "MUTANT: and the recipient reads it as from the identity-point uuaid");
  });
});

test("envelope.open-delegated-strict-key — a delegated envelope with a small-order signer: CONTROL refused first, MUTANT gets past it", async () => {
  const env = { ...forgedEnvelope(honestKeychain()), delegation: {} };
  assert.deepEqual(open(env), { ok: false, reason: "weak-publicKey" }, "CONTROL");
  await withMutant({ envelope: ["envelope.open-delegated-strict-key"] }, ({ open: o }) => {
    const r = o(env);
    assert.equal(r.ok, false);
    assert.notEqual(r.reason, "weak-publicKey", `MUTANT: the gate is gone (now ${r.reason})`);
  });
});
