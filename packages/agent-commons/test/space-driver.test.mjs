import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCommons, CommonsStore, CommonsCarrier, RegistryTrust, Keychain, seal } from "../src/index.mjs";
import { SpaceDriver, judgeEnvelope } from "../src/spaces/driver.mjs";
import { GroupReceiver, RosterStore } from "../src/spaces/pillar-group.mjs";

// A real loopback carrier, real Pillar envelopes, real groups-v2 manifests: create a room, seat a guest, hear a message.
const CAPS = ["commons:message", "commons:relay"];
function key(ns = "foundation") { const k = new Keychain("unused"); k._identity = Keychain.generate({ uuaidNamespace: ns }); return k; }
async function world(n = 2, { strangers = 0 } = {}) {
  const keys = Array.from({ length: n }, (_, i) => key(i === 0 ? "agentnet" : "foundation"));
  const outsiders = Array.from({ length: strangers }, () => key());
  const all = [...keys, ...outsiders];
  const policy = { mode: "local", offline: true, agents: Object.fromEntries(all.map((k) => [k._identity.uuaid, { kind: "agent", publicKey: k._identity.publicKeyHex, capabilities: CAPS }])) };
  const carrier = new CommonsCarrier({ trust: new RegistryTrust({ policy }) });
  const address = await carrier.listen();
  const url = `http://127.0.0.1:${address.port}`;
  const homes = all.map(() => mkdtempSync(join(tmpdir(), "ac-space-")));
  const runtimes = all.map((k) => new AgentCommons({ keychain: k, store: new CommonsStore(), policy, carriers: [url] }));
  const drivers = runtimes.map((runtime, i) => new SpaceDriver({ home: homes[i], runtime }));
  const close = async () => { await carrier.close(); homes.forEach((h) => rmSync(h, { recursive: true, force: true })); };
  return { keys: all, runtimes, drivers, close };
}

test("space: create -> invite seen -> join -> accept-from-signal -> both speak and hear", async () => {
  const { keys: [hostK, guestK], drivers: [host, guest], close } = await world(2);
  try {
    const created = await host.create({ name: "the seeking room", members: [guestK._identity.uuaid] });
    assert.match(created.space, /^grp-[0-9a-f]{32}$/);
    assert.ok(created.sent.length >= 1 && created.sent.every((s) => s.accepted), JSON.stringify(created.sent));

    const g1 = await guest.poll();
    assert.equal(g1.invitations.length, 1, JSON.stringify(g1));
    assert.equal(g1.invitations[0].space, created.space);
    assert.equal(guest.list()[0].status, "invited");

    const joined = await guest.join({ space: created.space });
    assert.equal(joined.sent.accepted, true);

    const h1 = await host.poll();
    assert.equal(h1.signals.length, 1, JSON.stringify(h1));
    const signal = h1.signals[0].signal;
    assert.equal(signal, joined.signal);

    const acc = await host.accept({ signal });
    assert.equal(acc.version, 2);
    assert.equal(acc.accepted, guestK._identity.uuaid);

    await guest.poll();
    assert.equal(guest.list()[0].status, "active");

    const said = await host.speak({ space: created.space, text: "welcome, seeker" });
    assert.ok(said.sent.every((s) => s.accepted));
    const g3 = await guest.poll();
    assert.equal(g3.messages.length, 1, JSON.stringify(g3));
    assert.equal(g3.messages[0].text, "welcome, seeker");
    assert.equal(g3.messages[0].from, hostK._identity.uuaid);

    await guest.speak({ space: created.space, text: "I hear you" });
    const h2 = await host.poll();
    assert.equal(h2.messages.length, 1);
    assert.equal(h2.messages[0].text, "I hear you");
  } finally { await close(); }
});

