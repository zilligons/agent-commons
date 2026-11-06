import { createFixtureSpendingPolicy } from "./fixture-spending";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { GoogleGeminiAdapter } from "./google_gemini";
import { L10AccountingService } from "./l10-accounting";
import { L10AccountingStore } from "./l10-accounting-store";
import { L10_FROZEN_LITERALS } from "./l10-routes";
import type { AdapterRequest } from "./types";

const model = L10_FROZEN_LITERALS.integration;
const origin = "https://generativelanguage.googleapis.com/v1beta/models/";
type Slot = "integration" | "release";
const code = (expected: string) => (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === expected;
type Recorded = { url: string; method: string; body: any; headers: Headers; redirect?: RequestRedirect };

function envelope(runtimeModel: string = model) {
  return { modelVersion: runtimeModel, candidates: [{ finishReason: "STOP", content: { role: "model", parts: [
    { text: "PRIVATE_FIXTURE_THOUGHT", thought: true }, { text: "OK" },
  ] } }], usageMetadata: { promptTokenCount: 37, cachedContentTokenCount: 30,
    candidatesTokenCount: 3, thoughtsTokenCount: 100, totalTokenCount: 140 } };
}

// Provider-reported count fixtures do not establish a guaranteed preflight upper bound.
// Every fetch is injected; no credential lookup or provider request is needed.
function fixture(t: TestContext, options: { countResponse?: unknown; response?: unknown; apiKey?: string;
  providerRequestsEnabled?: boolean; status?: number; slotId?: Slot; eligibleSlots?: Slot[] } = {}) {
  const slotId = options.slotId ?? "integration";
  const requests: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body ?? "{}"));
    requests.push({ url, method: init?.method ?? "GET", body, headers: new Headers(init?.headers), redirect: init?.redirect });
    assert.equal(init?.method, "POST");
    const models = [L10_FROZEN_LITERALS.integration, L10_FROZEN_LITERALS.release];
    if (models.some(value => url === `${origin}${value}:countTokens`)) return Response.json(options.countResponse ?? { totalTokens: 37 });
    const generationModel = models.find(value => url === `${origin}${value}:generateContent`);
    assert(generationModel, "fixture refuses all other URLs");
    assert(store.outstanding(run.id).some(row => row.state === "started"), "dispatch must be recorded before generation fetch");
    return Response.json(options.response ?? envelope(generationModel), { status: options.status ?? 200 });
  };
  const adapter = new GoogleGeminiAdapter({ fetchImpl, apiKey: options.apiKey ?? "fixture-only-key",
    providerRequestsEnabled: options.providerRequestsEnabled ?? true });
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const store = new L10AccountingStore(db as unknown as ConstructorParameters<typeof L10AccountingStore>[0]);
  const service = new L10AccountingService(store, { spending: createFixtureSpendingPolicy() });
  const run = service.createRun({ kind: "cohort", baseTurnLimit: 7, eligibleSlots: options.eligibleSlots ?? [slotId] });
  return { adapter, requests, store, service, run, slotId };
}

function boundInput(slotId: Slot = "integration") {
  return { slotId, runtimeModel: L10_FROZEN_LITERALS[slotId], prompt: "fixture prompt", maxCompletionTokens: 1800, timeoutMs: 5000 };
}

async function admitted(f: ReturnType<typeof fixture>, callId = "fixture-call", slotId = f.slotId) {
  const input = boundInput(slotId);
  const bounds = await f.adapter.metering.bounds(input);
  const admission = f.service.reserveCall({ runId: f.run.id, callId, slotId, runtimeModel: input.runtimeModel,
    completionLimit: 1800, promptTokensUpper: bounds.promptTokensUpper, totalTokensUpper: bounds.totalTokensUpper });
  const request: AdapterRequest = { slotId, historicalModel: input.runtimeModel, runtimeModel: input.runtimeModel,
    prompt: input.prompt, timeoutMs: 5000, signal: { cancelled: () => false }, runId: f.run.id, callId,
    limits: admission.limits, reservation: admission.reservation, accountingPermit: admission.permit };
  return { request, admission, bounds };
}

const generations = (f: ReturnType<typeof fixture>) => f.requests.filter(request => request.url.endsWith(":generateContent"));

