import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAgentCallTree } from '@/lib/engine/observability/agent-trace';
import {
  buildDirectEvaluatorExecutionRecord,
  buildDirectEvaluatorInteractions,
  inferCompletionTimestampFromInteractions,
  shouldForceOpencodeEvalTransport,
} from '@/lib/engine/evaluation/evaluator-execution-recorder';

const TS = '2026-06-10T00:00:00.000Z';
const COMPLETED_TS = '2026-06-10T00:00:03.000Z';

test('synthesizes user + assistant interactions for a single-shot LLM judge', () => {
  const interactions = buildDirectEvaluatorInteractions({
    agentName: 'trace-quality-evaluator',
    query: 'case-input-short',
    userMessage: '# Key Action Trace Analysis Input\n{...big payload...}',
    assistantOutput: '{"dimension_scores":{"tool_choice":0.8,"redundancy":0.6}}',
    usage: { input: 1200, output: 300 },
    modelID: 'deepseek-chat',
    timestampISO: TS,
  });

  assert.equal(interactions.length, 2);
  assert.equal(interactions[0]?.role, 'user');
  // user content prefers the real prompt (userMessage), not the short display query
  assert.match(interactions[0]?.content ?? '', /Key Action Trace Analysis Input/);
  assert.equal(interactions[1]?.role, 'assistant');
  assert.equal(interactions[1]?.agent, 'trace-quality-evaluator');
  assert.equal(interactions[1]?.modelID, 'deepseek-chat');
  // total is derived from input+output when not supplied
  assert.equal(interactions[1]?.usage?.total, 1500);
});

test('records the system rubric as the first interaction (parity with opencode trace)', () => {
  const interactions = buildDirectEvaluatorInteractions({
    agentName: 'task-completion-evaluator',
    systemPrompt: '你是「Agent 任务完成度」评估器。只输出严格 JSON。',
    query: 'case-input-short',
    userMessage: '# 任务完成度评测输入\n{...}',
    assistantOutput: '{"score":0.9,"is_correct":true,"key_point_findings":[]}',
    usage: { input: 2000, output: 400 },
    timestampISO: TS,
  });

  // system rubric must be recorded (was dropped before — observability bug) and come first
  assert.equal(interactions.length, 3);
  assert.equal(interactions[0]?.role, 'system');
  assert.match(interactions[0]?.content ?? '', /评估器/);
  assert.equal(interactions[1]?.role, 'user');
  assert.equal(interactions[2]?.role, 'assistant');

  // the extra system message must NOT be miscounted as an LLM call
  const tree = buildAgentCallTree(
    interactions as unknown as Parameters<typeof buildAgentCallTree>[0],
  );
  assert.equal(tree?.stats.llmCalls, 1);
  assert.equal(tree?.stats.toolCalls, 0);
});

test('renders as a 1-LLM-call / 0-tool-call trace (matches what a judge actually is)', () => {
  const interactions = buildDirectEvaluatorInteractions({
    agentName: 'task-completion-evaluator',
    userMessage: 'judge this',
    assistantOutput: '{"score":0.9,"is_correct":true,"key_point_findings":[]}',
    usage: { input: 10, output: 5, total: 15 },
    timestampISO: TS,
  });

  const tree = buildAgentCallTree(
    interactions as unknown as Parameters<typeof buildAgentCallTree>[0],
  );
  assert.ok(tree);
  assert.equal(tree?.stats.llmCalls, 1);
  assert.equal(tree?.stats.toolCalls, 0);
});

test('uses one model invocation window for root trace and LLM duration', () => {
  const interactions = buildDirectEvaluatorInteractions({
    agentName: 'task-completion-evaluator',
    systemPrompt: 'judge',
    userMessage: 'task',
    assistantOutput: '{"score":0.9}',
    startedAtISO: TS,
    completedAtISO: COMPLETED_TS,
  });

  assert.equal(interactions[0]?.timestamp, TS);
  assert.equal(interactions[2]?.timestamp, TS);
  assert.deepEqual(interactions[2]?.timeInfo, {
    created: TS,
    completed: COMPLETED_TS,
  });

  const tree = buildAgentCallTree(
    interactions as unknown as Parameters<typeof buildAgentCallTree>[0],
  );
  const llmEvent = tree?.events.find(event => event.kind === 'llm');
  assert.equal(tree?.stats.durationMs, 3000);
  assert.equal((llmEvent?.completedAt ?? 0) - (llmEvent?.startedAt ?? 0), 3000);
  assert.equal(inferCompletionTimestampFromInteractions(interactions).toISOString(), COMPLETED_TS);
});

