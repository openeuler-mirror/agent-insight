'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiFetch } from '@/lib/client/api';
import type { RawInteraction } from '@/lib/engine/observability/agent-trace';
import { harnessDiffLimitation } from '@/lib/ingest/deepseek-harness-otel/context-membership';
import { HarnessBodyDetails } from './HarnessContextPanel';

type Reference = NonNullable<RawInteraction['harnessRequests']>[number];
type Entry = { request: Reference; key: string };
type View = 'members' | 'diff' | 'events';
const identity = (entry: Entry) => JSON.stringify([entry.request.sourceSessionId, entry.request.eventSequence]);
const labels: Record<string, string> = { system: '系统提示词', 'tool-definition': '工具定义', user: '用户消息', assistant: '历史回复', tool: '工具结果', 'skill-injection': 'Skill 注入', 'runtime-context': '运行上下文', 'skill-catalog': 'Skill 目录' };

export function harnessEventFamily(type: string) {
  return type === 'compaction/prune' ? 'prune' : type.startsWith('compaction/') ? 'compaction' : type === 'model/selection' ? 'model' : 'other';
}

export function collectHarnessContextEvents(entries: Entry[], source: string) {
  const events = new Map<string, { event: NonNullable<Reference['contextEvents']>[number]; target: Entry }>();
  for (const entry of entries) {
    if (entry.request.sourceSessionId !== source) continue;
    for (const event of entry.request.contextEvents ?? []) {
      if (event.sourceSessionId !== source || !Number.isSafeInteger(event.eventSequence) || event.eventSequence < 0
        || event.eventSequence > entry.request.eventSequence) continue;
      const id = JSON.stringify([source, event.eventSequence, event.eventType]);
      const previous = events.get(id);
      if (!previous || entry.request.eventSequence < previous.target.request.eventSequence) events.set(id, { event, target: entry });
    }
  }
  return [...events.values()].sort((a, b) => a.event.eventSequence - b.event.eventSequence);
}

