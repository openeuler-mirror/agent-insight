'use client';

/* eslint-disable react-hooks/set-state-in-effect */

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { SkillAnalysisHeader } from './_components/SkillAnalysisHeader';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import { isInternalSystemAgentTrace } from '@/lib/system-agent-names';
import { parseSkillAttributionFromRow } from '@/lib/engine/evaluation/skill-attribution';
import {
    buildFallbackDiagnosis,
    type DiagnosisDimensionKey,
    type DiagnosisDimensionStatus,
    type SkillDiagnosisResult,
    type SkillDiagnosisSnapshot,
} from '@/lib/skill-analysis/diagnosis';
import { calculateAbScoring, type AbScoringResult } from '@/lib/skill-analysis/ab-scoring';
import { formatPValueLabel, welchTTestPValue } from '@/lib/skill-analysis/ab-significance';
import { BatchEvaluation } from './_batch/page';
import { GrayscaleEvaluation } from './grayscale/page';
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
    trajectoryScore?: number;
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
            comments?: { meta?: string; code?: string };
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

interface ParsedFlowPayload {
    steps?: FlowStep[];
}

interface ExtractedTraceStep {
    uiStepIndex?: number;
    name?: string;
    description?: string;
    dialogStartIndex?: number;
    dialogEndIndex?: number;
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

interface MatchData {
    analyzed: boolean;
    mode?: 'compare' | 'dynamic';
    matchJson?: string;
    staticMermaid?: string;
    dynamicMermaid?: string;
    flowJson?: string;
    extractedSteps?: string;
    analysisText?: string;
    interactionCount?: number;
    currentInteractionCount?: number;
    hasUpdate?: boolean;
    matchedAt?: string;
    usedSkillName?: string;
    usedSkillVersion?: number;
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

/* 评估器 4 类 finding 的统一展示结构 */
interface EvaluatorFinding {
    kind: 'deviation' | 'key_point' | 'tool_choice' | 'result_issue';
    title: string;           // 单行标题
    description?: string;    // 详细描述
    severity?: 'high' | 'medium' | 'low';
    stepIndex?: number;
    isSkillAttributable?: boolean;
    improvementSuggestion?: string;
    // 仅 key_point 用：是否被覆盖
    covered?: boolean;
}

/* 符合项（per-trace 视图里的"做对了什么"） */
interface MatchingItem {
    kind: 'key_point_covered' | 'step_matched';
    title: string;           // 单行标题
    evidence?: string;       // 命中证据（实际执行片段 / explanation）
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

    const selectedSkill = useMemo(
        () => skills.find(s => s.id === selectedSkillId) || null,
        [skills, selectedSkillId],
    );

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
                // 排除系统内部任务: skill-trigger-analyzer / grayscale-* / 各评测器 等。
                // 这些 trace 是平台自己跑的(触发分析 / A/B / 任务完成度评测), 不是真实用户
                // 调用产生, 展示在"用例分析"里会误导用户对这个 skill 真实使用情况的判断。
                .filter((trace: TraceRecord) => !isInternalSystemAgentTrace(trace.agentName || trace.agent))
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
    const runBatchTraceAnalysis = useCallback(async (taskIds: string[]): Promise<{
        resultErrors: string[];                                    // 结果评测整体失败（一次入队全失败）
        trajectoryErrors: Map<string, string>;                     // 每条 trace 各自的 trajectory 失败原因
    }> => {
        const empty = { resultErrors: [] as string[], trajectoryErrors: new Map<string, string>() };
        if (!user || taskIds.length === 0) return empty;
        // resultRun 是一次入队多条，要么整体成功要么整体失败；trajRun 是逐条独立扇出，
        // 每条都可能有自己的失败原因（如 skill 缺 mermaid 那种 per-trace 的前提缺失）。
        const resultRun = (async () => {
            const res = await apiFetch('/api/eval/trajectory/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user,
                    taskIds,
                    evaluators: ['preset-agent-task-completion'],
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data?.error || `结果评估入队失败 (HTTP ${res.status})`);
            }
        })();
        // 改写：每个 trajectory 任务跑完单独 catch,把错误信息按 taskId 记下来,
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
        const resultErrors: string[] = [];
        const resultSettled = await Promise.allSettled([resultRun]);
        for (const s of resultSettled) {
            if (s.status === 'rejected') {
                resultErrors.push(String(s.reason instanceof Error ? s.reason.message : s.reason));
            }
        }
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
    }, [user, reloadTraces]);

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
    const grayFinalScore = graySummary?.scoring.totalScore ?? null;
    const batchHasResult = false;
    /*
     * 用例分析（trace）卡上展示的分数 = "已评测过的 trace" 的「(结果分 + 轨迹分) / 2」的平均值。
     * 关键约束：每条 trace 只有结果分 + 轨迹分都在时才参与；只跑了一边的不算"已评测"。
     *   - 结果分：trace.answer_score（Execution.answerScore，task-completion 评估器写）
     *   - 轨迹分：getTraceFlowScore(trace)（flow-parser analyze-match overallScore）
     * 跟单 trace 详情页 Hero 的口径不一样（详情页只看 LLM 单分），但卡片这层要求双分都备齐
     * 才算"完整评测"，避免被半评测的 trace 拉偏。
     */
    const traceCombinedScores = traces.reduce<{ sum: number; count: number }>((acc, t) => {
        const result = typeof t.answer_score === 'number' ? t.answer_score
            : typeof t.answerScore === 'number' ? t.answerScore : null;
        const traj = getTraceFlowScore(t);
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

    // overview 直接用 plain title；gray 走自家的 GrayscaleEvaluation 内嵌选择器，
    // 这里不再插一组 inline picker 避免双倍 skill 选择控件；其余 detail views（trace / static / batch）
    // 都把 skill+version 选择内嵌到路径里，下方不再渲染 sa-selector-hifi 大卡。
    const title = view === 'overview'
        ? 'Skills 分析'
        : view === 'gray'
            ? (
                <span className="sa-top-title">
                    <button onClick={() => setView('overview')}>Skills 分析</button>
                    <span>/</span>
                    <b>{viewTitle(view)}</b>
                </span>
            )
            : (
                <span className="sa-top-title">
                    <button onClick={() => setView('overview')}>Skills 分析</button>
                    <span>/</span>
                    <b>{viewTitle(view)}</b>
                    <span className="sa-top-dot">·</span>
                    <select
                        className="sa-top-select"
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
                        {skills.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    <select
                        className="sa-top-select sa-top-select-version"
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
                    <SkillAnalysisHeader
                        // overview 才渲染这个大卡；其余 detail view 的 skill+version 已经移到 AppTopBar 路径里。
                        crumbs={[{ label: 'Skills', href: '#' }, { label: 'Skills 分析' }]}
                        skills={skills}
                        selectedSkillId={selectedSkillId}
                        skillsLoading={skillsLoading}
                        onSelectSkill={(id) => {
                            const next = skills.find(s => s.id === id);
                            setSelectedSkillId(id);
                            setSelectedVersion(next ? resolveSkillVersion(next) : null);
                            setView('overview');
                        }}
                        monogram={getSkillMonogram(selectedSkill?.name)}
                        versions={
                            sortedVersions.length > 0
                                ? sortedVersions.map(v => ({
                                      version: v.version,
                                      isActive: v.version === selectedSkill?.activeVersion,
                                      label: `v${v.version}${v.version === selectedSkill?.activeVersion ? '（当前）' : ''}${v.createdAt ? ` · ${formatShortDate(v.createdAt)}` : ''}`,
                                  }))
                                : selectedSkill
                                ? [{
                                      version: selectedSkill.activeVersion ?? selectedSkill.version ?? 0,
                                      label: `v${selectedSkill.activeVersion ?? selectedSkill.version ?? 0}`,
                                  }]
                                : []
                        }
                        selectedVersion={selectedVersion}
                        onSelectVersion={(v) => {
                            setSelectedVersion(v);
                            setView('overview');
                        }}
                    />
                )}

                {view === 'overview' && (
                  <>
                    <AnalysisOverview
                        user={user}
                        selectedSkill={selectedSkill}
                        selectedVersion={selectedVersion}
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
        const traj = getTraceFlowScore(t);
        if (result != null && traj != null) {
            acc.sum += (result + traj) / 2;
            acc.count += 1;
        }
        return acc;
    }, { sum: 0, count: 0 });
    const fullyEvaluatedCount = traceCardAgg.count;
    const traceCardHasResult = fullyEvaluatedCount > 0;
    const traceLatestUpdatedAt = traces.reduce<string | null>((latest, t) => {
        const result = typeof t.answer_score === 'number' ? t.answer_score
            : typeof t.answerScore === 'number' ? t.answerScore : null;
        const traj = getTraceFlowScore(t);
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
    const traceCardScoreValue = traceCardHasResult
        ? Math.round((traceCardAgg.sum / fullyEvaluatedCount) * 100)
        : null;

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
    const grayFinalScore = graySummary?.scoring.totalScore ?? null;
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
            const traj = getTraceFlowScore(t);
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
                            title={staticCanTest ? '可触发详情页“重新扫描”' : '需先选择 Skill 与版本'}
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
                            <small>做的怎么样？结果&amp;轨迹分析</small>
                        </div>
                        <span className={`sa-card-status ${traceCardStatus === '正常' ? 'ok' : traceCardStatus === '需关注' ? 'warn' : 'neutral'}`}>
                            {traceCardStatus}
                        </span>
                    </div>

                    <div className="sa-card-score">
                        <span className="sa-card-score-num">{traceCardScoreValue ?? '--'}</span>
                        <span className="sa-card-score-unit">{traceCardScoreValue == null ? '待分析' : '/ 100'}</span>
                    </div>

                    <div className="sa-card-stats">
                        <div className="sa-card-stat">
                            <div className="sa-card-stat-label" title="结果分 + 轨迹分双双就绪的 trace 数；只跑一边的不计入">已完整评测</div>
                            <div className="sa-card-stat-val">{traces.length === 0 ? '暂无 Trace' : `${fullyEvaluatedCount} / ${traces.length}`}</div>
                        </div>
                        <div className="sa-card-stat">
                            <div className="sa-card-stat-label">高偏离</div>
                            <div className="sa-card-stat-val">{highDeviation > 0 ? `${highDeviation} 条` : '无'}</div>
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
                            <div className="sa-card-score" style={{ alignItems: 'baseline', gap: 8, marginTop: 18 }}>
                                <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--sa-muted)', alignSelf: 'flex-start', marginTop: 12 }}>最终评分</span>
                                <span style={{ fontSize: 62, lineHeight: 1, fontWeight: 900, color: 'var(--sa-warning)' }}>
                                    {graySummary?.scoring.totalScore ?? '--'}
                                </span>
                                <span style={{ fontSize: 24, fontWeight: 800, color: 'var(--sa-muted)' }}>/100</span>
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

                            <div className="sa-card-stats">
                                <div className="sa-card-stat">
                                    <div className="sa-card-stat-label">对比版本</div>
                                    <div className="sa-card-stat-val">{grayPairLabel}</div>
                                </div>
                                <div className="sa-card-stat">
                                    <div className="sa-card-stat-label">样本</div>
                                    <div className="sa-card-stat-val">{graySummary ? `${graySampleLabel} · ${grayRunLabel}` : '待选择样本'}</div>
                                </div>
                                <div className="sa-card-stat">
                                    <div className="sa-card-stat-label">显著性</div>
                                    <div className="sa-card-stat-val">{grayPValueLabel}</div>
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
}: {
    skill: SkillOption | null;
    version: number | null;
    user: string | null;
    traces: TraceRecord[];
    loading: boolean;
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
    const [detailTab, setDetailTab] = useState<'result' | 'trajectory'>('result');

    // 三段式 section 折叠态：① 默认展开（source toggle 在 ① body 顶部，需立刻可见），
    // ② 默认折叠，③ 默认展开。
    const [caseConfigOpen, setCaseConfigOpen] = useState(true);
    const [caseExecOpen, setCaseExecOpen] = useState(false);
    const [caseResultOpen, setCaseResultOpen] = useState(true);

    // 已触发评测的 trace id → 触发时间戳。runBothAnalyses 调用时填，让 ② 执行块的
    // 列表能区分"正在评测中"（已触发但分数还没回来）vs"已评测"（双分都就绪）。
    // 之前用户反映"批量分析 3 条只显示 1 条"——其实另 2 条还在后台 queue 跑，UI
    // 没记 trigger 痕迹就把它们当 idle 隐藏了。
    //
    // 跨刷新持久化：本地 state 在 refresh 后会丢，但后端 TrajectoryEvalResult 还在跑
    // （status: pending/running）。下方 useEffect 会在 mount + traces 变化时扫一遍
    // 后端进行中的评测，把对应 taskId 补回这个 Map——刷新页面后"评测中"徽章不消失。
    const [triggeredTaskIds, setTriggeredTaskIds] = useState<Map<string, number>>(new Map());

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
    // 用例来源模式：'trace' 用已有 Trace 评测 / 'dataset' 用数据集发起评测（v1 走跳转，phase 2 集成）
    const [caseSourceMode, setCaseSourceMode] = useState<'trace' | 'dataset'>('trace');
    // ③ 结果块"选中 trace 完整深度视图"默认折叠——避免页面一进来就铺满 Mermaid + Skill 归因等
    // 长内容，让用户主动点开"分析细节"才看。和 mockup 行为一致。
    const [caseDetailExpanded, setCaseDetailExpanded] = useState(false);
    const [matchData, setMatchData] = useState<MatchData | null>(null);
    const [matchLoading, setMatchLoading] = useState(false);
    const [analyzing, setAnalyzing] = useState(false);
    const [traceListCollapsed, setTraceListCollapsed] = useState(false);
    const [error, setError] = useState('');

    /* ─────────────────────────────────────────────────────
       Skill 归因状态
       轨迹分析的 alignment 是唯一事实源；归因区只读取 analyze-match 基于
       alignment 派生出的 finding（is_skill_attributable + improvement_suggestion），
       并写入 SkillIssue 表喂给 skill-opt。
       ───────────────────────────────────────────────────── */
    const [trajectoryEval, setTrajectoryEval] = useState<TrajectoryEvalRow | null>(null);
    const [trajEvalLoading, setTrajEvalLoading] = useState(false);
    const [trajEvalStarting, setTrajEvalStarting] = useState(false);
    const [trajEvalError, setTrajEvalError] = useState('');
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
    /* 评估器运行时长（秒）—— 给用户一个"还在跑"的反馈，结合下方 4 个子任务的
       indeterminate progress 一起呈现。基于 trajectoryEval.createdAt + 当前时间算。 */
    const [trajEvalElapsed, setTrajEvalElapsed] = useState(0);
    /* 归因模型由平台默认（user settings 的 active config）决定,不在本面板暴露
       切换入口——避免误导用户"切了影响所有评估"。要换默认模型去 /modelconfig。 */
    const scoreFormulaTitle = '计算公式：匹配度 =（完全匹配步骤数 + 委派子 Skill 步骤数 + 部分匹配步骤数 × 0.5 - 非预期步骤数 × 0.2）÷（参与评分的实际步骤数 + 缺失步骤数）。过渡操作不参与分子和分母，结果限制在 0% 到 100%。';

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
    const graphTargetName = matchData?.usedSkillName || primarySkill?.name || skill?.name || null;
    const actionUsesPrimarySkill = !!skill?.name && !!primarySkill?.name && primarySkill.name !== skill.name;
    const graphTargetDiffers = !!skill?.name && !!graphTargetName && graphTargetName !== skill.name;

    const fetchMatch = useCallback(() => {
        if (!selectedTraceId) {
            setMatchData(null);
            return;
        }
        setMatchLoading(true);
        setError('');
        setMatchData(null);
        apiFetch(`/api/observe/executions/${encodeURIComponent(selectedTraceId)}/analyze-match`)
            .then(r => r.json())
            .then(data => setMatchData(data))
            .catch(e => setError(e instanceof Error ? e.message : '读取分析结果失败'))
            .finally(() => setMatchLoading(false));
    }, [selectedTraceId]);

    useEffect(() => {
        fetchMatch();
    }, [fetchMatch]);

    /* ── 轨迹评估器：拉最新结果 ── */
    const fetchTrajectoryEval = useCallback(async () => {
        if (!selectedTraceId || !user) {
            setTrajectoryEval(null);
            return null;
        }
        setTrajEvalLoading(true);
        setTrajEvalError('');
        try {
            const res = await apiFetch(
                `/api/eval/trajectory/results?user=${encodeURIComponent(user)}&taskId=${encodeURIComponent(selectedTraceId)}&limit=1`,
            );
            const data = await res.json();
            const latest = (Array.isArray(data?.results) ? data.results : [])[0] as TrajectoryEvalRow | undefined;
            setTrajectoryEval(latest || null);
            return latest || null;
        } catch (e) {
            setTrajEvalError(e instanceof Error ? e.message : '读取评估结果失败');
            return null;
        } finally {
            setTrajEvalLoading(false);
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
                const res = await apiFetch(`/api/eval/trajectory/results?user=${encodeURIComponent(user)}&limit=200`);
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
    }, [user, traces.length]);

    const scheduleTrajectoryPoll = useCallback(function scheduleNextTrajectoryPoll() {
        if (trajEvalPollRef.current) clearTimeout(trajEvalPollRef.current);
        trajEvalPollRef.current = setTimeout(async () => {
            const row = await fetchTrajectoryEval();
            if (row && (row.status === 'pending' || row.status === 'running')) {
                scheduleNextTrajectoryPoll();
            }
        }, 5000);
    }, [fetchTrajectoryEval]);

    /**
     * 只跑「任务完成度评估器」(preset-agent-task-completion)——结果分析专用入口。
     * 跟轨迹分析解耦：用户在结果分析 tab 点开始分析时调这个，
     * 不会触发 alignment 归因，也不会去解析 flow 流程图。
     *
     * 评估结果落回同一张 TrajectoryEvalResult 表，rawAnalysisJson.resultEvaluation
     * 字段包含 score + key_point_findings + result_issues —— 结果分析 UI 直接读这些。
     */
    const startResultEval = async () => {
        if (!selectedTraceId || !user) return;
        setTrajEvalStarting(true);
        setTrajEvalError('');
        try {
            const res = await apiFetch('/api/eval/trajectory/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user,
                    taskIds: [selectedTraceId],
                    evaluators: ['preset-agent-task-completion'],
                }),
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.error || '启动结果评估失败');
            }
            await fetchTrajectoryEval();
            scheduleTrajectoryPoll();
        } catch (e) {
            setTrajEvalError(e instanceof Error ? e.message : '启动结果评估失败');
        } finally {
            setTrajEvalStarting(false);
        }
    };

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

    /* ── 评估器运行计时（用于进度展示） ── */
    useEffect(() => {
        if (trajectoryEval?.status !== 'pending' && trajectoryEval?.status !== 'running') {
            setTrajEvalElapsed(0);
            return;
        }
        const startTs = trajectoryEval?.createdAt
            ? new Date(trajectoryEval.createdAt).getTime()
            : Date.now();
        const tick = () => setTrajEvalElapsed(Math.max(0, Math.floor((Date.now() - startTs) / 1000)));
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [trajectoryEval?.status, trajectoryEval?.createdAt]);

    const runAnalyze = async (): Promise<boolean> => {
        if (!selectedTraceId) return false;
        if (!primarySkill?.name) {
            setError('当前 Trace 的外层主 Agent 未加载 Skill，无法进行主 Skill 流程对齐分析。');
            return false;
        }
        setAnalyzing(true);
        setError('');
        try {
            const res = await apiFetch(`/api/observe/executions/${encodeURIComponent(selectedTraceId)}/analyze-match`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user, mode: 'compare' }),
            });
            const result = await res.json();
            if (!res.ok || !result.success) throw new Error(result.error || '分析失败');
            setMatchData({
                analyzed: true,
                mode: 'compare',
                matchJson: result.match ? JSON.stringify(result.match) : undefined,
                staticMermaid: result.staticMermaid,
                dynamicMermaid: result.dynamicMermaid,
                flowJson: result.flowJson,
                extractedSteps: result.extractedSteps,
                interactionCount: result.interactionCount,
                matchedAt: new Date().toISOString(),
                usedSkillName: result.usedSkillName,
                usedSkillVersion: result.usedSkillVersion,
            });
            await fetchTrajectoryEval();
            onReload();
            return true;
        } catch (e) {
            setError(e instanceof Error ? e.message : '分析失败');
            return false;
        } finally {
            setAnalyzing(false);
        }
    };

