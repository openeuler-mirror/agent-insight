'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, Loader2 } from 'lucide-react';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { Term } from '@/components/text/Term';
import { useLocale } from '@/lib/client/locale-context';
import { apiFetch } from '@/lib/client/api';
import { QualityConfigBar, type ConfigState } from '@/components/quality/QualityConfigBar';
import { QualityHero } from '@/components/quality/QualityHero';
import { MethodologyCards } from '@/components/quality/MethodologyCards';
import { ProcessPanel } from '@/components/quality/ProcessPanel';
import { QualityTrendChart } from '@/components/quality/QualityTrendChart';
import { ProblemSummaryPanel } from '@/components/quality/ProblemSummaryPanel';
import { ExecutionScoreTable } from '@/components/quality/ExecutionScoreTable';
import type { QualityReport, QualityAgentInfo, WindowKind, TrendBucket, TrendGranularity } from '@/lib/engine/quality-monitoring/types';

// 客户端窗口范围（与后端 resolveWindowRange 同口径），用于 /executions 取数与桶下钻。
function windowRange(window: WindowKind): { from: string; to: string } {
    const to = new Date();
    const days = window === '1d' ? 1 : window === '1w' ? 7 : 30;
    const from = new Date(to.getTime() - days * 86_400_000);
    return { from: from.toISOString(), to: to.toISOString() };
}

function bucketRange(b: TrendBucket, g: TrendGranularity): { from: string; to: string; label: string } {
    const start = new Date(b.bucket_ts);
    const stepMs = g === 'hour' ? 3_600_000 : g === 'day' ? 86_400_000 : 7 * 86_400_000;
    const end = new Date(start.getTime() + stepMs);
    const label = g === 'hour'
        ? `${String(start.getHours()).padStart(2, '0')}:00`
        : `${start.getMonth() + 1}/${start.getDate()}`;
    return { from: start.toISOString(), to: end.toISOString(), label };
}

// 信息金字塔：Hero(结论+先修) → 四维卡 → 问题汇总 → 趋势/过程/执行表默认折叠（证据层按需展开）。
type SectionKey = 'trend' | 'process' | 'exec';
const ANCHOR_TO_SECTION: Record<string, SectionKey | undefined> = { cost: 'trend', process: 'process', exec: 'exec' };

