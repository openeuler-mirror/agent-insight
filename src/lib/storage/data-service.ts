import fs from 'fs';
import path from 'path';
import { judgeAnswer } from '@/lib/engine/evaluation/judge';
import { db, prisma } from '@/lib/storage/prisma';
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
import { getRootSkillFromInteractions } from '@/lib/engine/observability/skill-scope';
import {
    extractObservedAgentNames,
    extractObservedAgentRegistrations,
} from '@/lib/engine/observability/agent-registration';
import { chooseExecutionLabel } from '@/lib/engine/evaluation/label-utils';
import { parseLabelSkillVersionBinding } from '@/lib/engine/evaluation/label-skill-binding';
import { extractKeyActionsFromFlow, mergeKeyActionsFromMultipleSkills, type ExtractedKeyAction, type ParsedFlowResult } from '@/lib/engine/observability/flow-parser';
import { mergeSessionInteractionsMonotonic } from '@/lib/engine/observability/session-interactions-merge';
import { buildAgentCallTree, inferSubagentType, walkTree } from '@/lib/engine/observability/agent-trace';
import { isEvaluatorAgentName } from '@/lib/evaluator-agent';
import { normalizeClaudeCodeInteractionsForStorage } from '@/lib/shared/interaction-content';
import {
    normalizeInteractions,
    extractSkillsWithVersionsFromClaudeSession,
    extractSkillsWithVersionsFromOpenClawSession,
    extractSkillsWithVersionsFromOpencodeSession,
} from '@/lib/shared/interaction-utils';

export interface InvokedSkill {
    name: string;
    version: number | null;
}

