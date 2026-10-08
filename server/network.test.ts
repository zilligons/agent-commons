// L3 Slice 2 v6 §3 / §8: Property 6 Console Verification, Cleanup & Isolation Test Suite
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { NetworkConsole } from "./network";
import { verifyDocument, createProfile, encode, digest } from "../packages/agent-commons/src/profiles.mjs";
import { storage } from "./storage";
import {
  AgentCommons,
  CommonsStore,
  Keychain,
  MemoryLoopbackTransport,
} from "../packages/agent-commons/src/index.mjs";
import { seal } from "../packages/agent-commons/src/pillar.mjs";

test("Baseline console behavior: profile persistence, fixture gate, global-scope rejection, contribution", () => {
  const saved = storage.loadNetwork();
  try {
    const consoleState = new NetworkConsole();
    assert.ok(consoleState.state.profiles.length >= 3);
    const namespace = `local/verification-${Date.now()}`;
    const profile = consoleState.create({
      name: "Verification fixture",
      namespace,
      fixtures: [
        "Require a signed delivery receipt.",
        "A signed delivery receipt preserves the task identity.",
      ],
    });
    assert.equal(profile.benchmark.passed, profile.benchmark.tests);
    assert.throws(
      () =>
        consoleState.create({
          name: "Invalid global",
          namespace: "global/not-authorized",
          fixtures: ["a", "b"],
        }),
      /not global standards/
    );
    assert.throws(
      () =>
        consoleState.create({
          name: "Single fixture",
          namespace: "local/one",
          fixtures: ["one"],
        }),
      /2–100/
    );
    const candidate = consoleState.prepare(profile.id);
    assert.equal(verifyDocument(candidate.document).kind, "profile-contribution");
    assert.equal(candidate.document.payload.contribution.profile, undefined);
    assert.equal(candidate.ratified, false);
    assert.equal(candidate.stage, "prepared-no-egress");
    assert.equal(new NetworkConsole().state.profiles.some((p) => p.id === profile.id), true);
  } finally {
    if (saved) storage.saveNetwork(saved);
  }
});

// =========================================================================
// Property 6: Console Internal Channel Verification & Upfront Refusals (C2, R2)
// =========================================================================
test("Property 6: Upfront refusals - mode, remote carrier, offline flag, global profile with zero work (MUTANTS A, B, C, D)", async () => {
  const consoleState = new NetworkConsole();

  let storeCount = 0;
  let identityCount = 0;
  const originalExec = DatabaseSync.prototype.exec;
  const originalIdentity = NetworkConsole.prototype.identity;

  DatabaseSync.prototype.exec = function (sql: any) {
    if (String(sql).includes("CREATE TABLE IF NOT EXISTS kv")) {
      storeCount++;
    }
    return originalExec.call(this, sql);
  };
  NetworkConsole.prototype.identity = function (...args: any[]) {
    identityCount++;
    return originalIdentity.apply(this, args);
  };

  const originalOffline = process.env.AGENT_COMMONS_OFFLINE;

  try {
    async function assertZeroWorkRefusal(fn: () => Promise<any>, expectedRegex: RegExp) {
      storeCount = 0;
      identityCount = 0;
      await assert.rejects(fn, expectedRegex);
      assert.equal(storeCount, 0, "Expected 0 stores created on upfront refusal");
      assert.equal(identityCount, 0, "Expected 0 identities accessed on upfront refusal");
    }

    // MUTANT A: Upfront forbidden mode refusal
    await assertZeroWorkRefusal(
      () => consoleState.runChannelVerification({ mode: "global" }),
      /Console verification refuses global or non-local mode/
    );

    // MUTANT B: Upfront remote transport refusal
    await assertZeroWorkRefusal(
      () => consoleState.runChannelVerification({ carrier: "https://carrier.pillar.test" }),
      /Console verification refuses remote transports/
    );

    // MUTANT C1: Process-offline = "0" refusal (ordinary)
    process.env.AGENT_COMMONS_OFFLINE = "0";
    await assertZeroWorkRefusal(
      () => consoleState.runChannelVerification({}),
      /Console verification requires offline environment/
    );

    // MUTANT C2: Process-offline = "0" masked with config.env = {} MUST STILL REFUSE with zero work!
    await assertZeroWorkRefusal(
      () => consoleState.runChannelVerification({ env: {} }),
      /Console verification requires offline environment/
    );

    // MUTANT C3: Config env offline flag = "0" when process flag is unset
    delete process.env.AGENT_COMMONS_OFFLINE;
    await assertZeroWorkRefusal(
      () => consoleState.runChannelVerification({ env: { AGENT_COMMONS_OFFLINE: "0" } }),
      /Console verification requires offline environment/
    );

    // Explicit global profile refusal
    const globalProfile = createProfile({
      namespace: "global/test",
      name: "Global Test",
      scope: "global",
      fixtures: ["fixture one", "fixture two"],
    });
    await assertZeroWorkRefusal(
      () => consoleState.runChannelVerification({ profile: globalProfile }),
      /Console verification refuses global profiles/
    );

    // Fallback effective global profile refusal (when consoleState.state.profiles only has global profile)
    const savedProfiles = consoleState.state.profiles;
    consoleState.state.profiles = [globalProfile];
    await assertZeroWorkRefusal(
      () => consoleState.runChannelVerification({}),
      /Console verification refuses global profiles/
    );
    consoleState.state.profiles = savedProfiles;
  } finally {
    DatabaseSync.prototype.exec = originalExec;
    NetworkConsole.prototype.identity = originalIdentity;
    if (originalOffline === undefined) {
      delete process.env.AGENT_COMMONS_OFFLINE;
    } else {
      process.env.AGENT_COMMONS_OFFLINE = originalOffline;
    }
  }
});

