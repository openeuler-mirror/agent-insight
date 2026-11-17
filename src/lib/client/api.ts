/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const URL_PREFIX = process.env.NEXT_PUBLIC_URL_PREFIX || '';
const BATCH_OPERATION_STORAGE='agent-insight.batch-trace.operations.v1';
interface BatchOperation {signature:string;key:string;createdAt:number;scope?:string}
function batchOperations():BatchOperation[]{
  try{
    const parsed:unknown=JSON.parse(sessionStorage.getItem(BATCH_OPERATION_STORAGE)||'[]');
    return Array.isArray(parsed)?parsed.filter((value):value is BatchOperation=>!!value&&typeof value==='object'&&typeof value.signature==='string'&&/^[a-f0-9]{64}$/.test(value.signature)&&typeof value.key==='string'&&/^[\x21-\x7e]{1,512}$/.test(value.key)&&typeof value.createdAt==='number'&&Number.isFinite(value.createdAt)&&(value.scope===undefined||typeof value.scope==='string'&&/^[a-f0-9]{64}$/.test(value.scope))).slice(-32):[];
  }catch{return [];}
}
function saveBatchOperations(operations:BatchOperation[]){
  try{if(operations.length)sessionStorage.setItem(BATCH_OPERATION_STORAGE,JSON.stringify(operations.slice(-32)));else sessionStorage.removeItem(BATCH_OPERATION_STORAGE);}catch{}
}


type TriggerAckRow=Record<string,unknown>;
const triggerAckRow=(value:unknown):value is TriggerAckRow=>!!value&&typeof value==='object'&&!Array.isArray(value);
const triggerAckId=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
const triggerAckDate=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const triggerAckNullableText=(value:unknown)=>value===null||typeof value==='string';
function validTriggerRunAck(value:unknown,skillName:string):value is TriggerAckRow{
 if(!triggerAckRow(value)||!triggerAckId(value.id)||!triggerAckId(value.user)||value.skillName!==skillName||!Number.isSafeInteger(value.skillVersion)||Number(value.skillVersion)<0||!triggerAckId(value.triggerSetId)||!Array.isArray(value.results)||!['running','done','failed','cancelled'].includes(String(value.status)))return false;
 if(!['passRate','truePositiveRate','falsePositiveRate','triggerThreshold'].every(key=>typeof value[key]==='number'&&Number.isFinite(value[key])&&Number(value[key])>=0&&Number(value[key])<=1))return false;
 if(!['runsPerQuery','timeoutMs'].every(key=>Number.isSafeInteger(value[key])&&Number(value[key])>0)||!(value.durationMs===null||typeof value.durationMs==='number'&&Number.isFinite(value.durationMs)&&value.durationMs>=0))return false;
 return ['modelId','workspaceRoot','errorMessage'].every(key=>triggerAckNullableText(value[key]))&&triggerAckDate(value.createdAt)&&triggerAckDate(value.updatedAt);
}
function validTriggerSetAck(value:unknown,skillName:string):value is TriggerAckRow{
 return triggerAckRow(value)&&triggerAckId(value.id)&&triggerAckId(value.user)&&value.skillName===skillName&&Number.isSafeInteger(value.version)&&Number(value.version)>=1&&['llm-draft','user-upload','manual'].includes(String(value.versionSource))&&triggerAckNullableText(value.versionNote)&&typeof value.description==='string'&&Array.isArray(value.items)&&triggerAckNullableText(value.draftedFromSkillHash)&&['drafting','ready','failed'].includes(String(value.status))&&triggerAckDate(value.createdAt)&&triggerAckDate(value.updatedAt);
}
function validTriggerStartAck(value:unknown,kind:string,skillName:string,body:BodyInit|null|undefined):boolean{
 if(!triggerAckRow(value)||value.success!==true)return false;
 if(kind==='draft')return validTriggerSetAck(value.set,skillName);
 if(!validTriggerRunAck(value.run,skillName))return false;
 let request:TriggerAckRow={};try{if(typeof body==='string'){const parsed:unknown=JSON.parse(body);if(triggerAckRow(parsed))request=parsed;}}catch{return false;}
 return (request.skillVersion===undefined||request.skillVersion===null||value.run.skillVersion===Number(request.skillVersion))&&(!request.triggerSetId||value.run.triggerSetId===String(request.triggerSetId).trim());
}


