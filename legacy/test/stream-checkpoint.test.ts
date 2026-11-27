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

import { createStreamCheckpointWriter } from '../src/lib/chat/stream-checkpoint';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('checkpoint 在时间窗内合并事件，只保存最新快照', async () => {
  let value = 0;
  const persisted: number[] = [];
  const writer = createStreamCheckpointWriter({
    capture: () => value,
    persist: async (snapshot) => { persisted.push(snapshot); },
    intervalMs: 10,
  });

  value = 1;
  writer.schedule();
  value = 2;
  writer.schedule();
  await wait(25);
  writer.cancel();

  assert.deepEqual(persisted, [2]);
});

test('最终 flush 串行排在在途写入后面，不会被旧快照覆盖', async () => {
  let value = 1;
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const persisted: number[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const writer = createStreamCheckpointWriter({
    capture: () => value,
    persist: async (snapshot) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      if (snapshot === 1) await firstBlocked;
      persisted.push(snapshot);
      concurrent -= 1;
    },
    intervalMs: 0,
  });

  writer.schedule();
  await wait(5);
  value = 2;
  const flushing = writer.flush();
  releaseFirst();
  await flushing;

  assert.deepEqual(persisted, [1, 2]);
  assert.equal(maxConcurrent, 1);
});
