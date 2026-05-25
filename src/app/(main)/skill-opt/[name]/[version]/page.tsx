'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { useLocale } from '@/lib/client/locale-context';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import { MarkdownText } from '@/components/thread/markdown-text';
import {
    ChatThinkingBlock,
    ChatToolBlock,
    type ToolBlockData,
    type ThinkingBlockData,
} from '@/components/chat/chat-blocks';
import '@/components/chat/chat-blocks.css';
import { hydrateSkillOptChat } from '@/lib/chat/hydrate-messages';
import { safeUUID } from '@/lib/safe-uuid';
import type { OptIssue, OptimizationIteration, SkillSummary } from '../../types';
import { FileDiff } from '../../_FileDiff';
import '../../skill-opt.css';

/**
 * 单条消息内的可视化块。一个 agent turn 由多个 block 顺序组成：
 *   [thinking, text, tool, text, tool, text(summary)]
 * 这种"一个气泡多 block"的结构跟 skill-generator 对齐——文本和工具按时间顺序穿插，
 * 不会出现"早期气泡吞掉所有文本，工具/思考块孤立在下面"的错位。
 */
type AgentBlock =
    | { kind: 'text'; id: string; text: string }
    | { kind: 'thinking'; id: string; text: string; done: boolean }
    | { kind: 'tool'; id: string; name: string; args?: any; status: 'running' | 'ok' | 'error'; summary?: string; error?: string }
    | { kind: 'error'; id: string; text: string };

type ChatTurn =
    | { kind: 'user'; id: string; text: string }
    | { kind: 'agent'; id: string; blocks: AgentBlock[]; streaming?: boolean };

