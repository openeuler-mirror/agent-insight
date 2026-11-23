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
import { waitForExperimentTasksTerminal } from '@/lib/client/experiment-eval-polling';

test('评测轮询会等待全部目标 Trace 进入终态', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return Response.json({
      results: calls === 1
        ? [
            { taskId: 'trace-1', status: 'done' },
            { taskId: 'trace-2', status: 'running' },
          ]
        : [
            { taskId: 'trace-1', status: 'done' },
            { taskId: 'trace-2', status: 'failed' },
          ],
    });
  };

  await waitForExperimentTasksTerminal({
    user: 'poll-test',
    experimentId: 'experiment-1',
    taskIds: ['trace-1', 'trace-2'],
    pollIntervalMs: 1,
    maxWaitMs: 500,
    fetcher,
  });

  assert.equal(calls, 2);
});

test('评测轮询在切换上下文后可取消', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    waitForExperimentTasksTerminal({
      user: 'poll-test',
      experimentId: 'experiment-1',
      taskIds: ['trace-1'],
      signal: controller.signal,
      fetcher: async () => Response.json({ results: [] }),
    }),
    /已取消/,
  );
});

test('单次状态请求挂起时仍受轮询总时限约束', async () => {
  const startedAt = Date.now();
  const fetcher = async (_url: string, options?: RequestInit): Promise<Response> => (
    new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })
  );

  await assert.rejects(
    waitForExperimentTasksTerminal({
      user: 'poll-test',
      experimentId: 'experiment-1',
      taskIds: ['trace-1'],
      maxWaitMs: 30,
      requestTimeoutMs: 10,
      fetcher,
    }),
    /等待超时/,
  );
  assert.ok(Date.now() - startedAt < 200);
});
