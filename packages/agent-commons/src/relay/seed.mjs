// Cloud Commons relay: the seed bundle (spec v3.4.5 section 8, B5-B7, R5; N22 custody).
//
// The seed bundle is the public bootstrap document a member reads with a signed GET /v1/seed. It
// holds no secret: never a key seed, private key, invite secret, passphrase, provider key, operator
// token or another member's id. It is signed by the relay key (Ed25519 over JCS of every field but
// `sig`) and expires within 30 days; status is still checked on every request, so expiry is a hygiene
// bound, not the revocation mechanism. Only these four values cross a reset: the key seed, `agent`,
// `relay.origin` and `relay.public_key`; everything else comes back from GET /v1/seed.
//
// `rules` and `reconnect` name the two documents in ./docs by sha256. The agent acts only on a
// rules document whose hash matches the bundle (the reference client ships the same files).

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { jcs } from "../pillar.mjs";
import { RelayError } from "./records.mjs";
import { ROUTES } from "./routes.mjs";
import { verifyBytesStrict } from "./auth.mjs";

export const SEED_BUNDLE_V = "commons-relay-seed-bundle/1";
export const RELAY_PROTOCOL = "commons-relay/1";
export const SEED_BUNDLE_TTL_MS = 30 * 86400000;
const doc = (name) => readFileSync(new URL(`./docs/${name}`, import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** The working-rules document (R2 and R4 restated, the authority invariant, the dedicated-key rule). */
export const RULES = Object.freeze({ ref: "commons-relay/working-rules/1", version: 1, file: "working-rules-v1.md", sha256: sha(doc("working-rules-v1.md")) });
/** The reconnect procedure (11.5). */
export const RECONNECT = Object.freeze({ ref: "commons-relay/reconnect/1", file: "reconnect-v1.md", sha256: sha(doc("reconnect-v1.md")) });
/** The member endpoints (6.5): every signed route outside /v1/fleet/. */
export const MEMBER_ENDPOINTS = Object.freeze(ROUTES.filter(r => r.auth === "signed" && r.principal === "member").map(r => `${r.method} ${r.path}`));
/** Every field a seed bundle may hold (N22: a custody test covers each). */
export const SEED_BUNDLE_FIELDS = Object.freeze(["v", "relay", "namespace", "member", "rules", "board", "reconnect", "issued_at", "expires_at", "sig"]);

/** The unsigned bundle for an active member, read from the relay's own tables. */
export function seedBundleBody(db, memberId, { aud, relayPublicKey, now }) {
  const m = db.prepare(`SELECT m.member_id, m.status, m.role, p.lane FROM members m JOIN member_profiles p USING(member_id) WHERE m.member_id = ?`).get(memberId);
  if (!m || m.status !== "active") throw new RelayError("unauthorized", 401);
  const keys = db.prepare("SELECT agent FROM keys WHERE principal_kind = 'member' AND principal_id = ? AND status = 'active'").all(memberId);
  if (keys.length !== 1) throw new RelayError("unauthorized", 401);
  return {
    v: SEED_BUNDLE_V,
    relay: { origin: aud, public_key: relayPublicKey, protocol: RELAY_PROTOCOL },
    namespace: "agentnet",
    member: { member_id: m.member_id, agent: keys[0].agent, role: m.role },
    rules: { sha256: RULES.sha256, ref: RULES.ref, version: RULES.version },
    board: { lane: m.lane, endpoints: [...MEMBER_ENDPOINTS] },
    reconnect: { sha256: RECONNECT.sha256, ref: RECONNECT.ref },
    issued_at: now,
    expires_at: now + SEED_BUNDLE_TTL_MS,
  };
}

/** Sign a bundle body with the relay key seed (held by the relay only). */
export function signSeedBundle(body, relaySeedHex) {
  const sig = Buffer.from(ed25519.sign(Buffer.from(jcs(body), "utf8"), Buffer.from(relaySeedHex, "hex"))).toString("hex");
  return { ...body, sig };
}

/**
 * The client's check (8, B7): the relay key pinned in the invite or carried across a reset, byte for
 * byte; strict Ed25519 over JCS(bundle minus sig); the version, protocol and namespace; the origin; not
 * expired; the expiry within 30 days of issue; and, when given, the expected member and agent.
 */
export function verifySeedBundle(bundle, relayPublicKey, { aud, now, member_id, agent } = {}) {
  const problems = [];
  if (!bundle || typeof bundle !== "object") return { ok: false, problems: ["not-an-object"] };
  for (const k of Object.keys(bundle)) if (!SEED_BUNDLE_FIELDS.includes(k)) problems.push(`unknown-field:${k}`);
  const { sig, ...body } = bundle;
  let bytes = null;
  try { bytes = Buffer.from(jcs(body), "utf8"); } catch { problems.push("not-jcs"); }
  if (!bytes || !verifyBytesStrict(relayPublicKey, bytes, sig)) problems.push("bad-signature");
  if (bundle.relay?.public_key !== relayPublicKey) problems.push("relay-key-mismatch");
  if (bundle.v !== SEED_BUNDLE_V || bundle.relay?.protocol !== RELAY_PROTOCOL || bundle.namespace !== "agentnet") problems.push("version");
  if (aud !== undefined && bundle.relay?.origin !== aud) problems.push("origin-mismatch");
  if (!Number.isSafeInteger(bundle.issued_at) || !Number.isSafeInteger(bundle.expires_at) || bundle.expires_at <= bundle.issued_at
      || bundle.expires_at - bundle.issued_at > SEED_BUNDLE_TTL_MS) problems.push("validity");
  if (now !== undefined && !(now < bundle.expires_at)) problems.push("expired");
  if (member_id !== undefined && bundle.member?.member_id !== member_id) problems.push("member-mismatch");
  if (agent !== undefined && bundle.member?.agent !== agent) problems.push("agent-mismatch");
  return { ok: problems.length === 0, problems };
}

/** The local copy of a document the bundle names, accepted only if its sha256 matches (the agent acts on nothing else). */
export function trustedDocument(bundleEntry, which = RULES) {
  const bytes = doc(which.file);
  if (!bundleEntry || bundleEntry.sha256 !== sha(bytes) || bundleEntry.ref !== which.ref) throw new RelayError("document-mismatch", 400, which.ref);
  return bytes.toString("utf8");
}
