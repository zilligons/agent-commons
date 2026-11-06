// L2 production start path and consumer entry (-022 Addendum E P1; RT3). The production entrypoint
// (serve.mjs, `agent-commons relay serve`) takes only a canonical https audience and a literal
// loopback bind, has no test flag, and loads the relay key seed and the signed roster and policy from
// owner-only files; the L1 test entrypoint (server.mjs) refuses a production audience. Behind the
// host's reverse proxy the source address is X-Real-IP. The reference client is exported; the server
// is not. Fixture keys only; loopback only.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, symlinkSync, chmodSync, readFileSync, realpathSync, statSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { isProductionAud, checkStart, startRelay, createRelayHandler, StartRefused } from "../src/relay/server.mjs";
import { SERVE_FLAGS, parseServeArgs } from "../src/relay/serve.mjs";
import { CLIENT_VALUE_FLAGS, RelayClient, RelayClientError } from "../src/relay/client.mjs";
import { RELAY_TEST_AUD, RELAY_SIG_HEADER, verifyRelayResponse, signIdentityRequest, IDENTITY_AUTH_HEADER, PRINCIPAL_HEADER } from "../src/relay/auth.mjs";
import { setup, scratch, keySeedHex, decision, ownerConfirm, outboxFor, seatMessage, sendSeatMessage, createDecision, confirmOwnerRecord } from "./relay-fixtures.mjs";
import { startProxy } from "./relay-l2/proxy.mjs";
import { getMeta, setMeta } from "../src/relay/schema.mjs";

const PKG = fileURLToPath(new URL("../", import.meta.url));
const SERVE = fileURLToPath(new URL("../src/relay/serve.mjs", import.meta.url));
const SERVER = fileURLToPath(new URL("../src/relay/server.mjs", import.meta.url));
const BIN = fileURLToPath(new URL("../bin/agent-commons.mjs", import.meta.url));
const AUD = "https://commons.example.org";
const ENV = { ...process.env, AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED: "0" };
const TMP = realpathSync(tmpdir());

test("RT3 / L2: a production aud is one canonical https origin; checkStart refuses a test aud in production and a production aud in test mode", () => {
  for (const aud of [AUD, "https://commons.example.org:8443", "https://localhost:8443", "https://127.0.0.1:8443"]) assert.equal(isProductionAud(aud), true, aud);
  for (const aud of [RELAY_TEST_AUD, "https://commons-relay.test:8080", "https://x.test", "http://commons.example.org", `${AUD}/`, "https://Commons.example.org",
    "https://commons.example.org:443", "https://user@example.org", `${AUD}/v1`, `${AUD}?x`, `${AUD}#x`, "", null, undefined]) assert.equal(isProductionAud(aud), false, String(aud));
  const reasons = (args) => { try { checkStart(args); return []; } catch (e) { assert.ok(e instanceof StartRefused); return e.reasons.map(r => r.split(" ")[0]); } };
  assert.deepEqual(reasons({ aud: AUD, host: "127.0.0.1", mode: "production" }), []);
  assert.deepEqual(reasons({ aud: RELAY_TEST_AUD, host: "127.0.0.1", mode: "production" }), ["aud"], "a test aud in production mode");
  assert.deepEqual(reasons({ aud: AUD, host: "127.0.0.1" }), ["aud"], "a production aud in test mode (the default)");
  assert.deepEqual(reasons({ aud: AUD, host: "0.0.0.0", mode: "production" }), ["bind"]);
  assert.deepEqual(reasons({ aud: AUD, host: "localhost", mode: "production" }), ["bind"]);
  assert.deepEqual(reasons({ aud: AUD, host: "127.0.0.1", testInterface: "eth0", mode: "production" }), ["production"]);
  assert.deepEqual(reasons({ aud: AUD, host: "127.0.0.1", mode: "staging" }), ["unknown"]);
});

