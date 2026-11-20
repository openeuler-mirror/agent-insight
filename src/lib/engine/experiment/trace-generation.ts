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

import { isStorageCoreEnabled } from '@/lib/storage-core/mode';
import { requireCoreExperimentContext } from '@/lib/storage-core/experiments';
import { readTraceEvidence } from '@/lib/storage-core/evidence';
import { ownsSkillExecution } from '@/lib/grayscale/execution-fence';
import type { SkillExecutionFence } from '@/lib/grayscale/run-progress';
import { normalizeAgentOptions, resolveAgentOptions, type AgentOptions } from '../../../../packages/agent-runtime/index.cjs';
import { withExperimentCancellation } from './cancellation-context';
import { mapConcurrent, parseExecutionConcurrency } from './execution-concurrency';
import { prisma } from '@/lib/storage/prisma';
import type { Prisma } from '@prisma/client';
import {
  DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS,
  MAX_EXPERIMENT_AGENT_TIMEOUT_SECONDS,
  MIN_EXPERIMENT_AGENT_TIMEOUT_SECONDS,
  TRIGGER_STARTUP_TIMEOUT_SECONDS,
} from '@/lib/engine/experiment/constants';
import { listClientTraceGenerationAvailability } from '@/lib/engine/experiment/execution-targets';
import { createCommand, getCommand, markSent } from '@/lib/reliability/command-bus';
import { dispatchCommand } from '@/lib/reliability/control-dispatch';
import { hasUsableTraceInteractions } from '@/lib/engine/experiment/fi-orchestrate';
import type { SkillExecutionSnapshot } from '@/lib/skill-workbench/execution-target';
import { executionModelMatches } from '@/lib/skill-workbench/execution-model';
import { readJiuwenSessionIndex } from '@/lib/ingest/otel/jiuwen/spool';
import { isTraceGenerationFailureRetryable } from './trace-retry-policy';
export { isTraceGenerationFailureRetryable } from './trace-retry-policy';

export type TraceGenerationCaseSpec = { caseId: string; input: string };

export type TraceGenerationRequest = {
  user: string;
  experimentId: string;
  workerId: string;
  platform: string;
  agent: string;
  model?: string | null;
  agentOptions?: AgentOptions;
  timeoutSeconds?: number;
  executionConcurrency?: number;
  cases: TraceGenerationCaseSpec[];
  skillExecution?: { version: 1; skill: SkillExecutionSnapshot | null }
    | { version: 2; mode: 'trigger'; targetSkillName: string; skills: SkillExecutionSnapshot[] };
  signal?: AbortSignal;
  retryFromAttemptId?: string | null;
  skillRun?: SkillExecutionFence;
  onAttemptCreated?: (attempt: { caseId: string; attemptId: string; attemptNo: number }) => Promise<boolean | void>;
};

export type TriggerDecision = {
  triggered: boolean;
  competingSkill: string | null;
  sessionId: string;
  actualModel: string;
};

export type TraceGenerationResult = {
  readyCaseIds: string[];
  failedCaseIds: string[];
  triggerDecisions?: Record<string, TriggerDecision>;
};

export type TraceGenerationOptions = {
  /** 用户明确点击 Trace 重试时开启：首轮必须新执行，历史 Attempt 不参与绑定。 */
  forceNewTrace?: boolean;
  reservedAttemptIds?: Record<string, string>;
};

