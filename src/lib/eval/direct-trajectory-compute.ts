/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { resolveFrozenCustomEvaluator } from '@/lib/evaluators/evaluator-skill-service';
import type {PrismaClient} from '@prisma/client';
import type {FrozenExperimentWork} from '@/lib/storage-core/experiment-worker';
import {withFrozenSkillCatalog,type FrozenSkillRecord} from './frozen-skill-catalog';
import {createDirectTrajectoryDraft} from './direct-trajectory-draft';
import {deriveOptPointArtifacts} from '@/lib/engine/evaluation/derive-skill-opt-points';
import {
    type AgentDatasetRecord,
    type DatasetCase,
} from '@/server/agent_datasets_storage';
import { canReuseRootCauseCache, type RootCauseItem } from '@/lib/dataset-case-root-causes';
import {
    evaluateTrajectoryViaOpencode,
    TrajectoryEvalConfigError,
    type TrajectoryEvalInput,
} from '@/lib/engine/evaluation/opencode-trajectory-evaluator';
import {
    evaluateTaskCompletionViaOpencode,
    type TaskCompletionEvalInput,
} from '@/lib/engine/evaluation/opencode-task-completion-evaluator';
import { startOrReplace as startEvalTask, finish as finishEvalTask } from '@/lib/evaluation-task-manager';
import {
    runSkillSuggestionAgent,
    shouldRunSuggestionAgent,
    type SkillSuggestion,
} from '@/lib/engine/evaluation/skill-suggestion-agent';
import {
    NO_EVALUABLE_CASE_PREFIX,
    isRetryableResultEvaluationFailure,
    createSimpleAsyncLimiter,
    type SimpleAsyncLimiter,
} from '@/lib/engine/evaluation/eval-run-guards';
import {
    buildSkillKeyActionReference,
    getPrimaryExecutionSkillTargets,
    loadTaskCompletionSkillContext,
} from '@/lib/engine/evaluation/key-action-trace-analysis';
import { extractRealUserInput, findBestSemanticCaseMatch } from '@/lib/engine/evaluation/semantic-dataset-match';
import { matchAgentDatasetCase } from '@/lib/engine/evaluation/dataset-case-match';
import { extractTaskResultArtifact } from '@/lib/engine/evaluation/result-artifact-extractor';
import { parseLooseJson } from '@/lib/engine/evaluation/task-completion-json';
import {
    extractTrajectoryTaskMeta,
    normalizeTrajectoryTaskMeta,
} from '@/lib/eval/trajectory-task-meta';
import {
    buildEvaluationDiagnostic,
    type EvaluationDiagnostic,
} from '@/lib/eval/trajectory-diagnostic';
import {
    isCustomEvaluatorId,
    runCustomLlmEvaluator,
} from '@/lib/engine/evaluation/custom-llm-evaluator';
import { summarizeTrace, formatTraceForLLM } from '@/lib/engine/evaluation/trace-summarizer';
import {
    buildSkillAttributionStatus,
    type SkillKeyActionComparisonResult,
} from '@/lib/engine/evaluation/skill-attribution';
import {
    normalizeAutoWatchEnabledAt,
} from '@/lib/engine/evaluation/trajectory-auto-watch-helper';



interface GrayscaleBinding {
    source: 'grayscale-ab';
    grayscaleTaskId: string;
    caseId: string;
    side: 'a' | 'b';
    runIndex: number;
    roundIndex: number;
    executionTraceId: string;
    evaluationClaimId: string;
    evaluationAttempt: number;
}

const SUPPORTED_TRAJECTORY_EVALUATORS = new Set([
    'trace-quality-evaluator',
    'preset-agent-trace-quality',
    'preset-agent-task-completion',
]);

const TRACE_EVALUATOR_ID = 'preset-agent-trace-quality';
const TASK_COMPLETION_EVALUATOR_ID = 'preset-agent-task-completion';
const MAX_RESULT_EVALUATION_ATTEMPTS = 5;
const RESULT_EVALUATION_RETRY_DELAYS_MS = [1500, 3000, 5000, 8000];
const EVALUATOR_LABELS: Record<string, string> = {
    [TRACE_EVALUATOR_ID]: 'Agent 轨迹质量',
    [TASK_COMPLETION_EVALUATOR_ID]: 'Agent 任务完成度',
};

const CUSTOM_EVALUATOR_VARIABLE_RE = /\{\{\s*(input|dataset_input|output|reference_output|trajectory)\s*\}\}/g;
type CustomEvaluatorVariable = 'input' | 'dataset_input' | 'output' | 'reference_output' | 'trajectory';

function normalizeMatchText(value: string | null | undefined): string {
    return String(value || '').trim().replace(/\s+/g, ' ');
}

function buildTrajectoryTraceEvidence(interactions: TrajectoryEvalInput['actualInteractions']) {
    const summary = summarizeTrace(interactions, { maxSteps: 80, maxTextLen: 400 });
    return {
        summary,
        text: formatTraceForLLM(summary),
        steps: summary.steps.map(step => ({
            ...step,
            step_index: step.index,
            stepIndex: step.index,
        })),
    };
}

function collectCustomEvaluatorVariables(prompts: string[]): Set<CustomEvaluatorVariable> {
    const vars = new Set<CustomEvaluatorVariable>();
    for (const prompt of prompts) {
        let match: RegExpExecArray | null;
        CUSTOM_EVALUATOR_VARIABLE_RE.lastIndex = 0;
        while ((match = CUSTOM_EVALUATOR_VARIABLE_RE.exec(prompt || '')) !== null) {
            vars.add(match[1] as CustomEvaluatorVariable);
        }
    }
    return vars;
}

interface ResultJudgment {
    isCorrect: boolean;
    score: number;
    reason: string;
    rawAnalysis?: Record<string, unknown>;
}

interface MatchedDatasetCase {
    dataset: AgentDatasetRecord;
    caseEntry: DatasetCase;
}

interface ResultEvaluationRetryState {
    attemptCount: number;
    maxAttempts: number;
    retrying: boolean;
    exhausted: boolean;
    lastAttemptAt: string;
    nextRetryAt?: string;
    lastError?: string;
}

interface SelectedEvaluatorMeta {
    selectedEvaluators: string[];
    selectedEvaluatorNames: string[];
    autoWatch?: boolean;
    watchedAgent?: string;
    autoWatchEnabledAt?: string;
}

function normalizeSelectedEvaluators(value: unknown): string[] {
    const rawItems = Array.isArray(value)
        ? value
        : value == null
        ? []
        : [value];

    // 自建评估器 (id 形如 `custom-<ts>`) 也放行；后端真正校验是否存在交给 POST
    // 处理函数（需要 user 才能查 CustomEvaluatorList，这里只做 sync 形态过滤）。
    const normalized = rawItems
        .map(item => String(item || '').trim())
        .map(item => item === 'trace-quality-evaluator' ? TRACE_EVALUATOR_ID : item)
        .filter(item => SUPPORTED_TRAJECTORY_EVALUATORS.has(item) || isCustomEvaluatorId(item));

    return Array.from(new Set(normalized));
}

function buildSelectedEvaluatorMeta(
    selectedEvaluators: string[],
    options: {
        autoWatch?: boolean;
        watchedAgent?: string;
        autoWatchEnabledAt?: string;
        customNameResolver?: (id: string) => string | undefined;
    } = {},
): SelectedEvaluatorMeta {
    const resolveName = (id: string): string => {
        const preset = EVALUATOR_LABELS[id];
        if (preset) return preset;
        const custom = options.customNameResolver?.(id);
        if (custom) return custom;
        return id;
    };
    return {
        selectedEvaluators,
        selectedEvaluatorNames: selectedEvaluators.map(resolveName),
        ...(options.autoWatch ? { autoWatch: true } : {}),
        ...(options.watchedAgent ? { watchedAgent: options.watchedAgent } : {}),
        ...(options.autoWatch && options.autoWatchEnabledAt ? { autoWatchEnabledAt: options.autoWatchEnabledAt } : {}),
    };
}

