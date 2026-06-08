/**
 * trajectory 评测运行的"护栏"纯逻辑(无重依赖,可单测)。
 *
 * 拆出来的原因:这些规则直接关系到 119 上"并行跑多个评测任务 → next-server 堆 OOM 崩溃"的修复,
 * 必须能被单测锁死;但评测 run 路由(route.ts)拉了一大堆 server-only 依赖,测试里 import 不进来。
 */

/** 标记"这条 trace 压根没有可评测的 case"——属于确定性失败,不该重试。 */
export const NO_EVALUABLE_CASE_PREFIX = '[no-evaluable-case]';

/**
 * 结果评测失败是否值得重试。
 *
 * 默认可重试(瞬时错误,如网络/模型抖动);但**确定性**失败(配置/数据缺失、trace 行为本身不合规)
 * 重试只会原样再失败一遍,白白重跑重型 opencode agent + 累积 next-server 堆 —— 必须判为不可重试。
 *
 * 其中 `不允许派发子代理` 是 119 堆 OOM 的主放大器:被评测的 agent 派发了子代理(评测器不允许),
 * 同一条 trace 每次重试都会再派发、再失败,5 次重试 = 5× ~900MB opencode 跑 + 堆累积。
 */
export function isRetryableResultEvaluationFailure(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error || '');
    if (!message.trim()) return false;
    if (message.includes(NO_EVALUABLE_CASE_PREFIX)) return false;
    if (message.includes('缺少预期结果')) return false;
    if (message.includes('expectedOutput')) return false;
    if (message.includes('trace 没有实际输入')) return false;
    if (message.includes('Session.interactions JSON 解析失败')) return false;
    if (message.includes('Session 不存在或 interactions 为空')) return false;
    if (message.includes('读取数据集失败')) return false;
    if (message.includes('未匹配到可评测 case')) return false;
    if (message.includes('评估数据集不存在')) return false;
    if (message.includes('写入评测结果失败')) return false;
    if (message.includes('结果输出提取失败')) return false;
    // 确定性:评测器禁止派发子代理,重试只会重复触发 → 一次即止,堵住堆 OOM 主放大器。
    if (message.includes('不允许派发子代理')) return false;
    // 被「终止全部」打断(choke-point guard 抛 AbortError / opencode 进程被 SIGKILL)→ 绝不重试,
    // 否则终止后又把重型 opencode 重启回来。
    if (error instanceof Error && error.name === 'AbortError') return false;
    if (message.includes('已终止') || message.includes('用户中止') || message.includes('aborted: user terminated')) return false;
    return true;
}

export interface SimpleAsyncLimiter {
    acquire: () => Promise<void>;
    release: () => void;
}

/**
 * 最小计数信号量:同时最多 `max` 个持有者,多出来的在 acquire 处排队,release 时按 FIFO 放行。
 * 关键不变量:release 把 slot 直接交给下一个 waiter(active 不变),无 waiter 才递减 —— 这样
 * 任意 acquire/release 交错下 active 都不会漂移、也不会"释放过头"。配 try/finally 用即不泄漏。
 */
export function createSimpleAsyncLimiter(max: number): SimpleAsyncLimiter {
    const cap = Math.max(1, Math.floor(max));
    let active = 0;
    const waiters: Array<() => void> = [];
    return {
        acquire: () => new Promise<void>(resolve => {
            if (active < cap) { active++; resolve(); }
            else waiters.push(resolve);
        }),
        release: () => {
            const next = waiters.shift();
            if (next) next();
            else active = Math.max(0, active - 1);
        },
    };
}