export class TraceGenerationError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 503) {
    super(message);
    this.name = 'TraceGenerationError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const TERMINAL_COMMAND_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'EXPIRED', 'DELIVERY_FAILED']);
export const AUTO_RETRY_DELAYS_MS = [5_000, 20_000];
const TRACE_INGEST_TIMEOUT_MS = 60_000;

type CommandRow = NonNullable<Awaited<ReturnType<typeof getCommand>>> & { status: string };
type AttemptFailure = { code: string; message: string; retryable: boolean };
type PendingCase = TraceGenerationCaseSpec & {
  nextAttemptNo: number;
  cycleStartAttemptNo: number;
  reservedAttemptId?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseObject(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function readTriggerDecision(resultJson: string | null | undefined, targetSkillName: string, requestedModel?: string | null): TriggerDecision {
  const facts = parseObject(resultJson);
  const decision = facts.triggerDecision as Record<string, unknown> | undefined;
  if (facts.state !== 'AGENT_EXITED' || facts.eventMonitorReady !== true || facts.modelActivityObserved !== true
    || facts.timedOut !== false || facts.failureDetectedAt || !decision
    || decision.targetSkillName !== targetSkillName || typeof decision.triggered !== 'boolean'
    || typeof decision.sessionId !== 'string' || !decision.sessionId
    || typeof decision.actualModel !== 'string' || !decision.actualModel
    || decision.endReason !== (decision.triggered ? 'skill_loaded' : 'completed')
    || (!decision.triggered && (facts.exitCode !== 0 || facts.signal))) {
    throw new TraceGenerationError('TRIGGER_EVIDENCE_MISSING', '客户端未返回完整、可信的 Skill 路由判定证据');
  }
  if (requestedModel && !executionModelMatches(requestedModel, decision.actualModel)) {
    throw new TraceGenerationError('MODEL_MISMATCH', `配置模型 ${requestedModel} 与实际模型 ${decision.actualModel} 不一致，不进入触发评测`);
  }
  return {
    triggered: decision.triggered,
    competingSkill: typeof decision.competingSkill === 'string' ? decision.competingSkill : null,
    sessionId: decision.sessionId,
    actualModel: decision.actualModel,
  };
}

export function parseTraceIdFromCommandResult(resultJson: string | null | undefined): string | null {
  const traceId = parseObject(resultJson).traceId;
  return typeof traceId === 'string' && traceId.trim() ? traceId.trim() : null;
}

export async function traceIdFromCompletedCommand(resultJson: string | null | undefined, timeoutMs: number): Promise<string | null> {
  const direct = parseTraceIdFromCommandResult(resultJson);
  if (direct) return direct;
  const facts = parseObject(resultJson);
  const sessionId = typeof facts.sessionId === 'string' ? facts.sessionId : '';
  if (!/^web_[A-Za-z0-9_-]{8,100}$/.test(sessionId)) return null;
  const deadline = Date.now() + timeoutMs;
  do {
    const index = readJiuwenSessionIndex();
    const keys = index.sessionToKeys.get(sessionId);
    if (keys?.size === 1 && !index.multiTraceSessions.has(sessionId)) {
      const key = [...keys][0];
      if (/^[a-f0-9]{32}$/.test(key)) return `jiuwen-${key}`;
    }
    if (Date.now() >= deadline) return null;
    await sleep(1_000);
  } while (true);
}

export function isTraceGenerationCommandTerminal(status: string): boolean {
  return TERMINAL_COMMAND_STATUSES.has(status);
}

export function canReconcileGeneratedTraceAttempt(failureCode: string | null | undefined): boolean {
  return !failureCode || failureCode === 'TRACE_INGEST_TIMEOUT' || isTraceGenerationFailureRetryable(failureCode);
}

export function assertSkillExecutionOutput(execution: { finalResult?: string | null; model?: string | null }, requestedModel?: string | null) {
  if (!execution.finalResult?.trim()) throw new TraceGenerationError('AGENT_NO_OUTPUT', 'Agent 未生成有效输出，不进入评测');
  if (!requestedModel) return;
  if (!execution.model) throw new TraceGenerationError('MODEL_UNCONFIRMED', 'Trace 未记录实际执行模型，无法确认所选模型已生效，不进入评测');
  if (!executionModelMatches(requestedModel, execution.model)) {
    throw new TraceGenerationError('MODEL_MISMATCH', `配置模型 ${requestedModel} 与实际模型 ${execution.model} 不一致，不进入评测`);
  }
}

export function assertTriggerExecutionEvidence(execution: { clientId?: string | null; llmCallCount?: number | null }, workerId: string) {
  if (execution.clientId !== workerId) throw new TraceGenerationError('CLIENT_MISMATCH', 'Trace 未确认来自所选执行客户端，不进入触发评测');
  if (!execution.llmCallCount || execution.llmCallCount < 1) throw new TraceGenerationError('MODEL_NO_RESPONSE', 'Trace 未记录有效模型调用，不进入触发评测');
}

function commandFailure(command: CommandRow | null): AttemptFailure {
  if (!command) {
    return { code: 'COMMAND_MISSING', message: 'Trace 生成指令不存在', retryable: true };
  }
  const result = parseObject(command.resultJson);
  const code = command.errorCode
    || (command.status === 'EXPIRED' ? 'COMMAND_EXPIRED' : null)
    || (command.status === 'DELIVERY_FAILED' ? 'ACK_TIMEOUT' : null)
    || 'CASE_RUN_FAILED';
  const message = command.errorMessage
    || (typeof result.stderr === 'string' && result.stderr.trim() ? result.stderr.trim() : null)
    || (command.status === 'EXPIRED' ? '客户端执行指令已过期' : null)
    || (command.status === 'DELIVERY_FAILED' ? '客户端未确认收到执行指令' : null)
    || '客户端执行 Agent 失败';
  return { code, message, retryable: isTraceGenerationFailureRetryable(code) };
}

export async function collectTraceGenerationCases(
  experimentId: string,
): Promise<TraceGenerationCaseSpec[]> {
  {
    const snapshot = await requireCoreExperimentContext().rpc('read', {experiment_id: experimentId}) as {experiment: {cases: Array<{id: string; input: string; executionId?: string}>}};
    return snapshot.experiment.cases.filter(row => !row.executionId && row.input.trim()).map(row => ({caseId: row.id, input: row.input.trim()}));
  }
}

export async function assertTraceGenerationTarget(input: {
  user: string;
  workerId: string;
  platform: string;
  agent: string;
  agentOptions?: unknown;
}) {
  const { targets, diagnostics } = await listClientTraceGenerationAvailability(input.user);
  const target = targets.find((item) =>
    item.workerId === input.workerId
    && item.platform === input.platform
    && item.agent === input.agent);
  if (!target) {
    throw new TraceGenerationError(
      'execution_target_unavailable',
      diagnostics.find(item => (!item.clientId || item.clientId === input.workerId) && (!item.platform || item.platform === input.platform))?.message
        || '所选客户端未发现该 Agent，或客户端归属已变化；请刷新执行目标后重试',
    );
  }
  return resolveAgentOptions(target.parameterDefinitions || [], input.platform, input.agent, input.agentOptions);
}

export async function waitForCommand(commandId: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandRow | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    signal?.throwIfAborted();
    const command = await getCommand(commandId);
    if (!command) return null;
    if (isTraceGenerationCommandTerminal(command.status)) return command as CommandRow;
    if (command.expiresAt.getTime() <= Date.now()) {
      return { ...command, status: 'EXPIRED' } as CommandRow;
    }
    await sleep(1_000);
  }
  const command = await getCommand(commandId);
  return command ? { ...command, status: 'EXPIRED' } as CommandRow : null;
}

export async function findExecutionByTraceId(input: {
  user: string;
  traceId: string;
  completedTriggerCommand?: { status: string; resultJson: string | null };
}) {
  {
    const context = requireCoreExperimentContext();
    try {
      const {evidence} = await readTraceEvidence(context.request, {taskId: input.traceId}, context.options);
      if (!evidence.session || !hasUsableTraceInteractions(JSON.stringify(evidence.session.interactions))) return null;
      if (!evidence.execution || evidence.execution.user !== input.user) return null;
      if (!evidence.session.endTime && (!completedTriggerRunHasEvidence(input.completedTriggerCommand, input.traceId) || !evidence.execution.finalResult?.trim())) return null;
      return evidence.execution as unknown as NonNullable<Awaited<ReturnType<typeof prisma.execution.findFirst>>>;
    } catch (error) {if ([404,422,503].includes((error as {status?: number}).status || 0)) return null; throw error;}
  }
}

async function waitForExecutionByTraceId(input: {
  user: string;
  traceId: string;
  timeoutMs: number;
  signal?: AbortSignal;
  completedTriggerCommand?: { status: string; resultJson: string | null };
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < input.timeoutMs) {
    input.signal?.throwIfAborted();
    const execution = await findExecutionByTraceId(input);
    if (execution) return execution;
    await sleep(2_000);
  }
  return null;
}

async function bindExecution(input: {
  caseId: string;
  attemptId: string;
  traceId: string;
  execution: { id: string; taskId: string | null; finalResult: string | null };
  skillRun?: SkillExecutionFence;
}): Promise<boolean> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const locked = await tx.experimentCase.updateMany({
      where: { id: input.caseId, deletedAt: null, experiment: { deletedAt: null, status: { not: 'cancelled' } } },
      data: { id: input.caseId },
    });
    if (!locked.count || !await ownsSkillExecution(tx, input.skillRun)) return false;
    const attempt = await tx.experimentTraceAttempt.findUnique({ where: { id: input.attemptId } });
    if (!attempt || attempt.traceId && attempt.traceId !== input.traceId || ['cancelled', 'superseded'].includes(attempt.status) || attempt.failureCode === 'EXPERIMENT_CANCELLED') return false;
    const newer = await tx.experimentTraceAttempt.count({ where: { caseId: input.caseId,
      attemptNo: { gt: attempt.attemptNo } } });
    if (newer) return false;
    if (attempt.status === 'ready') return true;
    if (await tx.experimentTraceAttempt.count({ where: { caseId: input.caseId, attemptNo: { lt: attempt.attemptNo }, traceId: input.traceId } })) {
      throw new TraceGenerationError('TRACE_ID_REUSED', '客户端返回了历史执行的 Trace ID，无法确认本次主链路', 409);
    }
    await tx.experimentCase.update({ where: { id: input.caseId }, data: {
      executionId: input.execution.id, taskId: input.traceId, actualOutput: input.execution.finalResult || '', traceGenerationError: null,
    } });
    await tx.experimentTraceAttempt.update({ where: { id: input.attemptId }, data: {
      traceId: input.traceId, status: 'ready', failureCode: null, errorMessage: null, finishedAt: new Date(),
    } });
    await tx.experimentTraceAttempt.updateMany({ where: { caseId: input.caseId, id: { not: input.attemptId },
      attemptNo: { lt: attempt.attemptNo }, status: { not: 'ready' } }, data: { status: 'superseded', finishedAt: new Date() } });
    return true;
  });
}

