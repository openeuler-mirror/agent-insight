/**
 * 服务崩溃/重启后,grayscale 任务 caseStatesJson 里残留的非终态 run 的"启动回收/解卡"处置(纯逻辑,可测)。
 *
 * 设计要点(2026-06 调整为「解卡但不自动重评」):
 *   背景: run 崩溃时卡在 evaluating 这种中间态、还带着认领锁,没有任何进程在真的跑它。若不处理,
 *   它会永远显示"评测中"转圈,而且系统以为它在跑 → 连重试按钮都不给 → 用户彻底卡死。所以"解卡"
 *   这一步是必须的,它把僵死的中间态恢复成一个"用户能操作"的状态。
 *
 *   关键: 解卡只负责把状态摆正、让重试按钮出现,**绝不自动重评**(自动重评由 GET handler 那边一并移除)。
 *
 *   处置规则:
 *     ① 评测被打断(执行已成功、有 sessionId) → 标成「执行完成 + 评测失败(中断)」:
 *          status='fail' 且 failureType 留空(关键!failureType 一旦有值前端会当"执行失败"显示「重跑」)。
 *          前端据此渲染成"评测失败" → 显示「重评」按钮(仅重评、复用 session) → 用户点了才跑。
 *     ② 但若这条 run 其实早已评完(所有评估器 done、有分),只是被崩溃误标 → 直接恢复成「已评测」(pass)
 *          并保留分数,连重评都不用 —— 避免"明明有分却又被退回去重评一遍"。
 *     ③ 执行真没跑完(running/pending/evaluating 但无 sessionId)→ 执行失败 agent_error(显示「重跑」)。
 *     ④ 其它(done/pass/executed/真实失败)→ 不动。
 */

export type StaleReconcileStatus = 'pending' | 'running' | 'executed' | 'evaluating' | 'pass' | 'fail';

export interface StaleReconcilableRun {
    status: StaleReconcileStatus;
    sessionId?: string;
    failureType?: string;
    failureDetail?: string;
    output?: string;
    score?: number;
    evaluations?: Array<{ status: string; errorMessage?: string; evaluatorId?: string }>;
    evaluationClaimId?: string;
    evaluationResultId?: string;
    evaluatorRunId?: string;
    evalRetryPending?: boolean;
}

const STALE_RESTART_RE = /服务重启|服务中断|server[ _-]*restart|restarted|（stale）|\(stale\)/i;

/** 用户能直接看懂的"评测被服务中断"提示,同时也是 isStaleCrashArtifact 的识别标记。 */
export const EVAL_INTERRUPTED_MESSAGE = '服务中断，评测未完成，请点击「重评」重试';

/** 这条 run 的失败是不是"服务重启/崩溃残骸"(而非真实失败)。 */
export function isStaleCrashArtifact(run: StaleReconcilableRun): boolean {
    const text = [run.output, run.failureDetail, ...((run.evaluations || []).map(e => e.errorMessage || ''))]
        .filter(Boolean)
        .join(' ');
    return STALE_RESTART_RE.test(text);
}

/**
 * 对单条 run 做启动回收/解卡处置。直接 mutate 传入对象;返回是否改动。
 * 详见文件头注释。注意: 本函数**只解卡、不触发任何评测**。
 */
export function reconcileStaleGrayscaleRun(run: StaleReconcilableRun, reason: string): boolean {
    const evalInterrupted =
        (run.status === 'evaluating' && !!run.sessionId)
        || (run.status === 'fail' && !!run.sessionId && isStaleCrashArtifact(run));

    if (evalInterrupted) {
        const evals = run.evaluations || [];
        const doneEvals = evals.filter(e => e.status === 'done');
        const hasIncompleteEval = evals.some(e => (
            e.status === 'pending' || e.status === 'running' || e.status === 'failed'
        ));

        // ② 其实早已评完、只是被崩溃误标 → 恢复成「已评测」并保留分数,不重评。
        if (typeof run.score === 'number' && doneEvals.length > 0 && !hasIncompleteEval) {
            run.status = 'pass';
            run.failureType = undefined;
            run.failureDetail = undefined;
            run.output = undefined;
            run.evalRetryPending = false;
            run.evaluationClaimId = undefined;
            run.evaluations = doneEvals;
            return true;
        }

        // ① 评测真被打断 → 「执行完成 + 评测失败(中断)」,等用户点「重评」。
        const nextEvals = evals.map(e => (
            (e.status === 'pending' || e.status === 'running')
                ? { ...e, status: 'failed', errorMessage: EVAL_INTERRUPTED_MESSAGE }
                : e
        ));
        run.status = 'fail';
        run.failureType = undefined;        // 关键: 留空 → 前端当"评测失败"(显示「重评」),不是"执行失败"(「重跑」)
        run.failureDetail = undefined;
        run.output = EVAL_INTERRUPTED_MESSAGE;
        run.score = undefined;              // 清掉可能的部分分,重评后重算
        run.evalRetryPending = false;
        run.evaluationClaimId = undefined;
        run.evaluationResultId = undefined;
        run.evaluatorRunId = undefined;     // 让 onlyMissingEvaluation 的重评能干净命中
        run.evaluations = nextEvals.length > 0
            ? nextEvals
            : [{ status: 'failed', errorMessage: EVAL_INTERRUPTED_MESSAGE }];
        return true;
    }

    // ③ 执行真没跑完(无 sessionId)→ 执行失败。
    if (run.status === 'running' || run.status === 'pending' || run.status === 'evaluating') {
        run.status = 'fail';
        run.failureType = 'agent_error';
        run.failureDetail = run.failureDetail || reason;
        run.output = run.output || '服务重启中断';
        return true;
    }

    return false;
}
