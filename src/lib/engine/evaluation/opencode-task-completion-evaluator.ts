import {
    AgentInsight,
    type SendPromptPayload,
    type ChatHandlers,
} from '@/lib/engine/skill-generation/opencode-agent-cli/opencode-client';
import { runWithEphemeralOpencodeServer } from '@/lib/engine/skill-generation/opencode-agent-cli/opencode-manager';
import { withBackgroundOpencodeSlot } from '@/lib/engine/general-agent/concurrency-limiter';
import { buildEvaluatorPermissions } from '@/lib/engine/general-agent/workspace';
import { getActiveConfig, type ModelConfig } from '@/lib/storage/server-config';
import {
    inferProviderFromBaseUrl,
    loadServerModelForUser,
    normalizeProviderID,
} from '@/lib/engine/general-agent/server-model-config';
import { tagOpencodeSession } from '@/lib/internal-agent-tag';
import { findSystemAgentDefinition, getSystemAgentId } from '@/lib/system-agents';
import { type RootCauseItem } from '@/lib/dataset-case-root-causes';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { randomUUID } from 'node:crypto';
import {
    recordDirectEvaluatorExecution,
    recordEvaluatorExecution,
    shouldForceOpencodeEvalTransport,
} from './evaluator-execution-recorder';
import { extractRootCausesFromExpected } from './root-cause-extractor';
import {
    deriveTaskCompletionScoreFromFindings,
    stripSkillAttributionFromKeyPointFindings,
} from './task-completion-scoring';
import { normalizeResultIssues, parseLooseJson } from './task-completion-json';

export interface TaskCompletionEvalInput {
    caseInput: string;
    expectedOutput: string;
    actualOutput: string;
    precomputedRootCauses?: RootCauseItem[];
    precomputedRootCauseSource?: 'dataset-cache' | 'none';
    traceSummaryText?: string;
    skillAttributionMode?: 'skill-aware' | 'no-skill';
    skillContext?: {
        invokedSkills?: Array<{
            name: string;
            version?: number | null;
            content?: string;
        }>;
    };
}

export interface TaskCompletionEvalOutput {
    isCorrect: boolean;
    score: number;
    reason: string;
    rawAnalysis?: Record<string, unknown>;
}

const TASK_COMPLETION_EVALUATOR_NAME = 'task-completion-evaluator';
const OPENCODE_FALLBACK_AGENT_NAME = 'build';

