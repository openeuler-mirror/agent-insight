import {controlVmFixture} from './helpers/storage-core-vm';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {createHash} from 'node:crypto';

type Row=Record<string,unknown>;
function load(file:string,deps:Row):Row{
 const module={exports:{}};
 vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:(id:string)=>deps[id]||{},Request,Response,URL,Date,Map,Set,Error,JSON,Promise,console});return module.exports;
}
function fixture(body:Row={user:'forged',ids:['derived']}){
 const calls:Array<{action:string;body:Row}>=[];const staticRows:Row[]=[];let available=true;const values=new Map<string,Row>([['derived',{id:'derived',skillId:'skill',source:'dynamic',resolvedAt:null}]]);const operations=new Map<string,Row>();
 const context={actor:{username:'owner'},operationKey:'request-one',body,rpc:async(action:string,payload:Row)=>{calls.push({action,body:payload});if(!available)throw Object.assign(Error('offline'),{status:503});if(action==='derived_resolution_scope')return {fingerprint:'current-authority'};if(action==='derived_lookup')return values.has(String(payload.id))?{found:true,value:values.get(String(payload.id))}:{found:false,value:null};if(action==='derived_issue_resolve'){const key=String(payload.operation_key);if(operations.has(key))return operations.get(key);const ids=payload.issue_ids as string[];const fresh=ids.filter(id=>!values.get(id)!.resolvedAt).length;ids.forEach(id=>values.get(id)!.resolvedAt='now');const result={resolved_ids:ids,newly_resolved:fresh,resolved_run_id:payload.resolved_run_id};operations.set(key,result);return result;}throw Error(action);}};
 const derived=load('src/lib/storage-core/derived-issues.ts',{'node:crypto':{createHash},'./experiments':{requireCoreExperimentContext:()=>context}});
 const prisma={skill:{findMany:async()=>[{id:'skill'}]},skillIssue:{findMany:async(query:Row)=>{calls.push({action:'static-read',body:query});return staticRows;},updateMany:async(query:Row)=>{calls.push({action:'static-write',body:query});const fresh=staticRows.filter(row=>!row.resolvedAt);fresh.forEach(row=>row.resolvedAt='now');return {count:fresh.length};}}};
 const handler=load('src/lib/storage-core/issue-resolution-route.ts',{'node:crypto':{createHash},'@/lib/storage/prisma':{prismaRaw:prisma},'./derived-issues':derived,'./experiments':{getCoreExperimentContext:()=>context,requireCoreExperimentContext:()=>context,coreExperimentFailure:(error:Row)=>Response.json({error:'failed'},{status:Number(error.status)||502})},'./workbench':{withCoreWorkbenchRoute:()=>{throw Error('unexpected nested wrapper');}}});
 return {context,calls,staticRows,values,setAvailable:(value:boolean)=>{available=value;},run:()=> (handler.handleCoreIssueResolution as (request:Request,name:string)=>Promise<Response>)(new Request('http://localhost/api/skills/by-name/skill/optimization-points/resolve',{method:'PATCH',body:JSON.stringify(body)}),'skill')};
}

test('original resolve handles new typed IDs with verified actor and nullable thread without legacy dynamic writes',async()=>{
 const f=fixture();const response=await f.run();assert.equal(response.status,200);assert.deepEqual(await response.json(),{resolvedCount:1});const write=f.calls.find(call=>call.action==='derived_issue_resolve')!;assert.equal(write.body.resolved_run_id,null);assert.equal(f.calls.filter(call=>call.action==='static-write').length,0);assert.equal(f.values.get('derived')!.resolvedAt,'now');assert.equal(f.calls.find(call=>call.action==='static-read')!.body.where&&JSON.stringify(f.calls.find(call=>call.action==='static-read')!.body).includes('forged'),false);
});
test('mixed static and typed resolutions preflight both domains and keep original write guards',async()=>{
 const f=fixture({user:'forged',ids:['derived','static','derived','missing'],threadId:'session'});f.staticRows.push({id:'static',resolvedAt:null});const response=await f.run();assert.equal(response.status,200);assert.deepEqual(await response.json(),{resolvedCount:2});const write=f.calls.find(call=>call.action==='static-write')!.body;assert.equal(JSON.stringify(write).includes('static'),true);assert.deepEqual(JSON.parse(JSON.stringify(write)).where,{id:{in:['static']},user:'owner',source:{in:['static','feedback']},Skill:{name:'skill'},resolvedAt:null});
});
test('typed failures and ID collisions cannot partially update old static state',async()=>{
 const offline=fixture({ids:['derived','static']});offline.staticRows.push({id:'static',resolvedAt:null});offline.setAvailable(false);assert.equal((await offline.run()).status,503);assert.equal(offline.calls.some(call=>call.action==='static-write'),false);
 const collision=fixture();collision.staticRows.push({id:'derived',resolvedAt:null});assert.equal((await collision.run()).status,409);assert.equal(collision.calls.some(call=>call.action==='derived_issue_resolve'||call.action==='static-write'),false);
});
test('missing and wrong Skill IDs are ignored while redacted ownership is rejected',async()=>{
 const ignored=fixture({ids:['missing','other']});ignored.values.set('other',{id:'other',skillId:'different',source:'dynamic'});assert.deepEqual(await (await ignored.run()).json(),{resolvedCount:0});
 const privateIssue=fixture();privateIssue.values.set('derived',{id:'derived',skillId:'different',gold_redacted:true});assert.equal((await privateIssue.run()).status,403);
});
test('explicit operation replay and fresh repeat retain core receipt and old update-count semantics',async()=>{
 const f=fixture({ids:['derived'],threadId:'session'});assert.deepEqual(await (await f.run()).json(),{resolvedCount:1});assert.deepEqual(await (await f.run()).json(),{resolvedCount:1});f.context.operationKey='request-two';assert.deepEqual(await (await f.run()).json(),{resolvedCount:0});
});

test('the original PATCH entry delegates before legacy body parsing or SkillIssue reads',async()=>{
 let delegated=0;const control=controlVmFixture({actor:{token:'fixture',workspace:'w',principal:'p',username:'owner'}});
 const api=load('src/app/api/skills/by-name/[name]/optimization-points/resolve/route.ts',{'@/lib/storage-core/control-route':control.route,'next/server':{NextResponse:Response},'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},'@/lib/storage-core/issue-resolution-route':{handleCoreIssueResolution:async(_request:Request,name:string)=>{control.assertScoped();assert.equal(name,'skill');delegated++;return Response.json({resolvedCount:1});}},'@/lib/storage/prisma':{prismaRaw:new Proxy({},{get(){throw Error('legacy read');}})}});
 const response=await (api.PATCH as (request:Request,props:unknown)=>Promise<Response>)(new Request('http://localhost/api/skills/by-name/skill/optimization-points/resolve',{method:'PATCH',body:'{}'}),{params:Promise.resolve({name:'skill'})});assert.equal(response.status,200);assert.deepEqual(await response.json(),{resolvedCount:1});assert.equal(delegated,1);
});

test('a valid maximum-length request key remains valid for the typed operation receipt',async()=>{
 const f=fixture();f.context.operationKey='k'.repeat(512);assert.equal((await f.run()).status,200);const key=f.calls.find(call=>call.action==='derived_issue_resolve')!.body.operation_key;assert.equal(typeof key,'string');assert.ok(String(key).length<=512);
});
