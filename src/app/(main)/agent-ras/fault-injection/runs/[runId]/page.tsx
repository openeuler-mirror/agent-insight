'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { FiPageShell } from '@/components/fault-injection/FiPageShell'
import { HelpTip, LabelWithHelp } from '@/components/fault-injection/HelpTip'
import { CopyableId } from '@/components/fault-injection/CopyableId'
import { MarkerPipeline } from '@/components/fault-injection/MarkerPipeline'
import { PlatformChip, RunStatusBadge } from '@/components/fault-injection/TaskStatus'
import {
  CONTAINMENT_LABELS,
  OUTCOME_LABELS,
  labelMap,
} from '@/components/fault-injection/types'
import AgentTraceView from '@/components/observe/AgentTraceView'
import type { FiPipelineMarker } from '@/lib/fault-injection/trace-markers'

type TracePayload = {
  taskId?: string | null
  taskKey?: string | null
  taskName?: string | null
  framework?: string
  fault?: string
  submode?: string | null
  model?: string | null
  runId?: string
  status?: string
  error?: string | null
  judge?: {
    outcome?: string | null
    faultContainmentStatus?: string | null
    reason?: string | null
  }
  interactions?: unknown[]
  markers?: unknown[]
  pipelineMarkers?: FiPipelineMarker[]
  reliabilityEvents?: unknown[]
}

const TERMINAL = new Set(['completed', 'judge_skipped', 'dry_run', 'failed', 'stopped'])

