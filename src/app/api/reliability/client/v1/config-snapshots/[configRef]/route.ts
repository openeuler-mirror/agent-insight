import { NextResponse } from 'next/server'
import { resolveUser } from '@/lib/auth/auth'
import {
  findSnapshotAcrossUsers,
  getConfigSnapshot,
} from '@/lib/reliability/client-config-service'

export const dynamic = 'force-dynamic'

/** IF-N17 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ configRef: string }> },
) {
  try {
    const { configRef } = await ctx.params
    const url = new URL(req.url)
    const headerClientId = req.headers.get('x-agent-insight-client-id') || ''
    const clientId = headerClientId || url.searchParams.get('clientId') || ''
    const { username } = await resolveUser(req, url.searchParams.get('user'))

    let user = username
    if (!user) {
      const found = findSnapshotAcrossUsers(configRef)
      if (!found) {
        return NextResponse.json(
          { error: 'CONFIG_SNAPSHOT_NOT_FOUND', code: 'CONFIG_SNAPSHOT_NOT_FOUND' },
          { status: 404 },
        )
      }
      user = found.user
      if (!clientId) {
        return NextResponse.json(
          { error: 'X-Agent-Insight-Client-Id required', code: 'CLIENT_ID_REQUIRED' },
          { status: 400 },
        )
      }
    }
    if (!clientId) {
      return NextResponse.json(
        { error: 'X-Agent-Insight-Client-Id required', code: 'CLIENT_ID_REQUIRED' },
        { status: 400 },
      )
    }

    const snapshot = getConfigSnapshot({ user, clientId, configRef })
    const etag = `"${snapshot.checksum}"`
    if (req.headers.get('if-none-match') === etag) {
      return new NextResponse(null, { status: 304, headers: { ETag: etag } })
    }
    return NextResponse.json(
      {
        configRef: snapshot.configRef,
        clientId: snapshot.clientId,
        platform: snapshot.platform,
        scope: snapshot.scope,
        schemaVersion: snapshot.schemaVersion,
        configVersion: snapshot.configVersion,
        checksum: snapshot.checksum,
        correlation: snapshot.correlation || null,
        expiresAt: snapshot.expiresAt,
        config: snapshot.config,
      },
      { headers: { ETag: etag } },
    )
  } catch (error) {
    const err = error as { code?: string; status?: number; message?: string }
    if (err?.code && err?.status) {
      return NextResponse.json({ error: err.message || err.code, code: err.code }, { status: err.status })
    }
    console.error('[reliability/config-snapshots]', error)
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}
