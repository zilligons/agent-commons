// L1 request front door (spec v3.4.5 6.5, 6.1 A8 / RT2 O-c, 7.1, O-d): the closed route inventory,
// the browser-origin refusal on header presence, the size caps, pending members on GET /v1/status
// only, principal kind per path, and signer == body.by on fleet records. N12 (size), N15, N34.
// v3.4.4 (scope-seat ruling (a)): the lane owner's review.changes and review.reject fleet routes.
// Scratch databases, fixture keys, no network.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ROUTES, FLEET_RECORD_TYPES, FLEET_VIEWS, KB, classifyRequest, admitRequest } from "../src/relay/routes.mjs";
import { IDENTITY_AUTH_HEADER, PRINCIPAL_HEADER, RELAY_TEST_AUD, signIdentityRequest } from "../src/relay/auth.mjs";
import { MEMBER_RECORD_TYPES } from "../src/relay/records.mjs";
import * as G from "../src/relay/governance.mjs";
import { handleMemberRecord } from "../src/relay/board.mjs";
import { setup, keySeedHex, applyEnrollmentRequest, createInvite, decision, coauthor, declareCoauthor, laneD0, promoteC1, taskArgs, PATCH, rejects, T0, HOUR } from "./relay-fixtures.mjs";

const manifest = JSON.parse(readFileSync(new URL("./relay-fixtures/manifests/routes.json", import.meta.url), "utf8"));
const iso = (ms) => new Date(ms).toISOString();
const UNAUTH = { ok: false, status: 401, body: { error: "unauthorized" } };

test("routes.json: the code's inventory equals the closed manifest, in both directions; 6.5's record types and views are all present", () => {
  const code = ROUTES.map(r => ({ method: r.method, path: r.path, auth: r.auth, principal: r.principal, cap_bytes: r.cap, ...(r.allowPending ? { pending_allowed: true } : {}) }));
  assert.deepEqual(code, manifest.routes);
  assert.equal(new Set(ROUTES.map(r => `${r.method} ${r.path}`)).size, ROUTES.length, "no duplicate route");
  assert.deepEqual(ROUTES.filter(r => r.allowPending).map(r => `${r.method} ${r.path}`), ["GET /v1/status"], "O-d: one pending route");
  assert.deepEqual(ROUTES.filter(r => r.auth === "invite").map(r => r.path), ["/v1/enroll", "/v1/rekey", "/v1/rebind"]);
  for (const t of Object.keys(MEMBER_RECORD_TYPES)) assert.ok(ROUTES.some(r => r.path === `/v1/records/${t}`), t);
  assert.equal(FLEET_RECORD_TYPES.length, 27);
  for (const t of ["review.changes", "review.reject"]) assert.ok(ROUTES.some(r => r.method === "POST" && r.path === `/v1/fleet/records/${t}` && r.principal === "fleet" && r.cap === 64 * KB), t);
  assert.deepEqual([...FLEET_VIEWS], ["alerts", "queue", "decisions", "members", "quarantine", "owner-outbox"]);
  for (const r of ROUTES) assert.equal(r.path.startsWith("/v1/fleet/"), r.principal === "fleet", r.path);
});

test("6.5: any other method or path is 404 before any authentication work (no header needed)", () => {
  for (const [method, path] of [["GET", "/"], ["GET", "/v1/enroll"], ["DELETE", "/v1/status"], ["HEAD", "/v1/status"], ["OPTIONS", "/v1/status"],
    ["POST", "/v1/records/unknown"], ["POST", "/v1/fleet/records/role.grant"], ["GET", "/v1/fleet/secrets"], ["GET", "/v1/status/"], ["GET", "/V1/status"],
    ["POST", "/v1/fleet/records/review.accept"], ["POST", "/v1/fleet/records/accept"], ["GET", "/v1/status?x=1"]])
    assert.deepEqual(classifyRequest({ method, path, headers: {} }), { ok: false, status: 404, body: { error: "not-found" } }, `${method} ${path}`);
});

test("N34 / A8 / O-c: Origin, Sec-Fetch-Site or Sec-Fetch-Mode PRESENT (even empty) -> 403 on every non-fleet path, enrollment included; fleet paths unaffected", () => {
  const refused = { ok: false, status: 403, body: { error: "browser-origin-refused" } };
  for (const r of ROUTES.filter(x => x.principal !== "fleet")) {
    for (const h of ["origin", "sec-fetch-site", "sec-fetch-mode"]) for (const value of ["https://example.com", "", "null"])
      assert.deepEqual(classifyRequest({ method: r.method, path: r.path, headers: { [h]: value } }), refused, `${r.path} ${h}=${JSON.stringify(value)}`);
    // The passing sibling: the same request without the header.
    assert.equal(classifyRequest({ method: r.method, path: r.path, headers: {} }).ok, true, r.path);
  }
  // The check runs before the size cap: an oversize browser request is 403, not 413.
  assert.deepEqual(classifyRequest({ method: "POST", path: "/v1/enroll", headers: { origin: "" }, contentLength: 999999 }), refused);
  for (const r of ROUTES.filter(x => x.principal === "fleet"))
    assert.equal(classifyRequest({ method: r.method, path: r.path, headers: { origin: "https://example.com" } }).ok, true, r.path);
});

