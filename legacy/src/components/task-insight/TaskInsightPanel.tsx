/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use client';

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';

import { formatDurationMs } from '@/lib/latency-format';
import { formatAbsoluteLocalTime } from '@/lib/time-format';
import {
    TASK_CATEGORY_DEFINITIONS,
    type TaskInsightRange,
    type TaskInsightResponse,
    type TaskInsightRow,
} from '@/lib/task-insight/types';

const basePath = process.env.NEXT_PUBLIC_URL_PREFIX || '';

const RANGES: Array<{ value: TaskInsightRange; label: string }> = [
    { value: '7', label: '7 天' },
    { value: '30', label: '30 天' },
    { value: '90', label: '90 天' },
    { value: 'all', label: '全部' },
];

const LONG_REASON_LABELS: Record<string, string> = {
    latency: '耗时',
    tokens: 'Token',
    tool_calls: '工具调用',
    llm_calls: 'LLM 调用',
};

function formatCount(value: number): string {
    return Math.round(value).toLocaleString('zh-CN');
}

function formatTokens(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return '0';
    if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
    return String(Math.round(value));
}

function formatCost(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return '—';
    return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}

function formatPercent(value: number): string {
    return `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
}

function formatTime(value: string): string {
    return formatAbsoluteLocalTime(value) || '—';
}

export function TaskInsightPanel() {
    const [range, setRange] = useState<TaskInsightRange>('7');
    const [data, setData] = useState<TaskInsightResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [reloadToken, setReloadToken] = useState(0);

    useEffect(() => {
        const ctrl = new AbortController();
        const apiKey = typeof window !== 'undefined' ? localStorage.getItem('api_key') || '' : '';
        fetch(`${basePath}/api/observe/task-insight?range=${range}`, {
            headers: { 'x-witty-api-key': apiKey },
            signal: ctrl.signal,
        })
            .then(response => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
            .then((payload: TaskInsightResponse) => {
                setData(payload);
                setLoading(false);
            })
            .catch((caught: Error) => {
                if (caught.name === 'AbortError') return;
                setError('加载失败，请重试');
                setLoading(false);
            });

        return () => ctrl.abort();
    }, [range, reloadToken]);

    const retry = useCallback(() => {
        setLoading(true);
        setError(null);
        setReloadToken(token => token + 1);
    }, []);

    const selectRange = useCallback((next: TaskInsightRange) => {
        setLoading(true);
        setError(null);
        setRange(next);
    }, []);

    return (
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1400 }}>
            <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
                <div>
                    <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Token 与任务分析</h1>
                    <p style={{ fontSize: 'var(--text-sm)', color: 'var(--foreground-muted)', margin: '4px 0 0' }}>
                        基于 root trace 归纳 Token 消耗、任务类型与长短时判定，并识别可放到夜间执行的长时任务 · Asia/Shanghai
                    </p>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                    {RANGES.map(item => (
                        <button
                            key={item.value}
                            onClick={() => selectRange(item.value)}
                            data-active={range === item.value}
                            className="ai-filter-chip"
                        >
                            {item.label}
                        </button>
                    ))}
                </div>
            </header>

            {data && !loading && (
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 'var(--text-sm)', color: 'var(--foreground-muted)' }}>
                    <span>统计周期：{data.from ? formatTime(data.from) : '—'} 至 {formatTime(data.to)}</span>
                    <span>分析任务：{formatCount(data.analyzedTraces)} 条 root trace</span>
                    <span>用户：{formatCount(data.totals.users)}</span>
                </div>
            )}

            {error && (
                <div
                    style={{
                        border: '1px solid var(--error-subtle-border)',
                        background: 'var(--error-subtle)',
                        color: 'var(--error-foreground)',
                        borderRadius: 'var(--radius-md)',
                        padding: '12px 14px',
                        fontSize: 'var(--text-sm)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 12,
                    }}
                >
                    <span>{error}</span>
                    <button onClick={retry} className="ai-chip" style={{ cursor: 'pointer' }}>重试</button>
                </div>
            )}

            {loading && <div style={{ color: 'var(--foreground-muted)', fontSize: 'var(--text-sm)' }}>加载中…</div>}

            {data && !loading && !error && <TaskInsightContent data={data} />}
        </div>
    );
}

function TaskInsightContent({ data }: { data: TaskInsightResponse }) {
    const longBucket = data.lengthSplit.find(item => item.key === 'long');
    const shortBucket = data.lengthSplit.find(item => item.key === 'short');
    const maxHourTokens = useMemo(
        () => Math.max(...data.hours.map(item => item.tokens), 1),
        [data.hours],
    );

    if (data.analyzedTraces === 0) {
        return (
            <Card>
                <div style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}>当前时间窗内没有可分析的 root trace</div>
                <p style={{ fontSize: 'var(--text-sm)', color: 'var(--foreground-muted)', margin: '6px 0 0' }}>
                    先接入 Agent Trace，或切换到更长的时间范围。
                </p>
            </Card>
        );
    }

    return (
        <>
            {data.truncated && (
                <Notice level="warning">
                    数据量超过单次分析上限，当前仅分析最近 {formatCount(data.maxTraces)} 条 root trace；更早数据请缩短时间范围。
                </Notice>
            )}
            {data.pricingMissingModels.length > 0 && (
                <Notice level="warning">
                    以下模型未配置单价，成本按 0 估算：{data.pricingMissingModels.join('、')}。可在模型注册中补充价格。
                </Notice>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                <KpiCard label="分析任务" value={formatCount(data.totals.traces)} hint={`${formatCount(data.totals.users)} 位用户`} />
                <KpiCard label="Token 总量" value={formatTokens(data.totals.tokens)} hint={`输入 ${formatTokens(data.totals.inputTokens)} · 输出 ${formatTokens(data.totals.outputTokens)}`} />
                <KpiCard label="长时任务" value={formatCount(data.totals.longTraces)} hint={`占全部任务 ${formatPercent(longBucket?.traceShare ?? 0)}`} />
                <KpiCard label="可延后长任务" value={formatCount(data.totals.deferrableLongTraces)} hint={`Token ${formatTokens(data.deferral.candidateTokens)}`} />
                <KpiCard label="平均耗时" value={formatDurationMs(data.totals.avgLatencyMs)} hint={`P95 ${formatDurationMs(data.totals.p95LatencyMs)}`} />
                <KpiCard label="估算成本" value={formatCost(data.totals.cost)} hint="按模型单价估算" />
            </div>

            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--foreground-muted)' }}>
                长时判定：耗时 ≥ {formatDurationMs(data.thresholds.longLatencyMs)}，或 Token ≥ {formatCount(data.thresholds.longTokens)}，
                或工具调用 ≥ {formatCount(data.thresholds.longToolCalls)}，或 LLM 调用 ≥ {formatCount(data.thresholds.longLlmCalls)}。
                长任务默认视为可延后；出现“立即 / 今天必须 / 尽快”等实时要求时不计入。
            </div>

            <Card>
                <CardHeader title="任务类型分布" subtitle="按 query 内容与工具调用行为归类" />
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
                        <thead>
                            <tr style={{ color: 'var(--foreground-muted)', textAlign: 'left' }}>
                                <Th>类型</Th>
                                <Th align="right">任务数</Th>
                                <Th align="right">任务占比</Th>
                                <Th align="right">Token</Th>
                                <Th align="right">Token 占比</Th>
                                <Th align="right">估算成本</Th>
                                <Th align="right">平均耗时</Th>
                                <Th align="right">长任务</Th>
                                <Th align="right">可延后</Th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.categories.map(category => {
                                const definition = TASK_CATEGORY_DEFINITIONS.find(item => item.key === category.key);
                                return (
                                    <tr key={category.key} style={{ borderTop: '1px solid var(--border)' }}>
                                        <Td>
                                            <span title={definition?.description}>{category.label}</span>
                                        </Td>
                                        <Td align="right">{formatCount(category.traces)}</Td>
                                        <Td align="right">{formatPercent(category.traceShare)}</Td>
                                        <Td align="right" title={formatCount(category.tokens)}>{formatTokens(category.tokens)}</Td>
                                        <Td align="right">{formatPercent(category.tokenShare)}</Td>
                                        <Td align="right">{formatCost(category.cost)}</Td>
                                        <Td align="right">{formatDurationMs(category.avgLatencyMs)}</Td>
                                        <Td align="right">{formatCount(category.longTraces)}</Td>
                                        <Td align="right">{formatCount(category.deferrableTraces)}</Td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </Card>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
                <Card>
                    <CardHeader title="长时 / 短时拆分" subtitle="任务数与 Token 占比" />
                    <SplitRow bucket={longBucket} tone="warning" />
                    <SplitRow bucket={shortBucket} tone="success" />
                </Card>
                <Card>
                    <CardHeader title="长时判定原因" subtitle="同一任务可命中多个维度" />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {data.longReasonCounts.map(item => (
                            <ReasonRow key={item.key} label={item.label} count={item.count} total={data.totals.longTraces} />
                        ))}
                    </div>
                </Card>
            </div>

            <Card>
                <CardHeader title="时段分布" subtitle="按 Asia/Shanghai 小时聚合 Token；22:00–06:00 为建议夜间窗口" />
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 150, paddingTop: 8 }}>
                    {data.hours.map(item => {
                        const night = item.hour >= 22 || item.hour < 6;
                        const height = Math.max(2, Math.round((item.tokens / maxHourTokens) * 118));
                        return (
                            <div
                                key={item.hour}
                                title={`${String(item.hour).padStart(2, '0')}:00 · 任务 ${item.traces} · Token ${formatTokens(item.tokens)} · 长任务 ${item.longTraces}`}
                                style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 10 }}
                            >
                                <div
                                    style={{
                                        width: '100%',
                                        height,
                                        background: night ? 'var(--primary)' : 'var(--primary-subtle-border)',
                                        borderRadius: 2,
                                    }}
                                />
                                <span style={{ fontSize: 10, color: night ? 'var(--primary)' : 'var(--foreground-muted)' }}>
                                    {item.hour % 3 === 0 ? item.hour : ''}
                                </span>
                            </div>
                        );
                    })}
                </div>
            </Card>

            <Card>
                <CardHeader title="调度建议" subtitle="把可延后的长时任务移到夜间低峰" />
                <DeferralAdvice data={data} />
            </Card>

            <Card>
                <CardHeader title="用户 Token 分布" subtitle={`Token 最高的 ${data.users.length} 位用户`} />
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
                        <thead>
                            <tr style={{ color: 'var(--foreground-muted)', textAlign: 'left' }}>
                                <Th>用户</Th>
                                <Th align="right">任务数</Th>
                                <Th align="right">Token</Th>
                                <Th align="right">长任务</Th>
                                <Th align="right">估算成本</Th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.users.map(user => (
                                <tr key={user.user} style={{ borderTop: '1px solid var(--border)' }}>
                                    <Td>{user.user}</Td>
                                    <Td align="right">{formatCount(user.traces)}</Td>
                                    <Td align="right" title={formatCount(user.tokens)}>{formatTokens(user.tokens)}</Td>
                                    <Td align="right">{formatCount(user.longTraces)}</Td>
                                    <Td align="right">{formatCost(user.cost)}</Td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </Card>

            <TaskTable
                title="Token 消耗最高的任务"
                subtitle="按总 Token 倒序"
                rows={data.topTasks}
            />
            <TaskTable
                title="耗时最长的任务"
                subtitle="按墙钟耗时倒序"
                rows={data.slowestTasks}
            />
            <TaskTable
                title="可延后长时任务"
                subtitle="长时且无实时要求，建议移到夜间窗口"
                rows={data.deferrableTasks}
                emphasizeDeferral
            />
        </>
    );
}

function SplitRow({
    bucket,
    tone,
}: {
    bucket: TaskInsightResponse['lengthSplit'][number] | undefined;
    tone: 'warning' | 'success';
}) {
    if (!bucket) return null;
    const color = tone === 'warning' ? 'var(--warning)' : 'var(--success)';
    return (
        <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)', marginBottom: 6 }}>
                <span style={{ fontWeight: 500 }}>{bucket.label}</span>
                <span style={{ color: 'var(--foreground-muted)' }}>
                    {formatCount(bucket.traces)} 个 · {formatPercent(bucket.traceShare)} · Token {formatTokens(bucket.tokens)}（{formatPercent(bucket.tokenShare)}）
                </span>
            </div>
            <div style={{ height: 8, background: 'var(--background-secondary)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ width: `${Math.min(100, bucket.traceShare)}%`, height: '100%', background: color }} />
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--foreground-muted)', marginTop: 4 }}>
                平均耗时 {formatDurationMs(bucket.avgLatencyMs)} · 估算成本 {formatCost(bucket.cost)}
            </div>
        </div>
    );
}

function ReasonRow({ label, count, total }: { label: string; count: number; total: number }) {
    const percent = total > 0 ? Math.round((count / total) * 1000) / 10 : 0;
    return (
        <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)', marginBottom: 4 }}>
                <span>{label}</span>
                <span style={{ color: 'var(--foreground-muted)' }}>{formatCount(count)} 个 · {formatPercent(percent)}</span>
            </div>
            <div style={{ height: 6, background: 'var(--background-secondary)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${Math.min(100, percent)}%`, height: '100%', background: 'var(--warning)' }} />
            </div>
        </div>
    );
}

