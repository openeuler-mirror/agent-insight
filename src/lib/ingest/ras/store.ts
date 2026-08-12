import { prismaRaw } from "@/lib/storage/prisma"
import type { RasIngestRecord } from "@/lib/ingest/ras/normalize"
import { resolveTracePlatform } from "@/lib/ingest/ras/platform-label"
import { pickReliabilityTraceSummary } from "@/lib/ingest/ras/trace-summary"

type RasEventForDedupe = {
  id: string
  taskId: string
  type: string
  deliveryId: string
  anomalyKind: string | null
  severity: string | null
  summary: string | null
  actionTypes: string | null
  payloadJson: string
  ts: Date
}

export type RecoveryOutcome = "none" | "success" | "failed" | "unknown"

export type RasTaskSummary = {
  count: number
  kinds: string[]
  maxSeverity: string | null
  summaries: string[]
  latestTs: string | null
  detectionLevel: "L1" | "L2" | "L3" | null
  actionTypes: string[]
  hasFault: boolean
  recoveryStarted: boolean
  recoveryOutcome: RecoveryOutcome
  abortedStream: boolean
}

export type ReliabilityTraceItem = {
  taskId: string
  executionId: string
  latestTs: string
  completedAt: string | null
  anomalyKind: string
  detectionLevel: "L1" | "L2" | "L3" | null
  severity: string | null
  summary: string | null
  eventCount: number
  traceStatus: "running" | "success" | "failed"
  traceStatusReason: string
  hasFault: boolean
  recoveryStarted: boolean
  recoveryOutcome: RecoveryOutcome
  abortedStream: boolean
  /** Prefer RasAnomalyEvent.platform, else Execution.framework. */
  platform: string | null
  framework: string | null
  agentName: string | null
}

export function dedupeRasEvents<T extends RasEventForDedupe>(rows: T[]): T[] {
  const seenIds = new Set<string>()
  const out: T[] = []

  for (const row of rows) {
    const key = `${row.taskId}\u001f${row.deliveryId}`
    if (seenIds.has(key)) continue
    seenIds.add(key)
    out.push(row)
  }

  return out
}

function detectionLevelFromPayload(payloadJson: string): "L1" | "L2" | "L3" | null {
  try {
    const payload = JSON.parse(payloadJson)
    const mode = String(payload?.evidence?.mode || "")
    if (mode === "suffix_cycle") return "L1"
    if (mode === "similar_clauses") return "L2"
    if (mode === "plan_execution_loop_lock") return "L3"
  } catch {
    return null
  }
  return null
}

export async function findRootExecutionId(taskId: string): Promise<string | null> {
  const row = await prismaRaw.execution.findFirst({
    where: { taskId, isSubagent: false },
    orderBy: { timestamp: "desc" },
    select: { id: true },
  })
  return row?.id ?? null
}

export async function upsertRasIngestRecords(
  records: RasIngestRecord[],
  user: string | null,
): Promise<{ written: number; ids: string[] }> {
  const ids: string[] = []
  let written = 0

  for (const rec of records) {
    const executionId = await findRootExecutionId(rec.taskId)
    const data = {
      deliveryId: rec.deliveryId,
      type: rec.type,
      taskId: rec.taskId,
      rasSessionKey: rec.rasSessionKey,
      platform: rec.framework,
      framework: rec.framework,
      anomalyKind: rec.anomalyKind,
      severity: rec.severity,
      summary: rec.summary,
      actionTypes: rec.actionTypes,
      payloadJson: rec.payloadJson,
      executionId,
      ts: rec.ts,
      user,
    }

    const row = await prismaRaw.rasAnomalyEvent.upsert({
      where: {
        taskId_deliveryId: {
          taskId: rec.taskId,
          deliveryId: rec.deliveryId,
        },
      },
      create: data,
      update: data,
    })
    ids.push(row.id)
    written += 1
  }

  return { written, ids }
}

export async function listRasEventsByTaskIds(opts: {
  taskIds: string[]
  user?: string | null
  types?: string[]
  limit?: number
}) {
  const taskIds = opts.taskIds.filter(Boolean)
  if (!taskIds.length) return []

  const rows = await prismaRaw.rasAnomalyEvent.findMany({
    where: {
      taskId: { in: taskIds },
      ...(opts.user ? { user: opts.user } : {}),
      ...(opts.types?.length ? { type: { in: opts.types } } : {}),
    },
    orderBy: { ts: "desc" },
    take: opts.limit ?? 500,
  })
  return dedupeRasEvents(rows)
}

type RasEventForSummary = {
  taskId: string
  type: string
  anomalyKind: string | null
  severity: string | null
  summary: string | null
  actionTypes: string | null
  payloadJson: string
  ts: Date | string
}

function parseActionResultOk(payloadJson: string): boolean | null {
  try {
    const payload = JSON.parse(payloadJson)
    if (typeof payload?.ok === "boolean") return payload.ok
    return null
  } catch {
    return null
  }
}