// =========================================================================
// Property 6: Failure-Surviving Cleanup Poles (R2 / R3)
// =========================================================================
test("Property 6: POLE 1 - Success cleanup closes all 3 resources in reverse order", async () => {
  const consoleState = new NetworkConsole();
  const attempted: string[] = [];
  const closed: string[] = [];

  const res = await consoleState.runChannelVerification({
    hooks: {
      onAttempt: (name: string) => attempted.push(name),
      onClose: (name: string) => closed.push(name),
    },
  });

  assert.equal(res.ok, true);
  assert.deepEqual(attempted, ["transport", "lyra", "atlas"]);
  assert.deepEqual(closed, ["transport", "lyra", "atlas"]);
  assert.equal(closed.length, 3);
});

test("Property 6: POLE 2 - Mid-construction failure cleanup closes already acquired resources", async () => {
  const consoleState = new NetworkConsole();
  const attempted: string[] = [];
  const closed: string[] = [];

  await assert.rejects(
    () =>
      consoleState.runChannelVerification({
        failureInjection: { storeLyra: true },
        hooks: {
          onAttempt: (name: string) => attempted.push(name),
          onClose: (name: string) => closed.push(name),
        },
      }),
    /construction-failed/
  );

  // Only atlas was acquired before lyraStore failed
  assert.deepEqual(attempted, ["atlas"]);
  assert.deepEqual(closed, ["atlas"]);
  assert.equal(closed.length, 1);
});

test("Property 6: POLE 3 - Admission refusal cleanup closes all 3 acquired resources", async () => {
  const consoleState = new NetworkConsole();
  const attempted: string[] = [];
  const closed: string[] = [];

  await assert.rejects(
    () =>
      consoleState.runChannelVerification({
        failureInjection: { admission: true },
        hooks: {
          onAttempt: (name: string) => attempted.push(name),
          onClose: (name: string) => closed.push(name),
        },
      }),
    /admission-refused/
  );

  assert.deepEqual(attempted, ["transport", "lyra", "atlas"]);
  assert.deepEqual(closed, ["transport", "lyra", "atlas"]);
  assert.equal(closed.length, 3);
});

