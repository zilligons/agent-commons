import test from "node:test";
import assert from "node:assert/strict";
import { MemoryLoopbackTransport, PillarCarrierTransport } from "../src/transport.mjs";
import { OFFLINE_ENV } from "../src/offline.mjs";
import { Keychain } from "../src/pillar.mjs";

function makeKeychain() {
  const kc = new Keychain("unused");
  kc._identity = Keychain.generate();
  return kc;
}

test("MemoryLoopbackTransport: basic deliver, sequencing, and fetchInbox (two-pole)", async () => {
  const transport = new MemoryLoopbackTransport({ instanceId: "test-single" });
  assert.equal(transport.sourceId, "memory://loopback/test-single");
  assert.deepEqual(transport.sources(), ["memory://loopback/test-single"]);

  const env1 = { id: "msg-1", sender: "agent-a", recipient: "agent-b" };
  const env2 = { id: "msg-2", sender: "agent-a", recipient: "agent-b" };

  // Control pole: delivery returns accepted: true with monotonic seq
  const receipt1 = await transport.deliver(env1);
  assert.equal(receipt1.accepted, true);
  assert.equal(receipt1.seq, 1);
  assert.equal(receipt1.carrier, "memory://loopback/test-single");
  assert.equal(receipt1.duplicate, false);
  assert.ok(typeof receipt1.sha === "string" && receipt1.sha.length > 0);

  const receipt2 = await transport.deliver(env2);
  assert.equal(receipt2.accepted, true);
  assert.equal(receipt2.seq, 2);

  // Fetch all since seq 0
  const batchAll = await transport.fetchInbox(transport.sourceId, { since: 0 });
  assert.equal(batchAll.sourceId, "memory://loopback/test-single");
  assert.equal(batchAll.envelopes.length, 2);
  assert.equal(batchAll.envelopes[0].seq, 1);
  assert.equal(batchAll.envelopes[0].sourceId, "memory://loopback/test-single");
  assert.equal(batchAll.envelopes[0].envelope.id, "msg-1");
  assert.equal(batchAll.envelopes[1].seq, 2);

  // Fetch since seq 1 (should only return msg-2)
  const batchSince1 = await transport.fetchInbox(transport.sourceId, { since: 1 });
  assert.equal(batchSince1.envelopes.length, 1);
  assert.equal(batchSince1.envelopes[0].seq, 2);
  assert.equal(batchSince1.envelopes[0].envelope.id, "msg-2");

  // Unknown sourceId fails closed
  await assert.rejects(
    async () => transport.fetchInbox("memory://loopback/other"),
    (err) => err.code === "UNKNOWN_SOURCE_ID"
  );

  await transport.close();
});

test("MemoryLoopbackTransport: unique instance qualifiers and duplicate rejection (two-pole)", async () => {
  // Omitted qualifiers generate unique IDs
  const defaultA = new MemoryLoopbackTransport();
  const defaultB = new MemoryLoopbackTransport();
  assert.notEqual(
    defaultA.sourceId,
    defaultB.sourceId,
    "Omitted instanceId must generate unique sourceId to avoid cursor crosstalk"
  );

  // Explicit non-empty qualifier works
  const namedA = new MemoryLoopbackTransport({ instanceId: "my-named-instance" });
  assert.equal(namedA.sourceId, "memory://loopback/my-named-instance");

  // Duplicate explicit qualifier is rejected
  assert.throws(
    () => new MemoryLoopbackTransport({ instanceId: "my-named-instance" }),
    (err) => err.code === "DUPLICATE_TRANSPORT_INSTANCE"
  );

  // Invalid / empty qualifiers rejected
  assert.throws(
    () => new MemoryLoopbackTransport({ instanceId: "" }),
    /instanceId must be a non-empty string/
  );

  await defaultA.close();
  await defaultB.close();
  await namedA.close();

  // After close, name can be reused cleanly
  const namedAReused = new MemoryLoopbackTransport({ instanceId: "my-named-instance" });
  assert.equal(namedAReused.sourceId, "memory://loopback/my-named-instance");
  await namedAReused.close();
});