export async function reconcileGeneratedTraceCase(input: {
  user: string;
  caseId: string;
  minAttemptNo?: number;
} ): Promise<boolean> {
  {
    const context = requireCoreExperimentContext();
    const identity = await context.rpc('case_lookup', {case_id: input.caseId}) as {experiment_id: string};
    const snapshot = await context.rpc('read', {experiment_id: identity.experiment_id, case_ids: [input.caseId]}) as {experiment: {cases: Array<{id: string; traceAttempts: Array<{id: string; failureCode?: string; commandId?: string; traceId?: string; attemptNo: number}>}>}};
    const attempt = snapshot.experiment.cases[0]?.traceAttempts[0];
    if (!attempt || !canReconcileGeneratedTraceAttempt(attempt.failureCode) || (input.minAttemptNo && attempt.attemptNo < input.minAttemptNo)) return false;
    const traceId = attempt.traceId || await traceIdFromCompletedCommand(attempt.commandId ? (await getCommand(attempt.commandId))?.resultJson : null, 0);
    if (!traceId) return false;
    const payload = {experiment_id: identity.experiment_id, case_id: input.caseId, attempt_id: attempt.id, command_id: attempt.commandId, trace_id: traceId};
    const result = await context.rpc('execute_reconcile', {...payload, operation_key: `trace-reconcile:${attempt.id}:${traceId}`, operation_request: payload}) as {ready?: boolean};
    return result.ready === true;
  }
}

