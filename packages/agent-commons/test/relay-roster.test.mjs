// L0: the owner-signed roster and policy files (spec v3.2 sections 9.1, 9.2 D3,
// 12.3). The relay refuses to start without both, on a bad signature, or on an
// owner key that the operator did not pin. Scratch databases, fixture keys.

import test from "node:test";
import assert from "node:assert/strict";
import { openRelay, loadRoster, loadPolicy } from "../src/relay/roster.mjs";
import { handleMemberRecord } from "../src/relay/board.mjs";
import { signBody } from "../src/relay/signing.mjs";
import { mint, scratch, fixtureFiles, seedMember, decision, approval, verifyResult, securityApproval, taskArgs, PATCH, rejects,
  T0, HOUR, LANE, createDecision, addVerdict, trackMeasurer, recordVerifyResult, recordSecurityApproval } from "./relay-fixtures.mjs";

const IDS = ["seat-1", "seat-2", "seat-3", "seat-4", "seat-5", "seat-6", "seat-7", "verifier", "security", "scope", "owner", "measurer"];
const mintAll = () => Object.fromEntries(IDS.map(id => [id, mint()]));
const resign = (key, body) => ({ body, sig: signBody(key, body) });
const start = (keys, files, path = ":memory:", pin = keys.owner.publicKeyHex) => openRelay({ path, ...files, ownerPublicKey: pin, now: T0 });
const fleet = (db, id) => ({ ...db.prepare(`SELECT f.status, k.status AS key_status FROM fleet_principals f
                                              JOIN keys k ON k.principal_kind = 'fleet' AND k.principal_id = f.principal_id WHERE f.principal_id = ?`).get(id) });
const securityLog = (db) => db.prepare("SELECT event FROM logs WHERE log = 'security' ORDER BY seq").all().map(r => JSON.parse(r.event).kind);

test("the relay refuses to start without both signed files, or with an owner key nobody pinned", () => {
  const keys = mintAll(), files = fixtureFiles(keys);
  rejects(() => openRelay({ roster: files.roster, ownerPublicKey: keys.owner.publicKeyHex, now: T0 }), "relay-needs-roster-and-policy");
  rejects(() => openRelay({ policy: files.policy, ownerPublicKey: keys.owner.publicKeyHex, now: T0 }), "relay-needs-roster-and-policy");
  rejects(() => openRelay({ ...files, now: T0 }), "roster-owner-key-unpinned");
  rejects(() => openRelay({ ...files, ownerPublicKey: "ab", now: T0 }), "roster-owner-key-unpinned");
  const db = start(keys, files);
  assert.deepEqual(securityLog(db), ["roster.loaded", "policy.loaded"]);
  assert.equal(db.prepare("SELECT count(*) n FROM fleet_principals WHERE status = 'active'").get().n, IDS.length);
});

test("a bad signature, a tampered file or a roster that names a different owner is refused", () => {
  const keys = mintAll(), files = fixtureFiles(keys);
  rejects(() => start(keys, { ...files, roster: resign(keys["seat-1"], files.roster.body) }), "roster-signature");
  rejects(() => start(keys, { ...files, policy: resign(keys["seat-1"], files.policy.body) }), "policy-signature");
  rejects(() => start(keys, { ...files, roster: { body: { ...files.roster.body, issued_at: T0 + 1 }, sig: files.roster.sig } }), "roster-signature");
  // Pinning some other key does not help: the signature is checked against the pin.
  const stranger = mint();
  rejects(() => start(keys, files, ":memory:", stranger.publicKeyHex), "roster-signature");
  // A file signed by the pinned key whose owner entry is a different key: the file cannot vouch for itself.
  rejects(() => start(keys, { roster: resign(stranger, files.roster.body), policy: resign(stranger, files.policy.body) }, ":memory:", stranger.publicKeyHex), "roster-owner-mismatch");
  const twoOwners = { ...files.roster.body, principals: files.roster.body.principals.map(p => p.principal_id === "scope" ? { ...p, kind: "owner" } : p) };
  rejects(() => start(keys, { ...files, roster: resign(keys.owner, twoOwners) }), "roster-owner-mismatch");
});

