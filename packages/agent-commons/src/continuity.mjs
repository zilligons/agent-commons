/**
 * Continuity memory for one UUAID-bound agent.
 *
 * The module keeps a bounded, hash-chained, signed memory ledger for exactly one
 * identity (the agent whose Keychain is supplied). Every entry carries explicit
 * provenance and is persisted locally through a CommonsStore (SQLite, WAL) so the
 * agent survives process restarts without any network access.
 *
 * Remote continuity is strictly opt-in. Synchronization only happens when the
 * caller (a) injects an official `@uuaid/sdk` `UuaidClient` (or an object with the
 * identical `saveMemory`/`loadMemory` surface) and (b) supplies a `uvk_…` vault key,
 * and then (c) explicitly calls `push()`, `pull()`, or `sync()`. The official SDK
 * encrypts client-side (AES-256-GCM under HKDF, AAD bound to `${uuaid}/${slot}`),
 * so only ciphertext leaves the process. This module never constructs a network
 * client, never calls `registerAgent`, never performs signup, and never persists
 * the vault key.
 *
 * Fail-closed guarantees: a corrupt or foreign local blob refuses to load; a remote
 * snapshot that belongs to another UUAID or key, fails chain or signature checks,
 * or has diverged from local history is rejected rather than merged. Several
 * instances may share one store for one identity: every write re-reads the stored
 * head inside the transaction and refuses (`STALE_WRITER`) if another instance
 * advanced it, so cached state can never overwrite newer history.
 *
 * @module continuity
 */
import { randomUUID } from "node:crypto";
import { digest, assertJSON } from "./profiles.mjs";
// Imported from the vendored Pillar identity modules directly (not ./pillar.mjs or
// ./store.mjs) so this file never loads node:sqlite or carrier code. The module is
// therefore usable on Node 20 with an injected store; Node 22 remains the tested target.
import { Keychain } from "./vendor/pillar/identity/keychain.mjs";
import { jcs } from "./vendor/pillar/identity/jcs.mjs";

/** Wire/storage protocol identifier for continuity snapshots. */
export const CONTINUITY_PROTOCOL = "agent-commons/continuity/1";

/**
 * Provenance sources recognized by the ledger.
 * - `self`: produced by this agent's own reasoning or tooling.
 * - `peer`: received from another verified agent (actor must be that agent's UUAID).
 * - `operator`: supplied by the deploying operator/policy.
 * - `tool`: output of a deterministic local tool, benchmark, or fixture.
 * @type {ReadonlyArray<ProvenanceSource>}
 */
export const PROVENANCE_SOURCES = Object.freeze(["self", "peer", "operator", "tool"]);

/**
 * Default resource ceilings. All are overridable per instance but never unbounded.
 * @type {Readonly<ContinuityLimits>}
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 500,
  maxBytes: 256 * 1024,
  maxEntryBytes: 16 * 1024,
  retentionMs: 90 * 86400000,
});

const UUAID_RE = /^uuaid:[a-z0-9-]+:agent:[0-9a-f-]{36}$/;
const KIND_RE = /^[a-z][a-z0-9:_-]{0,63}$/;
const SLOT_SEGMENT_RE = /^[A-Za-z0-9._-]{1,64}$/;
const VAULT_KEY_RE = /^uvk_[A-Za-z0-9_-]{16,}$/;

/**
 * @typedef {"self"|"peer"|"operator"|"tool"} ProvenanceSource
 */

/**
 * Minimal durable key/value surface the ledger needs. `CommonsStore` (SQLite)
 * satisfies it; any wrapper with the same shape may be injected instead.
 * `transaction` is optional — when absent, writes are applied directly.
 * @typedef {object} ContinuityStore
 * @property {(key:string,fallback?:unknown)=>unknown} get  Return the JSON value for `key`, or `fallback` (default null) when absent.
 * @property {(key:string,value:unknown)=>void} set         Durably write a JSON value.
 * @property {(<T>(fn:()=>T)=>T)=} transaction               Run `fn` atomically; rethrow on failure without applying partial writes.
 */

/**
 * Volatile fallback store (process memory only). Used when no store is injected so
 * the module stays dependency-free; it is NOT durable and `status().durable` says so.
 * @implements {ContinuityStore}
 */
