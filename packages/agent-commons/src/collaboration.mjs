// Seven-slot collaboration scheduler.
//
// Provider-neutral: every external capability (model, persistence, memory,
// operational-needs intake, verification, artifact sink, clock) is injected
// through a small abstract interface. The scheduler never executes shell
// commands; builders may only emit *patch proposal artifacts* which the host
// decides whether to apply.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { posix, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

export const COLLABORATION_VERSION = 1;
export const ROSTER_SIZE = 7;
export const ROLES = Object.freeze(["needs", "planner", "builder", "tester", "reviewer"]);
export const PHASES = Object.freeze(["needs", "plan", "build", "test", "review"]);
export const TERMINAL_STATUSES = Object.freeze(["completed", "needs-host-verification", "cancelled", "failed"]);
export const MEMORY_FAILURE_POLICIES = Object.freeze(["halt", "best-effort"]);
const TASK_STATUSES = new Set(["pending", "in-progress", "done", "failed", "blocked"]);
const FATAL = new WeakMap(); // run state -> first fail-closed StopSignal (memory/persistence)

export const DEFAULT_ROSTER = Object.freeze([
  { id: "needs-analyst", role: "needs", instructions: "Identify operational needs, constraints and acceptance criteria before any work starts." },
  { id: "planner", role: "planner", instructions: "Decompose the objective into small dependency-ordered tasks." },
  { id: "builder-a", role: "builder", instructions: "Produce minimal patch proposals for one task. Never propose commands." },
  { id: "builder-b", role: "builder", instructions: "Produce minimal patch proposals for one task. Never propose commands." },
  { id: "builder-c", role: "builder", instructions: "Produce minimal patch proposals for one task. Never propose commands." },
  { id: "tester", role: "tester", instructions: "Assess a patch proposal against acceptance criteria and report findings." },
  { id: "reviewer", role: "reviewer", instructions: "Peer-review a patch proposal; approve or request specific changes." },
].map(Object.freeze));

export const BASELINE_NEEDS = Object.freeze([
  { id: "objective", question: "What concrete outcome must this collaboration deliver?", required: true },
  { id: "acceptanceCriteria", question: "Which observable acceptance criteria decide that the outcome is done?", required: true },
  { id: "allowedPaths", question: "Which repository paths may patch proposals touch?", required: true },
  { id: "constraints", question: "Which technical, policy, privacy or compatibility constraints apply?", required: false },
  { id: "environment", question: "Which runtime, versions and test commands will the host use to verify proposals?", required: false },
  { id: "deadline", question: "Is there a deadline or budget beyond the configured limits?", required: false },
].map(Object.freeze));

export const DEFAULT_LIMITS = Object.freeze({
  maxRounds: 6,
  maxTokens: 200_000,
  maxTokensPerCall: 8_000,
  maxDurationMs: 15 * 60_000,
  maxConcurrency: 3,
  maxTasks: 24,
  maxAttemptsPerTask: 3,
  maxPatchBytes: 256 * 1024,
  maxFilesPerProposal: 32,
  maxEvents: 500,
});

const FORBIDDEN_KEYS = new Set(["command", "commands", "cmd", "shell", "exec", "execute", "script", "scripts", "run", "spawn", "eval"]);

export class CollaborationError extends Error {
  constructor(code, message, details) { super(message); this.name = "CollaborationError"; this.code = code; if (details !== undefined) this.details = details; }
}
class StopSignal extends Error {
  constructor(reason, message) { super(message || reason); this.name = "StopSignal"; this.reason = reason; }
}

// ---------------------------------------------------------------- utilities
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}
export function hashOf(value) { return createHash("sha256").update(stableStringify(value)).digest("hex"); }
const clone = value => (value === undefined ? undefined : structuredClone(value));
const estimateTokens = value => Math.ceil((typeof value === "string" ? value : stableStringify(value ?? "")).length / 4);
const normalizeTitle = title => String(title || "").toLowerCase().replace(/\s+/g, " ").trim();
const isPositiveInt = n => Number.isInteger(n) && n > 0;

function createSemaphore(limit) {
  let active = 0;
  const queue = [];
  const next = () => { if (active < limit && queue.length) { active++; queue.shift()(); } };
  return {
    get active() { return active; },
    async run(fn) {
      await new Promise(resolve => { queue.push(resolve); next(); });
      try { return await fn(); } finally { active--; next(); }
    },
  };
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new StopSignal("cancelled", String(signal.reason ?? "cancelled")));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new StopSignal("cancelled", String(signal.reason ?? "cancelled")));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(v => { signal.removeEventListener("abort", onAbort); resolve(v); },
      e => { signal.removeEventListener("abort", onAbort); reject(e); });
  });
}

/** Parse provider-neutral model output: `{output}` object, or JSON (optionally fenced) in `{content|text}`. */
export function parseModelOutput(result) {
  if (result && typeof result === "object" && result.output && typeof result.output === "object") return result.output;
  const text = typeof result === "string" ? result : (result?.content ?? result?.text);
  if (text && typeof text === "object") return text;
  if (typeof text !== "string") throw new CollaborationError("invalid-output", "Model adapter returned no content");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try { return JSON.parse(candidate); } catch {
    const start = candidate.indexOf("{"), end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) { try { return JSON.parse(candidate.slice(start, end + 1)); } catch { /* fall through */ } }
    throw new CollaborationError("invalid-output", "Model output is not JSON");
  }
}

// ---------------------------------------------------------------- roster
export function createRoster(overrides) {
  let roster;
  if (overrides === undefined) roster = DEFAULT_ROSTER.map(s => ({ ...s }));
  else if (Array.isArray(overrides)) roster = overrides.map(s => ({ ...s }));
  else if (overrides && typeof overrides === "object") {
    // Keyed overrides: { "builder-c": { role: "reviewer", model: "x" } }
    roster = DEFAULT_ROSTER.map(s => ({ ...s, ...(overrides[s.id] || {}), id: overrides[s.id]?.id ?? s.id }));
    for (const key of Object.keys(overrides)) if (!DEFAULT_ROSTER.some(s => s.id === key)) throw new CollaborationError("invalid-roster", `Unknown roster slot ${key}`);
  } else throw new CollaborationError("invalid-roster", "Roster must be an array or slot-keyed object");
  if (roster.length !== ROSTER_SIZE) throw new CollaborationError("invalid-roster", `Roster must contain exactly ${ROSTER_SIZE} slots`);
  const ids = new Set();
  for (const slot of roster) {
    if (typeof slot.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slot.id)) throw new CollaborationError("invalid-roster", `Invalid slot id ${slot.id}`);
    if (ids.has(slot.id)) throw new CollaborationError("invalid-roster", `Duplicate slot id ${slot.id}`);
    if (!ROLES.includes(slot.role)) throw new CollaborationError("invalid-roster", `Invalid role ${slot.role} for ${slot.id}`);
    ids.add(slot.id);
  }
  for (const role of ROLES) if (!roster.some(s => s.role === role)) throw new CollaborationError("invalid-roster", `Roster is missing a ${role} slot`);
  return Object.freeze(roster.map(Object.freeze));
}

