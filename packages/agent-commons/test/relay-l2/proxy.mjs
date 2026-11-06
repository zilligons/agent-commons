// L2 tests: a minimal stand-in for the host's reverse proxy (nginx in production, a P4 design item).
// It forwards every request to the relay on loopback HTTP, replaces any client-sent X-Real-IP with the
// connection's own address, and, given a key and certificate, terminates TLS. Test-only.

import { createServer as createHttpServer, request } from "node:http";
import { createServer as createHttpsServer } from "node:https";

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "upgrade", "te", "trailer", "x-real-ip"]);
const clientIp = (socket) => String(socket?.remoteAddress ?? "").replace(/^::ffff:/, "");

/** Start the proxy on 127.0.0.1. target: {host, port} of the relay. tls: {key, cert} PEM, or null for plain HTTP. */
export function startProxy({ target, tls = null, port = 0 }) {
  const handler = (req, res) => {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
    headers["x-real-ip"] = clientIp(req.socket);
    const up = request({ host: target.host, port: target.port, method: req.method, path: req.url, headers, agent: false }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  };
  const server = tls ? createHttpsServer({ key: tls.key, cert: tls.cert }, handler) : createHttpServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, () => {
      resolve({ port: server.address().port, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }) });
    });
  });
}
