import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';


const runAck=(changes:Record<string,unknown>={})=>({id:'run',user:'legacy-alice',skillName:'checking',skillVersion:0,triggerSetId:'set',results:[],passRate:0,truePositiveRate:0,falsePositiveRate:0,runsPerQuery:1,triggerThreshold:.5,timeoutMs:5000,durationMs:null,modelId:null,workspaceRoot:'/isolated',status:'running',errorMessage:null,createdAt:'2026-11-16T00:00:00Z',updatedAt:'2026-11-16T00:00:00Z',...changes});
const setAck=(changes:Record<string,unknown>={})=>({id:'set',user:'legacy-alice',skillName:'checking',version:1,versionSource:'llm-draft',versionNote:null,description:'',items:[],draftedFromSkillHash:null,status:'drafting',createdAt:'2026-11-16T00:00:00Z',updatedAt:'2026-11-16T00:00:00Z',...changes});

function fixture(){
 const memory=new Map<string,string>(),calls:Array<{url:string;key:string|null;operation:string|null}>=[];let actor='alice-key',sequence=0;
 let respond:(url:string,options:RequestInit)=>Promise<Response>=(url)=>Promise.resolve(Response.json(url.endsWith('/cancel')?{success:true,aborted:true,run:runAck({id:'old'})}:{success:true,run:runAck(),set:setAck()}));
 const fixtureModule={exports:{}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/client/api.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:fixtureModule,exports:fixtureModule.exports,Headers,Response,Date,TextEncoder,Uint8Array,process:{env:{}},window:{},localStorage:{getItem:(key:string)=>key==='user_id'?'legacy-alice':actor},crypto:{subtle:webcrypto.subtle,randomUUID:()=>`trigger-operation-${++sequence}`},sessionStorage:{getItem:(key:string)=>memory.get(key)||null,setItem:(key:string,value:string)=>memory.set(key,value),removeItem:(key:string)=>memory.delete(key)},fetch:async(url:string,options:RequestInit)=>{const h=new Headers(options.headers);calls.push({url,key:h.get('x-witty-api-key'),operation:h.get('idempotency-key')});return respond(url,options);}});
 return {calls,memory,api:(fixtureModule.exports as {apiFetch:(url:string,options?:RequestInit)=>Promise<Response>}).apiFetch,setActor:(value:string)=>{actor=value;},respond:(fn:typeof respond)=>{respond=fn;}};
}
const post=(body:unknown)=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});

test('original Trigger routes transport the current actor key only for exact supported paths',async()=>{
 const f=fixture();
 for(const [url,method] of [['/api/skill-eval/trigger/checking','GET'],['/api/skill-eval/trigger/checking','POST'],['/api/skill-eval/trigger/checking','DELETE'],['/api/skill-eval/trigger/checking/upload','POST'],['/api/skill-eval/trigger/checking/draft','POST'],['/api/skill-eval/trigger/checking/run','POST'],['/api/skill-eval/trigger/checking/runs','GET'],['/api/skill-eval/trigger/checking/run/r1/cancel','POST']])await f.api(url,{method});
 assert.ok(f.calls.every(value=>value.key==='alice-key'));
 await f.api('/api/skill-eval/trigger/checking/unrelated');assert.equal(f.calls.at(-1)?.key,null);
 await f.api('/api/skill-eval/trigger/checking/runs',{headers:{'x-witty-api-key':'explicit'}});assert.equal(f.calls.at(-1)?.key,'explicit');
});

for(const kind of ['run','draft'])test('Trigger '+kind+' retains one logical key through lost or malformed ACK and clears only success true',async()=>{
 const f=fixture();let attempt=0;
 f.respond(async()=>{if(++attempt===1)throw Error('lost response');if(attempt===2)return new Response('{"success":');if(attempt===3)return Response.json({ok:true});return Response.json({success:true,run:runAck(),set:setAck()});});
 const url='/api/skill-eval/trigger/checking/'+kind,options=post({user:'forged',skillVersion:0});
 await assert.rejects(()=>f.api(url,options),/lost response/);await assert.rejects(()=>f.api(url,options));await f.api(url,options);await f.api(url,options);await f.api(url,options);
 assert.ok(f.calls[0].operation);assert.equal(f.calls[0].operation,f.calls[1].operation);assert.equal(f.calls[1].operation,f.calls[2].operation);assert.equal(f.calls[2].operation,f.calls[3].operation);assert.notEqual(f.calls[3].operation,f.calls[4].operation);assert.equal(f.memory.size,0);
});

