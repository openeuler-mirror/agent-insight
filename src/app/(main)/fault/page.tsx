'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */

import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
    AlertTriangle,
    ArrowLeft,
    AtSign,
    Bot,
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    Clock,
    ExternalLink,
    GitBranch,
    History,
    Loader2,
    MessageSquare,
    PanelLeft,
    Plus,
    Send,
    Sparkles,
    UserRound,
    X,
    XCircle,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { useAuth } from '@/lib/auth/auth-context';
import { useLocale } from '@/lib/client/locale-context';
import { apiFetch } from '@/lib/client/api';
import { formatDuration, type AgentEvent, type RawInteraction } from '@/lib/engine/observability/agent-trace';
import { buildFaultPathSteps, type FailureTraceAnchor } from '@/lib/engine/observability/fault-path';

const basePath = process.env.NEXT_PUBLIC_URL_PREFIX || '';
const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

interface InvokedSkill {
    name: string;
    version?: number | null;
}

interface Failure {
    failure_type: string;
    description: string;
    context?: string;
    recovery?: string;
    attribution?: string;
    attribution_reason?: string;
    step?: string;
    anchor_step_id?: string;
    trace_anchor?: FailureTraceAnchor;
}

interface DiagnosticItem extends Failure {
    diagnostic_kind: FaultKind;
    diagnostic_source: 'analysis' | 'ingest' | 'evaluation';
    synthetic?: boolean;
}

interface Execution {
    timestamp: string;
    framework: string;
    agent?: string;
    agentName?: string;
    query?: string;
    final_result?: string;
    skill?: string;
    skills?: string[];
    invokedSkills?: InvokedSkill[];
    invoked_skills?: InvokedSkill[];
    agents?: string[];
    is_answer_correct?: boolean;
    answer_score?: number;
    latency?: number;
    tokens?: number;
    cost?: number;
    judgment_reason?: string;
    failures?: Failure[];
    task_id?: string;
    upload_id?: string;
    is_evaluating?: boolean;
    tool_call_count?: number;
    llm_call_count?: number;
    tool_call_error_count?: number;
    agentOwnership?: string | null;
    input_tokens?: number;
    output_tokens?: number;
    skill_issues?: any[];
    outcome_evaluation?: any;
    routing_evaluation?: any;
    [key: string]: any;
}

interface SessionData {
    interactions?: RawInteraction[];
    error?: string;
}

type FaultKind = 'original' | 'deviation';
type TraceStatus = 'ok' | 'error' | 'skipped' | 'running';

interface TraceNodeItem {
    id: string;
    name: string;
    meta: string;
    time?: string;
    status: TraceStatus;
    detail?: string;
    step: number;
    kind?: AgentEvent['kind'] | 'agent' | 'system';
    tag?: string;
    faultRefs?: number[];
    matchReason?: string;
    depth?: number;
    rawText?: string;
    rawInput?: string;
    rawOutput?: string;
    startedAt?: number;
    completedAt?: number;
    durationMs?: number;
}

type TimeFilter = '1h' | '3h' | '24h' | '7d' | '30d' | 'all';

const TIME_WIN_MS: Record<TimeFilter, number> = {
    '1h': 3.6e6,
    '3h': 1.08e7,
    '24h': 8.64e7,
    '7d': 6.048e8,
    '30d': 2.592e9,
    'all': Infinity,
};

function getInvokedSkillNames(execution: Execution): string[] {
    const invoked = Array.isArray(execution.invoked_skills)
        ? execution.invoked_skills
        : (Array.isArray(execution.invokedSkills) ? execution.invokedSkills : []);
    const names = new Set<string>();
    invoked.forEach(skill => {
        const name = skill?.name?.trim();
        if (name) names.add(name);
    });
    return Array.from(names);
}

interface NodeRef {
    id: string;
    label: string;
    kind?: string;
}

interface ChatMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    pending?: boolean;
    nodeRefs?: NodeRef[];
}

interface TreeTraceNode extends TraceNodeItem {
    children: TreeTraceNode[];
    parentId?: string;
}

interface ConversationSnapshot {
    id: string;
    title: string;
    messages: ChatMessage[];
    agentSessionId: string | null;
    createdAt: number;
}

export default function FaultPage() {
    return (
        <Suspense fallback={<div>Loading...</div>}>
            <FaultPageContent />
        </Suspense>
    );
}

function FaultPageContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { user } = useAuth();
    const { t, locale } = useLocale();
    const [data, setData] = useState<Execution[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedExecution, setSelectedExecution] = useState<Execution | null>(null);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState<number>(20);

    // 筛选状态
    const [timeFilter, setTimeFilter] = useState<TimeFilter>('all');
    const [anomalyFilter, setAnomalyFilter] = useState<'all' | 'yes' | 'no'>('yes'); // 默认筛选"是"
    const [frameworkFilter, setFrameworkFilter] = useState<string>('all');
    const [agentFilter, setAgentFilter] = useState<string>('all');
    const [skillFilter, setSkillFilter] = useState<string>('all');
    const [ownershipFilter, setOwnershipFilter] = useState<string>('user');

    useEffect(() => {
        const agent = searchParams?.get('agent');
        if (agent) setAgentFilter(agent);
    }, []);

    const handleSelectExecution = (e: Execution | null) => {
        setSelectedExecution(e);
        const params = new URLSearchParams(window.location.search);
        if (e) {
            const id = e.task_id || e.upload_id;
            if (id) params.set('taskId', id);
        } else {
            params.delete('taskId');
        }
        router.push(`${window.location.pathname}?${params.toString()}`, { scroll: false });
    };

    // 同步 URL taskId → selectedExecution
    useEffect(() => {
        const taskId = searchParams?.get('taskId');
        if (taskId) {
            const exec = data.find(e => e.task_id === taskId || e.upload_id === taskId);
            if (exec && selectedExecution !== exec) {
                setSelectedExecution(exec);
            }
        } else {
            if (selectedExecution) {
                setSelectedExecution(null);
            }
        }
    }, [searchParams, data]);

    useEffect(() => {
        if (!user) return;
        setLoading(true);
        apiFetch(`/api/observe/data?user=${encodeURIComponent(user)}`)
            .then(r => r.json())
            .then((d: Execution[]) => {
                const list = Array.isArray(d) ? d : [];
                setData(list);
            })
            .catch(() => setData([]))
            .finally(() => setLoading(false));
    }, [user]);

    const { availableAgents, availableSkills, frameworks } = useMemo(() => {
        const agents = new Set<string>();
        const skills = new Set<string>();
        const fws = new Set<string>();
        data.forEach(d => {
            if (d.agent) agents.add(d.agent);
            if (d.framework) {
                agents.add(d.framework);
                fws.add(d.framework);
            }
            if (d.agents) d.agents.forEach(a => agents.add(a));
            getInvokedSkillNames(d).forEach(s => skills.add(s));
        });
        return {
            availableAgents: Array.from(agents).sort(),
            availableSkills: Array.from(skills).sort(),
            frameworks: Array.from(fws).sort()
        };
    }, [data]);

    const filtered = useMemo(() => {
        // eslint-disable-next-line react-hooks/purity
        const now = Date.now();
        const winMs = TIME_WIN_MS[timeFilter];
        return data
            .filter(e => {
                // 1. 时间过滤
                if (winMs !== Infinity) {
                    const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : Number(e.timestamp);
                    if (now - ts > winMs) return false;
                }

                // 2. 异常过滤
                const hasAnomaly = (e.failures && e.failures.length > 0) || (e.tool_call_error_count || 0) > 0;
                if (anomalyFilter === 'yes' && !hasAnomaly) return false;
                if (anomalyFilter === 'no' && hasAnomaly) return false;

                // 3. 平台过滤
                if (frameworkFilter !== 'all' && e.framework !== frameworkFilter) return false;

                // 4. Agent 过滤
                if (agentFilter !== 'all' && agentFilter !== '') {
                    const matchAgent = e.agent === agentFilter || e.framework === agentFilter;
                    const matchAgentsList = e.agents && e.agents.includes(agentFilter);
                    if (!matchAgent && !matchAgentsList) return false;
                }

                // 5. Skill 过滤
                if (skillFilter !== 'all') {
                    const skills = getInvokedSkillNames(e);
                    if (!skills.includes(skillFilter)) return false;
                }

                // 6. Agent 归属过滤
                if (ownershipFilter !== 'all') {
                    const ownership = e.agentOwnership ?? 'unregistered';
                    if (ownership !== ownershipFilter) return false;
                }

                return true;
            })
            .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    }, [data, timeFilter, anomalyFilter, frameworkFilter, agentFilter, skillFilter, ownershipFilter]);

    const failureTypeCounts = useMemo(() => {
        const m = new Map<string, number>();
        for (const e of filtered) {
            for (const f of e.failures || []) {
                if (f.failure_type) m.set(f.failure_type, (m.get(f.failure_type) || 0) + 1);
            }
        }
        return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
    }, [filtered]);

    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const pageItems = useMemo(
        () => filtered.slice((page - 1) * pageSize, page * pageSize),
        [filtered, page, pageSize],
    );

    useEffect(() => setPage(1), [pageSize, timeFilter, anomalyFilter, frameworkFilter, agentFilter, skillFilter, ownershipFilter]);

    return (
        <>
            <AppTopBar title={t('nav.fault')} showDefaultActions={false} />
            <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px' }}>
                {selectedExecution ? (
                    <FaultDetailView
                        execution={selectedExecution}
                        locale={locale}
                        user={user || ''}
                        onBack={() => handleSelectExecution(null)}
                    />
                ) : (
                    <>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 9, flex: 1 }}>
                                <StatCard label={locale === 'zh' ? '用例总数' : 'Total runs'} value={String(filtered.length)} sub={`${locale === 'zh' ? '共' : 'of'} ${data.length}`} />
                                <StatCard label={locale === 'zh' ? '异常类型' : 'Anomaly types'} value={String(failureTypeCounts.length)} />
                                <StatCard
                                    label={locale === 'zh' ? '主要异常' : 'Top anomaly'}
                                    value={failureTypeCounts[0]?.[0] || '-'}
                                    sub={failureTypeCounts[0] ? `${failureTypeCounts[0][1]}` : ''}
                                    truncate
                                />
                                <StatCard label={locale === 'zh' ? '异常记录' : 'Anomalies'} value={String(filtered.filter(e => (e.failures && e.failures.length > 0) || (e.tool_call_error_count || 0) > 0).length)} accent="error" />
                            </div>
                        </div>

                        <div
                            style={{
                                background: 'var(--background-secondary)',
                                border: '1px solid var(--border)',
                                borderRadius: 8,
                                marginBottom: 12,
                                overflow: 'hidden',
                            }}
                        >
                            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '7px 10px' }}>
                                {/* ── 归属 ── */}
                                <FilterChip
                                    label={t('nav.filterAgentOwnership')}
                                    active={ownershipFilter !== 'all'}
                                    value={ownershipFilter}
                                    onChange={v => { setPage(1); setOwnershipFilter(v); }}
                                >
                                    <option value="all">{t('nav.allOwnership')}</option>
                                    <option value="user">{t('nav.userAgent')}</option>
                                    <option value="system">{t('nav.systemAgent')}</option>
                                    <option value="unregistered">{t('nav.unregisteredAgent')}</option>
                                </FilterChip>

                                {/* ── Agent ── */}
                                {availableAgents.length > 0 && (
                                    <FilterChip
                                        label="Agent"
                                        active={agentFilter !== 'all' && agentFilter !== ''}
                                        value={agentFilter}
                                        onChange={v => { setPage(1); setAgentFilter(v); }}
                                    >
                                        <option value="all">{t('common.all')}</option>
                                        {availableAgents.map(a => <option key={a} value={a}>{a}</option>)}
                                    </FilterChip>
                                )}

                                {/* ── Skill ── */}
                                {availableSkills.length > 0 && (
                                    <FilterChip
                                        label="Skill"
                                        active={skillFilter !== 'all'}
                                        value={skillFilter}
                                        onChange={v => { setPage(1); setSkillFilter(v); }}
                                    >
                                        <option value="all">{t('common.all')}</option>
                                        {availableSkills.map(s => <option key={s} value={s}>{s}</option>)}
                                    </FilterChip>
                                )}

                                <FilterDivider />

                                {/* ── 执行异常（智能诊断额外保留）── */}
                                <FilterChip
                                    label={locale === 'zh' ? '执行异常' : 'Anomaly'}
                                    active={anomalyFilter !== 'all'}
                                    value={anomalyFilter}
                                    onChange={v => setAnomalyFilter(v as any)}
                                >
                                    <option value="all">{t('common.all')}</option>
                                    <option value="yes">{locale === 'zh' ? '是' : 'Yes'}</option>
                                    <option value="no">{locale === 'zh' ? '否' : 'No'}</option>
                                </FilterChip>

                                {/* ── 时间范围 ── */}
                                <FilterChip
                                    label={locale === 'zh' ? '时间' : 'Time'}
                                    active={timeFilter !== 'all'}
                                    value={timeFilter}
                                    onChange={v => setTimeFilter(v as TimeFilter)}
                                >
                                    <option value="all">{t('common.allTime')}</option>
                                    <option value="7d">{t('nav.last7Days')}</option>
                                    <option value="24h">{t('topbar.last24h')}</option>
                                    <option value="1h">{t('nav.last1Hour')}</option>
                                </FilterChip>

                                {/* ── 平台（条件显示）── */}
                                {frameworks.length > 1 && (
                                    <FilterChip
                                        label={locale === 'zh' ? '平台' : 'Platform'}
                                        active={frameworkFilter !== 'all'}
                                        value={frameworkFilter}
                                        onChange={v => setFrameworkFilter(v)}
                                    >
                                        <option value="all">{t('common.all')}</option>
                                        {frameworks.map(f => <option key={f} value={f}>{f}</option>)}
                                    </FilterChip>
                                )}

                                {/* ── 重置 ── */}
                                {(ownershipFilter !== 'all' || agentFilter !== 'all' || skillFilter !== 'all' || anomalyFilter !== 'all' || timeFilter !== 'all' || frameworkFilter !== 'all') && (
                                    <button
                                        onClick={() => {
                                            setOwnershipFilter('all');
                                            setAgentFilter('all');
                                            setSkillFilter('all');
                                            setAnomalyFilter('all');
                                            setTimeFilter('all');
                                            setFrameworkFilter('all');
                                        }}
                                        style={{
                                            marginLeft: 6,
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: 4,
                                            padding: '3px 10px',
                                            fontSize: 11,
                                            borderRadius: 5,
                                            border: '1px solid var(--border)',
                                            background: 'transparent',
                                            color: 'var(--foreground-muted)',
                                            cursor: 'pointer',
                                            lineHeight: 1.4,
                                        }}
                                    >
                                        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M2 2l6 6M8 2l-6 6"/></svg>
                                        {locale === 'zh' ? '重置' : 'Reset'}
                                    </button>
                                )}
                            </div>

                            {/* Active filter tags row */}
                            {(ownershipFilter !== 'all' || timeFilter !== 'all' || anomalyFilter !== 'all' || frameworkFilter !== 'all' || (agentFilter !== 'all' && agentFilter !== '') || skillFilter !== 'all') && (
                                <div style={{
                                    display: 'flex',
                                    flexWrap: 'wrap',
                                    gap: 5,
                                    alignItems: 'center',
                                    padding: '5px 10px 7px',
                                    borderTop: '1px solid var(--border)',
                                }}>
                                    <span style={{ fontSize: 10.5, color: 'var(--foreground-muted)', flexShrink: 0, marginRight: 2 }}>
                                        {locale === 'zh' ? '已筛选' : 'Active'}
                                    </span>
                                    {ownershipFilter !== 'all' && (
                                        <ActiveFilterTag
                                            label={`${t('nav.filterAgentOwnership')}: ${ownershipFilter === 'user' ? t('nav.userAgent') : ownershipFilter === 'system' ? t('nav.systemAgent') : t('nav.unregisteredAgent')}`}
                                            onRemove={() => setOwnershipFilter('all')}
                                        />
                                    )}
                                    {agentFilter !== 'all' && agentFilter !== '' && (
                                        <ActiveFilterTag label={`Agent: ${agentFilter}`} onRemove={() => setAgentFilter('all')} />
                                    )}
                                    {skillFilter !== 'all' && (
                                        <ActiveFilterTag label={`Skill: ${skillFilter}`} onRemove={() => setSkillFilter('all')} />
                                    )}
                                    {anomalyFilter !== 'all' && (
                                        <ActiveFilterTag
                                            label={`${locale === 'zh' ? '执行异常' : 'Anomaly'}: ${anomalyFilter === 'yes' ? (locale === 'zh' ? '是' : 'Yes') : (locale === 'zh' ? '否' : 'No')}`}
                                            onRemove={() => setAnomalyFilter('all')}
                                        />
                                    )}
                                    {timeFilter !== 'all' && (
                                        <ActiveFilterTag
                                            label={`${locale === 'zh' ? '时间' : 'Time'}: ${timeFilter === '1h' ? (locale === 'zh' ? '1小时内' : 'Last 1h') : timeFilter === '24h' ? (locale === 'zh' ? '24小时内' : 'Last 24h') : timeFilter === '7d' ? (locale === 'zh' ? '近7天' : 'Last 7d') : timeFilter}`}
                                            onRemove={() => setTimeFilter('all')}
                                        />
                                    )}
                                    {frameworkFilter !== 'all' && (
                                        <ActiveFilterTag
                                            label={`${locale === 'zh' ? '平台' : 'Platform'}: ${frameworkFilter}`}
                                            onRemove={() => setFrameworkFilter('all')}
                                        />
                                    )}
                                </div>
                            )}
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 9 }}>
                            <span className="ai-section-title">
                                {locale === 'zh' ? '故障事件清单' : 'Fault events'}
                                <span style={{ marginLeft: 8, color: 'var(--foreground-muted)', fontWeight: 400 }}>{filtered.length}</span>
                            </span>
                            <span className="ai-section-hint">
                                {anomalyFilter === 'yes'
                                    ? (locale === 'zh' ? '当前仅展示执行异常的记录' : 'Only showing records with execution anomalies')
                                    : (locale === 'zh' ? '展示所有匹配条件的记录' : 'Showing all matching records')}
                            </span>
                        </div>

                        <div className="ai-card" style={{ overflowX: 'auto' }}>
                            {loading ? (
                                <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--foreground-muted)', fontSize: 12 }}>
                                    {locale === 'zh' ? '加载中...' : 'Loading...'}
                                </div>
                            ) : pageItems.length === 0 ? (
                                <div style={{ padding: '40px 18px', textAlign: 'center', color: 'var(--foreground-muted)', fontSize: 12 }}>
                                    {locale === 'zh' ? '暂无异常记录' : 'No anomaly runs'}
                                </div>
                            ) : (
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5, tableLayout: 'fixed' }}>
                                    <thead>
                                        <tr style={{ background: 'var(--background-secondary)', textAlign: 'left' }}>
                                            <Th width={120}>Trace ID</Th>
                                            <Th width={120}>Agent</Th>
                                            <Th width={90}>{locale === 'zh' ? '执行状态' : 'Status'}</Th>
                                            <Th>{locale === 'zh' ? '任务内容' : 'Task'}</Th>
                                            <Th width={160}>{locale === 'zh' ? '故障摘要' : 'Summary'}</Th>
                                            <Th width={170}>{locale === 'zh' ? '执行时间' : 'Time'}</Th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {pageItems.map((e, i) => (
                                            <FaultRow
                                                key={(e.task_id || e.upload_id || i) + ''}
                                                execution={e}
                                                onClick={() => handleSelectExecution(e)}
                                                locale={locale}
                                            />
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>

                        {filtered.length > 0 && (
                            <Pagination
                                page={page}
                                totalPages={totalPages}
                                pageSize={pageSize}
                                total={filtered.length}
                                onPage={setPage}
                                onPageSize={setPageSize}
                                locale={locale}
                            />
                        )}
                    </>
                )}
            </div>
        </>
    );
}

