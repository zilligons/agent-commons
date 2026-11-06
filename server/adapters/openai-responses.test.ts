import { createFixtureSpendingPolicy } from "./fixture-spending";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { OpenAIResponsesAdapter } from "./openai_responses";
import { L10AccountingService } from "./l10-accounting";
import { L10AccountingStore } from "./l10-accounting-store";
import { L10_FROZEN_LITERALS } from "./l10-routes";
import type { AdapterProviderUsage, AdapterRequest } from "./types";

const model = L10_FROZEN_LITERALS.governance;
type RecordedRequest = { url: string; method: string; body: Record<string, unknown>; redirect: RequestRedirect | undefined };

function envelope(runtimeModel: string = model) {
  return { status: "completed", model: runtimeModel,
    output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
    usage: { input_tokens: 37, output_tokens: 103, total_tokens: 140,
      input_tokens_details: { cached_tokens: 30 }, output_tokens_details: { reasoning_tokens: 100 } } };
}

function fixture(t: TestContext, options: { inputTokens?: number; response?: unknown; status?: number; countResponse?: unknown;
  modelResponse?: unknown; modelStatus?: number; fetchFailure?: Error;
  apiKey?: string; providerRequestsEnabled?: boolean; slotId?: "governance" | "sustainability";
  eligibleSlots?: Array<"governance" | "sustainability"> } = {}) {
  const slotId = options.slotId ?? "governance";
  const runtimeModel = slotId === "governance" ? model : L10_FROZEN_LITERALS.sustainability!;
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, method: init?.method ?? "GET", body: JSON.parse(String(init?.body ?? "{}")), redirect: init?.redirect });
    if (options.fetchFailure) throw options.fetchFailure;
    if (url.startsWith("https://api.openai.com/v1/models/")) {
      return Response.json(options.modelResponse ?? { id: decodeURIComponent(url.slice("https://api.openai.com/v1/models/".length)), object: "model" },
        { status: options.modelStatus ?? 200 });
    }
    if (url === "https://api.openai.com/v1/responses/input_tokens") {
      return Response.json(options.countResponse ?? { object: "response.input_tokens", input_tokens: options.inputTokens ?? 37 });
    }
    assert.equal(url, "https://api.openai.com/v1/responses", "fixture refuses every other URL");
    assert(store.outstanding(run.id).some(row => row.state === "started"), "dispatch must be recorded before generation fetch");
    return Response.json(options.response ?? envelope(String(requests[requests.length - 1].body.model)), { status: options.status ?? 200 });
  };
  const adapter = new OpenAIResponsesAdapter({ fetchImpl, apiKey: options.apiKey ?? "fixture-only-key",
    providerRequestsEnabled: options.providerRequestsEnabled ?? true });
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const store = new L10AccountingStore(db as unknown as ConstructorParameters<typeof L10AccountingStore>[0]);
  const service = new L10AccountingService(store, { spending: createFixtureSpendingPolicy() });
  const run = service.createRun({ kind: "cohort", baseTurnLimit: 7, eligibleSlots: options.eligibleSlots ?? [slotId] });
  return { adapter, requests, db, store, service, run, slotId, runtimeModel };
}

async function admitted(f: ReturnType<typeof fixture>, prompt = "fixture prompt", callId = "fixture-call", slotId = f.slotId) {
  const runtimeModel = slotId === "governance" ? model : L10_FROZEN_LITERALS.sustainability!;
  const completionLimit = f.service.completionLimit(f.run.id, slotId);
  const bounds = await f.adapter.metering.bounds({ prompt, maxCompletionTokens: completionLimit, slotId, runtimeModel });
  const admission = f.service.reserveCall({ runId: f.run.id, callId, slotId, runtimeModel,
    completionLimit, promptTokensUpper: bounds.promptTokensUpper, totalTokensUpper: bounds.totalTokensUpper });
  const request: AdapterRequest = { slotId, historicalModel: runtimeModel, runtimeModel, prompt,
    timeoutMs: 5000, signal: { cancelled: () => false }, runId: f.run.id, callId,
    accountingPermit: admission.permit, limits: admission.limits, reservation: admission.reservation };
  return { admission, request, bounds };
}