function DeferralAdvice({ data }: { data: TaskInsightResponse }) {
    const deferral = data.deferral;
    const longCount = data.totals.longTraces;
    const longShare = longCount > 0 ? Math.round((deferral.candidateTraces / longCount) * 1000) / 10 : 0;

    if (deferral.candidateTraces === 0) {
        return (
            <p style={{ fontSize: 'var(--text-sm)', color: 'var(--foreground-muted)', margin: 0 }}>
                当前时间窗内没有识别到可延后的长时任务。若任务普遍较短，实时执行即可；也可以在更长时间范围或更严格的阈值下复核。
            </p>
        );
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div
                style={{
                    borderLeft: '3px solid var(--primary)',
                    background: 'var(--primary-subtle)',
                    borderRadius: 'var(--radius-md)',
                    padding: '12px 14px',
                    fontSize: 'var(--text-sm)',
                    lineHeight: 1.7,
                }}
            >
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                    建议窗口：{deferral.recommendedWindow}（夜间低峰）
                </div>
                <div>
                    可延后长任务 {formatCount(deferral.candidateTraces)} 个，占长任务 {formatPercent(longShare)}，
                    合计 {formatTokens(deferral.candidateTokens)} Token、累计耗时 {formatDurationMs(deferral.candidateLatencyMs)}。
                </div>
                <div>
                    其中 {formatCount(deferral.daytimeTraces)} 个当前在 09:00–18:00 执行，累计耗时 {formatDurationMs(deferral.daytimeLatencyMs)}；
                    迁移到夜间可减少日间峰值并发与同步等待。
                </div>
                <div style={{ color: 'var(--foreground-muted)' }}>
                    时段迁移不会减少 Token 总量本身；要降低成本仍需结合模型路由、缓存与失败重试治理。
                </div>
            </div>
            <div>
                <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, marginBottom: 8 }}>建议优先迁移的类型</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {deferral.byCategory.slice(0, 5).map(item => (
                        <span
                            key={item.key}
                            className="ai-chip"
                            style={{ cursor: 'default' }}
                            title={`${item.traces} 个任务，${formatTokens(item.tokens)} Token`}
                        >
                            {item.label} · {formatCount(item.traces)} 个 · {formatTokens(item.tokens)} Token
                        </span>
                    ))}
                </div>
            </div>
        </div>
    );
}

