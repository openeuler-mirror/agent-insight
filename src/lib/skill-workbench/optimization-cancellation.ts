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

import { prismaRaw } from '@/lib/storage/prisma';

export class OptimizationCancelledError extends Error {
  constructor() { super('用户已停止优化'); this.name = 'OptimizationCancelledError'; }
}

export async function watchOptimizationCancellation(readCancelled: () => Promise<boolean>) {
  const controller = new AbortController();
  let pending: Promise<void> | null = null;
  const check = () => pending ||= (async () => {
    if (!controller.signal.aborted && await readCancelled()) controller.abort(new OptimizationCancelledError());
  })().finally(() => { pending = null; });
  await check();
  const timer = setInterval(() => void check().catch((error) => {
    console.error('[optimization cancellation] poll failed:', error);
  }), 500);
  timer.unref?.();
  return {
    signal: controller.signal,
    check: async () => { await check(); controller.signal.throwIfAborted(); },
    close: async () => { clearInterval(timer); await pending?.catch(() => undefined); },
  };
}

export async function requestOptimizationCancellation(user: string, sessionId: string, taskId: string) {
  return prismaRaw.$transaction(async (tx) => {
    const task = await tx.skillWorkbenchTask.findFirst({
      where: { id: taskId, sessionId, type: 'optimization', session: { user } },
    });
    if (!task) return { kind: 'not_found' as const };
    if (!['pending', 'running'].includes(task.status)) return { kind: 'settled' as const, status: task.status };
    const progress = JSON.parse(task.progressJson || '{}');
    if (progress.finalizing) return { kind: 'finalizing' as const };
    await tx.skillWorkbenchTask.update({
      where: { id: task.id },
      data: { progressJson: JSON.stringify({ ...progress, cancelRequested: true, stage: '正在停止优化' }) },
    });
    return { kind: 'cancelling' as const };
  });
}

export async function isOptimizationCancellationRequested(taskId: string) {
  const task = await prismaRaw.skillWorkbenchTask.findUnique({ where: { id: taskId }, select: { status: true, progressJson: true } });
  return !task || task.status === 'cancelled' || Boolean(JSON.parse(task.progressJson || '{}').cancelRequested);
}

export async function claimOptimizationFinalization(taskId: string) {
  return prismaRaw.$transaction(async (tx) => {
    const task = await tx.skillWorkbenchTask.findUnique({ where: { id: taskId } });
    if (!task || !['pending', 'running'].includes(task.status) || JSON.parse(task.progressJson || '{}').cancelRequested) {
      throw new OptimizationCancelledError();
    }
    await tx.skillWorkbenchTask.update({
      where: { id: taskId },
      data: { progressJson: JSON.stringify({ ...JSON.parse(task.progressJson || '{}'), finalizing: true }) },
    });
  });
}

export async function finishOptimizationCancellation(taskId: string) {
  return prismaRaw.$transaction(async (tx) => {
    const task = await tx.skillWorkbenchTask.findUnique({ where: { id: taskId } });
    if (!task || !['pending', 'running'].includes(task.status)) return;
    await tx.skillWorkbenchTask.update({
      where: { id: taskId },
      data: { status: 'cancelled', errorMessage: null, progressJson: JSON.stringify({ stage: '优化已停止', cancelRequested: true }) },
    });
    if (task.resultType === 'optimization-record' && task.resultId) {
      await tx.skillOptimizationRecord.updateMany({
        where: { id: task.resultId, status: 'optimizing' },
        data: { status: 'optimization_cancelled', completedAt: new Date(), errorMessage: null, summary: '用户已停止优化，未保存可发布候选。' },
      });
    }
    await tx.skillWorkbenchSession.update({ where: { id: task.sessionId }, data: { stage: 'ready' } });
  });
}

export async function markOptimizationStopUnconfirmed(taskId: string) {
  const task = await prismaRaw.skillWorkbenchTask.findUnique({ where: { id: taskId } });
  if (!task || task.status !== 'running') return;
  await prismaRaw.skillWorkbenchTask.update({
    where: { id: taskId },
    data: {
      errorMessage: '停止 OpenCode 执行未确认，请检查运行服务',
      progressJson: JSON.stringify({ ...JSON.parse(task.progressJson || '{}'), cancelRequested: true, stopUnconfirmed: true, stage: '停止执行未确认' }),
    },
  });
}
