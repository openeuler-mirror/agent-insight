'use client';

/**
 * 轨迹评测详情视图（独立路由 panel，对齐 hifi p-eval-result-detail）
 *
 * 顶部：返回列表 + tid + 综合状态徽章
 * 综合评测结论卡（绿色渐变）
 * 分析 Tab：结果评测 / 轨迹评测 / 自定义评测
 *
 * 数据来源：
 *   - Execution（GET /api/observe/data?taskId=）
 *   - TrajectoryEvalResult（GET /api/eval/trajectory/results?taskId=）
 *   - Case（在 datasetId 给定时按 caseId 在 AgentEvalDataset.cases 中查找）
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { apiFetch } from '@/lib/client/api';
import { useAuth } from '@/lib/auth/auth-context';
import { EvaluatorFindingsView } from './EvaluatorFindingsView';

interface DatasetCase {
    id: string;
    input: string;
    expectedOutput: string;
    evaluationFocus: string;
    trajectory: string;
}

interface AgentDataset {
    id: string;
    name: string;
    description: string;
    targetAgent: string;
    datasetKind: string;
    cases: DatasetCase[];
    updatedAt: string;
}

interface ExecutionRecord {
    task_id?: string | null;
    upload_id?: string | null;
    timestamp?: string;
    framework?: string;
    model?: string;
    query?: string;
    final_result?: string;
    answer_score?: number | null;
    is_answer_correct?: boolean | null;
    judgment_reason?: string | null;
    judgmentReason?: string | null;
    latency?: number | null;
    cost?: number | null;
}

interface DimensionScores {
    completeness: number;
    toolChoice: number;
    redundancy: number;
    attribution: number;
}

interface TrajectoryDeviation {
    stepIndex: number;
    kind: string;
    name?: string;
    deviation: string;
    severity: 'low' | 'medium' | 'high';
}

interface ResultEvaluationFinding {
    content: string;
    covered?: boolean;
    severity?: 'low' | 'medium' | 'high';
    explanation?: string;
}

interface ResultEvaluationSummary {
    score: number | null;
    reason: string;
}

interface ResultEvaluationPayload {
    score: number | null;
    reason: string;
    findings: ResultEvaluationFinding[];
    hasStructuredFindings: boolean;
    errorMessage: string;
    actualOutput: string;
}

interface CustomEvaluationItem {
    evaluatorId: string;
    evaluatorName: string;
    score: number | null;
    reason: string;
    model?: string;
    durationMs?: number;
    error?: string;
}

interface CaseSnapshot {
    id?: string;
    input?: string;
    taskInput?: string;
    expectedOutput?: string;
    trajectory?: string;
    evaluationFocus?: string;
}

function parseLooseJsonText(text: string): Record<string, unknown> | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const candidate = fenced ? fenced[1] : trimmed;
    try {
        const parsed = JSON.parse(candidate);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        const first = candidate.indexOf('{');
        const last = candidate.lastIndexOf('}');
        if (first !== -1 && last !== -1 && last > first) {
            try {
                const parsed = JSON.parse(candidate.slice(first, last + 1));
                return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                    ? parsed as Record<string, unknown>
                    : null;
            } catch {
                return null;
            }
        }
        return null;
    }
}

function normalizeFindings(rawFindings: unknown): ResultEvaluationFinding[] {
    return (Array.isArray(rawFindings) ? rawFindings : [])
        .map(item => item && typeof item === 'object' ? item as Record<string, unknown> : null)
        .filter((item): item is Record<string, unknown> => Boolean(item))
        .map(item => ({
            content: String(item.content || '').trim(),
            covered: typeof item.covered === 'boolean' ? item.covered : undefined,
            severity: item.severity === 'high' || item.severity === 'medium' || item.severity === 'low'
                ? (item.severity as 'low' | 'medium' | 'high')
                : undefined,
            explanation: String(item.explanation || '').trim(),
        }))
        .filter(item => item.content || item.explanation);
}

function stripEmbeddedKeyPoints(reason: string): string {
    if (!reason) return '';
    const markerIndex = reason.indexOf('"key_point_findings"');
    if (markerIndex === -1) return reason.trim();
    return reason.slice(0, markerIndex).trim().replace(/[,{[]\s*$/g, '').trim();
}

interface TrajectoryResult {
    id: string;
    evaluatorRunId: string;
    selectedEvaluators?: string[];
    selectedEvaluatorNames?: string[];
    taskTitle?: string;
    taskDescription?: string;
    datasetId: string;
    caseId: string;
    executionId: string | null;
    taskId: string | null;
    status: 'pending' | 'running' | 'done' | 'failed';
    errorMessage: string | null;
    trajectoryScore: number | null;
    dimensionScores: DimensionScores | null;
    deviationSteps: TrajectoryDeviation[];
    rootCauseStep: string | null;
    reasonText: string | null;
    customEvaluationScore?: number | null;
    customEvaluations?: CustomEvaluationItem[];
    rawAnalysis?: unknown;
    createdAt: string;
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
const NO_EVALUABLE_CASE_PREFIX = '[no-evaluable-case]';

function fmtScore10(n: number | null | undefined): string {
    if (n === null || n === undefined || Number.isNaN(n)) return '--';
    return (n * 10).toFixed(1);
}

function isNoEvaluableCase(r?: Pick<TrajectoryResult, 'status' | 'errorMessage'> | null): boolean {
    return Boolean(r?.status === 'failed' && r.errorMessage?.includes(NO_EVALUABLE_CASE_PREFIX));
}

function isEvaluationTerminal(status?: TrajectoryResult['status'] | null): boolean {
    return status === 'done' || status === 'failed';
}

function deriveResultEvaluationPayload(
    execution: ExecutionRecord | null,
    rawAnalysis: unknown,
): ResultEvaluationPayload {
    const root = rawAnalysis && typeof rawAnalysis === 'object'
        ? rawAnalysis as {
            resultEvaluation?: {
                score?: unknown;
                reason?: unknown;
                key_point_summary?: unknown;
                key_point_findings?: unknown;
                raw_subagent_outputs?: { key_points?: { covered_points?: unknown } };
            };
            resultEvaluationError?: unknown;
            resultActualOutput?: unknown;
            score?: unknown;
            reason?: unknown;
            key_point_findings?: unknown;
            raw_subagent_outputs?: { key_points?: { covered_points?: unknown } };
        }
        : null;

    const directFindings = deriveResultEvaluationFindings(rawAnalysis);
    const parsedFromReason = parseLooseJsonText(
        String(execution?.judgment_reason || execution?.judgmentReason || ''),
    );
    const directFindingsRaw = root?.resultEvaluation?.key_point_findings
        ?? root?.key_point_findings
        ?? root?.resultEvaluation?.raw_subagent_outputs?.key_points?.covered_points
        ?? root?.raw_subagent_outputs?.key_points?.covered_points;
    const fallbackFindingsRaw = parsedFromReason?.key_point_findings
        ?? (parsedFromReason?.raw_subagent_outputs as { key_points?: { covered_points?: unknown } } | undefined)?.key_points?.covered_points;
    const fallbackFindings = normalizeFindings(
        fallbackFindingsRaw,
    );
    const findings = directFindings.length > 0 ? directFindings : fallbackFindings;
    const hasStructuredFindings = Array.isArray(directFindingsRaw) || Array.isArray(fallbackFindingsRaw);

    const scoreCandidates = [
        typeof root?.resultEvaluation?.score === 'number' ? root.resultEvaluation.score : null,
        typeof root?.score === 'number' ? root.score : null,
        execution?.answer_score,
        typeof parsedFromReason?.score === 'number' ? parsedFromReason.score : null,
    ];
    const score = scoreCandidates.find((item): item is number => typeof item === 'number' && !Number.isNaN(item)) ?? null;

    const reasonCandidates = [
        typeof root?.resultEvaluation?.reason === 'string' ? root.resultEvaluation.reason : '',
        typeof root?.resultEvaluation?.key_point_summary === 'string' ? root.resultEvaluation.key_point_summary : '',
        typeof root?.reason === 'string' ? root.reason : '',
        execution?.judgment_reason,
        execution?.judgmentReason,
        typeof parsedFromReason?.reason === 'string' ? parsedFromReason.reason : '',
    ];
    const reason = stripEmbeddedKeyPoints(String(reasonCandidates.find(item => String(item || '').trim()) || ''));
    const errorMessage = typeof root?.resultEvaluationError === 'string' ? root.resultEvaluationError.trim() : '';
    const actualOutput = String(
        typeof root?.resultActualOutput === 'string' ? root.resultActualOutput : '',
    ).trim();

    return { score, reason, findings, hasStructuredFindings, errorMessage, actualOutput };
}

function isResultEvaluationReady(payload: ResultEvaluationPayload, hasResultEvaluation: boolean): boolean {
    if (!hasResultEvaluation) return false;
    return typeof payload.score === 'number'
        && Boolean(payload.reason.trim())
        && payload.hasStructuredFindings;
}

function hasResultEvaluationFailed(payload: ResultEvaluationPayload): boolean {
    return Boolean(payload.errorMessage);
}

function cleanNoEvaluableCaseMessage(message?: string | null): string {
    return String(message || '没有可评测 case')
        .replace(/\[no-evaluable-case\]\s*/g, '')
        .trim();
}