export async function reserveTraceRetry(req: TraceGenerationRequest): Promise<Record<string, string>> {
  {
    const runId = await (await import('@/lib/storage-core/experiment-trace-worker')).prepareCoreTraceRun(requireCoreExperimentContext(), req, true);
    return Object.fromEntries(req.cases.map(item => [item.caseId, runId]));
  }
}

async function runAttempt(input: {
  req: TraceGenerationRequest;
  item: PendingCase;
  timeoutSeconds: number;
  canRetry: boolean;
  reconcilePrevious: boolean;
}): Promise<{ ready: boolean; failure?: AttemptFailure; triggerDecision?: TriggerDecision }> {
  const { assertExperimentActive } = await import('./cancellation-context');
  if (input.req.signal?.aborted) return { ready: false, failure: { code: 'EXPERIMENT_CANCELLED', message: '实验已取消', retryable: false } };
  try { await assertExperimentActive(input.req.experimentId, input.item.caseId); }
  catch (error) {
    if ((error as { code?: string }).code !== 'EXPERIMENT_CANCELLED') throw error;
    return { ready: false, failure: { code: 'EXPERIMENT_CANCELLED', message: '用户停止并删除', retryable: false } };
  }
  if (!input.req.skillExecution && input.reconcilePrevious && await reconcileGeneratedTraceCase({
    user: input.req.user,
    caseId: input.item.caseId,
    minAttemptNo: input.item.cycleStartAttemptNo,
  })) {
    return { ready: true };
  }

  const createAttempt = {
    data: {
      experimentId: input.req.experimentId,
      caseId: input.item.caseId,
      attemptNo: input.item.nextAttemptNo,
      workerId: input.req.workerId,
      platform: input.req.platform,
      agent: input.req.agent,
      model: input.req.model || null,
      timeoutSeconds: input.timeoutSeconds,
      status: 'dispatching',
      startedAt: new Date(),
    },
  };
  const claimAttempt = async () => prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const locked = await tx.experiment.updateMany({ where: { id: input.req.experimentId, deletedAt: null, status: { not: 'cancelled' } }, data: { updatedAt: new Date() } });
    if (!locked.count) throw new TraceGenerationError('EXPERIMENT_CANCELLED', '实验已取消', 409);
    const latest = await tx.experimentTraceAttempt.findFirst({ where: { caseId: input.item.caseId }, orderBy: { attemptNo: 'desc' } });
    const reserved = input.item.reservedAttemptId ? latest?.id === input.item.reservedAttemptId && latest.status === 'queued' : false;
    if (input.item.reservedAttemptId && !reserved || !input.item.reservedAttemptId && latest && latest.attemptNo >= input.item.nextAttemptNo) {
      throw new TraceGenerationError('trace_retry_in_progress', '该 Case 已切换执行轮次', 409);
    }
    const activeStatuses = ['dispatching', 'running', 'waiting_trace'];
    if (latest && activeStatuses.includes(latest.status)) throw new TraceGenerationError('trace_retry_in_progress', '该 Case 正在生成 Trace', 409);
    const experiment = await tx.experiment.findUnique({ where: { id: input.req.experimentId }, select: { configSnapshotJson: true } });
    const concurrency = parseExecutionConcurrency(parseObject(experiment?.configSnapshotJson).executionConcurrency ?? input.req.executionConcurrency);
    if (await tx.experimentTraceAttempt.count({ where: { experimentId: input.req.experimentId, status: { in: activeStatuses } } }) >= concurrency) return null;
    await tx.experimentTraceAttempt.updateMany({ where: { caseId: input.item.caseId, status: 'retry_wait' }, data: { status: 'superseded', finishedAt: new Date() } });
    return reserved
      ? tx.experimentTraceAttempt.update({ where: { id: input.item.reservedAttemptId }, data: { status: 'dispatching', startedAt: new Date() } })
      : tx.experimentTraceAttempt.create({ data: { ...createAttempt.data, startedAt: new Date() } });
  });
  let attempt = input.req.skillExecution && !input.item.reservedAttemptId
    ? await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.experimentCase.updateMany({ where: { id: input.item.caseId }, data: { id: input.item.caseId } });
      if (!await ownsSkillExecution(tx, input.req.skillRun)) throw new TraceGenerationError('EXECUTION_SUPERSEDED', '该执行已被新的重试替换', 409);
      return tx.experimentTraceAttempt.create(createAttempt);
    }) : await claimAttempt();
  while (!attempt) {
    input.req.signal?.throwIfAborted();
    await sleep(100);
    attempt = await claimAttempt();
  }


  let failure: AttemptFailure | null = null;
  let observedTraceId: string | null = null;
  let detachCancellation: (() => void) | undefined;
  let cancellation: Promise<void> | undefined;
  const startupSeconds = input.req.skillExecution?.version === 2 ? TRIGGER_STARTUP_TIMEOUT_SECONDS : 0;
  const commandWaitMs = (input.timeoutSeconds + startupSeconds + 90) * 1_000;
  try {
    if (await input.req.onAttemptCreated?.({ caseId: input.item.caseId, attemptId: attempt.id, attemptNo: attempt.attemptNo }) === false) {
      throw new TraceGenerationError('EXECUTION_SUPERSEDED', '该执行已被新的重试替换', 409);
    }
    const frame = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const activeCase = await tx.experimentCase.findFirst({ where: { id: input.item.caseId, deletedAt: null, experiment: { deletedAt: null, status: { not: 'cancelled' } } } });
      if (!activeCase || !await ownsSkillExecution(tx, input.req.skillRun) || await tx.experimentTraceAttempt.count({ where: { caseId: input.item.caseId, attemptNo: { gt: attempt.attemptNo } } })) throw Object.assign(new Error('实验或 Case 已取消'), { code: 'EXPERIMENT_CANCELLED' });
      const command = await createCommand({
      user: input.req.user,
      clientId: input.req.workerId,
      action: 'RUN_EXPERIMENT_CASE',
      ttlMs: commandWaitMs,
      payload: {
        platform: input.req.platform,
        agent: input.req.agent,
        model: input.req.model || null,
        ...(input.req.agentOptions ? { agentOptions: input.req.agentOptions } : {}),
        input: input.item.input,
        timeoutSeconds: input.timeoutSeconds,
        ...(startupSeconds ? { startupTimeoutSeconds: startupSeconds } : {}),
        ...(input.req.skillExecution ? { skillExecution: input.req.skillExecution } : {}),
        correlation: {
          experimentId: input.req.experimentId,
          experimentRunId: input.req.experimentId,
          caseRunId: input.item.caseId,
          traceAttemptId: attempt.id,
        },
      },
      }, tx);
      await tx.experimentTraceAttempt.update({
        where: { id: attempt.id },
        data: { commandId: command.commandId, status: 'running' },
      });
      await tx.experimentCase.update({
        where: { id: input.item.caseId },
        data: { traceGenerationCommandId: command.commandId, traceGenerationError: null },
      });
      return command;
    });

    const cancel = () => {
      cancellation ??= (async () => {
        const stop = await createCommand({ user: input.req.user, clientId: input.req.workerId,
          action: 'CANCEL_EXPERIMENT_RUN', payload: { kind: 'ordinary', runId: frame.commandId } });
        const sent = await dispatchCommand(input.req.workerId, stop);
        if (sent.delivered) await markSent(stop.commandId, 'wss');
      })();
      void cancellation.catch(() => undefined);
    };
    input.req.signal?.addEventListener('abort', cancel, { once: true });
    detachCancellation = () => input.req.signal?.removeEventListener('abort', cancel);
    if (input.req.signal?.aborted) cancel();
    input.req.signal?.throwIfAborted();
    await assertExperimentActive(input.req.experimentId, input.item.caseId);
    await dispatchTraceGenerationCommand(input.req.workerId, frame);
    const command = await waitForCommand(frame.commandId, commandWaitMs, input.req.signal);
    const traceId = command?.status === 'SUCCEEDED'
      ? await traceIdFromCompletedCommand(command.resultJson, TRACE_INGEST_TIMEOUT_MS)
      : parseTraceIdFromCommandResult(command?.resultJson);
    observedTraceId = traceId;
    if (traceId && await prisma.experimentTraceAttempt.count({ where: { caseId: input.item.caseId, attemptNo: { lt: attempt.attemptNo }, traceId } })) {
      observedTraceId = null;
      throw new TraceGenerationError('TRACE_ID_REUSED', '客户端返回了历史执行的 Trace ID，无法确认本次主链路', 409);
    }
    if (!command || command.status !== 'SUCCEEDED') {
      failure = commandFailure(command);
    } else if (input.req.skillExecution?.version === 2) {
      if (command.clientId !== input.req.workerId) {
        throw new TraceGenerationError('CLIENT_MISMATCH', '触发分析结果不是来自所选客户端');
      }
      const decision = readTriggerDecision(command.resultJson, input.req.skillExecution.targetSkillName, input.req.model);
      await assertExperimentActive(input.req.experimentId, input.item.caseId);
      input.req.signal?.throwIfAborted();
      const applied = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.experimentCase.updateMany({ where: { id: input.item.caseId }, data: { id: input.item.caseId } });
        if (!await ownsSkillExecution(tx, input.req.skillRun)) return false;
        await Promise.all([
        tx.experimentTraceAttempt.update({
          where: { id: attempt.id },
          data: { status: 'ready', traceId: traceId || null, failureCode: null, errorMessage: null, finishedAt: new Date() },
        }),
        tx.experimentCase.update({
          where: { id: input.item.caseId },
          data: { actualOutput: decision.triggered ? 'Skill 已触发' : 'Skill 未触发', traceGenerationError: null },
        }),
        ]);
        return true;
      });
      if (!applied) return { ready: false };
      return { ready: true, triggerDecision: decision };
    } else {
      if (!traceId) {
        failure = {
          code: 'TRACE_ID_MISSING',
          message: '客户端执行成功但未返回 Trace ID，已拒绝按输入猜测绑定',
          retryable: false,
        };
      } else {
        const advanced = await prisma.experimentTraceAttempt.updateMany({
          where: { id: attempt.id, status: 'running', OR: [{ traceId: null }, { traceId }], case: { traceAttempts: { none: { attemptNo: { gt: attempt.attemptNo } } } } },
          data: { traceId, status: 'waiting_trace' },
        });
        if (!advanced.count) return { ready: false };
        const execution = await waitForExecutionByTraceId({
          user: input.req.user,
          traceId,
          signal: input.req.signal,
          timeoutMs: TRACE_INGEST_TIMEOUT_MS,
        });
        if (execution) {
          if (input.req.skillExecution) assertSkillExecutionOutput(execution, input.req.model);
          await assertExperimentActive(input.req.experimentId, input.item.caseId);
          input.req.signal?.throwIfAborted();
          const bound = await bindExecution({
            caseId: input.item.caseId,
            attemptId: attempt.id,
            traceId,
            execution,
            skillRun: input.req.skillRun,
          });
          return { ready: bound };
        }
        failure = {
          code: 'TRACE_INGEST_TIMEOUT',
          message: `Agent 已执行结束，但 Trace ${traceId} 未在 60 秒内完成入库。请检查采集器和上传日志；本次不会自动重新执行 Agent。`,
          retryable: false,
        };
      }
    }
  } catch (error) {
    const code = input.req.signal?.aborted ? 'EXPERIMENT_CANCELLED' : error instanceof TraceGenerationError ? error.code : 'CASE_RUN_FAILED';
    failure = {
      code,
      message: error instanceof Error ? error.message : String(error || 'Trace 生成失败'),
      retryable: isTraceGenerationFailureRetryable(code),
    };
  } finally {
    detachCancellation?.();
    if (cancellation) await cancellation.catch(() => undefined);
  }

  const settledFailure = failure || {
    code: 'CASE_RUN_FAILED',
    message: 'Trace 生成失败',
    retryable: true,
  };
  const retrying = settledFailure.retryable && input.canRetry;
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.experimentCase.updateMany({ where: { id: input.item.caseId }, data: { id: input.item.caseId } });
    await tx.experimentTraceAttempt.updateMany({
      where: { id: attempt.id, status: { in: ['dispatching', 'running', 'waiting_trace'] } },
      data: {
        status: retrying ? 'retry_wait' : 'failed',
        traceId: observedTraceId || undefined,
        failureCode: settledFailure.code,
        errorMessage: settledFailure.message.slice(0, 2_000),
        finishedAt: retrying ? null : new Date(),
      },
    });
    if (!await ownsSkillExecution(tx, input.req.skillRun)) return;
    await tx.experimentCase.updateMany({
      where: { id: input.item.caseId, traceGenerationCommandId: attempt.commandId || undefined, deletedAt: null, experiment: { deletedAt: null, status: { not: 'cancelled' } }, traceAttempts: { none: { attemptNo: { gt: attempt.attemptNo } } } },
      data: { traceGenerationError: retrying ? null : settledFailure.message.slice(0, 2_000) },
    });
  });
  return { ready: false, failure: settledFailure };
}

