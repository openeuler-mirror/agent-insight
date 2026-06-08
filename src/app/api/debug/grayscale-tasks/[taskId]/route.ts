import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import { runGeneralAgent } from '@/lib/engine/general-agent';
import { withBackgroundOpencodeSlot } from '@/lib/engine/general-agent/concurrency-limiter';
import { findAgentDataset, type DatasetCase } from '@/server/agent_datasets_storage';
import { saveExecutionRecord } from '@/lib/storage/data-service';

export const dynamic = 'force-dynamic';

type Side = 'a' | 'b';
type CaseStatus = 'pending' | 'running' | 'executed' | 'evaluating' | 'pass' | 'fail';
type RunFailureType = 'permission_blocked' | 'agent_timeout' | 'question_blocked' | 'agent_error';

interface GrayscaleConfig {
    skillId?: string;
    versionAId?: string;
    versionBId?: string;
    selectedDatasetId?: string;
    linkedDatasetIds?: string[];
    selectedCaseId?: string;
    selectedCaseIds?: string[];
    runCount?: number;
    repeatRounds?: number;
    agentMaxConcurrency?: number;
    autoEval?: boolean;
    recordTriggerDetails?: boolean;
    evaluatorId?: string;
    evaluators?: string[];
    latestResultAt?: string;
    // 关联到「评测执行」页的批次 ID (evaluatorRunId)。前端通过「+ 新增评测任务」对话框创建,
    // 后续启动评测时透传给 /api/eval/trajectory/run 作 evaluatorRunId append (下一步迭代)。
    evaluationBatchId?: string;
    evaluationBatchTitle?: string;
    evaluationBatchEvaluators?: string[];
}

function withDefaultConfig(config: GrayscaleConfig): GrayscaleConfig {
    const evaluatorIds = normalizeAbEvaluators(config.evaluators || config.evaluationBatchEvaluators, config.evaluatorId);
    return {
        ...config,
        autoEval: true,
        recordTriggerDetails: true,
        evaluatorId: evaluatorIds[0] || '',
        evaluators: evaluatorIds,
    };
}

interface RunResult {
    status: CaseStatus;
    jobId?: string;
    evaluatorRunId?: string;
    evaluationResultId?: string;
    evaluationClaimId?: string;
    evaluationStartedAt?: string;
    evaluationTraceId?: string;
    timeCost?: string;
    tokenUsage?: number;
    output?: string;
    sessionId?: string;
    score?: number;
    tier?: 'good' | 'warn' | 'poor';
    evaluations?: RunEvaluation[];
    runIndex: number;
    roundIndex: number;
    caseId: string;
    traceIds?: string[];
    skillTriggered?: boolean;
    toolCallCount?: number;
    toolCalls?: string[];
    executionAttempts?: number;
    evaluationAttempts?: number;
    failureType?: RunFailureType;
    failureDetail?: string;
    completedAt?: string;
}

type RunEvaluationStatus = 'pending' | 'running' | 'done' | 'failed';

interface RunEvaluation {
    evaluatorId: string;
    evaluatorName: string;
    status: RunEvaluationStatus;
    evaluatorRunId?: string;
    evaluationResultId?: string;
    evaluationTraceId?: string;
    score?: number;
    errorMessage?: string;
}

interface GrayscaleBinding {
    source: 'grayscale-ab';
    grayscaleTaskId: string;
    caseId: string;
    side: Side;
    runIndex: number;
    roundIndex: number;
    executionTraceId: string;
    evaluationClaimId: string;
    evaluationAttempt: number;
}

interface PerVersionState {
    status: CaseStatus;
    jobId?: string;
    evaluatorRunId?: string;
    timeCost?: string;
    tokenUsage?: number;
    output?: string;
    sessionId?: string;
    score?: number;
    tier?: 'good' | 'warn' | 'poor';
    evaluations?: RunEvaluation[];
    runs?: RunResult[];
    runCount?: number;
    traceIds?: string[];
    skillTriggered?: boolean;
    toolCallCount?: number;
    toolCalls?: string[];
}

type CaseStates = Record<string, { a: PerVersionState; b: PerVersionState }>;

interface ActiveGrayscaleRun {
    taskId: string;
    runId: string;
    status: 'running' | 'evaluating';
    startedAt: number;
    /**
     * 任务级 AbortController, 用户点「终止」按钮时调用 .abort() 让所有 in-flight
     * 子任务尽快收尾。signal 会传给 runGeneralAgent.chatOptions.signal, opencode
     * 检测到 abort 立即返回; runWithConcurrency 的 worker 循环也会检查并 bail。
     */
    abortController?: AbortController;
}

interface GrayscaleTaskRow {
    id: string;
    user: string;
    skillId: string;
    skillName: string;
    skillVersion: number;
    skillVersionId: string;
    taskName: string;
    configJson: string;
    caseStatesJson: string;
    createdAt: Date;
}

interface SkillVersionRow {
    version: number;
    Skill?: { name?: string | null } | null;
}

interface TrajectoryResultRow {
    id?: string;
    evaluatorRunId?: string;
    status?: string;
    taskId?: string | null;
    trajectoryScore?: number | null;
    errorMessage?: string | null;
    rawAnalysisJson?: string | null;
    updatedAt?: Date;
}

interface TrajectoryApiResult {
    id?: string;
    evaluatorRunId?: string;
    status?: string;
    taskId?: string | null;
    trajectoryScore?: number | null;
    resultEvaluationScore?: number | null;
    errorMessage?: string | null;
    rawAnalysis?: unknown;
    updatedAt?: string;
}

type TrajectoryResultStatus = 'pending' | 'running' | 'done' | 'failed' | string;

interface ExecutionMetricRow {
    taskId?: string | null;
    query?: string | null;
    agentName?: string | null;
    finalResult?: string | null;
    skill?: string | null;
    skillVersion?: number | null;
    latency?: number | null;
    tokens?: number | null;
    toolCallCount?: number | null;
    timestamp?: Date | string | number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadInputTokens?: number | null;
    cacheCreationInputTokens?: number | null;
    reasoningTokens?: number | null;
}

interface GrayscalePrisma {
    grayscaleTask: {
        findFirst(args: { where: { id?: string; user: string; skillName?: string; skillVersion?: number; taskName?: string; NOT?: { id: string } } }): Promise<GrayscaleTaskRow | null>;
        findMany(args: { select: { id: true; user: true; caseStatesJson: true } }): Promise<Array<{ id: string; user: string; caseStatesJson: string }>>;
        updateMany(args: { where: { id: string; user: string; caseStatesJson?: string }; data: Record<string, string> }): Promise<{ count: number }>;
    };
    skillVersion: {
        findFirst(args: { where: { id: string; skillId: string }; include: { Skill: true } }): Promise<SkillVersionRow | null>;
    };
    trajectoryEvalResult: {
        findMany(args: { where: Record<string, unknown> }): Promise<TrajectoryResultRow[]>;
        updateMany(args: {
            where: { user?: string; evaluatorRunId?: string; id?: { in: string[] }; status?: { in: string[] }; taskId?: { in: string[] } };
            data: { status: string; errorMessage?: string };
        }): Promise<{ count: number }>;
    };
    execution: {
        findMany(args: {
            where: Record<string, unknown>;
            select: {
                taskId: true;
                query?: true;
                agentName?: true;
                finalResult?: true;
                skill?: true;
                skillVersion?: true;
                latency: true;
                tokens: true;
                toolCallCount?: true;
                timestamp?: true;
                inputTokens: true;
                outputTokens: true;
                cacheReadInputTokens: true;
                cacheCreationInputTokens: true;
                reasoningTokens: true;
            };
        }): Promise<ExecutionMetricRow[]>;
    };
}

declare global {
    var __grayscaleRunStore: Map<string, ActiveGrayscaleRun> | undefined;
}

const NONE_VERSION_ID = '__NONE__';
const TASK_COMPLETION_EVALUATOR_ID = 'preset-agent-task-completion';
const TRACE_EVALUATOR_ID = 'preset-agent-trace-quality';
const SUPPORTED_AB_EVALUATORS = new Set([TASK_COMPLETION_EVALUATOR_ID, TRACE_EVALUATOR_ID]);
const AB_EVALUATOR_NAMES: Record<string, string> = {
    [TASK_COMPLETION_EVALUATOR_ID]: 'Agent 任务完成度',
    [TRACE_EVALUATOR_ID]: 'Agent 轨迹质量',
};
const STALE_EVALUATION_MS = 15 * 60 * 1000;
// 本次 next.js server 进程的启动时间。TrajectoryEvalResult.updatedAt 早于此
// 时间但还停在 pending/running 的, 必然是上一个 server 生命周期遗留的孤儿
// (eval 进程跟着 server 一起挂了, 永远不会再 progress)。reconcile 用这条
// 规则比 STALE_EVALUATION_MS=15min 的纯时间阈值更快地恢复, 用户重启后不需要
// 等 15 分钟看到状态自然修复。globalThis 兜一层避免 dev 热更新 module 重载
// 把启动时间也重置 (热更不算真重启, 老 eval 可能还在跑)。
const SERVER_START_TIME: number = (() => {
    const g = globalThis as { __grayscaleServerStartTime?: number };
    if (!g.__grayscaleServerStartTime) g.__grayscaleServerStartTime = Date.now();
    return g.__grayscaleServerStartTime;
})();
const MAX_EXECUTION_RETRIES = 2;
const MAX_EVALUATION_RETRIES = 2;
// caseStatesJson 整份回写的乐观锁重试次数。评测/执行高并发(默认 5 个 slot)时,
// 多个 flow 各自 load→改→写整份 JSON, 不做 CAS 会 lost update; 冲突就重新 load 再算。
const PERSIST_CAS_MAX_RETRIES = 5;
const GRAYSCALE_AGENT_TIMEOUT_MS = Number(process.env.GRAYSCALE_AGENT_TIMEOUT_MS) || 3 * 60 * 1000;
const GRAYSCALE_AGENT_IDLE_TIMEOUT_MS = Number(process.env.GRAYSCALE_AGENT_IDLE_TIMEOUT_MS) || 45 * 1000;

class GrayscaleAgentTimeoutError extends Error {
    constructor(message = 'agent execution timed out') {
        super(message);
        this.name = 'GrayscaleAgentTimeoutError';
    }
}

class GrayscaleAgentInteractionError extends Error {
    readonly failureType: RunFailureType;

    constructor(failureType: RunFailureType, message: string) {
        super(message);
        this.name = 'GrayscaleAgentInteractionError';
        this.failureType = failureType;
    }
}

function activeRuns(): Map<string, ActiveGrayscaleRun> {
    if (!globalThis.__grayscaleRunStore) globalThis.__grayscaleRunStore = new Map();
    return globalThis.__grayscaleRunStore;
}

