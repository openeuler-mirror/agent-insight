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
 *  - LLM 维度评估：
 *      completeness-checker  : 步骤完整性
 *      tool-choice-judge     : 工具/Skill 选择合理性
 *      attribution-locator   : 步骤级根因定位
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
import { tagOpencodeSession } from '@/lib/internal-agent-tag';
import { findSystemAgentDefinition, getSystemAgentId } from '@/lib/system-agents';

import {
    type TrajectoryEvalInput,
    type TrajectoryEvalOutput,
    type TrajectoryDimensionScores,
    type TrajectoryDeviationStep,
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

const COORDINATOR_SYSTEM_PROMPT = `你是「轨迹评估器」的总协调者。你会收到一个 (case + actual_trace + reference_trajectory) 三元组，必要时还会带 reference_key_actions 与 actual_extracted_steps，需要协调 3 个 subagent 与 1 个规则工具，产出结构化评测结果。

【比较模式】
- 当 comparison_mode = trajectory 时：按 reference_trajectory 和 actual_trace 做常规轨迹对比。
- 当 comparison_mode = skill_key_actions 时：优先按 reference_key_actions 和 actual_extracted_steps 做关键步骤覆盖/偏离分析，再结合 actual_trace 判断工具选择与根因。

【必须遵循的工作流程】
1. **不要自己直接评估**，所有评估都通过 subagent 或 tool 完成。
2. 步骤 1：调用 \`detect_redundancy_and_loops\` 工具拿到规则检测结果（死循环 / 重复调用 / redundancy_score）。
3. 步骤 2：用 \`task\` 工具派发给 \`completeness-checker\`，把「参考轨迹」和「实际轨迹」原样转交，让它输出 JSON 完整性评估。
4. 步骤 3：用 \`task\` 工具派发给 \`tool-choice-judge\`，把「实际轨迹」（必要时附参考）转交，让它输出 JSON 工具选择评估。
5. 步骤 4：把 redundancy + completeness + tool-choice 的发现综合起来，用 \`task\` 工具派发给 \`attribution-locator\`，让它定位 root cause。
6. 步骤 5：把所有结果聚合成下面**严格的 JSON**，用 \`write_file\` 工具写入文件路径 \`final_result.json\`：

\`\`\`json
{
  "trajectory_score": 0.0,
  "dimension_scores": {
    "completeness": 0.0,
    "tool_choice": 0.0,
    "redundancy": 0.0,
    "attribution": 0.0
  },
  "deviation_steps": [
    {
      "step_index": 5,
      "kind": "tool",
      "name": "bash",
      "deviation": "...",
      "severity": "low|medium|high",
      "is_skill_attributable": true,
      "improvement_suggestion": "在 SKILL.md 的 X 章节明确：执行 bash 前先 ..."
    }
  ],
  "root_cause_step": "step#5: bash",
  "reason_text": "(中文 markdown 综述, 200-400 字)",
  "raw_subagent_outputs": {
    "redundancy": {},
    "completeness": {},
    "tool_choice": {},
    "attribution": {}
  }
}
\`\`\`

【关键观点 - 关于 deviation_steps 的两个新字段】
- is_skill_attributable：判断这条偏差是否由"SKILL.md 写得不够清楚"导致。
  · true  → SKILL 缺关键规则/示例/前置约束，需要补 SKILL 内容
  · false → 偏差是 agent 自身推理 / 模型能力问题，写再多 SKILL 也避免不了
  · 判断方法：reread SKILL 文本，问自己"如果在 SKILL 里加一段明确指令，agent 还会犯这个错吗？"
- improvement_suggestion：仅当 is_skill_attributable=true 时填，**写到具体小节级别**：
  "在 SKILL.md 的 'Step 2: 数据收集' 章节加一段：「在 dmesg 之前先采集 journalctl + iotop 时间序列，避免遗漏 IO 压力线索」"。不要写空话。
- 即使是 low severity，只要确实跟 skill 相关也要标 is_skill_attributable=true（severity 是问题严重度，is_skill_attributable 是归因维度，两者独立）。

【聚合公式】
- trajectory_score = 0.35 * completeness + 0.30 * tool_choice + 0.15 * redundancy + 0.20 * attribution
- 各维度分数取自对应 subagent / 规则工具输出的 score 字段。

完成 write_file 后只回复一句"已写入 final_result.json"。`;

const COMPLETENESS_CHECKER_PROMPT = `你是 Agent 执行轨迹「步骤完整性」评估专家。

输入会包含两种之一：
- 常规模式：参考轨迹 + 实际轨迹
- 关键步骤模式：参考关键步骤 + 实际提取关键步骤

任务：
1. 找出参考轨迹中**应有但实际没执行**的步骤（missing_steps）。
2. 找出实际轨迹中**多余、参考里没有**的步骤（extra_steps）。
3. 给出综合完整性评分：0.0（完全偏离）～ 1.0（完全覆盖）。

只输出**严格 JSON**（包在 \`\`\`json 代码块里）：

\`\`\`json
{
  "score": 0.85,
  "missing_steps": [
    {"description": "参考要求先 grep 关键字再分析，但实际跳过了", "severity": "high"}
  ],
  "extra_steps": [
    {"step_index": 5, "description": "重复调用了 ls", "severity": "low"}
  ],
  "explanation": "..."
}
\`\`\`

完成后简短回复"已输出 JSON"。`;

const TOOL_CHOICE_JUDGE_PROMPT = `你是 Agent 执行轨迹「工具选择合理性」评估专家。

任务：审视实际轨迹中每个 tool / skill 调用，判断：
- 在当前上下文下，是否选了合适的工具？
- 工具的参数是否合理？
- 是否存在错用工具（例如本该用 grep 却用 ls）？

只输出**严格 JSON**（包在 \`\`\`json 代码块里）：

\`\`\`json
{
  "score": 0.78,
  "problematic_steps": [
    {"step_index": 3, "name": "bash", "issue": "...", "severity": "medium"}
  ],
  "explanation": "..."
}
\`\`\`

完成后简短回复"已输出 JSON"。`;

const ATTRIBUTION_LOCATOR_PROMPT = `你是 Agent 执行轨迹的「根因定位」专家。

输入：完整三元组 + 前面 subagent / 规则工具的发现。

任务：在所有候选偏离中，挑出**最关键**的那一步（导致整段执行偏离参考轨迹的"罪魁祸首"），并给出清晰归因。如果没有显著偏离，可以返回 root_cause_step = null。

只输出**严格 JSON**（包在 \`\`\`json 代码块里）：

\`\`\`json
{
  "root_cause_step": "step#5: bash",
  "reasoning": "在第 5 步 bash 调用时使用了 ls 而非 grep，导致后续步骤无法定位错误日志",
  "attribution_score": 1.0
}
\`\`\`

attribution_score 含义：1.0 = 根因明确且单一；0.5 = 多个候选难分主次；0.0 = 完全归因不出来。

完成后简短回复"已输出 JSON"。`;

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

请按 systemPrompt 中的工作流程完成评估，并把最终结果 JSON 写入 \`final_result.json\` 文件。

注意：冗余检测已由规则工具完成，结果已在上方提供。请直接使用该 redundancy_score，
然后依次派发 completeness-checker、tool-choice-judge、attribution-locator 三个子代理。`;
}

