import assert from "node:assert/strict";
import { encode, decode, evaluate, corpus, engine } from "./engine";
import { storage } from "./storage";

const snapshot=JSON.parse(JSON.stringify(engine.state));
try {
  const lexicon={"round trip integrity":"~0~","semantic equivalence":"~1~","backward compatible protocol":"~2~","Confirm round trip integrity":"~3~"};
  for(const sample of corpus)assert.equal(decode(encode(sample,lexicon),lexicon),sample);
  for(let i=0;i<500;i++){
    const sample=[corpus[i%corpus.length],"~0~","~1~","~~","தமிழ்",String.fromCodePoint(0x1f600+i%50),"\n",corpus[(i*7)%corpus.length]].join(i%2?" ":"");
    assert.equal(decode(encode(sample,lexicon),lexicon),sample);
  }
  assert.equal(evaluate(lexicon).passed,corpus.length);
  assert.ok(evaluate(lexicon).reduction>evaluate({"round trip integrity":"~0~","semantic equivalence":"~1~"}).reduction);
  assert.ok(evaluate({"round trip integrity":"~99~","semantic equivalence":"~99~"}).passed<corpus.length);
  assert.equal(engine.verifyLedger(),true);
  const first=engine.state.messages[0];
  const text=first.body;first.body="tampered";
  assert.equal(engine.verifyLedger(),false);first.body=text;
  const signature=first.signature;first.signature="bad";
  assert.equal(engine.verifyLedger(),false);first.signature=signature;
  assert.throws(()=>engine.emit("human","hello"),/Unregistered sender/);
  engine.state.mode="simulation";engine.state.running=false;engine.state.busy=null;
  const version=engine.state.version;
  engine.fault("decoder");assert.equal(engine.state.version,version);assert.equal(engine.verifyLedger(),true);
  engine.fault("transport");assert.equal(engine.verifyLedger(),true);
  engine.state.selected=["atlas","lyra","orion","sentinel"];
  const p=engine.proposal("atlas","test phrase without corpus gain");
  assert.equal(p.status,"rejected");
  assert.throws(()=>engine.vote("atlas",p,true),/Vote not eligible/);
  engine.state.mode="live";
  assert.throws(()=>engine.fault("decoder"),/restricted to simulation/);
  assert.throws(()=>engine.start("live",3,["atlas","lyra"]),/at least three/);
  console.log("PASS: 500 codec combinations, 14 fixtures, improved corpus, collision rejection, signature/hash tampering, unknown sender, recovery tests, no-gain rejection, self-vote rejection, live fault boundary, quorum admission.");
} finally {
  engine.state=snapshot;storage.save(snapshot);
}
