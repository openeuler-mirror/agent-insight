import assert from 'node:assert/strict';
import test from 'node:test';

import { createBlockMirror } from '../src/lib/chat/block-mirror';
import { resolveProcessState, settleProcessBlocks } from '../src/lib/chat/process-block-state';

function mirror() {
  return createBlockMirror(
    { enqueue() {} } as unknown as ReadableStreamDefaultController,
    new TextEncoder(),
  );
}

test('成功终态收口未结束的思考和工具，并保留已有错误', () => {
  const blocks = settleProcessBlocks([
    { kind: 'thinking', id: 'thinking', done: false },
    { kind: 'tool', id: 'running', status: 'running' },
    { kind: 'tool', id: 'failed', status: 'error' },
  ], 'complete');

  assert.deepEqual(blocks, [
    { kind: 'thinking', id: 'thinking', done: true, status: 'done' },
    { kind: 'tool', id: 'running', status: 'complete' },
    { kind: 'tool', id: 'failed', status: 'error' },
  ]);
});

test('失败终态将尚未结束的过程标记为错误', () => {
  const blocks = settleProcessBlocks([
    { kind: 'thinking', id: 'thinking', status: 'running' },
    { kind: 'tool', id: 'running', status: 'pending' },
    { kind: 'tool', id: 'finished', status: 'ok' },
  ], 'error');

  assert.equal(blocks[0].status, 'error');
  assert.equal(blocks[1].status, 'error');
  assert.equal(blocks[2].status, 'ok');
});

test('父任务终态覆盖残留 running，历史消息不再旋转', () => {
  assert.equal(resolveProcessState('running', 'done'), 'complete');
  assert.equal(resolveProcessState('running', 'failed'), 'error');
  assert.equal(resolveProcessState('ok', 'failed'), 'complete');
});

test('SSE 镜像在 done 和 error 时收口后再持久化', () => {
  const completed = mirror();
  completed.send('thinking', { id: 'thinking', delta: '分析' });
  completed.send('tool_call', { id: 'tool', name: 'bash', status: 'running' });
  completed.send('done', { reason: 'completed' });
  assert.equal(completed.getBlocks()[0].done, true);
  assert.equal(completed.getBlocks()[1].status, 'complete');

  const failed = mirror();
  failed.send('tool_call', { id: 'tool', name: 'bash', status: 'running' });
  failed.send('error', '执行失败');
  assert.equal(failed.getBlocks()[0].status, 'error');
});
