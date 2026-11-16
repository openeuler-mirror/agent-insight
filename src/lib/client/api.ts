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


export async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const fullUrl = URL_PREFIX + url;
  const headers = new Headers(options?.headers);
  const pathname=url.split(/[?#]/,1)[0];
  const method=(options?.method||'GET').toUpperCase();
  let transportedKey: string | null | undefined;
  const batchAuth=/^\/api\/debug\/batch-tasks(?:\/[^/]+)?$/.test(pathname)&&['GET','POST','PATCH'].includes(method);
  const consumerAuth=batchAuth||method==='GET'&&(pathname==='/api/modelconfig/pricing'||pathname==='/api/skills'||pathname==='/api/skills/logs'||pathname==='/api/agents'||pathname==='/api/ingest/ras-events'||/^\/api\/fault-injection\/runs\/[^/]+\/trace$/.test(pathname)||/^\/api\/skills\/[^/]+\/(runs|versions)$/.test(pathname)||/^\/api\/skills\/by-name\/[^/]+\/optimization-points$/.test(pathname))||method==='PATCH'&&/^\/api\/skills\/by-name\/[^/]+\/optimization-points\/resolve$/.test(pathname);
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
  let response = await fetch(fullUrl, { ...options, headers });
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
  return response;
}

export function getApiUrl(url: string): string {
  return URL_PREFIX + url;
}
