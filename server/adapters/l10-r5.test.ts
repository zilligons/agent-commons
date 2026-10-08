/**
 * L10 rework 3 — R5 poles: shared witness/normalizer module.
 *
 * witnessFromOffset: CONTROL post-offset child-pid row OK; MUTANT
 *   pre-offset MISSING, wrong-pid MISSING, wrong-model/wrong-lane
 *   MISMATCH, malformed MISSING; correlated values surface.
 * normalizeCliEnvelope: CONTROL structured envelope → actualModel +
 *   usage with prompt/completion naming + internal-call coverage;
 *   MUTANT plain text → MODEL_EVIDENCE_MISSING; missing model field →
 *   MODEL_EVIDENCE_MISSING.
 *
 */
import assert from "node:assert/strict";
import fs, { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { witnessFromOffset, normalizeCliEnvelope } from "./l10-witness";
import { assertValidModelLiteral, CLAUDE_ALLOWED_MODELS, buildL10Argv } from "./l10-routes";
import { buildChildEnv, EnvRefusedError } from "./l10-env";
import { AdapterFailure } from "./types";
import { _setL10BinariesForTest, _resetL10BinariesForTest, resolveL10Binaries } from "./config";
import {
  spawnClaudeL10Child,
  spawnClaudeL10ChildForTest,
  spawnCodexL10Child,
  spawnCodexL10ChildForTest,
  assertClaudeModelGate,
  assertCodexModelGate,
  assertConfigGate,
  L10PermitPool,
  isSharedClaudePermitDir,
} from "./l10-process";
import { PreviewBridgeAdapter } from "./preview_bridge";
import { callForSlot } from "../cohort";

function assertNoSurvivingProcessesForDir(targetDir: string): void {
  const resolvedDir = resolve(targetDir);
  const realDir = existsSync(targetDir) ? realpathSync(targetDir) : resolvedDir;
  const out = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  const survivors: { pid: number; cmd: string }[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx === -1) continue;
    const pidStr = trimmed.slice(0, spaceIdx);
    const cmd = trimmed.slice(spaceIdx + 1).trim();
    const pid = parseInt(pidStr, 10);
    if (pid === process.pid) continue;
    if (cmd.includes(resolvedDir) || cmd.includes(realDir)) {
      survivors.push({ pid, cmd });
    }
  }
  if (survivors.length > 0) {
    throw new Error(`Survivor processes found under ${targetDir}: ${JSON.stringify(survivors)}`);
  }
}

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), "l10-r5-"));
  // Install the resolver snapshot BEFORE any witness call (the witness
  // reads the configured seats from the snapshot).
  _setL10BinariesForTest(resolveL10Binaries({
    AGENT_COMMONS_CLAUDE_BIN: "/tmp/l10-r5-fake-claude",
    AGENT_COMMONS_CODEX_BIN: "/tmp/l10-r5-fake-codex",
    AGENT_COMMONS_GROK_BIN: "/tmp/l10-r5-fake-grok",
    AGENT_COMMONS_MODEL_LEDGER: "",
    AGENT_COMMONS_WITNESS_SEATS: "seat-alpha,seat-beta",
  } as NodeJS.ProcessEnv));
  try {
    const ledger = join(scratch, "model-ledger.jsonl");
    writeFileSync(ledger, "", "utf8");
    const childPid = 31337;
    const lit = "claude-fable-5-1";
    const row = (over: Record<string, unknown>) =>
      JSON.stringify({ ts: "t", pid: childPid, lane: "max", seat: "seat-alpha", req: lit, eff: lit, ...over }) + "\n";

    // CONTROL — post-offset child-pid row with lane/seat/model OK, and
    // the correlated values surface for the report row.
    appendFileSync(ledger, row({}), "utf8");
    const w1 = witnessFromOffset(ledger, 0, childPid, lit);
    assert.equal(w1.verdict, "OK");
    assert.equal(w1.correlated?.pid, childPid);
    assert.equal(w1.correlated?.seat, "seat-alpha");
    assert.equal(w1.correlated?.req, lit);

    // MUTANT — pre-offset row never counts.
    const off = Buffer.byteLength(readFileSync(ledger, "utf8"), "utf8");
    assert.equal(witnessFromOffset(ledger, off, childPid, lit).verdict, "ROUTE_WITNESS_MISSING",
      "pre-offset rows are never searched");

    // MUTANT — wrong pid after offset.
    appendFileSync(ledger, row({ pid: 999 }), "utf8");
    const off2 = Buffer.byteLength(readFileSync(ledger, "utf8"), "utf8");
    appendFileSync(ledger, row({ pid: 998 }), "utf8");
    assert.equal(witnessFromOffset(ledger, off2, childPid, lit).verdict, "ROUTE_WITNESS_MISSING");

    // MUTANT — right pid, wrong model → MISMATCH.
    const off3 = Buffer.byteLength(readFileSync(ledger, "utf8"), "utf8");
    appendFileSync(ledger, row({ req: "WRONG-LITERAL-XYZ", eff: "WRONG-LITERAL-XYZ" }), "utf8");
    assert.equal(witnessFromOffset(ledger, off3, childPid, lit).verdict, "ROUTE_WITNESS_MISMATCH",
      "the mutant fixture's own wrong-literal row lands MISMATCH, never OK");

    // MUTANT — malformed JSONL in the window → ROUTE_WITNESS_MISSING
    // (brief rev 4 R2: the witness fails closed on a configured but
    // malformed ledger, matching f7ebb86 behavior).
    const off4 = Buffer.byteLength(readFileSync(ledger, "utf8"), "utf8");
    appendFileSync(ledger, "not json{{{\n", "utf8");
    assert.equal(witnessFromOffset(ledger, off4, childPid, lit).verdict, "ROUTE_WITNESS_MISSING");

    // MUTANT M7: a malformed ledger line BEFORE a valid matching row
    // must still return ROUTE_WITNESS_MISSING. A mutant that 'continue's
    // past the malformed line (instead of returning) would find the
    // valid row and return OK — that is the survival case. The witness
    // fails closed on ANY malformed line in the window, even if a
    // matching row is found later. Brief rev 4 R2 + rev 5: the
    // f7ebb86 behaviour.
    const offMalformedFirst = Buffer.byteLength(readFileSync(ledger, "utf8"), "utf8");
    appendFileSync(ledger, "not json before match\n", "utf8"); // malformed first
    appendFileSync(ledger, row({}), "utf8"); // valid matching row after
    assert.equal(witnessFromOffset(ledger, offMalformedFirst, childPid, lit).verdict, "ROUTE_WITNESS_MISSING",
      "M7: a malformed line in the window — even before a matching row — must fail closed");

    // Brief rev 4 R2: a configured ledger that is missing, unreadable
    // or empty (and a row with a seat NOT in the configured seats) all
    // return ROUTE_WITNESS_MISSING. f7ebb86 returned the same verdict;
    // a regression that returns NOT_EVALUATED on these inputs must go
    // red here.
    assert.equal(witnessFromOffset("/tmp/does-not-exist", 0, childPid, lit).verdict, "ROUTE_WITNESS_MISSING",
      "missing ledger -> ROUTE_WITNESS_MISSING (R2 fail closed)");
    const emptyLedger = join(scratch, "empty-ledger.jsonl");
    writeFileSync(emptyLedger, "");
    assert.equal(witnessFromOffset(emptyLedger, 0, childPid, lit).verdict, "ROUTE_WITNESS_MISSING",
      "empty ledger -> ROUTE_WITNESS_MISSING (R2 fail closed)");

    // Brief rev 4 R3: the witness reads the configured seats from the
    // resolver snapshot. A row with a seat NOT in the configured list
    // is MISMATCH (the row exists, lane/req/eff match, but the seat
    // does not). The default hard-coded list is gone.
    const okSeatLedger = join(scratch, "ok-seat-ledger.jsonl");
    writeFileSync(okSeatLedger, "");
    appendFileSync(okSeatLedger, JSON.stringify({ ts: "fixture", pid: 12345, lane: "max", seat: "seat-alpha", req: lit, eff: lit }) + "\n", "utf8");
    const wOkSeat = witnessFromOffset(okSeatLedger, 0, 12345, lit, { allowFixtureTs: true });
    assert.equal(wOkSeat.verdict, "OK", "R3: a row with a configured seat is OK");
    assert.equal(wOkSeat.correlated?.seat, "seat-alpha");
    const wrongSeatLedger = join(scratch, "wrong-seat-ledger.jsonl");
    writeFileSync(wrongSeatLedger, "");
    // Brief rev 4 R3: the configured seats are synthetic ("seat-alpha",
    // "seat-beta"). A row with a name NOT in the configured list is
    // MISMATCH (proves the witness reads the configured seats, not a
    // hard-coded owner name).
    appendFileSync(wrongSeatLedger, JSON.stringify({ ts: "fixture", pid: 12345, lane: "max", seat: "non-configured", req: lit, eff: lit }) + "\n", "utf8");
    const wWrongSeat = witnessFromOffset(wrongSeatLedger, 0, 12345, lit, { allowFixtureTs: true });
    assert.equal(wWrongSeat.verdict, "ROUTE_WITNESS_MISMATCH",
      "R3: a row with a non-configured seat name is MISMATCH when the configured seats are synthetic");
    assert.equal(wrongSeatLedger.length > 0, true);

    // Normalizer CONTROL — structured envelope yields actualModel + usage
    // with the v3 naming and internal-call coverage.
    const env = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "READY",
      session_id: "s",
      usage: { input_tokens: 100, output_tokens: 50 },
      modelUsage: {
        "claude-fable-5-1": { inputTokens: 100, outputTokens: 50 },
      },
    });
    const n1 = normalizeCliEnvelope(env, { route: "claude" });
    assert.ok(n1.ok);
    assert.equal(n1.actualModel, "claude-fable-5-1");
    assert.equal(n1.modelEvidence.fieldPath, "modelUsage");
    assert.equal(n1.usage?.promptTokens, 100);
    assert.equal(n1.usage?.completionTokens, 50);
    assert.equal(n1.usage?.totalTokens, 150);
    assert.equal(n1.usage?.coversInternalCalls, true);
    assert.equal(n1.usage?.source, "cli-envelope");

    // Normalizer MUTANT — plain stdout text is NOT an envelope.
    const n2 = normalizeCliEnvelope("claude-fable-5-1\n", { route: "claude" });
    assert.ok(!n2.ok && n2.code === "MODEL_EVIDENCE_MISSING",
      "plain stdout text never yields an actualModel (the slice derived it from text)");

    // Launch window CONTROL — timestamp within window returns OK
    const now = Date.now();
    const off5 = Buffer.byteLength(readFileSync(ledger, "utf8"), "utf8");
    appendFileSync(ledger, JSON.stringify({ ts: now, pid: 44444, lane: "max", seat: "seat-alpha", req: lit, eff: lit }) + "\n", "utf8");
    const wWindow = witnessFromOffset(ledger, off5, 44444, lit, { launchTimeMs: now, maxAgeMs: 5000 });
    assert.equal(wWindow.verdict, "OK", "timestamp within launch window matches");

    // Launch window MUTANT — timestamp outside window rejected
    appendFileSync(ledger, JSON.stringify({ ts: now - 100000, pid: 55555, lane: "max", seat: "seat-alpha", req: lit, eff: lit }) + "\n", "utf8");
    const wStale = witnessFromOffset(ledger, off5, 55555, lit, { launchTimeMs: now, maxAgeMs: 5000 });
    assert.equal(wStale.verdict, "ROUTE_WITNESS_MISMATCH", "timestamp outside launch window rejected");

    // Fixture timestamp exception separation (R5 rework 6):
    appendFileSync(ledger, JSON.stringify({ ts: "fixture", pid: 66666, lane: "max", seat: "seat-alpha", req: lit, eff: lit }) + "\n", "utf8");
    const wFixtureDefault = witnessFromOffset(ledger, off5, 66666, lit, { launchTimeMs: now, maxAgeMs: 5000 });
    assert.equal(wFixtureDefault.verdict, "ROUTE_WITNESS_MISMATCH", "fixture ts without explicit allowFixtureTs is rejected");
    const wFixtureAllowed = witnessFromOffset(ledger, off5, 66666, lit, { launchTimeMs: now, maxAgeMs: 5000, allowFixtureTs: true });
    assert.equal(wFixtureAllowed.verdict, "OK", "fixture ts with allowFixtureTs: true is accepted");

    // Adapter gate CONTROL — frozen literal for slot succeeds
    assert.equal(assertValidModelLiteral("claude-fable-5-1", "continuity"), "claude-fable-5-1");

    // Adapter gate MUTANTS — missing/empty/config-sourced/invalid rejected
    assert.throws(() => assertValidModelLiteral(undefined), /missing model literal/);
    assert.throws(() => assertValidModelLiteral(""), /empty model literal/);
    assert.throws(() => assertValidModelLiteral("config:claude-3"), /config-sourced model refused/);
    assert.throws(() => assertValidModelLiteral("wrong-model", "continuity"), /invalid model literal/);

    // Pre-spawn gate in production path (R5 rework 6 / R17 P1 / C1 Part 1 / Rework 18 C):
    const binDir = join(scratch, "bin");
    mkdirSync(binDir, { recursive: true, mode: 0o700 });
    const claudeBin = join(binDir, "claude");
    const claudeGoFile = join(scratch, "claude.go");
    writeFileSync(
      claudeBin,
      `#!/usr/bin/env python3
import os, sys, time
go_file = ${JSON.stringify(claudeGoFile)}
deadline = time.time() + 15
while time.time() < deadline:
    if os.path.exists(go_file):
        sys.exit(0)
    time.sleep(0.01)
sys.exit(1)
`,
      { mode: 0o700 },
    );
    const notClaudeBin = join(binDir, "notclaude");
    writeFileSync(notClaudeBin, "#!/bin/sh\nsleep 0.02\nexit 0\n", { mode: 0o700 });
    const codexBin = join(binDir, "codex");
    writeFileSync(codexBin, "#!/bin/sh\nsleep 0.02\nexit 0\n", { mode: 0o700 });

    // Brief rev 2: install a snapshot of the L10 resolver pointing at the
    // synthetic fixture binaries. The same resolver drives buildL10Argv
    // and the spawn gates, so a single setSnapshot keeps them in sync.
    _setL10BinariesForTest(resolveL10Binaries({
      AGENT_COMMONS_CLAUDE_BIN: claudeBin,
      AGENT_COMMONS_CODEX_BIN: codexBin,
      AGENT_COMMONS_GROK_BIN: codexBin,
      AGENT_COMMONS_MODEL_LEDGER: "",
      AGENT_COMMONS_WITNESS_SEATS: "seat-alpha,seat-beta",
    } as NodeJS.ProcessEnv));

    const fullClaudeContract = buildL10Argv({ slotId: "collaboration" });
    const shortClaudeArgs = ["--print", "--model", "claude-opus-5-5", "--output-format", "json"];
    const childEnv = buildChildEnv({ route: "claude", runId: "test-r5-spawn", home: scratch, pole: "CONTROL", runDir: scratch });

    // C1 Gate Poles: assertClaudeModelGate unit verification
    // 1. Full contract with the configured synthetic claude bin admitted on production
    assert.equal(assertClaudeModelGate(fullClaudeContract, false), "claude-opus-5-5");
    // 2. Full contract with fixture bin admitted on test entry
    assert.equal(assertClaudeModelGate([claudeBin, ...fullClaudeContract.slice(1)], true), "claude-opus-5-5");
    // 3. Foreign binary (notClaudeBin) refused on production entry — not the configured value
    assert.throws(() => assertClaudeModelGate([notClaudeBin, ...fullClaudeContract.slice(1)], false), (err: any) => err.code === "MODEL_UNAVAILABLE" && err.message.includes("invalid claude binary"));
    // 4. A different claude-shaped bin refused on production entry
    assert.throws(() => assertClaudeModelGate([codexBin, ...fullClaudeContract.slice(1)], false), (err: any) => err.code === "MODEL_UNAVAILABLE");
    // 5. Short contract refused on production entry
    assert.throws(() => assertClaudeModelGate([fullClaudeContract[0], ...shortClaudeArgs], false), (err: any) => err.code === "MODEL_UNAVAILABLE");
    // 6. Short contract refused on test entry
    assert.throws(() => assertClaudeModelGate([claudeBin, ...shortClaudeArgs], true), (err: any) => err.code === "MODEL_UNAVAILABLE");
    // 7. --model=gpt-6.1-sol FIRST refused
    assert.throws(() => assertClaudeModelGate([fullClaudeContract[0], "--model=gpt-6.1-sol", ...fullClaudeContract.slice(1)], false), (err: any) => err.code === "MODEL_UNAVAILABLE");
    // 8. Contract with appended flag refused
    assert.throws(() => assertClaudeModelGate([...fullClaudeContract, "--extra"], false), (err: any) => err.code === "MODEL_UNAVAILABLE");
    // 9. Non-Claude model refused
    assert.throws(() => assertClaudeModelGate([fullClaudeContract[0], "--print", "--model", "gpt-6.1-sol", ...fullClaudeContract.slice(4)], false), (err: any) => err.code === "MODEL_UNAVAILABLE");

    // Production spawnClaudeL10Child:
    // Production entry refuses any bin that is NOT the configured value
    // (brief rev 2: AGENT_COMMONS_CLAUDE_BIN is the configured source).
    await assert.rejects(async () => {
      await spawnClaudeL10Child({
        argv: [notClaudeBin, ...fullClaudeContract.slice(1)],
        cwd: scratch, childEnv, promptText: "test",
        timeoutMs: 5000, cancelSignal: { cancelled: () => false },
        runId: "c1-prod-foreign-test",
      });
    }, (err: any) => err.code === "MODEL_UNAVAILABLE" && err.message.includes("invalid claude binary"));

    // Production entry refuses short contract
    await assert.rejects(async () => {
      await spawnClaudeL10Child({
        argv: [fullClaudeContract[0], ...shortClaudeArgs],
        cwd: scratch, childEnv, promptText: "test",
        timeoutMs: 5000, cancelSignal: { cancelled: () => false },
        runId: "c1-prod-short-test",
      });
    }, (err: any) => err.code === "MODEL_UNAVAILABLE");

    // Test entry spawnClaudeL10ChildForTest: requires explicit private permitPool
    const privatePool = new L10PermitPool(join(scratch, "permits"), 2);
    await assert.rejects(async () => {
      await spawnClaudeL10ChildForTest({
        argv: [claudeBin, ...fullClaudeContract.slice(1)],
        cwd: scratch, childEnv, promptText: "test",
        timeoutMs: 5000, cancelSignal: { cancelled: () => false },
        runId: "c1-test-unspecified-pool",
      });
    }, (err: any) => err instanceof AdapterFailure && err.code === "SECURITY_VIOLATION" && err.message.includes("spawnClaudeL10ChildForTest requires an explicit private permitPool"));

    let pollerObserved = false;
    let testRes: any;
    try {
      testRes = await spawnClaudeL10ChildForTest({
        argv: [claudeBin, ...fullClaudeContract.slice(1)],
        cwd: scratch,
        childEnv,
        promptText: "test",
        timeoutMs: 5000,
        cancelSignal: { cancelled: () => false },
        runId: "c1-test-admitted",
        permitPool: privatePool,
        onSnapshot: (phase) => {
          if (phase === "poller") {
            pollerObserved = true;
            try { writeFileSync(claudeGoFile, "1"); } catch {}
          }
        },
      });
    } finally {
      try { writeFileSync(claudeGoFile, "1"); } catch {}
    }
    assert.ok(testRes.childPid > 0, "Test entry: claudeBin with full contract admitted");
    assert.equal(pollerObserved, true, "Poller snapshot must have observed child before release");

    // Test entry refuses short contract
    await assert.rejects(async () => {
      await spawnClaudeL10ChildForTest({
        argv: [claudeBin, ...shortClaudeArgs],
        cwd: scratch, childEnv, promptText: "test",
        timeoutMs: 5000, cancelSignal: { cancelled: () => false },
        runId: "c1-test-short-refused",
        permitPool: privatePool,
      });
    }, (err: any) => err.code === "MODEL_UNAVAILABLE");

    // Rework 20 Item E Pole: Permit pool guard realpath comparison & no acquire on shared
    const sharedPermitPaths = [
      "/private/tmp/l10/permits",
      "/tmp/l10/permits/",
      "/tmp/l10/../l10/permits",
    ];

    for (const sharedPath of sharedPermitPaths) {
      let acquireCalled = false;
      const fakeSharedPool = {
        poolDir: sharedPath,
        acquire: async () => {
          acquireCalled = true;
          throw new Error("acquire must never be called on shared permit pool");
        },
      } as unknown as L10PermitPool;

      // Pure helper identifies path as shared production pool
      assert.equal(isSharedClaudePermitDir(sharedPath), true, `isSharedClaudePermitDir must identify ${sharedPath}`);

      // spawnClaudeL10ChildForTest refuses before acquire
      await assert.rejects(async () => {
        await spawnClaudeL10ChildForTest({
          argv: [claudeBin, ...fullClaudeContract.slice(1)],
          cwd: scratch,
          childEnv,
          promptText: "test",
          timeoutMs: 5000,
          cancelSignal: { cancelled: () => false },
          runId: "e-test-refused",
          permitPool: fakeSharedPool,
        });
      }, (err: any) => err instanceof AdapterFailure && err.code === "SECURITY_VIOLATION" && err.message.includes("spawnClaudeL10ChildForTest requires an explicit private permitPool"));
      assert.equal(acquireCalled, false, `acquire was called on ${sharedPath}!`);
    }

    // Private dir is admitted (isSharedClaudePermitDir is false, and acquire is reached)
    const privatePoolDir = join(scratch, "private-permits");
    assert.equal(isSharedClaudePermitDir(privatePoolDir), false);
    let privateAcquireCalled = false;
    const recordedPrivatePool = {
      poolDir: privatePoolDir,
      acquire: async () => {
        privateAcquireCalled = true;
        throw new Error("PRIVATE_ACQUIRE_REACHED");
      },
    } as unknown as L10PermitPool;
    await assert.rejects(async () => {
      await spawnClaudeL10ChildForTest({
        argv: [claudeBin, ...fullClaudeContract.slice(1)],
        cwd: scratch,
        childEnv,
        promptText: "test",
        timeoutMs: 5000,
        cancelSignal: { cancelled: () => false },
        runId: "e-test-admitted",
        permitPool: recordedPrivatePool,
      });
    }, /PRIVATE_ACQUIRE_REACHED/);
    assert.equal(privateAcquireCalled, true, "Private pool was admitted and reached acquire");

    // MUTANT check: string equality (pre-fix) failed on /private/tmp/l10/permits
    const mutantOldCheck = (dir: string) => dir === "/tmp/l10/permits";
    assert.equal(mutantOldCheck("/private/tmp/l10/permits"), false, "MUTANT: old string equality failed to match /private/tmp/l10/permits");

    // Rework 20 Item F Pole: Error type is AdapterFailure with code SECURITY_VIOLATION
    let itemFErr: any = null;
    try {
      await spawnClaudeL10ChildForTest({
        argv: [claudeBin, ...fullClaudeContract.slice(1)],
        cwd: scratch,
        childEnv,
        promptText: "test",
        timeoutMs: 5000,
        cancelSignal: { cancelled: () => false },
        runId: "f-test-error-type",
      });
    } catch (e: any) {
      itemFErr = e;
    }
    // CONTROL: instance of AdapterFailure, code is SECURITY_VIOLATION
    assert.ok(itemFErr instanceof AdapterFailure, "CONTROL: error must be AdapterFailure");
    assert.equal(itemFErr.code, "SECURITY_VIOLATION", "CONTROL: error code must be SECURITY_VIOLATION");
    assert.equal(itemFErr.retryable, false, "CONTROL: retryable must be false");

    // MUTANT: pre-fix threw bare Error without .code === 'SECURITY_VIOLATION'
    const mutantBareError = new Error("spawnClaudeL10ChildForTest requires an explicit private permitPool; using the shared pool in tests is prohibited");
    assert.ok(!(mutantBareError instanceof AdapterFailure), "MUTANT: bare Error is not AdapterFailure");
    assert.equal((mutantBareError as any).code, undefined, "MUTANT: bare Error has no code");

    // Codex Gate Poles: assertCodexModelGate unit verification
    const fullCodexContract = buildL10Argv({ slotId: "governance" });
    const codexHome = join(scratch, "codex-home");
    mkdirSync(join(codexHome, ".codex"), { recursive: true, mode: 0o700 });
    writeFileSync(join(codexHome, ".codex", "config.toml"), "# test fixture\n");
    const codexChildEnv = buildChildEnv({ route: "codex", runId: "test-r5-codex", home: codexHome, pole: "CONTROL", runDir: scratch });

    // 1. Full contract with the configured synthetic codex bin admitted on production
    assert.equal(assertCodexModelGate(fullCodexContract, false), "gpt-6.1-sol");
    // 2. Full contract with fixture bin admitted on test entry
    assert.equal(assertCodexModelGate([codexBin, ...fullCodexContract.slice(1)], true), "gpt-6.1-sol");
    // 3. Foreign binary (notClaudeBin) refused on production entry — not the configured value
    assert.throws(() => assertCodexModelGate([notClaudeBin, ...fullCodexContract.slice(1)], false), (err: any) => err.code === "MODEL_UNAVAILABLE" && err.message.includes("invalid codex binary"));
    // 4. Appended flags refused
    assert.throws(() => assertCodexModelGate([...fullCodexContract, "--extra"], false), (err: any) => err.code === "MODEL_UNAVAILABLE");
    // 5. Short / incomplete codex contract refused
    assert.throws(() => assertCodexModelGate([fullCodexContract[0], "exec", "--model", "gpt-6.1-sol"], false), (err: any) => err.code === "MODEL_UNAVAILABLE");
    // 6. Wrong model on codex contract refused
    assert.throws(() => assertCodexModelGate([fullCodexContract[0], "exec", "--model", "claude-opus-5-5", ...fullCodexContract.slice(4)], false), (err: any) => err.code === "MODEL_UNAVAILABLE");

    // Production spawnCodexL10Child refuses any bin that is NOT the configured value
    await assert.rejects(async () => {
      await spawnCodexL10Child({
        argv: [notClaudeBin, ...fullCodexContract.slice(1)],
        cwd: scratch, childEnv: codexChildEnv, promptText: "test",
        timeoutMs: 5000, cancelSignal: { cancelled: () => false },
      });
    }, (err: any) => err.code === "MODEL_UNAVAILABLE" && err.message.includes("invalid codex binary"));

    // Test entry spawnCodexL10ChildForTest admits fixture binary
    const codexTestRes = await spawnCodexL10ChildForTest({
      argv: [codexBin, ...fullCodexContract.slice(1)],
      cwd: scratch, childEnv: codexChildEnv, promptText: "test",
      timeoutMs: 5000, cancelSignal: { cancelled: () => false },
    });
    assert.ok(codexTestRes.childPid > 0, "Test entry: codexBin with full contract admitted");

    // Form 4: runtime .add on exported CLAUDE_ALLOWED_MODELS throws TypeError
    assert.throws(() => {
      (CLAUDE_ALLOWED_MODELS as any).add("gpt-6.1-sol");
    }, TypeError);

    // R5 rework 7: EnvRefusedError code is stable ENV_REFUSED
    const envErr = new EnvRefusedError(["ANTHROPIC_BASE_URL"], "parent");
    assert.equal(envErr.code, "ENV_REFUSED");

    // R5 rework 7: assertConfigGate effective sources and provider redirects
    const testClaudeDir = join(scratch, "claude-cfg-gate");
    mkdirSync(testClaudeDir, { recursive: true });
    writeFileSync(join(testClaudeDir, "settings.json"), JSON.stringify({ env: {} }));
    writeFileSync(join(testClaudeDir, "settings.local.json"), JSON.stringify({ env: {} }));
    assertConfigGate({ CLAUDE_CONFIG_DIR: testClaudeDir });

    // Local settings carrying refused name
    writeFileSync(join(testClaudeDir, "settings.local.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "synth" } }));
    assert.throws(() => assertConfigGate({ CLAUDE_CONFIG_DIR: testClaudeDir }), (err: any) => err.code === "CONFIG_UNVERIFIED");

    // Settings carrying apiKeyHelper
    writeFileSync(join(testClaudeDir, "settings.local.json"), JSON.stringify({ env: {} }));
    writeFileSync(join(testClaudeDir, "settings.json"), JSON.stringify({ apiKeyHelper: "helper-cmd" }));
    assert.throws(() => assertConfigGate({ CLAUDE_CONFIG_DIR: testClaudeDir }), (err: any) => err.code === "CONFIG_UNVERIFIED");

    // TOML in Claude dir
    writeFileSync(join(testClaudeDir, "settings.json"), JSON.stringify({ env: {} }));
    writeFileSync(join(testClaudeDir, "config.toml"), "foo = 'bar'");
    assert.throws(() => assertConfigGate({ CLAUDE_CONFIG_DIR: testClaudeDir }), (err: any) => err.code === "CONFIG_UNVERIFIED");
    rmSync(join(testClaudeDir, "config.toml"));

    // Codex config.toml carrying model_provider
    const testCodexDir = join(scratch, "codex-cfg-gate");
    mkdirSync(testCodexDir, { recursive: true });
    writeFileSync(join(testCodexDir, "config.toml"), 'model_provider = "synth-redirect"\n');
    assert.throws(() => assertConfigGate({ CODEX_HOME: testCodexDir }), (err: any) => err.code === "CONFIG_UNVERIFIED");

    // Clean Codex config.toml
    writeFileSync(join(testCodexDir, "config.toml"), 'some_key = "clean"\n');
    assertConfigGate({ CODEX_HOME: testCodexDir });

    // R5 rework 8: effective-config admission across all sources
    // 1. PROJECT-LOCAL (.claude/settings.local.json in cwd)
    const projectDir = join(scratch, "proj-test");
    const projClaudeDir = join(projectDir, ".claude");
    mkdirSync(projClaudeDir, { recursive: true });
    writeFileSync(join(projClaudeDir, "settings.local.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "synthetic-unused-url" } }));
    assert.throws(() => assertConfigGate({ CLAUDE_CONFIG_DIR: testClaudeDir }, projectDir), (err: any) => err.code === "CONFIG_UNVERIFIED");
    writeFileSync(join(projClaudeDir, "settings.local.json"), JSON.stringify({ env: {} }));
    assertConfigGate({ CLAUDE_CONFIG_DIR: testClaudeDir }, projectDir);

    // 2. ABSENT-CONFIG (empty config dir)
    const emptyCfgDir = join(scratch, "empty-cfg");
    mkdirSync(emptyCfgDir, { recursive: true });
    assert.throws(() => assertConfigGate({ CLAUDE_CONFIG_DIR: emptyCfgDir }), (err: any) => err.code === "CONFIG_UNVERIFIED");

    // 3. CODEX-QUOTED-KEY ("model_provider" = "...")
    writeFileSync(join(testCodexDir, "config.toml"), 'model = "gpt-6.1-sol"\n"model_provider" = "synthetic-redirect"\n');
    assert.throws(() => assertConfigGate({ CODEX_HOME: testCodexDir }), (err: any) => err.code === "CONFIG_UNVERIFIED");

    // 4. CODEX-ENV-KEY (env_key = "...")
    writeFileSync(join(testCodexDir, "config.toml"), 'model = "gpt-6.1-sol"\nenv_key = "SYNTHETIC_UNUSED_AUTH"\n');
    assert.throws(() => assertConfigGate({ CODEX_HOME: testCodexDir }), (err: any) => err.code === "CONFIG_UNVERIFIED");

    // 5. CODEX-PARSE-FAILURE (malformed TOML)
    writeFileSync(join(testCodexDir, "config.toml"), 'model = "gpt-6.1-sol\n');
    assert.throws(() => assertConfigGate({ CODEX_HOME: testCodexDir }), (err: any) => err.code === "CONFIG_UNVERIFIED");

    // R5 rework 7: missing model at routed entry
    const pb = new PreviewBridgeAdapter();
    await assert.rejects(async () => {
      await pb.call({
        slotId: "continuity",
        historicalModel: "claude-fable-5-1",
        runtimeModel: "",
        prompt: "test",
        timeoutMs: 1000,
        runId: "r5-missing-model",
        generation: 1,
        reservationId: null,
      });
    }, (err: any) => err.code === "MODEL_UNAVAILABLE");

    // -------------------------------------------------------------------------
    // R5 rework 9: config-discovery poles (the earlier review shape)
    // -------------------------------------------------------------------------
    const r9Dir = join(scratch, "r9-discovery");
    mkdirSync(r9Dir, { recursive: true });

    // 1. CODEX-ABSENT (empty CODEX_HOME -> refused before spawn)
    {
      const emptyCodexDir = join(r9Dir, "empty-codex");
      mkdirSync(emptyCodexDir, { recursive: true });
      assert.throws(
        () => assertConfigGate({ CODEX_HOME: emptyCodexDir }),
        (err: any) => err.code === "CONFIG_UNVERIFIED",
        "R5 rework 9: empty CODEX_HOME must be refused before spawn"
      );

      // Control: clean CODEX_HOME with config.toml -> admitted
      const cleanCodexDir = join(r9Dir, "clean-codex");
      mkdirSync(cleanCodexDir, { recursive: true });
      writeFileSync(join(cleanCodexDir, "config.toml"), 'model = "gpt-6.1-sol"\n');
      assert.doesNotThrow(
        () => assertConfigGate({ CODEX_HOME: cleanCodexDir }),
        "R5 rework 9 CONTROL: valid CODEX_HOME admitted"
      );
    }

    // 2. CLAUDE-UNKNOWN-SOURCE (.yaml in CLAUDE_CONFIG_DIR)
    {
      const yamlClaudeDir = join(r9Dir, "yaml-claude");
      mkdirSync(yamlClaudeDir, { recursive: true });
      writeFileSync(join(yamlClaudeDir, "settings.json"), JSON.stringify({ env: {} }));
      writeFileSync(join(yamlClaudeDir, "extra-config.yaml"), "env:\n  ANTHROPIC_BASE_URL: synthetic-unused-url\n");
      assert.throws(
        () => assertConfigGate({ CLAUDE_CONFIG_DIR: yamlClaudeDir }),
        (err: any) => err.code === "CONFIG_UNVERIFIED",
        "R5 rework 9: unknown .yaml source in CLAUDE_CONFIG_DIR must be refused"
      );

      // Control: clean CLAUDE_CONFIG_DIR -> admitted
      const cleanClaudeDir = join(r9Dir, "clean-claude");
      mkdirSync(cleanClaudeDir, { recursive: true });
      writeFileSync(join(cleanClaudeDir, "settings.json"), JSON.stringify({ env: {} }));
      assert.doesNotThrow(
        () => assertConfigGate({ CLAUDE_CONFIG_DIR: cleanClaudeDir }),
        "R5 rework 9 CONTROL: clean CLAUDE_CONFIG_DIR admitted"
      );
    }

    // 3. CLAUDE-UNKNOWN-TOML (.toml in CLAUDE_CONFIG_DIR)
    {
      const tomlClaudeDir = join(r9Dir, "toml-claude");
      mkdirSync(tomlClaudeDir, { recursive: true });
      writeFileSync(join(tomlClaudeDir, "settings.json"), JSON.stringify({ env: {} }));
      writeFileSync(join(tomlClaudeDir, "extra-config.toml"), 'provider = "synthetic-redirect"\n');
      assert.throws(
        () => assertConfigGate({ CLAUDE_CONFIG_DIR: tomlClaudeDir }),
        (err: any) => err.code === "CONFIG_UNVERIFIED",
        "R5 rework 9: unknown .toml source in CLAUDE_CONFIG_DIR must be refused"
      );
    }

    // 4. CLAUDE-ANCESTOR-LOCAL (nested cwd with ancestor .claude/settings.local.json)
    {
      const projDir = join(r9Dir, "proj");
      const projClaude = join(projDir, ".claude");
      const nestedCwd = join(projDir, "nested", "deeper");
      mkdirSync(projClaude, { recursive: true });
      mkdirSync(nestedCwd, { recursive: true });

      // MUTANT: ancestor local settings contains redirect/refused name
      writeFileSync(join(projClaude, "settings.local.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "synthetic-unused-url" } }));
      assert.throws(
        () => assertConfigGate({ CLAUDE_CONFIG_DIR: join(r9Dir, "clean-claude") }, nestedCwd),
        (err: any) => err.code === "CONFIG_UNVERIFIED",
        "R5 rework 9: ancestor directory .claude refused name must be caught from nested cwd"
      );

      // CONTROL: ancestor local settings is clean -> admitted
      writeFileSync(join(projClaude, "settings.local.json"), JSON.stringify({ env: {} }));
      assert.doesNotThrow(
        () => assertConfigGate({ CLAUDE_CONFIG_DIR: join(r9Dir, "clean-claude") }, nestedCwd),
        "R5 rework 9 CONTROL: clean ancestor directory .claude admitted"
      );
    }

    // 5. CLAUDE-MANAGED-SETTINGS (rework 10: managed-settings.json discovery)
    {
      const managedDir = "/Library/Application Support/ClaudeCode";
      const managedPath = join(managedDir, "managed-settings.json");
      const origExists = fs.existsSync;
      const origRead = fs.readFileSync;
      const origReaddir = fs.readdirSync;
      try {
        // MUTANT: managed-settings.json carries refused redirect key
        fs.existsSync = function (p: any) {
          const s = String(p);
          if (s === managedDir || s === managedPath) return true;
          return origExists(p);
        };
        fs.readdirSync = function (p: any, ...args: any[]) {
          const s = String(p);
          if (s === managedDir) return ["managed-settings.json"] as any;
          return (origReaddir as any)(p, ...args);
        } as any;
        fs.readFileSync = function (p: any, ...args: any[]) {
          const s = String(p);
          if (s === managedPath) return JSON.stringify({ env: { ANTHROPIC_BASE_URL: "synthetic-unused-endpoint" } });
          return (origRead as any)(p, ...args);
        } as any;
        syncBuiltinESMExports();
        assert.throws(
          () => assertConfigGate({ CLAUDE_CONFIG_DIR: join(r9Dir, "clean-claude") }),
          (err: any) => err.code === "CONFIG_UNVERIFIED",
          "R5 rework 10: managed-settings.json with refused redirect key must be refused"
        );

        // CONTROL: managed-settings.json is clean
        fs.readFileSync = function (p: any, ...args: any[]) {
          const s = String(p);
          if (s === managedPath) return JSON.stringify({ env: {} });
          return (origRead as any)(p, ...args);
        } as any;
        syncBuiltinESMExports();
        assert.doesNotThrow(
          () => assertConfigGate({ CLAUDE_CONFIG_DIR: join(r9Dir, "clean-claude") }),
          "R5 rework 10 CONTROL: clean managed-settings.json admitted"
        );
      } finally {
        fs.existsSync = origExists;
        fs.readFileSync = origRead;
        fs.readdirSync = origReaddir;
        syncBuiltinESMExports();
      }
    }

    // 6. UNREADABLE CONFIG DIRECTORY (rework 12: fail-closed readdirSync)
    {
      const cleanDir = join(r9Dir, "clean-claude");
      // CONTROL: clean readable directory passes
      assert.doesNotThrow(
        () => assertConfigGate({ CLAUDE_CONFIG_DIR: cleanDir }),
        "R5 rework 12 CONTROL: readable config directory admitted"
      );

      // MUTANT: readdirSync throws EACCES -> CONFIG_UNVERIFIED
      const origReaddir = fs.readdirSync;
      try {
        fs.readdirSync = function (p: any, ...args: any[]) {
          const s = String(p);
          if (s === cleanDir) {
            const err: any = new Error("EACCES: permission denied, scandir");
            err.code = "EACCES";
            throw err;
          }
          return (origReaddir as any)(p, ...args);
        } as any;
        syncBuiltinESMExports();
        assert.throws(
          () => assertConfigGate({ CLAUDE_CONFIG_DIR: cleanDir }),
          (err: any) => err.code === "CONFIG_UNVERIFIED" && err.message.includes("unreadable config directory"),
          "R5 rework 12 MUTANT: unreadable config directory must throw CONFIG_UNVERIFIED"
        );
      } finally {
        fs.readdirSync = origReaddir;
        syncBuiltinESMExports();
      }
    }

    console.log("PASS R5: child-pid witness (post-offset OK, pre-offset/wrong-pid MISSING, wrong-model MISMATCH, malformed MISSING, correlated values surface); normalizer (structured envelope OK, plain text + missing field MODEL_EVIDENCE_MISSING); launch window, fixture-ts separation, production pre-spawn gates, effective config gates, routed missing-model refusal, rework 9 config discovery poles (CODEX-ABSENT, CLAUDE-UNKNOWN-SOURCE/TOML, CLAUDE-ANCESTOR-LOCAL), rework 10 managed-settings.json discovery, and rework 12 unreadable config directory validated.");
  } finally {
    try { assertNoSurvivingProcessesForDir(scratch); } catch (e) { console.error(e); throw e; }
    try { rmSync(scratch, { recursive: true, force: true }); } catch {}
  }
}

main();