function emptyRasTaskSummary(): RasTaskSummary & { actionResultSeen: boolean; actionResultFailed: boolean } {
  return {
    count: 0,
    kinds: [],
    maxSeverity: null,
    summaries: [],
    latestTs: null,
    detectionLevel: null,
    actionTypes: [],
    hasFault: false,
    recoveryStarted: false,
    recoveryOutcome: "none",
    abortedStream: false,
    actionResultSeen: false,
    actionResultFailed: false,
  }
}

/** Pure aggregator for unit tests and summarizeRasByTaskIds. */
export function buildRasTaskSummaries(rows: RasEventForSummary[]): Record<string, RasTaskSummary> {
  const map = new Map<string, ReturnType<typeof emptyRasTaskSummary>>()
  const sevRank: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 }

  for (const row of rows) {
    const cur = map.get(row.taskId) || emptyRasTaskSummary()
    cur.count += 1
    if (row.type === "anomaly") {
      cur.hasFault = true
      if (row.anomalyKind && !cur.kinds.includes(row.anomalyKind)) cur.kinds.push(row.anomalyKind)
      if (row.summary && cur.summaries.length < 3) cur.summaries.push(row.summary)
      const level = detectionLevelFromPayload(row.payloadJson)
      if (level && (!cur.detectionLevel || level > cur.detectionLevel)) {
        cur.detectionLevel = level
      }
      const prev = cur.maxSeverity ? sevRank[cur.maxSeverity] || 0 : 0
      const next = row.severity ? sevRank[row.severity] || 0 : 0
      if (next >= prev) cur.maxSeverity = row.severity
    }
    if (row.type === "actions") {
      cur.recoveryStarted = true
    }
    for (const action of String(row.actionTypes || "").split(",").map(item => item.trim()).filter(Boolean)) {
      if (!cur.actionTypes.includes(action)) cur.actionTypes.push(action)
      cur.recoveryStarted = true
    }
    if (row.type === "action_result") {
      cur.actionResultSeen = true
      const ok = parseActionResultOk(row.payloadJson)
      if (ok === false) cur.actionResultFailed = true
    }
    const ts = row.ts instanceof Date ? row.ts.toISOString() : String(row.ts)
    if (!cur.latestTs || ts > cur.latestTs) cur.latestTs = ts
    map.set(row.taskId, cur)
  }

  const out: Record<string, RasTaskSummary> = {}
  for (const [taskId, cur] of map.entries()) {
    const abortedStream = cur.actionTypes.includes("abort_stream")
    let recoveryOutcome: RecoveryOutcome = "none"
    if (cur.recoveryStarted) {
      if (!cur.actionResultSeen) recoveryOutcome = "unknown"
      else if (cur.actionResultFailed) recoveryOutcome = "failed"
      else recoveryOutcome = "success"
    }
    out[taskId] = {
      count: cur.count,
      kinds: cur.kinds,
      maxSeverity: cur.maxSeverity,
      summaries: cur.summaries,
      latestTs: cur.latestTs,
      detectionLevel: cur.detectionLevel,
      actionTypes: cur.actionTypes,
      hasFault: cur.hasFault,
      recoveryStarted: cur.recoveryStarted,
      recoveryOutcome,
      abortedStream,
    }
  }
  return out
}

export async function summarizeRasByTaskIds(opts: {
  taskIds: string[]
  user?: string | null
}): Promise<Record<string, RasTaskSummary>> {
  const rows = await listRasEventsByTaskIds({
    taskIds: opts.taskIds,
    user: opts.user,
    limit: 2000,
  })
  return buildRasTaskSummaries(rows)
}

/**
 * Align with observe `/api/observe/data` getTraceLifecycle:
 * only Session completion signal — not failures, finalResult, RAS, or FI judge.
 */
export function deriveTraceLifecycle(opts: {
  completedAt: string | null
}): { traceStatus: "running" | "success" | "failed"; traceStatusReason: string } {
  if (!opts.completedAt) {
    return { traceStatus: "running", traceStatusReason: "missing-completion-signal" }
  }
  return { traceStatus: "success", traceStatusReason: "session-ended" }
}

