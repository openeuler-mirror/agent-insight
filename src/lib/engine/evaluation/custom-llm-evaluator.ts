/**
 * 自建 LLM 评估器运行时。
 *
 * 用户在「评估器中心」创建的 LLM-judge 评估器（`custom-<ts>` 形态，存
 * CustomEvaluatorList.itemsJson）通过这里执行：把 systemPrompt 中的数据集变量注入后，
 * 通过 opencode build agent 发起一次评测会话。这样自建评估器本身也会产生可追踪的会话数据。
 */

import {
    AgentInsight,
    type ChatHandlers,
    type SendPromptPayload,
} from '@/lib/engine/skill-generation/opencode-agent-cli/opencode-client';
import { runWithEphemeralOpencodeServer } from '@/lib/engine/skill-generation/opencode-agent-cli/opencode-manager';
import { withBackgroundOpencodeSlot } from '@/lib/engine/general-agent/concurrency-limiter';
import { buildEvaluatorPermissions } from '@/lib/engine/general-agent/workspace';
import { getActiveConfig, type ModelConfig } from '@/lib/storage/server-config';
import { isModelConnectionReady } from '@/lib/shared/model-connection';
import {
    inferProviderFromBaseUrl,
    loadServerModelForUser,
    normalizeProviderID,
} from '@/lib/engine/general-agent/server-model-config';
import { prismaRaw } from '@/lib/storage/prisma';
import { tagOpencodeSession } from '@/lib/internal-agent-tag';
import { readUserCustomEvaluators } from '@/server/user_evaluators_storage';
import {
    CUSTOM_EVALUATOR_ALLOWED_VARIABLES,
    findUnsupportedCustomEvaluatorVariables,
    isValidCustomEvaluatorName,
    type EvaluatorCard,
    type LlmEvaluatorConfig,
} from '@/lib/evaluators/custom-evaluator-model';
import { parseCustomEvaluatorScore } from '@/lib/evaluators/custom-evaluator-score';

const DEFAULT_TIMEOUT_MS = Number(process.env.CUSTOM_EVAL_LLM_TIMEOUT_MS || 120_000);
const OPENCODE_FALLBACK_AGENT_NAME = 'build';

export const CUSTOM_EVALUATOR_ID_PREFIX = 'custom-';
export const CUSTOM_EVALUATOR_SYSTEM_AGENT_DESCRIPTION = '系统：自建评估器（自动注册）';

export function isCustomEvaluatorId(id: string): boolean {
    return typeof id === 'string' && id.startsWith(CUSTOM_EVALUATOR_ID_PREFIX);
}

export interface CustomEvaluatorInput {
    caseInput: string;
    expectedOutput?: string;
    actualOutput: string;
    /** 简要 trace 文本（已被截断/汇总，适合直接放进 prompt） */
    traceText?: string;
}

export interface CustomEvaluatorResult {
    evaluatorId: string;
    evaluatorName: string;
    /** 0-100 之间的分数；解析失败时为 null */
    score: number | null;
    reason: string;
    rawResponse: string;
    model: string;
    durationMs: number;
    error?: string;
}

interface CustomEvaluatorBundle {
    id: string;
    name: string;
    config: LlmEvaluatorConfig;
}

let cardListCache: { user: string; expiresAt: number; map: Map<string, CustomEvaluatorBundle> } | null = null;
const CACHE_TTL_MS = 5_000;

async function getEvaluatorMap(user: string): Promise<Map<string, CustomEvaluatorBundle>> {
    const now = Date.now();
    if (cardListCache && cardListCache.user === user && cardListCache.expiresAt > now) {
        return cardListCache.map;
    }
    const items = (await readUserCustomEvaluators(user)) as EvaluatorCard[];
    const map = new Map<string, CustomEvaluatorBundle>();
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        if (item.evaluatorType !== 'LLM' || !item.llmConfig) continue;
        if (typeof item.id !== 'string' || !item.id) continue;
        map.set(item.id, {
            id: item.id,
            name: item.name || item.id,
            config: item.llmConfig,
        });
    }
    cardListCache = { user, expiresAt: now + CACHE_TTL_MS, map };
    return map;
}

