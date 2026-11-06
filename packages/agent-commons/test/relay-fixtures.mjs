// Shared fixtures for the relay L0 tests. Scratch databases in a fresh temp
// directory, keys minted per test (never written to disk), provider requests
// disabled. Fleet principals are fixtures under one controller (the test).
// Members are seeded through the real seat decisions and the real enrollment-flow request side
// (src/relay/enroll.mjs, L1 item 4), at relay time, with the L1 test audience.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Keychain, jcs } from "../src/pillar.mjs";
import { signBody, sha256Hex, verdictPrev, appendLog } from "../src/relay/signing.mjs";
import * as G from "../src/relay/governance.mjs";
import { DECISION_V, APPROVAL_V, VERIFY_V, SECURITY_V, OWNER_CONFIRM_V, COAUTHOR_V, SEAT_MESSAGE_V, FINDING_OPEN_V, FINDING_CLOSE_V, ATTEST_V,
  ownerLineSha, DEFAULT_SECURITY_PATHS, openSuspensionInTx, measuredFamily, isFrozen } from "../src/relay/governance.mjs";
import { tx } from "../src/relay/schema.mjs";
import { handleMemberRecord } from "../src/relay/board.mjs";
import { openRelay, ROSTER_V, POLICY_V } from "../src/relay/roster.mjs";
import * as E from "../src/relay/enroll.mjs";
import { signEnrollmentRequest } from "../src/relay/enroll.mjs";
import { RELAY_TEST_AUD } from "../src/relay/auth.mjs";

process.env.AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED = "0";

export const SERVED_BY = "unmeasured: fixture test runner, no model";
export const T0 = 1_800_000_000_000;
export const MIN = 60000, HOUR = 3600000, DAY = 86400000;
export const BASE = "6d831a7ed37f9a6d804247ddb69b5fc47eb6efc9";
export const LANE = "relay-core";

// Seven AC seats with fixture roster families. Since Addendum C5 a roster family is a label
// only; credit comes from a measurer's attestation (9.8), which autoAttest below stands in for.
const SEATS = [["seat-1", "anthropic"], ["seat-2", "openai"], ["seat-3", "anthropic"], ["seat-4", "google"],
  ["seat-5", "deepseek"], ["seat-6", "qwen"], ["seat-7", "moonshot"]];
const OTHERS = [["verifier", "verifier"], ["security", "security"], ["scope", "scope"], ["owner", "owner"], ["measurer", "measurer"]];

// C5 (9.8): the policy's model -> family map (the examples Addendum C5 lists) and, for the
// measurer stand-in, one response model per fixture family.
export const FAMILY_MAP = [
  ["claude-*", "anthropic"], ["gpt-*", "openai"], ["gemini-*", "google"], ["deepseek-*", "deepseek"], ["qwen*", "qwen"],
  ["k3", "moonshot"], ["kimi*", "moonshot"], ["MiniMax-*", "minimax"], ["glm-*", "zhipu"], ["grok-*", "xai"],
].map(([pattern, family]) => ({ pattern, family }));
export const MODEL_OF = { anthropic: "claude-opus-5-5", openai: "gpt-5.5", google: "gemini-3-pro", deepseek: "deepseek-v4", qwen: "qwen3-max", moonshot: "kimi-k3" };
export const MODEL_OF_SHA = "e".repeat(64);   // fixture stand-in for model-of's sha256

export const mint = () => Keychain.generate({ uuaidNamespace: "agentnet" });
export const keySeedHex = (identity) => {
  const der = identity.privateKey.export({ format: "der", type: "pkcs8" });
  return Buffer.from(der.subarray(der.length - 32)).toString("hex");
};

export function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "relay-l0-"));
  return { dir, path: join(dir, "relay-test.db") };
}

// A3: each fixture seat's turns are "measured" as its family; the other principals are unmeasured.
export const FAMILY = Object.fromEntries(SEATS);
export const servedBy = (by) => (FAMILY[by] ? `measured:${FAMILY[by]}:fixture-model` : SERVED_BY);

