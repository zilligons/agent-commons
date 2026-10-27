import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer, request as httpRequest } from "node:http";
import express, { type RequestHandler } from "express";
import { createHostGuard, createOperatorGuard } from "./operator";
import { createRateLimiter, httpErrorHandler, httpSecurityConfig, installApiJsonParser, installHttpSecurity } from "./http-security";

const token = "offline-http-security-fixture";

/** Only the middleware under test and inert fixture routes; no application/storage imports. */
async function fixture(t: TestContext, env: NodeJS.ProcessEnv = {}, extra?: RequestHandler) {
  const lines: string[] = [];
  const app = express();
  installHttpSecurity(app, env, line => lines.push(line));
  if (extra) app.use(extra);
  app.use(createHostGuard(env));
  app.use(createOperatorGuard({ env, token: () => token }));
  installApiJsonParser(app);
  let dispatched = 0;
  app.all("/api/fixture", (req, res) => {
    dispatched++;
    res.json({ code: "FIXTURE_OK", parsed: req.body !== undefined });
  });
  app.all("/outside", (req, res) => res.json({ code: "OUTSIDE_OK", parsed: req.body !== undefined }));
  app.use((_req, res) => res.status(404).json({ code: "FIXTURE_NOT_FOUND" }));
  app.use(httpErrorHandler);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  async function request(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
    return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
      const method = options.method ?? "GET";
      const headers = { ...(["GET", "HEAD"].includes(method) && /^\/api(?:[/?]|$)/i.test(path) ? { authorization: `Bearer ${token}` } : {}), ...options.headers };
      const req = httpRequest(new URL(path, origin), { method, headers }, res => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end(options.body);
    });
  }
  return { origin, lines, request, dispatched: () => dispatched };
}

test("HTTP configuration defaults to socket identity and refuses invalid integer controls", () => {
  assert.deepEqual(httpSecurityConfig({}), { trustProxyHops: 0, rateLimitWindowMs: 60_000, rateLimitMax: 120 });
  assert.deepEqual(httpSecurityConfig({ AGENT_COMMONS_TRUST_PROXY_HOPS: "2", AGENT_COMMONS_RATE_LIMIT_WINDOW_MS: "1000", AGENT_COMMONS_RATE_LIMIT_MAX: "3" }), { trustProxyHops: 2, rateLimitWindowMs: 1000, rateLimitMax: 3 });
  for (const key of ["AGENT_COMMONS_TRUST_PROXY_HOPS", "AGENT_COMMONS_RATE_LIMIT_WINDOW_MS", "AGENT_COMMONS_RATE_LIMIT_MAX"]) {
    for (const value of ["", "-1", "1.5", "true", "1e3", " 1", "9007199254740992"]) assert.throws(() => httpSecurityConfig({ [key]: value }), /must be an integer/);
  }
  for (const key of ["AGENT_COMMONS_RATE_LIMIT_WINDOW_MS", "AGENT_COMMONS_RATE_LIMIT_MAX"]) assert.throws(() => httpSecurityConfig({ [key]: "0" }), /must be an integer/);
});

test("all API reads share a client budget and spoofed forwarded IPs cannot evade the default", async t => {
  const f = await fixture(t, { AGENT_COMMONS_RATE_LIMIT_MAX: "2" });
  assert.equal((await f.request("/api/fixture", { headers: { "x-forwarded-for": "203.0.113.1" } })).status, 200);
  assert.equal((await f.request("/api/unknown", { headers: { "x-forwarded-for": "203.0.113.2" } })).status, 404);
  const limited = await f.request("/API/fixture", { headers: { "x-forwarded-for": "203.0.113.3" } });
  assert.equal(limited.status, 429);
  assert.equal(JSON.parse(limited.body).code, "RATE_LIMITED");
  assert.equal(limited.headers["retry-after"], "60");
  assert(f.lines.every(line => JSON.parse(line).clientIP === "127.0.0.1"));
});

test("one explicitly trusted proxy hop separates client budgets and ignores farther spoofed hops", async t => {
  const f = await fixture(t, { AGENT_COMMONS_TRUST_PROXY_HOPS: "1", AGENT_COMMONS_RATE_LIMIT_MAX: "1" });
  assert.equal((await f.request("/api/fixture", { headers: { "x-forwarded-for": "192.0.2.1, 203.0.113.1" } })).status, 200);
  assert.equal((await f.request("/api/fixture", { headers: { "x-forwarded-for": "192.0.2.2, 203.0.113.1" } })).status, 429);
  assert.equal((await f.request("/api/fixture", { headers: { "x-forwarded-for": "203.0.113.2" } })).status, 200);
  assert.deepEqual(f.lines.map(line => JSON.parse(line).clientIP), ["203.0.113.1", "203.0.113.1", "203.0.113.2"]);
});

test("POST outside the API consumes the same budget while static GETs do not", async t => {
  const f = await fixture(t, { AGENT_COMMONS_RATE_LIMIT_MAX: "1" });
  for (let i = 0; i < 3; i++) assert.equal((await f.request("/outside")).status, 200);
  assert.equal((await f.request("/outside", { method: "POST" })).status, 200);
  assert.equal((await f.request("/api/fixture")).status, 429);
});

