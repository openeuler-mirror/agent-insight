/**
 * 客户端注册与设备凭证（IF-N01/N04/N06/N15）。
 * 令牌与凭证只保存哈希；明文只在创建时返回一次。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { prisma } from '@/lib/storage/prisma'

export type ClientStatus = 'online' | 'offline' | 'degraded' | 'disabled' | 'unbound'
export type ServiceHealth = 'healthy' | 'degraded' | 'unknown'

export type ClientPlatformCapability = {
  id: string
  version?: string
  models?: string[]
  agents?: string[]
  runExperimentCase?: {
    version: number
    returnsTraceId: boolean
  }
  actions?: string[]
}

export type ClientCapabilities = {
  platforms: ClientPlatformCapability[]
  actions?: string[]
  components?: Record<string, unknown>
  /** Python / agent_fault_injection 缺失时为 ready:false —— 客户端仍可上线，只是不派发 FI run。 */
  faultInjection?: { ready: boolean; note?: string; maxParallel?: number }
}

export class ReliabilityError extends Error {
  code: string
  status: number
  details?: Record<string, unknown>

  constructor(code: string, message: string, status: number, details?: Record<string, unknown>) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
  }
}

/**
 * `prisma` 在 DB_HOST 模式下被包成 any（见 storage/prisma.ts），
 * 查询结果失去推断，因此这里显式标注行形状。
 */
type PrismaClientRow = {
  clientId: string
  name: string
  hostname: string | null
  reportedIp: string | null
  observedIp: string | null
  os: string | null
  arch: string | null
  status: string
  serviceHealth: string
  supervisor: string | null
  processStartedAt: Date | null
  restartCount: number
  lastSeenAt: Date
  agentVersion: string | null
  capabilitiesJson: string
  unboundAt: Date | null
}

export function clientOnlineWindowMs(): number {
  const sec = Number(process.env.AGENT_INSIGHT_RAS_CLIENT_ONLINE_SEC || 90)
  return Math.max(30, Number.isFinite(sec) ? sec : 90) * 1000
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function newSecret(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString('base64url')}`
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(5).toString('hex')}`
}

/** Constant-time compare so a stored hash can't be probed byte-by-byte. */
function hashEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export async function createInstallToken(input: {
  user: string
  name?: string | null
  platform?: string | null
  expiresInSeconds?: number
}): Promise<{ installToken: string; expiresAt: string }> {
  const ttl = Math.min(3600, Math.max(60, Number(input.expiresInSeconds) || 600))
  const token = newSecret('rit')
  const expiresAt = new Date(Date.now() + ttl * 1000)
  await prisma.reliabilityInstallToken.create({
    data: {
      tokenHash: sha256(token),
      user: input.user,
      name: input.name || null,
      platform: input.platform || null,
      expiresAt,
    },
  })
  return { installToken: token, expiresAt: expiresAt.toISOString() }
}

