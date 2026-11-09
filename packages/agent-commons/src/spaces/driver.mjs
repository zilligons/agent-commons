/**
 * Spaces from the CLI: create, invite, join, accept (from a signal), speak and poll a groups-v2 space with nothing but
 * an Agent Commons home. This is the SUPPORTED way in to the vendored groups-v2 engine: callers never hand-build the
 * receiver's input. `judgeEnvelope` / `judgeReceived` do decrypt -> attach -> judge, so a driver's first verdict is
 * never a fabrication (a wrong "not-group" from a hand-attached payload).
 *
 * Trust: every inbound envelope first passes the runtime's own admission (an admitted sender under its pinned key);
 * the group engine then applies its own membership rules on top. Nothing here weakens either.
 */
import { randomBytes } from "node:crypto";
import { open, decrypt, seal } from "../pillar.mjs";
import {
  RosterStore, isGroupIdV2, adminCreate, adminChange, adminManifestSends, buildGroupTag, recipientsOf,
  GroupReceiver, keyBindsUuaid, manifestHash, adminOf, fanOutBudget,
} from "./pillar-group.mjs";

export class SpaceDriverError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new SpaceDriverError(code, message); };
const ENV_ID = /^env-[0-9A-Za-z_-]{6,128}$/;
const head = (rec) => rec.chain[rec.chain.length - 1];

/**
 * The supported group-receive path for a raw Pillar envelope: verify, decrypt, attach and judge.
 * Returns { verdict, reason, sends, ... } from the engine, plus `from`, `group` and `payload`.
 */
export function judgeEnvelope(receiver, keychain, envelope, now = Date.now()) {
  const v = open(envelope);
  if (!v.ok) return { verdict: "dropped", reason: `invalid-envelope:${v.reason}`, sends: [] };
  const payload = decrypt(keychain, envelope);
  return judgeReceived(receiver, { sender: envelope.sender, transportKey: envelope.transportSignature.publicKey, payload, delegation: envelope.delegation }, now);
}

/** Same contract for a message the Agent Commons runtime already verified, admitted and decrypted. */
export function judgeReceived(receiver, { sender, transportKey, payload, delegation }, now = Date.now()) {
  const env = { payload, from: sender, transportKey, ...(delegation ? { delegation } : {}) };
  const out = receiver.receive(env, now);
  const group = payload && typeof payload === "object" && payload._group && typeof payload._group.id === "string" ? payload._group.id : null;
  return { ...out, from: sender, group, payload };
}

export class SpaceDriver {
  /** runtime: a loaded AgentCommons (keychain, store, policy, transport). home: the Agent Commons home directory. */
  constructor({ home, runtime }) {
    if (!runtime?.keychain?._identity) fail("NO_IDENTITY", "A loaded Agent Commons runtime is required");
    this.runtime = runtime;
    this.keychain = runtime.keychain;
    this.groups = new RosterStore(home);
    this.self = { uuaid: runtime.keychain._identity.uuaid, key: runtime.keychain._identity.publicKeyHex };
  }

  /** "uuaid" (an admitted agent; its pinned key is used) or "uuaid:<64 hex key>". */
  memberRef(spec) {
    if (typeof spec !== "string") fail("MEMBER", "A member is a uuaid or uuaid:<64-hex public key>");
    const m = /^(uuaid:[a-z0-9-]+:[a-z0-9-]+:[a-z0-9][a-z0-9-]*)(?::([0-9a-f]{64}))?$/.exec(spec);
    if (!m) fail("MEMBER", `Not a member reference: ${spec.slice(0, 120)}`);
    const key = m[2] ?? this.runtime.policy.agents?.[m[1]]?.publicKey;
    if (!key) fail("MEMBER_KEY", `${m[1]} is not admitted here; give its key as uuaid:<key> or admit it first`);
    if (!keyBindsUuaid(m[1], key)) fail("MEMBER_KEY", `${m[1]}: the key does not derive this uuaid`);
    return { uuaid: m[1], key };
  }

  load(space) {
    if (!isGroupIdV2(space)) fail("SPACE", "A space id is grp-<32 hex>");
    if (!this.groups.has(space)) fail("SPACE_UNKNOWN", `${space} is not known in this home`);
    return this.groups.load(space);
  }

  keyFor(rec, uuaid) {
    if (rec) for (let i = rec.chain.length - 1; i >= 0; i--) { const r = rec.chain[i].members.find((x) => x.uuaid === uuaid); if (r) return r.key; }
    return this.runtime.policy.agents?.[uuaid]?.publicKey ?? null;
  }

  /**
   * Outbound admission (RedTeam PR7-1): the transport itself does not check recipients, so the driver does. A space
   * sends only to an agent admitted here under exactly the key used, with commons:message, and not blocked. The one
   * exception is `inviteeOf`: manifests to a member that the group's own signed chain lists as INVITED under that key,
   * so an admin can seat a stranger it named; that recipient still cannot speak until the admin admits it.
   */
  assertOutbound(to, key, { inviteeOf = null } = {}) {
    const agent = this.runtime.policy.agents?.[to];
    if (agent && agent.kind === "agent" && agent.publicKey === key && agent.capabilities?.includes("commons:message")) return "admitted";
    if (inviteeOf) {
      const row = head(inviteeOf).members.find((r) => r.uuaid === to);
      if (row && row.status === "invited" && row.key === key) return "invitee";
    }
    fail("RECIPIENT_NOT_ADMITTED", `${to} is not admitted here under that key; admit it first (agent-commons admit)`);
  }