    const retryTraceAnalysis = async () => {
        if (analyzing || trajEvalStarting || trajectoryEval?.status === 'pending' || trajectoryEval?.status === 'running') return;
        const analyzeOk = await runAnalyze();
        if (!analyzeOk) return;
        await fetchTrajectoryEval();
    };

    const parsedMatch = useMemo(
        () => safeJsonParse<ExecutionMatchPayload>(matchData?.matchJson),
        [matchData?.matchJson],
    );
    const summary: MatchSummary = parsedMatch?.summary || {};
    const matches: StepMatch[] = Array.isArray(parsedMatch?.matches) ? parsedMatch.matches : [];
    const skippedExpectedSteps: SkippedExpectedStep[] = Array.isArray(parsedMatch?.skippedExpectedSteps) ? parsedMatch.skippedExpectedSteps : [];
    const parsedFlow = useMemo(
        () => safeJsonParse<ParsedFlowPayload>(matchData?.flowJson),
        [matchData?.flowJson],
    );
    const extractedSteps = useMemo(() => {
        const parsed = safeJsonParse<ExtractedTraceStep[]>(matchData?.extractedSteps);
        return Array.isArray(parsed) ? parsed : [];
    }, [matchData?.extractedSteps]);
    const problemByStepKey = useMemo(() => {
        const map = new Map<string, ProblemStep>();
        const problemSteps: ProblemStep[] = Array.isArray(parsedMatch?.problemSteps) ? parsedMatch.problemSteps : [];
        for (const problem of problemSteps) {
            if (problem.stepIndex != null) map.set(`actual:${problem.stepIndex}`, problem);
            if (problem.stepName) map.set(`name:${problem.stepName}`, problem);
        }
        return map;
    }, [parsedMatch]);
    const score = typeof summary.overallScore === 'number'
        ? Math.round(summary.overallScore * 100)
        : selectedTrace ? (getTraceFlowScore(selectedTrace) == null ? null : Math.round(getTraceFlowScore(selectedTrace)! * 100)) : null;

    const isResultTab = detailTab === 'result';