test("roster entries are closed: unknown fields, duplicate keys and agents not bound to their key are refused", () => {
  const keys = mintAll(), files = fixtureFiles(keys);
  const edit = (fn) => resign(keys.owner, { ...files.roster.body, principals: fn(files.roster.body.principals.map(p => ({ ...p }))) });
  const cases = [
    [list => { list[0].extra = 1; return list; }, "roster-invalid"],
    [list => { list[1].public_key = list[0].public_key; list[1].agent = list[0].agent; return list; }, "roster-invalid"],
    [list => { [list[0].agent, list[1].agent] = [list[1].agent, list[0].agent]; return list; }, "roster-invalid"],
    [list => { list[0].kind = "member"; return list; }, "roster-invalid"],
    [list => { list[0].runtime_family = "Anthropic"; return list; }, "roster-invalid"],
    [list => [...list, { ...list[0] }], "roster-invalid"],
  ];
  for (const [fn, code] of cases) rejects(() => start(keys, { ...files, roster: edit(fn) }), code);
  rejects(() => start(keys, { ...files, roster: resign(keys.owner, { ...files.roster.body, note: "x" }) }), "roster-invalid");
});

test("versions only move forward; a version cannot be reused; a restart with the same files is a no-op", () => {
  const keys = mintAll(), { path } = scratch();
  const v1 = fixtureFiles(keys);
  start(keys, v1, path).close();
  const db = start(keys, v1, path);
  assert.deepEqual(securityLog(db), ["roster.loaded", "policy.loaded"], "the restart loaded nothing new");
  db.close();
  const reused = fixtureFiles(keys);
  reused.roster = resign(keys.owner, { ...reused.roster.body, issued_at: T0 + 1 });
  rejects(() => start(keys, reused, path), "roster-version-reused");
  const v2 = fixtureFiles(keys, { rosterVersion: 2, policyVersion: 2 });
  start(keys, v2, path).close();
  rejects(() => start(keys, v1, path), "roster-version-rollback");
  rejects(() => start(keys, { roster: v2.roster, policy: v1.policy }, path), "policy-version-rollback");
  const after = start(keys, v2, path);
  assert.deepEqual(securityLog(after), ["roster.loaded", "policy.loaded", "roster.loaded", "policy.loaded"]);
});

test("a newer roster retires an absent principal: its key is revoked, its records are refused, and it cannot return", () => {
  const keys = mintAll(), { path } = scratch();
  const all = fixtureFiles(keys).roster.body.principals;
  const db = start(keys, fixtureFiles(keys), path);
  seedMember({ db, keys, members: {} }, "A", T0);
  const without7 = fixtureFiles(keys, { rosterVersion: 2, principals: all.filter(p => p.principal_id !== "seat-7") });
  loadRoster(db, without7.roster, { ownerPublicKey: keys.owner.publicKeyHex, now: T0 + HOUR });
  assert.deepEqual(fleet(db, "seat-7"), { status: "retired", key_status: "revoked" });
  const fx = { db, keys };
  rejects(() => createDecision(db, decision(fx, "seat-7", { cls: "D0", action: "task.open", subject: "t1", args: taskArgs() }), T0 + HOUR), "unauthorized");
  const back = fixtureFiles(keys, { rosterVersion: 3, principals: all });
  rejects(() => loadRoster(db, back.roster, { ownerPublicKey: keys.owner.publicKeyHex, now: T0 + HOUR }), "roster-retired-principal");
  // Re-adding the seat under a new key is a different principal binding: still refused (one key ever).
  const fresh = mint();
  const rekeyed = all.map(p => p.principal_id === "seat-7" ? { ...p, public_key: fresh.publicKeyHex, agent: fresh.uuaid } : p);
  rejects(() => loadRoster(db, fixtureFiles(keys, { rosterVersion: 3, principals: rekeyed }).roster, { ownerPublicKey: keys.owner.publicKeyHex, now: T0 + HOUR }), "roster-retired-principal");
});

