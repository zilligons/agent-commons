import { createFixtureSpendingPolicy } from "./fixture-spending";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { XAIResponsesAdapter } from "./xai_responses";
import { L10AccountingService } from "./l10-accounting";
import { L10AccountingStore } from "./l10-accounting-store";
import type { AdapterRequest } from "./types";

const model = "grok-4.7";
const reportedInputTokens = 37;
type RecordedRequest = { url: string; method: string; body: Record<string, unknown>; redirect?: RequestRedirect };

function envelope() {
  return { status: "completed", model,
    output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "REASONING_FIXTURE" }] },
      { type: "message", content: [{ type: "output_text", text: "OK" }] }],
    usage: { input_tokens: 37, output_tokens: 103, total_tokens: 140, num_server_side_tools_used: 0,
      input_tokens_details: { cached_tokens: 30 }, output_tokens_details: { reasoning_tokens: 100 } } };
}

function fixture(t: TestContext, options: { metadata?: unknown; tokenResponse?: unknown; tokenCount?: number; response?: unknown; status?: number; apiKey?: string;
  providerRequestsEnabled?: boolean } = {}) {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, method: init?.method ?? "GET", body: JSON.parse(String(init?.body ?? "{}")), redirect: init?.redirect });
    if (url === "https://api.x.ai/v1/models") return Response.json(options.metadata ?? {
      object: "list", data: [{ id: "grok-4.7", aliases: [], context_length: 1000000 }] });
    if (url === "https://api.x.ai/v1/tokenize-text") return Response.json(options.tokenResponse !== undefined ? options.tokenResponse : {
      token_ids: Array.from({ length: options.tokenCount ?? reportedInputTokens }, (_, token_id) => ({ token_id, string_token: "x", token_bytes: [120] })),
    });
    assert.equal(url, "https://api.x.ai/v1/responses", "fixture refuses every other URL");
    assert(store.outstanding(run.id).some(row => row.state === "started"), "dispatch must be durable before generation fetch");
    return Response.json(options.response ?? envelope(), { status: options.status ?? 200 });
  };
  const adapter = new XAIResponsesAdapter({ fetchImpl, apiKey: options.apiKey ?? "fixture-only-key",
    providerRequestsEnabled: options.providerRequestsEnabled ?? true });
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const store = new L10AccountingStore(db as unknown as ConstructorParameters<typeof L10AccountingStore>[0]);
  const service = new L10AccountingService(store, { spending: createFixtureSpendingPolicy() });
  const run = service.createRun({ kind: "cohort", baseTurnLimit: 7, eligibleSlots: ["release"] });
  return { adapter, requests, store, service, run };
}

async function admitted(f: ReturnType<typeof fixture>, prompt = "fixture prompt", callId = "fixture-call") {
  const completionLimit = f.service.completionLimit(f.run.id, "release");
  const bounds = await f.adapter.metering.bounds({ prompt, maxCompletionTokens: completionLimit, slotId: "release", runtimeModel: model });
  const admission = f.service.reserveCall({ runId: f.run.id, callId, slotId: "release", runtimeModel: model,
    completionLimit, promptTokensUpper: bounds.promptTokensUpper, totalTokensUpper: bounds.totalTokensUpper });
  const request: AdapterRequest = { slotId: "release", historicalModel: model, runtimeModel: model, prompt,
    timeoutMs: 5000, signal: { cancelled: () => false }, runId: f.run.id, callId,
    accountingPermit: admission.permit, limits: admission.limits, reservation: admission.reservation };
  return { request, admission, bounds };
}

function generationCount(f: ReturnType<typeof fixture>) {
  return f.requests.filter(request => request.url === "https://api.x.ai/v1/responses").length;
}

