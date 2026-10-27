import { AdapterFailure } from "./types";

/** Inject a connection; importing this module never opens the application DB. */
export interface AccountingDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): { run(...values: any[]): any; get(...values: any[]): any; all(...values: any[]): any[] };
}
export type AgentLadder = { currentLimit: number; boostStreak: number; nonBoostStreak: number; hold: boolean };
export type AccountingRun = {
  id: string; kind: "cohort" | "probe" | "engine"; state: "active" | "closed" | "exhausted";
  baseTurnLimit: number; grantedTurnLimit: number; multiplier: number;
  chargedTokens: number; reservedTokens: number; attemptedTurns: number;
  eligibleSlots: string[]; excludedSlots: string[]; ladder: Record<string, AgentLadder>;
  startedAtMs: number; deadlineAtMs: number;
};
export type AccountingReservation = {
  id: string; runId: string; callId: string; slotId: string; runtimeModel: string;
  state: "reserved" | "started" | "settled" | "released" | "uncertain";
  promptTokensUpper: number; completionLimit: number; totalTokensUpper: number;
  createdAtMs: number; startedAtMs: number | null; terminalAtMs: number | null;
};
export type AccountingReceipt = {
  reservationId: string; signature: string; state: "settled" | "released" | "uncertain";
  chargedTokens: number; releasedTokens: number; outcomeCode: string;
  usageJson: string | null; metricsJson: string | null; recordedAtMs: number;
  actualModel: string | null;
};
export type AccountingCallEvidence = { reservation: AccountingReservation; receipt: AccountingReceipt | null };
export type AccountingSlotTotals = { calls: number; started: number; chargedTokens: number };

