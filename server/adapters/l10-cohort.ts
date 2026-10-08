/**
 * L10 C1 — cohort adapter `l10-cli`.
 *
 * Implements the live cohort adapter behind the accounting gate (inert).
 * Dispatches eligible cohort slots (continuity, collaboration, security, governance)
 * to their respective frozen CLI binaries using closed child environments, stdin prompts,
 * ledger witness verification, and structured envelope normalization.
 *
 * The model ledger path is read from getResolvedL10Binaries().modelLedger
 * (frozen at startup, brief rev 2 item P). When the path is unconfigured or
 * invalid, the witness check is skipped (NOT_EVALUATED) and the route still
 * succeeds — the witness is not part of the success contract when the
 * ledger is unconfigured.
 */
import { existsSync, statSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir, homedir, userInfo } from "node:os";
import {
  AdapterFailure,
  type AdapterRequest,
  type AdapterResultLive,
  type AdapterMetrics,
  type ModelAdapter,
} from "./types";
import { assertL10TrialEnabled, consumeL10TrialTurn } from "./l10-limits";
import {
  assertSlotEligibleForL10,
  buildL10Argv,
  L10_FROZEN_LITERALS,
} from "./l10-routes";
import { buildChildEnv, assertSpawnTripwire } from "./l10-env";
import {
  spawnClaudeL10Child,
  spawnClaudeL10ChildForTest,
  spawnCodexL10Child,
  spawnCodexL10ChildForTest,
  L10PermitPool,
  sharedClaudePermitPool,
  L10_CLAUDE_PERMIT_DIR,
  isSharedClaudePermitDir,
  L10_CLAUDE_USAGE_WALL_EXIT,
  L10_CLAUDE_AUTH_BLOCKED_EXIT,
} from "./l10-process";
import { witnessFromOffset, normalizeCliEnvelope } from "./l10-witness";
import { getResolvedL10Binaries, getClaudeRouteResolution } from "./config";

export interface L10CliTestKnobs {
  fixtureBin?: string;
  fixtureLedgerPath?: string;
  skipAccountingGate?: boolean;
  permitPool?: L10PermitPool;
}

export class L10CliAdapter implements ModelAdapter {
  readonly name = "l10-cli";
  readonly makesLiveCalls = true;

  async call(req: AdapterRequest): Promise<AdapterResultLive> {
    return callL10CliInternal(req, undefined);
  }
}

export async function callL10CliForTest(
  req: AdapterRequest,
  testKnobs?: L10CliTestKnobs,
): Promise<AdapterResultLive> {
  return callL10CliInternal(req, testKnobs);
}

