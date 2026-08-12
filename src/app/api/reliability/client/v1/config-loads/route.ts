import { NextResponse } from 'next/server'
import { resolveUser } from '@/lib/auth/auth'
import { recordConfigLoad } from '@/lib/reliability/client-config-service'

export const dynamic = 'force-dynamic'

/** IF-N12 */
export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { username } = await resolveUser(req, body.user)
    const clientId = String(body.clientId || '').trim()
    const platform = String(body.platform || '').trim()
    const configVersion = String(body.configVersion || '').trim()
    const statusRaw = String(body.status || '').trim()
    if (!clientId || !platform || !configVersion || !statusRaw) {
      return NextResponse.json({ error: 'clientId, platform, configVersion, status required' }, { status: 400 })
    }
    if (!username) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    const status =
      statusRaw === 'loaded'
        ? 'loaded'
        : statusRaw === 'version_mismatch'
          ? 'version_mismatch'
          : 'failed'
    const result = recordConfigLoad({
      user: username,
      clientId,
      platform,
      configVersion,
      checksum: body.checksum ? String(body.checksum) : undefined,
      status,
      loadedAt: body.loadedAt ? String(body.loadedAt) : undefined,
      error: body.error,
    })
    return NextResponse.json({ ok: true, deliveryStatus: result.deliveryStatus })
  } catch (error) {
    const err = error as { code?: string; status?: number; message?: string }
    if (err?.code && err?.status) {
      return NextResponse.json({ error: err.message || err.code, code: err.code }, { status: err.status })
    }
    console.error('[reliability/config-loads]', error)
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}
