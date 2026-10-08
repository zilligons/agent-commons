export interface TransportCapabilities {
  readonly name: string;
  readonly canPush: boolean;          // Can receive inbound pushes
  readonly canPoll: boolean;          // Supports inbox polling
  readonly supportsStreaming: boolean; // Supports SSE / live streams
  readonly maxMessageBytes: number;   // Transport-specific message size ceiling
  readonly loopbackSafe: boolean;     // Works on 127.0.0.1 without external network
}

export interface DeliveryResult {
  readonly carrier: string;           // Identifying URI of the accepting carrier
  readonly seq?: number;              // Monotonic sequence assigned by carrier
  readonly sha: string;               // Envelope SHA-256
  readonly duplicate: boolean;        // Whether the carrier already held this envelope
  readonly all?: any[];               // Multi-carrier replication or refusal details
  readonly accepted: boolean;         // Must be true for outbox consumption
  readonly retryable?: boolean;
  readonly quarantine?: boolean;
  readonly reason?: string;
}

export interface InboxEnvelopeItem {
  readonly sourceId: string;
  readonly seq: number;
  readonly envelope: any;
}

export interface InboxBatch {
  readonly sourceId: string;
  readonly envelopes: InboxEnvelopeItem[];
  readonly now: number;
}

export interface MessageTransport {
  readonly capabilities: TransportCapabilities;
  sources(): readonly string[];
  deliver(envelope: any, options?: { timeoutMs?: number }): Promise<DeliveryResult>;
  fetchInbox(sourceId: string, options?: { since?: number; waitS?: number; timeoutMs?: number }): Promise<InboxBatch>;
  subscribe?(sourceId: string, onEnvelope: (item: InboxEnvelopeItem) => Promise<void>): () => void;
  close(): Promise<void>;
}

export interface MemoryLoopbackOptions {
  instanceId?: string;
  capabilities?: Partial<TransportCapabilities>;
}

export class MemoryLoopbackTransport implements MessageTransport {
  constructor(options?: MemoryLoopbackOptions);
  readonly instanceId: string;
  readonly sourceId: string;
  readonly capabilities: TransportCapabilities;
  sources(): readonly string[];
  deliver(envelope: any, options?: { timeoutMs?: number }): Promise<DeliveryResult>;
  fetchInbox(sourceId: string, options?: { since?: number; waitS?: number; timeoutMs?: number }): Promise<InboxBatch>;
  subscribe(sourceId: string, onEnvelope: (item: InboxEnvelopeItem) => Promise<void>): () => void;
  close(): Promise<void>;
}

export interface PillarCarrierOptions {
  keychain?: any;
  client?: any;
  carriers?: string[];
  env?: Record<string, string | undefined>;
  capabilities?: Partial<TransportCapabilities>;
}

export class PillarCarrierTransport implements MessageTransport {
  constructor(options?: PillarCarrierOptions);
  readonly client: any;
  readonly capabilities: TransportCapabilities;
  sources(): readonly string[];
  deliver(envelope: any, options?: { timeoutMs?: number }): Promise<DeliveryResult>;
  fetchInbox(sourceId: string, options?: { since?: number; waitS?: number; timeoutMs?: number }): Promise<InboxBatch>;
  close(): Promise<void>;
}
