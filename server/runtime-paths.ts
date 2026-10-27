import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Runtime roots come from the process environment, never the launch directory. */
export function resolveRuntimePaths(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === "production";
  const roots = {
    appDir: env.AGENT_COMMONS_APP_DIR,
    dataDir: env.AGENT_COMMONS_DATA_DIR,
  };
  for (const [name, value] of Object.entries(roots)) {
    const variable = name === "appDir" ? "AGENT_COMMONS_APP_DIR" : "AGENT_COMMONS_DATA_DIR";
    if (value === undefined) {
      if (production) throw new Error(`${variable} must be an explicit absolute directory in production`);
    } else if (!isAbsolute(value) || value.includes("\0")) {
      throw new Error(`${variable} must be an absolute directory`);
    }
  }
  // Production bundles use CommonJS: import.meta.url is unavailable there.
  // Resolve the source fallback only after explicit production roots passed.
  let sourceRoot: string | undefined;
  const developmentRoot = () => sourceRoot ??= fileURLToPath(new URL("../", import.meta.url));
  const appDir = roots.appDir ?? developmentRoot();
  const dataDir = roots.dataDir ?? developmentRoot();
  return { appDir, dataDir, databasePath: join(dataDir, "commons.db"), production };
}