function readSelectedEvaluatorMeta(rawAnalysisJson: string | null | undefined): SelectedEvaluatorMeta {
    const parsed = rawAnalysisJson ? parseLooseJson(rawAnalysisJson) : null;
    const selectedEvaluators = normalizeSelectedEvaluators(parsed?.selectedEvaluators);
    const selectedEvaluatorNames = Array.isArray(parsed?.selectedEvaluatorNames)
        ? parsed.selectedEvaluatorNames.filter((name): name is string => typeof name === 'string' && !!name.trim())
        : [];
    const autoWatch = parsed?.autoWatch === true;
    const watchedAgent = typeof parsed?.watchedAgent === 'string'
        ? parsed.watchedAgent.trim()
        : '';
    const autoWatchEnabledAt = normalizeAutoWatchEnabledAt(parsed?.autoWatchEnabledAt);
    if (selectedEvaluators.length > 0) {
        if (selectedEvaluatorNames.length === selectedEvaluators.length) {
            return {
                selectedEvaluators,
                selectedEvaluatorNames,
                ...(autoWatch ? { autoWatch: true } : {}),
                ...(watchedAgent ? { watchedAgent } : {}),
                ...(autoWatch && autoWatchEnabledAt ? { autoWatchEnabledAt } : {}),
            };
        }
        return buildSelectedEvaluatorMeta(selectedEvaluators, { autoWatch, watchedAgent, autoWatchEnabledAt });
    }
    return buildSelectedEvaluatorMeta([TRACE_EVALUATOR_ID], { autoWatch, watchedAgent, autoWatchEnabledAt });
}

function safeParseRecord(text: string | null | undefined): Record<string, unknown> {
    const parsed = parseLooseJson(text || '');
    return parsed && typeof parsed === 'object' ? parsed : {};
}

function mergeDiagnosticIntoRawAnalysis(
    rawAnalysisJson: string | null | undefined,
    diagnostic: EvaluationDiagnostic,
    extra: Record<string, unknown> = {},
): string {
    return JSON.stringify({
        ...safeParseRecord(rawAnalysisJson),
        ...extra,
        diagnostic,
    });
}

function normalizeGrayscaleBinding(value: unknown): GrayscaleBinding | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const source = String(raw.source || '').trim();
    const grayscaleTaskId = String(raw.grayscaleTaskId || '').trim();
    const caseId = String(raw.caseId || '').trim();
    const side = String(raw.side || '').trim();
    const executionTraceId = String(raw.executionTraceId || '').trim();
    const evaluationClaimId = String(raw.evaluationClaimId || '').trim();
    const runIndex = typeof raw.runIndex === 'number' && Number.isFinite(raw.runIndex)
        ? Math.floor(raw.runIndex)
        : Number.NaN;
    const roundIndex = typeof raw.roundIndex === 'number' && Number.isFinite(raw.roundIndex)
        ? Math.floor(raw.roundIndex)
        : Number.NaN;
    const evaluationAttempt = typeof raw.evaluationAttempt === 'number' && Number.isFinite(raw.evaluationAttempt)
        ? Math.floor(raw.evaluationAttempt)
        : Number.NaN;
    if (
        source !== 'grayscale-ab'
        || !grayscaleTaskId
        || !caseId
        || (side !== 'a' && side !== 'b')
        || !executionTraceId
        || !evaluationClaimId
        || !Number.isFinite(runIndex)
        || !Number.isFinite(roundIndex)
        || !Number.isFinite(evaluationAttempt)
    ) {
        return null;
    }
    return {
        source: 'grayscale-ab',
        grayscaleTaskId,
        caseId,
        side: side as 'a' | 'b',
        runIndex,
        roundIndex,
        executionTraceId,
        evaluationClaimId,
        evaluationAttempt,
    };
}

function readGrayscaleBinding(rawAnalysisJson: string | null | undefined): GrayscaleBinding | null {
    const parsed = safeParseRecord(rawAnalysisJson);
    return normalizeGrayscaleBinding(parsed.grayscaleBinding);
}

async function evaluateTaskCompletionAgainstExpected(
    caseInput: string,
    expectedOutput: string,
    actualOutput: string,
    precomputedRootCauses?: RootCauseItem[],
    precomputedRootCauseSource?: 'dataset-cache' | 'none',
    onLiveRootCausesExtracted?: TaskCompletionEvalInput['onLiveRootCausesExtracted'],
    traceSummaryText?: string,
    skillContext?: TaskCompletionEvalInput['skillContext'],
    skillAttributionMode?: TaskCompletionEvalInput['skillAttributionMode'],
    user?: string | null,
    skillName?: string | null,
    skillVersion?: number | null,
): Promise<ResultJudgment> {
    const result = await evaluateTaskCompletionViaOpencode(
        {
            caseInput,
            expectedOutput,
            actualOutput,
            precomputedRootCauses,
            precomputedRootCauseSource,
            onLiveRootCausesExtracted,
            traceSummaryText,
            skillContext,
            skillAttributionMode,
        },
        user,
        skillName,
        skillVersion,
    );
    return {
        isCorrect: result.isCorrect,
        score: result.score,
        reason: result.reason,
        rawAnalysis: result.rawAnalysis,
    };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, error: Error): Promise<T> {
    let timer:ReturnType<typeof setTimeout>|undefined;
    return Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(error),timeoutMs);})]).finally(()=>{if(timer)clearTimeout(timer);});
}

function getResultEvaluationRetryDelayMs(attemptCount: number): number {
    return RESULT_EVALUATION_RETRY_DELAYS_MS[Math.max(0, attemptCount - 1)]
        ?? RESULT_EVALUATION_RETRY_DELAYS_MS[RESULT_EVALUATION_RETRY_DELAYS_MS.length - 1]
        ?? 8000;
}

function buildResultEvaluationRetryState(
    attemptCount: number,
    options: {
        retrying: boolean;
        exhausted: boolean;
        lastError?: string;
        delayMs?: number;
        now?: Date;
    },
): ResultEvaluationRetryState {
    const now = options.now ?? new Date();
    return {
        attemptCount,
        maxAttempts: MAX_RESULT_EVALUATION_ATTEMPTS,
        retrying: options.retrying,
        exhausted: options.exhausted,
        lastAttemptAt: now.toISOString(),
        ...(options.lastError ? { lastError: options.lastError } : {}),
        ...(options.retrying && options.delayMs
            ? { nextRetryAt: new Date(now.getTime() + options.delayMs).toISOString() }
            : {}),
    };
}

function readResultEvaluationAttemptCount(rawAnalysisJson: string | null | undefined): number {
    const parsed = safeParseRecord(rawAnalysisJson);
    const retry = parsed.resultEvaluationRetry;
    if (!retry || typeof retry !== 'object') return 0;
    const value = (retry as { attemptCount?: unknown }).attemptCount;
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : 0;
}


async function findMatchingDatasetCaseForTrace(
    user: string,
    traceQuery: string,
    options: {
        requireExpectedOutput?: boolean;
        includeAllDatasetKinds?: boolean;
        allowedDatasetIds?: string[];
        allowSemanticMatch?: boolean;
        datasets?: AgentDatasetRecord[];
    } = {},
): Promise<MatchedDatasetCase> {
    const result = await matchAgentDatasetCase({
        user,
        traceQuery,
        datasets: options.datasets,
        requireExpectedOutput: options.requireExpectedOutput,
        includeAllDatasetKinds: options.includeAllDatasetKinds,
        allowedDatasetIds: options.allowedDatasetIds,
        allowSemanticMatch: options.allowSemanticMatch,
    });
    if (result.reason === 'empty-input') {
        throw new StagedEvaluationError(
            'no-evaluable-case',
            `${NO_EVALUABLE_CASE_PREFIX} trace 没有实际输入，无法匹配评估数据集 case`,
        );
    }
    if (result.reason === 'no-datasets') {
        throw new StagedEvaluationError(
            'no-evaluable-case',
            `${NO_EVALUABLE_CASE_PREFIX} ${options.includeAllDatasetKinds ? '未找到可用于评测的数据集' : options.requireExpectedOutput ? '未找到可用于结果评测的数据集' : '未找到轨迹评测数据集'}`,
        );
    }
    if (result.error) {
        throw new StagedEvaluationError(
            'semantic-match-llm',
            `${NO_EVALUABLE_CASE_PREFIX} 语义匹配调用评测模型失败：${result.error}`,
        );
    }
    if (result.match) return result.match;

    throw new StagedEvaluationError(
        'no-evaluable-case',
        `${NO_EVALUABLE_CASE_PREFIX} trace 实际输入未匹配到${options.includeAllDatasetKinds ? '评测数据集中的' : options.requireExpectedOutput ? '带预期结果的' : '轨迹评测数据集中的'} case 输入`,
    );
}

const EVAL_ROW_CONCURRENCY = (() => {
    const raw = Number(process.env.MAX_EVAL_ROW_CONCURRENCY);
    return Number.isFinite(raw) && raw > 0 ? Math.min(20, Math.floor(raw)) : 4;
})();
/** 用 globalThis 存,跨 Next 模块重载/HMR 仍是同一个 limiter(否则会出现多份、上限失效)。 */
const EVAL_ROW_LIMITER_KEY = Symbol.for('@witty-insight/trajectory-eval-row-limiter');
function getEvalRowLimiter(): SimpleAsyncLimiter {
    const g = globalThis as unknown as Record<symbol, SimpleAsyncLimiter>;
    if (!g[EVAL_ROW_LIMITER_KEY]) {
        g[EVAL_ROW_LIMITER_KEY] = createSimpleAsyncLimiter(EVAL_ROW_CONCURRENCY);
    }
    return g[EVAL_ROW_LIMITER_KEY];
}
/** 单条 trace 评测的硬超时（ms）。超过则自动标 failed。 */
const PER_RESULT_TIMEOUT_MS = 10 * 60 * 1000;

