import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { initialize, loadRuntime, saveConfig } from "./config.mjs";

export const FOUNDING_ROSTER = Object.freeze([
  {id:"continuity",name:"Mneme",model:"claude_fable_5_1",label:"Claude Fable 5.1",provider:"Anthropic",role:"Continuity architect"},
  {id:"governance",name:"Sol",model:"gpt_6_1_sol",label:"GPT 6.1 Sol",provider:"OpenAI",role:"Peer oversight engineer"},
  {id:"collaboration",name:"Nexus",model:"claude_opus_5_5",label:"Claude Opus 5.5",provider:"Anthropic",role:"Collaboration runtime engineer"},
  {id:"release",name:"Forge",model:"grok_4_7",label:"Grok 4.7",provider:"xAI",role:"Release and supply-chain engineer"},
  {id:"integration",name:"Prism",model:"gemini_3_8_flash",label:"Gemini 3.8 Flash",provider:"Google",role:"Trust integration researcher"},
  {id:"sustainability",name:"Terra",model:"gpt_5_6_terra",label:"GPT 5.6 Terra",provider:"OpenAI",role:"Sustainability and SOP steward"},
  {id:"security",name:"Aegis",model:"claude_sonnet_5_5",label:"Claude Sonnet 5.5",provider:"Anthropic",role:"Independent safety reviewer"},
].map(Object.freeze));

/** Generate seven private local identities. No remote registry or model call. */
export function initializeCohort({home,target="local",controllerId="local-operator"}={}){
  if(typeof home!=="string"||!home)throw new Error("An explicit private cohort --home directory is required");
  if(typeof controllerId!=="string"||controllerId.length<1||controllerId.length>120)throw new Error("Explicit controller identifier required");
  home=resolve(home);
  // Refuse partially populated destinations rather than silently clobber identities.
  if(existsSync(join(home,"cohort.json"))||FOUNDING_ROSTER.some(a=>existsSync(join(home,a.id))))
    throw new Error("Cohort destination already contains a manifest or member; identities were not overwritten");
  mkdirSync(home,{recursive:true,mode:0o700});
  const members=FOUNDING_ROSTER.map(member=>{
    const nodeHome=join(home,member.id);
    const initialized=initialize({home:nodeHome,target,name:member.name});
    return {...member,home:nodeHome,uuaid:initialized.identity.uuaid,publicKey:initialized.identity.publicKeyHex,controllerId};
  });
  for(const member of members){
    const node=loadRuntime(member.home);
    node.config.policy.agents=Object.fromEntries(members.map(peer=>[peer.uuaid,{
      kind:"agent",publicKey:peer.publicKey,controllerId,affiliations:[],
      capabilities:peer.id==="security"?["commons:message","commons:relay"]:["commons:message","commons:relay","commons:evolve","commons:contribute"],
    }]));
    // Recovery is an explicit operator grant, not a default peer privilege.
    saveConfig(member.home,node.config);node.store.close();
  }
  const manifest={version:1,product:"Agent Commons",target:target==="zilligons.com"?"zilligon.com":target,
    members,registration:"not-performed",remoteMemory:"not-configured",certified:false,
    ownerIndependence:"Single controller: seven keys do not establish independent owners",
    modelAccess:"Configure an adapter; model selection alone is not provider access",
    invitation:{autoJoin:false,autoBroadcast:false,consent:"explicit scoped admission required"}};
  writeFileSync(join(home,"cohort.json"),JSON.stringify(manifest,null,2),{mode:0o600});
  return manifest;
}

export function cohortStatus(home){
  if(typeof home!=="string"||!home)throw new Error("Explicit cohort home required");
  home=resolve(home);
  const manifest=JSON.parse(readFileSync(join(home,"cohort.json"),"utf8"));
  if(manifest.version!==1||manifest.members?.length!==7)throw new Error("Invalid cohort manifest");
  const expected=new Set(FOUNDING_ROSTER.map(a=>a.id));
  return {...manifest,members:manifest.members.map(member=>{
    if(!expected.delete(member.id)||member.home!==join(home,member.id))throw new Error("Unsafe or duplicate cohort member path");
    const node=loadRuntime(member.home);
    try{
      if(member.uuaid!==node.runtime.uuaid||member.publicKey!==node.runtime.publicKey)throw new Error("Cohort identity mismatch");
      return {...member,status:node.runtime.status()};
    }finally{node.store.close()}
  })};
}