export async function registerClient(input: {
  installToken: string
  name?: string | null
  hostname?: string | null
  reportedIp?: string | null
  observedIp?: string | null
  os?: string | null
  arch?: string | null
  agentVersion?: string | null
  supervisor?: string | null
  capabilities?: ClientCapabilities
  /**
   * 本机上一次绑定的 clientId（改绑到别的账号时由安装器传入）。
   *
   * 一台机器只能属于一个账号：数据面（Trace 上报、RAS 配置）在本机只有一份，
   * 无法同时归属两边。所以改绑必须是**完整交接** —— 旧记录标为已解绑、
   * 旧凭证立即撤销，否则原账号仍能向这台机器下发配置。
   */
  previousClientId?: string | null
}): Promise<{
  clientId: string
  user: string
  deviceCredential: string
  unboundPrevious: { clientId: string; user: string } | null
}> {
  const tokenHash = sha256(String(input.installToken || ''))
  const record = await prisma.reliabilityInstallToken.findUnique({ where: { tokenHash } })
  if (!record) {
    throw new ReliabilityError('INSTALL_TOKEN_INVALID', '安装令牌无效', 401)
  }
  if (record.consumedAt) {
    throw new ReliabilityError('INSTALL_TOKEN_USED', '安装令牌已被使用', 409)
  }
  if (record.expiresAt.getTime() < Date.now()) {
    throw new ReliabilityError('INSTALL_TOKEN_EXPIRED', '安装令牌已过期', 410)
  }

  const clientId = newId('cli')
  const credential = newSecret('dc')
  const now = new Date()
  const capabilities = normalizeCapabilities(input.capabilities)
  const displayName =
    input.name?.trim() ||
    (input.reportedIp ? `主机-${input.reportedIp}` : null) ||
    input.hostname ||
    clientId

  // 解绑旧绑定必须和新注册在同一个事务里：否则中途失败会留下
  //「旧凭证已撤销、新客户端没建成」的半态，本机彻底失联且无法自愈。
  const previous = input.previousClientId
    ? await prisma.reliabilityClient.findUnique({ where: { clientId: input.previousClientId } })
    : null
  const shouldUnbind = Boolean(previous && !previous.unboundAt && previous.clientId !== clientId)

  await prisma.$transaction([
    prisma.reliabilityClient.create({
      data: {
        clientId,
        user: record.user,
        name: displayName,
        hostname: input.hostname || null,
        reportedIp: input.reportedIp || null,
        observedIp: input.observedIp || null,
        os: input.os || null,
        arch: input.arch || null,
        status: 'online',
        serviceHealth: 'healthy',
        supervisor: input.supervisor || null,
        processStartedAt: now,
        lastSeenAt: now,
        agentVersion: input.agentVersion || null,
        capabilitiesJson: JSON.stringify(capabilities),
      },
    }),
    prisma.reliabilityClientCredential.create({
      data: { clientId, credentialHash: sha256(credential) },
    }),
    prisma.reliabilityInstallToken.update({
      where: { tokenHash },
      data: { consumedAt: now, clientId },
    }),
    ...(shouldUnbind
      ? [
          prisma.reliabilityClient.update({
            where: { clientId: previous!.clientId },
            data: { unboundAt: now, unboundToClientId: clientId, status: 'offline' },
          }),
          // 撤销而非删除：旧账号立即失去控制权，但配置下发历史仍可追溯。
          prisma.reliabilityClientCredential.updateMany({
            where: { clientId: previous!.clientId, revokedAt: null },
            data: { revokedAt: now },
          }),
        ]
      : []),
  ])

  return {
    clientId,
    user: record.user,
    deviceCredential: credential,
    unboundPrevious: shouldUnbind ? { clientId: previous!.clientId, user: previous!.user } : null,
  }
}

/** Resolve `Authorization: Bearer <deviceCredential>` to its client. */
export async function authenticateDevice(req: Request): Promise<{
  clientId: string
  user: string
}> {
  const auth = req.headers.get('authorization') || ''
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim())
  if (!match) {
    throw new ReliabilityError('DEVICE_UNAUTHORIZED', '缺少设备凭证', 401)
  }
  const credentialHash = sha256(match[1].trim())
  const cred = await prisma.reliabilityClientCredential.findUnique({
    where: { credentialHash },
  })
  if (!cred || cred.revokedAt) {
    throw new ReliabilityError('DEVICE_UNAUTHORIZED', '设备凭证无效或已撤销', 401)
  }
  const headerClientId = req.headers.get('x-agent-insight-client-id')
  if (headerClientId && !hashEquals(headerClientId, cred.clientId)) {
    throw new ReliabilityError('DEVICE_CLIENT_MISMATCH', '设备凭证与 clientId 不匹配', 403)
  }
  const client = await prisma.reliabilityClient.findUnique({
    where: { clientId: cred.clientId },
  })
  if (!client) {
    throw new ReliabilityError('CLIENT_NOT_FOUND', '客户端不存在', 404)
  }
  await prisma.reliabilityClientCredential.update({
    where: { credentialHash },
    data: { lastUsedAt: new Date() },
  })
  return { clientId: client.clientId, user: client.user }
}

