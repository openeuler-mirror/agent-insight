import assert from 'node:assert/strict';
import test from 'node:test';
import {createAnalyticsSource,readCoreAnalytics} from '../src/lib/storage-core/analytics';
import {buildAnalyticsProjection} from '../src/lib/storage-core/analytics-projection';
import type {CoreOutcomeLookup} from '../src/lib/storage-core/trace-outcome-projection';

function fixture(){
 const projection=buildAnalyticsProjection({evidence:{snapshot_hash:'a'.repeat(64),execution:{id:'execution',taskId:'task',timestamp:'2026-11-15T00:00:00Z',user:'alice',isAnswerCorrect:true},session:{interactions:[]}}});
 const selected:CoreOutcomeLookup={outcome:{value:{version:1,source_snapshot_hash:'b'.repeat(64),answer_score:0,is_answer_correct:false,judgment_reason:'actual zero',failures:[{failure_type:'actual'}],skill_issues:[]},experiment_id:'outcome',run_id:'run',machine_result_id:'machine',content_hash:'c'.repeat(64),generation:1,source:{trace_id:'trace',incarnation:'1',route_epoch:'1',execution_id:'execution',snapshot_hash:'b'.repeat(64),plan_hash:'d'.repeat(64)}},is_evaluating:false,run_id:'run',experiment_id:'outcome',selection_hash:'e'.repeat(64)};
 return{items:[{trace_id:'trace',boundary:'boundary',projection}],selected};
}
test('statistics use the selected real Outcome without changing the immutable source projection',()=>{
 const {items,selected}=fixture();const source=createAnalyticsSource('alice',items,[],{trace:selected});
 assert.equal(source.rows[0].isAnswerCorrect,false);assert.equal(source.rows[0].failures,JSON.stringify(selected.outcome!.value.failures));
 assert.equal(items[0].projection.executions[0].isAnswerCorrect,true);assert.equal(source.currentOutcome('execution')?.outcome?.value.answer_score,0);assert.equal(source.currentOutcome('unknown'),null);
});
test('query answer reset preserves the separately recorded trigger rate',()=>{
 const {items,selected}=fixture();items[0].projection.executions[0].skillTriggerRate=1;
 selected.answer_reset={version:1,through_generation:1,annotation_revision:'1',content_hash:'f'.repeat(64)};
 const source=createAnalyticsSource('alice',items,[],{trace:selected});assert.equal(source.rows[0].isAnswerCorrect,false);assert.equal(source.rows[0].skillTriggerRate,1);
});
test('statistics use the sealed routing projection of a query edit',()=>{
 const {items,selected}=fixture();items[0].projection.executions[0].skillTriggerRate=1;
 selected.answer_reset={version:1,through_generation:1,annotation_revision:'1',content_hash:'f'.repeat(64),query_projection:{is_skill_correct:false,skill_trigger_rate:0,routing_evaluation:{},outcome_evaluation:{}}} as CoreOutcomeLookup['answer_reset'];
 const source=createAnalyticsSource('alice',items,[],{trace:selected});assert.equal(source.rows[0].skillTriggerRate,0);assert.equal(items[0].projection.executions[0].skillTriggerRate,1);
});
test('analytics reads carry and finally validate current Outcome selections',async()=>{
 process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';const {items,selected}=fixture();const actions:string[]=[];
 const fetcher=async(url:RequestInfo|URL,init?:RequestInit)=>{
  if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json({principal_id:'alice',username:'alice',workspace_id:'w',workspaces:[{workspace_id:'w'}]});
  const body=JSON.parse(String(init?.body));actions.push(body.action);
  if(body.action==='read')return Response.json({value:{items,pending:[],next_cursor:null,scope_fingerprint:'scope',outcomes:{trace:selected},outcome_read_token:'signed-current'}});
  if(body.action==='validate_outcomes')assert.deepEqual(body.read_tokens,['signed-current']);
  return Response.json({value:{scope_fingerprint:'scope'}});
 };
 const source=await readCoreAnalytics(new Request('http://localhost/api/dashboard/stats',{headers:{authorization:'Bearer api_'+'A'.repeat(43)}}),{fetcher:fetcher as typeof fetch});
 assert.equal(source.rows[0].isAnswerCorrect,false);await source.validate();assert.equal(actions.filter(action=>action==='validate_outcomes').length,2);
});
test('a nonempty analytics page cannot silently omit its Outcome read coverage',async()=>{
 process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';const {items}=fixture();
 const fetcher=async(url:RequestInfo|URL)=>new URL(String(url)).pathname==='/v1/auth/me'?Response.json({principal_id:'alice',username:'alice',workspace_id:'w',workspaces:[{workspace_id:'w'}]}):Response.json({value:{items,pending:[],scope_fingerprint:'scope'}});
 await assert.rejects(readCoreAnalytics(new Request('http://localhost/api/dashboard/stats',{headers:{authorization:'Bearer api_'+'A'.repeat(43)}}),{fetcher:fetcher as typeof fetch}),/Outcome/);
});
