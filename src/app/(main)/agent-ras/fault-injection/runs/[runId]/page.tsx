'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { FiPageShell } from '@/components/fault-injection/FiPageShell'
import { HelpTip, LabelWithHelp } from '@/components/fault-injection/HelpTip'
import { CopyableId } from '@/components/fault-injection/CopyableId'
import { MarkerPipeline } from '@/components/fault-injection/MarkerPipeline'
import { PlatformChip, RunStatusBadge } from '@/components/fault-injection/TaskStatus'
import { containmentLabel, outcomeLabel } from '@/components/fault-injection/types'
import AgentTraceView, {
  type RasAnomalyMarker,
  type RasTimelineEvent,
} from '@/components/observe/AgentTraceView'
import type { RawInteraction } from '@/lib/engine/observability/agent-trace'
import {
  loadFaultLabelsBundle,
  resolveSubmodeLabel,
} from '@/lib/fault-injection/fault-labels-cache'
import type { FiPipelineMarker } from '@/lib/fault-injection/trace-markers'
import { useLocale } from '@/lib/client/locale-context'

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
  interactions?: RawInteraction[]
  markers?: RasAnomalyMarker[]
  rasMarkers?: RasAnomalyMarker[]
  pipelineMarkers?: FiPipelineMarker[]
  reliabilityEvents?: RasTimelineEvent[]
}

const TERMINAL = new Set(['completed', 'judge_skipped', 'failed', 'stopped'])

