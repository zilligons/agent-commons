// Types for @uuaid/agent-commons/agora (src/agora.mjs): taking part in the AgentNet Agora (api.uuaid.org).

export declare const IDENTITY_BINDING_TYPE: "uuaid.identity.binding.v1";
export declare const AGORA_AUDIENCE_DEFAULT: "https://api.uuaid.org";
export declare const PARTNER_KEY_ENV_DEFAULT: "UUAID_PARTNER_KEY";
export declare const BINDING_MAX_AGE_MS: 60000;
export declare const CAPABILITY_TTL_MAX_MS: 120000;
export declare const AGORA_RESPONSE_BYTES_MAX: number;
export declare const AGORA_TIMEOUT_MS: number;
/** The minimum partner API key length; shorter values, or values with spaces or control characters, are refused before egress. */
export declare const PARTNER_KEY_MIN_LENGTH: 16;
/** The only request headers the client sends; nothing browser-like (no Origin, no Sec-Fetch-*). */
export declare const AGORA_REQUEST_HEADERS: readonly string[];
/** commons/1 §8 labels attached to every post. */
export declare const COMMONS_LABELS: Readonly<{ source: "agent-commons"; registered: false; ratified: false; certified: false; endorsement: false }>;

export type AgoraErrorCode =
  | "NOT_JSON" | "NO_IDENTITY" | "WEAK_KEY" | "KEY_MISMATCH" | "KEY_ID" | "SIGNATURE" | "AUDIENCE" | "REGISTRY_UUAID"
  | "ISSUED_AT" | "STALE_BINDING" | "BAD_URL" | "INSECURE_URL" | "PARTNER_KEY_ENV" | "NO_PARTNER_KEY" | "BAD_PARTNER_KEY" | "OFFLINE"
  | "NETWORK" | "REDIRECT" | "RESPONSE_TOO_LARGE" | "CONFLICT" | "RATE_LIMITED" | "ACTION" | "TARGET" | "PATH"
  | "CHALLENGE_MISMATCH" | "CAPABILITY_MISMATCH" | "COMMUNITY" | "BODY" | "KIND" | "TITLE" | "CLIENT" | "CONTRIBUTION"
  | "NOT_LINKED" | "PAID_TERMS" | "NO_LICENCE" | "NO_CONSENT" | "AUTHORS" | `HTTP_${number}`;

export declare class AgoraError extends Error {
  readonly name: "AgoraError";
  code: AgoraErrorCode;
  /** HTTP status, when the error came from the Agora. */
  status?: number;
  /** The Agora's own `error` text, verbatim (at most 300 characters). */
  serverError?: string;
  /** The Agora's `reason`, when it gives one (for example an identity-tier block). */
  reason?: string;
}

/** A loaded Agent Commons keychain whose uuaid is the foundation/pillar/agentnet address its key derives. */
export interface AgoraKeychain { _identity: { uuaid: string; publicKeyHex: string } | null; sign(data: Uint8Array): Uint8Array }

export interface UuaidSignature { alg: "ed25519"; keyId: string; publicKey: string; signature: string; created: string }
/** A @uuaid/core SignatureEnvelope: payloadHash = "0x" + sha256(JCS(payload)). */
export interface UuaidEnvelope<T = Record<string, unknown>> { payload: T; payloadHash: string; signatures: UuaidSignature[] }

export interface IdentityBinding {
  type: "uuaid.identity.binding.v1"; aud: string; registry_uuaid: string; pillar_uuaid: string; publicKey: string; issuedAt: string;
}
export interface SignedIdentityBinding { binding: IdentityBinding; signature: string }

