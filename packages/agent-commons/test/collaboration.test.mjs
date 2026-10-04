import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CollaborationScheduler, createCollaboration, createRoster, rosterFromModels, createContinuity, createMemoryPersistence, createFilePersistence, memoryFromContinuity,
  normalizePlan, readyTasks, validateProposal, parseModelOutput, DEFAULT_ROSTER, ROSTER_SIZE, CollaborationError,
  validateUnifiedDiff, validatePatchPath, normalizeAllowedPaths, chargeUsage, hmacIntegrity, validateRunState, NOOP_MEMORY,
} from "../src/collaboration.mjs";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

/** Deterministic host verifier double (stands in for a sandboxed host check). */
const HOST = Object.freeze({ verifier: { async verify() { return { passed: true, findings: [] }; } } });

const NEEDS = { objective: "Add greeting", acceptanceCriteria: "greet() returns hi", allowedPaths: ["src", "test"] };
const PLAN = { tasks: [
  { id: "core", title: "Implement greet", description: "src/greet.mjs" },
  { id: "tests", title: "Test greet", dependsOn: ["core"] },
] };
const patchFor = taskId => ({ summary: `patch ${taskId}`, patches: [{ path: `src/${taskId}.mjs`, op: "create", content: `export const ${taskId} = 1;\n` }] });

/** Scripted, provider-neutral fake adapter. `script[phase](request)` returns output; default is happy path. */
function fakeModel(script = {}) {
  const calls = [];
  let active = 0, maxActive = 0;
  const model = {
    calls, get maxActive() { return maxActive; },
    async complete(request) {
      calls.push({ phase: request.phase, slot: request.slot.id, taskId: request.input?.task?.id, key: request.idempotencyKey, request });
      active++; maxActive = Math.max(maxActive, active);
      try {
        if (script.delay) await new Promise(r => setTimeout(r, script.delay));
        const handler = script[request.phase];
        const out = handler ? await handler(request, calls) : defaults[request.phase](request);
        if (out && out.__raw) return out.__raw;
        return { content: JSON.stringify(out), usage: { inputTokens: 10, outputTokens: 5 } };
      } finally { active--; }
    },
  };
  return model;
}
const defaults = {
  needs: () => ({ questions: [{ id: "styleGuide", question: "Which style guide?", required: false }] }),
  plan: () => PLAN,
  build: r => patchFor(r.input.task.id),
  test: () => ({ passed: true, findings: [] }),
  review: () => ({ verdict: "approve", comments: [] }),
};
const make = (opts = {}) => new CollaborationScheduler({ ...HOST, model: fakeModel(), ...opts });

test("default roster has seven configurable slots covering every role", () => {
  assert.equal(DEFAULT_ROSTER.length, ROSTER_SIZE);
  const custom = createRoster({ "builder-c": { role: "reviewer", model: "m-7" } });
  assert.equal(custom.find(s => s.id === "builder-c").role, "reviewer");
  assert.throws(() => createRoster(DEFAULT_ROSTER.slice(0, 6)), /exactly 7/);
  assert.throws(() => createRoster(DEFAULT_ROSTER.map(s => ({ ...s, role: s.role === "tester" ? "builder" : s.role }))), /missing a tester/);
  assert.throws(() => createRoster({ nope: {} }), /Unknown roster slot/);
  const bound = rosterFromModels(["m1", "m2", "m3", "m4", "m5", "m6", "m7"]);
  assert.deepEqual(bound.map(s => s.model), ["m1", "m2", "m3", "m4", "m5", "m6", "m7"]);
  assert.throws(() => rosterFromModels(["m1"]), /Expected 7/);
  assert.throws(() => new CollaborationScheduler({}), /model adapter/);
  assert.throws(() => make({ limits: { maxRounds: 0 } }), /positive integer/);
});

test("asks operational needs first and pauses until required needs are answered", async () => {
  const model = fakeModel();
  const persistence = createMemoryPersistence();
  const s = new CollaborationScheduler({ ...HOST, model, persistence });
  const first = await s.run({ runId: "r1", goal: "Add greeting" });
  assert.equal(first.status, "awaiting-needs");
  assert.deepEqual(first.questions.map(q => q.id).sort(), ["acceptanceCriteria", "allowedPaths", "objective"]);
  assert.deepEqual(model.calls.map(c => c.phase), ["needs"]);
  await s.provideNeeds("r1", NEEDS);
  const done = await s.run({ runId: "r1" });
  assert.equal(done.status, "completed");
  assert.equal(model.calls.filter(c => c.phase === "needs").length, 1, "needs questions are not re-asked");
});

