/**
 * Reliability client + config control plane (IF-N09/N11/N12/N17).
 * File-backed per user; clients can be upserted from FI Worker heartbeats.
 */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { resolveAgentInsightDataPath } from '@/lib/env'
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

export type ReliabilityClientPlatform = {
  id: string
  version?: string
  models?: string[]
}

export type ReliabilityClientRecord = {
  id: string
  user: string
  name: string
  hostname: string | null
  reportedIp: string | null
  observedIp: string | null
  os: string | null
  arch: string | null
  status: 'online' | 'offline'
  serviceHealth: 'healthy' | 'unknown' | 'degraded'
  processStartedAt: string | null
  restartCount: number
  lastSeenAt: string
  agentVersion: string | null
  platforms: ReliabilityClientPlatform[]
  workerId?: string | null
}

export type ConfigDelivery = {
  configRef: string | null
  configVersion: string | null
  checksum: string | null
  deliveryId: string | null
  commandId: string | null
  status: DeliveryStatus
  pulledAt: string | null
  writtenAt: string | null
  loadedAt: string | null
  error: { code: string; message: string } | null
}

export type ClientPlatformConfig = {
  revision: number
  schemaVersion: string
  overrideDiff: Record<string, unknown>
  updatedAt: string
  delivery: ConfigDelivery
}

export type ConfigSnapshot = {
  configRef: string
  clientId: string
  user: string
  platform: ReliabilityPlatformId
  scope: 'client' | 'experiment'
  schemaVersion: string
  configVersion: string
  checksum: string
  config: Record<string, unknown>
  expiresAt: string
  createdAt: string
  correlation?: Record<string, unknown>
}

type UserStoreFile = {
  clients: Record<string, ReliabilityClientRecord>
  configs: Record<string, Record<string, ClientPlatformConfig>>
  snapshots: Record<string, ConfigSnapshot>
}

let testBaseDir: string | undefined

export function resetClientConfigStoreForTests(baseDir?: string) {
  testBaseDir = baseDir
}

function sanitizeUserKey(user: string): string {
  return user.replace(/[^a-zA-Z0-9._@-]/g, '_').slice(0, 128) || 'anonymous'
}

function storeRoot(): string {
  return testBaseDir ?? resolveAgentInsightDataPath('reliability-control')
}

function storePath(user: string): string {
  return path.join(storeRoot(), `${sanitizeUserKey(user)}.json`)
}

function emptyStore(): UserStoreFile {
  return { clients: {}, configs: {}, snapshots: {} }
}

function readStore(user: string): UserStoreFile {
  const file = storePath(user)
  try {
    if (!fs.existsSync(file)) return emptyStore()
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as UserStoreFile
    return {
      clients: raw.clients && typeof raw.clients === 'object' ? raw.clients : {},
      configs: raw.configs && typeof raw.configs === 'object' ? raw.configs : {},
      snapshots: raw.snapshots && typeof raw.snapshots === 'object' ? raw.snapshots : {},
    }
  } catch {
    return emptyStore()
  }
}

function writeStore(user: string, data: UserStoreFile): void {
  const file = storePath(user)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
}

function checksumOf(config: unknown): string {
  const hash = createHash('sha256').update(JSON.stringify(config)).digest('hex')
  return `sha256:${hash}`
}

function emptyDelivery(): ConfigDelivery {
  return {
    configRef: null,
    configVersion: null,
    checksum: null,
    deliveryId: null,
    commandId: null,
    status: 'saved',
    pulledAt: null,
    writtenAt: null,
    loadedAt: null,
    error: null,
  }
}

function clientIdFromWorker(workerId: string): string {
  const safe = workerId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48)
  return `cli_worker_${safe}`
}

export function upsertReliabilityClientFromWorker(input: {
  user: string
  workerId: string
  hostname?: string | null
  reportedIp?: string | null
  observedIp?: string | null
  lastSeenAt: string
  platforms: ReliabilityClientPlatform[]
  online: boolean
  agentVersion?: string | null
}): ReliabilityClientRecord {
  const store = readStore(input.user)
  const id = clientIdFromWorker(input.workerId)
  const existing = store.clients[id]
  const reportedIp = input.reportedIp || existing?.reportedIp || null
  const hostname = input.hostname || existing?.hostname || null
  const record: ReliabilityClientRecord = {
    id,
    user: input.user,
    name: reportedIp ? `主机-${reportedIp}` : hostname || id,
    hostname,
    reportedIp,
    observedIp: input.observedIp ?? existing?.observedIp ?? null,
    os: existing?.os ?? null,
    arch: existing?.arch ?? null,
    status: input.online ? 'online' : 'offline',
    serviceHealth: input.online ? 'healthy' : 'unknown',
    processStartedAt: existing?.processStartedAt ?? null,
    restartCount: existing?.restartCount ?? 0,
    lastSeenAt: input.lastSeenAt,
    agentVersion: input.agentVersion ?? existing?.agentVersion ?? null,
    platforms: input.platforms.length ? input.platforms : existing?.platforms || [],
    workerId: input.workerId,
  }
  store.clients[id] = record
  writeStore(input.user, store)
  return record
}

