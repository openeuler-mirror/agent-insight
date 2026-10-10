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
import { listClientTraceGenerationTargets } from '@/lib/engine/experiment/execution-targets';
import { createCommand, getCommand, markSent } from '@/lib/reliability/command-bus';
import { dispatchCommand } from '@/lib/reliability/control-dispatch';
import { hasUsableTraceInteractions } from '@/lib/engine/experiment/fi-orchestrate';
import type { SkillExecutionSnapshot } from '@/lib/skill-workbench/execution-target';
import { executionModelMatches } from '@/lib/skill-workbench/execution-model';
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
  timeoutSeconds?: number;
  executionConcurrency?: number;
  cases: TraceGenerationCaseSpec[];
  skillExecution?: { version: 1; skill: SkillExecutionSnapshot | null }
    | { version: 2; mode: 'trigger'; targetSkillName: string; skills: SkillExecutionSnapshot[] };
  signal?: AbortSignal;
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
const AUTO_RETRY_DELAYS_MS = [5_000, 20_000];
const TRACE_INGEST_TIMEOUT_MS = 60_000;

type CommandRow = NonNullable<Awaited<ReturnType<typeof getCommand>>> & { status: string };
type AttemptFailure = { code: string; message: string; retryable: boolean };
type PendingCase = TraceGenerationCaseSpec & {
  nextAttemptNo: number;
  cycleStartAttemptNo: number;
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

export function isTraceGenerationCommandTerminal(status: string): boolean {
  return TERMINAL_COMMAND_STATUSES.has(status);
}

export function canReconcileGeneratedTraceAttempt(failureCode: string | null | undefined): boolean {
  return !failureCode || isTraceGenerationFailureRetryable(failureCode);
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
  const rows = await prisma.experimentCase.findMany({
    where: { experimentId, executionId: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, input: true },
  });
  return rows
    .map((row: { id: string; input: string }) => ({ caseId: row.id, input: row.input.trim() }))
    .filter((row: TraceGenerationCaseSpec) => Boolean(row.input));
}

export async function assertTraceGenerationTarget(input: {
  user: string;
  workerId: string;
  platform: string;
  agent: string;
}): Promise<void> {
  const targets = await listClientTraceGenerationTargets(input.user);
  const target = targets.find((item) =>
    item.workerId === input.workerId
    && item.platform === input.platform
    && item.agent === input.agent);
  if (!target) {
    throw new TraceGenerationError(
      'execution_target_unavailable',
      '所选运行主机已离线，或客户端不支持回传 Trace ID',
    );
  }
}

async function waitForCommand(commandId: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandRow | null> {
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
  const session = await prisma.session.findFirst({
    where: { user: input.user, taskId: input.traceId },
    select: { interactions: true, endTime: true },
  });
  if (!session || !hasUsableTraceInteractions(session.interactions)) return null;
  const facts = parseObject(input.completedTriggerCommand?.resultJson);
  const completedTriggerRun = input.completedTriggerCommand?.status === 'SUCCEEDED'
    && facts.state === 'AGENT_EXITED'
    && facts.traceId === input.traceId
    && facts.exitCode === 0
    && facts.timedOut === false
    && !facts.signal
    && !facts.failureDetectedAt
    && facts.modelActivityObserved === true;
  if (!session.endTime && !completedTriggerRun) return null;
  const execution = await prisma.execution.findFirst({
    where: { user: input.user, taskId: input.traceId, isSubagent: false },
    orderBy: { timestamp: 'desc' },
  });
  if (!session.endTime && !execution?.finalResult?.trim()) return null;
  return execution;
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
}): Promise<boolean> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const locked = await tx.experimentCase.updateMany({
      where: { id: input.caseId, deletedAt: null, experiment: { deletedAt: null, status: { not: 'cancelled' } } },
      data: { id: input.caseId },
    });
    if (!locked.count) return false;
    const attempt = await tx.experimentTraceAttempt.findUnique({ where: { id: input.attemptId } });
    if (!attempt || attempt.status === 'superseded' || attempt.failureCode === 'EXPERIMENT_CANCELLED') return false;
    const newer = await tx.experimentTraceAttempt.count({ where: { caseId: input.caseId,
      attemptNo: { gt: attempt.attemptNo }, status: { in: ['dispatching', 'running', 'waiting_trace', 'ready'] } } });
    if (newer) return false;
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
}): Promise<boolean> {
  const previous = await prisma.experimentTraceAttempt.findMany({
    where: {
      caseId: input.caseId,
      ...(input.minAttemptNo ? { attemptNo: { gte: input.minAttemptNo } } : {}),
      OR: [{ traceId: { not: null } }, { commandId: { not: null } }],
    },
    orderBy: { attemptNo: 'desc' },
    select: {
      id: true,
      traceId: true,
      commandId: true,
      failureCode: true,
    },
  });
  for (const attempt of previous) {
    if (!canReconcileGeneratedTraceAttempt(attempt.failureCode)) continue;
    let traceId = attempt.traceId;
    if (!traceId && attempt.commandId) {
      const command = await getCommand(attempt.commandId);
      traceId = parseTraceIdFromCommandResult(command?.resultJson);
      if (traceId) {
        await prisma.experimentTraceAttempt.update({
          where: { id: attempt.id },
          data: { traceId },
        });
      }
    }
    if (!traceId) continue;
    const execution = await findExecutionByTraceId({ user: input.user, traceId });
    if (!execution) continue;
    const bound = await bindExecution({
      caseId: input.caseId,
      attemptId: attempt.id,
      traceId,
      execution,
    });
    if (bound) return true;
  }
  return false;
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

  await prisma.experimentTraceAttempt.updateMany({
    where: { caseId: input.item.caseId, status: 'retry_wait' },
    data: { status: 'superseded', finishedAt: new Date() },
  });
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
    const activeStatuses = ['dispatching', 'running', 'waiting_trace'];
    if (await tx.experimentTraceAttempt.count({ where: { caseId: input.item.caseId, status: { in: activeStatuses } } })) {
      throw new TraceGenerationError('trace_retry_in_progress', '该 Case 正在生成 Trace', 409);
    }
    const experiment = await tx.experiment.findUnique({ where: { id: input.req.experimentId }, select: { configSnapshotJson: true } });
    const concurrency = parseExecutionConcurrency(parseObject(experiment?.configSnapshotJson).executionConcurrency ?? input.req.executionConcurrency);
    if (await tx.experimentTraceAttempt.count({ where: { experimentId: input.req.experimentId, status: { in: activeStatuses } } }) >= concurrency) return null;
    return tx.experimentTraceAttempt.create({ data: { ...createAttempt.data, startedAt: new Date() } });
  });
  let attempt = input.req.skillExecution ? await prisma.experimentTraceAttempt.create(createAttempt) : await claimAttempt();
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
    const frame = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const activeCase = await tx.experimentCase.findFirst({ where: { id: input.item.caseId, deletedAt: null, experiment: { deletedAt: null, status: { not: 'cancelled' } } } });
      if (!activeCase) throw Object.assign(new Error('实验或 Case 已取消'), { code: 'EXPERIMENT_CANCELLED' });
      const command = await createCommand({
      user: input.req.user,
      clientId: input.req.workerId,
      action: 'RUN_EXPERIMENT_CASE',
      ttlMs: commandWaitMs,
      payload: {
        platform: input.req.platform,
        agent: input.req.agent,
        model: input.req.model || null,
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
    const dispatched = await dispatchCommand(input.req.workerId, frame);
    if (dispatched.delivered) await markSent(frame.commandId, 'wss');
    const command = await waitForCommand(frame.commandId, commandWaitMs, input.req.signal);
    const traceId = parseTraceIdFromCommandResult(command?.resultJson);
    observedTraceId = traceId;
    if (!command || command.status !== 'SUCCEEDED') {
      failure = commandFailure(command);
    } else if (input.req.skillExecution?.version === 2) {
      if (command.clientId !== input.req.workerId) {
        throw new TraceGenerationError('CLIENT_MISMATCH', '触发分析结果不是来自所选客户端');
      }
      const decision = readTriggerDecision(command.resultJson, input.req.skillExecution.targetSkillName, input.req.model);
      await assertExperimentActive(input.req.experimentId, input.item.caseId);
      input.req.signal?.throwIfAborted();
      await prisma.$transaction([
        prisma.experimentTraceAttempt.update({
          where: { id: attempt.id },
          data: { status: 'ready', traceId: traceId || null, failureCode: null, errorMessage: null, finishedAt: new Date() },
        }),
        prisma.experimentCase.update({
          where: { id: input.item.caseId },
          data: { actualOutput: decision.triggered ? 'Skill 已触发' : 'Skill 未触发', traceGenerationError: null },
        }),
      ]);
      return { ready: true, triggerDecision: decision };
    } else {
      if (!traceId) {
        failure = {
          code: 'TRACE_ID_MISSING',
          message: '客户端执行成功但未返回 Trace ID，已拒绝按输入猜测绑定',
          retryable: false,
        };
      } else {
        await prisma.experimentTraceAttempt.update({
          where: { id: attempt.id },
          data: { traceId, status: 'waiting_trace' },
        });
        const execution = await waitForExecutionByTraceId({
          user: input.req.user,
          traceId,
          signal: input.req.signal,
          timeoutMs: Math.max(
            TRACE_INGEST_TIMEOUT_MS,
            (input.timeoutSeconds + 90) * 1_000,
          ),
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
          });
          return { ready: bound };
        }
        failure = {
          code: 'TRACE_INGEST_TIMEOUT',
          message: `Trace ${traceId} 已生成，但未在等待时间内完成入库`,
          retryable: true,
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
  await prisma.$transaction([
    prisma.experimentTraceAttempt.updateMany({
      where: { id: attempt.id, status: { in: ['dispatching', 'running', 'waiting_trace'] } },
      data: {
        status: retrying ? 'retry_wait' : 'failed',
        traceId: observedTraceId || undefined,
        failureCode: settledFailure.code,
        errorMessage: settledFailure.message.slice(0, 2_000),
        finishedAt: retrying ? null : new Date(),
      },
    }),
    prisma.experimentCase.updateMany({
      where: { id: input.item.caseId, traceGenerationCommandId: attempt.commandId || undefined, deletedAt: null, experiment: { deletedAt: null, status: { not: 'cancelled' } }, traceAttempts: { none: { attemptNo: { gt: attempt.attemptNo } } } },
      data: { traceGenerationError: retrying ? null : settledFailure.message.slice(0, 2_000) },
    }),
  ]);
  return { ready: false, failure: settledFailure };
}

export async function generateExperimentTraces(
  req: TraceGenerationRequest,
  options: TraceGenerationOptions = {},
): Promise<TraceGenerationResult> {
  const timeoutSeconds = Math.max(
    MIN_EXPERIMENT_AGENT_TIMEOUT_SECONDS,
    Math.min(
      req.timeoutSeconds ?? DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS,
      MAX_EXPERIMENT_AGENT_TIMEOUT_SECONDS,
    ),
  );
  const latestAttempts = await prisma.experimentTraceAttempt.findMany({
    where: { caseId: { in: req.cases.map((item) => item.caseId) } },
    orderBy: { attemptNo: 'desc' },
    select: { caseId: true, attemptNo: true },
  });
  const nextAttemptByCase = new Map<string, number>();
  for (const attempt of latestAttempts) {
    if (!nextAttemptByCase.has(attempt.caseId)) {
      nextAttemptByCase.set(attempt.caseId, attempt.attemptNo + 1);
    }
  }
  let pending: PendingCase[] = req.cases.map((item) => {
    const nextAttemptNo = nextAttemptByCase.get(item.caseId) || 1;
    return { ...item, nextAttemptNo, cycleStartAttemptNo: nextAttemptNo };
  });
  const readyCaseIds: string[] = [];
  const triggerDecisions: Record<string, TriggerDecision> = {};

  for (let round = 0; round <= AUTO_RETRY_DELAYS_MS.length && pending.length; round += 1) {
    if (round > 0) await sleep(AUTO_RETRY_DELAYS_MS[round - 1]);
    const nextRound: PendingCase[] = [];
    const outcomes = await mapConcurrent(pending, req.skillExecution ? 1 : parseExecutionConcurrency(req.executionConcurrency), async (item) => {
      req.signal?.throwIfAborted();
      const execute = (signal?: AbortSignal) => runAttempt({
        req: { ...req, signal: req.signal && signal ? AbortSignal.any([req.signal, signal]) : signal || req.signal },
        item, timeoutSeconds, canRetry: round < AUTO_RETRY_DELAYS_MS.length,
        reconcilePrevious: !options.forceNewTrace || round > 0,
      });
      const result = req.skillExecution ? await execute() : await withExperimentCancellation(req.experimentId, item.caseId, execute)
        .catch((error) => {
          if (error?.code !== 'EXPERIMENT_CANCELLED') throw error;
          return { ready: false, triggerDecision: undefined, failure: { code: 'EXPERIMENT_CANCELLED', message: '实验或 Case 已取消', retryable: false } };
        });
      return { item, result };
    });
    for (const { item, result } of outcomes) {
      if (result.ready) {
        readyCaseIds.push(item.caseId);
        if (result.triggerDecision) triggerDecisions[item.caseId] = result.triggerDecision;
      } else if (result.failure?.retryable && round < AUTO_RETRY_DELAYS_MS.length) {
        nextRound.push({ ...item, nextAttemptNo: item.nextAttemptNo + 1 });
      }
    }
    pending = nextRound;
  }

  const readySet = new Set(readyCaseIds);
  return {
    readyCaseIds,
    failedCaseIds: req.cases.map((item) => item.caseId).filter((caseId) => !readySet.has(caseId)),
    ...(req.skillExecution?.version === 2 ? { triggerDecisions } : {}),
  };
}

export async function loadTraceGenerationRetryRequest(input: {
  user: string;
  experimentId: string;
  caseId: string;
}): Promise<TraceGenerationRequest | null> {
  const row = await prisma.experimentCase.findFirst({
    where: {
      id: input.caseId,
      experimentId: input.experimentId,
      experiment: { user: input.user },
    },
    select: {
      id: true,
      input: true,
      traceGenerationCommandId: true,
      experiment: { select: { scope: true, configSnapshotJson: true } },
      traceAttempts: {
        orderBy: { attemptNo: 'desc' },
        take: 1,
        select: {
          workerId: true,
          commandId: true,
          platform: true,
          agent: true,
          model: true,
          timeoutSeconds: true,
          status: true,
        },
      },
    },
  });
  if (!row || !row.input.trim()) return null;
  const attempt = row.traceAttempts[0];
  if (attempt) {
    if (['queued', 'dispatching', 'running', 'waiting_trace', 'retry_wait'].includes(attempt.status)) {
      throw new TraceGenerationError('trace_retry_in_progress', '该 Case 正在生成 Trace', 409);
    }
    const payload = attempt.commandId ? parseObject((await getCommand(attempt.commandId))?.payloadJson) : {};
    return {
      user: input.user,
      experimentId: input.experimentId,
      executionConcurrency: !row.experiment.scope ? parseExecutionConcurrency(parseObject(row.experiment.configSnapshotJson).executionConcurrency) : 1,
      workerId: attempt.workerId,
      platform: attempt.platform,
      agent: attempt.agent,
      model: attempt.model,
      ...(payload.skillExecution ? { skillExecution: payload.skillExecution as NonNullable<TraceGenerationRequest['skillExecution']> } : {}),
      timeoutSeconds: attempt.timeoutSeconds,
      cases: [{ caseId: row.id, input: row.input.trim() }],
    };
  }

  if (!row.traceGenerationCommandId) return null;
  const legacyCommand = await prisma.reliabilityCommand.findFirst({
    where: {
      commandId: row.traceGenerationCommandId,
      user: input.user,
      action: 'RUN_EXPERIMENT_CASE',
    },
    select: { clientId: true, payloadJson: true, status: true },
  });
  if (!legacyCommand) return null;
  if (!isTraceGenerationCommandTerminal(legacyCommand.status)) {
    throw new TraceGenerationError('trace_retry_in_progress', '该 Case 正在生成 Trace', 409);
  }
  const payload = parseObject(legacyCommand.payloadJson);
  const platform = typeof payload.platform === 'string' ? payload.platform.trim() : '';
  const agent = typeof payload.agent === 'string' ? payload.agent.trim() : '';
  if (!platform || !agent) return null;
  return {
    user: input.user,
    experimentId: input.experimentId,
    workerId: legacyCommand.clientId,
    platform,
    agent,
    model: typeof payload.model === 'string' ? payload.model : null,
    timeoutSeconds: Number(payload.timeoutSeconds) || DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS,
    cases: [{ caseId: row.id, input: row.input.trim() }],
  };
}
