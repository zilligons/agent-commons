import { snapshots, agentKeys } from "@shared/schema";
import type { CommonsState } from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { generateKeyPairSync } from "node:crypto";

const sqlite = new Database("commons.db");
sqlite.pragma("journal_mode = WAL");
sqlite.exec(
  "CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS agent_keys (id TEXT PRIMARY KEY, private_key TEXT NOT NULL, public_key TEXT NOT NULL)",
);
export const db = drizzle(sqlite);
export interface IStorage {
  load(): CommonsState | null;
  save(state: CommonsState): void;
  key(id: string): { privateKey: string; publicKey: string };
  loadNetwork(): any;
  saveNetwork(value: any): void;
}
export class DatabaseStorage implements IStorage {
  loadNetwork() {
    const row = db
      .select()
      .from(snapshots)
      .where(eq(snapshots.id, "network"))
      .get();
    return row ? JSON.parse(row.data) : null;
  }
  saveNetwork(value: any) {
    db.insert(snapshots)
      .values({ id: "network", data: JSON.stringify(value) })
      .onConflictDoUpdate({
        target: snapshots.id,
        set: { data: JSON.stringify(value) },
      })
      .run();
  }
  load() {
    const row = db
      .select()
      .from(snapshots)
      .where(eq(snapshots.id, "commons"))
      .get();
    return row ? (JSON.parse(row.data) as CommonsState) : null;
  }
  save(state: CommonsState) {
    db.insert(snapshots)
      .values({ id: "commons", data: JSON.stringify(state) })
      .onConflictDoUpdate({
        target: snapshots.id,
        set: { data: JSON.stringify(state) },
      })
      .run();
  }
  key(id: string) {
    const row = db.select().from(agentKeys).where(eq(agentKeys.id, id)).get();
    if (row) return { privateKey: row.privateKey, publicKey: row.publicKey };
    const pair = generateKeyPairSync("ed25519");
    const key = {
      privateKey: pair.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
      publicKey: pair.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
    };
    db.insert(agentKeys)
      .values({ id, ...key })
      .run();
    return key;
  }
}
export const storage = new DatabaseStorage();
