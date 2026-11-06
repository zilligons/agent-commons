// L1 acceptance harness (spec v3.4.5 13.2): the fleet controller. Every fleet principal (seven AC
// seats, the verification lane, the security reviewer, the scope seat, the owner and the measurer) is
// a FIXTURE key minted here, inside the harness side (in the container run: the relay's container,
// after the network cut), mode 0600, never committed, and never in agent A or B. They are labelled as
// one controller. Families are synthetic labels: they test the rule, not real diversity. It also plays
// the scratch owner-record mirror (seat-3 confirms owner-visible lines).
//
// node test/relay-l1/controller.mjs init --state <dir> --test-dir <dir>
// node test/relay-l1/controller.mjs op --state <dir> --relay-url <url> --test-dir <dir> --json '<op>'
// Each prints one JSON line. Requests are signed per 6.1 at the test clock's time; every response must
// verify against the pinned relay key (6.2) or the op fails.

import { mkdirSync, readFileSync, writeFileSync, lstatSync, realpathSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { pathToFileURL } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { jcs } from "../../src/pillar.mjs";
import { localIdFromKey } from "../../src/vendor/pillar/identity/keychain.mjs";
import { signIdentityRequest, verifyRelayResponse, RELAY_TEST_AUD, RELAY_SIG_HEADER } from "../../src/relay/auth.mjs";
import { ROSTER_V, POLICY_V } from "../../src/relay/roster.mjs";
import { DECISION_V, APPROVAL_V, VERIFY_V, OWNER_CONFIRM_V, SEAT_MESSAGE_V, ATTEST_V, DEFAULT_SECURITY_PATHS } from "../../src/relay/governance.mjs";
import { openTestHooks } from "../../src/relay/test-mode.mjs";

export const LANE = "relay-core";
export const SEATS = Object.freeze([["seat-1", "anthropic"], ["seat-2", "openai"], ["seat-3", "anthropic"], ["seat-4", "google"],
  ["seat-5", "deepseek"], ["seat-6", "qwen"], ["seat-7", "moonshot"]]);
const OTHERS = [["verifier", "verifier"], ["security", "security"], ["scope", "scope"], ["owner", "owner"], ["measurer", "measurer"]];
export const FAMILY_MAP = Object.freeze([["claude-*", "anthropic"], ["gpt-*", "openai"], ["gemini-*", "google"], ["deepseek-*", "deepseek"], ["qwen*", "qwen"], ["kimi-*", "moonshot"]]
  .map(([pattern, family]) => ({ pattern, family })));
const MODEL_OF = { anthropic: "claude-fixture", openai: "gpt-fixture", google: "gemini-fixture", deepseek: "deepseek-fixture", qwen: "qwen-fixture", moonshot: "kimi-fixture" };
const FAMILY = Object.fromEntries(SEATS);
const served = (by) => (FAMILY[by] ? `measured:${FAMILY[by]}:fixture-model` : "unmeasured: harness controller, no model");
const sha256 = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

function privateDir(dir) {
  if (typeof dir !== "string" || !isAbsolute(dir)) throw new Error("state dir must be absolute");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) !== 0) throw new Error("state dir must be private (0700)");
  return dir;
}
const pubOf = (seed) => Buffer.from(ed25519.getPublicKey(Buffer.from(seed, "hex"))).toString("hex");
const agentOf = (seed) => `uuaid:agentnet:agent:${localIdFromKey(Buffer.from(pubOf(seed), "hex"))}`;
const signBody = (seed, body) => Buffer.from(ed25519.sign(Buffer.from(jcs(body), "utf8"), Buffer.from(seed, "hex"))).toString("hex");

/** Mint every fleet key (mode 0600) and the owner-signed roster and policy files. */
export function init(stateDir, at) {
  privateDir(stateDir);
  const keys = {};
  for (const [id] of [...SEATS, ...OTHERS]) keys[id] = randomBytes(32).toString("hex");
  writeFileSync(join(stateDir, "fleet-keys.json"), JSON.stringify(keys), { mode: 0o600 });
  const principals = [...SEATS.map(([id, f]) => [id, "ac-seat", f]), ...OTHERS.map(([id, kind]) => [id, kind, null])]
    .map(([principal_id, kind, runtime_family]) => ({ principal_id, kind, runtime_family, public_key: pubOf(keys[principal_id]), agent: agentOf(keys[principal_id]) }));
  const roster = { v: ROSTER_V, version: 1, issued_at: at, principals };
  const policy = { v: POLICY_V, version: 1, issued_at: at, lanes: [{ lane: LANE, owner_seat: "seat-1" }], security_paths: [...DEFAULT_SECURITY_PATHS], family_map: FAMILY_MAP };
  writeFileSync(join(stateDir, "roster.json"), JSON.stringify({ body: roster, sig: signBody(keys.owner, roster) }), { mode: 0o600 });
  writeFileSync(join(stateDir, "policy.json"), JSON.stringify({ body: policy, sig: signBody(keys.owner, policy) }), { mode: 0o600 });
  return { owner_public_key: pubOf(keys.owner), roster: join(stateDir, "roster.json"), policy: join(stateDir, "policy.json"), principals: principals.map(p => p.principal_id) };
}

