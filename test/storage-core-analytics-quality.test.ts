import assert from 'node:assert/strict';
import test from 'node:test';
import {createAnalyticsSource, type AnalyticsSource} from '../src/lib/storage-core/analytics';
import {buildAnalyticsProjection} from '../src/lib/storage-core/analytics-projection';
import {coreQualitySource} from '../src/lib/storage-core/analytics-quality';
import {buildQualityReport} from '../src/lib/engine/quality-monitoring';
import {analyticsRecords} from '../src/lib/storage-core/analytics-records';

function source() {
  const projection=buildAnalyticsProjection({evidence:{snapshot_hash:'a'.repeat(64),execution:{id:'e',taskId:'t',user:'alice',timestamp:'2026-11-15T00:00:00Z',agentName:'A',model:'unknown-price-model',tokens:0,cost:0,latency:0,inputTokens:0,outputTokens:0,toolCallCount:1,toolCallErrorCount:1,llmCallCount:1,failures:'[]'},session:{interactions:[{role:'assistant',tool_calls:[{function:{name:'read'},state:'error',output:'ENOENT not found'}]}]}}});
  const base=createAnalyticsSource('alice',[{trace_id:'trace',boundary:'b',projection}]);
  let validations=0;
  return {...base,actor:{username:'alice'},validate:async()=>{validations++;},enrich:async()=>({trajectories:[{executionId:'e',trajectoryScore:0,dimensionScoresJson:JSON.stringify({completeness:0,toolChoice:0,redundancy:0,attribution:0})}],issues:[{executionId:'e',dedupKey:'issue',severity:'high',summary:'must fix',skillName:'checking',version:1}],diagnoses:[{executionId:'e',report:{rootCause:{criticalModule:'tool',summary:'file missing',confidence:0}}}]}),validations:()=>validations} as unknown as AnalyticsSource & {validations:()=>number};
}
const input={user:'alice',agent:'A',window:'1w' as const,from:new Date('2026-11-14Z'),to:new Date('2026-11-16Z')};

test('Quality consumes current selected zero score, unresolved issue, real error cluster and current diagnosis without legacy reads',async()=>{
  const analytics=source();const data=await coreQualitySource(analytics,input);
  assert.equal(data.collection.traces[0].trajectory?.score,0);
  assert.equal(data.collection.traces[0].trajectory?.dims.redundancy,0);
  assert.equal(data.collection.traces[0].tokens,0);
  assert.equal(data.diagnosesByTrace.get('e')?.confidence,0);
  assert.equal(data.skillIssueRows.length,1);
  const report=await buildQualityReport(input,undefined,data);
  assert.equal(report.meta.n,1);assert.equal(report.problemCounts.errorEvents,1);
  assert.equal(report.diagnosisCoverage.diagnosed,1);
  assert.equal(report.skillDrag[0].name,'checking');
  assert.ok(analytics.validations()>0);
});

test('Quality missing enrichment is an explicit storage error instead of fabricated empty statistics',async()=>{
  const analytics=source();analytics.enrich=async()=>({});
  await assert.rejects(()=>coreQualitySource(analytics,input),error=>!!error&&typeof error==='object'&&'status'in error&&error.status===503);
});

test('Task/Quality execution record adapter retains original zero omission and price-only cost semantics',()=>{
  const records=analyticsRecords(source(),{taskId:'t'});
  assert.equal(records[0].tokens,undefined);assert.equal(records[0].latency,undefined);
  assert.equal(records[0].cost,undefined);assert.equal(records[0].tool_call_error_count,1);
  assert.equal(records[0].input_tokens,0);
});

test('execution-only legacy source can publish statistics without inventing a Session',()=>{
  const value=buildAnalyticsProjection({evidence:{snapshot_hash:'a'.repeat(64),execution:{id:'e',taskId:'t',user:'alice',timestamp:'2026-11-15T00:00:00Z',toolCallCount:0},session:null}});
  assert.equal(value.executions[0].sessionEndTime,null);
  assert.equal(value.collaboration.startTime,null);
});
