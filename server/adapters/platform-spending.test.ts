import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { L10AccountingStore } from "./l10-accounting-store";
import { L10AccountingService } from "./l10-accounting";
import { markAccountingDispatchStarted } from "./l10-admission";
import { SQLitePlatformSpending, resolvePlatformCaps, pacificPeriods, type PlatformSpendingPolicy } from "./platform-spending";
import { verifiedPrice } from "./platform-pricing";
import { AdapterFailure } from "./types";

const noon = Date.parse("2026-10-27T12:00:00-07:00");
const model = "claude-sonnet-5-5";
const fake: PlatformSpendingPolicy = { admitRun(){}, reserve(){}, settle(){}, usage(){return {fixture:true};} };
const code = (expected: string) => (error: any) => error?.code === expected;
function fixture(t: TestContext, env: NodeJS.ProcessEnv = {}, history: unknown[] = [], database = ":memory:") {
  const db = new DatabaseSync(database); t.after(() => db.close());
  const clock = { now: noon };
  const store = new L10AccountingStore(db);
  const policy = new SQLitePlatformSpending(store, { env, now: () => clock.now, history: () => history });
  const service = new L10AccountingService(store, { now: () => clock.now, spending: policy });
  const run = () => service.createRun({ kind: "cohort", baseTurnLimit: 7, eligibleSlots: ["slot"], models: [model] });
  return { db, store, policy, service, clock, run };
}
function reserve(service: L10AccountingService, runId: string, callId: string, total = 1850, runtimeModel = model) {
  return service.reserveCall({ runId, callId, slotId: "slot", runtimeModel,
    promptTokensUpper: total - Math.min(1800, total), completionLimit: Math.min(1800, total), totalTokensUpper: total });
}
function settle(service: L10AccountingService, admitted: ReturnType<typeof reserve>, tokens: number | null, actualModel = model) {
  markAccountingDispatchStarted(admitted.permit);
  return service.settleCall(admitted.permit, { outcomeCode: tokens === null ? "TIMEOUT" : "OK", actualModel,
    usage: tokens === null ? null : { promptTokens: 0, completionTokens: tokens, totalTokens: tokens,
      coversInternalCalls: true, source: "provider-response", fieldPath: "usage" } });
}

test("platform: lower-only configuration accepts zero and rejects increases, malformed values and precision loss", () => {
  assert.equal(resolvePlatformCaps({}).dailyRuns, 4);
  assert.equal(resolvePlatformCaps({}).dailyTokens, 500000);
  assert.equal(resolvePlatformCaps({}).monthlyNanoUsd.toString(), "25000000000");
  assert.equal(resolvePlatformCaps({ AGENT_COMMONS_MAX_MONTHLY_USD: "0.000000001" }).monthlyNanoUsd.toString(), "1");
  for (const [name, values] of Object.entries({ AGENT_COMMONS_MAX_DAILY_RUNS: ["5", "-1", "1.5", "", " 1", "Infinity"],
    AGENT_COMMONS_MAX_DAILY_TOKENS: ["500001", "-1", "1e3", "NaN"],
    AGENT_COMMONS_MAX_MONTHLY_USD: ["25.000000001", "26", "-1", "0.0000000001", "", " 1", "NaN"] }))
    for (const value of values) assert.throws(() => resolvePlatformCaps({ [name]: value }), code("SPEND_CONFIG_INVALID"));
  const zero = resolvePlatformCaps({ AGENT_COMMONS_MAX_DAILY_RUNS: "0", AGENT_COMMONS_MAX_DAILY_TOKENS: "0", AGENT_COMMONS_MAX_MONTHLY_USD: "0" });
  assert.equal(zero.dailyRuns + zero.dailyTokens + Number(zero.monthlyNanoUsd), 0);
});