function FaultDetailView({ execution, locale, user, onBack }: { execution: Execution; locale: string; user: string; onBack: () => void }) {
    const taskId = execution.task_id || execution.upload_id || '';
    const detailsLink = `${basePath}/details?framework=${encodeURIComponent(execution.framework || '')}&expandTaskId=${taskId}`;

    // ── Data state (unchanged logic) ──
    const [session, setSession] = useState<SessionData | null>(null);
    const [sessionLoading, setSessionLoading] = useState(false);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [agentSessionId, setAgentSessionId] = useState<string | null>(null);
    const [sending, setSending] = useState(false);

    // ── UI state ──
    const [pendingNodeRefs, setPendingNodeRefs] = useState<Map<string, TraceNodeItem>>(new Map());
    const [traceSearch, setTraceSearch] = useState('');
    const [tracePanelCollapsed, setTracePanelCollapsed] = useState(false);
    const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set());
    const [highlightNodeId, setHighlightNodeId] = useState<string | null>(null);
    const [mentionActive, setMentionActive] = useState(false);
    const [mentionFilter, setMentionFilter] = useState('');
    const [detailsExpanded, setDetailsExpanded] = useState(false);
    const [showHistoryPanel, setShowHistoryPanel] = useState(false);
    const [conversations, setConversations] = useState<ConversationSnapshot[]>([]);

    // ── Refs ──
    const chatScrollRef = useRef<HTMLDivElement | null>(null);
    const traceNodeEls = useRef<Map<string, HTMLDivElement>>(new Map());
    const composerRef = useRef<HTMLTextAreaElement | null>(null);

    const [selectedNode, setSelectedNode] = useState<TreeTraceNode | null>(null);

    // ── Computed ──
    const faultKinds = useMemo(() => classifyFaultKinds(execution), [execution]);
    const diagnosticItems = useMemo(() => buildDiagnosticItems(execution, locale), [execution, locale]);
    const traceNodes = useMemo(() => buildFaultPath(execution, session?.interactions || [], locale, diagnosticItems), [execution, session?.interactions, locale, diagnosticItems]);
    const faultSummary = useMemo(() => summarizeFaultPath(traceNodes, execution), [traceNodes, execution]);
    const skillCount = (execution.invoked_skills?.length ?? 0) || (execution.skills?.length ?? 0) || (execution.skill ? 1 : 0);

    const { roots: treeRoots, nodeMap: treeNodeMap } = useMemo(() => flatToTree(traceNodes), [traceNodes]);

    const maxDurationMs = useMemo(() => {
        let max = 0;
        for (const n of traceNodes) { if (n.durationMs != null && n.durationMs > max) max = n.durationMs; }
        return max;
    }, [traceNodes]);

    const mentionNodes = useMemo(() => {
        const f = mentionFilter.toLowerCase();
        return traceNodes.filter(n => !f || n.name.toLowerCase().includes(f) || (n.kind || '').includes(f));
    }, [traceNodes, mentionFilter]);

    // Only show deviation fault badge when original errors also exist
    const displayFaultKinds = useMemo(() =>
        faultKinds.includes('original') ? faultKinds : faultKinds.filter(k => k !== 'deviation'),
        [faultKinds],
    );

    // ── Actions ──
    const quoteNode = useCallback((node: TraceNodeItem) => {
        setPendingNodeRefs(prev => { const n = new Map(prev); n.set(node.id, node); return n; });
        setMentionActive(false);
        composerRef.current?.focus();
    }, []);

    const scrollToNode = useCallback((nodeId: string) => {
        // Expand all ancestors
        let cur = treeNodeMap.get(nodeId);
        while (cur?.parentId) {
            const pid = cur.parentId;
            setCollapsedNodes(prev => { const n = new Set(prev); n.delete(pid); return n; });
            cur = treeNodeMap.get(pid);
        }
        if (tracePanelCollapsed) setTracePanelCollapsed(false);
        setHighlightNodeId(nodeId);
        setTimeout(() => {
            traceNodeEls.current.get(nodeId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(() => setHighlightNodeId(null), 1800);
        }, 330);
    }, [treeNodeMap, tracePanelCollapsed]);

    const handleFaultSelect = useCallback((ref: number) => {
        const node = traceNodes.find(n => n.faultRefs?.includes(ref));
        if (node) scrollToNode(node.id);
    }, [traceNodes, scrollToNode]);

    // ── Data loading ──
    useEffect(() => {
        setMessages([]); setInput(''); setAgentSessionId(null); setSession(null);
        setPendingNodeRefs(new Map()); setTraceSearch(''); setCollapsedNodes(new Set());
        if (!taskId) return;
        setSessionLoading(true);
        apiFetch(`/api/observe/session?taskId=${encodeURIComponent(taskId)}`)
            .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
            .then((d: SessionData) => setSession(d))
            .catch(err => setSession({ error: err instanceof Error ? err.message : String(err), interactions: [] }))
            .finally(() => setSessionLoading(false));
        apiFetch(`/api/fault/diagnosis/session?executionId=${encodeURIComponent(taskId)}`)
            .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
            .then((d: { session: { opencodeSessionId?: string } | null; messages: Array<{ id: string; role: string; content: string }> }) => {
                if (d.session?.opencodeSessionId) setAgentSessionId(d.session.opencodeSessionId);
                if (d.messages?.length) setMessages(d.messages.map(m => ({ id: m.id, role: m.role as 'user' | 'assistant', content: m.content })));
            })
            .catch(() => {});
    }, [taskId]);

    useEffect(() => {
        chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight });
    }, [messages, sending]);

    // Load saved conversations from localStorage
    useEffect(() => {
        if (!taskId) return;
        try {
            const raw = localStorage.getItem(`fault-convs-${taskId}`);
            if (raw) setConversations(JSON.parse(raw));
        } catch { /* ignore */ }
    }, [taskId]);

    const saveCurrentConversation = useCallback(() => {
        if (messages.length === 0 || !taskId) return;
        const title = messages.find(m => m.role === 'user')?.content?.slice(0, 60) || (locale === 'zh' ? '对话' : 'Conversation');
        const snapshot: ConversationSnapshot = {
            id: `conv-${Date.now()}`,
            title,
            messages: [...messages],
            agentSessionId,
            createdAt: Date.now(),
        };
        setConversations(prev => {
            const updated = [snapshot, ...prev].slice(0, 20);
            try { localStorage.setItem(`fault-convs-${taskId}`, JSON.stringify(updated)); } catch { /* ignore */ }
            return updated;
        });
    }, [messages, agentSessionId, taskId, locale]);

    const handleNewConversation = useCallback(() => {
        saveCurrentConversation();
        setMessages([]);
        setAgentSessionId(null);
        setInput('');
        setPendingNodeRefs(new Map());
        setShowHistoryPanel(false);
    }, [saveCurrentConversation]);

    const handleLoadConversation = useCallback((conv: ConversationSnapshot) => {
        saveCurrentConversation();
        setMessages(conv.messages);
        setAgentSessionId(conv.agentSessionId);
        setShowHistoryPanel(false);
    }, [saveCurrentConversation]);

    // ── Submit ──
    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        const text = input.trim();
        if ((!text && pendingNodeRefs.size === 0) || sending || !user) return;

        const refNodes = Array.from(pendingNodeRefs.values());
        const nodeRefs: NodeRef[] = refNodes.map(n => ({ id: n.id, label: n.name, kind: n.kind as string | undefined }));
        const refContextLines = refNodes.length > 0
            ? ['用户引用的执行节点（回答中引用这些节点时请使用 @[id:label] 格式）：',
               ...refNodes.map(n => `- @[${n.id}:${n.name}] 类型:${n.kind || 'unknown'} 状态:${n.status} 耗时:${n.time || '—'}`), '']
            : [];
        const fullMessage = [...refContextLines, text].filter(Boolean).join('\n');

        const userMessage: ChatMessage = { id: `u-${Date.now()}`, role: 'user', content: text || '（节点引用）', nodeRefs };
        const assistantId = `a-${Date.now()}`;
        setMessages(prev => [...prev, userMessage, { id: assistantId, role: 'assistant', content: '', pending: true }]);
        setInput(''); setPendingNodeRefs(new Map()); setSending(true);

        try {
            const response = await apiFetch('/api/fault/diagnosis/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user, message: fullMessage, executionId: taskId, sessionId: agentSessionId, executionBrief: buildExecutionBrief(execution) }),
            });
            if (!response.ok || !response.body) throw new Error((await response.text().catch(() => '')) || `HTTP ${response.status}`);
            await consumeSse(response, {
                text: data => {
                    const delta = typeof data?.delta === 'string' ? data.delta : '';
                    if (delta) setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: m.content + delta, pending: false } : m));
                },
                done: data => {
                    if (typeof data?.sessionId === 'string') setAgentSessionId(data.sessionId);
                    setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: m.content || (data?.output || ''), pending: false } : m));
                },
                error: data => { throw new Error(String(data?.message || '诊断 Agent 调用失败')); },
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: `${locale === 'zh' ? '诊断 Agent 调用失败：' : 'Agent failed: '}${msg}`, pending: false } : m));
        } finally { setSending(false); }
    }

    const handleComposerInput = (val: string) => {
        setInput(val);
        const m = val.match(/@(\S*)$/);
        if (m) { setMentionActive(true); setMentionFilter(m[1]); }
        else setMentionActive(false);
    };

    const traceSearchLower = traceSearch.toLowerCase();

    // ── Render ──
    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 106px)', overflow: 'hidden' }}>
            {selectedNode && <NodeDetailModal node={selectedNode} onClose={() => setSelectedNode(null)} locale={locale} />}

            {/* ── Session header ── */}
            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--card-bg)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0, flexWrap: 'wrap' }}>
                <button onClick={onBack} className="ai-btn-s" style={{ padding: '4px 9px', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <ArrowLeft size={12} />
                    {locale === 'zh' ? '返回' : 'Back'}
                </button>
                <div style={{ width: 1, height: 16, background: 'var(--border)', flexShrink: 0 }} />
                <div>
                    <div style={{ fontSize: 9, color: 'var(--foreground-muted)', letterSpacing: '.12em', textTransform: 'uppercase', marginBottom: 2, fontWeight: 700 }}>EXECUTION SESSION</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--foreground)' }}>{shortId(taskId)}</span>
                        {(execution.agentName || execution.agent) && (
                            <span style={{ fontSize: 12, color: 'var(--foreground-muted)', fontWeight: 600 }}>· {execution.agentName || execution.agent}</span>
                        )}
                        {displayFaultKinds.map(k => <FaultKindBadge key={k} kind={k} locale={locale} />)}
                    </div>
                </div>
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 0 }}>
                    <SessionStat label={locale === 'zh' ? '链路状态' : 'Status'} value={faultSummary.statusLabel} valueColor={faultSummary.hasFault ? 'var(--warning,#d97706)' : 'var(--success,#15a572)'} />
                    <SessionStat label={locale === 'zh' ? '执行节点' : 'Nodes'} value={String(faultSummary.executed)} />
                    <SessionStat label="LLM" value={String(execution.llm_call_count ?? '—')} />
                    <SessionStat label={locale === 'zh' ? '故障节点' : 'Faults'} value={String(faultSummary.faultNodeCount)} valueColor={faultSummary.faultNodeCount > 0 ? 'var(--warning,#d97706)' : undefined} />
                    <SessionStat label="Token" value={execution.tokens ? fmtTokens(execution.tokens) : '—'} />
                    <SessionStat label={locale === 'zh' ? '耗时' : 'Duration'} value={fmtSec(toDisplayLatencyMs(execution.latency || 0, execution.framework))} />
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <Link href={`${basePath}/trace?taskId=${taskId}`} className="ai-btn-s" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <GitBranch size={12} /> {locale === 'zh' ? '链路' : 'Trace'}
                    </Link>
                </div>
            </div>

            {/* ── Workspace ── */}
            <div style={{ display: 'grid', gridTemplateColumns: tracePanelCollapsed ? '44px 1fr' : '320px 1fr', flex: 1, overflow: 'hidden', minHeight: 0, transition: 'grid-template-columns 0.3s cubic-bezier(0.4,0,0.2,1)' }}>

                {/* ── LEFT: Trace Panel ── */}
                <div style={{ display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', background: 'var(--card-bg)', overflow: 'hidden', minWidth: 0 }}>
                    {tracePanelCollapsed ? (
                        /* Collapsed rail */
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '10px 0', gap: 6, height: '100%' }}>
                            <button onClick={() => setTracePanelCollapsed(false)} className="ai-btn-s" style={{ width: 30, height: 30, padding: 0, display: 'grid', placeItems: 'center', borderRadius: 7 }} title="展开">
                                <ChevronRight size={14} />
                            </button>
                            <div style={{ width: 20, height: 1, background: 'var(--border)', margin: '4px 0' }} />
                            <div style={{ marginTop: 'auto', width: 30, padding: '4px 0', borderRadius: 6, background: 'var(--background-secondary)', fontFamily: 'var(--font-mono)', fontSize: 9, textAlign: 'center', fontWeight: 600, color: 'var(--foreground-muted)' }}>
                                <div style={{ color: 'var(--foreground)', fontSize: 11, fontWeight: 700 }}>{traceNodes.length}</div>
                                {locale === 'zh' ? '节点' : 'nodes'}
                            </div>
                        </div>
                    ) : (
                        <>
                            {/* Panel head */}
                            <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                                <div style={{ width: 26, height: 26, borderRadius: 7, background: 'rgba(99,86,230,0.08)', border: '1px solid rgba(99,86,230,0.25)', display: 'grid', placeItems: 'center', color: 'var(--primary)', flexShrink: 0 }}>
                                    <GitBranch size={13} />
                                </div>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontSize: 9.5, color: 'var(--foreground-muted)', letterSpacing: '.10em', textTransform: 'uppercase', fontWeight: 700 }}>EXECUTION TRACE</div>
                                    <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                        {locale === 'zh' ? `执行链路 · ${traceNodes.length} 节点` : `Trace · ${traceNodes.length} nodes`}
                                    </div>
                                </div>
                                <button onClick={() => setTracePanelCollapsed(true)} className="ai-btn-s" style={{ width: 26, height: 26, padding: 0, display: 'grid', placeItems: 'center', flexShrink: 0, borderRadius: 6 }} title="收起">
                                    <PanelLeft size={13} />
                                </button>
                            </div>

                            {/* Search */}
                            <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
                                <div style={{ position: 'relative' }}>
                                    <input value={traceSearch} onChange={e => setTraceSearch(e.target.value)} placeholder={locale === 'zh' ? '搜索节点…' : 'Search nodes…'}
                                        style={{ width: '100%', height: 30, background: 'var(--background-secondary)', border: '1px solid var(--border)', borderRadius: 7, padding: '0 10px 0 28px', fontSize: 12, color: 'var(--foreground)', outline: 'none', fontFamily: 'inherit' }} />
                                    <svg style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--foreground-muted)' }} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
                                </div>
                            </div>

                            {/* Tree scroll */}
                            <div style={{ flex: 1, overflowY: 'auto', padding: '4px 4px 24px', minHeight: 0 }}>
                                {sessionLoading && (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--foreground-muted)', fontSize: 11.5, padding: '12px 8px' }}>
                                        <Loader2 size={13} className="animate-spin" />
                                        {locale === 'zh' ? '加载链路中...' : 'Loading trace...'}
                                    </div>
                                )}
                                {treeRoots.map((node, idx) => (
                                    <TreeNodeRow
                                        key={node.id}
                                        node={node}
                                        ancestors={[]}
                                        isLast={idx === treeRoots.length - 1}
                                        collapsedNodes={collapsedNodes}
                                        onToggleCollapse={id => setCollapsedNodes(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; })}
                                        onQuoteNode={quoteNode}
                                        onFaultSelect={handleFaultSelect}
                                        onNodeClick={setSelectedNode}
                                        highlightNodeId={highlightNodeId}
                                        traceNodeEls={traceNodeEls}
                                        traceSearch={traceSearchLower}
                                        locale={locale}
                                        maxDurationMs={maxDurationMs}
                                    />
                                ))}
                            </div>

                            {/* Footer */}
                            <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', background: 'var(--background-secondary)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, fontSize: 10.5 }}>
                                <Clock size={12} color="var(--foreground-muted)" />
                                <span style={{ color: 'var(--foreground-muted)' }}>{new Date(execution.timestamp).toLocaleString()}</span>
                                {faultSummary.faultNodeCount > 0 && <>
                                    <span style={{ color: 'var(--border)' }}>·</span>
                                    <span style={{ color: 'var(--warning,#d97706)', fontWeight: 600 }}>⚠ {faultSummary.faultNodeCount} {locale === 'zh' ? '故障' : 'fault(s)'}</span>
                                </>}
                            </div>

                            {/* Collapsible 详情 section */}
                            <div style={{ borderTop: '1px solid var(--border)', flexShrink: 0 }}>
                                <button
                                    onClick={() => setDetailsExpanded(p => !p)}
                                    style={{ width: '100%', padding: '7px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: 'var(--foreground-muted)' }}
                                >
                                    <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                        <ExternalLink size={11} />
                                        {locale === 'zh' ? '详情' : 'Details'}
                                    </span>
                                    {detailsExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                                </button>
                                {detailsExpanded && (
                                    <div style={{ padding: '0 12px 12px' }}>
                                        {(execution.agentName || execution.agent) && (
                                            <div style={{ fontSize: 10.5, color: 'var(--foreground-muted)', marginBottom: 4 }}>
                                                {execution.agentName || execution.agent}
                                            </div>
                                        )}
                                        {execution.query && (
                                            <div style={{ fontSize: 11, color: 'var(--foreground)', lineHeight: 1.5, marginBottom: 8, wordBreak: 'break-all' }}>
                                                {execution.query.slice(0, 120)}{execution.query.length > 120 ? '…' : ''}
                                            </div>
                                        )}
                                        <a
                                            href={detailsLink}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="ai-btn-s"
                                            style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11 }}
                                        >
                                            <ExternalLink size={11} />
                                            {locale === 'zh' ? '在详情页查看' : 'View full details'}
                                        </a>
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </div>

                {/* ── RIGHT: Chat Panel ── */}
                <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0, background: 'var(--background-secondary)', position: 'relative' }}>
                    {/* Chat head */}
                    <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12, background: 'var(--card-bg)', flexShrink: 0 }}>
                        <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--primary,#6356e6)', display: 'grid', placeItems: 'center', color: 'white', flexShrink: 0, boxShadow: '0 4px 12px rgba(99,86,230,0.3)' }}>
                            <Sparkles size={16} />
                        </div>
                        <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--foreground)' }}>
                                {locale === 'zh' ? 'Insight AI · 智能诊断' : 'Insight AI · Diagnosis'}
                            </div>
                            <div style={{ fontSize: 10.5, color: 'var(--foreground-muted)', letterSpacing: '.06em', textTransform: 'uppercase', marginTop: 1 }}>FAULT-DIAGNOSIS-AGENT</div>
                        </div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            {diagnosticItems.length > 0 && <FaultFilterPill active label={locale === 'zh' ? '故障条目已载入' : 'Faults loaded'} count={diagnosticItems.length} />}
                            <FaultFilterPill label={locale === 'zh' ? `${skillCount} Skill` : `${skillCount} skills`} />
                            <div style={{ width: 1, height: 16, background: 'var(--border)', flexShrink: 0 }} />
                            <button
                                type="button"
                                onClick={handleNewConversation}
                                title={locale === 'zh' ? '新增对话' : 'New conversation'}
                                className="ai-btn-s"
                                style={{ padding: '4px 8px', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}
                            >
                                <Plus size={12} />
                                {locale === 'zh' ? '新对话' : 'New'}
                            </button>
                            <button
                                type="button"
                                onClick={() => setShowHistoryPanel(p => !p)}
                                title={locale === 'zh' ? '对话历史' : 'Conversation history'}
                                className="ai-btn-s"
                                style={{ padding: '4px 8px', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, background: showHistoryPanel ? 'var(--primary-subtle)' : undefined, color: showHistoryPanel ? 'var(--primary)' : undefined, borderColor: showHistoryPanel ? 'var(--primary-subtle-border)' : undefined }}
                            >
                                <History size={12} />
                                {locale === 'zh' ? '历史' : 'History'}
                                {conversations.length > 0 && (
                                    <span style={{ fontSize: 9, fontWeight: 700, background: 'var(--primary)', color: 'white', borderRadius: 999, padding: '1px 4px', lineHeight: 1.3 }}>
                                        {conversations.length}
                                    </span>
                                )}
                            </button>
                        </div>
                    </div>

                    {/* Conversation history overlay */}
                    {showHistoryPanel && (
                        <div style={{ position: 'absolute', top: 0, right: 0, width: 320, bottom: 0, background: 'var(--card-bg)', borderLeft: '1px solid var(--border)', zIndex: 20, display: 'flex', flexDirection: 'column', boxShadow: '-4px 0 16px rgba(0,0,0,0.08)' }}>
                            <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                                    <History size={14} color="var(--primary)" />
                                    <span style={{ fontSize: 13, fontWeight: 700 }}>{locale === 'zh' ? '对话历史' : 'Conversation history'}</span>
                                </div>
                                <button onClick={() => setShowHistoryPanel(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--foreground-muted)', display: 'grid', placeItems: 'center', width: 24, height: 24, borderRadius: 5 }}>
                                    <X size={14} />
                                </button>
                            </div>
                            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
                                {messages.length > 0 && (
                                    <div>
                                        <div style={{ padding: '4px 14px 2px', fontSize: 10, fontWeight: 700, color: 'var(--foreground-muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                                            {locale === 'zh' ? '当前对话' : 'Current'}
                                        </div>
                                        <button
                                            onClick={() => setShowHistoryPanel(false)}
                                            style={{ width: '100%', padding: '8px 14px', background: 'var(--primary-subtle)', border: 'none', textAlign: 'left', cursor: 'pointer', borderBottom: '1px solid var(--border)' }}
                                        >
                                            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {messages.find(m => m.role === 'user')?.content?.slice(0, 50) || (locale === 'zh' ? '当前对话' : 'Current chat')}
                                            </div>
                                            <div style={{ fontSize: 10, color: 'var(--foreground-muted)', marginTop: 2 }}>
                                                {messages.length} {locale === 'zh' ? '条消息' : 'messages'}
                                            </div>
                                        </button>
                                    </div>
                                )}
                                {conversations.length > 0 && (
                                    <div>
                                        <div style={{ padding: '8px 14px 2px', fontSize: 10, fontWeight: 700, color: 'var(--foreground-muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                                            {locale === 'zh' ? '历史对话' : 'Past conversations'}
                                        </div>
                                        {conversations.map(conv => (
                                            <button
                                                key={conv.id}
                                                onClick={() => handleLoadConversation(conv)}
                                                style={{ width: '100%', padding: '8px 14px', background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)', textAlign: 'left', cursor: 'pointer' }}
                                                onMouseEnter={e => (e.currentTarget.style.background = 'var(--background-secondary)')}
                                                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                                            >
                                                <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                    {conv.title}
                                                </div>
                                                <div style={{ fontSize: 10, color: 'var(--foreground-muted)', marginTop: 2, display: 'flex', gap: 8 }}>
                                                    <span>{new Date(conv.createdAt).toLocaleString()}</span>
                                                    <span>{conv.messages.length} {locale === 'zh' ? '条' : 'msgs'}</span>
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                )}
                                {conversations.length === 0 && messages.length === 0 && (
                                    <div style={{ padding: '32px 14px', textAlign: 'center', color: 'var(--foreground-muted)', fontSize: 12 }}>
                                        {locale === 'zh' ? '暂无历史对话' : 'No past conversations'}
                                    </div>
                                )}
                            </div>
                            <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
                                <button
                                    onClick={handleNewConversation}
                                    className="ai-btn-s"
                                    style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '7px 12px', fontSize: 12 }}
                                >
                                    <Plus size={13} />
                                    {locale === 'zh' ? '新增对话' : 'New conversation'}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Chat scroll */}
                    <div ref={chatScrollRef} style={{ flex: 1, overflowY: 'auto', padding: '20px 24px 16px', minHeight: 0 }}>
                        <InitialDiagnosisBubble execution={execution} locale={locale} faultKinds={displayFaultKinds} diagnosticItems={diagnosticItems} traceNodes={traceNodes} onFaultSelect={handleFaultSelect} />
                        {messages.map(msg => <ChatBubble key={msg.id} message={msg} onNodeRefClick={scrollToNode} locale={locale} nodeMap={treeNodeMap} />)}
                        {messages.length === 0 && (
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0 0 40px' }}>
                                {[
                                    locale === 'zh' ? '这个故障最可能的根因是什么？' : 'What is the most likely root cause?',
                                    locale === 'zh' ? '给我一个修复方案' : 'Suggest a fix',
                                    locale === 'zh' ? '定位耗时最长的节点' : 'Find the slowest node',
                                ].map(text => (
                                    <button key={text} type="button" className="ai-btn-s" style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 5 }} onClick={() => { setInput(text); composerRef.current?.focus(); }}>
                                        <MessageSquare size={11} /> {text}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Composer */}
                    <div style={{ padding: '10px 20px 18px', flexShrink: 0, position: 'relative' }}>
                        <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 14, padding: '10px 12px 8px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
                            {/* Pending node refs */}
                            {pendingNodeRefs.size > 0 && (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 8, paddingBottom: 8, borderBottom: '1px dashed var(--border)' }}>
                                    {Array.from(pendingNodeRefs.values()).map(node => (
                                        <NodeRefChip key={node.id} nodeId={node.id} label={node.name} kind={node.kind as string | undefined}
                                            onClick={() => scrollToNode(node.id)}
                                            onRemove={() => setPendingNodeRefs(prev => { const n = new Map(prev); n.delete(node.id); return n; })} />
                                    ))}
                                </div>
                            )}
                            <form onSubmit={handleSubmit}>
                                <textarea
                                    ref={composerRef}
                                    value={input}
                                    onChange={e => handleComposerInput(e.target.value)}
                                    rows={2}
                                    placeholder={locale === 'zh' ? '向诊断 Agent 追问，输入 @ 引用具体节点…' : 'Ask the agent, type @ to reference a node…'}
                                    style={{ width: '100%', resize: 'none', border: 'none', background: 'transparent', color: 'var(--foreground)', fontSize: 13.5, lineHeight: 1.6, outline: 'none', minHeight: 44, maxHeight: 160, fontFamily: 'inherit' }}
                                    onKeyDown={e => {
                                        if (e.key === 'Escape') { setMentionActive(false); return; }
                                        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void handleSubmit(e as any); }
                                    }}
                                />
                                <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingTop: 8, borderTop: '1px solid var(--border)', marginTop: 4 }}>
                                    <button type="button" title="引用节点 (@)" onClick={() => { setMentionActive(m => !m); setMentionFilter(''); }}
                                        style={{ width: 28, height: 28, borderRadius: 6, background: 'transparent', border: '1px solid transparent', color: 'var(--foreground-muted)', display: 'grid', placeItems: 'center', cursor: 'pointer' }}>
                                        <AtSign size={14} />
                                    </button>
                                    <div style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--foreground-muted)', fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: 4 }}>
                                        <kbd style={{ background: 'var(--background-secondary)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 5px', fontSize: 10 }}>@</kbd>
                                        {locale === 'zh' ? '引用节点' : 'Ref node'}
                                        <span style={{ color: 'var(--border)', margin: '0 3px' }}>·</span>
                                        <kbd style={{ background: 'var(--background-secondary)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 5px', fontSize: 10 }}>↵</kbd>
                                        {locale === 'zh' ? '发送' : 'Send'}
                                    </div>
                                    <button type="submit" disabled={sending || (!input.trim() && pendingNodeRefs.size === 0)}
                                        style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--primary,#6356e6)', border: 'none', color: 'white', display: 'grid', placeItems: 'center', cursor: sending || (!input.trim() && pendingNodeRefs.size === 0) ? 'not-allowed' : 'pointer', opacity: sending || (!input.trim() && pendingNodeRefs.size === 0) ? 0.5 : 1, marginLeft: 6, boxShadow: '0 2px 8px rgba(99,86,230,0.35)' }}>
                                        {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                                    </button>
                                </div>
                            </form>
                        </div>

                        {/* @mention popup */}
                        {mentionActive && (
                            <div style={{ position: 'absolute', bottom: '100%', left: 20, right: 20, marginBottom: 6, background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.10)', maxHeight: 260, overflowY: 'auto', zIndex: 50 }}>
                                <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 10, color: 'var(--foreground-muted)', letterSpacing: '.08em', textTransform: 'uppercase', fontWeight: 700, background: 'var(--background-secondary)', borderRadius: '10px 10px 0 0' }}>
                                    {locale === 'zh' ? '引用执行节点' : 'Reference trace node'}
                                </div>
                                {mentionNodes.length === 0
                                    ? <div style={{ padding: 14, textAlign: 'center', fontSize: 11.5, color: 'var(--foreground-muted)' }}>{locale === 'zh' ? '没有匹配节点' : 'No matching nodes'}</div>
                                    : mentionNodes.slice(0, 12).map(node => {
                                        const bdg = KIND_BADGE[node.kind || ''];
                                        return (
                                            <button key={node.id} onClick={() => { quoteNode(node); setInput(i => i.replace(/@\S*$/, '').trimEnd()); }}
                                                style={{ width: '100%', padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', borderBottom: '1px solid var(--border)', background: 'transparent', border: 'none', textAlign: 'left' } as React.CSSProperties}
                                                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(99,86,230,0.06)')}
                                                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                                                {bdg && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, padding: '1px 4px', borderRadius: 3, background: bdg.bg, color: bdg.color, flexShrink: 0 }}>{bdg.label}</span>}
                                                <span style={{ fontSize: 12, color: 'var(--foreground)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}>{node.name}</span>
                                                <span style={{ fontSize: 10, color: 'var(--foreground-muted)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>{node.time || ''}</span>
                                            </button>
                                        );
                                    })
                                }
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

function InitialDiagnosisBubble({
    execution,
    locale,
    faultKinds,
    diagnosticItems,
    traceNodes,
    onFaultSelect,
}: {
    execution: Execution;
    locale: string;
    faultKinds: FaultKind[];
    diagnosticItems: DiagnosticItem[];
    traceNodes: TraceNodeItem[];
    onFaultSelect: (ref: number) => void;
}) {
    const originalItems = diagnosticItems.filter(item => item.diagnostic_kind === 'original');
    const deviationItems = diagnosticItems.filter(item => item.diagnostic_kind === 'deviation');
    return (
        <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
            <Avatar role="assistant" />
            <div style={{ maxWidth: 820 }}>
                <MessageMeta label="Insight AI" />
                <div style={bubbleStyle('assistant')}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                        {faultKinds.map(kind => <FaultKindBadge key={kind} kind={kind} locale={locale} />)}
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--foreground)', lineHeight: 1.65 }}>
                        {locale === 'zh'
                            ? '已从当前记录载入异常详情。下面是已有评测和链路数据的结构化摘要，这一步未额外调用 Agent。'
                            : 'Loaded anomaly details from this record. This summary uses existing data only and did not call an agent.'}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, marginTop: 12 }}>
                        <InlineFact label={locale === 'zh' ? '答案评分' : 'Score'} value={execution.answer_score == null ? '-' : String(execution.answer_score)} />
                        <InlineFact label={locale === 'zh' ? 'Token' : 'Tokens'} value={execution.tokens?.toLocaleString() || '-'} />
                        <InlineFact label={locale === 'zh' ? '耗时' : 'Duration'} value={fmtSec(toDisplayLatencyMs(execution.latency || 0, execution.framework))} />
                    </div>

                    {originalItems.length > 0 && (
                        <div style={diagnosisBoxStyle('error')}>
                            <div style={diagnosisTitleStyle}>
                                <AlertTriangle size={14} />
                                {locale === 'zh' ? `原始错误类故障 (${originalItems.length})` : `Original errors (${originalItems.length})`}
                            </div>
                            {originalItems.map((f, index) => (
                                <div key={index} style={{ paddingTop: index ? 10 : 0, marginTop: index ? 10 : 0, borderTop: index ? '1px solid var(--border)' : 'none' }}>
                                    {(() => {
                                        const faultRef = index + 1;
                                        const node = traceNodes.find(n => n.faultRefs?.includes(faultRef));
                                        return (
                                            <>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                                    <button
                                                        type="button"
                                                        onClick={() => onFaultSelect(faultRef)}
                                                        style={{
                                                            border: '1px solid var(--error-subtle-border)',
                                                            background: 'var(--error-subtle)',
                                                            color: 'var(--error)',
                                                            borderRadius: 999,
                                                            padding: '2px 7px',
                                                            fontSize: 10.5,
                                                            fontWeight: 750,
                                                            cursor: 'pointer',
                                                        }}
                                                    >
                                                        #{faultRef}
                                                    </button>
                                                    <div style={{ fontWeight: 650, color: 'var(--error)' }}>{f.failure_type || (locale === 'zh' ? '执行异常' : 'Execution error')}</div>
                                                </div>
                                                {node ? (
                                                    <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
                                                        <div style={{ fontWeight: 650, color: 'var(--primary)' }}>
                                                            {locale === 'zh' ? '发生步骤：' : 'Step: '}
                                                            {locale === 'zh' ? `第${node.step}步 · ${node.name}` : `Step ${node.step} · ${node.name}`}
                                                        </div>
                                                        <div style={mutedLineStyle}>
                                                            {locale === 'zh' ? '节点摘要：' : 'Node: '}
                                                            {node.meta || '-'}
                                                        </div>
                                                        {node.tag && (
                                                            <div style={mutedLineStyle}>
                                                                {locale === 'zh' ? '故障标记：' : 'Fault marker: '}
                                                                <span style={{ color: 'var(--error)', fontWeight: 700 }}>{node.tag}</span>
                                                            </div>
                                                        )}
                                                        {node.matchReason && (
                                                            <div style={mutedLineStyle}>
                                                                {locale === 'zh' ? '匹配依据：' : 'Matched by: '}
                                                                {node.matchReason}
                                                            </div>
                                                        )}
                                                    </div>
                                                ) : f.step ? (
                                                    <div style={{ marginTop: 3, fontWeight: 600, color: 'var(--primary)' }}>
                                                        {locale === 'zh' ? '原始定位：' : 'Original step: '}{f.step}
                                                    </div>
                                                ) : null}
                                            </>
                                        );
                                    })()}
                                    <div style={{ marginTop: 3 }}>{f.description || '-'}</div>
                                    {f.context && <div style={mutedLineStyle}>{locale === 'zh' ? '原报错：' : 'Original error: '}{f.context}</div>}
                                    {f.diagnostic_source === 'ingest' && (
                                        <div style={mutedLineStyle}>{locale === 'zh' ? '来源：上传/采集阶段自带的工具错误计数' : 'Source: uploaded trace tool error count'}</div>
                                    )}
                                    {f.recovery && <div style={{ ...mutedLineStyle, color: 'var(--success)' }}>{locale === 'zh' ? '建议：' : 'Recovery: '}{f.recovery}</div>}
                                </div>
                            ))}
                        </div>
                    )}

                    {deviationItems.length > 0 && (
                        <div style={diagnosisBoxStyle('deviation')}>
                            <div style={diagnosisTitleStyle}>
                                <AlertTriangle size={14} />
                                {locale === 'zh' ? `效果偏差类故障 (${deviationItems.length})` : `Deviation faults (${deviationItems.length})`}
                            </div>
                            {deviationItems.map((item, index) => (
                                <div key={index} style={{ paddingTop: index ? 10 : 0, marginTop: index ? 10 : 0, borderTop: index ? '1px solid var(--border)' : 'none' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                        <span style={{
                                            border: '1px solid var(--primary-subtle-border)',
                                            background: 'var(--primary-subtle)',
                                            color: 'var(--primary)',
                                            borderRadius: 999,
                                            padding: '2px 7px',
                                            fontSize: 10.5,
                                            fontWeight: 750,
                                        }}>
                                            #{originalItems.length + index + 1}
                                        </span>
                                        <div style={{ fontWeight: 650, color: 'var(--primary)' }}>{item.failure_type}</div>
                                    </div>
                                    <div style={{ marginTop: 3 }}>{item.description}</div>
                                    {item.context && <div style={mutedLineStyle}>{locale === 'zh' ? '原报错：' : 'Original error: '}{item.context}</div>}
                                    {item.recovery && <div style={{ ...mutedLineStyle, color: 'var(--success)' }}>{locale === 'zh' ? '建议：' : 'Recovery: '}{item.recovery}</div>}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function ChatBubble({
    message,
    onNodeRefClick,
    locale,
    nodeMap,
}: {
    message: ChatMessage;
    onNodeRefClick: (id: string) => void;
    locale: string;
    nodeMap?: Map<string, TreeTraceNode>;
}) {
    const isUser = message.role === 'user';
    return (
        <div style={{ display: 'flex', gap: 10, marginBottom: 14, justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
            {!isUser && <Avatar role="assistant" />}
            <div style={{ maxWidth: 820, minWidth: 0 }}>
                <MessageMeta label={isUser ? (locale === 'zh' ? '你' : 'You') : 'Insight AI'} align={isUser ? 'right' : 'left'} />
                <div style={bubbleStyle(message.role)}>
                    {message.pending && !message.content ? (
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--foreground-muted)' }}>
                            <Loader2 size={14} className="animate-spin" />
                            {locale === 'zh' ? '正在思考…' : 'Thinking…'}
                        </div>
                    ) : isUser ? (
                        <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
                            {message.nodeRefs && message.nodeRefs.length > 0 && (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                                    {message.nodeRefs.map(ref => (
                                        <NodeRefChip
                                            key={ref.id}
                                            nodeId={ref.id}
                                            label={ref.label}
                                            kind={ref.kind}
                                            onClick={() => onNodeRefClick(ref.id)}
                                        />
                                    ))}
                                </div>
                            )}
                            {message.content}
                        </div>
                    ) : (
                        <div style={{ lineHeight: 1.65 }}>
                            <ChatMarkdown content={message.content} onNodeRefClick={onNodeRefClick} nodeMap={nodeMap} />
                        </div>
                    )}
                </div>
            </div>
            {isUser && <Avatar role="user" />}
        </div>
    );
}

function buildDiagnosticItems(execution: Execution, locale: string): DiagnosticItem[] {
    const original: DiagnosticItem[] = (execution.failures || []).map(failure => ({
        ...failure,
        diagnostic_kind: 'original',
        diagnostic_source: 'analysis',
    }));

    const toolErrorCount = execution.tool_call_error_count || 0;
    if (toolErrorCount > 0 && !isToolErrorCovered(original)) {
        original.push({
            failure_type: locale === 'zh' ? '工具调用错误' : 'Tool call error',
            description: locale === 'zh'
                ? `上传/采集阶段检测到 ${toolErrorCount} 次工具调用失败，但未生成更细的结构化 failure 记录。`
                : `The uploaded trace reported ${toolErrorCount} tool call error(s), but no detailed structured failure was generated.`,
            context: locale === 'zh'
                ? `tool_call_error_count=${toolErrorCount}`
                : `tool_call_error_count=${toolErrorCount}`,
            recovery: locale === 'zh'
                ? '建议打开完整执行链路查看失败工具的入参、输出和错误信息。'
                : 'Open the full trace to inspect the failed tool call input, output, and error details.',
            diagnostic_kind: 'original',
            diagnostic_source: 'ingest',
            synthetic: true,
        });
    }

    const deviations: DiagnosticItem[] = [];
    if (execution.is_answer_correct === false) {
        deviations.push({
            failure_type: locale === 'zh' ? '效果偏差' : 'Outcome deviation',
            description: locale === 'zh'
                ? '最终答案未通过评测或未设置评测数据，属于无明显执行报错但结果偏离预期的故障。'
                : 'The final answer failed evaluation, indicating an outcome deviation without a required runtime error.',
            context: execution.judgment_reason || (execution.answer_score == null ? '' : `score=${execution.answer_score}`),
            recovery: locale === 'zh'
                ? '建议结合评测理由、标准答案和 Skill 执行路径判断是 Skill 定义问题、路由问题还是回答生成问题。'
                : 'Review the evaluation reason, expected answer, and skill path to separate skill definition, routing, and generation issues.',
            diagnostic_kind: 'deviation',
            diagnostic_source: 'evaluation',
            synthetic: true,
        });
    }

    return [...original, ...deviations];
}

function isToolErrorCovered(items: DiagnosticItem[]): boolean {
    return items.some(item => {
        const text = normalizeSearchText([
            item.failure_type,
            item.description,
            item.context,
            item.step,
            item.trace_anchor?.kind,
        ].filter(Boolean).join(' '));
        return item.trace_anchor?.kind === 'tool' || /tool|工具|bash|command|exit code|stderr|非零/.test(text);
    });
}

function buildFaultPath(execution: Execution, interactions: RawInteraction[], locale: string, diagnosticItems?: DiagnosticItem[]): TraceNodeItem[] {
    const startTime = Date.parse(execution.timestamp);
    const nodes: TraceNodeItem[] = buildFaultPathSteps(interactions || [], locale).map(step => ({
        id: step.id,
        name: step.name,
        meta: step.meta,
        time: step.startedAt && Number.isFinite(startTime) ? `+${formatDuration(step.startedAt - startTime)}` : (step.stepIndex === 1 ? '+0ms' : '—'),
        status: step.status,
        step: step.stepIndex,
        kind: step.kind,
        depth: step.depth,
        rawText: step.rawText,
        rawInput: step.rawInput,
        rawOutput: step.rawOutput,
        startedAt: step.startedAt,
        completedAt: step.completedAt,
        durationMs: step.startedAt != null && step.completedAt != null ? step.completedAt - step.startedAt : undefined,
    }));

    if (nodes.length === 0) {
        nodes.push({
            id: 'system:missing-trace',
            name: locale === 'zh' ? '链路详情缺失' : 'Trace unavailable',
            meta: locale === 'zh' ? '未找到可还原的 interactions，使用评测结果兜底展示。' : 'No interactions were available; showing evaluation fallback.',
            status: 'skipped',
            kind: 'system',
            step: 1,
        });
    }
    annotateFaultNodes(nodes, execution, locale, diagnosticItems);
    return nodes;
}

function annotateFaultNodes(nodes: TraceNodeItem[], execution: Execution, locale: string, diagnosticItems?: DiagnosticItem[]) {
    const failures = (diagnosticItems || buildDiagnosticItems(execution, locale)).filter(item => item.diagnostic_kind === 'original');
    failures.forEach((failure, index) => {
        const ref = index + 1;
        const match = findBestFaultNode(nodes, failure);
        if (!match) return;
        match.node.status = 'error';
        match.node.faultRefs = [...(match.node.faultRefs || []), ref];
        match.node.matchReason = match.reason;
        match.node.tag = faultTag(failure, execution);
        match.node.detail = failure.description || failure.context || match.node.detail;
    });

    if (failures.length === 0 && (execution.tool_call_error_count || 0) > 0) {
        const node = [...nodes].reverse().find(n => n.kind === 'tool') || [...nodes].reverse().find(n => n.status !== 'skipped');
        if (node) {
            node.status = 'error';
            node.faultRefs = [1];
            node.matchReason = locale === 'zh' ? '根据工具错误计数定位到最近一次工具调用' : 'Matched to the latest tool call from tool error count';
            node.tag = 'TOOL_ERROR';
        }
    }
}

function findBestFaultNode(nodes: TraceNodeItem[], failure: Failure): { node: TraceNodeItem; reason: string } | null {
    const anchor = failure.trace_anchor;
    if (anchor?.step_id) {
        const node = nodes.find(n => n.id === anchor.step_id);
        if (node) {
            return {
                node,
                reason: anchor.evidence || `后端锚定：${anchor.match_method}，置信度 ${Math.round(anchor.confidence * 100)}%`,
            };
        }
    }
    if (failure.anchor_step_id) {
        const node = nodes.find(n => n.id === failure.anchor_step_id);
        if (node) return { node, reason: '来自后端分析的候选步骤 ID' };
    }
    if (anchor?.step_index) {
        const node = nodes.find(n => n.step === anchor.step_index);
        if (node) return { node, reason: anchor.evidence || '来自后端分析的步骤编号' };
    }

    const text = normalizeSearchText([failure.failure_type, failure.description, failure.context, failure.recovery, failure.step].filter(Boolean).join(' '));
    const isOldInferenceStep = /推理判断|时间窗口匹配/i.test(failure.step || '');
    const stepMatch = !isOldInferenceStep ? String(failure.step || '').match(/第\s*(\d+)\s*步/i) : null;
    if (stepMatch) {
        const idx = Number(stepMatch[1]) - 1;
        if (nodes[idx]) return { node: nodes[idx], reason: '来自故障记录的步骤编号' };
    }

    const scored = nodes.map(node => {
        let score = 0;
        const raw = normalizeSearchText(node.rawText || `${node.name} ${node.meta}`);
        for (const token of tokenizeFaultText(text)) {
            if (raw.includes(token)) score += token.length > 4 ? 2 : 1;
        }
        if (/401|authentication|unauthori[sz]ed|api[_\s-]?key|认证|鉴权|权限/.test(text) && node.kind === 'llm') score += 8;
        if (/tool|工具|bash|command|exit code|stderr|非零/.test(text) && node.kind === 'tool') score += 7;
        if (/skill|技能|SKILL\.md/i.test(text) && node.kind === 'skill') score += 7;
        if (/timeout|超时|卡住/.test(text)) score += 3;
        return { node, score };
    }).sort((a, b) => b.score - a.score);

    if (scored[0]?.score > 0) {
        return { node: scored[0].node, reason: scored[0].score >= 7 ? '根据错误内容和节点类型匹配' : '根据错误上下文文本匹配' };
    }

    const lastMeaningful = [...nodes].reverse().find(n => n.kind === 'llm' || n.kind === 'tool' || n.kind === 'skill')
        || [...nodes].reverse().find(n => n.status !== 'skipped');
    if (lastMeaningful) {
        return { node: lastMeaningful, reason: '未找到精确锚点，回退到最后一个已执行关键节点' };
    }
    return null;
}

function faultTag(failure: Failure, execution: Execution): string {
    const text = normalizeSearchText([failure.failure_type, failure.description, failure.context].filter(Boolean).join(' '));
    if (/401|authentication|unauthori[sz]ed|api[_\s-]?key|认证|鉴权/.test(text)) return 'CHAIN_ERROR · 401';
    if (/timeout|超时/.test(text)) return 'TIMEOUT';
    if (/permission|权限|denied/.test(text)) return 'PERMISSION';
    if (/tool|工具|exit code|stderr|非零/.test(text) || (execution.tool_call_error_count || 0) > 0) return 'TOOL_ERROR';
    return 'CHAIN_ERROR';
}

function summarizeFaultPath(nodes: TraceNodeItem[], execution: Execution) {
    const faultNodeCount = nodes.filter(n => n.status === 'error').length;
    const hasFault = faultNodeCount > 0 || (execution.failures?.length || 0) > 0 || (execution.tool_call_error_count || 0) > 0;
    const firstFault = nodes.find(n => n.status === 'error');
    return {
        hasFault,
        faultNodeCount,
        executed: nodes.filter(n => n.status !== 'skipped').length,
        statusLabel: hasFault
            ? (firstFault ? `CHAIN_ERROR · L${firstFault.step}` : 'CHAIN_ERROR')
            : 'OK',
    };
}

function normalizeSearchText(value: string): string {
    return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenizeFaultText(value: string): string[] {
    return Array.from(new Set(value.split(/[^a-z0-9_\-.]+/i).map(s => s.trim().toLowerCase()).filter(s => s.length >= 3))).slice(0, 12);
}

function fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
}

const KIND_BADGE: Record<string, { label: string; color: string; bg: string }> = {
    llm:    { label: 'LLM',   color: '#7c3aed',                                    bg: 'rgba(124,58,237,0.10)' },
    tool:   { label: 'TOOL',  color: '#2563eb',                                    bg: 'rgba(37,99,235,0.10)' },
    skill:  { label: 'SKILL', color: '#15a572',                                    bg: 'rgba(21,165,114,0.10)' },
    agent:  { label: 'AGENT', color: 'var(--primary,#6356e6)',                      bg: 'rgba(99,86,230,0.10)' },
    task:   { label: 'TASK',  color: '#0891b2',                                    bg: 'rgba(8,145,178,0.10)' },
    flow:   { label: 'FLOW',  color: '#d97706',                                    bg: 'rgba(217,119,6,0.10)' },
    system: { label: 'SYS',   color: 'var(--foreground-muted,#9da1ac)',            bg: 'var(--background-secondary)' },
};

function flatToTree(nodes: TraceNodeItem[]): { roots: TreeTraceNode[]; nodeMap: Map<string, TreeTraceNode> } {
    const roots: TreeTraceNode[] = [];
    const nodeMap = new Map<string, TreeTraceNode>();
    const stack: Array<TreeTraceNode | undefined> = [];
    for (const node of nodes) {
        const depth = node.depth ?? 0;
        const treeNode: TreeTraceNode = { ...node, children: [], parentId: undefined };
        nodeMap.set(node.id, treeNode);
        stack.length = depth;
        if (depth === 0) {
            roots.push(treeNode);
        } else {
            const parent = stack[depth - 1];
            if (parent) {
                parent.children.push(treeNode);
                treeNode.parentId = parent.id;
            } else {
                roots.push(treeNode);
            }
        }
        stack[depth] = treeNode;
    }
    return { roots, nodeMap };
}

/* ── Session header stat cell ── */
function SessionStat({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
    return (
        <div style={{ padding: '0 14px', borderLeft: '1px solid var(--border)', textAlign: 'center', flexShrink: 0 }}>
            <div style={{ fontSize: 9.5, color: 'var(--foreground-muted)', fontWeight: 700, letterSpacing: '.10em', textTransform: 'uppercase', marginBottom: 3 }}>{label}</div>
            <div style={{ fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-mono)', letterSpacing: '-0.02em', color: valueColor || 'var(--foreground)', lineHeight: 1 }}>{value}</div>
        </div>
    );
}

/* ── Clickable node reference chip (used in composer + messages) ── */
function NodeRefChip({
    nodeId, label, kind, onClick, onRemove,
}: { nodeId: string; label: string; kind?: string; onClick?: () => void; onRemove?: () => void }) {
    const badge = KIND_BADGE[kind || ''];
    return (
        <span
            onClick={onClick}
            style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                background: 'var(--card-bg,#fff)',
                border: '1px solid rgba(99,86,230,0.35)',
                padding: '2px 6px 2px 3px', borderRadius: 6,
                fontSize: 11.5, color: 'var(--foreground)', fontWeight: 500,
                cursor: onClick ? 'pointer' : 'default',
                verticalAlign: 'middle', lineHeight: 1.3,
                transition: 'all 0.15s',
            }}
        >
            <span style={{ width: 16, height: 16, borderRadius: 4, background: 'var(--primary,#6356e6)', color: 'white', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                <AtSign size={9} />
            </span>
            {badge && (
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, color: badge.color, paddingRight: 5, borderRight: '1px solid rgba(99,86,230,0.2)', lineHeight: 1 }}>
                    {badge.label}
                </span>
            )}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>{label}</span>
            {onRemove && (
                <button onClick={e => { e.stopPropagation(); onRemove(); }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 1, color: 'var(--foreground-muted)', display: 'flex', alignItems: 'center', marginLeft: 1 }}>
                    <X size={10} />
                </button>
            )}
        </span>
    );
}

/* ── Parse token counts from meta string, e.g. "req 38000 tok · out 4500 tok" ── */
function parseTokensFromMeta(meta: string): { req?: number; out?: number } {
    const reqM = meta.match(/req\s+([\d,]+)\s*tok/i);
    const outM = meta.match(/out\s+([\d,]+)\s*tok/i);
    return {
        req: reqM ? parseInt(reqM[1].replace(/,/g, ''), 10) : undefined,
        out: outM ? parseInt(outM[1].replace(/,/g, ''), 10) : undefined,
    };
}

function fmtDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/* ── Node detail modal ── */
function NodeDetailModal({ node, onClose, locale }: { node: TreeTraceNode; onClose: () => void; locale: string }) {
    const badge = KIND_BADGE[node.kind || ''];
    const statusColor = node.status === 'error' ? 'var(--error,#dc2626)'
        : node.status === 'ok' ? 'var(--success,#15a572)'
        : node.status === 'running' ? 'var(--primary,#6356e6)'
        : 'var(--foreground-muted,#9da1ac)';
    const statusLabel = node.status === 'error' ? (locale === 'zh' ? '错误' : 'Error')
        : node.status === 'ok' ? (locale === 'zh' ? '成功' : 'OK')
        : node.status === 'skipped' ? (locale === 'zh' ? '未执行' : 'Skipped')
        : (locale === 'zh' ? '运行中' : 'Running');
    const tokens = parseTokensFromMeta(node.meta || '');
    const totalTok = (tokens.req || 0) + (tokens.out || 0);

    return (
        <div
            style={{ position: 'fixed', inset: 0, zIndex: 900, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onClick={onClose}
        >
            {/* Backdrop */}
            <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.32)', backdropFilter: 'blur(2px)' }} />
            {/* Panel */}
            <div
                style={{
                    position: 'relative', zIndex: 1, width: 540, maxWidth: 'calc(100vw - 40px)',
                    maxHeight: 'calc(100vh - 80px)', overflow: 'auto',
                    background: 'var(--card-bg,#fff)', borderRadius: 14,
                    boxShadow: '0 20px 60px rgba(0,0,0,0.22)', border: '1px solid var(--border)',
                    padding: '20px 22px',
                }}
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 14 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                            {badge && (
                                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: badge.bg, color: badge.color, letterSpacing: '0.04em' }}>
                                    {badge.label}
                                </span>
                            )}
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: statusColor, padding: '2px 7px', borderRadius: 99, background: `color-mix(in srgb, ${statusColor} 12%, transparent)` }}>
                                <span style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor, display: 'inline-block' }} />
                                {statusLabel}
                            </span>
                            {node.faultRefs && node.faultRefs.length > 0 && (
                                <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 99, background: 'var(--error,#dc2626)', color: '#fff' }}>
                                    ⚠ #{node.faultRefs.join(', #')}
                                </span>
                            )}
                        </div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--foreground)', lineHeight: 1.3 }}>{node.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--foreground-muted)', marginTop: 3, fontFamily: 'var(--font-mono)' }}>{node.id}</div>
                    </div>
                    <button
                        onClick={onClose}
                        style={{ background: 'var(--background-secondary)', border: '1px solid var(--border)', borderRadius: 6, width: 28, height: 28, display: 'grid', placeItems: 'center', cursor: 'pointer', color: 'var(--foreground-muted)', flexShrink: 0 }}
                    >
                        <X size={14} />
                    </button>
                </div>

                {/* Stats row */}
                <div style={{ display: 'flex', gap: 0, marginBottom: 16, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)', background: 'var(--background-secondary)' }}>
                    {node.durationMs != null && (
                        <div style={{ flex: 1, padding: '8px 12px', borderRight: '1px solid var(--border)' }}>
                            <div style={{ fontSize: 10, color: 'var(--foreground-muted)', marginBottom: 2, fontWeight: 600, letterSpacing: '0.05em' }}>{locale === 'zh' ? '耗时' : 'DURATION'}</div>
                            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--foreground)', fontFamily: 'var(--font-mono)' }}>{fmtDuration(node.durationMs)}</div>
                        </div>
                    )}
                    {totalTok > 0 && (
                        <div style={{ flex: 1, padding: '8px 12px', borderRight: node.time ? '1px solid var(--border)' : undefined }}>
                            <div style={{ fontSize: 10, color: 'var(--foreground-muted)', marginBottom: 2, fontWeight: 600, letterSpacing: '0.05em' }}>TOKENS</div>
                            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--foreground)', fontFamily: 'var(--font-mono)' }}>{fmtTokens(totalTok)}</div>
                        </div>
                    )}
                    {tokens.req != null && tokens.req > 0 && (
                        <div style={{ flex: 1, padding: '8px 12px', borderRight: tokens.out ? '1px solid var(--border)' : undefined }}>
                            <div style={{ fontSize: 10, color: 'var(--foreground-muted)', marginBottom: 2, fontWeight: 600, letterSpacing: '0.05em' }}>IN</div>
                            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--foreground)', fontFamily: 'var(--font-mono)' }}>{fmtTokens(tokens.req)}</div>
                        </div>
                    )}
                    {tokens.out != null && tokens.out > 0 && (
                        <div style={{ flex: 1, padding: '8px 12px' }}>
                            <div style={{ fontSize: 10, color: 'var(--foreground-muted)', marginBottom: 2, fontWeight: 600, letterSpacing: '0.05em' }}>OUT</div>
                            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--foreground)', fontFamily: 'var(--font-mono)' }}>{fmtTokens(tokens.out)}</div>
                        </div>
                    )}
                    {node.time && node.durationMs == null && (
                        <div style={{ flex: 1, padding: '8px 12px' }}>
                            <div style={{ fontSize: 10, color: 'var(--foreground-muted)', marginBottom: 2, fontWeight: 600, letterSpacing: '0.05em' }}>{locale === 'zh' ? '时间偏移' : 'OFFSET'}</div>
                            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--foreground)', fontFamily: 'var(--font-mono)' }}>{node.time}</div>
                        </div>
                    )}
                </div>

                {/* Error detail */}
                {node.status === 'error' && node.detail && (
                    <div style={{ marginBottom: 14, padding: '10px 12px', borderRadius: 8, background: 'var(--error-subtle,rgba(220,38,38,0.06))', border: '1px solid var(--error-subtle-border,rgba(220,38,38,0.2))' }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--error)', marginBottom: 5, letterSpacing: '0.05em' }}>{locale === 'zh' ? '故障详情' : 'FAULT DETAIL'}</div>
                        <div style={{ fontSize: 12, color: 'var(--error)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{node.detail}</div>
                    </div>
                )}

                {/* Match reason */}
                {node.matchReason && (
                    <div style={{ marginBottom: 14, padding: '8px 12px', borderRadius: 8, background: 'rgba(217,119,6,0.06)', border: '1px solid rgba(217,119,6,0.2)' }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: '#d97706', marginBottom: 4, letterSpacing: '0.05em' }}>{locale === 'zh' ? '定位依据' : 'MATCH REASON'}</div>
                        <div style={{ fontSize: 12, color: 'var(--foreground)', lineHeight: 1.5 }}>{node.matchReason}</div>
                    </div>
                )}

                {/* Meta */}
                {node.meta && (
                    <div style={{ marginBottom: 14 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--foreground-muted)', marginBottom: 6, letterSpacing: '0.05em' }}>{locale === 'zh' ? '节点元数据' : 'METADATA'}</div>
                        <div style={{ fontSize: 12, color: 'var(--foreground-secondary,#4b5563)', lineHeight: 1.6, padding: '8px 10px', background: 'var(--background-secondary)', borderRadius: 6, fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{node.meta}</div>
                    </div>
                )}

                {/* Input */}
                {node.rawInput && node.rawInput.length > 0 && (
                    <div style={{ marginBottom: 14 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--foreground-muted)', marginBottom: 6, letterSpacing: '0.05em' }}>INPUT</div>
                        <div style={{ fontSize: 11.5, color: 'var(--foreground-secondary)', lineHeight: 1.6, padding: '8px 10px', background: 'var(--background-secondary)', borderRadius: 6, maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                            {node.rawInput}
                        </div>
                    </div>
                )}

                {/* Output */}
                {node.rawOutput && node.rawOutput.length > 0 && (
                    <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--foreground-muted)', marginBottom: 6, letterSpacing: '0.05em' }}>OUTPUT</div>
                        <div style={{ fontSize: 11.5, color: 'var(--foreground-secondary)', lineHeight: 1.6, padding: '8px 10px', background: 'var(--background-secondary)', borderRadius: 6, maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                            {node.rawOutput}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

/* ── Recursive tree node row ── */
const TREE_INDENT = 14;
const GUIDE_LEFT  = 4;

function TreeNodeRow({
    node, ancestors, isLast,
    collapsedNodes, onToggleCollapse, onQuoteNode, onFaultSelect, onNodeClick,
    highlightNodeId, traceNodeEls, traceSearch, locale, maxDurationMs,
}: {
    node: TreeTraceNode;
    ancestors: boolean[];
    isLast: boolean;
    collapsedNodes: Set<string>;
    onToggleCollapse: (id: string) => void;
    onQuoteNode: (n: TraceNodeItem) => void;
    onFaultSelect: (ref: number) => void;
    onNodeClick: (n: TreeTraceNode) => void;
    highlightNodeId: string | null;
    traceNodeEls: React.MutableRefObject<Map<string, HTMLDivElement>>;
    traceSearch: string;
    locale: string;
    maxDurationMs: number;
}) {
    const [hovered, setHovered] = useState(false);
    const isCollapsed = collapsedNodes.has(node.id);
    const hasChildren = node.children.length > 0;
    const isHighlighted = node.id === highlightNodeId;
    const depth = node.depth ?? 0;

    const matchesSearch = !traceSearch || node.name.toLowerCase().includes(traceSearch) || (node.meta || '').toLowerCase().includes(traceSearch);
    const hasMatchingDescendant = (n: TreeTraceNode): boolean =>
        n.children.some(c => c.name.toLowerCase().includes(traceSearch) || (c.meta || '').toLowerCase().includes(traceSearch) || hasMatchingDescendant(c));
    if (traceSearch && !matchesSearch && !hasMatchingDescendant(node)) return null;

    const statusColor = node.status === 'error' ? 'var(--error,#dc2626)'
        : node.status === 'ok' ? 'var(--success,#15a572)'
        : node.status === 'running' ? 'var(--primary,#6356e6)'
        : 'var(--foreground-muted,#9da1ac)';
    const statusGlow = node.status === 'error' ? 'rgba(220,38,38,0.18)'
        : node.status === 'ok' ? 'rgba(21,165,114,0.18)'
        : node.status === 'running' ? 'rgba(99,86,230,0.18)'
        : 'transparent';
    const badge = KIND_BADGE[node.kind || ''];

    const tokens = parseTokensFromMeta(node.meta || '');
    const totalTok = (tokens.req || 0) + (tokens.out || 0);

    // For nodes whose name is a generic type phrase, derive a better label from meta.
    // e.g. "LLM 模型调用 DeepSeek" → "LLM DeepSeek"
    const GENERIC_NAMES = ['模型调用', 'Model call', '工具调用', 'Tool call', '调度子任务', 'Subtask execution',
        '子任务执行', '执行 Skill', 'Run skill', '控制器路由', 'Controller routing', '用户输入', 'User input'];
    const isGeneric = badge != null && GENERIC_NAMES.some(g => node.name === g);

    const metaSegs = (node.meta || '').split(/\s*·\s*/);
    const firstSeg = metaSegs[0]?.trim() ?? '';
    // Only use firstSeg as label if it's a name-like string (not a token count / pure number)
    const primaryMeta = firstSeg && !/^(req|out)\s|\d{4,}/.test(firstSeg)
        ? (firstSeg.length > 32 ? `${firstSeg.slice(0, 32)}…` : firstSeg)
        : '';

    const displayLabel = isGeneric && primaryMeta ? primaryMeta : node.name;

    // Inline meta: when primaryMeta is used as the label, show the remaining segments (minus tokens)
    const metaShort = (() => {
        const segsToUse = isGeneric && primaryMeta ? metaSegs.slice(1) : metaSegs;
        const joined = segsToUse.join(' · ')
            .replace(/\breq\s+[\d,]+\s*tok\b/gi, '')
            .replace(/\bout\s+[\d,]+\s*tok\b/gi, '')
            .replace(/\s*·\s*·\s*/g, ' · ')
            .replace(/^\s*·\s*|\s*·\s*$/g, '')
            .trim();
        return joined.length > 40 ? `${joined.slice(0, 40)}…` : joined;
    })();

    return (
        <div>
            <div
                ref={el => { if (el) traceNodeEls.current.set(node.id, el); else traceNodeEls.current.delete(node.id); }}
                style={{ position: 'relative' }}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
            >
                {/* Ancestor guide lines */}
                {ancestors.map((hasMore, i) =>
                    hasMore ? (
                        <div key={i} style={{ position: 'absolute', left: i * TREE_INDENT + GUIDE_LEFT + 4, top: 0, bottom: 0, width: 1, background: 'var(--border)', pointerEvents: 'none' }} />
                    ) : null
                )}
                {/* Connector from direct parent */}
                {depth > 0 && <>
                    <div style={{ position: 'absolute', left: (depth - 1) * TREE_INDENT + GUIDE_LEFT + 4, top: 0, height: isLast ? '50%' : '100%', width: 1, background: 'var(--border)', pointerEvents: 'none' }} />
                    <div style={{ position: 'absolute', left: (depth - 1) * TREE_INDENT + GUIDE_LEFT + 4, top: '50%', width: TREE_INDENT - GUIDE_LEFT - 2, height: 1, background: 'var(--border)', pointerEvents: 'none', marginTop: -0.5 }} />
                </>}

                {/* Row card */}
                <div
                    style={{
                        margin: '1px 4px', borderRadius: 6,
                        background: isHighlighted ? 'rgba(99,86,230,0.08)' : hovered ? 'var(--background-secondary)' : 'transparent',
                        border: `1px solid ${isHighlighted ? 'rgba(99,86,230,0.28)' : node.status === 'error' ? 'rgba(220,38,38,0.18)' : 'transparent'}`,
                        transition: 'background 0.12s, border-color 0.12s',
                        cursor: 'pointer',
                        overflow: 'hidden',
                    }}
                    onClick={() => { onNodeClick(node); }}
                >
                    {/* Single compact row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, paddingLeft: depth * TREE_INDENT + 4, paddingRight: 8, paddingTop: 4, paddingBottom: 4 }}>
                        {/* Chevron */}
                        <div
                            style={{ width: 14, height: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--foreground-muted)', flexShrink: 0 }}
                            onClick={e => { e.stopPropagation(); if (hasChildren) onToggleCollapse(node.id); }}
                        >
                            {hasChildren ? (isCollapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />) : null}
                        </div>
                        {/* Status dot */}
                        <div style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor, boxShadow: `0 0 0 2px ${statusGlow}`, flexShrink: 0 }} />
                        {/* Type badge */}
                        {badge && (
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, padding: '1px 4px', borderRadius: 3, background: badge.bg, color: badge.color, flexShrink: 0, letterSpacing: '0.02em' }}>
                                {badge.label}
                            </span>
                        )}
                        {/* Label + inline meta */}
                        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                            <span style={{ fontSize: 11.5, fontWeight: isHighlighted ? 600 : 500, color: node.status === 'error' ? 'var(--error)' : 'var(--foreground)' }}>
                                {displayLabel}
                            </span>
                            {metaShort && (
                                <span style={{ fontSize: 10, color: 'var(--foreground-muted)', fontFamily: 'var(--font-mono)', marginLeft: 5 }}>
                                    {metaShort}
                                </span>
                            )}
                        </div>
                        {/* Fault warn */}
                        {node.faultRefs && node.faultRefs.length > 0 && (
                            <span style={{ fontSize: 11, color: 'var(--warning,#d97706)', flexShrink: 0 }} title={node.tag || ''}>⚠</span>
                        )}
                        {/* Token count */}
                        {totalTok > 0 && (
                            <span style={{ fontSize: 9.5, color: 'var(--foreground-muted)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>{fmtTokens(totalTok)}</span>
                        )}
                        {/* Duration */}
                        {node.durationMs != null ? (
                            <span style={{ fontSize: 9.5, color: 'var(--foreground-muted)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>{fmtDuration(node.durationMs)}</span>
                        ) : node.time ? (
                            <span style={{ fontSize: 9.5, color: 'var(--foreground-muted)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>{node.time}</span>
                        ) : null}
                        {/* Quote button */}
                        <button
                            onClick={e => { e.stopPropagation(); onQuoteNode(node); }}
                            title={locale === 'zh' ? '引用此节点' : 'Quote node'}
                            style={{
                                width: 18, height: 18, borderRadius: 4, flexShrink: 0,
                                background: hovered ? 'var(--card-bg,#fff)' : 'transparent',
                                border: `1px solid ${hovered ? 'var(--border)' : 'transparent'}`,
                                color: 'var(--foreground-muted)', display: 'grid', placeItems: 'center', cursor: 'pointer',
                                opacity: hovered ? 1 : 0, transition: 'opacity 0.15s',
                            }}
                        >
                            <AtSign size={9} />
                        </button>
                    </div>
                </div>
            </div>

            {/* Children */}
            {!isCollapsed && hasChildren && node.children.map((child, idx) => (
                <TreeNodeRow
                    key={child.id}
                    node={child}
                    ancestors={[...ancestors, !isLast]}
                    isLast={idx === node.children.length - 1}
                    collapsedNodes={collapsedNodes}
                    onToggleCollapse={onToggleCollapse}
                    onQuoteNode={onQuoteNode}
                    onFaultSelect={onFaultSelect}
                    onNodeClick={onNodeClick}
                    highlightNodeId={highlightNodeId}
                    traceNodeEls={traceNodeEls}
                    traceSearch={traceSearch}
                    locale={locale}
                    maxDurationMs={maxDurationMs}
                />
            ))}
        </div>
    );
}

/* ── ChatMarkdown: render AI markdown + @[id:label] node-ref chips ── */

function preprocessNodeRefs(content: string): string {
    return content.replace(/@\[([^\]]+)\]/g, (match, inner) => {
        const lastColon = inner.lastIndexOf(':');
        if (lastColon === -1) return match;
        const nodeId = inner.slice(0, lastColon);
        const label = inner.slice(lastColon + 1);
        if (!nodeId || !label) return match;
        return `[${label}](NODEREF:${encodeURIComponent(nodeId)})`;
    });
}

function ChatMarkdown({ content, onNodeRefClick, nodeMap }: {
    content: string;
    onNodeRefClick: (id: string) => void;
    nodeMap?: Map<string, TreeTraceNode>;
}) {
    const processed = preprocessNodeRefs(content);
    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
                p: ({ children }) => <p style={{ margin: '0 0 0.55em', lineHeight: 1.7 }}>{children}</p>,
                h1: ({ children }) => <h1 style={{ fontSize: '1.15em', fontWeight: 700, margin: '0.9em 0 0.3em', lineHeight: 1.35 }}>{children}</h1>,
                h2: ({ children }) => <h2 style={{ fontSize: '1.05em', fontWeight: 700, margin: '0.75em 0 0.3em', lineHeight: 1.35 }}>{children}</h2>,
                h3: ({ children }) => <h3 style={{ fontSize: '1em', fontWeight: 700, margin: '0.65em 0 0.25em', lineHeight: 1.35 }}>{children}</h3>,
                ul: ({ children }) => <ul style={{ margin: '0.25em 0 0.5em 1.35em', padding: 0, lineHeight: 1.65 }}>{children}</ul>,
                ol: ({ children }) => <ol style={{ margin: '0.25em 0 0.5em 1.35em', padding: 0, lineHeight: 1.65 }}>{children}</ol>,
                li: ({ children }) => <li style={{ marginBottom: '0.1em' }}>{children}</li>,
                strong: ({ children }) => <strong style={{ fontWeight: 600 }}>{children}</strong>,
                em: ({ children }) => <em style={{ fontStyle: 'italic' }}>{children}</em>,
                blockquote: ({ children }) => <blockquote style={{ margin: '0.35em 0', padding: '3px 10px', borderLeft: '3px solid var(--border)', color: 'var(--foreground-secondary)', fontStyle: 'italic' }}>{children}</blockquote>,
                hr: () => <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '0.6em 0' }} />,
                a({ href, children }) {
                    if (href?.startsWith('NODEREF:')) {
                        const nodeId = decodeURIComponent(href.slice(8));
                        const node = nodeMap?.get(nodeId);
                        const label = node?.name || String(children);
                        const kind = node?.kind as string | undefined;
                        return <NodeRefChip nodeId={nodeId} label={label} kind={kind} onClick={() => onNodeRefClick(nodeId)} />;
                    }
                    return <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary)', textDecoration: 'underline' }}>{children}</a>;
                },
                table: ({ children }) => <table style={{ borderCollapse: 'collapse', width: '100%', margin: '0.35em 0', fontSize: '12px' }}>{children}</table>,
                th: ({ children }) => <th style={{ border: '1px solid var(--border)', padding: '4px 8px', background: 'var(--background-secondary)', fontWeight: 600, textAlign: 'left' }}>{children}</th>,
                td: ({ children }) => <td style={{ border: '1px solid var(--border)', padding: '4px 8px' }}>{children}</td>,
                code({ children, className }) {
                    const match = /language-(\w+)/.exec(className || '');
                    const codeText = String(children).replace(/\n$/, '');
                    if (!codeText.includes('\n') && !match) {
                        return <code style={{ background: 'rgba(175,184,193,0.18)', padding: '0.15em 0.38em', borderRadius: 3, fontFamily: 'var(--font-mono,monospace)', fontSize: '0.88em' }}>{children}</code>;
                    }
                    return (
                        <pre style={{ background: 'var(--background-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px', overflow: 'auto', margin: '0.4em 0', fontFamily: 'var(--font-mono,monospace)', fontSize: '11.5px', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            <code style={{ fontFamily: 'inherit', fontSize: 'inherit' }}>{codeText}</code>
                        </pre>
                    );
                },
            }}
        >
            {processed}
        </ReactMarkdown>
    );
}

function classifyFaultKinds(execution: Execution): FaultKind[] {
    const kinds: FaultKind[] = [];
    if ((execution.failures?.length || 0) > 0 || (execution.tool_call_error_count || 0) > 0) {
        kinds.push('original');
    }
    if (execution.is_answer_correct === false) {
        kinds.push('deviation');
    }
    return kinds;
}

function buildExecutionBrief(execution: Execution) {
    return {
        task_id: execution.task_id,
        upload_id: execution.upload_id,
        framework: execution.framework,
        agent: execution.agentName || execution.agent,
        query: execution.query,
        final_result: truncateText(execution.final_result || '', 4000),
        is_answer_correct: execution.is_answer_correct,
        answer_score: execution.answer_score,
        judgment_reason: execution.judgment_reason,
        failures: execution.failures || [],
        skill_issues: execution.skill_issues || [],
        skills: execution.invoked_skills || execution.skills || execution.skill,
        outcome_evaluation: execution.outcome_evaluation,
        routing_evaluation: execution.routing_evaluation,
        metrics: {
            latency: execution.latency,
            tokens: execution.tokens,
            tool_call_count: execution.tool_call_count,
            tool_call_error_count: execution.tool_call_error_count,
            llm_call_count: execution.llm_call_count,
            input_tokens: execution.input_tokens,
            output_tokens: execution.output_tokens,
        },
    };
}

async function consumeSse(response: Response, handlers: { text?: (data: any) => void; done?: (data: any) => void; error?: (data: any) => void }) {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() || '';
        for (const chunk of chunks) {
            const eventLine = chunk.split('\n').find(line => line.startsWith('event:'));
            const dataLine = chunk.split('\n').find(line => line.startsWith('data:'));
            if (!eventLine || !dataLine) continue;
            const event = eventLine.replace(/^event:\s*/, '').trim();
            let data: any = null;
            try {
                data = JSON.parse(dataLine.replace(/^data:\s*/, ''));
            } catch {
                data = {};
            }
            if (event === 'text') handlers.text?.(data);
            if (event === 'done') handlers.done?.(data);
            if (event === 'error') handlers.error?.(data);
        }
    }
}

function FaultKindBadge({ kind, locale }: { kind: FaultKind; locale: string }) {
    const isDeviation = kind === 'deviation';
    return (
        <span
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '3px 8px',
                borderRadius: 999,
                fontSize: 10.5,
                fontWeight: 650,
                background: isDeviation ? 'var(--primary-subtle)' : 'var(--error-subtle)',
                color: isDeviation ? 'var(--primary)' : 'var(--error)',
                border: `1px solid ${isDeviation ? 'var(--primary-subtle-border)' : 'var(--error-subtle-border)'}`,
            }}
        >
            <span style={{ width: 6, height: 6, borderRadius: 999, background: 'currentColor' }} />
            {isDeviation
                ? (locale === 'zh' ? '效果偏差类故障' : 'Deviation fault')
                : (locale === 'zh' ? '原始错误类故障' : 'Original error')}
        </span>
    );
}

function FaultFilterPill({ label, count, active }: { label: string; count?: number; active?: boolean }) {
    return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 9px', borderRadius: 999, fontSize: 11, background: active ? 'var(--primary-subtle)' : 'var(--background-secondary)', color: active ? 'var(--primary)' : 'var(--foreground-secondary)', border: `1px solid ${active ? 'var(--primary-subtle-border)' : 'var(--border)'}` }}>
            {label}
            {typeof count === 'number' && <b style={{ fontWeight: 700 }}>{count}</b>}
        </span>
    );
}

function MiniMetric({ label, value, tone = 'normal' }: { label: string; value: string; tone?: 'normal' | 'danger' }) {
    return (
        <div style={{ padding: '8px 9px', borderRadius: 8, background: tone === 'danger' ? 'var(--error-subtle)' : 'var(--background-secondary)', border: `1px solid ${tone === 'danger' ? 'var(--error-subtle-border)' : 'var(--border)'}` }}>
            <div style={{ fontSize: 10, color: 'var(--foreground-muted)' }}>{label}</div>
            <div style={{ marginTop: 2, fontSize: 13, fontWeight: 700, color: tone === 'danger' ? 'var(--error)' : 'var(--foreground)' }}>{value}</div>
        </div>
    );
}

function InlineFact({ label, value }: { label: string; value: string }) {
    return (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '7px 8px', background: 'var(--background-secondary)' }}>
            <div style={{ fontSize: 10, color: 'var(--foreground-muted)' }}>{label}</div>
            <div style={{ marginTop: 2, fontSize: 12, fontWeight: 700, color: 'var(--foreground)' }}>{value}</div>
        </div>
    );
}

function Avatar({ role }: { role: 'assistant' | 'user' }) {
    const isUser = role === 'user';
    return (
        <div style={{ width: 26, height: 26, borderRadius: 8, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: isUser ? 'var(--foreground)' : 'var(--primary)', color: 'white', marginTop: 18 }}>
            {isUser ? <UserRound size={14} /> : <Bot size={14} />}
        </div>
    );
}

function MessageMeta({ label, align = 'left' }: { label: string; align?: 'left' | 'right' }) {
    return (
        <div style={{ marginBottom: 5, fontSize: 10.5, color: 'var(--foreground-muted)', textAlign: align }}>
            {label}
        </div>
    );
}

function StatCard({ label, value, sub, accent, truncate }: { label: string; value: string; sub?: string; accent?: 'warning' | 'error'; truncate?: boolean }) {
    const color = accent === 'error' ? 'var(--error)' : accent === 'warning' ? 'var(--warning)' : 'var(--foreground)';
    return (
        <div className="ai-stat">
            <div className="ai-stat-lbl">{label}</div>
            <div className="ai-stat-val" style={{ color, overflow: truncate ? 'hidden' : undefined, textOverflow: truncate ? 'ellipsis' : undefined, whiteSpace: truncate ? 'nowrap' : undefined }}>
                {value}
            </div>
            {sub && <div className="ai-stat-d" style={{ color: 'var(--foreground-muted)' }}>{sub}</div>}
        </div>
    );
}

function FilterChip({
    label, active, value, onChange, children,
}: {
    label: string;
    active: boolean;
    value: string;
    onChange: (v: string) => void;
    children: React.ReactNode;
}) {
    return (
        <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            borderRadius: 6,
            border: `1px solid ${active ? 'var(--primary-subtle-border, rgba(59,130,246,0.35))' : 'var(--border)'}`,
            background: active ? 'var(--primary-subtle, rgba(59,130,246,0.06))' : 'var(--card-bg)',
            overflow: 'hidden',
            height: 28,
            transition: 'border-color .15s, background .15s',
        }}>
            <span style={{
                padding: '0 7px 0 9px',
                fontSize: 10.5,
                fontWeight: 600,
                color: active ? 'var(--primary, #3b82f6)' : 'var(--foreground-muted)',
                whiteSpace: 'nowrap',
                userSelect: 'none',
                borderRight: `1px solid ${active ? 'var(--primary-subtle-border, rgba(59,130,246,0.25))' : 'var(--border)'}`,
                lineHeight: '26px',
            }}>
                {label}
            </span>
            <select
                value={value}
                onChange={e => onChange(e.target.value)}
                style={{
                    height: '100%',
                    border: 'none',
                    outline: 'none',
                    background: 'transparent',
                    fontSize: 11,
                    color: active ? 'var(--primary, #3b82f6)' : 'var(--foreground)',
                    fontWeight: active ? 600 : 400,
                    padding: '0 20px 0 7px',
                    cursor: 'pointer',
                    appearance: 'none',
                    WebkitAppearance: 'none',
                    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M2 3.5l3 3 3-3' stroke='%23999' stroke-width='1.4' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
                    backgroundRepeat: 'no-repeat',
                    backgroundPosition: 'right 5px center',
                    minWidth: 52,
                }}
            >
                {children}
            </select>
        </div>
    );
}

function FilterDivider() {
    return (
        <div style={{
            width: 1,
            height: 18,
            background: 'var(--border)',
            margin: '0 6px',
            flexShrink: 0,
        }} />
    );
}

function ActiveFilterTag({ label, onRemove }: { label: string; onRemove: () => void }) {
    return (
        <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 8px',
            fontSize: 11,
            borderRadius: 4,
            background: 'var(--primary-subtle, rgba(59,130,246,0.08))',
            border: '1px solid var(--primary-subtle-border, rgba(59,130,246,0.2))',
            color: 'var(--primary, #3b82f6)',
            fontWeight: 500,
            whiteSpace: 'nowrap',
        }}>
            {label}
            <button
                onClick={onRemove}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 1, color: 'inherit', opacity: 0.7, fontSize: 12, display: 'flex', alignItems: 'center' }}
                aria-label="remove filter"
            >
                ×
            </button>
        </span>
    );
}

function Th({ children, width, align }: { children: React.ReactNode; width?: number; align?: 'left' | 'right' | 'center' }) {
    return (
        <th
            style={{
                padding: '7px 12px',
                fontSize: 10.5,
                fontWeight: 500,
                color: 'var(--foreground-muted)',
                borderBottom: '1px solid var(--border)',
                textAlign: align || 'left',
                whiteSpace: 'nowrap',
                width,
            }}
        >
            {children}
        </th>
    );
}

function FaultRow({ execution: e, onClick, locale }: { execution: Execution; onClick: () => void; locale: string }) {
    const id = e.task_id || e.upload_id || '';
    const failureTypes = (e.failures || []).map(f => f.failure_type).filter(Boolean);
    const skillCount = (e.invoked_skills?.length ?? 0) || (e.skills?.length ?? 0) || (e.skill ? 1 : 0);
    const isMultiAgent = (e.invoked_skills?.length ?? 0) > 1 || (e.skills?.length ?? 0) > 1;
    const hasAnomaly = (e.failures && e.failures.length > 0) || (e.tool_call_error_count || 0) > 0;
    const status = e.is_evaluating ? 'running' : hasAnomaly ? 'failed' : 'success';

    return (
        <tr
            onClick={onClick}
            style={{
                cursor: 'pointer',
                borderBottom: '1px solid var(--table-row-border)',
                transition: 'background .1s',
            }}
            onMouseEnter={ev => ((ev.currentTarget as HTMLElement).style.background = 'var(--background-secondary)')}
            onMouseLeave={ev => ((ev.currentTarget as HTMLElement).style.background = 'transparent')}
        >
            <Td>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--foreground-muted)' }}>
                    {id.slice(0, 14) || '-'}
                </span>
            </Td>
            <Td truncate>
                <span title={e.agent || e.agentName || e.framework || '-'} style={{ fontSize: 11, color: 'var(--foreground)' }}>
                    {e.agent || e.agentName || e.framework || '-'}
                </span>
            </Td>
            <Td>
                {status === 'running' ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--primary)', fontWeight: 600, fontSize: 11 }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--primary)', animation: 'pulse 1.5s infinite' }} />
                        {locale === 'zh' ? '执行中' : 'Running'}
                    </span>
                ) : status === 'failed' ? (
                    <span style={{ color: 'var(--error)', fontWeight: 600, fontSize: 11 }}>{locale === 'zh' ? '失败' : 'Failed'}</span>
                ) : (
                    <span style={{ color: 'var(--success)', fontWeight: 600, fontSize: 11 }}>{locale === 'zh' ? '成功' : 'Success'}</span>
                )}
            </Td>
            <Td truncate>
                <span title={e.query} style={{ color: 'var(--foreground)' }}>
                    {e.query || (locale === 'zh' ? '(无问题)' : '(no query)')}
                </span>
            </Td>
            <Td>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {failureTypes.slice(0, 2).map((type, idx) => (
                        <span key={idx} className="ai-badge ai-badge-r" style={{ fontSize: 9 }}>{type}</span>
                    ))}
                    {failureTypes.length > 2 && <span style={{ fontSize: 9, color: 'var(--foreground-muted)' }}>+{failureTypes.length - 2}</span>}
                </div>
            </Td>
            <Td>
                <span style={{ fontSize: 10, color: 'var(--foreground-secondary)', fontFamily: 'var(--font-mono)' }}>
                    {new Date(e.timestamp).toLocaleString()}
                </span>
            </Td>
        </tr>
    );
}

