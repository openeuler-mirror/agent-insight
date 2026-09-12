import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collaborationEventHash,
  deterministicCollaborationEventId,
  deterministicCollaborationId,
  normalizeCollaborationEvent,
  reportedCollaborationEventSchema,
  type CollaborationEventInput,
} from '@/lib/ingest/collaboration/contracts';
import { findCollaborationLocatorMatches } from '@/lib/ingest/collaboration/resolve';
import {
  goalPlusCollaborationEventIdentity,
  goalPlusCollaborationIdentity,
  goalPlusEndpointHint,
} from '@/lib/ingest/collaboration/providers/goal-plus';

function event(overrides: Partial<CollaborationEventInput> = {}): CollaborationEventInput {
  return {
    collaborationId: 'collab_contract',
    eventId: 'evt_contract',
    fromSessionId: 'session-a',
    toSessionId: 'session-b',
    description: '启动 worker',
    sourceType: 'reported',
    ...overrides,
  };
}

test('collaboration event contract is strict and validates locator shapes', () => {
  assert.equal(reportedCollaborationEventSchema.safeParse(event()).success, false, 'internal sourceType is not accepted externally');
  const external = {
    collaborationId: 'collab_contract',
    eventId: 'evt_contract',
    fromSessionId: 'session-a',
    toSessionId: 'session-b',
    description: '启动 worker',
    observedAt: '2026-09-12T10:00:00+08:00',
    fromLocator: { recordType: 'tool', name: 'spawn_agent' },
  };
  assert.equal(reportedCollaborationEventSchema.safeParse(external).success, true);
  assert.equal(reportedCollaborationEventSchema.safeParse({
    ...external,
    fromLocator: { recordType: 'shell', name: 'bash' },
  }).success, false);
  assert.equal(reportedCollaborationEventSchema.safeParse({ ...external, unexpected: true }).success, false);
  assert.equal(reportedCollaborationEventSchema.safeParse({
    ...external,
    collaborationId: `collab_gp_${'a'.repeat(64)}`,
  }).success, false, 'internal Goal Plus collaboration IDs are reserved');
});

test('collaboration event normalization redacts secrets and local paths before hashing', () => {
  const normalized = normalizeCollaborationEvent(event({
    description: '调用 token=private-value',
    content: '读取 /Users/example/private/file password=hunter2',
  }));
  assert.doesNotMatch(normalized.description, /private-value/);
  assert.doesNotMatch(String(normalized.content), /\/Users\/example|hunter2/);
  assert.equal(collaborationEventHash(event()), collaborationEventHash({ ...event() }));
  assert.notEqual(collaborationEventHash(event()), collaborationEventHash(event({ description: '另一次联系' })));
});

test('Goal Plus collaboration identities are deterministic and source scoped', () => {
  const first = goalPlusCollaborationIdentity('gpsrc-a', 'goal-a');
  assert.deepEqual(first, goalPlusCollaborationIdentity('gpsrc-a', 'goal-a'));
  assert.notEqual(first.collaborationId, goalPlusCollaborationIdentity('gpsrc-b', 'goal-a').collaborationId);
  assert.match(first.collaborationId, /^collab_gp_[a-f0-9]{64}$/);
  assert.match(
    goalPlusCollaborationEventIdentity('gpsrc-a', 'goal-a', 'run-a', 'agent-a', 'candidate-worker'),
    /^evt_gp_[a-f0-9]{64}$/,
  );
  assert.notEqual(
    deterministicCollaborationId('gpsrc-a', 'goal-a'),
    deterministicCollaborationEventId('gpsrc-a', 'goal-a'),
  );
});

test('Goal Plus endpoint projection links only one authoritative candidate', () => {
  assert.deepEqual(goalPlusEndpointHint([], { evidence: 'test' }).state, 'pending');
  const linked = goalPlusEndpointHint([
    { executionId: 'exec-a', linkMethod: 'native_session_id', linkState: 'linked' },
  ], { evidence: 'test' });
  assert.equal(linked.state, 'linked');
  assert.equal(linked.executionId, 'exec-a');
  const ambiguous = goalPlusEndpointHint([
    { executionId: 'exec-a', linkMethod: 'native_session_id', linkState: 'ambiguous' },
    { executionId: 'exec-b', linkMethod: 'native_session_id', linkState: 'ambiguous' },
  ], { evidence: 'test' });
  assert.equal(ambiguous.state, 'ambiguous');
  assert.equal(ambiguous.executionId, undefined);
});

test('locator matching keeps tool and shell candidates separate with trusted timing', () => {
  const interactions = [{
    tool_calls: [
      {
        id: 'spawn-1',
        function: { name: 'spawn_agent', arguments: '{}' },
        timing: { started_at: 10, source: 'execution' },
      },
      {
        id: 'shell-1',
        function: { name: 'bash', arguments: JSON.stringify({ command: 'agent-run --task risk-check' }) },
        timing: { started_at: 20, source: 'derived' },
      },
    ],
  }];
  const tools = findCollaborationLocatorMatches(interactions, { recordType: 'tool', name: 'spawn_agent' });
  assert.deepEqual(tools, [{ recordType: 'tool', recordId: 'spawn-1', startedAt: 10, trustedTime: true }]);
  const shells = findCollaborationLocatorMatches(interactions, {
    recordType: 'shell',
    commandContains: 'risk-check',
  });
  assert.equal(shells.length, 1);
  assert.equal(shells[0].trustedTime, false);
});
