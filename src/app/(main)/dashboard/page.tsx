'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { AppTopBar } from '@/components/shell/AppTopBar';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AgentRow {
    name: string;
    platform: string;
    status: 'running' | 'idle' | 'error';
    calls: number;
    successRate: number;
    p95ms: number;
}

interface AlertRow {
    id: number;
    level: string;
    agent: string;
    desc: string;
    href: string;
    cta: string;
}

interface TrendRow {
    day: string;
    calls: number;
    success: number;
}

interface RecentItem {
    icon: string;
    text: string;
    time: string;
    href: string;
}

interface DashboardStats {
    health: {
        totalAgents: number;
        onlineAgents: number;
        todayCalls: number;
        yesterdayCalls: number;
        successRate1h: number | null;
        p95Latency: number;
        avgLatency: number;
        todayCost: number;
    };
    trend: TrendRow[];
    agents: AgentRow[];
    alerts: AlertRow[];
    recent: RecentItem[];
    availablePlatforms: string[];
}

// ─── Fallback data (shown while loading or when DB is empty) ──────────────────

const EMPTY_STATS: DashboardStats = {
    health: {
        totalAgents: 0, onlineAgents: 0, todayCalls: 0, yesterdayCalls: 0,
        successRate1h: null, p95Latency: 0, avgLatency: 0, todayCost: 0,
    },
    trend: Array.from({ length: 7 }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - (6 - i));
        return { day: `${d.getMonth() + 1}/${d.getDate()}`, calls: 0, success: 0 };
    }),
    agents: [],
    alerts: [],
    recent: [],
    availablePlatforms: [],
};

const REFRESH_OPTIONS = [
    { label: '3s',  value: 3000  },
    { label: '5s',  value: 5000  },
    { label: '10s', value: 10000 },
    { label: '30s', value: 30000 },
    { label: '60s', value: 60000 },
];

// ─── Primitives ───────────────────────────────────────────────────────────────

function Section({ label, badge, children, style }: {
    label: string;
    badge?: React.ReactNode;
    children: React.ReactNode;
    style?: React.CSSProperties;
}) {
    return (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 12, ...style }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                    fontSize: 13, fontWeight: 700,
                    color: 'var(--foreground)',
                    letterSpacing: 0.1,
                }}>
                    {label}
                </span>
                {badge}
            </div>
            {children}
        </section>
    );
}

function Sparkline({ data, color = 'var(--primary)' }: { data: number[]; color?: string }) {
    const max = Math.max(...data), min = Math.min(...data);
    const range = max - min || 1;
    const W = 72, H = 26;
    const pts = data.map((v, i) =>
        `${(i / (data.length - 1)) * W},${H - ((v - min) / range) * H}`
    ).join(' ');
    return (
        <svg width={W} height={H} style={{ display: 'block', flexShrink: 0 }}>
            <polyline points={pts} fill="none" stroke={color} strokeWidth="1.8"
                strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

// ─── Filter Bar ───────────────────────────────────────────────────────────────

function FilterSelect({ label, value, onChange, options }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    options: { value: string; label: string }[];
}) {
    const isActive = value !== options[0].value;
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontSize: 11, color: 'var(--foreground-muted)', flexShrink: 0 }}>
                {label}
            </span>
            <div style={{ position: 'relative' }}>
                <select
                    value={value}
                    onChange={e => onChange(e.target.value)}
                    style={{
                        fontSize: 12,
                        padding: '3px 22px 3px 8px',
                        borderRadius: 6,
                        border: `1px solid ${isActive ? 'var(--border)' : 'var(--border)'}`,
                        background: isActive ? 'var(--primary-subtle)' : 'var(--background)',
                        color: isActive ? 'var(--primary)' : 'var(--foreground-secondary)',
                        cursor: 'pointer',
                        outline: 'none',
                        appearance: 'none' as const,
                        WebkitAppearance: 'none' as const,
                        lineHeight: 1.5,
                        fontWeight: isActive ? 500 : 400,
                    }}
                >
                    {options.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                </select>
                <span style={{
                    position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                    fontSize: 9, color: 'var(--foreground-muted)', pointerEvents: 'none',
                }}>
                    ▾
                </span>
            </div>
        </div>
    );
}

