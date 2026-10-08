// L3 Slice 2 v6 §3 / §8: Property 1-5 Two-Pole Test Suite
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentCommons,
  CommonsStore,
  Keychain,
  createProfile,
  verifyProfile,
  MemoryLoopbackTransport,
  PillarCarrierTransport,
  classifyThread,
  validateTenantBinding,
} from "../src/index.mjs";
import { jcs, envelopeSha, seal } from "../src/pillar.mjs";
import { encode, digest } from "../src/profiles.mjs";

function makeKey() {
  const k = new Keychain("unused");
  k._identity = Keychain.generate();
  return k;
}

function makeEnv(tempDir) {
  const atlasKey = makeKey();
  const lyraKey = makeKey();
  const atlasId = atlasKey._identity.uuaid;
  const lyraId = lyraKey._identity.uuaid;
  const channelUri = "channel://local/community/general";
  const tenantId = "tenant-a";

  const policy = {
    mode: "local",
    offline: true,
    channelsEnabled: true,
    channels: {
      [channelUri]: {
        members: [atlasId, lyraId],
        allowForwarding: false,
      },
    },
    agents: {
      [atlasId]: {
        kind: "agent",
        publicKey: atlasKey._identity.publicKeyHex,
        capabilities: ["commons:message", "commons:relay"],
        tenantId,
      },
      [lyraId]: {
        kind: "agent",
        publicKey: lyraKey._identity.publicKeyHex,
        capabilities: ["commons:message"],
        tenantId,
      },
    },
    tenantProfiles: {},
  };

  const profile = createProfile({
    namespace: "local/test",
    name: "Test Profile",
    scope: "local",
    fixtures: ["semantic equivalence A", "semantic equivalence B"],
  });

  policy.tenantProfiles[profile.id] = tenantId;

  const dbPath = tempDir ? join(tempDir, "store.db") : ":memory:";
  const atlasStore = new CommonsStore(dbPath);
  const lyraStore = new CommonsStore(":memory:");
  const transport = new MemoryLoopbackTransport();

  const atlasRuntime = new AgentCommons({
    keychain: atlasKey,
    store: atlasStore,
    policy,
    transport,
  });
  atlasRuntime.addProfile(profile);

  const lyraRuntime = new AgentCommons({
    keychain: lyraKey,
    store: lyraStore,
    policy,
    transport,
  });
  lyraRuntime.addProfile(profile);

  return {
    atlasKey,
    lyraKey,
    atlasId,
    lyraId,
    channelUri,
    tenantId,
    policy,
    profile,
    atlasStore,
    lyraStore,
    transport,
    atlasRuntime,
    lyraRuntime,
  };
}

// =========================================================================
// Property 1: Pluggable Transport Wiring & Receipt Acceptance (§3.1, §3.3, §3.5)
// =========================================================================
test("Property 1: CONTROL A - Memory transport auto-flush delivers and consumes outbox row", async () => {
  const env = makeEnv();
  const fixtureReceipt = {
    carrier: "memory://loopback/test",
    seq: 1,
    sha: "fixture-sha",
    duplicate: false,
    all: [],
    accepted: true,
  };
  env.transport.deliver = async (envelope) => fixtureReceipt;

  const res = await env.atlasRuntime.send({
    recipient: env.lyraId,
    profileId: env.profile.id,
    thread: env.channelUri,
    body: "hello",
  });

  assert.equal(res.result.length, 1);
  assert.equal(res.result[0].state, "carrier-accepted");
  assert.deepEqual(res.result[0].receipt, fixtureReceipt);

  const pendingRows = env.atlasStore.pending();
  assert.equal(pendingRows.length, 0);

  const subsequentFlush = await env.atlasRuntime.flush();
  assert.deepEqual(subsequentFlush, []);
});

test("Property 1: CONTROL B - Omitted transport fallback preserves pending row without error", async () => {
  const atlasKey = makeKey();
  const atlasId = atlasKey._identity.uuaid;
  const lyraKey = makeKey();
  const lyraId = lyraKey._identity.uuaid;
  const channelUri = "channel://local/community/general";
  const tenantId = "tenant-a";

  const policy = {
    mode: "local",
    offline: true,
    channelsEnabled: true,
    channels: { [channelUri]: { members: [atlasId, lyraId] } },
    agents: {
      [atlasId]: { kind: "agent", publicKey: atlasKey._identity.publicKeyHex, capabilities: ["commons:message"], tenantId },
      [lyraId]: { kind: "agent", publicKey: lyraKey._identity.publicKeyHex, capabilities: ["commons:message"], tenantId },
    },
    tenantProfiles: {},
  };
  const profile = createProfile({
    namespace: "local/test",
    name: "Test Profile",
    scope: "local",
    fixtures: ["semantic equivalence A", "semantic equivalence B"],
  });
  policy.tenantProfiles[profile.id] = tenantId;

  const atlasStore = new CommonsStore(":memory:");
  const atlasRuntime = new AgentCommons({
    keychain: atlasKey,
    store: atlasStore,
    policy,
    carriers: [], // Omitted transport and empty carriers
  });
  atlasRuntime.addProfile(profile);

  const res = await atlasRuntime.send({
    recipient: lyraId,
    profileId: profile.id,
    thread: channelUri,
    body: "hello",
  });

  assert.equal(res.state, "pending");
  assert.equal(res.reason, "No configured carrier");

  const flushRes = await atlasRuntime.flush();
  assert.deepEqual(flushRes, []);

  const pendingRows = atlasStore.pending();
  assert.equal(pendingRows.length, 1);
  assert.equal(pendingRows[0].state, "pending");
});

