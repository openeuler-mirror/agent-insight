import { createHash } from 'node:crypto';

import {
    buildAgentCallTree,
    walkTree,
    type AgentEvent,
    type InteractionUsage,
    type RawInteraction,
} from '@/lib/engine/observability/agent-trace';
import { stringifyClaudeContent } from '@/lib/shared/interaction-content';

export type AgentTrajectoryStepKind = 'user' | 'llm' | 'tool' | 'skill' | 'task';
export type AgentTrajectoryStepStatus = 'ok' | 'error' | 'timeout' | 'cancelled' | 'unknown';

export interface AgentTrajectoryStepTokens {
    input?: number;
    output?: number;
    reasoning?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
    estimated?: boolean;
}

export interface AgentTrajectoryStepFact {
    index: number;
    interactionIndex: number;
    /** Internal tree identity used to keep retry candidates within one agent invocation. */
    agentNodeId?: string;
    /** Internal spawn link used to keep child-agent evidence in its originating root turn. */
    spawnedChildId?: string;
    agent?: string;
    depth: number;
    kind: AgentTrajectoryStepKind;
    name?: string;
    argsSummary?: string;
    argsFingerprint?: string;
    outputSummary?: string;
    outputFingerprint?: string;
    textSummary?: string;
    /** Whether the underlying interaction contained visible assistant/user text. */
    visibleText?: boolean;
    status: AgentTrajectoryStepStatus;
    errorSummary?: string;
    startedAt?: number;
    completedAt?: number;
    durationMs?: number;
    tokens?: AgentTrajectoryStepTokens;
}

export interface AgentTrajectoryCandidate {
    kind: AgentTrajectoryStepKind;
    name?: string;
    stepIndexes: number[];
    stepIndexChunks: number[][];
    page: number;
}

export interface AgentTrajectoryCallStatistics {
    countsByKind: Record<AgentTrajectoryStepKind, number>;
    failureCount: number;
    totalTokens: number;
    totalDurationMs?: number;
    duplicateCallShare?: number;
}

export interface AgentTrajectoryStatistics {
    totalSteps: number;
    agentTreeDepth: number;
    totalLlmCalls: number;
    totalToolCalls: number;
    totalSkillCalls: number;
    totalTaskCalls: number;
    totalTokens: number;
    durationMs?: number;
    rootAgentName?: string;
    callStatistics: AgentTrajectoryCallStatistics;
}

export interface AgentTrajectoryCandidates {
    repeatedSameCallCandidates: AgentTrajectoryCandidate[];
    repeatedSameResultCandidates: AgentTrajectoryCandidate[];
    unchangedRetryCandidates: AgentTrajectoryCandidate[];
    consecutiveSimilarCandidates: AgentTrajectoryCandidate[];
}

export interface AgentTrajectoryFacts {
    steps: AgentTrajectoryStepFact[];
    statistics: AgentTrajectoryStatistics;
    candidates: AgentTrajectoryCandidates;
}

export function compareAgentTrajectoryStepTemporalOrder(
    left: AgentTrajectoryStepFact,
    right: AgentTrajectoryStepFact,
): number {
    return left.interactionIndex - right.interactionIndex || left.index - right.index;
}

export class TrajectoryPromptTooLargeError extends Error {
    constructor(message = '完整轨迹超过当前 Judge 上下文限制') {
        super(message);
        this.name = 'TrajectoryPromptTooLargeError';
    }
}

const MAX_PROMPT_FIELD_LEN = 500;
const MAX_PROMPT_CHARS = 120_000;
const CANDIDATE_PAGE_SIZE = 5;
const STEP_INDEX_CHUNK_SIZE = 10;
const REDACTED_PROMPT_VALUE = '[REDACTED]';
const SENSITIVE_PROMPT_KEYS = new Set([
    'password',
    'passwd',
    'pwd',
    'secret',
    'token',
    'apikey',
    'authorization',
    'proxyauthorization',
    'xapikey',
    'credential',
    'credentials',
    'cookie',
    'setcookie',
    'accesstoken',
    'refreshtoken',
    'sessiontoken',
    'authtoken',
    'clientsecret',
    'secretaccesskey',
    'awssecretaccesskey',
    'privatekey',
]);
const MISSING_ARGS_FINGERPRINT = createHash('sha256')
    .update('__agent_trajectory_missing_args__')
    .digest('hex');

