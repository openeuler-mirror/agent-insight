/**
 * 后台系统任务的 opencode 并发上限。
 *
 * 背景: A/B 测试一次能 spawn 几百个 work item, evaluator 一次也几十条;
 * 每个 work item 在 opencode-server 里创建一个 session, session 不会自动 GC, 内存累计
 * 容易把 next.js 进程干爆。runGeneralAgent 调用方又分散在多个文件,各自有自己的 local
 * concurrency, 互相之间不知道对方排了多少, 没人对"全局正在跑的 opencode 任务数"负责。
 *
 * 这里加一个**全局信号量**: 同一时间最多 N 个后台 opencode 任务并发跑, 多出来的自动排队,
 * 前一个 release 才能继续。后台 = A/B 测试 + 各评测器。
 *
 * **不**约束的:
 *   - 用户 skill-gen 实时对话(runGeneralAgent in skill-generator-bridge): 交互场景,
 *     用户在等模型回复, 不能压在排队队尾。
 *   - 单条 trace 的 trajectory eval / analyze-match 等同步 HTTP 入口的请求-响应:
 *     用户主动点的, 不算后台。
 *
 * 阈值: 默认 5, 可通过 MAX_BACKGROUND_OPENCODE_TASKS env 覆盖。
 * 实测内存 ~ 30-60MB/session × 5 = 150-300MB 上限, 不会失控。
 */

const DEFAULT_MAX_BG = 5;
const MAX_BG = (() => {
  const raw = Number(process.env.MAX_BACKGROUND_OPENCODE_TASKS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_BG;
  return Math.max(1, Math.min(50, Math.floor(raw))); // clamp [1, 50] 防误配
})();

class AsyncSemaphore {
  private permits: number;
  private waiters: Array<() => void> = [];
  // 监控用: 累计已抢/已释放/被拒, 让运维能看出"是不是一直在排队"
  active = 0;
  totalAcquired = 0;
  totalReleased = 0;
  totalQueuedWait = 0; // 历史上有多少次 acquire 是排队等到的(不是立刻拿到)

  constructor(public readonly max: number) {
    this.permits = max;
  }

  async acquire(): Promise<void> {
    this.totalAcquired += 1;
    if (this.permits > 0) {
      this.permits -= 1;
      this.active += 1;
      return;
    }
    // 没 permit, 排队等
    this.totalQueuedWait += 1;
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  release(): void {
    this.totalReleased += 1;
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) {
      // 把 permit 直接传给下一个等待者(不增 count, 因为它马上又被 active 消耗)
      next();
    } else {
      this.permits += 1;
    }
  }

  /** 给监控端用的统计快照. */
  snapshot() {
    return {
      max: this.max,
      permitsLeft: this.permits,
      active: this.active,
      waiting: this.waiters.length,
      totalAcquired: this.totalAcquired,
      totalReleased: this.totalReleased,
      totalQueuedWait: this.totalQueuedWait,
    };
  }
}

// 全局单例: 跨所有调用方共享同一份配额。挂 globalThis 是为了 next.js HMR 不会
// 在开发模式下让多个 module copy 各自起一份信号量(那样并发上限就不准了)。
const GLOBAL_KEY = Symbol.for('@witty-insight/background-opencode-semaphore');
type GlobalSlot = { semaphore: AsyncSemaphore };
const globalAny = globalThis as unknown as { [GLOBAL_KEY]?: GlobalSlot };
if (!globalAny[GLOBAL_KEY]) {
  globalAny[GLOBAL_KEY] = { semaphore: new AsyncSemaphore(MAX_BG) };
  console.log(
    `[opencode-bg-semaphore] initialized with max=${MAX_BG}` +
      (process.env.MAX_BACKGROUND_OPENCODE_TASKS
        ? ` (from MAX_BACKGROUND_OPENCODE_TASKS env)`
        : ` (default; override with MAX_BACKGROUND_OPENCODE_TASKS env)`),
  );
}
const semaphore: AsyncSemaphore = globalAny[GLOBAL_KEY]!.semaphore;

/**
 * 后台系统任务的 opencode 调用都包一层这个:
 *
 *   await withBackgroundOpencodeSlot(async () => {
 *     return runGeneralAgent({ ... });
 *   });
 *
 * 行为:
 *   - 当前 active < max: 立刻进 fn(), 占一个 slot
 *   - 当前 active >= max: 排队等, 前面有人 release 才轮到自己
 *   - fn() 抛错也会 release(finally), 不会泄漏 slot
 *   - 长时间排队会打点 log 帮助排查"是不是一直在等",避免静默卡死。
 */
export async function withBackgroundOpencodeSlot<T>(
  fn: () => Promise<T>,
  opts?: { label?: string },
): Promise<T> {
  const label = opts?.label || 'background-task';
  const waitStart = Date.now();
  await semaphore.acquire();
  const waited = Date.now() - waitStart;
  if (waited > 5000) {
    // 排队超过 5s 才能拿到 slot 说明背压大,打 log 让运维注意
    const s = semaphore.snapshot();
    console.log(
      `[opencode-bg-semaphore] ${label}: waited ${(waited / 1000).toFixed(1)}s for slot ` +
        `(active=${s.active}/${s.max}, waiting=${s.waiting})`,
    );
  }
  try {
    return await fn();
  } finally {
    semaphore.release();
  }
}

/** 给监控/admin 接口用的快照. */
export function getBackgroundOpencodeSemaphoreSnapshot() {
  return semaphore.snapshot();
}
