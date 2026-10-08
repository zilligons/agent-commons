/**
 * L10 rework 1 — B1 poles: bootstrap scrub is not a no-op (the security reviewer B1).
 *
 * CONTROL: a parent env carrying a refused name is scrubbed by
 * scrubAndProve BEFORE app evaluation — a scratch "app" module
 * dynamically imported afterwards does not see the name, and startup
 * continues.
 *
 * MUTANT: the old shape (static application imports beside the scrub)
 * provably evaluates the application before the scrub — scratch ESM
 * modules demonstrate the import-order defect the security reviewer measured, and the
 * probe also asserts the scratch app observed the refused name.
 *
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { scrubAndProve } from "./bootstrap";

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), "l10-b1-"));
  try {
    // CONTROL — scrubAndProve deletes the refused name and proves clean.
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: scratch,
      AWS_REGION: "us-west-2",       // refused (prefix)
      ANTHROPIC_AUTH_TOKEN: "x",     // refused (single)
      MY_API_KEY: "k",               // refused (family)
      LEGIT: "ok",
    };
    const survivors = scrubAndProve(env);
    assert.equal(survivors, null, "CONTROL: scrub must prove clean");
    assert.equal(env.AWS_REGION, undefined, "refused prefix name deleted");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined, "refused single deleted");
    assert.equal(env.MY_API_KEY, undefined, "refused family deleted");
    assert.equal(env.LEGIT, "ok", "clean name kept");

    // CONTROL (app-never-sees-it): a scratch "app" module imported AFTER
    // the scrub observes the env without the refused name.
    process.env.B1_PROBE_KEY = "should-be-deleted";
    // B1_PROBE_KEY contains API_KEY? No — use a real refused name:
    delete process.env.B1_PROBE_KEY;
    process.env.XAI_PROBE_KEY = "probe"; // refused: XAI_ prefix
    const appProbe = join(scratch, "app-probe.mjs");
    writeFileSync(
      appProbe,
      `export const saw = process.env.XAI_PROBE_KEY ?? null;\n`,
    );
    scrubAndProve(process.env);
    const mod = await import(pathToFileURL(appProbe).href);
    assert.equal(mod.saw, null, "CONTROL: app evaluated after scrub never sees the refused name");
    delete process.env.XAI_PROBE_KEY;

    // MUTANT — the old static-import shape evaluates the app FIRST.
    // Reproduce the security reviewer's /tmp probe: a module whose body runs a "scrub"
    // statement but statically imports the app; the app's evaluation
    // order marker proves it ran before the body statement.
    const order: string[] = [];
    (globalThis as Record<string, unknown>).__b1Order = order;
    const oldShape = join(scratch, "old-shape.mjs");
    const oldApp = join(scratch, "old-app.mjs");
    writeFileSync(oldApp, `(globalThis).__b1Order.push("app-evaluated");\n`);
    writeFileSync(
      oldShape,
      `import "./old-app.mjs";\n(globalThis).__b1Order.push("body-ran-scrub-here");\n`,
    );
    await import(pathToFileURL(oldShape).href);
    assert.deepEqual(order, ["app-evaluated", "body-ran-scrub-here"],
      "MUTANT: static import evaluates before the body scrub statement (the B1 defect)");

    // MUTANT (env consequence): in the old shape the app also observes
    // the refused name, because nothing scrubbed before its evaluation.
    process.env.XAI_PROBE2 = "probe2";
    const order2: string[] = [];
    (globalThis as Record<string, unknown>).__b1Order2 = order2;
    writeFileSync(join(scratch, "old-app2.mjs"),
      `(globalThis).__b1Order2.push("app-saw:" + (process.env.XAI_PROBE2 ?? "null"));\n`);
    writeFileSync(join(scratch, "old-shape2.mjs"),
      `import "./old-app2.mjs";\ndelete process.env.XAI_PROBE2;\n(globalThis).__b1Order2.push("scrubbed");\n`);
    await import(pathToFileURL(join(scratch, "old-shape2.mjs")).href);
    assert.equal(order2[0], "app-saw:probe2", "MUTANT: unscrubbed app observes the refused name");
    assert.equal(order2[1], "scrubbed");

    // Proof-of-clean refusal: an env whose refused name cannot be deleted
    // surfaces the survivor (frozen env simulates an undeletable name).
    const frozen = Object.freeze({ PATH: "/usr/bin", AWS_REGION: "us" }) as NodeJS.ProcessEnv;
    const frozenSurvivors = scrubAndProve(frozen);
    assert.deepEqual(frozenSurvivors, ["AWS_REGION"],
      "undeletable refused name must surface as a survivor (terminal ENV_REFUSED at launch)");

    console.log("PASS B1: CONTROL scrub-before-app (name deleted, app never sees it, startup continues); MUTANT static-import order defect reproduced; undeletable survivor proves ENV_REFUSED.");
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch {}
    delete process.env.XAI_PROBE_KEY;
    delete process.env.XAI_PROBE2;
  }
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
