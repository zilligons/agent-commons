import assert from "node:assert/strict";
import test from "node:test";
import { providerHTTPFailure, providerTransportFailure } from "./provider_diagnostics";
import { providerJSON } from "./provider_http";

const context = { cancelled: false, timedOut: false, timeoutMs: 10000 };
const privateText = "fixture-sensitive-message-and-url";
const snapshot = (error: Error & { code?: string; transportStatus?: string | null }) =>
  JSON.stringify({ code: error.code, message: error.message, transportStatus: error.transportStatus, stack: error.stack });

for (const [status, providerError, code, transportStatus] of [
  [401, { code: "invalid_api_key", type: "authentication_error" }, "AUTH_BLOCKED", "HTTP_401:invalid_api_key:authentication_error"],
  [403, { status: "PERMISSION_DENIED" }, "AUTH_BLOCKED", "HTTP_403:PERMISSION_DENIED"],
  [429, { code: "rate_limit_exceeded", type: "rate_limit_error" }, "RATE_LIMIT", "HTTP_429:rate_limit_exceeded:rate_limit_error"],
  [404, { code: "model_not_found", type: "invalid_request_error" }, "MODEL_UNAVAILABLE", "HTTP_404:model_not_found:invalid_request_error"],
  [503, { type: "overloaded_error", status: "UNAVAILABLE" }, "PROVIDER_ERROR", "HTTP_503:overloaded_error:UNAVAILABLE"],
] as const) test(`HTTP ${status} retains canonical diagnostic enums only`, async () => {
  const response = new Response(JSON.stringify({ error: { ...providerError, message: privateText } }), { status });
  const failure = await providerHTTPFailure(response);
  assert.equal(failure.code, code);
  assert.equal(failure.transportStatus, transportStatus);
  assert.equal(failure.retryable, false);
  assert.equal(snapshot(failure).includes(privateText), false);
});

test("unknown provider fields, headers and messages cannot enter diagnostics", async () => {
  const response = new Response(JSON.stringify({ error: { type: privateText, code: privateText,
    status: privateText, message: privateText, request: privateText }, payload: privateText }),
  { status: 500, headers: { "X-Request-Id": privateText, Authorization: privateText } });
  const failure = await providerHTTPFailure(response);
  assert.equal(failure.transportStatus, "HTTP_500");
  assert.equal(snapshot(failure).includes(privateText), false);
});

test("malformed error bodies preserve HTTP status", async () => {
  const failure = await providerHTTPFailure(new Response(privateText, { status: 502 }));
  assert.equal(failure.transportStatus, "HTTP_502");
  assert.equal(snapshot(failure).includes(privateText), false);
});

test("oversized error bodies are cancelled and do not emit partial metadata", async () => {
  let cancelled = 0;
  const bytes = new TextEncoder().encode(JSON.stringify({ error: { code: "model_not_found", message: privateText.repeat(300) } }));
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); }, cancel() { cancelled++; } });
  const failure = await providerHTTPFailure(new Response(stream, { status: 404 }));
  assert.equal(cancelled, 1);
  assert.equal(failure.transportStatus, "HTTP_404");
  assert.equal(snapshot(failure).includes(privateText), false);
});

test("body read failures retain status without reflecting the underlying exception", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error(privateText)); } });
  const failure = await providerHTTPFailure(new Response(stream, { status: 503 }));
  assert.equal(failure.transportStatus, "HTTP_503");
  assert.equal(snapshot(failure).includes(privateText), false);
});

test("successful responses are never read by the HTTP failure helper", async () => {
  let reads = 0;
  const response = { ok: true, status: 200, body: { getReader() { reads++; throw new Error(privateText); } } } as unknown as Response;
  const failure = await providerHTTPFailure(response);
  assert.equal(reads, 0);
  assert.equal(failure.code, "INVALID_REQUEST");
});

for (const causeCode of ["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "UND_ERR_CONNECT_TIMEOUT"]) {
  test(`transport cause ${causeCode} is preserved without exception text`, () => {
    const failure = providerTransportFailure(Object.assign(new Error(privateText), { cause: { code: causeCode, message: privateText, stack: privateText } }), context);
    assert.equal(failure.code, "TRANSPORT_ERROR");
    assert.equal(failure.transportStatus, "NETWORK_" + causeCode);
    assert.equal(snapshot(failure).includes(privateText), false);
  });
}

test("unknown or decorated network codes cannot reflect arbitrary data", () => {
  const failure = providerTransportFailure({ name: privateText, code: privateText, cause: { code: "ENOTFOUND:" + privateText } }, context);
  assert.equal(failure.transportStatus, "NETWORK_ERROR");
  assert.equal(snapshot(failure).includes(privateText), false);
});

test("client cancellation, timeout and AbortError remain distinct", () => {
  const abort = new DOMException(privateText, "AbortError");
  assert.equal(providerTransportFailure(abort, context).transportStatus, "CLIENT_ABORTED");
  assert.equal(providerTransportFailure(abort, { ...context, timedOut: true }).transportStatus, "CLIENT_TIMEOUT_10000ms");
  const cancelled = providerTransportFailure(abort, { ...context, cancelled: true, timedOut: true });
  assert.equal(cancelled.code, "CANCELLED");
  assert.equal(cancelled.transportStatus, "CLIENT_CANCELLED");
  assert.equal(providerTransportFailure(abort, { ...context, timedOut: true, timeoutMs: Infinity }).transportStatus, "CLIENT_TIMEOUT_0ms");
});

test("shared provider HTTP uses safe HTTP and network diagnostics without retries", async () => {
  let calls = 0;
  const input = { url: "https://fixture.invalid/only", method: "POST" as const, headers: {}, timeoutMs: 1000 };
  await assert.rejects(providerJSON({ ...input, fetchImpl: async () => {
    calls++; return new Response(JSON.stringify({ error: { code: "model_not_found", type: "invalid_request_error", message: privateText } }), { status: 404 });
  } }), { code: "MODEL_UNAVAILABLE", transportStatus: "HTTP_404:model_not_found:invalid_request_error" });
  assert.equal(calls, 1);
  await assert.rejects(providerJSON({ ...input, fetchImpl: async () => {
    calls++; throw Object.assign(new Error(privateText), { cause: { code: "ENOTFOUND" } });
  } }), { code: "TRANSPORT_ERROR", transportStatus: "NETWORK_ENOTFOUND" });
  assert.equal(calls, 2);
});

test("shared provider HTTP records the effective client timeout", async () => {
  let calls = 0;
  await assert.rejects(providerJSON({ url: "https://fixture.invalid/only", method: "GET", headers: {}, timeoutMs: 5,
    fetchImpl: async (_url, init) => { calls++; return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new DOMException(privateText, "AbortError")), { once: true });
    }); },
  }), { code: "TIMEOUT", transportStatus: "CLIENT_TIMEOUT_5ms" });
  assert.equal(calls, 1);
});
