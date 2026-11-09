'use client';

/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a file at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as React from 'react';
import {
    AlertTriangle,
    Check,
    Clock,
    ExternalLink,
    FileText,
    Info,
    Loader2,
    Plus,
    RotateCcw,
    XCircle,
} from 'lucide-react';

import { apiFetch } from '@/lib/client/api';
import { useLocale } from '@/lib/client/locale-context';
import { useAuth } from '@/lib/auth/auth-context';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

const TRACE_BUNDLE_MAX_BYTES = 50 * 1024 * 1024;
const TRACE_DETAIL_PATH = '/trace';

type ImportPhase = 'select' | 'running' | 'done';
type ItemStatus = 'waiting' | 'importing' | 'success' | 'failed' | 'stopped';
type ErrorKind = 'network' | 'schema' | 'size' | 'parse';
type ResultFilter = 'all' | 'success' | 'failed' | 'pending';

interface TraceImportOutcome {
    fileName: string | null;
    originalRootExecutionId: string;
    rootExecutionId: string;
    rootTaskId: string | null;
    executionCount: number;
    subagentCount: number;
    remappedIds: Array<{ original: string; imported: string }>;
}

interface BatchItem {
    id: string;
    file: File;
    status: ItemStatus;
    recoverable: boolean;
    errorKind?: ErrorKind;
    errorMessage?: string;
    result?: TraceImportOutcome;
}

interface ImportFailure {
    kind: ErrorKind;
    recoverable: boolean;
    message: string;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function classifyFailure(error: unknown): ImportFailure {
    if (error && typeof error === 'object' && 'batchKind' in error) {
        const f = error as unknown as ImportFailure & { batchKind: boolean };
        return { kind: f.kind, recoverable: f.recoverable, message: f.message };
    }
    // fetch 层网络异常（TypeError:Failed to fetch 等）视为可恢复
    return { kind: 'network', recoverable: true, message: 'Network error' };
}

function makeFailure(kind: ErrorKind, recoverable: boolean, message: string): ImportFailure & { batchKind: true } {
    return { kind, recoverable, message, batchKind: true };
}

export interface TraceBatchImportDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** 每个文件成功写入后回调（用于刷新列表），失败不触发 */
    onImportSuccess?: () => void;
}