function buildCoordinatorSystemPrompt(mode: NonNullable<TaskCompletionEvalInput['skillAttributionMode']>): string {
    const skillBranch = mode === 'skill-aware'
        ? `【Skill 归因分支】
本 trace 关联了 Skill。你会收到真实的 Skill 上下文，必须基于该 SKILL.md 内容判断每条未覆盖 / 部分覆盖 / 错误覆盖的关键观点是否可通过修改 Skill 降低复现概率。
- 如果可归因到 Skill，输出 is_skill_attributable=true，并给出 attribution_reason 与 improvement_suggestion。
- improvement_suggestion 必须具体到"在 SKILL.md 的哪类流程、规则、检查清单、输出约束或反例约束中补什么"。
- 如果主要不是 Skill 文档能解决的问题，输出 is_skill_attributable=false，attribution_reason 简述原因，improvement_suggestion 置空。`
        : `【无 Skill 分支】
本 trace 未关联任何 Skill。本次结果评测只评估任务完成度、关键观点覆盖情况和 trace 根因定位。
- 禁止输出有效的 Skill 归因和 Skill 改进建议。
- 每条 key_point_findings 必须设置 is_skill_attributable=false。
- attribution_reason 必须为空字符串。
- improvement_suggestion 必须为空字符串。`;

    return `你是「Agent 任务完成度 + 关键观点根因分析」评估器。你会收到用户输入、预期结果、实际输出、从标准答案中提取的关键观点、压缩执行轨迹 Trace Summary，以及可选的 Skill 上下文。

【必须遵循的工作流程】
1. 你必须自己逐条检查每个关键观点是否被实际输出覆盖，不要跳过任何一条。
2. 禁止派发、调用或生成任何 subagent / task；本次评测只能由你这个主评估器独立完成。
3. 综合预期结果、实际输出、关键观点覆盖情况，判断任务完成度。
4. 原因 reason 是**给人看的一句话结论**，界面上默认只展示它、明细全部折叠，所以它必须能独立说清问题：
   - 说人话，不要用"覆盖率/维度/评分点/整体完成度偏低"这类评测术语，就当是在跟同事口头汇报；
   - 先说任务到底成没成，再说卡在哪；问题只挑最要命的一条讲，不要把每个关键观点逐条塞进来（那些进 key_point_findings）；
   - 讲具体的东西（少了哪个数、答错成什么、漏了哪一步），不要"不够完整""质量欠佳"这种空话；
   - ≤80 字，不要复述任务描述，不要解释你的打分过程。
   反例：「关键观点覆盖率偏低，多个维度未达标，整体任务完成度不足。」——等于什么都没说。
   正例：「攻击类型判对了，但没给出来源 IP，也漏了 root 爆破次数，运维拿着没法直接处置。」
5. 把关键观点覆盖情况、覆盖依据、未覆盖根因放进独立字段 key_point_findings，供前端单独展示。
6. 只输出严格 JSON，不要输出 Markdown 或额外解释：

{
  "score": 0.86,
  "is_correct": true,
  "reason": "一句话中文结论，说人话、讲具体问题，≤80 字（见工作流程第 4 条）。",
  "key_point_findings": [
    {
      "content": "...",
      "score": 0.85,
      "covered": true,
      "coverage_status": "covered|partial|missing|wrong",
      "severity": "low|medium|high",
      "explanation": "...",
      "coverage_reason": "covered=true 时说明实际输出如何覆盖该观点；否则为空",
      "missing_reason": "未覆盖/部分覆盖/错误覆盖时说明最终输出缺了什么或错了什么；否则为空",
      "evidence": {
        "actual": "实际输出中的相关片段，没有则为空",
        "expected": "预期结果中的相关片段，没有则为空"
      },
      "trace_root_cause": {
        "failure_stage": "evidence_collection|tool_usage|reasoning|final_answer|model_or_environment|unknown",
        "failure_reason": "结合压缩轨迹说明问题发生原因；无证据时说明无法定位",
        "related_steps": [
          {
            "step_index": 5,
            "kind": "tool",
            "name": "read",
            "evidence": "该步骤与问题相关的简短证据"
          }
        ]
      },
      "is_skill_attributable": false,
      "attribution_reason": "为什么这个问题可/不可通过修改 Skill 降低复现概率",
      "improvement_suggestion": "仅当 is_skill_attributable=true 时填，写到 SKILL.md 具体小节级"
    }
  ],
  "key_point_summary": "中文总结关键观点整体覆盖情况",
  "result_issues": [
    {
      "kind": "incorrect_fact|extra_content|verbosity|format|other",
      "summary": "一句话描述这个【不对应任何预期关键观点、但实际输出自身存在】的结果层问题",
      "severity": "low|medium|high",
      "is_skill_attributable": false,
      "attribution_reason": "为什么这个问题可/不可通过修改 Skill 降低复现概率",
      "improvement_suggestion": "仅当 is_skill_attributable=true 时填，具体到 SKILL.md 小节 / scripts 文件级"
    }
  ]
}

【评分规则】
- 每条关键观点都必须输出显式 score，范围 0.0～1.0，可连续取值。
- 顶层 score 只作为参考输出；系统会按 key_point_findings[].score 做等权平均，重算最终任务完成度分数。
- 不要隐含权重；每个关键观点的权重完全相同。

【内部分析步骤】
你必须按以下步骤进行内部分析，但不要输出完整 Chain-of-Thought：
Step 1. 对比 expectedOutput 与 actualOutput，判断整体任务完成度。
Step 2. 对每条关键观点，判断 actualOutput 是否覆盖。
Step 3. 对每条关键观点给出显式 score（0.0～1.0），要求与 coverage_status、证据、解释保持一致。
Step 4. 如果 covered=true，给出 coverage_reason，并在 evidence.actual 中摘录实际输出中的覆盖依据。
Step 5. 如果 covered=false 或 coverage_status 不为 covered，说明最终输出缺了什么或错了什么。
Step 6. 查看 Trace Summary，判断问题发生阶段：
- evidence_collection：证据收集不足，如没读到关键文件、关键区域、关键日志。
- tool_usage：工具选择、参数、顺序或补救策略有问题。
- reasoning：trace 中已有证据，但推理归纳错了。
- final_answer：trace 中已有正确分析，但最终输出漏写或组织错误。
- model_or_environment：主要来自模型能力、外部环境、工具失败等，难以通过 Skill 修复。
- unknown：压缩轨迹中没有足够证据定位。
Step 7. 按下方 Skill 归因分支要求填写 is_skill_attributable / attribution_reason / improvement_suggestion。
Step 8. 单独检查【不对应任何预期关键观点、但实际输出自身就有】的结果层问题，逐条放进 result_issues：
- incorrect_fact：实际输出里与证据/事实矛盾的系统性错误（如时间/年份、数量、IP 等算错或写错）。
- extra_content：实际输出**编造**了预期结果与证据中都不存在的内容（如凭空多出的来源 IP、事件）——这类"多出来的错"不会体现在关键观点覆盖里，必须靠 result_issues 抓。
- verbosity / format / other：明显冗余或格式问题（保守判定，拿不准就不报）。
没有这类问题时 result_issues 输出空数组 []；每条按下方 Skill 归因分支规则填 is_skill_attributable / attribution_reason / improvement_suggestion。

${skillBranch}

【重要约束】
- result_issues 只装"关键观点覆盖之外"的结果层问题（事实错 / 编造 / 冗余）；已在 key_point_findings 里报过的覆盖问题不要重复塞进 result_issues。
- 不要编造 trace 证据。Trace Summary 中找不到证据时，related_steps 为空，failure_stage 使用 "unknown"。
- 每条关键观点都必须输出一条 key_point_findings。
- 每条关键观点都必须输出显式 score，范围 0.0～1.0。
- covered=true 的关键观点必须给 coverage_reason。
- covered=false / partial / wrong 的关键观点必须给 missing_reason、trace_root_cause.failure_stage、trace_root_cause.failure_reason。
`;
}

