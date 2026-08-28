'use client';

import { FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Check, CheckCircle2, Circle, FileSearch, Loader2, Send, Upload, Wrench, X } from 'lucide-react';

import { apiFetch } from '@/lib/client/api';
import { getOptimizationTargetVersion, getOptimizationTransitionLabel } from '@/lib/skill-workbench/optimization-display';
import { ConversationProcessDisclosure, processState } from './ConversationProcessDisclosure';
import { GenerationHistory } from './GenerationConversation';
import type { OptimizationRecordView } from './OptimizationRecordsPanel';

interface OptimizationPlanItemView {
  id: string;
  route: string;
  status: string;
  severity: string;
  title: string;
  targetFile?: string;
  conflictNote?: string;
}

interface OptimizationPlanView {
  id: string;
  status: string;
  sourceCount?: number;
  operatorMeta?: { error?: string };
  items: OptimizationPlanItemView[];
}

interface ChatBlock {
  kind: string;
  id: string;
  text?: string;
  name?: string;
  status?: string;
  summary?: string;
  sourceCount?: number;
  items?: OptimizationPlanItemView[];
  recordId?: string;
  taskId?: string;
  runId?: string;
  automatic?: boolean;
}
interface ChatMessage { id?: string; role: string; content: string; blocks: ChatBlock[]; streaming?: boolean; createdAt?: string }

interface OptimizationTaskView {
  id?: string;
  status: string;
  progress?: { stage?: string; activeStep?: number; percent?: number };
  errorMessage?: string | null;
  resultId?: string | null;
  createdAt?: string;
}

function displayOptimizationError(message: string | null | undefined) {
  if (!message) return '';
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network error/i.test(message)) {
    return '模型服务连接失败，当前候选未生成，请稍后重新优化。';
  }
  return message;
}

function parseBlocks(value: string | undefined): ChatBlock[] {
  try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

const PROGRESS_STEPS = [
  ['分析优化依据', '汇总评估问题与实验结论'],
  ['生成候选版本', '修改候选边界与诊断顺序'],
  ['执行质量校验', '检查结构、描述与安全规则'],
  ['整理优化报告', '生成版本差异与发布说明'],
] as const;

function optimizationMeta(message: ChatMessage) {
  return message.blocks.find((block) => block.kind === 'optimization_meta');
}

function recordMessageIndexes(messages: ChatMessage[], records: OptimizationRecordView[]) {
  const result = new Map<number, OptimizationRecordView[]>();
  messages.forEach((message, index) => {
    if (message.role !== 'agent') return;
    const recordId = optimizationMeta(message)?.recordId;
    if (!recordId) return;
    const record = records.find((item) => item.id === recordId);
    if (!record) return;
    for (const [messageIndex, attached] of result) {
      const remaining = attached.filter((item) => item.id !== recordId);
      if (remaining.length) result.set(messageIndex, remaining);
      else result.delete(messageIndex);
    }
    result.set(index, [record]);
  });
  return result;
}

function optimizationRoundAssignments(messages: ChatMessage[]) {
  const runNumbers = new Map<string, number>();
  const result = new Map<number, number>();
  let pendingUserIndex: number | null = null;
  messages.forEach((message, index) => {
    const meta = optimizationMeta(message);
    const runKey = meta?.runId || (meta?.taskId ? `task:${meta.taskId}` : meta?.recordId ? `record:${meta.recordId}` : '');
    if (message.role === 'user') pendingUserIndex = index;
    if (!runKey) {
      if (message.role === 'agent') pendingUserIndex = null;
      return;
    }
    if (!runNumbers.has(runKey)) runNumbers.set(runKey, runNumbers.size + 1);
    const roundNumber = runNumbers.get(runKey) as number;
    result.set(index, roundNumber);
    if (message.role === 'agent' && pendingUserIndex !== null && !result.has(pendingUserIndex)) {
      result.set(pendingUserIndex, roundNumber);
    }
    if (message.role === 'agent') pendingUserIndex = null;
  });
  return result;
}

function taskMessageIndexes(messages: ChatMessage[]) {
  const result = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role !== 'agent') return;
    const taskId = optimizationMeta(message)?.taskId;
    if (taskId) result.set(taskId, index);
  });
  return result;
}

