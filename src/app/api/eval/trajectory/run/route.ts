import { NextResponse } from 'next/server';
import { db, prismaRaw as prisma } from '@/lib/storage/prisma';
import { findAgentDataset, readAllAgentDatasets, type AgentDatasetRecord, type DatasetCase } from '@/server/agent_datasets_storage';
import {
    evaluateTrajectoryViaOpencode,
    TrajectoryEvalConfigError,
    type TrajectoryEvalInput,
} from '@/lib/engine/evaluation/opencode-trajectory-evaluator';
import { evaluateTaskCompletionViaOpencode } from '@/lib/engine/evaluation/opencode-task-completion-evaluator';
import { startOrReplace as startEvalTask, finish as finishEvalTask } from '@/lib/evaluation-task-manager';
import { deriveAndPersistOptPoints } from '@/lib/engine/evaluation/derive-skill-opt-points';
import {
    analyzeDynamicOnly,
    extractKeyActionsFromFlow,
    mergeKeyActionsFromMultipleSkills,
    type ExtractedKeyAction,
    type ParsedFlowResult,
} from '@/lib/engine/observability/flow-parser';
import { extractRealUserInput, findBestSemanticCaseMatch } from '@/lib/engine/evaluation/semantic-dataset-match';
import { extractTaskResultArtifact } from '@/lib/engine/evaluation/result-artifact-extractor';
import {
    extractTrajectoryTaskMeta,
    normalizeTrajectoryTaskMeta,
} from '@/lib/eval/trajectory-task-meta';
import {
    isCustomEvaluatorId,
    listCustomEvaluatorIds,
    loadCustomEvaluator,
    runCustomLlmEvaluator,
} from '@/lib/engine/evaluation/custom-llm-evaluator';
import { summarizeTrace, formatTraceForLLM } from '@/lib/engine/evaluation/trace-summarizer';
import {
    buildSkillAttributionStatus,
    type SkillKeyActionComparisonResult,
} from '@/lib/engine/evaluation/skill-attribution';
import { getRootSkillFromInteractions } from '@/lib/engine/observability/skill-scope';

export const dynamic = 'force-dynamic';

interface RunPair {
    caseId: string;
    executionId?: string;
    taskId?: string;
}

const SUPPORTED_TRAJECTORY_EVALUATORS = new Set([
    'trace-quality-evaluator',
    'preset-agent-trace-quality',
    'preset-agent-task-completion',
]);

const TRACE_EVALUATOR_ID = 'preset-agent-trace-quality';
const TASK_COMPLETION_EVALUATOR_ID = 'preset-agent-task-completion';
const EVALUATOR_LABELS: Record<string, string> = {
    [TRACE_EVALUATOR_ID]: 'Agent 轨迹质量',
    [TASK_COMPLETION_EVALUATOR_ID]: 'Agent 任务完成度',
};

