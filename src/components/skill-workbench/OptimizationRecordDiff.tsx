'use client';

import { useMemo, useState } from 'react';
import { diffLines } from 'diff';

import { MonacoDiffEditor, type DiffViewMode } from '@/components/diff/MonacoDiffEditor';
import { cn } from '@/lib/utils';

export interface OptimizationDiffEntry {
  path?: string;
  before?: string | null;
  after?: string | null;
  changeType?: string;
}

const CHANGE_LABELS: Record<string, string> = {
  added: '新增',
  deleted: '删除',
  modified: '修改',
};

function lineStats(entry: OptimizationDiffEntry) {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(entry.before || '', entry.after || '')) {
    if (part.added) added += part.count || 0;
    if (part.removed) removed += part.count || 0;
  }
  return { added, removed };
}

export function OptimizationRecordDiff({ files }: { files: OptimizationDiffEntry[] }) {
  const normalized = useMemo(() => files.map((file, index) => ({
    ...file,
    path: file.path || `未命名文件 ${index + 1}`,
    stats: lineStats(file),
  })), [files]);
  const [requestedPath, setRequestedPath] = useState(normalized[0]?.path || '');
  const [mode, setMode] = useState<DiffViewMode>('inline');
  const selected = normalized.find((file) => file.path === requestedPath) || normalized[0];
  if (!selected) return null;

  return (
    <div className="grid h-[360px] min-w-0 grid-cols-[220px_minmax(0,1fr)] overflow-hidden">
      <div className="min-w-0 overflow-y-auto border-r border-border bg-background-secondary p-2">
        {normalized.map((file) => (
          <button
            key={file.path}
            type="button"
            title={file.path}
            onClick={() => setRequestedPath(file.path)}
            className={cn(
              'mb-1 flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-[10px]',
              selected.path === file.path ? 'bg-card text-foreground shadow-sm' : 'text-foreground-secondary hover:bg-card',
            )}
          >
            <span className="min-w-0 flex-1 truncate">{file.path}</span>
            {file.stats.added > 0 && <span className="shrink-0 text-success">+{file.stats.added}</span>}
            {file.stats.removed > 0 && <span className="shrink-0 text-error">-{file.stats.removed}</span>}
          </button>
        ))}
      </div>
      <div className="flex min-w-0 flex-col overflow-hidden bg-card">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-[10px]">
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">{selected.path}</span>
          <span className="rounded bg-background-secondary px-1.5 py-0.5 text-foreground-muted">
            {CHANGE_LABELS[selected.changeType || ''] || selected.changeType || '变更'}
          </span>
          <div className="flex rounded-md border border-border p-0.5">
            {(['inline', 'side'] as DiffViewMode[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setMode(item)}
                className={cn(
                  'rounded px-2 py-0.5 text-[10px]',
                  mode === item ? 'bg-primary-subtle text-primary' : 'text-foreground-muted hover:text-foreground',
                )}
              >
                {item === 'inline' ? '内联' : '并排'}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 min-w-0 flex-1">
          <MonacoDiffEditor
            path={selected.path}
            before={selected.before || ''}
            after={selected.after || ''}
            mode={mode}
          />
        </div>
      </div>
    </div>
  );
}
