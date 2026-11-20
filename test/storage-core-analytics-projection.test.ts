import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAnalyticsProjection } from '../src/lib/storage-core/analytics-projection';
import { computeCallStats } from '../src/lib/fleet/call-stats';
import { buildFaultPathSteps } from '../src/lib/engine/observability/fault-path';
import { clusterErrorSteps, buildProblemSummary } from '../src/lib/engine/quality-monitoring/problem-summary';

const interactions = [{role: 'assistant', model: 'm', timeInfo: {created: 1000, completed: 3000}, tool_calls: [{id: 't1', function: {name: 'read', arguments: '{}'}, state: 'error', output: 'ENOENT file not found', duration_ms: 12}]}];
const evidence = (extra: Record<string, unknown> = {}) => ({snapshot_hash: 'a'.repeat(64), execution: {id: 'exec', taskId: 'task', user: 'alice', timestamp: '2026-11-15T01:00:00Z', model: 'm', agentName: 'A', tokens: 0, cost: 0, latency: 1200, toolCallCount: 1, toolCallErrorCount: 1, llmCallCount: 1, failures: '[]', ...extra}, session: {startTime: '2026-11-15T01:00:00Z', interactions}});

test('analytics projection retains real zero/nulls and existing call statistics without full bodies', () => {
  const value = buildAnalyticsProjection({evidence: evidence({isAnswerCorrect: false, inputTokens: null})});
  const row = value.executions[0];
  assert.equal(row.tokens, 0); assert.equal(row.cost, 0); assert.equal(row.inputTokens, null);
  assert.equal(row.isAnswerCorrect, false); assert.equal(row.latency, 1200); assert.equal(row.latencyMs, 1200);
  assert.deepEqual(JSON.parse(row.callStats!), computeCallStats(interactions, {fallbackModel: 'm', failures: '[]'}));
  assert.equal(JSON.stringify(value).includes('ENOENT file not found'), false);
  for (const key of ['interactions', 'finalResult', 'requestMessages', 'rawOutput']) assert.equal(key in row, false);
});

test('structured error projection preserves original classifier and problem aggregation', () => {
  const value = buildAnalyticsProjection({evidence: evidence()});
  const old = clusterErrorSteps([{executionId: 'exec', steps: buildFaultPathSteps(interactions, 'zh')}]);
  assert.deepEqual(value.errors[0].clusters, old.clusters.map(cluster => ({key:cluster.key,node:cluster.node,errorCode:cluster.errorCode,object:cluster.object,count:cluster.count,attribution:cluster.attribution})));
  const traces = [{executionId: 'exec', taskId: 'task', ts: '2026-11-15T01:00:00Z', toolCallErrorCount: 1}];
  const before = buildProblemSummary({traces, interactionsByTrace: new Map([['task', interactions]])});
  const after = buildProblemSummary({traces, structuredErrors: value.errors});
  assert.deepEqual(after, before);
});

test('projection keeps original serialized callStats and ExecutionSkill multiplicity', () => {
  const callStats = JSON.stringify(computeCallStats([]));
  const value = buildAnalyticsProjection({evidence: evidence({callStats, executionSkills: [{skillName: 's', version: 1}, {skillName: 's', version: 2}], failures: null})});
  assert.equal(value.executions[0].callStats, callStats);
  assert.equal(value.executions[0].executionSkills.length, 2);
  assert.equal(value.executions[0].failures, null);
});

test('10001 interactions retain existing callStats truncation declaration', () => {
  const input = evidence(); input.session.interactions = Array.from({length: 10001}, () => ({role: 'user'})) as typeof interactions;
  const value = buildAnalyticsProjection({evidence: input});
  assert.equal(JSON.parse(value.executions[0].callStats!).steps, 10001);
  assert.equal(JSON.parse(value.executions[0].callStats!).truncated, true);
});

