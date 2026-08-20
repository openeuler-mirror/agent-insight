'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Bot, CheckCircle2, FileSearch, Loader2, Play, Send, Wrench } from 'lucide-react';

import { apiFetch } from '@/lib/client/api';
import type { OptimizationRecordView } from './OptimizationRecordsPanel';

interface ChatBlock { kind: string; id: string; text?: string; name?: string; status?: string; summary?: string }
interface ChatMessage { id?: string; role: string; content: string; blocks: ChatBlock[]; streaming?: boolean }

function parseBlocks(value: string | undefined): ChatBlock[] {
  try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

export function OptimizationConversation({
  user,
  workbenchSessionId,
  optSessionId,
  skillName,
  baseVersion,
  baselineFiles,
  issues,
  autoStart,
  backgroundRunning,
  latestRecord,
  retesting,
  onViewRecords,
  onRetest,
  onCreateRetest,
  onAutoStartConsumed,
  onSynced,
  onError,
}: {
  user: string;
  workbenchSessionId: string;
  optSessionId: string;
  skillName: string;
  baseVersion: number;
  baselineFiles: Record<string, string>;
  issues: Array<{ id: string; severity: string; summary: string; dimension: string; suggestedFix: string | null }>;
  autoStart: boolean;
  backgroundRunning: boolean;
  latestRecord?: OptimizationRecordView;
  retesting: boolean;
  onViewRecords: () => void;
  onRetest: (record: OptimizationRecordView) => void;
  onCreateRetest: (record: OptimizationRecordView) => void;
  onAutoStartConsumed: () => void;
  onSynced: (session: unknown) => void;
  onError: (message: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [feedback, setFeedback] = useState('');
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(backgroundRunning);
  const autoStartedRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void apiFetch(`/api/skill-workbench/sessions/${encodeURIComponent(workbenchSessionId)}/optimization?user=${encodeURIComponent(user)}`, {
      cache: 'no-store', signal: controller.signal,
    }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '加载优化会话失败');
      setMessages((data.optimization.messages || []).map((message: any) => ({ ...message, blocks: parseBlocks(message.blocks) })));
    }).catch((error) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      onError(error instanceof Error ? error.message : '加载优化会话失败');
    }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [onError, user, workbenchSessionId]);

  useEffect(() => {
    if (!backgroundRunning) return;
    setRunning(true);
    const poll = window.setInterval(() => {
      void apiFetch(
        `/api/skill-workbench/sessions/${encodeURIComponent(workbenchSessionId)}?user=${encodeURIComponent(user)}`,
        { cache: 'no-store' },
      ).then(async (response) => {
        const data = await response.json();
        if (!response.ok) return;
        const task = [...(data.session?.tasks || [])]
          .reverse()
          .find((item: { type: string; status: string; errorMessage?: string }) => item.type === 'optimization');
        if (!task || task.status === 'running' || task.status === 'pending') return;
        window.clearInterval(poll);
        const optimizationResponse = await apiFetch(
          `/api/skill-workbench/sessions/${encodeURIComponent(workbenchSessionId)}/optimization?user=${encodeURIComponent(user)}`,
          { cache: 'no-store' },
        );
        const optimizationData = await optimizationResponse.json();
        if (optimizationResponse.ok) {
          setMessages((optimizationData.optimization.messages || []).map((message: { id: string; role: string; content: string; blocks?: string }) => ({
            ...message,
            blocks: parseBlocks(message.blocks),
          })));
        }
        setRunning(false);
        if (task.status === 'failed' && task.errorMessage) onError(task.errorMessage);
        onSynced(data.session);
      }).catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(poll);
  }, [backgroundRunning, onError, onSynced, user, workbenchSessionId]);

  const patchAgent = useCallback((mutator: (message: ChatMessage) => void) => setMessages((current) => {
    const next = [...current];
    const last = { ...next.at(-1)!, blocks: [...(next.at(-1)?.blocks || [])] };
    mutator(last);
    next[next.length - 1] = last;
    return next;
  }), []);

  const runRequest = useCallback(async (requestText: string) => {
    if (running || (!requestText.trim() && issues.length === 0)) return;
    const normalizedRequest = requestText.trim() || `根据 ${issues.length} 个静态评估问题优化`;
    setFeedback('');
    setMessages((current) => [...current, { role: 'user', content: normalizedRequest, blocks: [] }, { role: 'agent', content: '', blocks: [], streaming: true }]);
    setRunning(true);
    const controller = new AbortController();
    try {
      const response = await apiFetch('/api/skill-opt/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({
          user, threadId: optSessionId, skillName, baseVersion,
          checkedIssues: issues.map((issue) => ({
            id: issue.id, severity: issue.severity, category: issue.dimension,
            summary: issue.summary, improvementSuggestion: issue.suggestedFix || undefined,
          })),
          userFeedback: normalizedRequest,
          baselineFiles,
          mock: false,
          runId: crypto.randomUUID(),
        }),
      });
      if (!response.ok || !response.body) throw new Error('优化 Agent 启动失败');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() || '';
        for (const chunk of chunks) {
          if (!chunk.startsWith('data: ')) continue;
          const data = JSON.parse(chunk.slice(6));
          const payload = data.payload || {};
          if (data.mode === 'text') patchAgent((message) => {
            const text = String(data.payload || '');
            message.content += text;
            const tail = message.blocks.at(-1);
            if (tail?.kind === 'text') tail.text = `${tail.text || ''}${text}`;
            else message.blocks.push({ kind: 'text', id: `text-${message.blocks.length}`, text });
          });
          else if (data.mode === 'thinking') patchAgent((message) => {
            const block = message.blocks.find((item) => item.kind === 'thinking' && item.id === payload.id);
            if (block) block.text = `${block.text || ''}${payload.delta || ''}`;
            else message.blocks.push({ kind: 'thinking', id: payload.id, text: payload.delta || '', status: payload.done ? 'done' : 'running' });
          });
          else if (data.mode === 'tool_call') patchAgent((message) => message.blocks.push({ kind: 'tool', id: payload.id, name: payload.name, status: payload.status || 'running' }));
          else if (data.mode === 'tool_result') patchAgent((message) => {
            const block = message.blocks.find((item) => item.kind === 'tool' && item.id === payload.id);
            if (block) Object.assign(block, { status: payload.status || 'ok', summary: payload.summary });
          });
          else if (data.mode === 'error') throw new Error(String(data.payload || '优化失败'));
        }
      }
      const sessionResponse = await apiFetch(
        `/api/skill-workbench/sessions/${encodeURIComponent(workbenchSessionId)}?user=${encodeURIComponent(user)}`,
        { cache: 'no-store' },
      );
      const sessionData = await sessionResponse.json();
      if (!sessionResponse.ok) throw new Error(sessionData.error || '加载优化结果失败');
      onSynced(sessionData.session);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) onError(error instanceof Error ? error.message : '优化失败');
    } finally {
      setRunning(false);
      patchAgent((message) => { message.streaming = false; });
    }
  }, [baseVersion, baselineFiles, issues, onError, onSynced, optSessionId, patchAgent, running, skillName, user, workbenchSessionId]);

  useEffect(() => {
    if (!autoStart) {
      autoStartedRef.current = false;
      return;
    }
    if (loading || running || issues.length === 0 || autoStartedRef.current) return;
    autoStartedRef.current = true;
    onAutoStartConsumed();
    void runRequest(`修复当前静态质量评估发现的 ${issues.length} 个问题，并在完成后自动复验`);
  }, [autoStart, issues.length, loading, onAutoStartConsumed, runRequest, running]);

  const run = (event: FormEvent) => {
    event.preventDefault();
    void runRequest(feedback);
  };

  if (loading) return <div className="m-auto flex items-center text-xs text-foreground-muted"><Loader2 className="mr-2 size-4 animate-spin" />加载优化会话</div>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-3">
        {messages.length === 0 && <div className="rounded-lg bg-background-secondary p-3 text-xs leading-5 text-foreground-secondary"><b className="text-foreground">优化依据已准备。</b><br />{issues.length ? `将使用当前静态评估的 ${issues.length} 个问题。` : '请输入明确的优化诉求。'}</div>}
        {messages.map((message, index) => <div key={message.id || index} className={message.role === 'user' ? 'ml-8 rounded-lg bg-primary p-3 text-xs text-primary-foreground' : 'rounded-lg border border-border bg-card p-3'}>
          {message.role === 'agent' && <div className="mb-2 flex items-center gap-1.5 text-[11px] text-foreground-muted"><Bot className="size-3.5" />优化 Agent</div>}
          {message.blocks.length ? message.blocks.map((block, blockIndex) => block.kind === 'tool'
            ? <div key={`${block.id}-${blockIndex}`} className="my-1 flex items-center gap-2 rounded bg-background-secondary px-2 py-1.5 text-[11px] text-foreground-secondary"><Wrench className="size-3.5" />{block.name}<span className="ml-auto text-foreground-muted">{block.summary || block.status}</span></div>
            : block.kind === 'thinking' ? <details key={`${block.id}-${blockIndex}`} className="my-1 text-[11px] text-foreground-muted"><summary>思考过程</summary><p className="whitespace-pre-wrap">{block.text}</p></details>
              : <p key={`${block.id}-${blockIndex}`} className="whitespace-pre-wrap text-xs leading-5 text-foreground-secondary">{block.text}</p>)
            : <p className="whitespace-pre-wrap text-xs leading-5">{message.content}</p>}
          {message.streaming && <Loader2 className="mt-2 size-3.5 animate-spin text-primary" />}
        </div>)}
      </div>
      {latestRecord && ['pending_retest', 'retest_passed', 'retest_failed', 'retest_cancelled'].includes(latestRecord.status) && (
        <div className="mb-2 rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-2 text-xs font-medium text-foreground">
            <CheckCircle2 className="size-4 text-success" />
            {latestRecord.candidateVersionLabel}
            <span className="ml-auto rounded bg-background-secondary px-1.5 py-0.5 text-[10px] text-foreground-muted">
              {latestRecord.status === 'pending_retest' ? '待复测' : latestRecord.status === 'retest_passed' ? '复测通过' : '需处理'}
            </span>
          </div>
          <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-[11px] leading-4 text-foreground-secondary">{latestRecord.summary}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={onViewRecords} className="inline-flex h-7 items-center gap-1 rounded border border-border px-2 text-[10px] text-foreground-secondary">
              <FileSearch className="size-3" />查看优化报告
            </button>
            {['pending_retest', 'retest_failed', 'retest_cancelled'].includes(latestRecord.status) && (
              <button
                type="button"
                disabled={retesting}
                onClick={() => latestRecord.hasRetestableSource ? onRetest(latestRecord) : onCreateRetest(latestRecord)}
                className="inline-flex h-7 items-center gap-1 rounded bg-primary px-2 text-[10px] font-medium text-primary-foreground disabled:opacity-50"
              >
                {retesting ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
                {latestRecord.hasRetestableSource ? '同配置复测' : '新建复测实验'}
              </button>
            )}
          </div>
        </div>
      )}
      <form onSubmit={run} className="rounded-lg border border-border bg-card p-2">
        <textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} rows={3} disabled={running} placeholder="补充优化诉求…" className="w-full resize-none bg-transparent px-1 text-xs leading-5 text-foreground outline-none placeholder:text-foreground-muted" />
        <div className="flex justify-end">{running
          ? <span className="inline-flex h-8 items-center gap-1.5 rounded border border-border px-2 text-[10px] text-foreground-muted"><Loader2 className="size-3.5 animate-spin" />后台执行中</span>
          : <button type="submit" disabled={!feedback.trim() && issues.length === 0} className="inline-flex size-8 items-center justify-center rounded bg-primary text-primary-foreground disabled:opacity-40"><Send className="size-3.5" /></button>}</div>
      </form>
    </div>
  );
}
