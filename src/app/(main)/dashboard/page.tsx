'use client';

// 仪表盘 · 舰队监控大盘。
// 结构（对齐《监控大盘需求文档》REQ-FW）：健康总览 KPI 常驻 + 6 维度页签 + 懒加载 + 告警角标。
// 数据全部来自真实 Execution 聚合（/api/fleet/trends + /api/fleet/breakdowns）。
// 口径见 src/lib/fleet/agg.ts / 《视图数据计算口径说明》；硬错误口径，软错误(judge)未叠加。
// 缺埋点的面板（per-tool 延迟、TTFT、箱线、self-time、协作网络）以占位卡诚实标注。

import React, { useCallback, useEffect, useState } from 'react';
import {
    ResponsiveContainer, ComposedChart, BarChart, LineChart,
    Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, Legend,
} from 'recharts';
import { apiFetch, getApiUrl } from '@/lib/client/api';
import { useThemeColors } from '@/lib/client/theme-context';
import { useAuth } from '@/lib/auth/auth-context';

// ─── Types ──────────────────────────────────────────────────────────────────
interface Kpi {
    traces: number; successRate: number; p95Latency: number;
    activeAgents: number; activeModels: number;
    toolCalls: number; toolErrorRate: number; llmCalls: number;
    totalTokens: number; inputTokens: number; outputTokens: number; totalCost: number;
}
interface Bucket {
    ts: string; label: string; traces: number; success: number; fail: number; errorRate: number;
    latencyP50: number; latencyP95: number; latencyP99: number;
    inputTokens: number; outputTokens: number; totalTokens: number;
    cost: number; avgTokens: number; avgCost: number;
}
interface TrendsResp {
    window: '1d' | '1w' | '1m'; granularity: 'hour' | 'day';
    currency: string; errorThreshold: number; pricingMissingModels: string[];
    kpi: { current: Kpi; previous: Kpi }; buckets: Bucket[];
}
interface BreakdownsResp {
    reliability: {
        failAgents: { name: string; total: number; fail: number; errorRate: number }[];
        latHist: { label: string; count: number }[];
        slowTraces: { taskId: string; agent: string; query: string; latency: number; tokens: number; agents: number; ok: boolean; ts: string }[];
    };
    model: { callRank: { model: string; calls: number }[]; tokenComp: { model: string; input: number; output: number }[] };
    tool: { trend: { label: string; calls: number; successRate: number }[] };
    agent: {
        trend: { label: string; avgTools: number; avgModels: number }[];
        tokenRank: { name: string; tokens: number }[];
        callRank: { name: string; traces: number }[];
        skillRank: { skill: string; calls: number }[];
    };
    orchestration: {
        complexityHist: { label: string; count: number }[];
        collab: {
            nodes: { id: string; degree: number }[];
            edges: { from: string; to: string; weight: number }[];
            traceCount: number; truncated: boolean;
        };
    };
    flags: Record<string, boolean>;
}

type TabKey = 'trends' | 'reliability' | 'model' | 'tool' | 'agent' | 'orchestration';
const TABS: { key: TabKey; label: string }[] = [
    { key: 'trends', label: '系统趋势' },
    { key: 'reliability', label: '可靠性与性能' },
    { key: 'model', label: '模型监控' },
    { key: 'tool', label: '工具监控' },
    { key: 'agent', label: 'Agent 监控' },
    { key: 'orchestration', label: '多智能体编排' },
];
const WINDOWS: { key: '1d' | '1w' | '1m'; label: string }[] = [
    { key: '1d', label: '近 24h' }, { key: '1w', label: '近 7 天' }, { key: '1m', label: '近 30 天' },
];
const TEAL = '#2c7a6b';

