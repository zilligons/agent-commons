import { createFixtureSpendingPolicy } from "./fixture-spending";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { AnthropicMessagesAdapter } from "./anthropic_messages";
import { L10AccountingService } from "./l10-accounting";
import { L10AccountingStore } from "./l10-accounting-store";
import { L10_FROZEN_LITERALS, L10_LIVE_ELIGIBLE_SLOTS } from "./l10-routes";
import { getDefaultAdapterForSlot } from "./config";
import { captureProviderCredentials } from "./provider_credentials";
import type { AdapterRequest } from "./types";

const slots = ["continuity", "collaboration", "security"] as const;
type Slot = typeof slots[number];
type Recorded = { url: string; method: string; body: any; headers: Headers; redirect?: RequestRedirect };
const code = (expected: string) => (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === expected;

function envelope(slot: Slot = "continuity") {
  return { type: "message", role: "assistant", model: L10_FROZEN_LITERALS[slot], stop_reason: "end_turn",
    content: [{ type: "thinking", thinking: "PRIVATE_FIXTURE_THINKING", signature: "fixture-signature" },
      { type: "text", text: "OK" }],
    usage: { input_tokens: 7, cache_read_input_tokens: 20, cache_creation_input_tokens: 10, output_tokens: 103 } };
}

// Provider-reported preflight counts are estimates, not guaranteed input upper bounds.
// Every fetch is an injected fixture; no provider request runs in these tests.
function fixture(t: TestContext, options: { countResponse?: unknown; response?: unknown;
  apiKey?: string; providerRequestsEnabled?: boolean; status?: number } = {}) {
  const requests: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body ?? "{}"));
    requests.push({ url, method: init?.method ?? "GET", body, headers: new Headers(init?.headers), redirect: init?.redirect });
    if (url === "https://api.anthropic.com/v1/messages/count_tokens") {
      assert.equal(init?.method, "POST");
      assert(slots.some(slot => L10_FROZEN_LITERALS[slot] === body.model), "count request must name a frozen model");
      return Response.json(options.countResponse ?? { input_tokens: 37 });
    }
    assert.equal(url, "https://api.anthropic.com/v1/messages", "fixture refuses every unrecognized URL");
    assert(store.outstanding(run.id).some(row => row.state === "started"), "accounting must mark dispatch before generation fetch");
    const slot = slots.find(value => L10_FROZEN_LITERALS[value] === body.model)!;
    return Response.json(options.response ?? envelope(slot), { status: options.status ?? 200 });
  };
  const adapter = new AnthropicMessagesAdapter({ fetchImpl, apiKey: options.apiKey ?? "fixture-only-key",
    providerRequestsEnabled: options.providerRequestsEnabled ?? true });
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const store = new L10AccountingStore(db as unknown as ConstructorParameters<typeof L10AccountingStore>[0]);
  const service = new L10AccountingService(store, { spending: createFixtureSpendingPolicy() });
  const run = service.createRun({ kind: "cohort", baseTurnLimit: 7, eligibleSlots: [...slots] });
  return { adapter, requests, store, service, run };
}

function boundInput(slot: Slot, prompt = "fixture prompt") {
  return { slotId: slot, runtimeModel: L10_FROZEN_LITERALS[slot], prompt, maxCompletionTokens: 1800, timeoutMs: 5000 };
}

async function admitted(f: ReturnType<typeof fixture>, slot: Slot = "continuity", callId = "fixture-call",
  quotedBounds?: { promptTokensUpper: number; totalTokensUpper: number }) {
  const input = boundInput(slot);
  const bounds = quotedBounds ?? await f.adapter.metering.bounds(input);
  const admission = f.service.reserveCall({ runId: f.run.id, callId, slotId: slot, runtimeModel: input.runtimeModel,
    completionLimit: input.maxCompletionTokens, promptTokensUpper: bounds.promptTokensUpper, totalTokensUpper: bounds.totalTokensUpper });
  const request: AdapterRequest = { slotId: slot, historicalModel: input.runtimeModel, runtimeModel: input.runtimeModel,
    prompt: input.prompt, timeoutMs: 5000, signal: { cancelled: () => false }, runId: f.run.id, callId,
    limits: admission.limits, reservation: admission.reservation, accountingPermit: admission.permit };
  return { request, admission, bounds };
}

const generations = (f: ReturnType<typeof fixture>) => f.requests.filter(request => request.url.endsWith("/messages"));