test("client budgets reopen after the configured window", async t => {
  let now = 1000;
  const limiter = createRateLimiter({ trustProxyHops: 0, rateLimitWindowMs: 100, rateLimitMax: 1 }, () => now);
  const f = await fixture(t, {}, limiter);
  assert.equal((await f.request("/api/fixture")).status, 200);
  assert.equal((await f.request("/api/fixture")).status, 429);
  now = 1100;
  assert.equal((await f.request("/api/fixture")).status, 200);
});

test("logger records Host/auth/Origin denials before routes using only the five permitted fields", async t => {
  const f = await fixture(t);
  const secret = "offline-request-secret";
  assert.equal((await f.request("/api/fixture?private=" + secret, { headers: { host: "foreign.invalid", authorization: secret, cookie: secret } })).status, 403);
  assert.equal((await f.request("/api/fixture", { method: "POST", body: secret })).status, 401);
  assert.equal((await f.request("/api/fixture", { method: "POST", headers: { authorization: `Bearer ${token}` } })).status, 403);
  assert.equal(f.dispatched(), 0);
  assert.deepEqual(f.lines.map(line => JSON.parse(line).code), ["HOST_FORBIDDEN", "OPERATOR_AUTH_REQUIRED", "ORIGIN_REQUIRED"]);
  for (const line of f.lines) {
    assert.deepEqual(Object.keys(JSON.parse(line)), ["method", "path", "status", "code", "clientIP"]);
    assert(!line.includes(secret));
    assert(!line.includes(token));
    assert(!line.includes("?"));
  }
});

test("API JSON errors have fixed responses, a small body limit and sanitized request logs", async t => {
  const f = await fixture(t);
  const headers = { authorization: `Bearer ${token}`, origin: f.origin, "content-type": "application/json" };
  const secret = "offline-json-secret";
  const malformed = await f.request("/api/fixture", { method: "POST", headers, body: `{"${secret}":` });
  assert.equal(malformed.status, 400);
  assert.deepEqual(JSON.parse(malformed.body), { code: "INVALID_JSON", message: "Malformed JSON request" });
  const large = await f.request("/api/fixture", { method: "POST", headers, body: JSON.stringify({ secret: secret.repeat(4000) }) });
  assert.equal(large.status, 413);
  assert.equal(JSON.parse(large.body).code, "JSON_BODY_TOO_LARGE");
  const valid = await f.request("/api/fixture", { method: "POST", headers, body: "{}" });
  assert.equal(valid.status, 200);
  assert.equal(f.dispatched(), 1);
  assert.deepEqual(f.lines.map(line => JSON.parse(line).code), ["INVALID_JSON", "JSON_BODY_TOO_LARGE", "FIXTURE_OK"]);
  assert(f.lines.every(line => !line.includes(secret)));
});

test("JSON outside the API is not parsed and Sol generation stays default-off", async t => {
  const f = await fixture(t);
  const response = await f.request("/outside", { method: "POST", headers: { "content-type": "application/json" }, body: "{malformed" });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).parsed, false);
  assert.equal((await f.request("/api/cohort/sol-generation-check", { method: "POST" })).status, 404);
  assert.equal(f.dispatched(), 0);
});

test("production security headers cover successful and rejected requests with a self-only policy", async t => {
  const f = await fixture(t, { NODE_ENV: "production" });
  for (const headers of [{}, { host: "foreign.invalid" }]) {
    const response = await f.request("/api/fixture", { headers });
    const policy = String(response.headers["content-security-policy"]);
    assert(policy.includes("frame-ancestors 'none'"));
    for (const kind of ["script", "style", "font", "connect"]) assert(policy.includes(`${kind}-src 'self'`));
    assert(!/unsafe-inline|https?:|wss?:/.test(policy));
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["referrer-policy"], "no-referrer");
    assert.equal(response.headers["x-frame-options"], "DENY");
    assert.equal(response.headers["strict-transport-security"], "max-age=31536000; includeSubDomains");
    assert.equal(response.headers["x-powered-by"], undefined);
  }
});

test("development allows only Vite inline injection and same-Host WebSocket connections", async t => {
  const f = await fixture(t, { NODE_ENV: "development", AGENT_COMMONS_ALLOWED_HOSTS: "preview.example" });
  const response = await f.request("/outside", { headers: { host: "preview.example" } });
  const policy = String(response.headers["content-security-policy"]);
  assert(policy.includes("script-src 'self' 'unsafe-inline'"));
  assert(policy.includes("style-src 'self' 'unsafe-inline'"));
  assert(policy.includes("connect-src 'self' ws://preview.example wss://preview.example"));
  assert(policy.includes("font-src 'self'"));
  assert.equal(response.headers["strict-transport-security"], undefined);
});

test("bare configured public domains work with the preserved Host through a proxy", async t => {
  const f = await fixture(t, { AGENT_COMMONS_ALLOWED_HOSTS: "console.example" });
  const headers = { host: "console.example", origin: "https://console.example", authorization: `Bearer ${token}`, "content-type": "application/json" };
  assert.equal((await f.request("/api/fixture", { method: "POST", headers, body: "{}" })).status, 200);
  assert.equal((await f.request("/api/fixture", { headers: { host: "console.example:443" } })).status, 200);
  assert.equal((await f.request("/api/fixture", { headers: { host: "foreign.invalid", "x-forwarded-host": "console.example" } })).status, 403);
  const wrongPort = new URL(f.origin).port === "5000" ? "5001" : "5000";
  assert.equal((await f.request("/api/fixture", { headers: { host: `localhost:${wrongPort}` } })).status, 403);
});
