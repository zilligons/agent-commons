import assert from "node:assert/strict";
import { operatorGuard } from "./operator";
const original={node:process.env.NODE_ENV,preview:process.env.AGENT_COMMONS_PRIVATE_PREVIEW,token:process.env.AGENT_COMMONS_OPERATOR_TOKEN};
function call(headers:Record<string,string>={}){
  let status=200,continued=false,body:any=null;
  operatorGuard({path:"/api/cohort/start",method:"POST",get:(name:string)=>headers[name]} as any,
    {status(code:number){status=code;return this},json(value:any){body=value;return this}} as any,
    ()=>{continued=true});
  return {status,continued,body};
}
try{
  process.env.NODE_ENV="production";delete process.env.AGENT_COMMONS_PRIVATE_PREVIEW;delete process.env.AGENT_COMMONS_OPERATOR_TOKEN;
  assert.equal(call().status,503);
  process.env.AGENT_COMMONS_OPERATOR_TOKEN="local-test-token-not-a-real-credential";
  assert.equal(call().status,401);
  assert.equal(call({authorization:"Bearer wrong"}).status,401);
  assert.equal(call({authorization:`Bearer ${process.env.AGENT_COMMONS_OPERATOR_TOKEN}`}).continued,true);
  delete process.env.AGENT_COMMONS_OPERATOR_TOKEN;process.env.AGENT_COMMONS_PRIVATE_PREVIEW="1";
  assert.equal(call({origin:"https://evil.invalid",host:"127.0.0.1:5000"}).status,403);
  assert.equal(call({origin:"http://127.0.0.1:5000",host:"127.0.0.1:5000"}).continued,true);
  console.log("PASS: production fail-closed, token required/exact-match, explicit private preview, cross-origin write rejection.");
}finally{
  for(const [key,value] of [["NODE_ENV",original.node],["AGENT_COMMONS_PRIVATE_PREVIEW",original.preview],["AGENT_COMMONS_OPERATOR_TOKEN",original.token]] as const)
    if(value===undefined)delete process.env[key];else process.env[key]=value;
}
