/**
 * 兼容期：把仍在用 API Key 的存量 FI Worker 以只读方式列进客户端列表。
 *
 * 与旧的 clients-from-workers.ts 的关键区别：这里**不再伪造 ReliabilityClient 记录**，
 * 只在列表响应里追加只读行。这些行没有设备凭证，因此不能接收控制指令、不能配置下发；
 * 页面据 legacy=true 提示用户重装为正式客户端。
 */
import { prisma } from '@/lib/storage/prisma'
import { workerOnlineMs } from '@/lib/fault-injection/worker-protocol'
import { isLoopbackIp, pickDisplayClientIp } from '@/lib/reliability/client-ip'
import type { ClientPlatformCapability } from '@/lib/reliability/client-registry'

/** prisma 在 DB_HOST 模式下是 any，查询结果需显式标注。 */
type LegacyWorkerRow = {
  workerId: string
  hostname: string | null
  version: string | null
  lastSeenAt: Date
  inventoryJson: string | null
}

export type LegacyWorkerClient = {
  id: string
  /** 原始 workerId —— 调用方据此与已注册 clientId 去重。 */
  workerId: string
  name: string
  hostname: string | null
  reportedIp: string | null
  observedIp: string | null
  os: string | null
  arch: string | null
  status: 'online' | 'offline'
  serviceHealth: 'unknown'
  supervisor: null
  processStartedAt: null
  restartCount: number
  lastSeenAt: string
  agentVersion: string | null
  platforms: ClientPlatformCapability[]
  faultInjection: { ready: boolean }
  controlChannel: 'none'
  legacy: true
}

function platformsFromInventory(inventoryJson: string | null | undefined): ClientPlatformCapability[] {
  try {
    const inv = JSON.parse(inventoryJson || '{}') as {
      platforms?: Record<string, { version?: string; models?: unknown[] }>
    }
    return Object.entries(inv.platforms || {}).map(([id, info]) => ({
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

export async function listLegacyWorkerClients(
  user: string,
  opts?: { status?: string; keyword?: string },
): Promise<LegacyWorkerClient[]> {
  const cutoff = new Date(Date.now() - workerOnlineMs())
  const workers = await prisma.faultInjectionWorker.findMany({
    where: { user },
    orderBy: { lastSeenAt: 'desc' },
  })

  let items = (workers as LegacyWorkerRow[]).map((worker): LegacyWorkerClient => {
    const platforms = platformsFromInventory(worker.inventoryJson)
    const { reportedIp, observedIp } = ipsFromInventory(worker.inventoryJson)
    const hostnameIp = worker.hostname?.match(/\d+\.\d+\.\d+\.\d+/)?.[0] ?? null
    const display = pickDisplayClientIp({
      reportedIp: reportedIp || (hostnameIp && !isLoopbackIp(hostnameIp) ? hostnameIp : null),
      observedIp,
    })
    return {
      id: `legacy_worker_${worker.workerId}`,
      workerId: worker.workerId,
      name: display ? `主机-${display}` : worker.hostname || worker.workerId,
      hostname: worker.hostname,
      reportedIp: display,
      observedIp,
      os: null,
      arch: null,
      status: worker.lastSeenAt >= cutoff ? 'online' : 'offline',
      serviceHealth: 'unknown',
      supervisor: null,
      processStartedAt: null,
      restartCount: 0,
      lastSeenAt: worker.lastSeenAt.toISOString(),
      agentVersion: worker.version,
      platforms: platforms.length ? platforms : [{ id: 'opencode', models: [] }],
      faultInjection: { ready: true },
      controlChannel: 'none',
      legacy: true,
    }
  })

  const status = String(opts?.status || '').trim()
  if (status === 'online' || status === 'offline') {
    items = items.filter((item: LegacyWorkerClient) => item.status === status)
  }
  const keyword = String(opts?.keyword || '').trim().toLowerCase()
  if (keyword) {
    items = items.filter((item: LegacyWorkerClient) =>
      [item.reportedIp, item.hostname, item.name, item.id]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(keyword),
    )
  }
  return items
}
