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
import { generateRootCauseExtractionPrompt } from '@/prompts/config-extraction-prompt';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@langchain/core/messages';
import { tagOpencodeSession } from '@/lib/internal-agent-tag';
import { findSystemAgentDefinition, getSystemAgentId } from '@/lib/system-agents';
import { parseLooseJson } from './task-completion-json';

export interface TaskCompletionEvalInput {
    caseInput: string;
    expectedOutput: string;
    actualOutput: string;
}

export interface TaskCompletionEvalOutput {
    isCorrect: boolean;
    score: number;
    reason: string;
    rawAnalysis?: Record<string, unknown>;
}

interface RootCauseItem {
    content: string;
    weight: number;
}

const TASK_COMPLETION_EVALUATOR_NAME = 'task-completion-evaluator';
const KEY_POINTS_CHECKER_NAME = 'key-points-checker';
const OPENCODE_FALLBACK_AGENT_NAME = 'build';

const COORDINATOR_SYSTEM_PROMPT = `你是「Agent 任务完成度」评估器。你会收到用户输入、预期结果、实际输出，以及从标准答案中提取的关键观点。

【必须遵循的工作流程】
1. 不要直接给最终结论；先把关键观点原样转交给子代理 key-points-checker，检查每个关键观点是否被实际输出覆盖。
2. 综合预期结果、实际输出、关键观点覆盖情况，判断任务完成度。
3. 原因 reason 只写总体判断，不要把每个关键观点逐条塞进 reason。
4. 把关键观点覆盖情况放进独立字段 key_point_findings，供前端单独展示。
5. 只输出严格 JSON，不要输出 Markdown 或额外解释：

{
  "score": 0.86,
  "is_correct": true,
  "reason": "中文说明。先说任务是否完成，再说实际输出与预期结果的核心差异，最后一句收束。",
  "key_point_findings": [
    {
      "content": "...",
      "covered": true,
      "severity": "low|medium|high",
      "explanation": "...",
      "is_skill_attributable": false,
      "improvement_suggestion": "仅当 covered=false 且 is_skill_attributable=true 时填，写到 SKILL.md 具体小节级"
    }
  ],
  "result_issues": [
    {
      "kind": "format|extra_content|verbosity|incorrect_fact|other",
      "summary": "一句话描述问题（不要复述整个产物）",
      "severity": "low|medium|high",
      "is_skill_attributable": true,
      "improvement_suggestion": "在 SKILL.md 哪段加什么约束（仅 is_skill_attributable=true 时填）"
    }
  ],
  "key_point_summary": "中文总结关键观点整体覆盖情况",
  "raw_subagent_outputs": {
    "key_points": {}
  }
}

【评分标准】
- 1.0: 完全完成任务，且关键结论覆盖充分。
- 0.5: 基本完成任务，但表达不清、遗漏部分关键观点，或存在次要偏差。
- 0.0: 没有完成任务，或实际输出与预期结果明显不符。
- 允许输出 0.0～1.0 之间的连续分数，但必须以上述 1.0 / 0.5 / 0.0 为主要锚点，按完成度与关键观点覆盖度细化。

【关于 key_point_findings 的 is_skill_attributable / improvement_suggestion 字段（仅未覆盖时关注）】
- is_skill_attributable：若该关键观点缺失，是否由"SKILL.md 没明确要求"导致。
  · true  → SKILL 缺规则/示例/输出约束，下游 skill-opt 会拿它去改 SKILL
  · false → 跟 SKILL 无关（如纯模型输出能力不足、prompt 工程问题），不进 skill 优化点
- improvement_suggestion：仅当 covered=false && is_skill_attributable=true 时填，写"在 SKILL.md 哪段加什么约束"，到小节级。
- covered=true 的项可以省略这两个字段。

【关于 result_issues 数组（key_point_findings 之外的结果质量问题）】
key_point_findings 只覆盖"应有但缺失"的维度。还有 4 类 result 问题需要单独提取到 result_issues：
- kind="format"        → 输出格式不规范（缺章节、字段顺序乱、Markdown 层级错）
- kind="extra_content" → 含明显多余/无关内容（reasoning 塞进 final_result、调试日志、自我补充的免责声明）
- kind="verbosity"     → 表达啰嗦不简洁（同一信息反复重复、冗长前言、无必要寒暄）
- kind="incorrect_fact"→ 数值/事实错误（与预期结果数值/术语不符）
- kind="other"         → 上述无法归类但确实是 skill 应规避的问题

每条 result_issue 也要标 is_skill_attributable + 给出 improvement_suggestion；is_skill_attributable=false 的（纯模型能力问题）下游不进 skill 优化点。
没有这类问题就给空数组。
`;

