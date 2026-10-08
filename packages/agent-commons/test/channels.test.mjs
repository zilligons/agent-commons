import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyThread,
  assertChannelSendAdmission,
  assertChannelReceiveAdmission,
  assertForwardingPermission,
  validateTenantBinding,
  CANONICAL_CHANNEL_REGEX,
  RESERVED_CHANNEL_PREFIX
} from "../src/channels.mjs";

test("Channel classifier: C2 Input / Mode Decision Table (two-pole)", () => {
  const canonicalUris = [
    "channel://commons/dm/agent-session-123",
    "channel://zilligon/community/welcome",
    "channel://local/topic/node-events",
    "channel://commons/session/delib-456"
  ];

  // 1. Canonical structured channels succeed across all policy modes
  for (const uri of canonicalUris) {
    for (const channelsEnabled of [false, true, undefined]) {
      const result = classifyThread(uri, { channelsEnabled });
      assert.equal(result.ok, true, `Expected ${uri} to succeed with channelsEnabled=${channelsEnabled}`);
      assert.equal(result.classification, "structured");
      assert.equal(result.channelUri, uri);
      assert.ok(result.parsed.provider);
      assert.ok(result.parsed.channelType);
      assert.ok(result.parsed.channelId);
    }
  }

  // 2. Non-canonical channel-like spellings fail closed with INVALID_CHANNEL_URI
  const nonCanonicalUris = [
    "CHANNEL://commons/dm/agent-123", // Uppercase scheme (must NOT fall back to legacy bypass)
    "channel:/commons/dm/123",        // Missing slash
    "channel://commons",              // Missing segments
    "channel://commons/dm",           // Only two segments
    "channel://comm@ns/dm/123",       // Disallowed characters
    "Channel://local/topic/test",     // Mixed case scheme
    "CHANNEL://LOCAL/TOPIC/TEST"      // All uppercase
  ];

  for (const badUri of nonCanonicalUris) {
    for (const channelsEnabled of [false, true, undefined]) {
      const result = classifyThread(badUri, { channelsEnabled });
      // Control pole: Must fail closed with INVALID_CHANNEL_URI
      assert.equal(
        result.ok,
        false,
        `Expected non-canonical ${badUri} to fail with channelsEnabled=${channelsEnabled}`
      );
      assert.equal(result.classification, "reserved-malformed");
      assert.equal(result.error, "INVALID_CHANNEL_URI");

      // Mutant pole check: verify that a naive startsWith("channel://") would have incorrectly bypassed
      const naivePrefixMatches = badUri.startsWith("channel://");
      const reservedPrefixMatches = RESERVED_CHANNEL_PREFIX.test(badUri);
      assert.equal(
        reservedPrefixMatches,
        true,
        `Reserved regex must catch channel-like spelling ${badUri}`
      );
    }
  }

  // 3. Ordinary legacy strings under default / disabled mode: ALLOWED
  const legacyStrings = ["commons", "app-topic", "default-thread", "session-789"];
  for (const legacy of legacyStrings) {
    for (const channelsEnabled of [false, undefined]) {
      const result = classifyThread(legacy, { channelsEnabled });
      assert.equal(result.ok, true);
      assert.equal(result.classification, "legacy-allowed");
      assert.equal(result.thread, legacy);
    }
  }

  // 4. Ordinary legacy strings under channelsEnabled === true: DENIED
  for (const legacy of legacyStrings) {
    const result = classifyThread(legacy, { channelsEnabled: true });
    // Control pole: Denied with STRUCTURED_CHANNELS_REQUIRED
    assert.equal(result.ok, false);
    assert.equal(result.classification, "legacy-denied");
    assert.equal(result.error, "STRUCTURED_CHANNELS_REQUIRED");
  }

  // 5. Invalid thread inputs
  assert.equal(classifyThread("").error, "INVALID_THREAD_LENGTH");
  assert.equal(classifyThread("a".repeat(121)).error, "INVALID_THREAD_LENGTH");
  assert.equal(classifyThread(null).error, "INVALID_THREAD_LENGTH");
  assert.equal(classifyThread(undefined).error, "INVALID_THREAD_LENGTH");
});

test("Bidirectional channel admission: outbound send assertions (two-pole)", () => {
  const channelUri = "channel://commons/dm/thread-1";
  const policy = {
    channels: {
      [channelUri]: {
        visibility: "private",
        members: ["agent-alice", "agent-bob"]
      }
    }
  };

  // Control pole: sender and all recipients admitted
  assert.doesNotThrow(() => {
    assertChannelSendAdmission(channelUri, "agent-alice", ["agent-bob"], policy);
  });

  // Mutant pole 1: unauthorized sender fails closed
  assert.throws(
    () => assertChannelSendAdmission(channelUri, "agent-eve", ["agent-bob"], policy),
    (err) => err.code === "UNAUTHORIZED_CHANNEL_SENDER"
  );

  // Mutant pole 2: unauthorized recipient fails closed
  assert.throws(
    () => assertChannelSendAdmission(channelUri, "agent-alice", ["agent-eve"], policy),
    (err) => err.code === "UNAUTHORIZED_CHANNEL_RECIPIENT"
  );

  // Mutant pole 3: unconfigured channel fails closed
  assert.throws(
    () => assertChannelSendAdmission("channel://commons/dm/unconfigured", "agent-alice", ["agent-bob"], policy),
    (err) => err.code === "UNCONFIGURED_CHANNEL"
  );
});

