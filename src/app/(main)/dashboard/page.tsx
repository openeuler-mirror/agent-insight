'use client';

// 仪表盘 · 舰队监控大盘。
// 结构（对齐《监控大盘需求文档》REQ-FW）：健康总览 KPI 常驻 + 7 维度页签 + 懒加载 + 告警角标。
// 可靠性来自 RAS 链路事件聚合（/api/fleet/reliability），其余来自真实 Execution 聚合。
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
    cacheHitRate: number; cacheSavedUsd: number;
}
interface Bucket {
    ts: string; label: string; traces: number; success: number; fail: number; errorRate: number;
    latencyP50: number; latencyP95: number; latencyP99: number;
    inputTokens: number; outputTokens: number; totalTokens: number;
    cost: number; avgTokens: number; avgCost: number;
    cacheHitRate: number; cacheSavedUsd: number;
    reasoningTokens: number; visibleOutputTokens: number;
    concurrencyPeak: number; concurrencyAvg: number;
    modelTimeP50: number | null; modelTimeP95: number | null; modelTimeP99: number | null;
    overheadP50: number | null; overheadP95: number | null; overheadP99: number | null;
    statTraces: number;
}
interface TrendsResp {
    window: '1d' | '1w' | '1m'; granularity: 'hour' | 'day';
    currency: string; errorThreshold: number; pricingMissingModels: string[];
    kpi: { current: Kpi; previous: Kpi }; buckets: Bucket[];
}
interface BreakdownsResp {
    performance: {
        latHist: { label: string; count: number }[];
        latP50: number; latP95: number;
        ctxHist: { label: string; count: number }[];
        slowTraces: { taskId: string; agent: string; platform: string; query: string; latency: number; tokens: number; agents: number; llmCalls: number; avgLlmMs: number | null; ok: boolean; ts: string }[];
    };
    model: {
        callRank: { model: string; calls: number }[];
        tokenComp: { model: string; input: number; output: number }[];
        costRank: { model: string; cost: number }[];
        latRank: { model: string; calls: number; coveredN: number; avgMs: number | null; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null }[];
        box: { model: string; p10: number | null; p25: number | null; p50: number | null; p75: number | null; p90: number | null }[];
        trend: { label: string; avgMs: number | null; tokPerSec: number | null }[];
        pricingMissingModels: string[];
    };
    tool: {
        trend: { label: string; calls: number; successRate: number; avgMs: number | null }[];
        rank: { tool: string; calls: number; coveredN: number; successRate: number; avgMs: number | null; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null }[];
    };
    agent: {
        trend: { label: string; avgTools: number; avgModels: number; avgSteps: number | null }[];
        tokenRank: { name: string; tokens: number }[];
        callRank: { name: string; traces: number }[];
        unitTokenRank: { name: string; traces: number; avgTokens: number }[];
        skillRank: { skill: string; calls: number }[];
    };
    callStatsCoverage: { withStats: number; total: number };
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
interface ReliabilityResp {
    filters: { platforms: string[]; agents: string[] };
    kpi: { totalTraces: number; faultTraces: number; faultRate: number; recoveredTraces: number; recoveryRate: number; unrecoveredTraces: number };
    trend: { label: string; faults: number; recovered: number }[];
    recovery: { recovered: number; unrecovered: number };
    severity: { key: string; label: string; count: number }[];
    modes: { kind: string; total: number; recovered: number; unrecovered: number }[];
    agents: { name: string; platform: string; traces: number; faults: number; faultRate: number; recoveryRate: number }[];
    failureSupplement: {
        failAgents: { name: string; total: number; fail: number; errorRate: number }[];
        errTypes: { tool: { label: string; count: number }[]; judge: { label: string; count: number }[] };
        callStatsCoverage: { withStats: number; total: number };
    };
    recentFaultTraces: { taskId: string; executionId: string; agent: string; platform: string; faultMode: string; recoveryStatus: "recovered" | "unrecovered"; ts: string }[];
}

type TabKey = "trends" | "reliability" | "performance" | "model" | "tool" | "agent" | "orchestration";
const TABS: { key: TabKey; label: string }[] = [
    { key: 'trends', label: '系统趋势' },
    { key: 'reliability', label: '可靠性' },
    { key: 'performance', label: '性能' },
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
    const [reliability, setReliability] = useState<ReliabilityResp | null>(null);
    const [tErr, setTErr] = useState<string | null>(null);
    const [bErr, setBErr] = useState<string | null>(null);
    const [rErr, setRErr] = useState<string | null>(null);
    const [bLoading, setBLoading] = useState(false);
    const [rLoading, setRLoading] = useState(false);
    const [platformFilter, setPlatformFilter] = useState("all");
    const [agentFilter, setAgentFilter] = useState("all");
    const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

    useEffect(() => {
        if (!user) return;
        let live = true;
        setTrends(null); setTErr(null); setBd(null); setReliability(null);
        setPlatformFilter("all"); setAgentFilter("all");
        apiFetch(`/api/fleet/trends?window=${win}&user=${encodeURIComponent(user)}`)
            .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
            .then((d) => { if (live) setTrends(d); })
            .catch((e) => { if (live) setTErr(e.message || "取数失败"); });
        return () => { live = false; };
    }, [win, user]);

    useEffect(() => {
        if (tab === "trends" || tab === "reliability" || bd || !user) return;
        let live = true;
        setBLoading(true); setBErr(null);
        apiFetch(`/api/fleet/breakdowns?window=${win}&user=${encodeURIComponent(user)}`)
            .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
            .then((d) => { if (live) setBd(d); })
            .catch((e) => { if (live) setBErr(e.message || "取数失败"); })
            .finally(() => { if (live) setBLoading(false); });
        return () => { live = false; };
    }, [tab, win, bd, user]);

    useEffect(() => {
        if (tab !== "reliability" || !user) return;
        let live = true;
        const params = new URLSearchParams({ window: win, user });
        if (platformFilter !== "all") params.set("platform", platformFilter);
        if (agentFilter !== "all") params.set("agent", agentFilter);
        setRLoading(true); setRErr(null);
        apiFetch(`/api/fleet/reliability?${params.toString()}`)
            .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
            .then((d) => { if (live) setReliability(d); })
            .catch((e) => { if (live) setRErr(e.message || "取数失败"); })
            .finally(() => { if (live) setRLoading(false); });
        return () => { live = false; };
    }, [tab, win, user, platformFilter, agentFilter]);

    const refreshRef = React.useRef<() => void>(() => { });
    refreshRef.current = () => {
        if (!user) return;
        apiFetch(`/api/fleet/trends?window=${win}&user=${encodeURIComponent(user)}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (d) setTrends(d); })
            .catch(() => { });
        if (bd) {
            apiFetch(`/api/fleet/breakdowns?window=${win}&user=${encodeURIComponent(user)}`)
                .then((r) => (r.ok ? r.json() : null))
                .then((d) => { if (d) setBd(d); })
                .catch(() => { });
        }
        if (reliability) {
            const params = new URLSearchParams({ window: win, user });
            if (platformFilter !== "all") params.set("platform", platformFilter);
            if (agentFilter !== "all") params.set("agent", agentFilter);
            apiFetch(`/api/fleet/reliability?${params.toString()}`)
                .then((r) => (r.ok ? r.json() : null))
                .then((d) => { if (d) setReliability(d); })
                .catch(() => { });
        }
    };
    useEffect(() => {
        const id = setInterval(() => refreshRef.current(), 30_000);
        return () => clearInterval(id);
    }, []);

    const badges: Partial<Record<TabKey, boolean>> = {
        trends: !!trends?.buckets.some((b) => b.errorRate > (trends?.errorThreshold ?? 5)),
        reliability: (reliability?.kpi.faultTraces ?? 0) > 0,
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
                <span style={{
                    fontSize: 11, color: 'var(--foreground-muted)', display: 'inline-flex', gap: 6, alignItems: 'center',
                    border: '1px solid var(--border)', borderRadius: 999, padding: '4px 11px', background: 'var(--card-bg)',
                }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--success)' }} />实时 · 30s 刷新
                </span>
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
                                        {badges[tb.key] && <span title={tb.key === 'trends' ? '告警：部分时段错误率超过阈值' : '告警：窗口内存在 RAS 故障 trace'} style={{ position: 'absolute', top: 6, right: 4, width: 6, height: 6, borderRadius: '50%', background: 'var(--error)', cursor: 'help' }} />}
                                    </button>
                                );
                            })}
                        </div>

                        {/* 页签内容（懒加载 + 缓存） */}
                        {tab === "trends" && <TrendsTab data={trends} />}
                        {tab === "reliability" && (
                            rErr ? <ErrBox msg={rErr} />
                                : rLoading && !reliability ? <Placeholder text="加载中…" />
                                    : reliability ? <ReliabilityTab
                                        data={reliability}
                                        platform={platformFilter}
                                        agent={agentFilter}
                                        onPlatformChange={(value) => { setPlatformFilter(value); setAgentFilter("all"); }}
                                        onAgentChange={setAgentFilter}
                                        onAgentClick={setSelectedAgent}
                                    /> : <Placeholder text="暂无数据" />
                        )}
                        {tab !== "trends" && tab !== "reliability" && (
                            bErr ? <ErrBox msg={bErr} />
                                : bLoading || !bd ? <Placeholder text="加载中…" />
                                    : tab === "performance" ? <PerformanceTab bd={bd} />
                                        : tab === "model" ? <ModelTab bd={bd} trends={trends} />
                                            : tab === "tool" ? <ToolTab bd={bd} />
                                                : tab === "agent" ? <AgentTab bd={bd} onAgentClick={setSelectedAgent} />
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
            <Panel
                title="每 trace 模型耗时趋势"
                info="Σ该 trace 全部模型调用耗时（callStats 摘要，精确值非估算），按 per-trace 取 P50/P95/P99。与端到端时延对照：两者差距大 = 时间花在工具/等待而非模型。无摘要的 trace 不参与分位。"
                hint="per-trace Σ模型耗时 P50/P95/P99（秒）"
            >
                <ResponsiveContainer width="100%" height={CHART_H}>
                    <LineChart data={data.buckets} margin={mgn}>
                        <CartesianGrid strokeDasharray="3 3" stroke={c.border} vertical={false} />
                        <XAxis dataKey="label" stroke={c.fgMuted} tick={ax} interval="preserveStartEnd" />
                        <YAxis width={52} stroke={c.fgMuted} tick={ax} unit="s" />
                        <Tooltip contentStyle={tipStyle} /><Legend verticalAlign="top" align="right" wrapperStyle={lg} />
                        <Line type="monotone" dataKey="modelTimeP50" name="P50" stroke={c.success} strokeWidth={1.8} dot={false} connectNulls />
                        <Line type="monotone" dataKey="modelTimeP95" name="P95" stroke={c.warning} strokeWidth={2} dot={false} connectNulls />
                        <Line type="monotone" dataKey="modelTimeP99" name="P99" stroke={c.error} strokeWidth={2} dot={false} connectNulls />
                    </LineChart>
                </ResponsiveContainer>
            </Panel>
            <Panel
                title="开销 / 等待耗时趋势"
                info="残差 = 端到端 wall-time − Σ模型耗时 − Σ工具耗时（钳 ≥0），即排队/调度/人机等待/空转的时间。P95 异常高通常意味着有 trace 卡在等待而非计算。工具耗时缺埋点的框架会把工具时间也计入残差（诚实高估）。"
                hint="per-trace 残差 P50/P95/P99（秒）"
            >
                <ResponsiveContainer width="100%" height={CHART_H}>
                    <LineChart data={data.buckets} margin={mgn}>
                        <CartesianGrid strokeDasharray="3 3" stroke={c.border} vertical={false} />
                        <XAxis dataKey="label" stroke={c.fgMuted} tick={ax} interval="preserveStartEnd" />
                        <YAxis width={52} stroke={c.fgMuted} tick={ax} unit="s" />
                        <Tooltip contentStyle={tipStyle} /><Legend verticalAlign="top" align="right" wrapperStyle={lg} />
                        <Line type="monotone" dataKey="overheadP50" name="P50" stroke={c.success} strokeWidth={1.8} dot={false} connectNulls />
                        <Line type="monotone" dataKey="overheadP95" name="P95" stroke={c.warning} strokeWidth={2} dot={false} connectNulls />
                        <Line type="monotone" dataKey="overheadP99" name="P99" stroke={c.error} strokeWidth={2} dot={false} connectNulls />
                    </LineChart>
                </ResponsiveContainer>
            </Panel>
            <Panel
                title="并发活跃 Trace 趋势"
                info="把每条 trace 视为时间区间 [开始时间, 开始时间+端到端时延)。峰值=桶内瞬时并发最大值（扫描线）；平均=Σ桶内活跃时长 ÷ 桶长（时间加权）。反映系统同时承载的任务量。"
                hint="峰值 / 平均（区间重叠计算）"
            >
                <ResponsiveContainer width="100%" height={CHART_H}>
                    <LineChart data={data.buckets} margin={mgn}>
                        <CartesianGrid strokeDasharray="3 3" stroke={c.border} vertical={false} />
                        <XAxis dataKey="label" stroke={c.fgMuted} tick={ax} interval="preserveStartEnd" />
                        <YAxis width={52} stroke={c.fgMuted} tick={ax} allowDecimals={false} />
                        <Tooltip contentStyle={tipStyle} /><Legend verticalAlign="top" align="right" wrapperStyle={lg} />
                        <Line type="monotone" dataKey="concurrencyPeak" name="峰值并发" stroke={c.primary} strokeWidth={2} dot={{ r: 2 }} />
                        <Line type="monotone" dataKey="concurrencyAvg" name="平均并发" stroke={TEAL} strokeWidth={2} strokeDasharray="5 4" dot={false} />
                    </LineChart>
                </ResponsiveContainer>
            </Panel>
        </Grid>
    );
}

// ═══ 页签：③ 可靠性 ═════════════════════════════════════════════════════════
function ReliabilityTab({
    data, platform, agent, onPlatformChange, onAgentChange, onAgentClick,
}: {
    data: ReliabilityResp;
    platform: string;
    agent: string;
    onPlatformChange: (value: string) => void;
    onAgentChange: (value: string) => void;
    onAgentClick: (name: string) => void;
}) {
    const c = useThemeColors();
    const supplement = data.failureSupplement;
    const failureReasons = [
        ...supplement.errTypes.tool.map((item) => ({ name: item.label, value: item.count })),
        ...supplement.errTypes.judge.map((item) => ({ name: `判定:${item.label}`, value: item.count })),
    ];
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <section style={{ background: "var(--card-bg)", border: "1px solid var(--card-border)", borderRadius: 12, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: "var(--foreground)" }}>可靠性</div>
                    <div style={{ fontSize: 11, color: "var(--foreground-muted)", marginTop: 3 }}>数据源：链路跟踪中的 RAS anomaly / action_result 事件；无异常（含 unknown）按无故障计。</div>
                </div>
                <span style={{ flex: 1 }} />
                <ReliabilitySelect label="平台" value={platform} options={data.filters.platforms} onChange={onPlatformChange} />
                <ReliabilitySelect label="Agent" value={agent} options={data.filters.agents} onChange={onAgentChange} />
            </section>

            <ReliabilityKpis data={data} />

            <Grid>
                <div style={{ gridColumn: "1 / -1", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 14 }}>
                    <Panel title="故障与恢复趋势" hint="故障按首次 anomaly 时间；恢复按成功 action_result 时间">
                        <ResponsiveContainer width="100%" height={CHART_H}>
                            <LineChart data={data.trend} margin={mgn}>
                                <CartesianGrid strokeDasharray="3 3" stroke={c.border} vertical={false} />
                                <XAxis dataKey="label" stroke={c.fgMuted} tick={ax} interval="preserveStartEnd" />
                                <YAxis width={52} stroke={c.fgMuted} tick={ax} allowDecimals={false} />
                                <Tooltip contentStyle={tipStyle} /><Legend verticalAlign="top" align="right" wrapperStyle={lg} />
                                <Line type="monotone" dataKey="faults" name="故障 Trace" stroke={c.error} strokeWidth={2} dot={{ r: 2 }} />
                                <Line type="monotone" dataKey="recovered" name="已恢复" stroke={c.success} strokeWidth={2} dot={{ r: 2 }} />
                            </LineChart>
                        </ResponsiveContainer>
                    </Panel>
                    <Panel title="故障处置分布" hint="仅统计存在 RAS 故障的 Trace；恢复失败、未知或无恢复结果均计未恢复">
                        <RecoveryShare recovery={data.recovery} />
                    </Panel>
                </div>

                <Panel title="故障级别占比" hint="每条 Trace 取最高 severity；无故障为正常，故障无 severity 为未标注" wide>
                    <SeverityShare rows={data.severity} />
                </Panel>

                <div style={{ gridColumn: "1 / -1", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 14 }}>
                    <Panel title="故障模式" hint="RAS anomaly_kind · 同一 Trace 可命中多个模式">
                        <ReliabilityModeChart rows={data.modes} />
                    </Panel>
                    <Panel title="Agent 可靠性" hint="按平台 + Agent 聚合；故障率降序">
                        <ReliabilityAgentTable rows={data.agents} onAgentClick={onAgentClick} />
                    </Panel>
                </div>

                <div style={{ gridColumn: "1 / -1", padding: "4px 2px 0" }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: "var(--foreground)" }}>执行失败补充</div>
                    <div style={{ fontSize: 10.5, color: "var(--foreground-muted)", marginTop: 3 }}>下面两张图根据执行错误和结果判定汇总，用于辅助定位失败集中在哪些智能体、主要由哪些原因引起；这些数据不参与上方可靠性指标计算。</div>
                </div>
                <Panel title="失败热点 · Agent" hint="数据源：Execution · 错误率 TOP10（失败/总 Trace）">
                    <HBar data={supplement.failAgents.map((item) => ({ name: item.name, value: item.errorRate }))} color="var(--error)" unit="%" onClick={onAgentClick} />
                </Panel>
                <Panel
                    title="失败原因分类"
                    info="工具硬错误按 callStats 的 error/error_type 规则归类；判定类目来自 failures.failure_type。两者可能重叠。"
                    hint={`数据源：Execution callStats / Judge failures · 摘要覆盖 ${supplement.callStatsCoverage.withStats}/${supplement.callStatsCoverage.total} Trace`}
                >
                    {failureReasons.length ? <HBar data={failureReasons} color="var(--error)" /> : <Placeholder text="窗口内无失败记录" />}
                </Panel>
                <Panel title="近期故障 Trace" hint="按最新 RAS 事件时间降序 TOP20" wide>
                    <RecentFaultTable rows={data.recentFaultTraces} />
                </Panel>
            </Grid>
        </div>
    );
}

function ReliabilitySelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
    return (
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--foreground-muted)" }}>
            {label}
            <select value={value} onChange={(event) => onChange(event.target.value)} style={{ minWidth: 130, border: "1px solid var(--border)", borderRadius: 7, background: "var(--background)", color: "var(--foreground-secondary)", padding: "6px 9px", fontSize: 11.5 }}>
                <option value="all">全部</option>
                {options.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
        </label>
    );
}

function ReliabilityKpis({ data }: { data: ReliabilityResp }) {
    const cards = [
        { label: "Trace 总数", value: fmtInt(data.kpi.totalTraces), tone: "var(--foreground)" },
        { label: "故障 Trace", value: fmtInt(data.kpi.faultTraces), tone: "var(--error)" },
        { label: "故障率", value: fmtPct(data.kpi.faultRate), tone: "var(--error)" },
        { label: "已恢复", value: fmtInt(data.kpi.recoveredTraces), tone: "var(--success)" },
        { label: "恢复率", value: fmtPct(data.kpi.recoveryRate), tone: "var(--success)" },
        { label: "未恢复", value: fmtInt(data.kpi.unrecoveredTraces), tone: "var(--warning)" },
    ];
    return (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
            {cards.map((card) => (
                <div key={card.label} style={{ background: "var(--card-bg)", border: "1px solid var(--card-border)", borderRadius: 10, padding: "12px 14px" }}>
                    <div style={{ fontSize: 11, color: "var(--foreground-muted)" }}>{card.label}</div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: card.tone, fontFamily: "var(--font-mono, monospace)", marginTop: 7 }}>{card.value}</div>
                </div>
            ))}
        </div>
    );
}

function RecoveryShare({ recovery }: { recovery: ReliabilityResp["recovery"] }) {
    const total = recovery.recovered + recovery.unrecovered;
    if (!total) return <Placeholder text="窗口内无 RAS 故障" />;
    const rows = [
        { label: "已恢复", count: recovery.recovered, color: "var(--success)" },
        { label: "未恢复", count: recovery.unrecovered, color: "var(--error)" },
    ];
    const radius = 65;
    const circumference = 2 * Math.PI * radius;
    let offset = 0;
    const segments = rows.map((row) => {
        const length = (row.count / total) * circumference;
        const dashOffset = -offset;
        offset += length;
        return { ...row, length, dashOffset };
    });

    return (
        <div style={{ minHeight: CHART_H, display: "flex", alignItems: "center", justifyContent: "space-evenly", gap: 18, flexWrap: "wrap", padding: "8px 12px" }}>
            <svg viewBox="0 0 180 180" width="180" height="180" role="img" aria-label={`故障处置分布，共 ${total} 条故障调用链`} style={{ flex: "0 0 180px" }}>
                <circle cx="90" cy="90" r={radius} fill="none" stroke="var(--border)" strokeWidth="22" />
                {segments.filter((row) => row.count > 0).map((row) => (
                    <circle
                        key={row.label}
                        cx="90"
                        cy="90"
                        r={radius}
                        fill="none"
                        stroke={row.color}
                        strokeWidth="22"
                        strokeDasharray={`${row.length} ${Math.max(circumference - row.length, 0.001)}`}
                        strokeDashoffset={row.dashOffset}
                        transform="rotate(-90 90 90)"
                    >
                        <title>{row.label}：{row.count} 条</title>
                    </circle>
                ))}
                <text x="90" y="83" textAnchor="middle" fill="var(--foreground-muted)" fontSize="11">故障链</text>
                <text x="90" y="109" textAnchor="middle" fill="var(--foreground)" fontSize="24" fontWeight="800">{total}</text>
            </svg>

            <div style={{ display: "flex", flex: "1 1 130px", maxWidth: 190, minWidth: 130, flexDirection: "column", gap: 14 }}>
                {rows.map((row) => (
                    <div key={row.label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                        <span style={{ width: 10, height: 10, borderRadius: 3, background: row.color, flexShrink: 0 }} />
                        <span style={{ color: "var(--foreground-secondary)" }}>{row.label}</span>
                        <strong style={{ marginLeft: "auto", color: "var(--foreground)", fontFamily: "var(--font-mono, monospace)", whiteSpace: "nowrap" }}>
                            {row.count} · {Math.round((row.count / total) * 1000) / 10}%
                        </strong>
                    </div>
                ))}
            </div>
        </div>
    );
}

function SeverityShare({ rows }: { rows: ReliabilityResp["severity"] }) {
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    const colors: Record<string, string> = {
        critical: "var(--error)", high: "var(--warning)", medium: "var(--primary)",
        low: "var(--success)", normal: "var(--foreground-muted)", unlabeled: "var(--border-dark)",
    };
    if (!total) return <Placeholder text="暂无 Trace" />;
    return (
        <div style={{ minHeight: 120, display: "flex", flexDirection: "column", justifyContent: "center", gap: 18, padding: "8px 12px 12px" }}>
            <div style={{ height: 24, borderRadius: 6, overflow: "hidden", display: "flex", background: "var(--border)" }}>
                {rows.filter((row) => row.count > 0).map((row) => (
                    <div key={row.key} title={`${row.label}：${row.count}（${Math.round((row.count / total) * 1000) / 10}%）`} style={{ width: `${(row.count / total) * 100}%`, background: colors[row.key], minWidth: 2 }} />
                ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "nowrap", overflowX: "auto" }}>
                {rows.map((row) => (
                    <div key={row.key} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, flexShrink: 0 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: colors[row.key], flexShrink: 0 }} />
                        <span style={{ color: "var(--foreground-secondary)" }}>{row.label}</span>
                        <span style={{ marginLeft: 4, color: "var(--foreground-muted)", fontFamily: "var(--font-mono, monospace)" }}>{row.count} · {Math.round((row.count / total) * 1000) / 10}%</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

function ReliabilityModeChart({ rows }: { rows: ReliabilityResp["modes"] }) {
    const c = useThemeColors();
    if (!rows.length) return <Placeholder text="窗口内无 RAS 故障" />;
    return (
        <ResponsiveContainer width="100%" height={CHART_H}>
            <BarChart layout="vertical" data={rows} margin={{ top: 4, right: 18, bottom: 4, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={c.border} horizontal={false} />
                <XAxis type="number" stroke={c.fgMuted} tick={ax} allowDecimals={false} />
                <YAxis type="category" dataKey="kind" stroke={c.fgMuted} tick={{ fontSize: 10 }} width={118} />
                <Tooltip contentStyle={tipStyle} /><Legend verticalAlign="top" align="right" wrapperStyle={lg} />
                <Bar dataKey="recovered" name="已恢复" stackId="r" fill={c.success} barSize={14} isAnimationActive={false} />
                <Bar dataKey="unrecovered" name="未恢复" stackId="r" fill={c.error} barSize={14} isAnimationActive={false} radius={[0, 3, 3, 0]} />
            </BarChart>
        </ResponsiveContainer>
    );
}

function ReliabilityAgentTable({ rows, onAgentClick }: { rows: ReliabilityResp["agents"]; onAgentClick: (name: string) => void }) {
    if (!rows.length) return <Placeholder text="暂无数据" />;
    const th: React.CSSProperties = { textAlign: "left", padding: "7px 10px", color: "var(--foreground-muted)", fontWeight: 600, borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" };
    const td: React.CSSProperties = { padding: "7px 10px", borderBottom: "1px solid var(--border)", color: "var(--foreground-secondary)" };
    return (
        <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
                <thead><tr><th style={th}>Agent</th><th style={th}>平台</th><th style={th}>Trace</th><th style={th}>故障</th><th style={th}>故障率</th><th style={th}>恢复率</th><th style={th}>操作</th></tr></thead>
                <tbody>{rows.map((row) => (
                    <tr key={`${row.platform}:${row.name}`}>
                        <td style={td}>{row.name}</td><td style={td}>{row.platform}</td>
                        <td style={td}>{fmtInt(row.traces)}</td><td style={td}>{fmtInt(row.faults)}</td>
                        <td style={{ ...td, color: row.faultRate > 0 ? "var(--error)" : "var(--success)" }}>{fmtPct(row.faultRate)}</td>
                        <td style={{ ...td, color: row.recoveryRate === 100 ? "var(--success)" : "var(--warning)" }}>{row.faults ? fmtPct(row.recoveryRate) : "—"}</td>
                        <td style={td}><button onClick={() => onAgentClick(row.name)} style={{ border: "none", background: "transparent", color: "var(--primary)", cursor: "pointer", padding: 0 }}>查看</button></td>
                    </tr>
                ))}</tbody>
            </table>
        </div>
    );
}

function RecentFaultTable({ rows }: { rows: ReliabilityResp["recentFaultTraces"] }) {
    if (!rows.length) return <Placeholder text="窗口内无 RAS 故障 Trace" />;
    const th: React.CSSProperties = { textAlign: "left", padding: "7px 10px", color: "var(--foreground-muted)", fontWeight: 600, borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" };
    const td: React.CSSProperties = { padding: "7px 10px", borderBottom: "1px solid var(--border)", color: "var(--foreground-secondary)" };
    const fmtTs = (iso: string) => new Date(iso).toLocaleString();
    return (
        <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
                <thead><tr><th style={th}>Trace</th><th style={th}>Agent</th><th style={th}>平台</th><th style={th}>故障模式</th><th style={th}>处置结果</th><th style={th}>时间</th><th style={th}>操作</th></tr></thead>
                <tbody>{rows.map((row) => (
                    <tr key={row.executionId}>
                        <td style={{ ...td, fontFamily: "var(--font-mono, monospace)" }}>{row.taskId.slice(0, 12)}…</td>
                        <td style={td}>{row.agent}</td><td style={td}>{row.platform}</td><td style={td}>{row.faultMode}</td>
                        <td style={{ ...td, color: row.recoveryStatus === "recovered" ? "var(--success)" : "var(--warning)", fontWeight: 600 }}>{row.recoveryStatus === "recovered" ? "已恢复" : "未恢复"}</td>
                        <td style={{ ...td, color: "var(--foreground-muted)", whiteSpace: "nowrap" }}>{fmtTs(row.ts)}</td>
                        <td style={td}><a href={getApiUrl(`/trace?taskId=${encodeURIComponent(row.taskId)}`)} style={{ color: "var(--primary)", textDecoration: "none" }}>查看链路 →</a></td>
                    </tr>
                ))}</tbody>
            </table>
        </div>
    );
}

// ═══ 页签：④ 性能 ═══════════════════════════════════════════════════════════
const LAT_MARK_EDGES: [number, string][] = [[2, "0-2s"], [5, "2-5s"], [10, "5-10s"], [20, "10-20s"], [40, "20-40s"], [60, "40-60s"], [Infinity, "60s+"]];
const latBucketOf = (value: number) => LAT_MARK_EDGES.find(([edge]) => value < edge)?.[1] ?? "60s+";
function PerformanceTab({ bd }: { bd: BreakdownsResp }) {
    const performance = bd.performance;
    return (
        <Grid>
            <Panel title="端到端时延分布" hint={`per-trace 对数桶（秒）· 标线 P50=${performance.latP50}s / P95=${performance.latP95}s`}>
                <Histogram data={performance.latHist} color="var(--warning)" marks={[
                    { label: latBucketOf(performance.latP50), text: "P50", color: "var(--primary)" },
                    { label: latBucketOf(performance.latP95), text: "P95", color: "var(--error)" },
                ]} />
            </Panel>
            <Panel
                title="单次调用上下文峰值分布"
                info="每条 trace 取所有 Execution 行 maxSingleCallTokens 的最大值后分桶。无该埋点的 trace 不计入。"
                hint="trace 级 max(maxSingleCallTokens) 分桶"
            >
                <Histogram data={performance.ctxHist} color={TEAL} />
            </Panel>
            <Panel title="慢 Trace 排行" hint="按端到端耗时降序 TOP20（点击进链路）" wide>
                <SlowTable rows={performance.slowTraces} />
            </Panel>
        </Grid>
    );
}

// ═══ 页签：⑤ 模型监控 ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
function ModelTab({ bd, trends }: { bd: BreakdownsResp; trends: TrendsResp }) {
    const c = useThemeColors();
    const m = bd.model;
    return (
        <Grid>
            <Panel title="模型调用次数排行" hint="Σ 模型调用次数 TOP10">
                <HBar data={m.callRank.map((x) => ({ name: x.model, value: x.calls }))} color="var(--primary)" />
            </Panel>
            <Panel title="Token 构成排行" hint="input / output 堆叠 · 柱长=总消耗 TOP10">
                <StackedHBar data={m.tokenComp} />
            </Panel>
            <Panel title="模型成本排行" hint={`按单价加权成本 TOP10（${trends.currency}）· 缺价模型计 0 不上榜`}>
                <HBar data={m.costRank.map((x) => ({ name: x.model, value: x.cost }))} color="var(--warning)" fmt={fmtCost} />
            </Panel>
            <Panel
                title="缓存命中率 / 节省成本趋势"
                info="命中率 = cacheRead ÷ (input + cacheRead)：走缓存的输入 token 占比（无 cache 埋点的调用计 0 命中）。节省成本 = 命中 token ×（输入单价 − 缓存读单价），即这些 token 若未命中按全价计费的差额；缺价模型计 0。"
                hint="命中率 %（左）· 节省 USD（右）"
            >
                <ResponsiveContainer width="100%" height={CHART_H}>
                    <ComposedChart data={trends.buckets} margin={mgn}>
                        <CartesianGrid strokeDasharray="3 3" stroke={c.border} vertical={false} />
                        <XAxis dataKey="label" stroke={c.fgMuted} tick={ax} interval="preserveStartEnd" />
                        <YAxis yAxisId="hit" width={52} stroke={c.fgMuted} tick={ax} unit="%" domain={[0, 100]} />
                        <YAxis yAxisId="save" orientation="right" width={52} stroke={c.fgMuted} tick={ax} tickFormatter={(v) => `$${v}`} />
                        <Tooltip contentStyle={tipStyle} /><Legend verticalAlign="top" align="right" wrapperStyle={lg} />
                        <Line yAxisId="hit" type="monotone" dataKey="cacheHitRate" name="命中率 %" stroke={c.success} strokeWidth={2} dot={{ r: 2 }} />
                        <Line yAxisId="save" type="monotone" dataKey="cacheSavedUsd" name="节省成本(USD)" stroke={c.warning} strokeWidth={2} strokeDasharray="5 4" dot={false} />
                    </ComposedChart>
                </ResponsiveContainer>
            </Panel>
            <Panel
                title="输出 Token 构成"
                info="reasoning（思维链）/ 可见输出堆叠。reasoning 占比过高意味着成本与时延被推理放大。无 reasoning 埋点的调用计 0——本图只在有 reasoning 数据的窗口有意义。"
                hint="reasoning / 可见输出 堆叠"
            >
                <ResponsiveContainer width="100%" height={CHART_H}>
                    <BarChart data={trends.buckets} margin={mgn}>
                        <CartesianGrid strokeDasharray="3 3" stroke={c.border} vertical={false} />
                        <XAxis dataKey="label" stroke={c.fgMuted} tick={ax} interval="preserveStartEnd" />
                        <YAxis width={52} stroke={c.fgMuted} tick={ax} tickFormatter={fmtTok} />
                        <Tooltip contentStyle={tipStyle} formatter={(v) => fmtInt(Number(v))} /><Legend verticalAlign="top" align="right" wrapperStyle={lg} />
                        <Bar dataKey="reasoningTokens" name="reasoning" stackId="o" fill="#8B5CF6" />
                        <Bar dataKey="visibleOutputTokens" name="可见输出" stackId="o" fill={TEAL} radius={[2, 2, 0, 0]} />
                    </BarChart>
                </ResponsiveContainer>
            </Panel>
            <Panel
                title="模型调用平均耗时趋势"
                info="全模型汇总：Σ模型调用耗时 ÷ 有效调用次数（callStats 摘要，纯模型推理口径）。分模型差异见底部「模型调用时延排行」。"
                hint={`Σ耗时 ÷ 调用次数（秒）· 摘要覆盖 ${bd.callStatsCoverage.withStats}/${bd.callStatsCoverage.total} trace`}
            >
                <ResponsiveContainer width="100%" height={CHART_H}>
                    <LineChart data={m.trend.map((t) => ({ ...t, avgS: t.avgMs != null ? Math.round(t.avgMs / 100) / 10 : null }))} margin={mgn}>
                        <CartesianGrid strokeDasharray="3 3" stroke={c.border} vertical={false} />
                        <XAxis dataKey="label" stroke={c.fgMuted} tick={ax} interval="preserveStartEnd" />
                        <YAxis width={52} stroke={c.fgMuted} tick={ax} unit="s" />
                        <Tooltip contentStyle={tipStyle} />
                        <Line type="monotone" dataKey="avgS" name="均耗时(s)" stroke={c.warning} strokeWidth={2} dot={{ r: 2 }} connectNulls />
                    </LineChart>
                </ResponsiveContainer>
            </Panel>
            <Panel
                title="Token 输出速率趋势"
                info="Σoutput tokens ÷ Σ模型调用耗时（tok/s，全模型汇总）。下降=模型服务变慢或流量转向慢模型；与 /infra 的服务端吞吐指标可互相印证。"
                hint="output tokens ÷ 模型耗时（tok/s）"
            >
                <ResponsiveContainer width="100%" height={CHART_H}>
                    <LineChart data={m.trend} margin={mgn}>
                        <CartesianGrid strokeDasharray="3 3" stroke={c.border} vertical={false} />
                        <XAxis dataKey="label" stroke={c.fgMuted} tick={ax} interval="preserveStartEnd" />
                        <YAxis width={52} stroke={c.fgMuted} tick={ax} />
                        <Tooltip contentStyle={tipStyle} />
                        <Line type="monotone" dataKey="tokPerSec" name="tok/s" stroke="#0EA5E9" strokeWidth={2} dot={{ r: 2 }} connectNulls />
                    </LineChart>
                </ResponsiveContainer>
            </Panel>
            <Panel
                title="模型耗时箱线"
                info="per-call 耗时分布（P10/P25/P50/P75/P90，直方图桶内插值估算）。箱体（P25-P75）越高 = 耗时越不稳定；取调用量 TOP5 模型。y 轴为对数刻度——per-call 耗时常跨 2-3 个数量级，线性轴会被极端模型压垮导致其余箱体贴地不可读。"
                hint="P10-P90 分布 · y 轴对数刻度 · 直方图估算 · 调用量 TOP5"
            >
                {m.box.length ? <BoxPlot data={m.box} /> : <Placeholder text="窗口内无带耗时的模型调用" />}
            </Panel>
            <Panel
                title="模型调用时延排行"
                info="per-call 耗时（callStats 摘要跨 trace 合并）。均耗时精确；P50/P95/P99 为对数桶直方图桶内插值估算（误差≤桶宽）。覆盖=有耗时字段的调用数（部分框架不上报 per-call 耗时）。"
                hint="按调用次数降序 · P95>7s / P99>12s 高亮 · 分位为直方图估算" wide
            >
                <ModelLatTable rows={m.latRank} />
            </Panel>
        </Grid>
    );
}
function ModelLatTable({ rows }: { rows: BreakdownsResp['model']['latRank'] }) {
    if (!rows.length) return <Placeholder text="暂无数据" />;
    const th: React.CSSProperties = { textAlign: 'right', padding: '7px 10px', color: 'var(--foreground-muted)', fontWeight: 600, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
    const td: React.CSSProperties = { padding: '7px 10px', borderBottom: '1px solid var(--border)', color: 'var(--foreground-secondary)', fontFamily: 'var(--font-mono, monospace)', textAlign: 'right' };
    const sec = (ms: number | null) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`);
    return (
        <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                <thead><tr>
                    <th style={{ ...th, textAlign: 'left' }}>模型</th><th style={th}>调用</th><th style={th}>覆盖</th>
                    <th style={th}>均耗时</th><th style={th}>P50</th><th style={th}>P95</th><th style={th}>P99</th>
                </tr></thead>
                <tbody>
                    {rows.map((r, i) => (
                        <tr key={i}>
                            <td style={{ ...td, textAlign: 'left' }}>{r.model}</td>
                            <td style={td}>{fmtInt(r.calls)}</td>
                            <td style={{ ...td, color: 'var(--foreground-muted)' }}>{r.calls ? Math.round((r.coveredN / r.calls) * 100) : 0}%</td>
                            <td style={td}>{sec(r.avgMs)}</td>
                            <td style={td}>{sec(r.p50Ms)}</td>
                            <td style={{ ...td, ...(r.p95Ms != null && r.p95Ms > 7000 ? { color: 'var(--warning)', fontWeight: 700 } : {}) }}>{sec(r.p95Ms)}</td>
                            <td style={{ ...td, ...(r.p99Ms != null && r.p99Ms > 12000 ? { color: 'var(--error)', fontWeight: 700 } : {}) }}>{sec(r.p99Ms)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
// 横向箱线：每模型一行，须=P10-P90、箱=P25-P75、竖线=P50（数据为直方图估算）。
function BoxPlot({ data }: { data: BreakdownsResp['model']['box'] }) {
    const cols = data.filter((d) => d.p10 != null && d.p90 != null);
    if (!cols.length) return <Placeholder text="暂无数据" />;
    // 竖版：模型在 x 轴、耗时在 y 轴（对齐高保真）。须=P10-P90、箱=P25-P75、粗线=P50。
    // y 轴用【对数刻度】：per-call 耗时常跨 2-3 个数量级（几十 ms ~ 上千 s），线性轴会被
    // 极端模型压垮、其余箱体贴地不可读；数据本身就是对数桶采集的，对数轴天然匹配。
    const W2 = 460, H2 = CHART_H, PADL = 52, PADR = 14, PADT = 12, PADB = 30;
    const lo = Math.max(1, Math.min(...cols.map((d) => d.p10 as number)) / 1.6);
    const hi = Math.max(...cols.map((d) => d.p90 as number)) * 1.6;
    const lgLo = Math.log10(lo), lgHi = Math.log10(Math.max(hi, lo * 10));
    const sy = (ms: number) => PADT + (H2 - PADT - PADB) * (1 - (Math.log10(Math.max(ms, lo)) - lgLo) / (lgHi - lgLo));
    // 刻度：优先整数量级（100ms/1s/10s…）；跨度不足 3 个数量级时补 1-2-5 次刻度，避免只剩一条网格线
    const top = Math.max(hi, lo * 10);
    const decades: number[] = [];
    for (let e = Math.floor(lgLo); e <= Math.ceil(lgHi); e++) {
        const v = 10 ** e;
        if (v >= lo && v <= top) decades.push(v);
    }
    let ticks = decades;
    if (decades.length < 3) {
        ticks = [];
        for (let e = Math.floor(lgLo); e <= Math.ceil(lgHi); e++) {
            for (const m of [1, 2, 5]) {
                const v = m * 10 ** e;
                if (v >= lo && v <= top) ticks.push(v);
            }
        }
    }
    const cx = (i: number) => PADL + (W2 - PADL - PADR) * ((i + 0.5) / cols.length);
    const bw = Math.min(30, (W2 - PADL - PADR) / cols.length * 0.45);
    const secLabel = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s` : `${Math.round(ms)}ms`);
    return (
        <svg viewBox={`0 0 ${W2} ${H2}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
            {ticks.map((v) => (
                <g key={v}>
                    <line x1={PADL} y1={sy(v)} x2={W2 - PADR} y2={sy(v)} stroke="var(--border)" strokeDasharray="3 3" />
                    <text x={PADL - 5} y={sy(v) + 3} textAnchor="end" fontSize={8.5} fill="var(--foreground-muted)" fontFamily="var(--font-mono, monospace)">{secLabel(v)}</text>
                </g>
            ))}
            {cols.map((d, i) => {
                const x = cx(i);
                const [p10, p25, p50, p75, p90] = [d.p10!, d.p25!, d.p50!, d.p75!, d.p90!];
                const label = d.model.length > 12 ? `${d.model.slice(0, 11)}…` : d.model;
                return (
                    <g key={d.model}>
                        <title>{`${d.model}\nP10 ${secLabel(p10)} · P25 ${secLabel(p25)} · P50 ${secLabel(p50)} · P75 ${secLabel(p75)} · P90 ${secLabel(p90)}`}</title>
                        {/* 须线 + 上下横帽 */}
                        <line x1={x} y1={sy(p90)} x2={x} y2={sy(p10)} stroke="var(--foreground-muted)" />
                        <line x1={x - 8} y1={sy(p90)} x2={x + 8} y2={sy(p90)} stroke="var(--foreground-muted)" />
                        <line x1={x - 8} y1={sy(p10)} x2={x + 8} y2={sy(p10)} stroke="var(--foreground-muted)" />
                        {/* 箱体 P25-P75 + 中位线 P50 */}
                        <rect x={x - bw / 2} y={sy(p75)} width={bw} height={Math.max(2, sy(p25) - sy(p75))} rx={2}
                            fill="var(--primary-subtle, rgba(79,70,229,.12))" stroke="var(--primary)" strokeWidth={1.4} />
                        <line x1={x - bw / 2} y1={sy(p50)} x2={x + bw / 2} y2={sy(p50)} stroke="var(--primary)" strokeWidth={2} />
                        <text x={x} y={H2 - 10} textAnchor="middle" fontSize={9.5} fill="var(--foreground-muted)" fontFamily="var(--font-mono, monospace)">{label}</text>
                    </g>
                );
            })}
        </svg>
    );
}

// ═══ 页签：⑥ 工具监控 ════════════════════════════════════════════════════════
function ToolTab({ bd }: { bd: BreakdownsResp }) {
    const c = useThemeColors();
    const t = bd.tool.trend;
    return (
        <Grid>
            <Panel title="工具调用量趋势" hint="Σ tool_calls 条数 / 桶">
                <ResponsiveContainer width="100%" height={CHART_H}>
                    <LineChart data={t} margin={mgn}>
                        <CartesianGrid strokeDasharray="3 3" stroke={c.border} vertical={false} />
                        <XAxis dataKey="label" stroke={c.fgMuted} tick={ax} interval="preserveStartEnd" />
                        <YAxis width={52} stroke={c.fgMuted} tick={ax} allowDecimals={false} domain={[0, 'auto']} />
                        <Tooltip contentStyle={tipStyle} />
                        <Line type="monotone" dataKey="calls" name="工具调用" stroke={c.primary} strokeWidth={2} dot={{ r: 2 }} />
                    </LineChart>
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
            <Panel
                title="工具调用耗时均值趋势"
                info="Σ工具调用耗时 ÷ 有效调用次数（callStats 摘要）。部分框架不上报工具耗时（如 opencode），这些调用不参与均值——覆盖情况见底部排行表的「覆盖」列。"
                hint={`per-call 均耗时（ms）· 摘要覆盖 ${bd.callStatsCoverage.withStats}/${bd.callStatsCoverage.total} trace`}
            >
                <ResponsiveContainer width="100%" height={CHART_H}>
                    <LineChart data={t} margin={mgn}>
                        <CartesianGrid strokeDasharray="3 3" stroke={c.border} vertical={false} />
                        <XAxis dataKey="label" stroke={c.fgMuted} tick={ax} interval="preserveStartEnd" />
                        <YAxis width={52} stroke={c.fgMuted} tick={ax} unit="ms" />
                        <Tooltip contentStyle={tipStyle} />
                        <Line type="monotone" dataKey="avgMs" name="均耗时(ms)" stroke={c.warning} strokeWidth={2} dot={{ r: 2 }} connectNulls />
                    </LineChart>
                </ResponsiveContainer>
            </Panel>
            <Panel
                title="工具调用排行"
                info="真实工具名（callStats 摘要跨 trace 合并）。成功率=1−error 态占比；均耗时/P50 只统计有耗时字段的调用（覆盖列），P50 为直方图估算。"
                hint="调用次数 TOP10 · 成功率 <95% 高亮" wide
            >
                <ToolRankTable rows={bd.tool.rank} />
            </Panel>
        </Grid>
    );
}
function ToolRankTable({ rows }: { rows: BreakdownsResp['tool']['rank'] }) {
    if (!rows.length) return <Placeholder text="窗口内无工具调用摘要（等待新 trace 写入或执行回填）" />;
    const th: React.CSSProperties = { textAlign: 'right', padding: '7px 10px', color: 'var(--foreground-muted)', fontWeight: 600, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
    const td: React.CSSProperties = { padding: '7px 10px', borderBottom: '1px solid var(--border)', color: 'var(--foreground-secondary)', fontFamily: 'var(--font-mono, monospace)', textAlign: 'right' };
    const ms = (v: number | null) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);
    return (
        <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                <thead><tr>
                    <th style={{ ...th, textAlign: 'left' }}>工具</th><th style={th}>调用</th><th style={th}>成功率</th>
                    <th style={th}>覆盖</th><th style={th}>均耗时</th><th style={th}>P50</th><th style={th}>P95</th><th style={th}>P99</th>
                </tr></thead>
                <tbody>
                    {rows.map((r, i) => (
                        <tr key={i}>
                            <td style={{ ...td, textAlign: 'left' }}>{r.tool}</td>
                            <td style={td}>{fmtInt(r.calls)}</td>
                            <td style={{ ...td, ...(r.successRate < 95 ? { color: 'var(--error)', fontWeight: 700 } : { color: 'var(--success)' }) }}>{r.successRate}%</td>
                            <td style={{ ...td, color: 'var(--foreground-muted)' }}>{r.calls ? Math.round((r.coveredN / r.calls) * 100) : 0}%</td>
                            <td style={td}>{ms(r.avgMs)}</td>
                            <td style={td}>{ms(r.p50Ms)}</td>
                            <td style={td}>{ms(r.p95Ms)}</td>
                            <td style={td}>{ms(r.p99Ms)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

// ═══ 页签：⑦ Agent 监控 ══════════════════════════════════════════════════════
function AgentTab({ bd, onAgentClick }: { bd: BreakdownsResp; onAgentClick: (name: string) => void }) {
    const c = useThemeColors();
    const a = bd.agent;
    return (
        <Grid>
            <Panel title="平均执行工具数 / 模型数趋势" hint="每 trace 人均（分母=当桶 trace 数）· 差距变化=「动手比例」变化">
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
            <Panel
                title="平均执行步数趋势"
                info="步数 = interactions 轮次（含 user/assistant/tool 各类条目，callStats 摘要，分母=当桶有摘要的 trace）。与模型调用数强相关但含义不同：步数持续上涨而任务构成未变 = 任务变绕（空转/重试/多余往返），是编排效率恶化的领先信号。"
                hint="interactions 轮次 ÷ trace 数（有摘要口径）"
            >
                <ResponsiveContainer width="100%" height={CHART_H}>
                    <LineChart data={a.trend} margin={mgn}>
                        <CartesianGrid strokeDasharray="3 3" stroke={c.border} vertical={false} />
                        <XAxis dataKey="label" stroke={c.fgMuted} tick={ax} interval="preserveStartEnd" />
                        <YAxis width={52} stroke={c.fgMuted} tick={ax} />
                        <Tooltip contentStyle={tipStyle} />
                        <Line type="monotone" dataKey="avgSteps" name="平均步数" stroke="#8B5CF6" strokeWidth={2} dot={{ r: 2 }} connectNulls />
                    </LineChart>
                </ResponsiveContainer>
            </Panel>
            <Panel title="Agent Token 消耗（self）" hint="按 Agent 自身 token TOP10 · 点击下钻">
                <HBar data={a.tokenRank.map((x) => ({ name: x.name, value: x.tokens }))} color="var(--warning)" fmt={fmtTok} onClick={onAgentClick} />
            </Panel>
            <Panel
                title="单位任务 Token（主 Agent · inclusive）"
                info="按「接单的入口 Agent」记账：整条 trace（含其派生子 Agent）的全部 token 记到主 Agent 头上，再 ÷ 该主 Agent 的 trace 数。回答「派一个任务给这个入口平均烧多少 token」——self 榜按「干活的人」记账，答不了这个（大头可能在子 Agent）。单 Agent trace 也计入（此时 inclusive = self）。"
                hint="Σ整链 token ÷ trace 数 · 点击下钻"
            >
                {a.unitTokenRank.length
                    ? <HBar data={a.unitTokenRank.map((x) => ({ name: x.name, value: x.avgTokens }))} color="#8B5CF6" fmt={fmtTok} onClick={onAgentClick} />
                    : <Placeholder text="窗口内无带主 Agent 名的 trace" />}
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

// ═══ 页签：⑧ 多智能体编排 ════════════════════════════════════════════════════
function OrchestrationTab({ bd, onAgentClick }: { bd: BreakdownsResp; onAgentClick: (name: string) => void }) {
    const col = bd.orchestration.collab;
    return (
        <Grid>
            {/* 与协作网络并列等高（网络图高 440 + 图表内边距），避免半行留白 */}
            <Panel title="编排复杂度分布" hint="每 trace 的 distinct Agent 数分桶">
                <Histogram data={bd.orchestration.complexityHist} color="var(--primary)" height={446} />
            </Panel>
            <Panel
                title="全局协作网络"
                info="边来自 buildAgentCallTree 还原的 parent→child 派发关系（谁 spawn 了谁），跨当前窗口内所有 trace 聚合，边权=派发次数、节点大小=中心度。非 send_message 点对点消息（该口径四框架均无数据源），但同样能识别通信枢纽 Agent。"
                hint={`节点大小=中心度 · 边=派发(from→to) · 点击节点下钻 · ${col.traceCount} 条多 Agent trace${col.truncated ? '（已截断）' : ''}`}
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
    { label: '缓存命中率', key: 'cacheHitRate', fmt: fmtPct, goodWhenUp: true, tone: 'good', group: '模型' },
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
                {/* barSize 固定为 TOP10 满员时的粗细：条目少时不随可用高度膨胀成粗块。
                    关动画：30s 静默刷新会反复触发入场动画（且后台标签页 rAF 暂停会卡在 0 宽）。 */}
                <Bar dataKey="value" barSize={14} isAnimationActive={false} fill={color} radius={[0, 3, 3, 0]} cursor={onClick ? 'pointer' : undefined}
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
                <Bar dataKey="input" name="input" barSize={14} isAnimationActive={false} stackId="s" fill={c.primary} />
                <Bar dataKey="output" name="output" barSize={14} isAnimationActive={false} stackId="s" fill={TEAL} radius={[0, 3, 3, 0]} />
            </BarChart>
        </ResponsiveContainer>
    );
}
function Histogram({ data, color, marks, height }: {
    data: { label: string; count: number }[]; color: string;
    marks?: { label: string; text: string; color: string }[]; height?: number;
}) {
    const c = useThemeColors();
    return (
        <ResponsiveContainer width="100%" height={height ?? CHART_H}>
            <BarChart data={data} margin={mgn}>
                <CartesianGrid strokeDasharray="3 3" stroke={c.border} vertical={false} />
                <XAxis dataKey="label" stroke={c.fgMuted} tick={ax} />
                <YAxis width={52} stroke={c.fgMuted} tick={ax} allowDecimals={false} />
                <Tooltip contentStyle={tipStyle} />
                {(marks ?? []).map((m) => (
                    <ReferenceLine key={m.text} x={m.label} stroke={m.color} strokeWidth={1.5} strokeDasharray="5 4"
                        label={{ value: m.text, position: 'top', fill: m.color, fontSize: 10 }} />
                ))}
                <Bar dataKey="count" name="trace 数" fill={color} radius={[2, 2, 0, 0]} />
            </BarChart>
        </ResponsiveContainer>
    );
}
function SlowTable({ rows }: { rows: BreakdownsResp['performance']['slowTraces'] }) {
    if (!rows.length) return <Placeholder text="暂无数据" />;
    const th: React.CSSProperties = { textAlign: 'left', padding: '7px 10px', color: 'var(--foreground-muted)', fontWeight: 600, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
    const td: React.CSSProperties = { padding: '7px 10px', borderBottom: '1px solid var(--border)', color: 'var(--foreground-secondary)' };
    const fmtTs = (iso: string) => {
        const d = new Date(iso);
        return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    const num: React.CSSProperties = { ...td, fontFamily: 'var(--font-mono, monospace)', textAlign: 'right' };
    return (
        <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                <thead><tr>
                    <th style={th}>Trace</th><th style={th}>Agent</th><th style={th}>平台</th><th style={th}>任务 (query)</th>
                    <th style={{ ...th, textAlign: 'right' }}>时延(s)</th>
                    <th style={{ ...th, textAlign: 'right' }}>模型调用</th>
                    <th style={{ ...th, textAlign: 'right' }}>模型调用均耗时 <Info text="= Σ模型调用耗时 ÷ 有效调用次数（callStats 摘要，纯模型推理口径，不含工具与等待）。复杂任务调用多、均值不高属正常；均值高（>5s/次 标红）= 单次模型调用异常慢（超长上下文/限流重试/慢模型），值得点进链路排查。" /></th>
                    <th style={{ ...th, textAlign: 'right' }}>Token</th>
                    <th style={{ ...th, textAlign: 'right' }}>Agent 数</th>
                    <th style={th}>时间</th>
                </tr></thead>
                <tbody>
                    {rows.map((r, i) => (
                        <tr key={i}>
                            <td style={td}><a href={getApiUrl(`/trace?taskId=${encodeURIComponent(r.taskId)}`)} style={{ color: 'var(--primary)', textDecoration: 'none', fontFamily: 'var(--font-mono, monospace)' }}>{r.taskId.slice(0, 12)}…</a></td>
                            <td style={td}>{r.agent}</td>
                            <td style={td}>{r.platform}</td>
                            <td style={{ ...td, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.query}>{r.query || '—'}</td>
                            <td style={{ ...num, color: 'var(--warning)' }}>{r.latency}</td>
                            <td style={num}>{r.llmCalls || '—'}</td>
                            <td style={{ ...num, ...(r.avgLlmMs != null && r.avgLlmMs >= 5000 ? { color: 'var(--error)', fontWeight: 700 } : { color: 'var(--foreground-muted)' }) }}>
                                {r.avgLlmMs != null ? `${(r.avgLlmMs / 1000).toFixed(1)}s/次` : '—'}
                            </td>
                            <td style={num}>{fmtInt(r.tokens)}</td>
                            <td style={num}>{r.agents}</td>
                            <td style={{ ...td, fontFamily: 'var(--font-mono, monospace)', color: 'var(--foreground-muted)', whiteSpace: 'nowrap' }}>{fmtTs(r.ts)}</td>
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
    avgSteps: number | null; stepsCovered: number;
}
interface AgentResp {
    name: string; window: string; currency: string; found: boolean;
    stats: AgentStats;
    trend: { label: string; calls: number; tokens: number; latencyP95: number; cost: number; avgTools: number | null; avgModels: number | null; avgSteps: number | null }[];
    topModels: { model: string; calls: number; tokens: number }[];
    toolMix: { tool: string; calls: number; errN: number }[];
    errTypes: { tool: { label: string; count: number }[]; judge: { label: string; count: number }[] };
    slowTraces: { taskId: string; query: string; latency: number; avgLlmMs: number | null; ok: boolean }[];
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
                                <Mini label="平均执行工具数" v={s.traces ? (s.toolCalls / s.traces).toFixed(1) : '—'} title="Σ工具调用 ÷ 参与 trace 数：该 Agent 平均一个任务用几次工具" />
                                <Mini label="平均模型调用次数" v={s.traces ? (s.llmCalls / s.traces).toFixed(1) : '—'} title="Σ模型调用 ÷ 参与 trace 数：该 Agent 平均一个任务调几次模型" />
                                <Mini label="平均执行步数" v={s.avgSteps != null ? String(s.avgSteps) : '—'} title={`interactions 轮次 ÷ 有摘要的执行数（callStats 预解析，覆盖 ${s.stepsCovered}/${s.executions}）：该 Agent 平均一个任务走多少轮`} />
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
                            <Panel title="平均工具数 / 模型调用数趋势" hint="每 trace 人均（该 Agent 的执行）">
                                <ResponsiveContainer width="100%" height={200}>
                                    <LineChart data={data.trend} margin={mgn}>
                                        <CartesianGrid strokeDasharray="3 3" stroke={c.border} vertical={false} />
                                        <XAxis dataKey="label" stroke={c.fgMuted} tick={ax} interval="preserveStartEnd" />
                                        <YAxis width={40} stroke={c.fgMuted} tick={ax} />
                                        <Tooltip contentStyle={tipStyle} /><Legend verticalAlign="top" align="right" wrapperStyle={lg} />
                                        <Line type="monotone" dataKey="avgTools" name="平均工具数" stroke={c.primary} strokeWidth={2} dot={false} connectNulls />
                                        <Line type="monotone" dataKey="avgModels" name="平均模型调用数" stroke={TEAL} strokeWidth={2} dot={false} connectNulls />
                                    </LineChart>
                                </ResponsiveContainer>
                            </Panel>
                            <Panel title="平均执行步数趋势" hint="interactions 轮次 ÷ 有摘要的执行数 · 涨=任务变绕">
                                <ResponsiveContainer width="100%" height={200}>
                                    <LineChart data={data.trend} margin={mgn}>
                                        <CartesianGrid strokeDasharray="3 3" stroke={c.border} vertical={false} />
                                        <XAxis dataKey="label" stroke={c.fgMuted} tick={ax} interval="preserveStartEnd" />
                                        <YAxis width={40} stroke={c.fgMuted} tick={ax} />
                                        <Tooltip contentStyle={tipStyle} />
                                        <Line type="monotone" dataKey="avgSteps" name="平均步数" stroke="#8B5CF6" strokeWidth={2} dot={{ r: 2 }} connectNulls />
                                    </LineChart>
                                </ResponsiveContainer>
                            </Panel>
                            {data.topModels.length > 0 && (
                                <Panel title="常用模型" hint="按 token 占用">
                                    <HBar data={data.topModels.map((m) => ({ name: m.model, value: m.tokens }))} color={TEAL} fmt={fmtTok} />
                                </Panel>
                            )}
                            {data.toolMix.length > 0 && (
                                <Panel title="工具使用分布" hint="该 Agent 发起的工具调用次数 TOP（callStats 摘要）">
                                    <HBar data={data.toolMix.map((t) => ({ name: t.tool, value: t.calls }))} color="var(--primary)" />
                                </Panel>
                            )}
                            {(data.errTypes.tool.length > 0 || data.errTypes.judge.length > 0) && (
                                <Panel title="失败原因分类" hint="工具错误规则归类 + judge 判定（判定: 前缀）">
                                    <HBar data={[
                                        ...data.errTypes.tool.map((x) => ({ name: x.label, value: x.count })),
                                        ...data.errTypes.judge.map((x) => ({ name: `判定:${x.label}`, value: x.count })),
                                    ]} color="var(--error)" />
                                </Panel>
                            )}
                            {data.slowTraces.length > 0 && (
                                <Panel title="慢 Trace" hint="该 Agent 参与 · 按耗时降序 · 均耗时=Σ模型耗时÷调用（>5s/次 标红）">
                                    <DrawerSlowTable rows={data.slowTraces} />
                                </Panel>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
function DrawerSlowTable({ rows }: { rows: AgentResp['slowTraces'] }) {
    const th: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', color: 'var(--foreground-muted)', fontWeight: 600, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
    const td: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid var(--border)', color: 'var(--foreground-secondary)' };
    return (
        <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead><tr>
                    <th style={th}>Trace</th><th style={th}>任务 (query)</th>
                    <th style={{ ...th, textAlign: 'right' }}>时延(s)</th>
                    <th style={{ ...th, textAlign: 'right' }}>模型调用均耗时</th>
                </tr></thead>
                <tbody>
                    {rows.map((r, i) => (
                        <tr key={i}>
                            <td style={td}><a href={getApiUrl(`/trace?taskId=${encodeURIComponent(r.taskId)}`)} style={{ color: 'var(--primary)', textDecoration: 'none', fontFamily: 'var(--font-mono, monospace)' }}>{r.taskId.slice(0, 10)}…</a></td>
                            <td style={{ ...td, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.query}>{r.query || '—'}</td>
                            <td style={{ ...td, fontFamily: 'var(--font-mono, monospace)', textAlign: 'right', color: 'var(--warning)' }}>{r.latency}</td>
                            <td style={{ ...td, fontFamily: 'var(--font-mono, monospace)', textAlign: 'right', ...(r.avgLlmMs != null && r.avgLlmMs >= 5000 ? { color: 'var(--error)', fontWeight: 700 } : { color: 'var(--foreground-muted)' }) }}>
                                {r.avgLlmMs != null ? `${(r.avgLlmMs / 1000).toFixed(1)}s/次` : '—'}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
function Mini({ label, v, tone, title }: { label: string; v: string; tone?: 'good' | 'latency'; title?: string }) {
    const color = tone === 'good' ? 'var(--success)' : tone === 'latency' ? 'var(--warning)' : 'var(--foreground)';
    return (
        <div title={title} style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 9, padding: '9px 11px', cursor: title ? 'help' : undefined }}>
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
