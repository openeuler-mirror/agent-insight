'use client';

import React, { useState } from 'react';
import { ExternalLink, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useLocale } from '@/lib/client/locale-context';
import type { InferenceAnalysisTarget } from '@/lib/trace/inference-analysis';

export function InferenceAnalysisDetails({ target, locale }: { target: InferenceAnalysisTarget; locale: string }) {
    const zh = locale === 'zh';
    const reasons = {
        unsupported: zh ? '此来源尚未接入推理关联。' : 'Inference correlation is not available for this source.',
        session: zh ? '缺少模型请求的会话标识。' : 'The model request session ID is missing.',
        response: zh ? '未采集到推理服务响应 ID，无法定位单次推理。失败尝试或本地错误消息可能没有此 ID。' : 'No inference response ID was collected. Failed attempts and local errors may not have one.',
        request: zh ? '未采集到发送给推理服务的请求 ID，无法定位单次推理。' : 'No request ID sent to the inference service was collected.',
    };
    const rows = [
        { label: zh ? '模型调用 ID' : 'Model call IDs', values: target.callIds ?? [] },
        { label: zh ? '未确定所属 LLM 的调用 ID' : 'Call IDs with unknown LLM ownership', values: target.unassignedCallIds ?? [] },
        { label: zh ? '关联会话' : 'Sessions', values: target.sessionIds },
        { label: zh ? '响应 ID' : 'Response ID', values: target.responseId ? [target.responseId] : [] },
        { label: zh ? '请求 ID' : 'Request ID', values: target.requestId ? [target.requestId] : [] },
        { label: zh ? '尝试 ID' : 'Attempt IDs', values: target.attemptIds ?? [] },
    ].filter(row => row.values.length);
    return <div className="space-y-4">
        <p className="text-sm text-foreground-secondary">
            {target.unavailableReason ? reasons[target.unavailableReason] : zh ? '关联标识已就绪。' : 'Correlation IDs are available.'}
        </p>
        <dl className="max-h-64 space-y-3 overflow-y-auto text-xs">
            {rows.map(row => <div key={row.label}>
                <dt className="mb-1 text-foreground-muted">{row.label}</dt>
                <dd className="space-y-1">{row.values.map(value => <div key={value} className="break-all font-mono select-all text-foreground">{value}</div>)}</dd>
            </div>)}
        </dl>
        <p className="rounded-md border border-border bg-background-secondary p-3 text-sm text-foreground-secondary">
            {zh ? '尚未配置推理分析页面地址，暂不能打开外部分析页面。' : 'The inference analysis page URL has not been configured yet.'}
        </p>
    </div>;
}

export function InferenceAnalysisButton({ target }: { target: InferenceAnalysisTarget }) {
    const { locale } = useLocale();
    const [open, setOpen] = useState(false);
    const zh = locale === 'zh';
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
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{zh ? '查看与推理服务关联的标识及跳转状态。' : 'View correlation IDs and analysis page availability.'}</DialogDescription>
                </DialogHeader>
                <InferenceAnalysisDetails target={target} locale={locale} />
                <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" disabled={!!target.unavailableReason} onClick={() => void copy()}><Copy className="size-3" />{zh ? '复制关联标识' : 'Copy IDs'}</Button>
                    <Button size="sm" disabled title={zh ? '页面地址尚未配置' : 'Page URL not configured'}><ExternalLink className="size-3" />{zh ? '打开推理分析' : 'Open analysis'}</Button>
                </div>
            </DialogContent>
        </Dialog>
    </>;
}
