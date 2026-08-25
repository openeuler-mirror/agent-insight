'use client';

import { FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Bot, CheckCircle2, Globe2, Loader2, Paperclip, Send, Wrench, X } from 'lucide-react';

import { apiFetch } from '@/lib/client/api';
import { ALLOWED_EXT_ACCEPT } from '@/lib/skill-generator/file-types';

type GenerationBlock =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string; done?: boolean }
  | { kind: 'tool'; id: string; name: string; status: string; summary?: string; error?: string }
  | { kind: 'question'; id: string; question: string; status: string; answer?: unknown }
  | { kind: 'download'; id: string; skillName: string; fileCount: number };

interface GenerationMessage {
  id?: string;
  role: string;
  content: string;
  blocks: GenerationBlock[];
  streaming?: boolean;
}

function parseBlocks(value: string | GenerationBlock[] | undefined) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed as GenerationBlock[] : [];
  } catch {
    return [];
  }
}

export function GenerationHistory({
  user,
  workbenchSessionId,
  generatorSessionId,
  onError,
}: {
  user: string;
  workbenchSessionId: string;
  generatorSessionId: string;
  onError: (message: string) => void;
}) {
  const [messages, setMessages] = useState<GenerationMessage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void apiFetch(`/api/skill-workbench/sessions/${encodeURIComponent(workbenchSessionId)}/generation?user=${encodeURIComponent(user)}`, {
      cache: 'no-store',
      signal: controller.signal,
    }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '加载生成记录失败');
      setMessages((data.generation.messages || []).map((message: { id: string; role: string; content: string; blocks?: string }) => ({
        ...message,
        blocks: parseBlocks(message.blocks),
      })));
    }).catch((error) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      onError(error instanceof Error ? error.message : '加载生成记录失败');
    }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [generatorSessionId, onError, user, workbenchSessionId]);

  if (loading) {
    return <div className="flex items-center py-2 text-[11px] text-foreground-muted"><Loader2 className="mr-2 size-3.5 animate-spin" />加载 Skill 生成记录</div>;
  }
  if (messages.length === 0) return null;

  return (
    <>
      <ConversationPhaseLabel label="Skill 生成记录" />
      <GenerationMessageList messages={messages} user={user} />
      <ConversationPhaseLabel label="Skill 优化记录" />
    </>
  );
}