function FilterBar({
    platforms,
    filterPlatform,
    setFilterPlatform,
    filterOwnership,
    setFilterOwnership,
}: {
    platforms: string[];
    filterPlatform: string;
    setFilterPlatform: (v: string) => void;
    filterOwnership: string;
    setFilterOwnership: (v: string) => void;
}) {
    const platformOptions = [
        { value: 'all', label: '全部平台' },
        ...platforms.map(p => ({ value: p, label: p })),
    ];
    const ownershipOptions = [
        { value: 'user', label: '用户 Agent' },
        { value: 'all',  label: '全部类型'   },
    ];

    return (
        <div style={{
            display: 'flex', alignItems: 'center', gap: 16,
            padding: '6px 28px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--background)',
        }}>
            <span style={{ fontSize: 11, color: 'var(--foreground-muted)', opacity: 0.7 }}>筛选</span>
            <FilterSelect
                label="平台"
                value={filterPlatform}
                onChange={setFilterPlatform}
                options={platformOptions}
            />
            <FilterSelect
                label="Agent 类型"
                value={filterOwnership}
                onChange={setFilterOwnership}
                options={ownershipOptions}
            />

            <div style={{ flex: 1 }} />

            {/* Supported platforms notice */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>支持平台</span>
                <span style={{
                    fontSize: 11, padding: '2px 8px', borderRadius: 4,
                    background: 'var(--primary-subtle)',
                    color: 'var(--primary)',
                    fontWeight: 500,
                    border: '1px solid color-mix(in srgb, var(--primary) 18%, transparent)',
                }}>
                    opencode
                </span>
                <span style={{ fontSize: 11, color: 'var(--foreground-muted)', opacity: 0.6 }}>
                    · 更多接入中
                </span>
            </div>
        </div>
    );
}

// ─── Block 1：系统健康快照 ────────────────────────────────────────────────────

function HealthCard({ title, value, sub, spark, sparkColor, highlight }: {
    title: string;
    value: React.ReactNode;
    sub: React.ReactNode;
    spark?: number[];
    sparkColor?: string;
    highlight?: boolean;
}) {
    return (
        <div style={{
            flex: 1, minWidth: 170,
            background: highlight
                ? 'linear-gradient(135deg, var(--primary) 0%, color-mix(in srgb,var(--primary) 75%,#000) 100%)'
                : 'var(--card-bg)',
            border: `1px solid ${highlight ? 'transparent' : 'var(--card-border)'}`,
            borderRadius: 12,
            padding: '16px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
        }}>
            <span style={{ fontSize: 11, fontWeight: 500, letterSpacing: 0.3,
                color: highlight ? 'rgba(255,255,255,.72)' : 'var(--foreground-muted)' }}>
                {title}
            </span>
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 28, fontWeight: 700, lineHeight: 1,
                    color: highlight ? '#fff' : 'var(--foreground)' }}>
                    {value}
                </span>
                {spark && spark.length > 1 && (
                    <Sparkline data={spark} color={highlight ? 'rgba(255,255,255,.55)' : sparkColor} />
                )}
            </div>
            <span style={{ fontSize: 11,
                color: highlight ? 'rgba(255,255,255,.65)' : 'var(--foreground-secondary)' }}>
                {sub}
            </span>
        </div>
    );
}

function BlockHealth({ stats }: { stats: DashboardStats }) {
    const { health, trend } = stats;
    const errAgents = stats.agents.filter(a => a.status === 'error').length;

    const callTrend = trend.map(d => d.calls);
    const okTrend = trend.map(d => d.success);

    const todayCallsStr = health.todayCalls.toLocaleString();
    const vsYesterday = health.yesterdayCalls > 0
        ? ((health.todayCalls - health.yesterdayCalls) / health.yesterdayCalls * 100).toFixed(1)
        : null;

    const successRateStr = health.successRate1h != null
        ? `${health.successRate1h.toFixed(1)}%`
        : '—';
    const errorRateStr = health.successRate1h != null
        ? `${(100 - health.successRate1h).toFixed(1)}%`
        : '—';

    const p95Str = health.p95Latency > 0 ? `${health.p95Latency.toLocaleString()}ms` : '—';
    const costStr = health.todayCost > 0 ? `$${health.todayCost.toFixed(3)}` : '$0.000';
    const avgStr = health.avgLatency > 0 ? `均值 ${health.avgLatency}ms` : '暂无数据';

    return (
        <Section label="系统健康快照">
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <HealthCard
                    highlight
                    title="Agent 在线 / 总数"
                    value={<>
                        {health.onlineAgents}
                        <span style={{ fontSize: 16, opacity: .6 }}> / {health.totalAgents}</span>
                    </>}
                    sub={errAgents > 0
                        ? <span style={{ color: '#ff9090' }}>⚠ {errAgents} 个异常</span>
                        : health.totalAgents === 0 ? '尚未注册 Agent' : '全部正常'}
                />
                <HealthCard
                    title="今日调用量"
                    value={todayCallsStr}
                    sub={vsYesterday != null
                        ? <span style={{ color: Number(vsYesterday) >= 0 ? 'var(--tag-green-fg)' : 'var(--error)' }}>
                            {Number(vsYesterday) >= 0 ? '↑' : '↓'} {Math.abs(Number(vsYesterday))}% vs 昨日
                          </span>
                        : '暂无昨日数据'}
                    spark={callTrend}
                    sparkColor="var(--primary)"
                />
                <HealthCard
                    title="成功率（过去 1h）"
                    value={successRateStr}
                    sub={health.successRate1h != null
                        ? <span style={{ color: health.successRate1h < 95 ? 'var(--error)' : 'var(--foreground-secondary)' }}>
                            错误率 {errorRateStr}
                          </span>
                        : '过去 1h 暂无调用'}
                    spark={okTrend}
                    sparkColor="var(--tag-green-fg)"
                />
                <HealthCard
                    title="P95 时延 / 今日成本"
                    value={p95Str}
                    sub={`${avgStr} · 预估 ${costStr}`}
                />
            </div>
        </Section>
    );
}

