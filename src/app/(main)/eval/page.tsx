'use client';

/**
 * 评测执行主页 —— 主区显示某个评测批次的 trace 评测列表，右侧 sidebar 列历史批次。
 *
 * 设计：参考 skill-eval 的"调测历史"右栏。
 *  - 默认进来选中最新一个批次，主区直接展开它的 trace 评测进展 / 结果
 *  - 点右侧任一历史批次 → 主区切换到那个批次（不跳路由，纯 state）
 *  - 顶部固定「+ 发起新评测」按钮
 *  - /eval/run/[runId] 单独 panel 路由保留（外链分享用），未删除
 *
 * 数据：拉用户全部 TrajectoryEvalResult，按 evaluatorRunId 在前端聚合成 RunSummary。
 * 同时拉 /api/observe/data 取 execution 元数据（query / final_result / 执行 agent 名）。
 */
import { Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiFetch } from '@/lib/client/api';
import { useAuth } from '@/lib/auth/auth-context';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { useLocale } from '@/lib/client/locale-context';
import {
    getPrimaryExecutionAgentName,
    isEvaluatorTraceRecord,
} from '@/lib/evaluator-agent';

interface TrajectoryDimensionScores {
    completeness: number;
    toolChoice: number;
    redundancy: number;
    attribution: number;
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
    resultEvaluationScore?: number | null;
    customEvaluationScore?: number | null;
    customEvaluations?: unknown;
    dimensionScores: TrajectoryDimensionScores | null;
    rootCauseStep: string | null;
    createdAt: string;
}

interface ExecutionRecord {
    task_id?: string | null;
    upload_id?: string | null;
    framework?: string | null;
    model?: string | null;
    query?: string | null;
    final_result?: string | null;
    answer_score?: number | null;
    timestamp?: string | null;
    latency?: number | null;
    agent?: string | null;
    agentName?: string | null;
    agents?: string[];
}

interface RunSummary {
    runId: string;
    datasetId: string;
    taskTitle: string;
    taskDescription: string;
    evaluatorIds: string[];
    executionAgent: string;
    autoWatch: boolean;
    watchedAgent: string;
    traceCount: number;
    doneCount: number;
    runningCount: number;
    failedCount: number;
    avgScore: number | null;
    createdAt: string;
    evaluatorName: string;
}

interface EvalHistoryState {
    user: string;
    selectedRunId: string;
    autoWatchOnly: boolean;
    historyOpen: boolean;
    historyOffset: number;
    historyHasMore: boolean;
    historyScrollTop: number;
    runSummaries: RunSummary[];
    savedAt: number;
}

const COLORS = {
    primary: '#534AB7',
    primarySubtle: '#EEEDFE',
    success: '#0F6E56',
    danger: '#A32D2D',
    dangerSubtle: '#FFEBEB',
    warning: '#9A7311',
    border: '#eceae4',
    borderSoft: '#f3f2ee',
    bgSoft: '#f9f9fb',
    bgElev: '#FBFAF6',
    text: '#1a1a18',
    textSecondary: '#2c2b28',
    textMuted: '#6b6a66',
    textDisabled: '#8a8884',
};

const POLL_MS = 5000;
const HISTORY_PAGE_SIZE = 10;
const EVAL_HISTORY_STATE_KEY = 'agent-insight:eval-history-state';
const NO_EVALUABLE_CASE_PREFIX = '[no-evaluable-case]';

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
    if (n == null || Number.isNaN(n)) return '--';
    return (n * 10).toFixed(1);
}

function fmtTime(s?: string | null): string {
    if (!s) return '--';
    try { return new Date(s).toLocaleString('zh-CN', { hour12: false }); } catch { return s; }
}

function fmtRelTime(s?: string | null): string {
    if (!s) return '--';
    try {
        const d = new Date(s);
        const diff = Date.now() - d.getTime();
        if (diff < 60_000) return '刚刚';
        if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
        if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
        return `${Math.floor(diff / 86400_000)} 天前`;
    } catch { return s; }
}

