// The D items (D8) and D-1: the scope seat's DDL oracles, run against the CODE's schema (CORE_DDL alone, and
// the full DDL with the L0 extension tables). The scripts are vendored and pinned by hash; for
// publication their comments were reworded (roles instead of names) and nothing else changed:
// - rebind-recovery-scenarios (the scope seat's 33ea4630) with the one fixture-only port for spec
//   v3.3.2's decisions.lane (c034694c, accepted in D-1); its 3 controls run on the v3.3.2 block, which strands;
// - d1-checks (d33a9731), with the D-only merge (b6f3526b) as its control;
// - d2-checks (6813a44d; D-2, S5: no role row for a revoked member), with D-1's block (6c7b84aa, its
//   one RC-2 comment line reworded as in spec v3.4.6) as its control, which admits both revoked rows.
// Each script runs in a child process (they execute on import) on scratch copies in a temp directory.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CORE_DDL, DDL } from "../src/relay/schema.mjs";

const dir = new URL("./relay-fixtures/ddl/", import.meta.url);
const PINS = {
  "rebind-recovery-scenarios.lane-port.mjs": "249961147bf6379b163961a854c751ca8e1c3deedaf6a61a5f82c71b1ff31e09",
  "d1-checks.mjs": "2debc79e0775dedb1ef4cb12e4c8602e434ea562381287325e1de0effff88e58",
  "core-ddl-v332.sql": "70c4ed9753855aa76a89a3cbca3f3af9c2490c62ff8bc6058324b02fcc0ddfcf",
  "ddl-v332-plus-D.sql": "b6f3526b32bad735625fd9f4818b46acaa35fe18becaae97d400e2dce1b58494",
  "d2-checks.mjs": "d18dd779426d4b4e776ddb59e5f8553a4bb388345ba9d66ccc6e135cbf055b05",
  "ddl-v34-D1.sql": "47529a345d4062f23ce7aa88e5afbb1b1a5b8da802dce191835549347ee735a8",
};
const path = (name) => new URL(name, dir).pathname;

function runScript(script, candidateSql, controlFile) {
  const tmp = mkdtempSync(join(tmpdir(), "relay-ddl-oracle-"));
  try {
    const cand = join(tmp, "candidate.sql");
    writeFileSync(cand, candidateSql);
    const r = spawnSync(process.execPath, [path(script), cand, path(controlFile)], { encoding: "utf8", env: { ...process.env, AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED: "0" } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

test("the vendored oracles and control schemas are the pinned files", () => {
  for (const [name, sha] of Object.entries(PINS)) assert.equal(createHash("sha256").update(readFileSync(path(name))).digest("hex"), sha, name);
});

for (const [label, sql] of [["CORE_DDL", CORE_DDL], ["full DDL (core + extension tables)", DDL]]) {
  test(`the D items: the scope seat's 47 re-bind recovery scenarios pass on the code's ${label}; v3.3.2 still strands (controls)`, () => {
    const r = runScript("rebind-recovery-scenarios.lane-port.mjs", sql, "core-ddl-v332.sql");
    assert.match(r.out, /^TOTAL 47 {2}PASS 47 {2}FAIL 0$/m, r.out + r.err);
    assert.equal((r.out.match(/^PASS {2}CONTROL base:/gm) ?? []).length, 3);
  });
  test(`D-1: the scope seat's 18 RC-2 and family/pattern checks pass on the code's ${label}; 8 differ on the D-only control`, () => {
    const r = runScript("d1-checks.mjs", sql, "ddl-v332-plus-D.sql");
    assert.match(r.out, /^TOTAL 18 {2}PASS 18 {2}FAIL 0 {2}\(cases where the control differs: 8\)$/m, r.out + r.err);
  });
  test(`D-2: the scope seat's 4 S5 checks pass on the code's ${label}; both revoked rows refused, which D-1's block admits`, () => {
    const r = runScript("d2-checks.mjs", sql, "ddl-v34-D1.sql");
    assert.match(r.out, /^TOTAL 4 {2}PASS 4 {2}FAIL 0 {2}\(cases where the control differs: 2\)$/m, r.out + r.err);
    assert.equal((r.out.match(/candidate: refused \(role-frozen-revoked\)/g) ?? []).length, 2);
  });
}
