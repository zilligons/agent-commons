/**
 * `pillar-group` v2 — signed group rosters (docs/designs/pillar-group-v2.md
 * rev 4). An independent reference: written from the spec and the shared
 * vectors' README, never from another implementation.
 *
 *   manifests   canonical bytes, hashes, strict Ed25519, the closed schema,
 *               the genesis and version n+1 checks in the vectors' check
 *               order (it decides the reason code)
 *   receiver    GroupReceiver: §5.0 unknown groups (invitation, recovery),
 *               §5.1 carried manifests, §5.2 catch-up holds, §5.3 accept,
 *               §5.4 equivocation, §5.5 removal
 *   store       pillar-group-store/2: <home>/groups-v2/grp-<32 hex>.json
 *   mailbox     after every verified write, the mailbox `groups` row of a v2
 *               group lists the active members of the verified head (minus
 *               anyone leaving); a frozen group or one that removed us is
 *               cleared. An egress filter reads that column (§8).
 *   sender      recipients and the ⌊120/(N−1)⌋ budget (§6). No send path
 *               reads this store: sends still go through the mailbox roster.
 *
 * Every receiver and manifest rule carries an `@rule <id>` marker on the one
 * line that enforces it; test/mutants/run.mjs deletes that line in a copy
 * and checks that the rule's vectors go red.
 */
import { createHash, randomBytes, sign as edSign, verify as edVerify, createPublicKey } from "node:crypto";
import {
  mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, renameSync, chmodSync, openSync, fsyncSync, closeSync,
} from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { localIdFromKey, isStrictEd25519PublicKey } from "./identity/keychain.mjs";
import { findGroup } from "./groups.mjs";

export const MANIFEST_V = "pillar-group-manifest/2";
export const STORE_V = "pillar-group-store/2";
export const MAX_MEMBERS = 256;
export const MAX_NAME = 100;          // code points
export const MAX_PURPOSE = 2000;      // code points
export const MAX_MANIFEST_BYTES = 512 * 1024;
export const MAX_ANSWER = 64;         // manifests per manifest.request answer
export const SEEN_CAP = 10_000;       // accepted (sender, msgId) pairs kept per group; the oldest go first
export const COMMUNITY_SEND_BUDGET = 120; // envelopes per minute per sender
export const DEFAULT_LIMITS = Object.freeze({ holdPerSender: 20, holdPerGroup: 100, holdMs: 600_000 });
export const ACTIONS = Object.freeze(["create", "invite", "accept", "leave", "remove", "rename", "ext_update", "admin_transfer"]);
export const V2_OPS = Object.freeze([
  "message", "manifest", "accept.request", "leave.request", "rename.request", "manifest.request", "equivocation",
]);

const ID_RE = /^grp-[0-9a-f]{32}$/;
const UUAID_RE = /^uuaid:[a-z0-9-]+:[a-z0-9-]+:[a-z0-9][a-z0-9-]*$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const ISSUED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const MSGID_RE = /^gm-[0-9a-f]{16,128}$/;
const ZERO_HASH = "0".repeat(64);
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const TOP_KEYS = ["v", "id", "version", "prev", "epoch", "name", "purpose", "members", "transition", "ext", "issuedAt", "sig"];
const TOP_REQUIRED = TOP_KEYS.filter((k) => k !== "purpose");
const MEMBER_KEYS = ["uuaid", "key", "role", "status"];
const TRANSITION_KEYS = ["action", "actor", "target", "request"];
const SIG_KEYS = ["alg", "keyId", "publicKey", "signature"];

const plain = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const closed = (o, allowed, required) =>
  plain(o) && Object.keys(o).every((k) => allowed.includes(k)) && required.every((k) => Object.hasOwn(o, k));
const codePoints = (s) => Array.from(s).length;
const no = (reason) => ({ ok: false, reason });

export function isGroupIdV2(id) { return typeof id === "string" && ID_RE.test(id); }

