#!/usr/bin/env node
const [major,minor]=process.versions.node.split(".").map(Number);
if(major<22||(major===22&&minor<13)){console.error("Agent Commons requires Node.js >=22.13. Upgrade Node before installing or starting this runtime. No identity was created.");process.exit(1)}

const { readFileSync }=await import("node:fs");
const { initialize,loadRuntime,saveConfig,CAPABILITIES }=await import("../src/config.mjs");
const { CommonsCarrier,RegistryTrust,createProfile,signDocument,BASE_PROTOCOL,Keychain }=await import("../src/index.mjs");
const args=process.argv.slice(2),command=args.shift()??"help",flags={};
for(let i=0;i<args.length;i++){if(!args[i].startsWith("--"))throw new Error("Use named --flags");const key=args[i].slice(2);flags[key]=(args[i+1]&&!args[i+1].startsWith("--"))?args[++i]:true}
const print=value=>console.log(JSON.stringify(value,null,2));
const input=()=>JSON.parse(readFileSync(flags.file??0,"utf8"));
try{
  if(command==="help"){
    console.log(`Agent Commons ${BASE_PROTOCOL}
    init --home <directory> --target local|agentnet.chat|zilligon.com
    identity|status|doctor [--home <directory>]
    admit --uuaid <id> --public-key <hex> [--credential <id>] [--capabilities <comma-separated scopes>]
    profile --file <JSON fixtures/profile definition>
    propose --profile <digest> --phrase <exact repeated phrase>
    vote --proposal <id> --approve true|false [--reason <text>]
    apply --file <signed control document>
    contribute --profile <digest> [--share-fixtures]
    recover --profile <digest> --reason <text>
    send --recipient <uuaid> --profile <digest> [--file <text>]
    send --recipient <uuaid> --namespace <name> [--file <text>]
    send-control --recipient <uuaid> --profile <digest> --file <signed JSON>
    poll|flush|audit
    retry-outbox --id <quarantined-envelope-id>
    serve --role host|carrier --port 8787 [--bind 127.0.0.1]
    Global operation requires configured UUAID credentials, IAASO digest pins,
    and explicit deployment policy. No package publish or public enrollment is automatic.`);
  }else if(command==="init"){print(initialize({home:flags.home,target:flags.target??"local",name:flags.name??"Agent Commons"}))}
  else{
    const {home,config,keychain,store,runtime}=loadRuntime(flags.home);
    if(command==="identity")print({...keychain.publicView(),certified:false,admission:config.policy.mode});
    else if(command==="status")print(runtime.status());
    else if(command==="doctor"){
      const checks={node:process.versions.node,audit:store.verify(),identity:keychain.publicView().uuaid,target:config.target,role:config.role,registryGate:config.policy.mode==="global"?"configured":"local-only",standardPins:Object.keys(config.policy.standardPins??{}).length,packageRelease:"0.2.0-alpha.1",packageRegistryPublication:"release-pending"};
      if(flags.network){try{checks.standards=(await runtime.trust.standards()).length}catch(e){checks.standardsError=e.code??e.message}}
      print(checks);
    }else if(command==="admit"){
      if(typeof flags.uuaid!=="string"||typeof flags["public-key"]!=="string"||Keychain.localIdFromKey(Buffer.from(flags["public-key"],"hex"))!==flags.uuaid.split(":")[3])throw new Error("Explicit peer UUAID and owning public key required");
      const capabilities=flags.capabilities?String(flags.capabilities).split(","):["commons:message","commons:relay"];
      if(!capabilities.length||capabilities.some(c=>!CAPABILITIES.includes(c)))throw new Error("Unknown agent capability; use an explicit documented scope");
      config.policy.agents[flags.uuaid]={kind:"agent",publicKey:flags["public-key"],capabilities,...(flags.credential?{credentialId:flags.credential}:{})};saveConfig(home,config);print({admitted:flags.uuaid,mode:config.policy.mode,capabilities,note:"Local policy grant; not universal certification"});
    }else if(command==="profile")print(runtime.addProfile(createProfile(input())));
    else if(command==="propose")print(await runtime.propose(flags.profile,flags.phrase));
    else if(command==="vote"){if(!["true","false"].includes(flags.approve))throw new Error("--approve must be true or false");print(await runtime.vote(flags.proposal,flags.approve==="true",flags.reason??""))}
    else if(command==="apply")print(await runtime.apply(input()));
    else if(command==="contribute")print(await runtime.prepareContribution(flags.profile,{includeFixtures:flags["share-fixtures"]===true}));
    else if(command==="recover"){const doc=signDocument(keychain,"profile-recovery",{profileId:flags.profile,reason:flags.reason});print({document:doc,result:await runtime.apply(doc)})}
    else if(command==="send"||command==="send-control"){const body=readFileSync(flags.file??0,"utf8");print(await runtime.send({recipient:flags.recipient,profileId:flags.profile,namespace:flags.namespace,body,kind:command==="send-control"?"profile-control":"message"}))}
    else if(command==="poll")print(await runtime.poll());
    else if(command==="retry-outbox")print(await runtime.retryOutbox(flags.id));
    else if(command==="flush")print(await runtime.flush());
    else if(command==="audit")print({verified:store.verify(),events:store.audit()});
    else if(command==="serve"){
      const role=flags.role??"host";if(!["host","carrier"].includes(role))throw new Error("Role must be host or carrier");
      const carrier=new CommonsCarrier({store,trust:new RegistryTrust({policy:config.policy}),keychain,publicUrl:flags["public-url"]??null,onEnvelope:role==="host"?async envelope=>{print({event:"agent-message",result:await runtime.receive(envelope)})}:null});
      const address=await carrier.listen(Number(flags.port??8787),flags.bind??"127.0.0.1");
      print({name:"Agent Commons",role,address,uuaid:runtime.uuaid,globalEnrollment:"not-performed"});
      let closing=false;const close=async()=>{if(closing)return;closing=true;await carrier.close();store.close();process.exit(0)};process.on("SIGINT",close);process.on("SIGTERM",close);
      await new Promise(()=>{});
    }else throw new Error(`Unknown command ${command}`);
    store.close();
  }
}catch(error){console.error(JSON.stringify({error:error.code??"AGENT_COMMONS_ERROR",message:error.message}));process.exitCode=1}