const KEY_POINTS_CHECKER_PROMPT = `你是关键观点覆盖检查子代理。请对照“关键观点列表”和“实际输出”，判断每个关键观点是否被覆盖。

只输出严格 JSON：
{
  "covered_points": [
    {
      "content": "...",
      "covered": true,
      "severity": "low|medium|high",
      "explanation": "...",
      "is_skill_attributable": false,
      "improvement_suggestion": "仅当 covered=false 且归因到 SKILL 时填"
    }
  ],
  "summary": "中文总结"
}

字段语义：
- is_skill_attributable：未覆盖的关键观点是否由 SKILL 写得不清楚导致。覆盖了的项（covered=true）可省略此字段。
- improvement_suggestion：仅当 covered=false && is_skill_attributable=true 时填，写"在 SKILL.md 哪段加什么"，到小节级。
`;

function clampTaskScore(value: unknown): number {
    const score = typeof value === 'number'
        ? value
        : typeof value === 'string'
        ? Number(value)
        : NaN;
    if (!Number.isFinite(score)) return 0;
    return Math.max(0, Math.min(1, score));
}

function tryNormalizeFromTexts(...texts: Array<string | null | undefined>): TaskCompletionEvalOutput | null {
    for (const text of texts) {
        const parsed = parseLooseJson(String(text || ''));
        if (parsed && isTaskCompletionPayload(parsed)) return normalizeOutput(parsed);
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
    if (parsed.raw_subagent_outputs && typeof parsed.raw_subagent_outputs === 'object') return true;
    return false;
}

async function makeDirectModel(user?: string | null) {
    const config = await getActiveConfig(user);
    if (!config) return null;
    return new ChatOpenAI({
        apiKey: config.apiKey || 'no-api-key',
        model: config.model || 'deepseek-chat',
        configuration: {
            baseURL: config.baseUrl || 'https://api.deepseek.com',
        },
        temperature: 0.1,
    });
}

async function extractRootCausesFromExpected(
    caseInput: string,
    expectedOutput: string,
    user?: string | null,
): Promise<RootCauseItem[]> {
    if (!String(expectedOutput || '').trim()) return [];
    const model = await makeDirectModel(user);
    if (!model) return [];
    const response = await model.invoke([
        new HumanMessage(generateRootCauseExtractionPrompt(caseInput || 'Task completion', expectedOutput)),
    ]);
    const content = typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content);
    const parsed = parseLooseJson(content);
    const rawItems = Array.isArray(parsed?.root_causes) ? parsed.root_causes : [];
    return rawItems
        .map(item => item && typeof item === 'object' ? item as Record<string, unknown> : null)
        .filter((item): item is Record<string, unknown> => Boolean(item))
        .map(item => ({
            content: String(item.content || '').trim(),
            weight: typeof item.weight === 'number' ? item.weight : 1,
        }))
        .filter(item => item.content);
}

