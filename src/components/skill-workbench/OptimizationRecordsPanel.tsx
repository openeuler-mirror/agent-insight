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

import { useEffect, useState } from 'react';
import { ArrowDownToLine, CheckCircle2, CircleX, Clock3, GitCompareArrows, Loader2, RotateCcw, Upload, WandSparkles } from 'lucide-react';

import { getOptimizationTargetVersion, getOptimizationTransitionLabel } from '@/lib/skill-workbench/optimization-display';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/client/api';
import { OptimizationRecordDiff } from './OptimizationRecordDiff';

export interface OptimizationRecordView {
  id: string;
  sessionId: string;
  skillName: string;
  status: string;
  summary: string;
  baseVersion: number;
  candidateVersionLabel: string;
  candidateContentHash: string | null;
  sourceKind: string;
  sourceExperimentId: string | null;
  staticEvaluationId?: string | null;
  retestExperimentId?: string | null;
  diff?: Array<{ path?: string; before?: string | null; after?: string | null; changeType?: string }>;
  sourceRefs?: Array<Record<string, unknown>>;
  candidateFiles?: Record<string, string>;
  blockingIssues?: Array<{
    id: string;
    severity: 'high';
    dimension: string;
    summary: string;
    evidence: string | null;
    reasoning: string | null;
    suggestedFix: string | null;
  }>;
  hasRetestableSource: boolean;
  createdAt: string;
  updatedAt?: string;
  publishedVersion: number | null;
  skillId?: string | null;
  activeVersion?: number | null;
  verificationStatus?: string | null;
  verificationMode?: string | null;
  verifiedAt?: string | null;
  verifiedBy?: string | null;
  verificationNote?: string | null;
  errorMessage: string | null;
  sourceSession?: { id: string; title: string } | null;
}

const STATUS_COPY: Record<string, { label: string; tone: string }> = {
  optimizing: { label: '优化中', tone: 'text-primary bg-primary-subtle' },
  pending_retest: { label: '前置质量通过，可发布', tone: 'text-success bg-success-subtle' },
  retesting: { label: '行为验证中', tone: 'text-primary bg-primary-subtle' },
  retest_passed: { label: '行为验证通过', tone: 'text-success bg-success-subtle' },
  retest_failed: { label: '行为验证未通过', tone: 'text-error bg-error-subtle' },
  retest_cancelled: { label: '行为验证已停止', tone: 'text-warning bg-warning-subtle' },
  published: { label: '已发布', tone: 'text-success bg-success-subtle' },
  abandoned: { label: '已放弃', tone: 'text-foreground-muted bg-background-secondary' },
  optimization_failed: { label: '优化失败', tone: 'text-error bg-error-subtle' },
  optimization_cancelled: { label: '优化已停止', tone: 'text-foreground-muted bg-background-secondary' },
};

const ABANDONABLE = new Set(['pending_retest', 'retest_passed', 'retest_failed', 'retest_cancelled']);

function statusCopy(record: OptimizationRecordView) {
  if (record.status === 'published' && record.activeVersion === record.publishedVersion) {
    return { label: '已验证并激活', tone: 'text-success bg-success-subtle' };
  }
  if (record.status === 'published' && record.verificationStatus === 'pending') {
    return { label: '已发布，待外部验证', tone: 'text-warning bg-warning-subtle' };
  }
  if (record.status === 'published' && record.verificationStatus === 'passed') {
    return { label: '外部验证通过', tone: 'text-success bg-success-subtle' };
  }
  if (record.status === 'published' && record.verificationStatus === 'failed') {
    return { label: '外部验证未通过', tone: 'text-error bg-error-subtle' };
  }
  return STATUS_COPY[record.status] || { label: record.status, tone: 'text-foreground-muted bg-background-secondary' };
}

function displayOptimizationError(message: string) {
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network error/i.test(message)) {
    return '模型服务连接失败，当前候选未生成，请稍后重新优化。';
  }
  return message;
}

