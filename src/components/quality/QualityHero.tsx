'use client';

import React from 'react';
import { Sparkles, ArrowUpRight, Wrench } from 'lucide-react';
import { useLocale } from '@/lib/client/locale-context';
import { StatusBadge } from '@/components/feedback/StatusBadge';
import type { QualityReport, ProblemItem, DimScore } from '@/lib/engine/quality-monitoring/types';
import { statusToKind, scoreColor, severityColor, ATTR_COLOR, fmtNum } from './quality-ui';

/**
 * 首屏 Hero：用户 10 秒内拿走三层信息——
 * ① 能不能放心用（综合分+状态，按置信度调制呈现）
 * ② 瓶颈在哪（一句话判读）
 * ③ 先修哪个、修了值多少（Top 3 问题卡 + 预期收益估算）
 */
export function QualityHero({ report, onDrillTrace, onAnchor }: {
    report: QualityReport;
    onDrillTrace: (executionId: string) => void;
    onAnchor: (id: string) => void;
}) {
    const { t } = useLocale();
    const { composite, meta, dimensions, problems, coverage, trend } = report;

    // 窗口内自身趋势（首尾非空桶综合分差；非同类、非百分位）
    const nonEmpty = trend.buckets.filter((b) => b.n_traces > 0);
    const delta = nonEmpty.length >= 2
        ? Math.round((nonEmpty[nonEmpty.length - 1].composite - nonEmpty[0].composite) * 10) / 10
        : null;

    const judgedPct = coverage.total ? Math.round((coverage.judged / coverage.total) * 100) : 0;
    const lowJudge = judgedPct < 30;

    // 置信度调制：样本不足 → 整体置灰，不让大数字骗人（BR-007）
    const scoreCol = meta.lowSample ? 'var(--foreground-muted)' : scoreColor(composite.score);

    // 结论判读素材
    const dimEntries: [string, DimScore][] = [
        [t('quality.dim.result'), dimensions.result],
        [t('quality.dim.process'), dimensions.process],
        [t('quality.dim.cost'), dimensions.cost],
    ];
    const bottleneck = dimEntries.filter(([, d]) => d.coverage > 0).sort((a, b) => a[1].score - b[1].score)[0];
    const top = problems.slice(0, 3);

    // 全量计数来自 problemCounts（problems 数组按影响度封顶，直接 filter 会少算）
    const errorCount = report.problemCounts.errorEvents;
    const clusterCount = report.problemCounts.error;
    const evalIssueCount = report.problemCounts.eval;
    const totalProblems = report.problemCounts.total;

    return (
        <section id="verdict" style={{
            background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12,
            boxShadow: '0 1px 2px rgba(20,22,30,.04)', marginBottom: 14, scrollMarginTop: 56,
            padding: '18px 20px',
        }}>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'stretch' }}>
                {/* ① 综合分（置信度调制） */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 200, flex: '0 0 auto' }}>
                    <div style={{ fontSize: 10.5, color: 'var(--foreground-muted)', fontWeight: 600 }}>{t('quality.summary.composite')}</div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        <span style={{ fontSize: 40, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1, color: scoreCol }}>
                            {fmtNum(composite.score)}
                        </span>
                        <span style={{ fontSize: 13, color: 'var(--foreground-muted)', fontWeight: 600 }}>/100</span>
                        {delta != null && (
                            <span title={t('quality.hero.windowTrend')} style={{ fontSize: 12, fontWeight: 700, color: delta >= 0 ? 'var(--success)' : 'var(--error)' }}>
                                {delta >= 0 ? '▲' : '▼'} {fmtNum(Math.abs(delta))}
                            </span>
                        )}
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <StatusBadge status={statusToKind(composite.status)} label={t(`quality.status.${composite.status}`)} />
                        {composite.capped && <StatusBadge status="error" variant="outline" label={t('quality.summary.capped')} />}
                    </div>
                    {/* 可信度标注：低评测覆盖/样本不足时显式提醒，调制对分数的信任 */}
                    <div style={{ fontSize: 10.5, lineHeight: 1.5 }}>
                        {meta.lowSample ? (
                            <span style={{ color: 'var(--warning)', fontWeight: 700 }}>⚠ {t('quality.hero.lowSampleTag')}</span>
                        ) : (
                            <span style={{ color: lowJudge ? 'var(--warning)' : 'var(--foreground-muted)' }}>
                                {lowJudge ? `${t('quality.hero.deterministicTag')} · ` : ''}{t('quality.hero.judgeCoverage')} {judgedPct}%
                            </span>
                        )}
                    </div>
                    {/* P0/P1/P2 紧凑条 */}
                    <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
                        <MiniP tag="P0" v={composite.p0} tone="var(--error)" />
                        <MiniP tag="P1" v={composite.p1} tone="var(--warning)" />
                        <MiniP tag="P2" v={composite.p2} tone="var(--foreground-muted)" />
                    </div>
                    {nonEmpty.length >= 2 && <Spark values={nonEmpty.map((b) => b.composite)} color={scoreCol} />}
                </div>

                {/* ② 一句话判读 + 关键计数（与左右栏同节奏：标签行 + 内容，顶对齐） */}
                <div style={{ flex: '1 1 320px', minWidth: 280, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Sparkles size={13} style={{ color: 'var(--primary)' }} />
                        <span style={{ fontSize: 12, fontWeight: 800 }}>{t('quality.hero.verdictLabel')}</span>
                    </div>
                    <div style={{ borderLeft: '3px solid var(--primary)', paddingLeft: 12, fontSize: 12.5, lineHeight: 1.7, color: 'var(--foreground)' }}>
                        <b style={{ fontWeight: 800 }}>整体处于「{t(`quality.status.${composite.status}`)}」区间。</b>{' '}
                        {composite.capped && <span style={{ color: 'var(--error)', fontWeight: 700 }}>安全护栏命中，综合分已硬降级；</span>}
                        {bottleneck
                            ? <>瓶颈集中在 <span style={{ color: 'var(--warning)', fontWeight: 700 }}>{bottleneck[0]}（{fmtNum(bottleneck[1].score)}）</span>。</>
                            : <>各维覆盖有限，建议先补足评测覆盖率。</>}
                        {top[0] && <> 优先治理右侧 Top 问题，预计能最快抬升综合分。</>}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11.5, color: 'var(--foreground-secondary)', borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 2 }}>
                        <span>
                            {t('quality.summary.evaluated')} <b style={{ color: 'var(--foreground)' }}>{meta.n}</b> {t('quality.summary.times')}
                            {' · '}{t('quality.summary.passRate')} <b style={{ color: 'var(--foreground)' }}>{fmtNum(meta.passRate)}%</b>
                        </span>
                        <span>
                            {t('quality.summary.errors')} <b style={{ color: errorCount ? 'var(--error)' : 'var(--foreground)' }}>{errorCount}</b> {t('quality.summary.times')}
                            {' · '}{t('quality.summary.clusters')} <b style={{ color: 'var(--foreground)' }}>{clusterCount}</b> {t('quality.summary.classes')}
                            {evalIssueCount > 0 && (
                                <>{' · '}{t('quality.summary.evalIssues')} <b style={{ color: 'var(--foreground)' }}>{evalIssueCount}</b> {t('quality.summary.itemsUnit')}</>
                            )}
                        </span>
                    </div>
                </div>

                {/* ③ Top 3 先修问题卡（带预期收益） */}
                <div style={{ flex: '1 1 340px', minWidth: 300, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <Wrench size={13} style={{ color: 'var(--error)' }} />
                        <span style={{ fontSize: 12, fontWeight: 800 }}>{t('quality.hero.fixFirst')}</span>
                        <span style={{ flex: 1 }} />
                        {totalProblems > 0 && (
                            <button onClick={() => onAnchor('problems')} style={linkBtn}>
                                {t('quality.hero.viewAll')} {totalProblems} {t('quality.hero.problemsUnit')} ↓
                            </button>
                        )}
                    </div>
                    {top.length === 0 ? (
                        <div style={{ fontSize: 11.5, color: 'var(--foreground-muted)', padding: '14px 0' }}>{t('quality.hero.noProblems')}</div>
                    ) : top.map((p, i) => (
                        <TopProblemRow key={p.key} rank={i + 1} p={p} meta={meta} t={t} onDrillTrace={onDrillTrace} />
                    ))}
                </div>
            </div>
        </section>
    );
}

