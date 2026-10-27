import { AdapterFailure } from "./types";
import { L10AccountingStore, type AccountingRun, type AccountingReservation, type AccountingReceipt } from "./l10-accounting-store";
import { verifiedPrice, type VerifiedPrice } from "./platform-pricing";

export interface PlatformSpendingPolicy {
  admitRun(run: AccountingRun, models: string[]): void;
  reserve(run: AccountingRun, reservation: AccountingReservation): void;
  settle(reservation: AccountingReservation, receipt: AccountingReceipt): void;
  usage(): unknown;
}

const NANO = BigInt(1_000_000_000);
const fail = (code: string, message: string): never => { throw new AdapterFailure(code, message, null, false); };
const periodFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
});
export function pacificPeriods(timestamp: number) {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) fail("SPEND_HISTORY_UNVERIFIED", "Invalid spending timestamp");
  const parts = Object.fromEntries(periodFormatter.formatToParts(timestamp).map(p => [p.type, p.value]));
  const month = `${parts.year}-${parts.month}`;
  return { day: `${month}-${parts.day}`, month };
}

export function resolvePlatformCaps(env: NodeJS.ProcessEnv = process.env) {
  function integer(name: string, ceiling: number) {
    const raw = env[name];
    if (raw === undefined) return ceiling;
    if (!/^(0|[1-9]\d*)$/.test(raw)) fail("SPEND_CONFIG_INVALID", `${name} must lower the platform cap`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value > ceiling) fail("SPEND_CONFIG_INVALID", `${name} must lower the platform cap`);
    return value;
  }
  const raw = env.AGENT_COMMONS_MAX_MONTHLY_USD;
  if (raw !== undefined && !/^(0|[1-9]\d*)(\.\d{1,9})?$/.test(raw))
    fail("SPEND_CONFIG_INVALID", "AGENT_COMMONS_MAX_MONTHLY_USD must lower the platform cap");
  const [whole, fraction = ""] = (raw ?? "25").split(".");
  const monthlyNanoUsd = BigInt(whole) * NANO + BigInt(fraction.padEnd(9, "0"));
  if (monthlyNanoUsd > BigInt(25) * NANO) fail("SPEND_CONFIG_INVALID", "AGENT_COMMONS_MAX_MONTHLY_USD must lower the platform cap");
  return { dailyRuns: integer("AGENT_COMMONS_MAX_DAILY_RUNS", 4),
    dailyTokens: integer("AGENT_COMMONS_MAX_DAILY_TOKENS", 500_000), monthlyNanoUsd };
}

type Options = { now?: () => number; env?: NodeJS.ProcessEnv; history?: () => unknown;
  price?: (model: string, nowMs: number) => VerifiedPrice };
type SpendRow = { id: string; runtime_model: string; state: string; total_upper: number;
  charged_tokens: number | null; recorded_at_ms: number | null; actual_model: string | null;
  price_json: string | null; held_nano: string | null; charged_nano: string | null; liability_issue: string | null };

