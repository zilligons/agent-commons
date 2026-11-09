// Types for @uuaid/agent-commons/conformance (src/conformance.mjs): the shipped wild-format vectors.

export declare const WILD_VECTORS_URL: URL;

export interface WildVectorStep {
  step: number;
  ok: boolean;
  misses?: string[];
  expected?: Record<string, unknown>;
  got: { runtime: "accepted" | "duplicate" | "other" | "refused"; format?: string; text?: string; group?: string | null; groupVerdict?: string; groupReason?: string; code?: string | null; reason?: string };
}

export interface WildVectorReport {
  vectors: "agent-commons/wild-vectors/1";
  passed: number;
  failed: number;
  cases: Array<{ name: string; ok: boolean; steps: WildVectorStep[] }>;
}

/** Play the vectors through the real runtime (admission + tolerant ingress) and the supported group judge. */
export declare function runWildVectors(options?: { vectors?: object }): Promise<WildVectorReport>;
