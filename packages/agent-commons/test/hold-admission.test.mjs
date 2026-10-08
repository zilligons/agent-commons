// L11: Hold Before Admission in Agent Commons Engine (T1-T16 Two-Pole Suite)
// Code mutants for these properties: the project design
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  AgentCommons,
  CommonsStore,
  Keychain,
  createProfile,
  MemoryLoopbackTransport,
} from "../src/index.mjs";
import { seal, envelopeSha } from "../src/pillar.mjs";
import { encode, digest } from "../src/profiles.mjs";

function makeKey() {
  const k = new Keychain("test-key");
  k._identity = Keychain.generate();
  return k;
}

function makeTestEnv({ holdBeforeAdmission = true } = {}) {
  const atlasKey = makeKey();
  const lyraKey = makeKey();
  const atlasId = atlasKey._identity.uuaid;
  const lyraId = lyraKey._identity.uuaid;
  const channelUri = "channel://local/community/general";

  const policy = {
    mode: "local",
    offline: true,
    channelsEnabled: true,
    holdBeforeAdmission,
    channels: {
      [channelUri]: {
        members: [lyraId], // atlasId intentionally omitted from channel members
        allowForwarding: false,
      },
    },
    agents: {
      [atlasId]: {
        kind: "agent",
        publicKey: atlasKey._identity.publicKeyHex,
        capabilities: ["commons:message", "commons:evolve"],
      },
      [lyraId]: {
        kind: "agent",
        publicKey: lyraKey._identity.publicKeyHex,
        capabilities: ["commons:message", "commons:evolve"],
      },
    },
  };

  const profile = createProfile({
    namespace: "local/test",
    name: "Test Profile",
    scope: "local",
    fixtures: ["fixture one", "fixture two"],
  });

  const lyraStore = new CommonsStore(":memory:");
  const transport = new MemoryLoopbackTransport();

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
    policy,
    profile,
    lyraStore,
    transport,
    lyraRuntime,
  };
}

function makeSealedMessage(senderKey, recipientKey, profile, {
  thread = "channel://local/community/general",
  body = "test-message",
  kind = "message",
  expiresAt = new Date(Date.now() + 3600000).toISOString(),
  id = randomUUID(),
} = {}) {
  const payload = {
    v: "agent-commons/1",
    id,
    kind,
    thread,
    profileId: profile.id,
    wire: encode(body, profile.lexicon),
    bodyHash: digest(body),
    expiresAt,
  };
  return {
    payload,
    envelope: seal(senderKey, {
      recipient: recipientKey._identity.uuaid,
      recipientPublicKey: recipientKey._identity.publicKeyHex,
      kind: "agent-commons/1",
      payload,
    }),
  };
}

// =========================================================================
// T1: Hold before admission for invited sender, released after policy update
// =========================================================================
test("T1: CONTROL - Invited sender message is held, then accepted on releaseHeld after admission manifest", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const { payload, envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: "hello-hold" });

  const res = await env.lyraRuntime.receive(envelope);
  assert.equal(res.held, true);
  assert.equal(res.id, envelope.id);
  assert.equal(res.sender, env.atlasId);
  assert.equal(res.channel, env.channelUri);

  // Stored in held table, not yet processed/delivered
  assert.equal(env.lyraStore.allHeld().length, 1);
  assert.equal(env.lyraStore.seen(`msg:${env.atlasId}:${payload.id}`), false);

  // Update policy to admit sender to channel
  env.policy.channels[env.channelUri].members.push(env.atlasId);

  const released = await env.lyraRuntime.releaseHeld();
  assert.equal(released.length, 1);
  assert.equal(released[0].accepted, true);
  assert.equal(released[0].body, "hello-hold");
  assert.equal(released[0].id, payload.id);

  // Now leaves hold and is marked processed
  assert.equal(env.lyraStore.allHeld().length, 0);
  assert.equal(env.lyraStore.seen(`msg:${env.atlasId}:${payload.id}`), true);

  const auditKinds = env.lyraStore.audit().map(r => JSON.parse(r.body).kind);
  assert.ok(auditKinds.includes("hold-added"));
  assert.ok(auditKinds.includes("hold-released"));
  assert.ok(auditKinds.includes("message-received"));
});

test("T1: CONTROL (inverse) - When hold is disabled, unauthorized sender is refused and lost, releaseHeld finds 0", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: false });
  const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: "hello-mutant" });

  await assert.rejects(
    () => env.lyraRuntime.receive(envelope),
    (err) => err.code === "UNAUTHORIZED_CHANNEL_SENDER"
  );
  assert.equal(env.lyraStore.allHeld().length, 0);
  const released = await env.lyraRuntime.releaseHeld();
  assert.equal(released.length, 0);
});

// =========================================================================
// T2: Stranger (not in policy.agents) is never held
// =========================================================================
test("T2: CONTROL - Stranger not in policy.agents is refused with NOT_ADMITTED and never held", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const strangerKey = makeKey();
  const { envelope } = makeSealedMessage(strangerKey, env.lyraKey, env.profile, { thread: env.channelUri });

  await assert.rejects(
    () => env.lyraRuntime.receive(envelope),
    (err) => err.code === "NOT_ADMITTED" || /NOT_ADMITTED/.test(err.message)
  );
  assert.equal(env.lyraStore.allHeld().length, 0);
});

test("T2: CONTROL (inverse) - Stranger envelope does not enter hold even if channel admits stranger ID", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const strangerKey = makeKey();
  const strangerId = strangerKey._identity.uuaid;
  env.policy.channels[env.channelUri].members.push(strangerId); // In channel, but NOT in policy.agents
  const { envelope } = makeSealedMessage(strangerKey, env.lyraKey, env.profile, { thread: env.channelUri });

  await assert.rejects(
    () => env.lyraRuntime.receive(envelope),
    (err) => err.code === "NOT_ADMITTED" || /NOT_ADMITTED/.test(err.message)
  );
  assert.equal(env.lyraStore.allHeld().length, 0);
});

