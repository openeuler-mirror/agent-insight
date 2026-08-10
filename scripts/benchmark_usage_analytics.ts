/**
 * 平台用量统计性能基准（Phase3 Wave 6）。
 *
 * 在隔离的临时数据库上跑，绝不接触用户默认数据库。
 *   npx tsx scripts/benchmark_usage_analytics.ts [--users=1000] [--days=365] [--events=1000000]
 *
 * 输出：入队 p95、flush p95、查询 p95、RSS、丢弃数。
 * 阈值参考（Phase2 §12）：入队 p95 < 0.2ms；30/90 天查询 p95 < 300ms；全部 < 800ms。
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const arg = (name: string, dflt: number) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? Number(hit.split('=')[1]) : dflt;
};

const USERS = arg('users', 1000);
const DAYS = arg('days', 365);
const EVENTS = arg('events', 1_000_000);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-bench-'));
const dbFile = path.join(tmpDir, 'bench.db');
process.env.DATABASE_URL = `file:${dbFile}`;
delete process.env.DB_HOST;
process.env.AGENT_INSIGHT_USAGE_ENABLED = '1';

function p95(xs: number[]): number {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

function rssMb() {
    return Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10;
}

async function main() {
    console.log(`[bench] temp db: ${dbFile}`);
    console.log(`[bench] users=${USERS} days=${DAYS} events=${EVENTS}`);

    execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate'], {
        env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
        stdio: 'inherit',
    });

    const { USAGE_FEATURES } = await import('@/lib/usage-analytics/catalog');
    const { PrismaUsageStorage } = await import('@/lib/usage-analytics/storage');
    const { UsageQueue } = await import('@/lib/usage-analytics/queue');
    const { getUsageSummary, getUsageFeatureDetail } = await import('@/lib/usage-analytics/queries');
    const { toDateKey } = await import('@/lib/usage-analytics/date');

    const storage = new PrismaUsageStorage();
    const queue = new UsageQueue(storage);

    const events = USAGE_FEATURES.flatMap((f) => f.uses.map((u) => ({ feature: f.key, event: u.key })));
    const enqueueTimes: number[] = [];
    const flushTimes: number[] = [];

    const startedAt = Date.now();
    let produced = 0;

    while (produced < EVENTS) {
        const pick = events[produced % events.length];
        const dayOffset = produced % DAYS;
        const occurredAt = new Date(Date.now() - dayOffset * 86_400_000);

        const t0 = process.hrtime.bigint();
        queue.enqueue({
            eventId: `b-${produced}`,
            occurredAt,
            dateKey: toDateKey(occurredAt),
            user: `user-${produced % USERS}`,
            featureKey: pick.feature,
            eventKey: pick.event,
            source: 'server',
            route: null,
        });
        enqueueTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
        produced++;

        // 生产循环是同步的，enqueue 内部的 void flush() 排不上微任务，必须在这里主动排空，
        // 否则队列会假性溢出、把基准测成"全是 drop"。先 settle 等在途 flush 结束，
        // 不然 flush() 会因 flushing=true 直接 return，循环空转不推进。
        while (queue.depth >= 200) {
            await queue.settle();
            const f0 = Date.now();
            await queue.flush();
            flushTimes.push(Date.now() - f0);
        }

        if (produced % 100_000 === 0) {
            console.log(`[bench] produced=${produced} depth=${queue.depth} rss=${rssMb()}MB dropped=${queue.stats().dropped}`);
        }
    }
    await queue.drain();

    const writeSec = Math.round((Date.now() - startedAt) / 100) / 10;
    console.log(`\n[bench] 写入完成 ${produced} 事件，用时 ${writeSec}s`);
    console.log(`[bench] usage.enqueue p95      = ${p95(enqueueTimes).toFixed(4)} ms  (阈值 < 0.2)`);
    console.log(`[bench] usage.flush p95        = ${p95(flushTimes)} ms`);
    console.log(`[bench] usage.queue.dropped    = ${queue.stats().dropped}`);
    console.log(`[bench] usage.flush.failures   = ${queue.stats().failures}`);
    console.log(`[bench] RSS                    = ${rssMb()} MB`);

    console.log('\n[bench] 查询延迟：');
    for (const range of ['7', '30', '90', 'all'] as const) {
        const times: number[] = [];
        for (let i = 0; i < 5; i++) {
            const t0 = Date.now();
            await getUsageSummary(range, new Date(), storage);
            times.push(Date.now() - t0);
        }
        const threshold = range === 'all' ? 800 : 300;
        const v = p95(times);
        console.log(`[bench]   summary range=${range.padEnd(3)} p95 = ${String(v).padStart(5)} ms  (阈值 < ${threshold}) ${v < threshold ? 'PASS' : 'FAIL'}`);
    }

    for (const range of ['30', 'all'] as const) {
        const times: number[] = [];
        for (let i = 0; i < 5; i++) {
            const t0 = Date.now();
            await getUsageFeatureDetail('trace', range, new Date(), storage);
            times.push(Date.now() - t0);
        }
        console.log(`[bench]   feature range=${range.padEnd(3)} p95 = ${String(p95(times)).padStart(5)} ms`);
    }

    console.log(`\n[bench] 临时数据库保留在 ${dbFile}，可手动删除 ${tmpDir}`);
}

main().catch((e) => {
    console.error('[bench] failed:', e);
    process.exit(1);
});
