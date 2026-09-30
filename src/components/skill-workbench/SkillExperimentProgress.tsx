import type { ExperimentItemProgress } from '@/lib/skill-workbench/item-progress';

type EvaluationProgress = ExperimentItemProgress & { skipped?: number; unscored?: number };

export interface SkillExperimentProgressProps {
  status: string;
  preset: string | null;
  traceSource?: string;
  executionProgress: ExperimentItemProgress | null;
  evaluationProgress: EvaluationProgress | null;
  sideProgress?: Partial<Record<'a' | 'b', {
    executionProgress: ExperimentItemProgress;
    evaluationProgress: EvaluationProgress;
  }>> | null;
  versionALabel?: string;
  versionBLabel?: string;
}

function ProgressRow({ label, progress }: { label: string; progress: EvaluationProgress | null }) {
  const total = progress?.total || 0;
  const ended = progress ? Math.max(0, Math.min(total, total - progress.pending)) : 0;
  const percent = total > 0 ? Math.floor(ended / total * 100) : 0;
  const text = !progress ? '进度暂不可用' : total === 0 ? '暂无执行项' : `已结束 ${ended} / ${total} 项`;
  const complete = total > 0 && ended === total;
  const fill = complete && (progress?.failed || progress?.skipped)
    ? 'bg-error'
    : complete && !progress?.unscored ? 'bg-success' : 'bg-foreground-muted';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium text-foreground">{label}</span>
        <span className="tabular-nums text-foreground-secondary">{text}</span>
      </div>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ? percent : undefined} aria-valuetext={text} className="h-2 overflow-hidden rounded-full bg-background-secondary">
        <div className={`h-full rounded-full transition-all ${fill}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export function SkillExperimentProgress({
  status, preset, traceSource, executionProgress, evaluationProgress, sideProgress, versionALabel, versionBLabel,
}: SkillExperimentProgressProps) {
  const isAb = preset === 'skill-ab';
  const existingTrace = !isAb && traceSource === 'existing';
  const executionLabel = existingTrace ? 'Trace 就绪' : '用例执行';
  const evaluationLabel = preset === 'trigger' ? '触发判定' : '结果评测';
  const pendingExecution = (executionProgress?.pending || 0) > 0;
  const pendingEvaluation = (evaluationProgress?.pending || 0) > 0;
  const settled = ['done', 'partial', 'failed'].includes(status) && !pendingExecution && !pendingEvaluation;
  const hasFailures = Boolean(executionProgress?.failed || evaluationProgress?.failed || status === 'failed' || status === 'partial');
  const hasUnscored = Boolean(evaluationProgress?.unscored);
  const hasProgress = Boolean(executionProgress && evaluationProgress);
  const label = status === 'cancelled' ? '已取消'
    : status === 'draft' ? '准备中'
    : settled ? hasFailures ? '已结束 · 存在失败项' : hasUnscored ? '已结束 · 存在未计分项' : '已完成'
      : !hasProgress ? '运行中'
      : pendingExecution ? existingTrace ? '等待 Trace' : '执行中'
        : pendingEvaluation ? '评测中' : '汇总中';
  const issues = [
    executionProgress?.failed ? `${executionProgress.failed} 项执行失败` : '',
    evaluationProgress?.failed ? `${evaluationProgress.failed} 项评测失败` : '',
    evaluationProgress?.skipped ? `${evaluationProgress.skipped} 项未评测` : '',
    evaluationProgress?.unscored ? `${evaluationProgress.unscored} 项未计分` : '',
  ].filter(Boolean);
  const hint = status === 'cancelled' ? '实验已取消。'
    : status === 'draft' ? '等待开始执行。'
    : settled ? issues.length ? `${issues.join('，')}；请在下方明细中查看原因。`
      : hasFailures ? '请在下方明细中查看失败原因。' : `${evaluationLabel}已结束。`
      : !hasProgress ? '等待进度数据更新。'
      : pendingExecution ? existingTrace ? '等待所选 Trace 就绪。' : '正在执行用例。'
        : pendingEvaluation ? preset === 'trigger' ? '正在判定 Skill 触发结果。' : '正在评测执行结果。'
          : '正在整理实验结果。';

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h3 className="text-base font-semibold text-foreground">实验进度</h3>
        <span className="text-sm text-foreground-secondary">{label}</span>
      </div>
      <div className="space-y-5 p-4">
        {([
          [executionLabel, 'executionProgress', executionProgress],
          [evaluationLabel, 'evaluationProgress', evaluationProgress],
        ] as const).map(([title, key, progress]) => (
          isAb && sideProgress ? (
            <div key={key} className="space-y-3">
              <h4 className="text-sm font-semibold text-foreground">{title}</h4>
              <div className="grid gap-4 md:grid-cols-2">
                <ProgressRow label={`A ${versionALabel || ''} · ${title}`} progress={sideProgress.a?.[key] || null} />
                <ProgressRow label={`B ${versionBLabel || ''} · ${title}`} progress={sideProgress.b?.[key] || null} />
              </div>
            </div>
          ) : <ProgressRow key={key} label={title} progress={progress} />
        ))}
        <div className="space-y-1 text-sm text-foreground-muted">
          <p>{hint}</p>
          <p>进度表示处理结束的比例，包含失败、未评测和未计分项。</p>
        </div>
      </div>
    </section>
  );
}
