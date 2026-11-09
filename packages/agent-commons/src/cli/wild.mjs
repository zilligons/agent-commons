// CLI for the seeker's commands: space, continuity, square, conformance, agora (offline binding only).
// Separate from the main flag parser because these take a subcommand and repeatable flags (--member, --carrier, --door).
import { readFileSync, writeFileSync } from "node:fs";
import { Keychain } from "../pillar.mjs";

const REPEATABLE = new Set(["member", "carrier", "door"]);
const SECRET_FLAGS = new Set(["passphrase", "password", "seed", "private-key"]);

export function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) throw new Error(`Use named --flags (unexpected ${JSON.stringify(args[i].slice(0, 40))})`);
    const key = args[i].slice(2);
    if (SECRET_FLAGS.has(key)) throw new Error(`--${key} is refused: secrets never go on the command line. Use --passphrase-env <VARIABLE NAME>.`);
    const value = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
    if (REPEATABLE.has(key)) (flags[key] ??= []).push(value); else flags[key] = value;
  }
  return flags;
}

const need = (flags, ...names) => { for (const n of names) if (flags[n] === undefined || flags[n] === true) throw new Error(`--${n} is required`); };

async function withRuntime(home, fn) {
  const { loadRuntime } = await import("../config.mjs");
  const ctx = loadRuntime(home);
  try { return await fn(ctx); } finally { ctx.store.close(); }
}

async function space(sub, flags) {
  const { SpaceDriver } = await import("../spaces/driver.mjs");
  return withRuntime(flags.home, async ({ home, runtime }) => {
    const d = new SpaceDriver({ home, runtime });
    if (sub === "create") { need(flags, "name"); return d.create({ name: flags.name, purpose: typeof flags.purpose === "string" ? flags.purpose : undefined, members: flags.member ?? [] }); }
    if (sub === "invite") { need(flags, "space", "member"); if (flags.member.length !== 1) throw new Error("Invite one --member at a time"); return d.invite({ space: flags.space, member: flags.member[0] }); }
    if (sub === "join") { need(flags, "space"); return d.join({ space: flags.space }); }
    if (sub === "accept") { need(flags, "signal"); return d.accept({ signal: flags.signal, space: typeof flags.space === "string" ? flags.space : undefined }); }
    if (sub === "speak") { need(flags, "space", "text"); return d.speak({ space: flags.space, text: flags.text }); }
    if (sub === "poll") return d.poll();
    if (sub === "list") return d.list();
    throw new Error("space create|invite|join|accept|speak|poll|list");
  });
}

/** Load a Pillar keychain file (format 1 or 2) whose passphrase is in an environment variable. */
async function loadOldKeychain(path, passphraseEnv) {
  const { loadImportIdentity, DEFAULT_IMPORT_PASSPHRASE_ENV } = await import("../keychain-import.mjs");
  const env = typeof passphraseEnv === "string" ? passphraseEnv : DEFAULT_IMPORT_PASSPHRASE_ENV;
  const identity = loadImportIdentity({ sourceKeychainPath: path, sourcePassphrase: process.env[env] ?? "" });
  const k = new Keychain("unused"); k._identity = identity; return k;
}

async function continuity(sub, flags) {
  const kc = await import("../key-continuity.mjs");
  if (sub === "verify") {
    const doc = JSON.parse(readFileSync(typeof flags.file === "string" ? flags.file : 0, "utf8"));
    const body = kc.verifyKeyContinuity(doc);
    return { valid: true, digest: kc.keyContinuityDigest(doc), relation: body.relation, old: body.old, new: body.new, issuedAt: body.issuedAt };
  }
  if (sub === "admit") { need(flags, "home", "file"); return kc.admitByContinuity({ home: flags.home, doc: JSON.parse(readFileSync(flags.file, "utf8")) }); }
  if (sub === "attest") {
    need(flags, "old-keychain", "relation");
    const oldKeychain = await loadOldKeychain(flags["old-keychain"], flags["passphrase-env"]);
    return withRuntime(flags.home, async ({ keychain }) => {
      const doc = kc.createKeyContinuity({ oldKeychain, newKeychain: keychain, relation: flags.relation, ...(typeof flags.statement === "string" ? { statement: flags.statement } : {}) });
      if (typeof flags.out === "string") writeFileSync(flags.out, JSON.stringify(doc, null, 2) + "\n", { flag: "wx", mode: 0o644 });
      return { document: doc, digest: kc.keyContinuityDigest(doc), ...(typeof flags.out === "string" ? { wrote: flags.out } : {}) };
    });
  }
  throw new Error("continuity attest|verify|admit");
}

