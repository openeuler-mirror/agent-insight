import { prisma } from '@/lib/storage/prisma';
import { generateExperimentTraces, TraceGenerationError } from '@/lib/engine/experiment/trace-generation';
import { validateSkillExecutionTarget, type SkillExecutionTarget, type SkillExecutionSnapshot } from './execution-target';
import { withSkillClientSlot } from './client-execution-slot';
import { withExperimentDatasetCaseBinding } from '@/lib/engine/experiment/dataset-case-binding';
import { assertExperimentActive } from '@/lib/engine/experiment/cancellation-context';

interface ClientCaseInput {
  user: string;
  experimentId: string;
  experimentCaseId?: string;
  datasetCaseId: string;
  datasetId: string;
  executionTarget: SkillExecutionTarget;
  skill: SkillExecutionSnapshot | null;
  query: string;
  referenceOutput?: string | null;
  timeoutMs: number;
  signal: AbortSignal;
  onCaseCreated: (caseId: string) => Promise<void>;
}

export async function executeSkillCaseOnClient(input: ClientCaseInput) {
  return withSkillClientSlot(input.executionTarget.workerId, input.signal, () => executeClientCase(input));
}

async function executeClientCase(input: ClientCaseInput) {
  input.signal.throwIfAborted();
  await validateSkillExecutionTarget(input.user, input.executionTarget);
  await assertExperimentActive(input.experimentId, `dataset:${input.datasetCaseId}`);
  input.signal.throwIfAborted();
  const row = input.experimentCaseId
    ? await prisma.experimentCase.findFirst({ where: { id: input.experimentCaseId, experimentId: input.experimentId, experiment: { user: input.user } } })
    : await prisma.experimentCase.create({ data: {
      experimentId: input.experimentId, input: input.query, datasetInput: input.query,
      actualOutput: '', referenceOutput: input.referenceOutput ?? null,
      caseValuesJson: JSON.stringify(withExperimentDatasetCaseBinding(null, { datasetId: input.datasetId, caseId: input.datasetCaseId })),
    } });
  if (!row) throw new TraceGenerationError('case_missing', '实验 Case 已不存在', 404);
  await prisma.experimentCase.update({ where: { id: row.id }, data: {
    caseValuesJson: JSON.stringify(withExperimentDatasetCaseBinding(JSON.parse(row.caseValuesJson || '{}'), { datasetId: input.datasetId, caseId: input.datasetCaseId })),
  } });
  await input.onCaseCreated(row.id);
  const result = await generateExperimentTraces({
    user: input.user, experimentId: input.experimentId,
    ...input.executionTarget,
    timeoutSeconds: Math.round(input.timeoutMs / 1000),
    cases: [{ caseId: row.id, input: input.query }],
    skillExecution: { version: 1, skill: input.skill },
    signal: input.signal,
  }, { forceNewTrace: true });
  input.signal.throwIfAborted();
  if (!result.readyCaseIds.includes(row.id)) {
    const attempt = await prisma.experimentTraceAttempt.findFirst({ where: { caseId: row.id }, orderBy: { attemptNo: 'desc' } });
    throw new TraceGenerationError(attempt?.failureCode || 'CASE_RUN_FAILED', attempt?.errorMessage || '客户端执行失败');
  }
  const updated = await prisma.experimentCase.findUnique({ where: { id: row.id }, select: { taskId: true, actualOutput: true, executionId: true } });
  if (!updated?.taskId) throw new TraceGenerationError('TRACE_ID_MISSING', '缺少本次执行 Trace');
  if (updated.executionId) await prisma.execution.update({ where: { id: updated.executionId }, data: { skill: input.skill?.name || null, skillVersion: input.skill?.version ?? null } });
  return { sessionId: updated.taskId, output: updated.actualOutput || '', experimentCaseId: row.id };
}
