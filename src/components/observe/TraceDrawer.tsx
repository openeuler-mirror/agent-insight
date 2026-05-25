'use client';

import { useEffect, useState } from 'react';
import AgentTraceView from '@/components/observe/AgentTraceView';
import { useLocale } from '@/lib/client/locale-context';
import { apiFetch } from '@/lib/client/api';

const basePath = process.env.NEXT_PUBLIC_URL_PREFIX || '';

interface SessionPayload {
    interactions?: any[];
    error?: string;
}

export interface TraceDrawerExecutionMeta {
    taskId: string;
    query?: string;
    framework?: string;
    model?: string;
    latency?: number;
    tokens?: number;
    cost?: number;
    score?: number | null;
    isAnswerCorrect?: boolean;
    timestamp?: string | number;
}

export interface TraceDrawerProps {
    open: boolean;
    execution: TraceDrawerExecutionMeta | null;
    onClose: () => void;
}

/**
 * Right-side slide-out panel. Lazy-loads the session interactions for the
 * given execution and renders AgentTraceView inside it.
 */
export default function TraceDrawer({ open, execution, onClose }: TraceDrawerProps) {
    const { locale } = useLocale();
    const [session, setSession] = useState<SessionPayload | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!open || !execution?.taskId) {
            setSession(null);
            setLoading(false);
            return;
        }
        const taskId = execution.taskId;
        setLoading(true);
        apiFetch(`/api/observe/session?taskId=${encodeURIComponent(taskId)}`)
            .then(r => r.ok ? r.json() : { error: 'Fetch failed' })
            .then((j: SessionPayload) => setSession(j))
            .catch(() => setSession({ error: 'Network error' }))
            .finally(() => setLoading(false));
    }, [open, execution?.taskId]);

    // ESC to close
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    if (!open) return null;

    return (
        <>
            {/* Backdrop */}
            <div
                onClick={onClose}
                style={{
                    position: 'fixed',
                    inset: 0,
                    background: 'rgba(0,0,0,0.32)',
                    zIndex: 100,
                    transition: 'opacity 0.18s ease',
                }}
            />
            {/* Drawer */}
            <aside
                style={{
                    position: 'fixed',
                    top: 0,
                    right: 0,
                    bottom: 0,
                    width: 'min(60%, 960px)',
                    minWidth: 480,
                    background: 'var(--background)',
                    borderLeft: '1px solid var(--border)',
                    boxShadow: '-12px 0 32px -8px var(--shadow-color-lg)',
                    zIndex: 101,
                    display: 'flex',
                    flexDirection: 'column',
                    animation: 'aiDrawerSlideIn 0.22s cubic-bezier(0.32, 0.72, 0, 1)',
                }}
            >
                <Header execution={execution} onClose={onClose} locale={locale} />
                <Body
                    session={session}
                    loading={loading}
                    locale={locale}
                    taskId={execution?.taskId}
                    framework={execution?.framework}
                />
            </aside>
            <style>{`
                @keyframes aiDrawerSlideIn {
                    from { transform: translateX(100%); }
                    to { transform: translateX(0); }
                }
            `}</style>
        </>
    );
}

