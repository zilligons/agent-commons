// Regenerates identity-auth.json, the request-signature test vector the relay's port of the identity
// request scheme (src/relay/auth.mjs) must pass (spec 6.1). It is built here INDEPENDENTLY of that
// port, from the published algorithm only: Ed25519 (RFC 8032) through @noble/curves, sha256 through
// node:crypto, and RFC 8785 JCS written out below for the value types the vector uses (objects,
// arrays, strings, safe integers). The key seed is a fixed fixture, so the output is reproducible byte
// for byte:
//   node test/relay-fixtures/vectors/make-identity-auth-vector.mjs > test/relay-fixtures/vectors/identity-auth.json
// It follows the shape of the identity standard's own vector ("Profile K"): the request, the header,
// the public key and agent, the expected descriptor and signed string, and six must-fail mutations.

import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest();
/** RFC 8785 for objects, arrays, strings and safe integers: keys sorted by UTF-16 code units, no whitespace. */
function jcs(v) {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") { if (!Number.isSafeInteger(v)) throw new Error("integers only"); return String(v); }
  if (Array.isArray(v)) return `[${v.map(jcs).join(",")}]`;
  if (typeof v === "object") return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${jcs(v[k])}`).join(",")}}`;
  throw new Error(`unsupported ${typeof v}`);
}
const TYPE = "uuaid.identity.request.v1";
const seed = sha256(Buffer.from("agent-commons identity-auth vector v1: fixture key seed, never a real key", "utf8"));
const publicKey = Buffer.from(ed25519.getPublicKey(seed));
const h = sha256(publicKey).subarray(0, 16).toString("hex");
const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
const agent = `uuaid:pillar:agent:${id}`;
const aud = "https://api.uuaid.org";
const created = "2026-11-06T12:00:00.000Z", nonce = "00112233445566778899aabbccddeeff";
const path = `/agents/${agent}/wallet`;
const body = { enrolment: { payload: { type: "example-enrolment/1", aud, agent, label: "fixture agent", keys: 2, created, nonce: "c3".repeat(16) } } };
const bodySha = (b) => sha256(Buffer.from(jcs(b), "utf8")).toString("hex");
const descriptor = (o = {}) => ({ type: TYPE, aud, agent, method: "POST", path, query: "", body_sha256: bodySha(body), created, nonce, ...o });
const signed = `${TYPE}\n${jcs(descriptor())}`;
const sig = Buffer.from(ed25519.sign(Buffer.from(signed, "utf8"), seed)).toString("hex");
const vector = {
  note: "Regenerated test vector (make-identity-auth-vector.mjs; fixture key). The identity key derives the agent's address: uuaid:<namespace>:agent:<first 16 bytes of sha256(public key), as a UUID>. Rebuild the descriptor from the request; verify the header's Ed25519 signature (RFC 8032, prime-order key) over UTF-8(\"uuaid.identity.request.v1\\n\" + JCS(descriptor)) with public_key. Each mutation MUST fail.",
  request: { method: "POST", path, query: "", body },
  header: `v=1; created=${created}; nonce=${nonce}; ed25519=${sig}`,
  public_key: publicKey.toString("hex"),
  agent,
  expected_descriptor: descriptor(),
  expected_signed_string: signed,
  must_fail: [
    { change: "method", descriptor: descriptor({ method: "PUT" }) },
    { change: "path", descriptor: descriptor({ path: `/agents/${agent}/registration` }) },
    { change: "body", descriptor: descriptor({ body_sha256: bodySha({ ...body, extra: 1 }) }) },
    { change: "audience", descriptor: descriptor({ aud: "https://evil.example" }) },
    { change: "agent", descriptor: descriptor({ agent: `uuaid:agentnet:agent:${id}` }) },
    { change: "query", descriptor: descriptor({ query: "x=1" }) },
  ],
};
if (!ed25519.verify(Buffer.from(sig, "hex"), Buffer.from(signed, "utf8"), publicKey, { zip215: false })) throw new Error("self-check failed");
process.stdout.write(`${JSON.stringify(vector, null, 2)}\n`);