export async function loadCustomEvaluator(
    user: string,
    evaluatorId: string,
): Promise<CustomEvaluatorBundle | null> {
    const map = await getEvaluatorMap(user);
    return map.get(evaluatorId) || null;
}

export async function listCustomEvaluatorIds(user: string): Promise<Set<string>> {
    const map = await getEvaluatorMap(user);
    return new Set(map.keys());
}

const PLACEHOLDER_PATTERNS: Record<string, (input: CustomEvaluatorInput) => string> = {
    '{{input}}': i => i.caseInput || '',
    '{{output}}': i => i.actualOutput || '',
    '{{reference_output}}': i => i.expectedOutput || '',
    '{{trajectory}}': i => i.traceText || '',
};

function applyPlaceholders(template: string, input: CustomEvaluatorInput): string {
    let out = template;
    for (const key of CUSTOM_EVALUATOR_ALLOWED_VARIABLES) {
        const tokenRe = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
        const renderer = PLACEHOLDER_PATTERNS[`{{${key}}}`];
        out = out.replace(tokenRe, renderer ? renderer(input) : '');
    }
    return out;
}

function buildSystemPrompt(config: LlmEvaluatorConfig, input: CustomEvaluatorInput): string {
    const rendered = applyPlaceholders(config.systemPrompt || '', input);
    return `${rendered.trim()}

【输出要求】
只输出严格 JSON，不要输出 Markdown 或额外解释：
{
  "score": 0,
  "reason": "中文说明"
}

score 必须是 0 到 100 之间的数字；100 表示完全符合标准，0 表示完全不符合；reason 说明评分依据。`;
}

function buildUserMessage(config: LlmEvaluatorConfig, input: CustomEvaluatorInput): string {
    const prompt = applyPlaceholders(config.userPrompt || '', input).trim();
    return prompt || '请根据 system prompt 完成本次评估，并按要求输出 JSON。';
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
    if (!raw) return null;
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidates = [fence?.[1], raw].filter((s): s is string => !!s);
    for (const c of candidates) {
        try {
            const obj = JSON.parse(c);
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                return obj as Record<string, unknown>;
            }
        } catch {}
        const a = c.indexOf('{');
        const b = c.lastIndexOf('}');
        if (a !== -1 && b > a) {
            try {
                const obj = JSON.parse(c.slice(a, b + 1));
                if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                    return obj as Record<string, unknown>;
                }
            } catch {}
        }
    }
    return null;
}

function deriveReason(raw: string): string {
    if (!raw) return '';
    const parsed = parseJsonObject(raw);
    if (parsed) {
        const reasonCandidates = ['reason', 'explanation', 'rationale', '评测理由', '原因'];
        for (const key of reasonCandidates) {
            const value = parsed[key];
            if (typeof value === 'string' && value.trim()) {
                return value.trim().slice(0, 2000);
            }
        }
    }
    // 去掉 fenced JSON，让说明更易读
    const stripped = raw.replace(/```(?:json)?\s*[\s\S]*?```/g, '').trim();
    return (stripped || raw).slice(0, 2000);
}

function resolveProviderID(config: ModelConfig): string {
    return normalizeProviderID(config.provider || inferProviderFromBaseUrl(config.baseUrl));
}

async function ensureCustomRegisteredAgent(user: string, name: string): Promise<string | null> {
    try {
        const existing = await prismaRaw.registeredAgent.findFirst({
            where: { platform: 'opencode', name, user },
        });
        if (existing) {
            if (
                existing.agentOwnership !== 'system'
                || existing.agentType !== 'main'
                || existing.description !== CUSTOM_EVALUATOR_SYSTEM_AGENT_DESCRIPTION
            ) {
                const updated = await prismaRaw.registeredAgent.update({
                    where: { id: existing.id },
                    data: {
                        agentOwnership: 'system',
                        agentType: 'main',
                        description: CUSTOM_EVALUATOR_SYSTEM_AGENT_DESCRIPTION,
                    },
                });
                return updated.id;
            }
            return existing.id;
        }
        const created = await prismaRaw.registeredAgent.create({
            data: {
                platform: 'opencode',
                name,
                user,
                description: CUSTOM_EVALUATOR_SYSTEM_AGENT_DESCRIPTION,
                agentType: 'main',
                agentOwnership: 'system',
            },
        });
        return created.id;
    } catch (err) {
        console.warn(`[custom-evaluator] register agent ${name} failed:`, (err as Error)?.message);
        return null;
    }
}

