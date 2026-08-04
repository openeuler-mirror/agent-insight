'use client';

import React, { useMemo, useState } from 'react';
import {
    ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';
import { TrendingUp } from 'lucide-react';
import { useLocale } from '@/lib/client/locale-context';
import { useThemeColors } from '@/lib/client/theme-context';
import type { QualityReport, TrendBucket, TrendGranularity } from '@/lib/engine/quality-monitoring/types';

type DimKey = 'comp' | 'proc' | 'cost';

function bucketLabel(ts: string, g: TrendGranularity): string {
    const d = new Date(ts);
    if (g === 'hour') return `${String(d.getHours()).padStart(2, '0')}:00`;
    return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function QualityTrendChart({ report, onBucketClick, collapsed, onToggleCollapse }: {
    report: QualityReport;
    onBucketClick: (bucket: TrendBucket) => void;
    collapsed?: boolean;
    onToggleCollapse?: () => void;
}) {
    const { t } = useLocale();
    const c = useThemeColors();
    const [active, setActive] = useState<Record<DimKey, boolean>>({ comp: true, proc: false, cost: true });

    const COLORS: Record<DimKey, string> = { comp: c.primary, proc: '#2c6bd1', cost: c.warning };
    const NAMES: Record<DimKey, string> = { comp: t('quality.trend.comp'), proc: t('quality.trend.proc'), cost: t('quality.trend.cost') };
    const g = report.trend.granularity;

    const data = useMemo(() => report.trend.buckets.map((b) => ({
        label: bucketLabel(b.bucket_ts, g),
        comp: b.composite,
        proc: b.ratios.toolCorrect ?? 0,
        cost: b.ratios.cost ?? 0,
        n: b.n_traces,
        latencyP95: b.percentiles?.latency?.p95 ?? 0,
        anomaly: b.anomaly ? 1 : 0,
        _bucket: b,
    })), [report.trend.buckets, g]);

    const maxN = Math.max(1, ...data.map((d) => d.n));
    const granLabel = g === 'hour' ? t('quality.trend.hourBuckets') : g === 'day' ? t('quality.trend.dayBuckets') : t('quality.trend.weekBuckets');

    if (!data.length || data.every((d) => d.n === 0)) {
        return (
            <section id="cost" style={panel}>
                <Header t={t} />
                <div style={{ padding: 40, textAlign: 'center', color: 'var(--foreground-muted)', fontSize: 12 }}>{t('quality.trend.empty')}</div>
            </section>
        );
    }

    return (
        <section id="cost" style={panel}>
            <div style={{ ...panelH, cursor: onToggleCollapse ? 'pointer' : undefined }} onClick={onToggleCollapse}>
                <span style={{ ...ix, background: 'var(--warning-subtle)', color: 'var(--warning)' }}><TrendingUp size={13} /></span>
                <span style={{ fontSize: 13.5, fontWeight: 800 }}>{t('quality.trend.title')}</span>
                <span style={{ fontSize: 10.5, color: 'var(--foreground-muted)' }}>· {t('quality.trend.hint')}</span>
                <span style={{ flex: 1 }} />
                {!collapsed && (
                    <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                        {(['comp', 'proc', 'cost'] as DimKey[]).map((k) => (
                            <button key={k} onClick={() => setActive((s) => ({ ...s, [k]: !s[k] }))}
                                style={{
                                    fontSize: 11, fontWeight: 600, padding: '5px 10px', borderRadius: 7, cursor: 'pointer',
                                    border: `1px ${active[k] ? 'solid' : 'dashed'} var(--border)`,
                                    opacity: active[k] ? 1 : 0.55,
                                    background: 'var(--card-bg)', color: active[k] ? 'var(--foreground)' : 'var(--foreground-muted)',
                                    display: 'inline-flex', alignItems: 'center', gap: 6,
                                }}>
                                <span style={{ width: 9, height: 3, borderRadius: 2, background: COLORS[k] }} />{NAMES[k]}
                            </button>
                        ))}
                    </div>
                )}
                {onToggleCollapse && (
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--primary)' }}>
                        {collapsed ? t('quality.fold.expand') + ' ▾' : t('quality.fold.collapse') + ' ▴'}
                    </span>
                )}
            </div>
            {collapsed ? null : (
            <div style={{ padding: '14px 18px' }}>
                <div style={{ fontSize: 11, color: 'var(--foreground-muted)', marginBottom: 8 }}>
                    {t('quality.trend.window')}：<b style={{ color: 'var(--foreground-secondary)' }}>{granLabel} · {data.length} {t('quality.trend.bucketCount')}</b>
                    {' ｜ '}{t('quality.trend.percentileNote')}{' ｜ '}<span style={{ color: 'var(--primary)' }}>{t('quality.trend.clickBucket')}</span>
                </div>
                <div style={{ width: '100%', height: 260 }}>
                    <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: -16 }}
                            onClick={(state) => {
                                const p = (state as { activePayload?: { payload?: { _bucket?: TrendBucket; n?: number } }[] })
                                    ?.activePayload?.[0]?.payload;
                                if (p?._bucket && (p.n ?? 0) > 0) onBucketClick(p._bucket);
                            }}>
                            <CartesianGrid strokeDasharray="3 3" stroke={c.border} vertical={false} />
                            <XAxis dataKey="label" stroke={c.fgMuted} tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                            <YAxis yAxisId="score" domain={[0, 100]} stroke={c.fgMuted} tick={{ fontSize: 10 }} />
                            <YAxis yAxisId="count" orientation="right" domain={[0, maxN * 3]} stroke={c.fgMuted} tick={{ fontSize: 10 }} hide />
                            <Tooltip content={<TrendTip names={NAMES} colors={COLORS} activeDims={active} t={t} />} />
                            <ReferenceLine yAxisId="score" y={85} stroke="#c9b6ef" strokeDasharray="3 3" />
                            <Bar yAxisId="count" dataKey="n" fill={c.border} radius={[2, 2, 0, 0]} barSize={14} name={t('quality.trend.sample')}>
                                {data.map((d, i) => <Cell key={i} fill={d.anomaly ? 'color-mix(in srgb, var(--error) 35%, transparent)' : c.border} />)}
                            </Bar>
                            {active.cost && <Line yAxisId="score" type="monotone" dataKey="cost" stroke={COLORS.cost} strokeWidth={2} strokeDasharray="5 4" dot={false} />}
                            {active.proc && <Line yAxisId="score" type="monotone" dataKey="proc" stroke={COLORS.proc} strokeWidth={2} dot={false} />}
                            {active.comp && <Line yAxisId="score" type="monotone" dataKey="comp" stroke={COLORS.comp} strokeWidth={2.6} dot={{ r: 2 }} activeDot={{ r: 5 }} />}
                        </ComposedChart>
                    </ResponsiveContainer>
                </div>
            </div>
            )}
        </section>
    );
}

