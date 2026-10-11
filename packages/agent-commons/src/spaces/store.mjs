/**
 * The space store (design §8). Additive; imports the vendored pillar engine
 * ONLY through ./pillar-group.mjs (C9). Computes no engine-vs-client hash
 * (C13/V-7). Never opens engine.db (F9); it only hands back the path.
 *
 * Layout under <commonsHome>/spaces/ (all dirs 0700, all files 0600, atomic):
 *   groups-v2/grp-<32 hex>.json   roster record, via the vendored RosterStore
 *   grp-<32 hex>/adapter.json     adapter state (this file)
 *   grp-<32 hex>/engine.db        this space's own engine store (path only)
 *   dispatcher.json               per-carrier cursors
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, renameSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RosterStore, isGroupIdV2 } from "./pillar-group.mjs";

export const ADAPTER_V = "commons-space-adapter/1";
export const DISPATCHER_V = "commons-space-dispatcher/1";
export const PENDING_TTL_MS = 60 * 60 * 1000; // S-3: a pending removal lives at most 1 hour

const HEX64 = /^[0-9a-f]{64}$/;
const HARD_REASONS = ["outsider", "policy-mismatch"]; // A-4, P-9 (HS-1)
const SOFT_REASONS = ["reconsent"]; // P-12 (HS-1)

// Exact key sets, one per level. A strict set at every level is what refuses a
// `policy`/`agents` key anywhere (S-4: policy is derived, never stored) and a
// `body` inside a heldRefs entry (L-6: metadata only) — neither is in a set.
const ADAPTER_KEYS = ["v", "groupId", "channels", "profile", "consent", "hardStop", "softStop", "pendingRemovals", "heldRefs"];
const CHANNELS_KEYS = ["content", "control"];
const PROFILE_KEYS = ["id", "hash"];
const CONSENT_KEYS = ["manifestVersion", "charterHash", "carriers"];
const STOP_KEYS = ["reason", "at"];
const PENDING_KEYS = ["uuaid", "key", "manifestVersion", "queuedAt", "outboxId"];
const HELDREF_KEYS = ["ref", "groupId", "from", "msgId", "receivedAt"];
const DISPATCHER_KEYS = ["v", "cursors"];

const plain = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const nonEmptyString = (s) => typeof s === "string" && s.length > 0;
const hex64 = (s) => typeof s === "string" && HEX64.test(s);
const safeInt = (n) => Number.isSafeInteger(n);
const posInt = (n) => safeInt(n) && n >= 1;
const nonNegInt = (n) => safeInt(n) && n >= 0;

function exactKeys(obj, keys) {
  if (!plain(obj)) return false;
  const own = Object.keys(obj);
  if (own.length !== keys.length) return false;
  return keys.every((k) => Object.hasOwn(obj, k));
}

/** A named error, so a caller (and a pole) can tell a bad shape from an absent file. */
export class SpaceStoreError extends Error {
  constructor(name, message) { super(message); this.name = name; }
}
const badId = (id) => new SpaceStoreError("GroupIdError", `not a v2 group id: ${String(id)}`);
const badAdapter = (why) => new SpaceStoreError("AdapterStateError", `adapter.json: ${why}`);
const badDispatcher = (why) => new SpaceStoreError("DispatcherStateError", `dispatcher.json: ${why}`);

function validateStop(stop, reasons, label) {
  if (stop === null) return;
  if (!exactKeys(stop, STOP_KEYS)) throw badAdapter(`${label}: expected null or {reason, at}`);
  if (!reasons.includes(stop.reason)) throw badAdapter(`${label}.reason: not one of ${reasons.join("|")}`);
  if (!safeInt(stop.at)) throw badAdapter(`${label}.at: not a safe integer`);
}

/**
 * Strict shape check of an adapter state. Throws AdapterStateError on any
 * deviation. When `id` is given, the record's groupId must match it.
 */