// =========================================================================
// T3 (C1): Injected permissive trust plus stranger: direct check fails closed
// =========================================================================
test("T3: CONTROL (C1) - Injected permissive trust authorizing strangers is overridden by direct policy check", async () => {
  const strangerKey = makeKey();
  const env = makeTestEnv({ holdBeforeAdmission: true });
  // Injected permissive trust that authorizes everything
  const mockTrust = {
    authorize: async () => ({ tier: "permissive-mock" }),
    standards: async () => [],
    publishedProfilePin: async () => {},
  };
  env.lyraRuntime.trust = mockTrust;

  const { envelope } = makeSealedMessage(strangerKey, env.lyraKey, env.profile, { thread: env.channelUri });

  // Stranger passes mock trust.authorize, but fails channel admission AND direct policy.agents check
  await assert.rejects(
    () => env.lyraRuntime.receive(envelope),
    (err) => err.code === "UNAUTHORIZED_CHANNEL_SENDER"
  );
  assert.equal(env.lyraStore.allHeld().length, 0);
});

test("T3: CONTROL (inverse) (C1) - Simulated trust-trusting hold check would have held stranger; direct check prevents it", async () => {
  const strangerKey = makeKey();
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const mockTrust = {
    authorize: async () => ({ tier: "permissive-mock" }),
    standards: async () => [],
    publishedProfilePin: async () => {},
  };
  env.lyraRuntime.trust = mockTrust;
  const { envelope } = makeSealedMessage(strangerKey, env.lyraKey, env.profile, { thread: env.channelUri });

  // Verify that stranger is NOT in policy.agents directly
  assert.equal(env.policy.agents[strangerKey._identity.uuaid], undefined);
  await assert.rejects(() => env.lyraRuntime.receive(envelope));
  assert.equal(env.lyraStore.allHeld().length, 0);
});

// =========================================================================
// T4 (C1): Admitted UUAID whose transport key differs from policy key
// =========================================================================
test("T4: CONTROL (C1) - Admitted sender UUAID signed with wrong transport key is rejected and never held", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const otherKey = makeKey();
  // Set policy.agents to have a different public key than Atlas's real key
  env.policy.agents[env.atlasId].publicKey = otherKey._identity.publicKeyHex;

  // Permissive trust to test hold path's direct check
  const mockTrust = {
    authorize: async () => ({ tier: "mock" }),
    standards: async () => [],
    publishedProfilePin: async () => {},
  };
  env.lyraRuntime.trust = mockTrust;

  const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri });

  // Direct hold check fails key comparison (agent.publicKey !== envelope.transportSignature.publicKey)
  await assert.rejects(
    () => env.lyraRuntime.receive(envelope),
    (err) => err.code === "UNAUTHORIZED_CHANNEL_SENDER"
  );
  assert.equal(env.lyraStore.allHeld().length, 0);
});

test("T4: CONTROL (inverse) (C1) - When transport key matches policy key, envelope IS eligible for hold", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri });

  // Key matches policy
  assert.equal(envelope.transportSignature.publicKey, env.policy.agents[env.atlasId].publicKey);
  const res = await env.lyraRuntime.receive(envelope);
  assert.equal(res.held, true);
  assert.equal(env.lyraStore.allHeld().length, 1);
});

// =========================================================================
// T5 (C2): UNAUTHORIZED_CHANNEL_SENDER thrown from inside apply(): not held
// =========================================================================
test("T5: CONTROL (C2) - Error thrown from apply() escapes receiveInternal and is never held", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  // Add Atlas to channel so channel admission check passes
  env.policy.channels[env.channelUri].members.push(env.atlasId);

  // Monkey-patch apply to simulate a throw with UNAUTHORIZED_CHANNEL_SENDER
  env.lyraRuntime.apply = async () => {
    const err = new Error("Simulated apply error");
    err.code = "UNAUTHORIZED_CHANNEL_SENDER";
    throw err;
  };

  const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, {
    thread: env.channelUri,
    kind: "profile-control",
    body: JSON.stringify({ kind: "profile-proposal", id: randomUUID(), createdAt: new Date().toISOString(), issuer: env.atlasId, publicKey: env.atlasKey._identity.publicKeyHex, payload: {} }),
  });

  await assert.rejects(
    () => env.lyraRuntime.receive(envelope),
    (err) => err.code === "UNAUTHORIZED_CHANNEL_SENDER" && err.message === "Simulated apply error"
  );
  assert.equal(env.lyraStore.allHeld().length, 0);
});

test("T5: CONTROL (inverse) (C2) - Only assertChannelReceiveAdmission throw is held, not downstream errors", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  // Channel admission fails -> held
  const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri });
  const res = await env.lyraRuntime.receive(envelope);
  assert.equal(res.held, true);
  assert.equal(env.lyraStore.allHeld().length, 1);
});

// =========================================================================
// T6 (C2): UNCONFIGURED_CHANNEL: dropped, not held
// =========================================================================
test("T6: CONTROL (C2) - Message to unconfigured channel throws UNCONFIGURED_CHANNEL and is not held", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const unconfiguredUri = "channel://local/unconfigured/channel";
  const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: unconfiguredUri });

  await assert.rejects(
    () => env.lyraRuntime.receive(envelope),
    (err) => err.code === "UNCONFIGURED_CHANNEL"
  );
  assert.equal(env.lyraStore.allHeld().length, 0);
});

test("T6: CONTROL (inverse) (C2) - Configuring the channel allows hold to activate instead of dropping", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const newUri = "channel://local/new/channel";
  env.policy.channels[newUri] = { members: [env.lyraId], allowForwarding: false };
  const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: newUri });

  const res = await env.lyraRuntime.receive(envelope);
  assert.equal(res.held, true);
  assert.equal(env.lyraStore.allHeld().length, 1);
});

