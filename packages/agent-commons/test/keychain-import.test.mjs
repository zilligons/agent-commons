// Bring your own key: an established agent enters Agent Commons with the Pillar
// keychain it already has and keeps its UUAID. The source keychain is only read,
// the passphrase comes from the environment, and a refused import leaves no home
// behind that would block a retry.
import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes, scryptSync, verify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keychain } from "../src/pillar.mjs";
import { initialize, loadRuntime } from "../src/config.mjs";
import { DEFAULT_IMPORT_PASSPHRASE_ENV, initializeFromKeychain, loadImportIdentity } from "../src/keychain-import.mjs";

const sha256 = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const newPassphrase = () => randomBytes(24).toString("base64url");
const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const homeLeftEmpty = home => !existsSync(home) || readdirSync(home).length === 0;

// Set (or, for undefined, delete) environment variables for the length of fn.
// AGENT_COMMONS_PASSPHRASE is always pinned so the new home's protection is known.
function withEnv(vars, fn) {
  const all = { AGENT_COMMONS_PASSPHRASE: undefined, ...vars };
  const saved = Object.fromEntries(Object.keys(all).map(k => [k, process.env[k]]));
  const apply = values => { for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  apply(all);
  try { return fn(); } finally { apply(saved); }
}

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ac-import-"));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// A Pillar keychain as `pillar init` writes it (version 1, the vendored format).
function pillarKeychain(dir, options, passphrase, file = "keychain.json") {
  const path = join(dir, file);
  const identity = Keychain.generate(options);
  new Keychain(path).save(identity, { passphrase });
  return { path, identity };
}

// A version-2 keychain as @uuaid/pillar >= 2.5.3 writes one under a non-empty
// passphrase: scrypt (N=2^17, r=8, p=1) instead of HKDF, same AES-256-GCM body.
function pillarScryptKeychain(dir, options, passphrase, file = "keychain.json") {
  const path = join(dir, file);
  const identity = Keychain.generate(options);
  const kdf = { name: "scrypt", N: 131072, r: 8, p: 1 };
  const der = identity.privateKey.export({ type: "pkcs8", format: "der" });
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = scryptSync(Buffer.from(passphrase, "utf8"), salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 128 * kdf.N * kdf.r + 16 * 1024 * 1024 });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(der.subarray(der.length - 32)), cipher.final()]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 2, kdf, uuaid: identity.uuaid, createdAt: identity.createdAt, salt: salt.toString("hex"), iv: iv.toString("hex"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("hex"), publicKeyHex: identity.publicKeyHex }, null, 2), { mode: 0o600 });
  return { path, identity };
}

function assertImportedHome(home, source) {
  const stored = readJson(join(home, "identity.json"));
  assert.equal(stored.uuaid, source.identity.uuaid);
  assert.equal(stored.publicKeyHex, source.identity.publicKeyHex);
  const agents = readJson(join(home, "config.json")).policy.agents;
  assert.deepEqual(Object.keys(agents), [source.identity.uuaid]);
  assert.equal(agents[source.identity.uuaid].publicKey, source.identity.publicKeyHex);
  const loaded = loadRuntime(home);
  try {
    assert.equal(loaded.runtime.uuaid, source.identity.uuaid);
    assert.equal(loaded.runtime.status().uuaid, source.identity.uuaid);
    const message = Buffer.from(`signed in the commons by ${source.identity.uuaid}`);
    const signature = loaded.keychain.sign(message);
    assert.equal(Keychain.verifyDetached(source.identity.publicKeyHex, message, signature), true);
    assert.equal(verify(null, message, source.identity.publicKey, signature), true);
  } finally { loaded.store.close(); }
}

test("the default source passphrase variable is the Pillar CLI's", () => {
  assert.equal(DEFAULT_IMPORT_PASSPHRASE_ENV, "PILLAR_PASSPHRASE");
});

for (const namespace of ["foundation", "agentnet", "pillar"]) {
  test(`a ${namespace} agent key enters Agent Commons with its UUAID and key, and the source file is untouched`, () => withTmp(dir => {
    const passphrase = newPassphrase();
    const source = pillarKeychain(join(dir, "pillar"), { uuaidNamespace: namespace }, passphrase);
    assert.match(source.identity.uuaid, new RegExp(`^uuaid:${namespace}:agent:`));
    const before = sha256(source.path);
    const home = join(dir, "commons");
    withEnv({ PILLAR_PASSPHRASE: passphrase }, () => {
      const result = initializeFromKeychain({ home, sourceKeychainPath: source.path });
      assert.equal(result.identitySource, "imported");
      assert.equal(result.identity.uuaid, source.identity.uuaid);
      assert.equal(result.identity.publicKeyHex, source.identity.publicKeyHex);
      assert.equal(result.identity.createdAt, source.identity.createdAt);
      assert.equal(result.importedFrom, source.path);
      assert.equal(result.passphraseEnv, "PILLAR_PASSPHRASE");
      assert.equal(result.keyProtection, "file-permissions-with-colocated-local-secret");
      assert.equal(result.warnings.length, 1, "a passphrase-protected key copied under a colocated secret is flagged");
    });
    assert.equal(sha256(source.path), before);
    withEnv({}, () => assertImportedHome(home, source));
    assert.equal(sha256(source.path), before);
  }));
}