test('native summary keeps real model, agents, Skill bindings and zero tool errors without replacing explicit nulls', () => {
  const raw=evidence();delete (raw.execution as Record<string,unknown>).model;delete (raw.execution as Record<string,unknown>).toolCallErrorCount;
  const summary={attributes_json:JSON.stringify({model:'native-model',agents:['A','B'],invoked_skills:[{name:'s',version:0}],tool_error_count:0})};
  const value=buildAnalyticsProjection({evidence:raw,summary});
  assert.equal(value.executions[0].model,'native-model');assert.equal(value.executions[0].toolCallErrorCount,0);
  assert.deepEqual(JSON.parse(value.executions[0].observedAgents!),['A','B']);
  assert.deepEqual(value.executions[0].executionSkills,[{skillName:'s',version:0}]);
  raw.execution.model=null as unknown as string;raw.execution.toolCallErrorCount=null as unknown as number;
  const unknown=buildAnalyticsProjection({evidence:raw,summary});
  assert.equal(unknown.executions[0].model,null);assert.equal(unknown.executions[0].toolCallErrorCount,null);
});

test('virtual child executions and Session collaboration summaries retain direct parent and original subtree multiplicity', () => {
  const raw=evidence();raw.session.interactions=[
    {role:'assistant',agent:'A',content:'coordinator',timestamp:1000,tool_calls:[{id:'s1',function:{name:'task',arguments:JSON.stringify({subagent_type:'B',subagent_session_id:'b'})}}]},
    {role:'subagent',agent:'B',subagent_name:'B',subagent_session_id:'b',content:'dispatch',timestamp:2000,tool_calls:[{id:'s2',function:{name:'task',arguments:JSON.stringify({subagent_type:'C',subagent_session_id:'c'})}}]},
    {role:'subagent',agent:'C',subagent_name:'C',subagent_session_id:'c',content:'done',timestamp:3000},
  ] as unknown as typeof interactions;
  const projection=buildAnalyticsProjection({evidence:raw});
  const b=projection.executions.find(row=>row.taskId==='b');const c=projection.executions.find(row=>row.taskId==='c');
  assert.ok(b&&c);assert.equal(c.parentExecutionId,b.id);assert.equal(c.rootExecutionId,'exec');
  assert.equal(projection.collaboration.children?.length,2);
  const bc=[...projection.collaboration.edges,...projection.collaboration.children!.flatMap(row=>row.edges)].filter(edge=>edge[0]==='B'&&edge[1]==='C');
  assert.equal(bc.length,2);
});

test('analytics skips repeated LLM history while preserving error classification and detail defaults', () => {
  const turns = [
    {role: 'user', content: 'initial request'},
    {role: 'assistant', model: 'm', content: 'first response'},
    ...interactions,
  ];
  const full = buildFaultPathSteps(turns, 'zh');
  const compact = buildFaultPathSteps(turns, 'zh', {includeLlmHistory: false});
  assert.ok(full.some(step => step.kind === 'llm' && step.rawInput?.includes('first response')));
  assert.ok(compact.filter(step => step.kind === 'llm').every(step => step.rawInput === undefined));
  assert.deepEqual(compact.map(({rawInput, ...step}) => step), full.map(({rawInput, ...step}) => step));
  assert.deepEqual(clusterErrorSteps([{executionId: 'exec', steps: compact}]), clusterErrorSteps([{executionId: 'exec', steps: full}]));
});

test('analytics processes 21000 LLM outputs without retaining quadratic conversation history', () => {
  const raw = evidence();
  raw.session.interactions = Array.from({length: 21000}, (_, index) => ({
    role: 'assistant', model: 'm', content: `output ${index} ` + 'x'.repeat(1024),
    timeInfo: {created: 1000 + index, completed: 1001 + index},
  })) as unknown as typeof interactions;
  const result = buildAnalyticsProjection({evidence: raw});
  assert.equal(result.executions.length, 1);
  assert.deepEqual(result.errors[0].clusters, []);
  assert.ok(JSON.stringify(result).length < 10000);
});
