/**
 * 预置轨迹评估器实现。
 *
 * 语义边界：
 *  - demo-agent 等执行 Agent 负责产出结果/轨迹。
 *  - trace-quality-evaluator 是预置评估器，负责读取执行轨迹并评分。
 *
 * 优先尝试通过 opencode runtime 执行评估，以便评估过程也能被链路采集；
 * 如果本机 opencode provider/agent 环境不可用，则退回到直接 LLM 评测。
 *
 * 评估器内部维度：
 *  - 规则冗余检测：
 *      纯代码统计连续重复调用、超高频调用
 *  - 主评估器直接完成的 LLM 维度评估：
 *      completeness : 步骤完整性
 *      tool_choice  : 工具/Skill 选择合理性
 *      attribution  : 步骤级根因定位
 *
 * 输入：单个 (case × actualTrace) 对（离线模式 = trace 已存在于 Session.interactions）。
 * 输出：dimensionScores + trajectoryScore + deviationSteps + rootCauseStep + reasonText。
 */
import {
    AgentInsight,
    type SendPromptPayload,
    type ChatHandlers,
} from '@/lib/engine/skill-generation/opencode-agent-cli/opencode-client';
import { runWithEphemeralOpencodeServer } from '@/lib/engine/skill-generation/opencode-agent-cli/opencode-manager';
import { withBackgroundOpencodeSlot } from '@/lib/engine/general-agent/concurrency-limiter';
import { getActiveConfig, type ModelConfig } from '@/lib/storage/server-config';
import {
    inferProviderFromBaseUrl,
    loadServerModelForUser,
    normalizeProviderID,
} from '@/lib/engine/general-agent/server-model-config';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { randomUUID } from 'node:crypto';
import {
    recordDirectEvaluatorExecution,
    recordEvaluatorExecution,
    shouldForceOpencodeEvalTransport,
} from './evaluator-execution-recorder';
import { tagOpencodeSession } from '@/lib/internal-agent-tag';
import { findSystemAgentDefinition, getSystemAgentId } from '@/lib/system-agents';

import {
    normalizeTrajectoryRedundancyDetails,
    type TrajectoryEvalInput,
    type TrajectoryEvalOutput,
    type TrajectoryDimensionScores,
    type TrajectoryDeviationStep,
    type KeyActionTraceAnalysisResult,
    type TrajectoryScoreAggregationInfo,
} from './trajectory-evaluator';

export class TrajectoryEvalConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TrajectoryEvalConfigError';
    }
}

export type { TrajectoryEvalInput, TrajectoryEvalOutput, TrajectoryDimensionScores, TrajectoryDeviationStep };

type JsonRecord = Record<string, unknown>;

const EVALUATOR_AGENT_NAME = 'trace-quality-evaluator';
const OPENCODE_FALLBACK_AGENT_NAME = 'build';

