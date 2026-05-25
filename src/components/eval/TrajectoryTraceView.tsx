'use client';

/**
 * 评测详情下的 trace 链路观测视图
 * 路由：/eval/trajectory/[traceId]/trace?runId=...&datasetId=...
 *
 * 顶部「< 返回评测详情」会带回原详情页（含 runId/datasetId 上下文），
 * 不破坏 /trace 主页面，只复用 AgentTraceView 组件渲染该 traceId 的 interactions。
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import AgentTraceView from '@/components/observe/AgentTraceView';
import { apiFetch } from '@/lib/client/api';

const COLORS = {
    primary: '#534AB7',
    border: '#eceae4',
    text: '#1a1a18',
    textSecondary: '#2c2b28',
    textMuted: '#6b6a66',
    danger: '#A32D2D',
    dangerSubtle: '#FFEBEB',
};

export default function TrajectoryTraceView({ traceId }: { traceId: string }) {
    const router = useRouter();
    const params = useSearchParams();
    const runId = params?.get('runId') || '';
    const datasetId = params?.get('datasetId') || '';
    const autoWatchOnly = params?.get('autoWatchOnly') === '1' || params?.get('autoWatchOnly') === 'true';

    const [interactions, setInteractions] = useState<any[] | null>(null);
    const [meta, setMeta] = useState<{ query?: string; framework?: string; model?: string } | null>(null);
    const [error, setError] = useState<string>('');
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!traceId) return;
        let cancelled = false;
        (async () => {
            try {
                // 拉 session（含 interactions）
                const sessionRes = await apiFetch(
                    `/api/observe/session?taskId=${encodeURIComponent(traceId)}`,
                );
                if (!sessionRes.ok) throw new Error(`session API ${sessionRes.status}`);
                const session = await sessionRes.json();
                const arr = Array.isArray(session?.interactions) ? session.interactions : [];
                if (!cancelled) {
                    setInteractions(arr);
                    setMeta({
                        query: session?.query,
                        model: session?.model,
                    });
                }
                // 拉 execution 拿 framework
                try {
                    const execRes = await apiFetch(`/api/observe/task-stats?taskId=${encodeURIComponent(traceId)}`);
                    if (execRes.ok) {
                        const execJ = await execRes.json();
                        if (!cancelled && execJ?.found) {
                            setMeta(prev => ({ ...prev, framework: execJ.framework }));
                        }
                    }
                } catch {
                    /* ignore */
                }
            } catch (e: any) {
                if (!cancelled) setError(`加载链路失败：${e?.message || e}`);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [traceId]);

    function goBack() {
        const qs: string[] = [];
        if (runId) qs.push(`runId=${encodeURIComponent(runId)}`);
        if (datasetId) qs.push(`datasetId=${encodeURIComponent(datasetId)}`);
        if (autoWatchOnly) qs.push('autoWatchOnly=1');
        const suffix = qs.length > 0 ? `?${qs.join('&')}` : '';
        router.push(`/eval/trajectory/${encodeURIComponent(traceId)}${suffix}`);
    }

    return (
        <div style={{ padding: '18px 22px 28px', maxWidth: 1480, margin: '0 auto', color: COLORS.text }}>
            {/* 顶部：返回 + meta */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                <button onClick={goBack} style={btnSmallStyle()}>{`< 返回评测详情`}</button>
                <span style={{ height: 14, width: 1, background: COLORS.border }} />
                <div style={{ fontSize: 14, fontWeight: 600 }}>链路观测</div>
                <code style={{ fontSize: 11.5, color: COLORS.textMuted, fontFamily: 'monospace' }}>{traceId}</code>
                <div style={{ flex: 1 }} />
                {meta?.framework ? (
                    <span style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: 'monospace' }}>
                        {meta.framework}{meta.model ? ` · ${meta.model}` : ''}
                    </span>
                ) : null}
            </div>

            {meta?.query ? (
                <div style={{
                    background: '#FBFAF6',
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 7,
                    padding: '8px 12px',
                    marginBottom: 12,
                    fontSize: 12,
                    color: COLORS.textSecondary,
                }}>
                    <span style={{ color: COLORS.textMuted, marginRight: 6 }}>任务：</span>{meta.query}
                </div>
            ) : null}

            {error && (
                <div style={{
                    padding: 10,
                    background: COLORS.dangerSubtle,
                    border: `1px solid #FFD4D4`,
                    color: COLORS.danger,
                    borderRadius: 6,
                    fontSize: 12,
                    marginBottom: 12,
                }}>
                    {error}
                </div>
            )}

            {loading ? (
                <div style={{ padding: 24, color: COLORS.textMuted }}>加载链路数据中...</div>
            ) : interactions === null || interactions.length === 0 ? (
                <div style={{
                    padding: 24,
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 8,
                    color: COLORS.textMuted,
                    textAlign: 'center',
                }}>
                    该 trace 没有 interactions 数据（traceId={traceId}）
                </div>
            ) : (
                <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 8, background: '#fff', overflow: 'hidden' }}>
                    <AgentTraceView interactions={interactions} />
                </div>
            )}
        </div>
    );
}

function btnSmallStyle(): CSSProperties {
    return {
        padding: '4px 10px',
        background: '#fff',
        color: COLORS.textSecondary,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 5,
        fontSize: 12,
        cursor: 'pointer',
    };
}
