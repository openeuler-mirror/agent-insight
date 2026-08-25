/**
 * 兼容期双鉴权：FI Worker 端点同时接受
 *   - 存量 FI Worker 的用户级 API Key（x-witty-api-key）
 *   - 新常驻客户端的设备凭证（Authorization: Bearer）
 *
 * 新客户端用自己的 clientId 作为 workerId 领取 FI run，
 * 因此 FaultInjectionRun.workerId 无需迁移。
 */
import { resolveUser } from '@/lib/auth/auth'
import { authenticateDevice } from '@/lib/reliability/client-registry'

export type WorkerCaller = {
  username: string
  /** 设备凭证路径下为 clientId；API Key 路径下为 null，由请求体给出 workerId。 */
  clientId: string | null
}

export async function resolveWorkerCaller(req: Request): Promise<WorkerCaller | null> {
  const { username } = await resolveUser(req)
  if (username) return { username, clientId: null }

  if (req.headers.get('authorization')) {
    try {
      const device = await authenticateDevice(req)
      return { username: device.user, clientId: device.clientId }
    } catch {
      return null
    }
  }
  return null
}
