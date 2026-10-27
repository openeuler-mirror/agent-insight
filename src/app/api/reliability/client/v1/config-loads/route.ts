/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { NextResponse } from 'next/server'

import { reliabilityErrorResponse } from '@/lib/reliability/api-error'
import { authenticateDevice } from '@/lib/reliability/client-registry'
import { recordConfigLoad } from '@/lib/reliability/client-config-service'

export const dynamic = 'force-dynamic'

/** IF-N12：RAS 加载回报。设备凭证鉴权。 */
export async function POST(req: Request) {
  try {
    const { clientId, user } = await authenticateDevice(req)
    const body = await req.json().catch(() => ({}))
    const platform = String(body.platform || '').trim()
    const configVersion = String(body.configVersion || '').trim()
    const statusRaw = String(body.status || '').trim()
    if (!platform || !configVersion || !statusRaw) {
      return NextResponse.json(
        { error: { code: 'BAD_REQUEST', message: 'platform, configVersion, status required' } },
        { status: 400 },
      )
    }
    const status =
      statusRaw === 'loaded'
        ? 'loaded'
        : statusRaw === 'version_mismatch'
          ? 'version_mismatch'
          : 'failed'

    const result = await recordConfigLoad({
      user,
      clientId,
      platform,
      scope: body.scope ? String(body.scope) : undefined,
      configVersion,
      checksum: body.checksum ? String(body.checksum) : undefined,
      rasProcessId: body.rasProcessId ? String(body.rasProcessId) : undefined,
      status,
      loadedAt: body.loadedAt ? String(body.loadedAt) : undefined,
      error: body.error,
    })

    if (result.deliveryStatus === 'version_mismatch' && status === 'loaded') {
      return NextResponse.json(
        {
          error: {
            code: 'CONFIG_VERSION_MISMATCH',
            message: '回报的 configVersion 与当前 delivery 不一致',
          },
          deliveryStatus: result.deliveryStatus,
        },
        { status: 409 },
      )
    }
    return NextResponse.json({ ok: true, deliveryStatus: result.deliveryStatus })
  } catch (error) {
    return reliabilityErrorResponse(error, 'reliability/config-loads')
  }
}
