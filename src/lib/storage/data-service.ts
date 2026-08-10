import fs from 'fs';
import path from 'path';
import { resolveAgentInsightDataPath } from '@/lib/env';
import { judgeAnswer } from '@/lib/engine/evaluation/judge';
import { normalizeEndpointUrl } from '@/lib/infra/endpoint-resolve';
import { computeCallStats } from '@/lib/fleet/call-stats';
import { db, prisma, prismaRaw } from '@/lib/storage/prisma';
import { getModelPricing, calculateCost, getModelContextWindow, DEFAULT_CACHE_READ_RATIO, DEFAULT_CACHE_CREATION_RATIO } from '@/lib/shared/model-config';
import {
    configSupportsDatasetType,
    getDatasetTypePriority,
    normalizeExpectedSkills,
    normalizeConfigDatasetType,
    type ConfigDatasetType,
} from '@/lib/engine/evaluation/config-dataset';
import {
    getConfigSubjectLabel,
    normalizeConfigQuery,
    normalizeConfigSkillName,
} from '@/lib/engine/evaluation/config-target';
import {
    matchQueryToStoredRoutingSignature,
    type RoutingSemanticSignature,
} from '@/lib/ingest/routing-signature';
import { deriveOpencodeExecutionFields } from '@/lib/engine/observability/opencode-derived-metrics';
import {
    extractObservedAgentNames,
    extractObservedAgentRegistrations,
} from '@/lib/engine/observability/agent-registration';
import { chooseExecutionLabel } from '@/lib/engine/evaluation/label-utils';
import { parseLabelSkillVersionBinding } from '@/lib/engine/evaluation/label-skill-binding';
import { extractKeyActionsFromFlow, mergeKeyActionsFromMultipleSkills, type ExtractedKeyAction, type ParsedFlowResult } from '@/lib/engine/observability/flow-parser';
import { mergeSessionInteractionsMonotonic } from '@/lib/engine/observability/session-interactions-merge';
import { buildAgentCallTree, inferSubagentType, walkTree, type AgentNode } from '@/lib/engine/observability/agent-trace';
import { isEvaluatorAgentName } from '@/lib/evaluator-agent';
import { isInternalSystemAgentTrace } from '@/lib/system-agent-names';
import { SYSTEM_AGENT_NAMES } from '@/lib/system-agent-names';
import { buildExecutionOwnershipWhere } from '@/lib/agent-ownership';
import { getAdapter } from '@/lib/ingest/adapters/registry';
import { normalizeInteractions } from '@/lib/shared/interaction-utils';
import { buildPrismaWhere } from '@/lib/filters/to-prisma';
import type { FilterClause } from '@/lib/filters/types';
import { mergeLangfuseTraceNodes, type LangfuseTraceNode } from '@/lib/ingest/otel/adapters/langfuse-trace';
import {
    findExecutionIdsByBusinessTags,
    getTraceTagsByExecutionIds,
    type TraceTagDto,
} from '@/lib/trace-tags';

/** 允许派生子 Agent 树的框架集合。先落地者集合化，后落地者仅加值。 */
const SUBAGENT_TREE_FRAMEWORKS = new Set(['opencode', 'openclaw', 'hermes', 'langfuse-langgraph', 'codeagent', 'claudecode']);

export interface InvokedSkill {
    name: string;
    version: number | null;
}

/**
 * ExecutionSkill(可索引的 trace↔skill 绑定)在 SQLite 路径启用。
 * OpenGauss(配了 DB_HOST)未建表/未接适配器,这里整体降级回旧的 skill 列行为,避免运行期报错。
 */
const EXECUTION_SKILL_ENABLED = !process.env.DB_HOST;

const SKILL_NAME_PATTERN = /^[a-zA-Z0-9_\-\.]+$/;

export function inferUserQueryFromInteractions(interactions: unknown): string | undefined {
    if (!Array.isArray(interactions)) return undefined;
    for (const interaction of interactions) {
        if (!interaction || typeof interaction !== 'object') continue;
        const item = interaction as Record<string, any>;
        if (String(item.role || '').toLowerCase() !== 'user') continue;
        const content = typeof item.content === 'string' ? item.content.trim() : '';
        if (content) return content;
    }
    return undefined;
}

