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
import { apiFetch } from '@/lib/client/api';
import { useAuth } from '@/lib/auth/auth-context';
import { Term } from '@/components/text/Term';
import { parseSkillAttributionFromRow } from '@/lib/engine/evaluation/skill-attribution';
import { fmtPercentScore } from '@/lib/eval/score-format';
import {
    getTrajectoryOverallConclusion,
    isTrajectoryEvaluationTerminal,
    parseTrajectoryDiagnostic,
} from '@/lib/eval/trajectory-diagnostic';
import './evaluator-findings-view.css';

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
    completeness: number | null;
    toolChoice: number;
    redundancy: number;
    /** 归因维度（v2 起不计入加权轨迹分，仅历史数据可能携带）。 */
    attribution?: number;
}

interface TrajectoryDeviation {
    stepIndex?: number;
    kind: string;
    name?: string;
    deviation: string;
    severity: 'low' | 'medium' | 'high';
    improvementSuggestion?: string;
    isSkillAttributable?: boolean;
}

interface ResultEvaluationFinding {
    content: string;
    score?: number | null;
    covered?: boolean;
    coverageStatus?: 'covered' | 'partial' | 'missing' | 'wrong';
    severity?: 'low' | 'medium' | 'high';
    explanation?: string;
    coverageReason?: string;
    missingReason?: string;
    evidence?: {
        actual?: string;
        expected?: string;
    };
    traceRootCause?: {
        failureStage?: 'evidence_collection' | 'tool_usage' | 'reasoning' | 'final_answer' | 'model_or_environment' | 'unknown';
        failureReason?: string;
        relatedSteps?: Array<{
            stepIndex?: number;
            kind?: string;
            name?: string;
            evidence?: string;
        }>;
    };
    isSkillAttributable?: boolean;
    attributionReason?: string;
    improvementSuggestion?: string;
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
    retryState: {
        attemptCount: number;
        maxAttempts: number;
        retrying: boolean;
        exhausted: boolean;
        nextRetryAt?: string;
        lastError?: string;
    } | null;
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

interface ReferenceKeyAction {
    id?: string;
    content?: string;
    weight?: number;
    controlFlowType?: 'required' | 'conditional' | 'loop' | 'optional' | 'handoff';
    condition?: string;
    branchLabel?: string;
    loopCondition?: string;
    expectedMinCount?: number;
    expectedMaxCount?: number;
    skillSource?: string;
    groupId?: string;
}

interface ActualExtractedStep {
    uiStepIndex?: number;
    name?: string;
    description?: string;
    dialogStartIndex?: number;
    dialogEndIndex?: number;
    type?: 'action' | 'decision' | 'output';
}

interface SkillKeyActionComparisonPayload {
    referenceKeyActionsText: string;
    actualExtractedStepsText: string;
    referenceKeyActions: ReferenceKeyAction[];
    actualExtractedSteps: ActualExtractedStep[];
}

type KeyActionCoverage = 'covered' | 'partial' | 'missing' | 'not_applicable';

interface SkillKeyActionCard {
    action: ReferenceKeyAction;
    analysis: string;
    suggestion: string;
    coverage: KeyActionCoverage;
    matchedStep?: ActualExtractedStep;
    matchedStepIndex?: number;
    severity?: 'high' | 'medium' | 'low';
}

interface LlmKeyActionResult {
    actionId: string;
    actionContent: string;
    coverage: KeyActionCoverage;
    severity?: 'high' | 'medium' | 'low';
    matchedTraceSteps: number[];
    traceComparisonAnalysis: string;
    hasSkillImprovement: boolean;
    skillImprovementSuggestion: string;
    confidence?: number;
}

interface TrajectoryReasonLine {
    label: string;
    body: string;
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
        .map(item => {
            const evidence = asRecord(item.evidence);
            const traceRootCause = asRecord(item.trace_root_cause ?? item.traceRootCause);
            const relatedStepsRaw = Array.isArray(traceRootCause.related_steps)
                ? traceRootCause.related_steps
                : Array.isArray(traceRootCause.relatedSteps)
                ? traceRootCause.relatedSteps
                : [];
            const coverageStatusRaw = String(item.coverage_status ?? item.coverageStatus ?? '').trim();
            const failureStageRaw = String(traceRootCause.failure_stage ?? traceRootCause.failureStage ?? '').trim();
            const isSkillAttr = item.is_skill_attributable ?? item.isSkillAttributable;
            return {
                content: String(item.content || '').trim(),
                score: typeof item.score === 'number' && Number.isFinite(item.score) ? item.score : null,
                covered: typeof item.covered === 'boolean' ? item.covered : undefined,
                coverageStatus: isCoverageStatus(coverageStatusRaw) ? coverageStatusRaw : undefined,
                severity: item.severity === 'high' || item.severity === 'medium' || item.severity === 'low'
                    ? (item.severity as 'low' | 'medium' | 'high')
                    : undefined,
                explanation: String(item.explanation || '').trim(),
                coverageReason: String(item.coverage_reason ?? item.coverageReason ?? '').trim(),
                missingReason: String(item.missing_reason ?? item.missingReason ?? '').trim(),
                evidence: {
                    actual: String(evidence.actual || '').trim(),
                    expected: String(evidence.expected || '').trim(),
                },
                traceRootCause: {
                    failureStage: isFailureStage(failureStageRaw) ? failureStageRaw : undefined,
                    failureReason: String(traceRootCause.failure_reason ?? traceRootCause.failureReason ?? '').trim(),
                    relatedSteps: relatedStepsRaw
                        .map(step => asRecord(step))
                        .map(step => ({
                            stepIndex: typeof (step.step_index ?? step.stepIndex) === 'number'
                                ? (step.step_index ?? step.stepIndex) as number
                                : undefined,
                            kind: String(step.kind || '').trim(),
                            name: String(step.name || '').trim(),
                            evidence: String(step.evidence || '').trim(),
                        }))
                        .filter(step => step.stepIndex != null || step.kind || step.name || step.evidence),
                },
                isSkillAttributable: typeof isSkillAttr === 'boolean' ? isSkillAttr : undefined,
                attributionReason: String(item.attribution_reason ?? item.attributionReason ?? '').trim(),
                improvementSuggestion: String(item.improvement_suggestion ?? item.improvementSuggestion ?? '').trim(),
            };
        })
        .filter(item => item.content || item.explanation);
}

function isCoverageStatus(value: string): value is NonNullable<ResultEvaluationFinding['coverageStatus']> {
    return value === 'covered' || value === 'partial' || value === 'missing' || value === 'wrong';
}

function isFailureStage(value: string): value is NonNullable<NonNullable<ResultEvaluationFinding['traceRootCause']>['failureStage']> {
    return value === 'evidence_collection'
        || value === 'tool_usage'
        || value === 'reasoning'
        || value === 'final_answer'
        || value === 'model_or_environment'
        || value === 'unknown';
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
    comparisonMode?: 'trajectory' | 'skill_key_actions' | 'trace_only';
    taskTitle?: string;
    taskDescription?: string;
    datasetId: string;
    caseId: string;
    executionId: string | null;
    taskId: string | null;
    status: 'pending' | 'running' | 'done' | 'failed';
    errorMessage: string | null;
    resultEvaluationError?: string | null;
    trajectoryScore: number | null;
    resultEvaluationScore?: number | null;
    dimensionScores: DimensionScores | null;
    deviationSteps: TrajectoryDeviation[];
    rootCauseStep: string | null;
    reasonText: string | null;
    customEvaluationScore?: number | null;
    customEvaluations?: CustomEvaluationItem[];
    diagnostic?: unknown;
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
            };
            resultEvaluationRetry?: {
                attemptCount?: unknown;
                maxAttempts?: unknown;
                retrying?: unknown;
                exhausted?: unknown;
                nextRetryAt?: unknown;
                lastError?: unknown;
            };
            resultEvaluationError?: unknown;
            resultActualOutput?: unknown;
            score?: unknown;
            reason?: unknown;
            key_point_findings?: unknown;
        }
        : null;

    const directFindings = deriveResultEvaluationFindings(rawAnalysis);
    const parsedFromReason = parseLooseJsonText(
        String(execution?.judgment_reason || execution?.judgmentReason || ''),
    );
    const directFindingsRaw = root?.resultEvaluation?.key_point_findings
        ?? root?.key_point_findings;
    const fallbackFindingsRaw = parsedFromReason?.key_point_findings;
    const fallbackFindings = normalizeFindings(
        fallbackFindingsRaw,
    );
    const findings = directFindings.length > 0 ? directFindings : fallbackFindings;
    const hasStructuredFindings = Array.isArray(directFindingsRaw) || Array.isArray(fallbackFindingsRaw);

    const errorMessage = typeof root?.resultEvaluationError === 'string' ? root.resultEvaluationError.trim() : '';
    const scoreCandidates = [
        typeof root?.resultEvaluation?.score === 'number' ? root.resultEvaluation.score : null,
        typeof root?.score === 'number' ? root.score : null,
    ];
    const score = errorMessage
        ? null
        : scoreCandidates.find((item): item is number => typeof item === 'number' && !Number.isNaN(item)) ?? null;

    const reasonCandidates = [
        typeof root?.resultEvaluation?.reason === 'string' ? root.resultEvaluation.reason : '',
        typeof root?.resultEvaluation?.key_point_summary === 'string' ? root.resultEvaluation.key_point_summary : '',
        typeof root?.reason === 'string' ? root.reason : '',
        execution?.judgment_reason,
        execution?.judgmentReason,
        typeof parsedFromReason?.reason === 'string' ? parsedFromReason.reason : '',
    ];
    const reason = stripEmbeddedKeyPoints(String(reasonCandidates.find(item => String(item || '').trim()) || ''));
    const actualOutput = String(
        typeof root?.resultActualOutput === 'string' ? root.resultActualOutput : '',
    ).trim();
    const retryRaw = root?.resultEvaluationRetry;
    const retryState = retryRaw && typeof retryRaw === 'object'
        ? {
            attemptCount: typeof retryRaw.attemptCount === 'number' ? retryRaw.attemptCount : 0,
            maxAttempts: typeof retryRaw.maxAttempts === 'number' ? retryRaw.maxAttempts : 0,
            retrying: retryRaw.retrying === true,
            exhausted: retryRaw.exhausted === true,
            ...(typeof retryRaw.nextRetryAt === 'string' && retryRaw.nextRetryAt.trim()
                ? { nextRetryAt: retryRaw.nextRetryAt.trim() }
                : {}),
            ...(typeof retryRaw.lastError === 'string' && retryRaw.lastError.trim()
                ? { lastError: retryRaw.lastError.trim() }
                : {}),
        }
        : null;

    return { score, reason, findings, hasStructuredFindings, errorMessage, actualOutput, retryState };
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
            };
            key_point_findings?: unknown;
        }
        : null;

    const rawFindings =
        Array.isArray(root?.resultEvaluation?.key_point_findings)
            ? root.resultEvaluation.key_point_findings
            : Array.isArray(root?.key_point_findings)
            ? root.key_point_findings
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

