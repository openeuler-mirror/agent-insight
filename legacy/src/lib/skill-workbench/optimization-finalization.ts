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

const ACTIVE_TASK_STATUSES = ['pending', 'running'] as const;

/** 收尾写入只重试短暂故障，且次数有上限；持久故障交由调用方带两个原因上抛。 */
export const FINALIZATION_MAX_ATTEMPTS = 3;
export const FINALIZATION_RETRY_DELAYS_MS = [200, 600] as const;

const TRANSIENT_DATABASE_CODES = new Set(['P1008', 'P1017', 'P2024', 'P2028', 'P2034']);
const TRANSIENT_DATABASE_MESSAGE = /operations timed out|timed out fetching a new connection|database is locked|SQLITE_BUSY|write conflict|deadlock|connection closed|ECONNRESET/i;

export class OptimizationFinalizationError extends Error {
  constructor(
    readonly originalMessage: string,
    readonly finalizationMessages: string[],
  ) {
    super(
      `优化收尾失败：原始错误「${originalMessage}」；`
      + `收尾写入也失败「${finalizationMessages.join('；')}」，任务可能仍显示运行中。`
      + '请在数据库恢复后重试或重新发起优化。',
    );
    this.name = 'OptimizationFinalizationError';
  }
}

export function describeFinalizationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isTransientFinalizationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSIENT_DATABASE_CODES.has(code.toUpperCase())) return true;
  return TRANSIENT_DATABASE_MESSAGE.test(describeFinalizationError(error));
}

/**
 * 数据库短暂不可用时按固定退避重试收尾写入。只重试连接/锁/超时类错误，
 * 业务错误（取消、状态冲突）立即上抛，避免把终态或取消覆盖成失败。
 */
export async function withBoundedFinalizationRetry<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      signal?.throwIfAborted();
      if (!isTransientFinalizationError(error) || attempt >= FINALIZATION_MAX_ATTEMPTS - 1) throw error;
      const delay = FINALIZATION_RETRY_DELAYS_MS[Math.min(attempt, FINALIZATION_RETRY_DELAYS_MS.length - 1)];
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export type OptimizationTaskSettlement = 'settled' | 'cancelled' | 'already-settled';

function isActiveTaskStatus(status: string): boolean {
  return (ACTIVE_TASK_STATUSES as readonly string[]).includes(status);
}

function parseProgress(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * 终态写入只作用于仍活跃且未请求取消的任务：已取消/已完成/已失败的任务绝不覆盖，
 * 待处理取消优先于失败收尾。
 */
export async function settleWorkbenchOptimizationTask(input: {
  taskId: string;
  status: 'done' | 'failed';
  progress: Record<string, unknown>;
  errorMessage?: string | null;
  resultType?: string | null;
  resultId?: string | null;
  signal?: AbortSignal;
}): Promise<OptimizationTaskSettlement> {
  return withBoundedFinalizationRetry(() => prismaRaw.$transaction(async (tx) => {
    const task = await tx.skillWorkbenchTask.findUnique({
      where: { id: input.taskId },
      select: { status: true, progressJson: true },
    });
    if (!task) return 'already-settled' as const;
    if (!isActiveTaskStatus(task.status)) {
      return task.status === 'cancelled' ? 'cancelled' as const : 'already-settled' as const;
    }
    if (parseProgress(task.progressJson).cancelRequested) return 'cancelled' as const;
    // 以 status + progressJson 做 CAS：读取后被请求取消（cancelRequested 写入）时本次写入落空，改走取消收尾。
    const updated = await tx.skillWorkbenchTask.updateMany({
      where: { id: input.taskId, status: task.status, progressJson: task.progressJson },
      data: {
        status: input.status,
        progressJson: JSON.stringify(input.progress),
        ...(input.resultType !== undefined ? { resultType: input.resultType } : {}),
        ...(input.resultId !== undefined ? { resultId: input.resultId } : {}),
        ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
      },
    });
    if (updated.count > 0) return 'settled' as const;
    const latest = await tx.skillWorkbenchTask.findUnique({
      where: { id: input.taskId },
      select: { status: true, progressJson: true },
    });
    return latest && (latest.status === 'cancelled' || parseProgress(latest.progressJson).cancelRequested)
      ? 'cancelled' as const
      : 'already-settled' as const;
  }), input.signal);
}

/** 只有会话里没有其他活跃任务时才恢复就绪，避免把新一轮的 busy 改回 ready。 */
export async function releaseWorkbenchOptimizationSession(
  sessionId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return withBoundedFinalizationRetry(() => prismaRaw.$transaction(async (tx) => {
    const active = await tx.skillWorkbenchTask.count({
      where: { sessionId, status: { in: [...ACTIVE_TASK_STATUSES] } },
    });
    if (active > 0) return false;
    const updated = await tx.skillWorkbenchSession.updateMany({
      where: { id: sessionId, stage: 'busy' },
      data: { stage: 'ready' },
    });
    return updated.count > 0;
  }), signal);
}