function code(expected: string) {
  return (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === expected;
}

test("xAI Responses: reported text-token preflight counts provider token objects and ignores million-token model context", async (t) => {
  const f = fixture(t);
  const bounds = await f.adapter.metering.bounds({ prompt: "short", maxCompletionTokens: 1800 });
  assert.equal(f.adapter.name, "xai-responses");
  assert.equal(f.adapter.makesLiveCalls, true);
  assert.equal(f.adapter.metering.version, 1);
  assert.equal(f.adapter.metering.coversInternalCalls, true);
  assert.equal(model, "grok-4.7");
  assert.deepEqual(bounds, { promptTokensUpper: reportedInputTokens, totalTokensUpper: reportedInputTokens + 1800 });
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].url, "https://api.x.ai/v1/models");
  assert.equal(f.requests[0].method, "GET");
  assert.equal(f.requests[1].url, "https://api.x.ai/v1/tokenize-text");
  assert.equal(f.requests[1].method, "POST");
  assert.deepEqual(f.requests[1].body, { model: "grok-4.7", text: "short" });
  assert.equal(generationCount(f), 0);
});

test("xAI Responses: model context length does not determine the text-token reservation", async (t) => {
  for (const context_length of [248200, 256000, 1000000]) {
    const f = fixture(t, { metadata: { data: [{ id: model, context_length }] } });
    const { bounds } = await admitted(f);
    assert.deepEqual(bounds, { promptTokensUpper: reportedInputTokens, totalTokensUpper: 1837 });
    assert.equal(f.requests.length, 2);
    assert.equal(generationCount(f), 0);
  }
  const f = fixture(t, { metadata: { data: [{ id: model }] } });
  const { bounds } = await admitted(f);
  assert.equal(bounds.totalTokensUpper, 1837);
});

test("xAI Responses: reported text-token preflight admits a fixture generation and exact measured settlement", async (t) => {
  const f = fixture(t);
  const { request, admission } = await admitted(f);
  const result = await f.adapter.call(request);
  assert.equal(result.kind, "live");
  assert.equal(result.text, "OK", "reasoning output must remain hidden");
  assert.equal(result.actualModel, model);
  assert.deepEqual(result.modelEvidence, { source: "provider-response", fieldPath: "model" });
  assert.deepEqual(result.usage, { promptTokens: 37, completionTokens: 103, totalTokens: 140,
    coversInternalCalls: true, source: "provider-response", fieldPath: "usage" });
  const generation = f.requests.find(request => request.url === "https://api.x.ai/v1/responses")!;
  assert.equal(generation.method, "POST");
  assert.deepEqual(generation.body, { model, input: request.prompt, tools: [], tool_choice: "none", max_output_tokens: 1800,
    store: false, stream: false, background: false, truncation: "disabled" });
  assert.equal(generationCount(f), 1);
  const settled = f.service.settleCall(admission.permit, { usage: result.usage, metrics: result.metrics,
    actualModel: result.actualModel, outcomeCode: "OK" });
  assert.equal(settled.state, "settled");
  assert.equal(settled.chargedTokens, 140, "cached and reasoning subsets are not charged again");
  assert.equal(settled.releasedTokens, 1697);
  assert.equal(f.service.getRun(f.run.id).reservedTokens, 0);
  assert.equal(f.service.getRun(f.run.id).chargedTokens, 140);
});

test("xAI Responses: explicit model alias proves availability without substituting the requested literal", async (t) => {
  const f = fixture(t, { metadata: { data: [{ id: "canonical-provider-id", aliases: [model] }] } });
  const { request } = await admitted(f);
  await f.adapter.call(request);
  assert.equal(f.requests[2].body.model, model);
});

test("xAI Responses: missing credentials and disabled requests each refuse before fetch", async (t) => {
  const missing = fixture(t, { apiKey: "" });
  await assert.rejects(() => admitted(missing), code("CREDENTIAL_MISSING"));
  assert.equal(missing.requests.length, 0);
  const disabled = fixture(t, { providerRequestsEnabled: false });
  await assert.rejects(() => admitted(disabled), code("PROVIDER_DISPATCH_DISABLED"));
  assert.equal(disabled.requests.length, 0);
});

test("xAI Responses: missing current model and malformed alias metadata never reach tokenization", async (t) => {
  const data = [[], [{ id: "different-model" }], [{ id: "grok-4.7-build-fast", context_length: 1000000 }],
    [{ id: "canonical", aliases: model }], [{ id: "canonical", aliases: [{ id: model }] }],
    [{ id: "canonical", aliases: [model, 17] }]];
  for (const models of data) {
    const f = fixture(t, { metadata: { data: models } });
    await assert.rejects(() => admitted(f), code("MODEL_UNAVAILABLE"));
    assert.equal(f.requests.length, 1);
    assert.equal(generationCount(f), 0);
    assert.equal(f.service.getRun(f.run.id).reservedTokens, 0);
  }
});