test("MemoryLoopbackTransport: async subscriptions execute strictly in FIFO order (two-pole)", async () => {
  const transport = new MemoryLoopbackTransport();
  const executionLog = [];

  const unsubscribe = transport.subscribe(transport.sourceId, async (item) => {
    executionLog.push(`start:${item.seq}`);
    if (item.seq === 1) {
      // Simulate slow async processing on message 1 (50ms)
      await new Promise((resolve) => setTimeout(resolve, 50));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    executionLog.push(`end:${item.seq}`);
  });

  await transport.deliver({ id: "msg-fifo-1" });
  await transport.deliver({ id: "msg-fifo-2" });

  // Wait for queue processing to drain
  await new Promise((resolve) => setTimeout(resolve, 80));

  // Control pole: Must be strictly serialized start:1, end:1, start:2, end:2 (no start:2 before end:1)
  assert.deepEqual(
    executionLog,
    ["start:1", "end:1", "start:2", "end:2"],
    "Async subscription callbacks must complete strictly in FIFO order without overlapping"
  );

  // Unsubscribe stops future deliveries
  unsubscribe();
  await transport.deliver({ id: "msg-fifo-3" });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(executionLog.length, 4, "Unsubscribed callback must not receive new messages");

  await transport.close();
});

test("PillarCarrierTransport: adapter normalizes legacy deliver and fetchInbox (two-pole)", async () => {
  // Fake legacy client returning shapes without L3 fields
  const fakeLegacyClient = {
    carriers: ["http://127.0.0.1:5087"],
    async deliver(envelope, options) {
      // Legacy carrier-client.mjs:134 returns { carrier, seq, sha, duplicate, all } without accepted
      return {
        carrier: "http://127.0.0.1:5087",
        seq: 42,
        sha: "abc123sha",
        duplicate: false,
        all: []
      };
    },
    async fetchInbox(base, options) {
      // Legacy carrier-client.mjs:163 returns { envelopes: [{ seq, envelope }], now } without sourceId
      return {
        envelopes: [
          { seq: 10, envelope: { id: "in-1", sender: "peer", recipient: "me" } },
          { seq: 11, envelope: { id: "in-2", sender: "peer", recipient: "me" } }
        ],
        now: 1700000000000
      };
    }
  };

  const transport = new PillarCarrierTransport({
    client: fakeLegacyClient,
    env: { [OFFLINE_ENV]: "1" } // Loopback is permitted even when offline is forced
  });

  // Control pole: deliver normalizes accepted: true
  const receipt = await transport.deliver({ id: "out-1" });
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.carrier, "http://127.0.0.1:5087");
  assert.equal(receipt.seq, 42);
  assert.equal(receipt.sha, "abc123sha");

  // Control pole: fetchInbox annotates each item with sourceId
  const batch = await transport.fetchInbox("http://127.0.0.1:5087", { since: 0 });
  assert.equal(batch.sourceId, "http://127.0.0.1:5087");
  assert.equal(batch.envelopes.length, 2);
  assert.equal(batch.envelopes[0].sourceId, "http://127.0.0.1:5087");
  assert.equal(batch.envelopes[0].seq, 10);
  assert.equal(batch.envelopes[1].sourceId, "http://127.0.0.1:5087");
  assert.equal(batch.envelopes[1].seq, 11);

  // Reject unexpected source ID
  await assert.rejects(
    async () => transport.fetchInbox("http://127.0.0.1:9999"),
    (err) => err.code === "UNEXPECTED_SOURCE_ID"
  );

  await transport.close();
});

test("PillarCarrierTransport: injected client obeys forced offline refusal (two-pole)", async () => {
  const remoteCarrier = "https://carrier.remote.test";
  let injectedDeliverCalled = false;
  let injectedFetchCalled = false;

  const fakeInjectedClient = {
    carriers: [remoteCarrier],
    async deliver() {
      injectedDeliverCalled = true;
      return { carrier: remoteCarrier, seq: 1 };
    },
    async fetchInbox() {
      injectedFetchCalled = true;
      return { envelopes: [], now: 1000 };
    }
  };

  // With AGENT_COMMONS_OFFLINE="1", injected client MUST be refused before deliver or fetch
  const guardedTransport = new PillarCarrierTransport({
    client: fakeInjectedClient,
    env: { [OFFLINE_ENV]: "1" }
  });

  await assert.rejects(
    async () => guardedTransport.deliver({ id: "env-1", carrier: remoteCarrier }),
    (err) => err.code === "offline" && err.carrier === remoteCarrier
  );
  assert.equal(injectedDeliverCalled, false, "Injected client deliver must not be called when offline");

  await assert.rejects(
    async () => guardedTransport.fetchInbox(remoteCarrier),
    (err) => err.code === "offline" && err.carrier === remoteCarrier
  );
  assert.equal(injectedFetchCalled, false, "Injected client fetchInbox must not be called when offline");
});

test("PillarCarrierTransport: empty target carrier set fails closed when offline (two-pole R3b)", async () => {
  let clientCalled = false;
  const fakeClientNoCarriers = {
    // No carriers property
    async deliver() {
      clientCalled = true;
      return { seq: 1 };
    }
  };

  const transport = new PillarCarrierTransport({
    client: fakeClientNoCarriers,
    env: { [OFFLINE_ENV]: "1" }
  });

  // Envelope has no carrier field
  await assert.rejects(
    async () => transport.deliver({ id: "env-empty-carrier" }),
    (err) => err.code === "offline" && err.carrier === "unspecified"
  );
  assert.equal(clientCalled, false, "Injected client deliver must not be called when offline with empty carrier set");
});

