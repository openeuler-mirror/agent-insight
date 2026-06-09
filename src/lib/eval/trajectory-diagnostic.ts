export type TrajectoryEvalStatus = 'pending' | 'running' | 'done' | 'failed';

export type EvaluationDiagnosticCategory =
    | 'trace'
    | 'dataset'
    | 'case'
    | 'skill'
    | 'model'
    | 'evaluator'
    | 'system';

export interface EvaluationDiagnostic {
    errorCode: string;
    errorCategory: EvaluationDiagnosticCategory;
    shortStatus: string;
    userMessage: string;
    reason: string;
    nextAction: string;
    retryable: boolean;
    stage: string;
    details?: string;
    internal?: {
        stage?: string;
        reason?: string;
        confidence?: number;
    };
}

export interface TrajectoryDiagnosticResultLike {
    status: TrajectoryEvalStatus;
    errorMessage?: string | null;
    resultEvaluationError?: string | null;
    trajectoryScore?: number | null;
    resultEvaluationScore?: number | null;
    customEvaluationScore?: number | null;
    customEvaluations?: unknown;
    selectedEvaluators?: string[];
    diagnostic?: unknown;
    rawAnalysis?: unknown;
}

export type TrajectoryStatusTone = 'muted' | 'running' | 'success' | 'warning' | 'danger';
export type TrajectoryDisplayStatus = 'pending' | 'running' | 'done' | 'failed' | 'partial_failed';

const NO_EVALUABLE_CASE_PREFIX = '[no-evaluable-case]';
const TRACE_EVALUATOR_ID = 'preset-agent-trace-quality';
const TASK_COMPLETION_EVALUATOR_ID = 'preset-agent-task-completion';

const CATEGORY_LABEL: Record<EvaluationDiagnosticCategory, string> = {
    trace: 'Trace 数据问题',
    dataset: '评测集配置问题',
    case: 'Case 配置问题',
    skill: 'Skill 归因问题',
    model: '模型调用问题',
    evaluator: '评测器问题',
    system: '系统问题',
};

