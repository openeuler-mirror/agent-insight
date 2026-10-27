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
import { assertInternalCaller } from '@/lib/reliability/internal-guard'
import { handleCommandStatus } from '@/lib/reliability/command-receipt'

export const dynamic = 'force-dynamic'

/**
 * 内部接口：control-server 转发 WSS 上收到的 COMMAND_STATUS。
 * 与 IF-N08 走同一处理函数，保证两条通道语义一致。
 */
export async function POST(req: Request) {
  try {
    assertInternalCaller(req)
    const body = await req.json().catch(() => ({}))
    const clientId = String(body.clientId || '').trim()
    const commandId = String(body.commandId || '').trim()
    if (!clientId || !commandId) {
      return NextResponse.json(
        { error: { code: 'BAD_REQUEST', message: 'clientId, commandId required' } },
        { status: 400 },
      )
    }
    await handleCommandStatus({
      clientId,
      commandId,
      status: body.status,
      occurredAt: body.occurredAt ? String(body.occurredAt) : undefined,
      result: body.result,
      error: body.error,
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    return reliabilityErrorResponse(error, 'reliability/control-receipt')
  }
}
