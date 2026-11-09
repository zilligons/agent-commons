// Types for @uuaid/agent-commons/spaces (src/spaces/driver.mjs): spaces over Pillar groups-v2.

export type SpaceDriverErrorCode =
  | "NO_IDENTITY" | "MEMBER" | "MEMBER_KEY" | "SPACE" | "SPACE_UNKNOWN" | "RECIPIENT_NOT_ADMITTED" | "NO_CARRIER"
  | "NAME" | "NOT_INVITED" | "SIGNAL" | "SIGNAL_UNKNOWN" | "AMBIGUOUS" | "TEXT" | "NOT_ACTIVE" | "FAN_OUT";

export declare class SpaceDriverError extends Error {
  code: SpaceDriverErrorCode;
  constructor(code: SpaceDriverErrorCode, message: string);
}

/** A groups-v2 engine verdict plus who sent it, which group it names (or null) and the decrypted payload. */
export interface GroupJudgement {
  verdict: "accepted" | "invitation" | "dropped" | "not-group" | (string & {});
  reason?: string;
  detail?: unknown;
  sends: Array<{ to: string; op: string; key?: string; manifestHash?: string; want?: unknown }>;
  from?: string;
  group?: string | null;
  payload?: unknown;
  [extra: string]: unknown;
}

/** The engine's receiver (GroupReceiver from the vendored Pillar groups-v2). */
export interface GroupReceiverLike { receive(envelope: unknown, now: number): object }

/** The supported group-receive path for a raw Pillar envelope: verify, decrypt, attach and judge. */
export declare function judgeEnvelope(receiver: GroupReceiverLike, keychain: unknown, envelope: object, now?: number): GroupJudgement;
/** The same contract for a message the Agent Commons runtime already verified, admitted and decrypted. */
export declare function judgeReceived(receiver: GroupReceiverLike, received: { sender: string; transportKey: string; payload: unknown; delegation?: unknown }, now?: number): GroupJudgement;

export interface MemberRef { uuaid: string; key: string }
export interface SendResult { to: string; id?: string; op?: string; accepted: boolean; error?: string }
export interface SpaceMemberView { uuaid: string; role: string; status: string }
export interface SpaceView { space: string; name: string; version: number; admin: string; status: string; members: SpaceMemberView[] }

export interface PollReport {
  messages: Array<{ space: string; from: string; envelopeId: string; msgId: string; text?: string; [field: string]: unknown }>;
  direct: Array<{ id: string; from: string; kind: string; payload: unknown }>;
  invitations: Array<{ space: string; from: string; name: string; next: string }>;
  signals: Array<{ space: string; from: string; signal: string; next: string }>;
  dropped: Array<{ space: string | null; from: string; envelopeId: string; reason: string; detail?: unknown }>;
  other: unknown[];
  sent: SendResult[];
}

export declare class SpaceDriver {
  /** runtime: a loaded AgentCommons (keychain, store, policy, transport). home: the Agent Commons home directory. */
  constructor(options: { home: string; runtime: any });
  readonly self: MemberRef;
  /** "uuaid" (an admitted agent; its pinned key is used) or "uuaid:<64 hex key>". */
  memberRef(spec: string): MemberRef;
  /**
   * Outbound admission: refuses (RECIPIENT_NOT_ADMITTED) any recipient not admitted here under exactly `key` with
   * commons:message, except a manifest to a member the space's signed chain lists as invited under that key.
   */
  assertOutbound(to: string, key: string, options?: { inviteeOf?: object | null }): "admitted" | "invitee";
  deliver(to: string, key: string, payload: object, kind?: string, options?: { inviteeOf?: object | null }): Promise<SendResult>;
  create(options: { name: string; purpose?: string; members?: string[] }): Promise<{ space: string; version: number; invited: string[]; sent: SendResult[] }>;
  invite(options: { space: string; member: string }): Promise<{ space: string; version: number; invited: string; sent: SendResult[] }>;
  /** Say "I am in" to the admin; returns the signal envelope id the admin accepts from. */
  join(options: { space: string }): Promise<{ space: string; to: string; signal: string; sent: SendResult }>;
  /** Admin, one step: the next manifest version from the envelope in which the invitee said "I am in". */
  accept(options: { signal: string; space?: string }): Promise<{ space: string; version: number; accepted: string; request: string; sent: SendResult[] }>;
  speak(options: { space: string; text: string; payload?: object }): Promise<{ space: string; msgId: string; sent: SendResult[] }>;
  poll(options?: { now?: number }): Promise<PollReport>;
  list(): SpaceView[];
}
