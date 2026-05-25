'use client';

/**
 * 轨迹评估器 · 评测执行（对齐 hifi p-eval / p-eval-result-detail）
 *
 * 顶部 toolbar：选 Agent + 选评估器 + 开始评测
 * 主体：执行记录清单（按 Agent 过滤），多选 → 一键评测；自动按 trace.query ↔ case.input 匹配 case
 * 详情：综合评测结论 + grid2（左 Result-based / 右 Process-based）
 */
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
} from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiFetch } from '@/lib/client/api';
import { useAuth } from '@/lib/auth/auth-context';
import {
    getPrimaryExecutionAgentName,
    isEvaluatorAgent,
    isEvaluatorTraceRecord,
} from '@/lib/evaluator-agent';
import {
    buildDefaultTrajectoryTaskTitle,
    normalizeTrajectoryTaskMeta,
} from '@/lib/eval/trajectory-task-meta';

interface DatasetCase {
    id: string;
    input: string;
    expectedOutput: string;
    evaluationFocus: string;
    trajectory: string;
}

interface AgentDataset {
    id: string;
    name: string;
    description: string;
    targetAgent: string;
    datasetKind: string;
    tags: string[];
    cases: DatasetCase[];
    updatedAt: string;
}

interface Agent {
    id: string;
    name: string;
    ownership: 'system' | 'user' | 'unregistered';
    layer: 'main' | 'subagent';
    platform: 'opencode' | 'openclaw' | 'hermes';
    version: string;
    framework: string;
    status: 'running' | 'idle' | 'unregistered';
    successRate?: string;
    todayCalls: string;
    p99?: string;
    parentAgent?: string;
    discoveryTime?: string;
    lastExecutedAt: string;
}

interface ExecutionRecord {
    task_id?: string | null;
    upload_id?: string | null;
    timestamp?: string;
    framework?: string;
    model?: string;
    query?: string;
    final_result?: string;
    auto_eval_ready?: boolean;
    autoEvalReady?: boolean;
    answer_score?: number | null;
    is_answer_correct?: boolean | null;
    judgment_reason?: string | null;
    judgmentReason?: string | null;
    failures?: any;
    latency?: number | null;
    cost?: number | null;
    label?: string | null;
    agent?: string | null;
    agentName?: string | null;
    agents?: string[];
}

interface DimensionScores {
    completeness: number;
    toolChoice: number;
    redundancy: number;
    attribution: number;
}

interface TrajectoryDeviation {
    stepIndex: number;
    kind: string;
    name?: string;
    deviation: string;
    severity: 'low' | 'medium' | 'high';
}

interface TrajectoryResult {
    id: string;
    evaluatorRunId: string;
    selectedEvaluators?: string[];
    selectedEvaluatorNames?: string[];
    autoWatch?: boolean;
    watchedAgent?: string;
    watchPlaceholder?: boolean;
    taskTitle?: string;
    taskDescription?: string;
    datasetId: string;
    caseId: string;
    executionId: string | null;
    taskId: string | null;
    status: 'pending' | 'running' | 'done' | 'failed';
    errorMessage: string | null;
    resultEvaluationError?: string | null;
    trajectoryScore: number | null;
    dimensionScores: DimensionScores | null;
    deviationSteps: TrajectoryDeviation[];
    rootCauseStep: string | null;
    reasonText: string | null;
    resultEvaluationScore?: number | null;
    customEvaluationScore?: number | null;
    createdAt: string;
}

const POLL_MS = 3000;
const NO_EVALUABLE_CASE_PREFIX = '[no-evaluable-case]';
const TASK_DRAFT_STORAGE_KEY = 'trajectory-eval-task-draft';

import { presetEvaluators } from '@/lib/evaluators/preset-evaluators';

const RUNTIME_EVALUATORS = presetEvaluators.map(e => ({ id: e.id, name: e.name }));

const COLORS = {
    primary: '#4F46E5',
    primarySubtle: '#EEF2FF',
    primarySubtleBorder: '#C7D2FE',
    success: '#16A34A',
    successSubtle: '#F0FDF4',
    danger: '#DC2626',
    dangerSubtle: '#FEF2F2',
    warning: '#D97706',
    warningSubtle: '#FFFBEB',
    border: '#E4E4E7',
    borderSoft: '#F4F4F5',
    bgSoft: '#FAFAFA',
    text: '#18181B',
    textSecondary: '#52525B',
    textMuted: '#71717A',
    textDisabled: '#A1A1AA',
};

const STATUS_LABEL: Record<TrajectoryResult['status'], string> = {
    pending: '待评测',
    running: '评测中',
    done: '已评测',
    failed: '评测失败',
};

const STATUS_COLOR: Record<TrajectoryResult['status'], string> = {
    pending: COLORS.textDisabled,
    running: '#1677ff',
    done: COLORS.success,
    failed: COLORS.danger,
};

function getEffectiveStatus(r: TrajectoryResult): TrajectoryResult['status'] {
    return r.status === 'done' && r.resultEvaluationError ? 'failed' : r.status;
}

function isNoEvaluableCase(r?: Pick<TrajectoryResult, 'status' | 'errorMessage' | 'resultEvaluationError'> | null): boolean {
    return Boolean(r?.status === 'failed' && r.errorMessage?.includes(NO_EVALUABLE_CASE_PREFIX));
}

function getStatusLabel(r: TrajectoryResult): string {
    return isNoEvaluableCase(r) ? '无可评测case' : STATUS_LABEL[getEffectiveStatus(r)];
}

function getStatusColor(r: TrajectoryResult): string {
    return isNoEvaluableCase(r) ? COLORS.warning : STATUS_COLOR[getEffectiveStatus(r)];
}

function fmtScore10(n: number | null | undefined): string {
    if (n === null || n === undefined || Number.isNaN(n)) return '--';
    return (n * 10).toFixed(1);
}

function fmtRelTime(s?: string | null): string {
    if (!s) return '--';
    try {
        const d = new Date(s);
        const diff = Date.now() - d.getTime();
        if (diff < 60_000) return '刚刚';
        if (diff < 3600_000) return `${Math.floor(diff / 60000)} 分钟前`;
        if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
        return `${Math.floor(diff / 86400_000)} 天前`;
    } catch {
        return s;
    }
}

