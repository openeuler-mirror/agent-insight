'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Editor } from '@monaco-editor/react';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { useLocale } from '@/lib/client/locale-context';
import { useAuth } from '@/lib/auth/auth-context';
import ReactMarkdown from 'react-markdown';
import { MarkdownText } from '@/components/thread/markdown-text';
import remarkGfm from 'remark-gfm';
import { findSkillMd, findSkillMdPath } from '@/lib/skill-generator/skill-files';
import { ALLOWED_EXT_ACCEPT, ALLOWED_EXT_GROUPS } from '@/lib/skill-generator/file-types';
import { Term } from '@/components/text/Term';

const UPLOAD_GROUP_LABELS: Record<'zh' | 'en', Record<string, string>> = {
    zh: { documents: '文档', data: '数据', code: '代码', config: '配置', logs: '日志' },
    en: { documents: 'Documents', data: 'Data', code: 'Code', config: 'Config', logs: 'Logs' },
};
import './skill-generator.css';

interface FileData {
    content: string[];
    created_at: string;
    modified_at: string;
    // index signature 让 FileData 能传给 PlaygroundFileLike(也带 [k: string]: unknown)
    // 这是 vfs 文件元数据,本来就是开放结构,加上不影响已知字段类型
    [k: string]: unknown;
}

type FilesState = Record<string, FileData>;

/**
 * A single rendered block inside an agent message.
 *
 * Why blocks (instead of one big markdown string):
 * - thinking / tool calls are real-time event streams with structured fields
 *   (status, args, result), not document fragments — they shouldn't be
 *   serialized into markdown and re-parsed.
 * - The order of arrival defines the rendering order, so we just append.
 *
 * Backwards compatibility: agent messages from the DB only have `content`
 * (no blocks). Render logic falls back to `content` when `blocks` is empty.
 */
type Block =
    | { kind: 'text'; id: string; text: string }
    | { kind: 'thinking'; id: string; text: string; done: boolean }
    | {
          kind: 'tool';
          id: string;
          name: string;
          args: any;
          status: 'running' | 'ok' | 'error';
          summary?: string;
          error?: string;
      }
    | {
          kind: 'download';
          id: string;
          skillName: string;
          fileCount: number;
          sizeBytes?: number;
      }
    | {
          // agent 问用户的问题；'pending' 时渲染为答题输入，用户提交后变为 'answered'。
          kind: 'question';
          id: string;          // pending request id（提交时 POST 给 /api/agent/respond）
          question: string;    // 拼合后的问题文本（兼容老数据 / 单问题场景）
          // opencode QuestionInfo[]——每条独立渲染：question/header/options/multiple/custom。
          // 提交时按 string[][] 形态回传 opencode（每个 question 一组答案）。
          choices?: QuestionInfo[];
          status: 'pending' | 'answered' | 'skipped';
          answer?: string;     // 用户提交的答复摘要（answered 后填，仅用于已答状态展示）
      };

interface QuestionInfo {
    question: string;
    header?: string;
    options?: { label: string; description?: string }[];
    multiple?: boolean;
    custom?: boolean;
}

interface Message {
    role: 'user' | 'agent';
    content: string;
    blocks?: Block[];
    isStreaming?: boolean;
}

interface Session {
    id: string;
    title: string;
    messages: Message[];
    files: FilesState;
    updatedAt: string | number;
}

function formatBytes(n: number): string {
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

type SkillFrontmatter = {
    name?: string;
    description?: string;
    body: string;
    // 源码里被 frontmatter 块占掉的行数——ReactMarkdown 只渲染 body，所以从
    // body DOM 反查出的 data-line-* 行号要加上这个偏移才能对回原 SKILL.md。
    lineOffset: number;
};

// SKILL.md 顶部固定是 `---\nname: ...\ndescription: ...\n---`，ReactMarkdown 不带
// frontmatter 插件时会把它渲染成 hr + setext-h2 + hr 三件套（YAML 体被吃成大标题），
// 视觉上很糟。这里手动剥出 name/description，把 body 交给 ReactMarkdown 渲染，
// 上方用 skill-frontmatter-card 卡片单独呈现。
function parseSkillFrontmatter(content: string): SkillFrontmatter | null {
    if (!content.startsWith('---')) return null;
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!match) return null;
    const fm = match[1];
    return {
        name: extractYamlScalar(fm, 'name'),
        description: extractYamlScalar(fm, 'description'),
        body: content.slice(match[0].length),
        lineOffset: match[0].split('\n').length - 1,
    };
}

// 兼容三种 YAML 形态：
//   key: 单行值
//   key: "带引号的单行"
//   key: >        ← 折叠块标量（换行→空格）
//     续行 1
//     续行 2
//   key: |        ← 字面块标量（保留换行）
//     line 1
//     line 2
// 用整段 frontmatter 文本 + 字段名查询，找到匹配后处理续行收集。
function extractYamlScalar(fm: string, key: string): string | undefined {
    const lines = fm.split(/\r?\n/);
    const re = new RegExp(`^${key}:\\s*(.*)$`);
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(re);
        if (!m) continue;
        const raw = m[1].trim();
        if (raw === '>' || raw === '|' || raw === '') {
            const collected: string[] = [];
            for (let j = i + 1; j < lines.length; j++) {
                const next = lines[j];
                // 新的顶层 key（无缩进，以 `xxx:` 开头）终止收集；当前块结束。
                if (/^[A-Za-z_][\w-]*\s*:/.test(next)) break;
                collected.push(next.replace(/^\s+/, ''));
            }
            // 折叠：跳过空行用空格连接；字面：原样保留。
            if (raw === '|') return collected.join('\n').replace(/\s+$/, '');
            return collected.filter(s => s.length > 0).join(' ');
        }
        // 单行值：去掉两侧引号
        return raw.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    }
    return undefined;
}

