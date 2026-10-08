/**
 * L10 — two-pole harness (design v3 §d; rework 1 items B3/B4/C1-C4; rework 16 live wiring).
 *
 * CONTROL/MUTANT per slot, one at a time, scratch HOME mode 700 under
 * review-evidence/l10/<runId>/.
 *
 * Rework-16 changes:
 * - Harness --live path enabled for per-route billing proof.
 * - Single-use run-id reservation: AGENT_COMMONS_L10_LIVE_AUTHORIZED=<id>
 *   matches review-evidence/l10/run-ids/<id>.authorized, consumed atomically
 *   (renamed to .spent) on first use; missing, mismatched or spent exits 64.
 * - Spawns real frozen command via spawnClaudeL10Child for Claude and
 *   spawnL10Child for Codex, with prompt "Reply with the single word READY." on stdin.
 * - Claude CONTROL correlates the real ledger row at AGENT_COMMONS_MODEL_LEDGER
 *   (when unconfigured or the route is disabled at startup, the
 *   witness is bypassed; brief rev 4 R2 fails closed on a configured
 *   but missing/malformed ledger, returning ROUTE_WITNESS_MISSING).
 *   Asserting lane:"max", seat in the configured AGENT_COMMONS_WITNESS_SEATS,
 *   req/eff == frozen literal.
 * - Both routes normalize structured envelope via normalizeCliEnvelope.
 * - Claude MUTANT verifies pre-spawn refusal with non-allowlisted model and
 *   no model, with zero child and zero new ledger rows.
 * - Codex MUTANT with scratch HOME fails authentication (rc 76 / AUTH_BLOCKED).
 * - Grok stays BLOCKED with static reason.
 * - report.live is true ONLY for a real CLI run, never for a fixture.
 *
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, chmodSync, mkdtempSync, readFileSync, appendFileSync, existsSync, openSync, closeSync, renameSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { buildChildEnv, assertSpawnTripwire } from "../../../server/adapters/l10-env";
import { buildL10Argv, assertSlotEligibleForL10, L10_FROZEN_LITERALS, assertValidModelLiteral } from "../../../server/adapters/l10-routes";
import { getResolvedL10Binaries, getClaudeRouteResolution } from "../../../server/adapters/config";
import { classifyExit, sha256, spawnClaudeL10Child, spawnClaudeL10ChildForTest, spawnCodexL10Child, spawnCodexL10ChildForTest, sharedClaudePermitPool, L10PermitPool, assertConfigGate } from "../../../server/adapters/l10-process";
import { witnessFromOffset, normalizeCliEnvelope } from "../../../server/adapters/l10-witness";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");
const COMMAND_CONTRACT_VERSION = "l10-v3.0f948519-b";
// Brief rev 4 R3: the seat list is the configured
// AGENT_COMMONS_WITNESS_SEATS (no hard-coded default). The harness reads
// the SAME frozen resolver snapshot as the rest of the route. Reads
// are re-evaluated per call (the memoized getResolvedL10Binaries
// returns the current snapshot, so a test-side _setL10BinariesForTest
// takes effect on the next call).
function getSeats(): readonly string[] {
  const r = getResolvedL10Binaries().witnessSeats;
  return r.status === "enabled" ? r.seats : [];
}

export interface TwoPoleRunOptions {
  slot?: string;
  runId?: string;
  live?: boolean;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  _forTest?: {
    fixtureBin?: string;
    fixtureLedgerPath?: string;
    runIdsDir?: string;
    evidenceDir?: string;
    permitPool?: L10PermitPool;
  };
}

export type TwoPoleMode = "REFUSED" | "LIVE" | "TEST" | "OFFLINE";

/**
 * Pure predicate to classify two-pole harness execution mode without side effects.
 * Used for testing mode selection (especially refusing _forTest without fixtureBin).
 */
export function selectTwoPoleMode(
  options: TwoPoleRunOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): { mode: TwoPoleMode; exitCode?: number; reason?: string } {
  const effectiveArgv = options.argv ?? [];

  // Production CLI refusal of test flags
  if (options._forTest === undefined && effectiveArgv.some((a) => a.startsWith("--fixture-bin") || a.startsWith("--test-"))) {
    return { mode: "REFUSED", exitCode: 64, reason: "test flags not permitted on production CLI" };
  }

  // Rework 20 B: Presence decides mode
  const hasForTest = options._forTest !== undefined;
  if (hasForTest && (!options._forTest?.fixtureBin || options._forTest.fixtureBin.trim() === "")) {
    return { mode: "REFUSED", exitCode: 64, reason: "_forTest requires non-empty fixtureBin" };
  }

  const USE_LIVE = options.live ?? effectiveArgv.includes("--live");
  const isRealLive = USE_LIVE && !hasForTest;

  if (isRealLive) {
    return { mode: "LIVE" };
  }

  if (hasForTest) {
    return { mode: "TEST" };
  }

  return { mode: "OFFLINE" };
}