function safeParse<T>(value: string | null | undefined, fallback: T): T {
    if (!value) return fallback;
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function buildEvaluationClaimId(): string {
    return `gclaim_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
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
        side: side as Side,
        runIndex,
        roundIndex,
        executionTraceId,
        evaluationClaimId,
        evaluationAttempt,
    };
}

function readGrayscaleBindingFromRawAnalysisJson(rawAnalysisJson: string | null | undefined): GrayscaleBinding | null {
    const raw = safeParse<Record<string, unknown> | null>(rawAnalysisJson, null);
    return raw && typeof raw === 'object' ? normalizeGrayscaleBinding(raw.grayscaleBinding) : null;
}

function readGrayscaleBindingFromRaw(rawAnalysis: unknown): GrayscaleBinding | null {
    return normalizeGrayscaleBinding(
        rawAnalysis && typeof rawAnalysis === 'object' && !Array.isArray(rawAnalysis)
            ? (rawAnalysis as Record<string, unknown>).grayscaleBinding
            : null,
    );
}

function matchesGrayscaleBinding(
    binding: GrayscaleBinding | null,
    args: {
        taskId: string;
        caseId: string;
        side: Side;
        run: Pick<RunResult, 'runIndex' | 'roundIndex' | 'sessionId' | 'evaluationClaimId'>;
        expectedClaimId?: string;
    },
): boolean {
    if (!binding) return false;
    return binding.source === 'grayscale-ab'
        && binding.grayscaleTaskId === args.taskId
        && binding.caseId === args.caseId
        && binding.side === args.side
        && binding.runIndex === args.run.runIndex
        && binding.roundIndex === args.run.roundIndex
        && binding.executionTraceId === String(args.run.sessionId || '').trim()
        && binding.evaluationClaimId === String(args.expectedClaimId || args.run.evaluationClaimId || '').trim();
}

function findRunIndex(runs: RunResult[] | undefined, target: Pick<RunResult, 'runIndex' | 'roundIndex' | 'caseId'>): number {
    return (runs || []).findIndex(run => (
        run.runIndex === target.runIndex
        && run.roundIndex === target.roundIndex
        && run.caseId === target.caseId
    ));
}

function scoreTier(score: number): 'good' | 'warn' | 'poor' {
    return score >= 80 ? 'good' : score >= 50 ? 'warn' : 'poor';
}

function normalizeAbEvaluators(value: unknown, fallback?: string): string[] {
    const raw = Array.isArray(value) ? value : value ? [value] : [];
    const ids = Array.from(new Set(
        raw.map(item => String(item || '').trim())
            .map(item => item === 'trace-quality-evaluator' ? TRACE_EVALUATOR_ID : item)
            .filter(item => SUPPORTED_AB_EVALUATORS.has(item)),
    ));
    if (ids.length > 0) return ids;
    const fallbackId = fallback === 'trace-quality-evaluator' ? TRACE_EVALUATOR_ID : String(fallback || '').trim();
    return SUPPORTED_AB_EVALUATORS.has(fallbackId) ? [fallbackId] : [];
}

function getConfiguredDatasetIds(config: GrayscaleConfig): string[] {
    return Array.from(new Set([
        ...(Array.isArray(config.linkedDatasetIds) ? config.linkedDatasetIds : []),
        config.selectedDatasetId || '',
    ].map(item => String(item || '').trim()).filter(Boolean)));
}

async function loadConfiguredCaseMap(user: string, config: GrayscaleConfig): Promise<Map<string, { datasetId: string; caseEntry: DatasetCase }>> {
    const datasetIds = getConfiguredDatasetIds(config);
    const caseMap = new Map<string, { datasetId: string; caseEntry: DatasetCase }>();
    for (const datasetId of datasetIds) {
        const dataset = await findAgentDataset(user, datasetId).catch(() => null);
        if (!dataset) continue;
        for (const caseEntry of dataset.cases) {
            if (!caseMap.has(caseEntry.id)) {
                caseMap.set(caseEntry.id, { datasetId: dataset.id, caseEntry });
            }
        }
    }
    return caseMap;
}

function aggregateEvaluationScore(evaluations: RunEvaluation[] | undefined): number | undefined {
    const scores = (evaluations || [])
        .filter(item => item.status === 'done' && typeof item.score === 'number' && Number.isFinite(item.score))
        .map(item => item.score as number);
    if (scores.length === 0) return undefined;
    return Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
}

function getFailedOrMissingEvaluatorIds(run: RunResult, evaluatorIds: string[]): string[] {
    const existing = new Map((run.evaluations || []).map(item => [item.evaluatorId, item]));
    return evaluatorIds.filter(id => {
        const item = existing.get(id);
        return !item || item.status === 'failed' || item.status === 'pending';
    });
}

function pickNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pickEvaluationResultScore(rawAnalysisJson: string | null | undefined): number | null {
    const raw = safeParse<Record<string, unknown> | null>(rawAnalysisJson, null);
    if (!raw || typeof raw !== 'object') return null;
    const resultEvaluation = raw.resultEvaluation && typeof raw.resultEvaluation === 'object'
        ? raw.resultEvaluation as Record<string, unknown>
        : null;
    return pickNumber(resultEvaluation?.score) ?? pickNumber(raw.score);
}

function pickEvaluationTraceId(rawAnalysisJson: string | null | undefined): string {
    const raw = safeParse<Record<string, unknown> | null>(rawAnalysisJson, null);
    if (!raw || typeof raw !== 'object') return '';
    const resultEvaluation = raw.resultEvaluation && typeof raw.resultEvaluation === 'object'
        ? raw.resultEvaluation as Record<string, unknown>
        : null;
    const candidates = [
        raw.evaluatorSessionId,
        resultEvaluation?.evaluatorSessionId,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    return '';
}

function pickTraceEvaluationTraceId(rawAnalysisJson: string | null | undefined): string {
    const raw = safeParse<Record<string, unknown> | null>(rawAnalysisJson, null);
    if (!raw || typeof raw !== 'object') return '';
    const candidate = raw.evaluatorSessionId;
    return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : '';
}

function buildRunEvaluationsFromRow(row: TrajectoryResultRow, requestedEvaluatorIds?: string[]): RunEvaluation[] {
    const selected = normalizeAbEvaluators(
        requestedEvaluatorIds && requestedEvaluatorIds.length > 0
            ? requestedEvaluatorIds
            : selectedEvaluators(row.rawAnalysisJson),
    );
    const resultScore = pickEvaluationResultScore(row.rawAnalysisJson);
    const resultError = pickResultEvaluationError(row.rawAnalysisJson);
    const resultTraceId = pickEvaluationTraceId(row.rawAnalysisJson);
    const traceScore = typeof row.trajectoryScore === 'number' ? row.trajectoryScore : null;
    const traceTraceId = pickTraceEvaluationTraceId(row.rawAnalysisJson);
    return selected.map(evaluatorId => {
        if (row.status === 'pending' || row.status === 'running') {
            return {
                evaluatorId,
                evaluatorName: AB_EVALUATOR_NAMES[evaluatorId] || evaluatorId,
                status: row.status === 'running' ? 'running' : 'pending',
                evaluatorRunId: row.evaluatorRunId,
                evaluationResultId: row.id,
            };
        }
        if (evaluatorId === TASK_COMPLETION_EVALUATOR_ID) {
            const score = typeof resultScore === 'number' ? Math.round(resultScore * 100) : undefined;
            const failed = row.status === 'failed' || typeof score !== 'number';
            return {
                evaluatorId,
                evaluatorName: AB_EVALUATOR_NAMES[evaluatorId],
                status: failed ? 'failed' : 'done',
                evaluatorRunId: row.evaluatorRunId,
                evaluationResultId: row.id,
                evaluationTraceId: resultTraceId || undefined,
                score,
                errorMessage: failed ? (resultError || row.errorMessage || '任务完成度评测失败') : undefined,
            };
        }
        const score = typeof traceScore === 'number' ? Math.round(traceScore * 100) : undefined;
        const failed = row.status === 'failed' || typeof score !== 'number';
        return {
            evaluatorId,
            evaluatorName: AB_EVALUATOR_NAMES[evaluatorId] || evaluatorId,
            status: failed ? 'failed' : 'done',
            evaluatorRunId: row.evaluatorRunId,
            evaluationResultId: row.id,
            evaluationTraceId: traceTraceId || undefined,
            score,
            errorMessage: failed ? (row.errorMessage || '轨迹质量评测失败') : undefined,
        };
    });
}

function isNewerTrajectoryRow(candidate: TrajectoryResultRow, current: TrajectoryResultRow | undefined): boolean {
    if (!current) return true;
    const candidateTime = candidate.updatedAt instanceof Date ? candidate.updatedAt.getTime() : 0;
    const currentTime = current.updatedAt instanceof Date ? current.updatedAt.getTime() : 0;
    return candidateTime >= currentTime;
}

function mergeRunEvaluations(existing: RunEvaluation[] | undefined, incoming: RunEvaluation[]): RunEvaluation[] {
    const byId = new Map<string, RunEvaluation>();
    for (const item of existing || []) {
        if (SUPPORTED_AB_EVALUATORS.has(item.evaluatorId)) byId.set(item.evaluatorId, item);
    }
    for (const item of incoming) byId.set(item.evaluatorId, item);
    return Array.from(byId.values());
}

function getResultEvaluation(rawAnalysisJson: string | null | undefined): Record<string, unknown> | null {
    const raw = safeParse<Record<string, unknown> | null>(rawAnalysisJson, null);
    if (!raw || typeof raw !== 'object') return null;
    return raw.resultEvaluation && typeof raw.resultEvaluation === 'object'
        ? raw.resultEvaluation as Record<string, unknown>
        : null;
}

function pickResultEvaluationError(rawAnalysisJson: string | null | undefined): string {
    const raw = safeParse<Record<string, unknown> | null>(rawAnalysisJson, null);
    const value = raw && typeof raw === 'object' ? raw.resultEvaluationError : null;
    return typeof value === 'string' ? value.trim() : '';
}

function selectedEvaluators(rawAnalysisJson: string | null | undefined): string[] {
    const raw = safeParse<Record<string, unknown> | null>(rawAnalysisJson, null);
    const value = raw && typeof raw === 'object' ? raw.selectedEvaluators : null;
    return Array.isArray(value)
        ? value.map(item => String(item || '').trim()).filter(Boolean)
        : [];
}

function isIncompleteDoneEvaluation(row: TrajectoryResultRow): string {
    if (row.status !== 'done') return '';
    const evaluators = selectedEvaluators(row.rawAnalysisJson);
    const requiresEvaluatorTrace = evaluators.some(id => (
        id === 'preset-agent-task-completion'
        || id === 'preset-agent-trace-quality'
        || id === 'trace-quality-evaluator'
    ));
    const hasScore = typeof row.trajectoryScore === 'number'
        || pickEvaluationResultScore(row.rawAnalysisJson) != null
        || buildRunEvaluationsFromRow(row).some(item => item.status === 'done' && typeof item.score === 'number');
    const hasResultEvaluation = Boolean(getResultEvaluation(row.rawAnalysisJson));
    const hasEvaluationTrace = Boolean(pickEvaluationTraceId(row.rawAnalysisJson));
    if (requiresEvaluatorTrace && !hasEvaluationTrace) {
        const detail = pickResultEvaluationError(row.rawAnalysisJson);
        return detail || '评测完成记录缺少评测 session id';
    }
    if (hasScore && (hasResultEvaluation || hasEvaluationTrace)) return '';

    const detail = pickResultEvaluationError(row.rawAnalysisJson);
    return detail || '评测完成记录缺少评测输出或评测 session id';
}

function truncateForRunLog(value: unknown, maxLength = 240): string {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    if (!text) return '';
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

async function persistGrayscaleFallbackTrace(args: {
    sessionId: string;
    user: string;
    query: string;
    output: string;
    agentName: string;
    skill?: string;
    skillVersion?: number | null;
}) {
    const query = args.query.trim();
    const output = args.output.trim();
    if (!args.sessionId || (!query && !output)) return;
    const timestamp = new Date().toISOString();
    await saveExecutionRecord({
        task_id: args.sessionId,
        upload_id: args.sessionId,
        query: query || undefined,
        framework: 'opencode',
        user: args.user,
        agent: args.agentName,
        agentName: args.agentName,
        final_result: output || undefined,
        skill: args.skill,
        skill_version: args.skillVersion ?? undefined,
        interactions: [
            ...(query ? [{ role: 'user', content: query, timestamp }] : []),
            ...(output ? [{ role: 'assistant', content: output, timestamp, agent: args.agentName }] : []),
        ],
        skip_evaluation: true,
        skip_internal_judgment: true,
        failures: [],
        skill_issues: [],
        force_query_update: true,
        opencode_cli_completed: true,
    });
}

function buildGrayscaleExecutionSystem(version: ResolvedVersion): string {
    const common = [
        '你当前处于自动化 A/B 灰度测评后台执行环境。',
        '这是非交互运行：没有用户窗口，也没有人工确认通道。',
        '禁止向用户提问，禁止请求人工确认，禁止等待外部输入。',
        '如果某个工具、文件、目录、网络或系统能力不可用，立即停止依赖该能力的路径，直接在最终答案中说明受限原因。',
        '不要反复重试同一个权限受限、不可读、超时或需要确认的操作。',
        '不要读取当前任务无关的外部目录或文件；只使用当前 workspace、已加载 Skill、用户输入和可直接访问的信息。',
        '最终答案必须直接回应用户原始输入；若因环境限制无法完成，给出简短、明确的失败原因。',
    ].join('\n');

    if (version) {
        return `${common}\n你是 B 侧 Skill 执行 Agent：必须按已加载 Skill 的流程执行任务。`;
    }
    return `${common}\n你是 A 侧基线对照 Agent：不加载任何 Skill，仅基于模型自身知识直接回答用户问题。`;
}

function summarizeBlockedInteraction(result: Awaited<ReturnType<typeof runGeneralAgent>>): { failureType: RunFailureType; message: string } | null {
    const permission = result.interactions.find(item => item.kind === 'permission' && item.reply === 'reject');
    if (permission) {
        const title = truncateForRunLog(permission.meta?.title || permission.meta?.type || 'permission');
        const pattern = truncateForRunLog(permission.meta?.pattern || '');
        return {
            failureType: 'permission_blocked',
            message: `permission_blocked: ${title}${pattern ? ` (${pattern})` : ''}`,
        };
    }

    const question = result.interactions.find(item => item.kind === 'question');
    if (question) {
        return {
            failureType: 'question_blocked',
            message: 'question_blocked: background A/B execution cannot answer agent questions',
        };
    }

    return null;
}

function classifyAgentRunError(err: unknown): { failureType: RunFailureType; message: string } {
    if (err instanceof GrayscaleAgentInteractionError) {
        return { failureType: err.failureType, message: err.message };
    }
    if (err instanceof GrayscaleAgentTimeoutError) {
        return { failureType: 'agent_timeout', message: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/timeout|timed out|aborted/i.test(message)) {
        return { failureType: 'agent_timeout', message };
    }
    if (/permission|denied|not allowed|unauthorized|forbidden/i.test(message)) {
        return { failureType: 'permission_blocked', message };
    }
    return { failureType: 'agent_error', message };
}

function extractTokenUsage(stats: unknown): number {
    const obj = (stats || {}) as { totalTokens?: unknown; tokenUsage?: unknown; tokens?: unknown; toolCallCount?: unknown };
    const candidates = [obj.totalTokens, obj.tokenUsage, obj.tokens];
    for (const value of candidates) {
        if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
        if (value && typeof value === 'object') {
            const tokenObj = value as Record<string, unknown>;
            const sum = ['input', 'output', 'reasoning', 'cache'].reduce((acc, key) => {
                const n = tokenObj[key];
                return acc + (typeof n === 'number' && Number.isFinite(n) ? n : 0);
            }, 0);
            if (sum > 0) return Math.round(sum);
        }
    }
    return 0;
}

function normalizeExecutionLatencySeconds(latency: number | null | undefined): number | null {
    if (typeof latency !== 'number' || !Number.isFinite(latency) || latency <= 0) return null;
    return latency > 1000 ? latency / 1000 : latency;
}

function pickExecutionTokenUsage(row: ExecutionMetricRow): number | null {
    if (typeof row.tokens === 'number' && Number.isFinite(row.tokens) && row.tokens > 0) {
        return Math.round(row.tokens);
    }
    const tokenFields: Array<number | null | undefined> = [
        row.inputTokens,
        row.outputTokens,
        row.cacheReadInputTokens,
        row.cacheCreationInputTokens,
        row.reasoningTokens,
    ];
    const total = tokenFields.reduce<number>((sum, value) => (
        sum + (typeof value === 'number' && Number.isFinite(value) ? value : 0)
    ), 0);
    return total > 0 ? Math.round(total) : null;
}

async function loadTask(taskId: string, user: string) {
    const task = await (prisma as unknown as GrayscalePrisma).grayscaleTask.findFirst({ where: { id: taskId, user } });
    if (!task) return null;
    const configJson = withDefaultConfig(safeParse<GrayscaleConfig>(task.configJson, {}));
    if (!configJson.skillId && task.skillId) configJson.skillId = task.skillId;
    if (!configJson.versionBId && task.skillVersionId) configJson.versionBId = task.skillVersionId;
    return {
        ...task,
        configJson,
        caseStatesJson: safeParse<CaseStates>(task.caseStatesJson, {}),
        // 读到的原始 caseStatesJson 串, 用于整份回写时的乐观锁 compare-and-swap。
        rawCaseStatesJson: task.caseStatesJson,
    };
}

/**
 * 整份回写 caseStatesJson。传 expectedCaseStatesJson 时走乐观锁: 仅当库里的
 * caseStatesJson 仍等于我们读到的快照才写入, 否则返回 false(说明期间有别的
 * writer 改过, 我们这份是基于旧快照算的, 不能覆盖)。不传则无条件写(向后兼容)。
 */
async function persistTaskState(
    taskId: string,
    user: string,
    config: GrayscaleConfig,
    states: CaseStates,
    expectedCaseStatesJson?: string,
): Promise<boolean> {
    const res = await (prisma as unknown as GrayscalePrisma).grayscaleTask.updateMany({
        where: {
            id: taskId,
            user,
            ...(expectedCaseStatesJson != null ? { caseStatesJson: expectedCaseStatesJson } : {}),
        },
        data: {
            configJson: JSON.stringify(withDefaultConfig(config)),
            caseStatesJson: JSON.stringify(states),
        },
    });
    return res.count > 0;
}

/** 构造 GET 响应: 去掉仅供内部乐观锁用的 rawCaseStatesJson, 不外泄到前端 payload。 */
function respondTask(
    task: NonNullable<Awaited<ReturnType<typeof loadTask>>>,
    activeRun: ActiveGrayscaleRun | null,
) {
    const { rawCaseStatesJson, ...rest } = task;
    void rawCaseStatesJson;
    return NextResponse.json({ ...rest, activeRun });
}

async function persistRunStatePatch(args: {
    taskId: string;
    user: string;
    config: GrayscaleConfig;
    states: CaseStates;
    caseId: string;
    side: Side;
    nextRun: RunResult;
    expectedEvaluationClaimId?: string;
    sidePatch?: Partial<PerVersionState>;
    touchLatestResultAt?: boolean;
}): Promise<boolean> {
    ensureCaseState(args.states, args.caseId);
    const localSide = args.states[args.caseId][args.side];
    const localIndex = findRunIndex(localSide.runs, args.nextRun);
    if (localIndex >= 0) {
        localSide.runs![localIndex] = cloneJson(args.nextRun);
    }
    if (args.sidePatch) Object.assign(localSide, args.sidePatch);
    args.states[args.caseId][args.side] = rebuildSideAggregate(
        localSide,
        localSide.runCount || localSide.runs?.length || 0,
    );

    // 乐观锁 + 重试: 每次都重新 load 一份最新快照, 把本次 nextRun 合并进去, 再以
    // 读到的原始 JSON 串做 CAS 写入。若期间别的并发 flow 改了同一 task(CAS 落空),
    // 就重新 load 再算一遍, 直到写成功或重试用尽 —— 杜绝"后写覆盖前写"的 lost update。
    for (let attempt = 0; attempt < PERSIST_CAS_MAX_RETRIES; attempt++) {
        const latestTask = await loadTask(args.taskId, args.user);
        if (!latestTask) return false;
        ensureCaseState(latestTask.caseStatesJson, args.caseId);
        const latestSide = latestTask.caseStatesJson[args.caseId][args.side];
        const latestIndex = findRunIndex(latestSide.runs, args.nextRun);
        if (latestIndex < 0) return false;

        const currentRun = latestSide.runs![latestIndex];
        if (
            args.expectedEvaluationClaimId
            && currentRun.evaluationClaimId
            && currentRun.evaluationClaimId !== args.expectedEvaluationClaimId
        ) {
            args.states[args.caseId][args.side] = cloneJson(latestTask.caseStatesJson[args.caseId][args.side]);
            return false;
        }

        latestSide.runs![latestIndex] = cloneJson(args.nextRun);
        if (args.sidePatch) Object.assign(latestSide, args.sidePatch);
        latestTask.caseStatesJson[args.caseId][args.side] = rebuildSideAggregate(
            latestSide,
            latestSide.runCount || latestSide.runs?.length || 0,
        );
        if (args.touchLatestResultAt) markLatestGrayResultAt(latestTask.configJson);
        const written = await persistTaskState(
            args.taskId,
            args.user,
            latestTask.configJson,
            latestTask.caseStatesJson,
            latestTask.rawCaseStatesJson,
        );
        if (written) {
            // 把刚落库的权威结果同步回内存共享对象, 让 caller 继续用最新值。
            args.states[args.caseId][args.side] = cloneJson(latestTask.caseStatesJson[args.caseId][args.side]);
            return true;
        }
        // CAS 落空, 退避一小下再重试(带递增 jitter, 避免 hot loop)。
        await new Promise(resolve => setTimeout(resolve, 15 + attempt * 20));
    }
    return false;
}

function markLatestGrayResultAt(config: GrayscaleConfig) {
    config.latestResultAt = new Date().toISOString();
}

function markRunCompleted(run: RunResult, completedAt = new Date().toISOString()) {
    run.completedAt = completedAt;
}

function applyTrajectoryRowToRun(run: RunResult, row: TrajectoryResultRow, fallbackEvaluatorRunId?: string) {
    const nextEvaluations = mergeRunEvaluations(run.evaluations, buildRunEvaluationsFromRow(row));
    const nextScore = aggregateEvaluationScore(nextEvaluations);
    const hasFailedEvaluation = nextEvaluations.some(item => item.status === 'failed');
    const hasRunningEvaluation = nextEvaluations.some(item => item.status === 'pending' || item.status === 'running');
    run.evaluatorRunId = row.evaluatorRunId || fallbackEvaluatorRunId || run.evaluatorRunId;
    run.evaluationResultId = row.id || run.evaluationResultId;
    run.evaluationTraceId = pickEvaluationTraceId(row.rawAnalysisJson) || pickTraceEvaluationTraceId(row.rawAnalysisJson) || run.evaluationTraceId;
    run.evaluations = nextEvaluations;
    run.status = hasRunningEvaluation
        ? 'evaluating'
        : hasFailedEvaluation
            ? 'fail'
            : typeof nextScore === 'number'
                ? 'pass'
                : 'fail';
    if (typeof nextScore === 'number') {
        run.score = nextScore;
        run.tier = scoreTier(nextScore);
    } else {
        delete run.score;
        delete run.tier;
    }
    if (run.status === 'fail') {
        run.output = row.errorMessage
            || nextEvaluations.find(item => item.status === 'failed')?.errorMessage
            || run.output
            || '评测失败';
    }
    if (row.status === 'done' || row.status === 'failed') {
        markRunCompleted(run, row.updatedAt instanceof Date ? row.updatedAt.toISOString() : undefined);
    }
}

function validateTaskSkillBinding(task: Awaited<ReturnType<typeof loadTask>>) {
    if (!task?.skillId || !task.skillName || !task.skillVersionId || typeof task.skillVersion !== 'number') {
        throw new Error('task is not bound to a skill version');
    }
    const configSkillId = String(task.configJson.skillId || '').trim();
    if (configSkillId && configSkillId !== task.skillId) {
        throw new Error('task skill binding cannot be changed');
    }
    const configVersionBId = String(task.configJson.versionBId || '').trim();
    if (configVersionBId && configVersionBId !== task.skillVersionId) {
        throw new Error('task skill version binding cannot be changed');
    }
    task.configJson.skillId = task.skillId;
    task.configJson.versionBId = task.skillVersionId;
}

async function resolveVersion(skillId: string | undefined, versionId: string | undefined) {
    if (!skillId || !versionId || versionId === NONE_VERSION_ID) return null;
    const version = await (prisma as unknown as GrayscalePrisma).skillVersion.findFirst({
        where: { id: versionId, skillId },
        include: { Skill: true },
    });
    if (!version?.Skill?.name) return null;
    return {
        skillName: String(version.Skill.name),
        version: Number(version.version),
    };
}

function ensureCaseState(states: CaseStates, caseId: string) {
    if (!states[caseId]) {
        states[caseId] = { a: { status: 'pending', runs: [] }, b: { status: 'pending', runs: [] } };
    }
    if (!states[caseId].a.runs) states[caseId].a.runs = [];
    if (!states[caseId].b.runs) states[caseId].b.runs = [];
}

function hasAnyRunningCaseStates(states: CaseStates): boolean {
    return Object.values(states).some(state => (
        (['a', 'b'] as Side[]).some(side => (
            state[side].status === 'running'
            || state[side].status === 'evaluating'
            || (state[side].runs || []).some(run => run.status === 'running' || run.status === 'evaluating')
        ))
    ));
}

function isRecoverableInterruptedRun(run: RunResult): boolean {
    if (run.status !== 'fail' || run.sessionId) return false;
    const detail = `${run.failureDetail || ''}\n${run.output || ''}`;
    return run.failureType === 'agent_error' && /服务重启中断|server .*restart|restarted/i.test(detail);
}

function getAutoEvaluationBacklogCaseIds(states: CaseStates): string[] {
    return Object.entries(states)
        .filter(([, state]) => (
            (['a', 'b'] as Side[]).some(side => (
                (state[side].runs || []).some(run => (
                    run.status === 'executed'
                    && Boolean(run.sessionId)
                    && !run.evaluatorRunId
                    && typeof run.score !== 'number'
                ))
            ))
        ))
        .map(([caseId]) => caseId);
}

function rebuildSideAggregate(state: PerVersionState, totalRuns: number): PerVersionState {
    const runs = state.runs || [];
    const expectedRuns = Math.max(0, Number(totalRuns) || 0);
    const aggregateRuns = expectedRuns > 0 && runs.length > expectedRuns
        ? runs.slice(-expectedRuns)
        : runs;
    const effectiveTotalRuns = expectedRuns || aggregateRuns.length;
    const finished = aggregateRuns.filter(r => r.status === 'executed' || r.status === 'pass');
    const executionFinished = aggregateRuns.filter(r => (
        r.status === 'executed'
        || r.status === 'evaluating'
        || r.status === 'pass'
        || (r.status === 'fail' && Boolean(r.sessionId))
    ));
    const failed = aggregateRuns.filter(r => r.status === 'fail');
    const evaluating = aggregateRuns.some(r => r.status === 'evaluating');
    const running = aggregateRuns.some(r => r.status === 'running' || r.status === 'pending');
    const scored = aggregateRuns.filter(r => typeof r.score === 'number');
    const seconds = executionFinished
        .map(r => typeof r.timeCost === 'string' ? Number.parseFloat(r.timeCost) : 0)
        .filter(n => Number.isFinite(n) && n > 0);
    const avgSeconds = seconds.length > 0 ? seconds.reduce((a, b) => a + b, 0) / seconds.length : 0;
    const tokenRuns = executionFinished.filter(r => typeof r.tokenUsage === 'number');
    const avgTokens = tokenRuns.length > 0
        ? Math.round(tokenRuns.reduce((sum, r) => sum + (r.tokenUsage || 0), 0) / tokenRuns.length)
        : 0;
    const avgScore = scored.length > 0
        ? Math.round(scored.reduce((sum, r) => sum + (r.score || 0), 0) / scored.length)
        : undefined;
    const traceIds = executionFinished.map(r => r.sessionId).filter(Boolean) as string[];
    const toolCallCount = executionFinished.reduce((sum, r) => sum + (r.toolCallCount || 0), 0);
    const toolCalls = Array.from(new Set(executionFinished.flatMap(r => r.toolCalls || []))).slice(0, 8);

    let status: CaseStatus = 'pending';
    if (scored.length >= effectiveTotalRuns && effectiveTotalRuns > 0) status = 'pass';
    else if (failed.length >= effectiveTotalRuns && effectiveTotalRuns > 0) status = 'fail';
    else if (finished.length + failed.length >= effectiveTotalRuns && effectiveTotalRuns > 0) status = 'executed';
    else if (evaluating) status = 'evaluating';
    else if (running || finished.length > 0) status = 'running';

    return {
        ...state,
        status,
        runs,
        runCount: totalRuns,
        timeCost: seconds.length > 0 ? `${avgSeconds.toFixed(1)}s` : undefined,
        tokenUsage: avgTokens || undefined,
        output: [...executionFinished].reverse()[0]?.output || state.output,
        sessionId: traceIds[0] || state.sessionId,
        traceIds,
        score: avgScore,
        tier: avgScore == null ? undefined : scoreTier(avgScore),
        skillTriggered: executionFinished.some(r => r.skillTriggered),
        toolCallCount,
        toolCalls,
    };
}

async function hydrateExecutionMetrics(states: CaseStates): Promise<boolean> {
    const sessionIds = Array.from(new Set(
        Object.values(states)
            .flatMap(state => (['a', 'b'] as Side[]).flatMap(side => state[side].runs || []))
            .map(run => run.sessionId)
            .filter((id): id is string => Boolean(id)),
    ));
    if (sessionIds.length === 0) return false;

    const rows = await (prisma as unknown as GrayscalePrisma).execution.findMany({
        where: { taskId: { in: sessionIds } },
        select: {
            taskId: true,
            latency: true,
            tokens: true,
            inputTokens: true,
            outputTokens: true,
            cacheReadInputTokens: true,
            cacheCreationInputTokens: true,
            reasoningTokens: true,
        },
    });
    if (rows.length === 0) return false;

    const metricsBySessionId = new Map<string, { timeCost?: string; tokenUsage?: number }>();
    for (const row of rows) {
        if (!row.taskId) continue;
        const latencySeconds = normalizeExecutionLatencySeconds(row.latency);
        const tokenUsage = pickExecutionTokenUsage(row);
        metricsBySessionId.set(row.taskId, {
            timeCost: latencySeconds == null ? undefined : `${latencySeconds.toFixed(1)}s`,
            tokenUsage: tokenUsage == null ? undefined : tokenUsage,
        });
    }

    let changed = false;
    for (const state of Object.values(states)) {
        for (const side of ['a', 'b'] as Side[]) {
            let sideChanged = false;
            for (const run of state[side].runs || []) {
                if (!run.sessionId) continue;
                const metrics = metricsBySessionId.get(run.sessionId);
                if (!metrics) continue;
                if (metrics.timeCost && run.timeCost !== metrics.timeCost) {
                    run.timeCost = metrics.timeCost;
                    sideChanged = true;
                }
                if (typeof metrics.tokenUsage === 'number' && run.tokenUsage !== metrics.tokenUsage) {
                    run.tokenUsage = metrics.tokenUsage;
                    sideChanged = true;
                }
            }
            if (sideChanged) {
                state[side] = rebuildSideAggregate(state[side], state[side].runCount || state[side].runs?.length || 0);
                changed = true;
            }
        }
    }
    return changed;
}

function normalizeText(value: unknown): string {
    return String(value || '').trim();
}

function timestampMs(value: ExecutionMetricRow['timestamp']): number {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
}

async function reconcileFinishedExecutions(args: {
    user: string;
    config: GrayscaleConfig;
    states: CaseStates;
}): Promise<boolean> {
    const caseConfigMap = await loadConfiguredCaseMap(args.user, args.config);
    if (caseConfigMap.size === 0) return false;

    const pendingTargets: Array<{ caseId: string; side: Side; run: RunResult; query: string; version: ResolvedVersion }> = [];
    const versionA = await resolveVersion(args.config.skillId, args.config.versionAId);
    const versionB = await resolveVersion(args.config.skillId, args.config.versionBId);
    const claimedSessionIds = new Set(
        Object.values(args.states)
            .flatMap(state => (['a', 'b'] as Side[]).flatMap(side => state[side].runs || []))
            .map(run => run.sessionId)
            .filter((id): id is string => Boolean(id)),
    );

    for (const [caseId, state] of Object.entries(args.states)) {
        const query = normalizeText(caseConfigMap.get(caseId)?.caseEntry.input);
        if (!query) continue;
        for (const side of ['a', 'b'] as Side[]) {
            const version = side === 'a' ? versionA : versionB;
            for (const run of state[side].runs || []) {
                if (run.sessionId) continue;
                if (run.status !== 'running' && !isRecoverableInterruptedRun(run)) continue;
                pendingTargets.push({ caseId, side, run, query, version });
            }
        }
    }
    if (pendingTargets.length === 0) return false;

    const rows = await (prisma as unknown as GrayscalePrisma).execution.findMany({
        where: {
            user: args.user,
            agentName: { in: ['grayscale-baseline-agent', 'grayscale-skill-agent'] },
        },
        select: {
            taskId: true,
            query: true,
            agentName: true,
            finalResult: true,
            skill: true,
            skillVersion: true,
            latency: true,
            tokens: true,
            toolCallCount: true,
            timestamp: true,
            inputTokens: true,
            outputTokens: true,
            cacheReadInputTokens: true,
            cacheCreationInputTokens: true,
            reasoningTokens: true,
        },
    });
    if (rows.length === 0) return false;

    const sortedRows = [...rows].sort((a, b) => timestampMs(b.timestamp) - timestampMs(a.timestamp));
    let changed = false;
    for (const target of pendingTargets) {
        const expectedAgentName = target.version ? 'grayscale-skill-agent' : 'grayscale-baseline-agent';
        const row = sortedRows.find(candidate => {
            if (!candidate.taskId || claimedSessionIds.has(candidate.taskId)) return false;
            if (candidate.agentName !== expectedAgentName) return false;
            if (normalizeText(candidate.query) !== target.query) return false;
            if (!target.version) return !normalizeText(candidate.skill);
            return normalizeText(candidate.skill) === target.version.skillName
                && Number(candidate.skillVersion) === Number(target.version.version);
        });
        if (!row?.taskId) continue;

        target.run.status = 'executed';
        target.run.sessionId = row.taskId;
        target.run.traceIds = [row.taskId];
        target.run.output = row.finalResult || target.run.output || '';
        const latencySeconds = normalizeExecutionLatencySeconds(row.latency);
        if (latencySeconds != null) target.run.timeCost = `${latencySeconds.toFixed(1)}s`;
        const tokenUsage = pickExecutionTokenUsage(row);
        if (tokenUsage != null) target.run.tokenUsage = tokenUsage;
        target.run.skillTriggered = Boolean(target.version);
        target.run.toolCallCount = typeof row.toolCallCount === 'number' ? row.toolCallCount : target.run.toolCallCount;
        claimedSessionIds.add(row.taskId);
        changed = true;
    }

    if (changed) {
        markLatestGrayResultAt(args.config);
        for (const state of Object.values(args.states)) {
            for (const side of ['a', 'b'] as Side[]) {
                state[side] = rebuildSideAggregate(state[side], state[side].runCount || state[side].runs?.length || 0);
            }
        }
    }
    return changed;
}

async function reconcileFinishedEvaluations(taskId: string, user: string, config: GrayscaleConfig, states: CaseStates): Promise<boolean> {
    const evaluatorRunIds = Array.from(new Set(
        Object.values(states)
            .flatMap(state => (['a', 'b'] as Side[]).flatMap(side => [
                state[side].evaluatorRunId,
                ...(state[side].runs || []).map(run => run.evaluatorRunId),
            ]))
            .filter((id): id is string => Boolean(id)),
    ));
    const evaluationResultIds = Array.from(new Set(
        Object.values(states)
            .flatMap(state => (['a', 'b'] as Side[]).flatMap(side =>
                (state[side].runs || []).map(run => run.evaluationResultId),
            ))
            .filter((id): id is string => Boolean(id)),
    ));
    if (evaluatorRunIds.length === 0 && evaluationResultIds.length === 0) return false;

    const rowSelectors: Record<string, unknown>[] = [];
    if (evaluatorRunIds.length > 0) rowSelectors.push({ evaluatorRunId: { in: evaluatorRunIds } });
    if (evaluationResultIds.length > 0) rowSelectors.push({ id: { in: evaluationResultIds } });
    const rows = await (prisma as unknown as GrayscalePrisma).trajectoryEvalResult.findMany({
        where: rowSelectors.length === 1
            ? { user, ...rowSelectors[0] }
            : { user, OR: rowSelectors },
    });
    if (rows.length === 0) return false;

    const staleRows: Array<{ row: typeof rows[number]; reason: string }> = [];
    for (const row of rows) {
        const incompleteDoneReason = isIncompleteDoneEvaluation(row);
        if (incompleteDoneReason) {
            staleRows.push({ row, reason: incompleteDoneReason });
            continue;
        }
        if (row.status !== 'pending' && row.status !== 'running') continue;
        const updatedAt = row.updatedAt instanceof Date ? row.updatedAt.getTime() : 0;
        if (updatedAt <= 0) continue;
        // 区分两种 stale 原因, 让 errorMessage 更易读 (用户看 modal hover 气泡就懂):
        //   - 15min 无更新 → 真卡死, 评估器进程还在但 hang 住
        //   - 早于 SERVER_START_TIME → server 重启遗弃, 评估器进程已经没了
        if (Date.now() - updatedAt > STALE_EVALUATION_MS) {
            staleRows.push({ row, reason: `评测超时(>${Math.round(STALE_EVALUATION_MS / 60000)}min 无进展)` });
        } else if (updatedAt < SERVER_START_TIME) {
            staleRows.push({ row, reason: '服务重启中断, 请重新评测' });
        }
    }
    if (staleRows.length > 0) {
        for (const { row, reason } of staleRows) {
            if (row.status === 'done' && row.id) {
                await markEvaluatorRowsFailedForce(user, [row.id], reason).catch(() => {});
            } else if (row.evaluatorRunId && row.taskId) {
                await markEvaluatorTasksFailed(user, row.evaluatorRunId, [row.taskId], reason).catch(() => {});
            } else if (row.id) {
                await markEvaluatorRowsFailed(user, [row.id], reason).catch(() => {});
            }
            row.status = 'failed';
            row.errorMessage = row.errorMessage || reason;
        }
    }

    const rowsById = new Map<string, TrajectoryResultRow>();
    const rowsByClaimId = new Map<string, TrajectoryResultRow>();
    for (const row of rows) {
        if (row.id) rowsById.set(row.id, row);
        const binding = readGrayscaleBindingFromRawAnalysisJson(row.rawAnalysisJson);
        const claimId = binding?.evaluationClaimId || '';
        if (claimId && isNewerTrajectoryRow(row, rowsByClaimId.get(claimId))) {
            rowsByClaimId.set(claimId, row);
        }
    }

    let changed = false;
    for (const state of Object.values(states)) {
        for (const side of ['a', 'b'] as Side[]) {
            for (const run of state[side].runs || []) {
                if (!run.sessionId) continue;
                const row = (run.evaluationResultId ? rowsById.get(run.evaluationResultId) : undefined)
                    || (run.evaluationClaimId ? rowsByClaimId.get(run.evaluationClaimId) : undefined);
                if (!row) continue;
                const binding = readGrayscaleBindingFromRawAnalysisJson(row.rawAnalysisJson);
                if (!matchesGrayscaleBinding(binding, { taskId, caseId: run.caseId, side, run })) {
                    continue;
                }
                const before = JSON.stringify({
                    status: run.status,
                    evaluatorRunId: run.evaluatorRunId,
                    evaluationResultId: run.evaluationResultId,
                    evaluationTraceId: run.evaluationTraceId,
                    score: run.score,
                    tier: run.tier,
                    evaluations: run.evaluations || [],
                    output: run.output,
                    completedAt: run.completedAt,
                });
                applyTrajectoryRowToRun(run, row, state[side].evaluatorRunId);
                if (
                    before !== JSON.stringify({
                        status: run.status,
                        evaluatorRunId: run.evaluatorRunId,
                        evaluationResultId: run.evaluationResultId,
                        evaluationTraceId: run.evaluationTraceId,
                        score: run.score,
                        tier: run.tier,
                        evaluations: run.evaluations || [],
                        output: run.output,
                        completedAt: run.completedAt,
                    })
                ) {
                    changed = true;
                }
            }
            const next = rebuildSideAggregate(state[side], state[side].runCount || state[side].runs?.length || 0);
            if (state[side].status !== next.status || state[side].score !== next.score) changed = true;
            state[side] = next;
        }
    }

    if (changed) markLatestGrayResultAt(config);

    return changed;
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>, signal?: AbortSignal) {
    const queue = [...items];
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
        while (queue.length > 0) {
            // signal 是任务级 abortController.signal, 用户点「终止」时 fires。
            // 这里早退一次 → 不再 dispatch 新 work, 已 in-flight 的等其自己结束。
            if (signal?.aborted) return;
            const item = queue.shift();
            if (!item) return;
            await worker(item);
        }
    });
    await Promise.all(workers);
}

type ResolvedVersion = Awaited<ReturnType<typeof resolveVersion>>;
type ExecutionTarget = { caseId: string; side: Side; roundIndex: number; runIndex: number; run: RunResult };
type EvaluationTarget = { caseId: string; side: Side; run: RunResult; evaluatorIds?: string[] };

async function executeSingleAgentRun(args: {
    taskId: string;
    user: string;
    config: GrayscaleConfig;
    states: CaseStates;
    caseMap: Map<string, DatasetCase>;
    totalRunsPerSide: number;
    version: ResolvedVersion;
    /**
     * 对照 skill 名: A/B 任务里"另一侧"的 skill, 用于 baseline 那一侧 (args.version=null)
     * 在 trace 上挂个 skill 标签, 让"从 Trace"按 skill 过滤能搜到。caller 传两边 skillName
     * 任一非空即可, 优先 B 侧。args.version 非 null 时不用此参数。
     */
    referenceSkillName?: string | null;
    target: ExecutionTarget;
    /** 任务级 abort 信号: 用户点终止时, 这里桥接到本次 chat 的 abortController, 让 opencode chat 提前返回。 */
    parentSignal?: AbortSignal;
}) {
    const { target } = args;
    const state = args.states[target.caseId];
    const run = target.run;
    run.status = 'running';
    run.executionAttempts = (run.executionAttempts || 0) + 1;
    delete run.evaluatorRunId;
    delete run.evaluationResultId;
    delete run.evaluationTraceId;
    delete run.score;
    delete run.tier;
    delete run.evaluations;
    delete run.sessionId;
    delete run.traceIds;
    delete run.tokenUsage;
    delete run.skillTriggered;
    delete run.toolCallCount;
    delete run.toolCalls;
    delete run.failureType;
    delete run.failureDetail;
    run.output = undefined;
    run.timeCost = undefined;
    state[target.side] = rebuildSideAggregate(state[target.side], args.totalRunsPerSide);
    await persistTaskState(args.taskId, args.user, args.config, args.states);

    const startedAt = Date.now();
    const toolCalls: string[] = [];
    let lastToolSummary = '';
    const abortController = new AbortController();
    // 监听任务级终止信号——用户在 UI 点「终止」按钮触发的 abort 通过这里传到本次 chat
    if (args.parentSignal) {
        if (args.parentSignal.aborted) {
            abortController.abort();
        } else {
            const onParentAbort = () => abortController.abort();
            args.parentSignal.addEventListener('abort', onParentAbort, { once: true });
        }
    }
    let didTimeout = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    // 持有 agentPromise 引用, 让 finally 在超时路径下也能等 ephemeral opencode 清理跑完 (见 finally 注释)。
    let pendingAgent: Promise<unknown> | undefined;
    try {
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutTimer = setTimeout(() => {
                didTimeout = true;
                abortController.abort();
                reject(new GrayscaleAgentTimeoutError(`agent_timeout: exceeded ${Math.round(GRAYSCALE_AGENT_TIMEOUT_MS / 1000)}s${lastToolSummary ? `; last_tool=${lastToolSummary}` : ''}`));
            }, GRAYSCALE_AGENT_TIMEOUT_MS);
        });
        const grayAgentName = args.version ? 'grayscale-skill-agent' : 'grayscale-baseline-agent';
        const agentPromise = runGeneralAgent({
            user: args.user,
            query: args.caseMap.get(target.caseId)!.input,
            skill: args.version?.skillName,
            skillVersion: args.version?.version,
            // 每组按"实际使用情况"绑定 trace 的 skill：本侧用了某 skill 版本就标该版本, 无 skill(baseline)
            // 就不标任何 skill。不再回退到 referenceSkillName(B 侧 skill)——否则无 skill 的对照组 trace 会被
            // 错绑到 B 的 skill, 在用例分析按 skill 筛选时和 B 一起冒出来 (期望只出真正用了该 skill 的 trace)。
            tagSkill: args.version?.skillName ?? undefined,
            system: buildGrayscaleExecutionSystem(args.version),
            interactionPolicy: 'auto-deny',
            systemAgentName: grayAgentName,
            // 后台批量任务: 每次起独立 opencode 进程,跑完杀,保证拿最新 skill 内容
            ephemeralServer: true,
            // 让 runGeneralAgent 跑完后内部 listMessages + saveExecutionRecord 写 Execution 行。
            // 不依赖 plugin/OTEL 上报, 避免新 grayscale session 在 DB 里查不到 → trace 详情跳转空跳。
            // 复用同事 821236e 引入的 recordEvaluatorExecution helper, 写入真实 trajectory。
            recordTraceAs: grayAgentName,
            sessionTitle: `grayscale ${target.side.toUpperCase()} r${target.roundIndex} · ${args.user} · ${args.taskId}`,
            workspaceTag: `grayscale-${args.taskId}-${target.side}-${target.caseId}-r${target.roundIndex}`,
            timeoutMs: GRAYSCALE_AGENT_TIMEOUT_MS,
            chatOptions: {
                idleTimeoutMs: GRAYSCALE_AGENT_IDLE_TIMEOUT_MS,
                signal: abortController.signal,
            },
            handlers: {
                onTool: e => {
                    if (e.phase === 'start' && e.name) toolCalls.push(e.name);
                    if (e.name) {
                        const status = e.status || e.phase;
                        lastToolSummary = `${e.name}:${status}`;
                    }
                },
            },
        });
        pendingAgent = agentPromise;
        void agentPromise.catch(() => {});
        const result = await Promise.race([agentPromise, timeoutPromise]);
        if (didTimeout) {
            throw new GrayscaleAgentTimeoutError(`agent_timeout: exceeded ${Math.round(GRAYSCALE_AGENT_TIMEOUT_MS / 1000)}s${lastToolSummary ? `; last_tool=${lastToolSummary}` : ''}`);
        }
        const blocked = summarizeBlockedInteraction(result);
        if (blocked) {
            throw new GrayscaleAgentInteractionError(blocked.failureType, blocked.message);
        }
        run.status = 'executed';
        run.output = result.output || '';
        run.timeCost = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
        run.tokenUsage = extractTokenUsage(result.stats);
        run.sessionId = result.sessionId;
        run.traceIds = [result.sessionId];
        run.skillTriggered = args.version ? toolCalls.includes('load_skill') || result.skillResolved : false;
        run.toolCallCount = result.stats?.toolCallCount || toolCalls.length;
        run.toolCalls = Array.from(new Set(toolCalls)).slice(0, 8);
        markRunCompleted(run);
        // runGeneralAgent 会尽量写入真实 opencode messages。这里再写一份 query/output
        // fallback，防止 ephemeral server 的 listMessages 返回空数组时 trace 详情页空白。
        await persistGrayscaleFallbackTrace({
            sessionId: result.sessionId,
            user: args.user,
            query: args.caseMap.get(target.caseId)!.input,
            output: result.output || '',
            agentName: grayAgentName,
            // 同上: 按本侧实际使用绑定, 无 skill(baseline)不绑, 不回退到 B 侧 skill。
            skill: args.version?.skillName ?? undefined,
            skillVersion: args.version?.version,
        });
    } catch (err) {
        const classified = classifyAgentRunError(err);
        run.status = 'fail';
        run.failureType = classified.failureType;
        run.failureDetail = lastToolSummary ? `${classified.message}; last_tool=${lastToolSummary}` : classified.message;
        run.output = run.failureDetail;
        run.timeCost = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
        run.toolCallCount = toolCalls.length;
        run.toolCalls = Array.from(new Set(toolCalls)).slice(0, 8);
        markRunCompleted(run);
    } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        // 关键(反孤儿/反泄漏): ephemeral opencode 的真正 kill 在 runGeneralAgent →
        // runWithEphemeralOpencodeServer 的 finally 里, 只有 agentPromise settle 后才发生。
        // 超时路径下 Promise.race 已先返回, 若不在这里等 agentPromise, 外层 withBackgroundOpencodeSlot
        // 会在 opencode 进程被杀掉之前就释放 slot → 超时任务的 opencode 溜到 slot 之外继续活/变孤儿,
        // 后续任务又 spawn 新的 → 堆叠。这里确保"进程清理在 slot 内完成才放行"。
        // abort 已触发让 chat 尽快收尾; terminateOpencodeProcess 自带 30s 硬上限, 不会无限等。
        abortController.abort();
        if (pendingAgent) { try { await pendingAgent; } catch { /* fn 的错误已在上面 catch 里分类处理过 */ } }
        markLatestGrayResultAt(args.config);
        state[target.side] = rebuildSideAggregate(state[target.side], args.totalRunsPerSide);
        await persistTaskState(args.taskId, args.user, args.config, args.states);
    }
}

async function startSingleEvaluation(
    origin: string,
    user: string,
    config: GrayscaleConfig,
    pair: { caseId: string; taskId: string },
    datasetId?: string,
    evaluatorId?: string,
    evaluatorIds?: string[],
    grayscaleBinding?: GrayscaleBinding,
    options: { appendToBatch?: boolean } = {},
) {
    // 透传评测任务关联: 用户在 A/B 配置卡通过「+ 新增评测任务」对话框创建了批次,
    // 此 ID 存在 config.evaluationBatchId。这里走 append 模式让 trace 落到同一批次,
    // 而不是每次启动评测都新建一个 evaluatorRunId (修 "2 case × 3 round 拆成 6 个批次" 问题)。
    //
    // evaluator 字段:
    //   - 关联了批次: 不传, 让后端继承批次创建时配置的 selectedEvaluators (多评估器)。
    //     这是用户在「新增评测任务」对话框里多选的评估器列表, 应该统一应用。
    //   - 没关联批次: 沿用老逻辑, 传单 evaluator 让后端新建批次 (向后兼容)。
    const body: Record<string, unknown> = {
        user,
        ...(datasetId ? { datasetId } : {}),
        ...(getConfiguredDatasetIds(config).length > 0 ? { datasetIds: getConfiguredDatasetIds(config) } : {}),
        pairs: [pair],
        ...(grayscaleBinding ? { grayscaleBinding } : {}),
        // 让评测批次名与 A/B 任务名一致: 建批次时后端用它当批次标题(append 到已有批次时后端忽略)。
        ...(config.evaluationBatchTitle ? { taskTitle: config.evaluationBatchTitle } : {}),
    };
    if (config.evaluationBatchId && options.appendToBatch !== false) {
        body.evaluatorRunId = config.evaluationBatchId;
    } else {
        body.evaluators = normalizeAbEvaluators(evaluatorIds || config.evaluators, evaluatorId || config.evaluatorId);
    }
    const res = await fetch(`${origin}/api/eval/trajectory/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.evaluatorRunId) {
        throw new Error(data.error || 'failed to start trajectory evaluation');
    }
    const created = Array.isArray(data.created) ? data.created : [];
    const evaluationResultId = created.length > 0 ? String(created[0]?.id || '').trim() : '';
    if (!evaluationResultId) {
        throw new Error('failed to bind trajectory evaluation result');
    }
    return {
        evaluatorRunId: String(data.evaluatorRunId),
        evaluationResultId,
    };
}

