'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import React, { useCallback, useEffect, useMemo, useRef, useState, Suspense } from 'react';
import {
    ArrowLeft,
    Download,
    Upload,
    RefreshCw,
    X as XIcon,
    XCircle,
    Wrench,
    Users,
    Layers,
    Terminal,
    RotateCcw,
    SlidersHorizontal,
    Columns3,
    Plus,
    Check,
    Database,
} from 'lucide-react';
import { parseAsInteger, parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';

import { AppTopBar } from '@/components/shell/AppTopBar';
import { PageContainer, PageContent, PageFooter } from '@/components/shell/PageContainer';
import AgentTraceView from '@/components/observe/AgentTraceView';
import TraceFilterBar from '@/components/observe/TraceFilterBar';
import TraceFilterSidebar from '@/components/observe/TraceFilterSidebar';
import { TraceBackflowDialog } from '@/components/observe/TraceBackflowDialog';
import type { FilterClause } from '@/lib/filters/types';
import { useAuth } from '@/lib/auth/auth-context';
import { useLocale } from '@/lib/client/locale-context';
import { apiFetch } from '@/lib/client/api';
import { drillTraceEvalUrl } from '@/lib/client/drill-trace-eval';
import { clusterTraceTagsByPrefix, fitTraceTagCount } from '@/lib/trace-tag-clustering';

import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Select, type SelectOption } from '@/components/ui/select';
import { Pagination } from '@/components/ui/pagination';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { StatusBadge, type StatusKind } from '@/components/feedback/StatusBadge';
import { EmptyState } from '@/components/feedback/EmptyState';
import { IdChip } from '@/components/text/IdChip';
import { TruncateText } from '@/components/text/TruncateText';
import { RelativeTime } from '@/components/text/RelativeTime';
import { Term } from '@/components/text/Term';
import { cn } from '@/lib/utils';
import { formatDurationMs, formatLatencySeconds } from '@/lib/latency-format';

const basePath = process.env.NEXT_PUBLIC_URL_PREFIX || '';

interface InvokedSkill {
    name: string;
    version?: number | null;
}

interface TraceUserTag {
    id: string;
    name: string;
    description?: string | null;
    kind: 'version' | 'business';
    color: string;
    createdAt?: string;
    usageCount?: number;
}

interface TraceImportResult {
    fileName: string | null;
    originalRootExecutionId: string;
    rootExecutionId: string;
    rootTaskId: string | null;
    executionCount: number;
    subagentCount: number;
    remappedIds: Array<{ original: string; imported: string }>;
}

interface Execution {
    timestamp: string;
    framework?: string;
    agent?: string;
    agentName?: string;
    query?: string;
    final_result?: string;
    skill?: string;
    /** Primary skill version from Execution.skillVersion. */
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
    trace_status?: 'running' | 'success' | 'failed' | string | null;
    traceStatus?: 'running' | 'success' | 'failed' | string | null;
    trace_completed_at?: string | null;
    traceCompletedAt?: string | null;
    trace_status_reason?: string | null;
    traceStatusReason?: string | null;
    judgment_reason?: string;
    failures?: any[];
    agentOwnership?: string | null;
    user?: string | null;
    userTags?: TraceUserTag[];
}

interface TraceListStats {
    total: number;
    failedCount: number;
    avgLatencyMs: number;
    toolErrorRate: number;
}

interface TracePageResponse {
    records: Execution[];
    total: number;
    page: number;
    pageSize: number;
    stats?: TraceListStats;
}

interface FacetValueRow {
    value?: string | null;
    count?: number;
}

type SortKey = 'timestamp' | 'agent' | 'status' | 'latency' | 'tokens' | 'cost';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
const REFRESH_INTERVAL_OPTIONS = [5, 10, 30, 60] as const;

type TraceColumnKey = 'traceId' | 'agent' | 'status' | 'userTags' | 'systemTags' | 'task' | 'tokens' | 'time' | 'actions';
type ResizableColKey = TraceColumnKey;

const TRACE_COLUMN_ORDER: TraceColumnKey[] = ['traceId', 'agent', 'status', 'userTags', 'systemTags', 'task', 'tokens', 'time', 'actions'];

const DEFAULT_COLUMN_WIDTHS: Record<ResizableColKey, number> = {
    traceId:    130,
    task:       280,
    agent:      170,
    status:     110,
    userTags:   220,
    systemTags: 220,
    tokens:     110,
    time:       120,
    actions:    220,
};
const MIN_COLUMN_WIDTH: Record<ResizableColKey, number> = {
    traceId:    90,
    task:       280,
    agent:      100,
    status:     80,
    userTags:   150,
    systemTags: 140,
    tokens:     70,
    time:       80,
    actions:    160,
};
const DEFAULT_COLUMN_VISIBILITY: Record<TraceColumnKey, boolean> = {
    traceId: true,
    agent: true,
    status: true,
    userTags: true,
    systemTags: false,
    task: true,
    tokens: true,
    time: true,
    actions: true,
};
const MAX_COLUMN_WIDTH = 640;
const MAX_TASK_COLUMN_WIDTH = 1600;
const COL_WIDTHS_STORAGE_KEY = 'trace.columnWidths.v1';
const COL_VISIBILITY_STORAGE_KEY = 'trace.columnVisibility.v1';
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

function getExecStatus(e: Execution): 'running' | 'success' | 'failed' {
    const status = String(e.trace_status ?? e.traceStatus ?? '').trim().toLowerCase();
    if (status === 'running' || status === 'success' || status === 'failed') return status;
    return e.trace_completed_at || e.traceCompletedAt ? 'success' : 'running';
}

function getFrameworkLabel(framework?: string | null): string {
    const value = String(framework || '').trim();
    switch (value.toLowerCase()) {
        case 'langfuse-langgraph':
            return 'Langfuse-Langgraph';
        case 'opencode':
            return 'OpenCode';
        case 'claude':
        case 'claudecode':
            return 'Claude Code';
        case 'hermes':
            return 'Hermes';
        default:
            return value;
    }
}

