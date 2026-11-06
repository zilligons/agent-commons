// N38 (spec v3.3 section 9.8, -022 Addendum C5): runtime-family evidence. A seat's
// signed "measured:<family>" is its own assertion and earns no family credit alone;
// credit needs the owner-assigned measurer's served_by.attest of exactly that verdict.
// These tests call governance directly (no measurer stand-in) and attest by hand.
// Scratch databases, fixture keys; the measurer is a fixture key (O13).

import test from "node:test";
import assert from "node:assert/strict";
import * as G from "../src/relay/governance.mjs";
import { handleMemberRecord } from "../src/relay/board.mjs";
import { loadPolicy } from "../src/relay/roster.mjs";
import { signBody } from "../src/relay/signing.mjs";
import { setup, decision, approval, attestation, verifyResult, ownerConfirm, outboxFor, fixtureFiles, taskArgs, PATCH, promoteC1, laneD0,
  eligibleForC2, rejects, FAMILY_MAP, T0, MIN, HOUR, DAY } from "./relay-fixtures.mjs";

const stateOf = (fx, id) => fx.db.prepare("SELECT state FROM decisions WHERE id = ?").get(id).state;
const attest = (fx, fields, by = "measurer") => G.recordAttestation(fx.db, attestation(fx.db, fx.keys[by], by, fields), fields.at ?? T0);
const alerts = (fx, kind) => fx.db.prepare("SELECT subject, detail FROM alerts WHERE kind = ?").all(kind).map(r => ({ subject: r.subject, ...JSON.parse(r.detail) }));

/** A verified D1 accept proposed by seat-1 (anthropic) and approved by seat-2 (openai), with NO attestations. */
function d1(fx) {
  const A = promoteC1(fx, "A");
  laneD0(fx, "task.open", "t1", taskArgs(["docs"]));
  const c = handleMemberRecord(fx.db, A, { type: "claim", record_id: "c", body: { task_id: "t1", lease_ms: HOUR } }, T0);
  const r = handleMemberRecord(fx.db, A, { type: "result", record_id: "r", body: { claim_id: c.claim_id, epoch: 1, kind: "patch", body: PATCH() } }, T0);
  const d = G.createDecision(fx.db, decision(fx, "seat-1", { cls: "D1", action: "accept", subject: r.submission_id }), T0);
  G.addVerdict(fx.db, approval(fx, "seat-2", d.id), T0);
  G.recordVerifyResult(fx.db, verifyResult(fx, { submission_id: r.submission_id, patch_sha256: r.body_sha256 }), T0);
  return d;
}

test("N38: a measured: label alone earns no family; a valid attestation of each verdict earns it", () => {
  const fx = setup({ members: ["A"] });
  const d = d1(fx);
  assert.equal(stateOf(fx, d.id), "pending", "two seats asserting two families, nothing attested");
  assert.deepEqual(G.quorum(fx.db, d.id).families, []);
  assert.deepEqual(G.quorum(fx.db, d.id).uncredited.sort(), ["seat-1", "seat-2"]);
  // The creator's implicit approve is the decision body (seq 1); its attestation targets that body's hash.
  const first = attest(fx, { decision_id: d.id, by: "seat-1", seq: 1, family: "anthropic" });
  assert.deepEqual([first.credited, first.state], [true, "pending"]);
  assert.equal(attest(fx, { decision_id: d.id, by: "seat-2", seq: 1, family: "openai" }).state, "effective");
  assert.deepEqual(G.quorum(fx.db, d.id).families.sort(), ["anthropic", "openai"]);
  rejects(() => attest(fx, { decision_id: d.id, by: "seat-2", seq: 1, family: "openai" }), "duplicate-attestation");
});

