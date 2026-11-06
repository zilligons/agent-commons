/** Exact console provider and operator credentials captured before the secret scrub.
 * No files, stores, logging, network access or application initialization.
 * Values stay private to this process and are never restored to child envs.
 */
export const SCOPED_PROVIDER_CREDENTIAL_NAMES = Object.freeze([
  "AGENT_COMMONS_OPENAI_API_KEY", "AGENT_COMMONS_ANTHROPIC_API_KEY", "AGENT_COMMONS_XAI_API_KEY",
  "AGENT_COMMONS_GOOGLE_API_KEY", "AGENT_COMMONS_GEMINI_API_KEY",
] as const);
export type ScopedProviderCredentialName = typeof SCOPED_PROVIDER_CREDENTIAL_NAMES[number];
const captured = new Map<ScopedProviderCredentialName, string>();
const CAPTURE_CREDENTIAL_NAMES = Object.freeze([...SCOPED_PROVIDER_CREDENTIAL_NAMES, "AGENT_COMMONS_OPERATOR_TOKEN"] as const);
let operatorToken: string | undefined;
let initialized = false;

export function captureProviderCredentials(source: NodeJS.ProcessEnv): void {
  if(initialized)return;
  initialized=true;
  for(const name of CAPTURE_CREDENTIAL_NAMES){
    const value=source[name];
    if(typeof value==="string"&&value.trim()) {
      if(name === "AGENT_COMMONS_OPERATOR_TOKEN") operatorToken = value;
      else captured.set(name,value);
    }
  }
}

export function getProviderCredential(name: ScopedProviderCredentialName): string | undefined {
  return captured.get(name);
}

export function getOperatorToken(): string | undefined {
  return operatorToken;
}