// ───────────────────────────────────────────── canonical JSON (RFC 8785) ──
// Keys sort by UTF-16 code units, which is what JS `<` compares (RFC 8785
// §3.2.3). The shared src/identity/jcs.mjs sorted by UTF-16LE *bytes* (wrong
// for keys at or above U+0100) until 10048e1 fixed it; this module keeps its
// own canonicalizer either way and does not use that one.
export function canonicalJson(v) {
  if (v === null) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("canonicalJson: non-finite number");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (plain(v)) {
    const keys = Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported ${typeof v}`);
}
const sha256Hex = (s) => createHash("sha256").update(Buffer.from(s, "utf-8")).digest("hex");
const without = (o, ...keys) => { const c = { ...o }; for (const k of keys) delete c[k]; return c; };

/** Genesis preimage: version 1 without `sig` and without `id` (rev 4 §2). */
export function genesisPreimage(m) { return canonicalJson(without(m, "sig", "id")); }
export function genesisHash(m) { return sha256Hex(genesisPreimage(m)); }
export function idFromGenesisHash(h) { return `grp-${h.slice(0, 32)}`; }
/** The bytes the signature covers: the manifest without `sig`. */
export function signingPreimage(m) { return canonicalJson(without(m, "sig")); }
/** Manifest hash: the full signed manifest. `prev` and `mv.hash` use it. */
export function manifestHash(m) { return sha256Hex(canonicalJson(m)); }

// ───────────────────────────────────────────── strict Ed25519 (RFC 8032) ──
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const leInt = (buf) => { let n = 0n; for (let i = buf.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(buf[i]); return n; };

/**
 * A public key a manifest may carry: the shared keychain rule (canonical, not
 * of small order, in the prime-order subgroup). A mixed-order key (an honest
 * key plus a torsion point) is refused here, not only a small-order one.
 */
export function isStrictPublicKey(hex) {
  if (typeof hex !== "string" || !HEX64.test(hex)) return false;
  if (!isStrictEd25519PublicKey(hex)) return false; // @rule M1-strict-key
  return true;
}

/** R must be a canonical encoding of a curve point (it may be of any order). */
function isCanonicalPoint(hex) {
  try { return ed25519.Point.fromHex(hex, false).toHex() === hex; } catch { return false; }
}

/** RFC 8032 verification with S < L, R canonical and on the curve, A strict. */
export function verifyEd25519Strict(publicKeyHex, message, signatureHex) {
  if (!isStrictPublicKey(publicKeyHex) || typeof signatureHex !== "string" || !HEX128.test(signatureHex)) return false;
  const sig = Buffer.from(signatureHex, "hex");
  if (leInt(sig.subarray(32)) >= L) return false;
  if (!isCanonicalPoint(signatureHex.slice(0, 64))) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
    return edVerify(null, Buffer.from(message, "utf-8"), key, sig);
  } catch { return false; }
}

/** The Pillar keychain rule, exactly: uuaid:foundation:agent:<sha256(pubkey) as a UUID>. */
export function uuaidForKey(publicKeyHex) { return `uuaid:foundation:agent:${localIdFromKey(Buffer.from(publicKeyHex, "hex"))}`; }
export function keyBindsUuaid(uuaid, publicKeyHex) {
  return isStrictPublicKey(publicKeyHex) && uuaid === uuaidForKey(publicKeyHex);
}

// ───────────────────────────────────────────── manifest checks ──

/** Step 1 of both check orders. Returns a reason, or null. */
export function checkShape(m) {
  if (!plain(m)) return "bad-shape";
  if (typeof m.v !== "string") return "bad-shape";
  if (m.v !== MANIFEST_V) return "unknown-manifest-version";
  if (!closed(m, TOP_KEYS, TOP_REQUIRED)) return "bad-shape"; // @rule M1-closed-top
  if (!ID_RE.test(m.id) || !Number.isSafeInteger(m.version) || m.version < 1) return "bad-shape";
  if (!(m.prev === null || (typeof m.prev === "string" && HEX64.test(m.prev)))) return "bad-shape";
  if (!Number.isSafeInteger(m.epoch) || m.epoch < 0) return "bad-shape";
  if (typeof m.name !== "string") return "bad-shape";
  if (Object.hasOwn(m, "purpose") && typeof m.purpose !== "string") return "bad-shape";
  if (!Array.isArray(m.members) || m.members.length === 0) return "bad-shape";
  for (const r of m.members) {
    if (!closed(r, MEMBER_KEYS, MEMBER_KEYS)) return "bad-shape"; // @rule M1-closed-member
    if (typeof r.uuaid !== "string" || !UUAID_RE.test(r.uuaid) || typeof r.key !== "string" || !HEX64.test(r.key)) return "bad-shape";
    if (!["admin", "member"].includes(r.role) || !["active", "invited", "removed"].includes(r.status)) return "bad-shape";
  }
  const t = m.transition;
  if (!closed(t, TRANSITION_KEYS, TRANSITION_KEYS) || typeof t.action !== "string" || typeof t.actor !== "string") return "bad-shape";
  if (!(t.target === null || typeof t.target === "string") || !(t.request === null || typeof t.request === "string")) return "bad-shape";
  if (!plain(m.ext)) return "bad-shape";
  if (typeof m.issuedAt !== "string" || !ISSUED_RE.test(m.issuedAt)) return "bad-shape";
  const s = m.sig;
  if (!closed(s, SIG_KEYS, SIG_KEYS) || s.alg !== "ed25519" || typeof s.keyId !== "string") return "bad-shape";
  if (typeof s.publicKey !== "string" || !HEX64.test(s.publicKey) || typeof s.signature !== "string" || !HEX128.test(s.signature)) return "bad-shape";
  let bytes;
  try { bytes = Buffer.byteLength(canonicalJson(m), "utf-8"); } catch { return "bad-shape"; }
  if (bytes > MAX_MANIFEST_BYTES) return "too-large";
  if (m.members.length > MAX_MEMBERS) return "too-many-members";
  if (codePoints(m.name) > MAX_NAME) return "name-too-long"; // @rule M1-name-code-points
  if (Object.hasOwn(m, "purpose") && codePoints(m.purpose) > MAX_PURPOSE) return "purpose-too-long"; // @rule M1-purpose-code-points
  return null;
}

function rowChecks(m) {
  for (const r of m.members) if (!keyBindsUuaid(r.uuaid, r.key)) return "key-uuaid-mismatch"; // @rule M1-key-derives
  const seen = new Set();
  for (const r of m.members) { if (seen.has(r.uuaid)) return "duplicate-uuaid"; seen.add(r.uuaid); }
  const admins = activeAdmins(m);
  if (admins.length === 0) return "no-active-admin"; // @rule M1-no-active-admin
  if (admins.length > 1) return "multiple-active-admins"; // @rule M1-multiple-admins
  return null;
}

export function activeAdmins(m) { return m.members.filter((r) => r.status === "active" && r.role === "admin"); }
/** The single active admin of a verified manifest. */
export function adminOf(m) { return activeAdmins(m)[0]; }

/** Version 1, in the vectors' check order. */
export function verifyGenesis(m) {
  const shape = checkShape(m);
  if (shape) return no(shape);
  if (m.version !== 1 || m.prev !== null) return no("not-genesis");
  if (m.id !== idFromGenesisHash(genesisHash(m))) return no("genesis-id-mismatch"); // @rule M1-genesis-id
  const rows = rowChecks(m); // steps 4-6: keys derive, unique uuaids, one active admin
  if (rows) return no(rows);
  const admin = adminOf(m);
  if (m.sig.publicKey !== admin.key) return no("signer-not-admin");
  if (m.sig.keyId !== uuaidForKey(m.sig.publicKey)) return no("keyid-mismatch");
  if (!verifyEd25519Strict(admin.key, signingPreimage(m), m.sig.signature)) return no("bad-signature"); // @rule M1-signature-genesis
  if (m.members.some((r) => r !== admin && !(r.role === "member" && r.status === "invited"))) return no("no-matching-transition");
  if (m.epoch !== 0) return no("epoch-mismatch");
  const t = m.transition;
  if (t.action !== "create" || t.actor !== admin.uuaid || t.target !== null || t.request !== null) return no("transition-mismatch");
  return { ok: true, action: "create" };
}

/**
 * Which §3 row turns `prev` into `next`? Null when none does. `actions` is a
 * list because an `active → removed` change is `leave` or `remove` by label.
 */
export function classifyChange(prev, next) {
  const A = prev.members, B = next.members;
  if (B.length !== A.length && B.length !== A.length + 1) return null;
  for (let i = 0; i < A.length; i++) {
    if (B[i].uuaid !== A[i].uuaid || B[i].key !== A[i].key) return null; // @rule M1-rows-keep-positions
  }
  const changed = [];
  for (let i = 0; i < A.length; i++) if (B[i].role !== A[i].role || B[i].status !== A[i].status) changed.push(i);
  const renamed = prev.name !== next.name || prev.purpose !== next.purpose;
  const extChanged = canonicalJson(prev.ext) !== canonicalJson(next.ext);
  if (B.length === A.length + 1) {
    const r = B[A.length];
    if (changed.length || renamed || extChanged || r.role !== "member" || r.status !== "invited") return null;
    return { actions: ["invite"], target: r.uuaid, epochDelta: 0 };
  }
  if (changed.length === 0) {
    if (renamed && !extChanged) return { actions: ["rename"], target: null, epochDelta: 0 };
    if (extChanged && !renamed) return { actions: ["ext_update"], target: null, epochDelta: 0 };
    return null;
  }
  if (renamed || extChanged) return null; // @rule M1-one-change
  if (changed.length === 1) {
    const a = A[changed[0]], b = B[changed[0]];
    if (a.role !== b.role) return null;
    if (a.status === "removed" && b.status === "invited") return { actions: ["invite"], target: b.uuaid, epochDelta: 0 };
    if (a.status === "invited" && b.status === "active") return { actions: ["accept"], target: b.uuaid, epochDelta: 0 };
    if (a.status === "active" && b.status === "removed") return { actions: ["leave", "remove"], target: b.uuaid, epochDelta: 1 };
    if (a.status === "invited" && b.status === "removed") return { actions: ["remove"], target: b.uuaid, epochDelta: 1 };
    return null;
  }
  if (changed.length === 2) {
    const [i, j] = changed;
    for (const [o, n] of [[i, j], [j, i]]) {
      const oldIsAdmin = A[o].role === "admin" && A[o].status === "active" && B[o].role === "member" && B[o].status === "active";
      const newIsAdmin = A[n].role === "member" && A[n].status === "active" && B[n].role === "admin" && B[n].status === "active";
      if (oldIsAdmin && newIsAdmin) return { actions: ["admin_transfer"], target: B[n].uuaid, epochDelta: 0 };
    }
  }
  return null;
}

/** Version n+1 against a verified version n, in the vectors' check order. */
export function verifyNext(prev, m) {
  const shape = checkShape(m);
  if (shape) return no(shape);
  if (m.id !== prev.id) return no("id-mismatch");
  if (m.version !== prev.version + 1) return no("not-next-version");
  if (m.prev !== manifestHash(prev)) return no("prev-mismatch"); // @rule M1-prev
  const pAdmin = adminOf(prev);
  if (m.sig.publicKey !== pAdmin.key) return no("signer-not-admin"); // @rule M1-signer-from-chain
  if (m.sig.keyId !== uuaidForKey(m.sig.publicKey)) return no("keyid-mismatch"); // @rule M1-keyid
  if (!verifyEd25519Strict(pAdmin.key, signingPreimage(m), m.sig.signature)) return no("bad-signature"); // @rule M1-signature
  const rows = rowChecks(m);
  if (rows) return no(rows);
  const row = classifyChange(prev, m);
  if (!row) return no("no-matching-transition");
  if (m.epoch !== prev.epoch + row.epochDelta) return no("epoch-mismatch"); // @rule M1-epoch
  const t = m.transition;
  const needsRequest = t.action === "accept" || t.action === "leave";
  if (!row.actions.includes(t.action)) return no("transition-mismatch"); // @rule M1-transition-label
  if (t.actor !== pAdmin.uuaid || t.target !== row.target) return no("transition-mismatch");
  if (needsRequest ? !(typeof t.request === "string" && t.request.length > 0) : t.request !== null) return no("transition-mismatch");
  return { ok: true, action: t.action };
}

/** Version 1 and then every version against the one before. */
export function verifyChain(chain) {
  if (!Array.isArray(chain) || chain.length === 0) return { ok: false, reason: "bad-shape", at: 0 };
  let r = verifyGenesis(chain[0]);
  if (!r.ok) return { ...r, at: 1 };
  for (let i = 1; i < chain.length; i++) {
    r = verifyNext(chain[i - 1], chain[i]);
    if (!r.ok) return { ...r, at: i + 1 };
  }
  return { ok: true, at: chain.length };
}

// ───────────────────────────────────────────── building (the admin's side) ──

function nowIso() { return new Date().toISOString(); }

/** Unsigned version 1. `members`: [{ uuaid, key }] — each becomes an invited member. */
export function buildGenesis({ name, purpose, creator, members = [], ext = {}, issuedAt = nowIso() }) {
  if (!keyBindsUuaid(creator?.uuaid, creator?.publicKeyHex)) throw new Error("buildGenesis: the creator's key does not derive its uuaid");
  const rows = [{ uuaid: creator.uuaid, key: creator.publicKeyHex, role: "admin", status: "active" }];
  for (const m of members) {
    if (!keyBindsUuaid(m.uuaid, m.key)) throw new Error(`buildGenesis: ${m.uuaid}: key does not derive its uuaid`);
    if (rows.some((r) => r.uuaid === m.uuaid)) throw new Error(`buildGenesis: ${m.uuaid} named twice`);
    rows.push({ uuaid: m.uuaid, key: m.key, role: "member", status: "invited" });
  }
  const m = {
    v: MANIFEST_V, id: "", version: 1, prev: null, epoch: 0, name,
    ...(typeof purpose === "string" ? { purpose } : {}),
    members: rows,
    transition: { action: "create", actor: creator.uuaid, target: null, request: null },
    ext, issuedAt,
  };
  m.id = idFromGenesisHash(genesisHash(m));
  return m;
}

/**
 * Unsigned version n+1. The caller signs with the admin key of `prev` and
 * should run verifyNext() before storing (the CLI does).
 */
export function buildNext(prev, action, { target = null, request = null, member = null, name, purpose, ext, issuedAt = nowIso() } = {}) {
  const admin = adminOf(prev);
  const rows = prev.members.map((r) => ({ ...r }));
  const at = (u) => { const r = rows.find((x) => x.uuaid === u); if (!r) throw new Error(`buildNext: ${u} is not in the roster`); return r; };
  let epoch = prev.epoch;
  let next = { name: prev.name, purpose: prev.purpose, ext: prev.ext };
  switch (action) {
    case "invite": {
      if (!keyBindsUuaid(member?.uuaid, member?.key)) throw new Error("buildNext invite: key does not derive its uuaid");
      const r = rows.find((x) => x.uuaid === member.uuaid);
      if (r && r.status !== "removed") throw new Error(`buildNext invite: ${member.uuaid} is already ${r.status}`);
      if (r && r.key !== member.key) throw new Error("buildNext invite: a removed row keeps its key");
      if (r) r.status = "invited"; else rows.push({ uuaid: member.uuaid, key: member.key, role: "member", status: "invited" });
      target = member.uuaid;
      break;
    }
    case "accept": { const r = at(target); if (r.status !== "invited") throw new Error("buildNext accept: not invited"); r.status = "active"; break; }
    case "leave": { const r = at(target); if (r.status !== "active") throw new Error("buildNext leave: only an active member leaves"); r.status = "removed"; epoch++; break; }
    case "remove": { const r = at(target); if (r.status === "removed") throw new Error("buildNext remove: already removed"); r.status = "removed"; epoch++; break; }
    case "rename": next = { ...next, name: name ?? prev.name, purpose: purpose === undefined ? prev.purpose : purpose }; target = null; break;
    case "ext_update": next = { ...next, ext }; target = null; break;
    case "admin_transfer": {
      const r = at(target);
      if (r.status !== "active" || r.uuaid === admin.uuaid) throw new Error("buildNext admin_transfer: target must be another active member");
      rows.find((x) => x.uuaid === admin.uuaid).role = "member";
      r.role = "admin";
      break;
    }
    default: throw new Error(`buildNext: unknown action ${action}`);
  }
  if ((action === "leave" || action === "remove") && target === admin.uuaid) throw new Error("buildNext: the admin transfers first");
  const m = {
    v: MANIFEST_V, id: prev.id, version: prev.version + 1, prev: manifestHash(prev), epoch, name: next.name,
    ...(typeof next.purpose === "string" ? { purpose: next.purpose } : {}),
    members: rows,
    transition: { action, actor: admin.uuaid, target, request: action === "accept" || action === "leave" ? request : null },
    ext: next.ext, issuedAt,
  };
  return m;
}

/** Sign with a loaded Keychain, or an identity { uuaid, publicKeyHex, privateKey }. */
export function signManifest(m, signer) {
  const id = signer?._identity ?? signer;
  if (!id?.privateKey || !id?.publicKeyHex) throw new Error("signManifest: need a loaded keychain or identity");
  const body = without(m, "sig");
  const signature = edSign(null, Buffer.from(canonicalJson(body), "utf-8"), id.privateKey).toString("hex");
  return { ...body, sig: { alg: "ed25519", keyId: uuaidForKey(id.publicKeyHex), publicKey: id.publicKeyHex, signature } };
}

// ───────────────────────────────────────────── store (pillar-group-store/2) ──

/** A store record is fine only if its chain verifies and its head matches. */
export function checkStoreRecord(rec, id = rec?.id) {
  if (!plain(rec) || rec.v !== STORE_V || rec.id !== id || !isGroupIdV2(id)) return "bad-record";
  const v = verifyChain(rec.chain);
  if (!v.ok) return `chain:${v.reason}@${v.at}`;
  const last = rec.chain[rec.chain.length - 1];
  if (last.id !== id) return "bad-record";
  if (!plain(rec.head) || rec.head.version !== last.version || rec.head.hash !== manifestHash(last)) return "head-mismatch";
  if (!(rec.frozen === null || (plain(rec.frozen) && Array.isArray(rec.frozen.manifests) && rec.frozen.manifests.length === 2))) return "bad-record";
  if (typeof rec.outOfDate !== "boolean" || !(rec.recoveredFrom === null || typeof rec.recoveredFrom === "string")) return "bad-record";
  if (!Array.isArray(rec.leaving) || !rec.leaving.every((u) => typeof u === "string")) return "bad-record";
  if (!Array.isArray(rec.seen) || !rec.seen.every((s) => typeof s === "string")) return "bad-record";
  return null;
}

export function newRecord(chain, { outOfDate = false, recoveredFrom = null } = {}) {
  const last = chain[chain.length - 1];
  return {
    v: STORE_V, id: last.id, chain: [...chain], head: { version: last.version, hash: manifestHash(last) },
    frozen: null, outOfDate, recoveredFrom, leaving: [], seen: [],
  };
}

/** <home>/groups-v2/grp-<32 hex>.json, dir 0700, file 0600, written atomically. */
export class RosterStore {
  constructor(home) { this.dir = join(home, "groups-v2"); }
  path(id) {
    if (!isGroupIdV2(id)) throw new Error(`groups-v2 store: not a v2 group id: ${id}`);
    return join(this.dir, `${id}.json`);
  }
  has(id) { return isGroupIdV2(id) && existsSync(this.path(id)); }
  list() {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => /^grp-[0-9a-f]{32}\.json$/.test(f)).map((f) => f.slice(0, -5)).sort();
  }
  /** Throws on a file it cannot read, parse or verify: a reader denies those. */
  load(id) {
    const rec = JSON.parse(readFileSync(this.path(id), "utf-8"));
    const bad = checkStoreRecord(rec, id);
    if (bad) throw new Error(`groups-v2 store ${id}: ${bad}`);
    return rec;
  }
  save(rec) {
    const bad = checkStoreRecord(rec);
    if (bad) throw new Error(`groups-v2 store ${rec?.id}: refusing to write: ${bad}`);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const p = this.path(rec.id);
    const tmp = `${p}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600, flag: "wx" });
    const fd = openSync(tmp, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, p);
  }
}

