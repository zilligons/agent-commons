import { sqliteTable, text } from "drizzle-orm/sqlite-core";
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
