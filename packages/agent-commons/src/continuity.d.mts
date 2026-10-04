export type ProvenanceSource = "self"|"peer"|"operator"|"tool";
export interface ContinuityStore {get(key:string,fallback?:unknown):any;set(key:string,value:unknown):void;transaction?<T>(fn:()=>T):T}
export interface MemoryKeychain {_identity:{uuaid:string;publicKeyHex:string};sign(bytes:Buffer):Buffer}
export interface MemoryClient {saveMemory(agent:string,slot:string,text:string,key:string):Promise<any>;loadMemory(agent:string,slot:string,key:string):Promise<string>}
export interface ContinuityEntry {id:string;seq:number;kind:string;content:any;hash:string;signature:string;at:string;provenance:any}
export interface ContinuityOptions {keychain:MemoryKeychain;store?:ContinuityStore;client?:MemoryClient|null;vaultKey?:string|null;slot?:string;limits?:{maxEntries?:number;maxBytes?:number;maxEntryBytes?:number;retentionMs?:number};now?:()=>number}
export declare class ContinuityMemory {
  constructor(options:ContinuityOptions);
  readonly uuaid:string;readonly publicKey:string;
  remember(kind:string,content:unknown,provenance?:{source?:ProvenanceSource;actor?:string;origin?:string|null;evidence?:string|null;pin?:boolean}):ContinuityEntry;
  recall(filter?:{kind?:string;since?:string;source?:ProvenanceSource;limit?:number}):ContinuityEntry[];
  verify():boolean;head():string;status():any;
  snapshot():any;
  reload():any;compact():any;expired():any;
  push():Promise<any>;pull():Promise<any>;sync():Promise<any>;
  static storeKey(uuaid:string):string;
  static quarantine(store:ContinuityStore,uuaid:string):string|null;
}
export declare class ContinuityError extends Error {code:string}
export declare class MemoryContinuityStore implements ContinuityStore {get(key:string,fallback?:unknown):any;set(key:string,value:unknown):void;transaction<T>(fn:()=>T):T}
export declare const CONTINUITY_PROTOCOL:string;
export declare const PROVENANCE_SOURCES:readonly ProvenanceSource[];
export declare function validateSlot(slot:string):string;
export declare function verifyContinuity(state:unknown,owner:unknown,options?:any):any;
