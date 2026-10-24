// Boots server/network.ts against the commons.db in L30_DB_HOME, as the console
// does on start, and prints the identities for L30_IDS (public values only).
import { chdir } from "node:process";

try {
  const home = process.env.L30_DB_HOME;
  const networkModule = process.env.L30_NETWORK_MODULE;
  const ids = JSON.parse(process.env.L30_IDS ?? "[]");
  if (!home || !networkModule || !ids.length) throw new Error("probe env");
  chdir(home);
  const { NetworkConsole } = await import(networkModule);
  const consoleState = new NetworkConsole();
  const out = ids.map((id) => {
    const identity = consoleState.identity(id);
    return { id, uuaid: identity.uuaid, publicKeyHex: identity.publicKeyHex };
  });
  process.stdout.write(`${JSON.stringify(out)}\n`);
} catch (error) {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : "";
  const safe = /PRIVATE KEY|uvk_/.test(message) ? "" : message.slice(0, 200);
  process.stderr.write(`probe failed: ${name} ${safe}\n`);
  process.exit(1);
}