function Td({ children, align, truncate }: { children: React.ReactNode; align?: 'left' | 'right' | 'center'; truncate?: boolean }) {
    return (
        <td
            style={{
                padding: '7px 12px',
                fontSize: 11.5,
                textAlign: align || 'left',
                color: 'var(--foreground)',
                ...(truncate
                    ? { maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as any }
                    : {}),
            }}
        >
            {children}
        </td>
    );
}

function Pagination({
    page, totalPages, pageSize, total, onPage, onPageSize, locale,
}: {
    page: number;
    totalPages: number;
    pageSize: number;
    total: number;
    onPage: (n: number) => void;
    onPageSize: (n: number) => void;
    locale: string;
}) {
    const start = (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);
    const pages = pageNumbers(page, totalPages);
    return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, padding: '0 4px' }}>
            <div style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>
                {locale === 'zh'
                    ? `显示 ${start} 到 ${end}，共 ${total} 条`
                    : `Showing ${start}-${end} of ${total}`}
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button className="ai-btn-s" style={{ padding: '2px 8px', fontSize: 11, minWidth: 30 }} disabled={page <= 1} onClick={() => onPage(page - 1)}>‹</button>
                {pages.map((p, i) => p === '...' ? (
                    <span key={`ell-${i}`} style={{ color: 'var(--foreground-muted)', alignSelf: 'center', padding: '0 2px' }}>...</span>
                ) : (
                    <button
                        key={`p-${p}`}
                        className="ai-btn-s"
                        onClick={() => onPage(p as number)}
                        style={{
                            padding: '2px 8px',
                            fontSize: 11,
                            minWidth: 30,
                            background: p === page ? 'var(--primary-subtle)' : 'var(--card-bg)',
                            color: p === page ? 'var(--primary)' : 'var(--foreground-secondary)',
                            borderColor: p === page ? 'var(--primary-subtle-border)' : 'var(--border)',
                        }}
                    >
                        {p}
                    </button>
                ))}
                <button className="ai-btn-s" style={{ padding: '2px 8px', fontSize: 11, minWidth: 30 }} disabled={page >= totalPages} onClick={() => onPage(page + 1)}>›</button>
                <select value={pageSize} onChange={e => onPageSize(Number(e.target.value))} className="ai-chip" style={{ height: 24, padding: '2px 22px 2px 6px', fontSize: 11, marginLeft: 8 }}>
                    {PAGE_SIZE_OPTIONS.map(s => (
                        <option key={s} value={s}>
                            {s} {locale === 'zh' ? '条/页' : '/page'}
                        </option>
                    ))}
                </select>
            </div>
        </div>
    );
}

