/**
 * L2 adapter layer — config loader tests (offline, all RUN).
 *
 * Verifies (per design §5, §6.2, §10 test 3):
 * - valid file loads per-slot mapping
 * - bad slot id rejected
 * - forbidden credential fields rejected (case variants)
 * - malformed JSON → treated as absent (null returned)
 * - absent file → null (default path)
 *
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAdaptersConfig, resolveAdapterForSlot, resolveRuntimeModel } from "./index";

function tempConfig(content: string | object): string {
  const dir = mkdtempSync(join(tmpdir(), "adapters-cfg-"));
  const path = join(dir, "agent-commons.adapters.json");
  const text = typeof content === "string" ? content : JSON.stringify(content);
  writeFileSync(path, text, "utf8");
  return dir;
}

function rm(dir: string) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }

// 1. valid file loads per-slot mapping
let dir = tempConfig({ version: 1, defaultAdapter: "stub", slots: { continuity: { adapter: "stub", runtimeModel: "rtm-1" } } });
try {
  const cfg = loadAdaptersConfig(dir);
  assert.ok(cfg, "valid config must load");
  assert.equal(cfg?.defaultAdapter, "stub");
  assert.equal(resolveAdapterForSlot("continuity", cfg), "stub");
  assert.equal(resolveAdapterForSlot("governance", cfg), "stub", "no slot override falls back to defaultAdapter");
  assert.equal(resolveRuntimeModel("continuity", "hist", cfg), "rtm-1");
  assert.equal(resolveRuntimeModel("governance", "hist", cfg), "hist", "no runtimeModel override uses historical");
} finally { rm(dir); }

// 2. absent file → null
assert.equal(loadAdaptersConfig("/nonexistent/path/that/does/not/exist"), null, "absent file must return null");

// 3. malformed JSON → null
dir = tempConfig("{ not json");
try {
  assert.equal(loadAdaptersConfig(dir), null, "malformed JSON must return null");
} finally { rm(dir); }

// 4. bad slot id rejected
dir = tempConfig({ version: 1, slots: { not_a_real_slot: { adapter: "stub" } } });
try {
  assert.equal(loadAdaptersConfig(dir), null, "unknown slot id must reject the file");
} finally { rm(dir); }

// 5. forbidden credential fields rejected — case variants at any depth
for (const bad of ["key", "token", "secret", "password", "credential", "Key", "API_KEY", "apiKey", "OPENAI_API_KEY"]) {
  dir = tempConfig({ version: 1, slots: { continuity: { adapter: "stub", [bad]: "x" } } });
  try {
    assert.equal(loadAdaptersConfig(dir), null, `forbidden field "${bad}" must reject the file`);
  } finally { rm(dir); }
  // nested case
  dir = tempConfig({ version: 1, slots: { continuity: { adapter: "stub" } }, adapters: { stub: { fixtures: "x", [bad]: "y" } } });
  try {
    assert.equal(loadAdaptersConfig(dir), null, `nested forbidden field "${bad}" must reject the file`);
  } finally { rm(dir); }
}

// 5b. CONTROL: benign field names that contain a forbidden SUBSTRING as a
// contiguous run MUST be accepted. The previous substring check rejected
// `keyword`, `monkey`, etc.; the token-equality check accepts them. Two
// poles per name: top-level slot and nested under `adapters`.
for (const ok of ["keyword", "monkey", "passkey", "tokenize", "primarykey", "passwordless", "secretonly", "credentials-free"]) {
  dir = tempConfig({ version: 1, slots: { continuity: { adapter: "stub", [ok]: "x" } } });
  try {
    const cfg = loadAdaptersConfig(dir);
    assert.ok(cfg !== null, `benign field "${ok}" at top level must NOT trip the guard; got null`);
  } finally { rm(dir); }
  dir = tempConfig({ version: 1, slots: { continuity: { adapter: "stub" } }, adapters: { stub: { fixtures: "x", [ok]: "y" } } });
  try {
    const cfg = loadAdaptersConfig(dir);
    assert.ok(cfg !== null, `benign nested field "${ok}" must NOT trip the guard; got null`);
  } finally { rm(dir); }
}

// 6. wrong version rejected
dir = tempConfig({ version: 2, slots: {} });
try {
  assert.equal(loadAdaptersConfig(dir), null, "wrong version must reject the file");
} finally { rm(dir); }

// 7. non-string adapter / runtimeModel rejected
dir = tempConfig({ version: 1, slots: { continuity: { adapter: 42 } } });
try {
  assert.equal(loadAdaptersConfig(dir), null, "non-string adapter must reject the file");
} finally { rm(dir); }

console.log("PASS: valid load, absent file, malformed JSON, bad slot id, forbidden fields (all cases), version, non-string types.");