function shortId(s: string | null | undefined, head = 8, tail = 6): string {
    if (!s) return '--';
    return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

function formatTraceIdPreview(traceId: string | null | undefined): string {
    if (!traceId) return '--';
    return traceId.slice(0, 14) || '--';
}

function getExecutionAgentFromRecord(r?: ExecutionRecord): string {
    return getPrimaryExecutionAgentName(r);
}

function hasSelectedEvaluator(r: TrajectoryResult, evaluatorId: string): boolean {
    const selected = Array.isArray(r.selectedEvaluators) ? r.selectedEvaluators : [];
    if (selected.length === 0) return evaluatorId === 'preset-agent-trace-quality';
    return selected.includes(evaluatorId);
}

function isEvaluationTerminal(status?: TrajectoryResult['status'] | null): boolean {
    return status === 'done' || status === 'failed';
}

function deriveCustomEvaluationScore(result: TrajectoryResult): number | null {
    if (typeof result.customEvaluationScore === 'number' && Number.isFinite(result.customEvaluationScore)) {
        return result.customEvaluationScore;
    }
    const rawItems = Array.isArray(result.customEvaluations)
        ? result.customEvaluations
        : result.customEvaluations && typeof result.customEvaluations === 'object'
            ? Object.values(result.customEvaluations as Record<string, unknown>)
            : [];
    const scores = rawItems
        .map(item => item && typeof item === 'object' ? (item as Record<string, unknown>).score : null)
        .filter((score): score is number => typeof score === 'number' && Number.isFinite(score));
    return scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
}

function getDisplayScore(result: TrajectoryResult, exec?: ExecutionRecord): number | null {
    if (!isEvaluationTerminal(result.status) || getEffectiveStatus(result) !== 'done' || isNoEvaluableCase(result)) return null;
    const traceScore = hasSelectedEvaluator(result, 'preset-agent-trace-quality') ? result.trajectoryScore : null;
    const answerScore = hasSelectedEvaluator(result, 'preset-agent-task-completion')
        ? exec?.answer_score ?? result.resultEvaluationScore ?? null
        : null;
    const derivedCustomScore = deriveCustomEvaluationScore(result);
    const hasCustom = Array.isArray(result.selectedEvaluators)
        ? result.selectedEvaluators.some(id => id.startsWith('custom-'))
        : derivedCustomScore != null;
    const customScore = hasCustom ? derivedCustomScore : null;
    const parts = [traceScore, answerScore, customScore]
        .filter((score): score is number => typeof score === 'number' && Number.isFinite(score));
    return parts.length > 0 ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
}

function EvalPageContent() {
    const { t } = useLocale();
    const { user } = useAuth();
    const router = useRouter();
    const searchParams = useSearchParams();
    const requestedRunId = searchParams?.get('runId') || '';
    const requestedAutoWatchOnly = searchParams?.get('autoWatchOnly') === '1' || searchParams?.get('autoWatchOnly') === 'true';

    const [results, setResults] = useState<TrajectoryResult[]>([]);
    const [records, setRecords] = useState<ExecutionRecord[]>([]);
    const [runSummaries, setRunSummaries] = useState<RunSummary[]>([]);
    const [historyOffset, setHistoryOffset] = useState(HISTORY_PAGE_SIZE);
    const [historyHasMore, setHistoryHasMore] = useState(false);
    const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
    const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string>('');
    const [historyOpen, setHistoryOpen] = useState(false);
    const [autoWatchOnly, setAutoWatchOnly] = useState(requestedAutoWatchOnly);
    const historySentinelRef = useRef<HTMLDivElement | null>(null);
    const historyListRef = useRef<HTMLDivElement | null>(null);
    const restoredHistoryStateRef = useRef(false);
    const preferredRunIdForLoadRef = useRef('');

    function saveHistoryStateForReturn(runId: string) {
        if (!user || typeof window === 'undefined') return;
        const snapshot: EvalHistoryState = {
            user,
            selectedRunId: runId,
            autoWatchOnly,
            historyOpen,
            historyOffset,
            historyHasMore,
            historyScrollTop: historyListRef.current?.scrollTop || 0,
            runSummaries,
            savedAt: Date.now(),
        };
        window.sessionStorage.setItem(EVAL_HISTORY_STATE_KEY, JSON.stringify(snapshot));
    }

    function toggleAutoWatchFilter() {
        preferredRunIdForLoadRef.current = selectedRunId || '';
        setAutoWatchOnly(value => !value);
    }

    // 历史任务分页加载：首屏只取 10 个 run 摘要，滚动到底部再继续取下一页。
    useEffect(() => {
        if (!user) return;
        let stopped = false;
        const loadFirstPage = async () => {
            if (requestedRunId && !restoredHistoryStateRef.current && typeof window !== 'undefined') {
                const raw = window.sessionStorage.getItem(EVAL_HISTORY_STATE_KEY);
                if (raw) {
                    try {
                        const snapshot = JSON.parse(raw) as EvalHistoryState;
                        const freshEnough = Date.now() - Number(snapshot.savedAt || 0) < 10 * 60 * 1000;
                        if (
                            freshEnough &&
                            snapshot.user === user &&
                            snapshot.selectedRunId === requestedRunId &&
                            snapshot.autoWatchOnly === requestedAutoWatchOnly &&
                            Array.isArray(snapshot.runSummaries) &&
                            snapshot.runSummaries.some(run => run.runId === requestedRunId)
                        ) {
                            restoredHistoryStateRef.current = true;
                            setRunSummaries(snapshot.runSummaries);
                            setHistoryOffset(snapshot.historyOffset || HISTORY_PAGE_SIZE);
                            setHistoryHasMore(Boolean(snapshot.historyHasMore));
                            setSelectedRunId(requestedRunId);
                            setAutoWatchOnly(snapshot.autoWatchOnly);
                            setHistoryOpen(snapshot.historyOpen);
                            setResults([]);
                            setRecords([]);
                            setError('');
                            setLoading(false);
                            requestAnimationFrame(() => {
                                if (historyListRef.current) historyListRef.current.scrollTop = snapshot.historyScrollTop || 0;
                            });
                            return;
                        }
                    } catch {
                        window.sessionStorage.removeItem(EVAL_HISTORY_STATE_KEY);
                    }
                }
            }
            if (!stopped) {
                setLoading(true);
                setRunSummaries([]);
                setResults([]);
                setRecords([]);
                setHistoryOffset(HISTORY_PAGE_SIZE);
                setHistoryHasMore(false);
                setSelectedRunId(null);
            }
            try {
                const qs = new URLSearchParams({
                    user,
                    limit: String(HISTORY_PAGE_SIZE),
                });
                const anchorRunId = requestedRunId || preferredRunIdForLoadRef.current;
                if (anchorRunId) qs.set('includeRunId', anchorRunId);
                if (autoWatchOnly) qs.set('autoWatchOnly', '1');
                const res = await apiFetch(`/api/eval/trajectory/runs?${qs.toString()}`);
                const data = await res.json();
                if (!res.ok) throw new Error(data?.error || res.statusText);
                const nextRuns = Array.isArray(data?.runs) ? data.runs : [];
                if (!stopped) {
                    setRunSummaries(nextRuns);
                    setHistoryOffset(typeof data?.nextOffset === 'number' ? data.nextOffset : HISTORY_PAGE_SIZE);
                    setHistoryHasMore(Boolean(data?.hasMore));
                    const preferredRunId = requestedRunId || preferredRunIdForLoadRef.current;
                    const requestedRun = preferredRunId
                        ? nextRuns.find((run: RunSummary) => run.runId === preferredRunId)
                        : null;
                    setSelectedRunId(requestedRun?.runId || nextRuns[0]?.runId || null);
                    preferredRunIdForLoadRef.current = '';
                    setError('');
                }
            } catch (e: unknown) {
                const message = e instanceof Error ? e.message : String(e);
                if (!stopped) setError(`加载失败：${message}`);
            } finally {
                if (!stopped) setLoading(false);
            }
        };
        loadFirstPage();
        return () => { stopped = true; };
    }, [user, autoWatchOnly, requestedRunId, requestedAutoWatchOnly]);

    useEffect(() => {
        if (!user || !selectedRunId) {
            return;
        }
        let stopped = false;
        const tick = async () => {
            try {
                const res = await apiFetch(
                    `/api/eval/trajectory/results?user=${encodeURIComponent(user)}&runId=${encodeURIComponent(selectedRunId)}&limit=500`,
                );
                const data = await res.json();
                if (!res.ok) throw new Error(data?.error || res.statusText);
                const nextResults: TrajectoryResult[] = Array.isArray(data?.results) ? data.results : [];
                const traceIds = Array.from(new Set(nextResults.map(r => r.taskId || '').filter(Boolean)));
                let nextRecords: ExecutionRecord[] = [];
                if (traceIds.length > 0) {
                    const recordsQs = new URLSearchParams({
                        user,
                        taskIds: traceIds.join(','),
                        skipAutoEvalReady: '1',
                    });
                    const recRes = await apiFetch(`/api/observe/data?${recordsQs.toString()}`);
                    const recData = await recRes.json();
                    if (!recRes.ok) throw new Error(recData?.error || recRes.statusText);
                    nextRecords = Array.isArray(recData) ? recData : [];
                }
                if (!stopped) {
                    setResults(nextResults);
                    setRecords(nextRecords);
                    setError('');
                }
            } catch (e: unknown) {
                const message = e instanceof Error ? e.message : String(e);
                if (!stopped) setError(`加载失败：${message}`);
            }
        };
        tick();
        const id = setInterval(tick, POLL_MS);
        return () => { stopped = true; clearInterval(id); };
    }, [selectedRunId, user]);

    useEffect(() => {
        const node = historySentinelRef.current;
        if (!node || !user || !historyHasMore || historyLoadingMore) return;
        const observer = new IntersectionObserver(entries => {
            if (!entries.some(entry => entry.isIntersecting)) return;
            setHistoryLoadingMore(true);
            const qs = new URLSearchParams({
                user,
                limit: String(HISTORY_PAGE_SIZE),
            });
            qs.set('offset', String(historyOffset));
            if (autoWatchOnly) qs.set('autoWatchOnly', '1');
            apiFetch(`/api/eval/trajectory/runs?${qs.toString()}`)
                .then(async res => {
                    const data = await res.json();
                    if (!res.ok) throw new Error(data?.error || res.statusText);
                    const nextRuns: RunSummary[] = Array.isArray(data?.runs) ? data.runs : [];
                    setRunSummaries(prev => {
                        const seen = new Set(prev.map(run => run.runId));
                        return [...prev, ...nextRuns.filter(run => !seen.has(run.runId))];
                    });
                    setHistoryOffset(typeof data?.nextOffset === 'number' ? data.nextOffset : historyOffset + HISTORY_PAGE_SIZE);
                    setHistoryHasMore(Boolean(data?.hasMore));
                })
                .catch(e => setError(`加载历史任务失败：${e instanceof Error ? e.message : String(e)}`))
                .finally(() => setHistoryLoadingMore(false));
        }, { rootMargin: '180px' });
        observer.observe(node);
        return () => observer.disconnect();
    }, [autoWatchOnly, historyHasMore, historyLoadingMore, historyOffset, user]);

    const recordMap = useMemo(() => {
        const m = new Map<string, ExecutionRecord>();
        for (const r of records) {
            if (r.task_id) m.set(r.task_id, r);
            if (r.upload_id) m.set(r.upload_id, r);
        }
        return m;
    }, [records]);

    const runs = runSummaries;

    const selectedRun = useMemo(
        () => runs.find(r => r.runId === selectedRunId) || null,
        [runs, selectedRunId],
    );
    const selectedResults = useMemo(
        () => results.filter(r => !r.watchPlaceholder),
        [results],
    );

    const topBarActions = (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
                onClick={() => setHistoryOpen(o => !o)}
                title={historyOpen ? '收起历史任务' : '展开历史任务'}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '5px 10px',
                    background: historyOpen ? COLORS.primarySubtle : 'transparent',
                    color: historyOpen ? COLORS.primary : COLORS.textMuted,
                    border: `1px solid ${historyOpen ? COLORS.primary : COLORS.border}`,
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                }}
            >
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                    <circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" strokeWidth="1.3" />
                    <path d="M6.5 3.5v3l2 1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
                历史任务
            </button>
            <button
                onClick={() => router.push('/eval/trajectory')}
                style={{
                    padding: '6px 14px',
                    background: COLORS.primary,
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: 'pointer',
                }}
            >
                + 发起新评测
            </button>
        </div>
    );

    return (
        <>
            <AppTopBar title={t('nav.eval')} actions={topBarActions} showDefaultActions={false} />
            <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
                {/* 主区：选中批次的 trace 列表 */}
                <main style={{ flex: 1, overflowY: 'auto', minWidth: 0, color: COLORS.text }}>
                    {loading ? (
                        <div style={{ padding: 24, color: COLORS.textMuted }}>正在加载评测批次...</div>
                    ) : runs.length === 0 && !autoWatchOnly ? (
                        <EmptyState onCreate={() => router.push('/eval/trajectory')} error={error} />
                    ) : runs.length === 0 ? (
                        <FilteredEmptyState onClear={() => setAutoWatchOnly(false)} />
                    ) : selectedRun ? (
                        <RunPanel
                            key={selectedRun.runId}
                            run={selectedRun}
                            results={selectedResults}
                            records={records}
                            recordMap={recordMap}
                            router={router}
                            user={user}
                            error={error}
                            autoWatchOnly={autoWatchOnly}
                            onBeforeOpenTrace={saveHistoryStateForReturn}
                        />
                    ) : null}
                </main>

                {/* 右侧：历史任务 sidebar，完全收缩时宽度为 0 不占空间 */}
                <aside
                    style={{
                        width: historyOpen ? 300 : 0,
                        flexShrink: 0,
                        borderLeft: historyOpen ? `1px solid ${COLORS.border}` : 'none',
                        background: COLORS.bgElev,
                        display: 'flex',
                        flexDirection: 'column',
                        overflow: 'hidden',
                        transition: 'width 0.2s ease',
                    }}
                >
                    <header
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            padding: '12px 16px',
                            borderBottom: `1px solid ${COLORS.border}`,
                            flexShrink: 0,
                            whiteSpace: 'nowrap',
                        }}
                    >
                        <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text, display: 'flex', alignItems: 'center', gap: 6 }}>
                            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                                <circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" strokeWidth="1.3" />
                                <path d="M6.5 3.5v3l2 1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                            </svg>
                            历史任务
                        </div>
                        <button
                            type="button"
                            onClick={toggleAutoWatchFilter}
                            title={autoWatchOnly ? '查看全部历史任务' : '只看自动观测任务'}
                            style={{
                                marginLeft: 8,
                                padding: '5px 10px',
                                height: 28,
                                borderRadius: 8,
                                border: `1px solid ${autoWatchOnly ? COLORS.primary : COLORS.border}`,
                                background: autoWatchOnly ? COLORS.primarySubtle : '#fff',
                                color: autoWatchOnly ? COLORS.primary : COLORS.textMuted,
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                fontSize: 12,
                                fontWeight: 500,
                                cursor: 'pointer',
                            }}
                        >
                            <svg width="12" height="12" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                                <path d="M2 3h9M3.5 6.5h6M5.2 10h2.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                            </svg>
                            <span>{autoWatchOnly ? '全部任务' : '自动观测任务'}</span>
                        </button>
                    </header>
                    <div ref={historyListRef} style={{ flex: 1, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {runs.length === 0 ? (
                            <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: COLORS.textMuted }}>
                                {autoWatchOnly ? '没有自动观测任务' : '还没有任何评测任务'}
                            </div>
                        ) : (
                            runs.map(run => (
                                <RunSidebarItem
                                    key={run.runId}
                                    run={run}
                                    active={run.runId === selectedRunId}
                                    onClick={() => setSelectedRunId(run.runId)}
                                />
                            ))
                        )}
                        <div ref={historySentinelRef} style={{ height: 1 }} />
                        {historyLoadingMore && (
                            <div style={{ padding: 8, textAlign: 'center', fontSize: 11, color: COLORS.textMuted }}>
                                正在加载更多...
                            </div>
                        )}
                    </div>
                </aside>
            </div>
        </>
    );
}

