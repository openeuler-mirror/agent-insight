import {modelBaseUrl,loadExecutionConfig} from '../shared/config.mjs';
import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
export function createModelRelay({key,token,upstream,localTest=false,modelName,maxRequests,lifetimeMs,requestTimeoutMs}){
 if([upstream,modelName,maxRequests,lifetimeMs,requestTimeoutMs].some(v=>v===undefined)){const c=loadExecutionConfig({profile:process.env.E2E_LANE||'pr'});upstream??=c.model.baseUrl;modelName??=c.model.modelName;maxRequests??=c.model.maxRequests;lifetimeMs??=c.timeouts.runMs;requestTimeoutMs??=c.timeouts.modelRequestMs;}
 if(!key||!token)throw Error('Relay credentials required');
 upstream=modelBaseUrl(upstream);if(!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(modelName))throw Error('Invalid configured model');
 const stats={forwarded:0,completed:0,failed:0};const deadline=Date.now()+lifetimeMs;
 const server=http.createServer(async(req,res)=>{
  const send=(status,error)=>{if(!res.headersSent)res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error}));};
  const provided=Buffer.from(String(req.headers.authorization||'')),expected=Buffer.from('Bearer '+token);
  if(provided.length!==expected.length||!timingSafeEqual(provided,expected))return send(401,'Invalid relay token');
  if(req.method!=='POST'||!['/chat/completions','/v1/chat/completions'].includes(req.url))return send(404,'Route not available');
  if(Date.now()>deadline)return send(410,'Relay lease expired');
  if(stats.forwarded>=maxRequests)return send(429,'Run request budget exceeded');
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),requestTimeoutMs);res.once('close',()=>{if(!res.writableEnded)controller.abort();});
  try{
   let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>1048576)return send(413,'Request too large');chunks.push(chunk);}
   const raw=Buffer.concat(chunks);let body;try{body=JSON.parse(raw);}catch{return send(400,'Invalid JSON');}
   if(body.model!==modelName||!Array.isArray(body.messages))return send(400,'Unsupported model request');
   if(stats.forwarded>=maxRequests)return send(429,'Run request budget exceeded');
   stats.forwarded++;
   const response=await fetch(upstream+'/chat/completions',{method:'POST',redirect:'error',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:raw,signal:controller.signal});
   res.writeHead(response.status,{'content-type':response.headers.get('content-type')||'application/json','cache-control':'no-store'});
   let received=0;for await(const chunk of response.body){received+=chunk.length;if(received>16777216)throw Error('Response too large');if(!res.write(chunk))await new Promise(resolve=>{res.once('drain',resolve);res.once('close',resolve);});}
   res.end();if(response.ok)stats.completed++;else stats.failed++;
  }catch{stats.failed++;if(!res.headersSent)send(502,'Model upstream unavailable');else res.destroy();}
  finally{clearTimeout(timeout);}
 });
 server.requestTimeout=15000;server.headersTimeout=15000;return {server,stats};
}
