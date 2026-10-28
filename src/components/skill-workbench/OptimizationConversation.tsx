/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use client';

import { FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Check, CheckCircle2, Circle, FileSearch, Loader2, Send, Upload, Wrench, X } from 'lucide-react';

import { apiFetch } from '@/lib/client/api';
import { hasOptimizationInput } from '@/lib/skill-workbench/optimization-request';
import { safeUUID } from '@/lib/safe-uuid';
import { settleProcessBlocks, type ProcessOutcome } from '@/lib/chat/process-block-state';
import { getOptimizationTargetVersion, getOptimizationTransitionLabel } from '@/lib/skill-workbench/optimization-display';
import {
  optimizationRecordsSyncKey,
  publishWorkbenchSync,
  subscribeWorkbenchSync,
} from '@/lib/skill-workbench/sync-channel';
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
  done?: boolean;
  summary?: string;
  error?: string;
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
  progress?: { stage?: string; activeStep?: number; percent?: number; cancelRequested?: boolean };
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

function parseBlocks(value: string | ChatBlock[] | undefined): ChatBlock[] {
  if (Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function hydrateOptimizationMessages(
  values: Array<{ id?: string; role: string; content: string; blocks?: string | ChatBlock[]; createdAt?: string }>,
  outcome?: ProcessOutcome,
) {
  const messages: ChatMessage[] = values.map((message) => ({
    ...message,
    blocks: outcome
      ? settleProcessBlocks(parseBlocks(message.blocks), outcome)
      : parseBlocks(message.blocks),
  }));
  if (!outcome) {
    const activeIndex = messages.findLastIndex((message) => message.role === 'agent');
    if (activeIndex >= 0) messages[activeIndex] = { ...messages[activeIndex], streaming: true };
  }
  return messages;
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
  autoStartFeedback = '',
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
  autoStartFeedback?: string;
  useMergePlan: boolean;
  backgroundRunning: boolean;
  tasks: OptimizationTaskView[];
  records: OptimizationRecordView[];
  publishing: boolean;
  quickActions?: ReactNode | ((feedback: string, busy: boolean) => ReactNode);
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
  const [liveTasks, setLiveTasks] = useState(tasks);
  const [stopping, setStopping] = useState(false);
  const stopRequestedRef = useRef(false);
  const planningControllerRef = useRef<AbortController | null>(null);
  const runTaskIdRef = useRef<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [localStep, setLocalStep] = useState(backgroundRunning ? 1 : 0);
  const busy = planning || running || backgroundRunning;
  const autoStartedRef = useRef(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const ownsStreamRef = useRef(false);
  const snapshotRequestRef = useRef(0);
  const backgroundRunningRef = useRef(backgroundRunning);
  const observedTaskRef = useRef<{ id?: string; status: string } | null>(null);
  const observedRecordsRef = useRef(optimizationRecordsSyncKey(records));
  const activeTask = [...liveTasks].reverse().find((item) => ['pending', 'running'].includes(item.status));

  useEffect(() => setLiveTasks(tasks), [tasks]);
  useEffect(() => { backgroundRunningRef.current = backgroundRunning; }, [backgroundRunning]);
  useEffect(() => { observedRecordsRef.current = optimizationRecordsSyncKey(records); }, [records]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: busy ? 'auto' : 'smooth' });
  }, [busy, messages, records]);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++snapshotRequestRef.current;
    setLoading(true);
    void apiFetch(`/api/skill-workbench/sessions/${encodeURIComponent(workbenchSessionId)}/optimization?user=${encodeURIComponent(user)}`, {
      cache: 'no-store', signal: controller.signal,
    }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '加载优化会话失败');
      if (requestId !== snapshotRequestRef.current || ownsStreamRef.current) return;
      setMessages(hydrateOptimizationMessages(
        data.optimization.messages || [],
        backgroundRunningRef.current ? undefined : 'complete',
      ));
    }).catch((error) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (requestId !== snapshotRequestRef.current) return;
      onError(error instanceof Error ? error.message : '加载优化会话失败');
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [onError, user, workbenchSessionId]);

  useEffect(() => {
    let stopped = false;
    let timer: number | null = null;
    let syncing = false;

    const schedule = (delay: number) => {
      if (stopped) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => void sync(), delay);
    };
    const sync = async (forceConversation = false) => {
      if (stopped || syncing) return;
      syncing = true;
      let active = false;
      try {
        const response = await apiFetch(
          `/api/skill-workbench/sessions/${encodeURIComponent(workbenchSessionId)}?user=${encodeURIComponent(user)}`,
          { cache: 'no-store' },
        );
        const data = await response.json();
        if (stopped || !response.ok || !data.session) return;
        const nextTasks = (data.session.tasks || []).filter((item: { type: string }) => item.type === 'optimization');
        const task = [...nextTasks]
          .reverse()
          .at(0) as OptimizationTaskView | undefined;
        active = Boolean(task && ['pending', 'running'].includes(task.status));
        const previous = observedTaskRef.current;
        const taskChanged = Boolean(task && task.id !== previous?.id);
        const justStarted = Boolean(active && (taskChanged || !previous || !['pending', 'running'].includes(previous.status)));
        const justSettled = Boolean(task && !active && (taskChanged || (previous && ['pending', 'running'].includes(previous.status))));
        const nextRecordsKey = optimizationRecordsSyncKey(data.session.optimizations || []);
        const recordsChanged = nextRecordsKey !== observedRecordsRef.current;
        observedTaskRef.current = task ? { id: task.id, status: task.status } : null;
        if (recordsChanged) observedRecordsRef.current = nextRecordsKey;
        setLiveTasks(nextTasks);

        if (!ownsStreamRef.current && (active || justSettled || forceConversation)) {
          const requestId = ++snapshotRequestRef.current;
          const optimizationResponse = await apiFetch(
            `/api/skill-workbench/sessions/${encodeURIComponent(workbenchSessionId)}/optimization?user=${encodeURIComponent(user)}`,
            { cache: 'no-store' },
          );
          const optimizationData = await optimizationResponse.json();
          if (!stopped && !ownsStreamRef.current && requestId === snapshotRequestRef.current && optimizationResponse.ok) {
            const outcome = active ? undefined : ['failed', 'cancelled'].includes(task?.status || '') ? 'error' : 'complete';
            setMessages(hydrateOptimizationMessages(optimizationData.optimization.messages || [], outcome));
          }
        }
        if (!ownsStreamRef.current) {
          setRunning(active);
          if (!active) setStopping(false);
        }
        if (justStarted || justSettled || recordsChanged) {
          if (!ownsStreamRef.current && task?.status === 'failed' && task.errorMessage) onError(task.errorMessage);
          onSynced(data.session);
        }
      } catch {
        // 下一轮轮询或重新聚焦时继续追赶服务端状态。
      } finally {
        syncing = false;
        schedule(active ? 1_000 : 4_000);
      }
    };

    const unsubscribe = subscribeWorkbenchSync((event) => {
      if (event.sessionId === workbenchSessionId && event.taskType === 'optimization') void sync(true);
    });
    const syncOnFocus = () => void sync(true);
    window.addEventListener('focus', syncOnFocus);
    void sync(backgroundRunningRef.current);
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
      window.removeEventListener('focus', syncOnFocus);
    };
  }, [onError, onSynced, user, workbenchSessionId]);

  const patchAgent = useCallback((mutator: (message: ChatMessage) => void) => setMessages((current) => {
    const next = [...current];
    const last = { ...next.at(-1)!, blocks: [...(next.at(-1)?.blocks || [])] };
    mutator(last);
    next[next.length - 1] = last;
    return next;
  }), []);

  const prepareMergePlan = useCallback(async (signal: AbortSignal): Promise<OptimizationPlanView | null> => {
    setPlanning(true);
    try {
      const response = await apiFetch('/api/skill-opt/plan', {
        signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, skillName, baseVersion, sessionId: optSessionId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '归并优化依据失败');
      let plan = data.plan as OptimizationPlanView | null;
      for (let attempt = 0; plan?.status === 'running' && attempt < 180; attempt += 1) {
        signal.throwIfAborted();
        await new Promise((resolve) => window.setTimeout(resolve, 2_000));
        signal.throwIfAborted();
        const pollResponse = await apiFetch(
          `/api/skill-opt/plan?sessionId=${encodeURIComponent(optSessionId)}&user=${encodeURIComponent(user)}`,
          { cache: 'no-store', signal },
        );
        const pollData = await pollResponse.json();
        if (!pollResponse.ok) throw new Error(pollData.error || '读取优化计划失败');
        plan = pollData.plan as OptimizationPlanView | null;
      }
      if (plan?.status === 'running') throw new Error('归并优化依据超时，请稍后重试');
      if (plan?.status === 'failed') throw new Error(plan.operatorMeta?.error || '归并优化依据失败');
      if (!plan) throw new Error('当前没有待优化问题，可补充优化诉求后重试。');
      const executable = plan.items.some((item) => (
        (item.route === 'core' || item.route === 'reference') && item.status === 'pending'
      ));
      if (!executable) throw new Error('归并后没有可自动执行的优化点；冲突项需先处理，待办项不会自动写入当前版本');
      return plan;
    } finally {
      setPlanning(false);
    }
  }, [baseVersion, optSessionId, skillName, user]);

  const cancelTask = useCallback(async (taskId: string) => {
    try {
      const response = await apiFetch(`/api/skill-workbench/sessions/${encodeURIComponent(workbenchSessionId)}/optimization`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, action: 'cancel', taskId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '停止优化失败');
      publishWorkbenchSync({ sessionId: workbenchSessionId, taskType: 'optimization', kind: 'run-settled' });
    } catch (error) {
      stopRequestedRef.current = false;
      setStopping(false);
      onError(error instanceof Error ? error.message : '停止优化失败');
    }
  }, [onError, user, workbenchSessionId]);

  const stop = () => {
    stopRequestedRef.current = true;
    setStopping(true);
    if (planningControllerRef.current) {
      planningControllerRef.current.abort();
      return;
    }
    const taskId = ownsStreamRef.current ? runTaskIdRef.current : activeTask?.id;
    if (taskId) void cancelTask(taskId);
  };

  const runRequest = useCallback(async (requestText: string, options?: { mergeIssues?: boolean }) => {
    if (busy || ownsStreamRef.current) return;
    if (!hasOptimizationInput(requestText, issues) && !options?.mergeIssues) {
      onError('当前没有待优化问题，可补充优化诉求后重试。');
      return;
    }
    const normalizedRequest = requestText.trim() || (options?.mergeIssues ? '根据当前版本的评估与实验问题优化' : `根据 ${issues.length} 个静态评估问题优化`);
    const runId = safeUUID();
    const runMeta: ChatBlock = { kind: 'optimization_meta', id: `optimization-${runId}`, runId };
    let processOutcome: ProcessOutcome = 'error';
    onError('');
    stopRequestedRef.current = false;
    runTaskIdRef.current = null;
    setStopping(false);
    setRunning(true);
    ownsStreamRef.current = true;
    snapshotRequestRef.current += 1;
    setLocalStep(1);
    setFeedback('');
    setMessages((current) => [
      ...current,
      { role: 'user', content: normalizedRequest, blocks: [{ ...runMeta }] },
      { role: 'agent', content: '', blocks: [{ ...runMeta }], streaming: true },
    ]);
    const controller = new AbortController();
    try {
      planningControllerRef.current = controller;
      const plan = options?.mergeIssues ? await prepareMergePlan(controller.signal) : null;
      controller.signal.throwIfAborted();
      if (!hasOptimizationInput(requestText, issues, plan?.items)) throw new Error('请补充优化诉求或选择有效的评估问题');
      planningControllerRef.current = null;
      const response = await apiFetch('/api/skill-opt/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({
          user, threadId: optSessionId, skillName, baseVersion,
          checkedIssues: issues.map((issue) => ({
            id: issue.id, severity: issue.severity, category: issue.dimension,
            summary: issue.summary, evidence: issue.evidence || issue.reasoning || undefined,
            improvementSuggestion: issue.suggestedFix || undefined,
          })),
          userFeedback: requestText.trim(),
          baselineFiles,
          ...(plan ? { planId: plan.id } : {}),
          mock: false,
          runId,
        }),
      });
      if (!response.ok || !response.body) {
        const failure = await response.json().catch(() => ({}));
        throw new Error(failure.error || '优化 Agent 启动失败');
      }
      publishWorkbenchSync({ sessionId: workbenchSessionId, taskType: 'optimization', kind: 'run-started' });
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
              if (payload.done) {
                block.done = true;
                block.status = 'done';
              }
            }
            else message.blocks.push({ kind: 'thinking', id: payload.id, text: payload.delta || '', done: Boolean(payload.done), status: payload.done ? 'done' : 'running' });
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
            if (block) Object.assign(block, { status: payload.status || 'ok', summary: payload.summary, error: payload.error });
            else message.blocks.push({ kind: 'tool', id: payload.id, name: payload.name || 'tool', status: payload.status || 'ok', summary: payload.summary, error: payload.error });
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
          else if (data.mode === 'optimization_meta') {
            if (payload.taskId) {
              runTaskIdRef.current = payload.taskId;
              if (stopRequestedRef.current) void cancelTask(payload.taskId);
            }
            patchAgent((message) => {
              const id = `optimization-${payload.runId || payload.recordId || payload.taskId || runId}`;
              const block = message.blocks.find((item) => item.kind === 'optimization_meta' && item.id === id);
              const next = { kind: 'optimization_meta', id, runId: payload.runId || runId, recordId: payload.recordId, taskId: payload.taskId };
              if (block) Object.assign(block, next);
              else message.blocks.push(next);
            });
          }
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
            setLocalStep((current) => Math.max(current, 3));
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
          else if (data.mode === 'cancelled') {
            processOutcome = 'error';
            patchAgent((message) => {
              message.blocks = settleProcessBlocks(message.blocks, 'error');
              message.blocks.push({ kind: 'text', id: `cancelled-${runId}`, text: '优化已停止，可补充诉求后重新提交。' });
              message.streaming = false;
            });
          }
          else if (data.mode === 'done') {
            processOutcome = 'complete';
            patchAgent((message) => {
              message.blocks = settleProcessBlocks(message.blocks, 'complete');
              message.streaming = false;
            });
          }
          else if (data.mode === 'error') {
            patchAgent((message) => { message.blocks = settleProcessBlocks(message.blocks, 'error'); });
            throw new Error(String(data.payload || '优化失败'));
          }
        }
      }
      const requestId = ++snapshotRequestRef.current;
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
      if (requestId === snapshotRequestRef.current) {
        setMessages(hydrateOptimizationMessages(optimizationData.optimization.messages || [], processOutcome));
      }
      setLocalStep(4);
      onSynced(sessionData.session);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        patchAgent((agent) => agent.blocks.push({ kind: 'text', id: `cancelled-${runId}`, text: '已停止本次优化请求，可补充诉求后重新提交。' }));
      } else {
        const message = error instanceof Error ? error.message : '优化失败';
        patchAgent((agent) => {
          agent.content ||= message;
          agent.blocks.push({ kind: 'warning', id: `error-${runId}`, text: displayOptimizationError(message) });
        });
        onError(message);
      }
    } finally {
      ownsStreamRef.current = false;
      planningControllerRef.current = null;
      runTaskIdRef.current = null;
      setStopping(false);
      setRunning(false);
      patchAgent((message) => {
        message.blocks = settleProcessBlocks(message.blocks, processOutcome);
        message.streaming = false;
      });
      publishWorkbenchSync({ sessionId: workbenchSessionId, taskType: 'optimization', kind: 'run-settled' });
    }
  }, [baseVersion, baselineFiles, busy, cancelTask, issues, onError, onSynced, optSessionId, patchAgent, prepareMergePlan, skillName, user, workbenchSessionId]);

  useEffect(() => {
    if (!autoStart) {
      autoStartedRef.current = false;
      return;
    }
    if (loading || busy || autoStartedRef.current) return;
    autoStartedRef.current = true;
    onAutoStartConsumed();
    void runRequest(autoStartFeedback, { mergeIssues: useMergePlan && !autoStartFeedback.trim() });
  }, [autoStart, autoStartFeedback, busy, issues.length, loading, onAutoStartConsumed, runRequest, useMergePlan]);

  const run = (event: FormEvent) => {
    event.preventDefault();
    void runRequest(feedback, { mergeIssues: useMergePlan && !feedback.trim() });
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
        {messages.length === 0 && !autoStart && <div className="rounded-lg bg-background-secondary p-3 text-xs leading-5 text-foreground-secondary"><b className="text-foreground">可以提交优化诉求。</b><br />{issues.length ? `未填写诉求时，将使用当前有效的评估问题。` : useMergePlan ? '点击“Skill 优化”或发送，将整理当前版本的评估与实验问题并执行；也可以填写具体诉求。' : '填写具体诉求后，点击“Skill 优化”或发送即可开始。'}</div>}
        {messages.map((message, index) => {
          const meta = optimizationMeta(message);
          const messageRecords = recordsAtMessage.get(index) || [];
          const messageTask = meta?.taskId
            ? liveTasks.find((item) => item.id === meta.taskId)
            : messageRecords.length
              ? liveTasks.find((item) => messageRecords.some((record) => item.resultId === record.id))
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
              ? <ConversationProcessDisclosure key={`${block.id}-${blockIndex}`} kind="tool" state={processState(block.status, messageTask?.status || (message.streaming ? undefined : 'done'))} name={block.name}>
                <pre className="m-0 max-h-72 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-4 [overflow-wrap:anywhere]">{block.summary || block.error || block.status}</pre>
              </ConversationProcessDisclosure>
              : block.kind === 'thinking' ? <ConversationProcessDisclosure key={`${block.id}-${blockIndex}`} kind="thinking" state={processState(block.status || (block.done === false ? 'running' : 'done'), messageTask?.status || (message.streaming ? undefined : 'done'))}>
                <p className="whitespace-pre-wrap break-words leading-5 [overflow-wrap:anywhere]">{block.text}</p>
              </ConversationProcessDisclosure>
                : block.kind === 'optimization_plan' ? <OptimizationPlanCard key={`${block.id}-${blockIndex}`} block={block} />
                  : block.kind === 'verification' && messageTask?.status === 'cancelled' && block.status !== 'ok' ? <p key={`${block.id}-${blockIndex}`} className="my-1 text-xs text-foreground-muted">自验证已停止</p>
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
      {typeof quickActions === 'function' ? quickActions(feedback, busy || loading) : quickActions}
      <form onSubmit={run} className="rounded-lg border border-border bg-card p-2">
        <textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} rows={3} placeholder={busy ? "可编辑补充诉求，停止或完成后提交…" : "补充优化诉求…"} className="w-full resize-none bg-transparent px-1 text-xs leading-5 text-foreground outline-none placeholder:text-foreground-muted" />
        <div className="flex justify-end">{busy
          ? <button type="button" onClick={stop} disabled={stopping || Boolean(activeTask?.progress?.cancelRequested) || (!ownsStreamRef.current && !activeTask?.id)} className="inline-flex h-8 items-center gap-1.5 rounded border border-border px-2 text-xs text-foreground-secondary disabled:opacity-50">{stopping || activeTask?.progress?.cancelRequested ? '正在停止…' : '停止优化'}</button>
          : <button type="submit" aria-label="开始优化" disabled={loading || (!hasOptimizationInput(feedback, issues) && !useMergePlan)} className="inline-flex size-8 items-center justify-center rounded bg-primary text-primary-foreground disabled:opacity-40"><Send className="size-3.5" /></button>}</div>
      </form>
    </div>
  );
}

function OptimizationProgressCard({ task, record, localStep, planning, showError = true }: { task?: OptimizationTaskView; record?: OptimizationRecordView; localStep: number; planning: boolean; showError?: boolean }) {
  const taskStep = Number(task?.progress?.activeStep || 0);
  const activeStep = task?.status === 'done' ? 5 : Math.max(taskStep, localStep);
  if (task?.status === 'cancelled') return <p className="mt-3 text-xs text-foreground-muted">优化已停止，可补充诉求后重新提交。</p>;
  const qualityFailed = record?.status === 'optimization_failed' && Boolean(record.blockingIssues?.length);
  return <div className="mt-3 min-w-0 max-w-full overflow-hidden rounded-md border border-border">
    <p className="px-3 py-2 text-xs leading-5 text-foreground-secondary">{task?.progress?.cancelRequested ? task.progress.stage || '正在停止优化…' : planning ? '正在归并、去重并排序优化依据，完成后会自动开始修改。' : '我会基于评估与实验结果生成候选版本，当前版本不会被覆盖。'}</p>
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
    {showError && (task?.status === 'failed' || task?.progress?.cancelRequested) && task?.errorMessage && <p className="break-words border-t border-border px-3 py-2 text-[11px] text-error [overflow-wrap:anywhere]">{displayOptimizationError(task.errorMessage)}</p>}
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
  const cancelled = record.status === 'optimization_cancelled';
  const status = cancelled ? '优化已停止' : record.status === 'optimizing' ? '优化中'
    : qualityPassed ? '质量规则已通过'
      : executionFailed ? '优化执行失败'
        : record.status === 'optimization_failed' ? '质量校验未通过'
        : record.status === 'published' ? '已发布'
          : record.status === 'abandoned' ? '已放弃' : '需处理';
  return <div className="mt-3 min-w-0 max-w-full overflow-hidden rounded-md border border-border bg-background p-3">
    <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-foreground">
      {cancelled ? <Circle className="size-4 shrink-0 text-foreground-muted" /> : record.status === 'optimization_failed' ? <X className="size-4 shrink-0 text-error" /> : record.status === 'optimizing' ? <Loader2 className="size-4 shrink-0 animate-spin text-primary" /> : <CheckCircle2 className="size-4 shrink-0 text-success" />}
      <span className="min-w-0 truncate">{cancelled ? '本轮优化已停止' : executionFailed && !hasCandidate ? '本轮优化失败' : getOptimizationTransitionLabel(record)}</span>
      <span className="ml-auto shrink-0 rounded bg-background-secondary px-1.5 py-0.5 text-[10px] text-foreground-muted">{status}</span>
    </div>
    <p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-[11px] leading-4 text-foreground-secondary [overflow-wrap:anywhere]">{executionFailed && !hasCandidate ? `尚未生成 ${getOptimizationTargetVersion(record)} 候选。${displayOptimizationError(record.errorMessage)}` : record.summary}</p>
    <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-foreground-secondary">
      {hasCandidate && <span className="rounded bg-background-secondary px-1.5 py-1">候选版本 {getOptimizationTargetVersion(record)}</span>}
      {hasCandidate && <span className="rounded bg-background-secondary px-1.5 py-1">修改 {record.diff?.length || 0} 项</span>}
      {cancelled ? <span className="rounded bg-background-secondary px-1.5 py-1 text-foreground-muted">未保存可发布候选</span> : !hasCandidate && executionFailed
        ? <span className="rounded bg-error-subtle px-1.5 py-1 text-error">未生成候选</span>
        : record.status === 'optimization_failed'
        ? <span className="rounded bg-error-subtle px-1.5 py-1 text-error">{executionFailed ? '优化执行失败' : '质量校验未通过'}</span>
        : record.status === 'optimizing'
          ? null
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
