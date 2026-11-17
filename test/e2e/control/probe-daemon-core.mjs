import fs from 'node:fs';import path from 'node:path';
import {writePrivate} from '../shared/runtime.mjs';
const readJson=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return;throw error;}};
const persist=(file,data)=>{const temporary=file+'.tmp';writePrivate(temporary,data);fs.renameSync(temporary,file);};
export function recoverStaleLock(state,name,isAlive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}}){
 if(!['worker.lock','supervisor.lock'].includes(name))throw Error('Invalid lock name');
 const file=path.join(state,name);if(!fs.existsSync(file))return false;
 if(fs.lstatSync(file).isSymbolicLink())throw Error('Invalid lock file');
 const raw=fs.readFileSync(file,'utf8').trim();if(!/^[1-9]\d*$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw Error('Invalid lock owner');
 if(isAlive(Number(raw)))throw Error('Task owner is still running');
 fs.unlinkSync(file);return true;
}
export async function probeCycle({queue,state,runWorker,publish,now=Date.now,allowedModes=['probe']}){
 const jobs=queue.list();if(jobs.some(j=>j.state==='QUEUED'&&!allowedModes.includes(j.mode)))throw Error('probe daemon refuses business jobs');
 let executed=false,delivered=0,failed=0;
 if(jobs.some(j=>j.state==='QUEUED')){await runWorker();executed=true;recoverStaleLock(state,'worker.lock');queue.recover();}
 for(const job of queue.list()){
  if(!allowedModes.includes(job.mode)||!['COMPLETED','ERROR','BLOCKED'].includes(job.state))continue;
  if(!/^[a-f0-9]{32}$/.test(job.id))throw Error('Invalid job identity');
  const work=path.join(state,'jobs',job.id),destination=path.join(work,'delivery.json'),report=path.join(work,'report.json'),attemptFile=path.join(work,'delivery-attempt.json');
  const delivery=readJson(destination);if(['PUBLISHED','ALREADY_PUBLISHED','STALE'].includes(delivery?.status)&&(delivery.status==='STALE'||delivery.commentId))continue;
  let data=readJson(report);if(!data&&job.result){data=job.result;persist(report,data);}if(!data)continue;
  const previous=readJson(attemptFile);const attempt=Number.isSafeInteger(previous?.attempts)&&Number.isFinite(previous.nextAttemptAt)?previous:{attempts:0,nextAttemptAt:0};if(attempt.nextAttemptAt>now())continue;
  try{
   const result=await publish(job,data);
   if(!['PUBLISHED','ALREADY_PUBLISHED','STALE'].includes(result?.status))throw Error('Unconfirmed delivery');
   persist(destination,result);delivered++;
  }catch(error){
   const attempts=attempt.attempts+1;persist(attemptFile,{attempts,nextAttemptAt:now()+Math.min(900000,60000*2**Math.min(attempts-1,4)),reason:String(error.message).slice(0,300)});failed++;
  }
 }
 return {executed,delivered,failed};
}
