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
import {
    formatTraceForLLM,
    summarizeTrace,
    type TraceSummary,
} from './trace-summarizer';
import { recordEvaluatorExecution } from './evaluator-execution-recorder';
import { tagOpencodeSession } from '@/lib/internal-agent-tag';
import { findSystemAgentDefinition, getSystemAgentId } from '@/lib/system-agents';

import {
    type TrajectoryEvalInput,
    type TrajectoryEvalOutput,
    type TrajectoryDimensionScores,
    type TrajectoryDeviationStep,
    aggregateTrajectoryScore,
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

const COORDINATOR_SYSTEM_PROMPT = `你是 Agent Insight 的「轨迹质量评估器」。你会收到一个 (case + actual_trace + reference_trajectory) 三元组，必要时还会带 reference_key_actions 与 actual_extracted_steps，以及已由规则代码计算好的冗余检测结果。

请按下面的步骤完成内部分析，但最终只输出 JSON。不要输出步骤过程、Markdown、解释性前言或额外文本。

【你的职责边界 —— 非常重要】
- 你只负责给出 3 个维度的【单项分】(completeness / tool_choice / redundancy) 和一份带 severity 的【偏差清单】(deviation_steps)。
- 你【不要】计算、不要输出最终 trajectory_score —— 最终轨迹分的加权与"严重度封顶"由系统代码统一计算，你算了也会被忽略。
- 你的任务是把每一处偏差识别准、severity 标准，因为 severity 会直接决定是否触发封顶。

【比较模式】
- 当 comparison_mode = trajectory 时：按 reference_trajectory 和 actual_trace 做常规轨迹对比。
- 当 comparison_mode = skill_key_actions 时：优先按 reference_key_actions 和 actual_extracted_steps 做关键步骤覆盖/偏离分析，再结合 actual_trace 判断工具选择与根因。

【硬性约束】
- 你必须自己完成全部评测，禁止派发、调用或生成任何 subagent / task；本次评测只能由你这个主评估器独立完成。
- 不要调用工具、不要写文件、不要尝试重新检测冗余；输入里的规则冗余结果就是唯一依据。
- 所有分数必须是 0.0 到 1.0 之间的数字。
- \`dimension_scores.completeness\` 必须等于 \`dimension_details.completeness.score\`。
- \`dimension_scores.tool_choice\` 必须等于 \`dimension_details.tool_choice.score\`。
- \`dimension_scores.redundancy\` 必须等于输入规则结果里的 \`redundancy_score\`。

【三个维度的打分细则 —— 必须在 dimension_details 里写清算法依据】
维度 1 · 完整性 completeness（覆盖率 − 顺序惩罚）
- coverage = 实际命中的参考关键步骤数 ÷ 参考关键步骤总数。
- order_penalty：参考中有明确先后依赖、实际却乱序的，每处关键顺序错扣 0.10、非关键顺序错扣 0.05，上限 0.30。
- score = clamp01(coverage − order_penalty)。
- 在 dimension_details.completeness 里写明 coverage、order_penalty、missing_steps（应有但未执行）、extra_steps（多余/明显绕路）、explanation。
- missing_steps / extra_steps 每一项都必须是对象 {"description": "...", "severity": "high|medium|low"}（extra_steps 另可带 "step_index"），禁止用纯字符串，否则前端无法展示明细。

维度 2 · 工具选择 tool_choice（逐步打分求平均）
- 对 actual_trace 里每个 tool/skill 调用打一个 0~1 的小分：选对工具且参数与时机都合理 = 1.0；调用时机不当 = 0.7；参数有误 = 0.5；选错工具/用了破坏性或无关工具 = 0.0。
- score = 所有调用小分的平均；无调用时给 1.0。
- 在 dimension_details.tool_choice.problematic_steps 里逐条写 {step_index, name, issue, penalty(=1−小分), severity}，并在 explanation 里说明平均算法。

维度 3 · 冗余 redundancy（直接采用规则分）
- 直接采用输入中已计算好的 redundancy_score，把规则检测结果摘要写入 dimension_details.redundancy。

【偏差清单 deviation_steps 与 severity 判级 —— 直接决定封顶】
对每一处偏差产出一条记录，并标注 severity 与 factor：
- factor 取值：completeness | tool_choice | redundancy | error_recovery | grounding | other。
  · error_recovery：执行中出现报错/失败后，是否得到恰当恢复（重试、换路径、报告并停止）。
  · grounding：行动是否建立在真实读取/验证到的信息上，而非臆测、幻觉或未经核实的假设。
- severity 判级标准（务必严格，会影响封顶）：
  · high = 关键步骤缺失 / 方向性错误 / 不可逆后果：漏掉强制性 key action、用错工具或执行破坏性操作、基于幻觉或未验证信息采取关键行动、出现阻塞性错误却始终未恢复。
  · medium = 明显绕路 / 次优：多余步骤、参数小错、可恢复但笨拙的错误处理、非关键步骤顺序错乱。
  · low = 轻微 / 风格层面，不影响最终结果。
- 对每个 deviation_step 判断 is_skill_attributable：
  · true：如果在 SKILL.md 增加明确规则、示例或前置约束，能显著降低这个错误复现概率。
  · false：偏差主要来自 agent 自身推理、模型能力、外部环境或一次性执行波动。
- 仅当 is_skill_attributable=true 时，给出具体到 SKILL.md 小节级别的 improvement_suggestion。

【根因定位（不计分，仅展示）】
- 综合上述发现，定位最关键的偏离步骤写入 root_cause_step；没有显著偏离时为 null。
- 在 dimension_details.attribution 里写 {root_cause_step, reasoning, error_recovery_findings, grounding_findings}。

【最终输出】只输出下面 schema 对应的严格 JSON（不含 trajectory_score）：

\`\`\`json
{
  "dimension_scores": {
    "completeness": 0.0,
    "tool_choice": 0.0,
    "redundancy": 0.0
  },
  "deviation_steps": [
    {
      "step_index": 5,
      "kind": "tool",
      "name": "bash",
      "deviation": "...",
      "severity": "low|medium|high",
      "factor": "tool_choice|completeness|redundancy|error_recovery|grounding|other",
      "is_skill_attributable": true,
      "improvement_suggestion": "在 SKILL.md 的 X 章节明确：执行 bash 前先 ..."
    }
  ],
  "root_cause_step": "step#5: bash",
  "reason_text": "(中文 markdown 综述, 200-400 字；说明三个维度各自的得分依据，并指出哪些偏差可能触发封顶)",
  "dimension_details": {
    "redundancy": {
      "consecutive_same_runs": [],
      "heavy_repeated_calls": [],
      "total_tool_calls": 0,
      "total_skill_calls": 0,
      "redundancy_score": 1.0
    },
    "completeness": {
      "score": 0.85,
      "coverage": 0.9,
      "order_penalty": 0.05,
      "missing_steps": [ { "description": "参考要求先 grep 关键字再分析，实际跳过了", "severity": "high" } ],
      "extra_steps": [ { "step_index": 5, "description": "多调用一次 ls", "severity": "low" } ],
      "explanation": "coverage=0.9，1 处非关键顺序错 order_penalty=0.05，score=0.85"
    },
    "tool_choice": {
      "score": 0.78,
      "problematic_steps": [ { "step_index": 3, "name": "bash", "issue": "本该用 grep 却用 ls", "penalty": 0.5, "severity": "medium" } ],
      "explanation": "5 次调用平均：..."
    },
    "attribution": {
      "root_cause_step": "step#5: bash",
      "reasoning": "...",
      "error_recovery_findings": [],
      "grounding_findings": []
    }
  }
}
\`\`\`

【关于 dimension_details 字段】
- redundancy 放规则检测结果摘要。
- completeness / tool_choice 放各自的结构化打分依据（含 coverage / order_penalty / 逐步小分），供前端与 skill-opt 直接消费。
- attribution 放根因与 error_recovery / grounding 发现，仅供展示，不计入分数。

只输出严格 JSON。`;

function buildRedundancyDetectionPrompt(traceSummary: TraceSummary): string {
    const steps = traceSummary.steps;
    const callPatterns = new Map<string, number>();
    const consecutiveSame: Array<{ name: string; count: number; from: number; to: number }> = [];

    let runStart = -1;
    let runName = '';

    const flushRun = (endIdx: number) => {
        if (runStart >= 0) {
            const length = endIdx - runStart;
            if (length >= 3) {
                consecutiveSame.push({ name: runName, count: length, from: runStart, to: endIdx - 1 });
            }
        }
    };

    for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        if (s.kind === 'tool' || s.kind === 'skill') {
            const key = `${s.kind}:${s.name || 'unknown'}`;
            callPatterns.set(key, (callPatterns.get(key) || 0) + 1);

            if (key !== runName) {
                flushRun(i);
                runName = key;
                runStart = i;
            }
        } else {
            flushRun(i);
            runStart = -1;
            runName = '';
        }
    }
    flushRun(steps.length);

    const repeatedHeavy = Array.from(callPatterns.entries())
        .filter(([, c]) => c >= 5)
        .map(([k, c]) => ({ call: k, count: c }));

    const redundancyScore = Math.max(
        0,
        1 - 0.2 * consecutiveSame.length - 0.1 * repeatedHeavy.length,
    );

    return `# 冗余检测结果（规则工具 detect_redundancy_and_loops 输出）

\`\`\`json
${JSON.stringify({
    consecutive_same_runs: consecutiveSame,
    heavy_repeated_calls: repeatedHeavy,
    total_tool_calls: traceSummary.totalToolCalls,
    total_skill_calls: traceSummary.totalSkillCalls,
    redundancy_score: redundancyScore,
}, null, 2)}
\`\`\`

请在聚合时直接使用此 redundancy_score，无需再调用工具检测冗余。`;
}