const COORDINATOR_SYSTEM_PROMPT = `你是 Agent Insight 的「关键动作轨迹分析器」。你会收到一个 case、可能存在的 Skill 已提取关键动作列表，以及已经处理过的扁平化 trace 步骤。

当 comparison_mode=skill_key_actions 时，你的核心任务是：逐个关键动作独立判断它是否被扁平化 trace 覆盖，并给出覆盖判定与简要比较说明。Skill 改进建议由独立的「建议流」负责，本分析器只做覆盖判定，不产出 Skill 改进建议。
当 comparison_mode=trace_only 时，说明当前 trace 未关联 Skill 或没有可用关键动作；此时不要做关键动作分析，只评估工具选择与冗余，完整性不计分。
你的任务不是输出路径偏离清单，也不是把 trace 和参考路径做全局对齐。为了兼容既有前端，你需要保留执行路径分析汇总：completeness / tool_choice / redundancy。

【硬性约束】
- 禁止派发、调用或生成任何 subagent / task。
- 只使用输入中的 actual_flat_trace_steps 作为 trace 判断依据。
- actual_flat_trace_steps 是事件级 trace 摘要，包含 user / llm / tool / skill / task；tool、skill、task 事件本身就是覆盖证据，不能因为多个工具服务于同一业务目标就合并忽略。
- 判断 read/bash/脚本/文件读取等行为时，必须查看 tool/skill/task 事件的 name、argsSummary、outputSummary、textContent、index/step_index。
- comparison_mode=skill_key_actions 时，必须为 reference_key_actions 中的每个关键动作输出且只输出一条 key_action_results。
- comparison_mode=trace_only 时，reference_key_actions 为空，必须输出 key_action_results: []，不要生成 Skill 改进建议。
- 不要输出 deviation_steps，不要输出 path deviation 列表。
- 必须输出 dimension_scores 与 dimension_details，用于前端展示完整性、工具选择、冗余三张卡片。
- 本分析器不输出 Skill 改进建议（has_skill_improvement / skill_improvement_suggestion 字段已废弃，无需生成）；只需给出 coverage 判定与 trace_comparison_analysis 比较说明。
- matched_trace_steps 只能填 actual_flat_trace_steps 中存在的 step_index；没有命中则填 []。
- confidence 是 0.0 到 1.0 的数字。
- severity 只能是 low / medium / high。
- coverage 只能是 covered / partial / missing / not_applicable。

【覆盖判定】
- covered：trace 明确执行了该动作，且关键顺序/目的基本满足。
- partial：trace 只执行了相邻或弱化动作，或执行了但证据不足/时机不完整。
- missing：trace 中没有对应动作。
- not_applicable：该动作有条件约束，当前 case 明显不满足条件。

【overall.score】
- comparison_mode=skill_key_actions 时，你需要输出 overall.score，表示关键动作覆盖质量，范围 0.0 到 1.0。
- 建议口径：covered=1，partial=0.5，missing=0，not_applicable 不计入分母；如关键动作带 weight，可按 weight 加权。
- comparison_mode=trace_only 时，overall.score 可以等于工具选择与冗余的综合质量；最终轨迹分仍由系统按工具选择和冗余重新聚合。

【三维分】
- comparison_mode=skill_key_actions 时，completeness 表示关键动作覆盖完整性。主要基于 key_action_results 的 coverage 和必要顺序，0.0 到 1.0。
- comparison_mode=trace_only 时，completeness 必须为 null，dimension_details.completeness.not_scored 必须为 true，explanation 说明：当前 trace 未关联 Skill，没有可用于覆盖判断的关键动作，因此完整性不参与轨迹评分。
- tool_choice：工具/Skill 选择合理性。**只能取三档之一**，按判据对号入座，不要给中间值：
  · 1.0 合理 —— 工具/Skill 调用都符合关键动作意图；该用 Skill 脚本的地方用了，无明显错误选择。
  · 0.5 部分合理 —— 大体正确，但有个别偏差，如该用 Skill 脚本却用了裸命令、或个别调用与意图不符。
  · 0.0 不合理 —— 多数调用跑偏、用错工具、或完全绕过 Skill 推荐方式。
- redundancy：路径简洁度（**分越高越不冗余**）。**只能取三档之一**：
  · 1.0 无冗余 —— 无明显重复、绕路或高频无效调用，路径紧凑。
  · 0.5 一定冗余 —— 存在部分重复或绕路，但未形成连续重复调用。
  · 0.0 冗余严重 —— 大量重复调用、明显绕路，或连续同类无效调用。
- tool_choice / redundancy 的 dimension_scores 与 dimension_details.score 必须是 0.0 / 0.5 / 1.0 之一；explanation 必须写清落在哪一档、依据是什么。
- dimension_details 中必须给出每个维度的 score 和 explanation；如有具体问题，放入 missing_steps / problematic_steps / heavy_repeated_calls 等数组，供前端展开。
- dimension_details.redundancy.consecutive_same_runs 每项必须包含 name、count、from、to；heavy_repeated_calls 每项必须包含 call、count。name/call 必须来自 actual_flat_trace_steps 的 name 字段，不能留空。
- reason_text 是前端顶部「执行路径分析」绿色框的正文，必须总结完整性、工具选择、冗余，以及关键偏差；不要只写关键动作覆盖数量。

【最终输出】只输出下面 schema 对应的严格 JSON：
\`\`\`json
{
  "schema_version": "key-action-trace-analysis@1.0",
  "overall": {
    "score": 0.75,
    "summary": "4 个关键动作中，2 个已覆盖、1 个部分覆盖、1 个缺失。",
    "covered_count": 2,
    "partial_count": 1,
    "missing_count": 1,
    "not_applicable_count": 0
  },
  "reason_text": "完整性(0.60)：5 个关键动作中 2 个覆盖、1 个部分覆盖、2 个缺失，缺失项会影响主流程闭环。工具选择(0.5 部分合理)：大多数工具调用与任务相关，但个别该用 Skill 脚本处用了裸命令。冗余(0.5 一定冗余)：存在部分重复或绕路，未形成连续重复调用。关键偏差：存在 high 严重度关键动作缺失，应优先修正。",
  "dimension_scores": {
    "completeness": 0.6,
    "tool_choice": 0.5,
    "redundancy": 0.5
  },
  "dimension_details": {
    "completeness": {
      "score": 0.6,
      "missing_steps": [
        { "description": "关键动作「修改后验证」未在 trace 中出现", "severity": "high" }
      ],
      "extra_steps": [],
      "explanation": "5 个关键动作中 2 个覆盖、1 个部分覆盖、2 个缺失，因此完整性为 0.6。"
    },
    "tool_choice": {
      "score": 0.5,
      "problematic_steps": [
        { "step_index": 3, "name": "bash", "issue": "缺少与关键动作匹配的验证命令", "severity": "medium" }
      ],
      "explanation": "落在 0.5 部分合理：多数工具调用与任务相关，但个别该用 Skill 脚本处用了裸命令。"
    },
    "redundancy": {
      "score": 0.5,
      "consecutive_same_runs": [
        { "name": "bash", "count": 3, "from": 4, "to": 6 }
      ],
      "heavy_repeated_calls": [
        { "call": "read", "count": 8 }
      ],
      "explanation": "落在 0.5 一定冗余：存在部分重复或绕路，但未形成连续重复调用。"
    }
  },
  "key_action_results": [
    {
      "action_id": "ka_1",
      "action_content": "修改后运行验证命令确认结果",
      "coverage": "missing",
      "severity": "high",
      "matched_trace_steps": [],
      "trace_comparison_analysis": "实际 trace 在完成修改后直接回复，没有运行测试、lint、构建或其它验证命令，因此该关键动作未覆盖。",
      "confidence": 0.91
    }
  ]
}
\`\`\`

comparison_mode=trace_only 时，输出同一个 schema，但必须满足：
- dimension_scores.completeness 为 null。
- dimension_details.completeness.score 为 null，not_scored 为 true。
- key_action_results 为 []。
- reason_text 中的完整性行必须写清“当前 trace 未关联 Skill，本维度不参与计分”。

只输出严格 JSON。`;