test("Google Gemini: full preflight input is quoted and one admitted request settles cached prompt plus visible/thought usage", async t => {
  const f = fixture(t);
  const { request, admission, bounds } = await admitted(f);
  assert.deepEqual(bounds, { promptTokensUpper: 37, totalTokensUpper: 1837 });
  const result = await f.adapter.call(request);
  assert.equal(f.adapter.name, "google-gemini");
  assert.equal(result.text, "OK", "thought text must not be returned as visible content");
  assert.equal(result.actualModel, model);
  assert.deepEqual(result.modelEvidence, { source: "provider-response", fieldPath: "modelVersion" });
  assert.deepEqual(result.usage, { promptTokens: 37, completionTokens: 103, totalTokens: 140,
    coversInternalCalls: true, source: "provider-response", fieldPath: "usageMetadata" });
  const sent = generations(f)[0];
  const preflight = f.requests[0];
  const { model: resource, ...countedBody } = preflight.body.generateContentRequest;
  assert.equal(resource, `models/${model}`);
  assert.deepEqual(countedBody, sent.body, "countTokens must receive the complete generation input/config");
  assert.deepEqual(sent.body, { contents: [{ role: "user", parts: [{ text: request.prompt }] }], tools: [],
    generationConfig: { candidateCount: 1, maxOutputTokens: 1800 } });
  assert.equal(sent.headers.get("x-goog-api-key"), "fixture-only-key");
  assert.equal(sent.headers.get("content-type"), "application/json");
  assert(f.requests.every(request => request.redirect === "error"));
  assert.equal(generations(f).length, 1);
  const settled = f.service.settleCall(admission.permit, { usage: result.usage, metrics: result.metrics,
    actualModel: result.actualModel, outcomeCode: "OK" });
  assert.equal(settled.chargedTokens, 140, "cache is already included in prompt; thoughts add to completion");
  assert.equal(settled.releasedTokens, 1697);
  assert.equal(f.service.getRun(f.run.id).reservedTokens, 0);
});

test("Google Gemini: missing credential and disabled dispatch refuse before any fetch", async t => {
  for (const slotId of ["integration", "release"] as const) {
    for (const [options, expected] of [[{ apiKey: "" }, "CREDENTIAL_MISSING"], [{ providerRequestsEnabled: false }, "PROVIDER_DISPATCH_DISABLED"]] as const) {
      const f = fixture(t, { ...options, slotId });
      await assert.rejects(() => f.adapter.metering.bounds(boundInput(slotId)), code(expected));
      assert.equal(f.requests.length, 0);
    }
  }
});

test("Google Gemini: Argon release quotes the exact frozen model and settles one admitted request", async t => {
  assert.equal(L10_FROZEN_LITERALS.release, "gemini-4-argon");
  assert.notEqual(L10_FROZEN_LITERALS.release, L10_FROZEN_LITERALS.integration);
  const f = fixture(t, { slotId: "release" });
  const { request, admission, bounds } = await admitted(f);
  assert.deepEqual(bounds, { promptTokensUpper: 37, totalTokensUpper: 1837 });
  const counted = f.requests[0];
  assert.equal(counted.url, `${origin}gemini-4-argon:countTokens`);
  assert.equal(counted.body.generateContentRequest.model, "models/gemini-4-argon");
  const result = await f.adapter.call(request);
  assert.equal(result.actualModel, "gemini-4-argon");
  assert.deepEqual(result.modelEvidence, { source: "provider-response", fieldPath: "modelVersion" });
  assert.deepEqual(result.usage, { promptTokens: 37, completionTokens: 103, totalTokens: 140,
    coversInternalCalls: true, source: "provider-response", fieldPath: "usageMetadata" });
  const generation = generations(f)[0];
  assert.equal(generation.url, `${origin}gemini-4-argon:generateContent`);
  const { model: resource, ...countedBody } = counted.body.generateContentRequest;
  assert.equal(resource, "models/gemini-4-argon");
  assert.deepEqual(generation.body, countedBody);
  const settled = f.service.settleCall(admission.permit, { usage: result.usage, metrics: result.metrics,
    actualModel: result.actualModel, outcomeCode: "OK" });
  assert.equal(settled.chargedTokens, 140);
  assert.equal(settled.releasedTokens, 1697);
  assert.equal(f.service.getRun(f.run.id).reservedTokens, 0);
  assert.equal(generations(f).length, 1);
});

