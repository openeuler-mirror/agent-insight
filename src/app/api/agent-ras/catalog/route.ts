import { NextResponse } from 'next/server'

import { resolveUser } from '@/lib/auth/auth'
import { getRasCapabilityCatalog } from '@/lib/ingest/ras/catalog-engine'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    await resolveUser(req)
    const force = new URL(req.url).searchParams.get('force') === '1'
    const catalog = await getRasCapabilityCatalog({ force })
    if (catalog.kindLabels) {
      const { setAnomalyKindLabelOverrides } = await import('@/lib/ingest/ras/normalize')
      setAnomalyKindLabelOverrides(catalog.kindLabels)
    }
    return NextResponse.json({ status: 'ok', catalog })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[agent-ras/catalog] GET error:', message)
    return NextResponse.json({ error: 'server_error', message }, { status: 500 })
  }
}