export function OptimizationConversation({
  user,
  workbenchSessionId,
  generatorSessionId,
  optSessionId,
  skillName,
  baseVersion,
  baselineFiles,
  issues,
  autoStart,
  useMergePlan,
  backgroundRunning,
  tasks,
  records,
  publishing,
  quickActions,
  onViewRecords,
  onPublish,
  onRepair,
  onAutoStartConsumed,
  onSynced,
  onError,
}: {
  user: string;
  workbenchSessionId: string;
  generatorSessionId?: string | null;
  optSessionId: string;
  skillName: string;
  baseVersion: number;
  baselineFiles: Record<string, string>;
  issues: Array<{ id: string; severity: string; summary: string; dimension: string; evidence?: string | null; reasoning?: string | null; suggestedFix: string | null }>;
  autoStart: boolean;
  useMergePlan: boolean;
  backgroundRunning: boolean;
  tasks: OptimizationTaskView[];
  records: OptimizationRecordView[];
  publishing: boolean;
  quickActions?: ReactNode;
  onViewRecords: (record: OptimizationRecordView) => void;
  onPublish: (record: OptimizationRecordView) => void;
  onRepair: (record: OptimizationRecordView) => void;
  onAutoStartConsumed: () => void;
  onSynced: (session: unknown) => void;
  onError: (message: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [feedback, setFeedback] = useState('');
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(backgroundRunning);
  const [planning, setPlanning] = useState(false);
  const [localStep, setLocalStep] = useState(backgroundRunning ? 1 : 0);
  const busy = planning || running || backgroundRunning;
  const autoStartedRef = useRef(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const activeTask = [...tasks].reverse().find((item) => ['pending', 'running'].includes(item.status));

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: busy ? 'auto' : 'smooth' });
  }, [busy, messages, records]);

  useEffect(() => {
    const controller = new AbortController();
    void apiFetch(`/api/skill-workbench/sessions/${encodeURIComponent(workbenchSessionId)}/optimization?user=${encodeURIComponent(user)}`, {
      cache: 'no-store', signal: controller.signal,
    }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '加载优化会话失败');
      setMessages((data.optimization.messages || []).map((message: { id?: string; role: string; content: string; blocks?: string }) => ({ ...message, blocks: parseBlocks(message.blocks) })));
    }).catch((error) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      onError(error instanceof Error ? error.message : '加载优化会话失败');
    }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [onError, user, workbenchSessionId]);

  useEffect(() => {
    if (!backgroundRunning) return;
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

  const prepareMergePlan = useCallback(async (): Promise<OptimizationPlanView | null> => {
    setPlanning(true);
    try {
      const response = await apiFetch('/api/skill-opt/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, skillName, baseVersion, sessionId: optSessionId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '归并优化依据失败');
      let plan = data.plan as OptimizationPlanView | null;
      for (let attempt = 0; plan?.status === 'running' && attempt < 180; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 2_000));
        const pollResponse = await apiFetch(
          `/api/skill-opt/plan?sessionId=${encodeURIComponent(optSessionId)}&user=${encodeURIComponent(user)}`,
          { cache: 'no-store' },
        );
        const pollData = await pollResponse.json();
        if (!pollResponse.ok) throw new Error(pollData.error || '读取优化计划失败');
        plan = pollData.plan as OptimizationPlanView | null;
      }
      if (plan?.status === 'running') throw new Error('归并优化依据超时，请稍后重试');
      if (plan?.status === 'failed') throw new Error(plan.operatorMeta?.error || '归并优化依据失败');
      if (!plan) return null;
      const executable = plan.items.some((item) => (
        (item.route === 'core' || item.route === 'reference') && item.status === 'pending'
      ));
      if (!executable) throw new Error('归并后没有可自动执行的优化点；冲突项需先处理，待办项不会自动写入当前版本');
      return plan;
    } finally {
      setPlanning(false);
    }
  }, [baseVersion, optSessionId, skillName, user]);

  const runRequest = useCallback(async (requestText: string, options?: { mergeIssues?: boolean }) => {
    if (busy || (!requestText.trim() && issues.length === 0)) return;
    const normalizedRequest = requestText.trim() || `根据 ${issues.length} 个静态评估问题优化`;
    const runId = crypto.randomUUID();
    const runMeta: ChatBlock = { kind: 'optimization_meta', id: `optimization-${runId}`, runId };
    setLocalStep(1);
    setFeedback('');
    setMessages((current) => [
      ...current,
      { role: 'user', content: normalizedRequest, blocks: [{ ...runMeta }] },
      { role: 'agent', content: '', blocks: [{ ...runMeta }], streaming: true },
    ]);
    const controller = new AbortController();
    try {
      const plan = options?.mergeIssues ? await prepareMergePlan() : null;
      setRunning(true);
      const response = await apiFetch('/api/skill-opt/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({
          user, threadId: optSessionId, skillName, baseVersion,
          checkedIssues: issues.map((issue) => ({
            id: issue.id, severity: issue.severity, category: issue.dimension,
            summary: issue.summary, evidence: issue.evidence || issue.reasoning || undefined,
            improvementSuggestion: issue.suggestedFix || undefined,
          })),
          userFeedback: normalizedRequest,
          baselineFiles,
          ...(plan ? { planId: plan.id } : {}),
          mock: false,
          runId,
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
            if (block) {
              block.text = `${block.text || ''}${payload.delta || ''}`;
              if (payload.done) block.status = 'done';
            }
            else message.blocks.push({ kind: 'thinking', id: payload.id, text: payload.delta || '', status: payload.done ? 'done' : 'running' });
          });
          else if (data.mode === 'tool_call') {
            setLocalStep((current) => Math.max(current, 2));
            patchAgent((message) => {
              const block = message.blocks.find((item) => item.kind === 'tool' && item.id === payload.id);
              if (!block) {
                message.blocks.push({ kind: 'tool', id: payload.id, name: payload.name, status: payload.status || 'running' });
                return;
              }
              block.name ||= payload.name;
              if (!['ok', 'error'].includes(block.status || '')) block.status = payload.status || 'running';
            });
          }
          else if (data.mode === 'tool_result') patchAgent((message) => {
            const block = message.blocks.find((item) => item.kind === 'tool' && item.id === payload.id);
            if (block) Object.assign(block, { status: payload.status || 'ok', summary: payload.summary });
            else message.blocks.push({ kind: 'tool', id: payload.id, name: payload.name || 'tool', status: payload.status || 'ok', summary: payload.summary });
          });
          else if (data.mode === 'optimization_plan') patchAgent((message) => {
            const block = message.blocks.find((item) => item.kind === 'optimization_plan' && item.id === payload.id);
            const next = {
              kind: 'optimization_plan', id: payload.id, sourceCount: Number(payload.sourceCount) || 0,
              items: Array.isArray(payload.items) ? payload.items : [],
            };
            if (block) Object.assign(block, next);
            else message.blocks.push(next);
          });
          else if (data.mode === 'optimization_meta') patchAgent((message) => {
            const id = `optimization-${payload.runId || payload.recordId || payload.taskId || runId}`;
            const block = message.blocks.find((item) => item.kind === 'optimization_meta' && item.id === id);
            const next = { kind: 'optimization_meta', id, runId: payload.runId || runId, recordId: payload.recordId, taskId: payload.taskId };
            if (block) Object.assign(block, next);
            else message.blocks.push(next);
          });
          else if (data.mode === 'verify_progress') {
            setLocalStep((current) => Math.max(current, 3));
            patchAgent((message) => {
              const block = message.blocks.find((item) => item.kind === 'verification' && item.id === 'self-verify');
              const next = { kind: 'verification', id: 'self-verify', status: 'running', text: String(payload.message || '') };
              if (block) Object.assign(block, next);
              else message.blocks.push(next);
            });
          }
          else if (data.mode === 'verify_ok') {
            setLocalStep((current) => Math.max(current, 4));
            patchAgent((message) => {
              const block = message.blocks.find((item) => item.kind === 'verification' && item.id === 'self-verify');
              const next = { kind: 'verification', id: 'self-verify', status: 'ok', text: '结构门、脚本真值门与行为门已完成' };
              if (block) Object.assign(block, next);
              else message.blocks.push(next);
            });
          }
          else if (data.mode === 'warning') patchAgent((message) => message.blocks.push({
            kind: 'warning', id: `warning-${message.blocks.length}`, text: String(payload.message || data.payload || ''),
          }));
          else if (data.mode === 'error') throw new Error(String(data.payload || '优化失败'));
        }
      }
      const [sessionResponse, optimizationResponse] = await Promise.all([
        apiFetch(
          `/api/skill-workbench/sessions/${encodeURIComponent(workbenchSessionId)}?user=${encodeURIComponent(user)}`,
          { cache: 'no-store' },
        ),
        apiFetch(
          `/api/skill-workbench/sessions/${encodeURIComponent(workbenchSessionId)}/optimization?user=${encodeURIComponent(user)}`,
          { cache: 'no-store' },
        ),
      ]);
      const sessionData = await sessionResponse.json();
      const optimizationData = await optimizationResponse.json();
      if (!sessionResponse.ok) throw new Error(sessionData.error || '加载优化结果失败');
      if (!optimizationResponse.ok) throw new Error(optimizationData.error || '校准优化会话失败');
      setMessages((optimizationData.optimization.messages || []).map((message: { id: string; role: string; content: string; blocks?: string }) => ({
        ...message,
        blocks: parseBlocks(message.blocks),
      })));
      setLocalStep(4);
      onSynced(sessionData.session);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        const message = error instanceof Error ? error.message : '优化失败';
        patchAgent((agent) => {
          agent.content ||= message;
          agent.blocks.push({ kind: 'warning', id: `error-${runId}`, text: displayOptimizationError(message) });
        });
        onError(message);
      }
    } finally {
      setRunning(false);
      patchAgent((message) => { message.streaming = false; });
    }
  }, [baseVersion, baselineFiles, busy, issues, onError, onSynced, optSessionId, patchAgent, prepareMergePlan, skillName, user, workbenchSessionId]);

  useEffect(() => {
    if (!autoStart) {
      autoStartedRef.current = false;
      return;
    }
    if (loading || busy || autoStartedRef.current) return;
    autoStartedRef.current = true;
    onAutoStartConsumed();
    void runRequest('根据这些问题优化 Skill', { mergeIssues: useMergePlan });
  }, [autoStart, busy, issues.length, loading, onAutoStartConsumed, runRequest, useMergePlan]);

  const run = (event: FormEvent) => {
    event.preventDefault();
    void runRequest(feedback);
  };

  const recordsAtMessage = useMemo(() => recordMessageIndexes(messages, records), [messages, records]);
  const roundAssignments = useMemo(() => optimizationRoundAssignments(messages), [messages]);
  const taskOwners = useMemo(() => taskMessageIndexes(messages), [messages]);
  const attachedRecordIds = useMemo(() => new Set(
    [...recordsAtMessage.values()].flat().map((record) => record.id),
  ), [recordsAtMessage]);
  const liveMessageIndex = messages.findLastIndex((message) => message.role === 'agent' && message.streaming);
  const taskHasAgentMessage = Boolean(activeTask?.id && messages.some((message) => (
    message.role === 'agent' && optimizationMeta(message)?.taskId === activeTask.id
  )));
  const showDetachedProgress = busy && liveMessageIndex < 0 && !taskHasAgentMessage;

  if (loading) return <div className="m-auto flex items-center text-xs text-foreground-muted"><Loader2 className="mr-2 size-4 animate-spin" />加载优化会话</div>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden pb-3" style={{ scrollbarGutter: 'stable' }}>
        {generatorSessionId && (
          <GenerationHistory
            user={user}
            workbenchSessionId={workbenchSessionId}
            generatorSessionId={generatorSessionId}
            onError={onError}
          />
        )}
        {messages.length === 0 && !autoStart && <div className="rounded-lg bg-background-secondary p-3 text-xs leading-5 text-foreground-secondary"><b className="text-foreground">优化依据已准备。</b><br />{issues.length ? `将使用当前静态评估的 ${issues.length} 个问题。` : '可以补充明确的优化诉求。'}</div>}
        {messages.map((message, index) => {
          const meta = optimizationMeta(message);
          const messageRecords = recordsAtMessage.get(index) || [];
          const messageTask = meta?.taskId
            ? tasks.find((item) => item.id === meta.taskId)
            : messageRecords.length
              ? tasks.find((item) => messageRecords.some((record) => item.resultId === record.id))
              : index === liveMessageIndex ? activeTask : undefined;
          const showLiveProgress = index === liveMessageIndex && busy;
          const showStoredProgress = message.role === 'agent'
            && Boolean(messageTask)
            && !showLiveProgress
            && (!messageTask?.id || taskOwners.get(messageTask.id) === index);
          const visibleBlocks = message.blocks.filter((block) => block.kind !== 'optimization_meta');
          const roundNumber = roundAssignments.get(index);
          const transition = messageRecords[0]
            ? getOptimizationTransitionLabel(messageRecords[0])
            : `v${baseVersion} → v${baseVersion + 1}`;
          return <div key={message.id || index} className={message.role === 'user' ? 'ml-8 min-w-0 max-w-full overflow-hidden rounded-lg bg-primary p-3 text-xs text-primary-foreground' : 'min-w-0 max-w-full overflow-hidden rounded-lg border border-border bg-card p-3'}>
            {message.role === 'agent' && <div className="mb-2 flex items-center gap-1.5 text-[11px] text-foreground-muted"><Bot className="size-3.5" />Skill Copilot{roundNumber && <span>· 第 {roundNumber} 轮 · {transition}</span>}</div>}
            {message.role === 'user' && roundNumber && <div className="mb-1 text-[10px] text-primary-foreground/75">{meta?.automatic ? `第 ${roundNumber} 轮 · 自动修复` : `第 ${roundNumber} 轮`}</div>}
            {visibleBlocks.length ? visibleBlocks.map((block, blockIndex) => block.kind === 'tool'
              ? <ConversationProcessDisclosure key={`${block.id}-${blockIndex}`} kind="tool" state={processState(block.status)} name={block.name}>
                <pre className="m-0 max-h-72 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-4 [overflow-wrap:anywhere]">{block.summary || block.status}</pre>
              </ConversationProcessDisclosure>
              : block.kind === 'thinking' ? <ConversationProcessDisclosure key={`${block.id}-${blockIndex}`} kind="thinking" state={processState(block.status)}>
                <p className="whitespace-pre-wrap break-words leading-5 [overflow-wrap:anywhere]">{block.text}</p>
              </ConversationProcessDisclosure>
                : block.kind === 'optimization_plan' ? <OptimizationPlanCard key={`${block.id}-${blockIndex}`} block={block} />
                  : block.kind === 'verification' ? <div key={`${block.id}-${blockIndex}`} className="my-1 flex min-w-0 items-start gap-2 overflow-hidden rounded border border-success-border bg-success-subtle px-2 py-1.5 text-[11px] text-success">{block.status === 'running' ? <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" /> : <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />}<span className="min-w-0 break-words [overflow-wrap:anywhere]">{block.text}</span></div>
                    : block.kind === 'warning' ? <div key={`${block.id}-${blockIndex}`} className="my-1 min-w-0 overflow-hidden whitespace-pre-wrap break-words rounded border border-warning-border bg-warning-subtle px-2 py-1.5 text-[11px] text-warning [overflow-wrap:anywhere]">{block.text}</div>
                      : <p key={`${block.id}-${blockIndex}`} className="max-w-full whitespace-pre-wrap break-words text-xs leading-5 text-foreground-secondary [overflow-wrap:anywhere]">{block.text}</p>)
              : <p className="max-w-full whitespace-pre-wrap break-words text-xs leading-5 [overflow-wrap:anywhere]">{message.content}</p>}
            {(showLiveProgress || showStoredProgress) && <OptimizationProgressCard
              task={messageTask}
              record={messageRecords[0]}
              localStep={showLiveProgress ? localStep : messageTask?.status === 'failed' ? Number(messageTask.progress?.activeStep || 1) : 5}
              planning={showLiveProgress && planning}
              showError={!messageRecords.some((record) => record.errorMessage === messageTask?.errorMessage)}
            />}
            {messageRecords.map((record) => <OptimizationResultCard
              key={record.id}
              record={record}
              busy={busy}
              publishing={publishing}
              onViewRecords={onViewRecords}
              onPublish={onPublish}
              onRepair={onRepair}
            />)}
            {message.streaming && !showLiveProgress && <Loader2 className="mt-2 size-3.5 animate-spin text-primary" />}
          </div>;
        })}
        {showDetachedProgress && <div className="min-w-0 max-w-full overflow-hidden rounded-lg border border-border bg-card p-3"><div className="mb-2 flex items-center gap-1.5 text-[11px] text-foreground-muted"><Bot className="size-3.5" />Skill Copilot · 正在恢复后台执行</div><OptimizationProgressCard task={activeTask} localStep={localStep} planning={planning} /></div>}
        {records.filter((record) => !attachedRecordIds.has(record.id)).map((record) => {
          return <div key={record.id} className="min-w-0 max-w-full overflow-hidden rounded-lg border border-border bg-card p-3">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] text-foreground-muted"><Bot className="size-3.5" />未关联的历史优化记录 · {getOptimizationTransitionLabel(record)}</div>
            <OptimizationResultCard record={record} busy={busy} publishing={publishing} onViewRecords={onViewRecords} onPublish={onPublish} onRepair={onRepair} />
          </div>;
        })}
        <div ref={endRef} />
      </div>
      {quickActions}
      <form onSubmit={run} className="rounded-lg border border-border bg-card p-2">
        <textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} rows={3} disabled={busy} placeholder="补充优化诉求…" className="w-full resize-none bg-transparent px-1 text-xs leading-5 text-foreground outline-none placeholder:text-foreground-muted" />
        <div className="flex justify-end">{busy
          ? <span className="inline-flex h-8 items-center gap-1.5 rounded border border-border px-2 text-[10px] text-foreground-muted"><Loader2 className="size-3.5 animate-spin" />后台执行中</span>
          : <button type="submit" disabled={!feedback.trim() && issues.length === 0} className="inline-flex size-8 items-center justify-center rounded bg-primary text-primary-foreground disabled:opacity-40"><Send className="size-3.5" /></button>}</div>
      </form>
    </div>
  );
}

