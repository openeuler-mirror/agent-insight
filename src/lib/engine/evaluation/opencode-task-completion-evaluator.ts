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
import { recordEvaluatorExecution } from './evaluator-execution-recorder';
import { extractRootCausesFromExpected } from './root-cause-extractor';
import { parseLooseJson } from './task-completion-json';

export interface TaskCompletionEvalInput {
    caseInput: string;
    expectedOutput: string;
    actualOutput: string;
    precomputedRootCauses?: RootCauseItem[];
    precomputedRootCauseSource?: 'dataset-cache' | 'none';
}

export interface TaskCompletionEvalOutput {
    isCorrect: boolean;
    score: number;
    reason: string;
    rawAnalysis?: Record<string, unknown>;
}

const TASK_COMPLETION_EVALUATOR_NAME = 'task-completion-evaluator';
const OPENCODE_FALLBACK_AGENT_NAME = 'build';

const COORDINATOR_SYSTEM_PROMPT = `你是「Agent 任务完成度」评估器。你会收到用户输入、预期结果、实际输出，以及从标准答案中提取的关键观点。

【必须遵循的工作流程】
1. 你必须自己逐条检查每个关键观点是否被实际输出覆盖，不要跳过任何一条。
2. 禁止派发、调用或生成任何 subagent / task；本次评测只能由你这个主评估器独立完成。
3. 综合预期结果、实际输出、关键观点覆盖情况，判断任务完成度。
4. 原因 reason 只写总体判断，不要把每个关键观点逐条塞进 reason。
5. 把关键观点覆盖情况放进独立字段 key_point_findings，供前端单独展示。
6. 只输出严格 JSON，不要输出 Markdown 或额外解释：

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
  "key_point_summary": "中文总结关键观点整体覆盖情况"
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
    if (Array.isArray(parsed.result_issues)) return true;
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
        '请你自行逐条检查关键观点覆盖情况，并在不派发任何子代理的前提下完成整个任务完成度评测。',
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
   return runWithEphemeralOpencodeServer({ user: user || undefined, verbose: false, isolateHome: true }, async (serverUrl) => {
    const { rootCauses, source: rootCauseSource } = await resolveRootCauses(input, user);
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
            const normalized = normalizeOutput(parsed);
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
    coordinator: COORDINATOR_SYSTEM_PROMPT,
};
