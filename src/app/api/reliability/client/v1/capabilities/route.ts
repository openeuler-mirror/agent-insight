import { NextResponse } from 'next/server'

import { reliabilityErrorResponse } from '@/lib/reliability/api-error'
import { clientIpFromRequest } from '@/lib/reliability/client-ip'
import { authenticateDevice, updateCapabilities } from '@/lib/reliability/client-registry'

export const dynamic = 'force-dynamic'

/** IF-N15：刷新 IP、Agent 平台与模型能力。同一 revision 重复上报幂等。 */
export async function PUT(req: Request) {
  try {
    const { clientId } = await authenticateDevice(req)
    const body = await req.json().catch(() => ({}))
    const result = await updateCapabilities({
      clientId,
      revision: body.revision ? String(body.revision) : null,
      hostname: body.hostname ? String(body.hostname) : null,
      reportedIp: body.reportedIp ? String(body.reportedIp) : null,
      // 服务端从连接源地址生成 observedIp，不接受请求体覆盖。
      observedIp: clientIpFromRequest(req),
      os: body.os ? String(body.os) : null,
      arch: body.arch ? String(body.arch) : null,
      capabilities: {
        platforms: Array.isArray(body.platforms) ? body.platforms : [],
        actions: body.actions,
        components: body.components,
        faultInjection: body.faultInjection,
      },
    })
    return NextResponse.json({
      acceptedRevision: result.acceptedRevision,
      serverTime: new Date().toISOString(),
    })
  } catch (error) {
    return reliabilityErrorResponse(error, 'reliability/capabilities')
  }
}
