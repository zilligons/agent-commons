/**
 * Keychain — persistent identity for a pillar peer.
 *
 * Every agent has exactly one identity: an Ed25519 keypair.  The private key
 * is stored encrypted at rest with a password derived from the OS keyring
 * (Windows Credential Manager / macOS Keychain / GNOME libsecret) if
 * available, or a user-supplied passphrase otherwise.
 *
 * The keychain is deliberately simple: one keypair, one UUAID, one file.
 * Rotation is a new keypair + a new signed profile in the DHT.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, createHash, generateKeyPairSync, sign, verify, createPublicKey, createPrivateKey, hkdfSync, createCipheriv, createDecipheriv } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";

const KEYCHAIN_VERSION = 1;

/**
 * RFC 8032 / FIPS 186-5 rule for an Ed25519 public key: the canonical encoding
 * of a point that is not of small order and lies in the prime-order subgroup.
 *
 * OpenSSL's Ed25519 verify (node `crypto.verify`) does not check this: it uses
 * the non-cofactored equation, and 5 of the 8 small-order points verify as
 * keys. With the identity point as the key, R = identity and S = 0 verifies on
 * every message, so anyone could forge a signature "from" that key's uuaid
 * (found 2026-10-06). The same rule as `isStrictEd25519PublicKey` in
 * @uuaid/pillar-client.
 *
 * The answer depends on the key alone, so it is cached (bounded).
 */
const STRICT_KEY_CACHE_MAX = 4096;
const strictKeyCache = new Map();

export function isStrictEd25519PublicKey(publicKeyHex) {
  if (typeof publicKeyHex !== "string" || !/^[0-9a-f]{64}$/i.test(publicKeyHex)) return false;
  const hex = publicKeyHex.toLowerCase();
  const cached = strictKeyCache.get(hex);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    const point = ed25519.Point.fromHex(hex, false);
    ok = point.toHex() === hex && !point.isSmallOrder() && point.isTorsionFree();
  } catch (_e) {
    ok = false;
  }
  if (strictKeyCache.size >= STRICT_KEY_CACHE_MAX) strictKeyCache.delete(strictKeyCache.keys().next().value);
  strictKeyCache.set(hex, ok);
  return ok;
}

/**
 * Derive a stable, publishable local id from a raw Ed25519 public key.  This
 * makes the UUAID self-authenticating: given the UUAID, anyone can
 * independently check that the public key hashes to the expected local-id.
 *
 * Public because consumers verifying a UUAID against a public key need it
 * without reaching into `Keychain._localIdFromKey`.
 */
