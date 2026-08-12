import { NextResponse } from 'next/server'
import { resolveUser } from '@/lib/auth/auth'
import { listFaultsViaPython } from '@/lib/fault-injection/engine'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    await resolveUser(req)
    const platform = new URL(req.url).searchParams.get('platform') || undefined
    const faults = await listFaultsViaPython(platform || undefined)
    return NextResponse.json({ faults })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
