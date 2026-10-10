import { NextResponse } from 'next/server'

import { reliabilityErrorResponse } from '@/lib/reliability/api-error'
import { clientIpFromRequest } from '@/lib/reliability/client-ip'
import { authenticateDevice, recordHeartbeat } from '@/lib/reliability/client-registry'

export const dynamic = 'force-dynamic'

/** IF-N06：心跳。只更新在线度与进程健康度，不承载指令。 */
export async function POST(req: Request) {
  try {
    const { clientId } = await authenticateDevice(req)
    const body = await req.json().catch(() => ({}))
    const result = await recordHeartbeat({
      clientId,
      agentVersion: body.agentVersion ? String(body.agentVersion) : null,
      status: body.status ? String(body.status) : null,
      observedIp: clientIpFromRequest(req),
      service: body.service,
    })
    return NextResponse.json({
      serverTime: new Date().toISOString(),
      nextHeartbeatSeconds: result.nextHeartbeatSeconds,
      refreshCapabilities: result.refreshCapabilities,
    })
  } catch (error) {
    return reliabilityErrorResponse(error, 'reliability/heartbeat')
  }
}