class StagedEvaluationError extends Error {
    constructor(public stage: string, message: string, public cause?: unknown) {
        super(`[${stage}] ${message}`);
        this.name = 'StagedEvaluationError';
    }
}

function buildDiagnosticFromError(error: unknown): EvaluationDiagnostic {
    const stage = error instanceof StagedEvaluationError ? error.stage : 'unknown';
    const message = error instanceof Error ? error.message : String(error || 'unknown error');
    const cleanMessage = message.replace(/^\[[^\]]+\]\s*/, '').replace(NO_EVALUABLE_CASE_PREFIX, '').trim();
    const includes = (needle: string) => cleanMessage.includes(needle);

    if (stage === 'trace-parse') {
        return buildEvaluationDiagnostic('trace_parse_failed', { details: cleanMessage, reason: cleanMessage });
    }
    if (stage === 'trace-empty') {
        return buildEvaluationDiagnostic('trace_data_empty', { details: cleanMessage, reason: cleanMessage });
    }
    if (stage === 'semantic-match-llm' || stage === 'dataset-auto-match') {
        return buildEvaluationDiagnostic('case_match_failed', {
            details: cleanMessage,
            internal: {
                stage: 'semantic_match',
                reason: cleanMessage,
            },
        });
    }
    if (stage === 'result-artifact-timeout' || stage === 'result-timeout' || stage === 'timeout') {
        return buildEvaluationDiagnostic('evaluator_timeout', { details: cleanMessage, reason: cleanMessage });
    }
    if (stage === 'persist') {
        return buildEvaluationDiagnostic('persist_failed', { details: cleanMessage, reason: cleanMessage });
    }
    if (stage === 'llm-or-agent' || stage === 'config') {
        return buildEvaluationDiagnostic('evaluator_output_invalid', { details: cleanMessage, reason: cleanMessage });
    }
    if (stage === 'no-evaluable-case') {
        if (includes('没有实际输入')) {
            return buildEvaluationDiagnostic('trace_missing_input', { details: cleanMessage, reason: cleanMessage });
        }
        if (includes('评估数据集不存在')) {
            return buildEvaluationDiagnostic('dataset_missing', { details: cleanMessage, reason: cleanMessage });
        }
        if (includes('未找到可用于评测的数据集') || includes('未找到可用于结果评测的数据集') || includes('未找到轨迹评测数据集')) {
            return buildEvaluationDiagnostic('dataset_empty', { details: cleanMessage, reason: cleanMessage });
        }
        if (includes('reference_output')) {
            return buildEvaluationDiagnostic('custom_reference_missing', { details: cleanMessage, reason: cleanMessage });
        }
        if (includes('expectedOutput') || includes('预期结果')) {
            return buildEvaluationDiagnostic('case_missing_expected_output', { details: cleanMessage, reason: cleanMessage });
        }
        if (includes('动态分析失败')) {
            return buildEvaluationDiagnostic('trace_step_analysis_failed', { details: cleanMessage, reason: cleanMessage });
        }
        if (includes('无法提取可评测步骤') || includes('提取出实际执行步骤') || includes('无可提取执行步骤')) {
            return buildEvaluationDiagnostic('trace_no_steps', { details: cleanMessage, reason: cleanMessage });
        }
        return buildEvaluationDiagnostic('case_not_matched', { details: cleanMessage, reason: cleanMessage });
    }
    return buildEvaluationDiagnostic('evaluator_recovered_failed', { details: cleanMessage, reason: cleanMessage });
}