function buildUserMessage(input: TrajectoryEvalInput): string {
    return `# Key Action Trace Analysis Input

\`\`\`json
${JSON.stringify(buildKeyActionAnalysisPayload(input), null, 2)}
\`\`\`

请严格按 system prompt 输出 JSON。不要输出 Markdown、解释性前言或额外文本。`;
}

const DIRECT_EVALUATOR_SYSTEM_PROMPT = COORDINATOR_SYSTEM_PROMPT;

function buildDirectUserMessage(input: TrajectoryEvalInput): string {
    return buildUserMessage(input);
}

function buildKeyActionAnalysisPayload(input: TrajectoryEvalInput) {
    return {
        schema_version: 'key-action-trace-analysis@1.0',
        comparison_mode: input.comparisonMode || 'skill_key_actions',
        has_skill: input.comparisonMode === 'skill_key_actions',
        task: {
            case_id: input.caseId,
            input: input.caseInput,
            expected_output: input.referenceOutput || '',
            evaluation_focus: input.evaluationFocus || '',
            task_id: input.taskId || '',
            execution_id: input.executionId || '',
        },
        skill_context: input.skillContext || null,
        reference_key_actions: Array.isArray(input.referenceKeyActions) ? input.referenceKeyActions : [],
        reference_key_actions_text: input.referenceKeyActionsText || '',
        actual_flat_trace_steps: Array.isArray(input.actualExtractedSteps) ? input.actualExtractedSteps : [],
        actual_flat_trace_steps_text: input.actualExtractedStepsText || '',
        instructions: {
            language: 'zh-CN',
            analyze_each_key_action_independently: true,
            only_use_actual_flat_trace_steps_as_trace_basis: true,
            actual_trace_granularity: 'event_level_user_llm_tool_skill_task',
            do_not_generate_path_deviation_items: true,
            do_not_infer_extra_key_actions: true,
            skip_key_action_analysis: input.comparisonMode === 'trace_only',
            completeness_is_not_scored: input.comparisonMode === 'trace_only',
            score_only_tool_choice_and_redundancy: input.comparisonMode === 'trace_only',
        },
    };
}

