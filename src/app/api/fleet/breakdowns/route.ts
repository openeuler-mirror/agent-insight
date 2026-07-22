// 舰队监控大盘 · 排行 / 分布 / per-object 聚合端点（③可靠性 ④模型 ⑤工具 ⑥Agent ⑦编排）。
//
// 只覆盖「当前数据够算」的 T0 面板（口径见 src/lib/fleet/agg.ts）：
//  - per-tool 延迟/失败热点、模型 per-call 耗时/TTFT/箱线、send_message 协作网络 等需补埋点，
//    不在此端点，前端以占位卡说明。
//  - flags.* 显式告诉前端哪些维度当前无数据源。
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import { resolveUser } from '@/lib/auth/auth';
import {
    normalizeWindow, planOf, bucketStarts, bucketLabel, pct,
    isSuccess, agentCountOf, assignBuckets, rowCost, rowTokens, type FleetRow,
} from '@/lib/fleet/agg';
import {
    parseCallStats, mergeHist, histPercentile,
    LLM_BUCKET_EDGES, TOOL_BUCKET_EDGES, type CallStats, type CallBucketStat,
} from '@/lib/fleet/call-stats';
import { buildAgentCallTree, type AgentNode } from '@/lib/engine/observability/agent-trace';

export const dynamic = 'force-dynamic';

const COLLAB_SESSION_CAP = 200;

/** 递归收集 parent→child 派发边（跳过自环 / 无名节点）。 */
function collectSpawnEdges(node: AgentNode, acc: [string, string][]): [string, string][] {
    for (const c of node.children) {
        if (node.agentName && c.agentName && node.agentName !== c.agentName) acc.push([node.agentName, c.agentName]);
        collectSpawnEdges(c, acc);
    }
    return acc;
}

const LAT_EDGES = [0, 2, 5, 10, 20, 40, 60, Infinity];
const LAT_LABELS = ['0-2s', '2-5s', '5-10s', '10-20s', '20-40s', '40-60s', '60s+'];
const CX_LABELS = ['1', '2', '3', '4', '5', '6-8', '9+'];
const CTX_EDGES = [0, 8_000, 16_000, 32_000, 64_000, 96_000, 128_000, Infinity];
const CTX_LABELS = ['<8k', '8-16k', '16-32k', '32-64k', '64-96k', '96-128k', '128k+'];