test("Anthropic Messages: Aegis remains exact Anthropic count-only with seven eligible slots and no cross-provider fallback", async t => {
  assert.deepEqual([...L10_LIVE_ELIGIBLE_SLOTS].sort(), [
    "continuity", "governance", "collaboration", "release", "integration", "sustainability", "security",
  ].sort());
  assert.equal(getDefaultAdapterForSlot("security"), "anthropic-messages");
  assert.equal(L10_FROZEN_LITERALS.security, "claude-sonnet-5-5");

  // Synthetic startup capture only: never consult the owner's environment or stores.
  captureProviderCredentials({
    AGENT_COMMONS_ANTHROPIC_API_KEY: "aegis-scoped-fixture-only",
    AGENT_COMMONS_OPENAI_API_KEY: "other-provider-fixture-only",
    AGENT_COMMONS_GOOGLE_API_KEY: "google-fixture-only",
    AGENT_COMMONS_GEMINI_API_KEY: "gemini-fixture-only",
  });
  let status = 200;
  const requestUrls: string[] = [];
  const prompt = "Count this fixture input only.";
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requestUrls.push(url);
    assert.equal(url, "https://api.anthropic.com/v1/messages/count_tokens");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-api-key"), "aegis-scoped-fixture-only");
    assert.equal(headers.get("anthropic-version"), "2023-06-01");
    assert.equal(headers.get("x-goog-api-key"), null);
    assert.equal(headers.get("authorization"), null);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model: "claude-sonnet-5-5", messages: [{ role: "user", content: prompt }], tools: [],
    });
    return Response.json(status === 200 ? { input_tokens: 37 } : { error: { type: "fixture_refusal" } }, { status });
  };
  const adapter = new AnthropicMessagesAdapter({ fetchImpl, providerRequestsEnabled: true });
  const boundsInput = { slotId: "security", runtimeModel: L10_FROZEN_LITERALS.security,
    prompt, maxCompletionTokens: 1800, timeoutMs: 80000 };
  const bounds = await adapter.metering.bounds(boundsInput);
  assert.deepEqual(bounds, { promptTokensUpper: 37, totalTokensUpper: 1837 });
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const store = new L10AccountingStore(db as unknown as ConstructorParameters<typeof L10AccountingStore>[0]);
  const service = new L10AccountingService(store, { spending: createFixtureSpendingPolicy() });
  const run = service.createRun({ kind: "cohort", baseTurnLimit: 7, eligibleSlots: [...L10_LIVE_ELIGIBLE_SLOTS] });
  const admission = service.reserveCall({ runId: run.id, callId: "aegis-count-only", slotId: "security",
    runtimeModel: L10_FROZEN_LITERALS.security, completionLimit: 1800,
    promptTokensUpper: bounds.promptTokensUpper, totalTokensUpper: bounds.totalTokensUpper });
  assert.equal(admission.reservation.promptTokensUpper, 37);
  assert.equal(admission.reservation.totalTokens, 1837);
  assert.equal(service.getRun(run.id).reservedTokens, 1837);
  assert.equal(service.getRun(run.id).chargedTokens, 0);
  assert.equal(store.outstanding(run.id).filter(row => row.state === "started").length, 0);
  service.releaseUnstarted(admission.permit, "PREFLIGHT_ONLY");

  status = 403;
  await assert.rejects(() => adapter.metering.bounds(boundsInput), code("AUTH_BLOCKED"));
  assert.equal(requestUrls.length, 2, "one count request per attempt, including refusal");
  assert.equal(requestUrls.filter(url => !url.endsWith("/count_tokens")).length, 0);
  assert.equal(service.getRun(run.id).reservedTokens, 0);
  assert.equal(service.getRun(run.id).chargedTokens, 0);
});

