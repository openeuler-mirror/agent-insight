'use client';

import React, { useMemo, useState, useEffect, Suspense, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { useLocale } from '@/lib/client/locale-context';
import {
    Users,
    Database,
    Plus,
    Info,
    CheckCircle2,
    Network,
    ArrowRight,
    X,
    Loader2,
    HelpCircle,
    Trash2
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { AppTopBar } from '@/components/shell/AppTopBar';

type AgentOwnership = 'system' | 'user' | 'unregistered';
type AgentLayer = 'main' | 'subagent';
type PlatformFilter = 'all' | 'opencode' | 'openclaw' | 'hermes';
type ExecutionTimeFilter = 'all' | '1h' | '24h' | '7d' | 'exact';
type SortOption = 'lastExecutedDesc' | 'lastExecutedAsc' | 'platformAsc' | 'nameAsc';
type AgentLayerFilter = 'all' | AgentLayer;
type AgentOwnershipFilter = 'all' | AgentOwnership;

interface Agent {
    id: string;
    name: string;
    ownership: AgentOwnership;
    layer: AgentLayer;
    platform: Exclude<PlatformFilter, 'all'>;
    version: string;
    framework: string;
    status: 'running' | 'idle' | 'unregistered';
    successRate?: string;
    todayCalls: string;
    p99?: string;
    parentAgent?: string;
    discoveryTime?: string;
    lastExecutedAt: string;
}

const MOCK_NOW = new Date('2026-05-06T12:00:00');
const DEFAULT_PLATFORM: PlatformFilter = 'opencode';
const DEFAULT_EXECUTION_TIME: ExecutionTimeFilter = '1h';
const DEFAULT_SORT: SortOption = 'lastExecutedDesc';
const DEFAULT_AGENT_LAYER: AgentLayerFilter = 'main';
const DEFAULT_OWNERSHIP: AgentOwnershipFilter = 'user';

function getRelativeTimeParts(dateString: string, now = MOCK_NOW) {
    const diffMs = Math.max(0, now.getTime() - new Date(dateString).getTime());
    const diffMinutes = Math.floor(diffMs / (1000 * 60));

    if (diffMinutes < 60) {
        return { unit: 'minutes', value: Math.max(diffMinutes, 1) };
    }

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) {
        return { unit: 'hours', value: diffHours };
    }

    const diffDays = Math.floor(diffHours / 24);
    return { unit: 'days', value: diffDays };
}

function getExecutionWindowMs(value: ExecutionTimeFilter) {
    switch (value) {
        case '1h':
            return 1000 * 60 * 60;
        case '24h':
            return 1000 * 60 * 60 * 24;
        case '7d':
            return 1000 * 60 * 60 * 24 * 7;
        default:
            return null;
    }
}

function formatDateTimeLocal(date: Date) {
    const pad = (value: number) => value.toString().padStart(2, '0');

    return [
        date.getFullYear(),
        '-',
        pad(date.getMonth() + 1),
        '-',
        pad(date.getDate()),
        'T',
        pad(date.getHours()),
        ':',
        pad(date.getMinutes()),
        ':',
        pad(date.getSeconds()),
    ].join('');
}

function formatDateTimeLabel(value: string) {
    return value.replace('T', ' ');
}

function getDefaultExactTimeRange(value: ExecutionTimeFilter, now = MOCK_NOW) {
    const windowMs = getExecutionWindowMs(value);

    if (windowMs === null) {
        return { start: '', end: '' };
    }

    return {
        start: formatDateTimeLocal(new Date(now.getTime() - windowMs)),
        end: formatDateTimeLocal(now),
    };
}

function sortAgents(agents: Agent[], sortBy: SortOption) {
    const sorted = [...agents];

    sorted.sort((left, right) => {
        if (sortBy === 'lastExecutedDesc') {
            return new Date(right.lastExecutedAt).getTime() - new Date(left.lastExecutedAt).getTime();
        }

        if (sortBy === 'lastExecutedAsc') {
            return new Date(left.lastExecutedAt).getTime() - new Date(right.lastExecutedAt).getTime();
        }

        if (sortBy === 'platformAsc') {
            return left.platform.localeCompare(right.platform) || left.name.localeCompare(right.name);
        }

        return left.name.localeCompare(right.name);
    });

    return sorted;
}

function normalizePlatform(value: string): Exclude<PlatformFilter, 'all'> {
    if (value === 'openclaw' || value === 'hermes') return value;
    return 'opencode';
}

function normalizeOwnership(value: string): AgentOwnership {
    if (value === 'system' || value === 'unregistered') return value;
    return 'user';
}

function normalizeLayer(value: string): AgentLayer {
    return value === 'subagent' ? 'subagent' : 'main';
}

function dedupeAgentsByPlatformAndName(agents: Agent[]): Agent[] {
    const ownershipRank: Record<AgentOwnership, number> = {
        user: 3,
        unregistered: 2,
        system: 1,
    };
    const map = new Map<string, Agent>();
    for (const agent of agents) {
        const key = `${agent.platform}-${agent.name}`;
        const current = map.get(key);
        if (!current) {
            map.set(key, agent);
            continue;
        }
        const rankDiff = ownershipRank[agent.ownership] - ownershipRank[current.ownership];
        if (
            rankDiff > 0 ||
            (rankDiff === 0 && new Date(agent.lastExecutedAt).getTime() > new Date(current.lastExecutedAt).getTime())
        ) {
            map.set(key, agent);
        }
    }
    return Array.from(map.values());
}

// ============================================================
// 原子组件（纯 inline style，不依赖 Tailwind）
// ============================================================

interface BtnProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'default' | 'outline' | 'secondary';
    size?: 'sm' | 'md';
    fullWidth?: boolean;
}