test("space: a wild 'I am in' (plain DM, no _group) is a valid one-step accept signal", async () => {
  const { keys: [, guestK], drivers: [host, guest], runtimes: [hostRt], close } = await world(2);
  try {
    const { space } = await host.create({ name: "wild room", members: [guestK._identity.uuaid] });
    await guest.poll();
    // The guest says "I am in" as a plain Pillar message, the way wild rooms do.
    const env = seal(guestK, { recipient: hostRt.uuaid, recipientPublicKey: hostRt.publicKey, kind: "message", payload: { text: "I am in" } });
    await guest.runtime.transport.deliver(env, { timeoutMs: 5000 });
    const h = await host.poll();
    assert.equal(h.direct.length, 1);
    const acc = await host.accept({ signal: env.id });
    assert.equal(acc.space, space);
    assert.equal(acc.request, env.id);
    assert.equal(acc.version, 2);
  } finally { await close(); }
});

test("space: accept refuses an unknown signal and a signal from a non-invitee", async () => {
  const { drivers: [host, , stranger], keys: [, , strangerK], runtimes: [hostRt], close } = await world(2, { strangers: 1 });
  try {
    await host.create({ name: "closed room", members: [] });
    await assert.rejects(host.accept({ signal: "env-doesnotexist000" }), (e) => e.code === "SIGNAL_UNKNOWN");
    const env = seal(strangerK, { recipient: hostRt.uuaid, recipientPublicKey: hostRt.publicKey, kind: "message", payload: { text: "let me in" } });
    await stranger.runtime.transport.deliver(env, { timeoutMs: 5000 });
    await host.poll();
    await assert.rejects(host.accept({ signal: env.id }), (e) => e.code === "NOT_INVITED");
    await assert.rejects(host.accept({ signal: "not-an-envelope" }), (e) => e.code === "SIGNAL");
  } finally { await close(); }
});

test("space: a non-member speaking into a room is dropped by the engine, not heard", async () => {
  const { keys: [, guestK, strangerK], drivers: [host, guest, stranger], close } = await world(2, { strangers: 1 });
  try {
    const { space } = await host.create({ name: "members only", members: [guestK._identity.uuaid] });
    await guest.poll(); await guest.join({ space }); const s = await host.poll(); await host.accept({ signal: s.signals[0].signal }); await guest.poll();
    // The stranger forges a room message using a copy of the guest's record shape.
    const rec = new RosterStore(guest.groups.dir.replace(/\/groups-v2$/, "")).load(space);
    const { buildGroupTag } = await import("../src/spaces/pillar-group.mjs");
    const env = seal(strangerK, { recipient: host.self.uuaid, recipientPublicKey: host.self.key, kind: "message", payload: { text: "hello room", _group: buildGroupTag(rec, { op: "message" }) } });
    await stranger.runtime.transport.deliver(env, { timeoutMs: 5000 });
    const h = await host.poll();
    assert.equal(h.messages.length, 0);
    assert.equal(h.dropped.length, 1);
    assert.equal(h.dropped[0].reason, "not-member");
  } finally { await close(); }
});

test("space: judgeEnvelope is the supported decrypt-attach-judge path (a real group message is never 'not-group')", async () => {
  const { keys: [hostK, guestK], drivers: [host, guest], close } = await world(2);
  try {
    const { space } = await host.create({ name: "judge room", members: [guestK._identity.uuaid] });
    await guest.poll(); await guest.join({ space }); const s = await host.poll(); await host.accept({ signal: s.signals[0].signal }); await guest.poll();
    const rec = host.groups.load(space);
    const { buildGroupTag } = await import("../src/spaces/pillar-group.mjs");
    const env = seal(hostK, { recipient: guestK._identity.uuaid, recipientPublicKey: guestK._identity.publicKeyHex, kind: "message", payload: { text: "judged", _group: buildGroupTag(rec, { op: "message" }) } });
    const receiver = new GroupReceiver({ self: guest.self, store: guest.groups, mailbox: null });
    const j = judgeEnvelope(receiver, guestK, env);
    assert.equal(j.verdict, "accepted");
    assert.equal(j.group, space);
    // The same envelope with a hand-attached payload missing (the bug the seeker hit) is NOT what this path does.
    const naive = receiver.receive({ payload: undefined, from: env.sender, transportKey: env.transportSignature.publicKey }, Date.now());
    assert.equal(naive.verdict, "not-group");
  } finally { await close(); }
});