test("Property 6: POLE 4 - Synchronous first-close failure cleanup continues to close remaining resources", async () => {
  const consoleState = new NetworkConsole();

  // Control arm: individual try/catch awaits each close (production algorithm)
  const controlAttempted: string[] = [];
  const controlClosed: string[] = [];
  const controlCaught: any[] = [];

  const controlRes = await consoleState.runChannelVerification({
    failureInjection: { transportCloseSync: true },
    hooks: {
      onAttempt: (name: string) => controlAttempted.push(name),
      onClose: (name: string) => controlClosed.push(name),
      onCatch: (err: any) => controlCaught.push(err.message),
    },
  });

  assert.equal(controlRes.ok, true);
  assert.deepEqual(controlAttempted, ["transport", "lyra", "atlas"]); // 3/3 attempted
  assert.deepEqual(controlClosed, ["lyra", "atlas"]); // 2/2 remaining successfully closed
  assert.deepEqual(controlCaught, ["close-failed"]); // transport error was caught locally

  // Mutant arm: broken outer catch stops after first failure (isolated mutant algorithm)
  const mutantAttempted: string[] = [];
  const mutantClosed: string[] = [];
  const mutantCaught: any[] = [];

  const mockAcquired = [
    { name: "atlas", close: () => mutantClosed.push("atlas") },
    { name: "lyra", close: () => mutantClosed.push("lyra") },
    {
      name: "transport",
      close: () => {
        throw new Error("close-failed");
      },
    },
  ];

  try {
    for (const resource of [...mockAcquired].reverse()) {
      mutantAttempted.push(resource.name);
      resource.close();
    }
  } catch (error: any) {
    mutantCaught.push(error.message);
  }

  assert.deepEqual(mutantAttempted, ["transport"]); // only 1/3 attempted
  assert.deepEqual(mutantClosed, []); // 0/2 remaining closed
  assert.deepEqual(mutantCaught, ["close-failed"]);
});

test("Property 6: POLE 5 - Asynchronous first-close rejected-promise cleanup awaits close", async () => {
  const consoleState = new NetworkConsole();

  // Control arm: individual awaited try/catch (production algorithm)
  const unhandledControl: string[] = [];
  const onUnhandledControl = (err: any) => {
    unhandledControl.push(err?.message ?? String(err));
  };
  process.on("unhandledRejection", onUnhandledControl);

  const controlAttempted: string[] = [];
  const controlClosed: string[] = [];
  const controlCaught: any[] = [];

  try {
    const controlRes = await consoleState.runChannelVerification({
      failureInjection: { transportCloseAsync: true },
      hooks: {
        onAttempt: (name: string) => controlAttempted.push(name),
        onClose: (name: string) => controlClosed.push(name),
        onCatch: (err: any) => controlCaught.push(err.message),
      },
    });

    assert.equal(controlRes.ok, true);
    assert.deepEqual(controlAttempted, ["transport", "lyra", "atlas"]);
    assert.deepEqual(controlClosed, ["lyra", "atlas"]);
    assert.deepEqual(controlCaught, ["close-failed"]);
    assert.equal(unhandledControl.length, 0); // Zero unhandled rejections escaped
  } finally {
    process.removeListener("unhandledRejection", onUnhandledControl);
  }

  // Mutant arm: unawaited close omits await on resource.close() (isolated mutant algorithm)
  // Temporarily isolate from node:test runner's unhandledRejection listener
  const origListeners = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");

  const unhandledMutant: string[] = [];
  const onUnhandledMutant = (err: any) => {
    unhandledMutant.push(err?.message ?? String(err));
  };
  process.on("unhandledRejection", onUnhandledMutant);

  const mutantAttempted: string[] = [];
  const mutantClosed: string[] = [];
  const mutantCaught: any[] = [];

  const mockAcquiredAsync = [
    { name: "atlas", close: async () => { mutantClosed.push("atlas"); } },
    { name: "lyra", close: async () => { mutantClosed.push("lyra"); } },
    {
      name: "transport",
      close: () => Promise.reject(new Error("close-failed")),
    },
  ];

  try {
    for (const resource of [...mockAcquiredAsync].reverse()) {
      try {
        mutantAttempted.push(resource.name);
        // MUTANT: omits await on resource.close()
        resource.close();
        mutantClosed.push(resource.name);
      } catch (error: any) {
        mutantCaught.push(error.message);
      }
    }

    // Give microtasks a turn to trigger unhandledRejection
    await new Promise((resolve) => setImmediate(resolve));

    // Mutant did not await, so synchronous try/catch did not catch rejection
    assert.equal(mutantCaught.length, 0);
    assert.equal(unhandledMutant.length, 1);
    assert.equal(unhandledMutant[0], "close-failed");
  } finally {
    process.removeListener("unhandledRejection", onUnhandledMutant);
    for (const listener of origListeners) {
      process.on("unhandledRejection", listener as any);
    }
  }
});

