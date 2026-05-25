'use client';

import { useEffect, useMemo, useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { AppTopBar } from '@/components/shell/AppTopBar';
import TraceDrawer, { TraceDrawerExecutionMeta } from '@/components/observe/TraceDrawer';
import { useAuth } from '@/lib/auth/auth-context';
import { useLocale } from '@/lib/client/locale-context';
import { apiFetch } from '@/lib/client/api';

interface Execution {
    timestamp: string;
    framework?: string;
    agentName?: string;
    query?: string;
    skill?: string;
    skills?: string[];
    is_answer_correct?: boolean;
    answer_score?: number;
    latency?: number;
    tokens?: number;
    cost?: number;
    task_id?: string;
    upload_id?: string;
    model?: string;
    is_evaluating?: boolean;
    judgment_reason?: string;
}

function SkillHistoryInner() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const skillName = searchParams.get('name') || '';
    const { user } = useAuth();
    const { t, locale } = useLocale();
    const [data, setData] = useState<Execution[]>([]);
    const [loading, setLoading] = useState(true);
    const [drawer, setDrawer] = useState<TraceDrawerExecutionMeta | null>(null);

    useEffect(() => {
        if (!user || !skillName) return;
        setLoading(true);
        apiFetch(`/api/observe/data?user=${encodeURIComponent(user)}&skill=${encodeURIComponent(skillName)}`)
            .then(r => r.json())
            .then((d: Execution[]) => setData(Array.isArray(d) ? d : []))
            .catch(() => setData([]))
            .finally(() => setLoading(false));
    }, [user, skillName]);

    const sorted = useMemo(
        () =>
            data.slice().sort((a, b) => {
                const ta = typeof a.timestamp === 'string' ? Date.parse(a.timestamp) : Number(a.timestamp);
                const tb = typeof b.timestamp === 'string' ? Date.parse(b.timestamp) : Number(b.timestamp);
                return tb - ta;
            }),
        [data],
    );

    function openTrace(e: Execution) {
        const taskId = e.task_id || e.upload_id || '';
        if (!taskId) return;
        setDrawer({
            taskId, query: e.query, framework: e.framework, model: e.model,
            latency: e.latency, tokens: e.tokens, cost: e.cost,
            score: e.answer_score ?? null, isAnswerCorrect: e.is_answer_correct,
            timestamp: e.timestamp,
        });
    }

    return (
        <>
            <AppTopBar title={`${t('nav.skillHistory')}${skillName ? ` · ${skillName}` : ''}`} showDefaultActions={false} />
            <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                    <button
                        onClick={() => router.push('/skills')}
                        className="ai-btn-s"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px' }}
                    >
                        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                            <path d="M9 11L4 7l5-4" />
                        </svg>
                        {locale === 'zh' ? '返回 Skills 管理' : 'Back to Skills'}
                    </button>
                    <div style={{ height: 14, width: 1, background: 'var(--border)' }} />
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--foreground)' }}>
                        {skillName || (locale === 'zh' ? '(未指定 Skill)' : '(No skill specified)')}
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>
                        · {sorted.length} {locale === 'zh' ? '次执行' : 'executions'}
                    </span>
                </div>

                <div className="ai-card" style={{ overflowX: 'auto' }}>
                    {loading ? (
                        <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--foreground-muted)', fontSize: 12 }}>
                            {locale === 'zh' ? '加载中…' : 'Loading…'}
                        </div>
                    ) : sorted.length === 0 ? (
                        <div style={{ padding: '40px 18px', textAlign: 'center', color: 'var(--foreground-muted)', fontSize: 12 }}>
                            {locale === 'zh' ? '该 Skill 暂无执行记录' : 'No executions for this skill'}
                        </div>
                    ) : (
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                            <thead>
                                <tr style={{ background: 'var(--background-secondary)', textAlign: 'left' }}>
                                    <Th width={140}>{locale === 'zh' ? '执行 ID' : 'Execution ID'}</Th>
                                    <Th width={140}>{locale === 'zh' ? 'Agent / 平台' : 'Agent / Platform'}</Th>
                                    <Th width={150}>{locale === 'zh' ? '执行时间' : 'Time'}</Th>
                                    <Th width={90}>{locale === 'zh' ? '状态' : 'Status'}</Th>
                                    <Th>{locale === 'zh' ? '用户问题' : 'Query'}</Th>
                                    <Th width={70} align="right">{locale === 'zh' ? '延迟' : 'Latency'}</Th>
                                    <Th width={80} align="right">{locale === 'zh' ? '准确率' : 'Score'}</Th>
                                    <Th width={80} align="center">{locale === 'zh' ? '操作' : 'Actions'}</Th>
                                </tr>
                            </thead>
                            <tbody>
                                {sorted.slice(0, 200).map((e, i) => {
                                    const id = e.task_id || e.upload_id || '';
                                    const isEvaluating = e.is_evaluating || e.judgment_reason === '结果评估中...' || e.judgment_reason === 'Evaluation in progress...';
                                    const ok = !isEvaluating && e.is_answer_correct === true;
                                    const failed = !isEvaluating && e.is_answer_correct === false;
                                    const score = typeof e.answer_score === 'number' ? Math.round(e.answer_score * 100) : null;
                                    return (
                                        <tr
                                            key={(id || i) + ''}
                                            style={{ borderBottom: '1px solid var(--table-row-border)', cursor: 'pointer' }}
                                            onClick={() => openTrace(e)}
                                            onMouseEnter={ev => ((ev.currentTarget as HTMLElement).style.background = 'var(--background-secondary)')}
                                            onMouseLeave={ev => ((ev.currentTarget as HTMLElement).style.background = 'transparent')}
                                        >
                                            <Td>
                                                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--foreground-muted)' }}>
                                                    {id.slice(0, 16) || '-'}
                                                </span>
                                            </Td>
                                            <Td>
                                                <span className="ai-badge ai-badge-b" style={{ fontSize: 10 }}>{e.agentName || e.framework || '-'}</span>
                                            </Td>
                                            <Td>
                                                <span style={{ fontSize: 11, color: 'var(--foreground-secondary)' }}>
                                                    {new Date(e.timestamp).toLocaleString()}
                                                </span>
                                            </Td>
                                            <Td>
                                                {isEvaluating && <span className="ai-badge ai-badge-b" style={{ fontSize: 10 }}>{locale === 'zh' ? '运行中' : 'Running'}</span>}
                                                {ok && <span className="ai-badge ai-badge-g" style={{ fontSize: 10 }}>{locale === 'zh' ? '成功' : 'Success'}</span>}
                                                {failed && <span className="ai-badge ai-badge-r" style={{ fontSize: 10 }}>{locale === 'zh' ? '失败' : 'Failed'}</span>}
                                                {!isEvaluating && !ok && !failed && <span className="ai-badge ai-badge-gr" style={{ fontSize: 10 }}>{locale === 'zh' ? '未评' : 'N/A'}</span>}
                                            </Td>
                                            <Td truncate>
                                                <span title={e.query} style={{ color: 'var(--foreground)' }}>
                                                    {e.query || (locale === 'zh' ? '(无问题)' : '(no query)')}
                                                </span>
                                            </Td>
                                            <Td align="right">
                                                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                                                    {fmtSec(toDisplayLatencyMs(e.latency || 0, e.framework))}
                                                </span>
                                            </Td>
                                            <Td align="right">
                                                {score !== null ? (
                                                    <span style={{ color: ok ? 'var(--success)' : failed ? 'var(--error)' : 'var(--foreground-muted)', fontWeight: 500 }}>
                                                        {score}%
                                                    </span>
                                                ) : (
                                                    <span style={{ color: 'var(--foreground-muted)' }}>-</span>
                                                )}
                                            </Td>
                                            <Td align="center">
                                                <button
                                                    onClick={ev => { ev.stopPropagation(); openTrace(e); }}
                                                    className="ai-btn-s"
                                                    style={{ fontSize: 10.5, padding: '2px 8px' }}
                                                >
                                                    {locale === 'zh' ? '执行分析' : 'Analyze'}
                                                </button>
                                            </Td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>

            <TraceDrawer
                open={drawer !== null}
                execution={drawer}
                onClose={() => setDrawer(null)}
            />
        </>
    );
}

function fmtSec(ms: number): string {
    if (!ms || !Number.isFinite(ms)) return '-';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
}

function toDisplayLatencyMs(latency: number, framework?: string): number {
    const fw = (framework || '').toLowerCase();
    if ((fw === 'opencode' || fw === 'openhands' || fw === 'claude') && latency > 0 && latency < 1000) return latency * 1000;
    return latency;
}

function Th({ children, width, align }: { children: React.ReactNode; width?: number; align?: 'left' | 'right' | 'center' }) {
    return (
        <th
            style={{
                padding: '8px 12px',
                fontSize: 10.5, fontWeight: 500,
                color: 'var(--foreground-muted)',
                borderBottom: '1px solid var(--border)',
                textAlign: align || 'left',
                whiteSpace: 'nowrap',
                width,
            }}
        >
            {children}
        </th>
    );
}

function Td({ children, align, truncate }: { children: React.ReactNode; align?: 'left' | 'right' | 'center'; truncate?: boolean }) {
    return (
        <td
            style={{
                padding: '9px 12px', fontSize: 11.5,
                textAlign: align || 'left',
                color: 'var(--foreground)',
                ...(truncate
                    ? { maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as any }
                    : {}),
            }}
        >
            {children}
        </td>
    );
}

export default function SkillHistoryPage() {
    return (
        <Suspense fallback={<div style={{ padding: 24, color: 'var(--foreground-muted)' }}>Loading…</div>}>
            <SkillHistoryInner />
        </Suspense>
    );
}