function safeFilenameSegment(value: string): string {
    return value
        .replace(/[\\/:*?"<>|]+/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 120) || 'trace';
}

function clampColumnWidth(key: ResizableColKey, width: number): number {
    const maxWidth = key === 'task' ? MAX_TASK_COLUMN_WIDTH : MAX_COLUMN_WIDTH;
    return Math.min(maxWidth, Math.max(MIN_COLUMN_WIDTH[key], Math.round(width)));
}

function useColumnWidths() {
    const [widths, setWidths] = useState<Record<ResizableColKey, number>>(DEFAULT_COLUMN_WIDTHS);
    const [tableWidth, setTableWidth] = useState<number | null>(null);
    const [taskWidthCustomized, setTaskWidthCustomized] = useState(false);

    // Hydrate from localStorage on mount (skipped on server).
    useEffect(() => {
        try {
            const raw = window.localStorage.getItem(COL_WIDTHS_STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw) as Partial<Record<ResizableColKey, number>> & {
                tags?: number;
                tableWidth?: number;
            };
            setWidths(prev => {
                const next = { ...prev };
                (Object.keys(prev) as ResizableColKey[]).forEach(k => {
                    const v = parsed[k];
                    if (typeof v === 'number' && Number.isFinite(v)) next[k] = clampColumnWidth(k, v);
                });
                if (typeof parsed.tags === 'number' && Number.isFinite(parsed.tags)) {
                    next.systemTags = clampColumnWidth('systemTags', parsed.tags);
                }
                return next;
            });
            if (typeof parsed.task === 'number' && Number.isFinite(parsed.task)) {
                setTaskWidthCustomized(true);
            }
            if (typeof parsed.tableWidth === 'number' && Number.isFinite(parsed.tableWidth)) {
                setTableWidth(Math.max(0, Math.round(parsed.tableWidth)));
            }
        } catch { /* ignore */ }
    }, []);

    const setColumnWidth = useCallback((key: ResizableColKey, width: number, nextTableWidth?: number) => {
        if (key === 'task') setTaskWidthCustomized(true);
        setWidths(prev => {
            const next = { ...prev, [key]: clampColumnWidth(key, width) };
            const normalizedTableWidth = typeof nextTableWidth === 'number' && Number.isFinite(nextTableWidth)
                ? Math.max(0, Math.round(nextTableWidth))
                : tableWidth;
            if (normalizedTableWidth != null) setTableWidth(normalizedTableWidth);
            try {
                window.localStorage.setItem(COL_WIDTHS_STORAGE_KEY, JSON.stringify({
                    ...next,
                    ...(normalizedTableWidth != null ? { tableWidth: normalizedTableWidth } : {}),
                }));
            } catch { /* ignore */ }
            return next;
        });
    }, [tableWidth]);

    const resetColumnWidths = useCallback(() => {
        setWidths(DEFAULT_COLUMN_WIDTHS);
        setTableWidth(null);
        setTaskWidthCustomized(false);
        try { window.localStorage.removeItem(COL_WIDTHS_STORAGE_KEY); } catch { /* ignore */ }
    }, []);

    const isCustomized = useMemo(
        () => tableWidth != null
            || taskWidthCustomized
            || (Object.keys(DEFAULT_COLUMN_WIDTHS) as ResizableColKey[])
                .some(k => widths[k] !== DEFAULT_COLUMN_WIDTHS[k]),
        [tableWidth, taskWidthCustomized, widths],
    );

    return { widths, tableWidth, taskWidthCustomized, setColumnWidth, resetColumnWidths, isCustomized };
}

function useColumnVisibility() {
    const [columnVisibility, setColumnVisibility] = useState<Record<TraceColumnKey, boolean>>(DEFAULT_COLUMN_VISIBILITY);

    useEffect(() => {
        try {
            const raw = window.localStorage.getItem(COL_VISIBILITY_STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw) as Partial<Record<TraceColumnKey, boolean>>;
            setColumnVisibility(prev => {
                const next = { ...prev };
                TRACE_COLUMN_ORDER.forEach(key => {
                    if (typeof parsed[key] === 'boolean') next[key] = parsed[key] as boolean;
                });
                return next;
            });
        } catch { /* ignore */ }
    }, []);

    const setColumnVisible = useCallback((key: TraceColumnKey, visible: boolean) => {
        setColumnVisibility(prev => {
            const next = { ...prev, [key]: visible };
            try { window.localStorage.setItem(COL_VISIBILITY_STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
            return next;
        });
    }, []);

    const resetColumnVisibility = useCallback(() => {
        setColumnVisibility(DEFAULT_COLUMN_VISIBILITY);
        try { window.localStorage.removeItem(COL_VISIBILITY_STORAGE_KEY); } catch { /* ignore */ }
    }, []);

    const isVisibilityCustomized = useMemo(
        () => TRACE_COLUMN_ORDER.some(key => columnVisibility[key] !== DEFAULT_COLUMN_VISIBILITY[key]),
        [columnVisibility],
    );

    return { columnVisibility, setColumnVisible, resetColumnVisibility, isVisibilityCustomized };
}

function getExecutionRowKey(execution: Execution): string {
    return execution.upload_id || execution.task_id || '';
}

function mergeTraceTags(prev: TraceUserTag[], tag: TraceUserTag): TraceUserTag[] {
    const next = prev.some(item => item.id === tag.id)
        ? prev.map(item => item.id === tag.id ? tag : item)
        : [...prev, tag];
    return next.slice().sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind));
}

function ResizeHandle({
    colKey,
    currentWidth,
    onResize,
}: {
    colKey: ResizableColKey;
    currentWidth: number;
    onResize: (key: ResizableColKey, width: number, tableWidth?: number) => void;
}) {
    const onMouseDown = (e: React.MouseEvent<HTMLSpanElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startW = e.currentTarget.closest('th')?.getBoundingClientRect().width ?? currentWidth;
        const startTableWidth = e.currentTarget.closest('table')?.getBoundingClientRect().width;
        const handleMove = (ev: MouseEvent) => {
            const nextColumnWidth = clampColumnWidth(colKey, startW + (ev.clientX - startX));
            const appliedDelta = nextColumnWidth - startW;
            onResize(
                colKey,
                nextColumnWidth,
                startTableWidth == null ? undefined : startTableWidth + appliedDelta,
            );
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
    const [total, setTotal] = useState(0);
    const [stats, setStats] = useState<TraceListStats>({
        total: 0,
        failedCount: 0,
        avgLatencyMs: 0,
        toolErrorRate: 0,
    });
    const [loading, setLoading] = useState(true);
    const [selectedExecution, setSelectedExecution] = useState<Execution | null>(null);
    const [selectedTracesByKey, setSelectedTracesByKey] = useState<Map<string, Execution>>(() => new Map());
    const [batchBackflowOpen, setBatchBackflowOpen] = useState(false);
    const [availableTags, setAvailableTags] = useState<TraceUserTag[]>([]);
    const [frameworks, setFrameworks] = useState<string[]>([]);
    const [mainAgents, setMainAgents] = useState<string[]>([]);
    const importInputRef = useRef<HTMLInputElement>(null);
    const [importing, setImporting] = useState(false);
    const [importResult, setImportResult] = useState<TraceImportResult | null>(null);
    const [reloadKey, setReloadKey] = useState(0);

    // URL-persisted filter / sort / paging state (docs/design/patterns.md §1 + §11).
    const [timeFilter, setTimeFilter] = useQueryState('time', parseAsString.withDefault('all'));
    const [anomalyFilter, setAnomalyFilter] = useQueryState('status', parseAsString.withDefault('all'));
    const [frameworkFilter, setFrameworkFilter] = useQueryState('framework', parseAsString.withDefault('all'));
    const [agentFilter, setAgentFilter] = useQueryState('agent', parseAsString.withDefault('all'));
    const [skillFilter, setSkillFilter] = useQueryState('skill', parseAsString.withDefault('all'));
    const [businessTagFilter, setBusinessTagFilter] = useQueryState('bizTag', parseAsString.withDefault('all'));
    const [ownershipFilter, setOwnershipFilter] = useQueryState('ownership', parseAsString.withDefault('user'));
    const [agentScopeFilter, setAgentScopeFilter] = useQueryState('scope', parseAsString.withDefault('root'));
    const [sortKey, setSortKey] = useQueryState('sort', parseAsString.withDefault('timestamp'));
    const [sortDir, setSortDir] = useQueryState('dir', parseAsString.withDefault('desc'));
    const [page, setPage] = useQueryState('page', parseAsInteger.withDefault(1));
    const [pageSize, setPageSize] = useQueryState('size', parseAsInteger.withDefault(20));
    const [taskIdParam, setTaskIdParam] = useQueryState('taskId', parseAsString);
    const [search, setSearch] = useQueryState('q', parseAsString.withDefault(''));
    const [showFilters, setShowFilters] = useState(false);
    const [clausesRaw, setClausesRaw] = useQueryState('f', parseAsString.withDefault(''));
    const clauses = useMemo<FilterClause[]>(() => {
        if (!clausesRaw) return [];
        try {
            const p = JSON.parse(clausesRaw);
            return Array.isArray(p) ? (p as FilterClause[]) : [];
        } catch {
            return [];
        }
    }, [clausesRaw]);
    const setClauses = useCallback(
        (next: FilterClause[]) => setClausesRaw(next.length ? JSON.stringify(next) : null),
        [setClausesRaw],
    );
    const handleSearchChange = useCallback((v: string) => setSearch(v || null), [setSearch]);

    const loadAvailableTags = useCallback(() => {
        if (!user) {
            setAvailableTags([]);
            return;
        }
        apiFetch(`/api/tags?user=${encodeURIComponent(user)}`)
            .then(r => r.ok ? r.json() : [])
            .then(rows => setAvailableTags(Array.isArray(rows) ? rows : []))
            .catch(() => setAvailableTags([]));
    }, [user]);

    useEffect(() => {
        loadAvailableTags();
    }, [loadAvailableTags]);

    useEffect(() => {
        if (!user) {
            setFrameworks([]);
            setMainAgents([]);
            return;
        }
        Promise.all([
            apiFetch(`/api/observe/data?user=${encodeURIComponent(user)}&facet=values&column=framework`)
                .then(r => r.ok ? r.json() : []),
            apiFetch(`/api/observe/data?user=${encodeURIComponent(user)}&summary=agents&databasePagination=1`)
                .then(r => r.ok ? r.json() : { agents: [] }),
        ]).then(([frameworkRows, agentRows]) => {
            setFrameworks(Array.isArray(frameworkRows)
                ? (frameworkRows as FacetValueRow[]).map(item => String(item?.value || '')).filter(Boolean)
                : []);
            setMainAgents(Array.isArray(agentRows?.agents)
                ? agentRows.agents.map((item: unknown) => String(item || '')).filter(Boolean)
                : []);
        }).catch(() => {
            setFrameworks([]);
            setMainAgents([]);
        });
    }, [user]);

    const handleTraceTagsChanged = useCallback((executionId: string, tags: TraceUserTag[]) => {
        setData(prev => prev.map(item => (
            item.upload_id === executionId || item.task_id === executionId
                ? { ...item, userTags: tags }
                : item
        )));
        setSelectedExecution(prev => prev && (prev.upload_id === executionId || prev.task_id === executionId)
            ? { ...prev, userTags: tags }
            : prev);
    }, []);

    const handleTraceTagCreated = useCallback((tag: TraceUserTag) => {
        setAvailableTags(prev => mergeTraceTags(prev, tag));
    }, []);

    const businessTagOptions: SelectOption[] = useMemo(() => [
        { value: 'all', label: locale === 'zh' ? '全部业务标签' : 'All business tags' },
        ...availableTags
            .filter(tag => tag.kind === 'business')
            .map(tag => ({
                value: tag.id,
                label: tag.usageCount ? `${tag.name} (${tag.usageCount})` : tag.name,
            })),
    ], [availableTags, locale]);

    const columnLabels = useMemo<Record<TraceColumnKey, string>>(() => ({
        traceId: t('tracePage.columnTraceId'),
        agent: t('tracePage.columnAgent'),
        status: t('tracePage.columnStatus'),
        userTags: t('tracePage.columnUserTags'),
        systemTags: t('tracePage.columnSystemTags'),
        task: t('tracePage.columnTask'),
        tokens: t('tracePage.columnTokens'),
        time: t('tracePage.columnTime'),
        actions: t('tracePage.columnActions'),
    }), [t]);

    const {
        widths,
        tableWidth,
        taskWidthCustomized,
        setColumnWidth,
        resetColumnWidths,
        isCustomized,
    } = useColumnWidths();
    const { columnVisibility, setColumnVisible, resetColumnVisibility, isVisibilityCustomized } = useColumnVisibility();
    const tableMinWidth = useMemo(() => {
        const fixedWidth = (Object.keys(DEFAULT_COLUMN_WIDTHS) as ResizableColKey[])
            .filter(key => columnVisibility[key])
            .reduce((sum, key) => sum + widths[key], 0);
        return 44 + fixedWidth;
    }, [widths, columnVisibility]);

    const handleSelectExecution = useCallback((e: Execution | null) => {
        setSelectedExecution(e);
        const id = e ? (e.task_id || e.upload_id || null) : null;
        setTaskIdParam(id);
    }, [setTaskIdParam]);

    // Resolve selectedExecution from URL on data load or URL change.
    //   - data 列表里没这条(比如系统 agent grayscale-* 被前端过滤掉)
    const fetchGuardRef = useRef<string | null>(null);
    const listRequestIdRef = useRef(0);
    const listFilterKey = useMemo(() => JSON.stringify([
        agentScopeFilter,
        skillFilter,
        businessTagFilter,
        search,
        clausesRaw,
        frameworkFilter,
        agentFilter,
        ownershipFilter,
        anomalyFilter,
        timeFilter,
        sortKey,
        sortDir,
        pageSize,
    ]), [
        agentScopeFilter,
        skillFilter,
        businessTagFilter,
        search,
        clausesRaw,
        frameworkFilter,
        agentFilter,
        ownershipFilter,
        anomalyFilter,
        timeFilter,
        sortKey,
        sortDir,
        pageSize,
    ]);
    const previousListFilterKeyRef = useRef(listFilterKey);
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
        if (fetchGuardRef.current === taskIdParam) return;
        fetchGuardRef.current = taskIdParam;
        apiFetch(`/api/observe/data?taskId=${encodeURIComponent(taskIdParam)}&includeEvaluations=0&skipAutoEvalReady=1`)
            .then(async r => ({ ok: r.ok, status: r.status, body: await r.json() }))
            .then(({ ok, status, body }) => {
                if (fetchGuardRef.current !== taskIdParam) return;
                if (!ok && status !== 404) throw new Error('Trace lookup failed');
                const d = body as Execution[];
                if (Array.isArray(d) && d.length > 0) {
                    setSelectedExecution(d[0]);
                    return;
                }
                setSelectedExecution(null);
                void setTaskIdParam(null);
                toast.error(locale === 'zh' ? '未找到对应的子 Agent Trace' : 'Sub-agent trace not found');
            })
            .catch(() => {
                if (fetchGuardRef.current !== taskIdParam) return;
                fetchGuardRef.current = null;
                toast.error(locale === 'zh' ? '子 Agent Trace 加载失败' : 'Failed to load sub-agent trace');
            });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [taskIdParam, data]);

    useEffect(() => {
        const requestId = ++listRequestIdRef.current;
        const filtersChanged = previousListFilterKeyRef.current !== listFilterKey;
        previousListFilterKeyRef.current = listFilterKey;
        if (filtersChanged && page !== 1) {
            void setPage(1);
            return;
        }
        if (!user) return;
        setLoading(true);
        const scopeParam = agentScopeFilter === 'subagent'
            ? '&onlySubagents=1'
            : agentScopeFilter === 'all'
                ? '&includeSubagents=1'
                : '';
        const skillParam = skillFilter !== 'all' ? `&skill=${encodeURIComponent(skillFilter)}` : '';
        const searchParam = search ? `&query=${encodeURIComponent(search)}` : '';
        const filtersParam = clauses.length ? `&filters=${encodeURIComponent(JSON.stringify(clauses))}` : '';
        const bizTagParam = businessTagFilter !== 'all' ? `&bizTag=${encodeURIComponent(businessTagFilter)}` : '';
        const frameworkParam = frameworkFilter !== 'all' ? `&framework=${encodeURIComponent(frameworkFilter)}` : '';
        const agentParam = agentFilter !== 'all' ? `&agentName=${encodeURIComponent(agentFilter)}` : '';
        const ownershipParam = ownershipFilter !== 'all' ? `&ownership=${encodeURIComponent(ownershipFilter)}` : '';
        apiFetch(`/api/observe/data?user=${encodeURIComponent(user)}&paginated=1&databasePagination=1&page=${page}&pageSize=${pageSize}&sort=${encodeURIComponent(sortKey)}&dir=${encodeURIComponent(sortDir)}&time=${encodeURIComponent(timeFilter)}&status=${encodeURIComponent(anomalyFilter)}&includeEvaluations=0&fields=light&includeTags=1&skipAutoEvalReady=1${scopeParam}${skillParam}${searchParam}${filtersParam}${bizTagParam}${frameworkParam}${agentParam}${ownershipParam}`)
            .then(r => r.json())
            .then((response: TracePageResponse) => {
                if (listRequestIdRef.current !== requestId) return;
                const records = Array.isArray(response?.records) ? response.records : [];
                setData(records);
                setTotal(typeof response?.total === 'number' ? response.total : 0);
                setStats(response?.stats ?? {
                    total: typeof response?.total === 'number' ? response.total : 0,
                    failedCount: 0,
                    avgLatencyMs: 0,
                    toolErrorRate: 0,
                });
            })
            .catch(() => {
                if (listRequestIdRef.current !== requestId) return;
                setData([]);
                setTotal(0);
                setStats({ total: 0, failedCount: 0, avgLatencyMs: 0, toolErrorRate: 0 });
            })
            .finally(() => {
                if (listRequestIdRef.current === requestId) setLoading(false);
            });
    }, [
        user,
        agentScopeFilter,
        skillFilter,
        businessTagFilter,
        search,
        clausesRaw,
        frameworkFilter,
        agentFilter,
        ownershipFilter,
        anomalyFilter,
        timeFilter,
        sortKey,
        sortDir,
        page,
        pageSize,
        reloadKey,
        listFilterKey,
        setPage,
    ]);

    const handleImportFile = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file || !user) return;
        if (file.size > 50 * 1024 * 1024) {
            toast.error(locale === 'zh' ? 'Trace 文件不能超过 50 MB' : 'Trace file must be 50 MB or smaller');
            return;
        }
        setImporting(true);
        try {
            let bundle: unknown;
            try {
                bundle = JSON.parse(await file.text());
            } catch {
                throw new Error(locale === 'zh' ? '文件不是有效的 JSON' : 'The file is not valid JSON');
            }
            const response = await apiFetch('/api/observe/traces/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user, fileName: file.name, bundle }),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload?.error || (locale === 'zh' ? '导入 Trace 失败' : 'Failed to import trace'));
            setImportResult(payload as TraceImportResult);
            setReloadKey(value => value + 1);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : (locale === 'zh' ? '导入 Trace 失败' : 'Failed to import trace'));
        } finally {
            setImporting(false);
        }
    }, [locale, user]);

    const handleSort = (key: SortKey) => {
        if (key === sortKey) {
            setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
        } else {
            setSortKey(key);
            setSortDir(key === 'timestamp' || key === 'tokens' ? 'desc' : 'asc');
        }
    };

    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const pageItems = data;

    const selectedTraceKeys = useMemo(
        () => new Set(selectedTracesByKey.keys()),
        [selectedTracesByKey],
    );
    const selectedTraces = useMemo(
        () => Array.from(selectedTracesByKey.values()),
        [selectedTracesByKey],
    );
    const pageTraceKeys = useMemo(
        () => pageItems.map(getExecutionRowKey).filter(Boolean),
        [pageItems],
    );
    const selectedPageCount = pageTraceKeys.filter(key => selectedTraceKeys.has(key)).length;
    const allPageSelected = pageTraceKeys.length > 0 && selectedPageCount === pageTraceKeys.length;
    const somePageSelected = selectedPageCount > 0 && !allPageSelected;

    const toggleTraceSelection = useCallback((execution: Execution) => {
        const key = getExecutionRowKey(execution);
        if (!key) return;
        setSelectedTracesByKey(previous => {
            const next = new Map(previous);
            if (next.has(key)) next.delete(key);
            else next.set(key, execution);
            return next;
        });
    }, []);

    const toggleCurrentPage = useCallback(() => {
        setSelectedTracesByKey(previous => {
            const next = new Map(previous);
            const shouldSelect = pageTraceKeys.some(key => !next.has(key));
            pageItems.forEach(execution => {
                const key = getExecutionRowKey(execution);
                if (!key) return;
                if (shouldSelect) next.set(key, execution);
                else next.delete(key);
            });
            return next;
        });
    }, [pageItems, pageTraceKeys]);

    const clearTraceSelection = useCallback(() => setSelectedTracesByKey(new Map()), []);

    useEffect(() => {
        if (page > totalPages) setPage(totalPages);
    }, [page, totalPages, setPage]);

    const hasActiveFilters = ownershipFilter !== 'all' || agentFilter !== 'all' || skillFilter !== 'all' || businessTagFilter !== 'all'
        || anomalyFilter !== 'all' || timeFilter !== 'all' || frameworkFilter !== 'all'
        || agentScopeFilter !== 'root' || search !== '' || clauses.length > 0;

    const resetFilters = () => {
        setOwnershipFilter('all');
        setAgentFilter('all');
        setSkillFilter('all');
        setBusinessTagFilter('all');
        setAnomalyFilter('all');
        setTimeFilter('all');
        setFrameworkFilter('all');
        setAgentScopeFilter('root');
        setSearch(null);
        setClauses([]);
    };

    // Filter dropdown option sets
    const ownershipOptions: SelectOption[] = [
        { value: 'all', label: t('nav.allOwnership') },
        { value: 'user', label: t('nav.userAgent') },
        { value: 'system', label: t('nav.systemAgent') },
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
        { value: '30m', label: t('nav.last30Min') },
    ];
    const frameworkOptions: SelectOption[] = [
        { value: 'all', label: t('common.all') },
        ...frameworks.map(f => ({ value: f, label: f })),
    ];
    // 主 Agent 下拉选项(全部主 Agent + 当前工作集里出现过的每个主 Agent)。
    const mainAgentOptions: SelectOption[] = [
        { value: 'all', label: t('tracePage.filterMainAgentAll') },
        ...mainAgents.map(a => ({ value: a, label: a })),
    ];
    return (
        <>
            <AppTopBar
                title={<Term id="trace" label={t('nav.trace')} />}
                actions={!selectedExecution ? (
                    <>
                        <input ref={importInputRef} type="file" accept="application/json,.json" className="hidden" onChange={handleImportFile} />
                        <Button variant="outline" size="sm" disabled={!user || importing} onClick={() => importInputRef.current?.click()}>
                            <Download className="size-3.5" aria-hidden />
                            {importing ? (locale === 'zh' ? '导入中…' : 'Importing…') : (locale === 'zh' ? '导入 Trace' : 'Import Trace')}
                        </Button>
                    </>
                ) : undefined}
                showDefaultActions={false}
            />
            <PageContainer>
                {selectedExecution ? (
                    <TraceDetailView
                        execution={selectedExecution}
                        onBack={() => handleSelectExecution(null)}
                        availableTags={availableTags}
                        onTagsChanged={handleTraceTagsChanged}
                        onTagCreated={handleTraceTagCreated}
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
                            <StatCard label={t('tracePage.statAvgLatency')} value={formatDurationMs(stats.avgLatencyMs)} />
                            <StatCard
                                label={<Term id="tool-error-rate" label={t('tracePage.statToolErrorRate')} align="end" />}
                                value={`${stats.toolErrorRate}%`}
                            />
                        </div>

                        {user && (
                            <div className="mb-3">
                                <TraceFilterBar
                                    clauses={clauses}
                                    onChange={setClauses}
                                    search={search}
                                    onSearchChange={handleSearchChange}
                                    user={user}
                                />
                            </div>
                        )}

                        <div className="mb-2 flex flex-wrap items-center gap-2">
                            <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setShowFilters(v => !v)}>
                                <SlidersHorizontal className="size-3.5" />
                                {showFilters ? (locale === 'zh' ? '隐藏过滤' : 'Hide filters') : (locale === 'zh' ? '过滤' : 'Show filters')}
                            </Button>
                            {/* 固定高度竖分隔:不能用 <Separator orientation="vertical">——它带
                                data-[orientation=vertical]:h-full 会拉伸满行高,在 flex-wrap 行里撑坏换行
                                行盒(第二行下拉溢出、与下方列表标题重叠)。用定高 span 规避。 */}
                            <span aria-hidden className="h-5 w-px shrink-0 self-center bg-border" />
                            <Select
                                label={t('nav.filterAgentOwnership')}
                                value={ownershipFilter}
                                onChange={setOwnershipFilter}
                                options={ownershipOptions}
                                active={ownershipFilter !== 'all'}
                            />
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
                            <Select
                                label={t('tracePage.filterFramework')}
                                value={frameworkFilter}
                                onChange={setFrameworkFilter}
                                options={frameworkOptions}
                                active={frameworkFilter !== 'all'}
                            />
                            <Select
                                label={t('tracePage.filterBusinessTag')}
                                value={businessTagFilter}
                                onChange={setBusinessTagFilter}
                                options={businessTagOptions}
                                active={businessTagFilter !== 'all'}
                            />
                            <Select
                                label={t('tracePage.filterMainAgent')}
                                value={agentFilter}
                                onChange={setAgentFilter}
                                options={mainAgentOptions}
                                active={agentFilter !== 'all'}
                            />
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
                                <Button variant="ghost" size="sm" onClick={resetFilters} className="ml-auto h-7 gap-1 text-xs text-foreground-muted">
                                    <XIcon className="size-3" />
                                    {t('tracePage.resetFilters')}
                                </Button>
                            )}
                        </div>

                        <div className="flex-1 min-h-0 flex gap-3">
                            {showFilters && (
                                <aside className="w-60 shrink-0 overflow-auto rounded-md border border-card-border bg-card">
                                    <div className="px-3 py-2 border-b border-card-border">
                                        <span className="text-sm font-semibold">{locale === 'zh' ? '过滤器' : 'Filters'}</span>
                                    </div>
                                    {user && (
                                        <div className="p-3">
                                            <TraceFilterSidebar clauses={clauses} onChange={setClauses} user={user} />
                                        </div>
                                    )}
                                </aside>
                            )}
                            <div className="flex-1 min-w-0 flex flex-col">

                        <div className={cn(
                            'sticky top-0 z-20 flex min-h-9 flex-wrap items-center justify-between gap-3 mb-2 rounded-md',
                            selectedTraces.length > 0 && 'border border-primary-border bg-primary-subtle px-3 py-1.5',
                        )}>
                            {selectedTraces.length > 0 ? (
                                <div className="flex min-w-0 flex-wrap items-center gap-3">
                                    <span className="text-sm font-semibold text-primary">
                                        {locale === 'zh' ? `已选择 ${selectedTraces.length} 条` : `${selectedTraces.length} selected`}
                                    </span>
                                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={toggleCurrentPage}>
                                        {allPageSelected
                                            ? (locale === 'zh' ? '取消当前页' : 'Deselect page')
                                            : (locale === 'zh' ? '全选当前页' : 'Select page')}
                                    </Button>
                                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={clearTraceSelection}>
                                        {locale === 'zh' ? '清空选择' : 'Clear'}
                                    </Button>
                                </div>
                            ) : (
                                <h2 className="text-sm font-semibold text-foreground">
                                    {t('tracePage.listTitle')}
                                    <span className="ml-2 text-foreground-muted font-normal tabular-nums">{total}</span>
                                </h2>
                            )}
                            <div className="flex items-center gap-3">
                                {selectedTraces.length > 0 && (
                                    <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setBatchBackflowOpen(true)}>
                                        <Database className="size-3.5" aria-hidden />
                                        {locale === 'zh' ? '加入评测数据集' : 'Add to dataset'}
                                    </Button>
                                )}
                                {(isCustomized || isVisibilityCustomized) && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => { resetColumnWidths(); resetColumnVisibility(); }}
                                        className="h-7 px-2 text-xs text-foreground-muted gap-1"
                                    >
                                        <RotateCcw className="size-3" aria-hidden />
                                        {t('tracePage.resetColumns')}
                                    </Button>
                                )}
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button variant="outline" size="sm" className="h-7 px-2 text-xs gap-1.5">
                                            <Columns3 className="size-3.5" aria-hidden />
                                            {t('tracePage.columnSettings')}
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" className="w-44">
                                        <DropdownMenuLabel>{t('tracePage.columnSettings')}</DropdownMenuLabel>
                                        {TRACE_COLUMN_ORDER.map(key => (
                                            <DropdownMenuCheckboxItem
                                                key={key}
                                                checked={columnVisibility[key]}
                                                onCheckedChange={checked => setColumnVisible(key, checked === true)}
                                                onSelect={ev => ev.preventDefault()}
                                            >
                                                {columnLabels[key]}
                                            </DropdownMenuCheckboxItem>
                                        ))}
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem onSelect={() => { resetColumnWidths(); resetColumnVisibility(); }}>
                                            <RotateCcw className="size-3.5" aria-hidden />
                                            {t('tracePage.resetColumns')}
                                        </DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
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
                                    <table
                                        className="w-full table-fixed text-sm"
                                        style={{
                                            minWidth: tableMinWidth,
                                            width: tableWidth == null
                                                ? undefined
                                                : `max(100%, ${Math.max(tableWidth, tableMinWidth)}px)`,
                                        }}
                                    >
                                        <colgroup>
                                            <col style={{ width: 44 }} />
                                            {columnVisibility.traceId && <col style={{ width: widths.traceId }} />}
                                            {/* 任务内容放第二列：用户最关心的信息 */}
                                            {columnVisibility.task && (
                                                <col style={{ width: taskWidthCustomized ? widths.task : undefined }} />
                                            )}
                                            {columnVisibility.agent && <col style={{ width: widths.agent }} />}
                                            {columnVisibility.status && <col style={{ width: widths.status }} />}
                                            {columnVisibility.userTags && <col style={{ width: widths.userTags }} />}
                                            {columnVisibility.systemTags && <col style={{ width: widths.systemTags }} />}
                                            {columnVisibility.tokens && <col style={{ width: widths.tokens }} />}
                                            {columnVisibility.time && <col style={{ width: widths.time }} />}
                                            {columnVisibility.actions && <col style={{ width: widths.actions }} />}
                                        </colgroup>
                                        <thead className="sticky top-0 z-10">
                                            <tr className="bg-background-secondary text-left">
                                                <Th>
                                                    <SelectionCheckbox
                                                        checked={allPageSelected}
                                                        indeterminate={somePageSelected}
                                                        onChange={toggleCurrentPage}
                                                        ariaLabel={locale === 'zh' ? '选择当前页 Trace' : 'Select traces on this page'}
                                                    />
                                                </Th>
                                                {columnVisibility.traceId && (
                                                    <Th colKey="traceId" currentWidth={widths.traceId} onResize={setColumnWidth}>
                                                        <Term id="trace" label={t('tracePage.columnTraceId')} />
                                                    </Th>
                                                )}
                                                {columnVisibility.task && (
                                                    <Th colKey="task" currentWidth={widths.task} onResize={setColumnWidth}>
                                                        {t('tracePage.columnTask')}
                                                    </Th>
                                                )}
                                                {columnVisibility.agent && (
                                                    <SortableTh sortKey="agent" currentKey={sortKey as SortKey} dir={sortDir as SortDir} onSort={handleSort} colKey="agent" currentWidth={widths.agent} onResize={setColumnWidth}>
                                                        <Term id="agent" label={t('tracePage.columnAgent')} />
                                                    </SortableTh>
                                                )}
                                                {columnVisibility.status && (
                                                    <SortableTh sortKey="status" currentKey={sortKey as SortKey} dir={sortDir as SortDir} onSort={handleSort} colKey="status" currentWidth={widths.status} onResize={setColumnWidth}>
                                                        <Term id="chain-status" label={t('tracePage.columnStatus')} />
                                                    </SortableTh>
                                                )}
                                                {columnVisibility.userTags && <Th colKey="userTags" currentWidth={widths.userTags} onResize={setColumnWidth}>{t('tracePage.columnUserTags')}</Th>}
                                                {columnVisibility.systemTags && <Th colKey="systemTags" currentWidth={widths.systemTags} onResize={setColumnWidth}>{t('tracePage.columnSystemTags')}</Th>}
                                                {columnVisibility.tokens && (
                                                    <SortableTh sortKey="tokens" currentKey={sortKey as SortKey} dir={sortDir as SortDir} onSort={handleSort} colKey="tokens" currentWidth={widths.tokens} onResize={setColumnWidth}>
                                                        <Term id="tokens" label={t('tracePage.columnTokens')} />
                                                    </SortableTh>
                                                )}
                                                {columnVisibility.time && <SortableTh sortKey="timestamp" currentKey={sortKey as SortKey} dir={sortDir as SortDir} onSort={handleSort} colKey="time" currentWidth={widths.time} onResize={setColumnWidth}>{t('tracePage.columnTime')}</SortableTh>}
                                                {columnVisibility.actions && <Th align="right" colKey="actions" currentWidth={widths.actions} onResize={setColumnWidth}>{t('tracePage.columnActions')}</Th>}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {pageItems.map((e, i) => (
                                                <Row
                                                    key={(e.task_id || e.upload_id || i) + ''}
                                                    execution={e}
                                                    columnVisibility={columnVisibility}
                                                    availableTags={availableTags}
                                                    onTagsChanged={handleTraceTagsChanged}
                                                    onTagCreated={handleTraceTagCreated}
                                                    onClick={() => handleSelectExecution(e)}
                                                    selected={selectedTraceKeys.has(getExecutionRowKey(e))}
                                                    onSelectedChange={() => toggleTraceSelection(e)}
                                                />
                                            ))}
                                        </tbody>
                                    </table>
                                )}
                            </div>
                        </PageContent>

                        {total > 0 && (
                            <PageFooter className="border-0 mt-3 pt-0 shrink-0">
                                <Pagination
                                    className="w-full"
                                    page={page}
                                    pageSize={pageSize}
                                    total={total}
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
                        {user && (
                            <TraceBackflowDialog
                                open={batchBackflowOpen}
                                onOpenChange={setBatchBackflowOpen}
                                user={user}
                                sources={selectedTraces.map(item => ({
                                    taskId: item.task_id || item.upload_id || '',
                                    executionId: item.upload_id,
                                    label: item.query || item.task_id || item.upload_id || 'Trace',
                                }))}
                                onSaved={clearTraceSelection}
                            />
                        )}
                            </div>
                        </div>
                    </>
                )}
            </PageContainer>
            <Dialog open={!!importResult} onOpenChange={open => !open && setImportResult(null)}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle>{locale === 'zh' ? 'Trace 导入成功' : 'Trace imported'}</DialogTitle>
                        <DialogDescription>{locale === 'zh' ? '完整链路已写入当前用户空间。' : 'The complete trace tree was added to your workspace.'}</DialogDescription>
                    </DialogHeader>
                    {importResult && (
                        <div className="rounded-md border border-border bg-background-secondary p-3 text-sm">
                            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2">
                                <dt className="text-foreground-muted">{locale === 'zh' ? '文件' : 'File'}</dt>
                                <dd className="min-w-0 truncate font-mono text-xs">{importResult.fileName || '—'}</dd>
                                <dt className="text-foreground-muted">{locale === 'zh' ? '原 Trace ID' : 'Original trace ID'}</dt>
                                <dd className="min-w-0 break-all font-mono text-xs">{importResult.originalRootExecutionId}</dd>
                                <dt className="text-foreground-muted">{locale === 'zh' ? '新 Trace ID' : 'New trace ID'}</dt>
                                <dd className="min-w-0 break-all font-mono text-xs">{importResult.rootExecutionId}</dd>
                                <dt className="text-foreground-muted">{locale === 'zh' ? '节点' : 'Nodes'}</dt>
                                <dd>{importResult.executionCount} ({locale === 'zh' ? '子 Agent' : 'subagents'}: {importResult.subagentCount})</dd>
                                <dt className="text-foreground-muted">{locale === 'zh' ? 'ID 重映射' : 'ID remaps'}</dt>
                                <dd>{importResult.remappedIds.length}</dd>
                            </dl>
                        </div>
                    )}
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setImportResult(null)}>{locale === 'zh' ? '关闭' : 'Close'}</Button>
                        <Button disabled={!importResult?.rootTaskId && !importResult?.rootExecutionId} onClick={() => {
                            const targetId = importResult?.rootTaskId || importResult?.rootExecutionId;
                            setImportResult(null);
                            if (targetId) void setTaskIdParam(targetId);
                        }}>
                            {locale === 'zh' ? '打开 Trace' : 'Open Trace'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}

