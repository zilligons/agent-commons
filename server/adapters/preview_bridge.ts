/**
 * L2 adapter layer — preview-bridge adapter (the default path, unchanged).
 *
 * Wraps today's `python server/cohort_bridge.py` child-process spawn verbatim.
 * On the default path (no config, no AGENT_COMMONS_ADAPTER) `callForSlot`
 * delegates to this adapter, so behavior is byte-for-byte identical to the
 * previous `CohortConsole.call` implementation:
 *   - same spawn, same stdio JSON protocol, same 64 KB stdout cap,
 *   - same timeout timer, same generation/cancellation poll,
 *   - same error mapping into AdapterFailure.
 *
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterFailure, type AdapterRequest, type AdapterResult, type AdapterResultTyped, type ModelAdapter } from "./types";
import { buildChildEnv, assertSpawnTripwire } from "./l10-env";
import { PYTHON_ABS } from "./l10-process";
import { isBlockedSlotOrModel } from "./l10-routes";
import { assertLiveAccountingGate } from "./l10-limits";

export class PreviewBridgeAdapter implements ModelAdapter {
  readonly name = "preview-bridge";
  readonly makesLiveCalls = true;

  call(req: AdapterRequest): Promise<AdapterResultTyped> {
    return new Promise((resolve, reject) => {
      if (!req.runtimeModel || typeof req.runtimeModel !== "string" || req.runtimeModel.trim() === "") {
        reject(new AdapterFailure("MODEL_UNAVAILABLE", "missing model literal", null, false));
        return;
      }
      // R3: direct legacy entry must enforce eligibility policy before transport selection or spawn.
      if (
        isBlockedSlotOrModel(req.slotId) ||
        isBlockedSlotOrModel(req.historicalModel) ||
        isBlockedSlotOrModel(req.runtimeModel)
      ) {
        reject(new AdapterFailure(
          "MODEL_UNAVAILABLE",
          `slot or model ${req.slotId || req.runtimeModel} is blocked; L10 does not dispatch it (zero-dispatch gate)`,
          null,
          false,
        ));
        return;
      }
      // R3 (rework 3): preview-bridge is a live path; offline blocks it.
      if (process.env.AGENT_COMMONS_OFFLINE === "1") {
        reject(new AdapterFailure("MODEL_UNAVAILABLE","preview-bridge makes live calls; AGENT_COMMONS_OFFLINE=1 blocks it",null,false));
        return;
      }
      try {
        assertLiveAccountingGate();
      } catch (e) {
        reject(e);
        return;
      }
      // L10 seam delta: closed child env (v3 §b/§c). The Python bridge
      // gets the same closed allowlist as the L10 live CLIs. The `model`
      // is the runtimeModel resolved by the seam; nothing else from the
      // parent reaches the child.
      // B2 (rework 1): spawn the interpreter by its FROZEN ABSOLUTE path —
      // the closed child PATH contains no `python` (the security reviewer measured ENOENT).
      if (!PYTHON_ABS) {
        reject(new AdapterFailure("MODEL_UNAVAILABLE","python interpreter not resolvable to an absolute path",null,false));
        return;
      }
      // D2 (rework 2) + R1 (rework 3): tripwire on parent + constructed child.
      assertSpawnTripwire();
      const runDir = join(tmpdir(), `agentc-l10-bridge-${req.runId}`);
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      const cleanupRunDir = () => {
        try { rmSync(runDir, { recursive: true, force: true }); } catch {}
      };
      const childEnv = buildChildEnv({
        route: "claude",
        runId: req.runId,
        home: "/tmp/l10-preview-home",
        runDir,
      });
      assertSpawnTripwire({ ...(childEnv as Record<string, string>) }, "child");
      const child = spawn(PYTHON_ABS, ["server/cohort_bridge.py"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...childEnv },
        detached: true,
      });
      let output = "";
      const timer = setTimeout(() => {
        cleanupRunDir();
        child.kill("SIGKILL");
        reject(new AdapterFailure("TIMEOUT", "Turn time budget reached", null, true));
      }, req.timeoutMs);
      const cancellation = setInterval(() => {
        if (req.signal.cancelled()) {
          cleanupRunDir();
          child.kill("SIGKILL");
          reject(new Error("Cancelled"));
        }
      }, 200);
      child.stdout.on("data", (d: Buffer) => {
        output += d;
        if (output.length > 64000) {
          cleanupRunDir();
          child.kill("SIGKILL");
          reject(new AdapterFailure("TRANSPORT_ERROR", "Output budget exceeded", null, false));
        }
      });
      child.stderr.resume();
      child.on("error", (e: Error) => {
        clearTimeout(timer);
        clearInterval(cancellation);
        cleanupRunDir();
        reject(e);
      });
      child.on("close", () => {
        clearTimeout(timer);
        clearInterval(cancellation);
        cleanupRunDir();
        try {
          const obj = JSON.parse(output);
          if (obj.error || !obj.text) {
            reject(
              new AdapterFailure(
                obj.code ?? "TRANSPORT_ERROR",
                obj.message ?? obj.error ?? "No text",
                obj.transportStatus ?? null,
                obj.retryable === true,
              ),
            );
          } else {
            resolve({ kind: "offline", text: obj.text });
          }
        } catch {
          reject(new AdapterFailure("INVALID_RESPONSE", "Invalid adapter response", null, false));
        }
      });
      child.stdin.end(JSON.stringify({ model: req.runtimeModel, prompt: req.prompt }));
    });
  }
}