// =========================================================================
// T7 (C3): profile-control from invited sender: refused, not held
// =========================================================================
test("T7: CONTROL (C3) - profile-control envelope is refused immediately and not held", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, {
    thread: env.channelUri,
    kind: "profile-control",
    body: JSON.stringify({ kind: "profile-proposal", id: randomUUID(), createdAt: new Date().toISOString(), issuer: env.atlasId, publicKey: env.atlasKey._identity.publicKeyHex, payload: {} }),
  });

  await assert.rejects(
    () => env.lyraRuntime.receive(envelope),
    (err) => err.code === "UNAUTHORIZED_CHANNEL_SENDER"
  );
  assert.equal(env.lyraStore.allHeld().length, 0);
});

test("T7: CONTROL (inverse) (C3) - kind === 'message' from same sender IS held", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, {
    thread: env.channelUri,
    kind: "message",
  });
  const res = await env.lyraRuntime.receive(envelope);
  assert.equal(res.held, true);
  assert.equal(env.lyraStore.allHeld().length, 1);
});

// =========================================================================
// T8 (C4): Deduplication of carrier duplicates & re-held envelopes
// =========================================================================
test("T8: CONTROL (C4) - Carrier duplicate and re-held envelope store 1 entry and count once against bounds", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: "dedupe-test" });

  // First receipt -> held
  const r1 = await env.lyraRuntime.receive(envelope);
  assert.equal(r1.held, true);
  assert.equal(env.lyraStore.allHeld().length, 1);

  // Duplicate receipt of identical envelope -> returned as held, not stored twice
  const r2 = await env.lyraRuntime.receive(envelope);
  assert.equal(r2.held, true);
  assert.equal(env.lyraStore.allHeld().length, 1);

  // Attempt release while still unadmitted -> stays held, 1 entry
  const released = await env.lyraRuntime.releaseHeld();
  assert.equal(released.length, 0);
  assert.equal(env.lyraStore.allHeld().length, 1);

  const counts = env.lyraStore.holdCounts(env.channelUri, env.atlasId);
  assert.equal(counts.channelSender, 1);
  assert.equal(counts.total, 1);
});

test("T8: CONTROL (inverse) (C4) - Distinct envelopes with different message IDs create distinct held rows", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const { envelope: env1 } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: "msg-1" });
  const { envelope: env2 } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: "msg-2" });

  await env.lyraRuntime.receive(env1);
  await env.lyraRuntime.receive(env2);
  assert.equal(env.lyraStore.allHeld().length, 2);
  const counts = env.lyraStore.holdCounts(env.channelUri, env.atlasId);
  assert.equal(counts.channelSender, 2);
});

// =========================================================================
// T9a (R5): Bounds: 20 per (channel, sender), 100 per channel, 500 total
// =========================================================================
test("T9a: CONTROL (R5) - Bounds 20 per (channel, sender), 100 per channel, 500 total refuse with exact reason", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });

  // 1. Channel-sender bound: 20 envelopes from Atlas into channelUri
  for (let i = 0; i < 20; i++) {
    const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: `cs-${i}` });
    const r = await env.lyraRuntime.receive(envelope);
    assert.equal(r.held, true);
  }
  assert.equal(env.lyraStore.holdCounts(env.channelUri, env.atlasId).channelSender, 20);

  // 21st envelope from Atlas to same channel is refused with 'channel-sender'
  const { envelope: cs21 } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: "cs-21" });
  await assert.rejects(
    () => env.lyraRuntime.receive(cs21),
    (err) => err.code === "UNAUTHORIZED_CHANNEL_SENDER"
  );
  let audit = env.lyraStore.audit().map(r => JSON.parse(r.body));
  let refused = audit.find(e => e.kind === "hold-refused" && e.id === cs21.id);
  assert.ok(refused);
  assert.equal(refused.reason, "channel-sender");

  // 2. Channel bound: 100 per channel
  // We already have 20 from Atlas. We add 4 more senders with 20 envelopes each (= 100 total for channelUri).
  const extraSenders = [];
  for (let s = 0; s < 4; s++) {
    const k = makeKey();
    const id = k._identity.uuaid;
    env.policy.agents[id] = { kind: "agent", publicKey: k._identity.publicKeyHex, capabilities: ["commons:message"] };
    extraSenders.push(k);
    for (let i = 0; i < 20; i++) {
      const { envelope } = makeSealedMessage(k, env.lyraKey, env.profile, { thread: env.channelUri, body: `ch-${s}-${i}` });
      const r = await env.lyraRuntime.receive(envelope);
      assert.equal(r.held, true);
    }
  }
  assert.equal(env.lyraStore.holdCounts(env.channelUri, env.atlasId).channel, 100);

  // 101st envelope for channelUri from a fresh 6th sender: channel-sender is 0, sender is 0, but channel is 100 -> refused with 'channel'
  const sender6 = makeKey();
  env.policy.agents[sender6._identity.uuaid] = { kind: "agent", publicKey: sender6._identity.publicKeyHex, capabilities: ["commons:message"] };
  const { envelope: ch101 } = makeSealedMessage(sender6, env.lyraKey, env.profile, { thread: env.channelUri, body: "ch-101" });
  await assert.rejects(
    () => env.lyraRuntime.receive(ch101),
    (err) => err.code === "UNAUTHORIZED_CHANNEL_SENDER"
  );
  audit = env.lyraStore.audit().map(r => JSON.parse(r.body));
  refused = audit.find(e => e.kind === "hold-refused" && e.id === ch101.id);
  assert.ok(refused);
  assert.equal(refused.reason, "channel");

  // 3. Total bound: 500 across engine
  // Channel 1 has 100. We populate channels 2, 3, 4, 5 with 100 each -> 500 total.
  for (let c = 2; c <= 5; c++) {
    const cUri = `channel://local/c${c}/general`;
    env.policy.channels[cUri] = { members: [env.lyraId], allowForwarding: false };
    for (let s = 0; s < 5; s++) {
      const k = makeKey();
      env.policy.agents[k._identity.uuaid] = { kind: "agent", publicKey: k._identity.publicKeyHex, capabilities: ["commons:message"] };
      for (let i = 0; i < 20; i++) {
        const { envelope } = makeSealedMessage(k, env.lyraKey, env.profile, { thread: cUri, body: `tot-${c}-${s}-${i}` });
        const r = await env.lyraRuntime.receive(envelope);
        assert.equal(r.held, true);
      }
    }
  }
  assert.equal(env.lyraStore.holdCounts(env.channelUri, env.atlasId).total, 500);

  // 501st envelope into channel 6 from a fresh sender: refused with 'total'
  const c6Uri = "channel://local/c6/general";
  env.policy.channels[c6Uri] = { members: [env.lyraId], allowForwarding: false };
  const freshSender = makeKey();
  env.policy.agents[freshSender._identity.uuaid] = { kind: "agent", publicKey: freshSender._identity.publicKeyHex, capabilities: ["commons:message"] };
  const { envelope: tot501 } = makeSealedMessage(freshSender, env.lyraKey, env.profile, { thread: c6Uri, body: "tot-501" });
  await assert.rejects(
    () => env.lyraRuntime.receive(tot501),
    (err) => err.code === "UNAUTHORIZED_CHANNEL_SENDER"
  );
  audit = env.lyraStore.audit().map(r => JSON.parse(r.body));
  refused = audit.find(e => e.kind === "hold-refused" && e.id === tot501.id);
  assert.ok(refused);
  assert.equal(refused.reason, "total");
});