export default function QualityPage() {
    const { t } = useLocale();
    const router = useRouter();

    const [agents, setAgents] = useState<QualityAgentInfo[]>([]);
    const [skills, setSkills] = useState<string[]>([]);
    const [config, setConfig] = useState<ConfigState>({ agent: '', window: '1w', skill: 'all', status: 'all' });
    const [report, setReport] = useState<QualityReport | null>(null);
    const [loading, setLoading] = useState(false);
    const [bucketSel, setBucketSel] = useState<{ from: string; to: string; label: string } | null>(null);
    const [open, setOpen] = useState<Record<SectionKey, boolean>>({ trend: false, process: false, exec: false });

    // 加载 Agent 列表 + skill facet
    useEffect(() => {
        apiFetch('/api/quality/agents')
            .then((r) => r.json())
            .then((d) => {
                const list: QualityAgentInfo[] = Array.isArray(d.agents) ? d.agents : [];
                setAgents(list);
                setSkills(Array.isArray(d.skills) ? d.skills : []);
                if (list.length) setConfig((c) => (c.agent ? c : { ...c, agent: list[0].name }));
            })
            .catch(() => setAgents([]));
    }, []);

    // 切 Agent/窗口/Skill → 全页重算（BR-002）。status 为行级三态，不触发重算。
    const loadReport = useCallback((agent: string, window: WindowKind, skill: string) => {
        if (!agent) { setReport(null); return; }
        setLoading(true);
        setBucketSel(null);
        const q = new URLSearchParams({ agent, window });
        if (skill && skill !== 'all') q.set('skill', skill);
        apiFetch(`/api/quality/report?${q.toString()}`)
            .then((r) => r.json())
            .then((d) => setReport(d?.error ? null : d))
            .catch(() => setReport(null))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        loadReport(config.agent, config.window, config.skill);
    }, [config.agent, config.window, config.skill, loadReport]);

    const range = useMemo(() => windowRange(config.window), [config.window]);
    const execRange = bucketSel ?? range;

    // 锚点跳转：折叠区先展开再滚动（证据层按需呈现）
    const onAnchor = useCallback((id: string) => {
        const sec = ANCHOR_TO_SECTION[id];
        if (sec) setOpen((o) => (o[sec] ? o : { ...o, [sec]: true }));
        requestAnimationFrame(() => setTimeout(() => {
            document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 40));
    }, []);
    const onDrillTrace = useCallback((executionId: string) => {
        if (executionId) router.push(`/fault?executionId=${encodeURIComponent(executionId)}`);
    }, [router]);
    const onBucketClick = useCallback((b: TrendBucket) => {
        if (report) {
            setBucketSel(bucketRange(b, report.trend.granularity));
            onAnchor('exec');
        }
    }, [report, onAnchor]);

    const showBody = report && !report.meta.empty;

    const NAV: { id: string; label: string }[] = [
        { id: 'verdict', label: t('quality.nav.verdict') },
        { id: 'analysis', label: t('quality.nav.dims') },
        { id: 'problems', label: t('quality.nav.problems') },
        { id: 'cost', label: t('quality.nav.trend') },
        { id: 'process', label: t('quality.nav.process') },
        { id: 'exec', label: t('quality.nav.exec') },
    ];

    return (
        <>
            <AppTopBar title={<Term id="quality-monitoring" label={t('quality.title')} />} showDefaultActions={false} />
            <div style={{ flex: 1, overflowY: 'auto', padding: '18px 26px 48px', background: 'var(--background)' }}>
                <div style={{ maxWidth: 1320, width: '100%', margin: '0 auto' }}>
                    <QualityConfigBar
                        agents={agents}
                        skills={skills}
                        value={config}
                        onChange={(patch) => setConfig((c) => ({ ...c, ...patch }))}
                    />

                    {/* 粘性迷你导航：让"结论→证据"的跳转始终可达 */}
                    {showBody && (
                        <nav style={{
                            position: 'sticky', top: -18, zIndex: 20, display: 'flex', gap: 6, padding: '8px 2px',
                            background: 'color-mix(in srgb, var(--background) 90%, transparent)', backdropFilter: 'blur(8px)',
                            marginBottom: 6,
                        }}>
                            {NAV.map((n) => (
                                <button key={n.id} onClick={() => onAnchor(n.id)} style={{
                                    fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 14, cursor: 'pointer',
                                    border: '1px solid var(--border)', background: 'var(--card-bg)', color: 'var(--foreground-secondary)',
                                }}>
                                    {n.label}
                                </button>
                            ))}
                        </nav>
                    )}

                    {!config.agent ? (
                        <EmptyState title={t('quality.empty.noAgent')} desc={t('quality.empty.noAgentDesc')} />
                    ) : loading && !report ? (
                        <LoadingState label={t('quality.loading')} />
                    ) : report && report.meta.empty ? (
                        <EmptyState title={t('quality.empty.noTraces')} desc={t('quality.empty.noTracesDesc')} />
                    ) : report ? (
                        <div style={{ opacity: loading ? 0.6 : 1, transition: 'opacity .15s' }}>
                            {/* ① 结论层：10 秒拿走 判断+瓶颈+行动 */}
                            <QualityHero report={report} onDrillTrace={onDrillTrace} onAnchor={onAnchor} />
                            {/* ② 方向层：四维卡 */}
                            <MethodologyCards report={report} onAnchor={onAnchor} />
                            {/* ③ 行动层：完整问题清单（核心差异点，默认展开） */}
                            <ProblemSummaryPanel report={report} onDrillTrace={onDrillTrace} />
                            {/* ④ 证据层：默认折叠，按需展开 */}
                            <QualityTrendChart
                                report={report}
                                onBucketClick={onBucketClick}
                                collapsed={!open.trend}
                                onToggleCollapse={() => setOpen((o) => ({ ...o, trend: !o.trend }))}
                            />
                            <ProcessPanel
                                report={report}
                                collapsed={!open.process}
                                onToggleCollapse={() => setOpen((o) => ({ ...o, process: !o.process }))}
                            />
                            <ExecutionScoreTable
                                key={`${config.agent}|${execRange.from}|${execRange.to}|${config.skill}`}
                                agent={config.agent}
                                from={execRange.from}
                                to={execRange.to}
                                skill={config.skill}
                                statusFilter={config.status}
                                bucketLabel={bucketSel?.label ?? null}
                                onClearBucket={() => setBucketSel(null)}
                                onDrill={onDrillTrace}
                                collapsed={!open.exec}
                                onToggleCollapse={() => setOpen((o) => ({ ...o, exec: !o.exec }))}
                            />
                        </div>
                    ) : (
                        <LoadingState label={t('quality.loading')} />
                    )}
                </div>
            </div>
        </>
    );
}

function EmptyState({ title, desc }: { title: string; desc: string }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '80px 20px', textAlign: 'center' }}>
            <div style={{ width: 48, height: 48, borderRadius: 12, background: 'var(--primary-subtle)', color: 'var(--primary)', display: 'grid', placeItems: 'center' }}>
                <Activity size={24} />
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--foreground)' }}>{title}</div>
            <div style={{ fontSize: 12.5, color: 'var(--foreground-muted)', maxWidth: 420, lineHeight: 1.6 }}>{desc}</div>
        </div>
    );
}

function LoadingState({ label }: { label: string }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '80px 20px', color: 'var(--foreground-muted)', fontSize: 13 }}>
            <Loader2 size={18} className="animate-spin" /> {label}
        </div>
    );
}