test("Property 1: MUTANT A - Unaccepted receipt refusal retains pending with backoff", async () => {
  const env = makeEnv();
  const rejectedReceipt = {
    carrier: "memory://loopback/test",
    seq: 1,
    sha: "fixture-sha",
    duplicate: false,
    all: [],
    accepted: false,
  };
  env.transport.deliver = async () => rejectedReceipt;

  const res = await env.atlasRuntime.send({
    recipient: env.lyraId,
    profileId: env.profile.id,
    thread: env.channelUri,
    body: "hello",
  });

  assert.equal(res.result.length, 1);
  assert.equal(res.result[0].state, "retry-or-quarantine");
  assert.equal(res.result[0].error, "Carrier rejected envelope");

  const pendingRows = env.atlasStore.pending();
  assert.equal(pendingRows.length, 0); // next_at is in future (now + 2000), so pending() filters it out

  const allRows = env.atlasStore.db.prepare("SELECT * FROM outbox").all();
  assert.equal(allRows.length, 1);
  assert.equal(allRows[0].state, "pending");
  assert.equal(allRows[0].attempts, 1);
  assert.equal(allRows[0].error, "Carrier rejected envelope");

  const flushRes = await env.atlasRuntime.flush();
  assert.deepEqual(flushRes, []);
});

test("Property 1: Five-attempt quarantine boundary with controlled clock", async () => {
  const env = makeEnv();
  env.transport.deliver = async () => ({ accepted: false, carrier: "mem", sha: "s" });

  await env.atlasRuntime.send({
    recipient: env.lyraId,
    profileId: env.profile.id,
    thread: env.channelUri,
    body: "retry-test",
    deferFlush: true,
  });

  const row = env.atlasStore.pending()[0];
  assert.ok(row);

  // Simulate attempts 1 to 4 with store.failure()
  for (let i = 1; i <= 4; i++) {
    env.atlasStore.failure(row.id, `error-${i}`);
    const r = env.atlasStore.db.prepare("SELECT * FROM outbox WHERE id = ?").get(row.id);
    assert.equal(r.state, "pending");
    assert.equal(r.attempts, i);
  }

  // Attempt 5 triggers quarantine
  env.atlasStore.failure(row.id, "error-5");
  const quarantinedRow = env.atlasStore.db.prepare("SELECT * FROM outbox WHERE id = ?").get(row.id);
  assert.equal(quarantinedRow.state, "quarantined");
  assert.equal(quarantinedRow.attempts, 5);
  assert.equal(env.atlasStore.pending().length, 0);
});

test("Property 1: MUTANT B - Offline non-loopback carrier catch returns retry-or-quarantine", async () => {
  const origOffline = process.env.AGENT_COMMONS_OFFLINE;
  process.env.AGENT_COMMONS_OFFLINE = "1";
  try {
    const env = makeEnv();
    const mockCarrierClient = {
      deliver: async () => {
        throw new Error("Carrier refused loopback requirement: https://carrier.example.com");
      },
    };
    const pillarTransport = new PillarCarrierTransport({
      carriers: ["https://carrier.example.com"],
      client: mockCarrierClient,
    });
    env.atlasRuntime.transport = pillarTransport;

    const res = await env.atlasRuntime.send({
      recipient: env.lyraId,
      profileId: env.profile.id,
      thread: env.channelUri,
      body: "offline-test",
      deferFlush: true,
    });
    assert.equal(res.state, "pending");

    const flushRes = await env.atlasRuntime.flush();
    assert.equal(flushRes.length, 1);
    assert.equal(flushRes[0].state, "retry-or-quarantine");
    assert.match(flushRes[0].error, /offline|loopback/i);

    const pendingInDb = env.atlasStore.db.prepare("SELECT * FROM outbox").all();
    assert.equal(pendingInDb.length, 1);
    assert.equal(pendingInDb[0].state, "pending");
  } finally {
    if (origOffline === undefined) delete process.env.AGENT_COMMONS_OFFLINE;
    else process.env.AGENT_COMMONS_OFFLINE = origOffline;
  }
});

// =========================================================================
// Property 2: Structured Channel Send Admission & Validation Precedence (§4.2, §4.2.3)
// =========================================================================
test("Property 2: CONTROL - Structured channel send succeeds when sender and recipient are admitted members", async () => {
  const env = makeEnv();
  const res = await env.atlasRuntime.send({
    recipient: env.lyraId,
    profileId: env.profile.id,
    thread: env.channelUri,
    body: "passing-channel-msg",
  });
  assert.equal(res.result[0].state, "carrier-accepted");
  assert.ok(res.envelope);
});

test("Property 2: MUTANT A - Unauthorized sender throws UNAUTHORIZED_CHANNEL_SENDER with zero writes", async () => {
  const env = makeEnv();
  env.policy.channels[env.channelUri].members = [env.lyraId]; // Atlas removed

  await assert.rejects(
    () =>
      env.atlasRuntime.send({
        recipient: env.lyraId,
        profileId: env.profile.id,
        thread: env.channelUri,
        body: "unauthorized-sender",
      }),
    (err) => err.code === "UNAUTHORIZED_CHANNEL_SENDER" || /UNAUTHORIZED_CHANNEL_SENDER|Sender atlas is unauthorized/.test(err.message)
  );

  const outboxRows = env.atlasStore.db.prepare("SELECT COUNT(*) as count FROM outbox").get();
  assert.equal(outboxRows.count, 0);
});

test("Property 2: MUTANT B - Unauthorized recipient throws UNAUTHORIZED_CHANNEL_RECIPIENT with zero writes", async () => {
  const env = makeEnv();
  env.policy.channels[env.channelUri].members = [env.atlasId]; // Lyra removed

  await assert.rejects(
    () =>
      env.atlasRuntime.send({
        recipient: env.lyraId,
        profileId: env.profile.id,
        thread: env.channelUri,
        body: "unauthorized-recipient",
      }),
    (err) => err.code === "UNAUTHORIZED_CHANNEL_RECIPIENT" || /UNAUTHORIZED_CHANNEL_RECIPIENT|Receiver lyra is unauthorized/.test(err.message)
  );

  const outboxRows = env.atlasStore.db.prepare("SELECT COUNT(*) as count FROM outbox").get();
  assert.equal(outboxRows.count, 0);
});

