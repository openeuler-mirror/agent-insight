'use client';

import React, { useState } from 'react';
import { ExternalLink, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useLocale } from '@/lib/client/locale-context';
import { useInferenceAnalysisConfig } from '@/lib/client/inference-analysis-context';
import { buildInferenceAnalysisUrl, type InferenceAnalysisConfig } from '@/lib/trace/inference-analysis-link';
import type { InferenceAnalysisTarget } from '@/lib/trace/inference-analysis';

export function InferenceAnalysisDetails({ target, locale, config = { status: 'unconfigured' } }: { target: InferenceAnalysisTarget; locale: string; config?: InferenceAnalysisConfig }) {
    const zh = locale === 'zh';
    const calls: NonNullable<InferenceAnalysisTarget['calls']> = target.calls ?? (target.callIds ?? []).map(callId => ({ callId }));
    const reasons = {
        unsupported: zh ? '此来源尚未接入推理关联。' : 'Inference correlation is not available for this source.',
        session: zh ? '缺少模型请求的会话标识。' : 'The model request session ID is missing.',
        response: zh ? '未采集到推理服务响应 ID，无法定位单次推理。失败尝试或本地错误消息可能没有此 ID。' : 'No inference response ID was collected. Failed attempts and local errors may not have one.',
        request: zh ? '未采集到发送给推理服务的请求 ID，无法定位单次推理。' : 'No request ID sent to the inference service was collected.',
    };
    const rows = [
        { label: zh ? '关联会话' : 'Sessions', values: target.sessionIds },
        { label: zh ? '响应 ID' : 'Response ID', values: target.responseId ? [target.responseId] : [] },
        { label: zh ? '请求 ID' : 'Request ID', values: target.requestId ? [target.requestId] : [] },
        { label: zh ? '尝试 ID' : 'Attempt IDs', values: target.attemptIds ?? [] },
    ].filter(row => row.values.length);
    return <div className="space-y-4">
        <p className="text-sm text-foreground-secondary">
            {target.unavailableReason ? reasons[target.unavailableReason] : calls.length
                ? (zh ? `共 ${calls.length} 次模型请求，每次可单独打开分析页面。` : `${calls.length} model requests. Open each analysis separately.`)
                : (zh ? '未采集到统一模型调用 ID，暂不能打开推理分析。' : 'No unified model call ID was collected. Analysis is unavailable.')}
        </p>
        {calls.length > 0 && <div className="max-h-72 space-y-2 overflow-y-auto">
            {calls.map((call, index) => {
                const href = buildInferenceAnalysisUrl(config, call.callId);
                const stateLabels: Record<string, string> = {
                    started: zh ? '请求进行中' : 'In progress',
                    completed: zh ? '响应已结束' : 'Response ended',
                    cancelled: zh ? '已取消' : 'Cancelled',
                    timeout: zh ? '请求超时' : 'Timed out',
                    stream_error: zh ? '响应中断' : 'Stream interrupted',
                    transport_error: zh ? '连接失败' : 'Connection failed',
                };
                return <div key={call.callId} className="rounded-md border border-border bg-background-secondary p-3">
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-foreground-secondary">
                            <span className="font-medium text-foreground">{call.model || (zh ? `请求 ${index + 1}` : `Request ${index + 1}`)}</span>
                            {call.statusCode != null && <span>HTTP {call.statusCode}</span>}
                            {call.state && stateLabels[call.state] && <span>{stateLabels[call.state]}</span>}
                            {target.scope === 'llm' && calls.length > 1 && call.callId === target.preferredCallId && <span className="rounded border border-border px-1.5 py-0.5">{zh ? '最近一次请求' : 'Latest request'}</span>}
                        </div>
                        {href && <Button asChild variant="outline" size="sm" className="h-7 shrink-0 text-xs">
                            <a href={href} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-3" />{zh ? '打开分析' : 'Open analysis'}</a>
                        </Button>}
                    </div>
                    <div className="mt-2 break-all font-mono text-xs text-foreground select-all">{call.callId}</div>
                    {call.unassigned && <p className="mt-1 text-xs text-foreground-muted">{zh ? '未确定所属 LLM，仅关联整条链路。' : 'LLM ownership unknown; associated with this trace only.'}</p>}
                </div>;
            })}
        </div>}
        <details className="text-xs text-foreground-secondary">
            <summary className="cursor-pointer">{zh ? '查看关联标识' : 'View correlation IDs'}</summary>
            <dl className="mt-3 max-h-40 space-y-3 overflow-y-auto text-xs">
            {rows.map(row => <div key={row.label}>
                <dt className="mb-1 text-foreground-muted">{row.label}</dt>
                <dd className="space-y-1">{row.values.map(value => <div key={value} className="break-all font-mono select-all text-foreground">{value}</div>)}</dd>
            </div>)}
            </dl>
        </details>
        {config.status !== 'ready' && <p className="rounded-md border border-border bg-background-secondary p-3 text-sm text-foreground-secondary">
            {config.status === 'invalid'
                ? (zh ? '推理分析页面地址配置无效，请联系管理员检查协议、主机和端口。' : 'The inference analysis URL is invalid. Ask your administrator to check the scheme, host and port.')
                : (zh ? '尚未配置推理分析页面地址，暂不能打开外部分析页面。' : 'The inference analysis page URL has not been configured yet.')}
        </p>}
    </div>;
}

export function InferenceAnalysisButton({ target }: { target: InferenceAnalysisTarget }) {
    const { locale } = useLocale();
    const config = useInferenceAnalysisConfig();
    const [open, setOpen] = useState(false);
    const zh = locale === 'zh';
    const href = buildInferenceAnalysisUrl(config, target.preferredCallId);
    const title = target.scope === 'trace'
        ? (zh ? '整条链路的推理分析' : 'Trace inference analysis')
        : (zh ? '本次模型调用的推理分析' : 'Model call inference analysis');
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(JSON.stringify({ scope: target.scope, call_ids: target.callIds, unassigned_call_ids: target.unassignedCallIds, session_ids: target.sessionIds, response_id: target.responseId, request_id: target.requestId, attempt_ids: target.attemptIds }, null, 2));
            toast.success(zh ? '关联标识已复制' : 'Correlation IDs copied');
        } catch { toast.error(zh ? '复制失败，请手动选择标识复制' : 'Copy failed. Select the IDs and copy them manually.'); }
    };
    return <>
        <Button variant="outline" size="sm" className="h-7 shrink-0 gap-1 text-xs" title={title} onClick={() => setOpen(true)}>
            <ExternalLink className="size-3" />{zh ? '推理分析' : 'Inference analysis'}
        </Button>
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{zh ? '在新标签页查看对应模型请求的推理分析。' : 'View the matching model request analysis in a new tab.'}</DialogDescription>
                </DialogHeader>
                <InferenceAnalysisDetails target={target} locale={locale} config={config} />
                <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" disabled={!!target.unavailableReason} onClick={() => void copy()}><Copy className="size-3" />{zh ? '复制关联标识' : 'Copy IDs'}</Button>
                    {href && <Button asChild size="sm"><a href={href} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-3" />{zh ? '打开推理分析' : 'Open analysis'}</a></Button>}
                </div>
            </DialogContent>
        </Dialog>
    </>;
}
