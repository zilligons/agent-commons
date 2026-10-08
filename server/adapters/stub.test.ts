/**
 * L2 adapter layer — stub adapter tests (offline, all RUN).
 *
 * Verifies (per design §8 + §10 test 2):
 * - probe prompt per slot returns the probe fixture text
 * - stage prompt per slot returns the stage fixture text (keyed by stage name)
 * - unknown prompt → default body
 * - scripted failure throws AdapterFailure with the exact error shape
 * - 64 KB output cap enforced
 *
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterFailure, StubAdapter } from "./index";

const FIXTURE = {
  version: 1,
  slots: {
    governance: {
      probe: { error: { code: "ACCESS_DENIED", message: "Permission denied", transportStatus: "PERMISSION_DENIED", retryable: false } },
      stages: {
        needs: { text: "{\"body\":\"governance needs fixture\",\"nextTask\":\"x\",\"evidenceRequired\":\"y\"}" },
      },
      default: { text: "{\"body\":\"governance default\",\"nextTask\":\"x\",\"evidenceRequired\":\"y\"}" },
    },
    continuity: {
      probe: { text: "OK" },
      stages: {
        plan: { text: "{\"body\":\"continuity plan fixture\",\"nextTask\":\"x\",\"evidenceRequired\":\"y\"}" },
      },
    },
  },
  defaultProbe: { text: "default-probe-text" },
  defaultStage: { text: "{\"body\":\"default stage\",\"nextTask\":\"x\",\"evidenceRequired\":\"y\"}" },
};

const PROBE_PROMPT = "Model transport health check only. Return the word OK. No task, tool use or external action is requested.";
const STAGE_PROMPT = (stage: string) => `You are Mneme. Current phase: ${stage}. ...`;
const UNKNOWN_STAGE_PROMPT = (stage: string) => `You are Nexus. Current phase: ${stage}. ...`;

const tmpdirs: string[] = [];

function makeFixture(content: object): string {
  const dir = mkdtempSync(join(tmpdir(), "stub-fixture-"));
  const path = join(dir, "fixture.json");
  writeFileSync(path, JSON.stringify(content), "utf8");
  tmpdirs.push(dir);
  return path;
}

async function main() {
  // 1. probe prompt per slot returns the slot's probe fixture
  const fixturePath = makeFixture(FIXTURE);
  process.env.AGENT_COMMONS_STUB_FIXTURES = fixturePath;
  try {
    const stub = new StubAdapter();
    const continuityProbe = await stub.call({
      slotId: "continuity", historicalModel: "claude_fable_5_1", runtimeModel: "claude_fable_5_1",
      prompt: PROBE_PROMPT, timeoutMs: 1000, signal: { cancelled: () => false },
    });
    assert.equal(continuityProbe.text, "OK", "continuity probe should return OK");

    // 2. stage prompt per slot returns the stage fixture
    const continuityPlan = await stub.call({
      slotId: "continuity", historicalModel: "claude_fable_5_1", runtimeModel: "claude_fable_5_1",
      prompt: STAGE_PROMPT("plan"), timeoutMs: 1000, signal: { cancelled: () => false },
    });
    assert.equal(
      continuityPlan.text,
      "{\"body\":\"continuity plan fixture\",\"nextTask\":\"x\",\"evidenceRequired\":\"y\"}",
      "continuity plan should match fixture",
    );

    // 3. unknown stage falls through to global default stage
    const continuityUnknown = await stub.call({
      slotId: "continuity", historicalModel: "claude_fable_5_1", runtimeModel: "claude_fable_5_1",
      prompt: UNKNOWN_STAGE_PROMPT("needs"), timeoutMs: 1000, signal: { cancelled: () => false },
    });
    assert.equal(
      continuityUnknown.text,
      "{\"body\":\"default stage\",\"nextTask\":\"x\",\"evidenceRequired\":\"y\"}",
      "unknown stage should fall through to default stage",
    );

    // 4. unknown slot falls through to global default probe
    const integrationProbe = await stub.call({
      slotId: "integration", historicalModel: "gemini_3_8_flash", runtimeModel: "gemini_3_8_flash",
      prompt: PROBE_PROMPT, timeoutMs: 1000, signal: { cancelled: () => false },
    });
    assert.equal(integrationProbe.text, "default-probe-text", "unknown slot probe should use defaultProbe");

    // 5. scripted failure throws AdapterFailure with the exact shape
    await assert.rejects(
      stub.call({
        slotId: "governance", historicalModel: "gpt_6_1_sol", runtimeModel: "gpt_6_1_sol",
        prompt: PROBE_PROMPT, timeoutMs: 1000, signal: { cancelled: () => false },
      }),
      (e: unknown) => {
        if (!(e instanceof AdapterFailure)) return false;
        return e.code === "ACCESS_DENIED" && e.message === "Permission denied"
          && e.transportStatus === "PERMISSION_DENIED" && e.retryable === false;
      },
      "scripted failure must throw AdapterFailure with exact shape",
    );
  } finally {
    delete process.env.AGENT_COMMONS_STUB_FIXTURES;
  }

  // 6. 64 KB output cap enforced
  const oversizedPath = makeFixture({
    version: 1, slots: {},
    defaultProbe: { text: "x".repeat(64001) },
    defaultStage: { text: "x".repeat(64001) },
  });
  process.env.AGENT_COMMONS_STUB_FIXTURES = oversizedPath;
  try {
    const oversizeStub = new StubAdapter();
    await assert.rejects(
      oversizeStub.call({
        slotId: "continuity", historicalModel: "x", runtimeModel: "x",
        prompt: PROBE_PROMPT, timeoutMs: 1000, signal: { cancelled: () => false },
      }),
      (e: unknown) => e instanceof AdapterFailure && e.code === "TRANSPORT_ERROR" && /Output budget/.test(e.message),
      "oversized output must fail with TRANSPORT_ERROR",
    );
  } finally {
    delete process.env.AGENT_COMMONS_STUB_FIXTURES;
  }

  console.log("PASS: probe/stage/default buckets, scripted failure shape, 64 KB cap.");
}

main().finally(() => {
  for (const dir of tmpdirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
