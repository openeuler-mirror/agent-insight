'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Activity, ArrowLeft, ChevronLeft, ChevronRight, CornerDownRight, FileText, Loader2, RefreshCw, Search, ShieldAlert } from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/shell/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { CoreRequestError, LatestCoreRequest, formatCoreCount, formatCoreDuration, formatCoreTime, initialPayloadPage, nextPayloadPage, previousPayloadPage, readCoreJSON, type CoreSpan, type CoreTrace } from './storage-core-trace-model';

type LoadError = { status: number; message: string };
type TracePage = { items: CoreTrace[]; next_cursor?: string | null; partial?: boolean; scanned?: number; project_id?: string };
type SpanPage = { items: CoreSpan[]; next_span_id?: string | null; partial?: boolean; scanned?: number };
type PayloadChunk = { body: string; chunk_no: number | string };
type PayloadPage = { available: false } | { available?: true; chunks: PayloadChunk[]; next_chunk: number | null; complete: boolean; chunk_count: number };

const STATUS_OPTIONS = [
    { value: '', label: '全部状态' }, { value: 'done', label: '成功' },
    { value: 'failed', label: '失败' }, { value: 'running', label: '运行中' }, { value: 'unknown', label: '未上报' },
];

function queryURL(path: string, values: Record<string, string | number | null | undefined>) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) if (value != null && value !== '') params.set(key, String(value));
    return `${path}?${params}`;
}

function useCoreResource<T>(url: string | null, onData?: (data: T) => void, onError?: (error: LoadError) => void) {
    const router = useRouter();
    const gate = useRef(new LatestCoreRequest());
    const [version, setVersion] = useState(0);
    const requestKey = url == null ? '' : `${url}\0${version}`;
    const [state, setState] = useState<{ key: string; data: T | null; error: LoadError | null }>({ key: '', data: null, error: null });
    const reload = useCallback(() => setVersion(value => value + 1), []);
    useEffect(() => {
        const currentGate = gate.current;
        const request = currentGate.begin();
        if (!url) return () => currentGate.cancel();
        void readCoreJSON<T>(apiFetch, url, request.signal).then(data => {
            if (request.isCurrent()) { onData?.(data); setState({ key: requestKey, data, error: null }); }
        }).catch((error: unknown) => {
            if (!request.isCurrent()) return;
            const status = error instanceof CoreRequestError ? error.status : 0;
            if (status === 401) {
                const returnTo = window.location.pathname + window.location.search;
                router.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
            }
            const failure = { status, message: error instanceof CoreRequestError ? error.message : '网络连接失败，请重试。' };
            onError?.(failure);
            setState({ key: requestKey, data: null, error: failure });
        });
        return () => currentGate.cancel();
    }, [url, requestKey, router, onData, onError]);
    return { data: state.key === requestKey ? state.data : null, error: state.key === requestKey ? state.error : null, loading: !!url && state.key !== requestKey, reload };
}

function Status({ value }: { value?: string | null }) {
    const status = value || 'unknown';
    return <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs text-foreground-secondary', status === 'done' ? 'bg-success-subtle' : status === 'failed' ? 'bg-error-subtle' : status === 'running' ? 'bg-primary-subtle' : 'bg-background-secondary')}>
        <span className={cn('size-1.5 rounded-full', status === 'done' ? 'bg-success' : status === 'failed' ? 'bg-error' : status === 'running' ? 'bg-primary' : 'bg-foreground-muted')} aria-hidden />
        {STATUS_OPTIONS.find(item => item.value === status)?.label || status}
    </span>;
}

function Loading({ label = '正在加载' }: { label?: string }) {
    return <div role="status" className="flex items-center justify-center gap-2 p-8 text-sm text-foreground-muted"><Loader2 className="size-4 animate-spin" aria-hidden />{label}</div>;
}

function ErrorState({ error, retry }: { error: LoadError; retry: () => void }) {
    return <div role="alert" className="m-4 rounded-lg border border-border bg-background-secondary p-4 text-sm">
        <div className="mb-3 flex items-start gap-2"><ShieldAlert className="mt-0.5 size-4 shrink-0 text-foreground-muted" aria-hidden /><span>{error.message}</span></div>
        <Button type="button" size="sm" variant="outline" onClick={retry}><RefreshCw className="size-3" aria-hidden />重试</Button>
    </div>;
}