/** Same contract in memory (the vector driver, unit tests). */
export class MemoryRosterStore {
  constructor() { this.records = new Map(); }
  has(id) { return this.records.has(id); }
  list() { return [...this.records.keys()].sort(); }
  load(id) { const r = this.records.get(id); if (!r) throw new Error(`no group ${id}`); return structuredClone(r); }
  save(rec) {
    const bad = checkStoreRecord(rec);
    if (bad) throw new Error(`groups-v2 store ${rec?.id}: refusing to write: ${bad}`);
    this.records.set(rec.id, structuredClone(rec));
  }
}

// ───────────────────────────────────────────── mailbox coupling (egress filter) ──

/** Who a send seals to: the active members of the head except self and anyone leaving. */
export function recipientsOf(rec, selfUuaid) {
  if (rec.frozen) return [];
  const head = rec.chain[rec.chain.length - 1];
  return head.members.filter((r) => r.status === "active" && r.uuaid !== selfUuaid && !rec.leaving.includes(r.uuaid)).map((r) => r.uuaid);
}

/**
 * Keep the mailbox `groups` row of a v2 group true to the verified head: the
 * egress filter and v1 sendGroup read `members` from it. Called only after
 * a record was verified and written. A frozen group, or one whose head no
 * longer has us active or invited, is cleared (no members, `left`).
 * Either way the row is marked as v2's (mailbox.markGroupV2), for good.
 */
