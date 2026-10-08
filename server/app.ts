/**
 * L10 — the application module. Loaded ONLY by the bootstrap at
 * server/index.ts via dynamic import AFTER the §c scrub has proven the
 * env clean (v3 §c L69: "the phase-2 boundary therefore changes index into
 * a bootstrap importing only Node builtins and the side-effect-free
 * env-policy module, then dynamically imports the application module after
 * validation. Preserve the existing server code in server/app.ts").
 *
 * This module carries every application import. It MUST NEVER be imported
 * statically by any launch path — a static import would evaluate it before
 * the bootstrap scrub runs (ESM evaluates all static imports before the
 * first body statement; the security reviewer B1 pole).
 *
 * D1 (rework 2, v3 L77) + R1 (rework 5): NO automatic `import "dotenv/config"`.
 * The bootstrap at server/index.ts already ran the guarded dotenv loader
 * with the v3 §c L71 app-control allowlist against the closed console
 * env (R1). app.ts does not re-parse; the loader is exported only for
 * the two-pole test. ESM evaluates app.ts's static imports before any
 * body statement, so a second .env parse here would also see the
 * already-closed console — keeping the parse in the bootstrap is the
 * single point of validation the design requires.
 *
 */
// R1 (rework 5): the bootstrap already validated the effective
// controllable config (v3 §c L71 allowlist). Re-importing would only
// re-parse a file whose keys the bootstrap already applied.
// import { applyDotenvGuardedOrExit } from "./dotenv-guard"; // moved to bootstrap
// D1: parse .env, reject §c names (terminal ENV_REFUSED), apply allowed keys.
// Runs at application evaluation — AFTER the bootstrap scrub proved the
// console clean — and can never inject a refused name back in.
// applyDotenvGuardedOrExit() moved to server/index.ts (R1, rework 5).
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "node:http";
import { operatorGuard } from "./operator";
import { listenOptions } from "./listen_host";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));
app.use(operatorGuard);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  // Loopback unless AGENT_COMMONS_BIND_ALL=1. Preview and the operator
  // token do not change the host. See server/listen_host.ts.
  const { port, host, reusePort } = listenOptions(process.env);
  httpServer.listen(
    {
      port,
      host,
      reusePort,
    },
    () => {
      log(`serving on http://${host}:${port}`);
    },
  );
})();
