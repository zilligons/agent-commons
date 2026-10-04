/**
 * Refusals in agent language: every refusal is a stable `code` plus one
 * imperative `fix` line, and the CLIs print exactly `<code>: <fix>`.
 *
 * The carrier's codes are the `reason` (refused send) or `error` (refused
 * inbox read) values it has always sent (carrier-server.mjs, envelope.mjs,
 * delegation.mjs). Those values and their status codes never change here;
 * the carrier only ADDS a `fix` field, and a client talking to an older
 * carrier looks the fix up in this same map. The blob broker sends its own
 * `code` + `fix`, which is printed as received.
 *
 * CLOSED AND STATIC. Every fix this package produces is a value of
 * REFUSAL_FIXES: a fixed string, never built from request data, a remote
 * reason or an exception message. A parameterised reason
 * (`delegation-invalid:<why>`, `bad-version <v>`, `alg-not-active:<alg>`)
 * resolves by its family key, so the parameter never reaches the fix.
 *
 * Documented, with statuses, in HOSTING-LIMITS.md "Refusal codes".
 */

const RESEAL = "re-seal the envelope with seal() from @uuaid/pillar or @uuaid/pillar-client; this one does not verify";

/** code -> one-line fix. Frozen: add, never rename, never interpolate. */
export const REFUSAL_FIXES = Object.freeze({
  // Carrier, POST /v1/envelopes
  "rate-limited": "back off: budgets refill over a sliding 60 s, so retry after 5 s, doubling to 60 s",
  "body-too-large": "send the payload as a blob (pillar-blob send); maxBodyBytes is your tier's inline limit",
  "stale-envelope": "seal a new envelope and check your clock; createdAt must be within 24 h of carrier time",
  "carrier-full": "use your other carriers and do not retry this one soon; its store is full",
  "bad-recipient": "address the envelope to a full UUAID (uuaid:<namespace>:<type>:<id>)",
  "bad-json": "POST the envelope as one JSON object",
  "keyId-sender-mismatch": "sign with transportSignature.keyId equal to the sender UUAID, or send under a delegation",
  "publicKey-sender-mismatch": "send from the UUAID your signing key derives, or attach the principal's delegation",
  "bad-signature": "sign again with this identity's own key over the exact bytes; the signature does not verify",
  "delegation-invalid": "mint a fresh delegation from the principal, then resend",
  // Carrier, envelope shape and crypto (envelope.mjs open()): one fix for all
  "not-object": RESEAL,
  "bad-version": RESEAL,
  "missing-or-bad-alg": RESEAL,
  "alg-not-active": RESEAL,
  "bad-publicKey": RESEAL,
  "bad-signature-encoding": RESEAL,
  "missing-enc": RESEAL,
  "enc-alg-not-supported": RESEAL,
  "enc-alg-not-active": RESEAL,
  "bad-epk": RESEAL,
  "bad-iv": RESEAL,
  "bad-ct": RESEAL,
  "bad-canonical": RESEAL,
  "verify-threw": RESEAL,
  // Carrier, GET /v1/inbox/<uuaid>
  "missing-auth-headers": "send x-pillar-pubkey, x-pillar-ts and x-pillar-sig",
  "bad-pubkey": "send x-pillar-pubkey as the raw Ed25519 key in 64 hex characters",
  "bad-sig-encoding": "send x-pillar-sig as 128 hex characters",
  "clock-skew": "fix your clock (NTP) to within 5 min of the carrier; retrying does not help",
  "uuaid-pubkey-mismatch": "read the inbox of the UUAID your key derives, or send that UUAID's delegation in x-pillar-delegation",
  "delegation-unparseable": "send x-pillar-delegation as the JSON delegation document",
  "delegation-too-large": "send a delegation document under 8,192 bytes",
  "delegation-principal-mismatch": "use a delegation whose principal is the inbox UUAID",
  "delegation-delegate-key-mismatch": "sign with the key the delegation names as delegate",
  "delegation-inbox-denied": "ask the principal for a delegation that covers inbox (or *)",
  "busy": "retry after at least 2 s with jitter, or poll with wait=0 for a while",
  // Carrier, any route
  "not-found": "use POST /v1/envelopes or GET /v1/inbox/<uuaid>",
  "not-a-seed": "do not list this carrier as a seed; it runs without a seed identity",
  "internal-error": "retry later; if it repeats, tell the carrier operator",
  // Client side: no server gave a code
  "carrier-unreachable": "check the carrier URLs and your network, then retry",
  "carrier-bad-response": "retry, or use another carrier; the carrier or its proxy answered without a reason",
  "over-tier-limit": "send the payload as a blob (pillar-blob send, or Pillar.sendBlob)",
  "blob-key-unproven": "use a uuaid:foundation:agent UUAID derived from this key (pillar init), or get a registry badge that names this key",
  "sender-key-not-active": "ask the sender to send from a uuaid:foundation:agent UUAID derived from its own key, or to get a registry badge naming its key",
});

/**
 * The fix for a carrier reason, or null for a reason this map does not know.
 * An exact key wins; otherwise the reason's family (the part before the
 * first ":" or space) is looked up, so `delegation-invalid:expired` and
 * `bad-version 2` resolve to their family's fix. The result is always a
 * value of REFUSAL_FIXES or null; nothing from `reason` is copied into it.
 */
export function carrierFix(reason) {
  if (typeof reason !== "string" || !reason) return null;
  if (Object.hasOwn(REFUSAL_FIXES, reason)) return REFUSAL_FIXES[reason];
  const family = reason.split(/[: ]/, 1)[0];
  return family !== reason && Object.hasOwn(REFUSAL_FIXES, family) ? REFUSAL_FIXES[family] : null;
}

/**
 * A carrier response body with its `fix` added. Pure addition: only a
 * refusal (status >= 400) that names a `reason` or `error` and has no `fix`
 * yet gains one; every other field, and every other body, is returned as is.
 */
export function withCarrierFix(status, body) {
  if (!(status >= 400) || !body || typeof body !== "object" || Array.isArray(body) || body.fix !== undefined) return body;
  const fix = carrierFix(typeof body.reason === "string" ? body.reason : body.error);
  return fix ? { ...body, fix } : body;
}

/**
 * Terminal safety only: a line break or control character a remote sent
 * becomes a space, so the output stays one line and cannot drive the
 * terminal. Every other character is printed as received.
 */
function oneLine(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
}

/**
 * `<code>: <fix>` for an error that carries both (a carrier or broker
 * refusal, or a client error that knows its next step), else null so the
 * caller keeps its old output. A server's fix is printed as received.
 */
export function refusalLine(error) {
  const code = typeof error?.code === "string" ? oneLine(error.code) : "";
  const fix = typeof error?.fix === "string" ? oneLine(error.fix) : "";
  return code && fix ? `${code}: ${fix}` : null;
}

/** `{ code, fix }` of an error, for a result row, omitting what is absent. */
export function refusalFields(error) {
  return {
    ...(typeof error?.code === "string" && error.code ? { code: error.code } : {}),
    ...(typeof error?.fix === "string" && error.fix ? { fix: error.fix } : {}),
  };
}