export async function runTwoPole(options: TwoPoleRunOptions = {}): Promise<{ report: any; exitCode: number }> {
  const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  const exit = (code: number, rep: any = null) => {
    if (isDirectRun) process.exit(code);
    return { report: rep, exitCode: code };
  };

  const effectiveArgv = options.argv ?? process.argv;
  const effectiveEnv = options.env ?? process.env;

  // Test flags on production CLI are rejected immediately (rc 64)
  if (options._forTest === undefined && effectiveArgv.some((a) => a.startsWith("--fixture-bin") || a.startsWith("--test-"))) {
    console.error("REFUSED: test flags not permitted on production CLI");
    return exit(64);
  }

  // Rework 20 B: _forTest is decided by field presence, not non-empty values
  // ({ _forTest: {} } must be refused with rc 64, never live:true)
  const hasForTest = options._forTest !== undefined;
  if (hasForTest && (!options._forTest?.fixtureBin || options._forTest.fixtureBin.trim() === "")) {
    console.error("REFUSED: _forTest requires non-empty fixtureBin");
    return exit(64);
  }

  const slotArg = effectiveArgv.find((a) => a.startsWith("--slot="));
  const SLOT = options.slot ?? (slotArg ? slotArg.slice("--slot=".length) : "continuity");
  const runIdArg = effectiveArgv.find((a) => a.startsWith("--run-id="));
  const RUN_ID = options.runId ?? (runIdArg ? runIdArg.slice("--run-id=".length) : `harness-${Date.now()}`);
  const USE_LIVE = options.live ?? effectiveArgv.includes("--live");
  const LIVE_AUTH = effectiveEnv.AGENT_COMMONS_L10_LIVE_AUTHORIZED ?? "";

  const ROUTE: "claude" | "codex" | "grok" =
    SLOT === "governance" ? "codex" : SLOT === "release" ? "grok" : "claude";

  const evidenceDirArg = effectiveArgv.find((a) => a.startsWith("--evidence-dir="));
  const evidenceRoot = options._forTest?.evidenceDir ?? (evidenceDirArg ? evidenceDirArg.slice("--evidence-dir=".length) : join(ROOT, "review-evidence", "l10"));
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });

  // 1. Single-use run id reservation for --live
  if (USE_LIVE) {
    if (!LIVE_AUTH || LIVE_AUTH !== RUN_ID) {
      console.error(`REFUSED: AGENT_COMMONS_L10_LIVE_AUTHORIZED missing or does not match runId (${LIVE_AUTH} !== ${RUN_ID})`);
      return exit(64);
    }
    const runIdsDir = options._forTest?.runIdsDir ?? join(evidenceRoot, "run-ids");
    mkdirSync(runIdsDir, { recursive: true, mode: 0o700 });
    const authPath = join(runIdsDir, `${RUN_ID}.authorized`);
    const spentPath = join(runIdsDir, `${RUN_ID}.spent`);

    if (!existsSync(authPath) || existsSync(spentPath)) {
      console.error(`REFUSED: authorization file for runId ${RUN_ID} missing or already spent`);
      return exit(64);
    }
    try {
      renameSync(authPath, spentPath);
    } catch {
      console.error(`REFUSED: failed to atomically consume authorization for runId ${RUN_ID}`);
      return exit(64);
    }
  }

  // R6: ATOMIC single-use run-id reservation BEFORE any artifact or child
  const reservationPath = join(evidenceRoot, `run-${RUN_ID}.reserved`);
  try {
    const rfd = openSync(reservationPath, "wx");
    try {
      writeFileSync(rfd, JSON.stringify({ runId: RUN_ID, pid: process.pid, reservedAt: new Date().toISOString() }), "utf8");
    } finally { closeSync(rfd); }
  } catch {
    console.error(`REFUSED: run id ${RUN_ID} already reserved (single-use; R6 atomic reservation)`);
    return exit(64);
  }

  // Slot eligibility. C3: blocked slots get a BLOCKED report row with a static reason
  let slotOk = false;
  let slotBlockedReason: string | null = null;
  let argv: string[] = [];
  let expectedLiteral: string | null = null;
  try {
    assertSlotEligibleForL10(SLOT);
    argv = buildL10Argv({ slotId: SLOT, cwd: join(evidenceRoot, RUN_ID), stdinPath: "/dev/stdin" });
    expectedLiteral = L10_FROZEN_LITERALS[SLOT as keyof typeof L10_FROZEN_LITERALS]!;
    slotOk = true;
  } catch (e: any) {
    slotBlockedReason = e?.code ?? "MODEL_UNAVAILABLE";
  }

  const scratchRoot = join(evidenceRoot, RUN_ID);
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });

  function pacificNow(): string {
    return new Date().toLocaleString("en-US", {
      timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }) + " PDT";
  }

  function fileSha256(path: string): string | null {
    try { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
    catch { return null; }
  }

  // Brief rev 2 P: the wrapper binary is the frozen resolved value
  // (AGENT_COMMONS_*_BIN). When unconfigured, the harness fails closed
  // (USE_LIVE refuses to spawn a wrapper without a configured path).
  const resolvedBin = getResolvedL10Binaries();
  const binKey = ROUTE === "claude" ? "claude" : ROUTE === "codex" ? "codex" : "grok";
  const configuredBin = resolvedBin[binKey];
  const wrapperPath = configuredBin.status === "enabled" ? configuredBin.path : null;
  const wrapperDigest = wrapperPath !== null ? fileSha256(wrapperPath) : "unconfigured";
  // Config paths follow the operator's real home (os.userInfo().homedir).
  const realHome = userInfo().homedir;
  const ROUTE_CONFIG_PATHS: Record<string, string> = {
    claude: join(realHome, ".claude/settings.json"),
    codex: join(realHome, ".codex/config.toml"),
    grok: join(realHome, ".grok/auth.json"),
  };
  const effectiveConfigDigest = fileSha256(ROUTE_CONFIG_PATHS[ROUTE]) ?? "absent";
  const configurationFingerprint = createHash("sha256")
    .update(JSON.stringify({ route: ROUTE, contract: COMMAND_CONTRACT_VERSION, wrapper: wrapperDigest, effectiveConfig: effectiveConfigDigest }))
    .digest("hex");

  const isRealLive = USE_LIVE && !hasForTest;
  const poleTimeoutMs = isRealLive ? 120000 : 15000;

  // Brief rev 4 R2: in the real-live (production) path, the Claude route
  // is ENABLED only when the CLI binary, the model ledger, and the witness
  // seats all resolve. Same rule for the harness; the test entry uses
  // fixtureBin / fixtureLedgerPath to override.
  if (isRealLive && ROUTE === "claude") {
    const routeR = getClaudeRouteResolution();
    if (routeR.status !== "enabled") {
      console.error(`REFUSED: claude route disabled at startup: ${routeR.reason}`);
      return { report: { runId: RUN_ID, slot: SLOT, live: isRealLive, poles: [{
        runId: RUN_ID, pole: "NOT_RUN", slot: SLOT, slotEligible: false,
        route: ROUTE, requestedModel: null,
        wrapperDigest, configurationFingerprint, commandContractVersion: COMMAND_CONTRACT_VERSION,
        startPacific: pacificNow(), endPacific: pacificNow(), runAt: new Date().toISOString(),
        witness: { present: false, match: false, verdict: "ROUTE_WITNESS_MISSING", witnessSource: "wrapper" },
        envelope: { ok: false, code: "MODEL_UNAVAILABLE", reason: `claude route disabled at startup: ${routeR.reason}` },
        witnessPassed: false, exitCode: 64, status: "BLOCKED", staticReason: "MODEL_UNAVAILABLE",
      }] }, exitCode: 64 };
    }
  }

  if (!slotOk) {
    // C3: BLOCKED row, static reason, no spawn, no report-less exit
    const blockedRow = {
      runId: RUN_ID, pole: "NOT_RUN", slot: SLOT, slotEligible: false,
      route: ROUTE, requestedModel: null,
      wrapperDigest, configurationFingerprint, commandContractVersion: COMMAND_CONTRACT_VERSION,
      startPacific: pacificNow(), endPacific: pacificNow(), runAt: new Date().toISOString(),
      status: "BLOCKED", staticReason: slotBlockedReason,
      exitCode: null, stdoutBytes: 0, stdoutSha256: null, stderrBytes: 0, stderrSha256: null,
      actualModel: null, structuredUsageValid: false,
      ledgerWitness: { present: false, match: false, verdict: "NOT_APPLICABLE", witnessSource: isRealLive ? "wrapper" : "fixture" },
      verdict: "BLOCKED",
    };
    const report = { runId: RUN_ID, slot: SLOT, live: isRealLive, poles: [blockedRow] };
    writeFileSync(join(scratchRoot, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(`runId=${RUN_ID} slot=${SLOT} verdict=BLOCKED reason=${slotBlockedReason}`);
    return exit(0, report);
  }

  // --- eligible slot: poles ---

  const scratchHome = mkdtempSync(join(scratchRoot, "home-"));
  chmodSync(scratchHome, 0o700);
  mkdirSync(join(scratchHome, ".claude"), { recursive: true, mode: 0o700 });
  mkdirSync(join(scratchHome, ".codex"), { recursive: true, mode: 0o700 });

  const fixtureLedger = join(scratchRoot, "model-ledger.jsonl");
  writeFileSync(fixtureLedger, "", "utf8");

  function writeFixtureBinary(mode: string, targetLiteral: string): string {
    const binDir = join(scratchRoot, `bin-${mode}`);
    mkdirSync(binDir, { recursive: true, mode: 0o755 });
    const p = join(binDir, ROUTE === "claude" ? "claude" : `fixture-${mode}.sh`);
    // Brief rev 4 R3: the fixture ledger row uses the first configured
    // seat (synthetic in tests; the real env names a real one).
    const seatToken = getSeats()[0] ?? "control";
    writeFileSync(p, `#!/bin/sh
SEAT_TOKEN=${JSON.stringify(seatToken)}
cat > /dev/null
cat > /dev/null
if [ "${ROUTE}" = "codex" ] && [ -z "$CODEX_HOME" ]; then
  echo "AUTH_BLOCKED: no auth found in scratch home" >&2
  exit 76
fi
NOW_SEC=$(date +%s)
echo "{\\"ts\\":$NOW_SEC,\\"pid\\":$$,\\"lane\\":\\"max\\",\\"seat\\":\\"${SEAT_TOKEN}\\",\\"req\\":\\"${targetLiteral}\\",\\"eff\\":\\"${targetLiteral}\\"}" >> "${fixtureLedger}"
if [ "${ROUTE}" = "claude" ]; then
  echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"READY\\",\\"session_id\\":\\"s\\",\\"usage\\":{\\"input_tokens\\":10,\\"output_tokens\\":5},\\"modelUsage\\":{\\"${targetLiteral}\\":{\\"inputTokens\\":10,\\"outputTokens\\":5}}}"
else
  echo "{\\"model\\":\\"${targetLiteral}\\",\\"usage\\":{\\"prompt_tokens\\":10,\\"completion_tokens\\":5,\\"covers_internal_calls\\":true}}"
fi
exit 0
`, "utf8");
    chmodSync(p, 0o755);
    return p;
  }

  // Brief rev 2 P: the model-ledger path is the frozen resolved value
  // (AGENT_COMMONS_MODEL_LEDGER). When unconfigured, the live path
  // fails closed (witness reports NOT_EVALUATED).
  const configuredLedger = resolvedBin.modelLedger;
  const resolvedLedgerPath = configuredLedger.status === "enabled" ? configuredLedger.path : null;
  const liveLedger = options._forTest?.fixtureLedgerPath ?? resolvedLedgerPath ?? "";
  const ledgerPath = USE_LIVE ? liveLedger : fixtureLedger;
  const witnessSource: "fixture" | "wrapper" = isRealLive ? "wrapper" : "fixture";

  let controlBin: string;
  let mutantBin: string;
  if (USE_LIVE) {
    controlBin = options._forTest?.fixtureBin ?? argv[0];
    mutantBin = options._forTest?.fixtureBin ?? argv[0];
  } else {
    controlBin = writeFixtureBinary("control", expectedLiteral!);
    mutantBin = writeFixtureBinary("mutant", ROUTE === "codex" ? expectedLiteral! : "WRONG-LITERAL-XYZ");
  }

  // Brief rev 2 §Nit: Claude CONTROL home is the real account's home
  // (os.userInfo().homedir, never a hard-coded user path literal).
  const controlHome = (ROUTE === "claude" || ROUTE === "codex") ? userInfo().homedir : scratchHome;
  const controlEnv = buildChildEnv({
    route: ROUTE,
    runId: `${RUN_ID}-CONTROL`,
    home: controlHome,
    pole: "CONTROL",
    runDir: scratchRoot,
  });

  const mutantHome = ROUTE === "claude" ? userInfo().homedir : scratchHome;
  const mutantEnv = buildChildEnv({
    route: ROUTE,
    runId: `${RUN_ID}-MUTANT`,
    home: mutantHome,
    pole: "MUTANT",
    runDir: scratchRoot,
  });

  const mutantModel = "qwen3.8-max";
  const mutantArgv = ROUTE === "claude"
    ? [argv[0], "--print", "--model", mutantModel, ...argv.slice(4)]
    : argv;

  async function runPole(label: "CONTROL" | "MUTANT" | "MUTANT_GPT_SOL" | "MUTANT_NO_MODEL", binPath: string) {
    const childEnv = label === "CONTROL" ? controlEnv : mutantEnv;
    const startPacific = pacificNow();
    const launchTimeMs = Date.now();
    const prompt = USE_LIVE ? "Reply with the single word READY." : `SLOT=${SLOT}; harness=${RUN_ID}; pole=${label}`;
    const promptSha = sha256(prompt);

    let poleArgv = argv;
    let requestedModel: string | null = expectedLiteral;
    if (label === "MUTANT") {
      poleArgv = (ROUTE === "claude") ? mutantArgv : argv;
      requestedModel = mutantModel;
    } else if (label === "MUTANT_GPT_SOL") {
      poleArgv = (ROUTE === "claude") ? [argv[0], "--print", "--model", "gpt-6.1-sol", ...argv.slice(4)] : argv;
      requestedModel = "gpt-6.1-sol";
    } else if (label === "MUTANT_NO_MODEL") {
      poleArgv = argv.filter((_, idx, arr) => arr[idx] !== "--model" && arr[idx - 1] !== "--model");
      requestedModel = null;
    }

    const preSpawnOffset = existsSync(ledgerPath) ? Buffer.byteLength(readFileSync(ledgerPath, "utf8"), "utf8") : 0;

    let preSpawnRefusal: { code: string; message: string } | null = null;
    let result: {
      stdoutText: string;
      stderrText: string;
      diagnostic: { exitCode: number; stdoutBytes: number; stdoutSha256: string; stderrBytes: number; stderrSha256: string };
      childPid: number;
    } = {
      stdoutText: "",
      stderrText: "",
      diagnostic: { exitCode: -1, stdoutBytes: 0, stdoutSha256: sha256(""), stderrBytes: 0, stderrSha256: sha256("") },
      childPid: 0,
    };

    let settleTimeMs = 0;
    try {
      if (ROUTE === "claude") {
        const testPermitPool = options._forTest?.permitPool ?? new L10PermitPool(join(scratchRoot, "permits"), 2);
        const r = !isRealLive
          ? await spawnClaudeL10ChildForTest({
              argv: [binPath, ...poleArgv.slice(1)],
              cwd: scratchRoot, childEnv, promptText: prompt,
              timeoutMs: poleTimeoutMs, cancelSignal: { cancelled: () => false },
              runId: `${RUN_ID}-${label}`,
              permitPool: testPermitPool,
            })
          : await spawnClaudeL10Child({
              argv: [binPath, ...poleArgv.slice(1)],
              cwd: scratchRoot, childEnv, promptText: prompt,
              timeoutMs: poleTimeoutMs, cancelSignal: { cancelled: () => false },
              runId: `${RUN_ID}-${label}`,
              permitPool: sharedClaudePermitPool,
            });
        result = { stdoutText: r.stdoutText, stderrText: r.stderrText, diagnostic: r.diagnostic, childPid: r.childPid };
      } else {
        const r = !isRealLive
          ? await spawnCodexL10ChildForTest({
              argv: [binPath, ...poleArgv.slice(1)],
              cwd: scratchRoot, childEnv, promptText: prompt,
              timeoutMs: poleTimeoutMs, cancelSignal: { cancelled: () => false },
            })
          : await spawnCodexL10Child({
              argv: [binPath, ...poleArgv.slice(1)],
              cwd: scratchRoot, childEnv, promptText: prompt,
              timeoutMs: poleTimeoutMs, cancelSignal: { cancelled: () => false },
            });
        result = { stdoutText: r.stdoutText, stderrText: r.stderrText, diagnostic: r.diagnostic, childPid: r.childPid };
      }
      settleTimeMs = Date.now();
    } catch (e: any) {
      settleTimeMs = Date.now();
      const code = e.code ?? (e.name === "EnvRefusedError" ? "ENV_REFUSED" : "ADAPTER_FAILURE");
      preSpawnRefusal = { code, message: e.message ?? String(e) };
    }

    if (preSpawnRefusal) {
      const endPacific = pacificNow();
      const isEnvRefused = preSpawnRefusal.code === "ENV_REFUSED";
      const staticReason = isEnvRefused
        ? `refused by spawn tripwire: §c refused names present in parent or child environment; zero dispatch`
        : `refused by pre-spawn gate (${preSpawnRefusal.message}); zero dispatch`;
      const postSpawnOffset = existsSync(ledgerPath) ? Buffer.byteLength(readFileSync(ledgerPath, "utf8"), "utf8") : 0;
      const noNewLedgerRows = postSpawnOffset === preSpawnOffset;
      const isClaudeMutant = (label === "MUTANT" || label === "MUTANT_GPT_SOL" || label === "MUTANT_NO_MODEL") && ROUTE === "claude";
      return {
        runId: RUN_ID, pole: label, slot: SLOT, slotEligible: true,
        route: ROUTE, requestedModel,
        wrapperDigest, configurationFingerprint, commandContractVersion: COMMAND_CONTRACT_VERSION,
        startPacific, endPacific, runAt: new Date().toISOString(),
        argvContract: poleArgv, childEnvNames: Object.keys(childEnv).sort(),
        status: preSpawnRefusal.code,
        classifiedCode: preSpawnRefusal.code,
        refusalReason: preSpawnRefusal.code,
        staticReason,
        exitCode: -1,
        stdoutBytes: 0, stdoutSha256: sha256(""),
        stderrBytes: 0, stderrSha256: sha256(""),
        stderrAuthRejection: false,
        actualModel: null,
        structuredUsageValid: false,
        ledgerWitness: {
          present: false, match: false, verdict: "ROUTE_WITNESS_MISSING",
          witnessSource,
          correlatedPid: null, lane: null, seat: null, req: null, eff: null,
        },
        firstLineStored: false, promptStored: false, promptSha256: promptSha, observedLiteralStored: false,
        observedMatchesExpected: false,
        verdict: ((isClaudeMutant && preSpawnRefusal.code === "MODEL_UNAVAILABLE" && noNewLedgerRows)
          || (label === "MUTANT" && isEnvRefused && process.env.EXPECT_ENV_REFUSED === "1"))
          ? "PASS"
          : "FAIL",
      };
    }

    if (label === "MUTANT" && ROUTE === "codex") {
      const endPacific = pacificNow();
      const normalized = normalizeCliEnvelope(result.stdoutText, { route: ROUTE });
      const hasValidEnvelope = normalized.ok && normalized.actualModel !== null;
      const AUTH_REJECTION_RE = /auth|log ?in|unauthori[sz]ed|401|credential/i;
      const stderrAuthRejection = AUTH_REJECTION_RE.test(result.stderrText ?? "");

      let hasAnswerEvents = false;
      for (const line of (result.stdoutText ?? "").split("\n").map((l) => l.trim()).filter(Boolean)) {
        try {
          const obj = JSON.parse(line);
          if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            if (typeof obj.model === "string" && obj.model.trim() !== "") hasAnswerEvents = true;
            if (obj.role === "assistant" || obj.item?.role === "assistant") hasAnswerEvents = true;
            if (
              obj.item &&
              typeof obj.item === "object" &&
              !Array.isArray(obj.item) &&
              (obj.item.type === "agent_message" ||
                (typeof obj.item.type === "string" && obj.item.type.includes("message")) ||
                obj.item.role === "assistant" ||
                (typeof obj.item.text === "string" && obj.item.text.trim() !== ""))
            ) {
              hasAnswerEvents = true;
            }
            if (typeof obj.type === "string" && (
              obj.type === "turn.completed" ||
              obj.type === "response.completed" ||
              obj.type === "response.done" ||
              obj.type.includes("assistant") ||
              obj.type.includes("message")
            )) {
              hasAnswerEvents = true;
            }
          }
        } catch {}
      }

      let mutantVerdict: "PASS" | "BLOCK" | "INCONCLUSIVE";
      let mutantStatus: string;
      let staticReason: string;

      if (result.diagnostic.exitCode === 0 || hasValidEnvelope || hasAnswerEvents) {
        mutantVerdict = "BLOCK";
        mutantStatus = "BLOCK";
        staticReason = "paid fallback detected in scratch HOME; route blocked";
      } else if (result.diagnostic.exitCode !== 0 && !hasValidEnvelope && !hasAnswerEvents && stderrAuthRejection) {
        mutantVerdict = "PASS";
        mutantStatus = "AUTH_BLOCKED";
        staticReason = "credentials rejected in scratch HOME; auth rejection pattern matched in stderr";
      } else {
        mutantVerdict = "INCONCLUSIVE";
        mutantStatus = "INCONCLUSIVE";
        staticReason = `unclassified exit code ${result.diagnostic.exitCode} without auth rejection pattern in stderr`;
      }

      return {
        runId: RUN_ID, pole: label, slot: SLOT, slotEligible: true,
        route: ROUTE, requestedModel: expectedLiteral,
        wrapperDigest, configurationFingerprint, commandContractVersion: COMMAND_CONTRACT_VERSION,
        startPacific, endPacific, runAt: new Date().toISOString(),
        argvContract: poleArgv, childEnvNames: Object.keys(childEnv).sort(),
        status: mutantStatus,
        staticReason,
        exitCode: result.diagnostic.exitCode,
        stdoutBytes: result.diagnostic.stdoutBytes, stdoutSha256: result.diagnostic.stdoutSha256,
        stderrBytes: result.diagnostic.stderrBytes, stderrSha256: result.diagnostic.stderrSha256,
        stderrAuthRejection,
        actualModel: normalized.ok ? normalized.actualModel : null,
        structuredUsageValid: false,
        ledgerWitness: {
          present: false, match: false, verdict: "NOT_APPLICABLE",
          witnessSource,
          correlatedPid: null, lane: null, seat: null, req: null, eff: null,
        },
        firstLineStored: false, promptStored: false, promptSha256: promptSha, observedLiteralStored: false,
        observedMatchesExpected: false,
        verdict: mutantVerdict,
      };
    }

    const diag = classifyExit(result.diagnostic.exitCode);
    if (diag.code === "USAGE_WALL" || diag.code === "AUTH_BLOCKED" || result.diagnostic.exitCode === 75 || result.diagnostic.exitCode === 76) {
      const endPacific = pacificNow();
      return {
        runId: RUN_ID, pole: label, slot: SLOT, slotEligible: true,
        route: ROUTE, requestedModel: expectedLiteral,
        wrapperDigest, configurationFingerprint, commandContractVersion: COMMAND_CONTRACT_VERSION,
        startPacific, endPacific, runAt: new Date().toISOString(),
        argvContract: poleArgv, childEnvNames: Object.keys(childEnv).sort(),
        status: diag.code === "OK" ? "COMPLETED" : diag.code,
        staticReason: diag.staticReason,
        exitCode: result.diagnostic.exitCode,
        stdoutBytes: result.diagnostic.stdoutBytes, stdoutSha256: result.diagnostic.stdoutSha256,
        stderrBytes: result.diagnostic.stderrBytes, stderrSha256: result.diagnostic.stderrSha256,
        stderrAuthRejection: false,
        actualModel: null,
        structuredUsageValid: false,
        ledgerWitness: {
          present: false, match: false, verdict: "ROUTE_WITNESS_MISSING",
          witnessSource,
          correlatedPid: null, lane: null, seat: null, req: null, eff: null,
        },
        firstLineStored: false, promptStored: false, promptSha256: promptSha, observedLiteralStored: false,
        observedMatchesExpected: false,
        verdict: "FAIL",
      };
    }

    const witness = (ROUTE === "claude")
      ? witnessFromOffset(ledgerPath, preSpawnOffset, result.childPid, expectedLiteral!, {
          launchTimeMs,
          settleTimeMs,
          allowFixtureTs: !USE_LIVE || !!options._forTest?.fixtureBin,
        })
      : {
          present: false,
          match: false,
          verdict: "NOT_APPLICABLE" as const,
          correlated: undefined,
        };

    const normalized = normalizeCliEnvelope(result.stdoutText, { route: ROUTE });
    const actualModel = normalized.ok ? normalized.actualModel : null;
    const observedMatchesExpected = actualModel === expectedLiteral!;
    const endPacific = pacificNow();

    const witnessPassed = ROUTE === "claude"
      ? (witness.verdict === "OK" && witness.present && witness.match && witness.correlated?.lane === "max" && getSeats().includes(witness.correlated?.seat as string))
      : true;

    const row = {
      runId: RUN_ID, pole: label, slot: SLOT, slotEligible: true,
      route: ROUTE, requestedModel: expectedLiteral,
      wrapperDigest, configurationFingerprint, commandContractVersion: COMMAND_CONTRACT_VERSION,
      startPacific, endPacific, runAt: new Date().toISOString(),
      argvContract: poleArgv, childEnvNames: Object.keys(childEnv).sort(),
      status: (label === "CONTROL" && ROUTE === "codex" && (actualModel === null || !normalized.ok))
        ? "INCONCLUSIVE"
        : (diag.code === "OK" ? "COMPLETED" : diag.code),
      staticReason: (label === "CONTROL" && ROUTE === "codex" && (actualModel === null || !normalized.ok))
        ? "no declared model field in codex jsonl stream; inconclusive"
        : diag.staticReason,
      exitCode: result.diagnostic.exitCode,
      stdoutBytes: result.diagnostic.stdoutBytes, stdoutSha256: result.diagnostic.stdoutSha256,
      stderrBytes: result.diagnostic.stderrBytes, stderrSha256: result.diagnostic.stderrSha256,
      stderrAuthRejection: false,
      actualModel,
      structuredUsageValid: normalized.ok && normalized.usage !== null
        && normalized.usage.promptTokens !== null && normalized.usage.completionTokens !== null,
      ledgerWitness: {
        present: witness.present, match: witness.match, verdict: witness.verdict,
        witnessSource,
        correlatedPid: witness.correlated?.pid ?? null,
        lane: witness.correlated?.lane ?? null,
        seat: witness.correlated?.seat ?? null,
        req: witness.correlated?.req ?? null,
        eff: witness.correlated?.eff ?? null,
      },
      firstLineStored: false, promptStored: false, promptSha256: promptSha, observedLiteralStored: false,
      observedMatchesExpected,
      verdict: (
        label === "CONTROL" && ROUTE === "codex" && (actualModel === null || !normalized.ok)
      ) ? "INCONCLUSIVE" : (
        label === "CONTROL" && diag.code === "OK" && witnessPassed && observedMatchesExpected
      ) ? "PASS" : (
        label === "CONTROL" && !observedMatchesExpected
      ) ? "FAIL" : (
        label === "MUTANT" && !observedMatchesExpected && witness.verdict === "ROUTE_WITNESS_MISMATCH"
      ) ? "PASS" : "FAIL",
    };
    return row;
  }

  const controlRow = await runPole("CONTROL", controlBin);
  const mutantRow = await runPole("MUTANT", mutantBin);
  let mutantGptSolRow: any = null;
  let mutantNoModelRow: any = null;
  if (USE_LIVE && ROUTE === "claude") {
    mutantGptSolRow = await runPole("MUTANT_GPT_SOL", mutantBin);
    mutantNoModelRow = await runPole("MUTANT_NO_MODEL", mutantBin);
  }

  const poles = [
    controlRow,
    mutantRow,
    ...(mutantGptSolRow ? [mutantGptSolRow] : []),
    ...(mutantNoModelRow ? [mutantNoModelRow] : []),
  ];
  const rep = { runId: RUN_ID, slot: SLOT, live: isRealLive, scratchHome, poles };
  writeFileSync(join(scratchRoot, "report.json"), JSON.stringify(rep, null, 2) + "\n", "utf8");

  console.log(`runId=${RUN_ID} slot=${SLOT} slotEligible=${slotOk}`);
  for (const r of rep.poles) {
    console.log(`pole=${r.pole} verdict=${r.verdict} exit=${r.exitCode} status=${r.status} ledgerWS=${r.ledgerWitness.verdict} matched=${r.observedMatchesExpected}`);
  }
  const allPassed = rep.poles.every((p) => p.verdict === "PASS");
  return exit(allPassed ? 0 : 1, rep);
}

export async function runTwoPoleForTest(options: TwoPoleRunOptions): Promise<{ report: any; exitCode: number }> {
  return runTwoPole(options);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runTwoPole().then(({ exitCode }) => {
    process.exit(exitCode);
  }).catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  });
}