function TraceDetailView({
    execution,
    onBack,
    availableTags,
    onTagsChanged,
    onTagCreated,
}: {
    execution: Execution;
    onBack: () => void;
    availableTags: TraceUserTag[];
    onTagsChanged: (executionId: string, tags: TraceUserTag[]) => void;
    onTagCreated: (tag: TraceUserTag) => void;
}) {
    const { t, locale } = useLocale();
    const { user } = useAuth();
    const router = useRouter();
    const searchParams = useSearchParams();
    const [session, setSession] = useState<any | null>(null);
    const [loading, setLoading] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [backflowOpen, setBackflowOpen] = useState(false);
    const taskId = execution.task_id || execution.upload_id || '';
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

    const sessionRef = useRef<any | null>(null);
    useEffect(() => { sessionRef.current = session; }, [session]);

    const fetchSession = useCallback((silent = false) => {
        if (!taskId) return;
        const isInitial = !sessionRef.current;
        if (!silent && isInitial) setLoading(true);
        apiFetch(`/api/observe/session?taskId=${encodeURIComponent(taskId)}&view=structure`)
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

    const loadInteraction = useCallback(async (index: number) => {
        const response = await apiFetch(
            `/api/observe/session?taskId=${encodeURIComponent(taskId)}&view=interaction&index=${index}`,
        );
        if (!response.ok) throw new Error(await readApiError(response));
        const body = await response.json();
        return body?.interaction;
    }, [taskId]);

    const loadFullInteractions = useCallback(async () => {
        const response = await apiFetch(`/api/observe/session?taskId=${encodeURIComponent(taskId)}&view=interactions`);
        if (!response.ok) throw new Error(await readApiError(response));
        const body = await response.json();
        return Array.isArray(body?.interactions) ? body.interactions : [];
    }, [taskId]);

    const { framework, latency, tokens, cost } = execution;
    const isRunning = execStatus === 'running';
    const canDownloadSession = !exporting && !!user && !!taskId;

    const downloadSessionJson = async () => {
        if (!canDownloadSession || !user) return;
        setExporting(true);
        try {
            const query = new URLSearchParams({
                executionId: execution.upload_id || execution.task_id || '',
                user,
            });
            const response = await apiFetch('/api/observe/traces/export?' + query.toString());
            if (!response.ok) {
                const payload = await response.json().catch(() => ({}));
                throw new Error(payload?.error || (locale === 'zh' ? '导出 Trace 失败' : 'Failed to export trace'));
            }
            const blob = await response.blob();
            const disposition = response.headers.get('Content-Disposition') || '';
            const filenameMatch = /filename="?([^";]+)"?/i.exec(disposition);
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filenameMatch?.[1] || ('trace-' + safeFilenameSegment(taskId) + '.json');
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            toast.success(locale === 'zh' ? '完整 Trace 已开始下载' : 'Trace bundle download started');
        } catch (error) {
            console.error('[trace] export trace bundle failed:', error);
            toast.error(error instanceof Error ? error.message : (locale === 'zh' ? '导出 Trace 失败' : 'Failed to export trace'));
        } finally {
            setExporting(false);
        }
    };

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
                {framework && <Tag variant="framework" icon={Terminal}>{getFrameworkLabel(framework)}</Tag>}

                {/* 用户标签：在详情页原地打标，不必退回列表 */}
                <TraceTagCell
                    execution={execution}
                    availableTags={availableTags}
                    onTagsChanged={onTagsChanged}
                    onTagCreated={onTagCreated}
                    mode="button"
                />

                {(typeof tokens === 'number' && tokens > 0) || (typeof latency === 'number' && latency > 0) || (typeof cost === 'number' && cost > 0) ? (
                    <Separator orientation="vertical" className="h-5" />
                ) : null}
                {typeof tokens === 'number' && tokens > 0 && (
                    <MetricPill label={<Term id="tokens" label={t('tracePage.metricTokens')} />} value={tokens.toLocaleString()} />
                )}
                {typeof latency === 'number' && latency > 0 && (
                    <MetricPill label={t('tracePage.metricDuration')} value={formatLatencySeconds(latency)} />
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
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setBackflowOpen(true)}
                        disabled={!user || !taskId}
                        className="h-7 text-xs"
                    >
                        <Database className="size-3.5" aria-hidden />
                        {locale === 'zh' ? '加入评测集' : 'Add to dataset'}
                    </Button>
                    <Button variant="default" size="sm" asChild className="h-7 text-xs">
                        <Link href={`${basePath}/fault?taskId=${taskId}`}>{t('tracePage.diagnosis')}</Link>
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={downloadSessionJson}
                        disabled={!canDownloadSession}
                        title={
                            canDownloadSession
                                ? (locale === 'zh' ? '下载完整 Trace Bundle' : 'Download complete trace bundle')
                                : (locale === 'zh' ? 'Trace 暂不可导出' : 'Trace export is currently unavailable')
                        }
                        className="h-7 text-xs"
                    >
                        <Upload className="size-3.5" aria-hidden />
                        {locale === 'zh' ? '导出 Trace' : 'Export Trace'}
                    </Button>
                </div>
            </div>

            {user && (
                <TraceBackflowDialog
                    open={backflowOpen}
                    onOpenChange={setBackflowOpen}
                    user={user}
                    sources={[{
                        taskId,
                        executionId: execution.upload_id,
                        label: execution.query || taskId,
                    }]}
                />
            )}

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
                ) : (session?.interactions?.length || 0) > 0 || (session?.langfuseTraceNodes?.length || 0) > 0 ? (
                    <AgentTraceView
                        interactions={session.interactions || []}
                        langfuseTraceNodes={session.langfuseTraceNodes}
                        loadInteraction={loadInteraction}
                        loadAllInteractions={loadFullInteractions}
                        onSubagentNavigate={navigateToTaskId}
                        rootSessionId={taskId}
                        rootExecutionId={execution.upload_id || execution.task_id}
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
    onResize?: (key: ResizableColKey, width: number, tableWidth?: number) => void;
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

function SelectionCheckbox({
    checked,
    indeterminate = false,
    onChange,
    ariaLabel,
}: {
    checked: boolean;
    indeterminate?: boolean;
    onChange: () => void;
    ariaLabel: string;
}) {
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (inputRef.current) inputRef.current.indeterminate = indeterminate;
    }, [indeterminate]);

    return (
        <input
            ref={inputRef}
            type="checkbox"
            checked={checked}
            onChange={onChange}
            aria-label={ariaLabel}
            className="size-4 cursor-pointer accent-primary"
        />
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
    onResize?: (key: ResizableColKey, width: number, tableWidth?: number) => void;
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
                    {active ? (dir === 'asc' ? '\u2191' : '\u2193') : '\u2195'}
                </span>
            </span>
            {resizable && <ResizeHandle colKey={colKey} currentWidth={currentWidth} onResize={onResize} />}
        </th>
    );
}

