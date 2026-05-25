'use client';

import { useState, useEffect } from 'react';

/**
 * Chat 流里的可视化块组件 —— skill-generator 与 skill-opt 共用。
 *
 * 设计来源：从 src/app/(main)/skill-generator/page.tsx 提取，去掉对 skill-generator 内部
 * Block union 的依赖，独立成可复用的 props-only 形态。CSS 在
 * src/components/chat/chat-blocks.css，两个页面各自 import 一次。
 *
 * 这里不含「skill-generator 专属」的块（download / question / skill-card）——那些跟
 * skill-generator 业务深度耦合，留在 page.tsx 里。本模块只覆盖 thinking / tool /
 * todo / web-search 这四个跨场景通用块。
 */

// ─── 数据类型（最小公共子集，跟两个页面里现有 Block 的对应字段同形） ────────

export interface ThinkingBlockData {
  id: string;
  text: string;
  done: boolean;
}

export interface ToolBlockData {
  id: string;
  name: string;
  args?: any;
  status: 'running' | 'ok' | 'error';
  summary?: string;
  error?: string;
}

export interface TodoItem {
  content: string;
  status?: string;   // pending / in_progress / completed / cancelled
  priority?: string;
}

// ─── 工具名 → 人类可读 label（skill-generator/page.tsx 887-948 复制过来） ─────────

export function getToolLabel(name: string, args: any, locale: string): string {
  const isZh = locale === 'zh';
  // Tool-arg field names vary across agent frameworks: deepagents/langchain
  // uses `file_path`, claude uses `path`, opencode uses `filePath` (camelCase).
  const filePath = args?.filePath ?? args?.file_path ?? args?.path ?? args?.filename ?? args?.file;
  const fileName = (p?: string) => (p ? String(p).split('/').pop() || String(p) : '');
  const fname = fileName(filePath);
  const withFile = (zh: string, en: string, suffix?: string) => {
    const s = suffix ?? fname;
    return s ? (isZh ? `${zh} ${s}` : `${en} ${s}`) : (isZh ? zh : en);
  };

  switch (name) {
    case 'write_file':
    case 'create_file':
    case 'write':
      return withFile('创建文件', 'Writing');
    case 'edit':
    case 'str_replace':
    case 'edit_file':
      return withFile('修改文件', 'Editing');
    case 'read_file':
    case 'read':
      return withFile('读取文件', 'Reading');
    case 'ls':
      return withFile('列出目录', 'Listing', filePath || '/');
    case 'bash':
    case 'interactive_bash':
      return isZh ? '执行命令' : 'Running command';
    case 'glob':
      return withFile('查找文件', 'Searching', args?.pattern);
    case 'grep':
      return withFile('搜索内容', 'Grepping', args?.pattern ? `"${args.pattern}"` : '');
    case 'web_fetch':
    case 'webfetch':
      return isZh ? '抓取网页' : 'Fetching URL';
    case 'web_search':
    case 'websearch':
      return isZh ? '搜索网络' : 'Web search';
    case 'task':
      return isZh ? '调用子 Agent' : 'Calling subagent';
    case 'write_todos':
    case 'todo_write':
    case 'todowrite':
      return isZh ? '更新待办列表' : 'Updating todos';
    case 'skill':
      return withFile('加载技能', 'Loading skill', args?.name);
    case 'look_at':
      return isZh ? '查看视图' : 'Look at';
    default:
      return name;
  }
}

// ─── ThinkingBlock ───────────────────────────────────────────────────────────

export function ChatThinkingBlock({ block, locale }: { block: ThinkingBlockData; locale: string }) {
  const [open, setOpen] = useState(!block.done);
  // Auto-collapse the moment a thinking block finishes streaming.
  useEffect(() => { if (block.done) setOpen(false); }, [block.done]);

  const isZh = locale === 'zh';
  const label = block.done
    ? (isZh ? '已完成思考' : 'Thought')
    : (isZh ? '思考中...' : 'Thinking...');
  return (
    <div className={`inline-block thinking ${block.done ? 'done' : 'streaming'}`}>
      <button className="inline-block-header" onClick={() => setOpen(o => !o)}>
        <span className="inline-block-icon" aria-hidden>
          {block.done ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 8v4l2.5 2.5" /></svg>
          ) : (
            <span className="inline-block-spinner" />
          )}
        </span>
        <span className="inline-block-label">{label}</span>
        <span className="inline-block-chevron" data-open={open}>▾</span>
      </button>
      {open && (
        <div className="inline-block-body thinking-body">
          {block.text || (isZh ? '（思考中…）' : '(thinking…)')}
        </div>
      )}
    </div>
  );
}

// ─── ToolBlock（routes to TodoBlock / WebSearchBlock for special tools） ────