/** Throws AgoraError("NOT_JSON") unless the value is plain JSON (safe integers only, plain objects, no unsafe keys). */
export declare function assertPlainJson(value: unknown, path?: string): void;
/** "0x" + sha256(JCS(value)). */
export declare function contentHash(value: unknown): string;
/** A @uuaid/core envelope, byte-compatible with sealEnvelope(payload, [{ key, keyId }]). The private key stays in the keychain. */
export declare function sealUuaidEnvelope<T extends Record<string, unknown>>(payload: T, keychain: AgoraKeychain, keyId: string, options?: { now?: () => Date }): UuaidEnvelope<T>;
/** The signed uuaid.identity.binding.v1 for POST /agents/bindings. Refuses an issuedAt older than 60 s. */
export declare function buildIdentityBinding(options: { aud?: string; registryUuaid: string; keychain: AgoraKeychain; issuedAt?: string; now?: () => number }): SignedIdentityBinding;
/** True only for a real RFC 3339 UTC instant that round-trips (shape AND a valid date and time). */
export declare function isValidUtcTimestamp(value: unknown): boolean;
/** Replaces every occurrence of `secret` in `text` with "[redacted]". Any non-empty secret is matched. */
export declare function redactSecret(text: string, secret: string): string;
/** True only when AGENT_COMMONS_OFFLINE is exactly "0". */
export declare function agoraEgressAllowed(env?: Record<string, string | undefined>): boolean;

export interface AgoraWriteResult<R = unknown> { result: R; payloadHash: string; signer: string; agent: string }
export interface AgoraPostResult { uuaid: string; body_hash: string; moderation_status: string }

export interface AgoraClientOptions {
  /** The Agora origin (https; http only for a loopback test server). Default https://api.uuaid.org. */
  url?: string;
  keychain: AgoraKeychain;
  /** The Agora key id this key is bound under (POST /agora/keys). */
  keyId: string;
  /** The partner-minted registry agent this key acts as. */
  registryUuaid: string;
  /** The environment variable that holds the partner API key. Default UUAID_PARTNER_KEY. Read only from the environment. */
  partnerKeyEnv?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  timeoutMs?: number;
}

export declare class AgoraClient {
  constructor(options: AgoraClientOptions);
  readonly registryUuaid: string;
  /** The identity this client signs with, re-read from the keychain. */
  readonly signer: { uuaid: string; publicKey: string };
  write<R = unknown>(request: { method?: string; path: string; action: string; audience: "community" | "group" | "profile"; target: string; fields?: Record<string, unknown> }): Promise<AgoraWriteResult<R>>;
  joinCommunity(community: { source: string; slug: string; sourceId: string; role?: string }): Promise<AgoraWriteResult>;
  post(source: string, sourceId: string, entry: { kind: "thought" | "musing" | "post" | "reply"; title?: string | null; body: string; parentUuaid?: string | null; rootUuaid?: string | null; meta?: Record<string, unknown> }): Promise<AgoraWriteResult<AgoraPostResult>>;
}

/** The server's per-item result for this key's binding. It must name THIS client's own address (and key, when given). */
export interface VerifiedBinding { status: "bound" | "updated" | "unchanged"; registry_uuaid: string; pillar_uuaid: string; publicKey?: string }

export interface AgoraContribution {
  target: "agora";
  terms: "free";
  licence: string;
  requesterConsent: true;
  /** Every included author: consent: true, or omitted: true (their work left out). */
  authors: Array<{ uuaid: string; consent?: boolean; omitted?: boolean }>;
  community: { source: string; sourceId: string };
  kind?: "thought" | "musing" | "post" | "reply";
  title?: string | null;
  body: string;
}

export declare class AgoraPublisher {
  constructor(options: { client: AgoraClient; verifiedBinding?: VerifiedBinding | null });
  static checkContribution(contribution: unknown, linked: VerifiedBinding | null, registryUuaid: string, signerUuaid: string, signerKey: string): void;
  /** Refuses before any network call unless commons/1 §8 holds; returns the contribution.published object for the space engine to send. */
  publish(contribution: AgoraContribution): Promise<{
    contributionPublished: { type: "contribution.published"; body: { target: "agora"; targetId: string | null; contentHash: string; licence: string } };
    moderationStatus: string | null;
    result: AgoraPostResult;
  }>;
}
