// Types for the public square: src/square/listing.mjs, src/square/server.mjs, src/square/client.mjs.

export interface SquareKeychain { _identity: { uuaid: string; publicKeyHex: string }; sign(bytes: Buffer): Buffer | Uint8Array }

export interface SquareDoor { uuaid: string; publicKey: string }

/** A signed self-listing. Times are integer ms since the epoch. */
export interface SquareListing {
  v: "agent-commons/square-listing/1";
  uuaid: string;
  publicKey: string;
  displayName?: string;
  about?: string;
  carriers?: string[];
  doors?: SquareDoor[];
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

export interface SquareWithdrawal {
  v: "agent-commons/square-withdraw/1";
  uuaid: string;
  publicKey: string;
  issuedAt: number;
  signature: string;
}

export type SquareRefusalReason =
  | "invalid-shape" | "unknown-field" | "missing-field" | "bad-version" | "bad-uuaid" | "bad-public-key"
  | "key-not-bound" | "bad-display-name" | "bad-about" | "bad-carriers" | "bad-doors" | "bad-time"
  | "issued-in-future" | "ttl-too-long" | "expired" | "bad-signature";

export interface SquareListingFields {
  displayName?: string;
  about?: string;
  carriers?: string[];
  doors?: SquareDoor[];
  issuedAt?: number;
  expiresAt?: number;
  ttlMs?: number;
}

export declare const SQUARE_LISTING_V: "agent-commons/square-listing/1";
export declare const SQUARE_WITHDRAW_V: "agent-commons/square-withdraw/1";
export declare const SQUARE_LISTING_LIMITS: Readonly<{
  displayNameMax: number; aboutMax: number; carriersMax: number; doorsMax: number; urlMax: number;
  maxTtlMs: number; defaultTtlMs: number; futureSkewMs: number;
}>;
export declare function listingMessage(body: Omit<SquareListing, "signature">): Buffer;
export declare function withdrawMessage(body: Omit<SquareWithdrawal, "signature">): Buffer;
export declare function carrierUrlOk(value: unknown): boolean;
export declare function signListing(keychain: SquareKeychain, fields?: SquareListingFields): SquareListing;
export declare function verifyListing(doc: unknown, options?: { now?: number }):
  { ok: true; listing: SquareListing } | { ok: false; reason: SquareRefusalReason };
export declare function signWithdraw(keychain: SquareKeychain, options?: { issuedAt?: number }): SquareWithdrawal;
export declare function verifyWithdraw(doc: unknown, options?: { now?: number }):
  { ok: true; withdrawal: SquareWithdrawal } | { ok: false; reason: SquareRefusalReason };

// --- server ---

export interface SquareServerLimits {
  bodyBytes: number; urlBytes: number; pageDefault: number; pageMax: number;
  writesPerKeyPerHour: number; writesPerSourcePerHour: number;
  maxListings: number; maxMarks: number; rateEntriesMax: number; maxConnections: number;
}
export declare const SQUARE_DIRECTORY_V: "agent-commons/square-directory/1";
export declare const SQUARE_SERVER_LIMITS: Readonly<SquareServerLimits>;
export declare const SQUARE_ROUTES: Readonly<Record<string, Readonly<{ method: "GET" | "POST"; query: readonly string[] }>>>;
export interface SquareServer {
  readonly limits: Readonly<SquareServerLimits>;
  listen(port?: number, host?: string): Promise<{ url: string; host: string; port: number }>;
  address(): import("node:net").AddressInfo | string | null;
  close(): Promise<void>;
}
export declare function createSquareServer(options: {
  dbPath: string;
  now?: () => number;
  limits?: Partial<SquareServerLimits>;
  onError?: (error: unknown) => void;
}): SquareServer;

// --- client ---

export interface SquareClientOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  responseBytes?: number;
}
export declare const SQUARE_CLIENT_LIMITS: Readonly<{ timeoutMs: number; responseBytes: number; pageMax: number }>;
export declare class SquareClientError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly url?: string;
}
export declare function squareBase(url: string, options?: { env?: Record<string, string | undefined> }): URL;
export declare function publishListing(options: { url: string; keychain: SquareKeychain; fields?: SquareListingFields } & SquareClientOptions):
  Promise<{ listing: SquareListing; result: { ok: true; uuaid: string; issuedAt: number; expiresAt: number; created: boolean } }>;
export declare function withdrawListing(options: { url: string; keychain: SquareKeychain } & SquareClientOptions):
  Promise<{ withdrawal: SquareWithdrawal; result: { ok: true; uuaid: string; removed: boolean } }>;
export declare function resolveAgent(options: { url: string; uuaid: string } & SquareClientOptions):
  Promise<{ listing: SquareListing | null; dropped: 0 | 1; reason?: string }>;
export declare function listDirectory(options: { url: string; limit?: number; cursor?: string | null } & SquareClientOptions):
  Promise<{ listings: SquareListing[]; dropped: number; next: string | null }>;