test("a named passphrase variable and AGENT_COMMONS_PASSPHRASE keep the copy passphrase-protected", () => withTmp(dir => {
  const passphrase = newPassphrase(), homePassphrase = newPassphrase();
  const source = pillarKeychain(join(dir, "agentnet"), { uuaidNamespace: "agentnet" }, passphrase);
  const home = join(dir, "commons");
  withEnv({ PILLAR_PASSPHRASE: undefined, AC_TEST_IMPORT_PASSPHRASE: passphrase, AGENT_COMMONS_PASSPHRASE: homePassphrase }, () => {
    const result = initializeFromKeychain({ home, target: "agentnet.chat", sourceKeychainPath: source.path, passphraseEnv: "AC_TEST_IMPORT_PASSPHRASE" });
    assert.equal(result.keyProtection, "environment-passphrase");
    assert.equal(result.target, "agentnet.chat");
    assert.deepEqual(result.warnings, []);
    assert.equal(existsSync(join(home, "local-secret")), false);
    assertImportedHome(home, source);
  });
}));

test("an unset passphrase variable means \"\", as in Pillar, so an unencrypted keychain imports", () => withTmp(dir => {
  const source = pillarKeychain(join(dir, "pillar"), { uuaidNamespace: "foundation" }, "");
  const home = join(dir, "commons");
  withEnv({ PILLAR_PASSPHRASE: undefined }, () => {
    const result = initializeFromKeychain({ home, sourceKeychainPath: source.path });
    assert.equal(result.identity.uuaid, source.identity.uuaid);
    assert.deepEqual(result.warnings, []);
    assertImportedHome(home, source);
  });
}));

test("a version-2 (scrypt) keychain from Pillar >= 2.5.3 imports; a wrong passphrase or out-of-bounds kdf does not", () => withTmp(dir => {
  const passphrase = newPassphrase();
  const source = pillarScryptKeychain(join(dir, "pillar"), { uuaidNamespace: "pillar" }, passphrase);
  const before = sha256(source.path);
  const home = join(dir, "commons");
  withEnv({ PILLAR_PASSPHRASE: newPassphrase() }, () => {
    assert.throws(() => initializeFromKeychain({ home, sourceKeychainPath: source.path }), error => error.code === "IMPORT_DECRYPT_FAILED" && /home was not created/.test(error.message));
  });
  assert.equal(homeLeftEmpty(home), true);
  const tooCostly = join(dir, "costly.json");
  writeFileSync(tooCostly, JSON.stringify({ ...readJson(source.path), kdf: { name: "scrypt", N: 2 ** 21, r: 8, p: 1 } }));
  assert.throws(() => loadImportIdentity({ sourceKeychainPath: tooCostly, sourcePassphrase: passphrase }), error => error.code === "IMPORT_SOURCE_MALFORMED" && /out of bounds/.test(error.message));
  withEnv({ PILLAR_PASSPHRASE: passphrase }, () => {
    const result = initializeFromKeychain({ home, sourceKeychainPath: source.path });
    assert.equal(result.identity.uuaid, source.identity.uuaid);
    assertImportedHome(home, source);
  });
  assert.equal(sha256(source.path), before);
}));