test("Property 2: MUTANT C - Reserved-prefix malformed / uppercase URI throws INVALID_CHANNEL_URI", async () => {
  const env = makeEnv();
  env.policy.channelsEnabled = false; // Even when channels disabled, reserved prefix takes precedence

  for (const badUri of ["channel://LOCAL/COMMUNITY/GENERAL", "channel:malformed"]) {
    await assert.rejects(
      () =>
        env.atlasRuntime.send({
          recipient: env.lyraId,
          profileId: env.profile.id,
          thread: badUri,
          body: "bad-uri",
        }),
      (err) => err.code === "INVALID_CHANNEL_URI" || /INVALID_CHANNEL_URI/.test(err.message)
    );
  }

  const outboxRows = env.atlasStore.db.prepare("SELECT COUNT(*) as count FROM outbox").get();
  assert.equal(outboxRows.count, 0);
});

test("Property 2: MUTANT D - Unconfigured channel throws UNCONFIGURED_CHANNEL with zero writes", async () => {
  const env = makeEnv();
  await assert.rejects(
    () =>
      env.atlasRuntime.send({
        recipient: env.lyraId,
        profileId: env.profile.id,
        thread: "channel://local/community/unconfigured",
        body: "unconfigured-channel",
      }),
    (err) => err.code === "UNCONFIGURED_CHANNEL" || /UNCONFIGURED_CHANNEL|Channel is unconfigured/.test(err.message)
  );

  const outboxRows = env.atlasStore.db.prepare("SELECT COUNT(*) as count FROM outbox").get();
  assert.equal(outboxRows.count, 0);
});

test("Property 2: MUTANT E - Strict mode legacy thread throws STRUCTURED_CHANNELS_REQUIRED with zero writes", async () => {
  const env = makeEnv();
  env.policy.channelsEnabled = true;

  await assert.rejects(
    () =>
      env.atlasRuntime.send({
        recipient: env.lyraId,
        profileId: env.profile.id,
        thread: "commons",
        body: "legacy-thread",
      }),
    (err) => err.code === "STRUCTURED_CHANNELS_REQUIRED" || /STRUCTURED_CHANNELS_REQUIRED/.test(err.message)
  );

  const outboxRows = env.atlasStore.db.prepare("SELECT COUNT(*) as count FROM outbox").get();
  assert.equal(outboxRows.count, 0);
});

// =========================================================================
// Property 3: Structured Channel Inbound Receive Admission & Quarantine (§4.2, §4.2.3)
// =========================================================================
test("Property 3: CONTROL - Inbound receive and poll succeed for admitted member envelope", async () => {
  const env = makeEnv();
  // 1. Direct receive on envelope 1
  const sent1 = await env.atlasRuntime.send({
    recipient: env.lyraId,
    profileId: env.profile.id,
    thread: env.channelUri,
    body: "hello-lyra-direct",
    deferFlush: true,
  });

  const recv = await env.lyraRuntime.receive(sent1.envelope);
  assert.equal(recv.receipt.kind, "host-accepted");
  assert.equal(recv.body, "hello-lyra-direct");
  assert.equal(recv.accepted, true);

  const processedCount1 = env.lyraStore.db.prepare("SELECT COUNT(*) as c FROM processed").get().c;
  assert.equal(processedCount1, 1);

  // 2. Poll on envelope 2 delivered to transport
  const sent2 = await env.atlasRuntime.send({
    recipient: env.lyraId,
    profileId: env.profile.id,
    thread: env.channelUri,
    body: "hello-lyra-poll",
    deferFlush: true,
  });
  await env.transport.deliver(sent2.envelope);

  const polled = await env.lyraRuntime.poll();
  assert.equal(polled.length, 1);
  assert.equal(polled[0].accepted, true);
  assert.equal(polled[0].body, "hello-lyra-poll");

  const processedCount2 = env.lyraStore.db.prepare("SELECT COUNT(*) as c FROM processed").get().c;
  assert.equal(processedCount2, 2);
});

test("Property 3: MUTANT A & B - Unauthorized inbound sender fails receive() and poll()", async () => {
  const env = makeEnv();
  const sent = await env.atlasRuntime.send({
    recipient: env.lyraId,
    profileId: env.profile.id,
    thread: env.channelUri,
    body: "sender-unauth-test",
    deferFlush: true,
  });

  // Mutate receiver policy only
  env.lyraRuntime.policy.channels[env.channelUri].members = [env.lyraId]; // Atlas removed

  // MUTANT A: direct receive() throws
  await assert.rejects(
    () => env.lyraRuntime.receive(sent.envelope),
    (err) => err.code === "UNAUTHORIZED_CHANNEL_SENDER" || /UNAUTHORIZED_CHANNEL_SENDER|Sender .* is unauthorized for channel/.test(err.message)
  );
  assert.equal(env.lyraStore.db.prepare("SELECT COUNT(*) as c FROM processed").get().c, 0);
  assert.equal(env.lyraStore.audit().filter(e => JSON.parse(e.body).kind === "control-received").length, 0);

  // MUTANT B: poll() quarantines with exact reason and advances cursor
  await env.transport.deliver(sent.envelope);
  const polled = await env.lyraRuntime.poll();
  assert.equal(polled.length, 1);
  assert.equal(polled[0].rejected, true);
  assert.equal(polled[0].reason, `Sender ${env.atlasId} is unauthorized for channel ${env.channelUri}`);
  assert.equal(env.lyraStore.db.prepare("SELECT COUNT(*) as c FROM processed").get().c, 0);
  assert.equal(env.lyraStore.audit().filter(e => JSON.parse(e.body).kind === "control-received").length, 0);

  // Second poll returns empty because cursor advanced
  const secondPoll = await env.lyraRuntime.poll();
  assert.equal(secondPoll.length, 0);
});