function buildUserMessage(input: TrajectoryEvalInput, traceText: string, redundancySection: string): string {
    return `# 待评估三元组

## Case
- caseId: ${input.caseId}
- input: ${input.caseInput}
- reference_output: ${input.referenceOutput || '(未提供)'}
- comparison_mode: ${input.comparisonMode || 'trajectory'}
- evaluation_focus: ${input.evaluationFocus || '(未指定)'}

## 参考轨迹 (reference_trajectory)
\`\`\`
${input.referenceTrajectory || '(未提供，按 reference_output 反推应有步骤)'}
\`\`\`

## 参考关键步骤 (reference_key_actions)
\`\`\`
${input.referenceKeyActionsText || '(未提供)'}
\`\`\`

## 实际提取关键步骤 (actual_extracted_steps)
\`\`\`
${input.actualExtractedStepsText || '(未提供)'}
\`\`\`

## 实际轨迹 (actual_trace, taskId=${input.taskId || 'N/A'}, executionId=${input.executionId || 'N/A'})
\`\`\`
${traceText}
\`\`\`

${redundancySection}

请在不派发任何子代理的前提下，直接完成完整性、工具选择、根因定位 3 个维度的评估，并只输出符合 schema 的 JSON。

注意：冗余检测已由规则代码完成，结果已在上方提供。请直接使用该 redundancy_score，不要再调用 task 或生成任何子代理。`;
}

