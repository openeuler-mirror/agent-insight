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
  const { nowMs = Date.now(), fetchImpl, endpoints } = opts;
  const sources = await prismaRaw.infraSource.findMany({
    where: { enabled: true, kind: 'pull', ...(endpoints ? { endpoint: { in: endpoints } } : {}) },
  });

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
    } catch (e) {
      failed += 1;
      errors.push({ endpoint: src.endpoint, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { polled, failed, skipped, errors };
}

// ---- 自动定时拉取 --------------------------------------------------------
// 单一全局 tick：每 intervalMs 调一次 pollOnce（pollOnce 内部只抓启用的 pull 源；
// 无源时是廉价空转）。设 INFRA_POLL_INTERVAL_MS<=0 可关闭自动拉取。

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
  pollTimer = setInterval(() => {
    if (tickInFlight) return; // 上一轮没结束就跳过，避免堆叠
    tickInFlight = true;
    pollDue()
      .then((r) => {
        if (r.failed > 0) console.warn(`[infra-poller] polled ${r.polled}, failed ${r.failed}`, r.errors);
      })
      .catch((e) => console.warn('[infra-poller] tick error:', e instanceof Error ? e.message : e))
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
