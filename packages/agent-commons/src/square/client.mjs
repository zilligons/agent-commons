// The public square: the client. It trusts the square for nothing but delivery: every listing it
// returns has passed verifyListing HERE (signature, key-to-UUAID binding, bounds, expiry), so a
// square that alters, forges or substitutes a listing only gets it dropped, and the drop is counted.
// A square can still withhold a listing, or serve an older one that has not expired.
//
// Egress: offline mode (src/offline.mjs) refuses any non-loopback square before a single byte is
// sent; plain http is refused for any non-loopback host whatever the mode; redirects are never
// followed (a loopback square must not be able to bounce a request out); every call has a timeout
// and a response size cap.

import { isLoopbackUrl, isOffline } from "../offline.mjs";
import { SELF_CERTIFYING_AGENT_UUAID } from "../uuaid-namespace.mjs";
import { signListing, signWithdraw, verifyListing } from "./listing.mjs";

export const SQUARE_CLIENT_LIMITS = Object.freeze({ timeoutMs: 10000, responseBytes: 2 * 1024 * 1024, pageMax: 100 });

export class SquareClientError extends Error {
  constructor(code, { status = null, url = null } = {}) {
    super(status === null ? `square: ${code}` : `square: ${code} (HTTP ${status})`);
    this.name = "SquareClientError";
    this.code = code;
    this.status = status;
    if (url !== null) this.url = url;
  }
}

/** The base URL, checked before any network use. Throws SquareClientError("offline" | "bad-url" | "insecure-url"). */
export function squareBase(url, { env = process.env } = {}) {
  let base;
  try { base = new URL(String(url)); } catch { throw new SquareClientError("bad-url"); }
  if ((base.protocol !== "https:" && base.protocol !== "http:") || base.username || base.password || base.search || base.hash) throw new SquareClientError("bad-url");
  const loopback = isLoopbackUrl(base.href);
  if (isOffline(env) && !loopback) {
    const error = new SquareClientError("offline", { url: base.origin });
    error.message = `offline: refused outbound square call to ${base.origin}`;
    throw error;
  }
  if (base.protocol === "http:" && !loopback) throw new SquareClientError("insecure-url");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return base;
}

async function readCapped(res, cap) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) { await res.body?.cancel().catch(() => {}); throw new SquareClientError("response-too-large", { status: res.status }); }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > cap) { await reader.cancel().catch(() => {}); throw new SquareClientError("response-too-large", { status: res.status }); }
    chunks.push(value);
  }
  return Buffer.concat(chunks, n);
}

const ERROR_CODE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** One request. Resolves { status, body } for any JSON response; throws on transport failure. */
async function call(base, target, { method = "GET", body, timeoutMs, fetchImpl, responseBytes }) {
  const url = new URL(target, base);
  const signal = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      method, redirect: "error", credentials: "omit", signal,
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || signal.aborted) throw new SquareClientError("timeout");
    // undici: TypeError("fetch failed") with cause "redirect mode is set to error".
    throw new SquareClientError(/redirect/i.test(String(error?.cause?.message ?? "")) ? "redirect-refused" : "network");
  }
  if (res.status >= 300 && res.status < 400) { await res.body?.cancel().catch(() => {}); throw new SquareClientError("redirect-refused", { status: res.status }); }
  let bytes;
  try { bytes = await readCapped(res, responseBytes); } catch (error) {
    if (error instanceof SquareClientError) throw error;
    throw new SquareClientError(signal.aborted ? "timeout" : "network", { status: res.status });
  }
  let parsed;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new SquareClientError("bad-response", { status: res.status }); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new SquareClientError("bad-response", { status: res.status });
  return { status: res.status, body: parsed };
}

function refused(status, body) {
  const code = typeof body?.error === "string" && ERROR_CODE.test(body.error) ? body.error : `http-${status}`;
  return new SquareClientError(code, { status });
}

