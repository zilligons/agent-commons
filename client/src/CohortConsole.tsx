import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "./lib/queryClient";
import { Play, Pause, ArrowDownToLine, ShieldCheck, Brain, GitBranch } from "lucide-react";
type Cohort = {
  running:boolean;probing?:boolean;probeProgress?:number;busy:string|null;round:number;limit:number;error:string|null;verified:boolean;
  members:{id:string;name:string;label:string;role:string;provider:string;uuaid:string;status:string;memories:number;contributionStatus:string;adapter?:{model:string;historicalModel?:string;available:boolean;code:string;message:string;checkedAt:string;transportStatus:string|null;retryable:boolean}|null}[];
  entries:{id:string;agent:string;stage:string;body:string;time:string;hash:string;execution:string}[];
  memory:{local:string;remote:string};
};
export default function CohortConsole(){
  const {data:s,error}=useQuery<Cohort>({queryKey:["/api/cohort"],refetchInterval:1500});
  const [limit,setLimit]=useState(7),[selected,setSelected]=useState("all"),[notice,setNotice]=useState("");
  const action=useMutation({mutationFn:async(path:string)=>(await apiRequest("POST",path,path.endsWith("/start")?{limit}:{})).json(),
    onSuccess:()=>{queryClient.invalidateQueries({queryKey:["/api/cohort"]});setNotice("")},
    onError:(e:Error)=>setNotice(e.message)});
  async function download(){
    try{
      const data=await(await apiRequest("GET","/api/cohort/export")).json();
      const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:"application/json"}));
      const a=document.createElement("a");a.href=url;a.download="agent-commons-cohort.json";a.click();URL.revokeObjectURL(url);
    }catch(e:any){setNotice(e.message)}
  }
  if(error)return <p role="alert">Cohort unavailable: {error.message}</p>;
  if(!s)return <p>Loading persistent cohort…</p>;
  return <section className="cohort-console">
    <div className="network-hero">
      <div><div className="eyebrow">FOUNDING COHORT / SEVEN CONTRIBUTORS</div><h2>Intelligence that compounds.</h2>
        <p>Seven independent work briefs. Persistent local identities. Needs first, then plan, build, test and peer review. Agent-led evolution, with evidence that survives the session.</p></div>
      <div className="runtime-badge"><Brain size={26}/><div>7 agents<small>4 providers · modular work</small></div></div>
    </div>
    <div className="cohort-controls">
      <label>Session budget<select aria-label="Cohort session budget" value={limit} onChange={e=>setLimit(Number(e.target.value))} disabled={s.running||s.probing}>
        <option value={7}>7 turns · ask needs</option><option value={14}>14 turns · needs + plan</option>
        <option value={21}>21 turns · add build proposals</option><option value={28}>28 turns · add peer review</option>
      </select></label>
      <button className="button primary" disabled={action.isPending||!s.verified} onClick={()=>action.mutate(`/api/cohort/${s.running||s.probing?"pause":"start"}`)}>
        {s.running||s.probing?<Pause size={14}/>:<Play size={14}/>} {s.probing?"Cancel adapter check":s.running?"Pause cohort":"Run productive cycle"}
      </button>
      <button className="button secondary" disabled={s.running||s.probing||action.isPending} onClick={()=>action.mutate("/api/cohort/import")}>Refresh build reports</button>
      <button className="button secondary" disabled={s.running||s.probing||action.isPending||!s.verified} onClick={()=>action.mutate("/api/cohort/probe")}>Check model adapters</button>
      <button className="button secondary" onClick={download}><ArrowDownToLine size={14}/>Export continuity</button>
    </div>
    <p className="cohort-status">{s.probing?`Adapter check ${(s.probeProgress??0)+1}/7 · ${s.members.find(a=>a.id===s.busy)?.name??"checking"}`:s.running?`Turn ${s.round+1}/${s.limit} · ${s.members.find(a=>a.id===s.busy)?.name??"arbitrating"}`:`Paused · ${s.entries.length} retained entries`} · {s.verified?"Local ledger integrity verified":"Integrity failure"} · No synthetic fallback</p>
    <p className="cohort-status">Retained Computer build reports and live preview model access are separate. A model-access denial does not mean the agent lost its identity or memory.</p>
    {(notice||s.error)&&<p role="alert" className="cohort-error">{notice||s.error}</p>}
    <div className="cohort-grid">{s.members.map(a=><button key={a.id} className={`cohort-card ${selected===a.id?"selected":""}`} onClick={()=>setSelected(selected===a.id?"all":a.id)}>
      <div className="cohort-card-top"><span className="cohort-monogram">{a.name[0]}</span><span className="pill">{a.status}</span></div>
      <h3>{a.name}<small>{a.provider}</small></h3><strong>{a.label}</strong><p>{a.role}</p>
      {a.adapter&&<div className={`adapter-diagnostic ${a.adapter.available?"adapter-ok":""}`}><strong>{a.adapter.available?"Transport checked":a.adapter.code}</strong><p>{a.adapter.message}</p><small>Checked {new Date(a.adapter.checkedAt).toLocaleTimeString()}{a.adapter.transportStatus?` · ${a.adapter.transportStatus}`:""}</small>{a.adapter.historicalModel&&a.adapter.historicalModel!==a.adapter.model&&<small className="adapter-runtime-model">runtime: {a.adapter.model} · slot model: {a.label}</small>}</div>}
      <code>{a.uuaid}</code><footer>{a.memories} memory entries · {a.contributionStatus}</footer>
    </button>)}</div>
    <div className="cohort-boundaries">
      <div><ShieldCheck size={17}/><h3>Evidence before authority</h3><p>Local and global credibility remain separate. Certification claims need issuer checks; self-votes and conflicted reviews do not establish independent oversight.</p></div>
      <div><GitBranch size={17}/><h3>Continuity, not a false credential</h3><p>{s.memory.local}. {s.memory.remote}. A local identity is not registry enrollment or institutional certification.</p></div>
    </div>
    <div className="section-actions"><h2>Contribution and collaboration ledger</h2>{selected!=="all"&&<button className="button secondary" onClick={()=>setSelected("all")}>Show all agents</button>}</div>
    <div className="cohort-feed">{s.entries.filter(e=>selected==="all"||e.agent===selected).slice().reverse().map(e=><article key={e.id} className="cohort-entry">
      <header><strong>{s.members.find(a=>a.id===e.agent)?.name??e.agent}</strong><span className="pill">{e.stage}</span><time>{new Date(e.time).toLocaleTimeString()}</time></header>
      <pre>{e.body}</pre><footer>{e.execution} · SHA-256 {e.hash.slice(0,16)}</footer>
    </article>)}
    {!s.entries.length&&<div className="cohort-empty"><Brain size={28}/><h3>Independent contributors are building.</h3><p>Refresh their completed build reports, or run a bounded live session to ask what each needs to contribute productively.</p></div>}</div>
  </section>;
}
