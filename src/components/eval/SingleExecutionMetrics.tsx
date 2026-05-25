'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/client/api';
import { useAuth } from '@/lib/auth/auth-context';
import { useLocale } from '@/lib/client/locale-context';
import { parseEvaluationItemsFromReason } from '@/lib/engine/evaluation/evaluation-parser';

const basePath = process.env.NEXT_PUBLIC_URL_PREFIX || '';

interface ExecutionRecord {
    task_id?: string;
    upload_id?: string;
    timestamp?: string | number;
    framework?: string;
    model?: string;
    query?: string;
    answer?: string;
    judgment_reason?: string;
    is_answer_correct?: boolean;
    answer_score?: number | null;
    is_skill_correct?: boolean;
    skill?: string;
    skills?: string[];
    invoked_skills?: { name: string; version?: number | null }[];
    skill_trigger_rate?: number;
    latency?: number;
    tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    cost?: number;
    tool_call_count?: number;
    tool_call_error_count?: number;
    llm_call_count?: number;
    label?: string;
    is_evaluating?: boolean;
}

interface Props {
    taskId: string;
}

export function SingleExecutionMetrics({ taskId }: Props) {
    const { user } = useAuth();
    const { locale } = useLocale();
    const [record, setRecord] = useState<ExecutionRecord | null>(null);
    const [state, setState] = useState<'loading' | 'ready' | 'error' | 'notfound'>('loading');

    useEffect(() => {
        if (!user || !taskId) return;
        setState('loading');
        apiFetch(`/api/observe/data?user=${encodeURIComponent(user)}&taskId=${encodeURIComponent(taskId)}`)
            .then(r => (r.ok ? r.json() : Promise.reject('http')))
            .then((arr: ExecutionRecord[]) => {
                if (Array.isArray(arr) && arr.length > 0) {
                    setRecord(arr[0]);
                    setState('ready');
                } else {
                    setState('notfound');
                }
            })
            .catch(() => setState('error'));
    }, [user, taskId]);

    const evalItems = useMemo(
        () => (record?.judgment_reason ? parseEvaluationItemsFromReason(record.judgment_reason) : []),
        [record?.judgment_reason],
    );

    if (state === 'loading') {
        return <Empty msg={locale === 'zh' ? '正在加载执行数据…' : 'Loading execution…'} />;
    }
    if (state === 'error') {
        return <Empty msg={locale === 'zh' ? '加载失败' : 'Load failed'} tone="error" />;
    }
    if (state === 'notfound' || !record) {
        return (
            <Empty
                msg={locale === 'zh' ? `没有找到 taskId=${taskId} 的执行记录` : `No execution found for taskId=${taskId}`}
                tone="warn"
            />
        );
    }

    const isEvaluating = record.is_evaluating || record.judgment_reason === '结果评估中...' || record.judgment_reason === 'Evaluation in progress...';
    const ok = !isEvaluating && record.is_answer_correct === true;
    const failed = !isEvaluating && record.is_answer_correct === false;
    const scorePct = typeof record.answer_score === 'number' ? Math.round(record.answer_score * 100) : null;
    const skillCount = (record.invoked_skills?.length ?? 0) || (record.skills?.length ?? 0) || (record.skill ? 1 : 0);
    const triggerPct = typeof record.skill_trigger_rate === 'number' ? Math.round(record.skill_trigger_rate * 100) : null;

    return (
        <div style={{ padding: '20px 22px', maxWidth: 1180, margin: '0 auto' }}>
            {/* Header strip */}
            <div
                style={{
                    background: 'var(--card-bg)',
                    border: '1px solid var(--card-border)',
                    borderRadius: 10,
                    padding: '14px 18px',
                    marginBottom: 14,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                }}
            >
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 10.5, color: 'var(--foreground-muted)', fontFamily: 'var(--font-mono)', marginBottom: 4 }}>
                        {taskId}
                        {record.timestamp && <span> · {new Date(record.timestamp).toLocaleString()}</span>}
                    </div>
                    <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {record.query || (locale === 'zh' ? '(无问题)' : '(no query)')}
                    </div>
                </div>
                <Link
                    href={`${basePath}/details?framework=${encodeURIComponent(record.framework || '')}&expandTaskId=${taskId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ai-btn-s"
                    style={{ textDecoration: 'none', fontSize: 11, flexShrink: 0 }}
                >
                    {locale === 'zh' ? '完整详情 ↗' : 'Full details ↗'}
                </Link>
                <Link
                    href={`${basePath}/skill-eval?taskId=${taskId}`}
                    className="ai-btn-s"
                    style={{ textDecoration: 'none', fontSize: 11, flexShrink: 0 }}
                >
                    {locale === 'zh' ? '调测分析 ↗' : 'Skill diagnosis ↗'}
                </Link>
            </div>

            {/* Status row */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 12, fontSize: 11.5, color: 'var(--foreground-secondary)' }}>
                <Pair label={locale === 'zh' ? '平台' : 'Platform'} value={record.framework || '-'} />
                <Pair label={locale === 'zh' ? '模型' : 'Model'} value={record.model || '-'} />
                <Pair
                    label={locale === 'zh' ? '状态' : 'Status'}
                    value={isEvaluating ? (locale === 'zh' ? '运行中' : 'Running') : ok ? (locale === 'zh' ? '成功' : 'Success') : failed ? (locale === 'zh' ? '失败' : 'Failed') : (locale === 'zh' ? '未评测' : 'Unjudged')}
                    valueColor={isEvaluating ? 'var(--primary)' : ok ? 'var(--success)' : failed ? 'var(--error)' : 'var(--foreground-muted)'}
                />
                {record.label && <Pair label={locale === 'zh' ? '标签' : 'Tag'} value={record.label} />}
            </div>

            {/* Quality KPIs */}
            <SectionTitle text={locale === 'zh' ? '质量指标' : 'Quality metrics'} />
            <div style={kpiGrid}>
                <Kpi
                    label={locale === 'zh' ? '准确率' : 'Accuracy'}
                    value={scorePct !== null ? `${scorePct}%` : '--'}
                    tone={scorePct === null ? 'muted' : scorePct >= 80 ? 'green' : scorePct >= 50 ? 'amber' : 'red'}
                />
                <Kpi
                    label={locale === 'zh' ? '技能召回率' : 'Skill Recall'}
                    value={triggerPct !== null ? `${triggerPct}%` : '--'}
                    tone={triggerPct === null ? 'muted' : triggerPct >= 80 ? 'green' : triggerPct >= 50 ? 'amber' : 'red'}
                />
                <Kpi
                    label={locale === 'zh' ? '调用 Skill 数' : 'Skills used'}
                    value={String(skillCount)}
                />
                <Kpi
                    label={locale === 'zh' ? 'Skill 是否命中' : 'Skill correct'}
                    value={record.is_skill_correct === true ? '✓' : record.is_skill_correct === false ? '✗' : '--'}
                    tone={record.is_skill_correct === true ? 'green' : record.is_skill_correct === false ? 'red' : 'muted'}
                />
            </div>

            {/* Performance KPIs */}
            <SectionTitle text={locale === 'zh' ? '性能指标' : 'Performance metrics'} />
            <div style={kpiGrid}>
                <Kpi label={locale === 'zh' ? '延迟' : 'Latency'} value={fmtSec(toDisplayLatencyMs(record.latency, record.framework))} />
                <Kpi label={locale === 'zh' ? '总 Token' : 'Total tokens'} value={fmtNum(record.tokens)} />
                <Kpi label={locale === 'zh' ? '成本' : 'Cost'} value={typeof record.cost === 'number' && record.cost > 0 ? `$${record.cost.toFixed(4)}` : '--'} />
                <Kpi label={locale === 'zh' ? 'LLM 调用' : 'LLM calls'} value={fmtNum(record.llm_call_count)} />
                <Kpi label={locale === 'zh' ? '工具调用' : 'Tool calls'} value={fmtNum(record.tool_call_count)} />
                <Kpi
                    label={locale === 'zh' ? '工具错误' : 'Tool errors'}
                    value={fmtNum(record.tool_call_error_count)}
                    tone={(record.tool_call_error_count ?? 0) > 0 ? 'red' : 'muted'}
                />
            </div>

            {/* Token detail */}
            {(record.input_tokens || record.output_tokens) && (
                <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--foreground-muted)', marginTop: 8 }}>
                    {record.input_tokens != null && <span>Input: {fmtNum(record.input_tokens)}</span>}
                    {record.output_tokens != null && <span>Output: {fmtNum(record.output_tokens)}</span>}
                </div>
            )}

            {/* Per-criterion breakdown */}
            <SectionTitle
                text={locale === 'zh' ? '评分项分解' : 'Per-criterion breakdown'}
                hint={evalItems.length > 0 ? `${evalItems.length} ${locale === 'zh' ? '项' : 'items'}` : undefined}
            />
            {evalItems.length === 0 ? (
                <div
                    style={{
                        padding: '14px 16px',
                        background: 'var(--card-bg)',
                        border: '1px dashed var(--border)',
                        borderRadius: 8,
                        color: 'var(--foreground-muted)',
                        fontSize: 12,
                    }}
                >
                    {record.judgment_reason
                        ? (locale === 'zh' ? '该执行没有结构化评分项（可能是自由文本评估）' : 'No structured criteria parsed (free-text judgment)')
                        : (locale === 'zh' ? '该执行尚未被评测' : 'Not yet evaluated')}
                </div>
            ) : (
                <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 8, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                        <thead>
                            <tr style={{ background: 'var(--background-secondary)' }}>
                                <Th width={70}>ID</Th>
                                <Th>{locale === 'zh' ? '评分标准' : 'Criterion'}</Th>
                                <Th width={70} align="center">{locale === 'zh' ? '得分' : 'Score'}</Th>
                                <Th width={60} align="center">{locale === 'zh' ? '权重' : 'Weight'}</Th>
                                <Th width={70} align="center">{locale === 'zh' ? '扣分' : 'Deduction'}</Th>
                                <Th>{locale === 'zh' ? '原因' : 'Reason'}</Th>
                            </tr>
                        </thead>
                        <tbody>
                            {evalItems.map((item, idx) => {
                                const skipped = item.weight === 0;
                                const deduction = skipped ? 0 : (1 - item.match_score) * item.weight;
                                return (
                                    <tr
                                        key={idx}
                                        style={{
                                            borderBottom: '1px solid var(--table-row-border)',
                                            opacity: skipped ? 0.65 : 1,
                                        }}
                                    >
                                        <Td>
                                            <span
                                                style={{
                                                    background: item.type === 'root_cause' ? 'var(--tag-amber-bg)' : 'var(--tag-blue-bg, var(--primary-subtle))',
                                                    color: item.type === 'root_cause' ? 'var(--tag-amber-fg)' : 'var(--primary)',
                                                    padding: '1px 7px',
                                                    borderRadius: 5,
                                                    fontSize: 10,
                                                    fontWeight: 600,
                                                }}
                                            >
                                                {item.id}
                                            </span>
                                        </Td>
                                        <Td>
                                            <span style={{ wordBreak: 'break-word' }}>{item.content}</span>
                                        </Td>
                                        <Td align="center">
                                            <span
                                                style={{
                                                    color: skipped
                                                        ? 'var(--foreground-muted)'
                                                        : item.match_score >= 1
                                                            ? 'var(--success)'
                                                            : item.match_score >= 0.5
                                                                ? 'var(--warning)'
                                                                : 'var(--error)',
                                                    fontWeight: 600,
                                                }}
                                            >
                                                {Math.round(item.match_score * 100)}%
                                            </span>
                                        </Td>
                                        <Td align="center">
                                            <span style={{ color: 'var(--foreground-muted)' }}>
                                                {skipped ? (locale === 'zh' ? '—' : '—') : item.weight}
                                            </span>
                                        </Td>
                                        <Td align="center">
                                            <span style={{ color: deduction > 0 ? 'var(--error)' : 'var(--foreground-muted)' }}>
                                                {skipped ? '—' : deduction.toFixed(2)}
                                            </span>
                                        </Td>
                                        <Td>
                                            <span style={{ color: 'var(--foreground-secondary)', fontSize: 11 }}>
                                                {item.explanation}
                                            </span>
                                        </Td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

function Empty({ msg, tone = 'muted' }: { msg: string; tone?: 'muted' | 'warn' | 'error' }) {
    const color =
        tone === 'error' ? 'var(--error)' : tone === 'warn' ? 'var(--warning)' : 'var(--foreground-muted)';
    return (
        <div style={{ padding: '40px 24px', textAlign: 'center', color, fontSize: 12 }}>{msg}</div>
    );
}

function SectionTitle({ text, hint }: { text: string; hint?: string }) {
    return (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '18px 0 8px' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {text}
            </span>
            {hint && <span style={{ fontSize: 10.5, color: 'var(--foreground-muted)' }}>{hint}</span>}
        </div>
    );
}

function Pair({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
    return (
        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'baseline' }}>
            <span style={{ color: 'var(--foreground-muted)' }}>{label}:</span>
            <span style={{ color: valueColor || 'var(--foreground)', fontWeight: 500 }}>{value}</span>
        </span>
    );
}

function Kpi({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'green' | 'amber' | 'red' | 'muted' }) {
    const color =
        tone === 'green' ? 'var(--success)' :
        tone === 'amber' ? 'var(--warning)' :
        tone === 'red' ? 'var(--error)' :
        tone === 'muted' ? 'var(--foreground-muted)' :
        'var(--foreground)';
    return (
        <div style={{
            background: 'var(--card-bg)',
            border: '1px solid var(--card-border)',
            borderRadius: 8,
            padding: '10px 14px',
        }}>
            <div style={{ fontSize: 10.5, color: 'var(--foreground-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
                {label}
            </div>
            <div style={{ fontSize: 18, fontWeight: 600, color, fontFamily: 'var(--font-mono)' }}>
                {value}
            </div>
        </div>
    );
}

function Th({ children, width, align }: { children: React.ReactNode; width?: number; align?: 'left' | 'right' | 'center' }) {
    return (
        <th
            style={{
                padding: '8px 12px',
                fontSize: 10.5,
                fontWeight: 500,
                color: 'var(--foreground-muted)',
                borderBottom: '1px solid var(--border)',
                textAlign: align || 'left',
                width,
                whiteSpace: 'nowrap',
            }}
        >
            {children}
        </th>
    );
}

function Td({ children, align }: { children: React.ReactNode; align?: 'left' | 'right' | 'center' }) {
    return (
        <td style={{ padding: '8px 12px', fontSize: 11.5, textAlign: align || 'left', color: 'var(--foreground)' }}>
            {children}
        </td>
    );
}

const kpiGrid: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
    gap: 8,
};

function fmtSec(ms?: number): string {
    if (!ms || !Number.isFinite(ms)) return '-';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
}

function toDisplayLatencyMs(latency?: number, framework?: string): number | undefined {
    if (latency == null) return undefined;
    const fw = (framework || '').toLowerCase();
    if ((fw === 'opencode' || fw === 'openhands' || fw === 'claude') && latency > 0 && latency < 1000) return latency * 1000;
    return latency;
}

function fmtNum(n?: number): string {
    return typeof n === 'number' ? n.toLocaleString() : '-';
}
