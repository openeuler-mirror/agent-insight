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

const COORDINATOR_SYSTEM_PROMPT = `你是 Skill Insight 的「轨迹质量评估器」。你会收到一个 (case + actual_trace + reference_trajectory) 三元组，必要时还会带 reference_key_actions 与 actual_extracted_steps，以及已由规则代码计算好的冗余检测结果。

请按下面 5 个步骤完成内部分析，但最终只输出 JSON。不要输出步骤过程、Markdown、解释性前言或额外文本。

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
- \`dimension_scores.attribution\` 必须等于 \`dimension_details.attribution.attribution_score\`。
- \`trajectory_score\` 必须按公式计算，可四舍五入到 3 位小数。

【内部分析步骤】
Step 1：冗余分析
- 直接采用输入中已计算好的 redundancy_score。
- 把规则检测结果摘要写入 \`dimension_details.redundancy\`。

Step 2：完整性分析
- comparison_mode = trajectory 时，对比 reference_trajectory 与 actual_trace。
- comparison_mode = skill_key_actions 时，优先对比 reference_key_actions 与 actual_extracted_steps。
- 列出 missing_steps（应有但未执行）和 extra_steps（多余或明显绕路）。
- 给出 completeness 评分。

Step 3：工具选择分析
- 逐步检查 actual_trace 中每个 tool / skill 调用。
- 判断工具选择、参数、调用时机是否合理。
- 列出 problematic_steps。
- 给出 tool_choice 评分。

Step 4：根因定位与 Skill 归因
- 综合完整性与工具选择发现，定位最关键的偏离步骤；没有显著偏离时 root_cause_step 为 null。
- 对每个 deviation_step 判断 is_skill_attributable：
  · true：如果在 SKILL.md 增加明确规则、示例或前置约束，能显著降低这个错误复现概率。
  · false：偏差主要来自 agent 自身推理、模型能力、外部环境或一次性执行波动。
- 仅当 is_skill_attributable=true 时，给出具体到 SKILL.md 小节级别的 improvement_suggestion。
- attribution 评分只表示根因是否明确、证据是否充分；不要把它当作 Skill 可归因比例。

Step 5：聚合输出
- trajectory_score = 0.35 * completeness + 0.30 * tool_choice + 0.15 * redundancy + 0.20 * attribution。
- 只输出下面 schema 对应的严格 JSON：

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
      "missing_steps": [],
      "extra_steps": [],
      "explanation": "..."
    },
    "tool_choice": {
      "score": 0.78,
      "problematic_steps": [],
      "explanation": "..."
    },
    "attribution": {
      "root_cause_step": "step#5: bash",
      "reasoning": "...",
      "attribution_score": 1.0
    }
  }
}
\`\`\`

【关于 dimension_details 字段】
- redundancy 放规则检测结果摘要。
- completeness / tool_choice / attribution 分别放 3 个维度的结构化分析，供前端与 skill-opt 直接消费。

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