export default function FaultInjectionRunTracePage() {
  const { locale } = useLocale()
  const zh = locale === 'zh'
  const params = useParams<{ runId: string }>()
  const [trace, setTrace] = useState<TracePayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [submodeLabel, setSubmodeLabel] = useState<string | null>(null)
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
    if (!trace?.fault) {
      setSubmodeLabel(null)
      return
    }
    void loadFaultLabelsBundle()
      .then(() => {
        setSubmodeLabel(
          resolveSubmodeLabel(trace.fault || '', trace.submode) || trace.submode || null,
        )
      })
      .catch(() => setSubmodeLabel(trace.submode || null))
  }, [trace?.fault, trace?.submode])

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
    <FiPageShell className="overflow-hidden" contentClassName="overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-sm text-foreground-muted">
          <Link href="/agent-ras/fault-injection/tasks" className="text-primary hover:underline">
            {zh ? '注入任务' : 'Injection tasks'}
          </Link>
          <span>/</span>
          <Link href={taskHref} className="text-primary hover:underline">
            {trace?.taskName || trace?.taskKey || (zh ? '任务' : 'Task')}
          </Link>
          <span>/</span>
          <span className="font-mono text-xs text-foreground">{params.runId}</span>
          <HelpTip widthClass="w-80">
            {zh
              ? '单次故障注入的摘要与调用树。数据来自 collect-result / Session.interactions；顶部四节点展示注入与评判流程。注入细节只在本页与 FI 任务视图；可靠性观测以正常上报的轨迹（Execution）为准，不再为「注入激活」合成 RasAnomalyEvent。'
              : 'Summary and call tree for one fault-injection run. Data comes from collect-result / Session.interactions; the top four nodes show injection and judge flow. Injection details stay on this page and FI tasks; reliability observing uses normally uploaded Execution traces — no synthetic RasAnomalyEvent for activation.'}
          </HelpTip>
        </div>

        {trace?.taskId ? (
          <p className="text-sm text-foreground-muted">
            Trace ID：
            <CopyableId value={trace.taskId} className="ml-1" />
            <Link
              href={`/agent-ras/trace/${encodeURIComponent(trace.taskId)}`}
              className="ml-2 text-primary hover:underline"
            >
              {zh ? '打开可靠性观测' : 'Open reliability'}
            </Link>
            <span className="ml-1 text-xs">
              {zh ? '（需同 Trace ID 已有轨迹上报）' : '(requires an uploaded trace for this Trace ID)'}
            </span>
          </p>
        ) : null}
        {loading && (
          <p className="text-sm text-foreground-muted">{zh ? '加载中…' : 'Loading…'}</p>
        )}
        {error && <p className="text-sm text-[var(--error)]">{error}</p>}

        {trace && (
          <>
            <div className="shrink-0 rounded-md border border-border bg-card">
              <div className="grid gap-0 sm:grid-cols-2 lg:grid-cols-5">
                <div className="border-b border-border p-3 lg:border-b-0 lg:border-r">
                  <LabelWithHelp
                    tip={
                      zh
                        ? '实验管线终态。失败常见于插件未就绪、平台超时或执行异常。'
                        : 'Pipeline terminal state. Failures often mean plugin not ready, platform timeout, or runtime errors.'
                    }
                  >
                    <span className="text-[11px] text-foreground-muted">
                      {zh ? '状态' : 'Status'}
                    </span>
                  </LabelWithHelp>
                  <div className="mt-1.5">
                    <RunStatusBadge status={trace.status || '—'} />
                  </div>
                </div>
                <div className="border-b border-border p-3 lg:border-b-0 lg:border-r">
                  <div className="text-[11px] text-foreground-muted">
                    {zh ? '故障 / 平台' : 'Fault / Platform'}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs font-medium">
                    <span>{trace.fault || '—'}</span>
                    {submodeLabel ? (
                      <span className="text-foreground-muted">· {submodeLabel}</span>
                    ) : null}
                    <PlatformChip platform={trace.framework || '—'} />
                  </div>
                </div>
                <div className="border-b border-border p-3 lg:border-b-0 lg:border-r">
                  <LabelWithHelp
                    tip={
                      zh
                        ? '两维判定：①注入是否成功；②成功后是否恢复，或未发生时是否被阻断。无模型或跳过评判时显示「评判跳过」。'
                        : 'Two-axis verdict: (1) whether injection occurred; (2) recovery after success, or prevention when it did not. Shows Judge skipped when no model or judge is skipped.'
                    }
                  >
                    <span className="text-[11px] text-foreground-muted">
                      {zh ? '评判结果' : 'Judge result'}
                    </span>
                  </LabelWithHelp>
                  <div className="mt-1.5 text-xs font-medium">
                    {judge?.outcome
                      ? `${outcomeLabel(judge.outcome, locale)} · ${containmentLabel(judge.faultContainmentStatus, locale)}`
                      : '—'}
                  </div>
                </div>
                <div className="border-b border-border p-3 sm:border-b-0 lg:border-r">
                  <LabelWithHelp
                    tip={
                      zh
                        ? '优先任务配置的模型；未指定时回退 Session / 轨迹 modelID / 平台默认（Worker inventory）。'
                        : 'Prefers task model; falls back to Session / interaction modelID / platform default (worker inventory).'
                    }
                  >
                    <span className="text-[11px] text-foreground-muted">
                      {zh ? '模型' : 'Model'}
                    </span>
                  </LabelWithHelp>
                  <div className="mt-1.5 break-all font-mono text-xs">
                    {trace.model || (zh ? '默认' : 'Default')}
                  </div>
                </div>
                <div className="p-3">
                  <LabelWithHelp
                    tip={
                      zh
                        ? 'Trace ID（平台原生 session），与可靠性观测 Execution.taskId 对齐。可复制。'
                        : 'Trace ID (bare platform session), aligns with reliability Execution.taskId. Copyable.'
                    }
                  >
                    <span className="text-[11px] text-foreground-muted">Trace ID</span>
                  </LabelWithHelp>
                  <div className="mt-1.5">
                    {trace.taskId ? <CopyableId value={trace.taskId} /> : '—'}
                  </div>
                </div>
              </div>
            </div>

            {trace.error ? (
              <div className="shrink-0 rounded-md border border-[var(--error-border)] bg-[var(--error-subtle)] px-3 py-2 text-sm text-[var(--error)]">
                {trace.error}
              </div>
            ) : null}

            <div className="shrink-0 space-y-3">
              <div className="flex items-center gap-1.5">
                <h2 className="text-[13px] font-semibold">
                  {zh ? '注入流程' : 'Injection pipeline'}
                </h2>
                <HelpTip>
                  {zh
                    ? '固定四节点：请求 → 开始 → 完成 → 评判。未到达的节点保持空心。'
                    : 'Fixed four nodes: request → start → complete → judge. Pending nodes stay hollow.'}
                </HelpTip>
              </div>
              <MarkerPipeline markers={trace.pipelineMarkers || []} />
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
              <div className="flex shrink-0 items-center gap-1.5">
                <h2 className="text-[13px] font-semibold">
                  {zh ? '完整链路追踪' : 'Full call tree'}
                </h2>
                <HelpTip widthClass="w-80">
                  {zh
                    ? '过滤 AGENT / LLM / TOOL 等 span；左侧调用树，右侧详情。非终态时自动轮询并尽量保持选中。'
                    : 'Filters AGENT / LLM / TOOL spans; call tree on the left, details on the right. Auto-polls before terminal and tries to keep selection.'}
                </HelpTip>
                <span className="text-xs text-foreground-muted">
                  {(trace.interactions || []).length} interactions
                </span>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                <AgentTraceView
                  interactions={trace.interactions || []}
                  traceKey={trace.taskId || params.runId}
                  anomalies={[...(trace.rasMarkers || []), ...(trace.markers || [])]}
                  reliabilityEvents={[]}
                  panelClassName="h-full min-h-[520px]"
                />
              </div>
            </div>
          </>
        )}
      </div>
    </FiPageShell>
  )
}