test("RT3: production mode never takes a test hook: startRelay with testMode or testDir and createRelayHandler with a barrier are refused", async () => {
  const fx = setup({ members: [] });
  const base = { db: fx.db, aud: AUD, host: "127.0.0.1", port: 0, relayKeySeedHex: "1".repeat(64), mode: "production" };
  await assert.rejects(startRelay({ ...base, testMode: true, testDir: "/nonexistent" }), /production mode takes no test mode/);
  await assert.rejects(startRelay({ ...base, testDir: "/nonexistent" }), /production mode takes no test mode/);
  assert.throws(() => createRelayHandler({ ...base, barrier: async () => {} }), /production mode takes no test hook/);
  assert.throws(() => createRelayHandler({ ...base, aud: RELAY_TEST_AUD }), /canonical https origin/);
  assert.throws(() => createRelayHandler({ ...base, mode: "test" }), /aud must be exactly/);
  // The production flag table has no test flag; neither has the consumer client's.
  for (const flags of [SERVE_FLAGS, CLIENT_VALUE_FLAGS]) assert.deepEqual(flags.filter(f => /test/.test(f)), []);
  assert.throws(() => parseServeArgs(["--test-mode"]), /unknown argument/);
  // The production modules never import the test hooks.
  for (const file of ["src/relay/serve.mjs", "src/relay/cli.mjs"]) {
    const imports = [...readFileSync(join(PKG, file), "utf8").matchAll(/^import .* from "([^"]+)";$/gm)].map(m => m[1]);
    assert.equal(imports.some(i => /test-mode/.test(i)), false, file);
  }
});

/** A fixture deployment: owner-signed roster and policy (0600), a fixture relay key seed (0600). */
function deployment() {
  const fx = setup({ members: [] });
  const { dir } = scratch();
  const file = (name, text, mode = 0o600) => { const p = join(dir, name); writeFileSync(p, text, { mode }); chmodSync(p, mode); return p; };
  const seed = randomBytes(32).toString("hex");
  return { fx, dir, file, seed,
    roster: file("roster.json", JSON.stringify(fx.files.roster)), policy: file("policy.json", JSON.stringify(fx.files.policy)), key: file("relay.key", `${seed}\n`),
    args(over = {}) {
      const o = { "--aud": AUD, "--bind": "127.0.0.1", "--port": "0", "--db": join(dir, "relay-l2.db"), "--roster": this.roster, "--policy": this.policy,
        "--owner-public-key": fx.keys.owner.publicKeyHex, "--relay-key-file": this.key, ...over };
      return Object.entries(o).filter(([, v]) => v !== null).flat();
    } };
}
const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: ENV, timeout: 20000 });

test("RT3 / P1: the production entrypoint exits 2 on every test flag, a test or non-canonical aud, a non-loopback bind, and an owner file that is not 0600, a symlink or malformed", () => {
  const d = deployment();
  const refused = (args, why) => {
    const r = run(SERVE, args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, why);
    assert.equal(r.stdout, "", "never listening");
  };
  refused([...d.args(), "--test-mode"], /unknown argument "--test-mode"/);
  refused([...d.args(), "--test-dir", d.dir], /unknown argument "--test-dir"/);
  refused([...d.args(), "--test-interface", "eth0"], /unknown argument "--test-interface"/);
  refused(d.args({ "--aud": RELAY_TEST_AUD }), /canonical https origin/);
  refused(d.args({ "--aud": "https://commons-relay.test:8080" }), /canonical https origin/);
  refused(d.args({ "--aud": `${AUD}/` }), /canonical https origin/);
  refused(d.args({ "--bind": "0.0.0.0" }), /literal loopback/);
  refused(d.args({ "--relay-key-file": null }), /--relay-key-file is required/);
  refused(d.args({ "--relay-key-file": d.file("loose.key", `${d.seed}\n`, 0o644) }), /no group or other access/);
  refused(d.args({ "--roster": d.file("loose-roster.json", JSON.stringify(d.fx.files.roster), 0o640) }), /--roster must have no group or other access/);
  refused(d.args({ "--policy": d.file("loose-policy.json", JSON.stringify(d.fx.files.policy), 0o604) }), /--policy must have no group or other access/);
  const link = join(d.dir, "link.key");
  symlinkSync(d.key, link);
  refused(d.args({ "--relay-key-file": link }), /not a symlink/);
  refused(d.args({ "--relay-key-file": d.file("two.key", `${d.seed}\n${d.seed}\n`) }), /exactly one 64-hex key seed/);
  refused(d.args({ "--relay-key-file": d.file("upper.key", d.seed.toUpperCase()) }), /exactly one 64-hex key seed/);
  refused(d.args({ "--roster": d.file("plain.json", JSON.stringify(d.fx.files.roster.body)) }), /signed file \{body, sig\}/);
  refused(d.args({ "--roster": d.file("forged.json", JSON.stringify({ ...d.fx.files.roster, sig: "0".repeat(128) })) }), /roster-signature/);
  refused(d.args({ "--owner-public-key": "x" }), /--owner-public-key/);
  // The other direction: the L1 test entrypoint refuses a production aud.
  const t = run(SERVER, ["--aud", AUD, "--bind", "127.0.0.1"]);
  assert.equal(t.status, 2);
  assert.match(t.stderr, /aud must be exactly http:\/\/commons-relay\.test:8080/);
  // And the consumer command routes serve to the production entrypoint.
  const viaBin = run(BIN, ["relay", "serve", ...d.args(), "--test-mode"]);
  assert.equal(viaBin.status, 2);
  assert.match(viaBin.stderr, /unknown argument "--test-mode"/);
});

