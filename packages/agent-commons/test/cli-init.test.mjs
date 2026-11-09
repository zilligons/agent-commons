// The CLI's init path (holder gap 3 / gap 4), run through the real bin: carriers set at init, a bad carrier refused
// before any home exists, and a passphrase-protected key never silently downgraded on import.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Keychain } from "../src/pillar.mjs";

const bin = fileURLToPath(new URL("../bin/agent-commons.mjs", import.meta.url));
function cli(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.AGENT_COMMONS_PASSPHRASE;
  for (const [k, v] of Object.entries(extraEnv)) if (v === undefined) delete env[k];
  return spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", env });
}
function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ac-cli-init-"));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("init --carrier writes the carriers into config.json", () => withTmp(dir => {
  const home = join(dir, "home");
  const out = cli(["init", "--home", home, "--carrier", "https://carrier-a.example, https://carrier-b.example"]);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout).carriers, ["https://carrier-a.example", "https://carrier-b.example"]);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).carriers, ["https://carrier-a.example", "https://carrier-b.example"]);
}));

test("init --carrier with a bad URL is refused before any home is created", () => withTmp(dir => {
  for (const bad of ["ftp://x.example", "https://user:pw@x.example", "https://x.example/?q=1", "not a url"]) {
    const home = join(dir, `home-${randomBytes(4).toString("hex")}`);
    const out = cli(["init", "--home", home, "--carrier", bad]);
    assert.equal(out.status, 1, bad);
    assert.equal(existsSync(home), false, `no half-made home for ${bad}`);
  }
}));

test("init --import-keychain refuses a silent custody downgrade; --allow-file-protection makes it explicit", () => withTmp(dir => {
  const passphrase = randomBytes(24).toString("base64url");
  const source = join(dir, "keychain.json");
  const identity = Keychain.generate({ uuaidNamespace: "agentnet" });
  new Keychain(source).save(identity, { passphrase });
  const home = join(dir, "home");
  const refused = cli(["init", "--home", home, "--import-keychain", source, "--passphrase-env", "AC_CLI_TEST_PASS"], { AC_CLI_TEST_PASS: passphrase });
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stderr.split("\n")[0]).error, "IMPORT_PROTECTION_DOWNGRADE");
  assert.equal(existsSync(join(home, "config.json")), false);
  const allowed = cli(["init", "--home", home, "--import-keychain", source, "--passphrase-env", "AC_CLI_TEST_PASS", "--allow-file-protection"], { AC_CLI_TEST_PASS: passphrase });
  assert.equal(allowed.status, 0, allowed.stderr);
  const result = JSON.parse(allowed.stdout);
  assert.equal(result.identity.uuaid, identity.uuaid);
  assert.equal(result.keyProtection, "file-permissions-with-colocated-local-secret");
  assert.match(allowed.stderr, /^warning: the source key was passphrase-protected/m);
  assert.equal(allowed.stdout.includes(passphrase) || allowed.stderr.includes(passphrase), false, "the passphrase is never echoed");
}));
