import type { Request, Response, NextFunction } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { getOperatorToken } from "./adapters/provider_credentials";
import type { Server } from "node:http";
import { isIP } from "node:net";

export const SOL_GENERATION_CHECK_PATH = "/api/cohort/sol-generation-check";
export const solGenerationCheckEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.AGENT_COMMONS_SOL_GENERATION_CHECK_ENABLED === "1";

function validHostname(value: string): boolean {
  return value.length <= 253 && value.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function allowedHostnames(env: NodeJS.ProcessEnv): Set<string> {
  const configured = env.AGENT_COMMONS_ALLOWED_HOSTS;
  if (configured === undefined || configured.trim() === "") return new Set();
  const entries = configured.split(",").map(entry => entry.trim().toLowerCase());
  if (entries.some(entry => !validHostname(entry))) {
    throw new Error("AGENT_COMMONS_ALLOWED_HOSTS must contain only comma-separated bare hostnames without schemes, ports or wildcards");
  }
  return new Set(entries);
}

function authority(value: string | undefined, defaultPort = 80): string | null {
  if (!value || !/^[A-Za-z0-9.\[\]:-]+$/.test(value)) return null;
  try {
    const parsed = new URL("http://" + value);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    const name = parsed.hostname.toLowerCase();
    if (name.startsWith("[") ? isIP(name.slice(1, -1)) !== 6 : !validHostname(name)) return null;
    const port = parsed.port ? Number(parsed.port) : /:0*80$/.test(value) ? 80 : defaultPort;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return `${name}:${port}`;
  } catch { return null; }
}

/** Runs before parsers, API routes, Vite and static serving; forwarded hosts are ignored. */
function hostAllowed(host: string | undefined, actualPort: number, configured: Set<string>): boolean {
  const allowed = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`]);
  const normalized = authority(host);
  if (normalized === null) return false;
  const hostname = normalized.slice(0, normalized.lastIndexOf(":"));
  if (["127.0.0.1", "localhost", "[::1]"].includes(hostname)) return allowed.has(normalized);
  return configured.has(hostname);
}

export function createHostGuard(env: NodeJS.ProcessEnv = process.env) {
  const configured = allowedHostnames(env);
  return (req: Request, res: Response, next: NextFunction) => {
    const actualPort = req.socket?.localPort ?? Number(env.PORT || 5000);
    if (!hostAllowed(req.get("host"), actualPort, configured)) return res.status(403).json({ code: "HOST_FORBIDDEN", message: "Request Host is not allowed" });
    return next();
  };
}

/** HTTP middleware is not run for WebSocket upgrades; reject before Vite's listener. */
export function installUpgradeHostGuard(server: Server, env: NodeJS.ProcessEnv = process.env): void {
  const configured = allowedHostnames(env);
  server.prependListener("upgrade", (req, socket) => {
    if (!hostAllowed(req.headers.host, req.socket.localPort ?? Number(env.PORT || 5000), configured)) socket.destroy();
  });
}

function validOrigin(origin: string | undefined): URL | null {
  if (!origin) return null;
  try {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed;
  } catch { return null; }
}

export function createOperatorGuard(options: { env?: NodeJS.ProcessEnv; token?: () => string | undefined } = {}) {
  const env = options.env ?? process.env;
  const tokenForRequest = options.token ?? getOperatorToken;
  return (req: Request, res: Response, next: NextFunction) => {
    const path = req.path.toLowerCase();
    if (path !== "/api" && !path.startsWith("/api/")) return next();
    const read = ["GET", "HEAD"].includes(req.method);
    if (!read && path.replace(/\/$/, "") === SOL_GENERATION_CHECK_PATH && !solGenerationCheckEnabled(env)) return res.status(404).json({ message: "Unknown API route" });
    if (req.method === "OPTIONS") return next();
    const token = tokenForRequest();
    if (!token?.trim()) return res.status(503).json({ code: "OPERATOR_UNCONFIGURED", message: "API access disabled: operator authentication is not configured" });
    const digest = (value: string) => createHash("sha256").update(value).digest();
    if (!timingSafeEqual(digest(req.get("authorization") ?? ""), digest(`Bearer ${token}`))) return res.status(401).json({ code: "OPERATOR_AUTH_REQUIRED", message: "Operator authentication required" });
    if (read) return next();
    const origin = validOrigin(req.get("origin"));
    if (!origin) return res.status(403).json({ code: "ORIGIN_REQUIRED", message: "A valid operator Origin is required" });
    const originHost = authority(origin.host, origin.protocol === "https:" ? 443 : 80);
    const requestHost = authority(req.get("host"), origin.protocol === "https:" ? 443 : 80);
    const sameHost = originHost !== null && requestHost !== null && originHost === requestHost;
    const previewOrigin = env.AGENT_COMMONS_PRIVATE_PREVIEW === "1" && (env.AGENT_COMMONS_PREVIEW_ORIGINS ?? "").split(",").some(value => validOrigin(value.trim())?.origin === origin.origin);
    if (!sameHost && !previewOrigin) return res.status(403).json({ code: "ORIGIN_FORBIDDEN", message: "Cross-origin operator action denied" });
    return next();
  };
}

export const hostGuard = createHostGuard();
export const operatorGuard = createOperatorGuard();