// =========================================================================
// Property 6: Exchange Acceptance Required Before Publishing Verification (R1)
// =========================================================================
test("Property 6: R1 Exchange acceptance required before publishing verification (CONTROL & FAULT POLES)", async () => {
  const consoleState = new NetworkConsole();

  // CONTROL: complete exchange accepted by carrier and recipient
  consoleState.cachedVerification = null;
  const control = await consoleState.runChannelVerification();
  assert.equal(control.ok, true);
  assert.equal(control.sendResult.result[0].state, "carrier-accepted");
  assert.equal(control.pollResult[0].accepted, true);
  assert.equal(consoleState.cachedVerification?.channels?.[0]?.state, "verified-active");
  assert.equal(consoleState.cachedVerification?.transports?.[0]?.state, "operational");

  // FAULT POLE 1: Carrier receipt accepted=false -> refuse, no cached verification
  const oldDeliver = MemoryLoopbackTransport.prototype.deliver;
  try {
    MemoryLoopbackTransport.prototype.deliver = async function (...args: any[]) {
      const res = await oldDeliver.apply(this, args);
      return { ...res, accepted: false };
    };
    consoleState.cachedVerification = null;
    await assert.rejects(
      () => consoleState.runChannelVerification(),
      /Console verification send unaccepted by carrier/
    );
    assert.equal(consoleState.cachedVerification, null);
  } finally {
    MemoryLoopbackTransport.prototype.deliver = oldDeliver;
  }

  // FAULT POLE 2: Receiver membership revoked before polling -> poll rejects envelope, refuse, no cached verification
  const oldPoll = AgentCommons.prototype.poll;
  try {
    AgentCommons.prototype.poll = async function () {
      const uri = Object.keys(this.policy.channels)[0];
      if (this.policy.channels?.[uri]) {
        this.policy.channels[uri].members = this.policy.channels[uri].members.filter(
          (id: string) => id !== this.uuaid
        );
      }
      return oldPoll.call(this);
    };
    consoleState.cachedVerification = null;
    await assert.rejects(
      () => consoleState.runChannelVerification(),
      /Console verification received message unaccepted or mismatched/
    );
    assert.equal(consoleState.cachedVerification, null);
  } finally {
    AgentCommons.prototype.poll = oldPoll;
  }

  // FAULT POLE 3: Omitted / empty poll result -> refuse, no cached verification
  try {
    AgentCommons.prototype.poll = async function () {
      return [];
    };
    consoleState.cachedVerification = null;
    await assert.rejects(
      () => consoleState.runChannelVerification(),
      /Console verification poll produced empty result/
    );
    assert.equal(consoleState.cachedVerification, null);
  } finally {
    AgentCommons.prototype.poll = oldPoll;
  }
});

// =========================================================================
// Property 6: State Isolation & Repeat Execution
// =========================================================================
test("Property 6: State isolation and repeat execution leaves database unchanged", async () => {
  const consoleState = new NetworkConsole();
  const profilesBefore = JSON.stringify(consoleState.state.profiles);
  const contributionsBefore = JSON.stringify(consoleState.state.contributions);

  // Execute two verification passes (one DM channel, one community channel)
  const res1 = await consoleState.runChannelVerification({
    channelUri: "channel://local/dm/atlas-lyra",
  });
  const res2 = await consoleState.runChannelVerification({
    channelUri: "channel://local/community/general",
  });

  assert.equal(res1.ok, true);
  assert.equal(res2.ok, true);

  const profilesAfter = JSON.stringify(consoleState.state.profiles);
  const contributionsAfter = JSON.stringify(consoleState.state.contributions);

  assert.equal(profilesBefore, profilesAfter);
  assert.equal(contributionsBefore, contributionsAfter);

  // Summary exposes cached verification without running new exchanges
  const summary = consoleState.summary();
  assert.ok(summary.cachedVerification);
  assert.equal(summary.channels.length, 1);
  assert.equal(summary.transports[0].state, "operational");
});

