import { prisma } from '@/lib/storage/prisma'
import { ReliabilityError } from '@/lib/reliability/client-registry'
import { benchmarkDatasetOwners } from '@/lib/benchmark/dataset-ownership'
import { readExperimentDatasetCaseBinding } from './dataset-case-binding'
import { readSavedOptions } from './runtime-options'
import type { EnvironmentSelection } from '@/lib/client/use-execution-environment'

function object(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') { try { return object(JSON.parse(value)) } catch { return {} } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function strings(value: unknown): string[] { return Array.isArray(value) ? value.map(String) : [] }
function incomplete(): never {
  throw new ReliabilityError('SOURCE_ENVIRONMENT_INCOMPLETE', '原实验缺少可确认的执行配置，请使用“复用评测配置”重新选择数据集和执行目标。', 409)
}

export async function resolveReuseEnvironment(user: string, sourceExperimentId: string, store = prisma): Promise<EnvironmentSelection | null> {
  const source = await store.experiment.findFirst({
    where: { id: sourceExperimentId, user, deletedAt: null },
    include: { benchmarkBinding: true, cases: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } } },
  })
  if (!source) throw new ReliabilityError('SOURCE_EXPERIMENT_NOT_FOUND', '原实验不存在或无权访问', 404)
  const snapshot = object(source.configSnapshotJson)
  if (source.scope === 'benchmark') {
    const binding = source.benchmarkBinding
    if (!binding) incomplete()
    const config = object(binding.runConfigJson)
    if (config.submissionSource === 'imported') throw new ReliabilityError('IMPORTED_EXPERIMENT', '历史导入提交实验不支持同配置运行', 409)
    const dataset = await store.agentEvalDataset.findFirst({ where: { benchmarkDataset: { id: binding.datasetId }, user: { in: benchmarkDatasetOwners(user) } } })
    if (!dataset) incomplete()
    const selection = object(binding.selectionJson)
    const cases = selection.mode === 'explicit' ? strings(selection.caseIds)
      : (await store.benchmarkDatasetCase.findMany({ where: { datasetId: binding.datasetId }, orderBy: { ordinal: 'asc' }, select: { id: true } })).map((item: { id: string }) => item.id)
    return { datasetId: dataset.id, clientId: String(snapshot.clientId || ''), platform: String(config.platform || ''),
      agent: String(config.agent || source.agentName), model: String(config.model || ''), agentOptions: readSavedOptions(config.agentOptions),
      caseIds: cases, mode: 'generate', timeoutSeconds: Number(config.timeoutSeconds) || 600, concurrency: Number(config.executionConcurrency) || 1 }
  }
  const skillExecution = source.scope === 'skill-workbench' && Boolean(snapshot.grayscaleTaskId)
  const generates = snapshot.traceSource === 'generate' || source.cases.some((item: { traceGenerationCommandId: string | null }) => Boolean(item.traceGenerationCommandId))
  if (!skillExecution && (source.type === 'llm' || !generates)) return null
  const target = object(snapshot.executionTarget)
  const datasetId = typeof snapshot.datasetId === 'string' ? snapshot.datasetId : ''
  if (!target.workerId || !target.platform || !datasetId) incomplete()
  let caseIds: string[]
  if (skillExecution) {
    const cancelled = await store.experimentCancellation.findMany({ where: { experimentId: source.id, caseKey: { startsWith: 'dataset:' } }, select: { caseKey: true } })
    const removed = new Set(cancelled.map((item: { caseKey: string }) => item.caseKey.slice(8)))
    caseIds = strings(snapshot.caseIds).filter(id => !removed.has(id))
  } else {
    const dataset = await store.agentEvalDataset.findFirst({ where: { id: datasetId, user } })
    if (!dataset || (dataset.datasetKind === 'reliability') !== Boolean(snapshot.fiOrchestrate)) incomplete()
    let catalog: Array<{ id?: string; input?: string; values?: Record<string, unknown> }> = []
    try { catalog = JSON.parse(dataset.casesJson) } catch { incomplete() }
    if (!Array.isArray(catalog)) incomplete()
    const faults = new Map(catalog.map((item, index) => [String(item.id || `dataset-case-${index}:${item.input || ''}`), item.values?.fault_injection_type || '']))
    caseIds = source.cases.map((item: { caseValuesJson: string | null; faultInjectionType: string | null }) => {
      const binding = readExperimentDatasetCaseBinding(object(item.caseValuesJson))
      if (!binding || binding.datasetId !== datasetId) incomplete()
      // 复跑沿用 Case 冻结的故障类型，不能用数据集修改后的类型代替检查。
      if (snapshot.fiOrchestrate && faults.get(binding.caseId) !== (item.faultInjectionType || object(item.caseValuesJson).fault_injection_type || '')) incomplete()
      return binding.caseId
    })
  }
  if (!caseIds.length) incomplete()
  const runtime = object(snapshot.runtime)
  return { datasetId, clientId: String(target.workerId), platform: String(target.platform), agent: String(target.agent || source.agentName),
    model: String(target.model || ''), agentOptions: readSavedOptions(target.agentOptions), caseIds: [...new Set(caseIds)],
    mode: skillExecution && source.preset === 'skill-ab' ? 'skill-ab' : skillExecution && source.preset === 'trigger' ? 'trigger' : 'generate',
    timeoutSeconds: skillExecution ? Number(runtime.timeoutMs) / 1000 || 600 : Number(target.timeoutSeconds) || 600,
    concurrency: skillExecution ? 1 : Number(snapshot.executionConcurrency) || 1 }
}
