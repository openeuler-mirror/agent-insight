'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ChevronDown, ChevronRight } from 'lucide-react'
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
import type { LangfuseTraceNode } from '@/lib/ingest/otel/adapters/langfuse-trace'
import {
  loadFaultLabelsBundle,
  resolveSubmodeLabel,
} from '@/lib/fault-injection/fault-labels-cache'
import { buildMarkerPipeline } from '@/lib/fault-injection/marker-pipeline'
import type { FiPipelineMarker } from '@/lib/fault-injection/trace-markers'
import { apiFetch } from '@/lib/client/api'
import { useLocale } from '@/lib/client/locale-context'
import { cn } from '@/lib/utils'

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
  const [pipelineOpen, setPipelineOpen] = useState(false)
  const [structureInteractions, setStructureInteractions] = useState<RawInteraction[] | null>(null)
  const [langfuseTraceNodes, setLangfuseTraceNodes] = useState<LangfuseTraceNode[]>([])
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
    const taskId = trace?.taskId
    if (!taskId) {
      setStructureInteractions(null)
      setLangfuseTraceNodes([])
      return
    }
    let cancelled = false
    void apiFetch(`/api/observe/session?taskId=${encodeURIComponent(taskId)}&view=structure`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((body) => {
        if (cancelled) return
        setStructureInteractions(Array.isArray(body?.interactions) ? body.interactions : [])
        setLangfuseTraceNodes(Array.isArray(body?.langfuseTraceNodes) ? body.langfuseTraceNodes : [])
      })
      .catch(() => {
        if (!cancelled) {
          setStructureInteractions(null)
          setLangfuseTraceNodes([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [trace?.taskId])

  const loadInteraction = useCallback(async (index: number) => {
    const taskId = trace?.taskId
    if (!taskId) throw new Error('missing taskId')
    const response = await apiFetch(
      `/api/observe/session?taskId=${encodeURIComponent(taskId)}&view=interaction&index=${index}`,
    )
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json()
    return body?.interaction
  }, [trace?.taskId])

  const loadFullInteractions = useCallback(async () => {
    const taskId = trace?.taskId
    if (!taskId) return trace?.interactions || []
    const response = await apiFetch(
      `/api/observe/session?taskId=${encodeURIComponent(taskId)}&view=interactions`,
    )
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json()
    return Array.isArray(body?.interactions) ? body.interactions : []
  }, [trace?.taskId, trace?.interactions])

  const displayInteractions = structureInteractions ?? trace?.interactions ?? []

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

  const pipelineSteps = useMemo(
    () => buildMarkerPipeline(trace?.pipelineMarkers || [], locale === 'zh' ? 'zh' : 'en'),
    [trace?.pipelineMarkers, locale],
  )
  const pipelineDoneCount = pipelineSteps.filter((step) => step.done).length
  const pipelineLatestLabel =
    [...pipelineSteps].reverse().find((step) => step.done)?.label ||
    (zh ? '尚未开始' : 'Not started')

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
              ? '单次故障注入的摘要与调用树。FI 注入/评判事件与同 session 的真 RAS 检出是不同来源：本页可并列显示，但互不归属；可靠性观测是独立入口。'
              : 'Summary and call tree for one fault-injection run. FI injection/judge events and real RAS detections on the same session are different sources: both may appear here, but neither owns the other. Reliability observing is a separate entry.'}
          </HelpTip>
        </div>

        {trace?.taskId ? (
          <p className="text-sm text-foreground-muted">
            Trace ID：
            <CopyableId value={trace.taskId} className="ml-1" />
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
                        ? '平台原生 session（Trace ID）。可复制；同 session 上的 RAS 事件是独立来源，不由此页合成。'
                        : 'Bare platform session (Trace ID). Copyable; RAS events on the same session are a separate source, not synthesized here.'
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

            <div className="shrink-0 rounded-md border border-border bg-card">
              <div className="flex items-center gap-1 pr-2">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left hover:bg-background-secondary/60"
                  aria-expanded={pipelineOpen}
                  onClick={() => setPipelineOpen((open) => !open)}
                >
                  {pipelineOpen ? (
                    <ChevronDown className="size-4 shrink-0 text-foreground-muted" aria-hidden />
                  ) : (
                    <ChevronRight className="size-4 shrink-0 text-foreground-muted" aria-hidden />
                  )}
                  <span className="text-[13px] font-semibold">
                    {zh ? '注入流程' : 'Injection pipeline'}
                  </span>
                  <span className="ml-auto truncate text-xs text-foreground-muted">
                    {`${pipelineDoneCount}/4 · ${pipelineLatestLabel}`}
                  </span>
                </button>
                <HelpTip>
                  {zh
                    ? '固定四节点：请求 → 开始 → 完成 → 评判。默认收起以免挤占下方链路追踪；点击标题展开。'
                    : 'Fixed four nodes: request → start → complete → judge. Collapsed by default so the call tree keeps the first screen; click to expand.'}
                </HelpTip>
              </div>
              <div className={cn('border-t border-border px-3 py-3', !pipelineOpen && 'hidden')}>
                <MarkerPipeline markers={trace.pipelineMarkers || []} />
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
              <div className="flex shrink-0 items-center gap-1.5">
                <h2 className="text-[13px] font-semibold">
                  {zh ? '完整链路追踪' : 'Full call tree'}
                </h2>
                <HelpTip widthClass="w-80">
                  {zh
                    ? '过滤 AGENT / LLM / TOOL 等 span；左侧调用树，右侧详情。FI markers 与真 RAS markers 分源标注。非终态时自动轮询并尽量保持选中。'
                    : 'Filters AGENT / LLM / TOOL spans; call tree on the left, details on the right. FI markers and real RAS markers keep distinct sources. Auto-polls before terminal and tries to keep selection.'}
                </HelpTip>
                <span className="text-xs text-foreground-muted">
                  {displayInteractions.length} interactions
                </span>
              </div>
              <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-card">
                <AgentTraceView
                  interactions={displayInteractions}
                  framework={trace.framework}
                  langfuseTraceNodes={langfuseTraceNodes}
                  loadInteraction={trace.taskId ? loadInteraction : undefined}
                  loadAllInteractions={trace.taskId ? loadFullInteractions : undefined}
                  rootSessionId={trace.taskId || undefined}
                  rootExecutionId={trace.taskId || params.runId}
                  traceKey={trace.taskId || params.runId}
                  anomalies={[...(trace.rasMarkers || []), ...(trace.markers || [])]}
                  reliabilityEvents={[]}
                  panelClassName="h-full min-h-0"
                />
              </div>
            </div>
          </>
        )}
      </div>
    </FiPageShell>
  )
}
