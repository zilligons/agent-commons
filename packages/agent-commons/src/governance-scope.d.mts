export type PrincipalStatus =
  | "active"
  | "superseded"
  | "suspended"
  | "revoked"
  | "expired"
  | "not-found";

export interface PrincipalStatusResult {
  readonly status: PrincipalStatus;
  readonly checkedAt: number;
}

export interface PrincipalStatusVerifier {
  checkStatus(principalId: string): Promise<PrincipalStatusResult>;
}

export type OperationTier =
  | "tier1-messaging"
  | "tier2-default-local-evolution"
  | "tier3-principal-governed";

export interface ScopeOptions {
  readonly scope?: "local" | "tenant" | "global" | string;
  readonly policy?: {
    readonly mode?: "local" | "global" | string;
    readonly governanceMode?: "principal-required" | string;
    readonly principals?: Record<string, string>;
    [key: string]: any;
  };
}

export function classifyOperationTier(operation: string, options?: ScopeOptions): OperationTier;

export function verifyPrincipalGovernance(
  uuaid: string,
  verifier: PrincipalStatusVerifier,
  policy: ScopeOptions["policy"]
): Promise<{ readonly principalId: string; readonly status: "active"; readonly checkedAt: number }>;

export class MockPrincipalStatusVerifier implements PrincipalStatusVerifier {
  constructor(initialStatuses?: Map<string, PrincipalStatus> | Record<string, PrincipalStatus>);
  setStatus(principalId: string, status: PrincipalStatus): void;
  setThrows(principalId: string, error: Error): void;
  checkStatus(principalId: string): Promise<PrincipalStatusResult>;
}