function clamp01(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

/**
 * 三档吸附：工具选择/冗余度是锚定的三档评分（合理/部分/不合理），LLM 只应输出
 * 0 / 0.5 / 1；这里把任何漂移的连续值吸附到最近一档，作安全网。完整性是覆盖率
 * 汇总（连续），不走这个。
 */
function snap3(n: number): number {
    const c = clamp01(n);
    if (c < 0.25) return 0;
    if (c < 0.75) return 0.5;
    return 1;
}

function toNumber(v: unknown): number {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
}

function normalizeSeverity(v: unknown): 'low' | 'medium' | 'high' {
    const s = String(v || '').toLowerCase();
    if (s === 'high') return 'high';
    if (s === 'low') return 'low';
    return 'medium';
}

function asRecord(value: unknown): JsonRecord {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : {};
}

function normalizeCoverage(v: unknown): KeyActionTraceAnalysisResult['coverage'] {
    const s = String(v || '').toLowerCase().replace(/[\s-]+/g, '_');
    if (s === 'covered') return 'covered';
    if (s === 'partial' || s === 'partially_covered') return 'partial';
    if (s === 'not_applicable' || s === 'na' || s === 'n/a') return 'not_applicable';
    return 'missing';
}

function normalizeStepIndexes(value: unknown): number[] {
    const raw = Array.isArray(value) ? value : [];
    const out: number[] = [];
    for (const item of raw) {
        const n = typeof item === 'number' ? item : Number(item);
        if (Number.isFinite(n)) out.push(n);
    }
    return Array.from(new Set(out));
}

function normalizeKeyActionResults(value: unknown): KeyActionTraceAnalysisResult[] {
    return (Array.isArray(value) ? value : [])
        .map(asRecord)
        .filter(item => Object.keys(item).length > 0)
        .map(item => {
            const actionId = String(item.action_id ?? item.actionId ?? '').trim();
            const actionContent = String(item.action_content ?? item.actionContent ?? '').trim();
            return {
                actionId,
                actionContent,
                coverage: normalizeCoverage(item.coverage),
                severity: normalizeSeverity(item.severity),
                matchedTraceSteps: normalizeStepIndexes(item.matched_trace_steps ?? item.matchedTraceSteps),
                traceComparisonAnalysis: String(item.trace_comparison_analysis ?? item.traceComparisonAnalysis ?? '').trim(),
                // Skill 改进建议改由独立的「建议流」(skill-suggestion-agent) 产出；
                // 关键动作覆盖判定不再生成建议，以下字段保留仅为兼容旧结构。
                hasSkillImprovement: false,
                skillImprovementSuggestion: '',
                confidence: Number.isFinite(toNumber(item.confidence)) ? clamp01(toNumber(item.confidence)) : undefined,
            };
        });
}

function pickDimensionScores(parsed: JsonRecord, fallbackScore: number, traceOnly: boolean): TrajectoryDimensionScores {
    const dim = asRecord(parsed.dimension_scores ?? parsed.dimensionScores);
    const completeness = toNumber(dim.completeness);
    const toolChoice = toNumber(dim.tool_choice ?? dim.toolChoice);
    const redundancy = toNumber(dim.redundancy);
    return {
        completeness: traceOnly
            ? null
            : Number.isFinite(completeness)
            ? clamp01(completeness)
            : fallbackScore,
        // 工具选择/冗余度是三档锚定评分 → 吸附到 0 / 0.5 / 1
        toolChoice: Number.isFinite(toolChoice) ? snap3(toolChoice) : 1,
        redundancy: Number.isFinite(redundancy) ? snap3(redundancy) : 1,
    };
}

function aggregateTrajectoryScoreByMode(
    dims: TrajectoryDimensionScores,
    keyActionResults: KeyActionTraceAnalysisResult[],
    mode: TrajectoryEvalInput['comparisonMode'],
): { trajectoryScore: number; rawWeightedScore: number; scoreAggregation: TrajectoryScoreAggregationInfo } {
    if (mode === 'trace_only') {
        const toolWeight = 0.35;
        const redundancyWeight = 0.20;
        const rawWeightedScore = Math.round((
            (toolWeight * clamp01(dims.toolChoice) + redundancyWeight * clamp01(dims.redundancy))
            / (toolWeight + redundancyWeight)
        ) * 1000) / 1000;
        return {
            trajectoryScore: rawWeightedScore,
            rawWeightedScore,
            scoreAggregation: {
                mode: 'trace_only',
                reason: '当前 trace 未关联 Skill，完整性不参与计分；最终分只由工具选择和冗余归一化计算。',
                rawWeightedScore,
                finalScore: rawWeightedScore,
                highCount: 0,
                mediumCount: 0,
            },
        };
    }

    const rawWeightedScore = Math.round((
        0.45 * clamp01(typeof dims.completeness === 'number' ? dims.completeness : 0)
        + 0.35 * clamp01(dims.toolChoice)
        + 0.20 * clamp01(dims.redundancy)
    ) * 1000) / 1000;

    const actionable = keyActionResults.filter(item => item.coverage !== 'covered' && item.coverage !== 'not_applicable');
    const highCount = actionable.filter(item => item.severity === 'high').length;
    const mediumCount = actionable.filter(item => item.severity === 'medium').length;
    const reason = `轨迹分按完整性/工具选择/冗余加权计算；关键动作严重度仅用于诊断展示（high ${highCount}，medium ${mediumCount}），不调整最终分。`;

    return {
        trajectoryScore: clamp01(rawWeightedScore),
        rawWeightedScore,
        scoreAggregation: {
            mode: 'skill_key_actions',
            reason,
            rawWeightedScore,
            finalScore: clamp01(rawWeightedScore),
            highCount,
            mediumCount,
        },
    };
}

function buildFallbackReasonText(
    parsed: JsonRecord,
    dims: TrajectoryDimensionScores,
    scoreAggregation: TrajectoryScoreAggregationInfo,
): string {
    const details = asRecord(parsed.dimension_details ?? parsed.dimensionDetails);
    const completeness = asRecord(details.completeness);
    const toolChoice = asRecord(details.tool_choice ?? details.toolChoice);
    const redundancy = asRecord(details.redundancy);
    const completenessText = dims.completeness == null
        ? '不计分'
        : dims.completeness.toFixed(2);
    const parts = [
        `完整性(${completenessText})：${String(completeness.explanation || '评估器未给出完整性说明。')}`,
        `工具选择(${dims.toolChoice.toFixed(2)})：${String(toolChoice.explanation || '评估器未给出工具选择说明。')}`,
        `冗余(${dims.redundancy.toFixed(2)})：${String(redundancy.explanation || '评估器未给出冗余说明。')}`,
        `关键偏差：${scoreAggregation.reason}`,
    ];
    return parts.join('\n\n');
}

function normalizeOutput(
    parsedInput: unknown,
    expectedKeyActionCount = 0,
    comparisonMode: TrajectoryEvalInput['comparisonMode'] = 'skill_key_actions',
    actualSteps: unknown[] = [],
): TrajectoryEvalOutput {
    const parsed = normalizeTrajectoryRedundancyDetails(asRecord(parsedInput), actualSteps);
    const overall = asRecord(parsed.overall);
    const traceOnly = comparisonMode === 'trace_only';
    const keyActionResults = traceOnly
        ? []
        : normalizeKeyActionResults(parsed.key_action_results ?? parsed.keyActionResults);
    if (!traceOnly && expectedKeyActionCount > 0 && keyActionResults.length !== expectedKeyActionCount) {
        throw new Error(
            `关键动作评估结果数量不匹配：期望 ${expectedKeyActionCount} 条，实际 ${keyActionResults.length} 条`,
        );
    }
    for (const item of keyActionResults) {
        if (!item.actionId) {
            throw new Error(`关键动作评估结果缺少 action_id: ${item.actionContent || '(unknown action)'}`);
        }
        if (!item.actionContent) {
            throw new Error(`关键动作评估结果缺少 action_content: ${item.actionId}`);
        }
        // trace_comparison_analysis / skill_improvement_suggestion 不再强制校验：
        // 建议已迁出到独立的「建议流」(skill-suggestion-agent)，本判定只产覆盖结果。
    }

    const rawScore = toNumber(overall.score);
    if (!traceOnly && !Number.isFinite(rawScore)) {
        throw new Error('关键动作评估结果缺少 overall.score');
    }
    const score = Number.isFinite(rawScore) ? clamp01(rawScore) : 0;
    if (traceOnly) {
        const dim = asRecord(parsed.dimension_scores ?? parsed.dimensionScores);
        if (!Number.isFinite(toNumber(dim.tool_choice ?? dim.toolChoice)) || !Number.isFinite(toNumber(dim.redundancy))) {
            throw new Error('无 Skill 轨迹评测缺少 dimension_scores.tool_choice 或 dimension_scores.redundancy');
        }
    }
    const dimensionScores = pickDimensionScores(parsed, score, traceOnly);
    const { trajectoryScore, rawWeightedScore, scoreAggregation } = aggregateTrajectoryScoreByMode(
        dimensionScores,
        keyActionResults,
        comparisonMode,
    );
    const reasonText = String(parsed.reason_text || parsed.reasonText || '').trim()
        || buildFallbackReasonText(parsed, dimensionScores, scoreAggregation);

    const deviationSteps: TrajectoryDeviationStep[] = [];

    return {
        trajectoryScore,
        rawWeightedScore,
        scoreAggregation,
        dimensionScores,
        deviationSteps,
        keyActionResults,
        reasonText,
        rawAnalysis: {
            ...parsed,
            schema_version: parsed.schema_version || (traceOnly ? 'trace-only-analysis@1.0' : 'key-action-trace-analysis@1.0'),
            comparison_mode: comparisonMode,
            keyActionResults,
            score_aggregation: scoreAggregation,
            dimension_scores: {
                completeness: dimensionScores.completeness,
                tool_choice: dimensionScores.toolChoice,
                redundancy: dimensionScores.redundancy,
                key_action_coverage: traceOnly ? null : score,
            },
        },
    };
}

function makeDirectModel(config: ModelConfig) {
    return new ChatOpenAI({
        apiKey: config.apiKey || 'no-api-key',
        model: config.model || 'deepseek-chat',
        configuration: {
            baseURL: config.baseUrl || 'https://api.deepseek.com',
        },
        temperature: 0,
        topP: 1,
        // 显式超时 + 重试，对齐 opencode 路径（idleTimeoutMs 3min / streamTimeoutMs 10min）。
        // 单轮 judge 正常 <10s，180s 兜住卡死调用；瞬时错误自动重试 2 次。
        timeout: 180_000,
        maxRetries: 2,
        modelKwargs: {
            seed: 42,
        },
    });
}

async function evaluateTrajectoryDirect(
    input: TrajectoryEvalInput,
    config: ModelConfig,
): Promise<TrajectoryEvalOutput> {
    const model = makeDirectModel(config);
    const response = await model.invoke([
        new SystemMessage(DIRECT_EVALUATOR_SYSTEM_PROMPT),
        new HumanMessage(buildDirectUserMessage(input)),
    ]);
    const content = typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content);
    // 与 opencode 路径用同一个多策略提取器（extractFinalResultFromText），保证两路解析一致。
    const parsed = extractFinalResultFromText(content);
    if (!parsed) {
        throw new Error(`直接 LLM 评测未产出有效 JSON。模型输出前 800 字符：${content.slice(0, 800)}`);
    }
    return normalizeOutput(
        asRecord(parsed),
        Array.isArray(input.referenceKeyActions) ? input.referenceKeyActions.length : 0,
        input.comparisonMode,
        input.actualExtractedSteps,
    );
}