function fmtLatency(s: number | null | undefined): string {
    if (s == null || Number.isNaN(s)) return '--';
    if (s >= 60) return `${(s / 60).toFixed(1)}m`;
    return `${s.toFixed(2)}s`;
}

function formatTraceIdPreview(traceId: string | null | undefined): string {
    if (!traceId) return '--';
    return traceId.slice(0, 14) || '--';
}

function hasSelectedEvaluator(r: TrajectoryResult | null | undefined, evaluatorId: string): boolean {
    const selected = Array.isArray(r?.selectedEvaluators) ? r.selectedEvaluators : [];
    if (selected.length === 0) return evaluatorId === 'preset-agent-trace-quality';
    return selected.includes(evaluatorId);
}

function getSelectedEvaluatorNames(r: TrajectoryResult | null | undefined): string {
    const names = Array.isArray(r?.selectedEvaluatorNames) ? r.selectedEvaluatorNames : [];
    return names.length > 0 ? names.join('、') : 'Agent 轨迹质量';
}

function isEvaluationTerminal(status?: TrajectoryResult['status'] | null): boolean {
    return status === 'done' || status === 'failed';
}

function isTraceReadyForAutoEvaluation(record: ExecutionRecord): boolean {
    return record.auto_eval_ready === true || record.autoEvalReady === true;
}

interface ModelConfig {
    id: string;
    name: string;
    model: string;
    baseUrl?: string;
}

interface CustomEvaluatorOption {
    id: string;
    name: string;
}

