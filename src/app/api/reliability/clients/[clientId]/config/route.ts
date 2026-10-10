import { NextResponse } from 'next/server'
import { resolveUser } from '@/lib/auth/auth'
import {
  deleteClientConfig,
  getClientConfigView,
  putClientConfig,
} from '@/lib/reliability/client-config-service'

export const dynamic = 'force-dynamic'

function errorResponse(error: unknown) {
  const err = error as {
    code?: string
    status?: number
    revision?: number
    message?: string
    details?: Record<string, unknown>
  }
  if (err?.code && err?.status) {
    return NextResponse.json(
      {
        error: err.message || err.code,
        code: err.code,
        revision: err.revision,
        // 带上逐字段原因：只说「字段不合法」，调用方无从知道是哪个字段、差在哪。
        details: err.details,
      },
      { status: err.status },
    )
  }
  console.error('[reliability/clients/config]', error)
  return NextResponse.json({ error: 'internal error' }, { status: 500 })
}

/** IF-N11 GET */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ clientId: string }> },
) {
  try {
    const url = new URL(req.url)
    const { username } = await resolveUser(req, url.searchParams.get('user'))
    if (!username) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    const { clientId } = await ctx.params
    const platform = url.searchParams.get('platform') || 'opencode'
    const view = await getClientConfigView(username, clientId, platform)
    return NextResponse.json(view)
  } catch (error) {
    return errorResponse(error)
  }
}

/** IF-N11 PUT */
export async function PUT(
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
    const result = await putClientConfig({
      user: username,
      clientId,
      platform,
      overrideDiff: body.overrideDiff,
      expectedRevision: body.expectedRevision,
      sync: body.sync === true,
    })
    const payload: Record<string, unknown> = {
      revision: result.revision,
      status: result.status,
    }
    if (result.configRef) payload.configRef = result.configRef
    if (result.configVersion) payload.configVersion = result.configVersion
    if (result.checksum) payload.checksum = result.checksum
    if (result.deliveryId) payload.deliveryId = result.deliveryId
    if (result.commandId) payload.commandId = result.commandId
    if (result.saved != null) payload.saved = result.saved
    if (result.sync) payload.sync = result.sync
    return NextResponse.json(payload, { status: result.httpStatus })
  } catch (error) {
    return errorResponse(error)
  }
}

/** IF-N11 DELETE */
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ clientId: string }> },
) {
  try {
    const url = new URL(req.url)
    const { username } = await resolveUser(req, url.searchParams.get('user'))
    if (!username) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    const { clientId } = await ctx.params
    const platform = url.searchParams.get('platform') || 'opencode'
    const pathKey = url.searchParams.get('path')
    const sync = url.searchParams.get('sync') === 'true'
    const result = await deleteClientConfig({
      user: username,
      clientId,
      platform,
      path: pathKey,
      sync,
    })
    return NextResponse.json(
      {
        revision: result.revision,
        status: result.status,
        configRef: result.configRef,
        configVersion: result.configVersion,
        deliveryId: result.deliveryId,
        commandId: result.commandId,
        sync: result.sync,
        saved: result.saved,
      },
      { status: result.httpStatus },
    )
  } catch (error) {
    return errorResponse(error)
  }
}
