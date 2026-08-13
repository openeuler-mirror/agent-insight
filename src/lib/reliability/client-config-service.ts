/**
 * 客户端配置中心（IF-N10/N11/N12/N17），Prisma 存储。
 *
 * 状态权威来源分工 —— 服务端不得代客户端确认：
 *   saved / sync_notified / notify_failed  ← 服务端
 *   pulling                                ← 客户端 GET config-snapshots
 *   written                                ← 客户端 COMMAND_STATUS SUCCEEDED(WRITTEN)
 *   ras_loaded                             ← RAS POST config-loads
 */
import { createHash, randomBytes } from 'node:crypto'

import { prisma } from '@/lib/storage/prisma'
import {
  applyOverrideDiff,
  buildBuiltinConfigSchema,
  buildFieldSources,
  deleteOverridePath,
  flatConfigToCapabilityBody,
  isReliabilityPlatformId,
  nestEffectiveConfig,
  type ReliabilityPlatformId,
} from '@/lib/reliability/client-config-model'
import {
  isRasCapabilityPlatformId,
  platformSupportsSync,
  type RasCapabilityConfigEnvelope,
} from '@/lib/ingest/ras/capability-config'
import {
  getCapabilityEnvelope,
  saveCapabilityEnvelope,
} from '@/lib/ingest/ras/capability-config-store'
import {
  ReliabilityError,
  deriveStatus,
  requireOwnedClient,
} from '@/lib/reliability/client-registry'
import {
  createCommand,
  markSent,
  sweepUnackedCommands,
} from '@/lib/reliability/command-bus'
import { isConnected } from '@/lib/reliability/control-hub'
import { dispatchCommand } from '@/lib/reliability/control-dispatch'

export type DeliveryStatus =
  | 'saved'
  | 'sync_notified'
  | 'pulling'
  | 'written'
  | 'ras_loaded'
  | 'notify_failed'
  | 'pull_failed'
  | 'write_failed'
  | 'load_failed'
  | 'version_mismatch'

export type ConfigDelivery = {
  deliveryId: string | null
  configRef: string | null
  configVersion: string | null
  checksum: string | null
  commandId: string | null
  status: DeliveryStatus
  pulledAt: string | null
  writtenAt: string | null
  loadedAt: string | null
  error: { code: string; message: string } | null
}

const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(5).toString('hex')}`
}

function checksumOf(config: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(config)).digest('hex')}`
}

function requirePlatform(platform: string): ReliabilityPlatformId {
  if (!isReliabilityPlatformId(platform)) {
    throw new ReliabilityError('PLATFORM_SCHEMA_NOT_FOUND', `未知平台: ${platform}`, 404)
  }
  return platform
}

function emptyDelivery(): ConfigDelivery {
  return {
    deliveryId: null,
    configRef: null,
    configVersion: null,
    checksum: null,
    commandId: null,
    status: 'saved',
    pulledAt: null,
    writtenAt: null,
    loadedAt: null,
    error: null,
  }
}

type DeliveryRow = {
  deliveryId: string
  configRef: string
  configVersion: string
  checksum: string
  commandId: string | null
  status: string
  pulledAt: Date | null
  writtenAt: Date | null
  loadedAt: Date | null
  errorCode: string | null
  errorMessage: string | null
}

function toDelivery(row: DeliveryRow | null): ConfigDelivery {
  if (!row) return emptyDelivery()
  return {
    deliveryId: row.deliveryId,
    configRef: row.configRef,
    configVersion: row.configVersion,
    checksum: row.checksum,
    commandId: row.commandId,
    status: row.status as DeliveryStatus,
    pulledAt: row.pulledAt ? row.pulledAt.toISOString() : null,
    writtenAt: row.writtenAt ? row.writtenAt.toISOString() : null,
    loadedAt: row.loadedAt ? row.loadedAt.toISOString() : null,
    error: row.errorCode
      ? { code: row.errorCode, message: row.errorMessage || row.errorCode }
      : null,
  }
}

