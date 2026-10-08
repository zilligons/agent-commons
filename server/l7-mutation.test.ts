import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("custody and derivation mutants fail on a scratch copy", () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  env.TMPDIR = "/tmp";
  const child = spawnSync(process.execPath, [join(root, "server/l7-mutation-check.mjs")], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 180000,
  });
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  assert.match(child.stdout, /KNOW custody-prefix: CONTROL rc=0; MUTANT rc=1/);
  assert.match(child.stdout, /KNOW custody-material: CONTROL rc=0; MUTANT rc=1/);
  assert.match(child.stdout, /KNOW custody-journal: CONTROL rc=0; MUTANT rc=1/);
  assert.match(child.stdout, /KNOW custody-shm: CONTROL rc=0; MUTANT rc=1/);
  assert.match(child.stdout, /KNOW custody-raw: CONTROL rc=0; MUTANT rc=1/);
  assert.match(child.stdout, /KNOW derivation-vendor: CONTROL rc=0; MUTANT rc=1/);
  assert.match(child.stdout, /KNOW derivation-server: CONTROL rc=0; MUTANT rc=1/);
});