function clampTaskScore(value: unknown): number {
    const score = typeof value === 'number'
        ? value
        : typeof value === 'string'
        ? Number(value)
        : NaN;
    if (!Number.isFinite(score)) return 0;
    return Math.max(0, Math.min(1, score));
}

function tryNormalizeFromTexts(
    mode: NonNullable<TaskCompletionEvalInput['skillAttributionMode']>,
    ...texts: Array<string | null | undefined>
): TaskCompletionEvalOutput | null {
    for (const text of texts) {
        const parsed = parseLooseJson(String(text || ''));
        if (parsed && isTaskCompletionPayload(parsed)) return normalizeOutput(parsed, mode);
    }
    return null;
}

function resolveProviderID(config: ModelConfig): string {
    return normalizeProviderID(config.provider || inferProviderFromBaseUrl(config.baseUrl));
}

function isTaskCompletionPayload(parsed: Record<string, unknown>): boolean {
    if (typeof parsed.score !== 'undefined') return true;
    if (typeof parsed.is_correct !== 'undefined') return true;
    if (Array.isArray(parsed.key_point_findings)) return true;
    return false;
}

async function resolveRootCauses(
    input: TaskCompletionEvalInput,
    user?: string | null,
): Promise<{ rootCauses: RootCauseItem[]; source: 'dataset-cache' | 'live-extract' | 'none' }> {
    if (input.precomputedRootCauseSource === 'none') {
        return { rootCauses: [], source: 'none' };
    }
    if (input.precomputedRootCauseSource === 'dataset-cache') {
        return {
            rootCauses: Array.isArray(input.precomputedRootCauses) ? input.precomputedRootCauses : [],
            source: 'dataset-cache',
        };
    }
    if (!String(input.expectedOutput || '').trim()) {
        return { rootCauses: [], source: 'none' };
    }
    try {
        return {
            rootCauses: await extractRootCausesFromExpected(input.caseInput, input.expectedOutput, user),
            source: 'live-extract',
        };
    } catch {
        return { rootCauses: [], source: 'none' };
    }
}

function buildUserMessage(input: TaskCompletionEvalInput, rootCauses: RootCauseItem[]): string {
    const keyPointsText = rootCauses.length > 0
        ? rootCauses.map((item, index) => `${index + 1}. ${item.content}`).join('\n')
        : '（未提取到关键观点，可仅按任务完成度评判）';
    const skillContextText = formatSkillContext(input.skillContext);

    return [
        '# Agent 任务完成度评测输入',
        '',
        `## Skill 归因模式\n${input.skillAttributionMode === 'skill-aware'
            ? 'skill-aware：本 trace 关联了 Skill，允许基于 Skill 上下文输出 Skill 归因和改进建议。'
            : 'no-skill：本 trace 未关联任何 Skill，禁止输出 Skill 归因和 Skill 改进建议。'}`,
        '',
        `## 用户输入\n${input.caseInput}`,
        '',
        `## 预期结果\n${input.expectedOutput}`,
        '',
        `## 实际输出\n${input.actualOutput}`,
        '',
        `## 关键观点\n${keyPointsText}`,
        '',
        `## 压缩执行轨迹\n${input.traceSummaryText?.trim() || '（无可用轨迹）'}`,
        '',
        `## Skill 上下文\n${skillContextText}`,
        '',
        '请你自行逐条检查关键观点覆盖情况，并在不派发任何子代理的前提下完成任务完成度评测和关键观点根因分析。',
    ].join('\n');
}

