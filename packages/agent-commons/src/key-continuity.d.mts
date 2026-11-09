export declare const KEY_CONTINUITY_V: "agent-commons/key-continuity/1";
export declare const KEY_CONTINUITY_RELATIONS: readonly ["rotation", "additional-door"];
export declare const KEY_CONTINUITY_STATEMENT_MAX: 500;
export declare const KEY_CONTINUITY_NOTE: "Local policy grant via verified key-continuity; not certification";

export type KeyContinuityRelation = "rotation" | "additional-door";

export type KeyContinuityErrorCode =
  | "SHAPE" | "VERSION" | "RELATION" | "OLD_KEY_BINDING" | "NEW_KEY_BINDING" | "SAME_KEY" | "SAME_UUAID"
  | "OLD_WEAK_KEY" | "NEW_WEAK_KEY" | "NONCE" | "ISSUED_AT" | "FUTURE" | "STATEMENT" | "OLD_SIGNATURE"
  | "NEW_SIGNATURE" | "CLOCK" | "KEYCHAIN_NOT_LOADED"
  | "OLD_NOT_ADMITTED" | "OLD_KEY_MISMATCH" | "OLD_BLOCKED" | "DUPLICATE_KEY" | "NEW_BLOCKED"
  | "NEW_KEY_ADMITTED_ELSEWHERE" | "NEW_KEY_CONFLICT" | "CONTINUITY_REPLAYED";

/** A key-derived agent UUAID in a self-certifying namespace and the 64-hex Ed25519 key that owns it. */
export interface KeyContinuityParty { uuaid: string; publicKey: string }

/** The signed body. Preimage = UTF-8 of `${KEY_CONTINUITY_V}\n` + jcs(body). */
export interface KeyContinuityBody {
  v: "agent-commons/key-continuity/1";
  relation: KeyContinuityRelation;
  old: KeyContinuityParty;
  new: KeyContinuityParty;
  /** ISO-8601 UTC, millisecond precision. */
  issuedAt: string;
  /** 32 lower-case hex characters. */
  nonce: string;
  /** At most 500 code points, well-formed Unicode. */
  statement?: string;
}

export interface KeyContinuityDocument extends KeyContinuityBody {
  /** 128 hex: old key's Ed25519 signature over the preimage (the vouch). */
  oldSignature: string;
  /** 128 hex: new key's Ed25519 signature over the same preimage (acceptance). */
  newSignature: string;
}

/** Any loaded keychain: a vendored Pillar Keychain after load() or save(). */
export interface LoadedKeychain {
  _identity: { uuaid: string; publicKeyHex: string } | null;
  sign(data: Uint8Array): Buffer;
}

/** The CommonsStore methods admitByContinuity uses (src/store.mjs). */
export interface KeyContinuityStore {
  transaction<T>(fn: () => T): T;
  seen(id: string, hash?: string | null): boolean;
  mark(id: string, hash: string): void;
  append(id: string, event: unknown): { id: string; hash: string; previous?: string; duplicate?: boolean };
}

export declare class KeyContinuityError extends Error {
  readonly name: "KeyContinuityError";
  code: KeyContinuityErrorCode;
  constructor(code: KeyContinuityErrorCode, message: string);
}

export declare function keyContinuityPreimage(body: KeyContinuityBody): Buffer;

export declare function createKeyContinuity(options: {
  oldKeychain: LoadedKeychain;
  newKeychain: LoadedKeychain;
  relation: KeyContinuityRelation;
  statement?: string;
  /** Default: now. Normalized to ISO-8601 with millisecond precision. */
  issuedAt?: string | number | Date;
}): KeyContinuityDocument;

/** Pure and offline. Returns a fresh copy of the verified body; throws KeyContinuityError. */
export declare function verifyKeyContinuity(
  doc: unknown,
  options?: { now?: number; maxFutureSkewMs?: number },
): KeyContinuityBody;

/** sha256 hex over the JCS of the whole signed document. */
export declare function keyContinuityDigest(doc: KeyContinuityDocument): string;

export interface KeyContinuityAdmission {
  admitted: string;
  from: string;
  relation: KeyContinuityRelation;
  capabilities: string[];
  docDigest: string;
  /** Always true: the old key is never removed automatically. */
  oldKeyStillAdmitted: true;
  /** Always false: a registry credential names one subject UUAID. */
  credentialCopied: false;
  note: "Local policy grant via verified key-continuity; not certification";
  /** Present when the new key was already admitted under new.uuaid; the existing grant is left untouched. */
  alreadyAdmitted?: true;
  /** Old-grant fields carried to the new grant (subset of controllerId, affiliations, tenantId, conflicts). */
  carried?: string[];
  /** Present in global mode: the new UUAID needs its own pinned registry credential. */
  registryCredentialRequired?: true;
  /** The audit event written to the home's commons store. */
  audit?: { id: string; hash: string };
}

export declare function admitByContinuity(options: {
  /** Agent Commons home; default ~/.agent-commons. */
  home?: string;
  doc: unknown;
  /** An already open store for the same home; when omitted, home/commons.db is opened and closed. */
  store?: KeyContinuityStore | null;
  now?: number;
  maxFutureSkewMs?: number;
}): KeyContinuityAdmission;