export function TraceBatchImportDialog({ open, onOpenChange, onImportSuccess }: TraceBatchImportDialogProps) {
    const { locale } = useLocale();
    const { user } = useAuth();
    const zh = locale === 'zh';
    const basePath = process.env.NEXT_PUBLIC_URL_PREFIX || '';

    const [phase, setPhase] = React.useState<ImportPhase>('select');
    const [items, setItems] = React.useState<BatchItem[]>([]);
    const [stopRequested, setStopRequested] = React.useState(false);
    const [cancelRequested, setCancelRequested] = React.useState(false);
    const [confirmCancelOpen, setConfirmCancelOpen] = React.useState(false);
    const [filter, setFilter] = React.useState<ResultFilter>('all');
    const [expandedId, setExpandedId] = React.useState<string | null>(null);
    const [dragOver, setDragOver] = React.useState(false);
    const [feedback, setFeedback] = React.useState<string | null>(null);

    const itemsRef = React.useRef<BatchItem[]>([]);
    const flagsRef = React.useRef({ stopRequested: false, cancelRequested: false });
    const inputRef = React.useRef<HTMLInputElement>(null);
    const idSeqRef = React.useRef(0);

    const zhFail = (kind: ErrorKind) => (
        kind === 'network' ? '服务暂时不可用，本次文件导入失败。稍后可重试。'
            : kind === 'schema' ? '导入校验失败。请检查导出文件是否完整。'
                : kind === 'size' ? '文件超过单文件 50 MB 限制。'
                    : '文件无法解析为 JSON，请检查文件内容。'
    );
    const enFail = (kind: ErrorKind) => (
        kind === 'network' ? 'The service is temporarily unavailable. You can retry later.'
            : kind === 'schema' ? 'Import validation failed. Check whether the exported file is complete.'
                : kind === 'size' ? 'The file exceeds the 50 MB single-file limit.'
                    : 'The file could not be parsed as JSON.'
    );

    const updateItems = React.useCallback((fn: (list: BatchItem[]) => BatchItem[]) => {
        const next = fn(itemsRef.current);
        itemsRef.current = next;
        setItems(next);
    }, []);

    const addFiles = React.useCallback((list: FileList | File[] | null) => {
        if (!list) return;
        const incoming = Array.from(list).filter(f => f.name.toLowerCase().endsWith('.json'));
        if (!incoming.length) return;
        updateItems(cur => [...cur, ...incoming.map(file => ({
            id: `f${++idSeqRef.current}`,
            file,
            status: 'waiting' as ItemStatus,
            recoverable: false,
        }))]);
    }, [updateItems]);

    const removeItem = React.useCallback((id: string) => {
        updateItems(cur => cur.filter(i => i.id !== id));
    }, [updateItems]);

    const importOne = React.useCallback(async (item: BatchItem): Promise<TraceImportOutcome> => {
        if (item.file.size > TRACE_BUNDLE_MAX_BYTES) {
            throw makeFailure('size', false, zh ? zhFail('size') : enFail('size'));
        }
        let bundle: unknown;
        try {
            bundle = JSON.parse(await item.file.text());
        } catch {
            throw makeFailure('parse', false, zh ? zhFail('parse') : enFail('parse'));
        }
        let response: Response;
        try {
            response = await apiFetch('/api/observe/traces/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user, fileName: item.file.name, bundle }),
            });
        } catch {
            throw makeFailure('network', true, zh ? zhFail('network') : enFail('network'));
        }
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const status = response.status;
            if (status === 413) throw makeFailure('size', false, zh ? zhFail('size') : enFail('size'));
            const kind: ErrorKind = status >= 500 || status === 429 ? 'network' : 'schema';
            const recoverable = kind === 'network';
            const fallback = zh ? '导入 Trace 失败' : 'Failed to import trace';
            throw makeFailure(kind, recoverable, (payload as { error?: string })?.error || fallback);
        }
        return payload as TraceImportOutcome;
    }, [zh, user]);

    const runQueue = React.useCallback(async () => {
        setPhase('running');
        setFeedback(null);
        flagsRef.current = { stopRequested: false, cancelRequested: false };
        setStopRequested(false);
        setCancelRequested(false);
        for (;;) {
            const next = itemsRef.current.find(i => i.status === 'waiting');
            if (!next || flagsRef.current.stopRequested || flagsRef.current.cancelRequested) break;
            updateItems(cur => cur.map(i => i.id === next.id ? { ...i, status: 'importing' as ItemStatus } : i));
            try {
                const result = await importOne(next);
                updateItems(cur => cur.map(i => i.id === next.id
                    ? { ...i, status: 'success' as ItemStatus, result, recoverable: false, errorMessage: undefined }
                    : i));
                onImportSuccess?.();
            } catch (error) {
                const failure = classifyFailure(error);
                updateItems(cur => cur.map(i => i.id === next.id
                    ? {
                        ...i,
                        status: 'failed' as ItemStatus,
                        recoverable: failure.recoverable,
                        errorKind: failure.kind,
                        errorMessage: failure.message,
                    }
                    : i));
            }
        }
        if (flagsRef.current.stopRequested || flagsRef.current.cancelRequested) {
            updateItems(cur => cur.map(i => i.status === 'waiting' ? { ...i, status: 'stopped' as ItemStatus } : i));
        }
        setPhase('done');
        setStopRequested(flagsRef.current.stopRequested);
        setCancelRequested(flagsRef.current.cancelRequested);
    }, [importOne, onImportSuccess, updateItems]);

    const handleStart = React.useCallback(() => {
        if (!itemsRef.current.length) return;
        void runQueue();
    }, [runQueue]);

    const handleStop = React.useCallback(() => {
        flagsRef.current.stopRequested = true;
        setStopRequested(true);
        const stopped = itemsRef.current.filter(i => i.status === 'waiting').length;
        updateItems(cur => cur.map(i => i.status === 'waiting' ? { ...i, status: 'stopped' as ItemStatus } : i));
        setFeedback(zh
            ? `已停止后续导入：${stopped} 个文件不会再开始，当前文件继续完成。`
            : `Remaining imports stopped: ${stopped} file(s) will not start; the current file will finish.`);
    }, [updateItems, zh]);

    const handleCancelConfirm = React.useCallback(() => {
        setConfirmCancelOpen(false);
        flagsRef.current.cancelRequested = true;
        setCancelRequested(true);
        onOpenChange(false);
    }, [onOpenChange]);

    const retryItems = React.useCallback((ids: string[]) => {
        updateItems(cur => cur.map(i => ids.includes(i.id)
            ? { ...i, status: 'waiting' as ItemStatus, errorMessage: undefined, errorKind: undefined }
            : i));
        void runQueue();
    }, [runQueue, updateItems]);

    const handleRetryAll = React.useCallback(() => {
        retryItems(itemsRef.current.filter(i => i.status === 'failed' && i.recoverable).map(i => i.id));
    }, [retryItems]);

    const counts = React.useMemo(() => {
        const success = items.filter(i => i.status === 'success').length;
        const failed = items.filter(i => i.status === 'failed').length;
        const importing = items.filter(i => i.status === 'importing').length;
        const waiting = items.filter(i => i.status === 'waiting').length;
        const stopped = items.filter(i => i.status === 'stopped').length;
        const processed = success + failed + stopped;
        const retryable = items.filter(i => i.status === 'failed' && i.recoverable).length;
        return { success, failed, importing, waiting, stopped, processed, total: items.length, retryable };
    }, [items]);

    const importingIndex = React.useMemo(
        () => items.findIndex(i => i.status === 'importing') + 1,
        [items],
    );

    const visibleItems = React.useMemo(() => {
        if (phase === 'select') return items;
        if (filter === 'success') return items.filter(i => i.status === 'success');
        if (filter === 'failed') return items.filter(i => i.status === 'failed');
        if (filter === 'pending') return items.filter(i => i.status !== 'success');
        return items;
    }, [items, filter, phase]);

    const headerTag = phase === 'select'
        ? (zh ? '选择文件' : 'Select files')
        : phase === 'running'
            ? (cancelRequested ? (zh ? '取消中' : 'Cancelling…')
                : stopRequested ? (zh ? '停止中' : 'Stopping…') : (zh ? '进行中' : 'In progress'))
            : counts.stopped > 0 && counts.success === 0 && counts.failed === 0
                ? (zh ? '已停止' : 'Stopped')
                : counts.failed > 0 ? (zh ? '部分失败' : 'Partially failed') : (zh ? '全部成功' : 'All imported');

    const statusBadge = (item: BatchItem) => {
        const map: Record<ItemStatus, { label: string; cls: React.ReactNode; icon: React.ReactNode }> = {
            success: {
                label: zh ? '导入成功' : 'Imported',
                cls: 'text-green-700 bg-green-50 border-green-200',
                icon: <Check className="size-3.5" aria-hidden />,
            },
            failed: {
                label: zh ? '导入失败' : 'Failed',
                cls: 'text-red-700 bg-red-50 border-red-200',
                icon: <XCircle className="size-3.5" aria-hidden />,
            },
            importing: {
                label: zh ? '导入中' : 'Importing',
                cls: 'text-blue-700 bg-blue-50 border-blue-200',
                icon: <Loader2 className="size-3.5 animate-spin" aria-hidden />,
            },
            waiting: {
                label: zh ? '等待导入' : 'Waiting',
                cls: 'text-foreground-muted bg-background-secondary border-border',
                icon: <Clock className="size-3.5" aria-hidden />,
            },
            stopped: {
                label: zh ? '已停止' : 'Stopped',
                cls: 'text-foreground-muted bg-background-secondary border-border',
                icon: <Clock className="size-3.5" aria-hidden />,
            },
        };
        const s = map[item.status];
        return (
            <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium', s.cls)}>
                {s.icon}
                {s.label}
            </span>
        );
    };

    const requestClose = React.useCallback(() => {
        if (phase === 'running') {
            setConfirmCancelOpen(true);
            return;
        }
        onOpenChange(false);
    }, [onOpenChange, phase]);

    const filterTabs: Array<{ key: ResultFilter; label: string; count: number }> = [
        { key: 'all', label: zh ? '全部' : 'All', count: counts.total },
        { key: 'success', label: zh ? '成功' : 'Success', count: counts.success },
        { key: 'failed', label: zh ? '失败' : 'Failed', count: counts.failed },
        {
            key: 'pending',
            label: zh ? '未导入' : 'Not imported',
            count: counts.total - counts.success - counts.failed,
        },
    ];

    return (
        <>
            <Dialog open={open} onOpenChange={next => { if (!next) requestClose(); }}>
                <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2.5">
                            {zh ? '批量导入 Trace' : 'Batch import traces'}
                            <span className="rounded-md bg-background-secondary border border-border px-2 py-0.5 text-xs font-medium text-foreground-muted">
                                {headerTag}
                            </span>
                        </DialogTitle>
                    </DialogHeader>

                    {phase === 'select' && (
                        <>
                            <div
                                className={cn(
                                    'rounded-lg border border-dashed p-8 text-center transition-colors',
                                    dragOver ? 'border-blue-400 bg-blue-50/50' : 'border-border',
                                )}
                                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                                onDragLeave={() => setDragOver(false)}
                                onDrop={e => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
                            >
                                <FileText className="mx-auto size-8 text-foreground-muted" aria-hidden />
                                <p className="mt-3 text-sm font-medium">{zh ? '拖拽多个 Trace 文件到这里' : 'Drag multiple trace files here'}</p>
                                <p className="mt-1 text-xs text-foreground-muted">
                                    {zh ? 'Agent Insight 导出的 JSON 文件 · 单个文件不超过 50 MB' : 'JSON files exported from Agent Insight · 50 MB max per file'}
                                </p>
                                <Button variant="outline" size="sm" className="mt-4" onClick={() => inputRef.current?.click()}>
                                    <Plus className="size-3.5" aria-hidden />
                                    {zh ? '选择文件' : 'Choose files'}
                                </Button>
                                <input
                                    ref={inputRef}
                                    type="file"
                                    accept="application/json,.json"
                                    multiple
                                    className="hidden"
                                    onChange={e => { addFiles(e.target.files); e.target.value = ''; }}
                                />
                            </div>
                            <p className="text-xs text-foreground-muted">
                                {zh ? '每个文件包含一条根 Trace 及其子 Agent；ID 冲突时自动生成新 ID。' : 'Each file contains one root trace and its sub-agents; conflicting IDs are remapped automatically.'}
                            </p>
                            {items.length > 0 && (
                                <div className="flex items-center justify-between border-b border-border pb-2">
                                    <span className="text-sm font-medium text-blue-700">
                                        {zh ? `已选择 ${items.length}` : `${items.length} selected`}
                                    </span>
                                    <span className="text-xs text-foreground-muted">
                                        {zh ? `${items.length} 个文件` : `${items.length} files`}
                                    </span>
                                </div>
                            )}
                        </>
                    )}

                    {phase !== 'select' && (
                        <>
                            <div className="space-y-2.5">
                                <div className="flex items-center justify-between text-sm">
                                    <span className="font-medium">
                                        {phase === 'running'
                                            ? (zh ? `正在导入第 ${importingIndex} 个文件` : `Importing file ${importingIndex}`)
                                            : counts.failed > 0
                                                ? (zh ? '导入完成，部分文件失败' : 'Import finished, some files failed')
                                                : (zh ? '导入完成' : 'Import finished')}
                                    </span>
                                    <span className="text-foreground-muted">
                                        {counts.processed} / {counts.total} {zh ? '已处理' : 'processed'}
                                    </span>
                                </div>
                                <div className="h-2 w-full overflow-hidden rounded-full bg-background-secondary">
                                    <div className="flex h-full">
                                        <div className="bg-green-500" style={{ width: `${(counts.success / Math.max(1, counts.total)) * 100}%` }} />
                                        <div className="bg-red-500" style={{ width: `${(counts.failed / Math.max(1, counts.total)) * 100}%` }} />
                                    </div>
                                </div>
                                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-foreground-muted">
                                    <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-green-500" />{zh ? `成功 ${counts.success}` : `Success ${counts.success}`}</span>
                                    <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-red-500" />{zh ? `失败 ${counts.failed}` : `Failed ${counts.failed}`}</span>
                                    <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-blue-500" />{zh ? `导入中 ${counts.importing}` : `Importing ${counts.importing}`}</span>
                                    <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-foreground-muted" />{zh ? `等待 ${counts.waiting}` : `Waiting ${counts.waiting}`}</span>
                                    {counts.stopped > 0 && <span className="inline-flex items-center gap-1.5">{zh ? `已停止 ${counts.stopped}` : `Stopped ${counts.stopped}`}</span>}
                                </div>
                            </div>

                            {phase === 'running' && (
                                <div className="flex items-start gap-2 rounded-md border border-border bg-background-secondary p-3 text-xs text-foreground-muted">
                                    <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                                    <span>{zh ? '单个文件失败不会中断其余导入。请保持当前页面打开。' : 'One file failing does not interrupt the others. Keep this page open.'}</span>
                                </div>
                            )}
                            {phase === 'done' && counts.failed > 0 && (
                                <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                                    <span>{zh ? '成功文件已保存。失败文件可单独处理，无需重新导入成功文件。' : 'Imported files are saved. Handle failed files separately; imported files are never re-imported.'}</span>
                                </div>
                            )}
                            {feedback && <p className="text-xs text-foreground-muted">{feedback}</p>}

                            <div className="flex items-center justify-between border-b border-border pb-2">
                                <div className="flex items-center gap-1">
                                    {filterTabs.map(tabData => (
                                        <button
                                            key={tabData.key}
                                            type="button"
                                            onClick={() => setFilter(tabData.key)}
                                            className={cn(
                                                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                                                filter === tabData.key
                                                    ? 'bg-background-secondary text-foreground'
                                                    : 'text-foreground-muted hover:text-foreground',
                                            )}
                                        >
                                            {tabData.label} {tabData.count}
                                        </button>
                                    ))}
                                </div>
                                <span className="text-xs text-foreground-muted">
                                    {zh ? `${items.length} 个文件` : `${items.length} files`}
                                </span>
                            </div>
                        </>
                    )}

                    <div className="min-h-0 flex-1 overflow-y-auto">
                        {visibleItems.length === 0 ? (
                            <p className="py-8 text-center text-sm text-foreground-muted">
                                {phase === 'select'
                                    ? (zh ? '尚未选择文件' : 'No files selected')
                                    : (zh ? '没有符合条件的文件' : 'No files match this filter')}
                            </p>
                        ) : (
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-border text-left text-xs text-foreground-muted">
                                        <th className="py-2 pr-3 font-medium">{zh ? '文件 / Trace' : 'File / Trace'}</th>
                                        <th className="py-2 pr-3 font-medium">{zh ? '导入状态' : 'Status'}</th>
                                        <th className="py-2 text-right font-medium">{zh ? '操作' : 'Actions'}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {visibleItems.map(item => (
                                        <React.Fragment key={item.id}>
                                            <tr className="border-b border-border/60 align-middle">
                                                <td className="py-2.5 pr-3">
                                                    <div className="flex items-start gap-2.5">
                                                        <FileText className="mt-0.5 size-4 shrink-0 text-foreground-muted" aria-hidden />
                                                        <div className="min-w-0">
                                                            <p className="truncate font-medium">{item.file.name}</p>
                                                            <p className="mt-0.5 text-xs text-foreground-muted">
                                                                {formatBytes(item.file.size)}
                                                                {item.result && (
                                                                    <>
                                                                        {' · '}{item.result.executionCount} {zh ? '条 Trace' : 'trace'}
                                                                        {' · '}{item.result.subagentCount} {zh ? '个子 Agent' : 'subagents'}
                                                                        {item.result.remappedIds.length > 0 && (zh ? ' · ID 已重映射' : ' · IDs remapped')}
                                                                    </>
                                                                )}
                                                            </p>
                                                        </div>
                                                    </div>
                                                </td>
                                                <td className="py-2.5 pr-3">
                                                    {statusBadge(item)}
                                                    {item.status === 'importing' && (
                                                        <p className="mt-1 text-xs text-foreground-muted">
                                                            {zh ? '正在处理完整链路…' : 'Processing the full trace…'}
                                                        </p>
                                                    )}
                                                    {item.status === 'failed' && (
                                                        <p className="mt-1 text-xs text-red-600">{item.errorMessage}</p>
                                                    )}
                                                </td>
                                                <td className="py-2.5 text-right">
                                                    {phase === 'select' && (
                                                        <button
                                                            type="button"
                                                            className="text-xs font-medium text-foreground-muted hover:text-foreground"
                                                            onClick={() => removeItem(item.id)}
                                                        >
                                                            {zh ? '移除' : 'Remove'}
                                                        </button>
                                                    )}
                                                    {phase !== 'select' && item.status === 'success' && (
                                        <button
                                            type="button"
                                            className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline"
                                            onClick={() => {
                                                const targetId = item.result?.rootTaskId || item.result?.rootExecutionId;
                                                if (targetId) window.open(`${basePath}${TRACE_DETAIL_PATH}?taskId=${encodeURIComponent(targetId)}`, '_blank', 'noopener');
                                            }}
                                        >
                                            {zh ? '查看 Trace' : 'View trace'}
                                            <ExternalLink className="size-3" aria-hidden />
                                        </button>
                                                    )}
                                                    {item.status === 'failed' && (
                                                        <button
                                                            type="button"
                                                            className="text-xs font-medium text-blue-700 hover:underline"
                                                            onClick={() => setExpandedId(cur => cur === item.id ? null : item.id)}
                                                        >
                                                            {zh ? '查看原因' : 'View reason'}
                                                        </button>
                                                    )}
                                                </td>
                                            </tr>
                                            {item.status === 'failed' && expandedId === item.id && (
                                                <tr className="border-b border-border/60">
                                                    <td colSpan={3} className="pb-3">
                                                        <div className="rounded-md border border-border bg-background-secondary p-3 text-xs text-foreground-muted">
                                                            <p>{item.errorMessage}</p>
                                                            {item.recoverable && (
                                                                <Button
                                                                    variant="outline"
                                                                    size="sm"
                                                                    className="mt-2"
                                                                    onClick={() => retryItems([item.id])}
                                                                >
                                                                    <RotateCcw className="size-3.5" aria-hidden />
                                                                    {zh ? '重试此文件' : 'Retry this file'}
                                                                </Button>
                                                            )}
                                                        </div>
                                                    </td>
                                                </tr>
                                            )}
                                        </React.Fragment>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>

                    <DialogFooter className="flex-row items-center justify-end gap-2 border-t border-border pt-3">
                        {phase === 'select' && (
                            <>
                                <Button variant="outline" onClick={() => onOpenChange(false)}>{zh ? '取消' : 'Cancel'}</Button>
                                <Button disabled={!items.length} onClick={handleStart}>
                                    {zh ? `开始导入 ${items.length} 个文件` : `Start importing ${items.length} file(s)`}
                                </Button>
                            </>
                        )}
                        {phase === 'running' && (
                            <>
                                <Button variant="outline" disabled={stopRequested} onClick={handleStop}>
                                    {stopRequested ? (zh ? '已停止后续导入' : 'Remaining imports stopped') : (zh ? '停止后续导入' : 'Stop remaining imports')}
                                </Button>
                                <Button variant="outline" disabled={cancelRequested} onClick={() => setConfirmCancelOpen(true)}>
                                    {cancelRequested ? (zh ? '取消中…' : 'Cancelling…') : (zh ? '取消' : 'Cancel')}
                                </Button>
                            </>
                        )}
                        {phase === 'done' && (
                            <>
                                {counts.retryable > 0 && (
                                    <Button variant="outline" onClick={handleRetryAll}>
                                        <RotateCcw className="size-3.5" aria-hidden />
                                        {zh ? `重试可恢复失败项 (${counts.retryable})` : `Retry recoverable failures (${counts.retryable})`}
                                    </Button>
                                )}
                                <Button onClick={() => onOpenChange(false)}>{zh ? '关闭' : 'Close'}</Button>
                            </>
                        )}
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <ConfirmDialog
                open={confirmCancelOpen}
                onOpenChange={setConfirmCancelOpen}
                title={zh ? '确认取消导入？' : 'Cancel this import?'}
                description={zh
                    ? '未导入的停止导入，正在导入的等待导入完成，是否确认取消？'
                    : 'Files not yet imported will stop; files currently importing will finish. Confirm cancel?'}
                confirmText={zh ? '确认取消' : 'Confirm cancel'}
                cancelText={zh ? '暂不取消' : 'Not now'}
                onConfirm={handleCancelConfirm}
            />
        </>
    );
}
