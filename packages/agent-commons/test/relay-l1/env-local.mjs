// L1 acceptance harness: the LOCAL backend (NON-COUNTING). Runs the relay (with the egress sensor),
// the fleet controller, agents A and B (the reference client CLI) and the verification lane as
// separate processes on 127.0.0.1 under one scratch directory. It exercises the same scenario as the
// container backend; only the container run at candidate C counts (13.2, the scope-seat ruling on item 10).

import { execFile, spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, renameSync, copyFileSync, mkdtempSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { RELAY_TEST_AUD } from "../../src/relay/auth.mjs";

export const PKG = fileURLToPath(new URL("../../", import.meta.url));
const NODE = process.execPath;
const ENV = { ...process.env, AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED: "0" };
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const priv = (d) => { mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Run a node script; resolve the last stdout line parsed as JSON (or {ok:false} with stderr). */
function runNode(args, { env = ENV, cwd = PKG } = {}) {
  return new Promise((resolve) => execFile(NODE, args, { env, cwd, encoding: "utf8", maxBuffer: 16 << 20 }, (error, stdout, stderr) => {
    const line = stdout.trim().split("\n").at(-1);
    try { resolve(JSON.parse(line)); } catch { resolve({ ok: false, error: "no-json", code: error?.code ?? null, stdout: stdout.slice(-500), stderr: stderr.slice(-1500) }); }
  }));
}
/** Deterministic git for the fixture repository (no user config, fixed identity and dates). */
const GIT_ENV = { PATH: process.env.PATH, HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "harness", GIT_AUTHOR_EMAIL: "harness@example.invalid", GIT_AUTHOR_DATE: "2027-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "harness", GIT_COMMITTER_EMAIL: "harness@example.invalid", GIT_COMMITTER_DATE: "2027-01-01T00:00:00Z" };
export const FIXTURE_FILES = Object.freeze({ "docs/relay.md": "old\n", "check.sh": "grep -q '^new' docs/relay.md && ! grep -q FAIL docs/relay.md\n" });
const sh = (cmd, cwd) => new Promise((resolve) => execFile("/bin/sh", ["-c", cmd], { cwd, env: GIT_ENV, encoding: "utf8" }, (error, stdout, stderr) =>
  resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, out: `${stdout}${stderr}` })));

export async function localEnv({ log = () => {} } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "relay-l1-local-")));
  const home = (n) => priv(join(root, n));
  const tm = (n) => priv(join(home(n), "tm"));
  for (const n of ["relay", "controller", "A", "B", "verify"]) { home(n); tm(n); }
  const port = await freePort();
  const relayUrl = `http://127.0.0.1:${port}`;
  const relayKey = join(home("relay"), "relay.key");
  writeFileSync(relayKey, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  let relayProc = null, relayPublicKey = null, fleet = null, generation = 0;
  const egressLog = join(home("relay"), "egress.jsonl");

  const env = {
    name: "local", counting: false, root,
    get relayPublicKey() { return relayPublicKey; },
    async setClock(ms) { for (const n of ["relay", "controller", "A", "B"]) writeFileSync(join(tm(n), "clock"), `${ms}\n`, { mode: 0o600 }); },
    relay: {
      async start({ ownerPublicKey }) {
        const args = ["--import", "./test/relay-l1/egress-sensor.mjs", "src/relay/server.mjs", "--test-mode", "--test-dir", tm("relay"), "--aud", RELAY_TEST_AUD,
          "--bind", "127.0.0.1", "--port", String(port), "--db", join(home("relay"), "relay-l1.db"), "--roster", fleet.roster, "--policy", fleet.policy,
          "--owner-public-key", ownerPublicKey, "--relay-key-file", relayKey, "--access-log", join(home("relay"), "access.log")];
        relayProc = spawn(NODE, args, { cwd: PKG, env: { ...ENV, EGRESS_LOG: egressLog }, stdio: ["ignore", "pipe", "pipe"] });
        let err = "";
        relayProc.stderr.on("data", (c) => { err += c; });
        const first = await new Promise((resolve, reject) => {
          let buf = "";
          relayProc.stdout.on("data", (c) => { buf += c; if (buf.includes("\n")) resolve(JSON.parse(buf.split("\n")[0])); });
          relayProc.once("exit", (code) => reject(new Error(`relay exited ${code}: ${err}`)));
        });
        relayPublicKey = first.relay_public_key;
        generation++;
        log(`relay up ${first.listening} (start ${generation})`);
        return first;
      },
      async stop() {
        if (!relayProc) return;
        const p = relayProc; relayProc = null;
        p.kill("SIGTERM");
        await new Promise(r => (p.exitCode !== null ? r() : p.once("exit", r)));
        log("relay down");
      },
    },
    controller: {
      async init() {
        const r = await runNode(["test/relay-l1/controller.mjs", "init", "--state", priv(join(home("controller"), "state")), "--test-dir", tm("controller")]);
        if (!r.ok) throw new Error(`controller init: ${JSON.stringify(r)}`);
        fleet = r.result;
        return fleet;
      },
      op: (o) => runNode(["test/relay-l1/controller.mjs", "op", "--state", join(home("controller"), "state"), "--relay-url", relayUrl,
        "--relay-public-key", relayPublicKey, "--test-dir", tm("controller"), "--json", JSON.stringify(o)]),
    },
    agent(name) {
      const state = () => priv(join(home(name), "state"));
      const files = priv(join(home(name), "files"));
      const barriers = () => priv(join(tm(name), "barriers"));
      const cliArgs = (args) => ["src/relay/client.mjs", ...args, "--state", state(), "--relay-url", relayUrl, "--test-mode", "--test-dir", tm(name)];
      return {
        name,
        path: (rel) => join(files, rel),
        async putFile(rel, text) { writeFileSync(join(files, rel), text, { mode: 0o600 }); },
        async removeFile(rel) { rmSync(join(files, rel), { force: true }); },
        async run(args, { background = false } = {}) {
          if (!background) return runNode(cliArgs(args));
          const child = spawn(NODE, cliArgs(args), { cwd: PKG, env: ENV, stdio: "ignore" });
          const done = new Promise(r => child.once("exit", r));
          return { done, async kill() { child.kill("SIGKILL"); await done; } };
        },
        async hold(b) { writeFileSync(join(barriers(), `${b}.hold`), "", { mode: 0o600 }); },
        async waitReached(b) {
          const f = join(barriers(), `${b}.reached`);
          const end = Date.now() + 20000;
          while (!existsSync(f)) { if (Date.now() > end) throw new Error(`${name}: barrier ${b} not reached`); await sleep(20); }
          rmSync(f, { force: true });
        },
        async release(b) { rmSync(join(barriers(), `${b}.hold`), { force: true }); },
        /** Replace the agent's state: keepFour = the key seed and pins.json (agent, relay.origin, relay.public_key) only. */
        async wipe({ keepFour }) {
          const old = join(home(name), "state");
          const gone = join(home(name), `state-wiped-${Date.now()}`);
          renameSync(old, gone);
          const fresh = state();
          if (keepFour) for (const f of ["key.seed", "pins.json"]) copyFileSync(join(gone, f), join(fresh, f));
          return { files: readdirSync(fresh).sort() };
        },
      };
    },
    verify: {
      /** The fixture repository at base_commit (deterministic content, identity and dates). */
      async base() {
        const repo = priv(join(home("verify"), "base"));
        for (const [p, text] of Object.entries(FIXTURE_FILES)) { mkdirSync(dirname(join(repo, p)), { recursive: true }); writeFileSync(join(repo, p), text); }
        for (const cmd of ["git -c init.defaultBranch=main init -q .", "git add -A", "git -c commit.gpgsign=false commit -q -m base"]) {
          const r = await sh(cmd, repo);
          if (r.code !== 0) throw new Error(`fixture repo: ${cmd}: ${r.out}`);
        }
        return (await sh("git rev-parse HEAD", repo)).out.trim();
      },
      /** 12.2: apply the patch to base_commit in a fresh copy and run the required checks. */
      async check(patch, checks) {
        const work = join(home("verify"), `work-${randomBytes(4).toString("hex")}`);
        await sh(`git clone -q ${join(home("verify"), "base")} ${work}`, root);
        let logText = "";
        writeFileSync(join(work, "submission.patch"), patch.map(f => f.diff).join(""));
        const applied = await sh("git apply --whitespace=nowarn submission.patch && rm submission.patch", work);
        logText += `apply ${applied.code}\n${applied.out}`;
        const exit_codes = [];
        for (const c of checks) { const r = applied.code === 0 ? await sh(c, work) : { code: 125, out: "patch did not apply\n" }; exit_codes.push(r.code); logText += `$ ${c}\n${r.out}exit ${r.code}\n`; }
        return { exit_codes, log_sha256: sha256(logText), image_digest: `sha256:${sha256("local-loopback-non-counting")}` };
      },
    },
    async exportSigned() {
      const out = join(home("relay"), `export-${Date.now()}.json`);
      await execNode(["src/relay/export-cli.mjs", "--db", join(home("relay"), "relay-l1.db"), "--relay-key-file", relayKey, "--aud", RELAY_TEST_AUD, "--out", out,
        "--at", readFileSync(join(tm("relay"), "clock"), "utf8").trim()]);
      return JSON.parse(readFileSync(out, "utf8"));
    },
    oracle: () => runNode(["test/relay-l1/oracle.mjs", join(home("relay"), "relay-l1.db")]),
    egress: async () => (existsSync(egressLog) ? readFileSync(egressLog, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : []),
    async close() { await env.relay.stop(); },
  };
  return env;
}

function execNode(args) {
  return new Promise((resolve, reject) => execFile(NODE, args, { cwd: PKG, env: ENV, encoding: "utf8" }, (e, out, err) => (e ? reject(new Error(err)) : resolve(out))));
}