export function syncMailboxRoster(mailbox, rec, selfUuaid) {
  if (!mailbox) return;
  const head = rec.chain[rec.chain.length - 1];
  const me = head.members.find((r) => r.uuaid === selfUuaid);
  const createdBy = adminOf(rec.chain[0]).uuaid;
  if (rec.frozen || !me || me.status === "removed") {
    mailbox.putGroup({ id: rec.id, name: head.name, members: [], keys: {}, createdBy, pending: false, left: true }); // @rule MB-clear
  } else {
    const rows = head.members.filter((r) => r.status === "active" && !rec.leaving.includes(r.uuaid));
    mailbox.putGroup({
      id: rec.id, name: head.name, members: rows.map((r) => r.uuaid),
      keys: Object.fromEntries(rows.map((r) => [r.uuaid, r.key])), createdBy, pending: me.status === "invited", left: false,
    });
  }
  mailbox.markGroupV2(rec.id); // @rule MB-marker-set
}

/**
 * Re-sync the mailbox row of every group the store holds, from the verified
 * store. A crash between a store write and its mailbox write leaves the row a
 * superset of the head (a removed member still listed); this repairs it. A
 * group file that no longer loads (unparsable, chain does not verify) gets an
 * empty, `left` row: a filter that reads the row then allows no one.
 * A row the v2 sync marked whose store file is gone is cleared the same way.
 * Returns the group ids it wrote. Unmarked rows the store does not hold are
 * v1 groups (whatever their id's shape) and are left alone.
 */
export function reconcileMailboxRosters(store, mailbox, selfUuaid) {
  if (!mailbox) return [];
  const done = [];
  for (const id of store.list()) {
    let rec;
    try { rec = store.load(id); }
    catch {
      const row = mailbox.getGroup(id);
      mailbox.putGroup({ id, name: row?.name ?? id, members: [], keys: {}, createdBy: row?.createdBy ?? null, pending: false, left: true });
      done.push(id);
      continue;
    }
    syncMailboxRoster(mailbox, rec, selfUuaid);
    done.push(id);
  }
  // A row the v2 sync marked whose store file is gone: no verified chain is left
  // to say who is in it, so it is cleared like an unloadable record.
  for (const id of mailbox.groupV2MarkedIds()) {
    if (store.has(id)) continue;
    const row = mailbox.getGroup(id);
    mailbox.putGroup({ id, name: row.name, members: [], keys: {}, createdBy: row.createdBy, pending: false, left: true }); // @rule MB-reconcile-missing-store
    done.push(id);
  }
  return done;
}

// ───────────────────────────────────────────── the admin's writes ──

/**
 * Create a group: sign version 1 with `keychain`, verify it, store it, then
 * write the mailbox row. `members`: [{ uuaid, key }], each invited.
 */
export function adminCreate({ store, mailbox, keychain, name, purpose, members = [] }) {
  const me = keychain._identity;
  const g = signManifest(buildGenesis({ name, purpose, creator: { uuaid: me.uuaid, publicKeyHex: me.publicKeyHex }, members }), keychain);
  const v = verifyGenesis(g);
  if (!v.ok) throw new Error(`refusing to store a genesis that does not verify: ${v.reason}`);
  const rec = newRecord([g]);
  store.save(rec);
  syncMailboxRoster(mailbox, rec, me.uuaid);
  return { rec, manifest: g };
}

/**
 * One §3 change by this home's key: build version n+1, sign it, verify it as
 * the next version of the stored head (a non-admin is refused here with
 * signer-not-admin), store it, then write the mailbox row. Nothing is sent.
 */
