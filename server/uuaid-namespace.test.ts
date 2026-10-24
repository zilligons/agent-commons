// Console keys record the namespace they were minted in: rows from before the
// column stay uuaid:foundation:, new keys are uuaid:agentnet:, across restarts.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { ensureAgentKeyNamespace } from "./storage";
import { localIdFromKey } from "../packages/agent-commons/src/pillar.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
// The schema every commons.db had before the namespace column.
const LEGACY_SCHEMA =
  "CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS agent_keys (id TEXT PRIMARY KEY, private_key TEXT NOT NULL, public_key TEXT NOT NULL)";
const LEGACY_INSERT = "INSERT INTO agent_keys (id, private_key, public_key) VALUES (?, ?, ?)";

function pemPair() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    raw: Buffer.from(pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32)),
  };
}
const keyDerived = (namespace: string, raw: Buffer) => `uuaid:${namespace}:agent:${localIdFromKey(raw)}`;

// One console start: a fresh process opens the real file database and reads the ids.
function start(home: string, ids: string[]) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  env.L30_DB_HOME = home;
  env.L30_IDS = JSON.stringify(ids);
  env.L30_NETWORK_MODULE = pathToFileURL(join(here, "network.ts")).href;
  env.TSX_TSCONFIG_PATH = join(root, "tsconfig.json");
  return spawnSync(process.execPath, ["--import", "tsx", join(here, "uuaid-namespace-probe.mjs")], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 60000,
  });
}
function boot(home: string, ids: string[]) {
  const child = start(home, ids);
  assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
  const rows: { id: string; uuaid: string; publicKeyHex: string }[] = JSON.parse(
    child.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "",
  );
  return new Map(rows.map((row) => [row.id, row]));
}

