import { NextResponse } from 'next/server'
import { resolveUser } from '@/lib/auth/auth'
import { listClientsWithWorkerSync } from '@/lib/reliability/clients-from-workers'

export const dynamic = 'force-dynamic'

/** IF-N09 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const { username } = await resolveUser(req, url.searchParams.get('user'))
    if (!username) {
      return NextResponse.json({ error: 'user is required' }, { status: 401 })
    }
    const payload = await listClientsWithWorkerSync(username, {
      page: Number(url.searchParams.get('page') || 1),
      pageSize: Number(url.searchParams.get('pageSize') || 20),
      status: url.searchParams.get('status') || undefined,
      keyword: url.searchParams.get('keyword') || undefined,
    })
    return NextResponse.json({
      items: payload.items.map((item) => ({
        id: item.id,
        name: item.name,
        hostname: item.hostname,
        reportedIp: item.reportedIp,
        observedIp: item.observedIp,
        os: item.os,
        arch: item.arch,
        status: item.status,
        serviceHealth: item.serviceHealth,
        processStartedAt: item.processStartedAt,
        restartCount: item.restartCount,
        lastSeenAt: item.lastSeenAt,
        platforms: item.platforms,
        agentVersion: item.agentVersion,
      })),
      page: payload.page,
      pageSize: payload.pageSize,
      total: payload.total,
    })
  } catch (error) {
    console.error('[reliability/clients GET]', error)
    return NextResponse.json({ error: 'Failed to list clients' }, { status: 500 })
  }
}