test('persists the invocation window as Execution and Session lifecycle fields', () => {
  const record = buildDirectEvaluatorExecutionRecord({
    taskId: 'task-completion-evaluator-test',
    agentName: 'task-completion-evaluator',
    userMessage: 'task',
    assistantOutput: '{"score":0.9}',
    startedAtISO: TS,
    completedAtISO: COMPLETED_TS,
  });

  assert.ok(record);
  assert.equal(record.latency, 3);
  assert.equal(new Date(record.timestamp!).toISOString(), TS);
  assert.equal(new Date(record.trace_started_at!).toISOString(), TS);
  assert.equal(new Date(record.trace_completed_at!).toISOString(), COMPLETED_TS);
});

test('clamps an invalid completion time to the invocation start', () => {
  const interactions = buildDirectEvaluatorInteractions({
    agentName: 'trace-quality-evaluator',
    userMessage: 'task',
    assistantOutput: '{}',
    startedAtISO: COMPLETED_TS,
    completedAtISO: TS,
  });

  assert.deepEqual(interactions[1]?.timeInfo, {
    created: COMPLETED_TS,
    completed: COMPLETED_TS,
  });
  const tree = buildAgentCallTree(
    interactions as unknown as Parameters<typeof buildAgentCallTree>[0],
  );
  assert.equal(tree?.stats.durationMs, 0);
});

test('explicit usage.total wins over input+output sum', () => {
  const interactions = buildDirectEvaluatorInteractions({
    agentName: 'trace-quality-evaluator',
    userMessage: 'u',
    assistantOutput: 'a',
    usage: { input: 100, output: 50, total: 999 },
    timestampISO: TS,
  });
  assert.equal(interactions[1]?.usage?.total, 999);
});

test('infers direct evaluator completion from the latest interaction timestamp', () => {
  const completedAt = inferCompletionTimestampFromInteractions([
    {
      role: 'user',
      timestamp: '2026-06-10T00:00:00.000Z',
    },
    {
      role: 'assistant',
      timestamp: '2026-06-10T00:00:01.000Z',
      timeInfo: {
        created: '2026-06-10T00:00:01.000Z',
        completed: '2026-06-10T00:00:03.000Z',
      },
    },
  ]);

  assert.equal(completedAt.toISOString(), '2026-06-10T00:00:03.000Z');
});

test('falls back to display query when userMessage is absent; drops empty content', () => {
  const onlyUser = buildDirectEvaluatorInteractions({
    agentName: 'trace-quality-evaluator',
    query: 'just the case input',
    assistantOutput: '',
    timestampISO: TS,
  });
  assert.equal(onlyUser.length, 1);
  assert.equal(onlyUser[0]?.role, 'user');
  assert.equal(onlyUser[0]?.content, 'just the case input');

  const empty = buildDirectEvaluatorInteractions({
    agentName: 'trace-quality-evaluator',
    timestampISO: TS,
  });
  assert.deepEqual(empty, []);
});

test('transport flag defaults to direct LLM, opt back into opencode with env=1', () => {
  const prev = process.env.EVAL_FORCE_OPENCODE_TRANSPORT;
  delete process.env.EVAL_FORCE_OPENCODE_TRANSPORT;
  assert.equal(shouldForceOpencodeEvalTransport(), false);
  process.env.EVAL_FORCE_OPENCODE_TRANSPORT = '1';
  assert.equal(shouldForceOpencodeEvalTransport(), true);
  if (prev === undefined) delete process.env.EVAL_FORCE_OPENCODE_TRANSPORT;
  else process.env.EVAL_FORCE_OPENCODE_TRANSPORT = prev;
});
