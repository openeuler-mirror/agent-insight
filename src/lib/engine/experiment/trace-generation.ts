import { prisma } from '@/lib/storage/prisma';
import { listClientTraceGenerationTargets } from '@/lib/engine/experiment/execution-targets';
import { createCommand, getCommand, markSent } from '@/lib/reliability/command-bus';
import { dispatchCommand } from '@/lib/reliability/control-dispatch';
import { hasUsableTraceInteractions } from '@/lib/engine/experiment/fi-orchestrate';

export type TraceGenerationCaseSpec = { caseId: string; input: string };

export type TraceGenerationRequest = {
  user: string;
  experimentId: string;
  workerId: string;
  platform: string;
  agent: string;
  model?: string | null;
  timeoutSeconds?: number;
  cases: TraceGenerationCaseSpec[];
};

export type TraceGenerationResult = { readyCaseIds: string[]; failedCaseIds: string[] };

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
const NON_RETRYABLE_FAILURE_CODES = new Set([
  'ACTION_NOT_ALLOWED',
  'PAYLOAD_FORBIDDEN',
  'PLATFORM_NOT_AVAILABLE',
  'TRACE_ID_MISSING',
  'TRACE_ID_UNSUPPORTED',
]);
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

export function parseTraceIdFromCommandResult(resultJson: string | null | undefined): string | null {
  const traceId = parseObject(resultJson).traceId;
  return typeof traceId === 'string' && traceId.trim() ? traceId.trim() : null;
}

export function isTraceGenerationFailureRetryable(code: string): boolean {
  return !NON_RETRYABLE_FAILURE_CODES.has(code);
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

async function waitForCommand(commandId: string, timeoutMs: number): Promise<CommandRow | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const command = await getCommand(commandId);
    if (!command) return null;
    if (parseTraceIdFromCommandResult(command.resultJson)) return command as CommandRow;
    if (TERMINAL_COMMAND_STATUSES.has(command.status)) return command as CommandRow;
    if (command.expiresAt.getTime() <= Date.now()) {
      return { ...command, status: 'EXPIRED' } as CommandRow;
    }
    await sleep(1_000);
  }
  const command = await getCommand(commandId);
  return command ? { ...command, status: 'EXPIRED' } as CommandRow : null;
}

async function findExecutionByTraceId(input: { user: string; traceId: string }) {
  const session = await prisma.session.findFirst({
    where: { user: input.user, taskId: input.traceId },
    select: { interactions: true, endTime: true },
  });
  if (!session?.endTime || !hasUsableTraceInteractions(session.interactions)) return null;
  return prisma.execution.findFirst({
    where: { user: input.user, taskId: input.traceId, isSubagent: false },
    orderBy: { timestamp: 'desc' },
  });
}

async function waitForExecutionByTraceId(input: {
  user: string;
  traceId: string;
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < input.timeoutMs) {
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
}): Promise<void> {
  await prisma.$transaction([
    prisma.experimentCase.update({
      where: { id: input.caseId },
      data: {
        executionId: input.execution.id,
        taskId: input.traceId,
        actualOutput: input.execution.finalResult || '',
        traceGenerationError: null,
      },
    }),
    prisma.experimentTraceAttempt.update({
      where: { id: input.attemptId },
      data: {
        traceId: input.traceId,
        status: 'ready',
        failureCode: null,
        errorMessage: null,
        finishedAt: new Date(),
      },
    }),
    prisma.experimentTraceAttempt.updateMany({
      where: {
        caseId: input.caseId,
        id: { not: input.attemptId },
        status: { not: 'ready' },
      },
      data: { status: 'superseded', finishedAt: new Date() },
    }),
  ]);
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
    },
  });
  for (const attempt of previous) {
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
    await bindExecution({
      caseId: input.caseId,
      attemptId: attempt.id,
      traceId,
      execution,
    });
    return true;
  }
  return false;
}