function deriveSkillKeyActionComparison(rawAnalysis: unknown): SkillKeyActionComparisonPayload | null {
    const root = rawAnalysis && typeof rawAnalysis === 'object'
        ? rawAnalysis as { skillKeyActionComparison?: unknown }
        : null;
    const payload = root?.skillKeyActionComparison;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const record = payload as Record<string, unknown>;
    const referenceKeyActions = Array.isArray(record.referenceKeyActions)
        ? record.referenceKeyActions
            .filter(item => item && typeof item === 'object' && !Array.isArray(item))
            .map(item => item as ReferenceKeyAction)
        : [];
    const actualExtractedSteps = Array.isArray(record.actualExtractedSteps)
        ? record.actualExtractedSteps
            .filter(item => item && typeof item === 'object' && !Array.isArray(item))
            .map(item => item as ActualExtractedStep)
        : [];

    return {
        referenceKeyActionsText: String(record.referenceKeyActionsText || '').trim(),
        actualExtractedStepsText: String(record.actualExtractedStepsText || '').trim(),
        referenceKeyActions,
        actualExtractedSteps,
    };
}

function normalizeComparisonText(text: string): string {
    return text
        .toLowerCase()
        .replace(/[`~!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?，。！？；：（）【】《》、\s]+/g, '');
}

function createBigrams(text: string): Set<string> {
    const normalized = normalizeComparisonText(text);
    if (!normalized) return new Set();
    if (normalized.length === 1) return new Set([normalized]);
    const grams = new Set<string>();
    for (let index = 0; index < normalized.length - 1; index += 1) {
        grams.add(normalized.slice(index, index + 2));
    }
    return grams;
}

function scoreTextSimilarity(left: string, right: string): number {
    const leftGrams = createBigrams(left);
    const rightGrams = createBigrams(right);
    if (leftGrams.size === 0 || rightGrams.size === 0) return 0;

    let intersection = 0;
    for (const gram of leftGrams) {
        if (rightGrams.has(gram)) intersection += 1;
    }
    const union = new Set([...leftGrams, ...rightGrams]).size;
    return union > 0 ? intersection / union : 0;
}

function formatTraceStepRef(step: ActualExtractedStep, fallbackIndex: number): string {
    if (typeof step.uiStepIndex === 'number') return `步骤 ${step.uiStepIndex}`;
    return `提取步骤 ${fallbackIndex + 1}`;
}

function buildDefaultSkillSuggestion(action: ReferenceKeyAction, coverage: KeyActionCoverage): string {
    const skillSource = action.skillSource ? `${action.skillSource} SKILL.md` : 'SKILL.md';
    const flowHint = action.controlFlowType === 'conditional' && action.branchLabel
        ? `，并明确仅在“${action.branchLabel}”分支命中时执行`
        : action.controlFlowType === 'loop' && action.loopCondition
        ? `，并补充循环触发条件“${action.loopCondition}”`
        : '';

    if (coverage === 'covered') {
        return `在 ${skillSource} 中继续把“${action.content || '该关键动作'}”写成显式步骤${flowHint}，并保留完成判定，避免 agent 在相邻步骤间跳步。`;
    }
    if (coverage === 'partial') {
        return `在 ${skillSource} 中把“${action.content || '该关键动作'}”补成更强的过程约束${flowHint}，明确推荐工具、完成信号和禁止跳步条件。`;
    }
    return `在 ${skillSource} 中把“${action.content || '该关键动作'}”标记为必须执行的核心步骤${flowHint}，写清操作方式和完成标准，避免 trace 直接跳过。`;
}

function normalizeKeyActionCoverage(value: unknown): LlmKeyActionResult['coverage'] {
    const raw = String(value || '').trim();
    if (raw === 'covered' || raw === 'partial' || raw === 'missing' || raw === 'not_applicable') return raw;
    return 'missing';
}

function parseLlmKeyActionResults(rawAnalysis: unknown): LlmKeyActionResult[] {
    const root = rawAnalysis && typeof rawAnalysis === 'object' && !Array.isArray(rawAnalysis)
        ? rawAnalysis as Record<string, unknown>
        : null;
    if (!root) return [];
    const direct = Array.isArray(root.keyActionResults)
        ? root.keyActionResults
        : Array.isArray(root.key_action_results)
        ? root.key_action_results
        : [];

    return direct
        .map(item => item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null)
        .filter((item): item is Record<string, unknown> => Boolean(item))
        .map(item => {
            const steps = Array.isArray(item.matchedTraceSteps)
                ? item.matchedTraceSteps
                : Array.isArray(item.matched_trace_steps)
                ? item.matched_trace_steps
                : [];
            const rawSeverity = String(item.severity || '');
            const severity: LlmKeyActionResult['severity'] = rawSeverity === 'high' || rawSeverity === 'medium' || rawSeverity === 'low'
                ? rawSeverity
                : undefined;
            return {
                actionId: String(item.actionId ?? item.action_id ?? '').trim(),
                actionContent: String(item.actionContent ?? item.action_content ?? '').trim(),
                coverage: normalizeKeyActionCoverage(item.coverage),
                severity,
                matchedTraceSteps: steps
                    .map(step => typeof step === 'number' ? step : Number(step))
                    .filter(step => Number.isFinite(step)),
                traceComparisonAnalysis: String(item.traceComparisonAnalysis ?? item.trace_comparison_analysis ?? '').trim(),
                hasSkillImprovement: (item.hasSkillImprovement ?? item.has_skill_improvement) === true,
                skillImprovementSuggestion: String(item.skillImprovementSuggestion ?? item.skill_improvement_suggestion ?? '').trim(),
                confidence: typeof item.confidence === 'number' && Number.isFinite(item.confidence)
                    ? item.confidence
                    : undefined,
            };
        })
        .filter(item => item.actionId || item.actionContent || item.traceComparisonAnalysis);
}

function deriveSkillKeyActionCardsFromLlm(rawAnalysis: unknown): SkillKeyActionCard[] {
    return parseLlmKeyActionResults(rawAnalysis).map((item, index) => ({
        action: {
            id: item.actionId,
            content: item.actionContent || `关键动作 ${index + 1}`,
        },
        analysis: item.traceComparisonAnalysis || '评估器未返回该关键动作的 trace 对比分析。',
        suggestion: item.skillImprovementSuggestion || '路径已覆盖该动作，无 Skill 改进点',
        coverage: item.coverage,
        severity: item.severity,
    }));
}

function deriveSkillKeyActionCards(
    comparison: SkillKeyActionComparisonPayload | null,
    deviationSteps: TrajectoryDeviation[] | null | undefined,
): SkillKeyActionCard[] {
    if (!comparison || comparison.referenceKeyActions.length === 0) return [];

    const actions = comparison.referenceKeyActions;
    const actualSteps = comparison.actualExtractedSteps;
    const attributableDeviations = (deviationSteps || []).filter(step => step.isSkillAttributable !== false);
    const cards: SkillKeyActionCard[] = [];
    let nextStepCursor = 0;

    const findRelatedDeviation = (
        action: ReferenceKeyAction,
        matchedStep: ActualExtractedStep | undefined,
        matchedStepIndex: number | undefined,
    ): TrajectoryDeviation | undefined => {
        const actionText = action.content || '';
        let best: { item: TrajectoryDeviation; score: number } | null = null;
        for (const deviation of attributableDeviations) {
            let score = 0;
            if (
                matchedStep
                && typeof matchedStep.uiStepIndex === 'number'
                && typeof deviation.stepIndex === 'number'
            ) {
                const distance = Math.abs(deviation.stepIndex - matchedStep.uiStepIndex);
                if (distance <= 1) score += 1.1;
                else if (distance <= 3) score += 0.6;
            } else if (
                typeof matchedStepIndex === 'number'
                && typeof deviation.stepIndex === 'number'
            ) {
                const distance = Math.abs(deviation.stepIndex - (matchedStepIndex + 1));
                if (distance <= 1) score += 0.4;
            }

            score += scoreTextSimilarity(
                actionText,
                [deviation.name, deviation.deviation, deviation.improvementSuggestion].filter(Boolean).join(' '),
            );

            if (!best || score > best.score) {
                best = { item: deviation, score };
            }
        }
        return best && best.score >= 0.22 ? best.item : undefined;
    };

    actions.forEach((action, actionIndex) => {
        const actionText = action.content || '';
        let bestMatch: { step: ActualExtractedStep; index: number; lexical: number; final: number } | null = null;

        for (let stepIndex = nextStepCursor; stepIndex < actualSteps.length; stepIndex += 1) {
            const step = actualSteps[stepIndex];
            const stepText = [step.name, step.description].filter(Boolean).join(' ');
            const lexical = scoreTextSimilarity(actionText, stepText);
            const orderAlignment = 1 - Math.abs(
                (actionIndex + 1) / Math.max(actions.length, 1)
                - (stepIndex + 1) / Math.max(actualSteps.length, 1),
            );
            const final = lexical * 0.72 + orderAlignment * 0.28;

            if (!bestMatch || final > bestMatch.final) {
                bestMatch = { step, index: stepIndex, lexical, final };
            }
        }

        let matchedStep: ActualExtractedStep | undefined;
        let matchedStepIndex: number | undefined;
        let coverage: KeyActionCoverage = 'missing';

        if (bestMatch && bestMatch.lexical >= 0.34) {
            matchedStep = bestMatch.step;
            matchedStepIndex = bestMatch.index;
            coverage = bestMatch.lexical >= 0.56 ? 'covered' : 'partial';
        } else if (nextStepCursor < actualSteps.length) {
            matchedStep = actualSteps[nextStepCursor];
            matchedStepIndex = nextStepCursor;
            coverage = 'partial';
        }

        if (typeof matchedStepIndex === 'number') {
            nextStepCursor = matchedStepIndex + 1;
        }

        const relatedDeviation = findRelatedDeviation(action, matchedStep, matchedStepIndex);
        let analysis = '';
        if (matchedStep && typeof matchedStepIndex === 'number') {
            const stepTitle = matchedStep.name || matchedStep.description || '未命名步骤';
            const stepRef = formatTraceStepRef(matchedStep, matchedStepIndex);
            analysis = coverage === 'covered'
                ? `Trace 在${stepRef}执行了“${stepTitle}”，与这个关键动作基本对齐。`
                : `Trace 在${stepRef}执行了“${stepTitle}”，但和这个关键动作只部分对齐，过程约束还不够明确。`;
            if (matchedStep.description && matchedStep.description !== matchedStep.name) {
                analysis += ` 实际表现：${matchedStep.description}`;
            }
        } else {
            analysis = 'Trace 中没有找到与这个关键动作直接对应的步骤，当前流程很可能跳过了这个必做动作。';
        }

        if (relatedDeviation?.deviation) {
            analysis += ` 评估器识别到：${relatedDeviation.deviation}`;
        }

        cards.push({
            action,
            analysis,
            suggestion: relatedDeviation?.improvementSuggestion || buildDefaultSkillSuggestion(action, coverage),
            coverage,
            matchedStep,
            matchedStepIndex,
            severity: relatedDeviation?.severity,
        });
    });

    return cards;
}

function deriveResultEvaluationSummary(
    payload: ResultEvaluationPayload,
): ResultEvaluationSummary {
    return {
        score: payload.score,
        reason: payload.reason,
    };
}

function formatTrajectoryReasonText(text: string | null | undefined): TrajectoryReasonLine[] {
    const raw = String(text || '').trim();
    if (!raw) return [];
    const normalized = raw
        .replace(/\s*(完整性(?:[（(]|[:：]))/g, '\n$1')
        .replace(/。?\s*(工具选择[（(])/g, '\n$1')
        .replace(/。?\s*(冗余[（(])/g, '\n$1')
        .replace(/。?\s*(可能触发封顶的偏差[:：]?)/g, '\n$1')
        .replace(/\n{2,}/g, '\n')
        .trim();

    const lines = normalized
        .split('\n')
        .map(line => line.trim())
        .map(line => line.replace(/^[-*]\s+/, '').trim())
        .filter(Boolean);

    return lines
        .map(line => {
            const match = line.match(/^(完整性(?:[（(][^）)]*[）)]|[:：])|工具选择[（(][^）)]*[）)]|冗余[（(][^）)]*[）)]|可能触发封顶的偏差)\s*[:：]?\s*(.*)$/);
            if (!match) {
                return { label: '', body: line };
            }
            return {
                label: match[1].replace(/[:：]$/, ''),
                body: match[2] || '',
            };
        });
}

function TrajectoryReasonBlock({ text }: { text: string | null | undefined }) {
    const lines = formatTrajectoryReasonText(text);
    if (lines.length === 0) {
        return <span style={{ color: COLORS.textDisabled }}>(无 reasonText)</span>;
    }
    return (
        <ul>
            {lines.map((line, index) => (
                <li key={`${line.label || 'line'}-${index}`}>
                    {line.label ? <strong>{line.label}</strong> : null}
                    {line.label && line.body ? '：' : null}
                    {line.body}
                </li>
            ))}
        </ul>
    );
}

export default function TrajectoryDetailView({ traceId }: { traceId: string }) {
    const { user } = useAuth();
    const router = useRouter();
    const params = useSearchParams();
    const datasetId = params?.get('datasetId') || '';
    const runId = params?.get('runId') || '';
    const resultId = params?.get('resultId') || '';
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
                if (resultId) {
                    const det = await apiFetch(
                        `/api/eval/trajectory/results/${encodeURIComponent(resultId)}?user=${encodeURIComponent(user)}`,
                    ).then(r => r.json()).catch(() => null);
                    if (!stopped) {
                        setResult(det || null);
                    }
                    return;
                }
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
    }, [user, traceId, datasetId, runId, resultId]);

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
    const evaluationDiagnostic = useMemo(
        () => parseTrajectoryDiagnostic(result),
        [result],
    );
    const terminalDiagnosticText = useMemo(() => {
        if (!result || !isTrajectoryEvaluationTerminal(result.status) || !evaluationDiagnostic) return '';
        return [
            evaluationDiagnostic.userMessage,
            evaluationDiagnostic.reason ? `具体原因：${evaluationDiagnostic.reason}` : '',
            evaluationDiagnostic.nextAction ? `下一步建议：${evaluationDiagnostic.nextAction}` : '',
        ].filter(Boolean).join('\n');
    }, [evaluationDiagnostic, result]);
    const isMatchingCase = Boolean(result && !caseEntry && !isEvaluationTerminal(result.status));
    const caseSnapshot = useMemo(
        () => deriveCaseSnapshot(result?.rawAnalysis),
        [result?.rawAnalysis],
    );
    const skillAttribution = useMemo(
        () => parseSkillAttributionFromRow(result),
        [result],
    );
    const skillKeyActionComparison = useMemo(
        () => deriveSkillKeyActionComparison(result?.rawAnalysis),
        [result?.rawAnalysis],
    );
    const skillKeyActionCards = useMemo(
        () => {
            const llmCards = deriveSkillKeyActionCardsFromLlm(result?.rawAnalysis);
            return llmCards.length > 0
                ? llmCards
                : deriveSkillKeyActionCards(skillKeyActionComparison, result?.deviationSteps);
        },
        [result?.rawAnalysis, skillKeyActionComparison, result?.deviationSteps],
    );
    const isTraceOnlyTrajectory = result?.comparisonMode === 'trace_only'
        || asRecord(result?.rawAnalysis).comparisonMode === 'trace_only'
        || asRecord(result?.rawAnalysis).comparison_mode === 'trace_only';
    const shouldShowSkillKeyActions = !isTraceOnlyTrajectory && skillKeyActionCards.length > 0;
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
    const groundTruthEmptyHint = !hasResultEvaluation && !groundTruthValue.trim()
        ? '未选择 Agent 任务完成度评估器，本次不展示预期结果。'
        : '';
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
        const r = hasResultEvaluation
            ? (resultEvaluationSummary.score ?? null)
            : null;
        const c = hasCustomEvaluation ? customEvaluationScore : null;

        if (hasTraceEvaluation && (traj == null || !Number.isFinite(traj))) return null;
        if (hasResultEvaluation && (r == null || !Number.isFinite(r))) return null;
        if (hasCustomEvaluation && (c == null || !Number.isFinite(c))) return null;

        const parts = [traj, r, c].filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
        return parts.length > 0 ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
    }, [result, noEvaluableCase, hasTraceEvaluation, hasResultEvaluation, hasCustomEvaluation, customEvaluationScore, resultEvaluationSummary.score]);

    const overallText = getTrajectoryOverallConclusion(result, {
        composite,
        fallbackRootCauseStep: result?.rootCauseStep,
    });

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
                                {fmtPercentScore(composite)} <span style={{ fontSize: 11, color: COLORS.textMuted, fontWeight: 400 }}>/ 100</span>
                            </span>
                        </>
                    )}
                </div>
                <div style={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6, whiteSpace: 'pre-line' }}>
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
                            emptyHint={groundTruthEmptyHint}
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
                        ) : terminalDiagnosticText ? (
                            <div style={{
                                color: COLORS.danger,
                                fontSize: 12,
                                padding: 10,
                                marginTop: 8,
                                background: COLORS.dangerSubtle,
                                border: `1px solid ${COLORS.border}`,
                                borderRadius: 6,
                                lineHeight: 1.6,
                                whiteSpace: 'pre-line',
                            }}>
                                {terminalDiagnosticText}
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
                        ) : noEvaluableCase ? (
                            <div style={{ color: COLORS.textMuted, fontSize: 12, paddingTop: 8 }}>
                                {cleanNoEvaluableCaseMessage(result?.errorMessage)}
                            </div>
                        ) : !resultEvaluationReady ? (
                            <div style={{ color: COLORS.textMuted, fontSize: 12, paddingTop: 8 }}>
                                {result && isTrajectoryEvaluationTerminal(result.status)
                                    ? '结果评测未产出完整结构化结果。'
                                    : '结果评测进行中…任务完成度得分、原因、关键观点会在结果评估器产出完整结果后一起显示。'}
                            </div>
                        ) : (
                            <>
                                <ScoreLine
                                    label="任务完成度得分"
                                    value={resultEvaluationSummary.score == null ? '--' : `${fmtPercentScore(resultEvaluationSummary.score)} / 100`}
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
                                {resultEvaluationFindings.length > 0 && (
                                    <div style={{ marginTop: 12 }}>
                                        <div style={{ fontSize: 11.5, color: COLORS.textMuted, marginBottom: 6 }}>任务完成度评测详情</div>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                            {resultEvaluationFindings.map((item, index) => (
                                                <KeyPointFindingCard key={index} item={item} fallbackTitle={`关键观点 #${index + 1}`} />
                                            ))}
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
                                        <TrajectoryReasonBlock text={result.reasonText} />
                                    </div>
                                </div>

                                {(() => {
                                    const findings = deriveDimensionFindings(result.rawAnalysis);
                                    const dims = resolveDimensionScores(result.dimensionScores, result.rawAnalysis);
                                    if (dims.completeness == null && dims.toolChoice == null && dims.redundancy == null) return null;
                                    return (
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8, marginBottom: 12 }}>
                                            <DimensionCard label="完整性" termId="traj-completeness" weight={isTraceOnlyTrajectory ? undefined : 0.45} score={isTraceOnlyTrajectory ? null : dims.completeness} findings={findings.completeness} notScored={isTraceOnlyTrajectory} />
                                            <DimensionCard label="工具选择" termId="traj-tool-choice" weight={isTraceOnlyTrajectory ? 0.6364 : 0.35} score={dims.toolChoice} findings={findings.toolChoice} />
                                            <DimensionCard label="冗余" termId="traj-redundancy" weight={isTraceOnlyTrajectory ? 0.3636 : 0.20} score={dims.redundancy} findings={findings.redundancy} />
                                        </div>
                                    );
                                })()}

                                {!isTraceOnlyTrajectory ? (
                                    <TrajectoryCapBanner rawAnalysis={result.rawAnalysis} trajectoryScore={result.trajectoryScore} />
                                ) : null}

                                {shouldShowSkillKeyActions ? (
                                <div style={{ marginTop: 14 }}>
                                    <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 6 }}>
                                        Skill 关键动作
                                    </div>
                                    {(
                                        <div className="efv-root">
                                            <div className="efv-summary">
                                                <span>
                                                    评估器逐条分析 <b>{skillKeyActionCards.length}</b> 个关键动作
                                                </span>
                                                <span className="efv-summary-sep">·</span>
                                                <span>
                                                    分数：{result.trajectoryScore == null ? '—' : `${fmtPercentScore(result.trajectoryScore)} / 100`}
                                                </span>
                                                {skillAttribution ? (
                                                    <>
                                                        <span className="efv-summary-sep">·</span>
                                                        <span>
                                                            Skill 归因：{skillAttribution.state === 'ok'
                                                                ? '已启用'
                                                                : skillAttribution.state === 'degraded'
                                                                ? '降级'
                                                                : '不适用'}
                                                        </span>
                                                    </>
                                                ) : null}
                                            </div>
                                            <div className="efv-group">
                                                <div className="efv-group-head">
                                                    关键动作
                                                    <span className="efv-group-count">{skillKeyActionCards.length}</span>
                                                </div>
                                                {skillKeyActionCards.map((card, index) => (
                                                    <div
                                                        key={`${card.action.id || card.action.content || index}`}
                                                        className={`efv-card${card.severity ? ` sev-${card.severity}` : card.coverage === 'missing' ? ' sev-high' : card.coverage === 'partial' ? ' sev-medium' : ''}`}
                                                    >
                                                        <div className="efv-card-head">
                                                            <span className="efv-title">
                                                                {card.action.content || `关键动作 ${index + 1}`}
                                                            </span>
                                                            <span className={`efv-pill${card.coverage === 'missing' ? ' err' : card.coverage === 'partial' ? ' warn' : ''}`}>
                                                                {card.coverage === 'covered' ? '已覆盖' : card.coverage === 'partial' ? '部分覆盖' : card.coverage === 'not_applicable' ? '不适用' : '未覆盖'}
                                                            </span>
                                                        </div>
                                                        <div className="efv-desc">
                                                            {card.analysis}
                                                        </div>
                                                        <div className="efv-suggestion">
                                                            <span className="efv-suggestion-label">改进建议</span>
                                                            {card.suggestion}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                                ) : null}

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
                                        if (resultId) qs.push(`resultId=${encodeURIComponent(resultId)}`);
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
                                                    分数 {item.score == null ? '--' : `${fmtPercentScore(item.score)} / 100`}
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

function FieldBlock({ label, value, emptyHint }: { label: string; value: string; emptyHint?: string }) {
    const hasValue = Boolean(value.trim());
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
                color: hasValue ? COLORS.textSecondary : COLORS.textMuted,
                minHeight: hasValue ? 18 : 44,
                display: 'flex',
                alignItems: hasValue ? 'initial' : 'center',
            }}>
                {hasValue ? value : (emptyHint || '')}
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

function KeyPointFindingCard({ item, fallbackTitle }: { item: ResultEvaluationFinding; fallbackTitle: string }) {
    const status = item.coverageStatus || (item.covered ? 'covered' : 'missing');
    const severity = item.severity || (status === 'covered' ? 'low' : 'high');
    const tone =
        status === 'covered' ? COLORS.success
        : severity === 'high' || status === 'wrong' ? COLORS.danger
        : severity === 'medium' || status === 'partial' ? COLORS.warning
        : COLORS.textMuted;
    const bg =
        status === 'covered' ? COLORS.successSubtle
        : severity === 'high' || status === 'wrong' ? COLORS.dangerSubtle
        : severity === 'medium' || status === 'partial' ? COLORS.warningSubtle
        : COLORS.bgSoft;
    const scoreText = item.score == null ? '--' : `(${fmtPercentScore(item.score)}/100)`;
    const isCovered = status === 'covered';
    const resultJudgement = buildResultJudgement(item);
    const hasTrace = !isCovered && Boolean(item.traceRootCause?.failureReason || item.traceRootCause?.failureStage || item.traceRootCause?.relatedSteps?.length);
    const hasAttribution = !isCovered && (item.isSkillAttributable === false || item.attributionReason || item.improvementSuggestion);

    return (
        <div style={{
            padding: '10px 12px',
            border: `1px solid ${COLORS.border}`,
            borderRadius: 6,
            background: status === 'covered' ? '#fff' : bg,
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start', marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 650, color: COLORS.textSecondary, lineHeight: 1.45 }}>
                    关键观点：{item.content || fallbackTitle}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <span style={{
                        fontSize: 10,
                        lineHeight: 1,
                        fontWeight: 700,
                        color: tone,
                        fontVariantNumeric: 'tabular-nums',
                    }}>
                        {scoreText}
                    </span>
                    <span style={{ ...badgeStyle(bg, tone, true), fontSize: 9 }}>
                        {coverageStatusLabel(status)}
                    </span>
                </div>
            </div>

            <div style={{ display: 'grid', gap: 6 }}>
                <FindingDetailBlock
                    label="结果判断"
                    value={resultJudgement}
                    tone={isCovered ? 'success' : 'warning'}
                />
                {hasTrace && (
                    <TraceRootCauseBlock rootCause={item.traceRootCause} />
                )}
                {hasAttribution && (
                    <SkillAttributionBlock
                        isSkillAttributable={item.isSkillAttributable}
                        attributionReason={item.attributionReason}
                        improvementSuggestion={item.isSkillAttributable !== false ? item.improvementSuggestion : ''}
                    />
                )}
            </div>
        </div>
    );
}

function buildResultJudgement(item: ResultEvaluationFinding): string {
    const parts = [item.coverageReason, item.missingReason]
        .map(part => String(part || '').trim())
        .filter((part, index, arr) => part && arr.indexOf(part) === index);
    if (parts.length > 0) return parts.join(' ');
    return item.explanation || '评估器未返回结果判断。';
}

function FindingDetailBlock({ label, value, tone }: { label: string; value: string; tone: 'success' | 'warning' }) {
    return (
        <div style={{
            fontSize: 11,
            lineHeight: 1.55,
            color: COLORS.textSecondary,
            padding: '6px 8px',
            background: tone === 'success' ? COLORS.successSubtle : '#fff',
            borderLeft: `2px solid ${tone === 'success' ? COLORS.success : COLORS.warning}`,
            borderRadius: 3,
        }}>
            <span style={{ fontWeight: 650, color: tone === 'success' ? COLORS.success : COLORS.warning, marginRight: 6 }}>{label}</span>
            {value}
        </div>
    );
}

function TraceRootCauseBlock({ rootCause }: { rootCause?: ResultEvaluationFinding['traceRootCause'] }) {
    const steps = rootCause?.relatedSteps || [];
    return (
        <div style={{
            padding: '6px 8px',
            background: '#fff',
            border: `1px solid ${COLORS.borderSoft}`,
            borderRadius: 4,
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 650, color: COLORS.textSecondary }}>问题定位</span>
                {rootCause?.failureStage && (
                    <span style={badgeStyle(COLORS.bgSoft, COLORS.textMuted, true)}>
                        {failureStageLabel(rootCause.failureStage)}
                    </span>
                )}
            </div>
            {rootCause?.failureReason && (
                <div style={{ fontSize: 11, color: COLORS.textSecondary, lineHeight: 1.55, marginBottom: steps.length ? 6 : 0 }}>
                    {rootCause.failureReason}
                </div>
            )}
            {steps.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {steps.map((step, index) => (
                        <div key={index} style={{
                            fontSize: 10.5,
                            color: COLORS.textMuted,
                            lineHeight: 1.45,
                            padding: '4px 6px',
                            background: COLORS.bgSoft,
                            borderRadius: 3,
                        }}>
                            <span style={{ fontWeight: 650, color: COLORS.textSecondary }}>
                                {step.stepIndex != null ? `步骤 #${step.stepIndex}` : `相关步骤 ${index + 1}`}
                                {step.kind ? ` · ${step.kind}` : ''}
                                {step.name ? ` (${step.name})` : ''}
                            </span>
                            {step.evidence ? `：${step.evidence}` : ''}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function SkillAttributionBlock({
    isSkillAttributable,
    attributionReason,
    improvementSuggestion,
}: {
    isSkillAttributable?: boolean;
    attributionReason?: string;
    improvementSuggestion?: string;
}) {
    if (isSkillAttributable === false) {
        return (
            <div style={{
                fontSize: 11,
                lineHeight: 1.55,
                color: COLORS.textSecondary,
                padding: '6px 8px',
                background: COLORS.bgSoft,
                borderLeft: `2px solid ${COLORS.textDisabled}`,
                borderRadius: 3,
            }}>
                <span style={{ fontWeight: 650, color: COLORS.textMuted }}>非 Skill 问题</span>
            </div>
        );
    }

    return (
        <div style={{ display: 'grid', gap: 6 }}>
            {attributionReason && (
                <div style={{
                    fontSize: 11,
                    lineHeight: 1.55,
                    color: COLORS.textSecondary,
                    padding: '6px 8px',
                    background: '#f0f7f4',
                    borderLeft: `2px solid ${COLORS.success}`,
                    borderRadius: 3,
                }}>
                    <span style={{ fontWeight: 650, color: COLORS.success, marginRight: 6 }}>Skill 归因</span>
                    {attributionReason}
                </div>
            )}
            {improvementSuggestion && (
                <div style={{
                    fontSize: 11,
                    lineHeight: 1.55,
                    color: COLORS.textSecondary,
                    padding: '6px 8px',
                    background: '#f0f7f4',
                    borderLeft: `2px solid ${COLORS.success}`,
                    borderRadius: 3,
                }}>
                    <span style={{ fontWeight: 650, color: COLORS.success, marginRight: 6 }}>skill改进建议</span>
                    {improvementSuggestion}
                </div>
            )}
        </div>
    );
}

function coverageStatusLabel(status: NonNullable<ResultEvaluationFinding['coverageStatus']>): string {
    if (status === 'covered') return '已覆盖';
    if (status === 'partial') return '部分覆盖';
    if (status === 'wrong') return '错误覆盖';
    return '未覆盖';
}

function failureStageLabel(stage: NonNullable<NonNullable<ResultEvaluationFinding['traceRootCause']>['failureStage']>): string {
    const labels: Record<NonNullable<NonNullable<ResultEvaluationFinding['traceRootCause']>['failureStage']>, string> = {
        evidence_collection: '证据收集',
        tool_usage: '工具使用',
        reasoning: '推理归纳',
        final_answer: '最终输出',
        model_or_environment: '模型/环境',
        unknown: '无法定位',
    };
    return labels[stage] || stage;
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

function DimensionCard({
    label,
    score,
    findings,
    weight,
    termId,
    notScored,
}: {
    label: string;
    score: number | null | undefined;
    findings?: { type: 'high' | 'medium' | 'low' | 'info'; text: string }[];
    weight?: number;
    termId?: string;
    notScored?: boolean;
}) {
    const [expanded, setExpanded] = useState(false);
    const hasScore = !notScored && typeof score === 'number' && Number.isFinite(score);
    const tone = !hasScore ? COLORS.textMuted : score >= 0.8 ? COLORS.success : score >= 0.5 ? COLORS.warning : COLORS.danger;
    const bg = !hasScore ? COLORS.bgSoft : score >= 0.8 ? COLORS.successSubtle : score >= 0.5 ? COLORS.warningSubtle : COLORS.dangerSubtle;
    const barWidth = hasScore ? Math.round(score * 100) : 0;
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
            <div
                role={hasFindings ? 'button' : undefined}
                onClick={() => hasFindings && setExpanded(v => !v)}
                style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    cursor: hasFindings ? 'pointer' : 'default',
                    width: '100%',
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
                    {termId ? (
                        <span onClick={e => e.stopPropagation()} style={{ display: 'inline-flex', alignItems: 'center' }}>
                            <Term id={termId} render="compact" />
                        </span>
                    ) : null}
                    {notScored ? (
                        <span style={{ color: COLORS.textDisabled, fontSize: 10, fontWeight: 400 }}>
                            不计分
                        </span>
                    ) : typeof weight === 'number' ? (
                        <span style={{ color: COLORS.textDisabled, fontSize: 10, fontWeight: 400 }}>
                            权重 {Math.round(weight * 100)}%
                        </span>
                    ) : null}
                    {hasFindings ? (
                        <span style={{ color: COLORS.textDisabled, fontSize: 10, fontWeight: 400 }}>
                            ({findingCount})
                        </span>
                    ) : null}
                </span>
                <span>
                    {notScored ? (
                        <span style={{ fontSize: 12, fontWeight: 600, color: tone }}>N/A</span>
                    ) : (
                        <>
                            <span style={{ fontSize: 14, fontWeight: 600, color: tone }}>{fmtPercentScore(score)}</span>
                            <span style={{ fontSize: 9, color: COLORS.textDisabled, marginLeft: 2 }}>/100</span>
                        </>
                    )}
                </span>
            </div>
            <div style={{ height: 3, background: bg, borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ width: `${barWidth}%`, height: '100%', background: tone }} />
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

function TrajectoryCapBanner({
    rawAnalysis,
    trajectoryScore,
}: {
    rawAnalysis: unknown;
    trajectoryScore: number | null;
}) {
    const agg = asRecord(asRecord(rawAnalysis).score_aggregation ?? asRecord(rawAnalysis).scoreAggregation);
    if (Object.keys(agg).length === 0) return null;
    if (agg.mode === 'trace_only') return null;

    const rawWeighted = typeof agg.rawWeightedScore === 'number' ? agg.rawWeightedScore : null;
    const finalScore = typeof agg.finalScore === 'number'
        ? agg.finalScore
        : (typeof trajectoryScore === 'number' ? trajectoryScore : null);
    const ceiling = typeof agg.ceiling === 'number' ? agg.ceiling : null;
    const triggered = agg.triggered === true;
    const effective = agg.effective === true;
    const highCount = typeof agg.highCount === 'number' ? agg.highCount : 0;
    const mediumCount = typeof agg.mediumCount === 'number' ? agg.mediumCount : 0;
    const reason = typeof agg.reason === 'string' ? agg.reason : '';

    const accent = effective ? COLORS.danger : triggered ? COLORS.warning : COLORS.success;
    const bg = effective ? COLORS.dangerSubtle : triggered ? COLORS.warningSubtle : COLORS.successSubtle;

    return (
        <div style={{
            border: `1px solid ${COLORS.border}`,
            borderLeft: `3px solid ${accent}`,
            borderRadius: 6,
            background: bg,
            padding: '10px 12px',
            marginBottom: 12,
            fontSize: 12,
            lineHeight: 1.6,
            color: COLORS.textSecondary,
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontWeight: 600, color: accent }}>
                    {effective ? '已封顶' : triggered ? '触发封顶规则（未压低）' : '未封顶'}
                </span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 11, color: COLORS.textMuted }}>
                    加权分 {rawWeighted != null ? fmtPercentScore(rawWeighted) : '--'}
                    {' → '}
                    <b style={{ color: accent }}>{finalScore != null ? fmtPercentScore(finalScore) : '--'}</b>
                    {' / 100'}
                    {ceiling != null ? `（上限 ${fmtPercentScore(ceiling)}）` : ''}
                </span>
            </div>
            <div style={{ fontSize: 11.5, color: COLORS.textSecondary }}>
                {reason || '无封顶：无 high 偏差且 medium 偏差少于 3 个。'}
            </div>
            <div style={{ marginTop: 4, fontSize: 10.5, color: COLORS.textMuted }}>
                严重度：high {highCount} · medium {mediumCount}
                {' · 规则：≥1 个 high → 封顶 40.0；无 high 但 ≥3 个 medium → 封顶 65.0'}
            </div>
        </div>
    );
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function extractStepInfo(raw: unknown): {
    text: string;
    severity: unknown;
    idx: unknown;
    name: unknown;
} {
    if (typeof raw === 'string') {
        return { text: raw.trim(), severity: undefined, idx: undefined, name: undefined };
    }
    const m = asRecord(raw);
    const text = String(
        m.description ?? m.desc ?? m.issue ?? m.step ?? m.action
        ?? m.detail ?? m.text ?? m.reason ?? m.note ?? m.name ?? '',
    ).trim();
    return { text, severity: m.severity, idx: m.step_index ?? m.stepIndex, name: m.name };
}

function resolveDimensionScores(
    dimensionScores: DimensionScores | null | undefined,
    rawAnalysis: unknown,
): { completeness: number | null; toolChoice: number | null; redundancy: number | null } {
    const root = asRecord(rawAnalysis);
    const rawDimScores = asRecord(root.dimension_scores ?? root.dimensionScores);
    const details = asRecord(root.dimension_details ?? root.dimensionDetails);
    const num = (v: unknown): number | null => {
        if (v == null) return null;
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(n) ? n : null;
    };
    const pick = (colVal: number | null | undefined, rawKey: string, detailKey: string, detailScoreKey = 'score'): number | null => {
        const fromCol = num(colVal);
        if (fromCol != null) return fromCol;
        const fromRaw = num(rawDimScores[rawKey] ?? rawDimScores[detailKey]);
        if (fromRaw != null) return fromRaw;
        const d = asRecord(details[detailKey]);
        return num(d[detailScoreKey] ?? d.score);
    };
    return {
        completeness: pick(dimensionScores?.completeness, 'completeness', 'completeness'),
        toolChoice: pick(dimensionScores?.toolChoice, 'tool_choice', 'tool_choice'),
        redundancy: pick(dimensionScores?.redundancy, 'redundancy', 'redundancy', 'redundancy_score'),
    };
}

function deriveDimensionFindings(rawAnalysis: unknown): {
    completeness: { type: 'high' | 'medium' | 'low' | 'info'; text: string }[];
    toolChoice: { type: 'high' | 'medium' | 'low' | 'info'; text: string }[];
    redundancy: { type: 'high' | 'medium' | 'low' | 'info'; text: string }[];
} {
    const root = asRecord(rawAnalysis);
    const details = asRecord(root.dimension_details ?? root.dimensionDetails);
    const sev = (s: unknown): 'high' | 'medium' | 'low' | 'info' => {
        const v = String(s || '').toLowerCase();
        if (v === 'high') return 'high';
        if (v === 'low') return 'low';
        if (v === 'info') return 'info';
        return 'medium';
    };

    const completeness: { type: ReturnType<typeof sev>; text: string }[] = [];
    const cmpt = asRecord(details.completeness);
    for (const raw of (Array.isArray(cmpt.missing_steps) ? cmpt.missing_steps : [])) {
        const { text, severity } = extractStepInfo(raw);
        completeness.push({ type: sev(severity), text: `缺失：${text || '(未给描述)'}` });
    }
    for (const raw of (Array.isArray(cmpt.extra_steps) ? cmpt.extra_steps : [])) {
        const { text, severity, idx } = extractStepInfo(raw);
        completeness.push({ type: sev(severity), text: `多余${idx != null ? `（#${idx}）` : ''}：${text || '(未给描述)'}` });
    }
    if (completeness.length === 0 && cmpt.explanation) {
        completeness.push({ type: 'info', text: String(cmpt.explanation) });
    }

    const toolChoice: { type: ReturnType<typeof sev>; text: string }[] = [];
    const tc = asRecord(details.tool_choice ?? details.toolChoice);
    for (const raw of (Array.isArray(tc.problematic_steps) ? tc.problematic_steps : [])) {
        const { text, severity, idx, name } = extractStepInfo(raw);
        const nm = name ? ` ${name}` : '';
        toolChoice.push({ type: sev(severity), text: `#${idx ?? '?'}${nm}：${text || '(未给原因)'}` });
    }
    if (toolChoice.length === 0 && tc.explanation) {
        toolChoice.push({ type: 'info', text: String(tc.explanation) });
    }

    const redundancy: { type: ReturnType<typeof sev>; text: string }[] = [];
    const rd = asRecord(details.redundancy);
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
    if (redundancy.length === 0 && rd.explanation) {
        redundancy.push({ type: 'info', text: String(rd.explanation) });
    }

    return { completeness, toolChoice, redundancy };
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
