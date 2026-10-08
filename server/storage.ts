import { snapshots, agentKeys } from "@shared/schema";
import type { CommonsState } from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";

const sqlite = new Database("commons.db");
// Preserve existing identity/ledger continuity while fixing filesystem exposure.
// This private preview still requires volume encryption for protection from a
// whole-home reader; filesystem permissions are not encryption.
function protectDatabase(){
  for(const path of ["commons.db","commons.db-wal","commons.db-shm"])
    if(existsSync(path))chmodSync(path,0o600);
}
sqlite.pragma("journal_mode = WAL");
sqlite.exec(
  "CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS agent_keys (id TEXT PRIMARY KEY, private_key TEXT NOT NULL, public_key TEXT NOT NULL)",
);
protectDatabase();
export const db = drizzle(sqlite);
export interface IStorage {
  load(): CommonsState | null;
  save(state: CommonsState): void;
  key(id: string): { privateKey: string; publicKey: string };
  existingPublicKey(id: string): string | null;
  loadNetwork(): any;
  saveNetwork(value: any): void;
}
export class DatabaseStorage implements IStorage {
  loadValue(key:string,fallback:unknown=null) {
    const row=db.select().from(snapshots).where(eq(snapshots.id,key)).get();
    return row?JSON.parse(row.data):fallback;
  }
  saveValue(key:string,value:unknown) {
    db.insert(snapshots).values({id:key,data:JSON.stringify(value)})
      .onConflictDoUpdate({target:snapshots.id,set:{data:JSON.stringify(value)}}).run();
    protectDatabase();
  }
  transaction<T>(fn:()=>T):T {return sqlite.transaction(fn)()}
  loadCohort() {
    const row = db.select().from(snapshots).where(eq(snapshots.id, "cohort")).get();
    return row ? JSON.parse(row.data) : null;
  }
  saveCohort(value: unknown) {
    db.insert(snapshots).values({ id: "cohort", data: JSON.stringify(value) })
      .onConflictDoUpdate({target:snapshots.id,set:{data:JSON.stringify(value)}}).run();
    protectDatabase();
  }
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
    protectDatabase();
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
    protectDatabase();
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
    protectDatabase();
    return key;
  }
  existingPublicKey(id: string): string | null {
    const row = db.select().from(agentKeys).where(eq(agentKeys.id, id)).get();
    return row?.publicKey ?? null;
  }
}
export const storage = new DatabaseStorage();
