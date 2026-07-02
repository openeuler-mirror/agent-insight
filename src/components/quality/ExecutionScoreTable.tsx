'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { ChevronLeft, ChevronRight, ListChecks, X } from 'lucide-react';
import { useLocale } from '@/lib/client/locale-context';
import { apiFetch } from '@/lib/client/api';
import { StatusBadge } from '@/components/feedback/StatusBadge';
import { scoreColor } from './quality-ui';

interface ExecRow {
    id: string;
    task_id?: string;
    upload_id?: string;
    query?: string;
    agent?: string | null;
    timestamp?: string;
    answer_score?: number | null;
    is_answer_correct?: boolean | null;
    tool_call_count?: number;
    tool_call_error_count?: number;
    failures?: { failure_type?: string; description?: string }[];
    tokens?: number | null;
    latency?: number | null;
    result_score?: number | null;
    result_eval_status?: 'missing' | 'running' | 'done' | 'failed';
    result_metrics?: Record<string, { score: number | null; status: string; confidence: number; note?: string; error?: string }>;
}

type Sig = 'ok' | 'warn' | 'bad';

const SECURITY = /(inject|越权|未授权|unauthorized|pii|敏感|泄露|leak)/i;
const PAGE_SIZE = 20;

function resultSig(r: ExecRow): Sig {
    const v = r.result_score;
    if (v == null) return 'warn';
    return v >= 85 ? 'ok' : v >= 70 ? 'warn' : 'bad';
}
function toolSig(r: ExecRow): Sig {
    const e = r.tool_call_error_count ?? 0;
    return e === 0 ? 'ok' : e <= 1 ? 'warn' : 'bad';
}
function costSig(r: ExecRow): Sig {
    if (r.latency == null) return 'ok';
    return r.latency < 60000 ? 'ok' : r.latency < 120000 ? 'warn' : 'bad';
}
function safetySig(r: ExecRow): Sig {
    return (r.failures ?? []).some((f) => SECURITY.test(`${f.failure_type ?? ''} ${f.description ?? ''}`)) ? 'bad' : 'ok';
}

