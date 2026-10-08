/**
 * L10 rework 16 — Live harness offline verification tests (Section B.5).
 *
 * Covers with two poles each:
 * 1. Reservation: missing, mismatched and spent ids give rc 64; valid id consumed once.
 * 2. CLI refusal: production CLI refuses --fixture-bin-for-test with rc 64.
 * 3. Live path via fixture binary standing in for CLI (Claude route):
 *    CONTROL passing with ledger & envelope; MUTANTs refusing before spawn with 0 new rows.
 * 4. Live path via fixture binary standing in for CLI (Codex route):
 *    CONTROL passing with envelope; MUTANT failing auth in scratch HOME with rc 76 / AUTH_BLOCKED.
 * 5. Ledger witness: matching childPid, lane, seat, req/eff OK; mismatching pid / model / lane rejected.
 * 6. CLI envelope normalizer: structured JSON OK; plain text / missing model / invalid JSON rejected.
 *
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, appendFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTwoPoleForTest, selectTwoPoleMode } from "../../packages/agent-commons/scripts/l10-twopole";
import { witnessFromOffset, normalizeCliEnvelope } from "./l10-witness";
import { _setL10BinariesForTest, _resetL10BinariesForTest, resolveL10Binaries } from "./config";

const ROOT = new URL("../../", import.meta.url).pathname;
const HARNESS_SCRIPT = join(ROOT, "packages/agent-commons/scripts/l10-twopole.ts");
const TSX_BIN = join(ROOT, "node_modules/.bin/tsx");

function runCliHarness(args: string[], env: Record<string, string> = {}): Promise<{ rc: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(TSX_BIN, [HARNESS_SCRIPT, ...args], {
      cwd: ROOT,
      env: {
        PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
        HOME: process.env.HOME!,
        USER: process.env.USER!,
        LOGNAME: process.env.LOGNAME!,
        SHELL: process.env.SHELL!,
        TERM: process.env.TERM!,
        LANG: process.env.LANG!,
        TMPDIR: process.env.TMPDIR!,
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout!.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.stderr!.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.on("error", (e: Error) => resolve({ rc: null, out: out + `\nSPAWN-ERROR: ${e.message}` }));
    child.on("close", (code) => resolve({ rc: code, out }));
  });
}

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), "l10-live-harness-"));
  const authDir = join(scratch, "run-ids");
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  const evidenceDir = join(scratch, "evidence");
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const fixtureLedger = join(scratch, "test-ledger.jsonl");
  writeFileSync(fixtureLedger, "", "utf8");

  // Create standing fixture binaries that simulate CLI wrapper behaviors
  const binDir = join(scratch, "bin");
  mkdirSync(binDir, { recursive: true, mode: 0o755 });
  const fixtureCli = join(binDir, "claude");
  writeFileSync(fixtureCli, `#!/bin/sh
cat > /dev/null
for arg in "$@"; do
  if [ "$arg" = "exec" ]; then
    if [ -z "$CODEX_HOME" ]; then
      echo "AUTH_BLOCKED: no auth in scratch home" >&2
      exit 76
    fi
  fi
done
TARGET_MODEL="claude-fable-5-1"
for arg in "$@"; do
  if [ "$arg" = "gpt-6.1-sol" ]; then
    TARGET_MODEL="gpt-6.1-sol"
  fi
done
NOW_S=$(date +%s)
echo "{\\"ts\\":$NOW_S,\\"pid\\":$$,\\"lane\\":\\"max\\",\\"seat\\":\\"seat-alpha\\",\\"req\\":\\"$TARGET_MODEL\\",\\"eff\\":\\"$TARGET_MODEL\\"}" >> "${fixtureLedger}"
if [ "$TARGET_MODEL" = "gpt-6.1-sol" ]; then
  echo "{\\"model\\":\\"$TARGET_MODEL\\",\\"usage\\":{\\"prompt_tokens\\":12,\\"completion_tokens\\":6,\\"covers_internal_calls\\":true}}"
else
  echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"READY\\",\\"session_id\\":\\"s\\",\\"usage\\":{\\"input_tokens\\":12,\\"output_tokens\\":6},\\"modelUsage\\":{\\"$TARGET_MODEL\\":{\\"inputTokens\\":12,\\"outputTokens\\":6}}}"
fi
exit 0
`, "utf8");
  chmodSync(fixtureCli, 0o700);

  // Brief rev 2 P: install a snapshot pointing the resolver at the
  // fixtureCli so the harness's two-pole production path can read it.
  // (snapshot AFTER the file exists; the resolver statSync's the path)
  _setL10BinariesForTest(resolveL10Binaries({
    AGENT_COMMONS_CLAUDE_BIN: fixtureCli,
    AGENT_COMMONS_CODEX_BIN: fixtureCli,
    AGENT_COMMONS_GROK_BIN: fixtureCli,
    AGENT_COMMONS_MODEL_LEDGER: fixtureLedger,
    AGENT_COMMONS_WITNESS_SEATS: "seat-alpha,seat-beta",
  } as NodeJS.ProcessEnv));

  const fixtureCliBlock = join(scratch, "mock-cli-block.sh");
  writeFileSync(fixtureCliBlock, `#!/bin/sh
cat > /dev/null
for arg in "$@"; do
  if [ "$arg" = "exec" ]; then
    if [ -z "$CODEX_HOME" ]; then
      TARGET_MODEL="gpt-6.1-sol"
      echo "{\\"model\\":\\"$TARGET_MODEL\\",\\"usage\\":{\\"prompt_tokens\\":10,\\"completion_tokens\\":5,\\"covers_internal_calls\\":true}}"
      exit 0
    fi
  fi
done
TARGET_MODEL="gpt-6.1-sol"
NOW_S=$(date +%s)
echo "{\\"model\\":\\"$TARGET_MODEL\\",\\"usage\\":{\\"prompt_tokens\\":12,\\"completion_tokens\\":6,\\"covers_internal_calls\\":true}}"
exit 0
`, "utf8");
  chmodSync(fixtureCliBlock, 0o700);

  const fixtureCliInconclusive = join(scratch, "mock-cli-inconclusive.sh");
  writeFileSync(fixtureCliInconclusive, `#!/bin/sh
cat > /dev/null
for arg in "$@"; do
  if [ "$arg" = "exec" ]; then
    if [ -z "$CODEX_HOME" ]; then
      echo "generic network connection timeout; remote peer disconnected" >&2
      exit 2
    fi
  fi
done
TARGET_MODEL="gpt-6.1-sol"
NOW_S=$(date +%s)
echo "{\\"model\\":\\"$TARGET_MODEL\\",\\"usage\\":{\\"prompt_tokens\\":12,\\"completion_tokens\\":6,\\"covers_internal_calls\\":true}}"
exit 0
`, "utf8");
  chmodSync(fixtureCliInconclusive, 0o700);

  const fixtureCliAgentMessageBlock = join(scratch, "mock-cli-agent-msg-block.sh");
  writeFileSync(fixtureCliAgentMessageBlock, `#!/bin/sh
cat > /dev/null
for arg in "$@"; do
  if [ "$arg" = "exec" ]; then
    if [ -z "$CODEX_HOME" ]; then
      echo '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"READY"}}'
      echo "401 Unauthorized" >&2
      exit 1
    fi
  fi
done
TARGET_MODEL="gpt-6.1-sol"
NOW_S=$(date +%s)
echo "{\\"model\\":\\"$TARGET_MODEL\\",\\"usage\\":{\\"prompt_tokens\\":12,\\"completion_tokens\\":6,\\"covers_internal_calls\\":true}}"
exit 0
`, "utf8");
  chmodSync(fixtureCliAgentMessageBlock, 0o700);

  try {
    // =========================================================================
    // 1. Reservation tests: single-use run id
    // =========================================================================
    // CONTROL: valid reservation file exists with mode 0600; consumed once (rc 0)
    const validId = `test-run-valid-${Date.now()}`;
    const validAuthPath = join(authDir, `${validId}.authorized`);
    writeFileSync(validAuthPath, "authorized", { mode: 0o600 });

    const firstRun = await runTwoPoleForTest({
      slot: "continuity",
      runId: validId,
      live: true,
      env: { ...process.env, AGENT_COMMONS_L10_LIVE_AUTHORIZED: validId },
      _forTest: {
        fixtureBin: fixtureCli,
        fixtureLedgerPath: fixtureLedger,
        runIdsDir: authDir,
        evidenceDir,
      },
    });
    assert.equal(firstRun.exitCode, 0, `CONTROL: valid authorized id runs successfully (got rc ${firstRun.exitCode})`);
    assert.equal(existsSync(validAuthPath), false, "authorized file must be consumed (renamed)");
    assert.equal(existsSync(join(authDir, `${validId}.spent`)), true, "spent file must exist after first run");

    // MUTANT 1: sequential reuse of spent id -> rc 64
    const secondRun = await runTwoPoleForTest({
      slot: "continuity",
      runId: validId,
      live: true,
      env: { ...process.env, AGENT_COMMONS_L10_LIVE_AUTHORIZED: validId },
      _forTest: {
        fixtureBin: fixtureCli,
        fixtureLedgerPath: fixtureLedger,
        runIdsDir: authDir,
        evidenceDir,
      },
    });
    assert.equal(secondRun.exitCode, 64, `MUTANT: sequential reuse of spent id must exit 64 (got rc ${secondRun.exitCode})`);

    // MUTANT 2: missing AGENT_COMMONS_L10_LIVE_AUTHORIZED env var -> rc 64
    const missingEnvRun = await runTwoPoleForTest({
      slot: "continuity",
      runId: `test-missing-env-${Date.now()}`,
      live: true,
      env: { ...process.env, AGENT_COMMONS_L10_LIVE_AUTHORIZED: "" },
      _forTest: {
        fixtureBin: fixtureCli,
        fixtureLedgerPath: fixtureLedger,
        runIdsDir: authDir,
        evidenceDir,
      },
    });
    assert.equal(missingEnvRun.exitCode, 64, "MUTANT: missing AGENT_COMMONS_L10_LIVE_AUTHORIZED env var must exit 64");

    // MUTANT 3: mismatched runId -> rc 64
    const mismatchedRun = await runTwoPoleForTest({
      slot: "continuity",
      runId: `run-A-${Date.now()}`,
      live: true,
      env: { ...process.env, AGENT_COMMONS_L10_LIVE_AUTHORIZED: "run-B" },
      _forTest: {
        fixtureBin: fixtureCli,
        fixtureLedgerPath: fixtureLedger,
        runIdsDir: authDir,
        evidenceDir,
      },
    });
    assert.equal(mismatchedRun.exitCode, 64, "MUTANT: mismatched AGENT_COMMONS_L10_LIVE_AUTHORIZED must exit 64");

    // MUTANT 4: matching env var but missing .authorized file -> rc 64
    const noFileId = `run-nofile-${Date.now()}`;
    const noFileRun = await runTwoPoleForTest({
      slot: "continuity",
      runId: noFileId,
      live: true,
      env: { ...process.env, AGENT_COMMONS_L10_LIVE_AUTHORIZED: noFileId },
      _forTest: {
        fixtureBin: fixtureCli,
        fixtureLedgerPath: fixtureLedger,
        runIdsDir: authDir,
        evidenceDir,
      },
    });
    assert.equal(noFileRun.exitCode, 64, "MUTANT: missing .authorized file must exit 64");

    // MUTANT 5: _forTest with fixtureLedgerPath but missing fixtureBin -> rc 64
    const noFixtureBinId = `test-nofixturebin-${Date.now()}`;
    const noFixtureBinRun = await runTwoPoleForTest({
      slot: "continuity",
      runId: noFixtureBinId,
      live: true,
      env: { ...process.env, AGENT_COMMONS_L10_LIVE_AUTHORIZED: noFixtureBinId },
      _forTest: {
        fixtureLedgerPath: fixtureLedger,
        runIdsDir: authDir,
        evidenceDir,
      },
    });
    assert.equal(noFixtureBinRun.exitCode, 64, "MUTANT: _forTest without fixtureBin must be refused with rc 64");

    // MUTANT 5b: _forTest presence with empty string values -> rc 64, never live:true
    const emptyForTestId = `test-emptyfortest-${Date.now()}`;
    const emptyForTestRun = await runTwoPoleForTest({
      slot: "continuity",
      runId: emptyForTestId,
      live: true,
      env: { ...process.env, AGENT_COMMONS_L10_LIVE_AUTHORIZED: emptyForTestId },
      _forTest: {
        fixtureLedgerPath: "",
      },
    });
    assert.equal(emptyForTestRun.exitCode, 64, "MUTANT: _forTest with empty field must be refused with rc 64");
    assert.equal(emptyForTestRun.report, null, "MUTANT: refused run must produce null report");
    assert.notEqual(emptyForTestRun.report?.live, true, "MUTANT: _forTest with empty field must never report live:true");

    // =========================================================================
    // 1b. Rework 20 Item B Poles: Pure predicate selectTwoPoleMode (R16-P2-2)
    // =========================================================================
    // CONTROL: _forTest: {} gives REFUSED (rc 64)
    const controlResult = selectTwoPoleMode({
      slot: "continuity",
      runId: "b-control",
      live: true,
      _forTest: {},
    });
    assert.equal(controlResult.mode, "REFUSED", "CONTROL: _forTest: {} must be REFUSED");
    assert.equal(controlResult.exitCode, 64, "CONTROL: _forTest: {} must exit with 64");
    assert.ok(controlResult.reason?.includes("_forTest requires non-empty fixtureBin"), "CONTROL: reason must name fixtureBin");

    // MUTANT: pre-fix expression evaluated Object.keys(options._forTest).length > 0
    // which was false for {}, causing isRealLive = USE_LIVE && !hasForTest to be true!
    const mutantOldHasForTest = (opts: any) => !!opts._forTest && Object.keys(opts._forTest).length > 0;
    const mutantIsRealLive = (opts: any) => (opts.live ?? false) && !mutantOldHasForTest(opts);
    const mutantOptions = { slot: "continuity", runId: "b-mutant", live: true, _forTest: {} };
    assert.equal(mutantIsRealLive(mutantOptions), true, "MUTANT: pre-fix expression selected live for _forTest: {}");

    // =========================================================================
    // 2. Production CLI refusal of test flags
    // =========================================================================
    // CONTROL: normal CLI invocation runs fixture binary cleanly
    const cliControlId = `cli-ctrl-${Date.now()}`;
    const cliControl = await runCliHarness(["--slot=continuity", `--run-id=${cliControlId}`]);
    assert.equal(cliControl.rc, 0, `CONTROL: normal CLI invocation without test flags completes rc 0 (got ${cliControl.rc})`);

    // MUTANT: CLI invocation with --fixture-bin-for-test is refused with rc 64
    const cliMutantId = `cli-mut-${Date.now()}`;
    const cliMutant = await runCliHarness(["--slot=continuity", `--run-id=${cliMutantId}`, `--fixture-bin-for-test=${fixtureCli}`]);
    assert.equal(cliMutant.rc, 64, `MUTANT: CLI with --fixture-bin-for-test must be refused with rc 64 (got ${cliMutant.rc})`);
    assert.ok(cliMutant.out.includes("REFUSED: test flags not permitted on production CLI"), "MUTANT: output must state refusal reason");

    // =========================================================================
    // 3. Live path via fixture binary (Claude route): CONTROL & MUTANTs
    // =========================================================================
    const claudeRunId = `claude-live-test-${Date.now()}`;
    writeFileSync(join(authDir, `${claudeRunId}.authorized`), "auth", { mode: 0o600 });
    const claudeRun = await runTwoPoleForTest({
      slot: "continuity",
      runId: claudeRunId,
      live: true,
      env: { ...process.env, AGENT_COMMONS_L10_LIVE_AUTHORIZED: claudeRunId },
      _forTest: {
        fixtureBin: fixtureCli,
        fixtureLedgerPath: fixtureLedger,
        runIdsDir: authDir,
        evidenceDir,
      },
    });
    assert.equal(claudeRun.exitCode, 0, `Claude live test run completes rc 0`);
    assert.equal(claudeRun.report.live, false, "fixture run must report live: false per the security reviewer C1");
    assert.equal(claudeRun.report.poles.length, 4, "Claude live run has CONTROL, MUTANT (unallowlisted qwen), MUTANT_GPT_SOL, and MUTANT_NO_MODEL");

    const claudeControl = claudeRun.report.poles[0];
    assert.equal(claudeControl.pole, "CONTROL");
    assert.equal(claudeControl.verdict, "PASS");
    assert.equal(claudeControl.ledgerWitness.verdict, "OK");
    assert.equal(claudeControl.ledgerWitness.lane, "max");
    assert.ok(claudeControl.ledgerWitness.seat === "seat-alpha" || claudeControl.ledgerWitness.seat === "seat-beta",
      `claudeControl.ledgerWitness.seat === ${claudeControl.ledgerWitness.seat} (synthetic seat names)`);
    assert.equal(claudeControl.actualModel, "claude-fable-5-1");

    const claudeMutant1 = claudeRun.report.poles[1];
    assert.equal(claudeMutant1.pole, "MUTANT");
    assert.equal(claudeMutant1.verdict, "PASS");
    assert.equal(claudeMutant1.status, "MODEL_UNAVAILABLE");

    const claudeMutantGpt = claudeRun.report.poles[2];
    assert.equal(claudeMutantGpt.pole, "MUTANT_GPT_SOL");
    assert.equal(claudeMutantGpt.verdict, "PASS");
    assert.equal(claudeMutantGpt.status, "MODEL_UNAVAILABLE");

    const claudeMutant2 = claudeRun.report.poles[3];
    assert.equal(claudeMutant2.pole, "MUTANT_NO_MODEL");
    assert.equal(claudeMutant2.verdict, "PASS");
    assert.equal(claudeMutant2.status, "MODEL_UNAVAILABLE");

    // =========================================================================
    // 4. Live path via fixture binary (Codex route): CONTROL & MUTANT (all 3 outcomes)
    // =========================================================================
    // Outcome 1: PASS = nonzero exit AND no valid model envelope AND stderr matches auth pattern
    const codexRunId = `codex-live-test-${Date.now()}`;
    writeFileSync(join(authDir, `${codexRunId}.authorized`), "auth", { mode: 0o600 });
    const codexRun = await runTwoPoleForTest({
      slot: "governance",
      runId: codexRunId,
      live: true,
      env: { ...process.env, AGENT_COMMONS_L10_LIVE_AUTHORIZED: codexRunId, CHECK_CODEX_AUTH: "1" },
      _forTest: {
        fixtureBin: fixtureCli,
        fixtureLedgerPath: fixtureLedger,
        runIdsDir: authDir,
        evidenceDir,
      },
    });
    assert.equal(codexRun.exitCode, 0, `Codex live test run completes rc 0`);
    assert.equal(codexRun.report.poles.length, 2, "Codex live run has CONTROL and MUTANT");

    const codexControl = codexRun.report.poles[0];
    assert.equal(codexControl.pole, "CONTROL");
    assert.equal(codexControl.verdict, "PASS");
    assert.equal(codexControl.actualModel, "gpt-6.1-sol");

    const codexMutant = codexRun.report.poles[1];
    assert.equal(codexMutant.pole, "MUTANT");
    assert.equal(codexMutant.verdict, "PASS");
    assert.equal(codexMutant.status, "AUTH_BLOCKED");
    assert.equal(codexMutant.exitCode, 76, "Codex MUTANT scratch HOME fails with rc 76 (auth rejection)");
    assert.equal(codexMutant.stderrAuthRejection, true, "Codex MUTANT records stderrAuthRejection: true");

    // Outcome 2: BLOCK = exit 0, or any valid model envelope
    const codexBlockId = `codex-block-test-${Date.now()}`;
    writeFileSync(join(authDir, `${codexBlockId}.authorized`), "auth", { mode: 0o600 });
    const codexBlockRun = await runTwoPoleForTest({
      slot: "governance",
      runId: codexBlockId,
      live: true,
      env: { ...process.env, AGENT_COMMONS_L10_LIVE_AUTHORIZED: codexBlockId },
      _forTest: {
        fixtureBin: fixtureCliBlock,
        fixtureLedgerPath: fixtureLedger,
        runIdsDir: authDir,
        evidenceDir,
      },
    });
    assert.equal(codexBlockRun.exitCode, 1, "Codex run with MUTANT BLOCK must exit 1");
    const codexMutantBlock = codexBlockRun.report.poles[1];
    assert.equal(codexMutantBlock.pole, "MUTANT");
    assert.equal(codexMutantBlock.verdict, "BLOCK");
    assert.equal(codexMutantBlock.status, "BLOCK");

    // Outcome 3: INCONCLUSIVE = nonzero exit without auth pattern in stderr
    const codexInconclusiveId = `codex-inconclusive-test-${Date.now()}`;
    writeFileSync(join(authDir, `${codexInconclusiveId}.authorized`), "auth", { mode: 0o600 });
    const codexInconclusiveRun = await runTwoPoleForTest({
      slot: "governance",
      runId: codexInconclusiveId,
      live: true,
      env: { ...process.env, AGENT_COMMONS_L10_LIVE_AUTHORIZED: codexInconclusiveId },
      _forTest: {
        fixtureBin: fixtureCliInconclusive,
        fixtureLedgerPath: fixtureLedger,
        runIdsDir: authDir,
        evidenceDir,
      },
    });
    assert.equal(codexInconclusiveRun.exitCode, 1, "Codex run with MUTANT INCONCLUSIVE must exit 1");
    const codexMutantInconclusive = codexInconclusiveRun.report.poles[1];
    assert.equal(codexMutantInconclusive.pole, "MUTANT");
    assert.equal(codexMutantInconclusive.verdict, "INCONCLUSIVE");
    assert.equal(codexMutantInconclusive.status, "INCONCLUSIVE");
    assert.equal(codexMutantInconclusive.stderrAuthRejection, false);

    // Outcome 4 (R16-P1-1): BLOCK = nested agent_message item blocks MUTANT despite nonzero exit and auth stderr
    const codexAgentMsgId = `codex-agentmsg-test-${Date.now()}`;
    writeFileSync(join(authDir, `${codexAgentMsgId}.authorized`), "auth", { mode: 0o600 });
    const codexAgentMsgRun = await runTwoPoleForTest({
      slot: "governance",
      runId: codexAgentMsgId,
      live: true,
      env: { ...process.env, AGENT_COMMONS_L10_LIVE_AUTHORIZED: codexAgentMsgId },
      _forTest: {
        fixtureBin: fixtureCliAgentMessageBlock,
        fixtureLedgerPath: fixtureLedger,
        runIdsDir: authDir,
        evidenceDir,
      },
    });
    assert.equal(codexAgentMsgRun.exitCode, 1, "Codex run with nested agent_message must BLOCK and exit 1");
    const codexMutantAgentMsg = codexAgentMsgRun.report.poles[1];
    assert.equal(codexMutantAgentMsg.pole, "MUTANT");
    assert.equal(codexMutantAgentMsg.verdict, "BLOCK");
    assert.equal(codexMutantAgentMsg.status, "BLOCK");

    // =========================================================================
    // 5. Ledger witness against fixture ledger appended after spawn
    // =========================================================================
    const witnessLedger = join(scratch, "witness-test-ledger.jsonl");
    writeFileSync(witnessLedger, "", "utf8");
    const preOffset = 0;
    const testPid = 77777;
    const targetModel = "claude-fable-5-1";
    const now = Date.now();
    const nowS = Math.floor(now / 1000);

    // CONTROL 1: seconds-format row (10 digits) matching wrapper -> OK
    appendFileSync(witnessLedger, JSON.stringify({ ts: nowS, pid: testPid, lane: "max", seat: "seat-alpha", req: targetModel, eff: targetModel }) + "\n");
    const wControlSeconds = witnessFromOffset(witnessLedger, preOffset, testPid, targetModel, { launchTimeMs: now });
    assert.equal(wControlSeconds.verdict, "OK", "CONTROL: seconds-format row matching wrapper returns OK");
    assert.equal(wControlSeconds.present, true);
    assert.equal(wControlSeconds.match, true);
    assert.equal(wControlSeconds.correlated?.lane, "max");
    assert.equal(wControlSeconds.correlated?.seat, "seat-alpha");

    // CONTROL 2: valid row for 90-second call (launch window check) -> OK
    const longCallLaunch = now - 90000;
    const longCallS = Math.floor(longCallLaunch / 1000);
    const longPid = 77778;
    appendFileSync(witnessLedger, JSON.stringify({ ts: longCallS, pid: longPid, lane: "max", seat: "seat-alpha", req: targetModel, eff: targetModel }) + "\n");
    const wControlLong = witnessFromOffset(witnessLedger, preOffset, longPid, targetModel, { launchTimeMs: longCallLaunch, settleTimeMs: now });
    assert.equal(wControlLong.verdict, "OK", "CONTROL: valid row for 90-second call within launch window returns OK");

    // MUTANT 1: mismatching pid -> ROUTE_WITNESS_MISSING
    const wWrongPid = witnessFromOffset(witnessLedger, preOffset, testPid + 999, targetModel, { launchTimeMs: now });
    assert.equal(wWrongPid.verdict, "ROUTE_WITNESS_MISSING", "MUTANT: mismatching pid returns ROUTE_WITNESS_MISSING");

    // MUTANT 2: matching pid but wrong model -> ROUTE_WITNESS_MISMATCH
    const wWrongModel = witnessFromOffset(witnessLedger, preOffset, testPid, "wrong-model-lit", { launchTimeMs: now });
    assert.equal(wWrongModel.verdict, "ROUTE_WITNESS_MISMATCH", "MUTANT: matching pid with wrong model returns ROUTE_WITNESS_MISMATCH");

    // MUTANT 3: matching pid but wrong lane ("ccr") -> ROUTE_WITNESS_MISMATCH
    const laneLedger = join(scratch, "lane-test-ledger.jsonl");
    writeFileSync(laneLedger, JSON.stringify({ ts: nowS, pid: testPid, lane: "ccr", seat: "seat-alpha", req: targetModel, eff: targetModel }) + "\n");
    const wWrongLane = witnessFromOffset(laneLedger, 0, testPid, targetModel, { launchTimeMs: now });
    assert.equal(wWrongLane.verdict, "ROUTE_WITNESS_MISMATCH", "MUTANT: matching pid with lane ccr returns ROUTE_WITNESS_MISMATCH");

    // MUTANT 4: matching pid but wrong seat -> ROUTE_WITNESS_MISMATCH
    const seatLedger = join(scratch, "seat-test-ledger.jsonl");
    writeFileSync(seatLedger, JSON.stringify({ ts: nowS, pid: testPid, lane: "max", seat: "unauthorized", req: targetModel, eff: targetModel }) + "\n");
    const wWrongSeat = witnessFromOffset(seatLedger, 0, testPid, targetModel, { launchTimeMs: now });
    assert.equal(wWrongSeat.verdict, "ROUTE_WITNESS_MISMATCH", "MUTANT: matching pid with wrong seat returns ROUTE_WITNESS_MISMATCH");

    // MUTANT 5: row from before the launch (>5s before launchTimeMs) -> ROUTE_WITNESS_MISMATCH
    const preLaunchLedger = join(scratch, "pre-launch-ledger.jsonl");
    const beforeLaunchS = Math.floor((now - 10000) / 1000);
    writeFileSync(preLaunchLedger, JSON.stringify({ ts: beforeLaunchS, pid: testPid, lane: "max", seat: "non-configured", req: targetModel, eff: targetModel }) + "\n");
    const wPreLaunch = witnessFromOffset(preLaunchLedger, 0, testPid, targetModel, { launchTimeMs: now, settleTimeMs: now });
    assert.equal(wPreLaunch.verdict, "ROUTE_WITNESS_MISMATCH", "MUTANT: row from before launch rejected with ROUTE_WITNESS_MISMATCH");

    // =========================================================================
    // 6. CLI envelope normalizer: matching and mismatching models
    // =========================================================================
    // CONTROL: the real-shape envelope gives OK with model claude-opus-5-5
    const validJson = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "READY",
      session_id: "s",
      usage: { input_tokens: 20, output_tokens: 10 },
      modelUsage: {
        "claude-opus-5-5": { inputTokens: 20, outputTokens: 10 },
      },
    });
    const normControl = normalizeCliEnvelope(validJson, { route: "claude" });
    assert.equal(normControl.ok, true, "CONTROL: real-shape envelope parsed successfully");
    if (normControl.ok) {
      assert.equal(normControl.actualModel, "claude-opus-5-5");
      assert.equal(normControl.modelEvidence.fieldPath, "modelUsage");
      assert.equal(normControl.usage?.promptTokens, 20);
      assert.equal(normControl.usage?.completionTokens, 10);
      assert.equal(normControl.usage?.totalTokens, 30);
    }

    // MUTANT 1: top-level model only without modelUsage -> MODEL_EVIDENCE_MISSING
    const oldShapeJson = JSON.stringify({
      type: "result",
      result: "READY",
      model: "claude-opus-5-5",
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    });
    const normOldShape = normalizeCliEnvelope(oldShapeJson, { route: "claude" });
    assert.equal(normOldShape.ok, false, "MUTANT 1: top-level model only must fail normalization");
    if (!normOldShape.ok) {
      assert.equal(normOldShape.code, "MODEL_EVIDENCE_MISSING");
    }

    // MUTANT 2: two modelUsage keys -> MODEL_EVIDENCE_AMBIGUOUS
    const ambiguousModelJson = JSON.stringify({
      type: "result",
      is_error: false,
      result: "READY",
      modelUsage: {
        "claude-opus-5-5": { inputTokens: 10, outputTokens: 5 },
        "claude-sonnet-5-5": { inputTokens: 10, outputTokens: 5 },
      },
    });
    const normAmbiguous = normalizeCliEnvelope(ambiguousModelJson, { route: "claude" });
    assert.equal(normAmbiguous.ok, false, "MUTANT 2: multiple modelUsage keys must fail");
    if (!normAmbiguous.ok) {
      assert.equal(normAmbiguous.code, "MODEL_EVIDENCE_AMBIGUOUS");
      assert.ok(normAmbiguous.reason.includes("claude-opus-5-5") && normAmbiguous.reason.includes("claude-sonnet-5-5"));
    }

    // MUTANT 3: is_error: true -> MODEL_EVIDENCE_MISSING
    const errorEnvelopeJson = JSON.stringify({
      type: "result",
      is_error: true,
      result: "rate limit exceeded",
      modelUsage: {
        "claude-opus-5-5": { inputTokens: 1, outputTokens: 1 },
      },
    });
    const normError = normalizeCliEnvelope(errorEnvelopeJson, { route: "claude" });
    assert.equal(normError.ok, false, "MUTANT 3: is_error: true must fail normalization");
    if (!normError.ok) {
      assert.equal(normError.code, "MODEL_EVIDENCE_MISSING");
    }

    // MUTANT 4: plain text stdout -> MODEL_EVIDENCE_MISSING
    const plainText = "Reply with the single word READY.\nREADY\n";
    const normPlainText = normalizeCliEnvelope(plainText, { route: "claude" });
    assert.equal(normPlainText.ok, false, "MUTANT: plain text stdout must fail envelope normalization");
    if (!normPlainText.ok) {
      assert.equal(normPlainText.code, "MODEL_EVIDENCE_MISSING");
    }

    // MUTANT 5: malformed JSON -> MODEL_EVIDENCE_MISSING
    const malformedJson = "{ model: 'broken' ";
    const normMalformed = normalizeCliEnvelope(malformedJson, { route: "claude" });
    assert.equal(normMalformed.ok, false, "MUTANT: malformed JSON must fail normalization");
    if (!normMalformed.ok) {
      assert.equal(normMalformed.code, "MODEL_EVIDENCE_MISSING");
    }

    // Codex JSONL CONTROL: line-by-line event stream with declared model in turn.completed
    const codexJsonl = [
      JSON.stringify({ type: "thread.started" }),
      JSON.stringify({
        type: "turn.completed",
        model: "gpt-6.1-sol",
        usage: { prompt_tokens: 15, completion_tokens: 5, covers_internal_calls: true },
      }),
    ].join("\n");
    const normCodex = normalizeCliEnvelope(codexJsonl, { route: "codex" });
    assert.equal(normCodex.ok, true, "CONTROL: Codex JSONL stream parsed line by line");
    if (normCodex.ok) {
      assert.equal(normCodex.actualModel, "gpt-6.1-sol");
      assert.equal(normCodex.usage?.totalTokens, 20);
      assert.equal(normCodex.modelEvidence.fieldPath, "turn.completed.model");
    }

    // Codex JSONL MUTANT: stream without declared model event
    const codexNoModel = [
      JSON.stringify({ type: "thread.started" }),
      JSON.stringify({ type: "step.progress" }),
    ].join("\n");
    const normCodexNoModel = normalizeCliEnvelope(codexNoModel, { route: "codex" });
    assert.equal(normCodexNoModel.ok, false, "MUTANT: Codex JSONL without declared model fails normalization");
    if (!normCodexNoModel.ok) {
      assert.equal(normCodexNoModel.code, "MODEL_EVIDENCE_MISSING");
    }

    console.log("PASS L10 live harness offline verification: reservation (single-use, spent, missing, mismatched), CLI test flag refusal (rc 64), live fixture path (Claude CONTROL/MUTANTs, Codex CONTROL/MUTANT), ledger witness (pid/lane/seat/model matching vs mismatching), envelope normalizer (structured JSON vs plain/malformed).");
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
}).finally(() => {
  _resetL10BinariesForTest();
});