function OptimizationProgressCard({ task, record, localStep, planning, showError = true }: { task?: OptimizationTaskView; record?: OptimizationRecordView; localStep: number; planning: boolean; showError?: boolean }) {
  const taskStep = Number(task?.progress?.activeStep || 0);
  const activeStep = task?.status === 'done' ? 5 : Math.max(taskStep, localStep);
  const qualityFailed = record?.status === 'optimization_failed' && Boolean(record.blockingIssues?.length);
  return <div className="mt-3 min-w-0 max-w-full overflow-hidden rounded-md border border-border">
    <p className="px-3 py-2 text-xs leading-5 text-foreground-secondary">{planning ? '正在归并、去重并排序优化依据，完成后会自动开始修改。' : '我会基于评估与实验结果生成候选版本，当前版本不会被覆盖。'}</p>
    <div className="divide-y divide-border border-t border-border">
      {PROGRESS_STEPS.map(([label, description], index) => {
        const step = index + 1;
        const qualityBlocked = qualityFailed && step === 3;
        const failed = !qualityBlocked && task?.status === 'failed' && step === Math.max(1, activeStep);
        const complete = qualityFailed ? step !== 3 : task?.status === 'done' || activeStep > step;
        const current = !complete && activeStep === step && !failed && !qualityBlocked;
        return <div key={label} className="flex min-w-0 items-center gap-2 px-3 py-2">
          <span className={complete ? 'flex size-4 shrink-0 items-center justify-center rounded-full bg-success text-white' : failed || qualityBlocked ? 'flex size-4 shrink-0 items-center justify-center rounded-full bg-error text-white' : current ? 'flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground' : 'shrink-0 text-foreground-muted'}>
            {complete ? <Check className="size-3" /> : failed || qualityBlocked ? <X className="size-3" /> : current ? <Loader2 className="size-3 animate-spin" /> : <Circle className="size-4" />}
          </span>
          <span className="min-w-0 flex-1"><b className="block break-words text-[11px] text-foreground [overflow-wrap:anywhere]">{label}</b><span className="block break-words text-[10px] text-foreground-muted [overflow-wrap:anywhere]">{description}</span></span>
          <span className={complete ? 'shrink-0 text-[10px] text-success' : failed || qualityBlocked ? 'shrink-0 text-[10px] text-error' : 'shrink-0 text-[10px] text-foreground-muted'}>{complete ? '已完成' : qualityBlocked ? '未通过' : failed ? '失败' : current ? '执行中' : '等待中'}</span>
        </div>;
      })}
    </div>
    {showError && task?.status === 'failed' && task.errorMessage && <p className="break-words border-t border-border px-3 py-2 text-[11px] text-error [overflow-wrap:anywhere]">{displayOptimizationError(task.errorMessage)}</p>}
  </div>;
}

