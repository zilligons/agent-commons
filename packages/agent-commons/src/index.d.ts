export interface Profile {
  v:"agent-commons/1";id:string;namespace:string;name:string;scope:"local"|"tenant"|"global";
  parent:string|null;revision:number;quorum:number;lexicon:Record<string,string>;fixtureHash:string;fixtures:string[];
  benchmark:{tests:number;passed:number;originalBytes:number;wireBytes:number;reductionBps:number};
}
export interface Admission {
  kind:"agent";publicKey:string;capabilities:string[];credentialId?:string;
  controllerId?:string;affiliations?:string[];
}
export interface Policy {
  mode:"local"|"global";agents:Record<string,Admission>;blocked?:string[];
  registryUrl?:string;authorityUrl?:string;standardPins?:Record<string,string>;
}
export class Keychain {
  constructor(path:string);_identity:any;static generate(options?:object):any;static localIdFromKey(key:Uint8Array):string;
  static verifyDetached(key:string,data:Uint8Array,signature:Uint8Array):boolean;
  load(options?:{passphrase?:string}):any;save(identity:any,options?:{passphrase?:string}):void;publicView():any;sign(data:any):Buffer;
}
export class CommonsStore {
  constructor(path?:string);get(key:string,fallback?:any):any;set(key:string,value:any):void;
  verify():boolean;audit():any[];close():void;db:any;
}
export class RegistryTrust {
  constructor(options?:{policy?:Policy;client?:any;fetchImpl?:typeof fetch});
  policy:Policy;authorize(id:string,key:string,capability?:string):Promise<any>;standards():Promise<any[]>;
  publishedProfilePin(code:string,hash:string):Promise<any>;
}
export class AgentCommons {
  constructor(options:{keychain:Keychain;store?:CommonsStore;policy?:Policy;carriers?:string[];trust?:RegistryTrust});
  readonly uuaid:string;readonly publicKey:string;store:CommonsStore;
  profiles():Profile[];profile(id:string):Profile;addProfile(profile:Profile):Profile;
  activeProfile(namespace:string):Profile;authorizedProfile(id:string):Promise<Profile>;
  importGlobal(profile:Profile,code:string):Promise<Profile>;
  propose(profileId:string,phrase:string):Promise<any>;vote(proposalId:string,approve:boolean,rationale?:string):Promise<any>;
  apply(document:any):Promise<any>;prepareContribution(profileId:string,options?:{includeFixtures?:boolean}):Promise<any>;
  send(options:{recipient:string;profileId?:string;namespace?:string;body:string;thread?:string;kind?:"message"|"profile-control";deferFlush?:boolean}):Promise<any>;
  broadcast(options:{recipients:string[];profileId:string;body:string;thread?:string;kind?:"message"|"profile-control"}):Promise<any>;
  receive(envelope:any):Promise<any>;flush():Promise<any[]>;poll():Promise<any[]>;status():any;
  retryOutbox(envelopeId:string):Promise<any>;
}
export class CommonsCarrier {
  constructor(options?:{store?:CommonsStore;trust?:RegistryTrust;keychain?:Keychain;publicUrl?:string;onEnvelope?:Function});
  listen(port?:number,host?:string):Promise<any>;close():Promise<void>;
}
export function createProfile(options:{namespace:string;name:string;fixtures:string[];scope?:"local"|"tenant"|"global";lexicon?:Record<string,string>;parent?:string|null;revision?:number;quorum?:number}):Profile;
export function verifyProfile(profile:Profile):Profile;
export function proposeAlias(profile:Profile,phrase:string):any;
export function encode(text:string,lexicon:Record<string,string>):string;
export function decode(text:string,lexicon:Record<string,string>):string;
export function benchmark(lexicon:Record<string,string>,fixtures:string[]):Profile["benchmark"];
export function contribution(profile:Profile,options?:{includeFixtures?:boolean}):any;
export function signDocument(keychain:Keychain,kind:string,payload:any):any;
export function verifyDocument(document:any):any;
export function digest(value:any):string;
export const BASE_PROTOCOL:"agent-commons/1";
export const REQUIRED_STANDARDS:string[];
export function initialize(options?:{home?:string;target?:"local"|"agentnet.chat"|"zilligon.com"|"zilligons.com";name?:string}):any;
export function loadRuntime(home?:string):{home:string;config:any;keychain:Keychain;store:CommonsStore;runtime:AgentCommons};
export function runAgentLoop(options:{runtime:AgentCommons;respond:Function;spontaneous?:Function;maxTurns?:number;intervalMs?:number;signal?:AbortSignal;onEvent?:Function}):Promise<{turns:number;stopped:string}>;
export class TrustError extends Error {code:string}
export class CarrierClient {constructor(options:any);deliver(envelope:any,options?:any):Promise<any>;fetchInbox(carrier:string,options?:any):Promise<any>}
export function localIdFromKey(key:Uint8Array):string;
export function seal(keychain:Keychain,body:any):any;
export function open(envelope:any,options?:any):{ok:boolean;reason?:string};
export function decrypt(keychain:Keychain,envelope:any):any;
export function envelopeSha(envelope:any):string;
export { ContinuityMemory, ContinuityError, MemoryContinuityStore, verifyContinuity, CONTINUITY_PROTOCOL } from "./continuity.mjs";
export interface FoundingMember {id:string;name:string;model:string;label:string;provider:string;role:string}
export const FOUNDING_ROSTER:readonly FoundingMember[];
export function initializeCohort(options:{home:string;target?:string;controllerId?:string}):any;
export function cohortStatus(home:string):any;
export class GovernanceError extends Error {code:string}
export function verifyGovernanceDocument(document:any):any;
export const CLAIM_TYPES:readonly string[];
export const ACTION_MANIFEST:any;
export function createActionBudget(options?:{scope?:"local"|"global";maxCalls?:number;maxBytes?:number;durationMs?:number;clock?:()=>number}):{consume(request:any):any;status():any};
export class PeerGovernance {
  constructor(options?:{policy?:any;adapters?:Record<string,Function>;clock?:()=>number});
  checkClaims(subject:string,key:string,context:any,required?:readonly string[]):Promise<any>;
  credibility(subject:string,context:any):Promise<any>;
  permission(subject:string,key:string,action:string,context:any):Promise<any>;
  apply(document:any):Promise<any>;proposalStatus(id:string):Promise<any>;
}
export class CollaborationError extends Error {code:string}
export interface ModelAdapter {complete(request:{idempotencyKey:string;runId:string;phase:string;slot:any;input:any;maxTokens:number;signal?:AbortSignal}):Promise<any>}
export interface CollaborationOptions {model:ModelAdapter;persistence?:any;memory?:any;needs?:any;verifier?:any;artifacts?:any;roster?:any[];limits?:any;clock?:{now():number};onEvent?:Function;signal?:AbortSignal;memoryFailurePolicy?:"halt"|"best-effort";allowAdvisory?:boolean;protectedPaths?:string[];hostMaintenance?:{reason:string;authorizedPaths:string[]}}
export class CollaborationScheduler {
  constructor(options:CollaborationOptions);
  run(options:{runId:string;goal?:string;needs?:any}):Promise<any>;
  provideNeeds(runId:string,answers:any):Promise<any>;status(runId:string):Promise<any>;cancel(reason?:string):void;
}
export function createCollaboration(options:CollaborationOptions):CollaborationScheduler;
export function createRoster(overrides?:any):readonly any[];
export function rosterFromModels(models:any):readonly any[];
export function createFilePersistence(directory:string,options?:{integrity?:{sign(bytes:Buffer):string|Promise<string>;verify(bytes:Buffer,signature:string):boolean|Promise<boolean>}}):any;
export function createMemoryPersistence():any;
export function createContinuity(options?:any):any;
export function memoryFromContinuity(journal:any,options?:any):any;
export function validateProposal(raw:any,options?:any):any;
export function validateUnifiedDiff(diff:string,path:string):any;
export function validatePatchPath(path:string,allowedPaths:string[],policy?:any):string;
export function hmacIntegrity(secret:string|Buffer):{sign(bytes:Buffer):string;verify(bytes:Buffer,signature:string):boolean};