function includesEvaluator(result: TrajectoryResult | null, evaluatorId: string): boolean {
    const selected = Array.isArray(result?.selectedEvaluators) ? result.selectedEvaluators : [];
    if (selected.length === 0) {
        return evaluatorId === 'preset-agent-trace-quality';
    }
    return selected.includes(evaluatorId);
}

function isCustomEvaluatorId(evaluatorId: string): boolean {
    return evaluatorId.startsWith('custom-');
}

function normalizeCustomEvaluations(value: unknown): CustomEvaluationItem[] {
    const rawItems = Array.isArray(value)
        ? value
        : value && typeof value === 'object'
        ? Object.values(value as Record<string, unknown>)
        : [];
    return rawItems
        .map(item => item && typeof item === 'object' ? item as Record<string, unknown> : null)
        .filter((item): item is Record<string, unknown> => Boolean(item))
        .map(item => ({
            evaluatorId: String(item.evaluatorId || '').trim(),
            evaluatorName: String(item.evaluatorName || item.evaluatorId || '自定义评估器').trim(),
            score: typeof item.score === 'number' && Number.isFinite(item.score) ? item.score : null,
            reason: String(item.reason || '').trim(),
            model: typeof item.model === 'string' ? item.model : undefined,
            durationMs: typeof item.durationMs === 'number' ? item.durationMs : undefined,
            error: typeof item.error === 'string' ? item.error : undefined,
        }))
        .filter(item => item.evaluatorId || item.evaluatorName);
}

function deriveResultEvaluationFindings(rawAnalysis: unknown): ResultEvaluationFinding[] {
    const root = rawAnalysis && typeof rawAnalysis === 'object'
        ? rawAnalysis as {
            resultEvaluation?: {
                key_point_findings?: unknown;
                raw_subagent_outputs?: { key_points?: { covered_points?: unknown } };
            };
            key_point_findings?: unknown;
            raw_subagent_outputs?: { key_points?: { covered_points?: unknown } };
        }
        : null;

    const rawFindings =
        Array.isArray(root?.resultEvaluation?.key_point_findings)
            ? root.resultEvaluation.key_point_findings
            : Array.isArray(root?.key_point_findings)
            ? root.key_point_findings
            : Array.isArray(root?.resultEvaluation?.raw_subagent_outputs?.key_points?.covered_points)
            ? root.resultEvaluation.raw_subagent_outputs.key_points.covered_points
            : Array.isArray(root?.raw_subagent_outputs?.key_points?.covered_points)
            ? root.raw_subagent_outputs.key_points.covered_points
            : [];
    return normalizeFindings(rawFindings);
}

function deriveCaseSnapshot(rawAnalysis: unknown): CaseSnapshot | null {
    const root = rawAnalysis && typeof rawAnalysis === 'object'
        ? rawAnalysis as { caseSnapshot?: unknown }
        : null;
    const snapshot = root?.caseSnapshot;
    return snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
        ? snapshot as CaseSnapshot
        : null;
}

function deriveResultEvaluationSummary(
    payload: ResultEvaluationPayload,
): ResultEvaluationSummary {
    return {
        score: payload.score,
        reason: payload.reason,
    };
}