test("R3c offline unknown injected destination must not be authorized by envelope carrier hint (two-pole)", async () => {
  let called = false;
  const client = {
    async deliver() {
      called = true;
      return { carrier: "https://pillar.uuaid.org", seq: 1, sha: "fixture", duplicate: false };
    }
  };
  const adapter = new PillarCarrierTransport({
    client,
    env: { [OFFLINE_ENV]: "1" }
  });
  let receipt;
  let code = null;
  try {
    receipt = await adapter.deliver({ id: "carrier-hint", carrier: "http://127.0.0.1:5087" });
  } catch (error) {
    code = error.code;
  }
  assert.equal(called, false, "Unknown injected client must not be called under offline mode even with loopback carrier hint");
  assert.equal(code, "offline");
  assert.equal(receipt, undefined);
});

test("PillarCarrierTransport: offline guard refuses non-loopback egress (two-pole)", async () => {
  const remoteCarrier = "https://pillar.uuaid.org";
  const loopbackCarrier = "http://127.0.0.1:5087";

  // Control pole 1: remote carrier refused offline
  const offlineTransport = new PillarCarrierTransport({
    keychain: makeKeychain(),
    carriers: [remoteCarrier],
    env: { [OFFLINE_ENV]: "1" }
  });

  await assert.rejects(
    async () => offlineTransport.deliver({ id: "out-1" }),
    (err) => err.code === "offline" && err.carrier === remoteCarrier
  );

  await assert.rejects(
    async () => offlineTransport.fetchInbox(remoteCarrier),
    (err) => err.code === "offline" && err.carrier === remoteCarrier
  );

  // Control pole 2: loopback carrier is allowed past the offline guard
  let loopbackDeliverCalled = false;
  const fakeLoopbackClient = {
    carriers: [loopbackCarrier],
    _offlineEnv: { [OFFLINE_ENV]: "1" },
    async deliver(env) {
      loopbackDeliverCalled = true;
      return { carrier: loopbackCarrier, seq: 1, sha: "sha", duplicate: false };
    }
  };
  const loopbackTransport = new PillarCarrierTransport({ client: fakeLoopbackClient, env: { [OFFLINE_ENV]: "1" } });
  const loopbackReceipt = await loopbackTransport.deliver({ id: "loopback-1" });
  assert.equal(loopbackReceipt.accepted, true);
  assert.equal(loopbackDeliverCalled, true);

  // Opt-in AGENT_COMMONS_OFFLINE="0" permits remote call past guard
  let remoteDeliverCalled = false;
  const fakeRemoteClient = {
    carriers: [remoteCarrier],
    _offlineEnv: { [OFFLINE_ENV]: "0" },
    async deliver(env) {
      remoteDeliverCalled = true;
      return { carrier: remoteCarrier, seq: 1, sha: "sha", duplicate: false };
    }
  };
  const optInTransport = new PillarCarrierTransport({ client: fakeRemoteClient, env: { [OFFLINE_ENV]: "0" } });
  const optInReceipt = await optInTransport.deliver({ id: "optin-1" });
  assert.equal(optInReceipt.accepted, true);
  assert.equal(remoteDeliverCalled, true);
});

test("TransportCapabilities and DeliveryResult match v4 design contract (two-pole)", () => {
  const loopback = new MemoryLoopbackTransport();
  const caps = loopback.capabilities;

  assert.equal(typeof caps.name, "string");
  assert.equal(typeof caps.canPush, "boolean");
  assert.equal(typeof caps.canPoll, "boolean");
  assert.equal(typeof caps.supportsStreaming, "boolean");
  assert.equal(typeof caps.maxMessageBytes, "number");
  assert.equal(typeof caps.loopbackSafe, "boolean");

  assert.equal(caps.name, "memory");
  assert.equal(caps.canPush, true);
  assert.equal(caps.canPoll, true);
  assert.equal(caps.supportsStreaming, true);
  assert.equal(caps.maxMessageBytes, 64000);
  assert.equal(caps.loopbackSafe, true);

  const pillar = new PillarCarrierTransport({
    keychain: makeKeychain(),
    carriers: ["http://127.0.0.1:5087"]
  });
  const pCaps = pillar.capabilities;
  assert.equal(pCaps.name, "pillar");
  assert.equal(pCaps.canPush, false);
  assert.equal(pCaps.canPoll, true);
  assert.equal(pCaps.supportsStreaming, false);
  assert.equal(pCaps.maxMessageBytes, 512000);
  assert.equal(pCaps.loopbackSafe, false);

  loopback.close();
});
