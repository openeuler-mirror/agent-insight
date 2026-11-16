import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {createRequire} from 'node:module';
import {createAnalyticsSource} from '../src/lib/storage-core/analytics';
import {buildAnalyticsProjection} from '../src/lib/storage-core/analytics-projection';
import {selectKeepIdsByTaskId,type ExecutionRecord} from '../src/lib/storage/data-service';
import {overlayCoreOutcome} from '../src/lib/storage-core/trace-outcome-projection';
import type {CoreOutcomeLookup} from '../src/lib/storage-core/trace-outcome-projection';

const require=createRequire(import.meta.url);
type Row=Record<string,unknown>;
type Loaded={GET:(request:Request,context:{params:Promise<{id:string}>})=>Promise<Response>;coreSkillRecord:(row:Row)=>ExecutionRecord;readCoreSkillRecords:(request:Request,source?:unknown)=>Promise<{records:ExecutionRecord[]}>};
const now=Date.parse('2026-11-15T12:00:00Z');
const configs=[{id:'routing',query:'check access',dataset_type:'routing',routing_intent:'check access',routing_anchors:['access'],expectedSkills:[{skill:'expected-only',version:0},{skill:'secondary',version:2}],standard_answer:''},{id:'outcome',query:null,dataset_type:'outcome',skill:'primary',skillVersion:0,standard_answer:'answer',root_causes:[],key_actions:[]}];
function load(file:string,deps:Record<string,unknown>) {
 if(file==='src/lib/storage-core/skill-records.ts')deps['../storage/data-service']={...(deps['../storage/data-service'] as Record<string,unknown>),selectKeepIdsByTaskId};
 deps['./trace-outcome-projection']={overlayCoreOutcome};
 const sandboxModule={exports:{}};const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,{module:sandboxModule,exports:sandboxModule.exports,require:(name:string)=>name in deps?deps[name]:require(name),URL,Request,Response,Buffer,Date,Map,Set,console:{error(){},warn(){}}});return sandboxModule.exports as Loaded;
}
function fixture(rawOnly=false){
 const executions=[
  {id:'e0',taskId:'t0',user:'iam-alice',timestamp:new Date(now).toISOString(),isSubagent:false,agentName:'A',framework:'opencode',query:'check access',skill:'primary',skillVersion:0,skills:['primary','secondary'],invokedSkills:[{name:'primary',version:0},{name:'secondary',version:2}],finalResult:'完整输出\n'+'long'.repeat(200),answerScore:0,isAnswerCorrect:false,judgmentReason:'actual zero',failures:'[]',skillIssues:'[{"summary":"actual issue"}]',label:'original label',latency:0},
  {id:'e1',taskId:'t1',user:'iam-alice',timestamp:new Date(now-1000).toISOString(),isSubagent:false,agentName:'B',framework:'opencode',query:'check access',skill:null,skillVersion:null,skills:['secondary'],invokedSkills:[],finalResult:'',answerScore:null,isAnswerCorrect:null,judgmentReason:'结果评估中...',failures:'[]',skillIssues:'[]',label:null,latency:12},
  {id:'e2',taskId:'t2',user:'iam-alice',timestamp:new Date(now-2000).toISOString(),isSubagent:false,agentName:'C',framework:'opencode',query:'unrelated',skill:'primary',skillVersion:null,skills:[],invokedSkills:[],finalResult:null,answerScore:80,isAnswerCorrect:null,judgmentReason:null,failures:'[]',skillIssues:'[]',label:null,latency:null},
 ];
 if(rawOnly){executions.splice(1);Object.assign(executions[0],{skill:null,skillVersion:null,skills:['raw-only']});Reflect.deleteProperty(executions[0],'invokedSkills');}
 const items=executions.map(execution=>({trace_id:'trace-'+execution.id,boundary:'b-'+execution.id,projection:buildAnalyticsProjection({evidence:{snapshot_hash:'a'.repeat(64),execution,session:{interactions:[]}}})}));
 return {executions,source:{...createAnalyticsSource('alice',items),actor:{username:'alice',principalUsername:'iam-alice'},validate:async()=>{}}};
}
function setup(routeName:'skills/logs'|'skills/[id]/runs',options:{error?:number;forbidden?:boolean;changed?:boolean;legacy?:boolean;rawOnly?:boolean}={}) {
 const {executions,source}=fixture(options.rawOnly);let oldReads=0,oldAuth=0,validations=0,fullReads=0;const configUsers:string[]=[],accessUsers:unknown[]=[];
 const routing=(record:Row)=>({status:'available',expected_skills:[],invoked_skills:record.invokedSkills||[],matched_skills:[],matched_anchors:[],expected_count:2,matched_count:0,is_correct:false,trigger_rate:0,skill_breakdown:[{skill:'expected-only',expected:true,invoked:false,matched:false,status:'missed',expected_version:0,invoked_version:null},{skill:'secondary',expected:true,invoked:true,matched:true,status:'matched',expected_version:2,invoked_version:2}]});
 const snapshots=async(record:Row,_configs:unknown,user:string)=>{assert.equal(user,'alice');return{...record,routing_evaluation:routing(record),outcome_evaluation:{status:'available',score:record.answer_score??null,skill_breakdown:[{skill:'primary',version:record.skill_version??null,score:record.answer_score??null,is_correct:record.is_answer_correct??null}]}};};
 source.validate=async()=>{validations++;if(options.changed)throw Object.assign(Error('changed'),{status:409});};
 const data={readConfig:async(user:string)=>{configUsers.push(user);return configs;},buildRecordEvaluationSnapshots:snapshots,readRecords:async()=>{oldReads++;if(!options.legacy)throw Error('legacy dynamic read poisoned');return [
  {upload_id:'e0',task_id:'t0',timestamp:new Date(now).toISOString(),query:'check access',skill:'primary',skills:['primary','secondary'],skill_version:0,invokedSkills:[{name:'primary',version:0},{name:'secondary',version:2}],agentName:'A',answer_score:0,is_answer_correct:false,judgment_reason:'actual zero',failures:[],skill_issues:[{summary:'actual issue'}],label:'original label',final_result:'完整输出\n'+'long'.repeat(200)},
  {upload_id:'e1',task_id:'t1',timestamp:new Date(now-1000).toISOString(),query:'check access',skills:[],skill_version:null,invokedSkills:[],agentName:'B',answer_score:null,is_answer_correct:null,judgment_reason:'结果评估中...',failures:[],skill_issues:[],label:null,latency:12},
  {upload_id:'e2',task_id:'t2',timestamp:new Date(now-2000).toISOString(),query:'unrelated',skill:'primary',skills:[],skill_version:null,invokedSkills:[],agentName:'C',answer_score:80,is_answer_correct:null,failures:[],skill_issues:[],label:null},
 ].map(record=>({...record,routing_evaluation:routing(record),outcome_evaluation:{status:'available',score:record.answer_score??null,skill_breakdown:[{skill:'primary',version:record.skill_version??null,score:record.answer_score??null,is_correct:record.is_answer_correct??null}]}}));}};
 const deps:Record<string,unknown>={
  'next/server':{NextResponse:Response},
  '@/lib/storage-core/mode':{isStorageCoreEnabled:()=>!options.legacy},
  '@/lib/storage-core/analytics':{readCoreAnalytics:async()=>{if(options.error)throw Object.assign(Error('storage'),{status:options.error});return source;},analyticsFailure:(error:{status?:number})=>Response.json({error:'storage'},{status:error.status||503})},
  '@/lib/storage/data-service':data,
  '@/lib/auth/auth':{resolveUser:async()=>{oldAuth++;return{username:'alice'};},canAccessSkill:async(_id:string,user:string)=>{accessUsers.push(user);return{allowed:!options.forbidden,skill:{name:options.rawOnly?'raw-only':'secondary'}};}},
 };
 const helperFile='src/lib/storage-core/skill-records.ts';
 if(fs.existsSync(helperFile))deps['@/lib/storage-core/skill-records']=load(helperFile,{
  './analytics':deps['@/lib/storage-core/analytics'],
  './evidence':{readTraceExecution:async(_request:Request,refs:{executionId:string})=>{fullReads++;const execution=executions.find(row=>row.id===refs.executionId);assert.ok(execution);return{username:'alice',evidence:{execution}};}},
  '../storage/data-service':data,
 });
 const api=load('src/app/api/'+routeName+'/route.ts',deps);
 return {request:async(query='')=>api.GET(new Request('http://localhost/api/'+routeName+'?user=forged&'+query),{params:Promise.resolve({id:'skill-id'})}) as Promise<Response>,counts:()=>({oldReads,oldAuth,validations,fullReads}),configUsers,accessUsers};
}
test('Skill logs return real full source fields, zero score and secondary association without legacy reads',async()=>{
 const api=setup('skills/logs');const response=await api.request('skill=secondary&limit=1');assert.equal(response.status,200);const value=await response.json();assert.equal(value.length,1);assert.equal(value[0].task_id,'t0');assert.equal(value[0].answer_score,0);assert.equal(value[0].judgment_reason,'actual zero');assert.equal(value[0].skill_version,0);assert.equal(value[0].final_result,'完整输出\n'+'long'.repeat(200));assert.equal(value[0].skill_issues[0].summary,'actual issue');assert.equal(api.counts().oldReads,0);assert.equal(api.counts().oldAuth,0);assert.deepEqual(api.configUsers,['alice']);assert.ok(api.counts().validations>0);
});
test('Skill runs retain routing-only association, version zero and pagination with true status',async()=>{
 const api=setup('skills/[id]/runs');const response=await api.request('version=2&offset=1&limit=1');assert.equal(response.status,200);const value=await response.json();assert.equal(value.total,3);assert.equal(value.items.length,1);assert.equal(value.items[0].trace_id,'t1');assert.equal(value.items[0].status,'pending');assert.equal(value.items[0].duration_ms,12);assert.deepEqual(api.accessUsers,['alice']);assert.equal(api.counts().oldReads,0);
 const expected=setup('skills/logs');const result=await expected.request('skill=expected-only&skill_version=v0');assert.equal(result.status,200);assert.equal((await result.json()).length,3);
});
test('record reads keep null versions and omit empty output according to the old DTO',async()=>{
 const api=setup('skills/logs');const response=await api.request('skill=primary&limit=10');const rows=await response.json();assert.equal(response.status,200);assert.equal(rows.at(-1).skill_version,null);
 const secondary=setup('skills/logs');const result=await secondary.request('skill=secondary&limit=10');const values=await result.json();assert.equal(values[1].answer_score,null);assert.equal('final_result'in values[1],false);
});
test('Skill read errors and authorization do not fall back or turn into empty results',async()=>{
 for(const name of ['skills/logs','skills/[id]/runs'] as const)for(const error of [401,403,409,503]){const api=setup(name,{error});assert.equal((await api.request('skill=primary')).status,error);assert.equal(api.counts().oldReads,0);}
 const denied=setup('skills/[id]/runs',{forbidden:true});assert.equal((await denied.request()).status,403);assert.equal(denied.counts().fullReads,0);
 const changed=setup('skills/logs',{changed:true});assert.equal((await changed.request('skill=primary')).status,409);
});