async function markEvaluatorRunFailed(user: string, evaluatorRunId: string, errorMessage: string) {
    await (prisma as unknown as GrayscalePrisma).trajectoryEvalResult.updateMany({
        where: {
            user,
            evaluatorRunId,
            status: { in: ['pending', 'running'] },
        },
        data: {
            status: 'failed',
            errorMessage,
        },
    });
}

async function markEvaluatorTasksFailed(user: string, evaluatorRunId: string, taskIds: string[], errorMessage: string) {
    const scopedTaskIds = Array.from(new Set(taskIds.map(id => id.trim()).filter(Boolean)));
    if (scopedTaskIds.length === 0) {
        await markEvaluatorRunFailed(user, evaluatorRunId, errorMessage);
        return;
    }
    await (prisma as unknown as GrayscalePrisma).trajectoryEvalResult.updateMany({
        where: {
            user,
            evaluatorRunId,
            taskId: { in: scopedTaskIds },
            status: { in: ['pending', 'running'] },
        },
        data: {
            status: 'failed',
            errorMessage,
        },
    });
}

async function markEvaluatorRowsFailed(user: string, rowIds: string[], errorMessage: string) {
    const scopedRowIds = Array.from(new Set(rowIds.map(id => id.trim()).filter(Boolean)));
    if (scopedRowIds.length === 0) return;
    await (prisma as unknown as GrayscalePrisma).trajectoryEvalResult.updateMany({
        where: {
            user,
            id: { in: scopedRowIds },
            status: { in: ['pending', 'running'] },
        },
        data: {
            status: 'failed',
            errorMessage,
        },
    });
}