function Btn({ variant = 'default', size = 'md', fullWidth, style, children, ...props }: BtnProps) {
    const [hover, setHover] = useState(false);

    const base: React.CSSProperties = {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        borderRadius: 6,
        fontWeight: 500,
        fontFamily: 'inherit',
        cursor: 'pointer',
        transition: 'background 0.15s, border-color 0.15s, color 0.15s',
        whiteSpace: 'nowrap',
        outline: 'none',
        boxSizing: 'border-box',
        width: fullWidth ? '100%' : undefined,
        height: size === 'sm' ? 28 : 32,
        padding: size === 'sm' ? '0 8px' : '0 12px',
        fontSize: size === 'sm' ? 11 : 12,
    };

    const variants: Record<string, React.CSSProperties> = {
        default: {
            background: hover ? 'var(--primary-hover, var(--primary))' : 'var(--primary)',
            color: 'var(--primary-foreground, #fff)',
            border: '1px solid var(--primary)',
        },
        outline: {
            background: hover ? 'var(--background-secondary)' : 'transparent',
            color: 'var(--foreground)',
            border: '1px solid var(--border)',
        },
        secondary: {
            background: hover ? 'var(--secondary-hover, var(--secondary))' : 'var(--secondary)',
            color: 'var(--foreground)',
            border: '1px solid transparent',
        },
    };

    return (
        <button
            {...props}
            style={{ ...base, ...variants[variant], ...style }}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
        >
            {children}
        </button>
    );
}

interface TagProps {
    variant?: 'default' | 'secondary' | 'outline';
    children: React.ReactNode;
    style?: React.CSSProperties;
}

function Tag({ variant = 'default', children, style }: TagProps) {
    const base: React.CSSProperties = {
        display: 'inline-flex',
        alignItems: 'center',
        height: 16,
        padding: '0 6px',
        borderRadius: 4,
        fontSize: 9,
        fontWeight: 600,
        fontFamily: 'inherit',
        textTransform: 'uppercase',
        letterSpacing: '0.02em',
        flexShrink: 0,
        lineHeight: 1,
    };

    const variants: Record<string, React.CSSProperties> = {
        default: {
            background: 'var(--primary)',
            color: 'var(--primary-foreground, #fff)',
        },
        secondary: {
            background: 'var(--secondary, #f1f5f9)',
            color: 'var(--foreground)',
        },
        outline: {
            background: 'transparent',
            color: 'var(--foreground-secondary, var(--foreground))',
            border: '1px solid var(--border)',
        },
    };

    return <span style={{ ...base, ...variants[variant], ...style }}>{children}</span>;
}

interface FilterSelectProps {
    label: string;
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
    minWidth?: number;
    tooltip?: React.ReactNode;
}

function FilterSelect({ label, value, onChange, options, minWidth = 220, tooltip }: FilterSelectProps) {
    return (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth }}>
            <span style={{ fontSize: 10.5, color: 'var(--foreground-muted)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                {label}
                {tooltip && (
                    <TooltipProvider>
                        <Tooltip delayDuration={300}>
                            <TooltipTrigger asChild>
                                <HelpCircle size={12} style={{ cursor: 'help', color: 'var(--foreground-muted)' }} />
                            </TooltipTrigger>
                            <TooltipContent
                                side="bottom"
                                sideOffset={6}
                                className="bg-[var(--card-bg,#fff)] text-[var(--foreground)] border border-[var(--border)] shadow-md max-w-[280px] p-3 [&>svg]:hidden"
                            >
                                {tooltip}
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
                )}
            </span>
            <select
                value={value}
                onChange={(event) => onChange(event.target.value)}
                style={{
                    width: '100%',
                    height: 36,
                    padding: '0 12px',
                    borderRadius: 10,
                    border: '1px solid var(--border)',
                    background: 'var(--background)',
                    color: 'var(--foreground)',
                    fontSize: 12,
                    fontWeight: 500,
                    outline: 'none',
                    cursor: 'pointer',
                    boxSizing: 'border-box',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
                }}
            >
                {options.map(option => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
        </label>
    );
}

interface FilterDateTimeInputProps {
    label: string;
    value: string;
    onChange: (value: string) => void;
    minWidth?: number;
}

function FilterDateTimeInput({ label, value, onChange, minWidth = 220 }: FilterDateTimeInputProps) {
    return (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth }}>
            <span style={{ fontSize: 10.5, color: 'var(--foreground-muted)', fontWeight: 600 }}>
                {label}
            </span>
            <input
                type="datetime-local"
                step={1}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                style={{
                    height: 36,
                    padding: '0 12px',
                    borderRadius: 10,
                    border: '1px solid var(--border)',
                    background: 'var(--background)',
                    color: 'var(--foreground)',
                    fontSize: 12,
                    fontWeight: 500,
                    outline: 'none',
                    boxSizing: 'border-box',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
                }}
            />
        </label>
    );
}

// ============================================================
// 注册 Agent 弹窗组件
// ============================================================

interface RegisterAgentDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess: () => void;
    initialName?: string;
    initialPlatform?: string;
}

