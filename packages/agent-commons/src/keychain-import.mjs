// Bring your own key: an agent that already has a Pillar keychain (a foundation,
// pillar or agentnet agent key) enters Agent Commons with that key and keeps its
// UUAID, instead of minting a new one.
//
// The source keychain is only ever read; it is never re-saved. Every check runs
// before the Agent Commons home is touched, so a failed import leaves nothing
// behind that would block a retry. Errors name the problem, never key material,
// passphrases or file contents.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDecipheriv, createPrivateKey, createPublicKey, scryptSync } from "node:crypto";
import { Keychain, localIdFromKey } from "./pillar.mjs";
import { homePath, initialize } from "./config.mjs";
import { SELF_CERTIFYING_NAMESPACES, keyBindsAgentUuaid } from "./uuaid-namespace.mjs";

// The Pillar CLI reads its keychain passphrase from PILLAR_PASSPHRASE and uses ""
// when it is unset (bin/pillar.mjs: `process.env.PILLAR_PASSPHRASE ?? ""`).
export const DEFAULT_IMPORT_PASSPHRASE_ENV = "PILLAR_PASSPHRASE";

// Keychain file versions. Version 1 (HKDF-SHA256) is what the vendored Pillar 2.2.0
// Keychain reads and writes. Version 2 (scrypt) is what @uuaid/pillar >= 2.5.3 writes
// for a key saved under a non-empty passphrase; the vendored Keychain cannot open it,
// so it is opened here with the same KDF bounds as upstream (src/identity/keychain.mjs).
const KEYCHAIN_V1 = 1;
const KEYCHAIN_V2_SCRYPT = 2;
const SCRYPT_LIMITS = Object.freeze({ minN: 16384, maxN: 1048576, maxR: 32, maxP: 16, maxMem: 512 * 1024 * 1024 });
const KEYCHAIN_CIPHER = "aes-256-gcm";
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function importError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readSourceBlob(path) {
  if (!existsSync(path)) throw importError("IMPORT_SOURCE_MISSING", `source keychain not found at ${path}`);
  let blob;
  // The parse error is not passed on: its message quotes the file's contents.
  try { blob = JSON.parse(readFileSync(path, "utf8")); } catch { throw importError("IMPORT_SOURCE_MALFORMED", `source keychain at ${path} is not a readable Pillar keychain (not JSON)`); }
  if (blob === null || typeof blob !== "object" || Array.isArray(blob)
    || typeof blob.uuaid !== "string" || typeof blob.salt !== "string" || typeof blob.iv !== "string"
    || typeof blob.ciphertext !== "string" || typeof blob.tag !== "string") {
    throw importError("IMPORT_SOURCE_MALFORMED", `source keychain at ${path} is not a Pillar keychain (missing uuaid, salt, iv, ciphertext or tag)`);
  }
  return blob;
}

// Refuse what Agent Commons would never accept, by the uuaid alone. The same rules
// run again on the loaded identity, whose uuaid the key has been checked against.
function assertAgentUuaid(uuaid) {
  const parts = uuaid.split(":");
  if (parts.length !== 4 || parts[0] !== "uuaid") throw importError("IMPORT_SOURCE_MALFORMED", `source keychain uuaid ${JSON.stringify(uuaid)} is not of the form uuaid:<namespace>:<type>:<local id>`);
  if (parts[2] !== "agent") throw importError("IMPORT_NOT_AGENT", `source identity ${uuaid} is a ${parts[2]}, not an agent; only agent identities can enter Agent Commons`);
  if (!SELF_CERTIFYING_NAMESPACES.includes(parts[1])) throw importError("IMPORT_NAMESPACE", `source identity ${uuaid} is in namespace ${parts[1]}, which a key alone cannot claim; supported: ${SELF_CERTIFYING_NAMESPACES.join(", ")}`);
}

// Version 2: scrypt with the file's own parameters, inside upstream's bounds, then
// the same AES-256-GCM open and uuaid<->key integrity check as Keychain.load.
function openScryptKeychain(blob, passphrase) {
  const k = blob.kdf ?? {};
  const pow2 = Number.isInteger(k.N) && (k.N & (k.N - 1)) === 0;
  if (k.name !== "scrypt" || !pow2 || k.N < SCRYPT_LIMITS.minN || k.N > SCRYPT_LIMITS.maxN
    || !Number.isInteger(k.r) || k.r < 1 || k.r > SCRYPT_LIMITS.maxR || !Number.isInteger(k.p) || k.p < 1 || k.p > SCRYPT_LIMITS.maxP
    || 128 * k.N * k.r > SCRYPT_LIMITS.maxMem) {
    throw importError("IMPORT_SOURCE_MALFORMED", "source keychain kdf parameters are missing or out of bounds");
  }
  const key = scryptSync(Buffer.from(passphrase, "utf8"), Buffer.from(blob.salt, "hex"), 32, { N: k.N, r: k.r, p: k.p, maxmem: 128 * k.N * k.r + 16 * 1024 * 1024 });
  let seed = null, der = null;
  try {
    const decipher = createDecipheriv(KEYCHAIN_CIPHER, key, Buffer.from(blob.iv, "hex"));
    decipher.setAuthTag(Buffer.from(blob.tag, "hex"));
    seed = Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, "base64")), decipher.final()]);
    der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
    const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    const publicKey = createPublicKey(privateKey);
    const spki = publicKey.export({ type: "spki", format: "der" });
    const rawPub = spki.subarray(spki.length - 32);
    if (blob.uuaid.split(":")[3] !== localIdFromKey(rawPub)) throw new Error("keychain integrity failure: UUAID does not match keypair");
    return { uuaid: blob.uuaid, publicKey, privateKey, publicKeyHex: Buffer.from(rawPub).toString("hex"), createdAt: blob.createdAt };
  } finally {
    key.fill(0);
    seed?.fill(0);
    der?.fill(0);
  }
}

