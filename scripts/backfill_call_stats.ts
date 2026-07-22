/**
 * 一次性回填 Execution.callStats（大盘 B 档 per-call 摘要，写入路径已对新 trace 自动填充）。
 *
 * 与写入路径共用同一个 computeCallStats 纯函数——回填出的历史摘要与新数据口径完全一致。
 * 状态全部落在 callStats 列本身，无外部进度文件：
 *   NULL                  = 未处理（候选）
 *   {"v":1,"err":true}    = 处理过但失败/无 session 数据（哨兵，默认不再重试）
 *   其他                  = 有效摘要（跳过）
 * 因此脚本幂等可重入：重复执行/中断重跑都只处理剩余候选行，不会重复计算。
 *
 * 用法（手动执行，绝不随服务启动自动跑；跑前建议备份 DB）：
 *   node --import tsx scripts/backfill_call_stats.ts                 # 回填近 30 天 callStats 为空的行
 *   node --import tsx scripts/backfill_call_stats.ts --days 7        # 只回填近 7 天
 *   node --import tsx scripts/backfill_call_stats.ts --dry-run       # 干跑：只统计可回填质量，不写库
 *   node --import tsx scripts/backfill_call_stats.ts --retry-failed  # 连同哨兵失败行一起重试
 *   DATABASE_URL="file:/abs/path.db" node --import tsx scripts/backfill_call_stats.ts   # 指定库
 *
 * 资源边界（对齐 docs/design/fleet-dashboard-tier-b-preparse-risk.md R5）：
 * 分批游标 + 逐条加载单个 session（不整表拉 interactions），批间 sleep 让写锁给 ingest 穿插。
 */
import { prismaRaw } from '@/lib/storage/prisma';
import { computeCallStats, parseCallStats } from '@/lib/fleet/call-stats';

const DRY_RUN = process.argv.includes('--dry-run');
const RETRY_FAILED = process.argv.includes('--retry-failed');
const daysArg = process.argv.indexOf('--days');
const DAYS = daysArg >= 0 ? Math.max(1, Number(process.argv[daysArg + 1]) || 30) : 30;

const BATCH = 50;
const SLEEP_MS = 200;
const SENTINEL = JSON.stringify({ v: 1, err: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const cutoff = new Date(Date.now() - DAYS * 86_400_000);
    console.log(`回填范围：timestamp ≥ ${cutoff.toISOString()}（近 ${DAYS} 天）${DRY_RUN ? ' [dry-run]' : ''}${RETRY_FAILED ? ' [retry-failed]' : ''}`);

    let cursor: string | undefined;
    let scanned = 0, ok = 0, empty = 0, failed = 0, noSession = 0, skipped = 0;
    const t0 = Date.now();

    for (;;) {
        const rows: Array<{ id: string; taskId: string | null; model: string | null; failures: string | null; callStats: string | null }> =
            await prismaRaw.execution.findMany({
                where: { timestamp: { gte: cutoff } },
                select: { id: true, taskId: true, model: true, failures: true, callStats: true },
                orderBy: { id: 'asc' },
                take: BATCH,
                ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
            });
        if (rows.length === 0) break;
        cursor = rows[rows.length - 1].id;

        for (const row of rows) {
            scanned++;
            // 候选判定：NULL 必处理；哨兵仅 --retry-failed 时处理；有效摘要一律跳过
            if (row.callStats != null) {
                const isSentinel = parseCallStats(row.callStats) == null;
                if (!isSentinel || !RETRY_FAILED) { skipped++; continue; }
            }

            let statsJson: string = SENTINEL;
            let kind: 'ok' | 'empty' | 'noSession' | 'failed' = 'noSession';
            try {
                const session = row.taskId
                    ? await prismaRaw.session.findUnique({ where: { taskId: row.taskId }, select: { interactions: true } })
                    : null;
                if (session?.interactions) {
                    const interactions = JSON.parse(session.interactions);
                    const stats = computeCallStats(Array.isArray(interactions) ? interactions : [], {
                        fallbackModel: row.model,
                        failures: row.failures,
                    });
                    statsJson = JSON.stringify(stats);
                    // 干跑质量口径：llm/tool 都为空的摘要视作「空」（session 存在但解析不出调用）
                    kind = (Object.keys(stats.llm).length || Object.keys(stats.tool).length) ? 'ok' : 'empty';
                }
            } catch (e) {
                kind = 'failed';
                console.warn(`  ⚠ ${row.id} 计算失败:`, e instanceof Error ? e.message : e);
            }
            if (kind === 'ok') ok++; else if (kind === 'empty') empty++; else if (kind === 'failed') failed++; else noSession++;

            if (!DRY_RUN) {
                await prismaRaw.execution.update({ where: { id: row.id }, data: { callStats: statsJson } });
            }
        }
        console.log(`  …scanned=${scanned} ok=${ok} empty=${empty} noSession=${noSession} failed=${failed} skipped=${skipped}`);
        await sleep(SLEEP_MS);
    }

    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    const candidates = ok + empty + failed + noSession;
    console.log(`\n${DRY_RUN ? '🔎 dry-run 完成（未写库）' : '✅ 回填完成'}：${dur}s`);
    console.log(`  扫描 ${scanned} 行，候选 ${candidates}，已有摘要跳过 ${skipped}`);
    console.log(`  有效摘要 ${ok} · 空摘要 ${empty} · 无 session ${noSession} · 计算失败 ${failed}`);
    if (candidates > 0) {
        console.log(`  有效率 ${(ok / candidates * 100).toFixed(1)}%${DRY_RUN ? '（低于预期请勿正式回填，先排查字段兼容性）' : ''}`);
    }
    await prismaRaw.$disconnect();
}

main().catch(async (e) => { console.error('❌ 回填失败:', e); await prismaRaw.$disconnect(); process.exit(1); });