/** 从 langchain 响应里抽 token 用量（usage_metadata 优先，回退 response_metadata.tokenUsage）。 */
function extractLangchainUsage(
    response: unknown,
): { input?: number; output?: number; total?: number } | null {
    const meta = (response as {
        usage_metadata?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
    })?.usage_metadata;
    if (meta && (typeof meta.input_tokens === 'number' || typeof meta.output_tokens === 'number')) {
        return { input: meta.input_tokens, output: meta.output_tokens, total: meta.total_tokens };
    }
    const tu = (response as {
        response_metadata?: { tokenUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } };
    })?.response_metadata?.tokenUsage;
    if (tu && (typeof tu.promptTokens === 'number' || typeof tu.completionTokens === 'number')) {
        return { input: tu.promptTokens, output: tu.completionTokens, total: tu.totalTokens };
    }
    return null;
}

/**
 * 直连 LLM 轨迹评测（primary path）：一次 model.invoke 拿到 JSON，正常解析后把这次 judge 合成成一条
 * trace 落库（含 system rubric）。prompt / 模型参数(temperature 0, seed 42) 与 opencode 路径一致，
 * 只是省掉了起进程 + session 往返。EVAL_FORCE_OPENCODE_TRANSPORT=1 可回退旧 opencode 路径。
 */