/** The owner-signed fixture roster and policy (9.1, 13.2 "fixture roster"). */
export function fixtureFiles(keys, { rosterVersion = 1, policyVersion = 1, principals, lanes = [{ lane: LANE, owner_seat: "seat-1" }], security_paths = [...DEFAULT_SECURITY_PATHS],
  family_map = FAMILY_MAP } = {}) {
  const list = principals ?? [...SEATS.map(([id, f]) => [id, "ac-seat", f]), ...OTHERS.map(([id, kind]) => [id, kind, null])]
    .map(([principal_id, kind, runtime_family]) => ({ principal_id, kind, runtime_family, public_key: keys[principal_id].publicKeyHex, agent: keys[principal_id].uuaid }));
  const roster = { v: ROSTER_V, version: rosterVersion, issued_at: T0, principals: list };
  const policy = { v: POLICY_V, version: policyVersion, issued_at: T0, lanes, security_paths, family_map };
  return { roster: { body: roster, sig: signBody(keys.owner, roster) }, policy: { body: policy, sig: signBody(keys.owner, policy) } };
}

/** Start a fresh relay from the signed fixture roster and policy, with the named members. */
export function setup({ path = ":memory:", members = ["A", "B"] } = {}) {
  const keys = {};
  for (const [id] of [...SEATS, ...OTHERS]) keys[id] = mint();
  const files = fixtureFiles(keys);
  const db = openRelay({ path, ...files, ownerPublicKey: keys.owner.publicKeyHex, now: T0 });
  MEASURERS.set(keys.measurer.publicKeyHex, keys.measurer);
  const fx = { db, keys, members: {}, path, files };
  for (const name of members) seedMember(fx, name, T0);
  return fx;
}

/**
 * Enrollment-flow request through the REAL request side (src/relay/enroll.mjs; -022 Addendum C4:
 * no longer test-only). Mints the agent's new key, signs the 5.2 body (re-key also with the member's
 * current key), and applies it at relay time `at` with the L1 test audience. Returns the pending
 * enrollment and its owner-record outbox row.
 */
export function applyEnrollmentRequest(fx, { invite, name = "x", at = T0, displayName = `member ${name}`, platform = "fixture" }) {
  const { db } = fx;
  fx.identities ??= new Map();
  const identity = mint();
  fx.identities.set(identity.publicKeyHex, identity);
  let oldSeedHex;
  if (invite.kind === "rekey") {
    const active = db.prepare("SELECT public_key FROM keys WHERE principal_kind = 'member' AND principal_id = ? AND status = 'active'").get(invite.member_id);
    const old = active && fx.identities.get(active.public_key);
    if (!old) throw new Error(`fixture: no identity for ${invite.member_id}'s active key`);
    oldSeedHex = keySeedHex(old);
  }
  const { body } = signEnrollmentRequest({ invite: { relay: { origin: RELAY_TEST_AUD }, ...invite }, seedHex: keySeedHex(identity), oldSeedHex,
    displayName, platform, created: new Date(at).toISOString() });
  const r = E.applyEnrollmentRequest(db, invite.kind, body, { aud: RELAY_TEST_AUD, now: at, sourceIp: "127.0.0.1" });
  return { memberId: r.member_id, identity, enrollment: r.enrollment_id, outbox: outboxFor(db, r.enrollment_id) };
}

/** A real invite.create by `by` (default: the lane owner); returns its once-only invite. */
export function createInvite(fx, { kind = "enroll", member_id = null, by, at = T0, id, label = nextId("req") } = {}) {
  const creator = by ?? fx.db.prepare("SELECT owner_seat FROM lanes WHERE lane = ?").get(LANE).owner_seat;
  return G.createDecision(fx.db, decision(fx, creator, { id, cls: "D0", action: "invite.create", subject: label,
    args: { kind, member_id, intended_display_name: "fixture agent", intended_platform: "fixture" }, at }), at).invite;
}

/**
 * Enroll a member through the real seat decisions: invite.create by the lane owner (seat-1),
 * the test-only request stand-in, the enrollment's owner line confirmed by seat-3, and
 * enroll.confirm by seat-2 (not the invite creator, P1), which grants C0.
 */
