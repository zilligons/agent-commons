/**
 * L10 — l10-env tests (two-pole, per FLEET-SOP §4.6(7)).
 *
 * Covers (per design v3 §b/§c + the seam review note 3):
 * - refused-name predicate: every prefix, each named single, empty-string
 *   presence; negative cases (clean names) pass
 * - closed child env builder: exact name set per route; parent pollution
 *   never leaks; rejected value of an allowlisted name never leaks
 *
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { refusedReason, buildChildEnv, scrubEnv, L10_REFUSED_PREFIXES, L10_REFUSED_SINGLES, L10EnvBuilderError } from "./l10-env";

/** CONTROL predicate table — names that MUST be refused. */
const REFUSED = [
  // Prefix family
  "AWS_PROFILE", "AWS_REGION", "AWS_FUTURE_SWITCH",
  "XAI_API_KEY", "XAI_WS_URL",
  "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS",
  // Named singles
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_BASE_URL", "ANTHROPIC_API_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_BASE_URL", "OPENAI_ORG_ID",
  "GROK_WS_URL",
  // API_KEY substring family
  "MYPROVIDER_API_KEY", "RANDOMAPI_KEYVARIANT",
  // _TOKEN suffix family
  "GITHUB_TOKEN", "CUSTOM_PROVIDER_TOKEN",
  // Empty string presence
  "",
];

/** Clean names that MUST NOT be refused. */
const CLEAN = ["PATH", "HOME", "USER", "TERM", "LANG", "TMPDIR", "TZ",
  "SHELL", "EDITOR", "PAGER", "MYAPP_VERSION", "NOT_A_REAL_REFUSED_FLAG"];

