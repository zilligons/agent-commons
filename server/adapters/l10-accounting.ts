import { createHash, randomUUID } from "node:crypto";
import { AdapterFailure, type AdapterUsage, type AdapterMetrics } from "./types";
import { L10_MAX_RUN_TOKENS, L10_MAX_SESSION_SECONDS, L10_MAX_TURNS, nextPerTurnLimit } from "./l10-limits";
import { issueAccountingPermit, invalidateAccountingPermit, type AccountingPermit } from "./l10-admission";
import { L10AccountingStore, type AccountingRun, type AccountingReservation, type AccountingReceipt } from "./l10-accounting-store";
import type { PlatformSpendingPolicy } from "./platform-spending";

type Observation = { usage: AdapterUsage | null; metrics?: AdapterMetrics; outcomeCode: string; actualModel?: string };
type Settlement = { state:"settled"|"released"|"uncertain"; chargedTokens:number; releasedTokens:number; duplicate:boolean; outcomeCode:string };
const safe = (n: unknown): n is number => typeof n==="number" && Number.isSafeInteger(n) && n>=0;
function refuse(code:string,message:string): never { throw new AdapterFailure(code,message,null,false); }

function safeMetrics(value: unknown): AdapterMetrics | null {
  try {
    if(!value||typeof value!=="object")return null;
    const m=value as AdapterMetrics;
    if(!Number.isSafeInteger(m.exitCode)||!safe(m.stdoutBytes)||!safe(m.stderrBytes)||
      !/^[a-f0-9]{64}$/.test(m.stdoutSha256)||!/^[a-f0-9]{64}$/.test(m.stderrSha256))return null;
    return {exitCode:m.exitCode,stdoutBytes:m.stdoutBytes,stdoutSha256:m.stdoutSha256,
      stderrBytes:m.stderrBytes,stderrSha256:m.stderrSha256};
  } catch { return null; }
}

export function validAccountingUsage(value: unknown): AdapterUsage | null {
  try {
    if (!value || typeof value!=="object") return null;
    const u=value as AdapterUsage;
    if (!safe(u.promptTokens)||!safe(u.completionTokens)||!safe(u.totalTokens)||
      !Number.isSafeInteger(u.promptTokens+u.completionTokens)||u.totalTokens!==u.promptTokens+u.completionTokens||
      u.coversInternalCalls!==true||!["cli-envelope","provider-response"].includes(u.source)||typeof u.fieldPath!=="string"||
      !/^[A-Za-z0-9_.$\[\]-]{1,200}$/.test(u.fieldPath)) return null;
    return {promptTokens:u.promptTokens,completionTokens:u.completionTokens,totalTokens:u.totalTokens,
      coversInternalCalls:true,source:u.source,fieldPath:u.fieldPath};
  } catch { return null; }
}

/** Deterministic available-signal proxy, not semantic task classification. */
function promote(run: AccountingRun, promptUpper=0): void {
  const tier=Math.max(0,...Object.values(run.ladder).map(a=>a.currentLimit));
  const suggested=run.baseTurnLimit>=21||promptUpper>=12000||tier>=12000||run.chargedTokens>=75000 ? 3 :
    run.baseTurnLimit>=14||promptUpper>=6000||tier>=6000||run.chargedTokens>=25000 ? 2 : 1;
  run.multiplier=Math.max(run.multiplier,suggested);
  run.grantedTurnLimit=Math.min(L10_MAX_TURNS,run.baseTurnLimit*run.multiplier);
}

export class L10AccountingService {
  private readonly bindings=new WeakMap<object,string>();
  private readonly now:()=>number;
  private readonly spending: PlatformSpendingPolicy;
  constructor(private readonly store:L10AccountingStore, options:{now?:()=>number;spending?:PlatformSpendingPolicy}={}) {
    this.now=options.now??(()=>Date.now());
    this.spending=options.spending??{
      admitRun(run){if(run.kind!=="probe")refuse("SPEND_POLICY_REQUIRED","Platform spending policy is required");},
      reserve(){refuse("SPEND_POLICY_REQUIRED","Platform spending policy is required");},
      settle(){refuse("SPEND_POLICY_REQUIRED","Platform spending policy is required");},
      usage(){return {status:"blocked",code:"SPEND_POLICY_REQUIRED"};},
    };
  }