export default function TrajectoryDetailView({ traceId }: { traceId: string }) {
    const { user } = useAuth();
    const router = useRouter();
    const params = useSearchParams();
    const datasetId = params?.get('datasetId') || '';
    const runId = params?.get('runId') || '';
    const autoWatchOnly = params?.get('autoWatchOnly') === '1' || params?.get('autoWatchOnly') === 'true';

    const [exec, setExec] = useState<ExecutionRecord | null>(null);
    const [result, setResult] = useState<TrajectoryResult | null>(null);
    const [dataset, setDataset] = useState<AgentDataset | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string>('');
    const [activeAnalysisTab, setActiveAnalysisTab] = useState<'result' | 'trajectory' | 'custom'>('result');

    // Execution（轮询，结果评测字段可能在轨迹评测过程中被补写）
    useEffect(() => {
        if (!user || !traceId) return;
        let stopped = false;
        const tick = async () => {
            try {
                const arr = await apiFetch(`/api/observe/data?user=${encodeURIComponent(user)}&taskId=${encodeURIComponent(traceId)}`)
                    .then(r => r.json());
                if (!stopped && Array.isArray(arr) && arr.length > 0) {
                    setExec(arr[0]);
                }
            } catch (e) {
                if (!stopped) setError(`加载执行记录失败：${(e as Error)?.message || e}`);
            }
        };
        tick();
        const t = setInterval(tick, POLL_MS);
        return () => {
            stopped = true;
            clearInterval(t);
        };
    }, [user, traceId]);

    // Trajectory result（轮询，因为可能 running）
    useEffect(() => {
        if (!user || !traceId) return;
        let stopped = false;
        const tick = async () => {
            try {
                const qs = new URLSearchParams({
                    user,
                    taskId: traceId,
                    limit: '10',
                });
                if (datasetId) qs.set('datasetId', datasetId);
                if (runId) qs.set('runId', runId);
                const url = `/api/eval/trajectory/results?${qs.toString()}`;
                const res = await apiFetch(url);
                const data = await res.json();
                const rows: TrajectoryResult[] = Array.isArray(data?.results) ? data.results : [];
                if (stopped) return;
                if (rows.length === 0) {
                    setResult(null);
                } else {
                    // 取最新一条；无论是否 done 都补拉详情，确保结果评测的结构化明细能及时显示
                    const sorted = [...rows].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
                    const top = sorted[0];
                    const det = await apiFetch(
                        `/api/eval/trajectory/results/${encodeURIComponent(top.id)}?user=${encodeURIComponent(user)}`,
                    ).then(r => r.json()).catch(() => null);
                    if (!stopped) {
                        setResult(det ? { ...top, ...det, rawAnalysis: det.rawAnalysis } : top);
                    }
                }
            } catch {
                /* ignore */
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
    }, [user, traceId, datasetId, runId]);

    const effectiveDatasetId = datasetId || result?.datasetId || '';

    // Dataset（用于查 case）
    useEffect(() => {
        if (!user || !effectiveDatasetId) return;
        apiFetch(`/api/agent-datasets/${encodeURIComponent(effectiveDatasetId)}?user=${encodeURIComponent(user)}`)
            .then(r => r.json())
            .then((d: AgentDataset) => {
                if (d && d.id) setDataset(d);
            })
            .catch(() => undefined);
    }, [user, effectiveDatasetId]);

    const caseEntry = useMemo<DatasetCase | null>(() => {
        if (!dataset) return null;
        if (result?.caseId) return dataset.cases.find(c => c.id === result.caseId) || null;
        return null;
    }, [dataset, result]);

    const noEvaluableCase = isNoEvaluableCase(result);
    const hasTraceEvaluation = includesEvaluator(result, 'preset-agent-trace-quality');
    const hasResultEvaluation = includesEvaluator(result, 'preset-agent-task-completion');
    const hasCustomEvaluation = (result?.selectedEvaluators || []).some(isCustomEvaluatorId);
    const customEvaluationFailed = hasCustomEvaluation && result?.status === 'failed' && Boolean(result.errorMessage);
    const customEvaluations = useMemo(
        () => normalizeCustomEvaluations(result?.customEvaluations ?? (result?.rawAnalysis as { customEvaluations?: unknown } | undefined)?.customEvaluations),
        [result?.customEvaluations, result?.rawAnalysis],
    );
    const customEvaluationScore = useMemo(() => {
        const scores = customEvaluations
            .map(item => item.score)
            .filter((score): score is number => typeof score === 'number' && Number.isFinite(score));
        return scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    }, [customEvaluations]);
    const resultEvaluationPayload = useMemo(
        () => deriveResultEvaluationPayload(exec, result?.rawAnalysis),
        [exec, result?.rawAnalysis],
    );
    const resultEvaluationSummary = useMemo(
        () => deriveResultEvaluationSummary(resultEvaluationPayload),
        [resultEvaluationPayload],
    );
    const resultEvaluationFindings = resultEvaluationPayload.findings;
    const resultEvaluationReady = isResultEvaluationReady(resultEvaluationPayload, hasResultEvaluation);
    const resultEvaluationFailed = hasResultEvaluationFailed(resultEvaluationPayload);
    const isMatchingCase = Boolean(result && !caseEntry && !isEvaluationTerminal(result.status));
    const caseSnapshot = useMemo(
        () => deriveCaseSnapshot(result?.rawAnalysis),
        [result?.rawAnalysis],
    );
    const taskInputValue = caseSnapshot?.taskInput?.trim()
        || caseSnapshot?.input?.trim()
        || (isEvaluationTerminal(result?.status) ? '(未提取到任务输入)' : '任务输入提取中…');
    const groundTruthValue = caseSnapshot?.expectedOutput?.trim()
        || (caseEntry
        ? (caseEntry.expectedOutput || '(case 未填 expectedOutput)')
        : isMatchingCase
        ? ''
        : noEvaluableCase
        ? cleanNoEvaluableCaseMessage(result?.errorMessage)
        : '');
    const groundTruthLabel = caseSnapshot?.expectedOutput?.trim()
        ? '预期结果 (Ground Truth · 来自本次评测快照)'
        : caseEntry
        ? '预期结果 (Ground Truth · 来自 case)'
        : '预期结果 (Ground Truth)';

    // 综合分数
    const composite = useMemo(() => {
        if (!isEvaluationTerminal(result?.status)) return null;
        if (noEvaluableCase) return null;
        const traj = hasTraceEvaluation ? result?.trajectoryScore : null;
        const r = hasResultEvaluation ? exec?.answer_score : null;
        const c = hasCustomEvaluation ? customEvaluationScore : null;
        const parts = [traj, r, c].filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
        return parts.length > 0 ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
    }, [result, exec, noEvaluableCase, hasTraceEvaluation, hasResultEvaluation, hasCustomEvaluation, customEvaluationScore]);

    const overallText =
        noEvaluableCase
            ? cleanNoEvaluableCaseMessage(result?.errorMessage)
            : composite == null
            ? '该执行尚未评测'
            : composite >= 0.8
            ? '该执行在结果与过程两个维度均表现良好'
            : composite >= 0.5
            ? '该执行结果基本可用，但过程存在偏离参考路径的问题'
            : '该执行偏离参考较大，建议优先排查';

    if (loading && !exec && !result) {
        return <div style={{ padding: 24 }}>加载中...</div>;
    }

    return (
        <div style={{ padding: '18px 22px 28px', maxWidth: 1480, margin: '0 auto', color: COLORS.text }}>
            {/* 顶部：返回 + tid + 状态 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <button
                    onClick={() => {
                        if (runId) {
                            const qs = new URLSearchParams({ runId });
                            if (autoWatchOnly) qs.set('autoWatchOnly', '1');
                            router.push(`/eval?${qs.toString()}`);
                        }
                        else if (datasetId) router.push(`/eval/trajectory?datasetId=${encodeURIComponent(datasetId)}`);
                        else router.push('/eval/trajectory');
                    }}
                    style={btnSmallStyle()}
                >
                    {`< ${runId ? '返回评测批次列表' : '返回列表'}`}
                </button>
                <span style={{ height: 14, width: 1, background: COLORS.border }} />
                <code style={{ fontSize: 13, color: COLORS.text, fontFamily: 'monospace' }}>{traceId}</code>
                <div style={{ flex: 1 }} />
                {exec ? (
                    <div style={{ fontSize: 11, color: COLORS.textMuted }}>
                        {exec.framework} · {exec.model} · {exec.timestamp ? new Date(exec.timestamp).toLocaleString('zh-CN', { hour12: false }) : ''}
                    </div>
                ) : null}
            </div>

            {error && <div style={infoBoxStyle(COLORS.danger, COLORS.dangerSubtle, '#FFD4D4')}>{error}</div>}

            <div
                style={{
                    background: 'linear-gradient(135deg, #FBFAF6 0%, #FFFFFF 100%)',
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 10,
                    padding: 16,
                    marginBottom: 16,
                }}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0, flex: '1 1 440px' }}>
                        <div style={{ fontSize: 12, color: COLORS.textMuted, marginBottom: 6 }}>评测任务</div>
                        <div style={{ fontSize: 22, fontWeight: 700, color: COLORS.text, lineHeight: 1.3 }}>
                            {result?.taskTitle || '评测执行'}
                        </div>
                        <div style={{ marginTop: 6, fontSize: 12.5, color: result?.taskDescription ? COLORS.textSecondary : COLORS.textDisabled, lineHeight: 1.65 }}>
                            {result?.taskDescription || ''}
                        </div>
                    </div>
                    <div style={{ display: 'grid', gap: 8, minWidth: 220 }}>
                        <SummaryPill
                            label="发起时间"
                            value={result?.createdAt ? new Date(result.createdAt).toLocaleString('zh-CN', { hour12: false }) : '—'}
                        />
                    </div>
                </div>
                <div
                    style={{
                        marginTop: 16,
                        paddingTop: 16,
                        borderTop: `1px solid ${COLORS.borderSoft}`,
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                        gap: 12,
                    }}
                >
                    <TopMetric label="运行模型" value={exec?.framework && exec?.model ? `${exec.framework} · ${exec.model}` : '—'} />
                    <TopMetric label="TRACE ID" value={traceId} mono />
                    <TopMetric label="结果评测" value={hasResultEvaluation ? '已开启' : '未开启'} />
                    <TopMetric label="轨迹评测" value={hasTraceEvaluation ? '已开启' : '未开启'} />
                    <TopMetric label="自定义评测" value={hasCustomEvaluation ? `${customEvaluations.length || '运行中'} 个` : '未开启'} />
                </div>
            </div>

            {/* 综合评测结论 */}
            <div style={{
                background: 'linear-gradient(135deg, #F0F7F4 0%, #FFFFFF 100%)',
                border: `1px solid #D1EAE2`,
                borderRadius: 8,
                padding: 14,
                marginBottom: 16,
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.success }}>综合评测结论</span>
                    {composite != null && (
                        <>
                            <span style={{ flex: 1 }} />
                            <span style={{ fontWeight: 700, color: COLORS.success, fontSize: 18 }}>
                                {fmtScore10(composite)} <span style={{ fontSize: 11, color: COLORS.textMuted, fontWeight: 400 }}>/ 10</span>
                            </span>
                        </>
                    )}
                </div>
                <div style={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6 }}>
                    {overallText}
                    {result?.rootCauseStep ? (
                        <>
                            {' · '}
                            根因步骤：<code style={{ background: '#fff', padding: '1px 4px', border: '1px solid #D1EAE2', borderRadius: 3 }}>{result.rootCauseStep}</code>
                        </>
                    ) : null}
                </div>
            </div>

            <div style={{ display: 'flex', gap: 0, borderBottom: `1px solid ${COLORS.border}`, marginBottom: 14 }}>
                <AnalysisTabButton
                    active={activeAnalysisTab === 'result'}
                    label="结果评测"
                    onClick={() => setActiveAnalysisTab('result')}
                />
                <AnalysisTabButton
                    active={activeAnalysisTab === 'trajectory'}
                    label="轨迹评测"
                    onClick={() => setActiveAnalysisTab('trajectory')}
                />
                <AnalysisTabButton
                    active={activeAnalysisTab === 'custom'}
                    label="自定义评测"
                    onClick={() => setActiveAnalysisTab('custom')}
                />
            </div>

            <div>
                {/* 左：结果评测 */}
                {activeAnalysisTab === 'result' && (
                <div>
                    <div style={cardStyle()}>
                        <FieldBlock label="任务输入" value={taskInputValue} />
                        <FieldBlock
                            label={groundTruthLabel}
                            value={groundTruthValue}
                        />
                        <FieldBlock
                            label="任务输出"
                            value={resultEvaluationPayload.actualOutput}
                        />
                        <Divider />
                        {!hasResultEvaluation ? (
                            <div style={{ color: COLORS.textMuted, fontSize: 12, paddingTop: 8 }}>
                                本次未选择 Agent 任务完成度评估器。
                            </div>
                        ) : resultEvaluationFailed ? (
                            <div style={{
                                color: COLORS.danger,
                                fontSize: 12,
                                padding: 10,
                                marginTop: 8,
                                background: COLORS.dangerSubtle,
                                border: `1px solid ${COLORS.border}`,
                                borderRadius: 6,
                                lineHeight: 1.6,
                            }}>
                                {resultEvaluationPayload.errorMessage}
                            </div>
                        ) : !resultEvaluationReady ? (
                            <div style={{ color: COLORS.textMuted, fontSize: 12, paddingTop: 8 }}>
                                结果评测进行中…任务完成度得分、原因、关键观点会在结果评估器产出完整结果后一起显示。
                            </div>
                        ) : noEvaluableCase ? (
                            <div style={{ color: COLORS.textMuted, fontSize: 12, paddingTop: 8 }}>
                                {cleanNoEvaluableCaseMessage(result?.errorMessage)}
                            </div>
                        ) : (
                            <>
                                <ScoreLine
                                    label="任务完成度得分"
                                    value={resultEvaluationSummary.score == null ? '--' : `${fmtScore10(resultEvaluationSummary.score)} / 10`}
                                    tone={
                                        resultEvaluationSummary.score == null
                                            ? 'muted'
                                            : resultEvaluationSummary.score >= 0.8
                                            ? 'success'
                                            : resultEvaluationSummary.score >= 0.5
                                            ? 'warning'
                                            : 'danger'
                                    }
                                />
                                <div style={{ marginTop: 8 }}>
                                    <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 6 }}>原因</div>
                                    <div style={{
                                        fontSize: 11,
                                        padding: 10,
                                        background: COLORS.bgSoft,
                                        border: `1px solid ${COLORS.borderSoft}`,
                                        borderRadius: 4,
                                        whiteSpace: 'pre-wrap',
                                        wordBreak: 'break-word',
                                        maxHeight: 240,
                                        overflow: 'auto',
                                        color: COLORS.textSecondary,
                                    }}>
                                        {resultEvaluationSummary.reason || '结果评测进行中...'}
                                    </div>
                                </div>
                                {resultEvaluationFindings.length > 0 && (
                                    <div style={{ marginTop: 12 }}>
                                        <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 6 }}>关键观点评测</div>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                            {resultEvaluationFindings.map((item, index) => {
                                                const severity = item.severity || (item.covered ? 'low' : 'high');
                                                const tone =
                                                    severity === 'high' ? COLORS.danger : severity === 'medium' ? COLORS.warning : COLORS.success;
                                                const bg =
                                                    severity === 'high' ? COLORS.dangerSubtle : severity === 'medium' ? COLORS.warningSubtle : COLORS.successSubtle;
                                                return (
                                                    <div key={index} style={{ padding: '8px 10px', border: `1px solid ${COLORS.border}`, borderRadius: 5, background: '#fff' }}>
                                                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                                                            <span style={{ fontSize: 11, fontWeight: 600, color: COLORS.textSecondary }}>
                                                                {item.content || `关键观点 #${index + 1}`}
                                                            </span>
                                                            <span style={{ ...badgeStyle(bg, tone, true), fontSize: 9 }}>
                                                                {item.covered ? '已覆盖' : '未覆盖'}
                                                            </span>
                                                        </div>
                                                        <div style={{ fontSize: 11, color: COLORS.textSecondary, lineHeight: 1.55 }}>
                                                            {item.explanation || '未返回额外说明'}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </div>
                )}

                {/* 右：轨迹评测 */}
                {activeAnalysisTab === 'trajectory' && (
                <div>
                    <div style={cardStyle()}>
                        {!hasTraceEvaluation ? (
                            <div style={{ color: COLORS.textMuted, fontSize: 12, padding: 12, textAlign: 'center' }}>
                                本次未选择 Agent 轨迹质量评估器。
                            </div>
                        ) : !result || result.status !== 'done' ? (
                            <div style={{ padding: 12 }}>
                                <div style={{ color: COLORS.textMuted, fontSize: 12, textAlign: 'center', marginBottom: 12 }}>
                                    {noEvaluableCase
                                        ? cleanNoEvaluableCaseMessage(result?.errorMessage)
                                        : result?.status === 'failed'
                                        ? `评测失败：${result.errorMessage || '未知错误'}`
                                        : result?.status === 'running' || result?.status === 'pending'
                                        ? '评测进行中…（每 3s 自动刷新）'
                                        : '该 trace 尚未由轨迹评估器评测。'}
                                </div>
                                {/* 即使没有/失败的情况下也允许就地重新触发评估器，避免用户必须回 batch 列表 */}
                                {(!result || result.status === 'failed') && !noEvaluableCase && (
                                    <RerunTrajectoryEvalButton
                                        taskId={traceId}
                                        user={user}
                                        onTriggered={() => { /* 轮询会自动接管 */ }}
                                        compact
                                    />
                                )}
                            </div>
                        ) : (
                            <>
                                <div style={{ marginBottom: 12 }}>
                                    <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 6 }}>执行路径分析 (LLM-as-Judge)</div>
                                    <div
                                        className="trajectory-reason-md"
                                        style={{
                                            fontSize: 12,
                                            padding: 12,
                                            background: '#f4f9f6',
                                            border: '1px solid #d1eae2',
                                            borderRadius: 5,
                                            color: COLORS.textSecondary,
                                            lineHeight: 1.7,
                                            maxHeight: 320,
                                            overflow: 'auto',
                                        }}
                                    >
                                        {result.reasonText ? (
                                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                                {result.reasonText}
                                            </ReactMarkdown>
                                        ) : (
                                            <span style={{ color: COLORS.textDisabled }}>(无 reasonText)</span>
                                        )}
                                    </div>
                                </div>

                                {result.dimensionScores && (() => {
                                    const findings = deriveDimensionFindings(result.rawAnalysis);
                                    return (
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8, marginBottom: 12 }}>
                                            <DimensionCard label="完整性" score={result.dimensionScores.completeness} findings={findings.completeness} />
                                            <DimensionCard label="工具选择" score={result.dimensionScores.toolChoice} findings={findings.toolChoice} />
                                            <DimensionCard label="冗余" score={result.dimensionScores.redundancy} findings={findings.redundancy} />
                                            <DimensionCard label="归因" score={result.dimensionScores.attribution} findings={findings.attribution} />
                                        </div>
                                    );
                                })()}

                                {result.deviationSteps && result.deviationSteps.length > 0 && (
                                    <div>
                                        <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 6 }}>偏离步骤</div>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                            {result.deviationSteps.map((d, i) => {
                                                const tone =
                                                    d.severity === 'high' ? COLORS.danger : d.severity === 'medium' ? COLORS.warning : COLORS.textMuted;
                                                const bg =
                                                    d.severity === 'high' ? COLORS.dangerSubtle : d.severity === 'medium' ? COLORS.warningSubtle : COLORS.bgSoft;
                                                return (
                                                    <div key={i} style={{ padding: '6px 8px', border: `1px solid ${COLORS.border}`, borderRadius: 5, background: '#fff' }}>
                                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                                                            <span style={{ fontSize: 11, fontWeight: 600 }}>
                                                                步骤 #{d.stepIndex} · {d.kind}{d.name ? ` (${d.name})` : ''}
                                                            </span>
                                                            <span style={{ ...badgeStyle(bg, tone, true), fontSize: 9 }}>{d.severity}</span>
                                                        </div>
                                                        <div style={{ fontSize: 11, color: COLORS.textSecondary, lineHeight: 1.5 }}>{d.deviation}</div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}

                                {/* 评估器识别的 4 类 Skill 归因问题（路径偏离 / 关键动作 / 工具选择 / 结果问题，
                                    每条带 is_skill_attributable 徽章 + improvement_suggestion）。
                                    从原 skill-eval 页 TrajectoryEvaluatorFindings 抽过来，让 batch 评测入口
                                    点"评测结果"就能直接看到——不用再跳走到旧的轨迹分析视图。 */}
                                <div style={{ marginTop: 14 }}>
                                    <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 6 }}>
                                        评估器识别的 Skill 归因问题
                                    </div>
                                    <EvaluatorFindingsView row={result} />
                                </div>

                                {/* 重新跑归因评估按钮 —— 用户在详情页看到结果过时/不完整时可以就地重新触发，
                                    避免必须回 batch 列表才能重跑（对应方案 A：保留单条 trace 重新归因入口）。 */}
                                <RerunTrajectoryEvalButton
                                    taskId={traceId}
                                    user={user}
                                    onTriggered={() => { /* 拉刷会通过外层轮询自动接管 */ }}
                                />

                                {/* 主入口：跳到链路观测查看被评测的实际 trace */}
                                <button
                                    type="button"
                                    onClick={() => {
                                        const qs: string[] = [];
                                        if (runId) qs.push(`runId=${encodeURIComponent(runId)}`);
                                        if (effectiveDatasetId) qs.push(`datasetId=${encodeURIComponent(effectiveDatasetId)}`);
                                        if (autoWatchOnly) qs.push('autoWatchOnly=1');
                                        const suffix = qs.length > 0 ? `?${qs.join('&')}` : '';
                                        router.push(`/eval/trajectory/${encodeURIComponent(traceId)}/trace${suffix}`);
                                    }}
                                    style={{
                                        marginTop: 12,
                                        width: '100%',
                                        padding: '10px 12px',
                                        background: COLORS.primarySubtle,
                                        color: COLORS.primary,
                                        border: `1px solid #D6D2F2`,
                                        borderRadius: 6,
                                        fontSize: 12.5,
                                        fontWeight: 500,
                                        cursor: 'pointer',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                    }}
                                >
                                    <span>前往链路观测 · 查看实际执行 trace 的步骤树</span>
                                    <span style={{ fontSize: 14 }}>→</span>
                                </button>

                            </>
                        )}
                    </div>
                </div>
                )}

                {activeAnalysisTab === 'custom' && (
                <div>
                    <div style={cardStyle()}>
                        {!hasCustomEvaluation ? (
                            <div style={{ color: COLORS.textMuted, fontSize: 12, padding: 12, textAlign: 'center' }}>
                                本次未选择自定义评估器。
                            </div>
                        ) : customEvaluationFailed ? (
                            <div style={{ color: COLORS.danger, background: COLORS.dangerSubtle, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: 12, fontSize: 12, lineHeight: 1.6 }}>
                                {cleanNoEvaluableCaseMessage(result?.errorMessage)}
                            </div>
                        ) : customEvaluations.length === 0 ? (
                            <div style={{ color: COLORS.textMuted, fontSize: 12, padding: 12, textAlign: 'center' }}>
                                自定义评测进行中…多个自定义评估器会在这里分别展示。
                            </div>
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                {customEvaluations.map((item, index) => {
                                    return (
                                        <div key={`${item.evaluatorId || item.evaluatorName}-${index}`} style={{ border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: 12, background: '#fff' }}>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
                                                <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.text }}>{item.evaluatorName}</div>
                                                <span style={{
                                                    ...badgeStyle(
                                                        item.score == null
                                                            ? COLORS.bgSoft
                                                            : item.score >= 0.8
                                                                ? COLORS.successSubtle
                                                                : item.score >= 0.5
                                                                    ? COLORS.warningSubtle
                                                                    : COLORS.dangerSubtle,
                                                        item.score == null
                                                            ? COLORS.textMuted
                                                            : item.score >= 0.8
                                                                ? COLORS.success
                                                                : item.score >= 0.5
                                                                    ? COLORS.warning
                                                                    : COLORS.danger,
                                                        true,
                                                    ),
                                                    minHeight: 30,
                                                    fontSize: 13,
                                                    display: 'inline-flex',
                                                    alignItems: 'center',
                                                }}>
                                                    分数 {item.score == null ? '--' : `${fmtScore10(item.score)} / 10`}
                                                </span>
                                            </div>
                                            {item.error ? (
                                                <div style={{ color: COLORS.danger, background: COLORS.dangerSubtle, border: `1px solid ${COLORS.border}`, borderRadius: 5, padding: 10, fontSize: 12, lineHeight: 1.6 }}>
                                                    {item.error}
                                                </div>
                                            ) : (
                                                <div>
                                                    <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 6 }}>原因</div>
                                                    <div style={{
                                                        fontSize: 12,
                                                        padding: 10,
                                                        background: COLORS.bgSoft,
                                                        border: `1px solid ${COLORS.borderSoft}`,
                                                        borderRadius: 4,
                                                        whiteSpace: 'pre-wrap',
                                                        wordBreak: 'break-word',
                                                        color: COLORS.textSecondary,
                                                        lineHeight: 1.65,
                                                    }}>
                                                        {item.reason || '该评估器未返回原因。'}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
                )}
            </div>
        </div>
    );
}

// ──────────── 工具组件 ────────────

function FieldBlock({ label, value }: { label: string; value: string }) {
    return (
        <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 4 }}>{label}</div>
            <div style={{
                fontSize: 11.5,
                background: COLORS.bgSoft,
                padding: 8,
                borderRadius: 4,
                border: `1px solid ${COLORS.borderSoft}`,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: 160,
                overflow: 'auto',
                color: COLORS.textSecondary,
                minHeight: 18,
            }}>
                {value}
            </div>
        </div>
    );
}

function ScoreLine({ label, value, tone }: { label: string; value: string; tone: 'success' | 'warning' | 'danger' | 'muted' }) {
    const color =
        tone === 'success' ? COLORS.success : tone === 'warning' ? COLORS.warning : tone === 'danger' ? COLORS.danger : COLORS.textMuted;
    const bg =
        tone === 'success' ? COLORS.successSubtle : tone === 'warning' ? COLORS.warningSubtle : tone === 'danger' ? COLORS.dangerSubtle : COLORS.bgSoft;
    return (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
            <span style={{ fontSize: 11.5, color: COLORS.textMuted }}>{label}</span>
            <span style={badgeStyle(bg, color, true)}>{value}</span>
        </div>
    );
}

function SummaryPill({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
    return (
        <div style={{ padding: '8px 10px', borderRadius: 8, background: '#fff', border: `1px solid ${COLORS.border}` }}>
            <div style={{ fontSize: 10.5, color: COLORS.textMuted, marginBottom: 3 }}>{label}</div>
            <div
                style={{
                    fontSize: 12,
                    color: COLORS.textSecondary,
                    fontFamily: mono ? 'monospace' : undefined,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                }}
                title={value}
            >
                {value}
            </div>
        </div>
    );
}

function TopMetric({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
    return (
        <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 4 }}>{label}</div>
            <div
                style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: COLORS.textSecondary,
                    fontFamily: mono ? 'monospace' : undefined,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                }}
                title={value}
            >
                {value}
            </div>
        </div>
    );
}

function Divider() {
    return <div style={{ height: 1, background: COLORS.borderSoft, margin: '10px 0' }} />;
}

/**
 * 单条 trace 的"重新跑归因评估"触发按钮。
 *
 * 直接调 POST /api/eval/trajectory/run，taskIds=[taskId] + evaluators=['preset-agent-trace-quality']。
 * 评测启动后写一行 TrajectoryEvalResult；外层 TrajectoryDetailView 的 3s 轮询会自动接管
 * 状态从 pending → running → done 的更新。
 *
 * 用途（方案 A）：用户在评测详情页发现结果过时或没跑过 → 就地重新触发，不用回 batch 列表。
 * 跟原 TraceDeviationPanel 里的 startTrajectoryEval 行为一致；从那里抽出来共用。
 */
function RerunTrajectoryEvalButton({
    taskId,
    user,
    onTriggered,
    compact = false,
}: {
    taskId: string;
    user: string | null;
    onTriggered?: () => void;
    compact?: boolean;
}) {
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState('');

    const trigger = async () => {
        if (!taskId || !user) return;
        setStarting(true);
        setError('');
        try {
            const res = await apiFetch('/api/eval/trajectory/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user,
                    taskIds: [taskId],
                    // 单 trace 兜底归因走轨迹质量评估器；它内部有空 case fallback
                    // (没 reference trajectory 时用 SKILL.md key actions)。
                    // 不带 task-completion 是因为它强依赖 expectedOutput——见
                    // src/lib/engine/evaluation/opencode-trajectory-evaluator.ts 注释。
                    evaluators: ['preset-agent-trace-quality'],
                }),
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.error || '启动评估失败');
            }
            onTriggered?.();
        } catch (e) {
            setError(e instanceof Error ? e.message : '启动评估失败');
        } finally {
            setStarting(false);
        }
    };

    return (
        <div style={{ marginTop: compact ? 0 : 12 }}>
            <button
                type="button"
                onClick={trigger}
                disabled={starting || !user}
                style={{
                    width: '100%',
                    padding: '8px 12px',
                    background: starting ? COLORS.bgSoft : COLORS.successSubtle,
                    color: COLORS.success,
                    border: `1px solid #BDE3D2`,
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: starting || !user ? 'not-allowed' : 'pointer',
                    opacity: starting || !user ? 0.6 : 1,
                }}
            >
                {starting
                    ? '正在启动评估…'
                    : compact
                    ? '↻ 触发归因评估'
                    : '↻ 重新跑归因评估（评估器会重新分析这条 trace）'}
            </button>
            {error && (
                <div
                    style={{
                        marginTop: 6,
                        padding: '6px 10px',
                        background: COLORS.dangerSubtle,
                        color: COLORS.danger,
                        border: `1px solid #F5CFCF`,
                        borderRadius: 4,
                        fontSize: 11,
                    }}
                >
                    {error}
                </div>
            )}
        </div>
    );
}