/** One raw loopback request to a relay or proxy. */
function raw(port, { path = "/v1/status", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("L2: the production relay listens on loopback, signs every response for its https aud, refuses a request with no X-Real-IP, and logs the proxied source", { timeout: 60000 }, async () => {
  const d = deployment();
  const log = join(d.dir, "access.log");
  const child = spawn(process.execPath, [SERVE, ...d.args({ "--access-log": log })], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c; });
  try {
    const first = await new Promise((resolve, reject) => {
      let buf = "";
      child.stdout.on("data", (c) => { buf += c; if (buf.includes("\n")) resolve(JSON.parse(buf.split("\n")[0])); });
      child.on("exit", (code) => reject(new Error(`exited ${code}: ${stderr}`)));
    });
    assert.deepEqual([first.mode, first.aud], ["production", AUD]);
    assert.match(first.listening, /^http:\/\/127\.0\.0\.1:\d+$/);
    const port = Number(first.listening.split(":").at(-1));
    const signedBy = (res, nonce = null) => verifyRelayResponse(first.relay_public_key, { aud: AUD, requestNonce: nonce, status: res.status, body: res.body }, res.headers[RELAY_SIG_HEADER]);
    // Straight to the relay with no proxy header: 400 invalid-source, still relay-signed for the https aud.
    const direct = await raw(port);
    assert.deepEqual([direct.status, direct.body], [400, { error: "invalid-source" }]);
    assert.equal(signedBy(direct), true);
    for (const bad of ["not-an-ip", "", "10.0.0.1, 10.0.0.2"]) assert.equal((await raw(port, { headers: { "x-real-ip": bad } })).body.error, "invalid-source", bad);
    // With the proxy's header: the normal path (an unsigned request is the uniform 401).
    const viaProxy = await raw(port, { headers: { "x-real-ip": "203.0.113.7" } });
    assert.deepEqual([viaProxy.status, viaProxy.body], [401, { error: "unauthorized" }]);
    assert.equal(signedBy(viaProxy), true);
    // A request signed for the L1 test aud is refused (the descriptor is rebuilt with the https aud).
    const seat = d.fx.keys["seat-1"];
    const s = signIdentityRequest({ seedHex: keySeedHex(seat), method: "GET", path: "/v1/fleet/alerts", query: "", audience: RELAY_TEST_AUD });
    const wrong = await raw(port, { path: "/v1/fleet/alerts", headers: { "x-real-ip": "203.0.113.7", [IDENTITY_AUTH_HEADER]: s.header, [PRINCIPAL_HEADER]: s.agent } });
    assert.equal(wrong.status, 401);
    const s2 = signIdentityRequest({ seedHex: keySeedHex(seat), method: "GET", path: "/v1/fleet/alerts", query: "", audience: AUD });
    const right = await raw(port, { path: "/v1/fleet/alerts", headers: { "x-real-ip": "203.0.113.7", [IDENTITY_AUTH_HEADER]: s2.header, [PRINCIPAL_HEADER]: s2.agent } });
    assert.equal(right.status, 200);
    assert.equal(signedBy(right, /nonce=([0-9a-f]+)/.exec(s2.header)[1]), true);
    const lines = readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l));
    assert.deepEqual(lines.map(l => l.ip), [null, null, null, null, "203.0.113.7", "203.0.113.7", "203.0.113.7"]);
    assert.equal(statSync(log).mode & 0o777, 0o600, "the access log is private (umask 077)");
  } finally {
    child.kill("SIGTERM");
    await new Promise(r => child.once("exit", r));
  }
  assert.equal(child.exitCode, 0, stderr);
});