// ─── Block 2：需要立即处理 ────────────────────────────────────────────────────

const LEVEL_STYLE = {
    error: { dot: 'var(--error)',          badge: 'var(--tag-red-bg)',   text: 'var(--tag-red-fg)'   },
    warn:  { dot: 'var(--tag-amber-fg)',   badge: 'var(--tag-amber-bg)', text: 'var(--tag-amber-fg)' },
    info:  { dot: 'var(--primary)',        badge: 'var(--primary-subtle)', text: 'var(--primary)'    },
} as const;

function BlockAlerts({ alerts, router }: { alerts: AlertRow[]; router: ReturnType<typeof useRouter> }) {
    const errorCount = alerts.filter(a => a.level === 'error').length;
    const badge = errorCount > 0 && (
        <span style={{
            fontSize: 10, fontWeight: 700, padding: '1px 7px',
            borderRadius: 10, background: 'var(--tag-red-bg)', color: 'var(--tag-red-fg)',
        }}>
            {errorCount} 错误
        </span>
    );
    return (
        <Section label="需要立即处理" badge={badge}>
            <div style={{
                background: 'var(--card-bg)',
                border: '1px solid var(--card-border)',
                borderRadius: 12,
                overflow: 'hidden',
            }}>
                {alerts.length === 0 ? (
                    <div style={{ padding: '20px 16px', textAlign: 'center', color: 'var(--foreground-muted)', fontSize: 13 }}>
                        ✅ 暂无告警，系统运行正常
                    </div>
                ) : alerts.map((a, i) => {
                    const s = LEVEL_STYLE[a.level as keyof typeof LEVEL_STYLE] ?? LEVEL_STYLE.info;
                    return (
                        <div
                            key={a.id}
                            onClick={() => router.push(a.href)}
                            style={{
                                display: 'flex', alignItems: 'center', gap: 12,
                                padding: '12px 16px',
                                borderBottom: i < alerts.length - 1 ? '1px solid var(--border)' : 'none',
                                cursor: 'pointer', transition: 'background 0.12s',
                            }}
                            onMouseEnter={e => (e.currentTarget.style.background = 'var(--background)')}
                            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        >
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.dot, flexShrink: 0 }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--foreground)' }}>{a.agent}</span>
                                <span style={{ fontSize: 12, color: 'var(--foreground-secondary)', marginLeft: 8 }}>{a.desc}</span>
                            </div>
                            <span style={{
                                flexShrink: 0, fontSize: 11, fontWeight: 500,
                                padding: '3px 10px', borderRadius: 20,
                                background: s.badge, color: s.text,
                            }}>
                                {a.cta} →
                            </span>
                        </div>
                    );
                })}
            </div>
        </Section>
    );
}

// ─── Block 3：7 日趋势 ────────────────────────────────────────────────────────

