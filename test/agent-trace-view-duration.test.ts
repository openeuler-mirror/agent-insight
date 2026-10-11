import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildAgentCallTree, resolveTraceTimelineBounds } from '@/lib/engine/observability/agent-trace';
import { resolveTraceTimelineDurationMs } from '@/lib/latency-format';

const root = process.cwd();

test('trace timeline duration prefers the tree duration over persisted execution latency', () => {
  assert.equal(resolveTraceTimelineDurationMs(15_000, 24_204), 15_000);
});

test('trace timeline duration falls back to the call-tree duration without a persisted execution latency', () => {
  assert.equal(resolveTraceTimelineDurationMs(17_146, undefined), 17_146);
  assert.equal(resolveTraceTimelineDurationMs(15_000, 0), 15_000);
});

test('trace timeline duration ignores invalid duration candidates', () => {
  assert.equal(resolveTraceTimelineDurationMs(Number.NaN, 24_204), 24_204);
  assert.equal(resolveTraceTimelineDurationMs(0, -1), undefined);
});

test('trace timeline bounds include child and event work beyond the root agent', () => {
  const tree = {
    startedAt: 1_000,
    endedAt: 4_000,
    events: [{ startedAt: 1_500, completedAt: 4_500 }],
    children: [{
      startedAt: 2_500,
      endedAt: 9_000,
      events: [{ startedAt: 2_500, completedAt: 11_000 }],
      children: [],
    }],
  } as any;

  assert.deepEqual(resolveTraceTimelineBounds(tree, 12_000), {
    start: 1_000,
    end: 11_000,
    durationMs: 10_000,
  });
});

test('trace timeline bounds use persisted duration only when an end timestamp is absent', () => {
  assert.deepEqual(resolveTraceTimelineBounds({
    startedAt: 1_000,
    events: [],
    children: [],
  } as any, 2_000), {
    start: 1_000,
    end: 3_000,
    durationMs: 2_000,
  });
  assert.equal(resolveTraceTimelineBounds({ events: [], children: [] } as any, 2_000), null);
  assert.deepEqual(resolveTraceTimelineBounds({
    startedAt: 3_000,
    endedAt: 1_000,
    events: [],
    children: [],
  } as any), {
    start: 3_000,
    end: 3_000,
    durationMs: 0,
  });
});

test('agent tree duration includes a child that outlives its parent', () => {
  const tree = buildAgentCallTree([
    {
      role: 'assistant',
      agent: 'root',
      content: 'delegate',
      timestamp: 1_700_000_000_000,
      timeInfo: { created: 1_700_000_000_000, completed: 1_700_000_001_000 },
      tool_calls: [{
        id: 'task-1',
        function: {
          name: 'task',
          arguments: JSON.stringify({ subagent_type: 'worker', subagent_session_id: 'child-1' }),
        },
      }],
    },
    {
      role: 'subagent',
      agent: 'worker',
      subagent_name: 'worker',
      subagent_session_id: 'child-1',
      content: 'done',
      timestamp: 1_700_000_003_000,
      timeInfo: { created: 1_700_000_003_000, completed: 1_700_000_009_000 },
    },
  ] as any[]);

  assert.equal(tree?.stats.durationMs, 9_000);
  assert.equal(tree?.endedAt, 1_700_000_009_000);
});

test('AgentTraceView keeps omitted RAS markers stable and avoids equivalent state updates', () => {
  const source = fs.readFileSync(path.join(root, 'src/components/observe/AgentTraceView.tsx'), 'utf8');

  assert.match(source, /const EMPTY_RAS_MARKERS: RasTraceMarker\[\] = \[\]/);
  assert.match(source, /rasMarkers = EMPTY_RAS_MARKERS/);
  assert.doesNotMatch(source, /rasMarkers = \[\]/);
  assert.match(source, /sameStringSet\(current, defaultExpandedKeys\) \? current : defaultExpandedKeys/);
});