export async function generateExperimentTraces(
  req: TraceGenerationRequest,
  options: TraceGenerationOptions = {},
): Promise<TraceGenerationResult> {
  return (await import('@/lib/storage-core/experiment-trace-worker')).generateCoreExperimentTraces(requireCoreExperimentContext(), req, options);
}

export async function loadTraceGenerationRetryRequest(input: {
  user: string;
  experimentId: string;
  caseId: string;
} ): Promise<TraceGenerationRequest | null> {
  {
    const context = requireCoreExperimentContext();
    const snapshot = await context.rpc('read', {experiment_id: input.experimentId, case_ids: [input.caseId]}) as {experiment: {cases: Array<{id: string; input: string; traceAttempts: Array<{id: string; status: string; workerId: string; platform: string; agent: string; model?: string; timeoutSeconds: number; commandId?: string}>}>}};
    const row = snapshot.experiment.cases[0];
    if (!row?.input?.trim()) return null;
    const attempt = row.traceAttempts[0];
    if (!attempt) return null;
    if (['queued','dispatching','running','waiting_trace','retry_wait'].includes(attempt.status)) throw new TraceGenerationError('trace_retry_in_progress','该 Case 正在生成 Trace',409);
    const payload = attempt.commandId ? parseObject((await getCommand(attempt.commandId))?.payloadJson) : {};
    return {user: context.actor.username, experimentId: input.experimentId, retryFromAttemptId: attempt.id, workerId: attempt.workerId, platform: attempt.platform, agent: attempt.agent, model: attempt.model, timeoutSeconds: attempt.timeoutSeconds, agentOptions: normalizeAgentOptions(payload.agentOptions), ...(payload.skillExecution ? {skillExecution: payload.skillExecution as NonNullable<TraceGenerationRequest['skillExecution']>} : {}), cases: [{caseId: row.id, input: row.input.trim()}]};
  }
}

