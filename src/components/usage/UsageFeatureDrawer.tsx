'use client';

import { useEffect, useState } from 'react';

import { UsageTrendChart } from './UsageTrendChart';
import type { UsageFeatureResponse, UsageRange } from '@/lib/usage-analytics/types';

const basePath = process.env.NEXT_PUBLIC_URL_PREFIX || '';

const RANGE_LABEL: Record<UsageRange, string> = { '7': '最近 7 天', '30': '最近 30 天', '90': '最近 90 天', all: '全部' };

interface Props {
    featureKey: string;
    label: string;
    range: UsageRange;
    onClose: () => void;
}

export function UsageFeatureDrawer({ featureKey, label, range, onClose }: Props) {
    const [data, setData] = useState<UsageFeatureResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    // range 变化时已打开的抽屉同步刷新（Phase3 T4-3）。
    useEffect(() => {
        const ctrl = new AbortController();
        setLoading(true);
        setError(null);

        const apiKey = typeof window !== 'undefined' ? localStorage.getItem('api_key') || '' : '';
        fetch(`${basePath}/api/admin/usage/features/${encodeURIComponent(featureKey)}?range=${range}`, {
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
                setError('加载失败');
                setLoading(false);
            });

        return () => ctrl.abort();
    }, [featureKey, range]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    return (
        <div
            style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', justifyContent: 'flex-end' }}
            onClick={onClose}
        >
            <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.32)' }} />
            <aside
                onClick={(e) => e.stopPropagation()}
                style={{
                    position: 'relative',
                    width: 'min(560px, 100%)',
                    background: 'var(--card-bg)',
                    borderLeft: '1px solid var(--card-border)',
                    display: 'flex',
                    flexDirection: 'column',
                    overflowY: 'auto',
                }}
            >
                <header
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        padding: '16px 20px',
                        borderBottom: '1px solid var(--card-border)',
                        position: 'sticky',
                        top: 0,
                        background: 'var(--card-bg)',
                    }}
                >
                    <div>
                        <div style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}>{label} 使用详情</div>
                        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--foreground-muted)', marginTop: 2 }}>
                            有效使用和使用用户 · {RANGE_LABEL[range]}
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        aria-label="关闭"
                        style={{
                            border: '1px solid var(--border)',
                            background: 'transparent',
                            borderRadius: 'var(--radius-sm)',
                            width: 28,
                            height: 28,
                            cursor: 'pointer',
                            color: 'var(--foreground-secondary)',
                            flexShrink: 0,
                        }}
                    >
                        ×
                    </button>
                </header>

                <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 20 }}>
                    {loading && <div style={{ color: 'var(--foreground-muted)', fontSize: 'var(--text-sm)' }}>加载中…</div>}
                    {error && <div style={{ color: 'var(--error)', fontSize: 'var(--text-sm)' }}>{error}</div>}

                    {data && !loading && (
                        <>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                                <Kpi label="有效使用次数" value={data.kpis.uses} />
                                <Kpi label="使用用户" value={data.kpis.users} />
                            </div>

                            <section>
                                <div
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        marginBottom: 10,
                                    }}
                                >
                                    <SectionTitle inline>每日有效使用趋势</SectionTitle>
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
                                        有效使用次数
                                    </div>
                                </div>
                                <UsageTrendChart points={data.trend} height={170} />
                            </section>

                            <section>
                                <SectionTitle>使用行为构成</SectionTitle>
                                {data.behaviorBreakdown.length === 0 ? (
                                    <div style={{ color: 'var(--foreground-muted)', fontSize: 'var(--text-sm)' }}>暂无数据</div>
                                ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                        {data.behaviorBreakdown.map((b) => {
                                            const max = Math.max(1, ...data.behaviorBreakdown.map((x) => x.count));
                                            return (
                                                <div key={b.eventKey}>
                                                    <div
                                                        style={{
                                                            display: 'flex',
                                                            justifyContent: 'space-between',
                                                            fontSize: 'var(--text-sm)',
                                                            marginBottom: 4,
                                                        }}
                                                    >
                                                        <span>{b.label}</span>
                                                        <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--foreground-secondary)' }}>
                                                            {b.count.toLocaleString()}
                                                        </span>
                                                    </div>
                                                    <div style={{ height: 6, background: 'var(--background-secondary)', borderRadius: 3 }}>
                                                        <div
                                                            style={{
                                                                width: `${(b.count / max) * 100}%`,
                                                                height: '100%',
                                                                background: 'var(--primary)',
                                                                borderRadius: 3,
                                                            }}
                                                        />
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </section>
                        </>
                    )}
                </div>
            </aside>
        </div>
    );
}

function Kpi({ label, value }: { label: string; value: number }) {
    return (
        <div
            style={{
                border: '1px solid var(--card-border)',
                borderRadius: 'var(--radius-md)',
                padding: '12px 14px',
                background: 'var(--background-secondary)',
            }}
        >
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--foreground-muted)' }}>{label}</div>
            <div style={{ fontSize: 24, fontWeight: 600, fontVariantNumeric: 'tabular-nums', marginTop: 4 }}>
                {value.toLocaleString()}
            </div>
        </div>
    );
}

function SectionTitle({ children, inline }: { children: React.ReactNode; inline?: boolean }) {
    return (
        <div
            style={{
                fontSize: 'var(--text-sm)',
                fontWeight: 600,
                marginBottom: inline ? 0 : 10,
                color: 'var(--foreground-secondary)',
            }}
        >
            {children}
        </div>
    );
}