function OptimizationResultCard({ record, busy, publishing, onViewRecords, onPublish, onRepair }: {
  record: OptimizationRecordView;
  busy: boolean;
  publishing: boolean;
  onViewRecords: (record: OptimizationRecordView) => void;
  onPublish: (record: OptimizationRecordView) => void;
  onRepair: (record: OptimizationRecordView) => void;
}) {
  const qualityPassed = ['pending_retest', 'retesting', 'retest_passed', 'retest_failed', 'retest_cancelled'].includes(record.status);
  const executionFailed = record.status === 'optimization_failed' && !record.blockingIssues?.length && Boolean(record.errorMessage);
  const hasCandidate = Boolean(record.staticEvaluationId && Object.keys(record.candidateFiles || {}).length);
  const status = record.status === 'optimizing' ? '优化中'
    : qualityPassed ? '质量规则已通过'
      : executionFailed ? '优化执行失败'
        : record.status === 'optimization_failed' ? '质量校验未通过'
        : record.status === 'published' ? '已发布'
          : record.status === 'abandoned' ? '已放弃' : '需处理';
  return <div className="mt-3 min-w-0 max-w-full overflow-hidden rounded-md border border-border bg-background p-3">
    <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-foreground">
      {record.status === 'optimization_failed' ? <X className="size-4 shrink-0 text-error" /> : record.status === 'optimizing' ? <Loader2 className="size-4 shrink-0 animate-spin text-primary" /> : <CheckCircle2 className="size-4 shrink-0 text-success" />}
      <span className="min-w-0 truncate">{executionFailed && !hasCandidate ? '本轮优化失败' : getOptimizationTransitionLabel(record)}</span>
      <span className="ml-auto shrink-0 rounded bg-background-secondary px-1.5 py-0.5 text-[10px] text-foreground-muted">{status}</span>
    </div>
    <p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-[11px] leading-4 text-foreground-secondary [overflow-wrap:anywhere]">{executionFailed && !hasCandidate ? `尚未生成 ${getOptimizationTargetVersion(record)} 候选。${displayOptimizationError(record.errorMessage)}` : record.summary}</p>
    <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-foreground-secondary">
      {hasCandidate && <span className="rounded bg-background-secondary px-1.5 py-1">候选版本 {getOptimizationTargetVersion(record)}</span>}
      {hasCandidate && <span className="rounded bg-background-secondary px-1.5 py-1">修改 {record.diff?.length || 0} 项</span>}
      {!hasCandidate && executionFailed
        ? <span className="rounded bg-error-subtle px-1.5 py-1 text-error">未生成候选</span>
        : record.status === 'optimization_failed'
        ? <span className="rounded bg-error-subtle px-1.5 py-1 text-error">{executionFailed ? '优化执行失败' : '质量校验未通过'}</span>
        : record.status === 'optimizing'
          ? <span className="rounded bg-primary-subtle px-1.5 py-1 text-primary">质量校验中</span>
          : <span className="rounded bg-success-subtle px-1.5 py-1 text-success">质量规则已通过</span>}
    </div>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" onClick={() => onViewRecords(record)} className="inline-flex h-7 items-center gap-1 rounded border border-border px-2 text-[10px] text-foreground-secondary"><FileSearch className="size-3" />{executionFailed && !hasCandidate ? '查看失败详情' : '查看优化报告'}</button>
      {qualityPassed && <button type="button" disabled={publishing} onClick={() => onPublish(record)} className="inline-flex h-7 items-center gap-1 rounded bg-primary px-2 text-[10px] font-medium text-primary-foreground disabled:opacity-50">{publishing ? <Loader2 className="size-3 animate-spin" /> : <Upload className="size-3" />}发布为 {getOptimizationTargetVersion(record)}</button>}
      {record.status === 'optimization_failed' && <button type="button" disabled={busy} onClick={() => onRepair(record)} className="inline-flex h-7 items-center gap-1 rounded bg-primary px-2 text-[10px] font-medium text-primary-foreground disabled:opacity-50"><Wrench className="size-3" />{executionFailed ? '重新优化' : '修复阻断问题'}</button>}
    </div>
    {record.errorMessage && !(executionFailed && !hasCandidate) && <p className="mt-2 break-words text-[11px] text-error [overflow-wrap:anywhere]">{displayOptimizationError(record.errorMessage)}</p>}
    {record.status === 'optimization_failed' && Boolean(record.blockingIssues?.length) && <ul className="mt-2 space-y-1 text-[10px] leading-4 text-error">{record.blockingIssues!.map((issue) => <li key={issue.id} className="break-words [overflow-wrap:anywhere]">• {issue.summary}</li>)}</ul>}
  </div>;
}

