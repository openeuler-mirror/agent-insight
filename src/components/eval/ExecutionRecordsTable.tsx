'use client';

import React from 'react';

/**
 * 评测执行记录表 —— A/B 测试执行记录页同款三列形态, 用例分析 ②「评测执行」与 A/B 共用。
 *
 * 每行 = 一条评测记录:
 *   - 执行 session id 列: 被评测的 trace, 可跳「链路追踪」(/trace?taskId=)
 *   - 评测状态 列: 排队中 / 评测中 / 已评测 / 失败 (失败 hover 看错误)
 *   - 评测结果 列: 跳该评测任务详情 (/eval/run/<evaluatorRunId>), 看分数 + 评估器维度细节
 *   - 分数 / 操作(重试)
 *
 * 设计取向: 纯展示 + 跳转, 不持有业务状态。数据由调用方组装成 EvalRecordRow[] 传入。
 */

export interface EvalRecordRow {
    /** 唯一 key (通常 = TrajectoryEvalResult.id) */
    id: string;
    /** 用例/trace 短标识 (taskId / caseId) */
    caseLabel: string;
    /** hover 文案 (query / 来源信息) */
    caseTitle?: string;
    /** 被评测的 trace task_id —— 跳链路追踪。数据集来源的记录, 这里是执行生成的那条 trace。 */
    executionTraceId?: string;
    /** 评估器自己跑出来的 trace (评估 session id) —— 跳链路追踪看评测器怎么判的 */
    evaluationTraceId?: string;
    /** 评测任务批次 id —— 用于拼"评测结果详情"链接 (/eval/trajectory/<trace>?runId=<id>) */
    evaluatorRunId?: string;
    /** 评测参考数据集 id —— 拼结果详情链接的 datasetId (可选, 不传则详情页自行解析) */
    datasetId?: string;
    /** pending=排队中 running/evaluating=评测中 done=已评测 failed=失败 */
    status: string;
    /** 综合分 (0-100) */
    score?: number | null;
    /** 失败时的错误信息, 失败态 hover 展示 */
    errorMsg?: string;
}

type Tone = 'pending' | 'running' | 'done' | 'fail' | 'partial';

function statusToneLabel(status: string, locale: string): { tone: Tone; label: string } {
    const zh = locale === 'zh';
    switch (status) {
        case 'pending':
        case 'queued':
            return { tone: 'pending', label: zh ? '排队中' : 'Queued' };
        case 'executing':
            return { tone: 'running', label: zh ? '执行中' : 'Executing' };
        case 'running':
        case 'evaluating':
            return { tone: 'running', label: zh ? '评测中' : 'Evaluating' };
        case 'partial':
            return { tone: 'partial', label: zh ? '部分评测' : 'Partial' };
        case 'done':
        case 'pass':
            return { tone: 'done', label: zh ? '已评测' : 'Evaluated' };
        case 'fail':
        case 'failed':
            return { tone: 'fail', label: zh ? '失败' : 'Failed' };
        default:
            return { tone: 'pending', label: status };
    }
}

const TONE_COLOR: Record<Tone, { color: string; bg: string }> = {
    pending: { color: '#888780', bg: '#F4F4F2' },
    running: { color: '#2563EB', bg: 'rgba(37,99,235,.10)' },
    partial: { color: '#D97706', bg: 'rgba(217,119,6,.10)' },
    done: { color: '#16A34A', bg: 'rgba(22,163,74,.10)' },
    fail: { color: '#DC2626', bg: 'rgba(220,38,38,.10)' },
};

function StatusPill({ tone, label, title }: { tone: Tone; label: string; title?: string }) {
    const c = TONE_COLOR[tone];
    return (
        <span
            title={title}
            style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '2px 9px', borderRadius: 99, fontSize: 11.5, fontWeight: 600,
                color: c.color, background: c.bg,
                cursor: title ? 'help' : 'default',
            }}
        >
            {tone === 'running' && (
                <span style={{
                    width: 8, height: 8, borderRadius: 99,
                    border: '1.5px solid ' + c.color, borderTopColor: 'transparent',
                    display: 'inline-block', animation: 'erspin 0.7s linear infinite',
                }} />
            )}
            {label}
        </span>
    );
}

