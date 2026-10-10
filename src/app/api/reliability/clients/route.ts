import { NextResponse } from 'next/server'

import { resolveUser } from '@/lib/auth/auth'
import { reliabilityErrorResponse } from '@/lib/reliability/api-error'
import { listClients } from '@/lib/reliability/client-registry'
import { listLegacyWorkerClients } from '@/lib/reliability/legacy-worker-clients'
import { isConnected } from '@/lib/reliability/control-hub'
import { sweepUnackedCommands } from '@/lib/reliability/command-bus'

export const dynamic = 'force-dynamic'

/** IF-N09 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const { username } = await resolveUser(req, url.searchParams.get('user'))
    if (!username) {
      return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'user is required' } }, { status: 401 })
    }
    await sweepUnackedCommands(username)

    const page = Number(url.searchParams.get('page') || 1)
    const pageSize = Number(url.searchParams.get('pageSize') || 20)
    const status = url.searchParams.get('status') || undefined
    const keyword = url.searchParams.get('keyword') || undefined

    const registered = await listClients(username, { page: 1, pageSize: 1000, status, keyword })
    // 兼容期：仍在用 API Key 的存量 FI Worker 也要可见，标记 legacy。
    const legacyAll = await listLegacyWorkerClients(username, { status, keyword })

    // 常驻客户端用 clientId 作为 workerId 上报 FI 心跳，那一行不是「存量 Worker」，
    // 而是同一台机器 —— 不去重会让同一主机在列表里出现两次。
    const registeredIds = new Set(registered.items.map((item) => item.id))
    const legacy = legacyAll.filter((item) => !registeredIds.has(item.workerId))

    const items = [
      ...registered.items.map((item) => ({
        ...item,
        controlChannel: isConnected(item.id) ? 'wss' : 'none',
        legacy: false,
      })),
      ...legacy,
    ].sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))

    const total = items.length
    const start = (Math.max(1, page) - 1) * Math.min(100, Math.max(1, pageSize))
    return NextResponse.json({
      items: items.slice(start, start + Math.min(100, Math.max(1, pageSize))),
      page: Math.max(1, page),
      pageSize: Math.min(100, Math.max(1, pageSize)),
      total,
    })
  } catch (error) {
    return reliabilityErrorResponse(error, 'reliability/clients GET')
  }
}
