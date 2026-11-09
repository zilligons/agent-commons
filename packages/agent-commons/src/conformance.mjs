// Runs the shipped wild-format vectors (examples/wild-vectors/wild-v1.json) through the REAL receive path:
// the Agent Commons runtime (admission + tolerant ingress), then the supported group judge for space traffic.
// A driver that passes these hears the wild; one that fails must not trust its own silence.
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { Keychain } from "./pillar.mjs";
import { AgentCommons } from "./runtime.mjs";
import { CommonsStore } from "./store.mjs";
import { GroupReceiver, RosterStore } from "./spaces/pillar-group.mjs";
import { judgeReceived } from "./spaces/driver.mjs";

export const WILD_VECTORS_URL = new URL("../examples/wild-vectors/wild-v1.json", import.meta.url);
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");

function keychainFromSeed({ uuaid, seedHex }) {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });
  const der = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const publicKeyHex = Buffer.from(der.subarray(der.length - 32)).toString("hex");
  const k = new Keychain("unused");
  k._identity = { uuaid, publicKey: createPublicKey(privateKey), privateKey, publicKeyHex, createdAt: "2026-11-08T00:00:00.000Z" };
  return k;
}

function check(expect, got) {
  const misses = [];
  for (const [field, want] of Object.entries(expect)) {
    if (field === "payloadKeys") { const keys = Object.keys(got.payload ?? {}).sort(); if (JSON.stringify(keys) !== JSON.stringify([...want].sort())) misses.push(field); }
    else if (got[field] !== want) misses.push(field);
  }
  return misses;
}

export async function runWildVectors({ vectors = JSON.parse(readFileSync(WILD_VECTORS_URL, "utf8")) } = {}) {
  if (vectors?.v !== "agent-commons/wild-vectors/1") throw new Error("Unknown wild vector format");
  const keychain = keychainFromSeed(vectors.recipient);
  if (keychain._identity.publicKeyHex !== vectors.recipient.publicKeyHex) throw new Error("Vector recipient seed does not match its public key");
  const caps = ["commons:message"];
  const agents = { [vectors.recipient.uuaid]: { kind: "agent", publicKey: vectors.recipient.publicKeyHex, capabilities: caps } };
  for (const a of vectors.admitted) agents[a.uuaid] = { kind: "agent", publicKey: a.publicKeyHex, capabilities: caps };
  const cases = [];
  for (const c of vectors.cases) {
    const dir = mkdtempSync(join(tmpdir(), "ac-wild-"));
    const runtime = new AgentCommons({ keychain, store: new CommonsStore(), policy: { mode: "local", agents } });
    const receiver = new GroupReceiver({ self: { uuaid: keychain._identity.uuaid, key: keychain._identity.publicKeyHex }, store: new RosterStore(dir), mailbox: null });
    const steps = [];
    try {
      for (let i = 0; i < c.envelopes.length; i++) {
        let got;
        try {
          const r = await runtime.receive(c.envelopes[i]);
          got = { runtime: r?.accepted === true ? "accepted" : r?.duplicate ? "duplicate" : "other", format: r?.format, text: r?.text, group: r?.group, payload: r?.payload };
          if (r?.group) { const j = judgeReceived(receiver, { sender: r.sender, transportKey: r.transportKey, payload: r.payload }); got.groupVerdict = j.verdict; if (j.reason) got.groupReason = j.reason; }
        } catch (error) { got = { runtime: "refused", code: error.code ?? null, reason: error.message }; }
        const misses = check(c.expect[i] ?? {}, got);
        const { payload, ...shown } = got;
        steps.push({ step: i + 1, ok: misses.length === 0, ...(misses.length ? { misses, expected: c.expect[i] } : {}), got: shown });
      }
    } finally { runtime.store.close?.(); rmSync(dir, { recursive: true, force: true }); }
    cases.push({ name: c.name, ok: steps.every((s) => s.ok), steps });
  }
  return { vectors: vectors.v, passed: cases.filter((c) => c.ok).length, failed: cases.filter((c) => !c.ok).length, cases };
}