async function latestDelivery(clientId: string, platform: string) {
  return prisma.reliabilityConfigDelivery.findFirst({
    where: { clientId, platform },
    orderBy: { createdAt: 'desc' },
  })
}

async function getOrInitConfig(user: string, clientId: string, platform: ReliabilityPlatformId) {
  const existing = await prisma.reliabilityClientConfig.findUnique({
    where: { clientId_platform: { clientId, platform } },
  })
  if (existing) return existing
  return prisma.reliabilityClientConfig.create({
    data: { clientId, user, platform, revision: 0, overrideJson: '{}' },
  })
}

function parseOverride(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export async function getClientConfigView(user: string, clientId: string, platformRaw: string) {
  const platform = requirePlatform(platformRaw)
  await requireOwnedClient(user, clientId)
  await sweepUnackedCommands(user)

  const schema = buildBuiltinConfigSchema(platform)
  const cfg = await getOrInitConfig(user, clientId, platform)
  const override = parseOverride(cfg.overrideJson)
  const effectiveFlat = applyOverrideDiff(schema.defaults, override)
  const delivery = await reconcileDelivery(await latestDelivery(clientId, platform))

  return {
    clientId,
    platform,
    schemaVersion: cfg.schemaVersion,
    builtinConfigVersion: schema.configVersion,
    revision: cfg.revision,
    overrideDiff: { ...override },
    effectiveConfig: nestEffectiveConfig(effectiveFlat),
    fieldSources: buildFieldSources(schema.defaults, override),
    delivery,
  }
}

/**
 * 指令投递失败会把 delivery 从 sync_notified 落到 notify_failed —— 这一步必须发生在
 * 读取时，否则页面会一直停在「已通知」，而实际上指令早已 ACK 超时。
 */
async function reconcileDelivery(row: DeliveryRow | null): Promise<ConfigDelivery> {
  if (!row || !row.commandId) return toDelivery(row)
  if (row.status !== 'sync_notified') return toDelivery(row)
  const command = await prisma.reliabilityCommand.findUnique({
    where: { commandId: row.commandId },
  })
  if (!command) return toDelivery(row)
  if (command.status === 'DELIVERY_FAILED' || command.status === 'EXPIRED') {
    const updated = await prisma.reliabilityConfigDelivery.update({
      where: { deliveryId: row.deliveryId },
      data: {
        status: 'notify_failed',
        errorCode: command.errorCode || 'ACK_TIMEOUT',
        errorMessage: command.errorMessage || '客户端未确认接收指令',
      },
    })
    return toDelivery(updated)
  }
  return toDelivery(row)
}

/**
 * 兼容既有 RAS 拉取通道（/api/ingest/ras-config）：把生效配置发布到 user × platform 的 capability envelope。
 * 严禁跨平台写入——只更新入参 platform。
 */
export function publishClientConfigToCapabilityPullPath(input: {
  user: string
  platform: ReliabilityPlatformId
  effectiveFlat: Record<string, unknown>
}): void {
  if (!isRasCapabilityPlatformId(input.platform)) return
  if (!platformSupportsSync(input.platform)) return

  const body = flatConfigToCapabilityBody(input.effectiveFlat)
  // xiaoO 强制关闭语义内容检测（既有 ingest 约定）。
  const loop = body.detectors.llm_thinking_loop
  if (input.platform === 'xiaoo' && loop) {
    loop.semantic_content_enabled = false
  }

  const existing = getCapabilityEnvelope(input.user, input.platform)
  const next: RasCapabilityConfigEnvelope = {
    platform: input.platform,
    syncEnabled: true,
    revision: (existing.revision || 0) + 1,
    updatedAt: new Date().toISOString(),
    config: body,
    platformExtras: existing.platformExtras,
  }
  saveCapabilityEnvelope(input.user, next)
}

async function freezeSnapshot(input: {
  user: string
  clientId: string
  platform: ReliabilityPlatformId
  effectiveFlat: Record<string, unknown>
  scope?: 'client' | 'experiment'
  correlation?: Record<string, unknown>
  expiresAt?: Date
}) {
  const configRef = newId('cfgref')
  const configVersion = newId('cfg')
  const nested = nestEffectiveConfig(input.effectiveFlat)
  const capability = flatConfigToCapabilityBody(input.effectiveFlat)
  const config = { ...nested, capability }
  const checksum = checksumOf(config)

  await prisma.reliabilityConfigSnapshot.create({
    data: {
      configRef,
      clientId: input.clientId,
      user: input.user,
      platform: input.platform,
      scope: input.scope || 'client',
      configVersion,
      checksum,
      configJson: JSON.stringify(config),
      correlationJson: input.correlation ? JSON.stringify(input.correlation) : null,
      expiresAt: input.expiresAt || new Date(Date.now() + SNAPSHOT_TTL_MS),
    },
  })
  return { configRef, configVersion, checksum }
}

export type PutClientConfigResult = {
  revision: number
  status: DeliveryStatus
  saved?: boolean
  configRef?: string
  configVersion?: string
  checksum?: string
  deliveryId?: string
  commandId?: string
  sync?: { status: 'failed'; error: { code: string; message: string } }
  httpStatus: number
}

/**
 * 通知客户端同步：冻结快照 → 建指令 → 经 WSS 投递。
 * 状态只到 sync_notified —— 拉取与写入由客户端回执推进。
 */
async function notifyClientSync(input: {
  user: string
  clientId: string
  platform: ReliabilityPlatformId
  configRef: string
  configVersion: string
  checksum: string
  online: boolean
}): Promise<{ delivery: ConfigDelivery; commandId: string | null }> {
  const deliveryId = newId('delivery')

  if (!input.online) {
    // 保存不回滚，但不排队等待重连（需求文档 §6.2）。
    const row = await prisma.reliabilityConfigDelivery.create({
      data: {
        deliveryId,
        clientId: input.clientId,
        user: input.user,
        platform: input.platform,
        configRef: input.configRef,
        configVersion: input.configVersion,
        checksum: input.checksum,
        status: 'notify_failed',
        errorCode: 'CLIENT_OFFLINE',
        errorMessage: '配置已保存，但客户端离线，未通知同步',
      },
    })
    return { delivery: toDelivery(row), commandId: null }
  }

  const frame = await createCommand({
    user: input.user,
    clientId: input.clientId,
    action: 'APPLY_CLIENT_CONFIG',
    payload: {
      platform: input.platform,
      scope: 'client',
      configRef: input.configRef,
      configVersion: input.configVersion,
      checksum: input.checksum,
    },
  })

  const sent = await dispatchCommand(input.clientId, frame)
  if (sent.delivered) {
    await markSent(frame.commandId, 'wss')
  }

  const row = await prisma.reliabilityConfigDelivery.create({
    data: {
      deliveryId,
      clientId: input.clientId,
      user: input.user,
      platform: input.platform,
      configRef: input.configRef,
      configVersion: input.configVersion,
      checksum: input.checksum,
      commandId: frame.commandId,
      // 未经 socket 投递也留在 sync_notified：客户端可能走长轮询取指令。
      status: 'sync_notified',
    },
  })
  return { delivery: toDelivery(row), commandId: frame.commandId }
}

/**
 * 客户端能否收到指令。
 *
 * WSS 已连当然能收；**但 WSS 不是唯一通道** —— 部署形态若不带控制网关
 * （如 start.sh 直接跑 Next standalone），客户端会自动降级到 IF-N07 长轮询。
 * 这时只要心跳新鲜，指令照样能被取走，不该判定为离线。
 * 只用 isConnected() 把关会让这类部署永远无法下发配置。
 */
function canReceiveCommands(
  client: { status: string; lastSeenAt: Date },
  clientId: string,
): boolean {
  if (isConnected(clientId)) return true
  return deriveStatus(client) === 'online'
}

export async function putClientConfig(input: {
  user: string
  clientId: string
  platform: string
  overrideDiff?: Record<string, unknown>
  expectedRevision?: number
  sync?: boolean
}): Promise<PutClientConfigResult> {
  const platform = requirePlatform(input.platform)
  const client = await requireOwnedClient(input.user, input.clientId)
  const schema = buildBuiltinConfigSchema(platform)
  const cfg = await getOrInitConfig(input.user, input.clientId, platform)

  if (
    input.expectedRevision != null &&
    Number.isFinite(input.expectedRevision) &&
    Number(input.expectedRevision) !== cfg.revision
  ) {
    throw new ReliabilityError('CONFIG_REVISION_CONFLICT', '配置版本冲突', 409, {
      revision: cfg.revision,
    })
  }

  const nextOverride =
    input.overrideDiff && typeof input.overrideDiff === 'object' && !Array.isArray(input.overrideDiff)
      ? { ...input.overrideDiff }
      : parseOverride(cfg.overrideJson)

  const updated = await prisma.reliabilityClientConfig.update({
    where: { clientId_platform: { clientId: input.clientId, platform } },
    data: { overrideJson: JSON.stringify(nextOverride), revision: { increment: 1 } },
  })

  const effectiveFlat = applyOverrideDiff(schema.defaults, nextOverride)

  if (input.sync !== true) {
    return { revision: updated.revision, status: 'saved', saved: true, httpStatus: 200 }
  }

  // 兼容通道：RAS 走 /api/ingest/ras-config 主动拉取时读到的是这份。
  publishClientConfigToCapabilityPullPath({ user: input.user, platform, effectiveFlat })

  const frozen = await freezeSnapshot({
    user: input.user,
    clientId: input.clientId,
    platform,
    effectiveFlat,
  })
  const online = canReceiveCommands(client, input.clientId)
  const { delivery, commandId } = await notifyClientSync({
    user: input.user,
    clientId: input.clientId,
    platform,
    ...frozen,
    online,
  })

  if (delivery.status === 'notify_failed') {
    return {
      revision: updated.revision,
      status: 'notify_failed',
      saved: true,
      configRef: frozen.configRef,
      configVersion: frozen.configVersion,
      checksum: frozen.checksum,
      deliveryId: delivery.deliveryId || undefined,
      httpStatus: 200,
      sync: {
        status: 'failed',
        error: delivery.error || { code: 'CLIENT_OFFLINE', message: '客户端离线' },
      },
    }
  }

  return {
    revision: updated.revision,
    status: delivery.status,
    configRef: frozen.configRef,
    configVersion: frozen.configVersion,
    checksum: frozen.checksum,
    deliveryId: delivery.deliveryId || undefined,
    commandId: commandId || undefined,
    httpStatus: 202,
  }
}

export async function deleteClientConfig(input: {
  user: string
  clientId: string
  platform: string
  path?: string | null
  sync?: boolean
}): Promise<PutClientConfigResult> {
  const platform = requirePlatform(input.platform)
  await requireOwnedClient(input.user, input.clientId)
  const cfg = await getOrInitConfig(input.user, input.clientId, platform)
  const nextOverride = deleteOverridePath(parseOverride(cfg.overrideJson), input.path)
  return putClientConfig({
    user: input.user,
    clientId: input.clientId,
    platform,
    overrideDiff: nextOverride,
    expectedRevision: cfg.revision,
    sync: input.sync === true,
  })
}

/** 复用已冻结的快照重新通知，不产生新的配置 revision。 */
export async function syncClientConfig(input: {
  user: string
  clientId: string
  platform: string
  configRef?: string
}): Promise<PutClientConfigResult> {
  const platform = requirePlatform(input.platform)
  const client = await requireOwnedClient(input.user, input.clientId)
  const cfg = await getOrInitConfig(input.user, input.clientId, platform)
  const previous = await latestDelivery(input.clientId, platform)
  const configRef = String(input.configRef || previous?.configRef || '').trim()
  if (!configRef) {
    throw new ReliabilityError('CONFIG_SNAPSHOT_NOT_FOUND', '没有可用的配置快照', 404)
  }
  const snapshot = await prisma.reliabilityConfigSnapshot.findUnique({ where: { configRef } })
  if (!snapshot) {
    throw new ReliabilityError('CONFIG_SNAPSHOT_NOT_FOUND', '配置快照不存在', 404)
  }
  if (snapshot.clientId !== input.clientId || snapshot.user !== input.user) {
    throw new ReliabilityError('CONFIG_SNAPSHOT_FORBIDDEN', '配置快照不属于该客户端', 403)
  }
  if (snapshot.platform !== platform) {
    throw new ReliabilityError('CONFIG_SNAPSHOT_PLATFORM_MISMATCH', '配置快照平台不匹配', 409)
  }
  if (!canReceiveCommands(client, input.clientId)) {
    throw new ReliabilityError('CLIENT_OFFLINE', '客户端离线，无法通知同步', 503)
  }

  const { delivery, commandId } = await notifyClientSync({
    user: input.user,
    clientId: input.clientId,
    platform,
    configRef: snapshot.configRef,
    configVersion: snapshot.configVersion,
    checksum: snapshot.checksum,
    online: true,
  })

  return {
    revision: cfg.revision,
    status: delivery.status,
    configRef: snapshot.configRef,
    configVersion: snapshot.configVersion,
    checksum: snapshot.checksum,
    deliveryId: delivery.deliveryId || undefined,
    commandId: commandId || undefined,
    httpStatus: 202,
  }
}

/** IF-N17：客户端按 configRef 拉取；拉取动作本身把 delivery 推进到 pulling。 */
export async function getConfigSnapshot(input: {
  clientId: string
  configRef: string
}) {
  const snapshot = await prisma.reliabilityConfigSnapshot.findUnique({
    where: { configRef: input.configRef },
  })
  if (!snapshot) {
    throw new ReliabilityError('CONFIG_SNAPSHOT_NOT_FOUND', '配置快照不存在', 404)
  }
  if (snapshot.clientId !== input.clientId) {
    throw new ReliabilityError('CONFIG_SNAPSHOT_FORBIDDEN', '配置快照不属于该客户端', 403)
  }
  if (snapshot.expiresAt.getTime() < Date.now()) {
    throw new ReliabilityError('CONFIG_SNAPSHOT_EXPIRED', '配置快照已过期', 410)
  }

  await prisma.reliabilityConfigDelivery.updateMany({
    where: {
      clientId: input.clientId,
      configRef: input.configRef,
      status: { in: ['sync_notified', 'notify_failed'] },
    },
    data: { status: 'pulling', pulledAt: new Date() },
  })

  return {
    configRef: snapshot.configRef,
    clientId: snapshot.clientId,
    platform: snapshot.platform,
    scope: snapshot.scope,
    schemaVersion: snapshot.schemaVersion,
    configVersion: snapshot.configVersion,
    checksum: snapshot.checksum,
    correlation: snapshot.correlationJson ? JSON.parse(snapshot.correlationJson) : undefined,
    expiresAt: snapshot.expiresAt.toISOString(),
    config: JSON.parse(snapshot.configJson),
  }
}

/** 客户端回执 SUCCEEDED(WRITTEN) 时调用 —— 这是 written 的唯一来源。 */
export async function markDeliveryWritten(input: {
  clientId: string
  configRef: string
  checksum?: string
}): Promise<void> {
  await prisma.reliabilityConfigDelivery.updateMany({
    where: { clientId: input.clientId, configRef: input.configRef },
    data: { status: 'written', writtenAt: new Date(), errorCode: null, errorMessage: null },
  })
}

export async function markDeliveryFailed(input: {
  clientId: string
  configRef: string
  stage: 'pull' | 'write'
  code?: string
  message?: string
}): Promise<void> {
  await prisma.reliabilityConfigDelivery.updateMany({
    where: { clientId: input.clientId, configRef: input.configRef },
    data: {
      status: input.stage === 'pull' ? 'pull_failed' : 'write_failed',
      errorCode: input.code || (input.stage === 'pull' ? 'PULL_FAILED' : 'WRITE_FAILED'),
      errorMessage: input.message || null,
    },
  })
}

/** IF-N12：RAS 加载回报 —— ras_loaded 的唯一来源。 */
export async function recordConfigLoad(input: {
  user: string
  clientId: string
  platform: string
  scope?: string
  configVersion: string
  checksum?: string
  rasProcessId?: string
  status: 'loaded' | 'failed' | 'version_mismatch'
  loadedAt?: string
  error?: { code?: string; message?: string }
}): Promise<{ deliveryStatus: DeliveryStatus }> {
  const platform = requirePlatform(input.platform)
  await requireOwnedClient(input.user, input.clientId)
  const loadedAt = input.loadedAt ? new Date(input.loadedAt) : new Date()

  await prisma.reliabilityConfigLoad.create({
    data: {
      clientId: input.clientId,
      user: input.user,
      platform,
      scope: input.scope || 'client',
      configVersion: input.configVersion,
      checksum: input.checksum || null,
      rasProcessId: input.rasProcessId || null,
      status: input.status,
      errorCode: input.error?.code || null,
      errorMessage: input.error?.message || null,
      loadedAt,
    },
  })

  const delivery = await latestDelivery(input.clientId, platform)
  if (!delivery) return { deliveryStatus: 'saved' }

  if (delivery.configVersion && delivery.configVersion !== input.configVersion) {
    await prisma.reliabilityConfigDelivery.update({
      where: { deliveryId: delivery.deliveryId },
      data: {
        status: 'version_mismatch',
        errorCode: 'VERSION_MISMATCH',
        errorMessage: 'RAS 回报的 configVersion 与当前 delivery 不一致',
      },
    })
    return { deliveryStatus: 'version_mismatch' }
  }

  let status: DeliveryStatus
  const data: Record<string, unknown> = {}
  if (input.status === 'loaded') {
    status = 'ras_loaded'
    data.loadedAt = loadedAt
    data.errorCode = null
    data.errorMessage = null
  } else if (input.status === 'version_mismatch') {
    status = 'version_mismatch'
    data.errorCode = input.error?.code || 'VERSION_MISMATCH'
    data.errorMessage = input.error?.message || 'RAS 回报版本不一致'
  } else {
    status = 'load_failed'
    data.errorCode = input.error?.code || 'LOAD_FAILED'
    data.errorMessage = input.error?.message || 'RAS 加载配置失败'
  }
  await prisma.reliabilityConfigDelivery.update({
    where: { deliveryId: delivery.deliveryId },
    data: { ...data, status },
  })
  return { deliveryStatus: status }
}

/**
 * 客户端经 /api/ingest/ras-config?platform= 拉取时：仅推进该 platform 的 delivery 到 pulling。
 * 兼容路径 —— 该通道没有 configRef，因此只能表示「拉走了」，不能推进到 written。
 */
export async function noteCapabilityIngestPull(user: string, platformRaw: string): Promise<void> {
  if (!isReliabilityPlatformId(platformRaw)) return
  await prisma.reliabilityConfigDelivery.updateMany({
    where: { user, platform: platformRaw, status: 'sync_notified' },
    data: { status: 'pulling', pulledAt: new Date() },
  })
}
