import { localIdFromKey, mintNamespace, SELF_CERTIFYING_NAMESPACES } from "./vendor/pillar/identity/keychain.mjs";

// The namespace Agent Commons mints NEW key-derived identities in:
// uuaid:agentnet:agent:<localIdFromKey(publicKey)>.
//
// Pass it explicitly at every mint site. The vendored Keychain.generate default
// ("foundation") stays unchanged on purpose: a stored key without a recorded
// namespace must never be re-derived under a new default and renamed (the
// 2026-09-20 peek() defect). Existing identities keep their ids; "foundation"
// remains a valid self-certifying namespace.
export const RUNTIME_UUAID_NAMESPACE = "agentnet";

// Every mint site passes mintNamespace(RUNTIME_UUAID_NAMESPACE): the vendored
// check throws on a namespace a key cannot claim, so a wrong constant fails at
// mint instead of producing an identity no verifier accepts.
export { mintNamespace };

// The namespaces a key alone can claim, taken from the vendored @uuaid/pillar
// (foundation, pillar, agentnet). A registry namespace (zilligon, iaaso, ...) is
// vouched for by its registry, not by a key, so it is refused wherever Agent
// Commons accepts an identity on the strength of its key.
export { SELF_CERTIFYING_NAMESPACES };

// The shape of a key-derived agent UUAID in a self-certifying namespace. The
// local id is the canonical lower-case 8-4-4-4-12 form localIdFromKey emits.
export const SELF_CERTIFYING_AGENT_UUAID = new RegExp(`^uuaid:(?:${SELF_CERTIFYING_NAMESPACES.join("|")}):agent:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`);

// Namespace alignment rule 1: the UUAID has the shape above and its local id is
// the key's. The id is parsed and its local id compared; it is never rebuilt
// from the key and compared whole (rule 2).
export function keyBindsAgentUuaid(uuaid, publicKeyHex) {
  return typeof uuaid === "string" && SELF_CERTIFYING_AGENT_UUAID.test(uuaid) &&
    typeof publicKeyHex === "string" && /^[0-9a-f]{64}$/.test(publicKeyHex) &&
    localIdFromKey(Buffer.from(publicKeyHex, "hex")) === uuaid.split(":")[3];
}

// Block by key, not by spelling. One key has a spelling in each self-certifying
// namespace, all with the same local id, so a block on any of them blocks the
// key. An entry that is not a key-derived spelling blocks only itself.
// Block entries are operator-asserted, not key-verified: a list carries no
// public keys, so a shape-valid entry blocks whichever key has that local id.
export function keyIsBlocked(blocked, uuaid) {
  if (!Array.isArray(blocked) || typeof uuaid !== "string") return false;
  if (blocked.includes(uuaid)) return true;
  if (!SELF_CERTIFYING_AGENT_UUAID.test(uuaid)) return false;
  const local = uuaid.split(":")[3];
  return blocked.some(entry => typeof entry === "string" && SELF_CERTIFYING_AGENT_UUAID.test(entry) && entry.split(":")[3] === local);
}