// ─── Formatters ─────────────────────────────────────────────────────────────
const fmtInt = (n: number) => (n ?? 0).toLocaleString();
const fmtPct = (n: number) => `${n}%`;
const fmtSec = (n: number) => `${n}s`;
const fmtCost = (n: number) => (n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

export default function DashboardPage() {
    const { user } = useAuth();
    const [win, setWin] = useState<'1d' | '1w' | '1m'>('1w');
    const [tab, setTab] = useState<TabKey>('trends');
    const [trends, setTrends] = useState<TrendsResp | null>(null);
    const [bd, setBd] = useState<BreakdownsResp | null>(null);
    const [tErr, setTErr] = useState<string | null>(null);
    const [bErr, setBErr] = useState<string | null>(null);
    const [bLoading, setBLoading] = useState(false);
    const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

    // 系统趋势 + KPI：随窗口即时加载。作用域=当前登录用户（带 ?user=）。
    useEffect(() => {
        if (!user) return; // 等登录用户就绪再取，避免误查全库
        let live = true;
        setTrends(null); setTErr(null); setBd(null); // 窗口/用户变→清空 breakdowns，按需重取
        apiFetch(`/api/fleet/trends?window=${win}&user=${encodeURIComponent(user)}`)
            .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
            .then((d) => { if (live) setTrends(d); })
            .catch((e) => { if (live) setTErr(e.message || '取数失败'); });
        return () => { live = false; };
    }, [win, user]);

    // breakdowns：懒加载——首次切到非「系统趋势」页签时才取，之后缓存。
    // 注意：deps 不能含 bLoading——否则 setBLoading(true) 会触发本 effect cleanup(live=false)
    // 把 in-flight 请求的结果丢弃，导致永远卡「加载中」。
    useEffect(() => {
        if (tab === 'trends' || bd || !user) return;
        let live = true;
        setBLoading(true); setBErr(null);
        apiFetch(`/api/fleet/breakdowns?window=${win}&user=${encodeURIComponent(user)}`)
            .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
            .then((d) => { if (live) setBd(d); })
            .catch((e) => { if (live) setBErr(e.message || '取数失败'); })
            .finally(() => { if (live) setBLoading(false); });
        return () => { live = false; };
    }, [tab, win, bd, user]);

    const threshold = trends?.errorThreshold ?? 5;
    const badges: Partial<Record<TabKey, boolean>> = {
        trends: !!trends?.buckets.some((b) => b.errorRate > threshold),
        reliability: !!bd?.reliability.failAgents.some((a) => a.errorRate >= threshold),
    };

    return (
        <div style={{ height: '100%', overflowY: 'auto', background: 'var(--background)' }}>
            {/* Header */}
            <div style={{
                position: 'sticky', top: 0, zIndex: 20, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                padding: '14px 22px', borderBottom: '1px solid var(--border)', background: 'var(--background)',
            }}>
                <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--foreground)' }}>仪表盘</span>
                <Info text="成本按模型单价加权（单位 USD）；成功/错误为硬错误口径（工具 state / failures），软错误（judge）未叠加；端到端时延为 wall-time。数据源：真实 Execution 聚合。" />
                <span style={{ flex: 1 }} />
                <div style={{ display: 'flex', gap: 4, background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 8, padding: 2 }}>
                    {WINDOWS.map((o) => (
                        <button key={o.key} onClick={() => setWin(o.key)} style={{
                            fontSize: 11.5, fontWeight: 600, padding: '5px 11px', borderRadius: 6, cursor: 'pointer', border: 'none',
                            background: win === o.key ? 'var(--primary)' : 'transparent',
                            color: win === o.key ? 'var(--primary-foreground, #fff)' : 'var(--foreground-secondary)',
                        }}>{o.label}</button>
                    ))}
                </div>
            </div>

            <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 16 }}>
                {tErr && <ErrBox msg={tErr} />}

                {/* 健康总览常驻 */}
                {!trends && !tErr && <Placeholder text="加载中…" />}
                {trends && (
                    <>
                        <KpiGrid kpi={trends.kpi} />
                        {trends.pricingMissingModels.length > 0 && (
                            <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: -6 }}>
                                ⚠ 以下模型缺单价，成本按 0 计：{trends.pricingMissingModels.join('、')}（在 custom-models.json 补单价）
                            </div>
                        )}

                        {/* 页签栏 */}
                        <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
                            {TABS.map((tb) => {
                                const active = tab === tb.key;
                                return (
                                    <button key={tb.key} onClick={() => setTab(tb.key)} style={{
                                        position: 'relative', fontSize: 12.5, fontWeight: active ? 700 : 500,
                                        padding: '9px 15px', border: 'none', cursor: 'pointer', background: 'transparent',
                                        color: active ? 'var(--primary)' : 'var(--foreground-secondary)',
                                        borderBottom: active ? '2px solid var(--primary)' : '2px solid transparent', marginBottom: -1,
                                    }}>
                                        {tb.label}
                                        {badges[tb.key] && <span title={tb.key === 'trends' ? '告警：部分时段错误率超过 5% 阈值' : '告警：存在失败热点 Agent 错误率 ≥ 5% 阈值'} style={{ position: 'absolute', top: 6, right: 4, width: 6, height: 6, borderRadius: '50%', background: 'var(--error)', cursor: 'help' }} />}
                                    </button>
                                );
                            })}
                        </div>

                        {/* 页签内容（懒加载 + 缓存） */}
                        {tab === 'trends' && <TrendsTab data={trends} />}
                        {tab !== 'trends' && (
                            bErr ? <ErrBox msg={bErr} />
                                : bLoading || !bd ? <Placeholder text="加载中…" />
                                    : tab === 'reliability' ? <ReliabilityTab bd={bd} onAgentClick={setSelectedAgent} />
                                        : tab === 'model' ? <ModelTab bd={bd} />
                                            : tab === 'tool' ? <ToolTab bd={bd} />
                                                : tab === 'agent' ? <AgentTab bd={bd} onAgentClick={setSelectedAgent} />
                                                    : <OrchestrationTab bd={bd} onAgentClick={setSelectedAgent} />
                        )}
                    </>
                )}
            </div>
            {selectedAgent && user && (
                <AgentDetailDrawer name={selectedAgent} win={win} user={user} onClose={() => setSelectedAgent(null)} />
            )}
        </div>
    );
}