export default function EvalPage() {
    return (
        <Suspense fallback={<div style={{ padding: 24, color: COLORS.textMuted }}>Loading...</div>}>
            <EvalPageContent />
        </Suspense>
    );
}

/* ============================================================
 * 主区：已选批次的 panel —— summary 卡 + trace 评测列表
 * 复刻自原 EvaluationRunDetailView，但去掉了 page 容器（返回按钮、独立路由），
 * 嵌进主区直接展示。
 * ============================================================ */
function RunPanel({
    run,
    results,
    records,
    recordMap,
    router,
    user,
    error,
    autoWatchOnly,
    onBeforeOpenTrace,
}: {
    run: RunSummary;
    results: TrajectoryResult[];
    records: ExecutionRecord[];
    recordMap: Map<string, ExecutionRecord>;
    router: ReturnType<typeof useRouter>;
    user?: string | null;
    error: string;
    autoWatchOnly: boolean;
    onBeforeOpenTrace: (runId: string) => void;
}) {
    const [addOpen, setAddOpen] = useState(false);
    const [selectedAddTraceIds, setSelectedAddTraceIds] = useState<Set<string>>(new Set());
    const [adding, setAdding] = useState(false);
    const [addMessage, setAddMessage] = useState('');
    const [addError, setAddError] = useState('');
    const [addCandidateRecords, setAddCandidateRecords] = useState<ExecutionRecord[]>([]);
    const [updatingAutoWatch, setUpdatingAutoWatch] = useState(false);
    const [autoWatchOverride, setAutoWatchOverride] = useState<boolean | null>(null);
    const autoWatchEnabled = autoWatchOverride ?? run.autoWatch;
    const recordsForAdd = addOpen ? addCandidateRecords : records;

    const existingTraceIds = useMemo(() => new Set(
        results
            .map(item => item.taskId || item.executionId || '')
            .filter(Boolean),
    ), [results]);

    const addableRecords = useMemo(() => {
        const targetAgent = run.watchedAgent || run.executionAgent;
        return recordsForAdd
            .filter(record => Boolean(record.task_id))
            .filter(record => !isEvaluatorTraceRecord(record))
            .filter(record => !existingTraceIds.has(record.task_id || ''))
            .filter(record => {
                return getExecutionAgentFromRecord(record) === targetAgent;
            })
            .sort((a, b) => {
                const at = a.timestamp ? new Date(a.timestamp).getTime() : 0;
                const bt = b.timestamp ? new Date(b.timestamp).getTime() : 0;
                return bt - at;
            });
    }, [existingTraceIds, recordsForAdd, run.executionAgent, run.watchedAgent]);

    useEffect(() => {
        if (!addOpen || !user || addCandidateRecords.length > 0) return;
        let stopped = false;
        const qs = new URLSearchParams({
            user,
            skipAutoEvalReady: '1',
        });
        apiFetch(`/api/observe/data?${qs.toString()}`)
            .then(async res => {
                const data = await res.json();
                if (!res.ok) throw new Error(data?.error || res.statusText);
                if (!stopped) setAddCandidateRecords(Array.isArray(data) ? data : []);
            })
            .catch(e => {
                if (!stopped) setAddError(`加载可追加 trace 失败：${e instanceof Error ? e.message : String(e)}`);
            });
        return () => { stopped = true; };
    }, [addCandidateRecords.length, addOpen, user]);

    const toggleAddTrace = (traceId: string) => {
        setSelectedAddTraceIds(prev => {
            const next = new Set(prev);
            if (next.has(traceId)) next.delete(traceId);
            else next.add(traceId);
            return next;
        });
    };

    const submitAddTraces = async () => {
        if (!user) {
            setAddError('请先登录');
            return;
        }
        const traceIds = Array.from(selectedAddTraceIds);
        if (traceIds.length === 0) {
            setAddError('请至少选择一条 trace');
            return;
        }
        setAdding(true);
        setAddError('');
        setAddMessage('');
        try {
            const res = await apiFetch('/api/eval/trajectory/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user,
                    evaluatorRunId: run.runId,
                    taskIds: traceIds,
                    evaluators: run.evaluatorIds,
                }),
            });
            const data = await res.json();
            if (!res.ok) {
                setAddError(`追加失败：${data?.error || res.statusText}`);
                return;
            }
            setAddMessage(`已追加 ${data.created?.length ?? 0} 条 trace 到本批次`);
            setSelectedAddTraceIds(new Set());
            setAddOpen(false);
        } catch (e: unknown) {
            setAddError(`追加失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setAdding(false);
        }
    };

    const updateAutoWatch = async (nextValue: boolean) => {
        if (!user) {
            setAddError('请先登录');
            return;
        }
        setUpdatingAutoWatch(true);
        setAddError('');
        setAddMessage('');
        setAutoWatchOverride(nextValue);
        try {
            const res = await apiFetch('/api/eval/trajectory/run', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user,
                    evaluatorRunId: run.runId,
                    autoWatch: nextValue,
                }),
            });
            const data = await res.json();
            if (!res.ok) {
                setAutoWatchOverride(run.autoWatch);
                setAddError(`${nextValue ? '开启' : '关闭'}自动观测失败：${data?.error || res.statusText}`);
                return;
            }
            setAddMessage(nextValue ? '已重新开启自动观测' : '已关闭自动观测，后续新 trace 不会再自动追加');
        } catch (e: unknown) {
            setAutoWatchOverride(run.autoWatch);
            setAddError(`${nextValue ? '开启' : '关闭'}自动观测失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setUpdatingAutoWatch(false);
        }
    };

    return (
        <div style={{ padding: '18px 22px 28px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
                <span style={badgeStyle(COLORS.primarySubtle, COLORS.primary)}>评测批次</span>
                {autoWatchEnabled && (
                    <span style={badgeStyle('#EAF7F1', COLORS.success)}>自动观测</span>
                )}
                <span style={{ fontSize: 12, color: COLORS.textMuted }}>任务已同步到历史卡片与详情页</span>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 11, color: COLORS.textMuted }}>发起时间：{fmtTime(run.createdAt)}</span>
            </div>

            {error && <div style={infoBoxStyle(COLORS.danger, COLORS.dangerSubtle, '#FFD4D4')}>{error}</div>}

            <div
                style={{
                    background: 'linear-gradient(135deg, #FBFAF6 0%, #FFFFFF 100%)',
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 8,
                    padding: 16,
                    marginBottom: 14,
                }}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0, flex: '1 1 420px' }}>
                        <div style={{ fontSize: 12, color: COLORS.textMuted, marginBottom: 6 }}>评测任务</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <div style={{ fontSize: 20, fontWeight: 700, color: COLORS.text, lineHeight: 1.3 }}>
                                {run.taskTitle}
                            </div>
                            {autoWatchEnabled && <span style={badgeStyle('#EAF7F1', COLORS.success, true)}>自动观测</span>}
                        </div>
                        <div style={{ marginTop: 6, fontSize: 12.5, color: run.taskDescription ? COLORS.textSecondary : COLORS.textDisabled, lineHeight: 1.6 }}>
                            {run.taskDescription || ''}
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', minWidth: 408 }}>
                        <div
                            style={{
                                minWidth: 200,
                                flex: '0 0 200px',
                                padding: '12px 14px',
                                borderRadius: 10,
                                border: `1px solid ${autoWatchEnabled ? '#CDECDD' : COLORS.border}`,
                                background: autoWatchEnabled ? '#F6FFFA' : '#fff',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 14,
                            }}
                        >
                            <div style={{ minWidth: 0 }}>
                                <div style={{ fontSize: 11.5, color: COLORS.textMuted, marginBottom: 4 }}>自动观测</div>
                                <div style={{ fontSize: 14, color: autoWatchEnabled ? COLORS.success : COLORS.textDisabled, fontWeight: 700 }}>
                                    {autoWatchEnabled ? '开启中' : '已关闭'}
                                </div>
                            </div>
                            <LargeSwitch
                                checked={autoWatchEnabled}
                                disabled={updatingAutoWatch}
                                onChange={updateAutoWatch}
                                aria-label="切换自动观测"
                            />
                        </div>
                    </div>
                </div>
                <div
                    style={{
                        marginTop: 16,
                        paddingTop: 16,
                        borderTop: `1px solid ${COLORS.borderSoft}`,
                        display: 'grid',
                        gridTemplateColumns: 'minmax(220px, 1.25fr) minmax(180px, 1.15fr) repeat(3, minmax(120px, 1fr))',
                        gap: 14,
                    }}
                >
                    <Stat
                        label="执行 Agent"
                        value={run.executionAgent || '—'}
                        mono
                        primary
                        truncate
                    />
                    <Stat label="评估器" value={run.evaluatorName || '—'} truncate />
                    <Stat label="trace 总数" value={String(run.traceCount)} />
                    <Stat
                        label="评测进度"
                        value={`${run.doneCount} / ${run.traceCount}`}
                        detail={
                            <span style={{ fontSize: 11 }}>
                                <span style={{ color: COLORS.success }}>完成 {run.doneCount}</span>
                                {run.runningCount > 0 && <span style={{ color: '#1677ff' }}> · 进行中 {run.runningCount}</span>}
                                {run.failedCount > 0 && <span style={{ color: COLORS.danger }}> · 失败 {run.failedCount}</span>}
                            </span>
                        }
                    />
                    <Stat
                        label="平均分"
                        value={run.avgScore != null ? `${fmtScore10(run.avgScore)} / 10` : '--'}
                        valueColor={
                            run.avgScore != null
                                ? run.avgScore >= 0.8
                                    ? COLORS.success
                                    : run.avgScore >= 0.5
                                        ? COLORS.warning
                                        : COLORS.danger
                                : COLORS.textDisabled
                        }
                    />
                </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text }}>本批次 trace 评测列表</div>
                <div style={{ fontSize: 12, color: COLORS.textMuted }}>点行查看单条 trace 的评测细节</div>
                <div style={{ flex: 1 }} />
                <button
                    type="button"
                    onClick={() => {
                        setAddOpen(open => !open);
                        setAddError('');
                        setAddMessage('');
                    }}
                    style={{
                        padding: '5px 11px',
                        borderRadius: 6,
                        border: `1px solid ${COLORS.primary}`,
                        background: addOpen ? COLORS.primarySubtle : '#fff',
                        color: COLORS.primary,
                        fontSize: 12,
                        fontWeight: 500,
                        cursor: 'pointer',
                    }}
                >
                    + 增加评测 trace
                </button>
            </div>

            {(addOpen || addMessage || addError) && (
                <div
                    style={{
                        border: `1px solid ${COLORS.border}`,
                        borderRadius: 8,
                        background: '#fff',
                        padding: 12,
                        marginBottom: 10,
                    }}
                >
                    {addError && <div style={infoBoxStyle(COLORS.danger, COLORS.dangerSubtle, '#FFD4D4')}>{addError}</div>}
                    {addMessage && <div style={infoBoxStyle(COLORS.success, '#F0F7F4', '#D1EAE2')}>{addMessage}</div>}
                    {addOpen ? (
                        <>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                                <div style={{ fontSize: 12, color: COLORS.textMuted }}>
                                    可追加 trace：{addableRecords.length}
                                </div>
                                <div style={{ flex: 1 }} />
                                <button
                                    type="button"
                                    disabled={adding || selectedAddTraceIds.size === 0}
                                    onClick={submitAddTraces}
                                    style={{
                                        padding: '5px 12px',
                                        borderRadius: 6,
                                        border: 'none',
                                        background: adding || selectedAddTraceIds.size === 0 ? '#bdb8df' : COLORS.primary,
                                        color: '#fff',
                                        fontSize: 12,
                                        cursor: adding || selectedAddTraceIds.size === 0 ? 'not-allowed' : 'pointer',
                                    }}
                                >
                                    {adding ? '追加中...' : `开始评测 (${selectedAddTraceIds.size})`}
                                </button>
                            </div>
                            {addableRecords.length === 0 ? (
                                <div style={{ padding: 16, textAlign: 'center', fontSize: 12, color: COLORS.textMuted }}>
                                    没有可追加的 trace。
                                </div>
                            ) : (
                                <div style={{ maxHeight: 260, overflow: 'auto', border: `1px solid ${COLORS.borderSoft}`, borderRadius: 6 }}>
                                    <div
                                        style={{
                                            display: 'grid',
                                            gridTemplateColumns: '28px minmax(170px, 220px) minmax(0, 1fr) minmax(0, 1fr) 84px',
                                            gap: 10,
                                            alignItems: 'center',
                                            padding: '8px 10px',
                                            borderBottom: `1px solid ${COLORS.borderSoft}`,
                                            background: COLORS.bgSoft,
                                            color: COLORS.textMuted,
                                            fontSize: 11,
                                            fontWeight: 500,
                                        }}
                                    >
                                        <span />
                                        <span>TRACE ID</span>
                                        <span>Trace 实际输入</span>
                                        <span>Trace 实际输出</span>
                                        <span style={{ textAlign: 'right' }}>执行时间</span>
                                    </div>
                                    {addableRecords.map(record => {
                                        const traceId = record.task_id || '';
                                        return (
                                            <label
                                                key={traceId}
                                                style={{
                                                    display: 'grid',
                                                    gridTemplateColumns: '28px minmax(170px, 220px) minmax(0, 1fr) minmax(0, 1fr) 84px',
                                                    gap: 10,
                                                    alignItems: 'center',
                                                    padding: '8px 10px',
                                                    borderBottom: `1px solid ${COLORS.borderSoft}`,
                                                    cursor: 'pointer',
                                                    fontSize: 12,
                                                }}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={selectedAddTraceIds.has(traceId)}
                                                    onChange={() => toggleAddTrace(traceId)}
                                                />
                                                <code style={{ color: COLORS.textMuted, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }} title={traceId}>
                                                    {formatTraceIdPreview(traceId)}
                                                </code>
                                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={record.query || ''}>
                                                    {record.query || '(空输入)'}
                                                </span>
                                                <span style={{ minWidth: 0 }}>
                                                    <span
                                                        style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                                        title={record.final_result || ''}
                                                    >
                                                        {record.final_result || '—'}
                                                    </span>
                                                    <span style={{ display: 'block', color: COLORS.textDisabled, fontSize: 10, marginTop: 2 }}>
                                                        {record.framework || ''}{record.model ? ` · ${record.model}` : ''}
                                                    </span>
                                                </span>
                                                <span style={{ color: COLORS.textMuted, textAlign: 'right' }}>{fmtRelTime(record.timestamp)}</span>
                                            </label>
                                        );
                                    })}
                                </div>
                            )}
                        </>
                    ) : null}
                </div>
            )}

            <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 9, overflow: 'hidden', background: '#fff' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                        <tr style={{ background: COLORS.bgSoft, borderBottom: `1px solid ${COLORS.border}` }}>
                            <th style={thStyle(170, 'left')}>TRACE ID</th>
                            <th style={thStyle(undefined, 'left')}>Trace 实际输入</th>
                            <th style={thStyle(undefined, 'left')}>Trace 实际输出</th>
                            <th style={thStyle(80, 'center')}>评测状态</th>
                            <th style={thStyle(92, 'left')}>得分</th>
                            <th style={thStyle(110, 'left')}>评测时间</th>
                        </tr>
                    </thead>
                    <tbody>
                        {results.map(r => {
                            const traceId = r.taskId || r.executionId || '';
                            const exec = recordMap.get(traceId);
                            const clickable = !!traceId;
                            const displayScore = getDisplayScore(r, exec);
                            return (
                                <tr
                                    key={r.id}
                                    onClick={() => {
                                        if (!traceId) return;
                                        onBeforeOpenTrace(run.runId);
                                        const qs = new URLSearchParams({
                                            runId: run.runId,
                                            datasetId: r.datasetId,
                                        });
                                        if (autoWatchOnly) qs.set('autoWatchOnly', '1');
                                        router.push(`/eval/trajectory/${encodeURIComponent(traceId)}?${qs.toString()}`);
                                    }}
                                    style={{ borderBottom: `1px solid ${COLORS.borderSoft}`, cursor: clickable ? 'pointer' : 'default' }}
                                    onMouseEnter={e => { if (clickable) e.currentTarget.style.background = COLORS.bgSoft; }}
                                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                                >
                                    <td style={{ ...tdStyle('left'), fontFamily: 'var(--font-mono)', color: COLORS.textSecondary, whiteSpace: 'nowrap' }} title={traceId}>
                                        {formatTraceIdPreview(traceId)}
                                    </td>
                                    <td style={{ ...tdStyle('left'), maxWidth: 280 }} title={exec?.query || ''}>
                                        {exec ? (
                                            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {exec.query || '(空)'}
                                            </div>
                                        ) : (
                                            <span style={{ color: COLORS.textDisabled }}>(无 trace 输入)</span>
                                        )}
                                    </td>
                                    <td style={{ ...tdStyle('left'), maxWidth: 280 }} title={exec?.final_result || ''}>
                                        {exec ? (
                                            <>
                                                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                    {exec.final_result || '—'}
                                                </div>
                                                <div style={{ fontSize: 11, color: COLORS.textDisabled, marginTop: 2 }}>
                                                    {exec.framework} · {exec.model}
                                                </div>
                                            </>
                                        ) : (
                                            <span style={{ color: COLORS.textDisabled }}>(无 trace 元数据)</span>
                                        )}
                                    </td>
                                    <td style={tdStyle('center')}>
                                        <span style={{ color: getStatusColor(r), fontWeight: 500 }} title={r.errorMessage || r.resultEvaluationError || ''}>
                                            {getStatusLabel(r)}
                                        </span>
                                    </td>
                                    <td style={{ ...tdStyle('left'), minWidth: 92, color: displayScore != null ? COLORS.primary : COLORS.textDisabled, fontWeight: 600 }}>
                                        {displayScore != null ? `${fmtScore10(displayScore)} 分` : '--'}
                                    </td>
                                    <td style={{ ...tdStyle('left'), color: COLORS.textMuted }}>{fmtTime(r.createdAt)}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

/* ============================================================
 * 右栏：历史批次 sidebar item
 * ============================================================ */
function RunSidebarItem({ run, active, onClick }: { run: RunSummary; active: boolean; onClick: () => void }) {
    const totalScore = run.avgScore != null ? `${fmtScore10(run.avgScore)} / 10` : '—';
    return (
        <div
            onClick={onClick}
            style={{
                padding: 12,
                border: `1px solid ${active ? COLORS.primary : COLORS.border}`,
                borderRadius: 6,
                background: active ? COLORS.primarySubtle : '#fff',
                cursor: 'pointer',
                transition: 'border-color 0.15s, background 0.15s',
            }}
            onMouseEnter={e => { if (!active) e.currentTarget.style.borderColor = '#d8d6cf'; }}
            onMouseLeave={e => { if (!active) e.currentTarget.style.borderColor = COLORS.border; }}
        >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: COLORS.text }} title={run.taskTitle}>
                    {run.taskTitle}
                </span>
                <span style={{ fontSize: 11, color: COLORS.textMuted }}>{fmtRelTime(run.createdAt)}</span>
            </div>
            {run.autoWatch && (
                <div style={{ marginBottom: 8 }}>
                    <span style={badgeStyle('#EAF7F1', COLORS.success, true)}>自动观测</span>
                </div>
            )}
            <div
                style={{
                    fontSize: 11.5,
                    color: run.taskDescription ? COLORS.textSecondary : COLORS.textDisabled,
                    marginBottom: 8,
                    lineHeight: 1.5,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                }}
                title={run.taskDescription || ''}
            >
                {run.taskDescription || ''}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: COLORS.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {run.executionAgent || '未识别 Agent'}
                </span>
            </div>
            <div
                style={{
                    fontSize: 11,
                    color: COLORS.textMuted,
                    marginBottom: 8,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                }}
                title={run.evaluatorName}
            >
                评估器：{run.evaluatorName || '—'}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                <ProgressDot done={run.doneCount} running={run.runningCount} failed={run.failedCount} total={run.traceCount} />
                <span style={{ color: COLORS.textMuted }}>
                    {run.doneCount}/{run.traceCount}
                </span>
                <span style={{ flex: 1 }} />
                <span style={{ color: run.avgScore != null ? COLORS.primary : COLORS.textDisabled, fontWeight: 600 }}>
                    {totalScore}
                </span>
            </div>
        </div>
    );
}

function ProgressDot({ done, running, failed, total }: { done: number; running: number; failed: number; total: number }) {
    if (total === 0) return null;
    return (
        <div style={{ display: 'flex', height: 4, width: 60, background: COLORS.bgSoft, borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ width: `${(done / total) * 100}%`, background: COLORS.success }} />
            <div style={{ width: `${(running / total) * 100}%`, background: '#1677ff' }} />
            <div style={{ width: `${(failed / total) * 100}%`, background: COLORS.danger }} />
        </div>
    );
}

/* ============================================================
 * 空态 / 共享 UI
 * ============================================================ */
function EmptyState({ onCreate, error }: { onCreate: () => void; error: string }) {
    return (
        <div style={{ padding: '60px 22px', textAlign: 'center', color: COLORS.textMuted }}>
            <div style={{ marginBottom: 12, fontSize: 14 }}>还没有任何评测批次</div>
            {error && <div style={{ ...infoBoxStyle(COLORS.danger, COLORS.dangerSubtle, '#FFD4D4'), maxWidth: 480, margin: '0 auto 12px' }}>{error}</div>}
            <button
                onClick={onCreate}
                style={{
                    padding: '8px 18px',
                    background: COLORS.primary,
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: 'pointer',
                }}
            >
                发起首次评测 →
            </button>
        </div>
    );
}

function FilteredEmptyState({ onClear }: { onClear: () => void }) {
    return (
        <div style={{ padding: '60px 22px', textAlign: 'center', color: COLORS.textMuted }}>
            <div style={{ marginBottom: 12, fontSize: 14 }}>没有自动观测历史任务</div>
            <button
                onClick={onClear}
                style={{
                    padding: '8px 18px',
                    background: '#fff',
                    color: COLORS.primary,
                    border: `1px solid ${COLORS.primary}`,
                    borderRadius: 6,
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: 'pointer',
                }}
            >
                查看全部历史任务
            </button>
        </div>
    );
}

function Stat({
    label,
    value,
    detail,
    primary,
    mono,
    valueColor,
    truncate,
}: {
    label: string;
    value: string;
    detail?: React.ReactNode;
    primary?: boolean;
    mono?: boolean;
    valueColor?: string;
    truncate?: boolean;
}) {
    return (
        <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, color: COLORS.textMuted, marginBottom: 4 }}>{label}</div>
            <div
                title={truncate ? value : undefined}
                style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: valueColor || (primary ? COLORS.text : COLORS.textSecondary),
                    fontFamily: mono ? 'monospace' : undefined,
                    lineHeight: 1.35,
                    ...(truncate ? { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } : {}),
                }}
            >
                {value}
            </div>
            {detail ? <div style={{ marginTop: 3 }}>{detail}</div> : null}
        </div>
    );
}

