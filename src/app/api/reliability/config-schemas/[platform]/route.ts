import { NextResponse } from 'next/server'
import {
  buildBuiltinConfigSchema,
  isReliabilityPlatformId,
} from '@/lib/reliability/client-config-model'

export const dynamic = 'force-dynamic'

/** IF-N10：内置只读 Schema（随产品发布，无用户态差异）。 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ platform: string }> },
) {
  try {
    const { platform } = await ctx.params
    if (!isReliabilityPlatformId(platform)) {
      return NextResponse.json(
        { error: 'PLATFORM_SCHEMA_NOT_FOUND', code: 'PLATFORM_SCHEMA_NOT_FOUND' },
        { status: 404 },
      )
    }
    return NextResponse.json(buildBuiltinConfigSchema(platform))
  } catch (error) {
    console.error('[reliability/config-schemas GET]', error)
    return NextResponse.json({ error: 'Failed to load schema' }, { status: 500 })
  }
}