function RegisterAgentDialog({ isOpen, onClose, onSuccess, initialName, initialPlatform }: RegisterAgentDialogProps) {
    const [platform, setPlatform] = useState<string>(initialPlatform || 'opencode');
    const [name, setName] = useState(initialName || '');
    const [description, setDescription] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (isOpen) {
            setName(initialName || '');
            setPlatform(initialPlatform || 'opencode');
            setDescription('');
            setError('');
        }
    }, [isOpen, initialName, initialPlatform]);

    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');

        if (!platform || !name) {
            setError('平台名称和 Agent 名称不能为空');
            return;
        }

        setLoading(true);
        try {
            const res = await fetch('/api/agents', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ platform, name, description }),
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || '注册失败');
            }

            onSuccess();
            onClose();
            setName('');
            setDescription('');
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <AnimatePresence>
            <div
                style={{
                    position: 'fixed',
                    inset: 0,
                    background: 'rgba(15, 23, 42, 0.45)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 20,
                    zIndex: 1000,
                }}
                onClick={onClose}
            >
                <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    style={{
                        width: 'min(480px, 100%)',
                        borderRadius: 16,
                        border: '1px solid var(--border)',
                        background: 'var(--background)',
                        boxShadow: '0 24px 60px rgba(0,0,0,0.18)',
                        padding: 24,
                        boxSizing: 'border-box',
                    }}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--foreground)' }}>
                            注册 Agent
                        </h2>
                        <button
                            type="button"
                            onClick={onClose}
                            style={{
                                width: 28,
                                height: 28,
                                borderRadius: 999,
                                border: '1px solid var(--border)',
                                background: 'transparent',
                                color: 'var(--foreground-secondary)',
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                cursor: 'pointer',
                            }}
                        >
                            <X style={{ width: 14, height: 14 }} />
                        </button>
                    </div>

                    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                        {error && (
                            <div style={{ padding: 10, borderRadius: 8, background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', fontSize: 13 }}>
                                {error}
                            </div>
                        )}
                        
                        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>
                                平台名称 <span style={{ color: '#ef4444' }}>*</span>
                            </span>
                            <select
                                value={platform}
                                onChange={(e) => setPlatform(e.target.value)}
                                style={{
                                    height: 38,
                                    padding: '0 12px',
                                    borderRadius: 10,
                                    border: '1px solid var(--border)',
                                    background: 'var(--background)',
                                    color: 'var(--foreground)',
                                    fontSize: 13,
                                    outline: 'none',
                                }}
                            >
                                <option value="opencode">opencode</option>
                                <option value="openclaw">openclaw</option>
                                <option value="hermes">hermes</option>
                            </select>
                        </label>

                        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>
                                Agent 名称 <span style={{ color: '#ef4444' }}>*</span>
                            </span>
                            <input
                                type="text"
                                placeholder="输入唯一的 Agent 名称"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                style={{
                                    height: 38,
                                    padding: '0 12px',
                                    borderRadius: 10,
                                    border: '1px solid var(--border)',
                                    background: 'var(--background)',
                                    color: 'var(--foreground)',
                                    fontSize: 13,
                                    outline: 'none',
                                }}
                            />
                        </label>

                        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>
                                Agent 描述 <span style={{ color: 'var(--foreground-muted)', fontWeight: 400 }}>(可选)</span>
                            </span>
                            <textarea
                                placeholder="输入 Agent 的功能描述"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                rows={3}
                                style={{
                                    padding: '10px 12px',
                                    borderRadius: 10,
                                    border: '1px solid var(--border)',
                                    background: 'var(--background)',
                                    color: 'var(--foreground)',
                                    fontSize: 13,
                                    outline: 'none',
                                    resize: 'vertical',
                                }}
                            />
                        </label>

                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
                            <Btn variant="outline" type="button" onClick={onClose} disabled={loading}>
                                取消
                            </Btn>
                            <Btn variant="default" type="submit" disabled={loading || !name}>
                                {loading ? <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} /> : '确认注册'}
                            </Btn>
                        </div>
                    </form>
                </motion.div>
            </div>
        </AnimatePresence>
    );
}

// ============================================================
// 主页面
// ============================================================