test("needs provider is consulted before planning", async () => {
  const order = [];
  const model = fakeModel({ plan: () => { order.push("plan"); return PLAN; } });
  const s = new CollaborationScheduler({ ...HOST, model, needs: { async ask({ missing }) { order.push(`ask:${missing.length}`); return NEEDS; } } });
  const result = await s.run({ runId: "r2", goal: "Add greeting" });
  assert.equal(result.status, "completed");
  assert.deepEqual(order, ["ask:3", "plan"]);
  assert.equal(model.calls[0].phase, "needs");
});

test("plan/build/test/peer-review cycle respects dependencies and yields patch artifacts", async () => {
  const model = fakeModel();
  const sink = [];
  const s = new CollaborationScheduler({ ...HOST, model, artifacts: { async put(a) { sink.push(a) } } });
  const result = await s.run({ runId: "r3", goal: "Add greeting", needs: NEEDS });
  assert.equal(result.status, "completed");
  assert.equal(result.rounds, 2, "dependent task waits for its dependency");
  const builds = model.calls.filter(c => c.phase === "build");
  assert.deepEqual(builds.map(c => c.taskId), ["core", "tests"]);
  assert.deepEqual(builds[1].request.input.dependencies[0].approved[0].paths, ["src/core.mjs"]);
  const reviews = model.calls.filter(c => c.phase === "review" && c.taskId === "core");
  assert.equal(reviews.length, 2, "reviewer plus a peer builder");
  const author = result.tasks.find(t => t.id === "core").assignee;
  assert.ok(!reviews.some(r => r.slot === author), "author never reviews own proposal");
  assert.equal(result.artifacts.length, 2);
  assert.equal(result.artifacts[0].kind, "patch-proposal");
  assert.equal(sink.length, 2);
  for (const c of model.calls) assert.ok(c.request.maxTokens > 0 && c.request.idempotencyKey && c.request.signal);
});

test("changes requested trigger rework with feedback; identical resubmission is deduplicated", async () => {
  let reviewCount = 0;
  const model = fakeModel({
    plan: () => ({ tasks: [{ id: "core", title: "Implement greet" }] }),
    review: () => (++reviewCount <= 2 ? { verdict: "request-changes", comments: ["add docs"] } : { verdict: "approve" }),
    build: r => (r.input.feedback.length >= 2 ? { summary: "v2", patches: [{ path: "src/core.mjs", op: "create", content: "// docs\n" }] } : patchFor("core")),
  });
  const s = new CollaborationScheduler({ ...HOST, model, limits: { maxAttemptsPerTask: 5 } });
  const result = await s.run({ runId: "r4", goal: "g", needs: NEEDS });
  assert.equal(result.status, "completed");
  assert.equal(result.rounds, 3);
  assert.equal(result.tasks[0].attempts, 2);
  const state = await s.persistence.load("r4");
  assert.deepEqual(state.tasks.core.feedback.map(f => f.reason), ["changes-requested", "duplicate-proposal"]);
  assert.equal(model.calls.filter(c => c.phase === "review").length, 4, "duplicate proposal spends no review tokens");
});

test("proposals with commands or unsafe paths are rejected, never executed", async () => {
  assert.throws(() => validateProposal({ patches: [{ path: "src/a", op: "create", content: "" }], command: "rm -rf /" }), e => e.code === "forbidden-execution");
  assert.throws(() => validateProposal({ patches: [{ path: "src/a", op: "create", content: "", shell: "x" }] }), /executable field/);
  for (const path of ["../etc/passwd", "/etc/passwd", "src/../../x", "C:/x", ".git/config", "a\\b"]) assert.throws(() => validateProposal({ patches: [{ path, op: "create", content: "" }] }), /Unsafe/);
  assert.throws(() => validateProposal({ patches: [{ path: "lib/x", op: "create", content: "" }] }, { allowedPaths: ["src"] }), /outside allowed/);
  assert.throws(() => validateProposal({ patches: [{ path: "src/x", op: "modify" }] }, { allowedPaths: ["src"] }), /unified diff/);
  assert.throws(() => validateProposal({ patches: [{ path: "src/x", op: "create", content: "x".repeat(20) }] }, { allowedPaths: ["src"], maxPatchBytes: 10 }), /limit/);
  assert.throws(() => validateProposal({ patches: [{ path: "src/x", op: "create", content: "" }] }), /No allowed paths/);
  const model = fakeModel({ plan: () => ({ tasks: [{ id: "a", title: "A" }] }), build: () => ({ patches: [{ path: "src/a", op: "create", content: "" }], run: "npm test" }) });
  const result = await new CollaborationScheduler({ ...HOST, model, limits: { maxAttemptsPerTask: 1 } }).run({ runId: "r5", goal: "g", needs: NEEDS });
  assert.equal(result.status, "failed");
  assert.equal(model.calls.filter(c => c.phase === "test").length, 0);
});

