import { randomBytes } from 'crypto'
import { prisma } from '@/lib/storage/prisma'
import { composeFaultPrompt, findSubmode } from '@/lib/fault-injection/compose-prompt'
import { listFaultsViaPython, type CollectPayload } from '@/lib/fault-injection/engine'
import { judgeFaultInjection } from '@/lib/fault-injection/judge'
import { mergeEvaluationMarkers } from '@/lib/fault-injection/trace-markers'

export function newTaskKey(): string {
  return `task-${randomBytes(4).toString('hex')}`
}

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').slice(0, 15)
  return `ras-${stamp}-${randomBytes(4).toString('hex')}`
}

export async function createTaskWithRuns(input: {
  user: string | null
  name?: string
  platform: string
  agent: string
  prompt: string
  workspace: string
  model?: string | null
  items: Array<{ fault: string; submode?: string | null }>
  timeoutSeconds?: number | null
  initialStatus?: 'queued' | 'running'
}) {
  const taskKey = newTaskKey()
  const items = input.items.map((item, index) => ({
    item_id: `item-${index + 1}`,
    fault: item.fault,
    submode: item.submode || null,
    run_id: null as string | null,
    status: 'queued',
    phase: 'queued',
    error: null as string | null,
    result: null as Record<string, unknown> | null,
  }))

  const initialStatus = input.initialStatus || 'queued'
  const requestJson = JSON.stringify({
    timeoutSeconds: input.timeoutSeconds ?? null,
  })

  const task = await prisma.faultInjectionTask.create({
    data: {
      taskKey,
      name: input.name || `注入任务 ${taskKey}`,
      status: initialStatus,
      platform: input.platform,
      agent: input.agent,
      prompt: input.prompt,
      workspace: input.workspace,
      model: input.model || null,
      requestJson,
      itemsJson: JSON.stringify(items),
      progressJson: JSON.stringify({
        total: items.length,
        queued: items.length,
        running: 0,
        completed: 0,
        failed: 0,
        judge_skipped: 0,
        stopped: 0,
      }),
      user: input.user,
      startedAt: initialStatus === 'queued' ? null : new Date(),
    },
  })

  const catalog = (await listFaultsViaPython(input.platform)) as Array<{
    id?: string
    name?: string
    skillName?: string
    skill_name?: string
    submodes?: Array<{ id: string; name: string }>
  }>
  const byFault = new Map(catalog.map((row) => [String(row.id || row.name || ''), row]))

  const runs = []
  for (const item of items) {
    const runId = newRunId()
    item.run_id = runId
    const faultMeta = byFault.get(item.fault)
    const skillName =
      faultMeta?.skillName || faultMeta?.skill_name || item.fault
    const selected = findSubmode(faultMeta?.submodes || [], item.submode)
    const prompt = composeFaultPrompt({
      skillName,
      basePrompt: input.prompt,
      submode: selected,
    })
    const run = await prisma.faultInjectionRun.create({
      data: {
        runId,
        fiTaskId: task.id,
        itemId: item.item_id,
        user: input.user,
        platform: input.platform,
        agent: input.agent,
        fault: item.fault,
        submode: item.submode,
        status: 'queued',
        queuedAt: new Date(),
        requestJson: JSON.stringify({
          prompt,
          workspace: input.workspace,
          model: input.model || null,
          timeoutSeconds: input.timeoutSeconds ?? null,
        }),
      },
    })
    runs.push(run)
  }

  const updatedTask = await prisma.faultInjectionTask.update({
    where: { id: task.id },
    data: { itemsJson: JSON.stringify(items) },
  })

  return { task: updatedTask, runs, items }
}

function looksLikeFiRunId(value: string): boolean {
  return /^ras-\d{8}T[0-9a-zA-Z_-]+$/.test(value.trim())
}

function looksLikeMessageOrPartId(value: string): boolean {
  return /^(msg_|prt_)[0-9a-zA-Z_-]+$/.test(value.trim())
}

