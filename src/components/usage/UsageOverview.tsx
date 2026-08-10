'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { UsageTrendChart } from './UsageTrendChart';
import { UsageFeatureDrawer } from './UsageFeatureDrawer';
import type { UsageRange, UsageSummaryResponse } from '@/lib/usage-analytics/types';

const basePath = process.env.NEXT_PUBLIC_URL_PREFIX || '';

const RANGES: Array<{ value: UsageRange; label: string }> = [
    { value: '7', label: '7 天' },
    { value: '30', label: '30 天' },
    { value: '90', label: '90 天' },
    { value: 'all', label: '全部' },
];

type SortKey = 'uses-desc' | 'uses-asc' | 'users-desc' | 'label-asc';

const SORTS: Array<{ value: SortKey; label: string }> = [
    { value: 'uses-desc', label: '有效使用次数（高→低）' },
    { value: 'uses-asc', label: '有效使用次数（低→高）' },
    { value: 'users-desc', label: '使用用户数（高→低）' },
    { value: 'label-asc', label: '功能名称（A→Z）' },
];

export function UsageOverview() {
    const [range, setRange] = useState<UsageRange>('7');
    const [sort, setSort] = useState<SortKey>('uses-desc');
    const [data, setData] = useState<UsageSummaryResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState<{ featureKey: string; label: string } | null>(null);
    const [reloadToken, setReloadToken] = useState(0);

    // 切换 range 时取消旧请求，防止旧响应覆盖新状态（Phase3 T4-2）。
    useEffect(() => {
        const ctrl = new AbortController();
        setLoading(true);
        setError(null);

        const apiKey = typeof window !== 'undefined' ? localStorage.getItem('api_key') || '' : '';
        fetch(`${basePath}/api/admin/usage/summary?range=${range}`, {
            headers: { 'x-witty-api-key': apiKey },
            signal: ctrl.signal,
        })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
            .then((d) => {
                setData(d);
                setLoading(false);
            })
            .catch((e) => {
                if (e.name === 'AbortError') return;
                setError('加载失败，请重试');
                setLoading(false);
            });

        return () => ctrl.abort();
    }, [range, reloadToken]);

    // 排序只重排当前数据，不触发重新聚合，也不改变总计。
    const sortedFeatures = useMemo(() => {
        if (!data) return [];
        const rows = [...data.features];
        switch (sort) {
            case 'uses-asc':
                return rows.sort((a, b) => a.uses - b.uses);
            case 'users-desc':
                return rows.sort((a, b) => b.users - a.users);
            case 'label-asc':
                return rows.sort((a, b) => a.label.localeCompare(b.label, 'zh'));
            default:
                return rows.sort((a, b) => b.uses - a.uses);
        }
    }, [data, sort]);

    const retry = useCallback(() => setReloadToken((t) => t + 1), []);

    return (
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1200 }}>
            <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
                <div>
                    <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>平台用量</h1>
                    <p style={{ fontSize: 'var(--text-sm)', color: 'var(--foreground-muted)', margin: '4px 0 0' }}>
                        查看所有用户对平台功能的有效使用情况 · Asia/Shanghai
                    </p>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                    {RANGES.map((r) => (
                        <button
                            key={r.value}
                            onClick={() => setRange(r.value)}
                            data-active={range === r.value}
                            className="ai-filter-chip"
                        >
                            {r.label}
                        </button>
                    ))}
                </div>
            </header>

            {data && !loading && (
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--foreground-muted)' }}>
                    统计周期：{data.from ?? '—'} 至 {data.to}
                </div>
            )}

            {error && (
                <div
                    style={{
                        border: '1px solid var(--error-subtle-border)',
                        background: 'var(--error-subtle)',
                        color: 'var(--error-foreground)',
                        borderRadius: 'var(--radius-md)',
                        padding: '12px 14px',
                        fontSize: 'var(--text-sm)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 12,
                    }}
                >
                    <span>{error}</span>
                    <button onClick={retry} className="ai-chip" style={{ cursor: 'pointer' }}>
                        重试
                    </button>
                </div>
            )}

            {loading && <div style={{ color: 'var(--foreground-muted)', fontSize: 'var(--text-sm)' }}>加载中…</div>}

            {data && !loading && !error && (
                <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
                        <KpiCard label="使用用户" value={data.kpis.users} />
                        <KpiCard label="有效使用次数" value={data.kpis.uses} />
                    </div>

                    <Card>
                        <CardHeader title="每日有效使用趋势" subtitle="有效使用次数" />
                        <UsageTrendChart points={data.trend} />
                    </Card>

                    <Card>
                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 12,
                                flexWrap: 'wrap',
                                marginBottom: 12,
                            }}
                        >
                            <div>
                                <div style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}>功能使用排行</div>
                                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--foreground-muted)', marginTop: 2 }}>
                                    共 {data.features.length} 个可统计功能 · 点击整行查看趋势与明细
                                </div>
                            </div>
                            <select
                                value={sort}
                                onChange={(e) => setSort(e.target.value as SortKey)}
                                aria-label="排序方式"
                                style={{
                                    border: '1px solid var(--input-border)',
                                    background: 'var(--input-bg)',
                                    color: 'var(--foreground)',
                                    borderRadius: 'var(--radius-sm)',
                                    padding: '6px 8px',
                                    fontSize: 'var(--text-sm)',
                                }}
                            >
                                {SORTS.map((s) => (
                                    <option key={s.value} value={s.value}>
                                        {s.label}
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
                                <thead>
                                    <tr style={{ color: 'var(--foreground-muted)', textAlign: 'left' }}>
                                        <Th style={{ width: 60 }}>排名</Th>
                                        <Th>菜单功能</Th>
                                        <Th align="right">有效使用次数</Th>
                                        <Th align="right">使用用户</Th>
                                        <Th style={{ width: 90 }} />
                                    </tr>
                                </thead>
                                <tbody>
                                    {sortedFeatures.map((f, i) => (
                                        <tr
                                            key={f.featureKey}
                                            onClick={() => setSelected({ featureKey: f.featureKey, label: f.label })}
                                            style={{ cursor: 'pointer', borderTop: '1px solid var(--border)' }}
                                        >
                                            <Td style={{ color: 'var(--foreground-muted)', fontVariantNumeric: 'tabular-nums' }}>
                                                {i + 1}
                                            </Td>
                                            <Td>{f.label}</Td>
                                            <Td align="right" style={{ fontVariantNumeric: 'tabular-nums' }}>
                                                {f.uses.toLocaleString()}
                                            </Td>
                                            <Td align="right" style={{ fontVariantNumeric: 'tabular-nums' }}>
                                                {f.users.toLocaleString()}
                                            </Td>
                                            <Td align="right">
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        setSelected({ featureKey: f.featureKey, label: f.label });
                                                    }}
                                                    className="ai-chip"
                                                    style={{ cursor: 'pointer' }}
                                                >
                                                    查看详情
                                                </button>
                                            </Td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </Card>
                </>
            )}

            {selected && (
                <UsageFeatureDrawer
                    featureKey={selected.featureKey}
                    label={selected.label}
                    range={range}
                    onClose={() => setSelected(null)}
                />
            )}
        </div>
    );
}

