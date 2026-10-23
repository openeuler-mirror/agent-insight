import { createHash } from 'node:crypto'
import { z } from 'zod'
import { prisma } from '@/lib/storage/prisma'
import { ReliabilityError, deriveStatus, deriveServiceHealth, parseCapabilities } from '@/lib/reliability/client-registry'
import { dispatchCommand } from '@/lib/reliability/control-dispatch'
import { ackTimeoutMs, markSent, type CommandFrame } from '@/lib/reliability/command-bus'
import { benchmarkDatasetOwners } from '@/lib/benchmark/dataset-ownership'
import { digest } from '../../../../packages/benchmark-protocol/execution.cjs'
import { ACTION, PROTOCOL, TIMEOUT_MS, contextDigest, preparationMessage, validateContext, type EnvironmentTask, type EnvironmentContext } from '../../../../packages/benchmark-protocol/environment.cjs'

const requestSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  datasetId: z.string().min(1).max(256).nullable(),
  clientId: z.string().min(1).max(256),
  platform: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  agent: z.string().min(1).max(128),
  model: z.string().max(512).default(''),
  agentOptions: z.record(z.string(), z.unknown()).optional(),
  caseIds: z.array(z.string().min(1).max(65536)).max(500),
  mode: z.enum(['generate', 'skill-ab', 'trigger']),
  timeoutSeconds: z.number().int().min(30).max(3600),
  concurrency: z.number().int().min(1).max(1024),
}).strict()

type Store = typeof prisma
type CommandRow = { commandId: string; user: string; clientId: string; action: string; status: string; payloadJson: string; resultJson: string | null; errorMessage: string | null; expiresAt: Date; createdAt: Date; sentAt?: Date | null }
type DatasetCase = { id?: string; input?: string; values?: Record<string, unknown> }
function json(value: string | null): Record<string, unknown> { try { return JSON.parse(value || '{}') } catch { return {} } }

export function environmentTask(row: CommandRow): EnvironmentTask {
  const result = json(row.resultJson)
  const payload = json(row.payloadJson)
  const issues = Array.isArray(result.issues) ? result.issues.filter((item): item is { code: string; message: string } => Boolean(item && typeof item.code === 'string' && typeof item.message === 'string')) : []
  let state: EnvironmentTask['state'] = row.status === 'SUCCEEDED' && ['ready', 'needs_action'].includes(String(result.state))
    ? result.state as 'ready' | 'needs_action'
    : ['FAILED', 'EXPIRED', 'DELIVERY_FAILED', 'SUCCEEDED'].includes(row.status) ? 'failed'
    : result.state === 'preparing' ? 'preparing' : 'checking'
  if (!['ready', 'needs_action', 'failed'].includes(state) && row.expiresAt.getTime() <= Date.now()) state = 'failed'
  const unacked = row.status === 'SENT' && row.sentAt && row.sentAt.getTime() < Date.now() - ackTimeoutMs()
  if (unacked) state = 'failed'
  const durationHint = ['first_install_minutes', 'minutes'].includes(String(result.durationHint)) ? result.durationHint as EnvironmentTask['durationHint'] : undefined
  return {
    taskId: row.commandId, contextDigest: String(payload.contextDigest || ''), state, durationHint, issues,
    message: state === 'needs_action' ? `${typeof result.hostname === 'string' ? `主机 ${result.hostname}：\n` : ''}${issues.map(item => item.message).join('\n') || '请在执行机完成所需配置，然后再次点击“下一步”。'}`
      : state === 'failed' ? issues.map(item => item.message).join('\n') || row.errorMessage || (unacked ? '执行主机未确认收到检查请求，请确认客户端连接后再次点击“下一步”。' : '运行环境准备中断或超时，请检查执行机后再次点击“下一步”。')
      : preparationMessage(state, durationHint),
  }
}