    /*
     * 顶部主按钮：一键并行启动「结果分析 + 轨迹分析」两条链路。
     * 使用 Promise.allSettled —— 任一边失败不阻断另一边：
     *   - 结果分析：preset-agent-task-completion 评估器（独立 LLM 调用）
     *   - 轨迹分析：analyze-match 生成 alignment，并由 alignment 派生 Skill 归因
     * Tab 内部仍保留各自的"运行/重试"按钮（结果分析空态 + 关键观点判定头 + TraceAlignmentPanel）
     * 供"单边重跑"场景使用，跟顶部按钮职责分明。
     */
    const bothRunning = batchRunning || trajEvalStarting || analyzing
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
        if (bothRunning || targetTraceIds.length === 0) return;
        // 立刻记录"已触发"——② 执行块的状态徽章靠这个区分 pending/idle
        const triggerTs = Date.now();
        setTriggeredTaskIds(prev => {
            const next = new Map(prev);
            for (const id of targetTraceIds) next.set(id, triggerTs);
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
    const primaryDisabled = bothRunning || targetTraceIds.length === 0 || (checkedTraceIds.size === 0 && !primarySkill?.name);

    // 「用例来源」toggle —— 两种模式都用同一份 JSX；trace 模式渲染在 trace 的 ① body 里，
    // dataset 模式通过 BatchEvaluation 的 topConfigSlot prop 注入到 BE 的 ① body 顶部。
    // 视觉上"toggle 始终在 ① 配置块里"，两边对称。
    const sourceModeToggle = (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: '#fafafa', border: '1px solid #e5e7eb', borderRadius: 6, marginBottom: 14 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>用例来源</span>
            <div style={{ display: 'inline-flex', background: '#fff', borderRadius: 5, padding: 3, gap: 2, border: '1px solid #e5e7eb' }}>
                <button
                    type="button"
                    onClick={() => setCaseSourceMode('trace')}
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
                >📊 从 Trace</button>
                <button
                    type="button"
                    onClick={() => setCaseSourceMode('dataset')}
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
                >🗄 从数据集</button>
            </div>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: '#71717a' }}>
                {caseSourceMode === 'trace'
                    ? `当前 skill: ${skill?.name || '未选'}${version != null ? ` v${version}` : ''}（顶部切换）`
                    : '数据集 / 评测器 / 历史任务 见下方'}
            </span>
        </div>
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
        const j = getTraceFlowScore(t);
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
        if (s.isEvaluating || triggeredTaskIds.has(s.id)) return 'pending';
        if (s.lastEvalStatus === 'failed' || failedTaskIds.has(s.id)) return 'failed';
        if (s.resultScore != null && s.trajScore != null) return 'done';
        if (s.resultScore != null || s.trajScore != null) return 'partial';
        return 'idle';
    };
    // ② 执行块要列的 trace：四类——已评测 / 部分评测 / 评测中 / 评测失败,
    // 外加任何曾经在后端跑过评测的 taskId(evaluatedTaskIds 来自 recovery)。
    // 用户明确要求"无论成功失败都要列出来",所以这里跟 getTraceEvalStatus 解耦,
    // 走"any history" 的口径,避免漏掉 backend 落了 row 但前端 state 算不出非-idle 的 case。
    const displayedTraces = scoredTraces.filter(s =>
        getTraceEvalStatus(s) !== 'idle' || evaluatedTaskIds.has(s.id)
    );
    const fullyEvaluated = scoredTraces.filter(s => s.resultScore != null && s.trajScore != null);
    const avgResult = fullyEvaluated.length === 0 ? null
        : Math.round(fullyEvaluated.reduce((sum, s) => sum + (s.resultScore || 0), 0) / fullyEvaluated.length);
    const avgTraj = fullyEvaluated.length === 0 ? null
        : Math.round(fullyEvaluated.reduce((sum, s) => sum + (s.trajScore || 0), 0) / fullyEvaluated.length);
    const avgOverall = avgResult == null || avgTraj == null ? null : Math.round((avgResult + avgTraj) / 2);
    const overallScoreKlass: 'good' | 'warn' | 'bad' = avgOverall == null
        ? 'warn'
        : avgOverall >= 80 ? 'good' : avgOverall >= 60 ? 'warn' : 'bad';
    const passCount = fullyEvaluated.filter(s => ((s.resultScore || 0) + (s.trajScore || 0)) / 2 >= 60).length;
    const passRatePct = fullyEvaluated.length === 0 ? 0 : Math.round((passCount / fullyEvaluated.length) * 100);

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
                subtitle={`${skill?.name || '未选择 Skill'}${version != null ? ` · v${version}` : ''} · ${isResultTab ? '当前：结果分析' : '当前：轨迹分析'}`}
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
                title="配置 · 用例集"
                desc="该 skill 版本关联的全部 trace（含已评测和未评测）；勾选 → 到 ② 触发分析"
                open={caseConfigOpen}
                onToggle={() => setCaseConfigOpen(o => !o)}
                summary={
                    <>
                        <span>用例来源</span>
                        <code>从 Trace</code>
                        <span>· 关联 <code>{traces.length}</code> 条</span>
                        <span>· 已评测 <code>{fullyEvaluated.length}</code></span>
                    </>
                }
            >
                {/* source-mode 切换 chip：放在 ① 配置块内（用户要求） */}
                {sourceModeToggle}
                {/* trace 列表 */}
            <div className={`sa-trace-picker ${traceListCollapsed ? 'collapsed' : ''}`} style={{ display: 'block' }}>
                <aside className="sa-trace-list" aria-label="该 Skill 的 Trace" style={{ width: '100%', maxWidth: 'none' }}>
                    {traceListCollapsed ? (
                        <button
                            className="sa-trace-collapse collapsed"
                            onClick={() => setTraceListCollapsed(false)}
                            aria-label="展开 Trace 列表"
                        >
                            <span>›</span>
                            <b>Trace</b>
                            <small>{traces.length}</small>
                        </button>
                    ) : null}
                    <div className="sa-trace-list-head">
                        <div className="sa-trace-list-title">
                            <h3>该 Skill 的 Trace <small>({traces.length})</small></h3>
                            <button
                                className="sa-trace-collapse"
                                onClick={() => setTraceListCollapsed(true)}
                                aria-label="收起 Trace 列表"
                            >
                                ‹
                            </button>
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
                                        <span className="sa-trace-id">{id}<small>{formatShortDate(trace.timestamp)}</small></span>
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
            </SectionShell>
            )}{/* /trace mode ① */}

            {/* dataset 模式：① 之后直接渲染 BatchEvaluation 接管 ②/③。
                外裹 .debug-root 是为了把 BatchEvaluation 用到的 CSS 变量
                （--ink / --accent / --bg-soft 等，定义在 debug.css 的 .debug-root 选择器上）
                带进来——否则 .d-btn.primary 的 background: var(--ink) 解析为空，按钮"看不见"。 */}
            {caseSourceMode === 'dataset' && (
                <div className="debug-root" style={{ background: 'transparent' }}>
                    <BatchEvaluation newTaskTrigger={0} historyPanelTrigger={0} topConfigSlot={sourceModeToggle} />
                </div>
            )}

            {/* trace 模式：② + ③ */}
            {caseSourceMode === 'trace' && (<>

            {/* ─────────── ② 执行 · 跑用例评测 ─────────── */}
            <SectionShell
                num={2}
                variant="exec"
                title="执行 · 跑用例评测"
                desc="对勾选的 trace 触发结果 + 轨迹双分析；下方表只列已评测 trace，点行钻取 ③ 结果详情"
                open={caseExecOpen}
                onToggle={() => setCaseExecOpen(o => !o)}
                summary={
                    <>
                        <span>已评测</span>
                        <code>{fullyEvaluated.length} / {traces.length}</code>
                        {avgOverall != null && (
                            <span>· 平均评分 <b style={{ color: overallScoreKlass === 'good' ? 'var(--ev-success)' : overallScoreKlass === 'bad' ? 'var(--ev-error)' : 'var(--ev-warning)' }}>{avgOverall} 分</b></span>
                        )}
                        {/* 评测中 / 评测失败 徽章：折叠态下也能看到"还有 N 条在跑 / X 条失败"——
                            之前 refresh 后 ② 折叠用户完全感知不到后台 in-flight 评测 / 静默失败,
                            以为评测丢了。 */}
                        {(() => {
                            const pendingCount = displayedTraces.filter(s => getTraceEvalStatus(s) === 'pending').length;
                            return pendingCount > 0 ? (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--ev-info)', fontWeight: 600 }}>
                                    · <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'currentColor', animation: 'pulse 1.5s ease-in-out infinite' }} />
                                    评测中 <b>{pendingCount}</b> 条
                                </span>
                            ) : null;
                        })()}
                        {(() => {
                            const partialCount = displayedTraces.filter(s => getTraceEvalStatus(s) === 'partial').length;
                            return partialCount > 0 ? (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--ev-warning)', fontWeight: 600 }} title="只跑成功了一边（result 或 trajectory）。展开 ② 点行查看已有分析。">
                                    · ◐ 部分评测 <b>{partialCount}</b> 条
                                </span>
                            ) : null;
                        })()}
                        {(() => {
                            const failedCount = displayedTraces.filter(s => getTraceEvalStatus(s) === 'failed').length;
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
                {/* 顶部动作区：原 DetailHeader 右上角"分析当前 Trace"按钮移到这里 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: '#fafafa', border: '1px solid var(--ev-line)', borderRadius: 8 }}>
                    <button
                        type="button"
                        onClick={runBothAnalyses}
                        disabled={primaryDisabled}
                        style={{
                            padding: '7px 16px',
                            background: primaryDisabled ? 'var(--ev-line-strong)' : 'var(--ev-info)',
                            color: '#fff',
                            border: 'none',
                            borderRadius: 6,
                            fontSize: 13,
                            fontWeight: 600,
                            cursor: primaryDisabled ? 'not-allowed' : 'pointer',
                            opacity: primaryDisabled ? 0.6 : 1,
                        }}
                        title={primaryDisabled ? '需选 trace 且 trace 有主 skill' : '一键并行启动结果 + 轨迹双分析'}
                    >
                        {bothRunning ? '分析中…'
                            : checkedTraceIds.size > 0 ? `分析选中 ${checkedTraceIds.size} 条`
                            : '分析当前 Trace'}
                    </button>
                    <span style={{ fontSize: 11, color: 'var(--ev-muted)' }}>
                        在 ① 配置块勾选 trace 后回到此触发批量分析
                    </span>
                </div>

                {/* trace 评测列表 —— 含已评测 + 本会话触发还在评测中的；每行带状态徽章。
                    pending 状态：用户刚点"分析"，后台 queue 跑（concurrency=3，每条 10-30s）。
                    上方 runBatchTraceAnalysis 的 poll 拉长到 90s 后会自动刷新 traces，
                    一旦双分数就绪 → 自动从 pending 切到 done。 */}
                {displayedTraces.length === 0 ? (
                    <div style={{ padding: '24px 20px', textAlign: 'center', color: 'var(--ev-muted)', fontSize: 13, background: '#fafafa', border: '1px dashed var(--ev-line)', borderRadius: 8 }}>
                        还没触发过评测。在 ① 配置块勾选 trace → 点上方"分析"按钮。
                    </div>
                ) : (
                    <div style={{ border: '1px solid var(--ev-line)', borderRadius: 8, overflow: 'hidden' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                            <thead>
                                <tr style={{ background: '#fafafa', borderBottom: '1px solid var(--ev-line)' }}>
                                    <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 11, color: 'var(--ev-muted)', fontWeight: 600, width: 90 }}>状态</th>
                                    <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 11, color: 'var(--ev-muted)', fontWeight: 600 }}>Trace · query</th>
                                    <th
                                        style={{ padding: '8px 12px', textAlign: 'right', fontSize: 11, color: 'var(--ev-muted)', fontWeight: 600, width: 70, cursor: 'help' }}
                                        title="该 trace 的结果评测最新分（满分 100）。想看跨 trace 均值看 ③ Hero。"
                                    >结果</th>
                                    <th
                                        style={{ padding: '8px 12px', textAlign: 'right', fontSize: 11, color: 'var(--ev-muted)', fontWeight: 600, width: 70, cursor: 'help' }}
                                        title="该 trace 的轨迹评测最新分（满分 100）。想看跨 trace 均值看 ③ Hero。"
                                    >轨迹</th>
                                    <th
                                        style={{ padding: '8px 12px', textAlign: 'right', fontSize: 11, color: 'var(--ev-muted)', fontWeight: 600, width: 70, cursor: 'help' }}
                                        title="(结果 + 轨迹) / 2，该 trace 自己的均分。跟 ③ Hero 的'总评分'不一样——后者是跨多个 trace 的聚合。"
                                    >均分</th>
                                    <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: 11, color: 'var(--ev-muted)', fontWeight: 600, width: 60 }}>查看</th>
                                </tr>
                            </thead>
                            <tbody>
                                {displayedTraces.map(s => {
                                    const status = getTraceEvalStatus(s);
                                    const r = s.resultScore;
                                    const j = s.trajScore;
                                    const avg = (r != null && j != null) ? Math.round((r + j) / 2) : null;
                                    const scoreColor = (n: number | null) => n == null ? 'var(--ev-muted)'
                                        : n >= 80 ? 'var(--ev-success)'
                                        : n >= 60 ? 'var(--ev-warning)'
                                        : 'var(--ev-error)';
                                    const isSelected = selectedTraceId === s.id;
                                    // done 和 partial 都可点开看详情(至少有一边的分数和分析);
                                    // pending/failed 没有可看的分析详情,不可点
                                    const clickable = status === 'done' || status === 'partial';
                                    const failErr = status === 'failed' ? failedTaskIds.get(s.id) : null;
                                    // 部分评测的情况:也可能有 partial err(只是其中一边失败,另一边成功)。
                                    // 拉出来在行内提示"为什么轨迹评测/结果评测没跑通"。
                                    const partialErr = status === 'partial' ? failedTaskIds.get(s.id) : null;
                                    // 推断 partial 缺哪一边: 没分数的那边就是缺失的
                                    const partialMissingSide =
                                        status === 'partial'
                                            ? (s.resultScore == null ? '结果评测' : s.trajScore == null ? '轨迹评测' : null)
                                            : null;
                                    return (
                                        <tr
                                            key={s.id}
                                            onClick={() => {
                                                if (!clickable) return;
                                                onSelectedTraceChange(s.id);
                                                setCaseDetailExpanded(true);
                                                setCaseResultOpen(true);
                                            }}
                                            style={{
                                                cursor: clickable ? 'pointer' : 'default',
                                                background: isSelected ? 'var(--ev-info-soft)' : 'transparent',
                                                borderBottom: '1px solid #f4f4f5',
                                                opacity: status === 'pending' ? 0.85 : 1,
                                            }}
                                            title={
                                                status === 'pending' ? '评测进行中——后台 queue 跑，平均每条 10-30s。等双分就绪自动切到"已评测"，可点击查看'
                                                : status === 'failed' ? `评测失败：${failErr}`
                                                : status === 'partial' ? '部分评测——只有一边的分数（另一边评测器没跑成功）。可点击查看已有分析'
                                                : ''
                                            }
                                        >
                                            <td style={{ padding: '10px 12px' }}>
                                                {status === 'done' ? (
                                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 99, background: 'var(--ev-success-soft, rgba(22,163,74,.1))', color: 'var(--ev-success)' }}>
                                                        ✓ 已评测
                                                    </span>
                                                ) : status === 'pending' ? (
                                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 99, background: 'rgba(37,99,235,.1)', color: 'var(--ev-info)' }}>
                                                        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'currentColor', animation: 'pulse 1.5s ease-in-out infinite' }} />
                                                        评测中
                                                    </span>
                                                ) : status === 'partial' ? (
                                                    <span
                                                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 99, background: 'var(--ev-warning-soft, rgba(217,119,6,.1))', color: 'var(--ev-warning)', cursor: partialErr ? 'help' : 'default' }}
                                                        title={
                                                            partialErr
                                                                ? `部分评测 - 缺 ${partialMissingSide}:\n${partialErr}\n\n常见原因: skill 内容缺 mermaid 流程图, 后端无法解析关键步骤; 或 skill 未生成 ParsedFlow。`
                                                                : `部分评测 - 缺 ${partialMissingSide}。点开仍可看到已完成那边的分析。`
                                                        }
                                                    >
                                                        ◐ 部分评测
                                                    </span>
                                                ) : (
                                                    <span
                                                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 99, background: 'var(--ev-error-soft, rgba(220,38,38,.1))', color: 'var(--ev-error)', cursor: 'help' }}
                                                        title={`后端评测器调用失败:\n${failErr || '未知错误'}\n\n常见原因: 模型 API key 失效 / 配额不足。去 /modelconfig 检查激活的模型配置。`}
                                                    >
                                                        ⚠ 评测失败
                                                    </span>
                                                )}
                                            </td>
                                            <td style={{ padding: '10px 12px', maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {isSelected && <span style={{ color: 'var(--ev-info)', marginRight: 4 }}>›</span>}
                                                {s.query}
                                                <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--ev-muted)', fontFamily: 'monospace' }}>{s.id.slice(0, 8)}</span>
                                                {/* 评测失败时,把错误信息平铺一行,鼠标用户不依赖 hover 也能看到原因 */}
                                                {status === 'failed' && failErr && (
                                                    <div style={{ marginTop: 4, fontSize: 11, color: 'var(--ev-error)', whiteSpace: 'normal', lineHeight: 1.4 }}>
                                                        {failErr.length > 200 ? failErr.slice(0, 200) + '…' : failErr}
                                                    </div>
                                                )}
                                                {/* 部分评测:把缺失那边的原因也平铺出来,用户立刻知道"轨迹评测为什么没跑成"。
                                                    不显原始 stack/api err,显简短的"缺什么"——具体长错误走 hover。 */}
                                                {status === 'partial' && partialMissingSide && (
                                                    <div style={{ marginTop: 4, fontSize: 11, color: 'var(--ev-warning)', whiteSpace: 'normal', lineHeight: 1.4, display: 'flex', alignItems: 'flex-start', gap: 4 }}>
                                                        <Info style={{ width: 14, height: 14, flexShrink: 0, marginTop: 1 }} aria-hidden />
                                                        <span>
                                                            缺 <b>{partialMissingSide}</b>
                                                            {partialErr && ': ' + (partialErr.length > 150 ? partialErr.slice(0, 150) + '…' : partialErr)}
                                                        </span>
                                                    </div>
                                                )}
                                            </td>
                                            <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: scoreColor(r) }}>{r ?? '—'}</td>
                                            <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: scoreColor(j) }}>{j ?? '—'}</td>
                                            <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 800, color: scoreColor(avg) }}>{avg ?? '—'}</td>
                                            <td style={{ padding: '10px 12px', textAlign: 'center', color: clickable ? 'var(--ev-info)' : 'var(--ev-muted)', fontSize: 12 }}>
                                                {clickable ? '↓' : '…'}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </SectionShell>

            {/* ─────────── ③ 结果 · 用例分析（仅 trace 模式） ─────────── */}
            <SectionShell
                num={3}
                variant="result"
                title="结果 · 用例分析"
                desc={fullyEvaluated.length > 0
                    ? `已评测 ${fullyEvaluated.length} / ${traces.length} trace · 结果 + 轨迹 双维度`
                    : '尚未评测'}
                open={caseResultOpen}
                onToggle={() => setCaseResultOpen(o => !o)}
                summary={
                    avgOverall != null ? (
                        <>
                            <span>总评分</span>
                            <code className={`score-${overallScoreKlass}`}>{avgOverall} 分</code>
                            <span>· 通过 <b>{passCount}</b> / <b>{fullyEvaluated.length}</b></span>
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
                            总评分 · 结果 + 轨迹 平均 · 已评测 {fullyEvaluated.length} / {traces.length} trace
                            <span style={{ display: 'block', fontSize: 11, color: 'var(--ev-muted)', fontWeight: 400, marginTop: 2 }}>
                                跨已评测 trace 聚合 · 不随 ② 选中切换变化
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
                            <div className={`ev-hero-sub-num ${fullyEvaluated.length === 0 ? '' : passRatePct >= 80 ? 'good' : passRatePct < 50 ? 'bad' : ''}`}>
                                {fullyEvaluated.length === 0 ? '--' : `${passRatePct}%`}
                            </div>
                            <div className="ev-hero-sub-label">通过率</div>
                            <div className="ev-hero-sub-hint">已评测中达标</div>
                        </div>
                        <div className="ev-hero-sub-item">
                            <div className="ev-hero-sub-num">{fullyEvaluated.length} / {traces.length}</div>
                            <div className="ev-hero-sub-label">评测进度</div>
                            <div className="ev-hero-sub-hint">{traces.length - fullyEvaluated.length} 条待评测</div>
                        </div>
                    </div>
                </div>

                {/* 提升到 section 级的 dual-tab —— 同时控制下方 Findings + 选中 trace 的深度视图 */}
                <div className="sa-detail-tabs" role="tablist" style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--sa-border)', marginBottom: 0 }}>
                    <button
                        role="tab"
                        aria-selected={detailTab === 'result'}
                        className={`sa-detail-tab${detailTab === 'result' ? ' active' : ''}`}
                        onClick={() => setDetailTab('result')}
                        style={{
                            padding: '8px 16px',
                            background: detailTab === 'result' ? 'var(--sa-bg)' : 'transparent',
                            border: 'none',
                            borderBottom: detailTab === 'result' ? '2px solid var(--sa-primary)' : '2px solid transparent',
                            color: detailTab === 'result' ? 'var(--sa-primary)' : 'var(--sa-secondary)',
                            fontSize: 13,
                            fontWeight: detailTab === 'result' ? 700 : 500,
                            cursor: 'pointer',
                        }}
                    >
                        📋 结果分析{avgResult != null ? ` · ${avgResult} 分` : ''}
                    </button>
                    <button
                        role="tab"
                        aria-selected={detailTab === 'trajectory'}
                        className={`sa-detail-tab${detailTab === 'trajectory' ? ' active' : ''}`}
                        onClick={() => setDetailTab('trajectory')}
                        style={{
                            padding: '8px 16px',
                            background: detailTab === 'trajectory' ? 'var(--sa-bg)' : 'transparent',
                            border: 'none',
                            borderBottom: detailTab === 'trajectory' ? '2px solid var(--sa-primary)' : '2px solid transparent',
                            color: detailTab === 'trajectory' ? 'var(--sa-primary)' : 'var(--sa-secondary)',
                            fontSize: 13,
                            fontWeight: detailTab === 'trajectory' ? 700 : 500,
                            cursor: 'pointer',
                        }}
                    >
                        🧭 轨迹分析{avgTraj != null ? ` · ${avgTraj} 分` : ''}
                    </button>
                </div>

                {/* per-trace 符合项 + 扣分项 视图（替换旧 FindingsGrouped 按 case 状态分组） */}
                <CaseAnalysisItemsView
                    selectedTrace={selectedTrace}
                    selectedTraceId={selectedTraceId}
                    tab={detailTab}
                    trajectoryEval={trajectoryEval}
                    matchData={matchData}
                    resultScore={(() => {
                        const s = scoredTraces.find(s => s.id === selectedTraceId);
                        return s?.resultScore ?? null;
                    })()}
                    trajScore={(() => {
                        const s = scoredTraces.find(s => s.id === selectedTraceId);
                        return s?.trajScore ?? null;
                    })()}
                />

                {/* "选中 trace 的完整深度视图" —— 默认折叠（避免 Mermaid + Skill 归因等长内容
                    一进来就把页面铺满）。用户主动展开才看，与 mockup 行为一致。 */}
                <button
                    type="button"
                    onClick={() => setCaseDetailExpanded(v => !v)}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '12px 16px',
                        background: caseDetailExpanded ? 'var(--ev-info-soft)' : '#fafafa',
                        border: `1px ${caseDetailExpanded ? 'solid' : 'dashed'} ${caseDetailExpanded ? 'var(--ev-info)' : 'var(--ev-line)'}`,
                        borderRadius: 8,
                        cursor: 'pointer',
                        fontSize: 13,
                        fontWeight: 600,
                        color: caseDetailExpanded ? 'var(--ev-info)' : 'var(--ev-fg2)',
                        textAlign: 'left',
                    }}
                    title="展开 / 收起选中 trace 的完整分析（含 Mermaid 流程图 + Skill 归因）"
                >
                    <span style={{ fontSize: 16, transform: caseDetailExpanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform .2s' }}>›</span>
                    <span style={{ flex: 1 }}>
                        {caseDetailExpanded ? '收起分析细节' : '展开分析细节'}
                        {selectedTrace ? (
                            <span style={{ marginLeft: 8, fontWeight: 400, color: 'var(--ev-muted)', fontSize: 12 }}>
                                · 当前选中 <code style={{ background: 'rgba(0,0,0,.05)', padding: '1px 6px', borderRadius: 3, fontFamily: 'monospace', fontSize: 11 }}>{selectedTraceId.slice(0, 12)}…</code>
                            </span>
                        ) : (
                            <span style={{ marginLeft: 8, fontWeight: 400, color: 'var(--ev-muted)', fontSize: 12 }}>· 未选中 trace（先到 ② 执行块挑一条）</span>
                        )}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--ev-muted)', fontWeight: 400 }}>
                        {caseDetailExpanded ? '含 Mermaid 流程图 + Skill 归因' : '含完整 ResultAnalysisSection / TraceAlignmentPanel / 4 类 evaluator findings'}
                    </span>
                </button>
                {caseDetailExpanded && (
                <div className="sa-trace-detail" aria-label="Trace 分析详情" style={{ width: '100%', maxWidth: 'none' }}>
                    {!selectedTrace && (
                        <EmptyState title="请选择 Trace" text="左侧选择一条执行链路后，这里会显示 Skill 标准流程和实际执行流程的对比。" />
                    )}
                    {selectedTrace && (
                        <>
                            <div className="sa-trace-summary">
                                <div>
                                    <div className="sa-code-line">
                                        {selectedTraceId}
                                        {matchData?.analyzed
                                            ? <span className="sa-pill primary">已分析</span>
                                            : <span className="sa-pill">待分析</span>}
                                    </div>
                                    <h3>{selectedTrace.query || '无输入内容'}</h3>
                                    <p>
                                        框架 <b>{selectedTrace.framework || 'Unknown'}</b>
                                        {selectedTrace.model ? <> · Model <b>{selectedTrace.model}</b></> : null}
                                        {selectedTrace.timestamp ? <> · 运行于 <b>{formatDateTime(selectedTrace.timestamp)}</b></> : null}
                                    </p>
                                    {graphTargetDiffers && (
                                        <div className="sa-scope-note">
                                            当前只支持分析外层主 Agent 的主 Skill；子 Agent 内部 Skill 仅作为来源展示，不作为本页主 Skill 对齐目标。
                                        </div>
                                    )}
                                </div>
                            </div>

                            {error && <div className="sa-alert">{error}</div>}

                            {/* dual-tab 已提到 ③ section level，这里只渲染当前 tab 的完整内容 */}

                            {detailTab === 'result' && (
                                <ResultAnalysisSection
                                    trajectoryEval={trajectoryEval}
                                    trajEvalLoading={trajEvalLoading}
                                    trajEvalError={trajEvalError}
                                    onStartEval={startResultEval}
                                    starting={trajEvalStarting}
                                />
                            )}

                            {detailTab === 'trajectory' && (
                                <>
                                    {matchLoading && <EmptyState title="正在读取分析结果" text="如果这条 Trace 尚未分析，稍后可点击按钮发起 Skill 对比。" compact />}
                                    {!matchLoading && (!matchData?.analyzed || (!matchData.staticMermaid && !matchData.dynamicMermaid && !matchData.matchJson)) && (
                                        <EmptyState
                                            title="这条 Trace 还未做轨迹分析"
                                            text={primarySkill?.name
                                                ? '点击后会基于外层主 Agent 的主 Skill 做流程图对齐；Skill 归因会从同一份 alignment 自动派生。'
                                                : '当前 Trace 的外层主 Agent 未加载 Skill，无法进行流程图对齐分析。'}
                                            actionLabel={primarySkill?.name ? (analyzing ? '分析中...' : '运行流程图比对') : undefined}
                                            onAction={primarySkill?.name ? runAnalyze : undefined}
                                        />
                                    )}
                                    {!matchLoading && matchData?.analyzed && (matchData.staticMermaid || matchData.dynamicMermaid || matchData.matchJson) && (
                                    <>
                                    {/* ───── 单 Trace 轨迹分数 Hero ─────
                                         与结果分析 Hero 同款风格：大字号分数置顶，无副指标。
                                         分数 = flow-parser overallScore（匹配度公式见 scoreFormulaTitle）。 */}
                                    <section className="sa-standards-wrap" style={{ marginBottom: 12 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '16px 18px' }}>
                                            <div>
                                                <div style={{ fontSize: 11, color: 'var(--sa-muted)', letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 700, marginBottom: 4 }}>
                                                    轨迹分析评分
                                                    <span style={{ marginLeft: 6, textTransform: 'none', letterSpacing: 0, fontWeight: 500, color: 'var(--sa-muted)', fontSize: 10 }} title={scoreFormulaTitle}>· 流程图匹配度公式</span>
                                                </div>
                                                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                                                    <b style={{
                                                        fontSize: 44, fontWeight: 800, lineHeight: 1, letterSpacing: '-1.5px',
                                                        color: score == null ? 'var(--sa-muted)'
                                                            : score >= 80 ? 'var(--sa-success)'
                                                            : score >= 50 ? 'var(--sa-warning)'
                                                            : 'var(--sa-danger)',
                                                    }}>
                                                        {score == null ? '--' : score}
                                                    </b>
                                                    <span style={{ fontSize: 14, color: 'var(--sa-muted)', fontWeight: 600 }}>/ 100</span>
                                                </div>
                                            </div>
                                            <button
                                                className="sa-mini-action"
                                                onClick={retryTraceAnalysis}
                                                disabled={analyzing || trajEvalStarting || matchLoading || !selectedTraceId || trajectoryEval?.status === 'pending' || trajectoryEval?.status === 'running'}
                                            >
                                                {analyzing || trajEvalStarting ? '重试中...' : '重试'}
                                            </button>
                                        </div>
                                    </section>

                                    <section className="sa-standards-wrap">
                                        <div className="sa-wrap-head">
                                            <h3>执行轨迹对齐 · Skill 预期标注</h3>
                                            <span style={{ color: 'var(--sa-muted)', fontSize: 12 }}>以实际执行为主，直接标注偏离与缺失步骤</span>
                                        </div>
                                        <TraceAlignmentPanel
                                            matches={matches}
                                            skippedExpectedSteps={skippedExpectedSteps}
                                            problemByStepKey={problemByStepKey}
                                            flowSteps={parsedFlow?.steps || []}
                                            extractedSteps={extractedSteps}
                                            alignment={parsedMatch?.alignment}
                                            mermaidCode={matchData.dynamicMermaid}
                                        />
                                    </section>

                                    {/* ───── Skill 归因分析（由 alignment 派生） ─────
                                        这是进入 skill-opt 优化输入的诊断结果，事实源与上方流程对齐一致 */}
                                    <section className="sa-standards-wrap">
                                        <div className="sa-wrap-head">
                                            <h3>Skill 归因分析</h3>
                                        </div>
                                        <div style={{ padding: '14px 16px' }}>
                                            {/* 归因调用的 LLM 模型走 user settings 的 active config(平台默认),
                                                这里不暴露切换入口,避免误导"切了影响所有评估"。
                                                要换默认模型去 /modelconfig。 */}
                                            {trajEvalError && <div className="sa-alert" style={{ marginBottom: 10 }}>{trajEvalError}</div>}

                                            {!trajectoryEval && !trajEvalLoading && (
                                                <div className="sa-dx-eval-empty">
                                                    <p style={{ margin: '0 0 6px', color: 'var(--sa-text)', fontWeight: 500 }}>
                                                        这条 Trace 还没经过<b>Skill 归因分析</b>
                                                    </p>
                                                    <p style={{ margin: 0, fontSize: 12.5, color: 'var(--sa-secondary)' }}>
                                                        点击上方「重试」会刷新执行轨迹对齐，并基于同一份 <b>alignment</b> 派生归因候选；
                                                        LLM 只补充是否可归因到主 Skill、原因和修复建议,
                                                        可归因的自动写入 SkillIssue 表喂给 skill-opt 对话。
                                                        <b>无需评测集</b>;上方&ldquo;流程对比&rdquo;就是唯一事实源。
                                                    </p>
                                                </div>
                                            )}
                                            {trajEvalLoading && !trajectoryEval && (
                                                <div className="sa-dx-eval-empty">读取归因结果中…</div>
                                            )}

                                            {trajectoryEval && (trajectoryEval.status === 'pending' || trajectoryEval.status === 'running') && (
                                                <div className="sa-dx-eval-progress">
                                                    <div className="sa-dx-eval-progress-head">
                                                        <span className="sa-dx-eval-progress-title">
                                                            归因生成{trajectoryEval.status === 'pending' ? '已入队，准备启动…' : '正在执行…'}
                                                        </span>
                                                        <span className="sa-dx-eval-progress-meta">
                                                            已用 <b>{trajEvalElapsed}s</b>
                                                        </span>
                                                    </div>
                                                    <div className="sa-dx-eval-progress-bar">
                                                        <div className="sa-dx-eval-progress-bar-fill" />
                                                    </div>
                                                    <ul className="sa-dx-eval-tasks">
                                                        <li><span className="dot running" />读取 alignment · 复用轨迹分析的唯一事实源</li>
                                                        <li><span className="dot running" />派生候选 · violations / skippedExpectedSteps / out_of_scope</li>
                                                        <li><span className="dot running" />补充建议 · 仅判断是否归因到 Skill 与修复方式</li>
                                                    </ul>
                                                    <div className="sa-dx-eval-progress-foot">
                                                        基于 alignment 做 Skill 归因 · 无需重复步骤抽取/流程对齐 · 结果会自动写入 SkillIssue 喂给 skill-opt
                                                    </div>
                                                </div>
                                            )}

                                            {trajectoryEval?.status === 'failed' && (
                                                <div className="sa-alert">
                                                    归因失败：{trajectoryEval.errorMessage || '未知错误'}
                                                </div>
                                            )}
                                            {(trajectoryEval?.status === 'done' || trajectoryEval?.status === 'failed') && (
                                                <SkillAttributionBadge row={trajectoryEval} />
                                            )}
                                            {trajectoryEval?.status === 'done' && (
                                                <TrajectoryEvaluatorFindings row={trajectoryEval} />
                                            )}
                                        </div>
                                    </section>
                                    </>
                                    )}

                                </>
                            )}
                        </>
                    )}
                </div>
                )}
            </SectionShell>{/* /③ 结果 */}
            </>)}{/* /trace mode (②+③) */}
        </section>
    );
}

