// 舰队监控大盘 · 系统趋势 + 健康总览 KPI 聚合端点。
//
// 口径依据《视图数据计算口径说明》，共享逻辑见 src/lib/fleet/agg.ts：
//  - 只统计 root trace（isSubagent:false），避免子 agent 行重复计数。
//  - 端到端时延用 wall-time（Execution.latency，单位=秒），分位「先聚合到 per-trace 再取分位」。
//  - 成本【不读 Execution.cost】（库内为 NULL），一律按 per-call 模型单价加权重算（口径 0.5）。
//  - 环比 = 与「上一个等长窗口」比较。
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import { resolveUser } from '@/lib/auth/auth';
import {
    normalizeWindow, planOf, bucketStarts, bucketLabel, pct,
    isSuccess, rowTokens, rowCost, rowCacheSaved, concurrencyPerBucket, assignBuckets, type FleetRow,
} from '@/lib/fleet/agg';
import { parseCallStats } from '@/lib/fleet/call-stats';

export const dynamic = 'force-dynamic';

function aggregate(rows: FleetRow[], missing: Set<string>) {
    const n = rows.length;
    const success = rows.filter(isSuccess).length;
    const latencies = rows.map((r) => r.latency).filter((v): v is number => v != null && v > 0);
    const toolCalls = rows.reduce((s, r) => s + (r.toolCallCount ?? 0), 0);
    const toolErrors = rows.reduce((s, r) => s + (r.toolCallErrorCount ?? 0), 0);
    const llmCalls = rows.reduce((s, r) => s + (r.llmCallCount ?? 0), 0);
    let inputTok = 0, outputTok = 0, totalTok = 0, cost = 0, cacheRead = 0, cacheSaved = 0;
    for (const r of rows) {
        const tk = rowTokens(r);
        inputTok += tk.input; outputTok += tk.output; totalTok += tk.total;
        cost += rowCost(r, missing);
        cacheRead += r.cacheReadInputTokens ?? 0;
        cacheSaved += rowCacheSaved(r, missing);
    }
    return {
        traces: n,
        successRate: n ? Math.round((success / n) * 1000) / 10 : 0,
        p95Latency: Math.round(pct(latencies, 0.95) * 100) / 100,
        activeAgents: new Set(rows.map((r) => r.agentName?.trim()).filter(Boolean)).size,
        activeModels: new Set(rows.map((r) => r.model?.trim()).filter(Boolean)).size,
        toolCalls,
        toolErrorRate: toolCalls ? Math.round((toolErrors / toolCalls) * 1000) / 10 : 0,
        llmCalls,
        totalTokens: totalTok,
        inputTokens: inputTok,
        outputTokens: outputTok,
        totalCost: Math.round(cost * 1e6) / 1e6,
        // 缓存命中率 = cacheRead ÷ (input + cacheRead)：走缓存的输入 token 占比（无 cache 埋点的行计 0 命中）。
        cacheHitRate: (inputTok + cacheRead) ? Math.round((cacheRead / (inputTok + cacheRead)) * 1000) / 10 : 0,
        cacheSavedUsd: Math.round(cacheSaved * 1e6) / 1e6,
    };
}

