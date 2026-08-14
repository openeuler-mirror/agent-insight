import { NextResponse } from 'next/server'

import { reliabilityErrorResponse } from '@/lib/reliability/api-error'
import { authenticateDevice } from '@/lib/reliability/client-registry'
import { getConfigSnapshot } from '@/lib/reliability/client-config-service'

export const dynamic = 'force-dynamic'

/**
 * IF-N17：按 configRef 拉取不可变快照。
 * 设备凭证决定 clientId，因此不再需要跨用户查找 —— 快照绑定关系由 getConfigSnapshot 校验。
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ configRef: string }> },
) {
  try {
    const { configRef } = await ctx.params
    const { clientId } = await authenticateDevice(req)

    const snapshot = await getConfigSnapshot({ clientId, configRef })
    const etag = `"${snapshot.checksum}"`
    if (req.headers.get('if-none-match') === etag) {
      return new NextResponse(null, { status: 304, headers: { ETag: etag } })
    }
    return NextResponse.json(
      {
        configRef: snapshot.configRef,
        clientId: snapshot.clientId,
        platform: snapshot.platform,
        scope: snapshot.scope,
        schemaVersion: snapshot.schemaVersion,
        configVersion: snapshot.configVersion,
        checksum: snapshot.checksum,
        correlation: snapshot.correlation || null,
        expiresAt: snapshot.expiresAt,
        config: snapshot.config,
      },
      { headers: { ETag: etag } },
    )
  } catch (error) {
    return reliabilityErrorResponse(error, 'reliability/config-snapshots')
  }
}
