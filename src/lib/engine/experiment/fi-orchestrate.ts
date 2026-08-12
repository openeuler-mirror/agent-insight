/**
 * 外挂 FI 编排：在 startExperimentRun 之前按 case 的 faultInjectionType 创建 FI 任务。
 * 禁止写入 run-experiment 内核 I/O；本模块只调用 store/createTaskWithRuns。
 * FI 元数据写入 ExperimentCase 独立列，禁止污染 evaluatorContextJson。
 */
import { createTaskWithRuns } from '@/lib/fault-injection/store'
import { listPlatformsFromWorkers } from '@/lib/fault-injection/worker-protocol'
import { normalizeFiWorkspaceInput } from '@/lib/fault-injection/workspace'
import { prisma } from '@/lib/storage/prisma'
import { resolveCaseFaultInjectionType } from '@/lib/engine/experiment/case-fi-meta'

export type FiOrchestrateCaseSpec = {
  caseId: string
  input: string
  fault: string
  submode?: string | null
}

export type FiOrchestrateRequest = {
  user: string
  experimentId: string
  platform: string
  agent: string
  model?: string | null
  workspace?: string | null
  timeoutSeconds?: number
  cases: FiOrchestrateCaseSpec[]
}

export type FiOrchestrateResult = {
  skipped: boolean
  reason?: string
  taskIds: string[]
  runIds: string[]
  caseFaults: Array<{ caseId: string; fault: string; taskId?: string; runId?: string }>
}

/** 有 FI case 但无法编排时抛出；run 路由映射为 503。 */
export class FiOrchestrateError extends Error {
  readonly code: string
  readonly httpStatus: number

  constructor(code: string, message: string, httpStatus = 503) {
    super(message)
    this.name = 'FiOrchestrateError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

/** 从实验 case 中提取需要 FI 的条目（已有 execution/task 的跳过）。 */
export async function collectFiCasesFromExperiment(experimentId: string): Promise<FiOrchestrateCaseSpec[]> {
  const cases = await prisma.experimentCase.findMany({
    where: { experimentId },
    orderBy: { createdAt: 'asc' },
  })
  const out: FiOrchestrateCaseSpec[] = []
  for (const item of cases) {
    if (item.executionId || item.taskId) continue
    const fault = resolveCaseFaultInjectionType(item)
    if (!fault) continue
    let submode: string | null = null
    if (item.caseValuesJson) {
      try {
        const values = JSON.parse(item.caseValuesJson) as Record<string, unknown>
        const raw = values.submode
        if (raw != null && String(raw).trim()) submode = String(raw).trim()
      } catch {
        submode = null
      }
    }
    out.push({
      caseId: item.id,
      input: item.input || '',
      fault,
      submode,
    })
  }
  return out
}

async function patchCaseFiMeta(caseId: string, meta: {
  fault: string
  taskId: string
  runId: string
}) {
  await prisma.experimentCase.update({
    where: { id: caseId },
    data: {
      faultInjectionType: meta.fault,
      fiTaskId: meta.taskId,
      fiRunId: meta.runId,
    },
  })
}

export async function orchestrateFaultInjection(
  req: FiOrchestrateRequest,
): Promise<FiOrchestrateResult> {
  if (!req.cases.length) {
    return { skipped: true, reason: 'no_fi_cases', taskIds: [], runIds: [], caseFaults: [] }
  }

  const { platforms, ok } = await listPlatformsFromWorkers(req.user)
  if (!ok) {
    throw new FiOrchestrateError(
      'no_online_worker',
      '无在线 FI Worker；请用与当前登录账号相同的 API Key 安装并启动 Worker',
    )
  }
  const platformInfo = platforms.find((p) => p.id === req.platform)
  if (!platformInfo || platformInfo.readiness !== 'ready') {
    throw new FiOrchestrateError(
      `platform_not_ready:${req.platform}`,
      `平台 ${req.platform} 不可用（需在线 Worker 上报就绪）`,
    )
  }

  const workspace = normalizeFiWorkspaceInput(req.workspace)
  const taskIds: string[] = []
  const runIds: string[] = []
  const caseFaults: FiOrchestrateResult['caseFaults'] = []

  for (const item of req.cases) {
    const { task, runs } = await createTaskWithRuns({
      user: req.user,
      name: `exp:${req.experimentId}:${item.caseId.slice(0, 8)}`,
      platform: req.platform,
      agent: req.agent,
      prompt: item.input,
      workspace,
      model: req.model || null,
      timeoutSeconds: req.timeoutSeconds ?? 180,
      items: [{ fault: item.fault, submode: item.submode || null }],
    })
    const runId = runs[0]?.id
    taskIds.push(task.id)
    if (runId) runIds.push(runId)
    caseFaults.push({
      caseId: item.caseId,
      fault: item.fault,
      taskId: task.id,
      runId,
    })
    if (runId) {
      await patchCaseFiMeta(item.caseId, {
        fault: item.fault,
        taskId: task.id,
        runId,
      })
    }
  }

  return {
    skipped: false,
    taskIds,
    runIds,
    caseFaults,
  }
}
