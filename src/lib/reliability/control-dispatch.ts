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

/**
 * 向 control-server 投递指令帧。
 *
 * control-server 与 Next 在同一进程内跑，但连接表在 control-server 的闭包里，
 * 因此这里通过它绑定在 127.0.0.1 的 dispatch 端口投递。
 * 未启用 control-server（如 dev 模式）时回落到进程内 hub。
 */
import type { CommandFrame } from '@/lib/reliability/command-bus'
import { deliverCommand as deliverViaHub, isConnected as hubConnected } from '@/lib/reliability/control-hub'

function dispatchUrl(): string | null {
  const port = process.env.AGENT_INSIGHT_RAS_DISPATCH_PORT
  if (!port) return null
  return `http://127.0.0.1:${port}`
}

export async function dispatchCommand(
  clientId: string,
  frame: CommandFrame,
): Promise<{ delivered: boolean; connected: boolean }> {
  const base = dispatchUrl()
  if (!base) {
    const delivered = deliverViaHub(clientId, frame)
    return { delivered, connected: hubConnected(clientId) }
  }
  try {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId, frame }),
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return { delivered: false, connected: false }
    const json = (await res.json()) as { delivered?: boolean; connected?: boolean }
    return { delivered: Boolean(json.delivered), connected: Boolean(json.connected) }
  } catch {
    return { delivered: false, connected: false }
  }
}
