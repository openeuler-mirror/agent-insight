// 单个 Agent 的下钻统计端点（仪表盘图表点击某 Agent 时调用）。
// 作用域 = 当前登录用户(?user=) + 时间窗；口径同 src/lib/fleet/agg.ts（self：只看 agentName=该 agent 的行）。
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import { resolveUser } from '@/lib/auth/auth';
import {
    normalizeWindow, planOf, bucketStarts, bucketLabel, pct,
    isSuccess, rowTokens, rowCost, assignBuckets, type FleetRow,
} from '@/lib/fleet/agg';
import { parseCallStats, type CallStats } from '@/lib/fleet/call-stats';

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
                callStats: true, query: true,
            },
        })) as (FleetRow & { id: string; callStats?: string | null })[];
        const statsOf = new Map<string, CallStats>();
        for (const r of rows) {
            const s = parseCallStats(r.callStats);
            if (s) statsOf.set(r.id, s);
        }

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

        // 按桶趋势（含 B 档：平均步数/工具数/模型调用数，步数分母=当桶有摘要的行）
        const bkt = assignBuckets(rows, starts, plan.step);
        const trend = starts.map((start, i) => {
            const inb = bkt[i] as typeof rows;
            const lat = inb.map((r) => r.latency).filter((v): v is number => v != null && v > 0);
            let c = 0, t = 0, tool = 0, llm = 0, steps = 0, withSt = 0;
            for (const r of inb) {
                c += rowCost(r, missing); t += rowTokens(r).total;
                tool += r.toolCallCount ?? 0; llm += r.llmCallCount ?? 0;
                const s = statsOf.get(r.id);
                if (s) { steps += s.steps; withSt++; }
            }
            return {
                label: bucketLabel(start, plan.gran),
                calls: inb.length,
                tokens: t,
                latencyP95: Math.round(pct(lat, 0.95) * 100) / 100,
                cost: Math.round(c * 1e6) / 1e6,
                avgTools: inb.length ? Math.round((tool / inb.length) * 10) / 10 : null,
                avgModels: inb.length ? Math.round((llm / inb.length) * 10) / 10 : null,
                avgSteps: withSt > 0 ? Math.round((steps / withSt) * 10) / 10 : null,
            };
        });

        // ── B 档：该 Agent 的工具使用分布 / 失败原因分类 / 慢 trace ─────────────
        const toolAgg = new Map<string, { calls: number; errN: number }>();
        const errAgg = new Map<string, number>();
        for (const s of statsOf.values()) {
            for (const [tl, st] of Object.entries(s.tool)) {
                const a = toolAgg.get(tl) || { calls: 0, errN: 0 };
                a.calls += st.n; a.errN += st.errN;
                toolAgg.set(tl, a);
            }
            for (const [label, cnt] of Object.entries(s.errTypes)) errAgg.set(label, (errAgg.get(label) ?? 0) + cnt);
        }
        const toolMix = [...toolAgg].map(([tl, a]) => ({ tool: tl, calls: a.calls, errN: a.errN }))
            .sort((a, b) => b.calls - a.calls).slice(0, 10);
        const errTypes = {
            tool: [...errAgg].filter(([k]) => !k.startsWith('judge:')).map(([label, count]) => ({ label, count }))
                .sort((a, b) => b.count - a.count).slice(0, 8),
            judge: [...errAgg].filter(([k]) => k.startsWith('judge:')).map(([label, count]) => ({ label: label.slice(6), count }))
                .sort((a, b) => b.count - a.count).slice(0, 8),
        };
        const avgLlmMsOf = (id: string) => {
            const s = statsOf.get(id); if (!s) return null;
            let cn = 0, unk = 0, sum = 0;
            for (const st of Object.values(s.llm)) { cn += st.n; unk += st.unkN; sum += st.sumMs; }
            return cn - unk > 0 ? Math.round(sum / (cn - unk)) : null;
        };
        const slowTraces = rows.filter((r) => (r.latency ?? 0) > 0)
            .sort((a, b) => (b.latency ?? 0) - (a.latency ?? 0)).slice(0, 8)
            .map((r) => ({
                taskId: r.taskId || r.id,
                query: (r.query || '').slice(0, 48),
                latency: Math.round((r.latency ?? 0) * 100) / 100,
                avgLlmMs: avgLlmMsOf(r.id),
                ok: isSuccess(r),
            }));

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
                // 平均执行步数（interactions 轮次，callStats 摘要）：分母=有摘要的执行数
                ...(() => {
                    let steps = 0;
                    for (const s of statsOf.values()) steps += s.steps;
                    const withSt = statsOf.size;
                    return { avgSteps: withSt > 0 ? Math.round((steps / withSt) * 10) / 10 : null, stepsCovered: withSt };
                })(),
            },
            trend, topModels, toolMix, errTypes, slowTraces,
        });
    } catch (error) {
        console.error('[Fleet Agent]', error);
        return NextResponse.json({ error: 'Failed to load agent stats' }, { status: 500 });
    }
}
