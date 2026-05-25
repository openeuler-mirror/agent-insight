/**
 * 一次性回填脚本：把已经入库的 OpenCode root Execution 重新过一遍 deriveSubagentExecutions，
 * 派生出 sub-agent Execution + Session 行（之前旧的 dedup 逻辑把它们删掉了）。
 *
 * 用法：
 *   npx tsx scripts/backfill_subagent_executions.ts                 # 全量
 *   npx tsx scripts/backfill_subagent_executions.ts ses_xxx ses_yyy # 只回填指定 root taskId
 *
 * 幂等：deriveSubagentExecutions 用 deterministic id `<parent>__sub__<sid>`，重复跑不会产生重复行。
 */
import { PrismaClient } from '@prisma/client';
import { deriveSubagentExecutions } from '../src/lib/storage/data-service';

const prisma = new PrismaClient();

async function main() {
    const argTaskIds = process.argv.slice(2).filter(Boolean);
    const whereClause: any = { framework: 'opencode', isSubagent: false };
    if (argTaskIds.length > 0) {
        whereClause.taskId = { in: argTaskIds };
    }

    const executions = await prisma.execution.findMany({
        where: whereClause,
        orderBy: { timestamp: 'desc' },
    });

    console.log(`[Backfill] Found ${executions.length} opencode root executions to scan` +
        (argTaskIds.length > 0 ? ` (filtered to ${argTaskIds.length} taskIds)` : ''));

    let scanned = 0;
    let withSubagents = 0;
    let totalDerived = 0;

    for (const exec of executions) {
        scanned++;
        if (!exec.taskId) continue;

        const session = await prisma.session.findUnique({ where: { taskId: exec.taskId } });
        if (!session?.interactions) continue;

        let interactions: any[];
        try {
            interactions = JSON.parse(session.interactions as unknown as string);
            if (!Array.isArray(interactions)) continue;
        } catch (e) {
            console.warn(`[Backfill] Skip ${exec.taskId}: interactions JSON parse failed`);
            continue;
        }

        const subagentSidSet = new Set<string>();
        for (const it of interactions) {
            const sid = typeof (it as any)?.subagent_session_id === 'string'
                ? (it as any).subagent_session_id.trim()
                : '';
            if (sid && sid !== exec.taskId) subagentSidSet.add(sid);
        }
        if (subagentSidSet.size === 0) continue;

        withSubagents++;

        try {
            await deriveSubagentExecutions({
                parentExecutionId: exec.id,
                parentTaskId: exec.taskId,
                parentFramework: exec.framework ?? null,
                parentUser: exec.user ?? null,
                interactions,
            });
            totalDerived += subagentSidSet.size;
            console.log(`[Backfill] ✓ ${exec.taskId} → derived ${subagentSidSet.size} sub-agent rows`);
        } catch (e) {
            console.warn(`[Backfill] ✗ ${exec.taskId} failed:`, e);
        }
    }

    console.log(
        `\n[Backfill] Done. scanned=${scanned}, root_with_subagents=${withSubagents}, ` +
        `total_subagent_rows_derived=${totalDerived}`,
    );
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