test('record conversion preserves raw-only Skill associations and immutable unknown versions',()=>{
 const helper=load('src/lib/storage-core/skill-records.ts',{'./analytics':{},'./evidence':{},'../storage/data-service':{}});
 const raw=helper.coreSkillRecord({id:'raw',taskId:'task',user:'iam-alice',timestamp:new Date(now).toISOString(),skill:null,skillVersion:null,skills:'["secondary-only"]',invokedSkills:null,answerScore:0,isAnswerCorrect:false,finalResult:'',failures:'[]'});
 assert.deepEqual(JSON.parse(JSON.stringify(raw.skills)),['secondary-only']);assert.equal(raw.skill_version,null);assert.equal(raw.answer_score,0);assert.equal(raw.final_result,undefined);
 const related=helper.coreSkillRecord({id:'bound',taskId:'bound-task',skill:'primary',skillVersion:0,executionSkills:[{skillName:'secondary',skillVersion:2}],invokedSkills:'[{"name":"obsolete","version":9}]'});
 assert.deepEqual(JSON.parse(JSON.stringify(related.invokedSkills)),[{name:'secondary',version:2}]);assert.equal(related.rootSkill?.version,0);
});

test('Skill records use the selected current Outcome after immutable Execution hydration',async()=>{
 const {executions,source}=fixture();const current:CoreOutcomeLookup={outcome:{value:{version:1,source_snapshot_hash:'a'.repeat(64),answer_score:1,is_answer_correct:true,judgment_reason:'new selected result',failures:[],skill_issues:[]},experiment_id:'outcome',run_id:'run',machine_result_id:'machine',content_hash:'b'.repeat(64),generation:1},is_evaluating:false,run_id:'run',experiment_id:'outcome',selection_hash:'c'.repeat(64)};
 source.currentOutcome=id=>id==='e0'?current:null;
 const helper=load('src/lib/storage-core/skill-records.ts',{'./analytics':{},'./evidence':{readTraceExecution:async(_request:Request,refs:{executionId:string})=>({evidence:{execution:executions.find(row=>row.id===refs.executionId)}})},'../storage/data-service':{readConfig:async()=>[],buildRecordEvaluationSnapshots:async(record:unknown)=>record}});
 const result=await helper.readCoreSkillRecords(new Request('http://localhost'),source);const record=result.records.find(row=>row.upload_id==='e0');
 assert.equal(record?.answer_score,1);assert.equal(record?.is_answer_correct,true);assert.equal(record?.judgment_reason,'new selected result');assert.equal(executions[0].answerScore,0);
});