async function evaluateTrajectoryDirectAndRecord(
    input: TrajectoryEvalInput,
    config: ModelConfig,
    user?: string | null,
): Promise<TrajectoryEvalOutput> {
    const model = makeDirectModel(config);
    const userMsg = buildUserMessage(input);
    const response = await model.invoke([
        new SystemMessage(DIRECT_EVALUATOR_SYSTEM_PROMPT),
        new HumanMessage(userMsg),
    ]);
    const assistantText = typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content);
    // 与 opencode 路径用同一个多策略提取器（extractFinalResultFromText），保证两路解析一致。
    const parsed = extractFinalResultFromText(assistantText);
    if (!parsed) {
        throw new Error(`直接 LLM 轨迹评测未产出有效 JSON。模型输出前 800 字符：${assistantText.slice(0, 800)}`);
    }
    const normalized = normalizeOutput(
        asRecord(parsed),
        Array.isArray(input.referenceKeyActions) ? input.referenceKeyActions.length : 0,
        input.comparisonMode,
        input.actualExtractedSteps,
    );
    const evaluatorSessionId = `${EVALUATOR_AGENT_NAME}-${(input.caseId || 'case').slice(0, 24)}-${randomUUID()}`;
    const def = findSystemAgentDefinition('opencode', EVALUATOR_AGENT_NAME);
    await recordDirectEvaluatorExecution({
        taskId: evaluatorSessionId,
        agentName: EVALUATOR_AGENT_NAME,
        user,
        query: input.caseInput,
        systemPrompt: DIRECT_EVALUATOR_SYSTEM_PROMPT,
        userMessage: userMsg,
        assistantOutput: assistantText,
        usage: extractLangchainUsage(response),
        modelID: config.model,
        skill: def?.traceSkill ?? null,
    }).catch((err) => {
        console.warn('[opencode-trajectory-eval] failed to record direct evaluator trace:', (err as Error)?.message || err);
    });
    return {
        ...normalized,
        rawAnalysis: {
            ...(normalized.rawAnalysis || {}),
            evaluatorSessionId,
        },
    };
}

function parseJsonLoose(s: string): unknown | null {
    let text = s.trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fence) text = fence[1];
    try {
        return JSON.parse(text);
    } catch {
        const first = text.indexOf('{');
        const last = text.lastIndexOf('}');
        if (first !== -1 && last !== -1 && last > first) {
            try {
                return JSON.parse(text.substring(first, last + 1));
            } catch {
                return null;
            }
        }
        return null;
    }
}