function Row({
    execution: e,
    columnVisibility,
    availableTags,
    onTagsChanged,
    onTagCreated,
    onClick,
    selected,
    onSelectedChange,
}: {
    execution: Execution;
    columnVisibility: Record<TraceColumnKey, boolean>;
    availableTags: TraceUserTag[];
    onTagsChanged: (executionId: string, tags: TraceUserTag[]) => void;
    onTagCreated: (tag: TraceUserTag) => void;
    onClick: () => void;
    selected: boolean;
    onSelectedChange: () => void;
}) {
    const { t, locale } = useLocale();
    const router = useRouter();
    const { user } = useAuth();
    const id = e.task_id || e.upload_id || '';
    const status = getExecStatus(e);
    const skillCount = getInvokedSkillNames(e).length;
    const agentCount = new Set((e.agents ?? []).filter(Boolean)).size;
    const isMultiAgent = agentCount > 1;
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
            className={cn(
                'border-b border-border hover:bg-background-secondary focus-visible:outline-none focus-visible:bg-background-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset cursor-pointer transition-colors',
                selected && 'bg-primary-subtle',
            )}
        >
            <Td>
                <div onClick={ev => ev.stopPropagation()} onKeyDown={ev => ev.stopPropagation()}>
                    <SelectionCheckbox
                        checked={selected}
                        onChange={onSelectedChange}
                        ariaLabel={`${locale === 'zh' ? '选择' : 'Select'} Trace ${id}`}
                    />
                </div>
            </Td>
            {columnVisibility.traceId && (
                <Td>
                    <IdChip value={id} head={6} tail={4} />
                </Td>
            )}
            {columnVisibility.task && (
                <Td>
                    <TruncateText className="text-foreground text-sm">
                        {e.query || t('tracePage.noQuery')}
                    </TruncateText>
                </Td>
            )}
            {columnVisibility.agent && (
                <Td>
                    <TruncateText className="text-foreground text-sm">
                        {e.agent || (e.agents && e.agents.length > 0 ? e.agents[0] : null) || e.framework || '-'}
                    </TruncateText>
                </Td>
            )}
            {columnVisibility.status && (
                <Td>
                    <StatusBadge status={statusKind} label={statusLabel} />
                </Td>
            )}
            {columnVisibility.userTags && (
                <Td>
                    <TraceTagCell
                        execution={e}
                        availableTags={availableTags}
                        onTagsChanged={onTagsChanged}
                        onTagCreated={onTagCreated}
                    />
                </Td>
            )}
            {columnVisibility.systemTags && (
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
                            <Tag variant="framework" icon={Terminal}>{getFrameworkLabel(e.framework)}</Tag>
                        )}
                    </div>
                </Td>
            )}
            {columnVisibility.tokens && (
                <Td>
                    <span className="text-xs text-foreground-secondary font-mono tabular-nums whitespace-nowrap">
                        {e.tokens != null ? e.tokens.toLocaleString() : '-'}
                    </span>
                </Td>
            )}
            {columnVisibility.time && (
                <Td>
                    <RelativeTime value={e.timestamp} className="text-xs text-foreground-secondary font-mono whitespace-nowrap" />
                </Td>
            )}
            {columnVisibility.actions && (
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
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            title={t('tracePage.rowEval')}
                            onClick={() => { void drillTraceEvalUrl(user || '', id).then(url => router.push(url)); }}
                        >
                            <Wrench className="size-3" />
                            {t('tracePage.rowEval')}
                        </Button>
                    </div>
                </Td>
            )}
        </tr>
    );
}

