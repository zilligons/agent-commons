// New Agent Commons identities are minted as uuaid:agentnet:agent:<key-derived id>
// (namespace alignment program, rule 3). Existing identities keep their ids.
// Every verifier accepts a key-derived id only in foundation, pillar or agentnet,
// and only when its local id is the key's (rule 1).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AgentCommons, CommonsCarrier, CommonsStore, CarrierClient, Keychain, RegistryTrust, createProfile, signDocument, verifyDocument, contribution, ContinuityMemory, verifyContinuity, seal } from "../src/index.mjs";
import { verifyGovernanceDocument } from "../src/governance.mjs";
import { REQUIRED_STANDARDS } from "../src/trust.mjs";
import { SELF_CERTIFYING_NAMESPACES as VENDORED_NAMESPACES, mintNamespace as vendoredMintNamespace } from "../src/vendor/pillar/identity/keychain.mjs";
import { CAPABILITIES, initialize, loadRuntime, saveConfig } from "../src/config.mjs";
import { RUNTIME_UUAID_NAMESPACE, SELF_CERTIFYING_NAMESPACES, SELF_CERTIFYING_AGENT_UUAID, keyBindsAgentUuaid, keyIsBlocked, mintNamespace } from "../src/uuaid-namespace.mjs";

const keyDerived = (namespace, publicKeyHex) => `uuaid:${namespace}:agent:${Keychain.localIdFromKey(Buffer.from(publicKeyHex, "hex"))}`;
function keychain(options) { const k = new Keychain("unused"); k._identity = Keychain.generate(options); return k; }