async function markEvaluatorRowsFailedForce(user: string, rowIds: string[], errorMessage: string) {
    const scopedRowIds = Array.from(new Set(rowIds.map(id => id.trim()).filter(Boolean)));
    if (scopedRowIds.length === 0) return;
    await (prisma as unknown as GrayscalePrisma).trajectoryEvalResult.updateMany({
        where: {
            user,
            id: { in: scopedRowIds },
        },
        data: {
            status: 'failed',
            errorMessage,
        },
    });
}

async function evaluateSingleRunTarget(args: {
    taskId: string;
    user: string;
    origin: string;
    config: GrayscaleConfig;
    states: CaseStates;
    caseDatasetIdByCaseId?: Map<string, string>;
    evaluatorId?: string;
    evaluatorIds?: string[];
    appendToBatch?: boolean;
    target: EvaluationTarget;
}) {
    const { target } = args;
    let evaluatorRunId: string | undefined;
    let evaluationResultId: string | undefined;
    const effectiveEvaluatorIds = normalizeAbEvaluators(args.evaluatorIds || args.config.evaluators, args.evaluatorId || args.config.evaluatorId);
    const evaluationAttempt = (target.run.evaluationAttempts || 0) + 1;
    const evaluationClaimId = buildEvaluationClaimId();
    target.run.status = 'evaluating';
    target.run.evaluationAttempts = evaluationAttempt;
    target.run.evaluationClaimId = evaluationClaimId;
    target.run.evaluationStartedAt = new Date().toISOString();
    target.run.evaluations = mergeRunEvaluations(
        target.run.evaluations,
        effectiveEvaluatorIds.map(id => ({
            evaluatorId: id,
            evaluatorName: AB_EVALUATOR_NAMES[id] || id,
            status: 'running',
        })),
    );
    delete target.run.evaluationResultId;
    delete target.run.evaluationTraceId;
    delete target.run.score;
    delete target.run.tier;
    target.run.output = undefined;
    await persistRunStatePatch({
        taskId: args.taskId,
        user: args.user,
        config: args.config,
        states: args.states,
        caseId: target.caseId,
        side: target.side,
        nextRun: target.run,
        sidePatch: { evaluatorRunId: undefined },
        touchLatestResultAt: true,
    });

    try {
        const binding: GrayscaleBinding = {
            source: 'grayscale-ab',
            grayscaleTaskId: args.taskId,
            caseId: target.caseId,
            side: target.side,
            runIndex: target.run.runIndex,
            roundIndex: target.run.roundIndex,
            executionTraceId: target.run.sessionId!,
            evaluationClaimId,
            evaluationAttempt,
        };
        const createdEvaluation = await startSingleEvaluation(
            args.origin,
            args.user,
            args.config,
            { caseId: target.caseId, taskId: target.run.sessionId! },
            args.caseDatasetIdByCaseId?.get(target.caseId),
            args.evaluatorId,
            effectiveEvaluatorIds,
            binding,
            { appendToBatch: args.appendToBatch },
        );
        evaluatorRunId = createdEvaluation.evaluatorRunId;
        evaluationResultId = createdEvaluation.evaluationResultId;
        target.run.evaluatorRunId = evaluatorRunId;
        target.run.evaluationResultId = evaluationResultId;
        args.states[target.caseId][target.side].evaluatorRunId = evaluatorRunId;
        await persistRunStatePatch({
            taskId: args.taskId,
            user: args.user,
            config: args.config,
            states: args.states,
            caseId: target.caseId,
            side: target.side,
            nextRun: target.run,
            expectedEvaluationClaimId: evaluationClaimId,
            sidePatch: { evaluatorRunId },
            touchLatestResultAt: true,
        });

        const settled = await waitAndApplyEvaluationResult({
            taskId: args.taskId,
            user: args.user,
            origin: args.origin,
            states: args.states,
            caseId: target.caseId,
            side: target.side,
            run: target.run,
            evaluationResultId,
            evaluatorRunId,
            expectedEvaluationClaimId: evaluationClaimId,
            config: args.config,
        });
        if (settled) {
            await hydrateExecutionMetrics(args.states);
        } else {
            target.run.status = 'evaluating';
            target.run.output = undefined;
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (evaluationResultId) {
            await markEvaluatorRowsFailed(args.user, [evaluationResultId], message).catch(() => {});
        } else if (evaluatorRunId) {
            await markEvaluatorTasksFailed(args.user, evaluatorRunId, target.run.sessionId ? [target.run.sessionId] : [], message).catch(() => {});
        }
        target.run.status = 'fail';
        target.run.evaluations = mergeRunEvaluations(
            target.run.evaluations,
            effectiveEvaluatorIds.map(id => ({
                evaluatorId: id,
                evaluatorName: AB_EVALUATOR_NAMES[id] || id,
                status: 'failed',
                evaluatorRunId,
                evaluationResultId,
                errorMessage: message,
            })),
        );
        target.run.output = message;
        markRunCompleted(target.run);
        await persistRunStatePatch({
            taskId: args.taskId,
            user: args.user,
            config: args.config,
            states: args.states,
            caseId: target.caseId,
            side: target.side,
            nextRun: target.run,
            expectedEvaluationClaimId: evaluationClaimId,
            sidePatch: evaluatorRunId ? { evaluatorRunId } : undefined,
            touchLatestResultAt: true,
        }).catch(() => {});
    }
    markLatestGrayResultAt(args.config);
    await persistRunStatePatch({
        taskId: args.taskId,
        user: args.user,
        config: args.config,
        states: args.states,
        caseId: target.caseId,
        side: target.side,
        nextRun: target.run,
        expectedEvaluationClaimId: evaluationClaimId,
        sidePatch: evaluatorRunId ? { evaluatorRunId } : undefined,
        touchLatestResultAt: true,
    }).catch(() => {});
}

function isTerminalTrajectoryStatus(status: TrajectoryResultStatus | undefined): boolean {
    return status === 'done' || status === 'failed';
}

async function waitAndApplyEvaluationResult(args: {
    taskId: string;
    user: string;
    origin: string;
    config: GrayscaleConfig;
    states: CaseStates;
    caseId: string;
    side: Side;
    run: RunResult;
    evaluationResultId: string;
    evaluatorRunId: string;
    expectedEvaluationClaimId: string;
}): Promise<boolean> {
    const timeoutMessage = 'evaluation timed out';
    for (let i = 0; i < 180; i++) {
        const res = await fetch(`${args.origin}/api/eval/trajectory/results/${encodeURIComponent(args.evaluationResultId)}?user=${encodeURIComponent(args.user)}`);
        const result = await res.json().catch(() => ({})) as TrajectoryApiResult & { error?: string };
        if (res.ok) {
            const binding = readGrayscaleBindingFromRaw(result.rawAnalysis);
            if (String(result.id || '').trim() !== args.evaluationResultId) {
                throw new Error(`evaluation result id mismatch: expected ${args.evaluationResultId}, got ${String(result.id || '').trim() || 'N/A'}`);
            }
            if (String(result.taskId || '').trim() !== String(args.run.sessionId || '').trim()) {
                throw new Error(`evaluation result trace mismatch: expected ${String(args.run.sessionId || '').trim() || 'N/A'}, got ${String(result.taskId || '').trim() || 'N/A'}`);
            }
            if (!matchesGrayscaleBinding(binding, {
                taskId: args.taskId,
                caseId: args.caseId,
                side: args.side,
                run: args.run,
                expectedClaimId: args.expectedEvaluationClaimId,
            })) {
                throw new Error('evaluation result binding mismatch');
            }
            if (isTerminalTrajectoryStatus(result.status)) {
                const rowLike: TrajectoryResultRow = {
                    id: result.id,
                    evaluatorRunId: result.evaluatorRunId || args.evaluatorRunId,
                    status: result.status,
                    taskId: result.taskId,
                    trajectoryScore: result.trajectoryScore,
                    errorMessage: result.errorMessage,
                    rawAnalysisJson: JSON.stringify(result.rawAnalysis || {}),
                    updatedAt: result.updatedAt ? new Date(result.updatedAt) : undefined,
                };
                applyTrajectoryRowToRun(args.run, rowLike, args.evaluatorRunId);
                await persistRunStatePatch({
                    taskId: args.taskId,
                    user: args.user,
                    config: args.config,
                    states: args.states,
                    caseId: args.caseId,
                    side: args.side,
                    nextRun: args.run,
                    expectedEvaluationClaimId: args.expectedEvaluationClaimId,
                    sidePatch: { evaluatorRunId: args.evaluatorRunId },
                    touchLatestResultAt: true,
                });
                return true;
            }
        } else if (res.status !== 404) {
            throw new Error(result.error || 'failed to load trajectory evaluation result');
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    try {
        const res = await fetch(`${args.origin}/api/eval/trajectory/results/${encodeURIComponent(args.evaluationResultId)}?user=${encodeURIComponent(args.user)}`);
        const result = await res.json().catch(() => ({})) as TrajectoryApiResult & { error?: string };
        if (res.ok && !isTerminalTrajectoryStatus(result.status)) {
            return false;
        }
    } catch {
        // ignore: fall through to timeout failure below
    }
    await markEvaluatorRowsFailed(args.user, [args.evaluationResultId], timeoutMessage);
    if (args.run.status === 'evaluating' || args.run.status === 'running') {
        args.run.status = 'fail';
        args.run.output = timeoutMessage;
        args.run.evaluations = mergeRunEvaluations(
            args.run.evaluations,
            normalizeAbEvaluators(args.run.evaluations?.map(item => item.evaluatorId) || []).map(id => ({
                evaluatorId: id,
                evaluatorName: AB_EVALUATOR_NAMES[id] || id,
                status: 'failed',
                evaluatorRunId: args.evaluatorRunId,
                evaluationResultId: args.evaluationResultId,
                errorMessage: timeoutMessage,
            })),
        );
        markRunCompleted(args.run);
        await persistRunStatePatch({
            taskId: args.taskId,
            user: args.user,
            config: args.config,
            states: args.states,
            caseId: args.caseId,
            side: args.side,
            nextRun: args.run,
            expectedEvaluationClaimId: args.expectedEvaluationClaimId,
            sidePatch: { evaluatorRunId: args.evaluatorRunId },
            touchLatestResultAt: true,
        }).catch(() => {});
    }
    throw new Error(timeoutMessage);
}

async function evaluateRunsWithConcurrency(args: {
    taskId: string;
    user: string;
    origin: string;
    config: GrayscaleConfig;
    states: CaseStates;
    caseIds: string[];
    evaluatorId?: string;
    evaluatorIds?: string[];
    onlyMissingEvaluation?: boolean;
    parentSignal?: AbortSignal;
}) {
    const targets: EvaluationTarget[] = [];
    const configuredEvaluatorIds = normalizeAbEvaluators(args.evaluatorIds || args.config.evaluators, args.evaluatorId || args.config.evaluatorId);
    const caseConfigMap = await loadConfiguredCaseMap(args.user, args.config);
    const caseDatasetIdByCaseId = new Map(Array.from(caseConfigMap.entries()).map(([caseId, info]) => [caseId, info.datasetId] as const));
    for (const caseId of args.caseIds) {
        const state = args.states[caseId];
        if (!state) continue;
        for (const side of ['a', 'b'] as Side[]) {
            for (const run of state[side].runs || []) {
                const targetEvaluatorIds = args.onlyMissingEvaluation
                    ? getFailedOrMissingEvaluatorIds(run, configuredEvaluatorIds)
                    : configuredEvaluatorIds;
                if (args.onlyMissingEvaluation && targetEvaluatorIds.length === 0) {
                    continue;
                }
                // 默认状态白名单: executed / pass。onlyMissingEvaluation 模式下额外接受
                // 'evaluating' —— 前端行级 retry 会先把 run 标成 evaluating 让 UI 立刻
                // 显示"评测中"动效, 此时 evaluatorRunId/score 都被清掉了, 落进 backend
                // 这里应当被选中重评; 不开 onlyMissing 时不接受 evaluating, 避免抢已经
                // 在跑的 eval。
                const eligibleStatus = run.status === 'executed' || run.status === 'pass'
                    || (args.onlyMissingEvaluation && run.status === 'evaluating');
                if (eligibleStatus && run.sessionId) {
                    targets.push({ caseId, side, run, evaluatorIds: targetEvaluatorIds });
                }
            }
        }
    }
    if (targets.length === 0) return null;

    const evaluatorRunIds: string[] = [];
    const concurrency = Math.max(1, Number(args.config.agentMaxConcurrency || targets.length));
    // 评测器同样进 withBackgroundOpencodeSlot 排队,跟 A/B agent 执行**共享**5 个 slot ——
    // 也就是说全局后台 opencode 总并发上限就是 5, agent + evaluator 一起算。
    const runEvaluationBatch = async (batch: EvaluationTarget[]) => {
        await runWithConcurrency(batch, concurrency, async target => {
            if (args.parentSignal?.aborted) {
                target.run.status = 'fail';
                target.run.output = '用户终止';
                markRunCompleted(target.run);
                return;
            }
            const beforeRunId = target.run.evaluatorRunId;
            try {
                await withBackgroundOpencodeSlot(
                    () => evaluateSingleRunTarget({
                        ...args,
                        target,
                        caseDatasetIdByCaseId,
                        evaluatorIds: target.evaluatorIds,
                        appendToBatch: !args.onlyMissingEvaluation,
                    }),
                    {
                        taskType: 'grayscale-eval',
                        user: args.user,
                        label: `eval-${target.side}-${target.caseId}`,
                        // displayOnly: 这层是 orchestration 只发 HTTP 给 /api/eval/trajectory/run,
                        // 内部 trajectory + task-completion 各自再走 withBackgroundOpencodeSlot
                        // 占自己的 slot。如果外层也占 slot, 1 个 case 2 个 side 就要 2(外) +
                        // 4(2 side × 2 evaluator) = 6 个 slot, 超过默认 max=5, 用户会看到
                        // "1 评测中 + 1 排队中" 的奇怪现象。displayOnly=true 表示 dashboard
                        // 上仍能看到这个任务条目, 但不实际占 slot, 杜绝外/内双重计数。
                        displayOnly: true,
                        signal: args.parentSignal,
                        // TODO: evaluateRunsWithConcurrency 当前从 args.config.skillId 索引,这一层
                        // 拿不到具体 versionA/B 的 skillName/version。后续 refactor 让 caller 把
                        // versionA/B 显式传进 args 后再补齐 skill 透传。当前 grayscale-eval 任务
                        // 在 dashboard 按 skill 过滤时会看不见,需要在"显示所有"模式才能看到。
                    },
                );
            } catch (err) {
                if (args.parentSignal?.aborted || (err as Error)?.name === 'AbortError') {
                    target.run.status = 'fail';
                    target.run.output = '用户终止';
                    markRunCompleted(target.run);
                    return;
                }
                throw err;
            }
            if (target.run.evaluatorRunId && target.run.evaluatorRunId !== beforeRunId) {
                evaluatorRunIds.push(target.run.evaluatorRunId);
            }
        }, args.parentSignal);
    };

    // 反散裂修复: 让本次评测的所有 target 落到同一个评测批次。
    // 此前每个 target 各自 POST /api/eval/trajectory/run、各 mint 一个 evaluatorRunId
    // (因为 config.evaluationBatchId 一直没值、append 分支是死代码 —— 那个对话框在 A/B 页打不开),
    // 导致 "N case × M round 在「评测执行」里散裂成 N×M 个只有一条的批次"。
    // 做法(对齐用例分析的同一批次语义): 先串行跑第一条建出批次, 把 evaluatorRunId 写进**内存中**的
    // config(仅本次调用内共享, 故意不落库 —— 落库会让下次重跑 append 到旧批次、越积越多;
    // 不落库则每次评测各自成一个干净批次)。其余 target 走 append 落到同一批。
    // 每条 run 的 evaluatorRunId 已写进各自 run 状态,「评测执行」按它分组就归到一批。
    // 仅在「全量评测(非 onlyMissing) 且尚未关联批次」时介入; onlyMissing(行级重试)维持原语义不动。
    if (!args.onlyMissingEvaluation && !args.config.evaluationBatchId && targets.length > 1) {
        await runEvaluationBatch([targets[0]]);
        const seedBatchId = targets[0].run.evaluatorRunId;
        if (seedBatchId) {
            args.config.evaluationBatchId = seedBatchId; // 仅本次调用内共享, 不落库
        }
        // seedBatchId 为空(第一条建批次失败)时退回原行为: 其余各自评测, 至少不阻塞。
        await runEvaluationBatch(targets.slice(1));
    } else {
        await runEvaluationBatch(targets);
    }
    for (let retry = 1; retry <= MAX_EVALUATION_RETRIES; retry++) {
        const failedTargets = targets
            .filter(target => target.run.status === 'fail' && target.run.sessionId)
            .map(target => ({
                ...target,
                evaluatorIds: getFailedOrMissingEvaluatorIds(target.run, configuredEvaluatorIds),
            }))
            .filter(target => (target.evaluatorIds || []).length > 0);
        if (failedTargets.length === 0) break;
        await runEvaluationBatch(failedTargets);
    }
    return evaluatorRunIds[evaluatorRunIds.length - 1] || null;
}

async function runGrayscaleTask(args: {
    taskId: string;
    user: string;
    origin: string;
    caseIds: string[];
    evaluatorId?: string;
    evaluatorIds?: string[];
    agentMaxConcurrency?: number;
}) {
    const { taskId, user, origin, evaluatorId } = args;
    const storeKey = `${user}:${taskId}`;
    const task = await loadTask(taskId, user);
    if (!task) throw new Error('task not found');
    validateTaskSkillBinding(task);
    const config = {
        ...task.configJson,
        skillId: task.skillId,
        evaluatorId: evaluatorId || task.configJson.evaluatorId,
        evaluators: normalizeAbEvaluators(args.evaluatorIds || task.configJson.evaluators, evaluatorId || task.configJson.evaluatorId),
        agentMaxConcurrency: args.agentMaxConcurrency || task.configJson.agentMaxConcurrency,
        // 评测批次标题默认用 A/B 任务名, 让「评测结果」里的批次跟 A/B 任务同名、好对应。
        evaluationBatchTitle: task.configJson.evaluationBatchTitle || task.taskName,
    };
    const configuredDatasetIds = getConfiguredDatasetIds(config);
    if (configuredDatasetIds.length === 0) throw new Error('dataset is required');
    const caseConfigMap = await loadConfiguredCaseMap(user, config);
    if (caseConfigMap.size === 0) throw new Error('dataset not found');

    const runCount = Math.max(1, Number(config.runCount || args.caseIds.length || 1));
    const repeatRounds = Math.max(1, Number(config.repeatRounds || 1));
    const caseIds = args.caseIds.slice(0, runCount);
    if (caseIds.length !== runCount) throw new Error(`selected case count ${caseIds.length} does not match runCount ${runCount}`);

    for (const caseId of caseIds) {
        if (!caseConfigMap.get(caseId)?.caseEntry.input?.trim()) throw new Error(`case ${caseId} not found or missing input`);
    }

    const versionA = await resolveVersion(config.skillId, config.versionAId);
    const versionB = await resolveVersion(config.skillId, config.versionBId);
    const states: CaseStates = {};
    const totalRunsPerSide = repeatRounds;

    for (const caseId of caseIds) {
        states[caseId] = {
            a: { status: 'pending', runs: [], runCount: totalRunsPerSide },
            b: { status: 'pending', runs: [], runCount: totalRunsPerSide },
        };
    }

    const work: ExecutionTarget[] = [];
    for (let roundIndex = 1; roundIndex <= repeatRounds; roundIndex++) {
        for (const caseId of caseIds) {
            for (const side of ['a', 'b'] as Side[]) {
                const run: RunResult = {
                    status: 'pending',
                    caseId,
                    runIndex: roundIndex,
                    roundIndex,
                };
                states[caseId][side].runs = [...(states[caseId][side].runs || []), run];
                work.push({ caseId, side, roundIndex, runIndex: roundIndex, run });
            }
        }
    }
    for (const caseId of caseIds) {
        for (const side of ['a', 'b'] as Side[]) {
            states[caseId][side] = rebuildSideAggregate(states[caseId][side], totalRunsPerSide);
        }
    }
    await persistTaskState(taskId, user, config, states);

    const concurrency = Math.max(1, Number(config.agentMaxConcurrency || runCount * 2));
    // 内层每个 work item 进 withBackgroundOpencodeSlot 排队,跟全局 5 个 opencode 后台任务
    // 上限对齐——A/B 一把 200 个 work 也只会有 5 个真在跑 opencode,其余在信号量队列等。
    // 这样不管 user 把 agentMaxConcurrency / repeatRounds 调多大,内存也不会失控。
    // 任务级 AbortSignal——activeRuns().get(storeKey)?.abortController 在 POST start
    // 时创建, action='abort' 时 fire。下面 runWithConcurrency / executeSingleAgentRun
    // 都监听它, 用户点终止后所有 in-flight 都尽快退出。
    const taskSignal = activeRuns().get(storeKey)?.abortController?.signal;
    const markRunAborted = (item: ExecutionTarget) => {
        item.run.status = 'fail';
        item.run.failureType = 'agent_error';
        item.run.failureDetail = '用户终止';
        item.run.output = item.run.output || '用户终止';
        markRunCompleted(item.run);
        states[item.caseId][item.side] = rebuildSideAggregate(states[item.caseId][item.side], totalRunsPerSide);
    };
    const runExecutionBatch = async (batch: ExecutionTarget[]) => {
        await runWithConcurrency(batch, concurrency, async item => {
            if (taskSignal?.aborted) {
                markRunAborted(item);
                return;
            }
            const version = item.side === 'a' ? versionA : versionB;
            // baseline 侧 (version=null) 取另一侧的 skillName 作为 trace 标签;
            // 两侧都不是 None 时取本侧, 走 input.skill 路径, referenceSkillName 自然不参与。
            const referenceSkillName = versionB?.skillName || versionA?.skillName || null;
            try {
                await withBackgroundOpencodeSlot(
                    () => executeSingleAgentRun({
                        taskId,
                        user,
                        config,
                        states,
                        caseMap: new Map(Array.from(caseConfigMap.entries()).map(([caseId, info]) => [caseId, info.caseEntry] as const)),
                        totalRunsPerSide,
                        version,
                        referenceSkillName,
                        target: item,
                        parentSignal: taskSignal,
                    }),
                    {
                        taskType: 'grayscale-ab',
                        user,
                        label: `grayscale-${item.side}-${item.caseId}-r${item.roundIndex}`,
                        skill: version?.skillName,
                        skillVersion: version?.version ?? null,
                        signal: taskSignal,
                    },
                );
            } catch (err) {
                // 排队中被 abort: semaphore.acquire 抛 AbortError → 标 fail, 不抛
                if (taskSignal?.aborted || (err as Error)?.name === 'AbortError') {
                    markRunAborted(item);
                    return;
                }
                throw err;
            }
        }, taskSignal);
    };

    await runExecutionBatch(work);
    for (let retry = 1; retry <= MAX_EXECUTION_RETRIES; retry++) {
        if (taskSignal?.aborted) break;
        // 只对 agent_error 重试 (大概率 transient: network glitch / opencode crash 等)。
        // agent_timeout / permission_blocked / question_blocked 是确定性失败, 重试
        // 不会改变结果, 反而让 UI 经历 fail → running → fail 的闪烁循环, 用户疑惑。
        const failedWork = work.filter(item =>
            item.run.status === 'fail' && item.run.failureType === 'agent_error'
        );
        if (failedWork.length === 0) break;
        await runExecutionBatch(failedWork);
    }

    if (config.autoEval !== false && !taskSignal?.aborted) {
        activeRuns().set(storeKey, {
            taskId,
            runId: activeRuns().get(storeKey)?.runId || '',
            status: 'evaluating',
            startedAt: Date.now(),
            abortController: activeRuns().get(storeKey)?.abortController,
        });
        await evaluateRunsWithConcurrency({ taskId, user, origin, config, states, caseIds, evaluatorId, evaluatorIds: config.evaluators, parentSignal: taskSignal });
    }
}

async function evaluateExistingTask(args: { taskId: string; user: string; origin: string; caseIds: string[]; evaluatorId?: string; evaluatorIds?: string[]; onlyMissingEvaluation?: boolean }) {
    const task = await loadTask(args.taskId, args.user);
    if (!task) throw new Error('task not found');
    validateTaskSkillBinding(task);
    const config = {
        ...task.configJson,
        skillId: task.skillId,
        evaluatorId: args.evaluatorId || task.configJson.evaluatorId,
        evaluators: normalizeAbEvaluators(args.evaluatorIds || task.configJson.evaluators, args.evaluatorId || task.configJson.evaluatorId),
        // 评测批次标题默认用 A/B 任务名(行级重评等也走同名批次)。
        evaluationBatchTitle: task.configJson.evaluationBatchTitle || task.taskName,
    };
    const states = task.caseStatesJson || {};
    const caseIds = args.caseIds.length > 0 ? args.caseIds : Object.keys(states);
    const evaluatorRunId = await evaluateRunsWithConcurrency({
        taskId: args.taskId,
        user: args.user,
        origin: args.origin,
        config,
        states,
        caseIds,
        evaluatorId: args.evaluatorId,
        evaluatorIds: config.evaluators,
        // 透传给 evaluateRunsWithConcurrency, true 时只选 evaluatorRunId/score 都没的 run,
        // 避免行级 retry 误评同 case 已 pass 的其他 run。
        onlyMissingEvaluation: args.onlyMissingEvaluation,
    });
    if (!evaluatorRunId) throw new Error('no executed agent sessions to evaluate');
}

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ taskId: string }> }
) {
    try {
        const { taskId } = await params;
        const user = req.nextUrl.searchParams.get('user') || '';
        if (!user || !taskId) {
            return NextResponse.json({ error: 'user and taskId are required' }, { status: 400 });
        }
        const task = await loadTask(taskId, user);
        if (!task) return NextResponse.json({ error: 'task not found' }, { status: 404 });

        const metricsHydrated = await hydrateExecutionMetrics(task.caseStatesJson);
        const executionsReconciled = await reconcileFinishedExecutions({
            user,
            config: task.configJson,
            states: task.caseStatesJson,
        });
        const reconciled = await reconcileFinishedEvaluations(taskId, user, task.configJson, task.caseStatesJson);

        // === 孤儿 in-flight 清理 ===
        // activeRuns 是内存 map (挂 globalThis), server 重启就丢。如果 caseStates
        // 里还有 running/pending/evaluating 但 activeRuns 没有这个 task 的条目,
        // 那一定是上次进程跑到一半被杀的孤儿——agent / evaluator 子进程都没了,
        // 不会再有人推进它的状态。先走上面的 reconcileFinishedExecutions 反查
        // Execution 表回填; 只有仍未被回填的 in-flight run 才能判作真正孤儿。
        //
        // 直接走跟 abort 同款的清理: pending/running/evaluating 全标 fail, 然后
        // rebuildSideAggregate 让 top 跟 runs 一致。
        const orphanStoreKey = `${user}:${taskId}`;
        let orphanCleanup = false;
        if (!activeRuns().get(orphanStoreKey) && hasAnyRunningCaseStates(task.caseStatesJson)) {
            const cancelable: CaseStatus[] = ['running', 'evaluating', 'pending'];
            const states = task.caseStatesJson;
            for (const cid of Object.keys(states)) {
                for (const side of ['a', 'b'] as Side[]) {
                    const sideState = states[cid][side];
                    if (!sideState) continue;
                    let patched = false;
                    for (const run of sideState.runs || []) {
                        if (cancelable.includes(run.status)) {
                            run.status = 'fail';
                            run.failureType = 'agent_error';
                            run.failureDetail = run.failureDetail || '服务重启中断, 请重新评测';
                            run.output = run.output || '服务重启中断';
                            patched = true;
                            orphanCleanup = true;
                        }
                    }
                    if (patched) {
                        states[cid][side] = rebuildSideAggregate(
                            sideState,
                            sideState.runCount || sideState.runs?.length || 0,
                        );
                        const rebuilt = states[cid][side];
                        if (rebuilt.status === 'running' || rebuilt.status === 'evaluating') {
                            rebuilt.status = 'fail';
                            rebuilt.output = rebuilt.output || '服务重启中断';
                        }
                    }
                }
            }
        }

        if (orphanCleanup || metricsHydrated || executionsReconciled || reconciled) {
            // 乐观锁回写: 这次 reconcile 是基于 task 刚 load 时的快照算的。若期间评测
            // flow 已经写了更新的状态(CAS 落空), 不能用我们这份旧快照覆盖它 —— 否则
            // 会把刚落库的 pass 又擦回 evaluating(就是"评完又退回评估中"那个抖动)。
            // 冲突时直接返回最新已提交状态, 不再用本轮中间态响应, 下一拍 poll 会基于
            // 最新状态重新 reconcile。
            const written = await persistTaskState(
                taskId,
                user,
                task.configJson,
                task.caseStatesJson,
                task.rawCaseStatesJson,
            );
            if (!written) {
                const fresh = await loadTask(taskId, user);
                if (fresh) return respondTask(fresh, activeRuns().get(`${user}:${taskId}`) || null);
            }
        }
        const storeKey = `${user}:${taskId}`;
        const active = activeRuns().get(storeKey);
        if (active && !hasAnyRunningCaseStates(task.caseStatesJson)) {
            activeRuns().delete(storeKey);
        }
        const currentActive = activeRuns().get(storeKey);
        if (!currentActive && task.configJson.autoEval !== false) {
            const backlogCaseIds = getAutoEvaluationBacklogCaseIds(task.caseStatesJson);
            if (backlogCaseIds.length > 0) {
                const runId = `gray_recover_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                activeRuns().set(storeKey, { taskId, runId, status: 'evaluating', startedAt: Date.now() });
                void evaluateRunsWithConcurrency({
                    taskId,
                    user,
                    origin: req.nextUrl.origin,
                    config: task.configJson,
                    states: task.caseStatesJson,
                    caseIds: backlogCaseIds,
                    evaluatorId: task.configJson.evaluatorId,
                    evaluatorIds: normalizeAbEvaluators(task.configJson.evaluators, task.configJson.evaluatorId),
                    onlyMissingEvaluation: true,
                })
                    .catch(err => console.error('[GRAYSCALE_TASKS_RECOVER_EVAL] Failed:', err))
                    .finally(() => {
                        activeRuns().delete(storeKey);
                    });
            }
        }
        return respondTask(task, activeRuns().get(`${user}:${taskId}`) || null);
    } catch (err) {
        console.error('[GRAYSCALE_TASKS_GET_ONE] Failed:', err);
        return NextResponse.json({ error: 'Failed to fetch task' }, { status: 500 });
    }
}

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ taskId: string }> }
) {
    try {
        const { taskId } = await params;
        const body = await req.json().catch(() => ({}));
        const user = String(body.user || '').trim();
        const action = String(body.action || 'start');
        const caseIds = Array.isArray(body.caseIds)
            ? body.caseIds.map((id: unknown) => String(id || '').trim()).filter(Boolean)
            : [];
        const evaluatorId = typeof body.evaluatorId === 'string' ? body.evaluatorId.trim() : undefined;
        const evaluatorIds = normalizeAbEvaluators(body.evaluators, evaluatorId);
        const agentMaxConcurrency = typeof body.agentMaxConcurrency === 'number' && Number.isFinite(body.agentMaxConcurrency)
            ? Math.max(1, Math.floor(body.agentMaxConcurrency))
            : undefined;
        // 行级 retry 用: true 时 backend 只评估 evaluatorRunId/score 都没有的 run,
        // 避免把同 case 已 pass 的其他 run 也重评一遍。
        const onlyMissingEvaluation = body.onlyMissingEvaluation === true;
        if (!user || !taskId) {
            return NextResponse.json({ error: 'user and taskId are required' }, { status: 400 });
        }
        if (caseIds.length === 0 && action === 'start') {
            return NextResponse.json({ error: 'caseIds are required' }, { status: 400 });
        }
        const storeKey = `${user}:${taskId}`;
        // === action: abort —— 用户点「终止」按钮 ===
        if (action === 'abort') {
            // 双场景:
            //   A. activeRuns 里有 → 任务真在跑, abort signal + 清 DB + 删 active
            //   B. activeRuns 里没有 → server 重启等原因丢了 in-memory state, 但
            //      caseStatesJson 还卡在 running/evaluating (孤儿状态)。前端 UI 因为
            //      hasRunningStates 还显示「执行中」, 用户点终止 → 必须也能清掉这些
            //      孤儿, 否则用户被永久锁死。之前直接返回 404, 反而堵了用户唯一的
            //      自救入口。
            const active = activeRuns().get(storeKey);
            if (active) {
                try { active.abortController?.abort(); } catch { /* already aborted */ }
            }
            // 不管 active 在不在, 都 patch DB 把 in-flight 状态推到 fail。
            // 包括 pending——pending 在 rebuildSideAggregate 里被算作 running 同类
            // (line 502: runs.some(r => status==='running' || status==='pending')),
            // 所以哪怕把 running/evaluating 都标了 fail, pending 没动 → rebuild 算出
            // top='running', 用户看 UI 仍然是「执行中」, abort 失效。
            let patchedCount = 0;
            const cancelable: CaseStatus[] = ['running', 'evaluating', 'pending'];
            try {
                const taskRow = await loadTask(taskId, user);
                if (taskRow) {
                    const states = taskRow.caseStatesJson || {};
                    for (const cid of Object.keys(states)) {
                        for (const side of ['a', 'b'] as Side[]) {
                            const sideState = states[cid][side];
                            if (!sideState) continue;
                            for (const run of sideState.runs || []) {
                                if (cancelable.includes(run.status)) {
                                    run.status = 'fail';
                                    run.failureType = 'agent_error';
                                    run.failureDetail = '用户终止';
                                    run.output = run.output || '用户终止';
                                    patchedCount++;
                                }
                            }
                            // 主动 rebuild: 让 sideState.status 跟 runs[] 严格一致
                            // (按上面 patch 完后, 所有 run 要么是 fail/pass/executed 等
                            // 终态, rebuild 算出来必然不是 'running')
                            states[cid][side] = rebuildSideAggregate(
                                sideState,
                                sideState.runCount || sideState.runs?.length || 0,
                            );
                            // 兜底: 万一 rebuild 仍然算成 running/evaluating (例如所有
                            // run 都是 pass 但 totalRuns 比 runs 长度多), 强行推到 fail
                            const rebuilt = states[cid][side];
                            if (rebuilt.status === 'running' || rebuilt.status === 'evaluating') {
                                rebuilt.status = 'fail';
                                rebuilt.output = rebuilt.output || '用户终止';
                            }
                        }
                    }
                    if (patchedCount > 0) {
                        await persistTaskState(taskId, user, taskRow.configJson, states);
                    }
                }
            } catch (e) {
                console.warn('[GRAYSCALE_TASKS_ABORT] persist fail patch failed:', e);
            }
            if (active) activeRuns().delete(storeKey);
            return NextResponse.json({
                ok: true,
                aborted: true,
                hadActiveRun: !!active,
                patchedCount,
            });
        }

        // 行级 retry-eval 路径 (action='evaluate' + onlyMissingEvaluation=true)
        // 跳过 single-instance 守门, 允许多个 retry 并行——只针对 frontend retryEvaluation
        // 这种"用户点了 N 条失败 case 的 retry, 期望并行重评"的场景。
        //
        // 安全性论证: onlyMissingEvaluation=true 时, backend evaluateRunsWithConcurrency
        // 只选 evaluatorRunId/score 都没的 run; 每条 retry 走 retryEvaluation 时 frontend
        // 已经清掉了那条 run 的 evaluatorRunId/score, 不同 retry 改的是不同 run。
        //
        // RACE 风险 (已知, 不修): persistTaskState 写整个 caseStatesJson 而非 patch 单 run,
        // 两个 retry 并行时存在 lost-update 风险 (call1 在 T=0 loadTask 拿快照 S1,
        // call2 在 T=0.1 loadTask 拿快照 S2; call1 在 T=10s persistTaskState(S1.R2=pass),
        // call2 在 T=10.5s persistTaskState(S2.R3=pass) → S1 的 R2 更新被 S2 覆盖丢)。
        // 实际频率应该低 (用户点几个 retry, 间隔通常够 backend 串行写); 如出现问题再加
        // per-run 原子 persist (read-merge-write)。
        const isParallelRetryEval = action === 'evaluate' && onlyMissingEvaluation;
        if (activeRuns().has(storeKey) && !isParallelRetryEval) {
            return NextResponse.json({ error: 'task is already running' }, { status: 409 });
        }
        const task = await loadTask(taskId, user);
        if (!task) return NextResponse.json({ error: 'task not found' }, { status: 404 });
        try {
            validateTaskSkillBinding(task);
        } catch (err) {
            return NextResponse.json({ error: err instanceof Error ? err.message : 'invalid task skill binding' }, { status: 400 });
        }
        const origin = req.nextUrl.origin;
        const runId = `gray_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const abortController = new AbortController();
        // 并行 retry-eval 不占 activeRuns 主槽位 (否则后续 retry 也会被 guard 拒),
        // 但保留 abortController; 主路径正常占 activeRuns。
        if (!isParallelRetryEval) activeRuns().set(storeKey, {
            taskId,
            runId,
            status: action === 'evaluate' ? 'evaluating' : 'running',
            startedAt: Date.now(),
            abortController,
        });

        const job = action === 'evaluate'
            ? evaluateExistingTask({ taskId, user, origin, caseIds, evaluatorId, evaluatorIds, onlyMissingEvaluation })
            : runGrayscaleTask({ taskId, user, origin, caseIds, evaluatorId, evaluatorIds, agentMaxConcurrency });

        void job
            .catch(async err => {
                console.error('[GRAYSCALE_TASKS_RUN] Failed:', err);
                const task = await loadTask(taskId, user).catch(() => null);
                if (task) {
                    const states = task.caseStatesJson || {};
                    for (const caseId of caseIds.length > 0 ? caseIds : Object.keys(states)) {
                        ensureCaseState(states, caseId);
                        for (const side of ['a', 'b'] as Side[]) {
                            if (states[caseId][side].status === 'running' || states[caseId][side].status === 'evaluating') {
                                states[caseId][side].status = 'fail';
                                states[caseId][side].output = err instanceof Error ? err.message : String(err);
                            }
                        }
                    }
                    await persistTaskState(taskId, user, task.configJson, states).catch(() => {});
                }
            })
            .finally(() => {
                // 并行 retry-eval 没占主槽, 也不删它 (别的 retry-eval 可能还在跑)
                if (!isParallelRetryEval) activeRuns().delete(storeKey);
            });

        return NextResponse.json({ ok: true, runId });
    } catch (err) {
        console.error('[GRAYSCALE_TASKS_POST] Failed:', err);
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to start task' }, { status: 500 });
    }
}

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ taskId: string }> }
) {
    try {
        const { taskId } = await params;
        const body = await req.json();
        const { user, taskName, configJson, caseStatesJson } = body;

        if (!user || !taskId) {
            return NextResponse.json({ error: 'user and taskId are required' }, { status: 400 });
        }

        const data: Record<string, string> = {};
        const existing = await (prisma as unknown as GrayscalePrisma).grayscaleTask.findFirst({
            where: { id: taskId, user },
        });
        if (!existing) return NextResponse.json({ error: 'task not found' }, { status: 404 });

        if (configJson !== undefined) {
            const nextConfig = configJson && typeof configJson === 'object' && !Array.isArray(configJson)
                ? withDefaultConfig({ ...(configJson as GrayscaleConfig) })
                : {};
            const nextSkillId = String(nextConfig.skillId || '').trim();
            if (nextSkillId && nextSkillId !== existing.skillId) {
                return NextResponse.json({ error: 'task skill binding cannot be changed' }, { status: 400 });
            }
            const nextVersionBId = String(nextConfig.versionBId || '').trim();
            if (nextVersionBId && nextVersionBId !== existing.skillVersionId) {
                return NextResponse.json({ error: 'task skill version binding cannot be changed' }, { status: 400 });
            }
            nextConfig.skillId = existing.skillId;
            nextConfig.versionBId = existing.skillVersionId;
            data.configJson = JSON.stringify(nextConfig);
        }
        if (caseStatesJson !== undefined) data.caseStatesJson = JSON.stringify(caseStatesJson);
        if (typeof taskName === 'string' && taskName.trim()) {
            const trimmedName = taskName.trim();
            // 甲(原地改名):同一任务换标签。但唯一键现在含 taskName,改成"同版本里别的任务已占用的名字"
            // 会撞键,直接 updateMany 会抛 Prisma P2002。先查重,把它变成可读的 409,前端弹"名字已被占用"。
            if (trimmedName !== existing.taskName) {
                const clash = await (prisma as unknown as GrayscalePrisma).grayscaleTask.findFirst({
                    where: {
                        user,
                        skillName: existing.skillName,
                        skillVersion: existing.skillVersion,
                        taskName: trimmedName,
                        NOT: { id: taskId },
                    },
                });
                if (clash) {
                    return NextResponse.json({ error: '该版本下已存在同名 A/B 任务，请换一个名字' }, { status: 409 });
                }
            }
            data.taskName = trimmedName;
        }

        if (Object.keys(data).length === 0) {
            return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
        }

        await (prisma as unknown as GrayscalePrisma).grayscaleTask.updateMany({
            where: { id: taskId, user },
            data,
        });
        const updated = await (prisma as unknown as GrayscalePrisma).grayscaleTask.findFirst({
            where: { id: taskId, user },
        });
        if (!updated) return NextResponse.json({ error: 'task not found' }, { status: 404 });

        return NextResponse.json({
            ...updated,
            configJson: {
                ...withDefaultConfig(JSON.parse(updated.configJson || '{}')),
                skillId: updated.skillId,
                versionBId: updated.skillVersionId,
            },
            caseStatesJson: JSON.parse(updated.caseStatesJson || '{}'),
        });
    } catch (err) {
        console.error('[GRAYSCALE_TASKS_PATCH] Failed:', err);
        return NextResponse.json({ error: 'Failed to update task' }, { status: 500 });
    }
}

