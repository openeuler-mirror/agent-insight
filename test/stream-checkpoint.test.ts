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
