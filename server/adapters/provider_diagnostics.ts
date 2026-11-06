import { AdapterFailure } from "./types";

const ERROR_BODY_BYTES = 4096;
const TYPES = new Set([
  "invalid_request_error", "authentication_error", "permission_error", "not_found_error",
  "rate_limit_error", "api_error", "server_error", "overloaded_error", "request_too_large",
]);
const CODES = new Set([
  "model_not_found", "invalid_api_key", "insufficient_quota", "rate_limit_exceeded",
  "context_length_exceeded", "invalid_request_error", "permission_denied", "access_denied",
  "account_deactivated", "billing_hard_limit_reached", "resource_exhausted", "not_found",
]);
const STATUSES = new Set([
  "INVALID_ARGUMENT", "UNAUTHENTICATED", "PERMISSION_DENIED", "NOT_FOUND", "RESOURCE_EXHAUSTED",
  "FAILED_PRECONDITION", "ABORTED", "OUT_OF_RANGE", "UNIMPLEMENTED", "INTERNAL", "UNAVAILABLE", "DEADLINE_EXCEEDED",
]);
const NETWORK_CODES = new Set([
  "ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH",
  "ENETUNREACH", "ENETDOWN", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
  "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED", "ERR_SSL_WRONG_VERSION_NUMBER",
]);

const allowed = (value: unknown, values: Set<string>): string | undefined => typeof value === "string" && values.has(value) ? value : undefined;

async function errorEnvelope(response: Response): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.body?.getReader();
    if (!reader) return undefined;
    const chunks: Uint8Array[] = []; let length = 0;
    while (length < ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (value.byteLength > ERROR_BODY_BYTES-length) return undefined;
      chunks.push(value); length += value.byteLength;
    }
    // At the boundary, refuse metadata rather than reading beyond the cap.
    return undefined;
  } catch { return undefined; }
  finally { try { await reader?.cancel(); } catch {} }
}

/** Preserve status and canonical enums only; provider text is never reflected. */
export async function providerHTTPFailure(response: Response): Promise<AdapterFailure> {
  const status = "HTTP_" + response.status;
  if (response.ok) return new AdapterFailure("INVALID_REQUEST", "HTTP failure diagnostics require a rejected response", status, false);
  const body = await errorEnvelope(response);
  const error = body && typeof body === "object" && "error" in body ? (body as { error?: unknown }).error : undefined;
  const fields = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const transportStatus = [status, allowed(fields.code, CODES), allowed(fields.type, TYPES), allowed(fields.status, STATUSES)].filter(Boolean).join(":");
  const code = response.status === 401 || response.status === 403 ? "AUTH_BLOCKED" : response.status === 429 ? "RATE_LIMIT" :
    response.status === 404 ? "MODEL_UNAVAILABLE" : "PROVIDER_ERROR";
  return new AdapterFailure(code, "Provider rejected this request", transportStatus, false);
}

/** No raw exception text, stack, URL or unrecognized cause code can leave this seam. */
export function providerTransportFailure(error: unknown, context: { cancelled: boolean; timedOut: boolean; timeoutMs: number }): AdapterFailure {
  const timeoutMs = Number.isFinite(context.timeoutMs) ? Math.trunc(Math.min(80000, Math.max(0, context.timeoutMs))) : 0;
  let name: unknown; let networkCode: string | undefined;
  try {
    const outer = error && typeof error === "object" ? error as { name?: unknown; code?: unknown; cause?: { code?: unknown } } : undefined;
    name = outer?.name;
    networkCode = allowed(outer?.cause?.code, NETWORK_CODES) ?? allowed(outer?.code, NETWORK_CODES);
  } catch {}
  if (context.cancelled) return new AdapterFailure("CANCELLED", "Provider request cancelled; outcome may be unknown", "CLIENT_CANCELLED", false);
  if (context.timedOut || name === "TimeoutError") return new AdapterFailure("TIMEOUT", "Provider request timed out; outcome may be unknown", `CLIENT_TIMEOUT_${timeoutMs}ms`, false);
  if (name === "AbortError") return new AdapterFailure("CANCELLED", "Provider request aborted; outcome may be unknown", "CLIENT_ABORTED", false);
  return new AdapterFailure("TRANSPORT_ERROR", "Provider request failed; no retry was attempted", networkCode ? "NETWORK_" + networkCode : "NETWORK_ERROR", false);
}
