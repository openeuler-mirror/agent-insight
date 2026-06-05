/**
 * 一次性回填 Execution.observedAgents(轻量列表 fields=light 用它还原 agents,避免解析 interactions)。
 *
 * 背景:observedAgents 是新增的 denormalized 列,写入路径(saveExecutionRecord)会为新 trace 自动填充;
 * 既有数据需跑本脚本回填一次。与读侧 heavy 的 extractObservedAgentNames(interactions) 同源同口径,
 * 保证 light 与 heavy 的 agents 完全一致、不丢任何 agent 名(含 opencode 'build' 等)。
 *
 * 用法(本地 / 119 上各跑一次,部署后):
 *   node --import tsx scripts/backfill_observed_agents.ts            # 只回填 observedAgents 为空的行
 *   node --import tsx scripts/backfill_observed_agents.ts --force    # 全部重算覆盖
 *   DATABASE_URL="file:/abs/path.db" node --import tsx scripts/backfill_observed_agents.ts   # 指定库
 *
 * 分批游标遍历,逐条加载单个 session 的 interactions,避免脚本自身 OOM。
 */
import { prismaRaw } from '@/lib/storage/prisma';
import { extractObservedAgentNames } from '@/lib/engine/observability/agent-registration';

const FORCE = process.argv.includes('--force');
const BATCH = 200;

async function main() {
    let cursor: string | undefined;
    let scanned = 0;
    let updated = 0;
    let skipped = 0;

    for (;;) {
        const rows: Array<{ id: string; taskId: string | null; observedAgents: string | null }> =
            await prismaRaw.execution.findMany({
                select: { id: true, taskId: true, observedAgents: true },
                orderBy: { id: 'asc' },
                take: BATCH,
                ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
            });
        if (rows.length === 0) break;
        cursor = rows[rows.length - 1].id;

        for (const row of rows) {
            scanned++;
            if (!FORCE && row.observedAgents != null) { skipped++; continue; }
            if (!row.taskId) { skipped++; continue; }
            const session = await prismaRaw.session.findUnique({
                where: { taskId: row.taskId },
                select: { interactions: true },
            });
            let interactions: unknown = null;
            if (session?.interactions) {
                try { interactions = JSON.parse(session.interactions); } catch { interactions = null; }
            }
            const names = Array.isArray(interactions) ? extractObservedAgentNames(interactions) : [];
            await prismaRaw.execution.update({
                where: { id: row.id },
                data: { observedAgents: JSON.stringify(names) },
            });
            updated++;
        }
        console.log(`  …scanned=${scanned} updated=${updated} skipped=${skipped}`);
    }

    console.log(`✅ backfill 完成:scanned=${scanned} updated=${updated} skipped=${skipped}${FORCE ? ' (force)' : ''}`);
    await prismaRaw.$disconnect();
}

main().catch(async (e) => { console.error('❌ backfill 失败:', e); await prismaRaw.$disconnect(); process.exit(1); });
