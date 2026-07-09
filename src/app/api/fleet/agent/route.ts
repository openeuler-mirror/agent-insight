// 单个 Agent 的下钻统计端点（仪表盘图表点击某 Agent 时调用）。
// 作用域 = 当前登录用户(?user=) + 时间窗；口径同 src/lib/fleet/agg.ts（self：只看 agentName=该 agent 的行）。
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import { resolveUser } from '@/lib/auth/auth';
import {
    normalizeWindow, planOf, bucketStarts, bucketLabel, pct,
    isSuccess, rowTokens, rowCost, assignBuckets, type FleetRow,
} from '@/lib/fleet/agg';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    try {
        const url = new URL(req.url);
        const name = (url.searchParams.get('name') || '').trim();
        if (!name) return NextResponse.json({ error: '缺少 name 参数' }, { status: 400 });

        const { username } = await resolveUser(req, url.searchParams.get('user'));
        const userFilter = username ? { user: username } : {};
        const window = normalizeWindow(url.searchParams.get('window'));
        const plan = planOf(window);
        const now = new Date();
        const starts = bucketStarts(now, plan);
        const from = starts[0];

        const rows = (await prisma.execution.findMany({
            where: { ...userFilter, agentName: name, timestamp: { gte: new Date(from) } },
            select: {
                id: true, taskId: true, rootExecutionId: true, timestamp: true, latency: true,
                toolCallCount: true, toolCallErrorCount: true, llmCallCount: true, failures: true,
                inputTokens: true, outputTokens: true, tokens: true,
                cacheReadInputTokens: true, cacheCreationInputTokens: true, model: true,
            },
        })) as (FleetRow & { id: string })[];

        const missing = new Set<string>();
        const n = rows.length;
        const success = rows.filter(isSuccess).length;
        const latencies = rows.map((r) => r.latency).filter((v): v is number => v != null && v > 0);
        const traceSet = new Set(rows.map((r) => r.rootExecutionId || r.taskId || r.id));
        let inp = 0, out = 0, tot = 0, cost = 0, toolCalls = 0, toolErr = 0, llm = 0;
        for (const r of rows) {
            const tk = rowTokens(r);
            inp += tk.input; out += tk.output; tot += tk.total; cost += rowCost(r, missing);
            toolCalls += r.toolCallCount ?? 0; toolErr += r.toolCallErrorCount ?? 0; llm += r.llmCallCount ?? 0;
        }

        // 该 agent 用过的模型（按 token 占用降序）
        const mAgg = new Map<string, { calls: number; tokens: number }>();
        for (const r of rows) {
            const m = r.model?.trim(); if (!m) continue;
            const a = mAgg.get(m) || { calls: 0, tokens: 0 };
            a.calls += r.llmCallCount ?? 0; a.tokens += rowTokens(r).total;
            mAgg.set(m, a);
        }
        const topModels = [...mAgg].map(([model, a]) => ({ model, ...a })).sort((x, y) => y.tokens - x.tokens).slice(0, 6);

        // 按桶趋势
        const bkt = assignBuckets(rows, starts, plan.step);
        const trend = starts.map((start, i) => {
            const inb = bkt[i];
            const lat = inb.map((r) => r.latency).filter((v): v is number => v != null && v > 0);
            let c = 0, t = 0;
            for (const r of inb) { c += rowCost(r, missing); t += rowTokens(r).total; }
            return {
                label: bucketLabel(start, plan.gran),
                calls: inb.length,
                tokens: t,
                latencyP95: Math.round(pct(lat, 0.95) * 100) / 100,
                cost: Math.round(c * 1e6) / 1e6,
            };
        });

        return NextResponse.json({
            name, window, currency: 'USD', found: n > 0,
            stats: {
                traces: traceSet.size,
                executions: n,
                successRate: n ? Math.round((success / n) * 1000) / 10 : 0,
                p50Latency: Math.round(pct(latencies, 0.5) * 100) / 100,
                p95Latency: Math.round(pct(latencies, 0.95) * 100) / 100,
                avgLatency: latencies.length ? Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 100) / 100 : 0,
                totalTokens: tot, inputTokens: inp, outputTokens: out,
                cost: Math.round(cost * 1e6) / 1e6,
                toolCalls, toolErrorRate: toolCalls ? Math.round((toolErr / toolCalls) * 1000) / 10 : 0, llmCalls: llm,
            },
            trend, topModels,
        });
    } catch (error) {
        console.error('[Fleet Agent]', error);
        return NextResponse.json({ error: 'Failed to load agent stats' }, { status: 500 });
    }
}