test("Property 3: MUTANT C & D - Unauthorized inbound receiver fails receive() and poll()", async () => {
  const env = makeEnv();
  const sent = await env.atlasRuntime.send({
    recipient: env.lyraId,
    profileId: env.profile.id,
    thread: env.channelUri,
    body: "recv-unauth-test",
    deferFlush: true,
  });

  // Mutate receiver policy only: Lyra removed
  env.lyraRuntime.policy.channels[env.channelUri].members = [env.atlasId];

  // MUTANT C: direct receive() throws
  await assert.rejects(
    () => env.lyraRuntime.receive(sent.envelope),
    (err) => err.code === "UNAUTHORIZED_CHANNEL_RECEIVER" || /UNAUTHORIZED_CHANNEL_RECEIVER|Receiver .* is unauthorized for channel/.test(err.message)
  );
  assert.equal(env.lyraStore.db.prepare("SELECT COUNT(*) as c FROM processed").get().c, 0);

  // MUTANT D: poll() quarantines with exact reason and advances cursor
  await env.transport.deliver(sent.envelope);
  const polled = await env.lyraRuntime.poll();
  assert.equal(polled.length, 1);
  assert.equal(polled[0].rejected, true);
  assert.equal(polled[0].reason, `Receiver ${env.lyraId} is unauthorized for channel ${env.channelUri}`);
  assert.equal(env.lyraStore.db.prepare("SELECT COUNT(*) as c FROM processed").get().c, 0);

  const secondPoll = await env.lyraRuntime.poll();
  assert.equal(secondPoll.length, 0);
});

test("Property 3: MUTANT E - Strict mode inbound legacy rejection fails receive() and poll()", async () => {
  const env = makeEnv();
  // Sender queues legacy envelope under channelsEnabled: false
  env.atlasRuntime.policy.channelsEnabled = false;
  const sent = await env.atlasRuntime.send({
    recipient: env.lyraId,
    profileId: env.profile.id,
    thread: "commons",
    body: "legacy-inbound",
    deferFlush: true,
  });

  // Receiver has channelsEnabled: true (strict)
  env.lyraRuntime.policy.channelsEnabled = true;

  // Direct receive
  await assert.rejects(
    () => env.lyraRuntime.receive(sent.envelope),
    (err) => err.code === "STRUCTURED_CHANNELS_REQUIRED" || /STRUCTURED_CHANNELS_REQUIRED/.test(err.message)
  );
  assert.equal(env.lyraStore.db.prepare("SELECT COUNT(*) as c FROM processed").get().c, 0);

  // Poll
  await env.transport.deliver(sent.envelope);
  const polled = await env.lyraRuntime.poll();
  assert.equal(polled.length, 1);
  assert.equal(polled[0].rejected, true);
  assert.match(polled[0].reason, /STRUCTURED_CHANNELS_REQUIRED/);
  assert.equal(env.lyraStore.db.prepare("SELECT COUNT(*) as c FROM processed").get().c, 0);
});

