import test from 'node:test';
import assert from 'node:assert/strict';
import {withCoreExperiments} from '@/lib/storage-core/experiments';
import {GET} from '@/app/api/experiments/traces/route';
test('experiment Trace selection reads authorized new facts and retains the old page DTO and filters',async()=>{
 const previous=process.env.AGENT_INSIGHT_TRACE_STORAGE;process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';
 const request=new Request('http://localhost/api/experiments/traces?agent=build&model=selected&search=完整&tagIds=tag&pageSize=1',{headers:{authorization:'Bearer api_'+'T'.repeat(43)}});let reads=0;
 const fetcher:typeof fetch=async(url)=>{
  const parsed=new URL(String(url));if(parsed.pathname==='/v1/auth/me')return Response.json({principal_id:'owner',username:'owner',workspace_id:'w',workspaces:[{workspace_id:'w'}]});
  assert.equal(parsed.pathname,'/v1/compat/observe/data');assert.equal(parsed.searchParams.get('workspace_id'),'w');assert.equal(parsed.searchParams.get('agentName'),'build');assert.equal(parsed.searchParams.get('query'),'完整');assert.equal(parsed.searchParams.get('tagIds'),'tag');assert.equal(parsed.searchParams.get('ownership'),'user');assert.deepEqual(JSON.parse(parsed.searchParams.get('filters')!),[{column:'model',operator:'=',value:'selected'}]);reads++;
  return Response.json({value:[{upload_id:'execution',task_id:'task',query:'完整输入',final_result:'实际输出',latency:12,tokens:15,timestamp:'2026-11-14T00:00:00Z',tool_call_error_count:0,trace_status:'success',model:'selected',skills:['skill'],invoked_skills:[{name:'skill',version:2}]}]});
 };
 try{const response=await withCoreExperiments(request,()=>GET(request),{fetcher});assert.equal(response.status,200);assert.deepEqual(await response.json(),{total:1,page:1,pageSize:1,items:[{id:'execution',taskId:'task',query:'完整输入',finalResult:'实际输出',latency:12,tokens:15,timestamp:'2026-11-14T00:00:00Z',ok:true,model:'selected',skillName:'skill',skillVersion:2}]});assert.equal(reads,1);}
 finally{if(previous===undefined)delete process.env.AGENT_INSIGHT_TRACE_STORAGE;else process.env.AGENT_INSIGHT_TRACE_STORAGE=previous;}
});
