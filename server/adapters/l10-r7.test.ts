/**
 * L10 rework 3 — R7 poles: recordAdapter always records actualModel
 * (even when equal), usage validation, stale extras cleared on throw,
 * terminal USAGE_WALL/AUTH_BLOCKED latch in the run skip list.
 *
 */
import assert from "node:assert/strict";
import { AdapterFailure } from "./types";

async function main() {
  const { cohortConsole } = await import("../cohort");
  const c = cohortConsole as unknown as {
    recordAdapter: (agent: string, model: string, error?: unknown, historicalModel?: string, liveExtras?: unknown) => void;
    state: { adapterDiagnostics: Record<string, Record<string, unknown>>; statuses: Record<string, string> };
    _lastLiveExtras: Record<string, unknown>;
  };

  // CONTROL — actualModel recorded even when EQUAL to the runtime model
  // (an earlier equal-model probe demonstrated the absent field).
  const metrics = { exitCode: 0, stdoutBytes: 10, stdoutSha256: "a", stderrBytes: 0, stderrSha256: "b" };
  c.recordAdapter("continuity", "claude-fable-5-1", undefined, "claude_fable_5_1", {
    actualModel: "claude-fable-5-1", // equal to runtime
    modelEvidence: { source: "cli-envelope", fieldPath: "model" },
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, coversInternalCalls: true, source: "cli-envelope", fieldPath: "usage" },
    metrics,
  });
  const diag1 = c.state.adapterDiagnostics["continuity"];
  assert.equal(diag1.actualModel, "claude-fable-5-1", "R7 CONTROL: actualModel recorded even when equal");
  assert.equal(diag1.usageValid, true, "valid usage block validates");

  // MUTANT — usage missing the prompt/completion naming → usageValid=false.
  c.recordAdapter("continuity", "claude-fable-5-1", undefined, "claude_fable_5_1", {
    actualModel: "claude-fable-5-1",
    usage: { inputTokens: 100, outputTokens: 50 }, // legacy naming, no source/fieldPath
    metrics,
  });
  const diag2 = c.state.adapterDiagnostics["continuity"];
  assert.equal(diag2.usageValid, false, "R7 MUTANT: legacy-named usage is usageValid=false (never estimated)");

  // MUTANT — no usage block at all → usageValid=false.
  c.recordAdapter("continuity", "claude-fable-5-1", undefined, "claude_fable_5_1", {
    actualModel: "claude-fable-5-1", metrics,
  });
  assert.equal(c.state.adapterDiagnostics["continuity"].usageValid, false);

  // MUTANT — usage with negative or NaN tokens → usageValid=false
  c.recordAdapter("continuity", "claude-fable-5-1", undefined, "claude_fable_5_1", {
    actualModel: "claude-fable-5-1",
    modelEvidence: { source: "cli-envelope", fieldPath: "model" },
    usage: { promptTokens: -10, completionTokens: NaN, coversInternalCalls: false, source: "cli-envelope", fieldPath: "usage" },
    metrics,
  });
  const diagNaN = c.state.adapterDiagnostics["continuity"];
  assert.equal(diagNaN.usageValid, false, "R7 MUTANT: negative/NaN tokens is usageValid=false");

  // MUTANT — missing modelEvidence → usageValid=false
  c.recordAdapter("continuity", "claude-fable-5-1", undefined, "claude_fable_5_1", {
    actualModel: "claude-fable-5-1",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, coversInternalCalls: true, source: "cli-envelope", fieldPath: "usage" },
    metrics,
  });
  const diagNoEv = c.state.adapterDiagnostics["continuity"];
  assert.equal(diagNoEv.usageValid, false, "R7 MUTANT: missing modelEvidence is usageValid=false");

  // R7 (rework 6): totalTokens consistency mutants in recordAdapter (-1, NaN, Infinity, 1.5, 14 vs 10+5)
  for (const badTotal of [-1, NaN, Infinity, 1.5, 14]) {
    c.recordAdapter("continuity", "claude-fable-5-1", undefined, "claude_fable_5_1", {
      actualModel: "claude-fable-5-1",
      modelEvidence: { source: "cli-envelope", fieldPath: "model" },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: badTotal, coversInternalCalls: true, source: "cli-envelope", fieldPath: "usage" },
      metrics,
    });
    const diagBadTotal = c.state.adapterDiagnostics["continuity"];
    assert.equal(diagBadTotal.usageValid, false, `R7 MUTANT: totalTokens=${badTotal} is usageValid=false`);
  }

  // R7 rework 7: coversInternalCalls false in recordAdapter -> usageValid=false
  c.recordAdapter("continuity", "claude-fable-5-1", undefined, "claude_fable_5_1", {
    actualModel: "claude-fable-5-1",
    modelEvidence: { source: "cli-envelope", fieldPath: "model" },
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, coversInternalCalls: false, source: "cli-envelope", fieldPath: "usage" },
    metrics,
  });
  assert.equal(c.state.adapterDiagnostics["continuity"].usageValid, false, "R7 MUTANT: coversInternalCalls=false is usageValid=false");

  // CONTROL / MUTANT — callForSlot returns discriminated result and clears stale extras on actual throw
  const { foundingCohort } = await import("../../shared/cohort");
  const continuity = foundingCohort.find((m) => m.id === "continuity")!;

  // CONTROL — default/offline returns discriminated result { kind: "offline", text: ... }
  (cohortConsole as any).call = async () => "MOCK_RESULT";
  const defaultRes = await (cohortConsole as any).callForSlot(continuity, "test", 1, 1000);
  assert.equal(typeof defaultRes, "object", "callForSlot returns discriminated result object");
  assert.equal(defaultRes.kind, "offline", "default/offline call returns kind: 'offline'");
  assert.equal(defaultRes.text, "MOCK_RESULT", "text matches stubbed call");

  // MUTANT — exercise actual throw with unknown adapter: prior stale extras must be cleared
  (cohortConsole as any)._lastLiveExtras["continuity"] = { actualModel: "stale" };
  process.env.AGENT_COMMONS_ADAPTER = "invalid-offline-fixture-adapter";
  let threw = false;
  try {
    await (cohortConsole as any).callForSlot(continuity, "test", 1, 1000);
  } catch {
    threw = true;
  } finally {
    delete process.env.AGENT_COMMONS_ADAPTER;
  }
  assert.equal(threw, true, "unknown adapter throws");
  assert.equal((cohortConsole as any)._lastLiveExtras["continuity"], undefined, "stale extras cleared across actual throw");

  // MUTANT — terminal latch: USAGE_WALL and AUTH_BLOCKED in the skip list
  const src = (await import("node:fs")).readFileSync(new URL("../cohort.ts", import.meta.url).pathname, "utf8");
  assert.ok(src.includes('"USAGE_WALL","AUTH_BLOCKED"'), "R7 MUTANT: skip list latches USAGE_WALL + AUTH_BLOCKED");
  assert.ok(/USAGE_WALL.{0,200}terminal/.test(src) || /terminal.{0,200}USAGE_WALL/.test(src), "terminal semantics documented at the latch");

  // R7 (rework 6): callForSlot seam verification with totalTokens mutants
  const { StubAdapter } = await import("./stub");
  const origStubCall = StubAdapter.prototype.call;
  const validSeamResult = {
    kind: "live",
    text: "OFFLINE_FIXTURE",
    actualModel: "claude-fable-5-1",
    modelEvidence: { source: "cli-envelope", fieldPath: "model" },
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, coversInternalCalls: true, source: "cli-envelope", fieldPath: "usage" },
    metrics,
  };
  process.env.AGENT_COMMONS_ADAPTER = "stub";
  try {
    // CONTROL — 10 + 5 = 15 succeeds
    StubAdapter.prototype.call = async () => ({ ...validSeamResult }) as any;
    const seamOk = await (cohortConsole as any).callForSlot(continuity, "test", 1, 1000);
    assert.equal(seamOk.kind, "live");
    assert.equal(seamOk.usage.totalTokens, 15);

    // MUTANTS — -1, NaN, Infinity, 1.5, 14 vs 10+5 all refuse and clear extras
    for (const badTotal of [-1, NaN, Infinity, 1.5, 14]) {
      StubAdapter.prototype.call = async () => ({
        ...validSeamResult,
        usage: { ...validSeamResult.usage, totalTokens: badTotal },
      }) as any;
      await assert.rejects(async () => {
        await (cohortConsole as any).callForSlot(continuity, "test", 1, 1000);
      }, (err: any) => err.code === "USAGE_INVALID", `totalTokens ${badTotal} must refuse with USAGE_INVALID`);
      assert.equal((cohortConsole as any)._lastLiveExtras["continuity"], undefined, `extras must be cleared for bad total ${badTotal}`);
    }

    // R7 rework 7: coverage true/false pair in callForSlot
    // CONTROL: coversInternalCalls: true -> live usage retained, extras stored
    StubAdapter.prototype.call = async () => ({
      ...validSeamResult,
      usage: { ...validSeamResult.usage, coversInternalCalls: true },
    }) as any;
    const seamTrue = await (cohortConsole as any).callForSlot(continuity, "test", 1, 1000);
    assert.equal(seamTrue.kind, "live");
    assert.equal(seamTrue.usage.coversInternalCalls, true);
    assert.ok((cohortConsole as any)._lastLiveExtras["continuity"]);

    // MUTANT: coversInternalCalls: false -> USAGE_INVALID throw, no stored aggregate
    StubAdapter.prototype.call = async () => ({
      ...validSeamResult,
      usage: { ...validSeamResult.usage, coversInternalCalls: false },
    }) as any;
    await assert.rejects(async () => {
      await (cohortConsole as any).callForSlot(continuity, "test", 1, 1000);
    }, (err: any) => err.code === "USAGE_INVALID", "coversInternalCalls=false must refuse with USAGE_INVALID");
    assert.equal((cohortConsole as any)._lastLiveExtras["continuity"], undefined, "no aggregate stored when coverage is incomplete");
  } finally {
    StubAdapter.prototype.call = origStubCall;
    delete process.env.AGENT_COMMONS_ADAPTER;
  }

  console.log("PASS R7: actualModel always recorded (equal case), usage validation (safe integer counts, coverage evidence, complete internal-call coverage, total consistency in recordAdapter and callForSlot), stale extras cleared, USAGE_WALL/AUTH_BLOCKED terminal latch in skip list.");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