export function ExecutionScoreTable({ agent, user, from, to, skill, statusFilter, bucketLabel, onClearBucket, onDrill, collapsed, onToggleCollapse }: {
    agent: string;
    user?: string | null;   // 身份口径：拼入 ?user= 实现用户隔离，缺失会越权拿全量执行记录
    from: string;
    to: string;
    skill?: string;
    statusFilter?: string;   // '达标'|'关注'|'异常'|'all' — 本页行级三态筛选（状态为评分后派生量）
    bucketLabel?: string | null;
    onClearBucket?: () => void;
    onDrill: (executionId: string) => void;
    collapsed?: boolean;
    onToggleCollapse?: () => void;
}) {
    const { t } = useLocale();
    const [rows, setRows] = useState<ExecRow[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(true);
    // 注：filter（agent/from/to/skill）变更时由父组件通过 key 重挂载本表，page 自然回到 1，
    // 无需在 effect 内同步 setState（避免 react-hooks/set-state-in-effect 级联渲染）。

    const load = useCallback(() => {
        if (!agent || !user) return;
        setLoading(true);
        const q = new URLSearchParams({ agent, user, from, to, page: String(page), pageSize: String(PAGE_SIZE) });
        if (skill && skill !== 'all') q.set('skill', skill);
        apiFetch(`/api/quality/executions?${q.toString()}`)
            .then((r) => r.json())
            .then((d) => { setRows(Array.isArray(d.records) ? d.records : []); setTotal(d.total ?? 0); })
            .catch(() => { setRows([]); setTotal(0); })
            .finally(() => setLoading(false));
    }, [agent, user, from, to, skill, page]);

    useEffect(() => { load(); }, [load]);

    const statusOf = (s: number): '达标' | '关注' | '异常' => (s >= 85 ? '达标' : s >= 70 ? '关注' : '异常');
    const shown = (statusFilter && statusFilter !== 'all')
        ? rows.filter((r) => r.result_score != null && statusOf(r.result_score) === statusFilter)
        : rows;

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const startIdx = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
    const endIdx = Math.min(total, page * PAGE_SIZE);

    return (
        <section id="exec" style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12, boxShadow: '0 1px 2px rgba(20,22,30,.04)', overflow: 'hidden', marginBottom: 14, scrollMarginTop: 56 }}>
            <div style={{ padding: '14px 18px', borderBottom: collapsed ? 'none' : '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, cursor: onToggleCollapse ? 'pointer' : undefined }} onClick={onToggleCollapse}>
                <span style={{ ...ix, background: 'var(--success-subtle)', color: 'var(--success)' }}><ListChecks size={13} /></span>
                <span style={{ fontSize: 13.5, fontWeight: 800 }}>{t('quality.table.title')}</span>
                <span style={{ background: 'var(--primary-subtle)', color: 'var(--primary)', fontSize: 11, fontWeight: 700, padding: '4px 8px', borderRadius: 6 }}>
                    {total} {t('quality.table.count')}
                </span>
                {bucketLabel && (
                    <button onClick={(e) => { e.stopPropagation(); onClearBucket?.(); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--primary-subtle-border)', background: 'var(--primary-subtle)', color: 'var(--primary)', cursor: 'pointer' }}>
                        {bucketLabel} <X size={12} />
                    </button>
                )}
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 10.5, color: 'var(--foreground-muted)' }}>{t('quality.table.note')}</span>
                {onToggleCollapse && (
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--primary)' }}>
                        {collapsed ? t('quality.fold.expand') + ' ▾' : t('quality.fold.collapse') + ' ▴'}
                    </span>
                )}
            </div>

            {collapsed ? null : (<>
            <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                        <tr>
                            {[t('quality.table.traceId'), t('quality.table.agent'), t('quality.table.task'), t('quality.table.score'), t('quality.table.signals'), t('quality.table.status'), t('quality.table.time')].map((h, i) => (
                                <th key={i} style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--foreground-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'left', padding: '10px 14px', background: 'var(--background-secondary)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {loading ? (
                            <tr><td colSpan={7} style={{ padding: 28, textAlign: 'center', color: 'var(--foreground-muted)', fontSize: 12 }}>{t('quality.table.loading')}</td></tr>
                        ) : shown.length === 0 ? (
                            <tr><td colSpan={7} style={{ padding: 28, textAlign: 'center', color: 'var(--foreground-muted)', fontSize: 12 }}>{t('quality.table.empty')}</td></tr>
                        ) : shown.map((r) => {
                            const s = r.result_score;
                            const status = s == null ? 'pending' : s >= 85 ? 'success' : s >= 70 ? 'warning' : 'error';
                            const evalLabel = r.result_eval_status === 'running' ? t('quality.table.evaluating')
                                : r.result_eval_status === 'failed' ? t('quality.table.evalFailed')
                                    : r.result_eval_status === 'missing' ? t('quality.table.notEvaluated') : null;
                            const metricTitle = Object.entries(r.result_metrics ?? {}).map(([key, value]) => `${key}: ${value.score ?? 'N/A'}`).join('\n');
                            return (
                                <tr key={r.id || r.task_id || r.upload_id} onClick={() => onDrill(r.id)} style={{ cursor: 'pointer' }}
                                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--background-secondary)')}
                                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                                    <td style={td}><span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5, color: 'var(--primary)', fontWeight: 600 }}>{(r.id || '').slice(0, 14) || '—'}</span></td>
                                    <td style={td}><span style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground-secondary)' }}>{r.agent || '—'}</span></td>
                                    <td style={{ ...td, maxWidth: 300 }}><div style={{ fontSize: 11.5, color: 'var(--foreground-secondary)', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{r.query || '—'}</div></td>
                                    <td style={td}>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 96 }}>
                                            <span style={{ fontSize: 15, fontWeight: 700, color: s == null ? 'var(--foreground-muted)' : scoreColor(s) }}>{s == null ? 'N/A' : s}<span style={{ fontSize: 10, color: 'var(--foreground-muted)' }}>{s == null ? '' : '/100'}</span></span>
                                            <span style={{ height: 5, borderRadius: 5, background: 'var(--background-secondary)', overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: `${s ?? 0}%`, background: s == null ? 'var(--foreground-muted)' : scoreColor(s), borderRadius: 5 }} /></span>
                                        </div>
                                    </td>
                                    <td style={td}>
                                        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                                            <span title={metricTitle}><SigChip sig={resultSig(r)} label={t('quality.table.sigResult')} /></span>
                                            <SigChip sig={toolSig(r)} label={t('quality.table.sigTool')} />
                                            <SigChip sig={costSig(r)} label={t('quality.table.sigCost')} />
                                            <SigChip sig={safetySig(r)} label={t('quality.table.sigSafe')} />
                                        </div>
                                    </td>
                                    <td style={td}>{evalLabel ? <span style={{ fontSize: 10.5, color: r.result_eval_status === 'failed' ? 'var(--error)' : 'var(--foreground-muted)' }}>{evalLabel}</span> : <StatusBadge status={status} label={t(`quality.status.${(s ?? 0) >= 85 ? '达标' : (s ?? 0) >= 70 ? '关注' : '异常'}`)} />}</td>
                                    <td style={td}><span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 11, color: 'var(--foreground-muted)', whiteSpace: 'nowrap' }}>{fmtTs(r.timestamp)}</span></td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', padding: '12px 18px', fontSize: 11.5, color: 'var(--foreground-muted)' }}>
                <span>{t('quality.table.showing')} {startIdx} {t('quality.table.to')} {endIdx} {t('quality.table.of')} {total} {t('quality.table.total')}</span>
                <span style={{ flex: 1 }} />
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <PagerBtn disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}><ChevronLeft size={13} /></PagerBtn>
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--foreground-secondary)', padding: '0 6px' }}>{page} / {totalPages}</span>
                    <PagerBtn disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}><ChevronRight size={13} /></PagerBtn>
                </div>
            </div>
            </>)}
        </section>
    );
}

function SigChip({ sig, label }: { sig: Sig; label: string }) {
    const map = { ok: ['var(--success-subtle)', 'var(--success)'], warn: ['var(--warning-subtle)', 'var(--warning)'], bad: ['var(--error-subtle)', 'var(--error)'] } as const;
    const [bg, fg] = map[sig];
    return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 600, padding: '3px 7px', borderRadius: 6, background: bg, color: fg }}><span style={{ width: 5, height: 5, borderRadius: '50%', background: fg }} />{label}</span>;
}

function PagerBtn({ children, disabled, onClick }: { children: React.ReactNode; disabled?: boolean; onClick: () => void }) {
    return <button disabled={disabled} onClick={onClick} style={{ width: 26, height: 26, borderRadius: 7, border: '1px solid var(--border)', display: 'grid', placeItems: 'center', background: 'var(--card-bg)', color: 'var(--foreground-secondary)', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1 }}>{children}</button>;
}

function fmtTs(ts?: string): string {
    if (!ts) return '—';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '—';
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const td: React.CSSProperties = { padding: '12px 14px', borderBottom: '1px solid var(--border)', verticalAlign: 'middle' };
const ix: React.CSSProperties = { width: 22, height: 22, borderRadius: 6, display: 'grid', placeItems: 'center', flex: '0 0 22px' };
