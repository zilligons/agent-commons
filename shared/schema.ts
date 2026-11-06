import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const snapshots = sqliteTable("snapshots", {
  id: text("id").primaryKey(),
  data: text("data").notNull(),
});
export const insertSnapshotSchema = createInsertSchema(snapshots);
export type InsertSnapshot = z.infer<typeof insertSnapshotSchema>;
export type Snapshot = typeof snapshots.$inferSelect;
export const agentKeys = sqliteTable("agent_keys", {
  id: text("id").primaryKey(),
  privateKey: text("private_key").notNull(),
  publicKey: text("public_key").notNull(),
  // Set when the key is created. Rows from before this column read "foundation",
  // the namespace their UUAID was always derived in.
  uuaidNamespace: text("uuaid_namespace").notNull().default("foundation"),
});

export const l10Runs = sqliteTable("l10_runs", {
  id: text("id").primaryKey(), kind: text("kind").notNull(), state: text("state").notNull(),
  baseTurnLimit: integer("base_turn_limit").notNull(), grantedTurnLimit: integer("granted_turn_limit").notNull(),
  multiplier: integer("multiplier").notNull(), chargedTokens: integer("charged_tokens").notNull(),
  reservedTokens: integer("reserved_tokens").notNull(), attemptedTurns: integer("attempted_turns").notNull(),
  eligibleSlots: text("eligible_slots").notNull(), excludedSlots: text("excluded_slots").notNull(),
  ladder: text("ladder").notNull(), startedAtMs: integer("started_at_ms").notNull(), deadlineAtMs: integer("deadline_at_ms").notNull(),
  policyVersion: integer("policy_version").notNull().default(1), tokenCap: integer("token_cap").notNull().default(250000),
});
export const l10Reservations = sqliteTable("l10_reservations", {
  id: text("id").primaryKey(), runId: text("run_id").notNull().references(()=>l10Runs.id),
  callId: text("call_id").notNull().unique(), slotId: text("slot_id").notNull(), runtimeModel: text("runtime_model").notNull(),
  state: text("state").notNull(), promptUpper: integer("prompt_upper").notNull(),
  completionLimit: integer("completion_limit").notNull(), totalUpper: integer("total_upper").notNull(),
  createdAtMs: integer("created_at_ms").notNull(), startedAtMs: integer("started_at_ms"), terminalAtMs: integer("terminal_at_ms"),
}, table=>[index("l10_reservations_run_state").on(table.runId,table.state)]);
export const l10Consumption = sqliteTable("l10_consumption", {
  reservationId: text("reservation_id").primaryKey().references(()=>l10Reservations.id),
  signature: text("signature").notNull(), state: text("state").notNull(),
  chargedTokens: integer("charged_tokens").notNull(), releasedTokens: integer("released_tokens").notNull(),
  outcomeCode: text("outcome_code").notNull(), usageJson: text("usage_json"), metricsJson: text("metrics_json"),
  recordedAtMs: integer("recorded_at_ms").notNull(),
  actualModel: text("actual_model"),
});
export const l10AttemptWindow = sqliteTable("l10_attempt_window", {
  id: integer("id").primaryKey(), startedAtMs: integer("started_at_ms").notNull(), attempts: integer("attempts").notNull(),
});
export type Agent = {
  id: string;
  name: string;
  provider: string;
  model: string;
  role: string;
  color: string;
  status: string;
  calls: number;
  failures: number;
  streak: number;
  latency: number;
  publicKey: string;
};
export type Message = {
  id: string;
  agent: string;
  channel: string;
  kind: string;
  body: string;
  wire: string;
  time: string;
  mode: string;
  bytes: number;
  originalBytes: number;
  protocol: string;
  prevHash: string;
  hash: string;
  signature: string;
};
export type Proposal = {
  id: string;
  phrase: string;
  alias: string;
  author: string;
  mode: string;
  votes: Record<string, boolean>;
  status: string;
  reduction: number;
  tests: number;
  passed: number;
  reason: string;
};
export type CommonsState = {
  mode: "simulation" | "live";
  running: boolean;
  busy: string | null;
  round: number;
  limit: number;
  runCalls: number;
  callLimit: number;
  agents: Agent[];
  messages: Message[];
  proposals: Proposal[];
  lexicon: Record<string, string>;
  version: string;
  history: {
    version: string;
    lexicon: Record<string, string>;
    reason: string;
    time: string;
  }[];
  repairs: {
    id: string;
    time: string;
    type: string;
    detail: string;
    status: string;
  }[];
  selected: string[];
  error: string | null;
  verified: boolean;
  startedAt: string | null;
};
