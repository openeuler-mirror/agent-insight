/**
 * 评测任务的全局活跃状态登记表。给 GET /api/observe/data 的 is_evaluating 字段提供判断,
 * 让前端 trace 行能看到"评测中" 标签。
 *
 * 历史 bug + 修复 (2026-05):
 *   1. 之前 `activeTasks` 是 module-level Map, dev HMR / 模块 reload 时被清空,
 *      导致刷新页面"评测中"状态丢失。修复: 挂 globalThis Symbol 防 HMR。
 *   2. 之前 key = `${user}::${taskId}` 让 upload (plugin 上报自动评估) 和 rejudge
 *      (用户主动评测) 共享同一个 entry。两个 source 会互相 `startOrReplace`,
 *      导致老 source 的 finish 因 runId mismatch 不删, entry 永远残留, isActive
 *      永真, UI 卡死"评测中"循环。修复: key 改 `${user}::${taskId}::${source}`,
 *      让两条线互不干扰。isActive 仍按 (user, taskId) 查任意 source。
 *   3. finish 改成按 runId 遍历找 (跨 source), caller 不需要传 source。
 */

type EvaluationSource = "upload" | "rejudge";

type EvaluationTaskRecord = {
  user: string;
  taskId: string;
  source: EvaluationSource;
  runId: string;
  status: "running" | "cancelling";
  startedAt: number;
};

const GLOBAL_KEY = Symbol.for('@witty-insight/evaluation-task-manager');
type GlobalSlot = { activeTasks: Map<string, EvaluationTaskRecord>; version: number };
const globalAny = globalThis as unknown as { [GLOBAL_KEY]?: GlobalSlot };

// 版本号:此文件 schema 变了就 bump,让 HMR 时强制重建 Map (旧 entry 跟新代码 key 格式不兼容)
const SCHEMA_VERSION = 2;

if (!globalAny[GLOBAL_KEY] || globalAny[GLOBAL_KEY].version !== SCHEMA_VERSION) {
  globalAny[GLOBAL_KEY] = { activeTasks: new Map(), version: SCHEMA_VERSION };
}
const activeTasks = globalAny[GLOBAL_KEY]!.activeTasks;

function makeKey(user: string, taskId: string, source: EvaluationSource): string {
  return `${user}::${taskId}::${source}`;
}

function generateRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 启动评测,登记到 activeTasks。同一 (user, taskId, source) 下已有 running entry 时替换,
 * 返回老 runId 让 caller 知道老评测已被取代 (语义: 老的应该早退或被忽略)。
 *
 * upload 和 rejudge 的 entry 独立, 互不替换。
 */
export function startOrReplace(
  user: string,
  taskId: string,
  source: EvaluationSource
): { runId: string; replacedRunId?: string } {
  const key = makeKey(user, taskId, source);
  const runId = generateRunId();
  let replacedRunId: string | undefined;

  const existing = activeTasks.get(key);
  if (existing) {
    existing.status = "cancelling";
    replacedRunId = existing.runId;
    console.log(`[EvalTask] replaced user=${user} task=${taskId} source=${source} oldRun=${replacedRunId} newRun=${runId}`);
  } else {
    console.log(`[EvalTask] start user=${user} task=${taskId} source=${source} run=${runId}`);
  }

  activeTasks.set(key, {
    user,
    taskId,
    source,
    runId,
    status: "running",
    startedAt: Date.now(),
  });

  return { runId, replacedRunId };
}

/**
 * 取消同 (user, taskId, source) 下当前 running 的评测。返回它的 runId 让 caller 通知 evaluator 退出。
 *
 * 注意: 现 key 加了 source, 想取消所有 source 要分别调一次。
 * 现有 caller (eval/rejudge route) 只对 rejudge 自己取消, 不需要跨 source。
 */
export function cancel(
  user: string,
  taskId: string,
  source: EvaluationSource = "rejudge"
): { cancelled: boolean; runId?: string } {
  const key = makeKey(user, taskId, source);
  const existing = activeTasks.get(key);

  if (!existing || existing.status !== "running") {
    console.log(`[EvalTask] cancel - no active task user=${user} task=${taskId} source=${source}`);
    return { cancelled: false };
  }

  existing.status = "cancelling";
  console.log(`[EvalTask] cancel user=${user} task=${taskId} source=${source} run=${existing.runId}`);
  return { cancelled: true, runId: existing.runId };
}

/**
 * (user, taskId) 是否在任意 source 下有 running 评测。用于前端"评测中"判断。
 *
 * 跨 source 检查 —— upload 或 rejudge 任一在跑都算 active。
 */
export function getActive(
  user: string,
  taskId: string
): EvaluationTaskRecord | null {
  for (const record of activeTasks.values()) {
    if (record.user === user && record.taskId === taskId && record.status === "running") {
      return record;
    }
  }
  return null;
}

export function isActive(user: string, taskId: string): boolean {
  return getActive(user, taskId) !== null;
}

export class EvaluationCancelledError extends Error {
  constructor(message: string = "Evaluation cancelled") {
    super(message);
    this.name = "EvaluationCancelledError";
  }
}

/**
 * 验证 runId 仍然是 running 的当前 evaluator。被替换后老 evaluator 调用此函数会抛错,
 * 用于让老 evaluator 中途感知"我已经被取代了"提前退出。
 *
 * 实现: 按 runId 在 activeTasks 里遍历找匹配 record (任意 source)。
 */
export function assertActive(user: string, taskId: string, runId: string): void {
  for (const record of activeTasks.values()) {
    if (record.user === user && record.taskId === taskId && record.runId === runId) {
      if (record.status !== "running") {
        console.log(`[EvalTask] assertActive failed - status=${record.status} user=${user} task=${taskId} run=${runId}`);
        throw new EvaluationCancelledError("Evaluation cancelled");
      }
      return; // OK
    }
  }
  console.log(`[EvalTask] assertActive failed - no matching runId user=${user} task=${taskId} run=${runId}`);
  throw new EvaluationCancelledError("Evaluation superseded or already finished");
}

/**
 * 结束评测,从 activeTasks 摘掉自己那条。按 runId 遍历找 (caller 不需要知道 source)。
 *
 * 即使 record.status === 'cancelling' (被 startOrReplace 标记) 也照样删 —— 此 runId 的
 * evaluator 已经收工, entry 没必要继续占着。新 source 的 evaluator 有自己独立的 entry,
 * 不受影响。
 */
export function finish(user: string, taskId: string, runId: string): void {
  for (const [key, record] of activeTasks.entries()) {
    if (record.user === user && record.taskId === taskId && record.runId === runId) {
      activeTasks.delete(key);
      console.log(`[EvalTask] finish user=${user} task=${taskId} source=${record.source} run=${runId}`);
      return;
    }
  }
  console.log(`[EvalTask] finish - no matching runId user=${user} task=${taskId} run=${runId} (likely already cleaned by HMR or earlier replace)`);
}

export function isCancelled(user: string, taskId: string, runId: string): boolean {
  for (const record of activeTasks.values()) {
    if (record.user === user && record.taskId === taskId && record.runId === runId) {
      return record.status !== "running";
    }
  }
  return true; // 找不到 = 早已被替换/清理 = 已 cancelled
}