test("T9a: CONTROL (inverse) (R5) - Below bounds, envelopes are held without refusal", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: "under-bound" });
  const res = await env.lyraRuntime.receive(envelope);
  assert.equal(res.held, true);
  const audit = env.lyraStore.audit().map(r => JSON.parse(r.body));
  assert.equal(audit.some(e => e.kind === "hold-refused"), false);
});

// =========================================================================
// T9b (R5): 10-minute expiry and payload expiresAt
// =========================================================================
test("T9b: CONTROL (R5) - Expired held entry is purged on release with hold-expired", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, {
    thread: env.channelUri,
    body: "will-expire",
    // 5 seconds from now
    expiresAt: new Date(Date.now() + 5000).toISOString(),
  });

  const res = await env.lyraRuntime.receive(envelope);
  assert.equal(res.held, true);
  assert.equal(env.lyraStore.allHeld().length, 1);

  // Directly set expires_at in database to simulated past time
  env.lyraStore.db.prepare("UPDATE held SET expires_at=? WHERE id=?").run(Date.now() - 1000, envelope.id);

  // Admit Atlas and release
  env.policy.channels[env.channelUri].members.push(env.atlasId);
  const released = await env.lyraRuntime.releaseHeld();
  assert.equal(released.length, 0); // Not delivered because expired
  assert.equal(env.lyraStore.allHeld().length, 0); // Removed from hold

  const audit = env.lyraStore.audit().map(r => JSON.parse(r.body));
  const expiredEvent = audit.find(e => e.kind === "hold-expired" && e.id === envelope.id);
  assert.ok(expiredEvent);
  assert.equal(expiredEvent.reason, "expired");
});

test("T9b: CONTROL (inverse) (R5) - Non-expired held entry is released and accepted", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: "unexpired" });
  await env.lyraRuntime.receive(envelope);

  env.policy.channels[env.channelUri].members.push(env.atlasId);
  const released = await env.lyraRuntime.releaseHeld();
  assert.equal(released.length, 1);
  assert.equal(released[0].accepted, true);
});

// =========================================================================
// T9c (R5): Held body is never returned before acceptance
// =========================================================================
test("T9c: CONTROL (R5) - Held return value contains no body, wire, or payload content", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const secretBody = "ultra-secret-body-content";
  const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: secretBody });

  const res = await env.lyraRuntime.receive(envelope);
  assert.equal(res.held, true);
  assert.equal(res.body, undefined);
  assert.equal(res.wire, undefined);
  assert.equal(res.payload, undefined);
  assert.equal(Object.keys(res).sort().join(","), "channel,held,id,sender");
});

test("T9c: CONTROL (inverse) (R5) - Upon acceptance, body is properly returned to caller", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const bodyText = "accepted-body-content";
  const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: bodyText });
  await env.lyraRuntime.receive(envelope);

  env.policy.channels[env.channelUri].members.push(env.atlasId);
  const released = await env.lyraRuntime.releaseHeld();
  assert.equal(released.length, 1);
  assert.equal(released[0].body, bodyText);
});

// =========================================================================
// T13 (R1): Admitted sender flooding 5 channels caps at 20 across all channels
// =========================================================================
test("T13: CONTROL (R1) - Admitted sender flooding 5 channels stops at 20 across channels; 6th channel sender succeeds", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });

  // Create 5 channels
  const channels = [];
  for (let i = 1; i <= 5; i++) {
    const cUri = `channel://local/flood-${i}/general`;
    env.policy.channels[cUri] = { members: [env.lyraId], allowForwarding: false };
    channels.push(cUri);
  }

  // Atlas sends 4 messages to each of the 5 channels = 20 total
  for (const cUri of channels) {
    for (let m = 0; m < 4; m++) {
      const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: cUri, body: `flood-${m}` });
      const r = await env.lyraRuntime.receive(envelope);
      assert.equal(r.held, true);
    }
  }

  const countsAtlas = env.lyraStore.holdCounts(channels[0], env.atlasId);
  assert.equal(countsAtlas.sender, 20);
  assert.equal(countsAtlas.channelSender, 4);

  // 21st message from Atlas to channel 1: channelSender is 4 (< 20), but sender count is 20 -> refused with 'sender'
  const { envelope: flood21 } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: channels[0], body: "flood-21" });
  await assert.rejects(
    () => env.lyraRuntime.receive(flood21),
    (err) => err.code === "UNAUTHORIZED_CHANNEL_SENDER"
  );
  const audit = env.lyraStore.audit().map(r => JSON.parse(r.body));
  const refused = audit.find(e => e.kind === "hold-refused" && e.id === flood21.id);
  assert.ok(refused);
  assert.equal(refused.reason, "sender");

  // An independent sender in channel 6 succeeds in being held
  const c6Uri = "channel://local/flood-6/general";
  env.policy.channels[c6Uri] = { members: [env.lyraId], allowForwarding: false };
  const independentKey = makeKey();
  env.policy.agents[independentKey._identity.uuaid] = { kind: "agent", publicKey: independentKey._identity.publicKeyHex, capabilities: ["commons:message"] };
  const { envelope: indEnv } = makeSealedMessage(independentKey, env.lyraKey, env.profile, { thread: c6Uri, body: "ind-1" });
  const indRes = await env.lyraRuntime.receive(indEnv);
  assert.equal(indRes.held, true);
});