export function extractAgentTrajectoryFacts(interactions: unknown[]): AgentTrajectoryFacts {
    const tree = buildAgentCallTree((Array.isArray(interactions) ? interactions : []) as RawInteraction[]);
    const countsByKind: Record<AgentTrajectoryStepKind, number> = {
        user: 0,
        llm: 0,
        tool: 0,
        skill: 0,
        task: 0,
    };

    if (!tree) {
        return {
            steps: [],
            statistics: {
                totalSteps: 0,
                agentTreeDepth: 0,
                totalLlmCalls: 0,
                totalToolCalls: 0,
                totalSkillCalls: 0,
                totalTaskCalls: 0,
                totalTokens: 0,
                callStatistics: {
                    countsByKind,
                    failureCount: 0,
                    totalTokens: 0,
                },
            },
            candidates: {
                repeatedSameCallCandidates: [],
                repeatedSameResultCandidates: [],
                unchangedRetryCandidates: [],
                consecutiveSimilarCandidates: [],
            },
        };
    }

    const steps: AgentTrajectoryStepFact[] = [];
    let agentTreeDepth = 0;
    let totalTokens = 0;
    let failureCount = 0;
    let totalDurationMs = 0;
    let hasDuration = false;
    let trajectoryStartedAt: number | undefined;
    let trajectoryEndedAt: number | undefined;

    walkTree(tree, (node) => {
        agentTreeDepth = Math.max(agentTreeDepth, node.depth);
        totalTokens += node.stats.totalTokens;
        if (Number.isFinite(node.startedAt)) {
            trajectoryStartedAt = trajectoryStartedAt === undefined
                ? node.startedAt as number
                : Math.min(trajectoryStartedAt, node.startedAt as number);
        }
        if (Number.isFinite(node.endedAt)) {
            trajectoryEndedAt = trajectoryEndedAt === undefined
                ? node.endedAt as number
                : Math.max(trajectoryEndedAt, node.endedAt as number);
        }

        for (const event of node.events) {
            const kind = normalizeEventKind(event);
            if (!kind) continue;

            const status = normalizeStatus(event);
            const argsSummary = summarizeValue(event.args);
            const outputSummary = summarizeValue(event.output);
            const textSummary = clipText(redactCredentialPatterns(normalizeText(event.summary)));
            const durationMs = normalizeDuration(event.startedAt, event.completedAt);
            if (durationMs !== undefined) {
                totalDurationMs += durationMs;
                hasDuration = true;
            }

            const fact: AgentTrajectoryStepFact = {
                index: steps.length,
                interactionIndex: event.interactionIndex,
                agentNodeId: node.id,
                spawnedChildId: event.spawnedChildId,
                agent: node.depth > 0 ? node.agentName : undefined,
                depth: node.depth,
                kind,
                name: normalizeText(event.name),
                argsSummary,
                argsFingerprint: fingerprintArgsValue(event.args),
                outputSummary,
                outputFingerprint: fingerprintValue(event.output),
                textSummary,
                visibleText: hasVisibleInteractionText(event.interaction),
                status,
                errorSummary: clipText(redactCredentialPatterns(normalizeErrorSummary(event))),
                startedAt: normalizeTimestamp(event.startedAt),
                completedAt: normalizeTimestamp(event.completedAt),
                durationMs,
                tokens: normalizeTokens(event.usage),
            };

            steps.push(fact);
            countsByKind[kind] += 1;
            if (status === 'error' || status === 'timeout' || status === 'cancelled') {
                failureCount += 1;
            }
        }
    });

    steps.sort(compareAgentTrajectoryStepTemporalOrder);
    steps.forEach((step, index) => {
        step.index = index;
    });

    const repeatedSameCallCandidates = buildRepeatedSameCallCandidates(steps);
    const repeatedSameResultCandidates = buildRepeatedSameResultCandidates(steps);
    const unchangedRetryCandidates = buildUnchangedRetryCandidates(steps);
    const consecutiveSimilarCandidates = buildConsecutiveSimilarCandidates(steps);

    const callableSteps = steps.filter((step) => step.kind === 'tool' || step.kind === 'skill' || step.kind === 'task');
    const largestRepeatedGroup = repeatedSameCallCandidates.reduce((max, candidate) =>
        Math.max(max, candidate.stepIndexes.length), 0);

    return {
        steps,
        statistics: {
            totalSteps: steps.length,
            agentTreeDepth,
            totalLlmCalls: countsByKind.llm,
            totalToolCalls: countsByKind.tool,
            totalSkillCalls: countsByKind.skill,
            totalTaskCalls: countsByKind.task,
            totalTokens,
            durationMs: trajectoryStartedAt !== undefined && trajectoryEndedAt !== undefined
                ? Math.max(0, trajectoryEndedAt - trajectoryStartedAt)
                : undefined,
            rootAgentName: tree.agentName,
            callStatistics: {
                countsByKind,
                failureCount,
                totalTokens,
                totalDurationMs: hasDuration ? totalDurationMs : undefined,
                duplicateCallShare: callableSteps.length > 0
                    ? Number((largestRepeatedGroup / callableSteps.length).toFixed(4))
                    : undefined,
            },
        },
        candidates: {
            repeatedSameCallCandidates,
            repeatedSameResultCandidates,
            unchangedRetryCandidates,
            consecutiveSimilarCandidates,
        },
    };
}