export class Controller {
  /** aud: the relay's audience (default the L1 test aud; the L2 rehearsal passes its https origin). ca: extra trusted CA (PEM) for an https relay URL. */
  constructor({ stateDir, relayUrl, relayPublicKey, clock, aud = RELAY_TEST_AUD, ca }) {
    this.aud = aud;
    this.ca = ca;
    this.dir = privateDir(stateDir);
    this.keys = JSON.parse(readFileSync(join(stateDir, "fleet-keys.json"), "utf8"));
    this.roster = JSON.parse(readFileSync(join(stateDir, "roster.json"), "utf8")).body.principals;
    this.relayUrl = relayUrl;
    this.relayKey = relayPublicKey;
    this.clock = clock;
    let n = 0;
    this.nextId = (p) => `${p}-${clock()}-${++n}-${randomBytes(3).toString("hex")}`;
  }
  /** A 6.1-signed request by fleet principal `by`; the response must verify against the pinned relay key. */
  call(by, method, target, body) {
    const [path, query = ""] = target.split("?");
    const s = signIdentityRequest({ seedHex: this.keys[by], method, path, query, body, audience: this.aud, created: new Date(this.clock()).toISOString() });
    const nonce = /nonce=([0-9a-f]+)/.exec(s.header)[1];
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const url = new URL(target, this.relayUrl);
    return new Promise((resolve, reject) => {
      const request = url.protocol === "https:" ? httpsRequest : httpRequest;
      const req = request(url, { method, agent: false, ...(this.ca && url.protocol === "https:" ? { ca: this.ca } : {}), headers: { "uuaid-identity-auth": s.header, "commons-principal": s.agent, "user-agent": "commons-relay-l1-controller/1",
        ...(bytes ? { "content-type": "application/json", "content-length": bytes.length } : {}) } }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!verifyRelayResponse(this.relayKey, { aud: this.aud, requestNonce: nonce, status: res.statusCode, body: parsed }, res.headers[RELAY_SIG_HEADER]))
            return reject(new Error("bad-relay-signature"));
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on("error", reject);
      if (bytes) req.end(bytes); else req.end();
    });
  }
  signed(by, body) { return { body, sig: signBody(this.keys[by], body) }; }
  async post(by, type, record) {
    const r = await this.call(by, "POST", `/v1/fleet/records/${type}`, record);
    if (r.status !== 200) throw Object.assign(new Error(`${type}: ${r.status} ${JSON.stringify(r.body)}`), { status: r.status, body: r.body });
    return r.body;
  }
  async view(name, by = "seat-1") {
    const r = await this.call(by, "GET", `/v1/fleet/${name}`);
    if (r.status !== 200) throw new Error(`view ${name}: ${r.status}`);
    return r.body;
  }
  decision(by, { cls, action, subject, args, sponsor, lane = ["SUSPEND", "OWNER", "D1R"].includes(cls) ? undefined : LANE }) {
    return this.signed(by, Object.fromEntries(Object.entries({ v: DECISION_V, id: this.nextId("d"), class: cls, action, subject, lane, sponsor, args, by, served_by: served(by), at: this.clock() })
      .filter(([, v]) => v !== undefined)));
  }
  /** C5: the measurer attests one verdict (decision, seat, seq) as the seat's own family. */
  async attest(decisionId, by, seq, bodyText) {
    const family = FAMILY[by];
    const body = { v: ATTEST_V, target: { decision_id: decisionId, by, seq }, session_id: `fixture-${by}`, record_uuid: this.nextId("rec"),
      response_model: MODEL_OF[family], turn_models: [MODEL_OF[family]], family, body_sha256: sha256(bodyText), tool: "model-of",
      tool_sha256: "e".repeat(64), measured_at: this.clock(), by: "measurer", served_by: served("measurer"), at: this.clock() };
    return this.post("measurer", "served_by.attest", this.signed("measurer", body));
  }
  async verdict(by, decisionId, verdict = "approve", seq = 1, prevText = null) {
    const body = { v: APPROVAL_V, decision_id: decisionId, verdict, seq, prev: prevText === null ? null : sha256(prevText), by, served_by: served(by), at: this.clock() };
    const out = await this.post(by, "verdict", this.signed(by, body));
    if (verdict === "approve") await this.attest(decisionId, by, seq, jcs(body));
    return out;
  }
  /** Confirm the owner-visible line about `subject` (the scratch owner-record mirror, seat-3). */
  async mirror(subject, by = "seat-3") {
    const line = (await this.view("owner-outbox", by)).lines.find(l => l.subject === subject);
    if (!line) throw new Error(`no owner line for ${subject}`);
    const body = { v: OWNER_CONFIRM_V, outbox_id: line.id, line_sha256: line.line_sha256, by, served_by: served(by), at: this.clock() };
    await this.post(by, "owner-record.confirm", this.signed(by, body));
    return line;
  }