function topN<T>(arr: T[], key: (t: T) => number, n: number): T[] {
    return [...arr].sort((a, b) => key(b) - key(a)).slice(0, n);
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
        const from = starts[0];

        const rows = (await prisma.execution.findMany({
            where: { ...userFilter, timestamp: { gte: new Date(from) } },
            select: {
                id: true, taskId: true, timestamp: true, latency: true,
                toolCallCount: true, toolCallErrorCount: true, llmCallCount: true, failures: true,
                inputTokens: true, outputTokens: true, tokens: true,
                cacheReadInputTokens: true, cacheCreationInputTokens: true, maxSingleCallTokens: true,
                model: true, agentName: true, observedAgents: true,
                rootExecutionId: true, isSubagent: true, query: true, callStats: true,
            },
        })) as (FleetRow & { id: string })[];

        const rootRows = rows.filter((r) => !r.isSubagent);
        const ids = rows.map((r) => r.id);

        // ── B 档：解析 callStats 预解析摘要（每行 ≤2KB 小 JSON，非法/哨兵返回 null）──
        const statsById = new Map<string, CallStats>();
        for (const r of rows) {
            const s = parseCallStats((r as FleetRow & { callStats?: string | null }).callStats);
            if (s) statsById.set(r.id, s);
        }
        const callStatsCoverage = {
            withStats: rootRows.filter((r) => statsById.has(r.id)).length,
            total: rootRows.length,
        };

        // ── ③ 可靠性 ─────────────────────────────────────────────
        // 失败热点 Agent（错误率 = 失败/总，root trace 维度）
        const agentAgg = new Map<string, { total: number; fail: number }>();
        for (const r of rootRows) {
            const name = r.agentName?.trim() || '(未命名)';
            const a = agentAgg.get(name) || { total: 0, fail: 0 };
            a.total++; if (!isSuccess(r)) a.fail++;
            agentAgg.set(name, a);
        }
        const failAgents = topN(
            [...agentAgg].map(([name, a]) => ({
                name, total: a.total, fail: a.fail,
                errorRate: a.total ? Math.round((a.fail / a.total) * 1000) / 10 : 0,
            })),
            (x) => x.errorRate * 1000 + x.total, 10,
        );

        // 端到端时延分布（对数桶）+ 窗口级 P50/P95（前端在直方图上画标线）
        const latHist = LAT_LABELS.map((label, i) => ({
            label,
            count: rootRows.filter((r) => {
                const v = r.latency ?? -1;
                return v >= LAT_EDGES[i] && v < LAT_EDGES[i + 1];
            }).length,
        }));
        const winLatencies = rootRows.map((r) => r.latency).filter((v): v is number => v != null && v > 0);
        const latP50 = Math.round(pct(winLatencies, 0.5) * 100) / 100;
        const latP95 = Math.round(pct(winLatencies, 0.95) * 100) / 100;

        // 单次调用上下文峰值分布（trace 级：同 trace 取各行 maxSingleCallTokens 的最大值；
        // 无该埋点的 trace 不计入，count 之和可能小于 trace 总数）
        const ctxByRoot = new Map<string, number>();
        for (const r of rows) {
            const v = r.maxSingleCallTokens ?? 0;
            if (v <= 0) continue;
            const key = r.isSubagent ? (r.rootExecutionId || r.id) : r.id;
            ctxByRoot.set(key, Math.max(ctxByRoot.get(key) ?? 0, v));
        }
        const ctxHist = CTX_LABELS.map((label, i) => ({
            label,
            count: [...ctxByRoot.values()].filter((v) => v >= CTX_EDGES[i] && v < CTX_EDGES[i + 1]).length,
        }));

        // 慢 trace 排行 TOP20。avgLlmMs=该 trace 模型调用均耗时（Σ模型耗时÷有效调用，纯模型口径，
        // 来自 callStats 摘要）——复杂任务调用多、均值不高属正常；均值高=单次调用异常慢。
        const llmTotalsOf = (id: string) => {
            const s = statsById.get(id);
            if (!s) return null;
            let n = 0, unkN = 0, sumMs = 0;
            for (const st of Object.values(s.llm)) { n += st.n; unkN += st.unkN; sumMs += st.sumMs; }
            const valid = n - unkN;
            return valid > 0 ? { avgMs: Math.round(sumMs / valid), sumMs } : null;
        };
        const slowTraces = topN(rootRows.filter((r) => (r.latency ?? 0) > 0), (r) => r.latency ?? 0, 20)
            .map((r) => ({
                taskId: r.taskId || r.id,
                agent: r.agentName || '—',
                query: (r.query || '').slice(0, 48),
                latency: Math.round((r.latency ?? 0) * 100) / 100,
                tokens: r.tokens ?? ((r.inputTokens ?? 0) + (r.outputTokens ?? 0)),
                agents: agentCountOf(r),
                llmCalls: r.llmCallCount ?? 0,
                avgLlmMs: llmTotalsOf(r.id)?.avgMs ?? null,
                ok: isSuccess(r),
                ts: r.timestamp.toISOString(),
            }));

        // 失败原因分类（两组口径分开：tool=工具硬错误规则归类；judge=failures 慢路径判定类目）
        const errAgg = new Map<string, number>();
        for (const s of statsById.values()) {
            for (const [label, cnt] of Object.entries(s.errTypes)) errAgg.set(label, (errAgg.get(label) ?? 0) + cnt);
        }
        const errTypes = {
            tool: topN([...errAgg].filter(([k]) => !k.startsWith('judge:')).map(([label, count]) => ({ label, count })), (x) => x.count, 10),
            judge: topN([...errAgg].filter(([k]) => k.startsWith('judge:')).map(([label, count]) => ({ label: label.slice(6), count })), (x) => x.count, 10),
        };

        // ── ④ 模型 ───────────────────────────────────────────────
        const modelAgg = new Map<string, { calls: number; input: number; output: number }>();
        for (const r of rows) {
            const m = r.model?.trim(); if (!m) continue;
            const a = modelAgg.get(m) || { calls: 0, input: 0, output: 0 };
            a.calls += r.llmCallCount ?? 0;
            a.input += r.inputTokens ?? 0;
            a.output += r.outputTokens ?? 0;
            modelAgg.set(m, a);
        }
        const modelList = [...modelAgg].map(([model, a]) => ({ model, ...a, total: a.input + a.output }));
        const modelCallRank = topN(modelList, (x) => x.calls, 10).map((x) => ({ model: x.model, calls: x.calls }));
        const modelTokenComp = topN(modelList, (x) => x.total, 10).map((x) => ({ model: x.model, input: x.input, output: x.output }));

        // 模型成本排行（per-call 单价加权，与 trends 成本同口径；缺价模型计 0 并上报 missing）
        const pricingMissing = new Set<string>();
        const modelCost = new Map<string, number>();
        for (const r of rows) {
            const m = r.model?.trim(); if (!m) continue;
            modelCost.set(m, (modelCost.get(m) ?? 0) + rowCost(r, pricingMissing));
        }
        const modelCostRank = topN(
            [...modelCost].map(([model, cost]) => ({ model, cost: Math.round(cost * 1e6) / 1e6 })).filter((x) => x.cost > 0),
            (x) => x.cost, 10,
        );

        // ── B 档：模型 per-call 耗时（callStats 直方图跨 trace 合并，分位=桶内插值估算）──
        const mergeGroup = (pick: (s: CallStats) => Record<string, CallBucketStat>, edges: number[]) => {
            const acc = new Map<string, { n: number; errN: number; unkN: number; sumMs: number; hist: number[] }>();
            for (const s of statsById.values()) {
                for (const [key, st] of Object.entries(pick(s))) {
                    let a = acc.get(key);
                    if (!a) { a = { n: 0, errN: 0, unkN: 0, sumMs: 0, hist: new Array(edges.length + 1).fill(0) }; acc.set(key, a); }
                    a.n += st.n; a.errN += st.errN; a.unkN += st.unkN; a.sumMs += st.sumMs;
                    mergeHist(a.hist, st.hist);
                }
            }
            return acc;
        };
        const llmMerged = mergeGroup((s) => s.llm, LLM_BUCKET_EDGES);
        const toolMerged = mergeGroup((s) => s.tool, TOOL_BUCKET_EDGES);
        const pctMs = (hist: number[], edges: number[], p: number) => {
            const v = histPercentile(hist, edges, p);
            return v == null ? null : v;
        };
        // 分模型时延排行：调用次数降序；avg 精确，P50/95/99 直方图估算
        const modelLatRank = topN(
            [...llmMerged].map(([model, a]) => ({
                model,
                calls: a.n,
                coveredN: a.n - a.unkN,
                avgMs: a.n - a.unkN > 0 ? Math.round(a.sumMs / (a.n - a.unkN)) : null,
                p50Ms: pctMs(a.hist, LLM_BUCKET_EDGES, 0.5),
                p95Ms: pctMs(a.hist, LLM_BUCKET_EDGES, 0.95),
                p99Ms: pctMs(a.hist, LLM_BUCKET_EDGES, 0.99),
            })),
            (x) => x.calls, 10,
        );
        // 模型耗时箱线（TOP5 调用量）：P10/P25/P50/P75/P90 直方图估算
        const modelBox = topN([...llmMerged].map(([model, a]) => ({ model, a })), (x) => x.a.n, 5)
            .map(({ model, a }) => ({
                model,
                p10: pctMs(a.hist, LLM_BUCKET_EDGES, 0.1), p25: pctMs(a.hist, LLM_BUCKET_EDGES, 0.25),
                p50: pctMs(a.hist, LLM_BUCKET_EDGES, 0.5), p75: pctMs(a.hist, LLM_BUCKET_EDGES, 0.75),
                p90: pctMs(a.hist, LLM_BUCKET_EDGES, 0.9),
            }))
            .filter((x) => x.p50 != null);
        // 工具排行：真实工具名 · 调用/成功率/均耗时/P50（耗时缺埋点的框架计入 coveredN 之外）
        const toolRank = topN(
            [...toolMerged].map(([tool, a]) => ({
                tool,
                calls: a.n,
                coveredN: a.n - a.unkN,
                successRate: a.n ? Math.round(((a.n - a.errN) / a.n) * 1000) / 10 : 100,
                avgMs: a.n - a.unkN > 0 ? Math.round(a.sumMs / (a.n - a.unkN)) : null,
                p50Ms: pctMs(a.hist, TOOL_BUCKET_EDGES, 0.5),
                p95Ms: pctMs(a.hist, TOOL_BUCKET_EDGES, 0.95),
                p99Ms: pctMs(a.hist, TOOL_BUCKET_EDGES, 0.99),
            })),
            (x) => x.calls, 10,
        );

        // ── ⑤ 工具趋势（量/成功率=Execution 列；均耗时=callStats 摘要按桶合并）──────
        const toolBuckets = assignBuckets(rows, starts, plan.step);
        // 按桶累加摘要里某组（llm/tool）的 sumMs 与有效次数
        const bucketGroupTotals = (inb: (FleetRow & { id: string })[], pick: (s: CallStats) => Record<string, CallBucketStat>) => {
            let sumMs = 0, valid = 0;
            for (const r of inb) {
                const s = statsById.get(r.id); if (!s) continue;
                for (const st of Object.values(pick(s))) { sumMs += st.sumMs; valid += st.n - st.unkN; }
            }
            return { sumMs, valid };
        };
        const toolTrend = starts.map((start, i) => {
            const inb = toolBuckets[i];
            const calls = inb.reduce((s, r) => s + (r.toolCallCount ?? 0), 0);
            const errs = inb.reduce((s, r) => s + (r.toolCallErrorCount ?? 0), 0);
            const t = bucketGroupTotals(inb, (s) => s.tool);
            return {
                label: bucketLabel(start, plan.gran),
                calls,
                successRate: calls ? Math.round(((calls - errs) / calls) * 1000) / 10 : 0,
                avgMs: t.valid > 0 ? Math.round(t.sumMs / t.valid) : null,
            };
        });

        // ── ④b 模型按桶趋势：均耗时 + Token 输出速率（Σoutput ÷ Σ模型耗时）─────────
        const modelTrend = starts.map((start, i) => {
            const inb = toolBuckets[i];
            const m = bucketGroupTotals(inb, (s) => s.llm);
            const outTok = inb.reduce((s, r) => s + (r.outputTokens ?? 0), 0);
            return {
                label: bucketLabel(start, plan.gran),
                avgMs: m.valid > 0 ? Math.round(m.sumMs / m.valid) : null,
                tokPerSec: m.sumMs > 0 ? Math.round((outTok / (m.sumMs / 1000)) * 10) / 10 : null,
            };
        });

        // ── ⑥ Agent ──────────────────────────────────────────────
        // 平均执行工具数 / 模型数趋势（分母 = 当桶 root trace 数）
        const rootBuckets = assignBuckets(rootRows, starts, plan.step);
        const agentTrend = starts.map((start, i) => {
            const inb = rootBuckets[i];
            const t = inb.length;
            const tool = inb.reduce((s, r) => s + (r.toolCallCount ?? 0), 0);
            const llm = inb.reduce((s, r) => s + (r.llmCallCount ?? 0), 0);
            // 平均执行步数：steps 来自 callStats（interactions 轮次），分母=当桶有摘要的 root trace 数
            let steps = 0, withSt = 0;
            for (const r of inb) {
                const s = statsById.get(r.id); if (!s) continue;
                steps += s.steps; withSt++;
            }
            return {
                label: bucketLabel(start, plan.gran),
                avgTools: t ? Math.round((tool / t) * 10) / 10 : 0,
                avgModels: t ? Math.round((llm / t) * 10) / 10 : 0,
                avgSteps: withSt > 0 ? Math.round((steps / withSt) * 10) / 10 : null,
            };
        });
        // Agent Token（self）+ 调用排行（distinct trace）
        const agentTok = new Map<string, number>();
        const agentTraces = new Map<string, Set<string>>();
        for (const r of rows) {
            const name = r.agentName?.trim(); if (!name) continue;
            agentTok.set(name, (agentTok.get(name) ?? 0) + (r.tokens ?? ((r.inputTokens ?? 0) + (r.outputTokens ?? 0))));
            const key = r.rootExecutionId || r.taskId || r.id;
            if (!agentTraces.has(name)) agentTraces.set(name, new Set());
            agentTraces.get(name)!.add(key);
        }
        const agentTokenRank = topN([...agentTok].map(([name, tokens]) => ({ name, tokens })), (x) => x.tokens, 10);
        const agentCallRank = topN([...agentTraces].map(([name, s]) => ({ name, traces: s.size })), (x) => x.traces, 10);

        // 单位任务 Token（主 Agent · inclusive）：整条 trace（root+子 agent 行）token 记到入口 agent 头上 ÷ trace 数。
        // 回答「派一个任务给该入口平均烧多少 token」；self 榜（tokenRank）答不了——大头可能在子 agent。
        const traceTok = new Map<string, number>();       // rootId → Σ tokens（含子行）
        const rootAgent = new Map<string, string>();      // rootId → 主 agent 名
        for (const r of rows) {
            const key = r.isSubagent ? (r.rootExecutionId || r.id) : r.id;
            traceTok.set(key, (traceTok.get(key) ?? 0) + rowTokens(r).total);
            if (!r.isSubagent && r.agentName?.trim()) rootAgent.set(r.id, r.agentName.trim());
        }
        const unitAgg = new Map<string, { tokens: number; traces: number }>();
        for (const [rootId, tokens] of traceTok) {
            const name = rootAgent.get(rootId); if (!name) continue;
            const a = unitAgg.get(name) || { tokens: 0, traces: 0 };
            a.tokens += tokens; a.traces++;
            unitAgg.set(name, a);
        }
        const unitTokenRank = topN(
            [...unitAgg].filter(([, a]) => a.traces > 0)
                .map(([name, a]) => ({ name, traces: a.traces, avgTokens: Math.round(a.tokens / a.traces) })),
            (x) => x.avgTokens, 10,
        );

        // Skill 排行（次数）——用 ExecutionSkill 表
        const skillRows = await prisma.executionSkill.findMany({
            where: { executionId: { in: ids } },
            select: { skillName: true },
        });
        const skillAgg = new Map<string, number>();
        for (const s of skillRows) skillAgg.set(s.skillName, (skillAgg.get(s.skillName) ?? 0) + 1);
        const skillRank = topN([...skillAgg].map(([skill, calls]) => ({ skill, calls })), (x) => x.calls, 10);

        // ── ⑦ 编排复杂度分布 ─────────────────────────────────────
        const cxHist = CX_LABELS.map((label) => ({ label, count: 0 }));
        for (const r of rootRows) {
            const c = agentCountOf(r);
            const idx = c >= 9 ? 6 : c >= 6 ? 5 : Math.min(4, c - 1);
            cxHist[Math.max(0, idx)].count++;
        }

        // ── ⑦ 全局协作网络（spawn/派发口径）───────────────────────
        // send_message 点对点消息网络四框架均无源；改用 buildAgentCallTree 还原的
        // parent→child 派发关系跨 trace 聚合：节点=Agent(度=中心度)，边权=派发次数。
        const collabSessions = await prisma.session.findMany({
            where: {
                ...userFilter,
                startTime: { gte: new Date(from) },
                OR: [
                    { interactions: { contains: 'subagent' } },
                    { interactions: { contains: 'build_team' } },
                    { interactions: { contains: 'coordinator' } },
                ],
            },
            select: { interactions: true },
            orderBy: { startTime: 'desc' },
            take: COLLAB_SESSION_CAP + 1,
        });
        const collabTruncated = collabSessions.length > COLLAB_SESSION_CAP;
        const edgeW = new Map<string, number>();
        const nodeDeg = new Map<string, number>();
        let collabTraces = 0;
        for (const s of collabSessions.slice(0, COLLAB_SESSION_CAP)) {
            if (!s.interactions) continue;
            let it: unknown[];
            try { it = JSON.parse(s.interactions); } catch { continue; }
            let tree: AgentNode | null = null;
            try { tree = buildAgentCallTree(it as Parameters<typeof buildAgentCallTree>[0]); } catch { tree = null; }
            if (!tree) continue;
            const edges = collectSpawnEdges(tree, []);
            if (edges.length) collabTraces++;
            for (const [a, b] of edges) {
                edgeW.set(`${a}\t${b}`, (edgeW.get(`${a}\t${b}`) ?? 0) + 1);
                nodeDeg.set(a, (nodeDeg.get(a) ?? 0) + 1);
                nodeDeg.set(b, (nodeDeg.get(b) ?? 0) + 1);
            }
        }
        const collab = {
            nodes: [...nodeDeg].map(([id, degree]) => ({ id, degree })).sort((a, b) => b.degree - a.degree),
            edges: [...edgeW].map(([k, weight]) => { const [from_, to] = k.split('\t'); return { from: from_, to, weight }; })
                .sort((a, b) => b.weight - a.weight),
            traceCount: collabTraces,
            truncated: collabTruncated,
        };

        return NextResponse.json({
            window,
            granularity: plan.gran,
            reliability: { failAgents, latHist, latP50, latP95, ctxHist, errTypes, slowTraces },
            model: {
                callRank: modelCallRank, tokenComp: modelTokenComp, costRank: modelCostRank,
                latRank: modelLatRank, box: modelBox, trend: modelTrend,
                pricingMissingModels: [...pricingMissing],
            },
            tool: { trend: toolTrend, rank: toolRank },
            agent: { trend: agentTrend, tokenRank: agentTokenRank, callRank: agentCallRank, unitTokenRank, skillRank },
            orchestration: { complexityHist: cxHist, collab },
            // callStats 摘要覆盖率（窗口内 root trace）：前端诚实展示「N/M 有统计」
            callStatsCoverage,
            // 当前无数据源的维度，前端据此显示占位卡（诚实标注 gap）。
            flags: {
                toolPerTool: true,    // per-tool 排行/耗时：callStats 预解析（B 档已接）
                modelPerCall: true,   // 模型 per-call 耗时/箱线：callStats 预解析（B 档已接；TTFT 仍缺埋点）
                skillSuccess: false,  // skill 成功率色深：需 skill-call state
                collabDispatch: true,     // 协作网络=spawn/派发口径（已实现）
                collabMessageCount: false, // send_message 消息计数口径：无数据源
                selfTime: false,      // self-time 箱线：需埋点
            },
        });
    } catch (error) {
        console.error('[Fleet Breakdowns Error]', error);
        return NextResponse.json({ error: 'Failed to load fleet breakdowns' }, { status: 500 });
    }
}