// ---------------------------------------------------------------- persistence / memory defaults
export function createMemoryPersistence() {
  const runs = new Map();
  return {
    async load(runId) { return clone(runs.get(runId)) ?? null; },
    async save(runId, state) { runs.set(runId, clone(state)); },
    _runs: runs,
  };
}
export const STATE_FORMAT = "agent-commons/collaboration-state/1";
/**
 * JSON-file persistence (one envelope per run, atomic rename) for CLI continuity across processes.
 * Every envelope carries a sha256 of the serialized state, which detects accidental corruption only.
 * Tamper resistance requires an injected `integrity` signer: `{ sign(bytes) -> string, verify(bytes, signature) -> boolean }`
 * (sync or async; e.g. `hmacIntegrity(secret)` or a host Keychain). With `integrity`, unsigned or
 * mis-signed envelopes fail closed on load.
 */
export function createFilePersistence(directory, { integrity = null } = {}) {
  if (typeof directory !== "string" || !directory) throw new CollaborationError("invalid-config", "directory is required");
  if (integrity && (typeof integrity.sign !== "function" || typeof integrity.verify !== "function")) throw new CollaborationError("invalid-config", "integrity must implement sign(bytes) and verify(bytes, signature)");
  const file = runId => join(directory, `${createHash("sha256").update(String(runId)).digest("hex").slice(0, 32)}.json`);
  const signed = sha256 => Buffer.from(`${STATE_FORMAT}\n${sha256}`);
  const corrupt = why => new CollaborationError("persistence-corrupt", `State file rejected: ${why}`);
  return {
    integrity: integrity ? "signed" : "checksum-only",
    async load(runId) {
      let text;
      try { text = await readFile(file(runId), "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
      let envelope;
      try { envelope = JSON.parse(text); } catch { throw corrupt("not JSON"); }
      if (!plainObject(envelope) || envelope.format !== STATE_FORMAT || typeof envelope.state !== "string" || typeof envelope.sha256 !== "string") throw corrupt("unknown envelope");
      if (createHash("sha256").update(envelope.state).digest("hex") !== envelope.sha256) throw corrupt("checksum mismatch");
      if (integrity) {
        if (typeof envelope.signature !== "string" || !envelope.signature) throw corrupt("missing signature");
        let ok = false;
        try { ok = (await integrity.verify(signed(envelope.sha256), envelope.signature)) === true; } catch { ok = false; }
        if (!ok) throw corrupt("signature invalid");
      }
      try { return JSON.parse(envelope.state); } catch { throw corrupt("state not JSON"); }
    },
    async save(runId, state) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const body = JSON.stringify(state);
      const sha256 = createHash("sha256").update(body).digest("hex");
      const signature = integrity ? await integrity.sign(signed(sha256)) : null;
      if (integrity && (typeof signature !== "string" || !signature)) throw new CollaborationError("persistence-failure", "integrity.sign returned no signature");
      const tmp = `${file(runId)}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify({ format: STATE_FORMAT, sha256, signature, state: body }), { mode: 0o600 });
      await rename(tmp, file(runId));
    },
  };
}
/** Local HMAC-SHA256 integrity signer for createFilePersistence. Keep the secret outside model inputs and state. */
export function hmacIntegrity(secret) {
  if (!(typeof secret === "string" || Buffer.isBuffer(secret)) || Buffer.byteLength(secret) < 32) throw new CollaborationError("invalid-config", "HMAC secret must be at least 32 bytes");
  const mac = bytes => createHmac("sha256", secret).update(bytes).digest("hex");
  return Object.freeze({
    sign: bytes => mac(bytes),
    verify: (bytes, signature) => { const expected = Buffer.from(mac(bytes)); const got = Buffer.from(String(signature)); return got.length === expected.length && timingSafeEqual(got, expected); },
  });
}
export const NOOP_MEMORY = Object.freeze({ async recall() { return []; }, async record() {} });

// ---------------------------------------------------------------- tasks
export function normalizePlan(rawTasks, { maxTasks = DEFAULT_LIMITS.maxTasks } = {}) {
  if (!Array.isArray(rawTasks) || !rawTasks.length) throw new CollaborationError("invalid-plan", "Plan must contain at least one task");
  const byId = new Map(), byTitle = new Map(), aliases = new Map();
  for (const [index, raw] of rawTasks.entries()) {
    if (!raw || typeof raw !== "object") throw new CollaborationError("invalid-plan", `Task ${index} is not an object`);
    const title = String(raw.title || raw.id || "").trim();
    if (!title) throw new CollaborationError("invalid-plan", `Task ${index} has no title`);
    const id = String(raw.id || `t${index + 1}`).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 64);
    const deps = Array.isArray(raw.dependsOn) ? raw.dependsOn.map(d => String(d).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-")) : [];
    const existing = byId.get(id) || byTitle.get(normalizeTitle(title));
    if (existing) { // dedup: merge duplicates by id or title
      existing.dependsOn = [...new Set([...existing.dependsOn, ...deps])];
      if (raw.id) aliases.set(String(raw.id).toLowerCase(), existing.id);
      if (id !== existing.id) aliases.set(id, existing.id);
      continue;
    }
    const task = { id, title, description: String(raw.description || ""), dependsOn: [...new Set(deps)], status: "pending", attempts: 0, feedback: [], assignee: null, proposals: [] };
    byId.set(id, task); byTitle.set(normalizeTitle(title), task);
  }
  if (byId.size > maxTasks) throw new CollaborationError("invalid-plan", `Plan has ${byId.size} tasks; limit is ${maxTasks}`);
  for (const task of byId.values()) {
    task.dependsOn = [...new Set(task.dependsOn.map(d => aliases.get(d) || d))];
    if (task.dependsOn.includes(task.id)) throw new CollaborationError("invalid-plan", `Task ${task.id} depends on itself`);
    for (const dep of task.dependsOn) if (!byId.has(dep)) throw new CollaborationError("invalid-plan", `Task ${task.id} depends on unknown task ${dep}`);
  }
  // Kahn cycle detection
  const indegree = new Map([...byId.keys()].map(id => [id, byId.get(id).dependsOn.length]));
  const queue = [...indegree].filter(([, n]) => n === 0).map(([id]) => id);
  let seen = 0;
  while (queue.length) {
    const id = queue.shift(); seen++;
    for (const t of byId.values()) if (t.dependsOn.includes(id)) { indegree.set(t.id, indegree.get(t.id) - 1); if (indegree.get(t.id) === 0) queue.push(t.id); }
  }
  if (seen !== byId.size) throw new CollaborationError("invalid-plan", "Plan contains a dependency cycle");
  return Object.fromEntries(byId);
}

export function readyTasks(tasks) {
  return Object.values(tasks).filter(t => t.status === "pending" && t.dependsOn.every(d => tasks[d]?.status === "done"));
}
function propagateBlocked(tasks) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of Object.values(tasks)) if (t.status === "pending" && t.dependsOn.some(d => ["failed", "blocked"].includes(tasks[d]?.status))) { t.status = "blocked"; changed = true; }
  }
}

// ---------------------------------------------------------------- patch proposals
function findForbiddenKey(value, path = "") {
  if (!value || typeof value !== "object") return null;
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(k.toLowerCase())) return `${path}${k}`;
    const nested = findForbiddenKey(v, `${path}${k}.`);
    if (nested) return nested;
  }
  return null;
}
// Host-protected paths. Defaults are immutable; hosts may add rules but never remove them.
// Secrets are never writable. The protected code surface is writable only through an explicit
// constructor-level `hostMaintenance` authorization, which never comes from model or needs input.
export const SECRET_PATH_RULES = Object.freeze([
  /(^|\/)\.env(\.[^/]*)?$/i, /(^|\/)\.npmrc$/i, /(^|\/)\.yarnrc(\.yml)?$/i, /(^|\/)\.pypirc$/i, /(^|\/)\.netrc$/i,
  /(^|\/)identity\.json$/i, /(^|\/)local-secret[^/]*$/i, /(^|\/)[^/]*\.(pem|key|p12|pfx)$/i, /(^|\/)id_(rsa|ed25519|ecdsa)[^/]*$/i,
  /(^|\/)[^/]*credentials?[^/]*$/i, /(^|\/)[^/]*secrets?(\.[^/]*)?$/i,
]);
export const PROTECTED_SURFACE_RULES = Object.freeze([
  /(^|\/)\.github(\/|$)/i,
  /(^|\/)(package|package-lock|npm-shrinkwrap)\.json$/i, /(^|\/)PROVENANCE\.json$/i,
  /(^|\/)[^/]*(release|polic(y|ies)|trust|admission|budget|governance|provenance)[^/]*(\/|$)/i,
  /(^|\/)collaboration\.mjs$/i,
]);
const underPrefix = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`); // slash-bounded, never bare startsWith

function safeRelative(path, label = "patch path") {
  if (typeof path !== "string" || !path || path.length > 512 || path.includes("\0") || path.includes("\\") || /^[a-z]:/i.test(path) || path.startsWith("/") || path.startsWith("~") || /[\x00-\x1f]/.test(path))
    throw new CollaborationError("invalid-proposal", `Unsafe ${label} ${JSON.stringify(path)}`);
  const normalized = posix.normalize(path).replace(/\/+$/, "");
  const segments = normalized.split("/");
  if (!normalized || normalized === "." || segments.includes("..") || segments.includes(".") || segments.includes(".git"))
    throw new CollaborationError("invalid-proposal", `Unsafe ${label} ${JSON.stringify(path)}`);
  return normalized;
}
export const isSecretPath = path => SECRET_PATH_RULES.some(rule => rule.test(path));
export function isProtectedPath(path, extraProtected = []) {
  return PROTECTED_SURFACE_RULES.some(rule => rule.test(path)) || extraProtected.some(prefix => underPrefix(path, prefix));
}
/** Normalize an allowlist. Empty, root ("."), unsafe, or secret entries are refused (fail closed). */
export function normalizeAllowedPaths(value) {
  const list = (Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : []).map(v => String(v).trim()).filter(Boolean);
  const out = [...new Set(list.map(entry => {
    const normalized = safeRelative(entry, "allowed path");
    if (isSecretPath(normalized)) throw new CollaborationError("invalid-proposal", `Allowed path ${normalized} names a secret`);
    return normalized;
  }))];
  if (!out.length) throw new CollaborationError("invalid-proposal", "allowedPaths must list at least one explicit relative path");
  return out;
}
/**
 * @param {string} path
 * @param {string[]} allowedPaths            non-empty allowlist (from operational needs)
 * @param {{protectedPaths?:string[], maintenancePaths?:string[]}} [policy]  host-only configuration
 */
export function validatePatchPath(path, allowedPaths, { protectedPaths = [], maintenancePaths = [] } = {}) {
  const normalized = safeRelative(path);
  if (!Array.isArray(allowedPaths) || !allowedPaths.length) throw new CollaborationError("invalid-proposal", "No allowed paths configured; refusing all patches");
  if (isSecretPath(normalized)) throw new CollaborationError("protected-path", `Patch path ${normalized} is a protected secret`);
  if (isProtectedPath(normalized, protectedPaths) && !maintenancePaths.some(prefix => underPrefix(normalized, prefix)))
    throw new CollaborationError("protected-path", `Patch path ${normalized} is host-protected; requires host maintenance authorization`);
  if (!allowedPaths.some(prefix => underPrefix(normalized, prefix)))
    throw new CollaborationError("invalid-proposal", `Patch path ${normalized} is outside allowed paths`);
  return normalized;
}

/** Strict unified-diff check: exactly one file, headers must name `path`, hunks must be well-formed and complete. */
export function validateUnifiedDiff(path, diff) {
  const bad = why => { throw new CollaborationError("invalid-proposal", `Diff for ${path} rejected: ${why}`); };
  const target = (raw, side) => {
    const name = raw.split("\t")[0].trim();
    if (name === "/dev/null") bad("modify diffs may not create or delete files");
    const stripped = name.startsWith(`${side}/`) ? name.slice(2) : name;
    if (stripped !== path) bad(`header targets ${JSON.stringify(stripped)}, not the declared path`);
  };
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  let minus = 0, plus = 0, hunks = 0, oldLeft = 0, newLeft = 0, changed = 0;
  for (const line of lines) {
    if (oldLeft > 0 || newLeft > 0) {
      const tag = line[0];
      if (tag === " ") { oldLeft--; newLeft--; }
      else if (tag === "-") { oldLeft--; changed++; }
      else if (tag === "+") { newLeft--; changed++; }
      else if (tag === "\\") continue;
      else if (line === "") { oldLeft--; newLeft--; }
      else bad("malformed hunk line");
      if (oldLeft < 0 || newLeft < 0) bad("hunk line counts exceeded");
      continue;
    }
    if (line.startsWith("\\")) continue;
    if (line.startsWith("diff --git ")) { if (minus || plus || hunks) bad("multiple files in one diff"); const m = line.match(/^diff --git a\/(\S+) b\/(\S+)$/); if (!m || m[1] !== path || m[2] !== path) bad("diff --git header does not match declared path"); continue; }
    if (/^index [0-9a-f]+\.\.[0-9a-f]+( [0-7]{6})?$/.test(line)) { if (/ 120000$/.test(line)) bad("symlinks are not allowed"); continue; }
    if (/^(similarity|dissimilarity|rename |copy |old mode|new mode|deleted file mode|new file mode|GIT binary patch|Binary files)/.test(line)) bad(`unsupported header ${JSON.stringify(line.slice(0, 40))}`);
    if (line.startsWith("--- ")) { if (minus || hunks) bad("multiple files in one diff"); minus++; target(line.slice(4), "a"); continue; }
    if (line.startsWith("+++ ")) { if (plus || !minus || hunks) bad("misordered file headers"); plus++; target(line.slice(4), "b"); continue; }
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) { if (!plus) bad("hunk before file headers"); hunks++; oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]); newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]); continue; }
    bad(`unexpected line outside hunk ${JSON.stringify(line.slice(0, 40))}`);
  }
  if (minus !== 1 || plus !== 1) bad("exactly one ---/+++ header pair is required");
  if (!hunks) bad("at least one hunk is required");
  if (oldLeft > 0 || newLeft > 0) bad("truncated hunk");
  if (!changed) bad("diff changes nothing");
  return true;
}