function AgentsPageInner() {
    const { t } = useLocale();
    const router = useRouter();
    const searchParams = useSearchParams();
    const defaultExactRange = useMemo(
        () => getDefaultExactTimeRange(DEFAULT_EXECUTION_TIME),
        []
    );

    const [platform, setPlatform] = useState<PlatformFilter>(
        (searchParams.get('platform') as PlatformFilter) || DEFAULT_PLATFORM
    );
    const [executionTime, setExecutionTime] = useState<ExecutionTimeFilter>(
        (searchParams.get('executionTime') as ExecutionTimeFilter) || DEFAULT_EXECUTION_TIME
    );
    const [sortBy, setSortBy] = useState<SortOption>(
        (searchParams.get('sortBy') as SortOption) || DEFAULT_SORT
    );
    const [agentLayer, setAgentLayer] = useState<AgentLayerFilter>(
        (searchParams.get('agentLayer') as AgentLayerFilter) || DEFAULT_AGENT_LAYER
    );
    const [ownership, setOwnership] = useState<AgentOwnershipFilter>(
        (searchParams.get('ownership') as AgentOwnershipFilter) || DEFAULT_OWNERSHIP
    );
    const [exactStartAt, setExactStartAt] = useState(
        searchParams.get('exactStartAt') || defaultExactRange.start
    );
    const [exactEndAt, setExactEndAt] = useState(
        searchParams.get('exactEndAt') || defaultExactRange.end
    );
    const [exactTimeDraftStartAt, setExactTimeDraftStartAt] = useState(
        searchParams.get('exactStartAt') || defaultExactRange.start
    );
    const [exactTimeDraftEndAt, setExactTimeDraftEndAt] = useState(
        searchParams.get('exactEndAt') || defaultExactRange.end
    );
    const [isExactTimeDialogOpen, setIsExactTimeDialogOpen] = useState(false);

    useEffect(() => {
        const params = new URLSearchParams();
        if (platform !== DEFAULT_PLATFORM) params.set('platform', platform);
        if (executionTime !== DEFAULT_EXECUTION_TIME) params.set('executionTime', executionTime);
        if (sortBy !== DEFAULT_SORT) params.set('sortBy', sortBy);
        if (agentLayer !== DEFAULT_AGENT_LAYER) params.set('agentLayer', agentLayer);
        if (ownership !== DEFAULT_OWNERSHIP) params.set('ownership', ownership);
        if (executionTime === 'exact') {
            if (exactStartAt) params.set('exactStartAt', exactStartAt);
            if (exactEndAt) params.set('exactEndAt', exactEndAt);
        }
        const qs = params.toString();
        router.replace(qs ? `?${qs}` : '?', { scroll: false });
    }, [platform, executionTime, sortBy, agentLayer, ownership, exactStartAt, exactEndAt]);
    const [isRegisterDialogOpen, setIsRegisterDialogOpen] = useState(false);
    const [convertTarget, setConvertTarget] = useState<{ name: string; platform: string } | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState('');
    const [dbAgents, setDbAgents] = useState<Agent[]>([]);
    const isDbAgentsMountedRef = useRef(true);

    const handleDeleteConfirm = async () => {
        if (!deleteTarget) return;
        setIsDeleting(true);
        setDeleteError('');
        try {
            const res = await fetch(`/api/agents/${deleteTarget.id}`, { method: 'DELETE' });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || '删除失败');
            }
            fetchDbAgents();
            setDeleteTarget(null);
        } catch (err) {
            setDeleteError(err instanceof Error ? err.message : String(err));
        } finally {
            setIsDeleting(false);
        }
    };

    const fetchDbAgents = useCallback(async () => {
        try {
            const res = await fetch('/api/agents');
            if (res.ok) {
                const data = await res.json();
                const formatted: Agent[] = data.agents.map((a: {
                    id: string;
                    name: string;
                    platform: string;
                    agentOwnership?: string;
                    agentType?: string;
                    ownership?: string;
                    layer?: string;
                    framework?: string;
                    status?: string;
                    version?: string;
                    todayCalls?: string;
                    createdAt?: string;
                    lastExecutedAt?: string;
                }) => ({
                    id: a.id,
                    name: a.name,
                    ownership: normalizeOwnership(a.agentOwnership || a.ownership || 'user'),
                    layer: normalizeLayer(a.agentType || a.layer || 'main'),
                    platform: normalizePlatform(a.platform),
                    version: a.version || 'v1.0',
                    framework: a.framework || 'Custom',
                    status: a.status === 'unregistered' || a.agentOwnership === 'unregistered' ? 'unregistered' : 'idle',
                    todayCalls: a.todayCalls || '0',
                    lastExecutedAt: a.lastExecutedAt || a.createdAt || new Date().toISOString(),
                }));
                if (isDbAgentsMountedRef.current) setDbAgents(formatted);
            }
        } catch (error) {
            console.error('Failed to fetch DB agents', error);
        }
    }, []);

    useEffect(() => {
        isDbAgentsMountedRef.current = true;
        const timeoutId = window.setTimeout(() => {
            void fetchDbAgents();
        }, 0);
        return () => {
            isDbAgentsMountedRef.current = false;
            window.clearTimeout(timeoutId);
        };
    }, [fetchDbAgents]);

    const mockAgents: Agent[] = useMemo(() => [
        {
            id: 'customer-service-agent',
            name: 'customer-service-agent',
            ownership: 'system',
            layer: 'main',
            platform: 'opencode',
            version: 'v2.1',
            framework: 'LangChain',
            status: 'running',
            successRate: '87.3%',
            todayCalls: '3,847',
            lastExecutedAt: '2026-05-06T11:48:00',
        },
        {
            id: 'data-analyzer-v2',
            name: 'data-analyzer-v2',
            ownership: 'user',
            layer: 'main',
            platform: 'openclaw',
            version: 'v1.0',
            framework: 'Custom',
            status: 'idle',
            successRate: '94.1%',
            todayCalls: '128',
            lastExecutedAt: '2026-05-05T20:10:00',
        },
        {
            id: 'temp-worker-42',
            name: 'temp-worker-42',
            ownership: 'unregistered',
            layer: 'main',
            platform: 'hermes',
            version: 'N/A',
            framework: 'N/A',
            status: 'unregistered',
            todayCalls: '12',
            discoveryTime: '2026-05-06T10:02:00',
            lastExecutedAt: '2026-05-06T10:02:00',
        },
        {
            id: 'order-executor',
            name: 'order-executor',
            ownership: 'system',
            layer: 'subagent',
            platform: 'opencode',
            version: 'v1.1',
            framework: 'LangGraph',
            status: 'running',
            todayCalls: '412',
            p99: '4.3s',
            parentAgent: 'customer-service-agent',
            lastExecutedAt: '2026-05-06T11:43:00',
        },
        {
            id: 'email-dispatcher',
            name: 'email-dispatcher',
            ownership: 'user',
            layer: 'main',
            platform: 'hermes',
            version: 'v0.9',
            framework: 'AutoGPT',
            status: 'running',
            successRate: '99.2%',
            todayCalls: '1,024',
            lastExecutedAt: '2026-05-06T09:24:00',
        },
        {
            id: 'security-guard',
            name: 'security-guard',
            ownership: 'system',
            layer: 'main',
            platform: 'opencode',
            version: 'v3.0',
            framework: 'Internal',
            status: 'running',
            successRate: '100%',
            todayCalls: '45,201',
            lastExecutedAt: '2026-05-06T11:56:00',
        },
        {
            id: 'trace-quality-evaluator',
            name: 'trace-quality-evaluator',
            ownership: 'system',
            layer: 'main',
            platform: 'opencode',
            version: 'v1.0',
            framework: 'opencode',
            status: 'running',
            successRate: '—',
            todayCalls: '—',
            lastExecutedAt: '2026-05-06T12:00:00',
        },
        {
            id: 'task-completion-evaluator',
            name: 'task-completion-evaluator',
            ownership: 'system',
            layer: 'main',
            platform: 'opencode',
            version: 'v1.0',
            framework: 'opencode',
            status: 'running',
            successRate: '—',
            todayCalls: '—',
            lastExecutedAt: '2026-05-06T12:00:00',
        },
    ], []);

    const agents = useMemo(() => {
        return dedupeAgentsByPlatformAndName([...dbAgents, ...mockAgents]);
    }, [dbAgents, mockAgents]);

    const unregisteredCount = agents.filter(agent => agent.ownership === 'unregistered').length;
    const hasActiveFilters =
        platform !== DEFAULT_PLATFORM ||
        executionTime !== DEFAULT_EXECUTION_TIME ||
        sortBy !== DEFAULT_SORT ||
        agentLayer !== DEFAULT_AGENT_LAYER ||
        ownership !== DEFAULT_OWNERSHIP ||
        (executionTime === 'exact' &&
            (exactStartAt !== defaultExactRange.start || exactEndAt !== defaultExactRange.end));

    const filteredAgents = useMemo(() => {
        const windowMs = getExecutionWindowMs(executionTime);
        const exactStartMs = executionTime === 'exact' && exactStartAt ? new Date(exactStartAt).getTime() : null;
        const exactEndMs = executionTime === 'exact' && exactEndAt ? new Date(exactEndAt).getTime() : null;

        const result = agents.filter(agent => {
            if (platform !== 'all' && agent.platform !== platform) {
                return false;
            }

            if (agentLayer !== 'all' && agent.layer !== agentLayer) {
                return false;
            }

            if (ownership !== 'all' && agent.ownership !== ownership) {
                return false;
            }

            const lastExecutedMs = new Date(agent.lastExecutedAt).getTime();

            if (windowMs !== null) {
                const diffMs = MOCK_NOW.getTime() - lastExecutedMs;
                if (diffMs > windowMs) {
                    return false;
                }
            }

            if (exactStartMs !== null && !Number.isNaN(exactStartMs) && lastExecutedMs < exactStartMs) {
                return false;
            }

            if (exactEndMs !== null && !Number.isNaN(exactEndMs) && lastExecutedMs > exactEndMs) {
                return false;
            }

            return true;
        });

        return sortAgents(result, sortBy);
    }, [agentLayer, agents, exactEndAt, exactStartAt, executionTime, ownership, platform, sortBy]);

    const filterOptions = {
        platforms: [
            { value: 'all', label: t('nav.filterDefaultOption') },
            { value: 'opencode', label: 'opencode' },
            { value: 'openclaw', label: 'openclaw' },
            { value: 'hermes', label: 'hermes' },
        ],
        executionTimes: [
            { value: 'all', label: t('nav.filterDefaultOption') },
            { value: '1h', label: t('nav.last1Hour') },
            { value: '24h', label: t('nav.last24Hours') },
            { value: '7d', label: t('nav.last7Days') },
            { value: 'exact', label: t('nav.exactTimeOption') },
        ],
        sortOptions: [
            { value: 'lastExecutedDesc', label: t('nav.sortLastExecutedDesc') },
            { value: 'lastExecutedAsc', label: t('nav.sortLastExecutedAsc') },
            { value: 'platformAsc', label: t('nav.sortPlatform') },
            { value: 'nameAsc', label: t('nav.sortName') },
        ],
        layerOptions: [
            { value: 'all', label: t('nav.filterDefaultOption') },
            { value: 'main', label: t('nav.mainAgent') },
            { value: 'subagent', label: t('nav.subAgent') },
        ],
        ownershipOptions: [
            { value: 'all', label: t('nav.filterDefaultOption') },
            { value: 'system', label: t('nav.systemAgent') },
            { value: 'user', label: t('nav.userAgent') },
            { value: 'unregistered', label: t('nav.unregisteredAgent') },
        ],
    };

    const activeFilters = [
        platform !== 'all'
            ? {
                key: 'platform',
                label: `${t('nav.filterPlatform')}: ${filterOptions.platforms.find(option => option.value === platform)?.label ?? platform}`,
                clear: () => setPlatform('all'),
            }
            : null,
        executionTime !== DEFAULT_EXECUTION_TIME
            ? {
                key: 'executionTime',
                label: `${t('nav.filterTimeRange')}: ${executionTime !== 'all' ? (filterOptions.executionTimes.find(option => option.value === executionTime)?.label ?? executionTime) : t('nav.filterDefaultOption')}${executionTime === 'exact' && (exactStartAt || exactEndAt) ? ` (${formatDateTimeLabel(exactStartAt || '...')} ~ ${formatDateTimeLabel(exactEndAt || '...')})` : ''}`,
                clear: () => {
                    const nextRange = getDefaultExactTimeRange(DEFAULT_EXECUTION_TIME);
                    setExecutionTime(DEFAULT_EXECUTION_TIME);
                    setExactStartAt(nextRange.start);
                    setExactEndAt(nextRange.end);
                    setExactTimeDraftStartAt(nextRange.start);
                    setExactTimeDraftEndAt(nextRange.end);
                },
            }
            : null,
        agentLayer !== 'all'
            ? {
                key: 'agentLayer',
                label: `${t('nav.filterAgentKind')}: ${filterOptions.layerOptions.find(option => option.value === agentLayer)?.label ?? agentLayer}`,
                clear: () => setAgentLayer('all'),
            }
            : null,
        ownership !== 'all'
            ? {
                key: 'ownership',
                label: `${t('nav.filterAgentOwnership')}: ${filterOptions.ownershipOptions.find(option => option.value === ownership)?.label ?? ownership}`,
                clear: () => setOwnership('all'),
            }
            : null,
        sortBy
            ? {
                key: 'sortBy',
                label: `${t('nav.filterSortBy')}: ${filterOptions.sortOptions.find(option => option.value === sortBy)?.label ?? sortBy}`,
                clear: () => setSortBy(DEFAULT_SORT),
            }
            : null,
    ].filter(Boolean) as Array<{ key: string; label: string; clear: () => void }>;

    const gridStyle: React.CSSProperties = {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
        gap: 16,
    };

    const openExactTimeDialog = () => {
        setExactTimeDraftStartAt(exactStartAt || defaultExactRange.start);
        setExactTimeDraftEndAt(exactEndAt || defaultExactRange.end);
        setIsExactTimeDialogOpen(true);
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
            <AppTopBar
                title={t('nav.agents')}
                showDefaultActions={false}
                actions={
                    <Btn variant="default" size="sm" onClick={() => setIsRegisterDialogOpen(true)}>
                        <Plus style={{ width: 14, height: 14 }} />
                        {t('nav.registerAgent')}
                    </Btn>
                }
            />
            <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px 28px', width: '100%', boxSizing: 'border-box' }}>
                {/* Unregistered Alert */}
                {unregisteredCount > 0 && (
                    <div style={{
                        background: 'var(--background-secondary)',
                        border: '1px dashed var(--border-dark, var(--border))',
                        borderRadius: 8,
                        padding: 10,
                        marginBottom: 12,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                    }}>
                        <div style={{ fontSize: 11.5, color: 'var(--foreground-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Info style={{ width: 14, height: 14, flexShrink: 0 }} />
                            <span>{t('nav.unregisteredAlert').replace('{{count}}', unregisteredCount.toString())}</span>
                        </div>
                        <button style={{
                            fontSize: 10,
                            fontWeight: 500,
                            color: 'var(--primary)',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            padding: 0,
                            flexShrink: 0,
                        }}>
                            {t('nav.viewAll')}
                        </button>
                    </div>
                )}

                <div style={{
                    background: 'linear-gradient(180deg, rgba(127,127,127,0.03), transparent 88%), var(--card-bg, var(--background))',
                    border: '1px solid var(--border)',
                    borderRadius: 14,
                    padding: 18,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.03)',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--foreground)' }}>
                                {t('nav.agentFiltersTitle')}
                            </div>
                            <div style={{ fontSize: 11.5, color: 'var(--foreground-secondary)' }}>
                                {t('nav.filteredAgentsCount', {
                                    count: filteredAgents.length.toString(),
                                    total: agents.length.toString(),
                                })}
                            </div>
                        </div>
                    </div>

                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                        flexWrap: 'wrap',
                        gap: 12,
                        marginTop: 18,
                        padding: 14,
                        borderRadius: 12,
                        background: 'var(--background-secondary)',
                        border: '1px solid rgba(127,127,127,0.08)',
                    }}>
                        <FilterSelect
                            label={t('nav.filterPlatform')}
                            value={platform}
                            onChange={(value) => setPlatform(value as PlatformFilter)}
                            options={filterOptions.platforms}
                            minWidth={180}
                        />
                        <FilterSelect
                            label={t('nav.filterTimeRange')}
                            value={executionTime}
                            onChange={(value) => {
                                const nextValue = value as ExecutionTimeFilter;
                                if (nextValue === 'exact') {
                                    openExactTimeDialog();
                                    return;
                                }
                                const nextRange = getDefaultExactTimeRange(nextValue);
                                setExecutionTime(nextValue);
                                setExactStartAt(nextRange.start);
                                setExactEndAt(nextRange.end);
                                setExactTimeDraftStartAt(nextRange.start);
                                setExactTimeDraftEndAt(nextRange.end);
                            }}
                            options={filterOptions.executionTimes}
                            minWidth={180}
                        />
                        {executionTime === 'exact' && (
                            <div style={{ display: 'flex', alignItems: 'flex-end', minWidth: 180 }}>
                                <Btn
                                    variant="outline"
                                    style={{ width: '100%', height: 36, borderRadius: 10 }}
                                    onClick={openExactTimeDialog}
                                >
                                    {t('nav.editExactTime')}
                                </Btn>
                            </div>
                        )}
                        <FilterSelect
                            label={t('nav.filterAgentKind')}
                            value={agentLayer}
                            onChange={(value) => setAgentLayer(value as AgentLayerFilter)}
                            options={filterOptions.layerOptions}
                            minWidth={180}
                        />
                        <FilterSelect
                            label={t('nav.filterAgentOwnership')}
                            tooltip={
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: '12px' }}>
                                    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                                        <span style={{ fontWeight: 600, color: 'var(--foreground)' }}>{t('nav.userAgent')}:</span>
                                        <span style={{ color: 'var(--foreground-muted)' }}>{t('nav.filterAgentOwnershipTooltipUser')}</span>
                                    </div>
                                    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                                        <span style={{ fontWeight: 600, color: 'var(--foreground)' }}>{t('nav.systemAgent')}:</span>
                                        <span style={{ color: 'var(--foreground-muted)' }}>{t('nav.filterAgentOwnershipTooltipSystem')}</span>
                                    </div>
                                    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                                        <span style={{ fontWeight: 600, color: 'var(--foreground)' }}>{t('nav.unregisteredAgent')}:</span>
                                        <span style={{ color: 'var(--foreground-muted)' }}>{t('nav.filterAgentOwnershipTooltipUnregistered')}</span>
                                    </div>
                                </div>
                            }
                            value={ownership}
                            onChange={(value) => setOwnership(value as AgentOwnershipFilter)}
                            options={filterOptions.ownershipOptions}
                            minWidth={180}
                        />
                        <FilterSelect
                            label={t('nav.filterSortBy')}
                            value={sortBy}
                            onChange={(value) => setSortBy(value as SortOption)}
                            options={filterOptions.sortOptions}
                            minWidth={220}
                        />
                    </div>

                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        flexWrap: 'wrap',
                        marginTop: 14,
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--foreground-secondary)' }}>
                                {t('nav.activeFiltersLabel')}
                            </span>
                            {activeFilters.length > 0 ? (
                                activeFilters.map(filter => (
                                    <button
                                        key={filter.key}
                                        type="button"
                                        onClick={filter.clear}
                                        style={{
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: 6,
                                            height: 28,
                                            padding: '0 10px',
                                            borderRadius: 999,
                                            border: '1px solid rgba(99, 102, 241, 0.18)',
                                            background: 'var(--primary-subtle, rgba(99, 102, 241, 0.1))',
                                            color: 'var(--primary)',
                                            fontSize: 11.5,
                                            fontWeight: 600,
                                            cursor: 'pointer',
                                        }}
                                    >
                                        <span>{filter.label}</span>
                                        <X style={{ width: 12, height: 12 }} />
                                    </button>
                                ))
                            ) : (
                                <span style={{ fontSize: 11.5, color: 'var(--foreground-muted)' }}>
                                    {t('nav.noActiveFilters')}
                                </span>
                            )}
                        </div>
                        {hasActiveFilters && (
                            <button
                                type="button"
                                onClick={() => {
                                    const nextRange = getDefaultExactTimeRange(DEFAULT_EXECUTION_TIME);
                                    setPlatform(DEFAULT_PLATFORM);
                                    setExecutionTime(DEFAULT_EXECUTION_TIME);
                                    setExactStartAt(nextRange.start);
                                    setExactEndAt(nextRange.end);
                                    setExactTimeDraftStartAt(nextRange.start);
                                    setExactTimeDraftEndAt(nextRange.end);
                                    setSortBy(DEFAULT_SORT);
                                    setAgentLayer(DEFAULT_AGENT_LAYER);
                                    setOwnership(DEFAULT_OWNERSHIP);
                                }}
                                style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    background: 'transparent',
                                    color: 'var(--foreground-secondary)',
                                    border: 'none',
                                    padding: 0,
                                    cursor: 'pointer',
                                    fontSize: 11.5,
                                    fontWeight: 600,
                                }}
                            >
                                <X style={{ width: 12, height: 12 }} />
                                {t('nav.clearFilters')}
                            </button>
                        )}
                    </div>

                    {filteredAgents.length > 0 ? (
                        <motion.div
                            style={{ ...gridStyle, marginTop: 16 }}
                            initial="hidden"
                            animate="visible"
                            variants={{ visible: { transition: { staggerChildren: 0.05 } } }}
                        >
                            {filteredAgents.map(agent => (
                                <motion.div
                                    key={agent.id}
                                    variants={{ hidden: { opacity: 0, y: 10 }, visible: { opacity: 1, y: 0 } }}
                                >
                                    <AgentCard agent={agent} onConvert={() => {
                                        setConvertTarget({ name: agent.name, platform: agent.platform });
                                        setIsRegisterDialogOpen(true);
                                    }} onDelete={() => {
                                        setDeleteTarget({ id: agent.id, name: agent.name });
                                    }} />
                                </motion.div>
                            ))}
                        </motion.div>
                    ) : (
                        <div style={{
                            marginTop: 16,
                            border: '1px dashed var(--border)',
                            borderRadius: 10,
                            padding: 24,
                            textAlign: 'center',
                            color: 'var(--foreground-secondary)',
                            fontSize: 12.5,
                            background: 'var(--background-secondary)',
                        }}>
                            {t('nav.noAgentsFiltered')}
                        </div>
                    )}
                </div>
            </div>
            {isExactTimeDialogOpen && (
                <div
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(15, 23, 42, 0.45)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: 20,
                        zIndex: 1000,
                    }}
                    onClick={() => setIsExactTimeDialogOpen(false)}
                >
                    <div
                        style={{
                            width: 'min(520px, 100%)',
                            borderRadius: 16,
                            border: '1px solid var(--border)',
                            background: 'var(--background)',
                            boxShadow: '0 24px 60px rgba(0,0,0,0.18)',
                            padding: 18,
                            boxSizing: 'border-box',
                        }}
                        onClick={(event) => event.stopPropagation()}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                            <div>
                                <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--foreground)' }}>
                                    {t('nav.exactTimeDialogTitle')}
                                </div>
                                <div style={{ marginTop: 4, fontSize: 12, color: 'var(--foreground-secondary)' }}>
                                    {t('nav.exactTimeDialogDescription')}
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => setIsExactTimeDialogOpen(false)}
                                style={{
                                    width: 28,
                                    height: 28,
                                    borderRadius: 999,
                                    border: '1px solid var(--border)',
                                    background: 'transparent',
                                    color: 'var(--foreground-secondary)',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    cursor: 'pointer',
                                    flexShrink: 0,
                                }}
                            >
                                <X style={{ width: 14, height: 14 }} />
                            </button>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12, marginTop: 16 }}>
                            <FilterDateTimeInput
                                label={t('nav.filterExactStartTime')}
                                value={exactTimeDraftStartAt}
                                onChange={setExactTimeDraftStartAt}
                                minWidth={0}
                            />
                            <FilterDateTimeInput
                                label={t('nav.filterExactEndTime')}
                                value={exactTimeDraftEndAt}
                                onChange={setExactTimeDraftEndAt}
                                minWidth={0}
                            />
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
                            <Btn
                                variant="outline"
                                onClick={() => setIsExactTimeDialogOpen(false)}
                            >
                                {t('common.cancel')}
                            </Btn>
                            <Btn
                                variant="default"
                                onClick={() => {
                                    setExecutionTime('exact');
                                    setExactStartAt(exactTimeDraftStartAt);
                                    setExactEndAt(exactTimeDraftEndAt);
                                    setIsExactTimeDialogOpen(false);
                                }}
                            >
                                {t('common.confirm')}
                            </Btn>
                        </div>
                    </div>
                </div>
            )}
            
            <RegisterAgentDialog
                isOpen={isRegisterDialogOpen}
                onClose={() => { setIsRegisterDialogOpen(false); setConvertTarget(null); }}
                onSuccess={() => { fetchDbAgents(); setConvertTarget(null); }}
                initialName={convertTarget?.name}
                initialPlatform={convertTarget?.platform}
            />

            <AnimatePresence>
                {deleteTarget && (
                    <div
                        style={{
                            position: 'fixed',
                            inset: 0,
                            background: 'rgba(15, 23, 42, 0.45)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: 20,
                            zIndex: 1000,
                        }}
                        onClick={() => !isDeleting && setDeleteTarget(null)}
                    >
                        <motion.div
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            style={{
                                width: 'min(400px, 100%)',
                                borderRadius: 16,
                                border: '1px solid var(--border)',
                                background: 'var(--background)',
                                boxShadow: '0 24px 60px rgba(0,0,0,0.18)',
                                padding: 24,
                                boxSizing: 'border-box',
                            }}
                            onClick={(e) => e.stopPropagation()}
                        >
                            <h2 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 600, color: 'var(--foreground)' }}>
                                确认删除
                            </h2>
                            <p style={{ margin: '0 0 20px', fontSize: 14, color: 'var(--foreground-secondary)', lineHeight: 1.5 }}>
                                确定要删除 Agent <strong style={{ color: 'var(--foreground)' }}>{deleteTarget.name}</strong> 吗？此操作将一并删除其产生的所有 Trace 数据，且不可恢复。
                            </p>
                            {deleteError && (
                                <div style={{ marginBottom: 16, padding: 10, borderRadius: 8, background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', fontSize: 13 }}>
                                    {deleteError}
                                </div>
                            )}
                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                                <Btn variant="outline" onClick={() => setDeleteTarget(null)} disabled={isDeleting}>
                                    取消
                                </Btn>
                                <Btn variant="default" style={{ background: '#ef4444', borderColor: '#ef4444', color: '#fff' }} onClick={handleDeleteConfirm} disabled={isDeleting}>
                                    {isDeleting ? <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} /> : '确认删除'}
                                </Btn>
                            </div>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>
        </div>
    );
}

