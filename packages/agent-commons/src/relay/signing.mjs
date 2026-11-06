// Cloud Commons relay, L0: record signatures and hash-chained logs (spec v3.2
// sections 9.3 "signed records", 9.5, 9.6). Signatures are Ed25519 over JCS(body),
// verified with the vendored strict-key primitive. Logs chain each event to the
// previous hash, so an export verifies offline without trusting relay.db.

import { createHash, sign as edSign } from "node:crypto";
import { jcs, Keychain } from "../pillar.mjs";
import { assertIntegerOnly, RelayError, DECISION_V, APPROVAL_V, VERIFY_V, SECURITY_V, OWNER_CONFIRM_V, COAUTHOR_V,
  FINDING_OPEN_V, FINDING_CLOSE_V, ATTEST_V, measuredFamily } from "./records.mjs";
import { D2_WINDOW_MS } from "./schema.mjs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { verifyBytesStrict } from "./auth.mjs";

export const GENESIS = "0".repeat(64);
export const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

/** A verdict's `prev`: the sha256 of the signer's previous signed body (stored as JCS text) on the same decision. */
export const verdictPrev = (bodyText) => sha256Hex(Buffer.from(bodyText, "utf8"));

export function canonicalBytes(body) {
  assertIntegerOnly(body);
  return Buffer.from(jcs(body), "utf8");
}

/** signer: a generated identity object (has privateKey) or a loaded Keychain (has sign()). This module mints no keys. */
export function signBody(signer, body) {
  const bytes = canonicalBytes(body);
  const sig = typeof signer?.sign === "function" ? signer.sign(bytes) : edSign(null, bytes, signer.privateKey);
  return Buffer.from(sig).toString("hex");
}

export function verifyBody(publicKeyHex, body, sigHex) {
  if (typeof sigHex !== "string" || !/^[0-9a-f]{128}$/.test(sigHex)) return false;
  let bytes;
  try { bytes = canonicalBytes(body); } catch { return false; }
  return Keychain.verifyDetached(publicKeyHex, bytes, Buffer.from(sigHex, "hex"));
}

const LOG_NAMES = new Set(["decision", "board", "security", "enrollment", "mailbox"]);
/** Every hash-chained log; the relay-signed export head commits to each of them (9.3, C2). */
export const RELAY_LOGS = Object.freeze([...LOG_NAMES].sort());
const linkHash = (prev, log, seq, at, event) => sha256Hex(`${prev}\n${jcs({ log, seq, at, event })}`);

/** Append one event to a named log. Call inside the caller's transaction. */
export function appendLog(db, log, event, at) {
  if (!LOG_NAMES.has(log)) throw new RelayError("unknown-log", 500, log);
  if (!Number.isSafeInteger(at)) throw new RelayError("invalid-time", 500);
  assertIntegerOnly(event, "event");
  const last = db.prepare("SELECT seq, hash FROM logs WHERE log = ? ORDER BY seq DESC LIMIT 1").get(log);
  const seq = (last?.seq ?? 0) + 1, prev = last?.hash ?? GENESIS;
  const hash = linkHash(prev, log, seq, at, event);
  db.prepare("INSERT INTO logs(log, seq, at, event, prev, hash) VALUES (?, ?, ?, ?, ?, ?)").run(log, seq, at, jcs(event), prev, hash);
  return { log, seq, hash };
}

