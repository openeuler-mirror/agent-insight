import { prisma } from '@/lib/storage/prisma'
import { createBenchmarkExperiment } from '@/lib/benchmark/experiment-service'
import { loadTraceGenerationRetryRequest } from '@/lib/engine/experiment/trace-generation'

import { autoPairGroups, createComparisonExperiment } from './comparison-runner'

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

function parseObject(value: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

export async function cloneExperimentFromFrozenConfig(input: {
  sourceExperimentId: string
  user: string
}): Promise<{ id: string; scope: string }> {
  const source = await prisma.experiment.findFirst({
    where: { id: input.sourceExperimentId, user: input.user },
    include: {
      cases: { orderBy: { createdAt: 'asc' } },
      groups: { orderBy: { createdAt: 'asc' } },
      benchmarkBinding: true,
    },
  })
  if (!source) throw new Error('source experiment not found')
  const evaluatorIds = parseStringArray(source.evaluatorIdsJson)
  const snapshot = parseObject(source.configSnapshotJson)
  const name = `${source.name} · 同配置`

  if (source.scope === 'benchmark') {
    const binding = source.benchmarkBinding
    if (!binding) throw new Error('Benchmark 实验缺少冻结配置')
    const runConfig = parseObject(binding.runConfigJson)
    const selection = parseObject(binding.selectionJson)
    const result = await createBenchmarkExperiment({
      user: input.user,
      name,
      agentName: source.agentName,
      datasetId: binding.datasetId,
      agentEvalDatasetId: typeof snapshot.agentEvalDatasetId === 'string'
        ? snapshot.agentEvalDatasetId
        : undefined,
      caseSelection: selection.mode === 'explicit' && Array.isArray(selection.caseIds)
        ? { mode: 'explicit', caseIds: selection.caseIds.map(String) }
        : { mode: 'all' },
      clientId: String(snapshot.clientId || ''),
      evaluatorIds,
      runConfig: {
        platform: String(runConfig.platform || ''),
        agent: String(runConfig.agent || source.agentName),
        model: typeof runConfig.model === 'string' ? runConfig.model : undefined,
        agentTimeoutSeconds: Number(runConfig.timeoutSeconds) || undefined,
        maxParallelAgentCases: 1,
      },
    })
    await prisma.experiment.update({
      where: { id: result.id },
      data: { sourceExperimentId: source.id },
    })
    return { id: result.id, scope: 'benchmark' }
  }

  if (source.type === 'llm') {
    const created = await createComparisonExperiment({
      user: input.user,
      name,
      agentName: source.agentName,
      variableDimension: 'llm',
      groups: source.groups.map((group: { key: string; variableValue: string }) => ({ key: group.key, value: group.variableValue })),
      evaluatorIds,
    })
    await prisma.experiment.update({
      where: { id: created.id },
      data: {
        sourceExperimentId: source.id,
        configSnapshotJson: source.configSnapshotJson,
      },
    })
    await autoPairGroups(created.id)
    return { id: created.id, scope: source.scope }
  }

  const traceSource = snapshot.traceSource === 'generate'
    || source.cases.some((item: { traceGenerationCommandId: string | null }) => Boolean(item.traceGenerationCommandId))
    ? 'generate'
    : 'existing'
  if (traceSource === 'generate' && (!snapshot.executionTarget || typeof snapshot.executionTarget !== 'object')) {
    const generatedCase = source.cases.find((item: { id: string; traceGenerationCommandId: string | null }) => Boolean(item.traceGenerationCommandId))
    if (!generatedCase) throw new Error('原实验缺少可复用的 Trace 生成配置')
    const request = await loadTraceGenerationRetryRequest({
      user: input.user,
      experimentId: source.id,
      caseId: generatedCase.id,
    })
    if (!request) throw new Error('原实验缺少可复用的 Trace 生成配置')
    snapshot.traceSource = 'generate'
    snapshot.agentName = source.agentName
    snapshot.executionTarget = {
      workerId: request.workerId,
      platform: request.platform,
      model: request.model,
      timeoutSeconds: request.timeoutSeconds,
    }
  }
  const created = await prisma.experiment.create({
    data: {
      user: input.user,
      name,
      type: source.type,
      agentName: source.agentName,
      evaluatorIdsJson: source.evaluatorIdsJson,
      status: 'draft',
      scope: source.scope,
      skillName: source.skillName,
      skillVersion: source.skillVersion,
      preset: source.preset,
      skillContextJson: source.skillContextJson,
      configSnapshotJson: JSON.stringify(snapshot),
      sourceExperimentId: source.id,
      watchMode: source.watchMode,
      watchEnabledAt: source.watchMode ? new Date() : null,
      cases: {
        create: source.cases.map((item: {
          executionId: string | null
          taskId: string | null
          input: string
          datasetInput: string | null
          actualOutput: string
          referenceOutput: string | null
          evaluatorContextJson: string | null
          faultInjectionType: string | null
          caseValuesJson: string | null
        }) => ({
          executionId: traceSource === 'existing' ? item.executionId : null,
          taskId: traceSource === 'existing' ? item.taskId : null,
          input: item.input,
          datasetInput: item.datasetInput,
          actualOutput: traceSource === 'existing' ? item.actualOutput : '',
          referenceOutput: item.referenceOutput,
          evaluatorContextJson: item.evaluatorContextJson,
          faultInjectionType: item.faultInjectionType,
          caseValuesJson: item.caseValuesJson,
        })),
      },
    },
    select: { id: true },
  })
  return { id: created.id, scope: source.scope }
}