function KpiCard({ label, value }: { label: string; value: number }) {
    return (
        <div
            style={{
                border: '1px solid var(--card-border)',
                borderRadius: 'var(--radius-lg)',
                background: 'var(--card-bg)',
                padding: '16px 18px',
            }}
        >
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--foreground-muted)' }}>{label}</div>
            <div style={{ fontSize: 30, fontWeight: 600, fontVariantNumeric: 'tabular-nums', marginTop: 6 }}>
                {value.toLocaleString()}
            </div>
        </div>
    );
}

function Card({ children }: { children: React.ReactNode }) {
    return (
        <section
            style={{
                border: '1px solid var(--card-border)',
                borderRadius: 'var(--radius-lg)',
                background: 'var(--card-bg)',
                padding: 18,
            }}
        >
            {children}
        </section>
    );
}

function CardHeader({ title, subtitle }: { title: string; subtitle?: string }) {
    return (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
            <div style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}>{title}</div>
            {subtitle && (
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 'var(--text-sm)',
                        color: 'var(--foreground-muted)',
                    }}
                >
                    <span
                        style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: 'var(--primary)',
                            flexShrink: 0,
                        }}
                    />
                    {subtitle}
                </div>
            )}
        </div>
    );
}

function Th({
    children,
    align = 'left',
    style,
}: {
    children?: React.ReactNode;
    align?: 'left' | 'right';
    style?: React.CSSProperties;
}) {
    return <th style={{ padding: '8px 10px', textAlign: align, fontWeight: 500, ...style }}>{children}</th>;
}

function Td({
    children,
    align = 'left',
    style,
}: {
    children?: React.ReactNode;
    align?: 'left' | 'right';
    style?: React.CSSProperties;
}) {
    return <td style={{ padding: '10px', textAlign: align, ...style }}>{children}</td>;
}