export function seedMember(fx, name, at) {
  const invite = createInvite(fx, { at, id: `fx-invite-${name}`, label: `req-${name}` });
  const { memberId, identity, outbox } = applyEnrollmentRequest(fx, { invite, name, at });
  G.confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-3", outbox, at), at);
  G.createDecision(fx.db, decision(fx, "seat-2", { id: `fx-enroll-${name}`, cls: "D0", action: "enroll.confirm", subject: memberId, args: { owner_line_ref: outbox.id }, at }), at);
  fx.members[name] = { id: memberId, identity, inviteSecret: Buffer.from(invite.secret, "hex") };   // the secret is a custody canary (N22)
  return memberId;
}

/**
 * A re-bind through the real seat decision: invite.create of kind rebind (which suspends the
 * member, C4), then the test-only request stand-in. Confirmation is the real D1R path.
 */
export function seedRebind(fx, name, { at = T0 } = {}) {
  const invite = createInvite(fx, { kind: "rebind", member_id: fx.members[name].id, at });
  const r = applyEnrollmentRequest(fx, { invite, name, at });
  return { enrollment: r.enrollment, invite: invite.invite_id, identity: r.identity };
}

// v3.3.2 (9.3): a signed record's body.at must lie within the 6.1 window of the relay's
// acceptance time. Fixture builders sign at a default time; a fixture-built record submitted
// outside that window is re-signed at the submission time with the same fixture key, as a seat
// signs when it sends. Bodies a test builds or edits by hand are never re-signed.
const FIXTURE_KEYS = new WeakMap();   // fixture-signed record -> the key that signed it
const signed = (fx, by, body) => { const r = { body, sig: signBody(fx.keys[by], body) }; FIXTURE_KEYS.set(r, fx.keys[by]); return r; };
export function atSubmission(rec, now) {
  const key = FIXTURE_KEYS.get(rec);
  if (!key || !Number.isSafeInteger(now) || (rec.body.at >= now - G.RECORD_WINDOW.back_ms && rec.body.at <= now + G.RECORD_WINDOW.ahead_ms)) return rec;
  const body = { ...rec.body, at: now };
  const out = { body, sig: signBody(key, body) };
  FIXTURE_KEYS.set(out, key);
  return out;
}
let counter = 0;
const nextId = (prefix) => `${prefix}-${++counter}`;

export const decision = (fx, by, { id = nextId("d"), cls, action, subject, lane = ["SUSPEND", "OWNER", "D1R"].includes(cls) ? undefined : LANE, args, sponsor, at = T0, served_by = servedBy(by) }) =>
  signed(fx, by, Object.fromEntries(Object.entries({ v: DECISION_V, id, class: cls, action, subject, lane, sponsor, args, by, served_by, at })
    .filter(([, v]) => v !== undefined)));
/** The signer's next position on a decision, as a seat computes it before signing: { seq, prev }. */
export function verdictPosition(db, decisionId, by) {
  const last = db.prepare("SELECT seq, body FROM approvals WHERE decision_id = ? AND approver = ? ORDER BY seq DESC LIMIT 1").get(decisionId, by);
  return { seq: (last?.seq ?? 0) + 1, prev: last ? verdictPrev(last.body) : null };
}
/** A signed verdict at the signer's current next position (override with `position` to sign a specific one). */
export const approval = (fx, by, decisionId, verdict = "approve", at = T0, served_by = servedBy(by), position = verdictPosition(fx.db, decisionId, by)) =>
  signed(fx, by, { v: APPROVAL_V, decision_id: decisionId, verdict, seq: position.seq, prev: position.prev, by, served_by, at });
export const findingOpen = (fx, { id = nextId("f"), member_id, summary = "credential reuse suspected", by = "security", at = T0 }) =>
  signed(fx, by, { v: FINDING_OPEN_V, id, member_id, summary, by, served_by: servedBy(by), at });
export const findingClose = (fx, { finding_id, resolution = "resolved after review", by = "security", at = T0 }) =>
  signed(fx, by, { v: FINDING_CLOSE_V, finding_id, resolution, by, served_by: servedBy(by), at });
export const verifyResult = (fx, { submission_id, patch_sha256, base_commit = BASE, exit_codes = [0, 0], network = "none", at = T0 }) =>
  signed(fx, "verifier", { v: VERIFY_V, submission_id, base_commit, patch_sha256, image_digest: "sha256:" + "a".repeat(64), network,
    checks: ["npm test", "node --test test/relay-*.test.mjs"].slice(0, exit_codes.length), exit_codes, log_sha256: "b".repeat(64), by: "verifier", served_by: servedBy("verifier"), at });