// ═══ 页签：② 系统趋势 ═════════════════════════════════════════════════════════
function TrendsTab({ data }: { data: TrendsResp }) {
    const c = useThemeColors();
    if (data.buckets.every((b) => b.traces === 0)) return <Placeholder text="当前窗口内暂无数据" />;
    return (
        <Grid>
            <Panel title="Trace 流量趋势" hint="成功 / 失败分层堆叠">
                <ResponsiveContainer width="100%" height={CHART_H}>
                    <BarChart data={data.buckets} margin={mgn}>
                        <CartesianGrid strokeDasharray="3 3" stroke={c.border} vertical={false} />
                        <XAxis dataKey="label" stroke={c.fgMuted} tick={ax} interval="preserveStartEnd" />
                        <YAxis width={52} stroke={c.fgMuted} tick={ax} allowDecimals={false} />
                        <Tooltip contentStyle={tipStyle} /><Legend verticalAlign="top" align="right" wrapperStyle={lg} />
                        <Bar dataKey="success" name="成功" stackId="t" fill={c.success} />
                        <Bar dataKey="fail" name="失败" stackId="t" fill={c.error} radius={[2, 2, 0, 0]} />
                    </BarChart>
                </ResponsiveContainer>
            </Panel>
            <Panel title="错误率趋势" hint={`失败 trace 占比 · 阈值线 ${data.errorThreshold}%`}>
                <ResponsiveContainer width="100%" height={CHART_H}>
                    <LineChart data={data.buckets} margin={mgn}>
                        <CartesianGrid strokeDasharray="3 3" stroke={c.border} vertical={false} />
                        <XAxis dataKey="label" stroke={c.fgMuted} tick={ax} interval="preserveStartEnd" />
                        <YAxis width={52} stroke={c.fgMuted} tick={ax} unit="%" />
                        <Tooltip contentStyle={tipStyle} />
                        <ReferenceLine y={data.errorThreshold} stroke={c.warning} strokeDasharray="5 4" label={{ value: `${data.errorThreshold}%`, position: 'right', fill: c.warning, fontSize: 10 }} />
                        <Line type="monotone" dataKey="errorRate" name="错误率" stroke={c.error} strokeWidth={2} dot={{ r: 2 }} />
                    </LineChart>
                </ResponsiveContainer>
            </Panel>
            <Panel title="端到端时延趋势" hint="per-trace P50 / P95 / P99（wall-time，秒）">
                <ResponsiveContainer width="100%" height={CHART_H}>
                    <LineChart data={data.buckets} margin={mgn}>
                        <CartesianGrid strokeDasharray="3 3" stroke={c.border} vertical={false} />
                        <XAxis dataKey="label" stroke={c.fgMuted} tick={ax} interval="preserveStartEnd" />
                        <YAxis width={52} stroke={c.fgMuted} tick={ax} unit="s" />
                        <Tooltip contentStyle={tipStyle} /><Legend verticalAlign="top" align="right" wrapperStyle={lg} />
                        <Line type="monotone" dataKey="latencyP50" name="P50" stroke={c.success} strokeWidth={1.8} dot={false} />
                        <Line type="monotone" dataKey="latencyP95" name="P95" stroke={c.warning} strokeWidth={2} dot={false} />
                        <Line type="monotone" dataKey="latencyP99" name="P99" stroke={c.error} strokeWidth={2} dot={false} />
                    </LineChart>
                </ResponsiveContainer>
            </Panel>
            <Panel title="Token 消耗趋势" hint="input / output 堆叠 + 总量线">
                <ResponsiveContainer width="100%" height={CHART_H}>
                    <ComposedChart data={data.buckets} margin={mgn}>
                        <CartesianGrid strokeDasharray="3 3" stroke={c.border} vertical={false} />
                        <XAxis dataKey="label" stroke={c.fgMuted} tick={ax} interval="preserveStartEnd" />
                        <YAxis width={52} stroke={c.fgMuted} tick={ax} tickFormatter={fmtTok} />
                        <Tooltip contentStyle={tipStyle} formatter={(v) => fmtInt(Number(v))} /><Legend verticalAlign="top" align="right" wrapperStyle={lg} />
                        <Bar dataKey="inputTokens" name="input" stackId="tok" fill={c.primary} />
                        <Bar dataKey="outputTokens" name="output" stackId="tok" fill={TEAL} radius={[2, 2, 0, 0]} />
                        <Line type="monotone" dataKey="totalTokens" name="总量" stroke={c.warning} strokeWidth={2} dot={false} />
                    </ComposedChart>
                </ResponsiveContainer>
            </Panel>
            <Panel title="成本趋势" hint={`按模型单价加权（${data.currency}）`}>
                <ResponsiveContainer width="100%" height={CHART_H}>
                    <LineChart data={data.buckets} margin={mgn}>
                        <CartesianGrid strokeDasharray="3 3" stroke={c.border} vertical={false} />
                        <XAxis dataKey="label" stroke={c.fgMuted} tick={ax} interval="preserveStartEnd" />
                        <YAxis width={52} stroke={c.fgMuted} tick={ax} tickFormatter={(v) => `$${v}`} />
                        <Tooltip contentStyle={tipStyle} formatter={(v) => fmtCost(Number(v))} />
                        <Line type="monotone" dataKey="cost" name="成本" stroke={c.warning} strokeWidth={2.2} dot={{ r: 2 }} />
                    </LineChart>
                </ResponsiveContainer>
            </Panel>
            <Panel title="单 trace 平均 Token / 平均成本" hint="效率指标（与流量解耦）">
                <ResponsiveContainer width="100%" height={CHART_H}>
                    <ComposedChart data={data.buckets} margin={mgn}>
                        <CartesianGrid strokeDasharray="3 3" stroke={c.border} vertical={false} />
                        <XAxis dataKey="label" stroke={c.fgMuted} tick={ax} interval="preserveStartEnd" />
                        <YAxis yAxisId="tok" width={52} stroke={c.fgMuted} tick={ax} tickFormatter={fmtTok} />
                        <YAxis yAxisId="cost" orientation="right" width={52} stroke={c.fgMuted} tick={ax} tickFormatter={(v) => `$${v}`} />
                        <Tooltip contentStyle={tipStyle} /><Legend verticalAlign="top" align="right" wrapperStyle={lg} />
                        <Line yAxisId="tok" type="monotone" dataKey="avgTokens" name="平均 Token" stroke={c.primary} strokeWidth={2} dot={false} />
                        <Line yAxisId="cost" type="monotone" dataKey="avgCost" name={`平均成本(${data.currency})`} stroke={c.warning} strokeWidth={2} strokeDasharray="5 4" dot={false} />
                    </ComposedChart>
                </ResponsiveContainer>
            </Panel>
        </Grid>
    );
}