/** True when value is a bare platform session usable as FI↔RAS join key. */
export function isPlatformSessionId(value: string | null | undefined): boolean {
  if (!value || !value.trim()) return false
  const s = value.trim()
  if (looksLikeFiRunId(s) || looksLikeMessageOrPartId(s)) return false
  return true
}

/** Write-only: persist collect-result into FaultInjectionRun (not Session tree).

FI ③ must not create or overwrite Session.interactions — main tree is ⓪ only.
Join key is Run.sessionTaskId → existing Session.taskId when Insight already wrote it.
*/
export async function persistFiCollectIngress(input: {
  runId: string
  user: string | null
  payload: CollectPayload
}): Promise<{ sessionAligned: boolean; sessionTaskId: string | null }> {
  const rawTaskId =
    typeof input.payload.taskId === 'string' ? input.payload.taskId.trim() : ''
  const sessionAligned =
    input.payload.sessionAligned !== false && isPlatformSessionId(rawTaskId)
  const sessionTaskId = sessionAligned ? rawTaskId : null

  const updated = await prisma.faultInjectionRun.update({
    where: { runId: input.runId },
    data: {
      status: 'judging',
      error: sessionAligned
        ? null
        : 'session_unaligned: missing platform session id (FI runId is not a RAS join key)',
      sessionTaskId,
      faultActivated: Boolean(input.payload.faultActivated),
      faultActivatedAt: input.payload.faultActivatedAt
        ? new Date(input.payload.faultActivatedAt)
        : null,
      injectionMethod: input.payload.injectionMethod || null,
      markersJson: JSON.stringify(input.payload.markers || []),
    },
  })

  // 实验「生成 Trace」依赖 Case.taskId；collect 对齐后立刻回填（避免评测时空轨迹）。
  if (sessionTaskId) {
    const fiKeys = Array.from(new Set([input.runId, updated.id].filter(Boolean)))
    const execution = await prisma.execution.findFirst({
      where: { taskId: sessionTaskId },
      select: { id: true },
    })
    await prisma.experimentCase.updateMany({
      where: {
        fiRunId: { in: fiKeys },
        OR: [{ taskId: null }, { taskId: '' }],
      },
      data: {
        taskId: sessionTaskId,
        ...(execution ? { executionId: execution.id } : {}),
      },
    })
  }

  return { sessionAligned, sessionTaskId }
}

