import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { digest } from "./profiles.mjs";

export class CommonsStore {
  constructor(path=":memory:") {
    if(path!==":memory:")mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY,v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS envelopes(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,sender TEXT NOT NULL,recipient TEXT NOT NULL,sha TEXT NOT NULL,body TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS inbox_recipient ON envelopes(recipient,seq);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,previous TEXT NOT NULL,hash TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,body TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'pending',error TEXT);
      CREATE TABLE IF NOT EXISTS processed(id TEXT PRIMARY KEY,hash TEXT NOT NULL);
    `);
    if(!this.db.prepare("PRAGMA table_info(outbox)").all().some(c=>c.name==="profile_id"))this.db.exec("ALTER TABLE outbox ADD COLUMN profile_id TEXT");
    if(path!==":memory:")chmodSync(path,0o600);
  }
  get(key,fallback=null){const row=this.db.prepare("SELECT v FROM kv WHERE k=?").get(key);return row?JSON.parse(row.v):fallback}
  set(key,value){this.db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(key,JSON.stringify(value))}
  transaction(fn){this.db.exec("BEGIN IMMEDIATE");try{const result=fn();this.db.exec("COMMIT");return result}catch(e){this.db.exec("ROLLBACK");throw e}}
  append(id,event){
    const existing=this.db.prepare("SELECT * FROM events WHERE id=?").get(id);if(existing){if(digest(JSON.parse(existing.body))!==digest(event))throw new Error("Audit event ID conflicts with content");return {...existing,duplicate:true}};
    const previous=this.db.prepare("SELECT hash FROM events ORDER BY seq DESC LIMIT 1").get()?.hash??"genesis";
    const hash=digest({previous,event});
    this.db.prepare("INSERT INTO events(id,previous,hash,body) VALUES(?,?,?,?)").run(id,previous,hash,JSON.stringify(event));
    return {id,previous,hash};
  }
  verify(){let previous="genesis";return this.db.prepare("SELECT * FROM events ORDER BY seq").all().every(r=>{const ok=r.previous===previous&&r.hash===digest({previous,event:JSON.parse(r.body)});previous=r.hash;return ok})}
  audit(){return this.db.prepare("SELECT * FROM events ORDER BY seq DESC LIMIT 100").all()}
  seen(id,hash=null){const row=this.db.prepare("SELECT hash FROM processed WHERE id=?").get(id);if(row&&hash&&row.hash!==hash)throw new Error("Replay ID conflicts with signed content");return !!row}
  mark(id,hash){this.db.prepare("INSERT INTO processed(id,hash) VALUES(?,?)").run(id,hash)}
  retain(envelope,sha,ttlMs=14*86400000){
    const existing=this.db.prepare("SELECT seq,sha FROM envelopes WHERE id=?").get(envelope.id);
    if(existing){if(existing.sha!==sha)throw new Error("Envelope ID conflicts with existing content");return {...existing,duplicate:true}}
    this.db.prepare("DELETE FROM envelopes WHERE expires<?").run(Date.now());
    if(this.db.prepare("SELECT COUNT(*) AS n FROM envelopes").get().n>=10000||this.db.prepare("PRAGMA page_count").get().page_count*this.db.prepare("PRAGMA page_size").get().page_size>=256*1024*1024)throw new Error("Carrier storage budget exhausted");
    const r=this.db.prepare("INSERT INTO envelopes(id,sender,recipient,sha,body,expires) VALUES(?,?,?,?,?,?)").run(envelope.id,envelope.sender,envelope.recipient,sha,JSON.stringify(envelope),Date.now()+ttlMs);
    return {seq:Number(r.lastInsertRowid),sha,duplicate:false};
  }
  inbox(recipient,since=0){return this.db.prepare("SELECT seq,body FROM envelopes WHERE recipient=? AND seq>? AND expires>? ORDER BY seq LIMIT 100").all(recipient,since,Date.now()).map(r=>({seq:r.seq,envelope:JSON.parse(r.body)}))}
  queue(envelope,profileId=null){this.db.prepare("INSERT OR IGNORE INTO outbox(id,body,profile_id) VALUES(?,?,?)").run(envelope.id,JSON.stringify(envelope),profileId)}
  pending(){return this.db.prepare("SELECT * FROM outbox WHERE state='pending' AND next_at<=? ORDER BY rowid LIMIT 50").all(Date.now())}
  delivered(id){this.db.prepare("UPDATE outbox SET state='accepted',error=NULL WHERE id=?").run(id)}
  failure(id,error){const row=this.db.prepare("SELECT attempts FROM outbox WHERE id=?").get(id);const attempts=row.attempts+1;const state=attempts>=5?"quarantined":"pending";this.db.prepare("UPDATE outbox SET attempts=?,next_at=?,state=?,error=? WHERE id=?").run(attempts,Date.now()+Math.min(300000,1000*2**attempts),state,error.slice(0,300),id)}
  close(){this.db.close()}
}