// ═══ 页签：③ 可靠性与性能 ═════════════════════════════════════════════════════
function ReliabilityTab({ bd, onAgentClick }: { bd: BreakdownsResp; onAgentClick: (name: string) => void }) {
    const r = bd.reliability;
    return (
        <Grid>
            <Panel title="失败热点 · Agent" hint="错误率 TOP10（失败/总调用）· 点击下钻">
                <HBar data={r.failAgents.map((a) => ({ name: a.name, value: a.errorRate }))} color="var(--error)" unit="%" onClick={onAgentClick} />
            </Panel>
            <Panel title="端到端时延分布" hint="per-trace 对数桶（秒）">
                <Histogram data={r.latHist} color="var(--warning)" />
            </Panel>
            <Panel title="慢 Trace 排行" hint="按端到端耗时降序 TOP20（点击进链路）" wide>
                <SlowTable rows={r.slowTraces} />
            </Panel>
        </Grid>
    );
}

// ═══ 页签：④ 模型监控 ════════════════════════════════════════════════════════
function ModelTab({ bd }: { bd: BreakdownsResp }) {
    const m = bd.model;
    return (
        <Grid>
            <Panel title="模型调用次数排行" hint="Σ 模型调用次数 TOP10">
                <HBar data={m.callRank.map((x) => ({ name: x.model, value: x.calls }))} color="var(--primary)" />
            </Panel>
            <Panel title="Token 构成排行" hint="input / output 堆叠 · 柱长=总消耗 TOP10">
                <StackedHBar data={m.tokenComp} />
            </Panel>
        </Grid>
    );
}

// ═══ 页签：⑤ 工具监控 ════════════════════════════════════════════════════════
function ToolTab({ bd }: { bd: BreakdownsResp }) {
    const c = useThemeColors();
    const t = bd.tool.trend;
    return (
        <Grid>
            <Panel title="工具调用量趋势" hint="Σ tool_calls 条数 / 桶">
                <ResponsiveContainer width="100%" height={CHART_H}>
                    <BarChart data={t} margin={mgn}>
                        <CartesianGrid strokeDasharray="3 3" stroke={c.border} vertical={false} />
                        <XAxis dataKey="label" stroke={c.fgMuted} tick={ax} interval="preserveStartEnd" />
                        <YAxis width={52} stroke={c.fgMuted} tick={ax} allowDecimals={false} />
                        <Tooltip contentStyle={tipStyle} />
                        <Bar dataKey="calls" name="工具调用" fill={c.primary} radius={[2, 2, 0, 0]} />
                    </BarChart>
                </ResponsiveContainer>
            </Panel>
            <Panel title="工具调用成功率趋势" hint="1 − 工具错误/总调用（%）">
                <ResponsiveContainer width="100%" height={CHART_H}>
                    <LineChart data={t} margin={mgn}>
                        <CartesianGrid strokeDasharray="3 3" stroke={c.border} vertical={false} />
                        <XAxis dataKey="label" stroke={c.fgMuted} tick={ax} interval="preserveStartEnd" />
                        <YAxis width={52} stroke={c.fgMuted} tick={ax} unit="%" domain={[90, 100]} />
                        <Tooltip contentStyle={tipStyle} />
                        <Line type="monotone" dataKey="successRate" name="成功率" stroke={c.success} strokeWidth={2} dot={{ r: 2 }} />
                    </LineChart>
                </ResponsiveContainer>
            </Panel>
        </Grid>
    );
}

// ═══ 页签：⑥ Agent 监控 ══════════════════════════════════════════════════════
function AgentTab({ bd, onAgentClick }: { bd: BreakdownsResp; onAgentClick: (name: string) => void }) {
    const c = useThemeColors();
    const a = bd.agent;
    return (
        <Grid>
            <Panel title="平均执行工具数 / 模型数趋势" hint="每 trace 人均（分母=当桶 trace 数）">
                <ResponsiveContainer width="100%" height={CHART_H}>
                    <LineChart data={a.trend} margin={mgn}>
                        <CartesianGrid strokeDasharray="3 3" stroke={c.border} vertical={false} />
                        <XAxis dataKey="label" stroke={c.fgMuted} tick={ax} interval="preserveStartEnd" />
                        <YAxis width={52} stroke={c.fgMuted} tick={ax} />
                        <Tooltip contentStyle={tipStyle} /><Legend verticalAlign="top" align="right" wrapperStyle={lg} />
                        <Line type="monotone" dataKey="avgTools" name="平均工具数" stroke={c.primary} strokeWidth={2} dot={false} />
                        <Line type="monotone" dataKey="avgModels" name="平均模型调用数" stroke={TEAL} strokeWidth={2} dot={false} />
                    </LineChart>
                </ResponsiveContainer>
            </Panel>
            <Panel title="Agent Token 消耗（self）" hint="按 Agent 自身 token TOP10 · 点击下钻">
                <HBar data={a.tokenRank.map((x) => ({ name: x.name, value: x.tokens }))} color="var(--warning)" fmt={fmtTok} onClick={onAgentClick} />
            </Panel>
            <Panel title="Agent 调用排行" hint="distinct trace 出现数 TOP10 · 点击下钻">
                <HBar data={a.callRank.map((x) => ({ name: x.name, value: x.traces }))} color="var(--primary)" onClick={onAgentClick} />
            </Panel>
            <Panel title="Skill 调用排行" hint="调用次数 TOP10（成功率色深待 skill-call state）">
                {a.skillRank.length ? <HBar data={a.skillRank.map((x) => ({ name: x.skill, value: x.calls }))} color={TEAL} />
                    : <Placeholder text="窗口内无 skill 调用" />}
            </Panel>
        </Grid>
    );
}

