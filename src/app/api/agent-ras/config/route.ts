import { NextResponse } from 'next/server'

import { resolveUser } from '@/lib/auth/auth'
import {
  buildUpdatedEnvelope,
  exportCapabilityJson,
  exportCapabilityYaml,
  isRasCapabilityPlatformId,
  type PutCapabilityInput,
} from '@/lib/ingest/ras/capability-config'
import {
  getCapabilityEnvelope,
  saveCapabilityEnvelope,
} from '@/lib/ingest/ras/capability-config-store'

export const dynamic = 'force-dynamic'

function unauthorized() {
  return NextResponse.json(
    { error: 'unauthorized', detail: 'valid auth required' },
    { status: 401 },
  )
}

export async function GET(req: Request) {
  try {
    const { username: user } = await resolveUser(req)
    if (!user) return unauthorized()

    const url = new URL(req.url)
    const platform = url.searchParams.get('platform')
    if (!isRasCapabilityPlatformId(platform)) {
      return NextResponse.json(
        { error: 'invalid_platform', detail: 'platform query required' },
        { status: 400 },
      )
    }

    const format = url.searchParams.get('format')
    const envelope = getCapabilityEnvelope(user, platform)
    if (format === 'yaml') {
      return new NextResponse(exportCapabilityYaml(envelope), {
        headers: { 'content-type': 'text/yaml; charset=utf-8' },
      })
    }
    if (format === 'json-export') {
      return new NextResponse(exportCapabilityJson(envelope), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }
    return NextResponse.json({ status: 'ok', envelope })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[agent-ras/config] GET error:', message)
    return NextResponse.json({ error: 'server_error', message }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  try {
    const { username: user } = await resolveUser(req)
    if (!user) return unauthorized()

    const url = new URL(req.url)
    const platform = url.searchParams.get('platform')
    if (!isRasCapabilityPlatformId(platform)) {
      return NextResponse.json(
        { error: 'invalid_platform', detail: 'platform query required' },
        { status: 400 },
      )
    }

    const body = (await req.json()) as PutCapabilityInput
    const existing = getCapabilityEnvelope(user, platform)
    const updated = buildUpdatedEnvelope(existing, body)
    if (!updated.ok) {
      return NextResponse.json({ error: 'validation_error', detail: updated.error }, { status: 400 })
    }
    const envelope = saveCapabilityEnvelope(user, updated.envelope)
    return NextResponse.json({ status: 'ok', envelope })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[agent-ras/config] PUT error:', message)
    return NextResponse.json({ error: 'server_error', message }, { status: 500 })
  }
}