export async function syncCustomEvaluatorRegisteredAgents(
    user: string,
    evaluators: EvaluatorCard[],
): Promise<void> {
    const names = new Set<string>();
    for (const item of evaluators) {
        if (!item || item.evaluatorType !== 'LLM') continue;
        const name = String(item.name || '').trim();
        if (!name || !isValidCustomEvaluatorName(name)) continue;
        names.add(name);
    }

    const existing = await prismaRaw.registeredAgent.findMany({
        where: {
            platform: 'opencode',
            user,
        },
    });

    const existingByName = new Map<string, { id: string; name: string }>();
    const managedIdsToDelete: string[] = [];
    for (const row of existing) {
        if (row.description === CUSTOM_EVALUATOR_SYSTEM_AGENT_DESCRIPTION) {
            if (!names.has(row.name)) {
                managedIdsToDelete.push(row.id);
                continue;
            }
        }
        if (names.has(row.name) && !existingByName.has(row.name)) {
            existingByName.set(row.name, { id: row.id, name: row.name });
        }
    }

    for (const name of names) {
        const row = existingByName.get(name);
        if (row) {
            await prismaRaw.registeredAgent.update({
                where: { id: row.id },
                data: {
                    description: CUSTOM_EVALUATOR_SYSTEM_AGENT_DESCRIPTION,
                    agentType: 'main',
                    agentOwnership: 'system',
                },
            });
            continue;
        }
        await prismaRaw.registeredAgent.create({
            data: {
                platform: 'opencode',
                name,
                user,
                description: CUSTOM_EVALUATOR_SYSTEM_AGENT_DESCRIPTION,
                agentType: 'main',
                agentOwnership: 'system',
            },
        });
    }

    if (managedIdsToDelete.length > 0) {
        await prismaRaw.registeredAgent.deleteMany({
            where: { id: { in: managedIdsToDelete } },
        });
    }
}