test("legacy console keys stay foundation, new keys mint agentnet, and both survive restarts", () => {
  const home = mkdtempSync(join(tmpdir(), "l30-ns-"));
  try {
    symlinkSync(join(root, "packages"), join(home, "packages"), "dir");
    const legacy = pemPair();
    const before = new DatabaseSync(join(home, "commons.db"));
    before.exec(LEGACY_SCHEMA);
    before.prepare(LEGACY_INSERT).run("legacy", legacy.privateKey, legacy.publicKey);
    before.close();

    const first = boot(home, ["legacy", "fresh"]);
    assert.equal(first.get("legacy")!.uuaid, keyDerived("foundation", legacy.raw));
    const fresh = first.get("fresh")!;
    assert.equal(fresh.uuaid, keyDerived("agentnet", Buffer.from(fresh.publicKeyHex, "hex")));

    // A binary from before this change, writing to the migrated database.
    const late = pemPair();
    const after = new DatabaseSync(join(home, "commons.db"));
    after.prepare(LEGACY_INSERT).run("late", late.privateKey, late.publicKey);
    const stored = after.prepare("SELECT id, uuaid_namespace FROM agent_keys ORDER BY id").all();
    after.close();
    assert.deepEqual(stored.map((row) => [row.id, row.uuaid_namespace]), [
      ["fresh", "agentnet"],
      ["late", "foundation"],
      ["legacy", "foundation"],
    ]);

    const second = boot(home, ["legacy", "fresh", "late"]);
    assert.equal(second.get("legacy")!.uuaid, first.get("legacy")!.uuaid);
    assert.deepEqual(second.get("fresh"), fresh);
    assert.equal(second.get("late")!.uuaid, keyDerived("foundation", late.raw));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a console key recorded outside the self-certifying set fails closed instead of becoming an id", () => {
  const home = mkdtempSync(join(tmpdir(), "l30-ns-"));
  try {
    symlinkSync(join(root, "packages"), join(home, "packages"), "dir");
    boot(home, ["atlas"]); // the first start migrates the schema
    const pillar = pemPair(), registry = pemPair(), blank = pemPair();
    const db = new DatabaseSync(join(home, "commons.db"));
    const insert = db.prepare("INSERT INTO agent_keys (id, private_key, public_key, uuaid_namespace) VALUES (?, ?, ?, ?)");
    insert.run("pillar", pillar.privateKey, pillar.publicKey, "pillar");
    insert.run("registry", registry.privateKey, registry.publicKey, "zilligon");
    insert.run("blank", blank.privateKey, blank.publicKey, "");
    db.close();
    assert.equal(boot(home, ["pillar"]).get("pillar")!.uuaid, keyDerived("pillar", pillar.raw));
    for (const id of ["registry", "blank"]) {
      const child = start(home, [id]);
      assert.notEqual(child.status, 0, `${id} became an id: ${child.stdout}`);
      assert.match(child.stderr, new RegExp(`Console key ${id} has no self-certifying UUAID namespace`));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the namespace migration adds one defaulted column and is idempotent", () => {
  const legacy = new Database(":memory:");
  try {
    legacy.exec(LEGACY_SCHEMA);
    legacy.prepare(LEGACY_INSERT).run("old", "private", "public");
    ensureAgentKeyNamespace(legacy);
    ensureAgentKeyNamespace(legacy);
    const columns = legacy.prepare("PRAGMA table_info(agent_keys)").all() as { name: string; notnull: number; dflt_value: string | null }[];
    assert.deepEqual(columns.map((c) => [c.name, c.notnull, c.dflt_value]), [
      ["id", 0, null],
      ["private_key", 1, null],
      ["public_key", 1, null],
      ["uuaid_namespace", 1, "'foundation'"],
    ]);
    assert.equal(legacy.prepare("SELECT uuaid_namespace FROM agent_keys WHERE id = 'old'").pluck().get(), "foundation");
  } finally {
    legacy.close();
  }
});

// A mint site is Keychain.generate(...) reached any way: directly, through
// Keychain["generate"], an alias (`const K = Keychain`, `import { Keychain as K }`)
// or a destructured, possibly renamed, `generate`. Each must mint through
// mintNamespace(RUNTIME_UUAID_NAMESPACE): one source for the value, and a check
// that throws outside the self-certifying set. A literal (even "agentnet") or the
// bare constant is refused.
function mintOffenses(text: string) {
  const offenders: string[] = [];
  let sites = 0;
  if (/uuaid:foundation:/.test(text)) offenders.push("hard-coded uuaid:foundation:");
  const names = new Set(["Keychain"]);
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*Keychain\b(?!\s*[.[])/g)) names.add(m[1]);
  for (const m of text.matchAll(/\bKeychain\s+as\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  const generators = new Set<string>();
  for (const m of text.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*([A-Za-z_$][\w$]*)/g)) {
    if (!names.has(m[2])) continue;
    for (const g of m[1].matchAll(/\bgenerate\b(?:\s*:\s*([A-Za-z_$][\w$]*))?/g)) generators.add(g[1] ?? "generate");
  }
  const calls: RegExpMatchArray[] = [];
  for (const name of names) calls.push(...text.matchAll(new RegExp(`(?<![\\w$])${name}\\s*(?:\\.\\s*generate|\\[\\s*["'\`]generate["'\`]\\s*\\])\\s*\\(([^)]*)\\)`, "g")));
  for (const g of generators) calls.push(...text.matchAll(new RegExp(`(?<![\\w$.])${g}\\s*\\(([^)]*)\\)`, "g")));
  for (const call of calls) {
    sites++;
    if (!/uuaidNamespace\s*:\s*mintNamespace\(\s*RUNTIME_UUAID_NAMESPACE\b/.test(call[1])) offenders.push(`${call[0].slice(0, 60)} does not mint through mintNamespace(RUNTIME_UUAID_NAMESPACE)`);
  }
  return { offenders, sites };
}

function sourceFiles(dir: string) {
  let entries: string[];
  try { entries = readdirSync(dir, { recursive: true }) as string[]; } catch { return []; }
  return entries.filter((f) => /\.(?:tsx?|mjs)$/.test(f) && !/\.test\.(?:tsx?|mjs)$/.test(f)).map((f) => join(dir, f));
}

test("the server mint-site guard catches every way to reach generate and a literal namespace", () => {
  for (const text of [
    "const k = Keychain.generate();",
    "const K = Keychain; const k = K.generate();",
    "const { generate } = Keychain; const k = generate();",
    "const { generate: g } = Keychain; const k = g();",
    'import { Keychain as KC } from "./pillar.mjs"; const k = KC.generate();',
    'const k = Keychain["generate"]();',
    'const k = Keychain.generate({ uuaidNamespace: "agentnet" });',
    "const k = Keychain.generate({ uuaidNamespace: RUNTIME_UUAID_NAMESPACE });",
    'const uuaid = "uuaid:foundation:agent:x";',
  ]) assert.notDeepEqual(mintOffenses(text).offenders, [], text);
  for (const text of [
    "const k = Keychain.generate({ uuaidNamespace: mintNamespace(RUNTIME_UUAID_NAMESPACE) });",
    "const K = Keychain; const k = K.generate({ uuaidNamespace: mintNamespace(RUNTIME_UUAID_NAMESPACE) });",
    'import { Keychain as KC } from "./pillar.mjs"; const k = KC["generate"]({ uuaidNamespace: mintNamespace(RUNTIME_UUAID_NAMESPACE) });',
    "const { generate: g } = Keychain; const k = g({ uuaidNamespace: mintNamespace(RUNTIME_UUAID_NAMESPACE) });",
  ]) {
    const { offenders, sites } = mintOffenses(text);
    assert.deepEqual(offenders, [], text);
    assert.equal(sites, 1, text);
  }
});

test("server mint sites take the namespace from the key record, never from a literal", () => {
  const offenders: string[] = [];
  const files = [...sourceFiles(here), ...sourceFiles(join(root, "shared")), ...sourceFiles(join(root, "client", "src"))];
  for (const file of files) {
    const scanned = mintOffenses(readFileSync(file, "utf8"));
    offenders.push(...scanned.offenders.map((o) => `${file.slice(root.length + 1)}: ${o}`));
  }
  assert.deepEqual(offenders, []);
  assert.ok(files.includes(join(here, "network.ts")), "the guard is not reading server/");
  assert.ok(files.some((f) => f.startsWith(join(root, "shared") + "/")), "the guard is not reading shared/");
  assert.ok(files.some((f) => f.startsWith(join(root, "client", "src") + "/") && f.endsWith(".tsx")), "the guard is not reading client/src");
  assert.match(readFileSync(join(here, "network.ts"), "utf8"), /uuaid:\$\{keys\.uuaidNamespace\}:agent:/);
  assert.match(readFileSync(join(here, "storage.ts"), "utf8"), /uuaidNamespace: mintNamespace\(RUNTIME_UUAID_NAMESPACE\)/);
  // The server mints with node:crypto, not Keychain.generate. Every file that
  // generates a console key must also stamp the namespace on the row.
  const generators = files.filter((f) => /(?<![\w$.])generateKeyPairSync\(/.test(readFileSync(f, "utf8")));
  assert.ok(generators.length >= 1, "the guard found no server key generator, so it is not reading the source");
  for (const file of generators)
    assert.match(readFileSync(file, "utf8"), /uuaidNamespace: mintNamespace\(RUNTIME_UUAID_NAMESPACE\)/, `${file}: generates a key without minting through mintNamespace(RUNTIME_UUAID_NAMESPACE)`);
});
