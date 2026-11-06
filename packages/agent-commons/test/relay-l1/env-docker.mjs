// L1 acceptance harness: the R6 CONTAINER backend (spec v3.4.5 13.2; the scope-seat ruling on L1
// item 10). Every container is a fresh `docker run --pull never`
// of the approved image by its full id, with no -v / --mount / --privileged / --cap-add /
// --security-opt / --pid host / --network host / docker socket (asserted with docker inspect before any
// step). The source arrives as a `git archive` of the commit (docker cp of a file; not a mount).
// Bootstrap is the pinned Linux bootstrap script, vendored as bootstrap-ubuntu-24.04.sh beside this file
// (RELAY_L1_BOOTSTRAP may name another copy; whichever file is used must match the sha256 pin), with
// the network ON (default bridge) only for it and ONE `npm ci` in packages/agent-commons. Then the
// internet is cut: each container leaves the bridge; relay, A and B join one `--internal` network; the
// verification container has no network at all. The egress sensor and its control are proved before
// any key is minted. Keys are minted inside each container after the cut; provider requests are off.
// The two "replaced by a fresh container" cases use spare containers bootstrapped and cut with the
// rest, so the network is never opened again during the run.
// /opt/relay-l1-bootstrap.sh and /opt/relay-l1-src.tar are container-internal staging paths: they exist
// only inside each run's containers (docker cp of a file, never a mount), and the containers are removed.