test("T13: CONTROL (inverse) (R1) - A sender with < 20 messages across channels is not refused by sender cap", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: "single-send" });
  const r = await env.lyraRuntime.receive(envelope);
  assert.equal(r.held, true);
});

// =========================================================================
// T14 (R2): Sender removed during hold is dropped on releaseHeld
// =========================================================================
test("T14: CONTROL (R2) - Sender removed from policy.agents during hold is dropped on release with hold-dropped", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: "will-be-dropped" });

  await env.lyraRuntime.receive(envelope);
  assert.equal(env.lyraStore.allHeld().length, 1);

  // Remove Atlas from policy.agents while envelope is held
  delete env.policy.agents[env.atlasId];

  // Also admit Atlas in channel (to prove channel admission isn't what drops it)
  env.policy.channels[env.channelUri].members.push(env.atlasId);

  const released = await env.lyraRuntime.releaseHeld();
  assert.equal(released.length, 0); // Dropped, not delivered
  assert.equal(env.lyraStore.allHeld().length, 0); // Removed from hold

  const audit = env.lyraStore.audit().map(r => JSON.parse(r.body));
  const dropped = audit.find(e => e.kind === "hold-dropped" && e.id === envelope.id);
  assert.ok(dropped);
  assert.equal(dropped.reason, "sender-not-admitted");
});

test("T14: CONTROL (inverse) (R2) - When sender remains in policy.agents, releaseHeld accepts message", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: "remains-admitted" });
  await env.lyraRuntime.receive(envelope);

  env.policy.channels[env.channelUri].members.push(env.atlasId);
  const released = await env.lyraRuntime.releaseHeld();
  assert.equal(released.length, 1);
  assert.equal(released[0].accepted, true);
});

// =========================================================================
// T15 (R3): Message accepted directly while copy is held -> duplicate: true on release
// =========================================================================
test("T15: CONTROL (R3) - Message accepted directly while copy is held returns duplicate: true on release with 1 delivery", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const { payload, envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: "seen-race" });

  // 1. Envelope arrives and is held
  await env.lyraRuntime.receive(envelope);
  assert.equal(env.lyraStore.allHeld().length, 1);

  // 2. Channel policy updated to admit Atlas
  env.policy.channels[env.channelUri].members.push(env.atlasId);

  // 3. Same envelope is received directly via receive() and accepted
  const directRes = await env.lyraRuntime.receive(envelope);
  assert.equal(directRes.accepted, true);
  assert.equal(directRes.id, payload.id);
  assert.equal(env.lyraStore.seen(`msg:${env.atlasId}:${payload.id}`), true);

  // 4. releaseHeld() runs: seen check catches it -> leaves hold, returns duplicate: true
  const releaseRes = await env.lyraRuntime.releaseHeld();
  assert.equal(releaseRes.length, 1);
  assert.equal(releaseRes[0].duplicate, true);
  assert.equal(env.lyraStore.allHeld().length, 0);

  // Audit has exactly 1 message-received event (1 delivery)
  const audit = env.lyraStore.audit().map(r => JSON.parse(r.body));
  const messageReceived = audit.filter(e => e.kind === "message-received" && e.envelopeId === envelope.id);
  assert.equal(messageReceived.length, 1);
});

test("T15: CONTROL (inverse) (R3) - Without prior direct delivery, release delivers normally", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: "no-race" });
  await env.lyraRuntime.receive(envelope);

  env.policy.channels[env.channelUri].members.push(env.atlasId);
  const releaseRes = await env.lyraRuntime.releaseHeld();
  assert.equal(releaseRes.length, 1);
  assert.equal(releaseRes[0].accepted, true);
});

// =========================================================================
// T16 (R6): poll() suppresses quarantined-inbound row for held envelopes
// =========================================================================
test("T16: CONTROL (R6) - poll() advances carrier cursor and writes hold-added with zero quarantined-inbound rows", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: "poll-hold" });

  await env.transport.deliver(envelope);
  const polled = await env.lyraRuntime.poll();

  assert.equal(polled.length, 1);
  assert.equal(polled[0].held, true);
  assert.equal(polled[0].id, envelope.id);

  // Check audit: hold-added present, quarantined-inbound absent
  const audit = env.lyraStore.audit().map(r => JSON.parse(r.body));
  assert.ok(audit.some(e => e.kind === "hold-added" && e.id === envelope.id));
  assert.equal(audit.some(e => e.kind === "quarantined-inbound"), false);

  // Carrier cursor advanced
  const cursors = env.lyraStore.get("cursors");
  assert.ok(cursors);
  assert.ok(Object.values(cursors).some(seq => seq > 0));
});

test("T16: CONTROL (inverse) (R6) - When hold is disabled, poll() writes quarantined-inbound", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: false });
  const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: "poll-refused" });

  await env.transport.deliver(envelope);
  const polled = await env.lyraRuntime.poll();

  assert.equal(polled.length, 1);
  assert.equal(polled[0].rejected, true);

  const audit = env.lyraStore.audit().map(r => JSON.parse(r.body));
  assert.ok(audit.some(e => e.kind === "quarantined-inbound" && e.id === envelope.id));
  assert.equal(audit.some(e => e.kind === "hold-added"), false);
});

