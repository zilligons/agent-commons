import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createServer } from "node:http";
import express from "express";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import CohortConsole from "../client/src/CohortConsole";
import NetworkConsole, { httpsDocumentUrl } from "../client/src/NetworkConsole";
import OperatorAccess from "../client/src/OperatorAccess";
import { apiRequest, getQueryFn, queryClient } from "../client/src/lib/queryClient";
import { buildOperatorRequest, clearOperatorToken, hasOperatorToken, operatorTokenSnapshot, setOperatorToken, subscribeOperatorToken } from "../client/src/lib/operatorToken";
import { createHostGuard, createOperatorGuard } from "./operator";

const fixtureToken = "unit-only-operator-authentication-value";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; clearOperatorToken(); });

test("memory-only token authenticates same-origin API reads and mutations, and Clear removes access", () => {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const name of ["localStorage", "sessionStorage", "document"]) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error("Persistence must not be accessed"); } });
  }
  try {
    setOperatorToken(fixtureToken);
    assert.equal(hasOperatorToken(), true);
    for (const action of ["start", "pause", "probe", "import"]) {
      const request = buildOperatorRequest("POST", `/api/cohort/${action}`, {});
      assert.equal(new Headers(request.init.headers).get("authorization"), `Bearer ${fixtureToken}`);
      assert.equal(request.init.mode, "same-origin");
      assert.equal(request.init.redirect, "error");
      assert.equal(request.url.includes(fixtureToken), false);
    }
    for (const method of ["GET", "HEAD", "OPTIONS"]) assert.equal(new Headers(buildOperatorRequest(method, "/api/cohort/export").init.headers).get("authorization"), `Bearer ${fixtureToken}`);
    for (const url of ["https://foreign.invalid/api/cohort/start", "//foreign.invalid/api/cohort/start", "/" + String.fromCharCode(92) + "foreign.invalid/api/cohort/start"]) assert.throws(() => buildOperatorRequest("POST", url, {}));
    clearOperatorToken();
    assert.equal(hasOperatorToken(), false);
    assert.throws(() => buildOperatorRequest("POST", "/api/cohort/start", {}), /Save an operator token/);
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test("actual client builder authenticates GET, HEAD, query and exports against real guards without read Origin", async t => {
  const app = express();
  app.use(createHostGuard({}));
  app.use(createOperatorGuard({ env: {}, token: () => fixtureToken }));
  app.use(express.json());
  let accepted = 0;
  app.post("/api/cohort/:action", (_req, res) => { accepted++; res.json({ accepted: true }); });
  app.get("/api/cohort", (_req, res) => res.json({ accepted: true }));
  app.get("/api/cohort/export", (_req, res) => res.json({ accepted: true }));
  app.get("/api/network/contributions/fixture", (_req, res) => res.json({ accepted: true }));
  app.get("/api/export", (_req, res) => res.json({ accepted: true }));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const seen: { method: string; authorization: string | null; origin: string | null }[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(typeof input, "string");
    const target = new URL(input as string, origin);
    assert.equal(target.origin, origin);
    assert.equal(init?.mode, "same-origin");
    const method = init?.method ?? "GET", headers = new Headers(init?.headers);
    seen.push({ method, authorization: headers.get("authorization"), origin: headers.get("origin") });
    // Browsers add Origin to same-origin mutations; Node's fetch does not.
    // Only this browser-transport behavior is supplied by the fixture.
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("origin", origin);
    return originalFetch(target, { ...init, headers });
  };
  setOperatorToken(fixtureToken);
  for (const action of ["start", "pause", "probe", "import"]) assert.equal((await apiRequest("POST", `/api/cohort/${action}`, {})).status, 200);
  assert.equal(accepted, 4);
  await apiRequest("GET", "/api/cohort/export");
  await apiRequest("GET", "/api/network/contributions/fixture");
  await apiRequest("GET", "/api/export");
  await apiRequest("HEAD", "/api/cohort");
  await getQueryFn({ on401: "throw" })({ queryKey: ["/api/cohort"] } as any);
  assert.equal(seen.filter(request => request.method === "GET").length, 4);
  assert(seen.every(request => request.authorization === `Bearer ${fixtureToken}`));
  assert(seen.filter(request => ["GET", "HEAD"].includes(request.method)).every(request => request.origin === null));
  for (const path of ["/api/cohort", "/api/cohort/export", "/api/export", "/api/network/contributions/fixture"]) {
    assert.equal((await originalFetch(origin + path)).status, 401);
    assert.equal((await originalFetch(origin + path, { method: "HEAD" })).status, 401);
  }
});

test("locked clients make zero API fetches, including default observed queries", async () => {
  clearOperatorToken();
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("Fixture must not fetch"); };
  for (const method of ["GET", "HEAD", "POST"]) await assert.rejects(() => apiRequest(method, "/api/cohort"), /Save an operator token/);
  await assert.rejects(() => getQueryFn({ on401: "throw" })({ queryKey: ["/api/network"] } as any), /Save an operator token/);
  const observer = new QueryObserver(queryClient, { queryKey: ["/api/state"] });
  const unsubscribe = observer.subscribe(() => {});
  await Promise.resolve();
  unsubscribe();
  assert.equal(calls, 0);
  queryClient.clear();
});

