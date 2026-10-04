/**
 * Tier grants — carrier-side volume/size flexibility for qualified identities.
 *
 * Foundations, orgs, and enterprise supporters that pass the UUAID
 * qualification process receive a SIGNED TIER GRANT: a portable JSON object,
 * Ed25519-signed by a trusted issuer (the UUAID Foundation identity, or any
 * issuer a carrier operator chooses to trust).  Carriers verify the signature
 * and expiry locally — no registry lookup, no account, consistent with the
 * self-authenticating design.  The wire API is unchanged: a grant only
 * raises the holder's rate/size budgets at carriers that trust the issuer.
 *
 * Qualification has two routes. The original is off-wire: the foundation's
 * review process decides WHO gets a grant. The second is earned on-wire —
 * operators who keep a public seed alive are promoted by the seed registry
 * (net/seed-registry.mjs) and issued a grant automatically, no review. This
 * module only makes grants unforgeable and portable; it does not care which
 * route produced one.
 *
 * Grant shape (JCS-signed over every field except `sig`):
 *   { v: 1, uuaid, tier, envelopesPerMin, maxBodyBytes, expires, issuer, sig }
 *   ...plus optional { priority: true, seedTier, seedUrl } on earned grants.
 *
 * `priority` is the wire half of priority delivery: a carrier that trusts the
 * issuer admits the holder from a reserved lane when it is otherwise shedding
 * load. It is inside the signed body, so it cannot be added to a grant after
 * issue. Older carriers that predate the field verify such a grant unchanged
 * (JCS covers whatever keys are present) and simply ignore the privilege.
 */
import { createHash } from "node:crypto";
import { jcs } from "./jcs.mjs";
import { Keychain } from "./keychain.mjs";

/** Tier ladder. community = the unauthenticated default (F2 hardening values).
 *
 *  Greek-order names (Doric, Ionic, Corinthian) are ALIASES for the lower
 *  three rungs of the canonical ladder. They were added 2026-09-19 so that
 *  grants may carry a feature-tier name — Doric = pillar core only,
 *  Ionic = + plinth mix hops, Corinthian = + full optional stack — while
 *  the carrier still enforces a single budget table. A grant with
 *  `tier: "Doric"` and a grant with `tier: "community"` resolve to the same
 *  rate/size budget; carriers verify by `TIER_DEFAULTS[grant.tier]` and
 *  never see the difference.
 *
 *  Aliasing is additive — the canonical five names still work, no carrier
 *  upgrade required. Enterprise and foundation keep their original names
 *  (no alias needed; they are not feature-presence markers).
 *
 *  Adding a new alias is a one-line change here: spread the budget object
 *  under the new key. No other file needs to know.
 */
const _CANONICAL_TIERS = {
  community:  { envelopesPerMin: 120,  maxBodyBytes: 512 * 1024 },
  supporter:  { envelopesPerMin: 300,  maxBodyBytes: 1024 * 1024 },
  org:        { envelopesPerMin: 600,  maxBodyBytes: 2 * 1024 * 1024 },
  enterprise: { envelopesPerMin: 1200, maxBodyBytes: 2 * 1024 * 1024 },
  foundation: { envelopesPerMin: 3000, maxBodyBytes: 2 * 1024 * 1024 },
};

export const TIER_DEFAULTS = {
  ..._CANONICAL_TIERS,
  Doric:      _CANONICAL_TIERS.community,    // alias of community
  Ionic:      _CANONICAL_TIERS.supporter,    // alias of supporter
  Corinthian: _CANONICAL_TIERS.org,          // alias of org
};

/** Hard ceiling any grant can reach — also the carrier's raw-body stream cap. */
export const ABSOLUTE_MAX_BODY = 2 * 1024 * 1024;
export const ABSOLUTE_MAX_RATE = 6000;

function signable(grant) {
  const { sig, ...rest } = grant;
  return jcs(rest);
}

/**
 * Issue a grant, signed by the loaded keychain (the issuer identity).
 * Rates/sizes default from the tier ladder; explicit overrides are clamped
 * to the absolute ceilings.
 */
export function makeTierGrant(keychain, { uuaid, tier, envelopesPerMin, maxBodyBytes, expires, priority, seedTier, seedUrl }) {
  if (!TIER_DEFAULTS[tier]) throw new Error(`unknown tier "${tier}" (${Object.keys(TIER_DEFAULTS).join("|")})`);
  if (!uuaid?.startsWith("uuaid:")) throw new Error("grant subject must be a uuaid:...");
  if (!expires || !Number.isFinite(Date.parse(expires))) throw new Error("expires must be an ISO date");
  const grant = {
    v: 1,
    uuaid,
    tier,
    envelopesPerMin: Math.min(envelopesPerMin ?? TIER_DEFAULTS[tier].envelopesPerMin, ABSOLUTE_MAX_RATE),
    maxBodyBytes: Math.min(maxBodyBytes ?? TIER_DEFAULTS[tier].maxBodyBytes, ABSOLUTE_MAX_BODY),
    expires,
    issuer: keychain._identity.publicKeyHex,
    // Optional fields are omitted rather than set false/null so that a plain
    // grant's signed body stays byte-identical to what pre-priority issuers
    // produced.
    ...(priority ? { priority: true } : {}),
    ...(seedTier ? { seedTier } : {}),
    ...(seedUrl ? { seedUrl } : {}),
  };
  grant.sig = keychain.sign(Buffer.from(signable(grant), "utf-8")).toString("hex");
  return grant;
}

/**
 * Verify a grant against a set of trusted issuer pubkeys (hex).
 * Returns { ok: true, grant } or { ok: false, reason }.
 */
export function verifyTierGrant(grant, trustedIssuers, now = Date.now()) {
  if (grant?.v !== 1) return { ok: false, reason: "bad-version" };
  if (!TIER_DEFAULTS[grant.tier]) return { ok: false, reason: "unknown-tier" };
  if (!trustedIssuers?.includes(grant.issuer)) return { ok: false, reason: "untrusted-issuer" };
  const exp = Date.parse(grant.expires);
  if (!Number.isFinite(exp) || exp < now) return { ok: false, reason: "expired" };
  if (!(grant.envelopesPerMin <= ABSOLUTE_MAX_RATE) || !(grant.maxBodyBytes <= ABSOLUTE_MAX_BODY)) {
    return { ok: false, reason: "over-ceiling" };
  }
  // Fail closed on a malformed privilege: `priority` is either absent or the
  // boolean true. Anything else (a truthy string, 1, an object) is a grant we
  // do not understand, and understanding it wrongly grants a reserved lane.
  if ("priority" in grant && grant.priority !== true) return { ok: false, reason: "bad-priority" };
  let verified = false;
  try {
    verified = Keychain.verifyDetached(grant.issuer, Buffer.from(signable(grant), "utf-8"), Buffer.from(grant.sig, "hex"));
  } catch (_e) { return { ok: false, reason: "verify-threw" }; }
  if (!verified) return { ok: false, reason: "bad-signature" };
  return { ok: true, grant };
}

export function grantFingerprint(grant) {
  return createHash("sha256").update(signable(grant)).digest("hex").slice(0, 16);
}
