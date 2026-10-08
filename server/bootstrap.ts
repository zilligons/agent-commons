/**
 * L10 — bootstrap helper (side-effect-free). The launch entry
 * server/index.ts calls scrubAndProve; the two-pole test imports the same
 * function here so the test never triggers the bootstrap's dynamic app
 * import or process.exit.
 *
 */
import { scrubEnv, buildClosedConsoleEnv } from "./adapters/l10-env";

/** R1 (rework 5): re-exported so the bootstrap can construct the closed
 *  console env without importing the l10-env barrel directly. */
export { buildClosedConsoleEnv };

/**
 * Scrub + prove-clean. Deletes every refused name it can, then
 * re-inventories. Returns null when clean, or the sorted names still
 * refused (survivors — e.g. an undeletable/frozen name), which the launch
 * bootstrap turns into terminal ENV_REFUSED (v3 §c L73).
 */
export function scrubAndProve(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const first = scrubEnv(env);
  for (const name of first.refused) {
    try { delete env[name]; } catch { /* cannot delete; surfaces below */ }
  }
  const second = scrubEnv(env);
  return second.refused.length === 0 ? null : second.refused;
}
