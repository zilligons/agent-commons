import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createServer, request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHostGuard, createOperatorGuard } from "./operator";

await import("./offline-test-home.mjs");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
assert(process.cwd().startsWith(join(root, "node_modules", ".offline-test-homes")));
const { default: express } = await import("express");
const { registerRoutes } = await import("./routes");
const { cohortConsole } = await import("./cohort");
const { storage, getAccountingService } = await import("./storage");
const { AdapterFailure } = await import("./adapters/types");
const originalCheck = cohortConsole.runSolGenerationCheck;
const token = "offline-route-operator-fixture";
let dispatched = 0;
cohortConsole.runSolGenerationCheck = async () => { dispatched++; throw new AdapterFailure("CHECK_ALREADY_CLAIMED", "Fixture spent guard", null, false); };
after(() => { cohortConsole.runSolGenerationCheck = originalCheck; delete process.env.AGENT_COMMONS_SOL_GENERATION_CHECK_ENABLED; });

function rawStatus(origin: string, path: string, headers: Record<string,string>, method = "GET"): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL(path, origin), { method, headers }, response => { response.resume(); resolve(response.statusCode ?? 0); });
    request.on("error", reject); request.end(method === "POST" ? "{}" : undefined);
  });
}

async function fixture(t: { after(fn: () => Promise<void>): void }, enabled: boolean, configured = true) {
  if (enabled) process.env.AGENT_COMMONS_SOL_GENERATION_CHECK_ENABLED = "1";
  else delete process.env.AGENT_COMMONS_SOL_GENERATION_CHECK_ENABLED;
  const env: NodeJS.ProcessEnv = { AGENT_COMMONS_SOL_GENERATION_CHECK_ENABLED: enabled ? "1" : "0", AGENT_COMMONS_ALLOWED_HOSTS: "preview.example" };
  const app = express();
  app.use(createHostGuard(env));
  app.use(createOperatorGuard({ env, token: () => configured ? token : undefined }));
  app.use(express.json());
  const server = createServer(app);
  await registerRoutes(server, app);
  app.use((_req, res) => res.status(200).type("html").send("fixture-vite-fallback"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { origin, post: (path: string, headers: Record<string,string> = {}) => fetch(origin + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" }) };
}

test("default-off Sol route stays404 before auth and performs zero dispatch on a fresh fixture DB", async t => {
  const { origin, post } = await fixture(t, false);
  assert.equal((await fetch(origin + "/api/cohort")).status, 401);
  assert.equal((await fetch(origin + "/api/cohort", { headers: { authorization: `Bearer ${token}` } })).status, 200);
  assert.equal((await fetch(origin + "/@vite/client")).status, 200);
  assert.equal((await post("/api/cohort/sol-generation-check")).status, 404);
  assert.equal((await post("/api/cohort/sol-generation-check", { authorization: `Bearer ${token}`, origin })).status, 404);
  assert.equal(dispatched, 0);
  assert.equal(Object.values(getAccountingService().slotTotals()).reduce((sum, value) => sum + value.calls, 0), 0);
});

test("flag-on Sol route requires configured token, exact auth and Origin before the real durable spent guard", async t => {
  const absent = await fixture(t, true, false);
  const unavailable = await absent.post("/api/cohort/sol-generation-check", { origin: absent.origin });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).code, "OPERATOR_UNCONFIGURED");
  const { origin, post } = await fixture(t, true);
  assert.equal((await post("/api/cohort/sol-generation-check")).status, 401);
  assert.equal((await post("/api/cohort/sol-generation-check", { authorization: "Bearer wrong", origin })).status, 401);
  assert.equal((await post("/api/cohort/sol-generation-check", { authorization: `Bearer ${token}` })).status, 403);
  assert.equal((await post("/api/cohort/sol-generation-check", { authorization: `Bearer ${token}`, origin: "https://foreign.invalid" })).status, 403);
  assert.equal(dispatched, 0);
  storage.saveValue("owner-sol-generation-check-v1", { status: "claimed" });
  const routeSpy = cohortConsole.runSolGenerationCheck;
  const originalCallForSlot = cohortConsole.callForSlot;
  let providerDispatches = 0;
  cohortConsole.runSolGenerationCheck = originalCheck;
  cohortConsole.callForSlot = async () => { providerDispatches++; throw new AdapterFailure("FIXTURE_DISPATCH_FORBIDDEN", "Offline fixture must not dispatch", null, false); };
  try {
    const spent = await post("/api/cohort/sol-generation-check", { authorization: `Bearer ${token}`, origin });
    assert.equal(spent.status, 400);
    assert.equal((await spent.json()).code, "CHECK_ALREADY_CLAIMED");
    assert.equal(dispatched, 0);
    assert.equal(providerDispatches, 0);
    assert.equal(Object.values(getAccountingService().slotTotals()).reduce((sum, value) => sum + value.calls, 0), 0);
    assert.deepEqual(storage.loadValue("owner-sol-generation-check-v1"), { status: "claimed" });
  } finally {
    cohortConsole.runSolGenerationCheck = routeSpy;
    cohortConsole.callForSlot = originalCallForSlot;
  }
});

test("foreign Hosts cannot reach GET/POST APIs or Vite fallback and forwarded Host is ignored", async t => {
  const { origin, post } = await fixture(t, false);
  for (const path of ["/api/cohort", "/@vite/client", "/"]) assert.equal(await rawStatus(origin, path, { host: "foreign.invalid:5088", "x-forwarded-host": new URL(origin).host }), 403);
  assert.equal(await rawStatus(origin, "/api/cohort/sol-generation-check", { host: "foreign.invalid:5088" }, "POST"), 403);
  assert.equal(await rawStatus(origin, "/@vite/client", { host: "preview.example:5088" }), 200);
  assert.equal((await post("/api/unknown", { authorization: `Bearer ${token}`, origin })).status, 404);
});

test("production app installs HTTP and upgrade Host boundaries before Vite/static serving", () => {
  const source = readFileSync(new URL("./app.ts", import.meta.url), "utf8");
  const host = source.indexOf("app.use(hostGuard)");
  assert(host >= 0 && host < source.indexOf("installApiJsonParser(app)"));
  assert(host < source.indexOf("await registerRoutes("));
  assert(host < source.indexOf("await setupVite("));
  assert(source.indexOf("installUpgradeHostGuard(httpServer)") < source.indexOf("await setupVite("));
});
