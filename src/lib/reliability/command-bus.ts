/**
 * 控制指令总线（IF-N05/N07/N08）。
 *
 * 送达语义：连接在线 ≠ 指令送达。只有客户端回 RECEIVED 才算送达；
 * ACK 窗口内没收到就是 DELIVERY_FAILED。指令不在重连后自动补发。
 */
import { randomBytes } from 'node:crypto'

import { prisma } from '@/lib/storage/prisma'
import { ReliabilityError } from '@/lib/reliability/client-registry'

export const WHITELISTED_ACTIONS = [
  'APPLY_CLIENT_CONFIG',
  'PREPARE_EXPERIMENT_CASE',
  'RUN_EXPERIMENT_CASE',
  'REFRESH_CAPABILITIES',
] as const

export type CommandAction = (typeof WHITELISTED_ACTIONS)[number]

export type CommandStatus =
  | 'CREATED'
  | 'SENT'
  | 'RECEIVED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'EXPIRED'
  | 'DELIVERY_FAILED'

/** 配置类 action 只能携带引用，绝不能携带下载地址、文件路径或完整配置。 */
const CONFIG_FORBIDDEN_KEYS = ['url', 'config', 'path', 'downloadUrl', 'file']
/** 运行类 action 绝不能携带自由执行字段。 */
const RUN_FORBIDDEN_KEYS = ['command', 'shell', 'args', 'cwd', 'executable', 'script']

export function isWhitelistedAction(value: unknown): value is CommandAction {
  return typeof value === 'string' && (WHITELISTED_ACTIONS as readonly string[]).includes(value)
}

export function assertPayloadSafe(action: CommandAction, payload: Record<string, unknown>): void {
  const forbidden =
    action === 'RUN_EXPERIMENT_CASE' ? RUN_FORBIDDEN_KEYS : CONFIG_FORBIDDEN_KEYS
  for (const key of Object.keys(payload || {})) {
    if (forbidden.includes(key)) {
      throw new ReliabilityError(
        'COMMAND_PAYLOAD_FORBIDDEN',
        `action ${action} 的 payload 不允许字段 ${key}`,
        400,
      )
    }
  }
}

export function ackTimeoutMs(): number {
  const sec = Number(process.env.AGENT_INSIGHT_RAS_ACK_TIMEOUT_SEC || 5)
  return Math.max(1, Number.isFinite(sec) ? sec : 5) * 1000
}

export function commandTtlMs(): number {
  const sec = Number(process.env.AGENT_INSIGHT_RAS_COMMAND_TTL_SEC || 30)
  return Math.max(5, Number.isFinite(sec) ? sec : 30) * 1000
}

function newCommandId(): string {
  return `cmd_${Date.now().toString(36)}_${randomBytes(5).toString('hex')}`
}

export type CommandFrame = {
  type: 'COMMAND'
  commandId: string
  action: CommandAction
  createdAt: string
  expiresAt: string
  payload: Record<string, unknown>
}

export async function createCommand(input: {
  user: string
  clientId: string
  action: CommandAction
  payload?: Record<string, unknown>
  ttlMs?: number
}): Promise<CommandFrame> {
  if (!isWhitelistedAction(input.action)) {
    throw new ReliabilityError('COMMAND_ACTION_UNKNOWN', `未知 action: ${input.action}`, 400)
  }
  const payload = input.payload || {}
  assertPayloadSafe(input.action, payload)

  const commandId = newCommandId()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? commandTtlMs()))
  await prisma.reliabilityCommand.create({
    data: {
      commandId,
      clientId: input.clientId,
      user: input.user,
      action: input.action,
      payloadJson: JSON.stringify(payload),
      status: 'CREATED',
      expiresAt,
    },
  })
  return {
    type: 'COMMAND',
    commandId,
    action: input.action,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    payload,
  }
}

export async function markSent(commandId: string, channel: 'wss' | 'poll'): Promise<void> {
  await prisma.reliabilityCommand.updateMany({
    where: { commandId, status: 'CREATED' },
    data: { status: 'SENT', sentAt: new Date(), channel },
  })
}

