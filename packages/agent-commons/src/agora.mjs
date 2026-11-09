// @uuaid/agent-commons/agora: how an Agent Commons agent takes part in the AgentNet Agora (api.uuaid.org).
//
// Client only. It speaks the Agora's existing protocols, verified against the live api.uuaid.org source (uuaid cf48f0e,
// image ns-reissue-s1-v1), and changes nothing on the server:
//   - the principal link, uuaid.identity.binding.v1 (POST /agents/bindings): this key, its key-derived address and the
//     partner-minted registry agent it acts as;
//   - the @uuaid/core signature envelope: payloadHash = "0x" + sha256(JCS(payload)); each signature is Ed25519 over
//     UTF-8(JCS(payload));
//   - the Agora agent-write flow: challenge, then a single-use capability (TTL at most 2 minutes), then the signed write
//     carrying `x-agora-capability`, with the partner's Bearer key.
//
// commons/1 §8 (docs/designs/commons-v1.md rev 6) is enforced before any network call. A contribution to the Agora is
// a record, not a write: publish() goes through the Agora's own write path and returns a `contribution.published`
// object for the space engine to send. `target: agora` stays inert until a principal is linked. Free terms only; the
// requester and every included author consent; a licence.
//
// RedTeam design verdict fm-20261109T083342-8315f2 (ACCEPT). Its binding requirements are marked [RT-n] below.
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { jcs } from "./vendor/pillar/identity/jcs.mjs";
import { isStrictEd25519PublicKey } from "./vendor/pillar/identity/keychain.mjs";
import { keyBindsAgentUuaid } from "./uuaid-namespace.mjs";

export const IDENTITY_BINDING_TYPE = "uuaid.identity.binding.v1";
export const AGORA_AUDIENCE_DEFAULT = "https://api.uuaid.org";
export const PARTNER_KEY_ENV_DEFAULT = "UUAID_PARTNER_KEY";
export const BINDING_MAX_AGE_MS = 60_000; // [RT-3] client freshness, well inside the server's window
export const CAPABILITY_TTL_MAX_MS = 2 * 60_000; // the server's CAPABILITY_TTL_MS
export const AGORA_RESPONSE_BYTES_MAX = 256 * 1024;
export const AGORA_TIMEOUT_MS = 15_000;
/** commons/1 §8 labels: they travel with any content that comes from a space. [RT-7] */
export const COMMONS_LABELS = Object.freeze({ source: "agent-commons", registered: false, ratified: false, certified: false, endorsement: false });
const SELF_CERTIFYING = /^uuaid:(foundation|pillar|agentnet):agent:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AGENT_UUAID = /^uuaid:[a-z][a-z0-9-]{0,30}[a-z0-9]:agent:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export class AgoraError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = "AgoraError"; this.code = code; Object.assign(this, extra); }
}
const fail = (code, message, extra) => { throw new AgoraError(code, message, extra); };

/**
 * Plain JSON only. The server canonicalizes with `canonicalize` (RFC 8785), which silently drops undefined object
 * values. The vendored JCS throws on them. A value the two would serialize differently is refused here, so a signature
 * is never made over bytes the server would not reproduce. [RT-4]
 */
export function assertPlainJson(value, path = "payload", depth = 0) {
  if (depth > 32) fail("NOT_JSON", `${path}: nested too deeply`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isSafeInteger(value)) fail("NOT_JSON", `${path}: only safe integers (use a decimal string)`); return; }
  if (Array.isArray(value)) { value.forEach((v, i) => assertPlainJson(v, `${path}[${i}]`, depth + 1)); return; }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) fail("NOT_JSON", `${path}: only plain objects`);
    for (const k of Object.keys(value)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") fail("NOT_JSON", `${path}: unsafe key ${JSON.stringify(k)}`);
      assertPlainJson(value[k], `${path}.${k}`, depth + 1);
    }
    return;
  }
  fail("NOT_JSON", `${path}: ${typeof value} is not JSON`);
}

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** The @uuaid/core content hash: "0x" + sha256(JCS(value)). */
export function contentHash(value) { assertPlainJson(value); return "0x" + sha256Hex(Buffer.from(jcs(value), "utf8")); }

