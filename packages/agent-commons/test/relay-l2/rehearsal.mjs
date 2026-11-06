// L2 consumer rehearsal (-022 Addendum E P1, item 5): npm pack -> npm install <tgz> into an empty
// directory -> the INSTALLED package runs the production-mode relay on loopback behind a local TLS
// proxy (a test CA made here, trusted by the client through NODE_EXTRA_CA_CERTS), and the INSTALLED
// `agent-commons relay` client enrolls by invite, heartbeats and reads its inbox. Fleet principals are
// fixture keys in the harness controller. Loopback only; nothing is published; no real key.
//
//   node test/relay-l2/rehearsal.mjs --commit <sha> --out <record.json>
//
// Exit 0 only if every step passed; the record lists each step with its evidence.

import { execFile, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync, chmodSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { init, Controller } from "../relay-l1/controller.mjs";
import { startProxy } from "./proxy.mjs";
import { verifyExport } from "../../src/relay/signing.mjs";
import { verifyRelayResponse, RELAY_SIG_HEADER } from "../../src/relay/auth.mjs";

const REPO = realpathSync(fileURLToPath(new URL("../../../../", import.meta.url)));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const ENV = { ...process.env, AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED: "0" };
delete ENV.NODE_EXTRA_CA_CERTS;

function exec(file, args, { cwd, env = ENV, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { cwd, env, encoding: "utf8", maxBuffer: 64 << 20 }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}
const lastJson = (r) => { try { return JSON.parse(r.stdout.trim().split("\n").at(-1)); } catch { return { ok: false, error: "no-json", stdout: r.stdout.slice(-400), stderr: r.stderr.slice(-800) }; } };

export async function rehearse({ commit, out }) {
  const record = { v: "commons-relay-l2-consumer-rehearsal/1", commit, host_node: process.version, started_at: new Date().toISOString(), steps: [] };
  const work = realpathSync(mkdtempSync(join(tmpdir(), "relay-l2-rehearsal-")));
  chmodSync(work, 0o700);
  const step = async (name, fn) => {
    try { const detail = await fn(); record.steps.push({ name, ok: true, detail: detail ?? null }); return detail; }
    catch (error) { record.steps.push({ name, ok: false, error: String(error?.stack ?? error).slice(0, 1500) }); throw error; }
  };
  const must = (cond, what) => { if (!cond) throw new Error(what); };
  let relayProc = null, proxy = null;
  try {
    // 1. Pack the package from a git archive of exactly the commit.
    const tgz = await step(commit === "worktree" ? "npm pack from the working tree (dry run, not a record of a commit)" : "npm pack from a git archive of the commit", async () => {
      const src = join(work, "src");
      mkdirSync(src);
      const tar = join(work, "src.tar");
      let pkgDir;
      if (commit === "worktree") { pkgDir = fileURLToPath(new URL("../../", import.meta.url)); writeFileSync(tar, ""); }
      else {
        must((await exec("git", ["-C", REPO, "archive", "--format=tar", "-o", tar, commit, "packages/agent-commons"])).code === 0, "git archive");
        must((await exec("tar", ["-xf", tar, "-C", src])).code === 0, "untar");
        pkgDir = join(src, "packages/agent-commons");
      }
      const packs = join(work, "pack");
      mkdirSync(packs);
      const p = await exec("npm", ["pack", "--json", "--pack-destination", packs], { cwd: pkgDir });
      must(p.code === 0, `npm pack: ${p.stderr.slice(-500)}`);
      const info = JSON.parse(p.stdout)[0];
      const file = join(packs, info.filename);
      record.tarball = { name: info.filename, sha256: sha256(readFileSync(file)), size: info.size, files: info.entryCount, archive_sha256: sha256(readFileSync(tar)),
        relay_files: info.files.filter(f => f.path.startsWith("src/relay/")).map(f => f.path) };
      return file;
    });
    // 2. Install into an empty directory.
    const consumer = join(work, "consumer");
    mkdirSync(consumer);
    await step("npm install <tgz> into an empty directory", async () => {
      const r = await exec("npm", ["install", "--prefer-offline", "--no-audit", "--no-fund", "--ignore-scripts", tgz], { cwd: consumer });
      must(r.code === 0, `npm install: ${r.stderr.slice(-800)}`);
      const ls = JSON.parse((await exec("npm", ["ls", "--json", "--all"], { cwd: consumer })).stdout);
      const pkg = ls.dependencies["@uuaid/agent-commons"];
      record.installed = { version: pkg.version, dependencies: Object.fromEntries(Object.entries(pkg.dependencies ?? {}).map(([k, v]) => [k, v.version])),
        lock_sha256: sha256(readFileSync(join(consumer, "package-lock.json"))) };
      return record.installed;
    });
    const BIN = join(consumer, "node_modules/@uuaid/agent-commons/bin/agent-commons.mjs");
    // 3. The installed package's exports: the client, seed and auth load; the server does not.
    await step("installed exports: relay/client, relay/seed, relay/auth load; relay/server is not exported", async () => {
      const code = `const out = {}; for (const p of ["relay/client", "relay/seed", "relay/auth", "relay/server", "relay/serve"]) { try { out[p] = Object.keys(await import("@uuaid/agent-commons/" + p)).length; } catch (e) { out[p] = e.code; } } console.log(JSON.stringify(out));`;
      const r = await exec(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { cwd: consumer });
      const res = JSON.parse(r.stdout.trim());
      must(res["relay/client"] > 0 && res["relay/seed"] > 0 && res["relay/auth"] > 0, `exports ${r.stdout}`);
      must(res["relay/server"] === "ERR_PACKAGE_PATH_NOT_EXPORTED" && res["relay/serve"] === "ERR_PACKAGE_PATH_NOT_EXPORTED", `hidden ${r.stdout}`);
      return res;
    });
    // 4. A local TLS test CA and a server certificate for localhost / 127.0.0.1 (loopback only).
    const tls = join(work, "tls");
    mkdirSync(tls, { mode: 0o700 });
    const tlsFiles = await step("local TLS test CA and server certificate", async () => {
      const o = (args) => exec("openssl", args, { cwd: tls });
      const ext = join(tls, "srv.ext");
      writeFileSync(ext, "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n");
      for (const args of [
        ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "1", "-subj", "/CN=agent-commons L2 rehearsal test CA",
          "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign"],
        ["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "srv.key", "-out", "srv.csr", "-subj", "/CN=localhost"],
        ["x509", "-req", "-in", "srv.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "srv.pem", "-days", "1", "-extfile", "srv.ext"],
      ]) { const r = await o(args); must(r.code === 0, `openssl ${args[0]}: ${r.stderr.slice(-400)}`); }
      const ca = readFileSync(join(tls, "ca.pem"), "utf8"), cert = readFileSync(join(tls, "srv.pem"), "utf8"), key = readFileSync(join(tls, "srv.key"), "utf8");
      record.tls = { ca_pem_sha256: sha256(ca), server_pem_sha256: sha256(cert), note: "test CA made for this rehearsal, deleted afterwards" };
      return { ca, cert, key, caPath: join(tls, "ca.pem") };
    });
    // 5. Fixture fleet (controller) and a fixture relay key seed, owner-only files.
    const fleetDir = join(work, "fleet");
    mkdirSync(fleetDir, { mode: 0o700 });
    const fleet = init(join(fleetDir, "state"), Date.now());
    const relayKey = join(fleetDir, "relay.key");
    writeFileSync(relayKey, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
    // 6. Ports, the https origin, and the installed production relay.
    const freePort = () => new Promise((resolve) => { const s = require_net().createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
    const proxyPort = await freePort();
    const aud = `https://localhost:${proxyPort}`;
    record.aud = aud;
    const relayDir = join(work, "relay");
    mkdirSync(relayDir, { mode: 0o700 });
    const serveArgs = (over = {}) => Object.entries({ "--aud": aud, "--bind": "127.0.0.1", "--port": "0", "--db": join(relayDir, "relay-l2.db"), "--roster": fleet.roster,
      "--policy": fleet.policy, "--owner-public-key": fleet.owner_public_key, "--relay-key-file": relayKey, "--access-log": join(relayDir, "access.log"), ...over })
      .filter(([, v]) => v !== null).flat();
    await step("installed `relay serve` refusals (RT3): test flags, test aud, non-loopback bind, loose key file; the installed test entrypoint refuses the https aud", async () => {
      const loose = join(fleetDir, "loose.key");
      writeFileSync(loose, readFileSync(relayKey), { mode: 0o644 });
      chmodSync(loose, 0o644);
      const cases = { test_mode: [...serveArgs(), "--test-mode"], test_dir: [...serveArgs(), "--test-dir", relayDir], test_aud: serveArgs({ "--aud": "http://commons-relay.test:8080" }),
        test_host_https: serveArgs({ "--aud": "https://commons-relay.test:8080" }), wildcard_bind: serveArgs({ "--bind": "0.0.0.0" }), loose_key: serveArgs({ "--relay-key-file": loose }) };
      const out = {};
      for (const [k, args] of Object.entries(cases)) {
        const r = await exec(process.execPath, [BIN, "relay", "serve", ...args]);
        out[k] = { exit: r.code, stderr: r.stderr.trim().split("\n").filter(l => !/ExperimentalWarning|trace-warnings/.test(l)).at(-1) };
        must(r.code === 2 && r.stdout === "", `${k}: exit ${r.code}`);
      }
      const t = await exec(process.execPath, [join(consumer, "node_modules/@uuaid/agent-commons/src/relay/server.mjs"), "--aud", aud, "--bind", "127.0.0.1"]);
      out.test_entry_https_aud = { exit: t.code, stderr: t.stderr.trim().split("\n").filter(l => !/ExperimentalWarning|trace-warnings/.test(l)).at(-1) };
      must(t.code === 2, "the test entrypoint took a production aud");
      return out;
    });
    const started = await step("installed `agent-commons relay serve` (production mode) listens on loopback", async () => {
      relayProc = spawn(process.execPath, [BIN, "relay", "serve", ...serveArgs()], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      relayProc.stderr.on("data", (c) => { err += c; });
      const first = await new Promise((resolve, reject) => {
        let buf = "";
        relayProc.stdout.on("data", (c) => { buf += c; if (buf.includes("\n")) resolve(JSON.parse(buf.split("\n")[0])); });
        relayProc.once("exit", (code) => reject(new Error(`relay exited ${code}: ${err}`)));
      });
      must(first.mode === "production" && first.aud === aud && /^http:\/\/127\.0\.0\.1:\d+$/.test(first.listening), JSON.stringify(first));
      record.relay = first;
      return first;
    });
    const relayPort = Number(started.listening.split(":").at(-1));
    // 7. The TLS proxy at the https origin (stand-in for the host's reverse proxy).
    proxy = await startProxy({ target: { host: "127.0.0.1", port: relayPort }, tls: { key: tlsFiles.key, cert: tlsFiles.cert }, port: proxyPort });
    await step("direct loopback request without the proxy's X-Real-IP is refused 400 invalid-source, relay-signed for the https aud", async () => {
      const res = await new Promise((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: relayPort, path: "/v1/status", agent: false }, (r) => {
          const chunks = []; r.on("data", (c) => chunks.push(c)); r.on("end", () => resolve({ status: r.statusCode, headers: r.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
        });
        req.on("error", reject); req.end();
      });
      must(res.status === 400 && res.body.error === "invalid-source", JSON.stringify(res.body));
      must(verifyRelayResponse(started.relay_public_key, { aud, requestNonce: null, status: res.status, body: res.body }, res.headers[RELAY_SIG_HEADER]), "signature");
      return { status: res.status, body: res.body, signed: true };
    });
    const ctl = new Controller({ stateDir: join(fleetDir, "state"), relayUrl: aud, relayPublicKey: started.relay_public_key, clock: Date.now, aud, ca: tlsFiles.ca });
    // 8. The installed client, trusting the test CA through NODE_EXTRA_CA_CERTS; it connects to the pinned origin (no --relay-url).
    const state = join(work, "agent");
    mkdirSync(state, { mode: 0o700 });
    const CLIENT_ENV = { ...ENV, NODE_EXTRA_CA_CERTS: tlsFiles.caPath };
    const client = async (args) => {
      const r = await exec(process.execPath, [BIN, "relay", ...args, "--state", state], { env: CLIENT_ENV });
      const j = lastJson(r);
      if (!j.ok) throw new Error(`relay ${args[0]}: ${JSON.stringify(j)}`);
      return j.result;
    };
    const minted = await step("installed client: relay mint (key seed minted, persisted and read back, mode 0600)", async () => client(["mint"]));
    const invite = await step("seat-1 (lane owner) invite.create over https; the invite pins the https origin and the relay key", async () => {
      const inv = await ctl.op({ op: "invite", kind: "enroll", label: "req-l2-rehearsal", intended_display_name: "rehearsal agent", intended_platform: "reference-client" });
      must(inv.relay.origin === aud && inv.relay.public_key === started.relay_public_key, JSON.stringify(inv.relay));
      const { decision_id, ...delivered } = inv;
      writeFileSync(join(state, "..", "invite.json"), JSON.stringify(delivered), { mode: 0o600 });
      return { origin: inv.relay.origin, public_key: inv.relay.public_key, kind: inv.kind, namespace: inv.namespace };
    });
    const enrolled = await step("installed client: relay enroll (no --relay-url: connects to the invite's https origin); status pending", async () => {
      const e = await client(["enroll", "--invite-file", join(state, "..", "invite.json"), "--display-name", "rehearsal agent", "--platform", "reference-client"]);
      must(e.status === "pending" && e.agent === minted.agent, JSON.stringify(e));
      const st = await client(["status"]);
      must(st.status === "pending", JSON.stringify(st));
      rmSync(join(state, "..", "invite.json"));
      return { enrollment_id: e.enrollment_id, member_id: e.member_id, status: st.status };
    });
    await step("owner line confirmed (seat-3), enroll.confirm by seat-2 (not the invite creator)", async () => {
      const c = await ctl.op({ op: "confirm-enrollment", enrollment_id: enrolled.enrollment_id, by: "seat-2" });
      must(c.state === "effective", JSON.stringify(c));
      return c;
    });
    await step("installed client: status active C0; seed bundle fetched and verified against the pinned key", async () => {
      const st = await client(["status"]);
      must(st.status === "active" && st.role === "C0", JSON.stringify(st));
      const seed = await client(["seed"]);
      must(seed.relay.origin === aud && seed.relay.public_key === started.relay_public_key && seed.member.member_id === enrolled.member_id, "seed bundle");
      return { status: st.status, role: st.role, seed_v: seed.v, expires_in_days: (seed.expires_at - seed.issued_at) / 86400000 };
    });
    const firstRun = await step("installed client: relay run-once heartbeats (accepted) and reads the inbox", async () => {
      const run = await client(["run-once"]);
      must(run.heartbeat?.kind === "heartbeat", JSON.stringify(run.heartbeat));
      return { heartbeat: run.heartbeat.kind, inbox_read: run.inbox.read.length };
    });
    await step("a seat message arrives; the next run reads, handles and acknowledges it once", async () => {
      const m = await ctl.op({ op: "message", member_id: enrolled.member_id, text: "hello from the lane seat over L2", record_id: "l2-rehearsal-msg" });
      const run = await client(["run-once"]);
      must(run.inbox.handled.includes("l2-rehearsal-msg"), JSON.stringify(run.inbox));
      const again = await client(["run-once"]);
      must(again.inbox.handled.length === 0, "handled twice");
      const handled = await client(["handled"]);
      must(handled["l2-rehearsal-msg"] === 1, JSON.stringify(handled));
      return { record_id: m.record_id, handled, second_heartbeat: run.heartbeat?.error ?? run.heartbeat?.kind, first_run: firstRun };
    });
    await step("the relay-signed export verifies offline (all logs, head) against the owner-signed roster and the relay key", async () => {
      const outFile = join(relayDir, "export.json");
      const r = await exec(process.execPath, [join(consumer, "node_modules/@uuaid/agent-commons/src/relay/export-cli.mjs"), "--db", join(relayDir, "relay-l2.db"),
        "--relay-key-file", relayKey, "--aud", aud, "--out", outFile]);
      must(r.code === 0, `export: ${r.stderr.slice(-400)}`);
      const exp = JSON.parse(readFileSync(outFile, "utf8"));
      const roster = await ctl.op({ op: "roster" });
      const v = verifyExport(exp, roster, { relayPublicKey: started.relay_public_key, aud });
      must(v.ok, JSON.stringify(v.problems).slice(0, 500));
      return { logs: Object.fromEntries(exp.head.body.logs.map(l => [l.log, l.count])) };
    });
    await step("access log: every request's source is the proxy's X-Real-IP (127.0.0.1), the direct probe's is null", async () => {
      const lines = readFileSync(join(relayDir, "access.log"), "utf8").trim().split("\n").map(l => JSON.parse(l));
      const ips = [...new Set(lines.map(l => l.ip))];
      must(lines[0].ip === null && lines.slice(1).every(l => l.ip === "127.0.0.1"), JSON.stringify(ips));
      return { requests: lines.length, ips, statuses: [...new Set(lines.map(l => l.status))].sort() };
    });
    record.ok = record.steps.every(s => s.ok);
  } catch (error) {
    record.ok = false;
    record.error = String(error?.message ?? error).slice(0, 1500);
  } finally {
    if (proxy) await proxy.close();
    if (relayProc && relayProc.exitCode === null) { relayProc.kill("SIGTERM"); await new Promise(r => relayProc.once("exit", r)); record.relay_exit = relayProc.exitCode; }
    rmSync(work, { recursive: true, force: true });
    record.scratch_removed = true;
    record.finished_at = new Date().toISOString();
    const text = `${JSON.stringify(record, null, 1)}\n`;
    if (out) writeFileSync(out, text, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ ok: record.ok, steps: record.steps.map(s => [s.name.slice(0, 60), s.ok]), record_sha256: sha256(text) })}\n`);
    process.exitCode = record.ok ? 0 : 1;
  }
  return record;
}

import { createRequire } from "node:module";
const require_net = () => createRequire(import.meta.url)("node:net");

const invoked = (() => { try { return process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (invoked) {
  const o = {};
  for (let i = 2; i < process.argv.length; i += 2) o[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
  await rehearse({ commit: o.commit ?? (await exec("git", ["-C", REPO, "rev-parse", "HEAD"])).stdout.trim(), out: o.out });
}
