import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import { runGeneralAgent } from '@/lib/engine/general-agent';
import { withBackgroundOpencodeSlot } from '@/lib/engine/general-agent/concurrency-limiter';
import { findAgentDataset, type DatasetCase } from '@/server/agent_datasets_storage';

export const dynamic = 'force-dynamic';

type Side = 'a' | 'b';
type CaseStatus = 'pending' | 'running' | 'executed' | 'evaluating' | 'pass' | 'fail';
type RunFailureType = 'permission_blocked' | 'agent_timeout' | 'question_blocked' | 'agent_error';

interface GrayscaleConfig {
    skillId?: string;
    versionAId?: string;
    versionBId?: string;
    selectedDatasetId?: string;
    selectedCaseId?: string;
    selectedCaseIds?: string[];
    runCount?: number;
    repeatRounds?: number;
    agentMaxConcurrency?: number;
    autoEval?: boolean;
    recordTriggerDetails?: boolean;
    evaluatorId?: string;
    latestResultAt?: string;
}

interface RunResult {
    status: CaseStatus;
    jobId?: string;
    evaluatorRunId?: string;
    evaluationResultId?: string;
    evaluationTraceId?: string;
    timeCost?: string;
    tokenUsage?: number;
    output?: string;
    sessionId?: string;
    score?: number;
    tier?: 'good' | 'warn' | 'poor';
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
    status?: string;
    taskId?: string | null;
    trajectoryScore?: number | null;
    resultEvaluationScore?: number | null;
    customEvaluationScore?: number | null;
    errorMessage?: string | null;
    rawAnalysis?: unknown;
}

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
        findFirst(args: { where: { id: string; user: string } }): Promise<GrayscaleTaskRow | null>;
        updateMany(args: { where: { id: string; user: string }; data: Record<string, string> }): Promise<unknown>;
    };
    skillVersion: {
        findFirst(args: { where: { id: string; skillId: string }; include: { Skill: true } }): Promise<SkillVersionRow | null>;
    };
    trajectoryEvalResult: {
        findMany(args: { where: { user?: string; evaluatorRunId: { in: string[] } } }): Promise<TrajectoryResultRow[]>;
        updateMany(args: {
            where: { user?: string; evaluatorRunId: string; status?: { in: string[] } };
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
const STALE_EVALUATION_MS = 15 * 60 * 1000;
const MAX_EXECUTION_RETRIES = 2;
const MAX_EVALUATION_RETRIES = 2;
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

function scoreTier(score: number): 'good' | 'warn' | 'poor' {
    return score >= 80 ? 'good' : score >= 50 ? 'warn' : 'poor';
}

function compositeScore(result: { trajectoryScore?: number | null; resultEvaluationScore?: number | null; customEvaluationScore?: number | null }): number {
    const custom = typeof result.customEvaluationScore === 'number' ? result.customEvaluationScore : null;
    const traj = typeof result.trajectoryScore === 'number' ? result.trajectoryScore : null;
    const task = typeof result.resultEvaluationScore === 'number' ? result.resultEvaluationScore : null;
    const base = custom ?? ((traj != null && task != null) ? (traj + task) / 2 : (traj ?? task ?? 0));
    return Math.round(base * 100);
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

function pickCustomEvaluationScore(rawAnalysisJson: string | null | undefined): number | null {
    const raw = safeParse<Record<string, unknown> | null>(rawAnalysisJson, null);
    if (!raw || typeof raw !== 'object') return null;
    return pickNumber(raw.customEvaluationScore);
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

function pickEvaluationTraceIdFromRaw(rawAnalysis: unknown): string {
    const raw = rawAnalysis && typeof rawAnalysis === 'object' && !Array.isArray(rawAnalysis)
        ? rawAnalysis as Record<string, unknown>
        : null;
    if (!raw) return '';
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

function truncateForRunLog(value: unknown, maxLength = 240): string {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    if (!text) return '';
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
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
    const configJson = safeParse<GrayscaleConfig>(task.configJson, {});
    if (!configJson.skillId && task.skillId) configJson.skillId = task.skillId;
    if (!configJson.versionBId && task.skillVersionId) configJson.versionBId = task.skillVersionId;
    return {
        ...task,
        configJson,
        caseStatesJson: safeParse<CaseStates>(task.caseStatesJson, {}),
    };
}

async function persistTaskState(taskId: string, user: string, config: GrayscaleConfig, states: CaseStates) {
    await (prisma as unknown as GrayscalePrisma).grayscaleTask.updateMany({
        where: { id: taskId, user },
        data: {
            configJson: JSON.stringify(config),
            caseStatesJson: JSON.stringify(states),
        },
    });
}

function markLatestGrayResultAt(config: GrayscaleConfig) {
    config.latestResultAt = new Date().toISOString();
}

function markRunCompleted(run: RunResult, completedAt = new Date().toISOString()) {
    run.completedAt = completedAt;
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
    const finished = runs.filter(r => r.status === 'executed' || r.status === 'pass');
    const failed = runs.filter(r => r.status === 'fail');
    const evaluating = runs.some(r => r.status === 'evaluating');
    const running = runs.some(r => r.status === 'running' || r.status === 'pending');
    const scored = runs.filter(r => typeof r.score === 'number');
    const seconds = finished
        .map(r => typeof r.timeCost === 'string' ? Number.parseFloat(r.timeCost) : 0)
        .filter(n => Number.isFinite(n));
    const avgSeconds = seconds.length > 0 ? seconds.reduce((a, b) => a + b, 0) / seconds.length : 0;
    const tokenRuns = finished.filter(r => typeof r.tokenUsage === 'number');
    const avgTokens = tokenRuns.length > 0
        ? Math.round(tokenRuns.reduce((sum, r) => sum + (r.tokenUsage || 0), 0) / tokenRuns.length)
        : 0;
    const avgScore = scored.length > 0
        ? Math.round(scored.reduce((sum, r) => sum + (r.score || 0), 0) / scored.length)
        : undefined;
    const traceIds = finished.map(r => r.sessionId).filter(Boolean) as string[];
    const toolCallCount = finished.reduce((sum, r) => sum + (r.toolCallCount || 0), 0);
    const toolCalls = Array.from(new Set(finished.flatMap(r => r.toolCalls || []))).slice(0, 8);

    let status: CaseStatus = 'pending';
    if (failed.length === totalRuns && totalRuns > 0) status = 'fail';
    else if (scored.length === totalRuns && totalRuns > 0) status = 'pass';
    else if (finished.length + failed.length === totalRuns && totalRuns > 0) status = 'executed';
    else if (evaluating) status = 'evaluating';
    else if (running || finished.length > 0) status = 'running';

    return {
        ...state,
        status,
        runs,
        runCount: totalRuns,
        timeCost: finished.length > 0 ? `${avgSeconds.toFixed(1)}s` : undefined,
        tokenUsage: avgTokens || undefined,
        output: [...finished].reverse()[0]?.output || state.output,
        sessionId: traceIds[0] || state.sessionId,
        traceIds,
        score: avgScore,
        tier: avgScore == null ? undefined : scoreTier(avgScore),
        skillTriggered: finished.some(r => r.skillTriggered),
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
    const datasetId = String(args.config.selectedDatasetId || '');
    if (!datasetId) return false;
    const dataset = await findAgentDataset(args.user, datasetId).catch(() => null);
    if (!dataset) return false;

    const pendingTargets: Array<{ caseId: string; side: Side; run: RunResult; query: string; version: ResolvedVersion }> = [];
    const versionA = await resolveVersion(args.config.skillId, args.config.versionAId);
    const versionB = await resolveVersion(args.config.skillId, args.config.versionBId);
    const caseMap = new Map<string, DatasetCase>(dataset.cases.map(c => [c.id, c]));
    const claimedSessionIds = new Set(
        Object.values(args.states)
            .flatMap(state => (['a', 'b'] as Side[]).flatMap(side => state[side].runs || []))
            .map(run => run.sessionId)
            .filter((id): id is string => Boolean(id)),
    );

    for (const [caseId, state] of Object.entries(args.states)) {
        const query = normalizeText(caseMap.get(caseId)?.input);
        if (!query) continue;
        for (const side of ['a', 'b'] as Side[]) {
            const version = side === 'a' ? versionA : versionB;
            for (const run of state[side].runs || []) {
                if (run.status !== 'running' || run.sessionId) continue;
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

async function reconcileFinishedEvaluations(user: string, config: GrayscaleConfig, states: CaseStates): Promise<boolean> {
    const evaluatorRunIds = Array.from(new Set(
        Object.values(states)
            .flatMap(state => (['a', 'b'] as Side[]).flatMap(side => [
                state[side].evaluatorRunId,
                ...(state[side].runs || []).map(run => run.evaluatorRunId),
            ]))
            .filter((id): id is string => Boolean(id)),
    ));
    if (evaluatorRunIds.length === 0) return false;

    const rows = await (prisma as unknown as GrayscalePrisma).trajectoryEvalResult.findMany({
        where: { user, evaluatorRunId: { in: evaluatorRunIds } },
    });
    if (rows.length === 0) return false;

    const staleRows = rows.filter(row => {
        if (row.status !== 'pending' && row.status !== 'running') return false;
        const updatedAt = row.updatedAt instanceof Date ? row.updatedAt.getTime() : 0;
        return updatedAt > 0 && Date.now() - updatedAt > STALE_EVALUATION_MS;
    });
    if (staleRows.length > 0) {
        for (const row of staleRows) {
            if (row.evaluatorRunId) {
                await markEvaluatorRunFailed(user, row.evaluatorRunId, 'evaluation stale timeout').catch(() => {});
            }
            row.status = 'failed';
            row.errorMessage = row.errorMessage || 'evaluation stale timeout';
        }
    }

    const rowsByTaskId = new Map<string, TrajectoryResultRow>();
    for (const row of rows) {
        if (row.taskId) rowsByTaskId.set(row.taskId, row);
    }

    let changed = false;
    for (const state of Object.values(states)) {
        for (const side of ['a', 'b'] as Side[]) {
            for (const run of state[side].runs || []) {
                if (!run.sessionId) continue;
                const row = rowsByTaskId.get(run.sessionId);
                if (!row || (row.status !== 'done' && row.status !== 'failed')) continue;

                run.evaluatorRunId = run.evaluatorRunId || state[side].evaluatorRunId;
                run.evaluationResultId = row.id || run.evaluationResultId;
                run.evaluationTraceId = pickEvaluationTraceId(row.rawAnalysisJson) || run.evaluationTraceId;

                if (row.status === 'done') {
                    const score = compositeScore({
                        trajectoryScore: row.trajectoryScore,
                        resultEvaluationScore: pickEvaluationResultScore(row.rawAnalysisJson),
                        customEvaluationScore: pickCustomEvaluationScore(row.rawAnalysisJson),
                    });
                    if (run.status !== 'pass' || run.score !== score) changed = true;
                    run.status = 'pass';
                    run.score = score;
                    run.tier = scoreTier(score);
                    markRunCompleted(run, row.updatedAt instanceof Date ? row.updatedAt.toISOString() : undefined);
                } else {
                    if (run.status !== 'fail') changed = true;
                    run.status = 'fail';
                    run.output = row.errorMessage || run.output || '评测失败';
                    markRunCompleted(run, row.updatedAt instanceof Date ? row.updatedAt.toISOString() : undefined);
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

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
    const queue = [...items];
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
        while (queue.length > 0) {
            const item = queue.shift();
            if (!item) return;
            await worker(item);
        }
    });
    await Promise.all(workers);
}

type ResolvedVersion = Awaited<ReturnType<typeof resolveVersion>>;
type ExecutionTarget = { caseId: string; side: Side; roundIndex: number; runIndex: number; run: RunResult };
type EvaluationTarget = { caseId: string; side: Side; run: RunResult };

async function executeSingleAgentRun(args: {
    taskId: string;
    user: string;
    config: GrayscaleConfig;
    states: CaseStates;
    caseMap: Map<string, DatasetCase>;
    totalRunsPerSide: number;
    version: ResolvedVersion;
    target: ExecutionTarget;
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
    let didTimeout = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
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
        // Execution 行的写库已经由 runGeneralAgent 里的 recordTraceAs 选项处理
        // (上面调用时传了 grayAgentName)。不在这里重复写。
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
        markLatestGrayResultAt(args.config);
        state[target.side] = rebuildSideAggregate(state[target.side], args.totalRunsPerSide);
        await persistTaskState(args.taskId, args.user, args.config, args.states);
    }
}

async function startSingleEvaluation(origin: string, user: string, config: GrayscaleConfig, pair: { caseId: string; taskId: string }, evaluatorId?: string) {
    const res = await fetch(`${origin}/api/eval/trajectory/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            user,
            datasetId: config.selectedDatasetId,
            pairs: [pair],
            evaluator: evaluatorId || config.evaluatorId || 'preset-agent-task-completion',
        }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.evaluatorRunId) {
        throw new Error(data.error || 'failed to start trajectory evaluation');
    }
    return String(data.evaluatorRunId);
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

function markStateRunsFailed(states: CaseStates, evaluatorRunId: string | undefined, errorMessage: string) {
    if (!evaluatorRunId) return;
    for (const state of Object.values(states)) {
        for (const side of ['a', 'b'] as Side[]) {
            let changed = false;
            for (const run of state[side].runs || []) {
                if (run.evaluatorRunId !== evaluatorRunId) continue;
                if (run.status !== 'evaluating' && run.status !== 'running') continue;
                run.status = 'fail';
                run.output = errorMessage;
                changed = true;
            }
            if (changed) {
                state[side] = rebuildSideAggregate(state[side], state[side].runCount || state[side].runs?.length || 0);
            }
        }
    }
}

async function evaluateSingleRunTarget(args: {
    taskId: string;
    user: string;
    origin: string;
    config: GrayscaleConfig;
    states: CaseStates;
    evaluatorId?: string;
    target: EvaluationTarget;
}) {
    const { target } = args;
    let evaluatorRunId: string | undefined;
    target.run.status = 'evaluating';
    target.run.evaluationAttempts = (target.run.evaluationAttempts || 0) + 1;
    delete target.run.evaluationResultId;
    delete target.run.evaluationTraceId;
    delete target.run.score;
    delete target.run.tier;
    args.states[target.caseId][target.side] = rebuildSideAggregate(
        args.states[target.caseId][target.side],
        args.states[target.caseId][target.side].runCount || args.states[target.caseId][target.side].runs?.length || 0,
    );
    await persistTaskState(args.taskId, args.user, args.config, args.states);

    try {
        evaluatorRunId = await startSingleEvaluation(
            args.origin,
            args.user,
            args.config,
            { caseId: target.caseId, taskId: target.run.sessionId! },
            args.evaluatorId,
        );
        target.run.evaluatorRunId = evaluatorRunId;
        args.states[target.caseId][target.side].evaluatorRunId = evaluatorRunId;
        await persistTaskState(args.taskId, args.user, args.config, args.states);

        await waitAndApplyEvaluation(args.origin, args.user, evaluatorRunId, args.states);
        await hydrateExecutionMetrics(args.states);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (evaluatorRunId) {
            await markEvaluatorRunFailed(args.user, evaluatorRunId, message).catch(() => {});
        }
        target.run.status = 'fail';
        target.run.output = message;
        markRunCompleted(target.run);
        args.states[target.caseId][target.side] = rebuildSideAggregate(
            args.states[target.caseId][target.side],
            args.states[target.caseId][target.side].runCount || args.states[target.caseId][target.side].runs?.length || 0,
        );
    }
    markLatestGrayResultAt(args.config);
    await persistTaskState(args.taskId, args.user, args.config, args.states);
}

async function waitAndApplyEvaluation(origin: string, user: string, evaluatorRunId: string, states: CaseStates) {
    const timeoutMessage = 'evaluation timed out';
    for (let i = 0; i < 180; i++) {
        const res = await fetch(`${origin}/api/eval/trajectory/results?user=${encodeURIComponent(user)}&runId=${encodeURIComponent(evaluatorRunId)}&limit=500`);
        const data = await res.json().catch(() => ({}));
        const body = data as { results?: TrajectoryApiResult[] };
        const results = Array.isArray(body.results) ? body.results : [];
        if (results.length > 0) {
            for (const result of results) {
                if (result.status !== 'done' && result.status !== 'failed') continue;
                for (const state of Object.values(states)) {
                    for (const side of ['a', 'b'] as Side[]) {
                        for (const run of state[side].runs || []) {
                            if (run.sessionId !== result.taskId) continue;
                            run.evaluatorRunId = evaluatorRunId;
                            run.evaluationResultId = result.id || run.evaluationResultId;
                            run.evaluationTraceId = pickEvaluationTraceIdFromRaw(result.rawAnalysis) || run.evaluationTraceId;
                            if (result.status === 'done') {
                                const score = compositeScore(result);
                                run.status = 'pass';
                                run.score = score;
                                run.tier = scoreTier(score);
                                markRunCompleted(run);
                            } else {
                                run.status = 'fail';
                                run.output = result.errorMessage || run.output || '评测失败';
                                markRunCompleted(run);
                            }
                        }
                        state[side] = rebuildSideAggregate(state[side], state[side].runCount || 0);
                    }
                }
            }
        }
        if (results.length > 0 && results.every(r => r.status === 'done' || r.status === 'failed')) return;
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    await markEvaluatorRunFailed(user, evaluatorRunId, timeoutMessage);
    markStateRunsFailed(states, evaluatorRunId, timeoutMessage);
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
    onlyMissingEvaluation?: boolean;
}) {
    const targets: EvaluationTarget[] = [];
    for (const caseId of args.caseIds) {
        const state = args.states[caseId];
        if (!state) continue;
        for (const side of ['a', 'b'] as Side[]) {
            for (const run of state[side].runs || []) {
                if (args.onlyMissingEvaluation && (run.evaluatorRunId || typeof run.score === 'number')) {
                    continue;
                }
                if ((run.status === 'executed' || run.status === 'pass') && run.sessionId) {
                    targets.push({ caseId, side, run });
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
            const beforeRunId = target.run.evaluatorRunId;
            await withBackgroundOpencodeSlot(
                () => evaluateSingleRunTarget({ ...args, target }),
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
                    // TODO: evaluateRunsWithConcurrency 当前从 args.config.skillId 索引,这一层
                    // 拿不到具体 versionA/B 的 skillName/version。后续 refactor 让 caller 把
                    // versionA/B 显式传进 args 后再补齐 skill 透传。当前 grayscale-eval 任务
                    // 在 dashboard 按 skill 过滤时会看不见,需要在"显示所有"模式才能看到。
                },
            );
            if (target.run.evaluatorRunId && target.run.evaluatorRunId !== beforeRunId) {
                evaluatorRunIds.push(target.run.evaluatorRunId);
            }
        });
    };

    await runEvaluationBatch(targets);
    for (let retry = 1; retry <= MAX_EVALUATION_RETRIES; retry++) {
        const failedTargets = targets.filter(target => target.run.status === 'fail' && target.run.sessionId);
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
        agentMaxConcurrency: args.agentMaxConcurrency || task.configJson.agentMaxConcurrency,
    };
    const datasetId = String(config.selectedDatasetId || '');
    if (!datasetId) throw new Error('dataset is required');
    const dataset = await findAgentDataset(user, datasetId);
    if (!dataset) throw new Error('dataset not found');

    const runCount = Math.max(1, Number(config.runCount || args.caseIds.length || 1));
    const repeatRounds = Math.max(1, Number(config.repeatRounds || 1));
    const caseIds = args.caseIds.slice(0, runCount);
    if (caseIds.length !== runCount) throw new Error(`selected case count ${caseIds.length} does not match runCount ${runCount}`);

    const caseMap = new Map<string, DatasetCase>(dataset.cases.map(c => [c.id, c]));
    for (const caseId of caseIds) {
        if (!caseMap.get(caseId)?.input?.trim()) throw new Error(`case ${caseId} not found or missing input`);
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
    const runExecutionBatch = async (batch: ExecutionTarget[]) => {
        await runWithConcurrency(batch, concurrency, async item => {
            const version = item.side === 'a' ? versionA : versionB;
            await withBackgroundOpencodeSlot(
                () => executeSingleAgentRun({
                    taskId,
                    user,
                    config,
                    states,
                    caseMap,
                    totalRunsPerSide,
                    version,
                    target: item,
                }),
                {
                    taskType: 'grayscale-ab',
                    user,
                    label: `grayscale-${item.side}-${item.caseId}-r${item.roundIndex}`,
                    skill: version?.skillName,
                    skillVersion: version?.version ?? null,
                },
            );
        });
    };

    await runExecutionBatch(work);
    for (let retry = 1; retry <= MAX_EXECUTION_RETRIES; retry++) {
        const failedWork = work.filter(item => item.run.status === 'fail');
        if (failedWork.length === 0) break;
        await runExecutionBatch(failedWork);
    }

    if (config.autoEval !== false) {
        activeRuns().set(storeKey, { taskId, runId: activeRuns().get(storeKey)?.runId || '', status: 'evaluating', startedAt: Date.now() });
        await evaluateRunsWithConcurrency({ taskId, user, origin, config, states, caseIds, evaluatorId });
    }
}

async function evaluateExistingTask(args: { taskId: string; user: string; origin: string; caseIds: string[]; evaluatorId?: string }) {
    const task = await loadTask(args.taskId, args.user);
    if (!task) throw new Error('task not found');
    validateTaskSkillBinding(task);
    const config = { ...task.configJson, skillId: task.skillId, evaluatorId: args.evaluatorId || task.configJson.evaluatorId };
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
        const reconciled = await reconcileFinishedEvaluations(user, task.configJson, task.caseStatesJson);
        if (metricsHydrated || executionsReconciled || reconciled) {
            await persistTaskState(taskId, user, task.configJson, task.caseStatesJson);
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
                    onlyMissingEvaluation: true,
                })
                    .catch(err => console.error('[GRAYSCALE_TASKS_RECOVER_EVAL] Failed:', err))
                    .finally(() => {
                        activeRuns().delete(storeKey);
                    });
            }
        }
        return NextResponse.json({ ...task, activeRun: activeRuns().get(`${user}:${taskId}`) || null });
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
        const agentMaxConcurrency = typeof body.agentMaxConcurrency === 'number' && Number.isFinite(body.agentMaxConcurrency)
            ? Math.max(1, Math.floor(body.agentMaxConcurrency))
            : undefined;
        if (!user || !taskId) {
            return NextResponse.json({ error: 'user and taskId are required' }, { status: 400 });
        }
        if (caseIds.length === 0 && action === 'start') {
            return NextResponse.json({ error: 'caseIds are required' }, { status: 400 });
        }
        const storeKey = `${user}:${taskId}`;
        if (activeRuns().has(storeKey)) {
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
        activeRuns().set(storeKey, { taskId, runId, status: action === 'evaluate' ? 'evaluating' : 'running', startedAt: Date.now() });

        const job = action === 'evaluate'
            ? evaluateExistingTask({ taskId, user, origin, caseIds, evaluatorId })
            : runGrayscaleTask({ taskId, user, origin, caseIds, evaluatorId, agentMaxConcurrency });

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
                activeRuns().delete(storeKey);
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
                ? { ...(configJson as GrayscaleConfig) }
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
        if (typeof taskName === 'string' && taskName.trim()) data.taskName = taskName.trim();

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
                ...JSON.parse(updated.configJson || '{}'),
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