/**
 * 未在 ACK 窗口内收到 RECEIVED 的 SENT 指令标为 DELIVERY_FAILED。
 * 调用点：配置保存后回读 delivery、以及列表查询前。
 */
export async function sweepUnackedCommands(user?: string): Promise<number> {
  const cutoff = new Date(Date.now() - ackTimeoutMs())
  const result = await prisma.reliabilityCommand.updateMany({
    where: {
      ...(user ? { user } : {}),
      status: 'SENT',
      sentAt: { lt: cutoff },
    },
    data: {
      status: 'DELIVERY_FAILED',
      errorCode: 'ACK_TIMEOUT',
      errorMessage: '指令已发送但未在 ACK 窗口内收到 RECEIVED',
      completedAt: new Date(),
    },
  })
  const expired = await prisma.reliabilityCommand.updateMany({
    where: {
      ...(user ? { user } : {}),
      status: { in: ['CREATED', 'RECEIVED', 'RUNNING'] },
      expiresAt: { lt: new Date() },
    },
    data: {
      status: 'EXPIRED',
      errorCode: 'COMMAND_EXPIRED',
      completedAt: new Date(),
    },
  })
  return result.count + expired.count
}

const TERMINAL: CommandStatus[] = ['SUCCEEDED', 'FAILED', 'EXPIRED', 'DELIVERY_FAILED']

export async function applyCommandStatus(input: {
  clientId: string
  commandId: string
  status: 'RECEIVED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'
  occurredAt?: string
  result?: Record<string, unknown>
  error?: { code?: string; message?: string }
}): Promise<{ action: CommandAction; payload: Record<string, unknown> }> {
  const command = await prisma.reliabilityCommand.findUnique({
    where: { commandId: input.commandId },
  })
  if (!command || command.clientId !== input.clientId) {
    throw new ReliabilityError('COMMAND_NOT_FOUND', '指令不存在', 404)
  }
  if (command.expiresAt.getTime() < Date.now() && !TERMINAL.includes(command.status as CommandStatus)) {
    await prisma.reliabilityCommand.update({
      where: { commandId: input.commandId },
      data: { status: 'EXPIRED', errorCode: 'COMMAND_EXPIRED', completedAt: new Date() },
    })
    throw new ReliabilityError('COMMAND_EXPIRED', '指令已过期', 410)
  }
  // 幂等：已到终态的指令不再被回执改写。
  if (TERMINAL.includes(command.status as CommandStatus)) {
    return {
      action: command.action as CommandAction,
      payload: safeParse(command.payloadJson),
    }
  }

  const now = input.occurredAt ? new Date(input.occurredAt) : new Date()
  const data: Record<string, unknown> = { status: input.status }
  if (input.status === 'RECEIVED') data.receivedAt = now
  if (input.status === 'RUNNING') data.startedAt = now
  if (input.status === 'SUCCEEDED' || input.status === 'FAILED') data.completedAt = now
  if (input.result) data.resultJson = JSON.stringify(input.result)
  if (input.error) {
    data.errorCode = input.error.code || 'CLIENT_ERROR'
    data.errorMessage = input.error.message || null
  }

  await prisma.reliabilityCommand.update({
    where: { commandId: input.commandId },
    data,
  })
  return {
    action: command.action as CommandAction,
    payload: safeParse(command.payloadJson),
  }
}

function safeParse(json: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 长轮询取下一条待投递指令（IF-N07）。 */
export async function claimNextCommand(clientId: string): Promise<CommandFrame | null> {
  const command = await prisma.reliabilityCommand.findFirst({
    where: {
      clientId,
      status: 'CREATED',
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'asc' },
  })
  if (!command) return null
  await markSent(command.commandId, 'poll')
  return {
    type: 'COMMAND',
    commandId: command.commandId,
    action: command.action as CommandAction,
    createdAt: command.createdAt.toISOString(),
    expiresAt: command.expiresAt.toISOString(),
    payload: safeParse(command.payloadJson),
  }
}

export async function getCommand(commandId: string) {
  return prisma.reliabilityCommand.findUnique({ where: { commandId } })
}
