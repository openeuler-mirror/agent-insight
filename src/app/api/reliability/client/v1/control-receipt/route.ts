import { NextResponse } from 'next/server'

import { reliabilityErrorResponse } from '@/lib/reliability/api-error'
import { assertInternalCaller } from '@/lib/reliability/internal-guard'
import { handleCommandStatus } from '@/lib/reliability/command-receipt'

export const dynamic = 'force-dynamic'

/**
 * 内部接口：control-server 转发 WSS 上收到的 COMMAND_STATUS。
 * 与 IF-N08 走同一处理函数，保证两条通道语义一致。
 */
export async function POST(req: Request) {
  try {
    assertInternalCaller(req)
    const body = await req.json().catch(() => ({}))
    const clientId = String(body.clientId || '').trim()
    const commandId = String(body.commandId || '').trim()
    if (!clientId || !commandId) {
      return NextResponse.json(
        { error: { code: 'BAD_REQUEST', message: 'clientId, commandId required' } },
        { status: 400 },
      )
    }
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
    return reliabilityErrorResponse(error, 'reliability/control-receipt')
  }
}