/* ─────────────────────────────────────────────────────────────────
   评估器深度分析组件
   传入 TrajectoryEvalRow，按 4 类 finding 渲染:
     deviation_steps    → 路径偏离
     key_point_findings → 关键动作（covered=false 的）
     tool_choice_findings → 工具选择
     result_issues      → 结果问题（4 子类:format/extra/verbosity/incorrect_fact）
   每条带 is_skill_attributable 徽章 + improvement_suggestion。
   ───────────────────────────────────────────────────────────────── */
function pickAttr(obj: Record<string, unknown>, snakeKey: string, camelKey: string): unknown {
    if (snakeKey in obj && obj[snakeKey] !== undefined) return obj[snakeKey];
    if (camelKey in obj && obj[camelKey] !== undefined) return obj[camelKey];
    return undefined;
}

function extractFindings(row: TrajectoryEvalRow): EvaluatorFinding[] {
    const out: EvaluatorFinding[] = [];

    // 1) deviation_steps（API 已解析为 row.deviationSteps 数组）
    const dev: Record<string, unknown>[] = Array.isArray(row.deviationSteps)
        ? (row.deviationSteps as Record<string, unknown>[])
        : [];
    for (const d of dev) {
        const isAttr = pickAttr(d, 'is_skill_attributable', 'isSkillAttributable');
        const suggestion = pickAttr(d, 'improvement_suggestion', 'improvementSuggestion');
        out.push({
            kind: 'deviation',
            title: String(d.name ?? d.kind ?? '路径偏离') + (d.stepIndex != null ? ` · 步骤 ${d.stepIndex}` : ''),
            description: typeof d.deviation === 'string' ? d.deviation : undefined,
            severity: typeof d.severity === 'string' ? d.severity as EvaluatorFinding['severity'] : undefined,
            stepIndex: typeof d.stepIndex === 'number' ? d.stepIndex : undefined,
            isSkillAttributable: typeof isAttr === 'boolean' ? isAttr : true,
            improvementSuggestion: typeof suggestion === 'string' ? suggestion : undefined,
        });
    }

    // API list 端点返回的是已解析的 rawAnalysis 对象（不是原始 JSON 字符串）。
    const raw = row.rawAnalysis ?? null;
    const findFromRaw = (key: string): Record<string, unknown>[] => {
        if (!raw) return [];
        const direct = raw[key];
        if (Array.isArray(direct)) return direct as Record<string, unknown>[];
        const resultEval = raw.resultEvaluation;
        if (resultEval && typeof resultEval === 'object' && Array.isArray((resultEval as Record<string, unknown>)[key])) {
            return (resultEval as Record<string, unknown>)[key] as Record<string, unknown>[];
        }
        return [];
    };

    // 2) key_point_findings 仅展示 covered=false 的
    for (const f of findFromRaw('key_point_findings')) {
        const covered = pickAttr(f, 'covered', 'covered');
        if (covered === true) continue; // 已覆盖的不展示（不是问题）
        const isAttr = pickAttr(f, 'is_skill_attributable', 'isSkillAttributable');
        const suggestion = pickAttr(f, 'improvement_suggestion', 'improvementSuggestion');
        out.push({
            kind: 'key_point',
            title: `关键动作未覆盖：${String(f.content ?? '未命名要点')}`,
            description: typeof f.explanation === 'string' ? f.explanation : undefined,
            severity: typeof f.severity === 'string' ? f.severity as EvaluatorFinding['severity'] : undefined,
            covered: false,
            isSkillAttributable: typeof isAttr === 'boolean' ? isAttr : true,
            improvementSuggestion: typeof suggestion === 'string' ? suggestion : undefined,
        });
    }

    // 3) tool_choice_findings
    for (const f of findFromRaw('tool_choice_findings')) {
        const isAttr = pickAttr(f, 'is_skill_attributable', 'isSkillAttributable');
        const suggestion = pickAttr(f, 'improvement_suggestion', 'improvementSuggestion');
        out.push({
            kind: 'tool_choice',
            title: `工具选择问题：${String(f.tool ?? f.issue ?? '工具调用')}` + (f.step_index != null || f.stepIndex != null ? ` · 步骤 ${f.step_index ?? f.stepIndex}` : ''),
            description: typeof f.reason === 'string' ? f.reason : (typeof f.issue === 'string' ? f.issue : undefined),
            severity: typeof f.severity === 'string' ? f.severity as EvaluatorFinding['severity'] : undefined,
            stepIndex: typeof f.step_index === 'number' ? f.step_index as number : (typeof f.stepIndex === 'number' ? f.stepIndex as number : undefined),
            isSkillAttributable: typeof isAttr === 'boolean' ? isAttr : true,
            improvementSuggestion: typeof suggestion === 'string' ? suggestion : undefined,
        });
    }

    // 4) result_issues（任务完成度评估器的输出）
    const RESULT_KIND_LABEL: Record<string, string> = {
        format: '格式偏差',
        extra_content: '多余内容',
        verbosity: '表达问题',
        incorrect_fact: '事实错误',
        other: '结果问题',
    };
    for (const f of findFromRaw('result_issues')) {
        const isAttr = pickAttr(f, 'is_skill_attributable', 'isSkillAttributable');
        const suggestion = pickAttr(f, 'improvement_suggestion', 'improvementSuggestion');
        const subKind = typeof f.kind === 'string' ? f.kind : 'other';
        out.push({
            kind: 'result_issue',
            title: `${RESULT_KIND_LABEL[subKind] || subKind}：${String(f.summary ?? '未命名问题')}`,
            severity: typeof f.severity === 'string' ? f.severity as EvaluatorFinding['severity'] : undefined,
            isSkillAttributable: typeof isAttr === 'boolean' ? isAttr : true,
            improvementSuggestion: typeof suggestion === 'string' ? suggestion : undefined,
        });
    }

    return out;
}