test("Anthropic Messages: all three frozen slots reserve provider-reported preflight counts and settle cached/thinking usage", async t => {
  const f = fixture(t);
  const perSlotBounds = await Promise.all(slots.map(slot => f.adapter.metering.bounds(boundInput(slot))));
  for (const [index, slot] of slots.entries()) {
    const { request, admission, bounds } = await admitted(f, slot, `call-${slot}`, perSlotBounds[index]);
    assert.deepEqual(bounds, { promptTokensUpper: 37, totalTokensUpper: 1837 });
    const result = await f.adapter.call(request);
    assert.equal(result.kind, "live");
    assert.equal(result.text, "OK", "thinking must not appear as visible output");
    assert.equal(result.actualModel, L10_FROZEN_LITERALS[slot]);
    assert.deepEqual(result.modelEvidence, { source: "provider-response", fieldPath: "model" });
    assert.deepEqual(result.usage, { promptTokens: 37, completionTokens: 103, totalTokens: 140,
      coversInternalCalls: true, source: "provider-response", fieldPath: "usage" });
    const settled = f.service.settleCall(admission.permit, { usage: result.usage, metrics: result.metrics, actualModel: result.actualModel, outcomeCode: "OK" });
    assert.equal(settled.chargedTokens, 140);
    assert.equal(settled.releasedTokens, 1697);
    const sent = generations(f).at(-1)!;
    assert.deepEqual(sent.body, { model: request.runtimeModel, max_tokens: 1800,
      messages: [{ role: "user", content: request.prompt }], tools: [], stream: false });
    const preflight = f.requests.find(request => request.url.endsWith("/count_tokens") && request.body.model === sent.body.model)!;
    const { max_tokens, stream, ...generationInput } = sent.body;
    assert.equal(max_tokens, 1800);
    assert.equal(stream, false);
    assert.deepEqual(preflight.body, generationInput, "count and generation must share model/messages/tools");
    assert.equal(preflight.headers.get("anthropic-version"), "2023-06-01");
    assert.equal(sent.headers.get("anthropic-version"), "2023-06-01");
    assert.equal(sent.headers.get("x-api-key"), "fixture-only-key");
    assert.equal(sent.headers.get("content-type"), "application/json");
  }
  assert.equal(generations(f).length, 3);
  assert.equal(f.service.getRun(f.run.id).chargedTokens, 420);
  assert.equal(f.service.getRun(f.run.id).reservedTokens, 0);
  assert(f.requests.every(request => request.redirect === "error"));
  assert.equal(f.requests.filter(request => request.url.endsWith("/count_tokens")).length, 3);
  assert(f.requests.every(request => request.method === "POST"), "no Models GET dependency remains");
});

test("Anthropic Messages: provider-reported preflight count plus completion ceiling exhausts the run budget before generation", async t => {
  const f = fixture(t, { countResponse: { input_tokens: 248200 } });
  for (const slot of slots) await assert.rejects(() => f.adapter.metering.bounds(boundInput(slot)), code("BUDGET_EXHAUSTED"));
  assert.equal(f.requests.length, 3);
  assert.equal(generations(f).length, 0);
  assert.equal(f.service.getRun(f.run.id).reservedTokens, 0);
});

test("Anthropic Messages: missing key and disabled dispatch perform no fetch", async t => {
  for (const [options, expected] of [[{ apiKey: "" }, "CREDENTIAL_MISSING"], [{ providerRequestsEnabled: false }, "PROVIDER_DISPATCH_DISABLED"]] as const) {
    const f = fixture(t, options);
    await assert.rejects(() => f.adapter.metering.bounds(boundInput("continuity")), code(expected));
    assert.equal(f.requests.length, 0);
  }
});

test("Anthropic Messages: malformed provider-reported preflight counts never admit generation", async t => {
  for (const countResponse of [{}, { input_tokens: null }, { input_tokens: -1 }, { input_tokens: 1.5 },
    { input_tokens: "37" }, { input_tokens: Number.MAX_SAFE_INTEGER + 1 }]) {
    const f = fixture(t, { countResponse });
    await assert.rejects(() => f.adapter.metering.bounds(boundInput("continuity")), code("METERING_BOUND_UNAVAILABLE"));
    assert.equal(generations(f).length, 0);
    assert.equal(f.service.getRun(f.run.id).reservedTokens, 0);
  }
});

test("Anthropic Messages: invalid preflight inputs refuse before any count request", async t => {
  const f = fixture(t);
  const input = boundInput("continuity");
  for (const change of [
    { prompt: null }, { maxCompletionTokens: 0 }, { maxCompletionTokens: 1.5 }, { maxCompletionTokens: 24001 },
    { slotId: "governance" }, { runtimeModel: "other-model" },
  ]) {
    await assert.rejects(() => f.adapter.metering.bounds({ ...input, ...change } as any));
  }
  assert.equal(f.requests.length, 0);
});