test('original routing/outcome algorithm is reused without reading old ExecutionMatch',async()=>{
 const service=await import('../src/lib/storage/data-service');const {db}=await import('../src/lib/storage/prisma');let dynamicReads=0;
 const previous=db.findExecutionMatch;db.findExecutionMatch=async()=>{dynamicReads++;throw Error('old dynamic table poisoned');};
 try {
  const result=await service.buildRecordEvaluationSnapshots({task_id:'t',query:'check access',skill:'primary',skill_version:0,invokedSkills:[{name:'primary',version:0},{name:'secondary',version:2}],answer_score:0,is_answer_correct:false,judgment_reason:'actual zero'},structuredClone(configs) as Parameters<typeof service.buildRecordEvaluationSnapshots>[1],'alice');
  assert.equal(result.answer_score,0);assert.equal(result.outcome_evaluation?.score,0);assert.equal(result.outcome_evaluation?.matched_skill_version,0);
  assert.equal(result.routing_evaluation?.skill_breakdown.find(row=>row.skill==='expected-only')?.status,'missed');assert.equal(result.routing_evaluation?.skill_breakdown.find(row=>row.skill==='secondary')?.status,'matched');
  assert.equal(result.routing_evaluation?.matched_count,1);assert.equal(dynamicReads,0);assert.equal('execution_match'in result,false);
 }finally{db.findExecutionMatch=previous;}
});