function buildUserMessage(input: TaskCompletionEvalInput, rootCauses: RootCauseItem[]): string {
    const keyPointsText = rootCauses.length > 0
        ? rootCauses.map((item, index) => `${index + 1}. ${item.content}（权重 ${item.weight}）`).join('\n')
        : '（未提取到关键观点，可仅按任务完成度评判）';

    return [
        '# Agent 任务完成度评测输入',
        '',
        `## 用户输入\n${input.caseInput}`,
        '',
        `## 预期结果\n${input.expectedOutput}`,
        '',
        `## 实际输出\n${input.actualOutput}`,
        '',
        `## 关键观点\n${keyPointsText}`,
        '',
        '请先让 key-points-checker 检查关键观点覆盖情况，再综合判断任务完成度。',
    ].join('\n');
}

function normalizeOutput(parsed: Record<string, unknown>): TaskCompletionEvalOutput {
    const score = clampTaskScore(parsed.score);
    const isCorrect = typeof parsed.is_correct === 'boolean'
        ? parsed.is_correct
        : score >= 1;
    const reason = String(parsed.reason || '').trim() || '任务完成度评测已完成，但未返回理由。';
    return {
        isCorrect,
        score,
        reason,
        rawAnalysis: {
            ...parsed,
            key_point_findings: Array.isArray(parsed.key_point_findings)
                ? parsed.key_point_findings
                : parsed.raw_subagent_outputs && typeof parsed.raw_subagent_outputs === 'object' && Array.isArray((parsed.raw_subagent_outputs as Record<string, unknown>).key_point_findings)
                ? (parsed.raw_subagent_outputs as Record<string, unknown>).key_point_findings
                : [],
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
   return runWithEphemeralOpencodeServer({ user: user || undefined, verbose: false }, async (serverUrl) => {
    const rootCauses = await extractRootCausesFromExpected(input.caseInput, input.expectedOutput, user);
    const config = await getActiveConfig(user);
    if (!config) {
        return {
            isCorrect: false,
            score: 0,
            reason: '请先在模型配置中激活一个评测模型，才能执行结果评测。',
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
        },
        system: COORDINATOR_SYSTEM_PROMPT,
        // 用统一的评测器权限基线：read/bash/webfetch 显式 allow + question/plan_* deny + 写允许 /tmp/*。
        // 之前只允许 external_directory /tmp/*,read/bash 没规则 → 后端无 TTY 时
        // permission.asked 没人响应 → 工具调用 silent 卡死,a/b 测试看不到任何输出。
        permission: buildEvaluatorPermissions(),
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
            console.log(`[opencode-task-completion] subagent ${e.agent}: phase=${e.phase}`);
        },
    };

    try {
        // serverUrl 由外层 runWithEphemeralOpencodeServer 注入 —— per-task 新进程,跑完自动杀
        const insight = new AgentInsight({
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

        const parsed = parseLooseJson(fullText);
        if (parsed && isTaskCompletionPayload(parsed)) {
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

    const salvaged = tryNormalizeFromTexts(
        fullText,
        runtimeError?.message,
    );
    if (salvaged) {
        return {
            ...salvaged,
            rawAnalysis: {
                ...(salvaged.rawAnalysis || {}),
                evaluatorSessionId: evaluatorSessionId || undefined,
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
        description: 'Agent 任务完成度评估器 — 基于 opencode 评估最终输出是否完成用户目标，并结合关键观点覆盖情况给分',
    },
    {
        id: KEY_POINTS_CHECKER_NAME,
        name: KEY_POINTS_CHECKER_NAME,
        ownership: 'system' as const,
        layer: 'subagent' as const,
        platform: 'opencode' as const,
        version: 'v1.0',
        framework: 'opencode',
        status: 'running' as const,
        successRate: '—',
        todayCalls: '—',
        lastExecutedAt: new Date().toISOString(),
        parentAgent: TASK_COMPLETION_EVALUATOR_NAME,
        description: '关键观点覆盖检查子代理 — 评估实际输出是否覆盖标准答案中的关键观点',
    },
];

export const TASK_COMPLETION_EVALUATOR_PROMPTS = {
    coordinator: COORDINATOR_SYSTEM_PROMPT,
    keyPointsChecker: KEY_POINTS_CHECKER_PROMPT,
};