  /** One harness op. */
  async op(o) {
    switch (o.op) {
      case "invite": {
        const rec = this.decision(o.by ?? "seat-1", { cls: "D0", action: "invite.create", subject: o.label ?? this.nextId("req"),
          args: { kind: o.kind, member_id: o.member_id ?? null, intended_display_name: o.intended_display_name ?? "harness agent", intended_platform: o.intended_platform ?? "reference-client" } });
        const out = await this.post(o.by ?? "seat-1", "invite.create", rec);
        return { ...out.invite, decision_id: out.id };   // the harness strips decision_id before delivering the invite
      }
      case "confirm-enrollment": {
        // 5.3: the owner line is confirmed posted first, then a seat that did not create the invite confirms (P1).
        const pending = (await this.view("members", o.by ?? "seat-2")).pending_enrollments.find(e => e.id === o.enrollment_id);
        if (!pending) throw new Error("no pending enrollment");
        const line = await this.mirror(o.enrollment_id);
        if (pending.kind === "rebind") {
          // D1R: two AC seats on two families, neither the invite creator; effect after the owner posting is confirmed.
          const rec = this.decision("seat-2", { cls: "D1R", action: "rebind.confirm", subject: o.enrollment_id });
          const d = await this.post("seat-2", "decision.propose", rec);
          await this.attest(d.id, "seat-2", 1, jcs(rec.body));
          await this.verdict("seat-4", d.id);
          await this.mirror(d.id, "seat-5");
          return { decision: d.id, pending: (await this.view("decisions")).decisions.some(x => x.id === d.id) };
        }
        const action = pending.kind === "enroll" ? "enroll.confirm" : "rekey.confirm";
        const subject = pending.kind === "enroll" ? pending.member_id : o.enrollment_id;
        const out = await this.post(o.by ?? "seat-2", action, this.decision(o.by ?? "seat-2", { cls: "D0", action, subject, args: { owner_line_ref: line.id } }));
        return { decision: out.id, state: out.state };
      }
      case "d0": return this.post("seat-1", o.action, this.decision("seat-1", { cls: "D0", action: o.action, subject: o.subject, args: o.args }));
      case "message": {
        const body = { v: SEAT_MESSAGE_V, record_id: o.record_id ?? this.nextId("sm"), member_id: o.member_id, lane: LANE, text: o.text, by: o.by ?? "seat-1", served_by: served(o.by ?? "seat-1"), at: this.clock() };
        return { record_id: body.record_id, ...(await this.post(o.by ?? "seat-1", "message", this.signed(o.by ?? "seat-1", body))) };
      }
      case "view": return this.view(o.name, o.by);
      case "verify-result": {
        const body = { v: VERIFY_V, submission_id: o.submission_id, base_commit: o.base_commit, patch_sha256: o.patch_sha256, image_digest: o.image_digest,
          network: "none", checks: o.checks, exit_codes: o.exit_codes, log_sha256: o.log_sha256, by: "verifier", served_by: served("verifier"), at: this.clock() };
        return this.post("verifier", "verify.result", this.signed("verifier", body));
      }
      case "accept": {
        // D1: the lane owner (seat-1) and a seat of another credited family (seat-2), neither an author; plus the passing verify.result.
        const rec = this.decision("seat-1", { cls: "D1", action: "accept", subject: o.submission_id });
        const d = await this.post("seat-1", "decision.propose", rec);
        await this.attest(d.id, "seat-1", 1, jcs(rec.body));
        await this.verdict("seat-2", d.id);
        await this.mirror(d.id);
        return { decision: d.id, pending: (await this.view("decisions")).decisions.some(x => x.id === d.id) };
      }
      case "roster": return this.roster.map(p => ({ principal_id: p.principal_id, kind: p.kind, runtime_family: p.runtime_family, public_key: p.public_key }));
      default: throw new Error(`unknown op ${o.op}`);
    }
  }
}

export async function controllerMain(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const [command, ...rest] = argv;
  const o = {};
  for (let i = 0; i < rest.length; i += 2) o[rest[i].replace(/^--/, "")] = rest[i + 1];
  try {
    const hooks = openTestHooks(o["test-dir"]);
    let result;
    if (command === "init") result = init(o.state, hooks.now());
    else if (command === "op") result = await new Controller({ stateDir: o.state, relayUrl: o["relay-url"], relayPublicKey: o["relay-public-key"], clock: hooks.now }).op(JSON.parse(o.json));
    else throw new Error("usage: init | op");
    stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
  } catch (error) {
    stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error).slice(0, 500), status: error?.status ?? null, body: error?.body ?? null })}\n`);
    process.exitCode = 1;
  }
}

const invoked = (() => { try { return process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (invoked) await controllerMain();