test("L2 end to end in process: the reference client enrolls, heartbeats and reads its inbox through a proxy against a production-mode relay", { timeout: 60000 }, async (tt) => {
  const fx = setup({ members: [] });
  const r = await startRelay({ db: fx.db, aud: AUD, host: "127.0.0.1", port: 0, relayKeySeedHex: randomBytes(32).toString("hex"), mode: "production" });
  tt.after(() => r.close());
  const proxy = await startProxy({ target: { host: "127.0.0.1", port: r.port } });
  tt.after(() => proxy.close());
  const url = `http://127.0.0.1:${proxy.port}`;
  // The lane owner's invite.create over the wire, signed for the https aud.
  const now = Date.now();
  const rec = decision(fx, "seat-1", { cls: "D0", action: "invite.create", subject: "req-l2", at: now, args: { kind: "enroll", member_id: null, intended_display_name: "l2 agent", intended_platform: "reference-client" } });
  const s = signIdentityRequest({ seedHex: keySeedHex(fx.keys["seat-1"]), method: "POST", path: "/v1/fleet/records/invite.create", query: "", body: rec, audience: AUD });
  const inviteRes = await new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(rec));
    const req = request({ host: "127.0.0.1", port: proxy.port, path: "/v1/fleet/records/invite.create", method: "POST", agent: false,
      headers: { "content-type": "application/json", "content-length": bytes.length, [IDENTITY_AUTH_HEADER]: s.header, [PRINCIPAL_HEADER]: s.agent } }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
    });
    req.on("error", reject); req.end(bytes);
  });
  const invite = inviteRes.invite;
  assert.deepEqual(invite.relay, { origin: AUD, public_key: r.publicKey }, "the invite pins the https origin and the relay key");
  const dir = mkdtempSync(join(TMP, "relay-l2-agent-"));
  chmodSync(dir, 0o700);
  const c = new RelayClient({ stateDir: dir, relayUrl: url });
  tt.after(() => c.close());
  // No --relay-url and nothing pinned yet: the client has nowhere to connect and says so.
  const bareDir = mkdtempSync(join(TMP, "relay-l2-bare-"));
  chmodSync(bareDir, 0o700);
  const bare = new RelayClient({ stateDir: bareDir });
  await assert.rejects(bare.exchange({ method: "GET", target: "/v1/status", aud: AUD, relayKey: r.publicKey, nonce: null }), (err) => err instanceof RelayClientError && err.code === "relay-url-unknown");
  bare.close();
  const minted = c.mintKey();
  const e = await c.enroll(invite, { displayName: "l2 agent", platform: "reference-client" });
  assert.deepEqual([e.status, e.agent], ["pending", minted.agent]);
  // Owner line confirmed by seat-3, enroll.confirm by seat-2 (not the invite creator).
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-3", outboxFor(fx.db, e.enrollment_id), Date.now()), Date.now());
  assert.equal(createDecision(fx.db, decision(fx, "seat-2", { cls: "D0", action: "enroll.confirm", subject: e.member_id, args: { owner_line_ref: outboxFor(fx.db, e.enrollment_id).id }, at: Date.now() }), Date.now()).state, "effective");
  assert.deepEqual([(await c.call("GET", "/v1/status")).status, (await c.fetchSeedBundle()).relay.origin], ["active", AUD]);
  sendSeatMessage(fx.db, seatMessage(fx, "seat-1", e.member_id, "hello over L2", "l2-msg-1", Date.now()), Date.now());
  const run1 = await c.runOnce({ handler: () => {} });
  assert.equal(run1.heartbeat.kind, "heartbeat");
  assert.ok(run1.inbox.handled.includes("l2-msg-1"));
  assert.equal(c.handledCounts()["l2-msg-1"], 1);
  // The relay saw the proxy's X-Real-IP for every member request (no shared unknown bucket).
  assert.equal(fx.db.prepare("SELECT count(*) n FROM member_records WHERE member_id = ? AND type = 'heartbeat'").get(e.member_id).n, 1);
});

