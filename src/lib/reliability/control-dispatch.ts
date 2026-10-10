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