export async function dispatchTraceGenerationCommand(workerId: string, frame: Awaited<ReturnType<typeof createCommand>>): Promise<void> {
  const dispatched = await dispatchCommand(workerId, frame);
  if (dispatched.delivered) await markSent(frame.commandId, 'wss');
}

export async function cancelTraceGenerationCommand(user: string, workerId: string, commandId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  do {
    const stop = await createCommand({user, clientId: workerId, action: 'CANCEL_EXPERIMENT_RUN', payload: {kind: 'ordinary', runId: commandId}});
    await dispatchTraceGenerationCommand(workerId, stop);
    const receipt = await waitForCommand(stop.commandId, Math.max(1, deadline - Date.now()));
    const facts = parseObject(receipt?.resultJson);
    const result = facts.result && typeof facts.result === 'object' ? facts.result as Record<string, unknown> : facts;
    if (receipt?.status === 'SUCCEEDED' && result.status === 'cancelled') return;
    await sleep(250);
  } while (Date.now() < deadline);
  throw Object.assign(new Error('客户端进程停止尚未确认，已禁止重试'), {code: 'EVALUATION_CLEANUP_UNCONFIRMED', status: 409});
}

function completedTriggerRunHasEvidence(command: {status: string; resultJson: string | null} | undefined, traceId: string): boolean {
  const facts = parseObject(command?.resultJson);
  return command?.status === 'SUCCEEDED'
    && facts.state === 'AGENT_EXITED'
    && facts.traceId === traceId
    && facts.exitCode === 0
    && facts.timedOut === false
    && !facts.signal
    && !facts.failureDetectedAt
    && facts.modelActivityObserved === true;
}