test("N38 rules 1-4: a non-measurer, a wrong body hash, a mixed turn or an unmapped model is refused", () => {
  const fx = setup({ members: ["A"] });
  const d = d1(fx);
  const target = { decision_id: d.id, by: "seat-2", seq: 1 };
  // Rule 1: only the owner-assigned measurer attests (permission, then the 9.3 trigger).
  for (const who of ["seat-3", "security", "owner"]) rejects(() => attest(fx, { ...target, family: "openai" }, who), "forbidden");
  const sha = fx.db.prepare("SELECT body_sha256 FROM approvals WHERE decision_id = ? AND approver = 'seat-2' AND seq = 1").get(d.id).body_sha256;
  const direct = (measurer) => fx.db.prepare(`INSERT INTO served_by_attestations(id, decision_id, target_by, target_seq, measurer, session_id, record_uuid,
      response_model, turn_models, family, body_sha256, tool, tool_sha256, measured_at, policy_version, recorded_at, body, sig)
    VALUES (?, ?, 'seat-2', 1, ?, 's', 'r', 'gpt-5.5', '["gpt-5.5"]', 'openai', ?, 'model-of', ?, 0, 1, 0, '{}', 'x')`).run(`direct-${measurer}`, d.id, measurer, sha, "e".repeat(64));
  rejects(() => direct("verifier"), "attest-not-measurer");
  // Rule 2: the body hash must be the target verdict's.
  rejects(() => attest(fx, { ...target, family: "openai", body_sha256: "a".repeat(64) }), "attest-body-mismatch");
  rejects(() => attest(fx, { decision_id: d.id, by: "seat-2", seq: 2, family: "openai" }), "no such verdict");
  // Rule 3: every model of the turn maps to the response model's family, and the response model is one of them.
  rejects(() => attest(fx, { ...target, family: "openai", turn_models: ["gpt-5.5", "claude-opus-5-5"] }), "attest-mixed-turn");
  rejects(() => attest(fx, { ...target, family: "openai", turn_models: ["gpt-4.1"] }), "attest-mixed-turn");
  // Rule 4: the family is the signed policy's map of the response model; unknown names earn nothing.
  rejects(() => attest(fx, { ...target, family: "anthropic", response_model: "gpt-5.5" }), "attest-family-map");
  // D9.3: a model matching no pattern (or several) earns no credit and raises served_by.mismatch; nothing is stored.
  for (const model of ["mystery-1", "<synthetic>", "GPT-5"])
    assert.deepEqual(attest(fx, { ...target, family: "openai", response_model: model }), { id: null, credited: false, refused: "attest-family-map", state: "pending" }, model);
  assert.deepEqual(alerts(fx, "served_by.mismatch").map(a => [a.response_model, a.map_matches]), [["mystery-1", 0], ["<synthetic>", 0], ["GPT-5", 0]]);
  assert.equal(fx.db.prepare("SELECT count(*) n FROM served_by_attestations").get().n, 0, "nothing refused was stored");
  assert.equal(stateOf(fx, d.id), "pending");
});

test("N38 rule 5: an attested family other than the asserted one earns nothing and raises served_by.mismatch", () => {
  const fx = setup({ members: ["A"] });
  const d = d1(fx);
  attest(fx, { decision_id: d.id, by: "seat-1", seq: 1, family: "anthropic" });
  // seat-2 asserted measured:openai, but its turn was served by a claude model.
  const r = attest(fx, { decision_id: d.id, by: "seat-2", seq: 1, family: "anthropic" });
  assert.deepEqual([r.credited, r.state], [false, "pending"]);
  assert.deepEqual(alerts(fx, "served_by.mismatch"), [{ subject: "seat-2", decision: d.id, seq: 1, asserted: "openai", attested: "anthropic" }]);
  assert.ok(fx.db.prepare("SELECT event FROM logs WHERE log = 'security'").all().some(l => JSON.parse(l.event).kind === "served_by.mismatch"));
  assert.deepEqual(G.quorum(fx.db, d.id).families, ["anthropic"]);
});

