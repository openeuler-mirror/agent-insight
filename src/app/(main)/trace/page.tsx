'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import React, { useCallback, useEffect, useMemo, useRef, useState, Suspense } from 'react';
import {
    ArrowLeft,
    RefreshCw,
    ExternalLink as ExternalLinkIcon,
    X as XIcon,
    XCircle,
    Wrench,
    Users,
    Layers,
    Terminal,
    RotateCcw,
} from 'lucide-react';
import { parseAsInteger, parseAsString, useQueryState } from 'nuqs';

import { AppTopBar } from '@/components/shell/AppTopBar';
import { PageContainer, PageContent, PageFooter, PageHeader, PageToolbar } from '@/components/shell/PageContainer';
import AgentTraceView from '@/components/observe/AgentTraceView';
import { useAuth } from '@/lib/auth/auth-context';
import { useLocale } from '@/lib/client/locale-context';
import { apiFetch } from '@/lib/client/api';
import { getPrimaryExecutionAgentName } from '@/lib/evaluator-agent';

import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Select, type SelectOption } from '@/components/ui/select';
import { Pagination } from '@/components/ui/pagination';

import { StatusBadge, type StatusKind } from '@/components/feedback/StatusBadge';
import { EmptyState } from '@/components/feedback/EmptyState';
import { IdChip } from '@/components/text/IdChip';
import { TruncateText } from '@/components/text/TruncateText';
import { RelativeTime } from '@/components/text/RelativeTime';
import { Term } from '@/components/text/Term';
import { cn } from '@/lib/utils';

const basePath = process.env.NEXT_PUBLIC_URL_PREFIX || '';

interface InvokedSkill {
    name: string;
    version?: number | null;
}

interface Execution {
    timestamp: string;
    framework?: string;
    agent?: string;
    agentName?: string;
    query?: string;
    final_result?: string;
    skill?: string;
    /** 主 skill 的版本号。Execution.skillVersion 字段，上传时由 ingest/upload 三级 fallback 确定 */
    skill_version?: number | null;
    skillVersion?: number | null;
    skills?: string[];
    invokedSkills?: InvokedSkill[];
    invoked_skills?: InvokedSkill[];
    agents?: string[];
    is_answer_correct?: boolean;
    is_skill_correct?: boolean;
    answer_score?: number;
    latency?: number;
    tokens?: number;
    cost?: number;
    tool_call_count?: number;
    tool_call_error_count?: number;
    task_id?: string;
    upload_id?: string;
    model?: string;
    label?: string;
    is_evaluating?: boolean;
    judgment_reason?: string;
    failures?: any[];
    agentOwnership?: string | null;
}

type TimeFilter = '1h' | '3h' | '24h' | '7d' | '30d' | 'all';
type SortKey = 'timestamp' | 'agent' | 'status' | 'latency' | 'tokens' | 'cost';
type SortDir = 'asc' | 'desc';
type AnomalyFilter = 'all' | 'running' | 'success' | 'failed';
type OwnershipFilter = 'all' | 'user' | 'system' | 'unregistered';

const TIME_WIN_MS: Record<TimeFilter, number> = {
    '1h': 3.6e6,
    '3h': 1.08e7,
    '24h': 8.64e7,
    '7d': 6.048e8,
    '30d': 2.592e9,
    'all': Infinity,
};

const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
const REFRESH_INTERVAL_OPTIONS = [5, 10, 30, 60] as const;

// Resizable trace-list columns. "task" has no fixed width — it absorbs remaining
// space via `table-fixed` + col without width. Widths persist to localStorage per
// user (docs/design/patterns.md §11 — table state survives reload).
type ResizableColKey = 'traceId' | 'agent' | 'status' | 'tags' | 'time' | 'actions';

const DEFAULT_COLUMN_WIDTHS: Record<ResizableColKey, number> = {
    traceId: 130,
    agent:   170,
    status:  110,
    tags:    240,
    time:    120,
    actions: 220,
};
const MIN_COLUMN_WIDTH: Record<ResizableColKey, number> = {
    traceId: 90,
    agent:   100,
    status:  80,
    tags:    120,
    time:    80,
    actions: 160,
};
const MAX_COLUMN_WIDTH = 640;
const COL_WIDTHS_STORAGE_KEY = 'trace.columnWidths.v1';
const TASK_COL_MIN_PX = 280; // reserved minimum for the flexible "task" column

function getInvokedSkillNames(execution: Execution): string[] {
    const invoked = Array.isArray(execution.invoked_skills)
        ? execution.invoked_skills
        : (Array.isArray(execution.invokedSkills) ? execution.invokedSkills : []);
    const names = new Set<string>();
    invoked.forEach(skill => {
        const name = skill?.name?.trim();
        if (name) names.add(name);
    });
    return Array.from(names);
}

function getExecutionAgentNames(execution: Execution): string[] {
    const names = new Set<string>();
    const primary = execution.agentName?.trim() || getPrimaryExecutionAgentName(execution);
    if (primary) names.add(primary);
    if (Array.isArray(execution.agents)) {
        execution.agents.forEach(agent => {
            const name = agent?.trim();
            if (name) names.add(name);
        });
    }
    return Array.from(names);
}

function getExecStatus(e: Execution): 'running' | 'success' | 'failed' {
    if (e.is_evaluating) return 'running';
    if (e.failures && e.failures.length > 0) return 'failed';
    return 'success';
}

function fmtSec(ms: number): string {
    if (!ms || !Number.isFinite(ms)) return '-';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
}

function toDisplayLatencyMs(latency: number, framework?: string): number {
    const fw = (framework || '').toLowerCase();
    if ((fw === 'opencode' || fw === 'openhands' || fw === 'claude' || fw === 'claudecode') && latency > 0 && latency < 1000) return latency * 1000;
    return latency;
}

function clampColumnWidth(key: ResizableColKey, width: number): number {
    return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH[key], Math.round(width)));
}

