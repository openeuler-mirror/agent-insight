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

/**
 * 单个后台任务的元信息——拿 slot 时由 caller 提供,放进 active map 后
 * dashboard / debug endpoint 能直接读出"现在 5 个 slot 都在跑啥"。
 */
export interface BackgroundTaskMeta {
  /** A/B 测试 / trajectory-eval / task-completion-eval / custom-llm-eval / skill-gen 等。 */
  taskType: string;
  /** 触发用户 (resolveUser),用来按 user/system 归属过滤。 */
  user?: string;
  /** 可读 label,会显示在 UI 上,例如 "trajectory-eval: openeuler-docker-fault v3"。 */
  label?: string;
  /** 关联的 skill 名: 后台分析任务都跟某个 skill 绑定,前端按 skill 严格过滤。 */
  skill?: string;
  /** 关联的 skill 版本号 (v0/v1/...),前端展示 + 可按版本筛选。 */
  skillVersion?: number | null;
}

export interface BackgroundTaskOptions extends Partial<BackgroundTaskMeta> {
  /** UI label 别名,优先级高于 meta.label。 */
  label?: string;
  /**
   * silent=true: 不写 TaskRecord, 只占 slot (做实际的限流)。dashboard 不可见。
   *   用于"用户视角的子任务"——例如 row-level 评测内部的 trajectory/task-completion/custom-llm 子调用,
   *   只在 row-level 任务里显示一次, 不让 panel 里冒出一堆子任务卡片。
   * silent=false (默认): 写 TaskRecord,dashboard 可见。
   */
  silent?: boolean;
  /**
   * displayOnly=true: 写 TaskRecord 让 dashboard 显示,但**不占 slot** (不影响并发上限)。
   *   用于"用户视角的父任务"——例如 runOneEvaluation 整体,只是为了在 panel 显示"评测进行中",
   *   不应该占 limiter 的 5 个 slot (那样会让 row 把 evaluator 的 slot 抢光,死锁)。
   * displayOnly=false (默认): 正常 acquire/release。
   */
  displayOnly?: boolean;
  /**
   * 任务级 AbortSignal。传了后:
   *   - acquire 时已 aborted → 立刻抛 AbortError (不进 record / waiters)
   *   - acquire 排队等 slot 时 signal fires → 从 waiters 队列移出 + reject AbortError
   *   - fn() 执行期间 abort 不会直接打断 (fn 自己的内部代码需自行响应 signal)
   * 配合 grayscale「终止」按钮: 用户点终止 → semaphore queue 里所有 waiter 立刻 reject,
   * runWithConcurrency 抓 catch 标 fail, 不再等死。
   */
  signal?: AbortSignal;
}

/** 任务生命周期状态 —— 前端按这个语义展示给用户(排队等待 / 执行中 / 成功 / 异常)。 */
export type TaskStatus = 'queued' | 'running' | 'done' | 'failed';

/** 任务记录: 一直保留到完成后 N 分钟才从 ring buffer 删,让前端能看到"刚完成"的任务。 */
export interface TaskRecord extends BackgroundTaskMeta {
  id: string;
  status: TaskStatus;
  /** acquire 入队时间 (= 用户发起任务时间)。 */
  queuedAt: number;
  /** 拿到 slot 真正开始跑的时间。queued 状态下为 null。 */
  startedAt: number | null;
  /** 任务结束时间。queued / running 时为 null。 */
  endedAt: number | null;
  /** failed 时的错误信息 (一行 message)。 */
  errorMessage?: string | null;
}

/** 完成任务在 ring buffer 里保留多久,5 分钟之后从 snapshot 里消失。 */
const FINISHED_TASK_RETAIN_MS = 5 * 60 * 1000;
/** ring buffer 上限,防 OOM。完成任务超过这个数会按 endedAt 升序裁。 */
const FINISHED_TASK_MAX = 200;

/**
 * 持久化状态: tasks + 计数器 + nextId 都挂 globalThis(plain object,跨 HMR 稳定)。
 * 避免 class private field 在 HMR 后被新 instance 重置为空,导致 dashboard 任务列表
 * "过一会消失"。waiters 不挂 (callback 引用旧 closure 不可持久化), 但 waiters 是
 * 极短生命周期的, HMR 时被清掉不会影响业务正确性 (最多让 dev 模式下排队任务多等一会)。
 */
interface PersistentState {
  tasks: Map<string, TaskRecord>;
  nextId: { v: number };
  counters: {
    active: number;
    totalAcquired: number;
    totalReleased: number;
    totalQueuedWait: number;
  };
}

class AsyncSemaphore {
  private permits: number;
  private waiters: Array<() => void> = [];
  // 持久化状态 (跨 HMR 共享)
  private state: PersistentState;

  constructor(public readonly max: number, state: PersistentState) {
    this.permits = max;
    this.state = state;
  }

  // 兼容旧 API 的 getter (snapshot() 用)
  get active() { return this.state.counters.active; }
  get totalAcquired() { return this.state.counters.totalAcquired; }
  get totalReleased() { return this.state.counters.totalReleased; }
  get totalQueuedWait() { return this.state.counters.totalQueuedWait; }
  private get tasks() { return this.state.tasks; }

