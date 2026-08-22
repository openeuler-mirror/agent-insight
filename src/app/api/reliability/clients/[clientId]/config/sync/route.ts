import { NextResponse } from 'next/server'
import { resolveUser } from '@/lib/auth/auth'
import { syncClientConfig } from '@/lib/reliability/client-config-service'

export const dynamic = 'force-dynamic'

/** IF-N11 POST .../config/sync */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ clientId: string }> },
) {
  try {
    const url = new URL(req.url)
    const body = await req.json().catch(() => ({}))
    const { username } = await resolveUser(req, body.user || url.searchParams.get('user'))
    if (!username) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    const { clientId } = await ctx.params
    const platform = url.searchParams.get('platform') || String(body.platform || 'opencode')
    const result = await syncClientConfig({
      user: username,
      clientId,
      platform,
      configRef: body.configRef,
    })
    return NextResponse.json(
      {
        deliveryId: result.deliveryId,
        commandId: result.commandId,
        configRef: result.configRef,
        configVersion: result.configVersion,
        status: result.status,
      },
      { status: result.httpStatus },
    )
  } catch (error) {
    const err = error as { code?: string; status?: number; message?: string }
    if (err?.code && err?.status) {
      return NextResponse.json({ error: err.message || err.code, code: err.code }, { status: err.status })
    }
    console.error('[reliability/config/sync]', error)
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}