export function adminChange({ store, mailbox, keychain, groupId, action, opts = {} }) {
  const rec = loadGroupForCommand(store, groupId);
  if (rec.frozen) throw new Error(`${groupId} is frozen (equivocation); a frozen group can only be replaced by a new group`);
  const head = rec.chain[rec.chain.length - 1];
  const next = signManifest(buildNext(head, action, opts), keychain);
  const v = verifyNext(head, next);
  if (!v.ok) throw new Error(`refusing to store version ${next.version}: ${v.reason}`);
  rec.chain.push(next);
  rec.head = { version: next.version, hash: manifestHash(next) };
  if (action === "leave" || action === "remove") rec.leaving = rec.leaving.filter((u) => u !== next.transition.target);
  store.save(rec);
  syncMailboxRoster(mailbox, rec, keychain._identity.uuaid);
  return { rec, manifest: next };
}

/**
 * §4/§6: who gets the admin's newest manifest (version n), as queue rows for
 * Pillar.syncGroupV2 (`{ to, key, op: "manifest", manifestHash, mvVersion }`).
 * Nothing here sends.
 *   - every member of `row`, the mailbox row (the verified head minus leavers), but self;
 *   - an invitee (an `invite`, or the invited rows of version 1): every version 1..n;
 *   - the member a `remove` or `leave` took out: version n.
 * Each key is that member's key in the chain.
 */
export function adminManifestSends(rec, row, selfUuaid) {
  const m = rec.chain[rec.chain.length - 1];
  const keyOf = (u) => {
    for (let i = rec.chain.length - 1; i >= 0; i--) { const r = rec.chain[i].members.find((x) => x.uuaid === u); if (r) return r.key; }
    return null;
  };
  const sends = [];
  const add = (to, man) => sends.push({ to, key: keyOf(to), op: "manifest", manifestHash: manifestHash(man), mvVersion: m.version });
  for (const u of row?.members ?? []) if (u !== selfUuaid) add(u, m); // @rule A-send-row
  const t = m.transition;
  const invitees = m.version === 1 ? m.members.filter((r) => r.status === "invited").map((r) => r.uuaid) : t.action === "invite" ? [t.target] : [];
  for (const u of invitees) for (const x of rec.chain) add(u, x); // @rule A-send-invitee-chain
  if (t.action === "remove" || t.action === "leave") add(t.target, m); // @rule A-send-removed
  return sends;
}

/** `<uuaid>:<64-hex pubkey>` -> { uuaid, key }; v2 binds every member to its key. */
export function parseMemberRef(s) {
  const t = String(s);
  const i = t.lastIndexOf(":");
  const uuaid = t.slice(0, i), key = t.slice(i + 1).toLowerCase();
  if (i < 0 || !UUAID_RE.test(uuaid) || !HEX64.test(key)) throw new Error(`member "${t}" must be <uuaid>:<64-hex pubkey>`);
  return { uuaid, key };
}

// ──────────────────────────────────────── `pillar group` dispatch ──

/** The verbs v1's `pillar group` accepts; anything else it answers with its usage (exit 2). */
export const GROUP_V1_VERBS = Object.freeze(["create", "send", "add", "rename", "leave", "accept", "show"]);
/** Verbs only v2 has. v1 printed its usage for each of them. */
export const GROUP_V2_ONLY_VERBS = Object.freeze(["list", "invite", "remove", "ext", "transfer", "sync", "queue"]);

/**
 * Which implementation runs `pillar group <verb> ...`: "v2" or "v1".
 * `args` is the bin's parsed argv (`args._ = ["group", verb, ref, ...]`, flags as keys).
 * `held(id)`: the v2 store holds this id. `mailboxId(ref)`: the id v1's findGroup
 * resolves `ref` to (an id or a unique name), else null.
 * Everything not routed to v2 runs v1 unchanged. A ref naming a v2 group goes
 * to v2 whatever the verb: v1's add/rename would rewrite that group's mailbox row,
 * which must stay the verified head (minus leavers). A v2 group is one the store
 * holds, or one whose mailbox row the v2 sync marked (`marked(id)`) even if its
 * store file is gone; v2 then refuses it (loadGroupForCommand). The id's shape
 * alone never makes a group v2: a v1 peer's tag can carry a grp-<32 hex> id.
 */
export function groupCommandRoute(args, { held, marked = () => false, mailboxId = () => null }) {
  const verb = args?._?.[1];
  if (GROUP_V2_ONLY_VERBS.includes(verb)) return "v2"; // @rule P-cli-v2-verbs
  if (!GROUP_V1_VERBS.includes(verb)) return "v1";
  if (verb === "create" && args.v2 !== undefined) return "v2"; // @rule P-cli-create-v2
  if (verb === "create") return "v1"; // @rule P-cli-create-stays-v1
  const ref = args._[2];
  let id = ref;
  if (!isGroupIdV2(ref)) id = mailboxId(ref); // @rule P-cli-held-name
  if (isGroupIdV2(id) && marked(id)) return "v2"; // @rule P-cli-marked-row
  if (!isGroupIdV2(id) || !held(id)) return "v1"; // @rule P-cli-v1-unless-held
  return "v2";
}

/** The lookups groupCommandRoute needs, from a roster store and an open mailbox (or null). */
export function groupRouteLookups(store, mailbox) {
  return {
    held: (id) => store.has(id),
    marked: (id) => !!mailbox?.isGroupV2Marked(id),
    mailboxId: (ref) => {
      if (!mailbox || typeof ref !== "string") return null;
      try { return findGroup(mailbox, ref).id; } catch { return null; } // unknown or ambiguous: v1 reports it
    },
  };
}

/**
 * The record a v2 group command acts on. A group with no store file (its mailbox
 * row is marked, the file was deleted) is refused: there is no v1 fallback.
 */
export function loadGroupForCommand(store, id) {
  if (!store.has(id)) throw Object.assign(new Error(`no verified chain for ${id}; recover it from a member`), { code: "group-v2-no-chain" }); // @rule P-cli-refuse-no-chain
  return store.load(id);
}

/**
 * `create --v2` takes no value. The bin's parser gives the next word to a flag
 * (`create --v2 Team` sets v2 to "Team" and loses the name), so any value but
 * true is refused with how to write it. Returns the refusal, or null.
 */
export function createV2FlagRefusal(args) {
  const v = args?.v2;
  if (v === undefined || v === true || v === "true") return null;
  return `--v2 takes no value (it took "${v}", which was meant as an argument): put --v2 last, or write --v2=true`; // @rule P-cli-v2-flag-value
}

// ───────────────────────────────────────────── sender rules (§6) ──

/** Group messages a sender may post per minute on the community tier: ⌊120/(N−1)⌋. */
export function fanOutBudget(groupSize) {
  const n = Number(groupSize);
  return n <= 1 ? Infinity : Math.floor(COMMUNITY_SEND_BUDGET / (n - 1));
}

/** The `_group` field for an outbound v2 message (the payload is sealed per member). */
export function buildGroupTag(rec, { op = "message", msgId = `gm-${randomBytes(16).toString("hex")}`, manifest, want, conflictsWith } = {}) {
  if (!V2_OPS.includes(op)) throw new Error(`buildGroupTag: unknown op ${op}`);
  const head = rec.chain[rec.chain.length - 1];
  const tag = {
    v: 2, id: rec.id, name: head.name, members: head.members.filter((r) => r.status === "active").map((r) => r.uuaid),
    msgId, op, mv: { version: rec.head.version, hash: rec.head.hash },
  };
  if (manifest) tag.manifest = manifest;
  if (want) tag.want = want;
  if (conflictsWith) tag.conflictsWith = conflictsWith;
  return tag;
}