function generationCount(f: ReturnType<typeof fixture>) {
  return f.requests.filter(r => r.url === "https://api.openai.com/v1/responses").length;
}

function code(expected: string) {
  return (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === expected;
}

test("OpenAI Responses: exact provider input-token count determines the complete reservation", async (t) => {
  const f = fixture(t, { inputTokens: 17 });
  const prompt = "x".repeat(12000);
  const bounds = await f.adapter.metering.bounds({ prompt, maxCompletionTokens: 1800 });
  assert.equal(f.adapter.name, "openai-responses");
  assert.equal(f.adapter.makesLiveCalls, true);
  assert.equal(f.adapter.metering.version, 1);
  assert.equal(f.adapter.metering.coversInternalCalls, true);
  assert.deepEqual(bounds, { promptTokensUpper: 17, totalTokensUpper: 1817 });
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].url, "https://api.openai.com/v1/models/" + model);
  assert.equal(f.requests[0].method, "GET");
  assert.equal(f.requests[1].url, "https://api.openai.com/v1/responses/input_tokens");
  assert.equal(f.requests[1].method, "POST");
  assert.equal(f.requests[1].body.model, model);
  assert.equal(f.requests[1].body.input, prompt);
  assert.equal(generationCount(f), 0);
});

test("OpenAI Responses: real reservation dispatches one bounded request and settles measured usage", async (t) => {
  const f = fixture(t);
  const { request, admission } = await admitted(f);
  const result = await f.adapter.call(request);
  assert.equal(result.kind, "live");
  assert.equal(result.text, "OK");
  assert.equal(result.actualModel, model);
  assert.deepEqual(result.modelEvidence, { source: "provider-response", fieldPath: "model" });
  assert.deepEqual(result.usage, { promptTokens: 37, completionTokens: 103, totalTokens: 140,
    coversInternalCalls: true, source: "provider-response", fieldPath: "usage" });
  assert.deepEqual(result.providerUsage, { input_tokens: 37, output_tokens: 103, total_tokens: 140,
    input_tokens_details: { cached_tokens: 30, cache_write_tokens: null },
    output_tokens_details: { reasoning_tokens: 100 } });
  const generation = f.requests.find(r => r.url === "https://api.openai.com/v1/responses")!;
  assert.equal(generation.method, "POST");
  assert.equal(generation.body.model, model);
  assert.equal(generation.body.service_tier, "default", "paid Responses calls use the priced Standard service tier");
  assert.equal(generation.body.input, request.prompt);
  assert.equal(generation.body.max_output_tokens, 1800, "completion ceiling includes hidden reasoning tokens");
  assert.equal(generation.body.store, false);
  assert.deepEqual(generation.body.tools, []);
  assert.equal(generation.body.tool_choice, "none");
  for (const key of ["previous_response_id", "conversation", "background", "stream"]) {
    assert(!generation.body[key], `${key} must not enable extra work or state`);
  }
  assert.equal(generationCount(f), 1);
  const settled = f.service.settleCall(admission.permit, { usage: result.usage, metrics: result.metrics,
    actualModel: result.actualModel, outcomeCode: "OK" });
  assert.equal(settled.state, "settled");
  assert.equal(settled.chargedTokens, 140, "cached and reasoning details are subsets, not additional tokens");
  assert.equal(settled.releasedTokens, 1697);
  assert.equal(f.service.getRun(f.run.id).reservedTokens, 0);
  assert.equal(f.service.getRun(f.run.id).chargedTokens, 140);
});

test("OpenAI Responses: empty credential refuses before any fetch", async (t) => {
  const f = fixture(t, { apiKey: "" });
  await assert.rejects(async () => f.adapter.metering.bounds({ prompt: "no credentials", maxCompletionTokens: 1800 }), code("CREDENTIAL_MISSING"));
  assert.equal(f.requests.length, 0);
});