function generateRunId(): string {
    return `trun_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const NO_EVALUABLE_CASE_PREFIX = '[no-evaluable-case]';
const CUSTOM_EVALUATOR_VARIABLE_RE = /\{\{\s*(input|output|reference_output|trajectory)\s*\}\}/g;
type CustomEvaluatorVariable = 'input' | 'output' | 'reference_output' | 'trajectory';

function normalizeMatchText(value: string | null | undefined): string {
    return String(value || '').trim().replace(/\s+/g, ' ');
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

interface SkillTarget {
    skill: string;
    version: number | null;
}

interface ExtractedTraceStep {
    name?: string;
    description?: string;
    dialogStartIndex?: number;
    dialogEndIndex?: number;
    type?: 'action' | 'decision' | 'output';
}

interface ExecutionLike {
    id?: string | null;
    taskId?: string | null;
    query?: string | null;
    agentName?: string | null;
    finalResult?: string | null;
    skill?: string | null;
    skillVersion?: number | null;
    invokedSkills?: string | null;
    skills?: string | null;
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

interface SelectedEvaluatorMeta {
    selectedEvaluators: string[];
    selectedEvaluatorNames: string[];
    autoWatch?: boolean;
    watchedAgent?: string;
}

function normalizeOptionalVersion(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function parseLooseJson(text: string): Record<string, unknown> | null {
    const trimmed = text.trim();
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
    options: { autoWatch?: boolean; watchedAgent?: string; customNameResolver?: (id: string) => string | undefined } = {},
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
    if (selectedEvaluators.length > 0) {
        if (selectedEvaluatorNames.length === selectedEvaluators.length) {
            return {
                selectedEvaluators,
                selectedEvaluatorNames,
                ...(autoWatch ? { autoWatch: true } : {}),
                ...(watchedAgent ? { watchedAgent } : {}),
            };
        }
        return buildSelectedEvaluatorMeta(selectedEvaluators, { autoWatch, watchedAgent });
    }
    return buildSelectedEvaluatorMeta([TRACE_EVALUATOR_ID], { autoWatch, watchedAgent });
}

function readSelectedEvaluatorMetaStrict(rawAnalysisJson: string | null | undefined): SelectedEvaluatorMeta | null {
    const parsed = rawAnalysisJson ? parseLooseJson(rawAnalysisJson) : null;
    const selectedEvaluators = normalizeSelectedEvaluators(parsed?.selectedEvaluators);
    if (selectedEvaluators.length === 0) return null;
    const selectedEvaluatorNames = Array.isArray(parsed?.selectedEvaluatorNames)
        ? parsed.selectedEvaluatorNames.filter((name): name is string => typeof name === 'string' && !!name.trim())
        : [];
    const autoWatch = parsed?.autoWatch === true;
    const watchedAgent = typeof parsed?.watchedAgent === 'string'
        ? parsed.watchedAgent.trim()
        : '';
    if (selectedEvaluatorNames.length === selectedEvaluators.length) {
        return {
            selectedEvaluators,
            selectedEvaluatorNames,
            ...(autoWatch ? { autoWatch: true } : {}),
            ...(watchedAgent ? { watchedAgent } : {}),
        };
    }
    return buildSelectedEvaluatorMeta(selectedEvaluators, { autoWatch, watchedAgent });
}

function mergeRawAnalysisMeta(
    rawAnalysisJson: string | null | undefined,
    meta: SelectedEvaluatorMeta,
): string {
    const parsed = safeParseRecord(rawAnalysisJson);
    const next: Record<string, unknown> = {
        ...parsed,
        selectedEvaluators: meta.selectedEvaluators,
        selectedEvaluatorNames: meta.selectedEvaluatorNames,
        watchedAgent: meta.watchedAgent || '',
    };
    if (meta.autoWatch) {
        next.autoWatch = true;
    } else {
        delete next.autoWatch;
    }
    if (!meta.watchedAgent) {
        delete next.watchedAgent;
    }
    return JSON.stringify(next);
}

function safeParseRecord(text: string | null | undefined): Record<string, unknown> {
    const parsed = parseLooseJson(text || '');
    return parsed && typeof parsed === 'object' ? parsed : {};
}

async function evaluateTaskCompletionAgainstExpected(
    caseInput: string,
    expectedOutput: string,
    actualOutput: string,
    user?: string | null,
    skillName?: string | null,
    skillVersion?: number | null,
): Promise<ResultJudgment> {
    const result = await evaluateTaskCompletionViaOpencode(
        { caseInput, expectedOutput, actualOutput },
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
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(error), timeoutMs)),
    ]);
}

async function persistResultJudgment(
    execution: ExecutionLike | null | undefined,
    resolvedTaskId: string | null | undefined,
    judgment: ResultJudgment,
): Promise<void> {
    const raw = judgment.rawAnalysis && typeof judgment.rawAnalysis === 'object'
        ? judgment.rawAnalysis as {
            key_point_findings?: unknown;
            raw_subagent_outputs?: { key_points?: { covered_points?: unknown } };
        }
        : null;
    const findings =
        raw?.key_point_findings
        ?? raw?.raw_subagent_outputs?.key_points?.covered_points;
    const isStructuredReady = typeof judgment.score === 'number'
        && Number.isFinite(judgment.score)
        && Boolean(String(judgment.reason || '').trim())
        && Array.isArray(findings);

    if (!isStructuredReady) {
        console.warn('[trajectory-eval] skip persisting incomplete result-evaluation payload to execution');
        return;
    }

    const data = {
        isAnswerCorrect: judgment.isCorrect,
        answerScore: judgment.score,
        judgmentReason: judgment.reason,
    };

    if (execution?.id) {
        await prisma.execution.update({
            where: { id: execution.id },
            data,
        });
        return;
    }

    if (resolvedTaskId) {
        await prisma.execution.updateMany({
            where: { taskId: resolvedTaskId },
            data,
        });
    }
}

function getPrimaryExecutionSkillTargets(
    execution: ExecutionLike | null | undefined,
    interactions?: unknown,
): SkillTarget[] {
    const rootSkill = getRootSkillFromInteractions(interactions);
    const skill = rootSkill?.name || execution?.skill;
    const normalized = String(skill || '').trim();
    if (!normalized) return [];
    return [{
        skill: normalized,
        version: rootSkill?.version ?? normalizeOptionalVersion(execution?.skillVersion),
    }];
}

async function extractSkillKeyActionsFromTargets(targets: SkillTarget[], user?: string | null): Promise<ExtractedKeyAction[]> {
    const allActions: { name: string; actions: ExtractedKeyAction[] }[] = [];

    for (const target of targets) {
        const skillRecord = await db.findSkill(target.skill, user || null);
        if (!skillRecord?.id) continue;

        const fullSkill = await db.findSkillById(skillRecord.id);
        const resolvedVersion = target.version
            ?? fullSkill?.activeVersion
            ?? fullSkill?.versions?.[0]?.version
            ?? null;
        if (resolvedVersion == null) continue;

        const parsedFlow = await db.findParsedFlow(skillRecord.id, resolvedVersion, user || null);
        if (!parsedFlow?.flowJson) continue;

        const flow: ParsedFlowResult = JSON.parse(parsedFlow.flowJson);
        const actions = extractKeyActionsFromFlow(flow).map(action => ({
            ...action,
            skillSource: action.skillSource || target.skill,
        }));
        if (actions.length > 0) {
            allActions.push({ name: target.skill, actions });
        }
    }

    if (allActions.length === 0) return [];
    return allActions.length === 1
        ? allActions[0].actions
        : mergeKeyActionsFromMultipleSkills(allActions);
}

function formatReferenceKeyActions(actions: ExtractedKeyAction[]): string {
    if (actions.length === 0) return '';
    return actions.map((action, index) => {
        const tags = [
            action.skillSource ? `skill=${action.skillSource}` : '',
            action.controlFlowType !== 'required' ? `type=${action.controlFlowType}` : '',
            action.branchLabel ? `branch=${action.branchLabel}` : '',
            action.loopCondition ? `loop=${action.loopCondition}` : '',
        ].filter(Boolean).join(', ');
        return `${index + 1}. ${action.content}${tags ? ` [${tags}]` : ''}`;
    }).join('\n');
}

function formatActualExtractedSteps(steps: ExtractedTraceStep[]): string {
    if (steps.length === 0) return '';
    return steps.map((step, index) => {
        const desc = normalizeMatchText(step.description || '');
        const range = step.dialogStartIndex != null && step.dialogEndIndex != null
            ? ` [dialog=${step.dialogStartIndex}-${step.dialogEndIndex}]`
            : '';
        return `${index + 1}. ${step.name || desc || '未命名步骤'}${step.type ? ` [${step.type}]` : ''}${range}${desc && desc !== step.name ? ` - ${desc}` : ''}`;
    }).join('\n');
}

async function buildSkillKeyActionComparison(
    execution: ExecutionLike | null | undefined,
    resolvedTaskId: string | null | undefined,
    user?: string | null,
    interactions?: unknown,
): Promise<SkillKeyActionComparisonResult> {
    const skillTargets = getPrimaryExecutionSkillTargets(execution, interactions);
    if (skillTargets.length === 0 || !resolvedTaskId) return { status: 'no-skill-targets' };

    const missingSkills: string[] = [];
    const missingParsedFlowSkills: string[] = [];
    for (const target of skillTargets) {
        const skillRecord = await db.findSkill(target.skill, user || null);
        if (!skillRecord?.id) {
            missingSkills.push(target.skill);
            continue;
        }

        const fullSkill = await db.findSkillById(skillRecord.id);
        const resolvedVersion = target.version
            ?? fullSkill?.activeVersion
            ?? fullSkill?.versions?.[0]?.version
            ?? null;
        if (resolvedVersion == null) {
            missingParsedFlowSkills.push(target.skill);
            continue;
        }

        const parsedFlow = await db.findParsedFlow(skillRecord.id, resolvedVersion, user || null);
        if (!parsedFlow?.flowJson) {
            missingParsedFlowSkills.push(target.skill);
        }
    }

    if (missingSkills.length > 0) {
        return { status: 'missing-skill', missingSkills };
    }
    if (missingParsedFlowSkills.length > 0) {
        return { status: 'missing-parsed-flow', missingSkills: missingParsedFlowSkills };
    }

    const executionMatch = await db.findExecutionMatch(resolvedTaskId);
    const extractedSteps = executionMatch?.extractedSteps
        ? JSON.parse(executionMatch.extractedSteps)
        : [];
    let normalizedSteps = Array.isArray(extractedSteps) ? extractedSteps as ExtractedTraceStep[] : [];
    if (normalizedSteps.length === 0) {
        const dynamicResult = await analyzeDynamicOnly(resolvedTaskId, user);
        if (!dynamicResult.success) return { status: 'dynamic-analysis-failed' };
        const refreshedExecutionMatch = await db.findExecutionMatch(resolvedTaskId);
        const refreshedExtractedSteps = refreshedExecutionMatch?.extractedSteps
            ? JSON.parse(refreshedExecutionMatch.extractedSteps)
            : [];
        normalizedSteps = Array.isArray(refreshedExtractedSteps) ? refreshedExtractedSteps as ExtractedTraceStep[] : [];
    }
    if (normalizedSteps.length === 0) return { status: 'no-extracted-steps' };

    const keyActions = await extractSkillKeyActionsFromTargets(skillTargets, user);
    if (keyActions.length === 0) return { status: 'no-key-actions' };

    return {
        status: 'ok',
        referenceKeyActionsText: formatReferenceKeyActions(keyActions),
        actualExtractedStepsText: formatActualExtractedSteps(normalizedSteps),
    };
}

async function findMatchingDatasetCaseForTrace(
    user: string,
    traceQuery: string,
    options: { requireExpectedOutput?: boolean; includeAllDatasetKinds?: boolean } = {},
): Promise<MatchedDatasetCase> {
    const normalizedTraceInput = normalizeMatchText(traceQuery);
    if (!normalizedTraceInput) {
        throw new StagedEvaluationError(
            'no-evaluable-case',
            `${NO_EVALUABLE_CASE_PREFIX} trace 没有实际输入，无法匹配评估数据集 case`,
        );
    }

    const requireExpectedOutput = options.requireExpectedOutput === true;
    const includeAllDatasetKinds = options.includeAllDatasetKinds === true;
    const datasets = (await readAllAgentDatasets())
        .filter(dataset => dataset.user === user)
        .filter(dataset => includeAllDatasetKinds || requireExpectedOutput || dataset.datasetKind === 'trajectory');

    if (datasets.length === 0) {
        throw new StagedEvaluationError(
            'no-evaluable-case',
            `${NO_EVALUABLE_CASE_PREFIX} ${includeAllDatasetKinds ? '未找到可用于评测的数据集' : requireExpectedOutput ? '未找到可用于结果评测的数据集' : '未找到轨迹评测数据集'}`,
        );
    }

    for (const dataset of datasets) {
        const found = dataset.cases.find(c =>
            normalizeMatchText(c.input) === normalizedTraceInput
            && (!requireExpectedOutput || Boolean(normalizeMatchText(c.expectedOutput)))
        );
        if (found) return { dataset, caseEntry: found };
    }

    const semanticCandidates: { id: string; input: string }[] = [];
    const semanticCaseMap = new Map<string, MatchedDatasetCase>();
    for (const dataset of datasets) {
        for (const caseEntry of dataset.cases) {
            if (requireExpectedOutput && !normalizeMatchText(caseEntry.expectedOutput)) continue;
            const id = `${dataset.id}::${caseEntry.id}`;
            semanticCandidates.push({ id, input: caseEntry.input });
            semanticCaseMap.set(id, { dataset, caseEntry });
        }
    }

    const semantic = await findBestSemanticCaseMatch(
        semanticCandidates,
        traceQuery,
        { user, requireModelAvailable: true },
    );
    if (semantic.error) {
        throw new StagedEvaluationError(
            'semantic-match-llm',
            `${NO_EVALUABLE_CASE_PREFIX} 语义匹配调用评测模型失败：${semantic.error}`,
        );
    }
    if (semantic.caseId) {
        const found = semanticCaseMap.get(semantic.caseId);
        if (found) return found;
    }

    throw new StagedEvaluationError(
        'no-evaluable-case',
        `${NO_EVALUABLE_CASE_PREFIX} trace 实际输入未匹配到${includeAllDatasetKinds ? '评测数据集中的' : requireExpectedOutput ? '带预期结果的' : '轨迹评测数据集中的'} case 输入`,
    );
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const user = String(body.user || '').trim();
        const appendRunId = String(body.evaluatorRunId || body.runId || '').trim();
        const requestedEvaluators = Array.isArray(body.evaluators) && body.evaluators.length > 0
            ? body.evaluators
            : body.evaluator;
        const selectedEvaluators = normalizeSelectedEvaluators(
            requestedEvaluators,
        );
        const requestedAutoWatch = body.autoWatch === true;
        const requestedWatchedAgent = String(body.watchedAgent || body.agent || '').trim();

        if (!user) return NextResponse.json({ error: 'user is required' }, { status: 400 });

        // 自建评估器需要真存在于该用户的 CustomEvaluatorList 才能放行；找不到的 ID 直接拒绝，
        // 避免后台 runner 反复抛"未找到自建评估器"。
        const customIdsRequested = selectedEvaluators.filter(isCustomEvaluatorId);
        const validCustomIds = new Set<string>();
        const customNameMap = new Map<string, string>();
        if (customIdsRequested.length > 0) {
            const knownIds = await listCustomEvaluatorIds(user);
            const missing: string[] = [];
            for (const id of customIdsRequested) {
                if (knownIds.has(id)) {
                    validCustomIds.add(id);
                } else {
                    missing.push(id);
                }
            }
            if (missing.length > 0) {
                return NextResponse.json(
                    { error: `unknown custom evaluators: ${missing.join(', ')}` },
                    { status: 400 },
                );
            }
            for (const id of validCustomIds) {
                const bundle = await loadCustomEvaluator(user, id);
                if (bundle) customNameMap.set(id, bundle.name);
            }
        }

        const finalEvaluators = selectedEvaluators.filter(id =>
            isCustomEvaluatorId(id) ? validCustomIds.has(id) : SUPPORTED_TRAJECTORY_EVALUATORS.has(id),
        );

        let evaluatorMeta = buildSelectedEvaluatorMeta(
            finalEvaluators.length > 0 ? finalEvaluators : [TRACE_EVALUATOR_ID],
            {
                autoWatch: requestedAutoWatch,
                watchedAgent: requestedWatchedAgent,
                customNameResolver: id => customNameMap.get(id),
            },
        );

        if (requestedEvaluators && finalEvaluators.length === 0) {
            return NextResponse.json(
                { error: 'unsupported evaluators' },
                { status: 400 },
            );
        }
        if (evaluatorMeta.selectedEvaluators.length === 0) {
            return NextResponse.json(
                { error: 'unsupported evaluators' },
                { status: 400 },
            );
        }

        // 支持两种模式：
        // 1. taskIds 模式：传 taskIds；后台从所有 trajectory 数据集匹配 case 输入
        // 2. 数据集配对模式（兼容旧版）：传 datasetId + pairs，后端校验输入是否能匹配 case
        const taskIds: string[] = Array.isArray(body.taskIds)
            ? body.taskIds.map((t: unknown) => String(t).trim()).filter(Boolean)
            : [];
        let datasetId = String(body.datasetId || '').trim();
        const pairs = Array.isArray(body.pairs) ? (body.pairs as RunPair[]) : [];
        let taskMeta = normalizeTrajectoryTaskMeta({
            title: body.taskTitle,
            description: body.taskDescription,
        });

        let existingRunTaskIds = new Set<string>();
        if (appendRunId) {
            const existingRows = await prisma.trajectoryEvalResult.findMany({
                where: { user, evaluatorRunId: appendRunId },
                orderBy: { createdAt: 'asc' },
            });
            if (existingRows.length === 0) {
                return NextResponse.json({ error: 'evaluatorRunId not found' }, { status: 404 });
            }
            const first = existingRows[0];
            const latestExplicitMeta = [...existingRows]
                .reverse()
                .map(row => readSelectedEvaluatorMetaStrict(row.rawAnalysisJson))
                .find((meta): meta is SelectedEvaluatorMeta => Boolean(meta));
            evaluatorMeta = finalEvaluators.length > 0
                ? buildSelectedEvaluatorMeta(finalEvaluators, {
                    autoWatch: requestedAutoWatch,
                    watchedAgent: requestedWatchedAgent,
                    customNameResolver: id => customNameMap.get(id),
                })
                : latestExplicitMeta || readSelectedEvaluatorMeta(first.rawAnalysisJson);
            taskMeta = extractTrajectoryTaskMeta(first.rawAnalysisJson, first.createdAt);
            datasetId = datasetId || first.datasetId || '';
            existingRunTaskIds = new Set(
                existingRows
                    .map(row => row.taskId || row.executionId || '')
                    .filter(Boolean),
            );
        }

        const evaluatorRunId = appendRunId || generateRunId();
        const created: { id: string; caseId: string; executionId?: string; taskId?: string }[] = [];
        const skipped: { caseId: string; reason: string }[] = [];

        if (taskIds.length > 0) {
            // 每个 taskId 创建一条评测记录；datasetId/caseId 在后台根据 Agent + trace 输入自动解析
            for (const taskId of taskIds) {
                if (existingRunTaskIds.has(taskId)) {
                    skipped.push({ caseId: '', reason: `taskId ${taskId} already exists in this run` });
                    continue;
                }
                const row = await prisma.trajectoryEvalResult.create({
                    data: {
                        user,
                        evaluatorRunId,
                        datasetId: '',
                        caseId: '',
                        executionId: null,
                        taskId,
                        status: 'pending',
                        rawAnalysisJson: JSON.stringify({ ...evaluatorMeta, taskMeta }),
                    },
                });
                created.push({ id: row.id, caseId: '', taskId });
            }
        } else if (requestedAutoWatch && !appendRunId) {
            if (datasetId) {
                const dataset = await findAgentDataset(user, datasetId);
                if (!dataset) {
                    return NextResponse.json({ error: 'dataset not found' }, { status: 404 });
                }
                if (dataset.datasetKind !== 'trajectory') {
                    return NextResponse.json(
                        { error: `dataset kind must be 'trajectory', got '${dataset.datasetKind}'` },
                        { status: 400 },
                    );
                }
            }
            const row = await prisma.trajectoryEvalResult.create({
                data: {
                    user,
                    evaluatorRunId,
                    datasetId,
                    caseId: '',
                    executionId: null,
                    taskId: null,
                    status: 'pending',
                    rawAnalysisJson: JSON.stringify({ ...evaluatorMeta, taskMeta, watchPlaceholder: true }),
                },
            });
            created.push({ id: row.id, caseId: '' });
        } else if (datasetId && pairs.length > 0) {
            // 数据集配对模式
            const dataset = await findAgentDataset(user, datasetId);
            if (!dataset) {
                return NextResponse.json({ error: 'dataset not found' }, { status: 404 });
            }
            const caseMap = new Map(dataset.cases.map(c => [c.id, c]));
            for (const pair of pairs) {
                const caseId = String(pair.caseId || '').trim();
                const executionId = pair.executionId ? String(pair.executionId).trim() : undefined;
                const taskId = pair.taskId ? String(pair.taskId).trim() : undefined;
                const duplicateKey = taskId || executionId || '';
                if (duplicateKey && existingRunTaskIds.has(duplicateKey)) {
                    skipped.push({ caseId, reason: `${duplicateKey} already exists in this run` });
                    continue;
                }
                const caseEntry = caseMap.get(caseId);
                if (!caseEntry) { skipped.push({ caseId, reason: 'case not found in dataset' }); continue; }
                if (!executionId && !taskId) { skipped.push({ caseId, reason: 'executionId or taskId is required' }); continue; }
                const row = await prisma.trajectoryEvalResult.create({
                    data: {
                        user,
                        evaluatorRunId,
                        datasetId,
                        caseId,
                        executionId: executionId || null,
                        taskId: taskId || null,
                        status: 'pending',
                        rawAnalysisJson: JSON.stringify({ ...evaluatorMeta, taskMeta }),
                    },
                });
                created.push({ id: row.id, caseId, executionId, taskId });
            }
        } else {
            return NextResponse.json({ error: 'provide taskIds or datasetId + pairs' }, { status: 400 });
        }

        if (created.length === 0) {
            return NextResponse.json({ error: 'no valid tasks to run', skipped }, { status: 400 });
        }

        const runnableIds = created
            .filter(c => c.taskId || c.executionId)
            .map(c => c.id);
        if (runnableIds.length > 0) {
            void runEvaluations(user, evaluatorRunId, runnableIds).catch(err => {
                console.error('[trajectory-eval] background run crashed:', err);
            });
        }

        return NextResponse.json({
            success: true,
            evaluatorRunId,
            evaluators: evaluatorMeta.selectedEvaluators,
            evaluatorNames: evaluatorMeta.selectedEvaluatorNames,
            datasetId,
            created,
            skipped,
        });
    } catch (error: unknown) {
        console.error('trajectory/run POST error:', error);
        const message = error instanceof Error ? error.message : 'failed to start trajectory evaluation';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

export async function PATCH(request: Request) {
    try {
        const body = await request.json();
        const user = String(body.user || '').trim();
        const evaluatorRunId = String(body.evaluatorRunId || body.runId || '').trim();
        const autoWatch = body.autoWatch === true;

        if (!user) return NextResponse.json({ error: 'user is required' }, { status: 400 });
        if (!evaluatorRunId) return NextResponse.json({ error: 'evaluatorRunId is required' }, { status: 400 });

        const rows = await prisma.trajectoryEvalResult.findMany({
            where: { user, evaluatorRunId },
            orderBy: { createdAt: 'asc' },
        });
        if (rows.length === 0) {
            return NextResponse.json({ error: 'evaluatorRunId not found' }, { status: 404 });
        }

        const baseMeta = readSelectedEvaluatorMeta(rows[0].rawAnalysisJson);
        const nextMeta = buildSelectedEvaluatorMeta(baseMeta.selectedEvaluators, {
            autoWatch,
            watchedAgent: baseMeta.watchedAgent,
        });

        await prisma.$transaction(
            rows.map(row => prisma.trajectoryEvalResult.update({
                where: { id: row.id },
                data: {
                    rawAnalysisJson: mergeRawAnalysisMeta(row.rawAnalysisJson, nextMeta),
                },
            })),
        );

        return NextResponse.json({
            success: true,
            evaluatorRunId,
            autoWatch,
            watchedAgent: nextMeta.watchedAgent || '',
        });
    } catch (error: unknown) {
        console.error('trajectory/run PATCH error:', error);
        const message = error instanceof Error ? error.message : 'failed to update auto watch state';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

/** 单条 trace 评测的并发上限 */
const RUN_CONCURRENCY = 3;
/** 单条 trace 评测的硬超时（ms）。超过则自动标 failed。 */
const PER_RESULT_TIMEOUT_MS = 10 * 60 * 1000;

class StagedEvaluationError extends Error {
    constructor(public stage: string, message: string, public cause?: unknown) {
        super(`[${stage}] ${message}`);
        this.name = 'StagedEvaluationError';
    }
}

/** 包装 evaluateTrajectory + 加超时；分阶段抛错便于 UI 显示根因 */
async function runOneEvaluation(user: string, id: string): Promise<void> {
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
    const shouldRunTraceEvaluation = evaluatorMeta.selectedEvaluators.includes(TRACE_EVALUATOR_ID);
    const shouldRunResultEvaluation = evaluatorMeta.selectedEvaluators.includes(TASK_COMPLETION_EVALUATOR_ID);
    const customEvaluatorIds = evaluatorMeta.selectedEvaluators.filter(isCustomEvaluatorId);
    const hasCustomEvaluators = customEvaluatorIds.length > 0;
    let resultEvaluationRawAnalysis: Record<string, unknown> | null = null;
    let resultEvaluationError: string | null = null;
    let resultArtifactExtractionRawAnalysis: Record<string, unknown> | null = null;
    let resultActualOutput = '';
    let customEvaluationsRawAnalysis: Record<string, unknown> | null = null;
    const customEvaluatorScores: number[] = [];
    const customEvaluatorBundles = hasCustomEvaluators
        ? await Promise.all(
            customEvaluatorIds.map(async evaluatorId => ({
                evaluatorId,
                bundle: await loadCustomEvaluator(user, evaluatorId),
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
    const needsCustomReferenceOutput = requestedCustomVars.has('reference_output');
    const needsCustomOutput = requestedCustomVars.has('output');
    const needsCustomTrajectory = requestedCustomVars.has('trajectory');

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
    let caseEntry: { id?: string; input: string; expectedOutput: string; trajectory: string; evaluationFocus: string } | null = null;
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
            const dataset = await findAgentDataset(user, row.datasetId);
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
                requireExpectedOutput: shouldRunResultEvaluation,
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
                caseEntry = { input: traceQuery, expectedOutput: '', trajectory: '', evaluationFocus: '' };
                matchKind = 'fallback';
            } else if (e instanceof StagedEvaluationError) {
                throw e;
            } else {
                throw new StagedEvaluationError('dataset-auto-match', `自动匹配数据集失败: ${(e as Error).message}`, e);
            }
        }
    } else if (hasCustomEvaluators) {
        // 自建评估器不强求数据集匹配。{{input}} 来自本次任务输入；
        // 只有 prompt 实际用了 {{reference_output}} 时，才匹配数据集取预期输出。
        if (needsCustomReferenceOutput) {
            try {
                const matched = await findMatchingDatasetCaseForTrace(user, traceQuery, {
                    requireExpectedOutput: true,
                    includeAllDatasetKinds: true,
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
                if (e instanceof StagedEvaluationError) throw e;
                throw new StagedEvaluationError(
                    'no-evaluable-case',
                    `${NO_EVALUABLE_CASE_PREFIX} 自定义评估器需要 reference_output，但 trace 输入未匹配到带预期结果的数据集 case`,
                    e,
                );
            }
        } else {
            caseEntry = { input: traceQuery, expectedOutput: '', trajectory: '', evaluationFocus: '' };
        }
    } else {
        // 无数据集：用空参考，依赖 skill key actions 和纯轨迹质量评估
        caseEntry = { input: traceQuery, expectedOutput: '', trajectory: '', evaluationFocus: '' };
    }

    if (shouldRunResultEvaluation && !normalizeMatchText(caseEntry.expectedOutput)) {
        throw new StagedEvaluationError(
            'no-evaluable-case',
            `${NO_EVALUABLE_CASE_PREFIX} 已匹配到 case，但该 case 缺少预期结果 expectedOutput，无法执行结果评测`,
        );
    }
    if (hasCustomEvaluators && needsCustomReferenceOutput && !normalizeMatchText(caseEntry.expectedOutput)) {
        throw new StagedEvaluationError(
            'no-evaluable-case',
            `${NO_EVALUABLE_CASE_PREFIX} 自定义评估器需要 reference_output，但未找到可用的预期结果 expectedOutput`,
        );
    }

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
    let evaluationFocus = caseEntry.evaluationFocus;
    const referenceTrajectory = caseEntry.trajectory;
    const hasReferenceTrajectory = !!normalizeMatchText(caseEntry.trajectory);
    const keyActionComparison = await buildSkillKeyActionComparison(
        execution,
        resolvedTaskId,
        user,
        interactions,
    );
    const skillAttributionStatus = buildSkillAttributionStatus(keyActionComparison);

    // missing-skill / missing-parsed-flow 是真的"用户配置不完整"的错——如果连
    // reference trajectory 都没有，评估就跑不动，必须抛错让用户去补 skill 解析。
    // 但如果已经有 reference trajectory，evaluator 还能在 trajectory 模式下产分，
    // 没必要因 skill 归因失败而整条评测作废——把降级状态写进 rawAnalysisJson 即可。
    if (!hasReferenceTrajectory) {
        if (keyActionComparison.status === 'missing-skill') {
            throw new StagedEvaluationError(
                'no-evaluable-case',
                `${NO_EVALUABLE_CASE_PREFIX} trace 使用了 skill，但在 Skills 管理中未找到同名 skill：${keyActionComparison.missingSkills.join('、')}`,
            );
        }
        if (keyActionComparison.status === 'missing-parsed-flow') {
            throw new StagedEvaluationError(
                'no-evaluable-case',
                `${NO_EVALUABLE_CASE_PREFIX} trace 使用的 skill 缺少可用于提取关键步骤的已解析流程：${keyActionComparison.missingSkills.join('、')}`,
            );
        }
    }
    if (keyActionComparison.status === 'ok') {
        comparisonMode = 'skill_key_actions';
        referenceKeyActionsText = keyActionComparison.referenceKeyActionsText;
        actualExtractedStepsText = keyActionComparison.actualExtractedStepsText;
        evaluationFocus = [
            normalizeMatchText(caseEntry.evaluationFocus),
            '优先比较技能自动提取的参考关键步骤与 trace 自动提取的实际关键步骤，再结合实际 trace 判断工具选择与根因。',
        ].filter(Boolean).join(' ');
        // 不再清空 referenceTrajectory——同时有 case trajectory 和 skill key actions
        // 时，evaluator 可以兼用两者（COORDINATOR_SYSTEM_PROMPT 在 skill_key_actions
        // 模式下也会引用 actual_trace + reference）。
    }

    // skillAttribution + comparisonMode 写进 baseRawAnalysisMeta 后所有 evaluator
    // 写盘的 rawAnalysisJson 都会带上，前端按 state 显示徽章。
    const baseRawAnalysisMeta = {
        ...evaluatorMeta,
        taskMeta,
        caseSnapshot,
        skillAttribution: skillAttributionStatus,
        comparisonMode,
    };

    if (shouldRunTraceEvaluation && interactions.length === 0) {
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
                    await prisma.trajectoryEvalResult.update({
                        where: { id },
                        data: {
                            rawAnalysisJson: JSON.stringify({
                                ...baseRawAnalysisMeta,
                                resultArtifactExtraction: resultArtifactExtractionRawAnalysis,
                                resultActualOutput: '',
                                resultEvaluation: null,
                                resultEvaluationError,
                            }),
                        },
                    });
                } else {
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
                    const resultJudgment = await evaluateTaskCompletionAgainstExpected(
                        caseEntry.input,
                        caseEntry.expectedOutput,
                        resultActualOutput,
                        user,
                        evalSkillName,
                        evalSkillVersion,
                    );
                    resultEvaluationRawAnalysis = {
                        ...(resultJudgment.rawAnalysis || {}),
                        result_artifact_extraction: {
                            status: artifactExtraction.rawAnalysis?.fallback ? 'fallback_final_result' : artifactExtraction.status,
                            confidence: artifactExtraction.confidence,
                            reason: artifactExtraction.reason,
                            source_refs: artifactExtraction.sourceRefs,
                            fallback_source: artifactExtraction.rawAnalysis?.fallback ? 'execution.finalResult' : null,
                        },
                    };
                    await persistResultJudgment(execution, resolvedTaskId, resultJudgment);
                    await prisma.trajectoryEvalResult.update({
                        where: { id },
                        data: {
                            rawAnalysisJson: JSON.stringify({
                                ...baseRawAnalysisMeta,
                                resultArtifactExtraction: resultArtifactExtractionRawAnalysis,
                                resultActualOutput,
                                resultEvaluation: resultEvaluationRawAnalysis,
                                resultEvaluationError: null,
                            }),
                        },
                    });
                }
            })(), PER_RESULT_TIMEOUT_MS, new StagedEvaluationError(
                'result-timeout',
                `结果评测超过 ${PER_RESULT_TIMEOUT_MS / 1000}s 未完成`,
            ));
        } catch (e) {
            console.warn('[trajectory-eval] result-based evaluation failed:', e);
            resultEvaluationError = `结果评测失败：${(e as Error).message || String(e)}`;
        }
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
            if (interactions.length === 0) return '';
            try {
                return formatTraceForLLM(summarizeTrace(interactions, { maxSteps: 50, maxTextLen: 400 }));
            } catch {
                return '';
            }
        })() : '';

        const customResults: Array<Awaited<ReturnType<typeof runCustomLlmEvaluator>>> = await Promise.all(
            customEvaluatorIds.map(evaluatorId =>
                runCustomLlmEvaluator(user, evaluatorId, {
                    caseInput: taskInputForEvaluation,
                    expectedOutput: needsCustomReferenceOutput ? caseEntry!.expectedOutput : '',
                    actualOutput: actualOutputForCustom,
                    traceText: traceTextForCustom,
                }, evalSkillName, evalSkillVersion).catch(e => ({
                    evaluatorId,
                    evaluatorName: evaluatorId,
                    score: null as number | null,
                    reason: '',
                    rawResponse: '',
                    model: '',
                    durationMs: 0,
                    error: `运行异常：${(e as Error)?.message || String(e)}`,
                })),
            ),
        );

        const byId: Record<string, unknown> = {};
        for (const r of customResults) {
            byId[r.evaluatorId] = {
                evaluatorId: r.evaluatorId,
                evaluatorName: r.evaluatorName,
                score: r.score,
                reason: r.reason,
                model: r.model,
                durationMs: r.durationMs,
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
        await prisma.trajectoryEvalResult.update({
            where: { id },
            data: {
                status: 'done',
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
                    customEvaluations: customEvaluationsRawAnalysis,
                    customVariableNeeds: Array.from(requestedCustomVars),
                    customEvaluationScore: customAvg,
                }),
                errorMessage: null,
            },
        });
        await derivePointsAfterDone(user, id, execution);
        return;
    }

    const input: TrajectoryEvalInput = {
        caseId: caseEntry.id || row.caseId || '',
        caseInput: caseEntry.input,
        referenceOutput: caseEntry.expectedOutput,
        referenceTrajectory,
        referenceKeyActionsText,
        actualExtractedStepsText,
        comparisonMode,
        evaluationFocus,
        actualInteractions: interactions,
        taskId: resolvedTaskId || undefined,
        executionId: row.executionId || execution?.id || undefined,
    };

    // ---- 2. 真跑 evaluator (opencode) + 超时 ----
    let out: Awaited<ReturnType<typeof evaluateTrajectoryViaOpencode>>;
    try {
        out = await Promise.race([
            evaluateTrajectoryViaOpencode(input, user, evalSkillName, evalSkillVersion),
            new Promise<never>((_, reject) =>
                setTimeout(
                    () => reject(new StagedEvaluationError('timeout', `单条评测超过 ${PER_RESULT_TIMEOUT_MS / 1000}s 未完成`)),
                    PER_RESULT_TIMEOUT_MS,
                ),
            ),
        ]);
    } catch (e) {
        if (e instanceof StagedEvaluationError) throw e;
        if (e instanceof TrajectoryEvalConfigError) {
            throw new StagedEvaluationError('config', e.message, e);
        }
        throw new StagedEvaluationError('llm-or-agent', (e as Error).message || String(e), e);
    }

    // ---- 3. 落库 ----
    try {
        const mergedRawAnalysis = {
            ...(out.rawAnalysis && typeof out.rawAnalysis === 'object' ? out.rawAnalysis : {}),
            ...baseRawAnalysisMeta,
            resultArtifactExtraction: resultArtifactExtractionRawAnalysis,
            resultActualOutput,
            resultEvaluation: resultEvaluationRawAnalysis,
            resultEvaluationError,
            customEvaluations: customEvaluationsRawAnalysis,
            customVariableNeeds: Array.from(requestedCustomVars),
            customEvaluationScore: customEvaluatorScores.length > 0
                ? customEvaluatorScores.reduce((a, b) => a + b, 0) / customEvaluatorScores.length
                : null,
        };
        await prisma.trajectoryEvalResult.update({
            where: { id },
            data: {
                status: 'done',
                trajectoryScore: out.trajectoryScore,
                dimensionScoresJson: JSON.stringify(out.dimensionScores),
                deviationStepsJson: JSON.stringify(out.deviationSteps),
                rootCauseStep: out.rootCauseStep || null,
                reasonText: out.reasonText || null,
                rawAnalysisJson: JSON.stringify(mergedRawAnalysis),
                errorMessage: null,
            },
        });
    } catch (e) {
        throw new StagedEvaluationError('persist', `写入评测结果失败: ${(e as Error).message}`, e);
    }

    await derivePointsAfterDone(user, id, execution);
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

/**
 * 评测落库 status='done' 后，从结果推导 SkillOptimizationPoint 落库给 skill-opt 用。
 * 失败不抛出——主流程已经 done 了，把这步当 best-effort。
 */
async function derivePointsAfterDone(
    user: string,
    rowId: string,
    execution: { invokedSkills?: string | null; skill?: string | null; skills?: string | null; skillVersion?: number | null } | null,
): Promise<void> {
    try {
        const row = await prisma.trajectoryEvalResult.findUnique({
            where: { id: rowId },
            select: {
                id: true,
                taskId: true,
                evaluatorRunId: true,
                deviationStepsJson: true,
                rootCauseStep: true,
                reasonText: true,
                rawAnalysisJson: true,
            },
        });
        if (!row) return;
        const skills = getPrimaryExecutionSkillTargets(execution).map(t => ({ name: t.skill, version: t.version }));
        if (skills.length === 0) return;
        const written = await deriveAndPersistOptPoints({
            user,
            taskId: row.taskId,
            runId: row.evaluatorRunId,
            trajectoryRow: row,
            skills,
        });
        if (written > 0) {
            console.log(`[trajectory-eval]   • derived ${written} skill optimization point(s) for row=${rowId}`);
        }
    } catch (e) {
        console.warn('[trajectory-eval] derive opt points failed (non-fatal):', (e as Error).message);
    }
}

/** 并发执行（concurrency=RUN_CONCURRENCY），失败的行单独标 failed，不影响其他 */
export async function runEvaluations(user: string, evaluatorRunId: string, resultIds: string[]) {
    const startedAt = Date.now();
    console.log(`[trajectory-eval] run ${evaluatorRunId} started: ${resultIds.length} traces, concurrency=${RUN_CONCURRENCY}`);

    const queue = [...resultIds];
    let activeCount = 0;
    let doneCount = 0;
    let failCount = 0;

    await new Promise<void>(resolveAll => {
        const tryStartNext = () => {
            while (activeCount < RUN_CONCURRENCY && queue.length > 0) {
                const id = queue.shift()!;
                activeCount++;
                runOneEvaluation(user, id)
                    .then(() => {
                        doneCount++;
                        console.log(`[trajectory-eval]   ✓ ${id} done (${doneCount}+${failCount}/${resultIds.length})`);
                    })
                    .catch(async err => {
                        failCount++;
                        const stage = err instanceof StagedEvaluationError ? err.stage : 'unknown';
                        const msg = err?.message || 'unknown error';
                        console.error(`[trajectory-eval]   ✗ ${id} failed [${stage}]: ${msg}`);
                        await prisma.trajectoryEvalResult
                            .update({
                                where: { id },
                                data: { status: 'failed', errorMessage: msg },
                            })
                            .catch(e2 => console.error(`[trajectory-eval] failed to mark ${id} as failed: ${e2.message}`));
                    })
                    .finally(() => {
                        activeCount--;
                        if (queue.length === 0 && activeCount === 0) {
                            resolveAll();
                        } else {
                            tryStartNext();
                        }
                    });
            }
        };
        tryStartNext();
    });

    // 兜底：只恢复本轮队列里确实残留的行，避免误伤同一 run 中刚追加/仍在运行的评测。
    try {
        const stuck = await prisma.trajectoryEvalResult.updateMany({
            where: {
                id: { in: resultIds },
                evaluatorRunId,
                updatedAt: { lt: new Date(startedAt) },
                status: { in: ['pending', 'running'] },
            },
            data: {
                status: 'failed',
                errorMessage: '[recover] 进程异常或评测器未返回，已自动标 failed',
            },
        });
        if (stuck.count > 0) {
            console.warn(`[trajectory-eval] run ${evaluatorRunId} recovered ${stuck.count} stuck rows.`);
            failCount += stuck.count;
        }
    } catch (e) {
        console.error(`[trajectory-eval] failed to recover stuck rows: ${(e as Error).message}`);
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[trajectory-eval] run ${evaluatorRunId} finished: ${doneCount} done, ${failCount} failed, ${elapsed}s`);
}