test("platform: four accepted runs globally; free probes cannot reserve; missing policy fails closed", t => {
  const f = fixture(t);
  for (let i = 0; i < 4; i++) f.run();
  assert.throws(f.run, code("SPEND_DAILY_RUNS"));
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM l10_runs WHERE kind!='probe'").get()!.n, 4);
  const probe = f.service.createRun({ kind: "probe", baseTurnLimit: 7, eligibleSlots: ["slot"] });
  assert.throws(() => reserve(f.service, probe.id, "probe-paid"), code("LIMIT_UNSUPPORTED"));
  const missing = new L10AccountingService(f.store, { now: () => noon });
  assert.throws(() => missing.createRun({ kind: "cohort", baseTurnLimit: 7, eligibleSlots: ["slot"] }), code("SPEND_POLICY_REQUIRED"));
  const free = missing.createRun({ kind: "probe", baseTurnLimit: 7, eligibleSlots: ["slot"] });
  assert.throws(() => reserve(missing, free.id, "missing-policy"), code("LIMIT_UNSUPPORTED"));
});

test("platform: zero in any lower-only cap refuses new paid work", t => {
  for (const [name, expected] of [["AGENT_COMMONS_MAX_DAILY_RUNS", "SPEND_DAILY_RUNS"],
    ["AGENT_COMMONS_MAX_DAILY_TOKENS", "SPEND_DAILY_TOKENS"], ["AGENT_COMMONS_MAX_MONTHLY_USD", "SPEND_MONTHLY_USD"]]) {
    const f = fixture(t, { [name]: "0" });
    assert.throws(f.run, code(expected));
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM l10_runs").get()!.n, 0);
  }
});

test("platform: all run holds share the daily token ceiling and refusal rolls back attempts and rows", t => {
  const f = fixture(t);
  const first = f.run(), second = f.run(), third = f.run();
  reserve(f.service, first.id, "large-first", 249999);
  reserve(f.service, second.id, "large-second", 249999);
  assert.throws(() => reserve(f.service, third.id, "over-token"), code("SPEND_DAILY_TOKENS"));
  const usage: any = f.policy.usage();
  assert.equal(usage.daily.outstandingTokens, 499998);
  assert.equal(f.store.getRun(third.id)!.reservedTokens, 0);
  assert.equal(f.db.prepare("SELECT attempts FROM l10_attempt_window").get()!.attempts, 2);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM l10_reservations").get()!.n, 2);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM platform_spending_calls").get()!.n, 2);
});

test("platform: every reservation rechecks lowered run caps and counts yesterday's active run on today's first reservation", t => {
  const f = fixture(t); const run = f.run();
  const zeroPolicy = new SQLitePlatformSpending(f.store, { env: { AGENT_COMMONS_MAX_DAILY_RUNS: "0" }, now: () => f.clock.now });
  const restarted = new L10AccountingService(f.store, { now: () => f.clock.now, spending: zeroPolicy });
  assert.throws(() => reserve(restarted, run.id, "lowered-to-zero"), code("SPEND_DAILY_RUNS"));
  f.clock.now = Date.parse("2026-10-27T23:59:59-07:00");
  const yesterday = f.run();
  f.clock.now += 2000;
  for (let i = 0; i < 4; i++) f.run();
  assert.throws(() => reserve(f.service, yesterday.id, "fifth-cross-midnight"), code("SPEND_DAILY_RUNS"));
  assert.equal(f.store.reservationForCall("fifth-cross-midnight"), null);
  assert.equal((f.policy.usage() as any).daily.acceptedRuns, 4);
});

test("platform: monthly holds, conservative uncertain charge and duplicate settlement persist without refunds", t => {
  const f = fixture(t, { AGENT_COMMONS_MAX_MONTHLY_USD: "0.02035" });
  const first = f.run(), second = f.run();
  const admitted = reserve(f.service, first.id, "hold-exact");
  assert.throws(() => reserve(f.service, second.id, "over-money"), code("SPEND_MONTHLY_USD"));
  const result = settle(f.service, admitted, null);
  assert.equal(result.state, "uncertain"); assert.equal(result.chargedTokens, 1850);
  const duplicate = f.service.settleCall(admitted.permit, { usage: null, outcomeCode: "TIMEOUT", actualModel: model });
  assert.equal(duplicate.duplicate, true);
  const usage: any = f.policy.usage();
  assert.equal(usage.monthly.chargedNanoUsd, "20350000"); assert.equal(usage.monthly.outstandingNanoUsd, "0");
  assert.throws(() => f.service.releaseUnstarted(admitted.permit, "REFUND"), code("ACCOUNTING_CONFLICT"));
  assert.throws(f.run, code("SPEND_MONTHLY_USD"));
});