function AnalysisTabButton({
    active,
    label,
    onClick,
}: {
    active: boolean;
    label: string;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            style={{
                display: 'flex',
                alignItems: 'center',
                padding: '10px 18px',
                border: 'none',
                borderBottom: active ? `3px solid ${COLORS.success}` : '3px solid transparent',
                background: active ? '#fff' : 'transparent',
                color: active ? COLORS.text : COLORS.textMuted,
                fontSize: 14,
                fontWeight: 650,
                cursor: 'pointer',
            }}
        >
            <span>{label}</span>
        </button>
    );
}

/**
 * 维度卡片：分数 + 进度条；点击头部展开看 subagent 具体发现（默认折叠）
 */
function DimensionCard({
    label,
    score,
    findings,
}: {
    label: string;
    score: number;
    findings?: { type: 'high' | 'medium' | 'low' | 'info'; text: string }[];
}) {
    const [expanded, setExpanded] = useState(false);
    const tone = score >= 0.8 ? COLORS.success : score >= 0.5 ? COLORS.warning : COLORS.danger;
    const bg = score >= 0.8 ? COLORS.successSubtle : score >= 0.5 ? COLORS.warningSubtle : COLORS.dangerSubtle;
    const findingCount = findings?.length || 0;
    const hasFindings = findingCount > 0;
    return (
        <div style={{
            border: `1px solid ${COLORS.border}`,
            borderRadius: 6,
            padding: 10,
            background: '#fff',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
        }}>
            <button
                type="button"
                onClick={() => hasFindings && setExpanded(v => !v)}
                disabled={!hasFindings}
                style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    cursor: hasFindings ? 'pointer' : 'default',
                    width: '100%',
                    textAlign: 'left',
                }}
                aria-expanded={expanded}
            >
                <span style={{ fontSize: 11.5, color: COLORS.textMuted, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4 }}>
                    {hasFindings ? (
                        <span style={{
                            display: 'inline-block',
                            width: 8,
                            transition: 'transform 0.15s',
                            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                            color: COLORS.textDisabled,
                        }}>›</span>
                    ) : null}
                    {label}
                    {hasFindings ? (
                        <span style={{ color: COLORS.textDisabled, fontSize: 10, fontWeight: 400 }}>
                            ({findingCount})
                        </span>
                    ) : null}
                </span>
                <span>
                    <span style={{ fontSize: 14, fontWeight: 600, color: tone }}>{fmtScore10(score)}</span>
                    <span style={{ fontSize: 9, color: COLORS.textDisabled, marginLeft: 2 }}>/10</span>
                </span>
            </button>
            <div style={{ height: 3, background: bg, borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ width: `${Math.round(score * 100)}%`, height: '100%', background: tone }} />
            </div>
            {expanded && hasFindings ? (
                <ul style={{
                    margin: 0,
                    padding: 0,
                    listStyle: 'none',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                    maxHeight: 160,
                    overflowY: 'auto',
                }}>
                    {findings!.map((f, i) => {
                        const dotColor =
                            f.type === 'high' ? COLORS.danger
                            : f.type === 'medium' ? COLORS.warning
                            : f.type === 'low' ? COLORS.textMuted
                            : COLORS.primary;
                        return (
                            <li key={i} style={{ display: 'flex', gap: 6, fontSize: 11, lineHeight: 1.5, color: COLORS.textSecondary }}>
                                <span style={{
                                    flexShrink: 0,
                                    width: 5,
                                    height: 5,
                                    borderRadius: '50%',
                                    background: dotColor,
                                    marginTop: 6,
                                }} />
                                <span>{f.text}</span>
                            </li>
                        );
                    })}
                </ul>
            ) : null}
        </div>
    );
}

