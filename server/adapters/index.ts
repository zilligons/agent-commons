/**
 * L2 adapter layer — public exports.
 */
export { AdapterFailure } from "./types";
export type { AdapterRequest, AdapterResult, AdapterResultTyped, AdapterResultLive, AdapterResultOffline, AdapterErrorShape, ModelAdapter, AdapterLiveExtras, AdapterLimits, AdapterReservation, AdapterMetrics, AdapterUsage, AdapterModelEvidence } from "./types";
export { resolveAdapter, KNOWN_ADAPTERS } from "./registry";
export { PreviewBridgeAdapter } from "./preview_bridge";
export { StubAdapter } from "./stub";
export { L10CliAdapter } from "./l10-cohort";
export { OpenAIResponsesAdapter } from "./openai_responses";
export { AnthropicMessagesAdapter } from "./anthropic_messages";
export { GoogleGeminiAdapter } from "./google_gemini";
export { loadAdaptersConfig, getDefaultAdapterForSlot, resolveAdapterForSlot, resolveRuntimeModel } from "./config";
export type { AdaptersConfig, SlotConfig } from "./config";
