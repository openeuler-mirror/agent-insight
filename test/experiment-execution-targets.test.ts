import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executionTargetsFromWorker,
  runCanBeClaimedByWorker,
} from '@/lib/fault-injection/worker-protocol';

test('client inventory expands into per-host executable Agent targets', () => {
  const targets = executionTargetsFromWorker({
    workerId: 'worker-a',
    hostname: 'host-a',
    lastSeenAt: new Date('2026-08-13T01:00:00.000Z'),
    inventoryJson: JSON.stringify({
      reportedIp: '10.20.3.11',
      platforms: {
        opencode: {
          ready: true,
          agents: [{ id: 'build', label: 'Build' }, { name: 'reviewer' }],
          models: [{ id: 'openai/gpt-5', label: 'GPT-5' }],
        },
        xiaoo: {
          ready: false,
          agents: [{ id: 'ignored' }],
          models: [],
        },
      },
    }),
  });

  assert.deepEqual(targets, [
    {
      workerId: 'worker-a',
      host: '10.20.3.11',
      hostname: 'host-a',
      platform: 'opencode',
      agent: 'build',
      agentLabel: 'Build',
      models: [
        { id: '', label: '平台默认' },
        { id: 'openai/gpt-5', label: 'GPT-5' },
      ],
      lastSeenAt: '2026-08-13T01:00:00.000Z',
    },
    {
      workerId: 'worker-a',
      host: '10.20.3.11',
      hostname: 'host-a',
      platform: 'opencode',
      agent: 'reviewer',
      agentLabel: 'reviewer',
      models: [
        { id: '', label: '平台默认' },
        { id: 'openai/gpt-5', label: 'GPT-5' },
      ],
      lastSeenAt: '2026-08-13T01:00:00.000Z',
    },
  ]);
});

test('targeted generated runs can only be claimed by the selected client', () => {
  const targeted = JSON.stringify({ targetWorkerId: 'worker-b' });
  assert.equal(runCanBeClaimedByWorker(targeted, 'worker-a'), false);
  assert.equal(runCanBeClaimedByWorker(targeted, 'worker-b'), true);
  assert.equal(runCanBeClaimedByWorker('{}', 'worker-a'), true);
  assert.equal(runCanBeClaimedByWorker('malformed', 'worker-a'), true);
});
