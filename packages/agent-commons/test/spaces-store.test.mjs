/**
 * Space-store poles (design §8, P1-P7). File-system only, no signals.
 * Every home is an mkdtemp dir under the OS temp dir — never a real home.
 * Test identities are generated in-test (C12).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync, renameSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Keychain } from "../src/vendor/pillar/identity/keychain.mjs";
import {
  buildGenesis, buildNext, signManifest, newRecord, verifyChain,
} from "../src/vendor/pillar/groups-v2.mjs";
import {
  SpaceStore, SpaceStoreError, ADAPTER_V, DISPATCHER_V, PENDING_TTL_MS,
  validateAdapterState, prunePendingRemovals,
} from "../src/spaces/store.mjs";

const SPACES_DIR = fileURLToPath(new URL("../src/spaces/", import.meta.url));

// ── in-test fixtures ──────────────────────────────────────────────────────

function mkHome() {
  return mkdtempSync(join(tmpdir(), "spaces-store-"));
}

function identity() {
  const id = Keychain.generate();
  return { uuaid: id.uuaid, publicKeyHex: id.publicKeyHex, privateKey: id.privateKey };
}

/** A verified roster record: admin + two invited members, member1 removed at v2. */
function fixtureRoster() {
  const admin = identity();
  const m1 = identity();
  const m2 = identity();
  const genesis = signManifest(buildGenesis({
    name: "pole-space",
    creator: admin,
    members: [{ uuaid: m1.uuaid, key: m1.publicKeyHex }, { uuaid: m2.uuaid, key: m2.publicKeyHex }],
    ext: {},
  }), admin);
  const removal = signManifest(buildNext(genesis, "remove", { target: m1.uuaid }), admin);
  const chain = [genesis, removal];
  assert.equal(verifyChain(chain).ok, true, "fixture chain verifies");
  const rec = newRecord(chain);
  return { admin, m1, m2, rec, groupId: genesis.id };
}

function fixtureAdapter(groupId, m1, now, overrides = {}) {
  return {
    v: ADAPTER_V,
    groupId,
    channels: { content: `channel://agentnet/group/${groupId}`, control: `channel://agentnet/group-ctl/${groupId}` },
    profile: { id: "prof-pole", hash: "a".repeat(64) },
    consent: { manifestVersion: 2, charterHash: "b".repeat(64), carriers: ["carrier://pole/one"] },
    hardStop: { reason: "outsider", at: now },
    softStop: { reason: "reconsent", at: now },
    pendingRemovals: [{ uuaid: m1.uuaid, key: m1.publicKeyHex, manifestVersion: 2, queuedAt: now - 1000, outboxId: "ob-pole-1" }],
    heldRefs: [{ ref: "ref-pole-1", groupId, from: m1.uuaid, msgId: "gm-" + "c".repeat(16), receivedAt: now }],
    ...overrides,
  };
}

const mode = (p) => statSync(p).mode & 0o777;

// ── P1: S-3 load-time pruning ─────────────────────────────────────────────

test("P1 CONTROL: S-3 keeps a valid pending removal and drops every other kind, with a reason each", () => {
  // The test must not take its TTL from the code under test. Use the literal and pin
  // the constant to it, so a changed PENDING_TTL_MS is caught here.
  assert.equal(PENDING_TTL_MS, 3_600_000, "S-3 TTL is exactly 1 hour");
  const TTL = 3_600_000;
  const { rec, groupId, m1, m2 } = fixtureRoster();
  const now = 1_800_000_000_000;
  const valid = { uuaid: m1.uuaid, key: m1.publicKeyHex, manifestVersion: 2, queuedAt: now - 1000, outboxId: "ob-1" };
  const entries = [
    valid,
    { ...valid, uuaid: m2.uuaid, key: m2.publicKeyHex, outboxId: "ob-2" }, // not removed in the head
    { ...valid, key: "d".repeat(64), outboxId: "ob-3" }, // wrong key
    { ...valid, queuedAt: now - TTL - 1, outboxId: "ob-4" }, // older than 1 hour
    { ...valid, queuedAt: now + 1000, outboxId: "ob-5" }, // future-stamped
    { ...valid, manifestVersion: 99, outboxId: "ob-6" }, // no such manifest in the chain
  ];
  const { kept, dropped } = prunePendingRemovals(entries, rec, now);
  assert.deepEqual(kept, [valid]);
  assert.deepEqual(dropped.map((d) => d.reason), [
    "head-not-removed", "head-key-mismatch", "expired", "future-stamp", "chain-manifest-absent",
  ]);
  // Roster absent -> every entry dropped.
  const gone = prunePendingRemovals(entries, null, now);
  assert.equal(gone.kept.length, 0);
  assert.deepEqual(gone.dropped.map((d) => d.reason), entries.map(() => "roster-absent"));
});