export function ExecutionRecordsTable({
    records,
    locale = 'zh',
    title,
    emptyHint,
    onRetry,
    onRowClick,
}: {
    records: EvalRecordRow[];
    locale?: string;
    title?: React.ReactNode;
    emptyHint?: string;
    /** 行级重试回调; 不传则不显示重试按钮 */
    onRetry?: (record: EvalRecordRow) => void;
    /** 点击行(非链接/按钮区)回调, 用于在本页钻取结果详情; 不传则行不可点 */
    onRowClick?: (record: EvalRecordRow) => void;
}) {
    const zh = locale === 'zh';
    const cols = '0.9fr 1.1fr 1.1fr 88px 76px 52px' + (onRetry ? ' 52px' : '');
    return (
        <div style={{ border: '1px solid #E7E5E4', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
            <style>{'@keyframes erspin{to{transform:rotate(360deg)}}'}</style>
            {title && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: '#FAFAF7', borderBottom: '1px solid #E7E5E4' }}>
                    <div style={{ fontWeight: 700, color: '#2C2C2A', fontSize: 13 }}>{title}</div>
                    <span style={{ fontSize: 12, color: '#888780' }}>{records.length} {zh ? '条' : 'records'}</span>
                </div>
            )}
            {records.length === 0 ? (
                <div style={{ padding: 14, color: '#888780', fontSize: 13 }}>
                    {emptyHint || (zh ? '暂无评测记录' : 'No evaluation records yet')}
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 460, overflowY: 'auto' }}>
                    {/* 表头 */}
                    <div style={{
                        display: 'grid', gridTemplateColumns: cols, gap: 12, padding: '8px 12px',
                        background: '#FAFAF7', borderBottom: '1px solid #E7E5E4',
                        fontSize: 11, fontWeight: 700, color: '#5F5E5A',
                        position: 'sticky', top: 0, zIndex: 1,
                    }}>
                        <div>{zh ? '用例 / 来源' : 'Case / Source'}</div>
                        <div>{zh ? '执行 Trace' : 'Execution trace'}</div>
                        <div>{zh ? '评估 Trace' : 'Eval trace'}</div>
                        <div>{zh ? '状态' : 'Status'}</div>
                        <div>{zh ? '评测结果' : 'Result'}</div>
                        <div style={{ textAlign: 'right' }}>{zh ? '分数' : 'Score'}</div>
                        {onRetry && <div style={{ textAlign: 'right' }}>{zh ? '操作' : 'Action'}</div>}
                    </div>
                    {records.map(rec => {
                        const { tone, label } = statusToneLabel(rec.status, locale);
                        return (
                            <div
                                key={rec.id}
                                onClick={onRowClick ? () => onRowClick(rec) : undefined}
                                style={{
                                    display: 'grid', gridTemplateColumns: cols, gap: 12, alignItems: 'center',
                                    padding: '10px 12px', borderTop: '1px solid #F1EFE8', fontSize: 12,
                                    cursor: onRowClick ? 'pointer' : 'default',
                                }}
                            >
                                {/* 用例 / 来源 */}
                                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={rec.caseTitle || rec.caseLabel}>
                                    <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#5F5E5A' }}>{rec.caseLabel}</span>
                                </div>

                                {/* 执行 session id → 链路追踪 */}
                                <div style={{ minWidth: 0 }}>
                                    {rec.executionTraceId ? (
                                        <button
                                            className="v2-action-btn"
                                            style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#185FA5', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}
                                            title={zh ? '查看链路追踪' : 'View trace'}
                                            onClick={e => { e.stopPropagation(); window.open(`/trace?taskId=${encodeURIComponent(rec.executionTraceId!)}`, '_blank'); }}
                                            onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                                            onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                                        >
                                            🔗 {rec.executionTraceId}
                                        </button>
                                    ) : (
                                        <span style={{ color: '#B8B6AE' }}>—</span>
                                    )}
                                </div>

                                {/* 评估 Trace → 评估器轨迹链路追踪 */}
                                <div style={{ minWidth: 0 }}>
                                    {rec.evaluationTraceId ? (
                                        <button
                                            className="v2-action-btn"
                                            style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#7E22CE', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}
                                            title={zh ? '查看评估器轨迹（评测怎么判的）' : 'View evaluator trace'}
                                            onClick={e => { e.stopPropagation(); window.open(`/trace?taskId=${encodeURIComponent(rec.evaluationTraceId!)}`, '_blank'); }}
                                            onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                                            onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                                        >
                                            🔎 {rec.evaluationTraceId}
                                        </button>
                                    ) : (
                                        <span style={{ color: '#B8B6AE' }}>—</span>
                                    )}
                                </div>

                                {/* 评测状态 */}
                                <div>
                                    <StatusPill tone={tone} label={label} title={tone === 'fail' ? rec.errorMsg : undefined} />
                                </div>

                                {/* 评测结果 → 该 trace 的评测结果详情 (/eval/trajectory/<trace>?runId=&datasetId=);
                                    缺 trace 时退回批次详情 (/eval/run/<runId>)。 */}
                                <div>
                                    {(() => {
                                        if (!rec.evaluatorRunId) return <span style={{ color: '#B8B6AE', fontSize: 11 }}>—</span>;
                                        const resultUrl = rec.executionTraceId
                                            ? `/eval/trajectory/${encodeURIComponent(rec.executionTraceId)}?runId=${encodeURIComponent(rec.evaluatorRunId)}${rec.datasetId ? `&datasetId=${encodeURIComponent(rec.datasetId)}` : ''}`
                                            : `/eval/run/${encodeURIComponent(rec.evaluatorRunId)}`;
                                        return (
                                            <button
                                                className="v2-action-btn"
                                                style={{ fontSize: 11, padding: '3px 8px', background: '#EEF2FF', color: '#4F46E5', border: '1px solid rgba(79,70,229,.25)', borderRadius: 4, cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}
                                                title={zh ? '查看该 trace 的评测结果详情' : 'View this trace\'s evaluation result'}
                                                onClick={e => { e.stopPropagation(); window.open(resultUrl, '_blank'); }}
                                            >
                                                📋 {zh ? '查看' : 'View'}
                                            </button>
                                        );
                                    })()}
                                </div>

                                {/* 分数 */}
                                <div style={{ textAlign: 'right', fontWeight: 700, color: typeof rec.score === 'number' ? '#2C2C2A' : '#B8B6AE' }}>
                                    {typeof rec.score === 'number' ? Math.round(rec.score) : '—'}
                                </div>

                                {/* 重试 */}
                                {onRetry && (
                                    <div style={{ textAlign: 'right' }}>
                                        {(tone === 'fail') ? (
                                            <button
                                                className="v2-action-btn"
                                                style={{ fontSize: 11, padding: '3px 8px', border: '1px solid #D4D4D8', background: '#fff', borderRadius: 4, cursor: 'pointer', color: '#52525B' }}
                                                onClick={e => { e.stopPropagation(); onRetry(rec); }}
                                            >
                                                {zh ? '重试' : 'Retry'}
                                            </button>
                                        ) : <span style={{ color: '#B8B6AE', fontSize: 11 }}>—</span>}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
