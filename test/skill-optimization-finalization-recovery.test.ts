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
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import test from 'node:test';

const directory = mkdtempSync(path.join(tmpdir(), 'issue365-'));
let prisma: typeof import('@/lib/storage/prisma')['prismaRaw'];
let adapter: typeof import('@/lib/skill-workbench/optimization-adapter');
let cancellation: typeof import('@/lib/skill-workbench/optimization-cancellation');
let finalization: typeof import('@/lib/skill-workbench/optimization-finalization');

test.before(async () => {
  writeFileSync(path.join(directory, 'test.db'), '');
  process.env.DATABASE_URL = `file:${path.join(directory, 'test.db')}`;
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { stdio: 'pipe', env: process.env });
  const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
  const original = loader._load;
  loader._load = function (id, ...args) {
    if (id === '@opencode-ai/sdk') return { createOpencodeClient: () => assert.fail('tests must not call a live model') };
    return original.call(this, id, ...args);
  };
  try {
    ({ prismaRaw: prisma } = await import('@/lib/storage/prisma'));
    adapter = await import('@/lib/skill-workbench/optimization-adapter');
    cancellation = await import('@/lib/skill-workbench/optimization-cancellation');
    finalization = await import('@/lib/skill-workbench/optimization-finalization');
  } finally { loader._load = original; }
});
test.after(async () => { await prisma?.$disconnect(); });

async function fixture() {
  const opt = await prisma.skillOptSession.create({ data: { user: 'owner', skillName: 'test', baseVersion: 0, files: '{}' } });
  const session = await prisma.skillWorkbenchSession.create({ data: {
    user: 'owner', source: 'management', skillName: 'test', workVersion: 0, stage: 'ready', optSessionId: opt.id,
  } });
  const run = await adapter.beginWorkbenchOptimizationRun({ user: 'owner', optSessionId: opt.id, runId: opt.id, sourceKind: 'user', sourceRefs: [] });
  assert.equal(run?.kind, 'started');
  return { session, opt, run: run! };
}

function databaseTimeout() {
  return Object.assign(new Error('Operations timed out after 15000 ms: skillWorkbenchTask.update'), { code: 'P1008' });
}

/** 收尾期间数据库暂时不可用：让最前面的 N 次事务按 Prisma P1008 失败。 */
function failNextTransactions(times: number) {
  const client = prisma as unknown as {
    $transaction: (arg: unknown, ...rest: unknown[]) => Promise<unknown>;
  };
  const original = client.$transaction;
  let calls = 0;
  client.$transaction = (arg: unknown, ...rest: unknown[]) => {
    calls += 1;
    if (calls <= times) return Promise.reject(databaseTimeout());
    return original.call(client, arg, ...rest);
  };
  return {
    get calls() { return calls; },
    restore() { client.$transaction = original; },
  };
}

function finishFailure(run: { taskId: string; recordId?: string }, sessionId: string, error: string) {
  return adapter.finishWorkbenchOptimizationRun({
    user: 'owner',
    workbenchSessionId: sessionId,
    taskId: run.taskId,
    recordId: run.recordId,
    sourceKind: 'user',
    sourceRefs: [],
    error,
  });
}

test('transient timeouts during failure settlement are retried within bounds and then settle', async () => {
  const { session, run } = await fixture();
  const transactions = failNextTransactions(2);
  try {
    const result = await finishFailure(run, session.id, '模型调用失败');
    assert.deepEqual(result, { kind: 'failed' });
  } finally {
    transactions.restore();
  }
  assert.ok(transactions.calls >= 3, '收尾写入应在有界次数内重试');
  const task = await prisma.skillWorkbenchTask.findUniqueOrThrow({ where: { id: run.taskId } });
  assert.equal(task.status, 'failed');
  assert.equal(JSON.parse(task.progressJson).stage, '优化失败');
  assert.equal(task.errorMessage, '模型调用失败');
  assert.equal((await prisma.skillWorkbenchSession.findUniqueOrThrow({ where: { id: session.id } })).stage, 'ready');
  assert.equal((await prisma.skillOptimizationRecord.findUniqueOrThrow({ where: { id: run.recordId! } })).status, 'optimization_failed');
});

test('a finalization write that keeps failing reports both reasons and leaves the task repairable', async () => {
  const { session, run } = await fixture();
  const transactions = failNextTransactions(Number.POSITIVE_INFINITY);
  try {
    await assert.rejects(
      finishFailure(run, session.id, '数据库超时前的原始错误'),
      (error: unknown) => {
        assert.ok(error instanceof finalization.OptimizationFinalizationError);
        assert.match(error.message, /数据库超时前的原始错误/);
        assert.match(error.message, /Operations timed out/);
        assert.equal(error.originalMessage, '数据库超时前的原始错误');
        assert.match(error.finalizationMessages.join(' '), /Operations timed out/);
        return true;
      },
    );
  } finally {
    transactions.restore();
  }
  const stuck = await prisma.skillWorkbenchTask.findUniqueOrThrow({ where: { id: run.taskId } });
  assert.equal(stuck.status, 'running');
  // 收尾写入最多重试 FINALIZATION_MAX_ATTEMPTS 次；额外一次是 finally 里的失败实验清理事务。
  assert.equal(transactions.calls, finalization.FINALIZATION_MAX_ATTEMPTS + 1, '重试次数必须有上限');

  await finishFailure(run, session.id, '数据库超时前的原始错误');
  const recovered = await prisma.skillWorkbenchTask.findUniqueOrThrow({ where: { id: run.taskId } });
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.errorMessage, '数据库超时前的原始错误');
});

test('pending cancellation wins over failure settlement; terminal states are never overwritten', async () => {
  const { session, run } = await fixture();
  await cancellation.requestOptimizationCancellation('owner', session.id, run.taskId);
  await assert.rejects(
    finishFailure(run, session.id, '收尾失败'),
    cancellation.OptimizationCancelledError,
  );
  const requested = await prisma.skillWorkbenchTask.findUniqueOrThrow({ where: { id: run.taskId } });
  assert.equal(requested.status, 'running');
  assert.equal(JSON.parse(requested.progressJson).cancelRequested, true);
  assert.equal(requested.errorMessage, null);

  assert.equal(await finalization.settleWorkbenchOptimizationTask({
    taskId: run.taskId,
    status: 'failed',
    progress: { stage: '保存失败', percent: 100 },
    errorMessage: '收尾失败',
  }), 'cancelled');

  await cancellation.finishOptimizationCancellation(run.taskId);
  assert.equal(await finalization.settleWorkbenchOptimizationTask({
    taskId: run.taskId,
    status: 'failed',
    progress: { stage: '保存失败', percent: 100 },
    errorMessage: '收尾失败',
  }), 'cancelled');
  assert.equal((await prisma.skillWorkbenchTask.findUniqueOrThrow({ where: { id: run.taskId } })).status, 'cancelled');

  const done = await fixture();
  await prisma.skillWorkbenchTask.update({ where: { id: done.run.taskId }, data: { status: 'done' } });
  assert.equal(await finalization.settleWorkbenchOptimizationTask({
    taskId: done.run.taskId,
    status: 'failed',
    progress: { stage: '保存失败', percent: 100 },
    errorMessage: '迟到的失败',
  }), 'already-settled');
  assert.equal((await prisma.skillWorkbenchTask.findUniqueOrThrow({ where: { id: done.run.taskId } })).status, 'done');
});