test("Property 3: MUTANT F - Inbound reserved-malformed rejection fails receive() and poll()", async () => {
  const env = makeEnv();
  const bodyText = "malformed-thread-body";
  const payload = {
    v: "agent-commons/1",
    id: "00000000-0000-0000-0000-000000000001",
    profileId: env.profile.id,
    thread: "channel:malformed",
    kind: "message",
    wire: encode(bodyText, env.profile.lexicon),
    bodyHash: digest(bodyText),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  const sealedEnvelope = seal(env.atlasKey, {
    recipient: env.lyraId,
    recipientPublicKey: env.lyraKey._identity.publicKeyHex,
    kind: "agent-commons/1",
    payload,
  });

  // Direct receive
  await assert.rejects(
    () => env.lyraRuntime.receive(sealedEnvelope),
    (err) => err.code === "INVALID_CHANNEL_URI" || /INVALID_CHANNEL_URI/.test(err.message)
  );
  assert.equal(env.lyraStore.db.prepare("SELECT COUNT(*) as c FROM processed").get().c, 0);

  // Poll
  await env.transport.deliver(sealedEnvelope);
  const polled = await env.lyraRuntime.poll();
  assert.equal(polled.length, 1);
  assert.equal(polled[0].rejected, true);
  assert.match(polled[0].reason, /INVALID_CHANNEL_URI/);
  assert.equal(env.lyraStore.db.prepare("SELECT COUNT(*) as c FROM processed").get().c, 0);
});

// =========================================================================
// Property 4: Tenant Boundary Fail-Closed Across All Scopes & Durable Flush (§5.1, §5.2)
// =========================================================================
test("Property 4: CONTROL A & B - Tenant matching and unbound local exemption", async () => {
  const env = makeEnv();
  // CONTROL A: Local profile bound to tenant-a, matching sender and receiver
  const resA = await env.atlasRuntime.send({
    recipient: env.lyraId,
    profileId: env.profile.id,
    thread: env.channelUri,
    body: "tenant-match",
  });
  assert.equal(resA.result[0].state, "carrier-accepted");

  // CONTROL B: Unbound local profile exemption
  const unboundLocalProfile = createProfile({
    namespace: "local/unbound",
    name: "Unbound Local Profile",
    scope: "local",
    fixtures: ["fixture one local", "fixture two local"],
  });
  env.atlasRuntime.addProfile(unboundLocalProfile);
  env.lyraRuntime.addProfile(unboundLocalProfile);
  delete env.policy.tenantProfiles[unboundLocalProfile.id];

  const resB = await env.atlasRuntime.send({
    recipient: env.lyraId,
    profileId: unboundLocalProfile.id,
    thread: env.channelUri,
    body: "unbound-local-pass",
  });
  assert.equal(resB.result[0].state, "carrier-accepted");
});

test("Property 4: MUTANT A & B - Bound local tenant mismatch throws TENANT_NAMESPACE_MISMATCH", async () => {
  const envA = makeEnv();
  envA.policy.agents[envA.lyraId].tenantId = "tenant-b"; // Recipient mismatch
  await assert.rejects(
    () =>
      envA.atlasRuntime.send({
        recipient: envA.lyraId,
        profileId: envA.profile.id,
        thread: envA.channelUri,
        body: "msg",
      }),
    (err) => err.code === "TENANT_NAMESPACE_MISMATCH" || /TENANT_NAMESPACE_MISMATCH|tenant mismatch/i.test(err.message)
  );

  const envB = makeEnv();
  envB.policy.agents[envB.atlasId].tenantId = "tenant-b"; // Sender mismatch
  await assert.rejects(
    () =>
      envB.atlasRuntime.send({
        recipient: envB.lyraId,
        profileId: envB.profile.id,
        thread: envB.channelUri,
        body: "msg",
      }),
    (err) => err.code === "TENANT_NAMESPACE_MISMATCH" || /TENANT_NAMESPACE_MISMATCH|tenant mismatch/i.test(err.message)
  );
});

test("Property 4: MUTANT C & D - Missing tenant binding throws TENANT_NAMESPACE_MISMATCH", async () => {
  const envC = makeEnv();
  delete envC.policy.agents[envC.atlasId].tenantId; // Missing sender binding
  await assert.rejects(
    () =>
      envC.atlasRuntime.send({
        recipient: envC.lyraId,
        profileId: envC.profile.id,
        thread: envC.channelUri,
        body: "msg",
      }),
    (err) => err.code === "TENANT_NAMESPACE_MISMATCH" || /TENANT_NAMESPACE_MISMATCH|tenant mismatch/i.test(err.message)
  );

  const envD = makeEnv();
  delete envD.policy.agents[envD.lyraId].tenantId; // Missing recipient binding
  await assert.rejects(
    () =>
      envD.atlasRuntime.send({
        recipient: envD.lyraId,
        profileId: envD.profile.id,
        thread: envD.channelUri,
        body: "msg",
      }),
    (err) => err.code === "TENANT_NAMESPACE_MISMATCH" || /TENANT_NAMESPACE_MISMATCH|tenant mismatch/i.test(err.message)
  );
});

test("Property 4: MUTANT E, F, G - Inbound receive tenant mismatches and missing bindings fail closed", async () => {
  const env = makeEnv();
  const sent = await env.atlasRuntime.send({
    recipient: env.lyraId,
    profileId: env.profile.id,
    thread: env.channelUri,
    body: "inbound-tenant-test",
    deferFlush: true,
  });

  // MUTANT E: Receiver has tenant-b
  env.lyraRuntime.policy.agents[env.lyraId].tenantId = "tenant-b";
  await assert.rejects(
    () => env.lyraRuntime.receive(sent.envelope),
    (err) => err.code === "TENANT_NAMESPACE_MISMATCH" || /TENANT_NAMESPACE_MISMATCH|tenant mismatch/i.test(err.message)
  );
  assert.equal(env.lyraStore.db.prepare("SELECT COUNT(*) as c FROM processed").get().c, 0);

  // Reset Lyra to tenant-a, then MUTANT F: Sender tenantId removed from receiver policy
  env.lyraRuntime.policy.agents[env.lyraId].tenantId = "tenant-a";
  delete env.lyraRuntime.policy.agents[env.atlasId].tenantId;
  await assert.rejects(
    () => env.lyraRuntime.receive(sent.envelope),
    (err) => err.code === "TENANT_NAMESPACE_MISMATCH" || /TENANT_NAMESPACE_MISMATCH|tenant mismatch/i.test(err.message)
  );
  assert.equal(env.lyraStore.db.prepare("SELECT COUNT(*) as c FROM processed").get().c, 0);

  // Restore sender tenantId, then MUTANT G: Receiver tenantId removed from receiver policy
  env.lyraRuntime.policy.agents[env.atlasId].tenantId = "tenant-a";
  delete env.lyraRuntime.policy.agents[env.lyraId].tenantId;
  await assert.rejects(
    () => env.lyraRuntime.receive(sent.envelope),
    (err) => err.code === "TENANT_NAMESPACE_MISMATCH" || /TENANT_NAMESPACE_MISMATCH|tenant mismatch/i.test(err.message)
  );
  assert.equal(env.lyraStore.db.prepare("SELECT COUNT(*) as c FROM processed").get().c, 0);
});

test("Property 4: MUTANT H & I - Unbound tenant and global scope profiles throw UNBOUND_PROFILE_TENANT", async () => {
  const env = makeEnv();

  // MUTANT H: scope tenant without tenantProfiles entry
  const tenantProfile = createProfile({
    namespace: "tenant/org",
    name: "Org Profile",
    scope: "tenant",
    fixtures: ["tenant fixture alpha", "tenant fixture beta"],
  });
  env.atlasRuntime.addProfile(tenantProfile);
  delete env.policy.tenantProfiles[tenantProfile.id];

  await assert.rejects(
    () =>
      env.atlasRuntime.send({
        recipient: env.lyraId,
        profileId: tenantProfile.id,
        thread: env.channelUri,
        body: "tenant-unbound",
      }),
    (err) => err.code === "UNBOUND_PROFILE_TENANT" || /UNBOUND_PROFILE_TENANT|Unbound tenant profile/.test(err.message)
  );

  // MUTANT I: scope global without tenantProfiles entry, with local trust stubs
  const globalProfile = createProfile({
    namespace: "global/standard",
    name: "Standard Global Profile",
    scope: "global",
    fixtures: ["global fixture alpha", "global fixture beta"],
  });
  const pins = env.atlasRuntime.store.get("globalProfilePins", {});
  pins[globalProfile.id] = "IAASO-1001";
  env.atlasRuntime.store.set("globalProfilePins", pins);
  env.atlasRuntime.store.set("profiles", [...env.atlasRuntime.profiles(), globalProfile]);
  delete env.policy.tenantProfiles[globalProfile.id];
  // Local stubs preventing external network
  env.atlasRuntime.trust = {
    publishedProfilePin: async () => ({ code: "IAASO-1001", hash: globalProfile.fixtureHash }),
    authorize: async () => ({ kind: "agent", capabilities: ["commons:message"] }),
  };

  await assert.rejects(
    () =>
      env.atlasRuntime.send({
        recipient: env.lyraId,
        profileId: globalProfile.id,
        thread: env.channelUri,
        body: "global-unbound",
      }),
    (err) => err.code === "UNBOUND_PROFILE_TENANT" || /UNBOUND_PROFILE_TENANT|Unbound tenant profile/.test(err.message)
  );
});

test("Property 4: Scope Separation Pole (R3) - verifyProfile validator vs validateTenantBinding", () => {
  const base = createProfile({
    namespace: "local/rebuilt",
    name: "Rebuilt Local",
    scope: "local",
    fixtures: ["fixture one local", "fixture two local"],
  });

  // 1. Unrecognized scope rejected at verifyProfile seam with 'Invalid profile scope'
  assert.throws(
    () => verifyProfile({ ...base, scope: "unknown" }),
    /Invalid profile scope/
  );

  // 2. Local profile with scope: undefined is rebuilt as 'local' by verifyProfile
  const withoutScope = { ...base };
  delete withoutScope.scope;
  const verified = verifyProfile(withoutScope);
  assert.equal(verified.scope, "local");

  // 3. At validateTenantBinding with unbound tenant profile, fails closed with UNBOUND_PROFILE_TENANT
  assert.throws(
    () => validateTenantBinding("atlas", "lyra", { id: "some-id", scope: "tenant" }, {}),
    (err) => err.code === "UNBOUND_PROFILE_TENANT" || /UNBOUND_PROFILE_TENANT|Unbound tenant profile/.test(err.message)
  );
});

test("Property 4: Inbound unbound tenant scope refusal via receive()", async () => {
  const env = makeEnv();
  const tenantProfile = createProfile({
    namespace: "tenant/org",
    name: "Org Profile",
    scope: "tenant",
    fixtures: ["tenant fixture 1", "tenant fixture 2"],
  });
  env.policy.tenantProfiles[tenantProfile.id] = "tenant-a";
  env.atlasRuntime.addProfile(tenantProfile);
  env.lyraRuntime.addProfile(tenantProfile);

  const sent = await env.atlasRuntime.send({
    recipient: env.lyraId,
    profileId: tenantProfile.id,
    thread: env.channelUri,
    body: "unbound-inbound",
    deferFlush: true,
  });

  // Remove profile from receiver tenantProfiles
  delete env.lyraRuntime.policy.tenantProfiles[tenantProfile.id];

  await assert.rejects(
    () => env.lyraRuntime.receive(sent.envelope),
    (err) => err.code === "UNBOUND_PROFILE_TENANT" || /UNBOUND_PROFILE_TENANT|Unbound tenant profile/.test(err.message)
  );
  assert.equal(env.lyraStore.db.prepare("SELECT COUNT(*) as c FROM processed").get().c, 0);
});

test("Property 4: Durable Flush Rechecks & Retained-Store Recovery (CONTROL 1 & MUTANTS 1-7)", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ac-p4-flush-"));
  try {
    const env = makeEnv(tempDir);
    // Queue message with valid matching policy
    const sent = await env.atlasRuntime.send({
      recipient: env.lyraId,
      profileId: env.profile.id,
      thread: env.channelUri,
      body: "durable-flush-msg",
      deferFlush: true,
    });
    const msgId = sent.envelope.id;

    // CONTROL 1: Retained Store Recovery
    // Close store and runtime
    env.atlasStore.close();
    const recoveredStore = new CommonsStore(join(tempDir, "store.db"));
    const recoveredRuntime = new AgentCommons({
      keychain: env.atlasKey,
      store: recoveredStore,
      policy: env.policy,
      transport: env.transport,
    });
    recoveredRuntime.addProfile(env.profile);

    const flushControl = await recoveredRuntime.flush();
    assert.equal(flushControl.length, 1);
    assert.equal(flushControl[0].state, "carrier-accepted");
    recoveredStore.close();

    // Setup for MUTANT 1: Thread-only corruption
    const storeM1 = new CommonsStore(join(tempDir, "store.db"));
    const runtimeM1 = new AgentCommons({ keychain: env.atlasKey, store: storeM1, policy: env.policy, transport: env.transport });
    runtimeM1.addProfile(env.profile);
    const sentM1 = await runtimeM1.send({
      recipient: env.lyraId,
      profileId: env.profile.id,
      thread: env.channelUri,
      body: "m1-msg",
      deferFlush: true,
    });
    // Tamper meta.thread in SQLite kv table
    const metaM1 = storeM1.get(`outbox_meta:${sentM1.envelope.id}`);
    metaM1.thread = "commons";
    storeM1.set(`outbox_meta:${sentM1.envelope.id}`, metaM1);

    const flushM1 = await runtimeM1.flush();
    assert.equal(flushM1.length, 1);
    assert.equal(flushM1[0].state, "retry-or-quarantine");
    assert.equal(flushM1[0].error, "INVALID_OUTBOX_METADATA");
    storeM1.close();

    // Setup for MUTANT 2: Sender Revocation after queueing
    const storeM2 = new CommonsStore(join(tempDir, "store.db"));
    const runtimeM2 = new AgentCommons({ keychain: env.atlasKey, store: storeM2, policy: env.policy, transport: env.transport });
    runtimeM2.addProfile(env.profile);
    await runtimeM2.send({ recipient: env.lyraId, profileId: env.profile.id, thread: env.channelUri, body: "m2-msg", deferFlush: true });
    // Revoke sender
    runtimeM2.policy.channels[env.channelUri].members = [env.lyraId];
    const flushM2 = await runtimeM2.flush();
    assert.equal(flushM2.length, 1);
    assert.equal(flushM2[0].state, "retry-or-quarantine");
    assert.match(flushM2[0].error, /UNAUTHORIZED_CHANNEL_SENDER|Sender atlas is unauthorized/);
    runtimeM2.policy.channels[env.channelUri].members = [env.atlasId, env.lyraId]; // restore
    storeM2.close();

    // Setup for MUTANT 3: Recipient Revocation after queueing
    const storeM3 = new CommonsStore(join(tempDir, "store.db"));
    const runtimeM3 = new AgentCommons({ keychain: env.atlasKey, store: storeM3, policy: env.policy, transport: env.transport });
    runtimeM3.addProfile(env.profile);
    await runtimeM3.send({ recipient: env.lyraId, profileId: env.profile.id, thread: env.channelUri, body: "m3-msg", deferFlush: true });
    // Revoke recipient
    runtimeM3.policy.channels[env.channelUri].members = [env.atlasId];
    const flushM3 = await runtimeM3.flush();
    assert.equal(flushM3.length, 1);
    assert.equal(flushM3[0].state, "retry-or-quarantine");
    assert.match(flushM3[0].error, /UNAUTHORIZED_CHANNEL_RECIPIENT|Receiver lyra is unauthorized/);
    runtimeM3.policy.channels[env.channelUri].members = [env.atlasId, env.lyraId]; // restore
    storeM3.close();

    // Setup for MUTANT 4: Peer tenant revocation after queueing
    const storeM4 = new CommonsStore(join(tempDir, "store.db"));
    const runtimeM4 = new AgentCommons({ keychain: env.atlasKey, store: storeM4, policy: env.policy, transport: env.transport });
    runtimeM4.addProfile(env.profile);
    await runtimeM4.send({ recipient: env.lyraId, profileId: env.profile.id, thread: env.channelUri, body: "m4-msg", deferFlush: true });
    runtimeM4.policy.agents[env.lyraId].tenantId = "tenant-b";
    const flushM4 = await runtimeM4.flush();
    assert.equal(flushM4.length, 1);
    assert.equal(flushM4[0].state, "retry-or-quarantine");
    assert.match(flushM4[0].error, /TENANT_NAMESPACE_MISMATCH|tenant mismatch/i);
    runtimeM4.policy.agents[env.lyraId].tenantId = "tenant-a"; // restore
    storeM4.close();

    // Setup for MUTANT 5: Missing admission record
    const storeM5 = new CommonsStore(join(tempDir, "store.db"));
    const runtimeM5 = new AgentCommons({ keychain: env.atlasKey, store: storeM5, policy: env.policy, transport: env.transport });
    runtimeM5.addProfile(env.profile);
    const sentM5 = await runtimeM5.send({ recipient: env.lyraId, profileId: env.profile.id, thread: env.channelUri, body: "m5-msg", deferFlush: true });
    storeM5.db.prepare("DELETE FROM kv WHERE k = ?").run(`outbox_meta:${sentM5.envelope.id}`);
    const flushM5 = await runtimeM5.flush();
    assert.equal(flushM5.length, 1);
    assert.equal(flushM5[0].state, "retry-or-quarantine");
    assert.equal(flushM5[0].error, "INVALID_OUTBOX_METADATA");
    storeM5.close();

    // Setup for MUTANT 6: Strict toggle after queueing
    const storeM6 = new CommonsStore(join(tempDir, "store.db"));
    const runtimeM6 = new AgentCommons({ keychain: env.atlasKey, store: storeM6, policy: { ...env.policy, channelsEnabled: false }, transport: env.transport });
    runtimeM6.addProfile(env.profile);
    await runtimeM6.send({ recipient: env.lyraId, profileId: env.profile.id, thread: "commons", body: "m6-msg", deferFlush: true });
    // Toggle strict mode
    runtimeM6.policy.channelsEnabled = true;
    const flushM6 = await runtimeM6.flush();
    assert.equal(flushM6.length, 1);
    assert.equal(flushM6[0].state, "retry-or-quarantine");
    assert.equal(flushM6[0].error, "STRUCTURED_CHANNELS_REQUIRED");
    storeM6.close();

    // Setup for MUTANT 7: Authenticated reserved-malformed flush refusal (R1b / R3)
    const storeM7 = new CommonsStore(join(tempDir, "store.db"));
    const runtimeM7 = new AgentCommons({ keychain: env.atlasKey, store: storeM7, policy: env.policy, transport: env.transport });
    runtimeM7.addProfile(env.profile);
    // Queue valid message first
    const sentM7 = await runtimeM7.send({ recipient: env.lyraId, profileId: env.profile.id, thread: env.channelUri, body: "m7-msg", deferFlush: true });
    // Construct signed tuple matching runtime.mjs:161 exactly:
    const sha = envelopeSha(sentM7.envelope);
    const tuple7 = {
      id: sentM7.envelope.id,
      sha,
      thread: "channel:malformed",
      profileId: env.profile.id,
      sender: env.atlasId,
      recipient: env.lyraId,
    };
    const sig7 = env.atlasKey.sign(Buffer.from(jcs(tuple7))).toString("hex");
    const meta7 = { ...tuple7, signature: sig7 };
    storeM7.set(`outbox_meta:${sentM7.envelope.id}`, meta7);

    const flushM7 = await runtimeM7.flush();
    assert.equal(flushM7.length, 1);
    assert.equal(flushM7[0].state, "retry-or-quarantine");
    assert.equal(flushM7[0].error, "INVALID_CHANNEL_URI");

    const rowM7 = storeM7.db.prepare("SELECT * FROM outbox WHERE id = ?").get(sentM7.envelope.id);
    assert.equal(rowM7.attempts, 1);
    assert.equal(rowM7.error, "INVALID_CHANNEL_URI");
    storeM7.close();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// =========================================================================
// Property 5: Legacy Thread Compatibility & Reserved-Prefix Priority (§4.2)
// =========================================================================
test("Property 5: CONTROL - Legacy thread succeeds under channelsEnabled !== true", async () => {
  const env = makeEnv();
  env.policy.channelsEnabled = false;

  const res = await env.atlasRuntime.send({
    recipient: env.lyraId,
    profileId: env.profile.id,
    thread: "commons",
    body: "legacy-pass",
  });
  assert.equal(res.result[0].state, "carrier-accepted");
});

test("Property 5: MUTANT A - Legacy thread denied under channelsEnabled === true", async () => {
  const env = makeEnv();
  env.policy.channelsEnabled = true;

  await assert.rejects(
    () =>
      env.atlasRuntime.send({
        recipient: env.lyraId,
        profileId: env.profile.id,
        thread: "commons",
        body: "legacy-fail",
      }),
    (err) => err.code === "STRUCTURED_CHANNELS_REQUIRED" || /STRUCTURED_CHANNELS_REQUIRED/.test(err.message)
  );
});

test("Property 5: MUTANT B - Reserved prefix takes precedence over disabled channels", async () => {
  const env = makeEnv();
  env.policy.channelsEnabled = false;

  // Even though channelsEnabled is false, channel:// is classified as structured and enforces channel configuration
  await assert.rejects(
    () =>
      env.atlasRuntime.send({
        recipient: env.lyraId,
        profileId: env.profile.id,
        thread: "channel://local/community/unconfigured",
        body: "reserved-precedence",
      }),
    (err) => err.code === "UNCONFIGURED_CHANNEL" || /UNCONFIGURED_CHANNEL|Channel is unconfigured/.test(err.message)
  );

  // And malformed channel URI throws INVALID_CHANNEL_URI
  await assert.rejects(
    () =>
      env.atlasRuntime.send({
        recipient: env.lyraId,
        profileId: env.profile.id,
        thread: "channel:malformed",
        body: "reserved-malformed",
      }),
    (err) => err.code === "INVALID_CHANNEL_URI" || /INVALID_CHANNEL_URI/.test(err.message)
  );
});

// =========================================================================
// Property 4: Reviewer Atomicity and Ordering Fault Oracles
// =========================================================================
test("Property 4: Atomic rollback oracle on send metadata fault", async () => {
  const a = new Keychain("unused");
  const b = new Keychain("unused");
  a._identity = Keychain.generate();
  b._identity = Keychain.generate();
  const store = new CommonsStore(":memory:");
  const policy = {
    mode: "local",
    offline: true,
    agents: Object.fromEntries(
      [a, b].map((k) => [
        k._identity.uuaid,
        { kind: "agent", publicKey: k._identity.publicKeyHex, capabilities: ["commons:message"] },
      ])
    ),
  };
  const runtime = new AgentCommons({ keychain: a, store, policy });
  const profile = createProfile({
    namespace: "local/review",
    name: "Atomic rollback",
    scope: "local",
    fixtures: ["first fixture", "second fixture"],
  });
  runtime.addProfile(profile);
  const set = store.set.bind(store);
  let faults = 0;
  store.set = (key, value) => {
    if (key.startsWith("outbox_meta:")) {
      faults++;
      throw Error("AC2_META_WRITE_FAULT");
    }
    return set(key, value);
  };
  try {
    await assert.rejects(
      runtime.send({ recipient: b._identity.uuaid, profileId: profile.id, body: "atomic", deferFlush: true }),
      /AC2_META_WRITE_FAULT/
    );
    const outbox = store.db.prepare("SELECT COUNT(*) AS n FROM outbox").get().n;
    const admission = store.audit().filter((e) => JSON.parse(e.body).kind === "outbox-admission").length;
    assert.equal(faults, 1);
    assert.equal(outbox, 0);
    assert.equal(admission, 0);
  } finally {
    store.close();
  }
});

test("Property 4: Actual trust-failure ordering oracle on receive path", async () => {
  const keys = Array.from({ length: 3 }, () => {
    const k = new Keychain("unused");
    k._identity = Keychain.generate();
    return k;
  });
  const policy = {
    mode: "local",
    offline: true,
    agents: Object.fromEntries(
      keys.map((k) => [
        k._identity.uuaid,
        { kind: "agent", publicKey: k._identity.publicKeyHex, capabilities: ["commons:message"] },
      ])
    ),
  };
  const transport = new MemoryLoopbackTransport();
  const stores = [new CommonsStore(":memory:"), new CommonsStore(":memory:")];
  const [a, b] = keys.slice(0, 2).map((keychain, i) => new AgentCommons({ keychain, store: stores[i], policy, transport }));
  const profile = createProfile({
    namespace: "local/review",
    name: "Transient order",
    scope: "local",
    fixtures: ["first fixture", "second fixture"],
  });
  a.addProfile(profile);
  b.addProfile(profile);
  try {
    for (const recipient of [b.uuaid, b.uuaid, keys[2]._identity.uuaid]) {
      const { envelope } = await a.send({ recipient, profileId: profile.id, body: "trust-order", deferFlush: true });
      await transport.deliver(envelope);
    }
    let calls = 0;
    b.trust.authorize = async () => {
      calls++;
      const e = Error("AC2_TRANSIENT");
      e.transient = true;
      e.code = "trust-unavailable";
      throw e;
    };
    const result = await b.poll();
    const cursor = b.store.get("cursors", {})[transport.sourceId] ?? 0;
    assert.equal(result.length, 1);
    assert.equal(calls, 1);
    assert.equal(cursor, 0);
    assert.equal(result[0].deferred, true);
  } finally {
    await transport.close();
    for (const s of stores) s.close();
  }
});
