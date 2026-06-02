/**
 * 触发评测「正在跑的 run」内存登记表。
 *
 * 评测异步化后跑在后台 detached promise 里——要支持「终止」，就得有个地方按 runId 拿到那次跑用的
 * AbortController。app 是单个长驻 node 进程（npm start），进程内的一张 Map 就够用，不需要外部队列。
 *
 * 为什么挂在 globalThis 上：Next dev / Turbopack HMR 会重载模块，普通 module-level Map 一重载就被清空，
 * 导致刚起的 run 找不到自己的 controller。用 Symbol.for + globalThis 跨重载保活。
 *
 * 注意：进程**重启**后这张表必然为空。这时去终止一个重启前残留的 running run 拿不到 controller，
 * 由 cancel 路由的 DB 兜底（直接把仍是 running 的那条置 cancelled）兜住。
 */
const REGISTRY_SYMBOL = Symbol.for('agent-insight.triggerEvalRunControllers');

type Registry = Map<string, AbortController>;

function getRegistry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  if (!g[REGISTRY_SYMBOL]) g[REGISTRY_SYMBOL] = new Map();
  return g[REGISTRY_SYMBOL]!;
}

/** 登记一次新 run，返回它的 AbortController（把 signal 穿进 runner）。 */
export function registerTriggerEvalRun(runId: string): AbortController {
  const controller = new AbortController();
  getRegistry().set(runId, controller);
  return controller;
}

/**
 * 终止某条 run：abort 它的 controller。
 * 返回是否真的找到了 controller（false = 进程内没有这次 run，多半是重启后的僵尸，需走 DB 兜底）。
 */
export function abortTriggerEvalRun(runId: string): boolean {
  const controller = getRegistry().get(runId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** run 收尾后注销，避免 Map 无限增长。 */
export function unregisterTriggerEvalRun(runId: string): void {
  getRegistry().delete(runId);
}
