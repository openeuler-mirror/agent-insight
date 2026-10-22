'use client';

import { Ban, CheckCheck, CheckCircle2, CircleHelp, Clock, FileCheck2, Loader2, MessageSquare, XCircle } from 'lucide-react';
import type { ModuleActivity } from './agent-debug-presentation';
import { STATUS_CLASSES, type StatusKind } from '@/components/feedback/StatusBadge';

const STATES = {
  checking: { icon: Loader2, zh: '检查中', en: 'Checking' },
  waiting: { icon: Loader2, zh: '等待新进展', en: 'Awaiting progress' },
  awaiting_analysis: { icon: Loader2, zh: '等待分析进展', en: 'Awaiting analysis updates' },
  evidence: { icon: FileCheck2, zh: '证据已返回', en: 'Evidence received' },
  updates: { icon: MessageSquare, zh: '已收到阶段内容', en: 'Updates received' },
  stage_done: { icon: CheckCheck, zh: '本轮检查完成', en: 'Stage complete' },
  skipped: { icon: Ban, zh: '已跳过', en: 'Skipped' },
  failed: { icon: XCircle, zh: '阶段失败', en: 'Stage failed' },
  interrupted: { icon: XCircle, zh: '任务中断', en: 'Task interrupted' },
  unknown: { icon: CircleHelp, zh: '状态未知', en: 'Status unknown' },
  result: { icon: CheckCircle2, zh: '已有结果', en: 'Result available' },
  missing: { icon: Clock, zh: '无可用结果', en: 'No available result' },
} as const;

export function DiagnosisModuleStatus({ activity, arrivalSeq, zh }: { activity: ModuleActivity; arrivalSeq?: number; zh: boolean }) {
  const { icon: Icon, ...labels } = STATES[activity];
  const stopped = ['failed', 'interrupted', 'unknown', 'result', 'missing', 'skipped'].includes(activity);
  const arrival = Boolean(arrivalSeq) && !stopped;
  const waiting = activity === 'waiting' || activity === 'awaiting_analysis';
  const status: StatusKind = activity === 'failed' || activity === 'interrupted' || activity === 'unknown' ? 'error'
    : waiting ? 'warning'
      : activity === 'stage_done' || activity === 'result' ? 'success'
        : activity === 'checking' || activity === 'evidence' || activity === 'updates' ? 'running' : 'pending';
  const palette = STATUS_CLASSES[status].subtle;
  const motion = activity === 'checking' ? ' diagnosis-status-spin' : waiting ? ' diagnosis-status-spin-slow' : '';
  return (
    <span key={arrivalSeq || 0} role="status" data-module-activity={activity} className={`inline-flex min-h-5 items-center gap-1 rounded-sm border px-1.5 text-xs font-medium ${palette}${arrival ? ' diagnosis-status-arrival' : ''}`}>
      <span className={`inline-flex shrink-0${arrival ? ' diagnosis-status-pop' : ''}`}>
        <Icon aria-hidden className={`size-3.5${motion}`} />
      </span>
      <span>{zh ? labels.zh : labels.en}</span>
    </span>
  );
}
