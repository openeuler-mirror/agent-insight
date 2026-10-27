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
