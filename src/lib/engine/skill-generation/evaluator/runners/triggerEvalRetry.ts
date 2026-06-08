/**
 * 触发评测 runner 的「结束原因分类 + 超时重试」纯逻辑。
 *
 * 从 triggerEval.ts 抽出来单放一处的原因：这部分是 runner 里唯一带分支判断的逻辑
 * （命中/跑完/超时/报错怎么分、超时该不该重试、重试几次），值得单测；而把它留在
 * triggerEval.ts 里会被 opencode client / prisma 等重依赖裹住，单测一 import 就拖一坨。
 * 这里全是纯函数，测试只 import 本文件，跑得快、无副作用。
 */

/**
 * 一次 run 的结束原因——用来区分"跑完 vs 没跑完"：
 *   - triggered: 命中目标 skill（命中即 abort，省 token）
 *   - completed: 跑到自然结束（idle）但没命中目标 skill —— 这是真实的"没触发"信号
 *   - timeout:   被单条超时掐断，没跑到路由决策 —— 不是"没触发"，是"没跑完"
 *   - error:     opencode 服务端报错（agent 名不认 / provider 拒绝 / apiKey 失效等），根本没问到模型
 * triggered / completed = 真正产出了路由决策；timeout / error = 没跑完。
 */
export type TriggerEndReason = 'triggered' | 'completed' | 'timeout' | 'error';

/**
 * 结束原因判定。优先级：命中 > 报错 > 超时 > 自然跑完。
 *   triggered → 命中目标 skill；error → 捕获到 session.error；
 *   timeout → 我们的硬超时 timer 先触发了 abort；completed → 跑到自然 idle 没命中（真实"没触发"）。
 * 注意优先级顺序：报错排在超时前——一次 run 既报错又恰好撞上超时时，按"根本没问到模型"算更准。
 */
export function classifyEndReason(o: {
  triggered: boolean;
  sessionError?: string;
  timedOut: boolean;
}): TriggerEndReason {
  if (o.triggered) return 'triggered';
  if (o.sessionError) return 'error';
  if (o.timedOut) return 'timeout';
  return 'completed';
}

/**
 * 超时重试次数上限。默认 2（共 3 次尝试），可用 env 覆盖；clamp 到 [0, 5] 防手滑。
 */
export function resolveMaxTimeoutRetries(
  rawEnv: string | undefined = process.env.TRIGGER_EVAL_TIMEOUT_RETRIES,
): number {
  const raw = Number(rawEnv ?? 2);
  if (!Number.isFinite(raw)) return 2;
  return Math.max(0, Math.min(5, Math.floor(raw)));
}

export const MAX_TIMEOUT_RETRIES = resolveMaxTimeoutRetries();

/**
 * 跑一次 query；**只在超时**（endReason==='timeout'）时自动重试，最多 maxRetries 次。
 *   - 'completed'（自然跑完没触发）是真实信号，重试只会虚高触发率；
 *   - 'error'（opencode 报错）多是配置类硬错（agent 名 / apiKey），重试是同样的错、白烧 token；
 *   - 'triggered' 已命中，不用重试。
 * isAborted() 为真（用户点了终止）时立刻停手、不再重试。返回结果带 attempts（实际跑了几次）。
 */
export async function retryOnTimeout<T extends { endReason: TriggerEndReason }>(
  runOnce: () => Promise<T>,
  opts: {
    maxRetries: number;
    isAborted?: () => boolean;
    /** 每次决定重试前回调（attempt 从 1 起，是"即将开始的第几次重试"）。 */
    onRetry?: (attempt: number) => void;
  },
): Promise<T & { attempts: number }> {
  let last = await runOnce();
  let attempts = 1;
  while (last.endReason === 'timeout' && attempts <= opts.maxRetries && !opts.isAborted?.()) {
    opts.onRetry?.(attempts);
    last = await runOnce();
    attempts++;
  }
  return { ...last, attempts };
}
