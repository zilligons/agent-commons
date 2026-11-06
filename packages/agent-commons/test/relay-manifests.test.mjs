// Closed manifests (spec v3.2 section 13.4, verifier R5): hand-written from the spec
// under test/relay-fixtures/manifests/, checked against the code in both
// directions. A field, action or sink the code has but a manifest lacks fails,
// and so does a manifest entry the code does not implement.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { validateMemberRecord, MEMBER_RECORD_TYPES } from "../src/relay/records.mjs";
import { permits, PERMISSION_TABLE, CEILING, ALL_ACTIONS, PRINCIPAL_KINDS, FROZEN_ALLOWED, DEFAULT_SECURITY_PATHS } from "../src/relay/governance.mjs";
import { handleMemberRecord, ownClaims, boardView } from "../src/relay/board.mjs";
import { readInbox } from "../src/relay/mailbox.mjs";
import { sendSeatMessage } from "../src/relay/governance.mjs";
import { renderSeatFeed } from "../src/relay/render.mjs";
import { exportRelay, signBody } from "../src/relay/signing.mjs";
import { setup, scratch, decision, approval, verifyResult, ownerConfirm, seatMessage, findingOpen, findingClose, taskArgs, PATCH, outboxFor, rejects, keySeedHex, T0, HOUR, LANE, createDecision, addVerdict, attestation, recordVerifyResult, confirmOwnerRecord, openFinding, closeFinding, recordAttestation, createInvite } from "./relay-fixtures.mjs";

const manifest = (name) => JSON.parse(readFileSync(new URL(`./relay-fixtures/manifests/${name}.json`, import.meta.url), "utf8"));
const BIDI = "\u202E";

// A valid body per member type, so one field at a time can be varied.
const BASE = {
  heartbeat: {}, message: { lane: LANE, text: "hi" }, claim: { task_id: "t" }, release: { claim_id: "c", epoch: 1 },
  progress: { claim_id: "c", epoch: 1, text: "p" }, evidence: { submission_id: "s", kind: "log", text: "e" },
  "review-request": { submission_id: "s" }, propose: { title: "t", description: "d", lane: LANE, acceptance: "a" },
  "advisory-review": { target: "s", verdict: "concern", text: "x" }, note: { text: "n" },
  "result(report)": { claim_id: "c", epoch: 1, kind: "report", body: "r" },
  "result(patch)": { claim_id: "c", epoch: 1, kind: "patch", body: [{ path: "docs/a.md", diff: "d" }] },
};
function withField(type, field, value) {
  if (type === "result") {
    if (field === "body(report)") return { type, record_id: "r", body: { ...BASE["result(report)"], body: value } };
    const file = { path: "docs/a.md", diff: "d", [field === "body[].path" ? "path" : "diff"]: value };
    return { type, record_id: "r", body: { ...BASE["result(patch)"], body: [file] } };
  }
  return { type, record_id: "r", body: { ...BASE[type], [field]: value } };
}

test("N12 / N13 record-fields.json: every listed text field refuses hidden characters and holds its cap exactly", () => {
  const m = manifest("record-fields");
  assert.deepEqual(Object.keys(m.member).sort(), Object.keys(MEMBER_RECORD_TYPES).sort(), "the manifest names exactly the code's member types");
  for (const [type, fields] of Object.entries(m.member)) {
    for (const { field, cap } of fields) {
      rejects(() => validateMemberRecord(withField(type, field, `a${BIDI}b`)), "hidden-character");
      if (cap === null) continue;
      const exact = "a".repeat(cap);
      if (type !== "result" || field !== "body[].diff") validateMemberRecord(withField(type, field, exact));
      assert.throws(() => validateMemberRecord(withField(type, field, exact + "a")), e => ["field-too-long", "record-too-large"].includes(e.code), `${type}.${field} cap+1`);
    }
  }
});