export async function createEnvironmentPreparation(user: string, body: unknown, store: Store = prisma, dispatch = dispatchCommand): Promise<EnvironmentTask> {
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) throw new ReliabilityError('ENVIRONMENT_REQUEST_INVALID', '请检查数据集、执行目标和运行参数', 400)
  const input = parsed.data
  const client = await store.reliabilityClient.findFirst({ where: { clientId: input.clientId, user, unboundAt: null } })
  if (!client) throw new ReliabilityError('CLIENT_NOT_FOUND', '执行主机不存在或无权访问', 404)
  if (deriveStatus(client) !== 'online') throw new ReliabilityError('CLIENT_OFFLINE', '执行主机不在线，请恢复连接或更换主机后再次点击“下一步”。', 409)
  if (deriveServiceHealth(client) !== 'healthy') throw new ReliabilityError('CLIENT_NOT_READY', '执行主机客户端服务尚未就绪，请确认服务正常后再次点击“下一步”。', 409)
  const caps = parseCapabilities(client.capabilitiesJson)
  if (!caps.actions?.includes(ACTION)) throw new ReliabilityError('ENVIRONMENT_CLIENT_UPGRADE_REQUIRED', '执行主机客户端暂不支持环境准备，请更新客户端后重试。', 409)
  const platform = caps.platforms.find(p => p.id === input.platform)
  const agents = [...(platform?.agents || []), ...caps.executionProfiles?.flatMap(p => p.profile.targets.filter(t => t.platform === input.platform).flatMap(t => t.agents)) || []]
  if (!platform || !agents.includes(input.agent)) throw new ReliabilityError('AGENT_UNAVAILABLE', '执行主机未声明所选 Agent，请刷新并重新选择。', 409)

  let dataset: EnvironmentContext['dataset'] = { id: 'trace-samples', adapterKey: 'generic', revision: digest(input.caseIds), caseIds: [], faultTypes: [] }
  if (!input.datasetId && input.mode !== 'skill-ab') throw new ReliabilityError('DATASET_REQUIRED', '请先选择数据集', 400)
  if (input.datasetId) {
    const record = await store.agentEvalDataset.findFirst({ where: { id: input.datasetId, user: { in: benchmarkDatasetOwners(user) } }, include: { benchmarkDataset: true } })
    if (!record || (record.user !== user && record.datasetKind !== 'benchmark')) throw new ReliabilityError('DATASET_NOT_FOUND', '数据集不存在或无权访问', 404)
    let cases: DatasetCase[]
    try { cases = JSON.parse(record.casesJson) } catch { throw new ReliabilityError('DATASET_INVALID', '数据集内容无法读取', 409) }
    if (!Array.isArray(cases)) throw new ReliabilityError('DATASET_INVALID', '数据集内容无法读取', 409)
    const catalog = new Map(cases.map((item, i) => [String(item.id || `dataset-case-${i}:${item.input || ''}`), item]))
    if (input.mode !== 'skill-ab' && (!input.caseIds.length || input.caseIds.some(id => !catalog.has(id)))) throw new ReliabilityError('DATASET_CASE_INVALID', '所选 Case 已变化，请重新选择数据集 Case。', 409)
    if (record.datasetKind === 'benchmark' && (!record.benchmarkDataset || record.benchmarkDataset.status !== 'ready')) throw new ReliabilityError('DATASET_NOT_READY', '数据集接入尚未就绪', 409)
    dataset = {
      id: record.id,
      adapterKey: record.benchmarkDataset?.adapterKey || (record.datasetKind === 'reliability' ? 'reliability' : 'generic'),
      revision: record.benchmarkDataset?.contentHash || digest({ updatedAt: record.updatedAt.toISOString(), cases: record.casesJson }),
      caseIds: input.caseIds,
      faultTypes: [...new Set(input.caseIds.flatMap(id => { const fault = catalog.get(id)?.values?.fault_injection_type; return typeof fault === 'string' && fault ? [fault] : [] }))],
    }
  }
  let context: EnvironmentContext
  try {
    context = validateContext({ protocol: PROTOCOL, clientId: client.clientId, dataset, platform: input.platform, agent: input.agent, model: input.model,
      ...(input.agentOptions ? { agentOptions: input.agentOptions } : {}), experiment: { mode: input.mode, timeoutSeconds: input.timeoutSeconds, concurrency: input.concurrency } })
  } catch { throw new ReliabilityError('ENVIRONMENT_CONTEXT_INVALID', '执行配置不合法或选择范围过大，请调整后再次点击“下一步”。', 400) }
  const hash = contextDigest(context)
  await store.reliabilityCommand.updateMany({ where: { user, action: ACTION, status: 'SENT', sentAt: { lt: new Date(Date.now() - ackTimeoutMs()) } },
    data: { status: 'DELIVERY_FAILED', errorCode: 'ACK_TIMEOUT', errorMessage: '执行主机未确认收到检查请求，请确认客户端连接后重试。', completedAt: new Date() } })
  const commandId = `env_${createHash('sha256').update(`${user}\0${input.requestId}`).digest('hex').slice(0, 40)}`
  const existing = await store.reliabilityCommand.findUnique({ where: { commandId } })
  if (existing && json(existing.payloadJson).contextDigest !== hash) throw new ReliabilityError('ENVIRONMENT_REQUEST_CONFLICT', '该请求对应的执行配置已变化，请重新点击“下一步”。', 409)
  const active = existing || await store.reliabilityCommand.findFirst({ where: { user, clientId: input.clientId, action: ACTION, status: { in: ['CREATED', 'SENT', 'RECEIVED', 'RUNNING'] }, expiresAt: { gt: new Date() }, payloadJson: { contains: hash } }, orderBy: { createdAt: 'desc' } })
  const row = active || await store.reliabilityCommand.upsert({ where: { commandId }, update: {}, create: {
    commandId, user, clientId: input.clientId, action: ACTION, payloadJson: JSON.stringify({ context, contextDigest: hash }), status: 'CREATED', expiresAt: new Date(Date.now() + TIMEOUT_MS),
  } })
  if (row.status === 'CREATED') {
    const frame: CommandFrame = { type: 'COMMAND', commandId: row.commandId, action: ACTION, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), payload: json(row.payloadJson) }
    const delivered = await dispatch(input.clientId, frame)
    if (delivered.delivered) await markSent(row.commandId, 'wss')
  }
  return environmentTask(row)
}