// =========================================================================
// T10 (C6): Audit rows never contain body, wire, or plaintext
// =========================================================================
test("T10: CONTROL (C6) - Audit rows for hold-added, hold-released, hold-dropped, hold-refused contain zero body or wire data", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const secretText = "confidential-payload-cannot-leak";
  const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: secretText });

  await env.lyraRuntime.receive(envelope);
  env.policy.channels[env.channelUri].members.push(env.atlasId);
  await env.lyraRuntime.releaseHeld();

  const holdRows = env.lyraStore.audit().filter(r => JSON.parse(r.body).kind?.startsWith("hold-"));
  assert.ok(holdRows.length >= 2);
  for (const row of holdRows) {
    const raw = row.body;
    assert.equal(raw.includes(secretText), false);
    assert.equal(raw.includes("wire"), false);
    assert.equal(raw.includes("payload"), false);
  }
});

test("T10: CONTROL (inverse) (C6) - Audit events contain required metadata fields", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: "metadata-check" });
  await env.lyraRuntime.receive(envelope);

  const audit = env.lyraStore.audit().map(r => JSON.parse(r.body));
  const holdEvent = audit.find(e => e.kind === "hold-added");
  assert.ok(holdEvent);
  assert.equal(holdEvent.id, envelope.id);
  assert.equal(holdEvent.sender, env.atlasId);
  assert.equal(holdEvent.channel, env.channelUri);
  assert.equal(holdEvent.sha, envelopeSha(envelope));
});

// =========================================================================
// T11: Default policy behavior unchanged (holdBeforeAdmission defaults to false)
// =========================================================================
test("T11: CONTROL - Without holdBeforeAdmission flag, behavior matches f4aeab9 baseline", async () => {
  const env = makeTestEnv();
  delete env.policy.holdBeforeAdmission; // unset flag

  const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri });
  await assert.rejects(
    () => env.lyraRuntime.receive(envelope),
    (err) => err.code === "UNAUTHORIZED_CHANNEL_SENDER"
  );
  assert.equal(env.lyraStore.allHeld().length, 0);
});

test("T11: CONTROL (inverse) - Explicit holdBeforeAdmission: true enables hold", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri });
  const res = await env.lyraRuntime.receive(envelope);
  assert.equal(res.held, true);
  assert.equal(env.lyraStore.allHeld().length, 1);
});

// =========================================================================
// T12 (C5): Multi-page bounded flush in flushInternal
// =========================================================================
test("T12: CONTROL (C5) - 120 pending outbox rows all flush in 1 call; 1,100 rows stops at 1,000", async () => {
  const k1 = makeKey();
  const k2 = makeKey();
  const policy = {
    mode: "local",
    offline: true,
    channelsEnabled: false,
    agents: {
      [k1._identity.uuaid]: { kind: "agent", publicKey: k1._identity.publicKeyHex, capabilities: ["commons:message"] },
      [k2._identity.uuaid]: { kind: "agent", publicKey: k2._identity.publicKeyHex, capabilities: ["commons:message"] },
    },
  };
  const profile = createProfile({ namespace: "local/test", name: "Test", scope: "local", fixtures: ["f1", "f2"] });
  const transport = new MemoryLoopbackTransport();

  // Test part 1: 120 queued rows all flush in 1 call (3 pages: 50, 50, 20)
  const runtime1 = new AgentCommons({ keychain: k1, policy, transport });
  runtime1.addProfile(profile);

  for (let i = 0; i < 120; i++) {
    await runtime1.send({ recipient: k2._identity.uuaid, profileId: profile.id, body: `msg-${i}`, deferFlush: true });
  }
  assert.equal(runtime1.store.db.prepare("SELECT COUNT(*) as n FROM outbox WHERE state='pending'").get().n, 120);

  const res1 = await runtime1.flush();
  assert.equal(res1.length, 120);
  assert.equal(runtime1.store.db.prepare("SELECT COUNT(*) as n FROM outbox WHERE state='pending'").get().n, 0);

  // Test part 2: 1,100 queued rows stops at hard cap of 20 pages = 1,000 rows
  const runtime2 = new AgentCommons({ keychain: k1, policy, transport });
  runtime2.addProfile(profile);

  for (let i = 0; i < 1100; i++) {
    await runtime2.send({ recipient: k2._identity.uuaid, profileId: profile.id, body: `msg-${i}`, deferFlush: true });
  }
  assert.equal(runtime2.store.db.prepare("SELECT COUNT(*) as n FROM outbox WHERE state='pending'").get().n, 1100);

  const res2 = await runtime2.flush();
  assert.equal(res2.length, 1000);
  assert.equal(runtime2.store.db.prepare("SELECT COUNT(*) as n FROM outbox WHERE state='pending'").get().n, 100);
});

test("T12: CONTROL (inverse) (C5) - Flush with zero pending rows returns empty results without infinite loop", async () => {
  const k1 = makeKey();
  const runtime = new AgentCommons({ keychain: k1, policy: { mode: "local" }, transport: new MemoryLoopbackTransport() });
  const res = await runtime.flush();
  assert.deepEqual(res, []);
});