export default function SkillOptimizePage() {
    const { t } = useLocale();
    const router = useRouter();
    const params = useParams<{ name: string; version: string }>();
    const skillName = decodeURIComponent(params.name);
    const baseVersion = Number(params.version);
    const { user } = useAuth();

    // 真实 skill 元数据：从 /api/skills?user= 拉用户全量再按 name 找。
    // 之前用 mock 里的 getSkillByName 只识别 pdf-extractor / doc-summarizer / chart-gen 三条假数据。
    const [skill, setSkill] = useState<SkillSummary | undefined>(undefined);
    useEffect(() => {
        if (!user) return;
        let cancelled = false;
        apiFetch(`/api/skills?user=${encodeURIComponent(user)}`)
            .then(r => r.json())
            .then((arr: unknown) => {
                if (cancelled) return;
                const list = Array.isArray(arr) ? (arr as SkillSummary[]) : [];
                setSkill(list.find(s => s.name === skillName));
            })
            .catch(() => { if (!cancelled) setSkill(undefined); });
        return () => { cancelled = true; };
    }, [user, skillName]);

    // base 版本的全量文件快照。3 处消费：
    //   1) startOptimize: 发给后端 agent 当 baselineFiles
    //   2) SSE 收尾兜底: agent 一次没推 vfs 时构造空草稿的兜底
    //   3) FileDiff: 多版本 diff 视图的"v{base}（原版本）"侧
    // 历史上用 mock 的 getSkillFiles 假数据；现在从 /api/skills/[id]/versions/[v] 拉真 SKILL.md +
    // 文件列表，对每个非 SKILL.md 路径并发拉单文件内容。
    const [baselineFiles, setBaselineFiles] = useState<Record<string, string> | null>(null);
    const [baselineLoading, setBaselineLoading] = useState(false);
    const [baselineError, setBaselineError] = useState<string | null>(null);

    useEffect(() => {
        if (!skill?.id || !Number.isInteger(baseVersion)) {
            setBaselineFiles(null);
            return;
        }
        const userQuery = user ? `?user=${encodeURIComponent(user)}` : '';
        let aborted = false;
        setBaselineLoading(true);
        setBaselineError(null);
        setBaselineFiles(null);

        (async () => {
            const detail = await apiFetch(
                `/api/skills/${skill.id}/versions/${baseVersion}${userQuery}`
            ).then(r => {
                if (!r.ok) throw new Error(`版本详情 HTTP ${r.status}`);
                return r.json();
            });

            let paths: string[] = ['SKILL.md'];
            try {
                const parsed = detail.files ? JSON.parse(detail.files) : null;
                if (Array.isArray(parsed) && parsed.length > 0) paths = parsed;
            } catch { /* 兜底用 ['SKILL.md'] */ }

            const others = paths.filter(p => p.toUpperCase() !== 'SKILL.MD');
            const results = await Promise.all(others.map(async p => {
                const encoded = p.split('/').map(encodeURIComponent).join('/');
                const r = await apiFetch(
                    `/api/skills/${skill.id}/versions/${baseVersion}/files/${encoded}${userQuery}`
                );
                if (!r.ok) {
                    console.warn(`[skill-opt] baseline file failed: ${p} (HTTP ${r.status})`);
                    return [p, ''] as const;
                }
                const j = await r.json();
                if (j.isText === false) return [p, `(binary file, ${j.size} bytes)`] as const;
                if (j.truncated) return [p, '(file too large, content truncated)'] as const;
                return [p, typeof j.content === 'string' ? j.content : ''] as const;
            }));

            if (aborted) return;
            const map: Record<string, string> = { 'SKILL.md': detail.content || '' };
            for (const [p, c] of results) map[p] = c;
            setBaselineFiles(map);
        })()
            .catch(err => {
                if (aborted) return;
                console.error('[skill-opt] baseline load failed:', err);
                setBaselineError(err?.message || String(err));
            })
            .finally(() => { if (!aborted) setBaselineLoading(false); });

        return () => { aborted = true; };
    }, [skill?.id, baseVersion, user]);

    const [issues, setIssues] = useState<OptIssue[]>([]);
    const [checkedIssueIds, setCheckedIssueIds] = useState<Set<string>>(new Set());
    // Cumulative set of issue ids that have been included in any past
    // optimization run for this page session. Used to mark them visually.
    const [optimizedIssueIds, setOptimizedIssueIds] = useState<Set<string>>(new Set());
    const [chat, setChat] = useState<ChatTurn[]>([]);
    const [input, setInput] = useState('');
    const [optimizing, setOptimizing] = useState(false);
    const [diffOpen, setDiffOpen] = useState(false);
    // 多个草稿的迭代历史（每次"开始优化"push 一个）
    const [iterations, setIterations] = useState<OptimizationIteration[]>([]);
    // 当前 diff 视图选中的"基线"和"对比"label。两者都可以是 'v{N}' 或 '草稿 #N'。
    const baseLabel = `v${baseVersion}`;
    const [selectedBase, setSelectedBase] = useState<string>(baseLabel);
    const [selectedCurrent, setSelectedCurrent] = useState<string>(baseLabel);
    // 当前活跃会话 id —— 持久化在 SkillOptSession 里。chat 路由用它作为 threadId
    // （workspace 复用 + opencode session 复用）；空字符串表示还没拿到 session 列表。
    const [currentSessionId, setCurrentSessionId] = useState<string>('');
    // 当前 (skill, baseVersion) 范围内的会话列表（按 updatedAt 倒序）
    interface SessionLite {
        id: string;
        title: string;
        updatedAt: string;
        iterationCount: number;        // 本地派生：iterations.length，供列表 tipLabel 用
        latestDraftNumber: number;     // 本地派生：iterations 最大 draftNumber
    }
    const [sessions, setSessions] = useState<SessionLite[]>([]);
    const [isHistoryOpen, setIsHistoryOpen] = useState(false);
    const [adopting, setAdopting] = useState(false);

    // ── 可调整布局：left / right 两侧宽度走 CSS 变量，middle flex:1
    // 实现思路与 skill-generator 一致：拖拽中只改 CSS 变量（不走 setState 避免每帧
    // 重渲染整页），松手时一次性 commit 到 state（触发 localStorage 写盘）。
    const LAYOUT_KEY = 'skill-opt:layout:v1';
    const [leftWidth, setLeftWidth] = useState(300);
    const [rightWidth, setRightWidth] = useState(560);
    const rootRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        try {
            const raw = localStorage.getItem(LAYOUT_KEY);
            if (!raw) return;
            const saved = JSON.parse(raw);
            if (typeof saved.leftWidth === 'number') setLeftWidth(saved.leftWidth);
            if (typeof saved.rightWidth === 'number') setRightWidth(saved.rightWidth);
        } catch { /* corrupt — fall back to defaults */ }
    }, []);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        document.documentElement.style.setProperty('--skopt-left-w', `${leftWidth}px`);
        document.documentElement.style.setProperty('--skopt-right-w', `${rightWidth}px`);
    }, [leftWidth, rightWidth]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        try {
            localStorage.setItem(LAYOUT_KEY, JSON.stringify({ leftWidth, rightWidth }));
        } catch { /* quota / disabled — silently skip */ }
    }, [leftWidth, rightWidth]);

    /**
     * 通用 resizer。
     * - 'left': 向右拖增大 left 宽度
     * - 'right': 向左拖增大 right 宽度（与拖动方向反向）
     * 全程改 CSS 变量；松手时 commit state。
     */
    const startResize = (kind: 'left' | 'right', e: React.PointerEvent) => {
        e.preventDefault();
        const startX = e.clientX;
        const startSize = kind === 'left' ? leftWidth : rightWidth;
        const setter = kind === 'left' ? setLeftWidth : setRightWidth;
        const cssVar = kind === 'left' ? '--skopt-left-w' : '--skopt-right-w';
        const min = 200;
        const max = 800;
        const root = document.documentElement;
        const container = rootRef.current;

        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        if (container) container.classList.add('dragging');

        let latestSize = startSize;
        let rafId = 0;
        const apply = () => {
            rafId = 0;
            root.style.setProperty(cssVar, `${latestSize}px`);
        };
        const onMove = (ev: PointerEvent) => {
            const dx = ev.clientX - startX;
            // right 列：往左拖（dx<0）应该增大宽度
            const delta = kind === 'left' ? dx : -dx;
            latestSize = Math.max(min, Math.min(max, startSize + delta));
            if (!rafId) rafId = requestAnimationFrame(apply);
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

    // ── 顶栏"预览"按钮：toggle 右侧 diff 面板。
    // 没有任何草稿 / 基线时不让点（开了也是 placeholder）。
    const hasPreviewableContent = iterations.length > 0 || Object.keys(baselineFiles ?? {}).length > 0;
    const togglePreview = () => {
        if (diffOpen) {
            setDiffOpen(false);
            return;
        }
        if (!hasPreviewableContent) return;
        setDiffOpen(true);
    };

    // 模型选择：与 skill-generator 同款——拉用户的 settings.configs，默认用 activeConfigId
    interface ModelConfigLite { id: string; name: string }
    const [modelConfigs, setModelConfigs] = useState<ModelConfigLite[]>([]);
    const [selectedModelId, setSelectedModelId] = useState<string>('');
    useEffect(() => {
        if (!user) return;
        fetch(`/api/settings?user=${encodeURIComponent(user)}`)
            .then(res => res.json())
            .then(data => {
                if (!data?.configs) return;
                setModelConfigs(data.configs);
                if (data.activeConfigId) setSelectedModelId(data.activeConfigId);
                else if (data.configs.length > 0) setSelectedModelId(data.configs[0].id);
            })
            .catch(() => { /* 静默：拉不到时按默认模型走 */ });
    }, [user]);

    // 真接口：拉 (skillName, baseVersion) 的 optimization points。
    // 后端 GET /api/skills/by-name/[name]/optimization-points 已经把 SkillIssue +
    // Evaluation 聚合后映射成 OptIssue 形态（含 category / improvementSuggestion /
    // source / occurrence），前端无需再二次 mapping。
    useEffect(() => {
        if (!skillName || !Number.isInteger(baseVersion)) { setIssues([]); return; }
        let aborted = false;
        const userQuery = user ? `&user=${encodeURIComponent(user)}` : '';
        const url = `/api/skills/by-name/${encodeURIComponent(skillName)}/optimization-points?version=${baseVersion}${userQuery}`;
        fetch(url)
            .then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json();
            })
            .then((data: { issues?: OptIssue[] }) => {
                if (aborted) return;
                setIssues(Array.isArray(data.issues) ? data.issues : []);
                setCheckedIssueIds(new Set());
                setOptimizedIssueIds(new Set());
            })
            .catch(err => {
                if (aborted) return;
                console.error('[skill-opt] failed to load issues:', err);
                setIssues([]);
            });
        return () => { aborted = true; };
    }, [skillName, baseVersion, user]);

    /**
     * 把后端 session detail（含 messages + iterations）灌进各个 state。
     * 用 useCallback 包以便在 effect 依赖里精确表达。
     */
    const applySessionDetail = useCallback((session: any) => {
        // chat 历史：messages → ChatTurn[]
        const turns = hydrateSkillOptChat(session.messages || []);
        setChat(turns as any);

        // iterations: 从持久化结构还原
        const persistedIters: OptimizationIteration[] = (session.iterations || []).map((it: any) => ({
            id: it.id,
            label: `草稿 #${it.draftNumber}`,
            baseVersion: session.baseVersion,
            createdAt: it.createdAt,
            summary: it.summary || '',
            files: (() => {
                try { return JSON.parse(it.files || '{}'); }
                catch { return {}; }
            })(),
        }));
        setIterations(persistedIters);

        // "已优化"标记：union 所有 iteration 处理过的 issue id
        const optimizedIds = new Set<string>();
        for (const it of session.iterations || []) {
            try {
                const ids = JSON.parse(it.resolvedIssueIds || '[]');
                if (Array.isArray(ids)) ids.forEach(id => optimizedIds.add(String(id)));
            } catch { /* ignore */ }
        }
        setOptimizedIssueIds(optimizedIds);
        setCheckedIssueIds(new Set());

        // diff viewer 默认选中最新 iteration（如果有），否则停在 base
        if (persistedIters.length > 0) {
            setSelectedCurrent(persistedIters[persistedIters.length - 1].label);
            setDiffOpen(true);
        } else {
            setSelectedCurrent(`v${baseVersion}`);
            setDiffOpen(false);
        }
        setSelectedBase(`v${baseVersion}`);
    }, [baseVersion]);

    /**
     * 拉当前 (user, skillName, baseVersion) 下所有会话，按 updatedAt 倒序。
     * 进页面时调一次 + 改名/删/新建/turn 结束后再调（让列表标题/iterationCount 同步）。
     */
    const fetchSessions = useCallback(async (): Promise<SessionLite[]> => {
        if (!user || !skill) return [];
        const url = `/api/skill-opt/sessions?user=${encodeURIComponent(user)}&skillName=${encodeURIComponent(skill.name)}&baseVersion=${baseVersion}`;
        try {
            const res = await fetch(url);
            const data = await res.json();
            const list: SessionLite[] = (data?.sessions || []).map((s: any) => {
                const iters = s.iterations || [];
                const maxDraft = iters.reduce((m: number, it: any) => Math.max(m, it.draftNumber || 0), 0);
                return {
                    id: s.id,
                    title: s.title || '新对话',
                    updatedAt: s.updatedAt,
                    iterationCount: iters.length,
                    latestDraftNumber: maxDraft,
                };
            });
            setSessions(list);
            return list;
        } catch (err) {
            console.warn('[skill-opt] fetchSessions failed:', err);
            return [];
        }
    }, [user, skill, baseVersion]);

    /**
     * 创建新会话 + 立刻切到。新建只 POST，不做 initial messages——首条用户消息由
     * chat/route.ts 在用户点"开始优化"时自动落库。
     */
    const handleNewChat = useCallback(async () => {
        if (!user || !skill) return null;
        try {
            const res = await fetch('/api/skill-opt/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user,
                    skillName: skill.name,
                    baseVersion,
                    title: '新对话',
                }),
            });
            const data = await res.json();
            if (data?.session?.id) {
                applySessionDetail(data.session);
                setCurrentSessionId(data.session.id);
                setIsHistoryOpen(false);
                await fetchSessions();
                return data.session.id as string;
            }
        } catch (err) {
            console.warn('[skill-opt] handleNewChat failed:', err);
        }
        return null;
    }, [user, skill, baseVersion, applySessionDetail, fetchSessions]);

    /**
     * 切到指定 session：fetch detail → apply。
     */
    const switchSession = useCallback(async (sessionId: string) => {
        try {
            const res = await fetch(`/api/skill-opt/sessions/${sessionId}`);
            const data = await res.json();
            if (data?.session) {
                applySessionDetail(data.session);
                setCurrentSessionId(sessionId);
                setIsHistoryOpen(false);
            }
        } catch (err) {
            console.warn('[skill-opt] switchSession failed:', err);
        }
    }, [applySessionDetail]);

    /**
     * 删 session。如果删的是当前 session，自动切到列表里下一条；都删完了起新对话。
     */
    const deleteSession = useCallback(async (e: React.MouseEvent, sessionId: string) => {
        e.stopPropagation();
        if (!confirm('删除这次优化记录？此操作不可恢复。')) return;
        try {
            await fetch(`/api/skill-opt/sessions/${sessionId}`, { method: 'DELETE' });
            const remaining = await fetchSessions();
            if (sessionId === currentSessionId) {
                if (remaining.length > 0) {
                    await switchSession(remaining[0].id);
                } else {
                    await handleNewChat();
                }
            }
        } catch (err) {
            console.warn('[skill-opt] deleteSession failed:', err);
        }
    }, [currentSessionId, fetchSessions, switchSession, handleNewChat]);

    /**
     * 进页面：拉 sessions 列表 → 有就切到最新一条，没有就 handleNewChat。
     * 仅在 (user, skill, baseVersion) 任一变化时跑——切版本相当于换一组会话。
     */
    useEffect(() => {
        if (!user || !skill) return;
        let cancelled = false;
        (async () => {
            const list = await fetchSessions();
            if (cancelled) return;
            if (list.length > 0) {
                await switchSession(list[0].id);
            } else {
                await handleNewChat();
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user, skill?.id, baseVersion]);

    const toggleIssue = (id: string) => {
        setCheckedIssueIds(prev => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    };

    /**
     * 从 agent turn 的 blocks 抠 markdown 总结作为优化报告主体。
     *
     * 优先级：
     *   1. 「## 修改总结」开头的 text block（按 prompt 设计 agent 应该有这个 marker）
     *   2. 最后一个 tool/error block 之后的所有 text block 拼起来（标准 trailing）
     *   3. 所有 text block 拼起来（兜底——agent 没收尾或把 summary 塞中段也能用）
     *
     * 纯函数：传入 blocks 返回 string。caller 通过 setChat callback 拿最新 blocks。
     */
    function extractTailText(blocks: AgentBlock[]): string {
        if (blocks.length === 0) return '';
        const textBlocks = blocks.filter(b => b.kind === 'text') as Array<Extract<AgentBlock, { kind: 'text' }>>;
        if (textBlocks.length === 0) return '';

        // 优先级 1：找含 "## 修改总结" 的 block，从那里开始拼
        const markerIdx = textBlocks.findIndex(b => /(^|\n)##\s*修改总结/.test(b.text));
        if (markerIdx >= 0) {
            const fromMarker = textBlocks.slice(markerIdx).map(b => b.text).join('\n\n');
            // 截断 marker 之前的引导文（如果 marker 不在 block 开头）
            const idx = fromMarker.indexOf('## 修改总结');
            return (idx >= 0 ? fromMarker.slice(idx) : fromMarker).trim();
        }

        // 优先级 2：trailing text blocks
        let cutoff = -1;
        for (let i = blocks.length - 1; i >= 0; i--) {
            const k = blocks[i].kind;
            if (k === 'tool' || k === 'error') { cutoff = i; break; }
        }
        const tail = blocks.slice(cutoff + 1).filter(b => b.kind === 'text') as Array<Extract<AgentBlock, { kind: 'text' }>>;
        const trailingJoined = tail.map(b => b.text).join('\n\n').trim();
        if (trailingJoined) return trailingJoined;

        // 优先级 3：兜底——所有 text block 拼起来
        return textBlocks.map(b => b.text).join('\n\n').trim();
    }

    /**
     * 把后端 SSE vfs_patch 的最终 files 转成 OptimizationIteration.files 形态。
     * 后端用 /workspace/<rel> 前缀且 content 是行数组；iteration 期望相对路径 + 字符串。
     */
    function vfsToIterationFiles(vfs: Record<string, { content: string[] | string }>): Record<string, string> {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(vfs)) {
            const rel = k.startsWith('/workspace/') ? k.slice('/workspace/'.length) : k;
            const text = Array.isArray(v.content) ? v.content.join('\n') : String(v.content || '');
            out[rel] = text;
        }
        return out;
    }

    const startOptimize = async () => {
        if (!skill || optimizing) return;
        if (checkedIssueIds.size === 0 && !input.trim()) return;
        // session 还没创建好（页面进入 → fetchSessions → handleNewChat 那个链路还在跑）就不发请求
        if (!currentSessionId) {
            console.warn('[skill-opt] startOptimize called before session ready');
            return;
        }

        const checked = issues.filter(i => checkedIssueIds.has(i.id));
        const userInputText = input.trim();

        // 1) push 用户消息 + 一个空 agent turn（streaming=true）
        //    后续所有 thinking / text / tool 事件都作为 block 追加到这个 turn 里
        const agentTurnId = safeUUID();
        setChat(prev => {
            const next: ChatTurn[] = [...prev];
            if (userInputText) next.push({ kind: 'user', id: safeUUID(), text: userInputText });
            next.push({ kind: 'agent', id: agentTurnId, blocks: [], streaming: true });
            return next;
        });
        if (userInputText) setInput('');
        setOptimizing(true);

        // 2) helpers
        const patchChat = (mutator: (turns: ChatTurn[]) => void) => {
            setChat(prev => {
                const next = [...prev];
                mutator(next);
                return next;
            });
        };
        // 找到当前 agent turn（按 id；不在的话返回 null，调用方自己兜底）
        const findAgentTurn = (turns: ChatTurn[]): { idx: number; turn: Extract<ChatTurn, { kind: 'agent' }> } | null => {
            const idx = turns.findIndex(t => t.kind === 'agent' && t.id === agentTurnId);
            if (idx === -1) return null;
            return { idx, turn: turns[idx] as Extract<ChatTurn, { kind: 'agent' }> };
        };
        const updateAgentTurn = (turns: ChatTurn[], blocks: AgentBlock[]) => {
            const found = findAgentTurn(turns);
            if (!found) return;
            turns[found.idx] = { ...found.turn, blocks };
        };
        // 在 agent turn 的 blocks 末尾追加；若末尾已经是同一类 block 且需要合并（text），直接累加 delta
        const appendOrCoalesceBlock = (turns: ChatTurn[], block: AgentBlock) => {
            const found = findAgentTurn(turns);
            if (!found) return;
            const blocks = [...found.turn.blocks];
            const last = blocks[blocks.length - 1];
            if (block.kind === 'text' && last?.kind === 'text') {
                blocks[blocks.length - 1] = { ...last, text: last.text + block.text };
            } else {
                blocks.push(block);
            }
            updateAgentTurn(turns, blocks);
        };
        // 找现有的 thinking/tool block 更新；找不到就 push
        const upsertBlock = (turns: ChatTurn[], blockId: string, kind: AgentBlock['kind'], updater: (existing: AgentBlock | null) => AgentBlock) => {
            const found = findAgentTurn(turns);
            if (!found) return;
            const blocks = [...found.turn.blocks];
            const idx = blocks.findIndex(b => b.kind === kind && b.id === blockId);
            if (idx === -1) {
                blocks.push(updater(null));
            } else {
                blocks[idx] = updater(blocks[idx]);
            }
            updateAgentTurn(turns, blocks);
        };

        // 3) 收尾时用：done 拿到的最终 vfs_patch files，构造一份 iteration push 进列表
        let latestFiles: Record<string, { content: string[] }> | null = null;
        // 后端是否推过任何"有内容的"事件（text / tool_call）。bridge 进来会先推一次基线 vfs_patch，
        // 仅凭 latestFiles 不为 null 不能说明 agent 真做过事——还要看是否有 text/tool。
        let agentDidWork = false;
        // 后端是否推过 error 事件——错了就不该再造草稿
        let streamErrored = false;

        // 起点文件：有草稿就基于最后一份草稿，否则从 base 版本真实文件出发。
        // baselineFiles state 已在页面 useEffect 里从 /api/skills/[id]/versions/[v] 拉好；
        // 「开始优化」按钮在它没就绪时是 disabled 的，所以这里能拿到非空 map。
        const startingFiles = iterations.length > 0
            ? iterations[iterations.length - 1].files
            : (baselineFiles ?? {});

        try {
            const resp = await fetch('/api/skill-opt/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user: user || 'anonymous',
                    threadId: currentSessionId,
                    skillName: skill.name,
                    baseVersion,
                    checkedIssues: checked.map(i => ({
                        id: i.id, severity: i.severity, category: i.category,
                        summary: i.summary, evidence: i.evidence,
                        improvementSuggestion: i.improvementSuggestion,
                    })),
                    userFeedback: userInputText,
                    baselineFiles: startingFiles,
                    modelId: selectedModelId || undefined,
                    mock: false,
                }),
            });
            if (!resp.ok || !resp.body) {
                throw new Error(`HTTP ${resp.status}`);
            }

            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const events = buffer.split('\n\n');
                buffer = events.pop() || '';

                // 一个 SSE chunk 通常打包多个事件，同步处理会被 React 18 自动 batching
                // 合并成一次 render——视觉上就是"一段段 append"。在每个 text/thinking
                // delta 之后让出一帧（setTimeout 0 = macrotask），强制 React 出帧再继续，
                // 这样字符就能逐 delta 蹦出来。tool_call / tool_result / vfs_patch 不需要这个
                // 节奏（它们一次性原子事件，无所谓出帧粒度），跳过 yield 省 4ms × N 开销。
                const yieldFrame = () => new Promise<void>(r => setTimeout(r, 0));

                for (const evt of events) {
                    if (!evt.startsWith('data: ')) continue;
                    let data: any;
                    try { data = JSON.parse(evt.slice(6)); } catch { continue; }

                    if (data.mode === 'text') {
                        agentDidWork = true;
                        const delta = String(data.payload ?? '');
                        patchChat(turns => {
                            appendOrCoalesceBlock(turns, {
                                kind: 'text', id: safeUUID(), text: delta,
                            });
                        });
                        await yieldFrame();
                    } else if (data.mode === 'thinking') {
                        const { id, delta, done: tDone } = data.payload || {};
                        if (!id) continue;
                        patchChat(turns => {
                            upsertBlock(turns, id, 'thinking', existing => {
                                if (!existing || existing.kind !== 'thinking') {
                                    return { kind: 'thinking', id, text: delta || '', done: !!tDone };
                                }
                                return {
                                    ...existing,
                                    text: existing.text + (delta || ''),
                                    done: tDone ? true : existing.done,
                                };
                            });
                        });
                        await yieldFrame();
                    } else if (data.mode === 'tool_call') {
                        agentDidWork = true;
                        const { id, name, args, status } = data.payload || {};
                        if (!id) continue;
                        patchChat(turns => {
                            upsertBlock(turns, id, 'tool', existing => {
                                if (!existing || existing.kind !== 'tool') {
                                    return {
                                        kind: 'tool', id,
                                        name: String(name || 'tool'),
                                        args,
                                        status: (status === 'ok' || status === 'error') ? status : 'running',
                                    };
                                }
                                // 重复 tool_call 事件 = bridge 在 delta phase 推送 input 增长。
                                // 必须更新 args（todowrite 这类大 args 工具靠它才能拼出完整 todos 数组）。
                                // 不要回退状态：已经 ok/error 不被新来的 'running' 覆盖。
                                return {
                                    ...existing,
                                    args: args ?? existing.args,
                                    name: existing.name || String(name || 'tool'),
                                    status: existing.status === 'running' && (status === 'ok' || status === 'error')
                                        ? status
                                        : existing.status,
                                };
                            });
                        });
                    } else if (data.mode === 'tool_result') {
                        const { id, status, summary, error } = data.payload || {};
                        if (!id) continue;
                        patchChat(turns => {
                            upsertBlock(turns, id, 'tool', existing => {
                                if (!existing || existing.kind !== 'tool') {
                                    // 罕见：result 先于 call 到（无序流）；占位一个 ok
                                    return {
                                        kind: 'tool', id, name: 'tool',
                                        status: status === 'error' ? 'error' : 'ok',
                                        summary, error,
                                    };
                                }
                                return {
                                    ...existing,
                                    status: status === 'error' ? 'error' : 'ok',
                                    summary: summary ?? existing.summary,
                                    error: error ?? existing.error,
                                };
                            });
                        });
                    } else if (data.mode === 'vfs_patch') {
                        if (data.payload?.files) {
                            latestFiles = data.payload.files;
                        }
                    } else if (data.mode === 'done') {
                        // 静默：实际收尾在 finally 里（覆盖正常 + 异常两路）
                    } else if (data.mode === 'error') {
                        streamErrored = true;
                        const errText = typeof data.payload === 'string' ? data.payload : JSON.stringify(data.payload);
                        patchChat(turns => {
                            // error 也作为 block 进 agent turn（保持顺序），找不到 turn 就降级为顶级用户级错误
                            const found = findAgentTurn(turns);
                            const errBlock: AgentBlock = { kind: 'error', id: safeUUID(), text: errText };
                            if (found) {
                                turns[found.idx] = { ...found.turn, blocks: [...found.turn.blocks, errBlock] };
                            }
                        });
                    }
                }
            }

            // ── 收尾 ───────────────────────────────────────────────────────
            // 后端报错（如 model 鉴权失败 / session 错误）就别造草稿——草稿应该是 agent 真改过的产物
            if (streamErrored) {
                // 错误块已在 stream 里 push 给 chat 了；保留勾选让用户可以改完模型/输入再点
                return;
            }
            // agent 啥都没干（既没 text 也没 tool 调用）也别造空草稿
            if (!agentDidWork) {
                patchChat(turns => {
                    const found = findAgentTurn(turns);
                    const errBlock: AgentBlock = {
                        kind: 'error', id: safeUUID(),
                        text: 'Agent 没有产生任何输出（可能是模型未配置或被中途取消）。',
                    };
                    if (found) {
                        turns[found.idx] = { ...found.turn, blocks: [...found.turn.blocks, errBlock] };
                    }
                });
                return;
            }

            // 把这批 issue 标记为"已优化"，清掉勾选，方便下一轮选新批次
            setOptimizedIssueIds(prev => {
                const next = new Set(prev);
                checked.forEach(i => next.add(i.id));
                return next;
            });
            setCheckedIssueIds(new Set());

            // 服务端置 resolvedAt，下次进来这些 id 不会再出现在优化点列表里。
            // best-effort：失败不影响本次会话已经有的"已优化"标记。
            if (skill && user && checked.length > 0) {
                apiFetch(
                    `/api/skills/by-name/${encodeURIComponent(skill.name)}/optimization-points/resolve`,
                    {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            user,
                            ids: checked.map(i => i.id),
                            threadId: currentSessionId,
                        }),
                    },
                ).catch(err => console.warn('[skill-opt] resolve points failed:', err));
            }

            // 用最终 vfs 构造一份 iteration；如果后端一次也没推 vfs（异常或空 workspace），
            // 退化用上一份草稿 / 真 baseline，避免列表里出现「空草稿」。
            const fallbackFiles = iterations.length > 0
                ? iterations[iterations.length - 1].files
                : (baselineFiles ?? {});
            const draftFiles = latestFiles
                ? vfsToIterationFiles(latestFiles)
                : fallbackFiles;

            // 从这次 agent turn 抠出"尾段文本" —— 最后一个工具调用之后的所有 text block 内容。
            // prompt 要求 agent 在 Step 3 收尾时输出"## 修改总结"开头的结构化 markdown，所以这段
            // 内容直接就是优化报告的主体。failed 兜底：如果 agent 完全没说话，用启发式短语。
            //
            // 通过 setChat callback 读最新 chat 状态——闭包里的 chat 变量是 startOptimize 启动时的
            // 旧值；SSE 流改了 N 次 state 后 React 还没把新值同步回闭包。
            let agentSummary = '';
            setChat(currentChat => {
                const turn = currentChat.find(t => t.kind === 'agent' && t.id === agentTurnId);
                if (turn && turn.kind === 'agent') {
                    agentSummary = extractTailText(turn.blocks);
                    // 调试日志：在 DevTools console 看 agent 实际产出的 block 形态，
                    // 帮诊断"summary 抠不到"是因为 agent 没说 / 说在了别处 / marker 不匹配
                    if (!agentSummary) {
                        console.warn('[skill-opt] no agent summary extracted. blocks:',
                            turn.blocks.map(b => ({
                                kind: b.kind,
                                preview: b.kind === 'text' || b.kind === 'thinking' || b.kind === 'error'
                                    ? (b.text || '').slice(0, 100)
                                    : (b.kind === 'tool' ? `${b.name}(${JSON.stringify(b.args).slice(0, 60)})` : '?'),
                            })));
                    }
                }
                return currentChat;  // 不改变 state，纯读
            });

            const draftNum = iterations.length + 1;
            const draft: OptimizationIteration = {
                id: `iter_${draftNum.toString().padStart(3, '0')}`,
                label: `草稿 #${draftNum}`,
                baseVersion,
                createdAt: new Date().toISOString(),
                summary: agentSummary || (checked.length > 0
                    ? `针对 ${checked.length} 个 issue 的优化结果（agent 未输出总结）`
                    : (userInputText ? '基于用户诉求的修改（agent 未输出总结）' : '本次未产生修改')),
                files: draftFiles,
            };
            setIterations(prev => [...prev, draft]);
            setSelectedCurrent(draft.label);
            setDiffOpen(true);

            // 后端持久化这份草稿（reload 后 diff viewer 能还原历次修改）。
            // 失败不致命——本地 state 已经 push 进 iterations，用户当下能看到；下次 reload 才会丢。
            try {
                const resp = await fetch(`/api/skill-opt/sessions/${currentSessionId}/iterations`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        summary: draft.summary,
                        files: draftFiles,
                        resolvedIssueIds: checked.map(i => i.id),
                    }),
                });
                if (!resp.ok) {
                    console.warn('[skill-opt] iteration persistence non-2xx:', resp.status);
                }
            } catch (err) {
                console.warn('[skill-opt] iteration persistence failed:', err);
            }
            // 顺手刷新 sessions 列表，让历史下拉里的 latestDraftNumber/title 同步
            fetchSessions();
        } catch (err: any) {
            patchChat(turns => {
                const found = findAgentTurn(turns);
                const errBlock: AgentBlock = {
                    kind: 'error', id: safeUUID(),
                    text: `请求失败：${err?.message || String(err)}`,
                };
                if (found) {
                    turns[found.idx] = { ...found.turn, blocks: [...found.turn.blocks, errBlock] };
                }
            });
        } finally {
            // agent turn 取消 streaming 标记
            patchChat(turns => {
                const found = findAgentTurn(turns);
                if (found) {
                    turns[found.idx] = { ...found.turn, streaming: false };
                }
            });
            setOptimizing(false);
        }
    };

    const sendMessage = () => {
        if (!input.trim()) return;
        setChat(c => [...c, { kind: 'user', id: safeUUID(), text: input.trim() }]);
        setInput('');
    };

    if (!skill) {
        return (
            <>
                <AppTopBar title={t('nav.skillOpt')} />
                <div className="skopt-not-found">
                    找不到 skill：<code>{skillName}</code>
                    <button onClick={() => router.push('/skill-opt')}>返回列表</button>
                </div>
            </>
        );
    }

    const breadcrumb = (
        <span className="skopt-crumb">
            <a className="crumb-link" onClick={() => router.push('/skill-opt')}>
                {t('nav.skillOpt')}
            </a>
            <span className="sep">/</span>
            <span className="crumb-name">{skill.name}</span>
            <span className="sep">/</span>
            <select
                className="crumb-version"
                value={baseVersion}
                onChange={e => router.push(`/skill-opt/${encodeURIComponent(skill.name)}/${e.target.value}`)}
            >
                {skill.versions.map(ver => (
                    <option key={ver.version} value={ver.version}>
                        v{ver.version}
                        {ver.version === skill.activeVersion ? ' (当前)' : ''}
                    </option>
                ))}
            </select>
        </span>
    );

    /**
     * 历史记录按钮 + dropdown（mirror skill-generator 的 history 控件）。
     * 列表项 tipLabel：有 iteration → "v1 → 草稿 #N"，没有 → "v1 → 新对话"。
     */
    const buildSessionTipLabel = (s: SessionLite): string => {
        if (s.latestDraftNumber > 0) return `v${baseVersion} → 草稿 #${s.latestDraftNumber}`;
        return `v${baseVersion} → 新对话`;
    };
    const historyControls = (
        <div className="skopt-history-controls">
            {/* 预览按钮：toggle 右侧 diff 面板。没草稿/没基线时 disabled（开了也是空壳）。
                与 skill-generator 顶栏 "预览" 同款，避免用户关掉面板后只能等下次 startOptimize 才能再次打开。 */}
            <button
                className="ai-btn-s skopt-preview-btn"
                onClick={togglePreview}
                disabled={!diffOpen && !hasPreviewableContent}
                title={
                    !diffOpen && !hasPreviewableContent
                        ? '暂无可预览的文件'
                        : diffOpen ? '关闭预览' : '打开预览'
                }
            >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 4 }}>
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                    <line x1="15" y1="4" x2="15" y2="20" />
                </svg>
                {diffOpen ? '关闭预览' : '预览'}
            </button>
            <button className="ai-btn-s skopt-new-chat-btn" onClick={() => handleNewChat()}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 4 }}>
                    <path d="M12 5v14M5 12h14" />
                </svg>
                新建对话
            </button>
            <div className="skopt-history-dropdown-wrapper">
                <button className="ai-btn-s skopt-history-btn" onClick={() => setIsHistoryOpen(o => !o)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 4 }}>
                        <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    优化记录
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginLeft: 4 }}>
                        <path d="M19 9l-7 7-7-7" />
                    </svg>
                </button>
                {isHistoryOpen && (
                    <div className="skopt-history-menu">
                        <div className="skopt-history-list">
                            {sessions.map(s => (
                                <div
                                    key={s.id}
                                    className={`skopt-history-item ${currentSessionId === s.id ? 'active' : ''}`}
                                    onClick={() => switchSession(s.id)}
                                >
                                    <div className="skopt-history-item-content">
                                        <div className="skopt-history-item-title">{s.title}</div>
                                        <div className="skopt-history-item-meta">
                                            <span className="skopt-history-item-version">{buildSessionTipLabel(s)}</span>
                                            <span className="skopt-history-item-date">{new Date(s.updatedAt).toLocaleString()}</span>
                                        </div>
                                    </div>
                                    <button className="skopt-history-item-delete" onClick={(e) => deleteSession(e, s.id)}>
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
                                    </button>
                                </div>
                            ))}
                            {sessions.length === 0 && (
                                <div className="skopt-history-empty">暂无优化记录</div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );

    return (
        <>
            <AppTopBar title={breadcrumb} actions={historyControls} showDefaultActions={false} />
            <div className="skopt-root" ref={rootRef}>
                {/* ───── Left: issues only (no search — skill is fixed) ───── */}
                <aside className="skopt-left">
                    <div className="issues">
                        <h4>可优化点 ({issues.length})</h4>
                        {issues.length === 0 && <div className="empty">暂无可优化点</div>}
                        {issues.map(it => {
                            const isOptimized = optimizedIssueIds.has(it.id);
                            const cls = [
                                'issue-row',
                                checkedIssueIds.has(it.id) && 'checked',
                                isOptimized && 'optimized',
                            ].filter(Boolean).join(' ');
                            return (
                                <div
                                    key={it.id}
                                    className={cls}
                                    onClick={() => toggleIssue(it.id)}
                                    title={it.evidence}
                                >
                                    <input
                                        type="checkbox"
                                        checked={checkedIssueIds.has(it.id)}
                                        onChange={() => toggleIssue(it.id)}
                                        onClick={e => e.stopPropagation()}
                                    />
                                    <div className="body">
                                        <div className="line1">
                                            <span className={`severity ${it.severity}`}>{it.severity}</span>
                                            <span className="summary">{it.summary}</span>
                                            {isOptimized && <span className="done-tag">已优化</span>}
                                        </div>
                                        {it.improvementSuggestion && (
                                            <div className="suggestion" title="评估器给出的改进建议">
                                                💡 {it.improvementSuggestion}
                                            </div>
                                        )}
                                        {it.source && (
                                            it.source.url
                                                ? <a
                                                    className="source"
                                                    href={it.source.url}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    onClick={e => e.stopPropagation()}
                                                    title={`来源 · ${it.source.kind}`}
                                                  >
                                                    🔗 {it.source.label}
                                                  </a>
                                                : <span className="source no-link" title={`来源 · ${it.source.kind}`}>
                                                    📌 {it.source.label}
                                                  </span>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    <div className="actions">
                        <div className="model-picker">
                            <label>模型</label>
                            <select
                                value={selectedModelId}
                                onChange={e => setSelectedModelId(e.target.value)}
                                disabled={optimizing}
                            >
                                {modelConfigs.length === 0 && <option value="">默认</option>}
                                {modelConfigs.map(c => (
                                    <option key={c.id} value={c.id}>{c.name}</option>
                                ))}
                            </select>
                        </div>
                        <button
                            disabled={
                                (checkedIssueIds.size === 0 && !input.trim())
                                || optimizing
                                || baselineLoading
                                || !baselineFiles
                            }
                            onClick={startOptimize}
                            title={
                                baselineLoading
                                    ? '正在加载 base 版本文件…'
                                    : baselineError
                                        ? `base 版本加载失败：${baselineError}`
                                        : undefined
                            }
                        >
                            {optimizing
                                ? '优化中…'
                                : baselineLoading
                                    ? '加载基线…'
                                    : `开始优化 (${checkedIssueIds.size})`}
                        </button>
                    </div>
                </aside>

                {/* left ↔ middle resizer */}
                <div
                    className="skopt-resizer"
                    onPointerDown={e => startResize('left', e)}
                    title="拖动调整宽度"
                />

                {/* ───── Middle: chat ───── */}
                <main className="skopt-middle">
                    <div className="chat-log">
                        {chat.length === 0 && (
                            <div className="empty">
                                {`已选 ${skill.name} v${baseVersion}。勾选左侧问题或在下方描述你的诉求。`}
                            </div>
                        )}
                        {chat.map(turn => {
                            if (turn.kind === 'user') {
                                return <div key={turn.id} className="msg user">{turn.text}</div>;
                            }
                            // agent turn：一个气泡里按顺序渲染所有 blocks（thinking/text/tool/error）
                            const empty = turn.blocks.length === 0;
                            return (
                                <div key={turn.id} className={`msg agent${turn.streaming ? ' streaming' : ''}`}>
                                    {empty && turn.streaming && <span className="agent-placeholder">…</span>}
                                    {turn.blocks.map(b => {
                                        if (b.kind === 'text') {
                                            return (
                                                <div key={b.id} className="agent-text-block">
                                                    <MarkdownText>{b.text}</MarkdownText>
                                                </div>
                                            );
                                        }
                                        if (b.kind === 'thinking') {
                                            const data: ThinkingBlockData = { id: b.id, text: b.text, done: b.done };
                                            return <ChatThinkingBlock key={b.id} block={data} locale="zh" />;
                                        }
                                        if (b.kind === 'tool') {
                                            const data: ToolBlockData = {
                                                id: b.id, name: b.name, args: b.args,
                                                status: b.status, summary: b.summary, error: b.error,
                                            };
                                            return <ChatToolBlock key={b.id} block={data} locale="zh" />;
                                        }
                                        // error block in-line
                                        return <div key={b.id} className="agent-error-block">⚠ {b.text}</div>;
                                    })}
                                </div>
                            );
                        })}
                    </div>
                    <div className="input-bar">
                        <textarea
                            value={input}
                            onChange={e => setInput(e.target.value)}
                            onKeyDown={e => {
                                // 中文/日文 IME 组字时按 Enter 是"上屏"，不应触发发送
                                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                                    e.preventDefault();
                                    sendMessage();
                                }
                            }}
                            placeholder="补充优化诉求，Enter 发送 / Shift+Enter 换行"
                        />
                        <button onClick={sendMessage}>发送</button>
                    </div>
                </main>

                {/* middle ↔ right resizer (仅在 diff 面板展开时显示) */}
                {diffOpen && (
                    <div
                        className="skopt-resizer"
                        onPointerDown={e => startResize('right', e)}
                        title="拖动调整宽度"
                    />
                )}

                {/* ───── Right: diff (collapsible, in-browser Monaco) ───── */}
                <section className={`skopt-right ${diffOpen ? 'open' : ''}`}>
                    {diffOpen && (
                        <>
                            <div className="header">
                                <span>多版本 diff</span>
                                <button className="close" onClick={() => setDiffOpen(false)}>✕</button>
                            </div>
                            {iterations.length === 0 ? (
                                <div className="placeholder">尚未产生草稿，点左侧「开始优化」生成第一份。</div>
                            ) : (
                                <FileDiff
                                    skillName={skill.name}
                                    baseVersion={baseVersion}
                                    baseFiles={baselineFiles ?? {}}
                                    iterations={iterations}
                                    selectedBase={selectedBase}
                                    selectedCurrent={selectedCurrent}
                                    onChangeBase={setSelectedBase}
                                    onChangeCurrent={setSelectedCurrent}
                                    onRollback={(label) => {
                                        // 删掉该草稿之后的所有迭代
                                        const idx = iterations.findIndex(i => i.label === label);
                                        if (idx === -1) return;
                                        if (idx < iterations.length - 1) {
                                            const ok = confirm(`回退到「${label}」将丢弃之后的 ${iterations.length - 1 - idx} 份草稿，确定？`);
                                            if (!ok) return;
                                        }
                                        setIterations(prev => prev.slice(0, idx + 1));
                                        setSelectedCurrent(label);
                                    }}
                                    onAdopt={async (label) => {
                                        if (adopting) return;
                                        if (!currentSessionId) {
                                            alert('当前会话尚未就绪，请稍后再试。');
                                            return;
                                        }
                                        // label 形如 "草稿 #N"——后端按 draftNumber 定位 iteration
                                        const m = label.match(/#(\d+)/);
                                        const draftNumber = m ? Number(m[1]) : NaN;
                                        if (!Number.isInteger(draftNumber) || draftNumber <= 0) {
                                            alert(`无法解析草稿编号: ${label}`);
                                            return;
                                        }
                                        const ok = confirm(`将「${label}」发布为 ${skill.name} 的 v${baseVersion + 1}？发布后本次会话的所有草稿历史会被清空。`);
                                        if (!ok) return;
                                        setAdopting(true);
                                        try {
                                            const res = await apiFetch(
                                                `/api/skill-opt/sessions/${currentSessionId}/iterations/${draftNumber}/apply`,
                                                {
                                                    method: 'POST',
                                                    headers: { 'Content-Type': 'application/json' },
                                                    body: JSON.stringify({ user }),
                                                }
                                            );
                                            const data = await res.json().catch(() => ({}));
                                            if (!res.ok || !data?.success) {
                                                alert(`发布失败：${data?.error || res.statusText}`);
                                                return;
                                            }
                                            // 草稿历史后端已删；本地状态也同步清掉，避免离开前闪烁
                                            setIterations([]);
                                            setSelectedBase(`v${baseVersion}`);
                                            setSelectedCurrent(`v${baseVersion}`);
                                            setDiffOpen(false);
                                            router.push('/skill-opt');
                                        } catch (err: any) {
                                            alert(`发布出错：${err?.message || err}`);
                                        } finally {
                                            setAdopting(false);
                                        }
                                    }}
                                />
                            )}
                        </>
                    )}
                </section>
            </div>
        </>
    );
}