const DIRECT_EVALUATOR_SYSTEM_PROMPT = COORDINATOR_SYSTEM_PROMPT;

function buildDirectUserMessage(input: TrajectoryEvalInput, traceText: string, redundancySection: string): string {
    return `# 待评估三元组

## Case
- caseId: ${input.caseId}
- input: ${input.caseInput}
- reference_output: ${input.referenceOutput || '(未提供)'}
- comparison_mode: ${input.comparisonMode || 'trajectory'}
- evaluation_focus: ${input.evaluationFocus || '(未指定)'}

## 参考轨迹 (reference_trajectory)
\`\`\`
${input.referenceTrajectory || '(未提供，按 reference_output 反推应有步骤)'}
\`\`\`

## 参考关键步骤 (reference_key_actions)
\`\`\`
${input.referenceKeyActionsText || '(未提供)'}
\`\`\`

## 实际提取关键步骤 (actual_extracted_steps)
\`\`\`
${input.actualExtractedStepsText || '(未提供)'}
\`\`\`

## 实际轨迹 (actual_trace, taskId=${input.taskId || 'N/A'}, executionId=${input.executionId || 'N/A'})
\`\`\`
${traceText}
\`\`\`

${redundancySection}

请只输出符合 schema 的 JSON。`;
}

function clamp01(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
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

function normalizeFactor(v: unknown): TrajectoryDeviationStep['factor'] {
    const s = String(v || '').toLowerCase().replace(/[\s-]+/g, '_');
    if (s === 'completeness') return 'completeness';
    if (s === 'tool_choice' || s === 'toolchoice') return 'tool_choice';
    if (s === 'redundancy') return 'redundancy';
    if (s === 'error_recovery' || s === 'errorrecovery') return 'error_recovery';
    if (s === 'grounding') return 'grounding';
    if (s) return 'other';
    return undefined;
}

function asRecord(value: unknown): JsonRecord {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : {};
}

function normalizeOutput(parsedInput: unknown): TrajectoryEvalOutput {
    const parsed = asRecord(parsedInput);
    const dim = asRecord(parsed.dimension_scores || parsed.dimensionScores);
    const dimensionScores: TrajectoryDimensionScores = {
        completeness: clamp01(toNumber(dim.completeness)),
        toolChoice: clamp01(toNumber(dim.tool_choice ?? dim.toolChoice)),
        redundancy: clamp01(toNumber(dim.redundancy)),
    };
    // attribution 不再计入加权分；若 LLM 仍输出则保留用于展示历史口径，否则不带。
    const attribRaw = toNumber(dim.attribution);
    if (Number.isFinite(attribRaw)) dimensionScores.attribution = clamp01(attribRaw);

    const deviationsRaw = parsed.deviation_steps || parsed.deviationSteps || [];
    const deviationSteps: TrajectoryDeviationStep[] = Array.isArray(deviationsRaw)
        ? deviationsRaw
              .map(asRecord)
              .filter(d => Object.keys(d).length > 0)
              .map(d => {
                  // is_skill_attributable 缺省（旧评测数据 / 维度分析漏字段）按 true 兜底，
                  // 避免漏报；用户在 skill-opt 页可以手动忽略。
                  const skillAttr = d.is_skill_attributable ?? d.isSkillAttributable;
                  const suggestion = String(d.improvement_suggestion ?? d.improvementSuggestion ?? '').trim();
                  return {
                      stepIndex: Number(d.step_index ?? d.stepIndex ?? -1),
                      kind: String(d.kind || ''),
                      name: d.name ? String(d.name) : undefined,
                      deviation: String(d.deviation || d.description || ''),
                      severity: normalizeSeverity(d.severity),
                      factor: normalizeFactor(d.factor),
                      isSkillAttributable: skillAttr === false ? false : true,
                      improvementSuggestion: suggestion || undefined,
                  };
              })
        : [];

    // 轨迹分一律由代码侧聚合层计算（加权 0.45/0.35/0.20 + 严重度封顶），
    // 不再信任 LLM 自算的 trajectory_score —— 即使 LLM 输出了也忽略。
    const { trajectoryScore, rawWeightedScore, cap } = aggregateTrajectoryScore(dimensionScores, deviationSteps);

    return {
        trajectoryScore,
        rawWeightedScore,
        cap,
        dimensionScores,
        deviationSteps,
        rootCauseStep: (typeof parsed.root_cause_step === 'string' ? parsed.root_cause_step : (typeof parsed.rootCauseStep === 'string' ? parsed.rootCauseStep : undefined)),
        reasonText: String(parsed.reason_text || parsed.reasonText || ''),
        // score_aggregation 落进 rawAnalysis，前端可据此展示封顶解释与封顶前后分数。
        rawAnalysis: { ...parsed, score_aggregation: cap },
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
        modelKwargs: {
            seed: 42,
        },
    });
}

