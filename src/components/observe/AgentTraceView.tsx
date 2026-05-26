'use client';

import React, { ReactNode, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy as CopyIcon, Search as SearchIcon, X as XIcon, AlertTriangle as AlertIcon, SlidersHorizontal as FiltersIcon } from 'lucide-react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SmartViewer } from '@/components/SmartViewer';
import { SkillLink } from '@/components/skills/SkillLink';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import { useLocale } from '@/lib/client/locale-context';
import { SPAN_KIND_CLASSES } from '@/lib/charts/palette';
import { cn } from '@/lib/utils';
import {
    AgentEvent,
    AgentNode,
    buildAgentCallTree,
    findNode,
    formatDuration,
    formatTokens,
    InteractionUsage,
    RawInteraction,
    ToolCall,
    walkTree,
} from '@/lib/engine/observability/agent-trace';
import {
    extractSkillsWithVersionsFromClaudeSession,
    extractSkillsWithVersionsFromOpenClawSession,
    extractSkillsWithVersionsFromOpencodeSession,
    normalizeInteractions,
} from '@/lib/shared/interaction-utils';

const SLOW_MS = 60_000;

type NodeStatus = 'error' | 'slow' | 'ok';

function getStatus(node: AgentNode): NodeStatus {
    if (node.stats?.durationMs !== undefined && node.stats.durationMs > SLOW_MS) return 'slow';
    return 'ok';
}

// docs/design/foundations.md §2 B.4 — status uses semantic tokens, never hardcoded hex.
const STATUS_TEXT: Record<NodeStatus, string> = {
    ok:    'text-foreground-muted',
    slow:  'text-warning',
    error: 'text-error',
};
const STATUS_DOT: Record<NodeStatus, string> = {
    ok:    'bg-foreground-muted',
    slow:  'bg-warning',
    error: 'bg-error',
};

// docs/design/components.md §2 E.13 — span types color-coded per chart palette 1-4 (+ violet for Skill).
const KIND_META: Record<string, { label: string; chip: string; bar: string; text: string }> = {
    agent: { label: 'AGENT', ...SPAN_KIND_CLASSES.agent },
    task:  { label: 'TASK',  ...SPAN_KIND_CLASSES.task },
    tool:  { label: 'TOOL',  ...SPAN_KIND_CLASSES.tool },
    skill: { label: 'SKILL', ...SPAN_KIND_CLASSES.skill },
    llm:   { label: 'LLM',   ...SPAN_KIND_CLASSES.llm },
    user:  { label: 'USER',  ...SPAN_KIND_CLASSES.user },
};

// Single source of truth for span-type chips (replaces the legacy inline-styled span badges).
function KindBadge({ kind, size = 'xs', className }: { kind: string; size?: 'xs' | 'sm'; className?: string }) {
    const meta = KIND_META[kind] ?? KIND_META.tool;
    const sizing = size === 'sm' ? 'h-5 px-1.5 text-xs' : 'h-4 px-1 text-[10px]';
    return (
        <span
            className={cn(
                'inline-flex items-center justify-center rounded-sm border font-bold uppercase tracking-wider whitespace-nowrap shrink-0',
                sizing,
                meta.chip,
                className,
            )}
        >
            {meta.label}
        </span>
    );
}

type DetailTab = 'timeline' | 'prompt' | 'overview' | 'skills';
type EventTypeFilter = 'all' | 'llm' | 'tool' | 'skill' | 'task' | 'user';

interface TraceSkillCall {
    name: string;
    version: number | null;
}

interface ManagedSkillAsset {
    id: string;
    name: string;
    activeVersion?: number | null;
    version?: number | null;
}

interface TraceSkillUsage {
    name: string;
    reportedVersion: number | null;
    displayVersion: number | null;
    versionSource: 'reported' | 'active' | 'unknown';
    asset: ManagedSkillAsset | null;
    status: 'managed' | 'unregistered';
}

// Selection key: 'a:{nodeId}' for agents, 'e:{nodeId}:{evIdx}' for events
const agentKey = (id: string) => `a:${id}`;
const eventKey = (nodeId: string, idx: number) => `e:${nodeId}:${idx}`;

/**
 * 复制文本到剪贴板,带 fallback。
 *
 * navigator.clipboard.writeText 会在以下场景 throw:
 *   - document 没 focus (用户 focus 在 DevTools / 别的窗口) → NotAllowedError
 *   - 非 secure context (HTTP, 非 localhost) → 接口 undefined
 *   - 某些 iframe 嵌套场景
 *
 * fallback: 隐藏 textarea + document.execCommand('copy') —— deprecated 但
 * 兼容性极好 (所有浏览器都支持,不依赖 secure context / focus 状态)。
 */
async function copyText(text: string): Promise<void> {
  // 先试 modern clipboard API
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (e) {
      // 常见 root cause: 'Document is not focused' (DevTools 抢焦点 / 弹窗丢焦点 等)
      console.warn('[copyText] clipboard.writeText failed, fallback to execCommand:',
        (e as Error)?.message || e);
    }
  }
  // Fallback: 隐藏 textarea + execCommand
  if (typeof document === 'undefined') throw new Error('no document available');
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  ta.setAttribute('readonly', '');
  document.body.appendChild(ta);
  ta.select();
  try {
    const ok = document.execCommand('copy');
    if (!ok) throw new Error('execCommand("copy") returned false');
  } finally {
    document.body.removeChild(ta);
  }
}

// Build nodeId → AgentNode map for the whole tree
function buildNodeMap(root: AgentNode): Map<string, AgentNode> {
    const map = new Map<string, AgentNode>();
    walkTree(root, n => map.set(n.id, n));
    return map;
}

// Build default expanded keys: all agents + task events at depth ≤ 1
function buildDefaultExpandedKeys(root: AgentNode): Set<string> {
    const keys = new Set<string>();
    const visit = (node: AgentNode, depth: number) => {
        keys.add(agentKey(node.id));
        if (depth <= 1) {
            node.events.forEach((ev, idx) => {
                if (ev.kind === 'task' && ev.spawnedChildId) keys.add(eventKey(node.id, idx));
            });
        }
        node.children.forEach(c => visit(c, depth + 1));
    };
    visit(root, 0);
    return keys;
}

function aggregateSubtreeStats(node: AgentNode) {
    const stats = {
        interactions: node.stats.interactions,
        llmCalls: node.stats.llmCalls,
        toolCalls: node.stats.toolCalls,
        skillCalls: node.stats.skillCalls,
        taskCalls: node.stats.taskCalls,
        inputTokens: node.stats.inputTokens,
        outputTokens: node.stats.outputTokens,
        cacheReadTokens: node.stats.cacheReadTokens,
        cacheWriteTokens: node.stats.cacheWriteTokens,
        reasoningTokens: node.stats.reasoningTokens,
        totalTokens: node.stats.totalTokens,
    };
    for (const child of node.children) {
        const c = aggregateSubtreeStats(child);
        stats.interactions += c.interactions;
        stats.llmCalls += c.llmCalls;
        stats.toolCalls += c.toolCalls;
        stats.skillCalls += c.skillCalls;
        stats.taskCalls += c.taskCalls;
        stats.inputTokens += c.inputTokens;
        stats.outputTokens += c.outputTokens;
        stats.cacheReadTokens += c.cacheReadTokens;
        stats.cacheWriteTokens += c.cacheWriteTokens;
        stats.reasoningTokens += c.reasoningTokens;
        stats.totalTokens += c.totalTokens;
    }
    return stats;
}

function normalizeSkillVersion(version: unknown): number | null {
    if (version === null || version === undefined || version === '') return null;
    const n = Number(version);
    return Number.isFinite(n) ? n : null;
}

function collectSubtreeInteractionIndices(node: AgentNode | null | undefined): Set<number> | null {
    if (!node) return null;
    const indices = new Set<number>();
    const visit = (n: AgentNode) => {
        n.interactionIndices.forEach(i => indices.add(i));
        n.children.forEach(visit);
    };
    visit(node);
    return indices;
}

