export const OFFLINE_ENV: "AGENT_COMMONS_OFFLINE";
export function isLoopbackHost(hostname: string): boolean;
export function isLoopbackUrl(url: string): boolean;
export function isOffline(
  env?: Record<string, string | undefined>,
  policy?: { mode?: string; offline?: boolean },
): boolean;
