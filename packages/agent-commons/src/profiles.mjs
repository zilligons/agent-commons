import { createHash, randomUUID } from "node:crypto";
import { jcs, Keychain } from "./pillar.mjs";

export const BASE_PROTOCOL = "agent-commons/1";
export function digest(value) { assertJSON(value);return createHash("sha256").update(jcs(value)).digest("hex"); }
export function assertJSON(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isSafeInteger(value)) return;
  if (Array.isArray(value)) return value.forEach(assertJSON);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) {
      if (!/^[\x20-\x7e]+$/.test(key) || ["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Unsafe canonical key");
      assertJSON(item);
    }
    return;
  }
  throw new Error("Expected canonical JSON; decimal measurements must be strings");
}
export function encode(body, lexicon) {
  let wire=body.replaceAll("~","~~");
  for (const [phrase,alias] of Object.entries(lexicon).sort((a,b)=>b[0].length-a[0].length)) wire=wire.split(phrase).join(alias);
  return wire;
}
export function decode(wire, lexicon) {
  const reverse=new Map(Object.entries(lexicon).map(([k,v])=>[v,k]));
  return wire.replace(/~~|~\d+~/g,t=>t==="~~"?"~":reverse.get(t)??t);
}
export function validateLexicon(lexicon) {
  if (!lexicon || typeof lexicon!=="object" || Array.isArray(lexicon) || Object.keys(lexicon).length>128) throw new Error("Invalid lexicon");
  const symbols=new Set();
  for (const [phrase,symbol] of Object.entries(lexicon)) {
    if (!/^[A-Za-z][A-Za-z ]{7,79}$/.test(phrase) || phrase!==phrase.trim() || !/^~\d{1,3}~$/.test(symbol) || symbols.has(symbol)) throw new Error("Invalid or colliding alias");
    symbols.add(symbol);
  }
}
export function benchmark(lexicon, fixtures) {
  validateLexicon(lexicon);
  let originalBytes=0,wireBytes=0,passed=0;
  for (const fixture of fixtures) {
    const wire=encode(fixture,lexicon);
    if(decode(wire,lexicon)===fixture)passed++;
    originalBytes+=Buffer.byteLength(fixture);wireBytes+=Buffer.byteLength(wire);
  }
  return {tests:fixtures.length,passed,originalBytes,wireBytes,reductionBps:originalBytes?Math.round(10000*(originalBytes-wireBytes)/originalBytes):0};
}
const safetyFixtures=["","~0~","~~","~123~","தமிழ் மொழி","🧬","\n\\\"", "a".repeat(128)];
export function createProfile({ namespace, name, fixtures, scope="local", lexicon={}, parent=null, revision=0, quorum=2 }) {
  if (!/^[a-z0-9][a-z0-9._/-]{1,119}$/.test(namespace)||typeof name!=="string"||name.length<2||name.length>120) throw new Error("Invalid profile name or namespace");
  if (!["local","tenant","global"].includes(scope)) throw new Error("Invalid profile scope");
  if(!Array.isArray(fixtures)||fixtures.length<2||fixtures.length>100||fixtures.some(f=>typeof f!=="string"||f.length>8000)||Buffer.byteLength(JSON.stringify(fixtures))>256000) throw new Error("Provide 2–100 bounded text fixtures");
  if(!Number.isSafeInteger(revision)||revision<0||!Number.isSafeInteger(quorum)||quorum<2||quorum>10)throw new Error("Invalid profile revision or quorum");
  validateLexicon(lexicon);
  const report=benchmark(lexicon,[...fixtures,...safetyFixtures]);
  if(report.tests!==report.passed)throw new Error("Profile fails lossless gate");
  const document={v:BASE_PROTOCOL,namespace,name,scope,parent,revision,quorum,lexicon,fixtureHash:digest(fixtures),fixtures};
  assertJSON(document);
  return {...document,id:digest(document),benchmark:report};
}
export function verifyProfile(profile) {
  const allowed=new Set(["v","namespace","name","scope","parent","revision","quorum","lexicon","fixtureHash","fixtures","id","benchmark"]);
  if(Object.keys(profile??{}).some(key=>!allowed.has(key)))throw new Error("Unknown profile field");
  const rebuilt=createProfile(profile);
  if(rebuilt.id!==profile.id || digest(rebuilt.benchmark)!==digest(profile.benchmark))throw new Error("Profile digest or benchmark mismatch");
  return rebuilt;
}
export function proposeAlias(profile, phrase) {
  verifyProfile(profile);
  if(Object.hasOwn(profile.lexicon,phrase))throw new Error("Alias already exists");
  const numbers=Object.values(profile.lexicon).map(s=>Number(s.slice(1,-1)));
  const alias=`~${numbers.length?Math.max(...numbers)+1:0}~`;
  const candidate=createProfile({...profile,lexicon:{...profile.lexicon,[phrase]:alias},parent:profile.id,revision:profile.revision+1});
  if(candidate.benchmark.wireBytes>=profile.benchmark.wireBytes)throw new Error("Candidate does not improve the local benchmark");
  return {id:randomUUID(),parent:profile.id,candidate,phrase,alias,status:"pending",votes:{}};
}
export function signDocument(keychain, kind, payload) {
  assertJSON(payload);
  const body={v:BASE_PROTOCOL,id:randomUUID(),kind,issuer:keychain._identity.uuaid,publicKey:keychain._identity.publicKeyHex,createdAt:new Date().toISOString(),payload};
  return {...body,signature:keychain.sign(Buffer.from(jcs(body))).toString("hex")};
}
export function verifyDocument(document) {
  assertJSON(document);
  const {signature,...body}=document;
  if(body.v!==BASE_PROTOCOL||!["profile-proposal","profile-vote","profile-contribution","profile-recovery"].includes(body.kind)||!/^uuaid:[a-z0-9-]+:agent:[0-9a-f-]{36}$/.test(body.issuer)||!/^[0-9a-f]{64}$/.test(body.publicKey)||!/^[0-9a-f]{128}$/.test(signature))throw new Error("Invalid agent document");
  if(Keychain.localIdFromKey(Buffer.from(body.publicKey,"hex"))!==body.issuer.split(":")[3])throw new Error("Agent key is not bound to UUAID");
  if(!Keychain.verifyDetached(body.publicKey,Buffer.from(jcs(body)),Buffer.from(signature,"hex")))throw new Error("Invalid document signature");
  return body;
}
export function contribution(profile, { includeFixtures=false }={}) {
  verifyProfile(profile);
  return {profileId:profile.id,namespace:profile.namespace,parent:profile.parent,base:BASE_PROTOCOL,lexicon:profile.lexicon,fixtureHash:profile.fixtureHash,benchmark:profile.benchmark,visibility:includeFixtures?"shared-fixtures":"metadata-only",...(includeFixtures?{profile}:{}),stage:"candidate",standardization:"requires-IAASO-review"};
}