export class MemoryContinuityStore {
  #map = new Map();
  get(key, fallback = null) { return this.#map.has(key) ? structuredClone(this.#map.get(key)) : fallback; }
  set(key, value) { this.#map.set(key, structuredClone(value)); }
  transaction(fn) { const before = new Map(this.#map); try { return fn(); } catch (e) { this.#map = before; throw e; } }
}

/**
 * @typedef {object} ContinuityLimits
 * @property {number} maxEntries   Maximum retained entries (oldest unpinned evicted first).
 * @property {number} maxBytes     Maximum canonical-JSON bytes of all retained entries; also caps the remote snapshot.
 * @property {number} maxEntryBytes Maximum canonical-JSON bytes of one entry; larger entries are refused.
 * @property {number} retentionMs  Entries older than this are pruned on the next write (pinned entries exempt).
 */

/**
 * @typedef {object} Provenance
 * @property {ProvenanceSource} source  Where the memory came from.
 * @property {string} actor             UUAID of the agent that produced it (defaults to the owner).
 * @property {string|null} origin       Free-form, non-secret locator: session id, document digest, tool name.
 * @property {string|null} evidence     Optional sha256 hex digest of supporting material kept elsewhere.
 */

/**
 * @typedef {object} ContinuityEntry
 * @property {typeof CONTINUITY_PROTOCOL} v
 * @property {number} seq        Monotonic sequence number within this identity's ledger (never reused after pruning).
 * @property {string} id         Random UUID for the entry.
 * @property {string} at         RFC 3339 creation timestamp.
 * @property {string} kind       Lower-case classifier such as `note`, `commitment`, `preference:operational`.
 * @property {unknown} content   Canonical-JSON-safe payload (see profiles.assertJSON).
 * @property {Provenance} provenance
 * @property {boolean} pin       Pinned entries are exempt from retention/eviction but still count toward budgets.
 * @property {string} previous   Hash of the previous entry, or the anchor hash for the first retained entry.
 * @property {string} hash       sha256 of the canonical body (everything except `hash` and `signature`).
 * @property {string} signature  Ed25519 signature over the hash bytes, made by the owner's Keychain.
 */

/**
 * @typedef {object} ContinuityAnchor
 * @property {string} previous      Hash the first retained entry must link to (`genesis` until pruning occurs).
 * @property {number} pruned        Count of entries pruned over the lifetime of this ledger.
 * @property {string|null} through  `at` timestamp of the most recently pruned entry.
 */

/**
 * @typedef {object} SyncReceipt
 * @property {string} at            RFC 3339 time of the operation.
 * @property {string} head          Local head hash at the time of the operation.
 * @property {string|null} contentHash  Registry-reported `content_hash` of the stored envelope (push only).
 * @property {number} sizeBytes     Plaintext snapshot size that was encrypted and sent / received.
 * @property {boolean|null} replaced  Registry-reported `replaced` flag (push only).
 * @property {"in-sync"|"fast-forwarded"|"local-ahead"|"remote-empty"|"pushed"} relation
 */

/**
 * @typedef {object} ContinuityState
 * @property {typeof CONTINUITY_PROTOCOL} v
 * @property {string} uuaid
 * @property {string} publicKey       Owner's Ed25519 public key (hex) — every entry signature must verify under it.
 * @property {number} nextSeq
 * @property {ContinuityAnchor} anchor
 * @property {ContinuityEntry[]} entries
 * @property {{lastPush:SyncReceipt|null,lastPull:SyncReceipt|null}} sync
 */

/**
 * @typedef {object} ContinuitySnapshot
 * @property {typeof CONTINUITY_PROTOCOL} v
 * @property {string} uuaid
 * @property {string} publicKey
 * @property {number} nextSeq
 * @property {ContinuityAnchor} anchor
 * @property {ContinuityEntry[]} entries
 * @property {string} head
 * @property {string} exportedAt
 */

/**
 * Minimal structural type of the official `@uuaid/sdk` client surface that this
 * module depends on. A real `UuaidClient` satisfies it; test doubles must too.
 * @typedef {object} OfficialMemoryClient
 * @property {(agentUuaid:string,key:string,text:string,vaultKey:string)=>Promise<{agent:string,key:string,content_hash?:string,size_bytes?:number,replaced?:boolean}>} saveMemory
 * @property {(agentUuaid:string,key:string,vaultKey:string)=>Promise<string>} loadMemory
 */

/**
 * @typedef {"IDENTITY_REQUIRED"|"CLIENT_INVALID"|"VAULT_KEY_INVALID"|"SLOT_INVALID"|"REMOTE_NOT_CONFIGURED"|"INTEGRITY"|"IDENTITY_MISMATCH"|"REMOTE_MISMATCH"|"DIVERGED"|"ENTRY_INVALID"|"ENTRY_TOO_LARGE"|"BUDGET_EXHAUSTED"|"REMOTE_UNAVAILABLE"|"STALE_WRITER"|"LIMIT_EXCEEDED"} ContinuityErrorCode
 */

/** Error raised by the continuity module; `code` is stable and machine-checkable. */
export class ContinuityError extends Error {
  /**
   * @param {ContinuityErrorCode} code
   * @param {string} message
   * @param {Record<string,unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ContinuityError";
    this.code = code;
    this.details = details;
  }
}

function isoNow(now) { return new Date(now()).toISOString(); }
function runAtomically(store, fn) { return typeof store.transaction === "function" ? store.transaction(fn) : fn(); }
function bytesOf(value) { return Buffer.byteLength(jcs(value), "utf-8"); }

/**
 * Validate a vault slot path. Slots are path-like (`continuity/chain`), each
 * segment restricted to a conservative charset; `.`/`..`/empty segments are refused.
 * @param {string} slot
 * @returns {string}
 */
export function validateSlot(slot) {
  if (typeof slot !== "string" || slot.length > 128) throw new ContinuityError("SLOT_INVALID", "Vault slot must be a short path-like string");
  const segments = slot.split("/");
  if (!segments.every(s => SLOT_SEGMENT_RE.test(s) && s !== "." && s !== "..")) throw new ContinuityError("SLOT_INVALID", "Vault slot segments must be [A-Za-z0-9._-] and non-empty", { slot });
  return slot;
}

/**
 * Verify a continuity snapshot/state structurally and cryptographically against the
 * expected owner, and — when `limits` are supplied — against the resource envelope.
 * Throws `ContinuityError` (`INTEGRITY`, `IDENTITY_MISMATCH`, or `LIMIT_EXCEEDED`) on
 * any defect; returns the verified object unchanged otherwise. A correctly signed
 * chain that exceeds the configured envelope is rejected whole, never pruned: a
 * writer that bypassed the limits is not a trusted writer.
 *
 * @param {ContinuityState|ContinuitySnapshot} state
 * @param {{uuaid:string,publicKey:string}} owner
 * @param {{limits?:ContinuityLimits,now?:()=>number,age?:boolean}} [envelope]  `age` (default true) also rejects unpinned entries older than `retentionMs`.
 * @returns {ContinuityState|ContinuitySnapshot}
 */
export function verifyContinuity(state, owner, envelope = {}) {
  if (!state || typeof state !== "object") throw new ContinuityError("INTEGRITY", "Continuity state is not an object");
  assertJSON(state);
  if (state.v !== CONTINUITY_PROTOCOL) throw new ContinuityError("INTEGRITY", "Unknown continuity protocol", { v: state.v });
  if (state.uuaid !== owner.uuaid || state.publicKey !== owner.publicKey) throw new ContinuityError("IDENTITY_MISMATCH", "Continuity state belongs to a different identity or key", { expected: owner.uuaid, found: state.uuaid });
  if (Keychain.localIdFromKey(Buffer.from(owner.publicKey, "hex")) !== owner.uuaid.split(":")[3]) throw new ContinuityError("IDENTITY_MISMATCH", "Owner key is not bound to owner UUAID");
  const { anchor, entries } = state;
  if (!anchor || typeof anchor.previous !== "string" || !Number.isSafeInteger(anchor.pruned) || anchor.pruned < 0 || !Array.isArray(entries)) throw new ContinuityError("INTEGRITY", "Malformed anchor or entries");
  if (!Number.isSafeInteger(state.nextSeq) || state.nextSeq < anchor.pruned + entries.length) throw new ContinuityError("INTEGRITY", "Sequence counter is inconsistent with ledger length");
  let previous = anchor.previous;
  let lastSeq = -1;
  for (const entry of entries) {
    const { hash, signature, ...body } = entry;
    if (body.v !== CONTINUITY_PROTOCOL || body.previous !== previous || !Number.isSafeInteger(body.seq) || body.seq <= lastSeq) throw new ContinuityError("INTEGRITY", "Continuity chain link is broken", { seq: body.seq });
    if (digest(body) !== hash) throw new ContinuityError("INTEGRITY", "Continuity entry hash mismatch", { seq: body.seq });
    if (!/^[0-9a-f]{128}$/.test(signature ?? "") || !Keychain.verifyDetached(owner.publicKey, Buffer.from(hash, "hex"), Buffer.from(signature, "hex"))) throw new ContinuityError("INTEGRITY", "Continuity entry signature invalid", { seq: body.seq });
    if (!PROVENANCE_SOURCES.includes(body.provenance?.source) || !UUAID_RE.test(body.provenance?.actor ?? "")) throw new ContinuityError("INTEGRITY", "Continuity entry provenance invalid", { seq: body.seq });
    previous = hash;
    lastSeq = body.seq;
  }
  if ("head" in state && state.head !== previous) throw new ContinuityError("INTEGRITY", "Snapshot head does not match chain");
  if ((anchor.pruned === 0) !== (anchor.previous === "genesis") || (anchor.previous !== "genesis" && !/^[0-9a-f]{64}$/.test(anchor.previous))) throw new ContinuityError("INTEGRITY", "Anchor hash and pruned count disagree");
  if (anchor.through !== null && (typeof anchor.through !== "string" || Number.isNaN(Date.parse(anchor.through)) || (entries.length && anchor.through > entries[0].at))) throw new ContinuityError("INTEGRITY", "Anchor retention marker is inconsistent with retained entries");
  if ((anchor.through === null) !== (anchor.pruned === 0)) throw new ContinuityError("INTEGRITY", "Anchor retention marker and pruned count disagree");
  if (envelope.limits) assertWithinLimits(state, envelope.limits, envelope.now ?? (() => Date.now()), envelope.age ?? true);
  return state;
}

/**
 * Enforce the resource envelope on an already-verified state. Fail closed with
 * `LIMIT_EXCEEDED`; never trims.
 * @param {ContinuityState|ContinuitySnapshot} state
 * @param {ContinuityLimits} limits
 * @param {() => number} now
 * @param {boolean} [age]  When true, unpinned entries older than `retentionMs` are a violation.
 */
export function assertWithinLimits(state, limits, now = () => Date.now(), age = true) {
  const { entries } = state;
  if (entries.length > limits.maxEntries) throw new ContinuityError("LIMIT_EXCEEDED", "Snapshot retains more entries than maxEntries", { entries: entries.length, limit: limits.maxEntries });
  let total = 0;
  const cutoff = now() - limits.retentionMs;
  for (const entry of entries) {
    const size = bytesOf(entry);
    if (size > limits.maxEntryBytes) throw new ContinuityError("LIMIT_EXCEEDED", "Snapshot entry exceeds maxEntryBytes", { seq: entry.seq, size, limit: limits.maxEntryBytes });
    total += size;
    const at = Date.parse(entry.at);
    if (Number.isNaN(at) || at > now() + 300000) throw new ContinuityError("LIMIT_EXCEEDED", "Snapshot entry timestamp is invalid or in the future", { seq: entry.seq, at: entry.at });
    if (age && !entry.pin && at < cutoff) throw new ContinuityError("LIMIT_EXCEEDED", "Snapshot retains an unpinned entry older than retentionMs", { seq: entry.seq, at: entry.at });
  }
  if (total > limits.maxBytes) throw new ContinuityError("LIMIT_EXCEEDED", "Snapshot exceeds maxBytes", { bytes: total, limit: limits.maxBytes });
}

/**
 * Identity-scoped, bounded, hash-chained continuity memory with optional explicit
 * encrypted remote synchronization through an injected official UUAID SDK client.
 */
export class ContinuityMemory {
  /** @type {string|null} */ #vaultKey;
  /** @type {OfficialMemoryClient|null} */ #client;
  /** @type {ContinuityState} */ #state;
  /** @type {() => number} */ #now;
  /** @type {string} Head hash this instance last loaded or committed (stale-writer guard). */ #loadedHead;
  /** @type {number} nextSeq this instance last loaded or committed. */ #loadedSeq;

  /**
   * @param {object} options
   * @param {Keychain} options.keychain        Loaded Keychain whose `_identity` owns this ledger. Required.
   * @param {ContinuityStore} [options.store]  Durable local store (e.g. CommonsStore). Defaults to volatile MemoryContinuityStore.
   * @param {OfficialMemoryClient|null} [options.client]  Injected official `UuaidClient`. Never constructed here.
   * @param {string|null} [options.vaultKey]   `uvk_…` key from `generateVaultKey()`. Held in a private field, never persisted.
   * @param {string} [options.slot]            Vault slot path; defaults to `continuity/chain`.
   * @param {Partial<ContinuityLimits>} [options.limits]
   * @param {() => number} [options.now]       Clock injection for tests (ms since epoch).
   */
  constructor({ keychain, store = new MemoryContinuityStore(), client = null, vaultKey = null, slot = "continuity/chain", limits = {}, now = () => Date.now() } = {}) {
    const identity = keychain?._identity;
    if (!identity || !UUAID_RE.test(identity.uuaid ?? "") || !/^[0-9a-f]{64}$/.test(identity.publicKeyHex ?? "") || typeof keychain.sign !== "function") throw new ContinuityError("IDENTITY_REQUIRED", "A loaded Keychain with a bound agent UUAID is required");
    if (Keychain.localIdFromKey(Buffer.from(identity.publicKeyHex, "hex")) !== identity.uuaid.split(":")[3]) throw new ContinuityError("IDENTITY_REQUIRED", "Keychain public key is not bound to its UUAID");
    if (client !== null && (typeof client !== "object" || typeof client.saveMemory !== "function" || typeof client.loadMemory !== "function")) throw new ContinuityError("CLIENT_INVALID", "Injected client must expose the official saveMemory/loadMemory surface");
    if (vaultKey !== null && !VAULT_KEY_RE.test(vaultKey)) throw new ContinuityError("VAULT_KEY_INVALID", "Vault key must be a uvk_ key from @uuaid/sdk generateVaultKey()");
    if (!store || typeof store.get !== "function" || typeof store.set !== "function") throw new ContinuityError("CLIENT_INVALID", "Store must expose get(key,fallback) and set(key,value)");
    this.keychain = keychain;
    this.uuaid = identity.uuaid;
    this.publicKey = identity.publicKeyHex;
    this.store = store;
    this.slot = validateSlot(slot);
    /** @type {ContinuityLimits} */
    this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...limits });
    for (const [k, v] of Object.entries(this.limits)) if (!Number.isSafeInteger(v) || v <= 0) throw new ContinuityError("BUDGET_EXHAUSTED", `Limit ${k} must be a positive integer`);
    this.#client = client;
    this.#vaultKey = vaultKey;
    this.#now = now;
    this.#state = this.#load();
    this.#loadedHead = this.#head(); this.#loadedSeq = this.#state.nextSeq;
  }

  /** Store key under which this identity's ledger lives. Scoped by UUAID so two agents sharing one store never collide. */
  static storeKey(uuaid) { return `continuity:${uuaid}`; }

  /**
   * Explicitly move a corrupt or foreign ledger blob aside so a fresh ledger can be
   * opened. This is an operator decision, never automatic: the constructor fails
   * closed instead of calling this. Returns the quarantine key or null if nothing was stored.
   * @param {ContinuityStore} store
   * @param {string} uuaid
   * @returns {string|null}
   */
  static quarantine(store, uuaid) {
    const key = ContinuityMemory.storeKey(uuaid);
    const blob = store.get(key, null);
    if (blob === null) return null;
    const quarantineKey = `${key}:quarantine:${new Date().toISOString()}`;
    runAtomically(store, () => { store.set(quarantineKey, blob); store.set(key, null); });
    return quarantineKey;
  }

  #owner() { return { uuaid: this.uuaid, publicKey: this.publicKey }; }

  /** @returns {ContinuityState} */
  #load() {
    const stored = this.store.get(ContinuityMemory.storeKey(this.uuaid), null);
    if (stored === null || stored === undefined) return { v: CONTINUITY_PROTOCOL, uuaid: this.uuaid, publicKey: this.publicKey, nextSeq: 0, anchor: { previous: "genesis", pruned: 0, through: null }, entries: [], sync: { lastPush: null, lastPull: null } };
    const state = verifyContinuity(stored, this.#owner(), this.#envelope(false)); // age tolerated locally: expired entries are pruned on the next write/compact(), never shipped
    state.sync ??= { lastPush: null, lastPull: null };
    return state;
  }

  #persist() { this.store.set(ContinuityMemory.storeKey(this.uuaid), this.#state); }

  /**
   * Optimistic concurrency guard. Multiple ContinuityMemory instances (or processes)
   * may share one store for the same identity; each instance caches the state it
   * loaded. Before any write we re-read the stored blob and require its head and
   * sequence counter to equal the ones this instance last loaded or committed. A
   * mismatch means another writer advanced the ledger: we throw `STALE_WRITER` and
   * change nothing. The caller must `reload()` and re-apply its intent explicitly.
   */
  #assertFresh() {
    const stored = this.store.get(ContinuityMemory.storeKey(this.uuaid), null);
    const storedHead = stored == null ? "genesis" : (stored.entries?.length ? stored.entries.at(-1)?.hash : stored.anchor?.previous);
    const storedSeq = stored == null ? 0 : stored.nextSeq;
    if (storedHead !== this.#loadedHead || storedSeq !== this.#loadedSeq) throw new ContinuityError("STALE_WRITER", "Another instance advanced this identity's ledger; reload() before writing", { expectedHead: this.#loadedHead, storedHead, expectedSeq: this.#loadedSeq, storedSeq });
  }

  /** Run a state mutation atomically with the stale-writer guard; rolls back in-memory state on any failure. */
  #commit(mutate) {
    const before = structuredClone(this.#state);
    const loaded = [this.#loadedHead, this.#loadedSeq];
    try {
      return runAtomically(this.store, () => {
        this.#assertFresh();
        const result = mutate();
        this.#persist();
        this.#loadedHead = this.#head(); this.#loadedSeq = this.#state.nextSeq;
        return result;
      });
    } catch (e) { this.#state = before; [this.#loadedHead, this.#loadedSeq] = loaded; throw e; }
  }

  /**
   * Explicitly discard this instance's cached state and re-read (and re-verify) the
   * stored ledger. Required after `STALE_WRITER`. Never merges: whatever the store
   * holds becomes this instance's view, and any un-committed intent is the caller's
   * to re-apply.
   * @returns {{head:string,entries:number}}
   */
  reload() {
    this.#state = this.#load();
    this.#loadedHead = this.#head(); this.#loadedSeq = this.#state.nextSeq;
    return { head: this.#loadedHead, entries: this.#state.entries.length };
  }

  #head(state = this.#state) { return state.entries.length ? state.entries.at(-1).hash : state.anchor.previous; }

  #bytes(entries = this.#state.entries) { return entries.reduce((n, e) => n + bytesOf(e), 0); }

  /**
   * Apply retention and budgets, evicting oldest unpinned entries first. Each
   * eviction advances the anchor so the remaining chain still verifies.
   * @param {number} incomingBytes
   * @param {number} [incomingCount]
   */
  #prune(incomingBytes, incomingCount = 1) {
    const { entries, anchor } = this.#state;
    const cutoff = this.#now() - this.limits.retentionMs;
    const evict = (index) => {
      const [gone] = entries.splice(index, 1);
      anchor.previous = gone.hash; anchor.pruned += 1; anchor.through = gone.at;
      if (entries.length && entries[0].previous !== gone.hash) throw new ContinuityError("INTEGRITY", "Eviction would break the continuity chain");
    };
    while (entries.length && !entries[0].pin && Date.parse(entries[0].at) < cutoff) evict(0);
    while (entries.length + incomingCount > this.limits.maxEntries || this.#bytes() + incomingBytes > this.limits.maxBytes) {
      const index = entries.findIndex(e => !e.pin);
      if (index !== 0) throw new ContinuityError("BUDGET_EXHAUSTED", index === -1 ? "Continuity budget exhausted by pinned entries" : "Cannot evict past a pinned entry without breaking the chain", { limits: this.limits });
      evict(index);
    }
  }

  /**
   * Append a memory. Fails closed on invalid kind/provenance, oversize entries, or an
   * exhausted budget; on success the entry is signed, chained, and persisted.
   *
   * @param {string} kind
   * @param {unknown} content   Canonical-JSON-safe value.
   * @param {Partial<Provenance> & {pin?:boolean}} [provenance]
   * @returns {ContinuityEntry}
   */
  remember(kind, content, provenance = {}) {
    if (typeof kind !== "string" || !KIND_RE.test(kind)) throw new ContinuityError("ENTRY_INVALID", "Kind must be lower-case [a-z0-9:_-], ≤64 chars");
    const source = provenance.source ?? "self";
    const actor = provenance.actor ?? this.uuaid;
    if (!PROVENANCE_SOURCES.includes(source)) throw new ContinuityError("ENTRY_INVALID", "Unknown provenance source", { source });
    if (!UUAID_RE.test(actor)) throw new ContinuityError("ENTRY_INVALID", "Provenance actor must be an agent UUAID");
    if (source === "self" && actor !== this.uuaid) throw new ContinuityError("ENTRY_INVALID", "Self-provenance must name the owner as actor");
    if (source === "peer" && actor === this.uuaid) throw new ContinuityError("ENTRY_INVALID", "Peer-provenance cannot name the owner as actor");
    if (provenance.evidence != null && !/^[0-9a-f]{64}$/.test(provenance.evidence)) throw new ContinuityError("ENTRY_INVALID", "Evidence must be a sha256 hex digest");
    const body = {
      v: CONTINUITY_PROTOCOL, seq: this.#state.nextSeq, id: randomUUID(), at: isoNow(this.#now), kind, content,
      provenance: { source, actor, origin: provenance.origin ?? null, evidence: provenance.evidence ?? null },
      pin: provenance.pin === true, previous: this.#head(),
    };
    try { assertJSON(body); } catch (e) { throw new ContinuityError("ENTRY_INVALID", e.message); }
    const hash = digest(body);
    const entry = { ...body, hash, signature: this.keychain.sign(Buffer.from(hash, "hex")).toString("hex") };
    const size = bytesOf(entry);
    if (size > this.limits.maxEntryBytes) throw new ContinuityError("ENTRY_TOO_LARGE", "Entry exceeds maxEntryBytes", { size, limit: this.limits.maxEntryBytes });
    this.#commit(() => {
      this.#prune(size);
      this.#state.entries.push(entry);
      this.#state.nextSeq += 1;
    });
    return structuredClone(entry);
  }

  /**
   * Explicitly apply retention/budget pruning without appending. Use before `push()`
   * when `status().verified` is false solely because unpinned entries aged past
   * `retentionMs` while this instance was alive. Returns the number of entries evicted.
   * @returns {number}
   */
  compact() {
    const before = this.#state.entries.length;
    this.#commit(() => this.#prune(0, 0));
    return before - this.#state.entries.length;
  }

  /**
   * Read retained entries, oldest first.
   * @param {{kind?:string,since?:string,source?:ProvenanceSource,limit?:number}} [filter]
   * @returns {ContinuityEntry[]}
   */
  recall({ kind, since, source, limit = this.limits.maxEntries } = {}) {
    let out = this.#state.entries;
    if (kind) out = out.filter(e => e.kind === kind);
    if (source) out = out.filter(e => e.provenance.source === source);
    if (since) out = out.filter(e => e.at > since);
    return structuredClone(out.slice(-limit));
  }

  /** Re-verify the whole local ledger. Returns false (never throws) so callers can gate behavior. */
  verify() { try { verifyContinuity(this.#state, this.#owner(), this.#envelope(false)); return true; } catch { return false; } }

  #envelope(age = true) { return { limits: this.limits, now: this.#now, age }; }

  /** Number of retained unpinned entries older than retentionMs (would be evicted by the next write or compact()). */
  expired() { const cutoff = this.#now() - this.limits.retentionMs; return this.#state.entries.filter(e => !e.pin && Date.parse(e.at) < cutoff).length; }

  /** Current head hash (last entry hash, or anchor hash when no entries are retained). */
  head() { return this.#head(); }

  /**
   * Non-secret status view. Never includes the vault key or client internals.
   * @returns {{uuaid:string,entries:number,bytes:number,pruned:number,head:string,anchor:ContinuityAnchor,limits:ContinuityLimits,verified:boolean,expired:number,durable:boolean,remote:{configured:boolean,slot:string,lastPush:SyncReceipt|null,lastPull:SyncReceipt|null}}}
   */
  status() {
    return structuredClone({
      uuaid: this.uuaid, entries: this.#state.entries.length, bytes: this.#bytes(), pruned: this.#state.anchor.pruned, head: this.#head(), anchor: this.#state.anchor,
      limits: this.limits, verified: this.verify(), expired: this.expired(), durable: !(this.store instanceof MemoryContinuityStore),
      remote: { configured: this.#client !== null && this.#vaultKey !== null, slot: this.slot, lastPush: this.#state.sync.lastPush, lastPull: this.#state.sync.lastPull },
    });
  }

  /**
   * Export a verifiable snapshot (what `push()` encrypts). Contains no secrets and no sync receipts.
   * @returns {ContinuitySnapshot}
   */
  snapshot() {
    const { v, uuaid, publicKey, nextSeq, anchor, entries } = this.#state;
    return structuredClone({ v, uuaid, publicKey, nextSeq, anchor, entries, head: this.#head(), exportedAt: isoNow(this.#now) });
  }

  #requireRemote() {
    if (this.#client === null || this.#vaultKey === null) throw new ContinuityError("REMOTE_NOT_CONFIGURED", "Remote continuity requires an injected official client and a vault key");
    verifyContinuity(this.#state, this.#owner(), this.#envelope(true)); // expired entries must be compact()ed before any remote operation
    this.#assertFresh(); // never ship or reconcile a cached view another instance has already advanced
  }

  /**
   * Encrypt (inside the official SDK) and upload the current snapshot to this
   * agent's vault slot. Explicit; never called automatically.
   * @returns {Promise<SyncReceipt>}
   */
  async push() {
    this.#requireRemote();
    const text = jcs(this.snapshot());
    const sizeBytes = Buffer.byteLength(text, "utf-8");
    if (sizeBytes > this.limits.maxBytes * 2) throw new ContinuityError("BUDGET_EXHAUSTED", "Snapshot exceeds remote byte budget", { sizeBytes });
    let result;
    try { result = await this.#client.saveMemory(this.uuaid, this.slot, text, this.#vaultKey); }
    catch (e) { throw new ContinuityError("REMOTE_UNAVAILABLE", `Remote save failed: ${e?.message ?? e}`, { status: e?.status ?? null }); }
    if (!result || result.agent !== this.uuaid || result.key !== this.slot) throw new ContinuityError("REMOTE_MISMATCH", "Registry acknowledged a different agent or slot", { result: result ?? null });
    /** @type {SyncReceipt} */
    const receipt = { at: isoNow(this.#now), head: this.#head(), contentHash: typeof result.content_hash === "string" ? result.content_hash : null, sizeBytes, replaced: typeof result.replaced === "boolean" ? result.replaced : null, relation: "pushed" };
    // Re-checked after the await: if a sibling wrote meanwhile, the remote now holds a
    // stale snapshot relative to the store. Surface that loudly instead of recording success.
    this.#commit(() => { this.#state.sync.lastPush = receipt; });
    return structuredClone(receipt);
  }

  /**
   * Download and decrypt (inside the official SDK) the remote snapshot and reconcile
   * it with local history. Outcomes:
   * - `remote-empty`: slot does not exist yet (HTTP 404); local unchanged.
   * - `in-sync`: identical heads; local unchanged.
   * - `fast-forwarded`: local head is an ancestor of the remote head; remote adopted.
   * - `local-ahead`: remote head is an ancestor of local head; local unchanged.
   * Any other relationship throws `DIVERGED` and changes nothing.
   * @returns {Promise<SyncReceipt>}
   */
  async pull() {
    this.#requireRemote();
    let text;
    try { text = await this.#client.loadMemory(this.uuaid, this.slot, this.#vaultKey); }
    catch (e) {
      if (e?.status === 404) return this.#receipt("remote-empty", 0);
      throw new ContinuityError("REMOTE_UNAVAILABLE", `Remote load failed: ${e?.message ?? e}`, { status: e?.status ?? null });
    }
    if (typeof text !== "string") throw new ContinuityError("REMOTE_MISMATCH", "Official client must return decrypted text");
    let remote;
    try { remote = JSON.parse(text); } catch { throw new ContinuityError("INTEGRITY", "Remote snapshot is not JSON"); }
    verifyContinuity(remote, this.#owner(), this.#envelope()); // chain, signatures, identity AND this instance's limits; over-limit remotes are refused whole
    const sizeBytes = Buffer.byteLength(text, "utf-8");
    const localHead = this.#head(), remoteHead = remote.head;
    const known = (state, hash) => hash === state.anchor.previous || state.entries.some(e => e.hash === hash);
    if (remoteHead === localHead) return this.#receipt("in-sync", sizeBytes);
    if (remoteHead === "genesis" && remote.entries.length === 0) return this.#receipt("remote-empty", sizeBytes);
    if (known(remote, localHead)) {
      if (remote.nextSeq < this.#state.nextSeq) throw new ContinuityError("DIVERGED", "Remote claims to be ahead but has a smaller sequence counter");
      return this.#commit(() => {
        const sync = this.#state.sync;
        this.#state = { v: CONTINUITY_PROTOCOL, uuaid: this.uuaid, publicKey: this.publicKey, nextSeq: remote.nextSeq, anchor: structuredClone(remote.anchor), entries: structuredClone(remote.entries), sync };
        const receipt = { at: isoNow(this.#now), head: this.#head(), contentHash: null, sizeBytes, replaced: null, relation: "fast-forwarded" };
        this.#state.sync.lastPull = receipt;
        return structuredClone(receipt);
      });
    }
    if (known(this.#state, remoteHead)) return this.#receipt("local-ahead", sizeBytes);
    throw new ContinuityError("DIVERGED", "Local and remote continuity histories have diverged; refusing to merge", { localHead, remoteHead });
  }

  #receipt(relation, sizeBytes) {
    /** @type {SyncReceipt} */
    const receipt = { at: isoNow(this.#now), head: this.#head(), contentHash: null, sizeBytes, replaced: null, relation };
    this.#commit(() => { this.#state.sync.lastPull = receipt; });
    return structuredClone(receipt);
  }

  /**
   * Pull, then push only when local history is ahead of (or the sole source for) the remote.
   * @returns {Promise<{pull:SyncReceipt,push:SyncReceipt|null}>}
   */
  async sync() {
    const pull = await this.pull();
    const push = ["local-ahead", "remote-empty"].includes(pull.relation) ? await this.push() : null;
    return { pull, push };
  }
}