const DIRECT_EVALUATOR_SYSTEM_PROMPT = `你是 Skill Insight 的预置评估器「trace-quality-evaluator」。

你会收到一个 (case + actual_trace + reference_trajectory) 三元组，以及已经由规则代码计算好的冗余检测结果。
请评估执行轨迹相对参考轨迹/参考答案的质量，并只输出严格 JSON，不要输出 Markdown 代码块或额外解释。

JSON 结构必须为：
{
  "trajectory_score": 0.0,
  "dimension_scores": {
    "completeness": 0.0,
    "tool_choice": 0.0,
    "redundancy": 0.0,
    "attribution": 0.0
  },
  "deviation_steps": [
    {
      "step_index": 5,
      "kind": "tool",
      "name": "bash",
      "deviation": "...",
      "severity": "low|medium|high",
      "is_skill_attributable": true,
      "improvement_suggestion": "在 SKILL.md 哪段加什么约束（具体到小节，仅 is_skill_attributable=true 时填）"
    }
  ],
  "root_cause_step": "step#5: bash",
  "reason_text": "中文 markdown 综述，说明主要偏离与分数原因",
  "raw_subagent_outputs": {
    "redundancy": {},
    "completeness": {},
    "tool_choice": {},
    "attribution": {}
  }
}

评分说明：
- completeness：参考轨迹/参考答案关键步骤覆盖度。
- tool_choice：工具、Skill 或操作选择是否合理。
- redundancy：直接采用输入中的 redundancy_score。
- attribution：是否能明确定位最关键偏离步骤。
- trajectory_score = 0.35 * completeness + 0.30 * tool_choice + 0.15 * redundancy + 0.20 * attribution。
所有分数必须在 0.0 到 1.0 之间。`;

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
        attribution: clamp01(toNumber(dim.attribution)),
    };

    const trajectoryScoreRaw = toNumber(parsed.trajectory_score ?? parsed.trajectoryScore);
    const trajectoryScore = Number.isFinite(trajectoryScoreRaw)
        ? clamp01(trajectoryScoreRaw)
        : clamp01(
              0.35 * dimensionScores.completeness +
                  0.3 * dimensionScores.toolChoice +
                  0.15 * dimensionScores.redundancy +
                  0.2 * dimensionScores.attribution,
          );

    const deviationsRaw = parsed.deviation_steps || parsed.deviationSteps || [];
    const deviationSteps: TrajectoryDeviationStep[] = Array.isArray(deviationsRaw)
        ? deviationsRaw
              .map(asRecord)
              .filter(d => Object.keys(d).length > 0)
              .map(d => {
                  // is_skill_attributable 缺省（旧评测数据 / 子代理漏字段）按 true 兜底，
                  // 避免漏报；用户在 skill-opt 页可以手动忽略。
                  const skillAttr = d.is_skill_attributable ?? d.isSkillAttributable;
                  const suggestion = String(d.improvement_suggestion ?? d.improvementSuggestion ?? '').trim();
                  return {
                      stepIndex: Number(d.step_index ?? d.stepIndex ?? -1),
                      kind: String(d.kind || ''),
                      name: d.name ? String(d.name) : undefined,
                      deviation: String(d.deviation || d.description || ''),
                      severity: normalizeSeverity(d.severity),
                      isSkillAttributable: skillAttr === false ? false : true,
                      improvementSuggestion: suggestion || undefined,
                  };
              })
        : [];

    return {
        trajectoryScore,
        dimensionScores,
        deviationSteps,
        rootCauseStep: (typeof parsed.root_cause_step === 'string' ? parsed.root_cause_step : (typeof parsed.rootCauseStep === 'string' ? parsed.rootCauseStep : undefined)),
        reasonText: String(parsed.reason_text || parsed.reasonText || ''),
        rawAnalysis: parsed,
    };
}