function useColumnWidths() {
    const [widths, setWidths] = useState<Record<ResizableColKey, number>>(DEFAULT_COLUMN_WIDTHS);

    // Hydrate from localStorage on mount (skipped on server).
    useEffect(() => {
        try {
            const raw = window.localStorage.getItem(COL_WIDTHS_STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw) as Partial<Record<ResizableColKey, number>>;
            setWidths(prev => {
                const next = { ...prev };
                (Object.keys(prev) as ResizableColKey[]).forEach(k => {
                    const v = parsed[k];
                    if (typeof v === 'number' && Number.isFinite(v)) next[k] = clampColumnWidth(k, v);
                });
                return next;
            });
        } catch { /* ignore */ }
    }, []);

    const setColumnWidth = useCallback((key: ResizableColKey, width: number) => {
        setWidths(prev => {
            const next = { ...prev, [key]: clampColumnWidth(key, width) };
            try { window.localStorage.setItem(COL_WIDTHS_STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
            return next;
        });
    }, []);

    const resetColumnWidths = useCallback(() => {
        setWidths(DEFAULT_COLUMN_WIDTHS);
        try { window.localStorage.removeItem(COL_WIDTHS_STORAGE_KEY); } catch { /* ignore */ }
    }, []);

    const isCustomized = useMemo(
        () => (Object.keys(DEFAULT_COLUMN_WIDTHS) as ResizableColKey[])
            .some(k => widths[k] !== DEFAULT_COLUMN_WIDTHS[k]),
        [widths],
    );

    return { widths, setColumnWidth, resetColumnWidths, isCustomized };
}

function ResizeHandle({
    colKey,
    currentWidth,
    onResize,
}: {
    colKey: ResizableColKey;
    currentWidth: number;
    onResize: (key: ResizableColKey, width: number) => void;
}) {
    const onMouseDown = (e: React.MouseEvent<HTMLSpanElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startW = currentWidth;
        const handleMove = (ev: MouseEvent) => {
            onResize(colKey, startW + (ev.clientX - startX));
        };
        const handleUp = () => {
            window.removeEventListener('mousemove', handleMove);
            window.removeEventListener('mouseup', handleUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        window.addEventListener('mousemove', handleMove);
        window.addEventListener('mouseup', handleUp);
    };

    return (
        <span
            onMouseDown={onMouseDown}
            onClick={e => e.stopPropagation()}
            onKeyDown={e => e.stopPropagation()}
            role="separator"
            aria-orientation="vertical"
            aria-label={`Resize column ${colKey}`}
            className="absolute right-0 top-0 z-10 flex h-full w-2 -mr-1 items-center justify-center cursor-col-resize group/handle"
        >
            <span className="h-4 w-px bg-border group-hover/handle:bg-primary group-hover/handle:w-0.5 transition-colors" aria-hidden />
        </span>
    );
}

export default function TracePage() {
    return (
        <Suspense
            fallback={
                <div className="flex flex-col gap-3 px-6 py-6">
                    <Skeleton className="h-9 w-48" />
                    <Skeleton className="h-24 w-full" />
                    <Skeleton className="h-96 w-full" />
                </div>
            }
        >
            <TracePageContent />
        </Suspense>
    );
}

function TracePageContent() {
    const { user } = useAuth();
    const { t, locale } = useLocale();
    const [data, setData] = useState<Execution[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedExecution, setSelectedExecution] = useState<Execution | null>(null);

    // URL-persisted filter / sort / paging state (docs/design/patterns.md §1 + §11).
    const [timeFilter, setTimeFilter] = useQueryState('time', parseAsString.withDefault('all'));
    const [anomalyFilter, setAnomalyFilter] = useQueryState('status', parseAsString.withDefault('all'));
    const [frameworkFilter, setFrameworkFilter] = useQueryState('framework', parseAsString.withDefault('all'));
    const [agentFilter, setAgentFilter] = useQueryState('agent', parseAsString.withDefault('all'));
    const [skillFilter, setSkillFilter] = useQueryState('skill', parseAsString.withDefault('all'));
    const [ownershipFilter, setOwnershipFilter] = useQueryState('ownership', parseAsString.withDefault('user'));
    // 主 Agent / 子 Agent 维度筛选。默认 'root'：列表只展示主 Agent 执行，
    // sub-agent 行通过详情页下钻或切换到 'subagent'/'all' 后才出现。
    const [agentScopeFilter, setAgentScopeFilter] = useQueryState('scope', parseAsString.withDefault('root'));
    const [sortKey, setSortKey] = useQueryState('sort', parseAsString.withDefault('timestamp'));
    const [sortDir, setSortDir] = useQueryState('dir', parseAsString.withDefault('desc'));
    const [page, setPage] = useQueryState('page', parseAsInteger.withDefault(1));
    const [pageSize, setPageSize] = useQueryState('size', parseAsInteger.withDefault(20));
    const [taskIdParam, setTaskIdParam] = useQueryState('taskId', parseAsString);

    const { widths, setColumnWidth, resetColumnWidths, isCustomized } = useColumnWidths();
    const tableMinWidth = useMemo(
        () => widths.traceId + widths.agent + widths.status + widths.tags + widths.time + widths.actions + TASK_COL_MIN_PX,
        [widths],
    );

    const handleSelectExecution = useCallback((e: Execution | null) => {
        setSelectedExecution(e);
        const id = e ? (e.task_id || e.upload_id || null) : null;
        setTaskIdParam(id);
    }, [setTaskIdParam]);

    // Resolve selectedExecution from URL on data load or URL change.
    // fetchGuardRef: 记录已经为哪个 taskIdParam fire 过 fallback fetch, 避免:
    //   - data 列表里没这条(比如系统 agent grayscale-* 被前端过滤掉)
    //   - 每次 fetch 返回新对象 ref → setSelectedExecution → 因为
    //     selectedExecution 在 deps 里, effect 重新跑, 又走 fetch → 死循环
    // 死循环 + 反复 setState 会让 TraceDetailView 的子 effect 反复 abort/重启,
    // 表现就是用户「click → 跳到 trace 列表页, detail 永远渲染不上」。
    const fetchGuardRef = useRef<{ taskId: string; user: string } | null>(null);
    useEffect(() => {
        if (!taskIdParam) {
            if (selectedExecution) setSelectedExecution(null);
            fetchGuardRef.current = null;
            return;
        }
        const exec = data.find(e => e.task_id === taskIdParam || e.upload_id === taskIdParam);
        if (exec) {
            if (selectedExecution !== exec) setSelectedExecution(exec);
            return;
        }
        // data 里没有, fallback 到 API 直查; 每个 (taskId, user) 只 fetch 一次
        if (!user) return;
        const guardKey = { taskId: taskIdParam, user };
        if (
            fetchGuardRef.current?.taskId === guardKey.taskId
            && fetchGuardRef.current?.user === guardKey.user
        ) return;
        fetchGuardRef.current = guardKey;
        apiFetch(`/api/observe/data?user=${encodeURIComponent(user)}&taskId=${encodeURIComponent(taskIdParam)}&includeEvaluations=0`)
            .then(r => r.json())
            .then((d: Execution[]) => {
                if (Array.isArray(d) && d.length > 0) setSelectedExecution(d[0]);
            })
            .catch(() => {
                // 失败让用户能重试: 清掉 guard, 下次 effect 再 fire 时还能再试一次
                if (fetchGuardRef.current?.taskId === taskIdParam) fetchGuardRef.current = null;
            });
    // selectedExecution 不放 deps——它由本 effect 自己写, 放进去就死循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [taskIdParam, data, user]);

    useEffect(() => {
        if (!user) return;
        setLoading(true);
        const scopeParam = agentScopeFilter === 'subagent'
            ? '&onlySubagents=1'
            : agentScopeFilter === 'all'
                ? '&includeSubagents=1'
                : '';
        apiFetch(`/api/observe/data?user=${encodeURIComponent(user)}&includeEvaluations=0${scopeParam}`)
            .then(r => r.json())
            .then((d: Execution[]) => setData(Array.isArray(d) ? d : []))
            .catch(() => setData([]))
            .finally(() => setLoading(false));
    }, [user, agentScopeFilter]);

    const { availableAgents, availableSkills } = useMemo(() => {
        const agents = new Set<string>();
        const skills = new Set<string>();
        data.forEach(d => {
            getExecutionAgentNames(d).forEach(a => agents.add(a));
            getInvokedSkillNames(d).forEach(s => skills.add(s));
        });
        return {
            availableAgents: Array.from(agents).sort(),
            availableSkills: Array.from(skills).sort(),
        };
    }, [data]);

    const frameworks = useMemo(() => {
        const set = new Set<string>();
        data.forEach(d => d.framework && set.add(d.framework));
        return Array.from(set).sort();
    }, [data]);

    const filtered = useMemo(() => {
        const now = Date.now();
        const winMs = TIME_WIN_MS[timeFilter as TimeFilter] ?? Infinity;
        return data
            .filter(d => {
                if (agentFilter !== 'all' && agentFilter !== '') {
                    if (!getExecutionAgentNames(d).includes(agentFilter)) return false;
                }
                if (winMs !== Infinity) {
                    const ts = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : Number(d.timestamp);
                    if (now - ts > winMs) return false;
                }
                if (frameworkFilter !== 'all' && d.framework !== frameworkFilter) return false;
                if (anomalyFilter !== 'all') {
                    const status = getExecStatus(d);
                    if (anomalyFilter !== status) return false;
                }
                if (skillFilter !== 'all') {
                    if (!getInvokedSkillNames(d).includes(skillFilter)) return false;
                }
                if (ownershipFilter !== 'all') {
                    const ownership = d.agentOwnership ?? 'unregistered';
                    if (ownership !== ownershipFilter) return false;
                }
                return true;
            })
            .sort((a, b) => {
                let cmp = 0;
                switch (sortKey as SortKey) {
                    case 'timestamp': {
                        const ta = typeof a.timestamp === 'string' ? Date.parse(a.timestamp) : Number(a.timestamp);
                        const tb = typeof b.timestamp === 'string' ? Date.parse(b.timestamp) : Number(b.timestamp);
                        cmp = ta - tb;
                        break;
                    }
                    case 'agent':
                        cmp = (a.agent || '').localeCompare(b.agent || '');
                        break;
                    case 'status': {
                        const order = { running: 0, failed: 1, success: 2 };
                        cmp = order[getExecStatus(a)] - order[getExecStatus(b)];
                        break;
                    }
                    case 'latency':
                        cmp = toDisplayLatencyMs(a.latency || 0, a.framework) - toDisplayLatencyMs(b.latency || 0, b.framework);
                        break;
                    case 'tokens':
                        cmp = (a.tokens || 0) - (b.tokens || 0);
                        break;
                    case 'cost':
                        cmp = (a.cost || 0) - (b.cost || 0);
                        break;
                }
                return sortDir === 'asc' ? cmp : -cmp;
            });
    }, [data, timeFilter, frameworkFilter, anomalyFilter, agentFilter, skillFilter, ownershipFilter, sortKey, sortDir]);

    useEffect(() => {
        if (page !== 1) setPage(1);
        // page reset on filter / sort change
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [timeFilter, frameworkFilter, anomalyFilter, agentFilter, skillFilter, ownershipFilter, sortKey, sortDir, pageSize]);

    const handleSort = (key: SortKey) => {
        if (key === sortKey) {
            setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
        } else {
            setSortKey(key);
            setSortDir(key === 'timestamp' ? 'desc' : 'asc');
        }
    };

    const stats = useMemo(() => {
        const total = filtered.length;
        const failedCount = filtered.filter(e => getExecStatus(e) === 'failed').length;
        const avgLatencyMs = total ? filtered.reduce((s, e) => s + toDisplayLatencyMs(e.latency || 0, e.framework), 0) / total : 0;
        const errorCount = filtered.reduce((s, e) => s + (e.tool_call_error_count || 0), 0);
        const totalTools = filtered.reduce((s, e) => s + (e.tool_call_count || 0), 0);
        const errRate = totalTools ? Math.round((errorCount / totalTools) * 1000) / 10 : 0;
        return { total, failedCount, avgLatency: avgLatencyMs, errRate };
    }, [filtered]);

    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const pageItems = useMemo(
        () => filtered.slice((page - 1) * pageSize, page * pageSize),
        [filtered, page, pageSize],
    );

    const hasActiveFilters = ownershipFilter !== 'all' || agentFilter !== 'all' || skillFilter !== 'all'
        || anomalyFilter !== 'all' || timeFilter !== 'all' || frameworkFilter !== 'all'
        || agentScopeFilter !== 'root';

    const resetFilters = () => {
        setOwnershipFilter('all');
        setAgentFilter('all');
        setSkillFilter('all');
        setAnomalyFilter('all');
        setTimeFilter('all');
        setFrameworkFilter('all');
        setAgentScopeFilter('root');
    };

    // Filter dropdown option sets
    const ownershipOptions: SelectOption[] = [
        { value: 'all', label: t('nav.allOwnership') },
        { value: 'user', label: t('nav.userAgent') },
        { value: 'system', label: t('nav.systemAgent') },
        { value: 'unregistered', label: t('nav.unregisteredAgent') },
    ];
    const statusOptions: SelectOption[] = [
        { value: 'all', label: t('common.all') },
        { value: 'running', label: t('tracePage.statusRunning') },
        { value: 'success', label: t('tracePage.statusSuccess') },
        { value: 'failed', label: t('tracePage.statusFailed') },
    ];
    const timeOptions: SelectOption[] = [
        { value: 'all', label: t('common.allTime') },
        { value: '7d', label: t('nav.last7Days') },
        { value: '24h', label: t('topbar.last24h') },
        { value: '1h', label: t('nav.last1Hour') },
    ];
    const agentOptions: SelectOption[] = [{ value: 'all', label: t('common.all') }, ...availableAgents.map(a => ({ value: a, label: a }))];
    const skillOptions: SelectOption[] = [{ value: 'all', label: t('common.all') }, ...availableSkills.map(s => ({ value: s, label: s }))];
    const frameworkOptions: SelectOption[] = [{ value: 'all', label: t('common.all') }, ...frameworks.map(f => ({ value: f, label: f }))];

    return (
        <>
            <AppTopBar title={<Term id="trace" label={t('nav.trace')} />} actions={undefined} showDefaultActions={false} />
            <PageContainer>
                {selectedExecution ? (
                    <TraceDetailView
                        execution={selectedExecution}
                        onBack={() => handleSelectExecution(null)}
                    />
                ) : (
                    <>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                            <StatCard
                                label={<Term id="trace" label={t('tracePage.statTotal')} />}
                                value={stats.total.toLocaleString()}
                            />
                            <StatCard
                                label={<Term id="fault-item" label={t('tracePage.statFailed')} />}
                                value={String(stats.failedCount)}
                                accent={stats.failedCount > 0 ? 'error' : undefined}
                            />
                            <StatCard label={t('tracePage.statAvgLatency')} value={fmtSec(stats.avgLatency)} />
                            <StatCard
                                label={<Term id="tool-error-rate" label={t('tracePage.statToolErrorRate')} align="end" />}
                                value={`${stats.errRate}%`}
                            />
                        </div>

                        <PageToolbar className="border border-border bg-background-secondary rounded-md p-2 mb-3">
                            <Select
                                label={t('nav.filterAgentOwnership')}
                                value={ownershipFilter}
                                onChange={setOwnershipFilter}
                                options={ownershipOptions}
                                active={ownershipFilter !== 'all'}
                            />
                            {availableAgents.length > 0 && (
                                <Select
                                    label="Agent"
                                    value={agentFilter}
                                    onChange={setAgentFilter}
                                    options={agentOptions}
                                    active={agentFilter !== 'all' && agentFilter !== ''}
                                />
                            )}
                            {availableSkills.length > 0 && (
                                <Select
                                    label="Skill"
                                    value={skillFilter}
                                    onChange={setSkillFilter}
                                    options={skillOptions}
                                    active={skillFilter !== 'all'}
                                />
                            )}
                            <Separator orientation="vertical" className="h-5" />
                            <Select
                                label={t('tracePage.filterStatus')}
                                value={anomalyFilter}
                                onChange={setAnomalyFilter}
                                options={statusOptions}
                                active={anomalyFilter !== 'all'}
                            />
                            <Select
                                label={t('tracePage.filterTime')}
                                value={timeFilter}
                                onChange={setTimeFilter}
                                options={timeOptions}
                                active={timeFilter !== 'all'}
                            />
                            {frameworks.length > 1 && (
                                <Select
                                    label={t('tracePage.filterPlatform')}
                                    value={frameworkFilter}
                                    onChange={setFrameworkFilter}
                                    options={frameworkOptions}
                                    active={frameworkFilter !== 'all'}
                                />
                            )}
                            <Select
                                label={locale === 'zh' ? '范围' : 'Scope'}
                                value={agentScopeFilter}
                                onChange={setAgentScopeFilter}
                                options={[
                                    { value: 'root', label: locale === 'zh' ? '仅主 Agent' : 'Root only' },
                                    { value: 'subagent', label: locale === 'zh' ? '仅子 Agent' : 'Sub-agents only' },
                                    { value: 'all', label: locale === 'zh' ? '主 + 子 Agent' : 'Root + sub-agents' },
                                ]}
                                active={agentScopeFilter !== 'root'}
                            />
                            {hasActiveFilters && (
                                <Button variant="ghost" size="sm" onClick={resetFilters} className="ml-auto text-xs text-foreground-muted h-7">
                                    <XIcon className="size-3" />
                                    {t('tracePage.resetFilters')}
                                </Button>
                            )}
                        </PageToolbar>

                        <div className="flex items-center justify-between mb-2">
                            <h2 className="text-sm font-semibold text-foreground">
                                {t('tracePage.listTitle')}
                                <span className="ml-2 text-foreground-muted font-normal tabular-nums">{filtered.length}</span>
                            </h2>
                            <div className="flex items-center gap-3">
                                {isCustomized && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={resetColumnWidths}
                                        className="h-7 px-2 text-xs text-foreground-muted gap-1"
                                    >
                                        <RotateCcw className="size-3" aria-hidden />
                                        {t('tracePage.resetColumnWidths')}
                                    </Button>
                                )}
                                <span className="text-xs text-foreground-muted">
                                    {t('tracePage.listHint')}
                                </span>
                            </div>
                        </div>

                        <PageContent className="flex flex-col">
                            <div className="flex-1 min-h-0 rounded-md border border-card-border bg-card overflow-auto">
                                {loading ? (
                                    <div className="p-4 space-y-2">
                                        {[0, 1, 2, 3, 4].map(i => <Skeleton key={i} className="h-8 w-full" />)}
                                    </div>
                                ) : pageItems.length === 0 ? (
                                    <EmptyState
                                        title={t('tracePage.emptyTitle')}
                                        description={hasActiveFilters ? t('tracePage.emptyDescription') : undefined}
                                        action={hasActiveFilters ? (
                                            <Button variant="outline" size="sm" onClick={resetFilters}>
                                                {t('tracePage.resetFilters')}
                                            </Button>
                                        ) : undefined}
                                    />
                                ) : (
                                    <table className="w-full table-fixed text-sm" style={{ minWidth: tableMinWidth }}>
                                        <colgroup>
                                            <col style={{ width: widths.traceId }} />
                                            <col style={{ width: widths.agent }} />
                                            <col style={{ width: widths.status }} />
                                            <col style={{ width: widths.tags }} />
                                            <col />
                                            <col style={{ width: widths.time }} />
                                            <col style={{ width: widths.actions }} />
                                        </colgroup>
                                        <thead className="sticky top-0 z-10">
                                            <tr className="bg-background-secondary text-left">
                                                <Th colKey="traceId" currentWidth={widths.traceId} onResize={setColumnWidth}>
                                                    <Term id="trace" label={t('tracePage.columnTraceId')} />
                                                </Th>
                                                <SortableTh sortKey="agent" currentKey={sortKey as SortKey} dir={sortDir as SortDir} onSort={handleSort} colKey="agent" currentWidth={widths.agent} onResize={setColumnWidth}>
                                                    <Term id="agent" label={t('tracePage.columnAgent')} />
                                                </SortableTh>
                                                <SortableTh sortKey="status" currentKey={sortKey as SortKey} dir={sortDir as SortDir} onSort={handleSort} colKey="status" currentWidth={widths.status} onResize={setColumnWidth}>
                                                    <Term id="chain-status" label={t('tracePage.columnStatus')} />
                                                </SortableTh>
                                                <Th colKey="tags" currentWidth={widths.tags} onResize={setColumnWidth}>{t('tracePage.columnTags')}</Th>
                                                <Th>{t('tracePage.columnTask')}</Th>
                                                <SortableTh sortKey="timestamp" currentKey={sortKey as SortKey} dir={sortDir as SortDir} onSort={handleSort} colKey="time" currentWidth={widths.time} onResize={setColumnWidth}>{t('tracePage.columnTime')}</SortableTh>
                                                <Th align="right" colKey="actions" currentWidth={widths.actions} onResize={setColumnWidth}>{t('tracePage.columnActions')}</Th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {pageItems.map((e, i) => (
                                                <Row
                                                    key={(e.task_id || e.upload_id || i) + ''}
                                                    execution={e}
                                                    onClick={() => handleSelectExecution(e)}
                                                />
                                            ))}
                                        </tbody>
                                    </table>
                                )}
                            </div>
                        </PageContent>

                        {filtered.length > 0 && (
                            <PageFooter className="border-0 mt-3 pt-0 shrink-0">
                                <Pagination
                                    className="w-full"
                                    page={page}
                                    pageSize={pageSize}
                                    total={filtered.length}
                                    onPageChange={setPage}
                                    onPageSizeChange={setPageSize}
                                    pageSizes={PAGE_SIZE_OPTIONS}
                                    pageSizeLabel={n => t('tracePage.pageSize', { n: String(n) })}
                                    summary={(start, end, total) => t('tracePage.pageSummary', {
                                        start: String(start),
                                        end: String(end),
                                        total: String(total),
                                    })}
                                />
                            </PageFooter>
                        )}
                    </>
                )}
            </PageContainer>
        </>
    );
}

function TraceDetailView({
    execution,
    onBack,
}: {
    execution: Execution;
    onBack: () => void;
}) {
    const { t, locale } = useLocale();
    const router = useRouter();
    const searchParams = useSearchParams();
    const [session, setSession] = useState<any | null>(null);
    const [loading, setLoading] = useState(false);
    const taskId = execution.task_id || execution.upload_id || '';
    // 多 Agent 拆分：当前 trace 可能本身就是某个 sub-agent execution，
    // 通过 parent_execution_id / is_subagent 判断并在 header 显示返回父执行入口。
    const execAny = execution as any;
    const isSubagentTrace: boolean = !!execAny.is_subagent;
    const parentExecutionId: string | null = execAny.parent_execution_id || null;
    const subagentType: string | null = execAny.subagent_type || null;
    const subagentName: string | null = execAny.subagent_name || null;

    const navigateToTaskId = useCallback((newTaskId: string) => {
        if (!newTaskId) return;
        const params = new URLSearchParams(searchParams?.toString() ?? '');
        params.set('taskId', newTaskId);
        router.push(`${window.location.pathname}?${params.toString()}`, { scroll: false });
    }, [router, searchParams]);

    const navigateToParent = useCallback(async () => {
        if (!parentExecutionId) return;
        try {
            // parent_execution_id 是 Execution.id，不是 taskId；需要换算一次。
            // 复用 /api/observe/data?taskIds=… 不行（这是 taskId 入口），改用专用查询。
            const res = await apiFetch(`/api/observe/data?executionId=${encodeURIComponent(parentExecutionId)}&includeEvaluations=0`);
            if (!res.ok) return;
            const arr = await res.json();
            const parent = Array.isArray(arr) ? arr[0] : (arr?.data?.[0] || arr);
            const parentTaskId = parent?.task_id || parent?.upload_id;
            if (parentTaskId) navigateToTaskId(parentTaskId);
        } catch { /* ignore */ }
    }, [parentExecutionId, navigateToTaskId]);

    const execStatus = getExecStatus(execution);
    const [autoRefresh, setAutoRefresh] = useState(execStatus === 'running');
    const [refreshIntervalSec, setRefreshIntervalSec] = useState(5);
    const [secondsSinceRefresh, setSecondsSinceRefresh] = useState(0);

    // 用 ref 跟踪当前 session，避免把 session 加进 fetchSession 依赖导致循环。
    // 切换 trace（从 xuanyuan → dayu）时，sessionRef.current 是上一个 trace 的非空数据 → 不显示 loading skeleton，
    // 保留旧 trace 渲染直到新数据到达，肉眼无闪烁。首次加载（无旧 session）才显示 loading。
    const sessionRef = useRef<any | null>(null);
    useEffect(() => { sessionRef.current = session; }, [session]);

    const fetchSession = useCallback((silent = false) => {
        if (!taskId) return;
        const isInitial = !sessionRef.current;
        if (!silent && isInitial) setLoading(true);
        apiFetch(`/api/observe/session?taskId=${encodeURIComponent(taskId)}`)
            .then(r => r.ok ? r.json() : { error: 'Fetch failed' })
            .then(j => { setSession(j); setSecondsSinceRefresh(0); })
            .catch(() => { if (!silent && isInitial) setSession({ error: 'Network error' }); })
            .finally(() => { if (!silent && isInitial) setLoading(false); });
    }, [taskId]);

    useEffect(() => { fetchSession(false); }, [fetchSession]);

    useEffect(() => {
        if (!autoRefresh || execStatus !== 'running') return;
        const id = setInterval(() => fetchSession(true), refreshIntervalSec * 1000);
        return () => clearInterval(id);
    }, [autoRefresh, refreshIntervalSec, fetchSession, execStatus]);

    useEffect(() => {
        const id = setInterval(() => setSecondsSinceRefresh(s => s + 1), 1000);
        return () => clearInterval(id);
    }, []);

    const { framework, latency, tokens, cost } = execution;
    const detailsLink = `${basePath}/details?framework=${encodeURIComponent(framework || '')}&expandTaskId=${taskId}`;
    const isRunning = execStatus === 'running';

    return (
        <div className="flex flex-col h-full min-h-0">
            <div className="rounded-md border border-border bg-card p-3 mb-3 flex flex-wrap items-center gap-2">
                <Button variant="ghost" size="sm" onClick={onBack} className="text-foreground-muted h-7 px-2">
                    <ArrowLeft className="size-3.5" aria-hidden />
                    {t('tracePage.backToList')}
                </Button>
                {isSubagentTrace && parentExecutionId && (
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={navigateToParent}
                        className="text-foreground-muted h-7 px-2"
                        title={locale === 'zh' ? '返回父 Agent 执行' : 'Back to parent agent execution'}
                    >
                        <ArrowLeft className="size-3.5" aria-hidden />
                        {locale === 'zh' ? '父执行' : 'Parent'}
                    </Button>
                )}
                <Separator orientation="vertical" className="h-5" />
                {isSubagentTrace && (
                    <span
                        title={subagentName || ''}
                        className="text-[10px] font-bold tracking-wider px-1.5 py-0.5 rounded-sm bg-primary/10 text-primary border border-primary/30 shrink-0"
                    >
                        SUB-AGENT{subagentType ? ` · ${subagentType}` : ''}
                    </span>
                )}
                <IdChip value={taskId} head={8} tail={6} />
                <StatusBadge
                    status={execStatus === 'running' ? 'running' : execStatus === 'failed' ? 'error' : 'success'}
                    label={
                        execStatus === 'running' ? t('tracePage.statusRunning')
                        : execStatus === 'failed' ? t('tracePage.statusFailed')
                        : t('tracePage.statusNormal')
                    }
                />

                {(typeof tokens === 'number' && tokens > 0) || (typeof latency === 'number' && latency > 0) || (typeof cost === 'number' && cost > 0) ? (
                    <Separator orientation="vertical" className="h-5" />
                ) : null}
                {typeof tokens === 'number' && tokens > 0 && (
                    <MetricPill label={<Term id="tokens" label={t('tracePage.metricTokens')} />} value={tokens.toLocaleString()} />
                )}
                {typeof latency === 'number' && latency > 0 && (
                    <MetricPill label={t('tracePage.metricDuration')} value={fmtSec(toDisplayLatencyMs(latency, framework))} />
                )}
                {typeof cost === 'number' && cost > 0 && (
                    <MetricPill label={t('tracePage.metricCost')} value={`$${cost.toFixed(4)}`} />
                )}

                <div className="ml-auto flex flex-wrap items-center gap-2">
                    <TooltipProvider delayDuration={250}>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant={autoRefresh && isRunning ? 'default' : 'outline'}
                                    size="sm"
                                    disabled={!isRunning}
                                    onClick={() => isRunning && setAutoRefresh(v => !v)}
                                    aria-pressed={autoRefresh && isRunning}
                                    className="h-7 px-2.5 text-xs"
                                >
                                    <RefreshCw className={cn('size-3.5', autoRefresh && isRunning && 'animate-spin')} />
                                    {autoRefresh && isRunning ? t('tracePage.autoRefresh') : t('tracePage.paused')}
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" className="text-xs">
                                {!isRunning ? t('tracePage.autoRefreshUnavailable') : t('tracePage.autoRefresh')}
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>

                    {autoRefresh && isRunning && (
                        <Select
                            value={String(refreshIntervalSec)}
                            onChange={v => setRefreshIntervalSec(Number(v))}
                            options={REFRESH_INTERVAL_OPTIONS.map(s => ({ value: String(s), label: `${s}s` }))}
                            aria-label={t('tracePage.refreshInterval')}
                        />
                    )}
                    <span className="text-xs text-foreground-muted whitespace-nowrap tabular-nums min-w-[36px]">
                        {secondsSinceRefresh === 0 ? t('tracePage.justNow') : t('tracePage.secondsAgo', { s: String(secondsSinceRefresh) })}
                    </span>
                    <Button variant="outline" size="icon" onClick={() => fetchSession(true)} aria-label={t('tracePage.refreshNow')} className="size-7">
                        <RefreshCw className="size-3.5" />
                    </Button>

                    <Separator orientation="vertical" className="h-5" />
                    <Button variant="default" size="sm" asChild className="h-7 text-xs">
                        <Link href={`${basePath}/fault?taskId=${taskId}`}>{t('tracePage.diagnosis')}</Link>
                    </Button>
                    <Button variant="outline" size="sm" asChild className="h-7 text-xs">
                        <a href={detailsLink} target="_blank" rel="noopener noreferrer">
                            {t('tracePage.fullDetails')}
                            <ExternalLinkIcon className="size-3.5" aria-hidden />
                        </a>
                    </Button>
                </div>
            </div>

            {execStatus === 'failed' && execution.failures && execution.failures.length > 0 && (
                <FailureCard failures={execution.failures} />
            )}

            <h2 className="text-sm font-semibold text-foreground mb-2">{t('tracePage.executionTrace')}</h2>
            <div className="min-h-[200px] flex-1 min-h-0">
                {loading ? (
                    <div className="rounded-md border border-card-border bg-card p-4 space-y-2">
                        <Skeleton className="h-6 w-1/2" />
                        <Skeleton className="h-6 w-3/4" />
                        <Skeleton className="h-6 w-2/3" />
                        <Skeleton className="h-6 w-1/2" />
                    </div>
                ) : session?.error ? (
                    <div className="rounded-md border border-error-border bg-error-subtle text-error p-4 text-sm" role="alert">
                        {session.error}
                    </div>
                ) : session?.interactions?.length > 0 ? (
                    <AgentTraceView
                        interactions={session.interactions}
                        onSubagentNavigate={navigateToTaskId}
                    />
                ) : (
                    <div className="rounded-md border border-card-border bg-card">
                        <EmptyState title={t('tracePage.noTrace')} />
                    </div>
                )}
            </div>
        </div>
    );
}

function FailureCard({ failures }: { failures: any[] }) {
    const { t } = useLocale();
    return (
        <div className="mb-3">
            <h3 className="text-sm font-semibold text-foreground mb-2">{t('tracePage.failureDetails')}</h3>
            <div className="rounded-md border-l-4 border-l-error border border-card-border bg-error-subtle/30 overflow-hidden">
                {failures.map((f, i) => (
                    <div
                        key={i}
                        className={cn('p-3 grid gap-1.5', i < failures.length - 1 && 'border-b border-card-border')}
                    >
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-semibold text-error inline-flex items-center gap-1">
                                <XCircle className="size-3.5" aria-hidden />
                                {f.failure_type || t('tracePage.unknownError')}
                            </span>
                            {f.attribution && (
                                <span className="inline-flex items-center rounded-sm border border-border bg-background-secondary text-foreground-muted px-1.5 py-0 text-xs font-medium uppercase tracking-wide">
                                    {f.attribution}
                                </span>
                            )}
                        </div>
                        {f.description && <p className="text-sm text-foreground">{f.description}</p>}
                        {f.context && (
                            <p className="text-xs text-foreground-muted">
                                <span className="font-medium">{t('tracePage.contextLabel')}</span>
                                {f.context}
                            </p>
                        )}
                        {f.recovery && (
                            <p className="text-xs text-success">
                                <span className="font-medium">{t('tracePage.recoveryLabel')}</span>
                                {f.recovery}
                            </p>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}

function MetricPill({ label, value }: { label: React.ReactNode; value: string }) {
    return (
        <span className="inline-flex items-baseline gap-1 text-xs">
            <span className="text-foreground-muted">{label}</span>
            <span className="font-semibold text-foreground tabular-nums">{value}</span>
        </span>
    );
}

function StatCard({ label, value, accent }: { label: React.ReactNode; value: string; accent?: 'error' }) {
    return (
        <div className="rounded-md border border-card-border bg-card p-3">
            <div className="text-xs text-foreground-muted">{label}</div>
            <div className={cn('mt-1 text-xl font-semibold tabular-nums', accent === 'error' ? 'text-error' : 'text-foreground')}>{value}</div>
        </div>
    );
}

function Th({
    children,
    align,
    className,
    colKey,
    currentWidth,
    onResize,
}: {
    children: React.ReactNode;
    align?: 'left' | 'right' | 'center';
    className?: string;
    colKey?: ResizableColKey;
    currentWidth?: number;
    onResize?: (key: ResizableColKey, width: number) => void;
}) {
    const resizable = !!(colKey && onResize && currentWidth != null);
    return (
        <th className={cn(
            'relative px-3 py-2 text-xs font-medium text-foreground-muted border-b border-border whitespace-nowrap',
            align === 'right' && 'text-right',
            align === 'center' && 'text-center',
            className,
        )}>
            {children}
            {resizable && <ResizeHandle colKey={colKey} currentWidth={currentWidth} onResize={onResize} />}
        </th>
    );
}

function SortableTh({
    children, sortKey, currentKey, dir, onSort,
    colKey, currentWidth, onResize,
}: {
    children: React.ReactNode;
    sortKey: SortKey;
    currentKey: SortKey;
    dir: SortDir;
    onSort: (k: SortKey) => void;
    colKey?: ResizableColKey;
    currentWidth?: number;
    onResize?: (key: ResizableColKey, width: number) => void;
}) {
    const active = sortKey === currentKey;
    const resizable = !!(colKey && onResize && currentWidth != null);
    return (
        <th
            scope="col"
            tabIndex={0}
            role="columnheader"
            aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
            onClick={() => onSort(sortKey)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSort(sortKey); } }}
            className={cn(
                'relative px-3 py-2 text-xs font-medium border-b border-border whitespace-nowrap cursor-pointer select-none',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active ? 'text-primary' : 'text-foreground-muted',
            )}
        >
            <span className="inline-flex items-center gap-1">
                {children}
                <span className={cn('text-[10px]', active ? 'opacity-100' : 'opacity-40')}>
                    {active ? (dir === 'asc' ? '▲' : '▼') : '⇅'}
                </span>
            </span>
            {resizable && <ResizeHandle colKey={colKey} currentWidth={currentWidth} onResize={onResize} />}
        </th>
    );
}

function Row({
    execution: e,
    onClick,
}: {
    execution: Execution;
    onClick: () => void;
}) {
    const { t } = useLocale();
    const id = e.task_id || e.upload_id || '';
    const status = getExecStatus(e);
    const skillCount = getInvokedSkillNames(e).length;
    const isMultiAgent = skillCount > 1;
    const statusKind: StatusKind = status === 'running' ? 'running' : status === 'failed' ? 'error' : 'success';
    const statusLabel = status === 'running' ? t('tracePage.statusRunning')
        : status === 'failed' ? t('tracePage.statusFailed')
        : t('tracePage.statusSuccess');

    return (
        <tr
            onClick={onClick}
            onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); onClick(); } }}
            tabIndex={0}
            role="button"
            aria-label={`${t('tracePage.columnTraceId')} ${id}`}
            className="border-b border-border hover:bg-background-secondary focus-visible:outline-none focus-visible:bg-background-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset cursor-pointer transition-colors"
        >
            <Td>
                <IdChip value={id} head={6} tail={4} />
            </Td>
            <Td>
                <TruncateText className="text-foreground text-sm">
                    {e.agent || (e.agents && e.agents.length > 0 ? e.agents[0] : null) || e.framework || '-'}
                </TruncateText>
            </Td>
            <Td>
                <StatusBadge status={statusKind} label={statusLabel} />
            </Td>
            <Td>
                <div className="flex gap-1 flex-wrap">
                    {(e as any).is_subagent ? (
                        <span
                            title={(e as any).subagent_name || (e as any).subagent_type || ''}
                            className="text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded-sm bg-primary/10 text-primary border border-primary/30"
                        >
                            SUB
                        </span>
                    ) : isMultiAgent && (
                        <Tag variant="agent" icon={Users}>Multi-Agent</Tag>
                    )}
                    {skillCount > 0 && (
                        <Tag variant="skill" icon={Layers}>Skills</Tag>
                    )}
                    {e.framework && (
                        <Tag variant="framework" icon={Terminal}>{e.framework}</Tag>
                    )}
                </div>
            </Td>
            <Td>
                <TruncateText className="text-foreground text-sm">
                    {e.query || t('tracePage.noQuery')}
                </TruncateText>
            </Td>
            <Td>
                <RelativeTime value={e.timestamp} className="text-xs text-foreground-secondary font-mono whitespace-nowrap" />
            </Td>
            <Td align="right">
                <div className="inline-flex gap-1 group" onClick={ev => ev.stopPropagation()}>
                    <Button variant="ghost" size="sm" onClick={onClick} className="h-7 px-2 text-xs">
                        {t('tracePage.rowDetail')}
                    </Button>
                    <Button variant="ghost" size="sm" asChild className="h-7 px-2 text-xs">
                        <Link href={`${basePath}/fault?taskId=${id}`}>
                            {t('tracePage.rowAnalysis')}
                        </Link>
                    </Button>
                    <Button variant="ghost" size="sm" asChild className="h-7 px-2 text-xs">
                        <Link href={`${basePath}/eval/trajectory/${id}`}>
                            <Wrench className="size-3" />
                            {t('tracePage.rowEval')}
                        </Link>
                    </Button>
                </div>
            </Td>
        </tr>
    );
}

type TagVariant = 'agent' | 'skill' | 'framework';

const TAG_VARIANT_CLASSES: Record<TagVariant, string> = {
    agent:     'bg-primary-subtle text-primary border-primary-border',
    skill:     'bg-primary-subtle text-primary border-primary-border',
    framework: 'bg-background-secondary text-foreground-secondary border-border',
};

function Tag({
    children,
    variant = 'framework',
    icon: Icon,
}: {
    children: React.ReactNode;
    variant?: TagVariant;
    icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
}) {
    return (
        <span className={cn(
            'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap leading-none',
            TAG_VARIANT_CLASSES[variant],
        )}>
            {Icon && <Icon className="size-3 shrink-0" aria-hidden />}
            {children}
        </span>
    );
}

function Td({ children, align, className }: { children: React.ReactNode; align?: 'left' | 'right' | 'center'; className?: string }) {
    return (
        <td className={cn(
            'px-3 py-2 text-sm text-foreground',
            align === 'right' && 'text-right',
            align === 'center' && 'text-center',
            className,
        )}>
            {children}
        </td>
    );
}