/**
 * 启动回收:把所有灰度(A/B)任务里"崩溃/重启前还在跑"的运行(running/evaluating/pending)一次性标失败。
 *
 * 背景:灰度的执行/评测运行状态存在 GrayscaleTask.caseStatesJson。进程崩溃/重启后这些 run 的 agent 进程
 * 已死,但 JSON 里仍是非终态。原来只在用户打开任务时惰性收尾(把它们判成「服务重启中断」)——于是用户
 * "选 case → 开始执行"时,这些上一轮崩溃的旧残骸会被恰好这时标成报错、混进新一轮里看着像新跑失败,
 * 状态也自相矛盾(能"重新执行"说明没有在跑的,却又显示着"运行中"的旧条目)。
 *
 * 开机就一次性清掉(与 opencode 孤儿回收 / 评测行回收同处、同理):重启 = 没有任何灰度 run 真的在跑,
 * 故把所有非终态 run 标 failed 是安全的。复用 rebuildSideAggregate 保证侧聚合状态一致。返回改动的任务数。
 */
export async function reapStaleGrayscaleRunsAtStartup(): Promise<number> {
    const cancelable: CaseStatus[] = ['running', 'evaluating', 'pending'];
    const reason = '服务重启中断（启动回收）';
    let tasks: Array<{ id: string; user: string; caseStatesJson: string }>;
    try {
        tasks = await (prisma as unknown as GrayscalePrisma).grayscaleTask.findMany({
            select: { id: true, user: true, caseStatesJson: true },
        });
    } catch {
        return 0;
    }
    let patchedTasks = 0;
    for (const task of tasks) {
        let states: CaseStates;
        try { states = JSON.parse(task.caseStatesJson || '{}') as CaseStates; } catch { continue; }
        let changed = false;
        for (const cid of Object.keys(states)) {
            for (const side of ['a', 'b'] as Side[]) {
                const sideState = states[cid]?.[side];
                if (!sideState) continue;
                let patched = false;
                for (const run of sideState.runs || []) {
                    if (cancelable.includes(run.status)) {
                        run.status = 'fail';
                        run.failureType = 'agent_error';
                        run.failureDetail = run.failureDetail || reason;
                        run.output = run.output || '服务重启中断';
                        patched = true;
                        changed = true;
                    }
                }
                if (patched) {
                    states[cid][side] = rebuildSideAggregate(sideState, sideState.runCount || sideState.runs?.length || 0);
                    const rebuilt = states[cid][side];
                    if (cancelable.includes(rebuilt.status)) {
                        rebuilt.status = 'fail';
                        rebuilt.output = rebuilt.output || '服务重启中断';
                    }
                }
            }
        }
        if (changed) {
            try {
                await (prisma as unknown as GrayscalePrisma).grayscaleTask.updateMany({
                    where: { id: task.id, user: task.user },
                    data: { caseStatesJson: JSON.stringify(states) },
                });
                patchedTasks++;
            } catch { /* 单任务失败不影响其它 */ }
        }
    }
    return patchedTasks;
}