export function GenerationConversation({
  user,
  workbenchSessionId,
  generatorSessionId,
  backgroundRunning,
  quickActions,
  onRunningChange,
  onSynced,
  onError,
}: {
  user: string;
  workbenchSessionId: string;
  generatorSessionId: string;
  backgroundRunning: boolean;
  quickActions?: ReactNode;
  onRunningChange: (running: boolean) => void;
  onSynced: (session: unknown) => void;
  onError: (message: string) => void;
}) {
  const [messages, setMessages] = useState<GenerationMessage[]>([]);
  const [files, setFiles] = useState<Record<string, unknown>>({});
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(backgroundRunning);
  const [attachments, setAttachments] = useState<Array<{ name: string; size: number }>>([]);
  const [uploading, setUploading] = useState(false);
  const [configs, setConfigs] = useState<Array<{ id: string; name: string }>>([]);
  const [modelId, setModelId] = useState('');
  const [scenario, setScenario] = useState('general');
  const [webSearchConfigured, setWebSearchConfigured] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    onRunningChange(running);
    return () => onRunningChange(false);
  }, [onRunningChange, running]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void apiFetch(`/api/skill-workbench/sessions/${encodeURIComponent(workbenchSessionId)}/generation?user=${encodeURIComponent(user)}`, {
      cache: 'no-store',
      signal: controller.signal,
    }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '加载生成会话失败');
      setFiles(data.generation.files || {});
      setMessages((data.generation.messages || []).map((message: { id: string; role: string; content: string; blocks?: string }) => ({
        ...message,
        blocks: parseBlocks(message.blocks),
      })));
    }).catch((error) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      onError(error instanceof Error ? error.message : '加载生成会话失败');
    }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [onError, user, workbenchSessionId]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      apiFetch(`/api/settings?user=${encodeURIComponent(user)}`, { signal: controller.signal }).then((response) => response.json()),
      apiFetch(`/api/skill-generator/attachments?user=${encodeURIComponent(user)}&threadId=${encodeURIComponent(generatorSessionId)}`, {
        signal: controller.signal,
      }).then((response) => response.json()),
    ]).then(([settings, attachmentData]) => {
      const nextConfigs = Array.isArray(settings.configs) ? settings.configs : [];
      setConfigs(nextConfigs);
      setModelId(settings.activeConfigId || nextConfigs[0]?.id || '');
      const searchReady = settings.searchProvider === 'tavily' && Boolean(settings.searchApiKey);
      setWebSearchConfigured(searchReady);
      setWebSearchEnabled(searchReady);
      setAttachments(Array.isArray(attachmentData.items) ? attachmentData.items : []);
    }).catch((error) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        onError(error instanceof Error ? error.message : '加载对话配置失败');
      }
    });
    return () => controller.abort();
  }, [generatorSessionId, onError, user]);

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
          .find((item: { type: string; status: string; errorMessage?: string }) => item.type === 'generation');
        if (!task || task.status === 'running' || task.status === 'pending') return;
        window.clearInterval(poll);
        const generationResponse = await apiFetch(
          `/api/skill-workbench/sessions/${encodeURIComponent(workbenchSessionId)}/generation?user=${encodeURIComponent(user)}`,
          { cache: 'no-store' },
        );
        const generationData = await generationResponse.json();
        if (generationResponse.ok) {
          setFiles(generationData.generation.files || {});
          setMessages((generationData.generation.messages || []).map((message: { id: string; role: string; content: string; blocks?: string }) => ({
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

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: running ? 'auto' : 'smooth' });
  }, [messages, running]);

  const patchAgent = (mutator: (message: GenerationMessage) => void) => {
    setMessages((current) => {
      const next = [...current];
      const last = { ...next[next.length - 1], blocks: [...(next[next.length - 1]?.blocks || [])] };
      mutator(last);
      next[next.length - 1] = last;
      return next;
    });
  };

  const uploadAttachments = async (fileList: FileList | null) => {
    if (!fileList?.length || uploading) return;
    setUploading(true);
    try {
      const body = new FormData();
      body.set('user', user);
      body.set('threadId', generatorSessionId);
      for (const file of Array.from(fileList)) body.append('files', file);
      const response = await apiFetch('/api/skill-generator/attachments', { method: 'POST', body });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '上传参考资料失败');
      setAttachments(Array.isArray(data.items) ? data.items : []);
      if (Array.isArray(data.errors) && data.errors.length) {
        onError(data.errors.map((item: { name: string; reason: string }) => `${item.name}: ${item.reason}`).join('；'));
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : '上传参考资料失败');
    } finally {
      setUploading(false);
      if (attachmentInputRef.current) attachmentInputRef.current.value = '';
    }
  };

  const removeAttachment = async (name: string) => {
    const response = await apiFetch(
      `/api/skill-generator/attachments?user=${encodeURIComponent(user)}&threadId=${encodeURIComponent(generatorSessionId)}&name=${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    );
    const data = await response.json();
    if (response.ok) setAttachments(Array.isArray(data.items) ? data.items : []);
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const message = input.trim();
    if (!message || running) return;
    setInput('');
    setMessages((current) => [
      ...current,
      { role: 'user', content: message, blocks: [] },
      { role: 'agent', content: '', blocks: [], streaming: true },
    ]);
    setRunning(true);
    const controller = new AbortController();
    try {
      const response = await apiFetch('/api/skill-generator/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          user,
          threadId: generatorSessionId,
          files,
          modelId,
          scenario,
          webSearchEnabled: webSearchConfigured && webSearchEnabled,
          mock: false,
          runId: crypto.randomUUID(),
        }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error('生成 Agent 启动失败');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';
        for (const eventText of events) {
          if (!eventText.startsWith('data: ')) continue;
          const eventData = JSON.parse(eventText.slice(6)) as { mode: string; payload: any };
          if (eventData.mode === 'text') {
            patchAgent((agent) => {
              agent.content += String(eventData.payload || '');
              const tail = agent.blocks.at(-1);
              if (tail?.kind === 'text') tail.text += String(eventData.payload || '');
              else agent.blocks.push({ kind: 'text', id: `text_${agent.blocks.length}`, text: String(eventData.payload || '') });
            });
          } else if (eventData.mode === 'thinking') {
            const payload = eventData.payload || {};
            patchAgent((agent) => {
              const existing = agent.blocks.find((block) => block.kind === 'thinking' && block.id === payload.id);
              if (existing?.kind === 'thinking') {
                existing.text += payload.delta || '';
                existing.done = payload.done || existing.done;
              } else agent.blocks.push({ kind: 'thinking', id: payload.id, text: payload.delta || '', done: payload.done });
            });
          } else if (eventData.mode === 'tool_call') {
            const payload = eventData.payload || {};
            patchAgent((agent) => agent.blocks.push({ kind: 'tool', id: payload.id, name: payload.name, status: payload.status || 'running' }));
          } else if (eventData.mode === 'tool_result') {
            const payload = eventData.payload || {};
            patchAgent((agent) => {
              const tool = agent.blocks.find((block) => block.kind === 'tool' && block.id === payload.id);
              if (tool?.kind === 'tool') Object.assign(tool, { status: payload.status || 'ok', summary: payload.summary, error: payload.error });
            });
          } else if (eventData.mode === 'question') {
            const payload = eventData.payload || {};
            patchAgent((agent) => agent.blocks.push({ kind: 'question', id: payload.id, question: payload.question || '', status: 'pending' }));
          } else if (eventData.mode === 'question_answered') {
            const payload = eventData.payload || {};
            patchAgent((agent) => {
              const question = agent.blocks.find((block) => block.kind === 'question' && block.id === payload.id);
              if (question?.kind === 'question') Object.assign(question, { status: payload.status, answer: payload.answer });
            });
          } else if (eventData.mode === 'vfs_patch' && eventData.payload?.files) {
            setFiles(eventData.payload.files);
          } else if (eventData.mode === 'download') {
            const payload = eventData.payload || {};
            patchAgent((agent) => agent.blocks.push({ kind: 'download', id: payload.id, skillName: payload.skillName, fileCount: payload.fileCount || 0 }));
          } else if (eventData.mode === 'error') {
            throw new Error(String(eventData.payload || '生成失败'));
          }
        }
      }
      const sessionResponse = await apiFetch(
        `/api/skill-workbench/sessions/${encodeURIComponent(workbenchSessionId)}?user=${encodeURIComponent(user)}`,
        { cache: 'no-store' },
      );
      const sessionData = await sessionResponse.json();
      if (sessionResponse.ok && sessionData.session) onSynced(sessionData.session);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        onError(error instanceof Error ? error.message : '生成失败');
      }
    } finally {
      setRunning(false);
      patchAgent((agent) => { agent.streaming = false; });
    }
  };

  if (loading) return <div className="m-auto flex items-center text-xs text-foreground-muted"><Loader2 className="mr-2 size-4 animate-spin" />加载生成会话</div>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden pb-3" style={{ scrollbarGutter: 'stable' }}>
        {messages.length === 0 && (
          <div className="rounded-lg bg-background-secondary px-3 py-3 text-xs leading-5 text-foreground-secondary">
            <b className="text-foreground">描述你希望创建的 Skill。</b><br />我会先澄清目标、输入输出、适用边界和安全约束，再生成工作快照。
          </div>
        )}
        <GenerationMessageList messages={messages} user={user} />
        <div ref={endRef} />
      </div>
      {quickActions}
      <form onSubmit={send} className="shrink-0 rounded-lg border border-border bg-card p-2">
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((attachment) => (
              <span key={attachment.name} className="inline-flex max-w-full items-center gap-1 rounded bg-background-secondary px-1.5 py-1 text-[10px] text-foreground-secondary">
                <Paperclip className="size-3" />
                <span className="max-w-44 truncate">{attachment.name}</span>
                <button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => void removeAttachment(attachment.name)}><X className="size-3" /></button>
              </span>
            ))}
          </div>
        )}
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          disabled={running}
          rows={3}
          placeholder="描述 Skill 的目标、输入和期望输出…"
          className="w-full resize-none bg-transparent px-1 text-xs leading-5 text-foreground outline-none placeholder:text-foreground-muted disabled:opacity-60"
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <input ref={attachmentInputRef} type="file" multiple accept={ALLOWED_EXT_ACCEPT} className="hidden" onChange={(event) => void uploadAttachments(event.target.files)} />
          <button type="button" title="上传参考资料" disabled={uploading} onClick={() => attachmentInputRef.current?.click()} className="inline-flex size-7 items-center justify-center rounded border border-border text-foreground-secondary disabled:opacity-50">
            {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Paperclip className="size-3.5" />}
          </button>
          <select value={modelId} onChange={(event) => setModelId(event.target.value)} title="模型" className="h-7 min-w-0 max-w-28 rounded border border-border bg-background px-1 text-[10px] text-foreground">
            {configs.map((config) => <option key={config.id} value={config.id}>{config.name}</option>)}
            {configs.length === 0 && <option value="">默认模型</option>}
          </select>
          <select value={scenario} onChange={(event) => setScenario(event.target.value)} title="场景" className="h-7 rounded border border-border bg-background px-1 text-[10px] text-foreground">
            <option value="general">通用</option>
            <option value="ops">运维</option>
          </select>
          <button
            type="button"
            title={webSearchConfigured ? (webSearchEnabled ? '关闭联网搜索' : '开启联网搜索') : '请先在配置中心设置 Tavily'}
            disabled={!webSearchConfigured}
            onClick={() => setWebSearchEnabled((current) => !current)}
            className={`inline-flex size-7 items-center justify-center rounded border disabled:opacity-40 ${webSearchEnabled ? 'border-primary bg-primary-subtle text-primary' : 'border-border text-foreground-secondary'}`}
          >
            <Globe2 className="size-3.5" />
          </button>
          <span className="flex-1" />
          {running ? (
            <span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-[10px] text-foreground-muted"><Loader2 className="size-3.5 animate-spin" />后台执行中</span>
          ) : (
            <button type="submit" disabled={!input.trim()} className="inline-flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground disabled:opacity-40"><Send className="size-3.5" /></button>
          )}
        </div>
      </form>
    </div>
  );
}

function ConversationPhaseLabel({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-1 text-[10px] font-medium text-foreground-muted">
      <span className="h-px flex-1 bg-border" />
      <span>{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function GenerationMessageList({ messages, user }: { messages: GenerationMessage[]; user: string }) {
  return messages.map((message, index) => (
    <div key={`generation-${message.id || index}`} className={message.role === 'user' ? 'ml-8 min-w-0 max-w-full overflow-hidden rounded-lg bg-primary px-3 py-2 text-xs leading-5 text-primary-foreground' : 'min-w-0 max-w-full overflow-hidden rounded-lg border border-border bg-card px-3 py-3'}>
      {message.role !== 'user' && <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-foreground-muted"><Bot className="size-3.5" />Skill Agent</div>}
      {message.blocks.length ? message.blocks.map((block) => (
        <GenerationBlockView key={block.id} block={block} user={user} />
      )) : <p className="whitespace-pre-wrap break-words text-xs leading-5 [overflow-wrap:anywhere]">{message.content}</p>}
      {message.streaming && <Loader2 className="mt-2 size-3.5 animate-spin text-primary" />}
    </div>
  ));
}

function GenerationBlockView({ block, user }: { block: GenerationBlock; user: string }) {
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  if (block.kind === 'text') return <p className="max-w-full whitespace-pre-wrap break-words text-xs leading-5 text-foreground-secondary [overflow-wrap:anywhere]">{block.text}</p>;
  if (block.kind === 'thinking') return <details className="my-2 min-w-0 max-w-full overflow-hidden rounded-md bg-background-secondary px-2 py-1.5 text-[11px] text-foreground-muted"><summary>思考过程</summary><p className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{block.text}</p></details>;
  if (block.kind === 'tool') return <div className="my-1 grid min-w-0 max-w-full grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 overflow-hidden rounded-md bg-background-secondary px-2 py-1.5 text-[11px] text-foreground-secondary"><Wrench className="mt-0.5 size-3.5" /><span className="min-w-0 break-words font-medium [overflow-wrap:anywhere]">{block.name}</span><span className="col-span-2 min-w-0 whitespace-pre-wrap break-words text-foreground-muted [overflow-wrap:anywhere]">{block.summary || block.status}</span></div>;
  if (block.kind === 'download') return <div className="my-2 flex items-center gap-2 rounded-md border border-success-border bg-success-subtle px-2 py-2 text-[11px] text-success"><CheckCircle2 className="size-3.5" />已生成 {block.skillName} · {block.fileCount} 个文件</div>;
  if (block.kind === 'question') {
    if (block.status !== 'pending') return <div className="my-2 rounded-md bg-background-secondary px-2 py-2 text-[11px] text-foreground-secondary">已回答：{String(block.answer || '已跳过')}</div>;
    const submitAnswer = async () => {
      if (!answer.trim() || submitting) return;
      setSubmitting(true);
      try {
        const response = await apiFetch('/api/agent/respond', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: block.id, user, kind: 'question', reply: [answer.trim()] }),
        });
        if (!response.ok) throw new Error('提交回答失败');
      } finally { setSubmitting(false); }
    };
    return <div className="my-2 min-w-0 max-w-full overflow-hidden rounded-md border border-border bg-background-secondary p-2 text-[11px]"><p className="break-words text-foreground [overflow-wrap:anywhere]">{block.question}</p><div className="mt-2 flex gap-1"><input value={answer} onChange={(event) => setAnswer(event.target.value)} className="h-7 min-w-0 flex-1 rounded border border-border bg-card px-2 text-foreground outline-none" /><button type="button" onClick={() => void submitAnswer()} disabled={submitting} className="rounded bg-primary px-2 text-primary-foreground disabled:opacity-50">回答</button></div></div>;
  }
  return null;
}