export const securityApproval = (fx, { submission_id, patch_sha256, at = T0 }) =>
  signed(fx, "security", { v: SECURITY_V, submission_id, patch_sha256, by: "security", served_by: servedBy("security"), at });
export const coauthor = (fx, by, submission_id, at = T0) =>
  signed(fx, by, { v: COAUTHOR_V, submission_id, by, served_by: servedBy(by), at });
export const ownerConfirm = (fx, by, row, at = T0) =>
  signed(fx, by, { v: OWNER_CONFIRM_V, outbox_id: row.id, line_sha256: row.line_sha256, by, served_by: servedBy(by), at });
export const clockResume = (fx, by = "seat-1", at = T0) => decision(fx, by, { cls: "D0", action: "clock.resume", subject: "relay-clock", at });
export const seatMessage = (fx, by, memberId, text, record_id = nextId("sm"), at = T0) =>
  signed(fx, by, { v: SEAT_MESSAGE_V, record_id, member_id: memberId, lane: LANE, text, by, served_by: servedBy(by), at });

export const taskArgs = (paths = ["docs/"]) => ({
  title: "Document the relay reconnect procedure", description: "Write the member-side reconnect steps.",
  kind: "work", paths, base_commit: BASE, acceptance: { criteria: "Steps match section 11.5.", required_checks: ["npm test"] },
});

