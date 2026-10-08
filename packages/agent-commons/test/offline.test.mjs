import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keychain } from "../src/pillar.mjs";
import { REQUIRED_STANDARDS, TrustError } from "../src/trust.mjs";
import { isOffline, OFFLINE_ENV } from "../src/offline.mjs";
import { initialize } from "../src/config.mjs";
import { CarrierClient } from "../src/index.mjs";

const href = process.env.TRUST_MODULE
  ? new URL(process.env.TRUST_MODULE, import.meta.url).href
  : new URL("../src/trust.mjs", import.meta.url).href;
const { RegistryTrust } = await import(href);

function identity() {
  const keychain = new Keychain("unused");
  keychain._identity = Keychain.generate();
  return keychain._identity;
}

function localPolicy(idn) {
  return {
    mode: "local",
    standardPins: Object.fromEntries(REQUIRED_STANDARDS.map((code) => [code, "ab".repeat(32)])),
    agents: {
      [idn.uuaid]: { kind: "agent", publicKey: idn.publicKeyHex, capabilities: ["commons:message"] },
    },
  };
}

function publishedFetch(calls) {
  return async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({
      standards: REQUIRED_STANDARDS.map((code) => ({ code, stage: "published", content_hash: "ab".repeat(32) })),
    }), { status: 200 });
  };
}

test("offline predicate: default on, exact env opt-in, global policy is not a local run", () => {
  assert.equal(isOffline({}), true);
  assert.equal(isOffline({ [OFFLINE_ENV]: "1" }), true);
  assert.equal(isOffline({ [OFFLINE_ENV]: "0" }), false);
  assert.equal(isOffline({ [OFFLINE_ENV]: "true" }), true);
  assert.equal(isOffline({}, { mode: "local" }), true);
  assert.equal(isOffline({}, { mode: "local", offline: true }), true);
  assert.equal(isOffline({}, { mode: "global" }), false);
  assert.equal(isOffline({}, { mode: "global", offline: true }), true);
  assert.equal(isOffline({}, { mode: "local", offline: false }), false);
  assert.equal(isOffline({ [OFFLINE_ENV]: "1" }, { mode: "global", offline: false }), true);
  assert.equal(isOffline({ [OFFLINE_ENV]: "0" }, { offline: true }), false);
});

test("local policy does not fetch standards, pins, or authorize", async () => {
  const idn = identity();
  const calls = [];
  const trust = new RegistryTrust({ policy: localPolicy(idn), fetchImpl: publishedFetch(calls), env: {} });
  assert.equal(calls.length, 0, "constructor fetched");
  const admitted = await trust.authorize(idn.uuaid, idn.publicKeyHex);
  assert.equal(admitted.tier, "local-policy-pinned");
  assert.equal(calls.length, 0, "authorize fetched");
  let standardsError = null;
  try { await trust.standards(); } catch (error) { standardsError = error; }
  assert.equal(calls.length, 0, "standards fetched");
  assert.equal(standardsError?.code, "OFFLINE");
  let pinError = null;
  try { await trust.publishedProfilePin("IAASO-1001", "ab".repeat(32)); } catch (error) { pinError = error; }
  assert.equal(calls.length, 0, "publishedProfilePin fetched");
  assert.equal(pinError?.code, "OFFLINE");
});

test("global policy still fetches through the stub unless offline is forced", async () => {
  const idn = identity();
  const policy = { ...localPolicy(idn), mode: "global" };
  policy.agents[idn.uuaid] = { ...policy.agents[idn.uuaid], credentialId: "credential-test" };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/v1/standards")) {
      return new Response(JSON.stringify({
        standards: REQUIRED_STANDARDS.map((code) => ({ code, stage: "published", content_hash: "ab".repeat(32) })),
      }), { status: 200 });
    }
    if (String(url).includes("/resolve/")) return new Response(JSON.stringify({ agent: { uuaid: idn.uuaid, status: "active" } }), { status: 200 });
    return new Response(JSON.stringify({ credential_id: "credential-test", agent_uuaid: idn.uuaid, valid: true, signatureValid: true, active: true, notExpired: true }), { status: 200 });
  };
  const open = new RegistryTrust({ policy, fetchImpl, env: {} });
  assert.equal((await open.authorize(idn.uuaid, idn.publicKeyHex)).tier, "registry-credential-and-policy");
  assert.ok(calls.length > 0);
  const blockedCalls = [];
  const blocked = new RegistryTrust({ policy, fetchImpl: publishedFetch(blockedCalls), env: { [OFFLINE_ENV]: "1" } });
  await assert.rejects(blocked.authorize(idn.uuaid, idn.publicKeyHex), (error) => error instanceof TrustError && error.code === "OFFLINE");
  assert.equal(blockedCalls.length, 0);
});

test("init writes offline:true and does not call the registry", () => {
  const home = mkdtempSync(join(tmpdir(), "ac-offline-"));
  try {
    const created = initialize({ home, target: "local" });
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    assert.equal(config.policy.mode, "local");
    assert.equal(config.policy.offline, true);
    assert.deepEqual(config.carriers, []);
    assert.equal(created.registryRegistration, "not-performed");
    assert.equal(created.certified, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("carrier client refuses pillar egress and still allows loopback", async () => {
  const keychain = {
    _identity: {
      uuaid: "uuaid:foundation:agent:01234567-89ab-4cde-8fab-0123456789ab",
      publicKeyHex: "ab".repeat(32),
    },
    sign: () => Buffer.alloc(64),
  };
  const previous = globalThis.fetch;
  const remoteCalls = [];
  globalThis.fetch = async (url, init) => {
    remoteCalls.push(String(url));
    return previous(url, init);
  };
  try {
    const remote = new CarrierClient({ keychain, carriers: ["https://pillar.uuaid.org"], env: {} });
    await assert.rejects(remote.deliver({ id: "local-only" }), (error) => error.code === "offline");
    await assert.rejects(remote.fetchInbox("https://pillar.uuaid.org"), (error) => error.code === "offline");
    assert.equal(remoteCalls.length, 0);
  } finally {
    globalThis.fetch = previous;
  }
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const local = new CarrierClient({ keychain, carriers: [`http://127.0.0.1:${port}`], env: {} });
    await assert.rejects(local.deliver({ id: "loopback" }));
    assert.equal(hits.length, 1);
    assert.match(hits[0], /^\/v1\/envelopes/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
