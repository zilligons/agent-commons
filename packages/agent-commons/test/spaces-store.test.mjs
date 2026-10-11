/**
 * Space-store poles (design §8, P1-P7). File-system only, no signals.
 * Every home is an mkdtemp dir under the OS temp dir — never a real home.
 * Test identities are generated in-test (C12).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
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
  const { rec, groupId, m1, m2 } = fixtureRoster();
  const now = 1_800_000_000_000;
  const valid = { uuaid: m1.uuaid, key: m1.publicKeyHex, manifestVersion: 2, queuedAt: now - 1000, outboxId: "ob-1" };
  const entries = [
    valid,
    { ...valid, uuaid: m2.uuaid, key: m2.publicKeyHex, outboxId: "ob-2" }, // not removed in the head
    { ...valid, key: "d".repeat(64), outboxId: "ob-3" }, // wrong key
    { ...valid, queuedAt: now - PENDING_TTL_MS - 1, outboxId: "ob-4" }, // older than 1 hour
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
        { uuaid: m1.uuaid, key: m1.publicKeyHex, manifestVersion: 2, queuedAt: now - PENDING_TTL_MS - 1, outboxId: "ob-expired" },
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
    assert.throws(() => store.saveRoster({ v: rec.v, id: rec.id }), /refusing to write|Error/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── P3: §8.1 modes and atomic writes ──────────────────────────────────────

test("P3 CONTROL: spaces/ and grp dirs are 0700, files 0600, no *.tmp left", () => {
  const home = mkHome();
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
