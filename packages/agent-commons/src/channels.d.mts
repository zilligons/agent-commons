export const CANONICAL_CHANNEL_REGEX: RegExp;
export const RESERVED_CHANNEL_PREFIX: RegExp;

export type ChannelClassification =
  | "structured"
  | "reserved-malformed"
  | "legacy-allowed"
  | "legacy-denied"
  | "invalid";

export interface ParsedChannelUri {
  readonly provider: string;
  readonly channelType: string;
  readonly channelId: string;
}

export interface ChannelClassificationResult {
  readonly ok: boolean;
  readonly classification: ChannelClassification;
  readonly channelUri?: string;
  readonly thread?: string;
  readonly parsed?: ParsedChannelUri;
  readonly error?: string;
}

export interface ChannelDefinition {
  readonly visibility?: "public" | "private" | "invite_only";
  readonly members?: readonly string[];
  readonly allowForwarding?: boolean;
  readonly metadata?: Record<string, any>;
}

export interface ChannelPolicy {
  readonly channelsEnabled?: boolean;
  readonly channels?: Record<string, ChannelDefinition>;
  readonly tenantProfiles?: Record<string, string>;
  readonly agents?: Record<string, { tenantId?: string; capabilities?: string[]; [key: string]: any }>;
  [key: string]: any;
}

export function classifyThread(thread: unknown, policy?: ChannelPolicy): ChannelClassificationResult;

export function assertChannelSendAdmission(
  channelUri: string,
  sender: string,
  recipients: string[],
  policy?: ChannelPolicy
): void;

export function assertChannelReceiveAdmission(
  channelUri: string,
  sender: string,
  receiver: string,
  policy?: ChannelPolicy
): void;

export function assertForwardingPermission(
  sourceChannelUri: string,
  targetChannelUri: string,
  sender: string,
  policy?: ChannelPolicy
): void;

export interface ProfileRef {
  readonly id: string;
  readonly scope: "local" | "tenant" | "global" | string;
  [key: string]: any;
}

export function validateTenantBinding(
  sender: string,
  recipient: string,
  profile: string | ProfileRef,
  policy?: ChannelPolicy
): void;