interface TrendTipProps {
    activeDims?: Record<DimKey, boolean>;
    payload?: { payload?: Record<string, number> }[];
    label?: string;
    names: Record<DimKey, string>;
    colors: Record<DimKey, string>;
    t: (k: string) => string;
}
function TrendTip({ activeDims, payload, label, names, colors, t }: TrendTipProps) {
    if (!payload?.length || !activeDims) return null;
    const p = payload[0]?.payload as Record<string, number>;
    return (
        <div style={{
            background: 'var(--card-bg)', border: '1px solid var(--border-dark)', borderRadius: 9, padding: '9px 11px',
            fontSize: 11, boxShadow: '0 6px 24px rgba(20,22,30,.12)', minWidth: 130,
        }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>{label}{p?.anomaly ? ` · ⚠ ${t('quality.trend.anomaly')}` : ''}</div>
            {(['comp', 'proc', 'cost'] as const).filter((k) => activeDims[k]).map((k) => (
                <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '3px 0', color: 'var(--foreground-secondary)' }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: colors[k] }} />{names[k]}
                    <b style={{ marginLeft: 'auto', color: 'var(--foreground)' }}>{Math.round(p[k] * 10) / 10}</b>
                </div>
            ))}
            <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border)', fontSize: 10, color: 'var(--foreground-muted)' }}>
                {t('quality.trend.sample')} {p.n} · latency p95 {Math.round(p.latencyP95)}
            </div>
        </div>
    );
}

function Header({ t }: { t: (k: string) => string }) {
    return (
        <div style={panelH}>
            <span style={{ ...ix, background: 'var(--warning-subtle)', color: 'var(--warning)' }}><TrendingUp size={13} /></span>
            <span style={{ fontSize: 13.5, fontWeight: 800 }}>{t('quality.trend.title')}</span>
        </div>
    );
}

const panel: React.CSSProperties = { background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12, boxShadow: '0 1px 2px rgba(20,22,30,.04)', marginBottom: 14, scrollMarginTop: 56 };
const panelH: React.CSSProperties = { padding: '13px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };
const ix: React.CSSProperties = { width: 22, height: 22, borderRadius: 6, display: 'grid', placeItems: 'center', flex: '0 0 22px' };
