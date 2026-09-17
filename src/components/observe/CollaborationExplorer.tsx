'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import { Button } from '@/components/ui/button';

type Node = { sessionId: string; name: string; traceResolution: string; traceSessionId?: string; message?: string };
type Edge = { eventId: string; fromSessionId: string; toSessionId: string; description: string; content?: string; observedAt?: string; receivedAt?: string; sources: string[]; fromLocator?: unknown; fromAnchor: { status: string; message: string; position?: { interactionIndex: number }; candidates?: unknown[]; orderIndex?: number } };
type Graph = { collaborationId: string; nodes: Node[]; events: Edge[]; automaticEvents: Edge[]; total: number; nextOffset: number | null; resolutionComplete: boolean };
type Entry = { collaborationId: string; eventCount: number; sourceType: string };
const labels: Record<string, string> = { confirmed: '明确关联', candidate: '候选位置', time_ordered: '按时间顺序关联（推定）', ambiguous: '存在歧义', waiting_trace: '等待 Trace', not_found: '未找到步骤', not_provided: '未关联步骤', pending: '待查询' };

export default function CollaborationExplorer() {
    const { apiKey } = useAuth();
    const params = useParams<{ collaborationId?: string }>();
    const search = useSearchParams();
    const nativeTask = search.get('traceTaskId');
    const id = params.collaborationId;
    const [entries, setEntries] = useState<Entry[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [graph, setGraph] = useState<Graph | null>(null);
    const [selection, setSelection] = useState<{ type: 'node' | 'edge'; id: string } | null>(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [zoom, setZoom] = useState(1);
    const [body, setBody] = useState<unknown>(undefined);
    const [bodyError, setBodyError] = useState('');
    const [bodyBusy, setBodyBusy] = useState(false);
    const generation = useRef(0);
    const bodyGeneration = useRef(0);
    const request = useCallback(async (url: string) => {
        const response = await apiFetch(url, { cache: 'no-store', headers: { 'x-witty-api-key': apiKey || '' } });
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error?.message || data?.error || `请求失败 (${response.status})`);
        return data;
    }, [apiKey]);
    const load = useCallback(async (more?: number | string) => {
        if (!apiKey) return;
        const current = ++generation.current;
        bodyGeneration.current++;
        setBody(undefined); setBodyError(''); setBodyBusy(false); setBusy(true); setError('');
        try {
            if (id || nativeTask) {
                const next: Graph = await request(nativeTask
                    ? `/api/observe/collaborations/native?traceTaskId=${encodeURIComponent(nativeTask)}`
                    : `/api/observe/collaborations/${encodeURIComponent(id!)}?offset=${typeof more === 'number' ? more : 0}&limit=100`);
                if (generation.current !== current) return;
                setGraph(previous => typeof more === 'number' && previous ? {
                    ...next,
                    nodes: [...new Map([...previous.nodes, ...next.nodes].map(node => [node.sessionId, node])).values()],
                    events: [...new Map([...previous.events, ...next.events].map(edge => [edge.eventId, edge])).values()],
                } : next);
                if (more === undefined) setSelection(null);
            } else {
                const next = await request(`/api/observe/collaborations?limit=50${typeof more === 'string' ? `&cursor=${encodeURIComponent(more)}` : ''}`);
                if (generation.current !== current) return;
                setEntries(previous => typeof more === 'string' ? [...new Map([...previous, ...next.items].map(item => [item.collaborationId, item])).values()] : next.items);
                setCursor(next.nextCursor);
            }
        } catch (err) { if (generation.current === current) setError(err instanceof Error ? err.message : '查询失败'); }
        finally { if (generation.current === current) setBusy(false); }
    }, [apiKey, id, nativeTask, request]);
    useEffect(() => { setGraph(null); setEntries([]); setCursor(null); setSelection(null); setBody(undefined); setBodyError(''); void load(); return () => { generation.current++; bodyGeneration.current++; }; }, [load]);
    const edges = [...(graph?.events ?? []), ...(graph?.automaticEvents ?? [])];
    const node = selection?.type === 'node' ? graph?.nodes.find(item => item.sessionId === selection.id) : undefined;
    const edge = selection?.type === 'edge' ? edges.find(item => item.eventId === selection.id) : undefined;
    const source = edge ? graph?.nodes.find(item => item.sessionId === edge.fromSessionId) : node;
    const select = (type: 'node' | 'edge', id: string) => { bodyGeneration.current++; setSelection({ type, id }); setBody(undefined); setBodyError(''); setBodyBusy(false); };
    const loadBody = async () => {
        if (!source?.traceSessionId) return;
        const current = ++bodyGeneration.current;
        setBodyError(''); setBodyBusy(true);
        try {
            const index = edge?.fromAnchor.position?.interactionIndex;
            const data = await request(`/api/observe/session?taskId=${encodeURIComponent(source.traceSessionId)}&${index == null ? 'view=interactions&source=raw' : `view=interaction&source=raw&index=${index}`}`);
            if (current === bodyGeneration.current) setBody(index == null ? data.interactions : data.interaction);
        } catch (err) { if (current === bodyGeneration.current) setBodyError(err instanceof Error ? err.message : '原文加载失败'); }
        finally { if (current === bodyGeneration.current) setBodyBusy(false); }
    };
    const visibleNodes = graph?.nodes.slice(0, 200) ?? [];
    const count = visibleNodes.length;
    const radius = Math.max(230, count * 35);
    const size = radius * 2 + 260;
    const positions = new Map(visibleNodes.map((item, index) => {
        const angle = count === 1 ? 0 : index * 2 * Math.PI / count - Math.PI / 2;
        return [item.sessionId, { x: size / 2 + (count === 1 ? 0 : radius * Math.cos(angle)), y: size / 2 + (count === 1 ? 0 : radius * Math.sin(angle)) }];
    }));
    return <main className="p-6 space-y-4">
        <div className="flex items-center justify-between gap-4">
            <div><h1 className="text-xl font-semibold">Agent 协作图</h1><p className="text-sm text-foreground-muted">查看会话之间的调用与信息传递；节点位置不代表执行顺序。</p></div>
            <div className="flex gap-2"><Button variant="outline" asChild><Link href="/trace">链路追踪</Link></Button>{(id || nativeTask) && <Button variant="outline" asChild><Link href="/observe/collaborations">全部协作</Link></Button>}<Button disabled={busy || !apiKey} onClick={() => void load()}>{busy ? '加载中…' : '刷新'}</Button></div>
        </div>
        {!apiKey && <p role="status">请登录后查看协作记录。</p>}
        {error && <p role="alert" className="text-destructive">{error}</p>}
        {!id && !nativeTask && <div className="rounded-md border border-card-border bg-card divide-y divide-card-border">
            {!entries.length && !busy && <p className="p-6 text-foreground-muted">暂无上报协作。首次发送关系事件后，这里自动出现协作记录；查看已有 Trace 的自动关系，请从 Trace 详情打开“调用关系图”。</p>}
            {entries.map(item => <Link className="block p-4 hover:bg-muted" key={item.collaborationId} href={`/observe/collaborations/${encodeURIComponent(item.collaborationId)}`}><div className="font-medium break-all">{item.collaborationId}</div><p className="text-sm text-foreground-muted">{item.eventCount} 条事件 · {item.sourceType === 'reported' ? '用户上报' : '自动采集'}</p></Link>)}
            {cursor && <Button className="m-4" variant="outline" disabled={busy} onClick={() => void load(cursor)}>加载更多协作</Button>}
        </div>}
        {nativeTask && <p className="text-sm text-foreground-muted">当前显示这条 Trace 中有明确证据的原生调用。通过接口上报的跨会话关系，请点击“全部协作”并选择对应的协作编号查看。</p>}
        {id && <p className="text-sm text-foreground-muted">这里将同一协作的会话和联系展示在一张图中；链路追踪列表仍保留各条原始 Trace。</p>}
        {graph && <>
            <div className="flex flex-wrap gap-4 text-sm"><span className="break-all">{nativeTask || graph.collaborationId}</span><span>{graph.nodes.length} 个会话 · {edges.length} 条可见关系</span><span className="text-foreground-muted">任务结束状态未知</span></div>
            {!graph.resolutionComplete && <p role="status" className="text-warning">当前数据超过单次解析限制，仍可分页查看上报关系；步骤和自动关系可能不完整。</p>}
            <div className="flex items-center gap-2 text-sm"><Button variant="outline" size="sm" onClick={() => setZoom(value => Math.max(0.1, value / 1.4))}>缩小</Button><span>{Math.round(zoom * 100)}%</span><Button variant="outline" size="sm" onClick={() => setZoom(value => Math.min(2, value * 1.4))}>放大</Button><Button variant="ghost" size="sm" onClick={() => setZoom(1)}>重置</Button>{graph.nodes.length > 200 && <span className="text-foreground-muted">图中显示前 200 个节点，其余联系请在事件列表查看。</span>}</div>
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
                <div className="overflow-auto max-h-[640px] rounded-md border border-card-border bg-card">
                    <svg width={size * zoom} height={size * zoom} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Agent 协作关系图" className="text-foreground">
                        <defs><marker id="collaboration-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="currentColor" /></marker></defs>
                        {edges.map((item, index) => {
                            const a = positions.get(item.fromSessionId), b = positions.get(item.toSessionId); if (!a || !b) return null;
                            const repeats = edges.filter(e => e.fromSessionId === item.fromSessionId && e.toSessionId === item.toSessionId);
                            const ordinal = repeats.findIndex(e => e.eventId === item.eventId);
                            const offset = 30 + ordinal * 32;
                            const self = item.fromSessionId === item.toSessionId;
                            const dx = b.x - a.x, dy = b.y - a.y, distance = Math.hypot(dx, dy) || 1;
                            const cx = (a.x + b.x) / 2 - dy / distance * offset, cy = (a.y + b.y) / 2 + dx / distance * offset;
                            const endX = b.x - dx / distance * 98, endY = b.y - dy / distance * 34;
                            const path = self ? `M ${a.x - 50} ${a.y - 30} C ${a.x - 120} ${a.y - 145 - ordinal * 30}, ${a.x + 120} ${a.y - 145 - ordinal * 30}, ${a.x + 50} ${a.y - 30}` : `M ${a.x} ${a.y} Q ${cx} ${cy} ${endX} ${endY}`;
                            return <g key={`${item.eventId}-${index}`} role="button" tabIndex={0} aria-label={`${item.fromSessionId} → ${item.toSessionId}：${item.description}`} onClick={() => select('edge', item.eventId)} onKeyDown={event => { if (event.key === 'Enter') select('edge', item.eventId); }} className={selection?.id === item.eventId ? 'text-primary cursor-pointer' : 'text-foreground-muted cursor-pointer'}>
                                <path d={path} fill="none" stroke="transparent" strokeWidth={18} /><path d={path} fill="none" stroke="currentColor" strokeWidth={2} strokeDasharray={item.fromAnchor.status === 'confirmed' ? undefined : '5 4'} markerEnd="url(#collaboration-arrow)" />
                                <text x={self ? a.x : cx} y={self ? a.y - 100 - ordinal * 25 : cy} textAnchor="middle" fontSize={12} fill="currentColor" stroke="var(--background)" strokeWidth={4} paintOrder="stroke">{item.description.slice(0, 22)}{item.description.length > 22 ? '…' : ''}</text>
                            </g>;
                        })}
                        {visibleNodes.map(item => { const p = positions.get(item.sessionId)!; return <g key={item.sessionId} role="button" tabIndex={0} aria-label={`会话 ${item.sessionId}`} onClick={() => select('node', item.sessionId)} onKeyDown={event => { if (event.key === 'Enter') select('node', item.sessionId); }} className="cursor-pointer">
                            <rect x={p.x - 95} y={p.y - 30} width={190} height={60} rx={8} fill="var(--background)" stroke={selection?.id === item.sessionId ? 'var(--primary)' : 'var(--card-border)'} strokeWidth={2} />
                            <text x={p.x} y={p.y - 4} textAnchor="middle" fill="currentColor" fontSize={14}>{item.name.slice(0, 22)}</text><text x={p.x} y={p.y + 17} textAnchor="middle" fill="currentColor" fontSize={11}>{item.traceResolution === 'resolved' ? '已关联 Trace' : '执行详情未关联'}</text>
                        </g>; })}
                    </svg>
                </div>
                <aside className="rounded-md border border-card-border bg-card p-4 space-y-3 overflow-auto max-h-[640px]">
                    {!selection && <p className="text-sm text-foreground-muted">点击节点查看会话；点击连线或下方事件查看联系、上报内容和步骤依据。</p>}
                    {node && <><h2 className="font-semibold break-all">{node.name}</h2><p className="text-sm break-all">{node.sessionId}</p><p className="text-sm">{node.traceResolution === 'resolved' ? '已关联原始 Trace' : node.message || '执行详情尚未上报，关系已保留'}</p></>}
                    {edge && <><h2 className="font-semibold break-words">{edge.description}</h2><p className="text-sm break-all">{edge.fromSessionId} → {edge.toSessionId}</p><p className="text-sm">来源：{edge.sources.map(s => s === 'trace' ? '原 Trace 明确证据' : s === 'reported' ? '主动上报' : '自动采集').join('、')}</p><p>{labels[edge.fromAnchor.status] || edge.fromAnchor.status}</p><p className="text-sm text-foreground-muted">{edge.fromAnchor.message}</p>{edge.fromAnchor.orderIndex && <p>推定对应第 {edge.fromAnchor.orderIndex} 次调用</p>}<p className="text-xs break-all">事件：{edge.eventId}</p>{edge.observedAt && <p className="text-xs">发生时间：{edge.observedAt}</p>}{edge.receivedAt && <p className="text-xs">接收时间：{edge.receivedAt}</p>}{edge.content && <div><h3 className="text-sm font-medium">上报内容</h3><p className="whitespace-pre-wrap break-words text-sm">{edge.content}</p></div>}{edge.fromLocator != null && <pre className="text-xs whitespace-pre-wrap break-all">{JSON.stringify(edge.fromLocator, null, 2)}</pre>}{edge.fromAnchor.candidates?.length ? <pre className="text-xs whitespace-pre-wrap break-all">候选记录：{JSON.stringify(edge.fromAnchor.candidates, null, 2)}</pre> : null}</>}
                    {source?.traceSessionId && <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" asChild><Link href={`/trace?taskId=${encodeURIComponent(source.traceSessionId)}`}>打开原 Trace</Link></Button><Button size="sm" disabled={bodyBusy} onClick={() => void loadBody()}>{bodyBusy ? '加载中…' : edge?.fromAnchor.position ? '查看关联步骤原文' : '查看执行原文'}</Button></div>}
                    {bodyError && <p role="alert" className="text-destructive">{bodyError}</p>}{body !== undefined && <pre className="text-xs whitespace-pre-wrap break-all">{JSON.stringify(body, null, 2)}</pre>}
                </aside>
            </div>
            <section className="rounded-md border border-card-border bg-card p-4 space-y-2"><h2 className="font-semibold">关系事件</h2><p className="text-xs text-foreground-muted">保留每次联系；多条联系不会因双方相同而折叠。排列不代表执行顺序。</p>{edges.map((item, index) => <button key={`${item.eventId}-${index}`} className="block w-full rounded-md border border-card-border p-3 text-left hover:bg-muted" onClick={() => select('edge', item.eventId)}><span className="block text-sm break-all">{item.fromSessionId} → {item.toSessionId} · {item.description}</span><span className="text-xs text-foreground-muted">{labels[item.fromAnchor.status] || item.fromAnchor.status} · {item.sources.join(' + ')}</span></button>)}{!edges.length && <p className="text-foreground-muted">未发现有明确证据的调用关系。</p>}{graph.nextOffset !== null && <Button variant="outline" disabled={busy} onClick={() => void load(graph.nextOffset!)}>加载更多上报事件（已加载 {graph.events.length} / {graph.total}）</Button>}</section>
        </>}
    </main>;
}