export function listReliabilityClientsForUser(
  user: string,
  opts?: { page?: number; pageSize?: number; status?: string; keyword?: string },
): { items: ReliabilityClientRecord[]; page: number; pageSize: number; total: number } {
  const store = readStore(user)
  let items = Object.values(store.clients)
  const status = String(opts?.status || '').trim()
  if (status === 'online' || status === 'offline') {
    items = items.filter((item) => item.status === status)
  }
  const keyword = String(opts?.keyword || '').trim().toLowerCase()
  if (keyword) {
    items = items.filter((item) => {
      const hay = [item.reportedIp, item.hostname, item.name, item.id]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(keyword)
    })
  }
  items.sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
  const page = Math.max(1, Number(opts?.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(opts?.pageSize) || 20))
  const total = items.length
  const start = (page - 1) * pageSize
  return { items: items.slice(start, start + pageSize), page, pageSize, total }
}

function requireClient(store: UserStoreFile, clientId: string): ReliabilityClientRecord {
  const client = store.clients[clientId]
  if (!client) {
    const err = new Error('CLIENT_NOT_FOUND') as Error & { code: string; status: number }
    err.code = 'CLIENT_NOT_FOUND'
    err.status = 404
    throw err
  }
  return client
}

function getOrInitConfig(
  store: UserStoreFile,
  clientId: string,
  platform: ReliabilityPlatformId,
): ClientPlatformConfig {
  if (!store.configs[clientId]) store.configs[clientId] = {}
  const existing = store.configs[clientId][platform]
  if (existing) return existing
  const created: ClientPlatformConfig = {
    revision: 0,
    schemaVersion: '1.0',
    overrideDiff: {},
    updatedAt: new Date().toISOString(),
    delivery: emptyDelivery(),
  }
  store.configs[clientId][platform] = created
  return created
}

export function getClientConfigView(user: string, clientId: string, platformRaw: string) {
  if (!isReliabilityPlatformId(platformRaw)) {
    const err = new Error('PLATFORM_SCHEMA_NOT_FOUND') as Error & { code: string; status: number }
    err.code = 'PLATFORM_SCHEMA_NOT_FOUND'
    err.status = 404
    throw err
  }
  const store = readStore(user)
  requireClient(store, clientId)
  const schema = buildBuiltinConfigSchema(platformRaw)
  const cfg = getOrInitConfig(store, clientId, platformRaw)
  const effectiveFlat = applyOverrideDiff(schema.defaults, cfg.overrideDiff)
  return {
    clientId,
    platform: platformRaw,
    schemaVersion: cfg.schemaVersion,
    builtinConfigVersion: schema.configVersion,
    revision: cfg.revision,
    overrideDiff: { ...cfg.overrideDiff },
    effectiveConfig: nestEffectiveConfig(effectiveFlat),
    fieldSources: buildFieldSources(schema.defaults, cfg.overrideDiff),
    delivery: { ...cfg.delivery },
  }
}