const DIAGNOSTIC_DEFINITIONS: Record<string, Omit<EvaluationDiagnostic, 'errorCode' | 'details' | 'internal'>> = {
    trace_missing_input: {
        errorCategory: 'trace',
        shortStatus: 'Trace 缺输入',
        userMessage: 'Trace 缺少实际输入，无法匹配评测集 case。',
        reason: '系统没有从本次执行记录中提取到可用于匹配 case 的任务输入。',
        nextAction: '检查 trace 采集是否包含用户任务输入；必要时重新采集或重新执行该任务。',
        retryable: false,
        stage: 'case-match',
    },
    trace_missing_output: {
        errorCategory: 'trace',
        shortStatus: 'Trace 缺输出',
        userMessage: 'Trace 缺少实际输出，无法做任务完成度评测。',
        reason: '本次 trace 没有提取到 Agent 最终输出，也没有可用的 execution.finalResult fallback。',
        nextAction: '检查 Agent 是否产出最终回复；确认 trace 采集包含 assistant final message；必要时重新跑该 case。',
        retryable: false,
        stage: 'result-artifact',
    },
    task_output_extraction_failed: {
        errorCategory: 'trace',
        shortStatus: '任务输出提取失败',
        userMessage: '无法从 trace 中提取任务输出。',
        reason: '任务输出提取流程没有定位到可用于任务完成度评测的最终输出，且没有 fallback 可用。',
        nextAction: '检查 trace 中是否包含最终回复或关键工具输出；必要时重试评测或重新采集 trace。',
        retryable: true,
        stage: 'result-artifact',
    },
    trace_data_empty: {
        errorCategory: 'trace',
        shortStatus: 'Trace 数据为空',
        userMessage: 'Trace 数据为空，无法评测。',
        reason: '系统没有找到可用的 session interactions，也没有足够的 query/finalResult 生成兜底交互。',
        nextAction: '检查 trace 采集、上传或执行记录入库是否完整。',
        retryable: false,
        stage: 'trace-load',
    },
    trace_parse_failed: {
        errorCategory: 'trace',
        shortStatus: 'Trace 解析失败',
        userMessage: 'Trace 数据解析失败，无法评测。',
        reason: 'Session.interactions 不是合法 JSON 或结构不兼容。',
        nextAction: '检查 trace 采集数据格式，必要时重新上传或修复采集链路。',
        retryable: false,
        stage: 'trace-parse',
    },
    case_not_matched: {
        errorCategory: 'case',
        shortStatus: '无匹配 case',
        userMessage: 'Trace 输入没有匹配到可用于评测的 case。',
        reason: '本次任务输入与当前评测集中的 case.input 没有达到可用匹配。',
        nextAction: '补充对应 case，或确认本次 trace 的任务输入与评测集 case.input 是否一致。',
        retryable: false,
        stage: 'case-match',
    },
    case_match_failed: {
        errorCategory: 'case',
        shortStatus: '匹配 case 失败',
        userMessage: '无法根据 trace 输入自动定位可用于评测的 case。',
        reason: 'trace 输入没有精确匹配到评测集 case，后台自动匹配也没有得到可用结果。',
        nextAction: '检查本次 trace 的任务输入是否与评测集 case.input 对齐；必要时补充 case 或重新选择评测集。',
        retryable: true,
        stage: 'case-match',
    },
    dataset_missing: {
        errorCategory: 'dataset',
        shortStatus: '评测集不存在',
        userMessage: '评测集不存在，无法匹配可评测 case。',
        reason: '评测结果关联的数据集已经不存在，或当前用户不可访问。',
        nextAction: '重新选择评测集后再发起评测。',
        retryable: false,
        stage: 'dataset-load',
    },
    dataset_empty: {
        errorCategory: 'dataset',
        shortStatus: '评测集为空',
        userMessage: '评测集没有可评测 case。',
        reason: '当前匹配范围内没有可用于评测的 case。',
        nextAction: '补充评测集 case 后重新评测。',
        retryable: false,
        stage: 'dataset-load',
    },
    case_missing_expected_output: {
        errorCategory: 'case',
        shortStatus: 'Case 缺预期结果',
        userMessage: 'Case 缺少预期结果，无法做任务完成度评测。',
        reason: '已匹配到 case，但 expectedOutput 为空。',
        nextAction: '为该 case 补充 expectedOutput 后重新评测。',
        retryable: false,
        stage: 'case-match',
    },
    custom_reference_missing: {
        errorCategory: 'case',
        shortStatus: '缺 reference_output',
        userMessage: '自定义评估器缺少 reference_output。',
        reason: '自定义评估器 prompt 引用了 reference_output，但没有匹配到带预期结果的 case。',
        nextAction: '补充评测集 expectedOutput，或调整自定义评估器 prompt。',
        retryable: false,
        stage: 'custom-evaluator',
    },
    trace_step_analysis_failed: {
        errorCategory: 'model',
        shortStatus: '步骤抽取失败',
        userMessage: 'Trace 步骤动态分析失败。',
        reason: '系统尝试从 trace 中抽取实际执行步骤时失败，通常与模型配置或调用异常有关。',
        nextAction: '检查评测模型配置和服务状态后重试。',
        retryable: true,
        stage: 'trace-step-analysis',
    },
    trace_no_steps: {
        errorCategory: 'trace',
        shortStatus: 'Trace 无步骤',
        userMessage: 'Trace 无可提取执行步骤，无法做轨迹评测。',
        reason: '系统没有从本次 trace 中提取到可用于轨迹评测的实际执行步骤。',
        nextAction: '检查 trace 质量、采集粒度或执行记录是否完整。',
        retryable: false,
        stage: 'trace-step-analysis',
    },
    evaluator_timeout: {
        errorCategory: 'evaluator',
        shortStatus: '评测超时',
        userMessage: '评测器运行超时。',
        reason: '评测器在限定时间内没有返回结果。',
        nextAction: '重试评测；如果持续出现，请检查模型服务响应时间。',
        retryable: true,
        stage: 'evaluator',
    },
    evaluator_output_invalid: {
        errorCategory: 'evaluator',
        shortStatus: '评测器输出异常',
        userMessage: '评测器未返回有效结构化结果。',
        reason: '评测器输出无法解析为系统需要的 JSON/评分结构。',
        nextAction: '重试评测；如果持续出现，请检查评测器模型输出。',
        retryable: true,
        stage: 'evaluator',
    },
    result_evaluator_failed: {
        errorCategory: 'evaluator',
        shortStatus: '结果评测失败',
        userMessage: '任务完成度评测失败。',
        reason: '任务完成度评测器没有产出可用评分或评测 session。',
        nextAction: '重试评测；如果持续出现，请检查模型配置和评测器日志。',
        retryable: true,
        stage: 'result-evaluator',
    },
    persist_failed: {
        errorCategory: 'system',
        shortStatus: '保存失败',
        userMessage: '评测结果保存失败。',
        reason: '评测已执行，但结果写入数据库时失败。',
        nextAction: '检查数据库或服务状态后重试。',
        retryable: true,
        stage: 'persist',
    },
    evaluator_recovered_failed: {
        errorCategory: 'system',
        shortStatus: '评测进程异常',
        userMessage: '评测进程异常中断。',
        reason: '后台恢复逻辑发现该评测长期停留在 pending/running 状态。',
        nextAction: '重试评测，并查看服务日志确认是否有进程异常。',
        retryable: true,
        stage: 'recover',
    },
};

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function getRawAnalysis(result: TrajectoryDiagnosticResultLike | null | undefined): Record<string, unknown> {
    return asRecord(result?.rawAnalysis);
}

