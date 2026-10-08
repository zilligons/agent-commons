// Feeds recorded seeds into server/network.ts identity() and prints public results only.
import { createPrivateKey, createPublicKey } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { chdir } from "node:process";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function material(seedHex) {
  const seed = Buffer.from(seedHex, "hex");
  if (seed.length !== 32) throw new Error("seed length");
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const raw = Buffer.from(publicKey.export({ type: "spki", format: "der" }).subarray(-32));
  return {
    rawHex: raw.toString("hex"),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

try {
  const home = process.env.L7_DB_HOME;
  const networkModule = process.env.L7_NETWORK_MODULE;
  const vectors = JSON.parse(readFileSync(process.env.L7_VECTORS, "utf8")).vectors;
  if (!home || !networkModule) throw new Error("probe env");
  chdir(home);
  const db = new Database("commons.db");
  db.exec("CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS agent_keys (id TEXT PRIMARY KEY, private_key TEXT NOT NULL, public_key TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO agent_keys (id, private_key, public_key) VALUES (?, ?, ?)");
  for (const vector of vectors) {
    const key = material(vector.seedHex);
    if (key.rawHex !== vector.rawPublicHex) throw new Error(`seed does not match recorded raw public key for ${vector.id}`);
    insert.run(vector.id, key.privateKeyPem, key.publicKeyPem);
  }
  db.close();
  const { NetworkConsole } = await import(networkModule);
  const consoleState = new NetworkConsole();
  const out = [];
  for (const vector of vectors) {
    const identity = consoleState.identity(vector.id);
    out.push({ id: vector.id, uuaid: identity.uuaid, publicKeyHex: identity.publicKeyHex });
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
} catch (error) {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : "";
  const safe = /PRIVATE KEY|uvk_/.test(message) ? "" : message.slice(0, 200);
  process.stderr.write(`probe failed: ${name} ${safe}\n`);
  process.exit(1);
}