function extractFinalResultFromText(fullText: string): unknown | null {
    // v2：LLM 不再输出 trajectory_score，改以 dimension_scores 为有效 JSON 的判据。
    // 兼容旧输出：trajectory_score 仍可识别，但其值会被聚合层忽略。
    const hasEvalKeys = (rec: JsonRecord): boolean =>
        typeof rec.key_action_results !== 'undefined'
        || typeof rec.keyActionResults !== 'undefined'
        || typeof rec.dimension_scores !== 'undefined'
        || typeof rec.dimensionScores !== 'undefined'
        || typeof rec.trajectory_score !== 'undefined';

    const jsonBlockMatch = fullText.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlockMatch) {
        const parsed = parseJsonLoose(jsonBlockMatch[1]);
        const parsedRecord = asRecord(parsed);
        if (hasEvalKeys(parsedRecord)) return parsedRecord;
    }

    const dimMatch = fullText.match(/\{[\s\S]*"dimension_scores"[\s\S]*\}/);
    if (dimMatch) {
        const parsed = parseJsonLoose(dimMatch[0]);
        if (parsed) return parsed;
    }

    const keyActionMatch = fullText.match(/\{[\s\S]*"key_action_results"[\s\S]*\}/);
    if (keyActionMatch) {
        const parsed = parseJsonLoose(keyActionMatch[0]);
        if (parsed) return parsed;
    }

    const trajectoryMatch = fullText.match(/\{[\s\S]*"trajectory_score"[\s\S]*\}/);
    if (trajectoryMatch) {
        return parseJsonLoose(trajectoryMatch[0]);
    }

    return null;
}