async function readApiError(response: Response): Promise<string> {
    try {
        const body = await response.json();
        return String(body?.error || response.statusText || 'Request failed');
    } catch {
        return response.statusText || 'Request failed';
    }
}

function tagKindLabel(kind: TraceUserTag['kind'], locale: string): string {
    if (kind === 'version') return locale === 'zh' ? '版本' : 'Version';
    return locale === 'zh' ? '业务' : 'Business';
}

function UserTagChip({
    tag,
    removable,
    className,
}: {
    tag: TraceUserTag;
    removable?: boolean;
    className?: string;
}) {
    return (
        <span
            title={tag.name}
            className={cn(
                'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-foreground leading-none',
                className,
            )}
            // 标签色只用于描边/淡底，文字保持前景色：用户可自选任意颜色，
            // 直接拿它当文字色在深浅主题下都可能读不清。
            style={{
                borderColor: `color-mix(in srgb, ${tag.color} 40%, transparent)`,
                backgroundColor: `color-mix(in srgb, ${tag.color} 12%, transparent)`,
            }}
        >
            <span className="size-1.5 rounded-full shrink-0" style={{ backgroundColor: tag.color }} aria-hidden />
            <span className="truncate">{tag.name}</span>
            {removable && <XIcon className="size-3 shrink-0 text-foreground-muted" aria-hidden />}
        </span>
    );
}

