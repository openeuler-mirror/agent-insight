import { NextResponse } from 'next/server'

import { resolveUser } from '@/lib/auth/auth'
import { reliabilityErrorResponse } from '@/lib/reliability/api-error'
import { createInstallToken } from '@/lib/reliability/client-registry'

export const dynamic = 'force-dynamic'

function baseUrlOf(req: Request): string {
  const url = new URL(req.url)
  const forwardedHost = req.headers.get('x-forwarded-host')
  const forwardedProto = req.headers.get('x-forwarded-proto')
  const host = forwardedHost || url.host
  const proto = forwardedProto || url.protocol.replace(':', '')
  const base = new URL(`${proto}://${host}`)
  if (base.hostname === '0.0.0.0' || base.hostname === '::' || base.hostname === '[::]') {
    base.hostname = '127.0.0.1'
  }
  return base.origin
}

/** IF-N01：创建一次性安装令牌并返回安装命令。 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const { username } = await resolveUser(req, body.user)
    if (!username) {
      return NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'user is required' } },
        { status: 401 },
      )
    }
    const { installToken, expiresAt } = await createInstallToken({
      user: username,
      name: body.name ? String(body.name) : null,
      platform: body.platform ? String(body.platform) : null,
      expiresInSeconds: Number(body.expiresInSeconds) || 600,
    })
    const base = baseUrlOf(req)
    return NextResponse.json(
      {
        installToken,
        expiresAt,
        // 安装脚本据此判断本机是否已绑定到别的账号（决定跳过还是改绑）。
        user: username,
        commands: {
          unix: `curl -sSf '${base}/api/ingest/setup/ras-client?platform=unix' | bash -s -- --token '${installToken}'`,
        },
      },
      { status: 201 },
    )
  } catch (error) {
    return reliabilityErrorResponse(error, 'reliability/install-tokens')
  }
}