test("N13 closure: a free-text member field missing from record-fields.json fails", () => {
  const listed = new Set(Object.entries(manifest("record-fields").member).flatMap(([t, fs]) => fs.map(f => `${t}.${f.field}`)));
  for (const [type, spec] of Object.entries(MEMBER_RECORD_TYPES)) {
    const probes = type === "result" ? ["body(report)", "body[].path", "body[].diff"] : Object.keys(spec.fields);
    for (const field of probes) {
      let isText = false;
      try { validateMemberRecord(withField(type, field, `a${BIDI}b`)); } catch (e) { isText = e.code === "hidden-character"; }
      if (isText) assert.ok(listed.has(`${type}.${field}`), `${type}.${field} is free text but not in the manifest`);
    }
  }
});

test("N13 record-fields.json fleet fields: task.open args, seat messages and Served-by refuse hidden characters", () => {
  const m = manifest("record-fields");
  const fx = setup({ members: ["A"] });
  const set = (obj, path, value) => {
    const keys = path.replace(/\[\]$/, "").split(".");
    const last = keys.pop(), target = keys.reduce((o, k) => o[k], obj);
    target[last] = path.endsWith("[]") ? [value] : value;
  };
  for (const { field, cap } of m.fleet["task.open"]) {
    const args = structuredClone(taskArgs(["docs"]));
    set({ args }, field, `a${BIDI}b`);
    rejects(() => createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "task.open", subject: `t-${field.replace(/[^a-z]/g, "")}`, args }), T0), "hidden-character");
    const long = structuredClone(taskArgs(["docs"]));
    set({ args: long }, field, "a".repeat(cap + 1));
    rejects(() => createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "task.open", subject: `u-${field.replace(/[^a-z]/g, "")}`, args: long }), T0), "field-too-long");
  }
  rejects(() => sendSeatMessage(fx.db, seatMessage(fx, "seat-1", fx.members.A.id, `a${BIDI}b`), T0), "hidden-character");
  rejects(() => sendSeatMessage(fx.db, seatMessage(fx, "seat-1", fx.members.A.id, "a".repeat(m.fleet.message[0].cap + 1)), T0), "field-too-long");
  assert.equal(m.fleet["every-fleet-record"][0].field, "served_by");
  // Finding records (L0 choice): their free text is sanitized and capped like every other field.
  const A = fx.members.A.id;
  rejects(() => openFinding(fx.db, findingOpen(fx, { member_id: A, summary: `a${BIDI}b` }), T0), "hidden-character");
  rejects(() => openFinding(fx.db, findingOpen(fx, { member_id: A, summary: "a".repeat(m.fleet["finding.open"][0].cap + 1) }), T0), "field-too-long");
  const f = openFinding(fx.db, findingOpen(fx, { member_id: A }), T0);
  rejects(() => closeFinding(fx.db, findingClose(fx, { finding_id: f.id, resolution: `a${BIDI}b` }), T0), "hidden-character");
  rejects(() => closeFinding(fx.db, findingClose(fx, { finding_id: f.id, resolution: "a".repeat(m.fleet["finding.close"][0].cap + 1) }), T0), "field-too-long");
  // invite.create (5.1) and served_by.attest (9.8) text fields.
  for (const { field, cap } of m.fleet["invite.create"]) {
    const key = field.slice(5), base = { kind: "enroll", member_id: null, intended_display_name: "n", intended_platform: "p" };
    for (const [value, code] of [[`a${BIDI}b`, "hidden-character"], ["a".repeat(cap + 1), "field-too-long"]])
      rejects(() => createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "invite.create", subject: `inv-${key}-${code}`, args: { ...base, [key]: value } }), T0), code);
  }
  // rebind.cancel (Addendum D3): args.reason is sanitized and capped.
  const live = createInvite(fx, { kind: "rebind", member_id: A, at: T0 });
  for (const [value, code] of [[`a${BIDI}b`, "hidden-character"], ["a".repeat(m.fleet["rebind.cancel"][0].cap + 1), "field-too-long"]])
    rejects(() => createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "rebind.cancel", subject: live.invite_id, args: { reason: value } }), T0), code);
  const d1 = fx.db.prepare("SELECT decision_id FROM approvals WHERE seq = 1 LIMIT 1").get().decision_id;
  const by = fx.db.prepare("SELECT approver FROM approvals WHERE decision_id = ? AND seq = 1").get(d1).approver;
  for (const { field, cap } of m.fleet["served_by.attest"]) {
    const key = field.replace("[]", "");
    for (const [value, code] of [[`a${BIDI}b`, "hidden-character"], ["a".repeat(cap + 1), "field-too-long"]]) {
      const signed = attestation(fx.db, fx.keys.measurer, "measurer", { decision_id: d1, by, seq: 1, family: "openai" });
      signed.body[key] = field.endsWith("[]") ? [value] : value;
      signed.sig = signBody(fx.keys.measurer, signed.body);
      rejects(() => recordAttestation(fx.db, signed, T0), code);
    }
  }
});