export async function listReliabilityTraces(opts: {
  user: string
  limit?: number
}): Promise<ReliabilityTraceItem[]> {
  const limit = opts.limit ?? 200

  const [executions, rasMetaRows] = await Promise.all([
    prismaRaw.execution.findMany({
      where: {
        user: opts.user,
        isSubagent: false,
        taskId: { not: null },
      },
      orderBy: { timestamp: "desc" },
      take: limit,
      select: {
        id: true,
        taskId: true,
        timestamp: true,
        framework: true,
        agentName: true,
        query: true,
      },
    }),
    prismaRaw.rasAnomalyEvent.findMany({
      where: { user: opts.user },
      orderBy: { ts: "desc" },
      take: Math.max(limit * 10, 500),
      select: {
        taskId: true,
        platform: true,
        framework: true,
        ts: true,
      },
    }),
  ])

  const platformByTaskId = new Map<string, string>()
  for (const row of rasMetaRows) {
    if (!platformByTaskId.has(row.taskId)) {
      const platform = resolveTracePlatform({
        eventPlatform: row.platform,
        eventFramework: row.framework,
      })
      if (platform) platformByTaskId.set(row.taskId, platform)
    }
  }

  const execByTaskId = new Map<string, (typeof executions)[number]>()
  for (const execution of executions) {
    if (!execution.taskId || execByTaskId.has(execution.taskId)) continue
    execByTaskId.set(execution.taskId, execution)
  }

  // List only tasks with an Execution — no ras-events-only fallback rows.
  const taskIds = [...execByTaskId.keys()]
  if (!taskIds.length) return []

  const [sessions, summaries] = await Promise.all([
    prismaRaw.session.findMany({
      where: { taskId: { in: taskIds } },
      select: { taskId: true, endTime: true, label: true },
    }),
    summarizeRasByTaskIds({ taskIds, user: opts.user }),
  ])
  const sessionByTaskId = new Map(sessions.map(session => [session.taskId, session]))

  const items: ReliabilityTraceItem[] = []

  for (const [taskId, execution] of execByTaskId.entries()) {
    const anomaly = summaries[taskId]
    const session = sessionByTaskId.get(taskId)
    const completedAt = session?.endTime?.toISOString() || null
    const { traceStatus, traceStatusReason } = deriveTraceLifecycle({ completedAt })
    const platform = resolveTracePlatform({
      eventPlatform: platformByTaskId.get(taskId),
      executionFramework: execution.framework,
    })

    items.push({
      taskId,
      executionId: execution.id,
      latestTs: anomaly?.latestTs || execution.timestamp.toISOString(),
      completedAt,
      anomalyKind: anomaly?.kinds[0] || "",
      detectionLevel: anomaly?.detectionLevel || null,
      severity: anomaly?.maxSeverity || null,
      summary: pickReliabilityTraceSummary({
        anomalySummary: anomaly?.summaries[0],
        executionQuery: execution.query,
        sessionLabel: session?.label,
      }),
      eventCount: anomaly?.count || 0,
      traceStatus,
      traceStatusReason,
      hasFault: anomaly?.hasFault ?? false,
      recoveryStarted: anomaly?.recoveryStarted ?? false,
      recoveryOutcome: anomaly?.recoveryOutcome ?? "none",
      abortedStream: anomaly?.abortedStream ?? false,
      platform,
      framework: execution.framework,
      agentName: execution.agentName,
    })
  }

  items.sort((a, b) => String(b.latestTs).localeCompare(String(a.latestTs)))
  return items.slice(0, limit)
}

export async function listAllTasksWithRasEvents(opts: {
  user?: string | null
  limit?: number
}): Promise<string[]> {
  const rows = await prismaRaw.rasAnomalyEvent.findMany({
    where: {
      type: "anomaly",
      ...(opts.user ? { user: opts.user } : {}),
    },
    orderBy: { ts: "desc" },
    select: { taskId: true, ts: true },
    take: opts.limit ?? 500,
  })
  const seen = new Set<string>()
  const taskIds: string[] = []
  for (const r of rows) {
    if (!seen.has(r.taskId)) {
      seen.add(r.taskId)
      taskIds.push(r.taskId)
    }
  }
  return taskIds
}

/** Delete reliability traces owned by `user` (Execution + Session + RAS events). */
export async function deleteReliabilityTraces(opts: {
  taskIds: string[]
  user: string
}): Promise<{
  taskIds: string[]
  deleted: { ras: number; executions: number; sessions: number }
}> {
  const requested = [...new Set(opts.taskIds.map(id => String(id || "").trim()).filter(Boolean))]
  if (!requested.length || !opts.user) {
    return { taskIds: [], deleted: { ras: 0, executions: 0, sessions: 0 } }
  }

  const ownedExec = await prismaRaw.execution.findMany({
    where: {
      taskId: { in: requested },
      user: opts.user,
      isSubagent: false,
    },
    select: { taskId: true },
  })
  const ownedRas = await prismaRaw.rasAnomalyEvent.findMany({
    where: {
      taskId: { in: requested },
      OR: [{ user: opts.user }, { user: null }],
    },
    select: { taskId: true },
    distinct: ["taskId"],
  })
  const ownedTaskIds = [...new Set([
    ...ownedExec.map(row => row.taskId).filter((taskId): taskId is string => Boolean(taskId)),
    ...ownedRas.map(row => row.taskId).filter(Boolean),
  ])]
  if (!ownedTaskIds.length) {
    return { taskIds: [], deleted: { ras: 0, executions: 0, sessions: 0 } }
  }

  const [ras, executions, sessions] = await Promise.all([
    prismaRaw.rasAnomalyEvent.deleteMany({
      where: {
        taskId: { in: ownedTaskIds },
        OR: [{ user: opts.user }, { user: null }],
      },
    }),
    prismaRaw.execution.deleteMany({
      where: { taskId: { in: ownedTaskIds }, user: opts.user },
    }),
    prismaRaw.session.deleteMany({
      where: {
        taskId: { in: ownedTaskIds },
        OR: [{ user: opts.user }, { user: null }],
      },
    }),
  ])

  return {
    taskIds: ownedTaskIds,
    deleted: {
      ras: ras.count,
      executions: executions.count,
      sessions: sessions.count,
    },
  }
}
