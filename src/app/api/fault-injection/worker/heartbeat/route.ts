import { NextResponse } from 'next/server'
import { resolveWorkerCaller } from '@/lib/reliability/worker-dual-auth'
import {
  sweepStaleClaims,
  upsertWorkerHeartbeat,
} from '@/lib/fault-injection/worker-protocol'
import { clientIpFromRequest } from '@/lib/reliability/client-ip'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const caller = await resolveWorkerCaller(req)
    if (!caller) {
      return NextResponse.json({ error: 'API key or device credential required' }, { status: 401 })
    }
    const username = caller.username
    const body = await req.json()
    const workerId = caller.clientId || body.workerId
    if (!workerId || typeof workerId !== 'string') {
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
      ...(typeof body.clientId === "string" ? { clientId: body.clientId } : {}),
      ...(observedIp ? { observedIp } : {}),
    }
    const worker = await upsertWorkerHeartbeat({
      user: username,
      workerId,
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
