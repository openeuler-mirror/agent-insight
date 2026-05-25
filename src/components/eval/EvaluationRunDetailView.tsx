'use client';

/**
 * 评测批次详情 panel —— /eval/run/[runId]。
 *
 * 顶部：「{`< 返回评测批次列表`}」+ 批次 id + 整体统计
 * 主体：该批次内的 trace 评测列表（点行 → /eval/trajectory/[traceId]?runId=...&datasetId=...）
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/client/api';
import { useAuth } from '@/lib/auth/auth-context';

interface TrajectoryDimensionScores {
    completeness: number;
    toolChoice: number;
    redundancy: number;
    attribution: number;
}

interface TrajectoryResult {
    id: string;
    evaluatorRunId: string;
    selectedEvaluators?: string[];
    selectedEvaluatorNames?: string[];
    autoWatch?: boolean;
    watchedAgent?: string;
    watchPlaceholder?: boolean;
    datasetId: string;
    caseId: string;
    executionId: string | null;
    taskId: string | null;
    status: 'pending' | 'running' | 'done' | 'failed';
    errorMessage: string | null;
    resultEvaluationError?: string | null;
    trajectoryScore: number | null;
    resultEvaluationScore?: number | null;
    customEvaluationScore?: number | null;
    customEvaluations?: unknown;
    dimensionScores: TrajectoryDimensionScores | null;
    rootCauseStep: string | null;
    createdAt: string;
}

interface ExecutionRecord {
    task_id?: string | null;
    upload_id?: string | null;
    framework?: string;
    model?: string;
    query?: string;
    final_result?: string;
    answer_score?: number | null;
    timestamp?: string;
    latency?: number | null;
    agent?: string | null;
    agentName?: string | null;
    agents?: string[];
}

const COLORS = {
    primary: '#534AB7',
    primarySubtle: '#EEEDFE',
    success: '#0F6E56',
    successSubtle: '#E1F2EC',
    danger: '#A32D2D',
    dangerSubtle: '#FFEBEB',
    warning: '#9A7311',
    warningSubtle: '#FFF4D6',
    border: '#eceae4',
    borderSoft: '#f3f2ee',
    bgSoft: '#f9f9fb',
    text: '#1a1a18',
    textSecondary: '#2c2b28',
    textMuted: '#6b6a66',
    textDisabled: '#8a8884',
};

const POLL_MS = 3000;
const EVALUATOR_KEYWORDS = ['evaluator', 'checker', 'judge', 'locator', 'assessor', 'grader', '评估器'];
const NO_EVALUABLE_CASE_PREFIX = '[no-evaluable-case]';

function isEvaluatorAgentName(name?: string | null): boolean {
    const n = String(name || '').trim();
    if (!n) return true;
    return EVALUATOR_KEYWORDS.some(kw => n.toLowerCase().includes(kw));
}

const STATUS_LABEL: Record<TrajectoryResult['status'], string> = {
    pending: '待评测',
    running: '评测中',
    done: '已评测',
    failed: '评测失败',
};

const STATUS_COLOR: Record<TrajectoryResult['status'], string> = {
    pending: COLORS.textDisabled,
    running: '#1677ff',
    done: COLORS.success,
    failed: COLORS.danger,
};

function getEvaluatorDisplayNames(rows: Pick<TrajectoryResult, 'selectedEvaluatorNames'>[]): string {
    const names = Array.from(new Set(
        rows.flatMap(row => Array.isArray(row.selectedEvaluatorNames) ? row.selectedEvaluatorNames : []),
    ));
    return names.length > 0 ? names.join('、') : 'Agent 轨迹质量';
}

function hasSelectedEvaluator(r: TrajectoryResult, evaluatorId: string): boolean {
    const selected = Array.isArray(r.selectedEvaluators) ? r.selectedEvaluators : [];
    if (selected.length === 0) return evaluatorId === 'preset-agent-trace-quality';
    return selected.includes(evaluatorId);
}

function isEvaluationTerminal(status?: TrajectoryResult['status'] | null): boolean {
    return status === 'done' || status === 'failed';
}

function getEffectiveStatus(r: TrajectoryResult): TrajectoryResult['status'] {
    return r.status === 'done' && r.resultEvaluationError ? 'failed' : r.status;
}

function deriveCustomEvaluationScore(result: TrajectoryResult): number | null {
    if (typeof result.customEvaluationScore === 'number' && Number.isFinite(result.customEvaluationScore)) {
        return result.customEvaluationScore;
    }
    const rawItems = Array.isArray(result.customEvaluations)
        ? result.customEvaluations
        : result.customEvaluations && typeof result.customEvaluations === 'object'
            ? Object.values(result.customEvaluations as Record<string, unknown>)
            : [];
    const scores = rawItems
        .map(item => item && typeof item === 'object' ? (item as Record<string, unknown>).score : null)
        .filter((score): score is number => typeof score === 'number' && Number.isFinite(score));
    return scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
}

function getDisplayScore(result: TrajectoryResult, exec?: ExecutionRecord): number | null {
    if (!isEvaluationTerminal(result.status) || getEffectiveStatus(result) !== 'done' || isNoEvaluableCase(result)) return null;
    const traceScore = hasSelectedEvaluator(result, 'preset-agent-trace-quality') ? result.trajectoryScore : null;
    const answerScore = hasSelectedEvaluator(result, 'preset-agent-task-completion')
        ? exec?.answer_score ?? result.resultEvaluationScore ?? null
        : null;
    const derivedCustomScore = deriveCustomEvaluationScore(result);
    const hasCustom = Array.isArray(result.selectedEvaluators)
        ? result.selectedEvaluators.some(id => id.startsWith('custom-'))
        : derivedCustomScore != null;
    const customScore = hasCustom ? derivedCustomScore : null;
    const parts = [traceScore, answerScore, customScore]
        .filter((score): score is number => typeof score === 'number' && Number.isFinite(score));
    if (parts.length === 0) return null;
    return parts.reduce((a, b) => a + b, 0) / parts.length;
}

function isNoEvaluableCase(r?: Pick<TrajectoryResult, 'status' | 'errorMessage' | 'resultEvaluationError'> | null): boolean {
    return Boolean(r?.status === 'failed' && r.errorMessage?.includes(NO_EVALUABLE_CASE_PREFIX));
}

function getStatusLabel(r: TrajectoryResult): string {
    return isNoEvaluableCase(r) ? '无可评测case' : STATUS_LABEL[getEffectiveStatus(r)];
}

function getStatusColor(r: TrajectoryResult): string {
    return isNoEvaluableCase(r) ? COLORS.warning : STATUS_COLOR[getEffectiveStatus(r)];
}

function fmtScore10(n: number | null | undefined): string {
    if (n == null || Number.isNaN(n)) return '--';
    return (n * 10).toFixed(1);
}

function fmtTime(s?: string | null): string {
    if (!s) return '--';
    try {
        return new Date(s).toLocaleString('zh-CN', { hour12: false });
    } catch {
        return s;
    }
}

function formatTraceIdPreview(traceId: string | null | undefined): string {
    if (!traceId) return '--';
    return traceId.slice(0, 14) || '--';
}

export default function EvaluationRunDetailView({ runId }: { runId: string }) {
    const { user } = useAuth();
    const router = useRouter();
    const [results, setResults] = useState<TrajectoryResult[]>([]);
    const [execMap, setExecMap] = useState<Map<string, ExecutionRecord>>(new Map());
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string>('');

    // 拉该 Run 的 results（轮询，因为可能 running）
    useEffect(() => {
        if (!user || !runId) return;
        let stopped = false;
        const tick = async () => {
            try {
                const res = await apiFetch(
                    `/api/eval/trajectory/results?user=${encodeURIComponent(user)}&runId=${encodeURIComponent(runId)}&limit=500`,
                );
                const data = await res.json();
        if (!stopped) {
            const rows = Array.isArray(data?.results) ? data.results as TrajectoryResult[] : [];
            setResults(rows.filter(r => !r.watchPlaceholder));
        }
            } catch (e: unknown) {
                const message = e instanceof Error ? e.message : String(e);
                if (!stopped) setError(`加载失败：${message}`);
            } finally {
                if (!stopped) setLoading(false);
            }
        };
        tick();
        const t = setInterval(tick, POLL_MS);
        return () => {
            stopped = true;
            clearInterval(t);
        };
    }, [user, runId]);

    // 拉 execution 元数据（按 traceId 批量）—— 简化为一次性拉用户全量执行记录后过滤
    useEffect(() => {
        if (!user || results.length === 0) return;
        apiFetch(`/api/observe/data?user=${encodeURIComponent(user)}`)
            .then(r => r.json())
            .then((arr: ExecutionRecord[]) => {
                if (!Array.isArray(arr)) return;
                const wanted = new Set(
                    results.flatMap(r => [r.taskId, r.executionId]).filter(Boolean) as string[],
                );
                const m = new Map<string, ExecutionRecord>();
                for (const r of arr) {
                    if (r.task_id && wanted.has(r.task_id)) m.set(r.task_id, r);
                    if (r.upload_id && wanted.has(r.upload_id)) m.set(r.upload_id, r);
                }
                setExecMap(m);
            })
            .catch(() => undefined);
    }, [user, results]);

    function getExecutionAgent(r?: ExecutionRecord): string {
        if (!r) return '';
        const primary = [r.agentName, r.agent].find(v => v?.trim() && !isEvaluatorAgentName(v));
        if (primary) return primary;
        const observed = (r.agents || []).find(v => !isEvaluatorAgentName(v));
        if (observed) return observed;
        return '';
    }

    const summary = useMemo(() => {
        const done = results.filter(r => getEffectiveStatus(r) === 'done').length;
        const running = results.filter(r => r.status === 'pending' || r.status === 'running').length;
        const failed = results.filter(r => getEffectiveStatus(r) === 'failed').length;
        const scores = results
            .map(r => getDisplayScore(r, execMap.get(r.taskId || r.executionId || '')))
            .filter((s): s is number => typeof s === 'number');
        const executionAgents = results
            .map(r => getExecutionAgent(execMap.get(r.taskId || r.executionId || '')))
            .filter(Boolean);
        const agentCounts = new Map<string, number>();
        for (const agent of executionAgents) agentCounts.set(agent, (agentCounts.get(agent) || 0) + 1);
        const executionAgent = Array.from(agentCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
        const autoWatch = results.some(r => r.autoWatch === true);
        const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
        const startedAt = results.length === 0
            ? null
            : new Date(Math.min(...results.map(r => new Date(r.createdAt).getTime()))).toISOString();
        return { total: results.length, done, running, failed, avg, startedAt, executionAgent, autoWatch };
    }, [results, execMap]);

    if (loading) return <div style={{ padding: 24 }}>加载评测批次中...</div>;

    if (results.length === 0) {
        return (
            <div style={{ padding: '24px 22px', maxWidth: 1480, margin: '0 auto' }}>
                <button onClick={() => router.push('/eval')} style={btnSmallStyle()}>{`< 返回评测批次列表`}</button>
                <div style={{ marginTop: 16, padding: 24, color: COLORS.textMuted, textAlign: 'center', border: `1px solid ${COLORS.border}`, borderRadius: 8 }}>
                    未找到该评测批次。
                </div>
            </div>
        );
    }

    return (
        <div style={{ padding: '18px 22px 28px', maxWidth: 1480, margin: '0 auto', color: COLORS.text }}>
            {/* 顶部：返回 + 批次概要 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                <button onClick={() => router.push('/eval')} style={btnSmallStyle()}>{`< 返回评测批次列表`}</button>
                <span style={{ height: 14, width: 1, background: COLORS.border }} />
                <div style={{ fontSize: 14, fontWeight: 600 }}>评测批次详情</div>
                {summary.autoWatch && <span style={badgeStyle('#E1F2EC', COLORS.success)}>自动观测</span>}
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 11, color: COLORS.textMuted }}>
                    发起时间：{fmtTime(summary.startedAt)}
                </span>
            </div>

            {error && <div style={infoBoxStyle(COLORS.danger, COLORS.dangerSubtle, '#FFD4D4')}>{error}</div>}

            {/* 批次概要卡 */}
            <div style={{
                background: 'linear-gradient(135deg, #FBFAF6 0%, #FFFFFF 100%)',
                border: `1px solid ${COLORS.border}`,
                borderRadius: 8,
                padding: 14,
                marginBottom: 14,
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                gap: 14,
            }}>
                <Stat label="执行 Agent" value={summary.executionAgent || '—'} mono primary />
                <Stat label="评估器" value={getEvaluatorDisplayNames(results)} />
                <Stat label="trace 总数" value={String(summary.total)} />
                <Stat label="评测进度"
                    value={`${summary.done} / ${summary.total}`}
                    detail={
                        <span style={{ fontSize: 10.5 }}>
                            <span style={{ color: COLORS.success }}>完成 {summary.done}</span>
                            {summary.running > 0 && <span style={{ color: '#1677ff' }}> · 进行中 {summary.running}</span>}
                            {summary.failed > 0 && <span style={{ color: COLORS.danger }}> · 失败 {summary.failed}</span>}
                        </span>
                    }
                />
                <Stat label="平均分"
                    value={summary.avg != null ? `${fmtScore10(summary.avg)} / 10` : '--'}
                    valueColor={summary.avg != null
                        ? (summary.avg >= 0.8 ? COLORS.success : summary.avg >= 0.5 ? COLORS.warning : COLORS.danger)
                        : COLORS.textDisabled}
                />
            </div>

            {/* trace 列表 */}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>本批次 trace 评测列表</div>
                <div style={{ fontSize: 11, color: COLORS.textMuted }}>点行查看单条 trace 的评测细节</div>
            </div>

            <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 9, overflow: 'hidden', background: '#fff' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                        <tr style={{ background: COLORS.bgSoft, borderBottom: `1px solid ${COLORS.border}` }}>
                            <th style={thStyle(170, 'left')}>TRACE ID</th>
                            <th style={thStyle(undefined, 'left')}>Trace 实际输入</th>
                            <th style={thStyle(undefined, 'left')}>Trace 实际输出</th>
                            <th style={thStyle(80, 'center')}>评测状态</th>
                            <th style={thStyle(60, 'right')}>得分</th>
                            <th style={thStyle(170, 'left')}>根因步骤</th>
                            <th style={thStyle(110, 'left')}>评测时间</th>
                        </tr>
                    </thead>
                    <tbody>
                        {results.map(r => {
                            const traceId = r.taskId || r.executionId || '';
                            const exec = execMap.get(traceId);
                            return (
                                <tr
                                    key={r.id}
                                    onClick={() =>
                                        traceId &&
                                        router.push(
                                            `/eval/trajectory/${encodeURIComponent(traceId)}?runId=${encodeURIComponent(runId)}&datasetId=${encodeURIComponent(r.datasetId)}`,
                                        )
                                    }
                                    style={{
                                        borderBottom: `1px solid ${COLORS.borderSoft}`,
                                        cursor: traceId ? 'pointer' : 'default',
                                    }}
                                    onMouseEnter={e => { if (traceId) e.currentTarget.style.background = COLORS.bgSoft; }}
                                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                                >
                                    <td style={{ ...tdStyle('left'), fontFamily: 'monospace', color: COLORS.textSecondary, whiteSpace: 'nowrap' }} title={traceId}>
                                        {formatTraceIdPreview(traceId)}
                                    </td>
                                    <td style={{ ...tdStyle('left'), maxWidth: 280 }} title={exec?.query || ''}>
                                        {exec ? (
                                            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {exec.query || '(空)'}
                                            </div>
                                        ) : (
                                            <span style={{ color: COLORS.textDisabled }}>(无 trace 输入)</span>
                                        )}
                                    </td>
                                    <td style={{ ...tdStyle('left'), maxWidth: 280 }} title={exec?.final_result || ''}>
                                        {exec ? (
                                            <>
                                                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                    {exec.final_result || '—'}
                                                </div>
                                                <div style={{ fontSize: 10, color: COLORS.textDisabled, marginTop: 2 }}>
                                                    {exec.framework} · {exec.model}
                                                </div>
                                            </>
                                        ) : (
                                            <span style={{ color: COLORS.textDisabled }}>(无 trace 元数据)</span>
                                        )}
                                    </td>
                                    <td style={tdStyle('center')}>
                                        <span style={{ color: getStatusColor(r), fontWeight: 600, fontSize: 11 }} title={r.errorMessage || r.resultEvaluationError || ''}>
                                            {getStatusLabel(r)}
                                        </span>
                                    </td>
                                    <td style={{ ...tdStyle('right'), color: getDisplayScore(r, exec) != null ? COLORS.primary : COLORS.textDisabled, fontWeight: 600 }}>
                                        {getDisplayScore(r, exec) != null ? `${fmtScore10(getDisplayScore(r, exec))} 分` : '--'}
                                    </td>
                                    <td style={{ ...tdStyle('left'), maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.rootCauseStep || ''}>
                                        {r.rootCauseStep || '—'}
                                    </td>
                                    <td style={{ ...tdStyle('left'), fontSize: 10.5, color: COLORS.textMuted }}>{fmtTime(r.createdAt)}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function Stat({
    label,
    value,
    detail,
    primary,
    mono,
    valueColor,
}: {
    label: string;
    value: string;
    detail?: React.ReactNode;
    primary?: boolean;
    mono?: boolean;
    valueColor?: string;
}) {
    return (
        <div>
            <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 3 }}>{label}</div>
            <div style={{
                fontSize: 14,
                fontWeight: 600,
                color: valueColor || (primary ? COLORS.text : COLORS.textSecondary),
                fontFamily: mono ? 'monospace' : undefined,
                lineHeight: 1.3,
            }}>
                {value}
            </div>
            {detail ? <div style={{ marginTop: 2 }}>{detail}</div> : null}
        </div>
    );
}

function btnSmallStyle(): CSSProperties {
    return {
        padding: '4px 10px',
        background: '#fff',
        color: COLORS.textSecondary,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 5,
        fontSize: 12,
        cursor: 'pointer',
    };
}

function badgeStyle(bg: string, color: string): CSSProperties {
    return {
        display: 'inline-block',
        padding: '2px 8px',
        background: bg,
        color,
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 500,
        whiteSpace: 'nowrap',
    };
}

function infoBoxStyle(color: string, bg: string, border: string): CSSProperties {
    return {
        padding: 10,
        marginBottom: 12,
        borderRadius: 6,
        background: bg,
        border: `1px solid ${border}`,
        color,
        fontSize: 12,
    };
}

function thStyle(width?: number, align: 'left' | 'right' | 'center' = 'left'): CSSProperties {
    return {
        padding: '8px 10px',
        textAlign: align,
        fontWeight: 500,
        color: COLORS.textMuted,
        fontSize: 11,
        ...(width ? { width } : {}),
    };
}

function tdStyle(align: 'left' | 'right' | 'center' = 'left'): CSSProperties {
    return {
        padding: '8px 10px',
        textAlign: align,
        verticalAlign: 'middle',
    };
}