function Metric({ label, value }: { label: string; value: string }) {
    return <div className="min-w-0"><dt className="text-xs text-foreground-muted">{label}</dt><dd className="mt-1 truncate font-mono text-sm text-foreground" title={value}>{value}</dd></div>;
}

function PageControls({ previous, next, loading, count, partial }: { previous?: () => void; next?: () => void; loading: boolean; count?: number; partial?: boolean }) {
    return <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-1 text-xs text-foreground-muted">
        <span aria-live="polite">本页 {count == null ? '—' : count} 条{partial ? ' · 尚有数据待检索' : ''}</span>
        <div className="flex items-center gap-1">
            <Button type="button" variant="ghost" size="sm" className="h-7" aria-label="上一页" disabled={!previous || loading} onClick={previous}><ChevronLeft className="size-4" aria-hidden />上一页</Button>
            <Button type="button" variant="ghost" size="sm" className="h-7" aria-label={partial ? '继续搜索' : '下一页'} disabled={!next || loading} onClick={next}>{partial ? '继续搜索' : '下一页'}<ChevronRight className="size-4" aria-hidden /></Button>
        </div>
    </div>;
}

export default function StorageCoreTracePage() {
    const auth = useAuth();
    const router = useRouter();
    const params = useSearchParams();
    const workspace = params.get('workspace_id') || auth.workspaceId || auth.profile?.workspace_id || '';
    const selectedID = params.get('trace_id') || '';
    const [searchDraft, setSearchDraft] = useState('');
    const [agentDraft, setAgentDraft] = useState('');
    const [filters, setFilters] = useState({ search: '', agent: '', status: '' });
    const [cursor, setCursor] = useState('');
    const [history, setHistory] = useState<string[]>([]);
    const [notice, setNotice] = useState('');
    const listFailure = useCallback((error: LoadError) => {
        if (error.status === 409 && cursor) {
            setCursor(''); setHistory([]); setNotice('查询游标已失效，已返回第一页。');
        }
    }, [cursor]);
    const list = useCoreResource<TracePage>(auth.authReady && auth.user ? queryURL('/api/observe/data', { limit: 50, workspace_id: workspace, cursor, ...filters }) : null, undefined, listFailure);
    const items = Array.isArray(list.data?.items) ? list.data.items : [];

    const navigate = useCallback((traceID: string, workspaceID = workspace) => {
        const next = new URLSearchParams(params.toString());
        if (traceID) next.set('trace_id', traceID); else next.delete('trace_id');
        if (workspaceID) next.set('workspace_id', workspaceID); else next.delete('workspace_id');
        router.replace(`/trace${next.size ? `?${next}` : ''}`, { scroll: false });
    }, [params, router, workspace]);

    function applyFilters(event?: FormEvent) {
        event?.preventDefault();
        setCursor(''); setHistory([]); setNotice('');
        setFilters(value => ({ ...value, search: searchDraft.trim(), agent: agentDraft.trim() }));
        navigate(''); list.reload();
    }

    if (!auth.authReady || !auth.user) return <Loading label="正在确认登录状态" />;

    return <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
        <PageHeader variant="management" title="Trace" icon={Activity} badges={<Badge variant="outline">默认项目 · default</Badge>} description="浏览运行记录，按需查看 Span 与输入输出。" secondaryAction={{ label: '刷新', icon: RefreshCw, onClick: list.reload }} />
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-3">
            {!!auth.profile?.workspaces.length && <Select aria-label="工作区" value={workspace} label="工作区" options={auth.profile.workspaces.map(item => ({ value: item.workspace_id, label: item.name || item.workspace_id }))} onChange={value => { auth.setWorkspaceId?.(value); setCursor(''); setHistory([]); setNotice(''); navigate('', value); }} />}
            <form className="flex min-w-0 flex-1 flex-wrap items-center gap-2" onSubmit={applyFilters}>
                <Input aria-label="搜索 Trace" className="h-8 min-w-40 flex-1" placeholder="Trace ID 或 Agent 名称" value={searchDraft} maxLength={256} onChange={event => setSearchDraft(event.target.value)} />
                <Input aria-label="筛选 Agent" className="h-8 w-40" placeholder="Agent 名称" value={agentDraft} maxLength={256} onChange={event => setAgentDraft(event.target.value)} />
                <Select aria-label="Trace 状态" value={filters.status} options={STATUS_OPTIONS} active={!!filters.status} onChange={status => { setFilters(value => ({ ...value, status })); setCursor(''); setHistory([]); setNotice(''); navigate(''); }} />
                <Button type="submit" size="sm" variant="outline"><Search className="size-3.5" aria-hidden />搜索</Button>
            </form>
        </div>
        {notice && <div role="status" className="border-b border-border bg-background-secondary px-4 py-2 text-xs text-foreground-secondary">{notice}</div>}
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(320px,38%)_minmax(0,1fr)]">
            <section aria-label="Trace 列表" aria-busy={list.loading} className={cn('min-h-0 flex-col border-r border-border bg-card', selectedID ? 'hidden lg:flex' : 'flex')}>
                <div className="flex items-center justify-between border-b border-border px-4 py-3"><h2 className="text-sm font-semibold">运行记录</h2><span className="text-xs text-foreground-muted">每页最多 50 条</span></div>
                <div className="min-h-0 flex-1 overflow-auto">
                    {list.loading && <Loading label="正在加载运行记录" />}
                    {list.error && <ErrorState error={list.error} retry={list.reload} />}
                    {!list.loading && !list.error && list.data && items.length === 0 && <div className="p-8 text-center text-sm text-foreground-muted">{list.data.partial ? '本次扫描暂无匹配项，可继续搜索后续记录。' : '暂无匹配的运行记录。'}</div>}
                    {items.length > 0 && <table className="w-full table-fixed text-left text-xs"><thead className="sticky top-0 z-10 bg-background-secondary text-foreground-muted"><tr><th className="w-[52%] px-4 py-2 font-medium">Trace / Agent</th><th className="w-[22%] px-2 py-2 font-medium">状态</th><th className="px-2 py-2 font-medium">所属用户</th></tr></thead><tbody>{items.map(trace => <tr key={`${trace.workspace_id}:${trace.trace_id}`} className={cn('border-b border-border hover:bg-background-secondary', selectedID === trace.trace_id && 'bg-primary-subtle')}>
                        <td className="px-4 py-3"><button type="button" className="block w-full text-left outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring" aria-label={`查看 Trace ${trace.native_trace_id || trace.trace_id}`} aria-pressed={selectedID === trace.trace_id} onClick={() => navigate(trace.trace_id, trace.workspace_id || workspace)}><span className="block truncate font-medium text-foreground">{trace.agent_name || trace.framework || '未命名 Agent'}</span><span className="mt-1 block truncate font-mono text-foreground-muted" title={trace.trace_id}>{trace.native_trace_id || trace.trace_id}</span><span className="mt-1 block truncate text-foreground-muted">{formatCoreTime(trace.started_at_ms)} · {formatCoreCount(trace.span_count)} Span</span></button></td>
                        <td className="px-2 py-3 align-top"><Status value={trace.execution_status} /></td><td className="px-2 py-3 align-top"><span className="block truncate" title={trace.owner_principal_id || undefined}>{trace.owner_display_name || trace.owner_principal_id || '—'}</span></td>
                    </tr>)}</tbody></table>}
                </div>
                <PageControls loading={list.loading} count={list.data ? items.length : undefined} partial={list.data?.partial} previous={history.length ? () => { setCursor(history[history.length - 1]); setHistory(history.slice(0, -1)); } : undefined} next={list.data?.next_cursor ? () => { setHistory([...history, cursor]); setCursor(list.data!.next_cursor!); } : undefined} />
            </section>
            {selectedID ? <TraceDetail key={`${workspace}:${selectedID}`} workspace={workspace} traceID={selectedID} onBack={() => navigate('')} /> : <section aria-label="Trace 详情" className="hidden min-h-0 items-center justify-center bg-background-secondary p-8 lg:flex"><div className="max-w-xs text-center"><Activity className="mx-auto mb-4 size-8 text-foreground-muted" aria-hidden /><h2 className="text-base font-medium">选择一条 Trace</h2><p className="mt-2 text-sm leading-6 text-foreground-muted">先浏览 Span 结构，再查看单条 Span 的详情与输入输出。</p></div></section>}
        </div>
    </div>;
}