import { execFile, spawn } from "node:child_process";
import { readFileSync, mkdtempSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { RELAY_TEST_AUD } from "../../src/relay/auth.mjs";
import { FIXTURE_FILES } from "./env-local.mjs";

/**
 * The pinned bootstrap script (installs Node from nodejs.org, checked against SHASUMS256.txt). Default: the
 * vendored copy; RELAY_L1_BOOTSTRAP, if set, names another file, which must match the same pin.
 */
export const VENDORED_BOOTSTRAP = fileURLToPath(new URL("./bootstrap-ubuntu-24.04.sh", import.meta.url));
export const BOOTSTRAP = process.env.RELAY_L1_BOOTSTRAP || VENDORED_BOOTSTRAP;
export const BOOTSTRAP_SHA256 = "07f54d1b21f42c3254c976e25df401651ecbc642c177133a1b5ddac3e963edcb";
export const IMAGE = "24737cef";
const SRC = "/workspace/packages/agent-commons";
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** docker CLI with an argument array (no shell). */
export function docker(args, { input, timeout = 1800000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile("docker", args, { encoding: "utf8", maxBuffer: 64 << 20, timeout }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}
async function must(args, what, opts) {
  const r = await docker(args, opts);
  if (r.code !== 0) throw new Error(`${what}: docker ${args.slice(0, 3).join(" ")} -> ${r.code}: ${r.stderr.slice(-800)}`);
  return r.stdout;
}
const execIn = (name, cmd, opts) => docker(["exec", "-i", "-e", "AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED=0", name, "sh", "-c", cmd], opts);
const lastJson = (r) => { try { return JSON.parse(r.stdout.trim().split("\n").at(-1)); } catch { return { ok: false, error: "no-json", code: r.code, stdout: r.stdout.slice(-500), stderr: r.stderr.slice(-1500) }; } };

/** Prove a container's isolation from its configuration: no mounts or privileges, and its networks. */
async function inspectHost(name) {
  const [info] = JSON.parse(await must(["inspect", name], `inspect ${name}`));
  const h = info.HostConfig;
  const problems = [];
  if ((info.Mounts ?? []).length) problems.push("mounts");
  if ((h.Binds ?? []).length) problems.push("binds");
  if (h.Privileged) problems.push("privileged");
  if ((h.CapAdd ?? []).length) problems.push("cap-add");
  if ((h.SecurityOpt ?? []).length) problems.push("security-opt");
  if (h.PidMode === "host" || h.IpcMode === "host" || h.UTSMode === "host" || h.NetworkMode === "host") problems.push("host-namespace");
  if ((h.Devices ?? []).length) problems.push("devices");
  return { name, image: info.Image, networks: Object.keys(info.NetworkSettings.Networks ?? {}), mounts: info.Mounts ?? [], problems,
    ips: Object.fromEntries(Object.entries(info.NetworkSettings.Networks ?? {}).map(([k, v]) => [k, v.IPAddress])) };
}

export async function dockerEnv({ commit, pkgRepo, runId, log = () => {}, record }) {
  const imageId = (await must(["image", "inspect", "--format", "{{.Id}}", IMAGE], "resolve image")).trim();
  record.image_id = imageId;
  record.image_count_before = (await must(["images", "-q", "--no-trunc"], "images")).trim().split("\n").filter(Boolean).length;
  const bootstrap = readFileSync(BOOTSTRAP);
  if (sha256(bootstrap) !== BOOTSTRAP_SHA256) throw new Error(`bootstrap script sha256 ${sha256(bootstrap)} is not the pinned ${BOOTSTRAP_SHA256}`);
  record.bootstrap = { source: BOOTSTRAP === VENDORED_BOOTSTRAP ? "vendored" : "RELAY_L1_BOOTSTRAP", file: BOOTSTRAP === VENDORED_BOOTSTRAP ? "test/relay-l1/bootstrap-ubuntu-24.04.sh" : "(operator path)", sha256: BOOTSTRAP_SHA256 };
  // The source: a git archive of the commit (the package only), copied in as a file.
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "relay-l1-docker-")));
  const tarPath = join(scratch, "src.tar");
  await new Promise((resolve, reject) => execFile("git", ["-C", pkgRepo, "archive", "--format=tar", "-o", tarPath, commit, "packages/agent-commons"], (e) => (e ? reject(e) : resolve())));
  record.source = { commit, archive_sha256: sha256(readFileSync(tarPath)) };

  const label = `commons-relay-l1=${runId}`;
  const net = `${runId}-internal`;
  const names = { relay: `${runId}-relay`, A: `${runId}-a`, B: `${runId}-b`, A2: `${runId}-a2`, B2: `${runId}-b2`, verify: `${runId}-verify` };
  const nodeSide = ["relay", "A", "B", "A2", "B2"];
  record.containers = {};
  const cleanup = async () => {
    const ids = (await docker(["ps", "-aq", "--filter", `label=${label}`])).stdout.trim().split("\n").filter(Boolean);
    if (ids.length) await docker(["rm", "-f", ...ids]);
    await docker(["network", "rm", net]);
    const left = (await docker(["ps", "-aq", "--filter", `label=${label}`])).stdout.trim();
    const netLeft = (await docker(["network", "ls", "-q", "--filter", `name=^${net}$`])).stdout.trim();
    record.cleanup = { containers_removed: ids.length, containers_left: left ? left.split("\n").length : 0, network_left: netLeft !== "" };
    record.image_count_after = (await docker(["images", "-q", "--no-trunc"])).stdout.trim().split("\n").filter(Boolean).length;
  };

  try {
    // 1. Fresh containers on the default bridge (bootstrap window only).
    for (const [role, name] of Object.entries(names)) {
      await must(["run", "-d", "--pull", "never", "--name", name, "--hostname", name, "--label", label, imageId, "sleep", "infinity"], `run ${role}`);
      const i = await inspectHost(name);
      if (i.problems.length || i.image !== imageId) throw new Error(`${name}: not isolated as required: ${i.problems.join(",")} image ${i.image}`);
      record.containers[role] = { name, pre_bootstrap: i };
    }
    // 2. Bootstrap (pinned, unchanged) and one npm ci, in parallel; full output recorded.
    await Promise.all(Object.entries(names).map(async ([role, name]) => {
      await must(["cp", BOOTSTRAP, `${name}:/opt/relay-l1-bootstrap.sh`], `cp bootstrap ${role}`);
      const b = await execIn(name, "sh /opt/relay-l1-bootstrap.sh 2>&1");
      record.containers[role].bootstrap = { exit: b.code, output: b.stdout };
      if (b.code !== 0) throw new Error(`${role}: bootstrap exit ${b.code}: ${b.stdout.slice(-1500)}`);
      if (!nodeSide.includes(role)) return;
      await must(["cp", tarPath, `${name}:/opt/relay-l1-src.tar`], `cp source ${role}`);
      const x = await execIn(name, `mkdir -p /workspace && tar -xf /opt/relay-l1-src.tar -C /workspace && rm /opt/relay-l1-src.tar && cd ${SRC} && sha256sum package-lock.json && npm ci --ignore-scripts --no-audit --no-fund 2>&1 && node -p 'JSON.stringify({node: process.version, unicode: process.versions.unicode, icu: process.versions.icu})'`);
      record.containers[role].npm_ci = { exit: x.code, output: x.stdout.slice(-4000) };
      if (x.code !== 0) throw new Error(`${role}: npm ci exit ${x.code}: ${x.stdout.slice(-1500)}`);
      const lines = x.stdout.trim().split("\n");
      record.containers[role].package_lock_sha256 = lines[0].split(/\s+/)[0];
      record.containers[role].runtime = JSON.parse(lines.at(-1));
    }));
    // 3. Cut the internet: leave the bridge; relay and agents on one --internal network; verify on none.
    await must(["network", "create", "--internal", "--label", label, net], "network create");
    for (const [role, name] of Object.entries(names)) {
      await must(["network", "disconnect", "bridge", name], `disconnect ${role}`);
      if (role !== "verify") await must(["network", "connect", net, name], `connect ${role}`);
    }
    const netInfo = JSON.parse(await must(["network", "inspect", net], "inspect network"))[0];
    if (netInfo.Internal !== true) throw new Error("the test network is not internal");
    record.network_cut = { network: net, internal: netInfo.Internal, containers: {} };
    for (const [role, name] of Object.entries(names)) {
      const i = await inspectHost(name);
      const routes = (await execIn(name, "cat /proc/net/route")).stdout;
      const defaultRoute = routes.split("\n").slice(1).some(l => l.split(/\s+/)[1] === "00000000");
      record.network_cut.containers[role] = { networks: i.networks, default_route: defaultRoute, ips: i.ips, problems: i.problems };
      const want = role === "verify" ? [] : [net];
      if (JSON.stringify(i.networks) !== JSON.stringify(want) || defaultRoute || i.problems.length) throw new Error(`${role}: network cut not proved: ${JSON.stringify(record.network_cut.containers[role])}`);
    }
    // 4. Egress sensor proof BEFORE any key: the control is recorded; the relay module loads with none.
    const relay = names.relay;
    await execIn(relay, "mkdir -p -m 700 /harness /harness/tm /harness/relay /harness/controller && chmod 700 /harness /harness/tm");
    const ctl = await execIn(relay, `cd ${SRC} && EGRESS_LOG=/harness/relay/control.jsonl node --import ./test/relay-l1/egress-sensor.mjs --import ./test/relay-l1/egress-control.mjs -e 'setTimeout(()=>{},1500)'; cat /harness/relay/control.jsonl`);
    const probe = await execIn(relay, `cd ${SRC} && EGRESS_LOG=/harness/relay/probe.jsonl node --import ./test/relay-l1/egress-sensor.mjs -e 'import("./src/relay/server.mjs")'; cat /harness/relay/probe.jsonl`);
    const parse = (t) => t.trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
    const { NOT_EGRESS } = await import("./egress-sensor-kinds.mjs");
    record.egress_proof = { control: parse(ctl.stdout), probe: parse(probe.stdout) };
    if (!record.egress_proof.control.some(e => e.kind === "net.connect")) throw new Error("egress control was not recorded: the sensor is blind");
    if (record.egress_proof.probe.some(e => !NOT_EGRESS.includes(e.kind))) throw new Error("egress before any case");
  } catch (error) {
    record.setup_error = String(error?.stack ?? error).slice(0, 4000);
    await cleanup();
    throw error;
  }

  // --- the env the scenario drives -----------------------------------------------------------------
  const relay = names.relay;
  const relayIp = record.network_cut.containers.relay.ips[net];
  const relayUrl = `http://${relayIp}:8080`;
  const ifaces = JSON.parse((await execIn(relay, `node -p 'JSON.stringify(require("node:os").networkInterfaces())'`)).stdout);
  const iface = Object.entries(ifaces).find(([, l]) => l.some(a => a.address === relayIp))?.[0];
  record.relay = { ip: relayIp, interface: iface, url: relayUrl, aud: RELAY_TEST_AUD };
  // The relay key, minted inside the relay container after the cut (mode 0600).
  await must(["exec", relay, "node", "-e", "require('node:fs').writeFileSync('/harness/relay/relay.key', require('node:crypto').randomBytes(32).toString('hex') + '\\n', { mode: 0o600 })"], "mint relay key");
  let relayPublicKey = null, fleet = null;
  const current = { A: names.A, B: names.B };
  const spare = { A: names.A2, B: names.B2 };
  for (const who of ["A", "B", "A2", "B2"]) await execIn(names[who], "mkdir -p -m 700 /harness /harness/tm /harness/state /harness/files && chmod 700 /harness /harness/tm /harness/state");

  const env = {
    name: "docker", counting: false,
    get relayPublicKey() { return relayPublicKey; },
    async setClock(ms) {
      await Promise.all([relay, current.A, current.B, names.A2, names.B2].map(n => execIn(n, `umask 077; printf '%s\\n' ${Number(ms)} > /harness/tm/clock`)));
    },
    relay: {
      async start({ ownerPublicKey }) {
        await execIn(relay, `rm -f /harness/relay/stdout.log`);
        const cmd = `cd ${SRC} && EGRESS_LOG=/harness/relay/egress.jsonl exec node --import ./test/relay-l1/egress-sensor.mjs src/relay/server.mjs --test-mode --test-dir /harness/tm`
          + ` --aud ${q(RELAY_TEST_AUD)} --bind ${relayIp} --test-interface ${q(iface)} --port 8080 --db /harness/relay/relay-l1.db --roster /harness/controller/state/roster.json`
          + ` --policy /harness/controller/state/policy.json --owner-public-key ${ownerPublicKey} --relay-key-file /harness/relay/relay.key --access-log /harness/relay/access.log`
          + ` >> /harness/relay/stdout.log 2>> /harness/relay/stderr.log`;
        await must(["exec", "-d", "-e", "AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED=0", relay, "sh", "-c", cmd], "start relay");
        for (let i = 0; i < 200; i++) {
          const out = (await execIn(relay, "cat /harness/relay/stdout.log 2>/dev/null")).stdout.trim();
          if (out) { const first = JSON.parse(out.split("\n").at(-1)); relayPublicKey = first.relay_public_key; log(`relay up ${first.listening}`); return first; }
          await sleep(100);
        }
        throw new Error(`relay did not start: ${(await execIn(relay, "cat /harness/relay/stderr.log")).stdout.slice(-1500)}`);
      },
      async stop() {
        // [s]rc: the pattern never matches the sh -c line that runs pkill / pgrep itself.
        await execIn(relay, "pkill -TERM -f '[s]rc/relay/server.mjs'");
        for (let i = 0; i < 100; i++) { if ((await execIn(relay, "pgrep -f '[s]rc/relay/server.mjs'")).code !== 0) { log("relay down"); return; } await sleep(100); }
        throw new Error("relay did not stop");
      },
    },
    controller: {
      async init() {
        const r = lastJson(await execIn(relay, `cd ${SRC} && node test/relay-l1/controller.mjs init --state /harness/controller/state --test-dir /harness/tm`));
        if (!r.ok) throw new Error(`controller init: ${JSON.stringify(r)}`);
        fleet = r.result;
        return fleet;
      },
      op: async (o) => lastJson(await execIn(relay, `cd ${SRC} && node test/relay-l1/controller.mjs op --state /harness/controller/state --relay-url ${relayUrl} --relay-public-key ${relayPublicKey} --test-dir /harness/tm --json ${q(JSON.stringify(o))}`)),
    },
    agent(name) {
      const c = () => current[name];
      const cli = (args) => `cd ${SRC} && node src/relay/client.mjs ${args.map(q).join(" ")} --state /harness/state --relay-url ${relayUrl} --test-mode --test-dir /harness/tm`;
      return {
        name,
        path: (rel) => `/harness/files/${rel}`,
        async putFile(rel, text) { const r = await execIn(c(), `umask 077; cat > /harness/files/${q(rel)}`, { input: text }); if (r.code) throw new Error(r.stderr); },
        async removeFile(rel) { await execIn(c(), `rm -f /harness/files/${q(rel)}`); },
        async run(args, { background = false } = {}) {
          if (!background) return lastJson(await execIn(c(), cli(args)));
          const child = spawn("docker", ["exec", "-e", "AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED=0", c(), "sh", "-c", cli(args)], { stdio: "ignore" });
          const done = new Promise(r => child.once("exit", r));
          const container = c();
          return { done, async kill() { await execIn(container, "pkill -KILL -f '[s]rc/relay/client.mjs'"); await done; } };
        },
        async hold(b) { await execIn(c(), `mkdir -p -m 700 /harness/tm/barriers && umask 077 && : > /harness/tm/barriers/${b}.hold`); },
        async waitReached(b) {
          for (let i = 0; i < 400; i++) { if ((await execIn(c(), `test -f /harness/tm/barriers/${b}.reached && rm -f /harness/tm/barriers/${b}.reached`)).code === 0) return; await sleep(50); }
          throw new Error(`${name}: barrier ${b} not reached`);
        },
        async release(b) { await execIn(c(), `rm -f /harness/tm/barriers/${b}.hold`); },
        /** 13.2 case 8 / N40: the agent moves to its spare: a fresh container from the same image, with nothing of the old state except, if keepFour, the four values. */
        async wipe({ keepFour }) {
          const old = c(), fresh = spare[name];
          const empty = (await execIn(fresh, "ls -A /harness/state")).stdout.trim();
          if (empty) throw new Error(`${fresh}: spare state not empty`);
          if (keepFour) for (const f of ["key.seed", "pins.json"]) {
            const v = await execIn(old, `cat /harness/state/${f}`);
            const w = await execIn(fresh, `umask 077; cat > /harness/state/${f}`, { input: v.stdout });
            if (v.code || w.code) throw new Error(`copy ${f}`);
          }
          await must(["stop", "-t", "1", old], `stop ${old}`);
          current[name] = fresh;
          record.replacements = [...(record.replacements ?? []), { agent: name, from: old, to: fresh, keep_four: keepFour }];
          return { files: (await execIn(fresh, "ls -A /harness/state")).stdout.trim().split("\n").filter(Boolean).sort() };
        },
      };
    },
    verify: {
      async base() {
        const files = Object.entries(FIXTURE_FILES).map(([p, t]) => `mkdir -p "$(dirname ${q(p)})" && printf '%s' ${q(t)} > ${q(p)}`).join(" && ");
        const r = await execIn(names.verify, `export HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=harness GIT_AUTHOR_EMAIL=harness@example.invalid GIT_AUTHOR_DATE=2027-01-01T00:00:00Z GIT_COMMITTER_NAME=harness GIT_COMMITTER_EMAIL=harness@example.invalid GIT_COMMITTER_DATE=2027-01-01T00:00:00Z; mkdir -p /verify/base && cd /verify/base && ${files} && git -c init.defaultBranch=main init -q . && git add -A && git -c commit.gpgsign=false commit -q -m base && git rev-parse HEAD`);
        if (r.code) throw new Error(`verify base: ${r.stderr}`);
        return r.stdout.trim().split("\n").at(-1);
      },
      async check(patch, checks) {
        const id = `w${Date.now()}`;
        const put = await execIn(names.verify, `cd /verify && git clone -q base ${id} && cat > ${id}/submission.patch`, { input: patch.map(f => f.diff).join("") });
        if (put.code) throw new Error(`verify clone: ${put.stderr}`);
        const applied = await execIn(names.verify, `cd /verify/${id} && git apply --whitespace=nowarn submission.patch 2>&1 && rm submission.patch`);
        let logText = `apply ${applied.code}\n${applied.stdout}`;
        const exit_codes = [];
        for (const chk of checks) {
          const r = applied.code === 0 ? await execIn(names.verify, `cd /verify/${id} && ${chk} 2>&1`) : { code: 125, stdout: "patch did not apply\n" };
          exit_codes.push(r.code); logText += `$ ${chk}\n${r.stdout}exit ${r.code}\n`;
        }
        return { exit_codes, log_sha256: sha256(logText), image_digest: imageId };
      },
    },
    async exportSigned() {
      const clock = (await execIn(relay, "cat /harness/tm/clock")).stdout.trim();
      const r = await execIn(relay, `cd ${SRC} && node src/relay/export-cli.mjs --db /harness/relay/relay-l1.db --relay-key-file /harness/relay/relay.key --aud ${q(RELAY_TEST_AUD)} --out /harness/relay/export.json --at ${clock} && cat /harness/relay/export.json`);
      if (r.code) throw new Error(`export: ${r.stderr}`);
      return JSON.parse(r.stdout);
    },
    oracle: async () => lastJson(await execIn(relay, `cd ${SRC} && node test/relay-l1/oracle.mjs /harness/relay/relay-l1.db`)),
    egress: async () => (await execIn(relay, "cat /harness/relay/egress.jsonl 2>/dev/null")).stdout.trim().split("\n").filter(Boolean).map(l => JSON.parse(l)),
    async close() { await cleanup(); },
  };
  return env;
}