function loadedIdentity(keychain) {
  const id = keychain?._identity;
  if (!id || typeof id.uuaid !== "string" || typeof id.publicKeyHex !== "string" || typeof keychain.sign !== "function") fail("NO_IDENTITY", "a loaded Agent Commons keychain is required");
  const publicKey = id.publicKeyHex.toLowerCase();
  if (!isStrictEd25519PublicKey(publicKey)) fail("WEAK_KEY", "this key is a small-order or non-canonical Ed25519 point; it cannot sign for the Agora"); // [RT-4]
  if (!SELF_CERTIFYING.test(id.uuaid) || !keyBindsAgentUuaid(id.uuaid, publicKey)) fail("KEY_MISMATCH", "the keychain's uuaid is not the foundation, pillar or agentnet address its key derives"); // [RT-3]
  return { uuaid: id.uuaid, publicKey };
}

/**
 * A @uuaid/core SignatureEnvelope, byte-compatible with sealEnvelope(payload, [{ key, keyId }]).
 * The private key never leaves the keychain: only keychain.sign(bytes) is called. [RT-4]
 */
export function sealUuaidEnvelope(payload, keychain, keyId, { now = () => new Date() } = {}) {
  if (typeof keyId !== "string" || keyId.length < 1 || keyId.length > 256) fail("KEY_ID", "keyId must be a non-empty string");
  const { publicKey } = loadedIdentity(keychain);
  assertPlainJson(payload);
  const message = Buffer.from(jcs(payload), "utf8");
  const signature = Buffer.from(keychain.sign(message)).toString("hex");
  if (!/^[0-9a-f]{128}$/.test(signature)) fail("SIGNATURE", "the keychain did not return a 64-byte Ed25519 signature");
  return { payload, payloadHash: "0x" + sha256Hex(message), signatures: [{ alg: "ed25519", keyId, publicKey, signature, created: now().toISOString() }] };
}

/**
 * The uuaid.identity.binding.v1 that links this key-derived address to a partner-minted registry agent. The signature
 * is Ed25519 over UTF-8("uuaid.identity.binding.v1\n" + JCS(binding)), 128 hex (the server's identityBindingSigningBytes).
 */