test("Google Gemini: Argon budget and measured thought overruns fail closed", async t => {
  const exhausted = fixture(t, { slotId: "release", countResponse: { totalTokens: 248200 } });
  await assert.rejects(() => admitted(exhausted), code("BUDGET_EXHAUSTED"));
  assert.equal(generations(exhausted).length, 0);
  const response = envelope(L10_FROZEN_LITERALS.release);
  const f = fixture(t, { slotId: "release", response: { ...response,
    usageMetadata: { ...response.usageMetadata, thoughtsTokenCount: 1800, totalTokenCount: 1840 } } });
  const { request } = await admitted(f);
  await assert.rejects(() => f.adapter.call(request), error => {
    assert(code("ACCOUNTING_OVERRUN")(error));
    assert.equal((error as any).accountingObservation.usage.completionTokens, 1803);
    assert.equal((error as any).accountingObservation.actualModel, "gemini-4-argon");
    return true;
  });
  assert.equal(generations(f).length, 1);
});

test("Google Gemini: Prism and Argon quotes remain independent and cannot replay across slots", async t => {
  const f = fixture(t, { eligibleSlots: ["integration", "release"] });
  const prism = await admitted(f, "prism", "integration");
  await assert.rejects(() => f.adapter.call({ ...prism.request, slotId: "release", runtimeModel: L10_FROZEN_LITERALS.release }), code("INVALID_REQUEST"));
  const argon = await admitted(f, "argon", "release");
  await assert.rejects(() => f.adapter.call({ ...prism.request, slotId: "release" }), code("INVALID_REQUEST"));
  await assert.rejects(() => f.adapter.call({ ...argon.request, runtimeModel: L10_FROZEN_LITERALS.integration }), code("INVALID_REQUEST"));
  const prismResult = await f.adapter.call(prism.request);
  f.service.settleCall(prism.admission.permit, { usage: prismResult.usage, outcomeCode: "OK" });
  const argonResult = await f.adapter.call(argon.request);
  f.service.settleCall(argon.admission.permit, { usage: argonResult.usage, outcomeCode: "OK" });
  assert.equal(prismResult.actualModel, L10_FROZEN_LITERALS.integration);
  assert.equal(argonResult.actualModel, L10_FROZEN_LITERALS.release);
  const fresh = f.service.reserveCall({ runId: f.run.id, callId: "argon-replay", slotId: "release", runtimeModel: L10_FROZEN_LITERALS.release,
    completionLimit: 1800, promptTokensUpper: 37, totalTokensUpper: 1837 });
  await assert.rejects(() => f.adapter.call({ ...argon.request, callId: "argon-replay", accountingPermit: fresh.permit,
    limits: fresh.limits, reservation: fresh.reservation }), code("INVALID_REQUEST"));
  assert.equal(generations(f).length, 2);
  assert.equal(f.service.getRun(f.run.id).chargedTokens, 280);
});

test("Google Gemini: malformed counts and strict count-plus-output budget exhaustion prevent generation", async t => {
  for (const countResponse of [{}, { totalTokens: null }, { totalTokens: -1 }, { totalTokens: 1.5 },
    { totalTokens: "37" }, { totalTokens: Number.MAX_SAFE_INTEGER + 1 }]) {
    const f = fixture(t, { countResponse });
    await assert.rejects(() => admitted(f), code("METERING_BOUND_UNAVAILABLE"));
    assert.equal(generations(f).length, 0);
  }
  const f = fixture(t, { countResponse: { totalTokens: 248200 } });
  await assert.rejects(() => admitted(f), code("BUDGET_EXHAUSTED"));
  assert.equal(generations(f).length, 0);
  assert.equal(f.service.getRun(f.run.id).reservedTokens, 0);
});