/**
 * 把 rawAnalysis.raw_subagent_outputs 派生成 4 张卡片各自的 findings 列表。
 * 任何字段缺失都安全降级为空数组。
 */
function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function deriveDimensionFindings(rawAnalysis: unknown): {
    completeness: { type: 'high' | 'medium' | 'low' | 'info'; text: string }[];
    toolChoice: { type: 'high' | 'medium' | 'low' | 'info'; text: string }[];
    redundancy: { type: 'high' | 'medium' | 'low' | 'info'; text: string }[];
    attribution: { type: 'high' | 'medium' | 'low' | 'info'; text: string }[];
} {
    const root = asRecord(rawAnalysis);
    const sub = asRecord(root.raw_subagent_outputs ?? root.rawSubagentOutputs);
    const sev = (s: unknown): 'high' | 'medium' | 'low' | 'info' => {
        const v = String(s || '').toLowerCase();
        if (v === 'high') return 'high';
        if (v === 'low') return 'low';
        if (v === 'info') return 'info';
        return 'medium';
    };

    const completeness: { type: ReturnType<typeof sev>; text: string }[] = [];
    const cmpt = asRecord(sub.completeness);
    for (const raw of (Array.isArray(cmpt.missing_steps) ? cmpt.missing_steps : [])) {
        const m = asRecord(raw);
        completeness.push({ type: sev(m.severity), text: `缺失：${m.description || '(未给描述)'}` });
    }
    for (const raw of (Array.isArray(cmpt.extra_steps) ? cmpt.extra_steps : [])) {
        const m = asRecord(raw);
        const idx = m.step_index ?? m.stepIndex;
        completeness.push({ type: sev(m.severity), text: `多余${idx != null ? `（#${idx}）` : ''}：${m.description || '(未给描述)'}` });
    }
    if (completeness.length === 0 && cmpt.explanation) {
        completeness.push({ type: 'info', text: String(cmpt.explanation) });
    }

    const toolChoice: { type: ReturnType<typeof sev>; text: string }[] = [];
    const tc = asRecord(sub.tool_choice ?? sub.toolChoice);
    for (const raw of (Array.isArray(tc.problematic_steps) ? tc.problematic_steps : [])) {
        const m = asRecord(raw);
        const idx = m.step_index ?? m.stepIndex;
        const name = m.name ? ` ${m.name}` : '';
        toolChoice.push({ type: sev(m.severity), text: `#${idx ?? '?'}${name}：${m.issue || '(未给原因)'}` });
    }
    if (toolChoice.length === 0 && tc.explanation) {
        toolChoice.push({ type: 'info', text: String(tc.explanation) });
    }

    const redundancy: { type: ReturnType<typeof sev>; text: string }[] = [];
    const rd = asRecord(sub.redundancy);
    for (const raw of (Array.isArray(rd.consecutive_same_runs) ? rd.consecutive_same_runs : [])) {
        const r = asRecord(raw);
        const name = r.name || '?';
        const count = r.count ?? '?';
        const from = r.from ?? '?';
        const to = r.to ?? '?';
        redundancy.push({ type: 'high', text: `连续重复：${name} ×${count}（步骤 #${from}–#${to}）` });
    }
    for (const raw of (Array.isArray(rd.heavy_repeated_calls) ? rd.heavy_repeated_calls : [])) {
        const r = asRecord(raw);
        redundancy.push({ type: 'medium', text: `高频调用：${r.call || '?'} 共 ${r.count ?? '?'} 次` });
    }
    if (redundancy.length === 0) {
        const totalToolCalls = typeof rd.total_tool_calls === 'number' ? rd.total_tool_calls : 0;
        const totalSkillCalls = typeof rd.total_skill_calls === 'number' ? rd.total_skill_calls : 0;
        const tot = totalToolCalls + totalSkillCalls;
        redundancy.push({ type: 'info', text: `无连续重复 / 高频调用（共 ${tot} 次工具/Skill 调用）` });
    }

    const attribution: { type: ReturnType<typeof sev>; text: string }[] = [];
    const at = asRecord(sub.attribution);
    if (at.root_cause_step) {
        attribution.push({ type: 'high', text: `根因：${at.root_cause_step}` });
    }
    if (at.reasoning) {
        attribution.push({ type: 'info', text: String(at.reasoning) });
    }
    if (attribution.length === 0) {
        attribution.push({ type: 'info', text: '归因子代理未输出明确根因' });
    }

    return { completeness, toolChoice, redundancy, attribution };
}

function badgeStyle(bg: string, color: string, small?: boolean): CSSProperties {
    return {
        display: 'inline-block',
        padding: small ? '1px 6px' : '2px 8px',
        background: bg,
        color,
        borderRadius: 4,
        fontSize: small ? 10 : 11,
        fontWeight: 500,
        whiteSpace: 'nowrap',
    };
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
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
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

function cardStyle(): CSSProperties {
    return {
        padding: 14,
        background: '#fff',
        border: `1px solid ${COLORS.border}`,
        borderRadius: 8,
    };
}