function OptimizationPlanCard({ block }: { block: ChatBlock }) {
  const items = block.items || [];
  const executable = items.filter((item) => (item.route === 'core' || item.route === 'reference') && item.status === 'pending');
  const conflicts = items.filter((item) => item.status === 'conflict');
  const backlog = items.filter((item) => item.route === 'backlog');
  return (
    <div className="my-2 min-w-0 max-w-full overflow-hidden rounded-md border border-border bg-background-secondary p-2.5 text-[11px] text-foreground-secondary">
      <div className="flex min-w-0 items-center gap-2">
        <CheckCircle2 className="size-3.5 text-primary" />
        <b className="text-foreground">优化依据已归并</b>
        <span className="ml-auto shrink-0 text-foreground-muted">{block.sourceCount || 0} 个问题 → {items.length} 个优化点</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
        <span className="rounded bg-primary-subtle px-1.5 py-0.5 text-primary">本轮执行 {executable.length}</span>
        {conflicts.length > 0 && <span className="rounded bg-warning-subtle px-1.5 py-0.5 text-warning">冲突待裁决 {conflicts.length}</span>}
        {backlog.length > 0 && <span className="rounded bg-background px-1.5 py-0.5 text-foreground-muted">待办 {backlog.length}</span>}
      </div>
      {executable.length > 0 && (
        <ul className="mt-2 space-y-1">
          {executable.slice(0, 5).map((item) => <li key={item.id} className="break-words [overflow-wrap:anywhere]">• {item.title}{item.targetFile ? ` · ${item.targetFile}` : ''}</li>)}
          {executable.length > 5 && <li className="text-foreground-muted">其余 {executable.length - 5} 个优化点将在本轮一并执行</li>}
        </ul>
      )}
    </div>
  );
}