export async function evaluateTrajectoryViaOpencode(
    input: TrajectoryEvalInput,
    user?: string | null,
    skillName?: string | null,    // 透传给 limiter,让"后台分析任务"按 skill 严格过滤
    skillVersion?: number | null, // skill 版本号,展示用
): Promise<TrajectoryEvalOutput> {
  return withBackgroundOpencodeSlot(async () => {
   // PRIMARY: 直连 LLM 单轮 judge —— 不起 opencode 进程、不建 session（省 ~1.6s 固定开销/次）。
   // 评测 trace 由 recordDirectEvaluatorExecution 合成落库（含 system rubric），与走 opencode 等价。
   // 设 EVAL_FORCE_OPENCODE_TRANSPORT=1 可一键回到旧 opencode 路径。
   if (!shouldForceOpencodeEvalTransport()) {
     const directConfig = await getActiveConfig(user);
     if (!directConfig) {
       throw new TrajectoryEvalConfigError(
         '未配置评测模型，请先在「模型配置」中激活一个模型。',
       );
     }
     try {
       return await evaluateTrajectoryDirectAndRecord(input, directConfig, user);
     } catch (directErr) {
       if (directErr instanceof TrajectoryEvalConfigError) throw directErr;
       console.warn(
         '[opencode-trajectory-eval] direct LLM path failed, falling back to opencode transport:',
         (directErr as Error)?.message || directErr,
       );
     }
   }
   return runWithEphemeralOpencodeServer({ user: user || undefined, verbose: false, isolateHome: true }, async (serverUrl) => {
    const config = await getActiveConfig(user);
    if (!config) {
        throw new TrajectoryEvalConfigError(
            '未配置评测模型，请先在「模型配置」中激活一个模型。',
        );
    }

    const userMsg = buildUserMessage(input);

    const activeModel = user ? await loadServerModelForUser(user) : null;
    const providerID = activeModel?.providerID || resolveProviderID(config);
    const modelID = activeModel?.modelID || config.model || 'deepseek-chat';

    const permissions = [
        { permission: 'external_directory', pattern: '/tmp/*', action: 'allow' },
    ];

    const payload: SendPromptPayload = {
        text: userMsg,
        agent: OPENCODE_FALLBACK_AGENT_NAME,
        model: {
            providerID,
            modelID,
            apiKey: activeModel?.apiKey || config.apiKey,
            baseURL: activeModel?.baseURL || config.baseUrl,
        },
        modelOptions: {
            temperature: 0,
            top_p: 1,
            seed: 42,
        },
        system: COORDINATOR_SYSTEM_PROMPT,
        permission: permissions,
    };

    let fullText = '';
    let runtimeError: Error | null = null;
    let evaluatorSessionId = '';
    let unexpectedSubagent: string | null = null;
    let insight: AgentInsight | null = null;
    const handlers: ChatHandlers = {
        onText: (e) => {
            fullText += e.delta;
        },
        onError: (e) => {
            runtimeError = e;
        },
        onSubagent: (e) => {
            unexpectedSubagent = e.agent || e.sessionID || 'unknown-subagent';
            console.warn(`[opencode-trajectory-eval] unexpected subagent spawned: ${unexpectedSubagent}`);
        },
        onTool: (e) => {
            if (e.name === 'task') {
                unexpectedSubagent = unexpectedSubagent || 'task';
                console.warn('[opencode-trajectory-eval] unexpected task tool invocation detected');
            }
            console.log(`[opencode-trajectory-eval] tool ${e.name}: phase=${e.phase}`);
        },
    };

    try {
        // serverUrl 由外层 runWithEphemeralOpencodeServer 注入 —— per-task 新进程,跑完自动杀
        insight = new AgentInsight({
            baseURL: serverUrl,
            logLevel: 'warn',
        });

        const sessionResp = await insight.createSession({
            title: `${EVALUATOR_AGENT_NAME}-${input.caseId}-${Date.now()}`,
        });
        const sessionId = String(sessionResp?.id || sessionResp?.ID || '');
        if (!sessionId) {
            throw new Error('Failed to create opencode session for trajectory evaluation');
        }
        evaluatorSessionId = sessionId;

        const agentId = await getSystemAgentId('opencode', EVALUATOR_AGENT_NAME);
        const def = findSystemAgentDefinition('opencode', EVALUATOR_AGENT_NAME);
        tagOpencodeSession(sessionId, {
            agentName: EVALUATOR_AGENT_NAME,
            agentId,
            skill: def?.traceSkill,
            displayQuery: input.caseInput,
            user: user || undefined,
        });

        const result = await insight.chat(sessionId, payload, handlers, {
            streamTimeoutMs: 10 * 60 * 1000,
            idleTimeoutMs: 3 * 60 * 1000,
        });

        fullText = result.text || fullText;

        await recordEvaluatorExecution(insight, {
            taskId: sessionId,
            agentName: EVALUATOR_AGENT_NAME,
            user,
            query: input.caseInput,
        });

        if (unexpectedSubagent) {
            throw new Error(`轨迹评估器不允许派发子代理，但实际派发了：${unexpectedSubagent}`);
        }

        const parsed = extractFinalResultFromText(fullText);
        if (parsed) {
            const normalized = normalizeOutput(
                parsed,
                Array.isArray(input.referenceKeyActions) ? input.referenceKeyActions.length : 0,
                input.comparisonMode,
                input.actualExtractedSteps,
            );
            return {
                ...normalized,
                rawAnalysis: {
                    ...(normalized.rawAnalysis || {}),
                    evaluatorSessionId,
                },
            };
        }
    } catch (e) {
        runtimeError = e instanceof Error ? e : new Error(String(e));
    }

    if (evaluatorSessionId && insight) {
        try {
            await recordEvaluatorExecution(insight, {
                taskId: evaluatorSessionId,
                agentName: EVALUATOR_AGENT_NAME,
                user,
                query: input.caseInput,
            });
        } catch (persistError) {
            console.warn(
                '[opencode-trajectory-eval] failed to persist evaluator execution:',
                (persistError as Error)?.message || persistError,
            );
        }
    }

    console.warn(
        '[opencode-trajectory-eval] opencode evaluator did not produce JSON, falling back to direct LLM evaluator:',
        runtimeError?.message || fullText.slice(0, 300),
    );

    try {
        const direct = await evaluateTrajectoryDirect(input, config);
        return {
            ...direct,
            rawAnalysis: {
                ...(direct.rawAnalysis || {}),
                evaluatorSessionId: evaluatorSessionId || undefined,
                unexpectedSubagent: unexpectedSubagent || undefined,
            },
        };
    } catch (fallbackError) {
        const primaryDetail = runtimeError?.message || `Agent 输出前 800 字符：${fullText.slice(0, 800)}`;
        const fallbackDetail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        throw new Error(
            `轨迹评估器未产出有效 JSON。opencode 评测失败：${primaryDetail}；直接 LLM 评测也失败：${fallbackDetail}`,
        );
    }
   });
  }, {
    taskType: 'trajectory-eval',
    user: user ?? undefined,
    skill: skillName ?? undefined,
    skillVersion: skillVersion ?? null,
    label: `trajectory: ${(input.caseInput || '').slice(0, 40)}`,
    // silent: 同 task-completion 注释,内部子步骤不单独显示。
    silent: true,
  });
}

function resolveProviderID(config: ModelConfig): string {
    return normalizeProviderID(config.provider || inferProviderFromBaseUrl(config.baseUrl));
}

export const EVALUATOR_AGENT_PROMPTS = {
    coordinator: COORDINATOR_SYSTEM_PROMPT,
};

export const EVALUATOR_AGENTS = [
    {
        id: 'trace-quality-evaluator',
        name: 'trace-quality-evaluator',
        ownership: 'system' as const,
        layer: 'main' as const,
        platform: 'opencode' as const,
        version: 'v1.0',
        framework: 'opencode',
        status: 'running' as const,
        successRate: '—',
        todayCalls: '—',
        lastExecutedAt: new Date().toISOString(),
        description: 'Agent 轨迹质量评估器 — 基于 opencode 的单主评估器，直接完成 completeness / tool-choice / attribution 评估，并结合规则冗余检测输出结果',
    },
];