test("a wrong passphrase is refused, leaves no home, and a correct retry into the same home succeeds", () => withTmp(dir => {
  const passphrase = newPassphrase(), wrong = newPassphrase();
  const source = pillarKeychain(join(dir, "pillar"), { uuaidNamespace: "foundation" }, passphrase);
  const before = sha256(source.path);
  const home = join(dir, "commons");
  for (const attempt of [wrong, undefined, ""]) {
    withEnv({ PILLAR_PASSPHRASE: attempt }, () => {
      assert.throws(() => initializeFromKeychain({ home, sourceKeychainPath: source.path }), error => {
        assert.equal(error.code, "IMPORT_DECRYPT_FAILED");
        assert.match(error.message, /wrong passphrase or damaged file/);
        assert.match(error.message, /home was not created/);
        assert.equal(error.message.includes(passphrase), false);
        assert.equal(error.message.includes(wrong), false);
        return true;
      });
    });
    assert.equal(homeLeftEmpty(home), true);
  }
  assert.throws(() => loadImportIdentity({ sourceKeychainPath: source.path, sourcePassphrase: wrong }), /did not open/);
  mkdirSync(home);
  withEnv({ PILLAR_PASSPHRASE: wrong }, () => assert.throws(() => initializeFromKeychain({ home, sourceKeychainPath: source.path }), /did not open/));
  assert.deepEqual(readdirSync(home), [], "a pre-existing empty home stays empty");
  withEnv({ PILLAR_PASSPHRASE: passphrase }, () => {
    assert.equal(initializeFromKeychain({ home, sourceKeychainPath: source.path }).identity.uuaid, source.identity.uuaid);
    assertImportedHome(home, source);
  });
  assert.equal(sha256(source.path), before);
}));

test("an import refuses a home that already has config.json or identity.json", () => withTmp(dir => {
  const passphrase = newPassphrase();
  const source = pillarKeychain(join(dir, "pillar"), { uuaidNamespace: "foundation" }, passphrase);
  withEnv({ PILLAR_PASSPHRASE: passphrase }, () => {
    const initialized = join(dir, "initialized");
    const existing = initialize({ home: initialized });
    const identityBefore = sha256(join(initialized, "identity.json")), configBefore = sha256(join(initialized, "config.json"));
    assert.throws(() => initializeFromKeychain({ home: initialized, sourceKeychainPath: source.path }), error => error.code === "IMPORT_HOME_EXISTS" && /not overwritten/.test(error.message));
    assert.throws(() => initialize({ home: initialized, identity: loadImportIdentity({ sourceKeychainPath: source.path, sourcePassphrase: passphrase }) }), /not overwritten/);
    assert.equal(sha256(join(initialized, "identity.json")), identityBefore);
    assert.equal(sha256(join(initialized, "config.json")), configBefore);
    assert.equal(readJson(join(initialized, "identity.json")).uuaid, existing.identity.uuaid);

    for (const file of ["identity.json", "config.json"]) {
      const partial = join(dir, `only-${file}`);
      mkdirSync(partial);
      writeFileSync(join(partial, file), "{}");
      assert.throws(() => initializeFromKeychain({ home: partial, sourceKeychainPath: source.path }), error => error.code === "IMPORT_HOME_EXISTS", file);
      assert.deepEqual(readdirSync(partial), [file]);
    }
  });
}));

test("an import refuses a non-agent object type or a namespace a key cannot claim, before decrypting", () => withTmp(dir => {
  const passphrase = newPassphrase();
  const cases = [
    { options: { uuaidNamespace: "foundation", objectType: "service" }, code: "IMPORT_NOT_AGENT", message: /is a service, not an agent/ },
    { options: { uuaidNamespace: "agentnet", objectType: "service" }, code: "IMPORT_NOT_AGENT", message: /not an agent/ },
    { options: { uuaidNamespace: "zilligon" }, code: "IMPORT_NAMESPACE", message: /namespace zilligon.*foundation, pillar, agentnet/ },
    { options: { uuaidNamespace: "iaaso" }, code: "IMPORT_NAMESPACE", message: /namespace iaaso/ },
  ];
  for (const [i, { options, code, message }] of cases.entries()) {
    const source = pillarKeychain(join(dir, `source-${i}`), options, passphrase);
    const before = sha256(source.path);
    const home = join(dir, `home-${i}`);
    for (const sourcePassphrase of [passphrase, newPassphrase()]) {
      assert.throws(() => loadImportIdentity({ sourceKeychainPath: source.path, sourcePassphrase }), error => error.code === code && message.test(error.message), JSON.stringify(options));
    }
    withEnv({ PILLAR_PASSPHRASE: passphrase }, () => {
      assert.throws(() => initializeFromKeychain({ home, sourceKeychainPath: source.path }), error => error.code === code && /home was not created/.test(error.message));
    });
    assert.equal(existsSync(home), false);
    assert.throws(() => initialize({ home, identity: source.identity }), /Imported identity must be/);
    assert.equal(existsSync(home), false, "initialize checks an imported identity before creating the home");
    assert.equal(sha256(source.path), before);
  }
}));