function TraceTagCell({
    execution,
    availableTags,
    onTagsChanged,
    onTagCreated,
    mode = 'cell',
}: {
    execution: Execution;
    availableTags: TraceUserTag[];
    onTagsChanged: (executionId: string, tags: TraceUserTag[]) => void;
    onTagCreated: (tag: TraceUserTag) => void;
    mode?: 'cell' | 'button';
}) {
    const { user } = useAuth();
    const { t, locale } = useLocale();
    const executionId = getExecutionRowKey(execution);
    const selectedTags = useMemo(
        () => execution.userTags ?? [],
        [execution.userTags],
    );
    const selectedIds = useMemo(
        () => new Set(selectedTags.map(tag => tag.id)),
        [selectedTags],
    );
    const [open, setOpen] = useState(false);
    const [savingId, setSavingId] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState('');
    const [newKind, setNewKind] = useState<TraceUserTag['kind']>('business');
    const [newColor, setNewColor] = useState('#6366f1');
    const tagAreaRef = useRef<HTMLSpanElement>(null);
    const tagMeasureRef = useRef<HTMLSpanElement>(null);
    const [visibleTagCount, setVisibleTagCount] = useState(selectedTags.length);

    const applyTagsResponse = useCallback(async (response: Response) => {
        if (!response.ok) throw new Error(await readApiError(response));
        const body = await response.json();
        const tags = Array.isArray(body?.tags) ? body.tags : [];
        onTagsChanged(executionId, tags);
        return tags as TraceUserTag[];
    }, [executionId, onTagsChanged]);

    const toggleTag = useCallback(async (tag: TraceUserTag) => {
        if (!user || !executionId) return;
        setSavingId(tag.id);
        try {
            const selected = selectedIds.has(tag.id);
            const response = selected
                ? await apiFetch(`/api/observe/executions/${encodeURIComponent(executionId)}/tags?user=${encodeURIComponent(user)}&tagId=${encodeURIComponent(tag.id)}`, { method: 'DELETE' })
                : await apiFetch(`/api/observe/executions/${encodeURIComponent(executionId)}/tags`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user, tagIds: [tag.id] }),
                });
            await applyTagsResponse(response);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t('tracePage.tagSaveFailed'));
        } finally {
            setSavingId(null);
        }
    }, [applyTagsResponse, executionId, selectedIds, t, user]);

    const createAndAttachTag = useCallback(async () => {
        if (!user || !executionId || !newName.trim()) return;
        setCreating(true);
        try {
            const createResponse = await apiFetch('/api/tags', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user, name: newName.trim(), kind: newKind, color: newColor }),
            });
            if (!createResponse.ok) throw new Error(await readApiError(createResponse));
            const tag = await createResponse.json() as TraceUserTag;
            onTagCreated(tag);
            const attachResponse = await apiFetch(`/api/observe/executions/${encodeURIComponent(executionId)}/tags`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user, tagIds: [tag.id] }),
            });
            await applyTagsResponse(attachResponse);
            setNewName('');
            setNewKind('business');
            setNewColor('#6366f1');
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t('tracePage.tagCreateFailed'));
        } finally {
            setCreating(false);
        }
    }, [applyTagsResponse, executionId, newColor, newKind, newName, onTagCreated, t, user]);

    const versionTags = availableTags.filter(tag => tag.kind === 'version');
    const businessTags = availableTags.filter(tag => tag.kind === 'business');

    useEffect(() => {
        if (mode !== 'cell' || selectedTags.length === 0) return;
        const area = tagAreaRef.current;
        const measurements = tagMeasureRef.current;
        if (!area || !measurements) return;

        const measure = () => {
            const tagWidths = Array.from(
                measurements.querySelectorAll<HTMLElement>('[data-trace-tag-measure]'),
                element => element.getBoundingClientRect().width,
            );
            const overflowWidths = Array(selectedTags.length + 1).fill(0);
            measurements
                .querySelectorAll<HTMLElement>('[data-trace-tag-overflow]')
                .forEach(element => {
                    const count = Number(element.dataset.traceTagOverflow);
                    if (Number.isInteger(count) && count > 0) {
                        overflowWidths[count] = element.getBoundingClientRect().width;
                    }
                });
            const nextCount = fitTraceTagCount({
                availableWidth: area.clientWidth,
                tagWidths,
                overflowWidths,
            });
            setVisibleTagCount(previous => previous === nextCount ? previous : nextCount);
        };

        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(measure);
        observer.observe(area);
        return () => observer.disconnect();
    }, [mode, selectedTags]);

    const visibleTags = selectedTags.slice(0, visibleTagCount);
    const overflowCount = selectedTags.length - visibleTags.length;
    const allTagNames = selectedTags.map(tag => tag.name).join(locale === 'zh' ? '、' : ', ');

    const trigger = mode === 'button' ? (
        <button
            type="button"
            title={selectedTags.length > 0 ? allTagNames : t('tracePage.editTags')}
            onClick={ev => ev.stopPropagation()}
            className="group/tag inline-flex min-h-7 items-center gap-1.5 rounded-md border border-border-dark bg-card px-2 py-0.5 text-xs hover:bg-background-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
            {selectedTags.length > 0 && (
                <span className="flex flex-wrap items-center gap-1">
                    {selectedTags.map(tag => <UserTagChip key={tag.id} tag={tag} />)}
                </span>
            )}
            <span className="inline-flex items-center gap-1 text-foreground-muted group-hover/tag:text-primary">
                <Plus className="size-3.5" aria-hidden />
                {selectedTags.length === 0 && t('tracePage.addTag')}
            </span>
        </button>
    ) : (
        <button
            type="button"
            className="group/tag relative flex min-h-7 w-full min-w-0 items-center gap-1 overflow-hidden rounded-sm px-1 py-0.5 text-left hover:bg-background-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={selectedTags.length > 0 ? allTagNames : t('tracePage.editTags')}
            onClick={ev => ev.stopPropagation()}
        >
            {selectedTags.length === 0 ? (
                // 空态给一个虚线占位，而不是让一个孤立的 + 图标浮在列宽最右侧
                <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-border-dark px-2 py-0.5 text-xs text-foreground-muted group-hover/tag:border-primary group-hover/tag:text-primary">
                    <Plus className="size-3" aria-hidden />
                    {t('tracePage.addTag')}
                </span>
            ) : (
                <>
                    <span ref={tagAreaRef} className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
                        {visibleTags.map(tag => (
                            <UserTagChip key={tag.id} tag={tag} className="min-w-12 shrink" />
                        ))}
                        {overflowCount > 0 && (
                            <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-xs tabular-nums text-foreground-muted">
                                +{overflowCount}
                            </span>
                        )}
                    </span>
                    <span className="ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded-full text-foreground-muted transition-colors group-hover/tag:bg-primary-subtle group-hover/tag:text-primary">
                        <Plus className="size-3.5" aria-hidden />
                    </span>
                    <span
                        ref={tagMeasureRef}
                        className="pointer-events-none absolute invisible left-0 top-0 flex items-center gap-1 whitespace-nowrap"
                        aria-hidden
                    >
                        {selectedTags.map(tag => (
                            <span key={tag.id} data-trace-tag-measure>
                                <UserTagChip tag={tag} />
                            </span>
                        ))}
                        {selectedTags.map((_, index) => {
                            const hiddenCount = index + 1;
                            return (
                                <span
                                    key={hiddenCount}
                                    data-trace-tag-overflow={hiddenCount}
                                    className="rounded-full border border-border px-1.5 py-0.5 text-xs tabular-nums text-foreground-muted"
                                >
                                    +{hiddenCount}
                                </span>
                            );
                        })}
                    </span>
                </>
            )}
        </button>
    );

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>{trigger}</PopoverTrigger>
            <PopoverContent
                align="start"
                className="w-[30rem] max-w-[calc(100vw-2rem)] p-3"
                onClick={ev => ev.stopPropagation()}
            >
                <div className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-foreground">{t('tracePage.editTags')}</span>
                        <div className="flex items-center gap-1">
                            <span className="text-xs text-foreground-muted tabular-nums">{selectedTags.length}</span>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="size-7"
                                aria-label={locale === 'zh' ? '关闭' : 'Close'}
                                onClick={() => setOpen(false)}
                            >
                                <XIcon className="size-3.5" aria-hidden />
                            </Button>
                        </div>
                    </div>
                    <TagPickerGroup
                        title={tagKindLabel('version', locale)}
                        tags={versionTags}
                        selectedIds={selectedIds}
                        savingId={savingId}
                        onToggle={toggleTag}
                    />
                    <TagPickerGroup
                        title={tagKindLabel('business', locale)}
                        tags={businessTags}
                        selectedIds={selectedIds}
                        savingId={savingId}
                        onToggle={toggleTag}
                    />
                    <div className="border-t border-border pt-3 space-y-2">
                        <div className="flex items-center gap-2">
                            <select
                                value={newKind}
                                onChange={ev => setNewKind(ev.target.value as TraceUserTag['kind'])}
                                className="h-8 rounded-md border border-input bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
                            >
                                <option value="business">{tagKindLabel('business', locale)}</option>
                                <option value="version">{tagKindLabel('version', locale)}</option>
                            </select>
                            <input
                                type="color"
                                value={newColor}
                                onChange={ev => setNewColor(ev.target.value)}
                                className="size-8 rounded border border-input bg-background p-0.5"
                                aria-label={t('tracePage.tagColor')}
                            />
                        </div>
                        <div className="flex items-center gap-2">
                            <Input
                                value={newName}
                                onChange={ev => setNewName(ev.target.value)}
                                onKeyDown={ev => { if (ev.key === 'Enter') { ev.preventDefault(); void createAndAttachTag(); } }}
                                placeholder={t('tracePage.newTagPlaceholder')}
                                className="h-8 text-sm"
                            />
                            <Button
                                type="button"
                                size="sm"
                                className="h-8 px-2"
                                disabled={creating || !newName.trim()}
                                onClick={() => void createAndAttachTag()}
                            >
                                <Plus className="size-3.5" aria-hidden />
                                {t('tracePage.createTag')}
                            </Button>
                        </div>
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    );
}