const FINDING_KIND_LABEL: Record<EvaluatorFinding['kind'], string> = {
    deviation: '路径偏离',
    key_point: '关键动作',
    tool_choice: '工具选择',
    result_issue: '结果问题',
};

/* ─────────────────────────────────────────────────────────────────
   per-trace 符合项 / 扣分项 抽取
   - 结果分析 tab：从 trajectoryEval.rawAnalysis 抽
       符合项 = key_point_findings 里 covered=true 的
       扣分项 = key_point_findings 里 covered=false + result_issues
   - 轨迹分析 tab：从 trajectoryEval.rawAnalysis + matchData 抽
       符合项 = matchData.matches（命中的 flow 步骤）
       扣分项 = deviation_steps + tool_choice_findings
   返回的 deductions 复用 EvaluatorFinding 结构，已经带 severity / evidence。
   ───────────────────────────────────────────────────────────────── */
function extractCoveredKeyPoints(row: TrajectoryEvalRow | null): MatchingItem[] {
    if (!row) return [];
    const raw = row.rawAnalysis ?? null;
    if (!raw) return [];
    const direct = raw.key_point_findings;
    const fromResult = (raw.resultEvaluation && typeof raw.resultEvaluation === 'object')
        ? (raw.resultEvaluation as Record<string, unknown>).key_point_findings
        : null;
    const list = Array.isArray(direct) ? direct
        : Array.isArray(fromResult) ? fromResult : [];
    const out: MatchingItem[] = [];
    for (const f of list as Record<string, unknown>[]) {
        if (f.covered !== true) continue;
        out.push({
            kind: 'key_point_covered',
            title: String(f.content ?? '未命名关键点'),
            evidence: typeof f.explanation === 'string' ? f.explanation : undefined,
        });
    }
    return out;
}

function extractMatchedSteps(matchData: MatchData | null): MatchingItem[] {
    if (!matchData?.matchJson) return [];
    try {
        const parsed = JSON.parse(matchData.matchJson) as Record<string, unknown>;
        const matches = Array.isArray(parsed.matches) ? parsed.matches : [];
        return (matches as Record<string, unknown>[])
            .filter(m => m.matched !== false)  // 只要命中的
            .map((m, i) => ({
                kind: 'step_matched' as const,
                title: `步骤 ${typeof m.stepIndex === 'number' ? m.stepIndex + 1 : i + 1}：${String(m.stepName ?? m.expectedName ?? m.name ?? '未命名步骤')}`,
                evidence: typeof m.actualStep === 'string' ? `实际执行：${m.actualStep}`
                    : typeof m.evidence === 'string' ? m.evidence
                    : undefined,
            }));
    } catch {
        return [];
    }
}

/** 按 dual-tab 维度抽取本 trace 的符合项 + 扣分项 */
function extractItemsForTab(
    row: TrajectoryEvalRow | null,
    matchData: MatchData | null,
    tab: 'result' | 'trajectory',
): { matching: MatchingItem[]; deductions: EvaluatorFinding[] } {
    if (!row && !matchData) return { matching: [], deductions: [] };
    const allDeductions = row ? extractFindings(row) : [];
    if (tab === 'result') {
        return {
            matching: extractCoveredKeyPoints(row),
            deductions: allDeductions.filter(f => f.kind === 'key_point' || f.kind === 'result_issue'),
        };
    } else {
        return {
            matching: extractMatchedSteps(matchData),
            deductions: allDeductions.filter(f => f.kind === 'deviation' || f.kind === 'tool_choice'),
        };
    }
}