export function promptAgentTrajectoryFacts(facts: AgentTrajectoryFacts): unknown {
    const prompt = {
        statistics: redactAgentTrajectoryPromptValue({
            ...facts.statistics,
            rootAgentName: clipText(redactCredentialPatterns(facts.statistics.rootAgentName)),
        }),
        steps: facts.steps.map((step) => ({
            index: step.index,
            interactionIndex: step.interactionIndex,
            agent: clipText(redactCredentialPatterns(step.agent)),
            depth: step.depth,
            kind: step.kind,
            name: clipText(redactCredentialPatterns(step.name)),
            argsSummary: clipText(redactPromptSummary(step.argsSummary)),
            outputSummary: clipText(redactPromptSummary(step.outputSummary)),
            textSummary: clipText(redactCredentialPatterns(step.textSummary)),
            status: step.status,
            errorSummary: clipText(redactCredentialPatterns(step.errorSummary)),
            startedAt: step.startedAt,
            completedAt: step.completedAt,
            durationMs: step.durationMs,
            tokens: step.tokens,
        })),
        candidates: sanitizeCandidates(facts.candidates),
    };

    const safePrompt = redactAgentTrajectoryPromptValue(prompt);
    if (JSON.stringify(safePrompt).length > MAX_PROMPT_CHARS) {
        throw new TrajectoryPromptTooLargeError();
    }

    return safePrompt;
}

export function redactAgentTrajectoryPromptValue(value: unknown, key?: string): unknown {
    if (key && isSensitivePromptKey(key)) return REDACTED_PROMPT_VALUE;
    if (typeof value === 'string') {
        return redactCredentialPatterns(value);
    }
    if (Array.isArray(value)) {
        return value.map(item => redactAgentTrajectoryPromptValue(item));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
            entryKey,
            redactAgentTrajectoryPromptValue(entryValue, entryKey),
        ]));
    }
    return value;
}

function redactPromptSummary(value?: string): string | undefined {
    if (value === undefined) return undefined;
    try {
        return stableStringify(redactAgentTrajectoryPromptValue(JSON.parse(value)));
    } catch {
        return redactCredentialPatterns(value);
    }
}

