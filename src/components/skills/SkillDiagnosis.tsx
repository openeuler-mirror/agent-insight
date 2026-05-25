'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/client/api';
import { useAuth } from '@/lib/auth/auth-context';
import { useLocale } from '@/lib/client/locale-context';
import { parseEvaluationItemsFromReason } from '@/lib/engine/evaluation/evaluation-parser';

const basePath = process.env.NEXT_PUBLIC_URL_PREFIX || '';

interface SkillIssue {
    id: string;
    content: string;
}

interface InvokedSkill {
    name: string;
    version?: number | null;
}

interface ExecutionRecord {
    task_id?: string;
    upload_id?: string;
    timestamp?: string | number;
    framework?: string;
    model?: string;
    query?: string;
    judgment_reason?: string;
    skill_issues?: SkillIssue[];
    is_skill_correct?: boolean;
    skill_trigger_rate?: number;
    skill?: string;
    skills?: string[];
    invoked_skills?: InvokedSkill[];
}

interface Props {
    taskId: string;
}

export function SkillDiagnosis({ taskId }: Props) {
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

    const invokedSkills = useMemo(() => {
        if (!record) return [] as InvokedSkill[];
        if (record.invoked_skills && record.invoked_skills.length > 0) return record.invoked_skills;
        if (record.skills && record.skills.length > 0) return record.skills.map((name): InvokedSkill => ({ name }));
        if (record.skill) return [{ name: record.skill }];
        return [];
    }, [record]);

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

    const triggerPct = typeof record.skill_trigger_rate === 'number' ? Math.round(record.skill_trigger_rate * 100) : null;

    return (
        <div style={{ padding: '20px 22px', maxWidth: 1180, margin: '0 auto' }}>
            {/* Header */}
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
                    href={`${basePath}/metrics?taskId=${taskId}`}
                    className="ai-btn-s"
                    style={{ textDecoration: 'none', fontSize: 11, flexShrink: 0 }}
                >
                    {locale === 'zh' ? '查看指标 ↗' : 'View metrics ↗'}
                </Link>
                <Link
                    href={`${basePath}/details?framework=${encodeURIComponent(record.framework || '')}&expandTaskId=${taskId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ai-btn-s"
                    style={{ textDecoration: 'none', fontSize: 11, flexShrink: 0 }}
                >
                    {locale === 'zh' ? '完整详情 ↗' : 'Full details ↗'}
                </Link>
            </div>

            {/* Skill summary KPIs */}
            <SectionTitle text={locale === 'zh' ? 'Skill 概要' : 'Skill summary'} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8, marginBottom: 12 }}>
                <Kpi
                    label={locale === 'zh' ? 'Skill 命中' : 'Skill correct'}
                    value={record.is_skill_correct === true ? '✓' : record.is_skill_correct === false ? '✗' : '—'}
                    tone={record.is_skill_correct === true ? 'green' : record.is_skill_correct === false ? 'red' : 'muted'}
                />
                <Kpi
                    label={locale === 'zh' ? '召回率' : 'Recall'}
                    value={triggerPct !== null ? `${triggerPct}%` : '—'}
                    tone={triggerPct === null ? 'muted' : triggerPct >= 80 ? 'green' : triggerPct >= 50 ? 'amber' : 'red'}
                />
                <Kpi
                    label={locale === 'zh' ? '调用 Skill 数' : 'Skills used'}
                    value={String(invokedSkills.length)}
                />
                <Kpi
                    label={locale === 'zh' ? '诊断扣分项' : 'Skill issues'}
                    value={String(record.skill_issues?.length ?? 0)}
                    tone={(record.skill_issues?.length ?? 0) > 0 ? 'red' : 'muted'}
                />
            </div>

            {/* Invoked skills */}
            <SectionTitle text={locale === 'zh' ? '调用的 Skill' : 'Invoked skills'} />
            {invokedSkills.length === 0 ? (
                <div style={emptyCardStyle}>{locale === 'zh' ? '本次执行没有调用任何 Skill' : 'No skill invoked'}</div>
            ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                    {invokedSkills.map((s, i) => (
                        <Link
                            key={`${s.name}-${i}`}
                            href={`${basePath}/skill-history?name=${encodeURIComponent(s.name)}${s.version != null ? `&version=${s.version}` : ''}`}
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 6,
                                padding: '5px 12px',
                                background: 'var(--primary-subtle)',
                                color: 'var(--primary)',
                                border: '1px solid var(--primary)',
                                borderRadius: 16,
                                fontSize: 11.5,
                                fontWeight: 500,
                                textDecoration: 'none',
                            }}
                        >
                            <span>🔧</span>
                            <span>{s.name}</span>
                            {s.version != null && <span style={{ color: 'var(--foreground-muted)' }}>v{s.version}</span>}
                        </Link>
                    ))}
                </div>
            )}

            {/* Skill issues (deductions) */}
            <SectionTitle
                text={locale === 'zh' ? 'Skill 诊断扣分项' : 'Skill diagnosis issues'}
                hint={record.skill_issues?.length ? `${record.skill_issues.length} ${locale === 'zh' ? '项' : 'items'}` : undefined}
            />
            {!record.skill_issues || record.skill_issues.length === 0 ? (
                <div style={emptyCardStyle}>
                    {locale === 'zh' ? '本次执行没有 Skill 相关的扣分诊断' : 'No skill-related deductions for this execution'}
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                    {record.skill_issues.map((issue, idx) => (
                        <div
                            key={idx}
                            style={{
                                background: 'var(--card-bg)',
                                border: '1px solid var(--card-border)',
                                borderLeft: '3px solid var(--warning)',
                                borderRadius: 6,
                                padding: '10px 14px',
                                fontSize: 11.5,
                                color: 'var(--foreground)',
                            }}
                        >
                            <div style={{ fontSize: 10, color: 'var(--foreground-muted)', marginBottom: 4, fontFamily: 'var(--font-mono)' }}>
                                {issue.id}
                            </div>
                            <div style={{ wordBreak: 'break-word' }}>{issue.content}</div>
                        </div>
                    ))}
                </div>
            )}

            {/* Per-criterion breakdown — focus on what each criterion says about skill behavior */}
            <SectionTitle
                text={locale === 'zh' ? '评分项与 Skill 关联' : 'Criteria mapped to skill behavior'}
                hint={evalItems.length > 0 ? `${evalItems.length} ${locale === 'zh' ? '项' : 'items'}` : undefined}
            />
            {evalItems.length === 0 ? (
                <div style={emptyCardStyle}>
                    {locale === 'zh' ? '该执行没有结构化评分项可供 Skill 维度分析' : 'No structured criteria available'}
                </div>
            ) : (
                <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 8, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                        <thead>
                            <tr style={{ background: 'var(--background-secondary)' }}>
                                <Th width={70}>ID</Th>
                                <Th>{locale === 'zh' ? '评分标准' : 'Criterion'}</Th>
                                <Th width={70} align="center">{locale === 'zh' ? '得分' : 'Score'}</Th>
                                <Th>{locale === 'zh' ? '原因 / 改进建议' : 'Reason / Suggestion'}</Th>
                            </tr>
                        </thead>
                        <tbody>
                            {evalItems.map((item, idx) => {
                                const skipped = item.weight === 0;
                                const relatedIssue = record.skill_issues?.find(si => si.id === item.id);
                                return (
                                    <tr key={idx} style={{ borderBottom: '1px solid var(--table-row-border)', opacity: skipped ? 0.65 : 1 }}>
                                        <Td>
                                            <span
                                                style={{
                                                    background: item.type === 'root_cause' ? 'var(--tag-amber-bg)' : 'var(--primary-subtle)',
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
                                            <div style={{ fontWeight: 500, marginBottom: 3, wordBreak: 'break-word' }}>
                                                {relatedIssue?.content || item.content}
                                            </div>
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
    return <div style={{ padding: '40px 24px', textAlign: 'center', color, fontSize: 12 }}>{msg}</div>;
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

const emptyCardStyle: React.CSSProperties = {
    padding: '14px 16px',
    background: 'var(--card-bg)',
    border: '1px dashed var(--border)',
    borderRadius: 8,
    color: 'var(--foreground-muted)',
    fontSize: 12,
};