for(const name of ['skills/logs','skills/[id]/runs'] as const)test(name+' preserves the original public DTO from an independent legacy record fixture',async()=>{
 const old=setup(name,{legacy:true}),core=setup(name);const query=name==='skills/logs'?'skill=secondary&limit=2':'version=2&offset=0&limit=3';
 const before=await old.request(query),after=await core.request(query);assert.equal(before.status,200);assert.equal(after.status,200);assert.deepEqual(await after.json(),await before.json());assert.equal(core.counts().oldReads,0);
});

test('full record hydration uses at most four reads and no static configuration reads for an empty source',async()=>{
 let active=0,maxActive=0,configReads=0,validations=0;
 const rows=Array.from({length:13},(_,i)=>({id:'e'+i,taskId:'t'+i,user:'owner',isSubagent:false,timestamp:new Date(now-i)}));
 const source={username:'alice',findMany:()=>rows,validate:async()=>{validations++;}};
 const helper=load('src/lib/storage-core/skill-records.ts',{'./analytics':{readCoreAnalytics:async()=>source},'./evidence':{readTraceExecution:async(_request:Request,{executionId}:{executionId:string})=>{active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,1));active--;return{evidence:{execution:rows.find(row=>row.id===executionId)}};}},'../storage/data-service':{readConfig:async()=>{configReads++;return[];},buildRecordEvaluationSnapshots:async(record:unknown)=>record}});
 const request=new Request('http://localhost');assert.equal((await helper.readCoreSkillRecords(request)).records.length,13);assert.equal(maxActive,4);assert.equal(configReads,1);assert.equal(validations,1);
 source.findMany=()=>[];assert.equal((await helper.readCoreSkillRecords(request)).records.length,0);assert.equal(configReads,1);assert.equal(validations,2);
});