function TraceDetail({ workspace, traceID, onBack }: { workspace: string; traceID: string; onBack: () => void }) {
    const summary = useCoreResource<{ trace: CoreTrace | null; state?: string }>(queryURL('/api/observe/session', { workspace_id: workspace, trace_id: traceID, action: 'summary' }));
    const [searchDraft, setSearchDraft] = useState('');
    const [search, setSearch] = useState('');
    const [status, setStatus] = useState('');
    const [parent, setParent] = useState('');
    const [cursor, setCursor] = useState('');
    const [history, setHistory] = useState<string[]>([]);
    const [spanID, setSpanID] = useState('');
    const [focusSpan, setFocusSpan] = useState(false);
    const [expandSummary, setExpandSummary] = useState(false);
    const spans = useCoreResource<SpanPage>(summary.data?.trace ? queryURL('/api/observe/session', { workspace_id: workspace, trace_id: traceID, action: 'spans', limit: 200, after_span_id: cursor, search, status, parent_span_id: parent }) : null);
    const trace = summary.data?.trace;
    const items = Array.isArray(spans.data?.items) ? spans.data.items : [];
    const resetStructure = () => { setCursor(''); setHistory([]); setSpanID(''); setFocusSpan(false); setExpandSummary(false); };
    const selectSpan = (id: string) => { setSpanID(id); if (!id) { setFocusSpan(false); setExpandSummary(false); } };
    return <section aria-label="Trace 详情" className="flex min-h-0 flex-col overflow-y-auto bg-card">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3"><Button type="button" variant="ghost" size="sm" aria-label="返回 Trace 列表" onClick={onBack}><ArrowLeft className="size-4" aria-hidden /></Button><div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold">{trace?.agent_name || 'Trace 详情'}</h2><p className="truncate font-mono text-xs text-foreground-muted" title={traceID}>{trace?.native_trace_id || traceID}</p></div><Button type="button" variant="ghost" size="sm" aria-label="刷新 Trace 详情" onClick={summary.reload}><RefreshCw className="size-4" aria-hidden /></Button></div>
        {summary.loading && <Loading label="正在加载 Trace 摘要" />}
        {summary.error && <ErrorState error={summary.error} retry={summary.reload} />}
        {summary.data && !trace && <div role="status" className="p-8 text-center text-sm text-foreground-muted"><p>Trace 已接收，正在建立索引。</p><Button type="button" variant="outline" size="sm" className="mt-3" onClick={summary.reload}><RefreshCw className="size-3.5" aria-hidden />刷新索引状态</Button></div>}
        {trace && <>
            {spanID && !expandSummary ? <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-1 text-xs text-foreground-muted"><Status value={trace.execution_status} /><span>{formatCoreCount(trace.span_count)} Span · {formatCoreDuration(trace)}</span><Button type="button" variant="ghost" size="sm" className="ml-auto h-7 text-xs" onClick={() => setExpandSummary(true)}>展开 Trace 摘要</Button></div> : <div className="shrink-0 border-b border-border px-4 py-3"><div className="mb-3 flex flex-wrap items-center gap-2"><Status value={trace.execution_status} /><span className="text-xs text-foreground-muted">{trace.framework || '框架未上报'}</span>{spanID && <Button type="button" variant="ghost" size="sm" className="ml-auto h-6 text-xs" onClick={() => setExpandSummary(false)}>收起摘要</Button>}</div><dl className="grid grid-cols-2 gap-3 sm:grid-cols-4"><Metric label="Span 数量" value={formatCoreCount(trace.span_count)} /><Metric label="持续时间" value={formatCoreDuration(trace)} /><Metric label="输入 Token" value={formatCoreCount(trace.input_tokens)} /><Metric label="输出 Token" value={formatCoreCount(trace.output_tokens)} /></dl></div>}
            <div className={cn('flex flex-1 flex-col overflow-hidden', spanID && !focusSpan ? 'min-h-[280px] lg:min-h-[460px]' : 'min-h-[220px]')}>
                <section aria-label="Span 结构" aria-busy={spans.loading} className={cn('min-h-0 flex-col', focusSpan ? 'hidden' : spanID ? 'hidden lg:flex lg:flex-[1_1_60%]' : 'flex flex-1')}>
                    <div className="shrink-0 px-4 pt-2"><div className="mb-1 flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">Span 结构</h3><span className="text-xs text-foreground-muted">按 ID 分页 · 每页最多 200 条</span></div>
                        <form className="flex items-center gap-2" onSubmit={event => { event.preventDefault(); setSearch(searchDraft.trim()); resetStructure(); spans.reload(); }}><Input aria-label="搜索 Span" className="h-8" placeholder="搜索 Span 名称或 ID" value={searchDraft} maxLength={256} onChange={event => setSearchDraft(event.target.value)} /><Select aria-label="Span 状态" value={status} options={STATUS_OPTIONS} onChange={value => { setStatus(value); resetStructure(); }} /><Button type="submit" variant="outline" size="sm" aria-label="搜索 Span 结构"><Search className="size-3.5" aria-hidden /></Button></form>
                        {parent && <div className="mt-2 flex min-w-0 items-center gap-2 text-xs text-foreground-muted"><CornerDownRight className="size-3.5 shrink-0" aria-hidden /><span className="truncate font-mono">父 Span: {parent}</span><Button type="button" variant="ghost" size="sm" onClick={() => { setParent(''); resetStructure(); }}>全部 Span</Button></div>}
                    </div>
                    <div className="mt-1 min-h-0 flex-1 overflow-auto">
                        {spans.loading && <Loading label="正在加载 Span 结构" />}
                        {spans.error && <ErrorState error={spans.error} retry={spans.reload} />}
                        {!spans.loading && !spans.error && spans.data && items.length === 0 && <p className="p-6 text-center text-sm text-foreground-muted">{spans.data.partial ? '本次扫描暂无匹配项，请继续搜索。' : '暂无匹配的 Span。'}</p>}
                        {items.length > 0 && <table className="w-full table-fixed text-left text-xs"><thead className="sticky top-0 z-10 bg-background-secondary text-foreground-muted"><tr><th className="w-[45%] px-4 py-2 font-medium">名称 / Span ID</th><th className="px-2 py-2 font-medium">状态</th><th className="px-2 py-2 font-medium">耗时</th><th className="w-10 py-2"><span className="sr-only">子 Span</span></th></tr></thead><tbody>{items.map(span => <tr key={span.span_id} className={cn('border-b border-border hover:bg-background-secondary', spanID === span.span_id && 'bg-primary-subtle')}><td className="px-4 py-2"><button type="button" aria-label={`查看 Span ${span.name || span.span_id}`} aria-pressed={spanID === span.span_id} className="block w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setSpanID(span.span_id)}><span className="block truncate font-medium">{span.name || span.kind || '未命名 Span'}</span><span className="mt-0.5 block truncate font-mono text-foreground-muted" title={span.span_id}>{span.span_id}</span></button></td><td className="px-2 py-2"><Status value={span.execution_status} /></td><td className="px-2 py-2 whitespace-nowrap font-mono text-foreground-secondary">{formatCoreDuration(span)}</td><td className="pr-2"><Button type="button" variant="ghost" size="icon" className="size-7" aria-label={`查看 ${span.span_id} 的子 Span`} onClick={() => { setParent(span.span_id); resetStructure(); }}><CornerDownRight className="size-3.5" aria-hidden /></Button></td></tr>)}</tbody></table>}
                    </div>
                    <PageControls loading={spans.loading} count={spans.data ? items.length : undefined} partial={spans.data?.partial} previous={history.length ? () => { setCursor(history[history.length - 1]); setHistory(history.slice(0, -1)); setSpanID(''); } : undefined} next={spans.data?.next_span_id ? () => { setHistory([...history, cursor]); setCursor(spans.data!.next_span_id!); setSpanID(''); } : undefined} />
                </section>
                {spanID && <SpanDetail key={spanID} workspace={workspace} traceID={traceID} spanID={spanID} selectSpan={selectSpan} focused={focusSpan} toggleFocus={() => { if (focusSpan) selectSpan(''); else setFocusSpan(true); }} />}
            </div>
        </>}
    </section>;
}

function SpanDetail({ workspace, traceID, spanID, selectSpan, focused, toggleFocus }: { workspace: string; traceID: string; spanID: string; selectSpan: (id: string) => void; focused: boolean; toggleFocus: () => void }) {
    const detail = useCoreResource<{ span: CoreSpan | null }>(queryURL('/api/observe/session', { workspace_id: workspace, trace_id: traceID, action: 'span', span_id: spanID }));
    const [section, setSection] = useState('input');
    const span = detail.data?.span;
    return <section aria-label="Span 详情" className={cn('flex min-h-[180px] flex-col overflow-hidden border-t border-border bg-background-secondary', focused ? 'flex-1' : 'flex-[1_1_40%]')}>
        <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-1"><h3 className="truncate text-sm font-semibold" title={spanID}>{span?.name || 'Span 详情'}</h3><div className="flex shrink-0 items-center gap-1"><Button type="button" variant="ghost" size="sm" className="h-7" aria-label={focused ? '返回 Span 结构' : '展开 Span 详情'} onClick={toggleFocus}>{focused ? '返回结构' : '展开详情'}</Button><Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => selectSpan('')}>关闭详情</Button></div></div>
        {detail.loading && <Loading label="正在加载单条 Span" />}
        {detail.error && <ErrorState error={detail.error} retry={detail.reload} />}
        {detail.data && !span && <p role="status" className="p-4 text-sm text-foreground-muted">此 Span 不存在，或已被删除。</p>}
        {span && <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">{focused ? <><p className="mb-3 break-all font-mono text-xs text-foreground-muted">{span.span_id}</p><dl className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4"><Metric label="耗时" value={formatCoreDuration(span)} /><Metric label="模型 / 工具" value={span.model || span.tool_name || '—'} /><Metric label="输入 Token" value={formatCoreCount(span.input_tokens)} /><Metric label="输出 Token" value={formatCoreCount(span.output_tokens)} /></dl></> : <p className="mb-2 text-xs text-foreground-muted">耗时 {formatCoreDuration(span)} · 输入 {formatCoreCount(span.input_tokens)} · 输出 {formatCoreCount(span.output_tokens)}</p>}
            {span.parent_span_id && <Button type="button" variant="link" className="mb-2 h-auto max-w-full p-0 text-xs" onClick={() => selectSpan(span.parent_span_id!)}><ArrowLeft className="size-3" aria-hidden /><span className="truncate">查看父 Span {span.parent_span_id}</span></Button>}
            <div role="tablist" aria-label="Span 内容" className="mb-3 flex gap-1 border-b border-border">{[{ value: 'input', label: '输入' }, { value: 'output', label: '输出' }, { value: 'attributes', label: '属性' }].map(tab => <button key={tab.value} type="button" role="tab" aria-selected={section === tab.value} className={cn('border-b-2 px-3 py-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring', section === tab.value ? 'border-primary text-primary' : 'border-transparent text-foreground-muted hover:text-foreground')} onClick={() => setSection(tab.value)}>{tab.label}</button>)}</div>
            {span.payload_revision ? <PayloadSection key={`${span.span_id}:${span.payload_revision}:${section}`} workspace={workspace} traceID={traceID} span={span} section={section} /> : <p className="py-4 text-sm text-foreground-muted">此 Span 尚未上报内容。</p>}
        </div>}
    </section>;
}

function PayloadSection({ workspace, traceID, span, section }: { workspace: string; traceID: string; span: CoreSpan; section: string }) {
    const [view, setView] = useState(initialPayloadPage);
    const payload = useCoreResource<PayloadPage>(queryURL('/api/observe/session', { workspace_id: workspace, trace_id: traceID, action: 'payload', span_id: span.span_id, revision: span.payload_revision, section, after_chunk: view.after, limit: 4 }));
    const page = payload.data && payload.data.available !== false ? payload.data : null;
    const chunks = page?.chunks || [];
    return <div role="tabpanel" aria-label={`${section} 内容`}>
        {payload.data?.available === false && <p role="status" className="py-4 text-sm text-foreground-muted">此 Span 尚未上报{section === 'input' ? '输入' : section === 'output' ? '输出' : '属性'}内容。</p>}
        {chunks.length > 0 && (chunks.some(chunk => chunk.body.length > 0) ? <pre tabIndex={0} aria-label={`正文第 ${view.previous.length + 1} 页`} className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-card p-3 font-mono text-xs leading-5 text-foreground-secondary outline-none focus-visible:ring-2 focus-visible:ring-ring">{chunks.map(chunk => chunk.body).join('')}</pre> : <p className="py-4 text-sm text-foreground-muted">内容已上报，值为空。</p>)}
        {payload.loading && <Loading label="正在读取此页内容" />}
        {payload.error && <ErrorState error={payload.error} retry={payload.reload} />}
        {(page || view.previous.length > 0) && <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-foreground-muted"><span><FileText className="mr-1 inline size-3" aria-hidden />内容第 {view.previous.length + 1} 页{page && chunks.length ? ` · 第 ${Number(chunks[0].chunk_no) + 1}–${Number(chunks[chunks.length - 1].chunk_no) + 1} / ${formatCoreCount(page.chunk_count)} 块` : ''}</span><div className="flex items-center gap-1"><Button type="button" variant="outline" size="sm" className="h-7" disabled={!view.previous.length || payload.loading} onClick={() => setView(previousPayloadPage)}>上一段内容</Button><Button type="button" variant="outline" size="sm" className="h-7" disabled={!page || page.next_chunk == null || payload.loading} onClick={() => setView(current => nextPayloadPage(current, page?.next_chunk ?? null))}>后续内容</Button></div></div>}
    </div>;
}
