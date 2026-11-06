// L1 acceptance harness (spec v3.4.5 13.2, N25): the egress sensor. Preloaded into the relay process
// (node --import), it records EVERY outbound attempt from start to shutdown: net and tls connects,
// dgram sends, dns lookups and resolves, http and https requests, fetch, and child processes. Each
// attempt is one JSON line appended synchronously to $EGRESS_LOG (the attempt is still made; the
// network decides). Listening and accepting are inbound and are not recorded. A control preload that
// makes one forbidden connect must turn the record red even though the network blocks it.

import { createRequire, syncBuiltinESMExports } from "node:module";
import { isIP } from "node:net";
import { appendFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const LOG = process.env.EGRESS_LOG;
if (!LOG) throw new Error("egress sensor: EGRESS_LOG is not set");
const record = (kind, detail) => {
  try { appendFileSync(LOG, `${JSON.stringify({ at: Date.now(), pid: process.pid, kind, detail: String(detail).slice(0, 200) })}\n`, { mode: 0o600 }); }
  catch { /* the sensor never breaks the process it watches */ }
};
const wrap = (mod, name, kind, describe = (a) => a[0]) => {
  const original = mod[name];
  if (typeof original !== "function") return;
  mod[name] = function sensed(...args) { record(kind, (() => { try { return JSON.stringify(describe(args)); } catch { return "?"; } })()); return original.apply(this, args); };
};

const net = require("node:net"), tls = require("node:tls"), dgram = require("node:dgram"), dns = require("node:dns"),
  http = require("node:http"), https = require("node:https"), cp = require("node:child_process");
const connectOriginal = net.Socket.prototype.connect;
net.Socket.prototype.connect = function sensedConnect(...args) {
  // Every outbound TCP path (net.connect, http, https, tls) ends here; a server's accepted sockets never call it.
  const a = Array.isArray(args[0]) ? args[0][0] : args[0];   // net.connect passes its normalized [options, cb]
  record("net.connect", typeof a === "object" && a !== null ? JSON.stringify({ host: a.host, port: a.port, path: a.path }) : JSON.stringify(args.slice(0, 2)));
  return connectOriginal.apply(this, args);
};
wrap(tls, "connect", "tls.connect", (a) => (typeof a[0] === "object" ? { host: a[0].host, port: a[0].port } : a.slice(0, 2)));
const sendOriginal = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function sensedSend(...args) { record("dgram.send", JSON.stringify(args.slice(1).filter(x => typeof x !== "function").slice(-2))); return sendOriginal.apply(this, args); };
// dns.lookup of an IP literal is answered inside Node without any resolver call (server.listen on an
// address does this); it is recorded under its own kind, which the harness lists but does not count
// as egress. Every other lookup or resolve is egress.
const lookupOriginal = dns.lookup;
dns.lookup = function sensedLookup(host, ...rest) { record(isIP(String(host)) ? "dns.lookup-literal" : "dns.lookup", JSON.stringify(host)); return lookupOriginal.call(this, host, ...rest); };
for (const name of ["resolve", "resolve4", "resolve6", "resolveAny", "resolveTxt", "resolveSrv", "reverse"]) wrap(dns, name, `dns.${name}`);
for (const name of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]) wrap(dns.promises, name, `dns.promises.${name}`);
for (const [mod, label] of [[http, "http"], [https, "https"]]) for (const name of ["request", "get"]) wrap(mod, name, `${label}.${name}`, (a) => (a[0] instanceof URL ? a[0].href : typeof a[0] === "string" ? a[0] : { host: a[0]?.host ?? a[0]?.hostname, port: a[0]?.port }));
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) wrap(cp, name, `child_process.${name}`);
if (typeof globalThis.fetch === "function") {
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = function sensedFetch(input, init) { record("fetch", input instanceof URL ? input.href : String(input?.url ?? input)); return fetchOriginal(input, init); };
}
syncBuiltinESMExports();   // ESM named imports of these builtins see the wrapped functions
record("sensor.armed", process.argv.slice(1, 3).join(" "));
export { NOT_EGRESS } from "./egress-sensor-kinds.mjs";