export async function runCustomLlmEvaluator(
    user: string,
    evaluatorId: string,
    input: CustomEvaluatorInput,
    skillName?: string | null,    // 透传给 limiter,让"后台分析任务"按 skill 严格过滤
    skillVersion?: number | null, // skill 版本号,展示用
): Promise<CustomEvaluatorResult> {
  return withBackgroundOpencodeSlot(async () => {
   return runWithEphemeralOpencodeServer({ user, verbose: false, isolateHome: true }, async (serverUrl) => {
    const startedAt = Date.now();
    const bundle = await loadCustomEvaluator(user, evaluatorId);
    if (!bundle) {
        return {
            evaluatorId,
            evaluatorName: evaluatorId,
            score: null,
            reason: '',
            rawResponse: '',
            model: '',
            durationMs: Date.now() - startedAt,
            error: `未找到自建评估器 ${evaluatorId}（可能已被删除）`,
        };
    }

    const config = await getActiveConfig(user);
    if (!config || !isModelConnectionReady(config)) {
        return {
            evaluatorId: bundle.id,
            evaluatorName: bundle.name,
            score: null,
            reason: '',
            rawResponse: '',
            model: bundle.config.model || '',
            durationMs: Date.now() - startedAt,
            error: '未配置可用的评测模型，请到「模型注册」页完善连接信息',
        };
    }

    if (!isValidCustomEvaluatorName(bundle.name)) {
        return {
            evaluatorId: bundle.id,
            evaluatorName: bundle.name,
            score: null,
            reason: '',
            rawResponse: '',
            model: bundle.config.model || config.model || '',
            durationMs: Date.now() - startedAt,
            error: '自建评估器名称必须是英文 agent 名称：以字母开头，仅支持字母、数字、下划线、连字符',
        };
    }

    const unsupportedVars = findUnsupportedCustomEvaluatorVariables(
        `${bundle.config.systemPrompt || ''}\n${bundle.config.userPrompt || ''}`,
    );
    if (unsupportedVars.length > 0) {
        return {
            evaluatorId: bundle.id,
            evaluatorName: bundle.name,
            score: null,
            reason: '',
            rawResponse: '',
            model: bundle.config.model || config.model || '',
            durationMs: Date.now() - startedAt,
            error: `System Prompt 包含不支持的变量：${unsupportedVars.map(v => `{{${v}}}`).join(', ')}`,
        };
    }

    const activeModel = await loadServerModelForUser(user);
    const providerID = activeModel?.providerID || resolveProviderID(config);
    const model = activeModel?.modelID || config.model || 'deepseek-chat';

    const payload: SendPromptPayload = {
        text: buildUserMessage(bundle.config, input),
        agent: OPENCODE_FALLBACK_AGENT_NAME,
        model: {
            providerID,
            modelID: model,
            apiKey: config.apiKey,
            baseURL: config.baseUrl,
            headers: config.headers,
        },
        system: buildSystemPrompt(bundle.config, input),
        // 用统一的评测器权限基线：read/bash/webfetch 显式 allow + question/plan_* deny + 写允许 /tmp/*。
        // 之前只允许 external_directory /tmp/*,read/bash 没规则 → 后端无 TTY 时
        // permission.asked 没人响应 → 工具调用 silent 卡死,自建评估器执行没输出。
        permission: buildEvaluatorPermissions(),
    };

    let raw = '';
    let runtimeError: Error | null = null;
    const handlers: ChatHandlers = {
        onText: e => {
            raw += e.delta;
        },
        onError: e => {
            runtimeError = e;
        },
    };

    try {
        // serverUrl 由外层 runWithEphemeralOpencodeServer 注入 —— per-task 新进程,跑完自动杀
        const insight = new AgentInsight({
            baseURL: serverUrl,
            logLevel: 'warn',
        });
        const sessionResp = await insight.createSession({
            title: `${bundle.name}-${Date.now()}`,
            // 评测 session 锁定 cwd 到 /tmp,避免误解析相对路径触发 read tool hang
            // (详见 opencode-task-completion-evaluator 同位置注释 + opencode-client createSession)
            directory: '/tmp',
        });
        const sessionId = String(sessionResp?.id || sessionResp?.ID || '');
        if (!sessionId) {
            throw new Error('Failed to create opencode session for custom evaluation');
        }

        const agentId = await ensureCustomRegisteredAgent(user, bundle.name);
        tagOpencodeSession(sessionId, {
            agentName: bundle.name,
            agentId,
            displayQuery: input.caseInput,
            user,
        });

        try {
            const result = await Promise.race([
                insight.chat(sessionId, payload, handlers, {
                    streamTimeoutMs: DEFAULT_TIMEOUT_MS,
                    idleTimeoutMs: DEFAULT_TIMEOUT_MS,
                }),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error(`LLM 调用超时（${DEFAULT_TIMEOUT_MS}ms）`)), DEFAULT_TIMEOUT_MS),
                ),
            ]);
            raw = result.text || raw;
        } finally {
            try {
                await insight.deleteSession(sessionId);
            } catch {
                // best-effort cleanup
            }
        }
    } catch (e) {
        runtimeError = e instanceof Error ? e : new Error(String(e));
    }

    if (runtimeError) {
        const salvagedScore = parseCustomEvaluatorScore(raw || runtimeError.message);
        if (salvagedScore == null) {
            return {
                evaluatorId: bundle.id,
                evaluatorName: bundle.name,
                score: null,
                reason: '',
                rawResponse: raw,
                model,
                durationMs: Date.now() - startedAt,
                error: `自建评估器调用失败：${runtimeError.message}`,
            };
        }
    }

    const score = parseCustomEvaluatorScore(raw);
    const reason = deriveReason(raw);

    return {
        evaluatorId: bundle.id,
        evaluatorName: bundle.name,
        score,
        reason,
        rawResponse: raw,
        model,
        durationMs: Date.now() - startedAt,
        error: score == null ? '未能从模型响应中解析出 0-100 分数' : undefined,
    };
   });
  }, {
    taskType: 'custom-llm-eval',
    user,
    skill: skillName ?? undefined,
    skillVersion: skillVersion ?? null,
    label: `custom-eval: ${evaluatorId}`,
    // silent: 自定义评测器作为 row-level "用例分析"的内部子步骤,不单独显示。
    silent: true,
  });
}
