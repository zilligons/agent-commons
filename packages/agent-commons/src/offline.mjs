// Offline mode. Default on for a local run.
// AGENT_COMMONS_OFFLINE=1 forces offline, including policy.mode "global".
// AGENT_COMMONS_OFFLINE=0 is the only opt-in that allows outbound calls.
// Unset: offline, unless policy.offline is false, or policy.mode is "global"
// and the policy does not set offline. Loopback is a local carrier, not egress.

export const OFFLINE_ENV = "AGENT_COMMONS_OFFLINE";

export function isLoopbackHost(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function isLoopbackUrl(url) {
  try {
    return isLoopbackHost(new URL(String(url)).hostname);
  } catch {
    return false;
  }
}

export function isOffline(env = process.env, policy) {
  const flag = env?.[OFFLINE_ENV];
  if (flag === "1") return true;
  if (flag === "0") return false;
  if (policy && Object.prototype.hasOwnProperty.call(policy, "offline")) return policy.offline !== false;
  if (policy?.mode === "global") return false;
  return true;
}
