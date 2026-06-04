'use client';

/* eslint-disable react-hooks/set-state-in-effect */

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import { isInternalSystemAgentTrace, shouldHideFromCaseAnalysis, classifyTraceSource } from '@/lib/system-agent-names';
import {
    buildFallbackDiagnosis,
    type DiagnosisDimensionKey,
    type DiagnosisDimensionStatus,
    type SkillDiagnosisResult,
    type SkillDiagnosisSnapshot,
} from '@/lib/skill-analysis/diagnosis';
import { calculateAbScoring, type AbScoringResult } from '@/lib/skill-analysis/ab-scoring';
import { NewEvaluationBatchDialog, type NewBatchCreated } from '@/components/eval/NewEvaluationBatchDialog';
import { formatPValueLabel, welchTTestPValue } from '@/lib/skill-analysis/ab-significance';
import { BatchEvaluation } from './_batch/page';
import { GrayscaleEvaluation } from './grayscale/page';
import { presetEvaluators } from '@/lib/evaluators/preset-evaluators';
import { ConfigMultiSelect } from '@/components/skills/ConfigMultiSelect';
import { ExecutionRecordsTable, type EvalRecordRow } from '@/components/eval/ExecutionRecordsTable';
import { EvalTaskPicker } from '@/components/eval/EvalTaskPicker';
import { useBatchEvalResults } from '@/components/eval/useBatchEvalResults';
import {
    EvaluationContent,
    SectionShell,
    FindingsGrouped,
    STATIC_EVAL_STANDARDS,
    type EvaluationDetail,
    type FindingItem,
    type FindingGroup,
} from '@/components/evaluation';
import { toast } from 'sonner';
import { Info } from 'lucide-react';
import { Term } from '@/components/text/Term';
import './debug.css';
import './skill-analysis.css';
import '@/components/evaluation/evaluation-content.css';

type AnalysisView = 'overview' | 'trace' | 'static' | 'gray';
type Severity = 'high' | 'medium' | 'low';
const AB_WEIGHT_LABEL = '40%';

/**
 * 触发分析摘要（"触发分析"卡 + Smart Run 行的数据源）。
 *
 * 由 GET /api/skill-eval/trigger/<name> + GET /api/skill-eval/trigger/<name>/runs?latestOnly=true
 * 合并而来；完整的编辑/评测能力收口在 /skill-eval/trigger/<name>。
 */
interface TriggerSummary {
    hasSet: boolean;
    itemCount: number;
    positiveCount: number;
    /** 最近一次 done 状态的 run，没有则 null */
    latestRun: null | {
        id?: string;
        passRate: number;
        truePositiveRate: number;
        falsePositiveRate: number;
        skillVersion: number;
        ranAt: string;
    };
}

interface SkillOption {
    id: string;
    name: string;
    description?: string;
    category?: string;
    activeVersion?: number;
    version?: number;
    updatedAt?: string;
    versions?: Array<{ id?: string; version: number; createdAt?: string; changeLog?: string }>;
}

interface InvokedSkillRef {
    name?: string | null;
    version?: number | null;
}

interface TraceRecord {
    upload_id?: string;
    task_id?: string;
    query?: string;
    skill?: string | null;
    rootSkill?: InvokedSkillRef | null;
    root_skill?: InvokedSkillRef | null;
    skill_version?: number | null;
    skillVersion?: number | null;
    skills?: unknown;
    invokedSkills?: InvokedSkillRef[];
    invoked_skills?: InvokedSkillRef[];
    timestamp?: string;
    timeCost?: string;
    framework?: string;
    model?: string;
    /** API 返回的 agent 显示名，可能为 'skill-generator-agent' / 'grayscale-baseline-agent' /
     * 'skill-trigger-analyzer' 等内部 agent，或者真实用户 agent 名。
     * 用例分析列表用这个字段过滤掉系统内部 trace（详见 isInternalSystemAgentTrace）。 */
    agent?: string | null;
    agentName?: string | null;
    trajectoryScore?: number | null;
    /** 方案A: 后端聚合层算出的统一轨迹分(0-1)，来源最近一次 TrajectoryEvalResult.trajectoryScore。 */
    trajectory_score?: number | null;
    /** 结果分析（任务完成度评估器）评分，0-1，来源 Execution.answerScore */
    answer_score?: number | null;
    answerScore?: number | null;
    is_evaluating?: boolean;
    /** 最近一次 TrajectoryEvalResult.status: pending/running/done/failed | null (从未评测过) */
    last_eval_status?: string | null;
    /** 最近一次评测失败时的错误信息 (status=failed 时有值) */
    last_eval_error?: string | null;
    execution_match?: {
        matchJson?: string | null;
        matchedAt?: string | null;
        mode?: string | null;
    } | null;
}

interface StaticSummary {
    latest: null | {
        evaluationId: string;
        ranAt: string;
        status: string;
        generator?: string;
        durationMs?: number;
        issuesCount: number;
        severityHistogram: Record<Severity, number>;
        // evaluation-summary API 返回的就是整段 parsed JSON：{ scores, comments }
        l2Scores?: {
            scores?: Record<string, number>;
            comments?: { meta?: string; robustness?: string; security?: string; code?: string };
        } | null;
    };
    history: Array<{
        evaluationId: string;
        ranAt: string;
        status: string;
        generator?: string;
        issuesCount: number;
        severityHistogram: Record<Severity, number>;
    }>;
}

interface StaticSummaryReloadOptions {
    expectedEvaluationId?: string;
    retries?: number;
    retryDelayMs?: number;
}

interface TriggerSummaryReloadOptions {
    expectedRunId?: string;
    retries?: number;
    retryDelayMs?: number;
}

interface TraceReloadOptions {
    retries?: number;
    retryDelayMs?: number;
}

interface GraySideAggregate {
    total: number;
    avgScore: number | null;
    avgTime: number | null;
    avgTokens: number | null;
    passRate: number;
    triggered: number;
    toolCalls: number;
}

interface GraySummary {
    taskId: string;
    taskName: string;
    createdAt?: string;
    latestResultAt?: string;
    latestCompletedAt?: string;
    runCount: number;
    repeatRounds: number;
    sampleCount: number;
    completedPairs: number;
    a: GraySideAggregate;
    b: GraySideAggregate;
    aLabel: string; // e.g. "无 Skill" or "v3"
    bLabel: string;
    aHasSkill: boolean;
    bHasSkill: boolean;
    aVersionId?: string;
    bVersionId?: string;
    delta: number | null; // bScore - aScore
    deltaPct: number | null;
    pValue: number | null;
    recommendation: 'up' | 'down' | 'flat' | 'insufficient';
    scoring: AbScoringResult;
}

interface GrayTaskMeta {
    id: string;
    createdAt?: string;
    configJson?: {
        skillId?: string;
        versionAId?: string;
        versionBId?: string;
        selectedCaseIds?: string[];
        checkedCaseIds?: string[];
        evaluatorId?: string;
        agentMaxConcurrency?: number;
        repeatRounds?: number;
        latestResultAt?: string;
    };
    caseStatesJson?: Record<string, { a?: GrayRunLike; b?: GrayRunLike }>;
    activeRun?: {
        taskId?: string;
        runId?: string;
        status?: 'running' | 'evaluating' | string;
        startedAt?: number;
    } | null;
}

interface GrayReloadResult {
    summary: GraySummary | null;
    meta: GrayTaskMeta | null;
    busy: boolean;
}

type DiagnosisUiStatus = 'idle' | 'loading' | 'ready';
type SmartRunPhase = 'idle' | 'starting' | 'running' | 'refreshing' | 'diagnosing';
type SelectedRunKey = 'trace' | 'static' | 'gray' | 'trigger';

type GrayRunLike = {
    status?: string;
    score?: number;
    pass?: number;
    timeCost?: string;
    tokenUsage?: number;
    sessionId?: string;
    skillTriggered?: boolean;
    toolCallCount?: number;
    toolCalls?: string[];
    completedAt?: string;
    runs?: GrayRunLike[];
};

type GrayCaseState = { a?: GrayRunLike; b?: GrayRunLike };

function hasGrayRunningStates(states: GrayTaskMeta['caseStatesJson'] | undefined): boolean {
    if (!states) return false;
    return Object.values(states).some(state =>
        (['a', 'b'] as const).some(side => {
            const sideState = state?.[side];
            return sideState?.status === 'running' || sideState?.status === 'evaluating';
        })
    );
}

function getGrayRunScore(run: GrayRunLike | undefined): number | null {
    if (!run) return null;
    if (typeof run.score === 'number') return run.score;
    if (typeof run.pass === 'number') return run.pass;
    return null;
}

function aggregateGraySide(side: {
    status?: string;
    score?: number;
    pass?: number;
    timeCost?: string;
    tokenUsage?: number;
    sessionId?: string;
    skillTriggered?: boolean;
    toolCallCount?: number;
    toolCalls?: string[];
    runs?: GrayRunLike[];
} | undefined): GraySideAggregate {
    const empty: GraySideAggregate = { total: 0, avgScore: null, avgTime: null, avgTokens: null, passRate: 0, triggered: 0, toolCalls: 0 };
    if (!side) return empty;
    const parseSec = (t?: string) => {
        if (!t) return null;
        const m = /(\d+(?:\.\d+)?)\s*s/.exec(t);
        return m ? Number(m[1]) : null;
    };
    const runs = Array.isArray(side.runs) ? side.runs : [];
    if (runs.length > 0) {
        // 通过率以分数为准（>=60 视为通过），评估器没给分才回退到 status。
        const scores = runs.map(getGrayRunScore).filter((score): score is number => score != null);
        const passCount = runs.filter(r => {
            const score = getGrayRunScore(r);
            return score != null ? score >= 60 : r.status === 'pass';
        }).length;
        const avgScore = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null;
        const timed = runs.map(r => parseSec(r.timeCost)).filter((n): n is number => n != null);
        const avgTime = timed.length ? Number((timed.reduce((a, n) => a + n, 0) / timed.length).toFixed(2)) : null;
        const tokened = runs.filter(r => typeof r.tokenUsage === 'number' && (r.tokenUsage || 0) > 0);
        const avgTokens = tokened.length ? Math.round(tokened.reduce((a, r) => a + (r.tokenUsage || 0), 0) / tokened.length) : null;
        const triggered = runs.filter(r => r.skillTriggered).length;
        const toolCalls = runs.reduce((sum, r) => sum + (r.toolCallCount || 0), 0);
        return { total: runs.length, avgScore, avgTime, avgTokens, passRate: Math.round((passCount / runs.length) * 100), triggered, toolCalls };
    }
    const singleScore = getGrayRunScore(side);
    const hasSingle = side.status === 'pass' || side.status === 'fail' || singleScore != null || !!side.sessionId;
    if (!hasSingle) return empty;
    const avgScore = singleScore;
    const passCount = avgScore != null ? (avgScore >= 60 ? 1 : 0) : (side.status === 'pass' ? 1 : 0);
    const avgTime = parseSec(side.timeCost);
    const avgTokens = typeof side.tokenUsage === 'number' && side.tokenUsage > 0 ? side.tokenUsage : null;
    return { total: 1, avgScore, avgTime, avgTokens, passRate: passCount * 100, triggered: side.skillTriggered ? 1 : 0, toolCalls: side.toolCallCount || 0 };
}

function aggregateGraySides(sides: GrayRunLike[]): GraySideAggregate {
    const runs = sides.flatMap(side => {
        if (Array.isArray(side.runs) && side.runs.length > 0) return side.runs;
        return side.status === 'pass' || side.status === 'fail' || getGrayRunScore(side) != null || !!side.sessionId
            ? [side]
            : [];
    });
    return aggregateGraySide({ runs });
}

function collectGrayScores(side: GrayRunLike | undefined): number[] {
    if (!side) return [];
    const runs = Array.isArray(side.runs) ? side.runs : [];
    if (runs.length > 0) {
        return runs.map(getGrayRunScore).filter((score): score is number => score != null);
    }
    const score = getGrayRunScore(side);
    return score == null ? [] : [score];
}

function collectLatestGrayCompletedAt(states: Record<string, GrayCaseState> | { a?: GrayRunLike; b?: GrayRunLike }): string | undefined {
    const terminalStatuses = new Set(['pass', 'fail', 'executed']);
    let latest = 0;
    const visit = (run: GrayRunLike | undefined) => {
        if (!run) return;
        if (Array.isArray(run.runs)) {
            run.runs.forEach(visit);
        }
        if (!run.completedAt || !terminalStatuses.has(run.status || '')) return;
        const time = new Date(run.completedAt).getTime();
        if (Number.isFinite(time)) latest = Math.max(latest, time);
    };
    if ('a' in states || 'b' in states) {
        visit((states as { a?: GrayRunLike }).a);
        visit((states as { b?: GrayRunLike }).b);
    } else {
        Object.values(states).forEach(state => {
            visit(state.a);
            visit(state.b);
        });
    }
    return latest > 0 ? new Date(latest).toISOString() : undefined;
}

function formatSkillVersionLabel(skillName: string | undefined, version: number | string | null | undefined): string {
    return `${skillName || 'Skill'}:v${version ?? '?'}`;
}

const GRAY_NONE_VERSION_ID = '__NONE__';
function buildGraySummary(task: {
    id: string;
    taskName?: string;
    createdAt?: string;
    configJson?: {
        skillId?: string;
        runCount?: number;
        repeatRounds?: number;
        versionAId?: string;
        versionBId?: string;
        latestResultAt?: string;
    };
    caseStatesJson?: { a?: GrayRunLike; b?: GrayRunLike } | Record<string, GrayCaseState>;
}, versionLookup?: Record<string, { version: number | string; skillName: string }>, fallback?: { skillName?: string; version?: number | null }): GraySummary | null {
    const states = task.caseStatesJson || {};
    const isLegacy = 'a' in states || 'b' in states;
    const caseStates = isLegacy
        ? []
        : Object.values(states).filter((item): item is GrayCaseState => !!item && typeof item === 'object');
    const a = isLegacy
        ? aggregateGraySide((states as { a?: GrayRunLike }).a)
        : aggregateGraySides(caseStates.map(item => item.a).filter((item): item is GrayRunLike => !!item));
    const b = isLegacy
        ? aggregateGraySide((states as { b?: GrayRunLike }).b)
        : aggregateGraySides(caseStates.map(item => item.b).filter((item): item is GrayRunLike => !!item));
    const aScores = isLegacy
        ? collectGrayScores((states as { a?: GrayRunLike }).a)
        : caseStates.flatMap(item => collectGrayScores(item.a));
    const bScores = isLegacy
        ? collectGrayScores((states as { b?: GrayRunLike }).b)
        : caseStates.flatMap(item => collectGrayScores(item.b));
    if (a.total === 0 && b.total === 0) return null;
    const sampleCount = isLegacy ? Math.max(a.total, b.total) : caseStates.length;
    const completedPairs = isLegacy
        ? Math.min(a.total, b.total)
        : caseStates.filter(item => aggregateGraySide(item.a).total > 0 && aggregateGraySide(item.b).total > 0).length;
    const delta = (a.avgScore != null && b.avgScore != null) ? (b.avgScore - a.avgScore) : null;
    const deltaPct = (a.avgScore != null && b.avgScore != null && a.avgScore > 0) ? Number(((b.avgScore - a.avgScore) / a.avgScore * 100).toFixed(1)) : null;
    const pValue = welchTTestPValue(aScores, bScores);
    const recommendation: GraySummary['recommendation'] =
        delta == null ? 'insufficient' : delta >= 5 ? 'up' : delta <= -5 ? 'down' : 'flat';
    // 判 hasSkill：显式 NONE → 无；显式有 versionId → 有；configJson 没存 →
    // 回退到约定（A=基线无 skill / B=候选有 skill），别让旧任务都退化成"无 SKILL vs 无 SKILL"。
    const labelFor = (versionId: string | undefined, sideDefault: 'has' | 'none') => {
        if (versionId === GRAY_NONE_VERSION_ID) return { label: '无 Skill', hasSkill: false };
        if (versionId) {
            const versionInfo = versionLookup?.[versionId];
            return {
                label: formatSkillVersionLabel(versionInfo?.skillName || fallback?.skillName, versionInfo?.version ?? fallback?.version),
                hasSkill: true,
            };
        }
        if (sideDefault === 'none') return { label: '无 Skill', hasSkill: false };
        return { label: formatSkillVersionLabel(fallback?.skillName, fallback?.version), hasSkill: true };
    };
    const aInfo = labelFor(task.configJson?.versionAId, 'none');
    const bInfo = labelFor(task.configJson?.versionBId, 'has');
    const scoringStates = isLegacy
        ? { 'legacy-case': { a: (states as { a?: GrayRunLike }).a, b: (states as { b?: GrayRunLike }).b } }
        : states as Record<string, GrayCaseState>;
    const scoring = calculateAbScoring(scoringStates, { repeatRounds: task.configJson?.repeatRounds });
    const repeatRounds = task.configJson?.repeatRounds ?? scoring.repeatRounds ?? 1;
    const latestCompletedAt = collectLatestGrayCompletedAt(scoringStates);
    return {
        taskId: task.id,
        taskName: task.taskName || 'AB测评',
        createdAt: task.createdAt,
        latestResultAt: task.configJson?.latestResultAt,
        latestCompletedAt,
        runCount: task.configJson?.runCount || Math.max(a.total, b.total) || 1,
        repeatRounds,
        sampleCount,
        completedPairs,
        a, b,
        aLabel: aInfo.label, bLabel: bInfo.label,
        aHasSkill: aInfo.hasSkill, bHasSkill: bInfo.hasSkill,
        aVersionId: task.configJson?.versionAId,
        bVersionId: task.configJson?.versionBId,
        delta, deltaPct, pValue, recommendation,
        scoring,
    };
}

/**
 * 把最近一次静态评估折算成「维度均分 ×20」的百分数。
 *   - 只统计拿到了 L2 维度分数的标准：未评估的维度不计入分母（用户要求）
 *   - avgPct = 已评估维度的平均分 × 20（满分 5 → 100%）
 *   - scoredCount = 实际被 L2 评估的维度数
 * 跟 EvaluationContent 维度评分卡顶部的"维度均分"严格同口径。
 * 没有任何 L2 分数（只跑过 L1）→ avgPct = null，由调用方显示 `--`。
 */
function computeStaticPassRate(latest: StaticSummary['latest']): {
    avgPct: number | null;
    scoredCount: number;
} {
    if (!latest) return { avgPct: null, scoredCount: 0 };
    const scores = latest.l2Scores?.scores;
    if (!scores) return { avgPct: null, scoredCount: 0 };
    let sum = 0;
    let scored = 0;
    for (const std of STATIC_EVAL_STANDARDS) {
        const v = std.dimensionAliases
            .map(a => scores[a])
            .find(s => typeof s === 'number' && Number.isFinite(s));
        if (typeof v === 'number') {
            scored++;
            sum += v;
        }
    }
    return {
        avgPct: scored > 0 ? Math.round((sum / scored) * 20) : null,
        scoredCount: scored,
    };
}

interface MatchSummary {
    totalSteps?: number;
    matchedSteps?: number;
    partialSteps?: number;
    unexpectedSteps?: number;
    nonBusinessSteps?: number;
    skippedSteps?: number;
    orderViolations?: number;
    overallScore?: number;
}

interface ProblemStep {
    stepIndex?: number;
    stepName?: string;
    status?: 'partial' | 'unexpected' | 'non_business' | 'skipped';
    problem?: string;
    suggestion?: string;
}

interface StepMatch {
    expectedStepId?: string;
    expectedStepName?: string;
    actualStepIndex?: number;
    actualAction?: string;
    matchStatus: 'matched' | 'partial' | 'unexpected' | 'delegated' | 'non_business' | 'skipped';
    matchReason?: string;
}

interface SkippedExpectedStep {
    expectedStepId: string;
    expectedStepName: string;
}

interface FlowStep {
    id: string;
    name: string;
    description?: string;
    type?: 'action' | 'decision' | 'output';
}

interface AlignmentActualStep {
    index: number;
    action: string;
    type?: 'action' | 'decision' | 'output';
    description?: string;
    dialogStartIndex?: number;
    dialogEndIndex?: number;
}

interface AlignmentMapping {
    actualStepIndex: number;
    expectedStepId?: string;
    expectedStepName?: string;
    status: 'matched' | 'partial' | 'unexpected' | 'delegated' | 'non_business';
    reason?: string;
}

interface AlignmentSkillSpan {
    skillName: string;
    version?: number;
    startActualStepIndex: number;
    endActualStepIndex: number;
    trigger?: 'primary' | 'invoked' | 'load_skill' | 'trace_tag' | 'subagent';
    expectedStepId?: string;
    expectedStepName?: string;
    evaluationStatus?: 'matched' | 'partial' | 'unexpected' | 'non_business';
    evaluationReason?: string;
}

interface AlignmentViolation {
    kind: 'partial' | 'unexpected' | 'non_business' | 'skipped' | 'order_violation' | 'tool_choice';
    actualStepIndex?: number;
    expectedStepId?: string;
    expectedStepName?: string;
    severity?: Severity;
    problem: string;
    suggestion?: string;
    evidenceInteractionIndexes?: number[];
}

interface TraceSkillAlignment {
    actualSteps?: AlignmentActualStep[];
    mappings?: AlignmentMapping[];
    skippedExpectedSteps?: SkippedExpectedStep[];
    skillSpans?: AlignmentSkillSpan[];
    violations?: AlignmentViolation[];
    summary?: MatchSummary;
}

interface ExecutionMatchPayload {
    matches?: StepMatch[];
    skippedExpectedSteps?: SkippedExpectedStep[];
    summary?: MatchSummary;
    problemSteps?: ProblemStep[];
    alignment?: TraceSkillAlignment;
}

/* /api/eval/trajectory/results 返回的单行结构（精简）
 *
 * 注意：list 端点不返回原始 JSON 字符串字段；它把 rawAnalysisJson 解析后整体放在
 * `rawAnalysis` 里，同时也把顶层键 spread 到 row 上。本结构只声明前端实际用到的几个
 * 解析后字段，并允许任意额外键（spread 来的）。
 */
interface TrajectoryEvalRow {
    id: string;
    taskId?: string | null;
    status: 'pending' | 'running' | 'done' | 'failed';
    errorMessage?: string | null;
    trajectoryScore?: number | null;
    deviationSteps?: unknown[];  // 解析后数组（来自 deviationStepsJson）
    rawAnalysis?: Record<string, unknown> | null;  // 解析后对象，含 skillAttribution / *_findings 等
    selectedEvaluators?: string[];
    selectedEvaluatorNames?: string[];
    rootCauseStep?: string | null;
    reasonText?: string | null;
    createdAt?: string;
    updatedAt?: string;
}

const LOOKBACK_DAYS = 30;
const SKILL_ANALYSIS_SELECTION_STORAGE_KEY = 'skill-analysis-selection';

export default function SkillDebugPage() {
    return (
        <Suspense fallback={null}>
            <SkillAnalysisPage />
        </Suspense>
    );
}