test("OpenAI Responses: sanitized provider evidence retains numeric cache writes and marks omitted details unknown", async t => {
  for (const details of [
    { input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10, ignored_counter: 999 },
      output_tokens_details: { reasoning_tokens: 100, ignored_counter: 999 } },
    {},
  ]) {
    const original = envelope();
    const f = fixture(t, { response: { ...original, usage: { input_tokens: 37, output_tokens: 103,
      total_tokens: 140, ignored_counter: 999, ...details } } });
    const { request } = await admitted(f);
    const result = await f.adapter.call(request);
    assert.deepEqual(result.providerUsage, { input_tokens: 37, output_tokens: 103, total_tokens: 140,
      input_tokens_details: { cached_tokens: details.input_tokens_details?.cached_tokens ?? null,
        cache_write_tokens: details.input_tokens_details?.cache_write_tokens ?? null },
      output_tokens_details: { reasoning_tokens: details.output_tokens_details?.reasoning_tokens ?? null } });
    assert.equal(result.usage?.totalTokens, 140);
    assert.equal(generationCount(f), 1);
  }
});

test("OpenAI Responses: reasoning output items stay out of returned text and remain in completion usage", async (t) => {
  const response = envelope();
  const f = fixture(t, { response: { ...response, output: [
    { type: "reasoning", summary: [{ type: "summary_text", text: "REASONING_SUMMARY_FIXTURE" }] },
    ...response.output,
  ] } });
  const { request } = await admitted(f);
  const result = await f.adapter.call(request);
  assert.equal(result.text, "OK");
  assert.equal(result.usage?.completionTokens, 103);
  assert.equal(result.usage?.totalTokens, 140);
  assert.equal(generationCount(f), 1);
});

test("OpenAI Responses: disabled provider requests refuse before any fetch", async (t) => {
  const f = fixture(t, { providerRequestsEnabled: false });
  await assert.rejects(async () => f.adapter.metering.bounds({ prompt: "disabled", maxCompletionTokens: 1800 }), code("PROVIDER_DISPATCH_DISABLED"));
  assert.equal(f.requests.length, 0);
});

test("OpenAI Responses: exact shared-budget exhaustion refuses before generation", async (t) => {
  const f = fixture(t, { inputTokens: 248200 });
  await assert.rejects(() => admitted(f), code("BUDGET_EXHAUSTED"));
  assert.equal(f.requests.length, 2);
  assert.equal(generationCount(f), 0);
  assert.equal(f.service.getRun(f.run.id).reservedTokens, 0);
});

test("OpenAI Responses: a quote cannot dispatch without a real accounting permit", async (t) => {
  const f = fixture(t);
  const { request } = await admitted(f);
  await assert.rejects(() => f.adapter.call({ ...request, accountingPermit: undefined }), code("LIMIT_UNSUPPORTED"));
  await assert.rejects(() => f.adapter.call({ ...request, accountingPermit: {} }), code("LIMIT_UNSUPPORTED"));
  assert.equal(generationCount(f), 0);
});

test("OpenAI Responses: prompt tampering invalidates the quote before generation", async (t) => {
  const f = fixture(t);
  const { request } = await admitted(f);
  await assert.rejects(() => f.adapter.call({ ...request, prompt: "a different prompt" }), code("INVALID_REQUEST"));
  assert.equal(generationCount(f), 0);
});

test("OpenAI Responses: completion or total-bound tampering invalidates the quote", async (t) => {
  const f = fixture(t);
  const { request } = await admitted(f);
  await assert.rejects(() => f.adapter.call({ ...request, limits: { ...request.limits, maxCompletionTokens: 3000 } }), code("INVALID_REQUEST"));
  await assert.rejects(() => f.adapter.call({ ...request, limits: { ...request.limits, maxTotalTokens: 5000 } }), code("INVALID_REQUEST"));
  await assert.rejects(() => f.adapter.call({ ...request, reservation: { ...request.reservation, promptTokensUpper: 38 } }), code("INVALID_REQUEST"));
  assert.equal(generationCount(f), 0);
});

test("OpenAI Responses: only the quoted slot and its frozen model may dispatch", async (t) => {
  const f = fixture(t);
  const { request } = await admitted(f);
  await assert.rejects(() => f.adapter.call({ ...request, slotId: "collaboration" }));
  await assert.rejects(() => f.adapter.call({ ...request, runtimeModel: "other-model" }));
  assert.equal(generationCount(f), 0);
});