test("xAI Responses: unknown slot or model refuses metadata lookup", async (t) => {
  const f = fixture(t);
  await assert.rejects(() => f.adapter.metering.bounds({ prompt: "fixture", maxCompletionTokens: 1800, slotId: "governance" }), code("MODEL_UNAVAILABLE"));
  await assert.rejects(() => f.adapter.metering.bounds({ prompt: "fixture", maxCompletionTokens: 1800, runtimeModel: "different-model" }), code("MODEL_UNAVAILABLE"));
  await assert.rejects(() => f.adapter.metering.bounds({ prompt: "fixture", maxCompletionTokens: 1800, runtimeModel: "gemini-4-argon" }), code("MODEL_UNAVAILABLE"));
  assert.equal(f.requests.length, 0);
});

test("xAI Responses: real admission is required and quote prompt and limits cannot change", async (t) => {
  const f = fixture(t);
  const { request } = await admitted(f);
  await assert.rejects(() => f.adapter.call({ ...request, accountingPermit: undefined }), code("LIMIT_UNSUPPORTED"));
  await assert.rejects(() => f.adapter.call({ ...request, accountingPermit: {} }), code("LIMIT_UNSUPPORTED"));
  await assert.rejects(() => f.adapter.call({ ...request, prompt: "tampered" }), code("INVALID_REQUEST"));
  await assert.rejects(() => f.adapter.call({ ...request, limits: { ...request.limits, maxCompletionTokens: 3000 } }), code("INVALID_REQUEST"));
  await assert.rejects(() => f.adapter.call({ ...request, limits: { ...request.limits, maxTotalTokens: 200000 } }), code("INVALID_REQUEST"));
  await assert.rejects(() => f.adapter.call({ ...request, slotId: "governance" }), code("INVALID_REQUEST"));
  assert.equal(generationCount(f), 0);
});

test("xAI Responses: a consumed quote cannot replay with a fresh accounting permit", async (t) => {
  const f = fixture(t);
  const { request, admission } = await admitted(f);
  const result = await f.adapter.call(request);
  f.service.settleCall(admission.permit, { usage: result.usage, metrics: result.metrics, actualModel: result.actualModel, outcomeCode: "OK" });
  await assert.rejects(() => f.adapter.call(request), code("LIMIT_UNSUPPORTED"));
  const next = f.service.reserveCall({ runId: f.run.id, callId: "fresh-permit", slotId: "release", runtimeModel: model,
    promptTokensUpper: reportedInputTokens, completionLimit: 1800, totalTokensUpper: reportedInputTokens + 1800 });
  await assert.rejects(() => f.adapter.call({ ...request, callId: "fresh-permit", accountingPermit: next.permit,
    limits: next.limits, reservation: next.reservation }), code("INVALID_REQUEST"));
  assert.equal(generationCount(f), 1);
});

test("xAI Responses: malformed complete usage and invalid subset counts are rejected", async (t) => {
  const valid = envelope();
  for (const usage of [null, { ...valid.usage, input_tokens: -1 }, { ...valid.usage, output_tokens: 1.5 },
    { ...valid.usage, total_tokens: 141 }, { input_tokens: 37, output_tokens: 103 },
    { ...valid.usage, output_tokens_details: { reasoning_tokens: 104 } },
    { ...valid.usage, input_tokens_details: { cached_tokens: 38 } }]) {
    const f = fixture(t, { response: { ...valid, usage } });
    const { request } = await admitted(f);
    await assert.rejects(() => f.adapter.call(request), code("USAGE_INVALID"));
    assert.equal(generationCount(f), 1);
  }
});

test("xAI Responses: actual usage beyond reported text tokens or output ceiling preserves the measured overrun", async (t) => {
  for (const usage of [{ input_tokens: reportedInputTokens + 1, output_tokens: 103, total_tokens: reportedInputTokens + 104 },
    { input_tokens: 37, output_tokens: 1801, total_tokens: 1838 }]) {
    const f = fixture(t, { response: { ...envelope(), usage } });
    const { request } = await admitted(f);
    await assert.rejects(() => f.adapter.call(request), (error: unknown) => {
      assert(code("ACCOUNTING_OVERRUN")(error));
      assert.equal((error as any).accountingObservation.usage.totalTokens, usage.total_tokens);
      return true;
    });
    assert.equal(generationCount(f), 1);
  }
});