/** Verify log chains from exported rows; returns the first break per log. */
export function verifyLogRows(rows) {
  const byLog = new Map();
  for (const row of rows) {
    if (!byLog.has(row.log)) byLog.set(row.log, []);
    byLog.get(row.log).push(row);
  }
  const problems = [];
  for (const [log, list] of byLog) {
    list.sort((a, b) => a.seq - b.seq);
    let prev = GENESIS;
    for (let i = 0; i < list.length; i++) {
      const row = list[i];
      let event;
      try { event = JSON.parse(row.event); } catch { problems.push({ log, seq: row.seq, reason: "event-not-json" }); break; }
      if (row.seq !== i + 1) { problems.push({ log, seq: row.seq, reason: "sequence-gap" }); break; }
      if (row.prev !== prev) { problems.push({ log, seq: row.seq, reason: "prev-mismatch" }); break; }
      if (linkHash(prev, log, row.seq, row.at, event) !== row.hash) { problems.push({ log, seq: row.seq, reason: "hash-mismatch" }); break; }
      prev = row.hash;
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Everything needed to verify the decision record offline. Contains public data only. */
export function exportRelay(db) {
  const all = (sql) => db.prepare(sql).all().map(row => ({ ...row }));
  return {
    v: "commons-relay-export/4",
    epoch: db.prepare("SELECT v FROM meta WHERE k = 'epoch'").get().v,
    roster: all(`SELECT f.principal_id, f.kind, f.runtime_family, f.status, k.public_key
                    FROM fleet_principals f JOIN keys k ON k.principal_kind = 'fleet' AND k.principal_id = f.principal_id ORDER BY f.principal_id`),
    // The owner-signed roster and policy files as loaded; the verifier re-derives roster, lanes and family map from them.
    signed_files: all("SELECT * FROM signed_files ORDER BY kind, version"),
    lanes: all("SELECT * FROM lanes ORDER BY lane"),
    keys: all("SELECT * FROM keys ORDER BY added_at, public_key"),
    members: all("SELECT member_id, status, role FROM members ORDER BY member_id"),
    decisions: all("SELECT * FROM decisions ORDER BY created_at, id"),
    decision_authors: all("SELECT * FROM decision_authors ORDER BY decision_id, principal"),
    approvals: all("SELECT * FROM approvals ORDER BY signed_at, decision_id, approver, seq"),
    served_by_attestations: all("SELECT * FROM served_by_attestations ORDER BY recorded_at, id"),
    policy_family_map: all("SELECT * FROM policy_family_map ORDER BY policy_version, pattern"),
    submissions: all("SELECT * FROM submissions ORDER BY submission_id"),
    verify_results: all("SELECT * FROM verify_results ORDER BY at"),
    security_approvals: all("SELECT * FROM security_approvals ORDER BY at"),
    coauthors: all("SELECT * FROM coauthors ORDER BY at"),
    owner_record_outbox: all("SELECT * FROM owner_record_outbox ORDER BY created_at, id"),
    owner_record_confirmations: all("SELECT * FROM owner_record_confirmations ORDER BY at"),
    security_findings: all("SELECT * FROM security_findings ORDER BY opened_at, id"),
    invites: all("SELECT * FROM invites ORDER BY created_at, invite_id"),
    invite_details: all("SELECT * FROM invite_details ORDER BY invite_id"),
    enrollments: all("SELECT * FROM enrollments ORDER BY spent_at, id"),
    rebind_ends: all("SELECT * FROM rebind_ends ORDER BY at, invite_id"),
    // Derived state the reducer acts on, so the verifier can tie each row to its decision.
    roles: all("SELECT * FROM roles ORDER BY member_id, seq"),
    suspensions: all("SELECT * FROM suspensions ORDER BY started_at, id"),
    contributions: all("SELECT * FROM contributions ORDER BY accepted_at, submission_id"),
    logs: all("SELECT * FROM logs ORDER BY log, seq"),
  };
}

// The role a role-granting decision gives (the roles relationship check).
const ROLE_GRANT = { "enroll.confirm": () => "C0", "role.c1": () => "C1", "role.change": (body) => body.args?.role };
const DONE = ["effective", "reversed"];   // states a decision reaches only by taking effect
/** SQLite GLOB for the policy's family-map patterns (the policy loader admits only letters, digits, . _ - * ?). */
const globMatch = (pattern, text) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "s").test(text);
const WINDOW_BACK_MS = 300000, WINDOW_AHEAD_MS = 60000, ENROLLMENT_TTL = 259200000;   // 6.1; 5.3
const P1 = ["enroll.confirm", "rekey.confirm"];

/**
 * Offline check of an export against a roster the verifier already trusts (the owner-signed
 * roster, never the export's own copy). Spec 9.3 "Export verification": v3.3 (Addendum C2,
 * security review D-C1/D-C3a), v3.3.2 (S1-S5, E-3, settlement) and v3.4 (the D items, D-1). It trusts no
 * column it can derive from a signed body, and it checks the relationships between rows:
 * - signatures and log chains; each record's acceptance time t is its log event's time, the
 *   signer's key was valid at t (added_at <= t < revoked_at), and body.at lies in the 6.1 window of t;
 * - columns equal their signed bodies (decisions incl. lane, approvals, verify results with passed
 *   from the signed exit codes, security approvals, co-authors, owner confirmations, findings by the
 *   security principal, attestations' signed fields; relay-derived policy_version and recorded_at);
 * - verdict chains, the implicit creator approval, decision_authors from signed declarations,
 *   an owner veto behind every reversed or vetoed decision, rows <-> decision-log events both ways;
 * - settlement: each effective D1, D1R and D2 re-checked as of its decision.effective event;
 * - fleet_principals, lanes and policy_family_map re-derived from the owner-signed files;
 * - roles replayed (veto re-projections), members' role and status re-derived (no member active
 *   without an active key, D-1), suspensions, invites (invites.decision_id), enrollments,
 *   rebind_ends and contributions tied to the decisions that justify them.
 */
export function verifyExport(exp, trustedRoster, { relayPublicKey, aud } = {}) {
  const trusted = new Map(trustedRoster.map(p => [p.principal_id, p]));
  const problems = [...verifyLogRows(exp.logs).problems];
  const flag = (kind, id, reason, extra = {}) => problems.push({ kind, id, reason, ...extra });
  for (const table of ["keys", "signed_files", "lanes", "members", "invites", "rebind_ends", "suspensions", "roles"])
    if (!Array.isArray(exp[table])) flag("export", table, "missing-table");
  const parse = (kind, id, text) => {
    try { const body = JSON.parse(text); if (body && typeof body === "object" && !Array.isArray(body)) return body; } catch { /* reported below */ }
    flag(kind, id, "body-not-json");
    return null;
  };
  const kindOf = (by) => trusted.get(by)?.kind;

  // --- the hash-chained logs, as ordered event lists ----------------------------------
  const logOf = (name) => (exp.logs ?? []).filter(l => l.log === name).sort((x, y) => x.seq - y.seq)
    .map(l => { try { return { ...JSON.parse(l.event), _seq: l.seq, _at: l.at }; } catch { return null; } }).filter(Boolean);
  const events = logOf("decision"), security = logOf("security");
  const firstEvent = (list, pred) => list.find(pred) ?? null;

  const keysByPk = new Map((exp.keys ?? []).map(k => [k.public_key, k]));
  /** The signer's key was the one bound to it and valid at t (C2 key history: the window, never its current status). */
  const keyValidAt = (by, t) => {
    const k = keysByPk.get(trusted.get(by)?.public_key);
    return !!k && k.principal_kind === "fleet" && k.principal_id === by && k.added_at <= t && (k.revoked_at === null || t < k.revoked_at);
  };
  /**
   * Verify a signed row: signer, signature, acceptance time t (= its log event's time when one is
   * given), key window, the 6.1 window of body.at, version, then each [field, column, signed value].
   */
  const signedRow = (kind, id, text, signer, sig, version, t, event, columns) => {
    const body = parse(kind, id, text);
    if (!body) return null;
    const by = signer ?? body.by;
    if (body.by !== by) { flag(kind, id, "signer-mismatch"); return null; }
    const key = trusted.get(by)?.public_key;
    if (!key || !verifyBody(key, body, sig)) { flag(kind, id, "bad-signature", { by }); return null; }
    if (event !== undefined && (!event || event._at !== t)) flag(kind, id, "acceptance-time-mismatch");
    if (!keyValidAt(by, t)) flag(kind, id, "key-not-valid-at-signing", { by });
    if (!Number.isSafeInteger(body.at) || body.at < t - WINDOW_BACK_MS || body.at > t + WINDOW_AHEAD_MS) flag(kind, id, "record-time-outside-window");
    if (body.v !== version) flag(kind, id, "record-version", { v: body.v });
    for (const [field, column, value] of columns(body)) if (column !== value) flag(kind, id, "column-mismatch", { field });
    return body;
  };

  // --- owner-signed roster and policy files: re-derive fleet_principals, lanes, family map (E-3) ---
  const owner = trustedRoster.find(p => p.kind === "owner");
  const files = { roster: [], policy: [] };
  for (const f of exp.signed_files ?? []) {
    const body = parse("signed-file", `${f.kind}/${f.version}`, f.body);
    if (!body) continue;
    if (!owner || !verifyBody(owner.public_key, body, f.sig) || body.version !== f.version) { flag("signed-file", `${f.kind}/${f.version}`, "bad-signature"); continue; }
    const ev = firstEvent(security, e => e.kind === `${f.kind}.loaded` && e.version === f.version);
    if (!ev || ev._at !== f.loaded_at) flag("signed-file", `${f.kind}/${f.version}`, "log-mismatch");
    (files[f.kind] ?? []).push({ ...f, body });
  }
  for (const list of Object.values(files)) list.sort((x, y) => x.version - y.version);
  if (files.roster.length) {
    const derived = new Map();
    for (const f of files.roster) {
      for (const [id, p] of derived) if (!f.body.principals.some(q => q.principal_id === id)) p.status = "retired";
      for (const p of f.body.principals) if (!derived.has(p.principal_id) || derived.get(p.principal_id).status === "active")
        derived.set(p.principal_id, { principal_id: p.principal_id, kind: p.kind, runtime_family: p.runtime_family, status: "active", public_key: p.public_key });
    }
    const rows = [...derived.values()].sort((x, y) => (x.principal_id < y.principal_id ? -1 : 1));
    if (JSON.stringify(rows) !== JSON.stringify(exp.roster ?? [])) flag("roster", "fleet_principals", "derived-mismatch");
  }
  const policyAt = (t) => {   // the policy versions in force at time t (several when loaded at the same instant)
    const loaded = files.policy.filter(f => f.loaded_at <= t);
    const last = loaded.at(-1)?.loaded_at;
    return loaded.filter(f => f.loaded_at === last);
  };
  if (files.policy.length) {
    const lanes = new Map();
    for (const f of files.policy) for (const l of f.body.lanes) lanes.set(l.lane, l.owner_seat);
    const rows = [...lanes].map(([lane, owner_seat]) => ({ lane, owner_seat })).sort((x, y) => (x.lane < y.lane ? -1 : 1));
    if (JSON.stringify(rows) !== JSON.stringify(exp.lanes ?? [])) flag("lanes", "lanes", "derived-mismatch");
    const map = files.policy.flatMap(f => f.body.family_map.map(e => ({ policy_version: f.version, pattern: e.pattern, family: e.family })))
      .sort((x, y) => x.policy_version - y.policy_version || (x.pattern < y.pattern ? -1 : x.pattern > y.pattern ? 1 : 0));
    if (JSON.stringify(map) !== JSON.stringify(exp.policy_family_map ?? [])) flag("policy_family_map", "policy_family_map", "derived-mismatch");
  }

  // --- decisions, owner lines, verdicts ---------------------------------------------
  const created = new Map(events.filter(e => e.kind === "decision.created").map(e => [e.id, e]));
  const decisions = new Map();
  for (const d of exp.decisions) {
    const body = signedRow("decision", d.id, d.body, null, d.sig, DECISION_V, d.created_at, created.get(d.id) ?? null, b => [
      ["id", d.id, b.id], ["class", d.class, b.class], ["action", d.action, b.action], ["subject", d.subject, b.subject],
      ["lane", d.lane, b.lane ?? null], ["sponsor", d.sponsor, b.sponsor ?? null], ["served_by", d.served_by, b.served_by]]);
    if (!body) continue;
    decisions.set(d.id, { row: d, body });
    if (["veto", "unfreeze"].includes(d.action) && kindOf(body.by) !== "owner") flag("decision", d.id, "owner-record-not-by-owner");
  }
  const confirmations = new Map();
  for (const c of exp.owner_record_confirmations ?? []) {
    const ev = firstEvent(events, e => e.kind === "owner-record.confirm" && e.outbox_id === c.outbox_id);
    const body = signedRow("owner-record-confirm", c.outbox_id, c.body, c.confirmed_by, c.sig, OWNER_CONFIRM_V, c.at, ev, b => [["outbox_id", c.outbox_id, b.outbox_id]]);
    const line = (exp.owner_record_outbox ?? []).find(o => o.id === c.outbox_id);
    if (body && (!line || line.line_sha256 !== body.line_sha256 || line.confirmed_by !== c.confirmed_by || line.confirmed_at !== c.at))
      flag("owner-record-confirm", c.outbox_id, "confirmation-line-mismatch");
    if (body) confirmations.set(c.outbox_id, { ...c, _seq: ev?._seq ?? Infinity });
  }
  for (const o of exp.owner_record_outbox ?? [])
    if (sha256Hex(Buffer.from(`${o.line}\n`, "utf8")) !== o.line_sha256) flag("owner-line", o.id, "line-hash-mismatch");
  const vetoOf = (targetId) => [...decisions.values()].find(v => v.row.class === "OWNER" && v.row.action === "veto" && v.row.subject === targetId && v.row.state === "effective");
  for (const { row: d } of decisions.values()) {
    if (d.owner_posted_at !== null) {
      const line = (exp.owner_record_outbox ?? []).find(o => o.id === d.owner_line_ref);
      if (!line || line.subject !== d.id || line.confirmed_at !== d.owner_posted_at || !confirmations.has(line.id)) flag("decision", d.id, "owner-post-unconfirmed");
    }
    if (d.class === "D2" && d.effect_at !== (d.owner_posted_at === null ? null : d.owner_posted_at + D2_WINDOW_MS)) flag("decision", d.id, "column-mismatch", { field: "effect_at" });
    if (["reversed", "vetoed"].includes(d.state) && !vetoOf(d.id)) flag("decision", d.id, "reversal-without-veto");
  }

  const verdictEvents = new Map(events.filter(e => e.kind === "verdict").map(e => [`${e.decision_id}\n${e.by}\n${e.seq}`, e]));
  const chains = new Map();
  for (const a of exp.approvals) {
    const id = `${a.decision_id}/${a.approver}/${a.seq}`;
    const decision = decisions.get(a.decision_id);
    if (!decision) { flag("approval", id, "unknown-decision"); continue; }
    const p = trusted.get(a.approver);
    if (p && "kind" in p && (a.approver_kind !== p.kind || a.approver_family !== (p.runtime_family ?? null))) flag("approval", id, "column-mismatch", { field: "approver_kind/approver_family" });
    if (a.body_sha256 !== sha256Hex(Buffer.from(a.body, "utf8"))) flag("approval", id, "column-mismatch", { field: "body_sha256" });
    const body = parse("approval", id, a.body);
    if (!body) continue;
    if (body.v === DECISION_V) {
      // The implicit approval a D0, D1 or D1R creator gives by creating the decision (S2: the body's creator).
      const { row: d, body: db } = decision;
      if (a.seq !== 1 || a.prev !== null || a.verdict !== "approve" || a.body !== d.body || a.sig !== d.sig || db.by !== a.approver
        || a.served_by !== db.served_by || a.signed_at !== d.created_at || !["D0", "D1", "D1R"].includes(d.class)) flag("approval", id, "implicit-approval-mismatch");
    } else {
      signedRow("approval", id, a.body, a.approver, a.sig, APPROVAL_V, a.signed_at, verdictEvents.get(`${a.decision_id}\n${a.approver}\n${a.seq}`) ?? null, b => [
        ["decision_id", a.decision_id, b.decision_id], ["verdict", a.verdict, b.verdict], ["seq", a.seq, b.seq], ["prev", a.prev, b.prev], ["served_by", a.served_by, b.served_by]]);
    }
    const key = `${a.decision_id}\n${a.approver}`;
    if (!chains.has(key)) chains.set(key, []);
    chains.get(key).push({ a, body });
  }
  for (const { row: d, body } of decisions.values())
    if (["D0", "D1", "D1R"].includes(d.class) && !chains.has(`${d.id}\n${body.by}`)) flag("decision", d.id, "implicit-approval-missing");
  for (const rows of chains.values()) {
    rows.sort((x, y) => x.a.seq - y.a.seq);
    const { row: d, body: db } = decisions.get(rows[0].a.decision_id);
    const creatorVerdict = ["D0", "D1", "D1R"].includes(d.class) && db.by === rows[0].a.approver;
    rows.forEach(({ a, body }, i) => {
      const id = `${a.decision_id}/${a.approver}/${a.seq}`;
      if (a.seq !== i + 1) flag("approval", id, "approval-seq-gap");
      if (i === 0 && creatorVerdict !== (body.v === DECISION_V)) flag("approval", id, "implicit-approval-mismatch");
      if (i > 0 && body.v === DECISION_V) flag("approval", id, "implicit-approval-mismatch");
      if (body.v === APPROVAL_V && body.prev !== (i === 0 ? null : verdictPrev(rows[i - 1].a.body))) flag("approval", id, "approval-prev-mismatch");
    });
  }

  // --- rows <-> the decision log, both ways; states <-> their transition events -----------
  const transitions = new Map(), reversedAt = new Map(), effectiveEvent = new Map();
  for (const e of events) {
    const m = /^decision\.(effective|lapsed|vetoed|reversed)$/.exec(e.kind);
    if (m) transitions.set(e.id, [...(transitions.get(e.id) ?? []), m[1]]);
    if (e.kind === "decision.reversed") reversedAt.set(e.id, e._seq);
    if (e.kind === "decision.effective") effectiveEvent.set(e.id, e);
  }
  const STATE_LOG = { pending: "", effective: "effective", reversed: "effective,reversed", lapsed: "lapsed", vetoed: "vetoed", withdrawn: "" };
  const rowIds = new Set(exp.decisions.map(d => d.id));
  for (const { row: d, body } of decisions.values()) {
    const e = created.get(d.id);
    if (!e || e.class !== d.class || e.action !== d.action || e.subject !== d.subject || e.by !== body.by || e.served_by !== d.served_by) flag("decision", d.id, "log-mismatch");
    if (STATE_LOG[d.state] !== (transitions.get(d.id) ?? []).join(",")) flag("decision", d.id, "state-log-mismatch", { state: d.state });
    if (d.state === "withdrawn" && !(chains.get(`${d.id}\n${d.sponsor}`) ?? []).some(r => r.a.verdict === "withdraw")) flag("decision", d.id, "state-log-mismatch", { state: d.state });
  }
  for (const id of created.keys()) if (!rowIds.has(id)) flag("decision", id, "row-missing");
  const unmatched = new Map(verdictEvents);
  for (const rows of chains.values()) for (const { a, body } of rows) {
    if (body.v !== APPROVAL_V) continue;   // the implicit approval is logged as decision.created
    const key = `${a.decision_id}\n${a.approver}\n${a.seq}`, e = unmatched.get(key);
    if (!e || e.verdict !== a.verdict || e.served_by !== a.served_by) flag("approval", `${a.decision_id}/${a.approver}/${a.seq}`, "log-mismatch");
    unmatched.delete(key);
  }
  for (const e of unmatched.values()) flag("approval", `${e.decision_id}/${e.by}/${e.seq}`, "row-missing");

  // --- other signed records ------------------------------------------------------------
  for (const v of exp.verify_results) {
    signedRow("verify-result", v.submission_id, v.body, v.verifier, v.sig, VERIFY_V, v.at,
      firstEvent(events, e => e.kind === "verify.result" && e.submission_id === v.submission_id && e.by === v.verifier), b => [
        ["submission_id", v.submission_id, b.submission_id], ["patch_sha256", v.patch_sha256, b.patch_sha256], ["served_by", v.served_by, b.served_by],
        ["passed", v.passed, Array.isArray(b.exit_codes) && b.exit_codes.length > 0 && b.exit_codes.every(c => c === 0) ? 1 : 0]]);
  }
  for (const s of exp.security_approvals)
    signedRow("security-approval", s.submission_id, s.body, s.reviewer, s.sig, SECURITY_V, s.at,
      firstEvent(events, e => e.kind === "security.approve" && e.submission_id === s.submission_id && e.by === s.reviewer),
      b => [["submission_id", s.submission_id, b.submission_id], ["served_by", s.served_by, b.served_by]]);
  const declared = new Map();   // submission -> principals with a verified co-author declaration
  for (const c of exp.coauthors ?? []) {
    const body = signedRow("coauthor", c.submission_id, c.body, c.principal, c.sig, COAUTHOR_V, c.at,
      firstEvent(events, e => e.kind === "coauthor.declare" && e.submission_id === c.submission_id && e.by === c.principal),
      b => [["submission_id", c.submission_id, b.submission_id], ["served_by", c.served_by, b.served_by]]);
    if (body) declared.set(c.submission_id, [...(declared.get(c.submission_id) ?? []), c.principal]);
  }
  for (const f of exp.security_findings ?? []) {
    // S4, E-1: opened and closed only by a security principal.
    signedRow("finding-open", f.id, f.body, f.opened_by, f.sig, FINDING_OPEN_V, f.opened_at,
      firstEvent(security, e => e.kind === "finding.opened" && e.finding === f.id), b => [["id", f.id, b.id], ["member_id", f.member_id, b.member_id]]);
    if (kindOf(f.opened_by) !== "security") flag("finding-open", f.id, "finding-not-security");
    if (f.closed_at !== null) {
      signedRow("finding-close", f.id, f.close_body, f.closed_by, f.close_sig, FINDING_CLOSE_V, f.closed_at,
        firstEvent(security, e => e.kind === "finding.closed" && e.finding === f.id), b => [["finding_id", f.id, b.finding_id]]);
      if (kindOf(f.closed_by) !== "security") flag("finding-close", f.id, "finding-not-security");
    }
  }

  // decision_authors = the submitting member + the signed co-author declarations (V5, C2).
  const authorsOf = new Map();
  for (const r of exp.decision_authors ?? []) {
    if (!decisions.has(r.decision_id)) { flag("decision-author", `${r.decision_id}/${r.principal}`, "unknown-decision"); continue; }
    authorsOf.set(r.decision_id, [...(authorsOf.get(r.decision_id) ?? []), r.principal]);
  }
  for (const { row: d } of decisions.values()) {
    const actual = [...(authorsOf.get(d.id) ?? [])].sort();
    const sub = d.action === "accept" ? (exp.submissions ?? []).find(s => s.submission_id === d.subject) : null;
    const expected = d.action === "accept" ? [...new Set([sub?.member_id, ...(declared.get(d.subject) ?? [])])].filter(Boolean).sort() : [];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) flag("decision", d.id, "authors-mismatch");
  }

  // --- C5 attestations -----------------------------------------------------------------
  const maps = exp.policy_family_map ?? [];
  const familyOf = (version, model) => {
    const hits = maps.filter(m => m.policy_version === version && globMatch(m.pattern, model));
    return hits.length === 1 ? hits[0].family : null;
  };
  const attestations = [];
  for (const s of exp.served_by_attestations ?? []) {
    const ev = firstEvent(events, e => e.kind === "served_by.attest" && e.id === s.id);
    const body = signedRow("attestation", s.id, s.body, s.measurer, s.sig, ATTEST_V, s.recorded_at, ev, b => [
      ["decision_id", s.decision_id, b.target?.decision_id], ["target_by", s.target_by, b.target?.by], ["target_seq", s.target_seq, b.target?.seq],
      ["session_id", s.session_id, b.session_id], ["record_uuid", s.record_uuid, b.record_uuid], ["response_model", s.response_model, b.response_model],
      ["turn_models", s.turn_models, JSON.stringify(b.turn_models)], ["family", s.family, b.family], ["body_sha256", s.body_sha256, b.body_sha256],
      ["tool", s.tool, b.tool], ["tool_sha256", s.tool_sha256, b.tool_sha256], ["measured_at", s.measured_at, b.measured_at]]);
    if (!body) continue;
    // Relay-derived: policy_version is the policy in force at recorded_at (v3.3.2).
    if (files.policy.length && !policyAt(s.recorded_at).some(f => f.version === s.policy_version)) flag("attestation", s.id, "column-mismatch", { field: "policy_version" });
    if (kindOf(s.measurer) !== undefined && kindOf(s.measurer) !== "measurer") flag("attestation", s.id, "attest-not-measurer");
    const target = exp.approvals.find(a => a.decision_id === s.decision_id && a.approver === s.target_by && a.seq === s.target_seq);
    if (!target || target.body_sha256 !== s.body_sha256) flag("attestation", s.id, "attest-target-mismatch");
    const d = decisions.get(s.decision_id);
    if (d && (d.body.by === s.measurer || d.row.sponsor === s.measurer || exp.approvals.some(a => a.decision_id === d.row.id && a.approver === s.measurer)
      || (authorsOf.get(d.row.id) ?? []).includes(s.measurer))) flag("attestation", s.id, "measurer-conflict");
    let turn = [];
    try { turn = JSON.parse(s.turn_models); } catch { /* flagged below */ }
    if (familyOf(s.policy_version, s.response_model) !== s.family) flag("attestation", s.id, "attest-family-map");
    if (!Array.isArray(turn) || !turn.includes(s.response_model) || turn.some(m => familyOf(s.policy_version, m) !== s.family)) flag("attestation", s.id, "attest-mixed-turn");
    attestations.push({ ...s, _seq: ev?._seq ?? Infinity });
  }

  // --- settlement (v3.3.2): each effective D1, D1R and D2 re-checked as of its effective event ---
  const frozenAt = (seq) => {
    let frozen = false;
    for (const e of events) {
      if (e._seq >= seq) break;
      if (e.kind === "decision.effective" && e.action === "freeze") frozen = true;
      if (e.kind === "decision.effective" && e.action === "unfreeze") frozen = false;
    }
    return frozen;
  };
  for (const { row: d, body } of decisions.values()) {
    if (!["D1", "D1R", "D2"].includes(d.class) || !DONE.includes(d.state)) continue;
    const E = effectiveEvent.get(d.id);
    if (!E) continue;   // state-log-mismatch already flagged
    const latest = new Map();
    for (const [key, rows] of chains) {
      if (!key.startsWith(`${d.id}\n`)) continue;
      for (const { a, body: vb } of rows) {
        const seq = vb.v === DECISION_V ? created.get(d.id)?._seq : verdictEvents.get(`${a.decision_id}\n${a.approver}\n${a.seq}`)?._seq;
        if (seq !== undefined && seq < E._seq && (!latest.has(a.approver) || latest.get(a.approver).seq < a.seq)) latest.set(a.approver, a);
      }
    }
    const authors = new Set(authorsOf.get(d.id) ?? []);
    const seats = [...latest.values()].filter(a => kindOf(a.approver) === "ac-seat");
    const approvals = seats.filter(a => a.verdict === "approve" && !authors.has(a.approver) && a.approver !== d.sponsor);
    const families = new Set(approvals.map(a => {
      const asserted = measuredFamily(a.served_by);
      return attestations.some(s => s.decision_id === d.id && s.target_by === a.approver && s.target_seq === a.seq && s._seq < E._seq && s.family === asserted) ? asserted : null;
    }).filter(Boolean));
    const blocked = seats.some(a => a.verdict === "reject") || (d.class === "D2" && seats.some(a => a.verdict === "object" && a.approver !== d.sponsor));
    let ok = !blocked && !frozenAt(E._seq) && families.size >= 2;
    if (d.class === "D1") {
      const owners = policyAt(E._at).map(f => f.body.lanes.find(l => l.lane === body.lane)?.owner_seat).filter(Boolean);
      ok = ok && approvals.length >= 2 && (owners.length === 0 || approvals.some(a => owners.includes(a.approver)));
    }
    if (d.class === "D1R" || d.class === "D2") {
      const post = d.owner_line_ref && confirmations.get(d.owner_line_ref);
      ok = ok && !!post && post._seq < E._seq && approvals.length >= (d.class === "D2" ? 3 : 2);
      if (d.class === "D2") ok = ok && d.effect_at !== null && E._at >= d.effect_at;
    }
    if (!ok) flag("decision", d.id, "settlement-mismatch");
  }

  // --- derived rows ----------------------------------------------------------------------
  const justified = (id, actions) => { const d = decisions.get(id); return d && DONE.includes(d.row.state) && actions.includes(d.row.action) ? d : null; };
  const enrollmentOf = (id) => (exp.enrollments ?? []).find(e => e.id === id);
  const inviteOf = (id) => (exp.invites ?? []).find(i => i.invite_id === id);
  const reversedBy = (id) => {   // the decision a veto reversed, when `id` is an effective owner veto of a reversed decision
    const v = decisions.get(id);
    if (!v || v.row.class !== "OWNER" || v.row.action !== "veto" || v.row.state !== "effective") return null;
    const t = decisions.get(v.row.subject);
    return t && t.row.state === "reversed" ? t : null;
  };
  /** The member a decision is about: its subject, or the member of the invite / enrollment it cites. */
  const memberOfDecision = (t) => {
    if (t.row.action === "invite.create") return (exp.invites ?? []).find(i => i.decision_id === t.row.id)?.member_id ?? null;
    if (["rekey.confirm", "rebind.confirm"].includes(t.row.action)) return enrollmentOf(t.row.subject)?.member_id ?? null;
    return t.row.subject;
  };

  // D-C1 (v3.4.3 9.3; verifier finding F-RECITE / DC1-dup at 5ebc902): each role row is bound to the logged event
  // that produced it: its grant's decision.effective event, or the reversal.effect role.reprojected of
  // the veto it cites. A decision produces at most one role row (9.3 roles.decision_id UNIQUE), rows
  // follow their events in decision-log order, and a row's time is its event's time. So a row that
  // re-cites an earlier grant cannot be appended to a ledger, before or after a revocation.
  const reprojected = new Map();
  for (const e of events) if (e.kind === "reversal.effect" && e.effect === "role.reprojected") reprojected.set(`${e.veto}\n${e.member_id}`, e);
  const producer = (r) => (ROLE_GRANT[decisions.get(r.decision_id)?.row.action] ? effectiveEvent.get(r.decision_id) : reprojected.get(`${r.decision_id}\n${r.member_id}`)) ?? null;
  const citations = new Map();
  for (const r of exp.roles ?? []) citations.set(r.decision_id, (citations.get(r.decision_id) ?? 0) + 1);
  const rolesByMember = new Map();
  for (const r of exp.roles ?? []) rolesByMember.set(r.member_id, [...(rolesByMember.get(r.member_id) ?? []), r]);
  for (const [member, rows] of rolesByMember) {
    rows.sort((x, y) => x.seq - y.seq);
    rows.forEach((r, i) => {
      const id = `${member}/${r.seq}`;
      if (r.seq !== i + 1) flag("role", id, "role-seq-gap");
      if (citations.get(r.decision_id) > 1) flag("role", id, "role-duplicate-decision");
      const ev = producer(r);
      if (!ev) flag("role", id, "role-event-missing");
      else {
        if (ev._at !== r.at) flag("role", id, "role-time-mismatch");
        const prev = i > 0 ? producer(rows[i - 1]) : null;
        if (prev && !(ev._seq > prev._seq)) flag("role", id, "role-order-mismatch");
        if (ev.kind === "reversal.effect" && ev.to !== r.role) flag("role", id, "role-decision-mismatch");
      }
      const grant = justified(r.decision_id, Object.keys(ROLE_GRANT));
      if (grant) {
        if (grant.row.subject !== member || ROLE_GRANT[grant.row.action](grant.body) !== r.role) flag("role", id, "role-decision-mismatch");
        return;
      }
      // C3 / D-C3a: a re-projection cites the veto and equals the latest grant still effective
      // when that veto reversed its target (replayed in decision-log order).
      const t = reversedBy(r.decision_id);
      if (!t || t.row.subject !== member || !["role.c1", "role.change"].includes(t.row.action)) { flag("role", id, "role-decision-mismatch"); return; }
      const cut = reversedAt.get(t.row.id);
      const still = rows.slice(0, i).filter(x => {
        const g = justified(x.decision_id, Object.keys(ROLE_GRANT));
        return g && !(reversedAt.has(g.row.id) && reversedAt.get(g.row.id) <= cut);
      });
      if (still.at(-1)?.role !== r.role) flag("role", id, "role-decision-mismatch");
    });
  }
  /**
   * The 9.7 projection, re-derived from the decisions alone (D-C1; security review: for every status): the
   * role of the latest role grant (enroll.confirm C0, role.c1 C1, role.change) by its decision.effective
   * event, among grants effective before `cut` and not reversed before it. For a revoked member, `cut` is
   * the revoking reversal itself, so the projection is the role at revocation (D-2, S5).
   */
  const projectionAt = (member, cut = Infinity) => {
    let best = null;
    for (const d of decisions.values()) {
      if (!ROLE_GRANT[d.row.action] || d.row.subject !== member || !DONE.includes(d.row.state)) continue;
      const ev = effectiveEvent.get(d.row.id);
      if (!ev || !(ev._seq < cut) || (reversedAt.has(d.row.id) && reversedAt.get(d.row.id) < cut)) continue;
      if (!best || ev._seq > best.ev._seq) best = { d, ev };
    }
    return best ? ROLE_GRANT[best.d.row.action](best.d.body) ?? null : null;
  };
  // D-C1, S5, D-1, D-2: the members projection is re-derived, never trusted.
  for (const m of exp.members ?? []) {
    const rows = rolesByMember.get(m.member_id) ?? [];
    const enrolls = [...decisions.values()].filter(d => d.row.action === "enroll.confirm" && d.row.subject === m.member_id);
    const own = (exp.enrollments ?? []).find(e => e.kind === "enroll" && e.member_id === m.member_id);
    const ownInvite = own && decisions.get(inviteOf(own.invite_id)?.decision_id);
    // The reversals that actually revoked the member (5.4, 9.7): a reversed enroll.confirm, or the
    // reversal of its enroll invite.create while the enrollment was still unconfirmed. A completed
    // invite's reversal is record-only (9.7 invite.create row) and never revokes. The revoked status
    // and the revocation boundary below both come from this one list (verifier boundary finding at e1b840c).
    const revocations = [...enrolls.filter(d => d.row.state === "reversed"),
      ...(own && own.confirmed_by === null && ownInvite?.row.state === "reversed" ? [ownInvite] : [])];
    const revoked = revocations.length > 0;
    if (!revoked) {
      // Active, suspended or pending: the members row AND the last ledger row equal the projection.
      const expected = projectionAt(m.member_id);
      if (m.role !== expected) flag("member", m.member_id, "member-projection-mismatch", { field: "role" });
      if ((rows.at(-1)?.role ?? null) !== expected) flag("role", m.member_id, "role-ledger-mismatch");
    } else {
      // D-2 (S5): a revoked member's role is frozen at revocation. The boundary is the decision-log
      // event of the owner veto that revoked it: the veto of a reversal in `revocations`, never a
      // record-only one. Each role row is placed by the event that produced it (above); a row placed
      // after the boundary is refused. The members row AND the last row at or before the boundary must
      // equal the projection at the revoking reversal, never simply the latest row.
      const revokers = revocations.map(d => vetoOf(d.row.id)).filter(Boolean);
      const boundary = Math.min(...revokers.map(v => effectiveEvent.get(v.row.id)?._seq ?? Infinity));
      const cut = Math.min(...revocations.map(d => reversedAt.get(d.row.id) ?? Infinity));
      const placed = (r) => producer(r)?._seq ?? Infinity;
      for (const r of rows) if (!(placed(r) <= boundary)) flag("role", `${m.member_id}/${r.seq}`, "role-after-revocation");
      const expected = projectionAt(m.member_id, cut);
      if (m.role !== expected) flag("member", m.member_id, "member-projection-mismatch", { field: "role" });
      if ((rows.filter(r => placed(r) <= boundary).at(-1)?.role ?? null) !== expected) flag("role", m.member_id, "role-ledger-mismatch");
    }
    const status = revoked ? "revoked"
      : !enrolls.some(d => DONE.includes(d.row.state)) ? "pending"
      : (exp.suspensions ?? []).some(s => s.member_id === m.member_id && s.ended_at === null) ? "suspended" : "active";
    if (status !== m.status) flag("member", m.member_id, "member-projection-mismatch", { field: "status" });
    const activeKeys = (exp.keys ?? []).filter(k => k.principal_kind === "member" && k.principal_id === m.member_id && k.status === "active").length;
    if (m.status === "active" && activeKeys === 0) flag("member", m.member_id, "active-without-key");   // D-1 (RC-1)
  }

  // --- invites, re-bind attempts and suspensions (the D items) ----------------------------
  for (const inv of exp.invites ?? []) {
    const d = justified(inv.decision_id, ["invite.create"]);
    const a = d?.body.args ?? {};
    if (!d || inv.kind !== a.kind || inv.member_id !== (a.kind === "enroll" ? null : a.member_id) || inv.created_by !== d.body.by || inv.created_at !== d.row.created_at)
      flag("invite", inv.invite_id, "invite-decision-mismatch");
    const det = (exp.invite_details ?? []).find(x => x.invite_id === inv.invite_id);
    if (!det || det.decision_id !== inv.decision_id || det.lane !== d?.body.lane || det.intended_display_name !== a.intended_display_name
      || det.intended_platform !== a.intended_platform) flag("invite", inv.invite_id, "invite-decision-mismatch");
  }
  const endsOf = new Map((exp.rebind_ends ?? []).map(r => [r.invite_id, r]));
  const completedAttempt = (inviteId) => {
    const e = (exp.enrollments ?? []).find(x => x.invite_id === inviteId);
    return !!e && [...decisions.values()].some(d => d.row.class === "D1R" && d.row.subject === e.id && DONE.includes(d.row.state));
  };
  for (const r of exp.rebind_ends ?? []) {
    const inv = inviteOf(r.invite_id), e = (exp.enrollments ?? []).find(x => x.invite_id === r.invite_id);
    const key = e && keysByPk.get(e.public_key);
    const killed = (!e && inv?.voided_at !== null) || key?.status === "revoked";
    const d = r.decision_id && decisions.get(r.decision_id);
    const ok = !!inv && inv.kind === "rebind" && !completedAttempt(r.invite_id) && (
      (r.cause === "invite-expired" && !e && r.at >= inv.expires_at && r.decision_id === null)
      || (r.cause === "invite-voided" && !e && inv.voided_at !== null && r.decision_id === null)
      || (r.cause === "enrollment-expired" && !!e && key?.status === "revoked" && r.at >= e.spent_at + ENROLLMENT_TTL && r.decision_id === null)
      || (r.cause === "cancelled" && killed && !!d && d.row.action === "rebind.cancel" && d.row.subject === r.invite_id && DONE.includes(d.row.state))
      || (r.cause === "reversed" && killed && !!d && d.row.class === "OWNER" && d.row.action === "veto" && d.row.subject === inv.decision_id)
      || (r.cause === "reinstated" && killed && !!d && d.row.action === "reinstate" && d.row.subject === inv.member_id && DONE.includes(d.row.state)));
    if (!ok) flag("rebind-end", r.invite_id, "rebind-end-mismatch", { cause: r.cause });
    const ev = firstEvent(security, x => x.kind === "rebind.dead" && x.invite_id === r.invite_id);
    if (!ev || ev.cause !== r.cause || ev._at !== r.at) flag("rebind-end", r.invite_id, "log-mismatch");
  }
  for (const ev of security.filter(x => x.kind === "rebind.dead")) if (!endsOf.has(ev.invite_id)) flag("rebind-end", ev.invite_id, "row-missing");
  for (const s of exp.suspensions ?? []) {
    if (s.reason === "decision") {
      const d = justified(s.decision_id, ["suspend"]), t = reversedBy(s.decision_id);
      // Opened by a suspend; or by the veto of a reinstate, rekey.confirm or rebind.confirm (C3, D5), or
      // by RC-1's guard when a veto would leave the member keyless.
      const ok = (d && d.row.subject === s.member_id) || (t && memberOfDecision(t) === s.member_id
        && ["reinstate", "rekey.confirm", "rebind.confirm", "suspend", "invite.create"].includes(t.row.action));
      if (!ok) flag("suspension", s.id, "suspension-decision-mismatch");
    } else {
      const inv = inviteOf(s.invite_id);
      if (!inv || inv.kind !== "rebind" || inv.member_id !== s.member_id || !justified(inv.decision_id, ["invite.create"])) flag("suspension", s.id, "suspension-invite-mismatch");
    }
    if (s.ended_by_decision !== null) {
      let ok = false;
      if (s.reason === "decision") {
        const re = justified(s.ended_by_decision, ["reinstate"]), v = reversedBy(s.ended_by_decision);
        ok = (re && re.row.subject === s.member_id) || (v && v.row.id === s.decision_id);
      } else {
        const inv = inviteOf(s.invite_id), dead = endsOf.has(s.invite_id);
        const own = justified(s.ended_by_decision, ["rebind.confirm"]), e = own && enrollmentOf(own.row.subject);
        const re = justified(s.ended_by_decision, ["reinstate"]);
        const sup = justified(s.ended_by_decision, ["invite.create"]), newer = sup && (exp.invites ?? []).find(i => i.decision_id === sup.row.id);
        const veto = decisions.get(s.ended_by_decision);
        ok = (!!e && e.kind === "rebind" && e.invite_id === s.invite_id && e.member_id === s.member_id)
          || (dead && !!re && re.row.subject === s.member_id)
          || (dead && !!newer && newer.kind === "rebind" && newer.member_id === s.member_id && newer.invite_id !== s.invite_id)
          || (dead && !!veto && veto.row.class === "OWNER" && veto.row.action === "veto" && veto.row.state === "effective" && veto.row.subject === inv?.decision_id);
      }
      if (!ok) flag("suspension", s.id, "suspension-end-mismatch");
    }
    if (!firstEvent(security, x => x.kind === "suspension" && x.member_id === s.member_id && x._at === s.started_at)) flag("suspension", s.id, "log-mismatch");
  }
  for (const e of exp.enrollments ?? []) {
    if (e.confirmed_by === null) continue;
    const c = [...decisions.values()].find(d => DONE.includes(d.row.state) && (e.kind === "enroll"
      ? d.row.action === "enroll.confirm" && d.row.subject === e.member_id : d.row.action === "rekey.confirm" && d.row.subject === e.id));
    if (!c || c.body.by !== e.confirmed_by || c.body.args?.owner_line_ref !== e.owner_line_ref) flag("enrollment", e.id, "enrollment-confirmation-mismatch");
  }
  for (const c of exp.contributions ?? []) {
    const d = justified(c.decision_id, ["accept"]);
    if (!d || d.row.subject !== c.submission_id) flag("contribution", c.submission_id, "contribution-decision-mismatch");
  }
  // L1 (9.3, C2): given the pinned relay key, the relay-signed head is required and binds every log's tail.
  if (relayPublicKey !== undefined) problems.push(...verifyExportHead(exp, relayPublicKey, { aud }));
  return { ok: problems.length === 0, problems };
}

// --- the relay-signed export head (L1; spec 9.3 "A truncated tail is L1", Addendum C2, RT2) --------
// The head commits to EVERY log's {log, count, head_hash}, not only the decision log, so a truncated
// tail of any log (the security log included) and a full rewrite of any chain are detected offline
// against the pinned relay key. It is signed by the relay key, which exists only in L1.

export const EXPORT_HEAD_V = "commons-relay-export-head/1";

/** The head of each log in an export's rows: {log, count, head_hash} for every relay log, sorted by name. */
export function logHeads(rows) {
  return RELAY_LOGS.map(log => {
    const list = (rows ?? []).filter(r => r.log === log).sort((a, b) => a.seq - b.seq);
    return { log, count: list.length, head_hash: list.length ? list.at(-1).hash : GENESIS };
  });
}

/**
 * The relay-signed export (L1): exportRelay plus `head`, read in ONE read transaction so the head and
 * the rows are the same snapshot. `relaySeedHex` is the relay key seed (64 hex), held by the relay only.
 */
export function exportRelaySigned(db, { relaySeedHex, aud, at }) {
  if (typeof relaySeedHex !== "string" || !/^[0-9a-f]{64}$/.test(relaySeedHex)) throw new RelayError("relay-key", 500);
  if (typeof aud !== "string" || !aud) throw new RelayError("relay-aud-unset", 500);
  if (!Number.isSafeInteger(at)) throw new RelayError("invalid-time", 500);
  db.exec("BEGIN");
  try {
    const exp = exportRelay(db);
    const body = { v: EXPORT_HEAD_V, aud, epoch: exp.epoch, at, logs: logHeads(exp.logs) };
    const sig = Buffer.from(ed25519.sign(Buffer.from(jcs(body), "utf8"), Buffer.from(relaySeedHex, "hex"))).toString("hex");
    db.exec("COMMIT");
    return { ...exp, head: { body, sig } };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* the original error is the one that matters */ }
    throw error;
  }
}