test("P1 CONTROL: S-3 window boundaries — exactly-at-TTL and exactly-at-now are kept; TTL+1 expires, now+1 is future-stamped", () => {
  const { rec, m1 } = fixtureRoster();
  const now = 1_800_000_000_000;
  const TTL = 3_600_000; // literal, not the module's constant
  const at = (queuedAt, outboxId) => ({ uuaid: m1.uuaid, key: m1.publicKeyHex, manifestVersion: 2, queuedAt, outboxId });
  const atTTL = at(now - TTL, "at-ttl");       // age exactly 1 h -> keep (<= TTL)
  const atNow = at(now, "at-now");             // age 0 -> keep
  const pastTTL = at(now - TTL - 1, "past-ttl"); // age TTL+1 -> expired
  const aheadNow = at(now + 1, "ahead-now");     // queuedAt now+1 -> future-stamp
  const { kept, dropped } = prunePendingRemovals([atTTL, atNow, pastTTL, aheadNow], rec, now);
  assert.deepEqual(kept.map((e) => e.outboxId), ["at-ttl", "at-now"]);
  assert.deepEqual(dropped.map((d) => [d.entry.outboxId, d.reason]), [["past-ttl", "expired"], ["ahead-now", "future-stamp"]]);
});

test("P1 CONTROL: a non-finite clock keeps nothing — undefined, NaN and 'abc' each drop as bad-clock (S-3 fails closed)", () => {
  const { rec, groupId, m1 } = fixtureRoster();
  const now = 1_800_000_000_000;
  // An entry that a finite clock keeps: age 1 s, member removed at the head, key matches.
  const fresh = { uuaid: m1.uuaid, key: m1.publicKeyHex, manifestVersion: 2, queuedAt: now - 1000, outboxId: "ob-fresh" };
  assert.equal(prunePendingRemovals([fresh], rec, now).kept.length, 1, "control: a finite clock keeps it");
  for (const bad of [undefined, NaN, "abc"]) {
    const { kept, dropped } = prunePendingRemovals([fresh], rec, bad);
    assert.equal(kept.length, 0, `now=${String(bad)} keeps 0 entries`);
    assert.deepEqual(dropped.map((d) => d.reason), ["bad-clock"], `now=${String(bad)} drops as bad-clock`);
  }
  // The loadAdapter seam: its `= Date.now()` default catches only an absent option, so
  // an explicitly passed NaN or "abc" must also fail closed through the store.
  const home = mkHome();
  try {
    const store = new SpaceStore(home);
    store.saveRoster(rec);
    store.saveAdapter(groupId, fixtureAdapter(groupId, m1, now));
    for (const bad of [NaN, "abc"]) {
      const out = store.loadAdapter(groupId, { now: bad });
      assert.equal(out.state.pendingRemovals.length, 0, `loadAdapter now=${String(bad)} keeps 0`);
      assert.deepEqual(out.dropped.map((d) => d.reason), ["bad-clock"]);
    }
    // An absent option falls back to the REAL clock, so pin it with a real-clock entry.
    // (The 1_800_000_000_000 fixture stamp is 2027-01-15T07:59:59Z: a window check
    // against it would fail for the hour after that instant, so it cannot pin a
    // default-clock read.) Re-stamp the removed member at Date.now()-1000 and require
    // both a bare call and an empty options object to keep exactly 1.
    store.saveAdapter(groupId, fixtureAdapter(groupId, m1, Date.now()));
    assert.equal(store.loadAdapter(groupId).state.pendingRemovals.length, 1,
      "a bare load keeps a real-clock entry (the default clock is Date.now(), not undefined)");
    assert.equal(store.loadAdapter(groupId, {}).state.pendingRemovals.length, 1,
      "an absent `now` option falls back to the real clock and keeps the entry");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("P1 CONTROL: a clock that is finite but not a safe integer keeps nothing — a fraction, 2**60 and MAX_SAFE_INTEGER+2 each drop as bad-clock", () => {
  const { rec, m1 } = fixtureRoster();
  const now0 = 1_800_000_000_000;
  const fresh = { uuaid: m1.uuaid, key: m1.publicKeyHex, manifestVersion: 2, queuedAt: now0 - 1000, outboxId: "ob-safe" };
  assert.equal(prunePendingRemovals([fresh], rec, now0).kept.length, 1, "control: a safe-integer clock keeps it");
  // Number.isFinite accepts all three; Number.isSafeInteger must not. A fractional clock
  // compares loosely against an integer stamp, and a value past 2**53-1 cannot represent
  // the 1 ms the window is decided by, so neither can pin the TTL bound exactly.
  // A numeric string is finite and `Number()` would coerce it to a safe integer, so it
  // is the exact class a `Number(now)` guard would silently admit. It must not be.
  for (const bad of [String(now0), now0 + 0.5, 2 ** 60, Number.MAX_SAFE_INTEGER + 2]) {
    const { kept, dropped } = prunePendingRemovals([fresh], rec, bad);
    assert.equal(kept.length, 0, `now=${String(bad)} keeps 0 entries`);
    assert.deepEqual(dropped.map((d) => d.reason), ["bad-clock"], `now=${String(bad)} drops as bad-clock`);
  }
});

test("P1 CONTROL: an entry stamp that is not a safe integer keeps nothing — a numeric string, a fraction and NaN each drop as bad-entry", () => {
  const { rec, m1 } = fixtureRoster();
  const now = 1_800_000_000_000;
  const at = (queuedAt, outboxId) => ({ uuaid: m1.uuaid, key: m1.publicKeyHex, manifestVersion: 2, queuedAt, outboxId });
  // The disk path cannot carry these (validateAdapterState requires a safe-integer
  // queuedAt), but prunePendingRemovals is exported and a later slice may hand it
  // in-memory entries. `<=` and `-` would coerce a numeric string and keep it.
  const entries = [at(String(now - 1000), "str"), at(now - 1000.5, "frac"), at(NaN, "nan")];
  const { kept, dropped } = prunePendingRemovals(entries, rec, now);
  assert.equal(kept.length, 0, "no non-safe-integer stamp is kept");
  assert.deepEqual(dropped.map((d) => [d.entry.outboxId, d.reason]), [["str", "bad-entry"], ["frac", "bad-entry"], ["nan", "bad-entry"]]);
});

test("P1 CONTROL: the manifest-ahead-of-head guard fires on a hand-built out-of-order chain", () => {
  // Unreachable on a VERIFIED record (verifyChain forces contiguous 1..N), but
  // prunePendingRemovals is exported and trusts its `rec`, so a synthetic chain reaches it.
  const { m1 } = fixtureRoster();
  const now = 1_800_000_000_000;
  const row = { uuaid: m1.uuaid, key: m1.publicKeyHex, status: "removed" };
  const synthetic = { chain: [{ version: 1, members: [row] }, { version: 3, members: [row] }, { version: 2, members: [row] }] };
  const entry = { uuaid: m1.uuaid, key: m1.publicKeyHex, manifestVersion: 3, queuedAt: now - 1, outboxId: "ob-ahead" };
  const { kept, dropped } = prunePendingRemovals([entry], synthetic, now);
  assert.equal(kept.length, 0);
  assert.deepEqual(dropped.map((d) => d.reason), ["manifest-ahead-of-head"]);
});

test("P1 CONTROL: manifestVersion 1 against a v2 removal drops as chain-not-removed; an unknown uuaid drops as head-no-row", () => {
  const { rec, m1 } = fixtureRoster();
  const now = 1_800_000_000_000;
  // v1 (genesis) still shows m1 as invited/active, not removed -> chain-not-removed.
  const v1 = { uuaid: m1.uuaid, key: m1.publicKeyHex, manifestVersion: 1, queuedAt: now - 1000, outboxId: "ob-v1" };
  // An uuaid with no row anywhere in the head -> head-no-row.
  const stranger = { uuaid: "uu-" + "e".repeat(16), key: m1.publicKeyHex, manifestVersion: 2, queuedAt: now - 1000, outboxId: "ob-stranger" };
  const { kept, dropped } = prunePendingRemovals([v1, stranger], rec, now);
  assert.equal(kept.length, 0);
  assert.deepEqual(dropped.map((d) => [d.entry.outboxId, d.reason]), [["ob-v1", "chain-not-removed"], ["ob-stranger", "head-no-row"]]);
});

test("P1 CONTROL: loadAdapter prunes against the roster verified in the same call", () => {
  const home = mkHome();
  try {
    const { rec, groupId, m1 } = fixtureRoster();
    const now = 1_800_000_000_000;
    const store = new SpaceStore(home);
    store.saveRoster(rec);
    const adapter = fixtureAdapter(groupId, m1, now, {
      pendingRemovals: [
        { uuaid: m1.uuaid, key: m1.publicKeyHex, manifestVersion: 2, queuedAt: now - 1000, outboxId: "ob-keep" },
        { uuaid: m1.uuaid, key: m1.publicKeyHex, manifestVersion: 2, queuedAt: now - 3_600_000 - 1, outboxId: "ob-expired" },
      ],
    });
    store.saveAdapter(groupId, adapter);
    const out = store.loadAdapter(groupId, { now });
    assert.equal(out.state.pendingRemovals.length, 1);
    assert.equal(out.state.pendingRemovals[0].outboxId, "ob-keep");
    assert.deepEqual(out.dropped.map((d) => [d.entry.outboxId, d.reason]), [["ob-expired", "expired"]]);
    // The on-disk file is NOT rewritten by a load.
    assert.equal(JSON.parse(readFileSync(store.adapterPath(groupId), "utf-8")).pendingRemovals.length, 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("P1 CONTROL: loadAdapter with the roster tampered, then missing, drops every entry as roster-absent", () => {
  const home = mkHome();
  try {
    const { rec, groupId, m1 } = fixtureRoster();
    const now = 1_800_000_000_000;
    const store = new SpaceStore(home);
    store.saveRoster(rec);
    const adapter = fixtureAdapter(groupId, m1, now, {
      pendingRemovals: [{ uuaid: m1.uuaid, key: m1.publicKeyHex, manifestVersion: 2, queuedAt: now - 1000, outboxId: "ob-1" }],
    });
    store.saveAdapter(groupId, adapter);
    assert.equal(store.loadAdapter(groupId, { now }).state.pendingRemovals.length, 1, "control: verified roster keeps the entry");

    // Tamper the roster file (flip a chain byte): it no longer verifies -> loadRoster is null.
    const rp = store.rosterPath(groupId);
    const raw = readFileSync(rp, "utf-8");
    const mark = raw.indexOf('"signature":"') + '"signature":"'.length;
    writeFileSync(rp, raw.slice(0, mark) + (raw[mark] === "0" ? "1" : "0") + raw.slice(mark + 1), { mode: 0o600 });
    const tampered = store.loadAdapter(groupId, { now });
    assert.equal(tampered.state.pendingRemovals.length, 0, "tampered roster keeps nothing");
    assert.deepEqual(tampered.dropped.map((d) => d.reason), ["roster-absent"]);

    // Delete the roster file entirely -> still roster-absent (the adapter itself is intact).
    rmSync(rp);
    const missing = store.loadAdapter(groupId, { now });
    assert.equal(missing.state.pendingRemovals.length, 0, "missing roster keeps nothing");
    assert.deepEqual(missing.dropped.map((d) => d.reason), ["roster-absent"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── P2: S-1 / F13 roster ──────────────────────────────────────────────────

test("P2 CONTROL: a flipped chain byte loads as null; save refuses an unverified record", () => {
  const home = mkHome();
  try {
    const { rec, groupId } = fixtureRoster();
    const store = new SpaceStore(home);
    store.saveRoster(rec);
    assert.deepEqual(store.loadRoster(groupId), rec, "verified record round-trips");

    // Flip one hex byte inside the chain's first signature, in the stored file.
    const p = store.rosterPath(groupId);
    const raw = readFileSync(p, "utf-8");
    const sigMark = raw.indexOf('"signature":"');
    assert.ok(sigMark > 0, "the stored record carries a signature");
    const hexAt = sigMark + '"signature":"'.length;
    const flipped = raw.slice(0, hexAt) + (raw[hexAt] === "0" ? "1" : "0") + raw.slice(hexAt + 1);
    assert.notEqual(flipped, raw);
    assert.equal(JSON.parse(flipped).chain.length, 2, "the flip still parses as JSON");
    writeFileSync(p, flipped, { mode: 0o600 });
    assert.equal(store.loadRoster(groupId), null, "a corrupt roster reads as absent, never as trusted");

    // save refuses an unverified record (S-1).
    const bad = structuredClone(rec);
    bad.chain[1].name = "tampered";
    assert.throws(() => store.saveRoster(bad), /refusing to write/);
    assert.throws(() => store.saveRoster({ v: rec.v, id: rec.id }), /refusing to write/);
    // The refusal happens before any directory is created — a refused save
    // leaves no trace under a home that had none.
    const freshHome = mkHome();
    try {
      const fresh = new SpaceStore(freshHome);
      assert.throws(() => fresh.saveRoster(bad), /refusing to write/);
      assert.equal(existsSync(fresh.spacesHome), false, "a refused saveRoster creates no spaces/");
    } finally { rmSync(freshHome, { recursive: true, force: true }); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── P3: §8.1 modes and atomic writes ──────────────────────────────────────

test("P3 CONTROL: spaces/ and grp dirs are 0700, files 0600, no *.tmp left", () => {
  const home = mkHome();
  // Pin umask so the 0600 mode control is not umask-dependent: under umask 077 the
  // default file mode is already 0600 and dropping mode:0o600 would go unnoticed.
  // Force 022 for the body, restore it after.
  const savedUmask = process.umask(0o022);
  try {
    const { rec, groupId, m1 } = fixtureRoster();
    const now = 1_800_000_000_000;
    const store = new SpaceStore(home);
    store.saveRoster(rec);
    store.saveAdapter(groupId, fixtureAdapter(groupId, m1, now));
    store.saveDispatcher({ v: DISPATCHER_V, cursors: { "carrier://pole/one": 7 } });

    assert.equal(mode(store.spacesHome), 0o700, "spaces/ is 0700");
    assert.equal(mode(join(store.spacesHome, "groups-v2")), 0o700, "groups-v2/ is 0700");
    assert.equal(mode(store.groupDir(groupId)), 0o700, "grp dir is 0700");
    assert.equal(mode(store.rosterPath(groupId)), 0o600, "roster file is 0600");
    assert.equal(mode(store.adapterPath(groupId)), 0o600, "adapter.json is 0600");
    assert.equal(mode(store.dispatcherPath()), 0o600, "dispatcher.json is 0600");

    const tmps = [];
    for (const d of [store.spacesHome, join(store.spacesHome, "groups-v2"), store.groupDir(groupId)]) {
      for (const f of readdirSync(d)) if (f.includes(".tmp-")) tmps.push(join(d, f));
    }
    assert.deepEqual(tmps, [], "no temp file survives a save");
  } finally {
    process.umask(savedUmask);
    rmSync(home, { recursive: true, force: true });
  }
});

test("P3 CONTROL: saving twice replaces adapter.json by rename — the inode changes (atomic, not in place)", () => {
  const home = mkHome();
  try {
    const { rec, groupId, m1 } = fixtureRoster();
    const now = 1_800_000_000_000;
    const store = new SpaceStore(home);
    store.saveRoster(rec);
    store.saveAdapter(groupId, fixtureAdapter(groupId, m1, now));
    const p = store.adapterPath(groupId);
    const ino1 = statSync(p).ino;
    store.saveAdapter(groupId, fixtureAdapter(groupId, m1, now)); // save again
    const ino2 = statSync(p).ino;
    assert.notEqual(ino1, ino2, "a second save renames a fresh temp over the file, so the inode changes");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("P3 CONTROL: saveAdapter tightens a pre-existing spaces/ at 0755 to 0700", () => {
  const home = mkHome();
  try {
    const { rec, groupId, m1 } = fixtureRoster();
    const now = 1_800_000_000_000;
    const store = new SpaceStore(home);
    mkdirSync(store.spacesHome, { mode: 0o755 });
    chmodSync(store.spacesHome, 0o755);
    assert.equal(mode(store.spacesHome), 0o755, "precondition: spaces/ starts at 0755");
    store.saveAdapter(groupId, fixtureAdapter(groupId, m1, now)); // saveAdapter calls _ensureSpaces
    assert.equal(mode(store.spacesHome), 0o700, "saveAdapter tightens spaces/ to 0700");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── only ENOENT means absent: a non-ENOENT read failure must THROW ─────────

test("P5 CONTROL: a pre-existing 0755 spaces/ plus saveRoster ends at 0700", () => {
  const home = mkHome();
  try {
    const { rec } = fixtureRoster();
    const store = new SpaceStore(home);
    mkdirSync(store.spacesHome, { mode: 0o755 });
    chmodSync(store.spacesHome, 0o755); // mkdirSync's mode is umask-filtered; pin it
    assert.equal(mode(store.spacesHome), 0o755, "precondition: spaces/ starts at 0755");
    store.saveRoster(rec);
    assert.equal(mode(store.spacesHome), 0o700, "saveRoster tightens spaces/ to 0700");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("P5 CONTROL: saveAdapter with a string queuedAt throws AdapterStateError and writes nothing", () => {
  const { groupId, m1 } = fixtureRoster();
  const now = 1_800_000_000_000;
  const state = fixtureAdapter(groupId, m1, now);
  // The disk-side validator is the first copy of the safe-integer check; the pruning
  // guard is only defense in depth behind it. A numeric string must be refused at save.
  state.pendingRemovals[0].queuedAt = String(now - 1000);
  const home = mkHome();
  try {
    const store = new SpaceStore(home);
    assert.throws(() => store.saveAdapter(groupId, state), { name: "AdapterStateError" });
    assert.equal(existsSync(store.spacesHome), false, "a refused saveAdapter creates no spaces/");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("P5 CONTROL: a mode-000 grp dir makes loadAdapter throw AdapterStateError (EACCES is not absence)", { skip: process.getuid() === 0 && "root bypasses mode 000" }, () => {
  const home = mkHome();
  const { rec, groupId, m1 } = fixtureRoster();
  const now = 1_800_000_000_000;
  const store = new SpaceStore(home);
  store.saveRoster(rec);
  // A latched hardStop sits on disk; an EACCES-as-absent read would return null and
  // lose it, widening authority (CL-1, HS-1).
  store.saveAdapter(groupId, fixtureAdapter(groupId, m1, now, { hardStop: { reason: "outsider", at: now } }));
  const dir = store.groupDir(groupId);
  try {
    chmodSync(dir, 0o000);
    assert.throws(() => store.loadAdapter(groupId, { now }),
      (e) => e instanceof SpaceStoreError && e.name === "AdapterStateError" && /EACCES/.test(e.message),
      "a mode-000 grp dir throws AdapterStateError naming EACCES, never reads as null");
  } finally {
    chmodSync(dir, 0o700);
    rmSync(home, { recursive: true, force: true });
  }
});

test("P5 CONTROL: a mode-000 spaces/ makes loadDispatcher throw DispatcherStateError (EACCES is not empty cursors)", { skip: process.getuid() === 0 && "root bypasses mode 000" }, () => {
  const home = mkHome();
  const store = new SpaceStore(home);
  store.saveDispatcher({ v: DISPATCHER_V, cursors: { "carrier://pole/one": 5 } });
  try {
    chmodSync(store.spacesHome, 0o000);
    assert.throws(() => store.loadDispatcher(),
      (e) => e instanceof SpaceStoreError && e.name === "DispatcherStateError" && /EACCES/.test(e.message),
      "a mode-000 spaces/ throws DispatcherStateError naming EACCES, never reads as empty");
  } finally {
    chmodSync(store.spacesHome, 0o700);
    rmSync(home, { recursive: true, force: true });
  }
});

test("P5 CONTROL: grp-<id> replaced by a regular file makes loadAdapter throw AdapterStateError, never null (CL-1, HS-1)", () => {
  const home = mkHome();
  try {
    const { rec, groupId, m1 } = fixtureRoster();
    const now = 1_800_000_000_000;
    const store = new SpaceStore(home);
    store.saveRoster(rec);
    // Save a latched hardStop, then replace the grp dir with a regular file (ENOTDIR on read).
    store.saveAdapter(groupId, fixtureAdapter(groupId, m1, now, { hardStop: { reason: "outsider", at: now } }));
    renameSync(store.groupDir(groupId), store.groupDir(groupId) + ".moved");
    writeFileSync(store.groupDir(groupId), "x", { mode: 0o600 });
    // A stat-based absence check would say "absent" and return null, losing the latched hardStop.
    assert.throws(() => store.loadAdapter(groupId, { now }),
      (e) => e instanceof SpaceStoreError && e.name === "AdapterStateError",
      "a grp path that is a file throws, never reads as null");
    chmodSync(store.groupDir(groupId), 0o644);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("P5 CONTROL: spaces/ replaced by a regular file makes loadDispatcher throw DispatcherStateError, never empty cursors", () => {
  const home = mkHome();
  try {
    const store = new SpaceStore(home);
    store.saveDispatcher({ v: DISPATCHER_V, cursors: { "carrier://pole/one": 5 } });
    renameSync(store.spacesHome, store.spacesHome + ".moved");
    writeFileSync(store.spacesHome, "x", { mode: 0o600 });
    assert.throws(() => store.loadDispatcher(),
      (e) => e instanceof SpaceStoreError && e.name === "DispatcherStateError",
      "a spaces/ path that is a file throws, never reads as empty cursors");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── P4: restart ───────────────────────────────────────────────────────────

test("P4 CONTROL: a NEW store instance reads back hardStop, softStop, heldRefs and pendingRemovals unchanged", () => {
  const home = mkHome();
  try {
    const { rec, groupId, m1 } = fixtureRoster();
    const now = 1_800_000_000_000; // pending is inside the 1-hour window at this `now`
    const adapter = fixtureAdapter(groupId, m1, now);
    const first = new SpaceStore(home);
    first.saveRoster(rec);
    first.saveAdapter(groupId, adapter);
    first.saveDispatcher({ v: DISPATCHER_V, cursors: { "carrier://pole/one": 3 } });

    const second = new SpaceStore(home); // restart
    const out = second.loadAdapter(groupId, { now });
    assert.deepEqual(out.state.hardStop, adapter.hardStop, "hardStop survives the restart");
    assert.deepEqual(out.state.softStop, adapter.softStop, "softStop survives the restart");
    assert.deepEqual(out.state.heldRefs, adapter.heldRefs, "heldRefs survive the restart");
    assert.deepEqual(out.state.pendingRemovals, adapter.pendingRemovals, "pendingRemovals survive inside the window");
    assert.deepEqual(out.dropped, []);
    assert.deepEqual(second.loadRoster(groupId), rec);
    assert.deepEqual(second.loadDispatcher(), { v: DISPATCHER_V, cursors: { "carrier://pole/one": 3 } });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── P5: strict shape, S-4, L-6 ────────────────────────────────────────────

test("P5 CONTROL: a body in heldRefs, a top-level policy/agents key and hardStop.reason 'reconsent' are refused", () => {
  const { groupId, m1 } = fixtureRoster();
  const now = 1_800_000_000_000;
  const good = fixtureAdapter(groupId, m1, now);
  validateAdapterState(good, groupId); // the good shape passes

  const withBody = fixtureAdapter(groupId, m1, now);
  withBody.heldRefs[0].body = "plaintext never persists (L-6)";
  assert.throws(() => validateAdapterState(withBody, groupId), { name: "AdapterStateError" });

  assert.throws(() => validateAdapterState({ ...good, policy: { agents: {} } }, groupId), { name: "AdapterStateError" }, "top-level policy refused (S-4)");
  assert.throws(() => validateAdapterState({ ...good, agents: {} }, groupId), { name: "AdapterStateError" }, "top-level agents refused (S-4)");

  const badHard = fixtureAdapter(groupId, m1, now, { hardStop: { reason: "reconsent", at: now } });
  assert.throws(() => validateAdapterState(badHard, groupId), { name: "AdapterStateError" }, "hardStop.reason is outsider|policy-mismatch only");
  const badSoft = fixtureAdapter(groupId, m1, now, { softStop: { reason: "outsider", at: now } });
  assert.throws(() => validateAdapterState(badSoft, groupId), { name: "AdapterStateError" }, "softStop.reason is reconsent only");

  const home = mkHome();
  try {
    const store = new SpaceStore(home);
    // save refuses the bad shapes too
    assert.throws(() => store.saveAdapter(groupId, withBody), { name: "AdapterStateError" });
    // A missing adapter.json is null (no state yet)…
    assert.equal(store.loadAdapter(groupId, { now }), null);
    // …but a corrupt one THROWS a named error and never reads as null.
    const dir = store.groupDir(groupId);
    const goodShape = fixtureAdapter(groupId, m1, now);
    store.saveAdapter(groupId, goodShape);
    writeFileSync(store.adapterPath(groupId), "{not json", { mode: 0o600 });
    assert.throws(() => store.loadAdapter(groupId, { now }), (e) => e instanceof SpaceStoreError && e.name === "AdapterStateError");
    writeFileSync(store.adapterPath(groupId), JSON.stringify({ ...goodShape, v: "wrong/9" }), { mode: 0o600 });
    assert.throws(() => store.loadAdapter(groupId, { now }), { name: "AdapterStateError" });
    assert.ok(existsSync(dir));
    // dispatcher: missing file = empty cursors; bad shape throws.
    assert.deepEqual(store.loadDispatcher(), { v: DISPATCHER_V, cursors: {} });
    writeFileSync(store.dispatcherPath(), JSON.stringify({ v: DISPATCHER_V, cursors: { "carrier://x": -1 } }), { mode: 0o600 });
    assert.throws(() => store.loadDispatcher(), { name: "DispatcherStateError" });
    writeFileSync(store.dispatcherPath(), "nope", { mode: 0o600 });
    assert.throws(() => store.loadDispatcher(), { name: "DispatcherStateError" });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── a policy key is refused at EVERY level (S-4), and a cross-id save throws ───

test("P5 CONTROL: a policy key at every level is refused (S-4); saveAdapter under a mismatched groupId throws", () => {
  const { groupId, m1 } = fixtureRoster();
  const now = 1_800_000_000_000;
  const good = fixtureAdapter(groupId, m1, now);
  validateAdapterState(good, groupId); // the good shape passes

  // Table-driven: a `policy` key inserted at each level must be refused (S-4).
  const cases = [
    ["channels", { ...good, channels: { ...good.channels, policy: {} } }],
    ["profile", { ...good, profile: { ...good.profile, policy: {} } }],
    ["consent", { ...good, consent: { ...good.consent, policy: {} } }],
    ["hardStop", { ...good, hardStop: { ...good.hardStop, policy: {} } }],
    ["softStop", { ...good, softStop: { ...good.softStop, policy: {} } }],
    ["pendingRemovals entry", { ...good, pendingRemovals: [{ ...good.pendingRemovals[0], policy: {} }] }],
  ];
  for (const [level, state] of cases) {
    assert.throws(() => validateAdapterState(state, groupId), { name: "AdapterStateError" }, `policy at ${level} refused`);
  }

  // A state whose groupId differs from the dir it is saved under is refused.
  const other = "grp-" + "f".repeat(32);
  const home = mkHome();
  try {
    const store = new SpaceStore(home);
    assert.throws(() => store.saveAdapter(other, good), { name: "AdapterStateError" }, "saveAdapter(idB, stateForA) throws");
    // dispatcher top level: a policy key is refused too (S-4).
    assert.throws(() => store.saveDispatcher({ v: DISPATCHER_V, cursors: {}, policy: {} }), { name: "DispatcherStateError" });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── P6: C9 single import site ─────────────────────────────────────────────

test("P6 CONTROL: exactly one file under src/spaces/ imports vendor/pillar/groups-v2.mjs", () => {
  const files = readdirSync(SPACES_DIR).filter((f) => f.endsWith(".mjs"));
  assert.ok(files.length >= 2, `src/spaces has the slice files (saw ${files.join(", ")})`);
  const importers = files.filter((f) =>
    /import[\s\S]*?["']\.\.\/vendor\/pillar\/groups-v2\.mjs["']|from\s*["']\.\.\/vendor\/pillar\/groups-v2\.mjs["']/.test(readFileSync(join(SPACES_DIR, f), "utf-8")));
  assert.deepEqual(importers, ["pillar-group.mjs"], "C9: one import site, pillar-group.mjs");
});

// ── P7: path safety ───────────────────────────────────────────────────────

test("P7 CONTROL: ../x, a 31-hex id and an uppercase id throw before any fs call", () => {
  const home = mkHome();
  try {
    const store = new SpaceStore(home);
    const bad = ["../x", "grp-" + "a".repeat(31), "GRP-" + "A".repeat(32), "grp-" + "A".repeat(32), "", null, 42];
    for (const id of bad) {
      for (const fn of [() => store.groupDir(id), () => store.adapterPath(id), () => store.engineDbPath(id), () => store.rosterPath(id), () => store.loadRoster(id), () => store.saveAdapter(id, {}), () => store.loadAdapter(id)]) {
        assert.throws(fn, { name: "GroupIdError" }, `${String(id)} refused`);
      }
    }
    // No fs side effect: nothing was created under the home.
    assert.equal(existsSync(store.spacesHome), false, "a refused id touches no disk");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("engineDbPath points at grp-<id>/engine.db and is never opened by this slice", () => {
  const home = mkHome();
  try {
    const { groupId } = fixtureRoster();
    const store = new SpaceStore(home);
    assert.equal(store.engineDbPath(groupId), join(store.spacesHome, groupId, "engine.db"));
    assert.equal(existsSync(store.engineDbPath(groupId)), false, "the path helper does not create or open engine.db");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
