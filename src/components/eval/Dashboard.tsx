'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { SkillLinks } from '@/components/skills/SkillLink';
import { useTheme, useThemeColors } from '@/lib/client/theme-context';
import { useLocale } from '@/lib/client/locale-context';
import { apiFetch, getApiUrl } from '@/lib/client/api';
import {
    configSupportsDatasetType,
    hasOutcomeExpectations,
    hasRoutingExpectations,
    normalizeExpectedSkills,
    normalizeConfigDatasetType,
    type ConfigDatasetType,
} from '@/lib/engine/evaluation/config-dataset';
import {
    formatSkillTargetLabel,
    normalizeConfigQuery,
    normalizeConfigSkillName,
    normalizeOptionalSkillVersion,
} from '@/lib/engine/evaluation/config-target';
import { LanguageSwitch } from '@/components/primitives/LanguageSwitch';


// --- Types ---
interface InvokedSkill {
    name: string;
    version: number | null;
}

interface RoutingMatchedSkill {
    skill: string;
    expected_version: number | null;
    invoked_version: number | null;
}

interface RoutingSkillBreakdown {
    skill: string;
    expected: boolean;
    invoked: boolean;
    matched: boolean;
    status: 'matched' | 'missed' | 'unexpected' | 'not_applicable';
    expected_version: number | null;
    invoked_version: number | null;
}

interface RoutingEvaluation {
    status: 'available' | 'missing';
    matched_config_id?: string;
    matched_query?: string;
    matched_intent?: string;
    matched_anchors?: string[];
    expected_skills: { skill: string; version: number | null }[];
    invoked_skills: InvokedSkill[];
    matched_skills: RoutingMatchedSkill[];
    expected_count: number;
    matched_count: number;
    is_correct: boolean;
    trigger_rate: number | null;
    skill_breakdown: RoutingSkillBreakdown[];
}

interface OutcomeSkillBreakdown {
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

interface OutcomeEvaluation {
    status: 'available' | 'missing' | 'pending';
    matched_config_id?: string;
    matched_query?: string;
    matched_skill?: string;
    matched_skill_version?: number | null;
    is_correct: boolean | null;
    score: number | null;
    reason?: string;
    standard_answer_present: boolean;
    root_cause_count: number;
    key_action_count: number;
    skill_breakdown: OutcomeSkillBreakdown[];
}

interface Execution {
    timestamp: string;
    framework: string;
    tokens: number;
    latency: number;
    query: string;
    skill?: string;
    skills?: string[];
    invokedSkills?: InvokedSkill[];
    skill_version?: string;
    final_result?: string;
    is_skill_correct?: boolean;
    is_answer_correct?: boolean;
    answer_score?: number | null;
    judgment_reason?: string;
    cost?: number;
    cost_pricing?: { inputTokenPrice: number; outputTokenPrice: number; cacheReadInputTokenPrice?: number; cacheCreationInputTokenPrice?: number; source?: 'default' | 'custom' } | null;
    skill_score?: number;
    label?: string;
    task_id?: string;
    upload_id?: string;
    user?: string | null;
    user_feedback?: {
        type: 'like' | 'dislike' | null;
        comment: string;
    };
    failures?: {
        failure_type: string;
        description: string;
        context: string;
        recovery: string;
        attribution?: string;
        attribution_reason?: string;
    }[];
    model?: string;
    skill_trigger_rate?: number | null;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    reasoning_tokens?: number;
    routing_evaluation?: RoutingEvaluation;
    outcome_evaluation?: OutcomeEvaluation;
    is_evaluating?: boolean;
}

interface ConfigItem {
    id: string;
    query?: string | null;
    dataset_type?: ConfigDatasetType;
    skill: string;
    skillVersion?: number | null;
    routing_intent?: string | null;
    routing_anchors?: string[];
    expectedSkills?: { skill: string; version: number | null }[];
    standard_answer: string;
    root_causes?: { content: string; weight: number }[];
    key_actions?: { content: string; weight: number; controlFlowType?: string; condition?: string; branchLabel?: string; loopCondition?: string; expectedMinCount?: number; expectedMaxCount?: number; groupId?: string }[];
    extractedKeyActions?: { id: string; content: string; weight: number; controlFlowType: string; condition?: string; branchLabel?: string; loopCondition?: string; expectedMinCount?: number; expectedMaxCount?: number; skillSource?: string; groupId?: string }[];
    parse_status?: string;
}

type OutcomeSharedKeyAction = NonNullable<ConfigItem['key_actions']>[number];
type OutcomeExtractedKeyAction = NonNullable<ConfigItem['extractedKeyActions']>[number];

interface OutcomeKeyActionSummaryItem {
    key: 'required' | 'conditional' | 'loop' | 'optional' | 'handoff';
    label: string;
    count: number;
    color: string;
}

interface OutcomeConfigGroup {
    key: string;
    skill: string;
    skillVersion: number | null;
    configs: ConfigItem[];
    datasetTypes: ConfigDatasetType[];
    sharedKeyActions: OutcomeSharedKeyAction[];
    sharedExtractedKeyActions: OutcomeExtractedKeyAction[];
    sharedKeyActionSource: 'flow' | 'shared';
    sharedControlFlowSummary: OutcomeKeyActionSummaryItem[];
    hasGenericScenario: boolean;
}

interface SkillOption {
    id: string;
    name: string;
    versions: { version: number }[];
}

function MultiSelectDropdown(props: {
    value: string[];
    options: string[];
    placeholder: string;
    minWidth?: string;
    onChange: (next: string[]) => void;
}) {
    const { value, options, placeholder, minWidth, onChange } = props;
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) return;
        const onDocMouseDown = (e: MouseEvent) => {
            const el = rootRef.current;
            if (!el) return;
            if (e.target instanceof Node && !el.contains(e.target)) setOpen(false);
        };
        document.addEventListener('mousedown', onDocMouseDown);
        return () => document.removeEventListener('mousedown', onDocMouseDown);
    }, [open]);

    const label = useMemo(() => {
        if (!value || value.length === 0) return placeholder;
        if (value.length === 1) return value[0];
        return `${value[0]} +${value.length - 1}`;
    }, [placeholder, value]);

    return (
        <div ref={rootRef} style={{ position: 'relative', display: 'inline-block', minWidth: minWidth || '160px' }}>
            <div
                className="dropdown-trigger"
                style={{ background: 'var(--dropdown-bg)', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', border: '1px solid var(--dropdown-border)', color: 'var(--foreground)' }}
                onClick={() => setOpen(v => !v)}
            >
                {label}
                <span style={{ float: 'right', fontSize: '0.8rem' }}>▼</span>
            </div>
            {open && (
                <div
                    className="dropdown-content"
                    style={{
                        position: 'absolute',
                        top: '100%',
                        left: 0,
                        zIndex: 20,
                        background: 'var(--dropdown-bg)',
                        border: '1px solid var(--dropdown-border)',
                        borderRadius: '4px',
                        padding: '0.5rem',
                        minWidth: minWidth || '200px',
                        maxHeight: '300px',
                        overflowY: 'auto',
                        boxShadow: '0 4px 6px -1px var(--shadow-color)',
                    }}
                >
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '6px' }}>
                        <button
                            type="button"
                            onClick={() => onChange([])}
                            style={{ padding: '2px 6px', borderRadius: '4px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--foreground-secondary)', cursor: 'pointer', fontSize: '0.8rem' }}
                        >
                            清空
                        </button>
                        <button
                            type="button"
                            onClick={() => onChange([...options])}
                            style={{ padding: '2px 6px', borderRadius: '4px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--foreground-secondary)', cursor: 'pointer', fontSize: '0.8rem' }}
                        >
                            全选
                        </button>
                    </div>
                    <hr style={{ borderColor: 'var(--border)', margin: '6px 0' }} />
                    {options.map((opt) => (
                        <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px', cursor: 'pointer', color: 'var(--foreground)' }}>
                            <input
                                type="checkbox"
                                checked={value.includes(opt)}
                                onChange={(e) => {
                                    if (e.target.checked) {
                                        onChange([...value, opt]);
                                    } else {
                                        onChange(value.filter(x => x !== opt));
                                    }
                                }}
                            />
                            <span>{opt}</span>
                        </label>
                    ))}
                    {options.length === 0 && (
                        <div style={{ color: 'var(--foreground-muted)', fontSize: '0.85rem' }}>—</div>
                    )}
                </div>
            )}
        </div>
    );
}

interface AvgComparison {
    query: string;
    shortQuery: string;
    latestTimestamp: number;
    [key: string]: string | number | null;
}

const CHART_COLORS = ['#2563eb', '#7c3aed', '#16a34a', '#d97706', '#db2777', '#dc2626'];
const CHART_COLORS_DARK = ['#3b82f6', '#818cf8', '#22c55e', '#f59e0b', '#f472b6', '#ef4444'];
const basePath = process.env.NEXT_PUBLIC_URL_PREFIX || '';

// --- Helpers ---
const formatLatency = (ms: number) => {
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    const seconds = ms / 1000;
    if (seconds >= 60) {
        const m = Math.floor(seconds / 60);
        const s = Math.round(seconds % 60);
        return s === 0 ? `${m}m` : `${m}m${s}s`;
    }
    return `${seconds.toFixed(1)}s`;
};

const formatTokens = (num: number) => {
    if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
    return num.toString();
};

const formatCost = (cost?: number) => {
    if (cost == null) return null;
    if (cost === 0) return '$0.00';
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    if (cost < 1) return `$${cost.toFixed(3)}`;
    return `$${cost.toFixed(2)}`;
};

type BestWorstMetric = 'latency' | 'accuracy' | 'tokens' | 'cost' | 'trigger';

const getMetricValue = (d: Execution, metric: BestWorstMetric): number => {
    switch (metric) {
        case 'latency': return d.latency;
        case 'accuracy': return d.answer_score ?? 0;
        case 'tokens': return d.tokens;
        case 'cost': return d.cost ?? 0;
        case 'trigger': return (d.skill_trigger_rate ?? 0) * 100;
    }
};

const hasMetricValue = (d: Execution, metric: BestWorstMetric): boolean => {
    switch (metric) {
        case 'latency': return d.latency != null;
        case 'accuracy': return d.answer_score != null;
        case 'tokens': return d.tokens != null;
        case 'cost': return d.cost != null;
        case 'trigger': return d.skill_trigger_rate != null;
    }
};

const getMetricLabel = (metric: BestWorstMetric, t: (key: string) => string): string => {
    switch (metric) {
        case 'latency': return t('metrics.latency');
        case 'accuracy': return t('metrics.accuracy');
        case 'tokens': return t('metrics.tokens');
        case 'cost': return t('metrics.cost');
        case 'trigger': return t('metrics.trigger');
    }
};

const getMetricFormattedValue = (d: Execution, metric: BestWorstMetric): string => {
    switch (metric) {
        case 'latency': return formatLatency(d.latency);
        case 'accuracy': return d.answer_score === null ? '--' : (d.answer_score || 0).toFixed(2);
        case 'tokens': return formatTokens(d.tokens);
        case 'cost': return formatCost(d.cost) || '-';
        case 'trigger': return d.skill_trigger_rate == null ? '--' : `${((d.skill_trigger_rate ?? 0) * 100).toFixed(1)}%`;
    }
};

const isMetricLowerBetter = (metric: BestWorstMetric): boolean => {
    return metric === 'latency' || metric === 'tokens' || metric === 'cost';
};

const formatDiff = (diff: number | null, lowerBetter: boolean, isDark: boolean = false): React.ReactNode => {
    if (diff === null) return null;
    if (Math.abs(diff) < 0.05) {
        return <span style={{ fontSize: '0.75rem', color: isDark ? '#71717a' : '#a1a1aa', marginLeft: '4px' }}>—</span>;
    }
    const isPositive = diff > 0;
    const isGood = lowerBetter ? !isPositive : isPositive;
    const color = isGood ? (isDark ? '#22c55e' : '#16a34a') : (isDark ? '#ef4444' : '#dc2626');
    const arrow = isPositive ? '↑' : '↓';
    return <span style={{ fontSize: '0.75rem', color, marginLeft: '4px' }}>{arrow}{Math.abs(diff).toFixed(1)}%</span>;
};

const formatExpectedSkillList = (skills: { skill: string; version: number | null }[] = []) => {
    if (skills.length === 0) return '--';
    return skills
        .map(item => `${item.skill}${item.version != null ? ` v${item.version}` : ''}`)
        .join(', ');
};

const formatInvokedSkillList = (skills: InvokedSkill[] = []) => {
    if (skills.length === 0) return '--';
    return skills
        .map(item => `${item.name}${item.version != null ? ` v${item.version}` : ''}`)
        .join(', ');
};

const truncateCardText = (value: string, maxLength = 120) => (
    value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
);

const getConfigDisplayTitle = (config: ConfigItem, sectionType: 'routing' | 'outcome') => {
    if (sectionType === 'routing') {
        const semanticIntent = config.routing_intent?.trim();
        if (semanticIntent) {
            return semanticIntent;
        }
        const query = normalizeConfigQuery(config.query);
        return query ? truncateCardText(query) : '未命名 Skill 召回率基准';
    }
    return formatSkillTargetLabel(config.skill, config.skillVersion ?? null) || '未绑定 Skill 执行效果基准';
};

const getOutcomeTargetMeta = (config: ConfigItem) => {
    const query = normalizeConfigQuery(config.query);
    if (!query) return null;
    return query.length > 90 ? `${query.slice(0, 90)}...` : query;
};

const getOutcomeScenarioLabel = (config: ConfigItem) => {
    const query = normalizeConfigQuery(config.query);
    return query ? truncateCardText(query, 90) : '通用基准';
};

const getOutcomeGroupKey = (skill: string, skillVersion: number | null | undefined) => (
    `${normalizeConfigSkillName(skill) || '__unbound_skill__'}::${normalizeOptionalSkillVersion(skillVersion) ?? 'any'}`
);

const sortOutcomeScenarioConfigs = (items: ConfigItem[]) => [...items].sort((a, b) => {
    const queryA = normalizeConfigQuery(a.query);
    const queryB = normalizeConfigQuery(b.query);

    if (!queryA && queryB) return -1;
    if (queryA && !queryB) return 1;
    if (!queryA && !queryB) return a.id.localeCompare(b.id);
    return (queryA || '').localeCompare(queryB || '', 'zh-CN');
});

const buildOutcomeKeyActionSummary = (items: OutcomeSharedKeyAction[]): OutcomeKeyActionSummaryItem[] => {
    const meta: Record<OutcomeKeyActionSummaryItem['key'], { label: string; color: string }> = {
        required: { label: '必选', color: '#38bdf8' },
        conditional: { label: '条件分支', color: '#fbbf24' },
        loop: { label: '循环', color: '#a78bfa' },
        optional: { label: '可选', color: '#94a3b8' },
        handoff: { label: '衔接', color: '#4ade80' },
    };

    const counts: Record<OutcomeKeyActionSummaryItem['key'], number> = {
        required: 0,
        conditional: 0,
        loop: 0,
        optional: 0,
        handoff: 0,
    };

    for (const item of items) {
        const cfType = item.controlFlowType || 'required';
        const key = (cfType in counts ? cfType : 'required') as OutcomeKeyActionSummaryItem['key'];
        counts[key] += 1;
    }

    return (Object.keys(meta) as OutcomeKeyActionSummaryItem['key'][])
        .map(key => ({
            key,
            label: meta[key].label,
            count: counts[key],
            color: meta[key].color,
        }))
        .filter(item => item.count > 0);
};

const buildOutcomeConfigGroup = (configs: ConfigItem[]): OutcomeConfigGroup | null => {
    if (configs.length === 0) return null;
    const sortedConfigs = sortOutcomeScenarioConfigs(configs);
    const first = sortedConfigs[0];
    const sourceConfig = sortedConfigs.find(config => (config.extractedKeyActions || []).length > 0)
        || sortedConfigs.find(config => (config.key_actions || []).length > 0)
        || first;
    const sharedKeyActions = sourceConfig?.key_actions || [];
    const sharedExtractedKeyActions = sourceConfig?.extractedKeyActions || [];

    return {
        key: getOutcomeGroupKey(first.skill, first.skillVersion),
        skill: normalizeConfigSkillName(first.skill),
        skillVersion: normalizeOptionalSkillVersion(first.skillVersion),
        configs: sortedConfigs,
        datasetTypes: Array.from(new Set(sortedConfigs.map(config => normalizeConfigDatasetType(config.dataset_type)))),
        sharedKeyActions,
        sharedExtractedKeyActions,
        sharedKeyActionSource: sharedExtractedKeyActions.length > 0 ? 'flow' : 'shared',
        sharedControlFlowSummary: buildOutcomeKeyActionSummary(sharedKeyActions),
        hasGenericScenario: sortedConfigs.some(config => !normalizeConfigQuery(config.query)),
    };
};

const getRoutingSourceQueryMeta = (config: ConfigItem) => {
    const query = normalizeConfigQuery(config.query);
    if (!query) return null;
    return truncateCardText(query, 140);
};

const getRoutingEvaluationMeta = (routing?: RoutingEvaluation) => {
    if (!routing || routing.status === 'missing') {
        return {
            label: '未配置 Skill 召回率数据集',
            accent: '#94a3b8',
            background: 'rgba(148, 163, 184, 0.12)',
            border: 'rgba(148, 163, 184, 0.35)',
        };
    }

    if ((routing.trigger_rate ?? 0) >= 1) {
        return {
            label: '完全命中',
            accent: '#4ade80',
            background: 'rgba(74, 222, 128, 0.12)',
            border: 'rgba(74, 222, 128, 0.35)',
        };
    }

    if (routing.is_correct) {
        return {
            label: '部分命中',
            accent: '#fbbf24',
            background: 'rgba(251, 191, 36, 0.12)',
            border: 'rgba(251, 191, 36, 0.35)',
        };
    }

    return {
        label: '未命中',
        accent: '#f87171',
        background: 'rgba(248, 113, 113, 0.12)',
        border: 'rgba(248, 113, 113, 0.35)',
    };
};

const getOutcomeEvaluationMeta = (outcome?: OutcomeEvaluation) => {
    if (!outcome || outcome.status === 'missing') {
        return {
            label: '未配置 Skill 执行效果数据集',
            accent: '#94a3b8',
            background: 'rgba(148, 163, 184, 0.12)',
            border: 'rgba(148, 163, 184, 0.35)',
        };
    }

    if (outcome.status === 'pending') {
        return {
            label: '评测中',
            accent: '#38bdf8',
            background: 'rgba(56, 189, 248, 0.12)',
            border: 'rgba(56, 189, 248, 0.35)',
        };
    }

    if ((outcome.score ?? 0) > 0.8) {
        return {
            label: '达标',
            accent: '#4ade80',
            background: 'rgba(74, 222, 128, 0.12)',
            border: 'rgba(74, 222, 128, 0.35)',
        };
    }

    return {
        label: '待改进',
        accent: '#f87171',
        background: 'rgba(248, 113, 113, 0.12)',
        border: 'rgba(248, 113, 113, 0.35)',
    };
};

const getRoutingSkillStatusMeta = (status?: RoutingSkillBreakdown['status'] | 'missing_dataset') => {
    switch (status) {
        case 'matched':
            return { label: '命中', color: '#4ade80', background: 'rgba(74, 222, 128, 0.12)', border: 'rgba(74, 222, 128, 0.35)' };
        case 'missed':
            return { label: '漏召回', color: '#f87171', background: 'rgba(248, 113, 113, 0.12)', border: 'rgba(248, 113, 113, 0.35)' };
        case 'unexpected':
            return { label: '误召回', color: '#fbbf24', background: 'rgba(251, 191, 36, 0.12)', border: 'rgba(251, 191, 36, 0.35)' };
        case 'missing_dataset':
            return { label: '未配置 Skill 召回率数据集', color: '#94a3b8', background: 'rgba(148, 163, 184, 0.12)', border: 'rgba(148, 163, 184, 0.35)' };
        default:
            return { label: '仅上下文涉及', color: '#94a3b8', background: 'rgba(148, 163, 184, 0.12)', border: 'rgba(148, 163, 184, 0.35)' };
    }
};

const calculateCPSR = (records: Execution[]): number | null => {
    const recordsWithCost = records.filter(d => d.cost != null);
    if (recordsWithCost.length === 0) return null;

    const totalRuns = recordsWithCost.length;
    const successfulRuns = recordsWithCost.filter(d => d.is_answer_correct).length;
    if (successfulRuns === 0) return null;

    const successRate = successfulRuns / totalRuns;
    const avgCost = recordsWithCost.reduce((sum, d) => sum + (d.cost || 0), 0) / totalRuns;

    return avgCost / successRate;
};

interface SkillLiftResult {
    valuePct: number | null;
    passSkill: number | null;
    passNoSkill: number | null;
    evaluatedSkillCount: number;
    evaluatedBaselineCount: number;
    reason: string | null;
}

const getEvaluatedRecords = (records: Execution[]) =>
    records.filter(d => d.answer_score !== null && d.answer_score !== undefined);

const calculateSuccessRate = (records: Execution[]) => {
    const evaluatedRecords = getEvaluatedRecords(records);
    if (evaluatedRecords.length === 0) {
        return { successRate: null, evaluatedCount: 0 };
    }

    const successfulRuns = evaluatedRecords.filter(d => d.is_answer_correct === true).length;
    return {
        successRate: successfulRuns / evaluatedRecords.length,
        evaluatedCount: evaluatedRecords.length
    };
};

const calculateSkillLift = (records: Execution[], skillLabel: string): SkillLiftResult => {
    const skillRecords = records.filter(d => (d.label || 'Other') === skillLabel);
    const baselineRecords = records.filter(d => d.label === 'without-skill');

    const { successRate: passSkill, evaluatedCount: evaluatedSkillCount } = calculateSuccessRate(skillRecords);
    const { successRate: passNoSkill, evaluatedCount: evaluatedBaselineCount } = calculateSuccessRate(baselineRecords);

    if (evaluatedBaselineCount === 0) {
        return {
            valuePct: null,
            passSkill,
            passNoSkill,
            evaluatedSkillCount,
            evaluatedBaselineCount,
            reason: '缺少 without-skill 基线或基线数据尚未完成评测，暂无法计算。'
        };
    }

    if (evaluatedSkillCount === 0) {
        return {
            valuePct: null,
            passSkill,
            passNoSkill,
            evaluatedSkillCount,
            evaluatedBaselineCount,
            reason: '当前标签下暂无可用于计算的已评测数据。'
        };
    }

    if (passSkill === null || passNoSkill === null) {
        return {
            valuePct: null,
            passSkill,
            passNoSkill,
            evaluatedSkillCount,
            evaluatedBaselineCount,
            reason: '当前数据不足以完成技能提升计算。'
        };
    }

    if (passNoSkill >= 1) {
        return {
            valuePct: null,
            passSkill,
            passNoSkill,
            evaluatedSkillCount,
            evaluatedBaselineCount,
            reason: 'without-skill 基线成功率为 100%，公式分母为 0，暂无法计算。'
        };
    }

    return {
        valuePct: ((passSkill - passNoSkill) / (1 - passNoSkill)) * 100,
        passSkill,
        passNoSkill,
        evaluatedSkillCount,
        evaluatedBaselineCount,
        reason: null
    };
};

const formatDateTime = (ts: string | Date) => {
    if (!ts) return '-';
    const d = new Date(ts);
    return d.getFullYear() + '/' +
        String(d.getMonth() + 1).padStart(2, '0') + '/' +
        String(d.getDate()).padStart(2, '0') + ' ' +
        String(d.getHours()).padStart(2, '0') + ':' +
        String(d.getMinutes()).padStart(2, '0') + ':' +
        String(d.getSeconds()).padStart(2, '0');
};

const generateId = () => Math.random().toString(36).substr(2, 9);

const CustomTooltip = ({ content }: { content: React.ReactNode }) => {
    const tc = useThemeColors();
    const [visible, setVisible] = useState(false);
    const triggerRef = useRef<HTMLSpanElement>(null);
    const [coords, setCoords] = useState({ top: 0, left: 0 });

    const handleMouseEnter = () => {
        if (triggerRef.current) {
            const rect = triggerRef.current.getBoundingClientRect();
            setCoords({
                top: rect.top,
                left: rect.left + rect.width / 2
            });
            setVisible(true);
        }
    };

    return (
        <>
            <span
                ref={triggerRef}
                style={{ marginLeft: '4px', cursor: 'help', display: 'inline-flex', alignItems: 'center', color: 'var(--foreground-muted)' }}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={() => setVisible(false)}
                aria-label="字段说明"
            >
                <Info style={{ width: 16, height: 16 }} aria-hidden />
            </span>
            {visible && typeof document !== 'undefined' && createPortal(
                <div style={{
                    position: 'fixed',
                    top: coords.top - 8,
                    left: coords.left,
                    transform: 'translate(-50%, -100%)',
                    background: tc.bg,
                    border: `1px solid ${tc.border}`,
                    color: tc.fg,
                    padding: '6px 10px',
                    borderRadius: '4px',
                    whiteSpace: 'pre-wrap',
                    minWidth: '200px',
                    textAlign: 'left',
                    zIndex: 9999,
                    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
                    pointerEvents: 'none'
                }}>
                    {content}
                    <div style={{
                        position: 'absolute',
                        top: '100%',
                        left: '50%',
                        marginLeft: '-4px',
                        width: 0,
                        height: 0,
                        borderLeft: '4px solid transparent',
                        borderRight: '4px solid transparent',
                        borderTop: `4px solid ${tc.border}`
                    }} />
                </div>,
                document.body
            )}
        </>
    );
};

import { useAuth } from '@/lib/auth/auth-context';
import SkillRegistry from '@/components/skills/SkillRegistry';
import UserGuide, { GuideStep } from '@/components/onboarding/UserGuide';
import { useUserGuide } from '@/lib/client/use-user-guide';
import { getFilteredStepsConfig, GuideStepConfig } from '@/lib/client/guide-config';

// --- Main Component ---
export type DashboardTab = 'dashboard' | 'config' | 'skill';

export interface DashboardProps {
    /** Hide built-in title + main nav tabs (when embedded inside the AppShell sidebar layout) */
    embedded?: boolean;
    /** Initial active tab */
    initialTab?: DashboardTab;
}

