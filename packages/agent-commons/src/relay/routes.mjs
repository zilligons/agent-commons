// Cloud Commons relay: the request front door (spec v3.4.5 6.5 endpoint inventory, 6.1
// browser-origin refusal (A8), 7.1 ingress order and size caps, pending members).
// Pure: no listener and no I/O. The server reads the method, path, headers and Content-Length, asks
// classifyRequest before reading any body byte, then authenticates with admitRequest.
//
// Order, before any authentication work:
//   1. the closed route inventory (routes.json): any other method or path -> 404 not-found;
//   2. on every path outside /v1/fleet/: an Origin, Sec-Fetch-Site or Sec-Fetch-Mode header that is
//      PRESENT, even empty -> 403 browser-origin-refused (before any signature, nonce or invite work;
//      principal-independent, so not an oracle);
//   3. the size cap chosen from the path (7.1): one byte over -> 413.
// Then admitRequest: the 6.1 signature (auth.mjs); a pending member only on GET /v1/status;
// a member on a fleet path, or a fleet principal on a member path -> the uniform 401; on a fleet
// record (sent as the signed record { body, sig }) the signer must equal body.by (6.5, C1) ->
// otherwise the uniform 401; a member record path's <type> must equal the record's type.

import { RelayError } from "./records.mjs";
import { MEMBER_RECORD_TYPES } from "./records.mjs";
import { authenticateRequest, signerMatchesBy, UNAUTHORIZED } from "./auth.mjs";

export const KB = 1024;
/** 6.5 fleet record types, closed (the fleet record table; v3.4.4 adds review.changes and review.reject). */
export const FLEET_RECORD_TYPES = Object.freeze([
  "invite.create", "rebind.cancel", "enroll.confirm", "rekey.confirm",
  "task.open", "task.close", "task.assign", "claim.release", "progress.accept", "role.c1", "clock.resume",
  "review.changes", "review.reject",
  "decision.propose", "verdict", "served_by.attest", "finding.open", "finding.close", "coauthor.declare",
  "verify.result", "security.approve", "suspend", "message", "owner-record.confirm", "freeze", "veto", "unfreeze",
]);
/** 6.5 fleet views, closed. */
export const FLEET_VIEWS = Object.freeze(["alerts", "queue", "decisions", "members", "quarantine", "owner-outbox"]);
export const BROWSER_HEADERS = Object.freeze(["origin", "sec-fetch-site", "sec-fetch-mode"]);

/**
 * The closed route inventory (6.5). `auth`: "invite" (5.2 enrollment flow) or "signed" (6.1).
 * `principal`: who may call it. `cap`: body bytes (0 = no body). Exported for routes.json.
 */
export const ROUTES = Object.freeze([
  ...["enroll", "rekey", "rebind"].map(kind => ({ method: "POST", path: `/v1/${kind}`, auth: "invite", principal: null, cap: 4 * KB, flow: kind })),
  { method: "GET", path: "/v1/status", auth: "signed", principal: "member", cap: 0, allowPending: true },
  { method: "GET", path: "/v1/seed", auth: "signed", principal: "member", cap: 0 },
  { method: "GET", path: "/v1/inbox", auth: "signed", principal: "member", cap: 0 },
  { method: "POST", path: "/v1/inbox/ack", auth: "signed", principal: "member", cap: 1 * KB },
  { method: "GET", path: "/v1/claims", auth: "signed", principal: "member", cap: 0 },
  { method: "GET", path: "/v1/board", auth: "signed", principal: "member", cap: 0 },
  ...Object.keys(MEMBER_RECORD_TYPES).map(type => ({ method: "POST", path: `/v1/records/${type}`, auth: "signed", principal: "member", cap: type === "result" ? 256 * KB : 64 * KB, recordType: type })),
  ...FLEET_RECORD_TYPES.map(type => ({ method: "POST", path: `/v1/fleet/records/${type}`, auth: "signed", principal: "fleet", cap: 64 * KB, recordType: type })),
  ...FLEET_VIEWS.map(view => ({ method: "GET", path: `/v1/fleet/${view}`, auth: "signed", principal: "fleet", cap: 0, view })),
].map(r => Object.freeze(r)));
const BY_KEY = new Map(ROUTES.map(r => [`${r.method} ${r.path}`, r]));

const isFleetPath = (path) => typeof path === "string" && path.startsWith("/v1/fleet/");
const refusal = (status, error) => ({ ok: false, status, body: { error } });

/**
 * Classify a request before any body byte is read and before any authentication work.
 * `headers` uses lower-case names (as node:http gives them). `contentLength` is the declared body
 * size in bytes (0 or undefined when there is none); the server must also stop reading at the cap.
 * Returns { ok: true, route } or a refusal { ok: false, status, body }.
 */
export function classifyRequest({ method, path, headers = {}, contentLength = 0 }) {
  const route = BY_KEY.get(`${method} ${path}`);
  if (!route) return refusal(404, "not-found");
  // A8: refuse on the header's PRESENCE (an empty value included), on every non-fleet path.
  if (!isFleetPath(path) && BROWSER_HEADERS.some(h => Object.hasOwn(headers, h))) return refusal(403, "browser-origin-refused");
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) return refusal(400, "bad-content-length");
  if (contentLength > route.cap) return refusal(413, "too-large");
  return { ok: true, route };
}

/**
 * Admit a classified, signed request (6.1 auth + 6.5 principal rules). `req` = { method, path,
 * query, headers, body } with `body` the parsed JSON. Returns { ok: true, route, principal } or a
 * refusal. The enrollment-flow routes (auth "invite") are not handled here (5.2).
 */
export function admitRequest(db, route, req, { aud, now }) {
  if (route.auth !== "signed") throw new RelayError("route-not-signed", 500, route.path);
  const a = authenticateRequest(db, req, { aud, now, allowPending: route.allowPending === true });
  if (!a.ok) return a;
  const p = a.principal;
  // Only GET /v1/status admits a pending member (authenticateRequest enforces allowPending).
  if (p.kind !== route.principal) return { ok: false, ...UNAUTHORIZED };
  // A fleet record travels as the signed record { body, sig } (9.2); its body's `by` must be the signer.
  if (route.principal === "fleet" && route.recordType && !signerMatchesBy(p, req.body?.body)) return { ok: false, ...UNAUTHORIZED };
  if (route.recordType && route.principal === "member" && req.body?.type !== route.recordType) return refusal(400, "type-mismatch");
  return { ok: true, route, principal: p };
}
