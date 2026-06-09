/**
 * 服务崩溃/重启后,grayscale 任务 caseStatesJson 里残留的非终态 run 的"启动回收"处置(纯逻辑,可测)。
 *
 * 关键修复:旧实现把所有中断的 run 一律标成 status='fail' + failureType='agent_error'(执行失败)。
 * 但"评测被重启打断"的 run 其实**执行已经成功**(有 sessionId)——把它标成执行失败会:
 *   ① UI 显示「执行失败」(误导,执行其实成功了);
 *   ② 挡住重评(重评只挑 executed/evaluating 的 run,fail 的挑不到)→ 用户重试也跑不动、且看不到原因。
 * 正确处置:这类 run 应回到 'executed'(执行完成、评测待跑)→ 可干净重评。
 */

export type StaleReconcileStatus = 'pending' | 'running' | 'executed' | 'evaluating' | 'pass' | 'fail';

export interface StaleReconcilableRun {
    status: StaleReconcileStatus;
    sessionId?: string;
    failureType?: string;
    failureDetail?: string;
    output?: string;
    evaluations?: Array<{ status: string; errorMessage?: string }>;
    evaluationClaimId?: string;
    evaluationResultId?: string;
    evaluatorRunId?: string;
    evalRetryPending?: boolean;
}

const STALE_RESTART_RE = /服务重启|server[ _-]*restart|restarted|（stale）|\(stale\)/i;

/** 这条 run 的失败是不是"服务重启/崩溃残骸"(而非真实失败)。 */
export function isStaleCrashArtifact(run: StaleReconcilableRun): boolean {
    const text = [run.output, run.failureDetail, ...((run.evaluations || []).map(e => e.errorMessage || ''))]
        .filter(Boolean)
        .join(' ');
    return STALE_RESTART_RE.test(text);
}

/**
 * 对单条 run 做启动回收处置。直接 mutate 传入对象;返回是否改动。
 *   - evaluating 且有 sessionId(执行完成、评测被打断)→ executed(可重评),清掉本次未完成的评测痕迹;
 *   - 已是 fail 但属于"服务重启"崩溃残骸且有 sessionId → 同样回到 executed(自愈历史卡死的失败);
 *   - running / pending / evaluating-但无 sessionId(执行真没跑完)→ 执行失败 agent_error;
 *   - 其它(done/pass/真实失败)→ 不动。
 */
export function reconcileStaleGrayscaleRun(run: StaleReconcilableRun, reason: string): boolean {
    const executedButEvalInterrupted =
        (run.status === 'evaluating' && !!run.sessionId)
        || (run.status === 'fail' && !!run.sessionId && isStaleCrashArtifact(run));

    if (executedButEvalInterrupted) {
        run.status = 'executed';
        run.failureType = undefined;
        run.failureDetail = undefined;
        run.output = undefined;
        run.evalRetryPending = false;
        run.evaluationClaimId = undefined;
        run.evaluationResultId = undefined;
        run.evaluatorRunId = undefined;
        run.evaluations = (run.evaluations || []).filter(e => e.status === 'done');
        return true;
    }

    if (run.status === 'running' || run.status === 'pending' || run.status === 'evaluating') {
        run.status = 'fail';
        run.failureType = 'agent_error';
        run.failureDetail = run.failureDetail || reason;
        run.output = run.output || '服务重启中断';
        return true;
    }

    return false;
}
