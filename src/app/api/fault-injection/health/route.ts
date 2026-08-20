import { NextResponse } from 'next/server'
import { resolveUser } from '@/lib/auth/auth'
import { listPlatformsFromWorkers } from '@/lib/fault-injection/worker-protocol'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { username } = await resolveUser(req)
  const { platforms, workers, ok } = await listPlatformsFromWorkers(username)
  return NextResponse.json({
    ok,
    needsWorker: !ok,
    workers,
    platforms,
  })
}