  createRun(input:{kind:"cohort"|"probe"|"engine";baseTurnLimit:number;eligibleSlots:string[];nowMs?:number;models?:string[]}):AccountingRun {
    if (!Number.isSafeInteger(input.baseTurnLimit)||input.baseTurnLimit<1||input.baseTurnLimit>28||
      !["cohort","probe","engine"].includes(input.kind)||!Array.isArray(input.eligibleSlots)||
      !input.eligibleSlots.length||input.eligibleSlots.length>7||new Set(input.eligibleSlots).size!==input.eligibleSlots.length||
      input.eligibleSlots.some(s=>typeof s!=="string"||!s)) refuse("INVALID_REQUEST","Invalid accounting run policy");
    const now=input.nowMs??this.now();
    if(!safe(now))refuse("INVALID_REQUEST","Invalid accounting clock");
    const run:AccountingRun={id:randomUUID(),kind:input.kind,state:"active",baseTurnLimit:input.baseTurnLimit,
      grantedTurnLimit:input.baseTurnLimit,multiplier:1,chargedTokens:0,reservedTokens:0,attemptedTurns:0,
      eligibleSlots:[...input.eligibleSlots],excludedSlots:[],ladder:{},startedAtMs:now,
      deadlineAtMs:now+L10_MAX_SESSION_SECONDS*1000};
    for(const slot of run.eligibleSlots)run.ladder[slot]={currentLimit:1800,boostStreak:0,nonBoostStreak:0,hold:false};
    promote(run);this.store.atomic(()=>{this.spending.admitRun(run,input.models??[]);this.store.insertRun(run);});return run;
  }
  platformUsage() { return this.spending.usage(); }
  getRun(id:string):AccountingRun {
    const run=this.store.getRun(id);
    if(!run||!safe(run.chargedTokens)||!safe(run.reservedTokens)||!safe(run.attemptedTurns)||
      !safe(run.deadlineAtMs)||!Array.isArray(run.eligibleSlots)||!Array.isArray(run.excludedSlots))
      refuse("ACCOUNTING_STORAGE_FAILED","Accounting run is missing or invalid");
    const totals=this.store.totals(id);
    if(totals.reserved!==run.reservedTokens||totals.charged!==run.chargedTokens)
      refuse("ACCOUNTING_STORAGE_FAILED","Accounting projections do not match durable receipts");
    return run;
  }
  completionLimit(runId:string,slotId:string):number {
    const ladder=this.getRun(runId).ladder[slotId];
    if(!ladder)refuse("MODEL_UNAVAILABLE","Slot not admitted to this accounting run");
    return ladder.currentLimit;
  }
  callEvidence(callId:string) {
    return this.store.callEvidence(callId);
  }
  slotTotals() {
    return this.store.slotTotals();
  }
  private requireOpen(run:AccountingRun):void {
    if(run.state!=="active"||this.now()>=run.deadlineAtMs||run.chargedTokens+run.reservedTokens>=L10_MAX_RUN_TOKENS)
      refuse("BUDGET_EXHAUSTED","Accounting run budget or deadline exhausted");
  }

