import { UuaidClient } from "@uuaid/sdk";
import { Keychain } from "./pillar.mjs";
import { keyIsBlocked, SELF_CERTIFYING_AGENT_UUAID } from "./uuaid-namespace.mjs";
import { isLoopbackUrl, isOffline } from "./offline.mjs";

export const REQUIRED_STANDARDS=["IAASO-1001","IAASO-2001","IAASO-3101","IAASO-3301"];
export class TrustError extends Error { constructor(code,message,{transient=false}={}){super(message);this.code=code;this.transient=transient} }
// Network/5xx/429/timeout failures of the trust backend are transient: callers must retry, never treat them as a verdict on the sender.
export function isTransientTrustFailure(error){if(error?.transient===true)return true;const status=error?.status??error?.statusCode;return error!=null&&!(error instanceof TrustError)&&(!Number.isInteger(status)||status>=500||status===408||status===429)}
async function backend(fn,code){try{return await fn()}catch(error){if(error instanceof TrustError)throw error;if(isTransientTrustFailure(error))throw new TrustError(code,`Trust backend unavailable: ${String(error?.message??error).slice(0,120)}`,{transient:true});throw error}}
export class RegistryTrust {
  #denied=false;
  static isCanonicalTrust(value){
    if(value===null||(typeof value!=="object"&&typeof value!=="function")||!(#denied in value))return false;
    let current=value,found=false;
    while(current!==null){
      if(current!==value&&current!==TRUST_PROTOTYPE&&current!==OBJECT_PROTOTYPE)return false;
      const descriptor=getOwnPropertyDescriptor(current,"authorize");
      if(!found&&descriptor){
        if(!("value" in descriptor)||descriptor.value!==CANONICAL_AUTHORIZE)return false;
        found=true;
      }
      current=getPrototypeOf(current);
    }
    return found;
  }
  denyPermanently(){this.#denied=true}
  constructor({policy={},client,fetchImpl=fetch,env=process.env}={}) {
    if(policy.mode!==undefined&&!["local","global"].includes(policy.mode))throw new TrustError("INVALID_POLICY_MODE","Policy mode must be explicitly local or global");
    this.policy=policy;this.policy.mode??="local";this.env=env;
    // One gate. policy.mode "local" skips only registry verification in authorize() (trust.mjs:44); policy.agents, key binding, and capability checks run in both modes; standards() still fetched (measured 2026-10-04).
    this.fetch=async(url,init)=>{
      if(isOffline(this.env,this.policy)&&!isLoopbackUrl(String(url)))throw new TrustError("OFFLINE","Offline mode refused an outbound fetch; no request was sent");
      return fetchImpl(url,init);
    };
    this.client=client??new UuaidClient({baseUrl:policy.registryUrl??"https://api.uuaid.org",timeoutMs:10000,fetchImpl:this.fetch});
  }
  async standards(){
    const pins=this.policy.standardPins??{};
    if(REQUIRED_STANDARDS.some(code=>!/^[0-9a-f]{64}$/.test(pins[code]??"")))throw new TrustError("STANDARDS_UNPINNED","All required IAASO standard digests must be pinned before global admission");
    const url=this.policy.authorityUrl??"https://authority.iaaso.org";
    if(!url.startsWith("https://"))throw new TrustError("INSECURE_AUTHORITY","Global authority reads require HTTPS");
    const response=await backend(()=>this.fetch(`${url.replace(/\/$/,"")}/v1/standards`,{signal:AbortSignal.timeout(10000)}),"AUTHORITY_UNAVAILABLE");
    if(!response.ok)throw new TrustError("AUTHORITY_UNAVAILABLE","IAASO register could not be read",{transient:response.status>=500||response.status===429||response.status===408});
    const list=(await backend(()=>response.json(),"AUTHORITY_UNAVAILABLE")).standards;
    if(!Array.isArray(list))throw new TrustError("REGISTER_SHAPE","Invalid IAASO register response");
    for(const code of REQUIRED_STANDARDS){
      const record=list.find(r=>r.code===code);
      if(record?.stage!=="published"||record.content_hash!==pins[code])throw new TrustError("STANDARD_PIN_MISMATCH",`${code} is not published at the configured digest`);
    }
    return list;
  }
  // The local half of admission: identity shape, key binding, block list, and the
  // operator's binding and capability. Synchronous, so it reads the policy as it is now.
  #localAdmission(uuaid,publicKey,capability){
    if(!SELF_CERTIFYING_AGENT_UUAID.test(uuaid)||!/^[0-9a-f]{64}$/.test(publicKey))throw new TrustError("AGENT_ONLY","A cryptographically bound agent UUAID in a self-certifying namespace (foundation, pillar, agentnet) is required");
    if(Keychain.localIdFromKey(Buffer.from(publicKey,"hex"))!==uuaid.split(":")[3])throw new TrustError("KEY_BINDING","Agent UUAID is not owned by the presented key");
    if(keyIsBlocked(this.policy.blocked,uuaid))throw new TrustError("SUBJECT_BLOCKED","Subject is blocked (under this or another spelling of its key)");
    const binding=this.policy.agents?.[uuaid];
    // One key must be one voice: reject any policy that admits the same key under several UUAID spellings.
    if(binding&&Object.values(this.policy.agents).filter(a=>a?.publicKey===publicKey).length!==1)throw new TrustError("DUPLICATE_KEY","One public key is admitted under more than one UUAID; Sybil-ambiguous policy is denied");
    if(!binding||binding.publicKey!==publicKey||binding.kind!=="agent"||!binding.capabilities?.includes(capability))throw new TrustError("NOT_ADMITTED","Subject/key/capability has not been admitted by this deployment");
    return binding;
  }
  async authorize(uuaid,publicKey,capability="commons:message"){
    if(this.#denied)throw new TrustError("NOT_ADMITTED","Trust receiver has been permanently denied");
    const binding=this.#localAdmission(uuaid,publicKey,capability);
    if(this.policy.mode!=="global"){
      const result={tier:"local-policy-pinned",uuaid,capability,certified:false};
      if(this.#denied)throw new TrustError("NOT_ADMITTED","Trust receiver has been permanently denied");
      return result;
    }
    if(!(this.policy.registryUrl??"https://api.uuaid.org").startsWith("https://"))throw new TrustError("INSECURE_REGISTRY","Global registry verification requires HTTPS");
    await this.standards();
    const resolution=await backend(()=>this.client.resolve(uuaid),"REGISTRY_UNAVAILABLE");
    const agent=resolution?.agent??resolution?.subject??resolution;
    if(agent?.uuaid!==uuaid||agent.status!=="active")throw new TrustError("SUBJECT_INACTIVE","Registry subject is not explicitly active");
    if(!binding.credentialId)throw new TrustError("CREDENTIAL_REQUIRED","Global agent admission requires a pinned credential");
    const verdict=await backend(()=>this.client.verify(binding.credentialId),"REGISTRY_UNAVAILABLE");
    if(verdict.credential_id!==binding.credentialId||verdict.agent_uuaid!==uuaid||![verdict.valid,verdict.signatureValid,verdict.active,verdict.notExpired].every(v=>v===true))throw new TrustError("CREDENTIAL_INVALID","Credential signature, subject, active status, or expiry failed");
    // The registry calls above await, and the operator's policy may change meanwhile
    // (a block, a removal, a narrowed capability). Decide on the policy as it is now,
    // for the same credential the registry just verified.
    if(this.#localAdmission(uuaid,publicKey,capability).credentialId!==binding.credentialId)throw new TrustError("NOT_ADMITTED","Admission changed while the registry was consulted");
    // Capabilities are operator policy grants. A valid credential alone does not
    // imply an IAASO accreditation role or permission to ratify a standard.
    const result={tier:"registry-credential-and-policy",uuaid,capability,credentialId:binding.credentialId,certified:false};
    if(this.#denied)throw new TrustError("NOT_ADMITTED","Trust receiver has been permanently denied");
    return result;
  }
  async publishedProfilePin(code,profileHash){
    await this.standards();
    const response=await backend(()=>this.fetch(`${(this.policy.authorityUrl??"https://authority.iaaso.org").replace(/\/$/,"")}/v1/standards`,{signal:AbortSignal.timeout(10000)}),"AUTHORITY_UNAVAILABLE");
    if(!response.ok)throw new TrustError("AUTHORITY_UNAVAILABLE","Cannot inspect global profile authority",{transient:response.status>=500||response.status===429||response.status===408});
    const record=(await backend(()=>response.json(),"AUTHORITY_UNAVAILABLE")).standards?.find(s=>s.code===code);
    if(record?.stage!=="published"||record.content_hash!==profileHash)throw new TrustError("GLOBAL_NOT_RATIFIED","The exact global profile document is not published at this IAASO pin");
    return record;
  }
}
const TRUST_PROTOTYPE=RegistryTrust.prototype;
const OBJECT_PROTOTYPE=Object.prototype;
const CANONICAL_AUTHORIZE=RegistryTrust.prototype.authorize;
const getOwnPropertyDescriptor=Object.getOwnPropertyDescriptor;
const getPrototypeOf=Object.getPrototypeOf;