test("Google Gemini: frozen route and quote reject tampering or a missing real permit before generation", async t => {
  const f = fixture(t);
  const { request } = await admitted(f);
  for (const accountingPermit of [undefined, {}]) await assert.rejects(() => f.adapter.call({ ...request, accountingPermit }), code("LIMIT_UNSUPPORTED"));
  for (const change of [{ prompt: "changed" }, { slotId: "governance" }, { runtimeModel: "other-model" },
    { limits: { ...request.limits, maxCompletionTokens: 3000 } }, { limits: { ...request.limits, maxTotalTokens: 1838 } },
    { reservation: { ...request.reservation, promptTokensUpper: 36 } }, { reservation: { ...request.reservation, totalTokens: 1836 } }]) {
    await assert.rejects(() => f.adapter.call({ ...request, ...change }), code("INVALID_REQUEST"));
  }
  assert.equal(generations(f).length, 0);
});

test("Google Gemini: quote expires after 30 seconds and a consumed quote cannot replay", async t => {
  const f = fixture(t);
  const { request, admission } = await admitted(f);
  const originalNow = Date.now;
  const afterExpiry = originalNow() + 30001;
  try {
    Date.now = () => afterExpiry;
    await assert.rejects(() => f.adapter.call(request), code("INVALID_REQUEST"));
  } finally {
    Date.now = originalNow;
  }
  const result = await f.adapter.call(request);
  f.service.settleCall(admission.permit, { usage: result.usage, outcomeCode: "OK" });
  const fresh = f.service.reserveCall({ runId: f.run.id, callId: "replay", slotId: "integration", runtimeModel: model,
    completionLimit: 1800, promptTokensUpper: 37, totalTokensUpper: 1837 });
  await assert.rejects(() => f.adapter.call({ ...request, callId: "replay", accountingPermit: fresh.permit,
    limits: fresh.limits, reservation: fresh.reservation }), code("INVALID_REQUEST"));
  assert.equal(generations(f).length, 1);
});

test("Google Gemini: malformed or inconsistent actual usage never becomes measured success", async t => {
  const valid = envelope().usageMetadata;
  for (const usageMetadata of [null, {}, { ...valid, promptTokenCount: -1 }, { ...valid, thoughtsTokenCount: 1.5 },
    { ...valid, cachedContentTokenCount: 38 }, { ...valid, totalTokenCount: 139 }, { ...valid, candidatesTokenCount: null },
    { ...valid, thoughtsTokenCount: Number.MAX_SAFE_INTEGER }]) {
    const f = fixture(t, { response: { ...envelope(), usageMetadata } });
    const { request } = await admitted(f);
    await assert.rejects(() => f.adapter.call(request), code("USAGE_INVALID"));
    assert.equal(generations(f).length, 1);
  }
});

test("Google Gemini: input/thinking overruns and wrong model retain complete usage observations", async t => {
  const valid = envelope();
  for (const [response, expected] of [
    [{ ...valid, usageMetadata: { ...valid.usageMetadata, promptTokenCount: 38, totalTokenCount: 141 } }, "ACCOUNTING_OVERRUN"],
    [{ ...valid, usageMetadata: { ...valid.usageMetadata, thoughtsTokenCount: 1800, totalTokenCount: 1840 } }, "ACCOUNTING_OVERRUN"],
    [{ ...valid, modelVersion: "other-model" }, "MODEL_MISMATCH"],
    [{ ...valid, candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ functionCall: { name: "forbidden", args: {} } }] } }] }, "UNEXPECTED_OUTPUT"],
  ] as const) {
    const f = fixture(t, { response });
    const { request } = await admitted(f);
    await assert.rejects(() => f.adapter.call(request), error => {
      assert(code(expected)(error));
      const observation = (error as any).accountingObservation;
      assert.equal(observation.usage.source, "provider-response");
      assert.equal(observation.usage.totalTokens, observation.usage.promptTokens + observation.usage.completionTokens);
      return true;
    });
    assert.equal(generations(f).length, 1);
  }
});

test("Google Gemini: provider HTTP refusal does not retry or expose its body", async t => {
  const f = fixture(t, { status: 403, response: { error: { message: "PRIVATE_FIXTURE_PROVIDER_ERROR" } } });
  const { request } = await admitted(f);
  await assert.rejects(() => f.adapter.call(request), error => {
    assert(code("AUTH_BLOCKED")(error));
    assert.doesNotMatch(String(error), /PRIVATE_FIXTURE_PROVIDER_ERROR/);
    return true;
  });
  assert.equal(generations(f).length, 1);
});
