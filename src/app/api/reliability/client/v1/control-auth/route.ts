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