export async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const fullUrl = URL_PREFIX + url;
  const headers = new Headers(options?.headers);
  const pathname=url.split(/[?#]/,1)[0];
  const method=(options?.method||'GET').toUpperCase();
  let transportedKey: string | null | undefined;
  const batchAuth=/^\/api\/debug\/batch-tasks(?:\/[^/]+)?$/.test(pathname)&&['GET','POST','PATCH'].includes(method);
  const triggerMatch=/^(\/api\/skill-eval\/trigger\/[^/]+)(?:\/(upload|draft|run|runs)|\/run\/[^/]+\/(cancel))?$/.exec(pathname);
  const triggerAuth=!!triggerMatch&&['GET','POST','DELETE'].includes(method);
  const fiAuth=/^\/api\/fault-injection\/(tasks(?:\/(?:stop|delete))?|task\/[^/]+(?:\/rerun)?|platforms(?:\/[^/]+\/(?:agents|models))?|health)$/.test(pathname)&&['GET','POST'].includes(method);
  const rasAuth=pathname==='/api/ingest/ras-events'&&['GET','DELETE'].includes(method);
  const consumerAuth=batchAuth||triggerAuth||fiAuth||rasAuth||method==='GET'&&(pathname==='/api/modelconfig/pricing'||pathname==='/api/skills'||pathname==='/api/skills/logs'||pathname==='/api/agents'||pathname==='/api/ingest/ras-events'||/^\/api\/fault-injection\/runs\/[^/]+\/trace$/.test(pathname)||/^\/api\/skills\/[^/]+\/(runs|versions)$/.test(pathname)||/^\/api\/skills\/by-name\/[^/]+\/optimization-points$/.test(pathname))||method==='PATCH'&&/^\/api\/skills\/by-name\/[^/]+\/optimization-points\/resolve$/.test(pathname);
  if (typeof window !== 'undefined' && (consumerAuth || url.startsWith('/api/observe/') || url.startsWith('/api/fault/diagnosis/') || url.startsWith('/api/fleet/') || url.startsWith('/api/quality/') || url.startsWith('/api/dashboard/') || url.startsWith('/api/tags') || url.startsWith('/api/agent-datasets') || url.startsWith('/api/experiments') || url.startsWith('/api/user-evaluators') || url.startsWith('/api/skill-workbench/') || url.startsWith('/api/eval/settings') || url.startsWith('/api/evaluation/') || url.startsWith('/api/diagnosis-runs') || url.includes('/diagnosis-inputs') || (url.startsWith('/api/skill-workbench/skills/') && url.endsWith('/retest')) || url.startsWith('/api/skill-workbench/sessions/diagnosis-') || url.startsWith('/api/skill-opt/sessions/diagnosis-') || url.startsWith('/api/skill-opt/chat') || url.startsWith('/api/skill-opt/plan') || url.startsWith('/api/eval/rejudge') || url.startsWith('/api/eval/trajectory') || url.startsWith('/api/debug/grayscale')) && !headers.has('x-witty-api-key')) {
    const key = localStorage.getItem('api_key');
    if (key) {headers.set('x-witty-api-key', key);transportedKey=key;}
  }
  let batchOperation:BatchOperation|undefined;let batchAction:unknown;let batchScope:string|undefined;
  if(batchAuth&&method==='POST'&&/^\/api\/debug\/batch-tasks\/[^/]+$/.test(pathname)&&typeof options?.body==='string'){
    try{batchAction=JSON.parse(options.body).action;const bytes=new TextEncoder().encode(JSON.stringify([fullUrl.split(/[?#]/,1)[0],headers.get('x-witty-api-key'),headers.get('authorization'),localStorage.getItem('user_id')]));batchScope=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');}catch{}
  }
  if(batchAuth&&method==='POST'&&/^\/api\/debug\/batch-tasks\/[^/]+$/.test(pathname)&&typeof options?.body==='string'&&!headers.has('idempotency-key')){
    let action:unknown;
    try{action=JSON.parse(options.body).action;}catch{}
    if(['evaluate','retry-evaluate','start','retry-execute'].includes(String(action))&&typeof crypto!=='undefined'&&typeof crypto.randomUUID==='function'){
      const key=crypto.randomUUID();headers.set('idempotency-key',key);
      try{
        const bytes=new TextEncoder().encode(JSON.stringify([fullUrl,options.body,headers.get('x-witty-api-key'),headers.get('authorization'),localStorage.getItem('user_id')]));
        const signature=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
        const pending=batchOperations();batchOperation={...(pending.find(value=>value.signature===signature)||{signature,key,createdAt:Date.now()}),...(batchScope?{scope:batchScope}:{})};
        headers.set('idempotency-key',batchOperation.key);
        saveBatchOperations([...pending.filter(value=>value.signature!==signature),batchOperation]);
      }catch{}
    }
  }
  let triggerOperation:BatchOperation|undefined;let triggerScope:string|undefined;
  if(triggerAuth&&method==='POST'&&typeof crypto!=='undefined'&&typeof crypto.randomUUID==='function'){
    try{const bytes=new TextEncoder().encode(JSON.stringify([URL_PREFIX+triggerMatch![1],headers.get('x-witty-api-key'),headers.get('authorization'),localStorage.getItem('user_id'),'trigger']));triggerScope=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');}catch{}
    if(['run','draft'].includes(triggerMatch![2])&&typeof options?.body==='string'&&!headers.has('idempotency-key')){
      const key=crypto.randomUUID();headers.set('idempotency-key',key);
      try{const bytes=new TextEncoder().encode(JSON.stringify([fullUrl,options.body,headers.get('x-witty-api-key'),headers.get('authorization'),localStorage.getItem('user_id')]));const signature=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');const pending=batchOperations();triggerOperation={...(pending.find(value=>value.signature===signature)||{signature,key,createdAt:Date.now()}),...(triggerScope?{scope:triggerScope}:{})};headers.set('idempotency-key',triggerOperation.key);saveBatchOperations([...pending.filter(value=>value.signature!==signature),triggerOperation]);}catch{}
    }
  }
  const triggerRunsRead=method==='GET'&&triggerMatch?.[2]==='runs';
  const triggerReadDeadline=Date.now()+15_000;
  let triggerIdentity:{key:string|null;user:string|null}|undefined;
  if(triggerRunsRead&&typeof window!=='undefined'){try{triggerIdentity={key:localStorage.getItem('api_key'),user:localStorage.getItem('user_id')};}catch{}}
  const triggerReadHeaders=()=>{
    options?.signal?.throwIfAborted();
    const current=new Headers(headers);
    if(typeof window!=='undefined'){
      let identity:{key:string|null;user:string|null};try{identity={key:localStorage.getItem('api_key'),user:localStorage.getItem('user_id')};}catch{throw new Error('登录身份不可用，请重新加载');}
      if(!triggerIdentity||identity.key!==triggerIdentity.key||identity.user!==triggerIdentity.user)throw new Error('登录身份已变化，请重新加载');
      if(transportedKey!==undefined&&identity.key)current.set('x-witty-api-key',identity.key);
    }
    return current;
  };
  let response = await fetch(fullUrl, { ...options, headers });
  let triggerReadRetries=0;
  while(triggerRunsRead&&response.status===409&&response.headers.get('x-storage-retry')==='trigger-read-changed'&&triggerReadRetries++<3&&Date.now()<triggerReadDeadline){
    void response.body?.cancel().catch(()=>{});triggerReadHeaders();
    const controller=new AbortController(),signal=options?.signal;
    const abort=()=>controller.abort(signal?.reason);signal?.addEventListener('abort',abort,{once:true});
    const deadline=setTimeout(()=>controller.abort(new Error('读取触发评测记录超时，请重试')),Math.max(0,triggerReadDeadline-Date.now()));
    try{
      if(signal?.aborted)abort();
      await new Promise<void>((resolve,reject)=>{
        if(controller.signal.aborted){reject(controller.signal.reason);return;}
        const interrupted=()=>{clearTimeout(wait);reject(controller.signal.reason);};
        const wait=setTimeout(()=>{controller.signal.removeEventListener('abort',interrupted);resolve();},100);
        controller.signal.addEventListener('abort',interrupted,{once:true});
      });
      response=await fetch(fullUrl,{...options,headers:triggerReadHeaders(),signal:controller.signal});
      try{triggerReadHeaders();}catch(error){void response.body?.cancel().catch(()=>{});throw error;}
    }finally{clearTimeout(deadline);signal?.removeEventListener('abort',abort);}
  }
  if(triggerRunsRead&&!response.ok){void response.body?.cancel().catch(()=>{});throw Object.assign(new Error('读取触发评测记录失败，请重试'),{status:response.status});}

  const started=Date.now();
  let retries=0;
  while(method==='GET'&&response.status===503&&response.headers.get('x-storage-retry')==='analytics-indexing'&&Date.now()-started<15_000&&retries++<15) {
    if(options?.signal?.aborted)break;
    if(transportedKey!==undefined&&localStorage.getItem('api_key')!==transportedKey)break;
    await new Promise(resolve=>setTimeout(resolve,1000));
    if(options?.signal?.aborted||transportedKey!==undefined&&localStorage.getItem('api_key')!==transportedKey)break;
    response=await fetch(fullUrl,{...options,headers});
  }
  if(batchOperation&&response.ok){
    const acknowledgement:unknown=await response.clone().json();
    if(acknowledgement&&typeof acknowledgement==='object'&&!Array.isArray(acknowledgement)&&'ok' in acknowledgement&&acknowledgement.ok===true){
      saveBatchOperations(batchOperations().filter(value=>value.signature!==batchOperation!.signature||value.key!==batchOperation!.key));
    }
  }
  if(batchAction==='abort'&&batchScope&&response.ok){
    try{const acknowledgement:unknown=await response.clone().json();if(acknowledgement&&typeof acknowledgement==='object'&&!Array.isArray(acknowledgement)&&'ok'in acknowledgement&&acknowledgement.ok===true)saveBatchOperations(batchOperations().filter(value=>value.scope!==batchScope));}catch{}
  }
  if(triggerOperation&&response.ok){
    const acknowledgement:unknown=await response.clone().json();
    let skillName:string;try{skillName=decodeURIComponent(triggerMatch![1].split('/').at(-1)!);}catch{return response;}
    if(validTriggerStartAck(acknowledgement,triggerMatch![2],skillName,options?.body))saveBatchOperations(batchOperations().filter(value=>value.signature!==triggerOperation!.signature||value.key!==triggerOperation!.key));
  }
  if(triggerMatch?.[3]==='cancel'&&triggerScope&&response.ok){
    try{const acknowledgement:unknown=await response.clone().json(),operation=response.headers.get('x-storage-trigger-operation');if(triggerAckRow(acknowledgement)&&acknowledgement.success===true&&typeof acknowledgement.aborted==='boolean'&&validTriggerRunAck(acknowledgement.run,decodeURIComponent(triggerMatch[1].split('/').at(-1)!))&&acknowledgement.run.id===decodeURIComponent(pathname.split('/').at(-2)!)&&operation&&/^[a-f0-9]{64}$/.test(operation)){const pending=batchOperations(),remove=new Set<string>();for(const value of pending){if(value.scope!==triggerScope)continue;const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value.key))),byte=>byte.toString(16).padStart(2,'0')).join('');if(hash===operation)remove.add(value.key);}saveBatchOperations(batchOperations().filter(value=>value.scope!==triggerScope||!remove.has(value.key)));}}catch{}
  }
  return response;
}

export function getApiUrl(url: string): string {
  return URL_PREFIX + url;
}
