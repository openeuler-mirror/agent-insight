import { NextResponse } from 'next/server'

import { reliabilityErrorResponse } from '@/lib/reliability/api-error'
import { clientIpFromRequest } from '@/lib/reliability/client-ip'
import { registerClient } from '@/lib/reliability/client-registry'

export const dynamic = 'force-dynamic'

function controlUrls(req: Request): { websocketUrl: string; pollUrl: string } {
  const url = new URL(req.url)
  const forwardedHost = req.headers.get('x-forwarded-host')
  const forwardedProto = req.headers.get('x-forwarded-proto')
  const host = forwardedHost || url.host
  const proto = forwardedProto || url.protocol.replace(':', '')
  const wsProto = proto === 'https' ? 'wss' : 'ws'
  return {
    websocketUrl: `${wsProto}://${host}/api/reliability/client/v1/control`,
    pollUrl: `${proto}://${host}/api/reliability/client/v1/commands/next`,
  }
}

/** IF-N04：以一次性安装令牌换取 clientId + 设备凭证。凭证只返回一次。 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const installToken = String(body.installToken || '').trim()
    if (!installToken) {
      return NextResponse.json(
        { error: { code: 'BAD_REQUEST', message: 'installToken required' } },
        { status: 400 },
      )
    }
    const client = (body.client && typeof body.client === 'object' ? body.client : {}) as Record<
      string,
      unknown
    >
    const result = await registerClient({
      installToken,
      name: client.name ? String(client.name) : null,
      hostname: client.hostname ? String(client.hostname) : null,
      reportedIp: client.ip ? String(client.ip) : null,
      observedIp: clientIpFromRequest(req),
      os: client.os ? String(client.os) : null,
      arch: client.arch ? String(client.arch) : null,
      agentVersion: client.agentVersion ? String(client.agentVersion) : null,
      supervisor: client.supervisor ? String(client.supervisor) : null,
      capabilities: body.capabilities,
      previousClientId: body.previousClientId ? String(body.previousClientId) : null,
    })

    const { websocketUrl, pollUrl } = controlUrls(req)
    return NextResponse.json(
      {
        clientId: result.clientId,
        // 归属写进客户端配置，作为下次安装判断是否需要改绑的依据。
        user: result.user,
        deviceCredential: result.deviceCredential,
        unboundPrevious: result.unboundPrevious,
        control: {
          websocketUrl,
          pollUrl,
          heartbeatIntervalSeconds: 30,
          ackTimeoutSeconds: Number(process.env.AGENT_INSIGHT_RAS_ACK_TIMEOUT_SEC || 5),
        },
      },
      { status: 201 },
    )
  } catch (error) {
    return reliabilityErrorResponse(error, 'reliability/register')
  }
}
