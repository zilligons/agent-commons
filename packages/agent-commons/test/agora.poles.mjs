// Source-mutant poles for @uuaid/agent-commons/agora (RedTeam RT-8, fm-20261109T083342-8315f2; V1 fm-20261109T090125-350bd3).
// Each pole removes ONE guard from a scratch COPY of src/, runs the UNCHANGED test/agora.test.mjs, and must turn its
// NAMED assertion red. The unchanged CONTROL must stay fully green. A pole whose named test does not fail proves its
// guard is untested, and fails this run. Run: node test/agora.poles.mjs   (exit 0 = every pole bites).
import { mkdtempSync, cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const source = fileURLToPath(new URL("../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "agora-poles-"));
const replace = (text, before, after) => { if (text.split(before).length !== 2) throw new Error(`Mutation target must be unique: ${before}`); return text.replace(before, after); };
const AGORA = "src/agora.mjs", JCS = "src/vendor/pillar/identity/jcs.mjs";

// [name, named test(s) that must fail, mutation, file]
const mutations = [
  // [name, named test (prefix), REQUIRED assertion anchor in that test's failure, mutation, file]
  // RT-8 / design §2-F: the six required poles
  ["P1-wrong-JCS-key-order", "a key-derived identity seals a @uuaid/core envelope", "RT4-JCS-canonical-key-order",
    (t) => replace(t, "const keys = Object.keys(v).sort();", "const keys = Object.keys(v);"), JCS],
  ["P2-capability-nonce-reused", "the full write flow against a loopback Agora", "RT6-fresh-nonce-per-write",
    (t) => replace(t, 'const nonce = randomBytes(18).toString("base64url");', 'const nonce = "fixed-nonce-reused-every-write";'), AGORA],
  ["P3-paid-contribution-allowed", "AgoraPublisher: commons/1 §8 refuses before any network call", "RT5-refuses-PAID_TERMS",
    (t) => replace(t, 'if (c.terms !== "free") fail("PAID_TERMS"', 'if (false) fail("PAID_TERMS"'), AGORA],
  ["P4-missing-consent-allowed", "AgoraPublisher: commons/1 §8 refuses before any network call", "RT5-refuses-NO_CONSENT",
    (t) => replace(t, 'if (c.requesterConsent !== true) fail("NO_CONSENT"', 'if (false) fail("NO_CONSENT"'), AGORA],
  ["P5-partner-key-not-env-only", "the partner key is read only from the environment", "RT1-partner-key-env-only",
    (t) => replace(t, "const value = env?.[name];", "const value = env?.[name] ?? process.argv.find((a) => a.startsWith(\"pk_\")) ?? \"fallback-partner-key-from-argv\";"), AGORA],
  ["P6-egress-while-offline", "egress is allowed ONLY when AGENT_COMMONS_OFFLINE is exactly", "RT2-offline-blocks-egress",
    (t) => replace(t, 'if (!agoraEgressAllowed(this.#env)) fail("OFFLINE"', 'if (false) fail("OFFLINE"'), AGORA],
  // V1 findings: each fix must also be shown to be load-bearing
  ["F1-binding-any-key", "V1-F1:", "V1-F1-other-key-binding-refused",
    (t) => replace(t, "if (linked.pillar_uuaid !== signerUuaid", "if (false && linked.pillar_uuaid !== signerUuaid"), AGORA],
  ["F2-sparse-holes-accepted", "V1-F2:", "V1-F2-sparse-array-refused",
    (t) => replace(replace(t, "if (Object.keys(value).length !== value.length)", "if (false)"),
      "if (!Object.prototype.hasOwnProperty.call(value, i))", "if (false)"), AGORA],
  ["F3-secret-not-redacted", "V1-F3:", "V1-F3-message-redacted",
    (t) => replace(t, "const clean = (v) => redactSecret(String(v), key).slice(0, 300);", "const clean = (v) => String(v).slice(0, 300);"), AGORA],
  ["F3b-short-partner-key-accepted", "V1-F3b:", "refused: 7 chars",
    (t) => replace(t, "if (trimmed.length < PARTNER_KEY_MIN_LENGTH || !PARTNER_KEY_SHAPE.test(trimmed)) fail(\"BAD_PARTNER_KEY\"", "if (false) fail(\"BAD_PARTNER_KEY\""), AGORA],
  ["F3c-short-secret-not-redacted", "V1-F3b:", "V1-F3b-message-redacted",
    (t) => replace(t, 'if (typeof secret !== "string" || secret.length === 0) return text;', 'if (typeof secret !== "string" || secret.length < 32) return text;'), AGORA],
  ["F4-impossible-timestamp-accepted", "V1-F4:", "V1-F4-impossible-timestamp-refused",
    (t) => replace(t, 'if (!isValidUtcTimestamp(at)) fail("ISSUED_AT"', 'if (false) fail("ISSUED_AT"'), AGORA],
];

let expectedTests;
// The TAP failure block of one named test (from "not ok ... - <name>" to its closing "  ...").
function failureBlock(stdout, prefix) {
  const lines = stdout.split("\n"); const i = lines.findIndex((l) => /^not ok \d+ - /.test(l) && l.replace(/^not ok \d+ - /, "").startsWith(prefix));
  if (i < 0) return null; const end = lines.findIndex((l, j) => j > i && /^  \.\.\.$/.test(l));
  return lines.slice(i, end < 0 ? undefined : end + 1).join("\n");
}
function run(name, target, anchor, mutate, file) {
  const root = join(scratch, name); mkdirSync(root);
  cpSync(join(source, "src"), join(root, "src"), { recursive: true });
  cpSync(join(source, "package.json"), join(root, "package.json"));
  symlinkSync(join(source, "node_modules"), join(root, "node_modules"), "dir"); // the real installed dependencies, unmutated
  mkdirSync(join(root, "test")); cpSync(join(source, "test/agora.test.mjs"), join(root, "test/agora.test.mjs"));
  if (mutate) { const path = join(root, file); writeFileSync(path, mutate(readFileSync(path, "utf8"))); }
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "test/agora.test.mjs"], { cwd: root, encoding: "utf8", timeout: 60000 });
  const count = (label) => Number(result.stdout.match(new RegExp(`# ${label} (\\d+)`))?.[1] ?? 0);
  writeFileSync(join(root, "result.log"), result.stdout + result.stderr);
  if (name === "CONTROL") expectedTests = count("tests");
  if (result.signal || result.error || !expectedTests || count("tests") !== expectedTests || count("cancelled") !== 0) throw new Error(`Pole did not complete: ${name} (${join(root, "result.log")})`);
  const failures = [...result.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  if (!target) return { name, rc: result.status, tests: count("tests"), pass: count("pass"), fail: count("fail"), failures };
  // V1 RT-8: a red counts ONLY as an assertion red. The named test must fail with ERR_ASSERTION, and its failure must
  // carry this pole's own anchor. A thrown CONFLICT, a TypeError or any other exception is NOT assertion evidence.
  const block = failureBlock(result.stdout, target) ?? "";
  const namedTestFailed = block.length > 0;
  const assertionRed = /code: 'ERR_ASSERTION'/.test(block);
  const anchorHit = block.includes(anchor);
  return { name, rc: result.status, tests: count("tests"), pass: count("pass"), fail: count("fail"), failures,
    namedTestFailed, assertionRed, anchor, anchorHit, intendedFailureObserved: namedTestFailed && assertionRed && anchorHit };
}

const control = run("CONTROL", null, null, null, null);
const poles = mutations.map(([name, target, anchor, mutate, file]) => run(name, target, anchor, mutate, file));
const ok = control.rc === 0 && control.fail === 0 && poles.every((p) => p.rc !== 0 && p.fail > 0 && p.intendedFailureObserved);
console.log(JSON.stringify({ scratch, control, poles, ok }, null, 2));
process.exitCode = ok ? 0 : 1;