function formatSkillContext(skillContext: TaskCompletionEvalInput['skillContext']): string {
    const skills = Array.isArray(skillContext?.invokedSkills) ? skillContext.invokedSkills : [];
    if (skills.length === 0) return '（无）';
    return skills.map((skill, index) => [
        `### Skill ${index + 1}: ${skill.name}${skill.version != null ? ` v${skill.version}` : ''}`,
        skill.content?.trim() || '（无 SKILL.md 内容）',
    ].join('\n')).join('\n\n');
}

function normalizeOutput(
    parsed: Record<string, unknown>,
    mode: NonNullable<TaskCompletionEvalInput['skillAttributionMode']> = 'skill-aware',
): TaskCompletionEvalOutput {
    const parsedForScoring = mode === 'no-skill'
        ? {
            ...parsed,
            key_point_findings: stripSkillAttributionFromKeyPointFindings(parsed.key_point_findings),
        }
        : parsed;
    const scoreSummary = deriveTaskCompletionScoreFromFindings(parsedForScoring.key_point_findings);
    // deriveTaskCompletionScoreFromFindings 类型上 score 为 number|null, 但实现里 findings 为空会直接 throw,
    // 非空时必返回 clamp 过的数字 —— 实际不会到 null。?? 0 仅为满足类型 + 万一为 null 时按 0 分(不达标)兜底。
    const score = scoreSummary.score ?? 0;
    const isCorrect = score >= 0.8;
    const reason = String(parsed.reason || '').trim() || '任务完成度评测已完成，但未返回理由。';
    const llmReportedScore = typeof parsed.score === 'undefined' ? undefined : clampTaskScore(parsed.score);
    const { result_issues: rawResultIssues, resultIssues: rawResultIssuesCamel, ...rest } = parsedForScoring;
    const resultIssues = normalizeResultIssues(rawResultIssues ?? rawResultIssuesCamel, mode);
    return {
        isCorrect,
        score,
        reason,
        rawAnalysis: {
            ...rest,
            score,
            is_correct: isCorrect,
            llm_reported_score: llmReportedScore,
            score_computation: {
                method: 'equal_weight_average',
                item_count: scoreSummary.itemCount,
            },
            skillAttributionMode: mode,
            result_issues: resultIssues,
            key_point_findings: scoreSummary.findings,
        },
    };
}

