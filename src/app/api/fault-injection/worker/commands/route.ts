import { NextResponse } from 'next/server'
import { resolveWorkerCaller } from '@/lib/reliability/worker-dual-auth'
import {
  listStopCommandsForWorker,
  sweepStaleClaims,
} from '@/lib/fault-injection/worker-protocol'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const caller = await resolveWorkerCaller(req)
    if (!caller) {
      return NextResponse.json(
        { error: 'API key or device credential required' },
        { status: 401 },
      )
    }
    const username = caller.username
    const workerId = caller.clientId || new URL(req.url).searchParams.get('workerId')
    if (!workerId) {
      return NextResponse.json({ error: 'workerId required' }, { status: 400 })
    }
    await sweepStaleClaims(username)
    const commands = await listStopCommandsForWorker(username, workerId)
    return NextResponse.json({ commands })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