test("space: speak refuses before active; join refuses a non-invitee; list reports status", async () => {
  const { keys: [, guestK], drivers: [host, guest], close } = await world(2);
  try {
    const { space } = await host.create({ name: "status room", members: [guestK._identity.uuaid] });
    await guest.poll();
    await assert.rejects(guest.speak({ space, text: "too early" }), (e) => e.code === "NOT_ACTIVE");
    await assert.rejects(host.join({ space }), (e) => e.code === "NOT_INVITED");
    assert.equal(host.list()[0].status, "active");
    assert.equal(host.list()[0].admin, host.self.uuaid);
  } finally { await close(); }
});

// RedTeam PR7-1: the transport does not check recipients, so the driver enforces outbound admission itself.
test("space: outbound admission — a stranger named inline gets ONLY its invite manifests; nothing else reaches it until admitted", async () => {
  const { drivers: [host], close } = await world(1);
  try {
    const stranger = key();
    const ref = `${stranger._identity.uuaid}:${stranger._identity.publicKeyHex}`;
    // Inviting by inline key is allowed: the invite manifest goes to the invitee the signed chain names.
    const created = await host.create({ name: "open door", members: [ref] });
    assert.equal(created.sent.length, 1);
    assert.equal(created.sent[0].accepted, true);
    // A room message is NOT sent to the non-admitted invitee (it is invited, not active, and not admitted).
    const said = await host.speak({ space: created.space, text: "only for admitted members" });
    assert.equal(said.sent.length, 0);
    // A direct deliver to a non-admitted key outside the invite exception is refused.
    await assert.rejects(host.deliver(stranger._identity.uuaid, stranger._identity.publicKeyHex, { text: "hi" }), (e) => e.code === "RECIPIENT_NOT_ADMITTED");
    // The invite exception needs the chain to name THAT key as invited: a different key for the same uuaid is refused.
    const other = key();
    await assert.rejects(host.deliver(stranger._identity.uuaid, other._identity.publicKeyHex, { text: "hi" }, "message", { inviteeOf: host.groups.load(created.space) }), (e) => e.code === "RECIPIENT_NOT_ADMITTED");
  } finally { await close(); }
});

