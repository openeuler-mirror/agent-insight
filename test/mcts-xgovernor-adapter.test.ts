import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import { aggregateOtelTraceEvents } from '../src/lib/ingest/otel/aggregate';
import { getOtelTraceAdapter } from '../src/lib/ingest/otel/adapter-registry';
import { normalizeOtlpTraces } from '../src/lib/ingest/otel/normalize';
import { findCollaborationLocatorMatches } from '../src/lib/ingest/collaboration/resolve';
import { getAdapter } from '../src/lib/ingest/adapters/registry';

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
      tool: { name: 'file_edit', type: 'xgovernor', arguments: {}, result: 'done' },
      endTimeMs: 1_700_000_000_200,
    }),
    canonical({
      eventId: 'task', spanId: '4'.repeat(16), parentSpanId: agentSpan, kind: 'tool', name: 'tool.task',
      tool: { name: 'task', type: 'subagent', arguments: { session_id: 'runtime.child' }, result: { session_id: 'runtime.child' } },
      attributes: { 'mcts.synthetic': true },
      startTimeMs: 1_700_000_000_350,
      endTimeMs: 1_700_000_000_350,
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
  assert.equal(interactions.some(interaction => interaction.trace_synthetic), true);
  const llmInteraction = interactions.find(interaction => interaction.spanId === llmSpan);
  const calls = llmInteraction?.tool_calls as Array<{ function?: { name?: string } }>;
  assert.equal(calls[0]?.function?.name, 'file_edit');
});