export const PATCH = (path = "docs/relay.md") => [{ path, diff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n` }];

export const outboxFor = (db, subject) => db.prepare("SELECT * FROM owner_record_outbox WHERE subject = ?").get(subject);

/** A D0 by the lane owner (seat-1 unless named). */
export const laneD0 = (fx, action, subject, args, by = "seat-1", at = T0) =>
  createDecision(fx.db, decision(fx, by, { cls: "D0", action, subject, args, at }), at);

/** Make a seeded member active on the board (first heartbeat) and promote it to C1. */
export function promoteC1(fx, name, at = T0) {
  const id = fx.members[name].id;
  handleMemberRecord(fx.db, id, { type: "heartbeat", record_id: `hb-${name}-${at}`, body: {} }, at);
  laneD0(fx, "role.c1", id, undefined, "seat-1", at);
  return id;
}

/** Three accepted submissions on three days: the 10 C2 eligibility a D2 role.change needs. */
export function eligibleForC2(fx, name) {
  const id = fx.members[name].id;
  for (let i = 0; i < 3; i++) {
    const at = T0 + i * DAY, t = `c2-${name}-${i}`;
    laneD0(fx, "task.open", t, taskArgs(["docs"]), "seat-1", at);
    const c = handleMemberRecord(fx.db, id, { type: "claim", record_id: `${t}-c`, body: { task_id: t, lease_ms: HOUR } }, at);
    const r = handleMemberRecord(fx.db, id, { type: "result", record_id: `${t}-r`, body: { claim_id: c.claim_id, epoch: c.epoch, kind: "report", body: "ok" } }, at);
    const d = createDecision(fx.db, decision(fx, "seat-1", { cls: "D1", action: "accept", subject: r.submission_id, at }), at);
    addVerdict(fx.db, approval(fx, "seat-2", d.id, "approve", at), at);
  }
}

// --- C5 measurer stand-in (test only) ----------------------------------------------
// Seat-side tooling (model-of over the seat's transcript) is outside the relay (9.8, M14).
// In tests the measurer is a fixture key; this stand-in attests a verdict whose served_by
// asserts measured:<family> as served by that family's model, so fixture seats earn the
// family they claim. Tests of C5 itself call governance directly and attest by hand.

const MEASURERS = new Map();   // measurer public key -> fixture identity (survives reopening a scratch file)
export function trackMeasurer(fx) { MEASURERS.set(fx.keys.measurer.publicKeyHex, fx.keys.measurer); return fx; }
const activeMeasurer = (db) => db.prepare(`SELECT f.principal_id, k.public_key FROM fleet_principals f
  JOIN keys k ON k.principal_kind = 'fleet' AND k.principal_id = f.principal_id WHERE f.kind = 'measurer' AND f.status = 'active' AND k.status = 'active'`).get();

/** A measurer's signed served_by.attest of verdict (decisionId, by, seq); fields may be overridden. */
export function attestation(db, measurerKey, measurerId, { decision_id, by, seq, family, response_model = MODEL_OF[family] ?? "unknown-model",
  turn_models = [response_model], body_sha256, session_id = "fixture-session", record_uuid = "fixture-record", at = T0 }) {
  const sha = body_sha256 ?? db.prepare("SELECT body_sha256 FROM approvals WHERE decision_id = ? AND approver = ? AND seq = ?").get(decision_id, by, seq)?.body_sha256 ?? "0".repeat(64);
  const body = { v: ATTEST_V, target: { decision_id, by, seq }, session_id, record_uuid, response_model, turn_models, family, body_sha256: sha,
    tool: "model-of", tool_sha256: MODEL_OF_SHA, measured_at: at, by: measurerId, served_by: SERVED_BY, at };
  const r = { body, sig: signBody(measurerKey, body) };
  FIXTURE_KEYS.set(r, measurerKey);
  return r;
}

/** Attest one verdict as its asserted family (no-op when it asserts none or no fixture measurer is known). */
export function autoAttest(db, decisionId, by, seq, at) {
  const m = activeMeasurer(db), key = m && MEASURERS.get(m.public_key);
  const row = db.prepare("SELECT served_by FROM approvals WHERE decision_id = ? AND approver = ? AND seq = ?").get(decisionId, by, seq);
  const family = measuredFamily(row?.served_by);
  if (!key || !family || !MODEL_OF[family] || isFrozen(db)) return null;
  return G.recordAttestation(db, attestation(db, key, m.principal_id, { decision_id: decisionId, by, seq, family, at }), at);
}
const stateNow = (db, id) => db.prepare("SELECT state FROM decisions WHERE id = ?").get(id)?.state;
const needsFamilies = (db, id) => ["D1", "D1R", "D2"].includes(db.prepare("SELECT class FROM decisions WHERE id = ?").get(id)?.class);

/** governance.createDecision, then the measurer stand-in attests the creator's implicit approve (D1, D1R). */
export function createDecision(db, rec, now) {
  const signed = atSubmission(rec, now);
  const r = G.createDecision(db, signed, now);
  if (r.state === "pending" && needsFamilies(db, r.id) && db.prepare("SELECT 1 FROM approvals WHERE decision_id = ? AND approver = ? AND seq = 1").get(r.id, signed.body.by))
    autoAttest(db, r.id, signed.body.by, 1, now);
  return { ...r, state: stateNow(db, r.id) };
}
/** governance.addVerdict, then the measurer stand-in attests an approve on a D1, D1R or D2. */
export function addVerdict(db, rec, now) {
  const signed = atSubmission(rec, now);
  const r = G.addVerdict(db, signed, now);
  if (signed.body.verdict === "approve" && r.state === "pending" && needsFamilies(db, r.decision_id)) autoAttest(db, r.decision_id, signed.body.by, r.seq, now);
  return { ...r, state: stateNow(db, r.decision_id) };
}
export const addApproval = addVerdict;
// The other signed-record entry points, with the same submission-time signing.
const atNow = (fn) => (db, rec, now) => fn(db, atSubmission(rec, now), now);
export const recordVerifyResult = atNow(G.recordVerifyResult), recordSecurityApproval = atNow(G.recordSecurityApproval),
  declareCoauthor = atNow(G.declareCoauthor), confirmOwnerRecord = atNow(G.confirmOwnerRecord), openFinding = atNow(G.openFinding),
  closeFinding = atNow(G.closeFinding), sendSeatMessage = atNow(G.sendSeatMessage), recordAttestation = atNow(G.recordAttestation);

/** Expect a RelayError (or SQLite error) whose code or message contains `code`. */
export function rejects(fn, code) {
  try { fn(); } catch (error) {
    if (error.code === code || String(error.message).includes(code)) return error;
    throw new Error(`expected ${code}, got ${error.code ?? ""} ${error.message}`);
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}