test("a new runtime mints a key-derived agentnet UUAID and keeps it across reloads", () => {
  assert.equal(RUNTIME_UUAID_NAMESPACE, "agentnet");
  const home = mkdtempSync(join(tmpdir(), "ac-ns-"));
  try {
    const { identity } = initialize({ home, target: "agentnet.chat" });
    assert.equal(identity.uuaid, keyDerived("agentnet", identity.publicKeyHex));
    assert.equal(JSON.parse(readFileSync(join(home, "identity.json"), "utf8")).uuaid, identity.uuaid);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).policy.agents), [identity.uuaid]);
    for (let boot = 0; boot < 2; boot++) {
      const loaded = loadRuntime(home);
      try { assert.equal(loaded.runtime.status().uuaid, identity.uuaid); } finally { loaded.store.close(); }
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a home whose identity was minted in foundation keeps that UUAID", () => {
  const home = mkdtempSync(join(tmpdir(), "ac-ns-"));
  try {
    initialize({ home });
    // Put the home in the state initialize() left it in before this change.
    const legacy = Keychain.generate();
    assert.equal(legacy.uuaid, keyDerived("foundation", legacy.publicKeyHex));
    rmSync(join(home, "identity.json"));
    new Keychain(join(home, "identity.json")).save(legacy, { passphrase: readFileSync(join(home, "local-secret"), "utf8") });
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    const [entry] = Object.values(config.policy.agents);
    config.policy.agents = { [legacy.uuaid]: { ...entry, publicKey: legacy.publicKeyHex } };
    saveConfig(home, config);
    const loaded = loadRuntime(home);
    try { assert.equal(loaded.runtime.status().uuaid, legacy.uuaid); } finally { loaded.store.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("agentnet runtimes and an existing foundation peer message, sign and govern together", async () => {
  const keys = [keychain({ uuaidNamespace: RUNTIME_UUAID_NAMESPACE }), keychain({ uuaidNamespace: RUNTIME_UUAID_NAMESPACE }), keychain()];
  assert.deepEqual(keys.map(k => k._identity.uuaid.split(":")[1]), ["agentnet", "agentnet", "foundation"]);
  const policy = { mode: "local", agents: Object.fromEntries(keys.map(k => [k._identity.uuaid, { kind: "agent", publicKey: k._identity.publicKeyHex, capabilities: CAPABILITIES }])) };
  const [a, b, c] = keys.map(k => new AgentCommons({ keychain: k, policy }));
  const profile = createProfile({ namespace: "test/fleet", name: "Fixture profile", fixtures: ["Require semantic equivalence and semantic equivalence.", "Preserve semantic equivalence before accepting a profile."] });
  [a, b, c].forEach(r => r.addProfile(profile));

  const store = new CommonsStore(), carrier = new CommonsCarrier({ store, trust: new RegistryTrust({ policy }) }), address = await carrier.listen();
  try {
    const url = `http://127.0.0.1:${address.port}`;
    for (const [from, to, sender, reader] of [[a, b, keys[0], keys[1]], [a, c, keys[0], keys[2]], [c, a, keys[2], keys[0]]]) {
      const body = `from ${from.uuaid.split(":")[1]} to ${to.uuaid.split(":")[1]}`;
      const sent = await from.send({ recipient: to.uuaid, profileId: profile.id, body });
      assert.equal((await new CarrierClient({ keychain: sender, carriers: [url] }).deliver(sent.envelope)).duplicate, false);
      const fetched = await new CarrierClient({ keychain: reader, carriers: [url] }).fetchInbox(url, { waitS: 0 });
      assert.equal((await to.receive(fetched.envelopes.at(-1).envelope)).body, body);
    }
    assert.equal(store.verify(), true);
  } finally { await carrier.close(); store.close(); }

  const document = signDocument(keys[0], "profile-contribution", { contribution: contribution(profile) });
  assert.equal(verifyDocument(document).issuer, keys[0]._identity.uuaid);
  const proposal = await a.propose(profile.id, "semantic equivalence");
  assert.equal((await b.apply(proposal)).status, "pending");
  assert.equal((await a.apply(await b.vote(proposal.payload.proposal.id, true, "Measured and reversible"))).status, "pending");
  assert.equal((await a.apply(await c.vote(proposal.payload.proposal.id, true, "Independent lossless check"))).status, "adopted");
  assert.equal(a.store.verify(), true);
});

// A mint site is Keychain.generate(...) reached any way: directly, through
// Keychain["generate"], an alias (`const K = Keychain`, `import { Keychain as K }`)
// or a destructured, possibly renamed, `generate`. Each must mint through
// mintNamespace(RUNTIME_UUAID_NAMESPACE): one source for the value, and a check
// that throws outside the self-certifying set. A literal (even "agentnet") or the
// bare constant is refused.
function mintOffenses(text) {
  const offenders = [];
  let sites = 0;
  if (/uuaid:foundation:/.test(text)) offenders.push("hard-coded uuaid:foundation:");
  const names = new Set(["Keychain"]);
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*Keychain\b(?!\s*[.[])/g)) names.add(m[1]);
  for (const m of text.matchAll(/\bKeychain\s+as\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  const generators = new Set();
  for (const m of text.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*([A-Za-z_$][\w$]*)/g)) {
    if (!names.has(m[2])) continue;
    for (const g of m[1].matchAll(/\bgenerate\b(?:\s*:\s*([A-Za-z_$][\w$]*))?/g)) generators.add(g[1] ?? "generate");
  }
  const calls = [];
  for (const name of names) calls.push(...text.matchAll(new RegExp(`(?<![\\w$])${name}\\s*(?:\\.\\s*generate|\\[\\s*["'\`]generate["'\`]\\s*\\])\\s*\\(([^)]*)\\)`, "g")));
  for (const g of generators) calls.push(...text.matchAll(new RegExp(`(?<![\\w$.])${g}\\s*\\(([^)]*)\\)`, "g")));
  for (const call of calls) {
    sites++;
    if (!/uuaidNamespace\s*:\s*mintNamespace\(\s*RUNTIME_UUAID_NAMESPACE\b/.test(call[1])) offenders.push(`${call[0].slice(0, 60)} does not mint through mintNamespace(RUNTIME_UUAID_NAMESPACE)`);
  }
  return { offenders, sites };
}

test("the mint-site guard catches every way to reach generate and a literal namespace", () => {
  for (const text of [
    "const k = Keychain.generate();",
    "const K = Keychain; const k = K.generate();",
    "const { generate } = Keychain; const k = generate();",
    "const { generate: g } = Keychain; const k = g();",
    'import { Keychain as KC } from "./pillar.mjs"; const k = KC.generate();',
    'const k = Keychain["generate"]();',
    'const k = Keychain.generate({ uuaidNamespace: "agentnet" });',
    "const k = Keychain.generate({ uuaidNamespace: RUNTIME_UUAID_NAMESPACE });",
    'const uuaid = "uuaid:foundation:agent:x";',
  ]) assert.notDeepEqual(mintOffenses(text).offenders, [], text);
  for (const text of [
    "const k = Keychain.generate({ uuaidNamespace: mintNamespace(RUNTIME_UUAID_NAMESPACE) });",
    "const K = Keychain; const k = K.generate({ uuaidNamespace: mintNamespace(RUNTIME_UUAID_NAMESPACE) });",
    'import { Keychain as KC } from "./pillar.mjs"; const k = KC["generate"]({ uuaidNamespace: mintNamespace(RUNTIME_UUAID_NAMESPACE) });',
    "const { generate: g } = Keychain; const k = g({ uuaidNamespace: mintNamespace(RUNTIME_UUAID_NAMESPACE) });",
  ]) {
    const { offenders, sites } = mintOffenses(text);
    assert.deepEqual(offenders, [], text);
    assert.equal(sites, 1, text);
  }
});

test("every Agent Commons mint site passes the namespace explicitly (vendored code excluded)", () => {
  const pkg = new URL("../", import.meta.url);
  const offenders = [];
  let sites = 0;
  for (const root of ["src/", "bin/", "examples/"]) {
    let entries;
    try { entries = readdirSync(new URL(root, pkg), { recursive: true }); } catch { continue; }
    for (const file of entries.filter(f => /\.m?js$/.test(f) && !f.startsWith("vendor"))) {
      const scanned = mintOffenses(readFileSync(new URL(file, new URL(root, pkg)), "utf8"));
      sites += scanned.sites;
      offenders.push(...scanned.offenders.map(o => `${root}${file}: ${o}`));
    }
  }
  assert.deepEqual(offenders, []);
  assert.ok(sites >= 1, "the guard found no mint site, so it is not reading the source");
});

test("the accepted namespaces are the vendored @uuaid/pillar set, and Agent Commons mints inside it", () => {
  assert.equal(SELF_CERTIFYING_NAMESPACES, VENDORED_NAMESPACES);
  assert.deepEqual([...SELF_CERTIFYING_NAMESPACES], ["foundation", "pillar", "agentnet"]);
  assert.ok(SELF_CERTIFYING_NAMESPACES.includes(RUNTIME_UUAID_NAMESPACE));
});

// The same key and private key under another UUAID spelling.
function spelled(k, uuaid) { const c = new Keychain("unused"); c._identity = { ...k._identity, uuaid }; return c; }
const isCode = code => error => error.code === code;

// Every place Agent Commons accepts an identity on the strength of its key.
// Each entry: run(keychain), the refusal for a namespace a key cannot claim, and
// the refusal for an accepted namespace whose local id is another key's.
const VERIFIERS = {
  "trust.authorize (carrier relay and inbox reads go through it)": {
    run: async k => {
      const { uuaid, publicKeyHex } = k._identity;
      const policy = { mode: "local", agents: { [uuaid]: { kind: "agent", publicKey: publicKeyHex, capabilities: ["commons:message"] } } };
      return new RegistryTrust({ policy }).authorize(uuaid, publicKeyHex);
    },
    namespace: isCode("AGENT_ONLY"), binding: isCode("KEY_BINDING"),
  },
  "profiles verifyDocument": {
    run: async k => verifyDocument(signDocument(k, "profile-vote", { proposalId: "rule-1", approve: true, rationale: "namespace set" })),
    namespace: /Invalid agent document/, binding: /not bound to UUAID/,
  },
  "governance verifyGovernanceDocument": {
    run: async k => verifyGovernanceDocument(signDocument(k, "governance-proposal", { proposal: "namespace set" })),
    namespace: isCode("INVALID_DOCUMENT"), binding: isCode("INVALID_SIGNATURE"),
  },
  "ContinuityMemory owner": {
    run: async k => new ContinuityMemory({ keychain: k }),
    namespace: error => error.code === "IDENTITY_REQUIRED" && /bound agent UUAID is required/.test(error.message),
    binding: error => error.code === "IDENTITY_REQUIRED" && /not bound to its UUAID/.test(error.message),
  },
  "verifyContinuity owner": {
    run: async k => {
      // A real chain signed by this key, then presented under the spelling being tested.
      const { publicKeyHex, uuaid } = k._identity;
      const memory = new ContinuityMemory({ keychain: spelled(k, `uuaid:foundation:agent:${Keychain.localIdFromKey(Buffer.from(publicKeyHex, "hex"))}`) });
      memory.remember("note", "namespace set");
      return verifyContinuity({ ...memory.snapshot(), uuaid }, { uuaid, publicKey: publicKeyHex });
    },
    // IDENTITY_MISMATCH is shared with the state/owner check; the message pins the owner-binding gate.
    namespace: error => error.code === "IDENTITY_MISMATCH" && /not bound to owner UUAID/.test(error.message),
    binding: error => error.code === "IDENTITY_MISMATCH" && /not bound to owner UUAID/.test(error.message),
  },
  "keyBindsAgentUuaid (agent-commons admit)": {
    run: async k => { if (!keyBindsAgentUuaid(k._identity.uuaid, k._identity.publicKeyHex)) throw new Error("refused"); },
    namespace: /refused/, binding: /refused/,
  },
};

for (const [name, verifier] of Object.entries(VERIFIERS)) {
  test(`rule 1 at ${name}: foundation, pillar and agentnet pass; registry namespaces, non-agent types and another key's id are refused`, async () => {
    const k = keychain(), other = keychain();
    const local = Keychain.localIdFromKey(Buffer.from(k._identity.publicKeyHex, "hex"));
    const otherLocal = Keychain.localIdFromKey(Buffer.from(other._identity.publicKeyHex, "hex"));
    for (const namespace of ["foundation", "pillar", "agentnet"])
      await verifier.run(spelled(k, `uuaid:${namespace}:agent:${local}`));
    for (const namespace of ["zilligon", "iaaso", "other", "local"])
      await assert.rejects(verifier.run(spelled(k, `uuaid:${namespace}:agent:${local}`)), verifier.namespace, `${name} accepted ${namespace}`);
    for (const objectType of ["service", "human"])
      await assert.rejects(verifier.run(spelled(k, `uuaid:agentnet:${objectType}:${local}`)), verifier.namespace, `${name} accepted object type ${objectType}`);
    await assert.rejects(verifier.run(spelled(k, `uuaid:agentnet:agent:${otherLocal}`)), verifier.binding, `${name} accepted another key's id`);
  });
}

// A provenance actor is a label the owner signs over, not an identity accepted on
// its key, so it may name a registry-namespace agent. The ledger owner may not.
test("a continuity entry may name a registry-namespace actor; the owner must still be key-derived", () => {
  const k = keychain({ uuaidNamespace: "agentnet" });
  const memory = new ContinuityMemory({ keychain: k });
  memory.remember("note", "relayed by a registry agent", { source: "peer", actor: "uuaid:zilligon:agent:00000000-0000-4000-8000-000000000000" });
  const owner = { uuaid: k._identity.uuaid, publicKey: k._identity.publicKeyHex };
  assert.equal(verifyContinuity(memory.snapshot(), owner).entries.at(-1).provenance.actor, "uuaid:zilligon:agent:00000000-0000-4000-8000-000000000000");
});

test("agent-commons admit refuses a registry namespace and another key's id, and admits an agentnet peer", () => {
  const bin = join(dirname(fileURLToPath(import.meta.url)), "../bin/agent-commons.mjs");
  const home = mkdtempSync(join(tmpdir(), "ac-admit-"));
  const env = { ...process.env };
  delete env.AGENT_COMMONS_PASSPHRASE;
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args, "--home", home], { env, encoding: "utf8" });
  try {
    assert.equal(cli("init").status, 0);
    const peer = keychain({ uuaidNamespace: "agentnet" })._identity, other = keychain()._identity;
    const local = Keychain.localIdFromKey(Buffer.from(peer.publicKeyHex, "hex"));
    for (const uuaid of [`uuaid:zilligon:agent:${local}`, `uuaid:agentnet:agent:${Keychain.localIdFromKey(Buffer.from(other.publicKeyHex, "hex"))}`]) {
      const refused = cli("admit", "--uuaid", uuaid, "--public-key", peer.publicKeyHex);
      assert.equal(refused.status, 1, uuaid);
      assert.match(refused.stderr, /foundation, pillar or agentnet/);
    }
    const admitted = cli("admit", "--uuaid", peer.uuaid, "--public-key", peer.publicKeyHex);
    assert.equal(admitted.status, 0, admitted.stderr);
    const agents = JSON.parse(readFileSync(join(home, "config.json"), "utf8")).policy.agents;
    assert.deepEqual(Object.keys(agents).filter(id => id !== loadRuntimeIdentity(home)), [peer.uuaid]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
function loadRuntimeIdentity(home) { return JSON.parse(readFileSync(join(home, "identity.json"), "utf8")).uuaid; }

test("mint sites go through the vendored mintNamespace, which refuses a namespace a key cannot claim", () => {
  assert.equal(mintNamespace, vendoredMintNamespace);
  assert.equal(mintNamespace(RUNTIME_UUAID_NAMESPACE), "agentnet");
  for (const namespace of ["zilligon", "iaaso", "local", ""]) assert.throws(() => mintNamespace(namespace), /namespace must be one of/, namespace);
});

test("a key-derived agent UUAID has the canonical lower-case 8-4-4-4-12 local id", async () => {
  const k = keychain();
  const local = Keychain.localIdFromKey(Buffer.from(k._identity.publicKeyHex, "hex"));
  assert.ok(SELF_CERTIFYING_AGENT_UUAID.test(`uuaid:agentnet:agent:${local}`));
  for (const bad of ["-".repeat(36), local.toUpperCase(), local.replaceAll("-", "").padEnd(36, "0"), `${local.slice(0, 8)}${local.slice(9)}-`]) {
    assert.equal(SELF_CERTIFYING_AGENT_UUAID.test(`uuaid:agentnet:agent:${bad}`), false, bad);
    const policy = { mode: "local", agents: { [`uuaid:agentnet:agent:${bad}`]: { kind: "agent", publicKey: k._identity.publicKeyHex, capabilities: ["commons:message"] } } };
    await assert.rejects(new RegistryTrust({ policy }).authorize(`uuaid:agentnet:agent:${bad}`, k._identity.publicKeyHex), error => error.code === "AGENT_ONLY", bad);
  }
});

// One key has a spelling in each self-certifying namespace. A block on any of
// them blocks the key; the trust gate must not be routed around by re-spelling.
test("a block on any spelling of a key blocks every spelling at trust.authorize", async () => {
  const namespaces = ["foundation", "pillar", "agentnet"];
  const k = keychain(), other = keychain();
  const local = Keychain.localIdFromKey(Buffer.from(k._identity.publicKeyHex, "hex"));
  const otherLocal = Keychain.localIdFromKey(Buffer.from(other._identity.publicKeyHex, "hex"));
  const admit = uuaid => ({ [uuaid]: { kind: "agent", publicKey: k._identity.publicKeyHex, capabilities: ["commons:message"] } });
  for (const blockedNs of namespaces) for (const presentedNs of namespaces) {
    const presented = `uuaid:${presentedNs}:agent:${local}`;
    const policy = { mode: "local", agents: admit(presented), blocked: [`uuaid:${blockedNs}:agent:${local}`] };
    await assert.rejects(new RegistryTrust({ policy }).authorize(presented, k._identity.publicKeyHex), error => error.code === "SUBJECT_BLOCKED", `${blockedNs} block let ${presentedNs} through`);
  }
  const presented = `uuaid:agentnet:agent:${local}`;
  for (const blocked of [[`uuaid:agentnet:agent:${otherLocal}`], [`uuaid:zilligon:agent:${local}`], [], undefined]) {
    const result = await new RegistryTrust({ policy: { mode: "local", agents: admit(presented), blocked } }).authorize(presented, k._identity.publicKeyHex);
    assert.equal(result.uuaid, presented, `blocked ${JSON.stringify(blocked)} wrongly blocked the key`);
  }
  assert.equal(keyIsBlocked([`uuaid:pillar:agent:${local}`], `uuaid:foundation:agent:${local}`), true);
  assert.equal(keyIsBlocked(["uuaid:zilligon:agent:x"], "uuaid:zilligon:agent:x"), true, "a non-key-derived entry still blocks itself");
});

test("agent-commons admit refuses a key that is blocked under another spelling", () => {
  const bin = join(dirname(fileURLToPath(import.meta.url)), "../bin/agent-commons.mjs");
  const home = mkdtempSync(join(tmpdir(), "ac-admit-blocked-"));
  const env = { ...process.env };
  delete env.AGENT_COMMONS_PASSPHRASE;
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args, "--home", home], { env, encoding: "utf8" });
  try {
    assert.equal(cli("init").status, 0);
    const peer = keychain({ uuaidNamespace: "agentnet" })._identity, other = keychain({ uuaidNamespace: "agentnet" })._identity;
    const local = Keychain.localIdFromKey(Buffer.from(peer.publicKeyHex, "hex"));
    const configPath = join(home, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.policy.blocked = [`uuaid:foundation:agent:${local}`];
    saveConfig(home, config);
    const refused = cli("admit", "--uuaid", peer.uuaid, "--public-key", peer.publicKeyHex);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /blocked under another spelling/);
    assert.equal(cli("admit", "--uuaid", other.uuaid, "--public-key", other.publicKeyHex).status, 0);
    const agents = JSON.parse(readFileSync(configPath, "utf8")).policy.agents;
    assert.equal(agents[peer.uuaid], undefined);
    assert.ok(agents[other.uuaid]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// A long-poll inbox read is admitted at its start and may wait up to 25 s. A key
// blocked (here under another spelling) during that wait must not be handed mail
// that arrives afterwards: it gets the same refusal a fresh request gets.
test("a key blocked during an admitted long poll is refused the mail that arrives after the block", async () => {
  const reader = keychain({ uuaidNamespace: "agentnet" }), sender = keychain();
  const bind = k => ({ kind: "agent", publicKey: k._identity.publicKeyHex, capabilities: ["commons:message", "commons:relay"] });
  const local = Keychain.localIdFromKey(Buffer.from(reader._identity.publicKeyHex, "hex"));
  const inbox = (url, wait = 0) => {
    const ts = String(Date.now()), id = reader._identity.uuaid;
    const sig = reader.sign(Buffer.from(`GET /v1/inbox/${id}?since=0\n${ts}`)).toString("hex");
    return fetch(`${url}/v1/inbox/${encodeURIComponent(id)}?since=0&wait=${wait}`, { headers: { "x-pillar-pubkey": reader._identity.publicKeyHex, "x-pillar-ts": ts, "x-pillar-sig": sig } });
  };
  for (const blockDuringWait of [false, true]) {
    const policy = { mode: "local", agents: { [reader._identity.uuaid]: bind(reader), [sender._identity.uuaid]: bind(sender) }, blocked: [] };
    const store = new CommonsStore(), carrier = new CommonsCarrier({ store, trust: new RegistryTrust({ policy }) });
    try {
      const { port } = await carrier.listen(), url = `http://127.0.0.1:${port}`;
      const pending = inbox(url, 5);
      for (let i = 0; i < 200 && !carrier.waiters.has(reader._identity.uuaid); i++) await new Promise(r => setTimeout(r, 5));
      assert.ok(carrier.waiters.has(reader._identity.uuaid), "the poll was admitted and is waiting");
      if (blockDuringWait) {
        policy.blocked.push(`uuaid:foundation:agent:${local}`);
        const fresh = await inbox(url);
        assert.equal(fresh.status, 403);
        assert.equal((await fresh.json()).reason, "SUBJECT_BLOCKED");
      }
      const envelope = seal(sender, { recipient: reader._identity.uuaid, recipientPublicKey: reader._identity.publicKeyHex, kind: "agent-commons/1", payload: { body: "arrived during the wait" } });
      assert.equal((await fetch(`${url}/v1/envelopes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) })).status, 202);
      const response = await pending, body = await response.json();
      if (blockDuringWait) {
        assert.equal(response.status, 403, "the blocked reader's pending poll is refused");
        assert.equal(body.reason, "SUBJECT_BLOCKED");
        assert.equal(body.envelopes, undefined, "no mail is handed over");
      } else {
        assert.equal(response.status, 200);
        assert.deepEqual(body.envelopes.map(e => e.envelope.id), [envelope.id], "control: the unblocked poll gets the new mail");
      }
    } finally { await carrier.close(); store.close(); }
  }
});

// Global admission awaits the registry (standards, resolve, verify). The operator's
// policy can change during those awaits; the decision must reflect the policy as
// it is when admission returns, for the credential the registry verified.
test("global admission re-checks the local policy after the registry calls return", async () => {
  const k = keychain({ uuaidNamespace: "agentnet" });
  const { uuaid, publicKeyHex } = k._identity;
  const local = uuaid.split(":")[3];
  const pins = Object.fromEntries(REQUIRED_STANDARDS.map(code => [code, "a".repeat(64)]));
  const cases = {
    "no change": { mutate: () => {}, expect: null },
    "blocked under another spelling": { mutate: p => p.blocked.push(`uuaid:foundation:agent:${local}`), expect: "SUBJECT_BLOCKED" },
    "binding removed": { mutate: p => { delete p.agents[uuaid]; }, expect: "NOT_ADMITTED" },
    "capability narrowed": { mutate: p => { p.agents[uuaid] = { ...p.agents[uuaid], capabilities: [] }; }, expect: "NOT_ADMITTED" },
    "credential replaced": { mutate: p => { p.agents[uuaid] = { ...p.agents[uuaid], credentialId: "credential-2" }; }, expect: "NOT_ADMITTED" },
    "receiver permanently denied": { mutate: (p, t) => t.denyPermanently(), expect: "NOT_ADMITTED" },
  };
  for (const [name, { mutate, expect }] of Object.entries(cases)) {
    for (const pauseAt of ["standards", "resolve", "verify"]) {
      const policy = { mode: "global", offline: false, standardPins: pins, blocked: [],
        agents: { [uuaid]: { kind: "agent", publicKey: publicKeyHex, capabilities: ["commons:message"], credentialId: "credential-1" } } };
      const reached = Promise.withResolvers(), release = Promise.withResolvers();
      const pause = async stage => { if (stage === pauseAt) { reached.resolve(); await release.promise; } };
      const trust = new RegistryTrust({ policy, env: {},
        fetchImpl: async () => { await pause("standards"); return { ok: true, json: async () => ({ standards: REQUIRED_STANDARDS.map(code => ({ code, stage: "published", content_hash: pins[code] })) }) }; },
        client: {
          resolve: async id => { await pause("resolve"); return { uuaid: id, status: "active" }; },
          verify: async credentialId => { await pause("verify"); return { credential_id: credentialId, agent_uuaid: uuaid, valid: true, signatureValid: true, active: true, notExpired: true }; },
        } });
      const pending = trust.authorize(uuaid, publicKeyHex);
      await reached.promise;
      mutate(policy, trust);
      release.resolve();
      if (expect) await assert.rejects(pending, error => error.code === expect, `${name} during ${pauseAt}`);
      else assert.equal((await pending).tier, "registry-credential-and-policy", `${name} during ${pauseAt}`);
    }
  }
});