export function shouldRefreshStoredQueryFromInteractions(
    query: unknown,
    framework: unknown,
): boolean {
    const current = typeof query === 'string' ? query.trim() : '';
    if (!current) return true;
    const fw = typeof framework === 'string' ? framework.trim().toLowerCase() : '';
    if (!fw) return false;
    if (fw === 'claudecode') {
        return /^Claude Code Session [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(current);
    }
    return current.toLowerCase() === `${fw} session`;
}

/**
 * 从单个 AgentNode 抽取**本层 agent 自己显式调用**的 skill(kind==='skill',即 skill/load_skill;
 * 天然排除 task() 预加载与子 agent 的事件)。用于 opencode 的逐层 agent 作用域绑定。
 */
export function extractExplicitSkillsFromNode(node: AgentNode): InvokedSkill[] {
    const seen = new Set<string>();
    const out: InvokedSkill[] = [];
    for (const ev of node.events || []) {
        if (ev.kind !== 'skill') continue;
        const a = (ev.args && typeof ev.args === 'object') ? ev.args : {};
        const rawName = a.name ?? a.skill_name ?? a.skillName ?? a.skill;
        if (rawName == null || !String(rawName).trim()) continue;
        const s = String(rawName).trim().replace(/^['"]+|['"]+$/g, '');
        if (!SKILL_NAME_PATTERN.test(s) || seen.has(s)) continue;
        seen.add(s);
        const v = a.version != null ? Number(a.version) : null;
        out.push({ name: s, version: v !== null && !isNaN(v) ? v : null });
    }
    return out;
}

/**
 * 写入时把缺版本的 skill 定格成当时的 Skill.activeVersion 快照(只查一次)。
 * 已带版本的原样保留;查不到的留 null。
 */
async function snapshotSkillVersions(skills: InvokedSkill[], user: string | null | undefined): Promise<InvokedSkill[]> {
    const needLookup = Array.from(new Set(skills.filter(s => s.version == null).map(s => s.name)));
    const activeMap = new Map<string, number>();
    if (needLookup.length > 0) {
        try {
            const rows = await (prisma as any).skill.findMany({
                where: { name: { in: needLookup }, ...(user ? { OR: [{ user }, { user: null }] } : {}) },
                select: { name: true, activeVersion: true },
            });
            for (const r of rows) {
                if (typeof r.activeVersion === 'number') activeMap.set(r.name, r.activeVersion);
            }
        } catch (e) {
            console.warn('[Data-Service] snapshotSkillVersions lookup failed:', e);
        }
    }
    return skills.map(s => s.version != null ? s : { name: s.name, version: activeMap.get(s.name) ?? null });
}

function preferExplicitPrimarySkillVersion(
    skills: InvokedSkill[],
    primaryName: string | null | undefined,
    primaryVersion: number | null | undefined,
): InvokedSkill[] {
    if (!primaryName || typeof primaryVersion !== 'number') return skills;
    return skills.map(s => (
        s.name === primaryName && s.version == null
            ? { ...s, version: primaryVersion }
            : s
    ));
}

/**
 * 幂等地把某条 Execution(= 某一层 agent)本层用到的 skill 写入 ExecutionSkill:
 * 先按 executionId 清空再重建,不依赖 NULL 版本的唯一约束。
 */
async function persistExecutionSkills(
    executionId: string,
    skills: InvokedSkill[],
    opts: { user?: string | null; primaryName?: string | null } = {},
): Promise<void> {
    if (!EXECUTION_SKILL_ENABLED || !executionId) return;
    try {
        await prismaRaw.executionSkill.deleteMany({ where: { executionId } });
        if (!skills.length) return;
        const seen = new Set<string>();
        const data = [] as { executionId: string; skillName: string; skillVersion: number | null; isPrimary: boolean; user: string | null }[];
        for (const s of skills) {
            if (!s?.name) continue;
            const key = `${s.name}@@${s.version ?? ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            data.push({
                executionId,
                skillName: s.name,
                skillVersion: s.version ?? null,
                isPrimary: opts.primaryName != null && s.name === opts.primaryName,
                user: opts.user ?? null,
            });
        }
        if (data.length) await prismaRaw.executionSkill.createMany({ data });
    } catch (e) {
        console.warn(`[Data-Service] persistExecutionSkills failed for ${executionId}:`, e);
    }
}

/**
 * 给定一条 Execution(= 某一层 agent)的 session interactions,算出**本层 agent 自己显式调用**的 skill。
 *   - opencode：在该切片上重建 agent-call-tree,取其根节点(= 这一层 agent 自己)的显式 skill,剥离子 agent。
 *     (root 行的 session 是全量;sub-agent 行的 session 是它自己的切片——两者切片的 tree 根都恰是该层 agent。)
 *   - claude / openclaw：单 agent,既有显式抽取即本层口径。
 */
export function computeOwnSkills(framework: string | null | undefined, interactions: any[]): InvokedSkill[] {
    if (!Array.isArray(interactions) || interactions.length === 0) return [];
    const capabilities = getAdapter(framework).capabilities;
    if (capabilities?.skills !== true) return [];
    if (capabilities.skillScope === 'agent-tree') {
        const tree = buildAgentCallTree(interactions as any);
        return tree ? extractExplicitSkillsFromNode(tree) : [];
    }
    return extractInvokedSkillsFromSessionInteractions(framework, interactions) ?? [];
}

export function allowsSnapshotShrinkForFramework(framework: string | null | undefined): boolean {
    const adapter = getAdapter(framework);
    return adapter.capabilities?.allowSnapshotShrink === true
        || (
            adapter.descriptor.id === 'jiuwenswarm'
            && process.env.AGENT_INSIGHT_JIUWEN_ALLOW_SHRINK === 'true'
        );
}

/**
 * 服务账号集合:平台在服务端替用户跑 agent/评测时,产物 trace 由 server 的遥测带 server 自己的
 * witty key 上传 → 归到这些"服务账号"名下(默认 admin/anonymous/空)。用于把这类 trace 归还给
 * 真正的发起人。可用 TRACE_SERVICE_OWNERS 环境变量覆盖(逗号分隔)。
 */
const TRACE_SERVICE_OWNERS = new Set<string>([
    ...(process.env.TRACE_SERVICE_OWNERS || 'admin,anonymous').split(',').map(s => s.trim()).filter(Boolean),
    '', 'debug-user', 'anonymous',
]);

export function isServiceTraceOwner(owner: string | null | undefined): boolean {
    return TRACE_SERVICE_OWNERS.has((owner || '').trim());
}

/**
 * 把"平台服务端替某用户跑出来、却记在服务账号(admin)名下"的执行 trace 归还给真正的发起人。
 * 安全前提:只在 trace 当前 owner 是服务账号(admin/anonymous/空/debug-user)时才改,绝不动真实
 * 用户已拥有的 trace。一并改 root 自身 + 它的 sub-agent 行 + ExecutionSkill + Session 的 user。
 * 供写侧 hook(评测创建时)与一次性回填脚本共用。返回是否发生了改动。
 */
export async function reattributeServiceTraceOwner(traceRef: string, intendedUser: string): Promise<boolean> {
    const ref = (traceRef || '').trim();
    const user = (intendedUser || '').trim();
    if (!ref || !user || isServiceTraceOwner(user)) return false;

    let exec = await prismaRaw.execution.findUnique({ where: { id: ref }, select: { id: true, taskId: true, user: true } });
    if (!exec) {
        exec = await prismaRaw.execution.findFirst({ where: { taskId: ref }, select: { id: true, taskId: true, user: true } });
    }
    if (!exec) return false;
    const cur = (exec.user || '').trim();
    if (cur === user) return false;
    if (!isServiceTraceOwner(cur)) return false; // 真实用户的 trace 不动

    const serviceOwnersForIn = [...TRACE_SERVICE_OWNERS].filter(Boolean);
    await prismaRaw.execution.update({ where: { id: exec.id }, data: { user } });
    // 同一棵树里仍归服务账号(或 null)的 sub-agent 行一并归还
    await prismaRaw.execution.updateMany({
        where: { rootExecutionId: exec.id, OR: [{ user: { in: serviceOwnersForIn } }, { user: null }] },
        data: { user },
    });
    // ExecutionSkill(skill facet 按 user 过滤)与 Session 同步,避免列表/筛选口径不一致
    try { await prismaRaw.executionSkill.updateMany({ where: { executionId: exec.id }, data: { user } }); } catch { /* 表未启用时忽略 */ }
    if (exec.taskId) {
        try { await prismaRaw.session.updateMany({ where: { taskId: exec.taskId }, data: { user } }); } catch { /* ignore */ }
    }
    return true;
}

/**
 * 从一条 Execution 的 session interactions 重算 agent 作用域 skill 并写入 ExecutionSkill(版本写时定格)。
 * 供回填脚本对历史数据逐行重建;返回写入的 skill 条数。
 */
export async function recomputeExecutionSkills(
    executionId: string,
    framework: string | null | undefined,
    interactions: any[],
    user: string | null | undefined,
    primaryName: string | null | undefined,
): Promise<number> {
    const own = computeOwnSkills(framework, interactions);
    const snapped = await snapshotSkillVersions(own, user);
    await persistExecutionSkills(executionId, snapped, { user: user ?? null, primaryName: primaryName ?? null });
    return snapped.length;
}

export interface ExecutionRecord {
    /**
     * Internal ingest provenance. This is consumed before persistence and is
     * intentionally not stored in the Execution table.
     */
    authenticated_ingest?: boolean;
    upload_id?: string;
    task_id?: string;
    query?: string;
    framework?: string;
    tokens?: number;
    cost?: number;
    latency?: number;
    timestamp?: string | Date;
    trace_started_at?: string | Date | null;
    trace_completed_at?: string | Date | null;
    final_result?: string;
    skill?: string;
    rootSkill?: InvokedSkill | null;
    root_skill?: InvokedSkill | null;
    skills?: string[];
    invokedSkills?: InvokedSkill[];
    invoked_skills?: InvokedSkill[];
    agents?: string[];
    langfuseTraceNodes?: LangfuseTraceNode[];

    is_skill_correct?: boolean;
    is_answer_correct?: boolean;
    answer_score?: number | null;
    judgment_reason?: string;

    failures?: {
        failure_type: string;
        description: string;
        context: string;
        recovery: string;
        attribution?: 'SKILL_DEFECT' | 'MODEL_ERROR' | 'ENVIRONMENT';
        attribution_reason?: string;
    }[];

    skill_score?: number | null;
    skill_issues?: any[] | null;
    skill_version?: number | null;
    label?: string | null;
    user?: string | null;
    userTags?: TraceTagDto[];
    model?: string | null;
    /** 真实推理源 URL（scheme://host:port），session↔infra 关联键。 */
    endpoint?: string | null;
    agent?: string | null;
    agentName?: string | null;
    agentType?: string | null;
    agentOwnership?: string | null;
    skip_evaluation?: boolean;
    skip_internal_judgment?: boolean;
    tool_call_count?: number;
    llm_call_count?: number;
    input_tokens?: number;
    output_tokens?: number;
    tool_call_error_count?: number;
    skill_trigger_rate?: number | null;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    max_single_call_tokens?: number;
    reasoning_tokens?: number;
    context_window_pct?: number;
    context_window_limit?: number;
    context_window_source?: string;
    routing_evaluation?: RoutingEvaluationSnapshot;
    outcome_evaluation?: OutcomeEvaluationSnapshot;
    [key: string]: any;
}

function toTraceLifecycleMs(value: unknown): number | null {
    if (value == null) return null;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
        const numeric = Number(trimmed);
        return Number.isFinite(numeric) ? numeric : null;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
}

function inferTraceCompletionFromInteractions(interactions: unknown): Date | null {
    if (!Array.isArray(interactions)) return null;
    const latest = interactions
        .flatMap((interaction) => {
            const item = interaction && typeof interaction === 'object'
                ? interaction as Record<string, unknown>
                : {};
            const timeInfo = item.timeInfo && typeof item.timeInfo === 'object'
                ? item.timeInfo as Record<string, unknown>
                : {};
            const timing = item.timing && typeof item.timing === 'object'
                ? item.timing as Record<string, unknown>
                : {};
            return [
                toTraceLifecycleMs(timeInfo.completed),
                toTraceLifecycleMs(timeInfo.created),
                toTraceLifecycleMs(timing.completed_at),
                toTraceLifecycleMs(timing.started_at),
                toTraceLifecycleMs(item.completedAt),
                toTraceLifecycleMs(item.completed_at),
                toTraceLifecycleMs(item.timestamp),
                toTraceLifecycleMs(item.createdAt),
            ];
        })
        .filter((value): value is number => value != null && Number.isFinite(value) && value > 0)
        .reduce((max, value) => Math.max(max, value), 0);
    return latest > 0 ? new Date(latest) : null;
}

export interface RoutingMatchedSkill {
    skill: string;
    expected_version: number | null;
    invoked_version: number | null;
}

export interface RoutingSkillBreakdown {
    skill: string;
    expected: boolean;
    invoked: boolean;
    matched: boolean;
    status: 'matched' | 'missed' | 'unexpected' | 'not_applicable';
    expected_version: number | null;
    invoked_version: number | null;
}

export interface RoutingEvaluationSnapshot {
    status: 'available' | 'missing';
    matched_config_id?: string;
    matched_query?: string;
    matched_intent?: string;
    matched_anchors?: string[];
    dataset_type?: ConfigDatasetType;
    expected_skills: { skill: string; version: number | null }[];
    invoked_skills: InvokedSkill[];
    matched_skills: RoutingMatchedSkill[];
    expected_count: number;
    matched_count: number;
    is_correct: boolean;
    trigger_rate: number | null;
    skill_breakdown: RoutingSkillBreakdown[];
}

export interface OutcomeSkillBreakdown {
    skill: string;
    version: number | null;
    role: 'primary' | 'invoked' | 'expected_only' | 'context_only';
    is_primary: boolean;
    is_invoked: boolean;
    is_expected: boolean;
    routing_status: RoutingSkillBreakdown['status'] | 'missing_dataset';
    shares_execution_outcome: true;
    score: number | null;
    is_correct: boolean | null;
}

export interface OutcomeEvaluationSnapshot {
    status: 'available' | 'missing' | 'pending';
    matched_config_id?: string;
    matched_query?: string;
    matched_skill?: string;
    matched_skill_version?: number | null;
    dataset_type?: ConfigDatasetType;
    is_correct: boolean | null;
    score: number | null;
    reason?: string;
    standard_answer_present: boolean;
    root_cause_count: number;
    key_action_count: number;
    skill_breakdown: OutcomeSkillBreakdown[];
}

export interface ConfigItem {
    id: string;
    query?: string | null;
    dataset_type?: ConfigDatasetType;
    skill: string;
    skillVersion?: number | null;
    routing_intent?: string;
    routing_anchors?: string[];
    expectedSkills?: { skill: string; version: number | null }[];
    standard_answer: string;
    root_causes?: { content: string; weight: number }[];
    key_actions?: { content: string; weight: number }[];
    parse_status?: string;
    extractedKeyActions?: { id: string; content: string; weight: number; controlFlowType: string; condition?: string; branchLabel?: string; loopCondition?: string; expectedMinCount?: number; expectedMaxCount?: number; skillSource?: string; groupId?: string }[];
}

type ConfigMatchMode = 'any' | 'routing' | 'outcome';

const NO_OUTCOME_MATCH_REASON = '未找到匹配的效果评测配置';

function normalizeQueryForMatch(input: string): string {
    let s = input.trim();
    const pairs: Array<[string, string]> = [
        ['"', '"'],
        ["'", "'"],
        ['“', '”'],
        ['‘', '’'],
        ['`', '`'],
        ['《', '》'],
        ['（', '）'],
        ['(', ')'],
        ['【', '】'],
        ['[', ']'],
        ['{', '}'],
        ['<', '>'],
    ];

    for (let i = 0; i < 6; i++) {
        const before = s;
        s = s.trim();
        for (const [l, r] of pairs) {
            if (s.startsWith(l) && s.endsWith(r) && s.length >= l.length + r.length + 1) {
                s = s.slice(l.length, -r.length);
            }
        }
        if (s === before) break;
    }

    s = s.replace(/[\s"'“”‘’`。.]/g, '');
    s = s.replace(/^[\s.,，。!?！？;；:：、·…]+|[\s.,，。!?！？;；:：、·…]+$/g, '');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
}

export function findBestMatchConfig(
    configs: ConfigItem[],
    userQuery: string | null | undefined,
    matchMode: ConfigMatchMode = 'any'
): ConfigItem | undefined {
    if (!userQuery) return undefined;
    
    const trimmedUserQuery = normalizeQueryForMatch(userQuery);
    if (!trimmedUserQuery) return undefined;
    
    const matchingConfigs = configs
        .filter(c => c.query && c.query.trim())
        .filter(c => {
            const trimmedConfigQuery = normalizeQueryForMatch(c.query || '');
            if (!trimmedConfigQuery) return false;
            return trimmedUserQuery.endsWith(trimmedConfigQuery);
        })
        .filter(c => {
            if (matchMode === 'any') {
                return true;
            }
            return configSupportsDatasetType(c.dataset_type, matchMode);
        });
    
    if (matchingConfigs.length === 0) return undefined;
    
    return matchingConfigs.reduce((best, current) => {
        const bestLen = normalizeQueryForMatch(best.query || '').length;
        const currentLen = normalizeQueryForMatch(current.query || '').length;
        if (currentLen !== bestLen) {
            return currentLen > bestLen ? current : best;
        }

        const bestPriority = getDatasetTypePriority(best.dataset_type, matchMode);
        const currentPriority = getDatasetTypePriority(current.dataset_type, matchMode);
        return currentPriority > bestPriority ? current : best;
    });
}

function getStoredRoutingSignature(config: ConfigItem): RoutingSemanticSignature | null {
    const existingAnchors = Array.isArray(config.routing_anchors)
        ? config.routing_anchors.filter(anchor => typeof anchor === 'string' && anchor.trim())
        : [];

    if (config.routing_intent?.trim() && existingAnchors.length > 0) {
        return {
            intent: config.routing_intent.trim(),
            anchors: existingAnchors,
        };
    }

    return null;
}

export async function findBestRoutingConfig(
    configs: ConfigItem[],
    userQuery: string | null | undefined,
    _user?: string | null
): Promise<ConfigItem | undefined> {
    const normalizedQuery = normalizeConfigQuery(userQuery);
    if (!normalizedQuery) return undefined;

    const candidates = configs.filter(config => configSupportsDatasetType(config.dataset_type, 'routing'));
    const scored: Array<{
        config: ConfigItem;
        signature: RoutingSemanticSignature;
        matchedAnchors: string[];
        anchorCoverage: number;
        intentMatched: boolean;
    }> = [];

    for (const candidate of candidates) {
        const signature = getStoredRoutingSignature(candidate);
        if (!signature) continue;

        const match = matchQueryToStoredRoutingSignature(normalizedQuery, signature);
        if (match.matchedAnchors.length === 0 && !match.intentMatched) {
            continue;
        }

        scored.push({
            config: candidate,
            signature,
            matchedAnchors: match.matchedAnchors,
            anchorCoverage: match.anchorCoverage,
            intentMatched: match.intentMatched,
        });
    }

    if (scored.length === 0) return undefined;

    scored.sort((a, b) => {
        if (b.matchedAnchors.length !== a.matchedAnchors.length) {
            return b.matchedAnchors.length - a.matchedAnchors.length;
        }

        if (b.anchorCoverage !== a.anchorCoverage) {
            return b.anchorCoverage - a.anchorCoverage;
        }

        if (Number(b.intentMatched) !== Number(a.intentMatched)) {
            return Number(b.intentMatched) - Number(a.intentMatched);
        }

        const aPriority = getDatasetTypePriority(a.config.dataset_type, 'routing');
        const bPriority = getDatasetTypePriority(b.config.dataset_type, 'routing');
        if (bPriority !== aPriority) {
            return bPriority - aPriority;
        }

        const aAnchorChars = a.signature.anchors.join('').length;
        const bAnchorChars = b.signature.anchors.join('').length;
        return bAnchorChars - aAnchorChars;
    });

    const best = scored[0];
    best.config.routing_intent = best.signature.intent;
    best.config.routing_anchors = best.signature.anchors;
    return best.config;
}

interface OutcomeTarget {
    skill: string;
    version: number | null;
}

function resolveOutcomeTarget(
    record: Pick<ExecutionRecord, 'skill' | 'skill_version' | 'invokedSkills' | 'skills'>
): OutcomeTarget | undefined {
    const primarySkill = normalizeConfigSkillName(record.skill);
    if (primarySkill) {
        return {
            skill: primarySkill,
            version: record.skill_version ?? null,
        };
    }

    const invokedSkills = getEffectiveInvokedSkills(record);
    const uniqueInvoked = Array.from(
        new Map(
            invokedSkills
                .filter(item => item.name?.trim())
                .map(item => [`${item.name.trim()}::${item.version ?? 'any'}`, item])
        ).values()
    );

    if (uniqueInvoked.length === 1) {
        return {
            skill: uniqueInvoked[0].name.trim(),
            version: uniqueInvoked[0].version ?? null,
        };
    }

    return undefined;
}

export function findBestOutcomeConfig(
    configs: ConfigItem[],
    record: Pick<ExecutionRecord, 'query' | 'skill' | 'skill_version' | 'invokedSkills' | 'skills'>
): ConfigItem | undefined {
    const target = resolveOutcomeTarget(record);
    if (!target) return undefined;
    const normalizedQuery = normalizeConfigQuery(record.query);

    const matchingConfigs = configs
        .filter(config => configSupportsDatasetType(config.dataset_type, 'outcome'))
        .filter(config => normalizeConfigSkillName(config.skill) === target.skill)
        .filter(config => {
            const configVersion = config.skillVersion ?? null;
            return configVersion === null || configVersion === target.version;
        })
        .filter(config => {
            const scenarioQuery = normalizeConfigQuery(config.query);
            if (!scenarioQuery) {
                return true;
            }
            return scenarioQuery === normalizedQuery;
        });

    if (matchingConfigs.length === 0) {
        return undefined;
    }

    return matchingConfigs.reduce((best, current) => {
        const bestExactVersion = (best.skillVersion ?? null) !== null && best.skillVersion === target.version;
        const currentExactVersion = (current.skillVersion ?? null) !== null && current.skillVersion === target.version;
        if (bestExactVersion !== currentExactVersion) {
            return currentExactVersion ? current : best;
        }

        const bestExactScenario = normalizeConfigQuery(best.query) === normalizedQuery;
        const currentExactScenario = normalizeConfigQuery(current.query) === normalizedQuery;
        if (bestExactScenario !== currentExactScenario) {
            return currentExactScenario ? current : best;
        }

        const bestIsCanonical = !normalizeConfigQuery(best.query);
        const currentIsCanonical = !normalizeConfigQuery(current.query);
        if (bestIsCanonical !== currentIsCanonical) {
            return currentIsCanonical ? current : best;
        }

        const bestPriority = getDatasetTypePriority(best.dataset_type, 'outcome');
        const currentPriority = getDatasetTypePriority(current.dataset_type, 'outcome');
        return currentPriority > bestPriority ? current : best;
    });
}

function getEvaluationContextLabel(
    record: Pick<ExecutionRecord, 'query' | 'skill' | 'skill_version'>,
    outcomeConfig?: Pick<ConfigItem, 'query' | 'skill' | 'skillVersion'>
): string {
    return getConfigSubjectLabel({
        query: record.query,
        skill: record.skill || outcomeConfig?.skill || null,
        skillVersion: record.skill_version ?? outcomeConfig?.skillVersion ?? null,
    }, 'Skill execution benchmark');
}

function getRoutingExpectedSkills(config?: ConfigItem): { skill: string; version: number | null }[] {
    if (!config) return [];

    const expectedSkills = normalizeExpectedSkills(config.expectedSkills);

    if (expectedSkills.length > 0) {
        return expectedSkills;
    }

    if (config.skill?.trim()) {
        return [{ skill: config.skill.trim(), version: config.skillVersion ?? null }];
    }

    return [];
}

function getEffectiveInvokedSkills(record: Pick<ExecutionRecord, 'invokedSkills' | 'skills'>): InvokedSkill[] {
    if (Array.isArray(record.invokedSkills) && record.invokedSkills.length > 0) {
        return record.invokedSkills
            .filter(item => item?.name?.trim())
            .map(item => ({ name: item.name.trim(), version: item.version ?? null }));
    }

    if (Array.isArray(record.skills) && record.skills.length > 0) {
        return record.skills
            .filter(name => typeof name === 'string' && name.trim())
            .map(name => ({ name: name.trim(), version: null }));
    }

    return [];
}

export function extractInvokedSkillsFromSessionInteractions(framework: string | null | undefined, interactions: any[]): InvokedSkill[] | null {
    if (!Array.isArray(interactions)) return null;
    const normalized = normalizeInteractions(interactions);
    return getAdapter(framework).extractSkills?.(normalized) ?? null;
}

interface SkillContext {
    skill: string;
    expected_version: number | null;
    invoked_version: number | null;
    primary_version: number | null;
    is_expected: boolean;
    is_invoked: boolean;
    is_primary: boolean;
    is_outcome_anchor: boolean;
}

function collectSkillContexts(
    record: Pick<ExecutionRecord, 'skill' | 'skill_version' | 'invokedSkills' | 'skills'>,
    routingConfig?: ConfigItem,
    outcomeConfig?: ConfigItem
): SkillContext[] {
    const contexts = new Map<string, SkillContext>();

    const upsertContext = (skillName: string | undefined, patch: Partial<SkillContext>) => {
        const trimmed = skillName?.trim();
        if (!trimmed) return;

        const existing = contexts.get(trimmed) || {
            skill: trimmed,
            expected_version: null,
            invoked_version: null,
            primary_version: null,
            is_expected: false,
            is_invoked: false,
            is_primary: false,
            is_outcome_anchor: false,
        };

        contexts.set(trimmed, {
            ...existing,
            ...patch,
            expected_version: patch.expected_version !== undefined ? patch.expected_version : existing.expected_version,
            invoked_version: patch.invoked_version !== undefined ? patch.invoked_version : existing.invoked_version,
            primary_version: patch.primary_version !== undefined ? patch.primary_version : existing.primary_version,
            is_expected: patch.is_expected ?? existing.is_expected,
            is_invoked: patch.is_invoked ?? existing.is_invoked,
            is_primary: patch.is_primary ?? existing.is_primary,
            is_outcome_anchor: patch.is_outcome_anchor ?? existing.is_outcome_anchor,
        });
    };

    upsertContext(record.skill, {
        is_primary: true,
        primary_version: record.skill_version ?? null,
    });

    for (const expected of getRoutingExpectedSkills(routingConfig)) {
        upsertContext(expected.skill, {
            is_expected: true,
            expected_version: expected.version ?? null,
        });
    }

    for (const invoked of getEffectiveInvokedSkills(record)) {
        upsertContext(invoked.name, {
            is_invoked: true,
            invoked_version: invoked.version ?? null,
        });
    }

    if (outcomeConfig?.skill?.trim()) {
        upsertContext(outcomeConfig.skill, {
            is_outcome_anchor: true,
        });
    }

    return Array.from(contexts.values()).sort((a, b) => {
        const aWeight = Number(a.is_primary) * 4 + Number(a.is_invoked) * 2 + Number(a.is_expected);
        const bWeight = Number(b.is_primary) * 4 + Number(b.is_invoked) * 2 + Number(b.is_expected);
        if (aWeight !== bWeight) return bWeight - aWeight;
        return a.skill.localeCompare(b.skill);
    });
}

function getKeyActionFlowTargets(config: ConfigItem): { skill: string; version: number | null }[] {
    const targets = new Map<string, { skill: string; version: number | null }>();

    const addTarget = (rawSkill: string | undefined, rawVersion: number | null | undefined) => {
        const skill = normalizeConfigSkillName(rawSkill);
        if (!skill) return;
        const version = rawVersion ?? null;
        targets.set(`${skill}::${version ?? 'any'}`, { skill, version });
    };

    addTarget(config.skill, config.skillVersion ?? null);

    for (const expected of normalizeExpectedSkills(config.expectedSkills)) {
        addTarget(expected.skill, expected.version ?? null);
    }

    return Array.from(targets.values());
}

async function fillConfigKeyActionsFromParsedFlows(
    config: ConfigItem,
    user?: string | null
): Promise<void> {
    if (!config || (Array.isArray(config.key_actions) && config.key_actions.length > 0)) {
        return;
    }

    const targets = getKeyActionFlowTargets(config);
    if (targets.length === 0) {
        return;
    }

    const allActions: { name: string; actions: ExtractedKeyAction[] }[] = [];

    for (const target of targets) {
        const skill = await db.findSkill(target.skill, user || null);
        if (!skill) {
            continue;
        }

        const resolvedVersion = target.version
            ?? skill.activeVersion
            ?? skill.versions?.[0]?.version
            ?? null;
        if (resolvedVersion == null) {
            continue;
        }

        const parsedFlow = await db.findParsedFlow(skill.id, resolvedVersion, user || null);
        if (!parsedFlow?.flowJson) {
            continue;
        }

        const flow: ParsedFlowResult = JSON.parse(parsedFlow.flowJson);
        const actions = extractKeyActionsFromFlow(flow).map(action => ({
            ...action,
            skillSource: action.skillSource || target.skill,
        }));

        if (actions.length > 0) {
            allActions.push({ name: target.skill, actions });
        }
    }

    if (allActions.length === 0) {
        return;
    }

    const extractedActions = allActions.length === 1
        ? allActions[0].actions
        : mergeKeyActionsFromMultipleSkills(allActions);

    config.key_actions = extractedActions.map(action => ({
        content: action.content,
        weight: action.weight,
        ...(action.controlFlowType !== 'required' ? { controlFlowType: action.controlFlowType } : {}),
        ...(action.condition ? { condition: action.condition } : {}),
        ...(action.branchLabel ? { branchLabel: action.branchLabel } : {}),
        ...(action.loopCondition ? { loopCondition: action.loopCondition } : {}),
        ...(action.expectedMinCount !== undefined ? { expectedMinCount: action.expectedMinCount } : {}),
        ...(action.expectedMaxCount !== undefined ? { expectedMaxCount: action.expectedMaxCount } : {}),
        ...(action.groupId ? { groupId: action.groupId } : {}),
    }));
    config.extractedKeyActions = extractedActions;

    try {
        await db.updateConfig(config.id, {
            keyActions: JSON.stringify(config.key_actions),
            extractedKeyActions: JSON.stringify(extractedActions),
        });
        console.log(`[AutoExtract] Auto-filled key_actions for config ${config.id} from ${targets.map(target => target.skill).join(', ')}`);
    } catch (err) {
        console.error('[AutoExtract] Error updating config with extracted key_actions:', err);
    }
}

async function buildRoutingEvaluationSnapshot(
    record: Pick<ExecutionRecord, 'query' | 'skill' | 'skill_version' | 'invokedSkills' | 'skills' | 'user'>,
    routingConfig?: ConfigItem,
    evaluationUser?: string | null
): Promise<RoutingEvaluationSnapshot> {
    const invokedSkills = getEffectiveInvokedSkills(record);
    const skillContexts = collectSkillContexts(record, routingConfig);

    if (!routingConfig) {
        return {
            status: 'missing',
            expected_skills: [],
            invoked_skills: invokedSkills,
            matched_skills: [],
            matched_anchors: [],
            expected_count: 0,
            matched_count: 0,
            is_correct: false,
            trigger_rate: null,
            skill_breakdown: skillContexts.map(context => ({
                skill: context.skill,
                expected: context.is_expected,
                invoked: context.is_invoked,
                matched: false,
                status: context.is_invoked ? 'unexpected' : 'not_applicable',
                expected_version: context.expected_version,
                invoked_version: context.invoked_version,
            })),
        };
    }

    const expectedSkills = getRoutingExpectedSkills(routingConfig);
    const matchedSkills: RoutingMatchedSkill[] = [];

    let correctInvokedSkills = 0;
    const skillsMap = new Map<string, { activeVersion?: number | null }>();

    const skillNamesForLookup = expectedSkills
        .filter(expected =>
            expected.version !== null
            && !invokedSkills.some(invoked => invoked.name === expected.skill && invoked.version !== null)
        )
        .map(expected => expected.skill);

    if (skillNamesForLookup.length > 0) {
        try {
            const skills = await db.findSkills({
                name: { in: skillNamesForLookup },
                user: evaluationUser || null,
            });

            for (const skill of skills) {
                skillsMap.set(skill.name, skill);
            }
        } catch (err) {
            console.error('[RoutingEvaluation] Error fetching skills for version check:', err);
        }
    }

    for (const expected of expectedSkills) {
        const matchingInvoked = invokedSkills.find(item => item.name === expected.skill);
        if (!matchingInvoked) continue;

        let isVersionMatch = false;
        if (expected.version === null) {
            isVersionMatch = true;
        } else if (matchingInvoked.version !== null) {
            isVersionMatch = matchingInvoked.version === expected.version;
        } else {
            const skill = skillsMap.get(expected.skill);
            const actualVersion = skill ? (skill.activeVersion || 0) : null;
            isVersionMatch = actualVersion === expected.version;
        }

        if (isVersionMatch) {
            correctInvokedSkills += 1;
            matchedSkills.push({
                skill: expected.skill,
                expected_version: expected.version,
                invoked_version: matchingInvoked.version ?? null,
            });
        }
    }

    const skillBreakdown: RoutingSkillBreakdown[] = skillContexts.map(context => {
        const matched = matchedSkills.some(item => item.skill === context.skill);
        let status: RoutingSkillBreakdown['status'] = 'not_applicable';

        if (context.is_expected) {
            status = matched ? 'matched' : 'missed';
        } else if (context.is_invoked) {
            status = 'unexpected';
        }

        return {
            skill: context.skill,
            expected: context.is_expected,
            invoked: context.is_invoked,
            matched,
            status,
            expected_version: context.expected_version,
            invoked_version: context.invoked_version,
        };
    });

    return {
        status: 'available',
        matched_config_id: routingConfig.id,
        matched_query: normalizeConfigQuery(routingConfig.query) || undefined,
        matched_intent: routingConfig.routing_intent || undefined,
        matched_anchors: routingConfig.routing_anchors || [],
        dataset_type: normalizeConfigDatasetType(routingConfig.dataset_type),
        expected_skills: expectedSkills,
        invoked_skills: invokedSkills,
        matched_skills: matchedSkills,
        expected_count: expectedSkills.length,
        matched_count: correctInvokedSkills,
        is_correct: correctInvokedSkills > 0,
        trigger_rate: expectedSkills.length > 0 ? correctInvokedSkills / expectedSkills.length : null,
        skill_breakdown: skillBreakdown,
    };
}

function buildOutcomeEvaluationSnapshot(
    record: Pick<ExecutionRecord, 'skill' | 'skill_version' | 'invokedSkills' | 'skills' | 'answer_score' | 'is_answer_correct' | 'judgment_reason'>,
    outcomeConfig?: ConfigItem,
    routingConfig?: ConfigItem,
    routingEvaluation?: RoutingEvaluationSnapshot
): OutcomeEvaluationSnapshot {
    const skillContexts = collectSkillContexts(record, routingConfig, outcomeConfig);
    const buildSkillBreakdown = (score: number | null, isCorrect: boolean | null): OutcomeSkillBreakdown[] =>
        skillContexts.map(context => {
            let role: OutcomeSkillBreakdown['role'] = 'context_only';
            if (context.is_primary) {
                role = 'primary';
            } else if (context.is_invoked) {
                role = 'invoked';
            } else if (context.is_expected) {
                role = 'expected_only';
            }

            const routingStatus = routingEvaluation?.status === 'available'
                ? (routingEvaluation.skill_breakdown.find(item => item.skill === context.skill)?.status || 'not_applicable')
                : 'missing_dataset';

            return {
                skill: context.skill,
                version: context.invoked_version ?? context.primary_version ?? context.expected_version ?? null,
                role,
                is_primary: context.is_primary,
                is_invoked: context.is_invoked,
                is_expected: context.is_expected,
                routing_status: routingStatus,
                shares_execution_outcome: true,
                score,
                is_correct: isCorrect,
            };
        });

    if (!outcomeConfig) {
        return {
            status: 'missing',
            is_correct: null,
            score: null,
            reason: record.judgment_reason || NO_OUTCOME_MATCH_REASON,
            standard_answer_present: false,
            root_cause_count: 0,
            key_action_count: 0,
            skill_breakdown: buildSkillBreakdown(null, null),
        };
    }

    const status = record.judgment_reason === '结果评估中...' ? 'pending' : 'available';
    const score = status === 'pending' ? null : (record.answer_score ?? null);
    const isCorrect = status === 'pending' ? null : (record.is_answer_correct ?? null);

    return {
        status,
        matched_config_id: outcomeConfig.id,
        matched_query: normalizeConfigQuery(outcomeConfig.query) || undefined,
        matched_skill: normalizeConfigSkillName(outcomeConfig.skill) || undefined,
        matched_skill_version: outcomeConfig.skillVersion ?? null,
        dataset_type: normalizeConfigDatasetType(outcomeConfig.dataset_type),
        is_correct: isCorrect,
        score,
        reason: record.judgment_reason || undefined,
        standard_answer_present: Boolean(outcomeConfig.standard_answer),
        root_cause_count: outcomeConfig.root_causes?.length ?? 0,
        key_action_count: outcomeConfig.key_actions?.length ?? 0,
        skill_breakdown: buildSkillBreakdown(score, isCorrect),
    };
}

async function attachEvaluationSnapshots(
    record: ExecutionRecord,
    configs: ConfigItem[],
    evaluationUser?: string | null
): Promise<ExecutionRecord> {
    const routingConfig = record.query ? await findBestRoutingConfig(configs, record.query, evaluationUser ?? record.user ?? null) : undefined;
    const outcomeConfig = findBestOutcomeConfig(configs, record);
    const routingEvaluation = await buildRoutingEvaluationSnapshot(record, routingConfig, evaluationUser ?? record.user ?? null);
    const executionId = record.task_id || record.upload_id || '';
    let executionMatch: {
        matchJson?: string | null;
        matchedAt?: string | Date | null;
        mode?: string | null;
    } | null = null;

    if (executionId) {
        try {
            const match = await db.findExecutionMatch(executionId);
            if (match) {
                executionMatch = {
                    matchJson: match.matchJson ?? null,
                    matchedAt: match.matchedAt ?? null,
                    mode: match.mode ?? null,
                };
            }
        } catch {
            executionMatch = null;
        }
    }

    return {
        ...record,
        routing_evaluation: routingEvaluation,
        outcome_evaluation: buildOutcomeEvaluationSnapshot(record, outcomeConfig, routingConfig, routingEvaluation),
        execution_match: executionMatch,
    };
}

const DATA_DIR = resolveAgentInsightDataPath();
const EVALUATION_FILE = path.join(DATA_DIR, 'evaluation_result.json');
const AUDIT_DATA_MUTATIONS = process.env.AUDIT_DATA_MUTATIONS === '1' || process.env.AUDIT_DATA_MUTATIONS === 'true';

interface ReadRecordFilters {
    query?: string;
    taskId?: string;
    taskIds?: string[];
    agentName?: string;
    framework?: string;
    skill?: string;
    skillVersion?: number;
    showAllUsers?: boolean;
    /** 显式 true 才会把 sub-agent execution 行也返回（默认不返回，保持主列表干净） */
    includeSubagents?: boolean;
    /** 只返回 sub-agent 行（不含 root），与 includeSubagents 互斥；优先级高于 includeSubagents */
    onlySubagents?: boolean;
    /** 列出指定 root 下的所有 sub-agent */
    parentExecutionId?: string | null;
    /**
     * 统一过滤器模型子句(operator 模型,见 src/lib/filters)。只下推 pushable 实列
     * (execution / observedAgents);skill / 计算列(status/ownership)由各自既有通道处理。
     */
    clauses?: FilterClause[];
    /** business 标签筛选，值为 Tag.id，支持多个 OR 命中 */
    businessTagIds?: string[];
    /** Trace 列表顶部时间筛选换算后的起始时间。 */
    timestampFrom?: Date;
    /** Trace 列表 Agent 归属筛选；按现有 RegisteredAgent + 内置系统 Agent 规则下推。 */
    ownership?: 'user' | 'system';
    /** Trace 列表兼容 agentName 为空、名称仅存在于 observedAgents 的历史记录。 */
    observedAgentFallback?: boolean;
}

interface ReadRecordsOptions {
    attachEvaluations?: boolean;
    page?: number;
    pageSize?: number;
    /**
     * 轻量返回:findExecutions 排除大字段 finalResult、完全跳过 session interactions 解析、
     * 跳过每条 execution_match、强制不附评测快照;agents 改从已持久化的子 agent 行批量还原。
     * 把每条记录从 KB–MB 降到几百字节,根治非分页路径的 next-server 堆 OOM(仅 SQLite/Prisma 路径正确)。
     */
    lightweight?: boolean;
    /** 是否批量附加用户标签；默认关闭，避免旧列表无谓 join */
    includeTags?: boolean;
    /** 数据库排序字段；仅允许 Execution 标量列白名单。 */
    sortKey?: 'timestamp' | 'agentName' | 'latency' | 'tokens' | 'cost';
    sortDir?: 'asc' | 'desc';
    /** Trace 列表显式启用；其他 readRecordPage 调用方保持原有全量去重后分页语义。 */
    databasePagination?: boolean;
}

export function resolveExecutionSubagentFilter(filters?: {
    includeSubagents?: boolean;
    onlySubagents?: boolean;
    parentExecutionId?: string | null;
    taskId?: string;
    taskIds?: string[];
    skill?: string;
}): boolean | undefined {
    if (filters?.onlySubagents === true) return true;
    if (
        filters?.includeSubagents === true
        || filters?.parentExecutionId !== undefined
        || filters?.taskId
        || filters?.taskIds?.length
    ) return undefined;
    return false;
}

export interface ReadRecordPageStats {
    total: number;
    failedCount: number;
    avgLatencyMs: number;
    toolErrorRate: number;
}

async function appendExecutionOwnershipWhere(
    where: Record<string, any>,
    ownership?: 'user' | 'system',
): Promise<void> {
    if (!ownership) return;
    try {
        const ownershipWhere = await buildExecutionOwnershipWhere(ownership);
        where.AND = [...((where.AND as any[]) ?? []), ownershipWhere];
    } catch (e) {
        console.warn('[readRecords] system agent ownership lookup failed:', (e as Error)?.message);
        const fallbackWhere = ownership === 'system'
            ? { agentName: { in: [...SYSTEM_AGENT_NAMES] } }
            : {
                OR: [
                    { agentName: null },
                    { agentName: { notIn: [...SYSTEM_AGENT_NAMES] } },
                ],
            };
        where.AND = [...((where.AND as any[]) ?? []), fallbackWhere];
    }
}

export async function listObservedAgentNames(user?: string, observedAgentFallback = false): Promise<string[]> {
    const where: any = { isSubagent: false };
    if (user) {
        // 只看 user=自己；无主(null)不可见(与 trace 列表口径一致)。
        where.user = user;
    }

    const records = await db.findExecutions(
        where,
        { timestamp: 'desc' },
        { agentName: true, observedAgents: true },
    );
    const names: string[] = [];
    const seen = new Set<string>();
    for (const record of records) {
        const name = String(
            record?.agentName
            || (observedAgentFallback
                ? parseObservedAgents(record?.observedAgents).find(agent => !isEvaluatorAgentName(agent))
                : '')
            || '',
        ).trim();
        if (!name || seen.has(name) || isEvaluatorAgentName(name)) continue;
        seen.add(name);
        names.push(name);
    }
    return names;
}

/**
 * 列出该 user 可见的全部 skill(name + 出现过的版本),用于 /trace 等页面的 skill 下拉 facet。
 * 走 ExecutionSkill(agent 作用域,含 sub-agent 用到的 skill);ES 不可用/未回填时降级到 Execution.skill 列。
 */
export async function listObservedSkills(user?: string): Promise<{ name: string; versions: number[] }[]> {
    const byName = new Map<string, Set<number>>();
    if (EXECUTION_SKILL_ENABLED) {
        try {
            const esWhere: any = {};
            if (user) esWhere.user = user;
            const rows = await prismaRaw.executionSkill.findMany({
                where: esWhere,
                select: { skillName: true, skillVersion: true },
                distinct: ['skillName', 'skillVersion'],
            });
            for (const r of rows) {
                if (!r.skillName) continue;
                const set = byName.get(r.skillName) ?? new Set<number>();
                if (typeof r.skillVersion === 'number') set.add(r.skillVersion);
                byName.set(r.skillName, set);
            }
        } catch (e) {
            console.warn('[listObservedSkills] ExecutionSkill query failed, falling back to legacy column:', e);
        }
    }
    if (byName.size === 0) {
        // 降级:从 Execution.skill / skillVersion 列汇总(OpenGauss 或尚未回填)。
        const where: any = {};
        if (user) where.user = user;
        const records = await db.findExecutions(where, { timestamp: 'desc' }, { skill: true, skillVersion: true } as any);
        for (const r of records) {
            const name = String(r?.skill || '').trim();
            if (!name) continue;
            const set = byName.get(name) ?? new Set<number>();
            if (typeof r.skillVersion === 'number') set.add(r.skillVersion);
            byName.set(name, set);
        }
    }
    return Array.from(byName.entries())
        .map(([name, vs]) => ({ name, versions: Array.from(vs).sort((a, b) => a - b) }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 某个分类列的观测值 + 出现次数,给过滤器值下拉(facet)用 —— 对标 langfuse SUGGESTIONS 的「值 + 件数」。
 * 仅允许白名单内的真实标量列 groupBy(防任意列注入);root 作用域、按 user 隔离,与其它 facet 口径一致。
 */
const FACETABLE_COLUMNS = new Set(['framework', 'agentName', 'model', 'subagentType']);
export async function listObservedFieldValues(
    column: string,
    user?: string,
): Promise<{ value: string; count: number }[]> {
    // skill 不是 Execution 标量列:计数走 ExecutionSkill(与 skill 过滤同源,agent 作用域),
    // 按 skillName 聚合(每 (executionId, skillName) 一行 ⇒ 近似「用到该 skill 的 trace 数」)。
    if (column === 'skill') {
        try {
            const rows = await prismaRaw.executionSkill.groupBy({
                by: ['skillName'],
                where: user ? { user } : undefined,
                _count: { executionId: true },
            });
            return rows
                .map((r) => ({ value: String(r.skillName ?? ''), count: r._count.executionId ?? 0 }))
                .filter((r) => r.value !== '')
                .sort((a, b) => b.count - a.count);
        } catch (e) {
            console.warn('[listObservedFieldValues] skill groupBy failed:', (e as Error)?.message);
            return [];
        }
    }
    if (!FACETABLE_COLUMNS.has(column)) return [];
    const where: any = { isSubagent: false, [column]: { not: null } };
    if (user) where.user = user;
    try {
        const rows = await prismaRaw.execution.groupBy({
            by: [column] as any,
            where,
            _count: { _all: true },
        });
        return rows
            .map((r: any) => ({ value: String(r[column] ?? ''), count: r._count?._all ?? 0 }))
            .filter((r: { value: string }) => r.value !== '')
            .sort((a: { count: number }, b: { count: number }) => b.count - a.count);
    } catch (e) {
        console.warn('[listObservedFieldValues] groupBy failed:', column, (e as Error)?.message);
        return [];
    }
}

export async function listObservedTraceIds(
    user?: string,
    agentName?: string,
): Promise<string[]> {
    const where: any = { isSubagent: false };
    if (user) {
        // 只看 user=自己；无主(null)不可见(与 trace 列表口径一致)。
        where.user = user;
    }
    if (agentName) {
        where.agentName = agentName;
    }

    const records = await db.findExecutions(where, { timestamp: 'desc' });
    const traceIds: string[] = [];
    const seenTaskIds = new Set<string>();
    for (const record of records) {
        const taskId = String(record?.taskId || '').trim();
        if (taskId) {
            if (seenTaskIds.has(taskId)) continue;
            seenTaskIds.add(taskId);
            traceIds.push(taskId);
            continue;
        }
        const uploadId = String(record?.id || '').trim();
        if (uploadId) traceIds.push(uploadId);
    }
    return traceIds;
}

// 轻量列表用的 Execution 列投影:穷举 schema.prisma 的 Execution 全部标量列,仅排除大字段 finalResult
// 与 evaluations 关系。normalizedRecord 用 `{ ...r }` 整体展开,故凡前端可能读的列都要在此列出。
// 注意:必须只含真实列名——例如 expectedSkillVersion 不是 Execution 列(今天即恒 undefined→null),不能放入。
// 导出供测试断言"不含 finalResult"。
export const LIGHT_EXECUTION_SELECT: Record<string, boolean> = {
    id: true, taskId: true, query: true, framework: true, tokens: true, cost: true, latency: true,
    toolCallCount: true, llmCallCount: true, inputTokens: true, outputTokens: true, toolCallErrorCount: true,
    cacheReadInputTokens: true, cacheCreationInputTokens: true, maxSingleCallTokens: true, reasoningTokens: true,
    timestamp: true, model: true, agentName: true, agentId: true, skill: true, skills: true, invokedSkills: true,
    isSkillCorrect: true, isAnswerCorrect: true, answerScore: true, skillScore: true, judgmentReason: true,
    failures: true, skillIssues: true, skillVersion: true, label: true, user: true, skillTriggerRate: true,
    parentExecutionId: true, rootExecutionId: true, agentSessionId: true, subagentType: true,
    subagentName: true, isSubagent: true, observedAgents: true,
    // 排除: finalResult(大字段,轻量模式的核心), evaluations(关系)
};

/**
 * 解析 denormalized 的 observedAgents 列(JSON string[]),供轻量模式还原 agents。
 * observedAgents 在写入时由 extractObservedAgentNames(interactions) 算好存入(见 saveExecutionRecord),
 * 与读侧 heavy 路径同源同口径,故 light 的 agents 与 heavy 完全一致、不丢任何 agent 名(含 opencode 'build' 等)。
 * 导出供测试。
 */
export function parseObservedAgents(observedAgents: string | null | undefined): string[] {
    if (!observedAgents) return [];
    try {
        const arr: unknown = JSON.parse(observedAgents);
        return Array.isArray(arr)
            ? arr.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
            : [];
    } catch {
        return [];
    }
}

// 按批 hydrate 的批大小:每批只把本批记录的 finalResult + session(整段 interactions 是最大
// 内存来源)拉进内存,解析/归一化后即释放。分页路径 pageSize≤100 → 单批;非分页路径
// (paged===filtered)按此切批,峰值内存从 O(全量 session) 降到 O(批大小)。
// 可经 READ_RECORDS_HYDRATE_BATCH_SIZE 环境变量调小(内存吃紧的线上机)或调大(批查询更少);
// 非法/缺省回落 100。批大小只影响峰值内存与查询次数,不影响返回结果(等价性见
// scripts/dryrun_readrecords_batched.ts)。
const READ_RECORDS_HYDRATE_BATCH_SIZE = Math.max(
    1,
    Math.trunc(Number(process.env.READ_RECORDS_HYDRATE_BATCH_SIZE)) || 100,
);

/** 把数组切成定长批次(最后一批可短)。size≤0 兜底成 1;空数组返回 []。导出供测试。 */
export function chunk<T>(arr: T[], size: number): T[][] {
    const n = Math.max(1, Math.trunc(size));
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
}

/**
 * dedup-by-taskId:同一 taskId 可能有多条 Execution 行(id≠taskId 的重复上报),选一条 canonical。
 * 规则:组内唯一→留;存在 id===taskId→留它;否则按 timestamp desc → id localeCompare 稳定兜底。
 * taskId 为空的行不参与去重(各自保留,由调用方原样透传)。
 * dedup 这一遍统一走 light 投影(无 finalResult),故不再用 finalResult 长度做 tiebreak——该
 * tiebreak 仅在"同 taskId 多行+时间戳完全相同+无 canonical"时才生效,极罕见,统一到 id 兜底
 * (与既有 light 模式行为一致)。返回 byTaskId 供调用方做重复行清理。导出供测试。
 */
export type DedupRow = { id: string; taskId?: string | null; timestamp?: string | number | Date | null };

export function selectKeepIdsByTaskId<T extends DedupRow>(
    records: T[],
): { keepIds: Set<string>; byTaskId: Map<string, T[]> } {
    const byTaskId = new Map<string, T[]>();
    for (const r of records) {
        const tid = r.taskId || null;
        if (!tid) continue;
        if (!byTaskId.has(tid)) byTaskId.set(tid, []);
        byTaskId.get(tid)!.push(r);
    }
    const keepIds = new Set<string>();
    for (const [tid, group] of byTaskId.entries()) {
        if (group.length === 1) {
            keepIds.add(group[0].id);
            continue;
        }
        const canonical = group.find(x => x.id === tid);
        if (canonical) {
            keepIds.add(canonical.id);
            continue;
        }
        const sorted = group.slice().sort((a, b) => {
            const ta = new Date(a.timestamp ?? 0).getTime();
            const tb = new Date(b.timestamp ?? 0).getTime();
            if (tb !== ta) return tb - ta;
            return String(a.id).localeCompare(String(b.id));
        });
        keepIds.add(sorted[0].id);
    }
    return { keepIds, byTaskId };
}

/**
 * 把一批已去重的 Execution 行 hydrate 成对外 ExecutionRecord:载本批 finalResult + session,
 * 解析 interactions 还原 agents/invokedSkills/rootSkill,补 ownership / 懒回填 skillVersion /
 * execution_match / 评测快照。每批用完即释放——这是把非分页路径"一次性全量 session"的堆 OOM
 * 根治掉的关键。light 批跳过 finalResult/session 加载,agents/skills 从 denormalized 列还原。
 */
async function hydrateAndNormalizeBatch(
    batch: any[],
    ctx: {
        user?: string;
        light: boolean;
        attachEvaluations: boolean;
        includeTags: boolean;
        getConfigsForEvaluationUser: (evaluationUser?: string | null) => Promise<ConfigItem[]>;
    },
): Promise<ExecutionRecord[]> {
    const { user, light, attachEvaluations, includeTags, getConfigsForEvaluationUser } = ctx;

    // heavy: dedup pass 走 light 投影未取 finalResult,这里按本批 id 回取。
    // skills/invokedSkills/rootSkill 一律从 ExecutionSkill(写入时已按 agent 作用域算好并定格版本)批量取,
    // agents 从 denormalize 的 observedAgents 列还原 —— 两者都不再逐行加载/解析 session interactions。
    // 这是列表页"频繁大量重复解析 → 卡死"的根因;去掉后 hydrate 与数据量解耦,light/heavy 仅差 finalResult。
    const execIds = batch.map((r: any) => r.id);
    const tagsByExec = includeTags
        ? await getTraceTagsByExecutionIds(execIds, user).catch((e: unknown) => {
            console.warn('[readRecords] trace tag batch fetch failed:', e);
            return new Map<string, TraceTagDto[]>();
        })
        : new Map<string, TraceTagDto[]>();
    const finalResultRows = (!light && execIds.length > 0)
        ? await db.findExecutions({ id: { in: execIds } }, undefined, { id: true, finalResult: true })
        : [];
    if (finalResultRows.length > 0) {
        const finalById = new Map<string, any>();
        for (const fr of finalResultRows) finalById.set(fr.id, fr.finalResult ?? null);
        for (const r of batch) {
            if (finalById.has(r.id)) r.finalResult = finalById.get(r.id);
        }
    }

    // 批量取本批所有 Execution 的 agent 作用域 skill 绑定。
    const esByExec = new Map<string, InvokedSkill[]>();
    const esPrimaryByExec = new Map<string, InvokedSkill>();
    if (EXECUTION_SKILL_ENABLED && execIds.length > 0) {
        try {
            const esRows = await prismaRaw.executionSkill.findMany({
                where: { executionId: { in: execIds } },
                select: { executionId: true, skillName: true, skillVersion: true, isPrimary: true },
            });
            for (const e of esRows) {
                const item: InvokedSkill = { name: e.skillName, version: e.skillVersion ?? null };
                const arr = esByExec.get(e.executionId);
                if (arr) arr.push(item); else esByExec.set(e.executionId, [item]);
                if (e.isPrimary && !esPrimaryByExec.has(e.executionId)) esPrimaryByExec.set(e.executionId, item);
            }
        } catch (e) {
            console.warn('[readRecords] ExecutionSkill batch fetch failed, falling back to legacy columns:', e);
        }
    }

    // agents + effective agent name(for ownership)——一律从 denormalize 的 observedAgents 列还原,不解析 interactions。
    const recordAgentsByTaskId = new Map<string, string[]>();
    const recordEffectiveAgent = new Map<string, string>();
    const resolveEffectiveAgentName = (agentName: string | null | undefined, sessionAgents: string[]): string => {
        const direct = (agentName || '').trim();
        if (direct) return direct;
        return sessionAgents.find(n => n && !isEvaluatorAgentName(n)) || '';
    };
    batch.forEach((r: any) => {
        const taskId = r.taskId || r.id;
        const sessionAgents = parseObservedAgents(r.observedAgents);
        recordAgentsByTaskId.set(taskId, sessionAgents);
        recordEffectiveAgent.set(taskId, resolveEffectiveAgentName(r.agentName, sessionAgents));
    });

    // Build ownership map keyed by "platform::effectiveAgentName" — ownership is an attribute
    // of agent identity (platform + name). The `user` dimension is collapsed so a given agent
    // name resolves to one ownership regardless of which user's execution record we look at.
    // When multiple registrations exist for (platform, name) across users, prefer
    // system > user: 一个全局注册的系统 Agent（user=null）是权威归属，即使同名还存在
    // 各 user 的 trace 自动发现行（observe 时落库为 user），也应判定为 system。
    const OWNERSHIP_RANK: Record<string, number> = { system: 2, user: 1 };
    const agentOwnershipMap = new Map<string, string>();
    const uniqueAgents = new Map<string, { platform: string; name: string }>();
    batch.forEach((r: any) => {
        const taskId = r.taskId || r.id;
        const effective = recordEffectiveAgent.get(taskId) || '';
        if (r.framework && effective) {
            const k = `${r.framework}::${effective}`;
            if (!uniqueAgents.has(k)) uniqueAgents.set(k, { platform: r.framework, name: effective });
        }
    });
    if (uniqueAgents.size > 0) {
        try {
            const agents = await (prisma as any).registeredAgent.findMany({
                where: { OR: Array.from(uniqueAgents.values()) },
                select: { platform: true, name: true, agentOwnership: true },
            });
            for (const a of agents) {
                const key = `${a.platform}::${a.name}`;
                const existing = agentOwnershipMap.get(key);
                if (!existing || (OWNERSHIP_RANK[a.agentOwnership] ?? 0) > (OWNERSHIP_RANK[existing] ?? 0)) {
                    agentOwnershipMap.set(key, a.agentOwnership);
                }
            }
        } catch { /* graceful degradation — ownership stays 'user' */ }
    }

    /* ─── 懒回填 Skill 版本绑定 ─────────────────────────────────────────
     * 当 Execution.skillVersion 为空但 Execution.skill 命中 DB 已注册 skill 时，
     * 把当前 activeVersion 回写到 Execution.skillVersion，并同步更新 r.skillVersion
     * 让本次返回也带上版本号。常见场景：trace 上传时 skill 还没注册，之后注册了，
     * 下一次列表加载时自动补上绑定。已绑定的不动。
     *
     * 实现：先一次性把"未绑定但有 skill 名"的记录涉及到的 skill 名汇总，
     * 一次 DB 查询拿到所有 (name → activeVersion) 映射；map 阶段按需 UPDATE
     * 单条 Execution。fire-and-forget——回填失败不影响本次返回。
     */
    const skillNamesNeedingBackfill = new Set<string>();
    batch.forEach((r: any) => {
        if (r.skill && (r.skillVersion == null) && !r.isSubagent) {
            skillNamesNeedingBackfill.add(String(r.skill));
        }
    });
    const skillActiveVersionMap = new Map<string, number>();
    if (skillNamesNeedingBackfill.size > 0 && user) {
        try {
            const skillRows = await (prisma as any).skill.findMany({
                where: {
                    name: { in: Array.from(skillNamesNeedingBackfill) },
                    OR: [{ user }, { user: null }],
                },
                select: { name: true, activeVersion: true },
            });
            for (const s of skillRows) {
                if (typeof s.activeVersion === 'number') {
                    skillActiveVersionMap.set(s.name, s.activeVersion);
                }
            }
        } catch (e) {
            console.warn('[readRecords] skill version backfill lookup failed:', e);
        }
    }

    const normalizedBatch = await Promise.all(batch.map(async (r: any) => {
        const model = r.model ?? null;
        const pricingResult = model ? getModelPricing(model) : null;
        const pricing = pricingResult?.pricing ?? null;
        const cwResult = (model && r.maxSingleCallTokens != null) ? getModelContextWindow(model) : null;

        const taskKey = r.taskId || r.id;
        const agents = recordAgentsByTaskId.get(taskKey) || [];
        const effectiveAgentName = recordEffectiveAgent.get(taskKey) || '';

        // agent 作用域的 skill 绑定来自 ExecutionSkill(写入时算好);无绑定(历史未回填 / OpenGauss 降级)
        // 回退到旧的 invokedSkills/skills JSON 列。不再解析 session interactions。
        let invokedSkills: InvokedSkill[] | null = esByExec.get(r.id) ?? null;
        if (!invokedSkills && r.invokedSkills) {
            try { const p = JSON.parse(r.invokedSkills); if (Array.isArray(p)) invokedSkills = p; } catch { /* ignore */ }
        }
        const rootSkillFromExecution: InvokedSkill | null = (!r.isSubagent && r.skill)
            ? { name: String(r.skill), version: typeof r.skillVersion === 'number' ? r.skillVersion : null }
            : null;
        let rootSkill: InvokedSkill | null = rootSkillFromExecution ?? esPrimaryByExec.get(r.id) ?? null;

        // 懒回填：Execution.skillVersion 为空但 skill 名命中 DB → 回写 activeVersion。
        // 在 in-memory r 上即时更新（喂下方 rootSkill 兜底），同时 fire-and-forget UPDATE DB。仅 root 行。
        if (r.skill && r.skillVersion == null && !r.isSubagent && skillActiveVersionMap.has(String(r.skill))) {
            const backfilled = skillActiveVersionMap.get(String(r.skill))!;
            r.skillVersion = backfilled;
            // fire-and-forget；只更原本 NULL 的（WHERE 守卫防意外覆盖）
            (prisma as any).execution.updateMany({
                where: { id: r.id, skillVersion: null },
                data: { skillVersion: backfilled },
            }).catch((e: unknown) => console.warn('[readRecords] backfill skillVersion failed for', r.id, ':', e));
        }
        // 兜底：sub-agent 或历史行没有 isPrimary 时,用 Execution 行 denormalized 的 skill 补全 rootSkill。
        if (!rootSkill && r.skill) {
            rootSkill = { name: String(r.skill), version: typeof r.skillVersion === 'number' ? r.skillVersion : null };
        }

        const normalizedRecord: ExecutionRecord = {
            ...r,
            upload_id: r.id,
            task_id: r.taskId || undefined,
            query: r.query || undefined,
            framework: r.framework || undefined,
            agent: r.agentName || undefined,
            agentName: r.agentName || undefined,
            // 归属兜底：已知系统/内置 Agent 名（评估器等）一律判 system，与 framework 无关。
            // 修复同一逻辑系统 Agent 换 framework（如评估器的 direct-llm 路径）逃出 (platform,name)
            // 注册、被误判为 user 的问题。写侧登记 + 启动迁移见 system-agents.ts，此处为框架无关兜底。
            agentOwnership: isInternalSystemAgentTrace(effectiveAgentName)
                ? 'system'
                : (r.framework && effectiveAgentName)
                    ? (agentOwnershipMap.get(`${r.framework}::${effectiveAgentName}`) ?? 'user')
                    : 'user',
            tokens: r.tokens || undefined,
            cost: (pricing && r.inputTokens != null && r.outputTokens != null)
                ? calculateCost(r.inputTokens, r.outputTokens, pricing, r.cacheReadInputTokens ?? undefined, r.cacheCreationInputTokens ?? undefined)
                : undefined,
            latency: r.latency || undefined,
            timestamp: r.timestamp?.toISOString?.() || r.timestamp,
            final_result: r.finalResult || undefined,
            skill: r.skill || undefined,
            rootSkill: rootSkill,
            root_skill: rootSkill,
            skills: invokedSkills ? invokedSkills.map(s => s.name) : (r.skills ? JSON.parse(r.skills) : undefined),
            invokedSkills: invokedSkills ?? undefined,
            invoked_skills: invokedSkills ?? undefined,
            is_skill_correct: r.isSkillCorrect ?? false,
            is_answer_correct: r.isAnswerCorrect ?? null,

            answer_score: r.answerScore !== undefined ? r.answerScore : undefined,
            skill_score: r.skillScore !== undefined ? r.skillScore : undefined,
            judgment_reason: r.judgmentReason || undefined,
            failures: r.failures ? JSON.parse(r.failures) : undefined,
            label: r.label ?? null,
            user: r.user ?? null,
            userTags: tagsByExec.get(r.id) ?? [],
            skill_issues: r.skillIssues ? JSON.parse(r.skillIssues) : [],
            skill_version: r.skillVersion ?? null,
            model,
            tool_call_count: r.toolCallCount ?? undefined,
            llm_call_count: r.llmCallCount ?? undefined,
            input_tokens: r.inputTokens ?? undefined,
            output_tokens: r.outputTokens ?? undefined,
            tool_call_error_count: r.toolCallErrorCount ?? undefined,
            cache_read_input_tokens: r.cacheReadInputTokens ?? undefined,
            cache_creation_input_tokens: r.cacheCreationInputTokens ?? undefined,
            max_single_call_tokens: r.maxSingleCallTokens ?? undefined,
            reasoning_tokens: r.reasoningTokens ?? undefined,
            expected_skill_version: r.expectedSkillVersion ?? null,
            skill_trigger_rate: r.skillTriggerRate ?? null,
            context_window_pct: (r.maxSingleCallTokens != null && cwResult)
                ? Math.round((r.maxSingleCallTokens / cwResult.contextWindow) * 1000) / 10
                : undefined,
            context_window_limit: cwResult?.contextWindow,
            context_window_source: cwResult?.source,
            cost_pricing: pricing ? {
                inputTokenPrice: pricing.inputTokenPrice,
                outputTokenPrice: pricing.outputTokenPrice,
                cacheReadInputTokenPrice: pricing.cacheReadInputTokenPrice ?? pricing.inputTokenPrice * DEFAULT_CACHE_READ_RATIO,
                cacheCreationInputTokenPrice: pricing.cacheCreationInputTokenPrice ?? pricing.inputTokenPrice * DEFAULT_CACHE_CREATION_RATIO,
                source: pricingResult?.source ?? 'default',
            } : null,
            agents,
            // 多 Agent 拆分相关字段（root 都为空/false，sub-agent 行带值）
            parent_execution_id: r.parentExecutionId ?? null,
            root_execution_id: r.rootExecutionId ?? null,
            agent_session_id: r.agentSessionId ?? null,
            subagent_type: r.subagentType ?? null,
            subagent_name: r.subagentName ?? null,
            is_subagent: r.isSubagent ?? false,
        };
        const executionId = normalizedRecord.task_id || normalizedRecord.upload_id || '';
        let executionMatch: ExecutionRecord['execution_match'] = null;
        // light: 跳过每条 execution_match 查询(仅 skill-eval 消费它,而 skill-eval 不走 light)。
        if (!light && executionId) {
            try {
                const match = await db.findExecutionMatch(executionId);
                if (match) {
                    executionMatch = {
                        matchJson: match.matchJson ?? null,
                        matchedAt: match.matchedAt ?? null,
                        mode: match.mode ?? null,
                    };
                }
            } catch {
                executionMatch = null;
            }
        }
        normalizedRecord.execution_match = executionMatch;
        if (!attachEvaluations) {
            return normalizedRecord;
        }
        const evaluationUser = normalizedRecord.user ?? user ?? null;
        const configs = await getConfigsForEvaluationUser(evaluationUser);
        return attachEvaluationSnapshots(normalizedRecord, configs, evaluationUser);
    }));
    return normalizedBatch;
}

async function readRecordsInternal(
    user?: string,
    filters?: ReadRecordFilters,
    options?: ReadRecordsOptions
): Promise<{ records: ExecutionRecord[]; total: number; stats: ReadRecordPageStats }> {
    const light = options?.lightweight === true;
    // light 强制不附评测快照(routing/outcome_evaluation 需 final_result/judge 等重上下文,与轻量语义冲突;
    // 迁移的调用方今天也没开 includeEvaluations,故零行为变化,且连带省掉 configsData 与每条快照查询)。
    const attachEvaluations = light ? false : (options?.attachEvaluations ?? true);
    const page = options?.page && Number.isFinite(options.page) ? Math.max(1, Math.trunc(options.page)) : 1;
    const pageSize = options?.pageSize && Number.isFinite(options.pageSize) ? Math.max(1, Math.trunc(options.pageSize)) : 0;
    const where: any = {};
    if (user && !filters?.showAllUsers) {
        // 严格按 owner 隔离：用户只看见 user=自己的记录；无主(user=null)记录不可见。
        // 全看(ownership=all / admin)走 showAllUsers ⇒ 不加 user 过滤、返回全部。
        where.user = user;
    }

    // 默认列表严格只显示 root execution；显式选择 sub-agent / 全部层级，或按 taskId
    // 下钻时才放开。Skill 是内容过滤条件，不能覆盖用户选择的 Agent 层级。
    const skillNamesFromClauses = (filters?.clauses ?? [])
        .filter((c) => c.column === 'skill' && (c.operator === 'any of' || c.operator === '='))
        .flatMap((c) => (Array.isArray(c.value) ? c.value : c.value != null ? [c.value] : []))
        .map((v) => String(v));
    const skillNames = Array.from(new Set([
        ...(filters?.skill !== undefined ? [String(filters.skill)] : []),
        ...skillNamesFromClauses,
    ]));
    const skillFilterActive = EXECUTION_SKILL_ENABLED && skillNames.length > 0;
    const subagentFilter = resolveExecutionSubagentFilter(filters);
    if (subagentFilter !== undefined) where.isSubagent = subagentFilter;

    if (filters?.parentExecutionId !== undefined) {
        where.parentExecutionId = filters.parentExecutionId;
    }

    if (filters?.taskIds && filters.taskIds.length > 0) {
        where.taskId = { in: filters.taskIds };
    } else if (!filters?.query && filters?.taskId) {
        where.taskId = filters.taskId;
    } else if (filters?.query) {
        const term = filters.query.trim();
        if (term) {
            // 文本搜索：trace 的 input(query) + output(finalResult) 子串模糊匹配
            // （对齐 Langfuse 的 input/output 搜索语义），再加 id/taskId 前缀·子串匹配
            // （列表 Trace ID 列显示 taskId || id，粘贴 ID 应能直查）。多列 OR，再与其它过滤 AND。
            // SQLite 注意：Prisma 在 SQLite 上不支持 mode:'insensitive'；但 LIKE 对 ASCII
            // 默认大小写不敏感，中文无大小写概念，故名称/内容搜索天然可用。
            where.OR = [
                { query: { contains: term } },
                { finalResult: { contains: term } },
                { id: { contains: term } },
                { taskId: { contains: term } },
            ];
        }
    }
    if (filters?.framework) where.framework = filters.framework;

    if (skillFilterActive) {
        // 反查 ExecutionSkill 得到真正用到这些 skill(+可选版本)的 executionId 集合,再交给 Execution 主查询。
        // 索引 (skillName, skillVersion) 命中,与数据量解耦;失败则降级回旧主 skill 列匹配。
        const esWhere: any = { skillName: { in: skillNames } };
        if (filters?.skillVersion !== undefined) esWhere.skillVersion = filters.skillVersion;
        if (user && !filters?.showAllUsers) esWhere.user = user;
        try {
            const esRows = await prismaRaw.executionSkill.findMany({ where: esWhere, select: { executionId: true } });
            where.id = { in: Array.from(new Set(esRows.map((r: any) => r.executionId))) };
        } catch (e) {
            console.warn('[readRecords] ExecutionSkill filter failed, falling back to legacy skill column:', e);
            where.skill = { in: skillNames };
            if (filters?.skillVersion !== undefined) where.skillVersion = filters.skillVersion;
        }
    } else {
        // EXECUTION_SKILL_ENABLED=false(OpenGauss)或无 skill 过滤:沿用旧的主 skill 列匹配。
        if (filters?.skill !== undefined) where.skill = filters.skill;
        if (filters?.skillVersion !== undefined) where.skillVersion = filters.skillVersion;
    }

    if (filters?.agentName !== undefined && filters.observedAgentFallback) {
        where.AND = [
            ...((where.AND as any[]) ?? []),
            {
                OR: [
                    { agentName: filters.agentName },
                    {
                        AND: [
                            { agentName: null },
                            { observedAgents: { contains: JSON.stringify(filters.agentName) } },
                        ],
                    },
                ],
            },
        ];
    } else if (filters?.agentName !== undefined) {
        where.agentName = filters.agentName;
    }
    if (filters?.timestampFrom) {
        where.timestamp = { gte: filters.timestampFrom };
    }

    await appendExecutionOwnershipWhere(where, filters?.ownership);

    const businessTagIds = Array.from(new Set((filters?.businessTagIds ?? []).map(v => String(v || '').trim()).filter(Boolean)));
    if (businessTagIds.length > 0) {
        const taggedExecutionIds = await findExecutionIdsByBusinessTags(user, businessTagIds).catch((e: unknown) => {
            console.warn('[readRecords] business tag filter failed:', e);
            return [] as string[];
        });
        if (taggedExecutionIds) {
            const current = Array.isArray(where.id?.in) ? where.id.in.map((v: unknown) => String(v)) : null;
            const next = current
                ? current.filter((id: string) => taggedExecutionIds.includes(id))
                : taggedExecutionIds;
            where.id = { in: next };
        }
    }

    // 统一过滤器(operator 模型)下推:FilterClause[] → Prisma where,AND 进主查询。
    // 只下推 pushable 实列(execution/observedAgents);skill(executionSkill)/计算列(status/ownership)
    // buildPrismaWhere 会放进 deferred,这里忽略——它们仍走各自既有通道(skillFilterActive / 前端二次过滤)。
    if (filters?.clauses && filters.clauses.length > 0) {
        const { where: clauseWhere, errors } = buildPrismaWhere(filters.clauses);
        if (Array.isArray(clauseWhere.AND) && clauseWhere.AND.length > 0) {
            where.AND = [...((where.AND as any[]) ?? []), ...clauseWhere.AND];
        }
        if (errors.length > 0) {
            console.warn('[readRecords] ignored invalid filter clauses:', errors.map((e) => e.reason));
        }
    }

    const sortKey = options?.sortKey ?? 'timestamp';
    const sortDir = options?.sortDir ?? 'desc';
    const orderBy = [{ [sortKey]: sortDir }, { id: sortDir }];
    let total = 0;
    let paged: any[] = [];
    let byTaskId = new Map<string, any[]>();
    let keepIds = new Set<string>();

    if (pageSize > 0 && options?.databasePagination === true && !process.env.DB_HOST) {
        // SQLite/Prisma 主路径：过滤、排序、分页都在数据库中完成。列表后续的标签、状态、
        // 评测补充只处理当前页，避免“全量 hydrate 后再 slice”的假分页。
        [total, paged] = await prismaRaw.$transaction([
            prismaRaw.execution.count({ where }),
            prismaRaw.execution.findMany({
                where,
                orderBy,
                skip: (page - 1) * pageSize,
                take: pageSize,
                select: LIGHT_EXECUTION_SELECT as any,
            }),
        ]);
    } else {
        // OpenGauss 适配器和非分页旧调用保持原行为；本次不扩展其它页面/数据库适配层。
        const records = await db.findExecutions(
            where,
            process.env.DB_HOST ? { timestamp: 'desc' } : orderBy,
            LIGHT_EXECUTION_SELECT,
        );
        const dedup = selectKeepIdsByTaskId(records);
        keepIds = dedup.keepIds;
        byTaskId = dedup.byTaskId;
        const filtered = records.filter((r: any) => !r.taskId || keepIds.has(r.id));
        total = filtered.length;
        paged = pageSize > 0
            ? filtered.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize)
            : filtered;
    }

    for (const [tid, group] of byTaskId.entries()) {
        if (group.length <= 1) continue;
        for (const r of group) {
            if (!keepIds.has(r.id)) {
                if (AUDIT_DATA_MUTATIONS) {
                    const keepId = group.find(x => keepIds.has(x.id))?.id ?? 'unknown';
                    console.warn(`[Data-Audit] deleteExecution (read dedup): taskId=${tid} deleteId=${r.id} keepId=${keepId}`);
                }
                db.deleteExecution(r.id).catch(() => {});
            }
        }
    }

    // 评测快照需要的 config 加载缓存(memoize per evaluationUser),跨批共享。
    const configCache = new Map<string, Promise<ConfigItem[]>>();
    const getConfigsForEvaluationUser = (evaluationUser?: string | null): Promise<ConfigItem[]> => {
        const key = evaluationUser || '__global__';
        if (!configCache.has(key)) {
            configCache.set(key, readConfig(evaluationUser || undefined));
        }
        return configCache.get(key)!;
    };

    // 按批 hydrate + normalize:每批只把本批的 finalResult + session 拉进内存,用完即释放。
    // 历史 OOM:非分页路径(paged===filtered)曾把全历史 session 的整段 interactions 一次性读进
    // 内存解析,随 DB 增长把 next-server V8 堆撑到 ~4GB → FATAL heap OOM 自杀。按批后峰值内存
    // 降到 O(批大小);分页路径 pageSize≤100 只一批,查询次数/行为不变。批与批之间串行 await
    // 以封顶峰值内存与并发 DB 查询数;out 顺序 = paged 顺序(light pass 已按 timestamp desc 排好)。
    const out: ExecutionRecord[] = [];
    for (const batch of chunk(paged, READ_RECORDS_HYDRATE_BATCH_SIZE)) {
        const normalizedBatch = await hydrateAndNormalizeBatch(batch, {
            user,
            light,
            attachEvaluations,
            includeTags: options?.includeTags === true,
            getConfigsForEvaluationUser,
        });
        out.push(...normalizedBatch);
    }
    let stats: ReadRecordPageStats;
    if (pageSize > 0 && !process.env.DB_HOST) {
        const aggregate = await prismaRaw.execution.aggregate({
            where,
            _avg: { latency: true },
            _sum: { toolCallCount: true, toolCallErrorCount: true },
        });
        const totalTools = aggregate._sum.toolCallCount ?? 0;
        const totalToolErrors = aggregate._sum.toolCallErrorCount ?? 0;
        stats = {
            total,
            // 当前生命周期读路径只产出 running/success；failed 保留在 API enrichment 后兼容计算。
            failedCount: 0,
            avgLatencyMs: (aggregate._avg.latency ?? 0) * 1000,
            toolErrorRate: totalTools > 0
                ? Math.round((totalToolErrors / totalTools) * 1000) / 10
                : 0,
        };
    } else {
        const totalTools = out.reduce((sum, item) => sum + (item.tool_call_count ?? 0), 0);
        const totalToolErrors = out.reduce((sum, item) => sum + (item.tool_call_error_count ?? 0), 0);
        stats = {
            total,
            failedCount: 0,
            avgLatencyMs: out.length > 0
                ? out.reduce((sum, item) => sum + ((item.latency ?? 0) * 1000), 0) / out.length
                : 0,
            toolErrorRate: totalTools > 0
                ? Math.round((totalToolErrors / totalTools) * 1000) / 10
                : 0,
        };
    }
    return { records: out, total, stats };
}

export async function readRecords(
    user?: string,
    filters?: ReadRecordFilters,
    options?: ReadRecordsOptions
): Promise<ExecutionRecord[]> {
    const result = await readRecordsInternal(user, filters, options);
    return result.records;
}

export async function readRecordPage(
    user?: string,
    filters?: ReadRecordFilters,
    options?: ReadRecordsOptions
): Promise<{ records: ExecutionRecord[]; total: number; stats: ReadRecordPageStats }> {
    return readRecordsInternal(user, filters, options);
}



export async function readConfig(
    user?: string | null,
    datasetType: ConfigMatchMode = 'any'
): Promise<ConfigItem[]> {
    const where: any = {};
    if (user) {
        where.OR = [
            { user: user },
            { user: null }
        ];
    }

    const configs = await db.findConfigs(where);
    const normalizedConfigs = configs.map((c: any) => {
        const parse = (s: string | null, fieldName: string) => {
            if (!s) return undefined;
            try { 
                return JSON.parse(s); 
            } catch (e) { 
                console.error(`[readConfig] Failed to parse ${fieldName} for config ${c.id}:`, e);
                return undefined; 
            }
        };
        return {
            id: c.id,
            query: c.query ?? null,
            dataset_type: normalizeConfigDatasetType(c.datasetType),
            skill: c.skill,
            skillVersion: c.skillVersion,
            routing_intent: c.routingIntent || undefined,
            routing_anchors: parse(c.routingAnchors, 'routingAnchors'),
            expectedSkills: normalizeExpectedSkills(parse(c.expectedSkills, 'expectedSkills')),
            standard_answer: c.standardAnswer || '',
            root_causes: parse(c.rootCauses, 'rootCauses'),
            key_actions: parse(c.keyActions, 'keyActions'),
            extractedKeyActions: parse(c.extractedKeyActions, 'extractedKeyActions'),
            parse_status: c.parseStatus || 'completed',
        };
    });

    if (datasetType === 'any') {
        return normalizedConfigs;
    }

    return normalizedConfigs.filter(config => configSupportsDatasetType(config.dataset_type, datasetType));
}

export function readEvaluationResults(): Record<string, string> {
    if (!fs.existsSync(EVALUATION_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(EVALUATION_FILE, 'utf-8'));
    } catch {
        return {};
    }
}

/**
 * 守护 Execution.skillVersion 的不可变性：一条 trace 当时加载执行的是哪个版本，
 * 是历史事实，写入后不应被静默覆盖。
 *
 * 允许的写入：
 *   - 首次写入 / 旧 trace 懒回填：existing 是 NULL → 任意值
 *   - 同值幂等：existing === incoming
 *   - 显式 label-skill-binding 重绑（caller 已 parse 出 binding，明确传 explicitRewrite=true）
 *
 * 被拦截：
 *   - existing 非 NULL → 另一个非 NULL 值（典型：trace 重传时 upload 路径用当前 activeVersion fallback）
 *   - existing 非 NULL → NULL/undefined（把已有版本号抹空，同样是篡改历史）
 *
 * 拦截时返回 existing 值 + blocked=true，caller 自己决定日志/告警。
 */
export function resolveImmutableSkillVersion(input: {
    isUpdate: boolean;
    existingSkillVersion: number | null;
    incomingSkillVersion: number | null;
    explicitRewrite: boolean;
}): { resolved: number | null; blocked: boolean } {
    const { isUpdate, existingSkillVersion, incomingSkillVersion, explicitRewrite } = input;
    if (!isUpdate || existingSkillVersion == null || explicitRewrite) {
        return { resolved: incomingSkillVersion, blocked: false };
    }
    if (incomingSkillVersion === existingSkillVersion) {
        return { resolved: existingSkillVersion, blocked: false };
    }
    return { resolved: existingSkillVersion, blocked: true };
}

/**
 * 按 task_id 删除 Execution（可选 framework 守卫），返回删除行数。
 * 用于清理"已被更完整记录取代"的孤儿：jiuwenswarm 早到批次先以单 agent task_id
 * （jiuwen-<traceId>）落库，随后该 trace 被并入多 agent session（sess_…）后，原单 agent
 * 记录需删除，否则界面重复出现并把首轮 llm/token 计两遍。ExecutionSkill 经 onDelete:Cascade
 * 连带清理。
 */
export async function deleteExecutionsByTaskId(taskId: string, framework?: string): Promise<number> {
    if (!taskId) return 0;
    const where: any = { taskId };
    if (framework) where.framework = framework;
    try {
        const count = await db.deleteExecutions(where);
        if (count > 0 && AUDIT_DATA_MUTATIONS) {
            console.warn(`[Data-Audit] deleteExecutionsByTaskId: taskId=${taskId} framework=${framework ?? '*'} deleted=${count}`);
        }
        return count;
    } catch {
        return 0;
    }
}

/**
 * 无 key、也无法解析出 user 时的**默认归属账户**。用于「多人共用一个账号、开箱即用不配 key」场景：
 * client 只填平台 IP、不带 x-witty-api-key，数据统一归到这个账号。
 *
 * 通过 env `AGENT_INSIGHT_DEFAULT_INGEST_USER` 配置；未设置则返回 null（保持原行为：upload 直接拒绝、
 * 其他路径走旧的「DB 第一个用户」非确定兜底）。
 *
 * 建议指向一个**专门的普通账号**（如 team/shared），不要用 admin / anonymous —— 它们是
 * TRACE_SERVICE_OWNERS 服务占位账号，reattributeServiceTraceOwner 会把 trace 从中挪走。
 *
 * 注意：这是「完全没带 key」才走的默认；「带了 key 但 DB 查不到」仍按各入口规则报错（如 upload 401），
 * 以免把配错 key 的数据静默灌进共享账号。
 */
export function getDefaultIngestUser(): string | null {
    const v = (process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER || '').trim();
    return v || null;
}

export async function saveExecutionRecord(data: ExecutionRecord): Promise<{ success: boolean; record: ExecutionRecord }> {
    const id = data.upload_id || data.task_id;
    let recordId = id || crypto.randomUUID();

    if (data.task_id) {
        try {
            const where: any = { taskId: data.task_id };
            if (data.framework) where.framework = data.framework;
            const existingByTask = await db.findExecutions(where, { timestamp: 'desc' });
            if (existingByTask && existingByTask.length > 0 && existingByTask[0]?.id) {
                const exact = existingByTask.find((x: any) => x.id === data.task_id);
                const canonicalId = (exact && exact.id) ? exact.id : existingByTask[0].id;
                if (canonicalId !== recordId) {
                    recordId = canonicalId;
                }
            }
        } catch {}
    }

    let existingRecord: ExecutionRecord | null = null;
    const dbRecord = await db.findExecutionById(recordId);

    if (dbRecord) {
        existingRecord = {
            ...dbRecord,
            upload_id: dbRecord.id,
            task_id: dbRecord.taskId || undefined,
            query: dbRecord.query || undefined,
            framework: dbRecord.framework || undefined,
            tokens: dbRecord.tokens ?? undefined,
            cost: dbRecord.cost ?? undefined,
            latency: dbRecord.latency ?? undefined,
            timestamp: dbRecord.timestamp?.toISOString?.() || dbRecord.timestamp,
            final_result: dbRecord.finalResult || undefined,
            skill: dbRecord.skill || undefined,
            skills: dbRecord.skills ? JSON.parse(dbRecord.skills) : undefined,
            invokedSkills: dbRecord.invokedSkills ? (() => { try { return JSON.parse(dbRecord.invokedSkills); } catch { return undefined; } })() : undefined,
            is_skill_correct: dbRecord.isSkillCorrect ?? false,
            is_answer_correct: dbRecord.isAnswerCorrect ?? null,
            answer_score: dbRecord.answerScore ?? undefined,
            skill_score: dbRecord.skillScore ?? undefined,
            judgment_reason: dbRecord.judgmentReason || undefined,
            failures: dbRecord.failures ? JSON.parse(dbRecord.failures) : undefined,
            skill_issues: dbRecord.skillIssues ? JSON.parse(dbRecord.skillIssues) : undefined,
            label: dbRecord.label || undefined,
            user: dbRecord.user || undefined,
            skill_version: dbRecord.skillVersion ?? undefined,
            expected_skill_version: dbRecord.expectedSkillVersion ?? null,
            skill_trigger_rate: dbRecord.skillTriggerRate ?? null,
            model: dbRecord.model || undefined,
            tool_call_count: dbRecord.toolCallCount ?? undefined,
            llm_call_count: dbRecord.llmCallCount ?? undefined,
            input_tokens: dbRecord.inputTokens ?? undefined,
            output_tokens: dbRecord.outputTokens ?? undefined,
            tool_call_error_count: dbRecord.toolCallErrorCount ?? undefined,
            cache_read_input_tokens: dbRecord.cacheReadInputTokens ?? undefined,
            cache_creation_input_tokens: dbRecord.cacheCreationInputTokens ?? undefined,
            max_single_call_tokens: dbRecord.maxSingleCallTokens ?? undefined,
        };
    }

    let targetRecord: ExecutionRecord = existingRecord ? { ...existingRecord } : {};
    const isUpdate = !!existingRecord;

    if (!isUpdate && !targetRecord.timestamp && !data.timestamp) {
        targetRecord.timestamp = new Date().toISOString();
    } else if (data.timestamp) {
        targetRecord.timestamp = data.timestamp;
    }

    const allowQueryOverwrite = !!data.force_query_update;
    const existingQuery = typeof existingRecord?.query === 'string' ? existingRecord.query.trim() : '';
    const incomingQuery = typeof data.query === 'string' ? data.query.trim() : '';

    let explicitSkillVersionRewrite = false;
    if (typeof data.label === 'string') {
        const b = parseLabelSkillVersionBinding(data.label);
        if (b) {
            data.skill = b.skill;
            data.skill_version = b.skill_version;
            data.skills = b.skills;
            data.invokedSkills = b.invokedSkills;
            explicitSkillVersionRewrite = true;
        }
    }

    targetRecord = { ...targetRecord, ...data };

    const guarded = resolveImmutableSkillVersion({
        isUpdate,
        existingSkillVersion: existingRecord?.skill_version ?? null,
        incomingSkillVersion: targetRecord.skill_version ?? null,
        explicitRewrite: explicitSkillVersionRewrite,
    });
    if (guarded.blocked) {
        console.warn(
            `[Data-Service] Preserving existing skill_version for execution ${recordId}: ` +
            `existing=${existingRecord?.skill_version}, incoming=${targetRecord.skill_version} blocked. ` +
            `Skill version is immutable history; only NULL → value or explicit label-binding rewrite is allowed.`
        );
    }
    targetRecord.skill_version = guarded.resolved ?? undefined;
    if (!targetRecord.agentName && targetRecord.agent) {
        targetRecord.agentName = targetRecord.agent;
    }

    if (existingQuery && !allowQueryOverwrite) {
        targetRecord.query = existingQuery;
    } else if (!existingQuery && incomingQuery) {
        targetRecord.query = incomingQuery;
    } else if (typeof targetRecord.query === 'string' && !targetRecord.query.trim()) {
        targetRecord.query = undefined;
    } else if (typeof targetRecord.query === 'string') {
        targetRecord.query = targetRecord.query.trim();
    }
    if (!targetRecord.upload_id && targetRecord.task_id) targetRecord.upload_id = targetRecord.task_id;
    if (!targetRecord.task_id && targetRecord.upload_id) targetRecord.task_id = targetRecord.upload_id;
    targetRecord.upload_id = recordId;

    if ((!targetRecord.label || !targetRecord.model || !targetRecord.user) && targetRecord.task_id) {
        const session = await db.findSessionByTaskId(targetRecord.task_id);
        if (session) {
            if (!targetRecord.label && session.label) targetRecord.label = session.label;
            if (!targetRecord.model && session.model) targetRecord.model = session.model;
            if (!targetRecord.user && session.user) targetRecord.user = session.user;
        }
    }

    if (!targetRecord.user) {
        const defaultUser = getDefaultIngestUser();
        if (defaultUser) {
            // 无 key / 无法解析 user 时，确定性地归到配置的默认账号（开箱即用共享账号场景）。
            // 覆盖 OTLP / proxy / opencode 等所有「不 reject、user 落空」的路径 —— 它们都汇到这里。
            targetRecord.user = defaultUser;
            console.log(`[Data-Service] No user on record for task ${targetRecord.task_id}, defaulting to AGENT_INSIGHT_DEFAULT_INGEST_USER=${defaultUser}`);
        } else {
            // 未配置默认账号：保留旧兜底（DB 第一个用户）。注意这是**非确定性**的（取决于建表顺序），
            // 生产建议配 AGENT_INSIGHT_DEFAULT_INGEST_USER 明确指定，避免数据莫名归到某个账号。
            try {
                const client = db.getClient();
                if ('query' in client) {
                    const res = await (client as any).query('SELECT username FROM "User" LIMIT 1');
                    if (res.rows[0]) {
                        targetRecord.user = res.rows[0].username;
                        console.log(`[Data-Service] Fallback resolved user for task ${targetRecord.task_id} to: ${targetRecord.user}`);
                    }
                }
            } catch (e) {
                console.warn('[Data-Service] Fallback user lookup failed:', e);
            }
        }
    }

    const incomingTokens = data.Token || data.token || data.tokens;
    if (incomingTokens !== undefined) targetRecord.tokens = Number(incomingTokens);

    if (data.tool_call_count !== undefined) targetRecord.tool_call_count = Number(data.tool_call_count);
    if (data.llm_call_count !== undefined) targetRecord.llm_call_count = Number(data.llm_call_count);
    if (data.input_tokens !== undefined) targetRecord.input_tokens = Number(data.input_tokens);
    if (data.output_tokens !== undefined) targetRecord.output_tokens = Number(data.output_tokens);
    if (data.tool_call_error_count !== undefined) targetRecord.tool_call_error_count = Number(data.tool_call_error_count);
    if (data.cache_read_input_tokens !== undefined) targetRecord.cache_read_input_tokens = Number(data.cache_read_input_tokens);
    if (data.cache_creation_input_tokens !== undefined) targetRecord.cache_creation_input_tokens = Number(data.cache_creation_input_tokens);
    if (data.max_single_call_tokens !== undefined) targetRecord.max_single_call_tokens = Number(data.max_single_call_tokens);
    if (data.reasoning_tokens !== undefined) targetRecord.reasoning_tokens = Number(data.reasoning_tokens);

    let mergedInteractionsForSession: any[] | null = null;
    if (targetRecord.task_id && targetRecord.interactions) {
        const storageAdapter = getAdapter(targetRecord.framework);
        const normalizeForStorage = (interactions: any) =>
            storageAdapter.normalizeForStorage?.(interactions) ?? interactions;
        let incomingInteractions = typeof targetRecord.interactions === 'string'
            ? (() => { try { return JSON.parse(targetRecord.interactions); } catch { return []; } })()
            : targetRecord.interactions;
        incomingInteractions = normalizeForStorage(incomingInteractions);

        mergedInteractionsForSession = incomingInteractions;
        try {
            const mergeStrategy = targetRecord.session_merge_strategy || storageAdapter.sessionMergeStrategy || 'monotonic';
            if (mergeStrategy !== 'snapshot-replace') {
                const existingSession = await db.findSessionByTaskId(targetRecord.task_id);
                let existingInteractions = existingSession?.interactions
                    ? (() => { try { return JSON.parse(existingSession.interactions as string); } catch { return []; } })()
                    : [];
                existingInteractions = normalizeForStorage(existingInteractions);

                if (Array.isArray(existingInteractions) && existingInteractions.length > 0) {
                    mergedInteractionsForSession = mergeSessionInteractionsMonotonic(existingInteractions, incomingInteractions);
                }
            } else {
                // snapshot-replace 防退化护栏：上游或服务端聚合层每批都重新形成「当前会话快照」后整条
                // 覆盖，正常情况下 incoming 是越来越全的快照。但若 span spool 在极端下仍残缺（历史 span
                // 永久丢失等），一个偏小的快照会把库里更完整的记录盖没。这里比较 interaction 数：incoming
                // 严格更小则判为退化快照，保留库里现有记录、不覆盖。Qoder 的完整 turn
                // 快照允许缩小；Jiuwen 仅可由服务端环境开关显式放行。
                const allowShrink = allowsSnapshotShrinkForFramework(targetRecord.framework);
                if (!allowShrink) {
                    const existingSession = await db.findSessionByTaskId(targetRecord.task_id);
                    let existingInteractions = existingSession?.interactions
                        ? (() => { try { return JSON.parse(existingSession.interactions as string); } catch { return []; } })()
                        : [];
                    existingInteractions = normalizeForStorage(existingInteractions);
                    const existingCount = Array.isArray(existingInteractions) ? existingInteractions.length : 0;
                    const incomingCount = Array.isArray(incomingInteractions) ? incomingInteractions.length : 0;
                    if (existingCount > 0 && incomingCount < existingCount) {
                        console.warn(
                            `[Data-Service] snapshot-replace 退化护栏：拒绝用更小快照覆盖 task ${targetRecord.task_id}` +
                            `（incoming ${incomingCount} < existing ${existingCount} interactions），保留现有记录。` +
                            `Jiuwen 可由服务端设置 AGENT_INSIGHT_JIUWEN_ALLOW_SHRINK=true 放行。`,
                        );
                        return { success: true, record: targetRecord };
                    }
                }
            }
        } catch (e) {
            // 护栏/合并的 DB 读取失败时 fail-open：按原逻辑继续落库，不因检查本身报错而阻断写入。
            if (e && typeof e === 'object' && 'task_id' in (targetRecord as any)) {
                console.warn('[Data-Service] snapshot-replace 退化检查异常，按原逻辑继续：', (e as Error)?.message || e);
            }
        }

        mergedInteractionsForSession = normalizeForStorage(mergedInteractionsForSession);
        targetRecord.interactions = mergedInteractionsForSession;
        const derivedQuery = inferUserQueryFromInteractions(mergedInteractionsForSession);
        if (derivedQuery && shouldRefreshStoredQueryFromInteractions(targetRecord.query, targetRecord.framework)) {
            targetRecord.query = derivedQuery;
        }

        if (targetRecord.framework === 'opencode' && Array.isArray(mergedInteractionsForSession)) {
            const derived = deriveOpencodeExecutionFields(mergedInteractionsForSession);
            if (derived.model) targetRecord.model = derived.model;
            if (derived.final_result) targetRecord.final_result = derived.final_result;
            if (derived.agentName && !targetRecord.agentName) targetRecord.agentName = derived.agentName;
            targetRecord.tokens = derived.tokens;
            targetRecord.latency = derived.latency;
            targetRecord.input_tokens = derived.input_tokens;
            targetRecord.output_tokens = derived.output_tokens;
            targetRecord.tool_call_count = derived.tool_call_count;
            targetRecord.tool_call_error_count = derived.tool_call_error_count;
            targetRecord.llm_call_count = derived.llm_call_count;
            targetRecord.cache_read_input_tokens = derived.cache_read_input_tokens;
            targetRecord.cache_creation_input_tokens = derived.cache_creation_input_tokens;
            targetRecord.max_single_call_tokens = derived.max_single_call_tokens;
            targetRecord.reasoning_tokens = derived.reasoning_tokens;
        }
    }
    let isSkillCorrect = false; // Reset to false and recalculate based on current config
    let isAnswerCorrect = targetRecord.is_answer_correct || false;
    let judgmentReason = targetRecord.judgment_reason || NO_OUTCOME_MATCH_REASON;
    targetRecord.skill_trigger_rate = null;

    const configs = await readConfig(targetRecord.user);
    if (configs.length > 0) {
        const routingConfig = await findBestRoutingConfig(configs, targetRecord.query, targetRecord.user);
        const outcomeConfig = findBestOutcomeConfig(configs, targetRecord);

        if (routingConfig) {
            const invokedSkillsWithVersion = Array.isArray(targetRecord.invokedSkills) ? targetRecord.invokedSkills : [];
            const skillsFallback = Array.isArray(targetRecord.skills) ? targetRecord.skills : [];
            const invokedSkillsFallback = skillsFallback.map(name => ({ name, version: null as number | null }));

            const expectedSkillsList = getRoutingExpectedSkills(routingConfig);
            
            if (expectedSkillsList.length > 0) {
                const skillsToCheck = invokedSkillsWithVersion.length > 0 
                    ? invokedSkillsWithVersion 
                    : invokedSkillsFallback;
                
                if (skillsToCheck.length > 0) {
                    let correctInvokedSkills = 0;
                    
                    const validExpectedSkills = expectedSkillsList.filter(e => e.skill?.trim());
                    
                    const skillNames = validExpectedSkills.map(e => e.skill.trim());
                    let skillsMap = new Map<string, any>();
                    
                    if (skillNames.length > 0) {
                        try {
                            const skills = await db.findSkills({
                                name: { in: skillNames },
                                user: targetRecord.user || null
                            });
                            
                            for (const skill of skills) {
                                skillsMap.set(skill.name, skill);
                            }
                        } catch (err) {
                            console.error('[Judgment] Error fetching skills for version check:', err);
                        }
                    }
                    
                    for (const expected of validExpectedSkills) {
                        const expectedName = expected.skill.trim();
                        const expectedVer = expected.version ?? null;
                        
                        const matchingInvoked = skillsToCheck.find(
                            (s) => s.name === expectedName
                        );
                        
                        if (matchingInvoked) {
                            let isVersionMatch = false;
                            
                            if (expectedVer === null) {
                                isVersionMatch = true;
                            } else if (matchingInvoked.version !== null) {
                                isVersionMatch = matchingInvoked.version === expectedVer;
                            } else {
                                const skill = skillsMap.get(expectedName);
                                if (skill) {
                                    const actualVersion = skill.activeVersion || 0;
                                    isVersionMatch = actualVersion === expectedVer;
                                } else {
                                    isVersionMatch = false;
                                }
                            }
                            
                            if (isVersionMatch) {
                                correctInvokedSkills++;
                                if (!isSkillCorrect) {
                                    isSkillCorrect = true;
                                }
                            }
                        }
                    }
                    
                    if (validExpectedSkills.length > 0) {
                        targetRecord.skill_trigger_rate = correctInvokedSkills / validExpectedSkills.length;
                    }
                }
            }
            targetRecord.is_skill_correct = isSkillCorrect;
        }

        if (outcomeConfig) {
            await fillConfigKeyActionsFromParsedFlows(outcomeConfig, targetRecord.user);
            if (targetRecord.final_result !== undefined) {
                let needsJudgment = true;

                if (isUpdate && !data.force_judgment) {
                    if (existingRecord && existingRecord.query === targetRecord.query && existingRecord.final_result === targetRecord.final_result) {
                        needsJudgment = false;
                    }
                }

                if (data.skip_internal_judgment) {
                    needsJudgment = false;
                }

                if (needsJudgment && !targetRecord.skip_evaluation) {
                    let skillDefinition: string | undefined = undefined;
                    const skillName = (
                        targetRecord.skill
                        || outcomeConfig.skill
                        || routingConfig?.skill
                        || ''
                    ).trim();

                    if (skillName) {
                        try {
                            const skill = await db.findSkill(skillName, targetRecord.user || null);
                            if (skill) {
                                const targetVersion = outcomeConfig.skillVersion
                                    ?? targetRecord.skill_version
                                    ?? skill.activeVersion
                                    ?? 0;
                                const sv = skill.versions?.find((v: any) => v.version === targetVersion);
                                if (sv && sv.content) {
                                    skillDefinition = sv.content;
                                    if (targetRecord.skill_version === undefined || targetRecord.skill_version === null) {
                                        targetRecord.skill_version = sv.version;
                                    }
                                } else if (skill.versions && skill.versions.length > 0) {
                                    const latestSv = skill.versions[0];
                                    if (latestSv && latestSv.content) {
                                        skillDefinition = latestSv.content;
                                        if (targetRecord.skill_version === undefined || targetRecord.skill_version === null) {
                                            targetRecord.skill_version = latestSv.version;
                                        }
                                    }
                                }
                            }
                        } catch (err) {
                            console.error('[Judgment] Error fetching skill definition:', err);
                        }
                    }

                    let executionSteps: { name: string; description: string; type: string }[] | null = null;
                    try {
                        const matchRecord = await db.findExecutionMatch(targetRecord.task_id || targetRecord.upload_id || '');
                        if (matchRecord?.extractedSteps) {
                            executionSteps = typeof matchRecord.extractedSteps === 'string' 
                                ? JSON.parse(matchRecord.extractedSteps) 
                                : matchRecord.extractedSteps;
                        }
                    } catch (e) {
                        console.warn('[Judgment] Failed to load execution steps for KA evaluation:', e);
                    }

                    const judgment = await judgeAnswer(
                        getEvaluationContextLabel(targetRecord, outcomeConfig),
                        {
                            standard_answer_example: outcomeConfig.standard_answer,
                            root_causes: outcomeConfig.root_causes,
                            key_actions: outcomeConfig.key_actions,
                            skill_definition: skillDefinition
                        },
                        targetRecord.final_result,
                        targetRecord.user,
                        executionSteps
                    );
                    isAnswerCorrect = judgment.is_correct;
                    targetRecord.answer_score = judgment.score;
                    judgmentReason = judgment.reason || 'Judged by Evaluation Model';
                }
            }
        } else {
            if (!isUpdate || data.force_judgment) {
                isAnswerCorrect = false;
                judgmentReason = NO_OUTCOME_MATCH_REASON;
                targetRecord.answer_score = null;
            }
        }
    }

    if (data.skip_evaluation) {
        targetRecord.answer_score = null;
        isAnswerCorrect = false;
        judgmentReason = '结果评估中...';
    }

    targetRecord.is_skill_correct = isSkillCorrect;
    targetRecord.is_answer_correct = isAnswerCorrect;
    targetRecord.judgment_reason = judgmentReason;
    targetRecord = await attachEvaluationSnapshots(targetRecord, configs, targetRecord.user);

    const skillForScore = Array.isArray(targetRecord.skills) && targetRecord.skills.length > 0 ? targetRecord.skills[0] : undefined;
    if (skillForScore) {
        const evalResults = readEvaluationResults();
        const scoreStr = evalResults[skillForScore];
        if (scoreStr) targetRecord.skill_score = parseFloat(scoreStr);
    }

    targetRecord.label = chooseExecutionLabel({
        existingLabel: existingRecord?.label,
        incomingLabel: data.label,
        skill: targetRecord.skill,
        skillVersion: targetRecord.skill_version ?? null
    });

    let agentId: string | undefined = undefined;
    if (targetRecord.framework) {
        const platform = targetRecord.framework;
        const user = targetRecord.user || null;

        const observedAgents = extractObservedAgentRegistrations(
            mergedInteractionsForSession,
            targetRecord.agentName,
        );

        // 并发安全 + 单点隔离：try/catch 收细到**单个 agent**，一个失败不再中断整条 trace 的其余登记
        // 与 agentId 关联；create 撞 @@unique([platform,name,user]) 时回查拿现有行（多人共用同一账号、
        // 首次并发登记同名 agent 的场景）——不重复、不覆盖、不报错。
        for (const observed of observedAgents) {
            try {
                let existingAgent = await prisma.registeredAgent.findFirst({
                    where: { platform, name: observed.name, user: user }
                });

                if (!existingAgent) {
                    try {
                        existingAgent = await prisma.registeredAgent.create({
                            data: {
                                platform,
                                name: observed.name,
                                user,
                                // 已知系统/内置 Agent 名（评估器等）直接落 system，避免它们换 framework
                                // （如评估器的 direct-llm 路径）被 ingest 登记成 user、污染用户视图/统计。
                                agentOwnership: isInternalSystemAgentTrace(observed.name) ? 'system' : 'user',
                                agentType: observed.agentType === 'main'
                                    ? (targetRecord.agentType || 'main')
                                    : 'subagent'
                            }
                        });
                    } catch (createErr) {
                        // 并发下另一个请求刚建了同一 (platform,name,user) 行 → 撞唯一约束。回查拿到它即可。
                        existingAgent = await prisma.registeredAgent.findFirst({
                            where: { platform, name: observed.name, user: user }
                        });
                        if (!existingAgent) {
                            console.warn(`[Data-Service] register observed agent failed (non-fatal): ${observed.name}`, createErr);
                        }
                    }
                }

                if (existingAgent && observed.agentType === 'main' && observed.name === targetRecord.agentName) {
                    agentId = existingAgent.id;
                }
            } catch (e) {
                // 单个 agent 的意外错误不影响其余 agent 与本条 trace 的保存。
                console.warn(`[Data-Service] observed-agent registration error (non-fatal): ${observed.name}`, e);
            }
        }
    }

    // 写入时预解析 agents 列表并 denormalize 存入 observedAgents,供轻量列表(fields=light)直接读取,
    // 无需加载/解析 session interactions。与读侧 extractObservedAgentNames(interactions) 同源同口径
    // (含 opencode 'build' 等只出现在 interactions 里的 agent 名),保证 light 与 heavy 的 agents 一致、不丢数据。
    const observedAgentsJson = Array.isArray(mergedInteractionsForSession) && mergedInteractionsForSession.length > 0
        ? JSON.stringify(extractObservedAgentNames(mergedInteractionsForSession))
        : null;
    await db.upsertExecution({
        where: { id: recordId },
        create: {
            id: recordId,
            taskId: targetRecord.task_id,
            query: targetRecord.query,
            framework: targetRecord.framework,
            tokens: targetRecord.tokens,
            cost: targetRecord.cost,
            latency: targetRecord.latency,
            timestamp: targetRecord.timestamp ? new Date(targetRecord.timestamp) : new Date(),
            finalResult: targetRecord.final_result,
            skill: targetRecord.skill,
            skills: targetRecord.skills ? JSON.stringify(targetRecord.skills) : null,
            invokedSkills: targetRecord.invokedSkills ? JSON.stringify(targetRecord.invokedSkills) : null,
            isSkillCorrect: targetRecord.is_skill_correct,
            isAnswerCorrect: targetRecord.is_answer_correct,
            answerScore: targetRecord.answer_score,
            skillScore: targetRecord.skill_score,
            judgmentReason: targetRecord.judgment_reason,
            failures: targetRecord.failures ? JSON.stringify(targetRecord.failures) : null,
            skillIssues: targetRecord.skill_issues ? JSON.stringify(targetRecord.skill_issues) : null,
            label: targetRecord.label,
            user: targetRecord.user,
            agentName: targetRecord.agentName,
            agentId: agentId,
            skillVersion: targetRecord.skill_version,
            model: targetRecord.model,
            endpoint: normalizeEndpointUrl(targetRecord.endpoint),
            toolCallCount: targetRecord.tool_call_count,
            llmCallCount: targetRecord.llm_call_count,
            inputTokens: targetRecord.input_tokens,
            outputTokens: targetRecord.output_tokens,
            toolCallErrorCount: targetRecord.tool_call_error_count,
            skillTriggerRate: targetRecord.skill_trigger_rate,
            cacheReadInputTokens: targetRecord.cache_read_input_tokens,
            cacheCreationInputTokens: targetRecord.cache_creation_input_tokens,
            maxSingleCallTokens: targetRecord.max_single_call_tokens,
            reasoningTokens: targetRecord.reasoning_tokens,
            observedAgents: observedAgentsJson,
        },
        update: {
            taskId: targetRecord.task_id,
            query: targetRecord.query,
            framework: targetRecord.framework,
            tokens: targetRecord.tokens,
            cost: targetRecord.cost,
            latency: targetRecord.latency,
            timestamp: targetRecord.timestamp ? new Date(targetRecord.timestamp) : new Date(),
            finalResult: targetRecord.final_result,
            skill: targetRecord.skill,
            skills: targetRecord.skills ? JSON.stringify(targetRecord.skills) : null,
            invokedSkills: targetRecord.invokedSkills ? JSON.stringify(targetRecord.invokedSkills) : null,
            isSkillCorrect: targetRecord.is_skill_correct,
            isAnswerCorrect: targetRecord.is_answer_correct,
            answerScore: targetRecord.answer_score,
            skillScore: targetRecord.skill_score,
            judgmentReason: targetRecord.judgment_reason,
            failures: targetRecord.failures ? JSON.stringify(targetRecord.failures) : null,
            skillIssues: targetRecord.skill_issues ? JSON.stringify(targetRecord.skill_issues) : null,
            label: targetRecord.label,
            user: targetRecord.user,
            agentName: targetRecord.agentName,
            agentId: agentId,
            skillVersion: targetRecord.skill_version,
            model: targetRecord.model,
            endpoint: normalizeEndpointUrl(targetRecord.endpoint),
            toolCallCount: targetRecord.tool_call_count,
            llmCallCount: targetRecord.llm_call_count,
            inputTokens: targetRecord.input_tokens,
            outputTokens: targetRecord.output_tokens,
            toolCallErrorCount: targetRecord.tool_call_error_count,
            skillTriggerRate: targetRecord.skill_trigger_rate,
            cacheReadInputTokens: targetRecord.cache_read_input_tokens,
            cacheCreationInputTokens: targetRecord.cache_creation_input_tokens,
            maxSingleCallTokens: targetRecord.max_single_call_tokens,
            reasoningTokens: targetRecord.reasoning_tokens,
            observedAgents: observedAgentsJson,
        }
    });

    if (data.upload_id && data.task_id && data.upload_id !== recordId) {
        try {
            const dup = await db.findExecutionById(data.upload_id);
            if (dup && dup.taskId === data.task_id) {
                if (AUDIT_DATA_MUTATIONS) {
                    console.warn(`[Data-Audit] deleteExecution (dedup on save): upload_id=${data.upload_id} task_id=${data.task_id} recordId=${recordId}`);
                }
                await db.deleteExecution(data.upload_id);
            }
        } catch {}
    }

    // 写入 root 这一层 agent 自己用到的 skill 到 ExecutionSkill(agent 作用域,不含子 agent)。
    //   - opencode：用 agent-call-tree 取 root 节点本层显式 skill 调用（剥离子 agent 冒泡）。
    //   - claude/openclaw / label 显式绑定：targetRecord.invokedSkills 已是单 agent + 显式口径,直接复用。
    // 版本写时定格(snapshotSkillVersions)。子 agent 的绑定在 deriveSubagentExecutions 里各自写。
    if (EXECUTION_SKILL_ENABLED) {
        try {
            let rootSkills: InvokedSkill[];
            const hasInteractions = Array.isArray(mergedInteractionsForSession) && mergedInteractionsForSession.length > 0;
            if (explicitSkillVersionRewrite) {
                // label 显式绑定:用绑定的 skill(权威),不从 interactions 重算
                rootSkills = Array.isArray(targetRecord.invokedSkills) ? (targetRecord.invokedSkills as InvokedSkill[]) : [];
            } else if (hasInteractions) {
                rootSkills = computeOwnSkills(targetRecord.framework, mergedInteractionsForSession as any[]);
            } else {
                rootSkills = Array.isArray(targetRecord.invokedSkills) ? (targetRecord.invokedSkills as InvokedSkill[]) : [];
            }
            const pinnedRootSkills = preferExplicitPrimarySkillVersion(
                rootSkills,
                targetRecord.skill ?? null,
                targetRecord.skill_version ?? null,
            );
            const snapped = await snapshotSkillVersions(pinnedRootSkills, targetRecord.user);
            await persistExecutionSkills(recordId, snapped, { user: targetRecord.user, primaryName: targetRecord.skill ?? null });
            await prismaRaw.execution.update({
                where: { id: recordId },
                data: {
                    skills: snapped.length ? JSON.stringify(snapped.map((skill) => skill.name)) : null,
                    invokedSkills: snapped.length ? JSON.stringify(snapped) : null,
                },
            });
        } catch (e) {
            console.warn(`[Data-Service] root ExecutionSkill persist failed for ${recordId}:`, e);
        }
    }

    // 多 Agent 拆分：把 root execution 里挂着的 sub-agent 切片单独派生成 Execution + Session 行，
    // 通过 parentExecutionId 与 root 建立父子关系。列表/聚合默认 filter isSubagent=false，
    // 详情页可下钻到 sub-agent。历史上这里曾对相同 taskId 的 child Execution 做 dedup 删除，
    // 现在反过来——保留它们，并补齐父子链接。
    if (
        getAdapter(targetRecord.framework).capabilities?.subagentTree === true
        && targetRecord.task_id
        && Array.isArray(mergedInteractionsForSession)
    ) {
        try {
            await deriveSubagentExecutions({
                parentExecutionId: recordId,
                parentTaskId: targetRecord.task_id,
                parentFramework: targetRecord.framework,
                parentUser: targetRecord.user,
                interactions: mergedInteractionsForSession,
            });
        } catch (e) {
            console.warn(`[Data-Service] deriveSubagentExecutions failed for parent=${recordId}:`, e);
        }
    }

    const explicitTraceStartedAt = targetRecord.trace_started_at
        ? new Date(targetRecord.trace_started_at)
        : null;
    const hasExplicitTraceStart = explicitTraceStartedAt != null
        && Number.isFinite(explicitTraceStartedAt.getTime());
    const explicitTraceCompletedAt = targetRecord.trace_completed_at
        ? new Date(targetRecord.trace_completed_at)
        : null;
    const hasExplicitTraceCompletion = explicitTraceCompletedAt != null
        && Number.isFinite(explicitTraceCompletedAt.getTime());
    const inferredHermesTraceCompletedAt = !hasExplicitTraceCompletion
        && targetRecord.framework === 'hermes'
        && typeof targetRecord.final_result === 'string'
        && targetRecord.final_result.trim()
        ? inferTraceCompletionFromInteractions(mergedInteractionsForSession)
        : null;
    const traceCompletedAtForSession = hasExplicitTraceCompletion
        ? explicitTraceCompletedAt
        : inferredHermesTraceCompletedAt;
    if (!hasExplicitTraceCompletion && inferredHermesTraceCompletedAt) {
        targetRecord.trace_completed_at = inferredHermesTraceCompletedAt;
    }
    const hasTraceCompletion = traceCompletedAtForSession != null
        && Number.isFinite(traceCompletedAtForSession.getTime())
        && (!hasExplicitTraceStart || traceCompletedAtForSession.getTime() >= explicitTraceStartedAt.getTime());

    if (targetRecord.task_id && mergedInteractionsForSession) {
        const isLangfuseTrace = targetRecord.framework === 'langfuse' || targetRecord.framework === 'langfuse-langgraph';
        let langfuseTraceNodesJson: string | undefined;
        if (isLangfuseTrace && Array.isArray(targetRecord.langfuseTraceNodes)) {
            const existingSession = await db.findSessionByTaskId(targetRecord.task_id);
            let existingNodes: LangfuseTraceNode[] = [];
            if (typeof existingSession?.langfuseTraceNodes === 'string' && existingSession.langfuseTraceNodes.trim()) {
                try {
                    const parsed = JSON.parse(existingSession.langfuseTraceNodes);
                    if (Array.isArray(parsed)) existingNodes = parsed;
                } catch {}
            }
            targetRecord.langfuseTraceNodes = mergeLangfuseTraceNodes(existingNodes, targetRecord.langfuseTraceNodes);
            langfuseTraceNodesJson = JSON.stringify(targetRecord.langfuseTraceNodes);
        }
        await db.upsertSession(
            targetRecord.task_id,
            {
                taskId: targetRecord.task_id,
                query: targetRecord.query,
                label: targetRecord.label,
                user: targetRecord.user,
                model: targetRecord.model,
                interactions: JSON.stringify(mergedInteractionsForSession),
                ...(langfuseTraceNodesJson !== undefined ? { langfuseTraceNodes: langfuseTraceNodesJson } : {}),
                ...(hasExplicitTraceStart ? { startTime: explicitTraceStartedAt } : {}),
                ...(hasTraceCompletion ? { endTime: traceCompletedAtForSession } : {}),
            },
            {
                query: targetRecord.query,
                label: targetRecord.label,
                user: targetRecord.user,
                model: targetRecord.model,
                interactions: JSON.stringify(mergedInteractionsForSession),
                ...(langfuseTraceNodesJson !== undefined ? { langfuseTraceNodes: langfuseTraceNodesJson } : {}),
                ...(hasExplicitTraceStart ? { startTime: explicitTraceStartedAt } : {}),
            }
        );
        if (hasTraceCompletion) {
            await db.updateSession(targetRecord.task_id, { endTime: traceCompletedAtForSession });
        }
        if (targetRecord.framework === 'opencode' && targetRecord.opencode_cli_completed === true) {
            await db.updateSession(targetRecord.task_id, { endTime: new Date() });
        }
    }

    // 大盘 B 档：基于内存中的全量 merged interactions 预解析 per-call 摘要（零额外 JSON.parse，
    // 单遍 O(n)，全量重算幂等覆盖）。失败降级 null，绝不阻断主写入。
    if (Array.isArray(mergedInteractionsForSession)) {
        let callStatsJson: string | null = null;
        try {
            callStatsJson = JSON.stringify(computeCallStats(mergedInteractionsForSession, {
                fallbackModel: targetRecord.model ?? null,
                failures: targetRecord.failures ? JSON.stringify(targetRecord.failures) : null,
            }));
        } catch (e) {
            console.warn(`[Data-Service] computeCallStats failed for ${recordId}:`, e);
        }
        if (callStatsJson) {
            try {
                await prismaRaw.execution.update({ where: { id: recordId }, data: { callStats: callStatsJson } });
            } catch (e) {
                console.warn(`[Data-Service] callStats persist failed for ${recordId}:`, e);
            }
        }
    }

    return { success: true, record: targetRecord };
}

interface DeriveSubagentArgs {
    parentExecutionId: string;
    parentTaskId: string;
    parentFramework?: string | null;
    parentUser?: string | null;
    interactions: any[];
}

export interface AgentNodeExecutionProjection {
    query: string;
    finalResult: string | null;
    model: string | null;
    tokens: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    latency: number | null;
    llmCallCount: number;
    toolCallCount: number;
    toolCallErrorCount: number;
}

function interactionContentText(content: any): string {
    if (content == null) return '';
    if (typeof content === 'string') {
        const trimmed = content.trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
            try {
                return interactionContentText(JSON.parse(trimmed));
            } catch {}
        }
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map((part) => interactionContentText(part?.text ?? part?.content ?? part))
            .filter(Boolean)
            .join('\n');
    }
    if (typeof content === 'object') return interactionContentText(content.text ?? content.content ?? '');
    return String(content);
}

function isFailedAgentToolEvent(event: any): boolean {
    const calls = Array.isArray(event?.interaction?.tool_calls) ? event.interaction.tool_calls : [];
    const eventId = event?._toolCallId;
    const call = calls.find((item: any) => !eventId || item?.id === eventId);
    const state = String(call?.state || '').toLowerCase();
    if (state === 'error' || state === 'failed') return true;
    const output = event?.output ?? call?.output ?? call?.result;
    if (output && typeof output === 'object') {
        const status = String(output.status || output.state || '').toLowerCase();
        return status === 'error' || status === 'failed' || !!output.error;
    }
    if (typeof output === 'string' && output.trim().startsWith('{')) {
        try {
            return isFailedAgentToolEvent({ ...event, output: JSON.parse(output), interaction: undefined });
        } catch {}
    }
    return false;
}

function parsedToolArguments(call: any): Record<string, any> {
    const value = call?.function?.arguments ?? call?.arguments;
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string') return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function findSubagentSpawnDescription(interactions: any[], sessionId: string): string | null {
    const sid = String(sessionId || '').trim();
    if (!sid) return null;
    for (const interaction of interactions) {
        const calls = Array.isArray(interaction?.tool_calls) ? interaction.tool_calls : [];
        for (const call of calls) {
            const name = call?.function?.name ?? call?.name;
            if (name !== 'task') continue;
            const args = parsedToolArguments(call);
            const argSessionId = String(args.subagent_session_id ?? args.session_id ?? args.agent_session_id ?? '').trim();
            if (argSessionId !== sid) continue;
            const description = interactionContentText(args.description ?? args.task_description ?? args.prompt ?? args.subagent_type).trim();
            if (description) return description;
        }
    }
    return null;
}

export function projectAgentNodeExecution(node: AgentNode, interactions: any[]): AgentNodeExecutionProjection {
    const ownTurns = (node.interactionIndices || []).map((index) => interactions[index]).filter(Boolean);
    const textTurns = ownTurns
        .map((interaction) => interactionContentText(interaction?.content).trim())
        .filter(Boolean);
    const query = textTurns[0] || node.agentName || node.sessionId;
    const llmEvents = (node.events || []).filter((event) => event.kind === 'llm');
    const meteredLlmEvents = llmEvents.filter((event) => {
        const usage = event.usage;
        return !!usage && ((usage.total || 0) > 0 || (usage.input || 0) > 0 || (usage.output || 0) > 0 || (usage.reasoning || 0) > 0);
    });
    const firstOwnIndex = node.interactionIndices?.[0];
    const fallbackLlmCalls = llmEvents.filter((event) =>
        event.interactionIndex !== firstOwnIndex &&
        (!!event.summary?.trim() || (event.interaction?.tool_calls?.length || 0) > 0)
    ).length;
    const toolEvents = (node.events || []).filter((event) =>
        event.kind === 'tool' || event.kind === 'skill' || event.kind === 'task'
    );
    const model = ownTurns
        .map((interaction) => interaction?.model ?? interaction?.modelID)
        .find((value) => typeof value === 'string' && value.trim()) || null;

    return {
        query,
        finalResult: textTurns.length > 1 ? textTurns[textTurns.length - 1] : null,
        model,
        tokens: node.stats.totalTokens,
        inputTokens: node.stats.inputTokens,
        outputTokens: node.stats.outputTokens,
        reasoningTokens: node.stats.reasoningTokens,
        cacheReadInputTokens: node.stats.cacheReadTokens,
        cacheCreationInputTokens: node.stats.cacheWriteTokens,
        latency: node.stats.durationMs != null ? node.stats.durationMs / 1000 : null,
        llmCallCount: meteredLlmEvents.length || fallbackLlmCalls,
        toolCallCount: toolEvents.length,
        toolCallErrorCount: toolEvents.filter(isFailedAgentToolEvent).length,
    };
}

/**
 * 派生 sub-agent Execution + Session 行。
 *
 * 嵌套关系（关键）：
 *   xuanyuan → dayu → kuafu 这种多层 case，不能按 `subagent_session_id` 平铺分组
 *   （那样会把 kuafu 错挂到 xuanyuan 之下，丢失真实父 dayu）。
 *   改用 `buildAgentCallTree` 从 interactions 序列推断真实父子树（它通过 task() 调用
 *   时机和 subagent_type 队列把每个 sub-agent spawn 关联到 spawning agent），
 *   再 BFS 写库，parentExecutionId 取真实父 node 的 execution id。
 *
 * 字段：
 *   Execution.parentExecutionId = 直接父 agent 的 execution id（嵌套时是上一级 sub-agent）
 *   Execution.rootExecutionId   = 整棵树根 root 的 execution id
 *   Execution.taskId            = sub-agent 的 sessionID（OpenCode 给的 ses_*）
 *   Execution.query             = sub-agent 收到的第一段 user/subagent text（用于
 *                                 列表显示和绕开 /api/observe/session 的 analyzeSession LLM fallback）
 *
 * 幂等：deterministic id `<parentExecId>__sub__<sid>`，多次重放同一份 interactions 不会重复建行。
 * 同 sessionID 多次 parallel spawn → 合并成同一 execution（取第一次的父）。
 */
export async function deriveSubagentExecutions(args: DeriveSubagentArgs): Promise<void> {
    const { parentExecutionId, parentTaskId, parentFramework, parentUser, interactions } = args;
    if (!Array.isArray(interactions) || interactions.length === 0) return;

    const tree = buildAgentCallTree(interactions as any);
    if (!tree) {
        await sweepStaleSubagents(parentExecutionId, new Set());
        return;
    }

    // 收集所有非 root node。同 sessionID 只取首次出现的 node（保留真实父）。
    type SubNode = {
        node: any;
        sessionId: string;
        parentNodeId: string;
    };
    const subNodes: SubNode[] = [];
    const seenSid = new Set<string>();
    walkTree(tree as any, (n: any) => {
        if (!n || n.depth === 0) return;
        const sid = typeof n.sessionId === 'string' ? n.sessionId.trim() : '';
        if (!sid || sid === parentTaskId) return;
        if (seenSid.has(sid)) return;
        seenSid.add(sid);
        subNodes.push({ node: n, sessionId: sid, parentNodeId: n.parentId });
    });
    if (subNodes.length === 0) return;

    // BFS：父先于子处理，这样查 parent exec id 时 mapping 一定已就绪
    subNodes.sort((a, b) => a.node.depth - b.node.depth);

    // node.id → derived execution id；根 node 映射到入参（root execution id）
    const nodeIdToExecId = new Map<string, string>();
    nodeIdToExecId.set(tree.id, parentExecutionId);

    // 本轮派生出的 sub-agent execution id 集合；后面用它清掉同 root 下的陈旧孤儿。
    // 历史上 derive 逻辑变化（如平铺 → 嵌套）会留下旧 id 的孤儿行；用 sweep 修正。
    const freshExecIds = new Set<string>();

    for (const sn of subNodes) {
        const { node, sessionId, parentNodeId } = sn;
        const directParentExecId = nodeIdToExecId.get(parentNodeId) ?? parentExecutionId;
        const childExecutionId = `${directParentExecId}__sub__${sessionId}`;
        nodeIdToExecId.set(node.id, childExecutionId);
        freshExecIds.add(childExecutionId);

        // 切片包含 node 自己 **及所有子孙 node** 的 turns + systemPrompts。
        // 这样每层 sub-agent 的详情页都能用同一份渲染逻辑：buildAgentCallTree 在切片上
        // 重建出该 sub-agent 为根的子树，Trace 跳转、概览子 Agent 卡片、agent-trace 树都自然工作。
        const turnIndices = new Set<number>();
        type SysPromptOwner = { sessionId: string; entries: any[] };
        const sysPromptOwners: SysPromptOwner[] = [];
        const collect = (n: any) => {
            for (const idx of (n.interactionIndices as number[]) || []) turnIndices.add(idx);
            if (Array.isArray(n.systemPrompts) && n.systemPrompts.length > 0 && n.sessionId) {
                sysPromptOwners.push({ sessionId: n.sessionId, entries: n.systemPrompts });
            }
            for (const c of (n.children as any[]) || []) collect(c);
        };
        collect(node);

        const sliceTurns: any[] = [...turnIndices]
            .sort((a, b) => a - b)
            .map((i) => interactions[i])
            .filter(Boolean);

        const sliceSystemPrompts: any[] = [];
        for (const owner of sysPromptOwners) {
            for (const sp of owner.entries) {
                sliceSystemPrompts.push({
                    role: 'system',
                    content: sp.text,
                    subagent_session_id: owner.sessionId,
                    system_prompt_sha256: sp.sha256,
                    system_prompt_length: sp.length,
                    system_prompt_modelID: sp.modelID,
                    system_prompt_providerID: sp.providerID,
                });
            }
        }
        const childInteractions = [...sliceSystemPrompts, ...sliceTurns];
        const projection = projectAgentNodeExecution(node, interactions);
        const spawnDescription = findSubagentSpawnDescription(interactions, sessionId);
        const queryText = (spawnDescription || projection.query).slice(0, 500);
        let ownSkills = extractExplicitSkillsFromNode(node);
        if (EXECUTION_SKILL_ENABLED) {
            try {
                ownSkills = await snapshotSkillVersions(ownSkills, parentUser);
            } catch (e) {
                console.warn(`[Data-Service] sub skill version snapshot failed sub=${sessionId}:`, e);
            }
        }

        const timestamp = node.startedAt ? new Date(node.startedAt) : new Date();
        const childCompletedAt = node.endedAt ? new Date(node.endedAt) : null;

        const baseFields = {
            taskId: sessionId,
            framework: parentFramework,
            timestamp,
            agentName: node.agentName ?? null,
            user: parentUser ?? null,
            query: queryText,
            finalResult: projection.finalResult,
            model: projection.model,
            tokens: projection.tokens,
            inputTokens: projection.inputTokens,
            outputTokens: projection.outputTokens,
            reasoningTokens: projection.reasoningTokens,
            cacheReadInputTokens: projection.cacheReadInputTokens,
            cacheCreationInputTokens: projection.cacheCreationInputTokens,
            latency: projection.latency,
            llmCallCount: projection.llmCallCount,
            toolCallCount: projection.toolCallCount,
            toolCallErrorCount: projection.toolCallErrorCount,
            skills: ownSkills.length ? JSON.stringify(ownSkills.map((skill) => skill.name)) : null,
            invokedSkills: ownSkills.length ? JSON.stringify(ownSkills) : null,
            parentExecutionId: directParentExecId,
            rootExecutionId: parentExecutionId,
            agentSessionId: sessionId,
            subagentType: node.subagentType ?? null,
            subagentName: node.agentName ?? null,
            isSubagent: true,
            // 子 agent 行也 denormalize observedAgents,保证 includeSubagents 的轻量列表 agents 一致。
            observedAgents: JSON.stringify(extractObservedAgentNames(childInteractions)),
        } as const;

        try {
            await db.upsertExecution({
                where: { id: childExecutionId },
                create: { id: childExecutionId, ...baseFields },
                update: { ...baseFields },
            });
        } catch (e) {
            console.warn(`[Data-Service] upsertExecution(sub) failed sub=${sessionId}:`, e);
            continue;
        }

        // 这一层 sub-agent 自己显式调用的 skill(agent 作用域,不含其更深子孙)。
        if (EXECUTION_SKILL_ENABLED) {
            try {
                await persistExecutionSkills(childExecutionId, ownSkills, { user: parentUser ?? null });
            } catch (e) {
                console.warn(`[Data-Service] sub ExecutionSkill persist failed sub=${sessionId}:`, e);
            }
        }

        try {
            await db.upsertSession(
                sessionId,
                {
                    taskId: sessionId,
                    label: node.agentName ?? null,
                    user: parentUser ?? null,
                    query: queryText,
                    interactions: JSON.stringify(childInteractions),
                    ...(childCompletedAt ? { endTime: childCompletedAt } : {}),
                },
                {
                    label: node.agentName ?? null,
                    user: parentUser ?? null,
                    query: queryText,
                    interactions: JSON.stringify(childInteractions),
                    ...(childCompletedAt ? { endTime: childCompletedAt } : {}),
                },
            );
        } catch (e) {
            console.warn(`[Data-Service] upsertSession(sub) failed sub=${sessionId}:`, e);
        }
    }

    // 派生完成 → 删掉同 root 下"本轮没派生出来"的 sub-agent 行（孤儿）。
    // 触发场景：上次 derive 用旧 (扁平) 逻辑写过的行、interactions 被截短后部分 sub-agent 消失、
    // sub-agent 重命名导致 sessionId 变化等。Session 表按 taskId @unique，新 derive 已经把
    // 切片覆盖到正确的 Session 行，所以删掉孤儿 Execution 是安全的（不影响保留行的 interactions）。
    await sweepStaleSubagents(parentExecutionId, freshExecIds);
}

/**
 * 删除某 root 下不在 keepIds 集合里的 sub-agent execution 行。
 * 安全：仅作用于 `isSubagent=true && rootExecutionId=<root>`，root 行自身不会被波及。
 */
async function sweepStaleSubagents(rootExecutionId: string, keepIds: Set<string>): Promise<void> {
    try {
        const existing: any[] = await db.findExecutions(
            { rootExecutionId, isSubagent: true },
            { timestamp: 'desc' },
        );
        for (const r of existing) {
            if (!r?.id || keepIds.has(r.id)) continue;
            try {
                await db.deleteExecution(r.id);
            } catch (e) {
                console.warn(`[Data-Service] sweepStaleSubagents: deleteExecution(${r.id}) failed:`, e);
            }
        }
    } catch (e) {
        console.warn(`[Data-Service] sweepStaleSubagents query failed root=${rootExecutionId}:`, e);
    }
}
