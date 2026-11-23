import assert from 'node:assert/strict';
import test from 'node:test';
import {startIsolatedControlCore} from './helpers/isolated-control-core';
let core: Awaited<ReturnType<typeof startIsolatedControlCore>>;
test.before(async()=>{core=await startIsolatedControlCore([{username:'legacy-alice',principal:'alice',workspace:'w'}]);});
import {prismaRaw as prisma} from '@/lib/storage/prisma';
import {saveUserSettings} from '@/lib/storage/server-config';
import {withCoreExperiments} from '@/lib/storage-core/experiments';
import {POST as draftRoute} from '@/app/api/skill-eval/trigger/[skillName]/draft/route';
import {DELETE as deleteRoute} from '@/app/api/skill-eval/trigger/[skillName]/route';
test.after(async()=>{await core?.dispose();});

test('original draft/delete handlers serialize durable begin, preserve exact lost ACK intent and reject late deleted-placeholder activation',async()=>{
 await core.run('legacy-alice',async()=>{
 await prisma.skill.create({data:{id:'draft-skill',name:'checking',user:'legacy-alice',description:'fallback',versions:{create:{version:0,content:'---\nname: checking\ndescription: exact v0\n---\nFROZEN BODY'}}}});
 await saveUserSettings('legacy-alice',{activeConfigId:'mock',configs:[{id:'mock',name:'Local Mock',provider:'custom',model:'mock',apiKey:'',headers:{'x-local':'fixture'},baseUrl:'http://127.0.0.1:19001'}]});
 });
 let receipt:Record<string,unknown>|undefined;let manifest:Record<string,unknown>|undefined;let status='running',lost=false;const writes:string[]=[];
 const fetcher:typeof fetch=async(url,options)=>{
  if(['/v1/auth/me','/v1/compat/platform-control'].includes(new URL(String(url)).pathname))return fetch(url,options);
  const raw=String(options?.body),body=JSON.parse(raw);
  if(body.action==='trigger_scope')return Response.json({value:{authorized:true,operation:body.operation,principal_id:'alice',workspace_id:'w'}});
  if(body.action==='lookup_operation')return Response.json({value:{found:!!receipt,result:receipt}});
  if(body.action==='trigger_draft_refs')return Response.json({value:{drafts:receipt?[{experiment_id:'draft-exp',set_id:(receipt.set as {id:string}).id,status}]:[]}});
  if(body.action==='trigger_begin'){writes.push(raw);assert.equal(body.operation_key,'draft-operation');assert.equal(body.operation_request.body.user,'forged');assert.ok(new Headers(options?.headers).get('x-storage-controller-proof'));assert.equal(body.manifest.skill.version,0);assert.ok(!JSON.stringify(body.manifest).includes('apiKey'));manifest=body.manifest;receipt={experiment_id:'draft-exp',run_id:'draft-run',set:body.manifest.placeholder};if(!lost){lost=true;throw TypeError('lost begin ACK');}return Response.json({value:receipt});}
  if(body.action==='trigger_draft_read')return Response.json({value:{experiment_id:'draft-exp',set:manifest!.placeholder,status,result:null}});
  if(body.action==='reconcile')return Response.json({value:{reconciled:0}});
  if(body.action==='claim')return Response.json({value:null});
  if(['trigger_delete_draft','trigger_cancel'].includes(body.action)){status='cancelled';return Response.json({value:{draft:{status},cancellation_id:'delete-fence',targets:[]}});}
  throw Error('Unexpected action '+body.action);
 };
 const request=(key='draft-operation')=>new Request('http://localhost/api/skill-eval/trigger/checking/draft',{method:'POST',headers:{authorization:'Bearer '+core.tokens['legacy-alice'],'content-type':'application/json','idempotency-key':key},body:JSON.stringify({user:'forged'})});
 const start=async(key?:string)=>{const input=request(key);return withCoreExperiments(input,()=>draftRoute(input,{params:Promise.resolve({skillName:'checking'})}),{fetcher});};
 const first=await start();assert.equal(first.status,200,await first.clone().text());const set=(await first.json()).set;assert.equal(set.status,'drafting');assert.equal(writes.length,2);assert.equal(writes[0],writes[1]);assert.equal(await core.run('legacy-alice',async()=>await prisma.skillTriggerEvalSet.count()),1);
 await core.run('legacy-alice',async()=>await prisma.skill.deleteMany({where:{id:'draft-skill'}}));const replay=await start();assert.equal(replay.status,200,await replay.clone().text());assert.equal((await replay.json()).set.id,set.id);assert.equal(writes.length,2);
 receipt=undefined;const conflict=await start('different-intent');assert.equal(conflict.status,409,await conflict.clone().text());assert.equal((await conflict.json()).set.id,set.id);receipt={experiment_id:'draft-exp',run_id:'draft-run',set};
 const deletion=new Request('http://localhost/api/skill-eval/trigger/checking?user=forged',{method:'DELETE',headers:{authorization:'Bearer '+core.tokens['legacy-alice']}});
 const deleted=await withCoreExperiments(deletion,()=>deleteRoute(deletion,{params:Promise.resolve({skillName:'checking'})}),{fetcher});assert.equal(deleted.status,200,await deleted.clone().text());assert.equal(await core.run('legacy-alice',async()=>await prisma.skillTriggerEvalSet.count()),0);assert.equal(status,'cancelled');
 const late=await start();assert.equal(late.status,410,await late.clone().text());assert.equal(await core.run('legacy-alice',async()=>await prisma.skillTriggerEvalSet.count()),0);
});
