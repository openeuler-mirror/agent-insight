/**
 * 一次性回填 ExecutionSkill(agent 作用域的 trace↔skill 绑定;按 skill+version 反查 trace、统一筛选都用它)。
 *
 * 背景:ExecutionSkill 是新增的可索引绑定表,写入路径(saveExecutionRecord / deriveSubagentExecutions)
 * 会为新 trace 自动填充;既有数据需跑本脚本回填一次。每条 Execution(root 与 sub-agent 行都算)从
 * 自己的 Session.interactions 重算"本层 agent 自己显式调用"的 skill,与读侧同源同口径。
 *
 * 用法(本地 / 部署后各跑一次):
 *   node --import tsx scripts/backfill_execution_skills.ts            # 只回填还没有 ExecutionSkill 的行
 *   node --import tsx scripts/backfill_execution_skills.ts --force    # 全部重算覆盖(delete+recreate,幂等)
 *   DATABASE_URL="file:/abs/path.db" node --import tsx scripts/backfill_execution_skills.ts   # 指定库
 *
 * 分批游标遍历,逐条加载单个 session 的 interactions,避免脚本自身 OOM。
 */
import path from 'node:path';

// 防御:DATABASE_URL 未注入时回落到仓库内 SQLite(Prisma 相对 file: 以 schema.prisma 目录为基准)。
if (!process.env.DATABASE_URL) {
    const dbPath = path.resolve(process.cwd(), 'data/witty_insight.db');
    process.env.DATABASE_URL = `file:${dbPath}`;
}

const FORCE = process.argv.includes('--force');
const BATCH = 200;

async function main() {
    const { prismaRaw } = await import('@/lib/storage/prisma');
    const { recomputeExecutionSkills } = await import('@/lib/storage/data-service');

    let cursor: string | undefined;
    let scanned = 0;
    let updated = 0;
    let skipped = 0;
    let skillRows = 0;

    for (;;) {
        const rows: Array<{ id: string; taskId: string | null; framework: string | null; user: string | null; skill: string | null }> =
            await prismaRaw.execution.findMany({
                select: { id: true, taskId: true, framework: true, user: true, skill: true },
                orderBy: { id: 'asc' },
                take: BATCH,
                ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
            });
        if (rows.length === 0) break;
        cursor = rows[rows.length - 1].id;

        // 非 --force:跳过本批中已经有 ExecutionSkill 的行(可重复运行、断点续跑)。
        const already = new Set<string>();
        if (!FORCE) {
            const have = await prismaRaw.executionSkill.findMany({
                where: { executionId: { in: rows.map(r => r.id) } },
                select: { executionId: true },
                distinct: ['executionId'],
            });
            for (const h of have) already.add(h.executionId);
        }

        for (const row of rows) {
            scanned++;
            if (!FORCE && already.has(row.id)) { skipped++; continue; }
            if (!row.taskId) { skipped++; continue; }

            const session = await prismaRaw.session.findUnique({
                where: { taskId: row.taskId },
                select: { interactions: true },
            });
            let interactions: unknown = null;
            if (session?.interactions) {
                try { interactions = JSON.parse(session.interactions); } catch { interactions = null; }
            }
            if (!Array.isArray(interactions)) { skipped++; continue; }

            try {
                const n = await recomputeExecutionSkills(row.id, row.framework, interactions, row.user, row.skill);
                skillRows += n;
                updated++;
            } catch (e) {
                console.warn(`  ⚠ recompute failed for ${row.id}:`, e);
                skipped++;
            }
        }
        console.log(`  …scanned=${scanned} updated=${updated} skipped=${skipped} skillRows=${skillRows}`);
    }

    console.log(`✅ ExecutionSkill 回填完成:scanned=${scanned} updated=${updated} skipped=${skipped} skillRows=${skillRows}${FORCE ? ' (force)' : ''}`);
    await prismaRaw.$disconnect();
}

main().catch(async (e) => {
    console.error('❌ ExecutionSkill 回填失败:', e);
    try { const { prismaRaw } = await import('@/lib/storage/prisma'); await prismaRaw.$disconnect(); } catch { /* ignore */ }
    process.exit(1);
});
