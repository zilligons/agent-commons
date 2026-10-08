/**
 * L2 adapter layer — registry (static, fail-closed).
 *
 * Registration is static code, not plugin loading: no dynamic import, no path
 * from config to `require`, so config can never inject code (design §9).
 *
 * Fail-closed rules (design §6):
 * 1. Unknown adapter name → throws AdapterFailure("MODEL_UNAVAILABLE", "adapter not registered")
 *    BEFORE any process spawn. No fallback to another adapter, ever.
 * 2. AGENT_COMMONS_OFFLINE=1 refuses any adapter with makesLiveCalls: true.
 * 3. `preview-bridge` is the default adapter (no config, no env) and is the
 *    unchanged spawn of `python server/cohort_bridge.py`.
 *
 */
import { AdapterFailure, type ModelAdapter } from "./types";
import { PreviewBridgeAdapter } from "./preview_bridge";
import { StubAdapter } from "./stub";
import { L10CliAdapter } from "./l10-cohort";

const ADAPTERS: ReadonlyMap<string, () => ModelAdapter> = Object.freeze(
  new Map<string, () => ModelAdapter>([
    ["preview-bridge", () => new PreviewBridgeAdapter()],
    ["stub", () => new StubAdapter()],
    ["l10-cli", () => new L10CliAdapter()],
  ]),
);

export const KNOWN_ADAPTERS: readonly string[] = Object.freeze(Array.from(ADAPTERS.keys()));

/**
 * Resolve an adapter by name. Never returns undefined; unknown names throw.
 * Respects the offline kill switch.
 */
export function resolveAdapter(name: string): ModelAdapter {
  const factory = ADAPTERS.get(name);
  if (!factory) {
    throw new AdapterFailure(
      "MODEL_UNAVAILABLE",
      `adapter not registered: ${name}`,
      null,
      false,
    );
  }
  const adapter = factory();
  if (adapter.makesLiveCalls && process.env.AGENT_COMMONS_OFFLINE === "1") {
    throw new AdapterFailure(
      "MODEL_UNAVAILABLE",
      `adapter "${name}" makes live calls and AGENT_COMMONS_OFFLINE=1 is set; refusing`,
      null,
      false,
    );
  }
  return adapter;
}