export async function GET(req: Request) {
    try {
        const url = new URL(req.url);
        // 作用域：按当前登录用户过滤（客户端传 ?user=）。解析不出用户则回退全量。
        const { username } = await resolveUser(req, url.searchParams.get('user'));
        const userFilter = username ? { user: username } : {};

        const window = normalizeWindow(url.searchParams.get('window'));
        const plan = planOf(window);

        const now = new Date();
        const starts = bucketStarts(now, plan);
        const currentFrom = starts[0];
        const spanMs = plan.count * plan.step;
        const prevFrom = currentFrom - spanMs;

        const rows = (await prisma.execution.findMany({
            where: { ...userFilter, isSubagent: false, timestamp: { gte: new Date(prevFrom) } },
            select: {
                timestamp: true, latency: true, isAnswerCorrect: true,
                toolCallCount: true, toolCallErrorCount: true, llmCallCount: true, failures: true,
                inputTokens: true, outputTokens: true, tokens: true,
                cacheReadInputTokens: true, cacheCreationInputTokens: true, reasoningTokens: true,
                model: true, agentName: true, taskId: true, callStats: true,
            },
        })) as (FleetRow & { callStats?: string | null })[];

        const missing = new Set<string>();
        const curRows = rows.filter((r) => r.timestamp.getTime() >= currentFrom);
        const prevRows = rows.filter((r) => {
            const t = r.timestamp.getTime();
            return t >= prevFrom && t < currentFrom;
        });

        const cur = aggregate(curRows, missing);
        const prev = aggregate(prevRows, missing);

        const bucketed = assignBuckets(curRows, starts, plan.step);
        // 并发活跃 trace（区间重叠口径，只看 root trace——curRows 本身已过滤 isSubagent:false）
        const concur = concurrencyPerBucket(curRows, starts, plan.step);
        // B 档：per-trace 模型总耗时 / 开销残差（端到端 − 模型 − 工具，钳 ≥0）。
        // 值来自 callStats 摘要的 sumMs（精确，非直方图估算）；无摘要的 trace 不参与分位。
        const traceTimes = (r: FleetRow & { callStats?: string | null }) => {
            const s = parseCallStats(r.callStats);
            if (!s || (r.latency ?? 0) <= 0) return null;
            let llmMs = 0, toolMs = 0;
            for (const st of Object.values(s.llm)) llmMs += st.sumMs;
            for (const st of Object.values(s.tool)) toolMs += st.sumMs;
            const wallMs = (r.latency as number) * 1000;
            return { llmMs, overheadMs: Math.max(0, wallMs - llmMs - toolMs) };
        };
        const buckets = starts.map((start, i) => {
            const inb = bucketed[i];
            const n = inb.length;
            const success = inb.filter(isSuccess).length;
            const fail = n - success;
            const latencies = inb.map((r) => r.latency).filter((v): v is number => v != null && v > 0);
            let inputTok = 0, outputTok = 0, cost = 0, cacheRead = 0, cacheSaved = 0, reasonTok = 0;
            for (const r of inb) {
                const tk = rowTokens(r);
                inputTok += tk.input; outputTok += tk.output;
                cost += rowCost(r, missing);
                cacheRead += r.cacheReadInputTokens ?? 0;
                cacheSaved += rowCacheSaved(r, missing);
                reasonTok += r.reasoningTokens ?? 0;
            }
            const totalTok = inputTok + outputTok;
            return {
                ts: new Date(start).toISOString(),
                label: bucketLabel(start, plan.gran),
                traces: n, success, fail,
                errorRate: n ? Math.round((fail / n) * 1000) / 10 : 0,
                latencyP50: Math.round(pct(latencies, 0.5) * 100) / 100,
                latencyP95: Math.round(pct(latencies, 0.95) * 100) / 100,
                latencyP99: Math.round(pct(latencies, 0.99) * 100) / 100,
                inputTokens: inputTok, outputTokens: outputTok, totalTokens: totalTok,
                cost: Math.round(cost * 1e6) / 1e6,
                avgTokens: n ? Math.round(totalTok / n) : 0,
                avgCost: n ? Math.round((cost / n) * 1e6) / 1e6 : 0,
                cacheHitRate: (inputTok + cacheRead) ? Math.round((cacheRead / (inputTok + cacheRead)) * 1000) / 10 : 0,
                cacheSavedUsd: Math.round(cacheSaved * 1e6) / 1e6,
                reasoningTokens: reasonTok,
                visibleOutputTokens: Math.max(0, outputTok - reasonTok),
                concurrencyPeak: concur[i].peak,
                concurrencyAvg: concur[i].avg,
                ...(() => {
                    const tt = inb.map((r) => traceTimes(r as FleetRow & { callStats?: string | null }))
                        .filter((x): x is { llmMs: number; overheadMs: number } => x != null);
                    const llmS = tt.map((x) => x.llmMs / 1000), ovhS = tt.map((x) => x.overheadMs / 1000);
                    const r2 = (v: number) => Math.round(v * 100) / 100;
                    return {
                        modelTimeP50: tt.length ? r2(pct(llmS, 0.5)) : null,
                        modelTimeP95: tt.length ? r2(pct(llmS, 0.95)) : null,
                        modelTimeP99: tt.length ? r2(pct(llmS, 0.99)) : null,
                        overheadP50: tt.length ? r2(pct(ovhS, 0.5)) : null,
                        overheadP95: tt.length ? r2(pct(ovhS, 0.95)) : null,
                        overheadP99: tt.length ? r2(pct(ovhS, 0.99)) : null,
                        statTraces: tt.length,
                    };
                })(),
            };
        });

        return NextResponse.json({
            window,
            granularity: plan.gran,
            currency: 'USD',
            errorThreshold: 5,
            generatedAt: now.toISOString(),
            pricingMissingModels: [...missing],
            kpi: { current: cur, previous: prev },
            buckets,
        });
    } catch (error) {
        console.error('[Fleet Trends Error]', error);
        return NextResponse.json({ error: 'Failed to load fleet trends' }, { status: 500 });
    }
}