function openSource(path, blob, passphrase) {
  try {
    if (blob.version === KEYCHAIN_V1) return new Keychain(path).load({ passphrase });
    if (blob.version === KEYCHAIN_V2_SCRYPT) return openScryptKeychain(blob, passphrase);
  } catch (error) {
    if (error?.code === "IMPORT_SOURCE_MALFORMED") throw error;
    if (/integrity failure/.test(error?.message ?? "")) throw importError("IMPORT_KEY_MISMATCH", `source keychain at ${path} failed its integrity check: its uuaid does not match its key`);
    // AES-GCM authentication failure, or a damaged salt/iv/tag/ciphertext. The
    // underlying error is not passed on.
    throw importError("IMPORT_DECRYPT_FAILED", `source keychain at ${path} did not open: wrong passphrase or damaged file`);
  }
  throw importError("IMPORT_SOURCE_VERSION", `source keychain at ${path} has unsupported version ${JSON.stringify(blob.version)} (supported: ${KEYCHAIN_V1}, ${KEYCHAIN_V2_SCRYPT})`);
}

/**
 * Load an existing Pillar keychain for import into Agent Commons. Read-only: the
 * source file is never written. Requires an agent identity in foundation, pillar
 * or agentnet whose uuaid binds its key. Returns
 * { uuaid, publicKey, privateKey, publicKeyHex, createdAt }; the private key is
 * only ever a KeyObject.
 */
export function loadImportIdentity({ sourceKeychainPath, sourcePassphrase = "" } = {}) {
  if (typeof sourceKeychainPath !== "string" || sourceKeychainPath === "") throw importError("IMPORT_SOURCE_MISSING", "sourceKeychainPath is required");
  if (typeof sourcePassphrase !== "string") throw importError("IMPORT_PASSPHRASE", "sourcePassphrase must be a string");
  const path = resolve(sourceKeychainPath);
  const blob = readSourceBlob(path);
  assertAgentUuaid(blob.uuaid);
  const loaded = openSource(path, blob, sourcePassphrase);
  const identity = { uuaid: loaded.uuaid, publicKey: loaded.publicKey, privateKey: loaded.privateKey, publicKeyHex: loaded.publicKeyHex, createdAt: loaded.createdAt };
  assertAgentUuaid(identity.uuaid);
  if (!keyBindsAgentUuaid(identity.uuaid, identity.publicKeyHex)) throw importError("IMPORT_KEY_MISMATCH", `source identity ${identity.uuaid} is not bound by its key`);
  // The clear-text public key is what `pillar profile` shows; it must be the key's.
  if (blob.publicKeyHex !== undefined && blob.publicKeyHex !== identity.publicKeyHex) throw importError("IMPORT_KEY_MISMATCH", `source keychain at ${path} stores a public key that is not its private key's`);
  return identity;
}

/**
 * Create an Agent Commons home that uses an existing Pillar keychain's identity.
 * The source passphrase is read from process.env[passphraseEnv] (default
 * PILLAR_PASSPHRASE, as the Pillar CLI does; unset means ""), never from argv.
 * The new home's own key protection is unchanged: AGENT_COMMONS_PASSPHRASE, or a
 * colocated local-secret file.
 */
export function initializeFromKeychain({ home, target = "local", name = "Agent Commons", sourceKeychainPath, passphraseEnv = DEFAULT_IMPORT_PASSPHRASE_ENV, allowFileProtection = false } = {}) {
  if (typeof passphraseEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(passphraseEnv)) throw importError("IMPORT_PASSPHRASE", "passphraseEnv must be an environment variable name; nothing was written");
  const resolvedHome = homePath(home);
  if (existsSync(join(resolvedHome, "config.json")) || existsSync(join(resolvedHome, "identity.json"))) {
    throw importError("IMPORT_HOME_EXISTS", `Home already initialized or contains an identity at ${resolvedHome}; existing identity was not overwritten and nothing was imported`);
  }
  const sourcePassphrase = process.env[passphraseEnv] ?? "";
  let identity;
  try {
    identity = loadImportIdentity({ sourceKeychainPath, sourcePassphrase });
  } catch (error) {
    error.message = `${error.message}; the Agent Commons home was not created or changed`;
    throw error;
  }
  // Custody (RedTeam Q3, holder gap 4): a passphrase-protected key must not silently become a file-permission-only
  // copy. Without AGENT_COMMONS_PASSPHRASE the import is refused unless the caller explicitly accepts the downgrade.
  // Checked before initialize(), so a refusal leaves no home behind.
  const downgrade = sourcePassphrase !== "" && !process.env.AGENT_COMMONS_PASSPHRASE;
  if (downgrade && allowFileProtection !== true) {
    throw importError("IMPORT_PROTECTION_DOWNGRADE", "the source key is passphrase-protected; set AGENT_COMMONS_PASSPHRASE so the imported copy stays passphrase-protected, or pass --allow-file-protection to accept file-permission protection with a colocated local-secret file; the Agent Commons home was not created");
  }
  const result = initialize({ home: resolvedHome, target, name, identity });
  const warnings = [];
  if (downgrade) {
    warnings.push("the source key was passphrase-protected; by --allow-file-protection the imported copy is protected only by file permissions and a colocated local-secret file.");
  }
  return { ...result, importedFrom: resolve(sourceKeychainPath), passphraseEnv, warnings };
}
