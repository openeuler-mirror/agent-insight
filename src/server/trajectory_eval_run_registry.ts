/**
 * trajectory 评测「正在跑的 run」内存登记表(按 evaluatorRunId)。
 *
 * 评测在后台 detached promise 里跑,要支持「终止」就得能按 run 拿到它的 AbortController。
 * 同时记录发起 user,以支持"终止某用户的全部评测"(terminateAllForUser)。
 *
 * 挂在 globalThis 上跨 Next 模块重载/HMR 保活(普通 module-level Map 一重载就清空)。
 * 进程**重启**后表为空 —— 重启前残留的 running 行由 DB 兜底(terminate 时把仍 running 的置 cancelled)。
 */
const REGISTRY_SYMBOL = Symbol.for('agent-insight.trajectoryEvalRunControllers');

interface RunEntry { controller: AbortController; user: string; }
type Registry = Map<string, RunEntry>;

function getRegistry(): Registry {
    const g = globalThis as unknown as Record<symbol, Registry | undefined>;
    if (!g[REGISTRY_SYMBOL]) g[REGISTRY_SYMBOL] = new Map();
    return g[REGISTRY_SYMBOL]!;
}

/** 登记一次新评测 run,返回它的 AbortController。 */
export function registerTrajectoryEvalRun(runId: string, user: string): AbortController {
    const controller = new AbortController();
    getRegistry().set(runId, { controller, user });
    return controller;
}

/** 按 runId 拿到该 run 的 signal(供运行中的派发循环 / 单行评测在关键点查"是否已被终止")。 */
export function getTrajectoryEvalRunSignal(runId: string | null | undefined): AbortSignal | undefined {
    if (!runId) return undefined;
    return getRegistry().get(runId)?.controller.signal;
}

/** 终止单条评测 run。返回是否找到 controller(false = 进程内没有,多半是重启后僵尸,走 DB 兜底)。 */
export function abortTrajectoryEvalRun(runId: string): boolean {
    const entry = getRegistry().get(runId);
    if (!entry) return false;
    entry.controller.abort();
    return true;
}

/** 终止某 user 的**全部**评测 run。返回被 abort 的数量。 */
export function abortTrajectoryEvalRunsForUser(user: string): number {
    let n = 0;
    for (const entry of getRegistry().values()) {
        if (entry.user === user && !entry.controller.signal.aborted) {
            entry.controller.abort();
            n++;
        }
    }
    return n;
}

/** run 收尾后注销,避免 Map 无限增长。 */
export function unregisterTrajectoryEvalRun(runId: string): void {
    getRegistry().delete(runId);
}
