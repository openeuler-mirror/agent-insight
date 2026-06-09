import { NextResponse } from 'next/server';
import { markUserTerminated } from '@/server/user_termination_registry';
import { abortTrajectoryEvalRunsForUser } from '@/server/trajectory_eval_run_registry';
import { killOpencodeForUser } from '@/lib/engine/skill-generation/opencode-agent-cli/opencode-manager';
import { abortBatchRunsForUser } from '@/app/api/debug/batch-tasks/[taskId]/route';
import { prismaRaw } from '@/lib/storage/prisma';

/**
 * POST /api/eval/terminate-all  body: { user }
 *
 * 「终止全部」——把**该 user 自己**当前在跑的执行 + 评测全部停下(严格按 user 隔离,不碰别人/别的平台任务)。
 * 组合拳:
 *   1) markUserTerminated:choke-point 标记。后台 opencode 统一入口(withBackgroundOpencodeSlot)拿到 slot 后,
 *      凡在此刻之前入队、属于该 user 的任务一律中止 —— 挡住"排队中/即将起"的执行 case 与评测裁判。
 *   2) killOpencodeForUser:SIGKILL 该 user 在跑的后台 opencode 进程组(执行 agent + 评测裁判都是 opencode),
 *      硬停"已经在飞"的。
 *   3) abortTrajectoryEvalRunsForUser:abort 评测 run 的派发/重试循环(防止杀掉后又重试重启)。
 *   4) abortBatchRunsForUser:abort 执行批次循环 + 重置其残留 case。
 *   5) DB 兜底:把该 user 仍 running/pending 的评测行(含进程重启后无 controller 的僵尸)置失败「已终止」。
 */
export async function POST(request: Request) {
    try {
        const body = await request.json().catch(() => ({}));
        const user = String(body?.user || '').trim();
        if (!user) return NextResponse.json({ error: 'user is required' }, { status: 400 });

        markUserTerminated(user);
        const killedOpencode = killOpencodeForUser(user);
        const abortedEvalRuns = abortTrajectoryEvalRunsForUser(user);
        const batch = await abortBatchRunsForUser(user);

        let cancelledEvalRows = 0;
        try {
            const r = await prismaRaw.trajectoryEvalResult.updateMany({
                where: { user, status: { in: ['running', 'pending'] } },
                data: { status: 'failed', errorMessage: '已终止：用户中止了该批次评测' },
            });
            cancelledEvalRows = r.count;
        } catch (e) {
            console.warn('[terminate-all] eval rows DB cleanup failed:', e);
        }

        console.warn(
            `[terminate-all] user=${user} killedOpencode=${killedOpencode} evalRuns=${abortedEvalRuns} ` +
            `batchRuns=${batch.abortedRuns} resetCases=${batch.resetCases} cancelledEvalRows=${cancelledEvalRows}`,
        );
        return NextResponse.json({
            ok: true,
            killedOpencode,
            abortedEvalRuns,
            abortedBatchRuns: batch.abortedRuns,
            resetCases: batch.resetCases,
            cancelledEvalRows,
        });
    } catch (e) {
        const message = e instanceof Error ? e.message : 'terminate-all failed';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