  reserveCall(input:{runId:string;callId:string;slotId:string;runtimeModel:string;promptTokensUpper:number;completionLimit:number;totalTokensUpper:number}) {
    if(!input.callId||typeof input.callId!=="string"||input.callId.length>200||typeof input.runtimeModel!=="string"||
      !input.runtimeModel||input.runtimeModel.length>200||!safe(input.promptTokensUpper)||!safe(input.completionLimit)||
      input.completionLimit<1||input.completionLimit>24000||!safe(input.totalTokensUpper)||
      !Number.isSafeInteger(input.promptTokensUpper+input.completionLimit)||
      input.totalTokensUpper<input.promptTokensUpper+input.completionLimit)
      refuse("INVALID_REQUEST","Invalid complete token reservation");
    const reservation=this.store.atomic(()=>{
      const run=this.getRun(input.runId);this.requireOpen(run);
      if(run.kind==="probe")refuse("LIMIT_UNSUPPORTED","Free probes cannot reserve paid generation");
      if(!run.eligibleSlots.includes(input.slotId)||run.excludedSlots.includes(input.slotId))
        refuse("MODEL_UNAVAILABLE","Slot excluded from this accounting run");
      if(this.store.reservationForCall(input.callId))refuse("ACCOUNTING_CONFLICT","Call id already reserved");
      if(input.completionLimit>run.ladder[input.slotId].currentLimit)refuse("INVALID_REQUEST","Completion ceiling exceeds agent ladder");
      promote(run,input.promptTokensUpper);
      if(run.attemptedTurns>=run.grantedTurnLimit||run.chargedTokens+run.reservedTokens+input.totalTokensUpper>=L10_MAX_RUN_TOKENS)
        refuse("BUDGET_EXHAUSTED","Insufficient turn or token capacity");
      try {this.store.consumeAttempt(this.now());} catch {refuse("BUDGET_EXHAUSTED","Persistent hourly attempt budget exhausted");}
      const row:AccountingReservation={...input,id:randomUUID(),state:"reserved",createdAtMs:this.now(),startedAtMs:null,terminalAtMs:null};
      this.store.insertReservation(row);this.spending.reserve(run,row);run.reservedTokens+=row.totalTokensUpper;run.attemptedTurns++;
      this.store.putRun(run);return row;
    });
    let permit:AccountingPermit;
    permit=issueAccountingPermit({
      validate:()=>{
        const r=this.store.getReservation(reservation.id);const run=this.getRun(input.runId);this.requireOpen(run);
        if(!r||r.state!=="reserved"||run.excludedSlots.includes(r.slotId))refuse("LIMIT_UNSUPPORTED","Live reservation is no longer dispatchable");
      },
      start:()=>this.store.atomic(()=>{
        const r=this.store.getReservation(reservation.id);
        if(!r||r.state!=="reserved")refuse("ACCOUNTING_CONFLICT","Reservation already dispatched");
        r.state="started";r.startedAtMs=this.now();this.store.putReservation(r);
      }),
    });
    this.bindings.set(permit,reservation.id);
    return {permit,reservation:{id:reservation.id,promptTokensUpper:reservation.promptTokensUpper,totalTokens:reservation.totalTokensUpper},
      limits:{maxCompletionTokens:reservation.completionLimit,maxTotalTokens:reservation.totalTokensUpper,maxCliModelCalls:1 as const}};
  }