/** Same-connection SQLite policy: the service calls admission/reservation inside BEGIN IMMEDIATE. */
export class SQLitePlatformSpending implements PlatformSpendingPolicy {
  private readonly now: () => number;
  private readonly caps: ReturnType<typeof resolvePlatformCaps>;
  private readonly price: NonNullable<Options["price"]>;
  constructor(private readonly store: L10AccountingStore, private readonly options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.caps = resolvePlatformCaps(options.env);
    this.price = options.price ?? verifiedPrice;
    store.connection.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS platform_spending_calls (
        reservation_id TEXT PRIMARY KEY REFERENCES l10_reservations(id),
        price_json TEXT NOT NULL, held_nano TEXT NOT NULL,
        charged_nano TEXT, settled_at_ms INTEGER, liability_issue TEXT
      );`);
  }

  private rows(): SpendRow[] {
    return this.store.connection.prepare(`SELECT r.id,r.runtime_model,r.state,r.total_upper,
      c.charged_tokens,c.recorded_at_ms,c.actual_model,p.price_json,p.held_nano,p.charged_nano,p.liability_issue
      FROM l10_reservations r LEFT JOIN l10_consumption c ON c.reservation_id=r.id
      LEFT JOIN platform_spending_calls p ON p.reservation_id=r.id`).all();
  }
  private amount(tokens: number, rate: number): bigint {
    if (!Number.isSafeInteger(tokens) || tokens < 0 || !Number.isSafeInteger(rate) || rate < 0)
      fail("SPEND_HISTORY_UNVERIFIED", "Unsafe durable spending evidence");
    return BigInt(tokens) * BigInt(rate);
  }
  private relevant(row: SpendRow, month: string) {
    return ["reserved", "started"].includes(row.state) ||
      (row.recorded_at_ms !== null && pacificPeriods(row.recorded_at_ms).month === month);
  }
  private reconcile(now: number): number {
    let unpriced = 0;
    const { month } = pacificPeriods(now);
    for (const row of this.rows()) {
      if (!this.relevant(row, month)) continue;
      if (row.liability_issue) { unpriced++; continue; }
      if (row.price_json) continue;
      try {
        const requested = this.price(row.runtime_model, now);
        const actual = row.actual_model && row.actual_model !== row.runtime_model ? this.price(row.actual_model, now) : requested;
        const rate = Math.max(requested.nanoUsdPerToken, actual.nanoUsdPerToken);
        const snapshot = { ...requested, nanoUsdPerToken: rate, estimatedBackfill: true,
          ...(actual !== requested ? { actualPrice: actual } : {}) };
        this.store.connection.prepare(`INSERT INTO platform_spending_calls
          (reservation_id,price_json,held_nano,charged_nano,settled_at_ms) VALUES(?,?,?,?,?)`).run(
          row.id, JSON.stringify(snapshot), this.amount(row.total_upper, rate).toString(),
          row.charged_tokens === null ? null : this.amount(row.charged_tokens, rate).toString(), row.recorded_at_ms);
      } catch (error) {
        if (!(error instanceof AdapterFailure) || error.code !== "PRICE_UNVERIFIED") throw error;
        unpriced++;
      }
    }
    return unpriced;
  }
  private history(now: number) {
    const period = pacificPeriods(now);
    const entries = this.options.history?.() ?? [];
    if (!Array.isArray(entries)) return { status: "unverified", unreconciledDay: 1, unreconciledMonth: 1, linked: 0 };
    let unreconciledDay = 0, unreconciledMonth = 0, linked = 0;
    const linkedCalls = new Set<string>();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") { unreconciledDay++; unreconciledMonth++; continue; }
      const value = entry as Record<string, any>;
      if (value.stage === "contribution-report" || (typeof value.execution === "string" && /\b(?:offline|stub)\b/i.test(value.execution))) continue;
      const stamp = typeof value.time === "string" ? Date.parse(value.time) : NaN;
      const entryPeriod = Number.isSafeInteger(stamp) && stamp >= 0 ? pacificPeriods(stamp) : null;
      if (entryPeriod && entryPeriod.month !== period.month) continue;
      const link = value.accounting;
      const evidence = link && typeof link.callId === "string" && typeof link.runId === "string" ? this.store.callEvidence(link.callId) : null;
      if (evidence?.receipt && evidence.receipt.state !== "released" && evidence.reservation.runId === link.runId && evidence.reservation.slotId === value.agent && !linkedCalls.has(link.callId)) {
        linked++; linkedCalls.add(link.callId); continue;
      }
      unreconciledMonth++;
      if (!entryPeriod || entryPeriod.day === period.day) unreconciledDay++;
    }
    return { status: unreconciledMonth ? "unverified" : "verified", unreconciledDay, unreconciledMonth, linked };
  }
  private snapshot(now: number) {
    const period = pacificPeriods(now);
    const unpricedCalls = this.reconcile(now);
    let chargedTokens = BigInt(0), heldTokens = BigInt(0), chargedNano = BigInt(0), heldNano = BigInt(0);
    for (const row of this.rows()) {
      if (["reserved", "started"].includes(row.state)) {
        heldTokens += BigInt(row.total_upper);
        if (row.held_nano !== null) heldNano += BigInt(row.held_nano);
      }
      if (row.recorded_at_ms !== null) {
        const recorded = pacificPeriods(row.recorded_at_ms);
        if (recorded.day === period.day) chargedTokens += BigInt(row.charged_tokens ?? 0);
        if (recorded.month === period.month && row.charged_nano !== null) chargedNano += BigInt(row.charged_nano);
      }
    }
    const runs = this.store.connection.prepare("SELECT id,started_at_ms FROM l10_runs WHERE kind!='probe'").all();
    const today = new Set(runs.filter(run => pacificPeriods(run.started_at_ms).day === period.day).map(run => run.id));
    const reservations = this.store.connection.prepare(`SELECT r.run_id,r.created_at_ms FROM l10_reservations r
      JOIN l10_runs run ON run.id=r.run_id WHERE run.kind!='probe'`).all();
    for (const reservation of reservations)
      if (pacificPeriods(reservation.created_at_ms).day === period.day) today.add(reservation.run_id);
    const acceptedRuns = today.size;
    return { period, acceptedRuns, chargedTokens, heldTokens, chargedNano, heldNano, unpricedCalls, history: this.history(now) };
  }
  private assertAvailable(snapshot: ReturnType<SQLitePlatformSpending["snapshot"]>) {
    if (snapshot.history.unreconciledMonth) fail("SPEND_HISTORY_UNVERIFIED", "Current-month paid history lacks exact durable receipt links");
    if (snapshot.unpricedCalls) fail("PRICE_UNVERIFIED", "Current spending has unverified prices or liabilities");
    if (snapshot.chargedTokens + snapshot.heldTokens >= BigInt(this.caps.dailyTokens)) fail("SPEND_DAILY_TOKENS", "Platform daily token cap reached");
    if (snapshot.chargedNano + snapshot.heldNano >= this.caps.monthlyNanoUsd) fail("SPEND_MONTHLY_USD", "Platform monthly USD cap reached");
  }
  admitRun(run: AccountingRun, models: string[]) {
    if (run.kind === "probe") return;
    this.store.atomic(() => {
      const now = this.now();
      if (!models.length) fail("PRICE_UNVERIFIED", "Paid admission requires resolved runtime models");
      for (const model of Array.from(new Set(models))) this.price(model, now);
      const snapshot = this.snapshot(now); this.assertAvailable(snapshot);
      if (snapshot.acceptedRuns >= this.caps.dailyRuns) fail("SPEND_DAILY_RUNS", "Platform daily accepted-run cap reached");
    });
  }
  reserve(run: AccountingRun, reservation: AccountingReservation) {
    if (run.kind === "probe") fail("LIMIT_UNSUPPORTED", "Free probes cannot reserve paid generation");
    this.store.atomic(() => {
      const now = this.now(), price = this.price(reservation.runtimeModel, now);
      // The reservation row exists in the enclosing transaction; exclude its
      // tokens until its monetary snapshot is pinned below.
      const snapshot = this.snapshot(now);
      snapshot.heldTokens -= BigInt(reservation.totalTokensUpper);
      const prior = this.store.connection.prepare("SELECT held_nano FROM platform_spending_calls WHERE reservation_id=?").get(reservation.id);
      if (prior) snapshot.heldNano -= BigInt(prior.held_nano);
      this.assertAvailable(snapshot);
      if (this.caps.dailyRuns === 0 || snapshot.acceptedRuns > this.caps.dailyRuns)
        fail("SPEND_DAILY_RUNS", "Reservation exceeds the current daily accepted-run cap");
      const hold = this.amount(reservation.totalTokensUpper, price.nanoUsdPerToken);
      if (snapshot.chargedTokens + snapshot.heldTokens + BigInt(reservation.totalTokensUpper) > BigInt(this.caps.dailyTokens))
        fail("SPEND_DAILY_TOKENS", "Reservation exceeds platform daily token cap");
      if (snapshot.chargedNano + snapshot.heldNano + hold > this.caps.monthlyNanoUsd)
        fail("SPEND_MONTHLY_USD", "Reservation exceeds platform monthly USD cap");
      this.store.connection.prepare(`INSERT INTO platform_spending_calls(reservation_id,price_json,held_nano)
        VALUES(?,?,?) ON CONFLICT(reservation_id) DO UPDATE SET price_json=excluded.price_json,held_nano=excluded.held_nano`).run(
          reservation.id, JSON.stringify(price), hold.toString());
    });
  }
  settle(reservation: AccountingReservation, receipt: AccountingReceipt) {
    this.store.atomic(() => {
      let row = this.store.connection.prepare("SELECT * FROM platform_spending_calls WHERE reservation_id=?").get(reservation.id);
      if (!row) {
        // Recovery may encounter a pre-policy outstanding reservation.
        this.reconcile(this.now());
        row = this.store.connection.prepare("SELECT * FROM platform_spending_calls WHERE reservation_id=?").get(reservation.id);
      }
      if (!row) return; // Durable token receipt remains; new admission fails PRICE_UNVERIFIED.
      let price: VerifiedPrice;
      try {
        price = JSON.parse(row.price_json) as VerifiedPrice;
        this.amount(receipt.chargedTokens, price.nanoUsdPerToken);
      } catch {
        this.store.connection.prepare(`UPDATE platform_spending_calls SET charged_nano=NULL,settled_at_ms=?,liability_issue='PRICE_UNVERIFIED'
          WHERE reservation_id=?`).run(receipt.recordedAtMs,reservation.id);
        return;
      }
      let rate = price.nanoUsdPerToken, issue: string | null = null, actualPrice: VerifiedPrice | undefined;
      if (receipt.actualModel && receipt.actualModel !== reservation.runtimeModel) {
        try { actualPrice = this.price(receipt.actualModel, receipt.recordedAtMs); rate = Math.max(rate, actualPrice.nanoUsdPerToken); }
        catch { issue = "PRICE_UNVERIFIED"; }
      }
      this.store.connection.prepare(`UPDATE platform_spending_calls SET charged_nano=?,settled_at_ms=?,liability_issue=?,price_json=?
        WHERE reservation_id=?`).run(this.amount(receipt.chargedTokens, rate).toString(), receipt.recordedAtMs, issue,
          JSON.stringify({ ...price, ...(actualPrice ? { actualPrice } : {}) }), reservation.id);
    });
  }
  usage() {
    return this.store.atomic(() => {
      const value = this.snapshot(this.now());
      const evidenceCode = value.history.unreconciledMonth ? "SPEND_HISTORY_UNVERIFIED" : value.unpricedCalls ? "PRICE_UNVERIFIED" : null;
      const exhaustedCaps = [value.acceptedRuns >= this.caps.dailyRuns ? "SPEND_DAILY_RUNS" : null,
        value.chargedTokens + value.heldTokens >= BigInt(this.caps.dailyTokens) ? "SPEND_DAILY_TOKENS" : null,
        value.chargedNano + value.heldNano >= this.caps.monthlyNanoUsd ? "SPEND_MONTHLY_USD" : null].filter(Boolean);
      return { timezone: "America/Los_Angeles", day: value.period.day, month: value.period.month,
        limits: { dailyRuns: this.caps.dailyRuns, dailyTokens: this.caps.dailyTokens, monthlyUsd: Number(this.caps.monthlyNanoUsd) / 1e9 },
        daily: { acceptedRuns: value.acceptedRuns, chargedTokens: Number(value.chargedTokens), outstandingTokens: Number(value.heldTokens),
          totalTokens: value.history.unreconciledDay ? null : Number(value.chargedTokens + value.heldTokens) },
        monthly: { chargedUsd: Number(value.chargedNano) / 1e9, outstandingUsd: Number(value.heldNano) / 1e9,
          totalUsd: evidenceCode ? null : Number(value.chargedNano + value.heldNano) / 1e9,
          complete: evidenceCode === null,
          chargedNanoUsd: value.chargedNano.toString(), outstandingNanoUsd: value.heldNano.toString() },
        history: value.history, unpricedCalls: value.unpricedCalls,
        evidenceStatus: evidenceCode ? "unverified" : "verified", exhaustedCaps,
        status: evidenceCode ? "blocked" : exhaustedCaps.length ? "limited" : "verified", code: evidenceCode ?? exhaustedCaps[0] ?? null,
        accountingBasis: "Recorded receipt/hold estimates only; unresolved current-month legacy entries have unknown additional spend and require exact signed call/run links" };
    });
  }
}