test("an existing principal's kind, family and key never change by roster", () => {
  const keys = mintAll(), db = start(keys, fixtureFiles(keys));
  const all = fixtureFiles(keys).roster.body.principals;
  const fresh = mint();
  const changes = [
    { runtime_family: "openai" },
    { kind: "verifier" },
    { public_key: fresh.publicKeyHex, agent: fresh.uuaid },
  ];
  for (const change of changes) {
    const list = all.map(p => p.principal_id === "seat-6" ? { ...p, ...change } : p);
    rejects(() => loadRoster(db, fixtureFiles(keys, { rosterVersion: 2, principals: list }).roster, { ownerPublicKey: keys.owner.publicKeyHex, now: T0 }), "roster-binding-changed");
  }
  assert.equal(db.prepare("SELECT runtime_family FROM fleet_principals WHERE principal_id = 'seat-6'").get().runtime_family, "qwen", "the refused loads changed nothing");
});

test("the policy names the lane owner, who must be an active AC seat", () => {
  const keys = mintAll(), db = start(keys, fixtureFiles(keys));
  const fx = { db, keys };
  const pin = { ownerPublicKey: keys.owner.publicKeyHex, now: T0 };
  rejects(() => loadPolicy(db, fixtureFiles(keys, { policyVersion: 2, lanes: [{ lane: LANE, owner_seat: "verifier" }] }).policy, pin), "policy-invalid");
  rejects(() => loadPolicy(db, fixtureFiles(keys, { policyVersion: 2, lanes: [{ lane: LANE, owner_seat: "nobody" }] }).policy, pin), "policy-invalid");
  rejects(() => loadPolicy(db, fixtureFiles(keys, { policyVersion: 2, security_paths: [] }).policy, pin), "policy-invalid");
  loadPolicy(db, fixtureFiles(keys, { policyVersion: 2, lanes: [{ lane: LANE, owner_seat: "seat-2" }] }).policy, pin);
  rejects(() => createDecision(db, decision(fx, "seat-1", { cls: "D0", action: "task.open", subject: "t1", args: taskArgs() }), T0), "not the lane owner");
  assert.equal(createDecision(db, decision(fx, "seat-2", { cls: "D0", action: "task.open", subject: "t1", args: taskArgs() }), T0).state, "effective");
});

test("the policy's security path list decides which D1 accepts need security.approve", () => {
  const keys = mintAll();
  const db = start(keys, fixtureFiles(keys, { security_paths: ["docs/secret/"] }));
  const fx = trackMeasurer({ db, keys, members: {} });   // D1 families come from the measurer stand-in
  const A = seedMember(fx, "A", T0);
  handleMemberRecord(db, A, { type: "heartbeat", record_id: "hb", body: {} }, T0);
  createDecision(db, decision(fx, "seat-1", { cls: "D0", action: "role.c1", subject: A }), T0);
  const accept = (task, path) => {
    createDecision(db, decision(fx, "seat-1", { cls: "D0", action: "task.open", subject: task, args: taskArgs(["docs/", "packages/"]) }), T0);
    const c = handleMemberRecord(db, A, { type: "claim", record_id: `c-${task}`, body: { task_id: task, lease_ms: HOUR } }, T0);
    const r = handleMemberRecord(db, A, { type: "result", record_id: `r-${task}`, body: { claim_id: c.claim_id, epoch: c.epoch, kind: "patch", body: PATCH(path) } }, T0);
    const d = createDecision(db, decision(fx, "seat-1", { cls: "D1", action: "accept", subject: r.submission_id }), T0);
    addVerdict(db, approval(fx, "seat-2", d.id), T0);
    recordVerifyResult(db, verifyResult(fx, { submission_id: r.submission_id, patch_sha256: r.body_sha256 }), T0);
    return { d, r, state: () => db.prepare("SELECT state FROM decisions WHERE id = ?").get(d.id).state };
  };
  const secret = accept("t1", "docs/secret/keys.md");
  assert.equal(secret.state(), "pending", "a path on the policy list waits for security.approve");
  recordSecurityApproval(db, securityApproval(fx, { submission_id: secret.r.submission_id, patch_sha256: secret.r.body_sha256 }), T0);
  assert.equal(secret.state(), "effective");
  // The built-in default list is not consulted once a policy is loaded.
  assert.equal(accept("t2", "packages/agent-commons/src/relay/notes.md").state(), "effective");
});
