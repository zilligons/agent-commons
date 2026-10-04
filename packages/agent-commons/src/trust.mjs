import { UuaidClient } from "@uuaid/sdk";
import { Keychain } from "./pillar.mjs";

export const REQUIRED_STANDARDS=["IAASO-1001","IAASO-2001","IAASO-3101","IAASO-3301"];
export class TrustError extends Error { constructor(code,message){super(message);this.code=code} }
export class RegistryTrust {
  constructor({policy={},client,fetchImpl=fetch}={}) {
    if(policy.mode!==undefined&&!["local","global"].includes(policy.mode))throw new TrustError("INVALID_POLICY_MODE","Policy mode must be explicitly local or global");
    this.policy=policy;this.policy.mode??="local";this.fetch=fetchImpl;this.client=client??new UuaidClient({baseUrl:policy.registryUrl??"https://api.uuaid.org",timeoutMs:10000,fetchImpl});
  }
  async standards(){
    const pins=this.policy.standardPins??{};
    if(REQUIRED_STANDARDS.some(code=>!/^[0-9a-f]{64}$/.test(pins[code]??"")))throw new TrustError("STANDARDS_UNPINNED","All required IAASO standard digests must be pinned before global admission");
    const url=this.policy.authorityUrl??"https://authority.iaaso.org";
    if(!url.startsWith("https://"))throw new TrustError("INSECURE_AUTHORITY","Global authority reads require HTTPS");
    const response=await this.fetch(`${url.replace(/\/$/,"")}/v1/standards`,{signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new TrustError("AUTHORITY_UNAVAILABLE","IAASO register could not be read");
    const list=(await response.json()).standards;
    if(!Array.isArray(list))throw new TrustError("REGISTER_SHAPE","Invalid IAASO register response");
    for(const code of REQUIRED_STANDARDS){
      const record=list.find(r=>r.code===code);
      if(record?.stage!=="published"||record.content_hash!==pins[code])throw new TrustError("STANDARD_PIN_MISMATCH",`${code} is not published at the configured digest`);
    }
    return list;
  }
  async authorize(uuaid,publicKey,capability="commons:message"){
    if(!/^uuaid:[a-z0-9-]+:agent:[0-9a-f-]{36}$/.test(uuaid)||!/^[0-9a-f]{64}$/.test(publicKey))throw new TrustError("AGENT_ONLY","A cryptographically bound agent UUAID is required");
    if(Keychain.localIdFromKey(Buffer.from(publicKey,"hex"))!==uuaid.split(":")[3])throw new TrustError("KEY_BINDING","Agent UUAID is not owned by the presented key");
    if(this.policy.blocked?.includes(uuaid))throw new TrustError("SUBJECT_BLOCKED","Subject is blocked");
    const binding=this.policy.agents?.[uuaid];
    if(!binding||binding.publicKey!==publicKey||binding.kind!=="agent"||!binding.capabilities?.includes(capability))throw new TrustError("NOT_ADMITTED","Subject/key/capability has not been admitted by this deployment");
    if(this.policy.mode!=="global")return {tier:"local-policy-pinned",uuaid,capability,certified:false};
    if(!(this.policy.registryUrl??"https://api.uuaid.org").startsWith("https://"))throw new TrustError("INSECURE_REGISTRY","Global registry verification requires HTTPS");
    await this.standards();
    const resolution=await this.client.resolve(uuaid);
    const agent=resolution?.agent??resolution?.subject??resolution;
    if(agent?.uuaid!==uuaid||agent.status!=="active")throw new TrustError("SUBJECT_INACTIVE","Registry subject is not explicitly active");
    if(!binding.credentialId)throw new TrustError("CREDENTIAL_REQUIRED","Global agent admission requires a pinned credential");
    const verdict=await this.client.verify(binding.credentialId);
    if(verdict.credential_id!==binding.credentialId||verdict.agent_uuaid!==uuaid||![verdict.valid,verdict.signatureValid,verdict.active,verdict.notExpired].every(v=>v===true))throw new TrustError("CREDENTIAL_INVALID","Credential signature, subject, active status, or expiry failed");
    // Capabilities are operator policy grants. A valid credential alone does not
    // imply an IAASO accreditation role or permission to ratify a standard.
    return {tier:"registry-credential-and-policy",uuaid,capability,credentialId:binding.credentialId,certified:false};
  }
  async publishedProfilePin(code,profileHash){
    await this.standards();
    const response=await this.fetch(`${(this.policy.authorityUrl??"https://authority.iaaso.org").replace(/\/$/,"")}/v1/standards`,{signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new TrustError("AUTHORITY_UNAVAILABLE","Cannot inspect global profile authority");
    const record=(await response.json()).standards?.find(s=>s.code===code);
    if(record?.stage!=="published"||record.content_hash!==profileHash)throw new TrustError("GLOBAL_NOT_RATIFIED","The exact global profile document is not published at this IAASO pin");
    return record;
  }
}
