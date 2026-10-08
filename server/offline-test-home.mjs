
// Isolate offline server tests inside L1; NODE_OPTIONS preload runs before tsx/server imports.
// SQLite is memory-only here; production storage is out of scope.
import { registerHooks } from "node:module";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";

// The test-runner parent keeps its cwd so it can resolve server/*.test.ts.
if (isMainThread && process.env.NODE_TEST_CONTEXT) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const homes = join(root, "node_modules", ".offline-test-homes");
  mkdirSync(homes, { recursive: true });
  const home = mkdtempSync(join(homes, "test-"));
  symlinkSync(join(root, "packages"), join(home, "packages"), "dir");
  symlinkSync(join(root, "docs"), join(home, "docs"), "dir");
  process.env.TMPDIR = home;
  process.env.TSX_TSCONFIG_PATH = join(root, "tsconfig.json");
  process.env.PYTHONDONTWRITEBYTECODE = "1";
  process.chdir(home);

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "better-sqlite3") return {
        url: new URL("./offline-sqlite.mjs", import.meta.url).href,
        shortCircuit: true,
      };
      return nextResolve(specifier, context);
    },
  });
  process.on("exit", () => rmSync(home, { recursive: true, force: true }));
}