test("7.1 / N12: the size cap is chosen from the path; exactly the cap is accepted, one byte more is 413", () => {
  const caps = { "/v1/enroll": 4 * KB, "/v1/inbox/ack": 1 * KB, "/v1/records/result": 256 * KB, "/v1/records/heartbeat": 64 * KB, "/v1/fleet/records/verdict": 64 * KB };
  for (const [path, cap] of Object.entries(caps)) {
    assert.equal(classifyRequest({ method: "POST", path, contentLength: cap }).ok, true, path);
    assert.deepEqual(classifyRequest({ method: "POST", path, contentLength: cap + 1 }), { ok: false, status: 413, body: { error: "too-large" } }, path);
  }
  assert.deepEqual(classifyRequest({ method: "GET", path: "/v1/status", contentLength: 1 }).status, 413, "a GET carries no body");
  assert.equal(classifyRequest({ method: "GET", path: "/v1/status", contentLength: -1 }).status, 400);
});

/** A signed request from a fixture identity for a route. */
function req(identity, method, path, body, created = iso(T0)) {
  const s = signIdentityRequest({ seedHex: keySeedHex(identity), method, path, query: "", body, audience: RELAY_TEST_AUD, created });
  return { method, path, query: "", body, headers: { [IDENTITY_AUTH_HEADER]: s.header, [PRINCIPAL_HEADER]: s.agent } };
}
const admit = (fx, r, now = T0) => {
  const c = classifyRequest({ method: r.method, path: r.path, headers: r.headers });
  assert.equal(c.ok, true, r.path);
  return admitRequest(fx.db, c.route, r, { aud: RELAY_TEST_AUD, now });
};

test("O-d / N15: a pending member may call GET /v1/status only; every other signed path is the uniform 401", () => {
  const fx = setup({ members: [] });
  const pend = applyEnrollmentRequest(fx, { invite: createInvite(fx, { at: T0 }), name: "P", at: T0 });
  assert.equal(admit(fx, req(pend.identity, "GET", "/v1/status")).ok, true);
  let n = 1;
  for (const r of ROUTES.filter(x => x.auth === "signed" && !x.allowPending)) {
    const body = r.cap > 0 ? (r.principal === "fleet" ? { body: { by: "x" }, sig: "0".repeat(128) } : { type: r.recordType ?? "ack", record_id: `r${n}`, body: {} }) : undefined;
    assert.deepEqual(admit(fx, req(pend.identity, r.method, r.path, body, iso(T0 + n++))), UNAUTH, r.path);
  }
});

test("principal kind per path: a member on a fleet path and a fleet principal on a member path get the uniform 401", () => {
  const fx = setup({ members: ["A"] });
  const A = fx.members.A.identity;
  assert.equal(admit(fx, req(A, "GET", "/v1/board")).ok, true);
  assert.deepEqual(admit(fx, req(A, "GET", "/v1/fleet/alerts", undefined, iso(T0 + 1))), UNAUTH);
  assert.deepEqual(admit(fx, req(A, "POST", "/v1/fleet/records/task.open", { body: { by: "seat-1" }, sig: "0".repeat(128) }, iso(T0 + 2))), UNAUTH);
  assert.equal(admit(fx, req(fx.keys["seat-1"], "GET", "/v1/fleet/alerts", undefined, iso(T0 + 3))).ok, true);
  assert.deepEqual(admit(fx, req(fx.keys["seat-1"], "GET", "/v1/board", undefined, iso(T0 + 4))), UNAUTH);
});

test("6.5 Signer = by on every fleet record path; a member record's <type> must equal the record's type", () => {
  const fx = setup({ members: ["A"] });
  let t = 0;
  for (const type of FLEET_RECORD_TYPES) {
    const own = admit(fx, req(fx.keys["seat-1"], "POST", `/v1/fleet/records/${type}`, { body: { by: "seat-1" }, sig: "0".repeat(128) }, iso(T0 + t++)));
    assert.equal(own.ok, true, type);
    const other = admit(fx, req(fx.keys["seat-1"], "POST", `/v1/fleet/records/${type}`, { body: { by: "seat-2" }, sig: "0".repeat(128) }, iso(T0 + t++)));
    assert.deepEqual(other, UNAUTH, `${type}: a captured seat-2 record re-submitted by seat-1`);
    const flat = admit(fx, req(fx.keys["seat-1"], "POST", `/v1/fleet/records/${type}`, { by: "seat-1" }, iso(T0 + t++)));
    assert.deepEqual(flat, UNAUTH, `${type}: not a signed record envelope`);
  }
  const A = fx.members.A.identity;
  assert.equal(admit(fx, req(A, "POST", "/v1/records/heartbeat", { type: "heartbeat", record_id: "h", body: {} }, iso(T0 + t++))).ok, true);
  assert.deepEqual(admit(fx, req(A, "POST", "/v1/records/heartbeat", { type: "note", record_id: "n", body: { text: "x" } }, iso(T0 + t++))),
    { ok: false, status: 400, body: { error: "type-mismatch" } });
});