export default function TrajectoryEvalCenter() {
    const { user } = useAuth();
    const router = useRouter();
    const searchParams = useSearchParams();
    const [datasets, setDatasets] = useState<AgentDataset[]>([]);
    
    // 初始化默认选中参数传过来的评估器
    const [selectedEvaluators, setSelectedEvaluators] = useState<string[]>(() => {
        const initialEvaluator = searchParams?.get('evaluatorId');
        return initialEvaluator ? [initialEvaluator] : [];
    });
    const [selectedAgent, setSelectedAgent] = useState<string>('');
    const [evaluatorToAdd, setEvaluatorToAdd] = useState<string>('');
    const [selectedDatasetId, setSelectedDatasetId] = useState<string>('');
    const [records, setRecords] = useState<ExecutionRecord[]>([]);
    const [results, setResults] = useState<TrajectoryResult[]>([]);
    const [selectedTraceIds, setSelectedTraceIds] = useState<Set<string>>(new Set());
    const [defaultsAppliedFor, setDefaultsAppliedFor] = useState<string>('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string>('');
    const [info, setInfo] = useState<string>('');
    const [submitting, setSubmitting] = useState(false);
    const [autoSubmitting, setAutoSubmitting] = useState(false);
    const [activeAutoWatchRunId, setActiveAutoWatchRunId] = useState('');
    const [modelConfigs, setModelConfigs] = useState<ModelConfig[]>([]);
    const [selectedModelConfigId, setSelectedModelConfigId] = useState<string>('');
    const [dbAgents, setDbAgents] = useState<Agent[]>([]);
    const [customEvaluatorOptions, setCustomEvaluatorOptions] = useState<CustomEvaluatorOption[]>([]);
    const [taskTitle, setTaskTitle] = useState('');
    const [taskDescription, setTaskDescription] = useState('');
    const [savedTaskSnapshot, setSavedTaskSnapshot] = useState('');

    const taskDraftStorageKey = useMemo(
        () => `${TASK_DRAFT_STORAGE_KEY}:${user || 'anonymous'}`,
        [user],
    );
    const autoWatchBaselineTraceIdsRef = useRef<Set<string>>(new Set());
    const autoWatchAppendInFlightRef = useRef(false);

    // 拉所有模型配置列表
    useEffect(() => {
        if (!user) return;
        apiFetch(`/api/eval/settings?user=${encodeURIComponent(user)}`)
            .then(r => r.json())
            .then((data: any) => {
                const cfgs: ModelConfig[] = Array.isArray(data?.configs)
                    ? data.configs.map((c: any) => ({ id: c.id, name: c.name || c.id, model: c.model || '', baseUrl: c.baseUrl }))
                    : [];
                setModelConfigs(cfgs);
                const activeId = data?.activeConfigId;
                if (activeId && cfgs.find(c => c.id === activeId)) {
                    setSelectedModelConfigId(activeId);
                } else if (cfgs.length > 0) {
                    setSelectedModelConfigId(cfgs[0].id);
                }
            })
            .catch(() => undefined);
    }, [user]);

    const fetchDbAgents = async () => {
        try {
            const res = await fetch('/api/agents');
            if (res.ok) {
                const data = await res.json();
                const formatted: Agent[] = data.agents.map((a: { id: string, name: string, platform: any, createdAt: string, todayCalls: string, lastExecutedAt: string }) => ({
                    id: a.id,
                    name: a.name,
                    ownership: 'user',
                    layer: 'main',
                    platform: a.platform,
                    version: 'v1.0',
                    framework: 'Custom',
                    status: 'idle',
                    todayCalls: a.todayCalls || '0',
                    lastExecutedAt: a.lastExecutedAt || a.createdAt,
                }));
                setDbAgents(formatted);
            }
        } catch (error) {
            console.error('Failed to fetch DB agents', error);
        }
    };

    useEffect(() => {
        fetchDbAgents();
    }, []);

    useEffect(() => {
        if (!user) return;
        apiFetch(`/api/user-evaluators?user=${encodeURIComponent(user)}`)
            .then(r => r.json())
            .then((items: unknown) => {
                const next = Array.isArray(items)
                    ? items
                        .map(item => item && typeof item === 'object' ? item as Record<string, unknown> : null)
                        .filter((item): item is Record<string, unknown> => Boolean(item))
                        .filter(item => item.evaluatorType === 'LLM')
                        .map(item => ({
                            id: String(item.id || '').trim(),
                            name: String(item.name || '').trim(),
                        }))
                        .filter(item => item.id && item.name)
                    : [];
                setCustomEvaluatorOptions(next);
            })
            .catch(() => setCustomEvaluatorOptions([]));
    }, [user]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const fallback = normalizeTrajectoryTaskMeta({});
        try {
            const raw = window.localStorage.getItem(taskDraftStorageKey);
            if (!raw) {
                setTaskTitle(fallback.title);
                setTaskDescription('');
                setSavedTaskSnapshot('');
                return;
            }
            const parsed = JSON.parse(raw) as { title?: string; description?: string } | null;
            const next = normalizeTrajectoryTaskMeta({
                title: parsed?.title,
                description: parsed?.description,
            });
            const snapshot = JSON.stringify(next);
            setTaskTitle(next.title);
            setTaskDescription(next.description);
            setSavedTaskSnapshot(snapshot);
        } catch {
            setTaskTitle(fallback.title);
            setTaskDescription('');
            setSavedTaskSnapshot('');
        }
    }, [taskDraftStorageKey]);

    const mockAgents: Agent[] = useMemo(() => [
        {
            id: 'demo-agent',
            name: 'demo-agent',
            ownership: 'system',
            layer: 'main',
            platform: 'opencode',
            version: 'v1.0',
            framework: 'opencode',
            status: 'running',
            successRate: '—',
            todayCalls: '—',
            lastExecutedAt: '2026-05-06T12:00:00',
        },
        {
            id: 'customer-service-agent',
            name: 'customer-service-agent',
            ownership: 'system',
            layer: 'main',
            platform: 'opencode',
            version: 'v2.1',
            framework: 'LangChain',
            status: 'running',
            successRate: '87.3%',
            todayCalls: '3,847',
            lastExecutedAt: '2026-05-06T11:48:00',
        },
        {
            id: 'data-analyzer-v2',
            name: 'data-analyzer-v2',
            ownership: 'user',
            layer: 'main',
            platform: 'openclaw',
            version: 'v1.0',
            framework: 'Custom',
            status: 'idle',
            successRate: '94.1%',
            todayCalls: '128',
            lastExecutedAt: '2026-05-05T20:10:00',
        },
        {
            id: 'temp-worker-42',
            name: 'temp-worker-42',
            ownership: 'unregistered',
            layer: 'main',
            platform: 'hermes',
            version: 'N/A',
            framework: 'N/A',
            status: 'unregistered',
            todayCalls: '12',
            discoveryTime: '2026-05-06T10:02:00',
            lastExecutedAt: '2026-05-06T10:02:00',
        },
        {
            id: 'order-executor',
            name: 'order-executor',
            ownership: 'system',
            layer: 'subagent',
            platform: 'opencode',
            version: 'v1.1',
            framework: 'LangGraph',
            status: 'running',
            todayCalls: '412',
            p99: '4.3s',
            parentAgent: 'customer-service-agent',
            lastExecutedAt: '2026-05-06T11:43:00',
        },
        {
            id: 'email-dispatcher',
            name: 'email-dispatcher',
            ownership: 'user',
            layer: 'main',
            platform: 'hermes',
            version: 'v0.9',
            framework: 'AutoGPT',
            status: 'running',
            successRate: '99.2%',
            todayCalls: '1,024',
            lastExecutedAt: '2026-05-06T09:24:00',
        },
        {
            id: 'security-guard',
            name: 'security-guard',
            ownership: 'system',
            layer: 'main',
            platform: 'opencode',
            version: 'v3.0',
            framework: 'Internal',
            status: 'running',
            successRate: '100%',
            todayCalls: '45,201',
            lastExecutedAt: '2026-05-06T11:56:00',
        },
        {
            id: 'trace-quality-evaluator',
            name: 'trace-quality-evaluator',
            ownership: 'system',
            layer: 'main',
            platform: 'opencode',
            version: 'v1.0',
            framework: 'opencode',
            status: 'running',
            successRate: '—',
            todayCalls: '—',
            lastExecutedAt: '2026-05-06T12:00:00',
        },
        {
            id: 'completeness-checker',
            name: 'completeness-checker',
            ownership: 'system',
            layer: 'subagent',
            platform: 'opencode',
            version: 'v1.0',
            framework: 'opencode',
            status: 'running',
            successRate: '—',
            todayCalls: '—',
            parentAgent: 'trace-quality-evaluator',
            lastExecutedAt: '2026-05-06T12:00:00',
        },
        {
            id: 'tool-choice-judge',
            name: 'tool-choice-judge',
            ownership: 'system',
            layer: 'subagent',
            platform: 'opencode',
            version: 'v1.0',
            framework: 'opencode',
            status: 'running',
            successRate: '—',
            todayCalls: '—',
            parentAgent: 'trace-quality-evaluator',
            lastExecutedAt: '2026-05-06T12:00:00',
        },
        {
            id: 'attribution-locator',
            name: 'attribution-locator',
            ownership: 'system',
            layer: 'subagent',
            platform: 'opencode',
            version: 'v1.0',
            framework: 'opencode',
            status: 'running',
            successRate: '—',
            todayCalls: '—',
            parentAgent: 'trace-quality-evaluator',
            lastExecutedAt: '2026-05-06T12:00:00',
        },
        {
            id: 'task-completion-evaluator',
            name: 'task-completion-evaluator',
            ownership: 'system',
            layer: 'main',
            platform: 'opencode',
            version: 'v1.0',
            framework: 'opencode',
            status: 'running',
            successRate: '—',
            todayCalls: '—',
            lastExecutedAt: '2026-05-06T12:00:00',
        },
        {
            id: 'key-points-checker',
            name: 'key-points-checker',
            ownership: 'system',
            layer: 'subagent',
            platform: 'opencode',
            version: 'v1.0',
            framework: 'opencode',
            status: 'running',
            successRate: '—',
            todayCalls: '—',
            parentAgent: 'task-completion-evaluator',
            lastExecutedAt: '2026-05-06T12:00:00',
        },
    ], []);

    const combinedAgents = useMemo(() => {
        const dbKeys = new Set(dbAgents.map(a => `${a.platform}-${a.name}`));
        const filteredMock = mockAgents.filter(a => !dbKeys.has(`${a.platform}-${a.name}`));
        return [...dbAgents, ...filteredMock];
    }, [dbAgents, mockAgents]);

    // 1. trajectory 数据集（用于 handleStart 自动匹配）
    useEffect(() => {
        if (!user) return;
        apiFetch(`/api/agent-datasets?user=${encodeURIComponent(user)}`)
            .then(r => r.json())
            .then((data: AgentDataset[]) => {
                const arr = (Array.isArray(data) ? data : []).filter(d => d.datasetKind === 'trajectory');
                setDatasets(arr);
            })
            .catch(e => setError(`加载数据集失败：${e?.message || e}`));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user]);

    // 2. 执行记录
    useEffect(() => {
        if (!user) return;
        apiFetch(`/api/observe/data?user=${encodeURIComponent(user)}`)
            .then(r => r.json())
            .then((data: ExecutionRecord[]) => {
                setRecords(Array.isArray(data) ? data : []);
            })
            .catch(e => setError(`加载执行记录失败：${e?.message || e}`))
            .finally(() => setLoading(false));
    }, [user]);

    // 3. 轮询评测结果
    useEffect(() => {
        if (!user) return;
        let stopped = false;
        const tick = async () => {
            try {
                const res = await apiFetch(`/api/eval/trajectory/results?user=${encodeURIComponent(user)}&limit=200`);
                const data = await res.json();
                if (!stopped) setResults(Array.isArray(data?.results) ? data.results : []);
            } catch {
                /* ignore poll error */
            }
        };
        tick();
        const t = setInterval(tick, POLL_MS);
        return () => {
            stopped = true;
            clearInterval(t);
        };
    }, [user]);

    const refreshResults = useCallback(async () => {
        if (!user) return;
        const res = await apiFetch(`/api/eval/trajectory/results?user=${encodeURIComponent(user)}&limit=200`);
        const data = await res.json();
        setResults(Array.isArray(data?.results) ? data.results : []);
    }, [user]);

    // 执行 Agent 列表（排除评估器 agent，按 name 去重）
    // `build` 是 opencode runtime 默认/内部 agent，不作为业务执行 Agent 展示。
    const agentOptions = useMemo(() => {
        const customEvaluatorNames = new Set(
            customEvaluatorOptions
                .map(item => item.name.trim())
                .filter(Boolean),
        );
        const registered = combinedAgents
            .filter(a => a.layer === 'main')
            .filter(a => !isEvaluatorAgent(a))
            .filter(a => !customEvaluatorNames.has(a.name))
            .map(a => a.name);
        const observed = records
            .filter(r => !isEvaluatorTraceRecord(r))
            .map(getPrimaryExecutionAgentName)
            .filter((name): name is string => Boolean(name) && !customEvaluatorNames.has(name));
        const seen = new Set<string>();
        return [...registered, ...observed]
            .filter(name => {
                if (!name || seen.has(name)) return false;
                seen.add(name);
                return true;
            })
            .sort();
    }, [combinedAgents, customEvaluatorOptions, records]);

    const evaluatorOptions = useMemo(() => {
        const merged = [...RUNTIME_EVALUATORS, ...customEvaluatorOptions];
        const seen = new Set<string>();
        return merged.filter(item => {
            if (!item.id || seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
        });
    }, [customEvaluatorOptions]);

    // 默认选中第一个 Agent
    useEffect(() => {
        if (!selectedAgent && agentOptions.length > 0) setSelectedAgent(agentOptions[0]);
    }, [agentOptions, selectedAgent]);

    // 默认选中第一个数据集
    useEffect(() => {
        if (!selectedDatasetId && datasets.length > 0) setSelectedDatasetId(datasets[0].id);
    }, [datasets, selectedDatasetId]);

    // 评测结果按 traceId 索引（取最新）
    const latestResultByTraceId = useMemo(() => {
        const m = new Map<string, TrajectoryResult>();
        for (const r of results) {
            if (r.watchPlaceholder) continue;
            const key = r.taskId || r.executionId || '';
            if (!key) continue;
            const old = m.get(key);
            if (!old || new Date(r.createdAt).getTime() > new Date(old.createdAt).getTime()) {
                m.set(key, r);
            }
        }
        return m;
    }, [results]);

    // 按 Agent 过滤后的 trace 列表：
    // - agentName / agent：执行记录主表字段，表示业务执行 Agent
    // - agents：仅在主字段缺失时兜底；排除 opencode 内部 build 和评估器 agent
    const agentRecords = useMemo(() => {
        return records
            .filter(r => Boolean(r.task_id || r.upload_id))
            .filter(r => !isEvaluatorTraceRecord(r))
            .filter(r => {
                if (!selectedAgent) return true;
                return getPrimaryExecutionAgentName(r) === selectedAgent;
            })
            .sort((a, b) => {
                const at = a.timestamp ? new Date(a.timestamp).getTime() : 0;
                const bt = b.timestamp ? new Date(b.timestamp).getTime() : 0;
                return bt - at;
            })
            .slice(0, 80);
    }, [records, selectedAgent]);

    // 切 Agent 时清空选择
    useEffect(() => {
        setSelectedTraceIds(new Set());
        setDefaultsAppliedFor('');
    }, [selectedAgent]);

    // 默认勾选：未评测 / 评测失败 的行（hifi 默认 checkbox 行为）
    // fingerprint 防止每次轮询都重置 user 已经手动调整过的状态
    useEffect(() => {
        if (agentRecords.length === 0) return;
        const fingerprint = `${selectedAgent}::${agentRecords.map(r => r.task_id).join(',')}`;
        if (defaultsAppliedFor === fingerprint) return;
        setDefaultsAppliedFor(fingerprint);
        const next = new Set<string>();
        for (const rec of agentRecords) {
            const traceId = rec.task_id || '';
            if (!traceId) continue;
            const r = latestResultByTraceId.get(traceId);
            // 未评测 / 失败 → 默认勾选；已评测（done/running/pending）不勾
            if (!r || getEffectiveStatus(r) === 'failed') next.add(traceId);
        }
        setSelectedTraceIds(next);
    }, [agentRecords, latestResultByTraceId, selectedAgent, defaultsAppliedFor]);

    function toggleRow(traceId: string) {
        setSelectedTraceIds(prev => {
            const next = new Set(prev);
            if (next.has(traceId)) next.delete(traceId);
            else next.add(traceId);
            return next;
        });
    }
    function addEvaluator(evaluatorId: string) {
        if (!evaluatorId) return;
        setSelectedEvaluators(prev => (
            prev.includes(evaluatorId) ? prev : [...prev, evaluatorId]
        ));
        setEvaluatorToAdd('');
    }
    function removeEvaluator(evaluatorId: string) {
        setSelectedEvaluators(prev => prev.filter(id => id !== evaluatorId));
    }
    function toggleSelectAll() {
        const allSelected = agentRecords.every(r => r.task_id && selectedTraceIds.has(r.task_id));
        if (allSelected) {
            setSelectedTraceIds(new Set());
        } else {
            const next = new Set<string>();
            for (const r of agentRecords) if (r.task_id) next.add(r.task_id);
            setSelectedTraceIds(next);
        }
    }

    function handleSaveTaskDraft() {
        if (typeof window === 'undefined') return;
        const next = normalizeTrajectoryTaskMeta({ title: taskTitle, description: taskDescription });
        const snapshot = JSON.stringify(next);
        window.localStorage.setItem(taskDraftStorageKey, snapshot);
        setTaskTitle(next.title);
        setTaskDescription(next.description);
        setSavedTaskSnapshot(snapshot);
        setError('');
        setInfo(`已保存任务信息：${next.title}`);
    }

    async function handleStart() {
        if (!user) {
            setError('请先登录');
            return;
        }
        if (selectedTraceIds.size === 0) {
            setError('请至少勾选一条执行记录');
            return;
        }
        if (!selectedAgent) {
            setError('请选择执行 Agent');
            return;
        }
        if (selectedEvaluators.length === 0) {
            setError('请至少选择一个评估器');
            return;
        }
        setError('');
        setInfo('');
        const taskMeta = normalizeTrajectoryTaskMeta({ title: taskTitle, description: taskDescription });

        // 收集选中的 traceId 列表，无需数据集配对；接口字段仍沿用 taskIds 契约。
        const traceIds: string[] = [];
        for (const rec of agentRecords) {
            if (rec.task_id && selectedTraceIds.has(rec.task_id)) {
                traceIds.push(rec.task_id);
            }
        }

        if (traceIds.length === 0) {
            setError('没有可评测的执行记录');
            return;
        }

        setSubmitting(true);
        try {
            const res = await apiFetch('/api/eval/trajectory/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user,
                    taskIds: traceIds,
                    evaluators: selectedEvaluators,
                    taskTitle: taskMeta.title,
                    taskDescription: taskMeta.description,
                }),
            });
            const data = await res.json();
            if (!res.ok) {
                setError(`提交失败：${data?.error || res.statusText}`);
            } else {
                const evaluatorText = Array.isArray(data?.evaluatorNames) ? data.evaluatorNames.join('、') : selectedEvaluators.join('、');
                setInfo(`已发起 ${data.created?.length ?? 0} 条评测：${taskMeta.title}（${evaluatorText}）`);
                setSelectedTraceIds(new Set());
                const nextDraft = {
                    title: buildDefaultTrajectoryTaskTitle(),
                    description: '',
                };
                const nextSnapshot = JSON.stringify(nextDraft);
                if (typeof window !== 'undefined') {
                    window.localStorage.setItem(taskDraftStorageKey, nextSnapshot);
                }
                setTaskTitle(nextDraft.title);
                setTaskDescription(nextDraft.description);
                setSavedTaskSnapshot(nextSnapshot);
                apiFetch(`/api/eval/trajectory/results?user=${encodeURIComponent(user)}&limit=200`)
                    .then(r => r.json())
                    .then(d => setResults(Array.isArray(d?.results) ? d.results : []));
            }
        } catch (e: any) {
            setError(`提交失败：${e?.message || e}`);
        } finally {
            setSubmitting(false);
        }
    }

    async function handleStartAutoWatch() {
        if (!user) {
            setError('请先登录');
            return;
        }
        if (!selectedAgent) {
            setError('请选择执行 Agent');
            return;
        }
        if (selectedEvaluators.length === 0) {
            setError('请至少选择一个评估器');
            return;
        }
        if (selectedTraceIds.size > 0) {
            setError('自动观测只追踪未来新来的 trace。请先取消当前勾选的 trace。');
            return;
        }

        setError('');
        setInfo('');
        setAutoSubmitting(true);
        const taskMeta = normalizeTrajectoryTaskMeta({ title: taskTitle, description: taskDescription });
        try {
            const res = await apiFetch('/api/eval/trajectory/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user,
                    taskIds: [],
                    evaluators: selectedEvaluators,
                    taskTitle: taskMeta.title,
                    taskDescription: taskMeta.description,
                    autoWatch: true,
                    watchedAgent: selectedAgent,
                }),
            });
            const data = await res.json();
            if (!res.ok) {
                setError(`自动观测启动失败：${data?.error || res.statusText}`);
                return;
            }
            autoWatchBaselineTraceIdsRef.current = new Set(
                agentRecords
                    .map(rec => rec.task_id || '')
                    .filter(Boolean),
            );
            setActiveAutoWatchRunId(data.evaluatorRunId || '');
            setSelectedTraceIds(new Set());
            setInfo(`已开启自动观测：后续 ${selectedAgent} 的新 trace 会自动追加到「${taskMeta.title}」`);
            await refreshResults();
        } catch (e: unknown) {
            setError(`自动观测启动失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setAutoSubmitting(false);
        }
    }

    useEffect(() => {
        if (!user || !activeAutoWatchRunId || autoWatchAppendInFlightRef.current) return;
        const runTraceIds = new Set(
            results
                .filter(r => r.evaluatorRunId === activeAutoWatchRunId && !r.watchPlaceholder)
                .map(r => r.taskId || r.executionId || '')
                .filter(Boolean),
        );
        const traceIds = agentRecords
            .filter(isTraceReadyForAutoEvaluation)
            .map(rec => rec.task_id || '')
            .filter(Boolean)
            .filter(traceId => !autoWatchBaselineTraceIdsRef.current.has(traceId))
            .filter(traceId => !runTraceIds.has(traceId));
        if (traceIds.length === 0) return;

        autoWatchAppendInFlightRef.current = true;
        apiFetch('/api/eval/trajectory/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user,
                evaluatorRunId: activeAutoWatchRunId,
                taskIds: traceIds,
                evaluators: selectedEvaluators,
                autoWatch: true,
                watchedAgent: selectedAgent,
            }),
        })
            .then(async res => {
                const data = await res.json();
                if (!res.ok) {
                    setError(`自动追加失败：${data?.error || res.statusText}`);
                    return;
                }
                setInfo(`自动观测已追加 ${data.created?.length ?? traceIds.length} 条新 trace`);
                await refreshResults();
            })
            .catch(e => setError(`自动追加失败：${e instanceof Error ? e.message : String(e)}`))
            .finally(() => {
                autoWatchAppendInFlightRef.current = false;
            });
    }, [activeAutoWatchRunId, agentRecords, refreshResults, results, selectedAgent, selectedEvaluators, user]);

    function gotoDetail(traceId: string) {
        if (!traceId) return;
        router.push(`/eval/trajectory/${encodeURIComponent(traceId)}`);
    }

    if (loading) {
        return <div className="loading" style={{ padding: 24 }}>正在加载评测视图...</div>;
    }

    const taskDraftDirty = JSON.stringify(
        normalizeTrajectoryTaskMeta({ title: taskTitle, description: taskDescription }),
    ) !== savedTaskSnapshot;
    const activeModelConfig = modelConfigs.find(cfg => cfg.id === selectedModelConfigId);

    return (
        <div style={{ padding: '18px 22px 28px', maxWidth: 1480, margin: '0 auto', color: COLORS.text }}>
            {/* Title */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                <span style={badgeStyle(COLORS.primarySubtle, COLORS.primary)}>评测执行</span>
                <span style={{ fontSize: 11, color: COLORS.textDisabled }}>
                    选执行 Agent 与评估器 → 多选 trace → 一键发起评测；可同时勾选结果评测与过程评测
                </span>
            </div>
            <div
                style={{
                    display: 'flex',
                    gap: 12,
                    alignItems: 'flex-start',
                    marginTop: 10,
                    padding: 14,
                    borderRadius: 12,
                    border: `1px solid ${COLORS.border}`,
                    background: '#fff',
                    boxShadow: '0 1px 2px rgba(24, 24, 27, 0.04)',
                }}
            >
                <div style={{ minWidth: 0, flex: 1, display: 'grid', gap: 10 }}>
                    <input
                        value={taskTitle}
                        onChange={e => setTaskTitle(e.target.value)}
                        placeholder={buildDefaultTrajectoryTaskTitle()}
                        style={taskTitleInputStyle()}
                    />
                    <input
                        value={taskDescription}
                        onChange={e => setTaskDescription(e.target.value)}
                        placeholder="任务描述（可选）…"
                        style={taskDescriptionInputStyle()}
                    />
                </div>
                <button
                    type="button"
                    onClick={handleSaveTaskDraft}
                    style={{
                        ...btnSmallStyle(taskDraftDirty ? COLORS.primary : COLORS.textDisabled, taskDraftDirty ? COLORS.primarySubtle : COLORS.bgSoft),
                        marginTop: 2,
                        height: 34,
                        padding: '0 14px',
                        fontSize: 12,
                    }}
                >
                    保存
                </button>
            </div>

            {error && <div style={infoBoxStyle(COLORS.danger, '#FFEBEB', '#FFD4D4')}>{error}</div>}
            {info && <div style={infoBoxStyle(COLORS.success, COLORS.successSubtle, '#C6E5D9')}>{info}</div>}

            {/* 运行模型 banner */}
            <div
                style={{
                    marginTop: 12,
                    padding: '8px 14px',
                    background: modelConfigs.length > 0 ? COLORS.bgSoft : '#FFF7E6',
                    border: `1px solid ${modelConfigs.length > 0 ? COLORS.border : '#FFD591'}`,
                    borderRadius: 7,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 12,
                }}
            >
                <span style={{ color: COLORS.textMuted }}>评测器运行模型：</span>
                {modelConfigs.length > 0 ? (
                    <>
                        <span
                            style={{
                                color: COLORS.text,
                                fontSize: 12,
                                fontWeight: 500,
                                lineHeight: '20px',
                            }}
                        >
                            {activeModelConfig
                                ? `${activeModelConfig.name} · ${activeModelConfig.model || '未填写 model'}`
                                : '未找到当前默认模型'}
                        </span>
                        <span style={{ color: COLORS.textDisabled, fontSize: 11 }}>（所有评估器共用）</span>
                    </>
                ) : (
                    <span style={{ color: COLORS.warning, fontWeight: 500 }}>
                        未配置 — 评测会失败
                    </span>
                )}
                <span style={{ flex: 1 }} />
                <button
                    type="button"
                    onClick={() => router.push('/modelconfig/registry')}
                    style={{
                        padding: '3px 10px',
                        background: '#fff',
                        color: COLORS.textSecondary,
                        border: `1px solid ${COLORS.border}`,
                        borderRadius: 5,
                        fontSize: 11,
                        cursor: 'pointer',
                    }}
                >
                    {modelConfigs.length > 0 ? '管理模型' : '去配置 →'}
                </button>
            </div>

            {/* Toolbar */}
            <div
                style={{
                    background: '#fff',
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 9,
                    padding: '14px 16px',
                    marginTop: 14,
                    display: 'flex',
                    gap: 18,
                    alignItems: 'center',
                    flexWrap: 'wrap',
                }}
            >
                <ToolbarItem label="执行 Agent">
                    <select
                        value={selectedAgent}
                        onChange={e => setSelectedAgent(e.target.value)}
                        style={chipSelectStyle()}
                    >
                        {agentOptions.length === 0 && <option value="">(暂无 Agent)</option>}
                        {agentOptions.map(a => (
                            <option key={a} value={a}>
                                {a}
                            </option>
                        ))}
                    </select>
                </ToolbarItem>

                <ToolbarItem label="评估器">
                    <div
                        style={{
                            minWidth: 360,
                            maxWidth: 560,
                            border: `1px solid ${COLORS.border}`,
                            borderRadius: 10,
                            background: COLORS.bgSoft,
                            padding: 8,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 8,
                        }}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <select
                                value={evaluatorToAdd}
                                onChange={e => addEvaluator(e.target.value)}
                                style={{
                                    ...chipSelectStyle(),
                                    minWidth: 0,
                                    width: '100%',
                                    height: 32,
                                    background: '#fff',
                                    borderColor: COLORS.primarySubtleBorder,
                                    fontSize: 12,
                                    boxShadow: '0 1px 2px rgba(26, 26, 24, 0.04)',
                                }}
                            >
                                <option value="">添加评估器...</option>
                                {evaluatorOptions.map(item => (
                                    <option
                                        key={item.id}
                                        value={item.id}
                                        disabled={selectedEvaluators.includes(item.id)}
                                    >
                                        {item.name}
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                flexWrap: 'wrap',
                                minHeight: 40,
                                padding: selectedEvaluators.length === 0 ? '0 4px' : '2px 0',
                            }}
                        >
                            {selectedEvaluators.length === 0 ? (
                                <span style={{ fontSize: 11, color: COLORS.textDisabled }}>已选评估器会显示在这里</span>
                            ) : (
                                selectedEvaluators.map(id => {
                                    const item = evaluatorOptions.find(option => option.id === id);
                                    if (!item) return null;
                                    return (
                                        <span
                                            key={item.id}
                                            style={{
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                gap: 8,
                                                padding: '5px 8px 5px 10px',
                                                border: `1px solid ${COLORS.primarySubtleBorder}`,
                                                borderRadius: 6,
                                                background: '#fff',
                                                color: COLORS.textSecondary,
                                                fontSize: 12,
                                                lineHeight: 1,
                                                boxShadow: '0 1px 2px rgba(26, 26, 24, 0.03)',
                                            }}
                                        >
                                            <span>{item.name}</span>
                                            <button
                                                type="button"
                                                onClick={() => removeEvaluator(item.id)}
                                                style={{
                                                    width: 16,
                                                    height: 16,
                                                    borderRadius: 4,
                                                    border: `1px solid ${COLORS.primarySubtleBorder}`,
                                                    background: COLORS.primarySubtle,
                                                    color: COLORS.primary,
                                                    cursor: 'pointer',
                                                    fontSize: 10,
                                                    lineHeight: '14px',
                                                    padding: 0,
                                                    flex: '0 0 auto',
                                                }}
                                                aria-label={`删除${item.name}`}
                                                title={`删除 ${item.name}`}
                                            >
                                                ×
                                            </button>
                                        </span>
                                    );
                                })
                            )}
                        </div>
                    </div>
                </ToolbarItem>

                <div style={{ flex: 1 }} />

                <button
                    onClick={handleStart}
                    disabled={submitting || autoSubmitting || selectedTraceIds.size === 0 || !selectedAgent || selectedEvaluators.length === 0}
                    style={btnPrimaryStyle(submitting || autoSubmitting || selectedTraceIds.size === 0 || !selectedAgent || selectedEvaluators.length === 0)}
                >
                    {submitting ? '提交中…' : `开始评测 (${selectedTraceIds.size})`}
                </button>
                <button
                    onClick={handleStartAutoWatch}
                    disabled={submitting || autoSubmitting || selectedTraceIds.size > 0 || !selectedAgent || selectedEvaluators.length === 0}
                    style={btnSecondaryStyle(submitting || autoSubmitting || selectedTraceIds.size > 0 || !selectedAgent || selectedEvaluators.length === 0)}
                    title="开启后，本页面会自动追踪该执行 Agent 新上报的 trace，并追加到本次评测任务"
                >
                    {autoSubmitting ? '启动中…' : '自动观测'}
                </button>
            </div>

            {/* 执行记录清单 */}
            <div style={{ marginTop: 16 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>执行记录清单</div>
                    <div style={{ fontSize: 11, color: COLORS.textMuted }}>
                        {selectedAgent ? <>当前 Agent <code style={{ color: COLORS.primary }}>{selectedAgent}</code> 共 {agentRecords.length} 条 trace</> : '请先选 Agent'}
                    </div>
                </div>
                <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 9, overflow: 'hidden', background: '#fff' }}>
                    {agentRecords.length === 0 ? (
                        <div style={{ padding: 24, textAlign: 'center', color: COLORS.textMuted, fontSize: 12 }}>
                            该 Agent 没有可评测的执行记录。
                        </div>
                    ) : (
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                            <thead>
                                <tr style={{ background: COLORS.bgSoft, borderBottom: `1px solid ${COLORS.border}` }}>
                                    <th style={thStyle(36)}>
                                        <input
                                            type="checkbox"
                                            checked={
                                                agentRecords.length > 0 &&
                                                agentRecords.every(r => r.task_id && selectedTraceIds.has(r.task_id))
                                            }
                                            onChange={toggleSelectAll}
                                        />
                                    </th>
                                    <th style={thStyle(170, 'left')}>TRACE ID</th>
                                    <th style={thStyle(undefined, 'left')}>Trace 实际输入</th>
                                    <th style={thStyle(undefined, 'left')}>Trace 实际输出</th>
                                    <th style={thStyle(80, 'center')}>评测状态</th>
                                    <th style={thStyle(60, 'right')}>得分</th>
                                    <th style={thStyle(80, 'left')}>评测器</th>
                                    <th style={thStyle(60, 'right')}>耗时</th>
                                    <th style={thStyle(80, 'center')}></th>
                                </tr>
                            </thead>
                            <tbody>
                                {agentRecords.map(rec => {
                                    const traceId = rec.task_id || '';
                                    const r = latestResultByTraceId.get(traceId);
                                    const checked = selectedTraceIds.has(traceId);
                                    const displayScore = r
                                        && isEvaluationTerminal(r.status)
                                        ? (() => {
                                            const hasTrace = hasSelectedEvaluator(r, 'preset-agent-trace-quality');
                                            const hasResult = hasSelectedEvaluator(r, 'preset-agent-task-completion');
                                            const hasCustom = Array.isArray(r.selectedEvaluators)
                                                ? r.selectedEvaluators.some(id => id.startsWith('custom-'))
                                                : typeof r.customEvaluationScore === 'number';
                                            const traceScore = hasTrace ? r.trajectoryScore : null;
                                            const resultScore = hasResult
                                                ? (typeof r.resultEvaluationScore === 'number' ? r.resultEvaluationScore : (rec.answer_score ?? null))
                                                : null;
                                            const customScore = hasCustom ? (r.customEvaluationScore ?? null) : null;
                                            const parts = [traceScore, resultScore, customScore]
                                                .filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
                                            if (parts.length === 0) return null;
                                            return parts.reduce((a, b) => a + b, 0) / parts.length;
                                        })()
                                        : null;
                                    return (
                                        <tr
                                            key={traceId}
                                            style={{
                                                borderBottom: `1px solid ${COLORS.borderSoft}`,
                                                background: checked ? '#F8F7FE' : 'transparent',
                                                cursor: 'pointer',
                                            }}
                                            onClick={() => gotoDetail(traceId)}
                                        >
                                            <td style={tdStyle('center')} onClick={e => e.stopPropagation()}>
                                                <input
                                                    type="checkbox"
                                                    checked={checked}
                                                    onChange={() => toggleRow(traceId)}
                                                />
                                            </td>
                                            <td style={{ ...tdStyle('left'), fontFamily: 'monospace', color: COLORS.textSecondary, whiteSpace: 'nowrap' }} title={traceId}>
                                                {formatTraceIdPreview(traceId)}
                                            </td>
                                            <td style={{ ...tdStyle('left'), maxWidth: 280 }}>
                                                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={rec.query || ''}>
                                                    {rec.query || '—'}
                                                </div>
                                            </td>
                                            <td style={{ ...tdStyle('left'), maxWidth: 280 }}>
                                                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={rec.final_result || ''}>
                                                    {rec.final_result || '—'}
                                                </div>
                                                <div style={{ fontSize: 10, color: COLORS.textDisabled, marginTop: 2 }}>
                                                    {rec.framework || ''} · {rec.model || ''} · {fmtRelTime(rec.timestamp)}
                                                </div>
                                            </td>
                                            <td style={tdStyle('center')}>
                                                {r ? (
                                                    <span style={{ color: getStatusColor(r), fontWeight: 600, fontSize: 11 }} title={r.errorMessage || r.resultEvaluationError || ''}>
                                                        {getStatusLabel(r)}
                                                    </span>
                                                ) : (
                                                    <span style={{ color: COLORS.textDisabled }}>待评测</span>
                                                )}
                                            </td>
                                            <td style={{ ...tdStyle('right'), color: displayScore != null ? COLORS.primary : COLORS.textDisabled, fontWeight: 600 }}>
                                                {displayScore != null ? `${fmtScore10(displayScore)} 分` : '--'}
                                            </td>
                                            <td style={tdStyle('left')}>
                                                <span style={{ color: r ? COLORS.textSecondary : COLORS.textDisabled }}>
                                                    {r ? getSelectedEvaluatorNames(r) : '—'}
                                                </span>
                                            </td>
                                            <td style={{ ...tdStyle('right'), color: COLORS.textMuted }}>{fmtLatency(rec.latency)}</td>
                                            <td style={tdStyle('center')} onClick={e => e.stopPropagation()}>
                                                <button onClick={() => gotoDetail(traceId)} style={btnSmallStyle()}>详情</button>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>

        </div>
    );
}

// ──────────────────────── 子组件 ────────────────────────

function ToolbarItem({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11.5, color: COLORS.textMuted, fontWeight: 500, whiteSpace: 'nowrap' }}>{label}：</span>
            {children}
        </div>
    );
}


// ──────────────────────── 样式工具 ────────────────────────

function badgeStyle(bg: string, color: string, small?: boolean): CSSProperties {
    return {
        display: 'inline-block',
        padding: small ? '1px 6px' : '2px 8px',
        background: bg,
        color,
        borderRadius: 4,
        fontSize: small ? 10 : 11,
        fontWeight: 500,
        whiteSpace: 'nowrap',
    };
}

function btnPrimaryStyle(disabled?: boolean): CSSProperties {
    return {
        padding: '6px 14px',
        background: disabled ? '#bfb6f0' : COLORS.primary,
        color: '#fff',
        border: 'none',
        borderRadius: 6,
        fontSize: 12,
        fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
    };
}

function btnSecondaryStyle(disabled?: boolean): CSSProperties {
    return {
        padding: '6px 14px',
        background: disabled ? COLORS.bgSoft : '#fff',
        color: disabled ? COLORS.textDisabled : COLORS.primary,
        border: `1px solid ${disabled ? COLORS.border : COLORS.primary}`,
        borderRadius: 6,
        fontSize: 12,
        fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
    };
}

function btnSmallStyle(color = COLORS.textSecondary, background = '#fff'): CSSProperties {
    return {
        padding: '3px 9px',
        background,
        color,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 5,
        fontSize: 11,
        cursor: 'pointer',
    };
}

function taskTitleInputStyle(): CSSProperties {
    return {
        width: '100%',
        minHeight: 42,
        border: `1px solid ${COLORS.primarySubtleBorder}`,
        borderRadius: 9,
        outline: 'none',
        background: '#fff',
        padding: '0 14px',
        margin: 0,
        fontSize: 20,
        fontWeight: 700,
        lineHeight: 1.3,
        color: COLORS.text,
        boxShadow: '0 0 0 3px rgba(79, 70, 229, 0.06)',
    };
}

function taskDescriptionInputStyle(): CSSProperties {
    return {
        width: '100%',
        minHeight: 46,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 9,
        outline: 'none',
        background: '#fff',
        padding: '0 14px',
        marginTop: 0,
        fontSize: 14,
        lineHeight: 1.65,
        color: COLORS.textSecondary,
    };
}

function chipSelectStyle(): CSSProperties {
    return {
        padding: '4px 12px',
        height: 30,
        borderRadius: 7,
        border: `1px solid ${COLORS.border}`,
        fontSize: 12,
        background: '#fff',
        color: COLORS.text,
        fontWeight: 500,
    };
}

function infoBoxStyle(color: string, bg: string, border: string): CSSProperties {
    return {
        padding: 10,
        marginTop: 12,
        borderRadius: 6,
        background: bg,
        border: `1px solid ${border}`,
        color,
        fontSize: 12,
    };
}

function thStyle(width?: number, align: 'left' | 'right' | 'center' = 'left'): CSSProperties {
    return {
        padding: '8px 10px',
        textAlign: align,
        fontWeight: 500,
        color: COLORS.textMuted,
        fontSize: 11,
        ...(width ? { width } : {}),
    };
}

function tdStyle(align: 'left' | 'right' | 'center' = 'left'): CSSProperties {
    return {
        padding: '8px 10px',
        textAlign: align,
        verticalAlign: 'middle',
    };
}