// ───────────────────────────────────────────── receiver (§5) ──

/**
 * The first malformed field of a v2 `_group`, or null. Reported as `detail`
 * with bad-group-message. Checked in this order: id, msgId, op, mv, then the
 * op's own fields (manifest, conflictsWith, want).
 */
function badTag(g) {
  if (!isGroupIdV2(g.id)) return "id";
  if (typeof g.msgId !== "string" || !MSGID_RE.test(g.msgId)) return "msgId";
  if (!V2_OPS.includes(g.op)) return "op";
  const mv = g.mv;
  if (!plain(mv) || !Number.isSafeInteger(mv.version) || mv.version < 0 || typeof mv.hash !== "string" || !HEX64.test(mv.hash)) return "mv";
  if (mv.version === 0 && !(g.op === "manifest.request" && mv.hash === ZERO_HASH)) return "mv";
  if ((g.op === "manifest" || g.op === "equivocation") && !plain(g.manifest)) return "manifest";
  if (g.op === "equivocation" && !(typeof g.conflictsWith === "string" && HEX64.test(g.conflictsWith))) return "conflictsWith";
  if (g.op === "manifest.request") {
    const w = g.want;
    if (!plain(w) || !Number.isSafeInteger(w.from) || w.from < 1) return "want";
    if (!(w.to === null || (Number.isSafeInteger(w.to) && w.to >= w.from))) return "want";
  }
  return null;
}

const res = (verdict, reason = null, extra = {}) => ({ verdict, reason, ...extra });
const drop = (reason, extra) => res("dropped", reason, extra);

/**
 * One receiver. Every entry point returns
 *   { verdict, reason, detail?, sends, released, dropped, lateLines }
 * and the caller seals and sends `sends` (it never decides recipients itself).
 */
export class GroupReceiver {
  constructor({ self, store, limits = {}, allowDelegation = true, mailbox = null }) {
    this.self = self; // { uuaid, key }
    this.store = store;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.allowDelegation = allowDelegation;
    this.mailbox = mailbox;
    this.records = new Map(); // id -> record (seen as a Set in memory)
    this.held = new Map();    // id -> [{ env, g, from, msgId, version, receivedAt }]
    this.catchup = new Map(); // id -> { to, asked: Set }
    this.asked = new Map();   // "id|target" -> { versions: Set, openFrom }
    this.invites = new Map(); // "id|sender" -> { manifests: Map, firstAt, requested }
    this.recovery = new Map(); // id -> { from, manifests: Map, firstAt }
    this.acceptedLog = new Map(); // id -> [{ from, msgId, at }]
    reconcileMailboxRosters(this.store, this.mailbox, this.self.uuaid); // @rule MB-reconcile-on-start
  }

  // ── records ──
  _rec(id) {
    if (this.records.has(id)) return this.records.get(id);
    if (!this.store.has(id)) return null;
    const r = this.store.load(id);
    const rec = { ...r, seen: new Set(r.seen) };
    this.records.set(id, rec);
    return rec;
  }
  _persist(rec) {
    this.store.save({ ...rec, seen: [...rec.seen] });
    syncMailboxRoster(this.mailbox, rec, this.self.uuaid); // @rule MB-sync-on-write
  }
  _head(rec) { return rec.chain[rec.chain.length - 1]; }

  /** Store a chain this client verified itself (its own admin writes, the driver's starting state). */
  adoptVerifiedChain(chain) {
    const v = verifyChain(chain);
    if (!v.ok) throw new Error(`adoptVerifiedChain: ${v.reason} at version ${v.at}`);
    const rec = { ...newRecord(chain), seen: new Set() };
    this.records.set(rec.id, rec);
    this._persist(rec);
    return rec;
  }

  knownGroups() { return this.store.list(); }

  state(groupId) {
    const rec = groupId ? this._rec(groupId) : null;
    if (!rec) return { groupId, known: false, headVersion: 0, frozen: false, outOfDate: false, leaving: [], recipients: [] };
    return {
      groupId, known: true, headVersion: rec.head.version, frozen: !!rec.frozen, outOfDate: rec.outOfDate,
      leaving: [...rec.leaving], recipients: recipientsOf(rec, this.self.uuaid),
    };
  }

  _out() { return { sends: [], released: [], dropped: [], lateLines: [] }; }

  // ── driver actions ──
  receive(env, now) {
    const out = this._out();
    this._expire(now, out);
    return { ...this._judge(env, now, out), ...out };
  }
  tick(now) {
    const out = this._out();
    this._expire(now, out);
    return { ...res("ignored"), ...out };
  }
  askAnother(groupId, now) {
    const out = this._out();
    this._expire(now, out);
    const rec = this._rec(groupId), c = this.catchup.get(groupId);
    if (rec && c && !rec.frozen) {
      const head = this._head(rec);
      const admin = adminOf(head).uuaid;
      const order = [admin, ...head.members.filter((r) => r.status === "active" && r.uuaid !== admin).map((r) => r.uuaid)];
      const target = order.find((u) => u !== this.self.uuaid && !c.asked.has(u));
      if (target) { c.asked.add(target); this._request(groupId, target, { from: rec.head.version + 1, to: c.to }, out); }
    }
    return { ...res("ignored"), ...out };
  }
  beginRecovery({ groupId, from }, now) {
    const out = this._out();
    this._expire(now, out);
    if (isGroupIdV2(groupId) && !this._rec(groupId)) {
      this.recovery.set(groupId, { from, manifests: new Map(), firstAt: now });
      out.sends.push({ to: from, op: "manifest.request", want: { from: 1, to: null }, mvVersion: 0 });
    }
    return { ...res("ignored"), ...out };
  }

  // ── §5 ──
  _judge(env, now, out) {
    const p = env.payload;
    if (!plain(p) || !Object.hasOwn(p, "_group")) return res("not-group");
    const g = p._group;
    if (!plain(g)) return drop("bad-group-message");
    if (g.v !== 2) {
      return isGroupIdV2(g.id) && this._rec(g.id) ? res("warning", "v1-in-v2-group") : res("v1"); // @rule R7-v1-in-v2
    }
    const bad = badTag(g);
    if (bad) return drop("bad-group-message", { detail: bad }); // @rule R4-tag-shape
    const rec = this._rec(g.id);
    if (!rec) return this._unknown(env, g, now, out);
    return this._judgeKnown(env, g, now, out);
  }

  _effKey(env) {
    if (env.delegation) return this.allowDelegation ? env.delegation.rootKey : null;
    return env.transportKey;
  }

  /** §5.2 gate: an active or invited member, under its own key. */
  _gate(env, rec) {
    const row = this._head(rec).members.find((r) => r.uuaid === env.from);
    if (!row) return false;
    if (!(row.status === "active" || row.status === "invited")) return false; // @rule R2-gate-status
    if (this._effKey(env) !== row.key) return false; // @rule R2-gate-key
    return true;
  }

  /** §5.3 sender checks. Null when the sender may speak. */
  _rule3(env, g, rec) {
    const head = this._head(rec);
    const row = head.members.find((r) => r.uuaid === env.from);
    if (!row) return "not-member"; // @rule R3-not-member
    if (env.delegation && !this.allowDelegation) return "delegation-refused"; // @rule R3-delegation
    if (this._effKey(env) !== row?.key) return "transport-key-mismatch"; // @rule R3-transport-key
    const invitedException = row?.status === "invited" && adminOf(head).uuaid === this.self.uuaid
      && (g.op === "accept.request" || g.op === "manifest.request");
    if (invitedException) return null;
    if (row?.status === "removed") return "sender-removed"; // @rule R5-removed-sender
    if (row?.status !== "active") return "sender-not-active"; // @rule R3-active-only
    return null;
  }