test('a conflicting full record stops scheduling the remaining canonical sources',async()=>{
 const rows=Array.from({length:20},(_,i)=>({id:'e'+i,taskId:'t'+i,user:'owner',isSubagent:false,timestamp:new Date(now-i)}));let reads=0;
 const helper=load('src/lib/storage-core/skill-records.ts',{'./analytics':{readCoreAnalytics:async()=>({username:'alice',findMany:()=>rows,validate:async()=>{}})},'./evidence':{readTraceExecution:async(_request:Request,{executionId}:{executionId:string})=>{reads++;await new Promise(resolve=>setTimeout(resolve,1));const row=rows.find(row=>row.id===executionId)!;return{evidence:{execution:{...row,id:executionId==='e0'?'wrong':executionId}}};}},'../storage/data-service':{readConfig:async()=>[],buildRecordEvaluationSnapshots:async(record:unknown)=>record}});
 await assert.rejects(()=>helper.readCoreSkillRecords(new Request('http://localhost')),error=>!!error&&typeof error==='object'&&'status'in error&&error.status===409);
 await new Promise(resolve=>setTimeout(resolve,20));assert.equal(reads,4);
});

test('empty legacy JSON columns and malformed invocation JSON use the original field-specific fallbacks',()=>{
 const helper=load('src/lib/storage-core/skill-records.ts',{'./analytics':{},'./evidence':{},'../storage/data-service':{}});
 const empty=helper.coreSkillRecord({id:'empty',taskId:'empty',skills:'',invokedSkills:'',failures:'',skillIssues:''});
 assert.equal(empty.skills,undefined);assert.equal(empty.invokedSkills,undefined);assert.equal(empty.failures,undefined);assert.deepEqual(JSON.parse(JSON.stringify(empty.skill_issues)),[]);
 for(const invokedSkills of ['{bad json','{}','null']) {
  const row=helper.coreSkillRecord({id:'fallback',taskId:'fallback',skills:'["raw-secondary"]',invokedSkills,failures:null,skillIssues:null});
  assert.deepEqual(JSON.parse(JSON.stringify(row.skills)),['raw-secondary']);assert.equal(row.invokedSkills,undefined);assert.equal(row.failures,undefined);assert.deepEqual(JSON.parse(JSON.stringify(row.skill_issues)),[]);
 }
});