export function normalizeCapabilities(raw: unknown): ClientCapabilities {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<ClientCapabilities>
  const platforms: ClientPlatformCapability[] = Array.isArray(value.platforms)
    ? value.platforms
        .map((p): ClientPlatformCapability | null => {
          const rec = (p && typeof p === 'object' ? p : {}) as ClientPlatformCapability
          const id = String(rec.id || '').trim()
          if (!id) return null
          return {
            id,
            version: rec.version ? String(rec.version) : undefined,
            models: Array.isArray(rec.models)
              ? rec.models.map((m) => String(m).trim()).filter(Boolean)
              : [],
            agents: Array.isArray(rec.agents)
              ? rec.agents.map((agent) => String(agent).trim()).filter(Boolean)
              : [],
            runExperimentCase: rec.runExperimentCase
              && typeof rec.runExperimentCase === 'object'
              ? {
                  version: Number.isFinite(Number(rec.runExperimentCase.version))
                    ? Number(rec.runExperimentCase.version)
                    : 1,
                  returnsTraceId: rec.runExperimentCase.returnsTraceId === true,
                }
              : undefined,
            actions: Array.isArray(rec.actions) ? rec.actions.map((a) => String(a)) : undefined,
          }
        })
        .filter((p): p is ClientPlatformCapability => p !== null)
    : []
  const fi = value.faultInjection
  return {
    platforms,
    actions: Array.isArray(value.actions) ? value.actions.map((a) => String(a)) : undefined,
    components: value.components && typeof value.components === 'object' ? value.components : undefined,
    faultInjection: fi && typeof fi === 'object'
      ? {
          ready: Boolean(fi.ready),
          note: fi.note ? String(fi.note) : undefined,
          maxParallel: Number.isFinite(Number(fi.maxParallel)) ? Number(fi.maxParallel) : undefined,
        }
      : { ready: false, note: 'not reported' },
  }
}

export async function recordHeartbeat(input: {
  clientId: string
  agentVersion?: string | null
  status?: string | null
  observedIp?: string | null
  service?: {
    processStartedAt?: string | null
    supervisor?: string | null
    watchdog?: string | null
    restartCount?: number | null
  }
}): Promise<{ nextHeartbeatSeconds: number; refreshCapabilities: boolean }> {
  const serviceHealth: ServiceHealth =
    input.service?.watchdog === 'healthy' || input.status === 'healthy'
      ? 'healthy'
      : input.status === 'degraded'
        ? 'degraded'
        : 'unknown'
  await prisma.reliabilityClient.update({
    where: { clientId: input.clientId },
    data: {
      lastSeenAt: new Date(),
      status: 'online',
      serviceHealth,
      agentVersion: input.agentVersion || undefined,
      observedIp: input.observedIp || undefined,
      supervisor: input.service?.supervisor || undefined,
      restartCount: Number.isFinite(Number(input.service?.restartCount))
        ? Number(input.service?.restartCount)
        : undefined,
      processStartedAt: input.service?.processStartedAt
        ? new Date(input.service.processStartedAt)
        : undefined,
    },
  })
  return {
    nextHeartbeatSeconds: Math.floor(clientOnlineWindowMs() / 3000),
    refreshCapabilities: false,
  }
}

export async function updateCapabilities(input: {
  clientId: string
  revision?: string | null
  hostname?: string | null
  reportedIp?: string | null
  observedIp?: string | null
  os?: string | null
  arch?: string | null
  capabilities: ClientCapabilities
}): Promise<{ acceptedRevision: string | null }> {
  const existing = await prisma.reliabilityClient.findUnique({
    where: { clientId: input.clientId },
  })
  if (!existing) {
    throw new ReliabilityError('CLIENT_NOT_FOUND', '客户端不存在', 404)
  }
  // Same revision replayed is a no-op, not an error (IF-N15 idempotency).
  if (input.revision && existing.capabilitiesRevision === input.revision) {
    return { acceptedRevision: input.revision }
  }
  await prisma.reliabilityClient.update({
    where: { clientId: input.clientId },
    data: {
      hostname: input.hostname || undefined,
      reportedIp: input.reportedIp || undefined,
      // observedIp 由服务端从连接源地址推导，不接受请求体覆盖。
      observedIp: input.observedIp || undefined,
      os: input.os || undefined,
      arch: input.arch || undefined,
      capabilitiesJson: JSON.stringify(normalizeCapabilities(input.capabilities)),
      capabilitiesRevision: input.revision || null,
      lastSeenAt: new Date(),
    },
  })
  return { acceptedRevision: input.revision || null }
}

