// L12: Consumer Poles and C6 Verification for Strict Ed25519 Keys
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  AgentCommons,
  CommonsStore,
  CommonsCarrier,
  RegistryTrust,
  Keychain,
  seal,
  open,
  MemoryLoopbackTransport,
} from "../src/index.mjs";
import { ContinuityMemory, MemoryContinuityStore, ContinuityError } from "../src/continuity.mjs";
import { verifyGovernanceDocument, GovernanceError } from "../src/governance.mjs";
import { verifyDocument, digest } from "../src/profiles.mjs";

const IDENTITY = "01" + "00".repeat(31);
const FORGED_SIG = "01" + "00".repeat(31) + "00".repeat(32);

function makeKey() {
  const k = new Keychain("test-key");
  k._identity = Keychain.generate();
  return k;
}

// ───────────────────────────────────────────────────────── 1. carrier.mjs:67 ──

test("carrier.mjs:67 — inbox-read signature with a weak key returns 401 bad-inbox-signature", async () => {
  const store = new CommonsStore();
  const carrier = new CommonsCarrier({ store, trust: new RegistryTrust({ policy: { mode: "local" } }) });
  const addr = await carrier.listen();
  const url = `http://127.0.0.1:${addr.port}`;

  try {
    const res = await fetch(`${url}/v1/inbox/test-user`, {
      headers: {
        "x-pillar-pubkey": IDENTITY,
        "x-pillar-ts": Date.now().toString(),
        "x-pillar-sig": FORGED_SIG,
      },
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.deepEqual(body, { error: "bad-inbox-signature" });
  } finally {
    await carrier.close();
    store.close();
  }
});

// ────────────────────────────────────────────── 2. carrier.mjs (C6 pole) ──

test("carrier.mjs (C6) — malformed pubkey header returns 401 bad-inbox-signature without throw", async () => {
  const store = new CommonsStore();
  const carrier = new CommonsCarrier({ store, trust: new RegistryTrust({ policy: { mode: "local" } }) });
  const addr = await carrier.listen();
  const url = `http://127.0.0.1:${addr.port}`;

  try {
    const res = await fetch(`${url}/v1/inbox/test-user`, {
      headers: {
        "x-pillar-pubkey": "not-a-valid-hex-pubkey",
        "x-pillar-ts": Date.now().toString(),
        "x-pillar-sig": "00".repeat(64),
      },
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.deepEqual(body, { error: "bad-inbox-signature" });
  } finally {
    await carrier.close();
    store.close();
  }
});

// ────────────────────────────────────────────────────── 3. continuity.mjs:233 ──

test("continuity.mjs:233 — weak owner key is refused with ContinuityError INTEGRITY", () => {
  const weakUuaid = `uuaid:foundation:agent:${Keychain.localIdFromKey(Buffer.from(IDENTITY, "hex"))}`;
  const fakeKeychain = {
    _identity: { uuaid: weakUuaid, publicKeyHex: IDENTITY },
    sign: () => Buffer.from(FORGED_SIG, "hex"),
  };

  const store = new MemoryContinuityStore();
  const entry = {
    v: "agent-commons/continuity/1",
    seq: 0,
    id: randomUUID(),
    at: new Date().toISOString(),
    kind: "note",
    content: { test: "data" },
    provenance: { source: "self", actor: weakUuaid },
    pin: false,
    previous: "genesis",
    hash: "",
    signature: FORGED_SIG,
  };
  const { hash: _h, signature: _s, ...entryBody } = entry;
  entry.hash = digest(entryBody);

  const state = {
    v: "agent-commons/continuity/1",
    uuaid: weakUuaid,
    publicKey: IDENTITY,
    nextSeq: 1,
    anchor: { previous: "genesis", pruned: 0, through: null },
    entries: [entry],
    sync: { lastPush: null, lastPull: null },
  };
  store.set(ContinuityMemory.storeKey(weakUuaid), state);

  assert.throws(
    () => new ContinuityMemory({ keychain: fakeKeychain, store }),
    (err) => err instanceof ContinuityError && err.code === "INTEGRITY" && err.message === "Continuity entry signature invalid"
  );
});

// ────────────────────────────────────────────────────── 4. governance.mjs:25 ──

test("governance.mjs:25 (C5) — weak key reaching verifyDetached is refused with INVALID_SIGNATURE", () => {
  const weakUuaid = `uuaid:local:agent:${Keychain.localIdFromKey(Buffer.from(IDENTITY, "hex"))}`;
  const doc = {
    v: "agent-commons/1",
    id: randomUUID(),
    kind: "governance-proposal",
    issuer: weakUuaid,
    publicKey: IDENTITY,
    createdAt: new Date().toISOString(),
    payload: { proposal: "test-small-order-refusal" },
    signature: FORGED_SIG,
  };

  assert.throws(
    () => verifyGovernanceDocument(doc),
    (err) => err instanceof GovernanceError && err.code === "INVALID_SIGNATURE"
  );
});

// ──────────────────────────────────────────────────────── 5. profiles.mjs:85 ──

test("profiles.mjs:85 (C5) — weak key reaching verifyDetached is refused with Invalid document signature", () => {
  const weakUuaid = `uuaid:local:agent:${Keychain.localIdFromKey(Buffer.from(IDENTITY, "hex"))}`;
  const doc = {
    v: "agent-commons/1",
    id: randomUUID(),
    kind: "profile-proposal",
    issuer: weakUuaid,
    publicKey: IDENTITY,
    createdAt: new Date().toISOString(),
    payload: { proposal: "test-profile-refusal" },
    signature: FORGED_SIG,
  };

  assert.throws(
    () => verifyDocument(doc),
    (err) => err instanceof Error && err.message === "Invalid document signature"
  );
});

// ─────────────────────────────────────────── 6. runtime.mjs:162 (CONTROL) ──

test("runtime.mjs:162 (CONTROL) — honest outbox metadata signature verification succeeds on flush", async () => {
  const senderKey = makeKey();
  const recipientKey = makeKey();
  const transport = new MemoryLoopbackTransport();

  const runtime = new AgentCommons({
    keychain: senderKey,
    policy: {
      mode: "local",
      agents: {
        [senderKey._identity.uuaid]: {
          kind: "agent",
          publicKey: senderKey._identity.publicKeyHex,
          capabilities: ["commons:message"],
        },
        [recipientKey._identity.uuaid]: {
          kind: "agent",
          publicKey: recipientKey._identity.publicKeyHex,
          capabilities: ["commons:message"],
        },
      },
    },
    transport,
  });

  const { createProfile } = await import("../src/profiles.mjs");
  const profile = createProfile({
    namespace: "test/fleet",
    name: "Fixture profile",
    scope: "local",
    fixtures: ["Require semantic equivalence and semantic equivalence.", "Preserve semantic equivalence before accepting a profile."],
  });
  runtime.addProfile(profile);

  const sent = await runtime.send({
    recipient: recipientKey._identity.uuaid,
    profileId: profile.id,
    body: "test-honest-runtime-flush",
  });

  assert.equal(sent.result[0].state, "carrier-accepted");
  assert.equal(sent.result[0].receipt.accepted, true);
  runtime.store.close();
});

// ───────────────────────────────────────────────────────────── 7. open() ──

test("open() — forged envelope with small-order public key is refused with weak-publicKey", () => {
  const recipientKey = makeKey();
  const honest = seal(makeKey(), {
    recipient: recipientKey._identity.uuaid,
    recipientPublicKey: recipientKey._identity.publicKeyHex,
    payload: { text: "forged" },
  });
  const sender = `uuaid:foundation:agent:${Keychain.localIdFromKey(Buffer.from(IDENTITY, "hex"))}`;
  const { transportSignature: _s, ...body } = honest;
  const forged = {
    ...body,
    sender,
    transportSignature: {
      alg: "ed25519",
      keyId: sender,
      publicKey: IDENTITY,
      signature: FORGED_SIG,
      created: body.createdAt,
    },
  };

  assert.deepEqual(open(forged), { ok: false, reason: "weak-publicKey" });
});