/** 预期收益（达标率提升的保守估算）：关联 trace 占比，封顶于剩余提升空间；标注"估"。 */
function gainOf(p: ProblemItem, meta: QualityReport['meta']): string | null {
    if (!p.relatedTraces.length || !meta.n) return null;
    const raw = (p.relatedTraces.length / meta.n) * 100;
    const headroom = Math.max(0, 100 - meta.passRate);
    const g = Math.min(raw, headroom);
    if (g < 0.05) return null;
    return `+${g < 1 ? g.toFixed(1) : Math.round(g)}pp`;
}

function TopProblemRow({ rank, p, meta, t, onDrillTrace }: {
    rank: number; p: ProblemItem; meta: QualityReport['meta'];
    t: (k: string) => string; onDrillTrace: (id: string) => void;
}) {
    const attr = ATTR_COLOR[p.attribution];
    const gain = gainOf(p, meta);
    return (
        <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
            border: '1px solid var(--border)', borderRadius: 9, background: 'var(--background)',
        }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: severityColor(p.severity), width: 14, flex: '0 0 14px' }}>{rank}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.desc}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 4, background: p.source === '错误' ? 'var(--error-subtle)' : 'var(--primary-subtle)', color: p.source === '错误' ? 'var(--error)' : 'var(--primary)' }}>{p.source}</span>
                    <span style={{ fontSize: 9, fontWeight: 600, padding: '1px 5px', borderRadius: 4, background: attr.bg, color: attr.fg }}>{p.attribution}</span>
                    <span style={{ fontSize: 10, color: 'var(--foreground-muted)' }}>{p.frequency} 次</span>
                    {gain && (
                        <span title={t('quality.hero.gainNote')} style={{ fontSize: 10, fontWeight: 700, color: 'var(--success)' }}>
                            {t('quality.hero.expectedGain')} {gain}<sup style={{ fontSize: 8 }}>估</sup>
                        </span>
                    )}
                </div>
            </div>
            <span style={{ display: 'inline-flex', gap: 6, flex: '0 0 auto' }}>
                {p.skillRef && (
                    <a href={`/skill-opt/${encodeURIComponent(p.skillRef.name)}/${p.skillRef.version ?? 0}`}
                        title={`${p.skillRef.name}@v${p.skillRef.version ?? 0} · ${t('quality.problems.optimize')}`}
                        style={{ ...linkBtn, color: 'var(--success)', display: 'inline-flex', alignItems: 'center' }}>
                        <Wrench size={12} />
                    </a>
                )}
                {p.relatedTraces.length > 0 && (
                    <button onClick={() => onDrillTrace(p.relatedTraces[0])} title={t('quality.hero.drill')} style={{ ...linkBtn, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                        <ArrowUpRight size={13} />
                    </button>
                )}
            </span>
        </div>
    );
}