export function ChatToolBlock({
  block, onOpenFile, locale,
}: {
  block: ToolBlockData;
  onOpenFile?: (p: string) => void;
  locale: string;
}) {
  const [open, setOpen] = useState(false);

  const isWebSearch = block.name === 'web_search' || block.name === 'websearch'
    || block.name === 'web_fetch' || block.name === 'webfetch';
  if (isWebSearch) return <ChatWebSearchBlock block={block} locale={locale} />;

  const isWriteTodos =
    (block.name === 'write_todos' || block.name === 'todo_write' || block.name === 'todowrite')
    && Array.isArray(block.args?.todos);
  if (isWriteTodos) return <ChatTodoBlock todos={block.args.todos} locale={locale} />;

  const label = getToolLabel(block.name, block.args, locale);
  const filePath = block.args?.filePath ?? block.args?.file_path ?? block.args?.path ?? block.args?.filename;
  const isFileWrite = (block.name === 'write_file' || block.name === 'write' || block.name === 'create_file') && filePath;

  const StatusIcon = () => {
    if (block.status === 'running') return <span className="inline-block-spinner" />;
    if (block.status === 'ok') return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    );
  };

  const fpArg = filePath;
  const headerPreview = (() => {
    if (block.name === 'bash' || block.name === 'interactive_bash') {
      const cmd = block.args?.command;
      if (typeof cmd === 'string' && cmd.trim()) return cmd.trim();
    }
    if (block.name === 'write' || block.name === 'write_file' || block.name === 'create_file') {
      if (fpArg) {
        const bytes = typeof block.args?.content === 'string' ? block.args.content.length : null;
        return bytes != null ? `${fpArg} (${bytes} 字符)` : String(fpArg);
      }
    }
    if (block.name === 'edit' || block.name === 'str_replace' || block.name === 'edit_file') {
      if (fpArg) return String(fpArg);
    }
    if (block.name === 'read' || block.name === 'read_file') {
      if (fpArg) return String(fpArg);
    }
    return block.summary || '';
  })();

  const inputView = (() => {
    if (!block.args || typeof block.args !== 'object') return null;
    const { content, ...rest } = block.args as Record<string, any>;
    const restPretty = Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : null;
    const contentStr = typeof content === 'string' ? content : null;
    if (!restPretty && contentStr == null) return null;
    return { restPretty, content: contentStr };
  })();

  const isZh = locale === 'zh';

  return (
    <div className={`inline-block tool status-${block.status}`}>
      <button className="inline-block-header" onClick={() => setOpen(o => !o)}>
        <span className="inline-block-icon" aria-hidden><StatusIcon /></span>
        <span className="inline-block-label">{label}</span>
        {headerPreview && !open && (
          <span className="inline-block-summary">{headerPreview}</span>
        )}
        <span className="inline-block-chevron" data-open={open}>▾</span>
      </button>
      {open && (
        <div className="inline-block-body tool-body">
          <div className="tool-row">
            <span className="tool-row-key">{isZh ? '工具' : 'tool'}</span>
            <code className="tool-row-value">{block.name}</code>
          </div>
          <div className="tool-row">
            <span className="tool-row-key">{isZh ? '输入' : 'input'}</span>
            <div className="tool-row-value tool-input-stack">
              {inputView ? (
                <>
                  {inputView.restPretty && <pre className="tool-args-pre">{inputView.restPretty}</pre>}
                  {inputView.content != null && (
                    <pre className="tool-content-pre" data-label={isZh ? '文件内容' : 'content'}>{inputView.content}</pre>
                  )}
                </>
              ) : (
                <span className="tool-row-empty">{isZh ? '（无）' : '(none)'}</span>
              )}
            </div>
          </div>
          <div className="tool-row">
            <span className="tool-row-key">{isZh ? '输出' : 'output'}</span>
            <div className="tool-row-value">
              {block.status === 'running' ? (
                <span className="tool-row-empty">{isZh ? '（运行中…）' : '(running…)'}</span>
              ) : block.summary ? (
                <pre className="tool-result-pre">{block.summary}</pre>
              ) : (
                <span className="tool-row-empty">{isZh ? '（无输出）' : '(no output)'}</span>
              )}
            </div>
          </div>
          {block.error && (
            <div className="tool-row tool-row-error">
              <span className="tool-row-key">{isZh ? '错误' : 'error'}</span>
              <pre className="tool-result-pre">{block.error}</pre>
            </div>
          )}
          {isFileWrite && block.status === 'ok' && onOpenFile && (
            <button className="tool-open-link" onClick={() => onOpenFile(String(filePath))}>
              {isZh ? '在编辑器中打开 ↗' : 'Open in editor ↗'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── TodoBlock ───────────────────────────────────────────────────────────────

export function ChatTodoBlock({ todos, locale }: { todos: TodoItem[]; locale: string }) {
  const isZh = locale === 'zh';
  const counts = { completed: 0, in_progress: 0, pending: 0, cancelled: 0 };
  for (const t of todos) {
    const s = (t.status || 'pending') as keyof typeof counts;
    if (s in counts) counts[s] += 1;
    else counts.pending += 1;
  }
  const total = todos.length;

  return (
    <div className="inline-block todos-block">
      <div className="todos-header">
        <span className="todos-icon" aria-hidden>📋</span>
        <span className="todos-title">
          {isZh ? '待办列表' : 'Todos'}
          <span className="todos-progress">
            {counts.completed}/{total}
          </span>
        </span>
        <span className="todos-counts">
          {counts.completed > 0 && (
            <span className="todos-count completed">✅ {counts.completed} {isZh ? '已完成' : 'done'}</span>
          )}
          {counts.in_progress > 0 && (
            <span className="todos-count in-progress">⏳ {counts.in_progress} {isZh ? '进行中' : 'in progress'}</span>
          )}
          {counts.pending > 0 && (
            <span className="todos-count pending">○ {counts.pending} {isZh ? '待办' : 'pending'}</span>
          )}
          {counts.cancelled > 0 && (
            <span className="todos-count cancelled">✗ {counts.cancelled} {isZh ? '已放弃' : 'cancelled'}</span>
          )}
        </span>
      </div>
      <ChatTodoChecklist todos={todos} />
    </div>
  );
}

function ChatTodoChecklist({ todos }: { todos: TodoItem[] }) {
  return (
    <ul className="todo-checklist">
      {todos.map((t, i) => {
        const status = t.status || 'pending';
        return (
          <li key={i} className={`todo-item todo-${status}`}>
            <span className="todo-checkbox" aria-label={status}>
              {status === 'completed' ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
              ) : status === 'in_progress' ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="6" /></svg>
              ) : status === 'cancelled' ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /></svg>
              )}
            </span>
            <span className="todo-content">{t.content}</span>
          </li>
        );
      })}
    </ul>
  );
}

// ─── WebSearchBlock ──────────────────────────────────────────────────────────

export function ChatWebSearchBlock({ block, locale }: { block: ToolBlockData; locale: string }) {
  const [open, setOpen] = useState(false);
  const isZh = locale === 'zh';
  const query: string = block.args?.query ?? block.args?.q ?? block.args?.url ?? '';

  type SearchResult = { title?: string; url?: string; snippet?: string; domain?: string };
  let results: SearchResult[] | null = null;
  if (block.summary) {
    try {
      const parsed = JSON.parse(block.summary);
      if (Array.isArray(parsed)) results = parsed;
    } catch { /* not JSON */ }
  }

  const isRunning = block.status === 'running';
  const isError = block.status === 'error';
  const headerLabel = isRunning
    ? (isZh ? '正在搜索网络...' : 'Searching the web...')
    : isError
      ? (isZh ? '搜索失败' : 'Search failed')
      : (isZh ? '已搜索网络' : 'Searched the web');

  const getDomain = (url?: string) => {
    if (!url) return '';
    try { return new URL(url).hostname.replace('www.', ''); } catch { return url; }
  };

  return (
    <div className="web-search-block">
      <button className="web-search-header" onClick={() => setOpen(o => !o)}>
        <span className="web-search-header-icon" aria-hidden>
          {isRunning ? (
            <span className="inline-block-spinner" style={{ color: '#3b82f6' }} />
          ) : isError ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2.5" strokeLinecap="round">
              <circle cx="12" cy="12" r="9" /><line x1="12" y1="8" x2="12" y2="12" /><circle cx="12" cy="16" r="0.5" fill="#dc2626" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 3c-2.5 3-4 5.5-4 9s1.5 6 4 9M12 3c2.5 3 4 5.5 4 9s-1.5 6-4 9M3 12h18" />
            </svg>
          )}
        </span>
        <span className="web-search-header-label">{headerLabel}</span>
        {results && (
          <span className="web-search-count-badge">{results.length} {isZh ? '条结果' : 'results'}</span>
        )}
        <span className="web-search-chevron" data-open={open}>▾</span>
      </button>
      {open && (
        <div className="web-search-body">
          {query && (
            <div className="web-search-query-row">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <span className="web-search-query-text">{query}</span>
            </div>
          )}
          {results ? (
            <div className="web-search-results-list">
              {results.map((r, i) => (
                <div key={i} className="web-search-result-item">
                  <div className="web-search-favicon">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 3c-2 3-3 5.5-3 9s1 6 3 9M12 3c2 3 3 5.5 3 9s-1 6-3 9M3 12h18" />
                    </svg>
                  </div>
                  <div className="web-search-result-info">
                    <div className="web-search-result-title">{r.title || r.url}</div>
                    <div className="web-search-result-domain">{getDomain(r.url)}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : block.summary ? (
            <div className="web-search-raw">{block.summary}</div>
          ) : block.error ? (
            <div className="web-search-raw" style={{ color: '#dc2626' }}>{block.error}</div>
          ) : null}
        </div>
      )}
    </div>
  );
}
