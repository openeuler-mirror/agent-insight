/**
 * 轨迹评估器（trajectory evaluator）— 评估器内部实现完全基于 Agent。
 *
 * 形态：deepagents（参考 commit 71bafc37 引入的 deepagent 范式）
 *  - 1 个主协调 agent（systemPrompt 严格规定流程）
 *  - 3 个 subagent（上下文隔离、各管一个评估维度）：
 *      completeness-checker  : 步骤完整性（覆盖参考轨迹的关键步骤？）
 *      tool-choice-judge     : 工具/Skill 选择合理性
 *      attribution-locator   : 步骤级根因定位
 *  - 1 个规则工具 detect_redundancy_and_loops：
 *      纯代码统计连续重复调用、超高频调用，避免让 LLM 数循环
 *
 * 流程：主 agent 按 prompt 指引依次调度上述 subagent + tool，
 *      最后把聚合结构 JSON 写入虚拟文件 `final_result.json`，本模块解析返回。
 *
 * 输入：单个 (case × actualTrace) 对（离线模式 = trace 已存在于 Session.interactions）。
 * 输出：dimensionScores + trajectoryScore + deviationSteps + rootCauseStep + reasonText。
 */
import { ChatOpenAI } from '@langchain/openai';
import { createDeepAgent, type SubAgent } from 'deepagents';
import { tool } from 'langchain';
import { z } from 'zod';

import { getActiveConfig, type ModelConfig } from '@/lib/storage/server-config';
import {
    formatTraceForLLM,
    summarizeTrace,
    type TraceSummary,
} from './trace-summarizer';

export interface TrajectoryEvalInput {
    caseId: string;
    caseInput: string;
    referenceOutput?: string;
    referenceTrajectory?: string;
    referenceKeyActionsText?: string;
    actualExtractedStepsText?: string;
    comparisonMode?: 'trajectory' | 'skill_key_actions';
    evaluationFocus?: string;

    actualInteractions: any[];
    taskId?: string;
    executionId?: string;
}

export interface TrajectoryDimensionScores {
    completeness: number;
    toolChoice: number;
    redundancy: number;
    attribution: number;
}

export interface TrajectoryDeviationStep {
    stepIndex: number;
    kind: string;
    name?: string;
    deviation: string;
    severity: 'low' | 'medium' | 'high';
    /**
     * 该偏差是否归因到 SKILL.md 写得不够清楚。
     *  - true：SKILL 里缺规则/示例/约束，需要进 skill 优化点
     *  - false：偏差是 agent 自身能力问题，跟 SKILL 无关，不入优化点列表
     * 评估器子代理输出；缺省（旧数据 / parse 失败）按 true 兜底，避免漏报。
     */
    isSkillAttributable?: boolean;
    /**
     * 当 isSkillAttributable=true 时，给出"应当在 SKILL.md 哪段加什么约束"的具体建议。
     * 直接喂给 skill-opt agent 作为优化输入。
     */
    improvementSuggestion?: string;
}

export interface TrajectoryEvalOutput {
    trajectoryScore: number;
    dimensionScores: TrajectoryDimensionScores;
    deviationSteps: TrajectoryDeviationStep[];
    rootCauseStep?: string;
    reasonText: string;
    rawAnalysis: any;
}

export class TrajectoryEvalConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TrajectoryEvalConfigError';
    }
}

function makeChatModel(config: ModelConfig) {
    return new ChatOpenAI({
        apiKey: config.apiKey || 'no-api-key',
        model: config.model || 'deepseek-chat',
        configuration: {
            baseURL: config.baseUrl || 'https://api.deepseek.com',
        },
        temperature: 0.1,
    });
}

function buildDetectRedundancyTool(traceSummary: TraceSummary) {
    return tool(
        async () => {
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

            return JSON.stringify({
                consecutive_same_runs: consecutiveSame,
                heavy_repeated_calls: repeatedHeavy,
                total_tool_calls: traceSummary.totalToolCalls,
                total_skill_calls: traceSummary.totalSkillCalls,
                redundancy_score: redundancyScore,
            });
        },
        {
            name: 'detect_redundancy_and_loops',
            description:
                '基于规则统计 trace 中的连续重复调用（潜在死循环）和高频重复调用。' +
                '输入无参数；返回 JSON 字符串，包含 consecutive_same_runs / heavy_repeated_calls / redundancy_score (0-1, 越高越好)。',
            schema: z.object({}),
        },
    );
}

const COMPLETENESS_CHECKER: SubAgent = {
    name: 'completeness-checker',
    description:
        '步骤完整性评估子代理。给它一段「参考轨迹」与「实际轨迹」（文本块），它会比较两者并输出 JSON：score(0-1)、missing_steps、extra_steps、explanation。',
    systemPrompt: `你是 Agent 执行轨迹「步骤完整性」评估专家。

输入会包含两段：参考轨迹 + 实际轨迹。

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

完成后简短回复"已输出 JSON"。`,
};