  async deliver(to, key, payload, kind = "message", { inviteeOf = null } = {}) {
    if (!this.runtime.transport) fail("NO_CARRIER", "No carrier configured in this home (config.json carriers)");
    if (!key) fail("MEMBER_KEY", `No key for ${to}`);
    this.assertOutbound(to, key, { inviteeOf });
    const envelope = seal(this.keychain, { recipient: to, recipientPublicKey: key, kind, payload });
    try {
      const receipt = await this.runtime.transport.deliver(envelope, { timeoutMs: 10000 });
      return { to, id: envelope.id, accepted: receipt?.accepted === true };
    } catch (error) {
      return { to, id: envelope.id, accepted: false, error: error.code ?? error.message };
    }
  }

  /** Seal and send engine `sends` rows ({to, op, manifestHash?, want?}) for one group. */
  async runSends(groupId, sends) {
    const results = [];
    const rec = groupId && this.groups.has(groupId) ? this.groups.load(groupId) : null;
    for (const s of sends) {
      let tag;
      if (rec && s.op === "manifest") {
        const manifest = rec.chain.find((m) => manifestHash(m) === s.manifestHash);
        if (!manifest) { results.push({ to: s.to, op: s.op, accepted: false, error: "manifest-not-in-chain" }); continue; }
        tag = buildGroupTag(rec, { op: "manifest", manifest });
      } else if (rec) {
        tag = buildGroupTag(rec, { op: s.op, ...(s.want ? { want: s.want } : {}) });
      } else if (s.op === "manifest.request" && isGroupIdV2(groupId)) {
        // An invitation still being assembled: there is no local record yet, so ask at version 0.
        tag = { v: 2, id: groupId, name: "", members: [], msgId: `gm-${randomBytes(16).toString("hex")}`, op: "manifest.request", mv: { version: 0, hash: "0".repeat(64) }, want: s.want };
      } else { results.push({ to: s.to, op: s.op, accepted: false, error: "unknown-group" }); continue; }
      // Only a manifest to a member the signed chain lists as invited may go to a not-yet-admitted key.
      const inviteeOf = rec && s.op === "manifest" ? rec : null;
      try {
        results.push({ op: s.op, ...(await this.deliver(s.to, s.key ?? this.keyFor(rec, s.to), { _group: tag }, "message", { inviteeOf })) });
      } catch (error) {
        if (error?.code !== "RECIPIENT_NOT_ADMITTED") throw error;
        results.push({ to: s.to, op: s.op, accepted: false, error: error.code });
      }
    }
    return results;
  }

  async create({ name, purpose, members = [] }) {
    if (typeof name !== "string" || !name.trim()) fail("NAME", "A space needs a --name");
    const refs = members.map((m) => this.memberRef(m));
    const { rec, manifest } = adminCreate({ store: this.groups, mailbox: null, keychain: this.keychain, name, ...(purpose ? { purpose } : {}), members: refs });
    const sends = adminManifestSends(rec, { members: recipientsOf(rec, this.self.uuaid) }, this.self.uuaid);
    return { space: rec.id, version: manifest.version, invited: refs.map((r) => r.uuaid), sent: await this.runSends(rec.id, sends) };
  }

  async invite({ space, member }) {
    const ref = this.memberRef(member);
    const before = this.load(space);
    const row = { members: recipientsOf(before, this.self.uuaid) };
    const { rec, manifest } = adminChange({ store: this.groups, mailbox: null, keychain: this.keychain, groupId: space, action: "invite", opts: { member: ref } });
    const sends = adminManifestSends(rec, row, this.self.uuaid);
    return { space, version: manifest.version, invited: ref.uuaid, sent: await this.runSends(space, sends) };
  }

  /** The invitee's side: say "I am in" to the admin with an accept.request signal. */
  async join({ space }) {
    const rec = this.load(space);
    const me = head(rec).members.find((r) => r.uuaid === this.self.uuaid);
    if (!me || me.status !== "invited") fail("NOT_INVITED", `This identity is ${me?.status ?? "not a member"} in ${space}`);
    const admin = adminOf(head(rec));
    const sent = await this.deliver(admin.uuaid, admin.key, { _group: buildGroupTag(rec, { op: "accept.request" }) });
    return { space, to: admin.uuaid, signal: sent.id, sent };
  }

