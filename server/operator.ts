import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";

export function operatorGuard(req:Request,res:Response,next:NextFunction){
  if(!req.path.startsWith("/api"))return next();
  const token=process.env.AGENT_COMMONS_OPERATOR_TOKEN;
  const privatePreview=process.env.AGENT_COMMONS_PRIVATE_PREVIEW==="1";
  if(token){
    const presented=req.get("authorization")??"";
    const expected=`Bearer ${token}`;
    if(Buffer.byteLength(presented)!==Buffer.byteLength(expected)||
      !timingSafeEqual(Buffer.from(presented),Buffer.from(expected)))
      return res.status(401).json({message:"Operator authentication required"});
    return next();
  }
  if(process.env.NODE_ENV==="production"&&!privatePreview)
    return res.status(503).json({message:"Public console API disabled. Configure an operator authentication gateway/token. Private-preview bypass is not a production deployment policy."});
  // CSRF protection for the explicitly private sandbox and loopback development.
  // Hostile browser origins cannot drive state-changing operations.
  const origin=req.get("origin");
  if(!["GET","HEAD","OPTIONS"].includes(req.method)&&origin){
    const previewOrigins=(process.env.AGENT_COMMONS_PREVIEW_ORIGINS??"").split(",").filter(Boolean);
    if(privatePreview&&previewOrigins.includes(origin))return next();
    try{
      const from=new URL(origin);
      const forwardedHost=req.get("x-forwarded-host");
      const hosts=[req.get("host"),...(privatePreview&&forwardedHost?[forwardedHost]:[])];
      if(!hosts.includes(from.host))return res.status(403).json({message:"Cross-origin operator action denied"});
    }catch{return res.status(403).json({message:"Invalid operator origin"})}
  }
  next();
}
