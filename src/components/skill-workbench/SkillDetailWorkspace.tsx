'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileText, FolderOpen, Loader2, Rocket, WandSparkles } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { StaticQualityGate } from './StaticEvaluationPanel';

interface SkillDetailWorkspaceProps {
  skillName: string;
  version: number;
  files: Record<string, string>;
  candidate: boolean;
  publishing: boolean;
  optimizing: boolean;
  qualityGate: StaticQualityGate | null;
  onOpenEvaluation: () => void;
  onOptimize: () => void;
  onPublish: () => void;
}

export function SkillDetailWorkspace({
  skillName,
  version,
  files,
  candidate,
  publishing,
  optimizing,
  qualityGate,
  onOpenEvaluation,
  onOptimize,
  onPublish,
}: SkillDetailWorkspaceProps) {
  const paths = useMemo(() => Object.keys(files).sort((left, right) => {
    if (left === 'SKILL.md') return -1;
    if (right === 'SKILL.md') return 1;
    return left.localeCompare(right);
  }), [files]);
  const [selectedPath, setSelectedPath] = useState(paths[0] || '');
  const publishReady = qualityGate?.state === 'passed';
  const gateLabel = qualityGate?.state === 'passed' ? '质量门禁通过'
    : qualityGate?.state === 'blocked' ? `${qualityGate.highIssueCount} 个高风险问题`
      : qualityGate?.state === 'running' ? '静态评估中'
        : qualityGate?.state === 'failed' ? '静态评估失败'
          : qualityGate?.state === 'stale' ? '文件已变化'
            : qualityGate ? '尚未评估' : '读取评估状态';

  useEffect(() => {
    setSelectedPath((current) => current && files[current] !== undefined ? current : paths[0] || '');
  }, [files, paths]);

  const downloadFile = () => {
    if (!selectedPath) return;
    const blob = new Blob([files[selectedPath]], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = selectedPath.split('/').at(-1) || `${skillName}-v${version}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <aside className="w-60 shrink-0 overflow-y-auto border-r border-border bg-card p-3">
        <div className="mb-2 flex items-center gap-2 px-2 text-[11px] font-medium text-foreground-muted">
          <FolderOpen className="size-3.5" />
          工作快照 · {paths.length} 个文件
        </div>
        <div className="space-y-0.5">
          {paths.map((path) => (
            <button
              type="button"
              key={path}
              onClick={() => setSelectedPath(path)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
                path === selectedPath
                  ? 'bg-primary-subtle text-primary'
                  : 'text-foreground-secondary hover:bg-background-secondary',
              )}
            >
              <FileText className="size-3.5 shrink-0" />
              <span className="truncate">{path}</span>
            </button>
          ))}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center border-b border-border bg-card px-4">
          <span className="truncate text-xs font-medium text-foreground">{selectedPath || '无文件'}</span>
          <span className="flex-1" />
          {candidate && (
            <>
              <button
                type="button"
                title={qualityGate?.message || '正在读取当前工作快照的静态质量状态'}
                onClick={onOpenEvaluation}
                className={cn(
                  'mr-2 inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium',
                  publishReady
                    ? 'border-success-border bg-success-subtle text-success'
                    : qualityGate?.state === 'blocked' || qualityGate?.state === 'failed'
                      ? 'border-error-border bg-error-subtle text-error'
                      : 'border-warning-border bg-warning-subtle text-warning',
                )}
              >
                {qualityGate?.state === 'running' || !qualityGate
                  ? <Loader2 className="size-3.5 animate-spin" />
                  : publishReady ? <CheckCircle2 className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
                {gateLabel}
              </button>
              {qualityGate?.state === 'blocked' && qualityGate.highIssueCount > 0 && (
                <button
                  type="button"
                  disabled={optimizing}
                  onClick={onOptimize}
                  className="mr-2 inline-flex h-7 items-center gap-1.5 rounded-md border border-primary px-2.5 text-[11px] font-medium text-primary disabled:opacity-50"
                >
                  {optimizing ? <Loader2 className="size-3.5 animate-spin" /> : <WandSparkles className="size-3.5" />}
                  {optimizing ? '启动修复中' : 'AI 修复问题'}
                </button>
              )}
              <button
                type="button"
                title={publishReady ? `发布为 v${version}` : qualityGate?.message}
                disabled={publishing || !publishReady}
                onClick={onPublish}
                className="mr-2 inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-[11px] font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {publishing ? <Loader2 className="size-3.5 animate-spin" /> : <Rocket className="size-3.5" />}
                发布为 v{version}
              </button>
            </>
          )}
          <button
            type="button"
            disabled={!selectedPath}
            onClick={downloadFile}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-[11px] text-foreground-secondary hover:bg-background-secondary disabled:opacity-40"
          >
            <Download className="size-3.5" />
            下载当前文件
          </button>
        </div>
        <pre className="min-h-0 flex-1 overflow-auto bg-background p-5 font-mono text-xs leading-6 text-foreground-secondary">
          {selectedPath ? files[selectedPath] : '当前工作快照没有可预览的文件。'}
        </pre>
      </div>
    </div>
  );
}
