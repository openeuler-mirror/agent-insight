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

// Path A 拉取器：遍历已注册、启用的 pull 源，抓一次 /metrics 落 InfraMetricSample。
// pollOnce 设计成可被定时器/路由触发；fetch 可注入便于测试。

import { parseAuthHeaders } from '@/lib/infra/auth-headers';
import { saveSample } from '@/lib/infra/store';
import { scrapeVllmTargetModels } from '@/lib/ingest/vllm/scrape';
import { prismaRaw } from '@/lib/storage/prisma';

export interface PollResult {
  polled: number;
  failed: number;
  skipped?: number;
  errors: Array<{ endpoint: string; error: string }>;
}

// 每源上次拉取时刻（内存态），用于按每源 scrapeIntervalMs 控制定时拉取节奏。
const lastPollAt = new Map<string, number>();

const FAILURE_LOG_INTERVAL_MS = 60_000;
type FailureLog = {
  error: string;
  firstFailedAt: number;
  lastLoggedAt: number;
  consecutiveFailures: number;
  suppressed: number;
};

function logFailure(logs: Map<string, FailureLog>, key: string, error: string, nowMs: number, endpoint?: string): void {
  const previous = logs.get(key);
  if (previous && previous.error === error && nowMs - previous.lastLoggedAt < FAILURE_LOG_INTERVAL_MS) {
    previous.consecutiveFailures += 1;
    previous.suppressed += 1;
    return;
  }
  const next: FailureLog = {
    error, firstFailedAt: previous?.firstFailedAt ?? nowMs, lastLoggedAt: nowMs,
    consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1, suppressed: 0,
  };
  logs.set(key, next);
  console.error(endpoint ? '[infra-poller] source error:' : '[infra-poller] tick error:', JSON.stringify({
    endpoint, error, consecutiveFailures: next.consecutiveFailures,
    firstFailedAt: new Date(next.firstFailedAt).toISOString(), lastFailedAt: new Date(nowMs).toISOString(),
    suppressed: previous?.suppressed ?? 0,
    previousError: previous && previous.error !== error ? previous.error : undefined,
  }));
}

function logRecovery(logs: Map<string, FailureLog>, key: string, nowMs: number, endpoint?: string): void {
  const previous = logs.get(key);
  if (!previous) return;
  logs.delete(key);
  console.log(endpoint ? '[infra-poller] source recovered:' : '[infra-poller] tick recovered:', JSON.stringify({
    endpoint, previousError: previous.error, consecutiveFailures: previous.consecutiveFailures,
    suppressed: previous.suppressed, durationMs: nowMs - previous.firstFailedAt,
  }));
}