  private reservation(permit:AccountingPermit):AccountingReservation {
    const id=permit&&typeof permit==="object"?this.bindings.get(permit):undefined;
    const row=id?this.store.getReservation(id):null;
    if(!row)refuse("LIMIT_UNSUPPORTED","Unknown accounting permit");return row;
  }
  settleCall(permit:AccountingPermit,observed:Observation):Settlement {
    const row=this.reservation(permit);const usage=validAccountingUsage(observed.usage);
    const code=typeof observed.outcomeCode==="string"&&/^[A-Z0-9_]{1,80}$/.test(observed.outcomeCode)?observed.outcomeCode:"TRANSPORT_ERROR";
    const metrics=safeMetrics(observed.metrics);
    const actualModel=typeof observed.actualModel==="string"&&/^[A-Za-z0-9_./:-]{1,200}$/.test(observed.actualModel)?observed.actualModel:null;
    const signature=createHash("sha256").update(JSON.stringify({usage,code,actualModel,metrics,invalid:observed.usage!=null&&!usage})).digest("hex");
    return this.finish(row,signature,usage,code,observed.usage!=null&&!usage,permit,false,metrics?JSON.stringify(metrics):null,actualModel);
  }
  releaseUnstarted(permit:AccountingPermit,reason:string):Settlement {
    const row=this.reservation(permit);
    if(row.state!=="reserved"&&row.state!=="released")refuse("ACCOUNTING_CONFLICT","A possibly started call cannot be refunded");
    const code=/^[A-Z0-9_]{1,80}$/.test(reason)?reason:"PRE_DISPATCH_REFUSAL";
    return this.finish(row,"release:"+code,null,code,false,permit,true);
  }
  private finish(row:AccountingReservation,signature:string,usage:AdapterUsage|null,code:string,invalid:boolean,
    permit?:AccountingPermit,release=false,metricsJson:string|null=null,actualModel:string|null=null):Settlement {
    return this.store.atomic(()=>{
      const prior=this.store.getReceipt(row.id);
      if(prior){
        if(prior.signature!==signature)refuse("ACCOUNTING_CONFLICT","Conflicting settlement receipt");
        return {state:prior.state,chargedTokens:prior.chargedTokens,releasedTokens:prior.releasedTokens,duplicate:true,outcomeCode:prior.outcomeCode};
      }
      const current=this.store.getReservation(row.id)!;const run=this.getRun(row.runId);
      if(!["reserved","started"].includes(current.state))refuse("ACCOUNTING_CONFLICT","Reservation already terminal without receipt");
      const measured=!!usage&&current.state==="started";
      const state=release?"released":measured?"settled":"uncertain";
      const charge=release?0:measured?usage!.totalTokens!:row.totalTokensUpper;
      if(!safe(charge)||!Number.isSafeInteger(run.chargedTokens+charge))refuse("ACCOUNTING_STORAGE_FAILED","Unsafe accounting aggregate");
      const overrun=measured&&(usage!.totalTokens!>row.totalTokensUpper||usage!.promptTokens!>row.promptTokensUpper||usage!.completionTokens!>row.completionLimit);
      const outcome=overrun?"ACCOUNTING_OVERRUN":invalid?"USAGE_INVALID":!release&&!measured&&code==="OK"?"USAGE_MISSING":code;
      const receipt:AccountingReceipt={reservationId:row.id,signature,state,chargedTokens:charge,
        releasedTokens:Math.max(0,row.totalTokensUpper-charge),outcomeCode:outcome,
        usageJson:usage?JSON.stringify(usage):null,metricsJson,actualModel,recordedAtMs:this.now()};
      run.reservedTokens-=row.totalTokensUpper;run.chargedTokens+=charge;
      if(state==="uncertain"&&!run.excludedSlots.includes(row.slotId))run.excludedSlots.push(row.slotId);
      if(measured&&!overrun){
        const next=nextPerTurnLimit(run.ladder[row.slotId],{completionTokens:usage!.completionTokens!});
        run.ladder[row.slotId]={currentLimit:next.nextLimit,boostStreak:next.nextBoostStreak,nonBoostStreak:next.nextNonBoostStreak,hold:next.nextHold};
      }
      promote(run);
      if(overrun)run.state="exhausted";
      current.state=state;current.terminalAtMs=this.now();
      this.store.insertReceipt(receipt);this.store.putReservation(current);this.store.putRun(run);
      // Settlement records actual liability even when it exceeds a platform cap.
      this.spending.settle(current,receipt);
      if(permit)invalidateAccountingPermit(permit);
      return {state,chargedTokens:charge,releasedTokens:receipt.releasedTokens,duplicate:false,outcomeCode:outcome};
    });
  }

  nextEligibleAgent(runId:string,afterSlot:string):string|null {
    return this.store.atomic(()=>{
      const run=this.getRun(runId);
      if(run.state!=="active"||this.now()>=run.deadlineAtMs||run.attemptedTurns>=run.grantedTurnLimit||
        run.chargedTokens+run.reservedTokens>=L10_MAX_RUN_TOKENS){run.state="exhausted";this.store.putRun(run);return null;}
      const start=run.eligibleSlots.indexOf(afterSlot);
      for(let step=1;step<=run.eligibleSlots.length;step++){
        const slot=run.eligibleSlots[(start+step+run.eligibleSlots.length)%run.eligibleSlots.length];
        if(!run.excludedSlots.includes(slot))return slot;
      }
      run.state="exhausted";this.store.putRun(run);return null;
    });
  }
  recoverInterruptedRun(runId:string):AccountingRun {
    // After a crash even a reservation without a recorded spawn acknowledgement
    // may have reached an external process. Never refund or replay it automatically.
    for(const row of this.store.outstanding(runId))this.finish(row,"recovery",null,"INTERRUPTED_OUTCOME",false);
    return this.getRun(runId);
  }
}