/**
 * 本轮无 WSS：把「保存并同步」桥到客户端真实拉取通道（user × platform 的 ras-capability）。
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
  if (input.platform === 'xiaoo') {
    for (const detector of Object.values(body.detectors)) {
      if (detector && Object.prototype.hasOwnProperty.call(detector, 'semantic_content_enabled')) {
        detector.semantic_content_enabled = false
      }
    }
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

function freezeSnapshot(input: {
  store: UserStoreFile
  user: string
  clientId: string
  platform: ReliabilityPlatformId
  effectiveFlat: Record<string, unknown>
}): { configRef: string; configVersion: string; checksum: string; deliveryId: string; commandId: string } {
  const configRef = newId('cfgref')
  const configVersion = newId('cfg')
  const nested = nestEffectiveConfig(input.effectiveFlat)
  const capability = flatConfigToCapabilityBody(input.effectiveFlat)
  const config = { ...nested, capability }
  const checksum = checksumOf(config)
  const snapshot: ConfigSnapshot = {
    configRef,
    clientId: input.clientId,
    user: input.user,
    platform: input.platform,
    scope: 'client',
    schemaVersion: '1.0',
    configVersion,
    checksum,
    config,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  }
  input.store.snapshots[configRef] = snapshot
  return {
    configRef,
    configVersion,
    checksum,
    deliveryId: newId('delivery'),
    commandId: newId('cmd'),
  }
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

export function putClientConfig(input: {
  user: string
  clientId: string
  platform: string
  overrideDiff?: Record<string, unknown>
  expectedRevision?: number
  sync?: boolean
}): PutClientConfigResult {
  if (!isReliabilityPlatformId(input.platform)) {
    const err = new Error('PLATFORM_SCHEMA_NOT_FOUND') as Error & { code: string; status: number }
    err.code = 'PLATFORM_SCHEMA_NOT_FOUND'
    err.status = 404
    throw err
  }
  const store = readStore(input.user)
  const client = requireClient(store, input.clientId)
  const schema = buildBuiltinConfigSchema(input.platform)
  const cfg = getOrInitConfig(store, input.clientId, input.platform)

  if (
    input.expectedRevision != null
    && Number.isFinite(input.expectedRevision)
    && Number(input.expectedRevision) !== cfg.revision
  ) {
    const err = new Error('CONFIG_REVISION_CONFLICT') as Error & {
      code: string
      status: number
      revision: number
    }
    err.code = 'CONFIG_REVISION_CONFLICT'
    err.status = 409
    err.revision = cfg.revision
    throw err
  }

  const nextOverride =
    input.overrideDiff && typeof input.overrideDiff === 'object' && !Array.isArray(input.overrideDiff)
      ? { ...input.overrideDiff }
      : { ...cfg.overrideDiff }

  cfg.overrideDiff = nextOverride
  cfg.revision += 1
  cfg.updatedAt = new Date().toISOString()

  const effectiveFlat = applyOverrideDiff(schema.defaults, cfg.overrideDiff)
  const wantSync = input.sync === true

  if (!wantSync) {
    cfg.delivery = {
      ...emptyDelivery(),
      status: 'saved',
    }
    writeStore(input.user, store)
    return { revision: cfg.revision, status: 'saved', saved: true, httpStatus: 200 }
  }

  const frozen = freezeSnapshot({
    store,
    user: input.user,
    clientId: input.clientId,
    platform: input.platform,
    effectiveFlat,
  })

  if (client.status !== 'online') {
    publishClientConfigToCapabilityPullPath({
      user: input.user,
      platform: input.platform,
      effectiveFlat,
    })
    cfg.delivery = {
      configRef: frozen.configRef,
      configVersion: frozen.configVersion,
      checksum: frozen.checksum,
      deliveryId: frozen.deliveryId,
      commandId: frozen.commandId,
      status: 'notify_failed',
      pulledAt: null,
      writtenAt: null,
      loadedAt: null,
      error: {
        code: 'CLIENT_OFFLINE',
        message: '配置已保存并写入拉取通道，但客户端离线，未推送通知',
      },
    }
    writeStore(input.user, store)
    return {
      revision: cfg.revision,
      status: 'notify_failed',
      saved: true,
      configVersion: frozen.configVersion,
      checksum: frozen.checksum,
      httpStatus: 200,
      sync: {
        status: 'failed',
        error: {
          code: 'CLIENT_OFFLINE',
          message: '配置已保存并写入拉取通道，但客户端离线，未推送通知',
        },
      },
    }
  }

  // 无 WSS：发布到 ras-config 拉取通道后标 written（待插件启动合并 / RAS 加载回报）。
  publishClientConfigToCapabilityPullPath({
    user: input.user,
    platform: input.platform,
    effectiveFlat,
  })
  const nowIso = new Date().toISOString()
  cfg.delivery = {
    configRef: frozen.configRef,
    configVersion: frozen.configVersion,
    checksum: frozen.checksum,
    deliveryId: frozen.deliveryId,
    commandId: frozen.commandId,
    status: 'written',
    pulledAt: nowIso,
    writtenAt: nowIso,
    loadedAt: null,
    error: null,
  }
  writeStore(input.user, store)
  return {
    revision: cfg.revision,
    status: 'written',
    configRef: frozen.configRef,
    configVersion: frozen.configVersion,
    checksum: frozen.checksum,
    deliveryId: frozen.deliveryId,
    commandId: frozen.commandId,
    httpStatus: 202,
  }
}

export function deleteClientConfig(input: {
  user: string
  clientId: string
  platform: string
  path?: string | null
  sync?: boolean
}): PutClientConfigResult {
  if (!isReliabilityPlatformId(input.platform)) {
    const err = new Error('PLATFORM_SCHEMA_NOT_FOUND') as Error & { code: string; status: number }
    err.code = 'PLATFORM_SCHEMA_NOT_FOUND'
    err.status = 404
    throw err
  }
  const store = readStore(input.user)
  requireClient(store, input.clientId)
  const cfg = getOrInitConfig(store, input.clientId, input.platform)
  const nextOverride = deleteOverridePath(cfg.overrideDiff, input.path)
  return putClientConfig({
    user: input.user,
    clientId: input.clientId,
    platform: input.platform,
    overrideDiff: nextOverride,
    expectedRevision: cfg.revision,
    sync: input.sync === true,
  })
}

export function syncClientConfig(input: {
  user: string
  clientId: string
  platform: string
  configRef?: string
}): PutClientConfigResult {
  if (!isReliabilityPlatformId(input.platform)) {
    const err = new Error('PLATFORM_SCHEMA_NOT_FOUND') as Error & { code: string; status: number }
    err.code = 'PLATFORM_SCHEMA_NOT_FOUND'
    err.status = 404
    throw err
  }
  const store = readStore(input.user)
  const client = requireClient(store, input.clientId)
  const cfg = getOrInitConfig(store, input.clientId, input.platform)
  const configRef = String(input.configRef || cfg.delivery.configRef || '').trim()
  if (!configRef || !store.snapshots[configRef]) {
    const err = new Error('CONFIG_SNAPSHOT_NOT_FOUND') as Error & { code: string; status: number }
    err.code = 'CONFIG_SNAPSHOT_NOT_FOUND'
    err.status = 404
    throw err
  }
  const snapshot = store.snapshots[configRef]
  if (snapshot.clientId !== input.clientId) {
    const err = new Error('CONFIG_SNAPSHOT_FORBIDDEN') as Error & { code: string; status: number }
    err.code = 'CONFIG_SNAPSHOT_FORBIDDEN'
    err.status = 403
    throw err
  }
  if (snapshot.platform !== input.platform) {
    const err = new Error('CONFIG_SNAPSHOT_PLATFORM_MISMATCH') as Error & { code: string; status: number }
    err.code = 'CONFIG_SNAPSHOT_PLATFORM_MISMATCH'
    err.status = 409
    throw err
  }
  if (client.status !== 'online') {
    const err = new Error('CLIENT_OFFLINE') as Error & { code: string; status: number }
    err.code = 'CLIENT_OFFLINE'
    err.status = 503
    throw err
  }
  const deliveryId = newId('delivery')
  const commandId = newId('cmd')
  const schema = buildBuiltinConfigSchema(input.platform)
  const effectiveFlat = applyOverrideDiff(schema.defaults, cfg.overrideDiff)
  publishClientConfigToCapabilityPullPath({
    user: input.user,
    platform: input.platform,
    effectiveFlat,
  })
  const nowIso = new Date().toISOString()
  cfg.delivery = {
    ...cfg.delivery,
    configRef: snapshot.configRef,
    configVersion: snapshot.configVersion,
    checksum: snapshot.checksum,
    deliveryId,
    commandId,
    status: 'written',
    pulledAt: nowIso,
    writtenAt: nowIso,
    error: null,
  }
  writeStore(input.user, store)
  return {
    revision: cfg.revision,
    status: 'written',
    configRef: snapshot.configRef,
    configVersion: snapshot.configVersion,
    checksum: snapshot.checksum,
    deliveryId,
    commandId,
    httpStatus: 202,
  }
}

export function getConfigSnapshot(input: {
  user: string
  clientId: string
  configRef: string
}): ConfigSnapshot {
  const store = readStore(input.user)
  const snapshot = store.snapshots[input.configRef]
  if (!snapshot) {
    const err = new Error('CONFIG_SNAPSHOT_NOT_FOUND') as Error & { code: string; status: number }
    err.code = 'CONFIG_SNAPSHOT_NOT_FOUND'
    err.status = 404
    throw err
  }
  if (snapshot.clientId !== input.clientId || snapshot.user !== input.user) {
    const err = new Error('CONFIG_SNAPSHOT_FORBIDDEN') as Error & { code: string; status: number }
    err.code = 'CONFIG_SNAPSHOT_FORBIDDEN'
    err.status = 403
    throw err
  }
  if (new Date(snapshot.expiresAt).getTime() < Date.now()) {
    const err = new Error('CONFIG_SNAPSHOT_EXPIRED') as Error & { code: string; status: number }
    err.code = 'CONFIG_SNAPSHOT_EXPIRED'
    err.status = 410
    throw err
  }
  const cfg = getOrInitConfig(store, input.clientId, snapshot.platform)
  if (cfg.delivery.configRef === snapshot.configRef && cfg.delivery.status === 'sync_notified') {
    cfg.delivery.status = 'pulling'
    cfg.delivery.pulledAt = new Date().toISOString()
    writeStore(input.user, store)
  } else if (cfg.delivery.configRef === snapshot.configRef && cfg.delivery.status === 'pulling') {
    cfg.delivery.status = 'written'
    cfg.delivery.writtenAt = new Date().toISOString()
    writeStore(input.user, store)
  }
  return snapshot
}

export function markSnapshotWritten(user: string, clientId: string, configRef: string): void {
  const store = readStore(user)
  const cfgPlatforms = store.configs[clientId]
  if (!cfgPlatforms) return
  const snapshot = store.snapshots[configRef]
  for (const [platform, cfg] of Object.entries(cfgPlatforms)) {
    if (cfg.delivery.configRef !== configRef) continue
    // 只更新命中的平台；有快照时再校验 platform 防串扰。
    if (snapshot && snapshot.platform !== platform) continue
    cfg.delivery.status = 'written'
    cfg.delivery.writtenAt = new Date().toISOString()
  }
  writeStore(user, store)
}

/**
 * 客户端经 /api/ingest/ras-config?platform= 拉取时：仅推进该 platform 的 delivery。
 */