test("platform: partial monthly headroom rejects an overshooting reservation and active runs recheck history", t => {
  const history: unknown[] = [], f = fixture(t, {}, history);
  const previous = f.run();
  const settled = settle(f.service, reserve(f.service, previous.id, "previous-day-spend"), 2_270_000);
  assert.equal(settled.outcomeCode, "ACCOUNTING_OVERRUN");
  f.clock.now = Date.parse("2026-10-28T12:00:00-07:00");
  const active = f.run(), before: any = f.policy.usage();
  assert.equal(before.limits.dailyRuns, 4);
  assert.equal(before.limits.dailyTokens, 500000);
  assert.equal(before.limits.monthlyUsd, 25);
  assert.equal(before.daily.acceptedRuns, 1);
  assert.equal(before.daily.chargedTokens, 0);
  assert.equal(before.daily.outstandingTokens, 0);
  assert.equal(before.monthly.chargedNanoUsd, "24970000000");
  assert.equal(before.monthly.outstandingNanoUsd, "0");
  assert.throws(() => reserve(f.service, active.id, "partial-month-overshoot", 3000), code("SPEND_MONTHLY_USD"));
  assert.equal(f.store.reservationForCall("partial-month-overshoot"), null);
  assert.equal(f.store.getRun(active.id)!.reservedTokens, 0);
  assert.deepEqual(f.policy.usage(), before);

  history.push({ time: "2026-10-28T11:00:00-07:00", agent: "slot", execution: "unknown paid route" });
  assert.throws(() => reserve(f.service, active.id, "history-changed-after-admission", 1), code("SPEND_HISTORY_UNVERIFIED"));
  assert.equal(f.store.reservationForCall("history-changed-after-admission"), null);
  assert.equal(f.store.getRun(active.id)!.reservedTokens, 0);
  const blocked: any = f.policy.usage();
  assert.equal(blocked.history.unreconciledMonth, 1);
  assert.equal(blocked.monthly.chargedNanoUsd, before.monthly.chargedNanoUsd);
  assert.equal(blocked.monthly.outstandingNanoUsd, "0");
});

test("platform: actual overrun is recorded before later admissions are blocked", t => {
  const f = fixture(t, { AGENT_COMMONS_MAX_DAILY_TOKENS: "1000", AGENT_COMMONS_MAX_MONTHLY_USD: "0.011" });
  const run = f.run(), admitted = reserve(f.service, run.id, "overrun", 100);
  const result = settle(f.service, admitted, 1200);
  assert.equal(result.outcomeCode, "ACCOUNTING_OVERRUN");
  assert.equal(f.store.callEvidence("overrun")!.receipt!.chargedTokens, 1200);
  assert.equal(f.db.prepare("SELECT charged_nano FROM platform_spending_calls").get()!.charged_nano, "13200000");
  assert.equal((f.policy.usage() as any).daily.chargedTokens, 1200);
  assert.throws(f.run, code("SPEND_DAILY_TOKENS"));
});

test("platform: transaction rollback removes a policy hold together with the reservation", t => {
  const f = fixture(t); const run = f.run();
  const failing = new L10AccountingService(f.store, { now: () => noon, spending: {
    admitRun: (...args) => f.policy.admitRun(...args), settle: (...args) => f.policy.settle(...args), usage: () => f.policy.usage(),
    reserve(...args) { f.policy.reserve(...args); throw new Error("fixture rollback"); },
  } });
  assert.throws(() => reserve(failing, run.id, "rolled-back"), /fixture rollback/);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM platform_spending_calls").get()!.n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM l10_reservations").get()!.n, 0);
  assert.equal(f.store.getRun(run.id)!.reservedTokens, 0);
});

