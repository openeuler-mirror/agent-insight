import {coreServiceOrigin} from './server';
import {coreReadAttempts as attempts,type CoreReadAttempt} from './read-attempt-context';

export function isCoreReadTransition(error:unknown):boolean {
 if(!error||typeof error!=='object'||!('status'in error)||!('code'in error))return false;
 return error.status===409&&error.code==='TRACE_READ_CHANGED'||error.status===503&&error.code==='TRACE_INDEXING';
}
export const coreReadChanged=(message:string)=>Object.assign(new Error(message),{status:409,code:'TRACE_READ_CHANGED'});
export const coreReadInvalidated=(message:string)=>Object.assign(new Error(message),{status:409,code:'TRACE_READ_INVALIDATED'});
export function markCoreReadSideEffect(){const attempt=attempts.getStore();if(attempt)attempt.sideEffect=true;}
export const coreReadRetryActive=()=>attempts.getStore()!==undefined;
export function bindCoreReadIdentity(actor:{principal:string;workspace:string}){
 const attempt=attempts.getStore();if(!attempt)return;
 const identity=JSON.stringify([actor.principal,actor.workspace]);
 if(attempt.identity!==undefined&&attempt.identity!==identity)throw Object.assign(new Error('Storage read identity changed'),{status:403});
 attempt.identity=identity;
}

function wait(signal:AbortSignal,milliseconds:number):Promise<void>{
 return new Promise((resolve,reject)=>{
  if(signal.aborted){reject(signal.reason);return;}
  const abort=()=>{clearTimeout(timer);reject(signal.reason);};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},milliseconds);
  signal.addEventListener('abort',abort,{once:true});
 });
}

export async function withCoreReadRetry<T>(request:Request,read:()=>Promise<T>):Promise<T>{
 if(request.method!=='GET'||attempts.getStore())return read();
 const state:CoreReadAttempt={origin:coreServiceOrigin(),signal:request.signal,sideEffect:false};const deadline=Date.now()+15000;let lastTransition:unknown;
 return attempts.run(state,async()=>{
  for(let attempt=0;;attempt++){
   request.signal.throwIfAborted();
   if(attempt>0&&Date.now()>=deadline)throw lastTransition;
   if(coreServiceOrigin()!==state.origin)throw Object.assign(new Error('Storage read origin changed'),{status:503});
   try{const value=await read();request.signal.throwIfAborted();if(coreServiceOrigin()!==state.origin)throw Object.assign(new Error('Storage read origin changed'),{status:503});return value;}
   catch(error){
    request.signal.throwIfAborted();
    const remaining=deadline-Date.now();
    if(!isCoreReadTransition(error)||state.sideEffect||attempt>=31||remaining<=0)throw error;
    lastTransition=error;
    await wait(request.signal,Math.min(100*(attempt+1),500,remaining));
   }
  }
 });
}