function makeDirectModel(config: ModelConfig) {
    return new ChatOpenAI({
        apiKey: config.apiKey || 'no-api-key',
        model: config.model || 'deepseek-chat',
        configuration: {
            baseURL: config.baseUrl || 'https://api.deepseek.com',
        },
        temperature: 0.1,
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
    if (typeof (parsedRecord.trajectory_score ?? parsedRecord.trajectoryScore) === 'undefined') {
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
    const jsonBlockMatch = fullText.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlockMatch) {
        const parsed = parseJsonLoose(jsonBlockMatch[1]);
        const parsedRecord = asRecord(parsed);
        if (typeof parsedRecord.trajectory_score !== 'undefined') return parsedRecord;
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
   return runWithEphemeralOpencodeServer({ user: user || undefined, verbose: false }, async (serverUrl) => {
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
        system: COORDINATOR_SYSTEM_PROMPT,
        permission: permissions,
    };

    let fullText = '';
    let runtimeError: Error | null = null;
    let evaluatorSessionId = '';
    const handlers: ChatHandlers = {
        onText: (e) => {
            fullText += e.delta;
        },
        onError: (e) => {
            runtimeError = e;
        },
        onSubagent: (e) => {
            console.log(`[opencode-trajectory-eval] subagent ${e.agent}: phase=${e.phase}`);
        },
        onTool: (e) => {
            console.log(`[opencode-trajectory-eval] tool ${e.name}: phase=${e.phase}`);
        },
    };

    try {
        // serverUrl 由外层 runWithEphemeralOpencodeServer 注入 —— per-task 新进程,跑完自动杀
        const insight = new AgentInsight({
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
    completenessChecker: COMPLETENESS_CHECKER_PROMPT,
    toolChoiceJudge: TOOL_CHOICE_JUDGE_PROMPT,
    attributionLocator: ATTRIBUTION_LOCATOR_PROMPT,
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
        description: 'Agent 轨迹质量评估器 — 基于 opencode 多 subagent 协作（completeness / tool-choice / attribution + 规则冗余检测）',
    },
    {
        id: 'completeness-checker',
        name: 'completeness-checker',
        ownership: 'system' as const,
        layer: 'subagent' as const,
        platform: 'opencode' as const,
        version: 'v1.0',
        framework: 'opencode',
        status: 'running' as const,
        successRate: '—',
        todayCalls: '—',
        lastExecutedAt: new Date().toISOString(),
        parentAgent: 'trace-quality-evaluator',
        description: '步骤完整性评估子代理 — 比较参考轨迹与实际轨迹，评估步骤覆盖度',
    },
    {
        id: 'tool-choice-judge',
        name: 'tool-choice-judge',
        ownership: 'system' as const,
        layer: 'subagent' as const,
        platform: 'opencode' as const,
        version: 'v1.0',
        framework: 'opencode',
        status: 'running' as const,
        successRate: '—',
        todayCalls: '—',
        lastExecutedAt: new Date().toISOString(),
        parentAgent: 'trace-quality-evaluator',
        description: '工具选择合理性评估子代理 — 评估每步工具/Skill 选择是否合理',
    },
    {
        id: 'attribution-locator',
        name: 'attribution-locator',
        ownership: 'system' as const,
        layer: 'subagent' as const,
        platform: 'opencode' as const,
        version: 'v1.0',
        framework: 'opencode',
        status: 'running' as const,
        successRate: '—',
        todayCalls: '—',
        lastExecutedAt: new Date().toISOString(),
        parentAgent: 'trace-quality-evaluator',
        description: '步骤级根因归因子代理 — 定位最关键的偏离根因步骤',
    },
];