// RedTeam COND-A: the invitee exception only holds for a chain this home authored, or whose genesis admin is admitted here.
test("space: COND-A — an invited row in a chain authored elsewhere never satisfies the invitee exception", async () => {
  const { drivers: [host], close } = await world(1);
  try {
    const { RosterStore: Store, adminCreate } = await import("../src/spaces/pillar-group.mjs");
    const foreignAdmin = key("agentnet"), stranger = key();
    const dir = mkdtempSync(join(tmpdir(), "ac-foreign-"));
    try {
      const { rec: foreign } = adminCreate({ store: new Store(dir), mailbox: null, keychain: foreignAdmin, name: "elsewhere", members: [{ uuaid: stranger._identity.uuaid, key: stranger._identity.publicKeyHex }] });
      assert.equal(foreign.chain[0].members.find((r) => r.uuaid === stranger._identity.uuaid).status, "invited");
      // Foreign admin not admitted here: the stranger it invited is unreachable from this home.
      assert.equal(host.chainAuthorized(foreign), false);
      assert.throws(() => host.assertOutbound(stranger._identity.uuaid, stranger._identity.publicKeyHex, { inviteeOf: foreign }), (e) => e.code === "RECIPIENT_NOT_ADMITTED");
      await assert.rejects(host.deliver(stranger._identity.uuaid, stranger._identity.publicKeyHex, { _group: {} }, "message", { inviteeOf: foreign }), (e) => e.code === "RECIPIENT_NOT_ADMITTED");
      // Positive control: once that admin is admitted here under its chain key, the same row satisfies the exception.
      host.runtime.policy.agents[foreignAdmin._identity.uuaid] = { kind: "agent", publicKey: foreignAdmin._identity.publicKeyHex, capabilities: CAPS };
      assert.equal(host.assertOutbound(stranger._identity.uuaid, stranger._identity.publicKeyHex, { inviteeOf: foreign }), "invitee");
      // Admitted under a different key: not the chain's admin, so still refused.
      host.runtime.policy.agents[foreignAdmin._identity.uuaid].publicKey = key()._identity.publicKeyHex;
      assert.throws(() => host.assertOutbound(stranger._identity.uuaid, stranger._identity.publicKeyHex, { inviteeOf: foreign }), (e) => e.code === "RECIPIENT_NOT_ADMITTED");
      // A chain this home authored keeps the exception (the seat-a-stranger flow).
      const own = await host.create({ name: "mine", members: [`${stranger._identity.uuaid}:${stranger._identity.publicKeyHex}`] });
      assert.equal(host.chainAuthorized(host.groups.load(own.space)), true);
      assert.equal(own.sent[0].accepted, true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  } finally { await close(); }
});

// RedTeam COND-B: policy.blocked is checked on every send, so a stale admission of a since-blocked key never passes.
test("space: COND-B — a blocked key is refused on every send, under any spelling, and reported per recipient", async () => {
  const { keys: [, guestK], drivers: [host, guest], close } = await world(2);
  try {
    const { space } = await host.create({ name: "block room", members: [guestK._identity.uuaid] });
    await guest.poll(); await guest.join({ space }); const s = await host.poll(); await host.accept({ signal: s.signals[0].signal }); await guest.poll();
    const g = guestK._identity.uuaid;
    assert.equal(host.assertOutbound(g, guestK._identity.publicKeyHex), "admitted");
    // Blocked under another namespace spelling of the same key: still the same key, still refused.
    const respelled = g.replace(/^uuaid:[a-z]+:/, "uuaid:pillar:");
    assert.notEqual(respelled, g);
    host.runtime.policy.blocked = [respelled];
    assert.throws(() => host.assertOutbound(g, guestK._identity.publicKeyHex), (e) => e.code === "RECIPIENT_BLOCKED");
    await assert.rejects(host.deliver(g, guestK._identity.publicKeyHex, { text: "hi" }), (e) => e.code === "RECIPIENT_BLOCKED");
    const said = await host.speak({ space, text: "not to the blocked" });
    assert.deepEqual(said.sent.map((x) => [x.to, x.accepted, x.error]), [[g, false, "RECIPIENT_BLOCKED"]]);
    // A blocked admin's chain no longer authorizes the invitee exception either: on the guest's side the chain's
    // genesis admin is the host, so blocking the host there revokes that chain's exception (world() shares one policy).
    host.runtime.policy.blocked = [];
    assert.equal(guest.chainAuthorized(guest.groups.load(space)), true);
    guest.runtime.policy.blocked = [host.self.uuaid];
    assert.equal(guest.chainAuthorized(guest.groups.load(space)), false);
  } finally { await close(); }
});

// Holder gap: the supported raw-envelope API is reachable through the public ./spaces subpath, with no deep import.
test("spaces: createGroupReceiver from @uuaid/agent-commons/spaces drives judgeEnvelope to a real verdict", async () => {
  const { keys: [hostK, guestK], drivers: [host, guest], close } = await world(2);
  try {
    const spaces = await import("@uuaid/agent-commons/spaces");
    assert.equal(typeof spaces.createGroupReceiver, "function");
    const { space } = await host.create({ name: "public api room", members: [guestK._identity.uuaid] });
    await guest.poll(); await guest.join({ space }); const s = await host.poll(); await host.accept({ signal: s.signals[0].signal }); await guest.poll();
    const { buildGroupTag } = await import("../src/spaces/pillar-group.mjs");
    const env = seal(hostK, { recipient: guestK._identity.uuaid, recipientPublicKey: guestK._identity.publicKeyHex, kind: "message", payload: { text: "via the public api", _group: buildGroupTag(host.groups.load(space), { op: "message" }) } });
    const receiver = spaces.createGroupReceiver({ home: guest.groups.dir.replace(/\/groups-v2$/, ""), keychain: guestK });
    const j = spaces.judgeEnvelope(receiver, guestK, env);
    assert.equal(j.verdict, "accepted");
    assert.equal(j.group, space);
    assert.throws(() => spaces.createGroupReceiver({ home: "x", keychain: {} }), (e) => e.code === "NO_IDENTITY");
    assert.throws(() => spaces.createGroupReceiver({ keychain: guestK }), (e) => e.code === "HOME");
  } finally { await close(); }
});
