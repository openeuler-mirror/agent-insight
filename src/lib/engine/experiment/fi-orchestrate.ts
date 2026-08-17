/**
 * 外挂 FI 编排：在 startExperimentRun 之前按 case 的 faultInjectionType 创建 FI 任务。
 * 禁止写入 run-experiment 内核 I/O；本模块只调用 store/createTaskWithRuns。
 * FI 元数据写入 ExperimentCase 独立列，禁止污染 evaluatorContextJson。
 *
 * 生成 Trace 契约：创建 Run → 等 Worker/collect 回填 sessionTaskId → 写入 Case.taskId → 再评测。
 */
import { createTaskWithRuns } from '@/lib/fault-injection/store'
import {
  listPlatformsFromWorkers,
  listWorkerExecutionTargets,
} from '@/lib/fault-injection/worker-protocol'
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
  targetWorkerId?: string | null
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

/** 从实验 case 中提取需要 FI 的条目（只有已绑定有效 Execution 的才跳过）。 */
export async function collectFiCasesFromExperiment(experimentId: string): Promise<FiOrchestrateCaseSpec[]> {
  const cases = await prisma.experimentCase.findMany({
    where: { experimentId },
    orderBy: { createdAt: 'asc' },
  })
  const out: FiOrchestrateCaseSpec[] = []
  for (const item of cases) {
    if (item.executionId) continue
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

  if (req.targetWorkerId) {
    const targets = await listWorkerExecutionTargets(req.user)
    const target = targets.find((item) =>
      item.workerId === req.targetWorkerId
      && item.platform === req.platform
      && item.agent === req.agent)
    if (!target) {
      throw new FiOrchestrateError(
        'execution_target_unavailable',
        '所选运行主机已离线，或不再提供该 Agent 的执行能力',
      )
    }
  } else {
    const { platforms, ok } = await listPlatformsFromWorkers(req.user)
    if (!ok) {
      throw new FiOrchestrateError(
        'no_online_worker',
        '无在线 FI Worker；请检查客户端配置与在线状态',
      )
    }
    const platformInfo = platforms.find((p) => p.id === req.platform)
    if (!platformInfo || platformInfo.readiness !== 'ready') {
      throw new FiOrchestrateError(
        `platform_not_ready:${req.platform}`,
        `平台 ${req.platform} 不可用（需在线客户端上报就绪）`,
      )
    }
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
      targetWorkerId: req.targetWorkerId || null,
      items: [{ fault: item.fault, submode: item.submode || null }],
    })
    // 必须用业务 runId（ras-…），禁止 Prisma cuid：Worker/collect/API 一律按 runId 关联。
    const runId = runs[0]?.runId
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

const FI_TERMINAL_WITHOUT_SESSION = new Set([
  'failed',
  'stopped',
])

export function hasUsableTraceInteractions(value: string | null | undefined): boolean {
  if (!value) return false
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) && parsed.length > 0
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 按业务 runId 或历史误写入的 Prisma id 查找 FI Run。 */
async function findFiRunByKey(runKey: string) {
  return prisma.faultInjectionRun.findFirst({
    where: { OR: [{ runId: runKey }, { id: runKey }] },
    select: {
      id: true,
      runId: true,
      status: true,
      sessionTaskId: true,
      error: true,
      user: true,
    },
  })
}

/**
 * 仅当 sessionTaskId 已经对应到非空 Session trace 与 Execution 时，才把它们回填到 Case。
 * 兼容历史 fiRunId=cuid 与正确的 ras- runId。
 */
export async function bindExperimentCaseToFiSession(input: {
  fiRunKey: string
  sessionTaskId: string
}): Promise<number> {
  const sessionTaskId = input.sessionTaskId.trim()
  if (!sessionTaskId) return 0

  const run = await findFiRunByKey(input.fiRunKey)
  const keys = Array.from(
    new Set([input.fiRunKey, run?.runId, run?.id].filter((v): v is string => Boolean(v))),
  )
  if (!keys.length) return 0

  const [execution, session] = await Promise.all([
    prisma.execution.findFirst({
      where: { taskId: sessionTaskId, isSubagent: false, ...(run?.user ? { user: run.user } : {}) },
      orderBy: { timestamp: 'desc' },
      select: { id: true },
    }),
    prisma.session.findUnique({
      where: { taskId: sessionTaskId },
      select: { interactions: true, endTime: true },
    }),
  ])
  if (!execution || !session?.endTime || !hasUsableTraceInteractions(session.interactions)) return 0

  const result = await prisma.experimentCase.updateMany({
    where: {
      fiRunId: { in: keys },
    },
    data: {
      taskId: sessionTaskId,
      executionId: execution.id,
    },
  })
  return result.count
}

/**
 * 等待 FI collect 对齐平台 Session，并在 Trace 完整可用后回填 ExperimentCase。
 * 超时不抛错：调用方只允许 readyRunIds 对应的 Case 进入评估。
 */
export async function awaitFiSessionsAndBindExperimentCases(input: {
  runIds: string[]
  timeoutMs?: number
  pollMs?: number
}): Promise<{
  bound: number
  readyRunIds: string[]
  pendingRunIds: string[]
  failedRunIds: string[]
}> {
  const runIds = Array.from(new Set(input.runIds.filter(Boolean)))
  if (!runIds.length) {
    return { bound: 0, readyRunIds: [], pendingRunIds: [], failedRunIds: [] }
  }

  const timeoutMs = Math.max(5_000, input.timeoutMs ?? 240_000)
  const pollMs = Math.max(500, input.pollMs ?? 2_000)
  const started = Date.now()
  const ready = new Set<string>()
  const failed = new Set<string>()
  let bound = 0

  while (Date.now() - started < timeoutMs) {
    for (const runKey of runIds) {
      if (ready.has(runKey) || failed.has(runKey)) continue
      const run = await findFiRunByKey(runKey)
      if (!run) {
        failed.add(runKey)
        continue
      }
      if (run.sessionTaskId) {
        const count = await bindExperimentCaseToFiSession({
          fiRunKey: runKey,
          sessionTaskId: run.sessionTaskId,
        })
        if (count > 0) {
          bound += count
          ready.add(runKey)
          continue
        }
      }
      if (FI_TERMINAL_WITHOUT_SESSION.has(run.status) && !run.sessionTaskId) {
        failed.add(runKey)
      }
    }
    if (ready.size + failed.size >= runIds.length) break
    await sleep(pollMs)
  }

  const pendingRunIds = runIds.filter((id) => !ready.has(id) && !failed.has(id))
  return {
    bound,
    readyRunIds: Array.from(ready),
    pendingRunIds,
    failedRunIds: Array.from(failed),
  }
}