test("an import refuses a missing, malformed, tampered or unknown-version keychain without quoting it", () => withTmp(dir => {
  const passphrase = newPassphrase();
  const source = pillarKeychain(join(dir, "pillar"), { uuaidNamespace: "foundation" }, passphrase);
  const blob = readJson(source.path);
  const other = Keychain.generate();
  const otherLocal = other.uuaid.split(":")[3];
  const marker = "do-not-echo-this-file-content";
  const files = {
    "not-json.json": `{"uuaid": "${marker}",`,
    "not-a-keychain.json": JSON.stringify({ hello: marker }),
    "other-uuaid.json": JSON.stringify({ ...blob, uuaid: `uuaid:foundation:agent:${otherLocal}` }),
    "other-public-key.json": JSON.stringify({ ...blob, publicKeyHex: other.publicKeyHex }),
    "version-3.json": JSON.stringify({ ...blob, version: 3 }),
    "bad-tag.json": JSON.stringify({ ...blob, tag: "00".repeat(16) }),
  };
  const expected = {
    "not-json.json": "IMPORT_SOURCE_MALFORMED",
    "not-a-keychain.json": "IMPORT_SOURCE_MALFORMED",
    "other-uuaid.json": "IMPORT_KEY_MISMATCH",
    "other-public-key.json": "IMPORT_KEY_MISMATCH",
    "version-3.json": "IMPORT_SOURCE_VERSION",
    "bad-tag.json": "IMPORT_DECRYPT_FAILED",
  };
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
  for (const [file, code] of Object.entries(expected)) {
    assert.throws(() => loadImportIdentity({ sourceKeychainPath: join(dir, file), sourcePassphrase: passphrase }), error => {
      assert.equal(error.code, code, file);
      assert.equal(error.message.includes(marker), false, file);
      assert.equal(error.message.includes(blob.ciphertext), false, file);
      assert.equal(error.message.includes(passphrase), false, file);
      return true;
    });
  }
  const home = join(dir, "commons");
  withEnv({ PILLAR_PASSPHRASE: passphrase }, () => {
    assert.throws(() => initializeFromKeychain({ home, sourceKeychainPath: join(dir, "missing.json") }), error => error.code === "IMPORT_SOURCE_MISSING" && /home was not created/.test(error.message));
    assert.throws(() => initializeFromKeychain({ home }), error => error.code === "IMPORT_SOURCE_MISSING");
    for (const passphraseEnv of ["", "PILLAR PASSPHRASE", "A=B", 7]) {
      assert.throws(() => initializeFromKeychain({ home, sourceKeychainPath: source.path, passphraseEnv }), error => error.code === "IMPORT_PASSPHRASE", String(passphraseEnv));
    }
  });
  assert.equal(existsSync(home), false);
  assert.throws(() => loadImportIdentity({ sourceKeychainPath: source.path, sourcePassphrase: Buffer.from(passphrase) }), error => error.code === "IMPORT_PASSPHRASE");
}));

test("initialize() refuses an identity object whose key does not bind its uuaid", () => withTmp(dir => {
  const a = Keychain.generate({ uuaidNamespace: "agentnet" }), b = Keychain.generate({ uuaidNamespace: "agentnet" });
  const home = join(dir, "commons");
  for (const identity of [
    { ...a, privateKey: b.privateKey },
    { ...a, publicKeyHex: b.publicKeyHex },
    { ...a, uuaid: b.uuaid },
    { ...a, privateKey: a.publicKey },
    { uuaid: a.uuaid, publicKeyHex: a.publicKeyHex },
    "not an identity",
  ]) {
    withEnv({}, () => assert.throws(() => initialize({ home, identity }), /Imported identity must be.*home was not created/));
    assert.equal(existsSync(home), false);
  }
  const result = withEnv({}, () => initialize({ home, identity: a }));
  assert.equal(result.identitySource, "imported");
  assert.equal(result.identity.uuaid, a.uuaid);
  withEnv({}, () => assertImportedHome(home, { identity: a }));
}));

test("initialize() without an identity still mints a new agentnet identity", () => withTmp(dir => {
  for (const [i, extra] of [{}, { identity: undefined }, { identity: null }].entries()) {
    const home = join(dir, `commons-${i}`);
    const result = withEnv({}, () => initialize({ home, ...extra }));
    assert.deepEqual(Object.keys(result), ["home", "identity", "target", "profileId", "registryRegistration", "certified", "keyProtection", "identitySource"]);
    assert.equal(result.identitySource, "generated");
    assert.equal(result.keyProtection, "file-permissions-with-colocated-local-secret");
    assert.equal(result.identity.uuaid, `uuaid:agentnet:agent:${Keychain.localIdFromKey(Buffer.from(result.identity.publicKeyHex, "hex"))}`);
    assert.deepEqual(readdirSync(home).sort(), ["commons.db", "config.json", "identity.json", "local-secret"]);
    const loaded = withEnv({}, () => loadRuntime(home));
    try { assert.equal(loaded.runtime.uuaid, result.identity.uuaid); } finally { loaded.store.close(); }
  }
}));