async function runOneEvaluationInner(user: string, id: string, prisma: PrismaClient, frozenDatasets: AgentDatasetRecord[], signal: AbortSignal): Promise<void> {
 signal.throwIfAborted();
 // 注册到 evaluation-task-manager 的 activeTasks 内存表 —— 让 GET /api/observe/data 的
 // is_evaluating 字段在轮询时对这条 trace 返 true,前端"已评测历史"列表立刻显示"评测中",
 // 不会再卡在老评测结果不刷新。
 // (之前 bug: runOneEvaluation 只改 DB.status='running',没注册内存表,前端 isActive()
 //  查内存表始终 false → trace 状态不刷新。)
 // 在最早能拿到 taskId 的时机就 startOrReplace, 保证用户点"再次评测"后下次轮询(3s 内)
 // 就能看到状态变化。
 let registeredTaskId: string | null = null;
 let registeredRunId: string | null = null;
 try {
    // ---- 0. 标 running ----
    await prisma.trajectoryEvalResult.update({
        where: { id },
        data: { status: 'running', errorMessage: null },
    });

    // ---- 1. 加载行 + case + interactions ----
    const row = await prisma.trajectoryEvalResult.findUnique({ where: { id } });
    if (!row) throw new StagedEvaluationError('lookup', `result row ${id} disappeared`);
    // 「终止」关键检查点:该评测 run 已被用户终止 → 本行不跑任何评测器、直接置失败(已终止)。
    // 这也挡住了"终止后重试/排队的行再去派发重型 opencode"——重试会重新进到这里、被这里拦下。
    if (signal.aborted) {
        await prisma.trajectoryEvalResult
            .update({ where: { id }, data: { status: 'failed', errorMessage: '已终止：用户中止了该批次评测' } })
            .catch(() => { /* row 可能已被清理,忽略 */ });
        return;
    }
    // 注册 isActive: 必须在 row 加载后才有 taskId, 但要尽早调以缩短"用户点评测" → "isActive=true"的窗口
    if (row.taskId) {
        registeredTaskId = row.taskId;
        const r = startEvalTask(user, row.taskId, 'rejudge');
        registeredRunId = r.runId;
    }
    // 反查关联的 execution 拿到 skill + skillVersion,后面传给 evaluator → limiter,
    // 让"后台分析任务"面板能按 skill 严格过滤。row 自己没存 skill 字段, 要通过 execution 关联。
    // 关键: 大部分 row 的 executionId 是 null (历史数据/ingest 路径没回填),所以必须 fallback
    // 用 row.taskId 反查 execution.taskId; 实测 99% 的 row 通过 taskId 都能找到对应 execution。
    let linkedExecution: { skill: string | null; skillVersion: number | null } | null = null;
    if (row.executionId) {
        linkedExecution = await prisma.execution.findUnique({
            where: { id: row.executionId },
            select: { skill: true, skillVersion: true },
        }).catch(() => null);
    }
    if (!linkedExecution && row.taskId) {
        linkedExecution = await prisma.execution.findFirst({
            where: { taskId: row.taskId },
            orderBy: { timestamp: 'desc' },
            select: { skill: true, skillVersion: true },
        }).catch(() => null);
    }
    const evalSkillName: string | null = linkedExecution?.skill || null;
    const evalSkillVersion: number | null = typeof linkedExecution?.skillVersion === 'number'
        ? linkedExecution.skillVersion
        : null;
    const evaluatorMeta = readSelectedEvaluatorMeta(row.rawAnalysisJson);
    const taskMeta = extractTrajectoryTaskMeta(row.rawAnalysisJson, row.createdAt);
    const grayscaleBinding = readGrayscaleBinding(row.rawAnalysisJson);
    const shouldRunTraceEvaluation = evaluatorMeta.selectedEvaluators.includes(TRACE_EVALUATOR_ID);
    const shouldRunResultEvaluation = evaluatorMeta.selectedEvaluators.includes(TASK_COMPLETION_EVALUATOR_ID);
    const customEvaluatorIds = evaluatorMeta.selectedEvaluators.filter(isCustomEvaluatorId);
    const hasCustomEvaluators = customEvaluatorIds.length > 0;
    let resultEvaluationRawAnalysis: Record<string, unknown> | null = null;
    let resultEvaluationError: string | null = null;
    let resultEvaluationRetryState: ResultEvaluationRetryState | null = null;
    let scheduledResultRetryDelayMs: number | null = null;
    let scheduledResultRetryAttemptCount = 0;
    let resultArtifactExtractionRawAnalysis: Record<string, unknown> | null = null;
    let resultActualOutput = '';
    let finalDiagnostic: EvaluationDiagnostic | null = null;
    let customEvaluationsRawAnalysis: Record<string, unknown> | null = null;
    const customEvaluatorScores: number[] = [];
    let customSkillError: string | null = null;
    const frozenRunSnapshot = safeParseRecord(row.rawAnalysisJson);
    const customEvaluatorBundles = hasCustomEvaluators
        ? await Promise.all(
            customEvaluatorIds.map(async evaluatorId => ({
                evaluatorId,
                bundle: await resolveFrozenCustomEvaluator(user, evaluatorId, frozenRunSnapshot).then(card => card?.llmConfig ? { id: card.id, name: card.name, config: card.llmConfig, card } : null),
            })),
        )
        : [];
    const requestedCustomVars = collectCustomEvaluatorVariables(
        customEvaluatorBundles
            .flatMap(item => [
                item.bundle?.config.systemPrompt || '',
                item.bundle?.config.userPrompt || '',
            ])
            .filter(Boolean),
    );
    const customVarsByEvaluator = new Map(
        customEvaluatorBundles.map(item => [
            item.evaluatorId,
            collectCustomEvaluatorVariables([
                item.bundle?.config.systemPrompt || '',
                item.bundle?.config.userPrompt || '',
            ]),
        ]),
    );
    const needsCustomReferenceOutput = requestedCustomVars.has('reference_output');
    const needsCustomDatasetInput = requestedCustomVars.has('dataset_input');
    const hasSkillEvaluators = customEvaluatorBundles.some(item => item.bundle?.config.skills?.length);
    const needsCustomOutput = requestedCustomVars.has('output') || hasSkillEvaluators;
    const needsCustomTrajectory = requestedCustomVars.has('trajectory') || hasSkillEvaluators;

    // 先解析 taskId 和执行记录，用于匹配数据集 case
    let resolvedTaskId = row.taskId;
    let execution = row.executionId
        ? await prisma.execution.findUnique({ where: { id: row.executionId } })
        : null;
    if (!resolvedTaskId && row.executionId) {
        if (execution?.taskId) resolvedTaskId = execution.taskId;
    }
    if (!execution && resolvedTaskId) {
        execution = await prisma.execution.findFirst({ where: { taskId: resolvedTaskId } });
    }
    const rawTraceQuery = execution?.query || '';
    const extractedTraceInput = await extractRealUserInput(rawTraceQuery, user);
    const traceQuery = extractedTraceInput.normalized_input.trim() || rawTraceQuery;
    const fallbackFinalResult = String(execution?.finalResult || '').trim();
    // 用户在用例分析配置区选的参考数据集 (创建 row 时写入 rawAnalysisJson)；收窄下面的 trace↔case 自动匹配。
    const rowAllowedDatasetIds = (() => {
        const parsed = safeParseRecord(row.rawAnalysisJson) as { allowedDatasetIds?: unknown };
        return Array.isArray(parsed?.allowedDatasetIds)
            ? parsed.allowedDatasetIds.map(v => String(v).trim()).filter(Boolean)
            : [];
    })();

    await prisma.trajectoryEvalResult.update({
        where: { id },
        data: {
            rawAnalysisJson: JSON.stringify({
                ...safeParseRecord(row.rawAnalysisJson),
                ...evaluatorMeta,
                taskMeta,
                caseSnapshot: {
                    taskInput: traceQuery,
                    rawTaskInput: rawTraceQuery,
                    taskInputExtraction: extractedTraceInput,
                },
            }),
        },
    });

    let interactions: TrajectoryEvalInput['actualInteractions'] = [];
    if (resolvedTaskId) {
        const session = await prisma.session.findUnique({ where: { taskId: resolvedTaskId } });
        if (session?.interactions) {
            try {
                const parsed = JSON.parse(session.interactions);
                interactions = Array.isArray(parsed) ? parsed : [];
            } catch (e) {
                throw new StagedEvaluationError('trace-parse', `Session.interactions JSON 解析失败: ${(e as Error).message}`, e);
            }
        }
    }
    if (interactions.length === 0 && (traceQuery || fallbackFinalResult)) {
        const timestamp = new Date().toISOString();
        interactions = [
            ...(traceQuery ? [{ role: 'user', content: traceQuery, timestamp }] : []),
            ...(fallbackFinalResult ? [{ role: 'assistant', content: fallbackFinalResult, timestamp }] : []),
        ] as TrajectoryEvalInput['actualInteractions'];
    }
    let caseEntry: {
        id?: string;
        input: string;
        expectedOutput: string;
        trajectory: string;
        evaluationFocus: string;
        rootCauses?: RootCauseItem[];
        rootCauseMeta?: DatasetCase['rootCauseMeta'];
    } | null = null;
    // 记录 case 匹配的来源信息——给结果分析 UI 展示"这条 trace 是用哪条 case 比对的"
    // matchKind 取值：
    //   'explicit-pair' 用户显式传 datasetId+caseId
    //   'exact-input'   后端按 input 文本完全匹配到的
    //   'semantic'      LLM 语义匹配到的（dataset 已知，case 通过 findBestSemanticCaseMatch）
    //   'auto-match'    findMatchingDatasetCaseForTrace 自动找 dataset+case
    //   'no-dataset'    没有可用数据集，使用空 case（仅 skill key actions / 纯轨迹质量）
    //   'fallback'      auto-match 失败但允许 fallback
    let matchedDatasetMeta: { id: string; name: string } | null = null;
    let matchKind: 'explicit-pair' | 'exact-input' | 'semantic' | 'auto-match' | 'no-dataset' | 'fallback' = 'no-dataset';
    if (row.datasetId && row.caseId) {
        try {
            const frozen = safeParseRecord(row.rawAnalysisJson).frozenTraceDataset as { id: string; name: string; cases: DatasetCase[] } | undefined;
            const dataset = frozen?.id === row.datasetId ? frozen : frozenDatasets.find(dataset => dataset.id === row.datasetId);
            if (!dataset) {
                throw new StagedEvaluationError(
                    'no-evaluable-case',
                    `${NO_EVALUABLE_CASE_PREFIX} 评估数据集不存在，无法匹配可评测 case`,
                );
            }
            matchedDatasetMeta = { id: dataset.id, name: dataset.name };
            const normalizedTraceInput = normalizeMatchText(traceQuery);
            if (!normalizedTraceInput && !row.caseId) {
                throw new StagedEvaluationError(
                    'no-evaluable-case',
                    `${NO_EVALUABLE_CASE_PREFIX} trace 没有实际输入，无法匹配评估数据集 case`,
                );
            }

            const exactFound = row.caseId
                ? dataset.cases.find(c => c.id === row.caseId)
                : dataset.cases.find(c => normalizeMatchText(c.input) === normalizedTraceInput);
            let found = exactFound || null;
            if (found) {
                matchKind = row.caseId ? 'explicit-pair' : 'exact-input';
            }

            if (!found && !row.caseId) {
                const semantic = await findBestSemanticCaseMatch(
                    dataset.cases.map(item => ({ id: item.id, input: item.input })),
                    traceQuery,
                    { user, requireModelAvailable: true }
                );
                if (semantic.error) {
                    throw new StagedEvaluationError(
                        'semantic-match-llm',
                        `${NO_EVALUABLE_CASE_PREFIX} 语义匹配调用评测模型失败：${semantic.error}`,
                    );
                }
                if (semantic.caseId) {
                    // found 类型是 DatasetCase | null（见上方 let 推断），Array.find 返回
                    // T | undefined，需要 ?? null 而不是 || undefined 才能保持类型一致。
                    found = dataset.cases.find(c => c.id === semantic.caseId) ?? null;
                    if (found) matchKind = 'semantic';
                }
            }

            if (!found) {
                throw new StagedEvaluationError(
                    'no-evaluable-case',
                    `${NO_EVALUABLE_CASE_PREFIX} trace 实际输入未匹配到当前数据集中的 case 输入`,
                );
            }

            caseEntry = found;
        } catch (e) {
            if (e instanceof StagedEvaluationError) throw e;
            throw new StagedEvaluationError('dataset-load', `读取数据集失败: ${(e as Error).message}`, e);
        }
        if (!caseEntry) {
            throw new StagedEvaluationError(
                'no-evaluable-case',
                `${NO_EVALUABLE_CASE_PREFIX} 未匹配到可评测 case`,
            );
        }
    } else if (shouldRunResultEvaluation || shouldRunTraceEvaluation) {
        try {
            const matched = await findMatchingDatasetCaseForTrace(user, traceQuery, {
                datasets: frozenDatasets,
                requireExpectedOutput: shouldRunResultEvaluation,
                allowedDatasetIds: rowAllowedDatasetIds,
            });
            caseEntry = matched.caseEntry;
            matchedDatasetMeta = { id: matched.dataset.id, name: matched.dataset.name };
            matchKind = 'auto-match';
            await prisma.trajectoryEvalResult.update({
                where: { id },
                data: {
                    datasetId: matched.dataset.id,
                    caseId: matched.caseEntry.id,
                },
            });
        } catch (e) {
            // 单 trace 归因场景（前端 Skill 分析 -> 重试 -> taskIds 模式）下,
            // 用户经常没维护 trajectory 数据集。没匹配到 dataset 是常见情况,不应该
            // 报错卡死;fallback 到空 case 模式,评估器内部会依赖 skill 的 SKILL.md
            // key actions 作为评估基准(参考下方 else 分支的空 case)。
            //
            // 仅对 stage='no-evaluable-case' 做 fallback;其他 stage(如 'semantic-match-llm'
            // LLM 调用失败)仍然抛错——那不是"没数据集",是真的有问题。
            if (e instanceof StagedEvaluationError && e.stage === 'no-evaluable-case' && !shouldRunResultEvaluation) {
                console.warn(`[trajectory/run] no matching dataset, falling back to empty case: ${e.message}`);
                caseEntry = { input: traceQuery, expectedOutput: '', trajectory: '', evaluationFocus: '', rootCauses: [] };
                matchKind = 'fallback';
            } else if (e instanceof StagedEvaluationError) {
                throw e;
            } else {
                throw new StagedEvaluationError('dataset-auto-match', `自动匹配数据集失败: ${(e as Error).message}`, e);
            }
        }
    } else if (hasCustomEvaluators) {
        // 自建评估器不强求数据集匹配。{{input}} 来自本次任务输入；只有提示词实际用了
        // {{reference_output}} 或 {{dataset_input}} 时才绑定数据集 case。
        if (needsCustomReferenceOutput || needsCustomDatasetInput) {
            try {
                const matched = await findMatchingDatasetCaseForTrace(user, traceQuery, {
                datasets: frozenDatasets,
                    requireExpectedOutput: needsCustomReferenceOutput && !needsCustomDatasetInput,
                    includeAllDatasetKinds: true,
                    allowedDatasetIds: rowAllowedDatasetIds,
                    allowSemanticMatch: !needsCustomDatasetInput,
                });
                caseEntry = matched.caseEntry;
                matchedDatasetMeta = { id: matched.dataset.id, name: matched.dataset.name };
                matchKind = 'auto-match';
                await prisma.trajectoryEvalResult.update({
                    where: { id },
                    data: {
                        datasetId: matched.dataset.id,
                        caseId: matched.caseEntry.id,
                    },
                });
            } catch (e) {
                if (needsCustomDatasetInput && e instanceof StagedEvaluationError && e.stage === 'no-evaluable-case') {
                    caseEntry = { input: traceQuery, expectedOutput: '', trajectory: '', evaluationFocus: '', rootCauses: [] };
                    matchKind = 'fallback';
                } else if (e instanceof StagedEvaluationError) {
                    throw e;
                } else {
                    throw new StagedEvaluationError(
                        'no-evaluable-case',
                        `${NO_EVALUABLE_CASE_PREFIX} 自定义评估器需要数据集字段，但 trace 输入未匹配到可用的数据集 case`,
                        e,
                    );
                }
            }
        } else {
            caseEntry = { input: traceQuery, expectedOutput: '', trajectory: '', evaluationFocus: '', rootCauses: [] };
        }
    } else {
        // 无数据集：用空参考，依赖 skill key actions 和纯轨迹质量评估
        caseEntry = { input: traceQuery, expectedOutput: '', trajectory: '', evaluationFocus: '', rootCauses: [] };
    }

    if (shouldRunResultEvaluation && !normalizeMatchText(caseEntry.expectedOutput)) {
        throw new StagedEvaluationError(
            'no-evaluable-case',
            `${NO_EVALUABLE_CASE_PREFIX} 已匹配到 case，但该 case 缺少预期结果 expectedOutput，无法执行结果评测`,
        );
    }
    const hasDeterministicDatasetInputMatch = Boolean(
        caseEntry.id
        && normalizeMatchText(caseEntry.input)
        && normalizeMatchText(traceQuery).includes(normalizeMatchText(caseEntry.input)),
    );

    const cachedRootCausesUsable = Boolean(
        caseEntry?.rootCauseMeta
        && canReuseRootCauseCache(caseEntry.expectedOutput, caseEntry.rootCauseMeta),
    );
    const cachedReadyRootCausesUsable = Boolean(
        cachedRootCausesUsable
        && caseEntry?.rootCauseMeta?.status === 'ready'
        && (caseEntry.rootCauses?.length || 0) > 0,
    );
    const precomputedRootCauses = cachedReadyRootCausesUsable
        ? caseEntry.rootCauses || []
        : undefined;
    const precomputedRootCauseSource = cachedRootCausesUsable
        ? (caseEntry?.rootCauseMeta?.status === 'empty' ? 'none' : cachedReadyRootCausesUsable ? 'dataset-cache' : undefined)
        : undefined;
    const liveRootCauseCacheTarget = matchedDatasetMeta?.id && caseEntry.id
        ? {
            datasetId: matchedDatasetMeta.id,
            caseId: caseEntry.id,
            expectedOutput: caseEntry.expectedOutput,
        }
        : null;
    const onLiveRootCausesExtracted = undefined;

    const taskInputForEvaluation = traceQuery || caseEntry.input || '';
    const caseSnapshot = {
        id: caseEntry.id || row.caseId || '',
        input: caseEntry.input,
        taskInput: taskInputForEvaluation,
        rawTaskInput: rawTraceQuery,
        taskInputExtraction: extractedTraceInput,
        expectedOutput: caseEntry.expectedOutput,
        trajectory: caseEntry.trajectory,
        evaluationFocus: caseEntry.evaluationFocus,
        rootCauseCacheStatus: caseEntry.rootCauseMeta?.status || null,
        rootCauseCacheUpdatedAt: caseEntry.rootCauseMeta?.updatedAt || null,
        // dataset 上下文——给"匹配的 Case"区块展示用
        datasetId: matchedDatasetMeta?.id || row.datasetId || '',
        datasetName: matchedDatasetMeta?.name || '',
        matchKind,
    };

    // 始终尝试做 skill 归因——以前只在没 trajectory 时跑，导致大多数评测路径上
    // skill_key_actions 维度被静默跳过；现在两者都能拿到时一起喂给 evaluator。
    let comparisonMode: TrajectoryEvalInput['comparisonMode'] = 'trajectory';
    let referenceKeyActionsText = '';
    let actualExtractedStepsText = '';
    let referenceKeyActionsForEval: unknown[] = [];
    let actualExtractedStepsForEval: unknown[] = [];
    let evaluationFocus = caseEntry.evaluationFocus;
    const referenceTrajectory = caseEntry.trajectory;
    const traceEvidence = interactions.length > 0
        ? buildTrajectoryTraceEvidence(interactions)
        : null;
    const keyActionReference = await buildSkillKeyActionReference(
        execution,
        user,
        interactions,
    );
    const resultSkillTargets = getPrimaryExecutionSkillTargets(execution, interactions);
    const resultSkillMode: NonNullable<TaskCompletionEvalInput['skillAttributionMode']> =
        resultSkillTargets.length > 0 ? 'skill-aware' : 'no-skill';
    const keyActionComparisonForStatus: SkillKeyActionComparisonResult = keyActionReference.status === 'ok'
        ? {
            status: 'ok',
            referenceKeyActionsText: keyActionReference.referenceKeyActionsText,
            actualExtractedStepsText: traceEvidence?.text || '',
            referenceKeyActions: keyActionReference.referenceKeyActions,
            actualExtractedSteps: traceEvidence?.steps || [],
        }
        : keyActionReference;
    const skillAttributionStatus = buildSkillAttributionStatus(keyActionComparisonForStatus);

    if (keyActionReference.status === 'ok' && traceEvidence && traceEvidence.steps.length > 0) {
        comparisonMode = 'skill_key_actions';
        referenceKeyActionsText = keyActionReference.referenceKeyActionsText;
        actualExtractedStepsText = traceEvidence.text;
        referenceKeyActionsForEval = keyActionReference.referenceKeyActions ?? [];
        actualExtractedStepsForEval = traceEvidence.steps;
        evaluationFocus = [
            normalizeMatchText(caseEntry.evaluationFocus),
            '逐条比较 Skill 自动提取的关键动作与 trace 事件级步骤（user/llm/tool/skill/task），并直接生成每个关键动作的 Skill 改进建议。',
        ].filter(Boolean).join(' ');
    } else if (shouldRunTraceEvaluation) {
        if (!traceEvidence || traceEvidence.steps.length === 0) {
            throw new StagedEvaluationError(
                'no-evaluable-case',
                `${NO_EVALUABLE_CASE_PREFIX} 当前 trace 无法提取可评测事件步骤`,
            );
        }
        comparisonMode = 'trace_only';
        actualExtractedStepsText = traceEvidence.text;
        actualExtractedStepsForEval = traceEvidence.steps;
        evaluationFocus = [
            normalizeMatchText(caseEntry.evaluationFocus),
            '当前 trace 未获得可用 Skill 关键动作；不评估完整性，不生成 Skill 关键动作建议，仅评估工具选择与冗余。',
        ].filter(Boolean).join(' ');
    }

    // skillAttribution + comparisonMode 写进 baseRawAnalysisMeta 后所有 evaluator
    // 写盘的 rawAnalysisJson 都会带上，前端按 state 显示徽章。
    const baseRawAnalysisMeta = {
        ...(Object.hasOwn(frozenRunSnapshot, 'customEvaluatorSnapshots') ? { customEvaluatorSnapshots: frozenRunSnapshot.customEvaluatorSnapshots } : {}),
        ...evaluatorMeta,
        taskMeta,
        ...(grayscaleBinding ? { grayscaleBinding } : {}),
        caseSnapshot,
        skillAttribution: skillAttributionStatus,
        resultSkillMode,
        comparisonMode,
        actualTraceExtraction: traceEvidence
            ? {
                source: 'summarizeTrace',
                totalSteps: traceEvidence.summary.totalSteps,
                shownSteps: traceEvidence.steps.length,
                truncated: traceEvidence.summary.truncated,
                totalLlmCalls: traceEvidence.summary.totalLlmCalls,
                totalToolCalls: traceEvidence.summary.totalToolCalls,
                totalSkillCalls: traceEvidence.summary.totalSkillCalls,
                totalTaskCalls: traceEvidence.summary.totalTaskCalls,
            }
            : null,
        skillKeyActionComparison: keyActionReference.status === 'ok'
            ? {
                referenceKeyActionsText: keyActionReference.referenceKeyActionsText,
                actualExtractedStepsText,
                referenceKeyActions: keyActionReference.referenceKeyActions ?? [],
                actualExtractedSteps: actualExtractedStepsForEval,
            }
            : null,
    };

    if ((shouldRunTraceEvaluation || shouldRunResultEvaluation) && interactions.length === 0) {
        throw new StagedEvaluationError(
            'trace-empty',
            `taskId=${resolvedTaskId || 'N/A'} 对应的 Session 不存在或 interactions 为空`,
        );
    }

    if (shouldRunTraceEvaluation && !shouldRunResultEvaluation) {
        const fallbackOutput = String(execution?.finalResult || '').trim();
        try {
            const artifactExtraction = await withTimeout(
                extractTaskResultArtifact({
                    userTask: caseEntry.input,
                    interactions,
                    fallbackOutput,
                    user,
                }),
                PER_RESULT_TIMEOUT_MS,
                new StagedEvaluationError('result-artifact-timeout', `实际输出提取超过 ${PER_RESULT_TIMEOUT_MS / 1000}s 未完成`),
            );
            resultArtifactExtractionRawAnalysis = artifactExtraction.rawAnalysis;
            resultActualOutput = String(artifactExtraction.outputForEvaluation || fallbackOutput || '').trim();
        } catch (e) {
            console.warn('[trajectory-eval] result artifact extraction failed:', e);
            resultActualOutput = fallbackOutput;
        }

        await prisma.trajectoryEvalResult.update({
            where: { id },
            data: {
                rawAnalysisJson: JSON.stringify({
                    ...baseRawAnalysisMeta,
                    resultArtifactExtraction: resultArtifactExtractionRawAnalysis,
                    resultActualOutput,
                    resultEvaluation: null,
                    resultEvaluationError: null,
                }),
            },
        });
    }

    if (shouldRunResultEvaluation) {
        const taskCompletionSkillContext = resultSkillMode === 'skill-aware'
            ? await loadTaskCompletionSkillContext(execution, interactions, user)
            : undefined;
        const traceSummaryForResultEvaluation = traceEvidence?.text || '';
        const attempt = Math.min(
            readResultEvaluationAttemptCount(row.rawAnalysisJson) + 1,
            MAX_RESULT_EVALUATION_ATTEMPTS,
        );
        const attemptStartedAt = new Date();

        try {
            await withTimeout((async () => {
                const artifactExtraction = await extractTaskResultArtifact({
                    userTask: caseEntry.input,
                    interactions,
                    fallbackOutput: fallbackFinalResult,
                    user,
                });
                resultArtifactExtractionRawAnalysis = artifactExtraction.rawAnalysis;
                const extractedOutput = String(artifactExtraction.outputForEvaluation || '').trim();
                resultActualOutput = extractedOutput;

                if (!resultActualOutput) {
                    resultEvaluationError = `结果输出提取失败：${artifactExtraction.reason}`;
                    finalDiagnostic = buildEvaluationDiagnostic(
                        String(artifactExtraction.reason || '').includes('没有可用于输出提取的 LLM 调用')
                            ? 'trace_missing_output'
                            : 'task_output_extraction_failed',
                        {
                            details: resultEvaluationError,
                            reason: resultEvaluationError,
                        },
                    );
                    resultEvaluationRetryState = buildResultEvaluationRetryState(attempt, {
                        retrying: false,
                        exhausted: true,
                        lastError: resultEvaluationError,
                        now: attemptStartedAt,
                    });
                    await prisma.trajectoryEvalResult.update({
                        where: { id },
                        data: {
                            rawAnalysisJson: JSON.stringify({
                                ...baseRawAnalysisMeta,
                                resultArtifactExtraction: resultArtifactExtractionRawAnalysis,
                                resultActualOutput: '',
                                resultEvaluation: null,
                                resultEvaluationError,
                                resultEvaluationRetry: resultEvaluationRetryState,
                                diagnostic: finalDiagnostic,
                            }),
                        },
                    });
                    return;
                }

                resultEvaluationRetryState = buildResultEvaluationRetryState(attempt, {
                    retrying: false,
                    exhausted: false,
                    now: attemptStartedAt,
                });
                finalDiagnostic = null;
                await prisma.trajectoryEvalResult.update({
                    where: { id },
                    data: {
                        rawAnalysisJson: JSON.stringify({
                            ...baseRawAnalysisMeta,
                            resultArtifactExtraction: resultArtifactExtractionRawAnalysis,
                            resultActualOutput,
                            resultEvaluation: null,
                            resultEvaluationError: null,
                            resultEvaluationRetry: resultEvaluationRetryState,
                        }),
                    },
                });
                const resultJudgment = await evaluateTaskCompletionAgainstExpected(
                    caseEntry.input,
                    caseEntry.expectedOutput,
                    resultActualOutput,
                    precomputedRootCauses,
                    precomputedRootCauseSource,
                    onLiveRootCausesExtracted,
                    traceSummaryForResultEvaluation,
                    taskCompletionSkillContext,
                    resultSkillMode,
                    user,
                    evalSkillName,
                    evalSkillVersion,
                );
                resultEvaluationRawAnalysis = {
                    ...(resultJudgment.rawAnalysis || {}),
                    score: resultJudgment.score,
                    is_correct: resultJudgment.isCorrect,
                    reason: resultJudgment.reason,
                    result_artifact_extraction: {
                        status: artifactExtraction.rawAnalysis?.fallback ? 'fallback_final_result' : artifactExtraction.status,
                        confidence: artifactExtraction.confidence,
                        reason: artifactExtraction.reason,
                        source_refs: artifactExtraction.sourceRefs,
                        fallback_source: artifactExtraction.rawAnalysis?.fallback ? 'execution.finalResult' : null,
                    },
                };

                resultEvaluationRetryState = buildResultEvaluationRetryState(attempt, {
                    retrying: false,
                    exhausted: false,
                    now: attemptStartedAt,
                });
                await prisma.trajectoryEvalResult.update({
                    where: { id },
                    data: {
                        rawAnalysisJson: JSON.stringify({
                            ...baseRawAnalysisMeta,
                            resultArtifactExtraction: resultArtifactExtractionRawAnalysis,
                            resultActualOutput,
                            resultEvaluation: resultEvaluationRawAnalysis,
                            resultEvaluationError: null,
                            resultEvaluationRetry: resultEvaluationRetryState,
                        }),
                    },
                });
                resultEvaluationError = null;
                finalDiagnostic = null;
            })(), PER_RESULT_TIMEOUT_MS, new StagedEvaluationError(
                'result-timeout',
                `结果评测超过 ${PER_RESULT_TIMEOUT_MS / 1000}s 未完成`,
            ));
        } catch (e) {
            console.warn(`[trajectory-eval] result-based evaluation attempt ${attempt}/${MAX_RESULT_EVALUATION_ATTEMPTS} failed:`, e);
            const detail = (e as Error).message || String(e);
            const canRetryLater = attempt < MAX_RESULT_EVALUATION_ATTEMPTS && isRetryableResultEvaluationFailure(e);

            if (canRetryLater) {
                scheduledResultRetryDelayMs = getResultEvaluationRetryDelayMs(attempt);
                scheduledResultRetryAttemptCount = attempt;
                resultEvaluationRetryState = buildResultEvaluationRetryState(attempt, {
                    retrying: true,
                    exhausted: false,
                    lastError: detail,
                    delayMs: scheduledResultRetryDelayMs,
                    now: attemptStartedAt,
                });
                await prisma.trajectoryEvalResult.update({
                    where: { id },
                    data: {
                        status: 'running',
                        errorMessage: null,
                        rawAnalysisJson: JSON.stringify({
                            ...baseRawAnalysisMeta,
                            resultArtifactExtraction: resultArtifactExtractionRawAnalysis,
                            resultActualOutput,
                            resultEvaluation: null,
                            resultEvaluationError: null,
                            resultEvaluationRetry: resultEvaluationRetryState,
                        }),
                    },
                });
            } else {
                resultEvaluationError = `结果评测失败：${detail}`;
                finalDiagnostic = buildEvaluationDiagnostic(
                    e instanceof StagedEvaluationError && (e.stage === 'result-timeout' || e.stage === 'result-artifact-timeout')
                        ? 'evaluator_timeout'
                        : 'result_evaluator_failed',
                    {
                        details: resultEvaluationError,
                        reason: resultEvaluationError,
                    },
                );
                resultEvaluationRetryState = buildResultEvaluationRetryState(attempt, {
                    retrying: false,
                    exhausted: true,
                    lastError: detail,
                    now: attemptStartedAt,
                });
                await prisma.trajectoryEvalResult.update({
                    where: { id },
                    data: {
                        rawAnalysisJson: JSON.stringify({
                            ...baseRawAnalysisMeta,
                            resultArtifactExtraction: resultArtifactExtractionRawAnalysis,
                            resultActualOutput,
                            resultEvaluation: resultEvaluationRawAnalysis,
                            resultEvaluationError,
                            resultEvaluationRetry: resultEvaluationRetryState,
                            diagnostic: finalDiagnostic,
                        }),
                    },
                });
            }
        }
    }

    if (scheduledResultRetryDelayMs != null) {
        await new Promise<void>((resolve, reject) => {const timer = setTimeout(resolve, scheduledResultRetryDelayMs!);signal.addEventListener('abort', () => {clearTimeout(timer);reject(signal.reason);}, {once: true});});
        await runOneEvaluationInner(user, id, prisma, frozenDatasets, signal);
        return;
    }

    // ---- 1.5 自建评估器（custom-* IDs）----
    // 与 preset trace/result evaluator 平行运行；根据所有自建评估器实际引用的变量做一次共享提取。
    if (hasCustomEvaluators) {
        if (needsCustomOutput && !resultActualOutput) {
            const fallbackOutput = String(execution?.finalResult || '').trim();
            if (interactions.length > 0) {
                try {
                    const artifactExtraction = await withTimeout(
                        extractTaskResultArtifact({
                            userTask: taskInputForEvaluation,
                            interactions,
                            fallbackOutput,
                            user,
                        }),
                        PER_RESULT_TIMEOUT_MS,
                        new StagedEvaluationError('result-artifact-timeout', `实际输出提取超过 ${PER_RESULT_TIMEOUT_MS / 1000}s 未完成`),
                    );
                    resultArtifactExtractionRawAnalysis = artifactExtraction.rawAnalysis;
                    resultActualOutput = String(artifactExtraction.outputForEvaluation || fallbackOutput || '').trim();
                } catch (e) {
                    console.warn('[trajectory-eval] custom evaluator output extraction failed:', e);
                    resultActualOutput = fallbackOutput;
                }
            } else {
                resultActualOutput = fallbackOutput;
            }
        }
        const actualOutputForCustom = needsCustomOutput ? resultActualOutput : '';
        const traceTextForCustom = needsCustomTrajectory ? (() => {
            return traceEvidence?.text || '';
        })() : '';

        const customResults: Array<Awaited<ReturnType<typeof runCustomLlmEvaluator>>> = await Promise.all(
            customEvaluatorIds.map(async evaluatorId => {
                const evaluatorVars = customVarsByEvaluator.get(evaluatorId) || new Set<CustomEvaluatorVariable>();
                const bundle = customEvaluatorBundles.find(item => item.evaluatorId === evaluatorId)?.bundle;
                const unavailableReason = evaluatorVars.has('dataset_input') && !hasDeterministicDatasetInputMatch
                    ? '不适用：实际任务输入未匹配到可用的数据集输入。'
                    : evaluatorVars.has('reference_output') && !normalizeMatchText(caseEntry!.expectedOutput)
                        ? '不适用：匹配的数据集 case 未提供预期输出。'
                        : '';
                if (unavailableReason) {
                    return {
                        evaluatorId,
                        evaluatorName: bundle?.name || evaluatorId,
                        score: null,
                        reason: unavailableReason,
                        rawResponse: '',
                        model: bundle?.config.model || '',
                        durationMs: 0,
                    };
                }
                return runCustomLlmEvaluator(user, evaluatorId, {
                    caseInput: taskInputForEvaluation,
                    datasetInput: evaluatorVars.has('dataset_input') || (bundle?.config.skills?.length && hasDeterministicDatasetInputMatch) ? caseEntry!.input : '',
                    expectedOutput: evaluatorVars.has('reference_output') || bundle?.config.skills?.length ? caseEntry!.expectedOutput : '',
                    actualOutput: actualOutputForCustom,
                    traceText: traceTextForCustom,
                }, evalSkillName, evalSkillVersion, bundle?.card || null, signal).catch(e => ({
                    evaluatorId,
                    evaluatorName: evaluatorId,
                    score: null as number | null,
                    reason: '',
                    rawResponse: '',
                    model: '',
                    durationMs: 0,
                    error: `运行异常：${(e as Error)?.message || String(e)}`,
                }));
            }),
        );

        customSkillError = customResults.find(r => r.runtime?.error)?.error || null;
        const byId: Record<string, unknown> = {};
        for (const r of customResults) {
            byId[r.evaluatorId] = {
                evaluatorId: r.evaluatorId,
                evaluatorName: r.evaluatorName,
                score: r.score,
                reason: r.reason,
                model: r.model,
                durationMs: r.durationMs,
                runtime: r.runtime,
                output: r.output,
                error: r.error,
            };
            if (typeof r.score === 'number') customEvaluatorScores.push(r.score);
        }
        customEvaluationsRawAnalysis = byId;
    }

    if (!shouldRunTraceEvaluation) {
        // 没有 trace 评估器但有自建评估器时，trajectoryScore 不再复用自定义分数；
        // 自定义评测作为和结果/轨迹并列的维度，保存在 rawAnalysisJson.customEvaluations。
        const customAvg = customEvaluatorScores.length > 0
            ? customEvaluatorScores.reduce((a, b) => a + b, 0) / customEvaluatorScores.length
            : null;
        // resultEvaluationRawAnalysis 仅在上方 async 闭包内赋值, TS 控制流到这里把它收窄成 null,
        // 直接 ?.evaluatorSessionId 会让访问类型变 never → next build 报错。先按声明类型取值再判类型。
        const resultEvalSid = (resultEvaluationRawAnalysis as Record<string, unknown> | null)?.evaluatorSessionId;
        const resultEvaluatorSessionId = typeof resultEvalSid === 'string' ? resultEvalSid.trim() : '';
        const resultEvaluationMissing = shouldRunResultEvaluation && (!resultEvaluationRawAnalysis || !resultEvaluatorSessionId);
        const finalStatus = resultEvaluationMissing || customSkillError ? 'failed' : 'done';
        const finalErrorMessage = resultEvaluationMissing
            ? (resultEvaluationError || '结果评测未产出有效结果或评测 session')
            : customSkillError;
        if (resultEvaluationMissing && !finalDiagnostic) {
            finalDiagnostic = buildEvaluationDiagnostic('result_evaluator_failed', {
                details: finalErrorMessage || undefined,
                reason: finalErrorMessage || undefined,
            });
        }
        await prisma.trajectoryEvalResult.update({
            where: { id },
            data: {
                status: finalStatus,
                trajectoryScore: null,
                dimensionScoresJson: null,
                deviationStepsJson: JSON.stringify([]),
                rootCauseStep: null,
                reasonText: null,
                rawAnalysisJson: JSON.stringify({
                    ...baseRawAnalysisMeta,
                    resultArtifactExtraction: resultArtifactExtractionRawAnalysis,
                    resultActualOutput,
                    resultEvaluation: resultEvaluationRawAnalysis,
                    resultEvaluationError,
                    resultEvaluationRetry: resultEvaluationRetryState,
                    customEvaluations: customEvaluationsRawAnalysis,
                    customVariableNeeds: Array.from(requestedCustomVars),
                    customEvaluationScore: customAvg,
                    ...(finalDiagnostic ? { diagnostic: finalDiagnostic } : {}),
                }),
                errorMessage: finalErrorMessage,
            },
        });
        return;
    }

    const input: TrajectoryEvalInput = {
        caseId: caseEntry.id || row.caseId || '',
        caseInput: caseEntry.input,
        referenceOutput: caseEntry.expectedOutput,
        referenceTrajectory,
        referenceKeyActionsText,
        actualExtractedStepsText,
        referenceKeyActions: referenceKeyActionsForEval,
        actualExtractedSteps: actualExtractedStepsForEval,
        skillContext: await loadTaskCompletionSkillContext(execution, interactions, user),
        comparisonMode,
        evaluationFocus,
        actualInteractions: interactions,
        taskId: resolvedTaskId || undefined,
        executionId: row.executionId || execution?.id || undefined,
    };

    // ---- 2. 真跑 evaluator (opencode) + 超时 ----
    let out: Awaited<ReturnType<typeof evaluateTrajectoryViaOpencode>>;
    try {
        out = await withTimeout(evaluateTrajectoryViaOpencode(input, user, evalSkillName, evalSkillVersion), PER_RESULT_TIMEOUT_MS, new StagedEvaluationError('timeout', `单条评测超过 ${PER_RESULT_TIMEOUT_MS / 1000}s 未完成`));
    } catch (e) {
        if (e instanceof StagedEvaluationError) throw e;
        if (e instanceof TrajectoryEvalConfigError) {
            throw new StagedEvaluationError('config', e.message, e);
        }
        throw new StagedEvaluationError('llm-or-agent', (e as Error).message || String(e), e);
    }

    // ---- 2.5 建议流：门控命中则跑 skill 改进建议 agent（读完整 trace，独立于覆盖打分）----
    // 计分（out.keyActionResults / completeness）已出，用它做门控：失败 / 覆盖不全才跑这次贵的深读。
    // 非致命：任何异常都吞掉、退回空建议，不阻塞评测落库。
    let skillSuggestions: SkillSuggestion[] = [];
    try {
        if (
            evalSkillName &&
            shouldRunSuggestionAgent({
                keyActionResults: out.keyActionResults,
                completeness: out.dimensionScores?.completeness,
            })
        ) {
            skillSuggestions = await runSkillSuggestionAgent({
                user,
                skillName: evalSkillName,
                skillVersion: evalSkillVersion,
                executionId: String(row.executionId || execution?.id || resolvedTaskId || id),
                interactions: Array.isArray(interactions) ? interactions : [],
                keyActionResults: out.keyActionResults,
            });
        }
    } catch (e) {
        console.warn('[trajectory-eval] skill suggestion agent failed (non-fatal):', (e as Error).message);
    }

    // ---- 3. 落库 ----
    try {
        const mergedRawAnalysis = {
            ...(out.rawAnalysis && typeof out.rawAnalysis === 'object' ? out.rawAnalysis : {}),
            ...baseRawAnalysisMeta,
            skill_suggestions: skillSuggestions,
            resultArtifactExtraction: resultArtifactExtractionRawAnalysis,
            resultActualOutput,
            resultEvaluation: resultEvaluationRawAnalysis,
            resultEvaluationError,
            resultEvaluationRetry: resultEvaluationRetryState,
            customEvaluations: customEvaluationsRawAnalysis,
            customVariableNeeds: Array.from(requestedCustomVars),
            customEvaluationScore: customEvaluatorScores.length > 0
                ? customEvaluatorScores.reduce((a, b) => a + b, 0) / customEvaluatorScores.length
                : null,
            ...(finalDiagnostic ? { diagnostic: finalDiagnostic } : {}),
        };
        await prisma.trajectoryEvalResult.update({
            where: { id },
            data: {
                status: customSkillError ? 'failed' : 'done',
                trajectoryScore: out.trajectoryScore,
                dimensionScoresJson: JSON.stringify(out.dimensionScores),
                deviationStepsJson: JSON.stringify(out.deviationSteps),
                rootCauseStep: out.rootCauseStep || null,
                reasonText: out.reasonText || null,
                rawAnalysisJson: JSON.stringify(mergedRawAnalysis),
                errorMessage: customSkillError,
            },
        });
    } catch (e) {
        throw new StagedEvaluationError('persist', `写入评测结果失败: ${(e as Error).message}`, e);
    }


 } finally {
    // 无论成功 / 失败 / throw,都从 activeTasks 摘掉这条注册,让 isActive() 返 false,
    // 前端轮询拿到 is_evaluating=false → trace 状态更新为最新分数 / 失败信息。
    if (registeredTaskId && registeredRunId) {
        try { finishEvalTask(user, registeredTaskId, registeredRunId); }
        catch (e) {
            console.warn(`[trajectory-eval] finishEvalTask failed user=${user} task=${registeredTaskId}: ${(e as Error)?.message}`);
        }
    }
 }
}