function SkillAnalysisPage() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { user } = useAuth();
    const [initialSkillParam] = useState(() => searchParams.get('skill') || '');
    const [initialVersionParam] = useState(() => searchParams.get('version') || '');
    const [view, setView] = useState<AnalysisView>(() => {
        const v = searchParams.get('view');
        return (v === 'trace' || v === 'static' || v === 'gray' || v === 'overview') ? v : 'overview';
    });

    useEffect(() => {
        const current = searchParams.get('view') || 'overview';
        if (current === view) return;
        const params = new URLSearchParams(Array.from(searchParams.entries()));
        if (view === 'overview') params.delete('view');
        else params.set('view', view);
        const qs = params.toString();
        router.replace(qs ? `?${qs}` : '?', { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [view]);
    const [skills, setSkills] = useState<SkillOption[]>([]);
    const [skillsLoading, setSkillsLoading] = useState(false);
    const [selectedSkillId, setSelectedSkillId] = useState('');
    const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
    const [traces, setTraces] = useState<TraceRecord[]>([]);
    const [tracesLoading, setTracesLoading] = useState(false);
    // 跟当前 traces.length 同步,reloadTraces 闭包里读它判断"是否需要显 loading"——
    // 之前每次 reloadTraces 都无脑 setTracesLoading(true),叠加后台 3s 轮询导致
    // ① 配置块"正在加载..."文字闪烁。现在只有"列表本来就空"才显 loading。
    const tracesRef = useRef<TraceRecord[]>([]);
    useEffect(() => { tracesRef.current = traces; }, [traces]);
    const [traceCardUpdatedAt, setTraceCardUpdatedAt] = useState<string | null>(null);
    const [staticSummary, setStaticSummary] = useState<StaticSummary | null>(null);
    const [staticLoading, setStaticLoading] = useState(false);
    const [grayNewTaskTrigger, setGrayNewTaskTrigger] = useState(0);
    const [grayHistoryTrigger, setGrayHistoryTrigger] = useState(0);
    // batchNewTaskTrigger / batchHistoryTrigger 删——'batch' 视图已下线，
    // BatchEvaluation 作为 trace 模式 ① 配置块"从数据集"内核渲染时直接 props 0/0
    const [resetToken, setResetToken] = useState(0);
    const [prefillTraceId, setPrefillTraceId] = useState(searchParams.get('taskId') || '');
    const [selectedTraceId, setSelectedTraceId] = useState(searchParams.get('taskId') || '');
    const [smartRunBusy, setSmartRunBusy] = useState(false);

    // 评测任务关联 (trace 模式专用 —— dataset 模式由 BatchEvaluation 自己维护)。
    // 持久化用 localStorage 按 (user, skillId, version) 维度 key, 因为 SkillAnalysisPage 没有
    // 单独的 task 实体承载这一关联 (BatchEvalTask 只跟 dataset 模式相关)。
    // 跨设备不同步是 known limitation, 后续如果接入跨设备 task 表可以迁移。
    const [newBatchDialogOpen, setNewBatchDialogOpen] = useState(false);
    const [traceEvaluationBatchId, setTraceEvaluationBatchId] = useState('');
    const [traceEvaluationBatchTitle, setTraceEvaluationBatchTitle] = useState('');
    const [traceEvaluationBatchEvaluators, setTraceEvaluationBatchEvaluators] = useState<string[]>([]);

    // 用例分析 AB 式配置区: 共享的「数据集多选」+「评估器多选」。
    // 数据集作为评测参考集 (后端按 datasetIds 收窄 trace↔case 匹配)，评估器多选决定开始评测时调用哪些评估器。
    // Phase 1 仅 trace 模式消费这套选择; dataset 模式后续并入。
    const [caseDatasets, setCaseDatasets] = useState<Array<{ id: string; name: string; cases?: unknown[] }>>([]);
    const [caseUserEvaluators, setCaseUserEvaluators] = useState<Array<{ id: string; name: string }>>([]);
    const [caseDatasetIds, setCaseDatasetIds] = useState<string[]>([]);
    const [caseEvaluatorIds, setCaseEvaluatorIds] = useState<string[]>(
        () => presetEvaluators.filter(e => e.status === 'ready').map(e => e.id),
    );
    useEffect(() => {
        if (!user) { setCaseDatasets([]); setCaseUserEvaluators([]); return; }
        Promise.all([
            apiFetch(`/api/agent-datasets?user=${encodeURIComponent(user)}`).then(r => r.json()).catch(() => []),
            apiFetch(`/api/user-evaluators?user=${encodeURIComponent(user)}`).then(r => r.json()).catch(() => []),
        ]).then(([ds, ev]) => {
            if (Array.isArray(ds)) setCaseDatasets(ds.map((d: any) => ({ id: d.id, name: d.name, cases: d.cases })));
            if (Array.isArray(ev)) setCaseUserEvaluators(ev.map((e: any) => ({ id: e.id, name: e.name })));
        }).catch(() => {});
    }, [user]);

    // 评测任务(批次)列表 —— 供配置区"选历史评测任务"。trace / dataset 共用同一份。
    const [caseEvalTasks, setCaseEvalTasks] = useState<Array<{ runId: string; taskTitle?: string; traceCount?: number; doneCount?: number; runningCount?: number; createdAt?: string; skillName?: string; skillVersion?: number | null }>>([]);
    const reloadEvalTasks = useCallback(async () => {
        if (!user) { setCaseEvalTasks([]); return; }
        try {
            const includeRun = traceEvaluationBatchId
                ? `&includeRunId=${encodeURIComponent(traceEvaluationBatchId)}`
                : '';
            const res = await apiFetch(`/api/eval/trajectory/runs?user=${encodeURIComponent(user)}&limit=50&latestByCase=1${includeRun}`);
            const data = await res.json();
            if (Array.isArray(data?.runs)) {
                setCaseEvalTasks(data.runs.map((r: any) => ({
                    runId: r.runId, taskTitle: r.taskTitle, traceCount: r.traceCount,
                    doneCount: r.doneCount, runningCount: r.runningCount, createdAt: r.createdAt,
                    skillName: r.skillName, skillVersion: r.skillVersion,
                })));
            }
        } catch {/* 列表加载失败不阻塞主流程 */}
    }, [user, traceEvaluationBatchId]);
    useEffect(() => { reloadEvalTasks(); }, [reloadEvalTasks]);

    // 持久化「数据集 + 评估器」选择 (按 user+skill+版本), 刷新页面不丢。
    const caseConfigStorageKey = useMemo(() => {
        if (!user || !selectedSkillId) return '';
        return `skill-eval:case-config:${user}:${selectedSkillId}:v${selectedVersion ?? 'all'}`;
    }, [user, selectedSkillId, selectedVersion]);
    // 恢复 (只读): 切 skill/版本 或刷新时从 localStorage 取回上次选择。
    useEffect(() => {
        if (!caseConfigStorageKey) return;
        try {
            const raw = localStorage.getItem(caseConfigStorageKey);
            if (!raw) return;
            const parsed = JSON.parse(raw) as { datasetIds?: string[]; evaluatorIds?: string[] };
            if (Array.isArray(parsed?.datasetIds)) setCaseDatasetIds(parsed.datasetIds);
            if (Array.isArray(parsed?.evaluatorIds) && parsed.evaluatorIds.length > 0) setCaseEvaluatorIds(parsed.evaluatorIds);
        } catch {/* localStorage 异常忽略 */}
    }, [caseConfigStorageKey]);
    // 保存只在用户改动时触发 (走 handler), 避免挂载时用初始空值覆盖已存的选择。
    const handleCaseDatasetIdsChange = useCallback((ids: string[]) => {
        setCaseDatasetIds(ids);
        if (caseConfigStorageKey) {
            try { localStorage.setItem(caseConfigStorageKey, JSON.stringify({ datasetIds: ids, evaluatorIds: caseEvaluatorIds })); } catch {/* ignore */}
        }
    }, [caseConfigStorageKey, caseEvaluatorIds]);
    const handleCaseEvaluatorIdsChange = useCallback((ids: string[]) => {
        setCaseEvaluatorIds(ids);
        if (caseConfigStorageKey) {
            try { localStorage.setItem(caseConfigStorageKey, JSON.stringify({ datasetIds: caseDatasetIds, evaluatorIds: ids })); } catch {/* ignore */}
        }
    }, [caseConfigStorageKey, caseDatasetIds]);

    // 现存数据集列表变化(刷新/删除数据集)时, 把已不存在的数据集 id 从选择中剔除并回写 localStorage——
    // 保证下发给后端的 datasetIds 始终是"当前真实存在"的子集; 否则被删数据集的幽灵 id(localStorage 残留)
    // 会随配置传到后端, 命中 "dataset not found" 导致启动失败。
    useEffect(() => {
        if (caseDatasets.length === 0) return; // 列表尚未加载完成时不剪枝, 避免把有效选择误清空
        const existing = new Set(caseDatasets.map(d => d.id));
        const pruned = caseDatasetIds.filter(id => existing.has(id));
        if (pruned.length === caseDatasetIds.length) return; // 没有幽灵 id, 无需改动
        setCaseDatasetIds(pruned);
        if (caseConfigStorageKey) {
            try { localStorage.setItem(caseConfigStorageKey, JSON.stringify({ datasetIds: pruned, evaluatorIds: caseEvaluatorIds })); } catch {/* ignore */}
        }
    }, [caseDatasets, caseDatasetIds, caseConfigStorageKey, caseEvaluatorIds]);

    const traceEvalBatchStorageKey = useMemo(() => {
        if (!user || !selectedSkillId) return '';
        return `skill-eval:trace-eval-batch:${user}:${selectedSkillId}:v${selectedVersion ?? 'all'}`;
    }, [user, selectedSkillId, selectedVersion]);
    // 初始化: 进入 / 切换 skill+version 时从 localStorage 恢复关联
    useEffect(() => {
        if (!traceEvalBatchStorageKey) {
            setTraceEvaluationBatchId('');
            setTraceEvaluationBatchTitle('');
            setTraceEvaluationBatchEvaluators([]);
            return;
        }
        try {
            const raw = localStorage.getItem(traceEvalBatchStorageKey);
            if (!raw) {
                setTraceEvaluationBatchId('');
                setTraceEvaluationBatchTitle('');
                setTraceEvaluationBatchEvaluators([]);
                return;
            }
            const parsed = JSON.parse(raw) as { id?: string; title?: string; evaluators?: string[] };
            setTraceEvaluationBatchId(parsed?.id || '');
            setTraceEvaluationBatchTitle(parsed?.title || '');
            setTraceEvaluationBatchEvaluators(Array.isArray(parsed?.evaluators) ? parsed.evaluators : []);
        } catch {
            setTraceEvaluationBatchId('');
            setTraceEvaluationBatchTitle('');
            setTraceEvaluationBatchEvaluators([]);
        }
    }, [traceEvalBatchStorageKey]);

    const selectedSkill = useMemo(
        () => skills.find(s => s.id === selectedSkillId) || null,
        [skills, selectedSkillId],
    );

    // 关联评测任务的版本一致性（非破坏式）：若已关联任务(其评测的 trace 属于另一个版本)与当前查看版本
    // 明确不一致，则在"展示/取数"层把它当作未关联，避免在 v0 看到 v1 任务的数据。
    // 注意：不清 state、不删 localStorage —— 每个版本的关联仍各自按槽位持久化，切版本不会互相影响
    //（之前用 effect 删 localStorage 会和"切版本恢复"竞态，误删刚切到的版本里已选好的任务）。
    const effectiveTraceEvaluationBatchId = useMemo(() => {
        if (!traceEvaluationBatchId || selectedVersion == null) return traceEvaluationBatchId;
        const associated = caseEvalTasks.find(t => t.runId === traceEvaluationBatchId);
        if (associated && (associated.traceCount || 0) > 0) {
            if (associated.skillName !== selectedSkill?.name || associated.skillVersion !== selectedVersion) return '';
        }
        return traceEvaluationBatchId;
    }, [traceEvaluationBatchId, caseEvalTasks, selectedSkill?.name, selectedVersion]);

    // 历史评测任务按当前 skill + 版本过滤：空任务可作为当前版本的新容器；
    // 已有 trace 的任务必须严格匹配当前 skill/version，避免把旧上下文继续追加进来。
    const caseEvalTasksForSkill = useMemo(() => {
        const skillName = selectedSkill?.name;
        if (!skillName) return caseEvalTasks;
        return caseEvalTasks.filter(t =>
            t.runId === effectiveTraceEvaluationBatchId
            || (t.skillName === skillName
                && (selectedVersion == null || (t.traceCount || 0) === 0 || t.skillVersion === selectedVersion)),
        );
    }, [caseEvalTasks, selectedSkill?.name, selectedVersion, effectiveTraceEvaluationBatchId]);

    const sortedVersions = useMemo(() => {
        const versions = selectedSkill?.versions || [];
        return [...versions].sort((a, b) => b.version - a.version);
    }, [selectedSkill]);

    useEffect(() => {
        if (!user) return;
        setSkillsLoading(true);
        apiFetch(`/api/skills?user=${encodeURIComponent(user)}`)
            .then(r => r.json())
            .then(data => {
                if (!Array.isArray(data)) return;
                setSkills(data);
            })
            .catch(() => {})
            .finally(() => setSkillsLoading(false));
    }, [user]);

    useEffect(() => {
        if (skills.length === 0) {
            if (selectedSkillId) setSelectedSkillId('');
            setSelectedVersion(null);
            return;
        }
        if (selectedSkillId && skills.some(s => s.id === selectedSkillId)) return;

        const stored = readSkillAnalysisSelection(user);
        const initial = findInitialSkill(skills, initialSkillParam, stored) || skills[0];
        setSelectedSkillId(initial.id);
        setSelectedVersion(resolveSkillVersion(initial, parseVersionParam(initialVersionParam) ?? stored?.version ?? null));
        // 复用上次选中的 trace：URL 显式 ?taskId= 优先；URL 没有就用 localStorage 里
        // 上次同一 (skill, version) 选中的 taskId。让用户在 trace 之间来回切回也能
        // 自动定位到上次看的那条。
        if (!prefillTraceId && stored?.taskId && stored.skillName === initial.name) {
            setPrefillTraceId(stored.taskId);
        }
    }, [initialSkillParam, initialVersionParam, prefillTraceId, selectedSkillId, skills, user]);

    useEffect(() => {
        if (!selectedSkill) return;
        writeSkillAnalysisSelection(user, {
            skillId: selectedSkill.id,
            skillName: selectedSkill.name,
            version: selectedVersion ?? null,
            // 把当前 trace 也存进 selection，下次进同一 (skill, version) 时自动选回
            taskId: selectedTraceId || null,
        });
    }, [selectedSkill, selectedVersion, selectedTraceId, user]);

    useEffect(() => {
        if (!selectedSkill) {
            setSelectedVersion(null);
            return;
        }
        // 注意：null 是合法状态，表示"全部版本"。只有当 selectedVersion 是具体数字但
        // 在当前 skill 的 versions 列表里找不到时（比如切了 skill 但状态没跟上）才回弹。
        const versions = selectedSkill.versions || [];
        if (selectedVersion != null && !versions.some(v => v.version === selectedVersion)) {
            setSelectedVersion(resolveSkillVersion(selectedSkill, selectedVersion));
        }
    }, [selectedSkill, selectedVersion]);

    // 把当前选中的 skill+version 同步进 URL ?skill=&version=
    // —— 跟上面 view 同步那段是同一套模式。
    // 用途有二：① 浏览器后退/刷新能落回同一份选择；
    // ② 子页（/skill-eval/trigger/<name>）跳回父页时，是带着 ?version= 回来的
    //    重新 mount 后 initialVersionParam 会读到它；用户在父页内自己再切版本时，
    //    这个 effect 把新值写回 URL，保持 URL 是真相源（对齐 view 的处理）。
    // 幂等：URL 当前值与待写值一致就直接 return，避免和 router.replace 引发循环。
    useEffect(() => {
        const params = new URLSearchParams(Array.from(searchParams.entries()));
        const skillName = selectedSkill?.name || '';
        const versionStr = selectedVersion != null ? String(selectedVersion) : '';
        const sameSkill = (params.get('skill') || '') === skillName;
        const sameVersion = (params.get('version') || '') === versionStr;
        if (sameSkill && sameVersion) return;
        if (skillName) params.set('skill', skillName); else params.delete('skill');
        if (versionStr) params.set('version', versionStr); else params.delete('version');
        const qs = params.toString();
        router.replace(qs ? `?${qs}` : '?', { scroll: false });
    // searchParams 故意不进依赖：它的变化会被 selectedSkill/selectedVersion 间接反应；
    // 直接监听会和上面这次 router.replace 自身的副作用形成循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedSkill, selectedVersion]);

    const reloadTraces = useCallback(async (options?: TraceReloadOptions): Promise<TraceRecord[]> => {
        if (!user || !selectedSkill) {
            setTraces([]);
            setTraceCardUpdatedAt(null);
            return [];
        }
        // 只在"列表本来就空"才显 loading；已有数据的刷新一律静默——避免后台 retry
        // 轮询导致"正在加载..."文字闪烁（每 3s 闪一次特别难受）。
        // 用 ref 读最新 traces.length,绕开 useCallback 闭包的 stale value 问题。
        if (tracesRef.current.length === 0) setTracesLoading(true);
        // 性能优化：
        //   includeEvaluations=0 关掉后端 evaluation 关联查询（trace 列表行不需要,
        //   点 trace 后才会单独拉 analyze-match 和 trajectory/results）
        //
        // 不能传 skill=<name> 让后端按 where.skill 过滤——Execution.skill 只是"主 skill",
        // 多 Agent / 子调用场景下用户选 X，trace 主 skill 可能是 agent 名，X 在 invokedSkills
        // 或 skills 字段里。后端单字段过滤会漏一大批,导致筛错。
        // 改回拉用户全量（已经按 user 隔离）再用前端 traceReferencesSkill 多字段匹配。
        const params = new URLSearchParams({
            user,
            includeEvaluations: '0',
            // 性能：跳过 auto-eval readiness 计算。该计算会对每条 trace 加载整段 Session +
            // 解析 interactions JSON（最多 200 条并发），是 /api/observe/data 的主要耗时来源；
            // 而用例分析列表只用已落库的分数(answer_score / trajectoryScore / matchJson)，
            // 既不消费 readiness 字段、也不依赖 auto-watch，跳过后分数能立刻返回。
            skipAutoEvalReady: '1',
        });
        const retries = options?.retries ?? 0;
        const retryDelayMs = options?.retryDelayMs ?? 800;
        const fetchOnce = async (cacheBustToken?: number): Promise<TraceRecord[]> => {
            const fetchParams = new URLSearchParams(params);
            fetchParams.set('_ts', String(cacheBustToken ?? Date.now()));
            const res = await apiFetch(`/api/observe/data?${fetchParams.toString()}`, { cache: 'no-store' });
            if (!res.ok) {
                throw new Error(`Trace 列表加载失败: HTTP ${res.status}`);
            }
            const data = await res.json();
            if (!Array.isArray(data)) return [];
            return data
                .filter((trace: TraceRecord) => traceReferencesSkill(trace, selectedSkill.name, selectedVersion))
                // 排除"跟用例分析语义无关"的系统 agent (平台辅助 + 评测器), 但**保留** A/B 灰度 trace
                // 让用户能复用 A/B 已跑过的 trace 评测。每行 UI 加来源徽章 (A/B / 用例分析 / 真实) 区分。
                .filter((trace: TraceRecord) => !shouldHideFromCaseAnalysis(trace.agentName || trace.agent))
                .slice(0, 200);
        };
        try {
            let latest: TraceRecord[] = [];
            for (let attempt = 0; attempt <= retries; attempt++) {
                latest = await fetchOnce(Date.now() + attempt);
                setTraces(latest);
                setTraceCardUpdatedAt(latest.length > 0 ? new Date().toISOString() : null);
                // 第 0 轮拿到数据立刻关闭 loading；后续 retry 是"批量分析后等分数落库"的
                // 后台静默刷新，不能再让"正在加载…"占满 trace 列表 90 秒——之前用户
                // 反馈：批量评测时 ① 配置块一直显示"正在加载 case13_oom... 的执行链路…"，
                // 看起来像挂了；其实数据早就拿到，只是 retry 循环把 loading 拖住了。
                if (attempt === 0) setTracesLoading(false);
                if (attempt < retries) {
                    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
                }
            }
            return latest;
        } catch {
            setTraces([]);
            setTraceCardUpdatedAt(null);
            return [];
        } finally {
            setTracesLoading(false);
        }
    }, [selectedSkill, selectedVersion, user]);

    useEffect(() => {
        reloadTraces();
    }, [reloadTraces, resetToken]);

    useEffect(() => {
        if (traces.length === 0) {
            if (selectedTraceId) setSelectedTraceId('');
            return;
        }
        if (prefillTraceId && traces.some(t => getTraceId(t) === prefillTraceId)) {
            if (selectedTraceId !== prefillTraceId) setSelectedTraceId(prefillTraceId);
            return;
        }
        if (!selectedTraceId || !traces.some(t => getTraceId(t) === selectedTraceId)) {
            setSelectedTraceId(getTraceId(traces[0]));
        }
    }, [prefillTraceId, selectedTraceId, traces]);

    const reloadStaticSummary = useCallback(async (options?: StaticSummaryReloadOptions): Promise<StaticSummary | null> => {
        if (!user || !selectedSkill || selectedVersion == null) {
            setStaticSummary(null);
            return null;
        }
        setStaticLoading(true);
        const retries = options?.retries ?? 5;
        const retryDelayMs = options?.retryDelayMs ?? 600;
        const expectedEvaluationId = options?.expectedEvaluationId;
        const fetchOnce = async (cacheBustToken?: number): Promise<StaticSummary> => {
            const params = new URLSearchParams({
                user,
                _ts: String(cacheBustToken ?? Date.now()),
            });
            const res = await apiFetch(
                `/api/skills/${selectedSkill.id}/versions/${selectedVersion}/evaluation-summary?${params.toString()}`,
                { cache: 'no-store' },
            );
            if (!res.ok) {
                throw new Error(`静态摘要加载失败: HTTP ${res.status}`);
            }
            return res.json();
        };
        try {
            let latest: StaticSummary | null = null;
            for (let attempt = 0; attempt <= retries; attempt++) {
                latest = await fetchOnce(Date.now() + attempt);
                setStaticSummary(latest);
                if (!expectedEvaluationId || latest.latest?.evaluationId === expectedEvaluationId) {
                    return latest;
                }
                if (attempt < retries) {
                    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
                }
            }
            return latest;
        } catch {
            setStaticSummary(null);
            return null;
        } finally {
            setStaticLoading(false);
        }
    }, [selectedSkill, selectedVersion, user]);

    useEffect(() => {
        reloadStaticSummary();
    }, [reloadStaticSummary, resetToken]);

    /* 触发分析卡 + Smart Run 行的数据：拉 trigger set 和最近一次 done 的 run。
       完整的"起草/编辑/评测"功能收口在 /skill-eval/trigger/<name>，这里只读做汇总。 */
    const [triggerSummary, setTriggerSummary] = useState<TriggerSummary | null>(null);
    const [triggerLoading, setTriggerLoading] = useState(false);
    const reloadTriggerSummary = useCallback(async (options?: TriggerSummaryReloadOptions): Promise<TriggerSummary | null> => {
        if (!user || !selectedSkill) {
            setTriggerSummary(null);
            return null;
        }
        const skillName = selectedSkill.name;
        setTriggerLoading(true);
        const retries = options?.retries ?? 5;
        const retryDelayMs = options?.retryDelayMs ?? 600;
        const expectedRunId = options?.expectedRunId;
        const fetchOnce = async (cacheBustToken?: number): Promise<TriggerSummary> => {
            const setParams = new URLSearchParams({ user, _ts: String(cacheBustToken ?? Date.now()) });
            const runParams = new URLSearchParams({
                user,
                latestOnly: 'true',
                _ts: String(cacheBustToken ?? Date.now()),
            });
            if (selectedVersion != null) runParams.set('skillVersion', String(selectedVersion));
            const [setData, runData] = await Promise.all([
                apiFetch(`/api/skill-eval/trigger/${encodeURIComponent(skillName)}?${setParams.toString()}`, { cache: 'no-store' })
                    .then(r => (r.ok ? r.json() : { set: null }))
                    .catch(() => ({ set: null })),
                apiFetch(`/api/skill-eval/trigger/${encodeURIComponent(skillName)}/runs?${runParams.toString()}`, { cache: 'no-store' })
                    .then(r => (r.ok ? r.json() : { run: null }))
                    .catch(() => ({ run: null })),
            ]);
            const items: Array<{ shouldTrigger?: boolean }> = Array.isArray(setData?.set?.items) ? setData.set.items : [];
            const positiveCount = items.filter(i => i?.shouldTrigger === true).length;
            const run = runData?.run ?? null;
            return {
                hasSet: !!setData?.set,
                itemCount: items.length,
                positiveCount,
                latestRun: run && run.status === 'done' ? {
                    id: typeof run.id === 'string' ? run.id : undefined,
                    passRate: Number(run.passRate ?? 0),
                    truePositiveRate: Number(run.truePositiveRate ?? 0),
                    falsePositiveRate: Number(run.falsePositiveRate ?? 0),
                    skillVersion: Number(run.skillVersion ?? 0),
                    ranAt: String(run.createdAt ?? ''),
                } : null,
            };
        };
        try {
            let latest: TriggerSummary | null = null;
            for (let attempt = 0; attempt <= retries; attempt++) {
                latest = await fetchOnce(Date.now() + attempt);
                setTriggerSummary(latest);
                if (!expectedRunId || latest.latestRun?.id === expectedRunId) {
                    return latest;
                }
                if (attempt < retries) {
                    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
                }
            }
            return latest;
        } catch {
            setTriggerSummary(null);
            return null;
        } finally {
            setTriggerLoading(false);
        }
    }, [selectedSkill, selectedVersion, user]);

    useEffect(() => {
        reloadTriggerSummary();
    }, [reloadTriggerSummary, resetToken]);

    const openTriggerEditor = useCallback(() => {
        if (!selectedSkill) return;
        // 把外侧 SkillAnalysisHeader 选中的版本透到子页 query 里，
        // 子页的版本初始化 effect 会读 ?version= 优先用它，对齐静态评估
        // ——StaticCompliancePanel 是同进程 prop 传 version={selectedVersion}，
        // 这里跨路由就用 URL 承载同一个意图。
        const qs = selectedVersion != null ? `?version=${selectedVersion}` : '';
        router.push(`/skill-eval/trigger/${encodeURIComponent(selectedSkill.name)}${qs}`);
    }, [router, selectedSkill, selectedVersion]);

    /*
     * 共享的"批量分析 N 条 trace"helper：被两条路径调用——
     *   1) AnalysisOverview「一键测试」点用例分析：直接触发当前 Trace 分析
     *   2) TraceDeviationPanel 详情页"分析当前/选中 Trace"：用户在详情页里勾选的
     * 同一份实现避免双轨。
     *   - 结果分析：一次 POST /api/eval/trajectory/run with taskIds[]
     *   - 轨迹分析：N 次 POST /api/observe/executions/{id}/analyze-match 并发扇出
     *   - Promise.allSettled 隔离：任一失败不阻断其它
     */
    // 「新增评测任务」对话框 onCreated: 设 React state + 写 localStorage 立刻持久化,
    // 让 trace 模式下"评测任务"关联跨刷新保留。后续 trajectory/run 调用透传 traceEvaluationBatchId
    // 让评测 append 到同一批次, 不再每次新建。
    const handleTraceEvalBatchCreated = useCallback((result: NewBatchCreated) => {
        setNewBatchDialogOpen(false);
        setTraceEvaluationBatchId(result.evaluatorRunId);
        setTraceEvaluationBatchTitle(result.taskTitle);
        setTraceEvaluationBatchEvaluators(result.selectedEvaluators);
        if (traceEvalBatchStorageKey) {
            try {
                localStorage.setItem(traceEvalBatchStorageKey, JSON.stringify({
                    id: result.evaluatorRunId,
                    title: result.taskTitle,
                    evaluators: result.selectedEvaluators,
                }));
            } catch {/* localStorage quota 异常时仍以 state 持有, 不阻塞主流程 */}
        }
        reloadEvalTasks();
    }, [traceEvalBatchStorageKey, reloadEvalTasks]);

    // 选一个已有评测任务 (评测执行批次) 关联到当前 trace 分析。
    const handleSelectTraceEvalBatch = useCallback((opt: { runId: string; taskTitle?: string }) => {
        setTraceEvaluationBatchId(opt.runId);
        setTraceEvaluationBatchTitle(opt.taskTitle || '');
        setTraceEvaluationBatchEvaluators([]);
        if (traceEvalBatchStorageKey) {
            try {
                localStorage.setItem(traceEvalBatchStorageKey, JSON.stringify({
                    id: opt.runId, title: opt.taskTitle || '', evaluators: [],
                }));
            } catch {/* ignore */}
        }
    }, [traceEvalBatchStorageKey]);

    useEffect(() => {
        if (traceEvaluationBatchId || caseEvalTasksForSkill.length === 0) return;
        const latest = caseEvalTasksForSkill[0];
        handleSelectTraceEvalBatch({ runId: latest.runId, taskTitle: latest.taskTitle });
    }, [caseEvalTasksForSkill, handleSelectTraceEvalBatch, traceEvaluationBatchId]);

    const runBatchTraceAnalysis = useCallback(async (taskIds: string[]): Promise<{
        resultErrors: string[];                                    // 结果评测整体失败（一次入队全失败）
        trajectoryErrors: Map<string, string>;                     // 每条 trace 各自的 trajectory 失败原因
    }> => {
        const empty = { resultErrors: [] as string[], trajectoryErrors: new Map<string, string>() };
        if (!user || taskIds.length === 0) return empty;
        // resultRun 是一次入队多条，要么整体成功要么整体失败；trajRun 是逐条独立扇出，
        // 每条都可能有自己的失败原因（如 skill 缺 mermaid 那种 per-trace 的前提缺失）。
        //
        // 方案A 顺序约定（重要）：先跑「评测」(trajectory/run，写 tool_choice/redundancy 单项分)，
        // 完成后再跑「analyze-match」。这样 analyze-match 的 persistAlignmentAttribution 作为最后写入者，
        // 能读到评测器写好的 tool_choice/redundancy，用 alignment 覆盖率当 completeness 走代码侧聚合层
        // 算出统一轨迹分（0.45/0.35/0.20 + 封顶）。两者并发时会因 last-write-wins 互相覆盖、口径不稳。
        const resultErrors: string[] = [];
        try {
            // 透传评测任务关联: 用户在配置区关联了批次时走 append 模式, 不再每次新建批次。
            // 关联后不传 evaluators (后端用批次原配置), 没关联时沿用老逻辑。
            const body: Record<string, unknown> = { user, taskIds };
            // 数据集作参考集: 收窄后端 trace↔case 匹配范围 (空 = 沿用全量 auto-match)。
            if (caseDatasetIds.length > 0) body.datasetIds = caseDatasetIds;
            if (traceEvaluationBatchId) {
                body.evaluatorRunId = traceEvaluationBatchId;
            } else {
                // 评估器多选决定本次评测调用哪些评估器; 未选时兜底任务完成度。
                body.evaluators = caseEvaluatorIds.length > 0 ? caseEvaluatorIds : ['preset-agent-task-completion'];
            }
            const res = await apiFetch('/api/eval/trajectory/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data?.error || `结果评估入队失败 (HTTP ${res.status})`);
            }
        } catch (e) {
            resultErrors.push(String(e instanceof Error ? e.message : e));
        }
        // 评测入队完成后再跑 analyze-match（轨迹对齐 + Skill 归因 + 统一轨迹分聚合）。
        // 每个 trajectory 任务跑完单独 catch,把错误信息按 taskId 记下来,
        // 之前 throw + Promise.allSettled 只能拿到错误文本但丢失了对应的 taskId,
        // 导致前端没法精确告诉用户"哪条 trace 的轨迹评测因为什么没跑成"。
        const trajectoryErrors = new Map<string, string>();
        const trajRuns = taskIds.map(id => (async () => {
            try {
                const res = await apiFetch(`/api/observe/executions/${encodeURIComponent(id)}/analyze-match`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user, mode: 'compare' }),
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    const errText = data?.error || `analyze-match 失败 (HTTP ${res.status})`;
                    trajectoryErrors.set(id, String(errText));
                }
            } catch (e) {
                trajectoryErrors.set(id, e instanceof Error ? e.message : '网络/解析错误');
            }
        })());
        await Promise.all(trajRuns);
        if (resultErrors.length > 0 || trajectoryErrors.size > 0) {
            console.warn('[skill-eval] batch analyze partial failures:', { resultErrors, trajectoryErrors });
        }
        // 短轮询几轮，让概览卡和详情页都能接住异步落库后的最新分数。
        // 之前是 5 × 900ms = 4.5s 窗口，太短：批量 3 条 trace 时后端 concurrency=3
        // 每条 eval（semantic match + opencode evaluator）通常 10-30s，5s 内只能看
        // 到第 1 条完成，剩下 2 条还在跑前端就停止 poll，造成"显示了一个"假象。
        // 拉长到 30 × 3000ms = 90s 窗口覆盖典型批量评测时长。每次轮询都拉一次
        // trace 列表，状态徽章会实时切换 pending→done。
        await reloadTraces({ retries: 30, retryDelayMs: 3000 });
        return { resultErrors, trajectoryErrors };
    }, [user, reloadTraces, traceEvaluationBatchId, caseEvaluatorIds, caseDatasetIds]);

    /* 拉最近一次灰度任务，做出 Skills 价值评估摘要喂给概览页的灰度卡。
       用 caseStatesJson.{a,b} 直接算 score/time/token/passRate，逻辑与
       grayscale 详情页 aggregateStats 的"无 runs[] 时回退到顶层字段"分支保持一致。 */
    const [graySummary, setGraySummary] = useState<GraySummary | null>(null);
    const [grayTaskMeta, setGrayTaskMeta] = useState<GrayTaskMeta | null>(null);
    const reloadGraySummary = useCallback(async (): Promise<GrayReloadResult> => {
        if (!user) {
            setGraySummary(null);
            setGrayTaskMeta(null);
            return { summary: null, meta: null, busy: false };
        }
        try {
            const res = await apiFetch(`/api/debug/grayscale-tasks?user=${encodeURIComponent(user)}&_ts=${Date.now()}`, { cache: 'no-store' });
            const list = res.ok ? await res.json() : [];
            const selectedVersionId = selectedSkill?.versions?.find(v => v.version === selectedVersion)?.id;
            const matches = Array.isArray(list)
                ? (selectedSkill
                    ? list.filter((t: GrayTaskMeta) => {
                        if (t?.configJson?.skillId !== selectedSkill.id) return false;
                        if (!selectedVersionId) return true;
                        return t?.configJson?.versionBId === selectedVersionId;
                    })
                    : list)
                : [];
            const latest = (matches[0] as GrayTaskMeta | undefined) || null;
            const versionLookup: Record<string, { version: number | string; skillName: string }> = {};
            (selectedSkill?.versions || []).forEach(v => {
                if (v.id) versionLookup[v.id] = { version: v.version, skillName: selectedSkill?.name || 'Skill' };
            });
            const summary = latest ? buildGraySummary(latest, versionLookup, {
                skillName: selectedSkill?.name,
                version: selectedVersion,
            }) : null;
            setGrayTaskMeta(latest);
            setGraySummary(summary);
            return {
                summary,
                meta: latest,
                busy: Boolean(latest?.activeRun) || hasGrayRunningStates(latest?.caseStatesJson),
            };
        } catch {
            setGraySummary(null);
            setGrayTaskMeta(null);
            return { summary: null, meta: null, busy: false };
        }
    }, [user, selectedSkill, selectedVersion]);

    useEffect(() => {
        let timer: ReturnType<typeof setInterval> | null = null;
        let cancelled = false;
        void reloadGraySummary().then(result => {
            if (cancelled || !result.busy) return;
            timer = setInterval(() => {
                void reloadGraySummary();
            }, 2500);
        });
        return () => {
            cancelled = true;
            if (timer) clearInterval(timer);
        };
    }, [reloadGraySummary, resetToken]);

    const handleReset = () => {
        setView('overview');
        setPrefillTraceId('');
        setResetToken(v => v + 1);
        if (selectedSkill) {
            setSelectedVersion(resolveSkillVersion(selectedSkill));
        }
    };

    const traceStats = summarizeTraceMatches(traces);
    const selectedTrace = traces.find(t => getTraceId(t) === selectedTraceId) || null;
    const selectedTraceStats = summarizeTraceMatches(selectedTrace ? [selectedTrace] : []);
    const traceAnalyzed = traceStats.analyzed;
    const staticStats = computeStaticPassRate(staticSummary?.latest ?? null);
    const staticHasResult = !!staticSummary?.latest;
    const triggerHasResult = !!triggerSummary?.latestRun;
    const grayHasResult = !!graySummary && graySummary.b.avgScore != null;
    // 跟详情页 decisionReady 严格对齐: 所有 case-side 都 executed/pass 时才显示分数,
    // 任一 case 还有 running/evaluating/pending/fail 时跟详情页一样显示「等待评估完成」。
    // 之前不带这判断, 卡片用全 task 聚合算分 → 跟详情页 (decisionReady 只看 active case
    // 的 simA/simB 状态) mismatch, 用户看「卡片有分但详情页没分」困惑。
    const grayCaseStates = (grayTaskMeta?.caseStatesJson || {}) as Record<string, { a?: { status?: string }; b?: { status?: string } }>;
    const grayAllSidesReady = Object.keys(grayCaseStates).length > 0
        && Object.values(grayCaseStates).every(s => {
            const ready = (st?: { status?: string }) => st?.status === 'executed' || st?.status === 'pass';
            return ready(s?.a) && ready(s?.b);
        });
    const grayFinalScore = (grayAllSidesReady ? graySummary?.scoring.totalScore : null) ?? null;
    const batchHasResult = false;
    /*
     * 用例分析（trace）卡上展示的分数 = "已评测过的 trace" 的「(结果分 + 轨迹分) / 2」的平均值。
     * 关键约束：每条 trace 只有结果分 + 轨迹分都在时才参与；只跑了一边的不算"已评测"。
     *   - 结果分：trace.answer_score（Execution.answerScore，task-completion 评估器写）
     *   - 轨迹分：getEffectiveTrajScore(trace)（优先方案A聚合分 trajectoryScore，回退 analyze-match 覆盖率）
     * 跟单 trace 详情页 Hero 的口径不一样（详情页只看 LLM 单分），但卡片这层要求双分都备齐
     * 才算"完整评测"，避免被半评测的 trace 拉偏。
     */
    const traceCombinedScores = traces.reduce<{ sum: number; count: number }>((acc, t) => {
        const result = typeof t.answer_score === 'number' ? t.answer_score
            : typeof t.answerScore === 'number' ? t.answerScore : null;
        const traj = getEffectiveTrajScore(t);
        if (result != null && traj != null) {
            acc.sum += (result + traj) / 2;
            acc.count += 1;
        }
        return acc;
    }, { sum: 0, count: 0 });
    const traceHasResult = traceCombinedScores.count > 0;
    // 折成 passed/total = avgPct/100，喂给 health 计算同口径
    const traceCardScore = traceHasResult
        ? { passed: Math.round((traceCombinedScores.sum / traceCombinedScores.count) * 100), total: 100 }
        : null;
    // 综合健康分：把维度均分（0-100%）按 passed/total = avgPct/100 的形式喂给 health 计算，
    // 跟详情页"维度均分"严格同口径。未评估的维度（avgPct=null）的不参与 health。
    const staticCardScore = staticStats.avgPct != null
        ? { passed: staticStats.avgPct, total: 100 }
        : null;
    // 触发卡：直接拿 passRate × itemCount 折成 passed/total，跟其他卡同口径参与 health 计算。
    const triggerCardScore = triggerHasResult && triggerSummary && triggerSummary.itemCount > 0
        ? {
            passed: Math.round(triggerSummary.latestRun!.passRate * triggerSummary.itemCount),
            total: triggerSummary.itemCount,
        }
        : null;
    const grayCardScore = grayFinalScore != null ? { passed: grayFinalScore, total: 100 } : null;
    const cardScores = [traceCardScore, staticCardScore, triggerCardScore, grayCardScore].filter((score): score is { passed: number; total: number } => !!score && score.total > 0);
    const hasAnyAnalysisResult = staticHasResult || traceHasResult || triggerHasResult || grayFinalScore != null;
    const standards = {
        total: cardScores.reduce((sum, score) => sum + score.total, 0),
        passed: cardScores.reduce((sum, score) => sum + score.passed, 0),
    };
    const health = hasAnyAnalysisResult && standards.total > 0
        ? Math.round((standards.passed / standards.total) * 100)
        : null;
    const optimizeHref = selectedSkill && selectedVersion != null
        ? `/skill-opt/${encodeURIComponent(selectedSkill.name)}/${selectedVersion}`
        : '/skill-opt';
    const handleSelectedTraceChange = useCallback((id: string) => {
        setSelectedTraceId(id);
        setPrefillTraceId('');
    }, []);

    // skill + version 统一并入 AppTopBar，让 overview 与 detail views 共用同一导航头。
    const title = (
        <span className="sa-top-title">
            {view === 'overview' ? (
                <span>Skills 评测</span>
            ) : (
                <>
                    <button onClick={() => setView('overview')}>Skills 评测</button>
                    <span>/</span>
                    <b>{viewTitle(view)}</b>
                </>
            )}
            <span className="sa-top-dot">·</span>
            <select
                className="sa-top-select"
                value={selectedSkillId}
                onChange={e => {
                    const next = skills.find(s => s.id === e.target.value);
                    setSelectedSkillId(e.target.value);
                    setSelectedVersion(next ? resolveSkillVersion(next) : null);
                    setView('overview');
                }}
                disabled={skillsLoading}
                aria-label="切换 Skill"
            >
                {skills.length === 0 && <option value="">暂无 Skill</option>}
                {skills.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select
                className="sa-top-select sa-top-select-version"
                value={selectedVersion ?? ''}
                onChange={e => {
                    // 切版本时留在当前视图(用例分析/A-B/静态等), 不再强制跳回 overview —— 方便跨版本对比。
                    setSelectedVersion(Number(e.target.value));
                }}
                disabled={!selectedSkill}
                aria-label="切换版本"
            >
                {sortedVersions.length === 0 && selectedSkill && (
                    <option value={selectedSkill.activeVersion ?? selectedSkill.version ?? 0}>
                        v{selectedSkill.activeVersion ?? selectedSkill.version ?? 0}
                    </option>
                )}
                {sortedVersions.map(v => (
                    <option key={v.version} value={v.version}>
                        v{v.version}{v.version === selectedSkill?.activeVersion ? '（当前）' : ''}
                    </option>
                ))}
            </select>
        </span>
    );

    return (
        <div className="sa-root">
            <AppTopBar
                title={title}
                showDefaultActions={false}
            />

            <main className="sa-main">
                {/* view === 'batch' DetailHeader 分支已删——'batch' 视图整体下线，
                    BatchEvaluation 现作为 trace 模式 ① 配置块"从数据集"子流程的内核 */}
                {view === 'overview' && (
                  <>
                    <AnalysisOverview
                        user={user}
                        selectedSkill={selectedSkill}
                        selectedVersion={selectedVersion}
                        traceEvaluationBatchId={effectiveTraceEvaluationBatchId}
                        traceEvaluationBatchTitle={traceEvaluationBatchTitle}
                        health={health}
                        standards={standards}
                        traces={traces}
                        traceAnalyzed={traceAnalyzed}
                        traceCardUpdatedAt={traceCardUpdatedAt}
                        selectedTrace={selectedTrace}
                        selectedTraceStats={selectedTraceStats}
                        staticSummary={staticSummary}
                        staticLoading={staticLoading}
                        tracesLoading={tracesLoading}
                        hasAnyAnalysisResult={hasAnyAnalysisResult}
                        graySummary={graySummary}
                        grayTaskMeta={grayTaskMeta}
                        triggerSummary={triggerSummary}
                        triggerLoading={triggerLoading}
                        onReloadTraces={reloadTraces}
                        onReloadStatic={reloadStaticSummary}
                        onReloadTrigger={reloadTriggerSummary}
                        onReloadGray={reloadGraySummary}
                        onOpenTriggerEditor={openTriggerEditor}
                        onOpen={setView}
                        smartRunBusy={smartRunBusy}
                        onSmartRunBusyChange={setSmartRunBusy}
                    />
                  </>
                )}

                {view === 'trace' && (
                    <TraceDeviationPanel
                        // key 强制 remount：切 skill / version 时 panel 的内部 state
                        // (triggeredTaskIds / failedTaskIds / evaluatedTaskIds / recovery 轮询 timer 等)
                        // 全部重置——否则上个版本的状态会泄漏到新版本视图，用户看到"切了版本下面没变"。
                        key={`tracepanel_${selectedSkill?.id || 'noskill'}_${selectedVersion ?? 'all'}`}
                        skill={selectedSkill}
                        version={selectedVersion}
                        user={user}
                        traces={traces}
                        loading={tracesLoading}
                        prefillTraceId={prefillTraceId}
                        selectedTraceId={selectedTraceId}
                        onSelectedTraceChange={handleSelectedTraceChange}
                        onBack={() => setView('overview')}
                        onReload={reloadTraces}
                        onOptimize={() => router.push(optimizeHref)}
                        onBatchAnalyze={runBatchTraceAnalysis}
                        traceEvaluationBatchId={effectiveTraceEvaluationBatchId}
                        traceEvaluationBatchTitle={traceEvaluationBatchTitle}
                        onOpenEvalBatchDialog={() => setNewBatchDialogOpen(true)}
                        evalTaskOptions={caseEvalTasksForSkill}
                        onSelectEvalBatch={handleSelectTraceEvalBatch}
                        datasets={caseDatasets}
                        selectedDatasetIds={caseDatasetIds}
                        onSelectedDatasetIdsChange={handleCaseDatasetIdsChange}
                        evaluatorOptions={[
                            ...presetEvaluators.filter(e => e.status === 'ready').map(e => ({ id: e.id, name: e.name })),
                            ...caseUserEvaluators,
                        ]}
                        selectedEvaluatorIds={caseEvaluatorIds}
                        onSelectedEvaluatorIdsChange={handleCaseEvaluatorIdsChange}
                    />
                )}

                {view === 'static' && (
                    <StaticCompliancePanel
                        skill={selectedSkill}
                        version={selectedVersion}
                        user={user}
                        summary={staticSummary}
                        loading={staticLoading}
                        onBack={() => setView('overview')}
                        onReload={reloadStaticSummary}
                        onOptimize={() => router.push(optimizeHref)}
                    />
                )}

                {view === 'gray' && (
                    <EmbeddedDebugPanel
                        title="A/B测试"
                        description="对照两个 Skill 版本或基础 Agent 的执行质量，定位新版本是否真正修复了关键失败类型。"
                        primaryAction="发起新一轮"
                        secondaryAction="历史任务"
                        onBack={() => setView('overview')}
                        onPrimary={() => setGrayNewTaskTrigger(v => v + 1)}
                        onSecondary={() => setGrayHistoryTrigger(v => v + 1)}
                        onOptimize={() => router.push(optimizeHref)}
                        renderHeader="none"
                    >
                        <GrayscaleEvaluation
                            hifi
                            newTaskTrigger={grayNewTaskTrigger}
                            historyPanelTrigger={grayHistoryTrigger}
                            pageTitle="A/B测试"
                            pageDescription="对照两个 Skill 版本或基础 Agent 的执行质量，定位新版本是否真正修复了关键失败类型。"
                            pageBadge="调测分析"
                            onBack={() => setView('overview')}
                            onOptimize={() => router.push(optimizeHref)}
                            parentSkillId={selectedSkillId}
                            parentSkillVersion={selectedVersion}
                            skillSelectorSlot={(() => {
                                const isCurrent = selectedVersion != null && selectedVersion === (selectedSkill?.activeVersion ?? selectedSkill?.version);
                                const showWarn = health != null && health < 60;
                                const iconText = (selectedSkill?.name || 'SKL').replace(/[^a-zA-Z0-9]/g, '').slice(0, 3).toUpperCase() || 'SKL';
                                return (
                                    <section className="sa-selector sa-selector-hifi" aria-label="选择skill">
                                        <div className="sa-skill-icon">{iconText}</div>
                                        <div className="sa-skill-info">
                                            <div className="sa-skill-name-row">
                                                <span className="sa-skill-name">{selectedSkill?.name || '请选择 Skill'}</span>
                                                {selectedVersion != null && (
                                                    <span className={`sa-skill-version-chip ${isCurrent ? '' : 'muted'}`}>
                                                        v{selectedVersion}{isCurrent ? ' · 当前' : ''}
                                                    </span>
                                                )}
                                                {showWarn && (
                                                    <span className="sa-skill-warn-badge">
                                                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L1 21h22L12 2z"/></svg>
                                                        {health != null && health < 60 && health >= 40 ? '需关注' : '急需优化'}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="sa-skill-stats">
                                                <span className="stat"><strong>{traces.length}</strong> 条执行</span>
                                                <span className="stat">最近 <strong>{LOOKBACK_DAYS}</strong> 天</span>
                                                <span className="stat"><strong>4</strong> 个评估器</span>
                                                <span className="stat"><strong>19</strong> 项标准</span>
                                                {selectedSkill?.updatedAt && (
                                                    <span className="stat">发布于 <strong>{formatShortDate(selectedSkill.updatedAt)}</strong></span>
                                                )}
                                            </div>
                                        </div>
                                        <div className="sa-skill-switchers">
                                            <select
                                                value={selectedSkillId}
                                                onChange={e => {
                                                    const next = skills.find(s => s.id === e.target.value);
                                                    setSelectedSkillId(e.target.value);
                                                    setSelectedVersion(next ? resolveSkillVersion(next) : null);
                                                }}
                                                disabled={skillsLoading}
                                                aria-label="切换 Skill"
                                            >
                                                {skills.length === 0 && <option value="">暂无 Skill</option>}
                                                {skills.map(skill => <option key={skill.id} value={skill.id}>{skill.name}</option>)}
                                            </select>
                                            <select
                                                value={selectedVersion ?? ''}
                                                onChange={e => setSelectedVersion(Number(e.target.value))}
                                                disabled={!selectedSkill}
                                                aria-label="切换版本"
                                            >
                                                {sortedVersions.length === 0 && selectedSkill && (
                                                    <option value={selectedSkill.activeVersion ?? selectedSkill.version ?? 0}>
                                                        v{selectedSkill.activeVersion ?? selectedSkill.version ?? 0}
                                                    </option>
                                                )}
                                                {sortedVersions.map(v => (
                                                    <option key={v.version} value={v.version}>
                                                        v{v.version}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                    </section>
                                );
                            })()}
                        />
                    </EmbeddedDebugPanel>
                )}

                {/* view === 'batch' EmbeddedDebugPanel 分支已删 */}
            </main>

            {/* 新增评测任务对话框 (trace 模式 ① actions 按钮触发, dataset 模式 BatchEvaluation 自己挂另一个 dialog).
                跨视图浮窗, 跟 main 同级避免被 sa-detail overflow 截掉。 */}
            <NewEvaluationBatchDialog
                open={newBatchDialogOpen}
                user={user || ''}
                defaultTitle={traceEvaluationBatchTitle || (selectedSkill ? `${selectedSkill.name} trace 评测` : undefined)}
                evaluators={caseEvaluatorIds}
                onClose={() => setNewBatchDialogOpen(false)}
                onCreated={handleTraceEvalBatchCreated}
            />
        </div>
    );
}

// ──────────────── Background opencode task status (banner helpers) ────────────────
//
// 数据源：GET /api/background-tasks，背后是 concurrency-limiter 的 ring buffer
// (queued + running + 最近 5min done/failed)。
// 用法：在卡片头下方挂一条小条状态条，把 queued/running/done/failed 的实时计数
// 渲染出来；全空闲时不渲染，避免 idle 卡片视觉污染。
interface BackgroundTaskCounts {
    queued: number;
    running: number;
    done: number;
    failed: number;
}

const EMPTY_TASK_COUNTS: BackgroundTaskCounts = { queued: 0, running: 0, done: 0, failed: 0 };

function useBackgroundTaskCounts(opts: {
    user: string | null;
    skillName?: string;
    skillVersion?: number | null;
    taskType?: string;
    enabled?: boolean;
}): BackgroundTaskCounts {
    const { user, skillName, skillVersion, taskType, enabled = true } = opts;
    const [counts, setCounts] = useState<BackgroundTaskCounts>(EMPTY_TASK_COUNTS);

    useEffect(() => {
        if (!enabled || !user) {
            setCounts(EMPTY_TASK_COUNTS);
            return;
        }
        let cancelled = false;
        const qs = new URLSearchParams({ user });
        if (skillName) qs.set('skill', skillName);
        if (skillVersion != null) qs.set('version', String(skillVersion));
        if (taskType) qs.set('taskType', taskType);
        const url = `/api/background-tasks?${qs.toString()}`;

        const fetchOnce = async () => {
            try {
                const res = await apiFetch(url, { cache: 'no-store' });
                if (!res.ok) return;
                const data = await res.json();
                if (!cancelled) setCounts(data?.counts ?? EMPTY_TASK_COUNTS);
            } catch {
                // 网络抖动忽略；下个 tick 自动恢复
            }
        };

        fetchOnce();
        const timer = setInterval(fetchOnce, 2500);
        return () => { cancelled = true; clearInterval(timer); };
    }, [user, skillName, skillVersion, taskType, enabled]);

    return counts;
}

function TaskQueueBanner({ counts, hint }: { counts: BackgroundTaskCounts; hint?: string }) {
    const { queued, running, done, failed } = counts;
    if (queued + running + done + failed === 0) return null;
    return (
        <div
            style={{
                display: 'flex',
                gap: 10,
                padding: '6px 10px',
                margin: '8px 0 0',
                background: 'var(--background-secondary)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                fontSize: 11,
                color: 'var(--foreground-secondary)',
                alignItems: 'center',
                flexWrap: 'wrap',
            }}
            title={hint || '后台 opencode 任务状态（2.5s 刷新一次；近 5 分钟内完成的会短暂保留显示）'}
        >
            {queued > 0 && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ca8a04' }} />
                    排队 <b style={{ color: 'var(--foreground)' }}>{queued}</b>
                </span>
            )}
            {running > 0 && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#2563eb' }} />
                    执行中 <b style={{ color: 'var(--foreground)' }}>{running}</b>
                </span>
            )}
            {done > 0 && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#16a34a' }} />
                    已完成 <b style={{ color: 'var(--foreground)' }}>{done}</b>
                </span>
            )}
            {failed > 0 && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#dc2626' }} />
                    失败 <b style={{ color: 'var(--foreground)' }}>{failed}</b>
                </span>
            )}
        </div>
    );
}

function AnalysisOverview({
    user,
    selectedSkill,
    selectedVersion,
    traceEvaluationBatchId,
    traceEvaluationBatchTitle,
    health,
    standards,
    traces,
    traceAnalyzed,
    traceCardUpdatedAt,
    selectedTrace,
    selectedTraceStats,
    staticSummary,
    staticLoading,
    tracesLoading,
    hasAnyAnalysisResult,
    graySummary,
    grayTaskMeta,
    triggerSummary,
    triggerLoading,
    onReloadTraces,
    onReloadStatic,
    onReloadTrigger,
    onReloadGray,
    onOpenTriggerEditor,
    onOpen,
    smartRunBusy,
    onSmartRunBusyChange,
}: {
    user: string | null;
    selectedSkill: SkillOption | null;
    selectedVersion: number | null;
    traceEvaluationBatchId?: string;
    traceEvaluationBatchTitle?: string;
    health: number | null;
    standards: { total: number; passed: number };
    traces: TraceRecord[];
    traceAnalyzed: number;
    traceCardUpdatedAt: string | null;
    selectedTrace: TraceRecord | null;
    selectedTraceStats: ReturnType<typeof summarizeTraceMatches>;
    staticSummary: StaticSummary | null;
    staticLoading: boolean;
    tracesLoading: boolean;
    hasAnyAnalysisResult: boolean;
    graySummary: GraySummary | null;
    grayTaskMeta: GrayTaskMeta | null;
    triggerSummary: TriggerSummary | null;
    triggerLoading: boolean;
    onReloadTraces: (options?: TraceReloadOptions) => Promise<TraceRecord[]>;
    onReloadStatic: (options?: StaticSummaryReloadOptions) => Promise<StaticSummary | null>;
    onReloadTrigger: (options?: TriggerSummaryReloadOptions) => Promise<TriggerSummary | null>;
    onReloadGray: () => Promise<GrayReloadResult>;
    onOpenTriggerEditor: () => void;
    onOpen: (view: AnalysisView) => void;
    smartRunBusy: boolean;
    onSmartRunBusyChange: (busy: boolean) => void;
}) {
    // 后台 opencode 任务实时状态——给 A/B 卡和 触发 卡顶部的 banner 喂数。
    // 静态合规走 LLM/linter，不过 concurrency-limiter，不需要这条线。
    // A/B 不按 taskType 过滤：它在跑时会同时驱动 trajectory-eval +
    // task-completion-eval + custom-llm-eval 多个 task 类型，这里直接看
    // 「本 skill+version 维度上所有 opencode 后台任务」整体即可。
    const grayTaskCounts = useBackgroundTaskCounts({
        user,
        skillName: selectedSkill?.name,
        skillVersion: selectedVersion,
        enabled: !!selectedSkill,
    });
    const triggerTaskCounts = useBackgroundTaskCounts({
        user,
        skillName: selectedSkill?.name,
        skillVersion: selectedVersion,
        taskType: 'trigger-eval',
        enabled: !!selectedSkill,
    });

    const staticStats = computeStaticPassRate(staticSummary?.latest ?? null);
    const staticHasResult = !!staticSummary?.latest;
    const traceStats = summarizeTraceMatches(traces);
    const highDeviation = traceStats.highDeviation;
    const [selectedTraceEvalUpdatedAt, setSelectedTraceEvalUpdatedAt] = useState<string | null>(null);
    const selectedTraceId = selectedTrace ? getTraceId(selectedTrace) : '';
    const selectedTraceScoreLabel = selectedTraceStats.totalSteps > 0
        ? `${selectedTraceStats.matchedSteps}/${selectedTraceStats.totalSteps}`
        : '--';
    // 用例分析卡片的"已分析/分数"口径：每条 trace 只有结果分(answer_score) + 轨迹分
    // (flow-parser overallScore) 双双就绪时才算"已完整评测"。卡片大数=已完整评测 trace
    // 的「(结果分+轨迹分)/2」平均值。只跑了一边的不算，避免半评测拉偏。
    const traceCardAgg = traces.reduce<{ sum: number; count: number }>((acc, t) => {
        const result = typeof t.answer_score === 'number' ? t.answer_score
            : typeof t.answerScore === 'number' ? t.answerScore : null;
        const traj = getEffectiveTrajScore(t);
        if (result != null && traj != null) {
            acc.sum += (result + traj) / 2;
            acc.count += 1;
        }
        return acc;
    }, { sum: 0, count: 0 });
    const fullyEvaluatedCount = traceCardAgg.count;
    const traceCardHasResult = fullyEvaluatedCount > 0;
    // 用例分析卡片口径：绑定当前关联的「评测任务」(traceEvaluationBatchId)，
    // 分数/用例数只统计该任务下的评测记录——与详情页 ③ 总评分同口径，
    // 而非该 skill 版本全部 trace 的平均。未关联任务时卡片提示先去关联。
    const hasEvalTask = !!traceEvaluationBatchId;
    const cardEvalResultsMap = useBatchEvalResults(user, traceEvaluationBatchId, 5000);
    const cardEvalMetas = hasEvalTask ? Array.from(cardEvalResultsMap.values()) : [];
    const cardEvalValid = cardEvalMetas.filter(m => typeof m.resultScore === 'number' && typeof m.trajScore === 'number') as { resultScore: number; trajScore: number }[];
    const cardEvalDone = cardEvalValid.length;
    const cardEvalTotal = cardEvalMetas.length;
    const cardEvalScore = cardEvalDone === 0 ? null
        : Math.round(cardEvalValid.reduce((sum, m) => sum + (m.resultScore + m.trajScore) / 2, 0) / cardEvalDone);
    const cardEvalStatus = !hasEvalTask ? '未关联' : cardEvalScore == null ? '待评测' : cardEvalScore >= 60 ? '正常' : '需关注';
    const traceLatestUpdatedAt = traces.reduce<string | null>((latest, t) => {
        const result = typeof t.answer_score === 'number' ? t.answer_score
            : typeof t.answerScore === 'number' ? t.answerScore : null;
        const traj = getEffectiveTrajScore(t);
        if (result == null || traj == null) return latest;
        const candidate = t.execution_match?.matchedAt || t.timestamp || null;
        if (!candidate) return latest;
        if (!latest) return candidate;
        return new Date(candidate).getTime() > new Date(latest).getTime() ? candidate : latest;
    }, null);
    useEffect(() => {
        if (!user || !selectedTraceId) {
            setSelectedTraceEvalUpdatedAt(null);
            return;
        }
        let cancelled = false;
        apiFetch(
            `/api/eval/trajectory/results?user=${encodeURIComponent(user)}&taskId=${encodeURIComponent(selectedTraceId)}&limit=1`,
            { cache: 'no-store' },
        )
            .then(res => res.ok ? res.json() : null)
            .then(data => {
                if (cancelled) return;
                const latest = (Array.isArray(data?.results) ? data.results : [])[0] as { updatedAt?: string } | undefined;
                setSelectedTraceEvalUpdatedAt(latest?.updatedAt || null);
            })
            .catch(() => {
                if (!cancelled) setSelectedTraceEvalUpdatedAt(null);
            });
        return () => {
            cancelled = true;
        };
    }, [selectedTraceId, traceCardUpdatedAt, user]);
    const traceCardFooterAt = traceCardHasResult
        ? (selectedTraceEvalUpdatedAt || traceCardUpdatedAt || traceLatestUpdatedAt)
        : null;
    const traceHasCompleteCardData = traces.length > 0 && fullyEvaluatedCount === traces.length;
    const tracePrimarySkill = selectedTrace ? getTracePrimarySkill(selectedTrace) : null;
    const traceCanTest = !!selectedTraceId && !!tracePrimarySkill?.name;

    /* ─────────────────────────────────────────────────────────
       综合诊断三栏的业务计算
       核心理念：评测覆盖不全时不直接说"X 项不符合"——那个数字
       会误导用户。改用"置信加权"，只对已跑过的评估器加权计算；
       未跑过的维度通过覆盖度条暴露，主 CTA 引导用户先把测评
       跑全再决定是否优化。设计文档：mockup/skill-analysis.html
       ───────────────────────────────────────────────────────── */
    const triggerHasSet = !!triggerSummary?.hasSet;
    const triggerHasResult = !!triggerSummary?.latestRun;
    const triggerCanTest = triggerHasSet && (triggerSummary?.itemCount ?? 0) > 0;
    const grayHasResult = !!graySummary && graySummary.b.avgScore != null;
    // 跟详情页 decisionReady 严格对齐: 所有 case-side 都 executed/pass 时才显示分数,
    // 任一 case 还有 running/evaluating/pending/fail 时跟详情页一样显示「等待评估完成」。
    // 之前不带这判断, 卡片用全 task 聚合算分 → 跟详情页 (decisionReady 只看 active case
    // 的 simA/simB 状态) mismatch, 用户看「卡片有分但详情页没分」困惑。
    const grayCaseStates = (grayTaskMeta?.caseStatesJson || {}) as Record<string, { a?: { status?: string }; b?: { status?: string } }>;
    const grayAllSidesReady = Object.keys(grayCaseStates).length > 0
        && Object.values(grayCaseStates).every(s => {
            const ready = (st?: { status?: string }) => st?.status === 'executed' || st?.status === 'pass';
            return ready(s?.a) && ready(s?.b);
        });
    const grayFinalScore = (grayAllSidesReady ? graySummary?.scoring.totalScore : null) ?? null;
    const grayPreparedSampleCount = (
        grayTaskMeta?.configJson?.checkedCaseIds
        ?? grayTaskMeta?.configJson?.selectedCaseIds
        ?? []
    ).length;
    const grayRunButtonBusy = Boolean(grayTaskMeta?.activeRun) || hasGrayRunningStates(grayTaskMeta?.caseStatesJson);
    const grayStartButtonEnabled = grayPreparedSampleCount > 0 && !grayRunButtonBusy;
    const grayCanTest = !!grayTaskMeta?.id && grayStartButtonEnabled;
    const staticCanTest = !!selectedSkill && selectedVersion != null;
    type DxRunState = { key: SelectedRunKey; name: string; hasResult: boolean; canRun: boolean; runHint: string };
    const evalRunStates: DxRunState[] = [
        {
            key: 'trace',
            name: '用例分析',
            hasResult: traceCardHasResult,
            canRun: traceCanTest,
            runHint: traceCanTest
                ? '当前 Trace 可分析'
                : traces.length === 0
                    ? '暂无 Trace 可分析'
                    : !selectedTrace
                        ? '需先选择 Trace'
                        : !tracePrimarySkill?.name
                            ? '当前 Trace 未加载主 Skill，无法分析'
                            : '待分析 · 需先进入详情页完成评测',
        },
        {
            key: 'static',
            name: '静态合规',
            hasResult: staticHasResult,
            canRun: staticCanTest,
            runHint: staticCanTest ? '可启动静态扫描' : '待分析 · 需先选择 Skill 与版本',
        },
        {
            key: 'trigger',
            name: '触发分析',
            hasResult: triggerHasResult,
            canRun: triggerCanTest,
            runHint: !triggerHasSet
                ? '未配置 · 需先准备触发集'
                : triggerCanTest
                    ? '触发集已准备 · 可立即评测'
                    : '触发集为空 · 需先补充数据',
        },
        {
            key: 'gray',
            name: 'A/B测试',
            hasResult: grayFinalScore != null,
            canRun: grayCanTest,
            runHint: grayCanTest
                ? '开始执行可点击'
                : grayRunButtonBusy
                    ? '执行中 · 当前 A/B 任务不可重复启动'
                    : grayPreparedSampleCount === 0
                        ? '未配置 · 需先在详情页选择样本'
                        : '未配置 · 需先保存 A/B 任务',
        },
    ];
    const coveredCount = evalRunStates.filter(s => s.hasResult).length;
    const totalEvaluators = evalRunStates.length;
    const dxOptimizeHref = selectedSkill && selectedVersion != null
        ? `/skill-opt/${encodeURIComponent(selectedSkill.name)}/${selectedVersion}`
        : '/skill-opt';
    const scoreTier: 'ok' | 'warn' | 'err' | 'idle' =
        !hasAnyAnalysisResult || health == null
            ? 'idle'
            : coveredCount < totalEvaluators
                ? 'warn'
                : health >= 80
                    ? 'ok'
                    : health >= 60
                        ? 'warn'
                        : 'err';
    const tierLabel = !hasAnyAnalysisResult
        ? '尚未运行任何评估'
        : coveredCount < totalEvaluators
            ? `数据不足 · 仅 ${coveredCount}/${totalEvaluators} 评估器有结果`
            : health! >= 80 ? '健康' : health! >= 60 ? '需关注' : '急需优化';
    const defaultDiagnosis: SkillDiagnosisResult = {
        problem: '还没有任何分析结果，当前页面先展示基础信息和可执行入口。',
        suggestion: '优先补齐可运行维度，再查看更稳定的诊断结论。',
        mode: 'fallback',
    };
    const [diagnosisResult, setDiagnosisResult] = useState<SkillDiagnosisResult | null>(null);
    const [diagnosisStatus, setDiagnosisStatus] = useState<DiagnosisUiStatus>('idle');
    const [smartRunPhase, setSmartRunPhase] = useState<SmartRunPhase>('idle');
    const selectableKeys = evalRunStates.filter(s => s.canRun).map(s => s.key);
    const [selectedRunKeys, setSelectedRunKeys] = useState<Array<DxRunState['key']>>(selectableKeys);
    useEffect(() => {
        setSelectedRunKeys(selectableKeys);
    }, [selectableKeys.join('|')]);
    const buildDiagnosisSnapshot = useCallback((overrides?: {
        traces?: TraceRecord[];
        staticSummary?: StaticSummary | null;
        triggerSummary?: TriggerSummary | null;
        graySummary?: GraySummary | null;
        grayTaskMeta?: GrayTaskMeta | null;
        traceBusy?: boolean;
        grayBusy?: boolean;
        selectedDimensionsThisRun?: SelectedRunKey[];
    }): SkillDiagnosisSnapshot | null => {
        if (!selectedSkill) return null;

        const tracesData = overrides?.traces ?? traces;
        const staticData = overrides?.staticSummary ?? staticSummary;
        const triggerData = overrides?.triggerSummary ?? triggerSummary;
        const grayData = overrides?.graySummary ?? graySummary;
        const grayMeta = overrides?.grayTaskMeta ?? grayTaskMeta;
        const traceBusyValue = overrides?.traceBusy ?? tracesData.some(t => t.is_evaluating);
        const grayBusyValue = overrides?.grayBusy ?? (Boolean(grayMeta?.activeRun) || hasGrayRunningStates(grayMeta?.caseStatesJson));

        const traceAgg = tracesData.reduce<{ sum: number; count: number }>((acc, t) => {
            const result = typeof t.answer_score === 'number' ? t.answer_score
                : typeof t.answerScore === 'number' ? t.answerScore : null;
            const traj = getEffectiveTrajScore(t);
            if (result != null && traj != null) {
                acc.sum += (result + traj) / 2;
                acc.count += 1;
            }
            return acc;
        }, { sum: 0, count: 0 });
        const traceScore = traceAgg.count > 0 ? Math.round((traceAgg.sum / traceAgg.count) * 100) : null;
        const traceStatsLocal = summarizeTraceMatches(tracesData);
        const staticStatsLocal = computeStaticPassRate(staticData?.latest ?? null);
        const triggerHasSetLocal = !!triggerData?.hasSet;
        const triggerHasResultLocal = !!triggerData?.latestRun;
        const selectedTraceLocal = tracesData.find(t => getTraceId(t) === selectedTraceId) || selectedTrace;
        const grayPreparedSamples = (
            grayMeta?.configJson?.checkedCaseIds
            ?? grayMeta?.configJson?.selectedCaseIds
            ?? []
        ).length;
        const traceConfigured = !!selectedTraceId && !!(selectedTraceLocal ? getTracePrimarySkill(selectedTraceLocal)?.name : null);
        const missingDimensions: string[] = [];
        if (!(grayData && grayData.scoring.totalScore != null)) missingDimensions.push('ab');
        if (traceScore == null) missingDimensions.push('trace');
        if (!triggerHasResultLocal) missingDimensions.push('recall');
        if (staticStatsLocal.avgPct == null) missingDimensions.push('static');

        const toStatus = (configured: boolean, hasResult: boolean, running: boolean, failed = false): DiagnosisDimensionStatus => {
            if (running) return 'running';
            if (failed) return 'failed';
            if (!configured) return 'unconfigured';
            if (hasResult) return 'done';
            return 'pending';
        };

        return {
            skillName: selectedSkill.name,
            version: selectedVersion,
            overall: {
                weightedScore: health,
                coveredCount: totalEvaluators - missingDimensions.length,
                totalCount: totalEvaluators,
                missingDimensions,
                selectedDimensionsThisRun: (overrides?.selectedDimensionsThisRun ?? []).map(key =>
                    key === 'gray' ? 'ab' : key === 'trigger' ? 'recall' : key
                ) as DiagnosisDimensionKey[],
            },
            ab: {
                configured: !!grayMeta?.id && grayPreparedSamples > 0,
                hasResult: !!grayData && grayData.scoring.totalScore != null,
                status: toStatus(!!grayMeta?.id && grayPreparedSamples > 0, !!grayData && grayData.scoring.totalScore != null, grayBusyValue),
                scoreA: grayData?.a.avgScore ?? null,
                scoreB: grayData?.scoring.totalScore ?? null,
                finalScore: grayData?.scoring.totalScore ?? null,
                decisionLabel: grayData?.scoring.decisionLabel ?? null,
                capabilityDeltaPp: grayData?.scoring.capability.deltaPp ?? null,
                tokenDeltaPct: grayData?.scoring.cost.deltaTokenPct ?? null,
                invokeRate: grayData?.scoring.stability.invokeRate ?? null,
                variance: grayData?.scoring.stability.variance ?? null,
                delta: grayData?.delta ?? null,
                pValue: grayData?.pValue ?? null,
                sampleCount: grayData?.sampleCount ?? null,
                recommendation: grayData?.recommendation ?? null,
            },
            trace: {
                configured: traceConfigured,
                hasResult: traceScore != null,
                status: toStatus(traceConfigured, traceScore != null, traceBusyValue),
                score: traceScore,
                fullyEvaluatedCount: traceAgg.count,
                totalTraceCount: tracesData.length,
                highDeviationCount: traceStatsLocal.highDeviation,
            },
            recall: {
                configured: triggerHasSetLocal,
                hasResult: triggerHasResultLocal,
                status: toStatus(triggerHasSetLocal, triggerHasResultLocal, false),
                score: triggerHasResultLocal ? Math.round((triggerData?.latestRun?.passRate ?? 0) * 100) : null,
                passRate: triggerData?.latestRun?.passRate ?? null,
                truePositiveRate: triggerData?.latestRun?.truePositiveRate ?? null,
                falsePositiveRate: triggerData?.latestRun?.falsePositiveRate ?? null,
                itemCount: triggerData?.itemCount ?? 0,
                positiveCount: triggerData?.positiveCount ?? 0,
            },
            static: {
                configured: !!selectedSkill && selectedVersion != null,
                hasResult: staticStatsLocal.avgPct != null,
                status: toStatus(!!selectedSkill && selectedVersion != null, staticStatsLocal.avgPct != null, false),
                score: staticStatsLocal.avgPct ?? null,
                passedCount: staticStatsLocal.scoredCount,
                totalCount: STATIC_EVAL_STANDARDS.length,
                issueCount: staticData?.latest?.issuesCount ?? 0,
            },
        };
    }, [
        graySummary,
        grayTaskMeta,
        health,
        selectedSkill,
        selectedTrace,
        selectedTraceId,
        selectedVersion,
        standards.passed,
        standards.total,
        staticSummary,
        totalEvaluators,
        traces,
        triggerSummary,
    ]);
    const diagnosisSnapshot = useMemo(() => buildDiagnosisSnapshot(), [buildDiagnosisSnapshot]);
    const diagnosisSignature = useMemo(
        () => (diagnosisSnapshot ? JSON.stringify(diagnosisSnapshot) : ''),
        [diagnosisSnapshot],
    );
    const lastDiagnosisSignatureRef = useRef('');
    const diagnosisRequestSeqRef = useRef(0);
    const refreshDiagnosis = useCallback(async (
        snapshot: SkillDiagnosisSnapshot | null,
        trigger: 'auto' | 'smart-run',
    ) => {
        if (!snapshot || !user || !selectedSkill?.name) {
            setDiagnosisResult(null);
            setDiagnosisStatus('idle');
            return null;
        }
        const requestSeq = ++diagnosisRequestSeqRef.current;
        setDiagnosisStatus('loading');
        try {
            const res = await apiFetch(`/api/skills/by-name/${encodeURIComponent(selectedSkill.name)}/analysis-diagnosis`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user, snapshot }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data?.diagnosis) {
                throw new Error(data?.error || '诊断生成失败');
            }
            const next = data.diagnosis as SkillDiagnosisResult;
            if (requestSeq === diagnosisRequestSeqRef.current) {
                setDiagnosisResult(next);
                setDiagnosisStatus('ready');
            }
            if (trigger === 'smart-run' && next.mode === 'fallback') {
                toast.warning('AI 诊断暂时不可用，已回退为基础诊断');
            }
            return next;
        } catch {
            const fallback = buildFallbackDiagnosis(snapshot);
            if (requestSeq === diagnosisRequestSeqRef.current) {
                setDiagnosisResult(fallback);
                setDiagnosisStatus('ready');
            }
            if (trigger === 'smart-run') {
                toast.warning('AI 诊断暂时不可用，已回退为基础诊断');
            }
            return fallback;
        }
    }, [selectedSkill?.name, user]);
    useEffect(() => {
        if (!diagnosisSnapshot || smartRunBusy || smartRunPhase !== 'idle') return;
        if (diagnosisSignature === lastDiagnosisSignatureRef.current) return;
        lastDiagnosisSignatureRef.current = diagnosisSignature;
        diagnosisRequestSeqRef.current += 1;
        setDiagnosisResult(buildFallbackDiagnosis(diagnosisSnapshot));
        setDiagnosisStatus('ready');
    }, [diagnosisSignature, diagnosisSnapshot, smartRunBusy, smartRunPhase]);
    const narrative = diagnosisResult ?? (diagnosisSnapshot ? buildFallbackDiagnosis(diagnosisSnapshot) : defaultDiagnosis);

    const startGrayRunFromOverview = async () => {
        const caseIds = grayTaskMeta?.configJson?.checkedCaseIds
            ?? grayTaskMeta?.configJson?.selectedCaseIds
            ?? [];
        if (!user || !grayTaskMeta?.id || caseIds.length === 0) {
            throw new Error('A/B 测试当前缺少可执行样本或任务信息。');
        }
        const res = await apiFetch(`/api/debug/grayscale-tasks/${encodeURIComponent(grayTaskMeta.id)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user,
                action: 'start',
                caseIds,
                evaluatorId: grayTaskMeta.configJson?.evaluatorId,
                agentMaxConcurrency: grayTaskMeta.configJson?.agentMaxConcurrency,
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data.error || 'A/B 测试启动失败');
        }
    };

    const startTraceRunFromOverview = async () => {
        if (!user || !selectedTraceId || !tracePrimarySkill?.name) {
            throw new Error('用例分析当前缺少可执行 Trace 或主 Skill 信息。');
        }
        const resultPromise = (async () => {
            const res = await apiFetch('/api/eval/trajectory/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user,
                    taskIds: [selectedTraceId],
                    evaluators: ['preset-agent-task-completion'],
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                throw new Error(data.error || '启动结果评估失败');
            }
        })();
        const tracePromise = (async () => {
            const analyzeRes = await apiFetch(`/api/observe/executions/${encodeURIComponent(selectedTraceId)}/analyze-match`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user, mode: 'compare' }),
            });
            const analyzeData = await analyzeRes.json().catch(() => ({}));
            if (!analyzeRes.ok || !analyzeData.success) {
                throw new Error(analyzeData.error || '流程图比对分析失败');
            }
        })();
        const outcomes = await Promise.allSettled([resultPromise, tracePromise]);
        const failures = outcomes.filter((item): item is PromiseRejectedResult => item.status === 'rejected');
        if (failures.length === outcomes.length) {
            throw new Error(failures[0]?.reason instanceof Error ? failures[0].reason.message : '用例分析启动失败');
        }
        if (failures.length > 0) {
            throw new Error(failures.map(item => item.reason instanceof Error ? item.reason.message : '部分流程启动失败').join('；'));
        }
        await onReloadTraces({ retries: 5, retryDelayMs: 900 });
    };

    const startTriggerRunFromOverview = async () => {
        if (!user || !selectedSkill?.name) {
            throw new Error('触发分析当前缺少 Skill 信息。');
        }
        const res = await apiFetch(`/api/skill-eval/trigger/${encodeURIComponent(selectedSkill.name)}/run`, {
            method: 'POST',
            body: JSON.stringify({
                user,
                runsPerQuery: 1,
                triggerThreshold: 0.5,
                timeoutMs: 30000,
                concurrency: 5,
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data.error || '触发分析启动失败');
        }
        await onReloadTrigger({
            expectedRunId: typeof data?.run?.id === 'string' ? data.run.id : undefined,
        });
    };

    const startStaticRunFromOverview = async () => {
        if (!user || !selectedSkill?.id || selectedVersion == null) {
            throw new Error('静态合规当前缺少 Skill 或版本信息。');
        }
        const res = await apiFetch(`/api/skills/${encodeURIComponent(selectedSkill.id)}/versions/${selectedVersion}/evaluate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data.error || '静态合规启动失败');
        }
        await onReloadStatic({
            expectedEvaluationId: typeof data.evaluationId === 'string' ? data.evaluationId : undefined,
        });
    };

    const waitForSelectedRuns = async (successfulKeys: SelectedRunKey[]) => {
        let latestTraces = traces;
        let latestStatic = staticSummary;
        let latestTrigger = triggerSummary;
        let latestGray = graySummary;
        let latestGrayMeta = grayTaskMeta;
        let grayBusy = grayRunButtonBusy;
        let traceBusy = traces.some(t => t.is_evaluating);

        if (successfulKeys.includes('static')) {
            latestStatic = await onReloadStatic({ retries: 1, retryDelayMs: 800 }) ?? latestStatic;
        }
        if (successfulKeys.includes('trigger')) {
            latestTrigger = await onReloadTrigger({ retries: 1, retryDelayMs: 800 }) ?? latestTrigger;
        }

        const shouldPollBackground = successfulKeys.includes('gray') || successfulKeys.includes('trace');
        const deadline = Date.now() + 90_000;
        let timedOut = false;

        while (shouldPollBackground && Date.now() < deadline) {
            let pending = false;

            if (successfulKeys.includes('gray')) {
                const grayState = await onReloadGray();
                latestGray = grayState.summary;
                latestGrayMeta = grayState.meta;
                grayBusy = grayState.busy;
                pending = pending || grayBusy;
            }

            if (successfulKeys.includes('trace')) {
                latestTraces = await onReloadTraces({ retries: 1, retryDelayMs: 800 });
                const traceRow = latestTraces.find(t => getTraceId(t) === selectedTraceId);
                const resultScore = traceRow
                    ? (typeof traceRow.answer_score === 'number' ? traceRow.answer_score : traceRow.answerScore)
                    : null;
                const traceTerminal = !!traceRow && !traceRow.is_evaluating && isTraceFlowAnalyzed(traceRow);
                const traceReady = traceTerminal && resultScore != null && getTraceFlowScore(traceRow) != null;
                traceBusy = !traceTerminal;
                pending = pending || traceBusy;
            }

            if (!pending) break;
            await new Promise(resolve => setTimeout(resolve, 1500));
        }

        if (shouldPollBackground && (grayBusy || traceBusy)) {
            timedOut = true;
        }

        return {
            traces: latestTraces,
            staticSummary: latestStatic,
            triggerSummary: latestTrigger,
            graySummary: latestGray,
            grayTaskMeta: latestGrayMeta,
            grayBusy,
            traceBusy,
            timedOut,
        };
    };

    const handleOneClickRun = async () => {
        const runnable = evalRunStates.filter(s => s.canRun && selectedRunKeys.includes(s.key));
        if (runnable.length === 0) {
            toast.error('当前没有可一键测试的维度。');
            return;
        }
        onSmartRunBusyChange(true);
        setSmartRunPhase('starting');
        try {
            const results = await Promise.allSettled(runnable.map(async item => {
                if (item.key === 'gray') return startGrayRunFromOverview();
                if (item.key === 'trace') return startTraceRunFromOverview();
                if (item.key === 'trigger') return startTriggerRunFromOverview();
                if (item.key === 'static') return startStaticRunFromOverview();
            }));
            const failures = results.flatMap((result, index) =>
                result.status === 'rejected'
                    ? [`${runnable[index].name}：${result.reason instanceof Error ? result.reason.message : '启动失败'}`]
                    : []
            );
            const successfulKeys = results.flatMap((result, index) =>
                result.status === 'fulfilled' ? [runnable[index].key] : []
            );

            if (failures.length > 0) {
                toast.error(failures.join('；'));
            }
            if (successfulKeys.length > 0) {
                toast.success(`已启动 ${successfulKeys.length} 个测试任务`);
            }

            setSmartRunPhase(successfulKeys.some(key => key === 'gray' || key === 'trace') ? 'running' : 'refreshing');
            const settled = await waitForSelectedRuns(successfulKeys);

            if (settled.timedOut) {
                toast.warning('部分后台测试仍在运行，已先刷新当前诊断。');
            }

            setSmartRunPhase('diagnosing');
            const snapshot = buildDiagnosisSnapshot({
                traces: settled.traces,
                staticSummary: settled.staticSummary,
                triggerSummary: settled.triggerSummary,
                graySummary: settled.graySummary,
                grayTaskMeta: settled.grayTaskMeta,
                grayBusy: settled.grayBusy,
                traceBusy: settled.traceBusy,
                selectedDimensionsThisRun: successfulKeys,
            });
            if (snapshot) {
                lastDiagnosisSignatureRef.current = JSON.stringify(snapshot);
                await refreshDiagnosis(snapshot, 'smart-run');
            }
        } finally {
            setSmartRunPhase('idle');
            onSmartRunBusyChange(false);
        }
    };
    const toggleRunKey = (key: DxRunState['key']) => {
        setSelectedRunKeys(prev => prev.includes(key) ? prev.filter(item => item !== key) : [...prev, key]);
    };
    const toggleAllRuns = () => {
        setSelectedRunKeys(prev => prev.length === selectableKeys.length ? [] : selectableKeys);
    };
    const selectedCount = selectedRunKeys.length;
    const traceRunBusy = !!selectedTraceId && traces.some(t => getTraceId(t) === selectedTraceId && t.is_evaluating);
    const smartRunBlocked = smartRunBusy || smartRunPhase !== 'idle' || grayRunButtonBusy || traceRunBusy;
    const smartRunLabel = smartRunPhase === 'starting'
        ? '启动中...'
        : smartRunPhase === 'running'
            ? '测试进行中...'
            : smartRunPhase === 'refreshing'
                ? '刷新结果中...'
                : smartRunPhase === 'diagnosing'
                    ? '更新诊断中...'
                    : smartRunBlocked
                        ? '测试进行中...'
                        : `一键测试 ${selectedCount} 项`;
    const traceCardStatus = !traceHasCompleteCardData ? '待分析' : highDeviation > 0 ? '需关注' : '正常';
    // status 用均分分级：≥80 视为「正常」，否则「需关注」（跟详情页"维度均分"色阶对齐）
    const staticCardStatus = !staticHasResult || staticStats.avgPct == null ? '待分析'
        : staticStats.avgPct >= 80 ? '正常' : '需关注';
    const staticAgoLabel = staticHasResult && staticSummary?.latest
        ? formatRelative(staticSummary.latest.ranAt)
        : '待扫描';
    const grayCardStatus = !graySummary ? '未配置'
        : graySummary.scoring.decision === 'insufficient' ? '样本不足'
            : graySummary.scoring.decisionLabel;
    const grayDeltaLabel = graySummary?.delta != null
        ? `${graySummary.delta > 0 ? '+' : ''}${graySummary.delta}`
        : '--';
    const grayScoreLabel = graySummary?.scoring.totalScore != null
        ? `总分 ${graySummary.scoring.totalScore}`
        : graySummary?.b.avgScore != null
            ? `B 均分 ${graySummary.b.avgScore}`
            : '待运行';
    const graySampleLabel = graySummary
        ? `${graySummary.completedPairs || Math.min(graySummary.a.total, graySummary.b.total)}/${graySummary.sampleCount || Math.max(graySummary.a.total, graySummary.b.total)} 样本`
        : '暂无样本';
    const grayRunLabel = graySummary
        ? `${graySummary.repeatRounds} 轮`
        : '未运行';
    const grayAgoLabel = graySummary?.latestCompletedAt || graySummary?.latestResultAt
        ? formatRelative(graySummary.latestCompletedAt || graySummary.latestResultAt)
        : '未运行';
    const grayFallbackBLabel = selectedSkill && selectedVersion != null
        ? formatSkillVersionLabel(selectedSkill.name, selectedVersion)
        : 'B 版本';
    const grayPairLabel = graySummary ? `${graySummary.aLabel} vs ${graySummary.bLabel}` : `无 Skill vs ${grayFallbackBLabel}`;
    const grayPValueLabel = graySummary ? formatPValueLabel(graySummary.pValue) : '待计算';
    const diagnosisSourceLabel = diagnosisStatus === 'loading'
        ? '正在更新诊断'
        : narrative.mode === 'llm'
            ? `由 ${narrative.modelLabel || '当前评测模型'} 生成`
            : '基础诊断';
    return (
        <>
            <section className="sa-hero">
                <div className={`sa-hero-score ${scoreTier}`}>
                    <div className="sa-hero-score-eyebrow">
                        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M7 1L13 12H1z"/><path d="M7 5.5v3"/><circle cx="7" cy="10.5" r=".5" fill="currentColor"/></svg>
                        <Term id="health-score" label="综合健康分 · 置信加权" />
                    </div>
                    <div className="sa-hero-score-body">
                        <div className="sa-hero-score-num">{health == null ? '--' : health}</div>
                        <div className="sa-hero-score-unit">/ 100</div>
                        <div className="sa-hero-score-tier">{tierLabel}</div>
                    </div>
                    
                    <div className="sa-hero-coverage" style={{ marginTop: 14 }}>
                        <div className="sa-hero-coverage-label">
                            <span><Term id="eval-coverage" label="评估覆盖度" /></span>
                            <b>{coveredCount} / {totalEvaluators} 维 · {Math.round((coveredCount / totalEvaluators) * 100)}%</b>
                        </div>
                        <div className="sa-hero-coverage-bar">
                            <div className={`sa-hero-coverage-seg${grayHasResult ? ' on' : ''}`} style={{ background: 'var(--sa-warning)' }} title="A/B 测试（权重 40%）"></div>
                            <div className={`sa-hero-coverage-seg${traceCardStatus !== '待分析' ? ' on' : ''}`} style={{ background: 'var(--sa-success)' }} title="用例分析（权重 30%）"></div>
                            <div
                                className={`sa-hero-coverage-seg${triggerHasResult ? ' on' : ''}`}
                                style={{ background: 'var(--sa-info, #6366f1)' }}
                                title={triggerHasResult
                                    ? `触发分析 · 已评测（权重 20%）`
                                    : triggerHasSet ? '触发分析 · 待评测（权重 20%）' : '触发分析 · 未配置（权重 20%）'}
                            ></div>
                            <div className={`sa-hero-coverage-seg${staticCardStatus !== '待分析' ? ' on' : ''}`} style={{ background: 'var(--sa-purple)' }} title="静态合规（权重 10%）"></div>
                        </div>
                    </div>
                </div>

                <div className="sa-hero-narr">
                    <div>
                        <div className="sa-hero-narr-eyebrow">
                            <Term id="one-line-diagnosis" label="一句话诊断" />
                            <span className="sa-hero-narr-ai">
                                {diagnosisStatus === 'loading' || narrative.mode === 'llm' ? (
                                    <>
                                        <svg width="9" height="9" viewBox="0 0 14 14" fill="currentColor"><path d="M8 1L1 8h5l-1 5 7-7h-5z"/></svg>
                                        AI
                                    </>
                                ) : (
                                    <>基础</>
                                )}
                            </span>
                            · {diagnosisSourceLabel}
                        </div>
                        <div className="sa-hero-narr-headline sa-hero-narr-split">
                            <span className="sa-hero-narr-line sa-hero-narr-problem">
                                <span className="lbl">问题</span> 
                                <span>{narrative.problem}</span>
                            </span>
                            <span className="sa-hero-narr-line sa-hero-narr-suggest">
                                <span className="lbl">建议</span> 
                                <span>{narrative.suggestion}</span>
                            </span>
                        </div>
                    </div>
                    <div className="sa-hero-formula">
                        <div className="sa-hero-formula-label">置信加权 · 权重 A/B 40% · 用例 30% · 触发 20% · 静态 10%（未跑维度不进分母）</div>
                        score = Σ(分 × 权重) ÷ Σ(已跑权重)<br />
                        &nbsp;&nbsp;= <strong>{health == null ? '—' : health}</strong>
                    </div>
                </div>

                <div className="sa-hero-cta">
                    <div className="sa-hero-cta-eyebrow">
                        <svg width="11" height="11" viewBox="0 0 14 14" fill="currentColor"><path d="M8 1L1 8h5l-1 5 7-7h-5z"/></svg>
                        <Term id="smart-run" label="Smart Run" />
                    </div>
                    <div className="sa-hero-cta-title">
                        <span>选择要一键测试的维度</span>
                        <a className="sa-cta-toggleall" onClick={toggleAllRuns}>{selectedCount === selectableKeys.length && selectableKeys.length > 0 ? '全不选' : '全选 / 反选'}</a>
                    </div>

                    <div className="sa-cta-list">
                        <label
                            className={`sa-cta-row${!staticCanTest ? ' disabled' : ''}`}
                            title={staticCanTest ? '可触发详情页“重新分析”' : '需先选择 Skill 与版本'}
                        >
                            <input type="checkbox" checked={selectedRunKeys.includes('static')} onChange={() => toggleRunKey('static')} disabled={!staticCanTest} />
                            <span className="dot" style={{ '--cdot': 'var(--sa-purple)' } as React.CSSProperties}></span>
                            <span className="nm">
                                <Term id="static-compliance" label="静态合规" /> <span className="wpct">10%</span>
                                {!staticCanTest && <span className="cfg-tag">待扫描</span>}
                            </span>
                            {!staticCanTest ? (
                                <a
                                    className="cfg-link"
                                    href="#"
                                    onClick={e => { e.preventDefault(); onOpen('static'); }}
                                >
                                    前往评测 →
                                </a>
                            ) : (
                                <span className="ago">{staticAgoLabel}</span>
                            )}
                        </label>

                        <label
                            className={`sa-cta-row${!triggerCanTest ? ' disabled' : ''}`}
                            title={!triggerHasSet
                                ? '尚未配置触发集，需先到编辑器里起草或手填'
                                : (triggerSummary?.itemCount ?? 0) === 0
                                    ? '触发集为空，需先补充触发分析数据'
                                    : '触发集已准备，可触发详情页“立即评测/立即复测”'}
                        >
                            <input
                                type="checkbox"
                                checked={selectedRunKeys.includes('trigger')}
                                onChange={() => toggleRunKey('trigger')}
                                disabled={!triggerCanTest}
                            />
                            <span className="dot" style={{ '--cdot': 'var(--sa-info, #6366f1)' } as React.CSSProperties}></span>
                            <span className="nm">
                                <Term id="trigger-analysis" label="触发分析" /> <span className="wpct">20%</span>
                                {!triggerHasSet && <span className="cfg-tag">未配置</span>}
                                {triggerHasSet && !triggerHasResult && <span className="cfg-tag">待评测</span>}
                                {triggerHasResult && triggerSummary?.latestRun && (
                                    <span className="ago">{Math.round(triggerSummary.latestRun.passRate * 100)}% 通过</span>
                                )}
                            </span>
                            <a
                                className="cfg-link"
                                href="#"
                                onClick={e => { e.preventDefault(); onOpenTriggerEditor(); }}
                            >
                                {!triggerHasSet ? '前往配置 →' : '打开编辑器 →'}
                            </a>
                        </label>

                        <label
                            className={`sa-cta-row${!traceCanTest ? ' disabled' : ''}`}
                            title={traceCanTest ? '当前 Trace 可触发详情页“分析当前 Trace”' : traces.length === 0 ? '暂无 Trace 可分析' : '当前 Trace 缺少主 Skill 信息，详情页按钮不可点击'}
                        >
                            <input type="checkbox" checked={selectedRunKeys.includes('trace')} onChange={() => toggleRunKey('trace')} disabled={!traceCanTest} />
                            <span className="dot" style={{ '--cdot': 'var(--sa-success)' } as React.CSSProperties}></span>
                            <span className="nm">
                                <Term id="case-analysis" label="用例分析" /> <span className="wpct">30%</span>
                                {!traceCanTest && <span className="cfg-tag">待分析</span>}
                            </span>
                            {!traceCanTest ? (
                                <a
                                    className="cfg-link"
                                    href="#"
                                    onClick={e => { e.preventDefault(); onOpen('trace'); }}
                                >
                                    前往评测 →
                                </a>
                            ) : (
                                <span className="ago">测试当前 Trace</span>
                            )}
                        </label>

                        <label
                            className={`sa-cta-row sa-cta-row-ab${!grayCanTest ? ' disabled' : ''}`}
                            title={grayCanTest
                                ? `A/B 版本：${grayPairLabel}，可触发详情页“开始执行”`
                                : grayRunButtonBusy
                                        ? '当前 A/B 任务执行中，详情页“开始执行”按钮不可点击'
                                        : grayPreparedSampleCount === 0
                                            ? '当前 A/B 任务缺少选中样本，需先进入详情页选择样本'
                                            : '当前 A/B 任务尚未保存，需先进入详情页完成配置'}
                        >
                            <input
                                type="checkbox"
                                checked={selectedRunKeys.includes('gray')}
                                onChange={() => toggleRunKey('gray')}
                                disabled={!grayCanTest}
                            />
                            <span className="dot" style={{ '--cdot': 'var(--sa-warning)' } as React.CSSProperties}></span>
                            <span className="nm">
                                <span className="sa-cta-mainline">
                                    <Term id="ab-test" label="A/B 测试" /> <span className="wpct">{AB_WEIGHT_LABEL}</span>
                                    {!grayCanTest && <span className="cfg-tag">未配置</span>}
                                </span>
                                <span className="sa-cta-subline">
                                    <b>{grayPairLabel}</b>
                                    {grayHasResult && (
                                        <>
                                            <span>{grayCardStatus}</span>
                                            <span>{grayScoreLabel}</span>
                                            <span>{grayDeltaLabel}</span>
                                            <span>{grayPValueLabel}</span>
                                            <span>{graySampleLabel}</span>
                                            <span>{grayRunLabel}</span>
                                        </>
                                    )}
                                </span>
                            </span>
                            {!grayCanTest ? (
                                <a
                                    className="cfg-link"
                                    href="#"
                                    onClick={e => { e.preventDefault(); onOpen('gray'); }}
                                >前往配置 →</a>
                            ) : (
                                <span className="ago">{grayAgoLabel}</span>
                            )}
                        </label>
                    </div>

                    <div className="sa-hero-cta-meta">
                        <span><svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="7" cy="7" r="5"/><path d="M7 4v3l2 1" strokeLinecap="round"/></svg>预计 {selectedCount > 0 ? `${selectedCount * 5} 分钟` : '—'}</span>
                        <span>已选 {selectedCount} / {selectableKeys.length || 0} 可运行项</span>
                    </div>
                    <div className="sa-cta-actions">
                        <button className="sa-hero-cta-btn" onClick={() => { void handleOneClickRun(); }} disabled={selectedCount === 0 || smartRunBlocked}>
                            <svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor"><path d="M3 1.5v11l9-5.5z"/></svg>
                            {smartRunLabel}
                        </button>
                        <a href={dxOptimizeHref} className="sa-hero-cta-btn-ghost">
                            前往 Skill 优化器
                            <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7h8M8 4l3 3-3 3"/></svg>
                        </a>
                    </div>
                </div>
            </section>

            <div className="sa-section-head">
                <h2>
                    <Term id="four-dim-eval" label="4 维评估能力" /> <span className="count">{coveredCount} / {totalEvaluators} 已配置 · 按前序关系排序</span>
                </h2>
                <span className="head-meta">点击卡片进入详情 · 百分制分数</span>
            </div>

            <section className="sa-cards">
                {/* 1. 静态合规 (static) */}
                <div className="sa-card k-static" onClick={() => onOpen('static')}>
                    <div className="sa-card-head">
                        <span className="sa-card-icon">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M3 2.5h7l3 3v8a.5.5 0 0 1-.5.5h-9.5a.5.5 0 0 1-.5-.5v-10.5a.5.5 0 0 1 .5-.5z"/>
                                <path d="M9.5 2.5v3h3"/>
                                <path d="M5.5 9l1.5 1.5 3-3"/>
                            </svg>
                        </span>
                        <div className="sa-card-title">
                            <span className="t-row">静态合规</span>
                            <small>写得规范吗？能被正确加载吗？</small>
                        </div>
                        <span className={`sa-card-status ${staticCardStatus === '正常' ? 'ok' : staticCardStatus === '需关注' ? 'warn' : 'neutral'}`}>
                            {staticCardStatus}
                        </span>
                    </div>

                    <div className="sa-card-score">
                        {/* 没评估过就显示空态 "--" + "待分析"，不要给 mock 数字（之前默认 91 容易误导用户） */}
                        <span className={staticHasResult && staticStats.avgPct != null ? 'sa-card-score-num' : 'sa-card-score-empty'}>
                            {staticHasResult && staticStats.avgPct != null ? staticStats.avgPct : '--'}
                        </span>
                        <span className="sa-card-score-unit">{staticHasResult && staticStats.avgPct != null ? '/ 100' : '待分析'}</span>
                    </div>

                    <div className="sa-card-stats">
                        <div className="sa-card-stat">
                            <div className="sa-card-stat-label">已评估维度</div>
                            <div className="sa-card-stat-val">{staticHasResult ? `${staticStats.scoredCount} / ${STATIC_EVAL_STANDARDS.length} 项` : '尚未评估'}</div>
                        </div>
                        <div className="sa-card-stat">
                            <div className="sa-card-stat-label">未评估</div>
                            <div className="sa-card-stat-val">{staticHasResult ? (STATIC_EVAL_STANDARDS.length - staticStats.scoredCount > 0 ? `${STATIC_EVAL_STANDARDS.length - staticStats.scoredCount} 项` : '无') : '—'}</div>
                        </div>
                    </div>

                    {staticCanTest ? (
                        <div className="sa-card-foot">
                            <span className="sa-card-foot-meta">
                                <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="7" cy="7" r="5"/><path d="M7 4v3l2 1" strokeLinecap="round"/></svg>
                                {staticHasResult && staticSummary?.latest ? formatRelative(staticSummary.latest.ranAt) : '点击进入静态评估详情'}
                            </span>
                            <a className="sa-card-foot-link" onClick={e => { e.preventDefault(); onOpen('static'); }}>查看详情 →</a>
                        </div>
                    ) : (
                        <button
                            className="sa-card-empty-cta"
                            onClick={e => { e.stopPropagation(); onOpen('static'); }}
                        >
                            <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M3 7h8M8 4l3 3-3 3"/></svg>
                            打开评测页扫描
                        </button>
                    )}
                </div>

                {/* 2. 触发分析 (trigger) —— 数据来自 GET /api/skill-eval/trigger/<name>{,/runs}。
                    点卡片或按钮跳到 /skill-eval/trigger/<name> 全功能编辑器。 */}
                <div
                    className="sa-card k-trigger"
                    onClick={(e) => {
                        if ((e.target as HTMLElement).closest('a,button')) return;
                        onOpenTriggerEditor();
                    }}
                >
                    <div className="sa-card-head">
                        <span className="sa-card-icon">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="7" cy="7" r="4.5"/>
                                <path d="M10.5 10.5 13.5 13.5"/>
                                <path d="M5 7l1.5 1.5L9 6"/>
                            </svg>
                        </span>
                        <div className="sa-card-title">
                            <span className="t-row">触发分析</span>
                            <small>该触发的时候，触发了吗？</small>
                        </div>
                        {triggerHasResult && triggerSummary?.latestRun ? (
                            <span className={`sa-card-status ${triggerSummary.latestRun.passRate >= 0.8 ? 'ok' : triggerSummary.latestRun.passRate >= 0.6 ? 'warn' : 'err'}`}>
                                {triggerSummary.latestRun.passRate >= 0.8 ? '正常' : triggerSummary.latestRun.passRate >= 0.6 ? '需关注' : '急需优化'}
                            </span>
                        ) : triggerHasSet ? (
                            <span className="sa-card-status warn">待评测</span>
                        ) : (
                            <span className="sa-card-status warn">未配置</span>
                        )}
                    </div>

                    <TaskQueueBanner counts={triggerTaskCounts} hint="触发分析评测的实时调度状态 (taskType=trigger-eval)" />

                    {triggerHasResult && triggerSummary?.latestRun ? (
                        <div className="sa-card-score">
                            <span className="sa-card-score-num">{Math.round(triggerSummary.latestRun.passRate * 100)}</span>
                            <span className="sa-card-score-unit">/ 100</span>
                        </div>
                    ) : (
                        <div className="sa-card-score sa-card-score-placeholder">
                            <span className="sa-card-score-placeholder-text">
                                {triggerHasSet ? '待评测' : '尚未配置'}
                            </span>
                        </div>
                    )}

                    <div className="sa-card-stats">
                        <div className="sa-card-stat">
                            <div className="sa-card-stat-label">触发集</div>
                            <div className={`sa-card-stat-val${triggerHasSet ? '' : ' muted'}`}>
                                {triggerHasSet
                                    ? `${triggerSummary?.itemCount ?? 0} 条 · 正例 ${triggerSummary?.positiveCount ?? 0}`
                                    : '未创建'}
                            </div>
                        </div>
                        <div className="sa-card-stat">
                            <div className="sa-card-stat-label">{triggerHasResult ? 'TPR / FPR' : '影响'}</div>
                            <div className={`sa-card-stat-val${triggerHasResult ? '' : ' muted'}`}>
                                {triggerHasResult && triggerSummary?.latestRun
                                    ? `${Math.round(triggerSummary.latestRun.truePositiveRate * 100)}% / ${Math.round(triggerSummary.latestRun.falsePositiveRate * 100)}%`
                                    : '不计入总分 (-20%)'}
                            </div>
                        </div>
                    </div>

                    {triggerHasResult && triggerSummary?.latestRun ? (
                        <div className="sa-card-foot">
                            <span className="sa-card-foot-meta">
                                <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="7" cy="7" r="5"/><path d="M7 4v3l2 1" strokeLinecap="round"/></svg>
                                {formatRelative(triggerSummary.latestRun.ranAt)} · v{triggerSummary.latestRun.skillVersion}
                            </span>
                            <a
                                className="sa-card-foot-link"
                                onClick={e => { e.preventDefault(); onOpenTriggerEditor(); }}
                                href="#"
                            >查看详情 →</a>
                        </div>
                    ) : (
                        <button
                            className="sa-card-empty-cta"
                            onClick={e => { e.stopPropagation(); onOpenTriggerEditor(); }}
                            disabled={triggerLoading}
                        >
                            <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M3 7h8M8 4l3 3-3 3"/></svg>
                            {triggerHasSet ? '打开编辑器评测' : '前往配置触发集'}
                        </button>
                    )}
                </div>

                {/* 3. 用例分析 (trace) */}
                <div className="sa-card k-batch" onClick={(e) => {
                    if (!(e.target as HTMLElement).closest('a,button')) {
                        onOpen('trace');
                    }
                }}>
                    <div className="sa-card-head">
                        <span className="sa-card-icon">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="2" y="2.5" width="5" height="5" rx="1"/>
                                <rect x="9" y="2.5" width="5" height="5" rx="1"/>
                                <rect x="2" y="9" width="5" height="5" rx="1"/>
                                <rect x="9" y="9" width="5" height="5" rx="1"/>
                                <path d="M3.6 5l1 1L5.8 4.8"/>
                                <path d="M10.6 5l1 1 1.2-1.2"/>
                                <path d="M3.6 11.5l1 1L5.8 11.3"/>
                                <path d="M10.6 11.5l1 1 1.2-1.2"/>
                            </svg>
                        </span>
                        <div className="sa-card-title">
                            <span className="t-row">用例分析</span>
                            <small title={hasEvalTask ? (traceEvaluationBatchTitle || '未命名评测任务') : undefined}>
                                {hasEvalTask ? `评测任务：${traceEvaluationBatchTitle || '未命名任务'}` : '做的怎么样？结果 & 轨迹分析'}
                            </small>
                        </div>
                        <span className={`sa-card-status ${cardEvalStatus === '正常' ? 'ok' : cardEvalStatus === '需关注' ? 'warn' : 'neutral'}`}>
                            {cardEvalStatus}
                        </span>
                    </div>

                    <div className="sa-card-score">
                        <span className="sa-card-score-num">{hasEvalTask ? (cardEvalScore ?? '--') : '--'}</span>
                        <span className="sa-card-score-unit">{!hasEvalTask ? '未选择评测任务' : cardEvalScore == null ? '待评测' : '/ 100'}</span>
                    </div>

                    <div className="sa-card-stats">
                        <div className="sa-card-stat">
                            <div className="sa-card-stat-label" title="当前评测任务下结果分 + 轨迹分双双就绪的记录数；只跑一边的不计入">已评测用例</div>
                            <div className="sa-card-stat-val">{!hasEvalTask ? '未选择评测任务' : `${cardEvalDone} / ${cardEvalTotal}`}</div>
                        </div>
                    </div>

                    {traceCanTest ? (
                        <div className="sa-card-foot">
                            <span className="sa-card-foot-meta">
                                <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="7" cy="7" r="5"/><path d="M7 4v3l2 1" strokeLinecap="round"/></svg>
                                {traceCardFooterAt ? formatRelative(traceCardFooterAt) : '点击进入用例分析详情'}
                            </span>
                            <a className="sa-card-foot-link" onClick={e => { e.preventDefault(); onOpen('trace'); }}>查看详情 →</a>
                        </div>
                    ) : (
                        <button
                            className="sa-card-empty-cta"
                            onClick={e => { e.stopPropagation(); onOpen('trace'); }}
                        >
                            <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M3 7h8M8 4l3 3-3 3"/></svg>
                            打开评测页扫描
                        </button>
                    )}
                </div>

                {/* 4. A/B 测试 (gray) */}
                <div className="sa-card k-gray" onClick={(e) => {
                    if ((e.target as HTMLElement).closest('a,button')) return;
                    onOpen('gray');
                }}>
                    <div className="sa-card-head">
                        <span className="sa-card-icon">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="5" cy="8" r="3"/>
                                <circle cx="11" cy="8" r="3"/>
                                <path d="M5 5v6M11 5v6" opacity=".4"/>
                            </svg>
                        </span>
                        <div className="sa-card-title">
                            <span className="t-row">A/B 测试</span>
                            <small>这个 skill 真的带来增益了吗？</small>
                        </div>
                        <span className={`sa-card-status ${graySummary ? (graySummary.scoring.decision === 'reject' ? 'err' : graySummary.scoring.decision === 'direct-release' || graySummary.scoring.decision === 'monitor-release' ? 'ok' : 'neutral') : 'warn'}`}>
                            {grayCardStatus}
                        </span>
                    </div>

                    <TaskQueueBanner counts={grayTaskCounts} hint="本 skill 当前所有 opencode 后台任务的实时调度状态 (A/B 跑评测时涉及 trajectory / task-completion / custom-llm 多类型)" />

                    {grayHasResult ? (
                        <>
                            <div className="sa-card-score">
                                <span className="sa-card-score-num">{graySummary?.scoring.totalScore ?? '--'}</span>
                                <span className="sa-card-score-unit">/ 100</span>
                            </div>

                            <div className="sa-card-stats">
                                <div className="sa-card-stat">
                                    <div className="sa-card-stat-label">能力</div>
                                    <div className="sa-card-stat-val">{graySummary?.scoring.capability.deltaPp == null ? '—' : `${graySummary.scoring.capability.deltaPp > 0 ? '+' : ''}${graySummary.scoring.capability.deltaPp}pp`}</div>
                                </div>
                                <div className="sa-card-stat">
                                    <div className="sa-card-stat-label">成本</div>
                                    <div className="sa-card-stat-val">{graySummary?.scoring.cost.deltaTokenPct == null ? '—' : `${graySummary.scoring.cost.deltaTokenPct > 0 ? '+' : ''}${graySummary.scoring.cost.deltaTokenPct}% Token`}</div>
                                </div>
                                <div className="sa-card-stat">
                                    <div className="sa-card-stat-label">稳定性</div>
                                    <div className="sa-card-stat-val">{graySummary?.scoring.stability.invokeRate == null ? '—' : `${graySummary.scoring.stability.invokeRate}% 触发`}</div>
                                </div>
                            </div>

                            <div className="sa-card-foot">
                                <span className="sa-card-foot-meta">
                                    <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="7" cy="7" r="5"/><path d="M7 4v3l2 1" strokeLinecap="round"/></svg>
                                    {grayAgoLabel} · 入总分 = v2.2 最终评分 {graySummary?.scoring.totalScore ?? '--'}
                                </span>
                                <a className="sa-card-foot-link" onClick={e => { e.preventDefault(); onOpen('gray'); }}>查看详情 →</a>
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="sa-card-score sa-card-score-placeholder">
                                <span className="sa-card-score-placeholder-text">尚未配置</span>
                            </div>

                            <div className="sa-card-stats">
                                <div className="sa-card-stat">
                                    <div className="sa-card-stat-label">实验版本</div>
                                    <div className="sa-card-stat-val muted">{grayFallbackBLabel}</div>
                                </div>
                                <div className="sa-card-stat">
                                    <div className="sa-card-stat-label">影响</div>
                                    <div className="sa-card-stat-val muted">不计入总分 (-40%)</div>
                                </div>
                            </div>

                            <button className="sa-card-empty-cta" onClick={e => { e.stopPropagation(); onOpen('gray'); }}>
                                <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M3 7h8M8 4l3 3-3 3"/></svg>
                                前往配置 A/B 测试
                            </button>
                        </>
                    )}
                </div>
            </section>

        </>
    );
}

function TraceDeviationPanel({
    skill,
    version,
    user,
    traces,
    loading,
    prefillTraceId,
    selectedTraceId,
    onSelectedTraceChange,
    onBack,
    onReload,
    onOptimize,
    onBatchAnalyze,
    traceEvaluationBatchId,
    traceEvaluationBatchTitle,
    onOpenEvalBatchDialog,
    evalTaskOptions,
    onSelectEvalBatch,
    datasets,
    selectedDatasetIds,
    onSelectedDatasetIdsChange,
    evaluatorOptions,
    selectedEvaluatorIds,
    onSelectedEvaluatorIdsChange,
}: {
    skill: SkillOption | null;
    version: number | null;
    user: string | null;
    traces: TraceRecord[];
    loading: boolean;
    /** AB 式配置区共享选择: 数据集(参考集) + 评估器, 父组件 SkillAnalysisPage 持有 state */
    datasets?: Array<{ id: string; name: string; cases?: unknown[] }>;
    selectedDatasetIds?: string[];
    onSelectedDatasetIdsChange?: (ids: string[]) => void;
    evaluatorOptions?: Array<{ id: string; name: string }>;
    selectedEvaluatorIds?: string[];
    onSelectedEvaluatorIdsChange?: (ids: string[]) => void;
    /** 评测批次关联 (trace 模式 ① actions 显示); 父组件 SkillAnalysisPage 维护 state + localStorage 持久化 */
    traceEvaluationBatchId?: string;
    traceEvaluationBatchTitle?: string;
    /** 点击 "+ 新增评测任务" / "切换/新建" 按钮触发的 callback, 由父组件打开 NewEvaluationBatchDialog */
    onOpenEvalBatchDialog?: () => void;
    /** 已有评测任务(批次)列表, 供"选历史" */
    evalTaskOptions?: Array<{ runId: string; taskTitle?: string; traceCount?: number; doneCount?: number; runningCount?: number; createdAt?: string }>;
    /** 选中一个已有评测任务 */
    onSelectEvalBatch?: (opt: { runId: string; taskTitle?: string }) => void;
    prefillTraceId: string;
    selectedTraceId: string;
    onSelectedTraceChange: (id: string) => void;
    onBack: () => void;
    onReload: () => void;
    onOptimize: () => void;
    /** 顶层共享的"批量分析 N 条 trace" helper；详情页主按钮跟外面"一键测试"复用同一通道。
     * 返回 partial failures（按 side 拆分）让调用方能精准告诉用户"哪条 trace 的哪一边没跑成"。 */
    onBatchAnalyze?: (taskIds: string[]) => Promise<{
        resultErrors?: string[];
        trajectoryErrors?: Map<string, string>;
    } | void> | void;
}) {
    const [query, setQuery] = useState('');
    const [tab, setTab] = useState<'all' | 'analyzed' | 'pending' | 'deviation'>('all');
    // 用例分析 = [结果分析 | 轨迹分析] 双 tab；默认进结果分析（用户关心"做对了没"）

    // 三段式 section 折叠态：① 默认展开（source toggle 在 ① body 顶部，需立刻可见），
    // ② 默认折叠，③ 默认展开。
    const [caseConfigOpen, setCaseConfigOpen] = useState(true);
    const [caseExecOpen, setCaseExecOpen] = useState(false);
    const [caseResultOpen, setCaseResultOpen] = useState(true);
    // 拉当前评测任务的结果, 给 ② 表每行补"评估 Trace / datasetId"(displayedTraces 里没有)。5s 轮询接异步落库。
    const traceEvalResultsMap = useBatchEvalResults(user, traceEvaluationBatchId, 5000);
    const [datasetExecutionRecords, setDatasetExecutionRecords] = useState<EvalRecordRow[]>([]);

    // 已触发评测的 trace id → 触发时间戳。runBothAnalyses 调用时填，让 ② 执行块的
    // 列表能区分"正在评测中"（已触发但分数还没回来）vs"已评测"（双分都就绪）。
    // 之前用户反映"批量分析 3 条只显示 1 条"——其实另 2 条还在后台 queue 跑，UI
    // 没记 trigger 痕迹就把它们当 idle 隐藏了。
    //
    // 跨刷新持久化：本地 state 在 refresh 后会丢，但后端 TrajectoryEvalResult 还在跑
    // （status: pending/running）。下方 useEffect 会在 mount + traces 变化时扫一遍
    // 后端进行中的评测，把对应 taskId 补回这个 Map——刷新页面后"评测中"徽章不消失。
    const [triggeredTaskIds, setTriggeredTaskIds] = useState<Map<string, number>>(new Map());

    // 用户在「评测执行」里删除的 trace（taskId）→ 从列表隐藏。后端会一并删掉该 trace 在当前评测任务
    // 下的 TrajectoryEvalResult 行；但 trace 的 Execution.answer_score / matchJson 仍保留（非破坏性），
    // 所以这里用 localStorage 记一份"已从评测视图删除"的集合，避免刷新后又凭分数被显示出来。
    const deletedTracesStorageKey = useMemo(
        () => (user && skill?.name ? `eval-deleted-traces:${user}:${skill.name}:${version ?? 'all'}` : ''),
        [user, skill?.name, version],
    );
    const [deletedTaskIds, setDeletedTaskIds] = useState<Set<string>>(new Set());
    useEffect(() => {
        if (!deletedTracesStorageKey) { setDeletedTaskIds(new Set()); return; }
        try {
            const raw = localStorage.getItem(deletedTracesStorageKey);
            const arr = raw ? JSON.parse(raw) : [];
            setDeletedTaskIds(new Set(Array.isArray(arr) ? arr.map(String) : []));
        } catch { setDeletedTaskIds(new Set()); }
    }, [deletedTracesStorageKey]);
    const persistDeletedTaskIds = useCallback((next: Set<string>) => {
        setDeletedTaskIds(next);
        if (deletedTracesStorageKey) {
            try { localStorage.setItem(deletedTracesStorageKey, JSON.stringify(Array.from(next))); } catch {/* ignore */}
        }
    }, [deletedTracesStorageKey]);

    // 自动清理 triggeredTaskIds: 当 trace 的后端 is_evaluating 变成 false (评测真的结束了),
    // 把这条 taskId 从 Map 移除,让 getTraceEvalStatus 不再返回 'pending',UI 自然切回 'done' 或
    // 显示新的分数。否则"已评测的 trace 重新评测后" Map 残留 → 永久卡在"评测中"。
    // 这条 effect 依赖后端 /api/observe/data 的 is_evaluating 字段真实反映 isActive,
    // 而后者依赖 runOneEvaluation 注册了 startOrReplace + finish (见 trajectory/run/route.ts)。
    useEffect(() => {
        if (triggeredTaskIds.size === 0) return;
        setTriggeredTaskIds(prev => {
            let changed = false;
            const next = new Map(prev);
            for (const t of traces) {
                const id = (t as any).task_id || (t as any).taskId;
                if (!id) continue;
                if (next.has(id) && t.is_evaluating === false) {
                    next.delete(id);
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [traces]);
    // 失败评测 trace id → 错误信息。后端的"静默失败"（status=done 但 LLM 调用挂掉/score 为 null）
    // 之前完全没暴露给前端,trace 显示"未评估"用户以为没触发,实际上是 API key 失效一类的真实错误。
    // 现在 recovery 时把这种行也抓出来,UI 用红色"评测失败"徽章 + tooltip 显示根因。
    const [failedTaskIds, setFailedTaskIds] = useState<Map<string, string>>(new Map());
    // 跑过任何评测的 taskId（不管成功失败 / 完整或部分）。② 执行块要列"所有跑过的评测",
    // 而不是只列双分都齐的 trace。这个 set 是 recovery 时从后端 latestRows 全量提取的。
    // 之前用 displayedTraces = filter(status !== 'idle'),依赖双分 + triggeredTaskIds + failedTaskIds,
    // 漏掉了"部分成功"（如 result=0.48 / traj=null）和"老评测记录"（refresh 后内存丢)。
    const [evaluatedTaskIds, setEvaluatedTaskIds] = useState<Set<string>>(new Set());
    // 本次会话里点过「开始评测」提交的 trace id（含勾选批量）。与 triggeredTaskIds 不同：
    // 它不会在 is_evaluating 变 false 时被清掉。用来保证"选了 N 条就一直显示 N 条"——
    // 即使某条后端没产出结果行(未匹配 case / 未引用 skill 等)，也留在 ② 列表里标"未产出"，
    // 不再静默消失。skill/version 切换时 panel remount 会随 key 一起重置。
    const [submittedTaskIds, setSubmittedTaskIds] = useState<Set<string>>(new Set());
    const [transientEvalRunId, setTransientEvalRunId] = useState(traceEvaluationBatchId || '');
    useEffect(() => {
        setDatasetExecutionRecords([]);
        setTriggeredTaskIds(new Map());
        setFailedTaskIds(new Map());
        setSubmittedTaskIds(new Set());
        setEvaluatedTaskIds(new Set());
        setTransientEvalRunId(traceEvaluationBatchId || '');
    }, [traceEvaluationBatchId]);
    const transientStateMatchesRun = transientEvalRunId === (traceEvaluationBatchId || '');
    // 用例来源模式：'trace' 用已有 Trace 评测 / 'dataset' 用数据集发起评测（v1 走跳转，phase 2 集成）
    const [caseSourceMode, setCaseSourceMode] = useState<'trace' | 'dataset'>('trace');
    const [traceListCollapsed, setTraceListCollapsed] = useState(false);

    /* ─────────────────────────────────────────────────────
       Skill 归因状态
       轨迹分析的 alignment 是唯一事实源；归因区只读取 analyze-match 基于
       alignment 派生出的 finding（is_skill_attributable + improvement_suggestion），
       并写入 SkillIssue 表喂给 skill-opt。trajectoryEval 仅用于门控顶部按钮的
       运行态（评测进行中禁用），不再在本页渲染评估明细。
       ───────────────────────────────────────────────────── */
    const [trajectoryEval, setTrajectoryEval] = useState<TrajectoryEvalRow | null>(null);
    const trajEvalPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /* 批量分析：左侧 trace 列表支持勾选；顶部「分析当前 Trace」按钮在有勾选时
       一键并行启动选中的全部 trace（结果分析 + 轨迹分析），相互不阻塞失败。 */
    const [checkedTraceIds, setCheckedTraceIds] = useState<Set<string>>(new Set());
    const [batchRunning, setBatchRunning] = useState(false);
    const toggleChecked = (id: string) => {
        setCheckedTraceIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return traces.filter(t => {
            const id = getTraceId(t);
            const analyzed = isTraceFlowAnalyzed(t);
            const score = getTraceFlowScore(t);
            // 已评估 = 结果分 + 轨迹分双双就绪；跟左侧 dot 标识和卡片"已完整评测"同口径
            const resultScore = typeof t.answer_score === 'number' ? t.answer_score
                : typeof t.answerScore === 'number' ? t.answerScore : null;
            const evaluated = resultScore != null && score != null;
            if (tab === 'analyzed' && !evaluated) return false;
            if (tab === 'pending' && evaluated) return false;
            if (tab === 'deviation' && (!analyzed || score == null || score >= 0.7)) return false;
            if (!q) return true;
            return id.toLowerCase().includes(q) || (t.query || '').toLowerCase().includes(q);
        });
    }, [query, tab, traces]);

    // ── 分页 ─────────────────────────────────────────────────────────
    // 用例分析的 trace 列表常常上百条,一次全渲染既慢又难浏览。这里做客户端分页:
    //   - 默认 30 条/页
    //   - tab/query/总数变化时自动回到第 1 页(否则可能停在不存在的页)
    //   - "全选当前列表"等批量操作改成基于"当前页", 避免一键勾错几百条
    const PAGE_SIZE = 30;
    const [pageIndex, setPageIndex] = useState(0);
    const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    useEffect(() => {
        // filtered 集合变了(切 tab/搜索/版本/skill 变更), 自动回首页
        setPageIndex(0);
    }, [query, tab, filtered.length]);
    const visibleTraces = useMemo(
        () => filtered.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE),
        [filtered, pageIndex],
    );

    useEffect(() => {
        if (prefillTraceId && traces.some(t => getTraceId(t) === prefillTraceId)) {
            onSelectedTraceChange(prefillTraceId);
            return;
        }
        if ((!selectedTraceId || !traces.some(t => getTraceId(t) === selectedTraceId)) && filtered[0]) {
            onSelectedTraceChange(getTraceId(filtered[0]));
        }
    }, [filtered, onSelectedTraceChange, prefillTraceId, selectedTraceId, traces]);

    const selectedTrace = useMemo(
        () => traces.find(t => getTraceId(t) === selectedTraceId) || null,
        [selectedTraceId, traces],
    );
    const primarySkill = selectedTrace ? getTracePrimarySkill(selectedTrace) : null;
    const actionUsesPrimarySkill = !!skill?.name && !!primarySkill?.name && primarySkill.name !== skill.name;

    /* ── 轨迹评估器：拉最新结果 ── */
    const fetchTrajectoryEval = useCallback(async () => {
        if (!selectedTraceId || !user) {
            setTrajectoryEval(null);
            return null;
        }
        try {
            const res = await apiFetch(
                `/api/eval/trajectory/results?user=${encodeURIComponent(user)}&taskId=${encodeURIComponent(selectedTraceId)}&limit=1`,
            );
            const data = await res.json();
            const latest = (Array.isArray(data?.results) ? data.results : [])[0] as TrajectoryEvalRow | undefined;
            setTrajectoryEval(latest || null);
            return latest || null;
        } catch {
            return null;
        }
    }, [selectedTraceId, user]);

    useEffect(() => {
        void fetchTrajectoryEval();
        // 清理之前的轮询
        return () => {
            if (trajEvalPollRef.current) {
                clearTimeout(trajEvalPollRef.current);
                trajEvalPollRef.current = null;
            }
        };
    }, [fetchTrajectoryEval]);

    /**
     * 跨刷新恢复"评测中" + "评测失败"状态：
     *
     * triggeredTaskIds 和 failedTaskIds 只是内存 Map，refresh 后会清空。但后端
     * TrajectoryEvalResult 行始终在 DB 里。原版只看 pending/running 把行抓出来,
     * 但漏了一种关键状态: **后端把 row 标 done 但 LLM 调用挂了**(typical: API key 失效),
     * score 为 null,errorMessage 走 rawAnalysisJson.resultEvaluationError。这种"静默失败"
     * 之前完全不暴露,trace 显示"未评估",用户以为没触发,体感像评测丢了。
     *
     * 现在 recovery 抓三种状态都补回 Map:
     *   - pending/running → 评测中(蓝色脉冲徽章)
     *   - done & 无分数 & 有 resultEvaluationError → 评测失败(红色徽章 + tooltip 错误)
     *   - done & 有分数 → 不入 Map,trace 行有 answerScore/trajScore 自然显示"已评测"
     *
     * 只在 traces 列表里出现过的 taskId 才入 Map——避免捞到别的 skill 的脏行。
     */
    useEffect(() => {
        if (!user || traces.length === 0) return;
        let cancelled = false;
        (async () => {
            try {
                const runScope = traceEvaluationBatchId
                    ? `&runId=${encodeURIComponent(traceEvaluationBatchId)}&latestByCase=1`
                    : '';
                const res = await apiFetch(`/api/eval/trajectory/results?user=${encodeURIComponent(user)}${runScope}&limit=500`);
                if (!res.ok) return;
                const data = await res.json();
                type EvalRow = {
                    taskId?: string;
                    status?: string;
                    createdAt?: string;
                    trajectoryScore?: number | null;
                    resultEvaluationScore?: number | null;
                    errorMessage?: string | null;
                    rawAnalysis?: { resultEvaluationError?: string; trajectoryError?: string };
                };
                const rows: EvalRow[] = Array.isArray(data?.results) ? data.results : [];
                if (cancelled) return;
                const traceIdSet = new Set(traces.map(getTraceId));
                // 每个 taskId 只保留最新一次评测（rows 已按 createdAt desc 排序，遇到就 break）
                const seenTaskId = new Set<string>();
                const latestRows: EvalRow[] = [];
                for (const r of rows) {
                    if (!r.taskId || !traceIdSet.has(r.taskId)) continue;
                    if (seenTaskId.has(r.taskId)) continue;
                    seenTaskId.add(r.taskId);
                    latestRows.push(r);
                }
                const inFlight = latestRows.filter(r => r.status === 'pending' || r.status === 'running');
                // "静默失败"识别：status=done OR failed, 但既没轨迹分也没结果评测分,
                // 而且 rawAnalysis 里挂着错误信息——这是后端 LLM 调用挂了 / API key 失效那种。
                const failed = latestRows.filter(r => {
                    if (r.status !== 'done' && r.status !== 'failed') return false;
                    const hasScore = (r.trajectoryScore != null) || (r.resultEvaluationScore != null);
                    if (hasScore) return false;
                    const err = r.errorMessage
                        || r.rawAnalysis?.resultEvaluationError
                        || r.rawAnalysis?.trajectoryError;
                    return !!err || r.status === 'failed';
                });
                // 全量"跑过评测"集合——user 要求"无论成功失败都要列出来",
                // 这里把所有 latestRows 的 taskId 都收进 evaluatedTaskIds。
                // displayedTraces 用这个 set 决定"该出现在 ② 执行块",
                // status 派生还是用 done/pending/failed/partial 区分。
                if (latestRows.length > 0) {
                    setEvaluatedTaskIds(prev => {
                        const next = new Set(prev);
                        for (const r of latestRows) {
                            if (r.taskId) next.add(r.taskId);
                        }
                        return next;
                    });
                }
                if (inFlight.length === 0 && failed.length === 0) return;
                if (inFlight.length > 0) {
                    setTriggeredTaskIds(prev => {
                        const next = new Map(prev);
                        for (const r of inFlight) {
                            if (!r.taskId || next.has(r.taskId)) continue;
                            const ts = r.createdAt ? new Date(r.createdAt).getTime() : Date.now();
                            next.set(r.taskId, ts);
                        }
                        return next;
                    });
                }
                if (failed.length > 0) {
                    setFailedTaskIds(prev => {
                        const next = new Map(prev);
                        for (const r of failed) {
                            if (!r.taskId) continue;
                            const err = String(
                                r.errorMessage
                                || r.rawAnalysis?.resultEvaluationError
                                || r.rawAnalysis?.trajectoryError
                                || '评测异常',
                            ).trim();
                            next.set(r.taskId, err);
                        }
                        return next;
                    });
                }
                // 自动展开 ② 执行块——之前 refresh 后默认折叠,即使状态已经从后端恢复了,
                // 用户也看不到徽章(badge 渲染在 ② body 里)。
                setCaseExecOpen(true);
                if (inFlight.length === 0) return;
                // 周期性触发父组件 onReload,让 trace 行的分数从后端拉新（仅当还有 in-flight）
                let pollCount = 0;
                const pollTimer: ReturnType<typeof setInterval> = setInterval(() => {
                    onReload();
                    if (++pollCount >= 30 || cancelled) {
                        clearInterval(pollTimer);
                    }
                }, 3000);
                // 如果当前选中的 trace 也在 in-flight 里，开一次单条 trajectory 轮询
                if (selectedTraceId && inFlight.some(r => r.taskId === selectedTraceId)) {
                    scheduleTrajectoryPoll();
                }
            } catch {
                /* 静默——只是状态恢复，失败不阻塞主流程 */
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user, traces.length, traceEvaluationBatchId]);

    const scheduleTrajectoryPoll = useCallback(function scheduleNextTrajectoryPoll() {
        if (trajEvalPollRef.current) clearTimeout(trajEvalPollRef.current);
        trajEvalPollRef.current = setTimeout(async () => {
            const row = await fetchTrajectoryEval();
            if (row && (row.status === 'pending' || row.status === 'running')) {
                scheduleNextTrajectoryPoll();
            }
        }, 5000);
    }, [fetchTrajectoryEval]);


    // trajectoryEval 拉到时如果是 pending/running 状态，自动开轮询
    useEffect(() => {
        if (trajectoryEval && (trajectoryEval.status === 'pending' || trajectoryEval.status === 'running')) {
            scheduleTrajectoryPoll();
        }
        return () => {
            if (trajEvalPollRef.current) {
                clearTimeout(trajEvalPollRef.current);
                trajEvalPollRef.current = null;
            }
        };
    }, [trajectoryEval, scheduleTrajectoryPoll]);

    const bothRunning = batchRunning
        || trajectoryEval?.status === 'pending' || trajectoryEval?.status === 'running';
    /*
     * 主按钮点击：批量并行启动「结果分析 + 轨迹分析」
     *   - 目标集合：勾选了的 trace 优先；否则回落到当前选中那条
     *   - 结果分析：POST /api/eval/trajectory/run with taskIds[] —— 后端一次入队多条
     *   - 轨迹分析：N 次 POST /api/observe/executions/{id}/analyze-match，扇出并发
     *     analyze-match 内部会从 alignment 生成 Skill 归因候选并写入优化点
     *   - 隔离：Promise.allSettled，任一条任一边失败不阻断其他
     */
    const targetTraceIds = checkedTraceIds.size > 0
        ? Array.from(checkedTraceIds)
        : (selectedTraceId ? [selectedTraceId] : []);
    const runBothAnalyses = async () => {
        // 必须先关联评测任务才能评测——否则后端每次会新建一个孤立任务、结果归属混乱。
        if (bothRunning || targetTraceIds.length === 0 || !traceEvaluationBatchId) return;
        // 立刻记录"已触发"——② 执行块的状态徽章靠这个区分 pending/idle
        const triggerTs = Date.now();
        setTriggeredTaskIds(prev => {
            const next = new Map(prev);
            for (const id of targetTraceIds) next.set(id, triggerTs);
            return next;
        });
        // 同步记进"本次会话已提交"集合（不被 is_evaluating 清理）——保证选了几条就一直列几条。
        setSubmittedTaskIds(prev => {
            const next = new Set(prev);
            for (const id of targetTraceIds) next.add(id);
            return next;
        });
        // 清空这批 trace 的 failed 标记——用户重新触发就是想重试,旧错误别再挂着扰乱状态。
        // evaluatedTaskIds 保留(它代表"历史上跑过评测",重试不影响这事实)。
        setFailedTaskIds(prev => {
            if (prev.size === 0) return prev;
            const next = new Map(prev);
            for (const id of targetTraceIds) next.delete(id);
            return next;
        });
        setBatchRunning(true);
        try {
            if (onBatchAnalyze) {
                // 委托给顶层共享 helper（同一份实现，跟外面"一键测试"接同一通道）。
                // 返回值: 每条 trace 的 trajectory 失败原因（resultErrors 是整批一起入队所以独立）。
                const failures = await onBatchAnalyze(targetTraceIds);
                if (failures) {
                    const trajErrs = failures.trajectoryErrors || new Map<string, string>();
                    const resultErrAll = (failures.resultErrors || []).join('\n');
                    // 把失败原因写进 failedTaskIds——用户能在 ② 行右侧的 ⚠ 评测失败徽章 / 行内
                    // 红字看到具体原因（"轨迹评测：缺 mermaid…" / "结果评估入队失败：…"）。
                    if (trajErrs.size > 0 || resultErrAll) {
                        setFailedTaskIds(prev => {
                            const next = new Map(prev);
                            for (const id of targetTraceIds) {
                                const parts: string[] = [];
                                if (resultErrAll) parts.push(`结果评测：${resultErrAll}`);
                                const trajErr = trajErrs.get(id);
                                if (trajErr) parts.push(`轨迹评测：${trajErr}`);
                                if (parts.length > 0) next.set(id, parts.join('\n'));
                            }
                            return next;
                        });
                    }
                }
            }
            // 拉一遍当前选中 trace 的最新评估状态，让 UI 立刻刷新
            await fetchTrajectoryEval();
            scheduleTrajectoryPoll();
            onReload();
        } finally {
            setBatchRunning(false);
        }
    };

    const primaryLabel = bothRunning ? '分析中…'
        : checkedTraceIds.size > 0 ? `分析选中 ${checkedTraceIds.size} 条 Trace`
        : '分析当前 Trace';
    const primaryDisabled = bothRunning || targetTraceIds.length === 0 || (checkedTraceIds.size === 0 && !primarySkill?.name) || !traceEvaluationBatchId;

    // 「添加评测对象」入口 —— 评测对象始终是 Trace，这里选的是 Trace 的来路（添加方式），不是两种评测模式：
    //   · 选已有 Trace：直接挑现成执行记录评测
    //   · 用数据集生成：先执行 case 生成 Trace，再评测
    // 两种方式都把 Trace 的评测加入「当前评测任务」，统一在下方「② 评测执行」展示。
    // 两边 JSX 同一份：trace 模式渲染在 trace 的 ① body；dataset 模式经 BatchEvaluation 的 topConfigSlot 注入。
    const sourceModeToggle = (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: '#fafafa', border: '1px solid #e5e7eb', borderRadius: 6, marginBottom: 14, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#52525b' }}>添加评测对象（Trace）</span>
            <div style={{ display: 'inline-flex', background: '#fff', borderRadius: 5, padding: 3, gap: 2, border: '1px solid #e5e7eb' }}>
                <button
                    type="button"
                    onClick={() => setCaseSourceMode('trace')}
                    title="直接挑选现成的执行记录(Trace)来评测"
                    style={{
                        border: 0,
                        padding: '4px 12px',
                        background: caseSourceMode === 'trace' ? '#2563eb' : 'transparent',
                        color: caseSourceMode === 'trace' ? '#fff' : '#52525b',
                        borderRadius: 4,
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: 'pointer',
                    }}
                >📊 选已有 Trace</button>
                <button
                    type="button"
                    onClick={() => setCaseSourceMode('dataset')}
                    title="用数据集 case 执行 skill 生成新 Trace，再评测（比「选已有」多一步生成）"
                    style={{
                        border: 0,
                        padding: '4px 12px',
                        background: caseSourceMode === 'dataset' ? '#2563eb' : 'transparent',
                        color: caseSourceMode === 'dataset' ? '#fff' : '#52525b',
                        borderRadius: 4,
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: 'pointer',
                    }}
                >🗄 用数据集生成</button>
            </div>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: '#71717a' }}>
                两种方式都把 Trace 评测加入当前评测任务，统一在下方「② 评测执行」展示
            </span>
        </div>
    );

    // 共享配置: 数据集(参考集) + 评估器 下拉多选。trace 模式渲染在 ① body；dataset 模式经
    // BatchEvaluation 的 topConfigSlot 注入到它的 ① body 顶部——两模式同一位置、同一份选择。
    const sharedConfigBar = (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: '10px 12px', marginBottom: 12, background: '#fff', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <ConfigMultiSelect
                label="数据集"
                placeholder="选择参考数据集（可多选）"
                emptyHint="暂无数据集（可在数据集中心创建）"
                accent="#2563eb"
                options={(datasets || []).map(d => ({ id: d.id, name: d.name, meta: `${Array.isArray(d.cases) ? d.cases.length : 0} 例` }))}
                selectedIds={selectedDatasetIds || []}
                onChange={ids => onSelectedDatasetIdsChange?.(ids)}
            />
            <ConfigMultiSelect
                label="评估器"
                placeholder="选择评估器（可多选）"
                emptyHint="暂无评估器"
                accent="#7E22CE"
                options={(evaluatorOptions || []).map(e => ({ id: e.id, name: e.name }))}
                selectedIds={selectedEvaluatorIds || []}
                onChange={ids => onSelectedEvaluatorIdsChange?.(ids)}
            />
            <div style={{ fontSize: 11, color: '#a1a1aa' }}>
                数据集作为评测参考集（按 query 匹配 case 取预期结果）；评估器多选决定「开始分析」时调用哪些评估器。
            </div>
        </div>
    );

    // 评测任务选择器 (建新 + 选历史)。trace 模式放 ① actions；dataset 模式经 headerActions 注入。两模式共用同一 evaluatorRunId。
    const evalTaskPickerNode = (
        <EvalTaskPicker
            tasks={evalTaskOptions || []}
            selectedRunId={traceEvaluationBatchId}
            selectedTitle={traceEvaluationBatchTitle}
            onSelect={opt => onSelectEvalBatch?.(opt)}
            onCreateNew={() => onOpenEvalBatchDialog?.()}
        />
    );

    /* ─────────────────────────────────────────────────────
       ③ 结果块用的聚合统计：
       - 每条 trace 的 result/traj 分数都需要在 0-100 范围内（getTraceFlowScore 返回 0-1，乘以 100）
       - "已评测"门槛：结果分 + 轨迹分双双就绪（与 sa-score-dot.ok 同口径）
       - avgScore = (resultAvg + trajAvg) / 2，与外层卡片"已分析平均分"的语义对齐
       ─────────────────────────────────────────────────── */
    type ScoredTrace = {
        trace: TraceRecord;
        id: string;
        query: string;
        resultScore: number | null;
        trajScore: number | null;
        isEvaluating: boolean;
        lastEvalStatus: string | null;
        lastEvalError: string | null;
    };
    const scoredTraces: ScoredTrace[] = traces.map(t => {
        // answer_score / answerScore 后端写的是 0-1 (clampTaskScore 范围)，
        // 这里统一 × 100 转 0-100 跟 trajScore 一致——之前少了 × 100 导致
        // dual tab 显示"1 分"而详情显示"100 分"的量纲冲突 bug。
        const rRaw = typeof t.answer_score === 'number' ? t.answer_score
            : typeof t.answerScore === 'number' ? t.answerScore : null;
        const r = rRaw == null ? null
            : rRaw <= 1 ? Math.round(rRaw * 100)  // 0-1 normalized
            : Math.round(rRaw);                    // 防御性：已经是 0-100 的兼容
        // 方案A: 轨迹分统一口径——优先用后端聚合层算出的 trajectoryScore（0.45 完整性 + 0.35 工具
        // + 0.20 冗余, 再封顶, 其中 完整性=对齐覆盖率），没有(未评测/纯对齐旧数据)再回退 getTraceFlowScore
        // (matchJson.overallScore = 对齐覆盖率单维)。两者都是 0-1。
        const aggTraj = typeof t.trajectory_score === 'number' ? t.trajectory_score
            : typeof t.trajectoryScore === 'number' ? t.trajectoryScore : null;
        const j = aggTraj != null ? aggTraj : getTraceFlowScore(t);
        return {
            trace: t,
            id: getTraceId(t),
            query: t.query || '(无 query)',
            resultScore: r,
            trajScore: j == null ? null : Math.round(j * 100),
            // 后端 isActive (我们注册 evaluation-task-manager 的 activeTasks 后会真实返 true/false)
            isEvaluating: t.is_evaluating === true,
            // 后端 TrajectoryEvalResult 最近一次 status,让"评测失败"的 trace 即使有老分数也能正确显示
            lastEvalStatus: t.last_eval_status ?? null,
            lastEvalError: t.last_eval_error ?? null,
        };
    });
    // 每条 trace 的评测状态：
    //   done    —— 双分都有（完整成功）
    //   partial —— 只有一边的分（如 result 评测成功但 trajectory 没跑成功；后端 row.status=done 但缺一边）
    //   pending —— 触发了但分数还没回来（runBothAnalyses 调用 + recovery 从后端 pending/running 行恢复）
    //   failed  —— 后端 row 有 errorMessage 或 status=failed 或 status=done 但**全无**分（API key 失效那种"静默挂"）
    //   idle    —— 完全没触发过
    type EvalStatus = 'done' | 'partial' | 'pending' | 'failed' | 'idle';
    const getTraceEvalStatus = (s: { id: string; resultScore: number | null; trajScore: number | null; isEvaluating?: boolean; lastEvalStatus?: string | null }): EvalStatus => {
        // 优先级:
        // 1. pending: 后端正在跑(isEvaluating) 或 前端刚触发但还没反馈(triggeredTaskIds)
        //    对"已评测的 trace 再次评测"的场景必须优先于 done,否则会卡死显示已评测。
        // 2. failed: 后端 TrajectoryEvalResult 最近一次 status='failed'。优先于 done —— 即使
        //    trace 上次评测成功留下了分数,这次评测失败也要让用户看到。也兼顾前端 failedTaskIds
        //    (页面 session 内的 batch run 失败)。
        // 3. done: 双分都有 (完整成功)
        // 4. partial: 只有一边分数
        // 5. idle: 完全没数据
        if (s.isEvaluating || (transientStateMatchesRun && triggeredTaskIds.has(s.id))) return 'pending';
        if (s.lastEvalStatus === 'failed' || (transientStateMatchesRun && failedTaskIds.has(s.id))) return 'failed';
        if (s.resultScore != null && s.trajScore != null) return 'done';
        if (s.resultScore != null || s.trajScore != null) return 'partial';
        return 'idle';
    };
    // ② 表行/表头徽章统一口径：关联了评测任务时用本任务 meta 的分数判状态(与"已评测 X/Y"一致)，
    // 否则用 trace 自带的 answer_score / trajScore。避免徽章按 trace 旧分算 done、而行按任务分显示
    // 部分评测的撕裂。
    const getDisplayedTraceStatus = (s: ScoredTrace): EvalStatus => {
        if (!traceEvaluationBatchId) return getTraceEvalStatus(s);
        const meta = traceEvalResultsMap.get(s.id);
        if (!meta) return getTraceEvalStatus(s);
        if (meta.status === 'failed') return 'failed';
        if (meta.status === 'pending' || meta.status === 'running') return 'pending';
        if (meta.status === 'done') {
            if (meta.resultScore != null && meta.trajScore != null) return 'done';
            if (meta.resultScore != null || meta.trajScore != null) return 'partial';
            return 'failed';
        }
        return getTraceEvalStatus({ ...s, resultScore: meta.resultScore ?? null, trajScore: meta.trajScore ?? null });
    };
    // ② 评测执行 列表口径：
    //   - 关联了「评测任务」时：只列该任务(evaluatorRunId)的记录(traceEvalResultsMap) + 本次会话刚触发/失败的，
    //     使列表与上方"已评测 X/Y"、③ 总评分(都绑定该任务)一致；且每行都在任务里 → 都有评估 Trace。
    //     之前 recovery 拉的是全量结果(所有任务, limit 200)塞进 evaluatedTaskIds，导致列表显示几十条历史
    //     "已评测"(其它任务、无评估ID)，与 4/6 这种任务内统计对不上。
    //   - 未关联任务时：沿用 status / 历史口径(无论成功失败都列出)。
    const displayedTraces = scoredTraces.filter(s => {
        if (deletedTaskIds.has(s.id)) return false;
        if (traceEvaluationBatchId) {
            // submittedTaskIds 兜底：本次提交过的 trace 即使后端没产出结果行也保留在列表里，
            // 由下方 records 映射标成"未产出/失败"，不再静默消失。
            return traceEvalResultsMap.has(s.id)
                || (transientStateMatchesRun && (
                    triggeredTaskIds.has(s.id)
                    || failedTaskIds.has(s.id)
                    || submittedTaskIds.has(s.id)
                ));
        }
        return getTraceEvalStatus(s) !== 'idle' || evaluatedTaskIds.has(s.id);
    });
    // ② 评测执行 头部「已评测 X/Y」严格对应下面的列表(displayedTraces): 批次里若有 trace 不在
    // scoredTraces(不属于本 skill/版本、或已从列表移除等), 会被批次全量统计算进去却不进列表 →
    // 造成"已评测 5/5"而列表只有 4 条。头部改用列表口径, 与 ② 的 评测中/部分/失败 徽章同源。
    // (③ 总评分仍按批次全量统计, 与 source 无关, 见下方 caseResultPairs。)
    // 与 getDisplayedTraceStatus 同口径取每条显示行的分数(关联批次时用本任务 meta, 否则用 trace 自带)。
    const listResultPairs: { resultScore: number | null; trajScore: number | null }[] = displayedTraces.map(s => {
        if (!traceEvaluationBatchId) return { resultScore: s.resultScore, trajScore: s.trajScore };
        const m = traceEvalResultsMap.get(s.id);
        return { resultScore: m?.resultScore ?? null, trajScore: m?.trajScore ?? null };
    });
    const listValidPairs = listResultPairs.filter(
        p => typeof p.resultScore === 'number' && typeof p.trajScore === 'number',
    ) as { resultScore: number; trajScore: number }[];
    const listEvalTotalCount = displayedTraces.length;
    const listEvalDoneCount = listValidPairs.length;
    const listAvgResult = listValidPairs.length === 0 ? null
        : Math.round(listValidPairs.reduce((sum, p) => sum + p.resultScore, 0) / listValidPairs.length);
    const listAvgTraj = listValidPairs.length === 0 ? null
        : Math.round(listValidPairs.reduce((sum, p) => sum + p.trajScore, 0) / listValidPairs.length);
    const listAvgOverall = listAvgResult == null || listAvgTraj == null ? null : Math.round((listAvgResult + listAvgTraj) / 2);
    const listOverallScoreKlass: 'good' | 'warn' | 'bad' = listAvgOverall == null ? 'warn'
        : listAvgOverall >= 80 ? 'good' : listAvgOverall >= 60 ? 'warn' : 'bad';
    // 排除已在「评测执行」里删除的记录(deletedTaskIds)，否则删除后上方"已评测 X/Y · 平均评分"
    // 仍按旧集合统计、不随删除变化。与 displayedTraces 同口径。
    const fullyEvaluated = scoredTraces.filter(s =>
        !deletedTaskIds.has(s.id) && s.resultScore != null && s.trajScore != null,
    );
    // ③ 结果区口径：绑定当前「评测任务」(evaluatorRunId) 的有效评测记录，与 source(从Trace/从数据集)
    // 无关——切换 source 不应改变这个平均。有关联任务时用 traceEvalResultsMap(该任务全部记录, 已 ×100)；
    // 没关联任务时回退本地 scoredTraces(fullyEvaluated)。X=有效记录(双分都在), Y=任务总记录数。
    const caseResultPairs: { resultScore: number | null; trajScore: number | null }[] = traceEvaluationBatchId
        ? Array.from(traceEvalResultsMap.entries())
            .filter(([id]) => !deletedTaskIds.has(id))
            .map(([, m]) => ({ resultScore: m.resultScore ?? null, trajScore: m.trajScore ?? null }))
        : fullyEvaluated.map(s => ({ resultScore: s.resultScore, trajScore: s.trajScore }));
    const validResultPairs = caseResultPairs.filter(p => typeof p.resultScore === 'number' && typeof p.trajScore === 'number') as { resultScore: number; trajScore: number }[];
    const evalDoneCount = validResultPairs.length;
    const evalTotalCount = traceEvaluationBatchId ? caseResultPairs.length : traces.length;
    const avgResult = evalDoneCount === 0 ? null
        : Math.round(validResultPairs.reduce((sum, p) => sum + p.resultScore, 0) / evalDoneCount);
    const avgTraj = evalDoneCount === 0 ? null
        : Math.round(validResultPairs.reduce((sum, p) => sum + p.trajScore, 0) / evalDoneCount);
    const avgOverall = avgResult == null || avgTraj == null ? null : Math.round((avgResult + avgTraj) / 2);
    const overallScoreKlass: 'good' | 'warn' | 'bad' = avgOverall == null
        ? 'warn'
        : avgOverall >= 80 ? 'good' : avgOverall >= 60 ? 'warn' : 'bad';
    const passCount = validResultPairs.filter(p => (p.resultScore + p.trajScore) / 2 >= 60).length;
    const passRatePct = evalDoneCount === 0 ? 0 : Math.round((passCount / evalDoneCount) * 100);

    const effectiveDatasetExecutionRecords = datasetExecutionRecords
        .filter(record =>
            record.evaluatorRunId === traceEvaluationBatchId
            && (!record.executionTraceId || !deletedTaskIds.has(record.executionTraceId)),
        )
        .map(record => record.executionTraceId
            && !record.resultId
            && transientStateMatchesRun
            && triggeredTaskIds.has(record.executionTraceId)
            ? {
                ...record,
                status: 'evaluating',
                resultId: undefined,
                evaluationTraceId: undefined,
                resultEvalTraceId: undefined,
                trajEvalTraceId: undefined,
                resultScore: null,
                trajScore: null,
            }
            : record);
    const datasetCaseIds = new Set(effectiveDatasetExecutionRecords.map(record => record.caseId).filter(Boolean));
    const datasetTraceIds = new Set(effectiveDatasetExecutionRecords.map(record => record.executionTraceId).filter(Boolean));
    const traceExecutionRecords: EvalRecordRow[] = displayedTraces
        .filter(s => {
            const meta = traceEvalResultsMap.get(s.id);
            return !datasetTraceIds.has(s.id) && (!meta?.caseId || !datasetCaseIds.has(meta.caseId));
        })
        .map(s => {
            const meta = traceEvalResultsMap.get(s.id);
            const taskScoped = !!traceEvaluationBatchId;
            const rScore = taskScoped ? (meta?.resultScore ?? null) : s.resultScore;
            const jScore = taskScoped ? (meta?.trajScore ?? null) : s.trajScore;
            const st = getDisplayedTraceStatus(s);
            let compStatus: string = st === 'done' ? 'done' : st === 'failed' ? 'failed' : st === 'partial' ? 'partial' : 'evaluating';
            let errorMsg = (transientStateMatchesRun ? failedTaskIds.get(s.id) : undefined) || meta?.errorMessage || undefined;
            if (meta?.status === 'failed' && compStatus !== 'done') compStatus = 'failed';
            if (st === 'idle'
                && !meta
                && transientStateMatchesRun
                && submittedTaskIds.has(s.id)
                && !triggeredTaskIds.has(s.id)) {
                compStatus = 'failed';
                errorMsg = errorMsg || '未在本次评测任务产出评测结果（可能该 trace 未匹配到 case 或未引用当前 skill）';
            }
            return {
                id: s.id,
                caseId: meta?.caseId,
                caseLabel: s.query || s.id.slice(0, 12),
                caseTitle: s.query || s.id,
                executionTraceId: s.id,
                evaluationTraceId: meta?.evaluationTraceId,
                resultEvalTraceId: meta?.resultEvalTraceId,
                trajEvalTraceId: meta?.trajEvalTraceId,
                datasetId: meta?.datasetId,
                evaluatorRunId: traceEvaluationBatchId || undefined,
                resultId: meta?.resultId,
                status: compStatus,
                resultScore: rScore,
                trajScore: jScore,
                errorMsg,
            };
        });
    const representedTraceIds = new Set([
        ...effectiveDatasetExecutionRecords.map(record => record.executionTraceId).filter(Boolean),
        ...traceExecutionRecords.map(record => record.executionTraceId).filter(Boolean),
    ]);
    const resultOnlyExecutionRecords: EvalRecordRow[] = Array.from(traceEvalResultsMap.values())
        .filter(meta =>
            meta.taskId
            && !deletedTaskIds.has(meta.taskId)
            && !representedTraceIds.has(meta.taskId)
            && (!meta.caseId || !datasetCaseIds.has(meta.caseId)),
        )
        .map(meta => ({
            id: meta.taskId!,
            caseId: meta.caseId,
            caseLabel: meta.caseId || meta.taskId!,
            caseTitle: meta.caseId || meta.taskId!,
            executionTraceId: meta.taskId,
            evaluationTraceId: meta.evaluationTraceId,
            resultEvalTraceId: meta.resultEvalTraceId,
            trajEvalTraceId: meta.trajEvalTraceId,
            evaluatorRunId: traceEvaluationBatchId || undefined,
            resultId: meta.resultId,
            datasetId: meta.datasetId,
            status: meta.status === 'done' ? 'done' : meta.status === 'failed' ? 'failed' : 'evaluating',
            resultScore: meta.resultScore ?? null,
            trajScore: meta.trajScore ?? null,
            errorMsg: meta.errorMessage,
        }));
    const executionRecords = [...effectiveDatasetExecutionRecords, ...traceExecutionRecords, ...resultOnlyExecutionRecords];

    // 为 dual-tab 各自生成 FindingGroup（未通过 / 通过 / 待评测），每条 IssueCard 的 dimension
    // 字段用 traceId 编码——FindingsGrouped 当前没暴露 onClick，所以"点 case → 切换 selectedTrace"
    // 通过下方的「在下方查看完整分析 ↓」按钮（沿用 ev-issue-drill button）显式触发。
    const buildFindingsForTab = (tab: 'result' | 'trajectory'): FindingGroup[] => {
        const failedItems: FindingItem[] = [];
        const passedItems: FindingItem[] = [];
        const pendingItems: FindingItem[] = [];
        for (const s of scoredTraces) {
            const score = tab === 'result' ? s.resultScore : s.trajScore;
            const shortQ = s.query.length > 80 ? s.query.slice(0, 80) + '…' : s.query;
            const otherScore = tab === 'result' ? s.trajScore : s.resultScore;
            const evidence = score != null
                ? `${tab === 'result' ? '结果分' : '轨迹分'} ${score}（另一维 ${otherScore ?? '—'}）`
                : '未评测';
            if (score == null) {
                pendingItems.push({
                    id: s.id, summary: shortQ, severity: 'low', evidence: '待评测', reasoning: null, passed: false,
                    dimension: `trace ${s.id.slice(0, 8)}`,
                });
            } else if (score >= 60) {
                passedItems.push({
                    id: s.id, summary: shortQ, severity: 'low', evidence, reasoning: null, passed: true,
                    dimension: `trace ${s.id.slice(0, 8)}`,
                });
            } else {
                failedItems.push({
                    id: s.id, summary: shortQ,
                    severity: score < 40 ? 'high' : 'medium',
                    evidence, reasoning: null,
                    suggestedFix: `点上方 Trace 列表选中此条 → 下方深度视图显示完整 ${tab === 'result' ? 'ResultAnalysisSection' : 'TraceAlignmentPanel + Skill 归因'}`,
                    dimension: `trace ${s.id.slice(0, 8)}`,
                });
            }
        }
        return [
            { key: 'failed', title: '未通过', desc: `${tab === 'result' ? '结果分' : '轨迹分'} < 60，点 case 在下方深度视图看完整分析`, status: failedItems.length === 0 ? 'passed' : 'failed', scoreLabel: `${failedItems.length} 个问题`, items: failedItems },
            { key: 'passed', title: '通过', desc: `${tab === 'result' ? '结果分' : '轨迹分'} ≥ 60`, status: 'passed', scoreLabel: `${passedItems.length} 通过`, items: passedItems },
            { key: 'pending', title: '待评测', desc: '还没评测或缺一边的 score', status: 'notEvaluated', scoreLabel: `${pendingItems.length} 待评`, items: pendingItems },
        ];
    };

    return (
        <section className="sa-detail">
            <DetailHeader
                title="用例分析"
                subtitle={`${skill?.name || '未选择 Skill'}${version != null ? ` · v${version}` : ''}`}
                badge="LLM Judge"
                onBack={onBack}
                onOptimize={onOptimize}
                /* primaryLabel 不传 = 不渲染主按钮；"分析"按钮已移到 ② 执行块 toolbar */
            />

            {/* 「用例来源」toggle 不在这里 —— 已下放到两种模式各自的 ① 配置 body 顶部：
                trace 模式：渲染在 trace mode 自己的 ① SectionShell body
                dataset 模式：通过 BatchEvaluation 的 topConfigSlot prop 注入到 BE ① body
                两种模式下视觉位置一致："在 ① 配置块的顶部" */}

            {/* trace 模式：完整 ① 配置 SectionShell（含 source toggle + trace list） */}
            {caseSourceMode === 'trace' && (
            <SectionShell
                num={1}
                variant="config"
                title="配置"
                desc="该 skill 版本关联的全部 trace（含已评测和未评测）；勾选 → 到 ② 触发分析"
                open={caseConfigOpen}
                onToggle={() => setCaseConfigOpen(o => !o)}
                summary={
                    <>
                        <span>用例来源</span>
                        <code>从 Trace</code>
                        <span>· 关联 <code>{traces.length}</code> 条</span>
                        <span>· 已评测 <code>{evalDoneCount}</code></span>
                    </>
                }
                // trace 模式评测任务关联: 跟 dataset 模式 BatchEvaluation 的 ① actions 一致样式。
                // 已关联时显示紫色徽章 + "切换/新建"; 未关联时只有"+ 新增评测任务"按钮。
                // state 走 traceEvaluationBatchId / 持久化在 localStorage (SkillAnalysisPage 维护)。
                actions={evalTaskPickerNode}
            >
                {/* AB 式配置: 数据集(参考集) + 评估器 下拉多选 —— 放在 source 切换之上 (用户要求) */}
                {sharedConfigBar}
                {/* source-mode 切换 chip：放在 ① 配置块内（用户要求） */}
                {sourceModeToggle}
                {/* trace 列表 */}
            <div className="sa-trace-picker" style={{ display: 'block' }}>
                <aside className="sa-trace-list" aria-label="该 Skill 的 Trace" style={{ width: '100%', maxWidth: 'none' }}>
                    <div className="sa-trace-list-head">
                        <div className="sa-trace-list-title">
                            <h3>该 Skill 的 Trace <small>({traces.length})</small></h3>
                        </div>
                        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索 query 或 taskId..." />
                        <div className="sa-tabs">
                            <button className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>全部 {traces.length}</button>
                            <button className={tab === 'analyzed' ? 'active' : ''} onClick={() => setTab('analyzed')}>已评估</button>
                            <button className={tab === 'pending' ? 'active' : ''} onClick={() => setTab('pending')}>未评估</button>
                            <button className={tab === 'deviation' ? 'active' : ''} onClick={() => setTab('deviation')}>高偏离</button>
                        </div>
                        {/* 批量选择控件——已勾选数 + 全选当前页 / 全选全部过滤结果 / 清空 */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--sa-muted)', marginTop: 6, flexWrap: 'wrap' }}>
                            <span>已勾选 <b style={{ color: 'var(--sa-text)' }}>{checkedTraceIds.size}</b></span>
                            <button
                                type="button"
                                onClick={() => setCheckedTraceIds(new Set([...checkedTraceIds, ...visibleTraces.map(getTraceId)]))}
                                style={{ background: 'transparent', border: 'none', color: 'var(--sa-primary)', cursor: 'pointer', fontSize: 11, padding: 0 }}
                                title={`勾选当前页 ${visibleTraces.length} 条 (跨页不影响)`}
                            >全选本页</button>
                            {filtered.length > visibleTraces.length && (
                                <>
                                    <span>·</span>
                                    <button
                                        type="button"
                                        onClick={() => setCheckedTraceIds(new Set(filtered.map(getTraceId)))}
                                        style={{ background: 'transparent', border: 'none', color: 'var(--sa-primary)', cursor: 'pointer', fontSize: 11, padding: 0 }}
                                        title={`勾选所有 ${filtered.length} 条 (跨所有页)`}
                                    >全选所有 ({filtered.length})</button>
                                </>
                            )}
                            <span>·</span>
                            <button
                                type="button"
                                onClick={() => setCheckedTraceIds(new Set())}
                                disabled={checkedTraceIds.size === 0}
                                style={{ background: 'transparent', border: 'none', color: checkedTraceIds.size === 0 ? 'var(--sa-muted)' : 'var(--sa-primary)', cursor: checkedTraceIds.size === 0 ? 'not-allowed' : 'pointer', fontSize: 11, padding: 0 }}
                            >清空</button>
                        </div>
                        {/* 分页栏: 只在 >1 页时出现, 避免少量 trace 时占空间 */}
                        {pageCount > 1 && (
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 11, color: 'var(--sa-muted)', marginTop: 8, padding: '6px 8px', background: '#fafafa', borderRadius: 4 }}>
                                <span>
                                    第 <b style={{ color: 'var(--sa-text)' }}>{pageIndex + 1}</b> / {pageCount} 页 ·
                                    显示 <b>{pageIndex * PAGE_SIZE + 1}-{Math.min((pageIndex + 1) * PAGE_SIZE, filtered.length)}</b> /
                                    共 <b>{filtered.length}</b> 条
                                </span>
                                <div style={{ display: 'flex', gap: 4 }}>
                                    <button
                                        type="button"
                                        onClick={() => setPageIndex(0)}
                                        disabled={pageIndex === 0}
                                        style={{ border: '1px solid var(--sa-line)', background: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 11, cursor: pageIndex === 0 ? 'not-allowed' : 'pointer', color: pageIndex === 0 ? 'var(--sa-muted)' : 'var(--sa-text)' }}
                                        title="首页"
                                    >«</button>
                                    <button
                                        type="button"
                                        onClick={() => setPageIndex(Math.max(0, pageIndex - 1))}
                                        disabled={pageIndex === 0}
                                        style={{ border: '1px solid var(--sa-line)', background: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 11, cursor: pageIndex === 0 ? 'not-allowed' : 'pointer', color: pageIndex === 0 ? 'var(--sa-muted)' : 'var(--sa-text)' }}
                                        title="上一页"
                                    >‹</button>
                                    <button
                                        type="button"
                                        onClick={() => setPageIndex(Math.min(pageCount - 1, pageIndex + 1))}
                                        disabled={pageIndex >= pageCount - 1}
                                        style={{ border: '1px solid var(--sa-line)', background: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 11, cursor: pageIndex >= pageCount - 1 ? 'not-allowed' : 'pointer', color: pageIndex >= pageCount - 1 ? 'var(--sa-muted)' : 'var(--sa-text)' }}
                                        title="下一页"
                                    >›</button>
                                    <button
                                        type="button"
                                        onClick={() => setPageIndex(pageCount - 1)}
                                        disabled={pageIndex >= pageCount - 1}
                                        style={{ border: '1px solid var(--sa-line)', background: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 11, cursor: pageIndex >= pageCount - 1 ? 'not-allowed' : 'pointer', color: pageIndex >= pageCount - 1 ? 'var(--sa-muted)' : 'var(--sa-text)' }}
                                        title="末页"
                                    >»</button>
                                </div>
                            </div>
                        )}
                        {/* 未绑定版本统计——让用户立刻知道"为什么过滤版本后看不到那条" */}
                        {(() => {
                            const unboundCount = traces.filter(t => getTracePrimarySkill(t)?.version == null).length;
                            if (unboundCount === 0) return null;
                            return (
                                <div
                                    style={{ marginTop: 6, padding: '4px 8px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 4, fontSize: 11, color: 'var(--sa-warning, #d97706)' }}
                                    title="未绑定版本的 trace 上传时没捕获到 skill 版本号——常见原因：agent 没显式用 skill 工具加载、skill 名跟 DB 对不上、或 skill 注册晚于 trace 上传。这些 trace 只能在版本筛选「全部」下看到。"
                                >
                                    ⚠ 当前列表共 {traces.length} 条，其中 <b>{unboundCount}</b> 条未绑定版本，只在「全部」下可见
                                </div>
                            );
                        })()}
                    </div>
                    <div className="sa-trace-list-body">
                        {loading && (
                            <div className="sa-empty-small">
                                正在加载 <b>{skill?.name || ''}</b> 的执行链路…
                            </div>
                        )}
                        {!loading && filtered.length === 0 && <div className="sa-empty-small">暂无匹配 Trace</div>}
                        {/* visibleTraces 是 filtered 按 PAGE_SIZE 切的当前页, 详见上面 pagination 定义 */}
                        {visibleTraces.map(trace => {
                            const id = getTraceId(trace);
                            // 已评估 = 结果分（answer_score）+ 轨迹分（flow-parser overallScore）双双就绪。
                            // 单边的归入"未评估"——跟外面卡片"已完整评测"口径一致，避免视觉/概念双轨。
                            const resultScore = typeof trace.answer_score === 'number' ? trace.answer_score
                                : typeof trace.answerScore === 'number' ? trace.answerScore : null;
                            const trajScore = getTraceFlowScore(trace);
                            const evaluated = resultScore != null && trajScore != null;
                            const checked = checkedTraceIds.has(id);
                            // Skill 版本绑定状态：来源 Execution.skillVersion（data-service 兜底已塞）。
                            // null = "未绑定"——这条 trace 只能在版本过滤"全部"下出现。
                            const boundVersion = getTracePrimarySkill(trace)?.version ?? null;
                            return (
                                <div
                                    key={id}
                                    role="button"
                                    tabIndex={0}
                                    className={`sa-trace-row ${selectedTraceId === id ? 'active' : ''}`}
                                    onClick={() => onSelectedTraceChange(id)}
                                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectedTraceChange(id); } }}
                                >
                                    {/* 勾选框——批量分析用。点击/键盘事件 stopPropagation 避免触发行的"选中" */}
                                    <label
                                        onClick={e => e.stopPropagation()}
                                        style={{ display: 'inline-flex', alignItems: 'center', marginRight: 4, cursor: 'pointer' }}
                                        title="勾选后顶部「分析」按钮会批量启动选中的所有 Trace"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={checked}
                                            onChange={() => toggleChecked(id)}
                                            onClick={e => e.stopPropagation()}
                                            style={{ margin: 0, cursor: 'pointer' }}
                                        />
                                    </label>
                                    <span
                                        className={`sa-score-dot ${evaluated ? 'ok' : 'pending'}`}
                                        title={evaluated ? '已评估（结果分 + 轨迹分均就绪）' : '未评估（结果分 / 轨迹分至少缺一个）'}
                                    >
                                        {evaluated ? '✓' : '○'}
                                    </span>
                                    <span className="sa-trace-text">
                                        <span className="sa-trace-id">
                                            {id}
                                            {/* 来源徽章: A/B 灰度 vs 用例分析 vs 真实用户调用 */}
                                            {(() => {
                                                const source = classifyTraceSource(trace.agentName || trace.agent);
                                                if (source === 'ab') {
                                                    return (
                                                        <span
                                                            title="来自 A/B 测试 (grayscale-skill-agent / grayscale-baseline-agent)"
                                                            style={{ marginLeft: 6, padding: '1px 6px', background: 'rgba(29,158,117,.1)', color: '#1D9E75', border: '1px solid rgba(29,158,117,.3)', borderRadius: 99, fontSize: 10, fontWeight: 600 }}
                                                        >🔀 A/B</span>
                                                    );
                                                }
                                                if (source === 'batch') {
                                                    return (
                                                        <span
                                                            title="来自用例分析「从数据集」(skill-debug-executor / batch-eval-agent)"
                                                            style={{ marginLeft: 6, padding: '1px 6px', background: 'rgba(24,95,165,.1)', color: '#185FA5', border: '1px solid rgba(24,95,165,.3)', borderRadius: 99, fontSize: 10, fontWeight: 600 }}
                                                        >📊 用例分析</span>
                                                    );
                                                }
                                                // real: 真实用户调用 (默认不加徽章, 让 A/B / batch 那两个特殊来源突出)
                                                return null;
                                            })()}
                                            <small>{formatShortDate(trace.timestamp)}</small>
                                        </span>
                                        <span className="sa-trace-query">{trace.query || '无输入内容'}</span>
                                        <span className="sa-trace-sub">
                                            {trace.framework || 'Unknown'}
                                            {trace.timeCost ? ` · ${trace.timeCost}` : ''}
                                            {evaluated ? ' · 已评估' : ' · 未评估'}
                                            {boundVersion != null ? (
                                                <span
                                                    title={`已绑定 v${boundVersion}——在版本筛选选 v${boundVersion} 才会看到这条`}
                                                    style={{ marginLeft: 6, padding: '1px 6px', background: 'var(--sa-success-soft, rgba(34,197,94,.1))', color: 'var(--sa-success, #16a34a)', border: '1px solid var(--sa-success-line, rgba(34,197,94,.3))', borderRadius: 99, fontSize: 10, fontWeight: 600 }}
                                                >v{boundVersion}</span>
                                            ) : (
                                                <span
                                                    title="未捕获到 skill 版本——上传时 interactions 里没有 skill 工具调用、payload 没带 skill_version、且 skill 名查 DB 也没拿到 activeVersion。这条 trace 只能在「全部」版本过滤下显示"
                                                    style={{ marginLeft: 6, padding: '1px 6px', background: 'var(--sa-warning-soft, rgba(251,191,36,.12))', color: 'var(--sa-warning, #d97706)', border: '1px solid var(--sa-warning-line, rgba(251,191,36,.32))', borderRadius: 99, fontSize: 10, fontWeight: 600 }}
                                                >未绑定版本</span>
                                            )}
                                        </span>
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </aside>
            </div>
                {/* 统一「开始评测」按钮 —— 放在 ① 配置末尾 (跟 A/B 一致)。trace 模式: 直接评测勾选的 trace。 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--ev-line)' }}>
                    <button
                        type="button"
                        onClick={runBothAnalyses}
                        disabled={primaryDisabled}
                        style={{
                            padding: '9px 22px',
                            background: primaryDisabled ? 'var(--ev-line-strong)' : 'var(--ev-info)',
                            color: '#fff', border: 'none', borderRadius: 6,
                            fontSize: 14, fontWeight: 700,
                            cursor: primaryDisabled ? 'not-allowed' : 'pointer',
                            opacity: primaryDisabled ? 0.6 : 1,
                        }}
                        title={!traceEvaluationBatchId ? '请先在上方"评测任务"里新建或选择一个评测任务' : primaryDisabled ? '请先在上方勾选 trace（且 trace 有主 skill）' : '对勾选的 trace 直接开始评测'}
                    >
                        {bothRunning ? '评测中…' : checkedTraceIds.size > 0 ? `▶ 开始评测（${checkedTraceIds.size} 条）` : '▶ 开始评测'}
                    </button>
                    <span style={{ fontSize: 11, color: !traceEvaluationBatchId ? 'var(--ev-warning)' : 'var(--ev-muted)' }}>
                        {!traceEvaluationBatchId
                            ? '请先在上方「评测任务」新建或选择一个任务，再开始评测'
                            : '勾选 trace 后开始评测；进度见 ② 评测执行'}
                    </span>
                </div>
            </SectionShell>
            )}{/* /trace mode ① */}

            {/* dataset 模式：① 之后直接渲染 BatchEvaluation 接管 ②/③。
                外裹 .debug-root 是为了把 BatchEvaluation 用到的 CSS 变量
                （--ink / --accent / --bg-soft 等，定义在 debug.css 的 .debug-root 选择器上）
                带进来——否则 .d-btn.primary 的 background: var(--ink) 解析为空，按钮"看不见"。 */}
            {caseSourceMode === 'dataset' && (
                <div className="debug-root" style={{ background: 'transparent' }}>
                    <BatchEvaluation
                        newTaskTrigger={0}
                        historyPanelTrigger={0}
                        controlled
                        hideExecAndResult
                        topConfigSlot={<>{sharedConfigBar}{sourceModeToggle}</>}
                        headerActions={evalTaskPickerNode}
                        controlledDatasetIds={selectedDatasetIds}
                        controlledEvaluatorIds={selectedEvaluatorIds}
                        controlledEvalBatchId={traceEvaluationBatchId}
                        controlledEvalBatchTitle={traceEvaluationBatchTitle}
                        controlledSkillId={skill?.id}
                        controlledVersionId={skill?.versions?.find(item => item.version === version)?.id || ''}
                        onExecutionRecordsChange={setDatasetExecutionRecords}
                    />
                </div>
            )}

            {/* ② 评测执行 + ③ 分析结果：两种 source 下统一渲染（绑定当前评测任务，与 source 无关）。
               「从数据集」只是多了一步产生 Trace；产生后的 Trace 评测同样落到当前评测任务，统一在这里展示。
               dataset 模式下 BatchEvaluation 用 hideExecAndResult 只渲染 ① 配置，②/③ 由这里统一出。 */}
            {(<>

            {/* ─────────── ② 评测执行 ─────────── */}
            <SectionShell
                num={2}
                variant="exec"
                title="评测执行"
                desc="对勾选的 trace 触发结果 + 轨迹双分析；实时展示评测进度，下方表列已评测 trace，点「评测结果」列查看逐条评测详情"
                open={caseExecOpen}
                onToggle={() => setCaseExecOpen(o => !o)}
                summary={
                    <>
                        <span>已评测</span>
                        <code>{listEvalDoneCount} / {listEvalTotalCount}</code>
                        {listAvgOverall != null && (
                            <span>· 平均评分 <b style={{ color: listOverallScoreKlass === 'good' ? 'var(--ev-success)' : listOverallScoreKlass === 'bad' ? 'var(--ev-error)' : 'var(--ev-warning)' }}>{listAvgOverall} 分</b></span>
                        )}
                        {/* 评测中 / 评测失败 徽章：折叠态下也能看到"还有 N 条在跑 / X 条失败"——
                            之前 refresh 后 ② 折叠用户完全感知不到后台 in-flight 评测 / 静默失败,
                            以为评测丢了。 */}
                        {(() => {
                            const pendingCount = executionRecords.filter(record =>
                                record.status === 'pending'
                                || record.status === 'executing'
                                || record.status === 'executed'
                                || record.status === 'evaluating',
                            ).length;
                            return pendingCount > 0 ? (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--ev-info)', fontWeight: 600 }}>
                                    · <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'currentColor', animation: 'pulse 1.5s ease-in-out infinite' }} />
                                    进行中 <b>{pendingCount}</b> 条
                                </span>
                            ) : null;
                        })()}
                        {(() => {
                            const partialCount = executionRecords.filter(record => record.status === 'partial').length;
                            return partialCount > 0 ? (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--ev-warning)', fontWeight: 600 }} title="只跑成功了一边（result 或 trajectory）。展开 ② 点行查看已有分析。">
                                    · ◐ 部分评测 <b>{partialCount}</b> 条
                                </span>
                            ) : null;
                        })()}
                        {(() => {
                            const failedCount = executionRecords.filter(record => record.status === 'failed').length;
                            return failedCount > 0 ? (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--ev-error)', fontWeight: 600 }} title="后端 LLM 评测调用挂了——常见原因：API key 失效 / 模型配额不足 / 网络。展开 ② 看每条具体错误。">
                                    · ⚠ 评测失败 <b>{failedCount}</b> 条
                                </span>
                            ) : null;
                        })()}
                        {checkedTraceIds.size > 0 && <span>· 勾选 <b>{checkedTraceIds.size}</b> 条待分析</span>}
                    </>
                }
            >
                {/* 评测执行记录表 (A/B 同款三列形态, 共享 ExecutionRecordsTable):
                    执行 session id → 链路追踪 (/trace) · 评测状态/进度 · 评测结果 → 逐条评测详情 (/eval/trajectory)。
                    数据由 displayedTraces 映射, runBatchTraceAnalysis 的轮询会刷新状态。
                    「开始评测」按钮已统一到 ① 配置块末尾。 */}
                <ExecutionRecordsTable
                    emptyHint={'还没触发过评测。在 ① 配置块勾选 trace → 点末尾「开始评测」。'}
                    onRowClick={rec => {
                        const t = displayedTraces.find(x => x.id === rec.executionTraceId);
                        if (!t) return;
                        const st = getTraceEvalStatus(t);
                        if (st === 'done' || st === 'partial') {
                            onSelectedTraceChange(rec.executionTraceId!);
                            setCaseResultOpen(true);
                        }
                    }}
                    onRetry={async rec => {
                        const id = rec.executionTraceId;
                        if (!id) return;
                        // 立刻给反馈：把这条标记为"已触发"——getTraceEvalStatus 读 triggeredTaskIds
                        // 返回 'pending'，行状态徽章随即切到「评测中」(spinner) 且重试按钮置灰，
                        // 不必等后端 is_evaluating 回报或手动刷新。和 ① 配置块「开始评测」同款。
                        setTriggeredTaskIds(prev => { const next = new Map(prev); next.set(id, Date.now()); return next; });
                        // 重试即重来：清掉旧失败标记，别再挂着扰乱状态。
                        setFailedTaskIds(prev => { if (!prev.has(id)) return prev; const next = new Map(prev); next.delete(id); return next; });
                        if (!onBatchAnalyze) return;
                        // onBatchAnalyze 内部已做 30×3s 轮询 reloadTraces，分数会随轮询实时回填。
                        const failures = await onBatchAnalyze([id]);
                        if (failures) {
                            const trajErr = failures.trajectoryErrors?.get(id);
                            const resultErrAll = (failures.resultErrors || []).join('\n');
                            if (trajErr || resultErrAll) {
                                setFailedTaskIds(prev => {
                                    const next = new Map(prev);
                                    const parts: string[] = [];
                                    if (resultErrAll) parts.push(`结果评测：${resultErrAll}`);
                                    if (trajErr) parts.push(`轨迹评测：${trajErr}`);
                                    if (parts.length > 0) next.set(id, parts.join('\n'));
                                    return next;
                                });
                            }
                        }
                    }}
                    onDelete={async rec => {
                        const id = rec.executionTraceId;
                        if (!id) return;
                        if (typeof window !== 'undefined' && !window.confirm('确定从「评测执行」列表删除这条记录吗？\n该 trace 在当前评测任务下的评测结果会被删除（trace 本身保留，可重新评测）。')) return;
                        try {
                            if (user) {
                                const res = await apiFetch('/api/eval/trajectory/results', {
                                    method: 'DELETE',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ user, taskId: id, runId: traceEvaluationBatchId || undefined }),
                                });
                                if (!res.ok) {
                                    const data = await res.json().catch(() => ({}));
                                    alert('删除失败：' + (data?.error || `HTTP ${res.status}`));
                                    return;
                                }
                            }
                            // 前端隐藏 + 持久化，并从各状态集合移除，避免轮询/恢复又把它显示回来。
                            const next = new Set(deletedTaskIds); next.add(id); persistDeletedTaskIds(next);
                            setTriggeredTaskIds(prev => { if (!prev.has(id)) return prev; const m = new Map(prev); m.delete(id); return m; });
                            setFailedTaskIds(prev => { if (!prev.has(id)) return prev; const m = new Map(prev); m.delete(id); return m; });
                            setEvaluatedTaskIds(prev => { if (!prev.has(id)) return prev; const ss = new Set(prev); ss.delete(id); return ss; });
                        } catch (e) {
                            alert('删除失败：' + (e instanceof Error ? e.message : String(e)));
                        }
                    }}
                    records={executionRecords}
                />
            </SectionShell>

            {/* ─────────── ③ 结果 · 用例分析（仅 trace 模式） ─────────── */}
            <SectionShell
                num={3}
                variant="result"
                title="分析结果"
                desc={evalDoneCount > 0
                    ? `已评测 ${evalDoneCount} / ${evalTotalCount} · 结果 + 轨迹 双维度`
                    : '尚未评测'}
                open={caseResultOpen}
                onToggle={() => setCaseResultOpen(o => !o)}
                summary={
                    avgOverall != null ? (
                        <>
                            <span>总评分</span>
                            <code className={`score-${overallScoreKlass}`}>{avgOverall} 分</code>
                            <span>· 通过 <b>{passCount}</b> / <b>{evalDoneCount}</b></span>
                        </>
                    ) : (
                        <span style={{ color: 'var(--ev-muted)' }}>未评测</span>
                    )
                }
            >
                {/* 总 Hero —— 总评分 + 4 mini（结果均分 / 轨迹均分 / 通过率 / 进度） */}
                <div className="ev-hero">
                    <div className="ev-hero-main">
                        <div className={`ev-hero-num ${overallScoreKlass}`}>
                            {avgOverall ?? '--'}
                            <span className="ev-hero-unit">分</span>
                        </div>
                        <div className="ev-hero-label">
                            总评分 · 结果 + 轨迹 平均 · 已评测 {evalDoneCount} / {evalTotalCount}
                            <span style={{ display: 'block', fontSize: 11, color: 'var(--ev-muted)', fontWeight: 400, marginTop: 2 }}>
                                跨当前评测任务的有效评测聚合 · 不随 source(从Trace/从数据集) 切换变化
                            </span>
                        </div>
                    </div>
                    <div className="ev-hero-sub">
                        <div className="ev-hero-sub-item">
                            <div className={`ev-hero-sub-num ${avgResult == null ? '' : avgResult >= 80 ? 'good' : avgResult < 60 ? 'bad' : ''}`}>
                                {avgResult ?? '--'}
                            </div>
                            <div className="ev-hero-sub-label">结果分析 均分</div>
                            <div className="ev-hero-sub-hint">输出是否符合预期</div>
                        </div>
                        <div className="ev-hero-sub-item">
                            <div className={`ev-hero-sub-num ${avgTraj == null ? '' : avgTraj >= 80 ? 'good' : avgTraj < 60 ? 'bad' : ''}`}>
                                {avgTraj ?? '--'}
                            </div>
                            <div className="ev-hero-sub-label">轨迹分析 均分</div>
                            <div className="ev-hero-sub-hint">执行路径是否合理</div>
                        </div>
                        <div className="ev-hero-sub-item">
                            <div className={`ev-hero-sub-num ${evalDoneCount === 0 ? '' : passRatePct >= 80 ? 'good' : passRatePct < 50 ? 'bad' : ''}`}>
                                {evalDoneCount === 0 ? '--' : `${passRatePct}%`}
                            </div>
                            <div className="ev-hero-sub-label">通过率</div>
                            <div className="ev-hero-sub-hint">已评测中达标</div>
                        </div>
                        <div className="ev-hero-sub-item">
                            <div className="ev-hero-sub-num">{evalDoneCount} / {evalTotalCount}</div>
                            <div className="ev-hero-sub-label">评测进度</div>
                            <div className="ev-hero-sub-hint">{Math.max(0, evalTotalCount - evalDoneCount)} 条待评测</div>
                        </div>
                    </div>
                </div>

            </SectionShell>{/* /③ 结果 */}
            </>)}{/* /② 评测执行 + ③ 分析结果 (统一, 与 source 无关) */}
        </section>
    );
}

function StaticCompliancePanel({
    skill,
    version,
    user,
    summary,
    loading,
    onBack,
    onReload,
    onOptimize,
}: {
    skill: SkillOption | null;
    version: number | null;
    user: string | null;
    summary: StaticSummary | null;
    loading: boolean;
    onBack: () => void;
    onReload: (options?: StaticSummaryReloadOptions) => Promise<StaticSummary | null>;
    onOptimize: () => void;
}) {
    const [detail, setDetail] = useState<EvaluationDetail | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [running, setRunning] = useState(false);
    const latestId = summary?.latest?.evaluationId;

    useEffect(() => {
        if (!latestId) {
            setDetail(null);
            return;
        }
        setDetailLoading(true);
        apiFetch(`/api/evaluation/${encodeURIComponent(latestId)}`)
            .then(r => r.json())
            .then(data => setDetail(data))
            .catch(() => setDetail(null))
            .finally(() => setDetailLoading(false));
    }, [latestId]);

    const runStaticEval = async () => {
        if (!skill || version == null) return;
        setRunning(true);
        try {
            const res = await apiFetch(`/api/skills/${skill.id}/versions/${version}/evaluate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data.error || '静态合规启动失败');
            }
            await onReload({
                expectedEvaluationId: typeof data.evaluationId === 'string' ? data.evaluationId : undefined,
            });
        } finally {
            setRunning(false);
        }
    };

    // 把 evaluation 元信息（评估时间/状态/耗时/评估器/contentHash）从 ev-meta bar 迁到 DetailHeader 副标题下，
    // 这样静态合规视图只剩两张主体卡：维度评分 + 分析标准。
    const metaSlot = detail ? (
        <>
            <span>评估时间：{new Date(detail.evaluation.ranAt).toLocaleString()}</span>
            <StaticMetaStatus status={detail.evaluation.status} />
            {detail.evaluation.durationMs != null && <span>耗时：{(detail.evaluation.durationMs / 1000).toFixed(2)}s</span>}
            {detail.evaluation.generator && <span>评估器：{detail.evaluation.generator}</span>}
            {detail.evaluation.contentHash && <span>contentHash：<code>{detail.evaluation.contentHash.slice(0, 12)}…</code></span>}
            {detail.evaluation.errorMessage && (
                <span style={{ color: '#b91c1c' }}>错误：{detail.evaluation.errorMessage}</span>
            )}
        </>
    ) : null;

    return (
        <section className="sa-detail">
            <DetailHeader
                title="静态合规分析"
                subtitle={`${skill?.name || '未选择 Skill'}${version != null ? ` · v${version}` : ''} · SKILL.md 文本扫描`}
                badge="Rule-based"
                metaSlot={metaSlot}
                onBack={onBack}
                onPrimary={runStaticEval}
                primaryLabel={running ? '分析中...' : '重新分析'}
                onOptimize={onOptimize}
            />

            {(loading || detailLoading) && <EmptyState title="正在读取静态评估" text="读取最近一次静态评估与问题列表。" compact />}
            {!loading && !summary?.latest && (
                <StaticEvalEmptyView onScan={runStaticEval} running={running} />
            )}
            {summary?.latest && detail && (
                <EvaluationContent detail={detail} />
            )}
        </section>
    );
}

/**
 * 静态合规空态视图：未扫描时取代原 EmptyState，结构对齐有数据时的视图。
 *   - 顶部一行"尚未扫描" + CTA "开始扫描"——不要再留大块空白
 *   - 下方 6 个 STATIC_EVAL_STANDARDS 灰态卡片：title + desc + "待扫描" 徽章, pointer-events: none
 * 让用户在扫描前能预览将要被评估的维度，而不是面对一大片空白。
 */
function StaticEvalEmptyView({ onScan, running }: { onScan: () => void; running: boolean }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* 顶部一行：状态文字 + CTA。极简、不留空白。 */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
                padding: '12px 16px',
                background: 'var(--ev-card, #fff)',
                border: '1px solid var(--ev-line, #e5e7eb)',
                borderRadius: 8,
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <span style={{ fontSize: 16 }}>🔍</span>
                    <span style={{ fontSize: 13, color: 'var(--ev-text, #18181b)', fontWeight: 600 }}>
                        当前 Skill 版本尚未扫描
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--ev-muted)' }}>
                        · 扫描会按下方 {STATIC_EVAL_STANDARDS.length} 个标准维度评分
                    </span>
                </div>
                <button
                    onClick={onScan}
                    disabled={running}
                    style={{
                        padding: '6px 14px',
                        background: running ? 'var(--ev-line-strong, #d4d4d8)' : 'var(--ev-info, #2563eb)',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 5,
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: running ? 'not-allowed' : 'pointer',
                        flexShrink: 0,
                    }}
                >
                    {running ? '扫描中…' : '开始扫描'}
                </button>
            </div>

            {/* 下：6 个 STATIC_EVAL_STANDARDS 灰态卡片——预览将被评估的维度。
                pointer-events: none + 50% 透明度，让用户一眼看出"扫描后才有交互"。 */}
            <div style={{
                background: 'var(--ev-card, #fff)',
                border: '1px solid var(--ev-line, #e5e7eb)',
                borderRadius: 12,
                padding: '16px 18px',
            }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                    <div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ev-text, #18181b)' }}>分析标准</div>
                        <div style={{ fontSize: 11, color: 'var(--ev-muted)', marginTop: 2 }}>扫描完成后这里会出现每个标准的命中问题，点击展开查看证据 + 修复建议</div>
                    </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {STATIC_EVAL_STANDARDS.map(std => (
                        <div
                            key={std.key}
                            style={{
                                display: 'grid',
                                gridTemplateColumns: '160px 1fr 80px',
                                alignItems: 'center',
                                gap: 12,
                                padding: '10px 12px',
                                background: '#fafafa',
                                border: '1px solid #f4f4f5',
                                borderRadius: 8,
                                opacity: 0.55,
                                cursor: 'not-allowed',
                                pointerEvents: 'none',
                            }}
                            aria-disabled="true"
                        >
                            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ev-text, #52525b)' }}>{std.title}</div>
                            <div style={{ fontSize: 11.5, color: 'var(--ev-muted)', lineHeight: 1.5 }}>{std.desc}</div>
                            <div style={{ textAlign: 'right' }}>
                                <span style={{
                                    display: 'inline-block',
                                    padding: '2px 8px',
                                    fontSize: 10,
                                    fontWeight: 600,
                                    color: '#a1a1aa',
                                    background: '#f4f4f5',
                                    border: '1px solid #e5e7eb',
                                    borderRadius: 99,
                                }}>待扫描</span>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function StaticMetaStatus({ status }: { status: string }) {
    const map: Record<string, string> = { ok: '成功', pending: '执行中', partial: '部分成功', failed: '失败' };
    const tone = ['ok', 'pending', 'partial', 'failed'].includes(status) ? status : 'ok';
    return <span className={`sa-meta-status ${tone}`}>{map[status] || status}</span>;
}

function EmbeddedDebugPanel({
    title,
    description,
    primaryAction,
    secondaryAction,
    children,
    onBack,
    onPrimary,
    onSecondary,
    onOptimize,
    renderHeader,
}: {
    title: string;
    description: string;
    primaryAction: string;
    secondaryAction: string;
    children: React.ReactNode;
    onBack: () => void;
    onPrimary: () => void;
    onSecondary: () => void;
    onOptimize: () => void;
    renderHeader?: 'before' | 'inline' | 'none';
}) {
    const headerMode = renderHeader ?? 'inline';
    return (
        <section className="sa-detail">
            {headerMode === 'inline' && (
                <DetailHeader
                    title={title}
                    subtitle={description}
                    badge="调测分析"
                    onBack={onBack}
                    onPrimary={onPrimary}
                    primaryLabel={primaryAction}
                    secondaryLabel={secondaryAction}
                    onSecondary={onSecondary}
                    onOptimize={onOptimize}
                />
            )}
            <div className="sa-embedded-debug" aria-label={title}>
                <div className="sa-embedded-shell-body">
                    {children}
                </div>
            </div>
        </section>
    );
}

function DetailHeader({
    title,
    subtitle,
    badge,
    metaSlot,
    onBack,
    onPrimary,
    primaryDisabled,
    primaryLabel,
    secondaryLabel,
    onSecondary,
    onOptimize,
}: {
    title: string;
    subtitle: string;
    badge: string;
    /** 副标题下方的 meta 信息行（评估时间/状态/耗时/评估器等），静态合规分析使用 */
    metaSlot?: React.ReactNode;
    onBack: () => void;
    /** 主按钮 onClick；可不传——用例分析页把"分析"按钮移到了 ② 执行块 toolbar 里 */
    onPrimary?: () => void;
    primaryDisabled?: boolean;
    /** 主按钮文案；缺省则不渲染按钮 */
    primaryLabel?: string;
    secondaryLabel?: string;
    onSecondary?: () => void;
    onOptimize: () => void;
}) {
    return (
        <header className="sa-detail-head">
            {/* sa-back-line（"← 返回综合分析 / <view>"）原本在这里，已删——
               顶部 AppTopBar 的"Skills 评测"已是可点击回 overview 的入口，
               这里再放一行重复且与最顶路径冲突。onBack 仍由 props 收着，
               以备未来其它入口（比如键盘快捷键）使用。 */}
            <div className="sa-detail-hero">
                <div>
                    <h1>{title} <span className="sa-pill primary">{badge}</span></h1>
                    <p>{subtitle}</p>
                    {metaSlot && <div className="sa-detail-meta">{metaSlot}</div>}
                </div>
                <div className="sa-detail-actions">
                    {secondaryLabel && <button className="sa-btn" onClick={onSecondary}>{secondaryLabel}</button>}
                    {primaryLabel && <button className="sa-btn" onClick={onPrimary} disabled={primaryDisabled}>{primaryLabel}</button>}
                    <button className="sa-btn sa-btn-primary" onClick={onOptimize}>开始优化</button>
                </div>
            </div>
        </header>
    );
}

function EvaluatorCard({
    kind,
    title,
    subtitle,
    status,
    score,
    scoreLabel,
    summary,
    detail,
    scoreSlot,
    stats,
    footnote,
    onClick,
}: {
    kind: 'trace' | 'static' | 'gray';
    title: string;
    subtitle: string;
    status: string;
    /** 主数字（建议是 N/M 格式，4 张卡含义不同需要 scoreLabel 解释） */
    score?: string;
    /** 数字含义的 micro 标签，比如"合规标准 / 已评估"。让用户一眼看懂"3/6 是啥"。 */
    scoreLabel?: string;
    /** 一句话总结当前评估状态（如 "5 天前最近一次扫描"） */
    summary?: string;
    /** 详细说明（如 "进入详情可手动重新扫描"） */
    detail: string;
    /** 自定义 score 区（比如灰度的 A vs B 对照），传了就替代 score/scoreLabel/summary */
    scoreSlot?: React.ReactNode;
    stats: Array<{ label: string; value: string }>;
    footnote: string;
    onClick: () => void;
}) {
    const statusTone = status === '正常' || status === '有提升'
        ? 'ok'
        : status === '需关注' || status === '有回退'
            ? 'warn'
            : 'neutral';
    const isEmpty = !scoreSlot && (!score || score.includes('--'));

    return (
        <button className={`sa-card k-${kind}${isEmpty ? ' empty' : ''}`} onClick={onClick}>
            <span className="sa-card-head">
                <span className={`sa-card-icon ${kind}`}>{iconFor(kind)}</span>
                <span className="sa-card-title">
                    <span className="t-row">
                        <span>{title}</span>
                    </span>
                    <small>{subtitle}</small>
                </span>
                <span className={`sa-card-status ${statusTone}`}>{status}</span>
            </span>
            {scoreSlot ? scoreSlot : (
                <span className="sa-card-score">
                    <span className={score?.includes('--') ? 'sa-card-score-empty' : 'sa-card-score-num'}>{score}</span>
                    {scoreLabel && <span className="sa-card-score-unit">{scoreLabel}</span>}
                </span>
            )}
            {summary && <span className="sa-card-summary">{summary}</span>}
            <span className="sa-card-detail">{detail}</span>
            <span className="sa-card-stats">
                {stats.map(item => (
                    <span className="sa-card-stat" key={`${item.label}-${item.value}`}>
                        <span className="sa-card-stat-label">{item.label}</span>
                        <span className={`sa-card-stat-val${item.value === '未接入' ? ' muted' : ''}`}>{item.value}</span>
                    </span>
                ))}
            </span>
            <span className="sa-card-foot">
                <span className="sa-card-foot-meta">{footnote}</span>
                <span className="sa-card-foot-link">查看详情 →</span>
            </span>
        </button>
    );
}

function TrajectoryMatchStandards({
    matches,
    skippedExpectedSteps,
    problemByStepKey,
}: {
    matches: StepMatch[];
    skippedExpectedSteps: SkippedExpectedStep[];
    problemByStepKey: Map<string, ProblemStep>;
}) {
    const matched = matches.filter(m => m.matchStatus === 'matched');
    const partial = matches.filter(m => m.matchStatus === 'partial');
    const unexpected = matches.filter(m => m.matchStatus === 'unexpected');

    const partialItems = partial.map(match => {
        const problem = problemByStepKey.get(`actual:${match.actualStepIndex}`)
            || problemByStepKey.get(`name:${match.expectedStepName || ''}`);
        return {
            key: `partial-${match.actualStepIndex}-${match.actualAction}`,
            title: match.expectedStepName || `实际步骤 #${match.actualStepIndex}`,
            desc: problem?.problem || match.matchReason || '该步骤只完成了部分预期要求。',
            meta: problem?.suggestion || match.actualAction,
        };
    });

    const unexpectedItems = unexpected.map(match => {
        const problem = problemByStepKey.get(`actual:${match.actualStepIndex}`)
            || problemByStepKey.get(`name:${match.actualAction}`);
        return {
            key: `unexpected-${match.actualStepIndex}-${match.actualAction}`,
            title: match.actualAction || `实际步骤 #${match.actualStepIndex}`,
            desc: problem?.problem || match.matchReason || '实际执行中出现了 Skill 流程之外的调用或步骤。',
            meta: problem?.suggestion || (match.expectedStepName ? `预期：${match.expectedStepName}` : undefined),
        };
    });

    const skippedItems = skippedExpectedSteps.map(step => ({
        key: `skipped-${step.expectedStepId}`,
        title: step.expectedStepName,
        desc: 'Skill 中规定了该步骤，但实际执行流程没有覆盖。',
        meta: step.expectedStepId,
    }));

    const matchedItems = matched.map(match => ({
        key: `matched-${match.actualStepIndex}-${match.actualAction}`,
        title: match.expectedStepName || match.actualAction || `实际步骤 #${match.actualStepIndex}`,
        desc: match.matchReason || '实际执行符合 Skill 中对应步骤的预期。',
        meta: match.actualAction && match.expectedStepName !== match.actualAction ? match.actualAction : undefined,
    }));

    return (
        <div className="sa-match-standards">
            <TrajectoryMatchGroup
                tone="matched"
                icon="✅"
                title="符合预期"
                desc="实际执行步骤与 Skill 预期步骤匹配良好"
                count={matched.length}
                items={matchedItems}
            />
            <TrajectoryMatchGroup
                tone="partial"
                icon="⚠️"
                title="部分偏离"
                desc="意图接近，但执行方式或覆盖程度不足"
                count={partial.length}
                items={partialItems}
            />
            <TrajectoryMatchGroup
                tone="unexpected"
                icon="❌"
                title="非预期调用"
                desc="实际执行了 Skill 标准流程之外的步骤"
                count={unexpected.length}
                items={unexpectedItems}
            />
            <TrajectoryMatchGroup
                tone="skipped"
                icon="⭕"
                title="跳过"
                desc="Skill 中要求的步骤没有在实际流程中出现"
                count={skippedExpectedSteps.length}
                items={skippedItems}
            />
        </div>
    );
}

function TrajectoryMatchGroup({
    tone,
    icon,
    title,
    desc,
    count,
    items,
}: {
    tone: 'matched' | 'partial' | 'unexpected' | 'skipped';
    icon: string;
    title: string;
    desc: string;
    count: number;
    items: Array<{ key: string; title: string; desc: string; meta?: string }>;
}) {
    const [open, setOpen] = useState(tone !== 'matched' && count > 0);
    return (
        <article className={`sa-match-group ${tone} ${open ? 'open' : ''}`}>
            <button className="sa-match-group-head" onClick={() => setOpen(v => !v)}>
                <span className="sa-match-icon">{icon}</span>
                <span>
                    <b>{title}</b>
                    <small>{desc}</small>
                </span>
                <code>{count} 个步骤</code>
                <span className="sa-chevron">›</span>
            </button>
            {open && (
                <div className="sa-match-group-body">
                    {items.length === 0 ? (
                        <div className="sa-match-empty">暂无该类步骤</div>
                    ) : items.map(item => (
                        <div key={item.key} className="sa-match-step">
                            <b>{item.title}</b>
                            <p>{item.desc}</p>
                            {item.meta && <small>{item.meta}</small>}
                        </div>
                    ))}
                </div>
            )}
        </article>
    );
}

function Donut({ value }: { value: number | null }) {
    const safe = value == null ? 0 : Math.max(0, Math.min(100, value));
    return (
        <div className={`sa-donut ${value == null ? 'pending' : ''}`} style={{ ['--value' as string]: `${safe}%` }}>
            <div>
                <b>{value == null ? '--' : safe}<small>{value == null ? '' : '%'}</small></b>
                <span>{value == null ? '待分析' : '符合率'}</span>
            </div>
        </div>
    );
}

function LegendRow({ color, label, value }: { color: string; label: string; value: number }) {
    return (
        <div className="sa-legend-row">
            <span style={{ background: color }} />
            <em>{label}</em>
            <b>{value}</b>
        </div>
    );
}

function EmptyState({ title, text, actionLabel, onAction, compact }: { title: string; text: string; actionLabel?: string; onAction?: () => void; compact?: boolean }) {
    return (
        <div className={`sa-empty ${compact ? 'compact' : ''}`}>
            <div className="sa-empty-icon">⌁</div>
            <h3>{title}</h3>
            <p>{text}</p>
            {actionLabel && <button className="sa-btn sa-btn-primary" onClick={onAction}>{actionLabel}</button>}
        </div>
    );
}

function iconFor(kind: 'trace' | 'static' | 'gray' | 'batch') {
    const icons = {
        trace: '⌁',
        static: '▤',
        gray: '⇄',
        batch: '☷',
    };
    return icons[kind];
}

function viewTitle(view: AnalysisView) {
    if (view === 'trace') return '用例分析';
    if (view === 'static') return '静态合规分析';
    if (view === 'gray') return 'A/B测试';
    return '综合分析';
}

interface SkillAnalysisSelection {
    skillId?: string | null;
    skillName?: string | null;
    version?: number | null;
    /** 选中的 trace taskId——下次进同一 (skill, version) 时自动选回，
        让用户在 trace 之间切换/导航回来时不丢上下文。 */
    taskId?: string | null;
}

function skillAnalysisStorageKey(user: string | null) {
    return `${SKILL_ANALYSIS_SELECTION_STORAGE_KEY}:${user || 'anonymous'}`;
}

function readSkillAnalysisSelection(user: string | null): SkillAnalysisSelection | null {
    if (typeof window === 'undefined') return null;
    try {
        const raw = window.localStorage.getItem(skillAnalysisStorageKey(user));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as SkillAnalysisSelection | null;
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

function writeSkillAnalysisSelection(user: string | null, selection: SkillAnalysisSelection) {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(skillAnalysisStorageKey(user), JSON.stringify(selection));
    } catch {
        return;
    }
}

function parseVersionParam(value: string | null | undefined): number | null {
    if (!value) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function resolveSkillVersion(skill: SkillOption, preferred?: number | null): number {
    const versions = skill.versions || [];
    const hasVersion = (v: number | null | undefined) => (
        typeof v === 'number' && Number.isFinite(v) && (versions.length === 0 || versions.some(item => item.version === v))
    );
    if (hasVersion(preferred)) return preferred as number;
    if (hasVersion(skill.activeVersion)) return skill.activeVersion as number;
    if (hasVersion(skill.version)) return skill.version as number;
    return versions[0]?.version ?? 0;
}

function findInitialSkill(
    skills: SkillOption[],
    skillParam: string,
    stored: SkillAnalysisSelection | null,
) {
    if (skillParam) {
        const byParam = skills.find(s => s.name === skillParam || s.id === skillParam);
        if (byParam) return byParam;
    }
    if (stored?.skillId) {
        const byId = skills.find(s => s.id === stored.skillId);
        if (byId) return byId;
    }
    if (stored?.skillName) {
        const byName = skills.find(s => s.name === stored.skillName);
        if (byName) return byName;
    }
    return null;
}

function traceReferencesSkill(trace: TraceRecord, skillName: string, version?: number | null) {
    const target = skillName.trim();
    if (!target) return false;
    const rootSkill = getTracePrimarySkill(trace);
    if (!rootSkill?.name || rootSkill.name !== target) return false;
    // version 没指定 → name 命中即算
    if (version == null) return true;
    // version 指定 → 严格匹配。data-service 已经给 rootSkill.version 兜底用
    // Execution.skillVersion 字段填充，所以这里不再容忍 rootSkill.version==null
    // （之前为兼容老 trace 而放宽，结果导致切换版本完全不过滤——治标不治本）。
    return rootSkill.version === version;
}

function getTracePrimarySkill(trace: TraceRecord): InvokedSkillRef | null {
    const root = trace.root_skill || trace.rootSkill || null;
    return root?.name ? { name: root.name, version: root.version ?? null } : null;
}

function formatSkillRef(value: InvokedSkillRef | null) {
    if (!value?.name) return '--';
    return value.version != null ? `${value.name} · v${value.version}` : value.name;
}

function summarizeTraceMatches(traces: TraceRecord[]) {
    let analyzed = 0;
    let highDeviation = 0;
    let matchedSteps = 0;
    let totalSteps = 0;

    for (const trace of traces) {
        const payload = getTraceMatchPayload(trace);
        if (payload && (Array.isArray(payload.matches) || Array.isArray(payload.skippedExpectedSteps))) {
            analyzed += 1;
            const matches = Array.isArray(payload.matches) ? payload.matches : [];
            const skipped = Array.isArray(payload.skippedExpectedSteps) ? payload.skippedExpectedSteps : [];
            const matched = matches.filter(m => m.matchStatus === 'matched').length;
            const scoringMatches = matches.filter(m => m.matchStatus !== 'non_business');
            const total = scoringMatches.length + skipped.length;
            matchedSteps += matched;
            totalSteps += total;

            const score = typeof payload.summary?.overallScore === 'number'
                ? payload.summary.overallScore
                : total > 0 ? matched / total : 1;
            if (score < 0.7) highDeviation += 1;
        }
    }

    return { analyzed, highDeviation, matchedSteps, totalSteps };
}

function getTraceMatchPayload(trace: TraceRecord): ExecutionMatchPayload | null {
    return safeJsonParse<ExecutionMatchPayload>(trace.execution_match?.matchJson || undefined);
}

function isTraceFlowAnalyzed(trace: TraceRecord) {
    const payload = getTraceMatchPayload(trace);
    return !!payload && (Array.isArray(payload.matches) || Array.isArray(payload.skippedExpectedSteps));
}

function getTraceFlowScore(trace: TraceRecord): number | null {
    const payload = getTraceMatchPayload(trace);
    if (!payload) return null;
    if (typeof payload.summary?.overallScore === 'number') return payload.summary.overallScore;
    const matches = Array.isArray(payload.matches) ? payload.matches : [];
    const skipped = Array.isArray(payload.skippedExpectedSteps) ? payload.skippedExpectedSteps : [];
    const scoringMatches = matches.filter(match => match.matchStatus !== 'non_business');
    const total = scoringMatches.length + skipped.length;
    if (total === 0) return null;
    return scoringMatches.filter(match => match.matchStatus === 'matched').length / total;
}

/**
 * 一条 trace 的"轨迹分"(0-1) 统一口径：优先用后端聚合层算出的 trajectoryScore（方案A：
 * 0.45 完整性 + 0.35 工具 + 0.20 冗余, 再封顶），没有(未评测/旧数据)再回退 analyze-match
 * 对齐覆盖率 getTraceFlowScore。所有"卡片/概览/健康分/诊断"聚合都走它，避免与 ③ 详情口径分裂。
 */
function getEffectiveTrajScore(trace: TraceRecord): number | null {
    if (typeof trace.trajectory_score === 'number') return trace.trajectory_score;
    if (typeof trace.trajectoryScore === 'number') return trace.trajectoryScore;
    return getTraceFlowScore(trace);
}

function getTraceId(trace: TraceRecord) {
    return trace.task_id || trace.upload_id || '';
}

function safeJsonParse<T = unknown>(value?: string): T | null {
    if (!value) return null;
    try { return JSON.parse(value); } catch { return null; }
}

function formatShortDate(value?: string) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDateTime(value?: string) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatRelative(value?: string) {
    if (!value) return '未知时间';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    return `${Math.floor(diff / 86_400_000)} 天前`;
}