test('canonical root selection uses the original localeCompare tie rule',async()=>{
 const rows=['B','a'].map(id=>({id,taskId:'same-task',user:'owner',isSubagent:false,timestamp:new Date(now)}));const readIds:string[]=[];
 const helper=load('src/lib/storage-core/skill-records.ts',{'./analytics':{readCoreAnalytics:async()=>({username:'alice',findMany:()=>rows,validate:async()=>{}})},'./evidence':{readTraceExecution:async(_request:Request,{executionId}:{executionId:string})=>{readIds.push(executionId);return{evidence:{execution:rows.find(row=>row.id===executionId)}};}},'../storage/data-service':{readConfig:async()=>[],buildRecordEvaluationSnapshots:async(record:unknown)=>record}});
 const result=await helper.readCoreSkillRecords(new Request('http://localhost'));assert.equal(result.records.length,1);assert.deepEqual(readIds,['a']);
});

for(const explicitNull of [false,true])test('native metadata supplements only undeclared execution fields: '+(explicitNull?'explicit nulls retained':'secondary Skill version zero'),async()=>{
 const identity={id:'native',taskId:'native-task',user:'iam-alice',timestamp:new Date(now).toISOString(),framework:'opencode',agentName:'native-agent'};
 const projection=buildAnalyticsProjection({evidence:{snapshot_hash:'a'.repeat(64),execution:{...identity,skill:null,skillVersion:0,invokedSkills:[{name:'secondary-only',version:0}],failures:[{failure_type:'timeout',description:'real native failure'}],skillIssues:[{summary:'real native issue'}],isAnswerCorrect:false,latency:23},session:{interactions:[]}}});
 let validations=0;
 const source={...createAnalyticsSource('alice',[{trace_id:'native-trace',boundary:'same-boundary',projection}]),validate:async()=>{validations++;}};
 const full:Row=explicitNull?{...identity,invoked_skills:null,executionSkills:null,is_answer_correct:null,failures:null,skill_issues:null,latency:null,skill_version:null,skill:null}:identity;
 const helper=load('src/lib/storage-core/skill-records.ts',{'./analytics':{readCoreAnalytics:async()=>source},'./evidence':{readTraceExecution:async()=>({evidence:{execution:full}})},'../storage/data-service':{readConfig:async()=>[],buildRecordEvaluationSnapshots:async(record:unknown)=>record}});
 const record=(await helper.readCoreSkillRecords(new Request('http://localhost'))).records[0];
 assert.equal(validations,1);assert.equal(record.answer_score,undefined);
 if(explicitNull){assert.equal(record.invokedSkills,undefined);assert.equal(record.skills,undefined);assert.equal(record.is_answer_correct,null);assert.equal(record.failures,undefined);assert.deepEqual(JSON.parse(JSON.stringify(record.skill_issues)),[]);assert.equal(record.latency,undefined);assert.equal(record.skill_version,null);}
 else{assert.deepEqual(JSON.parse(JSON.stringify(record.invokedSkills)),[{name:'secondary-only',version:0}]);assert.deepEqual(JSON.parse(JSON.stringify(record.skills)),['secondary-only']);assert.equal(record.skill,undefined);assert.equal(record.skill_version,0);assert.equal(record.latency,23);assert.equal(record.is_answer_correct,false);assert.equal(record.failures?.[0].description,'real native failure');assert.equal(record.skill_issues?.[0].summary,'real native issue');}
});

for(const name of ['skills/logs','skills/[id]/runs'] as const)test(name+' retains native raw-skills-only associations without inventing an invocation',async()=>{
 const api=setup(name,{rawOnly:true});const response=await api.request('skill=raw-only');assert.equal(response.status,200);const value=await response.json();
 if(name==='skills/logs'){assert.equal(value.length,1);assert.equal(value[0].task_id,'t0');assert.deepEqual(value[0].invoked_skills,[]);assert.equal(value[0].skill_version,null);}
 else{assert.equal(value.total,1);assert.equal(value.items[0].trace_id,'t0');assert.equal(value.items[0].version,null);}
 assert.equal(api.counts().oldReads,0);
});
