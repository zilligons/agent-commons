/**
 * Slice 6 poles (design §3, §4): V-3, V-6, B-1/B-2/B-3, B-4, B-6, V-7 unit.
 * File-system homes are mkdtemp dirs under the OS temp dir — never a real
 * home. Test identities are generated in-test (C12). No vendored edit (C8).
 * No engine-vs-client hash is computed anywhere (C13/V-7).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Keychain } from "../src/vendor/pillar/identity/keychain.mjs";
import {
  adminChange, buildGenesis, buildNext, signManifest, newRecord, verifyChain,
  manifestHash, RosterStore,
} from "../src/vendor/pillar/groups-v2.mjs";
import { RegistryTrust } from "../src/trust.mjs";
import { SpaceStore } from "../src/spaces/store.mjs";
import {
  verifiedHead, selfCheck, signAndApplyNext, agentRecordsFromVerifiedHead,
  agentRecordForRow, assertAsciiKeys, ManifestError,
} from "../src/spaces/manifest.mjs";

// ── in-test fixtures (C12) ────────────────────────────────────────────────

function mkHome() { return mkdtempSync(join(tmpdir(), "spaces-manifest-")); }

function identity() {
  const id = Keychain.generate();
  return { uuaid: id.uuaid, publicKeyHex: id.publicKeyHex, privateKey: id.privateKey };
}

/** admin (active) + m1 (removed at v2) + m2 (invited) — chain verified in-test. */
function fixtureRoster() {
  const admin = identity();
  const m1 = identity();
  const m2 = identity();
  const genesis = signManifest(buildGenesis({
    name: "pole-space", creator: admin,
    members: [{ uuaid: m1.uuaid, key: m1.publicKeyHex }, { uuaid: m2.uuaid, key: m2.publicKeyHex }],
    ext: {},
  }), admin);
  const removal = signManifest(buildNext(genesis, "remove", { target: m1.uuaid }), admin);
  const chain = [genesis, removal];
  assert.equal(verifyChain(chain).ok, true, "fixture chain verifies");
  return { admin, m1, m2, rec: newRecord(chain), groupId: genesis.id, chain };
}

/** A record with one flipped byte inside the head manifest's signature. */
function corruptHead(fx) {
  const chain = fx.chain.map((m) => structuredClone(m));
  const sig = chain[1].sig.signature;
  chain[1].sig.signature = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
  const rec = structuredClone(fx.rec);
  rec.chain = chain;
  assert.equal(verifyChain(rec.chain).ok, false, "mutant fixture: the corrupted chain must not verify");
  return rec;
}

// ── V-3: only whole chains yield a head ───────────────────────────────────

test("V-3 CONTROL: a valid record yields the verified head; one flipped chain byte yields none", () => {
  const fx = fixtureRoster();
  const head = verifiedHead(fx.rec);
  assert.equal(head.version, 2);
  assert.equal(head, fx.rec.chain[1], "the head IS the verified chain's last manifest");
  assert.equal(fx.rec.head.hash, manifestHash(head));

  assert.throws(() => verifiedHead(corruptHead(fx)), { name: "ChainVerifyError" });
  assert.throws(() => verifiedHead(null), { name: "ChainVerifyError" });
  assert.throws(() => verifiedHead({ chain: [] }), { name: "ChainVerifyError" });

  // A record whose head field disagrees with its own verified chain is refused too.
  const bad = structuredClone(fx.rec);
  bad.head = { version: 99, hash: "a".repeat(64) };
  assert.throws(() => verifiedHead(bad), { name: "HeadMismatchError" });
});

// ── B-6: self check ───────────────────────────────────────────────────────

test("B-6 CONTROL: selfCheck passes for a roster member and refuses every mismatch", () => {
  const fx = fixtureRoster();
  assert.equal(selfCheck(fx.admin, fx.rec), true, "the admin's own row carries its own key");
  assert.equal(selfCheck(fx.m2, fx.rec), true, "an invited member is in the head too");

  // Arm (a): the keychain's uuaid does not derive from its own public key.
  const tampered = { ...fx.admin, uuaid: `uuaid:foundation:agent:${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}` };
  assert.throws(() => selfCheck(tampered, fx.rec), { name: "SelfCheckError" });

  // Arm (b1): a sound keychain with NO row in the verified head.
  const stranger = identity();
  assert.throws(() => selfCheck(stranger, fx.rec), { name: "SelfCheckError" });

  // Arm (b2) — the head's own row carrying a DIFFERENT key — is unreachable on
  // a chain that verified: rowChecks binds every row (keyBindsUuaid) and B-1
  // makes the uuaid a function of the key, so arm (a) passing forces row.key ===
  // publicKeyHex short of a sha256 collision. The guard stays (defense in
  // depth, same posture as store.mjs's manifest-ahead-of-head); this comment
  // is the pole's coverage statement, per the design's §11 B-6 row.
  assert.throws(() => selfCheck(fx.admin, corruptHead(fx)), { name: "ChainVerifyError" },
    "an unverified chain never reaches the row checks (V-3 first)");
  assert.throws(() => selfCheck(null, fx.rec), { name: "SelfCheckError" });
});

