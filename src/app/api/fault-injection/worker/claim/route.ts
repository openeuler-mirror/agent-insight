import { NextResponse } from 'next/server'
import { resolveUser } from '@/lib/auth/auth'
import {
  claimQueuedRuns,
  listStopCommandsForWorker,
  sweepStaleClaims,
} from '@/lib/fault-injection/worker-protocol'

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
    const limit = typeof body.limit === 'number' ? body.limit : 1
    await sweepStaleClaims(username)
    const runs = await claimQueuedRuns({
      user: username,
      workerId: body.workerId,
      limit,
    })
    const commands = await listStopCommandsForWorker(username, body.workerId)
    return NextResponse.json({ runs, commands })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