function TagPickerGroup({
    title,
    tags,
    selectedIds,
    savingId,
    onToggle,
}: {
    title: string;
    tags: TraceUserTag[];
    selectedIds: Set<string>;
    savingId: string | null;
    onToggle: (tag: TraceUserTag) => void;
}) {
    const { t, locale } = useLocale();
    const clusters = clusterTraceTagsByPrefix(tags, locale);
    const ungroupedLabel = locale === 'zh' ? '未分组' : 'Ungrouped';
    return (
        <div className="space-y-1.5">
            <div className="text-xs font-medium text-foreground-muted">{title}</div>
            {tags.length === 0 ? (
                <p className="text-xs text-foreground-muted">{t('tracePage.noTagsAvailable')}</p>
            ) : (
                <div className="max-h-48 space-y-2 overflow-auto pr-1">
                    {clusters.map(cluster => (
                        <div
                            key={cluster.key}
                            className="flex items-start gap-2"
                        >
                            <div
                                className="w-fit max-w-[40%] shrink-0 truncate rounded-sm bg-background-secondary px-2 py-1.5 text-xs font-medium text-foreground-secondary"
                                title={cluster.prefix || ungroupedLabel}
                            >
                                {cluster.prefix || ungroupedLabel}
                            </div>
                            <div className="flex min-w-0 flex-wrap gap-1.5">
                                {cluster.tags.map(tag => {
                                    const selected = selectedIds.has(tag.id);
                                    return (
                                        <button
                                            key={tag.id}
                                            type="button"
                                            aria-pressed={selected}
                                            disabled={savingId === tag.id}
                                            onClick={() => onToggle(tag)}
                                            className={cn(
                                                'inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-full border border-border px-2 py-1 text-left text-xs text-foreground transition-colors hover:bg-background-secondary disabled:opacity-60',
                                                selected && 'border-primary-border bg-primary-subtle text-primary',
                                            )}
                                            title={tag.name}
                                        >
                                            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} aria-hidden />
                                            <span className="max-w-44 truncate">{tag.name}</span>
                                            {selected && <Check className="size-3.5 shrink-0" aria-hidden />}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
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