export function validateAdapterState(state, id) {
  if (!exactKeys(state, ADAPTER_KEYS)) throw badAdapter("top-level key set is not exact (a policy/agents key is refused here, S-4)");
  if (state.v !== ADAPTER_V) throw badAdapter(`v: expected ${ADAPTER_V}`);
  if (!isGroupIdV2(state.groupId)) throw badAdapter("groupId: not a v2 group id");
  if (id !== undefined && state.groupId !== id) throw badAdapter("groupId does not match the space it is stored under");
  if (!exactKeys(state.channels, CHANNELS_KEYS)) throw badAdapter("channels: expected {content, control}");
  if (!nonEmptyString(state.channels.content)) throw badAdapter("channels.content: not a non-empty string");
  if (!nonEmptyString(state.channels.control)) throw badAdapter("channels.control: not a non-empty string");
  if (!exactKeys(state.profile, PROFILE_KEYS)) throw badAdapter("profile: expected {id, hash}");
  if (!nonEmptyString(state.profile.id)) throw badAdapter("profile.id: not a non-empty string");
  if (!hex64(state.profile.hash)) throw badAdapter("profile.hash: not a 64-hex sha256");
  if (!exactKeys(state.consent, CONSENT_KEYS)) throw badAdapter("consent: expected {manifestVersion, charterHash, carriers}");
  if (!posInt(state.consent.manifestVersion)) throw badAdapter("consent.manifestVersion: not a positive safe integer");
  if (!hex64(state.consent.charterHash)) throw badAdapter("consent.charterHash: not a 64-hex sha256");
  if (!Array.isArray(state.consent.carriers)) throw badAdapter("consent.carriers: not an array");
  if (!state.consent.carriers.every(nonEmptyString)) throw badAdapter("consent.carriers: every entry must be a non-empty string");
  validateStop(state.hardStop, HARD_REASONS, "hardStop");
  validateStop(state.softStop, SOFT_REASONS, "softStop");
  if (!Array.isArray(state.pendingRemovals)) throw badAdapter("pendingRemovals: not an array");
  for (const e of state.pendingRemovals) {
    if (!exactKeys(e, PENDING_KEYS)) throw badAdapter("pendingRemovals entry: expected {uuaid, key, manifestVersion, queuedAt, outboxId}");
    if (!nonEmptyString(e.uuaid)) throw badAdapter("pendingRemovals.uuaid: not a non-empty string");
    if (!hex64(e.key)) throw badAdapter("pendingRemovals.key: not a 64-hex public key");
    if (!posInt(e.manifestVersion)) throw badAdapter("pendingRemovals.manifestVersion: not a positive safe integer");
    if (!safeInt(e.queuedAt)) throw badAdapter("pendingRemovals.queuedAt: not a safe integer");
    if (!nonEmptyString(e.outboxId)) throw badAdapter("pendingRemovals.outboxId: not a non-empty string");
  }
  if (!Array.isArray(state.heldRefs)) throw badAdapter("heldRefs: not an array");
  for (const e of state.heldRefs) {
    if (!exactKeys(e, HELDREF_KEYS)) throw badAdapter("heldRefs entry: expected exactly {ref, groupId, from, msgId, receivedAt} (a body is refused here, L-6)");
    if (!nonEmptyString(e.ref)) throw badAdapter("heldRefs.ref: not a non-empty string");
    if (!isGroupIdV2(e.groupId)) throw badAdapter("heldRefs.groupId: not a v2 group id");
    if (!nonEmptyString(e.from)) throw badAdapter("heldRefs.from: not a non-empty string");
    if (!nonEmptyString(e.msgId)) throw badAdapter("heldRefs.msgId: not a non-empty string");
    if (!safeInt(e.receivedAt)) throw badAdapter("heldRefs.receivedAt: not a safe integer");
  }
}

function validateDispatcher(d) {
  if (!exactKeys(d, DISPATCHER_KEYS)) throw badDispatcher("top-level key set is not exact");
  if (d.v !== DISPATCHER_V) throw badDispatcher(`v: expected ${DISPATCHER_V}`);
  if (!plain(d.cursors)) throw badDispatcher("cursors: not an object");
  for (const [url, seq] of Object.entries(d.cursors)) {
    if (!nonEmptyString(url)) throw badDispatcher("cursors: a carrier url key is empty");
    if (!nonNegInt(seq)) throw badDispatcher(`cursors[${url}]: not a non-negative safe integer`);
  }
}

/** temp 0600 + wx, fsync, rename — the RosterStore.save pattern (groups-v2.mjs:414-426). */
function atomicWrite0600(filePath, text) {
  const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
  const fd = openSync(tmp, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, filePath);
}

/**
 * S-3 load-time pruning. Re-checks every pendingRemovals entry against the
 * roster record VERIFIED IN THE SAME CALL. An entry is kept only if (a) the
 * verified head shows the row removed with the same key, (b) the verified chain
 * carries the manifest at manifestVersion showing that row removed and
 * manifestVersion <= head.version, and (c) now - queuedAt <= 1 hour and
 * queuedAt <= now. Anything else is dropped, with one reason per entry.
 * `now` is injectable for tests.
 */
export function prunePendingRemovals(entries, rec, now) {
  const kept = [];
  const dropped = [];
  const head = rec && Array.isArray(rec.chain) && rec.chain.length > 0 ? rec.chain[rec.chain.length - 1] : null;
  for (const e of entries) {
    let reason = null;
    if (!rec || !head) {
      reason = "roster-absent"; // no verified roster -> nothing grants a keep
    } else {
      // (a) verified head
      const hrow = head.members?.find((r) => r.uuaid === e.uuaid);
      if (!hrow) reason = "head-no-row";
      else if (hrow.status !== "removed") reason = "head-not-removed";
      else if (hrow.key !== e.key) reason = "head-key-mismatch";
      // (b) verified chain carries the manifest at manifestVersion
      if (reason === null) {
        const man = rec.chain.find((m) => m.version === e.manifestVersion);
        if (!man) reason = "chain-manifest-absent";
        else if (e.manifestVersion > head.version) reason = "manifest-ahead-of-head";
        else {
          const mrow = man.members?.find((r) => r.uuaid === e.uuaid);
          if (!mrow || mrow.status !== "removed") reason = "chain-not-removed";
        }
      }
      // (c) the 1-hour window, and no future stamp
      if (reason === null) {
        if (e.queuedAt > now) reason = "future-stamp";
        else if (now - e.queuedAt > PENDING_TTL_MS) reason = "expired";
      }
    }
    if (reason === null) kept.push(e);
    else dropped.push({ entry: e, reason });
  }
  return { kept, dropped };
}

