import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { createHostGuard, createOperatorGuard, installUpgradeHostGuard } from "./operator";

const fixtureToken = "offline-operator-fixture";
const local = { host: "127.0.0.1:5000", origin: "http://127.0.0.1:5000", authorization: `Bearer ${fixtureToken}` };
function call(guard: ReturnType<typeof createOperatorGuard>, headers: Record<string,string> = {}, method = "POST", path = "/api/cohort/start") {
  let status = 200, continued = false, body: any = null;
  guard({ path, method, socket: { localPort: 5000 }, get: (name: string) => headers[name] } as any,
    { status(code: number) { status = code; return this; }, json(value: unknown) { body = value; return this; } } as any,
    () => { continued = true; });
  return { status, continued, body };
}

for (const node of ["development", "test", "production"]) test(`all API reads and mutations fail closed without operator configuration in ${node}`, () => {
  const guard = createOperatorGuard({ env: { NODE_ENV: node, AGENT_COMMONS_PRIVATE_PREVIEW: "1" }, token: () => undefined });
  assert.equal(call(guard, local).status, 503);
  assert.equal(call(guard, local).body.code, "OPERATOR_UNCONFIGURED");
  assert.equal(call(guard, {}, "GET").status, 503);
  assert.equal(call(guard, {}, "HEAD").status, 503);
});

test("token authentication precedes required Origin and has no short/long token bypass", () => {
  const guard = createOperatorGuard({ env: {}, token: () => fixtureToken });
  assert.equal(call(guard).status, 401);
  for (const value of ["Bearer x", "Bearer " + "x".repeat(1000)]) assert.equal(call(guard, { ...local, authorization: value }).status, 401);
  assert.equal(call(guard, { host: local.host, authorization: local.authorization }).status, 403);
  assert.equal(call(guard, local).continued, true);
  assert.equal(call(guard, { ...local, host: "preview.example", origin: "https://preview.example" }).continued, true);
  assert.equal(call(guard, { ...local, origin: "https://evil.invalid", "x-forwarded-host": "evil.invalid" }).status, 403);
  assert.equal(call(guard, {}, "GET").status, 401);
  assert.equal(call(guard, {}, "POST", "/api/cohort/sol-generation-check").status, 404);
});

test("GET and HEAD require exact operator authentication on every API path without requiring Origin", () => {
  const guard = createOperatorGuard({ env: {}, token: () => fixtureToken });
  for (const method of ["GET", "HEAD"]) for (const path of ["/api", "/api/state", "/api/cohort", "/api/cohort/export", "/api/export", "/api/network", "/api/network/contributions/fixture"]) {
    assert.equal(call(guard, {}, method, path).status, 401);
    assert.equal(call(guard, { authorization: "Bearer incorrect" }, method, path).status, 401);
    assert.equal(call(guard, { authorization: local.authorization }, method, path).continued, true);
  }
  assert.equal(call(guard, {}, "GET", "/").continued, true);
  assert.equal(call(guard, {}, "GET", "/assets/fixture.js").continued, true);
  assert.equal(call(guard, {}, "OPTIONS", "/api/cohort").continued, true);
});

test("private preview origins require the valid token and explicit preview mode", () => {
  const env = { AGENT_COMMONS_PRIVATE_PREVIEW: "1", AGENT_COMMONS_PREVIEW_ORIGINS: "https://preview.example" };
  const guard = createOperatorGuard({ env, token: () => fixtureToken });
  assert.equal(call(guard, { ...local, origin: "https://preview.example" }).continued, true);
  assert.equal(call(guard, { ...local, origin: "https://preview.example", authorization: "wrong" }).status, 401);
  assert.equal(call(createOperatorGuard({ env: { AGENT_COMMONS_PREVIEW_ORIGINS: "https://preview.example" }, token: () => fixtureToken }), { ...local, origin: "https://preview.example" }).status, 403);
});

test("Host guard covers API and Vite paths, bare custom domains, IPv6 and actual loopback port", () => {
  const guard = createHostGuard({ PORT: "9999", AGENT_COMMONS_ALLOWED_HOSTS: "preview.example" });
  for (const host of ["127.0.0.1:5000", "LOCALHOST:5000", "[::1]:5000", "preview.example", "preview.example:5000", "PREVIEW.EXAMPLE:443"]) assert.equal(call(guard, { host }, "GET", "/@vite/client").continued, true);
  for (const method of ["GET", "POST"]) for (const host of ["evil.invalid:5000", "localhost:9999", "127.0.0.1.evil:5000", "localhost:5000@evil.invalid", "localhost:5000,evil.invalid"]) assert.equal(call(guard, { host, "x-forwarded-host": "localhost:5000" }, method).status, 403);
});

test("malformed allowed-host configuration refuses startup instead of silently dropping entries", () => {
  for (const host of ["https://preview.example", "preview.example:443", "*.invalid", "good.example,", "bad..example", "-bad.example", "bad_.example", "good.example/path"]) {
    assert.throws(() => createHostGuard({ AGENT_COMMONS_ALLOWED_HOSTS: host }), /bare hostnames/);
    assert.throws(() => installUpgradeHostGuard(new EventEmitter() as unknown as Server, { AGENT_COMMONS_ALLOWED_HOSTS: host }), /bare hostnames/);
  }
});

test("foreign Host upgrade sockets are destroyed before the HMR recorder while loopback upgrades remain usable", () => {
  const server = new EventEmitter(); let accepted = 0;
  installUpgradeHostGuard(server as unknown as Server, {});
  server.on("upgrade", (_request, socket) => { if (!socket.destroyed) accepted++; });
  const emit = (host: string) => {
    const socket = { destroyed: false, destroy() { this.destroyed = true; } };
    server.emit("upgrade", { headers: { host }, socket: { localPort: 5000 } }, socket);
    return socket.destroyed;
  };
  assert.equal(emit("evil.invalid:5000"), true);
  assert.equal(accepted, 0);
  assert.equal(emit("localhost:5000"), false);
  assert.equal(accepted, 1);
});