test("xAI Responses: incomplete response preserves valid usage for settlement", async (t) => {
  const f = fixture(t, { response: { ...envelope(), status: "incomplete" } });
  const { request, admission } = await admitted(f);
  let observation: Parameters<L10AccountingService["settleCall"]>[1] | undefined;
  await assert.rejects(() => f.adapter.call(request), (error: unknown) => {
    assert(code("INCOMPLETE_RESPONSE")(error));
    observation = (error as any).accountingObservation;
    return true;
  });
  assert(observation);
  const settled = f.service.settleCall(admission.permit, observation);
  assert.equal(settled.state, "settled");
  assert.equal(settled.chargedTokens, 140);
});

test("xAI Responses: server-side tool use or a different actual model is refused", async (t) => {
  const valid = envelope();
  const tools = fixture(t, { response: { ...valid, usage: { ...valid.usage, num_server_side_tools_used: 1 } } });
  await assert.rejects(() => admitted(tools).then(({ request }) => tools.adapter.call(request)), code("UNEXPECTED_OUTPUT"));
  assert.equal(generationCount(tools), 1);
  const mismatch = fixture(t, { response: { ...valid, model: "different-model" } });
  await assert.rejects(() => admitted(mismatch).then(({ request }) => mismatch.adapter.call(request)), code("MODEL_MISMATCH"));
  assert.equal(generationCount(mismatch), 1);
});

test("xAI Responses: shared HTTP transport disables redirects and never retries or leaks rejected bodies", async (t) => {
  const f = fixture(t, { status: 403, response: { error: { message: "PRIVATE_XAI_FIXTURE_BODY" } } });
  const { request } = await admitted(f);
  await assert.rejects(() => f.adapter.call(request), (error: unknown) => {
    assert(code("AUTH_BLOCKED")(error));
    assert.doesNotMatch(String(error), /PRIVATE_XAI_FIXTURE_BODY/);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_XAI_FIXTURE_BODY/);
    return true;
  });
  assert.equal(generationCount(f), 1);
  assert.equal(f.requests.length, 3);
  assert(f.requests.every(request => request.redirect === "error"));
});

test("xAI Responses: malformed tokenizer token objects cannot reserve or generate", async (t) => {
  const valid = { token_id: 4, string_token: "x", token_bytes: [120] };
  for (const tokenResponse of [{}, { token_ids: null }, { token_ids: [4] },
    { token_ids: [{ ...valid, token_id: -1 }] }, { token_ids: [{ ...valid, token_id: 1.5 }] },
    { token_ids: [{ ...valid, token_id: "4" }] }, { token_ids: [{ ...valid, token_id: Number.MAX_SAFE_INTEGER + 1 }] },
    { token_ids: [{ ...valid, string_token: null }] },
    { token_ids: [{ ...valid, token_bytes: [256] }] }, { token_ids: [{ ...valid, token_bytes: [1.5] }] },
    { token_ids: [{ token_id: 4 }] }]) {
    const f = fixture(t, { tokenResponse });
    await assert.rejects(() => admitted(f), code("USAGE_INVALID"));
    assert.equal(f.requests.length, 2);
    assert.equal(generationCount(f), 0);
    assert.equal(f.service.getRun(f.run.id).attemptedTurns, 0);
  }
});

test("xAI Responses: reported token count plus completion refuses exact cap before generation", async (t) => {
  const atCap = fixture(t, { tokenCount: 248200 });
  await assert.rejects(() => admitted(atCap), code("BUDGET_EXHAUSTED"));
  assert.equal(generationCount(atCap), 0);
  assert.equal(atCap.service.getRun(atCap.run.id).attemptedTurns, 0);
  const belowCap = fixture(t, { tokenCount: 248199 });
  const { bounds } = await admitted(belowCap);
  assert.equal(bounds.totalTokensUpper, 249999);
  assert.equal(generationCount(belowCap), 0);
});
