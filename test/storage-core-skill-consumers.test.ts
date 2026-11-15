import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {createAnalyticsSource} from '../src/lib/storage-core/analytics';
import {buildAnalyticsProjection} from '../src/lib/storage-core/analytics-projection';

const require=createRequire(import.meta.url);
const now=Date.parse('2026-11-15T12:00:00Z');
class FixedDate extends Date {constructor(value?:string|number|Date){super(value===undefined?now:value);}static now(){return now;}}
function load(file:string,deps:Record<string,unknown>) {
 const sandboxModule={exports:{}};
 const js=ts.transpileModule(fs.readFileSync(new URL('../'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(js,{module:sandboxModule,exports:sandboxModule.exports,require:(name:string)=>name in deps?deps[name]:require(name),Date:FixedDate,URL,Response,Request,Buffer,Set,Map,console:{warn(){},error(){}}});return sandboxModule.exports as {GET:(request:Request,context:{params:Promise<{id:string}>})=>Promise<Response>;readCoreSkillOutputs:(request:Request,rows:{id:string;taskId:string}[])=>Promise<Map<string,{finalResult:string|null;agentId:string|null}>>};
}
function fixture(count=4,dense=false) {
 const executions=Array.from({length:count},(_,index)=>({id:'e'+index,taskId:'t'+index,user:'alice',timestamp:new Date(now-index*(dense?1000:4*86400000)),skill:'checking',skillVersion:dense?0:index%2,agentName:index%2?'B':'A',agentId:index%2?'agent-b':'agent-a',query:'question '+index,finalResult:index===0?'完整输出\n'+('汉字'.repeat(700)):index===1?'':null,latency:index===0?0:index===1?null:1200,isAnswerCorrect:index===1?false:null,failures:index===2?'[{"description":"error"}]':index===3?'malformed':'[]'}));
 const items=executions.map(execution=>({trace_id:'trace-'+execution.id,boundary:'b-'+execution.id,projection:buildAnalyticsProjection({evidence:{snapshot_hash:'a'.repeat(64),execution:{...execution,timestamp:execution.timestamp.toISOString()},session:{interactions:[]}}})}));
 const source={...createAnalyticsSource('alice',items),actor:{username:'alice'},validate:async()=>{}};
 const skill={id:'s',name:'checking',user:'alice',description:'Description',updatedAt:new Date(now),category:'test',tags:'[]',author:'Author',activeVersion:0,visibility:'private',isUploaded:true,versions:[0,1].map(version=>({id:'v'+version,version,semanticVersion:'1.'+version,changeLog:'version '+version,createdAt:new Date(now-version*86400000)}))};
 return {executions,source,skill};
}
function setup(name:'skills'|'skills/[id]/versions',core:boolean,options:{count?:number;error?:number;forbidden?:boolean;evidenceError?:number;mismatch?:boolean;validateError?:number;dense?:boolean}={}) {
 const {executions,source,skill}=fixture(options.count,options.dense);let dynamicReads=0,oldAuth=0,validations=0,evidenceReads=0;const staticScopes:unknown[]=[];const accessUsers:unknown[]=[];
 source.validate=async()=>{validations++;if(options.validateError)throw Object.assign(Error('changed'),{status:options.validateError});};
 const deps:Record<string,unknown>={
  'next/server':{NextResponse:Response},
  '@/lib/storage-core/mode':{isStorageCoreEnabled:()=>core},
  '@/lib/storage-core/analytics':{readCoreAnalytics:async()=>{if(options.error)throw Object.assign(Error('unavailable'),{status:options.error});return source;},analyticsFailure:(e:{status?:number})=>Response.json({error:'storage'},{status:e.status||502})},
  '@/lib/auth/auth':{resolveUser:async()=>{oldAuth++;return{username:'alice'};},canAccessSkill:async(_id:unknown,user:unknown)=>{accessUsers.push(user);return{allowed:!options.forbidden&&user==='alice',skill};}},
  '@/lib/storage/prisma':{db:{findSkills:async(where:unknown)=>{staticScopes.push(JSON.parse(JSON.stringify(where)));return[skill];},findSkillById:async()=>skill},prismaRaw:{execution:{findMany:async(query:Parameters<typeof source.findMany>[0])=>{dynamicReads++;if(core)throw Error('Old execution poisoned');const selected=new Set(source.findMany(query).map(row=>row.id));return executions.filter(row=>selected.has(row.id));}},evaluation:{findMany:async()=>[{skillId:'s',version:0,issues:[{severity:'medium'}]}]}}},
  '@/lib/env':{getSkillStorageRoot:()=>'/unused'},
  '@/lib/engine/skill-generation/legacy/skill-sync-service':{},
  '@/lib/usage-analytics/collector':{},
  '@/lib/engine/observability/flow-parser':{},
  '@/lib/engine/skill-issues/static-evaluator':{},
 };
 const evidence={readTraceExecution:async(_request:Request,refs:{executionId:string})=>{evidenceReads++;if(options.evidenceError)throw Object.assign(Error('evidence unavailable'),{status:options.evidenceError});const execution=executions.find(row=>row.id===refs.executionId);assert.ok(execution);return{username:'alice',evidence:{execution:{...execution,id:options.mismatch?'wrong':execution.id}}};}};
 deps['@/lib/storage-core/evidence']=evidence;
 const helperPath=new URL('../src/lib/storage-core/skill-consumers.ts',import.meta.url);
 if(fs.existsSync(helperPath))deps['@/lib/storage-core/skill-consumers']=load('src/lib/storage-core/skill-consumers.ts',{'./evidence':evidence});
 const route=load('src/app/api/'+name+'/route.ts',deps);
 return {async request(){const request=new Request('http://localhost/api/'+name+'?user=bob');Object.assign(request,{nextUrl:new URL(request.url)});return route.GET(request,{params:Promise.resolve({id:'s'})}) as Promise<Response>;},counts:()=>({dynamicReads,oldAuth,validations,evidenceReads}),staticScopes,accessUsers};
}
for(const name of ['skills','skills/[id]/versions'] as const) {
 test(name+' keeps legacy DTO from new summaries with old dynamic reads poisoned',async()=>{
  const legacy=setup(name,false),core=setup(name,true);const expected=await legacy.request(),actual=await core.request();assert.equal(actual.status,200);assert.deepEqual(await actual.json(),await expected.json());assert.equal(core.counts().dynamicReads,0);assert.equal(core.counts().oldAuth,0);assert.ok(core.counts().validations>0);
  if(name==='skills')assert.deepEqual(core.staticScopes[0],{OR:[{user:'alice'},{user:null},{visibility:'public'}]});else{assert.deepEqual(core.accessUsers,['alice']);assert.equal(core.counts().evidenceReads,4);}
 });
 test(name+' preserves empty usage, null rate and original static metadata',async()=>{
  const legacy=setup(name,false,{count:0}),core=setup(name,true,{count:0});assert.deepEqual(await(await core.request()).json(),await(await legacy.request()).json());assert.equal(core.counts().dynamicReads,0);assert.equal(core.counts().evidenceReads,0);
 });
 test(name+' never returns fake zero usage when new store fails',async()=>{
  for(const error of [401,403,409,503]){const core=setup(name,true,{error});assert.equal((await core.request()).status,error);assert.equal(core.counts().dynamicReads,0);}
 });
 test(name+' rejects source changes rather than returning mixed statistics',async()=>{
  const core=setup(name,true,{validateError:409});assert.equal((await core.request()).status,409);assert.equal(core.counts().dynamicReads,0);
 });
}
test('version statistics check static Skill access using verified identity',async()=>{
 const core=setup('skills/[id]/versions',true,{forbidden:true});assert.equal((await core.request()).status,403);assert.deepEqual(core.accessUsers,['alice']);assert.equal(core.counts().evidenceReads,0);assert.equal(core.counts().dynamicReads,0);
});
test('version output hydration errors and identity mismatch fail the response',async()=>{
 for(const options of [{evidenceError:503},{mismatch:true}]){const core=setup('skills/[id]/versions',true,options);assert.equal((await core.request()).status,'mismatch'in options?409:503);assert.equal(core.counts().dynamicReads,0);}
});

test('version statistics retain the 800-row aggregate and hydrate only 30 displayed outputs per version',async()=>{
 const core=setup('skills/[id]/versions',true,{count:65,dense:true});const response=await core.request();assert.equal(response.status,200);const versions=await response.json();assert.equal(versions[0].usage.calls7d,65);assert.equal(versions[0].executions.length,30);assert.equal(versions[1].executions.length,0);assert.equal(core.counts().evidenceReads,30);assert.equal(core.counts().dynamicReads,0);
});
test('display output hydration uses a bounded pool and reads each execution once',async()=>{
 let active=0,maxActive=0,reads=0;
 const helper=load('src/lib/storage-core/skill-consumers.ts',{'./evidence':{readTraceExecution:async(_request:Request,refs:{executionId:string})=>{active++;reads++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,1));active--;return{evidence:{execution:{id:refs.executionId,taskId:'t-'+refs.executionId,finalResult:'',agentId:null}}};}}});
 const rows=Array.from({length:20},(_,i)=>({id:'e'+i,taskId:'t-e'+i}));const output=await helper.readCoreSkillOutputs(new Request('http://localhost'),[...rows,...rows]);assert.equal(output.size,20);assert.equal(reads,20);assert.equal(maxActive,4);assert.equal(output.get('e0')?.finalResult,'');
});
