import { NextResponse } from 'next/server'
import { resolveWorkerCaller } from '@/lib/reliability/worker-dual-auth'
import {
  claimQueuedRuns,
  listStopCommandsForWorker,
  sweepStaleClaims,
} from '@/lib/fault-injection/worker-protocol'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const caller = await resolveWorkerCaller(req)
    if (!caller) {
      return NextResponse.json({ error: 'API key or device credential required' }, { status: 401 })
    }
    const username = caller.username
    const body = await req.json()
    // 设备凭证路径下 workerId 恒等于 clientId，不接受请求体伪造他人身份。
    const workerId = caller.clientId || body.workerId
    if (!workerId || typeof workerId !== 'string') {
      return NextResponse.json({ error: 'workerId required' }, { status: 400 })
    }
    const limit = typeof body.limit === 'number' ? body.limit : 1
    await sweepStaleClaims(username)
    const runs = await claimQueuedRuns({
      user: username,
      workerId,
      limit,
    })
    const commands = await listStopCommandsForWorker(username, workerId)
    return NextResponse.json({ runs, commands })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