test("round, token, and time limits stop runs and are resumable", async () => {
  const stubborn = { review: () => ({ verdict: "request-changes", comments: ["no"] }), build: r => ({ patches: [{ path: `src/${r.input.feedback.length}.mjs`, op: "create", content: "x" }] }) };
  const r1 = await new CollaborationScheduler({ ...HOST, model: fakeModel(stubborn), limits: { maxRounds: 2, maxAttemptsPerTask: 10 } }).run({ runId: "lim", goal: "g", needs: NEEDS });
  assert.equal(r1.status, "round-limit");
  assert.equal(r1.rounds, 2);

  const r2 = await new CollaborationScheduler({ ...HOST, model: fakeModel(), limits: { maxTokens: 40 } }).run({ runId: "tok", goal: "g", needs: NEEDS });
  assert.equal(r2.status, "token-limit");
  assert.ok(r2.tokensUsed <= 40, "prompt reservation stops before overspending");

  let now = 0;
  const model = fakeModel({ build: r => { now += 1000; return patchFor(r.input.task.id); } });
  const persistence = createMemoryPersistence();
  const r3 = await new CollaborationScheduler({ ...HOST, model, persistence, clock: { now: () => now }, limits: { maxDurationMs: 500 } }).run({ runId: "time", goal: "g", needs: NEEDS });
  assert.equal(r3.status, "time-limit");
  const resumed = await new CollaborationScheduler({ ...HOST, model, persistence, clock: { now: () => now } }).run({ runId: "time" });
  assert.equal(resumed.status, "completed");
});

test("concurrency limit bounds parallel model calls", async () => {
  const model = fakeModel({ delay: 5, plan: () => ({ tasks: ["a", "b", "c", "d", "e"].map(id => ({ id, title: id })) }) });
  const result = await new CollaborationScheduler({ ...HOST, model, limits: { maxConcurrency: 2 } }).run({ runId: "cc", goal: "g", needs: NEEDS });
  assert.equal(result.status, "completed");
  assert.equal(result.rounds, 1);
  assert.equal(model.maxActive, 2);
});

test("cancellation aborts in-flight work and persists cancelled status", async () => {
  const controller = new AbortController();
  const model = fakeModel({ build: r => new Promise(resolve => { setTimeout(() => resolve(patchFor(r.input.task.id)), 1000); setTimeout(() => controller.abort("operator stop"), 5); }) });
  const persistence = createMemoryPersistence();
  const s = new CollaborationScheduler({ ...HOST, model, persistence, signal: controller.signal });
  const result = await s.run({ runId: "cx", goal: "g", needs: NEEDS });
  assert.equal(result.status, "cancelled");
  assert.match(result.stopReason, /operator stop/);
  assert.equal((await persistence.load("cx")).status, "cancelled");
  const again = await new CollaborationScheduler({ ...HOST, model, persistence }).run({ runId: "cx" });
  assert.equal(again.status, "cancelled", "terminal runs are not restarted");
  const s2 = make();
  s2.cancel("pre");
  assert.equal((await s2.run({ runId: "pre", goal: "g", needs: NEEDS })).status, "cancelled");
});