export interface ExecutionRecord {
    upload_id?: string;
    task_id?: string;
    query?: string;
    framework?: string;
    tokens?: number;
    cost?: number;
    latency?: number;
    timestamp?: string | Date;
    final_result?: string;
    skill?: string;
    rootSkill?: InvokedSkill | null;
    root_skill?: InvokedSkill | null;
    skills?: string[];
    invokedSkills?: InvokedSkill[];
    invoked_skills?: InvokedSkill[];
    agents?: string[];

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
    model?: string | null;
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

function extractInvokedSkillsFromSessionInteractions(framework: string | null | undefined, interactions: any[]): InvokedSkill[] | null {
    if (!Array.isArray(interactions)) return null;
    const normalized = normalizeInteractions(interactions);
    const fw = (framework || '').toLowerCase();

    if (fw === 'opencode') {
        return extractSkillsWithVersionsFromOpencodeSession(normalized);
    }
    if (fw === 'claude' || fw === 'claudecode') {
        return extractSkillsWithVersionsFromClaudeSession(normalized);
    }
    if (fw === 'openclaw') {
        return extractSkillsWithVersionsFromOpenClawSession(normalized);
    }

    return null;
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

const DATA_DIR = path.join(process.cwd(), 'data');
const EVALUATION_FILE = path.join(DATA_DIR, 'evaluation_result.json');
const AUDIT_DATA_MUTATIONS = process.env.AUDIT_DATA_MUTATIONS === '1' || process.env.AUDIT_DATA_MUTATIONS === 'true';

interface ReadRecordFilters {
    query?: string;
    taskId?: string;
    taskIds?: string[];
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
}

interface ReadRecordsOptions {
    attachEvaluations?: boolean;
}

export async function readRecords(
    user?: string,
    filters?: ReadRecordFilters,
    options?: ReadRecordsOptions
): Promise<ExecutionRecord[]> {
    const attachEvaluations = options?.attachEvaluations ?? true;
    const where: any = {};
    if (user && !filters?.showAllUsers) {
        where.OR = [
            { user: user },
            { user: null }
        ];
    }

    // 默认列表只显示 root execution；sub-agent 行通过 trace 视图下钻进入。
    // 显式按 taskId / taskIds / parentExecutionId 查询时跳过该过滤，
    // 让"按 sub-agent sessionID 直查"和"列出某 root 的所有子 agent"都能工作。
    const hasExplicitTaskIdFilter = !!(filters?.taskIds?.length || filters?.taskId);
    if (filters?.onlySubagents === true) {
        where.isSubagent = true;
    } else if (
        filters?.includeSubagents !== true &&
        filters?.parentExecutionId === undefined &&
        !hasExplicitTaskIdFilter
    ) {
        where.isSubagent = false;
    }

    if (filters?.parentExecutionId !== undefined) {
        where.parentExecutionId = filters.parentExecutionId;
    }

    if (filters?.taskIds && filters.taskIds.length > 0) {
        where.taskId = { in: filters.taskIds };
        if (filters.framework) where.framework = filters.framework;
    } else if (!filters?.query && filters?.taskId) {
        where.taskId = filters.taskId;
        if (filters.framework) where.framework = filters.framework;
    } else if (filters?.query) {
        where.query = filters.query;
        if (filters.framework) where.framework = filters.framework;
    }

    if (filters?.skill !== undefined) {
        where.skill = filters.skill;
    }

    if (filters?.skillVersion !== undefined) {
        where.skillVersion = filters.skillVersion;
    }

    const records = await db.findExecutions(where, { timestamp: 'desc' });
    const byTaskId = new Map<string, any[]>();
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

        const canonical = group.find((x: any) => x.id === tid);
        if (canonical) {
            keepIds.add(canonical.id);
            continue;
        }

        const sorted = group.slice().sort((a: any, b: any) => {
            const ta = new Date(a.timestamp).getTime();
            const tb = new Date(b.timestamp).getTime();
            if (tb !== ta) return tb - ta;
            const la = String(a.finalResult || '').length;
            const lb = String(b.finalResult || '').length;
            return lb - la;
        });
        keepIds.add(sorted[0].id);
    }

    const filtered = records.filter((r: any) => {
        if (!r.taskId) return true;
        return keepIds.has(r.id);
    });

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

    // Sessions must be fetched BEFORE building the ownership map: an execution's effective
    // agent name may come from session.interactions when `r.agentName` is empty, and ownership
    // is keyed on that resolved name.
    const [sessions, configsData] = await Promise.all([
        db.findSessions({ user: user || undefined }),
        (async () => {
            const configCache = new Map<string, Promise<ConfigItem[]>>();
            const getConfigsForEvaluationUser = (evaluationUser?: string | null) => {
                const key = evaluationUser || '__global__';
                if (!configCache.has(key)) {
                    configCache.set(key, readConfig(evaluationUser || undefined));
                }
                return configCache.get(key)!;
            };
            return { getConfigsForEvaluationUser };
        })()
    ]);

    const sessionMap = new Map<string, any>();
    sessions.forEach((s: any) => {
        if (s.taskId) sessionMap.set(s.taskId, s);
    });

    // For each record, pre-extract session-derived agent names + the effective agent name
    // used for both display and ownership lookup. Mirrors the frontend's
    // `agentName?.trim() || getPrimaryExecutionAgentName(d)` resolution.
    const recordAgentsByTaskId = new Map<string, string[]>();
    const recordEffectiveAgent = new Map<string, string>();
    const resolveEffectiveAgentName = (agentName: string | null | undefined, sessionAgents: string[]): string => {
        const direct = (agentName || '').trim();
        if (direct) return direct;
        return sessionAgents.find(n => n && !isEvaluatorAgentName(n)) || '';
    };
    filtered.forEach((r: any) => {
        const taskId = r.taskId || r.id;
        const sessionAgents: string[] = [];
        const session = r.taskId ? sessionMap.get(r.taskId) : null;
        if (session?.interactions) {
            try {
                const interactions = JSON.parse(session.interactions);
                if (Array.isArray(interactions)) {
                    const agentSet = new Set<string>();
                    extractObservedAgentNames(interactions).forEach(name => agentSet.add(name));
                    sessionAgents.push(...agentSet);
                }
            } catch { /* ignore */ }
        }
        recordAgentsByTaskId.set(taskId, sessionAgents);
        recordEffectiveAgent.set(taskId, resolveEffectiveAgentName(r.agentName, sessionAgents));
    });

    // Build ownership map keyed by "platform::effectiveAgentName" — ownership is an attribute
    // of agent identity (platform + name). The `user` dimension is collapsed so a given agent
    // name resolves to one ownership regardless of which user's execution record we look at.
    // When multiple registrations exist for (platform, name) across users, prefer
    // user > system > unregistered.
    const OWNERSHIP_RANK: Record<string, number> = { user: 3, system: 2, unregistered: 1 };
    const agentOwnershipMap = new Map<string, string>();
    const uniqueAgents = new Map<string, { platform: string; name: string }>();
    filtered.forEach((r: any) => {
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
        } catch { /* graceful degradation — ownership stays 'unregistered' */ }
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
    filtered.forEach((r: any) => {
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

    return Promise.all(filtered.map(async (r: any) => {
        const model = r.model ?? null;
        const pricingResult = model ? getModelPricing(model) : null;
        const pricing = pricingResult?.pricing ?? null;
        const cwResult = (model && r.maxSingleCallTokens != null) ? getModelContextWindow(model) : null;

        // Extract agents from session (re-parse only for invokedSkills; agent names already
        // pre-computed in recordAgentsByTaskId / recordEffectiveAgent above).
        const taskKey = r.taskId || r.id;
        const agents = recordAgentsByTaskId.get(taskKey) || [];
        const effectiveAgentName = recordEffectiveAgent.get(taskKey) || '';
        let invokedSkillsFromSession: InvokedSkill[] | null = null;
        let rootSkillFromSession: InvokedSkill | null = null;
        const session = r.taskId ? sessionMap.get(r.taskId) : null;
        if (session?.interactions) {
            try {
                const interactions = JSON.parse(session.interactions);
                if (Array.isArray(interactions)) {
                    invokedSkillsFromSession = extractInvokedSkillsFromSessionInteractions(r.framework, interactions);
                    rootSkillFromSession = getRootSkillFromInteractions(interactions);
                }
            } catch { /* ignore */ }
        }
        // 懒回填：Execution.skillVersion 为空但 skill 名命中 DB → 回写 activeVersion。
        // 在 in-memory r 上即时更新（让下方 normalizedRecord 拿到值），同时 fire-and-forget
        // UPDATE DB（不阻塞本次响应）。仅 root execution 回填，sub-agent 行跳过。
        if (r.skill && r.skillVersion == null && !r.isSubagent && skillActiveVersionMap.has(String(r.skill))) {
            const backfilled = skillActiveVersionMap.get(String(r.skill))!;
            r.skillVersion = backfilled;
            // fire-and-forget；只更原本 NULL 的（WHERE 守卫防意外覆盖）
            (prisma as any).execution.updateMany({
                where: { id: r.id, skillVersion: null },
                data: { skillVersion: backfilled },
            }).catch((e: unknown) => console.warn('[readRecords] backfill skillVersion failed for', r.id, ':', e));
        }
        // 兜底：用 Execution 行 denormalized 的 skill + skillVersion 补全 rootSkill。
        // 三种情况都需要兜：
        //   1) interactions 完全解析不出 rootSkill（旧 trace / 没 Session / 上报不规范）→ 整个对象给一个
        //   2) interactions 解出 name 但没 version（agent 调 skill 工具时没传 version 参数，常见）→ 补 version
        //   3) interactions 解出的 name 跟 Execution.skill 不一致 → 保留 interactions 那份不动（agent 实际加载的为准）
        // 跟 analyze-match/route.ts 同口径——前后端版本筛选都靠这个兜底。
        if (r.skill) {
            const execName = String(r.skill);
            const execVersion = typeof r.skillVersion === 'number' ? r.skillVersion : null;
            if (!rootSkillFromSession) {
                rootSkillFromSession = { name: execName, version: execVersion };
            } else if (rootSkillFromSession.name === execName && rootSkillFromSession.version == null && execVersion != null) {
                rootSkillFromSession = { name: rootSkillFromSession.name, version: execVersion };
            }
        }

        const normalizedRecord: ExecutionRecord = {
            ...r,
            upload_id: r.id,
            task_id: r.taskId || undefined,
            query: r.query || undefined,
            framework: r.framework || undefined,
            agent: r.agentName || undefined,
            agentName: r.agentName || undefined,
            agentOwnership: (r.framework && effectiveAgentName)
                ? (agentOwnershipMap.get(`${r.framework}::${effectiveAgentName}`) ?? 'unregistered')
                : 'unregistered',
            tokens: r.tokens || undefined,
            cost: (pricing && r.inputTokens != null && r.outputTokens != null)
                ? calculateCost(r.inputTokens, r.outputTokens, pricing, r.cacheReadInputTokens ?? undefined, r.cacheCreationInputTokens ?? undefined)
                : undefined,
            latency: r.latency || undefined,
            timestamp: r.timestamp?.toISOString?.() || r.timestamp,
            final_result: r.finalResult || undefined,
            skill: r.skill || undefined,
            rootSkill: rootSkillFromSession,
            root_skill: rootSkillFromSession,
            skills: invokedSkillsFromSession ? invokedSkillsFromSession.map(s => s.name) : (r.skills ? JSON.parse(r.skills) : undefined),
            invokedSkills: invokedSkillsFromSession ?? (r.invokedSkills ? JSON.parse(r.invokedSkills) : undefined),
            invoked_skills: invokedSkillsFromSession ?? (r.invokedSkills ? JSON.parse(r.invokedSkills) : undefined),
            is_skill_correct: r.isSkillCorrect ?? false,
            is_answer_correct: r.isAnswerCorrect ?? null,

            answer_score: r.answerScore !== undefined ? r.answerScore : undefined,
            skill_score: r.skillScore !== undefined ? r.skillScore : undefined,
            judgment_reason: r.judgmentReason || undefined,
            failures: r.failures ? JSON.parse(r.failures) : undefined,
            label: r.label ?? null,
            user: r.user ?? null,
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
        normalizedRecord.execution_match = executionMatch;
        if (!attachEvaluations) {
            return normalizedRecord;
        }
        const evaluationUser = normalizedRecord.user ?? user ?? null;
        const configs = await configsData.getConfigsForEvaluationUser(evaluationUser);
        return attachEvaluationSnapshots(normalizedRecord, configs, evaluationUser);
    }));
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
        let incomingInteractions = typeof targetRecord.interactions === 'string'
            ? (() => { try { return JSON.parse(targetRecord.interactions); } catch { return []; } })()
            : targetRecord.interactions;
        if (targetRecord.framework === 'claudecode') {
            incomingInteractions = normalizeClaudeCodeInteractionsForStorage(incomingInteractions);
        }

        mergedInteractionsForSession = incomingInteractions;
        try {
            const existingSession = await db.findSessionByTaskId(targetRecord.task_id);
            let existingInteractions = existingSession?.interactions
                ? (() => { try { return JSON.parse(existingSession.interactions as string); } catch { return []; } })()
                : [];
            if (targetRecord.framework === 'claudecode') {
                existingInteractions = normalizeClaudeCodeInteractionsForStorage(existingInteractions);
            }

            if (Array.isArray(existingInteractions) && existingInteractions.length > 0) {
                mergedInteractionsForSession = mergeSessionInteractionsMonotonic(existingInteractions, incomingInteractions);
            }
        } catch {}

        if (targetRecord.framework === 'claudecode') {
            mergedInteractionsForSession = normalizeClaudeCodeInteractionsForStorage(mergedInteractionsForSession);
        }
        targetRecord.interactions = mergedInteractionsForSession;

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

        try {
            for (const observed of observedAgents) {
                let existingAgent = await prisma.registeredAgent.findFirst({
                    where: {
                        platform,
                        name: observed.name,
                        user: user
                    }
                });

                if (!existingAgent) {
                    existingAgent = await prisma.registeredAgent.create({
                        data: {
                            platform,
                            name: observed.name,
                            user,
                            agentOwnership: 'unregistered',
                            agentType: observed.agentType === 'main'
                                ? (targetRecord.agentType || 'main')
                                : 'subagent'
                        }
                    });
                }

                if (observed.agentType === 'main' && observed.name === targetRecord.agentName) {
                    agentId = existingAgent.id;
                }
            }
        } catch (e) {
            console.error('[Data-Service] Failed to query or create RegisteredAgent:', e);
        }
    }

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

    // 多 Agent 拆分：把 root execution 里挂着的 sub-agent 切片单独派生成 Execution + Session 行，
    // 通过 parentExecutionId 与 root 建立父子关系。列表/聚合默认 filter isSubagent=false，
    // 详情页可下钻到 sub-agent。历史上这里曾对相同 taskId 的 child Execution 做 dedup 删除，
    // 现在反过来——保留它们，并补齐父子链接。
    if (targetRecord.framework === 'opencode' && targetRecord.task_id && Array.isArray(mergedInteractionsForSession)) {
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

    if (targetRecord.task_id && mergedInteractionsForSession) {
        await db.upsertSession(
            targetRecord.task_id,
            {
                taskId: targetRecord.task_id,
                query: targetRecord.query,
                label: targetRecord.label,
                user: targetRecord.user,
                model: targetRecord.model,
                interactions: JSON.stringify(mergedInteractionsForSession)
            },
            {
                query: targetRecord.query,
                label: targetRecord.label,
                user: targetRecord.user,
                model: targetRecord.model,
                interactions: JSON.stringify(mergedInteractionsForSession)
            }
        );
        if (targetRecord.framework === 'opencode' && targetRecord.opencode_cli_completed === true) {
            await db.updateSession(targetRecord.task_id, { endTime: new Date() });
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

        // 抽 query：用第一条有文本内容的 turn（避免 /api/observe/session 触发 LLM analyzeSession）
        const queryText = (() => {
            for (const it of sliceTurns) {
                const c = typeof it?.content === 'string' ? it.content.trim() : '';
                if (c) return c.slice(0, 500);
            }
            return node.agentName || sessionId;
        })();

        const timestamp = node.startedAt ? new Date(node.startedAt) : new Date();

        const baseFields = {
            taskId: sessionId,
            framework: parentFramework,
            timestamp,
            agentName: node.agentName ?? null,
            user: parentUser ?? null,
            query: queryText,
            parentExecutionId: directParentExecId,
            rootExecutionId: parentExecutionId,
            agentSessionId: sessionId,
            subagentType: node.subagentType ?? null,
            subagentName: node.agentName ?? null,
            isSubagent: true,
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

        try {
            await db.upsertSession(
                sessionId,
                {
                    taskId: sessionId,
                    label: node.agentName ?? null,
                    user: parentUser ?? null,
                    query: queryText,
                    interactions: JSON.stringify(childInteractions),
                },
                {
                    label: node.agentName ?? null,
                    user: parentUser ?? null,
                    query: queryText,
                    interactions: JSON.stringify(childInteractions),
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
