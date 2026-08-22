import { NextResponse } from 'next/server'

import { reliabilityErrorResponse } from '@/lib/reliability/api-error'
import { authenticateDevice } from '@/lib/reliability/client-registry'
import { assertInternalCaller } from '@/lib/reliability/internal-guard'

export const dynamic = 'force-dynamic'

/**
 * 内部接口：control-server 在 WSS 握手时校验设备凭证。
 * 只接受来自本机 control-server 的调用，不对外暴露。
 */
export async function POST(req: Request) {
  try {
    assertInternalCaller(req)
    const body = await req.json().catch(() => ({}))
    const proxied = new Request('http://internal/control-auth', {
      headers: {
        authorization: String(body.authorization || ''),
        'x-agent-insight-client-id': String(body.clientId || ''),
      },
    })
    const { clientId, user } = await authenticateDevice(proxied)
    return NextResponse.json({ clientId, user })
  } catch (error) {
    return reliabilityErrorResponse(error, 'reliability/control-auth')
  }
}