test("platform: unknown actual model and corrupt pinned price preserve token liability and block later spend", t => {
  for (const corrupt of [false, true]) {
    const f = fixture(t); const run = f.run(), admitted = reserve(f.service, run.id, "unpriced-liability");
    if (corrupt) f.db.prepare("UPDATE platform_spending_calls SET price_json='{}'").run();
    const settled = settle(f.service, admitted, 100, corrupt ? model : "unknown-actual-model");
    assert.equal(settled.chargedTokens, 100);
    assert.equal(f.store.callEvidence("unpriced-liability")!.receipt!.chargedTokens, 100);
    const usage: any = f.policy.usage();
    assert.equal(usage.code, "PRICE_UNVERIFIED"); assert.equal(usage.monthly.totalUsd, null);
    assert.throws(f.run, code("PRICE_UNVERIFIED"));
  }
});

test("platform: stale/unknown prices refuse at run and reservation while old pinned settlement remains valid", t => {
  const f = fixture(t); const run = f.run();
  assert.throws(() => f.service.createRun({ kind: "cohort", baseTurnLimit: 7, eligibleSlots: ["slot"], models: ["unknown"] }), code("PRICE_UNVERIFIED"));
  assert.throws(() => reserve(f.service, run.id, "unknown-price", 1850, "unknown"), code("PRICE_UNVERIFIED"));
  const admitted = reserve(f.service, run.id, "pinned");
  markAccountingDispatchStarted(admitted.permit);
  f.clock.now = Date.parse("2026-11-05T12:00:00-08:00");
  const result = f.service.settleCall(admitted.permit, { usage: null, outcomeCode: "TIMEOUT", actualModel: model });
  assert.equal(result.chargedTokens, 1850);
  assert.equal((f.policy.usage() as any).monthly.chargedNanoUsd, "20350000");
  assert.throws(f.run, code("PRICE_UNVERIFIED"));
  let expired = false;
  const policy = new SQLitePlatformSpending(f.store, { env: {}, now: () => noon,
    price: (m, now) => { if (expired) throw new AdapterFailure("PRICE_UNVERIFIED", "fixture expired"); return verifiedPrice(m, now); } });
  const service = new L10AccountingService(f.store, { now: () => noon, spending: policy });
  const active = service.createRun({ kind: "cohort", baseTurnLimit: 7, eligibleSlots: ["slot"], models: [model] });
  expired = true;
  assert.throws(() => reserve(service, active.id, "expired-after-run"), code("PRICE_UNVERIFIED"));
});