export async function computeFrozenDirectTrajectory(work:FrozenExperimentWork,options:{user:string;signal:AbortSignal}){
 if(work.handle.evaluator_id.startsWith('__direct_trajectory__:')){
  const real=work.handle.evaluator_id.slice('__direct_trajectory__:'.length);work=structuredClone(work);const request=work.raw_case.directTrajectory as Record<string,unknown>;const raw=safeParseRecord(String(request.rawAnalysisJson));const selected=Array.isArray(raw.selectedEvaluators)?raw.selectedEvaluators as string[]:[];const index=selected.indexOf(real);const names=Array.isArray(raw.selectedEvaluatorNames)?raw.selectedEvaluatorNames as string[]:[];
  if(index<0)throw Object.assign(new Error('Frozen direct evaluator is outside Case selection'),{status:503});
  request.rawAnalysisJson=JSON.stringify({...raw,selectedEvaluators:[real],selectedEvaluatorNames:[names[index]||real]});
 }

 const snapshot=JSON.parse(String(work.experiment_config.configSnapshotJson||'{}')) as {coreDirectDatasets?:{datasets:AgentDatasetRecord[]};coreDirectSkills?:FrozenSkillRecord[]};
 if(!snapshot.coreDirectDatasets||!Array.isArray(snapshot.coreDirectDatasets.datasets))throw Object.assign(new Error('Frozen direct evaluation Dataset scope required'),{status:503});
 const draft=createDirectTrajectoryDraft(work,options.user,options.signal);const row=work.raw_case.directTrajectory as {id:string};
 const limiter=getEvalRowLimiter();await limiter.acquire();
 try{
  try{await withFrozenSkillCatalog(snapshot.coreDirectSkills||[],options.user,()=>runOneEvaluationInner(options.user,row.id,draft.source,snapshot.coreDirectDatasets!.datasets,options.signal));}
  catch(error){options.signal.throwIfAborted();await draft.source.trajectoryEvalResult.update({where:{id:row.id},data:{status:'failed',errorMessage:error instanceof Error?error.message:String(error),rawAnalysisJson:mergeDiagnosticIntoRawAnalysis((await draft.source.trajectoryEvalResult.findUnique({where:{id:row.id}}))?.rawAnalysisJson,buildDiagnosticFromError(error))}});}
  const result=draft.result();
  if(result.status==='done'){
   const execution=work.frozen_trace_evidence?.execution;const interactions=work.frozen_trace_evidence?.session?.interactions;
   const skills=getPrimaryExecutionSkillTargets(execution,interactions).map(target=>({name:target.skill,version:target.version}));
   const saved=result.evidence.json.directTrajectory as unknown as import('@prisma/client').TrajectoryEvalResult;
   const allowed=work.runplan.config as {derived_skill_ids?:string[];derived_skill_versions?:Record<string,number[]>}|undefined;
   const catalog=(snapshot.coreDirectSkills||[]).filter(skill=>(allowed?.derived_skill_ids||[]).includes(skill.id));
   const targets=skills.filter(target=>{const skill=catalog.find(item=>item.name===target.name);if(!skill)return false;const version=target.version??skill.activeVersion??0;return (allowed?.derived_skill_versions?.[skill.id]||[]).includes(version);});
   const derived=deriveOptPointArtifacts({user:options.user,taskId:saved.taskId,runId:saved.evaluatorRunId,trajectoryRow:saved,skills:targets},{executionId:typeof execution?.id==='string'?execution.id:null,lineage:work.handle.attempt_id,skills:catalog});
   Object.assign(result.evidence.json,{directTrajectoryDerived:derived});
  }
  if(result.status==='failed')throw Object.assign(new Error(String(result.errorMessage||'Direct evaluation failed')),{coreExperimentFailureResult:result});return result;
 }finally{limiter.release();}
}