function redactCredentialPatterns(value?: string): string | undefined {
    if (value === undefined) return undefined;
    return value
        .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi, REDACTED_PROMPT_VALUE)
        .replace(/\b(?:xox[baprs]-[A-Za-z0-9-]{10,})\b/g, REDACTED_PROMPT_VALUE)
        .replace(/\b((?:https?|postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/)(?:[^\/\s:@]+(?::[^\/\s@]*)?@)/gi, `$1${REDACTED_PROMPT_VALUE}@`)
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, REDACTED_PROMPT_VALUE)
        .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, REDACTED_PROMPT_VALUE)
        .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g, REDACTED_PROMPT_VALUE)
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED_PROMPT_VALUE)
        .replace(
            /(["']?\b(x[_-]?api[_-]?key|proxy[_-]?authorization|(?:aws[_-]?)?secret[_-]?access[_-]?key|password|passwd|pwd|secret|token|api[_-]?key|authorization|credential|credentials|cookie|access[_-]?token|refresh[_-]?token|session[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*)(?:\[REDACTED\]|"[^"]*"|'[^']*'|[^\s,;}\]&]+)/gi,
            (_match, field: string) => `${field}${REDACTED_PROMPT_VALUE}`,
        );
}

function isSensitivePromptKey(key: string): boolean {
    return SENSITIVE_PROMPT_KEYS.has(normalizePromptKey(key));
}

function normalizePromptKey(key: string): string {
    return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function sanitizeCandidates(candidates: AgentTrajectoryCandidates): AgentTrajectoryCandidates {
    return {
        repeatedSameCallCandidates: candidates.repeatedSameCallCandidates.map(sanitizeCandidate),
        repeatedSameResultCandidates: candidates.repeatedSameResultCandidates.map(sanitizeCandidate),
        unchangedRetryCandidates: candidates.unchangedRetryCandidates.map(sanitizeCandidate),
        consecutiveSimilarCandidates: candidates.consecutiveSimilarCandidates.map(sanitizeCandidate),
    };
}

function sanitizeCandidate(candidate: AgentTrajectoryCandidate): AgentTrajectoryCandidate {
    return {
        kind: candidate.kind,
        name: clipText(redactCredentialPatterns(candidate.name)),
        stepIndexes: [...candidate.stepIndexes],
        stepIndexChunks: candidate.stepIndexChunks.map((chunk) => [...chunk]),
        page: candidate.page,
    };
}

function buildRepeatedSameCallCandidates(steps: AgentTrajectoryStepFact[]): AgentTrajectoryCandidate[] {
    const groups = new Map<string, AgentTrajectoryCandidate>();
    const segments = buildTrajectorySegments(steps);
    for (const step of steps) {
        if (!isCallableStep(step) || step.argsFingerprint === undefined) continue;
        const actorIdentity = step.agentNodeId ?? `${step.depth}:${step.agent || ''}`;
        const key = [segments.get(step.index) ?? '0', actorIdentity, step.kind, step.name || '', step.argsFingerprint].join('\u0000');
        const group = groups.get(key) ?? {
            kind: step.kind,
            name: step.name,
            stepIndexes: [],
            stepIndexChunks: [],
            page: 1,
        };
        group.stepIndexes.push(step.index);
        groups.set(key, group);
    }
    return finalizeCandidates([...groups.values()].filter((candidate) => candidate.stepIndexes.length >= 2));
}

function buildRepeatedSameResultCandidates(steps: AgentTrajectoryStepFact[]): AgentTrajectoryCandidate[] {
    const groups = new Map<string, AgentTrajectoryCandidate>();
    const segments = buildTrajectorySegments(steps);
    for (const step of steps) {
        if (isRetryStatus(step.status) || !isCallableStep(step) || step.argsFingerprint === undefined || step.outputFingerprint === undefined) continue;
        const actorIdentity = step.agentNodeId ?? `${step.depth}:${step.agent || ''}`;
        const key = [segments.get(step.index) ?? '0', actorIdentity, step.kind, step.name || '', step.argsFingerprint, step.outputFingerprint].join('\u0000');
        const group = groups.get(key) ?? {
            kind: step.kind,
            name: step.name,
            stepIndexes: [],
            stepIndexChunks: [],
            page: 1,
        };
        group.stepIndexes.push(step.index);
        groups.set(key, group);
    }
    return finalizeCandidates([...groups.values()].filter((candidate) => candidate.stepIndexes.length >= 2));
}

function buildUnchangedRetryCandidates(steps: AgentTrajectoryStepFact[]): AgentTrajectoryCandidate[] {
    const candidates: AgentTrajectoryCandidate[] = [];
    const callableChains = new Map<string, AgentTrajectoryStepFact[]>();
    const segments = buildTrajectorySegments(steps);

    for (const step of steps) {
        if (!isCallableStep(step)) continue;
        const actorIdentity = step.agentNodeId ?? `${step.depth}:${step.agent || ''}`;
        const key = `${segments.get(step.index) ?? '0'}\u0000${actorIdentity}`;
        const chain = callableChains.get(key) ?? [];
        chain.push(step);
        callableChains.set(key, chain);
    }

    for (const callableSteps of callableChains.values()) {
        for (let index = 0; index < callableSteps.length - 1; index += 1) {
            const current = callableSteps[index];
            if (!isRetryStatus(current.status) || current.argsFingerprint === undefined) continue;

            const next = callableSteps[index + 1];
            if (!sameCall(current, next)) continue;

            const stepIndexes = [current.index, next.index];
            let cursor = index + 1;
            while (cursor + 1 < callableSteps.length
                && sameCall(callableSteps[cursor], callableSteps[cursor + 1])
                && isRetryStatus(callableSteps[cursor].status)) {
                cursor += 1;
                stepIndexes.push(callableSteps[cursor].index);
            }

            candidates.push({
                kind: current.kind,
                name: current.name,
                stepIndexes,
                stepIndexChunks: [],
                page: 1,
            });
            index = cursor;
        }
    }

    return finalizeCandidates(candidates);
}

function buildConsecutiveSimilarCandidates(steps: AgentTrajectoryStepFact[]): AgentTrajectoryCandidate[] {
    const candidates: AgentTrajectoryCandidate[] = [];
    let cursor = 0;

    while (cursor < steps.length) {
        const current = steps[cursor];
        if (!isConsecutiveCandidateKind(current.kind)) {
            cursor += 1;
            continue;
        }

        const stepIndexes = [current.index];
        let nextIndex = cursor + 1;
        while (
            nextIndex < steps.length
            && steps[nextIndex].kind === current.kind
            && (steps[nextIndex].name || '') === (current.name || '')
        ) {
            stepIndexes.push(steps[nextIndex].index);
            nextIndex += 1;
        }

        if (stepIndexes.length >= 2) {
            candidates.push({
                kind: current.kind,
                name: current.name,
                stepIndexes,
                stepIndexChunks: [],
                page: 1,
            });
        }

        cursor = nextIndex;
    }

    return finalizeCandidates(candidates);
}

function finalizeCandidates(candidates: AgentTrajectoryCandidate[]): AgentTrajectoryCandidate[] {
    return candidates
        .sort((left, right) => left.stepIndexes[0] - right.stepIndexes[0] || (left.name || '').localeCompare(right.name || ''))
        .map((candidate, index) => ({
            ...candidate,
            page: Math.floor(index / CANDIDATE_PAGE_SIZE) + 1,
            stepIndexChunks: chunkIndexes(candidate.stepIndexes),
        }));
}

function chunkIndexes(indexes: number[]): number[][] {
    const chunks: number[][] = [];
    for (let start = 0; start < indexes.length; start += STEP_INDEX_CHUNK_SIZE) {
        chunks.push(indexes.slice(start, start + STEP_INDEX_CHUNK_SIZE));
    }
    return chunks;
}

function sameCall(left: AgentTrajectoryStepFact, right: AgentTrajectoryStepFact): boolean {
    return isCallableStep(left)
        && isCallableStep(right)
        && left.kind === right.kind
        && (left.name || '') === (right.name || '')
        && left.argsFingerprint !== undefined
        && left.argsFingerprint === right.argsFingerprint;
}

function isCallableStep(step: AgentTrajectoryStepFact): boolean {
    return step.kind === 'tool' || step.kind === 'skill' || step.kind === 'task';
}

function isConsecutiveCandidateKind(kind: AgentTrajectoryStepKind): boolean {
    return kind === 'llm' || kind === 'tool' || kind === 'skill';
}

function isRetryStatus(status: AgentTrajectoryStepStatus): boolean {
    return status === 'error' || status === 'timeout' || status === 'cancelled';
}

function normalizeEventKind(event: AgentEvent): AgentTrajectoryStepKind | null {
    if (event.kind === 'ras') return null;
    if (event.kind === 'chain') return 'task';
    if (event.kind === 'user' || event.kind === 'llm' || event.kind === 'tool' || event.kind === 'skill' || event.kind === 'task') {
        return event.kind;
    }
    return null;
}

function normalizeStatus(event: AgentEvent): AgentTrajectoryStepStatus {
    const rawStatus = firstNonEmptyString(
        event.toolStatus,
        event.interaction.trace_status,
        event.interaction.status,
        normalizeErrorSummary(event) ? 'error' : undefined,
    );
    if (!rawStatus) return 'unknown';

    const normalized = rawStatus.trim().toLowerCase();
    if (/(^|[_\s-])(ok|success|successful|completed|done)([_\s-]|$)/.test(normalized)) return 'ok';
    if (normalized.includes('timeout') || normalized.includes('timed_out') || normalized.includes('deadline') || normalized.includes('expired')) return 'timeout';
    if (normalized.includes('cancel') || normalized.includes('abort') || normalized.includes('interrupted')) return 'cancelled';
    if (normalized.includes('error') || normalized.includes('fail')) return 'error';
    return 'unknown';
}

function normalizeErrorSummary(event: AgentEvent): string | undefined {
    const errorSummary = normalizeText(event.interaction.error_summary);
    if (errorSummary) return errorSummary;
    if (typeof event.interaction.error === 'string') return normalizeText(event.interaction.error);
    if (event.interaction.error && typeof event.interaction.error === 'object') {
        return normalizeText(event.interaction.error.message);
    }
    if (event.interaction.status && String(event.interaction.status).toLowerCase() === 'error') {
        return 'LLM 调用失败';
    }
    return undefined;
}

function normalizeTokens(usage?: InteractionUsage): AgentTrajectoryStepTokens | undefined {
    if (!usage) return undefined;
    const tokens: AgentTrajectoryStepTokens = {
        input: finiteNumberOrUndefined(usage.input),
        output: finiteNumberOrUndefined(usage.output),
        reasoning: finiteNumberOrUndefined(usage.reasoning),
        cacheRead: finiteNumberOrUndefined(usage.cache?.read),
        cacheWrite: finiteNumberOrUndefined(usage.cache?.write),
        total: finiteNumberOrUndefined(usage.total),
        estimated: usage.estimated === true ? true : undefined,
    };

    return Object.values(tokens).some((value) => value !== undefined) ? tokens : undefined;
}

function normalizeDuration(startedAt?: number, completedAt?: number): number | undefined {
    const start = normalizeTimestamp(startedAt);
    const end = normalizeTimestamp(completedAt);
    if (start === undefined || end === undefined) return undefined;
    const duration = end - start;
    return duration >= 0 ? duration : undefined;
}

function normalizeTimestamp(value?: number): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function summarizeValue(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    return clipText(redactCredentialPatterns(stableStringify(value)));
}

function normalizeText(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    return value ? value : undefined;
}

function fingerprintValue(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function fingerprintArgsValue(value: unknown): string {
    if (isMissingArgsValue(value)) return MISSING_ARGS_FINGERPRINT;
    return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function isMissingArgsValue(value: unknown): boolean {
    return value === undefined
        || value === null
        || (typeof value === 'string' && value.trim() === '')
        || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0);
}

function hasVisibleInteractionText(interaction: AgentEvent['interaction']): boolean {
    if (typeof interaction.content === 'string' && interaction.content.trim()) return true;
    if (interaction.content && stringifyClaudeContent(interaction.content).trim()) return true;
    return Array.isArray(interaction.parts)
        && interaction.parts.some(part => part.type === 'text' && typeof part.text === 'string' && part.text.trim());
}

function buildTrajectorySegments(steps: AgentTrajectoryStepFact[]): Map<number, string> {
    const segments = new Map<number, string>();
    const rootNodeId = steps.find(step => step.depth === 0)?.agentNodeId;
    const rootSegmentByStep = new Map<number, number>();
    let rootSegment = 0;
    for (const step of steps) {
        if (step.kind === 'user' && step.depth === 0) rootSegment += 1;
        rootSegmentByStep.set(step.index, rootSegment);
    }

    const childSegment = new Map<string, number>();
    for (const step of steps) {
        if (!step.spawnedChildId || !step.agentNodeId) continue;
        const parentSegment = step.agentNodeId === rootNodeId
            ? rootSegmentByStep.get(step.index) ?? 0
            : childSegment.get(step.agentNodeId);
        if (parentSegment !== undefined) childSegment.set(step.spawnedChildId, parentSegment);
    }

    for (const step of steps) {
        const segment = step.agentNodeId && step.agentNodeId !== rootNodeId
            ? childSegment.get(step.agentNodeId) ?? rootSegmentByStep.get(step.index) ?? 0
            : rootSegmentByStep.get(step.index) ?? 0;
        segments.set(step.index, `${segment}`);
    }
    return segments;
}

function stableStringify(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortValue);
    }
    if (value && typeof value === 'object') {
        return Object.keys(value as Record<string, unknown>)
            .sort()
            .reduce<Record<string, unknown>>((acc, key) => {
                acc[key] = sortValue((value as Record<string, unknown>)[key]);
                return acc;
            }, {});
    }
    return value;
}

function clipText(value?: string): string | undefined {
    if (value === undefined) return undefined;
    return value.slice(0, MAX_PROMPT_FIELD_LEN);
}

function finiteNumberOrUndefined(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value;
    }
    return undefined;
}
