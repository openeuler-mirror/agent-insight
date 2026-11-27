import {configSnapshot,suiteMode} from '../shared/config.mjs';
import {selectedCases} from '../shared/selection.mjs';
import http from 'node:http';
import { createHmac, timingSafeEqual, createHash } from 'node:crypto';

export function verifySignature(body,signature,secret){
  if(!secret||typeof signature!=='string'||!/^sha256=[0-9a-f]{64}$/.test(signature))return false;
  return timingSafeEqual(Buffer.from(signature.slice(7),'hex'),createHmac('sha256',secret).update(body).digest());
}
export function normalizeEvent(body,repository){
  const a=body?.object_attributes;
  if(body?.object_kind!=='merge_request'||!a||!['open','update','reopen'].includes(a.action)||!['open','opened'].includes(a.state))return null;
  if(a.target?.path_with_namespace!==repository||!Number.isSafeInteger(a.iid)||a.iid<1)return null;
  const headSha=a.last_commit?.id;
  if(!/^[a-f0-9]{40}$/.test(headSha||''))return null;
  return {repository,pr:a.iid,headSha};
}
export function makeJob(event,pr,{mode,profile,executionConfig}={}){
  mode??=executionConfig?suiteMode(executionConfig):'real';
  if(!['real','mock','mixed','probe'].includes(mode))throw Error('Invalid mode');
  if(!event||!['open','opened'].includes(pr.state)||pr.head?.sha!==event.headSha||pr.base?.repo?.full_name!==event.repository||Number(pr.number)!==event.pr)return null;
  if(!/^[a-f0-9]{40}$/.test(pr.base.sha||''))throw Error('Invalid base SHA');
  if(!/^[\w.-]+\/[\w.-]+$/.test(pr.head.repo?.full_name||''))throw Error('Invalid source repository');
  if(profile)selectedCases(profile);
  const configuration=executionConfig?configSnapshot(executionConfig):null;
  if(configuration&&suiteMode(executionConfig)!==mode)throw Error('Configured mode mismatch');
  const job={...(configuration?{configHash:configuration.hash,caseIds:executionConfig.cases,runUt:executionConfig.runUt}:{}),...(profile?{profile}:{}),repository:event.repository,pr:event.pr,headSha:event.headSha,baseSha:pr.base.sha,sourceRepository:pr.head.repo.full_name,mode};
  job.id=createHash('sha256').update(JSON.stringify(job)).digest('hex').slice(0,32);return job;
}
export function createReceiver({secret,repository,queue,readPull,mode,profile,executionConfig}){
  mode??=executionConfig?suiteMode(executionConfig):'real';
  if(!secret||!repository)throw Error('Webhook secret and repository are required');
  const server=http.createServer(async(req,res)=>{
    const send=(status,data)=>{if(!res.headersSent)res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
    if(req.method==='GET'&&req.url==='/healthz')return send(200,{ok:true});
    if(req.method!=='POST'||req.url!=='/webhook')return send(404,{error:'not found'});
    if(!String(req.headers['content-type']).startsWith('application/json'))return send(415,{error:'JSON required'});
    try{
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>1048576){send(413,{error:'payload too large'});return;}chunks.push(chunk);}
      const raw=Buffer.concat(chunks);
      if(!verifySignature(raw,req.headers['x-gitcode-signature-256'],secret))return send(401,{error:'invalid signature'});
      let data;try{data=JSON.parse(raw);}catch{return send(400,{error:'invalid JSON'});}
      const event=normalizeEvent(data,repository);if(!event)return send(200,{ignored:true});
      const current=await readPull(event.repository,event.pr);
      const job=makeJob(event,current,{mode,profile,executionConfig});if(!job)return send(200,{ignored:true,reason:'stale or closed PR'});
      const result=queue.enqueue(job);send(result.created?202:200,{id:job.id,created:result.created,state:result.job.state});
    }catch{send(503,{error:'verification or queue unavailable; retry delivery'});}
  });
  server.requestTimeout=10000;server.headersTimeout=10000;return server;
}