// ═══ 页签：⑦ 多智能体编排 ════════════════════════════════════════════════════
function OrchestrationTab({ bd, onAgentClick }: { bd: BreakdownsResp; onAgentClick: (name: string) => void }) {
    const col = bd.orchestration.collab;
    return (
        <Grid>
            <Panel title="编排复杂度分布" hint="每 trace 的 distinct Agent 数分桶">
                <Histogram data={bd.orchestration.complexityHist} color="var(--primary)" />
            </Panel>
            <Panel
                title="全局协作网络"
                info="边来自 buildAgentCallTree 还原的 parent→child 派发关系（谁 spawn 了谁），跨当前窗口内所有 trace 聚合，边权=派发次数、节点大小=中心度。非 send_message 点对点消息（该口径四框架均无数据源），但同样能识别通信枢纽 Agent。"
                hint={`节点大小=中心度 · 边=派发(from→to) · 点击节点下钻 · ${col.traceCount} 条多 Agent trace${col.truncated ? '（已截断）' : ''}`}
                wide
            >
                {col.nodes.length
                    ? <CollabNetwork data={col} onNodeClick={onAgentClick} />
                    : <Placeholder text="窗口内无多 Agent 协作数据" />}
            </Panel>
        </Grid>
    );
}

// 全局协作网络：ECharts 力导向，对齐高保真原型 tab-7(graph/force + 可拖拽缩放 roam + 邻接高亮)。
// 节点大小=中心度、边宽=派发次数、曲线边;节点色按中心度分档(PRD 设计色 navy→teal→terra→gold→muted)。
const NET_PALETTE = ['#1D2B45', '#2C7A6B', '#C8553D', '#B5811F', '#76705f'];
function CollabNetwork({ data, onNodeClick }: { data: BreakdownsResp['orchestration']['collab']; onNodeClick?: (name: string) => void }) {
    const c = useThemeColors();
    const ref = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
        const el = ref.current;
        if (!el) return;
        let chart: ReturnType<typeof import('echarts').init> | null = null;
        let disposed = false;
        let onResize: (() => void) | null = null;
        import('echarts').then((echarts) => {
            if (disposed || !el) return;
            const maxDeg = Math.max(1, ...data.nodes.map((n) => n.degree));
            const maxW = Math.max(1, ...data.edges.map((e) => e.weight));
            const colorOf = (deg: number) => {
                const r = deg / maxDeg;
                return r > 0.8 ? NET_PALETTE[0] : r > 0.5 ? NET_PALETTE[1] : r > 0.3 ? NET_PALETTE[2] : r > 0.15 ? NET_PALETTE[3] : NET_PALETTE[4];
            };
            chart = echarts.init(el);
            chart.setOption({
                tooltip: {
                    confine: true,
                    backgroundColor: 'var(--card-bg)',
                    borderColor: 'var(--border)',
                    textStyle: { color: c.fg, fontSize: 12 },
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    formatter: (p: any) => p.dataType === 'edge'
                        ? `${p.data.source} → ${p.data.target}<br/>派发 <b>${p.data.value}</b> 次`
                        : `${p.name}<br/>中心度 <b>${p.value}</b>`,
                },
                series: [{
                    type: 'graph', layout: 'force', roam: true, draggable: true,
                    data: data.nodes.map((n) => ({
                        name: n.id, value: n.degree,
                        symbolSize: 16 + 40 * (n.degree / maxDeg),
                        itemStyle: { color: colorOf(n.degree) },
                    })),
                    links: data.edges.map((e) => ({
                        source: e.from, target: e.to, value: e.weight,
                        lineStyle: { width: 1 + 3.5 * (e.weight / maxW) },
                    })),
                    force: { repulsion: 300, edgeLength: [60, 140], gravity: 0.12 },
                    label: { show: true, position: 'right', color: c.fg, fontSize: 10, fontWeight: 500 },
                    lineStyle: { color: c.fgMuted, opacity: 0.5, curveness: 0.18 },
                    emphasis: { focus: 'adjacency', label: { fontWeight: 700 }, lineStyle: { color: '#C8553D', opacity: 0.95, width: 2.5 } },
                }],
            });
            onResize = () => chart?.resize();
            window.addEventListener('resize', onResize);
            if (onNodeClick) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                chart.on('click', (p: any) => { if (p?.dataType === 'node' && p.name) onNodeClick(String(p.name)); });
            }
        });
        return () => {
            disposed = true;
            if (onResize) window.removeEventListener('resize', onResize);
            if (chart) chart.dispose();
        };
    }, [data, c, onNodeClick]);
    return <div ref={ref} style={{ width: '100%', height: 440 }} />;
}

