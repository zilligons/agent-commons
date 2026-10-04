import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { Keychain } from "./pillar.mjs";
import { createProfile } from "./profiles.mjs";
import { CommonsStore } from "./store.mjs";
import { AgentCommons } from "./runtime.mjs";

export const CAPABILITIES=["commons:message","commons:relay","commons:evolve","commons:contribute","commons:recover"];
export function homePath(path){return resolve(path??join(homedir(),".agent-commons"))}
export function saveConfig(home,config){writeFileSync(join(home,"config.json"),JSON.stringify(config,null,2),{mode:0o600});chmodSync(join(home,"config.json"),0o600)}
export function initialize({home,target="local",name="Agent Commons"}={}){
  home=homePath(home);mkdirSync(home,{recursive:true,mode:0o700});
  if(existsSync(join(home,"config.json"))||existsSync(join(home,"identity.json")))throw new Error("Home already initialized or contains an identity; existing identity was not overwritten");
  if(!["local","agentnet.chat","zilligons.com"].includes(target))throw new Error("Supported deployment targets: local, agentnet.chat, zilligons.com");
  const passphrase=process.env.AGENT_COMMONS_PASSPHRASE??randomBytes(32).toString("base64url");
  if(!process.env.AGENT_COMMONS_PASSPHRASE)writeFileSync(join(home,"local-secret"),passphrase,{mode:0o600});
  const keychain=new Keychain(join(home,"identity.json"));keychain.save(Keychain.generate(),{passphrase});
  const identity=keychain.publicView();
  const config={version:1,name,target,role:"host",carriers:[],policy:{mode:"local",registryUrl:"https://api.uuaid.org",authorityUrl:"https://authority.iaaso.org",standardPins:{},blocked:[],agents:{[identity.uuaid]:{kind:"agent",publicKey:identity.publicKeyHex,capabilities:CAPABILITIES}}}};
  saveConfig(home,config);
  const store=new CommonsStore(join(home,"commons.db"));
  const template=JSON.parse(readFileSync(new URL(`../profiles/${target==="local"?"local":target}.json`,import.meta.url),"utf8"));
  const profile=createProfile(template);
  const runtime=new AgentCommons({keychain,store,policy:config.policy});runtime.addProfile(profile);store.close();
  return {home,identity,target,profileId:profile.id,registryRegistration:"not-performed",certified:false,keyProtection:process.env.AGENT_COMMONS_PASSPHRASE?"environment-passphrase":"file-permissions-with-colocated-local-secret"};
}
export function loadRuntime(home){
  home=homePath(home);
  const config=JSON.parse(readFileSync(join(home,"config.json"),"utf8"));
  const passphrase=process.env.AGENT_COMMONS_PASSPHRASE??readFileSync(join(home,"local-secret"),"utf8");
  const keychain=new Keychain(join(home,"identity.json"));keychain.load({passphrase});
  const store=new CommonsStore(join(home,"commons.db"));
  return {home,config,keychain,store,runtime:new AgentCommons({keychain,store,policy:config.policy,carriers:config.carriers})};
}