test("OpenAI Responses: malformed or incomplete provider usage is refused after one generation", async (t) => {
  const complete = envelope();
  const invalid: unknown[] = [null,
    { ...complete.usage, input_tokens: -1 }, { ...complete.usage, output_tokens: 1.5 },
    { ...complete.usage, total_tokens: 141 }, { input_tokens: 37, output_tokens: 103 },
    { ...complete.usage, output_tokens: Number.MAX_SAFE_INTEGER + 1 },
    { ...complete.usage, input_tokens: null }];
  for (const [index, usage] of invalid.entries()) {
    const f = fixture(t, { response: { ...complete, usage } });
    const { request } = await admitted(f, "fixture prompt", `invalid-${index}`);
    await assert.rejects(() => f.adapter.call(request), code("USAGE_INVALID"));
    assert.equal(generationCount(f), 1);
  }
});

test("OpenAI Responses: incomplete response status is refused even with complete counters", async (t) => {
  const f = fixture(t, { response: { ...envelope(), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } });
  const { request, admission } = await admitted(f);
  let failure: unknown;
  await assert.rejects(() => f.adapter.call(request), (error: unknown) => {
    failure = error;
    return code("INCOMPLETE_RESPONSE")(error);
  });
  assert.equal(generationCount(f), 1);
  const observation = (failure as { accountingObservation?: Parameters<L10AccountingService["settleCall"]>[1] & { providerUsage?: AdapterProviderUsage } }).accountingObservation;
  assert(observation, "post-dispatch refusal must preserve complete observed usage");
  assert.deepEqual(observation.providerUsage, { input_tokens: 37, output_tokens: 103, total_tokens: 140,
    input_tokens_details: { cached_tokens: 30, cache_write_tokens: null },
    output_tokens_details: { reasoning_tokens: 100 } });
  const settled = f.service.settleCall(admission.permit, { ...observation, outcomeCode: "INCOMPLETE_RESPONSE" });
  assert.equal(settled.state, "settled");
  assert.equal(settled.chargedTokens, 140);
});

test("OpenAI Responses: actual counts beyond the quoted reservation are refused", async (t) => {
  for (const usage of [
    { input_tokens: 38, output_tokens: 103, total_tokens: 141 },
    { input_tokens: 37, output_tokens: 1801, total_tokens: 1838 },
  ]) {
    const f = fixture(t, { response: { ...envelope(), usage } });
    const { request } = await admitted(f);
    await assert.rejects(() => f.adapter.call(request), error => {
      assert(code("ACCOUNTING_OVERRUN")(error));
      assert.deepEqual((error as { accountingObservation?: { providerUsage?: AdapterProviderUsage } }).accountingObservation?.providerUsage,
        { ...usage, input_tokens_details: { cached_tokens: null, cache_write_tokens: null },
          output_tokens_details: { reasoning_tokens: null } });
      return true;
    });
    assert.equal(generationCount(f), 1);
  }
});

test("OpenAI Responses: provider model mismatch is refused", async (t) => {
  const f = fixture(t, { response: { ...envelope(), model: "other-model" } });
  const { request } = await admitted(f);
  await assert.rejects(() => f.adapter.call(request), code("MODEL_MISMATCH"));
  assert.equal(generationCount(f), 1);
});

test("OpenAI Responses: HTTP 403 has no retry and leaks no response body", async (t) => {
  const f = fixture(t, { status: 403, response: { error: { message: "PRIVATE_PROVIDER_ERROR_BODY" } } });
  const { request } = await admitted(f);
  await assert.rejects(() => f.adapter.call(request), (error: unknown) => {
    assert(code("AUTH_BLOCKED")(error));
    assert.doesNotMatch(String(error), /PRIVATE_PROVIDER_ERROR_BODY/);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_PROVIDER_ERROR_BODY/);
    return true;
  });
  assert.equal(generationCount(f), 1);
});