// =========================================================================
// Concurrency & Interleaving Proof: 50-Cycle Stress with Fixed Seed
// =========================================================================
test("Concurrency & Interleaving: 50-cycle interleaving stress proof between poll() and releaseHeld()", async () => {
  const FIXED_SEED = 0x11062026;
  console.log(`[L11 Interleaving Test] PRNG Fixed Seed: 0x${FIXED_SEED.toString(16)} (${FIXED_SEED})`);

  function makePrng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }
  const rand = makePrng(FIXED_SEED);

  const receiverKey = makeKey();
  const receiverId = receiverKey._identity.uuaid;
  const channelUri = "channel://local/c/stress";
  const profile = createProfile({ namespace: "local/test", name: "Test", scope: "local", fixtures: ["f1", "f2"] });

  const senderKeys = [];
  const senderIds = [];
  for (let i = 0; i < 4; i++) {
    const k = makeKey();
    senderKeys.push(k);
    senderIds.push(k._identity.uuaid);
  }

  const policy = {
    mode: "local",
    offline: true,
    channelsEnabled: true,
    holdBeforeAdmission: true,
    channels: {
      [channelUri]: { members: [receiverId], allowForwarding: false },
    },
    agents: {
      [receiverId]: { kind: "agent", publicKey: receiverKey._identity.publicKeyHex, capabilities: ["commons:message"] },
    },
  };
  for (const k of senderKeys) {
    policy.agents[k._identity.uuaid] = { kind: "agent", publicKey: k._identity.publicKeyHex, capabilities: ["commons:message"] };
  }

  const transport = new MemoryLoopbackTransport();
  const store = new CommonsStore(":memory:");
  const runtime = new AgentCommons({ keychain: receiverKey, store, policy, transport });
  runtime.addProfile(profile);

  const deliveredMessages = new Map();

  for (let cycle = 0; cycle < 50; cycle++) {
    const senderIdx = Math.floor(rand() * senderKeys.length);
    const senderKey = senderKeys[senderIdx];
    const sId = senderIds[senderIdx];
    const msgId = randomUUID();

    const { envelope } = makeSealedMessage(senderKey, receiverKey, profile, {
      thread: channelUri,
      body: `stress-msg-${cycle}`,
      id: msgId,
    });

    await transport.deliver(envelope);

    // Dynamically admit sender with 50% probability
    if (rand() > 0.5) {
      if (!policy.channels[channelUri].members.includes(sId)) {
        policy.channels[channelUri].members.push(sId);
      }
    }

    // Concurrently trigger poll() and releaseHeld()
    const [pollRes, releaseRes] = await Promise.all([
      runtime.poll(),
      runtime.releaseHeld(),
    ]);

    for (const r of pollRes) {
      if (r?.accepted) {
        assert.equal(deliveredMessages.has(r.id), false, `Duplicate delivery via poll for ${r.id}`);
        deliveredMessages.set(r.id, r);
      }
    }
    for (const r of releaseRes) {
      if (r?.accepted) {
        assert.equal(deliveredMessages.has(r.id), false, `Duplicate delivery via releaseHeld for ${r.id}`);
        deliveredMessages.set(r.id, r);
      }
    }
  }

  // Final phase: admit all senders and release any remaining held messages
  for (const sId of senderIds) {
    if (!policy.channels[channelUri].members.includes(sId)) {
      policy.channels[channelUri].members.push(sId);
    }
  }
  const finalRelease = await runtime.releaseHeld();
  for (const r of finalRelease) {
    if (r?.accepted) {
      assert.equal(deliveredMessages.has(r.id), false, `Duplicate delivery in final release for ${r.id}`);
      deliveredMessages.set(r.id, r);
    }
  }

  // Invariants:
  // 1. Every message sent was delivered exactly once
  assert.equal(deliveredMessages.size, 50);

  // 2. Zero quarantined-inbound rows in audit log
  const audit = store.audit().map(r => JSON.parse(r.body));
  const quarantined = audit.filter(e => e.kind === "quarantined-inbound");
  assert.equal(quarantined.length, 0);

  // 3. Store audit integrity is intact
  assert.equal(store.verify(), true);

  // 4. Zero held messages remain
  assert.equal(store.allHeld().length, 0);
});

// =========================================================================
// Rework 1 F1: Expired held row pruning before bounds and deduplication
// =========================================================================
test("Rework 1 F1 (a): CONTROL - 20 expired rows for (channel, sender) are pruned so fresh eligible message is held", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  for (let i = 0; i < 20; i++) {
    const { envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: `old-${i}` });
    env.lyraStore.hold(envelope, `msg:${env.atlasId}:${randomUUID()}`, env.channelUri, env.atlasId, envelopeSha(envelope), Date.now() - 1000);
  }
  assert.equal(env.lyraStore.holdCounts(env.channelUri, env.atlasId).channelSender, 20);

  const { envelope: freshEnv } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: "fresh-msg" });
  const res = await env.lyraRuntime.receive(freshEnv);
  assert.equal(res.held, true);
  assert.equal(env.lyraStore.holdCounts(env.channelUri, env.atlasId).channelSender, 1);
  const audit = env.lyraStore.audit().map(r => JSON.parse(r.body));
  const expiredEvents = audit.filter(e => e.kind === "hold-expired");
  assert.equal(expiredEvents.length, 20);
});

test("Rework 1 F1 (b): CONTROL - Expired row with id X is pruned so same envelope X arriving again is held as live", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const { payload, envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: "replay-after-expiry" });
  const msgKey = `msg:${env.atlasId}:${payload.id}`;
  env.lyraStore.hold(envelope, msgKey, env.channelUri, env.atlasId, envelopeSha(envelope), Date.now() - 1000);
  assert.equal(env.lyraStore.allHeld().length, 1);

  const res = await env.lyraRuntime.receive(envelope);
  assert.equal(res.held, true);
  const live = env.lyraStore.allHeld();
  assert.equal(live.length, 1);
  assert.ok(live[0].expires_at > Date.now());
  const audit = env.lyraStore.audit().map(r => JSON.parse(r.body));
  assert.ok(audit.some(e => e.kind === "hold-expired" && e.id === envelope.id));
  assert.ok(audit.some(e => e.kind === "hold-added" && e.id === envelope.id));
});

// =========================================================================
// Rework 1 F2: Transient error handling in releaseHeldInternal
// =========================================================================
test("Rework 1 F2 (c): CONTROL - Injected trust throwing transient error keeps entry held with hold-deferred, accepted on later release", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const { payload, envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: "transient-retry" });

  await env.lyraRuntime.receive(envelope);
  assert.equal(env.lyraStore.allHeld().length, 1);

  env.policy.channels[env.channelUri].members.push(env.atlasId);

  let callCount = 0;
  const originalTrust = env.lyraRuntime.trust;
  env.lyraRuntime.trust = {
    ...originalTrust,
    authorize: async (uuaid, key, cap) => {
      if (callCount++ === 0) {
        const err = new Error("Registry temporarily offline");
        err.transient = true;
        err.code = "REGISTRY_UNAVAILABLE";
        throw err;
      }
      return originalTrust.authorize(uuaid, key, cap);
    },
  };

  const res1 = await env.lyraRuntime.releaseHeld();
  assert.equal(res1.length, 0);
  assert.equal(env.lyraStore.allHeld().length, 1);

  const audit = env.lyraStore.audit().map(r => JSON.parse(r.body));
  const deferred = audit.find(e => e.kind === "hold-deferred" && e.id === envelope.id);
  assert.ok(deferred);
  assert.equal(deferred.reason, "REGISTRY_UNAVAILABLE");
  assert.equal(audit.some(e => e.kind === "hold-dropped"), false);

  const res2 = await env.lyraRuntime.releaseHeld();
  assert.equal(res2.length, 1);
  assert.equal(res2[0].accepted, true);
  assert.equal(res2[0].id, payload.id);
  assert.equal(env.lyraStore.allHeld().length, 0);
});