  _seenKey(from, msgId) { return `${from} ${msgId}`; }

  /** A Set keeps insertion order, so the first key is the oldest. */
  _markSeen(rec, k) {
    rec.seen.add(k);
    if (rec.seen.size > SEEN_CAP) rec.seen.delete(rec.seen.values().next().value); // @rule R3-seen-cap
  }

  _judgeKnown(env, g, now, out) {
    const rec = this._rec(g.id);
    if (rec.frozen) return drop("frozen"); // @rule R4-frozen-drops
    const n = rec.head.version;
    const carried = g.op === "manifest" || g.op === "equivocation" ? g.manifest : null;
    const carriedAhead = carried && Number.isSafeInteger(carried.version) && carried.version > n + 1;
    // 4. A carried manifest of version <= n+1: rule 3 first, then the manifest.
    if (carried && !carriedAhead) {
      const r3 = this._rule3(env, g, rec);
      if (r3) return drop(r3); // @rule R1-carried-after-rule3
      const k = this._seenKey(env.from, g.msgId);
      if (rec.seen.has(k)) return drop("duplicate-msgid");
      this._markSeen(rec, k);
      return this._applyCarried(env, g, carried, rec, now, out);
    }
    // 5. Ahead: hold, but only for an active or invited member under its key.
    const ahead = carriedAhead ? carried.version : g.mv.version;
    if (ahead > n && this._gate(env, rec)) return this._hold(env, g, rec, ahead, now, out); // @rule R2-hold
    // 6. The signal: same version, other hash. Ask once; never freeze on it.
    if (g.mv.version === n && g.mv.hash !== rec.head.hash && this._gate(env, rec)) {
      this._request(rec.id, env.from, { from: n, to: n }, out); // @rule R4-signal-asks
    }
    // 7. Rule 3 under the receiver's own manifest: mv never widens authority.
    const r3 = this._rule3(env, g, rec);
    if (r3) return drop(r3);
    const k = this._seenKey(env.from, g.msgId);
    if (rec.seen.has(k)) return drop("duplicate-msgid"); // @rule R3-msgid-dedupe
    this._markSeen(rec, k);
    this._effects(env, g, rec, out);
    this._maybeInDate(env, g, rec);
    this._log(rec.id, env.from, g.msgId, now);
    this._persist(rec);
    return res("accepted");
  }

  _effects(env, g, rec, out) {
    const head = this._head(rec);
    if (g.op === "leave.request" && !rec.leaving.includes(env.from)) {
      let isAdmin = false;
      if (env.from === adminOf(head).uuaid) isAdmin = true; // @rule R5-admin-leave-ignored
      if (!isAdmin) rec.leaving.push(env.from); // @rule R5-leave-at-once
    }
    if (g.op === "manifest.request") {
      const n = rec.head.version;
      const to = Math.min(g.want.to ?? n, n);
      for (let v = g.want.from, c = 0; v <= to && c < MAX_ANSWER; v++, c++) {
        out.sends.push({ to: env.from, op: "manifest", manifestHash: manifestHash(rec.chain[v - 1]), mvVersion: n });
      }
    }
  }

  /** "Out of date" clears on a message carrying our exact head, from the admin or an active non-source member. */
  _maybeInDate(env, g, rec) {
    if (!rec.outOfDate || g.mv.version !== rec.head.version || g.mv.hash !== rec.head.hash) return;
    const head = this._head(rec);
    const row = head.members.find((r) => r.uuaid === env.from);
    if (env.from === adminOf(head).uuaid || (row?.status === "active" && env.from !== rec.recoveredFrom)) {
      rec.outOfDate = false; // @rule R2-out-of-date-clears
      rec.recoveredFrom = null;
    }
  }

  _applyCarried(env, g, m, rec, now, out) {
    const n = rec.head.version;
    const reject = (detail) => { this._persist(rec); return drop("manifest-rejected", { detail }); };
    const shape = checkShape(m);
    if (shape) return reject(shape);
    if (m.id !== rec.id) return reject("id-mismatch");
    if (m.version === n + 1) {
      const v = verifyNext(this._head(rec), m);
      if (!v.ok) return reject(v.reason); // @rule R1-verify-before-apply
      this._applyNext(rec, m, out);
      if (g.mv.version > rec.head.version && this._gate(env, rec)) {
        this._request(rec.id, env.from, { from: rec.head.version + 1, to: g.mv.version }, out);
      }
      this._maybeInDate(env, g, rec);
      this._persist(rec);
      this._release(rec, now, out);
      return res("accepted");
    }
    const stored = rec.chain[m.version - 1];
    if (manifestHash(stored) === manifestHash(m)) { this._persist(rec); return res("accepted"); }
    const check = m.version === 1 ? verifyGenesis(m) : verifyNext(rec.chain[m.version - 2], m);
    if (!check.ok) return reject(check.reason); // @rule R4-proof-must-verify
    return this._freeze(rec, stored, m, out);
  }

  _applyNext(rec, m, out) {
    rec.chain.push(m);
    rec.head = { version: m.version, hash: manifestHash(m) };
    const t = m.transition;
    if (t.action === "leave" || t.action === "remove") {
      rec.leaving = rec.leaving.filter((u) => u !== t.target);
      const since = Date.parse(m.issuedAt);
      out.lateLines.push(...(this.acceptedLog.get(rec.id) ?? []).filter((x) => x.from === t.target && x.at > since).map((x) => x.msgId));
    }
    const c = this.catchup.get(rec.id);
    if (c && rec.head.version >= c.to) this.catchup.delete(rec.id);
  }

  /** §5.4 proof: freeze, tell every non-removed member of either manifest once, then nothing. */
  _freeze(rec, a, b, out) {
    const ha = manifestHash(a), hb = manifestHash(b);
    const to = [];
    for (const m of [a, b]) for (const r of m.members) {
      if (r.status !== "removed" && r.uuaid !== this.self.uuaid && !to.includes(r.uuaid)) to.push(r.uuaid);
    }
    for (const u of to) {
      out.sends.push({ to: u, op: "equivocation", manifestHash: ha, conflictsWith: hb, mvVersion: rec.head.version });
      out.sends.push({ to: u, op: "equivocation", manifestHash: hb, conflictsWith: ha, mvVersion: rec.head.version });
    }
    rec.frozen = { manifests: [a, b] }; // @rule R4-freeze
    for (const h of this.held.get(rec.id) ?? []) out.dropped.push({ msgId: h.msgId, reason: "frozen" });
    this.held.delete(rec.id);
    this.catchup.delete(rec.id);
    this._persist(rec);
    return res("frozen", "equivocation-proof");
  }

  _hold(env, g, rec, version, now, out) {
    const held = this.held.get(rec.id) ?? [];
    if (held.filter((h) => h.from === env.from).length >= this.limits.holdPerSender) return drop("hold-quota-sender"); // @rule R2-quota-sender
    if (held.length >= this.limits.holdPerGroup) return drop("hold-quota-group"); // @rule R2-quota-group
    held.push({ env, g, from: env.from, msgId: g.msgId, version, receivedAt: now });
    this.held.set(rec.id, held);
    const c = this.catchup.get(rec.id) ?? { to: version, asked: new Set() };
    c.to = Math.max(c.to, version);
    c.asked.add(env.from);
    this.catchup.set(rec.id, c);
    this._request(rec.id, env.from, { from: rec.head.version + 1, to: version }, out);
    return res("held");
  }

