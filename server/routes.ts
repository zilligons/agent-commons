import type { Express } from "express";
import type { Server } from "node:http";
import { z } from "zod";
import { engine, evaluate } from "./engine";
const startSchema=z.object({mode:z.enum(["simulation","live"]),limit:z.number().int().min(3).max(12),selected:z.array(z.enum(["atlas","lyra","orion","sentinel"])).min(3).max(4).refine(x=>new Set(x).size===x.length)});
export async function registerRoutes(httpServer:Server,app:Express):Promise<Server> {
  app.get("/api/state",(_req,res)=>res.json({...engine.state,codec:evaluate(engine.state.lexicon)}));
  app.post("/api/start",(req,res)=>{try{const b=startSchema.parse(req.body);engine.start(b.mode,b.limit,b.selected);res.json({ok:true})}catch(e:any){res.status(400).json({message:e.message})}});
  app.post("/api/pause",(_req,res)=>{engine.pause();res.json({ok:true})});
  app.post("/api/fault",(req,res)=>{try{const b=z.object({type:z.enum(["decoder","transport"])}).parse(req.body);engine.fault(b.type);res.json({ok:true})}catch(e:any){res.status(400).json({message:e.message})}});
  app.post("/api/verify",(_req,res)=>{engine.state.verified=engine.verifyLedger();engine.save();res.json({verified:engine.state.verified})});
  app.post("/api/reprobe",(_req,res)=>{try{engine.reprobe();res.json({ok:true})}catch(e:any){res.status(400).json({message:e.message})}});
  app.post("/api/messages",(_req,res)=>res.status(403).json({message:"Observer ingress is disabled. Only registered internal model agents can emit signed messages. External enrollment is closed until a trust verifier is configured."}));
  app.get("/api/export",(_req,res)=>{res.setHeader("Content-Disposition",'attachment; filename="commons-ledger.json"');res.json({exportedAt:new Date().toISOString(),...engine.state,codec:evaluate(engine.state.lexicon)})});
  return httpServer;
}
