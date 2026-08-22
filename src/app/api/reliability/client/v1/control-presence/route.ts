import { NextResponse } from 'next/server'

import { prisma } from '@/lib/storage/prisma'
import { reliabilityErrorResponse } from '@/lib/reliability/api-error'
import { assertInternalCaller } from '@/lib/reliability/internal-guard'
import { setPresence } from '@/lib/reliability/control-hub'

export const dynamic = 'force-dynamic'

/** 内部接口：control-server 报告 WSS 连接建立/断开。 */
export async function POST(req: Request) {
  try {
    assertInternalCaller(req)
    const body = await req.json().catch(() => ({}))
    const clientId = String(body.clientId || '').trim()
    if (!clientId) {
      return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'clientId required' } }, { status: 400 })
    }
    const connected = body.connected === true
    setPresence(clientId, connected)
    // 连接建立即刷新 lastSeenAt；断开不改状态，交给心跳窗口自然过期。
    if (connected) {
      await prisma.reliabilityClient.updateMany({
        where: { clientId },
        data: { lastSeenAt: new Date(), status: 'online' },
      })
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    return reliabilityErrorResponse(error, 'reliability/control-presence')
  }
}