  /** 从 ring buffer 删掉过期 / 超量的 finished 任务,在每次 release 时跑。 */
  private pruneFinished() {
    const now = Date.now();
    const finished: TaskRecord[] = [];
    for (const t of this.tasks.values()) {
      if (t.status === 'done' || t.status === 'failed') finished.push(t);
    }
    // 1) 删过期的 (endedAt 比 now 早超过 retain 阈值)
    for (const t of finished) {
      if (t.endedAt != null && now - t.endedAt > FINISHED_TASK_RETAIN_MS) {
        this.tasks.delete(t.id);
      }
    }
    // 2) 删超量的 (按 endedAt 升序,留最近 FINISHED_TASK_MAX 条)
    const remaining = finished
      .filter(t => this.tasks.has(t.id))
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    const overflow = remaining.length - FINISHED_TASK_MAX;
    if (overflow > 0) {
      for (let i = 0; i < overflow; i++) this.tasks.delete(remaining[i].id);
    }
  }

  async acquire(meta?: BackgroundTaskMeta, modeOpts?: { silent?: boolean; displayOnly?: boolean; signal?: AbortSignal }): Promise<string> {
    // 调用方传了 signal 且已经 aborted → 立刻抛, 不进 record / waiters
    if (modeOpts?.signal?.aborted) {
      const err = new Error('opencode slot acquire aborted by user');
      (err as Error & { name: string }).name = 'AbortError';
      throw err;
    }
    this.state.counters.totalAcquired += 1;
    const id = `bg-${this.state.nextId.v++}`;
    const now = Date.now();
    const record: TaskRecord = {
      id,
      status: 'queued',
      queuedAt: now,
      startedAt: null,
      endedAt: null,
      taskType: meta?.taskType ?? 'unknown',
      user: meta?.user,
      label: meta?.label,
      skill: meta?.skill,
      skillVersion: meta?.skillVersion ?? null,
    };
    // displayOnly: 写 record 让 dashboard 看到, 但不占 slot, 直接标 running 返回
    if (modeOpts?.displayOnly) {
      record.status = 'running';
      record.startedAt = now;
      this.tasks.set(id, record);
      return id;
    }
    // silent: 不写 record (不污染 dashboard), 但走正常 slot acquire 限流
    if (!modeOpts?.silent) {
      this.tasks.set(id, record);
    }
    if (this.permits > 0) {
      this.permits -= 1;
      this.state.counters.active += 1;
      record.status = 'running';
      record.startedAt = Date.now();
      return id;
    }
    // 没 permit, 排队等。状态仍为 'queued' 直到 waiter 被 resolve
    this.state.counters.totalQueuedWait += 1;
    return new Promise<string>((resolve, reject) => {
      const waiter = () => {
        this.state.counters.active += 1;
        record.status = 'running';
        record.startedAt = Date.now();
        if (modeOpts?.signal) modeOpts.signal.removeEventListener('abort', onAbort);
        resolve(id);
      };
      const onAbort = () => {
        // 从 waiters 队列里把自己移出去, 否则后面 release 取下一个 waiter 时会
        // 调到一个 dangling callback, permit 被白消耗 + record 永远停在 queued
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        if (record.status === 'queued') {
          record.status = 'failed';
          record.endedAt = Date.now();
          record.errorMessage = 'aborted while waiting for slot';
        }
        const err = new Error('opencode slot acquire aborted by user');
        (err as Error & { name: string }).name = 'AbortError';
        reject(err);
      };
      this.waiters.push(waiter);
      if (modeOpts?.signal) modeOpts.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** 任务结束: 标记 done/failed + endedAt + errorMessage,不立即删,保留 5 分钟让前端看到。 */
  release(id?: string, outcome?: { error?: unknown }, modeOpts?: { silent?: boolean; displayOnly?: boolean }): void {
    this.state.counters.totalReleased += 1;
    // displayOnly 没占 slot, 不需要 release semaphore;只标 record 完成
    if (!modeOpts?.displayOnly) {
      this.state.counters.active = Math.max(0, this.state.counters.active - 1);
    }
    if (id) {
      const t = this.tasks.get(id);
      if (t) {
        t.endedAt = Date.now();
        if (outcome?.error !== undefined) {
          t.status = 'failed';
          const msg = outcome.error instanceof Error
            ? outcome.error.message
            : typeof outcome.error === 'string' ? outcome.error : JSON.stringify(outcome.error);
          t.errorMessage = (msg || '').slice(0, 500); // 截断防超长
        } else {
          t.status = 'done';
        }
      }
    }
    this.pruneFinished();
    // displayOnly 没占 slot,不要去叫醒 waiter (会让 permits 错配)
    if (modeOpts?.displayOnly) return;
    const next = this.waiters.shift();
    if (next) {
      // 把 permit 直接传给下一个等待者(不增 count, 因为它马上又被 active 消耗)
      next();
    } else {
      this.permits += 1;
    }
  }

  /** 手动从 ring buffer 删除某条任务记录 (例如 terminate 操作后前端不想再看到)。 */
  forget(id: string): void {
    this.tasks.delete(id);
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

  /** 所有任务清单 (queued + running + 最近 5min 内完成的),按 queuedAt 倒序方便最新在前。 */
  tasksSnapshot(): TaskRecord[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.queuedAt - a.queuedAt);
  }
}

// 全局单例: 跨所有调用方共享同一份配额。挂 globalThis 是为了 next.js HMR 不会
// 在开发模式下让多个 module copy 各自起一份信号量(那样并发上限就不准了)。
const GLOBAL_KEY = Symbol.for('@witty-insight/background-opencode-semaphore');
// 持久化设计: 把 tasks/计数器存为 plain object 挂 globalThis,跨 HMR 不丢。
// 每次模块 reload 都重新 new 一个 AsyncSemaphore class instance, 但它通过引用拿到
// 同一份 PersistentState, 所以 dashboard "后台分析任务" 列表稳定。
// (历史 bug: tasks 是 class private field 时,HMR 后新 instance 的 tasks 是空,导致
//  用户跑评测后任务"过一会消失"。)
type GlobalSlot = { state: PersistentState; version: number };
const globalAny = globalThis as unknown as { [GLOBAL_KEY]?: GlobalSlot };
const SCHEMA_VERSION = 2;
if (!globalAny[GLOBAL_KEY] || globalAny[GLOBAL_KEY].version !== SCHEMA_VERSION) {
  globalAny[GLOBAL_KEY] = {
    state: {
      tasks: new Map<string, TaskRecord>(),
      nextId: { v: 1 },
      counters: { active: 0, totalAcquired: 0, totalReleased: 0, totalQueuedWait: 0 },
    },
    version: SCHEMA_VERSION,
  };
  console.log(
    `[opencode-bg-semaphore] initialized state with max=${MAX_BG} (schema v${SCHEMA_VERSION})` +
      (process.env.MAX_BACKGROUND_OPENCODE_TASKS
        ? ` (from MAX_BACKGROUND_OPENCODE_TASKS env)`
        : ` (default; override with MAX_BACKGROUND_OPENCODE_TASKS env)`),
  );
}
const persistentState = globalAny[GLOBAL_KEY]!.state;
// AsyncSemaphore class instance 每次模块 reload 都新建,但 state 引用同一份 globalThis Map。
const semaphore: AsyncSemaphore = new AsyncSemaphore(MAX_BG, persistentState);

/**
 * 后台系统任务的 opencode 调用都包一层这个:
 *
 *   await withBackgroundOpencodeSlot(async () => {
 *     return runGeneralAgent({ ... });
 *   }, { taskType: 'trajectory-eval', user, label: 'eval foo v3' });
 *
 * 行为:
 *   - 当前 active < max: 立刻进 fn(), 占一个 slot
 *   - 当前 active >= max: 排队等, 前面有人 release 才轮到自己
 *   - fn() 抛错也会 release(finally), 不会泄漏 slot
 *   - 长时间排队会打点 log 帮助排查"是不是一直在等",避免静默卡死。
 *   - meta 会被注册到 active tasks 表里, dashboard 能实时看到"现在 5 个 slot 都在跑啥"
 */
export async function withBackgroundOpencodeSlot<T>(
  fn: () => Promise<T>,
  opts?: BackgroundTaskOptions,
): Promise<T> {
  const label = opts?.label || 'background-task';
  const meta: BackgroundTaskMeta = {
    taskType: opts?.taskType ?? 'unknown',
    user: opts?.user,
    label,
    skill: opts?.skill,
    skillVersion: opts?.skillVersion,
  };
  const modeOpts = { silent: opts?.silent, displayOnly: opts?.displayOnly, signal: opts?.signal };
  const waitStart = Date.now();
  const taskId = await semaphore.acquire(meta, modeOpts);
  const waited = Date.now() - waitStart;
  if (waited > 5000) {
    // 排队超过 5s 才能拿到 slot 说明背压大,打 log 让运维注意
    const s = semaphore.snapshot();
    console.log(
      `[opencode-bg-semaphore] ${label}: waited ${(waited / 1000).toFixed(1)}s for slot ` +
        `(active=${s.active}/${s.max}, waiting=${s.waiting})`,
    );
  }
  let caughtError: unknown = undefined;
  try {
    return await fn();
  } catch (e) {
    caughtError = e;
    throw e;
  } finally {
    semaphore.release(taskId, { error: caughtError }, modeOpts);
  }
}

/** 给监控/admin 接口用的快照. */
export function getBackgroundOpencodeSemaphoreSnapshot() {
  return semaphore.snapshot();
}

/**
 * 所有任务清单: queued + running + 最近 5 分钟完成 (done/failed)。
 * 按 queuedAt 倒序 (最新先)。前端按 status 分组展示。
 */
export function getAllBackgroundOpencodeTasks(): TaskRecord[] {
  return semaphore.tasksSnapshot();
}

/** 前端"删除完成卡片"等场景用,从 ring buffer 摘掉某条任务 (不影响 running 任务的真实生命周期)。 */
export function forgetBackgroundOpencodeTask(id: string): void {
  semaphore.forget(id);
}
