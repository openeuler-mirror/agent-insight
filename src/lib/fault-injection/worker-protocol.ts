import { prisma } from '@/lib/storage/prisma'
import { refreshTaskProgress } from '@/lib/fault-injection/store'

export function claimTimeoutMs(): number {
  const sec = Number(process.env.AGENT_INSIGHT_FI_CLAIM_TIMEOUT_SEC || 300)
  return Math.max(60, Number.isFinite(sec) ? sec : 300) * 1000
}

export function workerOnlineMs(): number {
  // Consider offline after 3x default poll or claim timeout, whichever smaller bound
  return Math.min(claimTimeoutMs(), 60_000)
}

/** Requeue or stop stale collecting leases. Call at heartbeat/claim entry. */
export async function sweepStaleClaims(user: string | null) {
  const cutoff = new Date(Date.now() - claimTimeoutMs())
  const whereUser = user ? { user } : {}
  const stale = await prisma.faultInjectionRun.findMany({
    where: {
      ...whereUser,
      status: 'collecting',
      OR: [{ claimedAt: { lt: cutoff } }, { claimedAt: null }],
    },
    take: 50,
  })
  const touchedTasks = new Set<string>()
  for (const run of stale) {
    if (run.workerId) {
      const worker = await prisma.faultInjectionWorker.findUnique({
        where: { workerId: run.workerId },
      })
      if (worker && worker.lastSeenAt >= cutoff) {
        // Worker still heartbeating; only reclaim if claimedAt itself is ancient
        if (run.claimedAt && run.claimedAt >= cutoff) continue
      }
    }
    if (run.stopRequested) {
      await prisma.faultInjectionRun.update({
        where: { id: run.id },
        data: {
          status: 'stopped',
          error: run.error || 'stopped by user',
          workerId: null,
          claimedAt: null,
        },
      })
    } else {
      await prisma.faultInjectionRun.update({
        where: { id: run.id },
        data: {
          status: 'queued',
          workerId: null,
          claimedAt: null,
          error: 'claim timeout; requeued',
        },
      })
    }
    if (run.fiTaskId) touchedTasks.add(run.fiTaskId)
  }
  for (const taskId of touchedTasks) {
    await refreshTaskProgress(taskId).catch(() => undefined)
  }
  return stale.length
}

export type ClaimedRunPayload = {
  runId: string
  taskKey: string | null
  platform: string
  agent: string
  fault: string
  submode: string | null
  prompt: string
  model: string | null
  workspaceLogical: string
  timeoutSeconds: number | null
  stopRequested: boolean
}

export async function claimQueuedRuns(input: {
  user: string
  workerId: string
  limit: number
}): Promise<ClaimedRunPayload[]> {
  const limit = Math.max(1, Math.min(input.limit, 8))
  const claimed: ClaimedRunPayload[] = []

  for (let i = 0; i < limit; i += 1) {
    const next = await prisma.faultInjectionRun.findFirst({
      where: {
        user: input.user,
        status: 'queued',
        stopRequested: false,
      },
      orderBy: { queuedAt: 'asc' },
    })
    if (!next) break

    const result = await prisma.faultInjectionRun.updateMany({
      where: { id: next.id, status: 'queued', stopRequested: false },
      data: {
        status: 'collecting',
        workerId: input.workerId,
        claimedAt: new Date(),
        error: null,
      },
    })
    if (result.count !== 1) continue

    const run = await prisma.faultInjectionRun.findUnique({ where: { id: next.id } })
    if (!run) continue
    const task = run.fiTaskId
      ? await prisma.faultInjectionTask.findUnique({ where: { id: run.fiTaskId } })
      : null
    const req = JSON.parse(run.requestJson || '{}') as {
      prompt?: string
      workspace?: string
      model?: string | null
      timeoutSeconds?: number | null
    }
    claimed.push({
      runId: run.runId,
      taskKey: task?.taskKey || null,
      platform: run.platform,
      agent: run.agent,
      fault: run.fault,
      submode: run.submode,
      prompt: req.prompt || task?.prompt || '',
      model: req.model ?? task?.model ?? null,
      workspaceLogical: req.workspace || task?.workspace || '__default__',
      timeoutSeconds:
        typeof req.timeoutSeconds === 'number'
          ? req.timeoutSeconds
          : parseTimeoutFromTask(task?.requestJson),
      stopRequested: run.stopRequested,
    })
    if (run.fiTaskId) await refreshTaskProgress(run.fiTaskId).catch(() => undefined)
  }

  // Mark queued+stopRequested as stopped without claiming
  const stoppedQueued = await prisma.faultInjectionRun.findMany({
    where: { user: input.user, status: 'queued', stopRequested: true },
    take: 20,
  })
  for (const run of stoppedQueued) {
    await prisma.faultInjectionRun.update({
      where: { id: run.id },
      data: { status: 'stopped', error: 'stopped by user' },
    })
    if (run.fiTaskId) await refreshTaskProgress(run.fiTaskId).catch(() => undefined)
  }

  return claimed
}