function collectTraceSkillCalls(interactions: RawInteraction[], node?: AgentNode | null): TraceSkillCall[] {
    if (!Array.isArray(interactions) || interactions.length === 0) return [];
    const subtreeIndices = collectSubtreeInteractionIndices(node);
    const sourceInteractions = subtreeIndices
        ? interactions.filter((_, index) => subtreeIndices.has(index))
        : interactions;
    if (sourceInteractions.length === 0) return [];

    const normalized = normalizeInteractions(sourceInteractions);
    const extracted = [
        ...extractSkillsWithVersionsFromOpencodeSession(normalized),
        ...extractSkillsWithVersionsFromClaudeSession(normalized),
        ...extractSkillsWithVersionsFromOpenClawSession(normalized),
    ];

    const byKey = new Map<string, TraceSkillCall>();
    const unknownByName = new Map<string, string>();

    for (const item of extracted) {
        const name = item?.name?.trim();
        if (!name) continue;
        const version = normalizeSkillVersion(item.version);
        const normalizedName = name.toLowerCase();
        const key = `${normalizedName}::${version ?? 'unknown'}`;
        if (!byKey.has(key)) {
            byKey.set(key, { name, version });
        }
        if (version === null && !unknownByName.has(normalizedName)) {
            unknownByName.set(normalizedName, key);
        }
    }

    // Prefer explicit versions over an additional "unknown" row for the same skill.
    for (const call of byKey.values()) {
        if (call.version !== null) {
            const unknownKey = unknownByName.get(call.name.toLowerCase());
            if (unknownKey) byKey.delete(unknownKey);
        }
    }

    return Array.from(byKey.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function resolveTraceSkillUsages(calls: TraceSkillCall[], assets: ManagedSkillAsset[]): TraceSkillUsage[] {
    const assetsByName = new Map<string, ManagedSkillAsset>();
    for (const asset of assets) {
        if (asset?.name) assetsByName.set(asset.name.toLowerCase(), asset);
    }

    const deduped = new Map<string, TraceSkillUsage>();
    for (const call of calls) {
        const asset = assetsByName.get(call.name.toLowerCase()) || null;
        const activeVersion = normalizeSkillVersion(asset?.activeVersion ?? asset?.version);
        const displayVersion = call.version ?? activeVersion;
        const usage: TraceSkillUsage = {
            name: call.name,
            reportedVersion: call.version,
            displayVersion,
            versionSource: call.version !== null ? 'reported' : activeVersion !== null ? 'active' : 'unknown',
            asset,
            status: asset ? 'managed' : 'unregistered',
        };
        const key = `${usage.name.toLowerCase()}::${usage.displayVersion ?? 'unknown'}::${usage.status}`;
        const existing = deduped.get(key);
        if (!existing || (existing.versionSource !== 'reported' && usage.versionSource === 'reported')) {
            deduped.set(key, usage);
        }
    }

    return Array.from(deduped.values()).sort((a, b) => {
        if (a.status !== b.status) return a.status === 'managed' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
}

// ─── Trace Search / Filter Context ───────────────────────────────────────────
interface SpanInfo {
    key: string;
    label: string;
    kind: string;
    durationMs?: number;
    tokens?: number;
    isSlow: boolean;
    searchText: string;
    parentKeys: string[];
}

interface TraceCtxValue {
    searchQuery: string;
    matchedKeys: Set<string>;
    activeMatchKey: string | null;
    treeKindFilter: string;
    minDurationMs: number;
    minTokenK: number;
    slowOnly: boolean;
    onJumpToKey: (key: string) => void;
    topNDuration: SpanInfo[];
    topNTokens: SpanInfo[];
    slowNodesList: SpanInfo[];
    /** sub-agent 节点上"打开独立 trace"按钮的点击回调；未注入则不渲染按钮 */
    onSubagentNavigate?: (sessionId: string) => void;
}

const defaultCtx: TraceCtxValue = {
    searchQuery: '', matchedKeys: new Set(), activeMatchKey: null,
    treeKindFilter: 'all', minDurationMs: 0, minTokenK: 0, slowOnly: false,
    onJumpToKey: () => {},
    topNDuration: [], topNTokens: [], slowNodesList: [],
    onSubagentNavigate: undefined,
};
const TraceCtx = React.createContext<TraceCtxValue>(defaultCtx);

export interface AgentTraceViewProps {
    interactions: RawInteraction[];
    /**
     * 点击 sub-agent 节点旁的跳转按钮触发。
     * sessionId 即 sub-agent 的 sessionID，等同于 Execution.taskId。
     * 父组件接管路由（一般走 router.push(`/trace?taskId=${sessionId}`)），
     * 不传则不渲染跳转按钮。
     */
    onSubagentNavigate?: (sessionId: string) => void;
}

export default function AgentTraceView({ interactions, onSubagentNavigate }: AgentTraceViewProps) {
    const { user } = useAuth();
    const { t: tt } = useLocale();
    const tree = useMemo(() => buildAgentCallTree(interactions || []), [interactions]);
    const nodeMap = useMemo(() => tree ? buildNodeMap(tree) : new Map<string, AgentNode>(), [tree]);
    const traceSkillCalls = useMemo(() => collectTraceSkillCalls(interactions || []), [interactions]);
    const [managedSkillAssets, setManagedSkillAssets] = useState<ManagedSkillAsset[]>([]);

    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
    const [activeDetailTab, setActiveDetailTab] = useState<DetailTab>('overview');
    const [eventTypeFilter, setEventTypeFilter] = useState<EventTypeFilter>('all');
    // docs/design/patterns.md §11 — slow-only flag persisted to URL so reload preserves user intent.
    const [slowOnlyParam, setSlowOnlyParam] = useQueryState('slowOnly', parseAsString);
    const slowOnly = slowOnlyParam === '1';
    const setSlowOnly = (v: boolean | ((p: boolean) => boolean)) => {
        const next = typeof v === 'function' ? v(slowOnly) : v;
        setSlowOnlyParam(next ? '1' : null);
    };

    // ── Search + extended filter state ──────────────────────────────────────
    const [searchQuery, setSearchQuery] = useState('');
    const [searchMatchIdx, setSearchMatchIdx] = useState(0);
    const [treeKindFilter, setTreeKindFilter] = useState('all');
    const [minDurationMs, setMinDurationMs] = useState(0);
    const [minTokenK, setMinTokenK] = useState(0);
    const [showFilters, setShowFilters] = useState(false);
    const searchInputRef = React.useRef<HTMLInputElement>(null);

    const defaultExpandedKeys = useMemo(() => tree ? buildDefaultExpandedKeys(tree) : new Set<string>(), [tree]);

    useEffect(() => {
        if (traceSkillCalls.length === 0) {
            setManagedSkillAssets([]);
            return;
        }
        let cancelled = false;
        const suffix = user ? `?user=${encodeURIComponent(user)}` : '';
        apiFetch(`/api/skills${suffix}`)
            .then(res => res.ok ? res.json() : [])
            .then(data => {
                if (cancelled) return;
                setManagedSkillAssets(Array.isArray(data) ? data : []);
            })
            .catch(() => {
                if (!cancelled) setManagedSkillAssets([]);
            });
        return () => {
            cancelled = true;
        };
    }, [traceSkillCalls.length, user]);

    useEffect(() => {
        if (!tree) return;
        setSelectedKey(agentKey(tree.id));
        setExpandedKeys(defaultExpandedKeys);
    }, [tree, defaultExpandedKeys]);

    const totalStats = useMemo(() => {
        if (!tree) return null;
        let agents = 0, tasks = 0, tools = 0, skills = 0, llm = 0, tokens = 0;
        walkTree(tree, n => {
            agents++;
            tasks += n.stats.taskCalls;
            tools += n.stats.toolCalls;
            skills += n.stats.skillCalls;
            llm += n.stats.llmCalls;
            tokens += n.stats.totalTokens;
        });
        return { agents, tasks, tools, skills, llm, tokens };
    }, [tree]);

    const totalStart = tree?.startedAt;
    const totalDuration = tree?.stats.durationMs;

    // Resolve selected node/event for right panel
    const { selectedAgentNode, selectedEvent } = useMemo(() => {
        if (!tree) return { selectedAgentNode: null, selectedEvent: null };
        if (!selectedKey) return { selectedAgentNode: tree, selectedEvent: null };
        if (selectedKey.startsWith('a:')) {
            const nodeId = selectedKey.slice(2);
            const node = nodeMap.get(nodeId) || tree;
            return { selectedAgentNode: node, selectedEvent: null };
        }
        if (selectedKey.startsWith('e:')) {
            const parts = selectedKey.slice(2).split(':');
            const nodeId = parts[0];
            const evIdx = parseInt(parts[1], 10);
            const node = nodeMap.get(nodeId) || tree;
            const ev = node.events[evIdx] || null;
            return { selectedAgentNode: node, selectedEvent: ev };
        }
        return { selectedAgentNode: tree, selectedEvent: null };
    }, [selectedKey, nodeMap, tree]);

    const selectedTraceSkillCalls = useMemo(
        () => collectTraceSkillCalls(interactions || [], selectedAgentNode),
        [interactions, selectedAgentNode],
    );

    const selectedTraceSkillUsages = useMemo(
        () => resolveTraceSkillUsages(selectedTraceSkillCalls, managedSkillAssets),
        [selectedTraceSkillCalls, managedSkillAssets],
    );

    const toggleKey = (key: string) => {
        setExpandedKeys(s => {
            const next = new Set(s);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const expandAll = () => {
        if (!tree) return;
        const keys = new Set<string>();
        walkTree(tree, n => {
            keys.add(agentKey(n.id));
            n.events.forEach((ev, idx) => {
                if (ev.kind === 'task' && ev.spawnedChildId) keys.add(eventKey(n.id, idx));
            });
        });
        setExpandedKeys(keys);
    };

    const collapseAll = () => {
        if (!tree) return;
        setExpandedKeys(new Set([agentKey(tree.id)]));
    };

    const slowCount = useMemo(() => {
        let n = 0;
        if (tree) walkTree(tree, node => { if (getStatus(node) !== 'ok') n++; });
        return n;
    }, [tree]);

    const handleStatChipClick = (kind: EventTypeFilter) => {
        setActiveDetailTab('timeline');
        setEventTypeFilter(prev => prev === kind ? 'all' : kind);
    };

    // ── Flat span list for search + TopN ────────────────────────────────────
    const allSpans = useMemo<SpanInfo[]>(() => {
        if (!tree) return [];
        const spans: SpanInfo[] = [];
        const visit = (node: AgentNode, parentKeys: string[]) => {
            const aKey = agentKey(node.id);
            spans.push({
                key: aKey, label: node.agentName, kind: 'agent',
                durationMs: node.stats.durationMs ?? undefined,
                tokens: node.stats.totalTokens || undefined,
                isSlow: (node.stats.durationMs ?? 0) > SLOW_MS,
                searchText: [node.agentName, node.subagentType, node.id].filter(Boolean).join(' ').toLowerCase(),
                parentKeys,
            });
            const myParents = [...parentKeys, aKey];
            node.events.forEach((ev, idx) => {
                const evKey = eventKey(node.id, idx);
                const childNode = ev.spawnedChildId ? nodeMap.get(ev.spawnedChildId) : undefined;
                const dur = childNode
                    ? childNode.stats.durationMs ?? undefined
                    : (ev.startedAt != null && ev.completedAt != null) ? ev.completedAt - ev.startedAt : undefined;
                const tok = ev.usage?.total || 0;
                const label = ev.kind === 'task'
                    ? `spawn → ${ev.args?.subagent_type || childNode?.agentName || 'subagent'}`
                    : ev.name || ev.summary?.split('\n')[0]?.slice(0, 60) || ev.kind;
                spans.push({
                    key: evKey, label, kind: ev.kind,
                    durationMs: dur, tokens: tok || undefined,
                    isSlow: (dur ?? 0) > SLOW_MS,
                    searchText: [ev.name, ev.summary, ev.kind,
                        ev.args ? (typeof ev.args === 'string' ? ev.args : JSON.stringify(ev.args)).slice(0, 300) : '',
                        ev.output ? (typeof ev.output === 'string' ? ev.output : JSON.stringify(ev.output)).slice(0, 100) : '',
                    ].filter(Boolean).join(' ').toLowerCase(),
                    parentKeys: myParents,
                });
            });
            node.children.forEach(c => visit(c, myParents));
        };
        visit(tree, []);
        return spans;
    }, [tree, nodeMap]);

    const searchMatches = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return [];
        return allSpans.filter(s => s.searchText.includes(q));
    }, [allSpans, searchQuery]);

    const safeIdx = searchMatches.length > 0 ? ((searchMatchIdx % searchMatches.length) + searchMatches.length) % searchMatches.length : 0;
    const activeMatchKey = searchMatches.length > 0 ? (searchMatches[safeIdx]?.key ?? null) : null;
    const matchedKeys = useMemo(() => new Set(searchMatches.map(s => s.key)), [searchMatches]);

    useEffect(() => {
        if (searchMatches.length === 0) return;
        setExpandedKeys(prev => {
            const next = new Set(prev);
            searchMatches.forEach(m => m.parentKeys.forEach(pk => next.add(pk)));
            return next;
        });
    }, [searchMatches]);

    useEffect(() => {
        if (!activeMatchKey) return;
        setTimeout(() => {
            document.querySelector(`[data-span-key="${activeMatchKey}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 80);
    }, [activeMatchKey]);

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                e.preventDefault();
                searchInputRef.current?.focus();
                searchInputRef.current?.select();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, []);

    const { topNDuration, topNTokens, slowNodesList } = useMemo(() => {
        const eventSpans = allSpans.filter(s => s.kind !== 'agent');
        const byDur = [...eventSpans].filter(s => s.durationMs).sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));
        const byTok = [...eventSpans].filter(s => s.tokens).sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0));
        return {
            topNDuration: byDur.slice(0, 5),
            topNTokens: byTok.slice(0, 5),
            slowNodesList: allSpans.filter(s => s.isSlow),
        };
    }, [allSpans]);

    const onJumpToKey = (key: string) => {
        const span = allSpans.find(s => s.key === key);
        if (span) {
            setExpandedKeys(prev => {
                const next = new Set(prev);
                span.parentKeys.forEach(pk => next.add(pk));
                return next;
            });
        }
        setSelectedKey(key);
        setTimeout(() => {
            document.querySelector(`[data-span-key="${key}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 80);
    };

    const ctxValue: TraceCtxValue = {
        searchQuery, matchedKeys, activeMatchKey,
        treeKindFilter, minDurationMs, minTokenK, slowOnly,
        onJumpToKey, topNDuration, topNTokens, slowNodesList,
        onSubagentNavigate,
    };

    const hasActiveFilters = treeKindFilter !== 'all' || minDurationMs > 0 || minTokenK > 0 || slowOnly;

    if (!tree || !selectedAgentNode) {
        return (
            <div className="p-8 text-center text-foreground-muted">
                {tt('traceTree.noData')}
            </div>
        );
    }

    return (
        <TraceCtx.Provider value={ctxValue}>
        <div className="flex flex-col gap-2.5">
            {/* Stats bar */}
            {totalStats && (
                <div className="flex flex-wrap items-center gap-3 px-3.5 py-2 rounded-md border border-border bg-background-secondary text-xs">
                    <StatChip label="AGENTS" value={totalStats.agents} />
                    <Sep />
                    <StatChip label="TASK SPAWNS" value={totalStats.tasks} accentClass={KIND_META.task.text} isActive={eventTypeFilter === 'task'} onClick={() => handleStatChipClick('task')} hint={tt('traceTree.filterType') + ' Task'} />
                    <StatChip label="TOOL CALLS"  value={totalStats.tools} accentClass={KIND_META.tool.text}  isActive={eventTypeFilter === 'tool'}  onClick={() => handleStatChipClick('tool')}  hint={tt('traceTree.filterType') + ' Tool'} />
                    <StatChip label="SKILL CALLS" value={totalStats.skills} accentClass={KIND_META.skill.text} isActive={eventTypeFilter === 'skill'} onClick={() => handleStatChipClick('skill')} hint={tt('traceTree.filterType') + ' Skill'} />
                    <StatChip label="LLM TURNS"   value={totalStats.llm}   accentClass={KIND_META.llm.text}   isActive={eventTypeFilter === 'llm'}   onClick={() => handleStatChipClick('llm')}   hint={tt('traceTree.filterType') + ' LLM'} />
                    <Sep />
                    <StatChip label="TOKENS" value={formatTokens(totalStats.tokens)} />
                    {eventTypeFilter !== 'all' && (
                        <Button variant="ghost" size="sm" onClick={() => setEventTypeFilter('all')} className="ml-auto h-6 text-xs">
                            <XIcon className="size-3" />{tt('traceTree.clearFilter')}
                        </Button>
                    )}
                </div>
            )}

            <div className="grid gap-3 min-h-[520px] h-[calc(100vh-200px)]" style={{ gridTemplateColumns: 'minmax(400px, 62%) 1fr' }}>
                {/* ─── Left: Unified Span Tree ─── */}
                <div className="rounded-lg border border-card-border bg-card flex flex-col h-full min-h-0 overflow-hidden">
                    {/* Toolbar: expand/collapse + search + filters */}
                    <div className={cn(
                        'flex flex-wrap items-center gap-2 px-2.5 py-1.5',
                        !(showFilters || hasActiveFilters) && 'border-b border-border',
                    )}>
                        <div className="flex border border-border rounded-md overflow-hidden shrink-0">
                            <Button variant="ghost" size="sm" onClick={expandAll} className="h-7 rounded-none border-r border-border text-xs px-2">{tt('traceTree.expandAll')}</Button>
                            <Button variant="ghost" size="sm" onClick={collapseAll} className="h-7 rounded-none text-xs px-2">{tt('traceTree.collapseAll')}</Button>
                        </div>

                        {/* Global search bar */}
                        <div className="flex-1 min-w-[120px] flex items-center gap-1 px-2 py-0.5 rounded-md border border-border bg-background-secondary focus-within:border-primary transition-colors">
                            <SearchIcon className="size-3.5 text-foreground-muted shrink-0" aria-hidden />
                            <input
                                ref={searchInputRef}
                                type="text"
                                value={searchQuery}
                                onChange={e => { setSearchQuery(e.target.value); setSearchMatchIdx(0); }}
                                onKeyDown={e => {
                                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) setSearchMatchIdx(i => e.shiftKey ? i - 1 : i + 1);
                                    if (e.key === 'Escape') { setSearchQuery(''); setSearchMatchIdx(0); }
                                }}
                                placeholder={tt('traceTree.searchPlaceholder')}
                                className="flex-1 border-0 bg-transparent outline-none text-xs text-foreground min-w-0"
                            />
                            {searchQuery && (
                                <span className={cn('text-xs tabular-nums shrink-0 whitespace-nowrap', searchMatches.length > 0 ? 'text-foreground-muted' : 'text-error')}>
                                    {searchMatches.length > 0 ? `${safeIdx + 1}/${searchMatches.length}` : '0'}
                                </span>
                            )}
                            {searchQuery && searchMatches.length > 1 && (
                                <>
                                    <button onClick={() => setSearchMatchIdx(i => i - 1)} aria-label="Previous match" className="px-1 bg-transparent border-0 text-foreground-muted hover:text-foreground cursor-pointer text-xs leading-none">▲</button>
                                    <button onClick={() => setSearchMatchIdx(i => i + 1)} aria-label="Next match" className="px-1 bg-transparent border-0 text-foreground-muted hover:text-foreground cursor-pointer text-xs leading-none">▼</button>
                                </>
                            )}
                            {searchQuery && (
                                <button onClick={() => { setSearchQuery(''); setSearchMatchIdx(0); }} aria-label="Clear" className="px-0.5 bg-transparent border-0 text-foreground-muted hover:text-foreground cursor-pointer text-xs leading-none shrink-0">
                                    <XIcon className="size-3" />
                                </button>
                            )}
                        </div>

                        {/* Slow / anomaly filter */}
                        <Button
                            variant={slowOnly ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => setSlowOnly(b => !b)}
                            className={cn(
                                'h-7 text-xs px-2 gap-1',
                                slowOnly && 'bg-warning text-warning-foreground hover:bg-warning/90 border-warning',
                            )}
                            aria-pressed={slowOnly}
                        >
                            <AlertIcon className="size-3" />
                            {tt('traceTree.slowOnly')}
                            {slowCount > 0 && (
                                <span className={cn(
                                    'ml-0.5 px-1 rounded-full text-xs font-semibold tabular-nums min-w-[16px] text-center',
                                    slowOnly ? 'bg-warning-foreground text-warning' : 'bg-background-tertiary text-foreground-muted',
                                )}>
                                    {slowCount}
                                </span>
                            )}
                        </Button>

                        {/* Extended filter toggle */}
                        <Button
                            variant={showFilters || hasActiveFilters ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => setShowFilters(b => !b)}
                            className="h-7 text-xs px-2 gap-1"
                        >
                            <FiltersIcon className="size-3" />
                            {tt('traceTree.filters')}{hasActiveFilters ? ' ●' : ''}
                        </Button>
                    </div>

                    {/* Extended filter row */}
                    {(showFilters || hasActiveFilters) && (
                        <div className="flex flex-wrap items-center gap-2 px-2.5 py-1.5 border-b border-border bg-background-secondary">
                            <FilterPill label={tt('traceTree.filterType')} value={treeKindFilter} options={[
                                { value: 'all', label: tt('traceTree.filterAll') },
                                { value: 'llm', label: 'LLM', accentClass: KIND_META.llm.text },
                                { value: 'tool', label: 'Tool', accentClass: KIND_META.tool.text },
                                { value: 'task', label: 'Task', accentClass: KIND_META.task.text },
                                { value: 'skill', label: 'Skill', accentClass: KIND_META.skill.text },
                                { value: 'user', label: 'User' },
                            ]} onChange={setTreeKindFilter} />
                            <span className="w-px h-3.5 bg-border shrink-0" />
                            <FilterPill label={tt('traceTree.filterDuration')} value={String(minDurationMs)} options={[
                                { value: '0', label: tt('traceTree.filterAll') },
                                { value: '1000', label: '>1s' },
                                { value: '5000', label: '>5s' },
                                { value: '10000', label: '>10s' },
                                { value: '30000', label: '>30s' },
                            ]} onChange={v => setMinDurationMs(Number(v))} />
                            <span className="w-px h-3.5 bg-border shrink-0" />
                            <FilterPill label={tt('traceTree.filterToken')} value={String(minTokenK)} options={[
                                { value: '0', label: tt('traceTree.filterAll') },
                                { value: '10', label: '>10k' },
                                { value: '50', label: '>50k' },
                                { value: '100', label: '>100k' },
                            ]} onChange={v => setMinTokenK(Number(v))} />
                            {hasActiveFilters && (
                                <Button variant="ghost" size="sm" onClick={() => { setTreeKindFilter('all'); setMinDurationMs(0); setMinTokenK(0); setSlowOnly(false); }} className="h-6 ml-auto text-xs text-foreground-muted">
                                    <XIcon className="size-3" />{tt('traceTree.resetFilter')}
                                </Button>
                            )}
                        </div>
                    )}

                    {/* Column headers */}
                    <div className="flex items-center px-2.5 py-1 border-b border-border text-xs text-foreground-muted uppercase tracking-wider gap-2">
                        <span className="flex-1">{tt('traceTree.spanColumn')}</span>
                        <span className="w-20 text-left">{tt('traceTree.spanShare')}</span>
                        <span className="w-12 text-right">{tt('traceTree.spanDuration')}</span>
                        <span className="w-11 text-right">{tt('traceTree.spanTokens')}</span>
                        <span className="w-2" />
                    </div>

                    <div role="tree" className="overflow-y-auto overflow-x-auto flex-1 py-1">
                        <UnifiedSpanTree
                            node={tree}
                            nodeMap={nodeMap}
                            expandedKeys={expandedKeys}
                            onToggleKey={toggleKey}
                            selectedKey={selectedKey}
                            onSelect={key => { setSelectedKey(key); }}
                            totalStart={totalStart}
                            totalDuration={totalDuration}
                            depth={0}
                            isLast={true}
                            prefixBits={[]}
                        />
                    </div>
                </div>

                {/* ─── Right: Detail Panel ─── */}
                <div className="rounded-lg border border-card-border bg-card flex flex-col h-full min-h-0 overflow-hidden">
                    {selectedEvent ? (
                        <EventDetailPanel event={selectedEvent} node={selectedAgentNode} interactions={interactions} />
                    ) : selectedAgentNode ? (
                        <AgentDetail
                            node={selectedAgentNode}
                            highlightEvent={null}
                            activeTab={activeDetailTab}
                            onTabChange={setActiveDetailTab}
                            eventTypeFilter={eventTypeFilter}
                            onEventTypeFilterChange={setEventTypeFilter}
                            totalDurationMs={totalDuration}
                            onSelectChild={(id) => {
                                const n = findNode(tree, id);
                                if (n) setSelectedKey(agentKey(n.id));
                            }}
                            interactions={interactions}
                            traceSkills={selectedTraceSkillUsages}
                            currentUser={user}
                        />
                    ) : null}
                </div>
            </div>
        </div>
        </TraceCtx.Provider>
    );
}

// ─── FilterPill ──────────────────────────────────────────────────────────────
function FilterPill({ label, value, options, onChange }: {
    label: string;
    value: string;
    options: { value: string; label: string; accentClass?: string }[];
    onChange: (v: string) => void;
}) {
    return (
        <div className="flex items-center gap-1.5">
            <span className="text-xs text-foreground-muted font-medium shrink-0">{label}:</span>
            <div className="flex border border-border rounded-md overflow-hidden">
                {options.map((o, idx) => {
                    const isActive = o.value === value;
                    return (
                        <button
                            key={o.value}
                            onClick={() => onChange(o.value)}
                            className={cn(
                                'px-2 py-0.5 text-xs whitespace-nowrap transition-colors',
                                idx < options.length - 1 && 'border-r border-border',
                                isActive
                                    ? cn('bg-primary-subtle font-semibold', o.accentClass || 'text-primary')
                                    : 'bg-background-tertiary text-foreground-muted hover:text-foreground hover:bg-background-secondary',
                                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                            )}
                        >
                            {o.label}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

// ─── Separator ───────────────────────────────────────────────────────────────
function Sep() {
    return <div className="w-px h-4 bg-border shrink-0" />;
}

// ─── StatChip ────────────────────────────────────────────────────────────────
function StatChip({ label, value, isActive, accentClass, onClick, hint }: {
    label: string; value: number | string;
    isActive?: boolean; accentClass?: string; onClick?: () => void; hint?: string;
}) {
    return (
        <div
            onClick={onClick}
            title={hint}
            role={onClick ? 'button' : undefined}
            tabIndex={onClick ? 0 : undefined}
            onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
            className={cn(
                'flex items-baseline gap-1.5',
                onClick && 'cursor-pointer px-1.5 py-0.5 rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                onClick && !isActive && 'border-transparent hover:bg-background-tertiary',
                isActive && accentClass ? cn('bg-primary-subtle border-current', accentClass) : '',
            )}
        >
            <span className={cn(
                'text-xs uppercase tracking-wide',
                isActive ? 'font-bold' : 'font-normal',
                isActive && accentClass ? accentClass : 'text-foreground-muted',
            )}>{label}</span>
            <span className={cn(
                'font-semibold text-sm tabular-nums',
                isActive && accentClass ? accentClass : 'text-foreground',
            )}>{value}</span>
        </div>
    );
}

// ─── GanttBar ─────────────────────────────────────────────────────────────────
function GanttBar({ left, width, barClass, faint }: { left: number; width: number; barClass: string; faint?: boolean }) {
    if (width <= 0) return <div className="flex-1 mx-2" />;
    return (
        <div className="flex-1 mx-2 relative h-1.5 bg-background-secondary rounded-sm min-w-[60px]">
            <div
                className={cn('absolute h-full rounded-sm transition-[width]', barClass, faint && 'opacity-50')}
                style={{
                    // left/width are derived percentages — only quantitative geometry uses inline style.
                    left: `${Math.min(left, 99)}%`,
                    width: `max(4px, ${Math.min(width, 100 - left)}%)`,
                }}
            />
        </div>
    );
}

// ─── Tree connector helpers ───────────────────────────────────────────────────
function TreeConnector({ depth, isLast, prefixBits }: { depth: number; isLast: boolean; prefixBits: boolean[] }) {
    if (depth === 0) return null;
    return (
        <div className="flex items-center shrink-0">
            {prefixBits.map((hasLine, i) => (
                <span key={i} className="w-5 shrink-0 flex justify-center">
                    {hasLine && <span className="w-px h-8 bg-border -mt-1" />}
                </span>
            ))}
            <span className="w-5 shrink-0 relative h-8 flex items-center">
                <span className={cn('absolute left-[10px] top-0 w-px bg-border', isLast ? 'h-4' : 'h-8')} />
                <span className="absolute left-[10px] top-[15px] w-2 h-px bg-border" />
            </span>
        </div>
    );
}

// ─── UnifiedSpanTree (recursive) ─────────────────────────────────────────────
function UnifiedSpanTree({
    node, nodeMap, expandedKeys, onToggleKey, selectedKey, onSelect,
    totalStart, totalDuration, depth, isLast, prefixBits,
}: {
    node: AgentNode;
    nodeMap: Map<string, AgentNode>;
    expandedKeys: Set<string>;
    onToggleKey: (k: string) => void;
    selectedKey: string | null;
    onSelect: (k: string) => void;
    totalStart?: number;
    totalDuration?: number;
    depth: number;
    isLast: boolean;
    prefixBits: boolean[];
}) {
    const aKey = agentKey(node.id);
    const isExpanded = expandedKeys.has(aKey);
    const isSelected = selectedKey === aKey;
    const status = getStatus(node);
    const displayStats = aggregateSubtreeStats(node);

    // Gantt bar for this agent
    const barLeft = (totalStart != null && totalDuration && node.startedAt != null)
        ? Math.max(0, ((node.startedAt - totalStart) / totalDuration) * 100) : 0;
    const barWidth = (totalDuration && node.stats.durationMs != null)
        ? Math.min(100 - barLeft, (node.stats.durationMs / totalDuration) * 100) : (depth === 0 ? 100 : 0);

    const ctx = React.useContext(TraceCtx);
    const { matchedKeys, activeMatchKey, searchQuery, treeKindFilter, minDurationMs, minTokenK, slowOnly: ctxSlowOnly } = ctx;

    const events = node.events;
    const hasContent = events.length > 0;

    const isSearchMatch = searchQuery ? matchedKeys.has(aKey) : false;
    const isActiveMatch = activeMatchKey === aKey;

    return (
        <div>
            {/* AGENT row */}
            <div
                data-span-key={aKey}
                onClick={() => onSelect(aKey)}
                tabIndex={0}
                role="treeitem"
                aria-selected={isSelected}
                aria-expanded={hasContent ? isExpanded : undefined}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(aKey); } }}
                className={cn(
                    'flex items-center h-[34px] pr-2 cursor-pointer select-none transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                    isActiveMatch ? 'bg-amber-200/40 dark:bg-amber-500/30'
                        : isSearchMatch ? 'bg-amber-100/40 dark:bg-amber-500/15'
                        : isSelected ? 'bg-primary-subtle'
                        : 'hover:bg-background-secondary',
                    isSelected && 'shadow-[inset_2px_0_0] shadow-primary',
                    !isSelected && isActiveMatch && 'shadow-[inset_2px_0_0] shadow-amber-500',
                    searchQuery && !matchedKeys.has(aKey) && 'opacity-40',
                )}
            >
                <TreeConnector depth={depth} isLast={isLast} prefixBits={prefixBits} />

                {/* Expand toggle */}
                <button
                    onClick={e => { e.stopPropagation(); if (hasContent) onToggleKey(aKey); }}
                    aria-label={isExpanded ? 'Collapse' : 'Expand'}
                    className={cn(
                        'size-4 p-0 flex items-center justify-center text-foreground-muted shrink-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm',
                        hasContent ? 'cursor-pointer hover:text-foreground' : 'cursor-default',
                    )}
                >
                    {hasContent ? (isExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />) : null}
                </button>

                {/* AGENT badge */}
                <KindBadge kind="agent" className="ml-0.5" />

                {/* Name + subtitle */}
                <span className={cn(
                    'flex-1 ml-1.5 text-sm text-foreground truncate min-w-0',
                    depth === 0 ? 'font-semibold' : 'font-medium',
                )}>
                    {node.agentName}
                    {node.subagentType && (
                        <span className="ml-1.5 text-xs text-foreground-muted font-normal">{node.subagentType}</span>
                    )}
                    {node.parallelCallCount && node.parallelCallCount > 1 && (
                        <span className="ml-1.5 text-xs px-1 bg-background-tertiary border border-border rounded-full text-foreground-muted">
                            ×{node.parallelCallCount}
                        </span>
                    )}
                    {depth > 0 && node.sessionId && ctx.onSubagentNavigate && (
                        <button
                            type="button"
                            title="在独立 Trace 视图中打开此 Sub-Agent"
                            onClick={(e) => {
                                e.stopPropagation();
                                ctx.onSubagentNavigate?.(node.sessionId!);
                            }}
                            style={{
                                marginLeft: 6,
                                padding: '1px 7px',
                                fontSize: '0.625rem',
                                fontWeight: 600,
                                letterSpacing: '0.04em',
                                lineHeight: '14px',
                                background: 'var(--primary-subtle, rgba(99,102,241,0.10))',
                                border: '1px solid var(--primary, #6366F1)',
                                borderRadius: 3,
                                color: 'var(--primary, #6366F1)',
                                cursor: 'pointer',
                                verticalAlign: 'middle',
                            }}
                        >
                            Trace
                        </button>
                    )}
                </span>

                {/* Gantt bar: selected → primary / slow → warning / default → kind color */}
                <GanttBar
                    left={barLeft}
                    width={barWidth}
                    barClass={cn(
                        isSelected ? 'bg-primary'
                            : status === 'slow' ? 'bg-warning'
                            : KIND_META.agent.bar,
                    )}
                />

                {/* Metrics */}
                <span className={cn(
                    'w-12 text-right text-xs tabular-nums shrink-0 font-mono',
                    status === 'slow' ? 'text-warning' : 'text-foreground-muted',
                )}>
                    {formatDuration(node.stats.durationMs)}
                </span>
                <span className="w-11 text-right ml-1 text-xs text-foreground-muted tabular-nums font-mono shrink-0">
                    {formatTokens(displayStats.totalTokens)}
                </span>
                <span className="w-2 ml-1 flex items-center justify-center">
                    {status !== 'ok' && <span className={cn('size-1.5 rounded-full shrink-0', STATUS_DOT[status])} />}
                </span>
            </div>

            {/* Events */}
            {hasContent && isExpanded && (
                <div>
                    {events.map((ev, evIdx) => {
                        const evKey = eventKey(node.id, evIdx);
                        const childNode = ev.kind === 'task' && ev.spawnedChildId ? nodeMap.get(ev.spawnedChildId) : undefined;
                        const hasChildren = !!childNode;
                        const isEvExpanded = hasChildren && expandedKeys.has(evKey);
                        const isLastEv = evIdx === events.length - 1;
                        const childPrefixBits = depth === 0 ? [] : [...prefixBits, !isLast];

                        // ── Context-driven filters ──
                        const evDur = childNode
                            ? childNode.stats.durationMs
                            : (ev.startedAt != null && ev.completedAt != null) ? ev.completedAt - ev.startedAt : undefined;
                        const evTok = ev.usage?.total || 0;
                        const evIsSlow = (evDur ?? 0) > SLOW_MS;
                        if (treeKindFilter !== 'all' && ev.kind !== treeKindFilter) return null;
                        if (minDurationMs > 0 && (evDur == null || evDur < minDurationMs)) return null;
                        if (minTokenK > 0 && evTok < minTokenK * 1000) return null;
                        if (ctxSlowOnly && !evIsSlow) return null;
                        if (searchQuery && !matchedKeys.has(evKey)) return null;

                        return (
                            <div key={evIdx}>
                                <UnifiedEventRow
                                    event={ev}
                                    evIdx={evIdx}
                                    parentNodeId={node.id}
                                    childNode={childNode}
                                    depth={depth + 1}
                                    isLast={isLastEv && !isEvExpanded}
                                    prefixBits={childPrefixBits}
                                    isExpanded={isEvExpanded}
                                    hasChildren={hasChildren}
                                    isSelected={selectedKey === evKey}
                                    onSelect={() => onSelect(evKey)}
                                    onToggle={hasChildren ? () => onToggleKey(evKey) : undefined}
                                    totalStart={totalStart}
                                    totalDuration={totalDuration}
                                />
                                {childNode && isEvExpanded && (
                                    <UnifiedSpanTree
                                        node={childNode}
                                        nodeMap={nodeMap}
                                        expandedKeys={expandedKeys}
                                        onToggleKey={onToggleKey}
                                        selectedKey={selectedKey}
                                        onSelect={onSelect}
                                        totalStart={totalStart}
                                        totalDuration={totalDuration}
                                        depth={depth + 2}
                                        isLast={isLastEv}
                                        prefixBits={[...childPrefixBits, !isLastEv]}
                                    />
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ─── UnifiedEventRow ──────────────────────────────────────────────────────────
function UnifiedEventRow({
    event, evIdx, parentNodeId, childNode,
    depth, isLast, prefixBits, isExpanded, hasChildren, isSelected,
    onSelect, onToggle, totalStart, totalDuration,
}: {
    event: AgentEvent; evIdx: number; parentNodeId: string; childNode?: AgentNode;
    depth: number; isLast: boolean; prefixBits: boolean[];
    isExpanded: boolean; hasChildren: boolean; isSelected: boolean;
    onSelect: () => void; onToggle?: () => void;
    totalStart?: number; totalDuration?: number;
}) {
    const km = KIND_META[event.kind] ?? KIND_META.tool;

    // Duration: for task events, use child agent duration
    const spanDurationMs = event.kind === 'task' && childNode
        ? childNode.stats.durationMs
        : (event.startedAt != null && event.completedAt != null)
            ? event.completedAt - event.startedAt
            : undefined;

    // Tokens: for task events, use child agent tokens
    const spanTokens = event.kind === 'task' && childNode
        ? childNode.stats.totalTokens
        : event.usage?.total || 0;

    // Gantt bar: for task events use child agent start
    const spanStart = event.kind === 'task' && childNode ? childNode.startedAt : event.startedAt;
    const barLeft = (totalStart != null && totalDuration && spanStart != null)
        ? Math.max(0, ((spanStart - totalStart) / totalDuration) * 100) : 0;
    const barWidth = (totalDuration && spanDurationMs != null)
        ? Math.min(100 - barLeft, (spanDurationMs / totalDuration) * 100) : 0;

    const isSlow = spanDurationMs != null && spanDurationMs > SLOW_MS;

    const { matchedKeys: ctxMatchedKeys, activeMatchKey: ctxActiveMatchKey, searchQuery: ctxSearch } = React.useContext(TraceCtx);
    const evKey = eventKey(parentNodeId, evIdx);
    const isSearchMatch = ctxSearch ? ctxMatchedKeys.has(evKey) : false;
    const isActiveSearchMatch = ctxActiveMatchKey === evKey;

    // Primary label
    const primaryLabel = event.kind === 'task'
        ? `spawn → ${event.args?.subagent_type || childNode?.agentName || 'subagent'}`
        : event.kind === 'llm'
            ? (event.summary ? event.summary.split('\n')[0].slice(0, 60) : 'LLM')
            : event.name || event.summary?.slice(0, 50) || event.kind;

    // Secondary label
    const secondaryLabel = event.kind === 'task'
        ? (event.args?.description ? String(event.args.description).slice(0, 55) : undefined)
        : event.kind === 'llm'
            ? undefined
            : (event.name && event.summary && event.summary !== event.name)
                ? event.summary.slice(event.name.length).replace(/^[:\s]+/, '').slice(0, 50)
                : undefined;

    return (
        <div
            data-span-key={evKey}
            onClick={() => { onSelect(); }}
            tabIndex={0}
            role="treeitem"
            aria-selected={isSelected}
            aria-expanded={hasChildren ? isExpanded : undefined}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
            className={cn(
                'flex items-center h-[30px] pr-2 cursor-pointer select-none transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                isActiveSearchMatch ? 'bg-amber-200/40 dark:bg-amber-500/30'
                    : isSearchMatch ? 'bg-amber-100/40 dark:bg-amber-500/15'
                    : isSelected ? 'bg-primary-subtle'
                    : 'hover:bg-background-secondary',
                isSelected && 'shadow-[inset_2px_0_0] shadow-primary',
                !isSelected && isActiveSearchMatch && 'shadow-[inset_2px_0_0] shadow-amber-500',
            )}
        >
            <TreeConnector depth={depth} isLast={isLast} prefixBits={prefixBits} />

            {/* Toggle for task rows */}
            <button
                onClick={e => { e.stopPropagation(); if (onToggle) onToggle(); }}
                aria-label={isExpanded ? 'Collapse' : 'Expand'}
                className={cn(
                    'size-4 p-0 flex items-center justify-center text-foreground-muted shrink-0 rounded-sm',
                    hasChildren ? 'cursor-pointer hover:text-foreground' : 'cursor-default invisible',
                )}
            >
                {hasChildren ? (isExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />) : null}
            </button>

            {/* Kind badge */}
            <KindBadge kind={event.kind} className="ml-0.5" />

            {/* Name + secondary */}
            <span className={cn(
                'flex-1 ml-1.5 text-xs text-foreground truncate min-w-0',
                event.kind === 'task' ? 'font-medium' : 'font-normal',
            )}>
                {primaryLabel}
                {secondaryLabel && (
                    <span className="ml-1.5 text-xs text-foreground-muted">{secondaryLabel}</span>
                )}
                {event.spawnedChildId && !hasChildren && (
                    <span className="ml-1.5 text-xs text-foreground-muted">→</span>
                )}
            </span>

            {/* Gantt bar */}
            <GanttBar
                left={barLeft}
                width={barWidth}
                barClass={cn(
                    isSelected ? 'bg-primary'
                        : isSlow ? 'bg-warning'
                        : km.bar,
                )}
                faint={event.kind === 'task'}
            />

            {/* Metrics */}
            <span className={cn(
                'w-12 text-right text-xs tabular-nums shrink-0 font-mono',
                isSlow ? 'text-warning' : 'text-foreground-muted',
            )}>
                {formatDuration(spanDurationMs)}
            </span>
            <span className="w-11 text-right ml-1 text-xs text-foreground-muted tabular-nums font-mono shrink-0">
                {spanTokens ? formatTokens(spanTokens) : ''}
            </span>
            <span className="w-2 ml-1 flex items-center justify-center">
                {isSlow && <span className="size-1.5 rounded-full bg-warning" />}
            </span>
        </div>
    );
}

// ─── CompactSection: truncated preview + click-to-expand modal ───────────────
const PREVIEW_CHARS = 300;

function CompactSection({ label, raw, modalTitle, emptyText, accentColor }: { label: string; raw: string | null; modalTitle?: string; emptyText?: string; accentColor?: string }) {
    const [showModal, setShowModal] = useState(false);
    if (raw == null) return null;
    const trimmed = raw.trim();
    const preview = trimmed.slice(0, PREVIEW_CHARS);
    const isTruncated = trimmed.length > PREVIEW_CHARS;
    return (
        <>
            <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.375rem' }}>
                    <SectionTitle accentColor={accentColor}>{label}</SectionTitle>
                    {trimmed && (
                        <button
                            onClick={() => setShowModal(true)}
                            style={{ fontSize: '0.5625rem', color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 0.375rem', fontWeight: 500 }}
                        >
                            查看全部 ›
                        </button>
                    )}
                </div>
                {trimmed ? (
                    <div
                        onClick={() => setShowModal(true)}
                        style={{
                            padding: '0.5rem 0.75rem',
                            background: 'var(--background-secondary)',
                            border: '1px solid var(--border)',
                            borderRadius: 6,
                            fontSize: '0.75rem',
                            lineHeight: 1.6,
                            color: 'var(--foreground)',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            cursor: 'pointer',
                            maxHeight: 110,
                            overflow: 'hidden',
                            position: 'relative',
                            userSelect: 'none',
                        }}
                    >
                        {preview}{isTruncated && ' …'}
                        {isTruncated && (
                            <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 32, background: 'linear-gradient(transparent, var(--background-secondary))' }} />
                        )}
                    </div>
                ) : (
                    <div style={{ fontSize: '0.75rem', color: 'var(--foreground-muted)', fontStyle: 'italic' }}>{emptyText || '(空)'}</div>
                )}
            </div>
            {showModal && (
                <ContentModal title={modalTitle || label} raw={raw} onClose={() => setShowModal(false)} />
            )}
        </>
    );
}

// ─── ContentModal: full SmartViewer display ───────────────────────────────────
function ContentModal({ title, raw, onClose }: { title: string; raw: string; onClose: () => void }) {
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try {
            await copyText(raw);
            setCopied(true);
            toast.success('Copied');
            setTimeout(() => setCopied(false), 1400);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error('[copy] all methods failed:', msg);
            toast.error(`Copy failed: ${msg.slice(0, 60)}`);
        }
    };
    return (
        <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
            <DialogContent className="max-w-[800px] max-h-[88vh] flex flex-col p-0 gap-0">
                <DialogHeader className="flex-row items-center gap-3 p-4 border-b border-border space-y-0">
                    <DialogTitle className="text-sm font-semibold text-foreground">{title}</DialogTitle>
                    <div className="flex-1" />
                    <span className="text-xs text-foreground-muted tabular-nums">{raw.length.toLocaleString()} chars</span>
                    <Button
                        variant={copied ? 'default' : 'outline'}
                        size="sm"
                        onClick={copy}
                        className="h-7 text-xs"
                    >
                        {copied ? <><Check className="size-3" />Copied</> : <><CopyIcon className="size-3" />Copy</>}
                    </Button>
                </DialogHeader>
                <div className="overflow-auto flex-1">
                    <SmartViewer text={raw} toolbar={false} maxHeight="none" theme="light" />
                </div>
            </DialogContent>
        </Dialog>
    );
}

// ─── RoleSection: one message-role block inside the Input group ───────────────
// 角色颜色仅在 LLM 详情面板内使用，用于区分 system/user/assistant 消息，不对外使用
const ROLE_ACCENT: Record<string, string> = {
    system:     '#7C3AED',  // violet — 系统提示用深紫区分
    user:       '#0284C7',  // sky — 用户消息用蓝区分
    assistant:  'var(--primary)',
    compaction: '#D97706',  // amber — context-compaction summary 用琥珀色，提示"摘要替代了原文"
};
const ROLE_BG: Record<string, string> = {
    system:     'rgba(124,58,237,0.03)',
    user:       'rgba(2,132,199,0.03)',
    assistant:  'rgba(79,70,229,0.03)',
    compaction: 'rgba(217,119,6,0.04)',
};

/** Section rendered between System and User when the current LLM step happens
 *  after a context-compaction boundary. Shows the compaction summary as what
 *  the model actually sees, plus a "view original" expander to inspect the
 *  messages that were folded behind the summary. */
function CompactionSection({
    summaryRaw,
    foldedOriginalRaw,
    foldedCount,
    modelLabel,
    summaryUsage,
    modalTitleBase,
}: {
    summaryRaw: string;
    foldedOriginalRaw: string | null;
    foldedCount: number;
    modelLabel?: string;
    summaryUsage?: InteractionUsage;
    modalTitleBase: string;
}) {
    const [showSummary, setShowSummary] = useState(false);
    const [showFolded, setShowFolded] = useState(false);
    const accent = ROLE_ACCENT.compaction;
    const bg = ROLE_BG.compaction;
    const trimmed = summaryRaw.trim();
    const preview = trimmed.slice(0, PREVIEW_CHARS);
    const isTruncated = trimmed.length > PREVIEW_CHARS;

    const totalTokens = summaryUsage?.total ?? undefined;

    return (
        <>
            <div style={{ borderBottom: '1px solid var(--border)', background: bg }}>
                {/* Header bar */}
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0.3rem 0.625rem',
                    borderBottom: '1px solid var(--border)',
                    background: bg,
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', flexWrap: 'wrap' }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: accent, flexShrink: 0, display: 'inline-block' }} />
                        <span style={{ fontSize: '0.5625rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: accent }}>
                            Compacted History
                        </span>
                        <span style={{ fontSize: '0.5625rem', color: 'var(--foreground-muted)' }}>
                            {foldedCount > 0
                                ? `${foldedCount} prior turn${foldedCount === 1 ? '' : 's'} replaced by summary`
                                : 'prior context replaced by summary'}
                            {modelLabel && <> · via <b style={{ color: 'var(--foreground)' }}>{modelLabel}</b></>}
                            {totalTokens != null && totalTokens > 0 && <> · {formatTokens(totalTokens)} tok</>}
                        </span>
                    </div>
                    <button
                        onClick={() => setShowSummary(true)}
                        style={{ fontSize: '0.5625rem', color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 500 }}
                    >
                        查看摘要全文 ›
                    </button>
                </div>
                {/* Summary preview body — what the model now sees in place of the originals */}
                <div
                    onClick={() => setShowSummary(true)}
                    style={{
                        padding: '0.5rem 0.75rem',
                        fontSize: '0.75rem',
                        lineHeight: 1.6,
                        color: 'var(--foreground)',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        cursor: 'pointer',
                        maxHeight: 110,
                        overflow: 'hidden',
                        position: 'relative',
                        userSelect: 'none',
                    }}
                >
                    {preview}{isTruncated && ' …'}
                    {isTruncated && (
                        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 32, background: `linear-gradient(transparent, ${bg || 'var(--background-secondary)'})` }} />
                    )}
                </div>
                {/* "View original folded messages" link */}
                {foldedOriginalRaw && foldedCount > 0 && (
                    <div style={{
                        padding: '0.25rem 0.75rem 0.4rem',
                        borderTop: '1px dashed var(--border)',
                        fontSize: '0.5625rem',
                        color: 'var(--foreground-muted)',
                    }}>
                        <button
                            onClick={() => setShowFolded(true)}
                            style={{ fontSize: '0.625rem', color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 500 }}
                        >
                            ▸ 查看被折叠的原始消息 ({foldedCount})
                        </button>
                        <span style={{ marginLeft: '0.5rem', color: 'var(--foreground-muted)' }}>
                            — 模型已不再看到这部分，仅供回溯
                        </span>
                    </div>
                )}
            </div>
            {showSummary && (
                <ContentModal
                    title={`${modalTitleBase} — Compaction Summary`}
                    raw={summaryRaw}
                    onClose={() => setShowSummary(false)}
                />
            )}
            {showFolded && foldedOriginalRaw && (
                <ContentModal
                    title={`${modalTitleBase} — Folded Original Messages (${foldedCount})`}
                    raw={foldedOriginalRaw}
                    onClose={() => setShowFolded(false)}
                />
            )}
        </>
    );
}

/** One row per conversation turn in the Input (Prompt) panel. Default state is
 *  a single-line collapsed preview (role badge + position + first line); click
 *  toggles inline-expand to the full content. A "查看全部" link in the expanded
 *  header opens the modal for very long content. This replaces the old "all
 *  users glued together, all assistants glued together" rendering. */
function TurnPreviewRow({
    role,
    content,
    position,
    defaultExpanded,
    modalTitle,
}: {
    role: string;
    content: string;
    position: number;
    defaultExpanded?: boolean;
    modalTitle: string;
}) {
    const [expanded, setExpanded] = useState(!!defaultExpanded);
    const [showModal, setShowModal] = useState(false);
    const accent = ROLE_ACCENT[role] || 'var(--foreground-muted)';
    const bg     = ROLE_BG[role]    || 'transparent';
    const trimmed = (content || '').trim();
    const firstLine = trimmed.split(/\n/).find(l => l.trim()) || '';
    const oneLine = firstLine.slice(0, 110);
    const isEmpty = trimmed.length === 0;
    const isLong  = trimmed.length > PREVIEW_CHARS;

    return (
        <>
            <div style={{ borderBottom: '1px solid var(--border)', background: bg }}>
                {/* Header row — always visible, click toggles */}
                <div
                    onClick={() => !isEmpty && setExpanded(v => !v)}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        padding: '0.3rem 0.625rem',
                        cursor: isEmpty ? 'default' : 'pointer',
                        userSelect: 'none',
                    }}
                >
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: accent, flexShrink: 0, display: 'inline-block' }} />
                    <span style={{ fontSize: '0.5625rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: accent, flexShrink: 0 }}>
                        {role}
                    </span>
                    <span style={{ fontSize: '0.5625rem', color: 'var(--foreground-muted)', flexShrink: 0 }}>
                        #{position}
                    </span>
                    {/* Inline first-line preview when collapsed (helps scan w/o expanding) */}
                    {!expanded && !isEmpty && (
                        <span
                            style={{
                                flex: 1,
                                fontSize: '0.6875rem',
                                color: 'var(--foreground-muted)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                            }}
                        >
                            {oneLine}{firstLine.length > 110 ? '…' : ''}
                        </span>
                    )}
                    {isEmpty && (
                        <span style={{ flex: 1, fontSize: '0.6875rem', color: 'var(--foreground-muted)', fontStyle: 'italic' }}>
                            (无文本内容)
                        </span>
                    )}
                    {/* Spacer when expanded so the chevron sits right */}
                    {expanded && <span style={{ flex: 1 }} />}
                    {!isEmpty && (
                        <span style={{ fontSize: '0.625rem', color: 'var(--foreground-muted)', flexShrink: 0 }}>
                            {expanded ? '▾' : '▸'}
                        </span>
                    )}
                </div>
                {/* Expanded body */}
                {expanded && !isEmpty && (
                    <div style={{ borderTop: '1px solid var(--border)' }}>
                        <div
                            style={{
                                padding: '0.5rem 0.75rem',
                                fontSize: '0.75rem',
                                lineHeight: 1.6,
                                color: 'var(--foreground)',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                                maxHeight: 280,
                                overflowY: 'auto',
                            }}
                        >
                            {trimmed}
                        </div>
                        {isLong && (
                            <div
                                style={{
                                    padding: '0.25rem 0.75rem 0.4rem',
                                    borderTop: '1px dashed var(--border)',
                                    textAlign: 'right',
                                }}
                            >
                                <button
                                    onClick={(e) => { e.stopPropagation(); setShowModal(true); }}
                                    style={{ fontSize: '0.625rem', color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 500 }}
                                >
                                    查看全部 ›
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>
            {showModal && (
                <ContentModal title={modalTitle} raw={trimmed} onClose={() => setShowModal(false)} />
            )}
        </>
    );
}

function RoleSection({ role, label, raw, modalTitle }: { role: string; label: string; raw: string; modalTitle: string }) {
    const [showModal, setShowModal] = useState(false);
    const accent = ROLE_ACCENT[role] || 'var(--foreground-muted)';
    const bg     = ROLE_BG[role]    || 'transparent';
    const trimmed = raw.trim();
    const preview = trimmed.slice(0, PREVIEW_CHARS);
    const isTruncated = trimmed.length > PREVIEW_CHARS;

    return (
        <>
            <div style={{ borderBottom: '1px solid var(--border)', background: bg }}>
                {/* Role header bar */}
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0.3rem 0.625rem',
                    borderBottom: '1px solid var(--border)',
                    background: `${bg}`,
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: accent, flexShrink: 0, display: 'inline-block' }} />
                        <span style={{ fontSize: '0.5625rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: accent }}>{label}</span>
                    </div>
                    <button
                        onClick={() => setShowModal(true)}
                        style={{ fontSize: '0.5625rem', color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 500 }}
                    >
                        查看全部 ›
                    </button>
                </div>
                {/* Content preview */}
                <div
                    onClick={() => setShowModal(true)}
                    style={{
                        padding: '0.5rem 0.75rem',
                        fontSize: '0.75rem',
                        lineHeight: 1.6,
                        color: 'var(--foreground)',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        cursor: 'pointer',
                        maxHeight: 110,
                        overflow: 'hidden',
                        position: 'relative',
                        userSelect: 'none',
                    }}
                >
                    {preview}{isTruncated && ' …'}
                    {isTruncated && (
                        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 32, background: `linear-gradient(transparent, ${bg || 'var(--background-secondary)'})` }} />
                    )}
                </div>
            </div>
            {showModal && (
                <ContentModal title={modalTitle} raw={raw} onClose={() => setShowModal(false)} />
            )}
        </>
    );
}

// ─── EventDetailPanel (right panel – event selected) ─────────────────────────
function EventDetailPanel({ event, node, interactions }: { event: AgentEvent; node: AgentNode; interactions: RawInteraction[] }) {
    const km = KIND_META[event.kind] ?? KIND_META.tool;
    const dur = (event.startedAt != null && event.completedAt != null)
        ? formatDuration(event.completedAt - event.startedAt) : null;
    const time = event.startedAt != null ? new Date(event.startedAt).toLocaleTimeString() : '';
    const title = event.name || event.summary?.split('\n')[0]?.slice(0, 60) || km.label;

    const responseText =
        event.kind === 'llm' ? (event.interaction?.content || event.summary || '')
        : event.kind === 'user' ? (event.summary || event.interaction?.content || '')
        : '';

    const argsStr = event.args !== undefined
        ? (typeof event.args === 'string' ? event.args : JSON.stringify(event.args, null, 2))
        : null;
    const outputStr = (event.output !== undefined && event.output !== null)
        ? (typeof event.output === 'string' ? event.output : JSON.stringify(event.output, null, 2))
        : null;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Header */}
            <div style={{ padding: '0.75rem 1rem 0.625rem', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
                <div className="flex items-center gap-2 mb-1.5">
                    <KindBadge kind={event.kind} size="sm" />
                    <span className="flex-1 text-base font-semibold truncate text-foreground">{title}</span>
                </div>
                <div style={{ display: 'flex', gap: 12, fontSize: '0.6875rem', color: 'var(--foreground-muted)', flexWrap: 'wrap', alignItems: 'center' }}>
                    {time && <span>{time}</span>}
                    {dur && <span style={{ fontVariantNumeric: 'tabular-nums' }}>{dur}</span>}
                    {event.usage?.total ? <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatTokens(event.usage.total)} tok</span> : null}
                    <span style={{ opacity: 0.6 }}>from: {node.agentName}</span>
                </div>
            </div>

            {/* Body — all sections use CompactSection for consistent truncated-preview + modal pattern */}
            <div style={{ flex: 1, overflowY: 'scroll', padding: '0.875rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>

                {/* ── LLM ── */}
                {event.kind === 'llm' && (
                    <LLMEventBody event={event} responseText={responseText} interactions={interactions} node={node} />
                )}

                {/* ── User message ── */}
                {event.kind === 'user' && (
                    <CompactSection label="Message" raw={responseText || null} modalTitle={`${title} — Message`} />
                )}

                {/* ── Tool / Skill ── */}
                {(event.kind === 'tool' || event.kind === 'skill') && (
                    <>
                        <CompactSection label="Input" raw={argsStr} modalTitle={`${title} — Input`} />
                        <CompactSection label="Output" raw={outputStr} modalTitle={`${title} — Output`} />
                        {argsStr == null && outputStr == null && <EmptyDetail />}
                    </>
                )}

                {/* ── Task spawn ── */}
                {event.kind === 'task' && (
                    <div style={{ fontSize: '0.8125rem', color: 'var(--foreground-muted)', padding: '0.75rem', background: 'var(--background-secondary)', border: '1px solid var(--border)', borderRadius: 6 }}>
                        已生成子 Agent — 在左侧树中展开 TASK 行查看详情。
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── LLMEventBody ─────────────────────────────────────────────────────────────
function LLMEventBody({ event, responseText, interactions, node }: {
    event: AgentEvent;
    responseText: string;
    interactions: RawInteraction[];
    node: AgentNode;
}) {
    const it = event.interaction as RawInteraction & {
        model?: string;
        modelID?: string;
        model_id?: string;
        provider?: string;
        providerID?: string;
        temperature?: number;
        max_tokens?: number;
        maxTokens?: number;
        top_p?: number;
        frequency_penalty?: number;
        presence_penalty?: number;
        finish_reason?: string;
        stop_reason?: string;
        latency?: number;
    };
    const modelId: string | undefined = it.model || it.modelID || it.model_id || (it as any).modelId;
    const provider: string | undefined = it.provider || it.providerID;
    const temperature: number | undefined = it.temperature ?? (it as any).temp;
    const maxTokens: number | undefined = it.max_tokens ?? it.maxTokens;
    const topP: number | undefined = it.top_p;
    const freqPenalty: number | undefined = it.frequency_penalty;
    const presPenalty: number | undefined = it.presence_penalty;
    const finishReason: string | undefined = it.finish_reason || it.stop_reason;
    const callLatencyMs: number | undefined = it.latency
        ?? (event.completedAt != null && event.startedAt != null ? event.completedAt - event.startedAt : undefined);

    const usage = event.usage;
    const hasUsage = usage && (usage.total || usage.input || usage.output);

    const hasParams = modelId || provider || temperature != null || maxTokens != null
        || topP != null || freqPenalty != null || presPenalty != null || hasUsage || finishReason || callLatencyMs != null;

    const toolCallsTriggered = (it.tool_calls || []).filter(tc => {
        const n = tc.function?.name || tc.name || '';
        return n !== 'task' && n !== 'skill';
    });

    // Build chronological per-turn views for the Input (Prompt) panel.
    // If a context compaction happened in this node before the current LLM
    // event, the messages before the compaction were replaced (from the
    // model's perspective) by the compaction summary. We:
    //   - filter "prior verbatim turns" to those strictly AFTER the most
    //     recent compaction boundary, so the per-turn list only contains
    //     what the model still sees verbatim;
    //   - expose the active compaction (summary text + the now-folded
    //     original messages) so the UI can render a "Compacted History"
    //     section between System and the turn list.
    const { systemRaw, priorTurns, activeCompaction, foldedOriginalRaw, foldedOriginalCount } = useMemo(() => {
        const eventIdx = event.interactionIndex;

        // Most recent compaction boundary before this event in this node.
        const boundaries = node.compactions || [];
        const cutoff = boundaries.length
            ? [...boundaries].filter(c => c.interactionIndex < eventIdx).pop()
            : undefined;
        const cutoffIdx = cutoff ? cutoff.interactionIndex : -1;

        // Indices that the panel renders verbatim: post-cutoff, pre-event.
        const verbatimNodeIndices = new Set(
            node.interactionIndices.filter(i => i > cutoffIdx && i < eventIdx),
        );
        const verbatimMessages = interactions.filter((_, i) => verbatimNodeIndices.has(i));

        // Indices folded by the compaction (everything in the node that came
        // before the boundary). We keep them off the per-turn render path;
        // users can still drill in via the "view original" toggle.
        const foldedIndices = cutoff
            ? node.interactionIndices.filter(i => i < cutoffIdx)
            : [];
        const foldedMessages = foldedIndices.map(i => interactions[i]).filter(Boolean);

        const systemPrompts = node.systemPrompts || [];
        const systemParts: string[] = systemPrompts.map(sp => sp.text);
        const sep = '\n\n---\n\n';

        // When an assistant message has no text content, it usually means this
        // turn was a "pure tool-calling step" — the model emitted reasoning +
        // tool calls but no user-facing prose. Empty-rendering those is bad UX
        // (a wall of "(无文本内容)" rows). Synthesize a readable description
        // from tool_calls / reasoning parts so each turn carries real signal.
        const summarizeArgs = (raw: unknown): string => {
            if (raw == null) return '';
            try {
                const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
                if (obj && typeof obj === 'object') {
                    const r = obj as Record<string, unknown>;
                    // Prefer human-friendly keys when present.
                    for (const k of ['path', 'file_path', 'pattern', 'command', 'description', 'query', 'url']) {
                        const v = r[k];
                        if (typeof v === 'string' && v.trim()) return `${k}: ${v.length > 60 ? v.slice(0, 60) + '…' : v}`;
                    }
                    const keys = Object.keys(r);
                    if (keys.length) return keys.slice(0, 3).join(',') + (keys.length > 3 ? '…' : '');
                }
                return '';
            } catch {
                const s = typeof raw === 'string' ? raw : '';
                return s.length > 60 ? s.slice(0, 60) + '…' : s;
            }
        };
        const messageToText = (m: RawInteraction): string => {
            const text = typeof m.content === 'string' ? m.content : '';
            if (text.trim()) return text;
            // Empty text — fall back to tool-call / reasoning summary.
            const blocks: string[] = [];
            if (Array.isArray(m.parts)) {
                const reasoning = m.parts
                    .filter(p => (p?.type || '').toLowerCase() === 'reasoning')
                    .map(p => (typeof p.text === 'string' ? p.text.trim() : ''))
                    .filter(Boolean)
                    .join('\n\n');
                if (reasoning) blocks.push(`[reasoning]\n${reasoning}`);
            }
            if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
                const lines = m.tool_calls.map(tc => {
                    const name = tc.function?.name || tc.name || 'tool';
                    const args = tc.function?.arguments ?? tc.arguments;
                    const argSum = summarizeArgs(args);
                    return argSum ? `→ ${name}(${argSum})` : `→ ${name}()`;
                });
                blocks.push(`[tool calls × ${m.tool_calls.length}]\n${lines.join('\n')}`);
            }
            if (typeof m.content !== 'string' && m.content != null) {
                blocks.push(JSON.stringify(m.content, null, 2));
            }
            return blocks.join('\n\n');
        };
        const normalizeRole = (role: string | undefined) =>
            role === 'opencode' ? 'user' :
            role === 'subagent' ? 'assistant' :
            (role || 'unknown');

        // Walk verbatimMessages in chronological order; produce one card per
        // message, dropping role==='system' (those are already shown above).
        // The very last verbatim message is usually the user turn that
        // triggered this LLM call — we default-expand that one so the most
        // relevant context is visible at a glance.
        const turns: { role: string; content: string; position: number; isMostRecent: boolean }[] = [];
        let position = 0;
        for (let i = 0; i < verbatimMessages.length; i++) {
            const m = verbatimMessages[i];
            if (m.role === 'system') continue;
            position += 1;
            turns.push({
                role: normalizeRole(m.role),
                content: messageToText(m),
                position,
                isMostRecent: i === verbatimMessages.length - 1,
            });
        }

        const foldedRendered = foldedMessages
            .map(m => `[${normalizeRole(m.role)}] ${messageToText(m)}`)
            .join(sep);

        return {
            systemRaw:    systemParts.length > 0    ? systemParts.join(sep)    : null,
            priorTurns:   turns,
            activeCompaction: cutoff || null,
            foldedOriginalRaw: foldedRendered || null,
            foldedOriginalCount: foldedMessages.length,
        };
    }, [event.interactionIndex, interactions, node]);

    const title = event.name || event.summary?.split('\n')[0]?.slice(0, 60) || 'LLM';

    return (
        <>
            {/* Compact meta row: model + params + token counts */}
            {hasParams && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem', padding: '0.375rem 0.625rem', background: 'var(--background-secondary)', border: '1px solid var(--border)', borderRadius: 6 }}>
                    {/* Row 1: model identity */}
                    {(modelId || provider) && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem 1rem', alignItems: 'baseline' }}>
                            {modelId && (
                                <span style={{ fontSize: '0.6875rem', fontWeight: 600, color: 'var(--foreground)' }}>{modelId}</span>
                            )}
                            {provider && (
                                <span style={{ fontSize: '0.625rem', color: 'var(--foreground-muted)' }}>{provider}</span>
                            )}
                        </div>
                    )}
                    {/* Row 2: request parameters */}
                    {(temperature != null || maxTokens != null || topP != null || freqPenalty != null || presPenalty != null) && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem 1rem', alignItems: 'baseline' }}>
                            {temperature != null && (
                                <LLMParam label="temperature" value={temperature} />
                            )}
                            {maxTokens != null && (
                                <LLMParam label="max_tokens" value={maxTokens.toLocaleString()} />
                            )}
                            {topP != null && (
                                <LLMParam label="top_p" value={topP} />
                            )}
                            {freqPenalty != null && (
                                <LLMParam label="freq_penalty" value={freqPenalty} />
                            )}
                            {presPenalty != null && (
                                <LLMParam label="pres_penalty" value={presPenalty} />
                            )}
                        </div>
                    )}
                    {/* Row 3: usage + latency + finish_reason */}
                    {(hasUsage || finishReason || callLatencyMs != null) && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem 1rem', alignItems: 'baseline' }}>
                            {hasUsage && (
                                <span style={{ fontSize: '0.625rem', color: 'var(--foreground-muted)' }}>
                                    {usage!.input != null && usage!.input > 0 && <span>in <b style={{ color: 'var(--foreground)' }}>{formatTokens(usage!.input)}</b> </span>}
                                    {usage!.output != null && usage!.output > 0 && <span>out <b style={{ color: 'var(--primary)' }}>{formatTokens(usage!.output)}</b> </span>}
                                    {usage!.cache?.read != null && usage!.cache.read > 0 && <span>cache <b style={{ color: 'var(--success)' }}>{formatTokens(usage!.cache.read)}</b> </span>}
                                    {usage!.reasoning != null && usage!.reasoning > 0 && <span>think <b style={{ color: 'var(--foreground-secondary)' }}>{formatTokens(usage!.reasoning)}</b> </span>}
                                    {usage!.total != null && usage!.total > 0 && <span>total <b style={{ color: 'var(--foreground)', fontWeight: 700 }}>{formatTokens(usage!.total)}</b></span>}
                                </span>
                            )}
                            {callLatencyMs != null && (
                                <LLMParam label="latency" value={callLatencyMs < 1000 ? `${callLatencyMs}ms` : `${(callLatencyMs / 1000).toFixed(2)}s`} />
                            )}
                            {finishReason && (
                                <LLMParam label="finish" value={finishReason} />
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Input — System + [Compacted History] + chronological turn list */}
            {(systemRaw || priorTurns.length > 0 || activeCompaction) && (
                <div>
                    <SectionTitle>
                        Input (Prompt)
                        {priorTurns.length > 0 && (
                            <span style={{ marginLeft: '0.5rem', fontSize: '0.625rem', fontWeight: 400, color: 'var(--foreground-muted)' }}>
                                · {priorTurns.length} turn{priorTurns.length === 1 ? '' : 's'}
                            </span>
                        )}
                    </SectionTitle>
                    <div style={{
                        border: '1px solid var(--border)',
                        borderRadius: 7,
                        overflow: 'hidden',
                    }}>
                        {systemRaw && (
                            <RoleSection role="system" label="System" raw={systemRaw} modalTitle={`${title} — System`} />
                        )}
                        {activeCompaction && (
                            <CompactionSection
                                summaryRaw={activeCompaction.summaryText || ''}
                                foldedOriginalRaw={foldedOriginalRaw}
                                foldedCount={foldedOriginalCount}
                                modelLabel={activeCompaction.modelID || activeCompaction.providerID}
                                summaryUsage={activeCompaction.usage}
                                modalTitleBase={title}
                            />
                        )}
                        {priorTurns.map((turn, i) => (
                            <TurnPreviewRow
                                key={`${turn.role}-${turn.position}-${i}`}
                                role={turn.role}
                                content={turn.content}
                                position={turn.position}
                                defaultExpanded={turn.isMostRecent}
                                modalTitle={`${title} — ${turn.role} #${turn.position}`}
                            />
                        ))}
                    </div>
                </div>
            )}

            {/* Output — compact preview */}
            <CompactSection
                label="Output"
                raw={responseText || null}
                modalTitle={`${title} — Output`}
                emptyText={toolCallsTriggered.length > 0 ? '(无文本输出 — 仅工具调用)' : undefined}
            />

            {/* Tool calls triggered — compact chip list */}
            {toolCallsTriggered.length > 0 && (
                <div>
                    <SectionTitle>Tool calls ({toolCallsTriggered.length})</SectionTitle>
                    <div className="flex flex-wrap gap-1">
                        {toolCallsTriggered.slice(0, 12).map((tc, i) => {
                            const name = tc.function?.name || tc.name || 'unknown';
                            return (
                                <span
                                    key={i}
                                    className={cn(
                                        'inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded-sm border',
                                        KIND_META.tool.chip,
                                    )}
                                >
                                    {name}
                                </span>
                            );
                        })}
                        {toolCallsTriggered.length > 12 && (
                            <span className="text-xs text-foreground-muted self-center">+{toolCallsTriggered.length - 12}</span>
                        )}
                    </div>
                </div>
            )}
        </>
    );
}

// ─── ToolCallTriggeredItem & Modal ─────────────────────────────────────────────
function ToolCallTriggeredItem({ tc }: { tc: ToolCall }) {
    const [showModal, setShowModal] = useState(false);
    const name = tc.function?.name || tc.name || 'unknown';
    const argStr = tc.function?.arguments ?? tc.arguments ?? '';
    const argPreview = typeof argStr === 'string' ? argStr.slice(0, 80) : '';
    const isLong = typeof argStr === 'string' && argStr.length > 80;

    return (
        <>
            <div
                onClick={() => { if (isLong) setShowModal(true); }}
                className={cn(
                    'flex items-baseline gap-2 px-2 py-1 bg-background-secondary border border-border rounded-md',
                    isLong ? 'cursor-pointer hover:bg-background-tertiary' : 'cursor-default',
                )}
            >
                <span className={cn('text-xs font-semibold shrink-0', KIND_META.tool.text)}>{name}</span>
                {argPreview && <span className="text-xs text-foreground-muted truncate">{argPreview}{isLong ? '…' : ''}</span>}
                {isLong && <span className="ml-auto text-xs text-primary shrink-0 whitespace-nowrap">View full ↗</span>}
            </div>
            {showModal && (
                <ToolCallContentModal name={name} args={argStr as string} onClose={() => setShowModal(false)} />
            )}
        </>
    );
}

function ToolCallContentModal({ name, args, onClose }: { name: string; args: string; onClose: () => void }) {
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try {
            await copyText(args);
            setCopied(true);
            toast.success('Copied');
            setTimeout(() => setCopied(false), 1400);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error('[copy] all methods failed:', msg);
            toast.error(`Copy failed: ${msg.slice(0, 60)}`);
        }
    };

    let displayArgs = args;
    try {
        displayArgs = JSON.stringify(JSON.parse(args), null, 2);
    } catch {}

    return (
        <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
            <DialogContent className="max-w-[780px] max-h-[88vh] flex flex-col p-0 gap-0">
                <DialogHeader className="flex-row items-center gap-3 p-4 border-b border-border space-y-0">
                    <span className="text-xs font-bold uppercase tracking-wider text-foreground-muted bg-background-secondary border border-border rounded-sm px-2 py-0.5">TOOL CALL</span>
                    <DialogTitle className="text-sm font-semibold text-foreground">{name}</DialogTitle>
                    <div className="flex-1" />
                    <span className="text-xs text-foreground-muted tabular-nums">{args.length.toLocaleString()} chars</span>
                    <Button variant={copied ? 'default' : 'outline'} size="sm" onClick={copy} className="h-7 text-xs">
                        {copied ? <><Check className="size-3" />Copied</> : <><CopyIcon className="size-3" />Copy</>}
                    </Button>
                </DialogHeader>
                <div className="overflow-y-auto p-6 flex-1">
                    <ModalCodeBlock value={displayArgs} />
                </div>
            </DialogContent>
        </Dialog>
    );
}

// ─── PromptMessage ─────────────────────────────────────────────────────────────
const PROMPT_MSG_LIMIT = 300;
const ROLE_COLOR: Record<string, string> = {
    system:    '#7C3AED',
    user:      '#0284C7',
    opencode:  '#0284C7',
    assistant: 'var(--primary)',
    subagent:  'var(--primary)',
};
function PromptMessage({ role, content, toolCalls }: { role: string; content: string; toolCalls?: ToolCall[] }) {
    const [showModal, setShowModal] = useState(false);
    const isLong = content.length > PROMPT_MSG_LIMIT;
    const display = isLong ? content.slice(0, PROMPT_MSG_LIMIT) + '…' : content;
    // Sub-agent messages are shown with their logical role for readability
    const displayRole = role === 'opencode' ? 'user' : role === 'subagent' ? 'assistant' : role;
    const color = ROLE_COLOR[role] || 'var(--foreground-muted)';
    return (
        <>
            <div style={{ padding: '0.375rem 0.5rem', background: 'var(--card-bg)', borderRadius: 4, border: '1px solid var(--border)', fontSize: '0.75rem', lineHeight: 1.5 }}>
                <div style={{ fontSize: '0.5rem', fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.25rem' }}>{displayRole}</div>
                {content && (
                    <>
                        <SmartViewer
                            text={display}
                            toolbar={false}
                            maxHeight="none"
                            theme="light"
                            unescape={false}
                            className="sv-inline sv-compact"
                        />
                        {isLong && (
                            <button onClick={() => setShowModal(true)} style={{ fontSize: '0.5625rem', marginTop: 4, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                                查看全部
                            </button>
                        )}
                    </>
                )}
                {toolCalls && toolCalls.length > 0 && (
                    <div style={{ fontSize: '0.5625rem', color: 'var(--foreground-muted)', marginTop: content ? 4 : 0 }}>
                        [工具调用: {toolCalls.map(tc => tc.function?.name || tc.name || '?').join(', ')}]
                    </div>
                )}
            </div>
            {showModal && (
                <MessageContentModal role={role} content={content} onClose={() => setShowModal(false)} />
            )}
        </>
    );
}

// ─── MessageContentModal ──────────────────────────────────────────────────────
function MessageContentModal({ role, content, onClose }: { role: string; content: string; onClose: () => void }) {
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try {
            await copyText(content);
            setCopied(true);
            toast.success('Copied');
            setTimeout(() => setCopied(false), 1400);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error('[copy] all methods failed:', msg);
            toast.error(`Copy failed: ${msg.slice(0, 60)}`);
        }
    };
    const displayRole = role === 'opencode' ? 'user' : role === 'subagent' ? 'assistant' : role;

    return (
        <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
            <DialogContent className="max-w-[780px] max-h-[88vh] flex flex-col p-0 gap-0">
                <DialogHeader className="flex-row items-center gap-3 p-4 border-b border-border space-y-0">
                    <DialogTitle className="text-xs font-bold uppercase tracking-wider text-foreground-muted bg-background-secondary border border-border rounded-sm px-2 py-0.5">{displayRole} MESSAGE</DialogTitle>
                    <div className="flex-1" />
                    <span className="text-xs text-foreground-muted tabular-nums">{content.length.toLocaleString()} chars</span>
                    <Button variant={copied ? 'default' : 'outline'} size="sm" onClick={copy} className="h-7 text-xs">
                        {copied ? <><Check className="size-3" />Copied</> : <><CopyIcon className="size-3" />Copy</>}
                    </Button>
                </DialogHeader>
                <div className="overflow-y-auto p-6 flex-1">
                    <MarkdownContent text={content} />
                </div>
            </DialogContent>
        </Dialog>
    );
}

function ModelChip({ label, value }: { label: string; value: string }) {
    return (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, padding: '0.25rem 0.625rem', background: 'var(--background-secondary)', border: '1px solid var(--border)', borderRadius: 5 }}>
            <span style={{ fontSize: '0.5625rem', color: 'var(--foreground-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
            <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--foreground)' }}>{value}</span>
        </div>
    );
}

function TokenPill({ label, value, color, bold }: { label: string; value: number; color: string; bold?: boolean }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0.375rem 0.75rem', background: 'var(--background-secondary)', border: `1px solid var(--border)`, borderRadius: 6, minWidth: 72, textAlign: 'center' }}>
            <span style={{ fontSize: '1rem', fontWeight: bold ? 700 : 600, color, fontVariantNumeric: 'tabular-nums', lineHeight: 1.3 }}>{value.toLocaleString()}</span>
            <span style={{ fontSize: '0.5rem', color: 'var(--foreground-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2 }}>{label}</span>
        </div>
    );
}

function ExpandBtn({ onClick }: { onClick: () => void }) {
    return (
        <button onClick={onClick} style={{ fontSize: '0.75rem', color: 'var(--primary)', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 500 }}>
            查看完整内容 →
        </button>
    );
}

function EmptyDetail() {
    return (
        <div style={{ fontSize: '0.8125rem', color: 'var(--foreground-muted)', textAlign: 'center', paddingTop: '2rem' }}>
            暂无详细数据
        </div>
    );
}

function InlineCodeBlock({ text }: { text: string }) {
    return (
        <SmartViewer
            text={text}
            toolbar={false}
            maxHeight={340}
            theme="light"
        />
    );
}

// ─── AgentDetail (right panel) ────────────────────────────────────────────────
function AgentDetail({
    node, highlightEvent, activeTab, onTabChange, eventTypeFilter, onEventTypeFilterChange,
    totalDurationMs, onSelectChild, interactions, traceSkills, currentUser
}: {
    node: AgentNode;
    highlightEvent: AgentEvent | null;
    activeTab: DetailTab;
    onTabChange: (t: DetailTab) => void;
    eventTypeFilter: EventTypeFilter;
    onEventTypeFilterChange: (f: EventTypeFilter) => void;
    totalDurationMs?: number;
    onSelectChild: (id: string) => void;
    interactions: RawInteraction[];
    traceSkills: TraceSkillUsage[];
    currentUser?: string | null;
}) {
    const status = getStatus(node);
    const hasPrompt = !!(node.systemPrompts && node.systemPrompts.length > 0);

    const tabs: { id: DetailTab; label: string; count?: number }[] = [
        { id: 'overview', label: '概览' },
        { id: 'timeline', label: '时间线', count: node.events.length },
        { id: 'skills', label: 'Skills', count: traceSkills.length },
        ...(hasPrompt ? [{ id: 'prompt' as DetailTab, label: 'System Prompt', count: node.systemPrompts!.length }] : []),
    ];

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Header */}
            <div style={{ padding: '0.75rem 1rem 0', flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.375rem' }}>
                    <span className={cn('size-2 rounded-full shrink-0', STATUS_DOT[status])} />
                    <h3 style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 600 }}>{node.agentName}</h3>
                    {node.parallelCallCount && node.parallelCallCount > 1 && (
                        <span style={{ fontSize: '0.625rem', padding: '0.125rem 0.4375rem', background: 'var(--background-tertiary)', border: '1px solid var(--border)', color: 'var(--foreground-muted)', borderRadius: 999, fontWeight: 500 }}>
                            ×{node.parallelCallCount} parallel
                        </span>
                    )}
                    <div style={{ flex: 1 }} />
                    <span style={{ fontSize: '0.6875rem', color: 'var(--foreground-muted)' }}>depth: {node.depth}</span>
                    {node.subagentType && (
                        <span style={{ fontSize: '0.5625rem', padding: '0.125rem 0.4375rem', background: 'var(--background-tertiary)', border: '1px solid var(--border)', color: 'var(--foreground-muted)', borderRadius: 4 }}>
                            {node.subagentType}
                        </span>
                    )}
                </div>

                {/* Duration bar */}
                {totalDurationMs && node.stats.durationMs != null && (
                    <div className="mb-2">
                        <div className="h-1 bg-background-secondary rounded-sm overflow-hidden">
                            <div
                                className={cn('h-full rounded-sm transition-[width]', status === 'slow' ? 'bg-warning' : 'bg-primary')}
                                style={{ width: `${Math.min(100, (node.stats.durationMs / totalDurationMs) * 100)}%` }}
                            />
                        </div>
                        <div className="flex justify-between text-xs text-foreground-muted mt-0.5">
                            <span className={cn('font-semibold', status === 'slow' ? 'text-warning' : 'text-foreground')}>{formatDuration(node.stats.durationMs)}</span>
                            <span>{Math.round((node.stats.durationMs / totalDurationMs) * 100)}% of total</span>
                        </div>
                    </div>
                )}

                {/* Tabs */}
                <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', marginTop: '0.25rem' }}>
                    {tabs.map(tab => (
                        <button key={tab.id} onClick={() => onTabChange(tab.id)} style={{
                            padding: '0.4rem 0.75rem', fontSize: '0.75rem', border: 'none',
                            borderBottom: activeTab === tab.id ? '2px solid var(--primary)' : '2px solid transparent',
                            background: 'transparent',
                            color: activeTab === tab.id ? 'var(--primary)' : 'var(--foreground-muted)',
                            cursor: 'pointer', fontWeight: activeTab === tab.id ? 600 : 400, transition: 'color 0.12s',
                            display: 'flex', alignItems: 'center', gap: 5, marginBottom: -1,
                        }}>
                            {tab.label}
                            {tab.count != null && (
                                <span style={{ fontSize: '0.5625rem', padding: '0 4px', borderRadius: 8, background: activeTab === tab.id ? 'var(--primary-subtle)' : 'var(--background-tertiary)', color: activeTab === tab.id ? 'var(--primary)' : 'var(--foreground-muted)', fontVariantNumeric: 'tabular-nums', fontWeight: 600, minWidth: 16, textAlign: 'center' }}>
                                    {tab.count}
                                </span>
                            )}
                        </button>
                    ))}
                </div>
            </div>

            <div style={{ flex: 1, overflowY: 'scroll', padding: '0.75rem 1rem' }}>
                {activeTab === 'overview' && <OverviewTab node={node} status={status} onSelectChild={onSelectChild} />}
                {activeTab === 'timeline' && (
                    <TimelineTab
                        events={node.events}
                        eventTypeFilter={eventTypeFilter}
                        onEventTypeFilterChange={onEventTypeFilterChange}
                        onSelectChild={onSelectChild}
                        node={node}
                        interactions={interactions}
                    />
                )}
                {activeTab === 'skills' && <SkillsTab skills={traceSkills} currentUser={currentUser} />}
                {activeTab === 'prompt' && hasPrompt && <SystemPromptsBlock prompts={node.systemPrompts!} />}
            </div>
        </div>
    );
}

function SkillsTab({ skills, currentUser }: { skills: TraceSkillUsage[]; currentUser?: string | null }) {
    const managed = skills.filter(s => s.status === 'managed');
    const unregistered = skills.filter(s => s.status === 'unregistered');

    if (skills.length === 0) {
        return (
            <div style={{
                padding: '1rem',
                background: 'var(--background-secondary)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                color: 'var(--foreground-muted)',
                fontSize: '0.75rem',
                textAlign: 'center',
            }}>
                该 Trace 未检测到 Skill 调用
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <SkillGroup
                title="已管理资产"
                count={managed.length}
                empty="本 Trace 没有命中已管理 Skill 资产"
                skills={managed}
                currentUser={currentUser}
            />
            <SkillGroup
                title="未注册资产"
                count={unregistered.length}
                empty="没有未注册 Skill"
                skills={unregistered}
                currentUser={currentUser}
            />
        </div>
    );
}

function SkillGroup({
    title,
    count,
    empty,
    skills,
    currentUser,
}: {
    title: string;
    count: number;
    empty: string;
    skills: TraceSkillUsage[];
    currentUser?: string | null;
}) {
    return (
        <div>
            <SectionTitle>{title} ({count})</SectionTitle>
            {skills.length === 0 ? (
                <div style={{
                    padding: '0.75rem',
                    border: '1px dashed var(--border)',
                    borderRadius: 8,
                    color: 'var(--foreground-muted)',
                    fontSize: '0.75rem',
                    background: 'var(--background-secondary)',
                }}>
                    {empty}
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {skills.map(skill => (
                        <SkillUsageCard
                            key={`${skill.status}-${skill.name}-${skill.displayVersion ?? 'unknown'}-${skill.reportedVersion ?? 'none'}`}
                            skill={skill}
                            currentUser={currentUser}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function SkillUsageCard({ skill, currentUser }: { skill: TraceSkillUsage; currentUser?: string | null }) {
    const managed = skill.status === 'managed';
    const activeVersion = normalizeSkillVersion(skill.asset?.activeVersion ?? skill.asset?.version);
    const versionLabel = skill.displayVersion !== null ? `v${skill.displayVersion}` : '版本未知';
    const versionHint =
        skill.versionSource === 'reported'
            ? 'Trace 上报版本'
            : skill.versionSource === 'active'
                ? '平台当前激活版本'
                : 'Trace 未上报版本，平台也未匹配到已管理资产';

    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            padding: '0.625rem 0.75rem',
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: managed ? 'var(--card-bg)' : 'var(--background-secondary)',
        }}>
            <span style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: managed ? 'var(--success)' : 'var(--warning)',
                backgroundColor: managed ? 'var(--success, #16a34a)' : 'var(--warning, #d97706)',
                flexShrink: 0,
            }} />
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--foreground)' }}>
                        {/* managed: SkillLink 内部跳 /skills?openSkillId=<id>&openVersion=<displayVersion>,
                           skill 管理 (SkillCatalogV2) 读这俩 query 自动打开对应 skill 的抽屉并落到 trace 上报版本。
                           unregistered: disabled SkillLink,灰字不可点 + tooltip。 */}
                        <SkillLink
                            skillId={skill.asset?.id}
                            skillName={skill.name}
                            version={skill.displayVersion}
                            user={currentUser}
                            disabled={!managed}
                        />
                    </span>
                    <span style={{
                        fontSize: '0.5625rem',
                        fontWeight: 700,
                        padding: '0.1rem 0.4rem',
                        borderRadius: 999,
                        border: `1px solid ${managed ? 'var(--success, #16a34a)' : 'var(--warning, #d97706)'}`,
                        color: managed ? 'var(--success, #16a34a)' : 'var(--warning, #d97706)',
                        background: managed ? 'var(--success-subtle, rgba(22, 163, 74, 0.10))' : 'var(--warning-subtle, rgba(217, 119, 6, 0.10))',
                    }}>
                        {managed ? '已管理' : '未注册'}
                    </span>
                </div>
                <div style={{ marginTop: 3, display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: '0.6875rem', color: 'var(--foreground-muted)' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--foreground-secondary)' }}>{versionLabel}</span>
                    <span>{versionHint}</span>
                    {skill.reportedVersion !== null && skill.versionSource === 'reported' && managed && activeVersion !== null && skill.displayVersion !== activeVersion && (
                        <span>平台当前激活：v{activeVersion}</span>
                    )}
                </div>
            </div>
        </div>
    );
}

// ─── OverviewTab ──────────────────────────────────────────────────────────────
function OverviewTab({ node, status, onSelectChild }: { node: AgentNode; status: NodeStatus; onSelectChild: (id: string) => void }) {
    const overviewCtx = React.useContext(TraceCtx);
    const stats = aggregateSubtreeStats(node);
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div>
                <SectionTitle>调用统计</SectionTitle>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem' }}>
                    {[
                        { label: 'Task',  value: stats.taskCalls  },
                        { label: 'Tool',  value: stats.toolCalls  },
                        { label: 'Skill', value: stats.skillCalls },
                        { label: 'LLM',   value: stats.llmCalls   },
                    ].map(({ label, value }) => (
                        <div key={label} style={{ padding: '0.5rem 0.75rem', background: 'var(--background-secondary)', border: '1px solid var(--border)', borderRadius: 6, textAlign: 'center' }}>
                            <div style={{ fontSize: '1.125rem', fontWeight: 700, color: value === 0 ? 'var(--foreground-muted)' : 'var(--foreground)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
                            <div style={{ fontSize: '0.5625rem', color: 'var(--foreground-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2 }}>{label}</div>
                        </div>
                    ))}
                </div>
            </div>

            <div>
                <SectionTitle>Token 消耗</SectionTitle>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '0.5rem' }}>
                    {[
                        { label: 'Input',  value: stats.inputTokens },
                        { label: 'Output', value: stats.outputTokens },
                        { label: 'Cache Read', value: stats.cacheReadTokens },
                        { label: 'Cache Write', value: stats.cacheWriteTokens },
                        { label: 'Total',  value: stats.totalTokens },
                    ].filter(({ value, label }) => value > 0 || label === 'Total').map(({ label, value }) => (
                        <div key={label} style={{ padding: '0.5rem 0.75rem', background: 'var(--background-secondary)', border: '1px solid var(--border)', borderRadius: 6, textAlign: 'center' }}>
                            <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--foreground)', fontVariantNumeric: 'tabular-nums' }}>{formatTokens(value)}</div>
                            <div style={{ fontSize: '0.5625rem', color: 'var(--foreground-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2 }}>{label}</div>
                        </div>
                    ))}
                </div>
            </div>

            {node.children.length > 0 && (
                <div>
                    <SectionTitle>子 Agent ({node.children.length})</SectionTitle>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                        {node.children.map(child => {
                            const childStatus = getStatus(child);
                            const pct = node.stats.durationMs && child.stats.durationMs != null
                                ? Math.min(100, (child.stats.durationMs / node.stats.durationMs) * 100) : 0;
                            return (
                                <div
                                    key={child.id}
                                    onClick={() => onSelectChild(child.id)}
                                    tabIndex={0}
                                    role="button"
                                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSelectChild(child.id); } }}
                                    className="p-2 rounded-md border border-border bg-background-secondary hover:bg-background-tertiary cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                    <div className={cn('flex items-center gap-2', pct > 0 && 'mb-1.5')}>
                                        {childStatus !== 'ok' && <span className={cn('size-1.5 rounded-full shrink-0', STATUS_DOT[childStatus])} />}
                                        <span className="flex-1 text-sm font-medium truncate">{child.agentName}</span>
                                        <span className={cn('text-xs tabular-nums shrink-0 font-mono', childStatus === 'slow' ? 'text-warning' : 'text-foreground-muted')}>{formatDuration(child.stats.durationMs)}</span>
                                        <span className="text-xs text-foreground-muted tabular-nums shrink-0 font-mono">{formatTokens(child.stats.totalTokens)}</span>
                                        {child.sessionId && overviewCtx.onSubagentNavigate && (
                                            <button
                                                type="button"
                                                title="在独立 Trace 视图中打开此 Sub-Agent"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    overviewCtx.onSubagentNavigate?.(child.sessionId!);
                                                }}
                                                className="px-2 py-0.5 text-xs font-semibold tracking-wider rounded-sm border border-primary text-primary bg-primary/10 hover:bg-primary/20 shrink-0 cursor-pointer"
                                            >
                                                Trace
                                            </button>
                                        )}
                                    </div>
                                    {pct > 0 && (
                                        <div className="h-[3px] bg-background-tertiary rounded-sm overflow-hidden">
                                            <div
                                                className={cn('h-full rounded-sm', childStatus === 'slow' ? 'bg-warning' : 'bg-foreground-muted')}
                                                style={{ width: `${pct}%` }}
                                            />
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* TopN quick navigation panel — shown only for root agent or when tree context has data */}
            <TopNPanel />
        </div>
    );
}

// ─── TopNPanel ────────────────────────────────────────────────────────────────
function TopNPanel() {
    const { topNDuration, topNTokens, slowNodesList, onJumpToKey } = React.useContext(TraceCtx);
    const [tab, setTab] = useState<'duration' | 'tokens' | 'slow'>('duration');

    if (topNDuration.length === 0 && topNTokens.length === 0 && slowNodesList.length === 0) return null;

    const tabs: { id: 'duration' | 'tokens' | 'slow'; icon: string; label: string; count: number }[] = [
        { id: 'duration', icon: '⏱', label: '耗时 Top 5', count: topNDuration.length },
        { id: 'tokens',   icon: '💬', label: 'Token Top 5', count: topNTokens.length },
        { id: 'slow',     icon: '⚠', label: '异常节点', count: slowNodesList.length },
    ];

    const items = tab === 'duration' ? topNDuration : tab === 'tokens' ? topNTokens : slowNodesList;

    return (
        <div style={{ marginTop: '0.5rem' }}>
            <SectionTitle>快速定位</SectionTitle>
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                {/* Tab bar */}
                <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', background: 'var(--background-secondary)' }}>
                    {tabs.map(t => (
                        <button key={t.id} onClick={() => setTab(t.id)} style={{
                            flex: 1, padding: '0.3125rem 0.25rem', fontSize: '0.625rem', border: 'none',
                            borderBottom: tab === t.id ? '2px solid var(--primary)' : '2px solid transparent',
                            background: 'transparent', color: tab === t.id ? 'var(--primary)' : 'var(--foreground-muted)',
                            cursor: 'pointer', fontWeight: tab === t.id ? 600 : 400, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
                        }}>
                            <span>{t.icon}</span>
                            <span style={{ display: 'none' }}>{t.label}</span>
                            <span style={{ fontSize: '0.5rem', padding: '0 3px', borderRadius: 6, background: tab === t.id ? 'var(--primary-subtle)' : 'var(--background-tertiary)', color: tab === t.id ? 'var(--primary)' : 'var(--foreground-muted)', minWidth: 14, textAlign: 'center' }}>
                                {t.count}
                            </span>
                        </button>
                    ))}
                </div>
                {/* Items */}
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {items.length === 0 ? (
                        <div className="p-3 text-sm text-foreground-muted text-center italic">No data</div>
                    ) : items.map((span, i) => {
                        const metric = tab === 'tokens'
                            ? (span.tokens ? formatTokens(span.tokens) : '-')
                            : (span.durationMs ? formatDuration(span.durationMs) : '-');
                        const isWarn = tab === 'slow' || span.isSlow;
                        return (
                            <div
                                key={span.key}
                                onClick={() => onJumpToKey(span.key)}
                                className={cn(
                                    'flex items-center gap-2 px-2 py-1.5 cursor-pointer transition-colors hover:bg-background-secondary',
                                    i < items.length - 1 && 'border-b border-border',
                                )}
                            >
                                <span className="text-xs text-foreground-muted tabular-nums w-3 shrink-0 text-right">{i + 1}</span>
                                <KindBadge kind={span.kind} />
                                <span className="flex-1 text-xs text-foreground truncate">{span.label}</span>
                                <span className={cn('text-xs tabular-nums shrink-0 font-semibold', isWarn ? 'text-warning' : 'text-foreground-muted')}>{metric}</span>
                                <span className="text-xs text-primary shrink-0">→</span>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

// ─── TimelineTab ──────────────────────────────────────────────────────────────
function TimelineTab({ events, eventTypeFilter, onEventTypeFilterChange, onSelectChild, node, interactions }: {
    events: AgentEvent[];
    eventTypeFilter: EventTypeFilter;
    onEventTypeFilterChange: (f: EventTypeFilter) => void;
    onSelectChild: (id: string) => void;
    node: AgentNode;
    interactions: RawInteraction[];
}) {
    const counts = useMemo(() => {
        const c: Record<string, number> = { llm: 0, tool: 0, skill: 0, task: 0, user: 0 };
        events.forEach(ev => { if (c[ev.kind] != null) c[ev.kind]++; });
        return c;
    }, [events]);

    const filtered = useMemo(() => {
        if (eventTypeFilter === 'all') return events;
        return events.filter(ev => ev.kind === eventTypeFilter);
    }, [events, eventTypeFilter]);

    const filterTypes: { kind: EventTypeFilter; label: string }[] = [
        { kind: 'all', label: 'All' },
        { kind: 'llm', label: 'LLM' },
        { kind: 'tool', label: 'Tool' },
        { kind: 'task', label: 'Task' },
        { kind: 'skill', label: 'Skill' },
        { kind: 'user', label: 'User' },
    ];

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
                {filterTypes.map(({ kind, label }) => {
                    const meta = kind !== 'all' ? KIND_META[kind] : null;
                    const count = kind === 'all' ? events.length : counts[kind] ?? 0;
                    if (kind !== 'all' && count === 0) return null;
                    const isActive = eventTypeFilter === kind;
                    return (
                        <button
                            key={kind}
                            onClick={() => onEventTypeFilterChange(kind)}
                            className={cn(
                                'inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium border rounded-full transition-colors',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                isActive && meta
                                    ? meta.chip + ' font-bold'
                                    : isActive
                                        ? 'bg-background-tertiary border-border text-foreground font-bold'
                                        : 'bg-transparent border-border text-foreground-muted hover:bg-background-secondary',
                            )}
                        >
                            {label}
                            <span className={cn(
                                'inline-flex items-center justify-center px-1 min-w-[16px] rounded-full tabular-nums text-xs font-semibold',
                                isActive && meta ? 'bg-background/40' : 'bg-background-tertiary text-foreground-muted',
                            )}>
                                {count}
                            </span>
                        </button>
                    );
                })}
            </div>
            {filtered.length === 0
                ? <div className="text-sm text-foreground-muted py-3">{eventTypeFilter !== 'all' ? `No ${eventTypeFilter.toUpperCase()} events` : '(no events)'}</div>
                : <TimelineTree events={filtered} onSelectChild={onSelectChild} node={node} interactions={interactions} />
            }
        </div>
    );
}

// ─── TimelineTree ─────────────────────────────────────────────────────────────
interface TimelineNode { event: AgentEvent; children: AgentEvent[]; index: number; }

function groupEventsAsTree(events: AgentEvent[]): TimelineNode[] {
    const roots: TimelineNode[] = [];
    let currentParent: TimelineNode | null = null;
    events.forEach((ev, i) => {
        if (ev.kind === 'user' || ev.kind === 'llm') {
            const node: TimelineNode = { event: ev, children: [], index: i };
            roots.push(node);
            currentParent = node;
        } else {
            if (currentParent) currentParent.children.push(ev);
            else roots.push({ event: ev, children: [], index: i });
        }
    });
    return roots;
}

function TimelineTree({ events, onSelectChild, node, interactions }: { events: AgentEvent[]; onSelectChild: (id: string) => void; node: AgentNode; interactions: RawInteraction[]; }) {
    const [expandedIdx, setExpandedIdx] = useState<Set<number>>(() => {
        const s = new Set<number>();
        events.forEach((ev, i) => { if (ev.kind === 'llm' || ev.kind === 'user') s.add(i); });
        return s;
    });
    const tree = useMemo(() => groupEventsAsTree(events), [events]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
            {tree.map((tNode, ti) => {
                const hasChildren = tNode.children.length > 0;
                const isExpanded = expandedIdx.has(tNode.index);
                return (
                    <div key={tNode.index}>
                        <TimelineEventRow event={tNode.event} hasChildren={hasChildren} isExpanded={isExpanded}
                            onToggle={() => setExpandedIdx(s => { const n = new Set(s); n.has(tNode.index) ? n.delete(tNode.index) : n.add(tNode.index); return n; })}
                            onSelectChild={onSelectChild} indent={0} isLast={ti === tree.length - 1 && (!hasChildren || !isExpanded)} showVerticalLine={ti !== tree.length - 1 || (hasChildren && isExpanded)} node={node} interactions={interactions} />
                        {hasChildren && isExpanded && (
                            <div style={{ borderLeft: '1px solid var(--border)', marginLeft: 18 }}>
                                {tNode.children.map((child, ci) => (
                                    <TimelineEventRow key={ci} event={child} hasChildren={false} isExpanded={false}
                                        onToggle={() => { }} onSelectChild={onSelectChild}
                                        indent={1} isLast={ci === tNode.children.length - 1} showVerticalLine={false} node={node} interactions={interactions} />
                                ))}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

// ─── TimelineEventRow ─────────────────────────────────────────────────────────
function TimelineEventRow({ event, hasChildren, isExpanded, onToggle, onSelectChild, indent, isLast, showVerticalLine, node, interactions }: {
    event: AgentEvent; hasChildren: boolean; isExpanded: boolean;
    onToggle: () => void; onSelectChild: (id: string) => void;
    indent: number; isLast: boolean; showVerticalLine: boolean;
    node: AgentNode; interactions: RawInteraction[];
}) {
    const [modalOpen, setModalOpen] = useState(false);
    const meta = KIND_META[event.kind] ?? KIND_META.tool;
    const dur = (event.startedAt != null && event.completedAt != null) ? formatDuration(event.completedAt - event.startedAt) : null;
    const time = event.startedAt != null ? new Date(event.startedAt).toLocaleTimeString() : '';
    const showDetail = !!(event.args !== undefined || event.output !== undefined || event.interaction?.content || event.summary);
    const summaryText = event.summary || event.name || '(empty)';

    return (
        <>
            <div className="flex items-start py-1.5 px-2 rounded-md gap-1.5 relative">
                {indent === 1 && (
                    <>
                        <span className={cn('absolute left-[-18px] top-0 w-3.5', isLast ? 'h-1/2 border-b border-border' : 'h-full')} />
                        <span className="absolute left-[-5px] top-1/2 -translate-y-1/2 w-1.5 h-px bg-border" />
                    </>
                )}
                <button
                    onClick={hasChildren ? onToggle : undefined}
                    aria-label={hasChildren ? (isExpanded ? 'Collapse' : 'Expand') : undefined}
                    className={cn(
                        'size-4 mt-0.5 p-0 flex items-center justify-center text-foreground-muted shrink-0',
                        hasChildren ? 'cursor-pointer hover:text-foreground' : 'cursor-default',
                    )}
                >
                    {hasChildren ? (isExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />) : null}
                </button>
                <KindBadge kind={event.kind} className="mt-0.5" />
                <div
                    className={cn('flex-1 min-w-0', showDetail ? 'cursor-pointer' : 'cursor-default')}
                    onClick={() => { if (showDetail) setModalOpen(true); }}
                >
                    <div className="text-sm text-foreground line-clamp-2 break-words leading-snug">
                        {summaryText}
                    </div>
                    <div className="text-xs text-foreground-muted mt-0.5 flex flex-wrap gap-2 items-center">
                        {time && <span>{time}</span>}
                        {dur && <span className="tabular-nums">{dur}</span>}
                        {event.usage?.total ? <span className="tabular-nums">{formatTokens(event.usage.total)} tok</span> : null}
                        {event.spawnedChildId && (
                            <button
                                onClick={e => { e.stopPropagation(); onSelectChild(event.spawnedChildId!); }}
                                className="bg-transparent border-0 text-primary hover:underline cursor-pointer p-0 text-xs font-semibold"
                            >
                                → Go to sub-agent
                            </button>
                        )}
                    </div>
                </div>
                {showDetail && (
                    <span onClick={() => setModalOpen(true)} style={{ fontSize: '0.5625rem', color: 'var(--foreground-muted)', flexShrink: 0, cursor: 'pointer', marginTop: 3, whiteSpace: 'nowrap' }}>
                        查看 ›
                    </span>
                )}
            </div>
            {modalOpen && (
                <EventDetailModal event={event} dur={dur} time={time} onClose={() => setModalOpen(false)} node={node} interactions={interactions} />
            )}
        </>
    );
}

// ─── SystemPromptsBlock ───────────────────────────────────────────────────────
function SystemPromptsBlock({ prompts }: { prompts: NonNullable<AgentNode['systemPrompts']> }) {
    const [modalIdx, setModalIdx] = useState<number | null>(null);
    const activePrompt = modalIdx !== null ? prompts[modalIdx] : null;

    return (
        <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                {prompts.map((p, i) => {
                    const chars = p.length ?? p.text.length;
                    const firstLine = p.text.split('\n').find(l => l.trim()) ?? '';
                    const label = firstLine.length > 72 ? firstLine.slice(0, 72) + '…' : firstLine;
                    return (
                        <div key={i} onClick={() => setModalIdx(i)}
                            style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '0.5rem 0.75rem', background: 'var(--background-secondary)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', transition: 'background 0.1s' }}
                            onMouseEnter={e => (e.currentTarget.style.background = 'var(--background-tertiary)')}
                            onMouseLeave={e => (e.currentTarget.style.background = 'var(--background-secondary)')}
                        >
                            <span style={{ fontSize: '0.75rem', color: 'var(--foreground-muted)', flexShrink: 0 }}>📄</span>
                            <span style={{ flex: 1, fontSize: '0.8125rem', color: 'var(--foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label || 'System Prompt'}</span>
                            <span style={{ fontSize: '0.625rem', color: 'var(--foreground-muted)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{chars.toLocaleString()} chars</span>
                            {p.modelID && <span style={{ fontSize: '0.625rem', color: 'var(--foreground-muted)', flexShrink: 0 }}>{p.modelID}</span>}
                            {p.sha256 && <span title={p.sha256} style={{ fontSize: '0.625rem', color: 'var(--foreground-muted)', fontFamily: 'monospace', flexShrink: 0 }}>{p.sha256.slice(0, 8)}</span>}
                            <span style={{ fontSize: '0.625rem', color: 'var(--foreground-muted)', flexShrink: 0 }}>查看 ›</span>
                        </div>
                    );
                })}
            </div>
            {activePrompt && (
                <SystemPromptModal prompt={activePrompt} index={modalIdx!} total={prompts.length} onClose={() => setModalIdx(null)} />
            )}
        </>
    );
}

// ─── SystemPromptModal ────────────────────────────────────────────────────────
function SystemPromptModal({ prompt, index, total, onClose }: { prompt: NonNullable<AgentNode['systemPrompts']>[number]; index: number; total: number; onClose: () => void }) {
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try {
            await copyText(prompt.text);
            setCopied(true);
            toast.success('Copied');
            setTimeout(() => setCopied(false), 1400);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error('[copy] all methods failed:', msg);
            toast.error(`Copy failed: ${msg.slice(0, 60)}`);
        }
    };
    const chars = prompt.length ?? prompt.text.length;

    return (
        <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
            <DialogContent className="max-w-[780px] max-h-[88vh] flex flex-col p-0 gap-0">
                <DialogHeader className="flex-row items-center gap-3 p-4 border-b border-border space-y-0 flex-wrap">
                    <DialogTitle className="text-xs font-bold uppercase tracking-wider text-foreground-muted bg-background-secondary border border-border rounded-sm px-2 py-0.5">SYSTEM PROMPT</DialogTitle>
                    {total > 1 && <span className="text-xs text-foreground-muted">{index + 1} / {total}</span>}
                    <div className="flex-1" />
                    <span className="text-xs text-foreground-muted tabular-nums">{chars.toLocaleString()} chars</span>
                    {prompt.modelID && <span className="text-xs text-foreground-muted">{prompt.modelID}</span>}
                    {prompt.sha256 && <span title={prompt.sha256} className="text-xs text-foreground-muted font-mono">{prompt.sha256.slice(0, 8)}</span>}
                    <Button variant={copied ? 'default' : 'outline'} size="sm" onClick={copy} className="h-7 text-xs">
                        {copied ? <><Check className="size-3" />Copied</> : <><CopyIcon className="size-3" />Copy</>}
                    </Button>
                </DialogHeader>
                <div className="overflow-auto p-6 flex-1">
                    <MarkdownContent text={prompt.text} />
                </div>
            </DialogContent>
        </Dialog>
    );
}

// ─── EventDetailModal ─────────────────────────────────────────────────────────
function EventDetailModal({ event, dur, time, onClose, node, interactions }: {
    event: AgentEvent;
    dur: string | null; time: string; onClose: () => void;
    node: AgentNode; interactions: RawInteraction[];
}) {
    const km = KIND_META[event.kind] ?? KIND_META.tool;
    const title = event.name || event.summary?.slice(0, 60) || km.label;

    return (
        <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
            <DialogContent className="max-w-[700px] max-h-[82vh] flex flex-col p-0 gap-0">
                <DialogHeader className="flex-row items-center gap-2 p-4 border-b border-border space-y-0">
                    <KindBadge kind={event.kind} size="sm" />
                    <DialogTitle className="flex-1 font-semibold text-sm truncate text-foreground">{title}</DialogTitle>
                    <div className="flex gap-3 items-center shrink-0 text-xs text-foreground-muted">
                        {time && <span>{time}</span>}
                        {dur && <span className="tabular-nums">{dur}</span>}
                        {event.usage?.total ? <span className="tabular-nums">{formatTokens(event.usage.total)} tok</span> : null}
                    </div>
                </DialogHeader>
                <div className="overflow-auto p-4 flex flex-col gap-4">
                    {event.kind === 'llm' && (
                        <LLMEventBody
                            event={event}
                            responseText={event.interaction?.content || event.summary || ''}
                            interactions={interactions}
                            node={node}
                        />
                    )}
                    {event.kind === 'user' && (event.summary || event.interaction?.content) && <ModalSection label="Message"><LLMContent text={event.summary || event.interaction?.content || ''} /></ModalSection>}
                    {event.kind !== 'llm' && event.args !== undefined && <ModalSection label="Input"><ModalCodeBlock value={event.args} /></ModalSection>}
                    {event.kind !== 'llm' && event.output !== undefined && event.output !== null && <ModalSection label="Output"><ModalCodeBlock value={event.output} /></ModalSection>}
                    {event.spawnedChildId && <div className="text-sm text-primary">Sub-agent spawned — click in the tree to jump.</div>}
                </div>
            </DialogContent>
        </Dialog>
    );
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function LLMParam({ label, value }: { label: string; value: string | number }) {
    return (
        <span style={{ fontSize: '0.625rem', color: 'var(--foreground-muted)' }}>
            {label}: <span style={{ color: 'var(--foreground)', fontWeight: 500 }}>{value}</span>
        </span>
    );
}

function SectionTitle({ children, accentColor }: { children: ReactNode; accentColor?: string }) {
    return (
        <div style={{ fontSize: '0.625rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: accentColor || 'var(--foreground-muted)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
            {accentColor && <span style={{ width: 6, height: 6, borderRadius: '50%', background: accentColor, flexShrink: 0, display: 'inline-block' }} />}
            {children}
        </div>
    );
}

function ModalSection({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div>
            <div style={{ fontSize: '0.5625rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--foreground-muted)', marginBottom: '0.5rem', paddingBottom: '0.25rem', borderBottom: '1px solid var(--border)' }}>{label}</div>
            {children}
        </div>
    );
}

function LLMContent({ text }: { text: string }) {
    return (
        <SmartViewer
            text={text}
            toolbar={false}
            maxHeight="none"
            theme="light"
            unescape={false}
            className="sv-inline"
        />
    );
}


function MarkdownContent({ text }: { text: string }) {
    return (
        <SmartViewer
            text={text}
            type="markdown"
            toolbar={false}
            maxHeight="none"
            theme="light"
            unescape={false}
        />
    );
}

function ModalCodeBlock({ value }: { value: unknown }) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return (
        <SmartViewer
            text={text}
            toolbar={false}
            maxHeight={560}
            theme="light"
        />
    );
}
