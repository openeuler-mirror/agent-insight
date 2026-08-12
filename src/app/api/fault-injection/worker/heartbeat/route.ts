import { NextResponse } from 'next/server'
import { resolveUser } from '@/lib/auth/auth'
import {
  sweepStaleClaims,
  upsertWorkerHeartbeat,
} from '@/lib/fault-injection/worker-protocol'
import { clientIpFromRequest } from '@/lib/reliability/client-ip'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const { username } = await resolveUser(req)
    if (!username) {
      return NextResponse.json({ error: 'API key required' }, { status: 401 })
    }
    const body = await req.json()
    if (!body.workerId || typeof body.workerId !== 'string') {
      return NextResponse.json({ error: 'workerId required' }, { status: 400 })
    }
    await sweepStaleClaims(username)
    const observedIp = clientIpFromRequest(req)
    const baseInventory =
      body.inventory && typeof body.inventory === 'object' && !Array.isArray(body.inventory)
        ? (body.inventory as Record<string, unknown>)
        : {}
    const inventory = {
      ...baseInventory,
      ...(observedIp ? { observedIp } : {}),
    }
    const worker = await upsertWorkerHeartbeat({
      user: username,
      workerId: body.workerId,
      hostname: body.hostname || null,
      version: body.version || null,
      inventory,
      busySlots: typeof body.busySlots === 'number' ? body.busySlots : 0,
    })
    return NextResponse.json({
      ok: true,
      workerId: worker.workerId,
      lastSeenAt: worker.lastSeenAt.toISOString(),
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
