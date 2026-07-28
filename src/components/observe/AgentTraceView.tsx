'use client';

import React, { ReactNode, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy as CopyIcon, Search as SearchIcon, X as XIcon, AlertTriangle as AlertIcon, SlidersHorizontal as FiltersIcon, Brain as BrainIcon, MessageSquare as MessageIcon, Wrench as WrenchIcon } from 'lucide-react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { CartesianGrid, Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SmartViewer } from '@/components/SmartViewer';
import type { LangfuseTraceNode } from '@/lib/ingest/otel/adapters/langfuse-trace';
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
    firstMeaningfulLine,
    formatDuration,
    formatTokens,
    RawInteraction,
    walkTree,
} from '@/lib/engine/observability/agent-trace';
import { buildLangfuseAgentTrace } from '@/lib/engine/observability/langfuse-agent-trace';
import {
    extractSkillsWithVersionsFromClaudeSession,
    extractSkillsWithVersionsFromHermesSession,
    extractSkillsWithVersionsFromJiuwenSession,
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
const STATUS_DOT: Record<NodeStatus, string> = {
    ok:    'bg-foreground-muted',
    slow:  'bg-warning',
    error: 'bg-error',
};

// docs/design/components.md §2 E.13 — span types color-coded per chart palette 1-4 (+ violet for Skill).
const KIND_META: Record<string, { label: string; chip: string; bar: string; text: string }> = {
    agent: { label: 'AGENT', ...SPAN_KIND_CLASSES.agent },
    task:  { label: 'TASK',  ...SPAN_KIND_CLASSES.task },
    chain: { label: 'CHAIN', ...SPAN_KIND_CLASSES.chain },
    tool:  { label: 'TOOL',  ...SPAN_KIND_CLASSES.tool },
    skill: { label: 'SKILL', ...SPAN_KIND_CLASSES.skill },
    llm:   { label: 'LLM',   ...SPAN_KIND_CLASSES.llm },
    user:  { label: 'USER',  ...SPAN_KIND_CLASSES.user },
};

/** Exact token count, down to the unit. The left-hand span tree keeps the
 *  abbreviated `formatTokens` (fixed-width columns), but that form rounds to the
 *  nearest 1k above 10k — so a turn-over-turn delta of a few dozen tokens reads
 *  as "no change", which is exactly what someone opening a span wants to see.
 *  Every token figure in the right-hand detail panel uses this instead. */
function exactTokens(n: number): string {
    return n.toLocaleString();
}

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

type DetailTab = 'timeline' | 'prompt' | 'overview' | 'skills' | 'infra';
type EventTypeFilter = 'all' | 'llm' | 'tool' | 'skill' | 'task' | 'chain' | 'user';

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

interface PromptSnapshotMessage {
    role: string;
    content: string;
    /** Assistant chain-of-thought ("thinking"), rendered as a collapsible
     *  "Thought for Ns" disclosure inside the assistant message — same turn,
     *  not a sibling message. */
    reasoning?: string;
    /** Reasoning token count for this turn (shown in the thinking summary line). */
    reasoningTokens?: number;
    /** Human duration label for this turn (e.g. "27.5s") — drives "Thought for Ns". */
    reasoningDurationLabel?: string;
    /** Tool calls made on this turn + their results, shown as a list with each
     *  result foldable (the tool_result the model received as context). */
    toolCalls?: { name: string; args: string; output: string }[];
    source: 'system' | 'compaction' | 'history';
    position: number;
}

interface LlmPromptSnapshot {
    inputMessages: PromptSnapshotMessage[];
    repeatedPrefixCount: number;
    activeCompaction: NonNullable<AgentNode['compactions']>[number] | null;
    foldedOriginalRaw: string | null;
    foldedOriginalCount: number;
    llmOrdinal: number;
}

// Selection key: 'a:{nodeId}' for agents, 'e:{nodeId}:{evIdx}' for events
const agentKey = (id: string) => `a:${id}`;
const eventKey = (nodeId: string, idx: number) => `e:${nodeId}:${idx}`;

interface AgentEventTreeEntry {
    event: AgentEvent;
    eventIndex: number;
    children: AgentEventTreeEntry[];
}

function buildAgentEventTree(events: AgentEvent[]): AgentEventTreeEntry[] {
    const entries = events.map((event, eventIndex) => ({ event, eventIndex, children: [] as AgentEventTreeEntry[] }));
    const bySpanId = new Map(entries
        .filter(entry => entry.event.sourceSpanId)
        .map(entry => [entry.event.sourceSpanId as string, entry]));
    const roots: AgentEventTreeEntry[] = [];
    for (const entry of entries) {
        const parent = entry.event.parentSourceSpanId
            ? bySpanId.get(entry.event.parentSourceSpanId)
            : undefined;
        if (parent && parent !== entry) parent.children.push(entry);
        else roots.push(entry);
    }
    return roots;
}

// 复制统一走共享 util(modern clipboard + execCommand fallback,兼容 http 部署)
import { copyText } from '@/lib/copy-text';

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
        const visitEvent = (entry: AgentEventTreeEntry) => {
            if (!entry.event.treeHidden && (entry.children.length > 0 || entry.event.spawnedChildId)) {
                if (entry.event.kind === 'chain' || depth <= 1) keys.add(eventKey(node.id, entry.eventIndex));
            }
            entry.children.forEach(visitEvent);
        };
        buildAgentEventTree(node.events).forEach(visitEvent);
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
        ...extractSkillsWithVersionsFromHermesSession(normalized),
        ...extractSkillsWithVersionsFromJiuwenSession(normalized),
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
    langfuseTraceNodes?: LangfuseTraceNode[];
    /** 按 interaction index 读取完整原文；未提供时保持旧的一次性完整数据行为。 */
    loadInteraction?: (index: number) => Promise<RawInteraction>;
    /** 搜索或 Prompt/Timeline 需要完整上下文时按需读取全部 interactions。 */
    loadAllInteractions?: () => Promise<RawInteraction[]>;
    /**
     * 点击 sub-agent 节点旁的跳转按钮触发。
     * sessionId 即 sub-agent 的 sessionID，等同于 Execution.taskId。
     * 父组件接管路由（一般走 router.push(`/trace?taskId=${sessionId}`)），
     * 不传则不渲染跳转按钮。
     */
    onSubagentNavigate?: (sessionId: string) => void;
    /** 当前 trace 对应的 Execution.id（= upload_id）。用于 Infra tab 做会话级 infra 关联；不传则该 tab 提示无法关联。 */
    rootExecutionId?: string;
}

