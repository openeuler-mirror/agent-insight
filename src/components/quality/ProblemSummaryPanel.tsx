'use client';

import React from 'react';
import { AlertTriangle, ArrowUpRight } from 'lucide-react';
import { useLocale } from '@/lib/client/locale-context';
import type { QualityReport, ProblemItem } from '@/lib/engine/quality-monitoring/types';
import { severityColor, ATTR_COLOR } from './quality-ui';

const NODE_COLORS = ['var(--warning)', '#2c6bd1', 'var(--primary)', 'var(--foreground-muted)', 'var(--success)'];

export function ProblemSummaryPanel({ report, onDrillTrace }: {
    report: QualityReport;
    onDrillTrace: (executionId: string) => void;
}) {
    const { t } = useLocale();
    const problems = report.problems;
    const maxImpact = Math.max(1, ...problems.map((p) => p.impact));
    const sevLabel: Record<string, string> = { high: t('quality.problems.high'), medium: t('quality.problems.medium'), low: t('quality.problems.low') };
    const nErr = problems.filter((p) => p.source === '错误').length;
    const nEval = problems.length - nErr;

    return (
        <section id="problems" style={panel}>
            <div style={panelH}>
                <span style={{ ...ix, background: 'var(--error-subtle)', color: 'var(--error)' }}><AlertTriangle size={13} /></span>
                <span style={{ fontSize: 13.5, fontWeight: 800 }}>{t('quality.problems.title')}</span>
                {problems.length > 0 && (
                    <span style={{ display: 'inline-flex', gap: 5 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 5, background: 'var(--error-subtle)', color: 'var(--error)' }}>
                            {t('quality.problems.sourceErr')} {nErr}
                        </span>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 5, background: 'var(--primary-subtle)', color: 'var(--primary)' }}>
                            {t('quality.problems.sourceEval')} {nEval}
                        </span>
                    </span>
                )}
                <span style={{ fontSize: 10.5, color: 'var(--foreground-muted)' }}>· {t('quality.problems.hint')}</span>
            </div>

            {problems.length === 0 ? (
                <div style={{ padding: 32, textAlign: 'center', color: 'var(--foreground-muted)', fontSize: 12 }}>{t('quality.problems.empty')}</div>
            ) : (
                <div style={{ padding: '16px 18px', display: 'grid', gridTemplateColumns: '1.55fr 1fr', gap: 18 }}>
                    {/* 问题列表（影响度降序 + 帕累托） */}
                    <div>
                        {problems.slice(0, 8).map((p, i) => (
                            <ProblemRow key={p.key} rank={i + 1} p={p} maxImpact={maxImpact} sevLabel={sevLabel} t={t} onDrill={onDrillTrace} />
                        ))}
                    </div>

                    {/* 错误节点分布 */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--foreground-secondary)' }}>{t('quality.problems.nodeDist')}</div>
                        {report.errorNodeDistribution.length > 0 ? (
                            <>
                                <div style={{ display: 'flex', height: 34, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
                                    {report.errorNodeDistribution.map((nd, i) => (
                                        <div key={nd.node} style={{ width: `${nd.pct}%`, background: NODE_COLORS[i % NODE_COLORS.length], display: 'grid', placeItems: 'center', color: '#fff', fontSize: 10, fontWeight: 700 }}>
                                            {nd.pct >= 10 ? `${nd.pct}%` : ''}
                                        </div>
                                    ))}
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                    {report.errorNodeDistribution.map((nd, i) => (
                                        <div key={nd.node} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--foreground-secondary)' }}>
                                            <span style={{ width: 9, height: 9, borderRadius: 3, background: NODE_COLORS[i % NODE_COLORS.length] }} />
                                            {nd.node}
                                            <b style={{ marginLeft: 'auto', color: 'var(--foreground)' }}>{nd.count} 次 · {nd.pct}%</b>
                                        </div>
                                    ))}
                                </div>
                            </>
                        ) : (
                            <div style={{ fontSize: 11.5, color: 'var(--foreground-muted)', padding: '8px 0' }}>—</div>
                        )}
                        <div style={{ fontSize: 11, color: 'var(--foreground-muted)', background: 'var(--background-secondary)', border: '1px dashed var(--border)', borderRadius: 8, padding: '9px 12px', lineHeight: 1.5 }}>
                            {t('quality.problems.pareto')}
                        </div>
                    </div>
                </div>
            )}
        </section>
    );
}

function ProblemRow({ rank, p, maxImpact, sevLabel, t, onDrill }: {
    rank: number; p: ProblemItem; maxImpact: number; sevLabel: Record<string, string>;
    t: (k: string) => string; onDrill: (id: string) => void;
}) {
    const attr = ATTR_COLOR[p.attribution];
    const canDrill = p.relatedTraces.length > 0;
    return (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11, padding: '11px 0', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--foreground-muted)', width: 16, fontVariantNumeric: 'tabular-nums' }}>{rank}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.desc}</span>
                    <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: p.source === '错误' ? 'var(--error-subtle)' : 'var(--primary-subtle)', color: p.source === '错误' ? 'var(--error)' : 'var(--primary)' }}>
                        {p.source === '错误' ? t('quality.problems.sourceErr') : t('quality.problems.sourceEval')}
                    </span>
                    {p.node && <span style={{ fontSize: 9, fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: 'var(--background-secondary)', color: 'var(--foreground-secondary)' }}>{p.node}</span>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                    <span style={{ flex: 1, maxWidth: 160, height: 6, borderRadius: 5, background: 'var(--background-secondary)', overflow: 'hidden' }}>
                        <span style={{ display: 'block', height: '100%', width: `${(p.impact / maxImpact) * 100}%`, background: severityColor(p.severity), borderRadius: 5 }} />
                    </span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--foreground-secondary)' }}>{p.frequency} 次</span>
                    {p.cumulativePct != null && <span style={{ fontSize: 10, color: 'var(--foreground-muted)' }}>{t('quality.problems.cumulative')} {p.cumulativePct}%</span>}
                    <span style={{ fontSize: 9.5, fontWeight: 600, padding: '3px 7px', borderRadius: 5, background: attr.bg, color: attr.fg }}>{p.attribution}</span>
                    <span style={{ fontSize: 9.5, fontWeight: 700, color: severityColor(p.severity) }}>{sevLabel[p.severity]}</span>
                    <span style={{ fontSize: 10, color: 'var(--foreground-muted)' }}>· {p.affectedDimensions.join('/')}</span>
                    {canDrill && (
                        <button onClick={() => onDrill(p.relatedTraces[0])}
                            style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', fontSize: 10.5, fontWeight: 700, color: 'var(--primary)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                            {t('quality.problems.relatedTraces')} {p.relatedTraces.length} <ArrowUpRight size={12} />
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

const panel: React.CSSProperties = { background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12, boxShadow: '0 1px 2px rgba(20,22,30,.04)', marginBottom: 14, scrollMarginTop: 56 };
const panelH: React.CSSProperties = { padding: '13px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };
const ix: React.CSSProperties = { width: 22, height: 22, borderRadius: 6, display: 'grid', placeItems: 'center', flex: '0 0 22px' };