function TaskTable({
    title,
    subtitle,
    rows,
    emphasizeDeferral = false,
}: {
    title: string;
    subtitle: string;
    rows: TaskInsightRow[];
    emphasizeDeferral?: boolean;
}) {
    return (
        <Card>
            <CardHeader title={title} subtitle={subtitle} />
            {rows.length === 0 ? (
                <p style={{ fontSize: 'var(--text-sm)', color: 'var(--foreground-muted)', margin: 0 }}>暂无任务。</p>
            ) : (
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
                        <thead>
                            <tr style={{ color: 'var(--foreground-muted)', textAlign: 'left' }}>
                                <Th style={{ minWidth: 260 }}>任务</Th>
                                <Th>类型</Th>
                                <Th>判定</Th>
                                <Th align="right">耗时</Th>
                                <Th align="right">Token</Th>
                                <Th align="right">工具 / LLM</Th>
                                <Th>用户</Th>
                                <Th>时间</Th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(row => (
                                <tr key={row.id} style={{ borderTop: '1px solid var(--border)' }}>
                                    <Td style={{ maxWidth: 380 }}>
                                        <div
                                            title={row.query || undefined}
                                            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                        >
                                            {row.query || '（无 query）'}
                                        </div>
                                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--foreground-muted)', marginTop: 2 }}>
                                            {row.agentName}{row.taskId ? ` · ${row.taskId}` : ''}
                                        </div>
                                    </Td>
                                    <Td><span className="ai-chip" style={{ cursor: 'default' }}>{row.categoryLabel}</span></Td>
                                    <Td>
                                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                            <Badge tone={row.length === 'long' ? 'warning' : 'success'}>
                                                {row.length === 'long' ? '长时' : '短时'}
                                            </Badge>
                                            {emphasizeDeferral && row.deferrable && <Badge tone="primary">可延后</Badge>}
                                        </div>
                                        {row.longReasons.length > 0 && (
                                            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--foreground-muted)', marginTop: 3 }}>
                                                {row.longReasons.map(reason => LONG_REASON_LABELS[reason]).join(' / ')}
                                            </div>
                                        )}
                                    </Td>
                                    <Td align="right">{formatDurationMs(row.latencyMs)}</Td>
                                    <Td align="right" title={formatCount(row.tokens)}>{formatTokens(row.tokens)}</Td>
                                    <Td align="right">{formatCount(row.toolCallCount)} / {formatCount(row.llmCallCount)}</Td>
                                    <Td>{row.user}</Td>
                                    <Td style={{ whiteSpace: 'nowrap' }}>{formatTime(row.timestamp)}</Td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </Card>
    );
}

function Notice({ level, children }: { level: 'warning' | 'error'; children: ReactNode }) {
    const warning = level === 'warning';
    return (
        <div
            style={{
                border: `1px solid ${warning ? 'var(--warning-subtle-border)' : 'var(--error-subtle-border)'}`,
                background: warning ? 'var(--warning-subtle)' : 'var(--error-subtle)',
                color: warning ? 'var(--warning)' : 'var(--error-foreground)',
                borderRadius: 'var(--radius-md)',
                padding: '10px 14px',
                fontSize: 'var(--text-sm)',
            }}
        >
            {children}
        </div>
    );
}

function Badge({ tone, children }: { tone: 'primary' | 'warning' | 'success'; children: ReactNode }) {
    const styles: Record<typeof tone, CSSProperties> = {
        primary: {
            background: 'var(--primary-subtle)',
            border: '1px solid var(--primary-subtle-border)',
            color: 'var(--primary)',
        },
        warning: {
            background: 'var(--warning-subtle)',
            border: '1px solid var(--warning-subtle-border)',
            color: 'var(--warning)',
        },
        success: {
            background: 'var(--success-subtle)',
            border: '1px solid var(--success-subtle-border)',
            color: 'var(--success)',
        },
    };
    return (
        <span
            style={{
                display: 'inline-block',
                padding: '1px 7px',
                borderRadius: 999,
                fontSize: 'var(--text-xs)',
                lineHeight: 1.6,
                whiteSpace: 'nowrap',
                ...styles[tone],
            }}
        >
            {children}
        </span>
    );
}

function KpiCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
    return (
        <div
            style={{
                border: '1px solid var(--card-border)',
                borderRadius: 'var(--radius-lg)',
                background: 'var(--card-bg)',
                padding: '14px 16px',
            }}
        >
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--foreground-muted)' }}>{label}</div>
            <div style={{ fontSize: 26, fontWeight: 600, fontVariantNumeric: 'tabular-nums', marginTop: 6 }}>{value}</div>
            {hint && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--foreground-muted)', marginTop: 4 }}>{hint}</div>}
        </div>
    );
}

function Card({ children }: { children: ReactNode }) {
    return (
        <section
            style={{
                border: '1px solid var(--card-border)',
                borderRadius: 'var(--radius-lg)',
                background: 'var(--card-bg)',
                padding: 18,
            }}
        >
            {children}
        </section>
    );
}

function CardHeader({ title, subtitle }: { title: string; subtitle?: string }) {
    return (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            <div style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}>{title}</div>
            {subtitle && (
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--foreground-muted)' }}>{subtitle}</div>
            )}
        </div>
    );
}

function Th({ children, align = 'left', style }: { children?: ReactNode; align?: 'left' | 'right'; style?: CSSProperties }) {
    return <th style={{ padding: '8px 10px', textAlign: align, fontWeight: 500, whiteSpace: 'nowrap', ...style }}>{children}</th>;
}

function Td({
    children,
    align = 'left',
    style,
    title,
}: {
    children?: ReactNode;
    align?: 'left' | 'right';
    style?: CSSProperties;
    title?: string;
}) {
    return <td title={title} style={{ padding: '10px', textAlign: align, verticalAlign: 'top', ...style }}>{children}</td>;
}
