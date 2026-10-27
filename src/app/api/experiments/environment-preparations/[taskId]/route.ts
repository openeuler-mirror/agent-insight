import { NextResponse } from 'next/server'
import { resolveUser } from '@/lib/auth/auth'
import { getEnvironmentPreparation } from '@/lib/engine/experiment/environment-preparation'
import { reliabilityErrorResponse } from '@/lib/reliability/api-error'

export const dynamic = 'force-dynamic'

export async function GET(req: Request, ctx: { params: Promise<{ taskId: string }> }) {
  try {
    const { username } = await resolveUser(req, new URL(req.url).searchParams.get('user'))
    if (!username) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    const { taskId } = await ctx.params
    return NextResponse.json(await getEnvironmentPreparation(username, taskId))
  } catch (error) { return reliabilityErrorResponse(error, 'experiments/environment-preparations/status') }
}