function MetaPill({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
    return (
        <div
            style={{
                minWidth: 200,
                flex: '0 0 200px',
                padding: '8px 10px',
                borderRadius: 8,
                border: `1px solid ${COLORS.border}`,
                background: '#fff',
            }}
        >
            <div style={{ fontSize: 10.5, color: COLORS.textMuted, marginBottom: 3 }}>{label}</div>
            <div
                style={{
                    fontSize: 12,
                    color: COLORS.textSecondary,
                    fontFamily: mono ? 'var(--font-mono)' : undefined,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                }}
                title={value}
            >
                {value}
            </div>
        </div>
    );
}

function LargeSwitch({
    checked,
    disabled,
    onChange,
    'aria-label': ariaLabel,
}: {
    checked: boolean;
    disabled?: boolean;
    onChange: (checked: boolean) => void;
    'aria-label'?: string;
}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={ariaLabel}
            disabled={disabled}
            onClick={() => onChange(!checked)}
            style={{
                width: 42,
                height: 22,
                borderRadius: 999,
                border: `1px solid ${checked ? '#21A36B' : '#C9CDD3'}`,
                background: checked ? '#23B26F' : '#D6D8DC',
                padding: 2,
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.6 : 1,
                boxShadow: checked
                    ? 'inset 0 0 0 1px rgba(255,255,255,0.2), 0 1px 4px rgba(18, 128, 79, 0.16)'
                    : 'inset 0 0 0 1px rgba(255,255,255,0.35)',
                transition: 'background 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease',
            }}
        >
            <span
                style={{
                    display: 'block',
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    background: '#fff',
                    transform: checked ? 'translateX(20px)' : 'translateX(0)',
                    boxShadow: '0 1px 4px rgba(24, 24, 27, 0.2)',
                    transition: 'transform 0.16s ease',
                }}
            />
        </button>
    );
}

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

function infoBoxStyle(color: string, bg: string, border: string): CSSProperties {
    return {
        padding: 10,
        marginBottom: 12,
        borderRadius: 6,
        background: bg,
        border: `1px solid ${border}`,
        color,
        fontSize: 12,
    };
}

function thStyle(width?: number, align: 'left' | 'right' | 'center' = 'left'): CSSProperties {
    return {
        padding: '9px 10px',
        textAlign: align,
        fontWeight: 500,
        color: COLORS.textMuted,
        fontSize: 12,
        ...(width ? { width } : {}),
    };
}

function tdStyle(align: 'left' | 'right' | 'center' = 'left'): CSSProperties {
    return {
        padding: '9px 10px',
        textAlign: align,
        verticalAlign: 'middle',
        fontSize: 13,
    };
}