function BarChart({ data }: { data: TrendRow[] }) {
    const max = Math.max(...data.map(d => d.calls), 1);
    return (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 96 }}>
            {data.map((d, i) => {
                const isToday = i === data.length - 1;
                return (
                    <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, height: '100%' }}>
                        <div style={{ flex: 1, width: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                            <div
                                title={`${d.calls.toLocaleString()} 次`}
                                style={{
                                    width: '100%',
                                    height: `${Math.max((d.calls / max) * 100, d.calls > 0 ? 4 : 0)}%`,
                                    minHeight: d.calls > 0 ? 4 : 0,
                                    background: isToday ? 'var(--primary)' : 'var(--primary-subtle)',
                                    borderRadius: '3px 3px 0 0',
                                    opacity: isToday ? 1 : 0.65,
                                    transition: 'opacity 0.15s',
                                    cursor: 'default',
                                }}
                            />
                        </div>
                        <span style={{ fontSize: 9, color: isToday ? 'var(--foreground)' : 'var(--foreground-muted)', fontWeight: isToday ? 600 : 400 }}>
                            {d.day}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

function LineChart({ data }: { data: TrendRow[] }) {
    const vals = data.map(d => d.success);
    const hasData = vals.some(v => v > 0);
    const minV = hasData ? Math.max(0, Math.min(...vals.filter(v => v > 0)) - 5) : 0;
    const maxV = hasData ? Math.min(100, Math.max(...vals) + 2) : 100;
    const range = maxV - minV || 1;
    const W = 300, H = 80;

    const toXY = (v: number, i: number) => ({
        x: data.length > 1 ? (i / (data.length - 1)) * W : W / 2,
        y: H - ((v - minV) / range) * H,
    });

    const nonZero = vals.filter(v => v > 0);
    const pts = vals.map((v, i) => { const p = toXY(v, i); return `${p.x},${p.y}`; }).join(' ');
    const refLines = hasData
        ? [minV + range * 0.25, minV + range * 0.5, minV + range * 0.75].map(v => Math.round(v))
        : [95, 97, 99];

    const todayVal = vals[vals.length - 1];
    const minVal = nonZero.length ? Math.min(...nonZero) : 0;

    return (
        <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
            {refLines.map(v => {
                const y = H - ((v - minV) / range) * H;
                return (
                    <g key={v}>
                        <line x1={0} y1={y} x2={W} y2={y} stroke="var(--border)" strokeWidth={0.6} strokeDasharray="4 3" />
                        <text x={2} y={y - 3} fontSize={8} fill="var(--foreground-muted)">{v}%</text>
                    </g>
                );
            })}
            <defs>
                <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.15" />
                    <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
                </linearGradient>
            </defs>
            {hasData && (
                <>
                    <polygon points={`0,${H} ${pts} ${W},${H}`} fill="url(#areaGrad)" />
                    <polyline points={pts} fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    {vals.map((v, i) => {
                        const { x, y } = toXY(v, i);
                        const isToday = i === data.length - 1;
                        return (
                            <g key={i}>
                                <circle cx={x} cy={y} r={isToday ? 4 : 3}
                                    fill={isToday ? 'var(--primary)' : 'var(--card-bg)'}
                                    stroke="var(--primary)" strokeWidth={1.5} />
                                {isToday && (
                                    <text x={x} y={y - 8} fontSize={9} fill="var(--primary)"
                                        textAnchor="middle" fontWeight="600">{v}%</text>
                                )}
                            </g>
                        );
                    })}
                </>
            )}
            {!hasData && (
                <text x={W / 2} y={H / 2} fontSize={11} fill="var(--foreground-muted)"
                    textAnchor="middle" dominantBaseline="middle">暂无数据</text>
            )}
        </svg>
    );
}

function BlockTrend({ trend }: { trend: TrendRow[] }) {
    const todayCalls = trend[trend.length - 1]?.calls ?? 0;
    const avgCalls = trend.length
        ? Math.round(trend.reduce((s, d) => s + d.calls, 0) / trend.length)
        : 0;
    const todaySuccess = trend[trend.length - 1]?.success ?? 0;
    const nonZeroSuccess = trend.map(d => d.success).filter(v => v > 0);
    const minSuccess = nonZeroSuccess.length ? Math.min(...nonZeroSuccess) : 0;

    return (
        <Section label="7 日趋势">
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <div style={{
                    flex: 1, minWidth: 260,
                    background: 'var(--card-bg)', border: '1px solid var(--card-border)',
                    borderRadius: 12, padding: '16px 18px',
                }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>调用量</span>
                        <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>次 / 天</span>
                    </div>
                    <BarChart data={trend} />
                    <div style={{ marginTop: 10, display: 'flex', gap: 16 }}>
                        <span style={{ fontSize: 11, color: 'var(--foreground-secondary)' }}>
                            今日 <strong style={{ color: 'var(--foreground)' }}>{todayCalls.toLocaleString()}</strong>
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--foreground-secondary)' }}>
                            7日均值 <strong style={{ color: 'var(--foreground)' }}>{avgCalls.toLocaleString()}</strong>
                        </span>
                    </div>
                </div>

                <div style={{
                    flex: 1, minWidth: 260,
                    background: 'var(--card-bg)', border: '1px solid var(--card-border)',
                    borderRadius: 12, padding: '16px 18px',
                }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>成功率</span>
                        <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>% / 天</span>
                    </div>
                    <LineChart data={trend} />
                    <div style={{ marginTop: 10, display: 'flex', gap: 16 }}>
                        <span style={{ fontSize: 11, color: 'var(--foreground-secondary)' }}>
                            今日 <strong style={{ color: 'var(--tag-green-fg)' }}>
                                {todaySuccess > 0 ? `${todaySuccess}%` : '—'}
                            </strong>
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--foreground-secondary)' }}>
                            7日最低 <strong style={{ color: 'var(--tag-amber-fg)' }}>
                                {minSuccess > 0 ? `${minSuccess}%` : '—'}
                            </strong>
                        </span>
                    </div>
                </div>
            </div>
        </Section>
    );
}

// ─── Block 4：Agent 状态一览 ──────────────────────────────────────────────────

const STATUS_META = {
    running: { label: '运行中', color: 'var(--tag-green-fg)' },
    idle:    { label: '空闲',   color: 'var(--foreground-muted)' },
    error:   { label: '异常',   color: 'var(--error)' },
} as const;

function BlockAgents({ agents, router }: { agents: AgentRow[]; router: ReturnType<typeof useRouter> }) {
    const [filter, setFilter] = useState<'all' | 'running' | 'error' | 'idle'>('all');
    const list = filter === 'all' ? agents : agents.filter(a => a.status === filter);

    return (
        <Section label="Agent 状态一览">
            <div style={{
                background: 'var(--card-bg)', border: '1px solid var(--card-border)',
                borderRadius: 12, overflow: 'hidden',
            }}>
                <div style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '10px 14px', borderBottom: '1px solid var(--border)',
                    background: 'var(--background)',
                }}>
                    {(['all', 'running', 'error', 'idle'] as const).map(f => (
                        <button
                            key={f}
                            onClick={() => setFilter(f)}
                            style={{
                                fontSize: 11, padding: '3px 10px', borderRadius: 20,
                                border: '1px solid var(--border)',
                                background: filter === f ? 'var(--primary)' : 'transparent',
                                color: filter === f ? '#fff' : 'var(--foreground-secondary)',
                                cursor: 'pointer', fontWeight: filter === f ? 600 : 400,
                                transition: 'all 0.12s',
                            }}
                        >
                            {{ all: '全部', running: '运行中', error: '异常', idle: '空闲' }[f]}
                            {f !== 'all' && (
                                <span style={{ marginLeft: 4, opacity: 0.75 }}>
                                    {agents.filter(a => a.status === f).length}
                                </span>
                            )}
                        </button>
                    ))}
                    <div style={{ flex: 1 }} />
                    <button
                        onClick={() => router.push('/agents')}
                        style={{
                            fontSize: 11, color: 'var(--primary)', background: 'none',
                            border: 'none', cursor: 'pointer', padding: 0,
                        }}
                    >
                        查看全部 →
                    </button>
                </div>

                <div style={{
                    display: 'grid',
                    gridTemplateColumns: '2fr 100px 90px 90px 90px 80px',
                    padding: '8px 14px',
                    borderBottom: '1px solid var(--border)',
                }}>
                    {['Agent', '平台', '状态', '今日调用', '成功率', 'P95'].map(h => (
                        <span key={h} style={{ fontSize: 11, color: 'var(--foreground-muted)', fontWeight: 500 }}>{h}</span>
                    ))}
                </div>

                {list.length === 0 ? (
                    <div style={{ padding: '20px 16px', textAlign: 'center', color: 'var(--foreground-muted)', fontSize: 13 }}>
                        {agents.length === 0 ? '尚未注册任何 Agent，前往「Agent 管理」创建' : '该状态下无 Agent'}
                    </div>
                ) : list.map((a, i) => {
                    const sm = STATUS_META[a.status];
                    return (
                        <div
                            key={i}
                            onClick={() => router.push('/trace')}
                            style={{
                                display: 'grid',
                                gridTemplateColumns: '2fr 100px 90px 90px 90px 80px',
                                padding: '10px 14px',
                                borderBottom: i < list.length - 1 ? '1px solid var(--border)' : 'none',
                                cursor: 'pointer', alignItems: 'center',
                                transition: 'background 0.1s',
                            }}
                            onMouseEnter={e => (e.currentTarget.style.background = 'var(--background)')}
                            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        >
                            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }} title={a.name}>{a.name}</span>
                            <span style={{
                                display: 'inline-block', fontSize: 10, padding: '2px 7px',
                                borderRadius: 8, background: 'var(--background-secondary)',
                                color: 'var(--foreground-secondary)', width: 'fit-content',
                            }}>{a.platform}</span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                <span style={{ width: 6, height: 6, borderRadius: '50%', background: sm.color, flexShrink: 0 }} />
                                <span style={{ fontSize: 12, color: sm.color }}>{sm.label}</span>
                            </div>
                            <span style={{ fontSize: 13, color: 'var(--foreground)' }}>{a.calls.toLocaleString()}</span>
                            <span style={{
                                fontSize: 13, fontWeight: 600,
                                color: a.calls === 0
                                    ? 'var(--foreground-muted)'
                                    : a.successRate >= 98 ? 'var(--tag-green-fg)'
                                    : a.successRate >= 95 ? 'var(--tag-amber-fg)'
                                    : 'var(--error)',
                            }}>
                                {a.calls === 0 ? '—' : `${a.successRate}%`}
                            </span>
                            <span style={{ fontSize: 12, color: 'var(--foreground-secondary)' }}>
                                {a.p95ms > 0 ? `${a.p95ms}ms` : '—'}
                            </span>
                        </div>
                    );
                })}
            </div>
        </Section>
    );
}

