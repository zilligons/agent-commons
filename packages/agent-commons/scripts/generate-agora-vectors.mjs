// Generates examples/agora-vectors/agora-v1.json: Agora envelopes, identity bindings and JCS cases produced by
// src/agora.mjs from FIXED, TEST-ONLY keys (derived from public labels: anyone can regenerate them; never use them for
// anything real). Ed25519 is deterministic, so the bytes are stable. The live uuaid verifiers (cf48f0e @uuaid/core
// verifyEnvelope + canonicalize, apps/api identity-binding verifyIdentityBindingSignature) approved these exact bytes;
// test/agora-vectors.test.mjs re-derives them in CI. Run: node scripts/generate-agora-vectors.mjs
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { Keychain, jcs } from "../src/pillar.mjs";
import { sealUuaidEnvelope, buildIdentityBinding } from "../src/agora.mjs";

const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
export function testKey(label, ns) {
  const seed = createHash("sha256").update(`agent-commons agora vectors v1 TEST ONLY: ${label}`).digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: "der", type: "pkcs8" });
  const der = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const raw = der.subarray(der.length - 32);
  const k = new Keychain("unused");
  k._identity = { uuaid: `uuaid:${ns}:agent:${Keychain.localIdFromKey(raw)}`, publicKey: createPublicKey(privateKey), privateKey, publicKeyHex: Buffer.from(raw).toString("hex"), createdAt: "2026-11-09T00:00:00.000Z" };
  return { k, seedHex: seed.toString("hex") };
}
export const REGISTRY = "uuaid:foundation:agent:0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
export const AT = "2026-11-09T09:00:00.000Z";
export const HOSTILE = { "é": 1, "e": 2, "Ā": 3, "a": [true, null, " ", "😀", "\u0000"], "z": { "b": "\"\\", "big": 9007199254740991 }, "": "empty-key", "10": "num-key", "9": "num-key2" };

export function buildVectors() {
  const cases = [];
  for (const ns of ["foundation", "pillar", "agentnet"]) {
    const { k, seedHex } = testKey(`agent ${ns}`, ns);
    const payload = { agent_uuaid: REGISTRY, action: "community.post", audience: "community", target: "community:agentnet:42", nonce: `vector-nonce-${ns}`,
      created: AT, expires: "2026-11-09T09:02:00.000Z", author_uuaid: REGISTRY, kind: "post", title: null, body: `a commons agent in ${ns}`, meta: { hostile: HOSTILE } };
    const envelope = sealUuaidEnvelope(payload, k, `ac-${ns}`, { now: () => new Date(AT) });
    const { binding, signature } = buildIdentityBinding({ registryUuaid: REGISTRY, keychain: k, now: () => Date.parse(AT) });
    cases.push({ namespace: ns, seedHex, uuaid: k._identity.uuaid, publicKey: k._identity.publicKeyHex, envelope, binding: { binding, signature } });
  }
  const jcsCases = [
    { name: "hostile", value: HOSTILE },
    { name: "unicode-order", value: { "é": 1, "é": 2, "ﬁ": 3, "𐀀": 4, "￿": 5 } },
    { name: "nested", value: { b: [{ d: 1, c: 2 }], a: "x" } },
  ].map((c) => ({ ...c, canonical: jcs(c.value) }));
  return { v: "agent-commons/agora-vectors/1", note: "TEST-ONLY keys derived from public labels. Approved byte-for-byte by the live uuaid cf48f0e verifiers.", registry: REGISTRY, cases, jcs: jcsCases };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = new URL("../examples/agora-vectors/agora-v1.json", import.meta.url);
  mkdirSync(new URL("./", out), { recursive: true });
  writeFileSync(out, JSON.stringify(buildVectors(), null, 2) + "\n");
  console.log(JSON.stringify({ wrote: out.pathname }));
}
