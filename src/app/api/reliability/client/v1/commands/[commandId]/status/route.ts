import { NextResponse } from 'next/server'

import { reliabilityErrorResponse } from '@/lib/reliability/api-error'
import { authenticateDevice } from '@/lib/reliability/client-registry'
import { handleCommandStatus } from '@/lib/reliability/command-receipt'

export const dynamic = 'force-dynamic'

/** IF-N08：指令 ACK、进度与结果。请求体与 WSS COMMAND_STATUS 帧一致。 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ commandId: string }> },
) {
  try {
    const { clientId } = await authenticateDevice(req)
    const { commandId } = await ctx.params
    const body = await req.json().catch(() => ({}))

    await handleCommandStatus({
      clientId,
      commandId,
      status: body.status,
      occurredAt: body.occurredAt ? String(body.occurredAt) : undefined,
      result: body.result,
      error: body.error,
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    return reliabilityErrorResponse(error, 'reliability/commands/status')
  }
}
