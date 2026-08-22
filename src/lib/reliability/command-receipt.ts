/**
 * 客户端回执 → delivery 状态推进。WSS 与 HTTPS 长轮询共用这一份，
 * 避免两条通道对同一语义给出不同结果。
 */
import {
  markDeliveryFailed,
  markDeliveryWritten,
} from '@/lib/reliability/client-config-service'
import { applyCommandStatus } from '@/lib/reliability/command-bus'
import { ReliabilityError } from '@/lib/reliability/client-registry'

export type ClientCommandStatus = 'RECEIVED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'

const ALLOWED: ClientCommandStatus[] = ['RECEIVED', 'RUNNING', 'SUCCEEDED', 'FAILED']

export function isClientCommandStatus(value: unknown): value is ClientCommandStatus {
  return typeof value === 'string' && (ALLOWED as string[]).includes(value)
}

export async function handleCommandStatus(input: {
  clientId: string
  commandId: string
  status: unknown
  occurredAt?: string
  result?: Record<string, unknown>
  error?: { code?: string; message?: string }
}): Promise<{ ok: true }> {
  if (!isClientCommandStatus(input.status)) {
    throw new ReliabilityError('COMMAND_STATUS_INVALID', `非法回执状态: ${input.status}`, 400)
  }

  const { action, payload } = await applyCommandStatus({
    clientId: input.clientId,
    commandId: input.commandId,
    status: input.status,
    occurredAt: input.occurredAt,
    result: input.result,
    error: input.error,
  })

  const isConfigAction = action === 'APPLY_CLIENT_CONFIG' || action === 'PREPARE_EXPERIMENT_CASE'
  const configRef = String(payload.configRef || '')

  if (isConfigAction && configRef) {
    if (input.status === 'SUCCEEDED') {
      // 只有客户端明确回 WRITTEN 才推进；缺失 state 视为未确认写入。
      const state = String(input.result?.state || '')
      if (state === 'WRITTEN') {
        await markDeliveryWritten({
          clientId: input.clientId,
          configRef,
          checksum: input.result?.checksum ? String(input.result.checksum) : undefined,
        })
      }
    } else if (input.status === 'FAILED') {
      const state = String(input.result?.state || '')
      await markDeliveryFailed({
        clientId: input.clientId,
        configRef,
        stage: state === 'PULLING' ? 'pull' : 'write',
        code: input.error?.code,
        message: input.error?.message,
      })
    }
  }

  return { ok: true }
}