/** per-trace 符合项 / 扣分项 视图组件 —— 替代旧的 FindingsGrouped (按 trace 状态分组) */
function CaseAnalysisItemsView({
    selectedTrace,
    selectedTraceId,
    tab,
    trajectoryEval,
    matchData,
    resultScore,
    trajScore,
}: {
    selectedTrace: TraceRecord | null;
    selectedTraceId: string;
    tab: 'result' | 'trajectory';
    trajectoryEval: TrajectoryEvalRow | null;
    matchData: MatchData | null;
    resultScore: number | null;
    trajScore: number | null;
}) {
    if (!selectedTrace) {
        return (
            <div className="recall-empty" style={{ marginTop: 12 }}>
                <b>在 ② 执行块挑一条 trace 看分析细节</b>
                <div style={{ marginTop: 6, fontSize: 12 }}>每条 trace 都会按当前 tab（结果 / 轨迹）展开符合项 + 扣分项</div>
            </div>
        );
    }
    const { matching, deductions } = extractItemsForTab(trajectoryEval, matchData, tab);
    const score = tab === 'result' ? resultScore : trajScore;
    const scoreColor = score == null ? 'var(--ev-muted)'
        : score >= 80 ? 'var(--ev-success)'
        : score >= 60 ? 'var(--ev-warning)'
        : 'var(--ev-error)';
    const sevColor = (s?: string) => s === 'high' ? 'var(--ev-error)'
        : s === 'medium' ? 'var(--ev-warning)'
        : 'var(--ev-muted)';
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 12 }}>
            {/* 选中 trace 头部 */}
            <div style={{ padding: '10px 14px', background: '#fafafa', border: '1px solid var(--ev-line)', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--ev-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>当前 trace</span>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--ev-fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {selectedTrace.query || '(无 query)'}
                </span>
                <code style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--ev-muted)', background: 'rgba(0,0,0,.04)', padding: '1px 6px', borderRadius: 3 }}>
                    {selectedTraceId.slice(0, 12)}
                </code>
                <span style={{ fontFamily: 'monospace', fontSize: 16, fontWeight: 800, color: scoreColor }}>
                    {score ?? '--'} 分
                </span>
            </div>

            {/* 符合项 */}
            <div style={{ border: '1px solid rgba(22,163,74,0.2)', borderRadius: 8, overflow: 'hidden', background: 'rgba(22,163,74,0.03)' }}>
                <div style={{ padding: '8px 14px', borderBottom: '1px solid rgba(22,163,74,0.15)', background: 'rgba(22,163,74,0.08)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: 'var(--ev-success)', fontSize: 14, fontWeight: 800 }}>✓ 符合项</span>
                    <span style={{ fontSize: 11, color: 'var(--ev-muted)' }}>共 {matching.length} 条 · {tab === 'result' ? '关键观点已覆盖' : '流程步骤命中'}</span>
                </div>
                {matching.length === 0 ? (
                    <div style={{ padding: '16px 14px', textAlign: 'center', fontSize: 12, color: 'var(--ev-muted)' }}>
                        暂无符合项{tab === 'result' ? '——所有关键观点都没覆盖' : '——所有 SKILL.md flow 步骤都没命中'}
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                        {matching.map((m, i) => (
                            <div key={i} style={{ padding: '10px 14px', borderBottom: i === matching.length - 1 ? 0 : '1px solid rgba(22,163,74,0.1)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ev-fg)', display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <span style={{ color: 'var(--ev-success)' }}>✓</span>
                                    <span>{m.title}</span>
                                </div>
                                {m.evidence && (
                                    <div style={{ fontSize: 12, color: 'var(--ev-fg2)', paddingLeft: 16 }}>
                                        <span style={{ color: 'var(--ev-muted)', marginRight: 4 }}>证据：</span>
                                        {m.evidence}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* 扣分项 */}
            <div style={{ border: '1px solid rgba(220,38,38,0.2)', borderRadius: 8, overflow: 'hidden', background: 'rgba(220,38,38,0.03)' }}>
                <div style={{ padding: '8px 14px', borderBottom: '1px solid rgba(220,38,38,0.15)', background: 'rgba(220,38,38,0.08)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: 'var(--ev-error)', fontSize: 14, fontWeight: 800 }}>✗ 扣分项</span>
                    <span style={{ fontSize: 11, color: 'var(--ev-muted)' }}>共 {deductions.length} 条 · {tab === 'result' ? '输出未达预期' : '执行偏离 SKILL.md flow'}</span>
                </div>
                {deductions.length === 0 ? (
                    <div style={{ padding: '16px 14px', textAlign: 'center', fontSize: 12, color: 'var(--ev-muted)' }}>
                        无扣分项 ✓ 这条 trace 在「{tab === 'result' ? '结果' : '轨迹'}」维度全部达标
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                        {deductions.map((d, i) => (
                            <div key={i} style={{ padding: '10px 14px', borderBottom: i === deductions.length - 1 ? 0 : '1px solid rgba(220,38,38,0.1)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ev-fg)', display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <span style={{ color: 'var(--ev-error)' }}>✗</span>
                                    <span style={{ flex: 1 }}>{d.title}</span>
                                    {d.severity && (
                                        <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 3, color: '#fff', background: sevColor(d.severity) }}>
                                            {d.severity.toUpperCase()}
                                        </span>
                                    )}
                                </div>
                                {d.description && (
                                    <div style={{ fontSize: 12, color: 'var(--ev-fg2)', paddingLeft: 16 }}>
                                        <span style={{ color: 'var(--ev-muted)', marginRight: 4 }}>证据：</span>
                                        {d.description}
                                    </div>
                                )}
                                {d.improvementSuggestion && (
                                    <div style={{ fontSize: 12, color: 'var(--ev-info)', paddingLeft: 16 }}>
                                        <span style={{ color: 'var(--ev-muted)', marginRight: 4 }}>建议：</span>
                                        {d.improvementSuggestion}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

/* ─────────────────────────────────────────────────────────────────
   结果分析 section
   展示：测试集 case 的「预期结果」与 Trace 提取出的「实际输出」并列对比，
   下方列出 result_issues / key_point_findings 两类 skill 归因。
   数据来源：trajectoryEval.rawAnalysis（由 /api/eval/trajectory/run 跑
   preset-agent-task-completion 写入；result_artifact_extractor 抽实际输出，
   task-completion 评估器对比 → result_issues + key_point_findings）。
   ───────────────────────────────────────────────────────────────── */
function ResultAnalysisSection({
    trajectoryEval,
    trajEvalLoading,
    trajEvalError,
    onStartEval,
    starting,
}: {
    trajectoryEval: TrajectoryEvalRow | null;
    trajEvalLoading: boolean;
    trajEvalError: string;
    /** 触发任务完成度评估（preset-agent-task-completion）；空态时按钮调它 */
    onStartEval?: () => void | Promise<void>;
    /** 评估器是否正在启动；按钮 disabled 用 */
    starting?: boolean;
}) {
    const raw = trajectoryEval?.rawAnalysis ?? null;
    const root = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : null;

    // 抽预期 / 实际：caseSnapshot.expectedOutput vs resultActualOutput
    const caseSnapshot = root?.caseSnapshot && typeof root.caseSnapshot === 'object'
        ? root.caseSnapshot as Record<string, unknown>
        : null;
    const expectedOutput = typeof caseSnapshot?.expectedOutput === 'string'
        ? caseSnapshot.expectedOutput
        : '';
    const actualOutput = typeof root?.resultActualOutput === 'string'
        ? root.resultActualOutput as string
        : '';
    // 匹配上下文——dataset 名、case id、case input、匹配方式（exact/semantic/auto/...）
    const matchedCaseId = typeof caseSnapshot?.id === 'string' ? caseSnapshot.id : '';
    const matchedCaseInput = typeof caseSnapshot?.input === 'string' ? caseSnapshot.input : '';
    const matchedDatasetId = typeof caseSnapshot?.datasetId === 'string' ? caseSnapshot.datasetId : '';
    const matchedDatasetName = typeof caseSnapshot?.datasetName === 'string' ? caseSnapshot.datasetName : '';
    const matchKindRaw = typeof caseSnapshot?.matchKind === 'string' ? caseSnapshot.matchKind : '';
    const MATCH_KIND_META: Record<string, { label: string; color: string }> = {
        'explicit-pair': { label: '用户显式指定',     color: 'var(--sa-primary)' },
        'exact-input':   { label: '输入文本完全一致', color: 'var(--sa-success)' },
        'semantic':      { label: '语义匹配',          color: 'var(--sa-warning)' },
        'auto-match':    { label: '自动匹配',          color: 'var(--sa-warning)' },
        'fallback':      { label: '降级（无 case）',   color: 'var(--sa-muted)' },
        'no-dataset':    { label: '无数据集',          color: 'var(--sa-muted)' },
    };
    const matchKindMeta = MATCH_KIND_META[matchKindRaw] || { label: matchKindRaw || '未知', color: 'var(--sa-muted)' };

    // 抽 result evaluation 的核心字段（score / reason / 两类 finding）
    const resultEval = root?.resultEvaluation && typeof root.resultEvaluation === 'object'
        ? root.resultEvaluation as Record<string, unknown>
        : null;
    const score = typeof resultEval?.score === 'number' ? resultEval.score
        : typeof root?.score === 'number' ? (root.score as number)
        : null;
    const reason = typeof resultEval?.reason === 'string' ? resultEval.reason
        : typeof root?.reason === 'string' ? (root.reason as string)
        : '';

    // findings 既可能在顶层也可能在 resultEvaluation 下
    function readFindings(key: string): Record<string, unknown>[] {
        if (!root) return [];
        const top = root[key];
        if (Array.isArray(top)) return top as Record<string, unknown>[];
        const nested = resultEval?.[key];
        if (Array.isArray(nested)) return nested as Record<string, unknown>[];
        return [];
    }
    const keyPointFindings = readFindings('key_point_findings');
    const resultIssues = readFindings('result_issues');

    const hasResultData = !!resultEval || keyPointFindings.length > 0 || resultIssues.length > 0 || !!actualOutput;

    // 加载 / 错误 / 空态
    if (trajEvalLoading && !trajectoryEval) {
        return <div className="sa-dx-eval-empty">读取结果分析中…</div>;
    }
    if (trajEvalError) {
        return <div className="sa-alert">{trajEvalError}</div>;
    }
    if (!trajectoryEval) {
        return (
            <div className="sa-dx-eval-empty">
                <p style={{ margin: '0 0 6px', color: 'var(--sa-text)', fontWeight: 500 }}>
                    这条 Trace 还没经过<b>结果分析</b>
                </p>
                <p style={{ margin: 0, fontSize: 12.5, color: 'var(--sa-secondary)' }}>
                    点击下方按钮（或顶部「运行结果评估」）让任务完成度评估器跑一遍——
                    它会把测试集 case 的预期输出与 Trace 实际输出对比，产 key_point_findings + result_issues，
                    带 is_skill_attributable 徽章自动写入 skill-opt。
                </p>
                {onStartEval && (
                    <button
                        className="sa-mini-action"
                        style={{ marginTop: 12 }}
                        onClick={() => { void onStartEval(); }}
                        disabled={!!starting}
                    >
                        {starting ? '结果评估启动中…' : '运行结果评估'}
                    </button>
                )}
            </div>
        );
    }
    if (trajectoryEval.status === 'failed') {
        return (
            <div className="sa-alert">
                评估失败：{trajectoryEval.errorMessage || '未知错误'}
            </div>
        );
    }
    if (trajectoryEval.status === 'pending' || trajectoryEval.status === 'running') {
        return (
            <div className="sa-dx-eval-empty">
                评估进行中…（每 3s 自动刷新）
            </div>
        );
    }
    if (!hasResultData) {
        return (
            <div className="sa-dx-eval-empty">
                <p style={{ margin: '0 0 6px', color: 'var(--sa-text)', fontWeight: 500 }}>
                    本次评估未产出结果分析数据
                </p>
                <p style={{ margin: 0, fontSize: 12.5, color: 'var(--sa-secondary)' }}>
                    通常是没匹配到测试集 case（任务完成度评估器需要 case.expectedOutput 当对照）。
                    要拿结果分析数据，建议先在「测试集」里给这条 query 准备一条带预期结果的 case，
                    然后从「用例覆盖」/「灰度对照」入口跑评测。
                </p>
            </div>
        );
    }

    // 顶部 hero：单 trace 结果评分大数。只显示唯一权威分数（LLM 任务完成度），
    // 不再罗列"加权覆盖率/加权和"等中间变量——表底已有"覆盖 N/M 条"作为表格自身统计。
    const heroScorePct = score != null ? Math.round(score * 100) : null;
    const heroScoreColor = heroScorePct == null ? 'var(--sa-muted)'
        : heroScorePct >= 80 ? 'var(--sa-success)'
        : heroScorePct >= 50 ? 'var(--sa-warning)'
        : 'var(--sa-danger)';

    return (
        <>
            {/* ───── 单 Trace 结果分数 Hero ─────
                 唯一权威分数置顶，省去理解成本。表底显示覆盖统计。 */}
            <section className="sa-standards-wrap" style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '16px 18px' }}>
                    <div>
                        <div style={{ fontSize: 11, color: 'var(--sa-muted)', letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 700, marginBottom: 4 }}>
                            结果分析评分
                        </div>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                            <b style={{ fontSize: 44, fontWeight: 800, lineHeight: 1, color: heroScoreColor, letterSpacing: '-1.5px' }}>
                                {heroScorePct ?? '--'}
                            </b>
                            <span style={{ fontSize: 14, color: 'var(--sa-muted)', fontWeight: 600 }}>/ 100</span>
                        </div>
                    </div>
                    {trajectoryEval?.updatedAt && (
                        <span style={{ fontSize: 12, color: 'var(--sa-muted)' }}>
                            评估于 {new Date(trajectoryEval.updatedAt).toLocaleString()}
                        </span>
                    )}
                </div>
            </section>

            {/* ───── 匹配的 Case ─────
                 让用户清楚知道"这一次评估用的是哪条 case"。dataset 名 + caseId + caseInput +
                 匹配方式（用户指定 / 完全匹配 / 语义匹配 / 自动匹配 / 降级）。 */}
            <section className="sa-standards-wrap">
                <div className="sa-wrap-head">
                    <h3>匹配的 Case</h3>
                    <span style={{ color: matchKindMeta.color, fontSize: 12, fontWeight: 600 }}>
                        匹配方式：{matchKindMeta.label}
                    </span>
                </div>
                <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                        <span style={{ color: 'var(--sa-muted)', minWidth: 80 }}>数据集</span>
                        <span style={{ color: 'var(--sa-text)' }}>
                            {matchedDatasetName || matchedDatasetId || <span style={{ color: 'var(--sa-muted)' }}>—</span>}
                            {matchedCaseId && <span style={{ color: 'var(--sa-muted)', marginLeft: 6, fontFamily: 'var(--font-mono)' }}>· case#{matchedCaseId.slice(0, 8)}</span>}
                        </span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                        <span style={{ color: 'var(--sa-muted)', minWidth: 80, paddingTop: 2 }}>Case 输入</span>
                        <span style={{ color: 'var(--sa-text)', whiteSpace: 'pre-wrap', flex: 1 }}>
                            {matchedCaseInput || <span style={{ color: 'var(--sa-muted)' }}>—</span>}
                        </span>
                    </div>
                </div>
            </section>

            {/* ───── 预期 vs 实际输出对比 ───── */}
            <section className="sa-standards-wrap">
                <div className="sa-wrap-head">
                    <h3>预期 vs 实际输出</h3>
                </div>
                <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ border: '1px solid var(--sa-line)', borderRadius: 6, background: '#fff' }}>
                        <div style={{ padding: '8px 12px', background: '#f5f4f0', borderBottom: '1px solid var(--sa-line)', fontSize: 12, fontWeight: 600 }}>
                            预期结果 (该 case 标准答案)
                        </div>
                        <div style={{ padding: 12, fontSize: 12, lineHeight: 1.6, color: 'var(--sa-text)', whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>
                            {expectedOutput || <span style={{ color: 'var(--sa-muted)' }}>（未匹配到测试集 case 或 case 未填 expectedOutput）</span>}
                        </div>
                    </div>
                    <div style={{ border: '1px solid var(--sa-line)', borderRadius: 6, background: '#fff' }}>
                        <div style={{ padding: '8px 12px', background: '#f5f4f0', borderBottom: '1px solid var(--sa-line)', fontSize: 12, fontWeight: 600 }}>
                            实际输出 (从 Trace 抽取)
                        </div>
                        <div style={{ padding: 12, fontSize: 12, lineHeight: 1.6, color: 'var(--sa-text)', whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>
                            {actualOutput || <span style={{ color: 'var(--sa-muted)' }}>（result_artifact_extractor 未从 Trace 抽出输出）</span>}
                        </div>
                    </div>
                </div>
            </section>

            {/* ───── 评估器综述 ───── 只在 reason 非空时显示 */}
            {reason && (
                <section className="sa-standards-wrap">
                    <div className="sa-wrap-head">
                        <h3>评估器综述</h3>
                        <span>LLM-as-Judge</span>
                    </div>
                    <div style={{ padding: '14px 16px', fontSize: 12, lineHeight: 1.7, color: 'var(--sa-secondary)' }}>
                        {reason}
                    </div>
                </section>
            )}

            {/* ───── 关键观点判定表 + 总分汇总行 ───── */}
            <section className="sa-standards-wrap">
                <div className="sa-wrap-head">
                    <h3>关键观点判定</h3>
                    <div className="sa-wrap-actions">
                        <span style={{ color: 'var(--sa-muted)', fontSize: 12 }}>
                            从 case 预期答案抽取 · 列出全部观点（含已覆盖）
                        </span>
                        {onStartEval && (
                            <button
                                className="sa-mini-action"
                                onClick={() => { void onStartEval(); }}
                                disabled={!!starting}
                            >
                                {starting ? '重新评估中…' : '重新评估'}
                            </button>
                        )}
                    </div>
                </div>
                <div style={{ padding: '14px 16px' }}>
                    <KeyPointsJudgementTable
                        keyPointFindings={keyPointFindings}
                    />
                </div>
            </section>

            {/* ───── 其他结果质量问题（result_issues：格式 / 多余 / 冗余 / 事实错误） ─────
                 与"关键观点判定"独立——这里是 LLM 在覆盖度之外另发现的质量问题。 */}
            {resultIssues.length > 0 && (
                <section className="sa-standards-wrap">
                    <div className="sa-wrap-head">
                        <h3>其他结果质量问题</h3>
                        <span style={{ color: 'var(--sa-muted)', fontSize: 12 }}>
                            评估器额外识别 · 可归因项写入 skill-opt
                        </span>
                    </div>
                    <div style={{ padding: '14px 16px' }}>
                        <ResultFindingsList
                            keyPointFindings={[]}
                            resultIssues={resultIssues}
                        />
                    </div>
                </section>
            )}
        </>
    );
}

/**
 * 关键观点判定表。
 *
 * 列：序号 / 观点 / 权重 / 实际是否符合 / skill 归因 / 优化建议
 * 末行：覆盖统计 (覆盖 N / M 条)。最终评分在顶部 Hero，不再在表底重复显示。
 */
function KeyPointsJudgementTable({
    keyPointFindings,
}: {
    keyPointFindings: Record<string, unknown>[];
}) {
    // 统一抽字段（兼容 snake_case 和 camelCase）
    type Row = {
        content: string;
        covered: boolean;
        weight: number;
        isSkillAttributable: boolean | null;
        improvementSuggestion: string;
        explanation: string;
        severity: string;
    };
    const rows: Row[] = keyPointFindings.map(f => {
        const isAttr = pickAttr(f, 'is_skill_attributable', 'isSkillAttributable');
        const suggestion = pickAttr(f, 'improvement_suggestion', 'improvementSuggestion');
        const weight = typeof f.weight === 'number' ? f.weight
            : typeof f.weight === 'string' ? Number(f.weight) || 1
            : 1;
        return {
            content: String(f.content ?? '').trim() || '（未命名观点）',
            covered: f.covered === true,
            weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
            isSkillAttributable: typeof isAttr === 'boolean' ? isAttr : null,
            improvementSuggestion: typeof suggestion === 'string' ? suggestion : '',
            explanation: typeof f.explanation === 'string' ? f.explanation : '',
            severity: typeof f.severity === 'string' ? f.severity : '',
        };
    });

    const coveredCount = rows.filter(r => r.covered).length;

    if (rows.length === 0) {
        return <div style={{ color: 'var(--sa-muted)', fontSize: 12 }}>未抽取到任何关键观点。</div>;
    }

    return (
        <div style={{ border: '1px solid var(--sa-line)', borderRadius: 6, overflow: 'hidden', background: '#fff' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                    <tr style={{ background: '#f5f4f0', textAlign: 'left' }}>
                        <th style={{ padding: '8px 10px', fontWeight: 600, width: 40 }}>#</th>
                        <th style={{ padding: '8px 10px', fontWeight: 600 }}>关键观点</th>
                        <th style={{ padding: '8px 10px', fontWeight: 600, width: 60, textAlign: 'center' }}>权重</th>
                        <th style={{ padding: '8px 10px', fontWeight: 600, width: 80, textAlign: 'center' }}>实际</th>
                        <th style={{ padding: '8px 10px', fontWeight: 600, width: 110, textAlign: 'center' }}>Skill 归因</th>
                        <th style={{ padding: '8px 10px', fontWeight: 600 }}>优化建议</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((r, i) => (
                        <tr key={i} style={{ borderTop: '1px solid var(--sa-line)', verticalAlign: 'top' }}>
                            <td style={{ padding: '10px', color: 'var(--sa-muted)' }}>{i + 1}</td>
                            <td style={{ padding: '10px', lineHeight: 1.55 }}>
                                <div style={{ color: 'var(--sa-text)' }}>{r.content}</div>
                                {r.explanation && (
                                    <div style={{ color: 'var(--sa-muted)', fontSize: 11, marginTop: 4 }}>{r.explanation}</div>
                                )}
                            </td>
                            <td style={{ padding: '10px', textAlign: 'center', fontVariant: 'tabular-nums' }}>{r.weight.toFixed(1)}</td>
                            <td style={{ padding: '10px', textAlign: 'center' }}>
                                {r.covered ? (
                                    <span style={{ color: 'var(--sa-success)', fontWeight: 600 }}>✓ 符合</span>
                                ) : (
                                    <span style={{ color: 'var(--sa-danger)', fontWeight: 600 }}>✗ 缺失</span>
                                )}
                            </td>
                            <td style={{ padding: '10px', textAlign: 'center' }}>
                                {r.covered ? (
                                    <span style={{ color: 'var(--sa-muted)' }}>—</span>
                                ) : r.isSkillAttributable === true ? (
                                    <span style={{ color: 'var(--sa-primary)', fontWeight: 600 }}>✓ 可优化</span>
                                ) : r.isSkillAttributable === false ? (
                                    <span style={{ color: 'var(--sa-muted)' }}>非 Skill 问题</span>
                                ) : (
                                    <span style={{ color: 'var(--sa-muted)' }}>—</span>
                                )}
                            </td>
                            <td style={{ padding: '10px', color: 'var(--sa-secondary)', lineHeight: 1.55 }}>
                                {r.covered ? (
                                    <span style={{ color: 'var(--sa-muted)' }}>—</span>
                                ) : r.improvementSuggestion ? (
                                    r.improvementSuggestion
                                ) : r.isSkillAttributable === false ? (
                                    <span style={{ color: 'var(--sa-muted)' }}>—</span>
                                ) : (
                                    <span style={{ color: 'var(--sa-muted)' }}>评估器未给出建议</span>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
                <tfoot>
                    <tr style={{ borderTop: '1px solid var(--sa-line)', background: '#fafaf6' }}>
                        <td colSpan={6} style={{ padding: '10px 14px', fontSize: 12, color: 'var(--sa-secondary)' }}>
                            共 <b style={{ color: 'var(--sa-text)' }}>{rows.length}</b> 条关键观点，覆盖 <b style={{ color: 'var(--sa-text)' }}>{coveredCount}</b> 条。
                            最终评分见顶部「结果分析评分」。
                        </td>
                    </tr>
                </tfoot>
            </table>
        </div>
    );
}

/**
 * 结果分析 - 把 key_point_findings + result_issues 两组渲染成与 TrajectoryEvaluatorFindings
 * 同款卡片视图（共用 .sa-dx-eval-* 样式 + is_skill_attributable 徽章 + improvement_suggestion）。
 * 只关心结果维度——deviation_steps / tool_choice_findings 等放在「轨迹分析」tab。
 */
function ResultFindingsList({
    keyPointFindings,
    resultIssues,
}: {
    keyPointFindings: Record<string, unknown>[];
    resultIssues: Record<string, unknown>[];
}) {
    const findings: EvaluatorFinding[] = [];

    // key_point_findings：只展示 covered=false 的
    for (const f of keyPointFindings) {
        const covered = pickAttr(f, 'covered', 'covered');
        if (covered === true) continue;
        const isAttr = pickAttr(f, 'is_skill_attributable', 'isSkillAttributable');
        const suggestion = pickAttr(f, 'improvement_suggestion', 'improvementSuggestion');
        findings.push({
            kind: 'key_point',
            title: `关键动作未覆盖：${String(f.content ?? '未命名要点')}`,
            description: typeof f.explanation === 'string' ? f.explanation : undefined,
            severity: typeof f.severity === 'string' ? f.severity as EvaluatorFinding['severity'] : undefined,
            covered: false,
            isSkillAttributable: typeof isAttr === 'boolean' ? isAttr : true,
            improvementSuggestion: typeof suggestion === 'string' ? suggestion : undefined,
        });
    }

    // result_issues：4 子类
    const RESULT_KIND_LABEL: Record<string, string> = {
        format: '格式偏差',
        extra_content: '多余内容',
        verbosity: '表达问题',
        incorrect_fact: '事实错误',
        other: '结果问题',
    };
    for (const f of resultIssues) {
        const isAttr = pickAttr(f, 'is_skill_attributable', 'isSkillAttributable');
        const suggestion = pickAttr(f, 'improvement_suggestion', 'improvementSuggestion');
        const subKind = typeof f.kind === 'string' ? f.kind : 'other';
        findings.push({
            kind: 'result_issue',
            title: `${RESULT_KIND_LABEL[subKind] || subKind}：${String(f.summary ?? '未命名问题')}`,
            severity: typeof f.severity === 'string' ? f.severity as EvaluatorFinding['severity'] : undefined,
            isSkillAttributable: typeof isAttr === 'boolean' ? isAttr : true,
            improvementSuggestion: typeof suggestion === 'string' ? suggestion : undefined,
        });
    }

    if (findings.length === 0) {
        return (
            <div className="sa-dx-eval-empty">
                ✓ 评估器未识别出结果层面可归因到 Skill 的问题
            </div>
        );
    }

    const grouped: Record<EvaluatorFinding['kind'], EvaluatorFinding[]> = {
        deviation: [], key_point: [], tool_choice: [], result_issue: [],
    };
    for (const f of findings) grouped[f.kind].push(f);

    const totalAttrCount = findings.filter(f => f.isSkillAttributable !== false).length;
    const nonAttrCount = findings.length - totalAttrCount;

    return (
        <div className="sa-dx-eval-findings">
            <div className="sa-dx-eval-summary">
                <span>评估器识别出 <b>{findings.length}</b> 条结果问题</span>
                <span className="sa-dx-eval-summary-sep">·</span>
                <span><b style={{ color: 'var(--sa-warning)' }}>{totalAttrCount}</b> 条可归因到 Skill</span>
                {nonAttrCount > 0 && (
                    <>
                        <span className="sa-dx-eval-summary-sep">·</span>
                        <span style={{ color: 'var(--sa-muted)' }}>{nonAttrCount} 条非 Skill 问题</span>
                    </>
                )}
            </div>
            {(['key_point', 'result_issue'] as EvaluatorFinding['kind'][]).map(kind => {
                const items = grouped[kind];
                if (items.length === 0) return null;
                return (
                    <div key={kind} className="sa-dx-eval-group">
                        <div className="sa-dx-eval-group-head">
                            {FINDING_KIND_LABEL[kind]}
                            <span className="sa-dx-eval-group-count">{items.length}</span>
                        </div>
                        {items.map((f, i) => (
                            <div key={i} className={`sa-dx-eval-card${f.severity ? ' sev-' + f.severity : ''}${f.isSkillAttributable === false ? ' non-attr' : ''}`}>
                                <div className="sa-dx-eval-card-head">
                                    <span className="sa-dx-eval-title">{f.title}</span>
                                    {f.severity && <span className={`sa-pill ${f.severity === 'high' ? 'err' : f.severity === 'medium' ? 'warn' : ''}`}>{f.severity}</span>}
                                    {f.isSkillAttributable === false && (
                                        <span className="sa-pill" title="评估器判定此问题不能通过修改 SKILL.md 解决,不会进入 skill-opt">
                                            非 Skill 问题
                                        </span>
                                    )}
                                </div>
                                {f.description && <div className="sa-dx-eval-desc">{f.description}</div>}
                                {f.improvementSuggestion && f.isSkillAttributable !== false && (
                                    <div className="sa-dx-eval-suggestion">
                                        <span className="sa-dx-eval-suggestion-label">改进建议</span>
                                        {f.improvementSuggestion}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                );
            })}
        </div>
    );
}

// 显示"skill 归因"链路是否完整跑通——三步 (extract skill key actions / extract
// trace steps / compare) 任一步失败都用 degraded 显示；trace 本来没绑 skill 时
// 用 not-applicable（用户无需处理）。前几版静默吞掉，没法 debug，所以补这个。
function SkillAttributionBadge({ row }: { row: TrajectoryEvalRow }) {
    const attr = parseSkillAttributionFromRow(row);
    if (!attr || !attr.state) return null;

    const STATE_META: Record<string, { label: string; icon: string; color: string; bg: string }> = {
        ok: {
            label: 'Skill 归因：完整',
            icon: '✓',
            color: '#0ea672',
            bg: 'rgba(14, 166, 114, 0.10)',
        },
        degraded: {
            label: 'Skill 归因：已降级',
            icon: '⚠',
            color: '#b45309',
            bg: 'rgba(245, 158, 11, 0.10)',
        },
        'not-applicable': {
            label: 'Skill 归因：不适用',
            icon: '○',
            color: 'var(--sa-muted)',
            bg: 'rgba(120, 120, 120, 0.08)',
        },
    };
    const meta = STATE_META[attr.state] || STATE_META.degraded;

    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                margin: '0 0 10px',
                borderRadius: 6,
                background: meta.bg,
                color: meta.color,
                fontSize: 12,
                lineHeight: 1.5,
            }}
            title={attr.message || ''}
        >
            <span style={{ fontWeight: 700 }}>{meta.icon}</span>
            <span style={{ fontWeight: 600 }}>{meta.label}</span>
            {attr.message && (
                <span style={{ color: 'var(--sa-muted)', fontWeight: 400 }}>· {attr.message}</span>
            )}
        </div>
    );
}

function TrajectoryEvaluatorFindings({ row }: { row: TrajectoryEvalRow }) {
    const findings = extractFindings(row);
    if (findings.length === 0) {
        return (
            <div className="sa-dx-eval-empty">
                ✓ 评估器未识别出可归因到 Skill 的问题（这条 Trace 流程合规）
            </div>
        );
    }
    // 按 kind 分组
    const grouped: Record<EvaluatorFinding['kind'], EvaluatorFinding[]> = {
        deviation: [], key_point: [], tool_choice: [], result_issue: [],
    };
    for (const f of findings) grouped[f.kind].push(f);

    const totalAttrCount = findings.filter(f => f.isSkillAttributable !== false).length;
    const nonAttrCount = findings.length - totalAttrCount;

    return (
        <div className="sa-dx-eval-findings">
            <div className="sa-dx-eval-summary">
                <span>评估器识别出 <b>{findings.length}</b> 条问题</span>
                <span className="sa-dx-eval-summary-sep">·</span>
                <span><b style={{ color: 'var(--sa-warning)' }}>{totalAttrCount}</b> 条可归因到 Skill</span>
                {nonAttrCount > 0 && (
                    <>
                        <span className="sa-dx-eval-summary-sep">·</span>
                        <span style={{ color: 'var(--sa-muted)' }}>{nonAttrCount} 条 model/工具问题（不进优化）</span>
                    </>
                )}
            </div>
            {(Object.keys(grouped) as EvaluatorFinding['kind'][]).map(kind => {
                const items = grouped[kind];
                if (items.length === 0) return null;
                return (
                    <div key={kind} className="sa-dx-eval-group">
                        <div className="sa-dx-eval-group-head">
                            {FINDING_KIND_LABEL[kind]}
                            <span className="sa-dx-eval-group-count">{items.length}</span>
                        </div>
                        {items.map((f, i) => (
                            <div key={i} className={`sa-dx-eval-card${f.severity ? ' sev-' + f.severity : ''}${f.isSkillAttributable === false ? ' non-attr' : ''}`}>
                                <div className="sa-dx-eval-card-head">
                                    <span className="sa-dx-eval-title">{f.title}</span>
                                    {f.severity && <span className={`sa-pill ${f.severity === 'high' ? 'err' : f.severity === 'medium' ? 'warn' : ''}`}>{f.severity}</span>}
                                    {f.isSkillAttributable === false && (
                                        <span className="sa-pill" title="评估器判定此问题不能通过修改 SKILL.md 解决,不会进入 skill-opt">
                                            非 Skill 问题
                                        </span>
                                    )}
                                </div>
                                {f.description && <div className="sa-dx-eval-desc">{f.description}</div>}
                                {f.improvementSuggestion && f.isSkillAttributable !== false && (
                                    <div className="sa-dx-eval-suggestion">
                                        <span className="sa-dx-eval-suggestion-label">改进建议</span>
                                        {f.improvementSuggestion}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                );
            })}
        </div>
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
                primaryLabel={running ? '扫描中...' : '重新扫描'}
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
               顶部 AppTopBar 的"Skills 分析"已是可点击回 overview 的入口，
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

function FlowBox({ title, subtitle, code }: { title: string; subtitle?: string; code?: string }) {
    return (
        <div className="sa-flow-box">
            <h4>{title}{subtitle && <small>{subtitle}</small>}</h4>
            <div className="sa-mermaid-wrap">
                {code ? <MermaidRenderer code={code} /> : <span>暂无流程图</span>}
            </div>
        </div>
    );
}

type AlignmentStatus = 'matched' | 'partial' | 'unexpected' | 'delegated' | 'non_business' | 'skipped';

interface AlignmentNode {
    key: string;
    kind: 'actual' | 'skipped';
    status: AlignmentStatus;
    actualStepIndex?: number;
    actualAction?: string;
    expectedStepId?: string;
    expectedStepName?: string;
    expectedIndex?: number;
    reason?: string;
    problem?: string;
    suggestion?: string;
    extracted?: ExtractedTraceStep;
    violation?: AlignmentViolation;
    skillSpanLabels?: string[];
    evidenceInteractionIndexes?: number[];
}

const ALIGNMENT_STATUS_LABEL: Record<AlignmentStatus, string> = {
    matched: '符合预期',
    partial: '部分偏离',
    unexpected: '非预期调用',
    delegated: '子 Skill',
    non_business: '过渡操作',
    skipped: 'Skill 步骤缺失',
};

function TraceAlignmentPanel({
    matches,
    skippedExpectedSteps,
    problemByStepKey,
    flowSteps,
    extractedSteps,
    alignment,
    mermaidCode,
}: {
    matches: StepMatch[];
    skippedExpectedSteps: SkippedExpectedStep[];
    problemByStepKey: Map<string, ProblemStep>;
    flowSteps: FlowStep[];
    extractedSteps: ExtractedTraceStep[];
    alignment?: TraceSkillAlignment;
    mermaidCode?: string;
}) {
    const nodes = useMemo(
        () => alignment && Array.isArray(alignment.mappings) && alignment.mappings.length > 0
            ? buildAlignmentNodesFromStructuredAlignment(alignment, problemByStepKey, flowSteps, extractedSteps)
            : buildAlignmentNodes(matches, skippedExpectedSteps, problemByStepKey, flowSteps, extractedSteps),
        [alignment, matches, skippedExpectedSteps, problemByStepKey, flowSteps, extractedSteps],
    );
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const [showRawFlow, setShowRawFlow] = useState(false);
    const selectedNode = nodes.find(node => node.key === selectedKey)
        || nodes.find(node => node.status !== 'matched' && node.status !== 'delegated' && node.status !== 'non_business')
        || nodes[0]
        || null;

    const counts = useMemo(() => ({
        matched: nodes.filter(node => node.kind === 'actual' && node.status === 'matched').length,
        partial: nodes.filter(node => node.kind === 'actual' && node.status === 'partial').length,
        unexpected: nodes.filter(node => node.kind === 'actual' && node.status === 'unexpected').length,
        delegated: nodes.filter(node => node.kind === 'actual' && node.status === 'delegated').length,
        nonBusiness: nodes.filter(node => node.kind === 'actual' && node.status === 'non_business').length,
        skipped: nodes.filter(node => node.kind === 'skipped').length,
        actualTotal: nodes.filter(node => node.kind === 'actual').length,
    }), [nodes]);
    const skillSpans = Array.isArray(alignment?.skillSpans)
        ? [...alignment.skillSpans].sort((a, b) => {
            if (a.trigger === 'primary' && b.trigger !== 'primary') return -1;
            if (a.trigger !== 'primary' && b.trigger === 'primary') return 1;
            return a.startActualStepIndex - b.startActualStepIndex;
        })
        : [];
    if (nodes.length === 0) {
        return (
            <div className="sa-alignment-empty">
                暂无可对齐步骤。可以点击右上角重试，生成实际执行步骤与 Skill 预期的匹配结果。
            </div>
        );
    }

    return (
        <div className="sa-alignment">
            <div className="sa-alignment-summary" aria-label="轨迹诊断摘要">
                <div className="sa-alignment-summary-main">
                    <b>{counts.actualTotal}</b>
                    <span>个实际步骤</span>
                </div>
                <div className="sa-alignment-metrics">
                    <AlignmentMetric status="matched" value={counts.matched} label="符合预期" />
                    <AlignmentMetric status="partial" value={counts.partial} label="部分偏离" />
                    <AlignmentMetric status="unexpected" value={counts.unexpected} label="非预期调用" />
                    <AlignmentMetric status="delegated" value={counts.delegated} label="子 Skill" />
                    <AlignmentMetric status="non_business" value={counts.nonBusiness} label="过渡操作" />
                    <AlignmentMetric status="skipped" value={counts.skipped} label="缺失步骤" />
                </div>
            </div>

            <div className="sa-alignment-body">
                <div className="sa-alignment-timeline" aria-label="执行轨迹对齐图">
                    {skillSpans.length > 0 && (
                        <div className="sa-align-span-summary">
                            {skillSpans.map((span, index) => (
                                <span key={`${span.skillName}-${index}`}>
                                    {formatSkillSpanLabel(span)}
                                    <small>步骤 #{span.startActualStepIndex} - #{span.endActualStepIndex}</small>
                                </span>
                            ))}
                        </div>
                    )}
                    {nodes.map((node, index) => (
                        <TraceAlignmentNode
                            key={node.key}
                            node={node}
                            position={index + 1}
                            selected={selectedNode?.key === node.key}
                            onSelect={() => setSelectedKey(node.key)}
                        />
                    ))}
                </div>
                <AlignmentDetail node={selectedNode} />
            </div>

            {mermaidCode && (
                <div className="sa-alignment-raw">
                    <button className="sa-mini-action" onClick={() => setShowRawFlow(v => !v)}>
                        {showRawFlow ? '收起原始流程图' : '查看原始流程图'}
                    </button>
                    {showRawFlow && (
                        <div className="sa-flow-grid single">
                            <FlowBox title="原始流程图" subtitle="保留用于排查与回退" code={mermaidCode} />
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function AlignmentMetric({ status, value, label }: { status: AlignmentStatus; value: number; label: string }) {
    return (
        <div className={`sa-alignment-metric ${status}`}>
            <b>{value}</b>
            <span>{label}</span>
        </div>
    );
}

function TraceAlignmentNode({
    node,
    position,
    selected,
    onSelect,
}: {
    node: AlignmentNode;
    position: number;
    selected: boolean;
    onSelect: () => void;
}) {
    const title = node.kind === 'skipped'
        ? node.expectedStepName || '未执行的 Skill 步骤'
        : node.actualAction || `实际步骤 #${node.actualStepIndex ?? position}`;
    const subtitle = node.kind === 'skipped'
        ? 'Skill 规定了该步骤，但实际轨迹没有覆盖'
        : node.status === 'delegated' && node.skillSpanLabels?.length
            ? `子 Skill：${node.skillSpanLabels.join('、')}，不参与主 Skill 内容匹配`
            : node.status === 'non_business'
            ? '上下文收集或流程衔接动作，不参与主 Skill 业务评分'
            : node.expectedStepName
            ? `对齐 Skill：${node.expectedStepName}`
            : '未匹配到 Skill 预期步骤';
    return (
        <button className={`sa-align-node ${node.status} ${selected ? 'selected' : ''}`} onClick={onSelect}>
            <span className="sa-align-rail">
                <span className="sa-align-dot">{statusGlyph(node.status)}</span>
            </span>
            <span className="sa-align-card">
                <span className="sa-align-card-head">
                    <span className="sa-align-index">
                        {node.kind === 'skipped' ? 'Skill' : `#${node.actualStepIndex ?? position}`}
                    </span>
                    <span className={`sa-align-status ${node.status}`}>{ALIGNMENT_STATUS_LABEL[node.status]}</span>
                    {node.skillSpanLabels?.map((label, index) => (
                        <span key={`${label}-${index}`} className="sa-align-skill-chip">{label}</span>
                    ))}
                </span>
                <b>{title}</b>
                <small>{subtitle}</small>
                {node.problem && <em>{node.problem}</em>}
            </span>
        </button>
    );
}

function AlignmentDetail({ node }: { node: AlignmentNode | null }) {
    if (!node) {
        return (
            <aside className="sa-align-detail">
                <b>步骤详情</b>
                <p>选择左侧步骤查看实际行为、Skill 预期和偏离建议。</p>
            </aside>
        );
    }

    return (
        <aside className={`sa-align-detail ${node.status}`}>
            <div className="sa-align-detail-head">
                <span className={`sa-align-status ${node.status}`}>{ALIGNMENT_STATUS_LABEL[node.status]}</span>
                <b>{node.kind === 'skipped' ? node.expectedStepName : node.actualAction}</b>
            </div>
            <dl>
                {node.actualStepIndex != null && (
                    <>
                        <dt>实际位置</dt>
                        <dd>Trace 步骤 #{node.actualStepIndex}</dd>
                    </>
                )}
                {node.expectedStepName && (
                    <>
                        <dt>Skill 预期</dt>
                        <dd>{node.expectedStepName}</dd>
                    </>
                )}
                {node.extracted?.description && (
                    <>
                        <dt>实际描述</dt>
                        <dd>{node.extracted.description}</dd>
                    </>
                )}
                {node.skillSpanLabels && node.skillSpanLabels.length > 0 && (
                    <>
                        <dt>Skill 区间</dt>
                        <dd>{node.skillSpanLabels.join('、')}</dd>
                    </>
                )}
                {node.problem && (
                    <>
                        <dt>偏离问题</dt>
                        <dd>{node.problem}</dd>
                    </>
                )}
                {node.suggestion && (
                    <>
                        <dt>建议</dt>
                        <dd>{node.suggestion}</dd>
                    </>
                )}
                {node.evidenceInteractionIndexes && node.evidenceInteractionIndexes.length > 0 && (
                    <>
                        <dt>证据位置</dt>
                        <dd>Trace 步骤 #{node.evidenceInteractionIndexes.join(', #')}</dd>
                    </>
                )}
            </dl>
        </aside>
    );
}

function buildAlignmentNodesFromStructuredAlignment(
    alignment: TraceSkillAlignment,
    problemByStepKey: Map<string, ProblemStep>,
    flowSteps: FlowStep[],
    extractedSteps: ExtractedTraceStep[],
): AlignmentNode[] {
    const mappings = Array.isArray(alignment.mappings) ? alignment.mappings : [];
    const actualSteps = Array.isArray(alignment.actualSteps) ? alignment.actualSteps : [];
    const skipped = Array.isArray(alignment.skippedExpectedSteps) ? alignment.skippedExpectedSteps : [];
    const violations = Array.isArray(alignment.violations) ? alignment.violations : [];
    const spans = Array.isArray(alignment.skillSpans) ? alignment.skillSpans : [];
    const expectedIndexById = new Map(flowSteps.map((step, index) => [step.id, index]));
    const actualByIndex = new Map(actualSteps.map(step => [step.index, step]));

    const nodes: AlignmentNode[] = mappings
        .slice()
        .sort((a, b) => a.actualStepIndex - b.actualStepIndex)
        .map((mapping, index) => {
            const actual = actualByIndex.get(mapping.actualStepIndex);
            const violation = findViolationForMapping(violations, mapping);
            const fallbackProblem = problemByStepKey.get(`actual:${mapping.actualStepIndex}`)
                || problemByStepKey.get(`name:${mapping.expectedStepName || ''}`)
                || problemByStepKey.get(`name:${actual?.action || ''}`);
            const extracted = actual
                ? {
                    name: actual.action,
                    description: actual.description,
                    dialogStartIndex: actual.dialogStartIndex,
                    dialogEndIndex: actual.dialogEndIndex,
                    type: actual.type,
                }
                : findExtractedStep(extractedSteps, mapping.actualStepIndex);
            return {
                key: `alignment-actual-${mapping.actualStepIndex}-${index}`,
                kind: 'actual',
                status: mapping.status,
                actualStepIndex: mapping.actualStepIndex,
                actualAction: actual?.action || `实际步骤 #${mapping.actualStepIndex}`,
                expectedStepId: mapping.expectedStepId,
                expectedStepName: mapping.expectedStepName,
                expectedIndex: mapping.expectedStepId ? expectedIndexById.get(mapping.expectedStepId) : undefined,
                reason: mapping.reason,
                problem: violation?.problem || fallbackProblem?.problem,
                suggestion: violation?.suggestion || fallbackProblem?.suggestion,
                extracted,
                violation,
                skillSpanLabels: spans
                    .filter(span => span.trigger !== 'primary' && mapping.actualStepIndex >= span.startActualStepIndex && mapping.actualStepIndex <= span.endActualStepIndex)
                    .map(formatSkillSpanLabel)
                    .filter((label, labelIndex, labels) => labels.indexOf(label) === labelIndex),
                evidenceInteractionIndexes: violation?.evidenceInteractionIndexes,
            };
        });

    const skippedNodes = skipped
        .slice()
        .sort((a, b) => (expectedIndexById.get(a.expectedStepId) ?? Number.MAX_SAFE_INTEGER) - (expectedIndexById.get(b.expectedStepId) ?? Number.MAX_SAFE_INTEGER))
        .map((step, index): AlignmentNode => {
            const violation = violations.find(v => v.kind === 'skipped' && (v.expectedStepId === step.expectedStepId || v.expectedStepName === step.expectedStepName));
            const fallbackProblem = problemByStepKey.get(`name:${step.expectedStepName}`);
            return {
                key: `alignment-skipped-${step.expectedStepId}-${index}`,
                kind: 'skipped',
                status: 'skipped',
                expectedStepId: step.expectedStepId,
                expectedStepName: step.expectedStepName,
                expectedIndex: expectedIndexById.get(step.expectedStepId),
                problem: violation?.problem || fallbackProblem?.problem,
                suggestion: violation?.suggestion || fallbackProblem?.suggestion,
                violation,
                evidenceInteractionIndexes: violation?.evidenceInteractionIndexes,
            };
        });

    return insertSkippedNodes(nodes, skippedNodes);
}

function buildAlignmentNodes(
    matches: StepMatch[],
    skippedExpectedSteps: SkippedExpectedStep[],
    problemByStepKey: Map<string, ProblemStep>,
    flowSteps: FlowStep[],
    extractedSteps: ExtractedTraceStep[],
): AlignmentNode[] {
    const expectedIndexById = new Map(flowSteps.map((step, index) => [step.id, index]));
    const actualNodes: AlignmentNode[] = matches
        .filter(match => match.matchStatus !== 'skipped')
        .slice()
        .sort((a, b) => (a.actualStepIndex ?? 0) - (b.actualStepIndex ?? 0))
        .map((match, index) => {
            const actualStepIndex = match.actualStepIndex ?? index;
            const problem = problemByStepKey.get(`actual:${match.actualStepIndex}`)
                || problemByStepKey.get(`name:${match.expectedStepName || ''}`)
                || problemByStepKey.get(`name:${match.actualAction}`);
            return {
                key: `actual-${actualStepIndex}-${index}`,
                kind: 'actual',
                status: match.matchStatus,
                actualStepIndex,
                actualAction: match.actualAction,
                expectedStepId: match.expectedStepId,
                expectedStepName: match.expectedStepName,
                expectedIndex: match.expectedStepId ? expectedIndexById.get(match.expectedStepId) : undefined,
                reason: match.matchReason,
                problem: problem?.problem,
                suggestion: problem?.suggestion,
                extracted: findExtractedStep(extractedSteps, actualStepIndex),
            };
        });

    const skippedNodes = skippedExpectedSteps
        .slice()
        .sort((a, b) => (expectedIndexById.get(a.expectedStepId) ?? Number.MAX_SAFE_INTEGER) - (expectedIndexById.get(b.expectedStepId) ?? Number.MAX_SAFE_INTEGER))
        .map((step, index): AlignmentNode => {
            const problem = problemByStepKey.get(`name:${step.expectedStepName}`);
            return {
                key: `skipped-${step.expectedStepId}-${index}`,
                kind: 'skipped',
                status: 'skipped',
                expectedStepId: step.expectedStepId,
                expectedStepName: step.expectedStepName,
                expectedIndex: expectedIndexById.get(step.expectedStepId),
                problem: problem?.problem,
                suggestion: problem?.suggestion,
            };
        });

    return insertSkippedNodes(actualNodes, skippedNodes);
}

function insertSkippedNodes(actualNodes: AlignmentNode[], skippedNodes: AlignmentNode[]) {
    const nodes: AlignmentNode[] = [...actualNodes];
    for (const skipped of skippedNodes) {
        if (skipped.expectedIndex == null) {
            nodes.push(skipped);
            continue;
        }
        const insertBefore = nodes.findIndex(node => node.expectedIndex != null && node.expectedIndex > skipped.expectedIndex!);
        if (insertBefore >= 0) {
            nodes.splice(insertBefore, 0, skipped);
            continue;
        }
        let insertAfter = -1;
        nodes.forEach((node, index) => {
            if (node.expectedIndex != null && node.expectedIndex <= skipped.expectedIndex!) insertAfter = index;
        });
        nodes.splice(insertAfter + 1, 0, skipped);
    }

    return nodes;
}

function findViolationForMapping(violations: AlignmentViolation[], mapping: AlignmentMapping) {
    return violations.find(violation => {
        if (violation.actualStepIndex != null && violation.actualStepIndex === mapping.actualStepIndex) return true;
        if (violation.expectedStepId && violation.expectedStepId === mapping.expectedStepId) return true;
        return !!violation.expectedStepName && violation.expectedStepName === mapping.expectedStepName;
    });
}

function formatSkillSpanLabel(span: AlignmentSkillSpan) {
    return span.version != null ? `${span.skillName} v${span.version}` : span.skillName;
}

function findExtractedStep(extractedSteps: ExtractedTraceStep[], actualStepIndex: number) {
    const byUiIndex = extractedSteps.find(step => step.uiStepIndex === actualStepIndex);
    if (byUiIndex) return byUiIndex;
    return extractedSteps.find(step => {
        const start = step.dialogStartIndex;
        const end = step.dialogEndIndex;
        return typeof start === 'number' && typeof end === 'number' && start <= actualStepIndex && end >= actualStepIndex;
    });
}

function statusGlyph(status: AlignmentStatus) {
    if (status === 'matched') return '✓';
    if (status === 'partial') return '!';
    if (status === 'unexpected') return '×';
    if (status === 'delegated') return 'S';
    if (status === 'non_business') return '~';
    return '−';
}

function MermaidRenderer({ code }: { code: string }) {
    const [svg, setSvg] = useState('');
    const [error, setError] = useState('');
    const [scale, setScale] = useState(1);
    const [baseSize, setBaseSize] = useState<{ width: number; height: number } | null>(null);
    const [fullscreen, setFullscreen] = useState(false);
    const [renderId] = useState(() => `sa-mermaid-${Math.random().toString(36).slice(2)}`);
    const viewportRef = useRef<HTMLDivElement | null>(null);
    const fullscreenViewportRef = useRef<HTMLDivElement | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const fullscreenContentRef = useRef<HTMLDivElement | null>(null);
    const userAdjustedZoomRef = useRef(false);

    useEffect(() => {
        let cancelled = false;
        setSvg('');
        setError('');
        setScale(1);
        setBaseSize(null);
        userAdjustedZoomRef.current = false;
        import('mermaid')
            .then(mod => {
                const mermaid = mod.default;
                mermaid.initialize({
                    startOnLoad: false,
                    theme: 'base',
                    themeVariables: {
                        primaryColor: '#ffffff',
                        primaryTextColor: '#18181b',
                        primaryBorderColor: '#d4d4d8',
                        lineColor: '#71717a',
                        fontFamily: 'system-ui, -apple-system, sans-serif',
                        fontSize: '12px',
                    },
                    flowchart: { curve: 'basis', padding: 8, nodeSpacing: 18, rankSpacing: 18 },
                });
                return mermaid.render(`${renderId}-${Date.now()}`, code);
            })
            .then(({ svg }) => {
                if (!cancelled) setSvg(svg);
            })
            .catch(() => {
                if (!cancelled) setError('流程图渲染失败');
            });
        return () => { cancelled = true; };
    }, [code]);

    const clampScale = useCallback((value: number) => Math.max(0.35, Math.min(2.5, value)), []);

    const fitScaleFor = useCallback((target: HTMLDivElement | null, width: number) => {
        if (!target || width <= 0) return 1;
        const available = Math.max(160, target.clientWidth - 24);
        return clampScale(available / width);
    }, [clampScale]);

    const measureSvg = useCallback((root: HTMLDivElement | null) => {
        const svgEl = root?.querySelector('svg');
        if (!svgEl) return null;
        const viewBox = svgEl.getAttribute('viewBox')?.split(/\s+/).map(Number);
        const width = viewBox && viewBox.length === 4 && Number.isFinite(viewBox[2])
            ? viewBox[2]
            : svgEl.getBoundingClientRect().width;
        const height = viewBox && viewBox.length === 4 && Number.isFinite(viewBox[3])
            ? viewBox[3]
            : svgEl.getBoundingClientRect().height;
        if (width <= 0 || height <= 0) return null;
        return { width, height };
    }, []);

    useEffect(() => {
        if (!svg) return;
        const frame = window.requestAnimationFrame(() => {
            const activeContent = fullscreen ? fullscreenContentRef.current : contentRef.current;
            const activeViewport = fullscreen ? fullscreenViewportRef.current : viewportRef.current;
            const measured = measureSvg(activeContent);
            if (!measured) return;
            setBaseSize(measured);
            if (!userAdjustedZoomRef.current) {
                setScale(fitScaleFor(activeViewport, measured.width));
            }
        });
        return () => window.cancelAnimationFrame(frame);
    }, [fitScaleFor, fullscreen, measureSvg, svg]);

    useEffect(() => {
        if (!baseSize || !svg || userAdjustedZoomRef.current) return;
        const target = fullscreen ? fullscreenViewportRef.current : viewportRef.current;
        if (!target || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(() => {
            if (!userAdjustedZoomRef.current) {
                setScale(fitScaleFor(target, baseSize.width));
            }
        });
        observer.observe(target);
        return () => observer.disconnect();
    }, [baseSize, fitScaleFor, fullscreen, svg]);

    useEffect(() => {
        if (!fullscreen) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setFullscreen(false);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [fullscreen]);

    const setZoom = useCallback((next: number) => {
        userAdjustedZoomRef.current = true;
        setScale(clampScale(Math.round(next * 100) / 100));
    }, [clampScale]);

    const fitWidth = useCallback((target: HTMLDivElement | null) => {
        if (!target || !baseSize?.width) return;
        userAdjustedZoomRef.current = true;
        setScale(fitScaleFor(target, baseSize.width));
    }, [baseSize, fitScaleFor]);

    const renderControls = (targetRef: React.RefObject<HTMLDivElement | null>, isFullscreen = false) => (
        <div className="sa-mermaid-tools" aria-label="流程图查看器工具栏">
            <button onClick={() => setZoom(scale - 0.1)} title="缩小">-</button>
            <button onClick={() => setZoom(scale + 0.1)} title="放大">+</button>
            <button onClick={() => setZoom(1)} title="恢复 100%">100%</button>
            <button onClick={() => fitWidth(targetRef.current)} title="适应宽度">适应宽度</button>
            {!isFullscreen && <button onClick={() => setFullscreen(true)} title="全屏查看">全屏</button>}
            <span>{Math.round(scale * 100)}%</span>
        </div>
    );

    const renderViewport = (
        targetRef: React.RefObject<HTMLDivElement | null>,
        targetContentRef: React.RefObject<HTMLDivElement | null>,
        isFullscreen = false,
    ) => (
        <>
            {renderControls(targetRef, isFullscreen)}
            <div className={`sa-mermaid-viewport ${isFullscreen ? 'fullscreen' : ''}`} ref={targetRef}>
                <div
                    className="sa-mermaid-stage"
                    style={{
                        width: baseSize ? `${baseSize.width * scale}px` : undefined,
                        height: baseSize ? `${baseSize.height * scale}px` : undefined,
                    }}
                >
                    <div
                        ref={targetContentRef}
                        className="sa-mermaid"
                        style={{
                            width: baseSize ? `${baseSize.width}px` : undefined,
                            height: baseSize ? `${baseSize.height}px` : undefined,
                            transform: `scale(${scale})`,
                        }}
                        dangerouslySetInnerHTML={{ __html: svg }}
                    />
                </div>
            </div>
        </>
    );

    if (error) return <span>{error}</span>;
    if (!svg) return <span>正在渲染流程图...</span>;
    return (
        <>
            {renderViewport(viewportRef, contentRef)}
            {fullscreen && (
                <div className="sa-mermaid-fullscreen" role="dialog" aria-modal="true" aria-label="流程图全屏查看器">
                    <div className="sa-mermaid-fullscreen-head">
                        <b>流程图查看器</b>
                        <button onClick={() => setFullscreen(false)}>关闭</button>
                    </div>
                    {renderViewport(fullscreenViewportRef, fullscreenContentRef, true)}
                </div>
            )}
        </>
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

function getSkillMonogram(name?: string | null) {
    const cleaned = (name || '').trim();
    if (!cleaned) return 'SK';
    const ascii = cleaned.replace(/[^a-zA-Z0-9]/g, '');
    if (ascii.length >= 2) return ascii.slice(0, 2).toUpperCase();
    return cleaned.slice(0, 2).toUpperCase();
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