test("shared token revisions clear every sensitive cache when the token changes or clears", () => {
  setOperatorToken(fixtureToken);
  const events: number[] = [];
  const unsubscribe = subscribeOperatorToken(() => events.push(operatorTokenSnapshot().version));
  for (const key of ["/api/cohort", "/api/network", "/api/state"]) queryClient.setQueryData([key], { private: "offline-sensitive-fixture" });
  assert.equal(queryClient.getQueryCache().getAll().length, 3);
  setOperatorToken("another-offline-token-fixture");
  assert.equal(queryClient.getQueryCache().getAll().length, 0);
  queryClient.setQueryData(["/api/cohort"], { private: "offline-sensitive-fixture" });
  clearOperatorToken();
  assert.equal(queryClient.getQueryCache().getAll().length, 0);
  assert.equal(operatorTokenSnapshot().configured, false);
  assert.equal(events.length, 2);
  assert(events[1] > events[0]);
  unsubscribe();
});

test("clearing access cancels an in-flight protected query without repopulating its cache", async () => {
  setOperatorToken(fixtureToken);
  let reply!: (response: Response) => void;
  globalThis.fetch = async () => new Promise<Response>(resolve => { reply = resolve; });
  const outcome = queryClient.fetchQuery({ queryKey: ["/api/cohort"] }).then(() => "accepted", () => "cancelled");
  clearOperatorToken();
  reply(new Response(JSON.stringify({ private: "late-sensitive-fixture" }), { status: 200 }));
  assert.equal(await outcome, "cancelled");
  assert.equal(queryClient.getQueryCache().getAll().length, 0);
});

test("client distinguishes unconfigured server from rejected token without reflecting response body", async () => {
  setOperatorToken(fixtureToken);
  const messages = new Map<number, string>();
  for (const [status, code] of [[503, "OPERATOR_UNCONFIGURED"], [401, "OPERATOR_AUTH_REQUIRED"]] as const) {
    globalThis.fetch = async () => new Response(JSON.stringify({ code, message: fixtureToken }), { status, headers: { "content-type": "application/json" } });
    await assert.rejects(() => apiRequest("POST", "/api/cohort/start", {}), error => {
      assert(error instanceof Error);
      assert.equal(error.message.includes(fixtureToken), false);
      assert.match(error.message, status === 503 ? /server|configured/i : /token|authentication/i);
      messages.set(status, error.message);
      return true;
    });
  }
  assert.notEqual(messages.get(401), messages.get(503), "401 and 503 must display different messages");
});

test("network standards links accept only absolute HTTPS document URLs", () => {
  assert.equal(httpsDocumentUrl("https://authority.iaaso.org/standards/example"), "https://authority.iaaso.org/standards/example");
  for (const value of ["javascript:alert(1)", "data:text/html,fixture", "http://authority.iaaso.org/", "file:///tmp/fixture", "//authority.iaaso.org/", "/standards/example", "not a URL"]) {
    assert.equal(httpsDocumentUrl(value), undefined);
  }
});

test("configured token never appears in rendered password input or console markup", () => {
  setOperatorToken(fixtureToken);
  const client = new QueryClient();
  client.setQueryData(["/api/cohort"], { running: false, probing: false, round: 0, limit: 7, error: null, verified: true, members: [], entries: [], memory: { local: "fixture", remote: "fixture" } });
  // tsx's Node fixture uses classic JSX; Vite supplies the browser JSX runtime.
  const previous = Object.getOwnPropertyDescriptor(globalThis, "React");
  Object.defineProperty(globalThis, "React", { configurable: true, value: React });
  try {
    const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(OperatorAccess, null, React.createElement(CohortConsole))));
    assert.match(html, /type="password"/);
    assert.match(html, /autocomplete="off"/i);
    assert.match(html, /Clear/);
    assert.equal(html.includes(fixtureToken), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, "React", previous);
    else Reflect.deleteProperty(globalThis, "React");
    client.clear();
  }
});

test("public shell exposes the token input before protected loading and hides cached cohort/network content while locked", () => {
  const client = new QueryClient();
  client.setQueryData(["/api/cohort"], { private: "retained-sensitive-cohort-fixture" });
  client.setQueryData(["/api/network"], { private: "retained-sensitive-network-fixture" });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "React");
  Object.defineProperty(globalThis, "React", { configurable: true, value: React });
  try {
    clearOperatorToken();
    const protectedViews = React.createElement(React.Fragment, null, React.createElement(CohortConsole), React.createElement(NetworkConsole, { view: "network" }));
    const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(OperatorAccess, null, protectedViews)));
    assert.match(html, /type="password"/);
    assert.match(html, /Workspace locked/);
    assert(!html.includes("retained-sensitive"));
    assert(!html.includes("Loading persistent cohort"));
    client.clear();
    setOperatorToken(fixtureToken);
    const loading = renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(OperatorAccess, null, React.createElement(CohortConsole))));
    assert(loading.indexOf('type="password"') < loading.indexOf("Loading persistent cohort"));
  } finally {
    if (previous) Object.defineProperty(globalThis, "React", previous);
    else Reflect.deleteProperty(globalThis, "React");
    client.clear();
  }
});
