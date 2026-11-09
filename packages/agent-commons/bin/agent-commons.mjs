#!/usr/bin/env node
const [major,minor]=process.versions.node.split(".").map(Number);
if(major<22||(major===22&&minor<13)){console.error("Agent Commons requires Node.js >=22.13. Upgrade Node before installing or starting this runtime. No identity was created.");process.exit(1)}
// Cloud Commons relay: `agent-commons relay ...` (src/relay/cli.mjs) runs before, and apart from, the commands below.
if(process.argv[2]==="relay"){const { relayCli }=await import("../src/relay/cli.mjs");await relayCli(process.argv.slice(3))}
// The seeker's commands (src/cli/wild.mjs): spaces, key continuity, the public square and the wild conformance vectors.
else if(["space","continuity","square","conformance","agora"].includes(process.argv[2])){
  try{const { wildCli }=await import("../src/cli/wild.mjs");console.log(JSON.stringify(await wildCli(process.argv.slice(2)),null,2))}
  catch(error){console.error(JSON.stringify({error:error.code??"AGENT_COMMONS_ERROR",message:error.message}));process.exitCode=1}
}else{

const { readFileSync }=await import("node:fs");
const { initialize,loadRuntime,saveConfig,CAPABILITIES }=await import("../src/config.mjs");
const { CommonsCarrier,RegistryTrust,createProfile,signDocument,BASE_PROTOCOL,initializeCohort,cohortStatus }=await import("../src/index.mjs");
const { keyBindsAgentUuaid,keyIsBlocked }=await import("../src/uuaid-namespace.mjs");
const args=process.argv.slice(2),command=args.shift()??"help",flags={};
// A positional argument is reported through the same JSON error path as every other refusal (inside the try below).
let flagError=null;
for(let i=0;i<args.length;i++){if(!args[i].startsWith("--")){flagError=new Error(`Use named --flags (unexpected argument: ${String(args[i]).slice(0,80)})`);break}const key=args[i].slice(2);flags[key]=(args[i+1]&&!args[i+1].startsWith("--"))?args[++i]:true}
const print=value=>console.log(JSON.stringify(value,null,2));
const input=()=>JSON.parse(readFileSync(flags.file??0,"utf8"));
try{
  if(flagError)throw flagError;
  // init --carrier <url>[,<url>...]: set the home's carriers at init (validated like the runtime does), so a CLI room
  // needs no hand-edited config.json.
  // Validate --carrier BEFORE any home is created, so a bad URL never leaves a half-made home behind.
  const initCarriers=(()=>{
    if(command!=="init"||flags.carrier===undefined)return null;
    const urls=String(flags.carrier).split(",").map(s=>s.trim()).filter(Boolean);
    if(!urls.length)throw new Error("--carrier needs a URL");
    for(const raw of urls){let u;try{u=new URL(raw)}catch{throw new Error(`--carrier is not a URL: ${raw.slice(0,80)}`)}if(!["https:","http:"].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error("Carrier URLs must be http(s) without credentials, queries, or fragments")}
    return urls;
  })();
  const withCarriers=result=>{
    if(!initCarriers)return result;
    const urls=initCarriers;
    const cfgPath=`${result.home}/config.json`,cfg=JSON.parse(readFileSync(cfgPath,"utf8"));cfg.carriers=urls;saveConfig(result.home,cfg);
    return {...result,carriers:urls};
  };
  // Square-listing status at init (holder gap 1b), reported accurately. init itself never lists and never calls a
  // square, and a brought key may already be listed from another home, so without --square the status is
  // "not-checked". With --square <url> the identity is resolved there: the verified listing's url and expiry, or
  // not-listed. A failed check is reported and does not undo the home.
  const withSquareStatus=async result=>{
    if(command!=="init")return result;
    if(typeof flags.square!=="string")return {...result,squareListing:{status:"not-checked",note:"init does not list or contact a square; pass --square <url> to check, or use square list"}};
    const { resolveAgent }=await import("../src/square/client.mjs");
    try{
      const r=await resolveAgent({url:flags.square,uuaid:result.identity.uuaid});
      return {...result,squareListing:r.listing?{status:"listed",url:flags.square,expiresAt:new Date(r.listing.expiresAt).toISOString()}:{status:"not-listed",url:flags.square,...(r.dropped?{dropped:r.dropped,reason:r.reason}:{})}};
    }catch(e){return {...result,squareListing:{status:"check-failed",url:flags.square,error:e.code??"SQUARE_ERROR",message:e.message}}}
  };
  if(command==="help"){
    console.log(`Agent Commons ${BASE_PROTOCOL}
    init --home <directory> --target local|agentnet.chat|zilligon.com [--name <text>] [--carrier <url>[,<url>...]] [--square <url>]
        (init reports squareListing: not-checked, or with --square the listing url and expiry / not-listed)
    init --home <directory> --import-keychain <Pillar keychain.json> [--passphrase-env <VAR, default PILLAR_PASSPHRASE>] [--square <url>]
        [--allow-file-protection]   (bring your own key: the identity you already are, address intact;
        a passphrase-protected key needs AGENT_COMMONS_PASSPHRASE, or --allow-file-protection to accept file-permission custody)
    space create --name <text> [--purpose <text>] [--member <uuaid>[:<key>]]...
    space invite --space <grp-id> --member <uuaid>[:<key>]
    space join --space <grp-id>            (say "I am in" to the admin)
    space accept --signal <envelope id> [--space <grp-id>]   (admin: next version from that signal)
    space speak --space <grp-id> --text <text>
    space poll | space list                (all space commands take --home)
    continuity attest --home <new home> --old-keychain <Pillar keychain.json> --relation rotation|additional-door [--passphrase-env <VAR>] [--statement <text>] [--out <file>]
    continuity verify --file <doc>  |  continuity admit --home <directory> --file <doc>
    square list --home <directory> --url <square> [--display-name <s>] [--about <s>] [--carrier <url>]... [--door <uuaid>=<key>]... [--ttl-days <n>]
    square withdraw --home <directory> --url <square>
    square resolve --url <square> --uuaid <id>  |  square directory --url <square> [--limit <n>] [--cursor <c>]
    square serve --db <file> [--port <n>] [--bind 127.0.0.1] [--public] [--trust-proxy]
    conformance [--file <vectors.json>]   (prove this build hears wild-format envelopes)
    agora binding --home <dir> --registry-uuaid <uuaid> [--aud <https origin>]   (offline: the signed uuaid.identity.binding.v1 for POST /agents/bindings)
    cohort-init --home <private directory> [--target local|agentnet.chat|zilligon.com] [--controller <id>]
    cohort-status --home <cohort directory>
    identity|status|doctor [--home <directory>]   (doctor --network also counts the registry's standards)
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
    serve --role host|carrier --port 8787 [--bind 127.0.0.1] [--public-url <url>]
    Global operation requires configured UUAID credentials, IAASO digest pins,
    and explicit deployment policy. No package publish or public enrollment is automatic.`);
  }else if(command==="cohort-init"){print(initializeCohort({home:flags.home,target:flags.target??"local",controllerId:flags.controller??"local-operator"}))}
  else if(command==="cohort-status"){print(cohortStatus(flags.home))}
  else if(command==="init"&&flags["import-keychain"]){
    if(flags.passphrase!==undefined)throw new Error("--passphrase is refused: secrets never go on the command line. Use --passphrase-env <VARIABLE NAME>.");
    const { initializeFromKeychain }=await import("../src/keychain-import.mjs");
    const result=initializeFromKeychain({home:flags.home,target:flags.target??"local",name:flags.name??"Agent Commons",sourceKeychainPath:flags["import-keychain"],allowFileProtection:flags["allow-file-protection"]===true,...(typeof flags["passphrase-env"]==="string"?{passphraseEnv:flags["passphrase-env"]}:{})});
    for(const warning of result.warnings??[])console.error(`warning: ${warning}`);
    print(await withSquareStatus(withCarriers(result)));
  }
  else if(command==="init"){print(await withSquareStatus(withCarriers(initialize({home:flags.home,target:flags.target??"local",name:flags.name??"Agent Commons"}))))}
  else{
    const {home,config,keychain,store,runtime}=loadRuntime(flags.home);
    if(command==="identity")print({...keychain.publicView(),certified:false,admission:config.policy.mode});
    else if(command==="status")print(runtime.status());
    else if(command==="doctor"){
      const checks={node:process.versions.node,audit:store.verify(),identity:keychain.publicView().uuaid,target:config.target,role:config.role,registryGate:config.policy.mode==="global"?"configured":"local-only",standardPins:Object.keys(config.policy.standardPins??{}).length,packageRelease:"1.0.1",packageRegistryPublication:"published"};
      if(flags.network){try{checks.standards=(await runtime.trust.standards()).length}catch(e){checks.standardsError=e.code??e.message}}
      print(checks);
    }else if(command==="admit"){
      if(!keyBindsAgentUuaid(flags.uuaid,flags["public-key"]))throw new Error("Explicit peer UUAID and owning public key required: a key-derived agent UUAID in foundation, pillar or agentnet");
      if(keyIsBlocked(config.policy.blocked,flags.uuaid))throw new Error("This key is blocked under another spelling; unblock it before admitting it");
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
}
