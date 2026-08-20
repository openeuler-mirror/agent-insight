import { NextResponse } from 'next/server'
import { resolveUser } from '@/lib/auth/auth'
import { listFaultModes } from '@/lib/reliability/fault-modes'

export const dynamic = 'force-dynamic'

/** IF-N16：内置故障模式注册表（只读）。 */
export async function GET(req: Request) {
  try {
    await resolveUser(req)
    const platform = new URL(req.url).searchParams.get('platform')
    const payload = await listFaultModes(platform)
    return NextResponse.json(payload)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