function parseSessionInteractionsJson(raw: string | null | undefined): unknown[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** ⓪ Session is judge-ready when dialogue has assistant turns or the Trace completed. */
export function isSessionTraceReadyForJudge(
  interactions: unknown[],
  opts?: { endTime?: Date | string | null },
): boolean {
  if (!Array.isArray(interactions) || interactions.length === 0) return false
  if (opts?.endTime) return true
  return interactions.some((row) => {
    if (!row || typeof row !== 'object') return false
    const role = String((row as { role?: string }).role || '').toLowerCase()
    return role === 'assistant' || role === 'opencode' || role === 'subagent'
  })
}

function judgeSessionWaitMs(): number {
  const raw = process.env.FI_JUDGE_SESSION_WAIT_MS
  if (raw === undefined || raw === '') return 120_000
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 120_000
}

function judgeSessionPollMs(): number {
  const raw = process.env.FI_JUDGE_SESSION_POLL_MS
  if (raw === undefined || raw === '') return 1_500
  const n = Number(raw)
  return Number.isFinite(n) && n >= 50 ? n : 1_500
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * When FI is session-aligned, wait for Insight ⓪ to write Session.interactions
 * before Judge runs (collect often finishes before OpenCode upload).
 */
export async function waitForSessionTraceForJudge(sessionTaskId: string): Promise<{
  interactions: unknown[]
  ready: boolean
  waitedMs: number
}> {
  const timeoutMs = judgeSessionWaitMs()
  const pollMs = judgeSessionPollMs()
  const started = Date.now()

  const loadOnce = async () => {
    const session = await prisma.session.findUnique({
      where: { taskId: sessionTaskId },
    })
    const interactions = parseSessionInteractionsJson(session?.interactions)
    return {
      interactions,
      ready: isSessionTraceReadyForJudge(interactions, { endTime: session?.endTime }),
    }
  }

  let loaded = await loadOnce()
  if (loaded.ready || timeoutMs <= 0) {
    return {
      interactions: loaded.interactions,
      ready: loaded.ready,
      waitedMs: Date.now() - started,
    }
  }

  while (Date.now() - started < timeoutMs) {
    await sleep(pollMs)
    loaded = await loadOnce()
    if (loaded.ready) {
      return {
        interactions: loaded.interactions,
        ready: true,
        waitedMs: Date.now() - started,
      }
    }
  }

  return {
    interactions: loaded.interactions,
    ready: false,
    waitedMs: Date.now() - started,
  }
}

/** Load FI Judge / Run inputs from Prisma (never from upload body). */
export async function loadPersistedFiCollectForJudge(runId: string): Promise<{
  fault: string
  submode: string | null
  injectionMethod: string | null
  faultActivated: boolean
  sessionAligned: boolean
  interactions: unknown[]
  markers: unknown[]
  sessionTraceReady: boolean
  sessionWaitMs: number
}> {
  const run = await prisma.faultInjectionRun.findUnique({ where: { runId } })
  if (!run) {
    throw new Error(`FI run not found: ${runId}`)
  }
  let interactions: unknown[] = []
  let sessionTraceReady = true
  let sessionWaitMs = 0
  if (run.sessionTaskId) {
    if (run.faultActivated) {
      const waited = await waitForSessionTraceForJudge(run.sessionTaskId)
      interactions = waited.interactions
      sessionTraceReady = waited.ready
      sessionWaitMs = waited.waitedMs
    } else {
      const session = await prisma.session.findUnique({
        where: { taskId: run.sessionTaskId },
      })
      interactions = parseSessionInteractionsJson(session?.interactions)
      sessionTraceReady = isSessionTraceReadyForJudge(interactions, {
        endTime: session?.endTime,
      })
    }
  }
  let markers: unknown[] = []
  try {
    const parsed = JSON.parse(run.markersJson || '[]')
    markers = Array.isArray(parsed) ? parsed : []
  } catch {
    markers = []
  }
  return {
    fault: run.fault,
    submode: run.submode || null,
    injectionMethod: run.injectionMethod || null,
    faultActivated: Boolean(run.faultActivated),
    sessionAligned: Boolean(run.sessionTaskId),
    interactions,
    markers,
    sessionTraceReady,
    sessionWaitMs,
  }
}

/**
 * Read path: Judge + evaluation markers only from persisted Prisma rows.
 * Used after collect ingress and by rejudge (no upload body).
 */
export async function finishFiJudgeFromDb(input: {
  runId: string
  user: string | null
}) {
  const persisted = await loadPersistedFiCollectForJudge(input.runId)

  // Session-aligned + activated: do not LLM-judge on an empty ⓪ tree.
  if (
    persisted.sessionAligned &&
    persisted.faultActivated &&
    !persisted.sessionTraceReady
  ) {
    const reason =
      `session_trace_not_ready: waited ${persisted.sessionWaitMs}ms for Session.interactions ` +
      `(taskId join); Insight ⓪ upload missing or late`
    const markersJson = JSON.stringify(
      mergeEvaluationMarkers(persisted.markers, {
        skipped: true,
        outcome: 'not_occurred',
        reason,
        model: null,
      }),
    )
    return prisma.faultInjectionRun.update({
      where: { runId: input.runId },
      data: {
        status: 'failed',
        outcome: null,
        faultContainmentStatus: null,
        judgeReason: reason,
        judgeRawJson: JSON.stringify({
          skipped: true,
          sessionAligned: true,
          sessionTraceReady: false,
          sessionWaitMs: persisted.sessionWaitMs,
        }),
        markersJson,
        judgedAt: new Date(),
        error: reason,
      },
    })
  }

  const judged = await judgeFaultInjection({
    user: input.user,
    fault: persisted.fault,
    injectionMethod: persisted.injectionMethod,
    faultActivated: persisted.faultActivated,
    interactions: persisted.interactions,
    submode: persisted.submode,
  })

  const status = judged.skipped ? 'judge_skipped' : 'completed'
  const markersJson = JSON.stringify(
    mergeEvaluationMarkers(persisted.markers, {
      skipped: Boolean(judged.skipped),
      outcome: judged.outcome,
      reason: judged.reason,
      model: judged.model,
    }),
  )

  return prisma.faultInjectionRun.update({
    where: { runId: input.runId },
    data: {
      status,
      outcome: judged.outcome,
      faultContainmentStatus: judged.fault_containment_status,
      judgeReason: judged.reason,
      judgeRawJson: JSON.stringify({
        raw: judged.raw || null,
        model: judged.model || null,
        skipped: judged.skipped,
        sessionAligned: persisted.sessionAligned,
        sessionTraceReady: persisted.sessionTraceReady,
        sessionWaitMs: persisted.sessionWaitMs,
      }),
      markersJson,
      judgedAt: new Date(),
      error: null,
      ...(persisted.sessionAligned
        ? {}
        : {
            error:
              'session_unaligned: missing platform session id (FI runId is not a RAS join key)',
          }),
    },
  })
}

export async function ingestCollectAndJudge(input: {
  runId: string
  user: string | null
  payload: CollectPayload
}) {
  await persistFiCollectIngress(input)
  return finishFiJudgeFromDb({ runId: input.runId, user: input.user })
}

export async function refreshTaskProgress(taskId: string) {
  const task = await prisma.faultInjectionTask.findUnique({ where: { id: taskId } })
  if (!task) return null
  const runs = await prisma.faultInjectionRun.findMany({ where: { fiTaskId: taskId } })
  type RunRow = (typeof runs)[number]
  const items = JSON.parse(task.itemsJson || '[]') as Array<Record<string, unknown>>
  for (const item of items) {
    const run = runs.find((r: RunRow) => r.runId === item.run_id)
    if (!run) continue
    item.status = run.status
    item.phase = run.status
    item.error = run.error
    item.result = run.outcome
      ? {
          outcome: run.outcome,
          fault_containment_status: run.faultContainmentStatus,
          reason: run.judgeReason,
        }
      : null
  }
  const progress = {
    total: runs.length,
    queued: runs.filter((r: RunRow) => r.status === 'queued').length,
    running: runs.filter((r: RunRow) => ['collecting', 'judging'].includes(r.status)).length,
    completed: runs.filter((r: RunRow) => r.status === 'completed').length,
    judge_skipped: runs.filter((r: RunRow) => r.status === 'judge_skipped').length,
    failed: runs.filter((r: RunRow) => r.status === 'failed').length,
    stopped: runs.filter((r: RunRow) => r.status === 'stopped').length,
  }
  const finished =
    progress.completed +
    progress.judge_skipped +
    progress.failed +
    progress.stopped
  let status = task.status
  if (progress.running > 0) {
    status = 'running'
  } else if (progress.queued === progress.total && progress.total > 0) {
    status = 'queued'
  } else if (progress.stopped && progress.stopped + progress.failed === progress.total) {
    status = 'stopped'
  } else if (progress.failed && finished === progress.total) status = 'failed'
  else if (finished === progress.total && progress.total > 0) {
    status = 'completed'
  } else if (progress.queued > 0) {
    status = 'queued'
  } else status = 'running'

  return prisma.faultInjectionTask.update({
    where: { id: taskId },
    data: {
      itemsJson: JSON.stringify(items),
      progressJson: JSON.stringify(progress),
      status,
      startedAt:
        status === 'running' && !task.startedAt ? new Date() : task.startedAt,
      finishedAt: status === 'running' || status === 'queued' ? null : new Date(),
    },
  })
}