function makeDirectModel(config: ModelConfig) {
    return new ChatOpenAI({
        apiKey: config.apiKey || 'no-api-key',
        model: config.model || 'deepseek-chat',
        configuration: {
            baseURL: config.baseUrl || 'https://api.deepseek.com',
            defaultHeaders: config.headers,
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
 * 直连 LLM 任务完成度评测（primary path）：一次 model.invoke 拿到 JSON，正常解析后把这次 judge
 * 合成成一条 trace 落库。system prompt / 模型参数(temperature 0, seed 42) 与 opencode 路径完全一致，
 * 只是省掉了起进程 + session 往返。
 */
async function evaluateTaskCompletionDirectAndRecord(
    input: TaskCompletionEvalInput,
    config: ModelConfig,
    rootCauses: RootCauseItem[],
    rootCauseSource: 'dataset-cache' | 'live-extract' | 'none',
    user?: string | null,
): Promise<TaskCompletionEvalOutput> {
    const model = makeDirectModel(config);
    const userMsg = buildUserMessage(input, rootCauses);
    const systemPrompt = buildCoordinatorSystemPrompt(input.skillAttributionMode || 'skill-aware');
    const startedAt = new Date();
    const response = await model.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(userMsg),
    ]);
    const completedAt = new Date();
    const assistantText = typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content);
    const parsed = parseLooseJson(assistantText);
    if (!parsed || !isTaskCompletionPayload(parsed)) {
        throw new Error(`任务完成度直接 LLM 评测未产出有效 JSON。模型输出前 800 字符：${assistantText.slice(0, 800)}`);
    }
    const normalized = normalizeOutput(parsed, input.skillAttributionMode || 'skill-aware');
    const evaluatorSessionId = `${TASK_COMPLETION_EVALUATOR_NAME}-${randomUUID()}`;
    const def = findSystemAgentDefinition('opencode', TASK_COMPLETION_EVALUATOR_NAME);
    await recordDirectEvaluatorExecution({
        taskId: evaluatorSessionId,
        agentName: TASK_COMPLETION_EVALUATOR_NAME,
        user,
        query: input.caseInput,
        systemPrompt,
        userMessage: userMsg,
        assistantOutput: assistantText,
        usage: extractLangchainUsage(response),
        modelID: config.model,
        skill: def?.traceSkill ?? null,
        startedAtISO: startedAt.toISOString(),
        completedAtISO: completedAt.toISOString(),
    }).catch((err) => {
        console.warn('[opencode-task-completion] failed to record direct evaluator trace:', (err as Error)?.message || err);
    });
    return {
        ...normalized,
        rawAnalysis: {
            ...(normalized.rawAnalysis || {}),
            evaluatorSessionId,
            root_cause_source: rootCauseSource,
        },
    };
}

export async function evaluateTaskCompletionViaOpencode(
    input: TaskCompletionEvalInput,
    user?: string | null,
    skillName?: string | null,    // 透传给 limiter,让"后台分析任务"按 skill 严格过滤
    skillVersion?: number | null, // skill 版本号,展示用
): Promise<TaskCompletionEvalOutput> {
  return withBackgroundOpencodeSlot(async () => {
   // PRIMARY: 直连 LLM 单轮 judge —— 不起 opencode 进程、不建 session（省 ~1.6s 固定开销/次）。
   // 评测 trace 由 recordDirectEvaluatorExecution 合成落库。EVAL_FORCE_OPENCODE_TRANSPORT=1 回退旧路径。
   if (!shouldForceOpencodeEvalTransport()) {
     const { rootCauses, source: rootCauseSource } = await resolveRootCauses(input, user);
     const directConfig = await getActiveConfig(user);
     if (!directConfig) {
       return {
         isCorrect: false,
         score: 0,
         reason: '请先在模型配置中激活一个评测模型，才能执行结果评测。',
         rawAnalysis: { root_cause_source: rootCauseSource },
       };
     }
     try {
       return await evaluateTaskCompletionDirectAndRecord(input, directConfig, rootCauses, rootCauseSource, user);
     } catch (directErr) {
       console.warn(
         '[opencode-task-completion] direct LLM path failed, falling back to opencode transport:',
         (directErr as Error)?.message || directErr,
       );
     }
   }
   return runWithEphemeralOpencodeServer({ user: user || undefined, verbose: false, isolateHome: true }, async (serverUrl) => {
    const { rootCauses, source: rootCauseSource } = await resolveRootCauses(input, user);
    const skillAttributionMode = input.skillAttributionMode || 'skill-aware';
    const config = await getActiveConfig(user);
    if (!config) {
        return {
            isCorrect: false,
            score: 0,
            reason: '请先在模型配置中激活一个评测模型，才能执行结果评测。',
            rawAnalysis: {
                root_cause_source: rootCauseSource,
            },
        };
    }

    const activeModel = user ? await loadServerModelForUser(user) : null;
    const providerID = activeModel?.providerID || resolveProviderID(config);
    const modelID = activeModel?.modelID || config.model || 'deepseek-chat';
    const payload: SendPromptPayload = {
        text: buildUserMessage(input, rootCauses),
        agent: OPENCODE_FALLBACK_AGENT_NAME,
        model: {
            providerID,
            modelID,
            apiKey: activeModel?.apiKey || config.apiKey,
            baseURL: activeModel?.baseURL || config.baseUrl,
            headers: activeModel?.headers || config.headers,
        },
        modelOptions: {
            temperature: 0,
            top_p: 1,
            seed: 42,
        },
        system: buildCoordinatorSystemPrompt(skillAttributionMode),
        // 用统一的评测器权限基线：read/bash/webfetch 显式 allow + question/plan_* deny + 写允许 /tmp/*。
        // 之前只允许 external_directory /tmp/*,read/bash 没规则 → 后端无 TTY 时
        // permission.asked 没人响应 → 工具调用 silent 卡死,a/b 测试看不到任何输出。
        permission: buildEvaluatorPermissions(),
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
            console.warn(`[opencode-task-completion] unexpected subagent spawned: ${unexpectedSubagent}`);
        },
    };

    try {
        // serverUrl 由外层 runWithEphemeralOpencodeServer 注入 —— per-task 新进程,跑完自动杀
        insight = new AgentInsight({
            baseURL: serverUrl,
            logLevel: 'warn',
        });

        const sessionResp = await insight.createSession({
            title: `${TASK_COMPLETION_EVALUATOR_NAME}-${Date.now()}`,
            // 评测 session 不操作文件,但仍要把 cwd 锁到 /tmp 避免落到 opencode spawn 时的
            // 默认 cwd(/root)。同样的坑会让 agent 误解析 SKILL.md 里的相对路径触发
            // read hang(opencode 1.14.x read tool 不存在文件不抛 ENOENT 而是死锁)。
            directory: '/tmp',
        });
        const sessionId = String(sessionResp?.id || sessionResp?.ID || '');
        if (!sessionId) {
            throw new Error('Failed to create opencode session for task completion evaluation');
        }
        evaluatorSessionId = sessionId;

        const agentId = await getSystemAgentId('opencode', TASK_COMPLETION_EVALUATOR_NAME);
        const def = findSystemAgentDefinition('opencode', TASK_COMPLETION_EVALUATOR_NAME);
        tagOpencodeSession(sessionId, {
            agentName: TASK_COMPLETION_EVALUATOR_NAME,
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
            agentName: TASK_COMPLETION_EVALUATOR_NAME,
            user,
            query: input.caseInput,
        });

        if (unexpectedSubagent) {
            throw new Error(`任务完成度评估器不允许派发子代理，但实际派发了：${unexpectedSubagent}`);
        }

        const parsed = parseLooseJson(fullText);
        if (parsed && isTaskCompletionPayload(parsed)) {
            const normalized = normalizeOutput(parsed, skillAttributionMode);
            return {
                ...normalized,
                rawAnalysis: {
                    ...(normalized.rawAnalysis || {}),
                    evaluatorSessionId,
                    root_cause_source: rootCauseSource,
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
                agentName: TASK_COMPLETION_EVALUATOR_NAME,
                user,
                query: input.caseInput,
            });
        } catch (persistError) {
            console.warn(
                '[opencode-task-completion] failed to persist evaluator execution:',
                (persistError as Error)?.message || persistError,
            );
        }
    }

    if (unexpectedSubagent) {
        throw runtimeError || new Error(`任务完成度评估器不允许派发子代理，但实际派发了：${unexpectedSubagent}`);
    }

    const salvaged = tryNormalizeFromTexts(
        skillAttributionMode,
        fullText,
        runtimeError?.message,
    );
    if (salvaged) {
        return {
            ...salvaged,
            rawAnalysis: {
                ...(salvaged.rawAnalysis || {}),
                evaluatorSessionId: evaluatorSessionId || undefined,
                root_cause_source: rootCauseSource,
            },
        };
    }

    const detail = runtimeError?.message || `Agent 输出前 800 字符：${fullText.slice(0, 800)}`;
    throw new Error(`任务完成度评估器未产出有效 JSON。opencode 评测失败：${detail}`);
   });
  }, {
    taskType: 'task-completion-eval',
    user: user ?? undefined,
    skill: skillName ?? undefined,
    skillVersion: skillVersion ?? null,
    label: `task-completion: ${(input.caseInput || '').slice(0, 40)}`,
    // silent: 只占 slot 限流, 不写 task record 到 dashboard。
    // 用户视角下"用例分析评测"是一个 row-level 任务(由 runOneEvaluation 注册 displayOnly),
    // 这里的 task-completion 是它内部的一个步骤, 不再单独显示。
    silent: true,
  });
}

export const TASK_COMPLETION_EVALUATOR_AGENTS = [
    {
        id: TASK_COMPLETION_EVALUATOR_NAME,
        name: TASK_COMPLETION_EVALUATOR_NAME,
        ownership: 'system' as const,
        layer: 'main' as const,
        platform: 'opencode' as const,
        version: 'v1.0',
        framework: 'opencode',
        status: 'running' as const,
        successRate: '—',
        todayCalls: '—',
        lastExecutedAt: new Date().toISOString(),
        description: 'Agent 任务完成度评估器 — 基于 opencode 评估最终输出是否完成用户目标，并由主评估器直接完成关键观点覆盖检查',
    },
];

export const TASK_COMPLETION_EVALUATOR_PROMPTS = {
    coordinator: buildCoordinatorSystemPrompt('skill-aware'),
    coordinatorNoSkill: buildCoordinatorSystemPrompt('no-skill'),
};