test("Rework 1 F2 (d): CONTROL - Two held entries where first defers halts release pass so second is not released ahead", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const { payload: p1, envelope: env1 } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: "msg-1" });
  const { payload: p2, envelope: env2 } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: "msg-2" });

  await env.lyraRuntime.receive(env1);
  await env.lyraRuntime.receive(env2);
  assert.equal(env.lyraStore.allHeld().length, 2);

  env.policy.channels[env.channelUri].members.push(env.atlasId);

  let calls = 0;
  const originalTrust = env.lyraRuntime.trust;
  env.lyraRuntime.trust = {
    ...originalTrust,
    authorize: async (uuaid, key, cap) => {
      calls++;
      if (calls === 1) {
        const err = new Error("Backend timeout");
        err.transient = true;
        err.code = "BACKEND_TIMEOUT";
        throw err;
      }
      return originalTrust.authorize(uuaid, key, cap);
    },
  };

  const res1 = await env.lyraRuntime.releaseHeld();
  assert.equal(res1.length, 0);
  assert.equal(env.lyraStore.allHeld().length, 2);
  assert.equal(calls, 1);

  env.lyraRuntime.trust = originalTrust;
  const res2 = await env.lyraRuntime.releaseHeld();
  assert.equal(res2.length, 2);
  assert.equal(res2[0].id, p1.id);
  assert.equal(res2[1].id, p2.id);
  assert.equal(env.lyraStore.allHeld().length, 0);
});

// =========================================================================
// L13 Item A: Duplicate release appends hold-released audit row
// =========================================================================
test("L13 Item A: CONTROL - Duplicate release appends hold-released audit row with reason duplicate-of-accepted", async () => {
  const env = makeTestEnv({ holdBeforeAdmission: true });
  const { payload, envelope } = makeSealedMessage(env.atlasKey, env.lyraKey, env.profile, { thread: env.channelUri, body: "audit-duplicate-release" });

  // 1. Envelope arrives and is held
  const heldRes = await env.lyraRuntime.receive(envelope);
  assert.equal(heldRes.held, true);
  assert.equal(env.lyraStore.allHeld().length, 1);

  // 2. Channel policy updated to admit Atlas
  env.policy.channels[env.channelUri].members.push(env.atlasId);

  // 3. Same envelope accepted directly
  const directRes = await env.lyraRuntime.receive(envelope);
  assert.equal(directRes.accepted, true);

  // 4. Release held copy
  const releaseRes = await env.lyraRuntime.releaseHeld();
  assert.equal(releaseRes.length, 1);
  assert.equal(releaseRes[0].duplicate, true);

  // Held row is gone
  assert.equal(env.lyraStore.allHeld().length, 0);

  // Exactly one hold-released row with reason "duplicate-of-accepted" exists
  const audit = env.lyraStore.audit().map(r => JSON.parse(r.body));
  const duplicateReleased = audit.filter(e => e.kind === "hold-released" && e.reason === "duplicate-of-accepted");
  assert.equal(duplicateReleased.length, 1);
  assert.equal(duplicateReleased[0].id, envelope.id);
  assert.equal(duplicateReleased[0].sender, env.atlasId);
  assert.equal(duplicateReleased[0].channel, env.channelUri);
  assert.equal(duplicateReleased[0].sha, envelopeSha(envelope));
});

// =========================================================================
// L13 Item B: pruneExpiredHeld in transaction deletes strictly by key
// =========================================================================
test("L13 Item B: CONTROL - pruneExpiredHeld deletes strictly by key inside transaction and preserves interleaved row", () => {
  const store = new CommonsStore(":memory:");
  const now = 10000;
  // Hold initial row that is expired at `now`
  store.hold({ id: "h1" }, "k1", "chan1", "sender1", "sha1", now - 1000);

  // Wrap store.db.prepare for the SELECT call
  const originalPrepare = store.db.prepare.bind(store.db);
  let injected = false;
  store.db.prepare = (sql) => {
    const stmt = originalPrepare(sql);
    if (sql.includes("FROM held WHERE expires_at<=?") && !injected) {
      const origAll = stmt.all.bind(stmt);
      stmt.all = (...args) => {
        const result = origAll(...args);
        // Simulate interleaved write of an expired row right after SELECT
        originalPrepare("INSERT INTO held(id,msg_key,channel,sender,envelope,sha,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)").run(
          "injected-id", "injected-key", "chan1", "sender1", JSON.stringify({ id: "injected-id" }), "sha-inj", now - 500, now - 500
        );
        injected = true;
        return result;
      };
    }
    return stmt;
  };

  const returned = store.pruneExpiredHeld(now);
  store.db.prepare = originalPrepare;

  // 1. Every row the prune removed is in its return value
  assert.equal(returned.length, 1);
  assert.equal(returned[0].id, "h1");
  assert.equal(store.isHeld("h1", "k1"), false);

  // 2. The injected row is either returned or still present
  const returnedIds = new Set(returned.map(r => r.id));
  assert.equal(returnedIds.has("injected-id"), false);
  assert.equal(store.isHeld("injected-id", "injected-key"), true, "injected row must still be present if not returned by prune");

  const allRemaining = store.allHeld();
  assert.equal(allRemaining.length, 1);
  assert.equal(allRemaining[0].id, "injected-id");

  store.close();
});