test("idempotent resume after crash reuses cached calls; completed and concurrent runs dedupe", async () => {
  let crash = true;
  const model = fakeModel({ test: () => { if (crash) { crash = false; throw new Error("adapter down"); } return { passed: true }; } });
  const dir = mkdtempSync(join(tmpdir(), "collab-"));
  try {
    const persistence = createFilePersistence(dir);
    await assert.rejects(new CollaborationScheduler({ ...HOST, model, persistence }).run({ runId: "idem", goal: "g", needs: NEEDS }), /adapter down/);
    assert.equal((await persistence.load("idem")).status, "interrupted");
    const before = model.calls.length;
    const resumed = await new CollaborationScheduler({ ...HOST, model, persistence }).run({ runId: "idem" });
    assert.equal(resumed.status, "completed");
    const after = model.calls.slice(before);
    assert.ok(!after.some(c => c.phase === "needs" || c.phase === "plan"), "earlier phases are not re-called");
    assert.ok(!after.some(c => c.phase === "build" && c.taskId === "core"), "cached build is reused");
    const count = model.calls.length;
    const replay = await new CollaborationScheduler({ ...HOST, model, persistence }).run({ runId: "idem" });
    assert.deepEqual(replay, resumed);
    assert.equal(model.calls.length, count);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const s = make();
  const [a, b] = [s.run({ runId: "same", goal: "g", needs: NEEDS }), s.run({ runId: "same", goal: "g", needs: NEEDS })];
  assert.equal(a, b);
  assert.equal((await a).status, "completed");
});

test("dependency tracking: dedup, unknown deps, cycles, and blocked dependents", async () => {
  const tasks = normalizePlan([{ id: "a", title: "Do A" }, { id: "a2", title: "do  a", dependsOn: [] }, { id: "b", title: "B", dependsOn: ["a2"] }]);
  assert.deepEqual(Object.keys(tasks), ["a", "b"]);
  assert.deepEqual(tasks.b.dependsOn, ["a"]);
  assert.deepEqual(readyTasks(tasks).map(t => t.id), ["a"]);
  assert.throws(() => normalizePlan([{ id: "a", title: "A", dependsOn: ["zz"] }]), /unknown task/);
  assert.throws(() => normalizePlan([{ id: "a", title: "A", dependsOn: ["b"] }, { id: "b", title: "B", dependsOn: ["a"] }]), /cycle/);
  assert.throws(() => normalizePlan([{ id: "a", title: "A", dependsOn: ["a"] }]), /itself/);
  const cyc = await new CollaborationScheduler({ ...HOST, model: fakeModel({ plan: () => ({ tasks: [{ id: "a", title: "A", dependsOn: ["b"] }, { id: "b", title: "B", dependsOn: ["a"] }] }) }) }).run({ runId: "cyc", goal: "g", needs: NEEDS });
  assert.equal(cyc.status, "failed");
  assert.match(cyc.stopReason, /cycle/);
  const blocked = await new CollaborationScheduler({ ...HOST, model: fakeModel({ test: r => ({ passed: r.input.task.id !== "core", findings: ["fails"] }) }), limits: { maxAttemptsPerTask: 2 } }).run({ runId: "blk", goal: "g", needs: NEEDS });
  assert.equal(blocked.status, "failed");
  assert.deepEqual(blocked.tasks.map(t => [t.id, t.status]), [["core", "failed"], ["tests", "blocked"]]);
});

test("memory hooks are recalled before work and record each methodical step", async () => {
  const recalls = [], records = [];
  const memory = { async recall(q) { recalls.push(q.phase); return [{ note: "prefer small patches" }]; }, async record(e) { records.push(e.kind); } };
  const model = fakeModel();
  const result = await createCollaboration({ ...HOST, model, ...createContinuity({ memory }) }).run({ runId: "mem", goal: "g", needs: NEEDS });
  assert.equal(result.status, "completed");
  assert.deepEqual([...new Set(recalls)], ["needs", "plan", "build"]);
  for (const kind of ["needs", "plan", "proposal", "test", "approval", "outcome"]) assert.ok(records.includes(kind), kind);
  assert.deepEqual(model.calls.find(c => c.phase === "plan").request.input.memory, [{ note: "prefer small patches" }]);
  const failing = { async recall() { throw new Error("memory offline") }, async record() { throw new Error("memory offline") } };
  assert.equal((await make({ memory: failing, memoryFailurePolicy: "best-effort" }).run({ runId: "mem2", goal: "g", needs: NEEDS })).status, "completed", "best-effort must be explicit");
});

test("model output parsing is provider neutral", () => {
  assert.deepEqual(parseModelOutput({ output: { a: 1 } }), { a: 1 });
  assert.deepEqual(parseModelOutput({ content: "```json\n{\"a\":2}\n```" }), { a: 2 });
  assert.deepEqual(parseModelOutput({ text: "Sure: {\"a\":3} done" }), { a: 3 });
  assert.deepEqual(parseModelOutput("{\"a\":4}"), { a: 4 });
  assert.throws(() => parseModelOutput({ content: "nope" }), CollaborationError);
});

test("continuity journals adapt to memory hooks via duck typing", async () => {
  const entries = [];
  const journal = { remember(kind, content) { assert.match(kind, /^[a-z0-9:_-]{1,64}$/); entries.push({ kind, content: structuredClone(content), at: entries.length }); }, recall({ limit }) { return entries.slice(-limit); } };
  const { persistence, memory } = createContinuity({ continuity: journal });
  const model = fakeModel();
  assert.equal((await createCollaboration({ ...HOST, model, persistence, memory }).run({ runId: "j1", goal: "g", needs: NEEDS })).status, "completed");
  assert.ok(entries.some(e => e.kind === "collab:outcome" && e.content.runId === "j1"));
  const recalled = await memoryFromContinuity(journal).recall({ runId: "j2", phase: "needs" });
  assert.ok(recalled.some(e => e.kind === "collab:outcome"), "prior outcomes inform new runs");
  assert.throws(() => memoryFromContinuity({}), /remember/);
  assert.throws(() => createContinuity({ memory: {}, continuity: journal }), /not both/);
});

// ---------------------------------------------------------------- security hardening
const DIFF = (path, from = path, to = path) => `--- a/${from}\n+++ b/${to}\n@@ -1,2 +1,2 @@\n context\n-old\n+new\n`;

test("C1: empty or root allowlists pause for needs; protected paths cannot be overridden by model or needs input", async () => {
  for (const [i, allowedPaths] of [[], "", " , ", ["."], ["./"], ["../x"], ["/abs"], [".env"]].entries()) {
    const model = fakeModel();
    const r = await new CollaborationScheduler({ ...HOST, model }).run({ runId: `ap-${i}`, goal: "g", needs: { ...NEEDS, allowedPaths } });
    assert.equal(r.status, "awaiting-needs", JSON.stringify(allowedPaths));
    assert.ok(r.questions.some(q => q.id === "allowedPaths"));
    assert.ok(!model.calls.some(c => c.phase !== "needs"), "no planning without an explicit allowlist");
  }
  assert.deepEqual(normalizeAllowedPaths("src, test/"), ["src", "test"]);
  // slash-bounded prefixes: "src" does not admit "src-evil"
  assert.throws(() => validatePatchPath("src-evil/a.mjs", ["src"]), /outside allowed/);
  assert.equal(validatePatchPath("src/a.mjs", ["src"]), "src/a.mjs");
  const wide = [".github", "src", "packages", "config", "."].filter(p => p !== ".");
  for (const path of [".github/workflows/ci.yml", "src/.env", "src/.env.local", "config/.npmrc", "src/identity.json", "src/local-secret.key", "packages/agent-commons/package.json",
    "packages/agent-commons/src/trust.mjs", "packages/agent-commons/src/governance.mjs", "src/release-plan.mjs", "src/policy/x.mjs", "src/admission.mjs", "src/budget.mjs", "packages/agent-commons/src/collaboration.mjs"])
    assert.throws(() => validatePatchPath(path, wide), e => e.code === "protected-path", path);
  // host maintenance (constructor only) may unlock the code surface but never secrets
  const maint = { protectedPaths: [], maintenancePaths: ["packages/agent-commons/src/trust.mjs"] };
  assert.equal(validatePatchPath("packages/agent-commons/src/trust.mjs", wide, maint), "packages/agent-commons/src/trust.mjs");
  assert.throws(() => validatePatchPath("packages/agent-commons/src/trust.mjs.bak/x", wide, maint), /protected/);
  assert.throws(() => make({ hostMaintenance: { reason: "rotate", authorizedPaths: ["src/.env"] } }), /Secrets cannot be authorized/);
  assert.throws(() => make({ hostMaintenance: { authorizedPaths: ["src/trust.mjs"] } }), /reason/);
  // host-added protected prefixes are additive
  assert.throws(() => validatePatchPath("src/vendor/x.mjs", ["src"], { protectedPaths: ["src/vendor"] }), /host-protected/);

  // Scheduler level: needs answers / model output claiming authority are ignored.
  const model = fakeModel({
    plan: () => ({ tasks: [{ id: "ci", title: "Edit CI" }] }),
    build: () => ({ hostMaintenance: { authorizedPaths: [".github"] }, protectedPaths: [], patches: [{ path: ".github/workflows/ci.yml", op: "create", content: "on: push" }] }),
  });
  const r = await new CollaborationScheduler({ ...HOST, model, limits: { maxAttemptsPerTask: 1 } })
    .run({ runId: "prot", goal: "g", needs: { ...NEEDS, allowedPaths: [".github", "src"], protectedPaths: [], hostMaintenance: { reason: "x", authorizedPaths: [".github"] } } });
  assert.equal(r.status, "failed");
  assert.ok(!model.calls.some(c => c.phase === "test" || c.phase === "review"));
  const authorized = await new CollaborationScheduler({ ...HOST, model: fakeModel({ plan: () => ({ tasks: [{ id: "ci", title: "Edit CI" }] }), build: () => ({ patches: [{ path: ".github/workflows/ci.yml", op: "create", content: "on: push" }] }) }), hostMaintenance: { reason: "CI maintenance ticket", authorizedPaths: [".github/workflows"] } })
    .run({ runId: "prot-ok", goal: "g", needs: { ...NEEDS, allowedPaths: [".github"] } });
  assert.equal(authorized.status, "completed");
});

test("C2: model tests are advisory; completion requires an injected host verifier", async () => {
  const advisory = await new CollaborationScheduler({ model: fakeModel() }).run({ runId: "adv", goal: "g", needs: NEEDS });
  assert.equal(advisory.status, "needs-host-verification");
  assert.equal(advisory.verifiedByHost, false);
  assert.equal(advisory.artifacts.length, 2);
  const allowed = await new CollaborationScheduler({ model: fakeModel(), allowAdvisory: true }).run({ runId: "adv2", goal: "g", needs: NEEDS });
  assert.equal(allowed.status, "completed");
  assert.equal(allowed.verifiedByHost, false);
  const verified = [];
  const verifier = { async verify(artifact) { verified.push(artifact.id); return { passed: !artifact.patches.some(p => p.content?.includes("BAD")), findings: ["host check"] }; } };
  let first = true;
  const model = fakeModel({ plan: () => ({ tasks: [{ id: "core", title: "Core" }] }), build: () => { const c = first ? "BAD" : "good"; first = false; return { patches: [{ path: "src/core.mjs", op: "create", content: c }] }; } });
  const host = await new CollaborationScheduler({ model, verifier }).run({ runId: "hv", goal: "g", needs: NEEDS });
  assert.equal(host.status, "completed");
  assert.equal(host.verifiedByHost, true);
  assert.equal(verified.length, 2, "host verifier rejected the first proposal");
  assert.equal(host.rounds, 2);
  assert.throws(() => new CollaborationScheduler({ model, allowAdvisory: "yes" }), /boolean/);
});

test("spend accounting rejects negative/invalid usage and never trusts under-reporting", async () => {
  assert.equal(chargeUsage({ content: "x".repeat(400), usage: { totalTokens: -600 } }, 10).tokens, 110);
  assert.deepEqual(chargeUsage({ content: "", usage: { inputTokens: 1.5, outputTokens: NaN } }, 7).invalid, ["inputTokens", "outputTokens"]);
  assert.equal(chargeUsage({ content: "", usage: { totalTokens: Number.POSITIVE_INFINITY } }, 7).tokens, 7);
  assert.equal(chargeUsage({ content: "abcd", usage: { totalTokens: 0 } }, 5).tokens, 6, "under-report floors at local estimate");
  assert.equal(chargeUsage({ content: "", usage: { inputTokens: 900, outputTokens: 100 } }, 5).tokens, 1000);
  const events = [];
  const model = { async complete(r) { return { content: JSON.stringify(defaults[r.phase](r)), usage: { totalTokens: -600, inputTokens: -1 } }; } };
  const r = await new CollaborationScheduler({ ...HOST, model, onEvent: e => events.push(e) }).run({ runId: "neg", goal: "g", needs: NEEDS });
  assert.equal(r.status, "completed");
  assert.ok(r.tokensUsed > 0);
  assert.ok(events.some(e => e.type === "usage-invalid"));
  const capped = await new CollaborationScheduler({ ...HOST, model, limits: { maxTokens: Math.floor(r.tokensUsed / 2) } }).run({ runId: "neg2", goal: "g", needs: NEEDS });
  assert.equal(capped.status, "token-limit", "negative usage cannot extend the budget");
});

test("unified diffs must target exactly the declared path", async () => {
  assert.equal(validateUnifiedDiff("src/a.mjs", DIFF("src/a.mjs")), true);
  assert.equal(validateUnifiedDiff("src/a.mjs", `diff --git a/src/a.mjs b/src/a.mjs\nindex 1234abc..5678def 100644\n${DIFF("src/a.mjs")}`), true);
  assert.equal(validateUnifiedDiff("src/a.mjs", "--- a/src/a.mjs\n+++ b/src/a.mjs\n@@ -1,2 +1,1 @@\n--- not a header\n keep\n"), true, "hunk content that looks like a header is counted, not parsed");
  const reject = [
    DIFF("src/a.mjs", "src/a.mjs", "package.json"), DIFF("src/a.mjs", "package.json", "src/a.mjs"),
    DIFF("src/a.mjs") + DIFF("package.json"), `--- /dev/null\n+++ b/src/a.mjs\n@@ -0,0 +1 @@\n+x\n`,
    `diff --git a/src/a.mjs b/package.json\n${DIFF("src/a.mjs")}`, `diff --git a/src/a.mjs b/src/a.mjs\nrename from src/a.mjs\nrename to package.json\n`,
    `diff --git a/src/a.mjs b/src/a.mjs\nGIT binary patch\n`, `--- a/src/a.mjs\n+++ b/src/a.mjs\n@@ -1,3 +1,3 @@\n context\n-old\n`,
    `--- a/src/a.mjs\n+++ b/src/a.mjs\n`, `junk\n${DIFF("src/a.mjs")}`, `--- a/src/a.mjs\n+++ b/src/a.mjs\n@@ -1 +1 @@\n same\n`,
    `diff --git a/src/a.mjs b/src/a.mjs\nindex 1234abc..5678def 120000\n${DIFF("src/a.mjs")}`,
  ];
  for (const diff of reject) assert.throws(() => validateUnifiedDiff("src/a.mjs", diff), /rejected/, diff);
  assert.throws(() => validateProposal({ patches: [{ path: "src/a.mjs", op: "modify", diff: DIFF("src/a.mjs"), content: "x" }] }, { allowedPaths: ["src"] }), /may not also carry/);
  // governance cross-review probe: declared path allowed, header targets package.json
  const model = fakeModel({ plan: () => ({ tasks: [{ id: "a", title: "A" }] }), build: () => ({ patches: [{ path: "src/safe.mjs", op: "modify", diff: DIFF("src/safe.mjs", "src/safe.mjs", "package.json") }] }) });
  const r = await new CollaborationScheduler({ ...HOST, model, limits: { maxAttemptsPerTask: 1 } }).run({ runId: "probe", goal: "g", needs: { ...NEEDS, allowedPaths: ["src"] } });
  assert.equal(r.status, "failed");
  assert.equal(r.artifacts.length, 0);
});

test("configured memory fails closed (halt) with no further model calls; best-effort is explicit", async () => {
  assert.throws(() => make({ memoryFailurePolicy: "ignore" }), /memoryFailurePolicy/);
  for (const [name, memory] of [
    ["record throws", { async recall() { return []; }, async record(e) { if (e.kind === "plan") throw new Error("disk full"); } }],
    ["recall corrupt", { async recall(q) { return q.phase === "build" ? { not: "an array" } : []; }, async record() {} }],
  ]) {
    const model = fakeModel();
    const persistence = createMemoryPersistence();
    const runId = name.replace(/\s+/g, "-");
    const r = await new CollaborationScheduler({ ...HOST, model, memory, persistence }).run({ runId, goal: "g", needs: NEEDS });
    assert.equal(r.status, "memory-failure", name);
    assert.match(r.stopReason, /Memory (record|recall) failed/);
    const phases = model.calls.map(c => c.phase);
    if (name === "record throws") assert.deepEqual(phases, ["needs", "plan"], "no build after plan record failed");
    else assert.ok(!phases.includes("build"), "no build when recall is corrupt");
    assert.equal((await persistence.load(runId)).status, "memory-failure");
    const fixed = await new CollaborationScheduler({ ...HOST, model, persistence, memory: { async recall() { return []; }, async record() {} } }).run({ runId });
    assert.equal(fixed.status, "completed", "resumable after memory is repaired");
  }
  const bestEffort = await make({ memory: { async recall() { return "garbage"; }, async record() { throw new Error("x"); } }, memoryFailurePolicy: "best-effort" }).run({ runId: "be", goal: "g", needs: NEEDS });
  assert.equal(bestEffort.status, "completed");
  assert.equal((await make({ memory: NOOP_MEMORY }).run({ runId: "noop", goal: "g", needs: NEEDS })).status, "completed");
  // continuity journal guards
  const journal = (extra) => ({ remember() {}, recall() { return []; }, ...extra });
  const nonDurable = await make({ memory: memoryFromContinuity(journal({ status: () => ({ durable: false }) })) }).run({ runId: "nd", goal: "g", needs: NEEDS });
  assert.equal(nonDurable.status, "memory-failure");
  assert.match(nonDurable.stopReason, /not durable/);
  const unverified = await make({ memory: memoryFromContinuity(journal({ verify: () => false })) }).run({ runId: "uv", goal: "g", needs: NEEDS });
  assert.match(unverified.stopReason, /verification/);
  const stored = [];
  const big = memoryFromContinuity(journal({ remember: (k, c) => stored.push(c) }), { maxEntryBytes: 200 });
  await big.record({ kind: "needs", runId: "r", round: 0, data: { blob: "x".repeat(1000), ratio: 0.5 } });
  await big.record({ kind: "note", runId: "r", round: 0, data: { ratio: 0.5, missing: undefined } });
  assert.equal(stored[0].data.truncated, true);
  assert.deepEqual(stored[1].data, { ratio: "0.5" }, "canonical JSON: decimals as strings, undefined dropped");
});

test("persistence failures and corrupt state fail closed without model calls", async () => {
  // save failure
  let saves = 0;
  const flaky = { async load() { return null; }, async save() { if (++saves > 2) throw new Error("EIO"); } };
  const model = fakeModel();
  const r = await new CollaborationScheduler({ ...HOST, model, persistence: flaky }).run({ runId: "pf", goal: "g", needs: NEEDS });
  assert.equal(r.status, "persistence-failure");
  assert.equal(r.persisted, false);
  assert.ok(model.calls.length <= 2, `stopped promptly (${model.calls.length} calls)`);
  // load failure and corrupt state
  const m2 = fakeModel();
  assert.equal((await new CollaborationScheduler({ ...HOST, model: m2, persistence: { async load() { throw new Error("EACCES"); }, async save() {} } }).run({ runId: "lf", goal: "g" })).status, "persistence-failure");
  const persistence = createMemoryPersistence();
  await new CollaborationScheduler({ ...HOST, model: fakeModel(), persistence, limits: { maxRounds: 1 } }).run({ runId: "cor", goal: "g", needs: NEEDS });
  for (const mutate of [s => { s.tokensUsed = -600; }, s => { s.version = 99; }, s => { s.tasks.core.dependsOn = ["ghost"]; }, s => { s.calls = { bad: {} }; }, s => { s.runId = "other"; }, s => { s.tasks.core.status = "approved-by-model"; }]) {
    const base = await persistence.load("cor");
    const tampered = structuredClone(base); mutate(tampered);
    persistence._runs.set("cor", tampered);
    const result = await new CollaborationScheduler({ ...HOST, model: m2, persistence }).run({ runId: "cor" });
    assert.equal(result.status, "persistence-failure");
    assert.match(result.stopReason, /persistence-corrupt/);
    assert.deepEqual(persistence._runs.get("cor"), tampered, "corrupt evidence is not overwritten");
    persistence._runs.set("cor", base);
  }
  assert.equal(m2.calls.length, 0);
  assert.throws(() => validateRunState({ version: 1 }), /corrupt/);
  await assert.rejects(new CollaborationScheduler({ ...HOST, model: m2, persistence: { async load() { return { version: 2 }; }, async save() {} } }).status("x"), /corrupt/);
});

test("file persistence detects corruption and enforces injected integrity signatures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collab-int-"));
  try {
    const integrity = hmacIntegrity("k".repeat(32));
    assert.throws(() => hmacIntegrity("short"), /32 bytes/);
    const signed = createFilePersistence(dir, { integrity });
    assert.equal(signed.integrity, "signed");
    assert.equal(createFilePersistence(dir).integrity, "checksum-only");
    const done = await new CollaborationScheduler({ ...HOST, model: fakeModel(), persistence: signed }).run({ runId: "fp", goal: "g", needs: NEEDS });
    assert.equal(done.status, "completed");
    const file = join(dir, readdirSync(dir).find(f => f.endsWith(".json")));
    const original = readFileSync(file, "utf8");
    const envelope = JSON.parse(original);
    assert.equal((await signed.load("fp")).status, "completed");
    // 1. raw corruption -> checksum mismatch even without a signer
    writeFileSync(file, JSON.stringify({ ...envelope, state: envelope.state.replace("completed", "cancelled") }));
    await assert.rejects(createFilePersistence(dir).load("fp"), /checksum mismatch/);
    // 2. attacker recomputes sha256 but cannot sign
    const forged = envelope.state.replace(/"tokensUsed":\d+/, '"tokensUsed":0');
    writeFileSync(file, JSON.stringify({ ...envelope, state: forged, sha256: createHash("sha256").update(forged).digest("hex") }));
    await assert.rejects(signed.load("fp"), /signature invalid/);
    // 3. stripped signature
    writeFileSync(file, JSON.stringify({ ...envelope, signature: null }));
    await assert.rejects(signed.load("fp"), /missing signature/);
    const m = fakeModel();
    const r = await new CollaborationScheduler({ ...HOST, model: m, persistence: signed }).run({ runId: "fp" });
    assert.equal(r.status, "persistence-failure");
    assert.equal(m.calls.length, 0);
    writeFileSync(file, "not json");
    await assert.rejects(signed.load("fp"), /not JSON/);
    writeFileSync(file, original);
    assert.equal((await signed.load("fp")).status, "completed");
    assert.throws(() => createFilePersistence(dir, { integrity: { sign() {} } }), /verify/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
