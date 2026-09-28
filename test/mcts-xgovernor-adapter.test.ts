import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import { aggregateOtelTraceEvents } from '../src/lib/ingest/otel/aggregate';
import { getOtelTraceAdapter } from '../src/lib/ingest/otel/adapter-registry';
import { normalizeOtlpTraces } from '../src/lib/ingest/otel/normalize';
import { findCollaborationLocatorMatches } from '../src/lib/ingest/collaboration/resolve';
import { getAdapter } from '../src/lib/ingest/adapters/registry';
import { buildAgentCallTree } from '../src/lib/engine/observability/agent-trace';

const require = createRequire(import.meta.url);
const { canonicalEventsToOtlp } = require('../scripts/agent-trace-collectors/shared/trace-transport.cjs');

function canonical(overrides: Record<string, unknown>) {
  return {
    framework: 'mcts-xgovernor',
    sessionId: 'mcts-runtime-session',
    traceId: 'a'.repeat(32),
    status: 'success',
    startTimeMs: 1_700_000_000_000,
    endTimeMs: 1_700_000_000_010,
    ...overrides,
  };
}

test('MCTS xGovernor adapter renders LLM, tool and exact task anchor records', () => {
  const agentSpan = '1'.repeat(16);
  const llmSpan = '2'.repeat(16);
  const taskSpan = '4'.repeat(16);
  const events = normalizeOtlpTraces(canonicalEventsToOtlp([
    canonical({
      eventId: 'agent', spanId: agentSpan, kind: 'agent', name: 'agent.mcts.runtime',
      attributes: { 'mcts.role': 'solver-child', 'agent.insight.trace.completed': true },
      endTimeMs: 1_700_000_000_500,
    }),
    canonical({
      eventId: 'llm', spanId: llmSpan, parentSpanId: agentSpan, kind: 'llm', name: 'llm.xgovernor.turn',
      input: 'repair bug', output: 'fixed', model: 'model-a',
      usage: { input: 10, output: 4, reasoning: 2, total: 16 },
      endTimeMs: 1_700_000_000_300,
    }),
    canonical({
      eventId: 'tool', spanId: '3'.repeat(16), parentSpanId: llmSpan, kind: 'tool', name: 'tool.file_edit',
      tool: { name: 'file_edit', type: 'xgovernor', arguments: { path: 'README.md' }, result: 'done' },
      endTimeMs: 1_700_000_000_200,
    }),
    canonical({
      eventId: 'task-unknown', spanId: taskSpan, parentSpanId: agentSpan, kind: 'tool', name: 'tool.task',
      tool: { name: 'task', type: 'subagent', arguments: { session_id: 'runtime.child', subagent_type: 'unknown' }, result: { session_id: 'runtime.child' } },
      attributes: { 'mcts.synthetic': true },
      startTimeMs: 1_700_000_000_350,
      endTimeMs: 1_700_000_000_350,
    }),
    canonical({
      eventId: 'task-confirmed', spanId: taskSpan, parentSpanId: agentSpan, kind: 'tool', name: 'tool.task',
      tool: { name: 'task', type: 'subagent', arguments: { session_id: 'runtime.child', subagent_type: 'solver-child' }, result: { session_id: 'runtime.child' } },
      attributes: { 'mcts.synthetic': true },
      startTimeMs: 1_700_000_000_350,
      endTimeMs: 1_700_000_000_350,
    }),
    canonical({
      eventId: 'summary', spanId: '5'.repeat(16), parentSpanId: agentSpan, kind: 'tool', name: 'mcts.summary.node-score',
      tool: { name: 'mcts.summary.node-score', type: 'stdout-summary', arguments: {}, result: {} },
      attributes: { 'mcts.role': 'unknown', 'mcts.summary.unbound': true },
      startTimeMs: 1_700_000_000_450,
      endTimeMs: 1_700_000_000_450,
    }),
  ], { framework: 'mcts-xgovernor' }), { authenticatedUser: 'alice' });

  assert.equal(getOtelTraceAdapter(events)?.id, 'mcts-xgovernor');
  assert.equal(getAdapter('mcts-xgovernor').descriptor.label, 'MCTS xGovernor');
  const record = aggregateOtelTraceEvents('mcts-runtime-session', events);
  assert.ok(record);
  assert.equal(record.framework, 'mcts-xgovernor');
  assert.equal(record.agentType, 'solver-child');
  assert.equal(record.tokens, 16);
  assert.equal(record.final_result, 'fixed');
  assert.equal(record.session_merge_strategy, 'snapshot-replace');
  const taskMatches = findCollaborationLocatorMatches(record.interactions, { recordType: 'tool', name: 'task' });
  assert.equal(taskMatches.length, 1);
  assert.equal(taskMatches[0].trustedTime, true);
  const interactions = record.interactions as Array<Record<string, unknown>>;
  const taskInteraction = interactions.find(interaction => (
    (interaction.tool_calls as Array<{ id?: string }> | undefined)?.[0]?.id === taskSpan
  ));
  const taskArguments = (taskInteraction?.tool_calls as Array<{ function?: { arguments?: string } }>)[0]?.function?.arguments;
  assert.equal(JSON.parse(taskArguments || '{}').subagent_type, 'solver-child');
  assert.equal(interactions.some(interaction => interaction.trace_synthetic), true);
  const summaryInteraction = interactions.find(interaction => (
    (interaction.tool_calls as Array<{ function?: { name?: string } }> | undefined)?.[0]?.function?.name
      === 'mcts.summary.node-score'
  ));
  assert.equal(summaryInteraction?.trace_synthetic, true);
  const tree = buildAgentCallTree(record.interactions);
  assert.ok(tree);
  assert.equal(tree.events.filter(event => event.kind === 'llm').length, 1);
  assert.equal(tree.events.some(event => event.name === 'mcts.summary.node-score'), true);
  const llmInteraction = interactions.find(interaction => interaction.spanId === llmSpan);
  const calls = llmInteraction?.tool_calls as Array<{ function?: { name?: string; arguments?: string } }>;
  assert.equal(calls[0]?.function?.name, 'file_edit');
  assert.deepEqual(JSON.parse(calls[0]?.function?.arguments || '{}'), { path: 'README.md' });
});

test('MCTS xGovernor adapter keeps unknown only when no confirmed role exists', () => {
  const events = normalizeOtlpTraces(canonicalEventsToOtlp([
    canonical({
      eventId: 'agent', spanId: '6'.repeat(16), kind: 'agent', name: 'agent.mcts.runtime',
      attributes: { 'mcts.role': 'unknown', 'agent.insight.trace.completed': true },
    }),
  ], { framework: 'mcts-xgovernor' }), { authenticatedUser: 'alice' });
  const record = aggregateOtelTraceEvents('mcts-runtime-session', events);
  assert.equal(record?.agentType, 'unknown');
  assert.equal(record?.agentName, 'mcts-unknown');
});