function parseDoor(spec) {
  const m = /^(uuaid:[^=]+)=([0-9a-f]{64})$/.exec(String(spec));
  if (!m) throw new Error("--door is <uuaid>=<64-hex public key>");
  return { uuaid: m[1], publicKey: m[2] };
}

async function square(sub, flags) {
  if (sub === "serve") {
    need(flags, "db");
    const bind = typeof flags.bind === "string" ? flags.bind : "127.0.0.1";
    if (!["127.0.0.1", "::1", "localhost"].includes(bind) && flags.public !== true) throw new Error("A non-loopback bind needs --public (and a TLS reverse proxy in front of it)");
    const { createSquareServer } = await import("../square/server.mjs");
    // --trust-proxy: behind a reverse proxy on this host, rate-limit by the address the proxy saw (see sourceOf).
    const server = createSquareServer({ dbPath: flags.db, trustProxy: flags["trust-proxy"] === true });
    const at = await server.listen(Number(flags.port ?? 0), bind);
    console.log(JSON.stringify({ name: "Agent Commons square", listening: at.url ?? at, public: flags.public === true }));
    const stop = async () => { await server.close(); process.exit(0); };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    await new Promise(() => {});
  }
  const client = await import("../square/client.mjs");
  need(flags, "url");
  if (sub === "resolve") { need(flags, "uuaid"); return client.resolveAgent({ url: flags.url, uuaid: flags.uuaid }); }
  if (sub === "directory") return client.listDirectory({ url: flags.url, ...(flags.limit ? { limit: Number(flags.limit) } : {}), ...(typeof flags.cursor === "string" ? { cursor: flags.cursor } : {}) });
  if (sub === "list" || sub === "withdraw") {
    return withRuntime(flags.home, async ({ keychain }) => {
      if (sub === "withdraw") return client.withdrawListing({ url: flags.url, keychain });
      const fields = {};
      if (typeof flags["display-name"] === "string") fields.displayName = flags["display-name"];
      if (typeof flags.about === "string") fields.about = flags.about;
      if (flags.carrier) fields.carriers = flags.carrier;
      if (flags.door) fields.doors = flags.door.map(parseDoor);
      if (flags["ttl-days"]) fields.ttlMs = Number(flags["ttl-days"]) * 86400000;
      return client.publishListing({ url: flags.url, keychain, fields });
    });
  }
  throw new Error("square serve|list|withdraw|resolve|directory");
}

// agora: OFFLINE only. Builds the signed uuaid.identity.binding.v1 an operator submits to POST /agents/bindings.
// Networked Agora writes are library-only (src/agora.mjs AgoraClient); none of them is a CLI command.
async function agora(sub, flags) {
  if (sub !== "binding") throw new Error("agora binding --home <dir> --registry-uuaid <uuaid> [--aud https://api.uuaid.org]");
  need(flags, "registry-uuaid");
  const { buildIdentityBinding, AGORA_AUDIENCE_DEFAULT } = await import("../agora.mjs");
  return withRuntime(flags.home, async ({ keychain }) => {
    const signed = buildIdentityBinding({ registryUuaid: flags["registry-uuaid"], keychain, aud: typeof flags.aud === "string" ? flags.aud : AGORA_AUDIENCE_DEFAULT });
    return { ...signed, submit: "POST /agents/bindings with { items: [this] } using your partner key; nothing was sent", validForSeconds: 60 };
  });
}

export async function wildCli(argv) {
  const [area, sub, ...rest] = argv;
  if (area === "conformance") {
    const { runWildVectors } = await import("../conformance.mjs");
    const flags = parseFlags([sub, ...rest].filter((x) => x !== undefined));
    const vectors = typeof flags.file === "string" ? JSON.parse(readFileSync(flags.file, "utf8")) : undefined;
    const report = await runWildVectors(vectors ? { vectors } : {});
    if (report.failed) process.exitCode = 1;
    return report;
  }
  const flags = parseFlags(rest);
  if (area === "space") return space(sub, flags);
  if (area === "continuity") return continuity(sub, flags);
  if (area === "square") return square(sub, flags);
  if (area === "agora") return agora(sub, flags);
  throw new Error(`Unknown command ${area}`);
}