test('cancelling a lost-ACK Trigger v0 clears exactly its operation while v1 and another account remain pending',async()=>{
 const f=fixture();f.respond(async()=>{throw Error('lost response');});const url='/api/skill-eval/trigger/checking/run';
 const v0=post({skillVersion:0}),v1=post({skillVersion:1});await assert.rejects(()=>f.api(url,v0));await assert.rejects(()=>f.api(url,v1));const key0=f.calls[0].operation!,key1=f.calls[1].operation!;assert.ok(key0);assert.ok(key1);
 f.setActor('bob-key');await assert.rejects(()=>f.api(url,v0));const bob=f.calls[2].operation!;f.setActor('alice-key');
 for(const ack of [{success:true},{success:true,aborted:true,run:runAck({id:'wrong-run',skillVersion:0,status:'cancelled'})}]){f.respond(async()=>Response.json(ack,{headers:{'x-storage-trigger-operation':createHash('sha256').update(key0).digest('hex')}}));await f.api('/api/skill-eval/trigger/checking/run/v0-run/cancel',post({user:'forged'}));assert.ok([...f.memory.values()].join('').includes(key0));}
 f.respond(async()=>Response.json({success:true,aborted:true,run:runAck({id:'v0-run',skillVersion:0,status:'cancelled'})},{headers:{'x-storage-trigger-operation':createHash('sha256').update(key0).digest('hex')}}));
 await f.api('/api/skill-eval/trigger/checking/run/v0-run/cancel',post({user:'forged'}));f.respond(async()=>{throw Error('lost response');});
 await assert.rejects(()=>f.api(url,v0));assert.notEqual(f.calls.at(-1)?.operation,key0);await assert.rejects(()=>f.api(url,v1));assert.equal(f.calls.at(-1)?.operation,key1);f.setActor('bob-key');await assert.rejects(()=>f.api(url,v0));assert.equal(f.calls.at(-1)?.operation,bob);
 assert.ok(![...f.memory.values()].join('').includes('alice-key'));assert.ok(![...f.memory.values()].join('').includes('forged'));
});

for(const kind of ['run','draft'])test('Trigger '+kind+' only clears a pending intent for its complete corresponding DTO',async()=>{
 const f=fixture(),url='/api/skill-eval/trigger/checking/'+kind,options=post({skillVersion:0,triggerSetId:'set'});
 const field=kind==='run'?'run':'set',ack=kind==='run'?runAck:setAck;
 const incomplete=[{success:true},{success:true,[field]:{}},{success:true,[field]:{id:'some-id'}},{success:true,[field]:ack({id:''})},{success:true,[field]:ack({skillName:'other'})},{success:true,[field]:ack({status:'invented'})},{success:true,[field]:ack({createdAt:null})},...(kind==='run'?[{success:true,run:runAck({skillVersion:1})},{success:true,run:runAck({triggerSetId:'wrong-set'})},{success:true,run:runAck({results:null})}]:[{success:true,set:setAck({version:0})},{success:true,set:setAck({items:null})}])];
 for(const value of incomplete){f.respond(async()=>Response.json(value));await f.api(url,options);}
 const original=f.calls[0].operation;assert.ok(original);assert.ok(f.calls.every(call=>call.operation===original));assert.equal(f.memory.size,1);
 f.respond(async()=>Response.json({success:true,[field]:ack()}));await f.api(url,options);assert.equal(f.calls.at(-1)?.operation,original);assert.equal(f.memory.size,0);
 await f.api(url,options);assert.notEqual(f.calls.at(-1)?.operation,original);
});