  /** At most one manifest.request per (target, version); an open-ended one covers every later version. */
  _request(groupId, target, want, out) {
    const key = `${groupId}|${target}`;
    const a = this.asked.get(key) ?? { versions: new Set(), openFrom: null };
    if (a.openFrom !== null && want.from >= a.openFrom) return;
    if (want.to === null) a.openFrom = a.openFrom === null ? want.from : Math.min(a.openFrom, want.from);
    else if (a.versions.has(want.to)) return; // @rule R2-one-request-per-version
    else a.versions.add(want.to);
    this.asked.set(key, a);
    const rec = this._rec(groupId);
    out.sends.push({ to: target, op: "manifest.request", want: { ...want }, mvVersion: rec ? rec.head.version : 0 });
  }

  /** After a head change, held messages now at or below the head are judged again from step 4. */
  _release(rec, now, out) {
    for (;;) {
      const held = this.held.get(rec.id) ?? [];
      const due = held.filter((h) => h.version <= rec.head.version);
      if (!due.length) return;
      this.held.set(rec.id, held.filter((h) => !due.includes(h)));
      for (const h of due) {
        const r = this._judgeKnown(h.env, h.g, now, out);
        const x = r.reason ? { msgId: h.msgId, verdict: r.verdict, reason: r.reason } : { msgId: h.msgId, verdict: r.verdict };
        if (h.env.ref !== undefined) x.ref = h.env.ref; // the caller's handle on the held message (pillar: the envelope id)
        out.released.push(x);
      }
    }
  }

  _expire(now, out) {
    for (const [id, held] of this.held) {
      const keep = [];
      for (const h of held) {
        if (now - h.receivedAt > this.limits.holdMs) { out.dropped.push({ msgId: h.msgId, reason: "hold-expired", ...(h.env.ref !== undefined ? { ref: h.env.ref } : {}) }); continue; } // @rule R2-expiry
        keep.push(h);
      }
      if (keep.length !== held.length) {
        const rec = this._rec(id);
        if (rec) { rec.outOfDate = true; this._persist(rec); }
        if (keep.length) this.held.set(id, keep); else { this.held.delete(id); this.catchup.delete(id); }
      }
    }
    for (const map of [this.invites, this.recovery]) {
      for (const [k, b] of map) if (now - b.firstAt > this.limits.holdMs) map.delete(k);
    }
  }

  _log(id, from, msgId, at) {
    const log = this.acceptedLog.get(id) ?? [];
    log.push({ from, msgId, at });
    if (log.length > 2000) log.splice(0, log.length - 2000);
    this.acceptedLog.set(id, log);
  }

  // ── §5.0 ──
  _unknown(env, g, now, out) {
    const rc = this.recovery.get(g.id);
    if (rc && rc.from === env.from && g.op === "manifest") return this._recoveryStep(env, g, rc, now, out);
    if (g.op === "manifest") return this._invitationStep(env, g, now, out);
    return drop("unknown-group"); // @rule R0-unknown-group
  }

  /**
   * Design cap: a buffered invitation or recovery keeps versions 1..4096 and at
   * most 1,024 manifests. A group past version 4096 cannot be adopted by
   * invitation or recovery; its members keep it by applying each version.
   */
  _buffer(map, key, m, now, extra = {}) {
    const b = map.get(key) ?? { manifests: new Map(), firstAt: now, requested: false, ...extra };
    if (Number.isSafeInteger(m.version) && m.version >= 1 && m.version <= 4096 && !b.manifests.has(m.version) && b.manifests.size < 1024) {
      b.manifests.set(m.version, m);
    }
    map.set(key, b);
    return b;
  }

  _invitationStep(env, g, now, out) {
    const m = g.manifest;
    if (m.id !== g.id) return drop("unknown-group");
    const key = `${g.id}|${env.from}`;
    const b = this._buffer(this.invites, key, m, now);
    if (!b.manifests.size) return drop("unknown-group");
    const top = Math.max(...b.manifests.keys());
    const topM = b.manifests.get(top);
    const me = Array.isArray(topM.members) ? topM.members.find((r) => plain(r) && r.uuaid === this.self.uuaid) : null;
    if (!me || me.status !== "invited" || me.key !== this.self.key) return res("ignored", "invitation-pending"); // @rule R0-names-self-invited
    const missing = [];
    for (let v = 1; v < top; v++) if (!b.manifests.has(v)) missing.push(v);
    if (missing.length) {
      const admin = Array.isArray(topM.members) ? topM.members.find((r) => plain(r) && r.status === "active" && r.role === "admin") : null;
      if (!b.requested && admin?.uuaid === env.from) {
        out.sends.push({ to: env.from, op: "manifest.request", want: { from: missing[0], to: missing[missing.length - 1] }, mvVersion: 0 });
        b.requested = true;
      }
      return res("ignored", "invitation-pending");
    }
    this.invites.delete(key);
    const chain = Array.from({ length: top }, (_, i) => b.manifests.get(i + 1));
    const v = verifyChain(chain);
    if (!v.ok) return drop(v.reason); // @rule R0-invitation-verifies
    const admin = adminOf(chain[top - 1]);
    if (env.from !== admin.uuaid || this._effKey(env) !== admin.key) return drop("invite-not-from-admin"); // @rule R0-invite-from-admin
    const rec = { ...newRecord(chain), seen: new Set() };
    this.records.set(rec.id, rec);
    this._persist(rec);
    return res("invitation");
  }

  _recoveryStep(env, g, rc, now, out) {
    const m = g.manifest;
    if (m.id !== g.id) return drop("unknown-group");
    this._buffer(this.recovery, g.id, m, now, { from: rc.from });
    const need = g.mv.version;
    for (let v = 1; v <= need; v++) if (!rc.manifests.has(v)) return res("ignored", "recovery-pending");
    if (need < 1) return res("ignored", "recovery-pending");
    this.recovery.delete(g.id);
    const chain = Array.from({ length: need }, (_, i) => rc.manifests.get(i + 1));
    const v = verifyChain(chain);
    if (!v.ok) return drop(v.reason);
    const head = chain[need - 1];
    const me = head.members.find((r) => r.uuaid === this.self.uuaid);
    if (!me || me.key !== this.self.key || !(me.status === "invited" || me.status === "active")) return drop("recovery-not-member"); // @rule R0-recovery-names-self
    const src = head.members.find((r) => r.uuaid === env.from);
    if (!src || src.status === "removed" || this._effKey(env) !== src.key) return drop("recovery-not-member");
    const rec = { ...newRecord(chain, { outOfDate: true, recoveredFrom: env.from }), seen: new Set() };
    this.records.set(rec.id, rec);
    this._persist(rec);
    const admin = adminOf(head).uuaid;
    const order = [admin, ...head.members.filter((r) => r.status === "active" && r.uuaid !== admin).map((r) => r.uuaid)];
    const target = order.find((u) => u !== this.self.uuaid && u !== env.from);
    if (target) this._request(rec.id, target, { from: need + 1, to: null }, out);
    return res("recovered");
  }
}