function Header({ execution, onClose, locale }: { execution: TraceDrawerExecutionMeta | null; onClose: () => void; locale: string }) {
    if (!execution) return null;
    const { taskId, query, framework, model, latency, tokens, cost, score, isAnswerCorrect, timestamp } = execution;
    const detailsLink = `${basePath}/details?framework=${encodeURIComponent(framework || '')}&expandTaskId=${taskId}`;
    const metricsLink = `${basePath}/metrics?taskId=${taskId}`;
    const debugLink = `${basePath}/skill-eval?taskId=${taskId}`;

    return (
        <div
            style={{
                padding: '14px 20px 12px',
                borderBottom: '1px solid var(--border)',
                background: 'var(--card-bg)',
                flexShrink: 0,
            }}
        >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 10.5, color: 'var(--foreground-muted)', display: 'flex', gap: 8, marginBottom: 4, alignItems: 'center' }}>
                        <span style={{ fontFamily: 'var(--font-mono)' }}>{taskId}</span>
                        {timestamp && <span>· {new Date(timestamp).toLocaleString()}</span>}
                    </div>
                    <div
                        style={{
                            fontSize: 13.5,
                            fontWeight: 500,
                            color: 'var(--foreground)',
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical' as any,
                            overflow: 'hidden',
                        }}
                        title={query}
                    >
                        {query || (locale === 'zh' ? '(无问题)' : '(no query)')}
                    </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <a
                        href={metricsLink}
                        className="ai-btn-s"
                        style={{ textDecoration: 'none', fontSize: 11 }}
                    >
                        {locale === 'zh' ? '指标 ↗' : 'Metrics ↗'}
                    </a>
                    <a
                        href={debugLink}
                        className="ai-btn-s"
                        style={{ textDecoration: 'none', fontSize: 11 }}
                    >
                        {locale === 'zh' ? '调测分析 ↗' : 'Skill diagnosis ↗'}
                    </a>
                    <a
                        href={detailsLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ai-btn-s"
                        style={{ textDecoration: 'none', fontSize: 11 }}
                    >
                        {locale === 'zh' ? '完整详情 ↗' : 'Full details ↗'}
                    </a>
                    <button
                        onClick={onClose}
                        title={locale === 'zh' ? '关闭 (Esc)' : 'Close (Esc)'}
                        style={{
                            width: 28,
                            height: 28,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: 'transparent',
                            border: '1px solid var(--border)',
                            borderRadius: 6,
                            color: 'var(--foreground-secondary)',
                            cursor: 'pointer',
                        }}
                    >
                        ✕
                    </button>
                </div>
            </div>

            <div
                style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 12,
                    fontSize: 11,
                    color: 'var(--foreground-secondary)',
                }}
            >
                {framework && (
                    <Pair label={locale === 'zh' ? '平台' : 'Platform'} value={framework} />
                )}
                {model && <Pair label={locale === 'zh' ? '模型' : 'Model'} value={model} />}
                {typeof latency === 'number' && (
                    <Pair label={locale === 'zh' ? '延迟' : 'Latency'} value={fmtSec(toDisplayLatencyMs(latency, framework))} />
                )}
                {typeof tokens === 'number' && tokens > 0 && (
                    <Pair label="Tokens" value={tokens.toLocaleString()} />
                )}
                {typeof cost === 'number' && cost > 0 && (
                    <Pair label={locale === 'zh' ? '成本' : 'Cost'} value={`$${cost.toFixed(4)}`} />
                )}
                {typeof score === 'number' && score !== null && (
                    <Pair
                        label={locale === 'zh' ? '准确率' : 'Score'}
                        value={`${Math.round(score * 100)}%`}
                        valueColor={isAnswerCorrect ? 'var(--success)' : 'var(--error)'}
                    />
                )}
            </div>
        </div>
    );
}

function Pair({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
    return (
        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'baseline' }}>
            <span style={{ color: 'var(--foreground-muted)' }}>{label}</span>
            <span style={{ color: valueColor || 'var(--foreground)', fontWeight: 500 }}>{value}</span>
        </span>
    );
}

function Body({
    session,
    loading,
    locale,
    taskId,
    framework,
}: {
    session: SessionPayload | null;
    loading: boolean;
    locale: string;
    taskId?: string;
    framework?: string;
}) {
    return (
        <div style={{ flex: 1, overflow: 'auto', padding: '14px 20px' }}>
            {loading && (
                <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--foreground-muted)', fontSize: 12 }}>
                    {locale === 'zh' ? '正在加载会话…' : 'Loading session…'}
                </div>
            )}
            {!loading && session?.error && (
                <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--error)', fontSize: 12 }}>
                    {session.error}
                </div>
            )}
            {!loading && session && !session.error && Array.isArray(session.interactions) && session.interactions.length > 0 && (
                <AgentTraceView interactions={session.interactions} />
            )}
            {!loading && session && !session.error && (!session.interactions || session.interactions.length === 0) && (
                <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--foreground-muted)', fontSize: 12 }}>
                    {locale === 'zh' ? '该执行没有可用的 interaction 数据' : 'No interaction data for this execution'}
                </div>
            )}
        </div>
    );
}

function fmtSec(ms: number): string {
    if (!ms || !Number.isFinite(ms)) return '-';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
}

function toDisplayLatencyMs(latency: number, framework?: string): number {
    const fw = (framework || '').toLowerCase();
    if ((fw === 'opencode' || fw === 'openhands' || fw === 'claude' || fw === 'claudecode') && latency > 0 && latency < 1000) return latency * 1000;
    return latency;
}