async function runAttempt(input: {
  req: TraceGenerationRequest;
  item: PendingCase;
  timeoutSeconds: number;
  canRetry: boolean;
  reconcilePrevious: boolean;
}): Promise<{ ready: boolean; failure?: AttemptFailure }> {
  if (input.reconcilePrevious && await reconcileGeneratedTraceCase({
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
  const attempt = await prisma.experimentTraceAttempt.create({
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
  });

  let failure: AttemptFailure | null = null;
  try {
    const frame = await createCommand({
      user: input.req.user,
      clientId: input.req.workerId,
      action: 'RUN_EXPERIMENT_CASE',
      ttlMs: (input.timeoutSeconds + 90) * 1_000,
      payload: {
        platform: input.req.platform,
        agent: input.req.agent,
        model: input.req.model || null,
        input: input.item.input,
        timeoutSeconds: input.timeoutSeconds,
        correlation: {
          experimentId: input.req.experimentId,
          experimentRunId: input.req.experimentId,
          caseRunId: input.item.caseId,
          traceAttemptId: attempt.id,
        },
      },
    });
    await prisma.$transaction([
      prisma.experimentTraceAttempt.update({
        where: { id: attempt.id },
        data: { commandId: frame.commandId, status: 'running' },
      }),
      prisma.experimentCase.update({
        where: { id: input.item.caseId },
        data: { traceGenerationCommandId: frame.commandId, traceGenerationError: null },
      }),
    ]);

    const dispatched = await dispatchCommand(input.req.workerId, frame);
    if (dispatched.delivered) await markSent(frame.commandId, 'wss');
    const command = await waitForCommand(frame.commandId, (input.timeoutSeconds + 90) * 1_000);
    const traceId = parseTraceIdFromCommandResult(command?.resultJson);
    if (!traceId && (!command || command.status !== 'SUCCEEDED')) {
      failure = commandFailure(command);
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
          timeoutMs: Math.max(
            TRACE_INGEST_TIMEOUT_MS,
            (input.timeoutSeconds + 90) * 1_000,
          ),
        });
        if (execution) {
          await bindExecution({
            caseId: input.item.caseId,
            attemptId: attempt.id,
            traceId,
            execution,
          });
          return { ready: true };
        }
        failure = {
          code: 'TRACE_INGEST_TIMEOUT',
          message: `Trace ${traceId} 已生成，但未在等待时间内完成入库`,
          retryable: true,
        };
      }
    }
  } catch (error) {
    failure = {
      code: error instanceof TraceGenerationError ? error.code : 'CASE_RUN_FAILED',
      message: error instanceof Error ? error.message : String(error || 'Trace 生成失败'),
      retryable: true,
    };
  }

  const settledFailure = failure || {
    code: 'CASE_RUN_FAILED',
    message: 'Trace 生成失败',
    retryable: true,
  };
  const retrying = settledFailure.retryable && input.canRetry;
  await prisma.$transaction([
    prisma.experimentTraceAttempt.update({
      where: { id: attempt.id },
      data: {
        status: retrying ? 'retry_wait' : 'failed',
        failureCode: settledFailure.code,
        errorMessage: settledFailure.message.slice(0, 2_000),
        finishedAt: retrying ? null : new Date(),
      },
    }),
    prisma.experimentCase.update({
      where: { id: input.item.caseId },
      data: { traceGenerationError: retrying ? null : settledFailure.message.slice(0, 2_000) },
    }),
  ]);
  return { ready: false, failure: settledFailure };
}

export async function generateExperimentTraces(
  req: TraceGenerationRequest,
  options: TraceGenerationOptions = {},
): Promise<TraceGenerationResult> {
  const timeoutSeconds = Math.max(30, Math.min(req.timeoutSeconds ?? 180, 3_600));
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

  for (let round = 0; round <= AUTO_RETRY_DELAYS_MS.length && pending.length; round += 1) {
    if (round > 0) await sleep(AUTO_RETRY_DELAYS_MS[round - 1]);
    const nextRound: PendingCase[] = [];
    for (const item of pending) {
      const result = await runAttempt({
        req,
        item,
        timeoutSeconds,
        canRetry: round < AUTO_RETRY_DELAYS_MS.length,
        reconcilePrevious: !options.forceNewTrace || round > 0,
      });
      if (result.ready) {
        readyCaseIds.push(item.caseId);
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
      traceAttempts: {
        orderBy: { attemptNo: 'desc' },
        take: 1,
        select: {
          workerId: true,
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
    return {
      user: input.user,
      experimentId: input.experimentId,
      workerId: attempt.workerId,
      platform: attempt.platform,
      agent: attempt.agent,
      model: attempt.model,
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
  if (!TERMINAL_COMMAND_STATUSES.has(legacyCommand.status)) {
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
    timeoutSeconds: Number(payload.timeoutSeconds) || 180,
    cases: [{ caseId: row.id, input: row.input.trim() }],
  };
}