test("N38: the measurer never votes; credit belongs to exactly the attested verdict position", () => {
  const fx = setup({ members: ["A"] });
  const A = promoteC1(fx, "A");
  // A D2 whose third approval is re-filed after a withdrawal: the old attestation does not carry over.
  eligibleForC2(fx, "A");
  const now = T0 + 3 * DAY;
  const d2 = G.createDecision(fx.db, decision(fx, "seat-1", { cls: "D2", action: "role.change", subject: A, sponsor: "seat-1", args: { role: "C2" }, at: now }), now);
  rejects(() => G.addVerdict(fx.db, approval(fx, "measurer", d2.id, "approve", now), now), "forbidden");
  const raw = { v: G.APPROVAL_V, decision_id: d2.id, verdict: "approve", seq: 1, prev: null, by: "measurer", served_by: "x", at: now };
  rejects(() => fx.db.prepare(`INSERT INTO approvals(decision_id, approver, seq, prev, verdict, approver_kind, approver_family, served_by, signed_at, body, body_sha256, sig)
    VALUES (?, 'measurer', 1, NULL, 'approve', 'measurer', NULL, 'x', 0, ?, ?, ?)`).run(d2.id, JSON.stringify(raw), "f".repeat(64), signBody(fx.keys.measurer, raw)), "approver-not-ac-seat");
  for (const [seat, family] of [["seat-2", "openai"], ["seat-4", "google"], ["seat-5", "deepseek"]]) {
    G.addVerdict(fx.db, approval(fx, seat, d2.id, "approve", now), now);
    attest(fx, { decision_id: d2.id, by: seat, seq: 1, family, at: now });
  }
  G.addVerdict(fx.db, approval(fx, "seat-4", d2.id, "withdraw", now), now);
  G.addVerdict(fx.db, approval(fx, "seat-5", d2.id, "withdraw", now), now);
  G.addVerdict(fx.db, approval(fx, "seat-4", d2.id, "approve", now), now);   // seq 3, unattested
  G.addVerdict(fx.db, approval(fx, "seat-5", d2.id, "approve", now), now);   // seq 3, unattested
  G.confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-6", outboxFor(fx.db, d2.id), now), now);
  G.settleAll(fx.db, now + DAY);
  assert.equal(stateOf(fx, d2.id), "pending", "three approvals, one credited family");
  attest(fx, { decision_id: d2.id, by: "seat-4", seq: 3, family: "google", at: now + DAY });
  assert.equal(stateOf(fx, d2.id), "effective", "the re-filed approval earns credit once it is attested");
});

test("N38: attestations are refused while frozen, and the newest signed policy's family map governs (exactly one pattern must match)", () => {
  const fx = setup({ members: ["A"] });
  const d = d1(fx);
  G.createDecision(fx.db, decision(fx, "owner", { cls: "OWNER", action: "freeze", subject: "relay" }), T0);
  rejects(() => attest(fx, { decision_id: d.id, by: "seat-1", seq: 1, family: "anthropic" }), "frozen");
  G.createDecision(fx.db, decision(fx, "owner", { cls: "OWNER", action: "unfreeze", subject: "relay" }), T0 + MIN);
  // Policy v2 drops the claude-* pattern: a claude-served turn now maps to nothing.
  const v2 = fixtureFiles(fx.keys, { policyVersion: 2, family_map: FAMILY_MAP.filter(e => e.pattern !== "claude-*") });
  loadPolicy(fx.db, v2.policy, { ownerPublicKey: fx.keys.owner.publicKeyHex, now: T0 + MIN });
  assert.equal(attest(fx, { decision_id: d.id, by: "seat-1", seq: 1, family: "anthropic", at: T0 + MIN }).refused, "attest-family-map");
  assert.equal(attest(fx, { decision_id: d.id, by: "seat-2", seq: 1, family: "openai", at: T0 + MIN }).credited, true);
  assert.equal(fx.db.prepare("SELECT policy_version FROM served_by_attestations").get().policy_version, 2);
  rejects(() => loadPolicy(fx.db, fixtureFiles(fx.keys, { policyVersion: 3, family_map: [{ pattern: "*", family: "any" }] }).policy,
    { ownerPublicKey: fx.keys.owner.publicKeyHex, now: T0 + MIN }), "policy-invalid");
});

test("D9.3: a model that matches SEVERAL patterns of the current policy earns no credit and raises served_by.mismatch", () => {
  const fx = setup({ members: ["A"] });
  const d = d1(fx);
  // Policy v2 adds an overlapping pattern: gpt-5.5 now matches both gpt-* and gpt-5*.
  const v2 = fixtureFiles(fx.keys, { policyVersion: 2, family_map: [...FAMILY_MAP, { pattern: "gpt-5*", family: "openai" }] });
  loadPolicy(fx.db, v2.policy, { ownerPublicKey: fx.keys.owner.publicKeyHex, now: T0 + MIN });
  const r = attest(fx, { decision_id: d.id, by: "seat-2", seq: 1, family: "openai", at: T0 + MIN });
  assert.deepEqual([r.id, r.credited, r.refused], [null, false, "attest-family-map"]);
  assert.deepEqual(alerts(fx, "served_by.mismatch").map(a => [a.response_model, a.map_matches]), [["gpt-5.5", 2]]);
  assert.equal(attest(fx, { decision_id: d.id, by: "seat-1", seq: 1, family: "anthropic", at: T0 + MIN }).credited, true, "a single match still earns credit");
});
