import {findCoreFiRun,coreFiRpc,coreFiOwner} from '@/lib/storage-core/fault-injection'
/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * 外挂 FI 编排：在 startExperimentRun 之前按 case 的 faultInjectionType 创建 FI 任务。
 * 禁止写入 run-experiment 内核 I/O；本模块只调用 store/createTaskWithRuns。
 * FI 元数据写入 ExperimentCase 独立列，禁止污染 evaluatorContextJson。
 *
 * 生成 Trace 契约：创建 Run → 等 Worker/collect 回填 sessionTaskId → 写入 Case.taskId → 再评测。
 */
import { readTraceEvidence } from '@/lib/storage-core/evidence'
import { isStorageCoreEnabled } from '@/lib/storage-core/mode'
import { requireCoreExperimentContext } from '@/lib/storage-core/experiments'
import { createTaskWithRuns, refreshTaskProgress } from '@/lib/fault-injection/store'
import {
  listPlatformsFromWorkers,
  listWorkerExecutionTargets,
} from '@/lib/fault-injection/worker-protocol'
import { normalizeFiWorkspaceInput } from '@/lib/fault-injection/workspace'
import { prisma } from '@/lib/storage/prisma'
import { resolveCaseFaultInjectionType } from '@/lib/engine/experiment/case-fi-meta'
import { DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS } from '@/lib/engine/experiment/constants'
import { isFiBusinessTraceUsable, isFiTraceWaitExpired, FI_TRACE_ARRIVAL_GRACE_MS } from '@/lib/fault-injection/trace-readiness'
export { isFiBusinessTraceUsable } from '@/lib/fault-injection/trace-readiness'

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
  {
    const snapshot = await requireCoreExperimentContext().rpc('read',{experiment_id: experimentId}) as {experiment: {cases: Array<{id: string; input: string; executionId?: string; faultInjectionType?: string; faultInjectionSubmode?: string}>}}
    return snapshot.experiment.cases.filter(row => !row.executionId && Boolean(resolveCaseFaultInjectionType(row))).map(row => ({caseId: row.id, input: row.input, fault: resolveCaseFaultInjectionType(row)!, submode: row.faultInjectionSubmode}))
  }
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
  return (await import('@/lib/storage-core/experiment-fi-worker')).orchestrateCoreFi(requireCoreExperimentContext(), req)
}

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
export async function findFiRunByKey(runKey: string) {
  return findCoreFiRun(runKey)
}

/**
 * 仅当 sessionTaskId 对应到已结束的业务 Session 与同 Agent 的 Execution 时，才把它们回填到 Case。
 * 兼容历史 fiRunId=cuid 与正确的 ras- runId。
 */
export async function bindExperimentCaseToFiSession(input: {
  fiRunKey: string
  sessionTaskId: string
}): Promise<number> {
  {
    const context = requireCoreExperimentContext()
    const identity = await context.rpc('case_lookup',{fi_run_id: input.fiRunKey}) as {experiment_id: string; case_id: string}
    const snapshot = await context.rpc('read',{experiment_id: identity.experiment_id, case_ids: [identity.case_id]}) as {experiment: {cases: Array<{taskId?: string; executionId?: string}>}}
    const row = snapshot.experiment.cases[0]
    return row?.taskId === input.sessionTaskId && row.executionId ? 1 : 0
  }
}

/**
 * 等待 FI collect 对齐平台 Session，并在 Trace 完整可用后回填 ExperimentCase。
 * 默认等待窗口到期即返回；批量模式持续等待活动 Run，终态仅保留有限回传宽限期。
 * 取消/删除通过 shouldContinue 中止；调用方只允许 readyRunIds 对应的 Case 进入评估。
 */
export async function awaitFiSessionsAndBindExperimentCases(input: {
  runIds: string[]
  timeoutMs?: number
  pollMs?: number
  /** Keep queued/running work alive beyond the initial collection window. */
  waitForActiveRuns?: boolean
  /** Bound the wait for an already finished run whose trace arrives late. */
  traceWaitMs?: number
  shouldContinue?: () => Promise<boolean>
}): Promise<{
  bound: number
  readyRunIds: string[]
  pendingRunIds: string[]
  failedRunIds: string[]
}> {
  {
    const readyRunIds: string[] = [], pendingRunIds: string[] = [], failedRunIds: string[] = []
    for (const id of input.runIds) {
      const run = await findFiRunByKey(id)
      if (!run || run.user !== requireCoreExperimentContext().actor.username) {failedRunIds.push(id);continue}
      if (run.sessionTaskId && await bindExperimentCaseToFiSession({fiRunKey: id, sessionTaskId: run.sessionTaskId})) readyRunIds.push(id)
      else if (['completed','judge_skipped','failed','stopped'].includes(run.status)) failedRunIds.push(id)
      else pendingRunIds.push(id)
    }
    return {bound: readyRunIds.length, readyRunIds, pendingRunIds, failedRunIds}
  }
}

export async function assertFiExecutionTarget(req: FiOrchestrateRequest): Promise<void> {
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

}

export async function createFiCaseTask(req: FiOrchestrateRequest, item: FiOrchestrateCaseSpec, stable?: {taskKey: string; runIds: string[]}) {
  return createTaskWithRuns({user: req.user, name: `exp:${req.experimentId}:${item.caseId.slice(0,8)}`, platform: req.platform, agent: req.agent, prompt: item.input, workspace: normalizeFiWorkspaceInput(req.workspace), model: req.model || null, timeoutSeconds: req.timeoutSeconds ?? DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS, targetWorkerId: req.targetWorkerId || null, items: [{fault: item.fault, submode: item.submode || null}]}, stable)
}

export async function cancelFiExecution(user: string, runId: string): Promise<void> {
  {
    coreFiOwner(user);await coreFiRpc('cancel',{runId})
    const deadline=Date.now()+30000
    do {const current=await findCoreFiRun(runId);if(!current||['completed','judge_skipped','failed','stopped'].includes(current.status))return;await sleep(250)} while(Date.now()<deadline)
    throw Object.assign(new Error('FI进程停止尚未确认，已禁止重试'),{code:'EVALUATION_CLEANUP_UNCONFIRMED',status:409})
  }
}

export async function isCoreFiBusinessTraceReady(input: {sessionTaskId: string; platform: string; agent: string}): Promise<boolean> {
  const context = requireCoreExperimentContext()
  try {
    const {evidence} = await readTraceEvidence(context.request,{taskId: input.sessionTaskId},context.options)
    if (evidence.execution.user !== context.actor.username) return false
    return isFiBusinessTraceUsable({platform: input.platform, agent: input.agent, executionAgent: typeof evidence.execution.agentName === 'string' ? evidence.execution.agentName : null, interactions: JSON.stringify(evidence.session.interactions), endTime: evidence.session.endTime ? new Date(String(evidence.session.endTime)) : null})
  } catch (error) {if ([404,422,503].includes((error as {status?: number}).status || 0)) return false;throw error}
}
