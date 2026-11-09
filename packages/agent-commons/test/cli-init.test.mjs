// The CLI's init path (holder gap 3 / gap 4), run through the real bin: carriers set at init, a bad carrier refused
// before any home exists, and a passphrase-protected key never silently downgraded on import.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Keychain } from "../src/pillar.mjs";
import { createSquareServer } from "../src/square/server.mjs";
import { publishListing } from "../src/square/client.mjs";

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

// Async: the square under test runs in this process, so the CLI must not block its event loop.
function cliAsync(args) {
  const env = { ...process.env }; delete env.AGENT_COMMONS_PASSPHRASE;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; }); child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("init reports squareListing: not-checked without --square; with --square, listed (url + expiry) or not-listed", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ac-cli-square-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sq = createSquareServer({ dbPath: join(dir, "square.db") });
  const { url } = await sq.listen(0, "127.0.0.1");
  t.after(() => sq.close());

  const plain = await cliAsync(["init", "--home", join(dir, "h0")]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(JSON.parse(plain.stdout).squareListing.status, "not-checked");

  const fresh = await cliAsync(["init", "--home", join(dir, "h1"), "--square", url]);
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.deepEqual(JSON.parse(fresh.stdout).squareListing, { status: "not-listed", url });

  // Bring your own key that is already listed from elsewhere: init must say so, with the expiry.
  const source = join(dir, "keychain.json");
  const kc = new Keychain(source); kc.save(Keychain.generate({ uuaidNamespace: "agentnet" }), { passphrase: "" });
  const pub = await publishListing({ url, keychain: kc, fields: { displayName: "already here" } });
  const listed = await cliAsync(["init", "--home", join(dir, "h2"), "--import-keychain", source, "--square", url]);
  assert.equal(listed.status, 0, listed.stderr);
  const status = JSON.parse(listed.stdout).squareListing;
  assert.equal(status.status, "listed");
  assert.equal(status.url, url);
  assert.equal(status.expiresAt, new Date(pub.listing.expiresAt).toISOString(), "the expiry the square holds for this key");
  assert.ok(Date.parse(status.expiresAt) > Date.now());

  // A square that cannot be reached is reported, and the home stays.
  const down = await cliAsync(["init", "--home", join(dir, "h3"), "--square", "http://127.0.0.1:9"]);
  assert.equal(down.status, 0, down.stderr);
  assert.equal(JSON.parse(down.stdout).squareListing.status, "check-failed");
  assert.equal(existsSync(join(dir, "h3", "config.json")), true);
});

test("a positional argument is a JSON refusal with exit status 1, not a stack trace", () => {
  const out = cli(["status", "stray"]);
  assert.equal(out.status, 1);
  const first = out.stderr.split("\n").find((l) => l.startsWith("{"));
  assert.ok(first, out.stderr);
  const err = JSON.parse(first);
  assert.equal(err.error, "AGENT_COMMONS_ERROR");
  assert.match(err.message, /^Use named --flags \(unexpected argument: stray\)$/);
  assert.equal(/\n\s+at /.test(out.stderr), false, "no stack trace");
});
