'use client';

import React from 'react';
import { CheckCircle2, GitBranch, Coins, AlertTriangle, ArrowDown, Sparkles } from 'lucide-react';
import { useLocale } from '@/lib/client/locale-context';
import type { QualityReport, DimScore } from '@/lib/engine/quality-monitoring/types';
import { scoreColor, statusColor, fmtNum } from './quality-ui';

const ICONS = { result: CheckCircle2, process: GitBranch, cost: Coins, error: AlertTriangle };

export function MethodologyCards({ report, onAnchor }: { report: QualityReport; onAnchor: (id: string) => void }) {
    const { t } = useLocale();
    const { dimensions } = report;

    const cards: { key: 'result' | 'process' | 'cost' | 'error'; name: string; q: string; anchor: string; score: string; status: string; signal: string; go: string }[] = [
        {
            key: 'result', name: t('quality.dim.result'), q: t('quality.dim.resultQ'), anchor: 'exec',
            score: fmtNum(dimensions.result.score), status: dimensions.result.status,
            signal: dimensions.result.signal || '', go: t('quality.dim.viewExec'),
        },
        {
            key: 'process', name: t('quality.dim.process'), q: t('quality.dim.processQ'), anchor: 'process',
            score: fmtNum(dimensions.process.score), status: dimensions.process.status,
            signal: dimensions.process.signal || processSignal(dimensions.process), go: t('quality.dim.viewProcess'),
        },
        {
            key: 'cost', name: t('quality.dim.cost'), q: t('quality.dim.costQ'), anchor: 'cost',
            score: fmtNum(dimensions.cost.score), status: dimensions.cost.status,
            signal: dimensions.cost.signal || '', go: t('quality.dim.viewTrend'),
        },
        {
            key: 'error', name: t('quality.dim.error'), q: t('quality.dim.errorQ'), anchor: 'problems',
            score: String(report.problems.filter((p) => p.source === '错误').reduce((s, p) => s + p.frequency, 0)),
            status: dimensions.error.status,
            signal: dimensions.error.signal || '', go: t('quality.dim.viewErrors'),
        },
    ];

    return (
        <section id="analysis" style={panel}>
            <div style={panelH}>
                <span style={{ ...ix, background: 'var(--primary-subtle)', color: 'var(--primary)' }}><Sparkles size={13} /></span>
                <span style={{ fontSize: 13.5, fontWeight: 800 }}>{t('quality.analysis.title')}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 10.5, color: 'var(--foreground-muted)' }}>{t('quality.analysis.hint')}</span>
            </div>
            <div style={{ padding: '16px 18px' }}>
                {/* 方法论 */}
                <div style={{ fontSize: 11, color: 'var(--foreground-muted)', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span>{t('quality.analysis.method')}</span>
                    {[t('quality.dim.result'), t('quality.dim.process'), t('quality.dim.cost'), t('quality.dim.error')].map((m, i) => (
                        <React.Fragment key={m}>
                            <span style={{ fontWeight: 600, color: 'var(--foreground-secondary)' }}><b style={{ color: 'var(--foreground)' }}>{m}</b></span>
                            {i < 3 && <span style={{ color: 'var(--border-dark)' }}>×</span>}
                        </React.Fragment>
                    ))}
                </div>

                {/* 四卡 */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                    {cards.map((c) => {
                        const Icon = ICONS[c.key];
                        const dim = dimensions[c.key];
                        const color = c.key === 'error' ? statusColor(dim.status) : scoreColor(dim.score);
                        return (
                            <button key={c.key} onClick={() => onAnchor(c.anchor)} style={lcard}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span style={{ ...ix, width: 24, height: 24, background: 'color-mix(in srgb, ' + color + ' 13%, transparent)', color }}><Icon size={14} /></span>
                                    <span style={{ fontSize: 12.5, fontWeight: 800 }}>{c.name}</span>
                                    <span style={{ fontSize: 9.5, color: 'var(--foreground-muted)', fontWeight: 600, marginLeft: 'auto' }}>{c.q}</span>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                                    <span style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', color }}>{c.score}</span>
                                    <span style={{
                                        fontSize: 10.5, fontWeight: 700, padding: '3px 7px', borderRadius: 5,
                                        background: 'color-mix(in srgb, ' + statusColor(dim.status) + ' 13%, transparent)', color: statusColor(dim.status),
                                    }}>{t(`quality.status.${dim.status}`)}</span>
                                    {dim.coverage < 1 && (
                                        <span style={{ fontSize: 9.5, color: 'var(--foreground-muted)', marginLeft: 'auto' }}>
                                            {t('quality.analysis.naCoverage')} {Math.round(dim.coverage * 100)}%
                                        </span>
                                    )}
                                </div>
                                <div style={{ fontSize: 11, color: 'var(--foreground-secondary)', lineHeight: 1.5, minHeight: 33 }}>{c.signal}</div>
                                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--primary)', display: 'flex', alignItems: 'center', gap: 5, marginTop: 'auto' }}>
                                    {c.go} <ArrowDown size={13} />
                                </div>
                            </button>
                        );
                    })}
                </div>
            </div>
        </section>
    );
}

function processSignal(d: DimScore): string {
    const weak = d.metrics?.filter((m) => m.score != null).sort((a, b) => (a.score as number) - (b.score as number))[0];
    return weak ? `${weak.label} ${fmtNum(weak.score)} 偏弱` : '过程信号覆盖有限';
}

const panel: React.CSSProperties = {
    background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12,
    boxShadow: '0 1px 2px rgba(20,22,30,.04)', marginBottom: 14, scrollMarginTop: 56,
};
const panelH: React.CSSProperties = {
    padding: '13px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8,
};
const ix: React.CSSProperties = {
    width: 22, height: 22, borderRadius: 6, display: 'grid', placeItems: 'center', flex: '0 0 22px',
};
const lcard: React.CSSProperties = {
    border: '1px solid var(--border)', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 9,
    background: 'var(--card-bg)', cursor: 'pointer', textAlign: 'left', font: 'inherit', color: 'inherit',
};
