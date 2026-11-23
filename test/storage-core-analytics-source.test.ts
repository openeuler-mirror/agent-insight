import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AnalyticsExecution } from '../src/lib/storage-core/analytics-projection';
import { createAnalyticsSource, readCoreAnalytics } from '../src/lib/storage-core/analytics';

const row = (id: string, timestamp: string, extra = {}) => ({id, taskId: id, timestamp, isSubagent:false, agentName:'a', user:'alice', ...extra}) as unknown as AnalyticsExecution;
test('analytics read adapter preserves date predicates, ordering, root/child and skill relations', () => {
  const source = createAnalyticsSource('alice', [{trace_id:'t',boundary:'b',projection:{version:1,executions:[row('r','2026-11-14T00:00:00Z',{executionSkills:[{skillName:'s'},{skillName:'s'}]}),row('c','2026-11-15T00:00:00Z',{isSubagent:true,rootExecutionId:'r'})],collaboration:{candidate:true,startTime:'2026-11-15T02:00:00Z',edges:[['a','b']]},errors:[],provenance:{snapshot_hash:'a'.repeat(64)}}}]);
  assert.deepEqual(source.findMany({where:{isSubagent:false}}).map(r=>r.id),['r']);
  assert.deepEqual(source.findMany({where:{timestamp:{gte:new Date('2026-11-15Z')}}}).map(r=>r.id),['c']);
  assert.deepEqual(source.findMany({orderBy:{timestamp:'desc'},take:1}).map(r=>r.id),['c']);
  assert.ok(source.findMany({take:1})[0].timestamp instanceof Date);
  assert.equal(source.skillRows(['r']).length,2);
  assert.equal(source.collaborations(new Date('2026-11-15Z')).length,1);
  assert.equal(source.traceTaskId('r'),'r');assert.equal(source.traceTaskId('c'),'r');
  assert.throws(()=>source.findMany({where:{unknownField:1}}),/Unsupported/);
});

test('unified source authenticates real actor and rejects scope drift across pages', async () => {
  process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';
  const calls: string[]=[];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url=String(input);calls.push(url);
    if(url.includes('/auth/me')) return Response.json({principal_id:'p',username:'alice',workspace_id:'w',workspaces:[{workspace_id:'w'}]});
    const body=JSON.parse(String(init?.body));
    return Response.json({value:{items:[],pending:[],ras_events:[],scope_fingerprint:body.cursor?'changed':'initial',next_cursor:body.cursor?null:'next'}});
  };
  await assert.rejects(()=>readCoreAnalytics(new Request('http://localhost/api/fleet/trends?user=admin',{headers:{authorization:'Bearer session_'+'A'.repeat(43)}}),{fetcher:fetcher as typeof fetch}),/Authorization/);
  assert.equal(calls.filter(x=>x.includes('/compat/analytics')).length,2);
});

test('oversized analytics pages retry a smaller page without losing the first cursor',async()=>{
  process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';const limits:number[]=[];
  const fetcher=async(input:RequestInfo|URL,init?:RequestInit)=>{
    if(String(input).includes('/auth/me'))return Response.json({principal_id:'p',username:'alice',workspace_id:'w',workspaces:[{workspace_id:'w'}]});
    const body=JSON.parse(String(init?.body));limits.push(body.limit);
    if(body.limit>25)return Response.json({error:'page too large'},{status:413});
    return Response.json({value:{items:[],pending:[],ras_events:[],scope_fingerprint:'s',next_cursor:null}});
  };
  const value=await readCoreAnalytics(new Request('http://localhost/api/fleet/trends',{headers:{authorization:'Bearer session_'+'A'.repeat(43)}}),{fetcher:fetcher as typeof fetch});
  assert.equal(value.rows.length,0);assert.deepEqual(limits,[200,100,50,25]);
});

test('selected non-default workspace is carried in the real RPC URL; ignored agent parameters do not narrow original statistics',async()=>{
  process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';const selections:Record<string,unknown>[]=[];
  const fetcher=async(input:RequestInfo|URL,init?:RequestInit)=>{
    if(String(input).includes('/auth/me'))return Response.json({principal_id:'p',username:'alice',workspace_id:'default',workspaces:[{workspace_id:'default'},{workspace_id:'selected'}]});
    const url=new URL(String(input));assert.equal(url.searchParams.get('workspace_id'),'selected');
    const body=JSON.parse(String(init?.body));selections.push(body.selection);
    return Response.json({value:{items:[],pending:[],ras_events:[],scope_fingerprint:'s',next_cursor:null}});
  };
  for(const route of ['fleet/trends','fleet/breakdowns','fleet/reliability','dashboard/stats','quality/agents','observe/task-insight','observe/task-stats'])await readCoreAnalytics(new Request('http://localhost/api/'+route+'?workspace_id=selected&agent=all',{headers:{authorization:'Bearer session_'+'A'.repeat(43)}}),{fetcher:fetcher as typeof fetch});
  assert.ok(selections.every(selection=>!('agent'in selection)));
});

test('concurrent pending reads share one preparation; a permanent byte failure does not reparse on every read',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'analytics-controller-'));const file=path.join(directory,'key');fs.writeFileSync(file,'a'.repeat(64),{mode:0o600});
  const previous=process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE;process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=file;
  let preparations=0;let release!:(value:Response)=>void;let boundary='b'.repeat(64);
  const pending=new Promise<Response>(resolve=>{release=resolve;});
  const fetcher=async(input:RequestInfo|URL,init?:RequestInit)=>{
    if(String(input).includes('/auth/me'))return Response.json({principal_id:'worker-test',username:'alice',workspace_id:'w',workspaces:[{workspace_id:'w'}]});
    const body=JSON.parse(String(init?.body));
    if(body.action==='prepare'){preparations++;return pending;}
    return Response.json({value:{items:[],pending:[{trace_id:'large-trace',boundary}],ras_events:[],scope_fingerprint:'s',next_cursor:null}});
  };
  const request=new Request('http://localhost/api/fleet/trends',{headers:{authorization:'Bearer session_'+'A'.repeat(43)}});
  try {
    const results=await Promise.allSettled(Array.from({length:12},()=>readCoreAnalytics(request,{fetcher:fetcher as typeof fetch})));
    assert.ok(results.every(row=>row.status==='rejected'));
    for(let n=0;n<100&&preparations===0;n++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(preparations,1);
    boundary='c'.repeat(64);
    await Promise.allSettled(Array.from({length:8},()=>readCoreAnalytics(request,{fetcher:fetcher as typeof fetch})));
    assert.equal(preparations,1,'a new source revision does not queue duplicate work behind an active preparation');
    release(Response.json({error:'byte budget'},{status:413}));
    await new Promise(resolve=>setTimeout(resolve,10));
    await assert.rejects(()=>readCoreAnalytics(request,{fetcher:fetcher as typeof fetch}),error=>!!error&&typeof error==='object'&&'code'in error&&error.code==='ANALYTICS_INDEXING');
    for(let n=0;n<100&&preparations<2;n++)await new Promise(resolve=>setTimeout(resolve,5));
    await new Promise(resolve=>setTimeout(resolve,10));
    for(let n=0;n<5;n++)await assert.rejects(()=>readCoreAnalytics(request,{fetcher:fetcher as typeof fetch}),error=>!!error&&typeof error==='object'&&'status'in error&&error.status===413);
    assert.equal(preparations,2);
  }finally{if(previous===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE;else process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=previous;fs.rmSync(directory,{recursive:true,force:true});}
});
