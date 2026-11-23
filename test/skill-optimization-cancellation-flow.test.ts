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
import { NextRequest } from 'next/server';
import { withSessionCancellation } from '@/lib/engine/general-agent/session-cancellation';

const directory = mkdtempSync(path.join(tmpdir(), 'issue315-'));
let prisma: typeof import('@/lib/storage/prisma')['prismaRaw'];
let cancel: typeof import('@/lib/skill-workbench/optimization-cancellation');
let adapter: typeof import('@/lib/skill-workbench/optimization-adapter');
let control: typeof import('@/lib/skill-workbench/optimization-execution-control');
let route: typeof import('@/app/api/skill-workbench/sessions/[id]/optimization/route');
let chat: typeof import('@/app/api/skill-opt/chat/route');

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
    cancel = await import('@/lib/skill-workbench/optimization-cancellation');
    adapter = await import('@/lib/skill-workbench/optimization-adapter');
    control = await import('@/lib/skill-workbench/optimization-execution-control');
    route = await import('@/app/api/skill-workbench/sessions/[id]/optimization/route');
    chat = await import('@/app/api/skill-opt/chat/route');
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

async function stop(sessionId: string, taskId: string, user = 'owner') {
  return route.POST(new NextRequest('http://localhost/api/skill-workbench/optimization', {
    method: 'POST', body: JSON.stringify({ user, action: 'cancel', taskId }),
  }), { params: Promise.resolve({ id: sessionId }) });
}

test('empty optimization input is rejected before any task or message is created', async () => {
  const before = await prisma.skillWorkbenchTask.count();
  const response = await chat.POST(new NextRequest('http://localhost/api/skill-opt/chat', {
    method: 'POST', body: JSON.stringify({ user: 'owner', threadId: 'empty', skillName: 'test', baseVersion: 0, userFeedback: ' \n ', checkedIssues: [{ id: 'blank', summary: ' ' }], mock: true }),
  }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /补充优化诉求/);
  assert.equal(await prisma.skillWorkbenchTask.count(), before);
  assert.equal(await prisma.skillOptMessage.count({ where: { sessionId: 'empty' } }), 0);
});

test('cancel endpoint checks owner, session and task; progress cannot erase cancellation', async () => {
  const { session, run } = await fixture();
  assert.equal((await stop(session.id, run.taskId, 'other')).status, 404);
  assert.equal((await stop('other-session', run.taskId)).status, 404);
  assert.equal((await stop(session.id, run.taskId)).status, 200);
  await adapter.updateWorkbenchOptimizationProgress({ taskId: run.taskId, stage: '生成候选', activeStep: 2, percent: 35 });
  const task = await prisma.skillWorkbenchTask.findUniqueOrThrow({ where: { id: run.taskId } });
  assert.equal(task.status, 'running');
  assert.equal(JSON.parse(task.progressJson).cancelRequested, true);
  assert.equal(JSON.parse(task.progressJson).stage, '正在停止优化');
});

test('cancellation settles task and record only after work exits, then permits a new submission', async () => {
  const { session, opt, run } = await fixture();
  let notify = false;
  await control.withOptimizationCancellation(run.taskId, async (signal) => {
    const aborted = new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }));
    assert.equal((await stop(session.id, run.taskId)).status, 200);
    const timeout = setTimeout(() => { throw new Error('cancellation was not observed'); }, 3000);
    try { await aborted; } finally { clearTimeout(timeout); }
    assert.equal((await prisma.skillWorkbenchTask.findUniqueOrThrow({ where: { id: run.taskId } })).status, 'running');
    signal!.throwIfAborted();
  }, async () => { notify = true; });
  assert.equal(notify, true);
  assert.equal((await prisma.skillWorkbenchTask.findUniqueOrThrow({ where: { id: run.taskId } })).status, 'cancelled');
  const record = await prisma.skillOptimizationRecord.findUniqueOrThrow({ where: { id: run.recordId! } });
  assert.equal(record.status, 'optimization_cancelled');
  assert.equal(record.candidateContentHash, null);
  const next = await adapter.beginWorkbenchOptimizationRun({ user: 'owner', optSessionId: opt.id, runId: 'next', sourceKind: 'user', sourceRefs: [] });
  assert.equal(next?.kind, 'started');
  assert.notEqual(next?.taskId, run.taskId);
});