export default function AgentTraceView({
    interactions: sourceInteractions,
    langfuseTraceNodes,
    loadInteraction,
    loadAllInteractions,
    onSubagentNavigate,
    rootExecutionId,
}: AgentTraceViewProps) {
    const { user } = useAuth();
    const { t: tt } = useLocale();
    const [interactions, setInteractions] = useState<RawInteraction[]>(sourceInteractions);
    const [interactionLoadError, setInteractionLoadError] = useState<string | null>(null);
    const [fullInteractionLoadError, setFullInteractionLoadError] = useState<string | null>(null);
    const fullLoadPromiseRef = React.useRef<Promise<RawInteraction[]> | null>(null);
    const previousRootExecutionIdRef = React.useRef(rootExecutionId);
    /** 置位表示下一次 tree 重建源于「同一条 trace 补数据」，重置选中态的 effect 应跳过一次。 */
    const sameTraceReloadRef = React.useRef(false);
    const langfuseProjection = useMemo(
        () => langfuseTraceNodes?.length ? buildLangfuseAgentTrace(langfuseTraceNodes) : null,
        [langfuseTraceNodes],
    );

    useEffect(() => {
        const traceChanged = previousRootExecutionIdRef.current !== rootExecutionId;
        previousRootExecutionIdRef.current = rootExecutionId;
        fullLoadPromiseRef.current = null;
        setInteractionLoadError(null);
        setFullInteractionLoadError(null);
        setInteractions(previous => {
            if (traceChanged) return sourceInteractions;
            return sourceInteractions.map((item, index) => {
                const loaded = previous[index] as (RawInteraction & { _payloadDeferred?: boolean }) | undefined;
                return loaded && !loaded._payloadDeferred ? loaded : item;
            });
        });
    }, [sourceInteractions, rootExecutionId]);

    const ensureInteractionLoaded = React.useCallback(async (index: number) => {
        if (langfuseProjection) return;
        const current = interactions[index] as (RawInteraction & { _payloadDeferred?: boolean }) | undefined;
        if (!current?._payloadDeferred || !loadInteraction) return;
        const requestedTraceId = previousRootExecutionIdRef.current;
        setInteractionLoadError(null);
        try {
            const loaded = await loadInteraction(index);
            if (previousRootExecutionIdRef.current !== requestedTraceId) return;
            // 同一条 trace 内补数据，不是换 trace —— 别让下面的重置 effect 清掉用户的选中
            sameTraceReloadRef.current = true;
            setInteractions(previous => previous.map((item, itemIndex) => itemIndex === index ? loaded : item));
        } catch (error) {
            setInteractionLoadError(error instanceof Error ? error.message : 'Failed to load interaction');
        }
    }, [interactions, langfuseProjection, loadInteraction]);

    const ensureAllInteractionsLoaded = React.useCallback(async () => {
        if (langfuseProjection) return langfuseProjection.interactions;
        if (!loadAllInteractions) return interactions;
        if (!interactions.some(item => (item as RawInteraction & { _payloadDeferred?: boolean })._payloadDeferred)) {
            return interactions;
        }
        if (!fullLoadPromiseRef.current) {
            const requestedTraceId = previousRootExecutionIdRef.current;
            setFullInteractionLoadError(null);
            let promise: Promise<RawInteraction[]>;
            promise = loadAllInteractions()
                .then(loaded => {
                    if (previousRootExecutionIdRef.current === requestedTraceId) {
                        // 同上：整条 trace 补全正文（切到 Prompt/时间线 或搜索时触发），同样保留选中
                        sameTraceReloadRef.current = true;
                        setInteractions(loaded);
                    }
                    return loaded;
                })
                .catch(error => {
                    if (previousRootExecutionIdRef.current === requestedTraceId) {
                        setFullInteractionLoadError(error instanceof Error ? error.message : 'Failed to load full trace');
                    }
                    return interactions;
                })
                .finally(() => {
                    if (fullLoadPromiseRef.current === promise) fullLoadPromiseRef.current = null;
                });
            fullLoadPromiseRef.current = promise;
        }
        return fullLoadPromiseRef.current;
    }, [interactions, langfuseProjection, loadAllInteractions]);

    const displayInteractions = langfuseProjection?.interactions || interactions;
    const tree = useMemo(
        () => langfuseProjection?.tree || buildAgentCallTree(interactions || []),
        [interactions, langfuseProjection],
    );
    const nodeMap = useMemo(() => tree ? buildNodeMap(tree) : new Map<string, AgentNode>(), [tree]);
    const traceSkillCalls = useMemo(() => collectTraceSkillCalls(displayInteractions || []), [displayInteractions]);
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

    // tree 由 interactions 派生，为同一条 trace 补数据（懒加载单条 / 补全全部）也会产生新的
    // interactions 数组 → 新 tree 对象。若无条件跟着 tree 重置，首次点击 span 触发懒加载后
    // 会被弹回根 Agent，必须点第二次才留得住（手动展开的节点同样会被清掉）。
    // 这里只跳过「同一条 trace 补数据」这一种已知来源，其余 tree 变化（换 trace、自动刷新、
    // langfuse 投影变化）一律照旧重置 —— TraceDrawer / TrajectoryTraceView 不传 rootExecutionId，
    // 不能用它作为 trace 身份来判定。
    useEffect(() => {
        if (!tree) return;
        if (sameTraceReloadRef.current) {
            sameTraceReloadRef.current = false;
            return;
        }
        setSelectedKey(agentKey(tree.id));
        setExpandedKeys(defaultExpandedKeys);
    }, [tree, defaultExpandedKeys]);

    const totalStats = useMemo(() => {
        if (!tree) return null;
        let agents = 0, tasks = 0, chains = 0, tools = 0, skills = 0, llm = 0, tokens = 0;
        walkTree(tree, n => {
            agents++;
            tasks += n.stats.taskCalls;
            chains += n.events.filter(event => event.kind === 'chain').length;
            tools += n.stats.toolCalls;
            skills += n.stats.skillCalls;
            llm += n.stats.llmCalls;
            tokens += n.stats.totalTokens;
        });
        return { agents, tasks, chains, tools, skills, llm, tokens };
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
        () => collectTraceSkillCalls(displayInteractions || [], selectedAgentNode),
        [displayInteractions, selectedAgentNode],
    );

    const selectedTraceSkillUsages = useMemo(
        () => resolveTraceSkillUsages(selectedTraceSkillCalls, managedSkillAssets),
        [selectedTraceSkillCalls, managedSkillAssets],
    );
    const selectedEventPayloadDeferred = Boolean(
        (selectedEvent?.interaction as (RawInteraction & { _payloadDeferred?: boolean }) | undefined)?._payloadDeferred,
    );

    useEffect(() => {
        if (selectedEvent) void ensureInteractionLoaded(selectedEvent.interactionIndex);
    }, [selectedEvent, ensureInteractionLoaded]);

    useEffect(() => {
        if (activeDetailTab === 'prompt' || activeDetailTab === 'timeline' || searchQuery.trim()) {
            void ensureAllInteractionsLoaded();
        }
    }, [activeDetailTab, searchQuery, ensureAllInteractionsLoaded]);

    const toggleKey = (key: string) => {
        setExpandedKeys(s => {
            const next = new Set(s);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    // 树中所有可展开的 Agent、子 Agent 调用和 Langfuse CHAIN。
    const allExpandableKeys = useMemo(() => {
        const keys = new Set<string>();
        if (tree) {
            walkTree(tree, n => {
                keys.add(agentKey(n.id));
                const visitEvent = (entry: AgentEventTreeEntry) => {
                    if (!entry.event.treeHidden && (entry.children.length > 0 || entry.event.spawnedChildId)) {
                        keys.add(eventKey(n.id, entry.eventIndex));
                    }
                    entry.children.forEach(visitEvent);
                };
                buildAgentEventTree(n.events).forEach(visitEvent);
            });
        }
        return keys;
    }, [tree]);

    // 是否已全部展开:决定开关当前展示「收起」还是「展开」。
    const isAllExpanded = allExpandableKeys.size > 0
        && [...allExpandableKeys].every(k => expandedKeys.has(k));

    const expandAll = () => setExpandedKeys(new Set(allExpandableKeys));

    const collapseAll = () => {
        if (!tree) return;
        setExpandedKeys(new Set([agentKey(tree.id)]));
    };

    const toggleExpandAll = () => (isAllExpanded ? collapseAll() : expandAll());

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
            const handledChildIds = new Set<string>();
            const visitEvent = (entry: AgentEventTreeEntry, eventParents: string[]) => {
                const ev = entry.event;
                const idx = entry.eventIndex;
                const childNode = ev.spawnedChildId ? nodeMap.get(ev.spawnedChildId) : undefined;
                if (ev.treeHidden) {
                    if (childNode) {
                        handledChildIds.add(childNode.id);
                        visit(childNode, eventParents);
                    }
                    return;
                }
                const evKey = eventKey(node.id, idx);
                const dur = childNode
                    ? childNode.stats.durationMs ?? undefined
                    : (ev.startedAt != null && ev.completedAt != null) ? ev.completedAt - ev.startedAt : undefined;
                const tok = ev.usage?.total || 0;
                const label = ev.kind === 'task' && ev.spawnedChildId
                    ? `spawn → ${ev.args?.subagent_type || childNode?.agentName || 'subagent'}`
                    : ev.name || firstMeaningfulLine(ev.summary) || ev.kind;
                spans.push({
                    key: evKey, label, kind: ev.kind,
                    durationMs: dur, tokens: tok || undefined,
                    isSlow: (dur ?? 0) > SLOW_MS,
                    searchText: [ev.name, ev.summary, ev.kind,
                        ev.args ? (typeof ev.args === 'string' ? ev.args : JSON.stringify(ev.args)).slice(0, 300) : '',
                        ev.output ? (typeof ev.output === 'string' ? ev.output : JSON.stringify(ev.output)).slice(0, 100) : '',
                    ].filter(Boolean).join(' ').toLowerCase(),
                    parentKeys: eventParents,
                });
                const childParents = [...eventParents, evKey];
                entry.children.forEach(child => visitEvent(child, childParents));
                if (childNode) {
                    handledChildIds.add(childNode.id);
                    visit(childNode, childParents);
                }
            };
            buildAgentEventTree(node.events).forEach(entry => visitEvent(entry, myParents));
            node.children.filter(child => !handledChildIds.has(child.id)).forEach(child => visit(child, myParents));
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
            {fullInteractionLoadError && (
                <div className="flex items-center justify-between gap-3 rounded-md border border-error-border bg-error-subtle px-3 py-2 text-sm text-error" role="alert">
                    <span>{fullInteractionLoadError}</span>
                    <Button variant="outline" size="sm" onClick={() => void ensureAllInteractionsLoaded()}>
                        重试
                    </Button>
                </div>
            )}
            {/* Stats bar */}
            {totalStats && (
                <div className="flex flex-wrap items-center gap-3 px-3.5 py-2 rounded-md border border-border bg-background-secondary text-xs">
                    <StatChip label="AGENTS" value={totalStats.agents} />
                    <Sep />
                    <StatChip label="TASK SPAWNS" value={totalStats.tasks} accentClass={KIND_META.task.text} isActive={eventTypeFilter === 'task'} onClick={() => handleStatChipClick('task')} hint={tt('traceTree.filterType') + ' Task'} />
                    {totalStats.chains > 0 && <StatChip label="CHAIN SPANS" value={totalStats.chains} accentClass={KIND_META.chain.text} isActive={eventTypeFilter === 'chain'} onClick={() => handleStatChipClick('chain')} hint={tt('traceTree.filterType') + ' Chain'} />}
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
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={toggleExpandAll}
                            aria-pressed={isAllExpanded}
                            className="h-7 border border-border rounded-md text-xs px-2 gap-1 shrink-0"
                        >
                            {isAllExpanded
                                ? <ChevronsDownUp className="size-3.5" />
                                : <ChevronsUpDown className="size-3.5" />}
                            {isAllExpanded ? tt('traceTree.collapseAll') : tt('traceTree.expandAll')}
                        </Button>

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
                                ...((totalStats?.chains || 0) > 0 ? [{ value: 'chain', label: 'Chain', accentClass: KIND_META.chain.text }] : []),
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
                    {selectedEvent && selectedEventPayloadDeferred && !interactionLoadError ? (
                        <div className="p-4 space-y-3">
                            <div className="h-5 w-1/3 rounded bg-background-tertiary animate-pulse" />
                            <div className="h-24 w-full rounded bg-background-tertiary animate-pulse" />
                            <div className="h-24 w-full rounded bg-background-tertiary animate-pulse" />
                        </div>
                    ) : selectedEvent && interactionLoadError ? (
                        <div className="m-4 rounded-md border border-error-border bg-error-subtle p-4 text-sm text-error">
                            <p>{interactionLoadError}</p>
                            <Button
                                variant="outline"
                                size="sm"
                                className="mt-3"
                                onClick={() => void ensureInteractionLoaded(selectedEvent.interactionIndex)}
                            >
                                重试
                            </Button>
                        </div>
                    ) : selectedEvent ? (
                        <EventDetailPanel
                            event={selectedEvent}
                            node={selectedAgentNode}
                            interactions={displayInteractions}
                            onSelectChild={(id) => {
                                const n = findNode(tree, id);
                                if (n) setSelectedKey(agentKey(n.id));
                            }}
                        />
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
                            interactions={displayInteractions}
                            traceSkills={selectedTraceSkillUsages}
                            currentUser={user}
                            rootExecutionId={rootExecutionId}
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
    const eventTree = buildAgentEventTree(events);
    const hasContent = events.length > 0;

    const isSearchMatch = searchQuery ? matchedKeys.has(aKey) : false;
    const isActiveMatch = activeMatchKey === aKey;

    const renderEventEntry = (
        entry: AgentEventTreeEntry,
        eventDepth: number,
        eventIsLast: boolean,
        eventPrefixBits: boolean[],
    ): ReactNode => {
        const ev = entry.event;
        const evIdx = entry.eventIndex;
        const evKey = eventKey(node.id, evIdx);
        const childNode = ev.spawnedChildId ? nodeMap.get(ev.spawnedChildId) : undefined;

        if (ev.treeHidden) {
            if (!childNode) return null;
            return (
                <UnifiedSpanTree
                    key={`hidden-${evIdx}`}
                    node={childNode}
                    nodeMap={nodeMap}
                    expandedKeys={expandedKeys}
                    onToggleKey={onToggleKey}
                    selectedKey={selectedKey}
                    onSelect={onSelect}
                    totalStart={totalStart}
                    totalDuration={totalDuration}
                    depth={eventDepth}
                    isLast={eventIsLast}
                    prefixBits={eventPrefixBits}
                />
            );
        }

        const hasChildren = entry.children.length > 0 || !!childNode;
        const isEvExpanded = hasChildren && expandedKeys.has(evKey);
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

        const descendantPrefixBits = [...eventPrefixBits, !eventIsLast];
        return (
            <div key={ev.sourceSpanId || evIdx}>
                <UnifiedEventRow
                    event={ev}
                    evIdx={evIdx}
                    parentNodeId={node.id}
                    childNode={childNode}
                    depth={eventDepth}
                    isLast={eventIsLast && !isEvExpanded}
                    prefixBits={eventPrefixBits}
                    isExpanded={isEvExpanded}
                    hasChildren={hasChildren}
                    isSelected={selectedKey === evKey}
                    onSelect={() => onSelect(evKey)}
                    onToggle={hasChildren ? () => onToggleKey(evKey) : undefined}
                    totalStart={totalStart}
                    totalDuration={totalDuration}
                />
                {isEvExpanded && entry.children.map((child, childIndex) => renderEventEntry(
                    child,
                    eventDepth + 1,
                    childIndex === entry.children.length - 1 && !childNode,
                    descendantPrefixBits,
                ))}
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
                        depth={eventDepth + 1}
                        isLast
                        prefixBits={descendantPrefixBits}
                    />
                )}
            </div>
        );
    };

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
                    {eventTree.map((entry, entryIndex) => renderEventEntry(
                        entry,
                        depth + 1,
                        entryIndex === eventTree.length - 1,
                        depth === 0 ? [] : [...prefixBits, !isLast],
                    ))}
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
    const primaryLabel = event.kind === 'task' && event.spawnedChildId
        ? `spawn → ${event.args?.subagent_type || childNode?.agentName || 'subagent'}`
        : event.kind === 'llm'
            ? (firstMeaningfulLine(event.summary) || 'LLM')
            : event.name || event.summary?.slice(0, 50) || event.kind;

    // Secondary label
    const secondaryLabel = event.kind === 'task' && event.spawnedChildId
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
    const [copied, setCopied] = useState(false);
    if (raw == null) return null;
    const trimmed = raw.trim();
    const onCopy = async () => {
        try {
            await copyText(trimmed);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch { /* ignore */ }
    };
    return (
        <>
            <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.375rem' }}>
                    <SectionTitle accentColor={accentColor}>{label}</SectionTitle>
                    {trimmed && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                            {/* 一键复制:Message(query)/Input/Output 全文 */}
                            <button
                                onClick={onCopy}
                                title="复制全文"
                                style={{ fontSize: '0.5625rem', color: copied ? 'var(--primary)' : 'var(--foreground-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 0.375rem', fontWeight: 500 }}
                            >
                                {copied ? '✓ 已复制' : '⧉ 复制'}
                            </button>
                            <button
                                onClick={() => setShowModal(true)}
                                style={{ fontSize: '0.5625rem', color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 0.375rem', fontWeight: 500 }}
                            >
                                查看全部 ›
                            </button>
                        </div>
                    )}
                </div>
                {trimmed ? (
                    // 预览区走 SmartViewer:JSON → 可交互树(嵌套 JSON 字符串自动展开)、
                    // Markdown → 渲染、其余纯文本(真实换行,不再满屏 \n 字面)。
                    // 展开节点等交互留给 SmartViewer,弹窗入口在头部"查看全部"。
                    <div style={{
                        background: 'var(--background-secondary)',
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        maxHeight: 180,
                        overflow: 'auto',
                        position: 'relative',
                    }}>
                        <SmartViewer
                            text={trimmed}
                            toolbar={false}
                            maxHeight="none"
                            theme="light"
                            unescape={false}
                            className="sv-inline sv-compact"
                        />
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
                {/* pr-12 给 DialogContent 右上角那颗绝对定位的关闭按钮留出车道，否则和 Copy 按钮叠在一起 */}
                <DialogHeader className="flex-row items-center gap-3 p-4 pr-12 border-b border-border space-y-0">
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

function normalizePromptRole(role: string | undefined): string {
    if (role === 'opencode') return 'user';
    if (role === 'subagent') return 'assistant';
    return role || 'unknown';
}

function summarizePromptArgs(raw: unknown): string {
    if (raw == null) return '';
    try {
        const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (obj && typeof obj === 'object') {
            const r = obj as Record<string, unknown>;
            for (const k of ['path', 'file_path', 'pattern', 'command', 'description', 'query', 'url']) {
                const v = r[k];
                if (typeof v === 'string' && v.trim()) return `${k}: ${v.length > 60 ? v.slice(0, 60) + '...' : v}`;
            }
            const keys = Object.keys(r);
            if (keys.length) return keys.slice(0, 3).join(',') + (keys.length > 3 ? '...' : '');
        }
        return '';
    } catch {
        const s = typeof raw === 'string' ? raw : '';
        return s.length > 60 ? `${s.slice(0, 60)}...` : s;
    }
}

function interactionToPromptText(m: RawInteraction): string {
    const text = typeof m.content === 'string' ? m.content : '';
    if (text.trim()) return text;

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
            const argSummary = summarizePromptArgs(args);
            return argSummary ? `-> ${name}(${argSummary})` : `-> ${name}()`;
        });
        blocks.push(`[tool calls x ${m.tool_calls.length}]\n${lines.join('\n')}`);
    }
    if (typeof m.content !== 'string' && m.content != null) {
        blocks.push(JSON.stringify(m.content, null, 2));
    }
    return blocks.join('\n\n');
}

/** Reasoning ("thinking") text of an assistant turn. OpenCode keeps the model's
 *  chain-of-thought in `reasoning` parts, separate from the visible `text` parts
 *  that become `content`. A tool-only turn often has empty content but non-empty
 *  reasoning — that reasoning is the "think" the timeline should surface. */
function extractReasoningText(it?: RawInteraction): string {
    if (!it || !Array.isArray(it.parts)) return '';
    return it.parts
        .filter(p => (p?.type || '').toLowerCase() === 'reasoning')
        .map(p => (typeof p.text === 'string' ? p.text.trim() : ''))
        .filter(Boolean)
        .join('\n\n');
}

/** Visible text content of a message for the prompt snapshot — NOT reasoning
 *  (carried separately as the thinking block) and NOT tool calls (carried
 *  separately as a structured list with foldable results). */
function interactionContentText(m: RawInteraction): string {
    const text = typeof m.content === 'string' ? m.content : '';
    if (text.trim()) return text;
    if (typeof m.content !== 'string' && m.content != null) return JSON.stringify(m.content, null, 2);
    return '';
}

/** Tool calls of a turn + their results, for the prompt snapshot. OpenCode keeps
 *  the result on the same assistant message (`tool_calls[].output`); in Messages
 *  API terms this is the tool_result the next call receives as context. */
function extractToolCalls(m: RawInteraction): { name: string; args: string; output: string }[] {
    if (!Array.isArray(m.tool_calls) || m.tool_calls.length === 0) return [];
    // task (sub-agent spawn) and skill are surfaced as their own tree events, so
    // exclude them from the message's plain tool-call badges.
    return m.tool_calls
        .filter(tc => {
            const n = tc.function?.name || tc.name || '';
            return n !== 'task' && n !== 'skill';
        })
        .map(tc => {
            const name = tc.function?.name || tc.name || 'tool';
            const argStr = tc.function?.arguments ?? tc.arguments;
            const args = typeof argStr === 'string' ? argStr : (argStr != null ? JSON.stringify(argStr) : '');
            const outRaw = tc.output ?? tc.result;
            const output = outRaw == null ? '' : (typeof outRaw === 'string' ? outRaw : JSON.stringify(outRaw, null, 2));
            return { name, args, output };
        });
}

function buildInputMessagesForLlmIndex(node: AgentNode, interactions: RawInteraction[], eventIdx: number): {
    inputMessages: PromptSnapshotMessage[];
    activeCompaction: NonNullable<AgentNode['compactions']>[number] | null;
    foldedOriginalRaw: string | null;
    foldedOriginalCount: number;
} {
    const boundaries = node.compactions || [];
    const cutoff = boundaries.length
        ? [...boundaries].filter(c => c.interactionIndex < eventIdx).pop()
        : undefined;
    const cutoffIdx = cutoff ? cutoff.interactionIndex : -1;

    const verbatimNodeIndices = new Set(
        node.interactionIndices.filter(i => i > cutoffIdx && i < eventIdx),
    );
    const verbatimMessages = interactions.filter((_, i) => verbatimNodeIndices.has(i));
    const foldedIndices = cutoff ? node.interactionIndices.filter(i => i < cutoffIdx) : [];
    const foldedMessages = foldedIndices.map(i => interactions[i]).filter(Boolean);

    const sep = '\n\n---\n\n';
    const inputMessages: PromptSnapshotMessage[] = [];
    let position = 0;

    for (const sp of node.systemPrompts || []) {
        if (!sp.text?.trim()) continue;
        inputMessages.push({
            role: 'system',
            content: sp.text,
            source: 'system',
            position: ++position,
        });
    }

    if (cutoff?.summaryText?.trim()) {
        inputMessages.push({
            role: 'compaction',
            content: cutoff.summaryText,
            source: 'compaction',
            position: ++position,
        });
    }

    for (const m of verbatimMessages) {
        if (m.role === 'system') continue;
        const calls = extractToolCalls(m);
        // Thinking is resent to the model only for the active tool-use turn the
        // current call continues from (Anthropic requires the signed thinking
        // block back during a tool-use cycle). We attach reasoning only to
        // tool-use turns; whether it actually shows is decided per section:
        // Current input keeps it (the active continuation), History strips it.
        const hasTools = calls.length > 0;
        inputMessages.push({
            role: normalizePromptRole(m.role),
            content: interactionContentText(m),
            reasoning: hasTools ? extractReasoningText(m) : undefined,
            reasoningTokens: hasTools ? m.usage?.reasoning : undefined,
            toolCalls: calls,
            source: 'history',
            position: ++position,
        });
    }

    const foldedOriginalRaw = foldedMessages
        .map(m => `[${normalizePromptRole(m.role)}] ${interactionToPromptText(m)}`)
        .join(sep);

    return {
        inputMessages,
        activeCompaction: cutoff || null,
        foldedOriginalRaw: foldedOriginalRaw || null,
        foldedOriginalCount: foldedMessages.length,
    };
}

/** Same tool calls on both turns? An opencode tool-use turn carries empty
 *  `content`, so on role+content alone every one of them looks alike — the
 *  name+args pairs are what actually tell two of them apart. */
function samePromptToolCalls(a: PromptSnapshotMessage, b: PromptSnapshotMessage): boolean {
    const x = a.toolCalls || [];
    const y = b.toolCalls || [];
    if (x.length !== y.length) return false;
    return x.every((t, i) => t.name === y[i].name && t.args === y[i].args);
}

function countRepeatedPromptPrefix(prev: PromptSnapshotMessage[], current: PromptSnapshotMessage[]): number {
    let count = 0;
    const max = Math.min(prev.length, current.length);
    while (count < max) {
        if (prev[count].role !== current[count].role) break;
        if ((prev[count].content || '').trim() !== (current[count].content || '').trim()) break;
        if (!samePromptToolCalls(prev[count], current[count])) break;
        count++;
    }
    return count;
}

function buildLlmPromptSnapshot(event: AgentEvent, node: AgentNode, interactions: RawInteraction[]): LlmPromptSnapshot {
    const eventIdx = event.interactionIndex;
    const current = buildInputMessagesForLlmIndex(node, interactions, eventIdx);
    const previousLlmEvents = node.events
        .filter(ev => ev.kind === 'llm' && ev.interactionIndex < eventIdx)
        .sort((a, b) => a.interactionIndex - b.interactionIndex);
    const prevEvent = previousLlmEvents[previousLlmEvents.length - 1];
    // The previous call's OUTPUT is part of this call's input, so it belongs to
    // History — not "本轮新增". Moving the cutoff one interaction further (`+ 1`)
    // folds that turn into the compared prefix. Only valid for a pure-text reply:
    // a tool-use turn's interaction also carries the tool result, which genuinely
    // IS new input this call, so that one has to stay in Current input.
    const prevReplyIsPureOutput = !!prevEvent && (prevEvent.interaction.tool_calls?.length ?? 0) === 0;
    const prevMessages = prevEvent
        ? buildInputMessagesForLlmIndex(node, interactions, prevEvent.interactionIndex + (prevReplyIsPureOutput ? 1 : 0)).inputMessages
        : [];

    return {
        ...current,
        repeatedPrefixCount: prevMessages.length > 0
            ? countRepeatedPromptPrefix(prevMessages, current.inputMessages)
            : 0,
        llmOrdinal: previousLlmEvents.length + 1,
    };
}

/** A collapsed disclosure bar rendered INSIDE a message: a single clickable
 *  summary line (icon + label + meta + chevron) that expands to the full text.
 *  Used for both the assistant's "Thought for Ns" (reasoning) and "Response"
 *  (content) blocks so they read as content-blocks of one message — matching
 *  the Anthropic/OpenAI convention, not separate messages. */
function DisclosureBar({ icon, label, sub, meta, text, tone = 'normal', defaultOpen, modalTitle }: {
    icon: ReactNode;
    label: string;
    /** Optional muted secondary text after the label (e.g. tool args), truncated. */
    sub?: string;
    meta?: string;
    text: string;
    /** 'muted' dims the body (reasoning); 'normal' keeps full contrast (content). */
    tone?: 'normal' | 'muted';
    defaultOpen?: boolean;
    modalTitle: string;
}) {
    const [open, setOpen] = useState(!!defaultOpen);
    const [showModal, setShowModal] = useState(false);
    const trimmed = text.trim();
    if (!trimmed) return null;
    const isLong = trimmed.length > PREVIEW_CHARS;

    return (
        <div className="border-b border-border last:border-b-0">
            <button
                type="button"
                onClick={() => setOpen(v => !v)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-foreground-secondary hover:bg-background-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
                {icon}
                <span className="text-xs font-semibold shrink-0">{label}</span>
                {sub && <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-normal text-foreground-muted">{sub}</span>}
                {meta && <span className={cn('text-[10px] text-foreground-muted tabular-nums shrink-0', !sub && 'ml-auto')}>{meta}</span>}
                <ChevronDown className={cn('size-3.5 text-foreground-muted transition-transform shrink-0', !meta && !sub && 'ml-auto', open && 'rotate-180')} />
            </button>
            {open && (
                <div className="bg-transparent">
                    {/* L5 "Block content" — indented further under its block header; bg
                     *  is transparent so it inherits the expanded message's tint. */}
                    <div className={cn('max-h-[260px] overflow-auto py-2 pl-10 pr-3 text-xs leading-6 whitespace-pre-wrap break-words', tone === 'muted' ? 'text-foreground-secondary' : 'text-foreground')}>
                        {trimmed}
                    </div>
                    {isLong && (
                        <div className="border-t border-border px-3 py-1.5 text-right">
                            <Button variant="ghost" size="sm" onClick={() => setShowModal(true)} className="h-6 px-2 text-xs">
                                查看全部
                            </Button>
                        </div>
                    )}
                </div>
            )}
            {showModal && (
                <ContentModal title={modalTitle} raw={trimmed} onClose={() => setShowModal(false)} />
            )}
        </div>
    );
}

/** Reasoning ("thinking") block of an assistant turn, styled as a collapsed
 *  "Thought for Ns" disclosure (ChatGPT / o1 convention): content stays
 *  primary, the chain-of-thought is one click away. */
function ThinkingBlock({ text, tokens, durationLabel, modalTitle }: {
    text: string;
    /** Reasoning token count, if known — shown in the summary line. */
    tokens?: number;
    /** e.g. "27.5s" — when present the line reads "Thought for 27.5s". */
    durationLabel?: string;
    modalTitle: string;
}) {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const summaryLabel = durationLabel ? `Thought for ${durationLabel}` : 'Thought process';
    const meta = [
        tokens && tokens > 0 ? `${exactTokens(tokens)} tokens` : '',
        `${trimmed.length.toLocaleString()} chars`,
    ].filter(Boolean).join(' · ');
    return (
        <DisclosureBar
            icon={<BrainIcon className="size-3.5 text-primary shrink-0" aria-hidden />}
            label={summaryLabel}
            meta={meta}
            text={text}
            tone="muted"
            modalTitle={modalTitle}
        />
    );
}

/** A single tool call shown as a badge (matching the span-type tool chip). Click
 *  opens its input + result in a modal. */
function ToolBadge({ call, modalTitle }: {
    call: NonNullable<PromptSnapshotMessage['toolCalls']>[number];
    modalTitle: string;
}) {
    const [open, setOpen] = useState(false);
    const raw = [
        `Input:\n${(call.args || '').trim() || '(none)'}`,
        `Output:\n${(call.output || '').trim() || '(no result captured)'}`,
    ].join('\n\n———\n\n');
    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                title={summarizePromptArgs(call.args) || call.name}
                className={cn(
                    'inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded-sm border cursor-pointer hover:opacity-80',
                    KIND_META.tool.chip,
                )}
            >
                {call.name}
            </button>
            {open && <ContentModal title={`${modalTitle} · ${call.name}`} raw={raw} onClose={() => setOpen(false)} />}
        </>
    );
}

/** "Tool calls" as ONE collapsible bar at the same level as Thought / Response.
 *  Expanding reveals the individual tool calls as badges (click a badge for its
 *  input + result). */
function ToolCallList({ calls, modalTitle }: {
    calls: NonNullable<PromptSnapshotMessage['toolCalls']>;
    modalTitle: string;
}) {
    const [open, setOpen] = useState(false);
    return (
        <div className="border-b border-border last:border-b-0">
            <button
                type="button"
                onClick={() => setOpen(v => !v)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-foreground-secondary hover:bg-background-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
                <WrenchIcon className="size-3.5 text-foreground-muted shrink-0" aria-hidden />
                <span className="text-xs font-semibold">Tool calls</span>
                <span className="ml-auto text-[10px] text-foreground-muted tabular-nums shrink-0">{calls.length}</span>
                <ChevronDown className={cn('size-3.5 text-foreground-muted transition-transform shrink-0', open && 'rotate-180')} />
            </button>
            {open && (
                <div className="flex flex-wrap gap-1 bg-transparent py-2 pl-10 pr-3">
                    {calls.map((c, i) => (
                        <ToolBadge key={i} call={c} modalTitle={modalTitle} />
                    ))}
                </div>
            )}
        </div>
    );
}

function SnapshotMessageRow({
    message,
    defaultExpanded,
    modalTitle,
}: {
    message: PromptSnapshotMessage;
    defaultExpanded?: boolean;
    modalTitle: string;
}) {
    const trimmed = (message.content || '').trim();
    const reasoning = (message.reasoning || '').trim();
    const toolCalls = message.toolCalls || [];
    const hasToolCalls = toolCalls.length > 0;
    const hasBody = !!(trimmed || reasoning || hasToolCalls);
    const [expanded, setExpanded] = useState(!!defaultExpanded);
    const [showModal, setShowModal] = useState(false);
    // Preview the content if present, else the thinking, else the tool calls —
    // never blank when the turn did something (a tool-only turn has empty content).
    const previewSource = trimmed || reasoning
        || (hasToolCalls ? `${toolCalls.length} 个工具调用: ${toolCalls.slice(0, 3).map(c => c.name).join(', ')}` : '');
    const firstLine = previewSource.split(/\n/).find(l => l.trim()) || '';
    const isLong = trimmed.length > PREVIEW_CHARS;
    // Assistant turns render content as a "Response" disclosure bar matching the
    // "Thought" bar; system/user messages keep their plain inline content.
    const isAssistant = message.role === 'assistant';
    // When the row opens by default (current-turn output / latest context turn),
    // open the Response bar too so the answer is visible without an extra click.
    const responseDefaultOpen = !!defaultExpanded;
    const roleLabel = message.role === 'compaction' ? 'summary' : message.role;
    // 结构化标题：调用方给到「Input · History」，这里补上「第几条 + 角色」，块级弹窗再往后接 thinking / response / 工具名
    const rowTitle = `${modalTitle} · #${message.position} ${roleLabel}`;
    const roleClasses = message.role === 'compaction'
        ? 'border-warning-border bg-warning-subtle text-warning'
        : message.role === 'system'
            ? KIND_META.llm.chip
            : message.role === 'assistant'
                ? KIND_META.agent.chip
                : message.role === 'user'
                    ? KIND_META.user.chip
                    : 'border-border bg-background-secondary text-foreground-muted';

    return (
        <>
            {/* L3 "Message" — highlighted (tinted bg + left accent) while expanded so its parts read as a unit */}
            <div className={cn('border-t border-border first:border-t-0', expanded ? 'bg-primary/[0.08] border-l-2 border-l-primary' : 'bg-card')}>
                <button
                    type="button"
                    onClick={() => hasBody && setExpanded(v => !v)}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-amber-400/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    <span className={cn('inline-flex min-w-[70px] justify-center rounded-sm border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider', roleClasses)}>
                        {roleLabel}
                    </span>
                    <span className="text-xs text-foreground-muted font-mono tabular-nums">#{message.position}</span>
                    <span className="flex-1 min-w-0 truncate text-xs text-foreground-muted">
                        {hasBody ? firstLine : '(empty)'}
                    </span>
                    {reasoning && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-primary shrink-0" title="包含思考过程">
                            <BrainIcon className="size-3" aria-hidden />
                        </span>
                    )}
                    {hasBody && <ChevronRight className={cn('size-3 text-foreground-muted transition-transform', expanded && 'rotate-90')} />}
                </button>
                {/* L4 "Block"s (Thought / Response / Tool calls) — indented under the message */}
                {expanded && hasBody && (
                    <div className="border-t border-border bg-transparent pl-3">
                        {reasoning && (
                            <ThinkingBlock
                                text={reasoning}
                                tokens={message.reasoningTokens}
                                durationLabel={message.reasoningDurationLabel}
                                modalTitle={`${rowTitle} · thinking`}
                            />
                        )}
                        {trimmed ? (
                            isAssistant ? (
                                <DisclosureBar
                                    icon={<MessageIcon className="size-3.5 text-foreground-muted shrink-0" aria-hidden />}
                                    label="Response"
                                    meta={`${trimmed.length.toLocaleString()} chars`}
                                    text={trimmed}
                                    tone="normal"
                                    defaultOpen={responseDefaultOpen}
                                    modalTitle={`${rowTitle} · response`}
                                />
                            ) : (
                                <>
                                    <div className="border-t border-border first:border-t-0 max-h-[280px] overflow-auto px-3 py-2 text-xs leading-6 text-foreground whitespace-pre-wrap break-words">
                                        {trimmed}
                                    </div>
                                    {isLong && (
                                        <div className="border-t border-border px-3 py-1.5 text-right">
                                            <Button variant="ghost" size="sm" onClick={() => setShowModal(true)} className="h-6 px-2 text-xs">
                                                查看全部
                                            </Button>
                                        </div>
                                    )}
                                </>
                            )
                        ) : null}
                        {hasToolCalls && (
                            <ToolCallList calls={toolCalls} modalTitle={rowTitle} />
                        )}
                        {!trimmed && !hasToolCalls && reasoning ? (
                            <div className="border-t border-border px-3 py-2 text-xs text-foreground-muted">
                                仅有思考，无可见正文（纯工具调用轮）
                            </div>
                        ) : null}
                    </div>
                )}
            </div>
            {showModal && (
                <ContentModal title={rowTitle} raw={trimmed} onClose={() => setShowModal(false)} />
            )}
        </>
    );
}

/** L2 "Group" — a collapsible group of messages, used for "History" and "Current
 *  input" inside the Input section. History is collapsed by default; Current input
 *  opens by default (and expands its latest message). */
function FoldedMessagesBlock({
    messages,
    modalTitle,
    label = 'History',
    subtitle,
    defaultOpen = false,
    expandLast = false,
}: {
    messages: PromptSnapshotMessage[];
    modalTitle: string;
    label?: string;
    subtitle?: string;
    defaultOpen?: boolean;
    expandLast?: boolean;
}) {
    const [expanded, setExpanded] = useState(defaultOpen);
    const [showModal, setShowModal] = useState(false);
    const raw = messages
        .map(m => `#${m.position} [${m.role}]\n${m.content}`)
        .join('\n\n---\n\n');
    // 弹窗标题只走「区块 · 分组 · 第几条」这条结构路径，不带正文首句 ——
    // 正文首句当标题会被读成「这个弹窗讲的是这句话」，而它其实是整组消息。
    const groupTitle = `${modalTitle} · ${label}`;

    return (
        <>
            <div className="border-t border-border first:border-t-0 bg-background-secondary">
                <button
                    type="button"
                    onClick={() => setExpanded(v => !v)}
                    className="w-full flex items-center gap-2 px-2 py-2 text-left hover:bg-background-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    <span className="text-sm font-semibold text-foreground">{label}</span>
                    <span className="text-xs text-foreground-muted tabular-nums">{messages.length} messages</span>
                    {subtitle && <span className="text-[10px] text-foreground-muted">{subtitle}</span>}
                    <ChevronRight className={cn('ml-auto size-4 text-foreground-muted transition-transform shrink-0', expanded && 'rotate-90')} />
                </button>
                {expanded && (
                    <div className="border-t border-border bg-card">
                        {messages.map((message, index) => (
                            <SnapshotMessageRow
                                key={`${message.role}-${message.position}-${index}`}
                                message={message}
                                defaultExpanded={expandLast && index === messages.length - 1}
                                modalTitle={groupTitle}
                            />
                        ))}
                        <div className="border-t border-border px-3 py-1.5 text-right">
                            <Button variant="ghost" size="sm" onClick={() => setShowModal(true)} className="h-6 px-2 text-xs">
                                查看合并文本
                            </Button>
                        </div>
                    </div>
                )}
            </div>
            {showModal && (
                <ContentModal title={groupTitle} raw={raw} onClose={() => setShowModal(false)} />
            )}
        </>
    );
}

/** L1 "Section" (Input / Output) — flat "Trace / Span Snapshot" heading style: a
 *  SectionTitle-style label (uppercase, muted) that toggles, with the content in a
 *  light bordered box below — no card header bar. */
function SnapshotSection({ label, count, subtitle, defaultOpen = true, children }: {
    label: string;
    count?: number;
    subtitle?: string;
    defaultOpen?: boolean;
    children: ReactNode;
}) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div>
            <button
                type="button"
                onClick={() => setOpen(v => !v)}
                className="mb-1.5 flex w-full items-center gap-1.5 text-left text-foreground-muted hover:text-foreground focus-visible:outline-none"
            >
                <span className="text-[0.625rem] font-semibold uppercase tracking-[0.06em]">{label}</span>
                {count != null && <span className="text-[0.625rem] tabular-nums">{count}</span>}
                {/* chevron hugs the label (not pushed to the far right) */}
                <ChevronRight className={cn('size-3 transition-transform shrink-0', open && 'rotate-90')} />
                {subtitle && <span className="ml-1 text-[0.625rem] normal-case">{subtitle}</span>}
            </button>
            {open && (
                <div className="overflow-hidden rounded-md border border-border bg-card">
                    {children}
                </div>
            )}
        </div>
    );
}

function HierarchicalSpanSnapshot({
    node,
    event,
    snapshot,
    responseText,
}: {
    node: AgentNode;
    event: AgentEvent;
    snapshot: LlmPromptSnapshot;
    responseText: string;
}) {
    // Split the input messages into the semantic sections of a Messages-API call:
    //   System          — the system prompt(s)
    //   History         — prior turns unchanged since the previous LLM call (the
    //                     stable prefix; ≈ what hits the provider's prefix cache,
    //                     though that's a billing optimization, not this grouping)
    //   Current input   — what's new this turn (the latest user msg / tool_result)
    const repeated = snapshot.inputMessages.slice(0, snapshot.repeatedPrefixCount);
    const fresh = snapshot.inputMessages.slice(snapshot.repeatedPrefixCount);
    const systemMessages = snapshot.inputMessages.filter(m => m.role === 'system');
    // History is older context — strip thinking (a prior turn's thinking is not
    // resent). Current input keeps it (the active tool-use turn being continued).
    const historyMessages = repeated
        .filter(m => m.role !== 'system')
        .map(m => ({ ...m, reasoning: undefined, reasoningTokens: undefined }));
    const currentInput = fresh.filter(m => m.role !== 'system');
    // System lives inside History now (it's part of the stable prefix the model
    // re-receives every call), so History = system prompt(s) + prior turns.
    const historyAndSystem = [...systemMessages, ...historyMessages];
    const inputCount = historyAndSystem.length + currentInput.length;
    // History can be thin (or absent) for two very different reasons, and saying
    // which one it is beats a block that silently shrinks: either this is the
    // node's first call (nothing came before), or the prefix failed to line up
    // with the previous call so the prior turns spilled into Current input.
    const isFirstCall = snapshot.llmOrdinal === 1;
    const historySubtitle = historyMessages.length
        ? (systemMessages.length ? 'system + 历史上下文 · 已折叠' : '历史上下文 · 已折叠')
        : isFirstCall
            ? '仅 system prompt · 本轮为首次调用，无历史上下文'
            : '仅 system prompt · 未能与上次调用对齐，历史已并入 Current input';
    const emptyHistoryHint = isFirstCall
        ? '本轮为首次调用，无历史上下文；该 agent 的 system prompt 也未上报'
        : '未采集到 system prompt，且未能与上次调用对齐 —— 历史已并入 Current input';

    // An LLM turn has two content blocks: the model's reasoning ("thinking") and
    // its visible response ("content"). OpenCode carries reasoning in `reasoning`
    // parts and content in `text` parts. Following the Anthropic/OpenAI
    // convention, both belong to ONE assistant message — thinking renders as a
    // collapsible block inside it, not as a separate message.
    const reasoningText = extractReasoningText(event.interaction);
    const visibleContent = (event.interaction?.content || '').trim()
        ? (event.interaction!.content as string)
        : '';
    // Don't let content fall back to reasoning (responseText/summary does):
    // reasoning has its own block, and a tool-only turn genuinely produced no
    // visible text. Fall back to responseText only when there's no reasoning to
    // show (covers frameworks that don't emit structured reasoning parts).
    const assistantContent = visibleContent || (reasoningText ? '' : (responseText || ''));
    const outputToolCalls = extractToolCalls(event.interaction);
    const hasOutput = !!(assistantContent || reasoningText || outputToolCalls.length);
    const reasoningTokens = event.usage?.reasoning;
    const reasoningDurationLabel = (event.startedAt != null && event.completedAt != null && event.completedAt > event.startedAt)
        ? formatDuration(event.completedAt - event.startedAt)
        : undefined;

    return (
        <div className="flex flex-col gap-3">
            {/* span identity — which call this is and whose it is. `llm_call_N` /
                `thread_id TOP` read like OTel ids but are neither: the ordinal is
                computed here and TOP is a placeholder. The agent name is what a
                reader actually needs. `event #N` stays — it is the index into the
                exported bundle's `session.interactions`, the only anchor back to
                the raw payload. */}
            <div>
                <SectionTitle>本次调用</SectionTitle>
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background-secondary px-2.5 py-2">
                    <KindBadge kind="llm" />
                    <span className="text-sm font-semibold text-foreground">第 {snapshot.llmOrdinal} 次模型调用</span>
                    <span className="text-xs text-foreground-muted">来自 Agent</span>
                    <span className="rounded-sm border border-border bg-card px-1.5 py-0.5 text-xs font-medium text-foreground">{node.agentName}</span>
                    {node.subagentType && (
                        <span className="text-xs text-foreground-muted">{node.subagentType}</span>
                    )}
                    <span className="ml-auto text-xs text-foreground-muted">event #{event.interactionIndex}</span>
                </div>
            </div>

            {/* INPUT — two collapsible groups: History (system + prior turns) and Current input */}
            <SnapshotSection label="Input" count={inputCount} defaultOpen>
                {historyAndSystem.length > 0 ? (
                    <FoldedMessagesBlock
                        messages={historyAndSystem}
                        label="History"
                        subtitle={historySubtitle}
                        modalTitle="Input"
                    />
                ) : currentInput.length > 0 ? (
                    <div className="border-t border-border first:border-t-0 px-3 py-2 text-xs text-foreground-muted">
                        {emptyHistoryHint}
                    </div>
                ) : null}
                {currentInput.length > 0 ? (
                    <FoldedMessagesBlock
                        messages={currentInput}
                        label="Current input"
                        subtitle="本轮新增"
                        modalTitle="Input"
                        defaultOpen
                    />
                ) : (
                    <div className="border-t border-border first:border-t-0 px-3 py-2 text-xs text-foreground-muted">
                        {historyAndSystem.length
                            ? '本轮无新增外部输入 —— 没有新的用户消息或工具结果，上一轮的模型回复已归入 History'
                            : 'No input messages captured for this span.'}
                    </div>
                )}
            </SnapshotSection>

            {/* OUTPUT — collapsible peer */}
            <SnapshotSection label="Output" count={hasOutput ? 1 : 0} defaultOpen>
                {hasOutput ? (
                    <SnapshotMessageRow
                        message={{
                            role: 'assistant',
                            content: assistantContent,
                            reasoning: reasoningText,
                            reasoningTokens,
                            reasoningDurationLabel,
                            // Tool calls are part of the assistant's response (tool_use
                            // blocks), so they belong in Output — same rendering as input.
                            toolCalls: outputToolCalls,
                            source: 'history',
                            position: 1,
                        }}
                        modalTitle="Output"
                    />
                ) : (
                    <div className="px-3 py-2 text-xs text-foreground-muted">
                        No text output captured.
                    </div>
                )}
            </SnapshotSection>
        </div>
    );
}

// ─── EventDetailPanel (right panel – event selected) ─────────────────────────
/** 工具/技能调用是否失败。判定口径与 faithfulness-evaluator 的 status 归类一致。 */
function isErrorToolStatus(status?: string): boolean {
    return /error|fail|cancel/i.test(status ?? '');
}

/** 毫秒级时钟。span 详情用,便于与后端日志、Infra 曲线对时。 */
function formatClockMs(ts?: number): string | null {
    if (ts == null) return null;
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.toLocaleTimeString('zh-CN', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** 可点击复制的 id 芯片(toolCallId 等)。 */
function CopyableId({ label, value }: { label: string; value: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <button
            type="button"
            title={`复制 ${label}`}
            onClick={async () => {
                try {
                    await copyText(value);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                } catch { /* ignore */ }
            }}
            className="font-mono text-[0.625rem] px-1.5 py-px rounded-sm border border-border bg-background-secondary text-foreground-secondary hover:border-primary hover:text-primary cursor-pointer shrink-0"
        >
            {value} {copied ? '✓' : '⧉'}
        </button>
    );
}

/** 失败 span 的错误区块。数据源为 event.toolStatus + 工具输出(错误正文通常就在 output 里)。 */
function SpanErrorBlock({ status, text }: { status?: string; text: string | null }) {
    const [copied, setCopied] = useState(false);
    const body = (text ?? '').trim();
    return (
        <div className="rounded-md border border-error-border bg-error-subtle overflow-hidden">
            <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-error-border">
                <span className="size-1.5 rounded-full bg-error shrink-0" />
                <span className="text-xs font-bold text-error">执行失败</span>
                {status && <span className="font-mono text-[0.625rem] text-error/75">toolStatus: {status}</span>}
                <span className="flex-1" />
                {body && (
                    <button
                        type="button"
                        title="复制错误信息"
                        onClick={async () => {
                            try {
                                await copyText(body);
                                setCopied(true);
                                setTimeout(() => setCopied(false), 1500);
                            } catch { /* ignore */ }
                        }}
                        className="text-[0.625rem] text-error/70 hover:text-error bg-transparent border-none cursor-pointer p-0"
                    >
                        {copied ? '✓ 已复制' : '⧉ 复制'}
                    </button>
                )}
            </div>
            {body ? (
                <pre className="m-0 px-2.5 py-2 font-mono text-[0.6875rem] leading-relaxed whitespace-pre-wrap break-words text-error max-h-72 overflow-auto">{body}</pre>
            ) : (
                <div className="px-2.5 py-2 text-xs text-error/80 italic">调用被标记为失败,但未记录错误正文。</div>
            )}
        </div>
    );
}

/** task span 的子 Agent 汇总卡 —— 不离开面板即可看到子 Agent 概况。 */
function SpawnedChildSummary({ child, onSelectChild }: { child: AgentNode; onSelectChild?: (id: string) => void }) {
    const ctx = React.useContext(TraceCtx);
    const status = getStatus(child);
    const s = child.stats;
    return (
        <div className="rounded-md border border-border p-2.5 flex flex-col gap-2">
            <div className="flex items-center gap-2">
                <KindBadge kind="agent" size="sm" />
                <span className="flex-1 text-sm font-semibold truncate">{child.agentName}</span>
                {child.sessionId && ctx.onSubagentNavigate && (
                    <button
                        type="button"
                        title="在独立 Trace 视图中打开此 Sub-Agent"
                        onClick={() => ctx.onSubagentNavigate?.(child.sessionId!)}
                        className="px-2 py-0.5 text-xs font-semibold rounded-sm border border-primary text-primary bg-primary/10 hover:bg-primary/20 cursor-pointer shrink-0"
                    >
                        查看子 Trace ↗
                    </button>
                )}
                {onSelectChild && (
                    <button
                        type="button"
                        title="在左侧树中选中该子 Agent"
                        onClick={() => onSelectChild(child.id)}
                        className="px-2 py-0.5 text-xs font-semibold rounded-sm border border-border text-foreground-secondary hover:bg-background-secondary cursor-pointer shrink-0"
                    >
                        定位
                    </button>
                )}
            </div>
            <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-foreground-muted">
                {status !== 'ok' && (
                    <span className="inline-flex items-center gap-1.5">
                        状态 <span className={cn('size-1.5 rounded-full', STATUS_DOT[status])} />
                        <b className="font-semibold text-foreground">{status === 'error' ? '失败' : '慢'}</b>
                    </span>
                )}
                <span>耗时 <b className="font-semibold text-foreground tabular-nums">{formatDuration(s.durationMs)}</b></span>
                <span>Token <b className="font-semibold text-foreground tabular-nums">{exactTokens(s.totalTokens)}</b></span>
                <span>LLM 调用 <b className="font-semibold text-foreground tabular-nums">{s.llmCalls}</b></span>
                <span>工具调用 <b className="font-semibold text-foreground tabular-nums">{s.toolCalls}</b></span>
                {s.skillCalls > 0 && <span>Skill <b className="font-semibold text-foreground tabular-nums">{s.skillCalls}</b></span>}
                {child.children.length > 0 && <span>子 Agent <b className="font-semibold text-foreground tabular-nums">{child.children.length}</b></span>}
            </div>
        </div>
    );
}

function EventDetailPanel({ event, node, interactions, onSelectChild }: { event: AgentEvent; node: AgentNode; interactions: RawInteraction[]; onSelectChild?: (id: string) => void }) {
    const km = KIND_META[event.kind] ?? KIND_META.tool;
    const dur = (event.startedAt != null && event.completedAt != null)
        ? formatDuration(event.completedAt - event.startedAt) : null;
    const startClock = formatClockMs(event.startedAt);
    const endClock = formatClockMs(event.completedAt);
    const title = event.name || firstMeaningfulLine(event.summary) || km.label;
    const hasError = isErrorToolStatus(event.toolStatus);
    const spawnedChild = event.kind === 'task' && event.spawnedChildId
        ? node.children.find(c => c.id === event.spawnedChildId)
        : undefined;

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
                    {dur && <span style={{ fontVariantNumeric: 'tabular-nums' }}>{dur}</span>}
                    {event.usage?.total ? <span style={{ fontVariantNumeric: 'tabular-nums' }}>{exactTokens(event.usage.total)} tok</span> : null}
                    {/* 毫秒级绝对时间:对时后端日志 / Infra 曲线时需要 */}
                    {startClock && <span style={{ fontVariantNumeric: 'tabular-nums' }}>开始 {startClock}</span>}
                    {endClock && <span style={{ fontVariantNumeric: 'tabular-nums' }}>结束 {endClock}</span>}
                    <span style={{ opacity: 0.6 }}>from: {node.agentName}</span>
                    {event.toolStatus && !hasError && (
                        <span className="inline-flex items-center gap-1 text-success font-semibold">
                            <span className="size-1.5 rounded-full bg-success" />{event.toolStatus}
                        </span>
                    )}
                    {event.toolCallId && <CopyableId label="toolCallId" value={event.toolCallId} />}
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
                    <CompactSection label="Message" raw={responseText || null} />
                )}

                {/* ── Tool / Skill ── */}
                {(event.kind === 'tool' || event.kind === 'skill') && (
                    <>
                        {/* 失败时错误正文置顶;此时 output 就是错误信息,不再重复渲染 Output */}
                        {hasError && <SpanErrorBlock status={event.toolStatus} text={outputStr} />}
                        <CompactSection label="Input" raw={argsStr} modalTitle={`${title} — Input`} />
                        {!hasError && <CompactSection label="Output" raw={outputStr} modalTitle={`${title} — Output`} />}
                        {!hasError && argsStr == null && outputStr == null && <EmptyDetail />}
                    </>
                )}

                {/* ── Task spawn ── */}
                {event.kind === 'task' && event.spawnedChildId && (
                    <>
                        {hasError && <SpanErrorBlock status={event.toolStatus} text={outputStr} />}
                        <CompactSection label="派生指令" raw={argsStr} modalTitle={`${title} — 派生指令`} />
                        {spawnedChild ? (
                            <SpawnedChildSummary child={spawnedChild} onSelectChild={onSelectChild} />
                        ) : (
                            <div style={{ fontSize: '0.8125rem', color: 'var(--foreground-muted)', padding: '0.75rem', background: 'var(--background-secondary)', border: '1px solid var(--border)', borderRadius: 6 }}>
                                已生成子 Agent — 在左侧树中展开 TASK 行查看详情。
                            </div>
                        )}
                    </>
                )}

                {/* ── Captured task / chain observation ── */}
                {((event.kind === 'task' && !event.spawnedChildId) || event.kind === 'chain') && (
                    <>
                        {hasError && <SpanErrorBlock status={event.toolStatus} text={outputStr} />}
                        <CompactSection label="Input" raw={argsStr} modalTitle={`${title} — Input`} />
                        {!hasError && <CompactSection label="Output" raw={outputStr} modalTitle={`${title} — Output`} />}
                        {!hasError && argsStr == null && outputStr == null && <EmptyDetail />}
                    </>
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

    const snapshot = useMemo(
        () => buildLlmPromptSnapshot(event, node, interactions),
        [event, node, interactions],
    );

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
                                    {usage!.input != null && usage!.input > 0 && <span>in <b style={{ color: 'var(--foreground)' }}>{exactTokens(usage!.input)}</b> </span>}
                                    {usage!.output != null && usage!.output > 0 && <span>out <b style={{ color: 'var(--primary)' }}>{exactTokens(usage!.output)}</b> </span>}
                                    {usage!.cache?.read != null && usage!.cache.read > 0 && <span>cache <b style={{ color: 'var(--success)' }}>{exactTokens(usage!.cache.read)}</b> </span>}
                                    {usage!.reasoning != null && usage!.reasoning > 0 && <span>think <b style={{ color: 'var(--foreground-secondary)' }}>{exactTokens(usage!.reasoning)}</b> </span>}
                                    {usage!.total != null && usage!.total > 0 && <span>total <b style={{ color: 'var(--foreground)', fontWeight: 700 }}>{exactTokens(usage!.total)}</b></span>}
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

            <HierarchicalSpanSnapshot
                node={node}
                event={event}
                snapshot={snapshot}
                responseText={responseText}
            />

            {snapshot.activeCompaction && snapshot.foldedOriginalRaw && snapshot.foldedOriginalCount > 0 && (
                <CompactSection
                    label={`Compaction Folded Originals (${snapshot.foldedOriginalCount})`}
                    raw={snapshot.foldedOriginalRaw}
                    modalTitle="Compaction Folded Originals"
                    emptyText="(empty)"
                />
            )}

        </>
    );
}

function EmptyDetail() {
    return (
        <div style={{ fontSize: '0.8125rem', color: 'var(--foreground-muted)', textAlign: 'center', paddingTop: '2rem' }}>
            暂无详细数据
        </div>
    );
}

// ─── AgentDetail (right panel) ────────────────────────────────────────────────
function AgentDetail({
    node, highlightEvent, activeTab, onTabChange, eventTypeFilter, onEventTypeFilterChange,
    totalDurationMs, onSelectChild, interactions, traceSkills, currentUser, rootExecutionId
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
    rootExecutionId?: string;
}) {
    const status = getStatus(node);
    const hasPrompt = !!(node.systemPrompts && node.systemPrompts.length > 0);
    const visibleEvents = node.events.filter(event => !event.treeHidden);

    const tabs: { id: DetailTab; label: string; count?: number }[] = [
        { id: 'overview', label: '概览' },
        { id: 'timeline', label: '时间线', count: visibleEvents.length },
        { id: 'skills', label: 'Skills', count: traceSkills.length },
        ...(hasPrompt ? [{ id: 'prompt' as DetailTab, label: 'System Prompt', count: node.systemPrompts!.length }] : []),
        { id: 'infra' as DetailTab, label: 'Infra' },
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
                        events={visibleEvents}
                        eventTypeFilter={eventTypeFilter}
                        onEventTypeFilterChange={onEventTypeFilterChange}
                        onSelectChild={onSelectChild}
                        node={node}
                        interactions={interactions}
                    />
                )}
                {activeTab === 'skills' && <SkillsTab skills={traceSkills} currentUser={currentUser} />}
                {activeTab === 'prompt' && hasPrompt && <SystemPromptsBlock prompts={node.systemPrompts!} />}
                {activeTab === 'infra' && <InfraTab executionId={rootExecutionId} />}
            </div>
        </div>
    );
}

interface InfraFinding { sev: string; cls: string; title: string; evidence: string; diagnosis: string; remediation: string[] }
interface InfraCard {
    endpoint: string;
    model: string | null;
    sourceId: string | null;
    window: { startMs: number; endMs: number; latencyMs: number };
    correlated: boolean;
    reason?: string;
    verdict: string | null;
    bottleneck: string | null;
    samples: number;
    classification: { label: string; why: string } | null;
    findings: InfraFinding[];
}
interface InfraCorrelation {
    correlated: boolean;
    rootExecutionId: string;
    manual: boolean;
    sessionWindow: { startMs: number; endMs: number } | null;
    reason?: string;
    endpoint?: string;
    cards: InfraCard[];
}
interface SourceOption { id: string; endpoint: string; model: string | null }

interface InfraHistoryPoint { tsMs: number; running: number; waiting: number; kvPerc: number; itlP95Ms: number | null; tpotP95Ms: number | null; ttftP95: number | null }

const cardKey = (c: { sourceId: string | null; endpoint: string; model: string | null }) => `${c.sourceId ?? c.endpoint}|${c.model ?? ''}`;

function ihhmmss(ms: number) { const dt = new Date(ms); return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}:${String(dt.getSeconds()).padStart(2, '0')}`; }

// session 时间窗内的一张 infra 曲线（高亮 session 实际跨度）
function InfraWindowChart({ title, data, win, series }: { title: string; data: InfraHistoryPoint[]; win: { startMs: number; endMs: number }; series: { key: keyof InfraHistoryPoint; name: string; color: string }[] }) {
    return (
        <div style={{ background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ fontSize: 11.5, color: 'var(--foreground-muted)', marginBottom: 4 }}>{title}</div>
            <div style={{ width: '100%', height: 120 }}>
                <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="tsMs" tickFormatter={ihhmmss} stroke="var(--foreground-muted)" tick={{ fontSize: 9 }} interval="preserveStartEnd" minTickGap={40} type="number" domain={['dataMin', 'dataMax']} />
                        <YAxis stroke="var(--foreground-muted)" tick={{ fontSize: 9 }} width={34} />
                        <RTooltip labelFormatter={(v) => ihhmmss(Number(v))} contentStyle={{ background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11 }} />
                        <ReferenceArea x1={win.startMs} x2={win.endMs} fill="var(--primary)" fillOpacity={0.12} />
                        {series.map((s) => <Line key={String(s.key)} type="monotone" dataKey={s.key as string} name={s.name} stroke={s.color} strokeWidth={1.8} dot={false} isAnimationActive={false} connectNulls />)}
                    </LineChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}

const INFRA_LABEL_COLOR: Record<string, string> = {
    'INFRA-BOUND': 'var(--error)',
    'APP-BOUND': 'var(--warning)',
    'INHERENT': 'var(--success)',
    'unknown': 'var(--foreground-muted)',
};
const INFRA_SEV_COLOR: Record<string, string> = {
    critical: 'var(--error)', warn: 'var(--warning)', healthy: 'var(--success)', info: 'var(--foreground-muted)',
};

// 单张 (endpoint,模型) 关联卡：归因标签 + 源链接 + 时间窗曲线 + findings。
function InfraCardView({ card, hist }: { card: InfraCard; hist: InfraHistoryPoint[] }) {
    const label = card.classification?.label ?? 'unknown';
    const win = card.window;
    return (
        <div style={{ border: '1px solid var(--card-border)', borderRadius: 'var(--radius-md)', background: 'var(--card-bg)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, color: INFRA_LABEL_COLOR[label] ?? 'var(--foreground)' }}>{label}</span>
                <span style={{ fontWeight: 600 }}>
                    {card.sourceId
                        ? <a href={`/infra/source/${encodeURIComponent(card.sourceId)}`} style={{ color: 'var(--primary)' }}>{card.endpoint} →</a>
                        : card.endpoint}
                </span>
                <span style={{ color: 'var(--foreground-muted)' }}>· 模型 {card.model ?? '全部'}</span>
            </div>
            {card.correlated ? (
                <div style={{ color: 'var(--foreground-muted)' }}>窗口 infra：{card.verdict ?? 'n/a'} / {card.bottleneck ?? 'none'} · 命中采样 {card.samples}</div>
            ) : (
                <div style={{ color: 'var(--foreground-muted)' }}>{card.reason || '该 endpoint 尚未注册为 infra 源'}{!card.sourceId && <> —— 到 <a href="/infra/sources" style={{ color: 'var(--primary)' }}>源管理</a> 导入</>}</div>
            )}
            {card.classification?.why && <div style={{ color: 'var(--foreground-secondary)' }}>{card.classification.why}</div>}
            {card.correlated && hist.length > 0 && (
                <div>
                    <div style={{ color: 'var(--foreground-muted)', marginBottom: 6 }}>
                        该 session 时间段内的 infra 曲线（高亮区 = 调用跨度 {ihhmmss(win.startMs)}–{ihhmmss(win.endMs)}，{(win.latencyMs / 1000).toFixed(1)}s）
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8 }}>
                        <InfraWindowChart title="调度：并发 / 排队" data={hist} win={win} series={[{ key: 'running', name: '并发', color: 'var(--primary)' }, { key: 'waiting', name: '排队', color: 'var(--warning)' }]} />
                        <InfraWindowChart title="KV 使用率 %" data={hist} win={win} series={[{ key: 'kvPerc', name: 'KV%', color: 'var(--error)' }]} />
                        <InfraWindowChart title="decode 延迟 (ms)：ITL / TPOT" data={hist} win={win} series={[{ key: 'itlP95Ms', name: 'ITL', color: 'var(--warning)' }, { key: 'tpotP95Ms', name: 'TPOT', color: 'var(--error)' }]} />
                    </div>
                </div>
            )}
            {card.correlated && hist.length === 0 && (
                <div style={{ color: 'var(--foreground-muted)' }}>该时间窗内暂无 infra 采样曲线（采样间隔可能大于调用时长）。</div>
            )}
            {card.findings.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {card.findings.map((f, i) => (
                        <div key={i} style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', background: 'var(--background)', borderLeft: `3px solid ${INFRA_SEV_COLOR[f.sev] ?? 'var(--border)'}` }}>
                            <div style={{ fontWeight: 600, marginBottom: 2 }}>[{f.cls}] {f.title}</div>
                            <div style={{ color: 'var(--foreground-muted)', marginBottom: 2 }}>证据：{f.evidence}</div>
                            <div style={{ color: 'var(--foreground-secondary)' }}>{f.diagnosis}</div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// 人工修改 session↔infra 关联：编辑一组 {源, 模型}，POST 覆盖式保存（按整棵 trace 树）。
function InfraLinkEditor({ executionId, cards, onSaved, onCancel }: { executionId: string; cards: InfraCard[]; onSaved: () => void; onCancel: () => void }) {
    const [sources, setSources] = useState<SourceOption[]>([]);
    const [rows, setRows] = useState<{ sourceId: string; model: string }[]>(
        cards.filter(c => c.sourceId).map(c => ({ sourceId: c.sourceId as string, model: c.model ?? '' })),
    );
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        (async () => {
            await Promise.resolve();
            if (!active) return;
            try {
                const res = await fetch('/api/observe/infra/sources');
                const body = await res.json();
                const list: SourceOption[] = (body.sources ?? body ?? []).map((s: { id: string; endpoint: string; model?: string | null }) => ({ id: s.id, endpoint: s.endpoint, model: s.model ?? null }));
                if (active) setSources(list);
            } catch { /* 下拉空也能用现有行 */ }
        })();
        return () => { active = false; };
    }, []);

    const addRow = () => setRows(r => [...r, { sourceId: sources[0]?.id ?? '', model: '' }]);
    const save = async () => {
        setSaving(true); setErr(null);
        try {
            const links = rows.filter(r => r.sourceId).map(r => ({ sourceId: r.sourceId, model: r.model.trim() || null }));
            const res = await fetch(`/api/observe/executions/${encodeURIComponent(executionId)}/infra`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ links }),
            });
            if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || `HTTP ${res.status}`); }
            onSaved();
        } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div style={{ border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--background)' }}>
            <div style={{ fontWeight: 600 }}>编辑关联（按整个 session 覆盖；留空模型=该源全部模型）</div>
            {rows.map((row, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <select value={row.sourceId} onChange={e => setRows(rs => rs.map((r, j) => j === i ? { ...r, sourceId: e.target.value } : r))}
                        style={{ flex: 1, padding: '5px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--card-bg)', color: 'var(--foreground)' }}>
                        <option value="">（选择源）</option>
                        {sources.map(s => <option key={s.id} value={s.id}>{s.endpoint}</option>)}
                        {row.sourceId && !sources.some(s => s.id === row.sourceId) && <option value={row.sourceId}>{cards.find(c => c.sourceId === row.sourceId)?.endpoint ?? row.sourceId}</option>}
                    </select>
                    <input value={row.model} placeholder="模型（可空）" onChange={e => setRows(rs => rs.map((r, j) => j === i ? { ...r, model: e.target.value } : r))}
                        style={{ width: 180, padding: '5px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--card-bg)', color: 'var(--foreground)' }} />
                    <button onClick={() => setRows(rs => rs.filter((_, j) => j !== i))} style={{ border: 'none', background: 'transparent', color: 'var(--error)', cursor: 'pointer' }}>移除</button>
                </div>
            ))}
            <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={addRow} style={{ padding: '5px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--card-bg)', color: 'var(--foreground)', cursor: 'pointer' }}>+ 添加源</button>
                <span style={{ flex: 1 }} />
                {err && <span style={{ color: 'var(--error)', alignSelf: 'center' }}>{err}</span>}
                <button onClick={onCancel} style={{ padding: '5px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--card-bg)', color: 'var(--foreground)', cursor: 'pointer' }}>取消</button>
                <button onClick={save} disabled={saving} style={{ padding: '5px 14px', borderRadius: 'var(--radius-sm)', border: 'none', background: 'var(--primary)', color: 'var(--primary-foreground)', cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>{saving ? '保存中…' : '保存'}</button>
            </div>
        </div>
    );
}

// session↔infra 关联 Tab：会话级多卡（每 endpoint×模型一张），支持人工覆盖关联。
function InfraTab({ executionId }: { executionId?: string }) {
    const [data, setData] = useState<InfraCorrelation | null>(null);
    const [histByKey, setHistByKey] = useState<Record<string, InfraHistoryPoint[]>>({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState(false);
    const [reloadTick, setReloadTick] = useState(0);

    useEffect(() => {
        if (!executionId) { setLoading(false); return; }
        let active = true;
        (async () => {
            await Promise.resolve();
            if (!active) return;
            setLoading(true);
            setError(null);
            setHistByKey({});
            try {
                const res = await fetch(`/api/observe/executions/${encodeURIComponent(executionId)}/infra`);
                const body = await res.json();
                if (!res.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`);
                if (!active) return;
                setData(body as InfraCorrelation);
                // 每张关联成功的卡 → 拉它自己时间窗（前后各放宽 30s）内的曲线
                const cards: InfraCard[] = (body.cards ?? []).filter((c: InfraCard) => c.correlated && c.sourceId);
                const entries = await Promise.all(cards.map(async (c) => {
                    const from = c.window.startMs - 30_000;
                    const to = c.window.endMs + 30_000;
                    const qs = `sourceId=${encodeURIComponent(c.sourceId as string)}&from=${from}&to=${to}${c.model ? `&model=${encodeURIComponent(c.model)}` : ''}`;
                    const hres = await fetch(`/api/observe/infra/history?${qs}`);
                    const hbody = await hres.json().catch(() => ({}));
                    return [cardKey(c), hres.ok ? (hbody.points ?? []) : []] as const;
                }));
                if (active) setHistByKey(Object.fromEntries(entries));
            } catch (e) {
                if (active) setError(e instanceof Error ? e.message : String(e));
            } finally {
                if (active) setLoading(false);
            }
        })();
        return () => { active = false; };
    }, [executionId, reloadTick]);

    if (!executionId) return <div style={{ color: 'var(--foreground-muted)', fontSize: '0.8125rem' }}>当前视图缺少 execution id，无法做 infra 关联。</div>;
    if (loading) return <div style={{ color: 'var(--foreground-muted)', fontSize: '0.8125rem' }}>加载 Infra 关联…</div>;
    if (error) return <div style={{ color: 'var(--error)', fontSize: '0.8125rem' }}>加载失败：{error}</div>;
    if (!data) return null;

    const cards = data.cards ?? [];
    return (
        <div style={{ fontSize: '0.8125rem', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600 }}>Infra 关联（{cards.length} 个 源×模型）</span>
                {data.manual && <span style={{ fontSize: 11, color: 'var(--warning)', background: 'var(--warning-subtle)', border: '1px solid var(--warning-subtle-border)', borderRadius: 999, padding: '1px 8px' }}>人工指定</span>}
                <span style={{ flex: 1 }} />
                {!editing && <button onClick={() => setEditing(true)} style={{ padding: '4px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--card-bg)', color: 'var(--foreground)', cursor: 'pointer' }}>编辑关联</button>}
            </div>

            {editing && (
                <InfraLinkEditor
                    executionId={executionId}
                    cards={cards}
                    onCancel={() => setEditing(false)}
                    onSaved={() => { setEditing(false); setReloadTick(t => t + 1); }}
                />
            )}

            {cards.length === 0 && !editing && (
                <div style={{ color: 'var(--foreground-muted)', lineHeight: 1.6 }}>
                    {data.reason || '未关联到 infra 源'}。可「编辑关联」手动指定该 session 对应的推理源。
                </div>
            )}

            {cards.map((c) => <InfraCardView key={cardKey(c)} card={c} hist={histByKey[cardKey(c)] ?? []} />)}
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
                    ].filter(({ value, label }) => value > 0 || label === 'Total').map(({ label, value }) => {
                        const text = exactTokens(value);
                        // Five fixed columns: an exact 7-figure count ("1,594,375") overruns the
                        // cell at 1rem, so step the size down once it gets that long.
                        const size = text.length > 8 ? '0.75rem' : text.length > 6 ? '0.875rem' : '1rem';
                        return (
                            <div key={label} style={{ padding: '0.5rem 0.5rem', minWidth: 0, background: 'var(--background-secondary)', border: '1px solid var(--border)', borderRadius: 6, textAlign: 'center' }}>
                                <div style={{ fontSize: size, fontWeight: 700, color: 'var(--foreground)', fontVariantNumeric: 'tabular-nums' }}>{text}</div>
                                <div style={{ fontSize: '0.5625rem', color: 'var(--foreground-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2 }}>{label}</div>
                            </div>
                        );
                    })}
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
                                        <span className="text-xs text-foreground-muted tabular-nums shrink-0 font-mono">{exactTokens(child.stats.totalTokens)}</span>
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
                            ? (span.tokens ? exactTokens(span.tokens) : '-')
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
        const c: Record<string, number> = { llm: 0, tool: 0, skill: 0, task: 0, chain: 0, user: 0 };
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
        { kind: 'chain', label: 'Chain' },
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
                        {event.usage?.total ? <span className="tabular-nums">{exactTokens(event.usage.total)} tok</span> : null}
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
                <DialogHeader className="flex-row items-center gap-3 p-4 pr-12 border-b border-border space-y-0 flex-wrap">
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
                <DialogHeader className="flex-row items-center gap-2 p-4 pr-12 border-b border-border space-y-0">
                    <KindBadge kind={event.kind} size="sm" />
                    <DialogTitle className="flex-1 font-semibold text-sm truncate text-foreground">{title}</DialogTitle>
                    <div className="flex gap-3 items-center shrink-0 text-xs text-foreground-muted">
                        {time && <span>{time}</span>}
                        {dur && <span className="tabular-nums">{dur}</span>}
                        {event.usage?.total ? <span className="tabular-nums">{exactTokens(event.usage.total)} tok</span> : null}
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