export class SpaceStore {
  /** @param {string} commonsHome the engine home chosen by the operator */
  constructor(commonsHome) {
    if (!nonEmptyString(commonsHome)) throw new SpaceStoreError("BadHomeError", "commonsHome: not a non-empty string");
    this.commonsHome = commonsHome;
    this.spacesHome = join(commonsHome, "spaces");
    // The vendored RosterStore makes groups-v2/ (0700) and writes 0600 atomically itself.
    this._roster = new RosterStore(this.spacesHome);
  }

  _ensureSpaces() {
    mkdirSync(this.spacesHome, { recursive: true, mode: 0o700 });
    chmodSync(this.spacesHome, 0o700);
  }

  _assertId(id) { if (!isGroupIdV2(id)) throw badId(id); }

  /** spaces/grp-<id>/ — validated before any fs call (P7). */
  groupDir(id) { this._assertId(id); return join(this.spacesHome, id); }
  /** spaces/grp-<id>/adapter.json */
  adapterPath(id) { return join(this.groupDir(id), "adapter.json"); }
  /** spaces/grp-<id>/engine.db — path only; F9 gives one engine store per space. Never opened here. */
  engineDbPath(id) { return join(this.groupDir(id), "engine.db"); }
  /** spaces/dispatcher.json */
  dispatcherPath() { return join(this.spacesHome, "dispatcher.json"); }
  /** spaces/groups-v2/grp-<id>.json (the vendored roster record path). */
  rosterPath(id) { this._assertId(id); return this._roster.path(id); }

  // ── roster (S-1, F13) ──────────────────────────────────────────────────

  /** Delegates to RosterStore.save, which refuses an unverified record (S-1). */
  saveRoster(rec) {
    this._ensureSpaces();
    this._roster.save(rec); // throws if the chain does not verify / head mismatches
  }

  /** The verified record, or null. Any read, parse or verify failure reads as ABSENT (F13). */
  loadRoster(id) {
    this._assertId(id);
    try { return this._roster.load(id); } catch { return null; }
  }

  // ── adapter.json ───────────────────────────────────────────────────────

  /** Validates the strict shape, then writes 0600 atomically under grp-<id>/. */
  saveAdapter(id, state) {
    this._assertId(id);
    validateAdapterState(state, id);
    const dir = this.groupDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    atomicWrite0600(this.adapterPath(id), JSON.stringify(state));
  }

  /**
   * Loads adapter state and runs S-3 pruning against the roster verified in the
   * same call. A MISSING file reads as null (no adapter state yet). A CORRUPT or
   * wrong-shape file THROWS — it never defaults, because defaulting would turn a
   * lost hardStop into "no stop" and widen authority (CL-1, HS-1).
   * @returns {null | { state: object, dropped: Array<{entry, reason}> }}
   */
  loadAdapter(id, { now = Date.now() } = {}) {
    this._assertId(id);
    const p = this.adapterPath(id);
    if (!existsSync(p)) return null;
    let raw;
    try { raw = readFileSync(p, "utf-8"); } catch (e) { throw badAdapter(`unreadable: ${e.message}`); }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { throw badAdapter(`not valid JSON: ${e.message}`); }
    validateAdapterState(parsed, id); // throws AdapterStateError on a bad shape
    const rec = this.loadRoster(id); // verified in THIS call
    const { kept, dropped } = prunePendingRemovals(parsed.pendingRemovals, rec, now);
    const state = { ...parsed, pendingRemovals: kept };
    return { state, dropped };
  }

  // ── dispatcher.json ────────────────────────────────────────────────────

  /** Validates and writes 0600 atomically at spaces/dispatcher.json. */
  saveDispatcher(d) {
    validateDispatcher(d);
    this._ensureSpaces();
    atomicWrite0600(this.dispatcherPath(), JSON.stringify(d));
  }

  /** A missing file means empty cursors; a bad shape throws (never defaults). */
  loadDispatcher() {
    const p = this.dispatcherPath();
    if (!existsSync(p)) return { v: DISPATCHER_V, cursors: {} };
    let raw;
    try { raw = readFileSync(p, "utf-8"); } catch (e) { throw badDispatcher(`unreadable: ${e.message}`); }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { throw badDispatcher(`not valid JSON: ${e.message}`); }
    validateDispatcher(parsed);
    return parsed;
  }
}