test('finalization rejects late cancellation and cancellation prevents finalization', async () => {
  const first = await fixture();
  await cancel.claimOptimizationFinalization(first.run.taskId);
  assert.equal((await stop(first.session.id, first.run.taskId)).status, 409);
  const second = await fixture();
  await stop(second.session.id, second.run.taskId);
  await assert.rejects(cancel.claimOptimizationFinalization(second.run.taskId), cancel.OptimizationCancelledError);
});

test('unconfirmed remote abort preserves the running lock', async () => {
  const { opt, run } = await fixture();
  await assert.rejects(control.withOptimizationCancellation(run.taskId, async () => {
    throw new Error('停止 OpenCode 执行未确认');
  }, async () => { assert.fail('must not report cancellation complete'); }), /停止 OpenCode 执行未确认/);
  const task = await prisma.skillWorkbenchTask.findUniqueOrThrow({ where: { id: run.taskId } });
  assert.equal(task.status, 'running');
  assert.equal(JSON.parse(task.progressJson).stopUnconfirmed, true);
  const next = await adapter.beginWorkbenchOptimizationRun({ user: 'owner', optSessionId: opt.id, runId: 'blocked', sourceKind: 'user', sourceRefs: [] });
  assert.equal(next?.kind, 'busy');
});

test('OpenCode cancellation waits for the session abort acknowledgement', async () => {
  const controller = new AbortController();
  let acknowledge!: (value: boolean) => void;
  let settled = false;
  const operation = withSessionCancellation(controller.signal, () => new Promise<boolean>((resolve) => { acknowledge = resolve; }), async () => {
    controller.abort(new Error('用户已停止优化'));
    return 'partial result';
  });
  const result = operation.then(() => assert.fail('must cancel'), (error: Error) => { settled = true; return error; });
  await Promise.resolve();
  assert.equal(settled, false);
  acknowledge(true);
  assert.match((await result).message, /用户已停止优化/);
});

test('failed remote abort is distinct from confirmed cancellation', async () => {
  const controller = new AbortController();
  await assert.rejects(withSessionCancellation(controller.signal, async () => false, async () => {
    controller.abort();
  }), /停止 OpenCode 执行未确认/);
});

test('normal completion does not abort the remote session', async () => {
  assert.equal(await withSessionCancellation(new AbortController().signal, async () => {
    assert.fail('normal completion must not abort');
  }, async () => 'done'), 'done');
});


test('accepted streaming run can be stopped through the API and is restored as cancelled', async () => {
  const { session, opt, run } = await fixture();
  await cancel.finishOptimizationCancellation(run.taskId);
  const response = await chat.POST(new NextRequest('http://localhost/api/skill-opt/chat', {
    method: 'POST', body: JSON.stringify({ user: 'owner', threadId: opt.id, skillName: 'test', baseVersion: 0, userFeedback: '补充失败退出条件', mock: true, runId: 'stream-cancel' }),
  }));
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let output = '';
  let requested = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value);
    if (!requested && output.includes('optimization_meta')) {
      const task = await prisma.skillWorkbenchTask.findFirstOrThrow({ where: { sessionId: session.id, status: 'running' } });
      assert.equal((await stop(session.id, task.id)).status, 200);
      requested = true;
    }
  }
  assert.equal(requested, true);
  assert.match(output, /"mode":"cancelled"/);
  const task = await prisma.skillWorkbenchTask.findFirstOrThrow({ where: { sessionId: session.id }, orderBy: { createdAt: 'desc' } });
  assert.equal(task.status, 'cancelled');
  assert.equal(await prisma.skillSnapshotEvaluation.count({ where: { sessionId: session.id } }), 0);
  const message = await prisma.skillOptMessage.findFirstOrThrow({ where: { sessionId: opt.id, role: 'agent' }, orderBy: { createdAt: 'desc' } });
  assert.match(message.content, /优化已停止/);
  assert.ok(JSON.parse(message.blocks).every((block: { status?: string }) => block.status !== 'running'));
});