function pageNumbers(current: number, total: number): (number | '...')[] {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    if (current <= 3) return [1, 2, 3, 4, '...', total];
    if (current >= total - 2) return [1, '...', total - 3, total - 2, total - 1, total];
    return [1, '...', current - 1, current, current + 1, '...', total];
}

function fmtSec(ms: number): string {
    if (!ms || !Number.isFinite(ms)) return '-';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
}

function toDisplayLatencyMs(latency: number, framework?: string): number {
    const fw = (framework || '').toLowerCase();
    if ((fw === 'opencode' || fw === 'openhands' || fw === 'claude') && latency > 0 && latency < 1000) return latency * 1000;
    return latency;
}

function truncateText(input: string, max: number): string {
    const s = String(input || '').trim();
    return s.length > max ? `${s.slice(0, max)}...` : s;
}

function stringifyShort(value: unknown): string {
    if (value == null) return '';
    if (typeof value === 'string') return value.slice(0, 500);
    try {
        return JSON.stringify(value).slice(0, 500);
    } catch {
        return String(value).slice(0, 500);
    }
}

function shortId(value: string): string {
    return value ? value.slice(0, 22) : '-';
}

function safeTime(value?: string): string {
    if (!value) return '-';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '-' : date.toLocaleTimeString();
}