// ─── KPI 卡组 ─────────────────────────────────────────────────────────────────
type Tone = 'count' | 'good' | 'latency' | 'error';
interface CardDef { label: string; key: keyof Kpi; fmt: (n: number) => string; goodWhenUp: boolean | null; tone: Tone; group: string }
const CARDS: CardDef[] = [
    { label: '总 Trace', key: 'traces', fmt: fmtInt, goodWhenUp: null, tone: 'count', group: '系统' },
    { label: '成功率', key: 'successRate', fmt: fmtPct, goodWhenUp: true, tone: 'good', group: '系统' },
    { label: 'P95 端到端时延', key: 'p95Latency', fmt: fmtSec, goodWhenUp: false, tone: 'latency', group: '系统' },
    { label: '活跃 Agent', key: 'activeAgents', fmt: fmtInt, goodWhenUp: null, tone: 'count', group: '系统' },
    { label: '活跃模型', key: 'activeModels', fmt: fmtInt, goodWhenUp: null, tone: 'count', group: '系统' },
    { label: '工具调用次数', key: 'toolCalls', fmt: fmtInt, goodWhenUp: null, tone: 'count', group: '工具' },
    { label: '工具调用错误率', key: 'toolErrorRate', fmt: fmtPct, goodWhenUp: false, tone: 'error', group: '工具' },
    { label: '模型 Tokens', key: 'totalTokens', fmt: fmtInt, goodWhenUp: null, tone: 'count', group: '模型' },
    { label: '模型调用次数', key: 'llmCalls', fmt: fmtInt, goodWhenUp: null, tone: 'count', group: '模型' },
    { label: '总成本', key: 'totalCost', fmt: fmtCost, goodWhenUp: false, tone: 'latency', group: '模型' },
];
function KpiGrid({ kpi }: { kpi: { current: Kpi; previous: Kpi } }) {
    return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            {CARDS.map((cd) => <KpiCard key={cd.key} def={cd} cur={kpi.current[cd.key]} prev={kpi.previous[cd.key]} />)}
        </div>
    );
}
const TONE_COLOR: Record<Tone, string> = { count: 'var(--foreground)', good: 'var(--success)', latency: 'var(--warning)', error: 'var(--error)' };
function KpiCard({ def, cur, prev }: { def: CardDef; cur: number; prev: number }) {
    return (
        <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--foreground-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 9, opacity: 0.7 }}>{def.group}</span>{def.label}
            </span>
            <span style={{ fontSize: 22, fontWeight: 800, color: TONE_COLOR[def.tone], fontFamily: 'var(--font-mono, monospace)', lineHeight: 1.1 }}>{def.fmt(cur ?? 0)}</span>
            <Delta cur={cur} prev={prev} goodWhenUp={def.goodWhenUp} />
        </div>
    );
}
function Delta({ cur, prev, goodWhenUp }: { cur: number; prev: number; goodWhenUp: boolean | null }) {
    if (prev == null || prev === 0) return <span style={{ fontSize: 10.5, color: 'var(--foreground-muted)' }}>环比 —</span>;
    const d = ((cur - prev) / prev) * 100;
    const rounded = Math.round(d * 10) / 10;
    if (Math.abs(rounded) < 0.05) return <span style={{ fontSize: 10.5, color: 'var(--foreground-muted)' }}>环比 ±0%</span>;
    const up = rounded > 0;
    const color = goodWhenUp === null ? 'var(--foreground-muted)' : (goodWhenUp === up ? 'var(--success)' : 'var(--error)');
    return (
        <span style={{ fontSize: 10.5, color, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            {up ? '▲' : '▼'} {Math.abs(rounded)}%<span style={{ color: 'var(--foreground-muted)', fontSize: 9.5 }}>环比</span>
        </span>
    );
}

// ─── 图表 helper ──────────────────────────────────────────────────────────────
function HBar({ data, color, unit, fmt, onClick }: { data: { name: string; value: number }[]; color: string; unit?: string; fmt?: (n: number) => string; onClick?: (name: string) => void }) {
    const c = useThemeColors();
    if (!data.length) return <Placeholder text="暂无数据" />;
    const h = CHART_H;
    return (
        <ResponsiveContainer width="100%" height={h}>
            <BarChart layout="vertical" data={data} margin={{ top: 4, right: 18, bottom: 4, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={c.border} horizontal={false} />
                <XAxis type="number" stroke={c.fgMuted} tick={ax} unit={unit} tickFormatter={fmt} />
                <YAxis type="category" dataKey="name" stroke={c.fgMuted} tick={{ fontSize: 10 }} width={118} />
                <Tooltip contentStyle={tipStyle} formatter={(v) => (fmt ? fmt(Number(v)) : String(v))} />
                <Bar dataKey="value" fill={color} radius={[0, 3, 3, 0]} cursor={onClick ? 'pointer' : undefined}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    onClick={onClick ? ((d: any) => { const nm = d?.name ?? d?.payload?.name; if (nm) onClick(String(nm)); }) : undefined} />
            </BarChart>
        </ResponsiveContainer>
    );
}
function StackedHBar({ data }: { data: { model: string; input: number; output: number }[] }) {
    const c = useThemeColors();
    if (!data.length) return <Placeholder text="暂无数据" />;
    const h = CHART_H;
    return (
        <ResponsiveContainer width="100%" height={h}>
            <BarChart layout="vertical" data={data} margin={{ top: 4, right: 18, bottom: 4, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={c.border} horizontal={false} />
                <XAxis type="number" stroke={c.fgMuted} tick={ax} tickFormatter={fmtTok} />
                <YAxis type="category" dataKey="model" stroke={c.fgMuted} tick={{ fontSize: 10 }} width={118} />
                <Tooltip contentStyle={tipStyle} formatter={(v) => fmtInt(Number(v))} /><Legend verticalAlign="top" align="right" wrapperStyle={lg} />
                <Bar dataKey="input" name="input" stackId="s" fill={c.primary} />
                <Bar dataKey="output" name="output" stackId="s" fill={TEAL} radius={[0, 3, 3, 0]} />
            </BarChart>
        </ResponsiveContainer>
    );
}
function Histogram({ data, color }: { data: { label: string; count: number }[]; color: string }) {
    const c = useThemeColors();
    return (
        <ResponsiveContainer width="100%" height={CHART_H}>
            <BarChart data={data} margin={mgn}>
                <CartesianGrid strokeDasharray="3 3" stroke={c.border} vertical={false} />
                <XAxis dataKey="label" stroke={c.fgMuted} tick={ax} />
                <YAxis width={52} stroke={c.fgMuted} tick={ax} allowDecimals={false} />
                <Tooltip contentStyle={tipStyle} />
                <Bar dataKey="count" name="trace 数" fill={color} radius={[2, 2, 0, 0]} />
            </BarChart>
        </ResponsiveContainer>
    );
}
function SlowTable({ rows }: { rows: BreakdownsResp['reliability']['slowTraces'] }) {
    if (!rows.length) return <Placeholder text="暂无数据" />;
    const th: React.CSSProperties = { textAlign: 'left', padding: '7px 10px', color: 'var(--foreground-muted)', fontWeight: 600, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
    const td: React.CSSProperties = { padding: '7px 10px', borderBottom: '1px solid var(--border)', color: 'var(--foreground-secondary)' };
    return (
        <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                <thead><tr>
                    <th style={th}>Trace</th><th style={th}>Agent</th><th style={th}>时延(s)</th>
                    <th style={th}>Token</th><th style={th}>Agent 数</th><th style={th}>状态</th>
                </tr></thead>
                <tbody>
                    {rows.map((r, i) => (
                        <tr key={i}>
                            <td style={td}><a href={getApiUrl(`/trace?taskId=${encodeURIComponent(r.taskId)}`)} style={{ color: 'var(--primary)', textDecoration: 'none', fontFamily: 'var(--font-mono, monospace)' }}>{r.taskId.slice(0, 12)}…</a></td>
                            <td style={td}>{r.agent}</td>
                            <td style={{ ...td, fontFamily: 'var(--font-mono, monospace)', color: 'var(--warning)' }}>{r.latency}</td>
                            <td style={{ ...td, fontFamily: 'var(--font-mono, monospace)' }}>{fmtInt(r.tokens)}</td>
                            <td style={td}>{r.agents}</td>
                            <td style={{ ...td, color: r.ok ? 'var(--success)' : 'var(--error)' }}>{r.ok ? '成功' : '失败'}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

// ─── Building blocks ──────────────────────────────────────────────────────────
function Grid({ children }: { children: React.ReactNode }) {
    return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(430px, 1fr))', gap: 14 }}>{children}</div>;
}
function Panel({ title, hint, info, wide, children }: { title: string; hint?: string; info?: string; wide?: boolean; children: React.ReactNode }) {
    return (
        <section style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12, gridColumn: wide ? '1 / -1' : undefined, minWidth: 0, overflow: 'hidden' }}>
            <div style={{ padding: '11px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--foreground)' }}>{title}</span>
                {info && <Info text={info} />}
                {hint && <span style={{ fontSize: 10.5, color: 'var(--foreground-muted)' }}>· {hint}</span>}
            </div>
            <div style={{ padding: '12px 12px 6px' }}>{children}</div>
        </section>
    );
}
// 指标/口径说明角标：hover 显示 tooltip（原生 title），取代大段说明文字。
function Info({ text }: { text: string }) {
    return (
        <span title={text} style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 14, height: 14,
            borderRadius: '50%', border: '1px solid var(--border-dark)', color: 'var(--foreground-muted)',
            fontSize: 9.5, fontWeight: 700, fontStyle: 'normal', cursor: 'help', flexShrink: 0, lineHeight: 1,
        }}>i</span>
    );
}
function Placeholder({ text }: { text: string }) {
    return <div style={{ padding: 50, textAlign: 'center', color: 'var(--foreground-muted)', fontSize: 13, background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12 }}>{text}</div>;
}
function ErrBox({ msg }: { msg: string }) {
    return <div style={{ padding: 16, borderRadius: 10, background: 'var(--error-subtle)', border: '1px solid var(--error-subtle-border)', color: 'var(--error)', fontSize: 13 }}>取数失败：{msg}</div>;
}

// ─── Agent 下钻抽屉 ────────────────────────────────────────────────────────────
interface AgentStats {
    traces: number; executions: number; successRate: number;
    p50Latency: number; p95Latency: number; avgLatency: number;
    totalTokens: number; inputTokens: number; outputTokens: number;
    cost: number; toolCalls: number; toolErrorRate: number; llmCalls: number;
}
interface AgentResp {
    name: string; window: string; currency: string; found: boolean;
    stats: AgentStats;
    trend: { label: string; calls: number; tokens: number; latencyP95: number; cost: number }[];
    topModels: { model: string; calls: number; tokens: number }[];
}
function AgentDetailDrawer({ name, win, user, onClose }: { name: string; win: string; user: string; onClose: () => void }) {
    const c = useThemeColors();
    const [data, setData] = useState<AgentResp | null>(null);
    const [err, setErr] = useState<string | null>(null);
    useEffect(() => {
        let live = true; setData(null); setErr(null);
        apiFetch(`/api/fleet/agent?name=${encodeURIComponent(name)}&window=${win}&user=${encodeURIComponent(user)}`)
            .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
            .then((d) => { if (live) setData(d); })
            .catch((e) => { if (live) setErr(e instanceof Error ? e.message : '取数失败'); });
        return () => { live = false; };
    }, [name, win, user]);
    const s = data?.stats;
    return (
        <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.3)', zIndex: 60, display: 'flex', justifyContent: 'flex-end' }}>
            <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(560px, 92vw)', height: '100%', background: 'var(--background)', borderLeft: '1px solid var(--border)', overflowY: 'auto', boxShadow: '-8px 0 30px rgba(0,0,0,.15)' }}>
                <div style={{ position: 'sticky', top: 0, background: 'var(--background)', borderBottom: '1px solid var(--border)', padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 10.5, color: 'var(--foreground-muted)' }}>Agent 详情 · {WINDOWS.find((w) => w.key === win)?.label}</div>
                        <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
                    </div>
                    <span style={{ flex: 1 }} />
                    <a href={getApiUrl(`/trace?agent=${encodeURIComponent(name)}`)} style={{ fontSize: 11.5, color: 'var(--primary)', textDecoration: 'none', border: '1px solid var(--border)', borderRadius: 7, padding: '5px 10px', whiteSpace: 'nowrap' }}>查看 trace →</a>
                    <button onClick={onClose} style={{ border: 'none', background: 'transparent', color: 'var(--foreground-muted)', fontSize: 20, cursor: 'pointer', lineHeight: 1 }}>×</button>
                </div>
                <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {err && <div style={{ color: 'var(--error)', fontSize: 13 }}>取数失败：{err}</div>}
                    {!data && !err && <div style={{ color: 'var(--foreground-muted)', fontSize: 13 }}>加载中…</div>}
                    {data && !data.found && <div style={{ color: 'var(--foreground-muted)', fontSize: 13 }}>该窗口内无此 Agent 的数据</div>}
                    {s && data?.found && (
                        <>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
                                <Mini label="参与 Trace" v={fmtInt(s.traces)} />
                                <Mini label="执行次数" v={fmtInt(s.executions)} />
                                <Mini label="成功率" v={`${s.successRate}%`} tone="good" />
                                <Mini label="P95 时延" v={`${s.p95Latency}s`} tone="latency" />
                                <Mini label="Token(self)" v={fmtInt(s.totalTokens)} />
                                <Mini label={`成本(${data.currency})`} v={fmtCost(s.cost)} tone="latency" />
                                <Mini label="工具调用" v={fmtInt(s.toolCalls)} />
                                <Mini label="模型调用" v={fmtInt(s.llmCalls)} />
                            </div>
                            <Panel title="趋势" hint="调用次数(柱) + P95 时延(线)">
                                <ResponsiveContainer width="100%" height={220}>
                                    <ComposedChart data={data.trend} margin={mgn}>
                                        <CartesianGrid strokeDasharray="3 3" stroke={c.border} vertical={false} />
                                        <XAxis dataKey="label" stroke={c.fgMuted} tick={ax} interval="preserveStartEnd" />
                                        <YAxis yAxisId="c" width={40} stroke={c.fgMuted} tick={ax} allowDecimals={false} />
                                        <YAxis yAxisId="l" orientation="right" width={44} stroke={c.fgMuted} tick={ax} unit="s" />
                                        <Tooltip contentStyle={tipStyle} />
                                        <Legend verticalAlign="top" align="right" wrapperStyle={lg} />
                                        <Bar yAxisId="c" dataKey="calls" name="调用次数（左轴）" fill={c.primary} radius={[2, 2, 0, 0]} />
                                        <Line yAxisId="l" type="monotone" dataKey="latencyP95" name="P95 时延 s（右轴）" stroke={c.warning} strokeWidth={2} dot={false} />
                                    </ComposedChart>
                                </ResponsiveContainer>
                            </Panel>
                            {data.topModels.length > 0 && (
                                <Panel title="常用模型" hint="按 token 占用">
                                    <HBar data={data.topModels.map((m) => ({ name: m.model, value: m.tokens }))} color={TEAL} fmt={fmtTok} />
                                </Panel>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
function Mini({ label, v, tone }: { label: string; v: string; tone?: 'good' | 'latency' }) {
    const color = tone === 'good' ? 'var(--success)' : tone === 'latency' ? 'var(--warning)' : 'var(--foreground)';
    return (
        <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 9, padding: '9px 11px' }}>
            <div style={{ fontSize: 10.5, color: 'var(--foreground-muted)' }}>{label}</div>
            <div style={{ fontSize: 17, fontWeight: 800, color, fontFamily: 'var(--font-mono, monospace)' }}>{v}</div>
        </div>
    );
}

// ─── shared style tokens ──────────────────────────────────────────────────────
const CHART_H = 260; // 所有图表统一高度：保证同一行不同类型图表的横轴在一条线上
const mgn = { top: 8, right: 16, bottom: 4, left: 0 } as const;
const ax = { fontSize: 10 } as const;
const lg = { fontSize: 11 } as const;
const tipStyle: React.CSSProperties = { background: 'var(--card-bg)', border: '1px solid var(--border-dark)', borderRadius: 9, fontSize: 11, boxShadow: '0 6px 24px rgba(20,22,30,.12)' };
