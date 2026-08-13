/**
 * WSS 连接注册表（IF-N05 服务端侧）。
 *
 * 单实例内存表。控制服务器（scripts/control-server.js）在 upgrade 时注册连接，
 * 业务侧只通过 deliverCommand 投递，不直接接触 socket。
 *
 * 全局单例：Next dev 的模块热重载会重复求值本模块，连接表必须挂在 globalThis 上，
 * 否则重载后已建立的连接会失联。
 */
import type { CommandFrame } from '@/lib/reliability/command-bus'

export type ControlSocket = {
  send: (data: string) => void
  close: () => void
}

type Hub = {
  sockets: Map<string, ControlSocket>
  /** control-server 进程持有真实 socket 时，Next 侧只记在线名单。 */
  presence: Set<string>
}

const KEY = Symbol.for('agent-insight.reliability.control-hub')

function hub(): Hub {
  const g = globalThis as unknown as Record<symbol, Hub | undefined>
  if (!g[KEY]) g[KEY] = { sockets: new Map(), presence: new Set() }
  return g[KEY]!
}

export function setPresence(clientId: string, connected: boolean): void {
  if (connected) hub().presence.add(clientId)
  else hub().presence.delete(clientId)
}

export function registerSocket(clientId: string, socket: ControlSocket): void {
  const existing = hub().sockets.get(clientId)
  if (existing && existing !== socket) {
    try {
      existing.close()
    } catch {
      /* ignore */
    }
  }
  hub().sockets.set(clientId, socket)
}

export function unregisterSocket(clientId: string, socket?: ControlSocket): void {
  const current = hub().sockets.get(clientId)
  if (socket && current !== socket) return
  hub().sockets.delete(clientId)
}

export function isConnected(clientId: string): boolean {
  return hub().sockets.has(clientId) || hub().presence.has(clientId)
}

export function connectedClientIds(): string[] {
  return [...new Set([...hub().sockets.keys(), ...hub().presence])]
}

/**
 * 投递指令帧。返回 true 只表示写入了 socket —— 不代表客户端已收到。
 * 送达以客户端回 RECEIVED 为准。
 */
export function deliverCommand(clientId: string, frame: CommandFrame): boolean {
  const socket = hub().sockets.get(clientId)
  if (!socket) return false
  try {
    socket.send(JSON.stringify(frame))
    return true
  } catch {
    hub().sockets.delete(clientId)
    return false
  }
}

export function resetControlHubForTests(): void {
  hub().sockets.clear()
  hub().presence.clear()
}