/** 拉一轮启用的 pull 源（可用 endpoints 限定子集）；返回成功/失败计数。 */
export async function pollOnce(
  opts: { fetchImpl?: typeof fetch; tsMs?: number; endpoints?: string[] } = {},
): Promise<PollResult> {
  const { fetchImpl, tsMs = Date.now(), endpoints } = opts;
  const sources = await prismaRaw.infraSource.findMany({
    where: {
      enabled: true,
      kind: 'pull',
      ...(endpoints ? { endpoint: { in: endpoints } } : {}),
    },
  });

  let polled = 0;
  let failed = 0;
  const errors: Array<{ endpoint: string; error: string }> = [];

  for (const src of sources) {
    try {
      const samples = await scrapeVllmTargetModels(src.scrapeUrl || src.endpoint, {
        fetchImpl,
        tsMs,
        headers: parseAuthHeaders(src.authHeaders),
      });
      for (const s of samples) await saveSample(src.id, s);
      polled += 1;
    } catch (e) {
      failed += 1;
      errors.push({ endpoint: src.endpoint, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { polled, failed, errors };
}

/** 只拉「到点」的源：每源按自己的 scrapeIntervalMs 控制节奏（定时器调它）。 */
export async function pollDue(
  opts: { nowMs?: number; fetchImpl?: typeof fetch; endpoints?: string[] } = {},
): Promise<PollResult> {
  return runPollDue(opts);
}

async function runPollDue(
  opts: { nowMs?: number; fetchImpl?: typeof fetch; endpoints?: string[] },
  failureLogs?: Map<string, FailureLog>,
): Promise<PollResult> {
  const { nowMs = Date.now(), fetchImpl, endpoints } = opts;
  const sources = await prismaRaw.infraSource.findMany({
    where: { enabled: true, kind: 'pull', ...(endpoints ? { endpoint: { in: endpoints } } : {}) },
  });
  if (failureLogs) {
    const activeIds = new Set(sources.map(source => source.id));
    for (const id of failureLogs.keys()) if (!activeIds.has(id)) failureLogs.delete(id);
  }

  let polled = 0;
  let failed = 0;
  let skipped = 0;
  const errors: Array<{ endpoint: string; error: string }> = [];

  for (const src of sources) {
    const interval = src.scrapeIntervalMs && src.scrapeIntervalMs > 0 ? src.scrapeIntervalMs : 1000;
    const last = lastPollAt.get(src.id) ?? 0;
    if (nowMs - last < interval) {
      skipped += 1;
      continue; // 还没到该源的采集间隔
    }
    lastPollAt.set(src.id, nowMs);
    try {
      const samples = await scrapeVllmTargetModels(src.scrapeUrl || src.endpoint, {
        fetchImpl,
        tsMs: nowMs,
        headers: parseAuthHeaders(src.authHeaders),
      });
      for (const s of samples) await saveSample(src.id, s);
      polled += 1;
      if (failureLogs) logRecovery(failureLogs, src.id, nowMs, src.endpoint);
    } catch (e) {
      failed += 1;
      const error = e instanceof Error ? e.message : String(e);
      errors.push({ endpoint: src.endpoint, error });
      if (failureLogs) logFailure(failureLogs, src.id, error, nowMs, src.endpoint);
    }
  }
  return { polled, failed, skipped, errors };
}

// ---- 自动定时拉取 --------------------------------------------------------

let pollTimer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

// 定时器「基础节拍」：多久醒一次去检查哪些源到点了。每源真正的采集间隔由各自的
// scrapeIntervalMs 决定（>= 基础节拍）。INFRA_POLL_BASE_MS<=0 关闭自动拉取。
export function startInfraPoller(opts: { intervalMs?: number } = {}): void {
  if (pollTimer) return; // 幂等：已启动则不重复
  const baseMs = opts.intervalMs
    ?? Number(process.env.INFRA_POLL_BASE_MS || process.env.INFRA_POLL_INTERVAL_MS || 1000);
  if (!Number.isFinite(baseMs) || baseMs <= 0) {
    console.log('[infra-poller] 自动拉取已关闭（INFRA_POLL_BASE_MS<=0）');
    return;
  }
  const sourceFailureLogs = new Map<string, FailureLog>();
  const tickFailureLogs = new Map<string, FailureLog>();
  pollTimer = setInterval(() => {
    if (tickInFlight) return; // 上一轮没结束就跳过，避免堆叠
    tickInFlight = true;
    runPollDue({}, sourceFailureLogs)
      .then(() => logRecovery(tickFailureLogs, 'tick', Date.now()))
      .catch((e) => logFailure(tickFailureLogs, 'tick', e instanceof Error ? e.message : String(e), Date.now()))
      .finally(() => {
        tickInFlight = false;
      });
  }, baseMs);
  // 不阻止进程退出
  if (typeof (pollTimer as { unref?: () => void }).unref === 'function') {
    (pollTimer as { unref: () => void }).unref();
  }
  console.log(`[infra-poller] 自动拉取已启动，基础节拍 ${baseMs}ms（每源按自己的采集间隔拉）`);
}

export function stopInfraPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** 仅供测试：当前是否在运行。 */
export function isInfraPollerRunning(): boolean {
  return pollTimer != null;
}