test("N16 actions.json: the permission table matches the manifest exactly, in both directions", () => {
  const m = manifest("actions");
  const named = new Set([...Object.values(m.member).flat(), ...Object.values(m.fleet).flat(), ...m.ceiling]);
  assert.deepEqual([...named].sort(), [...ALL_ACTIONS].sort(), "every action is in the manifest and every manifest action exists");
  assert.deepEqual([...m.ceiling].sort(), [...CEILING].sort());
  let allowed = 0;
  for (const role of Object.keys(m.member)) for (const action of ALL_ACTIONS) {
    const expect = m.member[role].includes(action);
    assert.equal(permits("member", role, action), expect, `member ${role} ${action}`);
    allowed += expect;
  }
  for (const kind of PRINCIPAL_KINDS.filter(k => k !== "member")) for (const action of ALL_ACTIONS) {
    const expect = m.fleet[kind].includes(action);
    assert.equal(permits(kind, null, action), expect, `${kind} ${action}`);
    allowed += expect;
  }
  assert.equal(PERMISSION_TABLE.size, allowed, "no permission outside the manifest");
});

test("N26 frozen-actions.json: the freeze exceptions match, and every fleet action is classified", () => {
  const m = manifest("frozen-actions");
  assert.deepEqual([...FROZEN_ALLOWED].sort(), [...m.fleet_allowed].sort());
  const fleetActions = new Set(PRINCIPAL_KINDS.filter(k => k !== "member").flatMap(k => ALL_ACTIONS.filter(a => permits(k, null, a))));
  assert.deepEqual([...new Set([...m.fleet_allowed, ...m.fleet_refused])].sort(), [...fleetActions].sort());
});

test("N21 security-paths.json matches the classifier", () => {
  assert.deepEqual([...DEFAULT_SECURITY_PATHS], manifest("security-paths").paths);
});