test("P1 consumer entry: package exports the reference client, seed and auth modules and NOT the server, serve, cli or test hooks", async () => {
  const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(pkg.exports).filter(k => k.startsWith("./relay")), ["./relay/client", "./relay/seed", "./relay/auth"]);
  const targets = JSON.stringify(pkg.exports);
  for (const f of ["server.mjs", "serve.mjs", "cli.mjs", "test-mode.mjs", "governance.mjs", "schema.mjs"]) assert.equal(targets.includes(`/relay/${f}`), false, f);
  assert.equal(readFileSync(join(PKG, "src/index.mjs"), "utf8").includes("relay/"), false, "the default export does not reach the relay");
  const client = await import("@uuaid/agent-commons/relay/client");
  assert.equal(typeof client.RelayClient, "function");
  assert.equal(typeof (await import("@uuaid/agent-commons/relay/seed")).verifySeedBundle, "function");
  assert.equal(typeof (await import("@uuaid/agent-commons/relay/auth")).signIdentityRequest, "function");
  for (const hidden of ["relay/server", "relay/serve", "relay/cli", "relay/test-mode", "src/relay/server.mjs"])
    await assert.rejects(import(`@uuaid/agent-commons/${hidden}`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }, hidden);
});

test("11.3 / L2 source order: a production request refused for its source does no work (no sweep: clock_suspect stays unset, no alert); a valid source runs the sweep", { timeout: 60000 }, async () => {
  // The real production entrypoint, a file-backed database, and a persisted clock high-water mark
  // 30 s AHEAD of now: the first sweep that runs sees the clock 30 s behind it and latches
  // clock_suspect with an alert (board.mjs sweep). Nothing is mocked; both requests come long before
  // the 15 s timer could fire.
  const d = deployment();
  const dbPath = join(d.dir, "relay-l2.db");
  const pre = setup({ path: dbPath, members: [] });
  setMeta(pre.db, "clock_high_water", String(Date.now() + 30000));
  pre.db.close();
  // The deployment's files were signed with another fixture's keys: use this database's own roster and policy.
  writeFileSync(d.roster, JSON.stringify(pre.files.roster), { mode: 0o600 });
  writeFileSync(d.policy, JSON.stringify(pre.files.policy), { mode: 0o600 });
  const child = spawn(process.execPath, [SERVE, ...d.args({ "--db": dbPath, "--owner-public-key": pre.keys.owner.publicKeyHex })], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c; });
  const { DatabaseSync } = await import("node:sqlite");
  const state = () => { const db = new DatabaseSync(dbPath, { readOnly: true }); try { return { clock_suspect: getMeta(db, "clock_suspect"), alerts: db.prepare("SELECT count(*) n FROM alerts").get().n }; } finally { db.close(); } };
  try {
    const first = await new Promise((resolve, reject) => {
      let buf = "";
      child.stdout.on("data", (c) => { buf += c; if (buf.includes("\n")) resolve(JSON.parse(buf.split("\n")[0])); });
      child.on("exit", (code) => reject(new Error(`exited ${code}: ${stderr}`)));
    });
    const port = Number(first.listening.split(":").at(-1));
    const before = state();
    assert.equal(before.clock_suspect, null, "no sweep has run yet");
    // (a) No X-Real-IP: 400 invalid-source, and nothing in the database moved.
    const refused = await raw(port);
    assert.deepEqual([refused.status, refused.body], [400, { error: "invalid-source" }]);
    assert.deepEqual(state(), before, "a request refused for its source does no work: no sweep, no clock latch, no alert");
    // An invalid X-Real-IP is the same refusal, with the same (absent) effect.
    assert.equal((await raw(port, { headers: { "x-real-ip": "not-an-ip" } })).body.error, "invalid-source");
    assert.deepEqual(state(), before);
    // (b) A valid loopback X-Real-IP: the request passes the source check, so the sweep runs and latches the clock.
    const passed = await raw(port, { headers: { "x-real-ip": "127.0.0.1" } });
    assert.deepEqual([passed.status, passed.body], [401, { error: "unauthorized" }], "an unsigned request, refused later in the order");
    const after = state();
    assert.equal(after.clock_suspect, "1", "the sweep ran and saw the clock 30 s behind its high-water mark");
    assert.equal(after.alerts, before.alerts + 1, "one clock.suspect alert");
  } finally {
    child.kill("SIGTERM");
    await new Promise(r => child.once("exit", r));
  }
});