// ── B-3: records only from the verified head's non-removed rows ──────────

test("B-3 CONTROL: keyed by full uuaid, removed rows skipped, a non-binding row throws", () => {
  const fx = fixtureRoster();
  const agents = agentRecordsFromVerifiedHead(fx.rec);

  assert.deepEqual(Object.keys(agents).sort(), [fx.admin.uuaid, fx.m2.uuaid].sort(),
    "keys are FULL uuaids: the active admin and the invited member, never the removed m1, never a local id");
  assert.ok(!(fx.m1.uuaid in agents), "the removed row is skipped");
  for (const u of Object.keys(agents)) assert.match(u, /^uuaid:foundation:agent:[0-9a-f-]{36}$/);
  assert.deepEqual(agents[fx.m2.uuaid], {
    kind: "agent", publicKey: fx.m2.publicKeyHex, capabilities: ["commons:message"],
  }, "P-2: exactly [commons:message], no credentialId/controllerId");

  // The binding re-check: a row whose key does not bind its uuaid THROWS, never skips.
  assert.throws(() => agentRecordForRow({ uuaid: fx.m2.uuaid, key: fx.admin.publicKeyHex }),
    { name: "KeyBindingError" });
  assert.throws(() => agentRecordForRow({ uuaid: fx.m2.uuaid, key: "zz".repeat(32) }),
    { name: "KeyBindingError" }, "a non-strict key is refused by the vendored rule too (B-1)");

  // V-3 gates the helper: a corrupted record yields no records at all.
  assert.throws(() => agentRecordsFromVerifiedHead(corruptHead(fx)), { name: "ChainVerifyError" });
});

// ── B-4: the namespace pole, against the real engine trust gate ──────────

test("B-4 CONTROL: an other-namespace sender with a member key is refused NOT_ADMITTED; the member itself is admitted", async () => {
  const fx = fixtureRoster();
  const agents = agentRecordsFromVerifiedHead(fx.rec);
  const trust = new RegistryTrust({ policy: { mode: "local", agents } });

  // Same local id, same key, OTHER namespace: passes the engine's own
  // local-id-only checks (KEY_BINDING) and dies at NOT_ADMITTED, because
  // policy.agents holds only full uuaid:foundation:agent: keys (B-4).
  const localId = fx.m2.uuaid.split(":")[3];
  const other = `uuaid:other:agent:${localId}`;
  await assert.rejects(() => trust.authorize(other, fx.m2.publicKeyHex, "commons:message"),
    (e) => e.code === "NOT_ADMITTED", "refused NOT_ADMITTED, not KEY_BINDING");

  // The legitimate member IS admitted by the same policy (the pole's second arm:
  // a local-id-keyed policy would refuse this one — that is the §11 mutant).
  const ok = await trust.authorize(fx.m2.uuaid, fx.m2.publicKeyHex, "commons:message");
  assert.equal(ok.tier, "local-policy-pinned");

  // The removed member is not in the policy at all.
  await assert.rejects(() => trust.authorize(fx.m1.uuaid, fx.m1.publicKeyHex, "commons:message"),
    (e) => e.code === "NOT_ADMITTED");
});

// ── V-6: sign → verify → own-store-save → return ─────────────────────────

