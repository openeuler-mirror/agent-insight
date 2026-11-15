import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import {createAnalyticsSource,readCoreAgentMetadata,type AnalyticsSource} from '../src/lib/storage-core/analytics';
import {buildAnalyticsProjection} from '../src/lib/storage-core/analytics-projection';

const require=createRequire(import.meta.url);
const now=Date.now();
const metadata=[{trace_id:'t',boundary:'b',executionId:'e',taskId:'task',agentId:'registered',agentName:'A',framework:'opencode',timestamp:new Date(now).toISOString(),user:'alice',interactions:[{role:'assistant',agent:'A'},{role:'subagent',subagent_name:'worker'}]}];
function route(core:boolean,failure?:number,records=metadata,principalUsername='alice'){
 let oldReads=0;let oldAuth=0;let validated=0;let ensured=0;const created:Record<string,unknown>[]=[];
 const registrations=[{id:'registered',name:'A',platform:'opencode',agentType:'main',agentOwnership:'user',user:'alice',description:'original',createdAt:new Date(now-1000)}];
 const source={username:'alice',actor:{principalUsername},validate:async()=>{validated++;}};
 const deps:Record<string,unknown>={
  'next/server':{NextResponse:Response},
  '@/lib/storage-core/mode':{isStorageCoreEnabled:()=>core},
  '@/lib/storage-core/analytics':{readCoreAnalytics:async()=>{if(failure)throw Object.assign(Error('unavailable'),{status:failure});return source;},readCoreAgentMetadata:async()=>records,analyticsFailure:(error:{status:number})=>Response.json({error:'storage'},{status:error.status})},
  '@/lib/system-agents':{ensureAllSystemAgents:async()=>{ensured++;}},
  '@/lib/system-agent-names':{isInternalSystemAgentTrace:()=>false},
  '@/lib/storage/prisma':{prismaRaw:{
   execution:{findMany:async()=>{oldReads++;if(core)throw Error('legacy poisoned');return[];}},session:{findMany:async()=>{oldReads++;if(core)throw Error('legacy poisoned');return[];}},
   registeredAgent:{findMany:async(query:{where:unknown})=>{if(core)assert.deepEqual(JSON.parse(JSON.stringify(query.where)),{OR:[{user:'alice'},{user:null}]});return registrations;},findFirst:async({where}:{where:{name:string}})=>registrations.find(row=>row.name===where.name)||null,create:async({data}:{data:Record<string,unknown>})=>{created.push(data);return data;}}
  }},
  '@/lib/auth/auth':{resolveUser:async()=>{oldAuth++;throw Error('legacy auth poisoned');}},
 };
 const sandboxModule={exports:{}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/api/agents/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:sandboxModule,exports:sandboxModule.exports,require:(name:string)=>deps[name]??require(name),Date,Response,URL,Map,Set,console:{error(){},warn(){}}});
 return {GET:(sandboxModule.exports as {GET(request:Request):Promise<Response>}).GET,counts:()=>({oldReads,oldAuth,validated,ensured}),created};
}
test('Agent list uses real registered id and original registration extraction with no legacy Trace reads',async()=>{
 const api=route(true);const response=await api.GET(new Request('http://localhost/api/agents?user=bob'));
 assert.equal(response.status,200);const value=await response.json();
 assert.deepEqual(value,{agents:[{...{id:'registered',platform:'opencode',name:'A',description:'original',agentType:'main',agentOwnership:'user',user:'alice'},createdAt:new Date(now-1000).toISOString(),todayCalls:'1',lastExecutedAt:new Date(now).toISOString()}]});
 assert.deepEqual(JSON.parse(JSON.stringify(api.created)),[{platform:'opencode',name:'worker',user:'alice',agentType:'subagent',agentOwnership:'user'}]);
 assert.equal(api.counts().oldReads,0);assert.equal(api.counts().oldAuth,0);assert.ok(api.counts().validated>0);
});
test('Agent list authenticates before system registration and returns core failures directly',async()=>{
 for(const status of [401,403,409,503]){const api=route(true,status);assert.equal((await api.GET(new Request('http://localhost/api/agents'))).status,status);assert.equal(api.counts().ensured,0);assert.equal(api.counts().oldReads,0);}
});


test('Agent metadata reader binds actual ids and registration coverage to the authorized source',async()=>{
 process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';let validations=0;let calls=0;
 const projection=buildAnalyticsProjection({evidence:{snapshot_hash:'a'.repeat(64),execution:{id:'e',taskId:'task',user:'alice',timestamp:new Date(now).toISOString(),agentName:'A',framework:'opencode'},session:{interactions:[]}}});
 const source={...createAnalyticsSource('alice',[{trace_id:'t',boundary:'b',projection}]),actor:{token:'api_'+'A'.repeat(43),workspace:'w',principal:'alice',username:'alice',principalUsername:'alice'},validate:async()=>{validations++;}} as AnalyticsSource;
 const fetcher=async(url:RequestInfo|URL,init?:RequestInit)=>{calls++;assert.equal(new URL(String(url)).searchParams.get('workspace_id'),'w');const body=JSON.parse(String(init?.body));assert.equal(body.action,'agent_metadata');assert.deepEqual(body.items,[{trace_id:'t',boundary:'b',registrations:true}]);return Response.json({value:{items:metadata}});};
 assert.equal((await readCoreAgentMetadata(source,{fetcher:fetcher as typeof fetch}))[0].agentId,'registered');assert.equal(validations,1);assert.equal(calls,1);
 for(const change of [{executionId:'wrong'},{user:'bob'},{interactions:undefined},{interactions:[{content:'private-body'}]}]) {
  await assert.rejects(()=>readCoreAgentMetadata(source,{fetcher:async()=>Response.json({value:{items:[{...metadata[0],...change}]}})}));
 }
});

test('same-named traces without the real registered id do not inflate Agent statistics',async()=>{
 const api=route(true,undefined,[{...metadata[0],agentId:null as unknown as string,interactions:[]}]);
 const response=await api.GET(new Request('http://localhost/api/agents?user=bob'));
 assert.equal(response.status,200);const value=await response.json();assert.equal(value.agents[0].todayCalls,'0');assert.equal(value.agents[0].lastExecutedAt,value.agents[0].createdAt);assert.deepEqual(api.created,[]);
});

test('legacy login aliases map own observed registrations to the original static owner',async()=>{
 const api=route(true,undefined,[{...metadata[0],user:'iam-alice'}],'iam-alice');const response=await api.GET(new Request('http://localhost/api/agents?user=bob'));
 assert.equal(response.status,200);const value=await response.json();assert.equal(value.agents[0].todayCalls,'1');assert.equal(api.created[0]?.user,'alice');assert.equal(api.created[0]?.name,'worker');
});
