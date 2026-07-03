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
    normalizeWindow, planOf, bucketStarts, bucketLabel,
    isSuccess, agentCountOf, assignBuckets, type FleetRow,
} from '@/lib/fleet/agg';
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
                model: true, agentName: true, observedAgents: true,
                rootExecutionId: true, isSubagent: true, query: true,
            },
        })) as (FleetRow & { id: string })[];

        const rootRows = rows.filter((r) => !r.isSubagent);
        const ids = rows.map((r) => r.id);

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

        // 端到端时延分布（对数桶）
        const latHist = LAT_LABELS.map((label, i) => ({
            label,
            count: rootRows.filter((r) => {
                const v = r.latency ?? -1;
                return v >= LAT_EDGES[i] && v < LAT_EDGES[i + 1];
            }).length,
        }));

        // 慢 trace 排行 TOP20
        const slowTraces = topN(rootRows.filter((r) => (r.latency ?? 0) > 0), (r) => r.latency ?? 0, 20)
            .map((r) => ({
                taskId: r.taskId || r.id,
                agent: r.agentName || '—',
                query: (r.query || '').slice(0, 48),
                latency: Math.round((r.latency ?? 0) * 100) / 100,
                tokens: r.tokens ?? ((r.inputTokens ?? 0) + (r.outputTokens ?? 0)),
                agents: agentCountOf(r),
                ok: isSuccess(r),
                ts: r.timestamp.toISOString(),
            }));

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

        // ── ⑤ 工具（Execution 级：调用量 + 成功率趋势；per-tool 需 interactions，缺）──
        const toolBuckets = assignBuckets(rows, starts, plan.step);
        const toolTrend = starts.map((start, i) => {
            const inb = toolBuckets[i];
            const calls = inb.reduce((s, r) => s + (r.toolCallCount ?? 0), 0);
            const errs = inb.reduce((s, r) => s + (r.toolCallErrorCount ?? 0), 0);
            return {
                label: bucketLabel(start, plan.gran),
                calls,
                successRate: calls ? Math.round(((calls - errs) / calls) * 1000) / 10 : 0,
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
            return {
                label: bucketLabel(start, plan.gran),
                avgTools: t ? Math.round((tool / t) * 10) / 10 : 0,
                avgModels: t ? Math.round((llm / t) * 10) / 10 : 0,
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
            reliability: { failAgents, latHist, slowTraces },
            model: { callRank: modelCallRank, tokenComp: modelTokenComp },
            tool: { trend: toolTrend },
            agent: { trend: agentTrend, tokenRank: agentTokenRank, callRank: agentCallRank, skillRank },
            orchestration: { complexityHist: cxHist, collab },
            // 当前无数据源的维度，前端据此显示占位卡（诚实标注 gap）。
            flags: {
                toolPerTool: false,   // per-tool 延迟/成功率/失败热点：需 interactions
                modelPerCall: false,  // 模型 per-call 耗时/TTFT/箱线：需埋点
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