export async function getEnvironmentPreparation(user: string, taskId: string, store: Store = prisma): Promise<EnvironmentTask> {
  const row = await store.reliabilityCommand.findFirst({ where: { commandId: taskId, user, action: ACTION, client: { user, unboundAt: null } }, include: { client: true } })
  if (!row) throw new ReliabilityError('ENVIRONMENT_TASK_NOT_FOUND', '环境准备任务不存在或无权访问', 404)
  const task = environmentTask(row)
  if (task.state === 'ready') {
    const context = json(row.payloadJson).context as EnvironmentContext
    let message = ''
    if (deriveStatus(row.client) !== 'online' || deriveServiceHealth(row.client) !== 'healthy') message = '执行主机当前不在线或服务未就绪，请确认后再次点击“下一步”。'
    if (context.dataset.id !== 'trace-samples') {
      const dataset = await store.agentEvalDataset.findFirst({ where: { id: context.dataset.id, user: { in: benchmarkDatasetOwners(user) } }, include: { benchmarkDataset: true } })
      const revision = dataset && (dataset.benchmarkDataset?.contentHash || digest({ updatedAt: dataset.updatedAt.toISOString(), cases: dataset.casesJson }))
      if (!dataset || (dataset.user !== user && dataset.datasetKind !== 'benchmark') || revision !== context.dataset.revision || (dataset.datasetKind === 'benchmark' && dataset.benchmarkDataset?.status !== 'ready')) message = '数据集内容或接入状态已变化，请重新选择并再次点击“下一步”。'
    }
    if (message) return { ...task, state: 'failed', message, issues: [{ code: 'ENVIRONMENT_CONTEXT_CHANGED', message }] }
  }
  return task
}