function getSelectedEvaluators(result: TrajectoryDiagnosticResultLike): string[] {
    return Array.isArray(result.selectedEvaluators) ? result.selectedEvaluators : [];
}

function hasSelectedEvaluator(result: TrajectoryDiagnosticResultLike, evaluatorId: string): boolean {
    const selected = getSelectedEvaluators(result);
    if (selected.length === 0) return evaluatorId === TRACE_EVALUATOR_ID;
    return selected.includes(evaluatorId);
}

function hasSelectedCustomEvaluator(result: TrajectoryDiagnosticResultLike): boolean {
    return getSelectedEvaluators(result).some(id => id.startsWith('custom-'));
}

function pickResultEvaluationScore(result: TrajectoryDiagnosticResultLike): number | null {
    if (isFiniteNumber(result.resultEvaluationScore)) return result.resultEvaluationScore;
    const raw = getRawAnalysis(result);
    const resultEvaluation = asRecord(raw.resultEvaluation);
    return isFiniteNumber(resultEvaluation.score) ? resultEvaluation.score : null;
}

function pickCustomEvaluationScore(result: TrajectoryDiagnosticResultLike): number | null {
    if (isFiniteNumber(result.customEvaluationScore)) return result.customEvaluationScore;
    const rawItems = Array.isArray(result.customEvaluations)
        ? result.customEvaluations
        : result.customEvaluations && typeof result.customEvaluations === 'object'
            ? Object.values(result.customEvaluations as Record<string, unknown>)
            : [];
    const scores = rawItems
        .map(item => asRecord(item).score)
        .filter(isFiniteNumber);
    return scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
}

function hasAnySuccessfulSelectedEvaluator(result: TrajectoryDiagnosticResultLike): boolean {
    if (hasSelectedEvaluator(result, TRACE_EVALUATOR_ID) && isFiniteNumber(result.trajectoryScore)) return true;
    if (hasSelectedEvaluator(result, TASK_COMPLETION_EVALUATOR_ID) && pickResultEvaluationScore(result) != null) return true;
    if (hasSelectedCustomEvaluator(result) && pickCustomEvaluationScore(result) != null) return true;
    return false;
}

export function buildEvaluationDiagnostic(
    errorCode: string,
    options: {
        details?: string;
        stage?: string;
        reason?: string;
        userMessage?: string;
        nextAction?: string;
        retryable?: boolean;
        internal?: EvaluationDiagnostic['internal'];
    } = {},
): EvaluationDiagnostic {
    const definition = DIAGNOSTIC_DEFINITIONS[errorCode] ?? {
        errorCategory: 'system' as const,
        shortStatus: '评测失败',
        userMessage: '评测执行失败。',
        reason: '评测执行过程中出现未分类异常。',
        nextAction: '重试评测；如果持续出现，请查看服务日志。',
        retryable: true,
        stage: 'unknown',
    };
    return {
        errorCode,
        errorCategory: definition.errorCategory,
        shortStatus: definition.shortStatus,
        userMessage: options.userMessage || definition.userMessage,
        reason: options.reason || definition.reason,
        nextAction: options.nextAction || definition.nextAction,
        retryable: typeof options.retryable === 'boolean' ? options.retryable : definition.retryable,
        stage: options.stage || definition.stage,
        ...(options.details ? { details: options.details } : {}),
        ...(options.internal ? { internal: options.internal } : {}),
    };
}