const TOOL_CHOICE_JUDGE: SubAgent = {
    name: 'tool-choice-judge',
    description:
        '工具选择合理性评估子代理。给它实际轨迹（必要时附参考），它会评估每步工具/Skill 选择是否合理，并输出 JSON：score、problematic_steps、explanation。',
    systemPrompt: `你是 Agent 执行轨迹「工具选择合理性」评估专家。

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

完成后简短回复"已输出 JSON"。`,
};

const ATTRIBUTION_LOCATOR: SubAgent = {
    name: 'attribution-locator',
    description:
        '步骤级根因归因子代理。综合前面两个子代理 + 规则工具的发现，定位最关键的偏离根因步骤，输出 JSON：root_cause_step、reasoning、attribution_score(0-1)。',
    systemPrompt: `你是 Agent 执行轨迹的「根因定位」专家。

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

完成后简短回复"已输出 JSON"。`,
};

const COORDINATOR_PROMPT = `你是「轨迹评估器」的总协调者。你会收到一个 (case + actual_trace + reference_trajectory) 三元组，需要协调 3 个 subagent 与 1 个规则工具，产出结构化评测结果。

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
    {"step_index": 5, "kind": "tool", "name": "bash", "deviation": "...", "severity": "low|medium|high"}
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

【聚合公式】
- trajectory_score = 0.35 * completeness + 0.30 * tool_choice + 0.15 * redundancy + 0.20 * attribution
- 各维度分数取自对应 subagent / 规则工具输出的 score 字段。

完成 write_file 后只回复一句"已写入 final_result.json"。`;

export async function evaluateTrajectory(
    input: TrajectoryEvalInput,
    user?: string | null,
): Promise<TrajectoryEvalOutput> {
    const config = await getActiveConfig(user);
    if (!config) {
        throw new TrajectoryEvalConfigError(
            '未配置评测模型，请先在「模型配置」中激活一个模型。',
        );
    }

    const model = makeChatModel(config);
    const traceSummary = summarizeTrace(input.actualInteractions);
    const traceText = formatTraceForLLM(traceSummary);

    const detectRedundancy = buildDetectRedundancyTool(traceSummary);

    const agent = createDeepAgent({
        model,
        tools: [detectRedundancy],
        subagents: [COMPLETENESS_CHECKER, TOOL_CHOICE_JUDGE, ATTRIBUTION_LOCATOR],
        systemPrompt: COORDINATOR_PROMPT,
    } as any);

    const userMsg = `# 待评估三元组

## Case
- caseId: ${input.caseId}
- input: ${input.caseInput}
- reference_output: ${input.referenceOutput || '(未提供)'}
- evaluation_focus: ${input.evaluationFocus || '(未指定)'}

## 参考轨迹 (reference_trajectory)
\`\`\`
${input.referenceTrajectory || '(未提供，按 reference_output 反推应有步骤)'}
\`\`\`

## 实际轨迹 (actual_trace, taskId=${input.taskId || 'N/A'}, executionId=${input.executionId || 'N/A'})
\`\`\`
${traceText}
\`\`\`

请按 systemPrompt 中的工作流程完成评估，并把最终结果 JSON 写入 \`final_result.json\` 文件。`;

    const finalState: any = await (agent as any).invoke(
        { messages: [{ role: 'user', content: userMsg }] },
        { recursionLimit: 60 },
    );

    const files = (finalState && (finalState.files || finalState.state?.files)) || {};
    const fileEntry = files['final_result.json'] || files['/final_result.json'];
    if (!fileEntry) {
        const lastMsg = finalState?.messages?.[finalState.messages.length - 1];
        const lastContent = typeof lastMsg?.content === 'string'
            ? lastMsg.content
            : JSON.stringify(lastMsg?.content);
        throw new Error(
            `轨迹评估器未产出 final_result.json。Agent 最后输出: ${(lastContent || '').slice(0, 800)}`,
        );
    }

    const content = Array.isArray(fileEntry.content)
        ? fileEntry.content.join('\n')
        : String(fileEntry.content);

    const parsed = parseJsonLoose(content);
    if (!parsed) {
        throw new Error(
            `无法解析 final_result.json，原始内容前 800 字符：${content.slice(0, 800)}`,
        );
    }

    const dim = parsed.dimension_scores || parsed.dimensionScores || {};
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
              .filter((d: any) => d && typeof d === 'object')
              .map((d: any) => ({
                  stepIndex: Number(d.step_index ?? d.stepIndex ?? -1),
                  kind: String(d.kind || ''),
                  name: d.name ? String(d.name) : undefined,
                  deviation: String(d.deviation || d.description || ''),
                  severity: normalizeSeverity(d.severity),
              }))
        : [];

    return {
        trajectoryScore,
        dimensionScores,
        deviationSteps,
        rootCauseStep: parsed.root_cause_step || parsed.rootCauseStep || undefined,
        reasonText: String(parsed.reason_text || parsed.reasonText || ''),
        rawAnalysis: parsed,
    };
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

function parseJsonLoose(s: string): any | null {
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
