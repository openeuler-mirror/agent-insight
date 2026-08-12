import { prisma } from '@/lib/storage/prisma'
import { workerOnlineMs } from '@/lib/fault-injection/worker-protocol'
import {
  listReliabilityClientsForUser,
  upsertReliabilityClientFromWorker,
  type ReliabilityClientPlatform,
} from '@/lib/reliability/client-config-service'
import { isLoopbackIp, pickDisplayClientIp } from '@/lib/reliability/client-ip'

function platformsFromInventory(inventoryJson: string | null | undefined): ReliabilityClientPlatform[] {
  try {
    const inv = JSON.parse(inventoryJson || '{}') as {
      platforms?: Record<string, { version?: string; models?: unknown[] }>
      reportedIp?: string
      ip?: string
    }
    const platforms = inv.platforms || {}
    return Object.entries(platforms).map(([id, info]) => ({
      id,
      version: info?.version ? String(info.version) : undefined,
      models: Array.isArray(info?.models)
        ? info.models
            .map((m) => {
              if (typeof m === 'string') return m.trim()
              if (m && typeof m === 'object') {
                const rec = m as { id?: unknown; name?: unknown; label?: unknown }
                return String(rec.id || rec.name || rec.label || '').trim()
              }
              return ''
            })
            .filter(Boolean)
        : [],
    }))
  } catch {
    return []
  }
}

function ipsFromInventory(inventoryJson: string | null | undefined): {
  reportedIp: string | null
  observedIp: string | null
} {
  try {
    const inv = JSON.parse(inventoryJson || '{}') as {
      reportedIp?: string
      ip?: string
      observedIp?: string
    }
    return {
      reportedIp: (inv.reportedIp || inv.ip || null) as string | null,
      observedIp: (inv.observedIp || null) as string | null,
    }
  } catch {
    return { reportedIp: null, observedIp: null }
  }
}

/** Mirror FI workers into ReliabilityClient list (IF-N09 source for this milestone). */
export async function syncReliabilityClientsFromWorkers(user: string): Promise<void> {
  const cutoff = new Date(Date.now() - workerOnlineMs())
  const workers = await prisma.faultInjectionWorker.findMany({
    where: { user },
    orderBy: { lastSeenAt: 'desc' },
  })
  for (const worker of workers) {
    const platforms = platformsFromInventory(worker.inventoryJson)
    const { reportedIp, observedIp } = ipsFromInventory(worker.inventoryJson)
    const hostnameIp = worker.hostname?.match(/\d+\.\d+\.\d+\.\d+/)?.[0] ?? null
    const display = pickDisplayClientIp({
      reportedIp: reportedIp || (hostnameIp && !isLoopbackIp(hostnameIp) ? hostnameIp : null),
      observedIp,
    })
    upsertReliabilityClientFromWorker({
      user,
      workerId: worker.workerId,
      hostname: worker.hostname,
      reportedIp: display,
      observedIp,
      lastSeenAt: worker.lastSeenAt.toISOString(),
      platforms: platforms.length ? platforms : [{ id: 'opencode', models: [] }],
      online: worker.lastSeenAt >= cutoff,
      agentVersion: worker.version,
    })
  }
}

export async function listClientsWithWorkerSync(
  user: string,
  opts?: { page?: number; pageSize?: number; status?: string; keyword?: string },
) {
  await syncReliabilityClientsFromWorkers(user)
  return listReliabilityClientsForUser(user, opts)
}
