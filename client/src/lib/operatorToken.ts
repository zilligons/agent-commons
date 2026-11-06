let operatorToken = "";
let snapshot = { configured: false, version: 0 };
const listeners = new Set<() => void>();
export class OperatorRequestError extends Error {}

/** The token lives only in this module's memory for the current page lifetime. */
export function setOperatorToken(value: string): void {
  const candidate = value.trim();
  if (/[\u0000-\u001f\u007f]/.test(candidate)) throw new Error("Enter a valid operator token.");
  if (candidate === operatorToken) return;
  operatorToken = candidate;
  snapshot = { configured: operatorToken.length > 0, version: snapshot.version + 1 };
  listeners.forEach(listener => listener());
}

export function clearOperatorToken(): void { setOperatorToken(""); }
export function hasOperatorToken(): boolean { return operatorToken.length > 0; }
export function operatorTokenSnapshot(): Readonly<typeof snapshot> { return snapshot; }
export function subscribeOperatorToken(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function buildOperatorRequest(method: string, url: string, data?: unknown): { url: string; init: RequestInit } {
  if (!url.startsWith("/") || url.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(url)) throw new Error("API requests must use a same-origin relative path.");
  if (!/^\/api(?:[/?#]|$)/i.test(url)) throw new Error("API requests must use an API path.");
  if (!operatorToken) throw new OperatorRequestError("Save an operator token to unlock the workspace.");
  const normalizedMethod = method.toUpperCase();
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (data !== undefined) {
    headers["Content-Type"] = "application/json";
    try { body = JSON.stringify(data); } catch { throw new Error("Unable to prepare the API request."); }
  }
  headers.Authorization = `Bearer ${operatorToken}`;
  return { url, init: { method: normalizedMethod, headers, body, mode: "same-origin", credentials: "same-origin", redirect: "error" } };
}

export function operatorRequestError(status: number, code?: unknown): Error {
  if (status === 401) return new OperatorRequestError("Operator token was rejected. Save a valid token and try again.");
  if (status === 503 && code === "OPERATOR_UNCONFIGURED") return new OperatorRequestError("Operator authentication is not configured on the server. Workspace access is unavailable.");
  if (status === 503) return new OperatorRequestError("Service is temporarily unavailable. Try again later.");
  if (status === 403) return new OperatorRequestError("The server blocked this request. Check the page origin and access policy.");
  if (status === 404) return new OperatorRequestError("This API action is not available.");
  return new OperatorRequestError("The API request failed. Please try again.");
}