export function localIdFromKey(rawPub) {
  const h = createHash("sha256").update(rawPub).digest();
  // First 16 bytes -> UUID-style dash format for readability.
  const b = h.slice(0, 16);
  const hex = Buffer.from(b).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export class Keychain {
  constructor(path) {
    this.path = path;
    this._identity = null; // { uuaid, publicKeyHex, privateKey (KeyObject), createdAt }
  }

  exists() {
    return existsSync(this.path);
  }

  /**
   * Generate a fresh identity.  Never overwrites.
   *
   * uuaidNamespace: default "foundation" per IAASO-1001 today; will support
   * federated forms once federation profile ratifies.
   * objectType: default "agent"; overridable to "service" etc.
   * localId: default random UUIDv4-like; caller may supply.
   */
  static generate({ uuaidNamespace = "foundation", objectType = "agent", localId = null } = {}) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubDer = publicKey.export({ type: "spki", format: "der" });
    const rawPub = pubDer.slice(pubDer.length - 32);
    const localIdActual = localId ?? Keychain._localIdFromKey(rawPub);
    const uuaid = `uuaid:${uuaidNamespace}:${objectType}:${localIdActual}`;
    return {
      uuaid,
      publicKey,
      privateKey,
      publicKeyHex: Buffer.from(rawPub).toString("hex"),
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Derive the local-id from a raw Ed25519 public key.
   *
   * Kept on the class for the call sites that already reach for it; the
   * implementation is the module-level `localIdFromKey`, which is the public
   * export.
   */
  static localIdFromKey = localIdFromKey;

  /** @deprecated Alias kept for compatibility — use `localIdFromKey`. */
  static _localIdFromKey = localIdFromKey;

  /**
   * Load an identity from disk.
   */
  load({ passphrase } = {}) {
    if (!this.exists()) throw new Error("keychain not initialized; run `pillar init` first");
    const blob = JSON.parse(readFileSync(this.path, "utf-8"));
    if (blob.version !== KEYCHAIN_VERSION) throw new Error(`unsupported keychain version ${blob.version}`);
    const salt = Buffer.from(blob.salt, "hex");
    const key = hkdfSync("sha256", Buffer.from(passphrase ?? "", "utf-8"), salt, "uuaid-pillar-keychain-v1", 32);
    const iv = Buffer.from(blob.iv, "hex");
    const ct = Buffer.from(blob.ciphertext, "base64");
    const tag = Buffer.from(blob.tag, "hex");
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    const seed = plain; // 32-byte raw ed25519 seed
    const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
    const privateKey = createPrivateKey({ key: Buffer.concat([pkcs8Prefix, seed]), format: "der", type: "pkcs8" });
    const publicKey = createPublicKey(privateKey);
    const pubDer = publicKey.export({ type: "spki", format: "der" });
    const rawPub = pubDer.slice(pubDer.length - 32);
    const publicKeyHex = Buffer.from(rawPub).toString("hex");
    // Sanity: derived UUAID must match stored UUAID.
    const derivedLocalId = Keychain._localIdFromKey(rawPub);
    const parts = blob.uuaid.split(":");
    if (parts.length < 4 || parts[3] !== derivedLocalId) {
      throw new Error("keychain integrity failure: UUAID does not match keypair");
    }
    this._identity = { uuaid: blob.uuaid, publicKey, privateKey, publicKeyHex, createdAt: blob.createdAt };
    return this._identity;
  }

  /**
   * Save identity to disk, encrypted with the passphrase.
   */
  save(identity, { passphrase } = {}) {
    const seedDer = identity.privateKey.export({ type: "pkcs8", format: "der" });
    const seed = seedDer.slice(seedDer.length - 32);
    const salt = randomBytes(16);
    const key = hkdfSync("sha256", Buffer.from(passphrase ?? "", "utf-8"), salt, "uuaid-pillar-keychain-v1", 32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(key), iv);
    const ct = Buffer.concat([cipher.update(seed), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = {
      version: KEYCHAIN_VERSION,
      uuaid: identity.uuaid,
      createdAt: identity.createdAt,
      salt: salt.toString("hex"),
      iv: iv.toString("hex"),
      ciphertext: ct.toString("base64"),
      tag: tag.toString("hex"),
      // Public material is stored in the clear so `pillar profile` doesn't need a passphrase.
      publicKeyHex: identity.publicKeyHex,
    };
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(blob, null, 2));
    chmodSync(this.path, 0o600);
    this._identity = identity;
  }

  publicView() {
    if (!this.exists()) return null;
    const blob = JSON.parse(readFileSync(this.path, "utf-8"));
    return { uuaid: blob.uuaid, publicKeyHex: blob.publicKeyHex, createdAt: blob.createdAt };
  }

  sign(data) {
    if (!this._identity) throw new Error("identity not loaded");
    return sign(null, Buffer.isBuffer(data) ? data : Buffer.from(data, "utf-8"), this._identity.privateKey);
  }

  static verifyDetached(publicKeyHex, data, signatureBytes) {
    if (!isStrictEd25519PublicKey(publicKeyHex)) return false; // @rule keychain.strict-key
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const der = Buffer.concat([spkiPrefix, Buffer.from(publicKeyHex, "hex")]);
    const pub = createPublicKey({ key: der, format: "der", type: "spki" });
    return verify(null, Buffer.isBuffer(data) ? data : Buffer.from(data, "utf-8"), pub, signatureBytes);
  }
}