export default function Dashboard({ embedded = false, initialTab = 'dashboard' }: DashboardProps = {}) {
    const { user, apiKey } = useAuth();
    const [isOrgMode, setIsOrgMode] = useState(false);
    const { theme, toggleTheme, isDark } = useTheme();
    const { locale, toggleLocale, t } = useLocale();
    const c = useThemeColors();
    const [localApiKey, setLocalApiKey] = useState<string | null>(null);

    const {
        guideState,
        loading: guideLoading,
        shouldShowGuide,
        setShouldShowGuide,
        markStepSkipped,
        disableGuide,
        dismissForToday,
    } = useUserGuide(user);

    const [guideSteps, setGuideSteps] = useState<GuideStep[]>([]);

    useEffect(() => {
        if (guideState) {
            const filteredConfigs = getFilteredStepsConfig(
                guideState.completedSteps,
                guideState.skippedSteps
            );
            const stepsWithCommands: GuideStep[] = filteredConfigs.map(config => {
                const step: GuideStep = {
                    id: config.id,
                    target: config.target,
                    title: t(config.titleKey),
                    content: t(config.contentKey),
                    position: config.position,
                    action: config.action,
                    actionLabel: config.actionLabelKey ? t(config.actionLabelKey) : undefined,
                    linkUrl: config.linkUrl,
                    linkText: config.linkTextKey ? t(config.linkTextKey) : undefined,
                };
                if (config.id === 'welcome' && apiKey && typeof window !== 'undefined') {
                    const host = window.location.host;
                    const protocol = window.location.protocol;
                    const baseUrl = `${protocol}//${host}`;
                    const setupUrl = getApiUrl('/api/ingest/setup');

                    const linuxCommand = `curl -sSf "${baseUrl}${setupUrl}" | bash`;
                    const windowsCommand = `irm "${baseUrl}${setupUrl}" | iex`;

                    return {
                        ...step,
                        setupCommands: {
                            linux: linuxCommand,
                            windows: windowsCommand,
                        },
                        apiKey: apiKey,
                    };
                }
                return step;
            });

            setGuideSteps(stepsWithCommands);
        }
    }, [guideState, apiKey, t]);

    // Setup local state for apiKey after mount to avoid hydration mismatch
    useEffect(() => {
        if (apiKey) setLocalApiKey(apiKey);
        // Fallback or explicit check if useAuth doesn't populate immediately but we want to be sure
        else if (typeof window !== 'undefined') {
            const stored = localStorage.getItem('api_key');
            if (stored) setLocalApiKey(stored);
        }
    }, [apiKey]);

    const [activeTab, setActiveTab] = useState<DashboardTab>(initialTab);
    const [showUserModal, setShowUserModal] = useState(false); // State for User Modal

    // Fetch fresh 密钥 from DB when user modal opens to ensure accuracy
    useEffect(() => {
        if (showUserModal && user) {
            apiFetch('/api/auth/apikey', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: user })
            })
                .then(res => res.json())
                .then(data => {
                    if (data.apiKey) {
                        setLocalApiKey(data.apiKey);
                        localStorage.setItem('api_key', data.apiKey); // Keep cache in sync with DB
                    }
                })
                .catch(err => console.error("Failed to fetch fresh API key", err));
        }
    }, [showUserModal, user]);

    // Data States
    const [rawData, setRawData] = useState<Execution[]>([]);
    const [loadingData, setLoadingData] = useState(true);

    // Config States
    const [configs, setConfigs] = useState<ConfigItem[]>([]);
    const [availableSkills, setAvailableSkills] = useState<SkillOption[]>([]);


    // Rejudge State
    const [rejudgingIds, setRejudgingIds] = useState<Set<string>>(new Set());

    // Interactive States
    const [selectedRecord, setSelectedRecord] = useState<Execution | null>(null);

    // Inline Editing
    const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
    const [tempLabelValue, setTempLabelValue] = useState<string>('');

    // Filters
    const [timeFilter, setTimeFilter] = useState('all');
    const [comparisonMode, setComparisonMode] = useState<'latest_10' | 'single' | 'all'>('latest_10');
    const [comparisonQuery, setComparisonQuery] = useState<string>('');

    // Drill-down Filters
    const [selectedFramework, setSelectedFramework] = useState<string>('');
    const [selectedQuery, setSelectedQuery] = useState<string>('');
    const [selectedLabel, setSelectedLabel] = useState<string>('');

    // Comparison Options
    const [comparisonGroupByLabel, setComparisonGroupByLabel] = useState(false);
    const [selectedComparisonLabels, setSelectedComparisonLabels] = useState<string[]>([]);
    const [comparisonDimension, setComparisonDimension] = useState<'framework' | 'model'>('framework');

    // Drill-down Classification Options
    const [drillDownGroupByLabel, setDrillDownGroupByLabel] = useState(false);
    const [drillDownGroupByModel, setDrillDownGroupByModel] = useState(false);
    const [selectedDrillDownLabels, setSelectedDrillDownLabels] = useState<string[]>([]);
    const [selectedDrillDownModels, setSelectedDrillDownModels] = useState<string[]>([]);
    const [bestWorstMetric, setBestWorstMetric] = useState<BestWorstMetric>('latency');

    // User Feedback State
    const [feedbackComment, setFeedbackComment] = useState('');
    const [copiedApiKey, setCopiedApiKey] = useState(false);

    // Settings Modal State
    const [showSettingsModal, setShowSettingsModal] = useState(false);
    const [isSavingSettings, setIsSavingSettings] = useState(false);
    const [settingsStatus, setSettingsStatus] = useState<{ type: 'success' | 'error', msg: string } | null>(null);
    const [autoEvaluationEnabled, setAutoEvaluationEnabled] = useState(true);

    interface EvalConfigItem {
        id: string;
        name: string;
        provider: 'deepseek' | 'openai' | 'anthropic' | 'siliconflow' | 'custom';
        apiKey?: string;
        baseUrl?: string;
        model?: string;
    }

    const [allConfigs, setAllConfigs] = useState<EvalConfigItem[]>([]);
    const [activeConfigId, setActiveConfigId] = useState<string>('default');

    // Editing state in modal
    const [editingConfigId, setEditingConfigId] = useState<string | null>(null);
    const [tempConfig, setTempConfig] = useState<EvalConfigItem>({
        id: 'new', name: 'New Config', provider: 'deepseek', model: 'deepseek-chat'
    });


    // Save entire settings verify connection for the *currently edited* config if relevant
    const saveCurrentConfig = async () => {
        setIsSavingSettings(true);
        setSettingsStatus(null);
        try {
            // 1. Prepare new list
            let newConfigs = [...allConfigs];
            const configToSave = { ...tempConfig };

            // If new, generate ID
            if (configToSave.id === 'new') {
                configToSave.id = `config_${Date.now()}`;
                newConfigs.push(configToSave);
            } else {
                newConfigs = newConfigs.map(c => c.id === configToSave.id ? configToSave : c);
            }

            // 2. Test Connection
            const testPayload = {
                provider: configToSave.provider,
                apiKey: configToSave.apiKey,
                baseUrl: configToSave.baseUrl,
                model: configToSave.model
            };

            setSettingsStatus({ type: 'success', msg: 'Testing connection...' }); // reuse success style for info

            const testRes = await apiFetch('/api/eval/settings/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(testPayload)
            });
            const testData = await testRes.json();

            if (!testData.success) {
                setSettingsStatus({ type: 'error', msg: `Connection Test Failed: ${testData.error}` });
                setIsSavingSettings(false);
                return;
            }

            // 3. Save to server
            // Automatically activate if it's the first config or currently active is missing
            let newActiveId = activeConfigId;
            if (newConfigs.length === 1 || activeConfigId === 'default') {
                newActiveId = configToSave.id;
            }

            const payload = {
                activeConfigId: newActiveId,
                configs: newConfigs,
                autoEvaluationEnabled
            };
            const finalPayload = {
                settings: payload,
                user: user
            };

            const res = await apiFetch('/api/eval/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(finalPayload)
            });

            if (res.ok) {
                setAllConfigs(newConfigs);
                setActiveConfigId(newActiveId);
                setEditingConfigId(null);
                setSettingsStatus({ type: 'success', msg: 'Saved!' });
                setTimeout(() => setSettingsStatus(null), 1500);
            } else {
                const err = await res.json();
                setSettingsStatus({ type: 'error', msg: `Failed to save settings: ${err.error || res.statusText}` });
            }
        } catch (e: any) {
            setSettingsStatus({ type: 'error', msg: `Error: ${e.message}` });
        } finally {
            setIsSavingSettings(false);
        }
    };

    const isDefaultConfig = (configId: string) => configId.startsWith('default_');

    const activateConfig = async (id: string) => {
        const payload = { activeConfigId: id, configs: allConfigs, autoEvaluationEnabled };
        const finalPayload = { settings: payload, user };
        await apiFetch('/api/eval/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(finalPayload)
        });
        setActiveConfigId(id);
    };

    const deleteEvalConfig = async (id: string) => {
        if (!confirm('Are you sure?')) return;
        const newConfigs = allConfigs.filter(c => c.id !== id);
        let newActive = activeConfigId;
        if (id === activeConfigId) newActive = newConfigs[0]?.id || '';

        const payload = { activeConfigId: newActive, configs: newConfigs, autoEvaluationEnabled };
        const finalPayload = { settings: payload, user };
        await apiFetch('/api/eval/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(finalPayload)
        });
        setAllConfigs(newConfigs);
        setActiveConfigId(newActive);
    };

    useEffect(() => {
        fetchServerSettings();
    }, []);

    useEffect(() => {
        apiFetch('/api/eval/config/status?check_org=true')
            .then(res => res.json())
            .then(data => setIsOrgMode(data.org_mode || false))
            .catch(() => {});
    }, []);

    // When modal opens, if we have configs, show list. if empty, show edit new.
    useEffect(() => {
        if (showSettingsModal) {
            fetchServerSettings();
            setSettingsStatus(null);
            setEditingConfigId(null);
        }
    }, [showSettingsModal]);

    // Reset comment when record changes
    useEffect(() => {
        if (selectedRecord && selectedRecord.user_feedback) {
            setFeedbackComment(selectedRecord.user_feedback.comment || '');
        } else {
            setFeedbackComment('');
        }
    }, [selectedRecord]);

    // Table Filters & Pagination


    // Inline Editing
    const [tableFrameworks, setTableFrameworks] = useState<string[]>([]);
    const [tableLabels, setTableLabels] = useState<string[]>([]);
    const [tableQuery, setTableQuery] = useState<string>('');
    const [tableModels, setTableModels] = useState<string[]>([]);
    const [tablePage, setTablePage] = useState(1);
    const TABLE_PAGE_SIZE = 10;

    // Reset page when filters change
    useEffect(() => {
        setTablePage(1);
    }, [tableFrameworks, tableLabels, tableQuery, tableModels, timeFilter]);

    // Fetch Data
    const fetchData = async () => {
        setLoadingData(true);
        try {
            // Witty_public special case: if user is 'public', map to 'witty_public'
            // OR if user wants to see public data, maybe we should have a toggle?
            // The prompt says "why I cannot see my date when login as public".
            // Previously we migrated data to 'witty_public'.
            // So if user logs in as 'public', they are actually 'public' user, but data is in 'witty_public'.
            // Let's assume the user meant they logged in as 'public' but expected to see the 'witty_public' data.
            // Or maybe they logged in as 'witty_public'?
            // If they logged in as 'witty_public', filtering by 'witty_public' works.
            // If they logged in as 'public', filtering by 'public' returns nothing.
            // Let's aliasing 'public' -> 'witty_public' for view convenience if that was the intention.

            const queryUser = user;

            const url = queryUser ? `/api/observe/data?user=${encodeURIComponent(queryUser)}` : '/api/observe/data';
            const res = await apiFetch(url, { cache: 'no-store' });
            const d = await res.json();
            const cleanData = d
                .filter((x: any) => x.query && x.query.trim() !== '') // 4. Filter empty queries
                .map((x: any) => {
                    let rawLat = Number(x.latency || 0);
                    // Legacy frameworks (opencode, openhands, or old proxy 'claude') saved as Seconds.
                    // The new local parser correctly saves 'claudecode' as Milliseconds.
                    if ((x.framework === 'opencode' || x.framework === 'openhands' || x.framework === 'claude') && rawLat > 0 && rawLat < 1000) {
                        rawLat = rawLat * 1000;
                    }

                    return {
                        ...x,
                        tokens: Number(x.tokens || x.Token || 0),
                        latency: rawLat,
                        // 1. Rename framework
                        framework: (x.framework === 'claude' ? 'claudecode' : x.framework) || 'Unknown',
                        model: x.model || 'Unknown',
                        skill_score: x.skill_score !== undefined ? Number(x.skill_score) : undefined,
                        answer_score: x.answer_score === null ? null : (x.answer_score !== undefined ? Number(x.answer_score) : (x.is_answer_correct ? 1.0 : 0.0))
                    };
                });
            setRawData(cleanData);
        } catch (e) {
            console.error("Failed to fetch data", e);
        } finally {
            setLoadingData(false);
        }
    };

    const fetchConfig = () => {
        if (!user) return;
        apiFetch(`/api/eval/config?user=${encodeURIComponent(user)}`)
            .then(res => res.json())
            .then(d => {
                if (Array.isArray(d)) setConfigs(d);
                else console.error("Invalid config data received:", d);
            })
            .catch(e => console.error("Failed to fetch configs", e));
    };

    const fetchSkills = () => {
        if (!user) return;
        apiFetch(`/api/skills?user=${encodeURIComponent(user)}`)
            .then(res => res.json())
            .then(d => {
                if (Array.isArray(d)) setAvailableSkills(d);
                else console.error("Invalid skills data received:", d);
            })
            .catch(e => console.error("Failed to fetch skills", e));
    };

    const fetchServerSettings = useCallback(async () => {
        if (!user) return;
        try {
            const res = await apiFetch(`/api/eval/settings?user=${encodeURIComponent(user)}`);
            if (res.ok) {
                const data = await res.json();
                if (data.configs) {
                    setAllConfigs(data.configs);
                    setActiveConfigId(data.activeConfigId || data.configs[0]?.id || 'default');
                }
                if (typeof data.autoEvaluationEnabled === 'boolean') {
                    setAutoEvaluationEnabled(data.autoEvaluationEnabled);
                }
            }
        } catch (e) {
            console.error("Failed to fetch settings", e);
        }
    }, [user]);

    useEffect(() => {
        if (user) {
            fetchData();
            fetchSkills();
            fetchServerSettings();
        }
    }, [user, fetchServerSettings]);

    useEffect(() => {
        if (activeTab === 'config' && user) {
            fetchConfig();
        }
    }, [activeTab, user]);

    // --- Actions ---
    const handleDelete = async (record: Execution) => {
        if (!confirm(t('dashboard.detail.deleteConfirm'))) return;
        try {
            console.log('[Dashboard] Deleting record:', {
                upload_id: record.upload_id,
                task_id: record.task_id,
                id: record.upload_id || record.task_id
            });

            const res = await apiFetch(`/api/observe/data?user=${encodeURIComponent(user || '')}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(record)
            });
            if (res.ok) {
                const result = await res.json();
                console.log('[Dashboard] Delete result:', result);
                if (result.count > 0) {
                    fetchData();
                } else {
                    alert(t('dashboard.detail.deleteNotFound'));
                }
            } else {
                const error = await res.json();
                console.error('[Dashboard] Delete failed:', error);
                alert(t('dashboard.detail.deleteFailed') + ': ' + (error.error || ''));
            }
        } catch (e: any) {
            console.error('[Dashboard] Delete error:', e);
            alert(t('dashboard.detail.deleteError'));
        }
    };

    const submitFeedback = async (type: 'like' | 'dislike' | null, comment?: string) => {
        if (!selectedRecord) return;
        try {
            const newFeedback = { type, comment: comment !== undefined ? comment : feedbackComment };
            const updatedRecord = { ...selectedRecord, user_feedback: newFeedback };

            // Update UI optimistically
            setSelectedRecord(updatedRecord);
            setRawData(prev => prev.map(d =>
                (d.task_id === selectedRecord.task_id || d.upload_id === selectedRecord.upload_id) ? updatedRecord : d
            ));

            const res = await apiFetch('/api/observe/data', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    task_id: selectedRecord.task_id,
                    upload_id: selectedRecord.upload_id,
                    user_feedback: newFeedback
                })
            });

            if (!res.ok) {
                console.error('Feedback save failed');
            } else {
                alert(t('dashboard.feedback.feedbackSaved'));
            }
        } catch (e) {
            console.error('Feedback error', e);
        }
    };


    const handleRejudge = async (record: Execution) => {
        const id = record.task_id || record.upload_id || '';
        if (!id) return;

        const isEvaluating = record.is_evaluating || rejudgingIds.has(id);

        if (isEvaluating) {
            try {
                const res = await apiFetch('/api/evaluation/cancel', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ task_id: id, currentUser: user })
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data.cancelled) {
                        console.log('Evaluation cancelled for ID:', id);
                    }
                    fetchData();
                }
            } catch (e) {
                console.error('Cancel request error', e);
            }
            return;
        }

        if (!confirm(t('dashboard.detail.rejudgeConfirm'))) return;

        console.log('Rejudging ID:', id);
        setRejudgingIds(prev => {
            const next = new Set(prev);
            next.add(id);
            return next;
        });

        try {
            const res = await apiFetch('/api/eval/rejudge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...record, currentUser: user })
            });
            if (res.ok) {
                const data = await res.json();
                
                if (data.cancelled) {
                    console.log('Rejudge was cancelled');
                    fetchData();
                    return;
                }

                const reason = data.record?.judgment_reason || '';
                const noMatch = reason.includes('未找到匹配的评测配置');
                if (noMatch) {
                    alert(t('dashboard.detail.rejudgeNoConfig'));
                } else {
                    alert(t('dashboard.detail.rejudgeComplete', { score: data.record.answer_score?.toFixed(2) || '0.00' }));
                }

                const updatedRecord = {
                    ...data.record,
                    tokens: Number(data.record.tokens || data.record.Token || 0),
                    latency: Number(data.record.latency || 0),
                    framework: data.record.framework || 'Unknown',
                    skill_score: data.record.skill_score !== undefined ? Number(data.record.skill_score) : undefined,
                    answer_score: data.record.answer_score !== null ? Number(data.record.answer_score) : (data.record.is_answer_correct ? 1.0 : 0.0)
                };

                setRawData(prev => prev.map(r =>
                    (r.upload_id === record.upload_id || r.task_id === record.task_id) ? updatedRecord : r
                ));

                if (selectedRecord && (selectedRecord.task_id === record.task_id || selectedRecord.upload_id === record.upload_id)) {
                    setSelectedRecord(updatedRecord);
                }

                fetchData();
            } else {
                let errorMsg = '重评失败';
                try {
                    const errData = await res.json();
                    if (errData && errData.error) errorMsg += `: ${errData.error}`;
                } catch (e) { }
                alert(errorMsg);
            }
        } catch (e) {
            alert(t('dashboard.detail.rejudgeError'));
        } finally {
            setRejudgingIds(prev => {
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
        }
    };

    const handleUpdateLabel = async (record: Execution, newLabel: string) => {
        try {
            const payload = {
                task_id: record.task_id,
                upload_id: record.upload_id,
                label: newLabel
            };

            const res = await apiFetch('/api/observe/data', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                setEditingLabelId(null);
                fetchData();
            } else {
                alert(t('dashboard.detail.updateLabelFailed'));
            }
        } catch (e) {
            alert(t('dashboard.detail.updateLabelError'));
        }
    };

    const [editingConfig, setEditingConfig] = useState<Partial<ConfigItem> & { version?: number }>({});
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [configModalPerspective, setConfigModalPerspective] = useState<'routing' | 'outcome' | 'combined' | null>(null);
    const [activeOutcomeGroupConfigs, setActiveOutcomeGroupConfigs] = useState<ConfigItem[]>([]);
    const [activeOutcomeScenarioId, setActiveOutcomeScenarioId] = useState<string | null>(null);
    const [isSavingConfig, setIsSavingConfig] = useState(false);
    const [configAnswerMode, setConfigAnswerMode] = useState<'manual' | 'document'>('manual');
    const [configDocumentFile, setConfigDocumentFile] = useState<File | null>(null);
    const [showAddMenu, setShowAddMenu] = useState(false);
    const pollingTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

    // Cleanup polling timers on unmount
    useEffect(() => {
        return () => {
            pollingTimersRef.current.forEach(timer => clearTimeout(timer));
        };
    }, []);

    const closeConfigModal = () => {
        setIsEditModalOpen(false);
        setConfigModalPerspective(null);
        setActiveOutcomeGroupConfigs([]);
        setActiveOutcomeScenarioId(null);
        setConfigDocumentFile(null);
        setConfigAnswerMode('manual');
        setEditingConfig({});
        setIsSavingConfig(false);
    };

    // Poll for parsing status of config items
    const pollConfigStatus = useCallback((configId: string) => {
        const poll = async () => {
            try {
                const res = await apiFetch(`/api/eval/config/status?id=${configId}`);
                if (!res.ok) return;
                const data = await res.json();

                if (data.parse_status === 'completed' || data.parse_status === 'failed') {
                    // Update the config in state (including standard_answer which may have been extracted from document)
                    setConfigs(prev => prev.map(c => c.id === configId ? {
                        ...c,
                        routing_intent: data.routing_intent || c.routing_intent,
                        routing_anchors: data.routing_anchors || c.routing_anchors,
                        standard_answer: data.standard_answer || c.standard_answer,
                        root_causes: data.root_causes,
                        key_actions: data.key_actions,
                        extractedKeyActions: data.extractedKeyActions,
                        parse_status: data.parse_status
                    } : c));
                    // Stop polling
                    const timer = pollingTimersRef.current.get(configId);
                    if (timer) clearTimeout(timer);
                    pollingTimersRef.current.delete(configId);
                } else {
                    // Continue polling
                    const timer = setTimeout(poll, 2000);
                    pollingTimersRef.current.set(configId, timer);
                }
            } catch (e) {
                console.error('Config status poll error:', e);
                const timer = setTimeout(poll, 5000);
                pollingTimersRef.current.set(configId, timer);
            }
        };
        // Start first poll after 2s
        const timer = setTimeout(poll, 2000);
        pollingTimersRef.current.set(configId, timer);
    }, []);

    // Start polling for any configs in 'parsing' state on load
    useEffect(() => {
        configs.forEach(c => {
            if (c.parse_status === 'parsing' && !pollingTimersRef.current.has(c.id)) {
                pollConfigStatus(c.id);
            }
        });
    }, [configs, pollConfigStatus]);

    const openCreateConfigModal = (datasetType: 'routing' | 'outcome') => {
        setActiveOutcomeGroupConfigs([]);
        setActiveOutcomeScenarioId(null);
        setConfigModalPerspective(datasetType);
        setEditingConfig({
            dataset_type: datasetType,
            query: datasetType === 'routing' ? '' : null,
            skill: '',
            skillVersion: null,
            expectedSkills: datasetType === 'routing' ? [{ skill: '', version: null }] : [],
            standard_answer: '',
            root_causes: [],
            key_actions: [],
        });
        setConfigAnswerMode('manual');
        setConfigDocumentFile(null);
        setIsEditModalOpen(true);
    };

    const openConfigModal = (config: ConfigItem, sectionType?: 'routing' | 'outcome') => {
        const configToEdit = {
            ...config,
            dataset_type: normalizeConfigDatasetType(config.dataset_type),
        };
        if (!configToEdit.expectedSkills && configToEdit.skill) {
            configToEdit.expectedSkills = [{ skill: configToEdit.skill, version: configToEdit.skillVersion ?? null }];
        }
        setActiveOutcomeGroupConfigs([]);
        setActiveOutcomeScenarioId(config.id);
        setConfigModalPerspective(sectionType || normalizeConfigDatasetType(config.dataset_type));
        setEditingConfig(configToEdit);
        setConfigAnswerMode('manual');
        setConfigDocumentFile(null);
        setIsEditModalOpen(true);
    };

    const openOutcomeGroupModal = (group: OutcomeConfigGroup, scenarioId?: string | null) => {
        const sortedConfigs = sortOutcomeScenarioConfigs(group.configs);
        const initialConfig = sortedConfigs.find(config => config.id === scenarioId) || sortedConfigs[0];
        if (!initialConfig) return;

        const configToEdit = {
            ...initialConfig,
            dataset_type: normalizeConfigDatasetType(initialConfig.dataset_type),
        };

        setActiveOutcomeGroupConfigs(sortedConfigs);
        setActiveOutcomeScenarioId(initialConfig.id);
        setConfigModalPerspective('outcome');
        setEditingConfig(configToEdit);
        setConfigAnswerMode('manual');
        setConfigDocumentFile(null);
        setIsEditModalOpen(true);
    };

    const openCreateOutcomeScenarioModal = (group: OutcomeConfigGroup) => {
        setActiveOutcomeGroupConfigs(sortOutcomeScenarioConfigs(group.configs));
        setActiveOutcomeScenarioId(null);
        setConfigModalPerspective('outcome');
        setEditingConfig({
            dataset_type: 'outcome',
            query: '',
            skill: group.skill,
            skillVersion: group.skillVersion,
            standard_answer: '',
            root_causes: [],
            key_actions: [...group.sharedKeyActions],
        });
        setConfigAnswerMode('manual');
        setConfigDocumentFile(null);
        setIsEditModalOpen(true);
    };

    const switchOutcomeScenario = (configId: string) => {
        const nextConfig = currentOutcomeGroupConfigs.find(config => config.id === configId);
        if (!nextConfig) return;

        setActiveOutcomeScenarioId(configId);
        setEditingConfig({
            ...nextConfig,
            dataset_type: normalizeConfigDatasetType(nextConfig.dataset_type),
        });
        setConfigAnswerMode('manual');
        setConfigDocumentFile(null);
    };

    const deleteOutcomeGroup = async (group: OutcomeConfigGroup) => {
        const targetLabel = formatSkillTargetLabel(group.skill, group.skillVersion);
        if (!confirm(`确定删除 ${targetLabel} 的整套执行效果评测集吗？这会删除该 Skill / 版本下的全部业务场景。`)) {
            return;
        }

        const groupIds = new Set(group.configs.map(config => config.id));
        const newConfigs = configs.filter(config => !groupIds.has(config.id));
        const res = await apiFetch('/api/eval/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ configs: newConfigs, user })
        });
        if (res.ok) {
            setConfigs(newConfigs);
            if (currentOutcomeGroup?.key === group.key) {
                closeConfigModal();
            }
        }
    };

    const duplicateConfigToDataset = (config: ConfigItem, datasetType: 'routing' | 'outcome') => {
        setActiveOutcomeGroupConfigs([]);
        setActiveOutcomeScenarioId(null);
        setConfigModalPerspective(datasetType);
        const duplicatedSkill = normalizeConfigSkillName(config.skill)
            || normalizeConfigSkillName(config.expectedSkills?.[0]?.skill)
            || '';
        const duplicatedVersion = config.skillVersion
            ?? config.expectedSkills?.[0]?.version
            ?? null;

        setEditingConfig({
            dataset_type: datasetType,
            query: datasetType === 'routing' ? (config.query ?? '') : null,
            skill: datasetType === 'outcome' ? duplicatedSkill : '',
            skillVersion: datasetType === 'outcome' ? duplicatedVersion : null,
            expectedSkills: datasetType === 'routing'
                ? (config.expectedSkills ? [...config.expectedSkills] : (config.skill ? [{ skill: config.skill, version: config.skillVersion ?? null }] : []))
                : [],
            standard_answer: datasetType === 'outcome' ? config.standard_answer : '',
            routing_intent: datasetType === 'routing' ? config.routing_intent : null,
            routing_anchors: datasetType === 'routing' ? [...(config.routing_anchors || [])] : [],
            root_causes: datasetType === 'outcome' ? [...(config.root_causes || [])] : [],
            key_actions: datasetType === 'outcome' ? [...(config.key_actions || [])] : [],
        });
        setConfigAnswerMode('manual');
        setConfigDocumentFile(null);
        setIsEditModalOpen(true);
    };

    const routingConfigs = useMemo(
        () => configs.filter(config => configSupportsDatasetType(config.dataset_type, 'routing')),
        [configs]
    );

    const outcomeConfigs = useMemo(
        () => configs.filter(config => configSupportsDatasetType(config.dataset_type, 'outcome')),
        [configs]
    );

    const outcomeConfigGroups = useMemo(() => {
        const groups = new Map<string, ConfigItem[]>();

        for (const config of outcomeConfigs) {
            const key = getOutcomeGroupKey(config.skill, config.skillVersion);
            const existing = groups.get(key) || [];
            existing.push(config);
            groups.set(key, existing);
        }

        return Array.from(groups.values())
            .map(buildOutcomeConfigGroup)
            .filter((group): group is OutcomeConfigGroup => Boolean(group))
            .sort((a, b) => {
                const labelA = formatSkillTargetLabel(a.skill, a.skillVersion) || '';
                const labelB = formatSkillTargetLabel(b.skill, b.skillVersion) || '';
                const skillCompare = labelA.localeCompare(
                    labelB,
                    'zh-CN'
                );
                if (skillCompare !== 0) return skillCompare;
                const versionA = a.skillVersion ?? -1;
                const versionB = b.skillVersion ?? -1;
                return versionA - versionB;
            });
    }, [outcomeConfigs]);

    const editingConfigType = normalizeConfigDatasetType(editingConfig.dataset_type);
    const modalEditingType = configModalPerspective || editingConfigType;
    const isRoutingEditor = modalEditingType === 'routing' || modalEditingType === 'combined';
    const isOutcomeEditor = modalEditingType === 'outcome' || modalEditingType === 'combined';
    const currentOutcomeGroupConfigs = useMemo(() => {
        if (!isOutcomeEditor) return [];
        if (activeOutcomeGroupConfigs.length > 0) {
            return sortOutcomeScenarioConfigs(activeOutcomeGroupConfigs);
        }

        const skill = normalizeConfigSkillName(editingConfig.skill);
        if (!skill) return [];

        const version = normalizeOptionalSkillVersion(editingConfig.skillVersion);
        return sortOutcomeScenarioConfigs(
            outcomeConfigs.filter(config =>
                normalizeConfigSkillName(config.skill) === skill &&
                normalizeOptionalSkillVersion(config.skillVersion) === version
            )
        );
    }, [isOutcomeEditor, activeOutcomeGroupConfigs, editingConfig.skill, editingConfig.skillVersion, outcomeConfigs]);
    const currentOutcomeGroup = useMemo(
        () => buildOutcomeConfigGroup(currentOutcomeGroupConfigs),
        [currentOutcomeGroupConfigs]
    );
    const configModalTitle = editingConfig.id
        ? (modalEditingType === 'routing'
            ? 'Skill 召回率数据项详情'
            : modalEditingType === 'outcome'
                ? (currentOutcomeGroupConfigs.length > 1 ? 'Skill 执行效果评测集详情' : 'Skill 执行效果数据项详情')
                : '兼容旧数据详情')
        : (modalEditingType === 'routing'
            ? '新增 Skill 召回率数据项'
            : modalEditingType === 'outcome'
                ? (currentOutcomeGroupConfigs.length > 0 ? '新增 Skill 执行效果场景' : '新增 Skill 执行效果数据项')
                : '新增数据项');

    type ControlFlowType = 'required' | 'conditional' | 'loop' | 'optional' | 'handoff';

    const handleAddAction = (type: ControlFlowType) => {
        const newActions: any[] = [...(editingConfig.key_actions || [])];
        
        switch (type) {
            case 'required':
                newActions.push({
                    id: `action-${Date.now()}`,
                    content: '',
                    weight: 1,
                    controlFlowType: 'required'
                });
                break;
                
            case 'conditional':
                const groupId = `cg-manual-${Date.now()}`;
                newActions.push({
                    id: `action-${Date.now()}`,
                    content: '',
                    weight: 1,
                    controlFlowType: 'conditional',
                    groupId: groupId,
                    condition: '条件描述',
                    branchLabel: '分支A'
                });
                break;
                
            case 'loop':
                const loopGroupId = `lg-manual-${Date.now()}`;
                newActions.push({
                    id: `action-${Date.now()}`,
                    content: '',
                    weight: 1,
                    controlFlowType: 'loop',
                    groupId: loopGroupId,
                    loopCondition: '循环条件',
                    expectedMinCount: 1,
                    expectedMaxCount: 10
                });
                break;
                
            case 'optional':
                newActions.push({
                    id: `action-${Date.now()}`,
                    content: '',
                    weight: 0,
                    controlFlowType: 'optional'
                });
                break;
                
            case 'handoff':
                newActions.push({
                    id: `action-${Date.now()}`,
                    content: '衔接描述',
                    weight: 1,
                    controlFlowType: 'handoff'
                });
                break;
        }
        
        setEditingConfig({ ...editingConfig, key_actions: newActions });
        setShowAddMenu(false);
    };

    const handleAddToGroup = (groupId: string, cfType: ControlFlowType) => {
        const newActions = [...(editingConfig.key_actions || [])];
        
        let lastGroupIndex = -1;
        for (let i = newActions.length - 1; i >= 0; i--) {
            if ((newActions[i] as any).groupId === groupId) {
                lastGroupIndex = i;
                break;
            }
        }
        
        const newAction: any = {
            id: `action-${Date.now()}`,
            content: '',
            weight: 1,
            controlFlowType: cfType,
            groupId: groupId
        };
        
        if (cfType === 'conditional' && lastGroupIndex >= 0) {
            const lastAction = newActions[lastGroupIndex] as any;
            newAction.condition = lastAction.condition;
            newAction.branchLabel = lastAction.branchLabel;
        }
        
        if (cfType === 'loop' && lastGroupIndex >= 0) {
            const lastAction = newActions[lastGroupIndex] as any;
            newAction.loopCondition = lastAction.loopCondition;
            newAction.expectedMinCount = lastAction.expectedMinCount;
            newAction.expectedMaxCount = lastAction.expectedMaxCount;
        }
        
        if (lastGroupIndex >= 0) {
            newActions.splice(lastGroupIndex + 1, 0, newAction);
        } else {
            newActions.push(newAction);
        }
        
        setEditingConfig({ ...editingConfig, key_actions: newActions });
    };

    const saveConfig = async () => {
        const editingDatasetType = normalizeConfigDatasetType(editingConfig.dataset_type);
        const trimmedQuery = normalizeConfigQuery(editingConfig.query);
        const trimmedSkill = normalizeConfigSkillName(editingConfig.skill);
        const normalizedSkillVersion = normalizeOptionalSkillVersion(editingConfig.skillVersion);

        if (!editingConfig.id) {
            if ((editingDatasetType === 'routing' || editingDatasetType === 'combined') && !trimmedQuery) {
                return alert('问题 (Query) 不能为空');
            }
            if ((editingDatasetType === 'outcome' || editingDatasetType === 'combined') && !trimmedSkill) {
                return alert('请绑定目标 skill');
            }

            const isDuplicate = configs.some(c => {
                if (normalizeConfigDatasetType(c.dataset_type) !== editingDatasetType) {
                    return false;
                }

                if (editingDatasetType === 'routing' || editingDatasetType === 'combined') {
                    return normalizeConfigQuery(c.query) === trimmedQuery;
                }

                return normalizeConfigSkillName(c.skill) === trimmedSkill
                    && normalizeOptionalSkillVersion(c.skillVersion) === normalizedSkillVersion
                    && normalizeConfigQuery(c.query) === trimmedQuery;
            });
            if (isDuplicate) {
                return alert(editingDatasetType === 'routing'
                    ? '该问题已存在于当前数据集类型中，请修改后再保存'
                    : trimmedQuery
                        ? '该目标 skill 的当前业务场景已存在于效果数据集中，请修改后再保存'
                        : '该目标 skill 的通用效果数据已存在于当前效果数据集中，请修改后再保存');
            }
        }
        editingConfig.query = trimmedQuery;

        editingConfig.skill = trimmedSkill;
        editingConfig.skillVersion = normalizedSkillVersion;

        setIsSavingConfig(true);

        try {
            if (!editingConfig.id) {
                if ((editingDatasetType === 'routing' || editingDatasetType === 'combined') && !hasRoutingExpectations(editingConfig)) {
                    setIsSavingConfig(false);
                    return alert('请至少填写一个预期技能');
                }

                if (editingDatasetType === 'outcome' || editingDatasetType === 'combined') {
                    if (configAnswerMode === 'manual' && !editingConfig.standard_answer?.trim()) {
                        setIsSavingConfig(false);
                        return alert('请填写标准答案');
                    }
                    if (configAnswerMode === 'document' && !configDocumentFile) {
                        setIsSavingConfig(false);
                        return alert('请上传案例文档');
                    }
                }

                let res: Response;
                if ((editingDatasetType === 'outcome' || editingDatasetType === 'combined') && configAnswerMode === 'document' && configDocumentFile) {
                    const formData = new FormData();
                    if (trimmedQuery) formData.append('query', trimmedQuery);
                    if (trimmedSkill) formData.append('skill', trimmedSkill);
                    if (normalizedSkillVersion != null) formData.append('skillVersion', String(normalizedSkillVersion));
                    formData.append('document', configDocumentFile);
                    formData.append('datasetType', editingDatasetType);
                    if (user) formData.append('user', user);
                    if (editingConfig.expectedSkills) {
                        formData.append('expectedSkills', JSON.stringify(editingConfig.expectedSkills));
                    }
                    res = await apiFetch('/api/eval/config/create', { method: 'POST', body: formData });
                } else {
                    res = await apiFetch('/api/eval/config/create', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            query: trimmedQuery,
                            standardAnswer: editingConfig.standard_answer,
                            datasetType: editingDatasetType,
                            skill: trimmedSkill,
                            skillVersion: normalizedSkillVersion,
                            expectedSkills: editingConfig.expectedSkills,
                            user
                        })
                    });
                }

                if (res.ok) {
                    const newConfig = await res.json();
                    if (newConfig && newConfig.id) {
                        setConfigs(prev => [newConfig, ...prev]);
                        // Start polling for parsing status
                        if (newConfig.parse_status === 'parsing') {
                            pollConfigStatus(newConfig.id);
                        }
                    }
                    closeConfigModal();
                } else {
                    const err = await res.json();
                    alert(`${t('config.saveFailed')}: ${err.error || 'Unknown error'}`);
                }
            } else {
                    let newConfigs = [...configs];
                    newConfigs = newConfigs.map(c => c.id === editingConfig.id ? { ...c, ...editingConfig } as ConfigItem : c);

                    const res = await apiFetch('/api/eval/config', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ configs: newConfigs, user })
                    });
                    if (res.ok) {
                        setConfigs(newConfigs);
                        closeConfigModal();
                    } else {
                        alert(t('config.saveFailed'));
                    }
                }
            } catch (e: any) {
                console.error(e);
                alert(t('config.saveError') + ': ' + e.message);
            } finally {
            setIsSavingConfig(false);
        }
    };


    const deleteConfig = async (id: string) => {
        if (!confirm(t('config.deleteConfirm'))) return;
        const newConfigs = configs.filter(c => c.id !== id);
        const res = await apiFetch('/api/eval/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ configs: newConfigs, user }) // Include user in the body
        });
        if (res.ok) setConfigs(newConfigs);
    };

    const renderConfigSection = (
        sectionType: 'routing' | 'outcome',
        title: string,
        description: string,
        items: ConfigItem[],
        accent: string,
        actionLabel: string,
        emptyText: string
    ) => (
        <div
            className="card"
            style={{
                padding: '18px',
                border: `1px solid ${accent}33`,
                boxShadow: `inset 0 1px 0 ${accent}14`,
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
            }}
        >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' }}>
                <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
                        <h3 style={{ margin: 0, color: '#e2e8f0', fontSize: '1.05rem' }}>{title}</h3>
                        <span
                            style={{
                                padding: '2px 8px',
                                borderRadius: '999px',
                                background: `${accent}22`,
                                border: `1px solid ${accent}44`,
                                color: accent,
                                fontSize: '0.75rem',
                                fontWeight: 600,
                            }}
                        >
                            {items.length} 项
                        </span>
                    </div>
                    <p style={{ margin: 0, color: '#94a3b8', fontSize: '0.85rem', lineHeight: 1.6 }}>{description}</p>
                </div>
                <button
                    onClick={() => openCreateConfigModal(sectionType)}
                    className="btn-primary"
                    style={{ padding: '8px 16px', fontSize: '0.85rem', borderRadius: '8px', whiteSpace: 'nowrap' }}
                >
                    {actionLabel}
                </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {items.length === 0 && (
                    <div
                        style={{
                            border: '1px dashed #334155',
                            borderRadius: '12px',
                            padding: '2rem 1rem',
                            textAlign: 'center',
                            color: '#64748b',
                            background: 'rgba(15, 23, 42, 0.35)',
                        }}
                    >
                        {emptyText}
                    </div>
                )}

                {items.map(c => {
                    const datasetType = normalizeConfigDatasetType(c.dataset_type);
                    const titleText = getConfigDisplayTitle(c, sectionType);
                    const outcomeTargetMeta = getOutcomeTargetMeta(c);
                    const routingSourceQuery = getRoutingSourceQueryMeta(c);
                    const statusColor = c.parse_status === 'parsing'
                        ? '#fbbf24'
                        : c.parse_status === 'failed'
                            ? '#ef4444'
                            : '#4ade80';
                    const badgeText = datasetType === 'combined'
                        ? '兼容旧数据'
                        : datasetType === 'routing'
                            ? '仅用于 Skill 召回率'
                            : '仅用于 Skill 执行效果';
                    const normalizedExpectedSkills = normalizeExpectedSkills(c.expectedSkills);
                    const summaryText = sectionType === 'routing'
                        ? (
                            hasRoutingExpectations(c)
                                ? `预期 Skill：${(normalizedExpectedSkills.length > 0
                                    ? normalizedExpectedSkills
                                    : (c.skill ? [{ skill: c.skill, version: c.skillVersion ?? null }] : [])
                                ).map(item => `${item.skill}${item.version !== null && item.version !== undefined ? ` (v${item.version})` : ''}`).join(', ')}`
                                : '未配置预期 Skill'
                        )
                        : (
                            hasOutcomeExpectations(c)
                                ? ((c.standard_answer || '').length > 120
                                    ? `${(c.standard_answer || '').slice(0, 120)}...`
                                    : (c.standard_answer || '已配置关键观点/关键动作'))
                                : '未配置标准答案或关键动作'
                        );

                    return (
                        <div
                            key={`${sectionType}-${c.id}`}
                            style={{
                                border: '1px solid #1e293b',
                                borderRadius: '12px',
                                padding: '14px 16px',
                                background: 'rgba(15, 23, 42, 0.55)',
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: '14px',
                            }}
                        >
                            <div
                                style={{
                                    flexShrink: 0,
                                    width: '10px',
                                    height: '10px',
                                    borderRadius: '50%',
                                    marginTop: '6px',
                                    background: statusColor,
                                    boxShadow: `0 0 10px ${statusColor}55`,
                                }}
                            />
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '6px' }}>
                                    <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.95rem', lineHeight: 1.5 }}>{titleText}</div>
                                    <span
                                        style={{
                                            padding: '2px 8px',
                                            borderRadius: '999px',
                                            background: datasetType === 'combined' ? 'rgba(148, 163, 184, 0.16)' : `${accent}22`,
                                            border: `1px solid ${datasetType === 'combined' ? 'rgba(148, 163, 184, 0.28)' : `${accent}44`}`,
                                            color: datasetType === 'combined' ? '#cbd5e1' : accent,
                                            fontSize: '0.72rem',
                                            fontWeight: 600,
                                        }}
                                    >
                                        {badgeText}
                                    </span>
                                </div>
                                <div style={{ color: '#94a3b8', fontSize: '0.83rem', lineHeight: 1.6 }}>
                                    {summaryText}
                                </div>
                                {sectionType === 'routing' && routingSourceQuery && (
                                    <div style={{ color: '#64748b', fontSize: '0.78rem', lineHeight: 1.5, marginTop: '6px' }}>
                                        来源问题：{routingSourceQuery}
                                    </div>
                                )}
                                {sectionType === 'routing' && c.routing_anchors && c.routing_anchors.length > 0 && (
                                    <div style={{ color: '#64748b', fontSize: '0.78rem', lineHeight: 1.5, marginTop: '6px' }}>
                                        语义锚点：{c.routing_anchors.join(', ')}
                                    </div>
                                )}
                                {sectionType === 'outcome' && outcomeTargetMeta && (
                                    <div style={{ color: '#64748b', fontSize: '0.78rem', lineHeight: 1.5, marginTop: '6px' }}>
                                        业务场景：{outcomeTargetMeta}
                                    </div>
                                )}
                            </div>
                            <div style={{ display: 'flex', gap: '6px', flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                <button
                                    onClick={() => openConfigModal(c, sectionType)}
                                    style={{
                                        padding: '5px 12px',
                                        background: '#1e3a5f',
                                        color: '#38bdf8',
                                        border: 'none',
                                        borderRadius: '6px',
                                        cursor: 'pointer',
                                        fontSize: '0.8rem',
                                        fontWeight: 500,
                                    }}
                                >
                                    详情
                                </button>
                                <button
                                    onClick={() => duplicateConfigToDataset(c, sectionType)}
                                    style={{
                                        padding: '5px 12px',
                                        background: '#2d1b4e',
                                        color: '#c084fc',
                                        border: 'none',
                                        borderRadius: '6px',
                                        cursor: 'pointer',
                                        fontSize: '0.8rem',
                                        fontWeight: 500,
                                    }}
                                >
                                    复制到本区
                                </button>
                                <button
                                    onClick={() => deleteConfig(c.id)}
                                    style={{
                                        padding: '5px 12px',
                                        background: '#3b1c1c',
                                        color: '#ef4444',
                                        border: 'none',
                                        borderRadius: '6px',
                                        cursor: 'pointer',
                                        fontSize: '0.8rem',
                                        fontWeight: 500,
                                    }}
                                >
                                    删除
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );

    const renderOutcomeConfigGroupSection = (
        title: string,
        description: string,
        groups: OutcomeConfigGroup[],
        accent: string,
        actionLabel: string,
        emptyText: string
    ) => (
        <div
            className="card"
            style={{
                padding: '18px',
                border: `1px solid ${accent}33`,
                boxShadow: `inset 0 1px 0 ${accent}14`,
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
            }}
        >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' }}>
                <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
                        <h3 style={{ margin: 0, color: '#e2e8f0', fontSize: '1.05rem' }}>{title}</h3>
                        <span
                            style={{
                                padding: '2px 8px',
                                borderRadius: '999px',
                                background: `${accent}22`,
                                border: `1px solid ${accent}44`,
                                color: accent,
                                fontSize: '0.75rem',
                                fontWeight: 600,
                            }}
                        >
                            {groups.length} 套
                        </span>
                    </div>
                    <p style={{ margin: 0, color: '#94a3b8', fontSize: '0.85rem', lineHeight: 1.6 }}>{description}</p>
                </div>
                <button
                    onClick={() => openCreateConfigModal('outcome')}
                    className="btn-primary"
                    style={{ padding: '8px 16px', fontSize: '0.85rem', borderRadius: '8px', whiteSpace: 'nowrap' }}
                >
                    {actionLabel}
                </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {groups.length === 0 && (
                    <div
                        style={{
                            border: '1px dashed #334155',
                            borderRadius: '12px',
                            padding: '2rem 1rem',
                            textAlign: 'center',
                            color: '#64748b',
                            background: 'rgba(15, 23, 42, 0.35)',
                        }}
                    >
                        {emptyText}
                    </div>
                )}

                {groups.map(group => {
                    const titleText = formatSkillTargetLabel(group.skill, group.skillVersion) || '未绑定 Skill 执行效果评测集';
                    const scenarioCount = group.configs.length;
                    const scenarioPreview = group.configs.slice(0, 3).map(getOutcomeScenarioLabel);
                    const hiddenScenarioCount = Math.max(0, scenarioCount - scenarioPreview.length);
                    const statusColor = group.configs.some(config => config.parse_status === 'parsing')
                        ? '#fbbf24'
                        : group.configs.some(config => config.parse_status === 'failed')
                            ? '#ef4444'
                            : '#4ade80';
                    const usesLegacyDataset = group.datasetTypes.includes('combined');

                    return (
                        <div
                            key={group.key}
                            style={{
                                border: '1px solid #1e293b',
                                borderRadius: '12px',
                                padding: '14px 16px',
                                background: 'rgba(15, 23, 42, 0.55)',
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: '14px',
                            }}
                        >
                            <div
                                style={{
                                    flexShrink: 0,
                                    width: '10px',
                                    height: '10px',
                                    borderRadius: '50%',
                                    marginTop: '6px',
                                    background: statusColor,
                                    boxShadow: `0 0 10px ${statusColor}55`,
                                }}
                            />
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '6px' }}>
                                    <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.95rem', lineHeight: 1.5 }}>{titleText}</div>
                                    <span
                                        style={{
                                            padding: '2px 8px',
                                            borderRadius: '999px',
                                            background: `${accent}22`,
                                            border: `1px solid ${accent}44`,
                                            color: accent,
                                            fontSize: '0.72rem',
                                            fontWeight: 600,
                                        }}
                                    >
                                        {scenarioCount} 个业务场景
                                    </span>
                                    {usesLegacyDataset && (
                                        <span
                                            style={{
                                                padding: '2px 8px',
                                                borderRadius: '999px',
                                                background: 'rgba(148, 163, 184, 0.16)',
                                                border: '1px solid rgba(148, 163, 184, 0.28)',
                                                color: '#cbd5e1',
                                                fontSize: '0.72rem',
                                                fontWeight: 600,
                                            }}
                                        >
                                            含兼容旧数据
                                        </span>
                                    )}
                                </div>
                                <div style={{ color: '#94a3b8', fontSize: '0.83rem', lineHeight: 1.6 }}>
                                    共享关键动作：{group.sharedKeyActions.length} 项 · {group.sharedKeyActionSource === 'flow' ? '来自 Skill 流程自动抽取' : '来自共享关键动作配置'} · {group.hasGenericScenario ? '包含通用基准' : '暂无通用基准'}
                                </div>
                                {group.sharedControlFlowSummary.length > 0 && (
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }}>
                                        {group.sharedControlFlowSummary.map(item => (
                                            <span
                                                key={`${group.key}-${item.key}`}
                                                style={{
                                                    padding: '2px 8px',
                                                    borderRadius: '999px',
                                                    background: `${item.color}20`,
                                                    border: `1px solid ${item.color}33`,
                                                    color: item.color,
                                                    fontSize: '0.72rem',
                                                    fontWeight: 600,
                                                }}
                                            >
                                                {item.label} {item.count}
                                            </span>
                                        ))}
                                    </div>
                                )}
                                {scenarioPreview.length > 0 && (
                                    <div style={{ color: '#64748b', fontSize: '0.78rem', lineHeight: 1.5, marginTop: '6px' }}>
                                        业务场景：{scenarioPreview.join('、')}{hiddenScenarioCount > 0 ? ` 等 ${scenarioCount} 个场景` : ''}
                                    </div>
                                )}
                            </div>
                            <div style={{ display: 'flex', gap: '6px', flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                <button
                                    onClick={() => openOutcomeGroupModal(group)}
                                    style={{
                                        padding: '5px 12px',
                                        background: '#1e3a5f',
                                        color: '#38bdf8',
                                        border: 'none',
                                        borderRadius: '6px',
                                        cursor: 'pointer',
                                        fontSize: '0.8rem',
                                        fontWeight: 500,
                                    }}
                                >
                                    详情
                                </button>
                                <button
                                    onClick={() => openCreateOutcomeScenarioModal(group)}
                                    style={{
                                        padding: '5px 12px',
                                        background: '#2d1b4e',
                                        color: '#c084fc',
                                        border: 'none',
                                        borderRadius: '6px',
                                        cursor: 'pointer',
                                        fontSize: '0.8rem',
                                        fontWeight: 500,
                                    }}
                                >
                                    新增场景
                                </button>
                                <button
                                    onClick={() => deleteOutcomeGroup(group)}
                                    style={{
                                        padding: '5px 12px',
                                        background: '#3b1c1c',
                                        color: '#ef4444',
                                        border: 'none',
                                        borderRadius: '6px',
                                        cursor: 'pointer',
                                        fontSize: '0.8rem',
                                        fontWeight: 500,
                                    }}
                                >
                                    删除整套
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );

    const reparseConfig = async (id: string) => {
        try {
            const res = await apiFetch('/api/eval/config/reparse', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, user })
            });

            if (res.ok) {
                setConfigs(prev => prev.map(c => 
                    c.id === id ? { ...c, parse_status: 'parsing' } : c
                ));
                pollConfigStatus(id);
            } else {
                const err = await res.json();
                alert(t('config.reparseFailed') + `: ${err.error || 'Unknown error'}`);
            }
        } catch (e: any) {
            console.error('Reparse error:', e);
            alert(t('config.reparseError') + ': ' + e.message);
        }
    };

    const allFrameworks = useMemo(() => Array.from(new Set(rawData.map(d => d.framework))).sort(), [rawData]);

    const allQueries = useMemo(() => Array.from(new Set(rawData.map(d => d.query))).sort(), [rawData]);

    // Dynamic Labels for Dropdown
    // Should depend on the Comparison Mode Dataset
    const filteredData = useMemo(() => {
        if (timeFilter === 'all') return rawData;
        const now = Date.now();
        const map = {
            '1h': 60 * 60 * 1000,
            '3h': 3 * 60 * 60 * 1000,
            '24h': 24 * 60 * 60 * 1000,
        };
        const threshold = now - (map[timeFilter as keyof typeof map] || 0);
        return rawData.filter(d => new Date(d.timestamp).getTime() > threshold);
    }, [rawData, timeFilter]);

    const allLabels = useMemo(() => {
        const labels = new Set<string>();
        filteredData.forEach(d => {
            if (d.label) labels.add(d.label);
        });
        return Array.from(labels).sort();
    }, [filteredData]);

    const allModels = useMemo(() => {
        const models = new Set<string>();
        filteredData.forEach(d => {
            if (d.model) models.add(d.model);
        });
        return Array.from(models).sort();
    }, [filteredData]);

    // Series to use for comparison
    const comparisonSeries = comparisonDimension === 'framework' ? allFrameworks : allModels;

    // Dynamic Labels for Dropdown
    // Should depend on the Comparison Mode Dataset
    const comparisonAvailableLabels = useMemo(() => {
        let dataset = filteredData;

        if (comparisonMode === 'single') {
            dataset = dataset.filter(d => d.query === comparisonQuery);
        }

        return Array.from(new Set(dataset.map(d => d.label || 'Other'))).sort();
    }, [filteredData, comparisonMode, comparisonQuery]);

    // Dynamic Labels for Drill Down Dropdown (Context Aware)
    const drillDownAvailableLabels = useMemo(() => {
        let dataset = filteredData;
        if (selectedQuery) {
            dataset = dataset.filter(d => d.query === selectedQuery);
        }
        if (selectedFramework) {
            dataset = dataset.filter(d => d.framework === selectedFramework);
        }
        return Array.from(new Set(dataset.map(d => d.label || 'Other'))).sort();
    }, [filteredData, selectedQuery, selectedFramework]);

    const drillDownAvailableModels = useMemo(() => {
        let dataset = filteredData;
        if (selectedQuery) {
            dataset = dataset.filter(d => d.query === selectedQuery);
        }
        if (selectedFramework) {
            dataset = dataset.filter(d => d.framework === selectedFramework);
        }
        return Array.from(new Set(dataset.map(d => d.model || 'Unknown'))).sort();
    }, [filteredData, selectedQuery, selectedFramework]);

    const filteredQueries = useMemo(() => {
        let dataset = filteredData;
        if (selectedFramework) {
            dataset = dataset.filter(d => d.framework === selectedFramework);
        }
        return Array.from(new Set(dataset.map(d => d.query))).sort();
    }, [filteredData, selectedFramework]);

    // Init Defaults
    useEffect(() => {
        if ((!selectedFramework || !allFrameworks.includes(selectedFramework)) && allFrameworks.length > 0) setSelectedFramework(allFrameworks[0]);
        if (!comparisonQuery && allQueries.length > 0) setComparisonQuery(allQueries[0]);
    }, [allFrameworks, allQueries]);

    useEffect(() => {
        if ((!selectedQuery || !filteredQueries.includes(selectedQuery)) && filteredQueries.length > 0) setSelectedQuery(filteredQueries[0]);
    }, [filteredQueries]);

    // Comparison Data Logic
    const comparisonData = useMemo(() => {
        let dataToUse = filteredData;

        // Filter by mode first
        if (comparisonMode === 'single') {
            dataToUse = dataToUse.filter(d => d.query === comparisonQuery);
        } else if (comparisonMode === 'latest_10') {
            // For 'latest_10', we need to get the latest 10 unique queries first, then filter data
            const uniqueQueriesSortedByLatestTimestamp = Array.from(new Set(dataToUse.map(d => d.query)))
                .map(q => ({
                    query: q,
                    latestTimestamp: Math.max(...dataToUse.filter(d => d.query === q).map(x => new Date(x.timestamp).getTime()))
                }))
                .sort((a, b) => b.latestTimestamp - a.latestTimestamp)
                .slice(0, 10)
                .map(item => item.query);
            dataToUse = dataToUse.filter(d => uniqueQueriesSortedByLatestTimestamp.includes(d.query));
        }

        // Use comparisonSeries instead of allFrameworks
        const relevantSeries = comparisonSeries;

        // Group by Label if needed
        if (comparisonGroupByLabel) {
            const result: any[] = [];
            // Get labels from data
            const labels = Array.from(new Set(dataToUse.map(d => d.label || 'Other'))).sort();

            labels.forEach(lbl => {
                if (selectedComparisonLabels.length > 0 && !selectedComparisonLabels.includes(lbl)) return;

                const lblData = dataToUse.filter(d => (d.label || 'Other') === lbl);
                if (lblData.length === 0) return;

                const row: any = { label: lbl, data: [] };
                // We need to aggregate per Query to get points for the chart?
                // Actually the previous logic was: X-axis is Query (or Index), Lines are Frameworks.
                // So for this label, we gather unique queries.
                const lblQueries = Array.from(new Set(lblData.map(d => d.query)));

                lblQueries.forEach(q => {
                    const qRecord: any = { shortQuery: q.length > 15 ? q.substring(0, 15) + '...' : q };
                    relevantSeries.forEach(seriesName => {
                        const fwOrModelData = lblData.filter(d => d.query === q && (comparisonDimension === 'framework' ? d.framework : (d.model || 'Unknown')) === seriesName);
                        if (fwOrModelData.length > 0) {
                            const avgLat = fwOrModelData.reduce((s, x) => s + x.latency, 0) / fwOrModelData.length;
                            const avgTok = fwOrModelData.reduce((s, x) => s + x.tokens, 0) / fwOrModelData.length;
                            const evaluatedDatas = fwOrModelData.filter(d => d.answer_score !== null);
                            const hasEvaluatedData = evaluatedDatas.length > 0;
                            const avgScore = hasEvaluatedData ? evaluatedDatas.reduce((s, x) => s + (x.answer_score || 0), 0) / evaluatedDatas.length : 0;
                            const skillTriggerRate = fwOrModelData.reduce((s, x) => s + (x.skill_trigger_rate ?? 0), 0) / fwOrModelData.length * 100;
                            qRecord[`${seriesName}_lat`] = parseFloat(avgLat.toFixed(2));
                            qRecord[`${seriesName}_tok`] = Math.round(avgTok);
                            qRecord[`${seriesName}_score`] = hasEvaluatedData ? parseFloat(avgScore.toFixed(2)) : null;
                            qRecord[`${seriesName}_trigger`] = parseFloat(skillTriggerRate.toFixed(1));
                        }
                    });
                    if (Object.keys(qRecord).length > 1) { // Check if any series data was added
                        row.data.push(qRecord);
                    }
                });
                if (row.data.length > 0) {
                    result.push(row);
                }
            });
            return result;
        } else {
            // ORIGINAL LOGIC (Group by Query)
            const groups: Record<string, Execution[]> = {};
            dataToUse.forEach(d => {
                if (!groups[d.query]) groups[d.query] = [];
                groups[d.query].push(d);
            });

            const result: AvgComparison[] = [];
            Object.keys(groups).forEach(q => {
                const group = groups[q];
                const latestTs = Math.max(...group.map(x => new Date(x.timestamp).getTime()));
                const row: AvgComparison = {
                    query: q,
                    shortQuery: q.length > 15 ? q.substring(0, 15) + '...' : q,
                    latestTimestamp: latestTs
                };

                let hasData = false;
                relevantSeries.forEach(seriesName => {
                    const fwOrModelData = group.filter(d => (comparisonDimension === 'framework' ? d.framework : (d.model || 'Unknown')) === seriesName);
                    if (fwOrModelData.length > 0) {
                        const avgLat = fwOrModelData.reduce((s, x) => s + x.latency, 0) / fwOrModelData.length;
                        const avgTok = fwOrModelData.reduce((s, x) => s + x.tokens, 0) / fwOrModelData.length;
                        const skillTriggerRate = fwOrModelData.reduce((s, x) => s + (x.skill_trigger_rate ?? 0), 0) / fwOrModelData.length * 100;
                        const evaluatedDatas = fwOrModelData.filter(d => d.answer_score !== null);
                        const hasEvaluatedData = evaluatedDatas.length > 0;
                        const avgScore = hasEvaluatedData ? evaluatedDatas.reduce((s, x) => s + (x.answer_score || 0), 0) / evaluatedDatas.length : 0;

                        row[`${seriesName}_lat`] = parseFloat(avgLat.toFixed(2));
                        row[`${seriesName}_tok`] = Math.round(avgTok);
                        row[`${seriesName}_trigger`] = parseFloat(skillTriggerRate.toFixed(1));
                        row[`${seriesName}_score`] = hasEvaluatedData ? parseFloat(avgScore.toFixed(2)) : null;
                        hasData = true;
                    }
                });
                if (hasData) result.push(row);
            });

            result.sort((a, b) => b.latestTimestamp - a.latestTimestamp);

            if (comparisonMode === 'latest_10') return result.slice(0, 10);
            return result;
        }
    }, [filteredData, comparisonMode, comparisonQuery, comparisonGroupByLabel, selectedComparisonLabels, comparisonSeries, comparisonDimension]);


    // Single Query Drill-down Data
    const singleQueryStats = useMemo(() => {
        if (!selectedQuery) return null;

        // Start with all data for this query
        let relevant = filteredData.filter(d => d.query === selectedQuery);

        // Apply Framework Filter (Optional)
        if (selectedFramework) {
            relevant = relevant.filter(d => d.framework === selectedFramework);
        }

        if (relevant.length === 0) return null;

        const totalLat = relevant.reduce((sum, d) => sum + d.latency, 0);
        const lowerBetter = isMetricLowerBetter(bestWorstMetric);
        const withMetric = relevant.filter(d => hasMetricValue(d, bestWorstMetric));
        const sorted = withMetric.length > 0 ? [...withMetric].sort((a, b) => {
            const va = getMetricValue(a, bestWorstMetric);
            const vb = getMetricValue(b, bestWorstMetric);
            return lowerBetter ? va - vb : vb - va;
        }) : [];

        // Calculate global skill recall rate (only for queries with expected skill info)
        // First, identify queries that have expected skill info (check both legacy skill and new expectedSkills)
        const queriesWithExpectedSkill = new Set(
            configs
                .filter(c =>
                    (c.skill && c.skill.trim() !== '') ||
                    (c.expectedSkills && c.expectedSkills.some((e: any) => e.skill && e.skill.trim() !== ''))
                )
                .map(c => normalizeConfigQuery(c.query))
                .filter((query): query is string => Boolean(query))
        );

        // Filter execution records to only include queries with expected skill info
        const dataWithExpectedSkill = filteredData.filter(d =>
            d.query && queriesWithExpectedSkill.has(d.query.trim())
        );
        // Further filter to only records with skill recall rate calculated
        const dataWithTriggerRate = dataWithExpectedSkill.filter(d =>
            d.skill_trigger_rate !== null && d.skill_trigger_rate !== undefined
        );

        const globalSkillRecallRate = dataWithTriggerRate.length > 0
            ? dataWithTriggerRate.reduce((s, x) => s + (x.skill_trigger_rate ?? 0), 0) / dataWithTriggerRate.length * 100
            : 0;

        // Calculate query-level skill recall rate (only for records with expected skills)
        const relevantWithExpectedSkill = relevant.filter(d => d.skill_trigger_rate !== null && d.skill_trigger_rate !== undefined);
        const querySkillRecallRate = relevantWithExpectedSkill.length > 0
            ? relevantWithExpectedSkill.reduce((s, x) => s + (x.skill_trigger_rate ?? 0), 0) / relevantWithExpectedSkill.length * 100
            : 0;

        const withCost = relevant.filter(d => d.cost != null);
        const avgCost = withCost.length ? withCost.reduce((sum, d) => sum + (d.cost || 0), 0) / withCost.length : null;

        // Calculate CPSR
        const cpsr = calculateCPSR(relevant);

        return {
            count: relevant.length,
            avgLatency: totalLat / relevant.length,
            avgTokens: Math.round(relevant.reduce((sum, d) => sum + d.tokens, 0) / relevant.length),
            avgCost,
            globalSkillRecallRate: globalSkillRecallRate,
            querySkillRecallRate: querySkillRecallRate,
            cpsr,
            avgAnsScore: relevant.filter(d => d.answer_score !== null).length ? (relevant.filter(d => d.answer_score !== null).reduce((sum, d) => sum + (d.answer_score || 0), 0) / relevant.filter(d => d.answer_score !== null).length) : 0,
            best: sorted.length > 0 ? sorted[0] : null,
            worst: sorted.length > 0 ? sorted[sorted.length - 1] : null,
            avgSkillScore: (relevant.reduce((sum, d) => sum + (d.skill_score || 0), 0) / relevant.filter(d => d.skill_score !== undefined).length) || 0
        };
    }, [filteredData, selectedFramework, selectedQuery, configs, bestWorstMetric]);

    // Derived Table Data
    const tableFilteredData = useMemo(() => {
        return filteredData.filter(d => {
            if (tableFrameworks.length > 0 && !tableFrameworks.includes(d.framework)) return false;
            if (tableLabels.length > 0 && !tableLabels.includes(d.label || '')) return false;
            if (tableModels.length > 0 && !tableModels.includes(d.model || '')) return false;
            if (tableQuery && !d.query.toLowerCase().includes(tableQuery.toLowerCase())) return false;
            return true;
        });
    }, [filteredData, tableFrameworks, tableLabels, tableModels, tableQuery]);

    const totalTablePages = Math.ceil(tableFilteredData.length / TABLE_PAGE_SIZE);
    const currentTableData = tableFilteredData.slice((tablePage - 1) * TABLE_PAGE_SIZE, tablePage * TABLE_PAGE_SIZE);

    const versionDiffMap = useMemo(() => {
        const map = new Map<string, { latencyDiff: number | null; tokenDiff: number | null; accuracyDiff: number | null; costDiff: number | null }>();
        const skillVersionRecords = filteredData.filter(d => d.skill && d.skill_version != null);
        const groupByKey = new Map<string, Execution[]>();
        for (const d of skillVersionRecords) {
            const key = `${d.query}|||${d.skill}`;
            if (!groupByKey.has(key)) groupByKey.set(key, []);
            groupByKey.get(key)!.push(d);
        }
        for (const [, records] of Array.from(groupByKey.entries())) {
            records.sort((a, b) => {
                const va = parseInt(a.skill_version || '0');
                const vb = parseInt(b.skill_version || '0');
                return va - vb;
            });
            const avgByVersion = new Map<number, { latency: number; tokens: number; accuracy: number; cost: number; count: number }>();
            for (const r of records) {
                const v = parseInt(r.skill_version || '0');
                if (!avgByVersion.has(v)) {
                    avgByVersion.set(v, { latency: 0, tokens: 0, accuracy: 0, cost: 0, count: 0 });
                }
                const entry = avgByVersion.get(v)!;
                entry.latency += r.latency;
                entry.tokens += r.tokens;
                entry.accuracy += r.answer_score ?? 0;
                entry.cost += r.cost ?? 0;
                entry.count += 1;
            }
            for (const r of records) {
                const v = parseInt(r.skill_version || '0');
                const prev = avgByVersion.get(v - 1);
                if (!prev || prev.count === 0) continue;
                const prevLat = prev.latency / prev.count;
                const prevTok = prev.tokens / prev.count;
                const prevAcc = prev.accuracy / prev.count;
                const prevCost = prev.cost / prev.count;
                const rid = r.upload_id || r.task_id || '';
                if (!rid) continue;
                map.set(rid, {
                    latencyDiff: prevLat !== 0 ? ((r.latency - prevLat) / prevLat) * 100 : null,
                    tokenDiff: prevTok !== 0 ? ((r.tokens - prevTok) / prevTok) * 100 : null,
                    accuracyDiff: prevAcc !== 0 ? (((r.answer_score ?? 0) - prevAcc) / prevAcc) * 100 : null,
                    costDiff: prevCost !== 0 ? (((r.cost ?? 0) - prevCost) / prevCost) * 100 : null,
                });
            }
        }
        return map;
    }, [filteredData]);

    const ChartLayout = ({ title, dataKey, unit = '', data, frameworks, yFormatter }: { title: React.ReactNode, dataKey: string, unit?: string, data: any[], frameworks: string[], yFormatter?: (val: number) => string }) => (
        <div className="card" style={{ height: '350px', display: 'flex', flexDirection: 'column' }}>
            <div className="card-title" style={{ marginBottom: '10px' }}>{title}</div>
            <div style={{ flex: 1, minHeight: 0 }}>
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 20 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                        <XAxis dataKey="shortQuery" stroke="var(--foreground-secondary)" fontSize={11} angle={-20} textAnchor="end" height={60} />
                        <YAxis stroke="var(--foreground-secondary)" tickFormatter={yFormatter} />
                        <Tooltip
                            formatter={(val, name) => [val !== undefined ? (yFormatter ? yFormatter(val as number) : val + unit) : '-', name || '']}
                            contentStyle={{ backgroundColor: 'var(--dropdown-bg)', borderColor: 'var(--border)', color: 'var(--foreground)' }}
                        />
                        <Legend />
                        {frameworks.map((fw, i) => (
                            <Bar key={fw} dataKey={`${fw}_${dataKey}`} name={fw} fill={(isDark ? CHART_COLORS_DARK : CHART_COLORS)[i % (isDark ? CHART_COLORS_DARK : CHART_COLORS).length]} radius={[4, 4, 0, 0]} />
                        ))}
                    </BarChart>
                </ResponsiveContainer>
            </div>
        </div>
    );



    return (
        <div className="dashboard-container">
            {/* Header */}
            <header className="header" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '1rem', ...(embedded ? { borderBottom: 'none', marginBottom: 0, paddingBottom: 0 } : {}) }}>
                {!embedded && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <h1 className="title" style={{ marginBottom: 0 }}>{t('app.title')}</h1>
                            <span style={{ fontSize: '0.8rem', color: 'var(--foreground-secondary)', letterSpacing: '1px' }}>{t('app.subtitle')}</span>
                        </div>

                        {/* Main Navigation Tabs */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                            <div className="tabs">
                            <button
                                className={`tab-btn ${activeTab === 'dashboard' ? 'active' : ''}`}
                                onClick={() => setActiveTab('dashboard')}
                            >
                                {t('nav.dashboard')}
                            </button>
                            <button
                                className={`tab-btn ${activeTab === 'config' ? 'active' : ''}`}
                                onClick={() => setActiveTab('config')}
                            >
                                {t('nav.dataset')}
                            </button>
                            <button
                                className={`tab-btn ${activeTab === 'skill' ? 'active' : ''}`}
                                onClick={() => setActiveTab('skill')}
                            >
                                {t('nav.skill')}
                            </button>
                            </div>
                        </div>
                    </div>
                )}
                {activeTab === 'dashboard' && (
                    <div className="controls" style={{ display: 'flex', gap: '8px' }}>
                        {!embedded && (
                            <button
                                className="theme-toggle-btn"
                                onClick={toggleTheme}
                                title={isDark ? t('theme.switchToLight') : t('theme.switchToDark')}
                            >
                                {isDark ? '☀️' : '🌙'}
                            </button>
                        )}
                        {!embedded && <LanguageSwitch />}
                        <select value={timeFilter} onChange={(e) => setTimeFilter(e.target.value)}>
                            <option value="all">{t('dashboard.timeFilter.all')}</option>
                            <option value="24h">{t('dashboard.timeFilter.24h')}</option>
                            <option value="3h">{t('dashboard.timeFilter.3h')}</option>
                            <option value="1h">{t('dashboard.timeFilter.1h')}</option>
                        </select>
                        {allConfigs.length > 0 ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', border: '1px solid var(--border)', borderRadius: '4px', padding: '4px 8px', background: 'var(--background-secondary)' }}>
                                <span style={{ fontSize: '0.8rem', color: 'var(--foreground-secondary)' }}>{t('settings.modelLabel')}:</span>
                                <select
                                    value={activeConfigId || 'none'}
                                    onChange={(e) => activateConfig(e.target.value)}
                                    style={{ background: 'transparent', color: 'var(--foreground-secondary)', border: 'none', maxWidth: '140px', outline: 'none', cursor: 'pointer' }}
                                >
                                    <option value="none">{t('settings.notConfigured')}</option>
                                    {allConfigs.map(cfg => (
                                        <option key={cfg.id} value={cfg.id}>{cfg.name}</option>
                                    ))}
                                </select>
                                <div style={{ width: '1px', height: '14px', background: 'var(--border)', margin: '0 4px' }}></div>
                                <button
                                    onClick={() => setShowSettingsModal(true)}
                                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '0', fontSize: '1rem' }}
                                    title={t('settings.manageModelConfig')}
                                >
                                    ⚙️
                                </button>
                            </div>
                        ) : (
                            <button
                                className="btn-secondary"
                                style={{
                                    padding: '4px 8px',
                                    background: 'transparent',
                                    border: '1px solid var(--border)',
                                    color: 'var(--foreground-secondary)'
                                }}
                                onClick={() => setShowSettingsModal(true)}
                            >
                                {t('settings.evalConfig')}
                            </button>
                        )}
                    </div>
                )}
            </header>

            {/* SETTINGS MODAL */}
            {showSettingsModal && (
                <div style={{
                    position: 'fixed',
                    top: 0, left: 0, right: 0, bottom: 0,
                    background: c.overlayBg,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 2000
                }} onClick={(e) => {
                    if (e.target === e.currentTarget) setShowSettingsModal(false);
                }}>
                    <div className="card" style={{ width: '600px', maxHeight: '90vh', overflowY: 'auto' }}>

                        {/* VIEW 1: LIST OF CONFIGS */}
                        {!editingConfigId && (
                            <>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem', alignItems: 'center' }}>
                                    <h3 style={{ margin: 0, color: c.fg }}>{t('settings.manageModelConfig')}</h3>
                                    <button onClick={() => setShowSettingsModal(false)} style={{ background: 'transparent', border: 'none', color: c.fgSecondary, fontSize: '1.2rem', cursor: 'pointer' }}>✕</button>
                                </div>

                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '1.5rem' }}>
                                    {allConfigs.map(config => {
                                        const isDefault = isDefaultConfig(config.id);
                                        return (
                                            <div key={config.id} style={{
                                                display: 'flex',
                                                justifyContent: 'space-between',
                                                alignItems: 'center',
                                                padding: '10px',
                                                background: activeConfigId === config.id ? 'rgba(37, 99, 235, 0.1)' : '#f4f4f5',
                                                border: activeConfigId === config.id ? '1px solid #2563eb' : '1px solid #e4e4e7',
                                                borderRadius: '6px'
                                            }}>
                                                <div>
                                                    <div style={{ fontWeight: 'bold', color: activeConfigId === config.id ? '#2563eb' : '#1e293b' }}>
                                                        {config.name} {activeConfigId === config.id && `(${t('common.active')})`}
                                                        {isDefault && <span style={{ marginLeft: '8px', fontSize: '0.8rem', color: c.fgSecondary }}>{t('common.default')}</span>}
                                                    </div>
                                                    <div style={{ fontSize: '0.8rem', color: c.fgSecondary }}>
                                                        {config.provider} • {config.model}
                                                    </div>
                                                </div>

                                                <div style={{ display: 'flex', gap: '8px' }}>
                                                    {activeConfigId !== config.id && (
                                                        <button
                                                            className="btn-secondary"
                                                            style={{ padding: '4px 8px', fontSize: '0.8rem' }}
                                                            onClick={() => activateConfig(config.id)}
                                                        >
                                                            {t('common.activate')}
                                                        </button>
                                                    )}
                                                    {!isDefault && (
                                                        <>
                                                            <button
                                                                className="btn-secondary"
                                                                style={{ padding: '4px 8px', fontSize: '0.8rem' }}
                                                                onClick={() => {
                                                                    setTempConfig({ ...config });
                                                                    setEditingConfigId(config.id);
                                                                    setSettingsStatus(null);
                                                                }}
                                                            >
                                                                {t('common.edit')}
                                                            </button>
                                                            <button
                                                                className="btn-secondary"
                                                                style={{ padding: '4px 8px', fontSize: '0.8rem', color: c.error, borderColor: c.error }}
                                                                onClick={() => deleteEvalConfig(config.id)}
                                                            >
                                                                {t('common.del')}
                                                            </button>
                                                        </>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>

                                <button
                                    className="btn-primary"
                                    style={{ width: '100%', display: 'flex', justifyContent: 'center', gap: '8px' }}
                                    onClick={() => {
                                        setTempConfig({
                                            id: 'new',
                                            name: t('settings.newConfig'),
                                            provider: 'deepseek',
                                            model: 'deepseek-chat',
                                            apiKey: '',
                                            baseUrl: 'https://api.deepseek.com'
                                        });
                                        setEditingConfigId('new');
                                        setSettingsStatus(null);
                                    }}
                                >
                                    + {t('settings.addNewConfig')}
                                </button>
                            </>
                        )}

                        {/* VIEW 2: EDITING FORM */}
                        {editingConfigId && (
                            <>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem', alignItems: 'center' }}>
                                    <h3 style={{ margin: 0, color: c.fg }}>{editingConfigId === 'new' ? t('settings.newConfig') : t('settings.editConfig')}</h3>
                                    <button
                                        onClick={() => setEditingConfigId(null)}
                                        style={{ background: 'transparent', border: 'none', color: c.fgSecondary, fontSize: '0.9rem', cursor: 'pointer' }}
                                    >
                                        Back to List
                                    </button>
                                </div>

                                {/* Status Message Display */}
                                {settingsStatus && (
                                    <div style={{
                                        padding: '10px',
                                        marginBottom: '1rem',
                                        borderRadius: '4px',
                                        background: settingsStatus.type === 'success' ? 'rgba(22, 163, 74, 0.1)' : 'rgba(220, 38, 38, 0.1)',
                                        border: `1px solid ${settingsStatus.type === 'success' ? '#16a34a' : '#dc2626'}`,
                                        color: settingsStatus.type === 'success' ? '#16a34a' : '#dc2626',
                                        fontSize: '0.9rem'
                                    }}>
                                        {settingsStatus.msg}
                                    </div>
                                )}

                                <div className="form-group">
                                    <label>Config Name</label>
                                    <input
                                        placeholder="e.g. My DeepSeek, Company OpenAI Proxy"
                                        value={tempConfig.name || ''}
                                        onChange={e => setTempConfig({ ...tempConfig, name: e.target.value })}
                                        disabled={isDefaultConfig(editingConfigId)}
                                        style={{ width: '100%', padding: '10px', background: c.bg, border: `1px solid ${c.borderDark}`, color: c.fg, borderRadius: '4px' }}
                                    />
                                </div>

                                <div className="form-group">
                                    <label>Provider</label>
                                    <select
                                        value={tempConfig.provider}
                                        onChange={e => {
                                            const p = e.target.value as any;
                                            const updates: any = { provider: p };
                                            if (p === 'deepseek') {
                                                updates.baseUrl = 'https://api.deepseek.com';
                                                updates.model = 'deepseek-chat';
                                            } else if (p === 'siliconflow') {
                                                updates.baseUrl = 'https://api.siliconflow.cn/v1';
                                                updates.model = 'deepseek-ai/DeepSeek-V3';
                                            } else if (p === 'openai') {
                                                updates.baseUrl = 'https://api.openai.com/v1';
                                                updates.model = 'gpt-4o';
                                            } else if (p === 'anthropic') {
                                                updates.baseUrl = 'https://api.anthropic.com/v1';
                                                updates.model = 'claude-3-5-sonnet-20240620';
                                            }
                                            setTempConfig({ ...tempConfig, ...updates });
                                        }}
                                        disabled={isDefaultConfig(editingConfigId)}
                                        style={{ width: '100%', padding: '10px', background: c.bg, border: `1px solid ${c.borderDark}`, color: c.fg, borderRadius: '4px' }}
                                    >
                                        <option value="deepseek">DeepSeek (Official)</option>
                                        <option value="siliconflow">SiliconFlow (DeepSeek V3 High Speed)</option>
                                        <option value="openai">OpenAI</option>
                                        <option value="anthropic">Anthropic</option>
                                        <option value="custom">Custom (OpenAI Compatible)</option>
                                    </select>
                                </div>

                                <div className="form-group">
                                    <label>Base URL (Optional)</label>
                                    <input
                                        placeholder="e.g. https://api.deepseek.com or https://api.openai.com/v1"
                                        value={tempConfig.baseUrl || ''}
                                        onChange={e => {
                                            let val = e.target.value;
                                            val = val.replace(/\/chat\/completions\/?$/, '');
                                            setTempConfig({ ...tempConfig, baseUrl: val });
                                        }}
                                        disabled={isDefaultConfig(editingConfigId)}
                                        style={{ width: '100%', padding: '10px', background: c.bg, border: `1px solid ${c.borderDark}`, color: c.fg, borderRadius: '4px' }}
                                    />
                                </div>

                                <div className="form-group">
                                    <label>密钥</label>
                                    <input
                                        type="password"
                                        placeholder="sk-..."
                                        value={tempConfig.apiKey || ''}
                                        onChange={e => setTempConfig({ ...tempConfig, apiKey: e.target.value })}
                                        disabled={isDefaultConfig(editingConfigId)}
                                        style={{ width: '100%', padding: '10px', background: c.bg, border: `1px solid ${c.borderDark}`, color: c.fg, borderRadius: '4px' }}
                                    />
                                </div>

                                <div className="form-group">
                                    <label>Model Name</label>
                                    <input
                                        placeholder="e.g. deepseek-chat, gpt-4o"
                                        value={tempConfig.model || ''}
                                        onChange={e => setTempConfig({ ...tempConfig, model: e.target.value })}
                                        disabled={isDefaultConfig(editingConfigId)}
                                        style={{ width: '100%', padding: '10px', background: c.bg, border: `1px solid ${c.borderDark}`, color: c.fg, borderRadius: '4px' }}
                                    />
                                </div>

                                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '2rem' }}>
                                    <button className="btn-secondary" onClick={() => setEditingConfigId(null)}>Cancel</button>
                                    {!isDefaultConfig(editingConfigId) && (
                                        <button
                                            className="btn-primary"
                                            onClick={saveCurrentConfig}
                                            disabled={isSavingSettings}
                                            style={{ opacity: isSavingSettings ? 0.7 : 1, display: 'flex', alignItems: 'center', gap: '6px' }}
                                        >
                                            {isSavingSettings && <span style={{
                                                width: '12px', height: '12px', border: '2px solid white', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite'
                                            }}></span>}
                                            {isSavingSettings ? 'Testing & Saving...' : 'Test Connection & Save'}
                                        </button>
                                    )}
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}

            {/* DASHBOARD */}
            {activeTab === 'dashboard' && (
                <>
                    {/* 1. Global Cards */}
                    <h2 className="section-title">{t('dashboard.overview')}</h2>
                    <div className="ai-grid-layout">
                        {allFrameworks.map((fw, idx) => {
                            const fwData = filteredData.filter(d => d.framework === fw);
                            // Filter for queries with expected skill info (check both legacy skill and new expectedSkills)
                            const queriesWithExpectedSkill = new Set(
                                configs
                                    .filter(c =>
                                        (c.skill && c.skill.trim() !== '') ||
                                        (c.expectedSkills && c.expectedSkills.some((e: any) => e.skill && e.skill.trim() !== ''))
                                    )
                                    .map(c => normalizeConfigQuery(c.query))
                                    .filter((query): query is string => Boolean(query))
                            );
                            const fwDataWithExpectedSkill = fwData.filter(d =>
                                d.query && queriesWithExpectedSkill.has(d.query.trim())
                            );
                            const avgLat = fwData.length ? (fwData.reduce((s, x) => s + x.latency, 0) / fwData.length) : 0;
                            const avgTok = fwData.length ? (fwData.reduce((s, x) => s + x.tokens, 0) / fwData.length) : 0;
                            const evaluatedFwData = fwData.filter(d => d.answer_score !== null);
                            const hasEvaluatedData = evaluatedFwData.length > 0;
                            const avgScore = hasEvaluatedData ? (evaluatedFwData.reduce((s, x) => s + (x.answer_score || 0), 0) / evaluatedFwData.length) : 0;
                            const skillTriggerRate = fwDataWithExpectedSkill.length ? fwDataWithExpectedSkill.reduce((s, x) => s + (x.skill_trigger_rate ?? 0), 0) / fwDataWithExpectedSkill.length * 100 : 0;

                            return (
                                <div className="card" key={fw} style={{ borderLeft: `4px solid ${(isDark ? CHART_COLORS_DARK : CHART_COLORS)[idx % (isDark ? CHART_COLORS_DARK : CHART_COLORS).length]}` }}>
                                    <div className="card-title" style={{ color: (isDark ? CHART_COLORS_DARK : CHART_COLORS)[idx % (isDark ? CHART_COLORS_DARK : CHART_COLORS).length], fontSize: '0.9375rem', fontWeight: 600 }}>{fw}</div>
                                    <div className="stat-value">{fwData.length} <small style={{ fontSize: '1rem', color: 'var(--foreground-muted)' }}>{t('metrics.executionCount')}</small></div>
                                    <div style={{ marginTop: '1rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.2rem' }}>
                                        {/* Latency */}
                                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                                            <span style={{ fontSize: '0.8rem', color: 'var(--foreground-secondary)', textTransform: 'uppercase' }}>{t('metrics.latency')}</span>
                                            <span style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--foreground)' }}>{formatLatency(avgLat)}</span>
                                        </div>
                                        {/* Token */}
                                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                                            <span style={{ fontSize: '0.8rem', color: 'var(--foreground-secondary)', textTransform: 'uppercase' }}>TOKEN</span>
                                            <span style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--foreground)' }}>{formatTokens(Math.round(avgTok))}</span>
                                        </div>
                                    </div>
                                    <div style={{ marginTop: '0.8rem', paddingTop: '0.8rem', borderTop: '1px solid var(--border)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.2rem' }}>
                                        {/* Accuracy */}
                                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                                            <span style={{ fontSize: '0.8rem', color: 'var(--foreground-secondary)' }}>{t('metrics.accuracy')}</span>
                                            <span style={{ fontSize: '1.5rem', fontWeight: 700, color: !hasEvaluatedData ? 'var(--foreground-muted)' : (avgScore > 0.8 ? 'var(--success)' : 'var(--warning)') }}>
                                                {hasEvaluatedData ? `${(avgScore * 100).toFixed(1)}%` : '--'}
                                            </span>
                                        </div>
                                        {/* Skill Recall Rate */}
                                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                                            <span style={{ fontSize: '0.8rem', color: 'var(--foreground-secondary)' }}>{t('metrics.skillTriggerRate')}</span>
                                            <span style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--warning)' }}>
                                                {skillTriggerRate.toFixed(1)}%
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {/* 2. Charts (Split 4 ways) */}
                    <h2 className="section-title">{t('dashboard.comparison')}</h2>
                    <div className="analysis-controls">
                        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                            {['single', 'latest_10', 'all'].map(m => (
                                <label key={m} style={{ cursor: 'pointer', color: 'var(--foreground)', display: 'flex', alignItems: 'center', gap: '5px' }}>
                                    <input type="radio" checked={comparisonMode === m} onChange={() => setComparisonMode(m as any)} />
                                    {m === 'latest_10' ? t('dashboard.comparisonMode.latest10') : m === 'all' ? t('dashboard.comparisonMode.all') : t('dashboard.comparisonMode.single')}
                                </label>
                            ))}
                        </div>
                        {comparisonMode === 'single' && (
                            <select value={comparisonQuery} onChange={e => setComparisonQuery(e.target.value)} style={{ maxWidth: '300px' }}>
                                {allQueries.map(q => <option key={q} value={q}>{q.substring(0, 40)}</option>)}
                            </select>
                        )}

                        <div style={{ marginLeft: '10px', display: 'flex', gap: '8px', borderLeft: '1px solid var(--border)', paddingLeft: '10px' }}>
                            <span style={{ color: 'var(--foreground-secondary)', fontSize: '0.9rem', display: 'flex', alignItems: 'center' }}>{t('dashboard.groupBy')}:</span>
                            <button
                                className={`tab-btn-sm ${comparisonDimension === 'framework' ? 'active' : ''}`}
                                onClick={() => setComparisonDimension('framework')}
                                style={{ padding: '2px 8px', fontSize: '0.8rem', background: comparisonDimension === 'framework' ? 'var(--primary)' : 'transparent', color: comparisonDimension === 'framework' ? '#ffffff' : 'var(--foreground-secondary)', border: '1px solid var(--primary)' }}
                            >
                                {t('dashboard.dimension.framework')}
                            </button>
                            <button
                                className={`tab-btn-sm ${comparisonDimension === 'model' ? 'active' : ''}`}
                                onClick={() => setComparisonDimension('model')}
                                style={{ padding: '2px 8px', fontSize: '0.8rem', background: comparisonDimension === 'model' ? 'var(--primary)' : 'transparent', color: comparisonDimension === 'model' ? '#ffffff' : 'var(--foreground-secondary)', border: '1px solid var(--primary)' }}
                            >
                                {t('dashboard.dimension.model')}
                            </button>
                        </div>


                        <div style={{ marginLeft: '10px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <label style={{ cursor: 'pointer', color: 'var(--foreground)', display: 'flex', alignItems: 'center', gap: '5px' }}>
                                <input type="checkbox" checked={comparisonGroupByLabel} onChange={(e) => {
                                    setComparisonGroupByLabel(e.target.checked);
                                    if (e.target.checked && selectedComparisonLabels.length === 0) {
                                        // Default to select all if none selected initially? Or let user pick.
                                        // Let's default to empty means ALL for now, or we force selection.
                                    }
                                }} />
                                {t('dashboard.byLabel')}
                            </label>

                            {comparisonGroupByLabel && (
                                <div style={{ position: 'relative', display: 'inline-block' }}>
                                    <div className="dropdown-trigger" style={{ background: 'var(--dropdown-bg)', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', border: '1px solid var(--dropdown-border)', minWidth: '150px', color: 'var(--foreground)' }}>
                                        {selectedComparisonLabels.length === 0 ? t('dashboard.allLabels') : t('dashboard.selectedCount', { count: selectedComparisonLabels.length.toString() })}
                                        <span style={{ float: 'right', fontSize: '0.8rem' }}>▼</span>
                                    </div>
                                    <div className="dropdown-content" style={{
                                        position: 'absolute', top: '100%', left: 0, zIndex: 10,
                                        background: 'var(--dropdown-bg)', border: '1px solid var(--dropdown-border)', borderRadius: '4px',
                                        padding: '0.5rem', minWidth: '200px', maxHeight: '300px', overflowY: 'auto',
                                        boxShadow: '0 4px 6px -1px var(--shadow-color)'
                                    }}>
                                        <label style={{ display: 'block', marginBottom: '4px', cursor: 'pointer', color: 'var(--foreground)' }}>
                                            <input type="checkbox"
                                                checked={selectedComparisonLabels.length === 0}
                                                onChange={() => setSelectedComparisonLabels([])}
                                            /> <span style={{ marginLeft: '4px' }}>{t('dashboard.allLabels')}</span>
                                        </label>
                                        <hr style={{ borderColor: 'var(--border)', margin: '4px 0' }} />
                                        {comparisonAvailableLabels.map(l => (
                                            <label key={l} style={{ display: 'block', marginBottom: '4px', cursor: 'pointer', color: 'var(--foreground)' }}>
                                                <input type="checkbox"
                                                    checked={selectedComparisonLabels.includes(l)}
                                                    onChange={(e) => {
                                                        if (e.target.checked) {
                                                            setSelectedComparisonLabels([...selectedComparisonLabels, l]);
                                                        } else {
                                                            setSelectedComparisonLabels(selectedComparisonLabels.filter(x => x !== l));
                                                        }
                                                    }}
                                                /> <span style={{ marginLeft: '4px' }}>{l}</span>
                                            </label>
                                        ))}
                                    </div>

                                </div>
                            )}
                        </div>
                    </div>

                    {comparisonGroupByLabel ? (
                        // Grouped By Label View (Rows of Charts)
                        <div>
                            {comparisonData.map((group: any) => (
                                <div key={group.label} style={{ marginBottom: '2rem' }}>
                                    <h3 style={{ color: 'var(--foreground)', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem', marginBottom: '1rem' }}>
                                        Tag: <span style={{ color: c.primary }}>{group.label}</span>
                                    </h3>
                                    <div className="analysis-grid">
<ChartLayout title={t('dashboard.table.latency')} unit="m" dataKey="lat" data={group.data} frameworks={comparisonSeries} yFormatter={(v) => (v / 60000).toFixed(2) + 'm'} />
                                        <ChartLayout title={t('metrics.tokens')} dataKey="tok" data={group.data} frameworks={comparisonSeries} yFormatter={formatTokens} />
                                        <ChartLayout title={t('metrics.accuracy')} dataKey="score" unit="" data={group.data} frameworks={comparisonSeries} />
                                        <ChartLayout title={t('metrics.skillTriggerRate')} dataKey="trigger" unit="%" data={group.data} frameworks={comparisonSeries} yFormatter={(v) => Number(v).toFixed(1) + '%'} />
                                    </div>
                                </div>
                            ))}
                            {comparisonData.length === 0 && <div className="card" style={{ textAlign: 'center', padding: '2rem', color: c.fgSecondary }}>{t('common.noData')}</div>}
                        </div>
                    ) : (
                        // Default View
                        comparisonData.length > 0 ? (
                            <div className="analysis-grid">
                                <ChartLayout
                                    title={<span>{t('metrics.avgLatency')} <CustomTooltip content={t('dashboard.tooltip.avgLatency')} /></span>}
                                    dataKey="lat"
                                    unit="m"
                                    data={comparisonData}
                                    frameworks={comparisonSeries}
                                    yFormatter={(v) => (v / 60000).toFixed(2) + 'm'}
                                />
                                <ChartLayout
                                    title={<span>{t('metrics.avgTokens')} <CustomTooltip content={t('dashboard.tooltip.avgConsumption')} /></span>}
                                    dataKey="tok"
                                    unit=""
                                    data={comparisonData}
                                    frameworks={comparisonSeries}
                                    yFormatter={formatTokens}
                                />
                                <ChartLayout
                                    title={<span>{t('metrics.avgAccuracy')} <CustomTooltip content={<div>{t('dashboard.tooltip.avgAccuracy')}</div>} /></span>}
                                    dataKey="score"
                                    unit=""
                                    data={comparisonData}
                                    frameworks={comparisonSeries}
                                />
                                <ChartLayout
                                    title={<span>{t('metrics.avgSkillTrigger')} <CustomTooltip content={<div>{t('dashboard.drillDown.avgSkillTrigger')}</div>} /></span>}
                                    dataKey="trigger"
                                    unit="%"
                                    data={comparisonData}
                                    frameworks={comparisonSeries}
                                    yFormatter={(v) => Number(v).toFixed(1) + '%'}
                                />
                            </div>
                        ) : (
                            <div className="card" style={{ textAlign: 'center', padding: '2rem', color: c.fgSecondary }}>{t('common.noData')}</div>
                        )
                    )}


                    {/* 3. Single Query Drill-down */}
                    <h2 className="section-title">{t('dashboard.singleQueryDetail')}</h2>
                    <div className="analysis-controls">
                        <select value={selectedFramework} onChange={e => setSelectedFramework(e.target.value)}>
                            <option value="">{t('dashboard.selectFramework')}</option>
                            {allFrameworks.map(f => <option key={f} value={f}>{f}</option>)}
                        </select>
                        <select value={selectedQuery} onChange={e => setSelectedQuery(e.target.value)} style={{ flex: 1 }}>
                            <option value="">{t('dashboard.selectQuery')}</option>
                            {filteredQueries.map(q => <option key={q} value={q}>{q.substring(0, 80)}</option>)}
                        </select>
                        <select value={bestWorstMetric} onChange={e => setBestWorstMetric(e.target.value as BestWorstMetric)} style={{ fontSize: '0.9rem' }}>
                            <option value="latency">{t('dashboard.drillDown.bestWorstMetric')}: {t('metrics.latency')}</option>
                            <option value="accuracy">{t('dashboard.drillDown.bestWorstMetric')}: {t('metrics.accuracy')}</option>
                            <option value="tokens">{t('dashboard.drillDown.bestWorstMetric')}: {t('metrics.tokens')}</option>
                            <option value="cost">{t('dashboard.drillDown.bestWorstMetric')}: {t('metrics.cost')}</option>
                            <option value="trigger">{t('dashboard.drillDown.bestWorstMetric')}: {t('metrics.trigger')}</option>
                        </select>
                        <div style={{ marginLeft: '10px', display: 'flex', alignItems: 'center', gap: '20px' }}>
                            <label style={{ cursor: 'pointer', color: 'var(--foreground)', display: 'flex', alignItems: 'center', gap: '5px' }}>
                                <input type="checkbox" checked={drillDownGroupByLabel} onChange={(e) => {
                                    setDrillDownGroupByLabel(e.target.checked);
                                    if (e.target.checked) setDrillDownGroupByModel(false);
                                }} />
                                {t('dashboard.byLabel')}
                            </label>

                            <label style={{ cursor: 'pointer', color: 'var(--foreground)', display: 'flex', alignItems: 'center', gap: '5px' }}>
                                <input type="checkbox" checked={drillDownGroupByModel} onChange={(e) => {
                                    setDrillDownGroupByModel(e.target.checked);
                                    if (e.target.checked) setDrillDownGroupByLabel(false);
                                }} />
                                {t('dashboard.byModel')}
                            </label>

                            {drillDownGroupByLabel && (
                                <div className="dropdown-container" style={{ position: 'relative', display: 'inline-block' }}>
                                    <div className="dropdown-trigger" style={{ background: 'var(--dropdown-bg)', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', border: '1px solid var(--dropdown-border)', minWidth: '150px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: 'var(--foreground)' }}>
                                        {selectedDrillDownLabels.length === 0 ? t('dashboard.allLabels') : t('dashboard.selectedCount', { count: selectedDrillDownLabels.length.toString() })}
                                        <span style={{ fontSize: '0.8rem', marginLeft: '8px' }}>▼</span>
                                    </div>
                                    <div className="dropdown-content" style={{
                                        position: 'absolute', top: '100%', left: 0, zIndex: 10,
                                        background: 'var(--dropdown-bg)', border: '1px solid var(--dropdown-border)', borderRadius: '4px',
                                        padding: '0.5rem', minWidth: '200px', maxHeight: '300px', overflowY: 'auto',
                                        boxShadow: '0 4px 6px -1px var(--shadow-color)',
                                        color: 'var(--foreground)'
                                    }}>
                                        <label style={{ display: 'block', marginBottom: '4px', cursor: 'pointer' }}>
                                            <input type="checkbox"
                                                checked={selectedDrillDownLabels.length === 0}
                                                onChange={() => setSelectedDrillDownLabels([])}
                                            /> <span style={{ marginLeft: '4px' }}>{t('dashboard.allLabels')}</span>
                                        </label>
                                        <hr style={{ borderColor: 'var(--border)', margin: '4px 0' }} />
                                        {drillDownAvailableLabels.map(l => (
                                            <label key={l} style={{ display: 'block', marginBottom: '4px', cursor: 'pointer' }}>
                                                <input type="checkbox"
                                                    checked={selectedDrillDownLabels.includes(l)}
                                                    onChange={(e) => {
                                                        if (e.target.checked) {
                                                            setSelectedDrillDownLabels([...selectedDrillDownLabels, l]);
                                                        } else {
                                                            setSelectedDrillDownLabels(selectedDrillDownLabels.filter(x => x !== l));
                                                        }
                                                    }}
                                                /> <span style={{ marginLeft: '4px' }}>{l}</span>
                                            </label>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {drillDownGroupByModel && (
                                <div className="dropdown-container" style={{ position: 'relative', display: 'inline-block' }}>
                                    <div className="dropdown-trigger" style={{ background: 'var(--dropdown-bg)', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', border: '1px solid var(--dropdown-border)', minWidth: '150px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: 'var(--foreground)' }}>
                                        {selectedDrillDownModels.length === 0 ? t('dashboard.allModels') : t('dashboard.selectedCount', { count: selectedDrillDownModels.length.toString() })}
                                        <span style={{ fontSize: '0.8rem', marginLeft: '8px' }}>▼</span>
                                    </div>
                                    <div className="dropdown-content" style={{
                                        position: 'absolute', top: '100%', left: 0, zIndex: 10,
                                        background: 'var(--dropdown-bg)', border: '1px solid var(--dropdown-border)', borderRadius: '4px',
                                        padding: '0.5rem', minWidth: '200px', maxHeight: '300px', overflowY: 'auto',
                                        boxShadow: '0 4px 6px -1px var(--shadow-color)',
                                        color: 'var(--foreground)'
                                    }}>
                                        <label style={{ display: 'block', marginBottom: '4px', cursor: 'pointer' }}>
                                            <input type="checkbox"
                                                checked={selectedDrillDownModels.length === 0}
                                                onChange={() => setSelectedDrillDownModels([])}
                                            /> <span style={{ marginLeft: '4px' }}>{t('dashboard.allModels')}</span>
                                        </label>
                                        <hr style={{ borderColor: 'var(--border)', margin: '4px 0' }} />
                                        {drillDownAvailableModels.map(m => (
                                            <label key={m} style={{ display: 'block', marginBottom: '4px', cursor: 'pointer' }}>
                                                <input type="checkbox"
                                                    checked={selectedDrillDownModels.includes(m)}
                                                    onChange={(e) => {
                                                        if (e.target.checked) {
                                                            setSelectedDrillDownModels([...selectedDrillDownModels, m]);
                                                        } else {
                                                            setSelectedDrillDownModels(selectedDrillDownModels.filter(x => x !== m));
                                                        }
                                                    }}
                                                /> <span style={{ marginLeft: '4px' }}>{m}</span>
                                            </label>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>

                    {drillDownGroupByLabel || drillDownGroupByModel ? (
                        // Grouped View for Drill Down (Label or Model)
                        <div>
                            {(drillDownGroupByLabel ? drillDownAvailableLabels : drillDownAvailableModels)
                                .filter(val => {
                                    if (drillDownGroupByLabel) {
                                        return selectedDrillDownLabels.length === 0 || selectedDrillDownLabels.includes(val);
                                    } else {
                                        return selectedDrillDownModels.length === 0 || selectedDrillDownModels.includes(val);
                                    }
                                })
                                .map(val => {
                                    // Filter Data
                                    let relevant = filteredData;
                                    if (drillDownGroupByLabel) {
                                        relevant = relevant.filter(d => (d.label || 'Other') === val);
                                    } else {
                                        relevant = relevant.filter(d => (d.model || 'Unknown') === val);
                                    }

                                    if (selectedQuery) relevant = relevant.filter(d => d.query === selectedQuery);
                                    if (selectedFramework) relevant = relevant.filter(d => d.framework === selectedFramework);

                                    if (relevant.length === 0) return null;

                                    // Calc Stats
                                    const counts = relevant.length;
                                    const avgLat = relevant.reduce((sum, d) => sum + d.latency, 0) / counts;
                                    const avgTok = Math.round(relevant.reduce((sum, d) => sum + d.tokens, 0) / counts);
                                    const recall = relevant.reduce((s, x) => s + (x.skill_trigger_rate ?? 0), 0) / counts * 100;
                                    const evaluatedRelevant = relevant.filter(d => d.answer_score !== null);
                                    const avgSc = evaluatedRelevant.length ? (evaluatedRelevant.reduce((sum, d) => sum + (d.answer_score || 0), 0) / evaluatedRelevant.length) : 0;
                                    const withMetric = relevant.filter(d => hasMetricValue(d, bestWorstMetric));
                                    const best = withMetric.length > 0 ? [...withMetric].sort((a, b) => {
                                        const va = getMetricValue(a, bestWorstMetric);
                                        const vb = getMetricValue(b, bestWorstMetric);
                                        return isMetricLowerBetter(bestWorstMetric) ? va - vb : vb - va;
                                    })[0] : null;
                                    const worst = withMetric.length > 0 ? [...withMetric].sort((a, b) => {
                                        const va = getMetricValue(a, bestWorstMetric);
                                        const vb = getMetricValue(b, bestWorstMetric);
                                        return isMetricLowerBetter(bestWorstMetric) ? vb - va : va - vb;
                                    })[0] : null;
                                    const groupWithCost = relevant.filter(d => d.cost != null);
                                    const groupAvgCost = groupWithCost.length ? groupWithCost.reduce((sum, d) => sum + (d.cost || 0), 0) / groupWithCost.length : null;

                                    // Calculate CPSR for grouped view
                                    const groupCpsr = calculateCPSR(relevant);

                                    // Calculate Skill Lift for grouped view (only for current label)
                                    let skillLiftMetrics: SkillLiftResult | null = null;
                                    if (drillDownGroupByLabel && selectedQuery && val !== 'without-skill' && val !== 'Other') {
                                        let queryData = filteredData.filter(d => d.query === selectedQuery);
                                        if (selectedFramework) {
                                            queryData = queryData.filter(d => d.framework === selectedFramework);
                                        }
                                        skillLiftMetrics = calculateSkillLift(queryData, val);
                                    }

                                    return (
                                        <div key={val} style={{ marginBottom: '2rem' }}>
                                            <div style={{ marginBottom: '0.5rem' }}>
                                                <h3 style={{ margin: 0, color: c.primary, fontSize: '1.1rem' }}>
                                                    {drillDownGroupByLabel ? `${t('dashboard.table.label')}: ` : `${t('dashboard.table.model')}: `} {val}
                                                </h3>
                                            </div>
                                            <div className="ai-grid-layout"style={{display: 'grid',
                                                                        gridTemplateColumns: 'repeat(4, 1fr)',
                                                                        gap: '1rem',
                                                                        }}>
                                                {/* Stats Card */}
                                                <div className="card" style={{ gridColumn: 'span 2' }}>
                                                    <div className="card-title">
                                                        {t('dashboard.avgPerformance')}
                                                        <span style={{ fontSize: '0.85rem', color: c.fgMuted, fontWeight: 'normal', marginLeft: '8px' }}>
                                                            ({t('dashboard.basedOnRecords', { count: counts.toString() })})
                                                        </span>
                                                    </div>
                                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '1rem', textAlign: 'center' }}>
                                                        <div>
                                                            <div className="text-sm text-slate-400">平均时延</div>
                                                            <div className="text-xl font-bold">{formatLatency(avgLat)}</div>
                                                        </div>
                                                        <div>
                                                            <div className="text-sm text-slate-400">平均 Token</div>
                                                            <div className="text-xl font-bold">{formatTokens(avgTok)}</div>
                                                        </div>
                                                        <div>
                                                            <div className="text-sm text-slate-400">平均准确率</div>
                                                            <div className="text-xl font-bold" style={{ color: avgSc > 0.8 ? '#4ade80' : '#fbbf24' }}>{avgSc.toFixed(2)}</div>
                                                        </div>
                                                        <div>
                                                            <div className="text-sm text-slate-400">{t('metrics.avgCost')} <CustomTooltip content={t('dashboard.tooltip.avgCostDetailed')} /></div>
                                                            <div className="text-xl font-bold" style={groupAvgCost == null ? { color: c.fgSecondary } : {}}>{groupAvgCost != null ? formatCost(groupAvgCost) : 'N/A'}</div>
                                                        </div>
                                                        <div>
                                                            <div className="text-sm text-slate-400">{t('metrics.cpsr')} <CustomTooltip content={t('dashboard.tooltip.cpsrDetailed')} /></div>
                                                            <div className="text-xl font-bold" style={{ color: groupCpsr != null ? '#38bdf8' : '#64748b' }}>{groupCpsr != null ? formatCost(groupCpsr) : 'N/A'}</div>
                                                        </div>
                                                    </div>
                                                </div>
                                                {/* Best/Worst */}
                                                {best && worst ? (
                                                <>
                                                <div className="card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                                                    <div>
                                                        <div className="card-title text-green-400" style={{ fontSize: '0.85rem' }}>{t('metrics.best')}（{isMetricLowerBetter(bestWorstMetric) ? t('dashboard.drillDown.bestRecord') : t('dashboard.drillDown.worstRecord')} {getMetricLabel(bestWorstMetric, t)}）</div>
                                                        <div className="text-xl font-bold">{getMetricFormattedValue(best, bestWorstMetric)}</div>
                                                        <div className="text-sm text-slate-400 mt-2" style={{ fontSize: '0.75rem' }}>
                                                            Token: {formatTokens(best.tokens)} | Score: {best.answer_score?.toFixed(2) || '-'} <br />
                                                            Cost: {formatCost(best.cost) || '-'} | Latency: {formatLatency(best.latency)}
                                                        </div>
                                                    </div>
                                                    <div style={{ fontSize: '0.75rem', color: c.primary, cursor: 'pointer', marginTop: '0.5rem', textAlign: 'right' }} onClick={() => {
                                                        const url = `${basePath}/details?framework=${encodeURIComponent(best.framework)}&expandTaskId=${best.task_id || best.upload_id}`;
                                                        window.open(url, '_blank');
                                                    }}>{t('common.view')} &gt;</div>
                                                </div>
                                                <div className="card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                                                    <div>
                                                        <div className="card-title text-red-400" style={{ fontSize: '0.85rem' }}>{t('metrics.worst')}（{isMetricLowerBetter(bestWorstMetric) ? t('dashboard.drillDown.worstRecord') : t('dashboard.drillDown.bestRecord')} {getMetricLabel(bestWorstMetric, t)}）</div>
                                                        <div className="text-xl font-bold">{getMetricFormattedValue(worst, bestWorstMetric)}</div>
                                                        <div className="text-sm text-slate-400 mt-2" style={{ fontSize: '0.75rem' }}>
                                                            Token: {formatTokens(worst.tokens)} | Score: {worst.answer_score?.toFixed(2) || '-'} <br />
                                                            Cost: {formatCost(worst.cost) || '-'} | Latency: {formatLatency(worst.latency)}
                                                        </div>
                                                    </div>
                                                    <div style={{ fontSize: '0.75rem', color: c.primary, cursor: 'pointer', marginTop: '0.5rem', textAlign: 'right' }} onClick={() => window.open(`${basePath}/details?framework=${encodeURIComponent(worst.framework)}&expandTaskId=${worst.task_id || worst.upload_id}`, '_blank')}>{t('common.view')} &gt;</div>
                                                </div>
                                                </>
                                                ) : (
                                                <div className="card" style={{ textAlign: 'center', padding: '1rem', color: c.fgMuted, fontSize: '0.85rem' }}>
                                                    该指标暂无有效数据
                                                </div>
                                                )}
                                                {/*Skill Lift*/}
                                                {drillDownGroupByLabel && skillLiftMetrics !== null && (
                                                <div className="card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                                                    <div>
                                                        <div className="card-title text-purple-400" style={{ fontSize: '0.85rem' }}>
                                                            {t('dashboard.drillDown.skillLift')}
                                                            <CustomTooltip content={t('dashboard.drillDown.skillLiftTooltip')} />
                                                        </div>
                                                        <div style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>
                                                            <div style={{ marginBottom: '0.5rem' }}>
                                                                <div style={{
                                                                    fontSize: '1.2rem',
                                                                    fontWeight: 'bold',
                                                                    color: skillLiftMetrics.valuePct == null
                                                                        ? '#a1a1aa'
                                                                        : skillLiftMetrics.valuePct > 0
                                                                            ? '#4ade80'
                                                                            : skillLiftMetrics.valuePct < 0
                                                                                ? '#f87171'
                                                                                : '#a1a1aa'
                                                                }}>
                                                                    {skillLiftMetrics.valuePct == null
                                                                        ? 'N/A'
                                                                        : `${skillLiftMetrics.valuePct > 0 ? '+' : ''}${skillLiftMetrics.valuePct.toFixed(2)}%`}
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                        <div style={{ fontSize: '0.75rem', color: c.fgSecondary }}>
                                                        {t('dashboard.drillDown.currentSuccessRate')}：{skillLiftMetrics.passSkill == null ? 'N/A' : `${(skillLiftMetrics.passSkill * 100).toFixed(1)}%`}
                                                        <br />
                                                        {t('dashboard.drillDown.baselineSuccessRate')}：{skillLiftMetrics.passNoSkill == null ? 'N/A' : `${(skillLiftMetrics.passNoSkill * 100).toFixed(1)}%`}
                                                    </div>
                                                        <div style={{ fontSize: '0.75rem', color: c.fgSecondary, marginTop: '0.5rem', textAlign: 'left', whiteSpace: 'pre-wrap' }}>
                                                        {skillLiftMetrics.reason || t('dashboard.drillDown.basedOnBaseline')}
                                                        </div>
                                                </div>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                        </div>
                    ) : (
                        singleQueryStats ? (
                            <div className="ai-grid-layout">
                                {/* Stats Card */}
                                <div className="card" style={{ gridColumn: 'span 2' }}>
                                    <div className="card-title">
                                        {t('dashboard.avgPerformance')}
                                        <span style={{ fontSize: '0.9rem', color: c.fgMuted, fontWeight: 'normal', marginLeft: '8px' }}>
                                            ({t('dashboard.basedOnRecords', { count: singleQueryStats.count.toString() })})
                                        </span>
                                    </div>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '1rem', textAlign: 'center' }}>
                                        <div>
                                            <div style={{ fontSize: '0.875rem', color: c.fgMuted }}>{t('metrics.avgLatency')}</div>
                                            <div style={{ fontSize: '1.25rem', fontWeight: 700, color: c.fg }}>{formatLatency(singleQueryStats.avgLatency)}</div>
                                        </div>
                                        <div>
                                            <div style={{ fontSize: '0.875rem', color: c.fgMuted }}>{t('metrics.avgTokens')}</div>
                                            <div style={{ fontSize: '1.25rem', fontWeight: 700, color: c.fg }}>{formatTokens(singleQueryStats.avgTokens)}</div>
                                        </div>
                                        <div>
                                            <div style={{ fontSize: '0.875rem', color: c.fgMuted }}>{t('metrics.avgSkillTrigger')}</div>
                                            <div style={{ fontSize: '1.25rem', fontWeight: 700, color: c.fg }}>{singleQueryStats.querySkillRecallRate?.toFixed(2)}%</div>
                                        </div>
                                        <div>
                                            <div style={{ fontSize: '0.875rem', color: c.fgMuted }}>{t('metrics.avgAccuracy')}</div>
                                            <div style={{ fontSize: '1.25rem', fontWeight: 700, color: singleQueryStats.avgAnsScore > 0.8 ? c.success : c.warning }}>{singleQueryStats.avgAnsScore.toFixed(2)}</div>
                                        </div>
                                        <div>
                                            <div style={{ fontSize: '0.875rem', color: c.fgMuted }}>{t('metrics.avgCost')} <CustomTooltip content={t('dashboard.tooltip.avgCostDetailed')} /></div>
                                            <div style={{ fontSize: '1.25rem', fontWeight: 700, color: c.fg, ...singleQueryStats.avgCost == null ? { color: c.fgSecondary } : {} }}>{singleQueryStats.avgCost != null ? formatCost(singleQueryStats.avgCost) : 'N/A'}</div>
                                        </div>
                                        <div>
                                            <div style={{ fontSize: '0.875rem', color: c.fgMuted }}>{t('metrics.cpsr')}<CustomTooltip content={t('dashboard.tooltip.cpsrDetailed')} /></div>
                                            <div style={{ fontSize: '1.25rem', fontWeight: 700, color: singleQueryStats.cpsr != null ? c.primary : c.fgSecondary }}>{singleQueryStats.cpsr != null ? formatCost(singleQueryStats.cpsr) : 'N/A'}</div>
                                        </div>
                                    </div>

                                </div>
                                {/* Best/Worst */}
                                {singleQueryStats.best && singleQueryStats.worst ? (
                                (() => {
                                    const bestRecord = singleQueryStats.best;
                                    const worstRecord = singleQueryStats.worst;
                                    return (
                                <>
                                <div className="card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                                    <div>
                                        <div className="card-title text-green-400">{t('metrics.best')}（{isMetricLowerBetter(bestWorstMetric) ? t('dashboard.drillDown.bestRecord') : t('dashboard.drillDown.worstRecord')} {getMetricLabel(bestWorstMetric, t)}）</div>
                                        <div className="text-2xl font-bold">{getMetricFormattedValue(bestRecord, bestWorstMetric)}</div>
                                        <div className="text-sm text-slate-400 mt-2">
                                            Token: {formatTokens(bestRecord.tokens)} | Cost: {formatCost(bestRecord.cost) || '-'} | Latency: {formatLatency(bestRecord.latency)} <br />
                                            Time: {formatDateTime(bestRecord.timestamp)}
                                        </div>
                                    </div>
                                    <div style={{ fontSize: '0.8rem', color: c.primary, cursor: 'pointer', marginTop: '0.5rem', textAlign: 'right' }} onClick={() => {
                                        window.open(`${basePath}/details?framework=${encodeURIComponent(bestRecord.framework)}&expandTaskId=${bestRecord.task_id || bestRecord.upload_id}`, '_blank');
                                    }}>{t('common.view')} &gt;</div>
                                </div>
                                <div className="card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                                    <div>
                                        <div className="card-title text-red-400">{t('metrics.worst')}（{isMetricLowerBetter(bestWorstMetric) ? t('dashboard.drillDown.worstRecord') : t('dashboard.drillDown.bestRecord')} {getMetricLabel(bestWorstMetric, t)}）</div>
                                        <div className="text-2xl font-bold">{getMetricFormattedValue(worstRecord, bestWorstMetric)}</div>
                                        <div className="text-sm text-slate-400 mt-2">
                                            Token: {formatTokens(worstRecord.tokens)} | Cost: {formatCost(worstRecord.cost) || '-'} | Latency: {formatLatency(worstRecord.latency)} <br />
                                            Time: {formatDateTime(worstRecord.timestamp)}
                                        </div>
                                    </div>
                                    <div style={{ fontSize: '0.8rem', color: c.primary, cursor: 'pointer', marginTop: '0.5rem', textAlign: 'right' }} onClick={() => {
                                        const url = `${basePath}/details?framework=${encodeURIComponent(worstRecord.framework)}&expandTaskId=${worstRecord.task_id || worstRecord.upload_id}`;
                                        window.open(url, '_blank');
                                    }}>{t('common.view')} &gt;</div>
                                </div>
                                </>
                                    );
                                })()
                                ) : (
                                <div className="card" style={{ textAlign: 'center', padding: '2rem', color: c.fgMuted }}>
                                    {t('common.noData')}
                                </div>
                                )}
                            </div>
                        ) : (
                            <div className="card" style={{ textAlign: 'center', padding: '2rem', color: c.fgMuted }}>
                                {selectedQuery ? t('dashboard.noDataForCombination') : t('dashboard.selectQueryPrompt')}
                            </div>
                        )
                    )}

                    {/* 4. Records Table */}
                    <h2 className="section-title">{t('metrics.record')}</h2>

                    {/* Table Filters */}
                    <div className="analysis-controls" style={{ marginBottom: '1rem' }}>
                        <MultiSelectDropdown
                            value={tableFrameworks}
                            options={allFrameworks}
                            placeholder={t('dashboard.table.allFrameworks')}
                            onChange={setTableFrameworks}
                        />

                        <MultiSelectDropdown
                            value={tableLabels}
                            options={allLabels}
                            placeholder={t('dashboard.table.allLabels')}
                            onChange={setTableLabels}
                        />

                        <MultiSelectDropdown
                            value={tableModels}
                            options={allModels}
                            placeholder={t('dashboard.table.allModels')}
                            onChange={setTableModels}
                        />

                        <input
                            type="text"
                            placeholder={t('dashboard.table.filterPlaceholder')}
                            value={tableQuery}
                            onChange={e => setTableQuery(e.target.value)}
                            style={{ padding: '0.5rem', background: 'var(--input-bg)', border: '1px solid var(--input-border)', borderRadius: '4px', color: 'var(--foreground)', minWidth: '250px' }}
                        />

                        <span style={{ marginLeft: 'auto', color: 'var(--foreground-secondary)', fontSize: '0.9rem' }}>
                            {t('dashboard.table.totalRecords', { count: tableFilteredData.length.toString() })}
                        </span>
                    </div>

                    <div className="card table-container" style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead style={{ textAlign: 'left', color: 'var(--foreground-secondary)', borderBottom: '1px solid var(--border)' }}>
                                <tr>
                                    <th className="p-2" style={{ whiteSpace: 'nowrap', width: '130px' }}>{t('dashboard.table.timestamp')}</th>
                                    <th className="p-2" style={{ whiteSpace: 'nowrap', width: '90px' }}>{t('dashboard.table.framework')}</th>
                                    <th className="p-2" style={{ whiteSpace: 'nowrap', maxWidth: '200px' }}>{t('dashboard.table.userInput')}</th>
                                    <th className="p-2" style={{ whiteSpace: 'nowrap', width: '100px' }}><span>{t('dashboard.table.latency')} <CustomTooltip content={t('dashboard.tooltip.totalLatency')} /></span></th>
                                    <th className="p-2" style={{ whiteSpace: 'nowrap', width: '80px' }}><span>{t('dashboard.table.tokens')} <CustomTooltip content={t('dashboard.tooltip.totalTokens')} /></span></th>
                                    <th className="p-2" style={{ whiteSpace: 'nowrap', width: '80px' }}><span>{t('metrics.accuracy')} <CustomTooltip content={<div>{t('dashboard.tooltip.accuracyDetailed')}</div>} /></span></th>
                                    <th className="p-2" style={{ whiteSpace: 'nowrap', width: '90px' }}><span>{t('dashboard.table.estimatedCost')} <CustomTooltip content={t('dashboard.tooltip.estimatedCost')} /></span></th>
                                    <th className="p-2" style={{ whiteSpace: 'nowrap', width: '100px' }}>{t('dashboard.table.model')}</th>
                                    <th className="p-2" style={{ whiteSpace: 'nowrap', width: '90px' }}>{t('dashboard.table.label')}</th>
                                    <th className="p-2" style={{ whiteSpace: 'nowrap', width: '120px' }}>{t('dashboard.table.actions')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {currentTableData.map((row, i) => {
                                    const recordId = row.task_id || row.upload_id || '';
                                    const vDiff = versionDiffMap.get(recordId);
                                    return (
                                        <tr key={i} style={{ borderBottom: '1px solid var(--table-row-border)' }}>
                                            <td className="p-2" style={{ fontSize: '0.85rem', whiteSpace: 'nowrap' }}>{formatDateTime(row.timestamp)}</td>
                                            <td className="p-2" style={{ whiteSpace: 'nowrap' }}>{row.framework}</td>
                                            <td className="p-2" title={row.query} style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.query.length > 40 ? row.query.substring(0, 40) + '...' : row.query}</td>
                                            <td className="p-2" style={{ whiteSpace: 'nowrap' }}>{formatLatency(row.latency)}{vDiff && formatDiff(vDiff.latencyDiff, true, isDark)}</td>
                                            <td className="p-2" style={{ whiteSpace: 'nowrap' }} title={
                                                row.reasoning_tokens
                                                    ? `Output: ${formatTokens(row.output_tokens || 0)} (Reasoning: ${formatTokens(row.reasoning_tokens)}, Response: ${formatTokens((row.output_tokens || 0) - row.reasoning_tokens)})` + (row.input_tokens ? `\nInput: ${formatTokens(row.input_tokens)}` : '')
                                                    : (row.input_tokens || row.output_tokens) ? `Input: ${formatTokens(row.input_tokens || 0)}, Output: ${formatTokens(row.output_tokens || 0)}` : undefined
                                            }>{formatTokens(row.tokens)}{vDiff && formatDiff(vDiff.tokenDiff, true, isDark)}</td>
                                            <td className="p-2" style={{ whiteSpace: 'nowrap' }}>
                                                <span style={{ color: row.answer_score === null ? 'var(--foreground-muted)' : ((row.answer_score || 0) > 0.8 ? 'var(--success)' : 'var(--error)'), fontWeight: 'bold' }}>
                                                    {row.answer_score === null ? '--' : (row.answer_score || 0).toFixed(2)}
                                                </span>
                                                {vDiff && formatDiff(vDiff.accuracyDiff, false, isDark)}
                                            </td>
                                            <td className="p-2" style={{ fontSize: '0.85rem', whiteSpace: 'nowrap' }} title={
                                                row.cost != null && row.cost_pricing
                                                    ? ((row.cache_read_input_tokens || row.cache_creation_input_tokens)
                                                        ? `Cost = base_input × $${row.cost_pricing.inputTokenPrice}/M + cache_read × $${row.cost_pricing.cacheReadInputTokenPrice}/M + cache_create × $${row.cost_pricing.cacheCreationInputTokenPrice}/M + output × $${row.cost_pricing.outputTokenPrice}/M`
                                                        : `Cost = input_tokens × $${row.cost_pricing.inputTokenPrice}/M + output_tokens × $${row.cost_pricing.outputTokenPrice}/M`)
                                                        + (row.model ? ` (${row.model})` : '') + `. Estimated from ${row.cost_pricing.source === 'custom' ? 'custom' : 'default'} pricing.`
                                                    : undefined
                                            }>
                                                {row.cost != null
                                                    ? formatCost(row.cost)
                                                    : (row.tokens ? <span style={{ color: 'var(--foreground-muted)' }}>N/A</span> : '-')
                                                }
                                                {vDiff && formatDiff(vDiff.costDiff, true, isDark)}
                                            </td>
                                            <td className="p-2" style={{ fontSize: '0.85rem', whiteSpace: 'nowrap' }}>{row.model || '-'}</td>

                                            <td className="p-2">
                                                {editingLabelId === recordId ? (
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                                        <input
                                                            value={tempLabelValue}
                                                            onChange={e => setTempLabelValue(e.target.value)}
                                                            style={{ width: '80px', padding: '2px 4px', fontSize: '0.8rem', background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--foreground)' }}
                                                        />
                                                        <button onClick={() => handleUpdateLabel(row, tempLabelValue)} style={{ color: 'var(--success)', background: 'none', border: 'none', cursor: 'pointer' }}>✓</button>
                                                        <button onClick={() => setEditingLabelId(null)} style={{ color: 'var(--error)', background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
                                                    </div>
                                                ) : (
                                                    <div
                                                        style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}
                                                        onClick={() => {
                                                            if (recordId) {
                                                                setEditingLabelId(recordId);
                                                                setTempLabelValue(row.label || '');
                                                            }
                                                        }}
                                                    >
                                                        {row.label ? <span style={{ padding: '2px 6px', background: 'var(--background-secondary)', borderRadius: '4px', fontSize: '0.8rem', border: '1px solid var(--border)' }}>{row.label}</span> : <span style={{ color: 'var(--foreground-muted)' }}>-</span>}
                                                        <span style={{ fontSize: '0.7rem', color: 'var(--foreground-muted)', opacity: 0.5 }}>✎</span>
                                                    </div>
                                                )}
                                            </td>
                                            <td className="p-2">
                                                <div style={{ display: 'flex', gap: '8px', whiteSpace: 'nowrap' }}>
                                                    <button onClick={() => {
                                                        const url = `${basePath}/details?framework=${encodeURIComponent(row.framework)}&expandTaskId=${recordId}`;
                                                        window.open(url, '_blank');
                                                    }} className="btn-sm" style={{ background: 'var(--primary)' }}>
                                                        {t('dashboard.table.detail')}
                                                    </button>
                                                    <button
                                                        onClick={() => handleRejudge(row)}
                                                        className="btn-sm"
                                                        title={row.is_evaluating || rejudgingIds.has(recordId) ? '点击取消当前评估' : '重新评估'}
                                                        style={{
                                                            background: row.is_evaluating || rejudgingIds.has(recordId) ? 'var(--foreground-muted)' : 'var(--warning)',
                                                            color: '#ffffff',
                                                            cursor: 'pointer',
                                                            display: 'inline-flex',
                                                            alignItems: 'center',
                                                            gap: '4px',
                                                            opacity: row.is_evaluating || rejudgingIds.has(recordId) ? 0.7 : 1
                                                        }}
                                                    >
                                                        {row.is_evaluating || rejudgingIds.has(recordId) ? (
                                                            <>
                                                                <span style={{
                                                                    width: '12px',
                                                                    height: '12px',
                                                                    border: '2px solid #18181b',
                                                                    borderTopColor: 'transparent',
                                                                    borderRadius: '50%',
                                                                    animation: 'spin 1s linear infinite',
                                                                    display: 'inline-block'
                                                                }}></span>
                                                                <span>{t('dashboard.table.evaluating')}</span>
                                                            </>
                                                        ) : (
                                                            t('dashboard.table.rejudge')
                                                        )}
                                                    </button>
                                                    <button onClick={() => handleDelete(row)} className="btn-sm" style={{ background: c.error }}>
                                                        {t('dashboard.table.delete')}
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                    {/* Pagination Controls */}
                    {totalTablePages > 1 && (
                        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', marginTop: '1rem', gap: '1rem' }}>
                            <button
                                className="btn-sm"
                                disabled={tablePage === 1}
                                onClick={() => setTablePage(p => Math.max(1, p - 1))}
                                style={{ background: tablePage === 1 ? '#334155' : '#38bdf8', color: tablePage === 1 ? '#a1a1aa' : '#18181b', cursor: tablePage === 1 ? 'not-allowed' : 'pointer' }}
                            >
                                &lt; Prev
                            </button>
                            <span style={{ color: c.fgMuted }}>
                                Page {tablePage} of {totalTablePages}
                            </span>
                            <button
                                className="btn-sm"
                                disabled={tablePage === totalTablePages}
                                onClick={() => setTablePage(p => Math.min(totalTablePages, p + 1))}
                                style={{ background: tablePage === totalTablePages ? '#334155' : '#38bdf8', color: tablePage === totalTablePages ? '#a1a1aa' : '#18181b', cursor: tablePage === totalTablePages ? 'not-allowed' : 'pointer' }}
                            >
                                Next &gt;
                            </button>
                        </div>
                    )}

                    <div style={{ marginTop: '2rem', marginBottom: '0.5rem', height: '1px', background: 'linear-gradient(to right, transparent, rgba(56, 189, 248, 0.5), transparent)' }}></div>

                    {/* Promotion Section */}
                    <div style={{ marginTop: '0.5rem', padding: '0.5rem', textAlign: 'center' }}>
                        <p style={{ margin: 0, fontSize: '0.9rem', color: c.fgMuted, lineHeight: 1.6 }}>
                            <a href="https://atomgit.com/openeuler/witty-skill-insight" target="_blank" rel="noopener noreferrer" style={{ color: c.fgMuted, textDecoration: 'underline', textUnderlineOffset: '3px' }}>
                                {t('dashboard.promotion')}
                            </a>
                        </p>
                    </div>
                </>
            )}

            {/* CONFIG TAB */}
            {activeTab === 'config' && (
                <div className="config-container">
                    <div style={{ marginBottom: '1rem' }}>
                        <h2 className="section-title" style={{ marginBottom: '0.35rem' }}>数据集管理</h2>
                        <p style={{ margin: 0, color: '#94a3b8', fontSize: '0.9rem', lineHeight: 1.7 }}>
                            将 Skill 召回率评测与 Skill 执行效果评测拆成两条独立数据链路。新建数据时建议分别维护，历史混合数据会以“兼容旧数据”的形式保留。
                        </p>
                    </div>
                    <div
                        style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
                            gap: '16px',
                            alignItems: 'start',
                        }}
                    >
                        {renderConfigSection(
                            'routing',
                            'Skill 召回率数据集',
                            '只定义某个问题应该命中哪些 Skill / 版本，用于计算 is_skill_correct 与 skill_trigger_rate。',
                            routingConfigs,
                            '#38bdf8',
                            '+ 新增 Skill 召回率数据项',
                            '暂无 Skill 召回率评测数据，添加后即可开始评估 Skill 是否被正确召回。'
                        )}
                        {renderOutcomeConfigGroupSection(
                            'Skill 执行效果数据集',
                            '按 Skill / 版本聚合管理执行效果评测集。点进单个评测集后，可以切换不同业务场景；关键动作在同一 Skill / 版本下共享，关键观点按场景分别维护。',
                            outcomeConfigGroups,
                            '#a78bfa',
                            '+ 新增 Skill 执行效果数据项',
                            '暂无 Skill 执行效果数据，添加后即可开始评估该 Skill 的回答质量与执行动作。'
                        )}
                    </div>
                </div>
            )}

            {/* SKILL MANAGEMENT TAB */}
            {activeTab === 'skill' && (
                <SkillRegistry />
            )}


            {/* MODALS */}
            {/* 1. Config Edit Modal */}
            {isEditModalOpen && (
                <div className="modal-overlay" onClick={closeConfigModal}>
                    <div className="modal-content card" onClick={e => e.stopPropagation()} style={{ maxHeight: '90vh', overflowY: 'auto', maxWidth: '900px', width: '66vw', minWidth: '500px', flexDirection: 'column' }}>
                        <h3>{configModalTitle}</h3>

                        <div style={{ marginBottom: '1rem', padding: '12px 14px', borderRadius: '10px', background: c.bgTertiary, border: `1px solid ${c.border}`, color: c.fgMuted, fontSize: '0.85rem', lineHeight: 1.7 }}>
                            {modalEditingType === 'routing' && '该数据项只参与 Skill 召回率评测。这里只看语义意图与预期 Skill，不看标准答案、关键观点或执行动作。'}
                            {modalEditingType === 'outcome' && '该数据项只参与 Skill 执行效果评测。这里关注命中该 Skill 后的最终回答质量、关键观点与关键动作，不参与 Skill 路由命中判断。'}
                            {modalEditingType === 'combined' && '这是历史兼容的混合数据项，同时包含 Skill 召回率与执行效果评测信息。后续建议逐步拆成两条独立数据。'}
                        </div>

                        {isRoutingEditor && !editingConfig.id && (
                            <div className="form-group">
                                <label style={{ fontWeight: 600, fontSize: '0.95rem', color: c.fg }}>问题（Query）<span style={{ color: c.error }}>*</span></label>
                                <textarea
                                    value={editingConfig.query || ''}
                                    onChange={e => setEditingConfig({ ...editingConfig, query: e.target.value })}
                                    placeholder="请输入需要评估 Skill 召回率的问题..."
                                    style={{ width: '100%', padding: '10px', minHeight: '60px', background: c.bg, border: `1px solid ${c.border}`, color: c.fg, borderRadius: '6px', fontSize: '0.95rem' }}
                                />
                            </div>
                        )}

                        {isRoutingEditor && (
                            <div className="form-group" style={{ marginTop: '1rem' }}>
                                <label style={{ fontWeight: 600, fontSize: '0.95rem', color: c.fg }}>
                                    预期 Skill <span style={{ color: c.error }}>*</span>
                                </label>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                    {(editingConfig.expectedSkills || []).map((item, index) => (
                                        <div key={index} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                            <input
                                                type="text"
                                                value={item.skill}
                                                onChange={e => {
                                                    const newSkills = [...(editingConfig.expectedSkills || [])];
                                                    newSkills[index] = { ...newSkills[index], skill: e.target.value };
                                                    setEditingConfig({ ...editingConfig, expectedSkills: newSkills });
                                                }}
                                                placeholder="Skill 名称"
                                                style={{ flex: 2, padding: '10px', background: c.bg, border: `1px solid ${c.border}`, color: c.fg, borderRadius: '6px', fontSize: '0.95rem' }}
                                            />
                                            <input
                                                type="number"
                                                value={item.version ?? ''}
                                                onChange={e => {
                                                    const value = e.target.value;
                                                    const newSkills = [...(editingConfig.expectedSkills || [])];
                                                    newSkills[index] = {
                                                        ...newSkills[index],
                                                        version: value === '' ? null : Math.max(0, parseInt(value, 10) || 0)
                                                    };
                                                    setEditingConfig({ ...editingConfig, expectedSkills: newSkills });
                                                }}
                                                placeholder="版本号（留空表示任意版本）"
                                                style={{ flex: 1, padding: '10px', background: c.bg, border: `1px solid ${c.border}`, color: c.fg, borderRadius: '6px', fontSize: '0.95rem' }}
                                            />
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    const newSkills = (editingConfig.expectedSkills || []).filter((_, i) => i !== index);
                                                    setEditingConfig({ ...editingConfig, expectedSkills: newSkills });
                                                }}
                                                style={{ padding: '10px', background: c.errorSubtle, color: c.error, border: 'none', borderRadius: '6px', cursor: 'pointer' }}
                                            >
                                                ✕
                                            </button>
                                        </div>
                                    ))}
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const newSkills = [...(editingConfig.expectedSkills || []), { skill: '', version: null }];
                                            setEditingConfig({ ...editingConfig, expectedSkills: newSkills });
                                        }}
                                        style={{ padding: '8px', background: c.primarySubtle, color: c.primary, border: `1px dashed ${c.primary}`, borderRadius: '6px', cursor: 'pointer', fontSize: '0.85rem' }}
                                    >
                                        + 添加预期 Skill
                                    </button>
                                </div>
                                <div style={{ marginTop: '8px', color: c.fgSecondary, fontSize: '0.8rem' }}>
                                    Skill 版本请填写实际版本号，例如 `0` 表示 `v0`；留空表示任意版本均可命中。
                                </div>
                            </div>
                        )}

                        {isRoutingEditor && editingConfig.id && (
                            <>
                                <div style={{ marginTop: '1rem', padding: '12px 16px', background: c.primarySubtle, border: '1px solid rgba(56, 189, 248, 0.2)', borderRadius: '8px', color: c.fgMuted, fontSize: '0.85rem', lineHeight: 1.7 }}>
                                    <div><strong style={{ color: c.fg }}>语义意图：</strong> {editingConfig.routing_intent || '待提取'}</div>
                                    <div style={{ marginTop: '6px' }}>
                                        <strong style={{ color: c.fg }}>语义锚点：</strong> {(editingConfig.routing_anchors && editingConfig.routing_anchors.length > 0)
                                            ? editingConfig.routing_anchors.join(', ')
                                            : '待提取'}
                                    </div>
                                </div>

                                <div className="form-group" style={{ marginTop: '1rem' }}>
                                    <label style={{ fontWeight: 600, fontSize: '0.95rem', color: c.fg }}>来源问题</label>
                                    <div
                                        style={{
                                            width: '100%',
                                            padding: '10px 12px',
                                            maxHeight: '120px',
                                            overflowY: 'auto',
                                            background: c.bg,
                                            border: `1px solid ${c.border}`,
                                            color: c.fgMuted,
                                            borderRadius: '6px',
                                            fontSize: '0.88rem',
                                            lineHeight: 1.65,
                                        }}
                                    >
                                        {editingConfig.query || '--'}
                                    </div>
                                </div>
                            </>
                        )}

                        {isOutcomeEditor && (
                            <>
                                {currentOutcomeGroup && (
                                    <div
                                        style={{
                                            marginTop: '1rem',
                                            marginBottom: '0.5rem',
                                            padding: '12px 14px',
                                            borderRadius: '10px',
                                            background: c.bgTertiary,
                                            border: `1px solid ${c.border}`,
                                            display: 'flex',
                                            flexDirection: 'column',
                                            gap: '10px',
                                        }}
                                    >
                                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
                                            <div>
                                                <div style={{ color: c.fg, fontWeight: 600, fontSize: '0.92rem' }}>
                                                    当前 Skill 评测集：{formatSkillTargetLabel(currentOutcomeGroup.skill, currentOutcomeGroup.skillVersion)}
                                                </div>
                                                <div style={{ marginTop: '4px', color: c.fgMuted, fontSize: '0.82rem', lineHeight: 1.6 }}>
                                                    共 {currentOutcomeGroup.configs.length} 个业务场景，关键动作共享 {currentOutcomeGroup.sharedKeyActions.length} 项。
                                                    {currentOutcomeGroup.sharedKeyActions.length > 0
                                                        ? ` ${currentOutcomeGroup.sharedKeyActionSource === 'flow' ? '这些动作来自 Skill 流程自动抽取。' : '这些动作来自当前 Skill 版本的共享配置。'}`
                                                        : ''}
                                                    {currentOutcomeGroup.hasGenericScenario ? ' 当前包含通用基准场景。' : ' 当前尚未配置通用基准场景。'}
                                                </div>
                                                {currentOutcomeGroup.sharedControlFlowSummary.length > 0 && (
                                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }}>
                                                        {currentOutcomeGroup.sharedControlFlowSummary.map(item => (
                                                            <span
                                                                key={`modal-${item.key}`}
                                                                style={{
                                                                    padding: '2px 8px',
                                                                    borderRadius: '999px',
                                                                    background: `${item.color}20`,
                                                                    border: `1px solid ${item.color}33`,
                                                                    color: item.color,
                                                                    fontSize: '0.72rem',
                                                                    fontWeight: 600,
                                                                }}
                                                            >
                                                                {item.label} {item.count}
                                                            </span>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                            {!editingConfig.id && (
                                                <span
                                                    style={{
                                                        padding: '3px 10px',
                                                        borderRadius: '999px',
                                                        background: 'rgba(167, 139, 250, 0.16)',
                                                        border: '1px solid rgba(167, 139, 250, 0.3)',
                                                        color: '#c4b5fd',
                                                        fontSize: '0.75rem',
                                                        fontWeight: 600,
                                                    }}
                                                >
                                                    正在新增业务场景
                                                </span>
                                            )}
                                        </div>

                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                                            {currentOutcomeGroup.configs.map(config => {
                                                const isActive = editingConfig.id === config.id && activeOutcomeScenarioId === config.id;
                                                return (
                                                    <button
                                                        key={config.id}
                                                        type="button"
                                                        onClick={() => switchOutcomeScenario(config.id)}
                                                        style={{
                                                            padding: '6px 10px',
                                                            borderRadius: '999px',
                                                            border: `1px solid ${isActive ? '#38bdf8' : c.border}`,
                                                            background: isActive ? 'rgba(56, 189, 248, 0.14)' : c.bg,
                                                            color: isActive ? '#38bdf8' : c.fgSecondary,
                                                            cursor: 'pointer',
                                                            fontSize: '0.8rem',
                                                            maxWidth: '320px',
                                                            whiteSpace: 'nowrap',
                                                            overflow: 'hidden',
                                                            textOverflow: 'ellipsis',
                                                        }}
                                                        title={normalizeConfigQuery(config.query) || '通用基准'}
                                                    >
                                                        {getOutcomeScenarioLabel(config)}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                        {editingConfig.id && currentOutcomeGroup.configs.length > 1 && (
                                            <div style={{ color: c.fgSecondary, fontSize: '0.78rem', lineHeight: 1.5 }}>
                                                可在同一 Skill / 版本下切换不同业务场景；关键动作为共享项，关键观点与标准答案按场景分别查看和维护。
                                            </div>
                                        )}
                                    </div>
                                )}

                                <div className="form-group" style={{ marginTop: '1rem' }}>
                                    <label style={{ fontWeight: 600, fontSize: '0.95rem', color: c.fg }}>
                                        目标 Skill {!editingConfig.id && <span style={{ color: c.error }}>*</span>}
                                    </label>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) 160px', gap: '8px' }}>
                                        <input
                                            type="text"
                                            list="outcome-skill-options"
                                            value={editingConfig.skill || ''}
                                            onChange={e => setEditingConfig({ ...editingConfig, skill: e.target.value })}
                                            placeholder="请输入或选择目标 skill"
                                            style={{ width: '100%', padding: '10px', background: c.bg, border: `1px solid ${c.border}`, color: c.fg, borderRadius: '6px', fontSize: '0.95rem' }}
                                        />
                                        <input
                                            type="number"
                                            min={0}
                                            value={editingConfig.skillVersion ?? ''}
                                            onChange={e => setEditingConfig({
                                                ...editingConfig,
                                                skillVersion: e.target.value === '' ? null : Math.max(0, parseInt(e.target.value, 10) || 0),
                                            })}
                                            placeholder="版本号（留空表示任意版本）"
                                            style={{ width: '100%', padding: '10px', background: c.bg, border: `1px solid ${c.border}`, color: c.fg, borderRadius: '6px', fontSize: '0.95rem' }}
                                        />
                                    </div>
                                    <div style={{ marginTop: '8px', color: c.fgSecondary, fontSize: '0.8rem' }}>
                                        将执行效果基准绑定到目标 Skill；留空表示适用于任意版本，填写 `0` 则表示只适用于 `v0`。
                                    </div>
                                    <datalist id="outcome-skill-options">
                                        {availableSkills.map(skill => (
                                            <option key={skill.id} value={skill.name} />
                                        ))}
                                    </datalist>
                                </div>

                                <div className="form-group" style={{ marginTop: '1rem' }}>
                                    <label style={{ fontWeight: 600, fontSize: '0.95rem', color: c.fg }}>
                                        业务场景 / 来源问题 <span style={{ color: c.fgSecondary, fontWeight: 400 }}>（可选）</span>
                                    </label>
                                    <textarea
                                        value={editingConfig.query || ''}
                                        onChange={e => setEditingConfig({ ...editingConfig, query: e.target.value })}
                                        placeholder="可填写该 Skill 对应的具体业务问题；留空则表示该效果数据为通用基准。"
                                        style={{ width: '100%', padding: '10px', minHeight: '70px', background: c.bg, border: `1px solid ${c.border}`, color: c.fg, borderRadius: '6px', fontSize: '0.9rem' }}
                                    />
                                    <div style={{ marginTop: '8px', color: c.fgSecondary, fontSize: '0.8rem' }}>
                                        业务场景用于区分同一 Skill 在不同问题下的关键观点；不填写时，将作为该 Skill 的通用执行效果基准。
                                    </div>
                                </div>

                                <div className="form-group" style={{ marginTop: '1rem' }}>
                                    <label style={{ fontWeight: 600, fontSize: '0.95rem', color: '#e2e8f0' }}>
                                        标准答案 {!editingConfig.id && <span style={{ color: '#ef4444' }}>*</span>}
                                    </label>
                                    {!editingConfig.id && (
                                        <div style={{ display: 'flex', gap: '12px', marginBottom: '10px' }}>
                                            <button
                                                onClick={() => { setConfigAnswerMode('manual'); setConfigDocumentFile(null); }}
                                                style={{
                                                    padding: '6px 16px',
                                                    background: configAnswerMode === 'manual' ? '#38bdf8' : '#1e293b',
                                                    color: configAnswerMode === 'manual' ? '#0f172a' : '#94a3b8',
                                                    border: `1px solid ${configAnswerMode === 'manual' ? '#38bdf8' : '#334155'}`,
                                                    borderRadius: '6px',
                                                    cursor: 'pointer',
                                                    fontSize: '0.85rem',
                                                    fontWeight: configAnswerMode === 'manual' ? 600 : 400,
                                                }}
                                            >
                                                手动填写
                                            </button>
                                            <button
                                                onClick={() => setConfigAnswerMode('document')}
                                                style={{
                                                    padding: '6px 16px',
                                                    background: configAnswerMode === 'document' ? '#38bdf8' : '#1e293b',
                                                    color: configAnswerMode === 'document' ? '#0f172a' : '#94a3b8',
                                                    border: `1px solid ${configAnswerMode === 'document' ? '#38bdf8' : '#334155'}`,
                                                    borderRadius: '6px',
                                                    cursor: 'pointer',
                                                    fontSize: '0.85rem',
                                                    fontWeight: configAnswerMode === 'document' ? 600 : 400,
                                                }}
                                            >
                                                上传案例文档
                                            </button>
                                        </div>
                                    )}

                                    {editingConfig.id || configAnswerMode === 'manual' ? (
                                        <textarea
                                            value={editingConfig.standard_answer || ''}
                                            onChange={e => setEditingConfig({ ...editingConfig, standard_answer: e.target.value })}
                                            placeholder={t('dashboard.config.standardAnswerPlaceholder')}
                                            style={{ width: '100%', padding: '10px', minHeight: '150px', background: c.bg, border: `1px solid ${c.border}`, color: c.fg, borderRadius: '6px', fontSize: '0.9rem' }}
                                        />
                                    ) : (
                                        <div style={{
                                            border: `2px dashed ${c.border}`,
                                            borderRadius: '8px',
                                            padding: '2rem',
                                            textAlign: 'center',
                                            background: c.bg,
                                            cursor: 'pointer',
                                            transition: 'border-color 0.2s'
                                        }}
                                            onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = '#38bdf8'; }}
                                            onDragLeave={e => { e.currentTarget.style.borderColor = '#334155'; }}
                                            onDrop={e => {
                                                e.preventDefault();
                                                e.currentTarget.style.borderColor = '#334155';
                                                const file = e.dataTransfer.files[0];
                                                if (file) setConfigDocumentFile(file);
                                            }}
                                            onClick={() => {
                                                const input = document.createElement('input');
                                                input.type = 'file';
                                                input.accept = '.txt,.md,.markdown,.pdf';
                                                input.onchange = (e: any) => {
                                                    const file = e.target.files[0];
                                                    if (file) setConfigDocumentFile(file);
                                                };
                                                input.click();
                                            }}
                                        >
                                            {configDocumentFile ? (
                                                <div>
                                                    <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>📄</div>
                                                    <div style={{ color: c.success, fontWeight: 500 }}>{configDocumentFile.name}</div>
                                                    <div style={{ color: c.fgMuted, fontSize: '0.8rem', marginTop: '4px' }}>
                                                        {(configDocumentFile.size / 1024).toFixed(1)} KB · 点击更换文件
                                                    </div>
                                                </div>
                                            ) : (
                                                <div>
                                                    <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>📁</div>
                                                    <div style={{ color: c.fgMuted }}>{t('dashboard.config.dragUpload')}</div>
                                                    <div style={{ color: c.fgSecondary, fontSize: '0.8rem', marginTop: '4px' }}>
                                                        支持 .txt, .md, .pdf 格式
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>

                                {!editingConfig.id && (
                                    <div style={{ marginTop: '1rem', padding: '12px 16px', background: c.primarySubtle, border: '1px solid rgba(56, 189, 248, 0.2)', borderRadius: '8px', color: c.fgMuted, fontSize: '0.85rem', lineHeight: 1.7 }}>
                                        <p style={{ margin: 0 }}>
                                            保存后，系统会根据用户提供的标准答案或案例文档提取<strong style={{ color: c.fg }}>关键观点</strong>。关键观点与具体业务问题相关，属于可选项。
                                        </p>
                                        <p style={{ margin: '8px 0 0 0' }}>
                                            同时，系统会根据目标 Skill 的流程约束提取并复用<strong style={{ color: c.fg }}>关键动作</strong>。同一 Skill / 版本应共享同一套关键动作，不随业务场景变化。
                                        </p>
                                    </div>
                                )}

                                {editingConfig.id && (
                                    <>
                                        <details style={{ marginBottom: '1rem' }}>
                                    <summary style={{
                                        cursor: 'pointer',
                                        color: c.fgMuted,
                                        fontSize: '0.9rem',
                                        padding: '10px 12px',
                                        userSelect: 'none',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '8px',
                                        background: c.bgTertiary,
                                        borderRadius: '6px',
                                        border: `1px solid ${c.border}`,
                                        listStyle: 'none',
                                        transition: 'background 0.2s'
                                    }}>
                                        <span className="details-arrow" style={{ fontSize: '0.7rem', color: c.fgSecondary, transition: 'transform 0.2s', display: 'inline-block' }}>▶</span>
                                        <span style={{ fontWeight: 500 }}>关键观点（可按场景配置）</span>
                                        <span style={{ fontSize: '0.8rem', color: c.fgSecondary, marginLeft: 'auto' }}>
                                            {(editingConfig.root_causes || []).length} 项 · 点击展开
                                        </span>
                                    </summary>
                                    <div style={{ background: c.bg, padding: '10px', borderRadius: '4px', border: `1px solid ${c.border}`, marginTop: '8px' }}>
                                        <div style={{ color: c.fgSecondary, fontSize: '0.8rem', marginBottom: '10px', padding: '6px 8px', background: c.bgTertiary, borderRadius: '4px' }}>
                                            来源：从用户提供的标准答案或业务材料中提取 · 作用：评估 Agent 回答是否覆盖当前场景的关键信息
                                        </div>
                                        {(editingConfig.root_causes || []).map((item, idx) => (
                                            <div key={idx} style={{ display: 'flex', gap: '10px', marginBottom: '8px' }}>
                                                <input
                                                    placeholder={t('config.contentPlaceholder')}
                                                    value={item.content}
                                                    onChange={e => {
                                                        const newItems = [...(editingConfig.root_causes || [])];
                                                        newItems[idx].content = e.target.value;
                                                        setEditingConfig({ ...editingConfig, root_causes: newItems });
                                                    }}
                                                    style={{ flex: 1, padding: '6px', color: c.fg, background: c.inputBg, border: `1px solid ${c.inputBorder}` }}
                                                />
                                                <input
                                                    type="number"
                                                    placeholder={t('config.weightPlaceholder')}
                                                    value={item.weight}
                                                    onChange={e => {
                                                        const newItems = [...(editingConfig.root_causes || [])];
                                                        newItems[idx].weight = Number(e.target.value);
                                                        setEditingConfig({ ...editingConfig, root_causes: newItems });
                                                    }}
                                                    style={{ width: '80px', padding: '6px', color: c.fg, background: c.inputBg, border: `1px solid ${c.inputBorder}` }}
                                                />
                                                <button
                                                    onClick={() => {
                                                        const newItems = (editingConfig.root_causes || []).filter((_, i) => i !== idx);
                                                        setEditingConfig({ ...editingConfig, root_causes: newItems });
                                                    }}
                                                    style={{ color: c.error, padding: '0 8px', background: 'none', border: 'none', cursor: 'pointer' }}
                                                >
                                                    ✕
                                                </button>
                                            </div>
                                        ))}
                                        <button
                                            className="btn-sm"
                                            style={{ background: c.bgTertiary, color: c.fgSecondary, marginTop: '5px', border: `1px solid ${c.border}` }}
                                            onClick={() => setEditingConfig({
                                                ...editingConfig,
                                                root_causes: [...(editingConfig.root_causes || []), { content: '', weight: 1 }]
                                            })}
                                        >
                                            + 添加关键观点
                                        </button>
                                    </div>
                                </details>

                                <details style={{ marginBottom: '1rem' }}>
                                    <summary style={{
                                        cursor: 'pointer',
                                        color: c.fgMuted,
                                        fontSize: '0.9rem',
                                        padding: '10px 12px',
                                        userSelect: 'none',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '8px',
                                        background: c.bgTertiary,
                                        borderRadius: '6px',
                                        border: `1px solid ${c.border}`,
                                        listStyle: 'none',
                                        transition: 'background 0.2s'
                                    }}>
                                        <span className="details-arrow" style={{ fontSize: '0.7rem', color: c.fgSecondary, transition: 'transform 0.2s', display: 'inline-block' }}>▶</span>
                                        <span style={{ fontWeight: 500 }}>关键动作（同一 Skill 版本共用）</span>
                                        <span style={{ fontSize: '0.8rem', color: c.fgSecondary, marginLeft: 'auto' }}>
                                            {(editingConfig.key_actions || []).length} 项 · 点击展开
                                        </span>
                                    </summary>
                                    <div style={{ background: c.bg, padding: '10px', borderRadius: '4px', border: `1px solid ${c.border}`, marginTop: '8px' }}>
                                        <div style={{ color: c.fgSecondary, fontSize: '0.8rem', marginBottom: '10px', padding: '6px 8px', background: c.bgTertiary, borderRadius: '4px' }}>
                                            {editingConfig.extractedKeyActions && (editingConfig.extractedKeyActions as any[]).length > 0
                                                ? t('config.keyActionsSourceSkill')
                                                : t('config.keyActionsSourceAnswer')}
                                        </div>
                                        {(() => {
                                            const cfLabelMap: Record<string, { text: string; color: string }> = {
                                                'required': { text: t('config.controlFlow.required'), color: '#38bdf8' },
                                                'conditional': { text: t('config.controlFlow.conditional'), color: '#fbbf24' },
                                                'loop': { text: t('config.controlFlow.loop'), color: '#a78bfa' },
                                                'optional': { text: t('config.controlFlow.optional'), color: '#94a3b8' },
                                                'handoff': { text: t('config.controlFlow.handoff'), color: '#4ade80' },
                                            };
                                            const items = editingConfig.key_actions || [];
                                            const elements: React.ReactNode[] = [];
                                            let prevGroupId: string | undefined = undefined;

                                            for (let idx = 0; idx < items.length; idx++) {
                                                const item = items[idx];
                                                const cfType = (item as any).controlFlowType || 'required';
                                                const groupId = (item as any).groupId;
                                                const cfInfo = cfLabelMap[cfType] || cfLabelMap['required'];
                                                const isGrouped = cfType === 'conditional' || cfType === 'loop';
                                                const showGroupHeader = isGrouped && groupId && groupId !== prevGroupId;
                                                const isIndented = isGrouped && !!groupId;

                                                if (showGroupHeader) {
                                                    const groupTitle = cfType === 'conditional'
                                                        ? ((item as any).condition || t('config.controlFlow.conditional'))
                                                        : ((item as any).loopCondition || t('config.controlFlow.loop'));
                                                    elements.push(
                                                        <div key={`group-${groupId}`} style={{
                                                            display: 'flex',
                                                            alignItems: 'center',
                                                            gap: '6px',
                                                            marginBottom: '4px',
                                                            marginTop: prevGroupId ? '8px' : '0',
                                                            padding: '4px 8px',
                                                            background: `${cfInfo.color}10`,
                                                            borderRadius: '4px',
                                                            borderLeft: `3px solid ${cfInfo.color}`,
                                                        }}>
                                                            <span style={{ color: cfInfo.color, fontSize: '0.8rem', fontWeight: 500 }}>
                                                                {cfType === 'conditional' ? '⎇' : '↻'} {groupTitle}
                                                            </span>
                                                            <button
                                                                onClick={() => handleAddToGroup(groupId, cfType)}
                                                                style={{
                                                                    marginLeft: 'auto',
                                                                    padding: '2px 8px',
                                                                    background: cfInfo.color,
                                                                    color: '#fff',
                                                                    border: 'none',
                                                                    borderRadius: '3px',
                                                                    cursor: 'pointer',
                                                                    fontSize: '0.7rem',
                                                                    fontWeight: 500
                                                                }}
                                                            >
                                                                + 添加到组内
                                                            </button>
                                                        </div>
                                                    );
                                                }

                                                prevGroupId = groupId;

                                                elements.push(
                                                    <div key={idx} style={{ display: 'flex', gap: '10px', marginBottom: '8px', alignItems: 'center', paddingLeft: isIndented ? '20px' : '0' }}>
                                                        <span style={{
                                                            padding: '2px 8px',
                                                            borderRadius: '4px',
                                                            background: `${cfInfo.color}20`,
                                                            color: cfInfo.color,
                                                            fontSize: '0.75rem',
                                                            whiteSpace: 'nowrap',
                                                            minWidth: '56px',
                                                            textAlign: 'center',
                                                        }}>
                                                            {cfInfo.text}
                                                        </span>
                                                        <input
                                                            placeholder={t('config.contentPlaceholder')}
                                                            value={item.content}
                                                            onChange={e => {
                                                                const newItems = [...(editingConfig.key_actions || [])];
                                                                newItems[idx].content = e.target.value;
                                                                setEditingConfig({ ...editingConfig, key_actions: newItems });
                                                            }}
                                                            style={{ flex: 1, padding: '6px', color: c.fg, background: c.inputBg, border: `1px solid ${c.inputBorder}` }}
                                                        />
                                                        <input
                                                            type="number"
                                                            placeholder={t('config.weightPlaceholder')}
                                                            value={item.weight}
                                                            onChange={e => {
                                                                const newItems = [...(editingConfig.key_actions || [])];
                                                                newItems[idx].weight = Number(e.target.value);
                                                                setEditingConfig({ ...editingConfig, key_actions: newItems });
                                                            }}
                                                            style={{ width: '80px', padding: '6px', color: c.fg, background: c.inputBg, border: `1px solid ${c.inputBorder}` }}
                                                        />
                                                        <button
                                                            onClick={() => {
                                                                const newItems = (editingConfig.key_actions || []).filter((_, i) => i !== idx);
                                                                setEditingConfig({ ...editingConfig, key_actions: newItems });
                                                            }}
                                                            style={{ color: c.error, padding: '0 8px', background: 'none', border: 'none', cursor: 'pointer' }}
                                                        >
                                                            ✕
                                                        </button>
                                                    </div>
                                                );
                                            }

                                            return elements;
                                        })()}
                                        <div style={{ position: 'relative', display: 'inline-block', marginTop: '5px' }}>
                                            <button
                                                className="btn-sm"
                                                style={{ background: c.bgTertiary, color: c.fgSecondary, border: `1px solid ${c.border}` }}
                                                onClick={() => setShowAddMenu(!showAddMenu)}
                                            >
                                                + 添加关键动作 ▼
                                            </button>
                                            {showAddMenu && (
                                                <>
                                                    <div
                                                        style={{
                                                            position: 'fixed',
                                                            top: 0,
                                                            left: 0,
                                                            right: 0,
                                                            bottom: 0,
                                                            zIndex: 999
                                                        }}
                                                        onClick={() => setShowAddMenu(false)}
                                                    />
                                                    <div style={{
                                                        position: 'absolute',
                                                        top: '100%',
                                                        left: 0,
                                                        background: c.bg,
                                                        border: `1px solid ${c.border}`,
                                                        borderRadius: '6px',
                                                        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                                                        zIndex: 1000,
                                                        minWidth: '200px',
                                                        marginTop: '4px',
                                                        overflow: 'hidden'
                                                    }}>
                                                        {[
                                                            { type: 'required' as ControlFlowType, icon: '➕', label: '添加必选动作' },
                                                            { type: 'conditional' as ControlFlowType, icon: '⎇', label: '添加条件分支组' },
                                                            { type: 'loop' as ControlFlowType, icon: '↻', label: '添加循环组' },
                                                            { type: 'optional' as ControlFlowType, icon: '○', label: '添加可选动作' },
                                                            { type: 'handoff' as ControlFlowType, icon: '→', label: '添加衔接动作' },
                                                        ].map(({ type, icon, label }) => (
                                                            <div
                                                                key={type}
                                                                onClick={() => handleAddAction(type)}
                                                                style={{
                                                                    padding: '10px 16px',
                                                                    cursor: 'pointer',
                                                                    display: 'flex',
                                                                    alignItems: 'center',
                                                                    gap: '10px',
                                                                    transition: 'background 0.15s',
                                                                    color: c.fg,
                                                                    fontSize: '0.9rem'
                                                                }}
                                                                onMouseEnter={e => {
                                                                    e.currentTarget.style.background = c.bgSecondary;
                                                                }}
                                                                onMouseLeave={e => {
                                                                    e.currentTarget.style.background = 'transparent';
                                                                }}
                                                            >
                                                                <span style={{ fontSize: '1rem' }}>{icon}</span>
                                                                <span>{label}</span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                </details>
                                    </>
                                )}
                            </>
                        )}

                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '1.5rem', paddingTop: '1rem', borderTop: `1px solid ${c.border}` }}>
                            <button
                                onClick={closeConfigModal}
                                style={{
                                    padding: '8px 24px',
                                    background: c.bgSecondary,
                                    color: c.fgMuted,
                                    border: `1px solid ${c.border}`,
                                    borderRadius: '6px',
                                    cursor: 'pointer',
                                    fontSize: '0.9rem',
                                    fontWeight: 500,
                                    transition: 'all 0.2s'
                                }}
                            >
                                {t('common.cancel')}
                            </button>
                            {editingConfig.id && (
                                <button
                                    onClick={() => reparseConfig(editingConfig.id as string)}
                                    disabled={isSavingConfig}
                                    style={{
                                        padding: '8px 24px',
                                        background: c.warningSubtle,
                                        color: c.warning,
                                        border: `1px solid ${c.warning}`,
                                        borderRadius: '6px',
                                        cursor: isSavingConfig ? 'not-allowed' : 'pointer',
                                        fontSize: '0.9rem',
                                        fontWeight: 500,
                                        opacity: isSavingConfig ? 0.7 : 1,
                                    }}
                                >
                                    重新解析
                                </button>
                            )}
                            <button
                                onClick={saveConfig}
                                disabled={isSavingConfig}
                                style={{
                                    padding: '8px 28px',
                                    background: isSavingConfig ? '#1e3a5f' : '#38bdf8',
                                    color: isSavingConfig ? '#64748b' : '#18181b',
                                    border: 'none',
                                    borderRadius: '6px',
                                    cursor: isSavingConfig ? 'not-allowed' : 'pointer',
                                    fontSize: '0.9rem',
                                    fontWeight: 600,
                                    transition: 'all 0.2s',
                                    boxShadow: isSavingConfig ? 'none' : '0 2px 8px rgba(56, 189, 248, 0.25)'
                                }}
                            >
                                {isSavingConfig ? t('common.loading') : t('common.save')}
                            </button>
                        </div>
                    </div >
                </div >
            )}

            {/* 2. Record Detail Modal */}
            {selectedRecord && (
                <div className="modal-overlay" onClick={() => setSelectedRecord(null)}>
                    <div className="modal-content card" onClick={e => e.stopPropagation()} style={{ width: '800px', maxWidth: '95%', maxHeight: '90vh', overflowY: 'auto', overflowX: 'hidden' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                            <h3>记录详情</h3>
                            <button onClick={() => setSelectedRecord(null)} style={{ background: 'transparent', border: 'none', color: 'white', fontSize: '1.5rem', cursor: 'pointer' }}>×</button>
                        </div>

                        <div className="detail-section">
                            <h4>基本信息</h4>
                            <div className="detail-grid">
                                <div><strong>时间：</strong> {formatDateTime(selectedRecord.timestamp)}</div>
                                <div><strong>平台：</strong> {selectedRecord.framework}</div>
                                <div><strong>时延：</strong> {formatLatency(selectedRecord.latency)}{(() => {
                                    const rid = selectedRecord.upload_id || selectedRecord.task_id || '';
                                    const vd = versionDiffMap.get(rid);
                                    return vd ? formatDiff(vd.latencyDiff, true, isDark) : null;
                                })()}</div>
                                <div><strong>Token：</strong> {selectedRecord.tokens}{(() => {
                                    const rid = selectedRecord.upload_id || selectedRecord.task_id || '';
                                    const vd = versionDiffMap.get(rid);
                                    return vd ? formatDiff(vd.tokenDiff, true, isDark) : null;
                                })()}</div>
                                {(() => {
                                    const rid = selectedRecord.upload_id || selectedRecord.task_id || '';
                                    const vd = versionDiffMap.get(rid);
                                    if (!vd) return null;
                                    return (
                                        <>
                                            <div><strong>准确率变化:</strong> {formatDiff(vd.accuracyDiff, false, isDark)}</div>
                                            <div><strong>成本变化:</strong> {formatDiff(vd.costDiff, true, isDark)}</div>
                                        </>
                                    );
                                })()}
                            </div>
                        </div>

                        <div className="detail-section">
                            <h4>输入与输出</h4>
                            <div className="detail-row">
                                <strong style={{ display: 'block', marginBottom: '0.2rem', color: c.fgMuted }}>用户输入：</strong>
                                <div className="code-block">{selectedRecord.query}</div>
                            </div>
                            <div className="detail-row">
                                <strong style={{ display: 'block', marginBottom: '0.2rem', color: c.fgMuted }}>使用的 Skill：</strong>
                                <div className="code-block">
                                    <SkillLinks
                                        skills={selectedRecord.skills}
                                        skill={selectedRecord.skill}
                                        skillVersion={selectedRecord.skill_version ? parseInt(selectedRecord.skill_version) : null}
                                        user={selectedRecord.user}
                                    />
                                </div>
                            </div>
                            <div className="detail-row">
                                <strong style={{ display: 'block', marginBottom: '0.2rem', color: c.fgMuted }}>最终结果：</strong>
                                <div className="code-block" style={{ maxHeight: '200px', overflowY: 'auto' }}>{selectedRecord.final_result || '（无）'}</div>
                            </div>
                        </div>

                        <div className="detail-section">
                            <h4>评估结果</h4>
                            {(() => {
                                const routing = selectedRecord.routing_evaluation;
                                const routingMeta = getRoutingEvaluationMeta(routing);
                                const outcome = selectedRecord.outcome_evaluation;
                                const outcomeMeta = getOutcomeEvaluationMeta(outcome);

                                return (
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
                                        <div
                                            style={{
                                                borderRadius: '10px',
                                                padding: '1rem',
                                                background: routingMeta.background,
                                                border: `1px solid ${routingMeta.border}`,
                                            }}
                                        >
                                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'center', marginBottom: '0.75rem' }}>
                                                <strong style={{ color: '#e2e8f0' }}>Skill 召回率评测</strong>
                                                <span style={{ color: routingMeta.accent, fontSize: '0.8rem', fontWeight: 700 }}>{routingMeta.label}</span>
                                            </div>
                                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0.75rem', marginBottom: '0.75rem' }}>
                                                <div>
                                                    <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.2rem' }}>召回率</div>
                                                    <div style={{ color: '#f8fafc', fontWeight: 700 }}>
                                                        {routing?.trigger_rate != null ? `${(routing.trigger_rate * 100).toFixed(0)}%` : '--'}
                                                    </div>
                                                </div>
                                                <div>
                                                    <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.2rem' }}>命中数</div>
                                                    <div style={{ color: '#f8fafc', fontWeight: 700 }}>
                                                        {routing?.status === 'available' ? `${routing.matched_count}/${routing.expected_count}` : '--'}
                                                    </div>
                                                </div>
                                            </div>
                                            <div style={{ fontSize: '0.82rem', color: '#cbd5e1', lineHeight: 1.6 }}>
                                                <div><strong style={{ color: '#94a3b8' }}>预期 Skill：</strong> {formatExpectedSkillList(routing?.expected_skills)}</div>
                                                <div><strong style={{ color: '#94a3b8' }}>实际调用：</strong> {formatInvokedSkillList(routing?.invoked_skills)}</div>
                                                {routing?.matched_intent && <div><strong style={{ color: '#94a3b8' }}>命中语义意图：</strong> {routing.matched_intent}</div>}
                                                {routing?.matched_anchors?.length ? <div><strong style={{ color: '#94a3b8' }}>命中语义锚点：</strong> {routing.matched_anchors.join(', ')}</div> : null}
                                            </div>
                                            {routing?.skill_breakdown?.length ? (
                                                <div style={{ marginTop: '0.85rem', display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                                                    {routing.skill_breakdown.map(item => {
                                                        const statusMeta = getRoutingSkillStatusMeta(item.status);
                                                        return (
                                                            <div key={`routing-${item.skill}`} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'center', padding: '0.45rem 0.6rem', borderRadius: '8px', background: 'rgba(15, 23, 42, 0.42)' }}>
                                                                <div style={{ minWidth: 0 }}>
                                                                    <div style={{ color: '#f8fafc', fontSize: '0.82rem', fontWeight: 700 }}>{item.skill}</div>
                                                                    <div style={{ color: '#94a3b8', fontSize: '0.76rem' }}>
                                                                        预期版本 {item.expected_version != null ? `v${item.expected_version}` : '任意'} | 实际版本 {item.invoked_version != null ? `v${item.invoked_version}` : '未调用'}
                                                                    </div>
                                                                </div>
                                                                <span style={{ flexShrink: 0, padding: '0.22rem 0.5rem', borderRadius: '999px', fontSize: '0.72rem', color: statusMeta.color, background: statusMeta.background, border: `1px solid ${statusMeta.border}` }}>
                                                                    {statusMeta.label}
                                                                </span>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            ) : null}
                                        </div>

                                        <div
                                            style={{
                                                borderRadius: '10px',
                                                padding: '1rem',
                                                background: outcomeMeta.background,
                                                border: `1px solid ${outcomeMeta.border}`,
                                            }}
                                        >
                                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'center', marginBottom: '0.75rem' }}>
                                                <strong style={{ color: '#e2e8f0' }}>Skill 执行效果评测</strong>
                                                <span style={{ color: outcomeMeta.accent, fontSize: '0.8rem', fontWeight: 700 }}>{outcomeMeta.label}</span>
                                            </div>
                                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0.75rem', marginBottom: '0.75rem' }}>
                                                <div>
                                                    <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.2rem' }}>评分</div>
                                                    <div style={{ color: '#f8fafc', fontWeight: 700 }}>
                                                        {outcome?.score != null ? outcome.score.toFixed(2) : '--'}
                                                    </div>
                                                </div>
                                                <div>
                                                    <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.2rem' }}>评测项数</div>
                                                    <div style={{ color: '#f8fafc', fontWeight: 700 }}>
                                                        {outcome?.status === 'available' || outcome?.status === 'pending'
                                                            ? `${outcome.root_cause_count + outcome.key_action_count}`
                                                            : '--'}
                                                    </div>
                                                </div>
                                            </div>
                                            <div style={{ fontSize: '0.82rem', color: '#cbd5e1', lineHeight: 1.6 }}>
                                                <div><strong style={{ color: '#94a3b8' }}>匹配 Skill：</strong> {outcome?.matched_skill ? `${outcome.matched_skill}${outcome.matched_skill_version != null ? ` v${outcome.matched_skill_version}` : ''}` : '--'}</div>
                                                {outcome?.matched_query && <div><strong style={{ color: '#94a3b8' }}>业务场景：</strong> {outcome.matched_query}</div>}
                                                <div><strong style={{ color: '#94a3b8' }}>效果数据：</strong> {outcome?.standard_answer_present ? '已配置标准答案' : '未配置标准答案'}</div>
                                            </div>
                                            {outcome?.skill_breakdown?.length ? (
                                                <div style={{ marginTop: '0.85rem', display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                                                    {outcome.skill_breakdown.map(item => {
                                                        const routingStatusMeta = getRoutingSkillStatusMeta(item.routing_status);
                                                        return (
                                                            <div key={`outcome-${item.skill}`} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'center', padding: '0.45rem 0.6rem', borderRadius: '8px', background: 'rgba(15, 23, 42, 0.42)' }}>
                                                                <div style={{ minWidth: 0 }}>
                                                                    <div style={{ color: '#f8fafc', fontSize: '0.82rem', fontWeight: 700 }}>
                                                                        {item.skill}{item.version != null ? ` v${item.version}` : ''}
                                                                    </div>
                                                                    <div style={{ color: '#94a3b8', fontSize: '0.76rem' }}>
                                                                        角色：{item.role} | 路由：{routingStatusMeta.label}
                                                                    </div>
                                                                </div>
                                                                <span style={{ flexShrink: 0, color: '#cbd5e1', fontSize: '0.76rem' }}>
                                                                    {item.score != null ? item.score.toFixed(2) : '--'}
                                                                </span>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            ) : null}
                                        </div>
                                    </div>
                                );
                            })()}

                            {selectedRecord.failures && selectedRecord.failures.length > 0 && (
                                <div className="detail-section">
                                    <h4 style={{ color: c.error }}>中间故障 / 异常分析</h4>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                        {selectedRecord.failures.map((fail, idx) => (
                                            <div key={idx} style={{ background: c.errorSubtle, border: `1px solid ${c.errorSubtleBorder}`, borderRadius: '6px', padding: '1rem' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                                                    <span style={{ background: c.error, color: c.bg, padding: '2px 8px', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 'bold' }}>
                                                        {fail.failure_type}
                                                    </span>
                                                    <span style={{ color: c.error, fontWeight: 'bold' }}>{fail.description}</span>
                                                </div>
                                                {fail.context && (
                                                    <div style={{ marginBottom: '0.5rem', fontSize: '0.9rem', color: '#d4d4d8', fontFamily: 'monospace', background: 'rgba(0,0,0,0.3)', padding: '0.5rem', borderRadius: '4px' }}>
                                                        {fail.context}
                                                    </div>
                                                )}
                                                {fail.recovery && (
                                                    <div style={{ fontSize: '0.9rem', color: c.success }}>
                                                        <strong style={{ color: c.fgMuted }}>修复建议:</strong> {fail.recovery}
                                                    </div>
                                                )}

                                                {/* Attribution Display */}
                                                {(fail.attribution || fail.attribution_reason) && (
                                                    <div style={{ marginTop: '0.8rem', paddingTop: '0.8rem', borderTop: `1px dashed ${c.errorSubtleBorder}` }}>
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.3rem' }}>
                                                            <strong style={{ color: c.warning }}>归因分析:</strong>
                                                            {fail.attribution && (
                                                                <span style={{
                                                                    background: c.warning,
                                                                    color: c.bg,
                                                                    padding: '1px 6px',
                                                                    borderRadius: '4px',
                                                                    fontSize: '0.75rem',
                                                                    fontWeight: 'bold',
                                                                    border: `1px solid ${c.warning}`
                                                                }}>
                                                                    {fail.attribution}
                                                                </span>
                                                            )}
                                                        </div>
                                                        {fail.attribution_reason && (
                                                            <div style={{ fontSize: '0.9rem', color: c.warning, fontStyle: 'italic' }}>
                                                                {fail.attribution_reason}
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}



                            <div className="detail-row" style={{ marginTop: '1rem' }}>
                                <strong style={{ color: c.fgMuted }}>执行效果判定说明：</strong>
                                <div style={{ marginTop: '0.2rem', fontSize: '0.9rem', color: c.fg, whiteSpace: 'pre-wrap' }}>{selectedRecord.judgment_reason || '-'}</div>
                            </div>
                        </div >

                        <div className="detail-section">
                            <h4>用户反馈</h4>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                                    <button
                                        onClick={() => submitFeedback('like')}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: '0.5rem',
                                            background: (selectedRecord.user_feedback?.type === 'like') ? '#38bdf8' : '#334155',
                                            color: (selectedRecord.user_feedback?.type === 'like') ? '#18181b' : '#a1a1aa',
                                            border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer',
                                            fontWeight: (selectedRecord.user_feedback?.type === 'like') ? 'bold' : 'normal',
                                            transition: 'all 0.2s'
                                        }}
                                    >
                                        👍 有帮助
                                    </button>
                                    <button
                                        onClick={() => submitFeedback('dislike')}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: '0.5rem',
                                            background: (selectedRecord.user_feedback?.type === 'dislike') ? '#f87171' : '#334155',
                                            color: (selectedRecord.user_feedback?.type === 'dislike') ? '#18181b' : '#a1a1aa',
                                            border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer',
                                            fontWeight: (selectedRecord.user_feedback?.type === 'dislike') ? 'bold' : 'normal',
                                            transition: 'all 0.2s'
                                        }}
                                    >
                                        👎 没帮助
                                    </button>
                                </div>
                                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                                    <textarea
                                        value={feedbackComment}
                                        onChange={(e) => setFeedbackComment(e.target.value)}
                                        placeholder={t('config.commentPlaceholder')}
                                        style={{ flex: 1, minHeight: '60px', padding: '8px', background: c.bg, border: `1px solid ${c.border}`, color: c.fg, borderRadius: '4px', fontSize: '0.9rem' }}
                                    />
                                    <button
                                        className="btn-primary"
                                        onClick={() => submitFeedback(selectedRecord.user_feedback?.type || null)}
                                        style={{ padding: '8px 16px', fontSize: '0.9rem', height: 'fit-content', whiteSpace: 'nowrap' }}
                                    >
                                        保存评论
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div >
                </div >
            )}

            {/* Floating User Button */}
            <button
                onClick={() => setShowUserModal(true)}
                style={{
                    position: 'fixed',
                    top: '1.5rem',
                    right: '2rem',
                    width: '3rem',
                    height: '3rem',
                    borderRadius: '50%',
                    background: c.primary,
                    color: c.bg,
                    border: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '1.5rem',
                    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
                    cursor: 'pointer',
                    zIndex: 900,
                    transition: 'transform 0.2s'
                }}
                onMouseOver={(e) => e.currentTarget.style.transform = 'scale(1.1)'}
                onMouseOut={(e) => e.currentTarget.style.transform = 'scale(1)'}
                title="User Settings"
            >
                👤
            </button>

            {/* User Info Modal */}
            {showUserModal && (
                <div className="modal-overlay" onClick={() => setShowUserModal(false)} style={{ alignItems: 'flex-start', paddingTop: '10vh' }}>
                    <div className="modal-content" style={{ width: '500px', maxWidth: '90vw', background: c.bg, border: `1px solid ${c.border}`, borderRadius: '12px', padding: '0', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>

                        {/* Modal Header */}
                        <div style={{ padding: '1.5rem', background: c.bgSecondary, borderBottom: `1px solid ${c.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                <div style={{
                                    width: '40px', height: '40px', borderRadius: '50%', background: c.primary, color: c.bg,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem', fontWeight: 'bold'
                                }}>
                                    {user ? user.substring(0, 1).toUpperCase() : '?'}
                                </div>
                                <div>
                                    <h3 style={{ margin: 0, color: c.fg, fontSize: '1.1rem' }}>{user}</h3>
                                    <span style={{ fontSize: '0.8rem', color: c.fgMuted }}>User Profile</span>
                                </div>
                            </div>
                            <button onClick={() => setShowUserModal(false)} style={{ background: 'transparent', border: 'none', color: c.fgSecondary, fontSize: '1.5rem', cursor: 'pointer', lineHeight: 1 }}>×</button>
                        </div>

                        {/* Modal Body */}
                        <div style={{ padding: '1.5rem' }}>

                            {/* Stats or Info could go here */}

                            {localApiKey ? (
                                <div className="form-group" style={{ background: c.bgSecondary, padding: '1.25rem', borderRadius: '8px', border: `1px solid ${c.border}` }}>
                                    <label style={{ color: c.fgMuted, fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '0.75rem', display: 'block' }}>密钥</label>
                                    <div style={{ display: 'flex', gap: '10px' }}>
                                        <div style={{
                                            flex: 1, padding: '0.75rem 1rem', background: c.bg, borderRadius: '6px',
                                            border: `1px solid ${c.border}`, color: c.fg, fontFamily: 'monospace', fontSize: '0.9rem',
                                            overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis'
                                        }}>
                                            {localApiKey}
                                        </div>
                                        <button
                                            className="btn-primary"
                                            onClick={() => {
                                                const textToCopy = localApiKey;
                                                const handleSuccess = () => {
                                                    setCopiedApiKey(true);
                                                    setTimeout(() => setCopiedApiKey(false), 2000);
                                                };

                                                if (navigator.clipboard && window.isSecureContext) {
                                                    navigator.clipboard.writeText(textToCopy).then(handleSuccess);
                                                } else {
                                                    // Fallback using document.execCommand('copy')
                                                    const textArea = document.createElement("textarea");
                                                    textArea.value = textToCopy;
                                                    textArea.style.position = "fixed";
                                                    textArea.style.left = "-9999px";
                                                    textArea.style.top = "0";
                                                    document.body.appendChild(textArea);
                                                    textArea.focus();
                                                    textArea.select();
                                                    try {
                                                        document.execCommand('copy');
                                                        handleSuccess();
                                                    } catch (err) {
                                                        console.error('Fallback: Oops, unable to copy', err);
                                                        alert(t('common.copyFailed'));
                                                    }
                                                    document.body.removeChild(textArea);
                                                }
                                            }}
                                            style={{
                                                padding: '0 1.25rem',
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '6px',
                                                background: copiedApiKey ? '#4ade80' : undefined
                                            }}
                                        >
                                            {copiedApiKey ? (
                                                <>
                                                    <span>✅</span> Copied
                                                </>
                                            ) : (
                                                <>
                                                    <span>📋</span> Copy
                                                </>
                                            )}
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <div style={{ textAlign: 'center', padding: '2rem', color: c.fgSecondary }}>
                                    未找到密钥。
                                </div>
                            )}


                        </div>

                        {/* Guide Settings */}
                        <div style={{ padding: '0 1.5rem 1.5rem' }}>
                            <div style={{ background: c.bgSecondary, padding: '1.25rem', borderRadius: '8px', border: `1px solid ${c.border}` }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <div>
                                        <h4 style={{ margin: '0 0 0.25rem 0', color: c.fg, fontSize: '0.95rem' }}>新手引导</h4>
                                        <p style={{ margin: 0, fontSize: '0.8rem', color: c.fgMuted }}>
                                            {guideState?.guideDisabled ? 'Guide Disabled' : 'Guide Enabled'}
                                        </p>
                                    </div>
                                    <button
                                        onClick={async () => {
                                            if (guideState?.guideDisabled) {
                                                const res = await apiFetch('/api/guide', {
                                                    method: 'POST',
                                                    headers: {
                                                        'Content-Type': 'application/json',
                                                        'x-user-id': user!,
                                                    },
                                                    body: JSON.stringify({
                                                        guideDisabled: false,
                                                        dismissedAt: null,
                                                    }),
                                                });
                                                if (res.ok) {
                                                    window.location.reload();
                                                }
                                            } else {
                                                const res = await apiFetch('/api/guide', {
                                                    method: 'POST',
                                                    headers: {
                                                        'Content-Type': 'application/json',
                                                        'x-user-id': user!,
                                                    },
                                                    body: JSON.stringify({
                                                        currentStep: 0,
                                                        completedSteps: [],
                                                        skippedSteps: [],
                                                        dismissedAt: null,
                                                    }),
                                                });
                                                if (res.ok) {
                                                    setShowUserModal(false);
                                                    setShouldShowGuide(true);
                                                }
                                            }
                                        }}
                                        style={{
                                            background: guideState?.guideDisabled ? '#4ade80' : '#38bdf8',
                                            border: 'none',
                                            color: c.bg,
                                            padding: '0.5rem 1rem',
                                            borderRadius: '6px',
                                            fontWeight: '600',
                                            cursor: 'pointer',
                                            fontSize: '0.85rem',
                                        }}
                                    >
                                        {guideState?.guideDisabled ? t('guide.buttons.enableGuide') : t('guide.buttons.restartGuide')}
                                    </button>
                                </div>
                            </div>
                        </div>

                        {/* Auto Evaluation Settings */}
                        <div style={{ padding: '0 1.5rem 1.5rem' }}>
                            <div style={{ background: c.bgSecondary, padding: '1.25rem', borderRadius: '8px', border: `1px solid ${c.border}` }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <div>
                                        <h4 style={{ margin: '0 0 0.25rem 0', color: c.fg, fontSize: '0.95rem' }}>自动评测</h4>
                                        <p style={{ margin: 0, fontSize: '0.8rem', color: c.fgMuted }}>
                                            {autoEvaluationEnabled ? '开启后，数据上报会自动触发评测' : '关闭后，只保存执行记录，不自动评测'}
                                        </p>
                                    </div>
                                    <button
                                        onClick={async () => {
                                            const newValue = !autoEvaluationEnabled;
                                            setAutoEvaluationEnabled(newValue);
                                            try {
                                                const payload = {
                                                    activeConfigId: activeConfigId,
                                                    configs: allConfigs,
                                                    autoEvaluationEnabled: newValue
                                                };
                                                const finalPayload = { settings: payload, user };
                                                await apiFetch('/api/settings', {
                                                    method: 'POST',
                                                    headers: { 'Content-Type': 'application/json' },
                                                    body: JSON.stringify(finalPayload)
                                                });
                                            } catch (e) {
                                                console.error('Failed to save auto evaluation setting', e);
                                                setAutoEvaluationEnabled(!newValue);
                                            }
                                        }}
                                        style={{
                                            background: autoEvaluationEnabled ? '#4ade80' : '#6b7280',
                                            border: 'none',
                                            color: c.bg,
                                            padding: '0.5rem 1rem',
                                            borderRadius: '6px',
                                            fontWeight: '600',
                                            cursor: 'pointer',
                                            fontSize: '0.85rem',
                                        }}
                                    >
                                        {autoEvaluationEnabled ? '已开启' : '已关闭'}
                                    </button>
                                </div>
                            </div>
                        </div>

                        {/* Modal Footer */}
                        <div style={{ padding: '1.25rem 1.5rem', background: c.bg, borderTop: `1px solid ${c.border}`, display: 'flex', justifyContent: 'flex-end', gap: '1rem' }}>
                            <button
                                onClick={() => setShowUserModal(false)}
                                style={{
                                    background: 'transparent',
                                    border: `1px solid ${c.border}`,
                                    color: c.fgMuted,
                                    padding: '0.6rem 1.25rem',
                                    borderRadius: '6px',
                                    fontWeight: '500',
                                    cursor: 'pointer'
                                }}
                            >
                                Close
                            </button>
                            {!isOrgMode && (
                            <button
                                onClick={() => {
                                    localStorage.removeItem('user_id');
                                    localStorage.removeItem('api_key');
                                    window.location.reload();
                                }}
                                style={{
                                    background: c.error,
                                    border: 'none',
                                    color: 'white',
                                    padding: '0.6rem 1.25rem',
                                    borderRadius: '6px',
                                    fontWeight: '600',
                                    cursor: 'pointer',
                                    boxShadow: '0 2px 4px rgba(239, 68, 68, 0.2)'
                                }}
                            >
                                Sign Out
                            </button>
                            )}
                        </div>
                    </div>
                </div>
            )}



            {/* User Modal */}

            {/* Styles */}
            <style jsx>{`
        .tab-btn { background: transparent; border: none; color: var(--foreground-muted); padding: 0.5rem 1rem; cursor: pointer; font-size: 1rem; border-bottom: 2px solid transparent; }
        .tab-btn.active { color: var(--primary); border-bottom-color: var(--primary); }
        .p-2 { padding: 0.75rem; }
        .btn-primary { background: var(--primary); color: var(--background); border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer; font-weight: bold; }
        .btn-sm { color: var(--background); border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 0.8rem; }
        .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); display: flex; justify-content: center; alignItems: center; z-index: 1000; backdrop-filter: blur(2px); }
        .modal-content { background: var(--background-secondary); padding: 2rem; border: 1px solid var(--border); width: 66vw; max-width: 1200px; }
        .form-group { margin-bottom: 1rem; }
        .form-group label { display: block; marginBottom: 0.5rem; color: var(--foreground-secondary); }
        input, textarea { background: var(--input-bg); border: 1px solid var(--border); color: white; borderRadius: 4px; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        details[open] > summary .details-arrow { transform: rotate(90deg); }
        details > summary:hover { background: rgba(30, 41, 59, 0.8) !important; }
        details > summary::-webkit-details-marker { display: none; }
        details > summary::marker { display: none; content: ''; }
        @keyframes pulse-dot { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(1.3); } }

        .detail-section { margin-bottom: 1.5rem; padding-bottom: 1.5rem; border-bottom: 1px solid #334155; }
        .detail-section:last-child { border-bottom: none; }
        .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
        .detail-row { margin-bottom: 1rem; }
        .code-block { background: var(--input-bg); padding: 0.8rem; border-radius: 6px; font-family: monospace; white-space: pre-wrap; word-break: break-word; overflow-wrap: break-word; font-size: 0.9rem; color: var(--foreground); max-width: 100%; overflow-x: auto; }
        .status-box { padding: 1rem; border-radius: 6px; text-align: center; }
        .status-box.good { background: var(--success-subtle); border: 1px solid var(--success); color: var(--success); }
        .status-box.bad { background: var(--error-subtle); border: 1px solid var(--error); color: var(--error); }

        h4 { color: var(--primary); margin-bottom: 1rem; margin-top: 0; }
        .text-sm { font-size: 0.875rem; }
        .text-xl { font-size: 1.25rem; }
        .text-2xl { font-size: 1.5rem; }
        .font-bold { font-weight: 700; }
        .text-slate-400 { color: var(--foreground-muted); }
        .text-green-400 { color: var(--success); }
        .text-red-400 { color: var(--error); }
        .dropdown-content { display: none; }
        .dropdown-trigger:hover + .dropdown-content, .dropdown-content:hover { display: block; }
      `}</style>

            {/* User Guide
              * 禁用：UserGuide 弹窗对老用户来说是干扰，新用户也很少用到。先全局关掉，
              * 设置页里"重启引导"按钮还在（依赖 shouldShowGuide / disableGuide hook 状态），
              * 想恢复就把下面的 false && 删掉即可。 */}
            {false && shouldShowGuide && guideSteps.length > 0 && !guideLoading && (
                <UserGuide
                    steps={guideSteps}
                    onComplete={async () => {
                        setShouldShowGuide(false);
                        await dismissForToday();
                    }}
                    onSkip={async (stepId) => {
                        await markStepSkipped(stepId);
                    }}
                    onDontShowAgain={async () => {
                        await disableGuide();
                    }}
                />
            )}
        </div >
    );
}