/** Validate a builder's output into an inert patch-proposal payload. Commands are never accepted. */
export function validateProposal(raw, { allowedPaths = [], protectedPaths = [], maintenancePaths = [], maxPatchBytes = DEFAULT_LIMITS.maxPatchBytes, maxFilesPerProposal = DEFAULT_LIMITS.maxFilesPerProposal } = {}) {
  if (!raw || typeof raw !== "object") throw new CollaborationError("invalid-proposal", "Proposal must be an object");
  const forbidden = findForbiddenKey(raw);
  if (forbidden) throw new CollaborationError("forbidden-execution", `Proposals may not contain executable field ${forbidden}; emit patches only`);
  const patches = raw.patches;
  if (!Array.isArray(patches) || !patches.length) throw new CollaborationError("invalid-proposal", "Proposal must contain patches");
  if (patches.length > maxFilesPerProposal) throw new CollaborationError("invalid-proposal", "Proposal touches too many files");
  let bytes = 0;
  const seen = new Set();
  const clean = patches.map(p => {
    if (!p || typeof p !== "object") throw new CollaborationError("invalid-proposal", "Patch must be an object");
    const op = p.op ?? (p.diff !== undefined ? "modify" : "create");
    if (!["create", "modify", "delete"].includes(op)) throw new CollaborationError("invalid-proposal", `Invalid patch op ${op}`);
    const path = validatePatchPath(p.path, allowedPaths, { protectedPaths, maintenancePaths });
    if (seen.has(path)) throw new CollaborationError("invalid-proposal", `Duplicate patch path ${path}`);
    seen.add(path);
    const out = { path, op };
    if (op === "modify") {
      if (typeof p.diff !== "string" || !p.diff) throw new CollaborationError("invalid-proposal", `modify ${path} requires a unified diff`);
      if (p.content !== undefined) throw new CollaborationError("invalid-proposal", `modify ${path} may not also carry content`);
      validateUnifiedDiff(path, p.diff);
      out.diff = p.diff;
    }
    if (op === "create") {
      if (typeof p.content !== "string") throw new CollaborationError("invalid-proposal", `create ${path} requires content`);
      if (p.diff !== undefined) throw new CollaborationError("invalid-proposal", `create ${path} may not also carry a diff`);
      out.content = p.content;
    }
    if (op === "delete" && (p.diff !== undefined || p.content !== undefined)) throw new CollaborationError("invalid-proposal", `delete ${path} carries no payload`);
    bytes += Buffer.byteLength(out.diff ?? out.content ?? "");
    return out;
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (bytes > maxPatchBytes) throw new CollaborationError("invalid-proposal", `Proposal is ${bytes} bytes; limit is ${maxPatchBytes}`);
  return { summary: String(raw.summary || "").slice(0, 2000), patches: clean, bytes };
}

// ---------------------------------------------------------------- scheduler
/**
 * @param {object} options
 * @param {{complete(request):Promise<{content?:string|object, output?:object, usage?:{inputTokens?:number,outputTokens?:number,totalTokens?:number}}>}} options.model
 * @param {{load(runId):Promise<object|null>, save(runId,state):Promise<void>}} [options.persistence]
 * @param {{recall(query):Promise<Array>, record(entry):Promise<void>}} [options.memory]
 * @param {{ask({runId,questions,missing,signal}):Promise<object>}} [options.needs]
 * @param {{verify(artifact,{task,signal}):Promise<{passed:boolean,findings?:string[]}>}} [options.verifier]
 * @param {{put(artifact):Promise<void>}} [options.artifacts]
 */
export class CollaborationScheduler {
  constructor({ model, persistence = createMemoryPersistence(), memory = NOOP_MEMORY, memoryFailurePolicy = "halt", allowAdvisory = false, protectedPaths = [], hostMaintenance = null, needs = null, verifier = null, artifacts = null, roster, limits = {}, clock = { now: () => Date.now() }, onEvent = () => {}, signal } = {}) {
    if (!model || typeof model.complete !== "function") throw new CollaborationError("invalid-config", "An injected model adapter with complete(request) is required");
    if (!persistence || typeof persistence.load !== "function" || typeof persistence.save !== "function") throw new CollaborationError("invalid-config", "Persistence must implement load(runId) and save(runId, state)");
    if (typeof memory?.recall !== "function" || typeof memory?.record !== "function") throw new CollaborationError("invalid-config", "Memory hooks must implement recall() and record()");
    if (!MEMORY_FAILURE_POLICIES.includes(memoryFailurePolicy)) throw new CollaborationError("invalid-config", `memoryFailurePolicy must be one of ${MEMORY_FAILURE_POLICIES.join(", ")}`);
    // Real (non-default) memory fails closed unless best-effort is chosen explicitly.
    this.memoryFailurePolicy = memoryFailurePolicy;
    this.memoryStrict = memory !== NOOP_MEMORY && memoryFailurePolicy === "halt";
    if (needs && typeof needs.ask !== "function") throw new CollaborationError("invalid-config", "Needs provider must implement ask()");
    if (verifier && typeof verifier.verify !== "function") throw new CollaborationError("invalid-config", "Verifier must implement verify()");
    if (artifacts && typeof artifacts.put !== "function") throw new CollaborationError("invalid-config", "Artifact sink must implement put()");
    if (typeof allowAdvisory !== "boolean") throw new CollaborationError("invalid-config", "allowAdvisory must be boolean");
    this.allowAdvisory = allowAdvisory;
    if (!Array.isArray(protectedPaths)) throw new CollaborationError("invalid-config", "protectedPaths must be an array");
    this.protectedPaths = Object.freeze(protectedPaths.map(p => safeRelative(p, "protected path")));
    if (hostMaintenance !== null) {
      if (!plainObject(hostMaintenance) || typeof hostMaintenance.reason !== "string" || !hostMaintenance.reason.trim() || !Array.isArray(hostMaintenance.authorizedPaths) || !hostMaintenance.authorizedPaths.length)
        throw new CollaborationError("invalid-config", "hostMaintenance requires a reason and non-empty authorizedPaths");
    }
    this.maintenancePaths = Object.freeze((hostMaintenance?.authorizedPaths ?? []).map(p => {
      const n = safeRelative(p, "maintenance path");
      if (isSecretPath(n)) throw new CollaborationError("invalid-config", `Secrets cannot be authorized for maintenance: ${n}`);
      return n;
    }));
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    for (const [k, v] of Object.entries(this.limits)) if (!isPositiveInt(v)) throw new CollaborationError("invalid-config", `Limit ${k} must be a positive integer`);
    this.roster = createRoster(roster);
    Object.assign(this, { model, persistence, memory, needsProvider: needs, verifier, artifactSink: artifacts, clock, onEvent });
    this.controller = new AbortController();
    if (signal) { if (signal.aborted) this.controller.abort(signal.reason); else signal.addEventListener("abort", () => this.controller.abort(signal.reason), { once: true }); }
    this.semaphore = createSemaphore(this.limits.maxConcurrency);
    this.inflight = new Map(); // idempotency key -> promise (call dedup)
    this.runs = new Map();     // runId -> promise (run dedup)
    this.saveChain = Promise.resolve();
  }

  slots(role) { return this.roster.filter(s => s.role === role); }
  cancel(reason = "cancelled") { this.controller.abort(reason); }
  get signal() { return this.controller.signal; }

  /** Start or resume a run. Concurrent calls for the same runId share one execution. */
  run(input = {}) {
    const runId = String(input.runId || "");
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(runId)) return Promise.reject(new CollaborationError("invalid-run", "runId is required (1-128 safe characters)"));
    if (this.runs.has(runId)) return this.runs.get(runId);
    const promise = this.#execute(runId, input).finally(() => this.runs.delete(runId));
    this.runs.set(runId, promise);
    return promise;
  }

  /** Merge operational-need answers into a persisted run (e.g. after status "awaiting-needs"). */
  async provideNeeds(runId, answers) {
    const state = await this.persistence.load(runId);
    if (!state) throw new CollaborationError("unknown-run", `No run ${runId}`);
    validateRunState(state, runId);
    state.needs.answers = { ...state.needs.answers, ...sanitizeAnswers(answers) };
    if (state.status === "awaiting-needs") state.status = "pending";
    await this.#save(state);
    return this.#result(state);
  }

  async status(runId) { const state = await this.persistence.load(runId); if (state) validateRunState(state, runId); return state ? this.#result(state) : null; }

  // ---------------------------------------------------------- internals
  async #execute(runId, input) {
    let state;
    try {
      state = await this.persistence.load(runId);
      if (state) validateRunState(state, runId);
    } catch (error) {
      // Fail closed: never overwrite or continue from unreadable/corrupt state; no model calls.
      const code = error instanceof CollaborationError && error.code === "persistence-corrupt" ? "persistence-corrupt" : "persistence-failure";
      try { this.onEvent({ type: "persistence-failure", runId, code, message: error?.message ?? String(error) }); } catch { /* ignore */ }
      return { runId, status: "persistence-failure", stopReason: `${code}: ${error?.message ?? error}`, persisted: false, rounds: 0, tokensUsed: 0, questions: [], tasks: [], artifacts: [] };
    }
    if (state && TERMINAL_STATUSES.includes(state.status)) return this.#result(state); // idempotent replay
    if (!state) state = this.#initialState(runId, input);
    else if (input.needs) state.needs.answers = { ...state.needs.answers, ...sanitizeAnswers(input.needs) };
    FATAL.delete(state);
    const ctx = { state, startedAt: this.clock.now() };
    let rethrow = null;
    try {
      this.#check(ctx);
      state.status = "running";
      if (!state.needs.resolved) { await this.#needsPhase(ctx); if (!state.needs.resolved) { state.status = "awaiting-needs"; this.#event(state, "awaiting-needs", { missing: state.needs.missing }); await this.#save(state); return this.#result(state); } }
      if (!state.planned) await this.#planPhase(ctx);
      await this.#cycles(ctx);
    } catch (error) {
      const stop = FATAL.get(state) ?? error;
      if (stop instanceof StopSignal) { state.status = stop.reason; state.stopReason = stop.message; }
      else if (stop instanceof CollaborationError && stop.code === "invalid-plan") { state.status = "failed"; state.stopReason = stop.message; }
      else { state.status = "interrupted"; state.stopReason = stop?.message || String(stop); rethrow = stop; }
      this.#event(state, "stopped", { status: state.status, reason: state.stopReason });
    }
    if (state.status === "persistence-failure") return this.#result(state, false);
    if (state.status !== "memory-failure" && !rethrow) {
      try { await this.#remember(state, "outcome", { status: state.status, reason: state.stopReason, approved: Object.values(state.artifacts).filter(a => a.status === "approved").map(a => a.id) }); }
      catch (error) { if (!(error instanceof StopSignal)) throw error; state.status = error.reason; state.stopReason = error.message; this.#event(state, "stopped", { status: state.status, reason: state.stopReason }); }
    }
    try { await this.#save(state); }
    catch (error) {
      if (!(error instanceof StopSignal)) throw error;
      if (rethrow) throw rethrow;
      state.status = error.reason; state.stopReason = error.message;
      return this.#result(state, false);
    }
    if (rethrow) throw rethrow;
    return this.#result(state);
  }

  #fatal(state, reason, message) {
    if (!FATAL.has(state)) { FATAL.set(state, new StopSignal(reason, message)); this.#event(state, reason, { message }); }
    return FATAL.get(state);
  }

  #initialState(runId, input) {
    const goal = String(input.goal || "").trim();
    if (!goal) throw new CollaborationError("invalid-run", "A goal is required for a new run");
    return {
      version: COLLABORATION_VERSION, runId, goal, status: "pending", stopReason: null,
      roster: this.roster.map(s => ({ id: s.id, role: s.role })),
      needs: { questions: [], answers: sanitizeAnswers(input.needs), missing: [], resolved: false, asked: false },
      planned: false, verifiedByHost: false, round: 0, activeRound: null, tokensUsed: 0, calls: {}, tasks: {}, artifacts: {}, events: [], seq: 0,
    };
  }

  #check(ctx) {
    if (FATAL.has(ctx.state)) throw FATAL.get(ctx.state);
    if (this.signal.aborted) throw new StopSignal("cancelled", String(this.signal.reason ?? "cancelled"));
    if (this.clock.now() - ctx.startedAt > this.limits.maxDurationMs) throw new StopSignal("time-limit", `Exceeded ${this.limits.maxDurationMs}ms`);
    if (ctx.state.tokensUsed >= this.limits.maxTokens) throw new StopSignal("token-limit", `Used ${ctx.state.tokensUsed} of ${this.limits.maxTokens} tokens`);
  }

  #event(state, type, data = {}) {
    const event = { seq: ++state.seq, type, round: state.activeRound ?? state.round, ...data };
    state.events.push(event);
    if (state.events.length > this.limits.maxEvents) state.events.splice(0, state.events.length - this.limits.maxEvents);
    try { this.onEvent(clone(event)); } catch { /* observer errors are ignored */ }
  }

  #save(state) {
    const snapshot = clone(state);
    const pending = this.saveChain.then(() => this.persistence.save(state.runId, snapshot));
    this.saveChain = pending.catch(() => {});
    return pending.catch(error => { throw this.#fatal(state, "persistence-failure", `Persistence save failed: ${error?.message ?? error}`); });
  }

  async #recall(state, phase, slot, query) {
    if (FATAL.has(state)) throw FATAL.get(state);
    try {
      const r = await this.memory.recall({ runId: state.runId, phase, slot: slot.id, role: slot.role, query });
      if (!Array.isArray(r)) throw new CollaborationError("memory-corrupt", "recall() must return an array");
      return clone(r.slice(0, 20));
    } catch (error) {
      if (this.memoryStrict) throw this.#fatal(state, "memory-failure", `Memory recall failed (${phase}): ${error?.message ?? error}`);
      this.#event(state, "memory-error", { op: "recall", message: error?.message ?? String(error) }); return [];
    }
  }
  async #remember(state, kind, data, extra = {}) {
    if (FATAL.has(state)) throw FATAL.get(state);
    try { await this.memory.record({ runId: state.runId, kind, round: state.activeRound ?? state.round, ...extra, data: clone(data) }); }
    catch (error) {
      if (this.memoryStrict) throw this.#fatal(state, "memory-failure", `Memory record failed (${kind}): ${error?.message ?? error}`);
      this.#event(state, "memory-error", { op: "record", kind, message: error?.message ?? String(error) });
    }
  }

  /** Idempotent, budgeted, concurrency-limited model invocation. */
  async #call(ctx, slot, phase, input, keyParts) {
    const { state } = ctx;
    const key = hashOf({ runId: state.runId, phase, slot: slot.id, ...keyParts });
    if (state.calls[key]) return state.calls[key].output;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const promise = this.semaphore.run(async () => {
      this.#check(ctx);
      // Reserve a local estimate of the prompt before calling; never trust the model for spend accounting.
      const reserve = estimateTokens(input);
      const remaining = this.limits.maxTokens - state.tokensUsed - reserve;
      if (remaining < 1) throw new StopSignal("token-limit", `Reserving ${reserve} prompt tokens would exceed ${this.limits.maxTokens} (used ${state.tokensUsed})`);
      const maxTokens = Math.min(this.limits.maxTokensPerCall, remaining);
      const request = { idempotencyKey: key, runId: state.runId, phase, slot: { id: slot.id, role: slot.role, model: slot.model, instructions: slot.instructions }, input: clone(input), maxTokens, signal: this.signal };
      this.#event(state, "call", { phase, slot: slot.id, key: key.slice(0, 16), taskId: keyParts.taskId });
      const result = await abortable(Promise.resolve().then(() => this.model.complete(request)), this.signal);
      const { tokens, invalid } = chargeUsage(result, reserve);
      if (invalid) this.#event(state, "usage-invalid", { phase, slot: slot.id, fields: invalid });
      state.tokensUsed += tokens;
      let output, parseError = null;
      try { output = parseModelOutput(result); } catch (error) { parseError = error.message; output = { __invalid: parseError }; }
      state.calls[key] = { phase, slot: slot.id, tokens, output };
      await this.#save(state);
      if (state.tokensUsed > this.limits.maxTokens) throw new StopSignal("token-limit", `Used ${state.tokensUsed} of ${this.limits.maxTokens} tokens`);
      return output;
    });
    this.inflight.set(key, promise);
    try { return await promise; } finally { this.inflight.delete(key); }
  }

  async #needsPhase(ctx) {
    const { state } = ctx;
    const slot = this.slots("needs")[0];
    if (!state.needs.questions.length) {
      const memory = await this.#recall(state, "needs", slot, state.goal);
      const out = await this.#call(ctx, slot, "needs", { goal: state.goal, baseline: BASELINE_NEEDS, known: state.needs.answers, memory }, { step: "questions" });
      const extra = Array.isArray(out?.questions) ? out.questions : [];
      const merged = new Map(BASELINE_NEEDS.map(q => [q.id, { ...q }]));
      for (const q of extra) {
        if (!q || typeof q.question !== "string") continue;
        const id = String(q.id || q.question).replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 64);
        if (!merged.has(id)) merged.set(id, { id, question: q.question.slice(0, 500), required: q.required === true });
      }
      state.needs.questions = [...merged.values()];
      this.#event(state, "needs-questions", { count: state.needs.questions.length });
    }
    const missing = () => {
      const out = state.needs.questions.filter(q => q.required && !hasAnswer(state.needs.answers[q.id])).map(q => q.id);
      state.needs.invalid = {};
      if (!out.includes("allowedPaths")) {
        try { normalizeAllowedPaths(state.needs.answers.allowedPaths); }
        catch (error) { out.push("allowedPaths"); state.needs.invalid.allowedPaths = error.message; }
      }
      return out;
    };
    if (missing().length && this.needsProvider && !state.needs.asked) {
      this.#check(ctx);
      const answers = await abortable(Promise.resolve(this.needsProvider.ask({ runId: state.runId, goal: state.goal, questions: clone(state.needs.questions), missing: missing(), signal: this.signal })), this.signal);
      state.needs.answers = { ...state.needs.answers, ...sanitizeAnswers(answers) };
      state.needs.asked = true;
    }
    state.needs.missing = missing();
    state.needs.resolved = state.needs.missing.length === 0;
    if (state.needs.resolved) { this.#event(state, "needs-resolved", {}); await this.#remember(state, "needs", state.needs.answers); }
    await this.#save(state);
  }

  #allowedPaths(state) {
    try { return normalizeAllowedPaths(state.needs.answers.allowedPaths); } catch { return []; } // empty => every patch refused
  }

  async #planPhase(ctx) {
    const { state } = ctx;
    const slot = this.slots("planner")[0];
    const memory = await this.#recall(state, "plan", slot, state.goal);
    const out = await this.#call(ctx, slot, "plan", { goal: state.goal, needs: state.needs.answers, maxTasks: this.limits.maxTasks, memory }, { step: "plan" });
    if (out?.__invalid) throw new CollaborationError("invalid-plan", `Planner output invalid: ${out.__invalid}`);
    state.tasks = normalizePlan(out?.tasks, { maxTasks: this.limits.maxTasks });
    state.planned = true;
    this.#event(state, "planned", { tasks: Object.keys(state.tasks) });
    await this.#remember(state, "plan", Object.values(state.tasks).map(({ id, title, dependsOn }) => ({ id, title, dependsOn })));
    await this.#save(state);
  }

  async #cycles(ctx) {
    const { state } = ctx;
    const builders = this.slots("builder");
    for (;;) {
      propagateBlocked(state.tasks);
      const tasks = Object.values(state.tasks);
      if (tasks.every(t => t.status === "done")) {
        // Model tests and reviews are advisory. Only an injected deterministic host verifier makes a run "completed".
        state.verifiedByHost = this.verifier !== null;
        state.status = state.verifiedByHost || this.allowAdvisory ? "completed" : "needs-host-verification";
        state.stopReason = state.verifiedByHost ? "all tasks approved and host-verified" : "all tasks peer-approved; model checks are advisory and not host-verified";
        this.#event(state, state.status, { verifiedByHost: state.verifiedByHost });
        return;
      }
      if (state.activeRound !== null && !tasks.some(t => t.status === "in-progress")) state.activeRound = null; // crash after round finished
      const ready = state.activeRound !== null ? tasks.filter(t => t.status === "in-progress") : readyTasks(state.tasks);
      if (!ready.length) {
        const failed = tasks.filter(t => t.status === "failed").map(t => t.id);
        state.status = "failed"; state.stopReason = `No runnable tasks; failed: ${failed.join(", ") || "none"}; blocked: ${tasks.filter(t => t.status === "blocked").map(t => t.id).join(", ") || "none"}`;
        return;
      }
      if (state.activeRound === null) {
        if (state.round >= this.limits.maxRounds) throw new StopSignal("round-limit", `Reached ${this.limits.maxRounds} rounds`);
        this.#check(ctx);
        state.round += 1; state.activeRound = state.round;
        for (const t of ready) { t.status = "in-progress"; t.assignee ??= builders[Object.keys(state.tasks).indexOf(t.id) % builders.length].id; }
        this.#event(state, "round-start", { tasks: ready.map(t => t.id) });
        await this.#save(state);
      }
      const results = await Promise.allSettled(ready.map(task => this.#taskCycle(ctx, task)));
      const stop = results.find(r => r.status === "rejected");
      if (stop) throw FATAL.get(state) ?? stop.reason;
      state.activeRound = null;
      this.#event(state, "round-end", { done: Object.values(state.tasks).filter(t => t.status === "done").length });
      await this.#save(state);
    }
  }

  async #taskCycle(ctx, task) {
    const { state } = ctx;
    const round = state.activeRound;
    const author = this.roster.find(s => s.id === task.assignee) || this.slots("builder")[0];
    const attempt = task.attempts;
    const reject = async (reason, findings, artifact) => {
      task.feedback.push({ round, attempt, reason, findings: findings.slice(0, 20) });
      task.attempts += 1;
      task.status = task.attempts >= this.limits.maxAttemptsPerTask ? "failed" : "pending";
      if (artifact) artifact.status = "rejected";
      this.#event(state, "task-rejected", { taskId: task.id, reason, final: task.status === "failed" });
      await this.#remember(state, "review", { reason, findings }, { taskId: task.id });
    };

    // build
    const deps = task.dependsOn.map(d => ({ id: d, title: state.tasks[d].title, approved: state.tasks[d].proposals.map(id => state.artifacts[id]).filter(a => a?.status === "approved").map(a => ({ id: a.id, summary: a.summary, paths: a.patches.map(p => p.path) })) }));
    const memory = await this.#recall(state, "build", author, task.title);
    const raw = await this.#call(ctx, author, "build", { goal: state.goal, needs: state.needs.answers, task: pickTask(task), dependencies: deps, feedback: task.feedback, memory, contract: "Return {summary, patches:[{path, op:create|modify|delete, diff|content}]}. Never return commands." }, { taskId: task.id, attempt, step: "build" });
    let proposal;
    try {
      if (raw?.__invalid) throw new CollaborationError("invalid-output", raw.__invalid);
      proposal = validateProposal(raw, { allowedPaths: this.#allowedPaths(state), protectedPaths: this.protectedPaths, maintenancePaths: this.maintenancePaths, maxPatchBytes: this.limits.maxPatchBytes, maxFilesPerProposal: this.limits.maxFilesPerProposal });
    } catch (error) { return reject(error.code || "invalid-proposal", [error.message]); }
    const contentHash = hashOf({ taskId: task.id, patches: proposal.patches });
    const id = `patch-${contentHash.slice(0, 16)}`;
    const existing = state.artifacts[id];
    if (existing && existing.status === "rejected") return reject("duplicate-proposal", [`Proposal ${id} is identical to a previously rejected proposal`]);
    if (existing && existing.status === "approved") { task.status = "done"; return; }
    const artifact = existing || { id, kind: "patch-proposal", taskId: task.id, author: author.id, round, attempt, hash: contentHash, summary: proposal.summary, patches: proposal.patches, bytes: proposal.bytes, status: "proposed", tests: [], reviews: [] };
    if (!existing) { state.artifacts[id] = artifact; task.proposals.push(id); this.#event(state, "proposal", { taskId: task.id, artifactId: id }); await this.#remember(state, "proposal", { id, summary: artifact.summary, paths: artifact.patches.map(p => p.path) }, { taskId: task.id }); }
    await this.#save(state);

    // test
    const testers = this.slots("tester");
    const findings = [];
    let passed = true;
    const testOutputs = await Promise.all(testers.map(slot => this.#call(ctx, slot, "test", { task: pickTask(task), needs: state.needs.answers, proposal: publicArtifact(artifact) }, { taskId: task.id, artifactId: id, step: "test" })));
    testOutputs.forEach((out, i) => {
      const ok = out?.passed === true;
      artifact.tests.push({ slot: testers[i].id, passed: ok, findings: listOf(out?.findings ?? out?.__invalid) });
      if (!ok) { passed = false; findings.push(...listOf(out?.findings ?? out?.__invalid ?? "tester did not pass the proposal")); }
    });
    if (this.verifier) {
      this.#check(ctx);
      const v = await abortable(Promise.resolve(this.verifier.verify(publicArtifact(artifact), { task: pickTask(task), signal: this.signal })), this.signal);
      artifact.tests.push({ slot: "verifier", passed: v?.passed === true, findings: listOf(v?.findings) });
      if (v?.passed !== true) { passed = false; findings.push(...listOf(v?.findings ?? "verifier rejected the proposal")); }
    }
    await this.#remember(state, "test", { artifactId: id, passed, findings }, { taskId: task.id });
    if (!passed) return reject("tests-failed", findings, artifact);

    // peer review: every reviewer slot plus one builder that is not the author
    const peer = this.slots("builder").find(s => s.id !== author.id);
    const reviewers = [...this.slots("reviewer"), ...(peer ? [peer] : [])].filter(s => s.id !== author.id);
    const reviews = await Promise.all(reviewers.map(slot => this.#call(ctx, slot, "review", { task: pickTask(task), needs: state.needs.answers, proposal: publicArtifact(artifact), tests: artifact.tests }, { taskId: task.id, artifactId: id, step: "review" })));
    const comments = [];
    let approved = reviews.length > 0;
    reviews.forEach((out, i) => {
      const verdict = out?.verdict === "approve" ? "approve" : "request-changes";
      artifact.reviews.push({ slot: reviewers[i].id, verdict, comments: listOf(out?.comments ?? out?.__invalid) });
      if (verdict !== "approve") { approved = false; comments.push(...listOf(out?.comments ?? out?.__invalid ?? "changes requested")); }
    });
    if (!approved) return reject("changes-requested", comments, artifact);
    artifact.status = "approved";
    task.status = "done";
    this.#event(state, "task-done", { taskId: task.id, artifactId: id });
    await this.#remember(state, "approval", { artifactId: id, reviewers: reviewers.map(r => r.id) }, { taskId: task.id });
    if (this.artifactSink) await this.artifactSink.put(clone(artifact));
  }

  #result(state, persisted = true) {
    return clone({
      runId: state.runId, status: state.status, stopReason: state.stopReason, verifiedByHost: state.verifiedByHost === true, persisted, rounds: state.round, tokensUsed: state.tokensUsed,
      questions: state.status === "awaiting-needs" ? state.needs.questions.filter(q => state.needs.missing.includes(q.id)).map(q => (state.needs.invalid?.[q.id] ? { ...q, invalid: state.needs.invalid[q.id] } : q)) : [],
      tasks: Object.values(state.tasks).map(t => ({ id: t.id, title: t.title, status: t.status, dependsOn: t.dependsOn, attempts: t.attempts, assignee: t.assignee })),
      artifacts: Object.values(state.artifacts).filter(a => a.status === "approved"),
    });
  }
}

const nonNegativeInt = v => Number.isSafeInteger(v) && v >= 0;
/** Spend accounting: reported usage only counts when every field is a non-negative safe integer, and never below the local estimate. */
export function chargeUsage(result, promptEstimate = 0) {
  const usage = result && typeof result === "object" && result.usage && typeof result.usage === "object" ? result.usage : {};
  const invalid = ["inputTokens", "outputTokens", "totalTokens"].filter(k => usage[k] !== undefined && !nonNegativeInt(usage[k]));
  const content = result && typeof result === "object" ? (result.content ?? result.text ?? result.output ?? "") : (result ?? "");
  const estimate = promptEstimate + estimateTokens(content);
  let reported = 0;
  if (!invalid.length) reported = usage.totalTokens !== undefined ? usage.totalTokens : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  return { tokens: Math.max(estimate, Number.isSafeInteger(reported) ? reported : 0), invalid: invalid.length ? invalid : null };
}
const plainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);
/** Structural check of persisted run state; throws persistence-corrupt so callers fail closed. */
export function validateRunState(state, runId) {
  const bad = why => { throw new CollaborationError("persistence-corrupt", `Persisted run state is corrupt: ${why}`); };
  if (!plainObject(state)) bad("not an object");
  if (state.version !== COLLABORATION_VERSION) bad(`unsupported version ${state.version}`);
  if (runId !== undefined && state.runId !== runId) bad("runId mismatch");
  if (typeof state.goal !== "string" || typeof state.status !== "string") bad("goal/status");
  for (const k of ["round", "tokensUsed", "seq"]) if (!Number.isSafeInteger(state[k]) || state[k] < 0) bad(k);
  if (state.activeRound !== null && !Number.isSafeInteger(state.activeRound)) bad("activeRound");
  if (!plainObject(state.needs) || !plainObject(state.needs.answers) || !Array.isArray(state.needs.questions) || !Array.isArray(state.needs.missing)) bad("needs");
  for (const k of ["tasks", "artifacts", "calls"]) if (!plainObject(state[k])) bad(k);
  if (!Array.isArray(state.events)) bad("events");
  for (const [id, t] of Object.entries(state.tasks)) {
    if (!plainObject(t) || t.id !== id || !TASK_STATUSES.has(t.status) || !Array.isArray(t.dependsOn) || !Array.isArray(t.feedback) || !Array.isArray(t.proposals) || !Number.isSafeInteger(t.attempts)) bad(`task ${id}`);
    if (t.dependsOn.some(d => !Object.hasOwn(state.tasks, d))) bad(`task ${id} dependency`);
    if (t.proposals.some(p => !Object.hasOwn(state.artifacts, p))) bad(`task ${id} proposal`);
  }
  for (const [id, a] of Object.entries(state.artifacts)) if (!plainObject(a) || a.id !== id || !Array.isArray(a.patches) || !Object.hasOwn(state.tasks, a.taskId)) bad(`artifact ${id}`);
  for (const [key, c] of Object.entries(state.calls)) if (!plainObject(c) || !/^[0-9a-f]{64}$/.test(key) || !Number.isSafeInteger(c.tokens)) bad("call cache");
  return state;
}

function hasAnswer(v) { return v !== undefined && v !== null && !(typeof v === "string" && !v.trim()) && !(Array.isArray(v) && !v.length); }
function sanitizeAnswers(answers) {
  if (!answers || typeof answers !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(answers)) if (/^[A-Za-z0-9_-]{1,64}$/.test(k) && hasAnswer(v)) out[k] = clone(v);
  return out;
}
const listOf = v => (v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]).map(x => String(typeof x === "object" ? stableStringify(x) : x).slice(0, 1000)));
const pickTask = t => ({ id: t.id, title: t.title, description: t.description, dependsOn: t.dependsOn });
const publicArtifact = a => ({ id: a.id, taskId: a.taskId, author: a.author, summary: a.summary, patches: a.patches });

export function createCollaboration(options) { return new CollaborationScheduler(options); }

/**
 * Bind seven model identifiers (opaque strings, e.g. from a host cohort list) to roster slots in order.
 * `models` may be an array of 7 ids/objects ({model, id?, role?, instructions?}) or a slotId->model map.
 */
export function rosterFromModels(models, base = DEFAULT_ROSTER) {
  if (Array.isArray(models)) {
    if (models.length !== ROSTER_SIZE) throw new CollaborationError("invalid-roster", `Expected ${ROSTER_SIZE} models`);
    return createRoster(base.map((slot, i) => (typeof models[i] === "string" ? { ...slot, model: models[i] } : { ...slot, ...models[i] })));
  }
  if (models && typeof models === "object") return createRoster(Object.fromEntries(Object.entries(models).map(([id, m]) => [id, typeof m === "string" ? { model: m } : m])));
  throw new CollaborationError("invalid-roster", "models must be an array or slot-keyed object");
}

/**
 * Continuity bundle for bootstrap: wraps host persistence + memory so a CLI can resume runs across processes.
 * Each argument is optional; unspecified parts fall back to in-memory/no-op implementations.
 */
export function createContinuity({ persistence, memory, continuity, prefix } = {}) {
  if (memory && continuity) throw new CollaborationError("invalid-config", "Pass memory or continuity, not both");
  return { persistence: persistence ?? createMemoryPersistence(), memory: memory ?? (continuity ? memoryFromContinuity(continuity, { prefix }) : NOOP_MEMORY) };
}

/**
 * Adapt any continuity journal exposing `remember(kind, content)` and `recall({kind?, limit?})`
 * (duck-typed; no import of a concrete module) into collaboration memory hooks.
 * Fails closed when the journal reports `verify() === false`, or is non-durable
 * (`status().durable === false`) while `requireDurable` is true (the default).
 * Content is canonicalized (non-integer numbers become strings, undefined dropped) and
 * entries larger than `maxEntryBytes` are replaced with a digest stub.
 */
export function memoryFromContinuity(continuity, { prefix = "collab", limit = 20, requireDurable = true, maxEntryBytes = 12 * 1024 } = {}) {
  if (typeof continuity?.remember !== "function" || typeof continuity?.recall !== "function") throw new CollaborationError("invalid-config", "continuity must implement remember(kind, content) and recall(query)");
  if (!/^[a-z][a-z0-9_-]{0,23}$/.test(prefix)) throw new CollaborationError("invalid-config", "prefix must match [a-z][a-z0-9_-]{0,23}");
  const guard = () => {
    if (typeof continuity.verify === "function" && continuity.verify() !== true) throw new CollaborationError("memory-corrupt", "continuity journal failed verification");
    if (requireDurable && typeof continuity.status === "function" && continuity.status()?.durable === false) throw new CollaborationError("memory-not-durable", "continuity journal is not durable");
  };
  const canonical = value => JSON.parse(JSON.stringify(value, (k, x) => (typeof x === "number" && !Number.isSafeInteger(x) ? String(x) : x)) ?? "null");
  return {
    async recall({ runId, phase }) {
      guard();
      const entries = await continuity.recall({ limit: limit * 5 });
      if (!Array.isArray(entries)) throw new CollaborationError("memory-corrupt", "continuity recall() must return an array");
      return entries
        .filter(e => typeof e?.kind === "string" && e.kind.startsWith(`${prefix}:`))
        .map(e => ({ kind: e.kind, runId: e.content?.runId, round: e.content?.round, taskId: e.content?.taskId, data: e.content?.data }))
        .filter(e => phase === "needs" || e.runId === runId || e.kind === `${prefix}:outcome`)
        .slice(-limit);
    },
    async record({ kind, ...rest }) {
      guard();
      let content = canonical(rest);
      const bytes = Buffer.byteLength(JSON.stringify(content));
      if (bytes > maxEntryBytes) content = canonical({ runId: rest.runId, round: rest.round, taskId: rest.taskId, data: { truncated: true, bytes, sha256: hashOf(content) } });
      await continuity.remember(`${prefix}:${String(kind).toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`, content);
    },
  };
}
