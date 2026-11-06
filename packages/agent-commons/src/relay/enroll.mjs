// Cloud Commons relay: the request side of the enrollment flows (spec v3.4.5 5.2, 5.3, 5.4; RD1,
// RD2, RD3, M1, B2, B3, B9).
//
// POST /v1/enroll | /v1/rekey | /v1/rebind share one body and one descriptor (5.2, B2):
//   body:       { invite_id, secret, member_id, public_key, agent, display_name, platform,
//                 created, nonce, sig, old_sig }
//   descriptor: { kind, aud, invite_id, member_id, public_key, agent, old_agent,
//                 display_name, platform, created, nonce }
//   sig     = Ed25519 by the new key     over "<tag>\n" + JCS(descriptor)
//   old_sig = Ed25519 by the current key over the same bytes (re-key only)
// The relay rebuilds the descriptor: `kind` from the endpoint, `aud` from its configuration and
// `old_agent` from its own keys table, never from the request.
//
// Processing order (5.2): 1 per-IP caps (server.mjs), 2 size cap (routes.mjs), 3 parse and
// allowlist, 4 invite, 5 proof of possession, 6 nonce spend then the future check, 7 one key ever,
// 8 member state, 9 spend the invite in one IMMEDIATE transaction. Failures at steps 4-8 against an
// existing invite are persisted in enroll_attempts; the fifth voids a live invite (voidInvite: an
// alert to the lane seats, and for a re-bind invite the attempt's death, invite-voided). A failed
// proof of possession never spends the invite.
//
// The flow reuses the 6.1 primitives of the cf48f0e port (auth.mjs): the `created` grammar, the
// nonce format, strict Ed25519, keyBindsAgentUuaid in agentnet, and the one request-nonce table.

import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { jcs } from "../pillar.mjs";
import { localIdFromKey } from "../vendor/pillar/identity/keychain.mjs";
import { keyBindsAgentUuaid } from "../uuaid-namespace.mjs";
import { RelayError, assertIntegerOnly, sanitizeText } from "./records.mjs";
import { tx, getMeta } from "./schema.mjs";
import { appendLog, sha256Hex } from "./signing.mjs";
import { isCreated, isNonce, isAgentnetAgent, isStrictEd25519PublicKey, verifyBytesStrict, spendNonce, AUTH_MAX_AGE_MS, AUTH_MAX_FUTURE_MS } from "./auth.mjs";
import { isFrozen, ownerLineSha, voidInvite, rebindCount } from "./governance.mjs";

export const ENROLLMENT_KINDS = Object.freeze(["enroll", "rekey", "rebind"]);
/** D-iii: relay-specific tags, one per endpoint. */
export const ENROLLMENT_TAGS = Object.freeze({ enroll: "commons-relay.enroll.v1", rekey: "commons-relay.rekey.v1", rebind: "commons-relay.rebind.v1" });
/** M1: failures against one invite that void it. */
export const ENROLL_FAILURE_BUDGET = 5;
const BODY_KEYS = Object.freeze(["invite_id", "secret", "member_id", "public_key", "agent", "display_name", "platform", "created", "nonce", "sig", "old_sig"]);
const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
const INVITE_ID = HEX(32), SECRET = HEX(64), KEY = HEX(64), SIG = HEX(128);

/** The uniform refusal for steps 4 and 5: an unknown, dead or mismatched invite and a bad proof look the same. */
const REFUSED = () => new RelayError("enrollment-refused", 403);

/** The descriptor both signatures cover (5.2), in the spec's field order (JCS sorts keys anyway). */
export function enrollmentDescriptor({ kind, aud, invite_id, member_id, public_key, agent, old_agent, display_name, platform, created, nonce }) {
  return { kind, aud, invite_id, member_id, public_key, agent, old_agent, display_name, platform, created, nonce };
}

/** "<tag>\n" + JCS(descriptor), the exact bytes `sig` and `old_sig` sign. */
export function enrollmentSigningBytes(d) {
  const tag = ENROLLMENT_TAGS[d?.kind];
  if (!tag) throw new RelayError("invalid-kind", 500);
  return Buffer.from(`${tag}\n${jcs(d)}`, "utf8");
}

/**
 * Build a signed enrollment-flow body (the reference client's signer; tests). `invite` is the invite
 * the owner delivered ({relay: {origin}, kind, member_id, invite_id, secret}). `seedHex` is the NEW key
 * seed; for re-key, `oldSeedHex` is the current key seed. Seeds never leave the caller.
 */
