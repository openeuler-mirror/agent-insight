import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import {createAnalyticsSource} from '../src/lib/storage-core/analytics';
import {analyticsRecords} from '../src/lib/storage-core/analytics-records';
import {isEvaluatorAgentName} from '../src/lib/evaluator-agent';
import {buildAnalyticsProjection} from '../src/lib/storage-core/analytics-projection';

const require=createRequire(import.meta.url);
const now=Date.parse('2026-11-15T12:00:00Z');
class FixedDate extends Date {constructor(value?:string|number|Date){super(value===undefined?now:value);}static now(){return now;}}
function fixture() {
  const items=[0,1,2].map(index=>({trace_id:'trace-'+index,boundary:'b'+index,projection:buildAnalyticsProjection({evidence:{snapshot_hash:'a'.repeat(64),execution:{id:'e'+index,taskId:'t'+index,user:'alice',timestamp:new Date(now-index*86400000).toISOString(),agentName:'A',framework:'opencode',model:'gpt-4o',latency:1000+index,tokens:0,inputTokens:20,outputTokens:10,cost:0.5,toolCallCount:2,toolCallErrorCount:index===0?1:0,llmCallCount:1,failures:index===0?'[{"failure_type":"timeout","description":"timeout"}]':'[]',isAnswerCorrect:index===1?false:null,executionSkills:[{skillName:'s',version:1},{skillName:'s',version:2}]},session:{startTime:new Date(now-index*86400000).toISOString(),interactions:[]}}})}));
  let validations=0;
  const base=createAnalyticsSource('alice',items);
  return {...base,actor:{username:'alice'},validate:async()=>{validations++;},enrich:async()=>({trajectories:[],issues:[],diagnoses:[]}),validations:()=>validations};
}
function route(name:string,core:boolean,source=fixture(), registrations?:{name:string;user:string|null;platform:string;agentOwnership:string;createdAt:Date}[]) {
  let oldReads=0;let oldAuth=0;
  const registered=registrations||[{name:'A',user:'alice',platform:'opencode',agentOwnership:'user',createdAt:new Date(now)}];
  const dynamic=()=>{oldReads++;if(core)throw Error('Legacy dynamic tables poisoned');return source;};
  const deps:Record<string,unknown>={
    'next/server':{NextResponse:Response},
    '@/lib/storage-core/mode':{isStorageCoreEnabled:()=>core},
    '@/lib/storage-core/analytics':{readCoreAnalytics:async()=>source,analyticsFailure:(error:{status?:number})=>Response.json({error:'storage'},{status:error.status||502})},
    '@/lib/storage-core/compat':{compatibilityFailure:(error:{status?:number})=>Response.json({error:'storage'},{status:error.status||502})},
    '@/lib/auth/admin':{resolveTraceReadScope:async()=>{oldAuth++;return{username:'alice',user:'alice'};}},
    '@/lib/auth/auth':{resolveUser:async()=>{oldAuth++;return{username:'alice'};}},
    '@/lib/storage/data-service':{
      listObservedAgentNames:async()=>{dynamic();return [...new Set([...source.rows].sort((a,b)=>b.timestamp.getTime()-a.timestamp.getTime()).flatMap(row=>[row.agentName,...(row.observedAgents?JSON.parse(row.observedAgents):[])].filter((name):name is string=>!!name&&!isEvaluatorAgentName(name))))];},
      listObservedSkills:async()=>{dynamic();const bindings=source.rows.flatMap(row=>row.executionSkills.map(skill=>skill.skillName));return [...new Set(bindings.length?bindings:source.rows.map(row=>row.skill).filter(Boolean))].sort().map(name=>({name}));},
      readRecords:async(_user:unknown,filters:Parameters<typeof analyticsRecords>[1])=>{dynamic();return analyticsRecords(source,filters);},
    },
    '@/lib/storage/prisma':{prisma:{execution:{findMany:(query:unknown)=>dynamic().findMany(query as never),count:(query:unknown)=>dynamic().count(query as never)},executionSkill:{findMany:()=>{dynamic();return source.skillRows(source.rows.map(row=>row.id));}},session:{findMany:()=>{dynamic();return[];}},rasAnomalyEvent:{findMany:()=>{dynamic();return[];}},registeredAgent:{findMany:async(query:{where?:{user?:unknown;OR?:unknown;platform?:string}})=>{
        if(core&&name==='quality/agents')assert.deepEqual(JSON.parse(JSON.stringify(query.where?.OR)),[{user:'alice'},{user:null}]);
        else if(core)assert.deepEqual(JSON.parse(JSON.stringify(query.where?.user)),{in:['alice']});
        return registered.filter(row=>(row.user==='alice'||name==='quality/agents'&&row.user===null)&&(!query.where?.platform||row.platform===query.where.platform));
      }}}},
  };
  const sandboxModule={exports:{}};const code=ts.transpileModule(fs.readFileSync(new URL('../src/app/api/'+name+'/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code,{module:sandboxModule,exports:sandboxModule.exports,require:(name:string)=>deps[name]??require(name),Date:FixedDate,Request,Response,URL,Set,Map,console:{error(){},warn(){}}});
  return{GET:(sandboxModule.exports as {GET(req:Request):Promise<Response>}).GET,counts:()=>({oldReads,oldAuth}),source};
}
for(const name of ['dashboard/stats','fleet/trends','fleet/breakdowns','fleet/agent','fleet/reliability','observe/task-insight','quality/agents','quality/executions','observe/task-stats']) {
  test(name+' keeps original aggregate DTO while core dynamic stores and legacy user auth are poisoned',async()=>{
    const query=name==='fleet/agent'?'?name=A':name==='dashboard/stats'?'?agentOwnership=all':name==='quality/executions'?'?agent=A':name==='observe/task-stats'?'?taskId=t0':'?range=all';
    const legacy=route(name,false);const core=route(name,true);
    const request=new Request('http://localhost/api/'+name+query+'&user=admin');
    const before=await legacy.GET(request);const after=await core.GET(request);
    assert.equal(before.status,200);assert.equal(after.status,200);
    assert.deepEqual(await after.json(),await before.json());
    assert.deepEqual(core.counts(),{oldReads:0,oldAuth:0});
    assert.ok(core.source.validations()>0);
  });
}

test('every statistics route preserves core authentication/indexing errors instead of falling back',async()=>{
  for(const name of ['dashboard/stats','fleet/trends','fleet/breakdowns','fleet/agent','fleet/reliability','observe/task-insight']) {
    const source=fixture();source.findMany=()=>{throw Object.assign(Error('indexing'),{status:503});};
    const api=route(name,true,source);const result=await api.GET(new Request('http://localhost/api/'+name+'?name=A'));
    assert.equal(result.status,503,name);assert.deepEqual(api.counts(),{oldReads:0,oldAuth:0});
  }
});


test('Quality facets retain observed-only Agents, public system metadata and secondary Skills while excluding judges',async()=>{
 const source=fixture();source.rows[0].observedAgents=JSON.stringify(['Observed-only','trace-quality-evaluator']);source.rows[0].executionSkills=[{skillName:'secondary',version:2}];
 source.rows[1].agentName='System';
 const registrations=[{name:'A',user:'alice',platform:'opencode',agentOwnership:'user',createdAt:new Date(now)},{name:'System',user:null,platform:'opencode',agentOwnership:'system',createdAt:new Date(now)},{name:'Secret',user:'bob',platform:'opencode',agentOwnership:'user',createdAt:new Date(now)}];
 const core=route('quality/agents',true,source,registrations);const response=await core.GET(new Request('http://localhost/api/quality/agents?user=bob&platform=opencode'));
 assert.equal(response.status,200);const value=await response.json();
 assert.ok(value.agents.some((row:{name:string;ownership:string})=>row.name==='System'&&row.ownership==='system'));
 assert.ok(value.agents.some((row:{name:string})=>row.name==='Observed-only'));
 assert.ok(!value.agents.some((row:{name:string})=>row.name==='trace-quality-evaluator'||row.name==='Secret'));
 assert.ok(value.skills.includes('secondary'));assert.deepEqual(core.counts(),{oldReads:0,oldAuth:0});
});