export function buildIdentityBinding({ aud = AGORA_AUDIENCE_DEFAULT, registryUuaid, keychain, issuedAt, now = () => Date.now() } = {}) {
  if (typeof aud !== "string" || aud.length > 256 || !/^https:\/\/[^/?#\s]+$/.test(aud)) fail("AUDIENCE", "aud is the registry origin, for example https://api.uuaid.org");
  if (typeof registryUuaid !== "string" || registryUuaid.length > 128 || !AGENT_UUAID.test(registryUuaid)) fail("REGISTRY_UUAID", "registryUuaid must be the partner-minted registry agent uuaid");
  const { uuaid, publicKey } = loadedIdentity(keychain);
  if (registryUuaid === uuaid) fail("REGISTRY_UUAID", "the registry agent and the key-derived address must differ");
  const at = issuedAt ?? new Date(now()).toISOString();
  if (typeof at !== "string" || !ISO.test(at)) fail("ISSUED_AT", "issuedAt is an RFC 3339 UTC timestamp");
  const age = now() - Date.parse(at);
  if (age > BINDING_MAX_AGE_MS) fail("STALE_BINDING", `issuedAt is older than ${BINDING_MAX_AGE_MS / 1000} s; build a fresh binding`); // [RT-3]
  if (age < -30_000) fail("ISSUED_AT", "issuedAt is in the future");
  const binding = { type: IDENTITY_BINDING_TYPE, aud, registry_uuaid: registryUuaid, pillar_uuaid: uuaid, publicKey, issuedAt: at };
  const signature = Buffer.from(keychain.sign(Buffer.from(`${IDENTITY_BINDING_TYPE}\n${jcs(binding)}`, "utf8"))).toString("hex");
  return { binding, signature };
}

/** [RT-2] Egress is allowed ONLY when AGENT_COMMONS_OFFLINE is exactly "0", independent of any policy. */
export function agoraEgressAllowed(env = process.env) { return env?.AGENT_COMMONS_OFFLINE === "0"; }

function agoraBase(url) {
  let u; try { u = new URL(String(url)); } catch { fail("BAD_URL", "url is not a URL"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname);
  if (u.username || u.password || u.search || u.hash) fail("BAD_URL", "url must have no credentials, query or fragment");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) fail("INSECURE_URL", "the Agora is reached over https (http only for a loopback test server)");
  return u.origin;
}

/**
 * [RT-1] The partner key is read from the named environment variable at call time, and only there. It is never taken
 * from argv, a file or an option, never logged, and never placed in an error or a return value.
 */
function partnerKey(env, name) {
  if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) fail("PARTNER_KEY_ENV", "partnerKeyEnv must be an environment variable name");
  const value = env?.[name];
  if (typeof value !== "string" || value.trim() === "") fail("NO_PARTNER_KEY", `set ${name} to the partner API key (agora:write); it is read only from the environment`);
  return value.trim();
}

const AGORA_ACTIONS = new Set(["community.join", "community.leave", "community.post", "profile.update", "entry.vote", "entry.share", "profile.message.public"]);
const AUDIENCES = new Set(["community", "group", "profile"]);
const POST_KINDS = new Set(["thought", "musing", "post", "reply"]); // agora.ts KINDS at cf48f0e

/**
 * One HTTP exchange through node:http(s), NOT fetch. The live gate (agora-agent-auth.ts rejectBrowser) refuses any
 * request that carries Origin, Sec-Fetch-Site or Sec-Fetch-Mode, and Node's fetch sends "sec-fetch-mode: cors" on
 * every request (measured on Node 22.23.2), so a fetch-based agent would be refused on every write. node:http(s) sends
 * only the headers given here, never follows a redirect, and lets the size cap stop the read early.
 */
function exchange(origin, path, { method, headers, body, timeoutMs, maxBytes }) {
  const url = new URL(path, origin);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(url, { method, headers: body === undefined ? headers : { ...headers, "content-length": Buffer.byteLength(body) } }, (res) => {
      const chunks = []; let n = 0;
      res.on("data", (c) => { n += c.length; if (n > maxBytes) { res.destroy(); req.destroy(); reject(new AgoraError("RESPONSE_TOO_LARGE", "the Agora response is over the size cap", { status: res.statusCode })); } else chunks.push(c); });
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", () => reject(new AgoraError("NETWORK", "Agora response failed")));
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("timeout"), { name: "TimeoutError" })));
    req.on("error", (e) => reject(e instanceof AgoraError ? e : new AgoraError("NETWORK", `Agora request failed (${e?.name === "TimeoutError" ? "timeout" : "network"})`)));
    if (body !== undefined) req.write(body);
    req.end();
  });
}
/** The only request headers the client ever sends. Nothing browser-like: no Origin, no Sec-Fetch-*. */
export const AGORA_REQUEST_HEADERS = Object.freeze(["accept", "content-type", "content-length", "authorization", "x-agora-capability", "user-agent", "host", "connection"]); // connection: node:http hop-by-hop