export function OptimizationRecordsPanel({
  records,
  user,
  selectedRecordId,
  abandoningId,
  publishingId,
  onRetest,
  retestingId,
  onAbandon,
  onPublish,
  onOpenSourceSession,
  onContinue,
  onSelectRecordId,
}: {
  records: OptimizationRecordView[];
  user: string;
  selectedRecordId: string | null;
  abandoningId: string | null;
  publishingId: string | null;
  onRetest?: (record: OptimizationRecordView) => void;
  retestingId?: string | null;
  onAbandon: (record: OptimizationRecordView) => void;
  onPublish: (record: OptimizationRecordView) => void;
  onOpenSourceSession: (record: OptimizationRecordView) => void;
  onContinue: (record: OptimizationRecordView) => void;
  onSelectRecordId: (recordId: string) => void;
}) {
  const selected = records.find((record) => record.id === selectedRecordId) || records[0];
  const [deployment, setDeployment] = useState<{
    phase: 'idle' | 'previewing' | 'confirming' | 'deploying' | 'succeeded' | 'failed';
    preview?: any;
    record?: any;
    error?: string;
  }>({ phase: 'idle' });
  useEffect(() => setDeployment({ phase: 'idle' }), [selected?.id]);
  if (!selected) return null;
  const selectedStatus = statusCopy(selected);
  const publishable = ['pending_retest', 'retest_passed', 'retest_failed', 'retest_cancelled'].includes(selected.status);
  const verification = selected.sourceRefs?.find((ref) => ref.type === 'verification-result');
  const executionFailed = selected.status === 'optimization_failed' && !selected.staticEvaluationId;
  let deploymentResult: Record<string, any> = {};
  try { deploymentResult = JSON.parse(deployment.record?.resultJson || '{}'); } catch {}
  const deploymentEndpoint = `/api/skills/by-name/${encodeURIComponent(selected.skillName)}/deployments`;
  const deploymentBody = {
    user,
    source: { type: 'optimization', optimizationRecordId: selected.id },
  };

  async function readError(response: Response) {
    const body = await response.json().catch(() => ({}));
    return body?.error?.message || body?.message || `请求失败（HTTP ${response.status}）`;
  }

  async function previewDeployment() {
    setDeployment({ phase: 'previewing' });
    try {
      const response = await apiFetch(`${deploymentEndpoint}/preview`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(deploymentBody),
      });
      if (!response.ok) throw new Error(await readError(response));
      setDeployment({ phase: 'confirming', preview: await response.json() });
    } catch (cause) {
      setDeployment({ phase: 'failed', error: cause instanceof Error ? cause.message : '下发预检请求失败' });
    }
  }

  async function confirmDeployment() {
    const preview = deployment.preview;
    let latestRecord = deployment.record;
    setDeployment({ phase: 'deploying', preview });
    try {
      const response = await apiFetch(deploymentEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...deploymentBody,
          confirmed: true,
          idempotencyKey: globalThis.crypto?.randomUUID?.() || `${selected.id}-${Date.now()}`,
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const created = await response.json();
      const deploymentId = created.deployment?.deploymentId;
      latestRecord = created.deployment;
      if (!deploymentId) throw new Error('服务端未返回下发记录标识');
      setDeployment({ phase: 'deploying', preview, record: latestRecord });
      for (let attempt = 0; attempt < 90; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const statusResponse = await apiFetch(`${deploymentEndpoint}/${encodeURIComponent(deploymentId)}?user=${encodeURIComponent(user)}`, { cache: 'no-store' });
        if (!statusResponse.ok) continue;
        const next = await statusResponse.json();
        latestRecord = next.deployment;
        const status = String(next.deployment?.status || '');
        if (status === 'SUCCEEDED') {
          setDeployment({ phase: 'succeeded', preview, record: latestRecord });
          return;
        }
        if (status === 'FAILED' || status === 'FAILED_RESTORED') {
          setDeployment({ phase: 'failed', preview, record: latestRecord, error: next.deployment?.errorMessage || '客户端下发失败' });
          return;
        }
        setDeployment({ phase: 'deploying', preview, record: latestRecord });
      }
      setDeployment({ phase: 'failed', preview, record: latestRecord, error: '等待客户端确认超时，可稍后刷新查看下发记录。' });
    } catch (cause) {
      setDeployment({ phase: 'failed', preview, record: latestRecord, error: cause instanceof Error ? cause.message : '客户端下发请求失败' });
    }
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background p-6">
      <div className="w-full">
        <div className="mb-4 flex items-center gap-2">
          <GitCompareArrows className="size-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">优化记录</h2>
          <span className="text-xs text-foreground-muted">展示顶部所选 Skill 版本的优化尝试；候选确认发布前不会写入正式版本</span>
        </div>
        <div className="grid min-h-[560px] grid-cols-[280px_minmax(0,1fr)] overflow-hidden rounded-lg border border-border bg-card">
          <div className="border-r border-border bg-background-secondary p-2">
            <p className="px-2 py-2 text-[10px] font-medium text-foreground-muted">全部记录 · {records.length}</p>
            <div className="space-y-1">
              {records.map((record) => {
            const status = statusCopy(record);
            return (
              <button type="button" key={record.id} onClick={() => onSelectRecordId(record.id)} className={cn('w-full rounded-md border p-3 text-left', selected.id === record.id ? 'border-primary bg-card' : 'border-transparent hover:bg-card')}>
                <div className="flex items-center gap-2"><b className="text-xs text-foreground">{getOptimizationTransitionLabel(record)}</b><span className={cn('ml-auto rounded px-1.5 py-0.5 text-[9px]', status.tone)}>{status.label}</span></div>
                <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-foreground-muted">{record.summary || '暂无优化摘要'}</p>
                <span className="mt-2 block text-[9px] text-foreground-muted">{new Date(record.createdAt).toLocaleString()}</span>
              </button>
            );
          })}
            </div>
          </div>
          <article className="min-w-0 p-5">
            <div className="flex flex-wrap items-start gap-3">
              <span className="flex size-9 items-center justify-center rounded-md bg-primary-subtle text-primary">
                {selected.status === 'published' || selected.status === 'retest_passed' ? <CheckCircle2 className="size-4" /> : selected.status.includes('failed') ? <CircleX className="size-4" /> : <Clock3 className="size-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold text-foreground">优化报告 · {getOptimizationTransitionLabel(selected)}</h3><span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', selectedStatus.tone)}>{selectedStatus.label}</span></div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                    {onRetest && selected.sourceKind === 'diagnosis' && ABANDONABLE.has(selected.status) && <button type="button" disabled={!selected.sourceExperimentId || !!retestingId} onClick={() => onRetest(selected)} className="rounded border border-border px-3 py-1 text-xs disabled:opacity-50">{retestingId === selected.id ? '复测中…' : selected.sourceExperimentId ? '按原实验配置复测' : '无来源实验可复测'}</button>}
                    {publishable && (
                      <button
                        type="button"
                        disabled={publishingId !== null}
                        onClick={() => onPublish(selected)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                      >
                        {publishingId === selected.id ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                        发布待验证 {getOptimizationTargetVersion(selected)}
                      </button>
                    )}
                    {selected.status === 'published' && selected.publishedVersion !== null && ['passed', 'not_required'].includes(selected.verificationStatus || '') && (
                      <button
                        type="button"
                        disabled={deployment.phase === 'previewing' || deployment.phase === 'deploying'}
                        onClick={() => void previewDeployment()}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                      >
                        {deployment.phase === 'previewing' || deployment.phase === 'deploying'
                          ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowDownToLine className="size-3.5" />}
                        下发到来源客户端
                      </button>
                    )}
                    {selected.status === 'optimization_failed' && <button type="button" onClick={() => onContinue(selected)} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-foreground-secondary hover:bg-background-secondary"><WandSparkles className="size-3.5" />{executionFailed ? '重新优化' : '修复阻断问题'}</button>}
                    {ABANDONABLE.has(selected.status) && (
                      <button
                        type="button"
                        disabled={abandoningId !== null || publishingId !== null}
                        onClick={() => onAbandon(selected)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-foreground-secondary hover:bg-background-secondary disabled:opacity-50"
                      >
                        {abandoningId === selected.id ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                        放弃候选
                      </button>
                    )}
              </div>
            </div>
            {deployment.phase !== 'idle' && (
              <section className="mt-3 rounded-md border border-border bg-background p-3 text-xs">
                {deployment.phase === 'confirming' && deployment.preview ? (
                  <>
                    <b className="text-foreground">确认下发 {selected.skillName} v{deployment.preview.targetVersion?.skillVersion}</b>
                    <p className="mt-1 break-all text-foreground-secondary">目标：{deployment.preview.target?.displayPath || deployment.preview.target?.mode}</p>
                    <p className="mt-1 text-foreground-muted">客户端当前版本：{deployment.preview.current?.skillVersion == null ? '未托管/未知' : `v${deployment.preview.current.skillVersion}`}；操作：{deployment.preview.direction}</p>
                    <p className="mt-1 text-foreground-muted">执行前会按当前版本号备份，安装校验失败时自动恢复。</p>
                    <div className="mt-3 flex gap-2">
                      <button type="button" onClick={() => void confirmDeployment()} className="ai-btn-p">确认下发</button>
                      <button type="button" onClick={() => setDeployment({ phase: 'idle' })} className="ai-btn-s">取消</button>
                    </div>
                  </>
                ) : deployment.phase === 'succeeded' ? (
                  <p className="text-success">
                    下发成功，客户端已安装 v{deployment.preview?.targetVersion?.skillVersion}
                    {deployment.preview?.current?.exists ? '；原版本已按版本号备份' : ''}
                    {deploymentResult.restartRequired ? '；请重启 JiuwenSwarm 使新版本生效' : ''}。
                  </p>
                ) : deployment.phase === 'failed' ? (
                  <p className="text-error">{deployment.error || '下发失败'}{deployment.record?.status === 'FAILED_RESTORED' ? '（已自动恢复原版本）' : ''}</p>
                ) : (
                  <p className="text-foreground-secondary">{deployment.phase === 'previewing' ? '正在检查客户端与目标路径…' : `正在下发：${deployment.record?.status || '等待客户端接收'}…`}</p>
                )}
              </section>
            )}
            <section className="mt-4 w-full overflow-hidden rounded-md border border-border bg-background">
              <div className="border-b border-border bg-background-secondary px-3 py-1.5 text-[10px] font-medium text-foreground-muted">
                优化摘要
              </div>
              <div
                className="max-h-64 min-h-28 overflow-y-auto whitespace-pre-wrap break-words px-3 py-3 text-xs leading-5 text-foreground-secondary"
                style={{ scrollbarGutter: 'stable' }}
              >
                {selected.summary || '暂无优化摘要'}
              </div>
            </section>
            <div className="grid grid-cols-3 gap-3 py-4">
              <Metric label="基线版本" value={`v${selected.baseVersion}`} />
              <Metric label="候选版本" value={getOptimizationTargetVersion(selected)} />
              <Metric label="静态质量" value={selected.status === 'optimization_cancelled' ? '已停止' : executionFailed ? '未执行' : selected.status === 'optimization_failed' ? '未通过' : selected.staticEvaluationId ? '已通过' : '待完成'} />
            </div>
            {selected.retestExperimentId && <a href={`/experiments/${encodeURIComponent(selected.retestExperimentId)}`} className="mb-3 inline-block text-xs text-primary hover:underline">查看行为验证实验</a>}
            {verification && <p className="mb-2 text-xs text-foreground-secondary">行为验证：{String(verification.sourceScore ?? '—')} → {String(verification.candidateScore ?? '—')} 分，{String(verification.measured ?? 0)} 个用例{verification.fullCoverage ? '，完整覆盖' : '，部分覆盖'}。</p>}
            {selected.sourceRefs?.some((ref) => ref.type === 'verification-cleanup') && <p className="mb-3 text-xs text-foreground-muted">优化临时实验已自动清理，验证摘要和复用证据已保留。</p>}
            <section className="rounded-md border border-border">
              <div className="flex items-center border-b border-border px-3 py-2"><b className="text-xs text-foreground">版本差异</b><span className="ml-auto text-[10px] text-foreground-muted">{selected.diff?.length || 0} 个文件变更</span></div>
              {selected.diff?.length
                ? <OptimizationRecordDiff files={selected.diff} />
                : <p className="py-8 text-center text-xs text-foreground-muted">优化完成后将在这里展示真实文件差异</p>}
            </section>
            {selected.status === 'optimization_failed' && Boolean(selected.blockingIssues?.length) && (
              <section className="mt-3 rounded-md border border-error bg-error-subtle p-3">
                <div className="flex items-center gap-2"><CircleX className="size-4 text-error" /><b className="text-xs text-foreground">仍有 {selected.blockingIssues!.length} 个阻断问题</b></div>
                <div className="mt-2 space-y-2">
                  {selected.blockingIssues!.map((issue) => (
                    <div key={issue.id} className="rounded border border-border bg-card p-2 text-[10px] leading-4 text-foreground-secondary">
                      <b className="text-foreground">{issue.summary}</b>
                      {(issue.evidence || issue.reasoning) && <p className="mt-1">依据：{issue.evidence || issue.reasoning}</p>}
                      {issue.suggestedFix && <p className="mt-1">建议：{issue.suggestedFix}</p>}
                    </div>
                  ))}
                </div>
              </section>
            )}
            {selected.sourceRefs?.filter(ref => ref.type === 'diagnosis' && typeof ref.id === 'string').map(ref =>
              <a key={String(ref.id)} className="mt-2 block text-xs text-primary" href={`${process.env.NEXT_PUBLIC_URL_PREFIX || ''}/diagnosis-runs/${encodeURIComponent(String(ref.id))}`}>查看来源诊断与评测证据</a>)}
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-foreground-muted"><span>依据：{selected.sourceKind}</span><button type="button" onClick={() => onOpenSourceSession(selected)} className="text-primary hover:underline disabled:text-foreground-muted" disabled={!selected.sourceSession}>来源会话：{selected.sourceSession?.title || selected.sessionId}</button><span>快照：{selected.candidateContentHash || '计算中'}</span>{selected.publishedVersion !== null && <span>正式版本：v{selected.publishedVersion}</span>}</div>
            {selected.errorMessage && <p className="mt-2 text-xs text-error">{displayOptimizationError(selected.errorMessage)}</p>}
          </article>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md border border-border bg-background p-3"><span className="text-[10px] text-foreground-muted">{label}</span><b className="mt-1 block text-lg text-foreground">{value}</b></div>;
}
