import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

test("app-root resources, public summaries and HTTPS standards stay isolated from launch cwd", () => {
  const home = mkdtempSync(join(tmpdir(), "agentc-public-identity-"));
  try {
    const app = join(home, "app"), data = join(home, "data"), cwd = join(home, "launch");
    for (const dir of [app, data, cwd, join(app, "packages/agent-commons/profiles"), join(app, "docs/agents")])
      mkdirSync(dir, { recursive: true });
    for (const name of ["local", "agentnet.chat", "zilligon.com"])
      copyFileSync(join(root, `packages/agent-commons/profiles/${name}.json`), join(app, `packages/agent-commons/profiles/${name}.json`));
    writeFileSync(join(app, "agent-commons.adapters.json"), JSON.stringify({ version: 1, defaultAdapter: "stub" }));
    writeFileSync(join(cwd, "agent-commons.adapters.json"), JSON.stringify({ version: 1, defaultAdapter: "cwd-decoy" }));
    const script = join(home, "public-identity.mjs");
    writeFileSync(script, `
import assert from "node:assert/strict";
import {writeFileSync} from "node:fs";
import {join} from "node:path";
const {default:Database}=await import(${JSON.stringify(new URL("../node_modules/better-sqlite3/lib/index.js", import.meta.url).href)});
const {storage}=await import(${JSON.stringify(new URL("./storage.ts", import.meta.url).href)});
const {networkConsole,NetworkConsole}=await import(${JSON.stringify(new URL("./network.ts", import.meta.url).href)});
const {cohortConsole,CohortConsole}=await import(${JSON.stringify(new URL("./cohort.ts", import.meta.url).href)});
const {foundingCohort}=await import(${JSON.stringify(new URL("../shared/cohort.ts", import.meta.url).href)});
const {loadAdaptersConfig}=await import(${JSON.stringify(new URL("./adapters/config.ts", import.meta.url).href)});
assert.equal(loadAdaptersConfig().defaultAdapter,"stub");
assert.ok(networkConsole.state.profiles.length>=3);
writeFileSync(join(process.env.AGENT_COMMONS_APP_DIR,"docs/agents",foundingCohort[0].document),"App-root contribution fixture");
cohortConsole.importReports();
assert.ok(cohortConsole.state.entries.some(e=>e.body==="App-root contribution fixture"));
const initialNetwork=networkConsole.summary().identities;
const initialCohort=cohortConsole.summary().members.map(m=>m.uuaid);
assert.ok(initialNetwork.every(i=>i.uuaid));assert.ok(initialCohort.every(Boolean));
const reopened=new NetworkConsole();const reloaded=new CohortConsole();
assert.deepEqual(reopened.summary().identities,initialNetwork);
assert.deepEqual(reloaded.summary().members.map(m=>m.uuaid),initialCohort);
assert.ok(reloaded.summary().verified);
assert.ok(reloaded.state.entries.some(e=>e.body==="App-root contribution fixture"));
const urls=["https://authority.example/standard","http://authority.example/standard","javascript:alert(1)","//authority.example/standard"];
await networkConsole.check({env:{AGENT_COMMONS_OFFLINE:"0"},fetchImpl:async(url)=>({ok:true,json:async()=>({standards:["IAASO-1001","IAASO-2001","IAASO-3101","IAASO-3301"].map((code,i)=>({code,stage:"published",doc_url:urls[i]}))})}),lookupImpl:async()=>({address:"127.0.0.1",family:4})});
assert.deepEqual(networkConsole.state.checks[0].standards.map(s=>s.url),[urls[0],null,null,null]);
networkConsole.state.checks=[{service:"saved",standards:urls.map(url=>({url}))}];
assert.deepEqual(networkConsole.summary().checks[0].standards.map(s=>s.url),[urls[0],null,null,null]);
const fixture=new Database(join(process.env.AGENT_COMMONS_DATA_DIR,"commons.db"));
const keysBefore=fixture.prepare("SELECT * FROM agent_keys ORDER BY id").all();
const snapshotsBefore=fixture.prepare("SELECT * FROM snapshots ORDER BY id").all();
const originalPrepare=Database.prototype.prepare;const publicReads=[];
Database.prototype.prepare=function(sql){if(/agent_keys/.test(sql))publicReads.push(sql);return originalPrepare.call(this,sql)};
const publicOnlyId="public-only-fixture";storage.key(publicOnlyId);
const publicOnly=storage.existingPublicKey(publicOnlyId);
publicReads.length=0;
storage.key=()=>{throw new Error("PRIVATE_KEY_READ_OR_CREATE")};
for(const method of ["saveValue","saveNetwork","saveCohort","save"])storage[method]=()=>{throw new Error("SUMMARY_WRITE")};
networkConsole.identity=()=>{throw new Error("SIGNING_IDENTITY_ON_READ")};
for(let i=0;i<3;i++){
  assert.deepEqual(networkConsole.summary().identities,initialNetwork);
  assert.deepEqual(cohortConsole.summary().members.map(m=>m.uuaid),initialCohort);
  assert.equal(cohortConsole.summary().verified,true);
}
assert.ok(networkConsole.publicIdentity(publicOnlyId));
assert.equal(storage.existingPublicKey(publicOnlyId),publicOnly);
assert.equal(networkConsole.publicIdentity("absent-public-identity"),null);
assert.equal(storage.existingPublicKey("absent-public-identity"),null);
assert.ok(publicReads.length>0);assert.ok(publicReads.every(sql=>!sql.includes("private_key")));
Database.prototype.prepare=originalPrepare;
assert.deepEqual(fixture.prepare("SELECT * FROM agent_keys WHERE id != ? ORDER BY id").all(publicOnlyId),keysBefore);
assert.deepEqual(fixture.prepare("SELECT * FROM snapshots ORDER BY id").all(),snapshotsBefore);
fixture.close();
`);
    const result = spawnSync(process.execPath, ["--import", require.resolve("tsx"), script], {
      cwd, env: { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: home, TZ: "America/Los_Angeles", NODE_ENV: "test",
        AGENT_COMMONS_APP_DIR: app, AGENT_COMMONS_DATA_DIR: data, TSX_TSCONFIG_PATH: join(root, "tsconfig.json"),
        AGENT_COMMONS_OFFLINE: "1", AGENT_COMMONS_ADAPTER: "stub", AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED: "0" },
      encoding: "utf8", maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(cwd, "commons.db")), false);
    assert.equal(existsSync(join(app, "commons.db")), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
