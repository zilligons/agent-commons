export declare const RUNTIME_UUAID_NAMESPACE: "agentnet";
export declare function mintNamespace(requested?: string | null): string;
export declare const SELF_CERTIFYING_NAMESPACES: readonly string[];
export declare const SELF_CERTIFYING_AGENT_UUAID: RegExp;
export declare function keyBindsAgentUuaid(uuaid: unknown, publicKeyHex: unknown): boolean;
export declare function keyIsBlocked(blocked: unknown, uuaid: unknown): boolean;
