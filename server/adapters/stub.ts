/**
 * L2 adapter layer — stub adapter (deterministic, offline, fixture-driven).
 *
 * Selected ONLY by explicit config (design §5) — never by default, never
 * auto-detected. No randomness, no clock dependence, no network, no filesystem
 * outside the fixture path.
 *
 * Fixture keying (design §8 + the design review's advisory A1): fixtures carry separate entries
 * for probe vs stage prompts per slot. Probe prompts are detected by the literal
 * prefix "Model transport health check only" (server/cohort.ts:130). Stage prompts
 * are keyed by the stage name embedded in the prompt. Unknown prompts fall through
 * to a fixed, clearly-labeled default body.
 *
 * The 64 KB stdout cap (server/cohort.ts:188) becomes an adapter contract item:
 * each adapter enforces its own cap and fails with TRANSPORT_ERROR on overflow.
 *
 */
import { readFileSync, existsSync } from "node:fs";
import { AdapterFailure, type AdapterRequest, type AdapterResult, type AdapterResultTyped, type ModelAdapter } from "./types";

type FixtureEntry = { text: string } | { error: { code: string; message: string; transportStatus: string | null; retryable: boolean } };
type SlotFixtures = {
  probe?: FixtureEntry;
  stages?: Record<string, FixtureEntry>;
  default?: FixtureEntry;
};
type StubFixtureFile = {
  version: number;
  slots: Record<string, SlotFixtures>;
  defaultProbe: FixtureEntry;
  defaultStage: FixtureEntry;
};

const PROBE_PREFIX = "Model transport health check only";

function isFixtureError(entry: FixtureEntry): entry is { error: { code: string; message: string; transportStatus: string | null; retryable: boolean } } {
  return "error" in entry;
}

export class StubAdapter implements ModelAdapter {
  readonly name = "stub";
  readonly makesLiveCalls = false;

  private fixtures: StubFixtureFile | null = null;

  private loadFixtures(path: string): StubFixtureFile {
    if (this.fixtures) return this.fixtures;
    if (!existsSync(path)) {
      throw new AdapterFailure(
        "MODEL_UNAVAILABLE",
        `stub fixture file not found: ${path}`,
        null,
        false,
      );
    }
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as StubFixtureFile;
    if (parsed.version !== 1) {
      throw new AdapterFailure(
        "TRANSPORT_ERROR",
        `stub fixture version ${parsed.version} unsupported`,
        null,
        false,
      );
    }
    this.fixtures = parsed;
    return parsed;
  }

  private pickEntry(req: AdapterRequest, fixtures: StubFixtureFile): FixtureEntry {
    const slot = fixtures.slots[req.slotId];
    if (!slot) {
      return req.prompt.startsWith(PROBE_PREFIX) ? fixtures.defaultProbe : fixtures.defaultStage;
    }
    if (req.prompt.startsWith(PROBE_PREFIX)) {
      return slot.probe ?? fixtures.defaultProbe;
    }
    // Stage prompt: extract the stage name from the prompt (design §8).
    const stageMatch = req.prompt.match(/Current phase: (\w+)/);
    const stageName = stageMatch?.[1];
    if (stageName && slot.stages?.[stageName]) {
      return slot.stages[stageName];
    }
    return slot.default ?? fixtures.defaultStage;
  }

  async call(req: AdapterRequest): Promise<AdapterResultTyped> {
    const fixturePath = process.env.AGENT_COMMONS_STUB_FIXTURES ?? "server/adapters/fixtures/stub-turns.json";
    const fixtures = this.loadFixtures(fixturePath);
    const entry = this.pickEntry(req, fixtures);
    if (isFixtureError(entry)) {
      const e = entry.error;
      throw new AdapterFailure(e.code, e.message, e.transportStatus, e.retryable);
    }
    const text = entry.text;
    if (text.length > 64000) {
      throw new AdapterFailure("TRANSPORT_ERROR", "Output budget exceeded", null, false);
    }
    return { kind: "offline", text };
  }
}