// =========================================================================
// Property 6: Polling Isolation & Foreign Cursor Progress (R2)
// =========================================================================
test("Property 6: Polling isolation - target-then-foreign and foreign-only cursor progress (CONTROL A & B)", async () => {
  const atlasKey = new Keychain("unused");
  atlasKey._identity = Keychain.generate();
  const lyraKey = new Keychain("unused");
  lyraKey._identity = Keychain.generate();
  const foreignKey = new Keychain("unused");
  foreignKey._identity = Keychain.generate();

  const atlasId = atlasKey._identity.uuaid;
  const lyraId = lyraKey._identity.uuaid;
  const foreignId = foreignKey._identity.uuaid;

  const policy = {
    mode: "local" as const,
    offline: true,
    channelsEnabled: false,
    agents: {
      [atlasId]: { kind: "agent" as const, publicKey: atlasKey._identity.publicKeyHex, capabilities: ["commons:message"] },
      [lyraId]: { kind: "agent" as const, publicKey: lyraKey._identity.publicKeyHex, capabilities: ["commons:message"] },
      [foreignId]: { kind: "agent" as const, publicKey: foreignKey._identity.publicKeyHex, capabilities: ["commons:message"] },
    },
  };

  const profile = createProfile({
    namespace: "local/test",
    name: "Test",
    scope: "local",
    fixtures: ["fixture one", "fixture two"],
  });

  const transport = new MemoryLoopbackTransport();
  const lyraRuntime = new AgentCommons({
    keychain: lyraKey,
    store: new CommonsStore(":memory:"),
    policy,
    transport,
  });
  lyraRuntime.addProfile(profile);

  // CONTROL A: Target envelope 1, then foreign envelope 2
  const body1 = "hello lyra";
  const env1 = seal(atlasKey, {
    recipient: lyraId,
    recipientPublicKey: lyraKey._identity.publicKeyHex,
    kind: "agent-commons/1",
    payload: {
      v: "agent-commons/1",
      id: "00000000-0000-0000-0000-000000000001",
      profileId: profile.id,
      thread: "commons",
      kind: "message",
      wire: encode(body1, profile.lexicon),
      bodyHash: digest(body1),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
  });
  const body2 = "hello foreign";
  const env2 = seal(atlasKey, {
    recipient: foreignId,
    recipientPublicKey: foreignKey._identity.publicKeyHex,
    kind: "agent-commons/1",
    payload: {
      v: "agent-commons/1",
      id: "00000000-0000-0000-0000-000000000002",
      profileId: profile.id,
      thread: "commons",
      kind: "message",
      wire: encode(body2, profile.lexicon),
      bodyHash: digest(body2),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
  });

  await transport.deliver(env1);
  await transport.deliver(env2);

  const poll1 = await lyraRuntime.poll();
  assert.equal(poll1.length, 2);
  assert.equal(poll1[0].accepted, true);
  assert.equal(poll1[1].skipped, true);

  // Subsequent poll returns 0 envelopes because cursor advanced past foreign envelope
  const poll2 = await lyraRuntime.poll();
  assert.equal(poll2.length, 0);

  // CONTROL B: Foreign-only envelope
  const transportB = new MemoryLoopbackTransport();
  const lyraRuntimeB = new AgentCommons({
    keychain: lyraKey,
    store: new CommonsStore(":memory:"),
    policy,
    transport: transportB,
  });
  lyraRuntimeB.addProfile(profile);

  await transportB.deliver(env2);
  const pollB1 = await lyraRuntimeB.poll();
  assert.equal(pollB1.length, 1);
  assert.equal(pollB1[0].skipped, true);

  const pollB2 = await lyraRuntimeB.poll();
  assert.equal(pollB2.length, 0);
});

test("Property 6: Polling isolation mutants - cursor stall, invalid envelope, transient trust (MUTANTS D, E, F)", async () => {
  const atlasKey = new Keychain("unused");
  atlasKey._identity = Keychain.generate();
  const lyraKey = new Keychain("unused");
  lyraKey._identity = Keychain.generate();
  const foreignKey = new Keychain("unused");
  foreignKey._identity = Keychain.generate();

  const atlasId = atlasKey._identity.uuaid;
  const lyraId = lyraKey._identity.uuaid;
  const foreignId = foreignKey._identity.uuaid;

  const policy = {
    mode: "local" as const,
    offline: true,
    channelsEnabled: false,
    agents: {
      [atlasId]: { kind: "agent" as const, publicKey: atlasKey._identity.publicKeyHex, capabilities: ["commons:message"] },
      [lyraId]: { kind: "agent" as const, publicKey: lyraKey._identity.publicKeyHex, capabilities: ["commons:message"] },
      [foreignId]: { kind: "agent" as const, publicKey: foreignKey._identity.publicKeyHex, capabilities: ["commons:message"] },
    },
  };
  const profile = createProfile({
    namespace: "local/test",
    name: "Test",
    scope: "local",
    fixtures: ["f1", "f2"],
  });

  // MUTANT D: Model v2 behavior where foreign item does not advance cursor
  const transportD = new MemoryLoopbackTransport();
  const storeD = new CommonsStore(":memory:");
  const lyraRuntimeD = new AgentCommons({ keychain: lyraKey, store: storeD, policy, transport: transportD });
  lyraRuntimeD.addProfile(profile);

  const foreignEnv = seal(atlasKey, {
    recipient: foreignId,
    recipientPublicKey: foreignKey._identity.publicKeyHex,
    kind: "agent-commons/1",
    payload: {
      v: "agent-commons/1",
      id: "00000000-0000-0000-0000-000000000003",
      profileId: profile.id,
      thread: "commons",
      kind: "message",
      wire: "foreign",
      bodyHash: "h",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
  });
  await transportD.deliver(foreignEnv);

  // If a buggy mutant rewrote cursors to not advance:
  const pollD1 = await lyraRuntimeD.poll();
  assert.equal(pollD1[0].skipped, true);
  // Simulating mutant rollback of cursor to 0:
  storeD.set("cursors", {});
  const pollD2 = await lyraRuntimeD.poll();
  // Mutant would re-offer foreign envelope
  assert.equal(pollD2.length, 1);
  assert.equal(pollD2[0].skipped, true);

  // MUTANT E: Invalid envelope is quarantined, NOT marked skipped
  const transportE = new MemoryLoopbackTransport();
  const lyraRuntimeE = new AgentCommons({ keychain: lyraKey, store: new CommonsStore(":memory:"), policy, transport: transportE });
  lyraRuntimeE.addProfile(profile);

  const invalidEnvelope = { id: "malformed-id", notPillar: true };
  await transportE.deliver(invalidEnvelope as any);

  const pollE = await lyraRuntimeE.poll();
  assert.equal(pollE.length, 1);
  assert.equal(pollE[0].rejected, true);
  assert.equal(pollE[0].skipped, undefined);
  assert.match(pollE[0].reason, /Invalid Pillar envelope/);

  // MUTANT F: Transient trust stop does not advance cursor and stops loop
  const transportF = new MemoryLoopbackTransport();
  const storeF = new CommonsStore(":memory:");
  const lyraRuntimeF = new AgentCommons({ keychain: lyraKey, store: storeF, policy, transport: transportF });
  lyraRuntimeF.addProfile(profile);

  const bodyF = "transient-test";
  const validEnv = seal(atlasKey, {
    recipient: lyraId,
    recipientPublicKey: lyraKey._identity.publicKeyHex,
    kind: "agent-commons/1",
    payload: {
      v: "agent-commons/1",
      id: "00000000-0000-0000-0000-000000000004",
      profileId: profile.id,
      thread: "commons",
      kind: "message",
      wire: encode(bodyF, profile.lexicon),
      bodyHash: digest(bodyF),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
  });
  await transportF.deliver(validEnv);

  // Inject transient trust failure
  lyraRuntimeF.receive = async () => {
    const err: any = new Error("trust backend offline");
    err.transient = true;
    err.code = "trust-unavailable";
    throw err;
  };

  const pollF1 = await lyraRuntimeF.poll();
  assert.equal(pollF1.length, 1);
  assert.equal(pollF1[0].deferred, true);
  assert.equal(pollF1[0].state, "trust-unavailable-retry");

  // Assert cursor was not advanced
  const cursors = storeF.get("cursors", {});
  assert.equal(cursors[transportF.sourceId] ?? 0, 0);
});