function parseTimeoutFromTask(requestJson?: string | null): number | null {
  if (!requestJson) return null
  try {
    const parsed = JSON.parse(requestJson) as { timeoutSeconds?: number }
    return typeof parsed.timeoutSeconds === 'number' ? parsed.timeoutSeconds : null
  } catch {
    return null
  }
}

export async function upsertWorkerHeartbeat(input: {
  user: string
  workerId: string
  hostname?: string | null
  version?: string | null
  inventory?: unknown
  busySlots?: number
}) {
  const inventoryJson = JSON.stringify(input.inventory ?? {})
  return prisma.faultInjectionWorker.upsert({
    where: { workerId: input.workerId },
    create: {
      workerId: input.workerId,
      user: input.user,
      hostname: input.hostname || null,
      version: input.version || null,
      lastSeenAt: new Date(),
      inventoryJson,
      busySlots: input.busySlots ?? 0,
    },
    update: {
      user: input.user,
      hostname: input.hostname || null,
      version: input.version || null,
      lastSeenAt: new Date(),
      inventoryJson,
      busySlots: input.busySlots ?? 0,
    },
  })
}

export async function listStopCommandsForWorker(user: string, workerId: string) {
  const runs = await prisma.faultInjectionRun.findMany({
    where: {
      user,
      workerId,
      status: 'collecting',
      stopRequested: true,
    },
    select: { runId: true },
  })
  return runs.map((r) => ({ type: 'stop' as const, runId: r.runId }))
}

export async function getLatestWorkerInventory(user: string | null, platform: string) {
  if (!user) return null
  const cutoff = new Date(Date.now() - workerOnlineMs())
  const worker = await prisma.faultInjectionWorker.findFirst({
    where: { user, lastSeenAt: { gte: cutoff } },
    orderBy: { lastSeenAt: 'desc' },
  })
  if (!worker) return null
  try {
    const inv = JSON.parse(worker.inventoryJson || '{}') as {
      platforms?: Record<
        string,
        { agents?: unknown[]; models?: unknown[]; ready?: boolean; executable?: string | null }
      >
    }
    return {
      workerId: worker.workerId,
      lastSeenAt: worker.lastSeenAt,
      platformInventory: inv.platforms?.[platform] || null,
      inventory: inv,
    }
  } catch {
    return { workerId: worker.workerId, lastSeenAt: worker.lastSeenAt, platformInventory: null, inventory: {} }
  }
}

export type WorkerPlatformInfo = {
  id: string
  label: string
  executable: string | null
  readiness: 'ready' | 'not_ready'
  preflight_errors: string[]
}

export type OnlineWorkerSummary = {
  workerId: string
  hostname: string | null
  lastSeenAt: string
  version: string | null
}

/** Platform readiness from online FI Worker inventory (not server PATH). */
export async function listPlatformsFromWorkers(user: string | null): Promise<{
  platforms: WorkerPlatformInfo[]
  workers: OnlineWorkerSummary[]
  ok: boolean
}> {
  const cutoff = new Date(Date.now() - workerOnlineMs())
  const workers = user
    ? await prisma.faultInjectionWorker.findMany({
        where: { user, lastSeenAt: { gte: cutoff } },
        orderBy: { lastSeenAt: 'desc' },
        take: 5,
      })
    : []

  const platforms = (['opencode', 'xiaoo'] as const).map((id) => {
    let ready = false
    let executable: string | null = null
    let errors: string[] = []
    for (const w of workers) {
      try {
        const inv = JSON.parse(w.inventoryJson || '{}') as {
          platforms?: Record<string, { ready?: boolean; executable?: string | null }>
        }
        const p = inv.platforms?.[id]
        if (p?.ready) {
          ready = true
          executable = p.executable || id
          errors = []
          break
        }
        if (p && !p.ready) {
          errors = [`${id} not ready on worker ${w.workerId}`]
        }
      } catch {
        /* ignore */
      }
    }
    if (!workers.length) {
      errors = ['No online FI Worker; run: npx agent-insight install-fault-injection --start']
    }
    return {
      id,
      label: id === 'xiaoo' ? 'xiaoO' : 'OpenCode',
      executable,
      readiness: ready ? ('ready' as const) : ('not_ready' as const),
      preflight_errors: errors,
    }
  })

  return {
    platforms,
    workers: workers.map((w) => ({
      workerId: w.workerId,
      hostname: w.hostname,
      lastSeenAt: w.lastSeenAt.toISOString(),
      version: w.version,
    })),
    ok: workers.length > 0,
  }
}