export function noteCapabilityIngestPull(user: string, platformRaw: string): void {
  if (!isReliabilityPlatformId(platformRaw)) return
  const store = readStore(user)
  let changed = false
  const nowIso = new Date().toISOString()
  for (const plats of Object.values(store.configs)) {
    const cfg = plats[platformRaw]
    if (!cfg) continue
    if (cfg.delivery.status === 'sync_notified' || cfg.delivery.status === 'pulling') {
      cfg.delivery.status = 'written'
      cfg.delivery.pulledAt = cfg.delivery.pulledAt || nowIso
      cfg.delivery.writtenAt = nowIso
      changed = true
    }
  }
  if (changed) writeStore(user, store)
}

export function recordConfigLoad(input: {
  user: string
  clientId: string
  platform: string
  configVersion: string
  checksum?: string
  status: 'loaded' | 'failed' | 'version_mismatch'
  loadedAt?: string
  error?: { code?: string; message?: string }
}): { deliveryStatus: DeliveryStatus } {
  if (!isReliabilityPlatformId(input.platform)) {
    const err = new Error('PLATFORM_SCHEMA_NOT_FOUND') as Error & { code: string; status: number }
    err.code = 'PLATFORM_SCHEMA_NOT_FOUND'
    err.status = 404
    throw err
  }
  const store = readStore(input.user)
  requireClient(store, input.clientId)
  const cfg = getOrInitConfig(store, input.clientId, input.platform)
  if (
    cfg.delivery.configVersion
    && cfg.delivery.configVersion !== input.configVersion
  ) {
    cfg.delivery.status = 'version_mismatch'
    cfg.delivery.error = {
      code: 'VERSION_MISMATCH',
      message: 'reported configVersion does not match active delivery',
    }
    writeStore(input.user, store)
    return { deliveryStatus: 'version_mismatch' }
  }
  if (input.status === 'loaded') {
    cfg.delivery.status = 'ras_loaded'
    cfg.delivery.loadedAt = input.loadedAt || new Date().toISOString()
    cfg.delivery.error = null
  } else if (input.status === 'version_mismatch') {
    cfg.delivery.status = 'version_mismatch'
    cfg.delivery.error = {
      code: input.error?.code || 'VERSION_MISMATCH',
      message: input.error?.message || 'RAS reported version mismatch',
    }
  } else {
    cfg.delivery.status = 'load_failed'
    cfg.delivery.error = {
      code: input.error?.code || 'LOAD_FAILED',
      message: input.error?.message || 'RAS failed to load config',
    }
  }
  writeStore(input.user, store)
  return { deliveryStatus: cfg.delivery.status }
}

/** Find any user's store that owns this configRef (device credential path). */
export function findSnapshotAcrossUsers(configRef: string): ConfigSnapshot | null {
  const root = storeRoot()
  if (!fs.existsSync(root)) return null
  for (const name of fs.readdirSync(root)) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')) as UserStoreFile
      const snap = raw.snapshots?.[configRef]
      if (snap) return snap
    } catch {
      /* skip */
    }
  }
  return null
}