test("platform: restart retains receipts, holds and admission counts in a private SQLite fixture", t => {
  const home = mkdtempSync(join(tmpdir(), "platform-restart-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "fixture.db");
  const first = new DatabaseSync(path), store = new L10AccountingStore(first);
  const policy = new SQLitePlatformSpending(store, { env: {}, now: () => noon });
  const service = new L10AccountingService(store, { now: () => noon, spending: policy });
  const run = service.createRun({ kind: "cohort", baseTurnLimit: 7, eligibleSlots: ["slot"], models: [model] });
  settle(service, reserve(service, run.id, "persist-charge"), 100);
  reserve(service, run.id, "persist-hold");
  first.close();
  const reopened = new DatabaseSync(path); t.after(() => reopened.close());
  const recovered = new SQLitePlatformSpending(new L10AccountingStore(reopened), { env: {}, now: () => noon });
  const usage: any = recovered.usage();
  assert.equal(usage.daily.acceptedRuns, 1); assert.equal(usage.daily.chargedTokens, 100);
  assert.equal(usage.daily.outstandingTokens, 1850); assert.equal(usage.monthly.chargedNanoUsd, "1100000");
});

test("platform: LA midnight/month and daylight saving boundaries keep every cross-period hold", t => {
  assert.deepEqual(pacificPeriods(Date.parse("2026-03-08T01:59:59-08:00")), { day: "2026-03-08", month: "2026-03" });
  assert.deepEqual(pacificPeriods(Date.parse("2026-03-08T03:00:00-07:00")), { day: "2026-03-08", month: "2026-03" });
  assert.deepEqual(pacificPeriods(Date.parse("2026-11-01T01:30:00-07:00")), pacificPeriods(Date.parse("2026-11-01T01:30:00-08:00")));
  const f = fixture(t); f.clock.now = Date.parse("2026-10-31T23:59:59-07:00");
  const run = f.run(), admitted = reserve(f.service, run.id, "month-hold");
  f.clock.now += 2000;
  const held: any = f.policy.usage();
  assert.equal(held.day, "2026-11-01"); assert.equal(held.month, "2026-11");
  assert.equal(held.daily.acceptedRuns, 0); assert.equal(held.daily.outstandingTokens, 1850);
  assert.equal(held.monthly.outstandingNanoUsd, "20350000");
  settle(f.service, admitted, 100);
  const charged: any = f.policy.usage();
  assert.equal(charged.daily.chargedTokens, 100); assert.equal(charged.monthly.chargedNanoUsd, "1100000");
  f.clock.now = Date.parse("2026-11-02T00:00:00-08:00");
  assert.equal((f.policy.usage() as any).daily.chargedTokens, 0);
});

test("platform: existing receipts backfill by receipt time; old unknown prices matter only this month or while outstanding", t => {
  const f = fixture(t);
  const legacy = new L10AccountingService(f.store, { now: () => f.clock.now, spending: fake });
  const run = legacy.createRun({ kind: "cohort", baseTurnLimit: 7, eligibleSlots: ["slot"] });
  settle(legacy, reserve(legacy, run.id, "old-known"), 100);
  const usage: any = f.policy.usage();
  assert.equal(usage.daily.chargedTokens, 100); assert.equal(usage.monthly.chargedNanoUsd, "1100000");
  assert.equal(JSON.parse(String(f.db.prepare("SELECT price_json FROM platform_spending_calls").get()!.price_json)).estimatedBackfill, true);
  const unknown = legacy.createRun({ kind: "cohort", baseTurnLimit: 7, eligibleSlots: ["slot"] });
  settle(legacy, reserve(legacy, unknown.id, "old-unknown", 1850, "unknown"), 100, "unknown");
  assert.equal((f.policy.usage() as any).unpricedCalls, 1);
  assert.throws(f.run, code("PRICE_UNVERIFIED"));
  f.clock.now = Date.parse("2026-11-01T12:00:00-08:00");
  assert.equal((f.policy.usage() as any).unpricedCalls, 0);
  const pending = legacy.createRun({ kind: "cohort", baseTurnLimit: 7, eligibleSlots: ["slot"] });
  reserve(legacy, pending.id, "unknown-held", 1850, "unknown");
  f.clock.now = Date.parse("2026-12-01T12:00:00-08:00");
  assert.equal((f.policy.usage() as any).unpricedCalls, 1);
});

test("platform: legacy paid entries block without heuristics; exact durable future linkage clears only its own entry", t => {
  const history: any[] = [{ time: new Date(noon).toISOString(), agent: "slot", execution: "unknown paid route", body: "transcript-secret" },
    { time: new Date(noon).toISOString(), stage: "contribution-report" },
    { time: new Date(noon).toISOString(), execution: "stub adapter (offline fixture)" },
    { time: "2026-09-01T12:00:00-07:00", execution: "old paid route" }];
  const f = fixture(t, {}, history);
  const blocked: any = f.policy.usage();
  assert.equal(blocked.code, "SPEND_HISTORY_UNVERIFIED"); assert.equal(blocked.history.unreconciledMonth, 1);
  assert.throws(f.run, code("SPEND_HISTORY_UNVERIFIED"));
  assert.equal(JSON.stringify(blocked).includes("transcript-secret"), false);
  const legacy = new L10AccountingService(f.store, { now: () => noon, spending: fake });
  const run = legacy.createRun({ kind: "cohort", baseTurnLimit: 7, eligibleSlots: ["slot"] });
  settle(legacy, reserve(legacy, run.id, "exact-call"), 100);
  history[0].accounting = { callId: "exact-call", runId: run.id };
  assert.equal((f.policy.usage() as any).history.unreconciledMonth, 0);
  assert.equal((f.policy.usage() as any).history.linked, 1);
  history[0].accounting.runId = "wrong-run";
  assert.equal((f.policy.usage() as any).history.unreconciledMonth, 1);
  history[0].accounting.runId = run.id; history[0].agent = "wrong-slot";
  assert.equal((f.policy.usage() as any).history.unreconciledMonth, 1);
});

for (const phase of ["admission", "reservation"] as const) test(`platform: racing SQLite ${phase}s cannot consume one allowance twice`, { timeout: 15000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), "platform-race-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "fixture.db"), seed = new DatabaseSync(path);
  const seedStore = new L10AccountingStore(seed);
  const seedPolicy = new SQLitePlatformSpending(seedStore, { env: {}, now: () => noon });
  const seedService = new L10AccountingService(seedStore, { now: () => noon, spending: seedPolicy });
  const runIds = phase === "reservation" ? [0, 1].map(() => seedService.createRun({ kind: "cohort", baseTurnLimit: 7,
    eligibleSlots: ["slot"], models: [model] }).id) : [];
  seed.close();
  const script = join(home, "race.mjs"), root = fileURLToPath(new URL("../../", import.meta.url));
  writeFileSync(script, `import {DatabaseSync} from "node:sqlite";
const {L10AccountingStore}=await import(${JSON.stringify(new URL("./l10-accounting-store.ts", import.meta.url).href)});
const {L10AccountingService}=await import(${JSON.stringify(new URL("./l10-accounting.ts", import.meta.url).href)});
const {SQLitePlatformSpending}=await import(${JSON.stringify(new URL("./platform-spending.ts", import.meta.url).href)});
const db=new DatabaseSync(${JSON.stringify(path)});const store=new L10AccountingStore(db);
const policy=new SQLitePlatformSpending(store,{env:${JSON.stringify(phase === "admission" ? { AGENT_COMMONS_MAX_DAILY_RUNS: "1" } : { AGENT_COMMONS_MAX_DAILY_TOKENS: "3000" })},now:()=>${noon}});
const service=new L10AccountingService(store,{spending:policy,now:()=>${noon}});
process.stdout.write("2");process.stdin.once("data",()=>{try{
${phase === "admission" ? `service.createRun({kind:"cohort",baseTurnLimit:7,eligibleSlots:["slot"],models:[${JSON.stringify(model)}]});` :
`service.reserveCall({runId:${JSON.stringify(runIds)}[Number(process.argv[2])],callId:"race-"+process.argv[2],slotId:"slot",runtimeModel:${JSON.stringify(model)},promptTokensUpper:50,completionLimit:1800,totalTokensUpper:1850});`}
process.stdout.write("1")}catch(e){if(e.code!==${JSON.stringify(phase === "admission" ? "SPEND_DAILY_RUNS" : "SPEND_DAILY_TOKENS")})process.exitCode=1;process.stdout.write("0")}finally{db.close();process.stdin.destroy()}});
`);
  const loader = createRequire(import.meta.url).resolve("tsx");
  const children = [0, 1].map(index => spawn(process.execPath, ["--import", loader, script, String(index)], { cwd: home,
    env: { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: home, TZ: "America/Los_Angeles", TSX_TSCONFIG_PATH: join(root, "tsconfig.json"),
      AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED: "0" }, stdio: ["pipe", "pipe", "pipe"] }));
  t.after(() => children.forEach(child => { if (child.exitCode === null) child.kill(); }));
  const ready = children.map(child => new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); }));
  const results = children.map(child => new Promise<number>((resolve, reject) => { let output = "";
    child.stdout.on("data", chunk => output += chunk); child.once("error", reject);
    child.once("close", status => { if (status !== 0) reject(new Error("fixture child failure")); else resolve(Number(output.slice(-1))); }); }));
  await Promise.all(ready); children.forEach(child => child.stdin.end("1"));
  assert.equal((await Promise.all(results)).reduce((sum, value) => sum + value, 0), 1);
  const checked = new DatabaseSync(path); t.after(() => checked.close());
  assert.equal(checked.prepare("SELECT COUNT(*) AS n FROM l10_runs").get()!.n, phase === "admission" ? 1 : 2);
  assert.equal(checked.prepare("SELECT COUNT(*) AS n FROM l10_reservations").get()!.n, phase === "admission" ? 0 : 1);
  assert.equal(checked.prepare("SELECT COUNT(*) AS n FROM platform_spending_calls").get()!.n, phase === "admission" ? 0 : 1);
});