  /**
   * The admin's side, in one step: take the id of the envelope in which the invitee said "I am in" (an accept.request
   * signal or a plain message), find who sent it, and produce the next manifest version with that id as the request.
   */
  async accept({ signal, space }) {
    if (typeof signal !== "string" || !ENV_ID.test(signal)) fail("SIGNAL", "--signal is the received envelope id (env-...)");
    const row = this.runtime.store.db.prepare("SELECT body FROM events WHERE id LIKE ? ESCAPE '\\' LIMIT 2").all(`plain:%:${signal.replace(/[\\%_]/g, (c) => `\\${c}`)}`);
    if (row.length !== 1) fail("SIGNAL_UNKNOWN", `No received envelope ${signal} in this home (poll first)`);
    const event = JSON.parse(row[0].body);
    if (event.envelopeId !== signal) fail("SIGNAL_UNKNOWN", `No received envelope ${signal} in this home`);
    const from = event.sender;
    const candidates = (space ? [space] : this.groups.list()).filter((id) => {
      const h = head(this.load(id));
      return adminOf(h).uuaid === this.self.uuaid && h.members.some((r) => r.uuaid === from && r.status === "invited");
    });
    if (candidates.length === 0) fail("NOT_INVITED", `${from} is not invited to ${space ?? "any space this identity administers"}`);
    if (candidates.length > 1) fail("AMBIGUOUS", `${from} is invited to several spaces; pass --space`);
    const groupId = candidates[0];
    const row0 = { members: recipientsOf(this.load(groupId), this.self.uuaid) };
    const { rec, manifest } = adminChange({ store: this.groups, mailbox: null, keychain: this.keychain, groupId, action: "accept", opts: { target: from, request: signal } });
    const sends = adminManifestSends(rec, { members: [...new Set([...row0.members, from])] }, this.self.uuaid);
    return { space: groupId, version: manifest.version, accepted: from, request: signal, sent: await this.runSends(groupId, sends) };
  }

  async speak({ space, text, payload = {} }) {
    if (typeof text !== "string" || !text.length) fail("TEXT", "--text is required");
    const rec = this.load(space);
    const me = head(rec).members.find((r) => r.uuaid === this.self.uuaid);
    if (!me || me.status !== "active") fail("NOT_ACTIVE", `This identity is ${me?.status ?? "not a member"} in ${space}`);
    const to = recipientsOf(rec, this.self.uuaid);
    if (to.length > fanOutBudget(head(rec).members.length)) fail("FAN_OUT", "Fan-out budget exceeded");
    const tag = buildGroupTag(rec, { op: "message" });
    const sent = [];
    for (const u of to) {
      try { sent.push(await this.deliver(u, this.keyFor(rec, u), { ...payload, text, _group: tag })); }
      catch (error) { if (error?.code !== "RECIPIENT_NOT_ADMITTED") throw error; sent.push({ to: u, accepted: false, error: error.code }); }
    }
    return { space, msgId: tag.msgId, sent };
  }

  /**
   * Poll the home's carriers once (the runtime's own cursor and admission), route group traffic through the engine,
   * send whatever the engine asks for, and report messages, invitations and join signals.
   */
  async poll({ now = Date.now() } = {}) {
    const results = await this.runtime.poll();
    const receiver = new GroupReceiver({ self: this.self, store: this.groups, mailbox: null });
    const report = { messages: [], direct: [], invitations: [], signals: [], dropped: [], other: [], sent: [] };
    for (const r of results) {
      if (r?.format !== "pillar-plain") { report.other.push(r); continue; }
      if (!r.group) { report.direct.push({ id: r.id, from: r.sender, kind: r.kind, payload: r.payload }); continue; }
      const j = judgeReceived(receiver, { sender: r.sender, transportKey: r.transportKey, payload: r.payload }, now);
      const op = r.payload._group?.op;
      if (j.verdict === "accepted" && op === "message") {
        const { _group, ...content } = r.payload;
        report.messages.push({ space: j.group, from: r.sender, envelopeId: r.id, msgId: _group.msgId, ...content });
      } else if (j.verdict === "accepted" && op === "accept.request") {
        report.signals.push({ space: j.group, from: r.sender, signal: r.id, next: `space accept --signal ${r.id}` });
      } else if (j.verdict === "invitation") {
        report.invitations.push({ space: j.group, from: r.sender, name: head(this.groups.load(j.group)).name, next: `space join --space ${j.group}` });
      } else if (j.verdict === "dropped") {
        report.dropped.push({ space: j.group, from: r.sender, envelopeId: r.id, reason: j.reason, ...(j.detail ? { detail: j.detail } : {}) });
      } else {
        report.other.push({ space: j.group, from: r.sender, envelopeId: r.id, verdict: j.verdict, reason: j.reason });
      }
      if (j.sends?.length) report.sent.push(...(await this.runSends(j.group, j.sends)));
    }
    return report;
  }

  list() {
    return this.groups.list().map((id) => {
      const rec = this.groups.load(id), h = head(rec), me = h.members.find((r) => r.uuaid === this.self.uuaid);
      return { space: id, name: h.name, version: h.version, admin: adminOf(h).uuaid, status: me?.status ?? "not-member",
        members: h.members.map((r) => ({ uuaid: r.uuaid, role: r.role, status: r.status })) };
    });
  }
}
