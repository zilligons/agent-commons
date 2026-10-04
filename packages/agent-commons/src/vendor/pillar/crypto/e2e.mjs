/**
 * End-to-end payload encryption — FUNDAMENTAL, not optional.
 *
 * Every envelope's payload is sealed to the recipient's key.  There is no
 * plaintext mode.  A carrier (or any relay) sees only ciphertext.
 *
 * Construction (sealed box over the agent's existing Ed25519 identity):
 *   1. Recipient's Ed25519 public key  --birational map-->  X25519 public key
 *      (libsodium crypto_sign_ed25519_pk_to_curve25519 equivalent;
 *       @noble/curves ed25519.utils.toMontgomery)
 *   2. Sender mints an EPHEMERAL X25519 keypair per envelope (forward secrecy
 *      per message: compromising the sender's long-term key never decrypts
 *      past traffic; compromising the recipient's does — that's the classic
 *      sealed-box tradeoff, addressed by key rotation policy, not this layer).
 *   3. shared = X25519(ephemeralPriv, recipientX25519Pub)
 *   4. key = HKDF-SHA256(shared, salt = epk || recipientX25519Pub,
 *                        info = "uuaid-pillar-e2e/1")  -> 32 bytes
 *   5. AES-256-GCM(key, iv = random 12 bytes) over JCS(payload)
 *      AAD = envelope id  (binds ciphertext to THIS envelope; a ciphertext
 *      transplanted into another envelope fails the GCM tag).
 *
 * Identity binding: callers MUST verify sha256(recipientEdPub) derives the
 * recipient's UUAID local-id before sealing (seal() in envelope.mjs does it).
 */
import { createHash, createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { jcs } from "../identity/jcs.mjs";

export const E2E_ALG = "x25519-hkdf-sha256-aes256gcm";
const HKDF_INFO = "uuaid-pillar-e2e/1";

/** Convert an Ed25519 public key (hex) to its X25519 (Montgomery) form. */
export function edPubToX25519(edPubHex) {
  return Buffer.from(ed25519.utils.toMontgomery(Buffer.from(edPubHex, "hex")));
}

/** Convert an Ed25519 seed (32 raw private bytes) to an X25519 secret. */
export function edSeedToX25519(seed32) {
  return Buffer.from(ed25519.utils.toMontgomerySecret(seed32));
}

function deriveKey(shared, epk, recipientXPub) {
  const salt = Buffer.concat([epk, recipientXPub]);
  return Buffer.from(hkdfSync("sha256", shared, salt, HKDF_INFO, 32));
}

/**
 * Seal a payload object to a recipient's Ed25519 public key.
 * Returns the `enc` block for the envelope.
 */
export function sealPayload(recipientEdPubHex, payload, { aad }) {
  if (!aad) throw new Error("sealPayload: aad (envelope id) required");
  const recipientXPub = edPubToX25519(recipientEdPubHex);
  const ephemeralSecret = randomBytes(32);
  const epk = Buffer.from(x25519.getPublicKey(ephemeralSecret));
  const shared = Buffer.from(x25519.getSharedSecret(ephemeralSecret, recipientXPub));
  const key = deriveKey(shared, epk, recipientXPub);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf-8"));
  const plaintext = Buffer.from(jcs(payload), "utf-8");
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: E2E_ALG,
    epk: epk.toString("hex"),
    iv: iv.toString("hex"),
    ct: Buffer.concat([ct, tag]).toString("hex"), // tag appended, last 16 bytes
  };
}

/**
 * Open a sealed payload with the recipient's Ed25519 seed (32 bytes).
 * Throws on any integrity failure (wrong key, tamper, transplanted aad).
 */
export function openPayload(recipientSeed32, enc, { aad }) {
  if (!enc || enc.alg !== E2E_ALG) throw new Error(`openPayload: unsupported alg ${enc?.alg}`);
  if (!aad) throw new Error("openPayload: aad (envelope id) required");
  const xSecret = edSeedToX25519(recipientSeed32);
  const recipientXPub = Buffer.from(x25519.getPublicKey(xSecret));
  const epk = Buffer.from(enc.epk, "hex");
  const shared = Buffer.from(x25519.getSharedSecret(xSecret, epk));
  const key = deriveKey(shared, epk, recipientXPub);
  const raw = Buffer.from(enc.ct, "hex");
  const ct = raw.subarray(0, raw.length - 16);
  const tag = raw.subarray(raw.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(enc.iv, "hex"));
  decipher.setAAD(Buffer.from(aad, "utf-8"));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plaintext.toString("utf-8"));
}

/** sha256 helper for identity binding checks. */
export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
