import test from "node:test";
import assert from "node:assert/strict";
import { AgentCommons, Keychain, seal, BASE_PROTOCOL } from "../src/index.mjs";

// Tolerant ingress: a plain-format Pillar message from an admitted, key-pinned sender is a first-class message.
const CAPS = ["commons:message", "commons:relay", "commons:evolve", "commons:contribute", "commons:recover"];
function key(ns = "foundation") { const k = new Keychain("unused"); k._identity = Keychain.generate({ uuaidNamespace: ns }); return k; }
function pair({ admitSender = true } = {}) {
  const a = key("agentnet"), b = key();
  const agents = { [b._identity.uuaid]: { kind: "agent", publicKey: b._identity.publicKeyHex, capabilities: CAPS } };
  if (admitSender) agents[a._identity.uuaid] = { kind: "agent", publicKey: a._identity.publicKeyHex, capabilities: CAPS };
  const receiver = new AgentCommons({ keychain: b, policy: { mode: "local", agents } });
  return { a, b, receiver };
}
const plain = (from, to, payload, kind = "message") => seal(from, { recipient: to._identity.uuaid, recipientPublicKey: to._identity.publicKeyHex, kind, payload });

test("wild ingress: a plain Pillar DM from an admitted, key-pinned sender is accepted as a first-class message", async () => {
  const { a, b, receiver } = pair();
  const env = plain(a, b, { text: "door 10020911: hello from the wild" });
  const r = await receiver.receive(env);
  assert.equal(r.accepted, true);
  assert.equal(r.format, "pillar-plain");
  assert.equal(r.sender, a._identity.uuaid);
  assert.equal(r.text, "door 10020911: hello from the wild");
  assert.deepEqual(r.payload, { text: "door 10020911: hello from the wild" });
  assert.equal(r.transportKey, a._identity.publicKeyHex);
  // Audit has metadata only, never the body.
  const events = receiver.store.audit().filter((row) => JSON.parse(row.body).kind === "plain-message-received");
  assert.equal(events.length, 1);
  assert.equal(JSON.stringify(events).includes("hello from the wild"), false);
  assert.equal(receiver.store.verify(), true);
});

test("wild ingress: any envelope kind and any JSON object payload are heard (not just {text})", async () => {
  const { a, b, receiver } = pair();
  const r = await receiver.receive(plain(a, b, { note: "knock", seq: 10020911, nested: { ok: true } }, "work-order"));
  assert.equal(r.accepted, true);
  assert.equal(r.kind, "work-order");
  assert.equal(r.text, undefined);
  assert.deepEqual(r.payload.nested, { ok: true });
});

test("wild ingress: the same envelope twice is a duplicate, not a second message", async () => {
  const { a, b, receiver } = pair();
  const env = plain(a, b, { text: "once" });
  assert.equal((await receiver.receive(env)).accepted, true);
  assert.deepEqual(await receiver.receive(env), { duplicate: true });
});

test("wild ingress: a stranger (not admitted) is still refused before decrypt", async () => {
  const { a, b, receiver } = pair({ admitSender: false });
  await assert.rejects(receiver.receive(plain(a, b, { text: "hi" })), (e) => e.code === "NOT_ADMITTED");
});

test("wild ingress: an admitted UUAID whose pinned key differs from the signing key is refused", async () => {
  const { a, b } = pair();
  const impostor = key("agentnet");
  // Admit a's UUAID but pin a DIFFERENT key: the transport key no longer matches the pin.
  const agents = { [b._identity.uuaid]: { kind: "agent", publicKey: b._identity.publicKeyHex, capabilities: CAPS },
    [a._identity.uuaid]: { kind: "agent", publicKey: impostor._identity.publicKeyHex, capabilities: CAPS } };
  const receiver = new AgentCommons({ keychain: b, policy: { mode: "local", agents } });
  await assert.rejects(receiver.receive(plain(a, b, { text: "hi" })));
});

test("wild ingress: a payload that CLAIMS agent-commons/1 keeps the strict commons checks", async () => {
  const { a, b, receiver } = pair();
  await assert.rejects(receiver.receive(plain(a, b, { v: BASE_PROTOCOL, text: "not a real commons payload" })), /Invalid or expired Agent Commons payload/);
});

test("wild ingress: non-object and oversized plain payloads are refused", async () => {
  const { a, b, receiver } = pair();
  await assert.rejects(receiver.receive(plain(a, b, ["array"])), /JSON object/);
  await assert.rejects(receiver.receive(plain(a, b, { text: "x".repeat(70000) })), /exceeds 64000 bytes/);
});

test("wild ingress: a plain group payload reports its space id for routing", async () => {
  const { a, b, receiver } = pair();
  const r = await receiver.receive(plain(a, b, { text: "in the room", _group: { v: 2, id: "grp-" + "a".repeat(32) } }));
  assert.equal(r.group, "grp-" + "a".repeat(32));
});
