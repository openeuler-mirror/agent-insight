import { NextResponse } from 'next/server'
import { resolveUser } from '@/lib/auth/auth'
import { getLatestWorkerInventory } from '@/lib/fault-injection/worker-protocol'
import type { PlatformOption } from '@/lib/fault-injection/types'

export const dynamic = 'force-dynamic'

function asOptions(rows: unknown[]): PlatformOption[] {
  const out: PlatformOption[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const rec = row as Record<string, unknown>
    const id = String(rec.id || rec.modelID || rec.name || '').trim()
    out.push({ id, label: String(rec.label || rec.name || id || '平台默认') })
  }
  return out
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ platform: string }> },
) {
  const { username } = await resolveUser(req)
  const { platform } = await ctx.params
  const inv = await getLatestWorkerInventory(username, platform)
  if (!inv?.platformInventory) {
    return NextResponse.json(
      {
        error:
          'No online FI Worker inventory. Open「新建注入任务」and run the account-bound setup command on this machine.',
        platform,
        models: [{ id: '', label: '平台默认' }],
        default: null,
        source: 'worker_missing',
      },
      { status: 503 },
    )
  }
  const models = asOptions(
    Array.isArray(inv.platformInventory.models) ? inv.platformInventory.models : [],
  )
  const withDefault: PlatformOption[] = [
    { id: '', label: '平台默认' },
    ...models.filter((m) => m.id),
  ]
  return NextResponse.json({
    platform,
    models: withDefault,
    default: null,
    source: 'worker',
    workerId: inv.workerId,
    lastSeenAt: inv.lastSeenAt.toISOString(),
  })
}