export default function AgentsPage() {
    return (
        <Suspense fallback={<div style={{ padding: 24, color: 'var(--foreground-muted)' }}>Loading…</div>}>
            <AgentsPageInner />
        </Suspense>
    );
}

// ============================================================
// 卡片组件
// ============================================================

function AgentCard({ agent, onConvert, onDelete }: { agent: Agent; onConvert?: () => void; onDelete?: () => void }) {
    const { t } = useLocale();
    const router = useRouter();
    const [hover, setHover] = useState(false);

    const isUnregistered = agent.ownership === 'unregistered';
    const relativeExecution = getRelativeTimeParts(agent.lastExecutedAt);
    const relativeDiscovery = agent.discoveryTime ? getRelativeTimeParts(agent.discoveryTime) : null;

    const formatRelativeLabel = (value: ReturnType<typeof getRelativeTimeParts>) => {
        if (value.unit === 'minutes') {
            return t('nav.minutesAgo', { count: value.value.toString() });
        }

        if (value.unit === 'hours') {
            return t('nav.hoursAgo', { count: value.value.toString() });
        }

        return t('nav.daysAgo', { count: value.value.toString() });
    };

    const iconColor =
        agent.layer === 'subagent' ? '#d97706' :
        agent.ownership === 'system' ? 'var(--primary)' :
        'var(--tag-green-fg, #0F6E56)';

    const iconBg =
        agent.layer === 'subagent' ? 'rgba(251, 191, 36, 0.12)' :
        agent.ownership === 'system' ? 'var(--primary-subtle, rgba(99, 102, 241, 0.1))' :
        'var(--tag-green-bg, #E1F5EE)';

    const Icon =
        agent.layer === 'subagent' ? Network :
        agent.ownership === 'system' ? Users :
        Database;

    const tagVariant: 'default' | 'secondary' | 'outline' =
        agent.ownership === 'system' ? 'default' :
        agent.ownership === 'user' ? 'secondary' :
        'outline';

    const cardStyle: React.CSSProperties = {
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 8,
        border: isUnregistered ? '1px dashed var(--border)' : '1px solid var(--border)',
        background: 'var(--card-bg, var(--background))',
        padding: 16,
        opacity: isUnregistered ? 0.92 : 1,
        boxShadow: hover ? '0 4px 12px rgba(0,0,0,0.06)' : 'none',
        borderColor: hover ? 'var(--primary)' : 'var(--border)',
        transition: 'box-shadow 0.2s, border-color 0.2s',
        boxSizing: 'border-box',
    };

    const renderStatusBadge = () => {
        if (agent.status === 'running') {
            return (
                <span style={{
                    flexShrink: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    height: 20,
                    padding: '0 8px',
                    borderRadius: 10,
                    border: '1px solid #bbf7d0',
                    background: 'rgba(240, 253, 244, 0.5)',
                    color: '#16a34a',
                    fontSize: 10,
                    fontWeight: 500,
                    lineHeight: 1,
                }}>
                    {t('nav.statusRunning')}
                </span>
            );
        }
        if (agent.status === 'idle') {
            return (
                <span style={{
                    flexShrink: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    height: 20,
                    padding: '0 8px',
                    borderRadius: 10,
                    border: '1px solid #e5e7eb',
                    background: 'rgba(249, 250, 251, 0.5)',
                    color: '#6b7280',
                    fontSize: 10,
                    fontWeight: 500,
                    lineHeight: 1,
                }}>
                    {t('nav.statusIdle')}
                </span>
            );
        }
        return null;
    };

    const labelStyle: React.CSSProperties = {
        fontSize: 9,
        color: 'var(--foreground-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        fontWeight: 500,
    };

    const valueStyle: React.CSSProperties = {
        fontSize: 13,
        fontWeight: 700,
        lineHeight: 1,
        color: 'var(--foreground)',
    };

    return (
        <div
            style={cardStyle}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
        >
            {/* Header row */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{
                    width: 36,
                    height: 36,
                    borderRadius: 8,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    background: iconBg,
                }}>
                    <Icon style={{ width: 16, height: 16, color: iconColor }} />
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span
                            style={{
                                fontSize: 13,
                                fontWeight: 600,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                maxWidth: 160,
                                color: 'var(--foreground)',
                            }}
                            title={agent.name}
                        >
                            {agent.name}
                        </span>
                        <Tag variant={tagVariant}>
                            {t(`nav.${agent.ownership}Agent`)}
                        </Tag>
                        <Tag variant="outline" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 10 }}>
                            {agent.layer === 'subagent' ? t('nav.subAgent') : t('nav.mainAgent')}
                        </Tag>
                        <Tag variant="outline" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 10 }}>
                            {agent.platform}
                        </Tag>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--foreground-muted)', marginTop: 4 }}>
                        {isUnregistered && relativeDiscovery
                            ? `${t('nav.discoveredAt')} ${formatRelativeLabel(relativeDiscovery)}`
                            : `${agent.version} · ${agent.framework}`}
                    </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {!isUnregistered && renderStatusBadge()}
                    {agent.ownership !== 'system' && (
                        <button
                            title="删除 Agent"
                            onClick={(e) => {
                                e.stopPropagation();
                                onDelete?.();
                            }}
                            style={{
                                background: 'transparent',
                                border: 'none',
                                cursor: 'pointer',
                                color: 'var(--foreground-muted)',
                                padding: 4,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                            }}
                        >
                            <Trash2 style={{ width: 14, height: 14, opacity: hover ? 1 : 0.4, transition: 'opacity 0.2s' }} />
                        </button>
                    )}
                </div>
            </div>

            {/* Parent Agent (subagent) */}
            {agent.parentAgent && (
                <div style={{
                    marginTop: 12,
                    fontSize: 10,
                    color: 'var(--foreground-muted)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    background: 'rgba(0,0,0,0.04)',
                    padding: '6px 8px',
                    borderRadius: 6,
                }}>
                    <ArrowRight style={{ width: 10, height: 10, flexShrink: 0 }} />
                    <span style={{ flexShrink: 0 }}>{t('nav.parentAgent')}:</span>
                    <span style={{
                        fontWeight: 600,
                        color: 'var(--primary)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                    }}>
                        {agent.parentAgent}
                    </span>
                </div>
            )}

            {/* Stats */}
            {!isUnregistered && (
                <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(70px, 1fr))',
                    gap: 14,
                    marginTop: 12,
                    paddingTop: 12,
                    borderTop: '1px solid var(--border)',
                }}>
                    {agent.successRate && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <span style={labelStyle}>{t('nav.successRate')}</span>
                            <span style={valueStyle}>{agent.successRate}</span>
                        </div>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span style={labelStyle}>{t('nav.lastExecuted')}</span>
                        <span style={valueStyle}>{formatRelativeLabel(relativeExecution)}</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span style={labelStyle}>{t('nav.todayCalls')}</span>
                        <span style={valueStyle}>{agent.todayCalls}</span>
                    </div>
                    {agent.p99 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <span style={labelStyle}>P99</span>
                            <span style={valueStyle}>{agent.p99}</span>
                        </div>
                    )}
                </div>
            )}

            {/* Spacer */}
            <div style={{ flex: 1, minHeight: 12 }} />

            {/* Actions */}
            <div style={{ display: 'flex', gap: 8, marginTop: isUnregistered ? 16 : 12 }}>
                {isUnregistered ? (
                    <Btn
                        variant="default"
                        size="sm"
                        fullWidth
                        style={{ height: 32 }}
                        onClick={(e) => { e.stopPropagation(); onConvert?.(); }}
                    >
                        <CheckCircle2 style={{ width: 14, height: 14 }} />
                        {t('nav.convertNow')}
                    </Btn>
                ) : (
                    <>
                        <Btn
                            variant="outline"
                            size="sm"
                            style={{ flex: 1 }}
                            onClick={(e) => {
                                e.stopPropagation();
                                router.push(`/trace?agent=${encodeURIComponent(agent.name)}`);
                            }}
                        >
                            {t('nav.agentTrace')}
                        </Btn>
                        <Btn
                            variant={agent.layer === 'subagent' ? 'outline' : 'secondary'}
                            size="sm"
                            style={{ flex: 1 }}
                            onClick={(e) => {
                                e.stopPropagation();
                                router.push(`/fault?agent=${encodeURIComponent(agent.name)}`);
                            }}
                        >
                            {agent.layer === 'subagent' ? t('nav.details') : t('nav.diagnosis')}
                        </Btn>
                    </>
                )}
            </div>
        </div>
    );
}