function MiniP({ tag, v, tone }: { tag: string; v: number | null; tone: string }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 52 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9.5, fontWeight: 700 }}>
                <span style={{ padding: '1px 4px', borderRadius: 3, background: 'color-mix(in srgb, ' + tone + ' 14%, transparent)', color: tone }}>{tag}</span>
                <span style={{ color: 'var(--foreground)' }}>{v == null ? 'N/A' : fmtNum(v)}</span>
            </div>
            <div style={{ height: 4, borderRadius: 3, background: 'var(--background-secondary)', overflow: 'hidden' }}>
                <span style={{ display: 'block', height: '100%', width: `${v ?? 0}%`, background: tone, borderRadius: 3 }} />
            </div>
        </div>
    );
}

function Spark({ values, color }: { values: number[]; color: string }) {
    const W = 180, H = 26;
    const min = Math.min(...values), max = Math.max(...values);
    const range = max - min || 1;
    const pts = values.map((v, i) => `${(i / (values.length - 1)) * W},${H - 3 - ((v - min) / range) * (H - 6)}`).join(' ');
    return (
        <svg width={W} height={H} style={{ display: 'block', marginTop: 2 }}>
            <polyline points={pts} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />
        </svg>
    );
}

const linkBtn: React.CSSProperties = {
    border: 'none', background: 'none', cursor: 'pointer', fontSize: 10.5, fontWeight: 700, color: 'var(--primary)', padding: 0,
};