test("V-6 CONTROL: the signed next manifest verifies, is in the own store when returned, and a reload shows it", () => {
  const fx = fixtureRoster();
  const home = mkHome();
  try {
    const store = new SpaceStore(home);
    store.saveRoster(fx.rec);
    const m3 = identity();

    const { manifest, record } = signAndApplyNext(store, fx.groupId, fx.admin, "invite", {
      member: { uuaid: m3.uuaid, key: m3.publicKeyHex },
    });

    assert.equal(manifest.version, 3);
    assert.equal(verifyChain([...fx.chain, manifest]).ok, true, "the new chain verifies");
    // Saved to the OWN store BEFORE the return: the reload already shows it.
    const reloaded = store.loadRoster(fx.groupId);
    assert.ok(reloaded, "the own store holds the new record");
    assert.equal(reloaded.head.version, 3);
    assert.equal(reloaded.head.hash, manifestHash(manifest));
    assert.deepEqual(record, reloaded, "the returned record IS what the own store holds");
    assert.equal(reloaded.chain[2].transition.action, "invite");
    assert.equal(reloaded.chain[2].transition.target, m3.uuaid);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("V-6 refusals: absent roster, a non-admin signer and a missing self check write nothing", () => {
  const fx = fixtureRoster();
  const home = mkHome();
  try {
    const store = new SpaceStore(home);
    // Absent roster: nothing verified, nothing signed.
    assert.throws(() => signAndApplyNext(store, fx.groupId, fx.admin, "rename", { name: "x" }),
      { name: "RosterAbsentError" });
    store.saveRoster(fx.rec);

    // A member (not the head's single active admin) is refused, and the store
    // is untouched: the refusal happens before any save.
    assert.throws(() => signAndApplyNext(store, fx.groupId, fx.m2, "rename", { name: "x" }),
      { name: "NotAdminError" });
    assert.equal(store.loadRoster(fx.groupId).head.version, 2, "no write on refusal");

    // A keychain whose uuaid does not derive from its key: SelfCheckError
    // precedes the admin check (the §11 B-6 mutant removes this call and the
    // refusal degrades to NotAdminError — RED on the name below).
    const tampered = { ...fx.admin, uuaid: `uuaid:foundation:agent:${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}` };
    assert.throws(() => signAndApplyNext(store, fx.groupId, tampered, "rename", { name: "x" }),
      { name: "SelfCheckError" });
    assert.equal(store.loadRoster(fx.groupId).head.version, 2, "still no write");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── V-6 (R2): a failed own-store save is never masked ─────────────────────

test("V-6 CONTROL (R2): a throwing own-store save propagates; the real store keeps v(n) and no manifest comes back", () => {
  const fx = fixtureRoster();
  const home = mkHome();
  try {
    const real = new SpaceStore(home);
    real.saveRoster(fx.rec);
    // Store stub: the REAL loadRoster (so every verify gate sees the true v2
    // record) and a failing saveRoster. The injected failure must propagate
    // through the vendored adminChange's store.save (groups-v2.mjs:542) and
    // out of the wrapper — a save that swallows its error and still returns
    // the signed manifest is the exact hazard V-6's order exists to prevent:
    // never hand back a manifest the own store does not hold.
    const stub = {
      loadRoster: (id) => real.loadRoster(id),
      saveRoster: () => { throw new Error("injected save failure"); },
    };
    const m3 = identity();
    let returned = null;
    assert.throws(
      () => {
        returned = signAndApplyNext(stub, fx.groupId, fx.admin, "invite", {
          member: { uuaid: m3.uuaid, key: m3.publicKeyHex },
        });
      },
      /injected save failure/,
      "the failed save throws out of signAndApplyNext, unswallowed",
    );
    assert.equal(returned, null, "no manifest is returned when the own-store save failed");
    assert.equal(real.loadRoster(fx.groupId).head.version, 2, "the REAL store still holds v(n) = v2");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── S-1 (R2): the admin save path keeps the 0700 tightening ───────────────

test("S-1 CONTROL (R2): an admin change retightens a loosened spaces/ to 0700, pinning the save to SpaceStore.saveRoster", () => {
  const fx = fixtureRoster();
  const home = mkHome();
  try {
    const store = new SpaceStore(home);
    store.saveRoster(fx.rec);
    chmodSync(store.spacesHome, 0o755); // loosen behind the store's back
    assert.equal(statSync(store.spacesHome).mode & 0o777, 0o755, "loosened first");

    const m3 = identity();
    signAndApplyNext(store, fx.groupId, fx.admin, "invite", {
      member: { uuaid: m3.uuaid, key: m3.publicKeyHex },
    });
    // A save routed AROUND the adapter (straight to the vendored RosterStore)
    // leaves 0755: RosterStore.save only tightens spaces/groups-v2/, never
    // spacesHome itself. Only SpaceStore.saveRoster's _ensureSpaces retightens
    // spaces/ to 0700 (store.mjs:243).
    assert.equal(statSync(store.spacesHome).mode & 0o777, 0o700,
      "spaces/ is 0700 again after the admin change");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── V-7 unit: the ASCII-key guard ─────────────────────────────────────────

test("V-7 unit CONTROL: a key Ā beside a is refused at depth 0, depth 2 and inside a lexicon", () => {
  assertAsciiKeys({ a: 1, b: { c: [1, 2, { d: "e" }] } }, "$"); // pure ASCII passes

  assert.throws(() => assertAsciiKeys({ a: 1, "Ā": 2 }), { name: "NonAsciiKeyError" }, "depth 0");
  assert.throws(() => assertAsciiKeys({ x: { y: { a: 1, "Ā": 2 } } }), { name: "NonAsciiKeyError" }, "depth 2");
  // A space profile document's lexicon: defs keyed by term, one non-ASCII.
  assert.throws(() => assertAsciiKeys({
    lexicon: { defs: { "app:term": { a: 1 }, "app:tĀrm": { a: 1 } } },
  }), { name: "NonAsciiKeyError" }, "inside the lexicon");
  // Values may be non-ASCII; only KEYS are refused.
  assertAsciiKeys({ a: "Ā", b: { c: "—ok→" } });
});

// T1 (R1): pin the whole 0x80-0xff band, not only U+0100. A `> 0xff` mutant
// slips é (U+00E9) and U+0080 through; these two arms make it RED.
test("V-7 unit T1: Latin-1 keys é (U+00E9) and U+0080 are refused, so the 0x80-0xff band is pinned", () => {
  assert.throws(() => assertAsciiKeys({ a: 1, "é": 2 }), { name: "NonAsciiKeyError" }, "U+00E9");
  assert.throws(() => assertAsciiKeys({ a: 1, "\u0080": 2 }), { name: "NonAsciiKeyError" }, "U+0080");
  assert.throws(() => assertAsciiKeys({ "é": { "\u0080": 1 } }), { name: "NonAsciiKeyError" }, "nested Latin-1");
});

// ── lone-guard poles (R2): each cross-check arm pinned with nothing else failing ──

test("Guard CONTROL (R2): an array-nested non-ASCII key is refused, and a right-version/wrong-hash head is HeadMismatchError", () => {
  // The recursion must descend INTO array elements: a guard that skips arrays
  // never sees this key. (Values may be non-ASCII; KEYS may not, at any depth.)
  assert.throws(() => assertAsciiKeys({ a: [{ "é": 1 }] }), { name: "NonAsciiKeyError" },
    "array-nested non-ASCII key");

  // The head cross-check's two arms, separated: the version here is RIGHT and
  // only the hash lies, so a version-only compare would let this through.
  const fx = fixtureRoster();
  const badHash = structuredClone(fx.rec);
  badHash.head = { version: fx.rec.head.version, hash: "b".repeat(64) };
  assert.equal(verifyChain(badHash.chain).ok, true, "the chain itself still verifies");
  assert.throws(() => verifiedHead(badHash), { name: "HeadMismatchError" },
    "right version, wrong hash");
});

// ── D1 (R1): a frozen record is refused before anything is built ──────────

test("D1 CONTROL: signAndApplyNext on a frozen record throws FrozenGroupError and writes nothing", () => {
  const fx = fixtureRoster();
  const home = mkHome();
  try {
    const store = new SpaceStore(home);
    // Equivocation proof: two distinct signed heads off the same genesis.
    const alt = signManifest(buildNext(fx.chain[0], "rename", { name: "other" }), fx.admin);
    const alt2 = signManifest(buildNext(fx.chain[0], "rename", { name: "third" }), fx.admin);
    const frozen = structuredClone(fx.rec);
    frozen.frozen = { manifests: [alt, alt2] };
    store.saveRoster(frozen);
    const before = JSON.stringify(store.loadRoster(fx.groupId));

    assert.throws(() => signAndApplyNext(store, fx.groupId, fx.admin, "rename", { name: "after-freeze" }),
      { name: "FrozenGroupError" }, "pillar refuses a frozen group (groups-v2.mjs:534)");
    // Unchanged: same head version AND same bytes on reload.
    const after = store.loadRoster(fx.groupId);
    assert.equal(after.head.version, frozen.head.version, "no new version on a frozen record");
    assert.equal(JSON.stringify(after), before, "the stored record is byte-identical");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── D2 (R1): leave/remove clears the target from `leaving` ────────────────

/** admin (active) + m1 (active, accepted) + m2 (invited); m1 in `leaving`. */
function fixtureLeaving() {
  const admin = identity();
  const m1 = identity();
  const m2 = identity();
  const genesis = signManifest(buildGenesis({
    name: "leave-space", creator: admin,
    members: [{ uuaid: m1.uuaid, key: m1.publicKeyHex }, { uuaid: m2.uuaid, key: m2.publicKeyHex }],
    ext: {},
  }), admin);
  const accept = signManifest(buildNext(genesis, "accept", { target: m1.uuaid, request: "env-accept-m1" }), admin);
  const chain = [genesis, accept];
  assert.equal(verifyChain(chain).ok, true, "leaving fixture chain verifies");
  const rec = newRecord(chain);
  rec.leaving = [m1.uuaid];
  return { admin, m1, m2, rec, groupId: genesis.id, chain };
}

test("D2 CONTROL: a remove (and a leave) of a uuaid in rec.leaving drops it from the returned AND reloaded record", () => {
  for (const action of ["remove", "leave"]) {
    const fx = fixtureLeaving();
    const home = mkHome();
    try {
      const store = new SpaceStore(home);
      store.saveRoster(fx.rec);
      assert.deepEqual(store.loadRoster(fx.groupId).leaving, [fx.m1.uuaid], `${action}: m1 starts in leaving`);

      // `leave` requires a non-empty request string (verifyNext:276); `remove` does not.
      const opts = action === "leave"
        ? { target: fx.m1.uuaid, request: "env-leave-m1" }
        : { target: fx.m1.uuaid };
      const { record } = signAndApplyNext(store, fx.groupId, fx.admin, action, opts);
      assert.ok(!record.leaving.includes(fx.m1.uuaid), `${action}: returned record drops m1 from leaving`);
      const reloaded = store.loadRoster(fx.groupId);
      assert.ok(!reloaded.leaving.includes(fx.m1.uuaid), `${action}: reloaded record drops m1 from leaving`);
      assert.equal(reloaded.chain[reloaded.chain.length - 1].transition.action, action);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
});

// ── R1 differential: my signer == vendored adminChange, byte-for-byte ─────

test("R1 differential: signAndApplyNext deep-equals vendored adminChange on chain, head and leaving (invite, remove, rename)", () => {
  const ISSUED = "2026-10-11T00:00:00.000Z"; // pin: buildNext stamps issuedAt from the clock
  // fixtureRoster's m1 is already removed at v2, so the `remove` case targets
  // m2 (invited → removed, classifyChange:242). m2 is put in `leaving` first.
  const cases = [
    { action: "invite", leaving: null, opts: (fx) => ({ member: { uuaid: fx.m3.uuaid, key: fx.m3.publicKeyHex }, issuedAt: ISSUED }) },
    { action: "remove", leaving: (fx) => fx.m2.uuaid, opts: (fx) => ({ target: fx.m2.uuaid, issuedAt: ISSUED }) },
    { action: "rename", leaving: null, opts: () => ({ name: "renamed", issuedAt: ISSUED }) },
  ];
  for (const c of cases) {
    const fx = fixtureRoster();
    fx.m3 = identity();
    const homeA = mkHome(); // mine, through SpaceStore
    const homeB = mkHome(); // vendored, through a raw RosterStore
    try {
      const baseA = structuredClone(fx.rec);
      const baseB = structuredClone(fx.rec);
      if (c.leaving) { const u = c.leaving(fx); baseA.leaving = [u]; baseB.leaving = [u]; }

      const storeA = new SpaceStore(homeA);
      storeA.saveRoster(baseA);
      const mine = signAndApplyNext(storeA, fx.groupId, fx.admin, c.action, c.opts(fx));

      const storeB = new RosterStore(homeB);
      storeB.save(baseB);
      const vend = adminChange({
        store: storeB, mailbox: null, keychain: { _identity: fx.admin },
        groupId: fx.groupId, action: c.action, opts: c.opts(fx),
      });

      assert.deepEqual(mine.record.chain, vend.rec.chain, `${c.action}: chain deep-equal`);
      assert.deepEqual(mine.record.head, vend.rec.head, `${c.action}: head deep-equal`);
      assert.deepEqual(mine.record.leaving, vend.rec.leaving, `${c.action}: leaving deep-equal`);
      // Deterministic Ed25519 + pinned issuedAt ⇒ the head manifest is byte-equal.
      assert.equal(JSON.stringify(mine.manifest), JSON.stringify(vend.manifest), `${c.action}: manifest byte-equal`);
    } finally {
      rmSync(homeA, { recursive: true, force: true });
      rmSync(homeB, { recursive: true, force: true });
    }
  }
});

// ── C9: the wrapper adds no second import site ────────────────────────────

test("C9 CONTROL: manifest.mjs imports the vendored engine only through pillar-group.mjs", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(fileURLToPath(new URL("../src/spaces/manifest.mjs", import.meta.url)), "utf-8");
  assert.ok(!/vendor\/pillar\/groups-v2\.mjs/.test(src), "no direct vendored import in manifest.mjs");
  assert.match(src, /from "\.\/pillar-group\.mjs"/, "the single import site is used");
  assert.ok(ManifestError.prototype instanceof Error);
});
