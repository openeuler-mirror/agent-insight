'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { useLocale } from '@/lib/client/locale-context';
import {
  rasKindLabel,
  rasRecoveryPipelineLabel,
  rasSeverityLabel,
  severityToStatusKind,
  type RasRecoveryOutcome,
} from '@/lib/ingest/ras/normalize';
import { StatusBadge } from '@/components/feedback/StatusBadge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Pagination } from '@/components/ui/pagination';
import { IdChip } from '@/components/text/IdChip';
import { TruncateText } from '@/components/text/TruncateText';
import { EmptyState } from '@/components/feedback/EmptyState';
import { Term } from '@/components/text/Term';
import { cn } from '@/lib/utils';
import type { RasTraceTimeSortDir } from '@/lib/ingest/ras/sort-traces';
import { getPlatformLabel } from '@/lib/ingest/ras/platform-label';

interface RasTraceItem {
  taskId: string;
  executionId: string;
  latestTs: string;
  anomalyKind: string;
  severity: string | null;
  summary: string | null;
  eventCount: number;
  traceStatus: 'running' | 'success' | 'failed';
  traceStatusReason: string;
  detectionLevel: 'L1' | 'L2' | 'L3' | null;
  completedAt: string | null;
  platform?: string | null;
  framework: string | null;
  agentName: string | null;
  hasFault?: boolean;
  recoveryStarted?: boolean;
  recoveryOutcome?: RasRecoveryOutcome;
  abortedStream?: boolean;
}

interface Props {
  traces: RasTraceItem[];
  total: number;
  pageSize: number;
  loading: boolean;
  page: number;
  onPageChange: (p: number) => void;
  onDeleteSelected?: (taskIds: string[]) => Promise<void> | void;
  deleting?: boolean;
  timeSortDir?: RasTraceTimeSortDir;
  onTimeSortToggle?: () => void;
}