function options({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = SQUARE_CLIENT_LIMITS.timeoutMs, now = () => Date.now(), responseBytes = SQUARE_CLIENT_LIMITS.responseBytes }) {
  if (typeof fetchImpl !== "function") throw new SquareClientError("no-fetch");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("square: timeoutMs must be a positive integer");
  if (typeof now !== "function") throw new TypeError("square: now must be a function");
  return { env, fetchImpl, timeoutMs, now, responseBytes };
}

/** Sign this keychain's listing and publish it. Resolves { listing, result } (result: the square's reply). */
export async function publishListing({ url, keychain, fields = {}, ...rest }) {
  const o = options(rest);
  const base = squareBase(url, o);
  const listing = signListing(keychain, { issuedAt: o.now(), ...fields });
  const res = await call(base, "v1/square/listings", { ...o, method: "POST", body: listing });
  if (res.status !== 200 || res.body.ok !== true) throw refused(res.status, res.body);
  return { listing, result: res.body };
}

/** Sign and send a withdrawal of this keychain's listing. Resolves { withdrawal, result }. */
export async function withdrawListing({ url, keychain, ...rest }) {
  const o = options(rest);
  const base = squareBase(url, o);
  const withdrawal = signWithdraw(keychain, { issuedAt: o.now() });
  const res = await call(base, "v1/square/withdraw", { ...o, method: "POST", body: withdrawal });
  if (res.status !== 200 || res.body.ok !== true) throw refused(res.status, res.body);
  return { withdrawal, result: res.body };
}

/**
 * Resolve one agent. Resolves { listing, dropped }: `listing` is a listing for exactly that uuaid that
 * verified here, or null (not listed, or the square's answer did not verify; then dropped is 1).
 */
export async function resolveAgent({ url, uuaid, ...rest }) {
  const o = options(rest);
  if (typeof uuaid !== "string" || !SELF_CERTIFYING_AGENT_UUAID.test(uuaid)) throw new SquareClientError("bad-uuaid");
  const base = squareBase(url, o);
  const res = await call(base, `v1/square/resolve?uuaid=${encodeURIComponent(uuaid)}`, o);
  if (res.status === 404) return { listing: null, dropped: 0 };
  if (res.status !== 200) throw refused(res.status, res.body);
  const v = verifyListing(res.body.listing, { now: o.now() });
  if (!v.ok || v.listing.uuaid !== uuaid) return { listing: null, dropped: 1, reason: v.ok ? "uuaid-mismatch" : v.reason };
  return { listing: v.listing, dropped: 0 };
}

/**
 * Read one directory page. Resolves { listings, dropped, next }: only listings that verified here (a
 * repeated uuaid counts as dropped), and `next`, the cursor for the following page or null.
 */
export async function listDirectory({ url, limit, cursor, ...rest }) {
  const o = options(rest);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > SQUARE_CLIENT_LIMITS.pageMax)) {
    const error = new SquareClientError("bad-limit");
    error.message = `square: bad-limit (limit is an integer from 1 to ${SQUARE_CLIENT_LIMITS.pageMax}; page with --cursor)`;
    throw error;
  }
  if (cursor !== undefined && cursor !== null && (typeof cursor !== "string" || !SELF_CERTIFYING_AGENT_UUAID.test(cursor))) throw new SquareClientError("bad-cursor");
  const base = squareBase(url, o);
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (cursor) params.set("cursor", cursor);
  const qs = params.toString();
  const res = await call(base, `v1/square/directory${qs ? `?${qs}` : ""}`, o);
  if (res.status !== 200) throw refused(res.status, res.body);
  if (!Array.isArray(res.body.listings)) throw new SquareClientError("bad-response", { status: res.status });
  const t = o.now();
  const listings = [], seen = new Set();
  let dropped = 0;
  for (const doc of res.body.listings) {
    const v = verifyListing(doc, { now: t });
    if (!v.ok || seen.has(v.listing.uuaid)) { dropped += 1; continue; }
    seen.add(v.listing.uuaid);
    listings.push(v.listing);
  }
  const next = typeof res.body.next === "string" && SELF_CERTIFYING_AGENT_UUAID.test(res.body.next) ? res.body.next : null;
  return { listings, dropped, next };
}