async function evaluateTrajectoryDirect(
    input: TrajectoryEvalInput,
    config: ModelConfig,
    traceText: string,
    redundancySection: string,
): Promise<TrajectoryEvalOutput> {
    const model = makeDirectModel(config);
    const response = await model.invoke([
        new SystemMessage(DIRECT_EVALUATOR_SYSTEM_PROMPT),
        new HumanMessage(buildDirectUserMessage(input, traceText, redundancySection)),
    ]);
    const content = typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content);
    const parsed = parseJsonLoose(content);
    const parsedRecord = asRecord(parsed);
    if (typeof (parsedRecord.dimension_scores ?? parsedRecord.dimensionScores) === 'undefined') {
        throw new Error(`直接 LLM 评测未产出有效 JSON。模型输出前 800 字符：${content.slice(0, 800)}`);
    }
    return normalizeOutput(parsedRecord);
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
        typeof rec.dimension_scores !== 'undefined'
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
   return runWithEphemeralOpencodeServer({ user: user || undefined, verbose: false, isolateHome: true }, async (serverUrl) => {
    const config = await getActiveConfig(user);
    if (!config) {
        throw new TrajectoryEvalConfigError(
            '未配置评测模型，请先在「模型配置」中激活一个模型。',
        );
    }

    const traceSummary = summarizeTrace(input.actualInteractions);
    const traceText = formatTraceForLLM(traceSummary);

    const redundancySection = buildRedundancyDetectionPrompt(traceSummary);
    const userMsg = buildUserMessage(input, traceText, redundancySection);

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
            const normalized = normalizeOutput(parsed);
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
        const direct = await evaluateTrajectoryDirect(input, config, traceText, redundancySection);
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