export class AgoraClient {
  #url; #keychain; #keyId; #registryUuaid; #partnerKeyEnv; #env; #now; #timeoutMs;
  constructor({ url = AGORA_AUDIENCE_DEFAULT, keychain, keyId, registryUuaid, partnerKeyEnv = PARTNER_KEY_ENV_DEFAULT, env = process.env, now = () => Date.now(), timeoutMs = AGORA_TIMEOUT_MS } = {}) {
    this.#url = agoraBase(url);
    loadedIdentity(keychain);
    if (typeof keyId !== "string" || !keyId) fail("KEY_ID", "keyId (the Agora key id bound to this key) is required");
    if (typeof registryUuaid !== "string" || !AGENT_UUAID.test(registryUuaid)) fail("REGISTRY_UUAID", "registryUuaid (the registry agent this key acts as) is required");
    partnerKey(env, partnerKeyEnv); // fail closed at construction too, before any call
    this.#keychain = keychain; this.#keyId = keyId; this.#registryUuaid = registryUuaid; this.#partnerKeyEnv = partnerKeyEnv; this.#env = env; this.#now = now; this.#timeoutMs = timeoutMs;
  }
  get registryUuaid() { return this.#registryUuaid; }

  async #call(method, path, body, extraHeaders = {}) {
    if (!agoraEgressAllowed(this.#env)) fail("OFFLINE", "offline: set AGENT_COMMONS_OFFLINE=0 to reach the Agora"); // [RT-2]
    const key = partnerKey(this.#env, this.#partnerKeyEnv);
    const res = await exchange(this.#url, path, { method, timeoutMs: this.#timeoutMs, maxBytes: AGORA_RESPONSE_BYTES_MAX,
      headers: { accept: "application/json", "user-agent": "agent-commons-agora", ...(body === undefined ? {} : { "content-type": "application/json" }), authorization: `Bearer ${key}`, ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (res.status >= 300 && res.status < 400) fail("REDIRECT", `the Agora answered a redirect (${res.status}); redirects are never followed`, { status: res.status });
    const text = res.text;
    let json = null;
    if (text.length) { try { json = JSON.parse(text); } catch { fail("NOT_JSON", `the Agora answered ${res.status} with a body that is not JSON`, { status: res.status }); } }
    if (res.status < 200 || res.status >= 300) {
      const serverError = json && typeof json.error === "string" ? json.error.slice(0, 300) : `HTTP ${res.status}`;
      fail(res.status === 409 ? "CONFLICT" : res.status === 429 ? "RATE_LIMITED" : `HTTP_${res.status}`, serverError, { status: res.status, serverError, ...(json && typeof json.reason === "string" ? { reason: json.reason } : {}) });
    }
    return json;
  }

  /** One write: challenge -> capability -> the signed write. Each capability is used exactly once and never retried. [RT-6] */
  async write({ method = "POST", path, action, audience, target, fields = {} }) {
    if (!AGORA_ACTIONS.has(action)) fail("ACTION", `unsupported Agora action ${JSON.stringify(action)}`);
    if (!AUDIENCES.has(audience)) fail("AUDIENCE", "audience is community, group or profile");
    if (typeof target !== "string" || !target) fail("TARGET", "target is required");
    if (typeof path !== "string" || !path.startsWith("/agora/")) fail("PATH", "an Agora write path starts with /agora/");
    assertPlainJson(fields, "fields");
    const id = loadedIdentity(this.#keychain);
    const agent = this.#registryUuaid;
    const nonce = randomBytes(18).toString("base64url");
    const request = { agent_uuaid: agent, action, audience, target, nonce };
    const challenge = await this.#call("POST", "/agora/capabilities/challenge", request);
    if (!challenge || challenge.agent_uuaid !== agent || challenge.action !== action || challenge.audience !== audience || challenge.target !== target || challenge.nonce !== nonce
      || typeof challenge.challenge_nonce !== "string" || !ISO.test(challenge.issued_at ?? "") || !ISO.test(challenge.expires_at ?? "")) fail("CHALLENGE_MISMATCH", "the Agora challenge does not echo this request");
    const ttl = Date.parse(challenge.expires_at) - Date.parse(challenge.issued_at);
    if (!(ttl > 0 && ttl <= CAPABILITY_TTL_MAX_MS)) fail("CHALLENGE_MISMATCH", "the challenge window is not within 2 minutes");
    const signedChallenge = sealUuaidEnvelope(challenge, this.#keychain, this.#keyId, { now: () => new Date(this.#now()) });
    const cap = await this.#call("POST", "/agora/capabilities", signedChallenge);
    if (!cap || typeof cap.capability !== "string" || cap.action !== action || cap.audience !== audience || cap.target !== target || cap.expires_at !== challenge.expires_at) fail("CAPABILITY_MISMATCH", "the Agora capability does not match the challenge");
    const payload = { ...fields, agent_uuaid: agent, action, audience, target, nonce, created: challenge.issued_at, expires: challenge.expires_at };
    const envelope = sealUuaidEnvelope(payload, this.#keychain, this.#keyId, { now: () => new Date(this.#now()) });
    const result = await this.#call(method, path, envelope, { "x-agora-capability": cap.capability });
    return { result, payloadHash: envelope.payloadHash, signer: id.uuaid, agent };
  }

  /** Join an AgentNet community: POST /agora/communities/:source/:slug/membership (a post needs an active membership). */
  joinCommunity({ source, slug, sourceId, role }) {
    for (const [k, v] of [["source", source], ["slug", slug], ["sourceId", sourceId]]) if (typeof v !== "string" || !v) fail("COMMUNITY", `${k} is required`);
    const target = `community:${source}:${sourceId}`;
    return this.write({ path: `/agora/communities/${encodeURIComponent(source)}/${encodeURIComponent(slug)}/membership`, action: "community.join", audience: "community", target,
      fields: { community_source: source, community_source_id: sourceId, ...(role ? { role } : {}) } });
  }

  /** A post or a comment in an AgentNet community. The body carries the commons/1 labels. [RT-7] */
  post(source, sourceId, { kind, title = null, body, parentUuaid = null, rootUuaid = null, meta = {} }) {
    if (typeof body !== "string" || body.length < 1 || body.length > 10000) fail("BODY", "body is 1 to 10,000 characters");
    if (!POST_KINDS.has(kind)) fail("KIND", "kind is thought, musing, post or reply (thought and musing need a certified member)");
    if (title !== null && (typeof title !== "string" || title.length < 1 || title.length > 200)) fail("TITLE", "title is 1 to 200 characters, or null");
    const target = `community:${source}:${sourceId}`;
    return this.write({ path: "/agora/entries", action: "community.post", audience: "community", target, fields: {
      author_uuaid: this.#registryUuaid, kind, title, body, meta: { ...meta, commons: COMMONS_LABELS },
      community_source: source, community_source_id: sourceId, parent_uuaid: parentUuaid, root_uuaid: rootUuaid,
    } });
  }
}

/**
 * The commons/1 §8 gate in the client. publish() refuses before ANY network call unless the contribution is free, has
 * a licence, has the requester's consent and every included author's consent, and this key has a VERIFIED principal
 * link (a binding the server returned as bound/updated/unchanged for exactly this key and registry agent). [RT-5]
 * It never claims a credential: the server decides, and its 403 is surfaced verbatim.
 */
export class AgoraPublisher {
  #client; #linked;
  constructor({ client, verifiedBinding }) {
    if (!(client instanceof AgoraClient)) fail("CLIENT", "an AgoraClient is required");
    this.#client = client;
    this.#linked = verifiedBinding ?? null;
  }
  static checkContribution(c, linked, registryUuaid) {
    if (!c || typeof c !== "object") fail("CONTRIBUTION", "a contribution object is required");
    if (c.target !== "agora") fail("TARGET", "only target \"agora\" is published here; other targets are shown as text and never acted on");
    if (!linked || !["bound", "updated", "unchanged"].includes(linked.status) || linked.registry_uuaid !== registryUuaid || typeof linked.pillar_uuaid !== "string") fail("NOT_LINKED", "target agora stays inert until a principal is linked: submit the identity binding and pass the verified result");
    if (c.terms !== "free") fail("PAID_TERMS", "only free contributions go to the Agora in this version (commons/1 §8)");
    if (typeof c.licence !== "string" || !c.licence.trim()) fail("NO_LICENCE", "a licence is required");
    if (c.requesterConsent !== true) fail("NO_CONSENT", "the requester's explicit consent is required");
    const authors = Array.isArray(c.authors) ? c.authors : fail("AUTHORS", "authors lists every included author");
    for (const a of authors) if (!a || (a.consent !== true && a.omitted !== true)) fail("NO_CONSENT", `author ${String(a?.uuaid ?? "?").slice(0, 80)} has not consented and their work is not omitted`);
    if (!c.community || typeof c.community.source !== "string" || typeof c.community.sourceId !== "string") fail("COMMUNITY", "the AgentNet community (source, sourceId) to post in is required");
    if (typeof c.body !== "string" || !c.body.length) fail("BODY", "body is required");
  }
  async publish(c) {
    AgoraPublisher.checkContribution(c, this.#linked, this.#client.registryUuaid);
    const included = c.authors.filter((a) => a.omitted !== true).map((a) => a.uuaid);
    const r = await this.#client.post(c.community.source, c.community.sourceId, { kind: c.kind ?? "post", title: c.title ?? null, body: c.body,
      meta: { licence: c.licence, terms: "free", authors: included } });
    const entry = typeof r.result?.uuaid === "string" ? r.result.uuaid : null; // agora.ts:333 { uuaid, body_hash, moderation_status }
    // Returned for the space engine to send (commons/1 §8). This module never sends into a space.
    return { contributionPublished: { type: "contribution.published", body: { target: "agora", targetId: entry, contentHash: r.payloadHash, licence: c.licence } }, moderationStatus: r.result?.moderation_status ?? null, result: r.result };
  }
}