test("N22 sinks.json + public-fields.json: no secret canary in any L0 sink; every 64-hex value is a declared public field", () => {
  const sinks = manifest("sinks"), pub = manifest("public-fields");
  const { path } = scratch();
  const fx = setup({ path });
  const A = fx.members.A.id;
  // A full L0 scenario so every sink holds data.
  createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "task.open", subject: "task-1", args: taskArgs(["docs"]) }), T0);
  handleMemberRecord(fx.db, A, { type: "heartbeat", record_id: "hb", body: {} }, T0);
  createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "role.c1", subject: A }), T0);
  const c = handleMemberRecord(fx.db, A, { type: "claim", record_id: "c", body: { task_id: "task-1", lease_ms: HOUR } }, T0);
  handleMemberRecord(fx.db, A, { type: "progress", record_id: "p", body: { claim_id: c.claim_id, epoch: c.epoch, text: "half way" } }, T0);
  handleMemberRecord(fx.db, A, { type: "message", record_id: "m", body: { lane: LANE, text: "question for the lane" } }, T0);
  handleMemberRecord(fx.db, A, { type: "note", record_id: "n", body: { text: "support request" } }, T0);
  sendSeatMessage(fx.db, seatMessage(fx, "seat-1", A, "answer"), T0);
  const r = handleMemberRecord(fx.db, A, { type: "result", record_id: "r", body: { claim_id: c.claim_id, epoch: c.epoch, kind: "patch", body: PATCH() } }, T0);
  handleMemberRecord(fx.db, A, { type: "evidence", record_id: "e", body: { submission_id: r.submission_id, kind: "log", text: "ok" } }, T0);
  const d = createDecision(fx.db, decision(fx, "seat-1", { cls: "D1", action: "accept", subject: r.submission_id }), T0);
  addVerdict(fx.db, approval(fx, "seat-2", d.id), T0);
  recordVerifyResult(fx.db, verifyResult(fx, { submission_id: r.submission_id, patch_sha256: r.body_sha256 }), T0);
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-3", outboxFor(fx.db, d.id)), T0);
  createDecision(fx.db, decision(fx, "verifier", { cls: "SUSPEND", action: "suspend", subject: fx.members.B.id }), T0);

  const texts = {
    exportRelay: JSON.stringify(exportRelay(fx.db)),
    renderSeatFeed: renderSeatFeed(fx.db, LANE).join("\n"),
    "readInbox page": JSON.stringify(readInbox(fx.db, A, {}, T0)),
    ownClaims: JSON.stringify(ownClaims(fx.db, A, T0)),
    boardView: JSON.stringify(boardView(fx.db, A, T0)),
    "member receipts": JSON.stringify(fx.db.prepare("SELECT receipt FROM member_records").all().map(x => x.receipt)),
    alerts: JSON.stringify(fx.db.prepare("SELECT * FROM alerts").all()),
  };
  fx.db.close();
  const files = Object.fromEntries(["", "-wal", "-shm"].map(s => {
    try { return [`relay.db${s ? `${s}` : ""} file`, readFileSync(path + s)]; } catch { return [`relay.db${s} file`, Buffer.alloc(0)]; }
  }));
  const covered = new Set([...Object.keys(texts), ...Object.keys(files)]);
  for (const sink of sinks.l0) assert.ok(covered.has(sink), `sink ${sink} is not scanned`);
  for (const sink of covered) assert.ok(sinks.l0.includes(sink), `scanned ${sink} is not in sinks.json`);

  // (a) Canaries: every fixture key seed (hex, raw, base64, base64url), every private key's DER, every raw invite secret.
  const identities = [...Object.values(fx.keys), ...Object.values(fx.members).map(m => m.identity)];
  const canaries = identities.flatMap(id => {
    const seed = Buffer.from(keySeedHex(id), "hex"), der = id.privateKey.export({ format: "der", type: "pkcs8" });
    return [seed.toString("hex"), seed, seed.toString("base64"), seed.toString("base64url"), der.toString("base64")];
  }).concat(Object.values(fx.members).flatMap(m => [m.inviteSecret.toString("hex"), m.inviteSecret, m.inviteSecret.toString("base64")]));
  for (const [name, hay] of [...Object.entries(texts).map(([k, v]) => [k, Buffer.from(v)]), ...Object.entries(files)])
    for (const canary of canaries) assert.equal(hay.includes(canary), false, `secret canary in ${name}`);

  // (b) Every bounded 64-hex value in any sink is a declared public value.
  const allowed = new Set();
  const exp = JSON.parse(texts.exportRelay);
  const walk = (v) => {
    if (typeof v === "string") { if (v.startsWith("{")) { try { walk(JSON.parse(v)); } catch { /* not JSON */ } } return; }
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
      if (pub.json_keys.includes(k) && typeof x === "string") allowed.add(x.startsWith("sha256:") ? x.slice(7) : x);
      walk(x);
    }
  };
  walk(exp); walk(Object.values(texts).map(t => { try { return JSON.parse(t); } catch { return t; } }));
  const live = new DatabaseSync(path, { readOnly: true });
  for (const col of pub.columns) {
    const [table, column] = col.split(".");
    for (const row of live.prepare(`SELECT ${column} AS v FROM ${table}`).all()) if (typeof row.v === "string") allowed.add(row.v);
  }
  live.close();
  const HEX64 = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g;
  let classified = 0;
  for (const [name, hay] of [...Object.entries(texts), ...Object.entries(files).map(([k, b]) => [k, b.toString("latin1")])])
    for (const token of hay.match(HEX64) ?? []) { assert.ok(allowed.has(token), `undeclared 64-hex value in ${name}: ${token.slice(0, 12)}...`); classified++; }
  assert.ok(classified > 20, `the scan saw ${classified} 64-hex values; it must not be vacuous`);
  // Negative control: an undeclared 64-hex value in a sink is found by the same scan.
  const planted = keySeedHex(fx.members.A.identity);
  assert.equal(allowed.has(planted), false);
  assert.ok(`{"x":"${planted}"}`.match(HEX64).some(t => !allowed.has(t)));
});