async function callL10CliInternal(
  req: AdapterRequest,
  testKnobs?: L10CliTestKnobs,
): Promise<AdapterResultLive> {
  // 1. assertL10TrialEnabled() first (inert when unset)
  if (!testKnobs?.skipAccountingGate) {
    assertL10TrialEnabled();
  }

  // 2. assertSlotEligibleForL10(req.slotId). Terra/Prism and unknown slots refused with MODEL_UNAVAILABLE
  assertSlotEligibleForL10(req.slotId);

  // 3. Ignore req.runtimeModel for the model choice.
  // The model comes ONLY from L10_FROZEN_LITERALS[slotId].
  // If req.runtimeModel differs from the frozen literal, refuse with MODEL_UNAVAILABLE.
  const frozenLiteral = L10_FROZEN_LITERALS[req.slotId as keyof typeof L10_FROZEN_LITERALS];
  if (!frozenLiteral) {
    throw new AdapterFailure("MODEL_UNAVAILABLE", `no frozen literal for slot: ${req.slotId}`, null, false);
  }
  if (req.runtimeModel && req.runtimeModel !== frozenLiteral) {
    throw new AdapterFailure(
      "MODEL_UNAVAILABLE",
      `runtimeModel "${req.runtimeModel}" differs from frozen literal "${frozenLiteral}" for slot "${req.slotId}"`,
      null,
      false,
    );
  }

  // 4. Route by slot:
  // - release (Grok): refuse with MODEL_UNAVAILABLE (zero dispatch)
  if (req.slotId === "release") {
    throw new AdapterFailure(
      "MODEL_UNAVAILABLE",
      "grok route blocked until its prompt/stdin precedence is established",
      null,
      false,
    );
  }

  const isClaude = req.slotId === "continuity" || req.slotId === "collaboration" || req.slotId === "security";
  const isCodex = req.slotId === "governance";
  if (!isClaude && !isCodex) {
    throw new AdapterFailure("MODEL_UNAVAILABLE", `unsupported route for slot "${req.slotId}"`, null, false);
  }
  const route: "claude" | "codex" = isClaude ? "claude" : "codex";

  // Brief rev 4 R2: the Claude live route is ENABLED only when the CLI
  // binary, the model ledger, and the witness seats all resolve. Any
  // one missing (unset / disabled for a reason) DISABLES the Claude
  // route with a static reason, decided at startup like the binaries.
  // The test entry can still proceed via the fixture paths below; the
  // test-supplied fixtureLedgerPath / fixtureBin override the configured
  // values, so a test can run with the route "disabled" in the resolver.
  if (route === "claude" && !testKnobs?.fixtureBin) {
    const routeR = getClaudeRouteResolution();
    if (routeR.status !== "enabled") {
      throw new AdapterFailure("MODEL_UNAVAILABLE", `claude route disabled at startup: ${routeR.reason}`, null, false);
    }
  }

  if (!/^[A-Za-z0-9._-]{1,128}$/.test(req.runId)) {
    throw new AdapterFailure("INVALID_REQUEST", `invalid runId charset or length: "${req.runId}"`, null, false);
  }
  const resolvedTmp = resolve(tmpdir());
  const runDir = resolve(join(resolvedTmp, `agentc-l10-cli-${req.runId}`));
  if (dirname(runDir) !== resolvedTmp) {
    throw new AdapterFailure("SECURITY_VIOLATION", `runDir "${runDir}" must sit directly under tmpdir "${resolvedTmp}"`, null, false);
  }
  mkdirSync(runDir, { recursive: true, mode: 0o700 });

  let spawnRes: {
    stdoutText: string;
    stderrText: string;
    diagnostic: { exitCode: number; stdoutBytes: number; stdoutSha256: string; stderrBytes: number; stderrSha256: string };
    childPid: number;
  };

  const launchTimeMs = Date.now();
  let settleTimeMs = 0;

  // Ledger path: testKnobs.fixtureLedgerPath (test entry) OR the frozen
  // configured value (production). When the resolved value is null
  // (unconfigured / invalid), the ledger check is skipped (NOT_EVALUATED).
  const configuredLedger = getResolvedL10Binaries().modelLedger;
  const ledgerPath: string = testKnobs?.fixtureLedgerPath
    ?? (configuredLedger.status === "enabled" ? configuredLedger.path : "");
  let preSpawnOffset = 0;

  try {
    // Build frozen argv
    let argv = buildL10Argv({ slotId: req.slotId, cwd: runDir, stdinPath: "-" });
    if (testKnobs?.fixtureBin) {
      argv = [testKnobs.fixtureBin, ...argv.slice(1)];
    }

    // HOME: os.userInfo().homedir (the real account's home, independent of
    // $HOME). os.homedir() can be set by the parent env; userInfo is stable.
    const childHome = (route === "claude" || route === "codex")
      ? userInfo().homedir
      : homedir();
    const childEnv = buildChildEnv({
      route,
      runId: req.runId,
      home: childHome,
      runDir,
    });
    assertSpawnTripwire({ ...(childEnv as Record<string, string>) }, "child");

    // 5. Pre-spawn ledger offset for Claude per-spawn witness
    if (route === "claude" && ledgerPath !== "") {
      try {
        if (existsSync(ledgerPath)) {
          preSpawnOffset = statSync(ledgerPath).size;
        }
      } catch {}
    }

    if (!testKnobs?.skipAccountingGate) {
      consumeL10TrialTurn(req.slotId);
    }
    if (route === "claude") {
      if (testKnobs !== undefined) {
        if (!testKnobs.permitPool || isSharedClaudePermitDir(testKnobs.permitPool.poolDir)) {
          throw new AdapterFailure("SECURITY_VIOLATION", "test entry call requires private permitPool; using the shared pool in tests is prohibited", null, false);
        }
      }
      spawnRes = testKnobs?.fixtureBin
        ? await spawnClaudeL10ChildForTest({
            argv: [testKnobs.fixtureBin, ...argv.slice(1)],
            cwd: runDir,
            childEnv,
            promptText: req.prompt,
            timeoutMs: req.timeoutMs,
            cancelSignal: req.signal,
            runId: req.runId,
            permitPool: testKnobs.permitPool,
          })
        : await spawnClaudeL10Child({
            argv,
            cwd: runDir,
            childEnv,
            promptText: req.prompt,
            timeoutMs: req.timeoutMs,
            cancelSignal: req.signal,
            runId: req.runId,
            permitPool: testKnobs?.permitPool ?? sharedClaudePermitPool,
          });
    } else {
      // Codex
      spawnRes = testKnobs?.fixtureBin
        ? await spawnCodexL10ChildForTest({
            argv: [testKnobs.fixtureBin, ...argv.slice(1)],
            cwd: runDir,
            childEnv,
            promptText: req.prompt,
            timeoutMs: req.timeoutMs,
            cancelSignal: req.signal,
          })
        : await spawnCodexL10Child({
            argv,
            cwd: runDir,
            childEnv,
            promptText: req.prompt,
            timeoutMs: req.timeoutMs,
            cancelSignal: req.signal,
          });
    }
  } finally {
    settleTimeMs = Date.now();
    try {
      if (dirname(resolve(runDir)) === resolvedTmp) {
        rmSync(runDir, { recursive: true, force: true });
      }
    } catch {}
  }

  // 7. Exit 75 -> USAGE_WALL, Exit 76 -> AUTH_BLOCKED; terminal, never retried
  if (spawnRes.diagnostic.exitCode === L10_CLAUDE_USAGE_WALL_EXIT) {
    throw new AdapterFailure("USAGE_WALL", "claude usage wall (exit 75); terminal", null, false);
  }
  if (spawnRes.diagnostic.exitCode === L10_CLAUDE_AUTH_BLOCKED_EXIT) {
    throw new AdapterFailure("AUTH_BLOCKED", "claude auth blocked (exit 76); terminal", null, false);
  }
  if (spawnRes.diagnostic.exitCode !== 0) {
    throw new AdapterFailure("TRANSPORT_ERROR", `Process exited with code ${spawnRes.diagnostic.exitCode}`, null, false);
  }

  // 5. Claude per-spawn witness: require row with lane:"max" and a seat in
  // the configured AGENT_COMMONS_WITNESS_SEATS list. Brief rev 4 R2: the
  // witness fails closed — any verdict other than OK throws
  // ROUTE_WITNESS_MISSING (a corrupted ledger line, an empty ledger, a
  // missing ledger all return ROUTE_WITNESS_MISSING; NO path lets a
  // Claude live run succeed without a witness). The seat check is
  // already inside witnessFromOffset via the configured seats.
  if (route === "claude") {
    const witness = witnessFromOffset(
      ledgerPath,
      preSpawnOffset,
      spawnRes.childPid,
      frozenLiteral,
      { launchTimeMs, settleTimeMs, allowFixtureTs: testKnobs !== undefined },
    );
    if (witness.verdict !== "OK" || !witness.present || !witness.match) {
      throw new AdapterFailure("ROUTE_WITNESS_MISSING", "Claude route witness missing or invalid in ledger", null, false);
    }
  }

  // 6. Envelope: normalizeCliEnvelope; actualModel must equal frozen literal
  const normalized = normalizeCliEnvelope(spawnRes.stdoutText, { route });
  if (!normalized.ok) {
    throw new AdapterFailure(normalized.code, normalized.reason, null, false);
  }
  if (normalized.actualModel !== frozenLiteral) {
    throw new AdapterFailure(
      "MODEL_MISMATCH",
      `actualModel "${normalized.actualModel}" does not match frozen literal "${frozenLiteral}"`,
      null,
      false,
    );
  }

  let text = "";
  if (route === "codex") {
    for (const line of spawnRes.stdoutText.split("\n").map((l) => l.trim()).filter(Boolean)) {
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          const item = (obj as Record<string, unknown>).item;
          if (
            item &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            typeof (item as Record<string, unknown>).text === "string" &&
            ((item as Record<string, unknown>).type === "agent_message" || !(item as Record<string, unknown>).type)
          ) {
            text = (item as Record<string, unknown>).text as string;
          } else if (typeof (obj as Record<string, unknown>).text === "string") {
            text = (obj as Record<string, unknown>).text as string;
          } else if (typeof (obj as Record<string, unknown>).result === "string") {
            text = (obj as Record<string, unknown>).result as string;
          } else if (typeof (obj as Record<string, unknown>).content === "string") {
            text = (obj as Record<string, unknown>).content as string;
          }
        }
      } catch {}
    }
  } else {
    try {
      const parsed = JSON.parse(spawnRes.stdoutText);
      if (typeof parsed?.text === "string") {
        text = parsed.text;
      } else if (typeof parsed?.result === "string") {
        text = parsed.result;
      } else if (typeof parsed?.content === "string") {
        text = parsed.content;
      }
    } catch {}
  }

  const metrics: AdapterMetrics = {
    exitCode: spawnRes.diagnostic.exitCode,
    stdoutBytes: spawnRes.diagnostic.stdoutBytes,
    stdoutSha256: spawnRes.diagnostic.stdoutSha256,
    stderrBytes: spawnRes.diagnostic.stderrBytes,
    stderrSha256: spawnRes.diagnostic.stderrSha256,
  };

  return {
    kind: "live",
    text,
    actualModel: normalized.actualModel,
    modelEvidence: normalized.modelEvidence,
    usage: normalized.usage,
    metrics,
  };
}
