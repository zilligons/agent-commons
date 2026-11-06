import express, { type Express, type Request, type Response, type NextFunction, type RequestHandler } from "express";
import { isIP } from "node:net";

export interface HttpSecurityConfig {
  trustProxyHops: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
}

function integerSetting(env: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

export function httpSecurityConfig(env: NodeJS.ProcessEnv = process.env): HttpSecurityConfig {
  return {
    trustProxyHops: integerSetting(env, "AGENT_COMMONS_TRUST_PROXY_HOPS", 0, 0),
    rateLimitWindowMs: integerSetting(env, "AGENT_COMMONS_RATE_LIMIT_WINDOW_MS", 60_000, 1),
    rateLimitMax: integerSetting(env, "AGENT_COMMONS_RATE_LIMIT_MAX", 120, 1),
  };
}

function isApiPath(path: string): boolean {
  const normalized = path.toLowerCase();
  return normalized === "/api" || normalized.startsWith("/api/");
}

function clientIP(req: Request): string {
  const address = req.ip ?? req.socket.remoteAddress ?? "";
  return isIP(address) ? address : "unknown";
}

/** The only response field captured is a bounded machine code; request data is never captured. */
export function createRequestLogger(write: (line: string) => void = line => console.log(line)): RequestHandler {
  return (req, res, next) => {
    const method = req.method;
    const path = req.path;
    const address = clientIP(req);
    let code: string | null = null;
    const json = res.json;
    res.json = function (body: unknown) {
      const candidate = body !== null && typeof body === "object" && "code" in body ? body.code : undefined;
      if (typeof candidate === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(candidate)) code = candidate;
      return json.call(this, body);
    };
    res.once("finish", () => write(JSON.stringify({ method, path, status: res.statusCode, code, clientIP: address })));
    next();
  };
}

export function createRateLimiter(config: HttpSecurityConfig, now: () => number = Date.now): RequestHandler {
  const clients = new Map<string, { count: number; expiresAt: number }>();
  let nextCleanup = 0;
  return (req, res, next) => {
    if (!isApiPath(req.path) && ["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const time = now();
    if (time >= nextCleanup) {
      for (const [address, entry] of Array.from(clients.entries())) if (entry.expiresAt <= time) clients.delete(address);
      nextCleanup = time + config.rateLimitWindowMs;
    }
    const address = clientIP(req);
    let entry = clients.get(address);
    if (!entry || entry.expiresAt <= time) {
      entry = { count: 0, expiresAt: time + config.rateLimitWindowMs };
      clients.set(address, entry);
    }
    if (entry.count >= config.rateLimitMax) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((entry.expiresAt - time) / 1000))));
      return res.status(429).json({ code: "RATE_LIMITED", message: "Too many requests" });
    }
    entry.count++;
    next();
  };
}

export function securityHeaders(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  const production = env.NODE_ENV === "production";
  return (req, res, next) => {
    // Vite development only: its injected scripts/styles and same-Host WebSocket HMR.
    // Production scripts, styles, assets and fonts stay on this origin.
    const inline = production ? "" : " 'unsafe-inline'";
    const host = req.get("host") ?? "";
    const hmr = !production && /^[A-Za-z0-9.\[\]:-]+$/.test(host) ? ` ws://${host} wss://${host}` : "";
    res.setHeader("Content-Security-Policy", [
      "default-src 'self'", "base-uri 'self'", "object-src 'none'", "form-action 'self'", "frame-ancestors 'none'",
      `script-src 'self'${inline}`, `style-src 'self'${inline}`, "font-src 'self'", "img-src 'self' data:", `connect-src 'self'${hmr}`,
    ].join("; "));
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (production) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  };
}

/** Install before Host/operator guards so their denials are limited, hardened and logged. */
export function installHttpSecurity(app: Express, env: NodeJS.ProcessEnv = process.env, write?: (line: string) => void): void {
  const config = httpSecurityConfig(env);
  app.set("trust proxy", config.trustProxyHops);
  app.disable("x-powered-by");
  app.use(createRequestLogger(write));
  app.use(securityHeaders(env));
  app.use(createRateLimiter(config));
}

/** JSON is the API's only body format; static and Vite requests are never parsed. */
export function installApiJsonParser(app: Express): void {
  app.use("/api", express.json({ limit: "32kb" }));
}

export function httpErrorHandler(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) { next(error); return; }
  const type = error !== null && typeof error === "object" && "type" in error ? error.type : undefined;
  if (type === "entity.parse.failed") {
    res.status(400).json({ code: "INVALID_JSON", message: "Malformed JSON request" });
    return;
  }
  if (type === "entity.too.large") {
    res.status(413).json({ code: "JSON_BODY_TOO_LARGE", message: "JSON request body is too large" });
    return;
  }
  // Parser errors can carry raw request bodies. Never print or reflect the error.
  const requestedStatus = error !== null && typeof error === "object" && "status" in error ? error.status : undefined;
  const status = typeof requestedStatus === "number" && Number.isInteger(requestedStatus) && requestedStatus >= 400 && requestedStatus < 500 ? requestedStatus : 500;
  res.status(status).json({ code: status === 500 ? "INTERNAL_SERVER_ERROR" : "REQUEST_FAILED", message: status === 500 ? "Internal Server Error" : "Request failed" });
}