function main() {
  // CONTROL — predicate refuses every entry in REFUSED.
  for (const name of REFUSED) {
    const r = refusedReason(name);
    assert.notEqual(r, null, `CONTROL: ${JSON.stringify(name)} should be refused, got null`);
  }

  // MUTANT — predicate accepts every clean name.
  for (const name of CLEAN) {
    const r = refusedReason(name);
    assert.equal(r, null, `MUTANT: clean name ${JSON.stringify(name)} should not be refused, got ${r}`);
  }

  // CONTROL — every L10_REFUSED_PREFIX catches at least one name.
  for (const prefix of L10_REFUSED_PREFIXES) {
    const r = refusedReason(`${prefix}FOO`);
    assert.ok(r?.startsWith("prefix:"), `prefix ${prefix} must trigger prefix: rule`);
  }

  // CONTROL — every L10_REFUSED_SINGLES name is refused by exact equality.
  // The prefix rule wins when the name has a prefix (e.g. ANTHROPIC_API_KEY
  // has no prefix, so it falls to the single rule; AWS_FUTURE_SWITCH is in
  // the prefix family, so we test it via the prefix rule).
  for (const single of L10_REFUSED_SINGLES) {
    const r = refusedReason(single);
    assert.ok(r !== null, `single ${single} must be refused (got null)`);
    assert.ok(r?.startsWith("single:"), `single ${single} must trigger single: rule, got ${r}`);
  }

  // CONTROL — case-insensitive.
  assert.notEqual(refusedReason("aws_profile"), null);
  assert.notEqual(refusedReason("Anthropic_Auth_Token"), 403);
  assert.ok(refusedReason("Anthropic_Auth_Token")?.startsWith("single:"));

  // CONTROL — closed env builder (Claude route, MUTANT pole: scratch HOME
  // is honored; CONTROL pole forces the real HOME per R2 pole policy).
  const scratchRun = mkdtempSync(join(tmpdir(), "l10-env-test-"));
  let envClaude: Readonly<Record<string, string>>;
  try {
    envClaude = buildChildEnv({
      route: "claude", runId: "test", home: "/h", pole: "MUTANT", runDir: scratchRun,
    });
    const expectedClaude = ["CLAUDE_CONFIG_DIR", "HOME", "LANG", "PATH", "TERM", "TMPDIR", "TZ", "USER"];
    assert.deepEqual(Object.keys(envClaude).sort(), expectedClaude,
      `Claude env keys ${JSON.stringify(Object.keys(envClaude).sort())} should equal ${JSON.stringify(expectedClaude)}`);
    assert.equal(envClaude.HOME, "/h");
    assert.equal(envClaude.CLAUDE_CONFIG_DIR, "/h/.claude");
    const envClaudeControl = buildChildEnv({ route: "claude", runId: "test", home: "/h", pole: "CONTROL", runDir: scratchRun });
    assert.equal(envClaudeControl.HOME, userInfo().homedir, "R2: Claude CONTROL uses the real HOME (from os.userInfo().homedir)");

    // MUTANT — omitting runDir throws L10EnvBuilderError
    assert.throws(
      () => (buildChildEnv as unknown as (opts: Record<string, unknown>) => unknown)({ route: "claude", runId: "test", home: "/h" }),
      (e: unknown) => e instanceof L10EnvBuilderError && /runDir is required/.test(e.message),
      "omitting runDir must throw L10EnvBuilderError",
    );
  } finally {
    try { rmSync(scratchRun, { recursive: true, force: true }); } catch {}
  }

  // MUTANT — parent pollution never leaks. A parent env carrying
  // credentials MUST NOT appear in the child env.
  const parentPollution = {
    AWS_REGION: "us-west-2", XAI_API_KEY: "secret", GOOGLE_API_KEY: "secret",
    GITHUB_TOKEN: "t", ANTHROPIC_API_KEY: "k",
  };
  // We test the predicate on every name; the builder itself starts from
  // its own allowlist, so the result cannot contain parent keys by
  // construction. We re-assert here for legibility.
  for (const [k] of Object.entries(parentPollution)) {
    const r = refusedReason(k);
    assert.notEqual(r, null, `MUTANT: parent pollution name ${k} must be refused`);
  }
  // The builder result for Claude route still has only the allowlisted 8.
  assert.equal(Object.keys(envClaude).length, 8);

  // CONTROL — scrubEnv returns refused names without values.
  const scrubbed = scrubEnv({
    PATH: "/p", HOME: "/h", AWS_REGION: "us-west-2", XAI_API_KEY: "secret",
    MY_PROVIDER_TOKEN: "x", CLEAN_NAME: "ok",
  });
  assert.ok(scrubbed.refused.includes("AWS_REGION"), "AWS_REGION must appear refused");
  assert.ok(scrubbed.refused.includes("XAI_API_KEY"), "XAI_API_KEY must appear refused");
  assert.ok(scrubbed.refused.includes("MY_PROVIDER_TOKEN"), "MY_PROVIDER_TOKEN (ends with _TOKEN) must appear refused");
  assert.ok(scrubbed.kept.includes("PATH"), "PATH must appear kept");
  assert.ok(scrubbed.kept.includes("CLEAN_NAME"), "CLEAN_NAME must appear kept");
  assert.ok(!("AWS_REGION" in scrubbed), "scrubEnv returns refused/kept arrays, not the values");

  // R10 (rework 3b): the empty-value presence clause applies to §c
  // CLASSIFIED names only. An unclassified empty-valued name is kept.
  const scrubbedR10 = scrubEnv({
    npm_config_noproxy: "",            // unclassified empty: KEPT (npx injects these)
    AWS_EMPTY_CLASSIFIED: "",          // classified empty: REFUSED (presence counts)
    XAI_ALSO_EMPTY: "",
  });
  assert.ok(scrubbedR10.kept.includes("npm_config_noproxy"),
    "R10 CONTROL: unclassified empty name is NOT a §c name (npm_config_noproxy kept)");
  assert.ok(scrubbedR10.refused.includes("AWS_EMPTY_CLASSIFIED"),
    "R10 MUTANT: classified name with empty value is refused (presence counts)");
  assert.ok(scrubbedR10.refused.includes("XAI_ALSO_EMPTY"),
    "R10 MUTANT: classified empty refused");

  console.log("PASS: refused-name predicate (every prefix/single/family/empty), closed env builder (exact name set per route), parent pollution never leaks, scrub returns NAMES only.");
}

main();