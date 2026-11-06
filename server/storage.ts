import { snapshots, agentKeys } from "@shared/schema";
import type { CommonsState } from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { L10AccountingStore } from "./adapters/l10-accounting-store";
import { L10AccountingService } from "./adapters/l10-accounting";
import { resolveRuntimePaths } from "./runtime-paths";
import { SQLitePlatformSpending } from "./adapters/platform-spending";
import { mintNamespace, RUNTIME_UUAID_NAMESPACE } from "../packages/agent-commons/src/uuaid-namespace.mjs";

const { databasePath, production } = resolveRuntimePaths();
const sqlite = new Database(databasePath, { fileMustExist: production });
// Preserve existing identity/ledger continuity while fixing filesystem exposure.
// This private preview still requires volume encryption for protection from a
// whole-home reader; filesystem permissions are not encryption.
function protectDatabase(){
  for(const path of [databasePath,`${databasePath}-wal`,`${databasePath}-shm`])
    if(existsSync(path))chmodSync(path,0o600);
}
sqlite.pragma("journal_mode = WAL");
sqlite.exec(
  "CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS agent_keys (id TEXT PRIMARY KEY, private_key TEXT NOT NULL, public_key TEXT NOT NULL)",
);
// Every key row records the namespace its UUAID is minted in. Rows written
// before the column existed get "foundation", the namespace they were always
// read in, so no existing identity is renamed. IMMEDIATE takes the write lock
// before the check, so two processes opening one database cannot both add it.
export function ensureAgentKeyNamespace(database: Database.Database) {
  database.transaction(() => {
    const columns = database.prepare("PRAGMA table_info(agent_keys)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "uuaid_namespace"))
      database.exec("ALTER TABLE agent_keys ADD COLUMN uuaid_namespace TEXT NOT NULL DEFAULT 'foundation'");
  }).immediate();
}
ensureAgentKeyNamespace(sqlite);
protectDatabase();
export const db = drizzle(sqlite);
export interface IStorage {
  load(): CommonsState | null;
  save(state: CommonsState): void;
  key(id: string): { privateKey: string; publicKey: string; uuaidNamespace: string };
  existingPublicKey(id: string): string | null;
  existingPublicIdentity(id: string): { publicKey: string; uuaidNamespace: string } | null;
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
    if (row) return { privateKey: row.privateKey, publicKey: row.publicKey, uuaidNamespace: row.uuaidNamespace };
    const pair = generateKeyPairSync("ed25519");
    const key = {
      privateKey: pair.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
      publicKey: pair.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
      // A new key is minted in the runtime namespace, recorded with the key.
      uuaidNamespace: mintNamespace(RUNTIME_UUAID_NAMESPACE),
    };
    db.insert(agentKeys)
      .values({ id, ...key })
      .run();
    protectDatabase();
    return key;
  }
  existingPublicKey(id: string): string | null {
    return this.existingPublicIdentity(id)?.publicKey ?? null;
  }
  existingPublicIdentity(id: string): { publicKey: string; uuaidNamespace: string } | null {
    const row = db.select({ publicKey: agentKeys.publicKey, uuaidNamespace: agentKeys.uuaidNamespace })
      .from(agentKeys).where(eq(agentKeys.id, id)).get();
    return row ?? null;
  }
}
export const storage = new DatabaseStorage();

let accounting: L10AccountingService | undefined;
/** Additive accounting initialization is deferred until a run is requested. */
export function getAccountingService(): L10AccountingService {
  if (!accounting) {
    const accountingStore = new L10AccountingStore(sqlite);
    accountingStore.seedAttemptWindow(storage.loadCohort()?.budget, Date.now());
    accounting = new L10AccountingService(accountingStore, {
      spending: new SQLitePlatformSpending(accountingStore, { history: () => storage.loadCohort()?.entries ?? [] }),
    });
    protectDatabase();
  }
  return accounting;
}