export class L10AccountingStore {
  private inTransaction = false;
  constructor(readonly connection: AccountingDatabase) {
    connection.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS l10_runs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
        base_turn_limit INTEGER NOT NULL CHECK(base_turn_limit BETWEEN 1 AND 28),
        granted_turn_limit INTEGER NOT NULL CHECK(granted_turn_limit BETWEEN 1 AND 84),
        multiplier INTEGER NOT NULL CHECK(multiplier BETWEEN 1 AND 3),
        charged_tokens INTEGER NOT NULL CHECK(charged_tokens BETWEEN 0 AND 9007199254740991),
        reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens BETWEEN 0 AND 9007199254740991),
        attempted_turns INTEGER NOT NULL CHECK(attempted_turns BETWEEN 0 AND 84),
        eligible_slots TEXT NOT NULL, excluded_slots TEXT NOT NULL, ladder TEXT NOT NULL,
        started_at_ms INTEGER NOT NULL, deadline_at_ms INTEGER NOT NULL,
        policy_version INTEGER NOT NULL DEFAULT 1 CHECK(policy_version=1),
        token_cap INTEGER NOT NULL DEFAULT 250000 CHECK(token_cap=250000)
      );
      CREATE TABLE IF NOT EXISTS l10_reservations (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES l10_runs(id), call_id TEXT NOT NULL UNIQUE,
        slot_id TEXT NOT NULL, runtime_model TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('reserved','started','settled','released','uncertain')),
        prompt_upper INTEGER NOT NULL CHECK(prompt_upper BETWEEN 0 AND 9007199254740991),
        completion_limit INTEGER NOT NULL CHECK(completion_limit BETWEEN 1 AND 24000),
        total_upper INTEGER NOT NULL CHECK(total_upper BETWEEN 1 AND 249999),
        created_at_ms INTEGER NOT NULL, started_at_ms INTEGER, terminal_at_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS l10_reservations_run_state ON l10_reservations(run_id,state);
      CREATE TABLE IF NOT EXISTS l10_consumption (
        reservation_id TEXT PRIMARY KEY REFERENCES l10_reservations(id), signature TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('settled','released','uncertain')),
        charged_tokens INTEGER NOT NULL CHECK(charged_tokens BETWEEN 0 AND 9007199254740991),
        released_tokens INTEGER NOT NULL CHECK(released_tokens BETWEEN 0 AND 249999),
        outcome_code TEXT NOT NULL, usage_json TEXT, metrics_json TEXT, recorded_at_ms INTEGER NOT NULL, actual_model TEXT
      );
      CREATE TABLE IF NOT EXISTS l10_attempt_window (
        id INTEGER PRIMARY KEY CHECK(id=1), started_at_ms INTEGER NOT NULL,
        attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 100)
      );`);
  }

  atomic<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.connection.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try { const result = fn(); this.connection.exec("COMMIT"); return result; }
    catch (error) { this.connection.exec("ROLLBACK"); throw error; }
    finally { this.inTransaction = false; }
  }

  getRun(id: string): AccountingRun | null {
    const r = this.connection.prepare("SELECT * FROM l10_runs WHERE id=?").get(id);
    if(r&&(r.policy_version!==1||r.token_cap!==250000))throw new AdapterFailure("ACCOUNTING_STORAGE_FAILED","Unsupported accounting policy",null,false);
    return r ? { id:r.id,kind:r.kind,state:r.state,baseTurnLimit:r.base_turn_limit,
      grantedTurnLimit:r.granted_turn_limit,multiplier:r.multiplier,chargedTokens:r.charged_tokens,
      reservedTokens:r.reserved_tokens,attemptedTurns:r.attempted_turns,
      eligibleSlots:JSON.parse(r.eligible_slots),excludedSlots:JSON.parse(r.excluded_slots),ladder:JSON.parse(r.ladder),
      startedAtMs:r.started_at_ms,deadlineAtMs:r.deadline_at_ms } : null;
  }
  insertRun(r: AccountingRun): void {
    this.connection.prepare(`INSERT INTO l10_runs(id,kind,state,base_turn_limit,granted_turn_limit,multiplier,
      charged_tokens,reserved_tokens,attempted_turns,eligible_slots,excluded_slots,ladder,started_at_ms,deadline_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      r.id,r.kind,r.state,r.baseTurnLimit,r.grantedTurnLimit,r.multiplier,r.chargedTokens,r.reservedTokens,
      r.attemptedTurns,JSON.stringify(r.eligibleSlots),JSON.stringify(r.excludedSlots),JSON.stringify(r.ladder),r.startedAtMs,r.deadlineAtMs);
  }
  putRun(r: AccountingRun): void {
    this.connection.prepare(`UPDATE l10_runs SET state=?,granted_turn_limit=?,multiplier=?,charged_tokens=?,reserved_tokens=?,
      attempted_turns=?,excluded_slots=?,ladder=? WHERE id=?`).run(r.state,r.grantedTurnLimit,r.multiplier,
      r.chargedTokens,r.reservedTokens,r.attemptedTurns,JSON.stringify(r.excludedSlots),JSON.stringify(r.ladder),r.id);
  }
  private decodeReservation(r: any): AccountingReservation | null {
    return r ? {id:r.id,runId:r.run_id,callId:r.call_id,slotId:r.slot_id,runtimeModel:r.runtime_model,state:r.state,
      promptTokensUpper:r.prompt_upper,completionLimit:r.completion_limit,totalTokensUpper:r.total_upper,
      createdAtMs:r.created_at_ms,startedAtMs:r.started_at_ms,terminalAtMs:r.terminal_at_ms} : null;
  }
  getReservation(id: string): AccountingReservation | null {
    return this.decodeReservation(this.connection.prepare("SELECT * FROM l10_reservations WHERE id=?").get(id));
  }
  reservationForCall(callId: string): AccountingReservation | null {
    return this.decodeReservation(this.connection.prepare("SELECT * FROM l10_reservations WHERE call_id=?").get(callId));
  }
  callEvidence(callId: string): AccountingCallEvidence | null {
    return this.atomic(() => {
      const reservation = this.reservationForCall(callId);
      return reservation ? { reservation, receipt: this.getReceipt(reservation.id) } : null;
    });
  }
  slotTotals(): Record<string, AccountingSlotTotals> {
    const rows = this.connection.prepare(`SELECT r.slot_id AS slotId, COUNT(*) AS calls,
      SUM(CASE WHEN r.started_at_ms IS NOT NULL THEN 1 ELSE 0 END) AS started,
      COALESCE(SUM(c.charged_tokens),0) AS chargedTokens
      FROM l10_reservations r LEFT JOIN l10_consumption c ON c.reservation_id=r.id
      GROUP BY r.slot_id ORDER BY r.slot_id`).all();
    return Object.fromEntries(rows.map(r => [r.slotId, { calls: r.calls, started: r.started, chargedTokens: r.chargedTokens }]));
  }
  insertReservation(r: AccountingReservation): void {
    this.connection.prepare("INSERT INTO l10_reservations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
      r.id,r.runId,r.callId,r.slotId,r.runtimeModel,r.state,r.promptTokensUpper,r.completionLimit,r.totalTokensUpper,
      r.createdAtMs,r.startedAtMs,r.terminalAtMs);
  }
  putReservation(r: AccountingReservation): void {
    this.connection.prepare("UPDATE l10_reservations SET state=?,started_at_ms=?,terminal_at_ms=? WHERE id=?")
      .run(r.state,r.startedAtMs,r.terminalAtMs,r.id);
  }
  outstanding(runId: string): AccountingReservation[] {
    return this.connection.prepare("SELECT * FROM l10_reservations WHERE run_id=? AND state IN ('reserved','started')")
      .all(runId).map(r=>this.decodeReservation(r)!);
  }
  totals(runId: string): {reserved:number;charged:number} {
    const reserved=this.connection.prepare("SELECT COALESCE(SUM(total_upper),0) AS n FROM l10_reservations WHERE run_id=? AND state IN ('reserved','started')").get(runId).n;
    const charged=this.connection.prepare("SELECT COALESCE(SUM(c.charged_tokens),0) AS n FROM l10_consumption c JOIN l10_reservations r ON r.id=c.reservation_id WHERE r.run_id=?").get(runId).n;
    return {reserved,charged};
  }
  getReceipt(id: string): AccountingReceipt | null {
    const r=this.connection.prepare("SELECT * FROM l10_consumption WHERE reservation_id=?").get(id);
    return r ? {reservationId:r.reservation_id,signature:r.signature,state:r.state,chargedTokens:r.charged_tokens,
      releasedTokens:r.released_tokens,outcomeCode:r.outcome_code,usageJson:r.usage_json,metricsJson:r.metrics_json,recordedAtMs:r.recorded_at_ms,actualModel:r.actual_model} : null;
  }
  insertReceipt(r: AccountingReceipt): void {
    this.connection.prepare("INSERT INTO l10_consumption VALUES (?,?,?,?,?,?,?,?,?,?)").run(r.reservationId,r.signature,
      r.state,r.chargedTokens,r.releasedTokens,r.outcomeCode,r.usageJson,r.metricsJson,r.recordedAtMs,r.actualModel);
  }
  consumeAttempt(now: number): void {
    let row=this.connection.prepare("SELECT * FROM l10_attempt_window WHERE id=1").get();
    if (!row || now-row.started_at_ms>=3600000) {
      this.connection.prepare("INSERT INTO l10_attempt_window VALUES(1,?,0) ON CONFLICT(id) DO UPDATE SET started_at_ms=excluded.started_at_ms,attempts=0").run(now);
      row={attempts:0};
    }
    if(row.attempts>=100) throw new AdapterFailure("BUDGET_EXHAUSTED","L10 hourly accounting attempt budget exhausted",null,false);
    this.connection.prepare("UPDATE l10_attempt_window SET attempts=attempts+1 WHERE id=1").run();
  }
  seedAttemptWindow(budget: {windowStart:number;attempts:number}|undefined, now:number):void {
    if(!budget||!Number.isSafeInteger(budget.windowStart)||!Number.isSafeInteger(budget.attempts)||
      budget.attempts<0||budget.attempts>100||budget.windowStart>now||now-budget.windowStart>=3600000)return;
    this.atomic(()=>{
      const current=this.connection.prepare("SELECT * FROM l10_attempt_window WHERE id=1").get();
      if(!current||now-current.started_at_ms>=3600000){
        this.connection.prepare("INSERT INTO l10_attempt_window VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET started_at_ms=excluded.started_at_ms,attempts=excluded.attempts")
          .run(budget.windowStart,budget.attempts);
      }else{
        this.connection.prepare("UPDATE l10_attempt_window SET attempts=MAX(attempts,?),started_at_ms=MAX(started_at_ms,?) WHERE id=1")
          .run(budget.attempts,budget.windowStart);
      }
    });
  }
}
