// Local console bind. Loopback is the default. 0.0.0.0 requires the exact
// opt-in AGENT_COMMONS_BIND_ALL=1. Private preview and the operator token
// must not widen the bind: they used to, at server/index.ts (pre-change).

export const BIND_ALL_ENV = "AGENT_COMMONS_BIND_ALL";

export function listenHost(
  env: NodeJS.ProcessEnv = process.env,
): "127.0.0.1" | "0.0.0.0" {
  if (env[BIND_ALL_ENV] === "1") return "0.0.0.0";
  return "127.0.0.1";
}

// Node 22.23.2 on this Mac returns ENOTSUP for listen() when reusePort is
// true (measured 2026-10-04, 127.0.0.1:5087). Other platforms keep the
// previous reusePort behavior.
export function listenOptions(
  env: NodeJS.ProcessEnv = process.env,
  port = Number.parseInt(env.PORT || "5000", 10),
  platform: NodeJS.Platform = process.platform,
): { port: number; host: "127.0.0.1" | "0.0.0.0"; reusePort: boolean } {
  return {
    port,
    host: listenHost(env),
    reusePort: platform !== "darwin",
  };
}