export function signEnrollmentRequest({ invite, seedHex, oldSeedHex, displayName = null, platform = null, created, nonce }) {
  const kind = invite.kind;
  const seed = Buffer.from(seedHex, "hex");
  const publicKey = Buffer.from(ed25519.getPublicKey(seed)).toString("hex");
  const agent = `uuaid:agentnet:agent:${localIdFromKey(Buffer.from(publicKey, "hex"))}`;
  let oldAgent = null, oldSeed = null;
  if (kind === "rekey") {
    oldSeed = Buffer.from(oldSeedHex, "hex");
    oldAgent = `uuaid:agentnet:agent:${localIdFromKey(Buffer.from(ed25519.getPublicKey(oldSeed)))}`;
  }
  const body = {
    invite_id: invite.invite_id, secret: invite.secret, member_id: kind === "enroll" ? null : invite.member_id,
    public_key: publicKey, agent, display_name: kind === "enroll" ? displayName : null, platform: kind === "enroll" ? platform : null,
    created: created ?? new Date().toISOString(), nonce: nonce ?? randomBytes(16).toString("hex"), sig: null, old_sig: null,
  };
  const bytes = enrollmentSigningBytes(enrollmentDescriptor({ ...body, kind, aud: invite.relay.origin, old_agent: oldAgent }));
  body.sig = Buffer.from(ed25519.sign(bytes, seed)).toString("hex");
  if (oldSeed) body.old_sig = Buffer.from(ed25519.sign(bytes, oldSeed)).toString("hex");
  return { body, agent, publicKey };
}

/** Step 3: the endpoint's field allowlist and value column (5.2 table). Throws 400/422 (never counted). */
function parseBody(kind, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RelayError("invalid-json", 400, "body must be a JSON object");
  for (const key of Object.keys(body)) if (!BODY_KEYS.includes(key)) throw new RelayError("unknown-field", 400, key.slice(0, 64));
  for (const key of BODY_KEYS) if (!Object.hasOwn(body, key)) throw new RelayError("missing-field", 400, key);
  assertIntegerOnly(body);
  const bad = (f) => { throw new RelayError("invalid-field", 400, f); };
  if (typeof body.invite_id !== "string" || !INVITE_ID.test(body.invite_id)) bad("invite_id");
  if (typeof body.secret !== "string" || !SECRET.test(body.secret)) bad("secret");
  if (typeof body.public_key !== "string" || !KEY.test(body.public_key)) bad("public_key");
  if (!isAgentnetAgent(body.agent)) bad("agent");   // B3: agentnet only
  if (!isCreated(body.created)) bad("created");
  if (!isNonce(body.nonce)) bad("nonce");
  if (typeof body.sig !== "string" || !SIG.test(body.sig)) bad("sig");
  if (kind === "rekey" ? typeof body.old_sig !== "string" || !SIG.test(body.old_sig) : body.old_sig !== null) bad("old_sig");
  if (kind === "enroll" ? body.member_id !== null : typeof body.member_id !== "string" || !isAgentnetAgent(body.member_id)) bad("member_id");
  if (kind === "enroll") {
    const displayName = sanitizeText(body.display_name, { field: "display_name", max: 64 });
    const platform = sanitizeText(body.platform, { field: "platform", max: 64 });
    if (!displayName.trim()) bad("display_name");
    if (!platform.trim()) bad("platform");
    return { ...body, display_name: displayName, platform };
  }
  if (body.display_name !== null) bad("display_name");
  if (body.platform !== null) bad("platform");
  return body;
}

/** A refusal at steps 4-8 that counts against the invite. */
class Failure extends Error {
  constructor(step, reason, error) { super(reason); this.step = step; this.reason = reason; this.error = error; }
}

const secretMatches = (secretHex, storedSha256Hex) =>
  timingSafeEqual(Buffer.from(sha256Hex(Buffer.from(secretHex, "hex")), "hex"), Buffer.from(storedSha256Hex, "hex"));

/** The member's current active key (re-key's old key), from the relay's own table. */
const activeMemberKey = (db, memberId) => db.prepare(`SELECT public_key, agent FROM keys WHERE principal_kind = 'member' AND principal_id = ? AND status = 'active'
  ORDER BY added_at DESC LIMIT 2`).all(memberId);

