import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  DurableCollaborationOutbox,
  goalPlusMainBinding,
  goalPlusWorkerRelationship,
} = require('../scripts/agent-trace-collectors/shared/collaboration-transport.cjs');

test('Goal Plus main and worker collectors derive the same stable collaboration identity', () => {
  const main = goalPlusMainBinding('pi-native-main', 'gp_0001', 'pi-native-main__task4');
  const worker = goalPlusWorkerRelationship('pi-native-main', 'gp_0001', {
    runId: 'run_0001',
    agentSessionId: 'agent_0001_01',
    candidateId: 'candidate_001',
    canonicalSessionId: 'goal-plus:gpsrc_123:agent_0001_01',
  });
  assert.equal(worker.binding.collaborationId, main.collaborationId);
  assert.equal(main.sessionId, 'main');
  assert.equal(worker.event.fromSessionId, 'main');
  assert.equal(worker.event.toSessionId, worker.binding.sessionId);
  assert.deepEqual(worker.event.fromLocator, { recordType: 'tool', name: 'goal_plus_session_run' });
  assert.equal('observedAt' in worker.event, false);
});

test('collaboration outbox retries transient failures and quarantines deterministic conflicts', async t => {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'collaboration-outbox-'));
  t.after(() => fsp.rm(homeDir, { recursive: true, force: true }));
  let now = 1_700_000_000_000;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const statuses = [503, 201, 409];
  const outbox = new DurableCollaborationOutbox({
    framework: 'goal-plus',
    apiKey: 'test-key',
    homeDir,
    sessionsEndpoint: 'http://example.invalid/api/ingest/collaborations/sessions',
    eventsEndpoint: 'http://example.invalid/api/ingest/collaborations/events',
    now: () => now,
    retry: { baseMs: 1, maxMs: 1, jitter: 0 },
    fetch: async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      const status = statuses.shift() || 500;
      return { status, async text() { return status === 409 ? 'immutable conflict' : ''; } };
    },
  });
  const session = goalPlusMainBinding('pi-main', 'gp_demo', 'pi-main__task0');
  await outbox.enqueueSession(session);
  assert.deepEqual(await outbox.flushOnce(), {
    acquired: true, uploaded: 0, retried: 1, rejected: 0, deferred: 0,
  });
  assert.equal((await outbox.status()).pending, 1);
  now += 2;
  assert.equal((await outbox.flushOnce()).uploaded, 1);
  assert.deepEqual(await outbox.status(), { pending: 0, rejected: 0, delivered: 1 });

  const relationship = goalPlusWorkerRelationship('pi-main', 'gp_demo', {
    runId: 'run_demo',
    agentSessionId: 'agent_demo',
    candidateId: 'candidate_demo',
    canonicalSessionId: 'goal-plus:source:agent_demo',
  });
  await outbox.enqueueEvent(relationship.event);
  assert.equal((await outbox.flushOnce()).rejected, 1);
  assert.deepEqual(await outbox.status(), { pending: 0, rejected: 1, delivered: 1 });
  assert.equal(calls[0].url.endsWith('/sessions'), true);
  assert.equal(calls[2].url.endsWith('/events'), true);
  assert.deepEqual(calls[0].body, session);
});