export function parseCapabilities(json: string | null | undefined): ClientCapabilities {
  try {
    return normalizeCapabilities(JSON.parse(json || '{}'))
  } catch {
    return { platforms: [], faultInjection: { ready: false } }
  }
}

/** Network reachability only — never conflate with serviceHealth. */
export function deriveStatus(row: {
  status: string
  lastSeenAt: Date
  unboundAt?: Date | null
}): ClientStatus {
  // 已解绑优先于一切：这台机器已改绑到别的账号，不再是「离线」——
  // 显示成离线会让人以为机器只是掉线了，等它自己回来。
  if (row.unboundAt) return 'unbound'
  if (row.status === 'disabled') return 'disabled'
  const fresh = Date.now() - row.lastSeenAt.getTime() <= clientOnlineWindowMs()
  if (!fresh) return 'offline'
  return row.status === 'degraded' ? 'degraded' : 'online'
}

/**
 * 进程健康度只在心跳时写库，客户端一旦停掉就会**冻结在最后一次的值**。
 * 离线后必须降级为 unknown —— 否则页面会同时显示「离线」和「healthy」，
 * 让人以为服务还好好的。真值只有客户端自己知道，它不在了就是未知。
 */
export function deriveServiceHealth(row: {
  status: string
  serviceHealth: string
  lastSeenAt: Date
}): ServiceHealth {
  if (deriveStatus(row) === 'offline') return 'unknown'
  const value = row.serviceHealth
  return value === 'healthy' || value === 'degraded' ? value : 'unknown'
}

export async function listClients(
  user: string,
  opts?: { page?: number; pageSize?: number; status?: string; keyword?: string },
): Promise<{
  items: Array<{
    id: string
    name: string
    hostname: string | null
    reportedIp: string | null
    observedIp: string | null
    os: string | null
    arch: string | null
    status: ClientStatus
    serviceHealth: string
    supervisor: string | null
    processStartedAt: string | null
    restartCount: number
    lastSeenAt: string
    agentVersion: string | null
    platforms: ClientPlatformCapability[]
    faultInjection: { ready: boolean; note?: string } | undefined
  }>
  page: number
  pageSize: number
  total: number
}> {
  const rows = await prisma.reliabilityClient.findMany({
    where: { user },
    orderBy: { lastSeenAt: 'desc' },
  })
  const keyword = String(opts?.keyword || '').trim().toLowerCase()
  const statusFilter = String(opts?.status || '').trim()

  let items = (rows as PrismaClientRow[]).map((row) => {
    const caps = parseCapabilities(row.capabilitiesJson)
    return {
      id: row.clientId,
      name: row.name,
      hostname: row.hostname,
      reportedIp: row.reportedIp,
      observedIp: row.observedIp,
      os: row.os,
      arch: row.arch,
      status: deriveStatus(row),
      serviceHealth: deriveServiceHealth(row),
      supervisor: row.supervisor,
      processStartedAt: row.processStartedAt ? row.processStartedAt.toISOString() : null,
      restartCount: row.restartCount,
      lastSeenAt: row.lastSeenAt.toISOString(),
      agentVersion: row.agentVersion,
      platforms: caps.platforms,
      faultInjection: caps.faultInjection,
    }
  })

  if (statusFilter) {
    items = items.filter((item: (typeof items)[number]) => item.status === statusFilter)
  }
  if (keyword) {
    items = items.filter((item: (typeof items)[number]) =>
      [item.reportedIp, item.hostname, item.name, item.id]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(keyword),
    )
  }

  const page = Math.max(1, Number(opts?.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(opts?.pageSize) || 20))
  const total = items.length
  const start = (page - 1) * pageSize
  return { items: items.slice(start, start + pageSize), page, pageSize, total }
}

export async function requireOwnedClient(user: string, clientId: string) {
  const client = await prisma.reliabilityClient.findUnique({ where: { clientId } })
  if (!client || client.user !== user) {
    throw new ReliabilityError('CLIENT_NOT_FOUND', '客户端不存在', 404)
  }
  return client
}