function formatExactTime(value: string | null | undefined, locale: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function SelectionCheckbox({
  checked,
  indeterminate = false,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  ariaLabel: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      ref={inputRef}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={ariaLabel}
      className="size-4 cursor-pointer accent-primary"
    />
  );
}

export function RasTraceList({
  traces,
  total,
  pageSize,
  loading,
  page,
  onPageChange,
  onDeleteSelected,
  deleting = false,
  timeSortDir = 'desc',
  onTimeSortToggle,
}: Props) {
  const { locale } = useLocale();
  const router = useRouter();
  const loc = locale === 'zh' ? 'zh' : 'en';
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setSelectedTaskIds(prev => {
      const visible = new Set(traces.map(item => item.taskId));
      const next = new Set<string>();
      for (const id of prev) {
        if (visible.has(id)) next.add(id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [traces]);

  const pageTaskIds = useMemo(() => traces.map(item => item.taskId), [traces]);
  const selectedCount = selectedTaskIds.size;
  const pageSelectedCount = pageTaskIds.filter(id => selectedTaskIds.has(id)).length;
  const allPageSelected = pageTaskIds.length > 0 && pageSelectedCount === pageTaskIds.length;
  const somePageSelected = pageSelectedCount > 0 && !allPageSelected;

  const toggleTask = (taskId: string) => {
    setSelectedTaskIds(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const toggleCurrentPage = () => {
    setSelectedTaskIds(prev => {
      const next = new Set(prev);
      if (allPageSelected) {
        for (const id of pageTaskIds) next.delete(id);
      } else {
        for (const id of pageTaskIds) next.add(id);
      }
      return next;
    });
  };

  const clearSelection = () => setSelectedTaskIds(new Set());

  const handleDelete = async () => {
    if (!onDeleteSelected || selectedCount === 0 || deleting) return;
    const ids = [...selectedTaskIds];
    const confirmed = window.confirm(
      locale === 'zh'
        ? `确认删除选中的 ${ids.length} 条链路？将同时清理 Execution / Session / RAS 事件。`
        : `Delete ${ids.length} selected trace(s)? This removes Execution / Session / RAS events.`,
    );
    if (!confirmed) return;
    await onDeleteSelected(ids);
    clearSelection();
  };

  if (loading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3, 4].map(i => <Skeleton key={i} className="h-10 w-full" />)}
      </div>
    );
  }

  if (!traces.length) {
    return (
      <EmptyState
        title={locale === 'zh' ? '暂无链路记录' : 'No traces'}
        description={locale === 'zh' ? '当前账号暂无可观测链路' : 'No observable traces for the current account'}
      />
    );
  }

  const handleRowClick = (taskId: string) => {
    router.push(`/agent-ras/trace/${encodeURIComponent(taskId)}`);
  };

  return (
    <div>
      <div
        className={cn(
          'mb-2 flex min-h-9 flex-wrap items-center justify-between gap-3 rounded-md',
          selectedCount > 0 && 'border border-primary-border bg-primary-subtle px-3 py-1.5',
        )}
      >
        {selectedCount > 0 ? (
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <span className="text-sm font-semibold text-primary">
              {locale === 'zh' ? `已选择 ${selectedCount} 条` : `${selectedCount} selected`}
            </span>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={toggleCurrentPage}>
              {allPageSelected
                ? (locale === 'zh' ? '取消当前页' : 'Deselect page')
                : (locale === 'zh' ? '全选当前页' : 'Select page')}
            </Button>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={clearSelection}>
              {locale === 'zh' ? '清空选择' : 'Clear'}
            </Button>
          </div>
        ) : (
          <h2 className="text-sm font-semibold text-foreground">
            {locale === 'zh' ? '链路列表' : 'Trace List'}
            <span className="ml-2 text-foreground-muted font-normal tabular-nums">{total}</span>
          </h2>
        )}
        {selectedCount > 0 && onDeleteSelected ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs text-error border-error-border hover:bg-error-subtle"
            disabled={deleting}
            onClick={() => void handleDelete()}
          >
            <Trash2 className="size-3.5" aria-hidden />
            {deleting
              ? (locale === 'zh' ? '删除中…' : 'Deleting…')
              : (locale === 'zh' ? '删除所选' : 'Delete selected')}
          </Button>
        ) : null}
      </div>

      <div className="rounded-md border border-card-border bg-card overflow-auto">
        <table className="w-full min-w-[1620px] table-fixed text-sm">
          <colgroup>
            <col style={{ width: 44 }} />
            <col style={{ width: 260 }} />
            <col style={{ width: 110 }} />
            <col style={{ width: 'clamp(180px, 22vw, 300px)' }} />
            <col style={{ width: 145 }} />
            <col style={{ width: 110 }} />
            <col style={{ width: 220 }} />
            <col style={{ width: 110 }} />
            <col style={{ width: 170 }} />
            <col style={{ width: 75 }} />
            <col style={{ width: 105 }} />
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr className="bg-background-secondary text-left">
              <th className="px-3 py-2 text-xs font-medium text-foreground-muted border-b border-border whitespace-nowrap">
                <SelectionCheckbox
                  checked={allPageSelected}
                  indeterminate={somePageSelected}
                  onChange={toggleCurrentPage}
                  ariaLabel={locale === 'zh' ? '全选当前页' : 'Select current page'}
                />
              </th>
              <th className="px-3 py-2 text-xs font-medium text-foreground-muted border-b border-border whitespace-nowrap">
                <Term id="trace" label="Trace ID" />
              </th>
              <th className="px-3 py-2 text-xs font-medium text-foreground-muted border-b border-border whitespace-nowrap">
                {locale === 'zh' ? '平台' : 'Platform'}
              </th>
              <th className="px-3 py-2 text-xs font-medium text-foreground-muted border-b border-border whitespace-nowrap">
                {locale === 'zh' ? '摘要' : 'Summary'}
              </th>
              <th className="px-3 py-2 text-xs font-medium text-foreground-muted border-b border-border whitespace-nowrap">
                <Term id="fault-item" label={locale === 'zh' ? '故障类型' : 'Fault Type'} />
              </th>
              <th className="px-3 py-2 text-xs font-medium text-foreground-muted border-b border-border whitespace-nowrap">
                <Term id="ras-severity" label={locale === 'zh' ? '严重等级' : 'Severity'} />
              </th>
              <th className="px-3 py-2 text-xs font-medium text-foreground-muted border-b border-border whitespace-nowrap">
                {locale === 'zh' ? 'RAS 处置' : 'RAS Recovery'}
              </th>
              <th className="px-3 py-2 text-xs font-medium text-foreground-muted border-b border-border whitespace-nowrap">
                <Term id="chain-status" label={locale === 'zh' ? '执行状态' : 'Status'} />
              </th>
              <th
                scope="col"
                tabIndex={onTimeSortToggle ? 0 : undefined}
                role="columnheader"
                aria-sort={onTimeSortToggle ? (timeSortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                onClick={onTimeSortToggle}
                onKeyDown={onTimeSortToggle ? ((e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onTimeSortToggle();
                  }
                }) : undefined}
                className={cn(
                  'px-3 py-2 text-xs font-medium border-b border-border whitespace-nowrap select-none',
                  onTimeSortToggle
                    ? 'cursor-pointer text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                    : 'text-foreground-muted',
                )}
              >
                <span className="inline-flex items-center gap-1">
                  {locale === 'zh' ? '时间' : 'Time'}
                  {onTimeSortToggle ? (
                    <span className="text-[10px] opacity-100" aria-hidden>
                      {timeSortDir === 'asc' ? '\u2191' : '\u2193'}
                    </span>
                  ) : null}
                </span>
              </th>
              <th className="px-3 py-2 text-xs font-medium text-foreground-muted border-b border-border whitespace-nowrap text-center">
                {locale === 'zh' ? '事件数' : 'Events'}
              </th>
              <th className="px-3 py-2 text-xs font-medium text-foreground-muted border-b border-border whitespace-nowrap text-right">
                {locale === 'zh' ? '操作' : 'Actions'}
              </th>
            </tr>
          </thead>
          <tbody>
            {traces.map(item => {
              const pipeline = rasRecoveryPipelineLabel({
                hasFault: item.hasFault ?? Boolean(item.anomalyKind || item.severity),
                recoveryStarted: item.recoveryStarted ?? false,
                recoveryOutcome: item.recoveryOutcome ?? 'none',
                abortedStream: item.abortedStream,
                locale: loc,
              });
              const selected = selectedTaskIds.has(item.taskId);
              return (
              <tr
                key={item.taskId}
                onClick={() => handleRowClick(item.taskId)}
                onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); handleRowClick(item.taskId); } }}
                tabIndex={0}
                className={cn(
                  'border-b border-border hover:bg-background-secondary focus-visible:outline-none focus-visible:bg-background-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset cursor-pointer transition-colors',
                  selected && 'bg-primary-subtle/40',
                )}
              >
                <td className="px-3 py-2 text-sm text-foreground" onClick={ev => ev.stopPropagation()}>
                  <SelectionCheckbox
                    checked={selected}
                    onChange={() => toggleTask(item.taskId)}
                    ariaLabel={locale === 'zh' ? `选择 ${item.taskId}` : `Select ${item.taskId}`}
                  />
                </td>
                <td className="px-3 py-2 text-sm text-foreground">
                  <IdChip value={item.taskId} head={64} tail={0} className="whitespace-nowrap" />
                </td>
                <td className="px-3 py-2 text-sm text-foreground">
                  <span className="text-xs text-foreground-secondary whitespace-nowrap">
                    {getPlatformLabel(item.platform || item.framework)}
                  </span>
                </td>
                <td className="px-3 py-2 text-sm text-foreground">
                  {item.summary ? (
                    <TruncateText tooltipMax={100} className="text-sm">{item.summary}</TruncateText>
                  ) : (
                    <span className="text-foreground-muted">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-sm text-foreground">
                  <span className="text-xs text-foreground-secondary">
                    {item.anomalyKind ? rasKindLabel(item.anomalyKind, loc) : '—'}
                    {item.detectionLevel && (
                      <span className="ml-1 font-mono text-foreground-muted">{item.detectionLevel}</span>
                    )}
                  </span>
                </td>
                <td className="px-3 py-2 text-sm text-foreground">
                  {item.severity ? (
                    <StatusBadge
                      status={severityToStatusKind(item.severity)}
                      label={rasSeverityLabel(item.severity, loc)}
                    />
                  ) : (
                    <StatusBadge status="success" label={locale === 'zh' ? '无故障' : 'No fault'} />
                  )}
                </td>
                <td className="px-3 py-2 text-sm text-foreground">
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <StatusBadge status={pipeline.badgeStatus} label={pipeline.label} />
                    {pipeline.hint ? (
                      <span className="text-[11px] text-foreground-muted leading-tight">{pipeline.hint}</span>
                    ) : null}
                  </div>
                </td>
                <td className="px-3 py-2 text-sm text-foreground">
                  <StatusBadge
                    status={item.traceStatus === 'failed' ? 'error' : item.traceStatus}
                    label={
                      item.traceStatus === 'running'
                        ? locale === 'zh' ? '执行中' : 'Running'
                        : item.traceStatus === 'failed'
                          ? locale === 'zh' ? '执行失败' : 'Failed'
                          : locale === 'zh' ? '正常完成' : 'Completed'
                    }
                  />
                </td>
                <td className="px-3 py-2 text-sm text-foreground">
                  <span className="text-xs text-foreground-secondary font-mono whitespace-nowrap tabular-nums">
                    {formatExactTime(item.latestTs, locale)}
                  </span>
                </td>
                <td className="px-3 py-2 text-sm text-foreground text-center">
                  <span className="text-xs text-foreground-secondary font-mono tabular-nums">
                    {item.eventCount}
                  </span>
                </td>
                <td className="px-3 py-2 text-sm text-foreground text-right">
                  <div onClick={ev => ev.stopPropagation()} onKeyDown={ev => ev.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRowClick(item.taskId)}
                      className="h-7 px-2 text-xs"
                    >
                      {locale === 'zh' ? '查看详情' : 'View detail'}
                    </Button>
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {total > pageSize && (
        <div className="mt-3">
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={onPageChange}
          />
        </div>
      )}
    </div>
  );
}
