/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
          models: [
            { id: 'csi-provider/deepseek-v4-flash', label: 'DeepSeek-V4-Flash', providerID: 'csi-provider' },
            { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek-V4-Flash', providerID: 'deepseek' },
          ],
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
        { id: 'csi-provider/deepseek-v4-flash', label: 'DeepSeek-V4-Flash · csi-provider' },
        { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek-V4-Flash · deepseek' },
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
        { id: 'csi-provider/deepseek-v4-flash', label: 'DeepSeek-V4-Flash · csi-provider' },
        { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek-V4-Flash · deepseek' },
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