test("OpenAI Responses: redirects are disabled on both exact-count and generation requests", async (t) => {
  const f = fixture(t);
  const { request } = await admitted(f);
  await f.adapter.call(request);
  assert.equal(f.requests.length, 3);
  assert(f.requests.every(request => request.redirect === "error"));
});

test("OpenAI Responses: a consumed quote and permit cannot replay generation", async (t) => {
  const f = fixture(t);
  const { request } = await admitted(f);
  await f.adapter.call(request);
  await assert.rejects(() => f.adapter.call(request));
  const next = f.service.reserveCall({ runId: f.run.id, callId: "fresh-permit-stale-quote", slotId: "governance", runtimeModel: model,
    completionLimit: 1800, promptTokensUpper: 37, totalTokensUpper: 1837 });
  await assert.rejects(() => f.adapter.call({ ...request, callId: "fresh-permit-stale-quote", accountingPermit: next.permit,
    limits: next.limits, reservation: next.reservation }), code("INVALID_REQUEST"));
  assert.equal(generationCount(f), 1);
});

test("OpenAI Responses: malformed exact-count replies never produce a reservation", async (t) => {
  for (const input_tokens of [-1, 1.5, null, "37", Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture(t, { countResponse: { input_tokens } });
    await assert.rejects(() => admitted(f));
    assert.equal(generationCount(f), 0);
    assert.equal(f.service.getRun(f.run.id).reservedTokens, 0);
  }
});

test("OpenAI Responses: Terra uses its exact frozen model for counting, dispatch, evidence, and settlement", async (t) => {
  const f = fixture(t, { slotId: "sustainability" });
  assert.equal(L10_FROZEN_LITERALS.sustainability, "gpt-5.6-terra");
  const { request, admission, bounds } = await admitted(f, "Terra sustainability prompt");
  assert.deepEqual(bounds, { promptTokensUpper: 37, totalTokensUpper: 1837 });
  assert.equal(f.requests[0].url, "https://api.openai.com/v1/models/gpt-5.6-terra");
  assert.equal(f.requests[1].body.model, "gpt-5.6-terra");
  assert.equal(f.requests[1].body.input, request.prompt);
  const result = await f.adapter.call(request);
  assert.equal(result.text, "OK");
  assert.equal(result.actualModel, "gpt-5.6-terra");
  assert.deepEqual(result.modelEvidence, { source: "provider-response", fieldPath: "model" });
  assert.deepEqual(result.usage, { promptTokens: 37, completionTokens: 103, totalTokens: 140,
    coversInternalCalls: true, source: "provider-response", fieldPath: "usage" });
  assert.match(result.metrics.stdoutSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.requests[2].body, { model: "gpt-5.6-terra", input: request.prompt, tools: [], tool_choice: "none",
    truncation: "disabled", service_tier: "default", max_output_tokens: 1800, store: false, stream: false, background: false });
  const settled = f.service.settleCall(admission.permit, { usage: result.usage, metrics: result.metrics,
    actualModel: result.actualModel, outcomeCode: "OK" });
  assert.equal(settled.state, "settled");
  assert.equal(settled.chargedTokens, 140);
  assert.equal(settled.releasedTokens, 1697);
  assert.equal(f.service.getRun(f.run.id).chargedTokens, 140);
  assert.equal(f.service.getRun(f.run.id).reservedTokens, 0);
  assert.equal(generationCount(f), 1);
});

test("OpenAI Responses: Terra requires the shared OpenAI credential before any fetch", async (t) => {
  const f = fixture(t, { slotId: "sustainability", apiKey: "" });
  await assert.rejects(() => admitted(f), code("CREDENTIAL_MISSING"));
  assert.equal(f.requests.length, 0);
});

test("OpenAI Responses: Terra and Sol cannot substitute bare model names or other personas", async (t) => {
  const f = fixture(t, { slotId: "sustainability" });
  for (const runtimeModel of [model, "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-luna"]) {
    await assert.rejects(() => f.adapter.metering.bounds({ prompt: "Terra", maxCompletionTokens: 1800,
      slotId: "sustainability", runtimeModel }), code("MODEL_UNAVAILABLE"));
  }
  await assert.rejects(() => f.adapter.metering.bounds({ prompt: "Sol", maxCompletionTokens: 1800,
    slotId: "governance", runtimeModel: "gpt-5.6-terra" }), code("MODEL_UNAVAILABLE"));
  assert.equal(f.requests.length, 0);
  const { request } = await admitted(f);
  await assert.rejects(() => f.adapter.call({ ...request, slotId: "governance" }), code("INVALID_REQUEST"));
  await assert.rejects(() => f.adapter.call({ ...request, runtimeModel: model }), code("INVALID_REQUEST"));
  assert.equal(generationCount(f), 0);
});

test("OpenAI Responses: separate Terra and Sol quotes coexist and settle against one run", async (t) => {
  const f = fixture(t, { eligibleSlots: ["governance", "sustainability"] });
  const sol = await admitted(f, "Sol prompt", "sol-call", "governance");
  const terra = await admitted(f, "Terra prompt", "terra-call", "sustainability");
  for (const { request, admission } of [sol, terra]) {
    const result = await f.adapter.call(request);
    assert.equal(result.actualModel, request.runtimeModel);
    f.service.settleCall(admission.permit, { usage: result.usage, metrics: result.metrics, actualModel: result.actualModel, outcomeCode: "OK" });
  }
  assert.deepEqual(f.requests.filter(request => request.method === "POST").map(request => request.body.model), [model, "gpt-5.6-terra", model, "gpt-5.6-terra"]);
  assert.equal(f.service.getRun(f.run.id).chargedTokens, 280);
  assert.equal(f.service.getRun(f.run.id).reservedTokens, 0);
  assert.equal(generationCount(f), 2);
});

test("OpenAI Responses: model-not-found stops counting even when the count fixture would return success", async (t) => {
  const f = fixture(t, { slotId: "sustainability", modelStatus: 404, modelResponse: {
    error: { message: "PRIVATE_MODEL_LOOKUP_FIXTURE_BODY", type: "invalid_request_error", code: "model_not_found" },
  } });
  await assert.rejects(() => admitted(f), (error: unknown) => {
    assert(code("MODEL_UNAVAILABLE")(error));
    const status = (error as { transportStatus: string }).transportStatus;
    assert.match(status, /HTTP_404/);
    assert.match(status, /model_not_found/);
    assert.match(status, /invalid_request_error/);
    assert.doesNotMatch(String(error), /PRIVATE_MODEL_LOOKUP_FIXTURE_BODY/);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_MODEL_LOOKUP_FIXTURE_BODY/);
    return true;
  });
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].method, "GET");
  assert.equal(f.requests.filter(request => request.url.endsWith("/responses/input_tokens")).length, 0);
  assert.equal(generationCount(f), 0);
  assert.equal(f.service.getRun(f.run.id).attemptedTurns, 0);
});