/** A member at C1 with a submission in review on `task`. */
function inReview(fx, task, name = "A") {
  const id = fx.members[name].role === "C1" ? fx.members[name].id : promoteC1(fx, name);
  fx.members[name].role = "C1";
  laneD0(fx, "task.open", task, taskArgs(["docs"]));
  const c = handleMemberRecord(fx.db, id, { type: "claim", record_id: `c-${task}`, body: { task_id: task, lease_ms: 2 * HOUR } }, T0);
  return handleMemberRecord(fx.db, id, { type: "result", record_id: `r-${task}`, body: { claim_id: c.claim_id, epoch: c.epoch, kind: "patch", body: PATCH() } }, T0);
}
const submissionState = (fx, id) => fx.db.prepare("SELECT state FROM submissions WHERE submission_id = ?").get(id).state;

test("v3.4.4 6.5 (scope-seat ruling (a)): review.changes and review.reject go from the front door to the L0 D0 handler; co-author 409, not in review 409, a member 401", () => {
  const fx = setup({ members: ["A"] });
  let t = 100;
  const send = (by, type, rec) => {
    const r = req(fx.keys[by], "POST", `/v1/fleet/records/${type}`, rec, iso(T0 + t++));
    const a = admit(fx, r);
    return a.ok ? { admitted: a, out: () => G.createDecision(fx.db, rec, T0) } : { refused: a };
  };
  // The lane owner's review.changes: admitted and effective; the claimant gets a new claim.
  const s1 = inReview(fx, "t1");
  const changes = send("seat-1", "review.changes", decision(fx, "seat-1", { cls: "D0", action: "review.changes", subject: s1.submission_id, args: {} }));
  assert.equal(changes.admitted.principal.id, "seat-1");
  assert.equal(changes.out().state, "effective");
  assert.equal(submissionState(fx, s1.submission_id), "changes");
  // A submission that is no longer in review: admitted (the front door does not read state), then 409 in the handler.
  const again = send("seat-1", "review.reject", decision(fx, "seat-1", { cls: "D0", action: "review.reject", subject: s1.submission_id, args: { disposition: "close" } }));
  assert.equal(rejects(() => again.out(), "invalid-state").status, 409);
  // The lane owner's review.reject on a fresh submission: effective.
  const live = fx.db.prepare("SELECT claim_id FROM claims WHERE state = 'live'").get();
  laneD0(fx, "claim.release", live.claim_id);   // the reissued t1 claim, so A is under the C1 cap again
  const s2 = inReview(fx, "t2");
  const reject = send("seat-1", "review.reject", decision(fx, "seat-1", { cls: "D0", action: "review.reject", subject: s2.submission_id, args: { disposition: "reopen" } }));
  assert.equal(reject.out().state, "effective");
  assert.equal(submissionState(fx, s2.submission_id), "rejected");
  // A declared co-author of the submission, as lane owner, never decides it: 409 author-cannot-approve.
  const s3 = inReview(fx, "t3");
  declareCoauthor(fx.db, coauthor(fx, "seat-1", s3.submission_id), T0);
  const co = send("seat-1", "review.changes", decision(fx, "seat-1", { cls: "D0", action: "review.changes", subject: s3.submission_id, args: {} }));
  assert.equal(rejects(() => co.out(), "author-cannot-approve").status, 409);
  assert.equal(submissionState(fx, s3.submission_id), "in-review");
  // Signed by another seat than body.by: the uniform 401 at the front door.
  const other = send("seat-2", "review.changes", decision(fx, "seat-1", { cls: "D0", action: "review.changes", subject: s3.submission_id, args: {} }));
  assert.deepEqual(other.refused, UNAUTH);
  // A member principal on the review routes: the uniform 401.
  for (const type of ["review.changes", "review.reject"]) {
    const r = req(fx.members.A.identity, "POST", `/v1/fleet/records/${type}`, { body: { by: fx.members.A.id }, sig: "0".repeat(128) }, iso(T0 + t++));
    assert.deepEqual(admit(fx, r), UNAUTH, type);
  }
});