export default function PlaygroundPage() {
    const { t, locale } = useLocale();
    const { user } = useAuth();
    const router = useRouter();
    
    // Multi-session states
    const [sessions, setSessions] = useState<Session[]>([]);
    const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
    
    // Current active states
    const [messages, setMessages] = useState<Message[]>([]);
    const [files, setFiles] = useState<FilesState>({});
    
    const [input, setInput] = useState('');
    const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    // 用户上传的参考资料：列表来自 /api/skill-generator/attachments，agent 端会在
    // <workspace>/uploads/ 下 read。chip 列表渲染在 chat-input 上方。
    const [attachments, setAttachments] = useState<Array<{
        name: string;
        size: number;
        relPath: string;
        textRelPath?: string;
        mime?: string;
    }>>([]);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    // 联网搜索（web_search MCP）开关——
    //   webSearchConfigured: 后端是否已配 Tavily key（决定 toggle 是否能启用）
    //   webSearchEnabled:    用户是否要让本次对话用——localStorage 持久化跨 session
    // 设计上：未配 key 时 toggle 灰显并 tooltip 引导去 Model Registry 配置；
    // 配了 key 默认 ON，用户可关掉以节省搜索额度 / 加快响应。
    const [webSearchConfigured, setWebSearchConfigured] = useState(false);
    const [webSearchEnabled, setWebSearchEnabled] = useState<boolean>(() => {
        if (typeof window === 'undefined') return true;
        const v = window.localStorage.getItem('pg.webSearchEnabled');
        return v == null ? true : v === '1';
    });
    useEffect(() => {
        if (typeof window !== 'undefined') {
            window.localStorage.setItem('pg.webSearchEnabled', webSearchEnabled ? '1' : '0');
        }
    }, [webSearchEnabled]);
    const [showIDE, setShowIDE] = useState(false);
    const [isHistoryOpen, setIsHistoryOpen] = useState(false);
    const historyDropdownRef = useRef<HTMLDivElement>(null);

    // 历史对话下拉：点击 wrapper 外部关闭。pointerdown 比 click 更准——避免被
    // 内部 button onClick 的 stopPropagation 干扰，也避免拖动选择文本时误触。
    useEffect(() => {
        if (!isHistoryOpen) return;
        const onPointerDown = (e: PointerEvent) => {
            if (!historyDropdownRef.current) return;
            if (!historyDropdownRef.current.contains(e.target as Node)) {
                setIsHistoryOpen(false);
            }
        };
        document.addEventListener('pointerdown', onPointerDown);
        return () => document.removeEventListener('pointerdown', onPointerDown);
    }, [isHistoryOpen]);

    const [configs, setConfigs] = useState<any[]>([]);
    const [selectedModelId, setSelectedModelId] = useState<string>('');
    const [selectedScenario, setSelectedScenario] = useState<string>('general');
    // chat 面板窄于这个像素时，模型/场景/联网三件套折叠成"更多"下拉。
    // inline 三件套（模型 select + 场景 select + 联网按钮 + 分隔线 + clear，gap×4）
    // 实测最少要 ~440px 才不挤；定 460 留一点呼吸位，避免临界宽度时
    // "联网搜索" 已经被裁边但还没折叠。
    const CONTROLS_COLLAPSE_THRESHOLD = 460;
    // 拖拽过程中只用 CSS 变量驱动宽度（避免每帧 setState 重渲染整棵 Playground），
    // 所以 chatPanelWidth state 直到松手才更新。但折叠状态必须在拖动过程中实时切，
    // 否则用户拖窄了"联网搜索"已经溢出还没折叠。
    // 拆出独立 state，drag 中**仅在跨越阈值时**调用 setState——一次 drag 最多
    // 一两次 re-render，性能可忽略；与 chatPanelWidth state 通过下面的 effect 同步。
    const [isControlsCollapsed, setIsControlsCollapsed] = useState(false);
    const [isControlsOpen, setIsControlsOpen] = useState(false);
    // popover 自适应方向：开启时按当前按钮在视口里的位置决定向上还是向下弹。
    // chat-controls 在 chat-input 上方——当 chatInputHeight 拉高 / 视口短时，按钮
    // 离底很近，向下弹直接被视口下沿切掉；这种场景翻转向上弹。
    const [popoverPlacement, setPopoverPlacement] = useState<'bottom' | 'top'>('bottom');
    const controlsMoreRef = useRef<HTMLDivElement | null>(null);
    const controlsMoreBtnRef = useRef<HTMLButtonElement | null>(null);
    /** popover 撑开后的目标高度（max-height）。CSS 同步成同值，保持判定与渲染一致。 */
    const POPOVER_MAX_HEIGHT = 320;
    /** 开闭 popover——开启时计算 placement，避免被视口下沿剪裁 */
    const toggleControlsOpen = () => {
        if (isControlsOpen) {
            setIsControlsOpen(false);
            return;
        }
        const btn = controlsMoreBtnRef.current;
        if (btn) {
            const rect = btn.getBoundingClientRect();
            const spaceBelow = window.innerHeight - rect.bottom;
            const spaceAbove = rect.top;
            // 下方放得下 popover 完整高度（含 6px 间距）→ 向下；否则比一下哪边大
            const wantTop = spaceBelow < POPOVER_MAX_HEIGHT + 12 && spaceAbove > spaceBelow;
            setPopoverPlacement(wantTop ? 'top' : 'bottom');
        }
        setIsControlsOpen(true);
    };
    useEffect(() => {
        if (!isControlsOpen) return;
        const onPointerDown = (e: PointerEvent) => {
            if (controlsMoreRef.current && !controlsMoreRef.current.contains(e.target as Node)) {
                setIsControlsOpen(false);
            }
        };
        document.addEventListener('pointerdown', onPointerDown);
        return () => document.removeEventListener('pointerdown', onPointerDown);
    }, [isControlsOpen]);

    const [isEditingTitle, setIsEditingTitle] = useState(false);
    const [titleInput, setTitleInput] = useState('');

    const [isPublishing, setIsPublishing] = useState(false);
    const [publishToast, setPublishToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

    // Open editor tabs — ordered list of file paths currently open. Active
    // tab === activeFilePath. Reset on session switch.
    const [openTabs, setOpenTabs] = useState<string[]>([]);

    // 标记当前 .md 文件是否处于"编辑模式"。默认 false（预览）。切换文件 / session
    // 时重置，避免预览/编辑状态在不相干的文件之间串。
    const [mdEditMode, setMdEditMode] = useState<Record<string, boolean>>({});
    // 仅当用户**手动**改动过 files 时才触发自动保存——agent 流式写入也会改 files，
    // 但那一路服务端会自己落库，前端再 PATCH 一遍只会和流式状态打架。
    const filesDirtyRef = useRef(false);
    // chat-input 现在是 contenteditable div（不是 textarea）——这样 chip 才能 inline
    // 落在光标处，用户可以围绕 chip 写自然语言。ref 拿 div 焦点 + 插入 chip 用。
    const chatInputRef = useRef<HTMLDivElement | null>(null);

    // 选区浮窗状态——挂在页面级，preview / Monaco 两条来源共用一套渲染：
    //  - preview：editor-body 的 mouseup 监听算位置；
    //  - Monaco：编辑器 onMouseUp + getScrolledVisiblePosition 算位置。
    // lineStart/lineEnd（1-based）：拿到就用"引用 file 第 N-M 行"格式塞给模型；
    // 拿不到（罕见）才回落到原文 quote。这样塞给模型的提示更紧凑，agent 也能
    // 直接 read 回那段 VFS。
    const editorBodyRef = useRef<HTMLDivElement | null>(null);
    type SelectionInfo = {
        x: number;
        y: number;
        text: string;
        lineStart?: number;
        lineEnd?: number;
    };
    const [selectionBubble, setSelectionBubble] = useState<SelectionInfo | null>(null);

    // 引用 chip：用户点"加入对话"后在 chat-input（contenteditable）当前光标位置
    // 落一个 inline span，可以围绕它写"把 [chip A] 改成 X，再把 [chip B] 改成 Y"
    // 这种自然语言指令。chip 自带 data-chip-id，元数据存在下方 Map 里。
    //
    // 发送时序列化：chip 替换成 `[引用 N]`，下面追加一份带"原文片段"的引用清单——
    // 这样即使前面的修改让后面 chip 的行号漂了，agent 还能用 anchor 文本 grep 定位。
    type ChatReference = {
        id: string;
        fileName: string;
        text: string;
        lineStart?: number;
        lineEnd?: number;
    };
    const referencesRef = useRef<Map<string, ChatReference>>(new Map());
    // 仅用于触发"发送按钮 disabled 是否更新"的 re-render——contenteditable 真值
    // 在 referencesRef + chatInputRef.current.textContent 里，state 只是占位。
    const [chipCount, setChipCount] = useState(0);
    // 跟踪 chat-input 里**最近一次**的 cursor/selection 位置。用户点编辑器选区
    // 浮窗"加入对话"时，焦点已经离开 chat-input，单纯 editor.focus() 浏览器恢复
    // cursor 的行为不稳定（实测会落到开头），导致后插的 chip 跑到最前面。
    // 这里在每次 chat-input 内的 selection 变化时把 Range 存下来，插 chip 时
    // 优先按这个位置走。
    const lastChatRangeRef = useRef<Range | null>(null);

    const openFileInTab = (path: string) => {
        setOpenTabs(prev => prev.includes(path) ? prev : [...prev, path]);
        setActiveFilePath(path);
        setShowIDE(true);
    };

    // 顶栏"预览"按钮：手动开关右侧 IDE 预览面板。
    // 关闭态 + 已有文件 + 没有活动 tab → 默认打开 SKILL.md 或第一个文件，
    // 避免把空壳面板甩给用户。已有活动 tab 时只切 showIDE，保留之前的浏览位置。
    const togglePreview = () => {
        if (showIDE) {
            setShowIDE(false);
            return;
        }
        if (Object.keys(files).length === 0) return;
        if (activeFilePath && files[activeFilePath]) {
            setShowIDE(true);
            return;
        }
        const fallback = findSkillMdPath(files) ?? Object.keys(files)[0];
        openFileInTab(fallback);
    };

    const closeTab = (path: string) => {
        setOpenTabs(prev => {
            const next = prev.filter(p => p !== path);
            if (activeFilePath === path) {
                const idx = prev.indexOf(path);
                const fallback = next[idx] ?? next[idx - 1] ?? null;
                setActiveFilePath(fallback);
                if (next.length === 0) setShowIDE(false);
            }
            return next;
        });
    };

    // Track which file-tree folders the user has collapsed. Default open
    // (empty set) so freshly-generated files are visible without an extra
    // click. Per-session in-memory state — not worth persisting since the
    // categories are small and known.
    const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
    const toggleFolder = (cat: string) => setCollapsedFolders(prev => {
        const next = new Set(prev);
        if (next.has(cat)) next.delete(cat); else next.add(cat);
        return next;
    });

    // Resizable panel widths (px). Persisted to localStorage so layout
    // sticks across reloads. localStorage (not server DB) because window
    // sizing is per-device — syncing to server would make sizes jump when
    // switching between desktop / laptop. Bounds enforced in startResize.
    //
    // 实现要点：拖拽时**不**走 React state，否则每帧 setState 会让
    // 整棵 PlaygroundPage（含 Monaco / ReactMarkdown / 文件树）重渲染，再叠加
    // chat-panel 上的 transition: all 0.4s 与 localStorage 同步写盘，体感就是
    // "缓慢卡顿"。改成：pointermove 直接改 CSS 变量（--pg-chat-w / --pg-tree-w），
    // pointerup 一次性 commit 到 state（驱动 localStorage + 兜底确保后续
    // re-render 的 width 与拖拽结束态一致）。
    const LAYOUT_KEY = 'playground:layout:v1';
    // 默认 480 是为了能放下 inline 三件套（模型/场景/联网搜索 + clear），
    // 与上面的 CONTROLS_COLLAPSE_THRESHOLD=460 之间留 20px 呼吸位——
    // 用户随手轻微缩窄不会立刻触发折叠。
    const [chatPanelWidth, setChatPanelWidth] = useState(480);
    const [fileTreeWidth, setFileTreeWidth] = useState(240);
    // 输入框高度——驱动 .chat-input-rich 的 height。拖拽条在模型/场景控件**上方**，
    // 向上拖即增大。默认 60px，跟 placeholder 大致一致，留出能放 chip 的余地。
    const [chatInputHeight, setChatInputHeight] = useState(80);
    const containerRef = useRef<HTMLDivElement | null>(null);

    // Hydrate from localStorage once on mount. SSR-safe: the read is gated
    // by `typeof window` so it never runs during prerender.
    useEffect(() => {
        if (typeof window === 'undefined') return;
        try {
            const raw = localStorage.getItem(LAYOUT_KEY);
            if (!raw) return;
            const saved = JSON.parse(raw);
            if (typeof saved.chatPanelWidth === 'number') setChatPanelWidth(saved.chatPanelWidth);
            if (typeof saved.fileTreeWidth === 'number') setFileTreeWidth(saved.fileTreeWidth);
            if (typeof saved.chatInputHeight === 'number') setChatInputHeight(saved.chatInputHeight);
        } catch { /* corrupt entry — ignore and use defaults */ }
    }, []);

    // 把 state → CSS 变量（mount + drag-end commit 时各跑一次，频率极低）。
    // 写在 :root 上而不是 container 上，是为了让 hydration 之前的 SSR HTML
    // 也能拿到默认值（避免首屏 width 跳动）。
    useEffect(() => {
        if (typeof window === 'undefined') return;
        document.documentElement.style.setProperty('--pg-chat-w', `${chatPanelWidth}px`);
        document.documentElement.style.setProperty('--pg-tree-w', `${fileTreeWidth}px`);
        document.documentElement.style.setProperty('--pg-chat-input-h', `${chatInputHeight}px`);
    }, [chatPanelWidth, fileTreeWidth, chatInputHeight]);

    // chatPanelWidth 与 isControlsCollapsed 的兜底同步——drag 中已经在 onMove 里
    // 跨阈值时实时切了；这个 effect 覆盖另外两条路径：mount/hydrate（localStorage 恢复
    // 了一个值）、外部 setChatPanelWidth（pointerup commit）。
    useEffect(() => {
        setIsControlsCollapsed(chatPanelWidth < CONTROLS_COLLAPSE_THRESHOLD);
    }, [chatPanelWidth]);

    // 持久化只在 state 变时跑（即 mount 或 pointerup commit 时），不再每帧写盘。
    useEffect(() => {
        if (typeof window === 'undefined') return;
        try {
            localStorage.setItem(LAYOUT_KEY, JSON.stringify({ chatPanelWidth, fileTreeWidth, chatInputHeight }));
        } catch { /* quota exceeded / disabled — silently skip */ }
    }, [chatPanelWidth, fileTreeWidth, chatInputHeight]);

    /**
     * Generic resizer. delta sign convention:
     *  - 'chat': dragging right grows chat panel (horizontal)
     *  - 'tree': dragging right grows file tree (horizontal)
     *  - 'chat-input': dragging up grows chat input (vertical, 反方向)
     *
     * 不在 onMove 里 setState：直接改 CSS 变量，DOM 由浏览器一步到位 reflow，
     * React 全程不参与；松手时再 commit 一次 state（持久化 + 兜底）。
     */
    const startResize = (kind: 'chat' | 'tree' | 'chat-input', e: React.PointerEvent) => {
        e.preventDefault();
        const vertical = kind === 'chat-input';
        const startCoord = vertical ? e.clientY : e.clientX;
        const startSize = kind === 'chat'
            ? chatPanelWidth
            : kind === 'tree'
                ? fileTreeWidth
                : chatInputHeight;
        const setter = kind === 'chat'
            ? setChatPanelWidth
            : kind === 'tree'
                ? setFileTreeWidth
                : setChatInputHeight;
        const cssVar = kind === 'chat'
            ? '--pg-chat-w'
            : kind === 'tree'
                ? '--pg-tree-w'
                : '--pg-chat-input-h';
        const min = kind === 'chat' ? 280 : kind === 'tree' ? 160 : 60;
        const max = kind === 'chat' ? 800 : kind === 'tree' ? 480 : 400;
        const root = document.documentElement;
        const container = containerRef.current;

        document.body.style.cursor = vertical ? 'ns-resize' : 'col-resize';
        document.body.style.userSelect = 'none';
        if (container) container.classList.add('dragging');

        let latestSize = startSize;
        let rafId = 0;
        const apply = () => {
            rafId = 0;
            root.style.setProperty(cssVar, `${latestSize}px`);
        };
        const onMove = (ev: PointerEvent) => {
            const coord = vertical ? ev.clientY : ev.clientX;
            // 横向：dx 增 → 宽度增；纵向 chat-input：dy **减**（向上拖）→ 高度增
            const delta = vertical ? (startCoord - coord) : (coord - startCoord);
            latestSize = Math.max(min, Math.min(max, startSize + delta));
            if (!rafId) rafId = requestAnimationFrame(apply);
            // 拖 chat panel 时实时切折叠状态——只在跨阈值时 setState，
            // 一次拖动最多 1~2 次 re-render，不会拖累拖拽帧率。
            if (kind === 'chat') {
                const shouldCollapse = latestSize < CONTROLS_COLLAPSE_THRESHOLD;
                setIsControlsCollapsed(prev => prev === shouldCollapse ? prev : shouldCollapse);
            }
        };
        const onUp = () => {
            if (rafId) { cancelAnimationFrame(rafId); apply(); }
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            if (container) container.classList.remove('dragging');
            if (latestSize !== startSize) setter(latestSize);
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
    };

    const currentSession = useMemo(() => sessions.find(s => s.id === currentSessionId), [sessions, currentSessionId]);

    useEffect(() => {
        if (!user) return;
        fetch(`/api/skill-generator/sessions?user=${encodeURIComponent(user)}`)
            .then(res => res.json())
            .then(data => {
                if (data.sessions) {
                    setSessions(data.sessions.map((s: any) => ({
                        ...s,
                        files: typeof s.files === 'string' ? JSON.parse(s.files) : s.files
                    })));
                    if (data.sessions.length > 0) {
                        switchSession(data.sessions[0].id);
                    } else {
                        handleNewChat();
                    }
                } else {
                    handleNewChat();
                }
            })
            .catch(err => {
                console.error("Failed to load sessions", err);
                handleNewChat();
            });
    }, [user]);

    // Autosave VFS changes (though now it's read-only, we might still want this for agent updates)
    useEffect(() => {
        if (!currentSessionId || isLoading) return;
        // The agent API now handles saving the final state.
        // We only update the title locally if needed.
    }, [messages, files]);

    // 切 session → 拉一份当前会话的附件列表。
    // 附件存在 workspace/uploads/，跟着 session 走，前端只是一个映射展示。
    useEffect(() => {
        if (!user || !currentSessionId) {
            setAttachments([]);
            return;
        }
        const ctrl = new AbortController();
        fetch(
            `/api/skill-generator/attachments?user=${encodeURIComponent(user)}&threadId=${encodeURIComponent(currentSessionId)}`,
            { signal: ctrl.signal },
        )
            .then(r => r.ok ? r.json() : { items: [] })
            .then(d => setAttachments(d.items || []))
            .catch(() => { /* aborted or net error: keep last list */ });
        return () => ctrl.abort();
    }, [user, currentSessionId]);

    const handleUploadFiles = async (fileList: FileList | null) => {
        if (!fileList || fileList.length === 0 || !user || !currentSessionId) return;
        setUploadError(null);
        setIsUploading(true);
        try {
            const fd = new FormData();
            fd.append('user', user);
            fd.append('threadId', currentSessionId);
            for (const f of Array.from(fileList)) fd.append('files', f);
            const res = await fetch('/api/skill-generator/attachments', { method: 'POST', body: fd });
            const data = await res.json();
            if (!res.ok) {
                setUploadError(data.error || '上传失败');
                return;
            }
            setAttachments(data.items || []);
            if (Array.isArray(data.errors) && data.errors.length > 0) {
                setUploadError(data.errors.map((e: any) => `${e.name}: ${e.reason}`).join('；'));
            }
        } catch (err: any) {
            setUploadError(err?.message || '上传失败');
        } finally {
            setIsUploading(false);
            // 清空 input 以便重复上传同名文件能触发 change
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    const handleRemoveAttachment = async (name: string) => {
        if (!user || !currentSessionId) return;
        try {
            const res = await fetch(
                `/api/skill-generator/attachments?user=${encodeURIComponent(user)}&threadId=${encodeURIComponent(currentSessionId)}&name=${encodeURIComponent(name)}`,
                { method: 'DELETE' },
            );
            const data = await res.json();
            if (res.ok) setAttachments(data.items || []);
        } catch { /* 静默：删除失败时下次切回会重拉 */ }
    };

    useEffect(() => {
        if (!user) return;
        fetch(`/api/settings?user=${encodeURIComponent(user)}`)
            .then(res => res.json())
            .then(data => {
                if (data.configs) {
                    setConfigs(data.configs);
                    if (data.activeConfigId) setSelectedModelId(data.activeConfigId);
                    else if (data.configs.length > 0) setSelectedModelId(data.configs[0].id);
                }
                // Tavily key 配过没——决定联网搜索 toggle 是否能启用
                setWebSearchConfigured(data.searchProvider === 'tavily' && !!data.searchApiKey);
            });
    }, [user]);

    /**
     * Convert Prisma-shaped messages (where blocks is a JSON string from
     * SQLite TEXT) into the in-memory Message shape the UI expects (blocks
     * is Block[]). Used in every path that sets `messages` from server data —
     * keep all hydration in one place so a future schema tweak is one edit.
     */
    const hydrateMessages = (rawMessages: any[]): Message[] => {
        return (rawMessages || []).map((m: any) => {
            let blocks: Block[] | undefined;
            if (m.role === 'agent' && typeof m.blocks === 'string' && m.blocks.length > 2) {
                try {
                    const parsed = JSON.parse(m.blocks);
                    if (Array.isArray(parsed) && parsed.length > 0) blocks = parsed;
                } catch { /* legacy fallback engages on render */ }
            }
            return { role: m.role, content: m.content, blocks };
        });
    };

    const handleNewChat = async () => {
        if (!user) return;
        const initialMsg = { role: 'agent', content: locale === 'zh' ? '你好！我是 Skills 生成助手。请告诉我你想生成什么样的 Skill？' : 'Hello! I am a Skills generation assistant. What would you like to generate?' };
        
        try {
            const res = await fetch('/api/skill-generator/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user, title: 'New Chat', files: {}, messages: [initialMsg] })
            });
            const data = await res.json();
            if (data.session) {
                const newSession = { ...data.session, files: {} };
                setSessions(prev => [newSession, ...prev]);
                setCurrentSessionId(newSession.id);
                setMessages(hydrateMessages(newSession.messages));
                setFiles({});
                setActiveFilePath(null);
                setOpenTabs([]);
                setShowIDE(false);
            }
        } catch (e) {
            console.error("Failed to create session", e);
        }
        setIsHistoryOpen(false);
    };

    const switchSession = async (id: string) => {
        try {
            const res = await fetch(`/api/skill-generator/sessions/${id}`);
            const data = await res.json();
            if (data.session) {
                const s = data.session;
                setCurrentSessionId(s.id);
                // Hydrate stored `blocks` JSON back into structured Block[] so
                // thinking / tool / download UI reappears on reload. Falls back
                // to text-only rendering for legacy messages without blocks.
                setMessages(hydrateMessages(s.messages));
                const fileMap = typeof s.files === 'string' ? JSON.parse(s.files) : s.files;
                setFiles(fileMap);
                setActiveFilePath(null);
                setOpenTabs([]);
                // Auto-open IDE when the session has files — otherwise refreshing
                // a finished generation hides the preview pane until the user
                // clicks something, which feels like data loss.
                setShowIDE(Object.keys(fileMap || {}).length > 0);
            }
        } catch (e) {
            console.error("Failed to switch session", e);
        }
        setIsHistoryOpen(false);
    };

    const deleteSession = async (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        try {
            await fetch(`/api/skill-generator/sessions/${id}`, { method: 'DELETE' });
            const next = sessions.filter(s => s.id !== id);
            setSessions(next);
            if (currentSessionId === id) {
                if (next.length > 0) switchSession(next[0].id);
                else handleNewChat();
            }
        } catch (e) {
            console.error("Failed to delete session", e);
        }
    };

    const handleUpdateTitle = async () => {
        if (!currentSessionId || !titleInput.trim()) {
            setIsEditingTitle(false);
            return;
        }
        try {
            const res = await fetch(`/api/skill-generator/sessions/${currentSessionId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: titleInput.trim() })
            });
            const data = await res.json();
            if (data.session) {
                setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, title: data.session.title } : s));
            }
        } catch (e) {
            console.error("Failed to update title", e);
        }
        setIsEditingTitle(false);
    };

    const chatEndRef = useRef<HTMLDivElement>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

    const handleSendMessage = async () => {
        if (isLoading || !user || !currentSessionId) return;
        // 从 contenteditable 走序列化，而不是看 input state——chip 是 DOM 节点，
        // textContent 也不包含 chip 的元信息。允许"只有 chip 没文字"也能发。
        const { body, chipsUsed } = serializeRichInput();
        if (!body && chipsUsed.length === 0) return;
        const userMsg = composeFinalMessage(body, chipsUsed);

        // 清空 contenteditable + 元数据缓存
        if (chatInputRef.current) chatInputRef.current.innerHTML = '';
        referencesRef.current.clear();
        setInput('');
        setChipCount(0);

        setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
        setIsLoading(true);
        setMessages(prev => [...prev, { role: 'agent', content: '', blocks: [], isStreaming: true }]);

        // Mutate the streaming agent message; helper hides immutable-copy boilerplate
        // so each event handler can stay focused on its own state shape.
        const patchLast = (mutator: (msg: Message) => void) => {
            setMessages(prev => {
                const next = [...prev];
                const last = { ...next[next.length - 1] };
                last.blocks = last.blocks ? [...last.blocks] : [];
                mutator(last);
                next[next.length - 1] = last;
                return next;
            });
        };

        try {
            const controller = new AbortController();
            abortControllerRef.current = controller;
            const response = await fetch('/api/skill-generator/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: userMsg, user, threadId: currentSessionId, files, modelId: selectedModelId, scenario: selectedScenario, webSearchEnabled: webSearchConfigured && webSearchEnabled, mock: false }),
                signal: controller.signal,
            });
            if (!response.ok) throw new Error('Failed');
            const reader = response.body?.getReader();
            if (!reader) throw new Error('No reader');
            const decoder = new TextDecoder();
        let agentContent = '';
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                let data: any;
                try { data = JSON.parse(line.slice(6)); } catch (e) {
                    console.error('Failed to parse SSE JSON:', e);
                    continue;
                }

                if (data.mode === 'text') {
                    const delta = data.payload as string;
                    agentContent += delta;
                    patchLast(msg => {
                        msg.content = agentContent;
                        // Coalesce consecutive text deltas into the trailing text block.
                        // CRITICAL: replace the tail object with a new one — do NOT
                        // mutate the existing block. React 19 StrictMode in dev
                        // invokes this reducer twice; mutation would compound and
                        // every token would visibly double in the rendered text.
                        const tailIdx = msg.blocks!.length - 1;
                        const tail = msg.blocks![tailIdx];
                        if (tail && tail.kind === 'text') {
                            msg.blocks![tailIdx] = { ...tail, text: tail.text + delta };
                        } else {
                            msg.blocks!.push({ kind: 'text', id: `text_${msg.blocks!.length}`, text: delta });
                        }
                    });
                } else if (data.mode === 'thinking') {
                    const { id, delta, done: thinkDone } = data.payload || {};
                    if (!id) continue;
                    patchLast(msg => {
                        const idx = msg.blocks!.findIndex(b => b.kind === 'thinking' && b.id === id);
                        if (idx === -1) {
                            msg.blocks!.push({ kind: 'thinking', id, text: delta || '', done: !!thinkDone });
                        } else {
                            const blk = { ...msg.blocks![idx] } as Extract<Block, { kind: 'thinking' }>;
                            if (delta) blk.text += delta;
                            if (thinkDone) blk.done = true;
                            msg.blocks![idx] = blk;
                        }
                    });
                } else if (data.mode === 'tool_call') {
                    const { id, name, args, status } = data.payload || {};
                    if (!id) continue;
                    patchLast(msg => {
                        msg.blocks!.push({ kind: 'tool', id, name, args, status: status || 'running' });
                    });
                } else if (data.mode === 'tool_result') {
                    const { id, status, summary, error, finalArgs } = data.payload || {};
                    if (!id) continue;
                    patchLast(msg => {
                        const idx = msg.blocks!.findIndex(b => b.kind === 'tool' && b.id === id);
                        if (idx === -1) return;
                        const blk = { ...msg.blocks![idx] } as Extract<Block, { kind: 'tool' }>;
                        blk.status = status || 'ok';
                        if (summary) blk.summary = summary;
                        if (error) blk.error = error;
                        // bridge 在 end phase 把最新 input 一起带过来——start phase 时 args
                        // 几乎肯定是空 {}，等 LLM 编完才有完整数据。这里覆盖让 TodoBlock /
                        // 跳转按钮 / write content 渲染能拿到真实参数。
                        if (finalArgs && typeof finalArgs === 'object') {
                            blk.args = finalArgs;
                        }
                        msg.blocks![idx] = blk;
                    });
                } else if (data.mode === 'vfs_patch') {
                    const incoming = data.payload?.files;
                    if (incoming) {
                        setFiles(incoming);
                        // 只有真的有文件时才展开 IDE 面板。空 vfs_patch（agent 跑完但没写任何文件）
                        // 弹出空白编辑器只会让用户困惑——保持折叠，让对话气泡里的 thinking/tool
                        // 明确告诉用户"啥也没生成"。
                        if (Object.keys(incoming).length > 0) {
                            setShowIDE(true);
                        }
                    }
                } else if (data.mode === 'download') {
                    const { id, skillName, fileCount, sizeBytes } = data.payload || {};
                    if (!id) continue;
                    patchLast(msg => {
                        msg.blocks!.push({ kind: 'download', id, skillName: skillName || 'skill', fileCount: fileCount || 0, sizeBytes });
                    });
                } else if (data.mode === 'question') {
                    // agent 问用户一个问题——渲染为可输入的答题块
                    const { id, question, choices } = data.payload || {};
                    if (!id) continue;
                    patchLast(msg => {
                        msg.blocks!.push({ kind: 'question', id, question: question || '', choices, status: 'pending' });
                    });
                } else if (data.mode === 'question_answered') {
                    // 答复已发回 agent / 超时 / 跳过——把对应 question 块状态改掉
                    const { id, status, answer } = data.payload || {};
                    if (!id) continue;
                    patchLast(msg => {
                        const idx = msg.blocks!.findIndex(b => b.kind === 'question' && b.id === id);
                        if (idx === -1) return;
                        const blk = { ...msg.blocks![idx] } as Extract<Block, { kind: 'question' }>;
                        blk.status = (status === 'answered' || status === 'skipped') ? status : blk.status;
                        if (answer !== undefined) blk.answer = answer;
                        msg.blocks![idx] = blk;
                    });
                } else if (data.mode === 'done') {
                    // streaming finished; isStreaming flag flipped in finally
                } else if (data.mode === 'error') {
                    patchLast(msg => { msg.content = `错误: ${data.payload}`; });
                }
            }
        }
        } catch (error: any) {
            if (error.name !== 'AbortError') {
                setMessages(prev => { const next = [...prev]; next[next.length - 1].content = `错误: ${error.message}`; return next; });
            }
        } finally {
            abortControllerRef.current = null;
            setIsLoading(false);
            setMessages(prev => { const next = [...prev]; if (next.length > 0) next[next.length - 1].isStreaming = false; return next; });
            // Refresh sessions list to show updated title/date
            fetch(`/api/skill-generator/sessions?user=${encodeURIComponent(user)}`)
                .then(res => res.json())
                .then(data => { if (data.sessions) setSessions(data.sessions.map((s: any) => ({ ...s, files: typeof s.files === 'string' ? JSON.parse(s.files) : s.files }))); });
        }
    };

    const handleStopStreaming = () => {
        abortControllerRef.current?.abort();
    };

    const categorizedFiles = useMemo(() => {
        const categories: Record<string, string[]> = { 'references': [], 'scripts': [], 'main': [] };
        Object.keys(files).forEach(path => {
            if (path.includes('/references/')) categories.references.push(path);
            else if (path.includes('/scripts/')) categories.scripts.push(path);
            else categories.main.push(path);
        });
        return categories;
    }, [files]);

    const activeFileContent = useMemo(() => {
        if (!activeFilePath || !files[activeFilePath]) return '';
        const content = files[activeFilePath].content;
        return Array.isArray(content) ? content.join('\n') : content;
    }, [activeFilePath, files]);

    const previewFrontmatter = useMemo(() => {
        if (!activeFilePath?.endsWith('.md')) return null;
        return parseSkillFrontmatter(activeFileContent);
    }, [activeFilePath, activeFileContent]);

    // 选区→@引用 链路读 data-line-* 时是 body 内行号；frontmatter 卡片是用源码顶部
    // 几行换的，要把这些行数补回去才能正确指向原 SKILL.md 的行。用 ref 而不是 dep，
    // 避免每次 frontmatter 变就重绑 mouseup/mousedown 监听。
    const previewLineOffsetRef = useRef(0);
    useEffect(() => {
        previewLineOffsetRef.current = previewFrontmatter?.lineOffset ?? 0;
    }, [previewFrontmatter]);

    // 编辑器/Monaco onChange 走这条统一入口：把字符串内容回写到 files state。
    // FileData.content 在 vfs_patch 里是 string[]（按行 split），保持同样形态，
    // 否则下次序列化/反序列化（PATCH → SQLite TEXT）会因为 type 漂移而出错。
    const handleFileContentChange = (path: string, newContent: string) => {
        setFiles(prev => {
            const prevFile = prev[path];
            if (!prevFile) return prev;
            const prevText = Array.isArray(prevFile.content)
                ? prevFile.content.join('\n')
                : (prevFile.content as unknown as string);
            if (prevText === newContent) return prev;
            filesDirtyRef.current = true;
            return {
                ...prev,
                [path]: {
                    ...prevFile,
                    content: newContent.split('\n'),
                    modified_at: new Date().toISOString(),
                },
            };
        });
    };

    // 用户手动改了文件后，去抖把整份 files 落库（PATCH /api/skill-generator/sessions/:id）。
    // 不在每次按键时就 PATCH，避免高频写库；流式生成中（isLoading）也不存，让
    // 服务端 chat 路由在结束时统一写一次。
    useEffect(() => {
        if (!currentSessionId || isLoading) return;
        if (!filesDirtyRef.current) return;
        const handle = setTimeout(() => {
            filesDirtyRef.current = false;
            fetch(`/api/skill-generator/sessions/${currentSessionId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ files }),
            }).catch(err => console.error('Autosave failed:', err));
        }, 800);
        return () => clearTimeout(handle);
    }, [files, isLoading, currentSessionId]);

    // 监听全局 selectionchange，只在选区落在 chat-input 内时把 Range 存下来。
    // 这样用户点编辑器选区浮窗时虽然焦点跳走、selection 也变了，但 ref 里仍是
    // chat-input 内**最后一次**的位置——insertChipInline 拿这个去 restore。
    useEffect(() => {
        const onSelChange = () => {
            const editor = chatInputRef.current;
            if (!editor) return;
            const sel = document.getSelection();
            if (!sel || sel.rangeCount === 0) return;
            const range = sel.getRangeAt(0);
            const anchor = range.startContainer;
            if (editor.contains(anchor)) {
                lastChatRangeRef.current = range.cloneRange();
            }
        };
        document.addEventListener('selectionchange', onSelChange);
        return () => document.removeEventListener('selectionchange', onSelChange);
    }, []);

    // editor-body 内监听 mouseup：用户**松开鼠标**时才检查选区，避免拉框过程里
    // 浮窗一直跟着选区抖。mousedown 则清掉浮窗——开始新一轮选择，旧 bubble 不留。
    // 这两个 listener 都绑在 editor-body 而非 document：限定作用域，浮窗只对编辑器
    // 选区生效，不会被对话区域的选择干扰。
    useEffect(() => {
        const container = editorBodyRef.current;
        if (!container) return;

        const onMouseUp = (e: MouseEvent) => {
            // 在 Monaco 区域里的 mouseup 由 Monaco 自己的 hook 处理（位置算法不一样），
            // 这里只管 markdown-preview 这种原生 DOM 渲染。
            const target = e.target as Node | null;
            if (target && (target as Element).closest?.('.monaco-editor')) return;

            const sel = window.getSelection();
            if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
                setSelectionBubble(null);
                return;
            }
            const range = sel.getRangeAt(0);
            const anchor = range.commonAncestorContainer;
            if (!(anchor === container || container.contains(anchor))) {
                setSelectionBubble(null);
                return;
            }
            const text = sel.toString();
            if (!text.trim()) {
                setSelectionBubble(null);
                return;
            }
            // 用 getClientRects 拿"每行一个"的矩形，取最后一条 ≈ 选区视觉末端。
            // getBoundingClientRect 在跨标题/段落时会给一个**外包**大矩形——右边
            // 顶到容器边、bubble 被夹到右沿，看起来像跑出页面。
            const rects = range.getClientRects();
            const lastRect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
            const cRect = container.getBoundingClientRect();
            // 留一点右侧 padding 给 bubble 本身宽度，避免被 clientWidth - 8 死夹到边。
            const x = Math.max(8, Math.min(lastRect.right - cRect.left + 4, container.clientWidth - 120));
            const y = Math.max(0, Math.min(lastRect.bottom - cRect.top + 6, container.clientHeight - 32));

            // 行号取自 ReactMarkdown 渲染时注入的 data-line-start/end（见下方
            // markdownComponents）。选区起点/终点向上找最近的带行号节点，min/max 合并。
            const lineRange = computeLineRangeFromSelection(range, container);

            // body 行号 + frontmatter 占行 = 源 SKILL.md 真实行号。
            const offset = previewLineOffsetRef.current;
            if (offset > 0) {
                if (typeof lineRange.lineStart === 'number') lineRange.lineStart += offset;
                if (typeof lineRange.lineEnd === 'number') lineRange.lineEnd += offset;
            }

            setSelectionBubble({ x, y, text, ...lineRange });
        };

        const onMouseDown = (e: MouseEvent) => {
            // 点击浮窗本身不算"开始新选择"——pointerdown 提交时会自己清，这里别误清。
            const t = e.target as Element | null;
            if (t?.closest?.('.selection-add-to-chat')) return;
            setSelectionBubble(null);
        };

        container.addEventListener('mouseup', onMouseUp);
        container.addEventListener('mousedown', onMouseDown);
        return () => {
            container.removeEventListener('mouseup', onMouseUp);
            container.removeEventListener('mousedown', onMouseDown);
        };
    }, [activeFilePath, mdEditMode]);

    // chip 视觉文本：文件名 + 行号区间（行号为单数行就只显示行号）。
    const chipDisplayLabel = (ref: ChatReference): string => {
        if (typeof ref.lineStart === 'number' && typeof ref.lineEnd === 'number') {
            const r = ref.lineStart === ref.lineEnd ? `${ref.lineStart}` : `${ref.lineStart}-${ref.lineEnd}`;
            return `${ref.fileName} ${r}`;
        }
        return ref.fileName;
    };

    // 在 chat-input 当前光标处插入一个 inline chip span。
    //
    // 实现要点：
    //  - 优先用 lastChatRangeRef（onSelectionChange 持续维护的 chat-input 内
    //    最后位置）。这样用户从编辑器点"加入对话"时，chip 也能落在他离开 chat-input
    //    时的 cursor 处而不是开头/末尾。
    //  - 拿不到保存的 range（用户压根没进过 chat-input）→ 落在末尾。
    //  - chip 是 contenteditable=false 的 span——浏览器把它当成不可分割的"字符"，
    //    backspace 整体删，cursor 不进内部。
    //  - chip 后跟一个 NBSP，避免 cursor 卡在 chip 边界。
    const insertChipInline = (ref: ChatReference) => {
        const editor = chatInputRef.current;
        if (!editor) return;
        editor.focus();

        let range: Range;
        const saved = lastChatRangeRef.current;
        // 用 saved range 之前要核对它两端的节点还在编辑器里——edit/delete 之后可能
        // 节点被摘掉了，盲信会扔 NS_ERROR。
        if (saved && editor.contains(saved.startContainer) && editor.contains(saved.endContainer)) {
            range = saved.cloneRange();
        } else {
            range = document.createRange();
            range.selectNodeContents(editor);
            range.collapse(false);
        }
        range.deleteContents();

        const chipEl = document.createElement('span');
        chipEl.setAttribute('contenteditable', 'false');
        chipEl.setAttribute('data-chip-id', ref.id);
        chipEl.className = 'chat-chip';
        // 文件图标 + 文件名 + 行号徽章 + ✕。✕ 与 backspace 删 chip 等价，
        // 给用户一个显式的视觉入口（不放 ✕ 的话有些用户不会想到 chip 能 backspace 删）。
        // 点击事件用 chat-input 上的委托处理，避免在 innerHTML 里写内联 onclick。
        const label = chipDisplayLabel(ref);
        const namePart = ref.fileName;
        const linePart = label.length > namePart.length ? label.slice(namePart.length).trim() : '';
        const escape = (s: string) => s.replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c] as string));
        chipEl.innerHTML = `
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
            </svg>
            <span class="chat-chip-name">${escape(namePart)}</span>
            ${linePart ? `<span class="chat-chip-lines">${escape(linePart)}</span>` : ''}
            <button type="button" class="chat-chip-remove" aria-label="移除引用" tabindex="-1">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
            </button>
        `.trim();

        range.insertNode(chipEl);
        const spaceNode = document.createTextNode(' ');
        chipEl.after(spaceNode);

        // 光标移到 chip 后面的 NBSP 之后，让用户继续打字。selectionchange 监听器
        // 会自动把这个新 range 同步到 lastChatRangeRef，下一次 chip 插入接着用。
        const newRange = document.createRange();
        newRange.setStartAfter(spaceNode);
        newRange.collapse(true);
        const winSel = window.getSelection();
        winSel?.removeAllRanges();
        winSel?.addRange(newRange);

        referencesRef.current.set(ref.id, ref);
        setChipCount(c => c + 1);
    };

    // 选中片段 → "加入对话"：直接把 chip inline 落到 chat-input 当前光标。
    const handleAddSelectionToChat = (sel: { text: string; lineStart?: number; lineEnd?: number }) => {
        const text = (sel.text || '').replace(/\r/g, '').trim();
        if (!text) return;
        const fileName = activeFilePath?.split('/').pop() || 'snippet';
        const ref: ChatReference = {
            id: `ref_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            fileName,
            text,
            lineStart: sel.lineStart,
            lineEnd: sel.lineEnd,
        };
        insertChipInline(ref);
        window.getSelection?.()?.removeAllRanges();
    };

    // 序列化 contenteditable 内容：text 节点保留，chip 替换成 [引用 N]；
    // 同时返回出现过的 chip 列表（按出现顺序），让 handleSendMessage 拼"引用清单"。
    const serializeRichInput = (): { body: string; chipsUsed: ChatReference[] } => {
        const editor = chatInputRef.current;
        if (!editor) return { body: '', chipsUsed: [] };
        const chipsUsed: ChatReference[] = [];
        let body = '';
        const walk = (node: Node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                body += node.textContent || '';
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            const el = node as HTMLElement;
            const chipId = el.getAttribute?.('data-chip-id');
            if (chipId) {
                const ref = referencesRef.current.get(chipId);
                if (ref) {
                    chipsUsed.push(ref);
                    body += `[引用${chipsUsed.length}]`;
                }
                return;
            }
            if (el.tagName === 'BR') {
                body += '\n';
                return;
            }
            // div/p 这种块级（contenteditable 在 Enter 时会插入）当作换行处理
            if (/^(DIV|P)$/.test(el.tagName) && body && !body.endsWith('\n')) {
                body += '\n';
            }
            el.childNodes.forEach(walk);
        };
        editor.childNodes.forEach(walk);
        return { body: body.replace(/ /g, ' ').trim(), chipsUsed };
    };

    // 拼接发送给 agent 的最终 message：自然语言 + 编号占位符 + 下方引用清单。
    // 引用清单**带原文片段**——这是解行号漂移问题的关键：第一处改完后第二处行号
    // 可能错位，但 anchor 文本不变，agent 用 grep 一样能找回去。注释明确给 agent。
    const composeFinalMessage = (body: string, chipsUsed: ChatReference[]): string => {
        if (chipsUsed.length === 0) return body;
        const isZh = locale === 'zh';
        const SNIPPET_LINE_CAP = 10; // 太长 chip 不可控，截断防 token 爆
        const footer = chipsUsed.map((ref, i) => {
            const idx = i + 1;
            const lines = typeof ref.lineStart === 'number' && typeof ref.lineEnd === 'number'
                ? (ref.lineStart === ref.lineEnd
                    ? (isZh ? `第 ${ref.lineStart} 行` : `line ${ref.lineStart}`)
                    : (isZh ? `第 ${ref.lineStart}-${ref.lineEnd} 行` : `lines ${ref.lineStart}-${ref.lineEnd}`))
                : (isZh ? '选中片段' : 'selection');
            const allLines = (ref.text || '').split('\n');
            const truncated = allLines.length > SNIPPET_LINE_CAP;
            const snippet = allLines.slice(0, SNIPPET_LINE_CAP).map(l => `> ${l}`).join('\n')
                + (truncated ? `\n> ... (${isZh ? '已截断' : 'truncated'})` : '');
            return isZh
                ? `[引用${idx}] \`${ref.fileName}\` ${lines}\n${snippet}`
                : `[Ref ${idx}] \`${ref.fileName}\` ${lines}\n${snippet}`;
        }).join('\n\n');
        const header = isZh
            ? '\n\n---\n引用清单（行号可能因前序修改漂移，请用下方"原文"做字符串匹配定位）：\n\n'
            : '\n\n---\nReferences (line numbers are hints — match by quoted text below for accuracy):\n\n';
        return `${body}${header}${footer}`;
    };

    // SKILL.md 真实位置——可能在 /workspace/SKILL.md 也可能在 /workspace/<skill>/SKILL.md。
    // 各处需要"打开 SKILL.md"的按钮、currentSkillName 都走这条统一定位。
    const skillMdInfo = useMemo(() => findSkillMd(files), [files]);
    const skillMdPath = skillMdInfo?.path ?? null;

    const currentSkillName = useMemo(() => {
        if (skillMdInfo?.name) return skillMdInfo.name;
        // SKILL.md 还没生成时（早期生成阶段或异常会话），退到 skill 文件夹名，
        // 都没有再退到 'new-skill'。比 fallback 到一个常量好。
        if (skillMdInfo?.folder) return skillMdInfo.folder;
        return 'new-skill';
    }, [skillMdInfo]);

    const breadcrumbDisplay = useMemo(() => {
        if (!activeFilePath) return currentSkillName;
        const relativePath = activeFilePath.replace('/workspace/', '');
        const segments = relativePath.split('/');
        // agent 通常会 mkdir -p <skill-name> 再把产物写进去，文件路径形如
        // /workspace/<skill-name>/SKILL.md，第一段本身就是 skill 名。这时直接按
        // 路径展示即可；只在文件直接落在 /workspace/ 根下时才补 currentSkillName。
        if (segments.length > 1) return segments.join(' / ');
        return `${currentSkillName} / ${segments[0]}`;
    }, [activeFilePath, currentSkillName]);

    const showPublishToast = (type: 'success' | 'error', msg: string) => {
        setPublishToast({ type, msg });
        setTimeout(() => setPublishToast(null), 4000);
    };

    const handlePublish = async () => {
        if (!currentSessionId || isPublishing) return;
        setIsPublishing(true);
        try {
            const res = await fetch('/api/skills/publish', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: currentSessionId, user }),
            });
            const data = await res.json();
            if (!res.ok) {
                showPublishToast('error', data.error || (locale === 'zh' ? '发布失败' : 'Publish failed'));
            } else {
                const versionNum = data.version?.version ?? 0;
                const isNew = data.isNewSkill;
                const msg = locale === 'zh'
                    ? isNew
                        ? `已发布到 Skills 管理（v${versionNum}）`
                        : `已更新 ${data.skill?.name}，新版本 v${versionNum}`
                    : isNew
                        ? `Published to Skills (v${versionNum})`
                        : `Updated ${data.skill?.name} → v${versionNum}`;
                showPublishToast('success', msg);
            }
        } catch {
            showPublishToast('error', locale === 'zh' ? '网络错误，请重试' : 'Network error, please retry');
        } finally {
            setIsPublishing(false);
        }
    };

    const handleEditorMount = (editor: any) => {
        // 右键菜单兜底：键盘选中（Shift+Arrow / Ctrl+A）不走鼠标 mouseup，
        // 这种情况下浮窗不会自动出现——右键也能补一条路径。
        editor.addAction({
            id: 'add-to-chat',
            label: locale === 'zh' ? '加入对话' : 'Add to Chat',
            contextMenuOrder: 0,
            contextMenuGroupId: 'navigation',
            run: (ed: any) => {
                const selection = ed.getSelection();
                if (!selection || selection.isEmpty()) return;
                const text = ed.getModel().getValueInRange(selection);
                handleAddSelectionToChat({
                    text,
                    lineStart: selection.startLineNumber,
                    lineEnd: selection.endLineNumber,
                });
            }
        });

        // Monaco 自己渲染选区（带 user-select: none），原生 window.getSelection 拿不到，
        // 必须走 Monaco 的 API：onMouseUp 时检查 editor.getSelection()，再用
        // getScrolledVisiblePosition 把选区末端换算成 editor DOM 内的坐标，最后再
        // 减掉 editor-body 的偏移，得到浮窗在 editor-body 容器内的相对定位。
        const computeMonacoBubble = () => {
            const sel = editor.getSelection();
            if (!sel || sel.isEmpty()) {
                setSelectionBubble(null);
                return;
            }
            const text = editor.getModel().getValueInRange(sel);
            if (!text || !text.trim()) {
                setSelectionBubble(null);
                return;
            }
            const visPos = editor.getScrolledVisiblePosition(sel.getEndPosition());
            const edDom: HTMLElement | null = editor.getDomNode();
            const ebDom = editorBodyRef.current;
            if (!visPos || !edDom || !ebDom) return;
            const edRect = edDom.getBoundingClientRect();
            const ebRect = ebDom.getBoundingClientRect();
            const x = Math.max(
                8,
                Math.min((edRect.left + visPos.left) - ebRect.left + 4, ebDom.clientWidth - 120)
            );
            const y = Math.max(
                0,
                Math.min((edRect.top + visPos.top + visPos.height) - ebRect.top + 4, ebDom.clientHeight - 32)
            );
            // Monaco 的 selection 直接给的就是源码行号，比 ReactMarkdown 那套精确：
            // startLineNumber/endLineNumber 是 1-based，跟 Monaco 行号栏对得上。
            setSelectionBubble({
                x,
                y,
                text,
                lineStart: sel.startLineNumber,
                lineEnd: sel.endLineNumber,
            });
        };

        editor.onMouseUp(() => computeMonacoBubble());
        // mousedown 起新一轮选择/光标移动——先清掉旧 bubble，避免残影。
        editor.onMouseDown(() => setSelectionBubble(null));
        // 滚动会让 visPos 失效——浮窗位置会瞬移到错的位置或留在视口外，直接隐藏更稳。
        editor.onDidScrollChange(() => setSelectionBubble(null));
    };

    const hasGeneratedFiles = Object.keys(files).length > 0;
    const previewBtnDisabled = !showIDE && !hasGeneratedFiles;
    const topBarActions = (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
            {/* "预览"切换：把右侧 IDE 面板的开关挪到顶栏，避免用户手动关掉后
                只能靠点 chat 里的下载卡片才能再次打开。没有任何已生成文件时
                禁用，因为开了也是空面板。 */}
            <button
                className="ai-btn-s preview-toggle-btn"
                onClick={togglePreview}
                disabled={previewBtnDisabled}
                title={previewBtnDisabled
                    ? (locale === 'zh' ? '暂无可预览的文件' : 'No files to preview')
                    : showIDE
                        ? (locale === 'zh' ? '关闭预览面板' : 'Close preview panel')
                        : (locale === 'zh' ? '打开预览面板' : 'Open preview panel')}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                    <line x1="15" y1="4" x2="15" y2="20" />
                </svg>
                {showIDE
                    ? (locale === 'zh' ? '关闭预览' : 'Close Preview')
                    : (locale === 'zh' ? '预览' : 'Preview')}
            </button>
            {/* "New Chat" sits as a sibling primary action — promoted out of the
                history dropdown so it's reachable in one click instead of two.
                button 用 inline-flex + center 对齐，否则 inline svg 跟文字按基线对齐，
                小图标视觉上偏低。 */}
            <button
                className="ai-btn-s new-chat-btn"
                onClick={handleNewChat}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 5v14M5 12h14" />
                </svg>
                {locale === 'zh' ? '新建对话' : 'New Chat'}
            </button>
            <div className="history-dropdown-wrapper" ref={historyDropdownRef}>
                <button
                    className="ai-btn-s history-btn"
                    onClick={() => setIsHistoryOpen(v => !v)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    {locale === 'zh' ? '历史对话' : 'History'}
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M19 9l-7 7-7-7" />
                    </svg>
                </button>
                {isHistoryOpen && (
                    <div className="history-menu">
                        <div className="history-list">
                            {sessions.map(s => (
                                <div key={s.id} className={`history-item ${currentSessionId === s.id ? 'active' : ''}`} onClick={() => switchSession(s.id)}>
                                    <div className="history-item-content">
                                        <div className="history-item-title">{s.title}</div>
                                        <div className="history-item-date">{new Date(s.updatedAt).toLocaleString()}</div>
                                    </div>
                                    <button className="history-item-delete" onClick={(e) => deleteSession(e, s.id)}>
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
                                    </button>
                                </div>
                            ))}
                            {sessions.length === 0 && (
                                <div className="history-empty">{locale === 'zh' ? '暂无历史对话' : 'No conversations yet'}</div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );

    return (
        <>
            {publishToast && (
                <div style={{
                    position: 'fixed', bottom: 24, right: 24, zIndex: 9999,
                    padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 500,
                    background: publishToast.type === 'success' ? '#16a34a' : '#dc2626',
                    color: '#fff', boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
                    maxWidth: 340, wordBreak: 'break-word',
                }}>
                    {publishToast.msg}
                </div>
            )}
            <AppTopBar title={<Term id="skill-generation" label={t('nav.skillGenerator')} />} actions={topBarActions} showDefaultActions={false} />
            <div
                ref={containerRef}
                className={`skill-generator-container ${showIDE ? 'ide-open' : 'ide-closed'}`}
            >
                <div className="skill-generator-panel chat-panel">
                    {/* width 由 CSS 变量 --pg-chat-w 驱动（startResize 直接改变量，绕过 React），
                        见 skill-generator.css `.skill-generator-container.ide-open .chat-panel`。 */}
                    <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        {isEditingTitle ? (
                            <input
                                className="title-edit-input"
                                value={titleInput}
                                onChange={e => setTitleInput(e.target.value)}
                                onBlur={handleUpdateTitle}
                                onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleUpdateTitle(); }}
                                autoFocus
                            />
                        ) : (
                            <div 
                                className="panel-title-wrapper" 
                                onClick={() => { 
                                    setTitleInput(currentSession?.title || 'New Chat'); 
                                    setIsEditingTitle(true); 
                                }}
                            >
                                <span>{currentSession?.title || '生成对话'}</span>
                                <svg className="edit-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                            </div>
                        )}
                    </div>
                    <div className="chat-messages">
                        {messages.map((msg, i) => (
                            <ChatMessage
                                key={i}
                                msg={msg}
                                user={user || ''}
                                onOpenFile={openFileInTab}
                                onDebug={() => { sessionStorage.setItem('pending_debug_skill', JSON.stringify({ name: currentSkillName, files: files })); router.push('/skill-eval'); }}
                                onDownload={(skillName) => currentSessionId && triggerSkillDownload(currentSessionId, skillName)}
                                onPreview={() => skillMdPath && openFileInTab(skillMdPath)}
                                locale={locale}
                            />
                        ))}
                        <div ref={chatEndRef} />
                    </div>
                    <div className="chat-input-area">
                        {/* 向上拖大输入区——drag handle 落在模型/场景控件上面，符合自然心智
                            模型（向上拖 = 让输入区往上扩）。chip-input 高度走 CSS 变量
                            --pg-chat-input-h，不每帧 setState 触发 re-render。 */}
                        <div
                            className="chat-input-resizer"
                            onPointerDown={e => startResize('chat-input', e)}
                            title={locale === 'zh' ? '拖动调整输入框高度' : 'Drag to resize input'}
                            aria-label={locale === 'zh' ? '拖动调整输入框高度' : 'Drag to resize input'}
                            role="separator"
                        >
                            <div className="chat-input-resizer-grip" aria-hidden />
                        </div>
                        {/* chat-controls：宽度足够时一字排开；不够时折叠到"更多"弹出面板。
                            折叠用独立 state isControlsCollapsed：drag 中 onMove 跨阈值时切，
                            其它路径（mount/hydrate、pointerup commit）由 chatPanelWidth effect 同步。
                            不用 chatPanelWidth 直接判定——它在拖拽期间不更新（避免每帧重渲染），
                            会导致折叠只在松手时才发生。 */}
                        {(() => {
                            const collapsed = isControlsCollapsed;
                            const clearBtnTitle = locale === 'zh' ? '清空当前对话（不会删除历史会话）' : 'Clear current conversation (history is kept)';
                            // 未配 key 时把配置路径写清楚（哪个菜单 → 哪个区块 → 填什么）；
                                                              // 配过 key 时只交代当前开关状态。
                            const webToggleTitle = !webSearchConfigured
                                ? (locale === 'zh'
                                    ? '联网搜索未配置。配置方法：左侧栏 CONFIGURATION → 联网搜索 → 供应商选 Tavily 并填 API Key。免费档约 1000 次/月，前往 tavily.com 获取 key。'
                                    : 'Web search is not configured. To enable: left sidebar → CONFIGURATION → Web Search → set Provider to Tavily and paste an API Key. Free tier ~1000 calls/month at tavily.com.')
                                : webSearchEnabled
                                    ? (locale === 'zh' ? '联网搜索已开启——点击关闭' : 'Web search is ON — click to disable')
                                    : (locale === 'zh' ? '联网搜索已关闭——点击开启' : 'Web search is OFF — click to enable');
                            const renderModelScenarioWeb = (variant: 'inline' | 'popover') => (
                                <>
                                    <div className={variant === 'popover' ? 'control-item control-item-stacked' : 'control-item'}>
                                        <label>{locale === 'zh' ? '模型' : 'Model'}{variant === 'inline' ? ':' : ''}</label>
                                        <select value={selectedModelId} onChange={e => setSelectedModelId(e.target.value)}>
                                            {configs.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                                            {configs.length === 0 && <option value="">Default</option>}
                                        </select>
                                    </div>
                                    <div className={variant === 'popover' ? 'control-item control-item-stacked' : 'control-item'}>
                                        <label>{locale === 'zh' ? '场景' : 'Scenario'}{variant === 'inline' ? ':' : ''}</label>
                                        <select value={selectedScenario} onChange={e => setSelectedScenario(e.target.value)}>
                                            <option value="general">{locale === 'zh' ? '通用场景' : 'General'}</option>
                                            <option value="ops">{locale === 'zh' ? '运维场景' : 'Operations (Ops)'}</option>
                                        </select>
                                    </div>
                                    <button
                                        type="button"
                                        className={`chat-web-toggle ${webSearchConfigured && webSearchEnabled ? 'is-on' : 'is-off'} ${webSearchConfigured ? 'has-key' : 'no-key'}`}
                                        disabled={!webSearchConfigured}
                                        onClick={() => webSearchConfigured && setWebSearchEnabled(v => !v)}
                                        title={webToggleTitle}
                                        aria-pressed={webSearchConfigured && webSearchEnabled}
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <circle cx="12" cy="12" r="9" />
                                            <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
                                        </svg>
                                        <span>{locale === 'zh' ? '联网搜索' : 'Web search'}</span>
                                        {/* 指示灯：配过 key → 绿（has-key），未配 → 灰（no-key）；用伪元素画在 span 后 */}
                                        <span className="chat-web-toggle-dot" aria-hidden />
                                    </button>
                                </>
                            );
                            return (
                                <div className={`chat-controls ${collapsed ? 'is-collapsed' : ''}`}>
                                    {collapsed ? (
                                        <div className="chat-controls-more-wrap" ref={controlsMoreRef}>
                                            <button
                                                type="button"
                                                className="chat-controls-more-btn"
                                                ref={controlsMoreBtnRef}
                                                onClick={toggleControlsOpen}
                                                aria-expanded={isControlsOpen}
                                                title={locale === 'zh' ? '展开模型 / 场景 / 联网 设置' : 'Show model / scenario / web settings'}
                                            >
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                    <line x1="3" y1="6" x2="21" y2="6" />
                                                    <line x1="3" y1="12" x2="21" y2="12" />
                                                    <line x1="3" y1="18" x2="21" y2="18" />
                                                </svg>
                                                <span>{locale === 'zh' ? '更多配置' : 'More settings'}</span>
                                            </button>
                                            {isControlsOpen && (
                                                <div className={`chat-controls-popover placement-${popoverPlacement}`}>
                                                    {renderModelScenarioWeb('popover')}
                                                </div>
                                            )}
                                        </div>
                                    ) : (
                                        <>
                                            {renderModelScenarioWeb('inline')}
                                            <div className="control-divider" />
                                        </>
                                    )}
                                    <button
                                        className="chat-clear-btn"
                                        title={clearBtnTitle}
                                        aria-label={clearBtnTitle}
                                        onClick={() => {
                                            if (confirm(locale === 'zh' ? '确定清空当前对话？历史会话不会被删除。' : 'Clear current conversation? Past sessions stay intact.')) {
                                                setMessages([{ role: 'agent', content: locale === 'zh' ? '已清空。' : 'Cleared.' }]);
                                                setFiles({});
                                                setShowIDE(false);
                                            }
                                        }}
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6" /></svg>
                                    </button>
                                </div>
                            );
                        })()}
                        <div className="chat-input-container">
                            {(attachments.length > 0 || isUploading || uploadError) && (
                                <div className="chat-attachments-row">
                                    {attachments.map(a => (
                                        <span key={a.name} className="chat-attachment-chip" title={`${a.relPath} · ${formatBytes(a.size)}`}>
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
                                            <span className="chat-attachment-name">{a.name}</span>
                                            {a.textRelPath && <span className="chat-attachment-tag">txt</span>}
                                            <button
                                                className="chat-attachment-remove"
                                                onClick={() => handleRemoveAttachment(a.name)}
                                                aria-label={locale === 'zh' ? '移除附件' : 'Remove attachment'}
                                            >✕</button>
                                        </span>
                                    ))}
                                    {isUploading && <span className="chat-attachment-status">{locale === 'zh' ? '上传中…' : 'Uploading…'}</span>}
                                    {uploadError && <span className="chat-attachment-error" title={uploadError}>⚠ {uploadError.length > 60 ? uploadError.slice(0, 57) + '…' : uploadError}</span>}
                                </div>
                            )}
                            <div className="chat-input-row">
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    multiple
                                    style={{ display: 'none' }}
                                    accept={ALLOWED_EXT_ACCEPT}
                                    onChange={e => handleUploadFiles(e.target.files)}
                                />
                                <div className="chat-upload-btn-wrap">
                                    <button
                                        className="chat-upload-btn"
                                        onClick={() => fileInputRef.current?.click()}
                                        disabled={isUploading || !currentSessionId}
                                        aria-label={locale === 'zh' ? '上传参考资料' : 'Upload reference files'}
                                    >
                                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                            <polyline points="17 8 12 3 7 8" />
                                            <line x1="12" y1="3" x2="12" y2="15" />
                                        </svg>
                                    </button>
                                    <div className="chat-upload-tooltip" role="tooltip">
                                        <div className="chat-upload-tooltip-title">
                                            {locale === 'zh' ? '支持的文件类型' : 'Supported file types'}
                                        </div>
                                        <div className="chat-upload-tooltip-summary">
                                            {(locale === 'zh' ? ['文档', '数据', '代码', '配置', '日志'] : ['Documents', 'Data', 'Code', 'Config', 'Logs']).join(' · ')}
                                        </div>
                                        <table className="chat-upload-tooltip-table">
                                            <tbody>
                                                {ALLOWED_EXT_GROUPS.map(g => (
                                                    <tr key={g.key}>
                                                        <th>{UPLOAD_GROUP_LABELS[locale === 'zh' ? 'zh' : 'en'][g.key]}</th>
                                                        <td>{g.exts.join(' ')}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                        <div className="chat-upload-tooltip-footer">
                                            {locale === 'zh'
                                                ? '单文件 ≤ 10MB · 单次最多 10 个 · 会话累计 ≤ 50'
                                                : 'Max 10MB/file · 10 files/upload · 50 files/session'}
                                        </div>
                                    </div>
                                </div>
                                {/* contenteditable 富文本输入：chip 是 inline 的 contenteditable=false span，
                                    Enter 发送（IME 组字 + Shift+Enter 都不触发，沿用之前的守卫）。
                                    input 事件里把 textContent 同步到 state 是为了驱动发送按钮 disabled。 */}
                                <div
                                    ref={chatInputRef}
                                    className="chat-input-rich"
                                    contentEditable
                                    suppressContentEditableWarning
                                    data-placeholder={locale === 'zh' ? '输入您的需求...' : 'Describe your request...'}
                                    onInput={e => {
                                        const div = e.currentTarget as HTMLDivElement;
                                        setInput(div.textContent || '');
                                        // backspace 删 chip 后 referencesRef 里的元数据成了孤儿，
                                        // 不影响发送（序列化只看 DOM 里还存在的 chip），但要让按钮
                                        // disabled 状态跟实际 chip 数对齐——重新数一次 DOM。
                                        setChipCount(div.querySelectorAll('[data-chip-id]').length);
                                    }}
                                    onKeyDown={e => {
                                        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                                            e.preventDefault();
                                            handleSendMessage();
                                        }
                                    }}
                                    onPaste={e => {
                                        // 拒绝粘贴富文本——避免从浏览器其他地方粘到 chat-input 时引入
                                        // 一堆 <span style="..."> 把样式搞乱。只接 plain text。
                                        e.preventDefault();
                                        const text = e.clipboardData?.getData('text/plain') || '';
                                        document.execCommand('insertText', false, text);
                                    }}
                                    onClick={e => {
                                        // chip 内的 ✕：事件委托——避免在 innerHTML 里写内联 onclick。
                                        // 点 ✕ 移除整个 chip span（不再要伴随的空格也带走，避免 cursor
                                        // 卡在裸 chip 之间无法 backspace 那块）。
                                        const removeBtn = (e.target as HTMLElement).closest?.('.chat-chip-remove');
                                        if (!removeBtn) return;
                                        const chip = removeBtn.closest('[data-chip-id]') as HTMLElement | null;
                                        if (!chip) return;
                                        e.preventDefault();
                                        const div = e.currentTarget as HTMLDivElement;
                                        // chip 后紧跟的空格一并删掉（如果存在），不留孤立空格。
                                        const next = chip.nextSibling;
                                        if (next && next.nodeType === Node.TEXT_NODE && /^[\s ]/.test(next.textContent || '')) {
                                            next.textContent = (next.textContent || '').replace(/^[\s ]/, '');
                                            if (!next.textContent) next.parentNode?.removeChild(next);
                                        }
                                        chip.remove();
                                        // 同步 React state，按钮 disabled 才会更新
                                        setInput(div.textContent || '');
                                        setChipCount(div.querySelectorAll('[data-chip-id]').length);
                                        div.focus();
                                    }}
                                />
                                {isLoading ? (
                                    <button
                                        className="chat-stop-icon-btn"
                                        onClick={handleStopStreaming}
                                        title="停止生成"
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="#5850ec">
                                            <rect x="4" y="4" width="16" height="16" rx="2" />
                                        </svg>
                                    </button>
                                ) : (
                                    <button
                                        className="chat-send-icon-btn"
                                        onClick={handleSendMessage}
                                        disabled={!input.trim() && chipCount === 0}
                                    >
                                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#5850ec" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: 'rotate(45deg)', marginTop: -2 }}>
                                            <line x1="22" y1="2" x2="11" y2="13" />
                                            <polygon points="22 2 15 22 11 13 2 9 22 2" />
                                        </svg>
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
                {showIDE && (
                    <div
                        className="resizer-vertical"
                        onPointerDown={e => startResize('chat', e)}
                        title={locale === 'zh' ? '拖动调整宽度' : 'Drag to resize'}
                    />
                )}
                {showIDE && (
                    <div className="skill-generator-ide-box">
                        {/* width 由 CSS 变量 --pg-tree-w 驱动，见 skill-generator.css `.file-tree-panel`。 */}
                        <div className="file-tree-panel">
                            <div className="panel-header">
                                {locale === 'zh' ? '项目结构' : 'Explorer'}
                            </div>
                            <div className="file-tree-scroll">
                                {['main', 'scripts', 'references'].map(cat => {
                                    const catFiles = categorizedFiles[cat] || [];
                                    if (catFiles.length === 0) return null;
                                    const collapsed = collapsedFolders.has(cat);
                                    const label = cat === 'main' ? (locale === 'zh' ? '主文档' : 'MAIN') : cat.toUpperCase();
                                    return (
                                        <div key={cat} className="tree-folder">
                                            <div
                                                className={`tree-category ${collapsed ? 'collapsed' : ''}`}
                                                onClick={() => toggleFolder(cat)}
                                            >
                                                <svg
                                                    className="tree-chevron"
                                                    width="10" height="10" viewBox="0 0 10 10"
                                                    fill="none" stroke="currentColor" strokeWidth="1.5"
                                                    aria-hidden
                                                >
                                                    <path d="M2 3l3 3 3-3" />
                                                </svg>
                                                <svg
                                                    className="tree-folder-icon"
                                                    width="13" height="13" viewBox="0 0 24 24"
                                                    fill="currentColor" stroke="none"
                                                    aria-hidden
                                                >
                                                    <path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z" />
                                                </svg>
                                                <span className="tree-category-label">{label}</span>
                                                <span className="tree-category-count">{catFiles.length}</span>
                                            </div>
                                            {!collapsed && (
                                                <div className="tree-folder-children">
                                                    {catFiles.map(path => (
                                                        <div
                                                            key={path}
                                                            className={`file-item ${activeFilePath === path ? 'active' : ''}`}
                                                            onClick={() => openFileInTab(path)}
                                                        >
                                                            <FileIcon name={path} />
                                                            <span className="file-item-name">{path.split('/').pop()}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                        <div
                            className="resizer-vertical resizer-inside"
                            onPointerDown={e => startResize('tree', e)}
                            title={locale === 'zh' ? '拖动调整宽度' : 'Drag to resize'}
                        />
                        <div className="editor-panel">
                            {/* editor-header 自身已是 flex space-between（skill-generator.css:1072）——
                                之前在里面又嵌一层 inline flex div 但没给 flex:1，外层 flex 看到
                                的是单个子元素，inner 只占自身内容宽，space-between 间隙塌掉，
                                按钮就贴到标题上了。展平成单层即可。 */}
                            <div className="editor-header">
                                <div className="breadcrumb"><FileIcon name={activeFilePath || 'SKILL.md'} /><span>{breadcrumbDisplay}</span></div>
                                <div className="header-actions">
                                    {/* .md 文件：默认预览 ReactMarkdown，点这里切到 Monaco 直接改 markdown 源码。
                                        其他文件本身就是 Monaco，没必要再加 toggle。 */}
                                    {activeFilePath?.endsWith('.md') && (
                                        <button
                                            type="button"
                                            className="btn-md-toggle"
                                            onClick={() => setMdEditMode(prev => ({ ...prev, [activeFilePath]: !prev[activeFilePath] }))}
                                            title={mdEditMode[activeFilePath]
                                                ? (locale === 'zh' ? '切到预览' : 'Switch to preview')
                                                : (locale === 'zh' ? '编辑 Markdown' : 'Edit markdown')}
                                        >
                                            {mdEditMode[activeFilePath]
                                                ? (locale === 'zh' ? '预览' : 'Preview')
                                                : (locale === 'zh' ? '编辑' : 'Edit')}
                                        </button>
                                    )}
                                    <button className="btn-download" onClick={() => currentSessionId && triggerSkillDownload(currentSessionId, currentSkillName)}>{locale === 'zh' ? '下载' : 'Download'}</button>
                                    <button className="btn-publish" onClick={handlePublish} disabled={isPublishing || !currentSessionId}>
                                        {isPublishing ? (locale === 'zh' ? '发布中…' : 'Publishing…') : (locale === 'zh' ? '保存并发布' : 'Publish')}
                                    </button>
                                    <button className="btn-close-ide" onClick={() => setShowIDE(false)}>
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                                    </button>
                                </div>
                            </div>
                            {/* Tab bar */}
                            {openTabs.length > 0 ? (
                                <div className="editor-tabs">
                                    {openTabs.map(tabPath => (
                                        <div
                                            key={tabPath}
                                            className={`editor-tab ${activeFilePath === tabPath ? 'active' : ''}`}
                                            onClick={() => setActiveFilePath(tabPath)}
                                            title={tabPath}
                                        >
                                            <FileIcon name={tabPath} />
                                            <span className="editor-tab-name">{tabPath.split('/').pop()}</span>
                                            <button
                                                className="tab-close-btn"
                                                onClick={e => { e.stopPropagation(); closeTab(tabPath); }}
                                                title={locale === 'zh' ? '关闭' : 'Close'}
                                            >×</button>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="editor-tabs-empty">
                                    {locale === 'zh' ? '点击文件以打开' : 'Click a file to open'}
                                </div>
                            )}
                            <div className="editor-body" style={{ padding: 0, position: 'relative' }} ref={editorBodyRef}>
                                {activeFilePath ? (
                                    activeFilePath.endsWith('.md') && !mdEditMode[activeFilePath] ? (
                                        <div className="markdown-preview">
                                            {previewFrontmatter && (previewFrontmatter.name || previewFrontmatter.description) && (
                                                <div className="skill-frontmatter-card">
                                                    <div className="skill-frontmatter-label">
                                                        {locale === 'zh' ? 'Skill 元信息' : 'Skill Metadata'}
                                                    </div>
                                                    {previewFrontmatter.name && (
                                                        <div className="skill-frontmatter-name">{previewFrontmatter.name}</div>
                                                    )}
                                                    {previewFrontmatter.description && (
                                                        <div className="skill-frontmatter-desc">{previewFrontmatter.description}</div>
                                                    )}
                                                </div>
                                            )}
                                            <ReactMarkdown
                                                remarkPlugins={[remarkGfm]}
                                                components={markdownComponentsWithLineAttrs}
                                            >
                                                {previewFrontmatter?.body ?? activeFileContent}
                                            </ReactMarkdown>
                                        </div>
                                    ) : (
                                        <Editor
                                            height="100%"
                                            language={
                                                activeFilePath.endsWith('.sh') ? 'shell'
                                                    : activeFilePath.endsWith('.json') ? 'json'
                                                        : activeFilePath.endsWith('.py') ? 'python'
                                                            : 'markdown'
                                            }
                                            value={activeFileContent}
                                            theme="light"
                                            options={{
                                                fontSize: 13,
                                                minimap: { enabled: false },
                                                automaticLayout: true,
                                                readOnly: false,
                                                contextmenu: true,
                                                wordWrap: 'on',
                                            }}
                                            onChange={(v) => activeFilePath && handleFileContentChange(activeFilePath, v ?? '')}
                                            onMount={handleEditorMount}
                                        />
                                    )
                                ) : (
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#9ca3af', fontSize: 13 }}>
                                        {locale === 'zh' ? '从左侧选择一个文件' : 'Select a file from the explorer'}
                                    </div>
                                )}
                                {selectionBubble && (
                                    <button
                                        type="button"
                                        className="selection-add-to-chat"
                                        style={{ position: 'absolute', left: selectionBubble.x, top: selectionBubble.y }}
                                        // pointerdown 提交：click 之前浏览器会先清掉选区——按钮还没读到 text
                                        // 就空了。stopPropagation 避免向上冒泡触发 editor-body 的 mousedown 清空逻辑。
                                        onPointerDown={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            handleAddSelectionToChat({
                                                text: selectionBubble.text,
                                                lineStart: selectionBubble.lineStart,
                                                lineEnd: selectionBubble.lineEnd,
                                            });
                                            setSelectionBubble(null);
                                        }}
                                    >
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                                        </svg>
                                        <span>{locale === 'zh' ? '加入对话' : 'Add to Chat'}</span>
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </>
    );
}

/**
 * Maps a tool name + args to a human-readable header label shown in the
 * collapsed tool block. Tweak this when more tools land.
 *
 * Why expose this as a function: tool-name → user-facing copy is a UX
 * decision (e.g. "write_file" can be "📝 Writing SKILL.md" or "🔧 write_file"),
 * and one place to change it makes future tools easy to onboard.
 */
/**
 * Tools the user generally doesn't need to inspect — exploration / book-keeping
 * commands. We collapse consecutive runs of these into a single "ran N commands"
 * group so the chat doesn't drown in `ls`/`bash` chatter. Anything not in this
 * set (write_file, edit, ...) is considered "important" and rendered standalone.
 */
// 折叠掉的"次要"工具——浏览/记录类调用，连续多个会被 ToolGroup 合并成"运行了 N 个命令"
// 一行折叠展示。其余被认为是"关键"工具（write/edit/...）独立成块。
//
// 命名涵盖 deepagents（write_todos/todo_write）、opencode（todowrite/webfetch/look_at/
// interactive_bash 等）和 Claude（read_file/web_search/...）三套，避免哪种 framework
// 切过来都得改这个 set。
/**
 * ReactMarkdown 自定义组件——给每个块级元素挂 data-line-start / data-line-end，
 * 取自 remark 解析时附带的 position 信息（默认就有，不用额外 plugin）。
 *
 * 为什么要这层注入：选区是 DOM Range，文本节点没有"自己是哪一行"的信息；
 * 通过往上找最近的带 data-line-* 的祖先，就能从 DOM 反查回源码行号——
 * 后续可以塞给 LLM 当作"@文件 第 N-M 行"的引用位，比塞原文 token 更省。
 *
 * 用 `any` 是为了避开 react-markdown 在不同版本里 Components 类型签名不一致
 * 的小坑——components map 里只用 node + props，跑时取出来用就行。
 */
const blockWithLineAttrs = (Tag: any) => (props: any) => {
    const pos = props?.node?.position;
    const { node, ...rest } = props;
    return (
        <Tag
            data-line-start={pos?.start?.line}
            data-line-end={pos?.end?.line}
            {...rest}
        />
    );
};

const markdownComponentsWithLineAttrs: Record<string, any> = {
    h1: blockWithLineAttrs('h1'),
    h2: blockWithLineAttrs('h2'),
    h3: blockWithLineAttrs('h3'),
    h4: blockWithLineAttrs('h4'),
    h5: blockWithLineAttrs('h5'),
    h6: blockWithLineAttrs('h6'),
    p: blockWithLineAttrs('p'),
    ul: blockWithLineAttrs('ul'),
    ol: blockWithLineAttrs('ol'),
    li: blockWithLineAttrs('li'),
    blockquote: blockWithLineAttrs('blockquote'),
    pre: blockWithLineAttrs('pre'),
    table: blockWithLineAttrs('table'),
    tr: blockWithLineAttrs('tr'),
};

/**
 * 从选区起点/终点的 DOM 节点向上爬，找到最近带 data-line-start/end 的祖先，
 * 合并出选区整体覆盖的行号区间。
 *
 *  - 起点节点找 lineStart（取祖先的 data-line-start）
 *  - 终点节点找 lineEnd（取祖先的 data-line-end）
 *  - 反向选择（focus 在前、anchor 在后）：DOM Range 已经把 start/end 规范化
 *    成 lexicographic 顺序，不用关心方向。
 *
 * 拿不到（节点不在 markdown-preview 里 / 块元素没注入属性）返回空对象，
 * 调用方降级到原文 quote。
 */
function computeLineRangeFromSelection(
    range: Range,
    container: HTMLElement,
): { lineStart?: number; lineEnd?: number } {
    const climb = (node: Node | null, attr: string): number | null => {
        let el: Element | null = node?.nodeType === 1
            ? (node as Element)
            : (node?.parentElement ?? null);
        while (el && container.contains(el)) {
            const raw = el.getAttribute?.(attr);
            const n = raw ? parseInt(raw, 10) : NaN;
            if (!Number.isNaN(n)) return n;
            el = el.parentElement;
        }
        return null;
    };
    const startStart = climb(range.startContainer, 'data-line-start');
    const endEnd = climb(range.endContainer, 'data-line-end');
    if (startStart == null || endEnd == null) return {};
    return {
        lineStart: Math.min(startStart, endEnd),
        lineEnd: Math.max(startStart, endEnd),
    };
}

const ROUTINE_TOOL_NAMES = new Set([
    'ls',
    'bash',
    'interactive_bash',
    'grep',
    'glob',
    'read_file',
    'read',
    'look_at',
    // todo 写工具（write_todos/todo_write/todowrite）刻意**不**算 routine：
    // 它代表 agent 的执行计划，要单独成块、内联展示完整列表，不能被合并到
    // "ran N commands"折叠组里。专用渲染走 TodoBlock。
    'web_search',
    'web_fetch',
    'webfetch',
    'lsp_diagnostics',
    'lsp_find_references',
    'lsp_goto_definition',
    'lsp_symbols',
]);

function isRoutineTool(name: string): boolean {
    return ROUTINE_TOOL_NAMES.has(name);
}

function getToolLabel(name: string, args: any, locale: string): string {
    const isZh = locale === 'zh';
    // Tool-arg field names vary across agent frameworks: deepagents/langchain
    // uses `file_path`, claude uses `path`, opencode uses `filePath` (camelCase).
    // 全都接，否则换 framework 的时候 label 就裸名露馅。
    const filePath = args?.filePath ?? args?.file_path ?? args?.path ?? args?.filename ?? args?.file;
    const fileName = (p?: string) => (p ? String(p).split('/').pop() || String(p) : '');
    const fname = fileName(filePath);
    // Helper that omits the trailing space when no file was extracted, so we
    // never render a dangling label like "创建 " (which is what users were seeing
    // before this fix).
    const withFile = (zh: string, en: string, suffix?: string) => {
        const s = suffix ?? fname;
        return s ? (isZh ? `${zh} ${s}` : `${en} ${s}`) : (isZh ? zh : en);
    };

    switch (name) {
        case 'write_file':
        case 'create_file':
        // opencode 的 file-write 工具直接叫 `write`，参数也是 path/content；
        // 不补这一条的话用户看到的就是赤裸裸的 "write" 没有"创建文件 SKILL.md"那种 label。
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
        // opencode 的 todo 工具叫 `todowrite`（一个词，全小写），见
        // exclude/opencode/.../tool/todo.ts:16；漏掉这条会让 todo 列表退化成原始 JSON。
        case 'todowrite':
            return isZh ? '更新待办列表' : 'Updating todos';
        // opencode 的 skill 加载工具，args.name 是技能名。
        case 'skill':
            return withFile('加载技能', 'Loading skill', args?.name);
        // opencode 的"看图"工具（截图/UI 校验场景）。
        case 'look_at':
            return isZh ? '查看视图' : 'Look at';
        default:
            return name;
    }
}

/**
 * Trigger a browser download of the skill as a real .zip, served by
 * `/api/skill-generator/download/<sessionId>`. The endpoint reads the session's
 * persisted files from the DB and streams an archive — no need to ship the
 * vfs back over the wire just to zip it client-side.
 *
 * We use a programmatic <a download> click instead of `window.location =`
 * so the page doesn't appear to navigate away during the download dialog.
 */
function triggerSkillDownload(sessionId: string, skillName: string) {
    const basePath = process.env.NEXT_PUBLIC_URL_PREFIX || '';
    const a = document.createElement('a');
    a.href = `${basePath}/api/skill-generator/download/${encodeURIComponent(sessionId)}`;
    // The server's Content-Disposition is authoritative for the filename;
    // this hint is just a fallback for browsers that ignore it.
    a.download = `${skillName || 'skill'}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

function ChatMessage({ msg, user, onOpenFile, onDebug, onDownload, onPreview, locale }: { msg: Message, user: string, onOpenFile: (p: string) => void, onDebug: () => void, onDownload: (skillName: string) => void, onPreview: () => void, locale: string }) {
    // Parse skill-card from accumulated content (kept for legacy + final summary).
    const cardMatch = msg.content.match(/:::skill-card([\s\S]*?):::/);
    let cardData: any = null;
    if (cardMatch) {
        const lines = cardMatch[1].trim().split('\n');
        cardData = {};
        lines.forEach(line => {
            const [key, ...val] = line.split(':');
            if (key) cardData[key.trim()] = val.join(':').trim();
        });
    }

    // Two render paths:
    //  - new path: msg.blocks present → render thinking/tool/text inline in order
    //  - legacy path: only msg.content → strip skill-card and render as markdown
    // Array.isArray guard: if hydration hasn't run, msg.blocks may be the
    // raw "[]" string from Prisma (length 2 > 0 would falsely engage the
    // blocks path and crash on .map). Require an actual array.
    const useBlocks = msg.role === 'agent' && Array.isArray(msg.blocks) && msg.blocks.length > 0;
    const textPart = cardMatch ? msg.content.replace(cardMatch[0], '') : msg.content;

    // Pre-process blocks into a render plan that groups consecutive routine
    // tool calls under a single "ran N commands" collapsible. This is a pure
    // view transformation — the underlying msg.blocks data stays unchanged so
    // we can change the grouping policy later without migrating stored state.
    type ToolBlk = Extract<Block, { kind: 'tool' }>;
    type RenderItem =
        | { kind: 'block'; block: Block }
        | { kind: 'tool-group'; tools: ToolBlk[]; key: string };
    const renderPlan: RenderItem[] = useBlocks ? (() => {
        const items: RenderItem[] = [];
        const blocks = msg.blocks!;
        let i = 0;
        while (i < blocks.length) {
            const cur = blocks[i];
            // Collect the longest run of consecutive routine tool calls.
            if (cur.kind === 'tool' && isRoutineTool(cur.name)) {
                const run: ToolBlk[] = [];
                while (i < blocks.length) {
                    const b = blocks[i];
                    if (b.kind === 'tool' && isRoutineTool(b.name)) { run.push(b); i++; }
                    else break;
                }
                if (run.length >= 2) {
                    items.push({ kind: 'tool-group', tools: run, key: `group_${run[0].id}` });
                } else {
                    // One routine tool alone — keep it inline; it'll render as a
                    // (subdued) ToolBlock so the user still sees what happened.
                    items.push({ kind: 'block', block: run[0] });
                }
                continue;
            }
            items.push({ kind: 'block', block: cur });
            i++;
        }
        return items;
    })() : [];

    return (
        <div className={`message-bubble message-${msg.role}`}>
            {useBlocks ? (
                renderPlan.map(item => {
                    if (item.kind === 'tool-group') {
                        return <ToolGroup key={item.key} tools={item.tools} onOpenFile={onOpenFile} locale={locale} />;
                    }
                    const block = item.block;
                    if (block.kind === 'text') {
                        // Strip any skill-card delimiters from text blocks too — the card is rendered separately below.
                        const stripped = block.text.replace(/:::skill-card[\s\S]*?:::/g, '');
                        if (!stripped.trim()) return null;
                        return <MarkdownText key={block.id}>{stripped}</MarkdownText>;
                    }
                    if (block.kind === 'thinking') {
                        return <ThinkingBlock key={block.id} block={block} locale={locale} />;
                    }
                    if (block.kind === 'tool') {
                        return <ToolBlock key={block.id} block={block} onOpenFile={onOpenFile} locale={locale} />;
                    }
                    if (block.kind === 'download') {
                        return <DownloadCard key={block.id} block={block} onDownload={onDownload} onPreview={onPreview} locale={locale} />;
                    }
                    if (block.kind === 'question') {
                        return <QuestionBlock key={block.id} block={block} user={user || ''} locale={locale} />;
                    }
                    return null;
                })
            ) : msg.role === 'user' ? (
                // 用户气泡：把 [引用 N] 渲成 chip，footer 的原文清单不显示
                // （那部分只给模型看，气泡里展开既挤又难读）。
                <UserMessageContent content={textPart} locale={locale} />
            ) : (
                <MarkdownText>{textPart}</MarkdownText>
            )}
            {msg.role === 'agent' && msg.isStreaming && (
                <div className="agent-streaming-indicator">
                    <div className="streaming-dots">
                        <span /><span /><span />
                    </div>
                </div>
            )}
            {cardData && (
                <div className="skill-card-preview">
                    <div className="skill-card-header"><div className="skill-card-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" /></svg></div><div><div className="skill-card-title">{cardData.name}</div><div className="skill-card-subtitle">{cardData.subtitle}</div></div></div>
                    <div className="skill-card-desc">{cardData.description}</div>
                    <div className="skill-card-stats"><div className="stat-item">脚本: <span>{cardData.scripts}</span></div><div className="stat-item">命令块: <span>{cardData.commands}</span></div><div className="stat-item">场景: <span>{cardData.scenarios}</span></div></div>
                    <div className="skill-card-actions">
                        <button className="ai-btn-s" onClick={() => alert('Save')}>版本保存</button>
                        <button className="ai-btn-s" onClick={onDebug}>调测分析</button>
                        <button className="ai-btn-sp" onClick={onPreview}>{locale === 'zh' ? '在编辑器中打开 ↗' : 'Open in editor ↗'}</button>
                    </div>
                </div>
            )}
        </div>
    );
}

/**
 * Collapsible "Thinking" block, Claude-style.
 * Default closed for finished thoughts, default open while streaming so users
 * can watch the model's reasoning unfold and collapse it after.
 */
function ThinkingBlock({ block, locale }: { block: Extract<Block, { kind: 'thinking' }>, locale: string }) {
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
                    {block.text || (locale === 'zh' ? '（思考中…）' : '(thinking…)')}
                </div>
            )}
        </div>
    );
}

/**
 * Collapsible tool-call block. Routes web_search/web_fetch to a special card;
 * all other tools render as a minimal collapsible row.
 */
function ToolBlock({
    block, onOpenFile, locale,
}: {
    block: Extract<Block, { kind: 'tool' }>;
    onOpenFile: (p: string) => void;
    locale: string;
}) {
    const [open, setOpen] = useState(false);
    const isWebSearch = block.name === 'web_search' || block.name === 'websearch' || block.name === 'web_fetch' || block.name === 'webfetch';
    if (isWebSearch) {
        return <WebSearchBlock block={block} locale={locale} />;
    }
    // todo 写工具：deepagents 用 write_todos / todo_write，opencode 用 todowrite，
    // args 字段名都是 todos（opencode todo.ts:8 / deepagents 也对得上）。
    // 这是 agent 的执行计划，最有价值的可见反馈之一——不走可折叠 ToolBlock，独立成
    // 永远展开的 TodoBlock，header 上直接显示状态计数（已完成/进行中/待办/已放弃）。
    const isWriteTodos =
        (block.name === 'write_todos' || block.name === 'todo_write' || block.name === 'todowrite')
        && Array.isArray(block.args?.todos);
    if (isWriteTodos) {
        return <TodoBlock todos={block.args.todos} locale={locale} />;
    }
    const label = getToolLabel(block.name, block.args, locale);
    // 路径字段名各家不一样：deepagents/Claude 用 file_path/path，opencode 用 filePath（camelCase）。
    // 三种都接收，否则 opencode 的 write 工具拿不到路径，跳转按钮永远不出现。
    const filePath = block.args?.filePath ?? block.args?.file_path ?? block.args?.path ?? block.args?.filename;
    // 文件写工具：deepagents 用 write_file、opencode 用 write，args 都带 path/file_path/filePath。
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

    // 给折叠状态下生成"一眼看清这次到底跑了什么"的预览。每个工具挑最有信息量的那个 arg
    // 字段：bash 看 command、write/read/edit 看路径文件名、其他降级到 summary。
    // 之所以不直接铺 summary：bash 的 `(no output)` / write 的"Wrote file successfully."
    // 这种几乎没信息量的字符串，看了等于没看；用 args 里的关键字段反而更直观。
    const fpArg = block.args?.filePath ?? block.args?.file_path ?? block.args?.path ?? block.args?.filename;
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

    // 用户要求：所有工具调用展开后都呈现 "input" + "output" 两段。
    // input 是 args（如果是 write/edit 这种带大段 content 的，content 抽出来单独渲，
    //         其余字段拼成 multi-line JSON 紧凑显示，避免 content 被 JSON 转义成 \n
    //         挤成一行看不清真实换行）。
    // output 优先 summary，没有就显示 "(no output)"——bash mkdir 这种就是真没 stdout。
    // error 单独红框渲染，不挤进 output。
    const inputView = (() => {
        if (!block.args || typeof block.args !== 'object') return null;
        const { content, ...rest } = block.args as Record<string, any>;
        const restPretty = Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : null;
        const contentStr = typeof content === 'string' ? content : null;
        if (!restPretty && contentStr == null) return null;
        return { restPretty, content: contentStr };
    })();

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
                        <span className="tool-row-key">{locale === 'zh' ? '工具' : 'tool'}</span>
                        <code className="tool-row-value">{block.name}</code>
                    </div>
                    {/* INPUT 段：args + content */}
                    <div className="tool-row">
                        <span className="tool-row-key">{locale === 'zh' ? '输入' : 'input'}</span>
                        <div className="tool-row-value tool-input-stack">
                            {inputView ? (
                                <>
                                    {inputView.restPretty && (
                                        <pre className="tool-args-pre">{inputView.restPretty}</pre>
                                    )}
                                    {inputView.content != null && (
                                        <pre className="tool-content-pre" data-label={locale === 'zh' ? '文件内容' : 'content'}>{inputView.content}</pre>
                                    )}
                                </>
                            ) : (
                                <span className="tool-row-empty">{locale === 'zh' ? '（无）' : '(none)'}</span>
                            )}
                        </div>
                    </div>
                    {/* OUTPUT 段 */}
                    <div className="tool-row">
                        <span className="tool-row-key">{locale === 'zh' ? '输出' : 'output'}</span>
                        <div className="tool-row-value">
                            {block.status === 'running' ? (
                                <span className="tool-row-empty">{locale === 'zh' ? '（运行中…）' : '(running…)'}</span>
                            ) : block.summary ? (
                                <pre className="tool-result-pre">{block.summary}</pre>
                            ) : (
                                <span className="tool-row-empty">{locale === 'zh' ? '（无输出）' : '(no output)'}</span>
                            )}
                        </div>
                    </div>
                    {/* error 单独红框 */}
                    {block.error && (
                        <div className="tool-row tool-row-error">
                            <span className="tool-row-key">{locale === 'zh' ? '错误' : 'error'}</span>
                            <pre className="tool-result-pre">{block.error}</pre>
                        </div>
                    )}
                    {isFileWrite && block.status === 'ok' && (
                        <button className="tool-open-link" onClick={() => onOpenFile(String(filePath))}>
                            {locale === 'zh' ? '在编辑器中打开 ↗' : 'Open in editor ↗'}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * Claude-style "Searched the web" card. Tries to parse block.summary as a
 * JSON results array [ { title, url, snippet } ]. Falls back to showing the
 * raw summary text if parsing fails.
 */
function WebSearchBlock({ block, locale }: {
    block: Extract<Block, { kind: 'tool' }>;
    locale: string;
}) {
    const [open, setOpen] = useState(false);
    const isZh = locale === 'zh';
    const query: string = block.args?.query ?? block.args?.q ?? block.args?.url ?? '';

    type SearchResult = { title?: string; url?: string; snippet?: string; domain?: string };
    let results: SearchResult[] | null = null;
    if (block.summary) {
        try {
            const parsed = JSON.parse(block.summary);
            if (Array.isArray(parsed)) results = parsed;
        } catch { /* not JSON — fallback to raw text */ }
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

/**
 * Rendered form of a write_todos call's args.todos array. Three states map to
 * three icons:
 *   pending     → empty circle
 *   in_progress → half-filled circle (active spinner-like cue)
 *   completed   → checkmark
 */
/**
 * 永远展开的 todo 计划块（agent 调 todowrite 时渲染）。
 *
 * 跟普通 ToolBlock 不一样的地方：
 *   - 不可折叠：todo 列表是 agent 执行计划的可视化，每次调用都重要，不该让用户再点开
 *   - header 上直接显示状态计数（已完成 / 进行中 / 待办 / 已放弃），一眼看进度
 *   - 用 ✅ / ⏳ / ○ / ✗ 四种 emoji 状态图标搭配文字标签，比纯 SVG 更直白
 *
 * 状态字段 opencode/deepagents 都用 status: pending/in_progress/completed/cancelled，
 * 对应 todo.ts:14 的 schema。
 */
function TodoBlock({
    todos,
    locale,
}: {
    todos: Array<{ content: string; status?: string; priority?: string }>;
    locale: string;
}) {
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
                        <span className="todos-count completed">
                            ✅ {counts.completed} {isZh ? '已完成' : 'done'}
                        </span>
                    )}
                    {counts.in_progress > 0 && (
                        <span className="todos-count in-progress">
                            ⏳ {counts.in_progress} {isZh ? '进行中' : 'in progress'}
                        </span>
                    )}
                    {counts.pending > 0 && (
                        <span className="todos-count pending">
                            ○ {counts.pending} {isZh ? '待办' : 'pending'}
                        </span>
                    )}
                    {counts.cancelled > 0 && (
                        <span className="todos-count cancelled">
                            ✗ {counts.cancelled} {isZh ? '已放弃' : 'cancelled'}
                        </span>
                    )}
                </span>
            </div>
            <TodoChecklist todos={todos} />
        </div>
    );
}

function TodoChecklist({ todos }: { todos: Array<{ content: string; status?: string; priority?: string }> }) {
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
                                // opencode 的 todo 状态多一个 cancelled——画个删除线圆圈表示"被放弃了"。
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

/**
 * Collapses a run of consecutive routine tool calls (ls / bash / write_todos
 * etc.) into a single "Ran N commands" header — Claude-style. Click expands
 * to show each individual ToolBlock inline.
 *
 * Why streaming-aware status: while running, the most-recent tool's status
 * dominates (likely 'running'); once everything finishes, we summarize
 * worst-case (any error → red, otherwise green).
 */
function ToolGroup({
    tools, onOpenFile, locale,
}: {
    tools: Extract<Block, { kind: 'tool' }>[];
    onOpenFile: (p: string) => void;
    locale: string;
}) {
    const [open, setOpen] = useState(false);
    const isZh = locale === 'zh';
    const anyError = tools.some(t => t.status === 'error');
    const anyRunning = tools.some(t => t.status === 'running');
    const aggregateStatus = anyError ? 'error' : anyRunning ? 'running' : 'ok';

    return (
        <div className={`inline-block tool tool-group status-${aggregateStatus}`}>
            <button className="inline-block-header tool-group" onClick={() => setOpen(o => !o)}>
                <span className="inline-block-icon" aria-hidden>
                    {anyRunning ? <span className="inline-block-spinner" style={{ color: '#3b82f6' }} />
                        : anyError ? (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                        ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                        )}
                </span>
                <span className="inline-block-label">
                    {anyRunning
                        ? (isZh ? '正在执行命令...' : 'Running commands...')
                        : (isZh ? `执行了 ${tools.length} 个命令` : `Ran ${tools.length} commands`)}
                </span>
                <span className="web-search-count-badge" style={{ marginLeft: 6 }}>{tools.length}</span>
                <span className="inline-block-chevron" data-open={open}>▾</span>
            </button>
            {open && (
                <div className="tool-group-body">
                    {tools.map(t => (
                        <ToolBlock key={t.id} block={t} onOpenFile={onOpenFile} locale={locale} />
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * agent 问用户的问题——支持 opencode 多 sub-question 协议：
 *   - choices 数组里每个 QuestionInfo 独立渲染（header / question / options / custom 输入）
 *   - 必填校验：每个 question 至少一个 option 选中或 custom 文本非空，否则 提交 disabled
 *   - 提交格式按 opencode schema：reply = string[][]，每个 question 一个内层数组
 *
 * 兼容回退：choices 缺失或长度=0 时退回到旧的单 textarea 行为，避免老 session 渲染断裂。
 */
function QuestionBlock({
    block, user, locale,
}: {
    block: Extract<Block, { kind: 'question' }>;
    user: string;
    locale: string;
}) {
    const isZh = locale === 'zh';
    const choices = Array.isArray(block.choices) ? block.choices : [];
    const hasStructured = choices.length > 0;

    // 多问题模式：每个 question 单独追踪 selectedOptions[i] (string[]) 和 customText[i] (string)
    // 单问题模式：用一个 textarea 即可（fallback）
    const [selected, setSelected] = useState<string[][]>(() => choices.map(() => []));
    const [custom, setCustom] = useState<string[]>(() => choices.map(() => ''));
    const [singleAnswer, setSingleAnswer] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const isPending = block.status === 'pending';

    const toggleOption = (qi: number, label: string, multiple: boolean) => {
        setSelected(prev => {
            const next = prev.map(arr => arr.slice());
            const cur = next[qi] || [];
            if (multiple) {
                const idx = cur.indexOf(label);
                if (idx >= 0) cur.splice(idx, 1);
                else cur.push(label);
            } else {
                next[qi] = cur.includes(label) ? [] : [label];
                return next;
            }
            next[qi] = cur;
            return next;
        });
    };

    const setCustomAt = (qi: number, value: string) => {
        setCustom(prev => {
            const next = prev.slice();
            next[qi] = value;
            return next;
        });
    };

    // 必填判断：每个 question 至少有一个 option 选中或 custom 文本非空
    const allFilled = hasStructured
        ? choices.every((_, i) => (selected[i]?.length || 0) > 0 || (custom[i] || '').trim().length > 0)
        : singleAnswer.trim().length > 0;

    const buildReply = (): string[] | string[][] | null => {
        if (!hasStructured) {
            const t = singleAnswer.trim();
            return t ? [t] : null;
        }
        // 每个 question：合并 selected options + custom 文本（如果填了）
        return choices.map((_, i) => {
            const opts = selected[i] || [];
            const c = (custom[i] || '').trim();
            const combined = c ? [...opts, c] : opts;
            return combined;
        });
    };

    const submit = async (kind: 'answer' | 'skip') => {
        if (submitting) return;
        setSubmitting(true);
        try {
            const reply = kind === 'skip' ? null : buildReply();
            const res = await fetch('/api/agent/respond', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    requestId: block.id,
                    user,
                    kind: 'question',
                    reply,
                }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                console.error('respond failed:', err);
                alert(isZh ? '提交失败' : 'Submit failed');
            }
            // 不在这里更新 block 状态——服务端 resolve 后推 question_answered 事件，UI 自动同步
        } catch (e) {
            console.error(e);
            alert(isZh ? '网络错误' : 'Network error');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div style={{
            margin: '8px 0',
            padding: '12px 14px',
            background: 'var(--card-bg)',
            border: '1px solid var(--card-border)',
            borderRadius: 8,
            fontSize: 13,
        }}>
            <div style={{ fontWeight: 600, marginBottom: hasStructured ? 10 : 6, color: 'var(--foreground)' }}>
                ❓ {isZh ? 'Agent 想请你回答' : 'Agent asks'}
                {hasStructured && choices.length > 1 && (
                    <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--foreground-muted)', marginLeft: 8 }}>
                        ({choices.length} {isZh ? '个问题，全部需要回答' : 'questions, all required'})
                    </span>
                )}
            </div>

            {!isPending ? (
                <div style={{
                    padding: '6px 10px',
                    background: 'var(--background)',
                    borderRadius: 4,
                    fontSize: 12,
                    color: 'var(--foreground-muted)',
                    whiteSpace: 'pre-wrap',
                }}>
                    {block.status === 'answered'
                        ? `✓ ${isZh ? '已回答' : 'Answered'}: ${block.answer || ''}`
                        : `⊘ ${isZh ? '已跳过' : 'Skipped'}${block.answer ? ` (${block.answer})` : ''}`}
                </div>
            ) : hasStructured ? (
                <>
                    {choices.map((q, qi) => {
                        const opts = Array.isArray(q.options) ? q.options : [];
                        const allowCustom = q.custom !== false; // 默认允许
                        const multiple = !!q.multiple;
                        const sel = selected[qi] || [];
                        const filled = sel.length > 0 || (custom[qi] || '').trim().length > 0;
                        return (
                            <div
                                key={qi}
                                style={{
                                    marginBottom: qi === choices.length - 1 ? 10 : 14,
                                    paddingLeft: 10,
                                    borderLeft: `2px solid ${filled ? 'var(--accent)' : 'var(--card-border)'}`,
                                }}
                            >
                                {q.header && (
                                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--foreground-muted)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                                        {q.header}{multiple ? ` · ${isZh ? '可多选' : 'multi'}` : ''}
                                    </div>
                                )}
                                <div style={{ marginBottom: 6, lineHeight: 1.5, whiteSpace: 'pre-wrap', color: 'var(--foreground-secondary)' }}>
                                    {q.question}
                                </div>
                                {opts.length > 0 && (
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: allowCustom ? 6 : 0 }}>
                                        {opts.map((o, oi) => {
                                            const isSel = sel.includes(o.label);
                                            return (
                                                <button
                                                    key={oi}
                                                    onClick={() => toggleOption(qi, o.label, multiple)}
                                                    disabled={submitting}
                                                    title={o.description || undefined}
                                                    style={{
                                                        padding: '4px 10px',
                                                        fontSize: 12,
                                                        borderRadius: 14,
                                                        border: `1px solid ${isSel ? 'var(--accent)' : 'var(--card-border)'}`,
                                                        background: isSel ? 'var(--accent)' : 'var(--background)',
                                                        color: isSel ? 'var(--accent-foreground, #fff)' : 'var(--foreground)',
                                                        cursor: submitting ? 'default' : 'pointer',
                                                        fontFamily: 'inherit',
                                                    }}
                                                >
                                                    {o.label}
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                                {allowCustom && (
                                    <input
                                        type="text"
                                        value={custom[qi] || ''}
                                        onChange={(e) => setCustomAt(qi, e.target.value)}
                                        placeholder={
                                            opts.length > 0
                                                ? (isZh ? '或输入自定义回答…' : 'Or type a custom answer…')
                                                : (isZh ? '在这里输入回答…' : 'Type your answer…')
                                        }
                                        disabled={submitting}
                                        style={{
                                            width: '100%',
                                            padding: '6px 8px',
                                            border: '1px solid var(--card-border)',
                                            borderRadius: 4,
                                            fontSize: 12,
                                            fontFamily: 'inherit',
                                            background: 'var(--background)',
                                            color: 'var(--foreground)',
                                        }}
                                    />
                                )}
                            </div>
                        );
                    })}
                    <div style={{ display: 'flex', gap: 8 }}>
                        <button
                            className="ai-btn-sp"
                            onClick={() => submit('answer')}
                            disabled={submitting || !allFilled}
                            style={{ opacity: !allFilled ? 0.5 : 1 }}
                            title={!allFilled ? (isZh ? '请回答所有问题' : 'Answer all questions first') : undefined}
                        >
                            {submitting ? (isZh ? '提交中…' : 'Submitting…') : (isZh ? '提交' : 'Submit')}
                        </button>
                        <button className="ai-btn-s" onClick={() => submit('skip')} disabled={submitting}>
                            {isZh ? '全部跳过' : 'Skip all'}
                        </button>
                    </div>
                </>
            ) : (
                <>
                    <div style={{ marginBottom: 10, lineHeight: 1.6, whiteSpace: 'pre-wrap', color: 'var(--foreground-secondary)' }}>
                        {block.question}
                    </div>
                    <textarea
                        value={singleAnswer}
                        onChange={(e) => setSingleAnswer(e.target.value)}
                        placeholder={isZh ? '在这里输入回答…' : 'Type your answer…'}
                        rows={2}
                        style={{
                            width: '100%',
                            padding: '8px 10px',
                            border: '1px solid var(--card-border)',
                            borderRadius: 6,
                            fontSize: 13,
                            fontFamily: 'inherit',
                            resize: 'vertical',
                            marginBottom: 8,
                            background: 'var(--background)',
                            color: 'var(--foreground)',
                        }}
                        disabled={submitting}
                    />
                    <div style={{ display: 'flex', gap: 8 }}>
                        <button
                            className="ai-btn-sp"
                            onClick={() => submit('answer')}
                            disabled={submitting || !allFilled}
                            style={{ opacity: !allFilled ? 0.5 : 1 }}
                        >
                            {submitting ? (isZh ? '提交中…' : 'Submitting…') : (isZh ? '提交' : 'Submit')}
                        </button>
                        <button className="ai-btn-s" onClick={() => submit('skip')} disabled={submitting}>
                            {isZh ? '跳过' : 'Skip'}
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}

/**
 * "Skill ready to download" card, Claude-style. Renders at the very end
 * of an agent message once the agent declares the package complete.
 */
function DownloadCard({
    block, onDownload, onPreview, locale,
}: {
    block: Extract<Block, { kind: 'download' }>;
    onDownload: (skillName: string) => void;
    onPreview: () => void;
    locale: string;
}) {
    const isZh = locale === 'zh';
    const sizeText = block.sizeBytes != null
        ? block.sizeBytes < 1024
            ? `${block.sizeBytes} B`
            : `${(block.sizeBytes / 1024).toFixed(1)} KB`
        : null;

    return (
        <div
            className="download-card download-card-clickable"
            role="button"
            tabIndex={0}
            onClick={onPreview}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPreview(); } }}
            title={isZh ? '点击预览技能内容' : 'Click to preview skill contents'}
        >
            <div className="download-card-icon" aria-hidden>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                </svg>
            </div>
            <div className="download-card-info">
                <div className="download-card-name">{block.skillName}.zip</div>
                <div className="download-card-meta">
                    {block.fileCount} {isZh ? '个文件' : 'files'}
                    {sizeText && ` · ${sizeText}`}
                </div>
            </div>
            <button
                className="download-card-btn"
                onClick={(e) => { e.stopPropagation(); onDownload(block.skillName); }}
                title={isZh ? '下载技能包' : 'Download skill package'}
            >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                <span>{isZh ? '下载' : 'Download'}</span>
            </button>
        </div>
    );
}

/**
 * 解析用户消息内容，分离"对话正文"和"引用清单"两部分。
 *
 * 序列化时（见 composeFinalMessage）chip 被替换成 `[引用 N]` 占位符，正文末尾用
 * `---\n引用清单（...）：\n\n[引用1] `file` 第 N 行\n> 原文...` 形式带原文片段。
 * 用户气泡里我们只想看到 chip + 正文，不要展开原文——所以这里把 footer 拆出来，
 * 解析出每个 N → {fileName, lineRange}，正文部分把 `[引用 N]` 渲成 chip span。
 */
function parseUserMessageContent(content: string): {
    body: string;
    refsByIdx: Map<number, { fileName: string; lineRange: string; text?: string }>;
} {
    const refsByIdx = new Map<number, { fileName: string; lineRange: string; text?: string }>();
    // 兼容中英文两种 footer 前缀。注意冒号 zh 是全角"："，en 是半角":"——两个都收。
    const footerMatch = content.match(/\n\n---\n(?:引用清单|References)[^\n]*[：:]\s*\n\n([\s\S]+)$/);
    if (!footerMatch) {
        return { body: content, refsByIdx };
    }
    const body = content.slice(0, footerMatch.index ?? 0);
    const footer = footerMatch[1];
    // 每条引用块以 [引用 N] / [Ref N] 起头，到下一个起头或末尾结束
    const ENTRY_RE = /\[(?:引用|Ref\s+)(\d+)\]\s+`([^`]+)`\s+([^\n]+)\n([\s\S]*?)(?=\n\n\[(?:引用|Ref\s+)\d+\]|\s*$)/g;
    let m: RegExpExecArray | null;
    while ((m = ENTRY_RE.exec(footer)) !== null) {
        const idx = parseInt(m[1], 10);
        const fileName = m[2];
        const lineRange = m[3].trim();
        // 去掉 `> ` 前缀拿到原文（hover tooltip 用）
        const text = m[4]
            .split('\n')
            .map(l => l.replace(/^>\s?/, ''))
            .join('\n')
            .trim();
        refsByIdx.set(idx, { fileName, lineRange, text });
    }
    return { body: body.trimEnd(), refsByIdx };
}

/**
 * 把用户消息渲成"文本 + inline chip"。chip 用复用的 .chat-chip 样式，
 * 比 markdown 化的纯文本可读性高一档（文件名 + 行号一眼能扫到）。
 */
function UserMessageContent({ content, locale }: { content: string; locale: string }) {
    const { body, refsByIdx } = useMemo(() => parseUserMessageContent(content), [content]);
    const REF_RE = /\[(?:引用|Ref\s+)(\d+)\]/g;
    const nodes: React.ReactNode[] = [];
    let lastIdx = 0;
    let key = 0;
    const pushText = (s: string) => {
        if (!s) return;
        // \n → <br>，避免把多行用户消息挤成一行
        const parts = s.split('\n');
        parts.forEach((part, i) => {
            if (part) nodes.push(<span key={key++}>{part}</span>);
            if (i < parts.length - 1) nodes.push(<br key={key++} />);
        });
    };
    let m: RegExpExecArray | null;
    while ((m = REF_RE.exec(body)) !== null) {
        if (m.index > lastIdx) pushText(body.slice(lastIdx, m.index));
        const idx = parseInt(m[1], 10);
        const ref = refsByIdx.get(idx);
        if (ref) {
            nodes.push(
                <span
                    key={key++}
                    className="chat-chip chat-chip-bubble"
                    title={ref.text || ''}
                >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span className="chat-chip-name">{ref.fileName}</span>
                    <span className="chat-chip-lines">{ref.lineRange.replace(/^第\s*|\s*行$/g, '').replace(/^line[s]?\s+/i, '')}</span>
                </span>
            );
        } else {
            pushText(m[0]);
        }
        lastIdx = m.index + m[0].length;
    }
    if (lastIdx < body.length) pushText(body.slice(lastIdx));
    return <div className="message-markdown user-message-content">{nodes}</div>;
}

function FileIcon({ name }: { name: string }) {
    const isMd = name.endsWith('.md');
    const isSh = name.endsWith('.sh');
    const color = isMd ? '#3b82f6' : isSh ? '#10b981' : '#6b7280';
    return (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            {isMd
                ? <><path d="M2 2h7l3 3v7H2V2z" /><path d="M9 2v3h3" /><path d="M4 7h6M4 9.5h4" strokeWidth="1.2" /></>
                : isSh
                    ? <><path d="M2 2h10v10H2z" rx="1" /><path d="M4 5l2.5 2L4 9" /><path d="M7.5 9h2.5" /></>
                    : <><rect x="2" y="2" width="10" height="10" rx="1.5" /><path d="M4 5.5h6M4 7.5h6M4 9.5h4" strokeWidth="1.2" /></>
            }
        </svg>
    );
}