test("OpenAI Responses: a model lookup returning another ID refuses before counting", async (t) => {
  const f = fixture(t, { modelResponse: { id: "different-provider-model" } });
  await assert.rejects(() => admitted(f), code("MODEL_MISMATCH"));
  assert.equal(f.requests.length, 1);
  assert.equal(generationCount(f), 0);
});

test("OpenAI Responses: transport failure preserves a safe code without raw error strings", async (t) => {
  const failure = new TypeError("PRIVATE_FETCH_FIXTURE_MESSAGE", {
    cause: Object.assign(new Error("PRIVATE_CAUSE_FIXTURE_MESSAGE"), { code: "ENOTFOUND" }),
  });
  const f = fixture(t, { fetchFailure: failure });
  await assert.rejects(() => admitted(f), (error: unknown) => {
    assert(code("TRANSPORT_ERROR")(error));
    assert.match((error as { transportStatus: string }).transportStatus, /ENOTFOUND/);
    assert.doesNotMatch(String(error), /PRIVATE_FETCH_FIXTURE_MESSAGE|PRIVATE_CAUSE_FIXTURE_MESSAGE/);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_FETCH_FIXTURE_MESSAGE|PRIVATE_CAUSE_FIXTURE_MESSAGE/);
    return true;
  });
  assert.equal(f.requests.length, 1);
  assert.equal(generationCount(f), 0);
});