test("Bidirectional channel admission: inbound receive assertions (two-pole)", () => {
  const channelUri = "channel://commons/dm/thread-1";
  const policy = {
    channels: {
      [channelUri]: {
        visibility: "private",
        members: ["agent-alice", "agent-bob"]
      }
    }
  };

  // Control pole: decrypted sender and local receiver admitted
  assert.doesNotThrow(() => {
    assertChannelReceiveAdmission(channelUri, "agent-alice", "agent-bob", policy);
  });

  // Mutant pole 1: unauthorized sender fails closed
  assert.throws(
    () => assertChannelReceiveAdmission(channelUri, "agent-eve", "agent-bob", policy),
    (err) => err.code === "UNAUTHORIZED_CHANNEL_SENDER"
  );

  // Mutant pole 2: unauthorized receiver fails closed
  assert.throws(
    () => assertChannelReceiveAdmission(channelUri, "agent-alice", "agent-eve", policy),
    (err) => err.code === "UNAUTHORIZED_CHANNEL_RECEIVER"
  );

  // Mutant pole 3: unconfigured inbound channel fails closed with UNCONFIGURED_CHANNEL
  assert.throws(
    () => assertChannelReceiveAdmission("channel://commons/dm/unconfigured", "agent-alice", "agent-bob", policy),
    (err) => err.code === "UNCONFIGURED_CHANNEL"
  );
});

test("Cross-channel forwarding assertions (two-pole)", () => {
  const sourceChannel = "channel://commons/dm/source-1";
  const targetChannel = "channel://zilligon/community/announcements";

  const policy = {
    agents: {
      "agent-forwarder": { capabilities: ["commons:message", "commons:forward"] },
      "agent-regular": { capabilities: ["commons:message"] }
    },
    channels: {
      [targetChannel]: {
        visibility: "public",
        allowForwarding: true
      },
      "channel://commons/dm/strict-target": {
        visibility: "private",
        allowForwarding: false
      }
    }
  };

  // Control pole: authorized forwarder and target permits forwarding
  assert.doesNotThrow(() => {
    assertForwardingPermission(sourceChannel, targetChannel, "agent-forwarder", policy);
  });

  // Mutant pole 1: sender lacks commons:forward capability
  assert.throws(
    () => assertForwardingPermission(sourceChannel, targetChannel, "agent-regular", policy),
    (err) => err.code === "CROSS_CHANNEL_FORWARDING_DENIED"
  );

  // Mutant pole 2: target channel disallows forwarding
  assert.throws(
    () => assertForwardingPermission(sourceChannel, "channel://commons/dm/strict-target", "agent-forwarder", policy),
    (err) => err.code === "CROSS_CHANNEL_FORWARDING_DENIED"
  );
});

test("Tenant namespace binding assertions (two-pole)", () => {
  const boundTenantProfile = {
    id: "sha256-bound-profile-digest",
    scope: "tenant"
  };
  const unboundTenantProfile = {
    id: "sha256-unbound-tenant-profile",
    scope: "tenant"
  };
  const unboundLocalProfile = {
    id: "sha256-unbound-local-profile",
    scope: "local"
  };

  const policy = {
    tenantProfiles: {
      [boundTenantProfile.id]: "tenant-acme"
    },
    agents: {
      "agent-acme-1": { tenantId: "tenant-acme" },
      "agent-acme-2": { tenantId: "tenant-acme" },
      "agent-corp-x": { tenantId: "tenant-corp" }
    }
  };

  // Control pole 1: matching tenant passes
  assert.doesNotThrow(() => {
    validateTenantBinding("agent-acme-1", "agent-acme-2", boundTenantProfile, policy);
  });

  // Mutant pole 1: sender tenant mismatch fails closed
  assert.throws(
    () => validateTenantBinding("agent-corp-x", "agent-acme-2", boundTenantProfile, policy),
    (err) => err.code === "TENANT_NAMESPACE_MISMATCH"
  );

  // Mutant pole 2: recipient tenant mismatch fails closed
  assert.throws(
    () => validateTenantBinding("agent-acme-1", "agent-corp-x", boundTenantProfile, policy),
    (err) => err.code === "TENANT_NAMESPACE_MISMATCH"
  );

  // Control pole 2: unbound tenant profile MUST fail closed with UNBOUND_PROFILE_TENANT (R4)
  assert.throws(
    () => validateTenantBinding("agent-acme-1", "agent-acme-2", unboundTenantProfile, policy),
    (err) => err.code === "UNBOUND_PROFILE_TENANT"
  );

  // Control pole 3: unbound local profile passes unconstrained without tenant binding requirement
  assert.doesNotThrow(() => {
    validateTenantBinding("agent-acme-1", "agent-corp-x", unboundLocalProfile, policy);
  });

  // Mutant pole: unbound bare digest string fails closed with UNBOUND_PROFILE_TENANT (R4)
  assert.throws(
    () => validateTenantBinding("agent-acme-1", "agent-corp-x", "sha256-unbound-digest", policy),
    (err) => err.code === "UNBOUND_PROFILE_TENANT"
  );

  // Mutant pole: unbound scope-less ProfileRef fails closed with UNBOUND_PROFILE_TENANT (R4)
  assert.throws(
    () => validateTenantBinding("agent-acme-1", "agent-corp-x", { id: "profile-no-scope" }, policy),
    (err) => err.code === "UNBOUND_PROFILE_TENANT"
  );
});
