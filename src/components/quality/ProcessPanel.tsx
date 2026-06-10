'use client';

import React from 'react';
import { GitBranch } from 'lucide-react';
import { useLocale } from '@/lib/client/locale-context';
import type { QualityReport, MetricScore } from '@/lib/engine/quality-monitoring/types';
import { scoreColor, fmtNum } from './quality-ui';

export function ProcessPanel({ report, collapsed, onToggleCollapse }: {
    report: QualityReport;
    collapsed?: boolean;
    onToggleCollapse?: () => void;
}) {
    const { t } = useLocale();
    const metrics = report.dimensions.process.metrics ?? [];

    return (
        <section id="process" style={panel}>
            <div style={{ ...panelH, cursor: onToggleCollapse ? 'pointer' : undefined }} onClick={onToggleCollapse}>
                <span style={{ ...ix, background: 'color-mix(in srgb, #2c6bd1 13%, transparent)', color: '#2c6bd1' }}><GitBranch size={13} /></span>
                <span style={{ fontSize: 13.5, fontWeight: 800 }}>{t('quality.process.title')}</span>
                <span style={{ fontSize: 10.5, color: 'var(--foreground-muted)' }}>· {t('quality.process.hint')}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 10.5, color: 'var(--foreground-muted)' }}>
                    {t('quality.process.coverage')} {Math.round(report.dimensions.process.coverage * 100)}%
                </span>
                {onToggleCollapse && (
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--primary)' }}>
                        {collapsed ? t('quality.fold.expand') + ' ▾' : t('quality.fold.collapse') + ' ▴'}
                    </span>
                )}
            </div>
            {!collapsed && (
                <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 15 }}>
                    {metrics.map((m) => <ProcessBar key={m.key} m={m} t={t} />)}
                </div>
            )}
        </section>
    );
}

function ProcessBar({ m, t }: { m: MetricScore; t: (k: string) => string }) {
    const na = m.score == null;
    const color = na ? 'var(--foreground-muted)' : scoreColor(m.score as number);
    return (
        <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 7 }}>
                <span style={{ fontSize: 12.5, fontWeight: 700 }}>{m.label}</span>
                <span style={{ fontSize: 9, fontWeight: 600, padding: '2px 5px', borderRadius: 4, background: 'color-mix(in srgb, ' + colorOfPriority(m.priority) + ' 13%, transparent)', color: colorOfPriority(m.priority) }}>{m.priority}</span>
                {m.note && <span style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--foreground-muted)' }}>{m.note}</span>}
                <span style={{ marginLeft: 'auto', fontSize: 14, fontWeight: 700, color }}>{na ? t('quality.process.na') : fmtNum(m.score)}</span>
            </div>
            <div style={{ height: 7, borderRadius: 5, background: 'var(--background-secondary)', overflow: 'hidden' }}>
                <span style={{ display: 'block', height: '100%', width: `${na ? 0 : (m.score as number)}%`, background: color, borderRadius: 5 }} />
            </div>
        </div>
    );
}

function colorOfPriority(p: string): string {
    return p === 'P0' ? 'var(--error)' : p === 'P1' ? 'var(--warning)' : 'var(--foreground-muted)';
}

const panel: React.CSSProperties = { background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12, boxShadow: '0 1px 2px rgba(20,22,30,.04)', marginBottom: 14, scrollMarginTop: 56 };
const panelH: React.CSSProperties = { padding: '13px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 };
const ix: React.CSSProperties = { width: 22, height: 22, borderRadius: 6, display: 'grid', placeItems: 'center', flex: '0 0 22px' };