// ─── Block 5：快捷入口 + 近期活动 ────────────────────────────────────────────

const QUICK_ACTIONS = [
    { icon: '🤖', label: '新建 Agent',   sub: '注册并配置 Agent',  href: '/agents'       },
    { icon: '🧪', label: 'Skills 生成',  sub: '快速调试 Skill',     href: '/skill-generator'   },
    { icon: '✅', label: '运行评测',     sub: '批量验证效果',        href: '/eval'         },
    { icon: '🔍', label: '链路分析',     sub: '排查线上问题',        href: '/trace'        },
];

function BlockQuickAccess({ recent, router }: { recent: RecentItem[]; router: ReturnType<typeof useRouter> }) {
    return (
        <Section label="快捷入口 · 近期活动">
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 260, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    {QUICK_ACTIONS.map(a => (
                        <button
                            key={a.href}
                            onClick={() => router.push(a.href)}
                            style={{
                                display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
                                gap: 4, padding: '14px 16px', borderRadius: 10,
                                background: 'var(--card-bg)', border: '1px solid var(--card-border)',
                                cursor: 'pointer', textAlign: 'left',
                                transition: 'border-color 0.15s, background 0.15s',
                            }}
                            onMouseEnter={e => {
                                e.currentTarget.style.borderColor = 'var(--primary)';
                                e.currentTarget.style.background = 'var(--primary-subtle)';
                            }}
                            onMouseLeave={e => {
                                e.currentTarget.style.borderColor = 'var(--card-border)';
                                e.currentTarget.style.background = 'var(--card-bg)';
                            }}
                        >
                            <span style={{ fontSize: 22, lineHeight: 1 }}>{a.icon}</span>
                            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)', marginTop: 4 }}>{a.label}</span>
                            <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>{a.sub}</span>
                        </button>
                    ))}
                </div>

                <div style={{
                    flex: 1, minWidth: 260,
                    background: 'var(--card-bg)', border: '1px solid var(--card-border)',
                    borderRadius: 12, overflow: 'hidden',
                }}>
                    <div style={{
                        padding: '10px 14px', borderBottom: '1px solid var(--border)',
                        fontSize: 12, fontWeight: 600, color: 'var(--foreground)',
                        background: 'var(--background)',
                    }}>
                        近期活动
                    </div>
                    {recent.length === 0 ? (
                        <div style={{ padding: '20px 16px', textAlign: 'center', color: 'var(--foreground-muted)', fontSize: 13 }}>
                            暂无活动记录
                        </div>
                    ) : recent.map((item, i) => (
                        <div
                            key={i}
                            onClick={() => router.push(item.href)}
                            style={{
                                display: 'flex', alignItems: 'center', gap: 10,
                                padding: '9px 14px',
                                borderBottom: i < recent.length - 1 ? '1px solid var(--border)' : 'none',
                                cursor: 'pointer', transition: 'background 0.1s',
                            }}
                            onMouseEnter={e => (e.currentTarget.style.background = 'var(--background)')}
                            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        >
                            <span style={{ fontSize: 16, flexShrink: 0 }}>{item.icon}</span>
                            <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--foreground)', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {item.text}
                            </span>
                            <span style={{ fontSize: 10, color: 'var(--foreground-muted)', flexShrink: 0 }}>
                                {item.time}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </Section>
    );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
    const router = useRouter();
    const [stats, setStats] = useState<DashboardStats>(EMPTY_STATS);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [lastUpdated, setLastUpdated] = useState<string>('');

    // Filter state — default: all platforms, user-owned agents only
    const [filterPlatform, setFilterPlatform] = useState<string>('all');
    const [filterOwnership, setFilterOwnership] = useState<string>('user');

    // Auto-refresh state
    const [autoRefresh, setAutoRefresh] = useState(true);
    const [refreshInterval, setRefreshInterval] = useState(3000);
    const [showIntervalPicker, setShowIntervalPicker] = useState(false);
    const pickerRef = useRef<HTMLDivElement>(null);

    const fetchStats = useCallback(async (isBackground = false) => {
        if (!isBackground) setLoading(true);
        try {
            const params = new URLSearchParams();
            if (filterPlatform !== 'all') params.set('platform', filterPlatform);
            if (filterOwnership !== 'all') params.set('agentOwnership', filterOwnership);

            const res = await fetch(`/api/dashboard/stats?${params}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data: DashboardStats = await res.json();
            setStats(data);
            setError(false);
            setLastUpdated(new Date().toLocaleTimeString('zh-CN', {
                hour: '2-digit', minute: '2-digit', second: '2-digit',
            }));
        } catch (e) {
            console.error('[Dashboard] Failed to fetch stats:', e);
            setError(true);
        } finally {
            setLoading(false);
        }
    }, [filterPlatform, filterOwnership]);

    // Initial fetch + auto-refresh
    useEffect(() => {
        fetchStats(false);
        if (!autoRefresh) return;
        const timer = setInterval(() => fetchStats(true), refreshInterval);
        return () => clearInterval(timer);
    }, [fetchStats, autoRefresh, refreshInterval]);

    // Close interval picker on outside click
    useEffect(() => {
        function onClickOutside(e: MouseEvent) {
            if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
                setShowIntervalPicker(false);
            }
        }
        document.addEventListener('mousedown', onClickOutside);
        return () => document.removeEventListener('mousedown', onClickOutside);
    }, []);

    const today = new Date().toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
    const currentIntervalLabel = REFRESH_OPTIONS.find(o => o.value === refreshInterval)?.label ?? '3s';

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
            <AppTopBar
                title="概览"
                showDefaultActions={false}
                actions={
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {/* Status badge */}
                        {loading ? (
                            <span style={{
                                fontSize: 11, padding: '2px 9px', borderRadius: 20,
                                background: 'var(--tag-amber-bg)', color: 'var(--tag-amber-fg)', fontWeight: 500,
                            }}>
                                加载中…
                            </span>
                        ) : error ? (
                            <span style={{
                                fontSize: 11, padding: '2px 9px', borderRadius: 20,
                                background: 'var(--tag-red-bg)', color: 'var(--tag-red-fg)', fontWeight: 500,
                            }}>
                                数据加载失败
                            </span>
                        ) : (
                            <span style={{
                                fontSize: 11, padding: '2px 9px', borderRadius: 20,
                                background: 'var(--tag-green-bg, var(--primary-subtle))',
                                color: 'var(--tag-green-fg, var(--primary))', fontWeight: 500,
                            }}>
                                实时数据
                            </span>
                        )}

                        <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>
                            {today}{lastUpdated ? ` · ${lastUpdated}` : ' · 过去 24h'}
                        </span>

                        {/* Divider */}
                        <span style={{ width: 1, height: 14, background: 'var(--border)' }} />

                        {/* Manual refresh button */}
                        <button
                            onClick={() => fetchStats(false)}
                            title="立即刷新"
                            style={{
                                fontSize: 14, lineHeight: 1,
                                background: 'none', border: 'none',
                                color: 'var(--foreground-secondary)',
                                cursor: 'pointer', padding: '2px 4px',
                                borderRadius: 4,
                                transition: 'color 0.12s',
                            }}
                            onMouseEnter={e => (e.currentTarget.style.color = 'var(--primary)')}
                            onMouseLeave={e => (e.currentTarget.style.color = 'var(--foreground-secondary)')}
                        >
                            ↻
                        </button>

                        {/* Interval picker */}
                        <div ref={pickerRef} style={{ position: 'relative' }}>
                            <button
                                onClick={() => setShowIntervalPicker(v => !v)}
                                disabled={!autoRefresh}
                                title="刷新周期"
                                style={{
                                    fontSize: 11, padding: '3px 8px', borderRadius: 6,
                                    border: '1px solid var(--border)',
                                    background: 'var(--background)',
                                    color: autoRefresh ? 'var(--foreground)' : 'var(--foreground-muted)',
                                    cursor: autoRefresh ? 'pointer' : 'default',
                                    display: 'flex', alignItems: 'center', gap: 3,
                                    transition: 'border-color 0.12s',
                                }}
                                onMouseEnter={e => { if (autoRefresh) e.currentTarget.style.borderColor = 'var(--primary)'; }}
                                onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border)')}
                            >
                                {currentIntervalLabel}
                                <span style={{ fontSize: 8, opacity: 0.6 }}>▾</span>
                            </button>
                            {showIntervalPicker && (
                                <div style={{
                                    position: 'absolute', top: 'calc(100% + 4px)', right: 0,
                                    background: 'var(--card-bg)', border: '1px solid var(--card-border)',
                                    borderRadius: 8, overflow: 'hidden', zIndex: 100,
                                    boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
                                    minWidth: 80,
                                }}>
                                    {REFRESH_OPTIONS.map(opt => (
                                        <button
                                            key={opt.value}
                                            onClick={() => { setRefreshInterval(opt.value); setShowIntervalPicker(false); }}
                                            style={{
                                                display: 'block', width: '100%', textAlign: 'left',
                                                fontSize: 12, padding: '7px 12px',
                                                background: opt.value === refreshInterval ? 'var(--primary-subtle)' : 'transparent',
                                                color: opt.value === refreshInterval ? 'var(--primary)' : 'var(--foreground)',
                                                fontWeight: opt.value === refreshInterval ? 600 : 400,
                                                border: 'none', cursor: 'pointer',
                                                transition: 'background 0.1s',
                                            }}
                                            onMouseEnter={e => { if (opt.value !== refreshInterval) e.currentTarget.style.background = 'var(--background)'; }}
                                            onMouseLeave={e => { if (opt.value !== refreshInterval) e.currentTarget.style.background = 'transparent'; }}
                                        >
                                            {opt.label}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Pause / Resume toggle */}
                        <button
                            onClick={() => setAutoRefresh(v => !v)}
                            title={autoRefresh ? '暂停自动刷新' : '恢复自动刷新'}
                            style={{
                                fontSize: 11, padding: '3px 9px', borderRadius: 6,
                                border: '1px solid var(--border)',
                                background: autoRefresh ? 'transparent' : 'var(--tag-amber-bg, #fef3c7)',
                                color: autoRefresh ? 'var(--foreground-secondary)' : 'var(--tag-amber-fg, #92400e)',
                                cursor: 'pointer', fontWeight: 400,
                                transition: 'all 0.12s',
                                display: 'flex', alignItems: 'center', gap: 3,
                            }}
                            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--foreground-muted)'; }}
                            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                        >
                            {autoRefresh ? '⏸ 暂停' : '▶ 恢复'}
                        </button>
                    </div>
                }
            />

            {/* Filter bar */}
            <FilterBar
                platforms={stats.availablePlatforms}
                filterPlatform={filterPlatform}
                setFilterPlatform={setFilterPlatform}
                filterOwnership={filterOwnership}
                setFilterOwnership={setFilterOwnership}
            />

            <div style={{
                flex: 1, overflowY: 'auto',
                padding: '24px 28px',
                display: 'flex', flexDirection: 'column', gap: 32,
                opacity: loading ? 0.6 : 1,
                transition: 'opacity 0.3s',
            }}>
                <BlockHealth stats={stats} />
                <BlockAlerts alerts={stats.alerts} router={router} />
                <BlockTrend trend={stats.trend} />
                <BlockAgents agents={stats.agents} router={router} />
                <BlockQuickAccess recent={stats.recent} router={router} />
                <div style={{ height: 8 }} />
            </div>
        </div>
    );
}