export default function FaultInjectionRunTracePage() {
  const params = useParams<{ runId: string }>()
  const [trace, setTrace] = useState<TracePayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const statusRef = useRef<string | undefined>(undefined)

  const load = useCallback(async () => {
    if (!params.runId) return
    const res = await fetch(`/api/fault-injection/runs/${params.runId}/trace`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'load failed')
    setTrace(data)
    statusRef.current = data.status
  }, [params.runId])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void load()
      .catch((e) => {
        if (!cancelled) setError(String(e.message || e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    const timer = window.setInterval(() => {
      const status = statusRef.current
      if (status && TERMINAL.has(status)) return
      void load().catch(() => undefined)
    }, 2000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [load])

  // Terminal empty interactions: one more pull
  useEffect(() => {
    if (!trace?.status || !TERMINAL.has(trace.status)) return
    if ((trace.interactions || []).length > 0) return
    const t = window.setTimeout(() => {
      void load().catch(() => undefined)
    }, 1500)
    return () => window.clearTimeout(t)
  }, [trace?.status, trace?.interactions, load])

  const judge = trace?.judge
  const taskHref = trace?.taskKey
    ? `/agent-ras/fault-injection/tasks/${trace.taskKey}`
    : '/agent-ras/fault-injection/tasks'

  return (
    <FiPageShell>
      <div className="flex flex-wrap items-center gap-1.5 text-sm text-foreground-muted">
        <Link href="/agent-ras/fault-injection/tasks" className="text-primary hover:underline">
          注入任务
        </Link>
        <span>/</span>
        <Link href={taskHref} className="text-primary hover:underline">
          {trace?.taskName || trace?.taskKey || '任务'}
        </Link>
        <span>/</span>
        <span className="font-mono text-xs text-foreground">{params.runId}</span>
        <HelpTip widthClass="w-80">
          单次故障注入的摘要与调用树。数据来自 collect-result / Session.interactions；顶部四节点展示注入与评判流程。
          若故障已激活，会同步写入 RasAnomalyEvent，可在「可靠性观测」按 Session taskId 查看。
        </HelpTip>
      </div>

      {trace?.status === 'dry_run' ? (
        <p className="rounded-md border border-[var(--warning)]/40 bg-[var(--warning-subtle)] px-3 py-2 text-sm text-[var(--warning)]">
          这是 Dry-run 模拟数据，未启动真实 Agent，也不会写入可靠性观测。
        </p>
      ) : null}

      {trace?.taskId ? (
        <p className="text-sm text-foreground-muted">
          Session taskId：
          <CopyableId value={trace.taskId} className="ml-1" />
          <Link
            href={`/agent-ras/trace/${encodeURIComponent(trace.taskId)}`}
            className="ml-2 text-primary hover:underline"
          >
            打开可靠性观测
          </Link>
        </p>
      ) : null}
      {loading && <p className="text-sm text-foreground-muted">加载中…</p>}
      {error && <p className="text-sm text-[var(--error)]">{error}</p>}

      {trace && (
        <>
          <div className="rounded-md border border-border bg-card">
            <div className="grid gap-0 sm:grid-cols-2 lg:grid-cols-5">
              <div className="border-b border-border p-3 lg:border-b-0 lg:border-r">
                <LabelWithHelp tip="实验管线终态。失败常见于插件未就绪、平台超时或执行异常。">
                  <span className="text-[11px] text-foreground-muted">状态</span>
                </LabelWithHelp>
                <div className="mt-1.5">
                  <RunStatusBadge status={trace.status || '—'} />
                </div>
              </div>
              <div className="border-b border-border p-3 lg:border-b-0 lg:border-r">
                <div className="text-[11px] text-foreground-muted">故障 / 平台</div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs font-medium">
                  <span>{trace.fault || '—'}</span>
                  {trace.submode ? (
                    <span className="font-mono text-foreground-muted">@{trace.submode}</span>
                  ) : null}
                  <PlatformChip platform={trace.framework || '—'} />
                </div>
              </div>
              <div className="border-b border-border p-3 lg:border-b-0 lg:border-r">
                <LabelWithHelp tip="两维判定：①注入是否成功；②成功后是否恢复，或未发生时是否被阻断。无模型或跳过评判时显示「评判跳过」。">
                  <span className="text-[11px] text-foreground-muted">评判结果</span>
                </LabelWithHelp>
                <div className="mt-1.5 text-xs font-medium">
                  {judge?.outcome
                    ? `${labelMap(OUTCOME_LABELS, judge.outcome)} · ${labelMap(CONTAINMENT_LABELS, judge.faultContainmentStatus)}`
                    : '—'}
                </div>
              </div>
              <div className="border-b border-border p-3 sm:border-b-0 lg:border-r">
                <LabelWithHelp tip="任务配置的模型；未指定时显示平台默认。">
                  <span className="text-[11px] text-foreground-muted">模型</span>
                </LabelWithHelp>
                <div className="mt-1.5 break-all font-mono text-xs">{trace.model || '默认'}</div>
              </div>
              <div className="p-3">
                <LabelWithHelp tip="平台 session / task 标识，用于与 Insight 轨迹对齐。可复制。">
                  <span className="text-[11px] text-foreground-muted">任务 ID</span>
                </LabelWithHelp>
                <div className="mt-1.5">
                  {trace.taskId ? <CopyableId value={trace.taskId} /> : '—'}
                </div>
              </div>
            </div>
          </div>

          {trace.error ? (
            <div className="rounded-md border border-[var(--error-border)] bg-[var(--error-subtle)] px-3 py-2 text-sm text-[var(--error)]">
              {trace.error}
            </div>
          ) : null}

          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              <h2 className="text-[13px] font-semibold">注入流程</h2>
              <HelpTip>固定四节点：请求 → 开始 → 完成 → 评判。未到达的节点保持空心。</HelpTip>
            </div>
            <MarkerPipeline markers={trace.pipelineMarkers || []} />
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              <h2 className="text-[13px] font-semibold">完整链路追踪</h2>
              <HelpTip widthClass="w-80">
                过滤 AGENT / LLM / TOOL 等 span；左侧调用树，右侧详情。非终态时自动轮询并尽量保持选中。
              </HelpTip>
              <span className="text-xs text-foreground-muted">
                {(trace.interactions || []).length} interactions
              </span>
            </div>
            <AgentTraceView
              interactions={trace.interactions || []}
              traceKey={trace.taskId || params.runId}
              anomalies={trace.markers || []}
              reliabilityEvents={(trace.reliabilityEvents || []) as any}
            />
          </div>
        </>
      )}
    </FiPageShell>
  )
}
