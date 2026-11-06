// Cloud Commons relay: the `agent-commons relay ...` command.
//
//   agent-commons relay serve ...              the production relay (serve.mjs; no test flag)
//   agent-commons relay <client command> ...   the reference client (client.mjs runClientCommand):
//     mint | enroll --invite-file <f> [--display-name <s> --platform <s>] | adopt-next-key | status |
//     seed | claims | board | send --type <t> --record-id <id> --body-json <json> | drain |
//     run-once [--wait <s>] | handled | outbox
//   every client command takes --state <absolute private directory> and optionally --relay-url <url>
//   (default: the relay origin pinned from the invite).
//
// Security invariant: neither path accepts --test-mode, --test-dir or --test-interface; they are unknown arguments
// here and exit 2. The test entrypoints are src/relay/server.mjs and src/relay/client.mjs, run directly.
// Seat (fleet) commands are not here: they sign with seat keys whose custody is an owner decision.

import { serveMain } from "./serve.mjs";
import { CLIENT_COMMANDS, CLIENT_VALUE_FLAGS, runClientCommand } from "./client.mjs";

export const RELAY_USAGE = `agent-commons relay serve --aud https://<host> --bind <loopback ip> [--port <n>] --db <relay*.db>
    --roster <signed roster> --policy <signed policy> --owner-public-key <64 hex> --relay-key-file <key seed file> [--access-log <file>]
agent-commons relay ${CLIENT_COMMANDS.join("|")} --state <private dir> [--relay-url <url>]
    enroll --invite-file <f> [--display-name <s> --platform <s>]; send --type <t> --record-id <id> --body-json <json>; run-once [--wait <s>]`;

/** Run the relay command. Returns the exit status it set (the server keeps the process alive). */
export async function relayCli(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const [command, ...rest] = argv;
  if (command === "serve") { await serveMain(rest, { stdout, stderr }); return process.exitCode ?? 0; }
  if (command === undefined || command === "help" || command === "--help") { stdout.write(`${RELAY_USAGE}\n`); return 0; }
  const o = {};
  let usage = !CLIENT_COMMANDS.includes(command);
  for (let i = 0; !usage && i < rest.length; i++) {
    if (!CLIENT_VALUE_FLAGS.includes(rest[i]) || i + 1 >= rest.length || Object.hasOwn(o, rest[i].slice(2))) { usage = true; break; }
    o[rest[i].slice(2)] = rest[++i];
  }
  if (usage) {
    stdout.write(`${JSON.stringify({ ok: false, error: "usage" })}\n`);
    stderr.write(`${RELAY_USAGE}\n`);
    process.exitCode = 2;
    return 2;
  }
  try {
    const result = await runClientCommand(command, o);
    stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
    return 0;
  } catch (error) {
    stdout.write(`${JSON.stringify({ ok: false, error: error?.code ?? "error", status: error?.status ?? null, detail: String(error?.message ?? error).slice(0, 300) })}\n`);
    process.exitCode = 1;
    return 1;
  }
}
