// D-12: one poison item from a carrier must not stop poll(). Each case below wedged poll() before the fix
// (an audit write keyed by the peer's envelope id, or a throw from open(), ran before the cursor moved).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AgentCommons, CommonsStore, Keychain, createProfile } from "../src/index.mjs";
import { seal, open, jcs } from "../src/pillar.mjs";
import { encode, digest } from "../src/profiles.mjs";

function makeKey() {
  const k = new Keychain("test-key");
  k._identity = Keychain.generate();
  return k;
}

// Sender atlas is admitted; stranger is a valid signer that the policy does not admit.
function makeEnv(byCarrier) {
  const atlasKey = makeKey(), lyraKey = makeKey(), strangerKey = makeKey();
  const policy = {
    mode: "local",
    offline: true,
    channelsEnabled: false,
    agents: {
      [atlasKey._identity.uuaid]: { kind: "agent", publicKey: atlasKey._identity.publicKeyHex, capabilities: ["commons:message"] },
      [lyraKey._identity.uuaid]: { kind: "agent", publicKey: lyraKey._identity.publicKeyHex, capabilities: ["commons:message"] },
    },
  };
  const profile = createProfile({ namespace: "local/test", name: "Test", scope: "local", fixtures: ["f1", "f2"] });
  const fetched = {};
  const items = typeof byCarrier === "function" ? byCarrier({ atlasKey, lyraKey, strangerKey, profile }) : byCarrier;
  const transport = {
    sources: () => Object.keys(items),
    fetchInbox: async (carrier, { since }) => {
      fetched[carrier] = (fetched[carrier] ?? 0) + 1;
      return { envelopes: items[carrier].filter(i => i.seq > since) };
    },
    deliver: async () => ({}),
  };
  const store = new CommonsStore(":memory:");
  const runtime = new AgentCommons({ keychain: lyraKey, store, policy, transport });
  runtime.addProfile(profile);
  return { atlasKey, lyraKey, strangerKey, profile, store, runtime, fetched };
}