test("Anthropic Messages: guarded quote rejects permit, prompt, model, slot and reservation tampering", async t => {
  const f = fixture(t);
  const { request } = await admitted(f);
  for (const accountingPermit of [undefined, {}]) await assert.rejects(() => f.adapter.call({ ...request, accountingPermit }), code("LIMIT_UNSUPPORTED"));
  const changes: Partial<AdapterRequest>[] = [
    { prompt: "tampered" }, { runtimeModel: "other-model" }, { slotId: "security" },
    { limits: { ...request.limits, maxCompletionTokens: 3000 } },
    { limits: { ...request.limits, maxTotalTokens: 1838 } },
    { reservation: { ...request.reservation, promptTokensUpper: 36 } },
    { reservation: { ...request.reservation, totalTokens: 1836 } },
  ];
  for (const change of changes) await assert.rejects(() => f.adapter.call({ ...request, ...change }), code("INVALID_REQUEST"));
  assert.equal(generations(f).length, 0);
});

test("Anthropic Messages: a successful quote is consumed and cannot replay with a fresh permit", async t => {
  const f = fixture(t);
  const { request, admission } = await admitted(f);
  const result = await f.adapter.call(request);
  f.service.settleCall(admission.permit, { usage: result.usage, outcomeCode: "OK" });
  const fresh = f.service.reserveCall({ runId: f.run.id, callId: "replay", slotId: request.slotId, runtimeModel: request.runtimeModel,
    completionLimit: 1800, promptTokensUpper: 37, totalTokensUpper: 1837 });
  await assert.rejects(() => f.adapter.call({ ...request, callId: "replay", accountingPermit: fresh.permit,
    limits: fresh.limits, reservation: fresh.reservation }), code("INVALID_REQUEST"));
  assert.equal(generations(f).length, 1);
});

test("Anthropic Messages: a quote expires after 30 seconds without generation", async t => {
  const f = fixture(t);
  const { request } = await admitted(f);
  const originalNow = Date.now;
  const afterExpiry = originalNow() + 30001;
  try {
    Date.now = () => afterExpiry;
    await assert.rejects(() => f.adapter.call(request), code("INVALID_REQUEST"));
  } finally {
    Date.now = originalNow;
  }
  assert.equal(generations(f).length, 0);
});

test("Anthropic Messages: malformed usage/cache counts are refused after one generation", async t => {
  for (const usage of [null, {}, { input_tokens: 7 }, { ...envelope().usage, output_tokens: -1 },
    { ...envelope().usage, cache_read_input_tokens: 1.5 }, { ...envelope().usage, cache_creation_input_tokens: "10" },
    { ...envelope().usage, input_tokens: Number.MAX_SAFE_INTEGER }, { ...envelope().usage, output_tokens: NaN }]) {
    const f = fixture(t, { response: { ...envelope(), usage } });
    const { request } = await admitted(f);
    await assert.rejects(() => f.adapter.call(request), code("USAGE_INVALID"));
    assert.equal(generations(f).length, 1);
  }
});

test("Anthropic Messages: output overrun, wrong model and tool use retain valid usage observations", async t => {
  for (const [response, expected] of [
    [{ ...envelope(), usage: { ...envelope().usage, output_tokens: 1801 } }, "ACCOUNTING_OVERRUN"],
    [{ ...envelope(), usage: { ...envelope().usage, input_tokens: 8 } }, "ACCOUNTING_OVERRUN"],
    [{ ...envelope(), model: "other-model" }, "MODEL_MISMATCH"],
    [{ ...envelope(), content: [{ type: "tool_use", id: "tool", name: "forbidden", input: {} }], stop_reason: "tool_use" }, "UNEXPECTED_OUTPUT"],
  ] as const) {
    const f = fixture(t, { response });
    const { request } = await admitted(f);
    await assert.rejects(() => f.adapter.call(request), error => {
      assert(code(expected)(error));
      const observation = (error as any).accountingObservation;
      assert.equal(observation.usage.source, "provider-response");
      assert.equal(observation.usage.coversInternalCalls, true);
      assert.equal(observation.usage.totalTokens, observation.usage.promptTokens + observation.usage.completionTokens);
      return true;
    });
    assert.equal(generations(f).length, 1);
  }
});

test("Anthropic Messages: HTTP refusal neither retries nor exposes the provider error body", async t => {
  const f = fixture(t, { status: 403, response: { error: { message: "PRIVATE_FIXTURE_PROVIDER_BODY" } } });
  const { request } = await admitted(f);
  await assert.rejects(() => f.adapter.call(request), error => {
    assert(code("AUTH_BLOCKED")(error));
    assert.doesNotMatch(String(error), /PRIVATE_FIXTURE_PROVIDER_BODY/);
    return true;
  });
  assert.equal(generations(f).length, 1);
});
