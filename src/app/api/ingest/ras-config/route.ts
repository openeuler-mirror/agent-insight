import { NextResponse } from 'next/server'

import { resolveUser } from '@/lib/auth/auth'
import {
  isRasCapabilityPlatformId,
  toIngestPayload,
} from '@/lib/ingest/ras/capability-config'
import { getCapabilityEnvelope } from '@/lib/ingest/ras/capability-config-store'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const { username, apiKey } = await resolveUser(req)
    if (apiKey && !username) {
      return NextResponse.json({ error: 'unauthorized', detail: 'invalid API key' }, { status: 401 })
    }
    if (!username && !process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER) {
      return NextResponse.json(
        {
          error: 'unauthorized',
          detail: 'x-witty-api-key required (or set AGENT_INSIGHT_DEFAULT_INGEST_USER for local demo)',
        },
        { status: 401 },
      )
    }
    const effectiveUser = username || process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER || null
    if (!effectiveUser) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }

    const url = new URL(req.url)
    const platform = url.searchParams.get('platform') || 'opencode'
    if (!isRasCapabilityPlatformId(platform)) {
      return NextResponse.json({ error: 'invalid_platform' }, { status: 400 })
    }

    const envelope = getCapabilityEnvelope(effectiveUser, platform)
    return NextResponse.json({
      status: 'ok',
      ...toIngestPayload(envelope),
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[RAS ras-config] GET error:', message)
    return NextResponse.json({ status: 'error', message }, { status: 500 })
  }
}