function sealMessage(senderKey, recipientKey, profile, { body = "hello", envelopeId, profileId = profile.id } = {}) {
  const payload = {
    v: "agent-commons/1",
    id: randomUUID(),
    profileId,
    thread: "commons",
    kind: "message",
    wire: encode(body, profile.lexicon),
    bodyHash: digest(body),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  return seal(senderKey, {
    recipient: recipientKey._identity.uuaid,
    recipientPublicKey: recipientKey._identity.publicKeyHex,
    kind: "agent-commons/1",
    payload,
    ...(envelopeId === undefined ? {} : { id: envelopeId }),
  });
}

// seal() only takes a string id, but any key holder can sign an envelope by hand. This rebuilds the transport
// signature after a patch, the way seal() computes it, so open() still accepts the envelope.
// A patch value of undefined removes that field (an absent-id envelope).
function resign(senderKey, envelope, patch) {
  const { transportSignature, ...rest } = envelope;
  const changed = { ...rest, ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete changed[k];
  const signature = senderKey.sign(Buffer.from(jcs(changed), "utf-8")).toString("hex");
  const signed = { ...changed, transportSignature: { ...transportSignature, signature } };
  assert.equal(open(signed).ok, true);
  return signed;
}

const transientReceive = runtime => {
  runtime.receive = async () => { const err = new Error("trust backend offline"); err.transient = true; err.code = "trust-unavailable"; throw err; };
};

// A trust outage that can be switched off, so one test can run several outage windows.
function switchableTrust(runtime) {
  const receive = runtime.receive.bind(runtime);
  const state = { down: true };
  runtime.receive = async envelope => {
    if (state.down) { const err = new Error("trust backend offline"); err.transient = true; err.code = "trust-unavailable"; throw err; }
    return receive(envelope);
  };
  return state;
}

const auditRows = store => store.audit().map(r => JSON.parse(r.body));
const quarantined = store => auditRows(store).filter(e => e.kind === "quarantined-inbound");
const deferredRows = store => auditRows(store).filter(e => e.kind === "inbound-deferred-trust-unavailable");
const clearBackoff = env => env.store.set("carrierHealth", {}); // the backoff window has passed

// Three polls: the first handles everything, the next two must be empty (nothing re-offered, nothing thrown).
async function pollThrice(runtime) {
  const first = await runtime.poll();
  const second = await runtime.poll();
  const third = await runtime.poll();
  return { first, second, third };
}

const POISON = {
  "no id (empty object)": {},
  "fractional id": { id: 1.5, version: 98 },
  "object id with a constructor key": { id: { constructor: 1 }, version: 98 },
  "array id": { id: ["x"], version: 98 },
};

for (const [label, envelope] of Object.entries(POISON)) {
  test(`D-12 non-string id is quarantined with id null and the cursor moves: ${label}`, async () => {
    const env = makeEnv({ c1: [{ seq: 1, envelope }] });
    const { first, second, third } = await pollThrice(env.runtime);
    assert.equal(first.length, 1);
    assert.equal(first[0].rejected, true);
    assert.equal(first[0].id, null);
    assert.match(first[0].reason, /^Invalid Pillar envelope: /);
    assert.deepEqual([second.length, third.length], [0, 0]);
    assert.equal(env.store.get("cursors", {}).c1, 1);
    const rows = quarantined(env.store);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, null);
    assert.equal(env.store.verify(), true);
  });
}

test("D-12 CONTROL: a string id is kept inside the quarantine event", async () => {
  const env = makeEnv({ c1: [{ seq: 1, envelope: { id: "E1", version: 98 } }] });
  const { first, second } = await pollThrice(env.runtime);
  assert.equal(first[0].id, "E1");
  assert.equal(second.length, 0);
  assert.deepEqual(quarantined(env.store).map(e => [e.id, e.reason]), [["E1", "Invalid Pillar envelope: bad-version 98"]]);
});

test("D-12 same envelope id with two different reasons is quarantined twice, not wedged", async () => {
  const env = makeEnv({ c1: [{ seq: 1, envelope: { id: "E1", version: 98 } }, { seq: 2, envelope: { id: "E1", version: 99 } }] });
  const { first, second, third } = await pollThrice(env.runtime);
  assert.equal(first.length, 2);
  assert.deepEqual([second.length, third.length], [0, 0]);
  assert.equal(env.store.get("cursors", {}).c1, 2);
  assert.deepEqual(quarantined(env.store).map(e => e.reason).sort(), ["Invalid Pillar envelope: bad-version 98", "Invalid Pillar envelope: bad-version 99"]);
  assert.equal(env.store.verify(), true);
});

test("D-12 an open() that throws (version {toString:null}) is quarantined and later carriers are read", async () => {
  const env = makeEnv({ c1: [{ seq: 1, envelope: { id: "T1", version: { toString: null } } }], c2: [{ seq: 1, envelope: { id: "E2", version: 98 } }] });
  const { first, second, third } = await pollThrice(env.runtime);
  assert.equal(first.length, 2);
  assert.equal(first[0].reason, "Invalid Pillar envelope: validation-threw");
  assert.deepEqual([second.length, third.length], [0, 0]);
  assert.deepEqual(env.store.get("cursors", {}), { c1: 1, c2: 1 });
  assert.deepEqual(env.fetched, { c1: 3, c2: 3 });
  assert.deepEqual(quarantined(env.store).map(e => [e.id, e.reason]).sort(), [["E2", "Invalid Pillar envelope: bad-version 98"], ["T1", "Invalid Pillar envelope: validation-threw"]]);
  assert.equal(env.store.verify(), true);
});

test("D-12 CONTROL: a scalar bad version on c1 reads c2 too (matching multi-carrier control)", async () => {
  const env = makeEnv({ c1: [{ seq: 1, envelope: { id: "T1", version: 98 } }], c2: [{ seq: 1, envelope: { id: "E2", version: 98 } }] });
  const { first, second } = await pollThrice(env.runtime);
  assert.equal(first.length, 2);
  assert.equal(second.length, 0);
  assert.deepEqual(env.store.get("cursors", {}), { c1: 1, c2: 1 });
});

test("D-12 a valid signed message after poison is delivered once, on the same carrier and on a later carrier", async () => {
  const env = makeEnv(({ atlasKey, lyraKey, profile }) => ({
    c1: [{ seq: 1, envelope: {} }, { seq: 2, envelope: sealMessage(atlasKey, lyraKey, profile, { body: "after-poison-c1" }) }],
    c2: [{ seq: 1, envelope: { id: 1.5, version: 98 } }, { seq: 2, envelope: sealMessage(atlasKey, lyraKey, profile, { body: "after-poison-c2" }) }],
  }));
  const { first, second, third } = await pollThrice(env.runtime);
  const accepted = first.filter(r => r.accepted === true);
  assert.deepEqual(accepted.map(r => r.body).sort(), ["after-poison-c1", "after-poison-c2"]);
  assert.equal(first.filter(r => r.rejected === true).length, 2);
  assert.deepEqual([second.length, third.length], [0, 0]);
  assert.deepEqual(env.store.get("cursors", {}), { c1: 2, c2: 2 });
  assert.equal(auditRows(env.store).filter(e => e.kind === "message-received").length, 2);
  assert.equal(quarantined(env.store).length, 2);
  assert.equal(env.store.verify(), true);
});

test("D-12 receive() rejections with one envelope id and two different reasons are both quarantined", async () => {
  // Both envelopes are validly signed and carry the same envelope id. One sender is not admitted;
  // the other names a profile this runtime does not have. Different reasons, same id.
  const env = makeEnv(({ atlasKey, lyraKey, strangerKey, profile }) => ({
    c1: [
      { seq: 1, envelope: sealMessage(strangerKey, lyraKey, profile, { envelopeId: "R1" }) },
      { seq: 2, envelope: sealMessage(atlasKey, lyraKey, profile, { envelopeId: "R1", profileId: "no-such-profile" }) },
    ],
  }));
  const { first, second, third } = await pollThrice(env.runtime);
  assert.equal(first.length, 2);
  assert.ok(first.every(r => r.rejected === true && r.id === "R1"));
  // Both come from the receive() catch, not from the invalid-envelope branch.
  const expected = ["Subject/key/capability has not been admitted by this deployment", "Unknown local profile digest"];
  assert.deepEqual(first.map(r => r.reason).sort(), expected);
  assert.ok(first.every(r => !r.reason.startsWith("Invalid Pillar envelope:")));
  assert.deepEqual([second.length, third.length], [0, 0]);
  assert.equal(env.store.get("cursors", {}).c1, 2);
  assert.deepEqual(quarantined(env.store).map(e => e.reason).sort(), expected);
  assert.equal(env.store.verify(), true);
});

for (const [label, envelopeId] of Object.entries({ "an integer id": 5, "an object id with a constructor key": { constructor: 1 } })) {
  test(`D-12 a validly signed envelope with ${label} that receive() rejects is quarantined with id null`, async () => {
    const env = makeEnv(({ atlasKey, lyraKey, profile }) => ({ c1: [{ seq: 1, envelope: resign(atlasKey, sealMessage(atlasKey, lyraKey, profile), { id: envelopeId }) }] }));
    const { first, second } = await pollThrice(env.runtime);
    assert.equal(first.length, 1);
    assert.equal(first[0].rejected, true);
    assert.equal(first[0].id, null);
    assert.ok(!first[0].reason.startsWith("Invalid Pillar envelope:"));
    assert.equal(second.length, 0);
    assert.equal(env.store.get("cursors", {}).c1, 1);
    assert.deepEqual(quarantined(env.store).map(e => e.id), [null]);
    assert.equal(env.store.verify(), true);
  });
}

for (const [label, thrown] of Object.entries({ "a number": 5, "an object whose message is not a string": { message: { nested: 1 } }, "undefined": undefined })) {
  test(`D-12 receive() throwing ${label} is quarantined with a constant reason`, async () => {
    const env = makeEnv(({ atlasKey, lyraKey, profile }) => ({ c1: [{ seq: 1, envelope: sealMessage(atlasKey, lyraKey, profile) }] }));
    env.runtime.receive = async () => { throw thrown; };
    const { first, second } = await pollThrice(env.runtime);
    assert.equal(first[0].rejected, true);
    assert.equal(first[0].reason, "receive-failed");
    assert.equal(second.length, 0);
    assert.deepEqual(quarantined(env.store).map(e => e.reason), ["receive-failed"]);
  });
}

test("D-12 KEEP: a genuine audit-write failure still fails the poll and leaves the cursor where it was", async () => {
  const env = makeEnv({ c1: [{ seq: 1, envelope: { id: "E1", version: 98 } }] });
  const append = env.store.append.bind(env.store);
  env.store.append = (id, event) => { if (event?.kind === "quarantined-inbound") throw new Error("disk full"); return append(id, event); };
  await assert.rejects(env.runtime.poll(), /disk full/);
  assert.equal(env.store.get("cursors", {}).c1, undefined);
  env.store.append = append;
  const retried = await env.runtime.poll();
  assert.equal(retried.length, 1);
  assert.equal(env.store.get("cursors", {}).c1, 1);
});

test("D-12 KEEP: an audit-write failure at the receive() rejection site also fails the poll and leaves the cursor", async () => {
  const env = makeEnv(({ lyraKey, strangerKey, profile }) => ({ c1: [{ seq: 1, envelope: sealMessage(strangerKey, lyraKey, profile) }] }));
  const append = env.store.append.bind(env.store);
  env.store.append = (id, event) => { if (event?.kind === "quarantined-inbound") throw new Error("disk full"); return append(id, event); };
  await assert.rejects(env.runtime.poll(), /disk full/);
  assert.equal(env.store.get("cursors", {}).c1, undefined);
  env.store.append = append;
  const retried = await env.runtime.poll();
  assert.equal(retried[0].reason, "Subject/key/capability has not been admitted by this deployment");
  assert.equal(env.store.get("cursors", {}).c1, 1);
});

test("D-12 a validly signed non-string id during a trust outage is deferred with id null, then quarantined after it", async () => {
  const env = makeEnv(({ atlasKey, lyraKey, profile }) => ({ c1: [{ seq: 1, envelope: resign(atlasKey, sealMessage(atlasKey, lyraKey, profile), { id: 5 }) }] }));
  const receive = env.runtime.receive.bind(env.runtime);
  let calls = 0;
  env.runtime.receive = async envelope => {
    if (calls++ === 0) { const err = new Error("trust backend offline"); err.transient = true; err.code = "trust-unavailable"; throw err; }
    return receive(envelope);
  };
  const deferred = await env.runtime.poll();
  assert.equal(deferred[0].deferred, true);
  assert.equal(deferred[0].id, null);
  assert.equal(env.store.get("cursors", {}).c1 ?? 0, 0);
  assert.deepEqual(auditRows(env.store).filter(e => e.kind === "inbound-deferred-trust-unavailable").map(e => e.id), [null]);
  assert.equal(quarantined(env.store).length, 0);
  env.store.set("carrierHealth", {}); // the backoff window has passed
  const after = await env.runtime.poll();
  assert.equal(after[0].rejected, true);
  assert.equal(after[0].id, null);
  assert.equal(env.store.get("cursors", {}).c1, 1);
  assert.equal((await env.runtime.poll()).length, 0);
  assert.equal(env.store.verify(), true);
});

test("D-12 during a trust outage, ids null and \"null\" on two carriers get two deferred rows, not a key clash", async () => {
  const env = makeEnv(({ atlasKey, lyraKey, profile }) => ({
    c1: [{ seq: 1, envelope: resign(atlasKey, sealMessage(atlasKey, lyraKey, profile), { id: 5 }) }],
    c2: [{ seq: 1, envelope: sealMessage(atlasKey, lyraKey, profile, { envelopeId: "null" }) }],
  }));
  transientReceive(env.runtime);
  const first = await env.runtime.poll();
  assert.deepEqual(first.map(r => [r.deferred, r.id]), [[true, null], [true, "null"]]);
  assert.deepEqual(env.store.get("cursors", {}), {});
  assert.deepEqual(env.fetched, { c1: 1, c2: 1 });
  env.store.set("carrierHealth", {});
  const retry = await env.runtime.poll(); // the same two items are deferred again and rewrite the same rows
  assert.equal(retry.length, 2);
  assert.deepEqual(auditRows(env.store).filter(e => e.kind === "inbound-deferred-trust-unavailable").map(e => JSON.stringify(e.id)).sort(), ['"null"', "null"]);
  assert.equal(env.store.verify(), true);
});

test("D-12 during a trust outage, two different lone-surrogate ids get two deferred rows", async () => {
  const env = makeEnv(({ atlasKey, lyraKey, profile }) => ({
    c1: [{ seq: 1, envelope: sealMessage(atlasKey, lyraKey, profile, { envelopeId: "\uD800" }) }],
    c2: [{ seq: 1, envelope: sealMessage(atlasKey, lyraKey, profile, { envelopeId: "\uDC00" }) }],
  }));
  transientReceive(env.runtime);
  const first = await env.runtime.poll();
  assert.deepEqual(first.map(r => r.deferred), [true, true]);
  assert.equal(auditRows(env.store).filter(e => e.kind === "inbound-deferred-trust-unavailable").length, 2);
  assert.equal(env.store.verify(), true);
});

test("D-12 repeated deferral of the same envelope leaves exactly one deferred audit row", async () => {
  const env = makeEnv(({ atlasKey, lyraKey, profile }) => ({ c1: [{ seq: 1, envelope: sealMessage(atlasKey, lyraKey, profile, { body: "deferred-thrice" }) }] }));
  const trust = switchableTrust(env.runtime);
  for (let n = 0; n < 3; n++) {
    const r = await env.runtime.poll();
    assert.equal(r[0].deferred, true);
    clearBackoff(env);
  }
  assert.equal(deferredRows(env.store).length, 1);
  assert.equal(env.store.get("cursors", {}).c1 ?? 0, 0);
  trust.down = false;
  const delivered = await env.runtime.poll();
  assert.equal(delivered.filter(r => r.accepted === true).length, 1);
  assert.equal(deferredRows(env.store).length, 1);
  assert.equal(env.store.verify(), true);
});

test("D-12 a normalized-null id and the string \"null\" do not collide across two trust-outage windows", async () => {
  // A (absent id, normalized to null) defers; trust recovers and A clears; then trust fails again and B (the
  // string "null") defers. Under the old key both deferrals wrote `deferred-null` with different events.
  const env = makeEnv(({ atlasKey, lyraKey, profile }) => ({
    c1: [
      { seq: 1, envelope: resign(atlasKey, sealMessage(atlasKey, lyraKey, profile), { id: undefined }) },
      { seq: 2, envelope: sealMessage(atlasKey, lyraKey, profile, { envelopeId: "null", body: "string-null" }) },
    ],
  }));
  const receive = env.runtime.receive.bind(env.runtime);
  const schedule = ["down", "up", "down", "up"]; // one entry per receive() call
  env.runtime.receive = async envelope => {
    if (schedule.shift() === "down") { const err = new Error("trust backend offline"); err.transient = true; err.code = "trust-unavailable"; throw err; }
    return receive(envelope);
  };
  const w1 = await env.runtime.poll();
  assert.deepEqual(w1.map(r => [r.deferred, r.id]), [[true, null]]);
  assert.equal(env.store.get("cursors", {}).c1 ?? 0, 0);
  clearBackoff(env);
  const w2 = await env.runtime.poll(); // A clears (rejected), then B defers in the second outage
  assert.deepEqual(w2.map(r => [r.rejected ?? false, r.deferred ?? false, r.id]), [[true, false, null], [false, true, "null"]]);
  assert.equal(env.store.get("cursors", {}).c1, 1);
  clearBackoff(env);
  const w3 = await env.runtime.poll();
  assert.deepEqual(w3.filter(r => r.accepted === true).map(r => r.body), ["string-null"]);
  assert.equal(env.store.get("cursors", {}).c1, 2);
  assert.equal((await env.runtime.poll()).length, 0);
  assert.deepEqual(deferredRows(env.store).map(e => JSON.stringify(e.id)).sort(), ['"null"', "null"]);
  assert.equal(env.store.verify(), true);
});

test("D-12 deferred rows written by the old code stay verifiable and do not block new deferrals", async () => {
  const env = makeEnv(({ atlasKey, lyraKey, profile }) => ({
    c1: [{ seq: 1, envelope: resign(atlasKey, sealMessage(atlasKey, lyraKey, profile), { id: 5 }) }],
    c2: [{ seq: 1, envelope: sealMessage(atlasKey, lyraKey, profile, { envelopeId: "null" }) }],
    c3: [{ seq: 1, envelope: sealMessage(atlasKey, lyraKey, profile, { envelopeId: "E1" }) }],
  }));
  // Rows exactly as a7c9862 wrote them: key `deferred-${id}`, event {kind, id}. Each one collides with the
  // un-namespaced `deferred-${JSON.stringify(id)}` key for a new id.
  const legacy = [["deferred-null", "null"], ['deferred-"E1"', '"E1"'], ["deferred-E1", "E1"]];
  for (const [key, id] of legacy) env.store.append(key, { kind: "inbound-deferred-trust-unavailable", id });
  transientReceive(env.runtime);
  const first = await env.runtime.poll();
  assert.deepEqual(first.map(r => [r.deferred, r.id]), [[true, null], [true, "null"], [true, "E1"]]);
  assert.equal(env.store.verify(), true);
  assert.equal(deferredRows(env.store).length, legacy.length + 3);
  clearBackoff(env);
  assert.equal((await env.runtime.poll()).length, 3); // retried, rows rewritten in place, nothing thrown
  assert.equal(deferredRows(env.store).length, legacy.length + 3);
});

test("D-12 KEEP: a transient trust failure defers without moving the cursor, then delivers once", async () => {
  const env = makeEnv(({ atlasKey, lyraKey, profile }) => ({ c1: [{ seq: 1, envelope: sealMessage(atlasKey, lyraKey, profile, { body: "deferred-once" }) }] }));
  const receive = env.runtime.receive.bind(env.runtime);
  let calls = 0;
  env.runtime.receive = async envelope => {
    if (calls++ === 0) { const err = new Error("trust backend offline"); err.transient = true; err.code = "trust-unavailable"; throw err; }
    return receive(envelope);
  };
  const deferred = await env.runtime.poll();
  assert.equal(deferred[0].deferred, true);
  assert.equal(env.store.get("cursors", {}).c1 ?? 0, 0);
  assert.equal(auditRows(env.store).filter(e => e.kind === "inbound-deferred-trust-unavailable").length, 1);
  assert.equal(quarantined(env.store).length, 0);
  env.store.set("carrierHealth", {}); // the backoff window has passed
  const delivered = await env.runtime.poll();
  assert.equal(delivered.filter(r => r.accepted === true).length, 1);
  assert.equal(env.store.get("cursors", {}).c1, 1);
  assert.equal((await env.runtime.poll()).length, 0);
});
