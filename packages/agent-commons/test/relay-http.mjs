// Shared helpers for the L1 HTTP tests: a relay on 127.0.0.1 in test mode over a fixture database,
// node:http requests (fetch would add Sec-Fetch-Mode), 6.1-signed requests, and a 6.2 check of the
// relay signature on every response. Loopback only; fixture keys; scratch directories.

import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { startRelay } from "../src/relay/server.mjs";
import { IDENTITY_AUTH_HEADER, PRINCIPAL_HEADER, RELAY_TEST_AUD, RELAY_SIG_HEADER, signIdentityRequest, verifyRelayResponse } from "../src/relay/auth.mjs";
import { keySeedHex, T0 } from "./relay-fixtures.mjs";

export const TMP = realpathSync(tmpdir());
export const iso = (ms) => new Date(ms).toISOString();

/** A private test-mode directory holding the clock file. */
export function testDir(at = T0) {
  const dir = mkdtempSync(join(TMP, "relay-l1-tm-"));
  writeFileSync(join(dir, "clock"), `${at}\n`, { mode: 0o600 });
  return dir;
}

/** A relay on 127.0.0.1 in test mode over `fx.db`, with a fake sweep scheduler and an in-memory access log. */
export async function relayFor(fx, { at = T0, relayKeySeedHex = randomBytes(32).toString("hex") } = {}) {
  const dir = testDir(at);
  const log = [], timers = [], errors = [];
  const scheduler = { setInterval: (fn, ms) => { const h = { fn, ms, cleared: false }; timers.push(h); return h; }, clearInterval: (h) => { h.cleared = true; } };
  const r = await startRelay({ db: fx.db, aud: RELAY_TEST_AUD, host: "127.0.0.1", port: 0, testMode: true, testDir: dir,
    relayKeySeedHex, accessLog: (e) => log.push(e), onError: (e) => errors.push(e), scheduler });
  let clock = at;
  return { r, dir, log, timers, errors, fx, now: () => clock, setClock: (ms) => { clock = ms; writeFileSync(join(dir, "clock"), `${ms}\n`); } };
}

/** One HTTP/1.1 request over loopback. */
export function call(port, { method = "GET", path, headers = {}, raw, body }) {
  const bytes = raw ?? (body === undefined ? null : Buffer.from(JSON.stringify(body)));
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, agent: false,
      headers: { "user-agent": "fixture-agent/1", ...(bytes ? { "content-length": bytes.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, headers: res.headers, text, body: text ? JSON.parse(text) : undefined });
      });
    });
    req.on("error", reject);
    if (bytes) req.end(bytes); else req.end();
  });
}

/** A request signed per 6.1 with a 32-byte key seed (hex) at relay time `at`. */
export function signedSeed(seedHex, method, target, body, at, { audience = RELAY_TEST_AUD, headers = {} } = {}) {
  const [path, query = ""] = target.split("?");
  const s = signIdentityRequest({ seedHex, method, path, query, body, audience, created: iso(at) });
  return { method, path: target, body, headers: { [IDENTITY_AUTH_HEADER]: s.header, [PRINCIPAL_HEADER]: s.agent, ...headers } };
}
/** A request signed per 6.1 by a fixture identity. */
export const signed = (identity, method, target, body, at, opts) => signedSeed(keySeedHex(identity), method, target, body, at, opts);

const ENROLL_PATHS = new Set(["/v1/enroll", "/v1/rekey", "/v1/rebind"]);
/** The nonce a response must bind (6.2): the 6.1 header's, or an enrollment-flow body's. */
export function nonceOf(req) {
  const header = /nonce=([0-9a-f]+)/.exec(req.headers?.[IDENTITY_AUTH_HEADER] ?? "")?.[1];
  if (header) return header;
  const n = ENROLL_PATHS.has(req.path) ? req.body?.nonce : undefined;
  return typeof n === "string" && /^[0-9a-f]{32,64}$/.test(n) ? n : null;
}

/**
 * 6.2: the response verifies against the relay key over {aud, request_nonce, status, body_sha256};
 * tampering breaks it. An enrollment-flow refusal made before the body was read binds null (never a 200).
 */
export function assertSigned(t, req, res) {
  const sig = res.headers[RELAY_SIG_HEADER];
  let nonce = nonceOf(req);
  if (nonce && !req.headers?.[IDENTITY_AUTH_HEADER] && res.status !== 200
      && !verifyRelayResponse(t.r.publicKey, { aud: RELAY_TEST_AUD, requestNonce: nonce, status: res.status, body: res.body }, sig)) nonce = null;
  const response = { aud: RELAY_TEST_AUD, requestNonce: nonce, status: res.status, body: res.body };
  assert.equal(verifyRelayResponse(t.r.publicKey, response, sig), true, `${req.method} ${req.path} -> ${res.status} is relay-signed`);
  assert.equal(verifyRelayResponse(t.r.publicKey, { ...response, status: res.status + 1 }, sig), false, "a changed status breaks it");
  assert.equal(verifyRelayResponse(t.r.publicKey, { ...response, requestNonce: "f".repeat(32) }, sig), false, "another request's nonce breaks it");
}

/** Send and check the relay signature. */
export async function send(t, req) {
  const res = await call(t.r.port, req);
  assertSigned(t, req, res);
  return res;
}