const mutedLineStyle = {
    marginTop: 6,
    fontSize: 11.5,
    color: 'var(--foreground-muted)',
    lineHeight: 1.55,
} as const;

const diagnosisTitleStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    fontWeight: 750,
    marginBottom: 8,
} as const;

function diagnosisBoxStyle(kind: 'error' | 'deviation') {
    const isError = kind === 'error';
    return {
        marginTop: 12,
        padding: '10px 11px',
        borderRadius: 8,
        border: `1px solid ${isError ? 'var(--error-subtle-border)' : 'var(--primary-subtle-border)'}`,
        background: isError ? 'var(--error-subtle)' : 'var(--primary-subtle)',
        color: 'var(--foreground)',
        fontSize: 12,
        lineHeight: 1.6,
    } as const;
}

function bubbleStyle(role: 'assistant' | 'user') {
    const isUser = role === 'user';
    return {
        borderRadius: isUser ? '12px 4px 12px 12px' : '4px 12px 12px 12px',
        border: `1px solid ${isUser ? 'var(--primary)' : 'var(--border)'}`,
        background: isUser ? 'var(--primary)' : 'var(--card-bg)',
        color: isUser ? 'var(--primary-foreground)' : 'var(--foreground)',
        padding: '11px 12px',
        fontSize: 12.5,
        boxShadow: '0 8px 28px var(--shadow-color)',
    } as const;
}