/** Offline check of the head against the pinned relay key (strict Ed25519) and the export's own log rows. */
export function verifyExportHead(exp, relayPublicKey, { aud } = {}) {
  const out = [];
  const flag = (id, reason, extra = {}) => out.push({ kind: "export-head", id, reason, ...extra });
  const head = exp?.head, body = head?.body;
  if (!body || typeof body !== "object") { flag("head", "head-missing"); return out; }
  let bytes;
  try { bytes = Buffer.from(jcs(body), "utf8"); } catch { flag("head", "head-bad-signature"); return out; }
  if (!verifyBytesStrict(relayPublicKey, bytes, head.sig)) { flag("head", "head-bad-signature"); return out; }
  if (body.v !== EXPORT_HEAD_V) flag("head", "head-version");
  if (body.epoch !== exp.epoch) flag("head", "head-epoch-mismatch");
  if (aud !== undefined && body.aud !== aud) flag("head", "head-aud-mismatch");
  const listed = Array.isArray(body.logs) ? body.logs : [];
  const names = listed.map(l => l?.log);
  for (const log of RELAY_LOGS) if (names.filter(n => n === log).length !== 1) flag(log, "head-log-missing");
  for (const n of names) if (!RELAY_LOGS.includes(n)) flag(String(n), "head-log-unknown");
  const actual = new Map(logHeads(exp.logs).map(h => [h.log, h]));
  for (const l of listed) {
    const a = actual.get(l?.log);
    if (!a) continue;
    if (a.count !== l.count) flag(l.log, "head-count-mismatch", { head: l.count, rows: a.count });
    else if (a.head_hash !== l.head_hash) flag(l.log, "head-hash-mismatch");
  }
  return out;
}