/** Persist one failure, then void a live invite once the budget is spent (M1). Its own transactions. */
function recordFailure(db, invite, kind, failure, sourceIp, now) {
  tx(db, () => {
    db.prepare("INSERT INTO enroll_attempts(invite_id, kind, step, reason, source_ip, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(invite.invite_id, kind, failure.step, failure.reason, sourceIp, now);
    appendLog(db, "security", { kind: "enroll.failed", invite_id: invite.invite_id, endpoint: kind, step: failure.step, reason: failure.reason }, now);
  });
  const n = db.prepare("SELECT count(*) n FROM enroll_attempts WHERE invite_id = ?").get(invite.invite_id).n;
  const live = db.prepare(`SELECT 1 FROM invites i WHERE i.invite_id = ? AND i.voided_at IS NULL
                            AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.invite_id = i.invite_id)`).get(invite.invite_id);
  if (n < ENROLL_FAILURE_BUDGET || !live) return { failures: n, voided: false };
  // D1-4: no void (and no death) while frozen or clock-suspect; the next failure after that voids it.
  if (isFrozen(db) || getMeta(db, "clock_suspect") === "1") return { failures: n, voided: false };
  voidInvite(db, invite.invite_id, now);
  return { failures: n, voided: true };
}

/**
 * Apply one enrollment-flow request (5.2 steps 3-9). `kind` is the endpoint's; `aud` the relay's
 * configured audience; `sourceIp` the connection's address (the server refused a non-IP at step 1).
 * Returns the pending enrollment, or throws a RelayError (403 enrollment-refused for steps 4-5,
 * 401 stale, 409 replay / key-not-new / invalid-state, 503 frozen, 400s for step 3).
 */
export function applyEnrollmentRequest(db, kind, rawBody, { aud, now, sourceIp }) {
  if (!ENROLLMENT_KINDS.includes(kind)) throw new RelayError("invalid-kind", 500);
  if (typeof aud !== "string" || !aud) throw new RelayError("relay-aud-unset", 500);
  if (!Number.isSafeInteger(now)) throw new RelayError("invalid-time", 500);
  if (typeof sourceIp !== "string" || sourceIp.length < 2) throw new RelayError("invalid-source", 400);
  const body = parseBody(kind, rawBody);   // step 3
  if (isFrozen(db)) throw new RelayError("frozen", 503);   // 9.2: every member request but GET /v1/status
  const invite = db.prepare("SELECT * FROM invites WHERE invite_id = ?").get(body.invite_id);
  if (!invite) throw REFUSED();   // nothing to count against
  try {
    // Step 4: the invite (constant-time secret check; live; the endpoint's kind and member, B2).
    if (!secretMatches(body.secret, invite.secret_sha256)) throw new Failure(4, "secret", REFUSED());
    if (invite.voided_at !== null) throw new Failure(4, "voided", REFUSED());
    if (db.prepare("SELECT 1 FROM enrollments WHERE invite_id = ?").get(invite.invite_id)) throw new Failure(4, "spent", REFUSED());
    if (now >= invite.expires_at || now < invite.created_at) throw new Failure(4, "expired", REFUSED());
    if (invite.kind !== kind) throw new Failure(4, "kind", REFUSED());
    if (invite.member_id !== body.member_id) throw new Failure(4, "member", REFUSED());
    // Step 5: proof of possession over the descriptor the relay rebuilds.
    const created = Date.parse(body.created);
    if (created < now - AUTH_MAX_AGE_MS) throw new Failure(5, "stale", new RelayError("stale", 401));
    if (!isStrictEd25519PublicKey(body.public_key) || !keyBindsAgentUuaid(body.agent, body.public_key)) throw new Failure(5, "key", REFUSED());
    let oldAgent = null, oldKey = null;
    if (kind === "rekey") {
      const active = activeMemberKey(db, body.member_id);
      if (active.length !== 1) throw new Failure(5, "old-key", REFUSED());
      oldAgent = active[0].agent; oldKey = active[0].public_key;
    }
    const bytes = enrollmentSigningBytes(enrollmentDescriptor({ ...body, kind, aud, old_agent: oldAgent }));
    if (!verifyBytesStrict(body.public_key, bytes, body.sig)) throw new Failure(5, "sig", REFUSED());
    if (kind === "rekey" && !verifyBytesStrict(oldKey, bytes, body.old_sig)) throw new Failure(5, "old-sig", REFUSED());
    // Step 6 (B9): spend the nonce, then refuse a future-dated request. The nonce stays spent.
    if (!spendNonce(db, body.agent, body.nonce, created, now)) throw new Failure(6, "replay", new RelayError("replay", 409));
    if (created > now + AUTH_MAX_FUTURE_MS) throw new Failure(6, "future", new RelayError("stale", 401));
    // Steps 7-9 in one IMMEDIATE transaction: the checks are read where the write happens.
    return tx(db, () => {
      // Step 7 (RD1): one key ever; the key and its id were never seen, in any status.
      if (db.prepare("SELECT 1 FROM keys WHERE public_key = ? OR agent = ?").get(body.public_key, body.agent)) throw new Failure(7, "key-not-new", new RelayError("key-not-new", 409));
      if (kind === "enroll" && db.prepare("SELECT 1 FROM members WHERE member_id = ?").get(body.agent)) throw new Failure(7, "member-exists", new RelayError("key-not-new", 409));
      // Step 8 (RD2): member state.
      if (kind === "rekey") {
        const m = db.prepare("SELECT status FROM members WHERE member_id = ?").get(body.member_id);
        if (m?.status !== "active" || db.prepare("SELECT 1 FROM suspensions WHERE member_id = ? AND ended_at IS NULL").get(body.member_id))
          throw new Failure(8, "member-not-active", new RelayError("invalid-state", 409, "re-key needs an active, unsuspended member"));
      }
      if (kind === "rebind") {
        const m = db.prepare("SELECT status FROM members WHERE member_id = ?").get(body.member_id);
        const own = db.prepare(`SELECT 1 FROM suspensions s WHERE s.member_id = ? AND s.reason = 'rebind' AND s.invite_id = ? AND s.ended_at IS NULL
                                  AND NOT EXISTS (SELECT 1 FROM rebind_ends r WHERE r.invite_id = s.invite_id)`).get(body.member_id, invite.invite_id);
        if (!m || m.status === "revoked" || !own) throw new Failure(8, "attempt-not-live", new RelayError("invalid-state", 409, "the re-bind attempt is not live"));
      }
      // Step 9: spend the invite.
      if (db.prepare("SELECT 1 FROM enrollments WHERE invite_id = ?").get(invite.invite_id)) throw new Failure(4, "spent", REFUSED());
      const memberId = kind === "enroll" ? body.agent : body.member_id;
      const enrollmentId = `enr-${randomBytes(12).toString("hex")}`;
      const details = db.prepare("SELECT lane, intended_display_name, intended_platform FROM invite_details WHERE invite_id = ?").get(invite.invite_id);
      if (kind === "enroll") {
        db.prepare("INSERT INTO members(member_id, status, role, updated_at) VALUES (?, 'pending', NULL, ?)").run(memberId, now);
        db.prepare("INSERT INTO member_profiles(member_id, display_name, platform, lane, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(memberId, body.display_name, body.platform, details.lane, now);
      }
      db.prepare("INSERT INTO keys(public_key, agent, principal_kind, principal_id, status, added_at, revoked_at) VALUES (?, ?, 'member', ?, 'pending', ?, NULL)")
        .run(body.public_key, body.agent, memberId, now);
      db.prepare("INSERT INTO enrollments(id, invite_id, kind, member_id, public_key, spent_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(enrollmentId, invite.invite_id, kind, memberId, body.public_key, now);
      const profile = db.prepare("SELECT display_name, platform FROM member_profiles WHERE member_id = ?").get(memberId);
      // 5.3: the owner-visible line {member_id, agent, platform, display_name, invite_id, created_by}.
      const line = `commons-relay ${kind} enrollment=${enrollmentId} member=${memberId} agent=${body.agent} platform=${JSON.stringify(profile.platform)} display_name=${JSON.stringify(profile.display_name)} invite=${invite.invite_id} created_by=${invite.created_by}`;
      const outboxId = randomUUID();
      db.prepare("INSERT INTO owner_record_outbox(id, subject, line, line_sha256, created_at) VALUES (?, ?, ?, ?, ?)").run(outboxId, enrollmentId, line, ownerLineSha(line), now);
      // 5.2: the invite's intended name and platform beside what the agent sent; a mismatch is shown, not hidden.
      const mismatch = kind === "enroll" && (body.display_name !== details.intended_display_name || body.platform !== details.intended_platform);
      // RD3 hook: the confirming seat sees how many re-binds this member already had (the 2nd and later raise rebind.repeat on confirmation).
      const detail = { enrollment: enrollmentId, kind, invite_id: invite.invite_id, created_by: invite.created_by, owner_line: outboxId,
        intended_display_name: details.intended_display_name, intended_platform: details.intended_platform, mismatch,
        ...(kind === "rebind" ? { rebind_count: rebindCount(db, memberId) } : {}) };
      db.prepare("INSERT INTO alerts(at, kind, subject, detail) VALUES (?, 'enrollment.request', ?, ?)").run(now, memberId, jcs(detail));
      appendLog(db, "enrollment", { kind: "enrollment.spent", enrollment: enrollmentId, enrollment_kind: kind, invite_id: invite.invite_id, member_id: memberId, agent: body.agent }, now);
      return { kind, enrollment_id: enrollmentId, member_id: memberId, agent: body.agent, status: "pending", owner_line: outboxId };
    });
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    recordFailure(db, invite, kind, error, sourceIp, now);
    throw error.error;
  }
}