export function HarnessRequestInspector({ entries, selectedKey, onSelect, rootSessionId, zh }: {
  entries: Entry[]; selectedKey: string | null; onSelect: (key: string) => void; rootSessionId?: string | null; zh: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('members');
  const [focused, setFocused] = useState('');
  const [eventFilter, setEventFilter] = useState('all');
  const [body, setBody] = useState<{ identity: string; json: string; expiresAt: number } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const selected = entries.find(entry => entry.key === selectedKey) ?? entries.find(entry => entry.request.membership) ?? entries[0];
  const current = entries.find(entry => identity(entry) === focused) ?? selected;
  const currentIdentity = current ? identity(current) : '';
  useEffect(() => {
    pending.current?.abort(); setBody(null); setError(''); setLoading(false);
    return () => pending.current?.abort();
  }, [currentIdentity, open]);
  useEffect(() => {
    if (!body) return;
    const timer = setTimeout(() => { setBody(null); setError(zh ? '正文已到期，成员元数据仍可查看。' : 'Body expired; member metadata remains available.'); }, Math.max(0, body.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [body, zh]);
  if (!current) return null;
  const request = current.request;
  const membership = (request.membership as any)?.schemaVersion === 1 ? request.membership as any : undefined;
  const diff = request.membershipDiff as any;
  const previous = typeof diff?.previousEventSequence === 'number' ? entries.find(entry => entry.request.sourceSessionId === request.sourceSessionId
    && entry.request.eventSequence === diff.previousEventSequence) : undefined;
  const events = collectHarnessContextEvents(entries, request.sourceSessionId);
  const eventNames: Record<string, string> = { compaction: zh ? '压缩' : 'Compaction', prune: zh ? '裁剪' : 'Pruning', model: zh ? '模型选择 / 切换' : 'Model selection / switch', other: zh ? '其他' : 'Other' };
  const memberItems = Array.isArray(membership?.items) ? membership.items : null;
  const show = (nextView: View) => { setFocused(selected ? identity(selected) : ''); setView(nextView); setOpen(true); };
  const selectRequest = (entry: Entry, nextView: View = view) => { setFocused(identity(entry)); setView(nextView); onSelect(entry.key); };
  const loadBody = async () => {
    if (!rootSessionId || typeof membership?.bodyRef !== 'string') return;
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller; setLoading(true); setError('');
    try {
      const query = new URLSearchParams({ taskId: rootSessionId, view: 'context-body', sourceSessionId: request.sourceSessionId, contextRequestId: membership.bodyRef });
      const response = await apiFetch(`/api/observe/session?${query}`, { signal: controller.signal });
      const value = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) { setError(`${response.status} · ${value.error || (zh ? '正文不可用' : 'Body unavailable')}`); return; }
      const expiresAt = Date.parse(value.expiresAt);
      if (!Array.isArray(value.items) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        setError(zh ? '正文格式不兼容或已到期，不展示内容。' : 'Incompatible or expired body; content is not displayed.'); return;
      }
      setBody({ identity: currentIdentity, json: JSON.stringify(value.items), expiresAt });
    } catch { if (!controller.signal.aborted) setError(zh ? '正文读取失败；成员元数据和原 Trace 仍可使用。' : 'Body loading failed; member metadata and Trace remain available.'); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };
  const activeBody = body?.identity === currentIdentity && body.expiresAt > Date.now() ? body : null;
  return <section className="rounded-lg border border-card-border bg-card p-4" aria-label={zh ? '上下文分析入口' : 'Context inspector entry'}>
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-medium">{zh ? '请求上下文工作台' : 'Request context workspace'}</h3>
      <p className="text-xs text-foreground-secondary">{zh ? '直接查看成员列表、相邻差异和源事件，无需展开右侧请求标识。' : 'Open members, adjacent changes and source events directly.'}</p></div>
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => show('members')}>{zh ? '请求成员与正文' : 'Members and bodies'}</Button>
        <Button size="sm" variant="outline" onClick={() => show('diff')}>{zh ? '相邻请求对比' : 'Compare adjacent requests'}</Button>
        <Button size="sm" variant="outline" onClick={() => show('events')}>{zh ? '上下文事件定位' : 'Locate context events'}</Button></div></div>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[92vh] max-w-[1280px] overflow-auto">
      <DialogHeader><DialogTitle>{zh ? '请求上下文工作台' : 'Request context workspace'} · #{request.eventSequence}</DialogTitle>
        <DialogDescription className="break-all">{request.sourceSessionId} · {request.turn}/{request.step} · {zh ? '响应事件序号，不是模型调用次数' : 'Response event sequence, not model call count'}</DialogDescription></DialogHeader>
      <div className="flex flex-wrap items-center justify-between gap-3"><label className="text-sm">{zh ? '当前请求 ' : 'Request '}
        <select className="max-w-full rounded-md border border-border bg-background p-2" aria-label={zh ? '工作台当前请求' : 'Inspector request'} value={currentIdentity}
          onChange={event => { const entry = entries.find(entry => identity(entry) === event.target.value); if (entry) selectRequest(entry); }}>
          {entries.map(entry => <option key={identity(entry)} value={identity(entry)}>#{entry.request.eventSequence} · {entry.request.turn}/{entry.request.step} · {entry.request.sourceSessionId.slice(-8)}</option>)}
        </select></label><Button size="sm" variant="outline" onClick={() => { onSelect(current.key); setOpen(false); }}>{zh ? '定位对应 LLM' : 'Locate corresponding LLM'}</Button></div>
      <div className="flex flex-wrap gap-2" aria-label={zh ? '工作台视图' : 'Inspector view'}>{(['members', 'diff', 'events'] as const).map(tab => <Button key={tab} size="sm" variant={view === tab ? 'default' : 'outline'} aria-pressed={view === tab} onClick={() => setView(tab)}>
        {{ members: zh ? '分类与成员列表' : 'Categories and members', diff: zh ? '新增 / 移除 / 变化' : 'Added / removed / changed', events: zh ? '压缩 / 裁剪 / 模型' : 'Compaction / pruning / model' }[tab]}
      </Button>)}</div>
      {view === 'members' && <div className="min-w-0 space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{zh ? '请求成员' : 'Request members'} · {memberItems?.length ?? '—'}</h3>
        {typeof membership?.bodyRef === 'string' && rootSessionId ? <Button size="sm" variant="outline" disabled={loading} onClick={loadBody}>{loading ? (zh ? '正在加载正文…' : 'Loading…') : zh ? '加载已采集正文' : 'Load captured bodies'}</Button>
          : <p className="text-sm text-foreground-secondary">{zh ? '平台正文不可用' : 'Bodies unavailable'} · {membership?.bodyStorageStatus ?? 'not-uploaded'}</p>}</div>
        {error && <p role="alert" className="rounded-md border border-warning-border bg-warning-subtle p-3 text-sm">{error}</p>}
        <p className="text-xs text-foreground-secondary">{activeBody ? (zh ? '已加载授权正文；截断或省略状态仍保留。' : 'Authorized bodies loaded; truncation and omission remain explicit.') : zh ? '当前先展示成员元数据；正文需另行鉴权加载。未加载不代表未采集。' : 'Showing member metadata; bodies require a separate authorized load. Not loaded does not mean not captured.'}</p>
        {memberItems ? <HarnessBodyDetails key={currentIdentity} embedded bodiesLoaded={!!activeBody} json={activeBody?.json ?? JSON.stringify(memberItems)} zh={zh} />
          : <p className="p-4 text-sm text-foreground-secondary">{zh ? '请求成员未采集或历史不足，原 Trace 仍可查看。' : 'No captured membership; existing Trace remains available.'}</p>}
      </div>}
      {view === 'diff' && <div className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{previous ? `#${previous.request.eventSequence} → #${request.eventSequence}` : zh ? '前次请求不可确定' : 'Previous request unavailable'}</h3>
        {previous && <Button size="sm" variant="outline" onClick={() => selectRequest(previous, 'members')}>{zh ? '查看前次成员列表' : 'Inspect previous members'}</Button>}</div>
        <div className="grid grid-cols-3 gap-3" aria-label={zh ? '相邻成员差异汇总' : 'Adjacent member change summary'}>{(['added', 'removed', 'changed'] as const).map(kind => <div key={kind} className="rounded-md border border-border bg-background-secondary p-3"><p className="text-xs text-foreground-secondary">{{ added: zh ? '新增' : 'Added', removed: zh ? '移除' : 'Removed', changed: zh ? '变化' : 'Changed' }[kind]}</p><p className="text-2xl font-medium tabular-nums">{Array.isArray(diff?.[kind]) ? diff[kind].length : '?'}</p></div>)}</div>
        <p className="rounded-md border border-border bg-background-secondary p-3 text-sm">{harnessDiffLimitation(diff, zh)}</p>
        {(['added', 'removed', 'changed'] as const).map(kind => <section key={kind} className="rounded-md border border-border">
          <h4 className="border-b border-border bg-background-secondary p-3 font-medium">{{ added: zh ? '新增成员' : 'Added members', removed: zh ? '移除成员' : 'Removed members', changed: zh ? '变化成员' : 'Changed members' }[kind]} · {Array.isArray(diff?.[kind]) ? diff[kind].length : '?'}</h4>
          {Array.isArray(diff?.[kind]) && diff[kind].length > 0 ? <div className="max-h-60 overflow-auto"><table className="w-full text-left text-sm"><thead><tr className="text-xs text-foreground-secondary"><th className="p-2">{zh ? '分类 / 成员标识' : 'Category / member'}</th><th className="p-2">{zh ? '前次指纹' : 'Previous fingerprint'}</th><th className="p-2">{zh ? '当前指纹' : 'Current fingerprint'}</th></tr></thead><tbody>
            {diff[kind].map((item: any, index: number) => { const before = (previous?.request.membership as any)?.items?.find((member: any) => member.itemId === item.id); const after = memberItems?.find((member: any) => member.itemId === item.id);
              return <tr key={`${item.id}:${index}`} className="border-t border-border"><td className="max-w-96 break-all p-2">{zh ? labels[item.category] ?? item.category : item.category}<p className="font-mono text-xs">{item.id}</p></td><td className="p-2 font-mono text-xs">{before?.contentFingerprint?.slice(0, 16) ?? '—'}</td><td className="p-2 font-mono text-xs">{after?.contentFingerprint?.slice(0, 16) ?? '—'}</td></tr>; })}
          </tbody></table></div> : <p className="p-3 text-sm text-foreground-secondary">{Array.isArray(diff?.[kind]) ? (zh ? '无已知条目' : 'No known items') : zh ? '未知，无法精确计数' : 'Unknown; exact count unavailable'}</p>}
        </section>)}
        <p className="text-xs text-foreground-secondary">{zh ? '这里只比较成员与脱敏内容指纹，不自动生成逐行正文差异；移除前正文需到前次请求鉴权加载。' : 'Member identities and redacted fingerprints only, not line-by-line text. Load removed bodies from the prior request with authorization.'}</p>
        {request.dshContext && <details className="text-sm"><summary>{zh ? 'dsh-context 投影差异 独立口径' : 'dsh-context projected delta — separate basis'}</summary><pre className="max-h-60 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(request.dshContext.delta ?? { status: request.dshContext.status }, null, 2)}</pre></details>}
      </div>}
      {view === 'events' && <div className="space-y-4"><div className="flex flex-wrap gap-2">{['all', 'compaction', 'prune', 'model'].map(family => <Button key={family} size="sm" variant={eventFilter === family ? 'default' : 'outline'} aria-pressed={eventFilter === family} onClick={() => setEventFilter(family)}>
        {family === 'all' ? (zh ? '全部事件' : 'All events') : eventNames[family]} · {events.filter(row => family === 'all' || harnessEventFamily(row.event.eventType) === family).length}
      </Button>)}</div><p className="text-sm text-foreground-secondary">{zh ? '按同一源会话的原生事件序号排列；发生位置与受影响请求分别标注。仅展示已采集并关联到后续请求的事件。' : 'Ordered by native source event sequence; event position and affected request are separate. Only captured events linked to later requests are shown.'}</p>
        {events.filter(row => eventFilter === 'all' || harnessEventFamily(row.event.eventType) === eventFilter).map(({ event, target }) => <article key={`${event.eventSequence}:${event.eventType}`} className="ml-2 space-y-2 border-l-2 border-border py-2 pl-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-medium">{eventNames[harnessEventFamily(event.eventType)]} · {zh ? '源' : 'Source'} #{event.eventSequence}</h4><Button size="sm" variant="outline" onClick={() => selectRequest(target, 'members')}>{zh ? '查看受影响请求' : 'Inspect affected request'} #{target.request.eventSequence}</Button></div>
          <p className="font-mono text-xs text-foreground-secondary">{event.eventType} · {zh ? '原生 Harness 遥测' : 'Native Harness telemetry'}</p>
          <p className="text-sm">{event.body.model ? `${zh ? '模型' : 'Model'}: ${String(event.body.provider ?? '')} / ${String(event.body.model)}` : ''}{Array.isArray(event.body.shadowedSeqs) ? ` ${zh ? '覆盖源事件' : 'Affected source events'}: ${event.body.shadowedSeqs.join(', ')}` : ''}</p>
          <p className="text-xs text-foreground-secondary">{typeof event.body.shadowedTokenCount === 'number' ? `${zh ? '源记录Token值' : 'Source-record tokens'}: ${event.body.shadowedTokenCount}` : ''}</p>
          <details className="text-xs"><summary>{zh ? '展开原始事件字段' : 'Expand source fields'}</summary><pre className="max-h-60 overflow-auto whitespace-pre-wrap">{JSON.stringify(event.body, null, 2)}</pre></details>
        </article>)}
        {!events.some(row => eventFilter === 'all' || harnessEventFamily(row.event.eventType) === eventFilter) && <p className="p-4 text-sm">{zh ? '没有已采集的匹配事件，不推断未发生。' : 'No captured matching events; absence is not inferred.'}</p>}
        {request.dshContext && <details className="text-sm"><summary>{zh ? '当前请求的 dsh-context 投影事件 独立来源' : 'Current request dsh-context projected events — separate source'}</summary><pre className="max-h-60 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify({ events: request.dshContext.events, eventsLimited: request.dshContext.eventsLimited }, null, 2)}</pre></details>}
      </div>}
    </DialogContent></Dialog>
  </section>;
}