export function parseTrajectoryDiagnostic(
    result: TrajectoryDiagnosticResultLike | null | undefined,
): EvaluationDiagnostic | null {
    if (!result) return null;
    const direct = result.diagnostic;
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct as EvaluationDiagnostic;
    const raw = getRawAnalysis(result);
    const fromRaw = raw.diagnostic;
    if (fromRaw && typeof fromRaw === 'object' && !Array.isArray(fromRaw)) {
        return fromRaw as EvaluationDiagnostic;
    }
    const rawResultError = typeof raw.resultEvaluationError === 'string'
        ? raw.resultEvaluationError.trim()
        : '';
    const resultError = String(result.resultEvaluationError || rawResultError || '').trim();
    if (resultError) {
        const isOutputExtraction = resultError.includes('结果输出提取失败') || resultError.includes('任务输出提取');
        return buildEvaluationDiagnostic(
            isOutputExtraction ? 'task_output_extraction_failed' : 'result_evaluator_failed',
            { details: resultError, reason: resultError },
        );
    }
    const errorMessage = String(result.errorMessage || '').trim();
    if (!errorMessage) return null;
    if (errorMessage.includes(NO_EVALUABLE_CASE_PREFIX)) {
        return buildEvaluationDiagnostic('case_not_matched', {
            details: cleanNoEvaluableCaseMessage(errorMessage),
            reason: cleanNoEvaluableCaseMessage(errorMessage),
        });
    }
    if (result.status === 'failed' && errorMessage.includes('[recover]')) {
        return buildEvaluationDiagnostic('evaluator_recovered_failed', {
            details: errorMessage,
            reason: errorMessage,
        });
    }
    return null;
}

export function isTrajectoryEvaluationTerminal(status?: TrajectoryEvalStatus | null): boolean {
    return status === 'done' || status === 'failed';
}

export function getTrajectoryDisplayStatus(result: TrajectoryDiagnosticResultLike): TrajectoryDisplayStatus {
    if (result.status === 'pending') return 'pending';
    if (result.status === 'running') return 'running';
    const diagnostic = parseTrajectoryDiagnostic(result);
    if (diagnostic) {
        if (result.status === 'done' && hasAnySuccessfulSelectedEvaluator(result)) return 'partial_failed';
        return 'failed';
    }
    return result.status;
}

export function getTrajectoryStatusLabel(result: TrajectoryDiagnosticResultLike): string {
    if (result.status === 'pending') return '待评测';
    if (result.status === 'running') return '评测中';
    const diagnostic = parseTrajectoryDiagnostic(result);
    if (diagnostic) {
        if (result.status === 'done' && hasAnySuccessfulSelectedEvaluator(result)) return '部分评测失败';
        return diagnostic.shortStatus;
    }
    return result.status === 'done' ? '已评测' : '评测失败';
}

export function getTrajectoryStatusTone(result: TrajectoryDiagnosticResultLike): TrajectoryStatusTone {
    if (result.status === 'pending') return 'muted';
    if (result.status === 'running') return 'running';
    const diagnostic = parseTrajectoryDiagnostic(result);
    if (diagnostic) {
        if (result.status === 'done' && hasAnySuccessfulSelectedEvaluator(result)) return 'warning';
        return ['trace', 'dataset', 'case', 'skill'].includes(diagnostic.errorCategory) ? 'warning' : 'danger';
    }
    return result.status === 'done' ? 'success' : 'danger';
}

export function getTrajectoryStatusTitle(result: TrajectoryDiagnosticResultLike): string {
    if (result.status === 'pending' || result.status === 'running') return '';
    const diagnostic = parseTrajectoryDiagnostic(result);
    if (diagnostic) {
        return [
            diagnostic.userMessage,
            diagnostic.reason ? `具体原因：${diagnostic.reason}` : '',
            diagnostic.nextAction ? `下一步建议：${diagnostic.nextAction}` : '',
            diagnostic.details ? `详细信息：${diagnostic.details}` : '',
        ].filter(Boolean).join('\n');
    }
    return String(result.errorMessage || result.resultEvaluationError || '').trim();
}

export function getTrajectoryOverallConclusion(
    result: TrajectoryDiagnosticResultLike | null | undefined,
    options: { composite?: number | null; fallbackRootCauseStep?: string | null } = {},
): string {
    if (!result) return '该执行尚未评测';
    const diagnostic = parseTrajectoryDiagnostic(result);
    if (diagnostic && result.status !== 'pending' && result.status !== 'running') {
        return [
            diagnostic.userMessage,
            '',
            `错误分类：${CATEGORY_LABEL[diagnostic.errorCategory]}`,
            `具体原因：${diagnostic.reason}`,
            `下一步建议：${diagnostic.nextAction}`,
            diagnostic.details ? `详细信息：${diagnostic.details}` : '',
        ].filter(line => line !== '').join('\n');
    }
    const composite = options.composite ?? null;
    if (composite == null || !Number.isFinite(composite)) return '该执行尚未评测';
    if (composite >= 0.8) return '该执行在结果与过程两个维度均表现良好';
    if (composite >= 0.5) return '该执行结果基本可用，但部分关键动作覆盖不足';
    return '该执行关键动作覆盖不足，建议优先排查';
}

function cleanNoEvaluableCaseMessage(message: string): string {
    return message.replace(NO_EVALUABLE_CASE_PREFIX, '').trim() || '未匹配到可评测 case';
}
