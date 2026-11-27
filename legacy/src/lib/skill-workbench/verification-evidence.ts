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

import { prismaRaw } from '@/lib/storage/prisma';
import { findAgentDataset } from '@/server/agent_datasets_storage';
import { verificationHash } from '@/lib/engine/skill-opt/verification-policy';
import type { BehavioralResult } from '@/lib/engine/skill-opt/self-verify';

type VerificationRef = { type?: string; experimentId?: string; experimentIds?: string[]; experimentDeleted?: boolean };

export async function cleanupOptimizationVerificationExperiments(input: { user: string; recordId: string }) {
  return prismaRaw.$transaction(async (tx) => {
    const record = await tx.skillOptimizationRecord.findFirst({ where: { id: input.recordId, user: input.user } });
    if (!record || record.status === 'retesting') return 0;
    const tasks = await tx.skillWorkbenchTask.findMany({ where: { sessionId: record.sessionId, type: 'optimization', resultId: record.id },
      select: { status: true, createdAt: true, updatedAt: true } });
    if (tasks.some((task) => ['pending', 'running'].includes(task.status))) return 0;
    const settledTasks = tasks.filter((task) => ['done', 'failed', 'cancelled'].includes(task.status));
    if (record.status === 'optimizing' && !settledTasks.length) return 0;
    const experiments = await tx.experiment.findMany({ where: { user: input.user, optimizationRecordId: record.id,
      skillName: record.skillName, skillVersion: record.baseVersion, scope: 'skill-workbench', preset: 'retest',
      deletedAt: null, status: { in: ['done', 'partial', 'failed', 'cancelled'] } } });
    const ids = experiments.filter((experiment) => {
      try {
        const snapshot = JSON.parse(experiment.configSnapshotJson || '{}');
        return experiment.id !== record.sourceExperimentId && snapshot.verificationOnly === true
          && (snapshot.verificationPurpose === 'optimization' || snapshot.verificationPurpose == null
            && settledTasks.some((task) => task.createdAt <= experiment.createdAt && experiment.createdAt <= task.updatedAt));
      } catch { return false; }
    }).map((experiment) => experiment.id);
    if (!ids.length) return 0;
    const refs = JSON.parse(record.sourceRefsJson || '[]') as VerificationRef[];
    const archivedIds = [...new Set([...refs.filter((ref) => ref.type === 'verification-cleanup')
      .flatMap((ref) => ref.experimentIds || []), ...ids])];
    const sourceRefs = refs.filter((ref) => ref.type !== 'verification-cleanup').map((ref) =>
      ref.type === 'verification-result' && ref.experimentId && archivedIds.includes(ref.experimentId)
        ? { ...ref, experimentDeleted: true } : ref);
    sourceRefs.push({ type: 'verification-cleanup', experimentIds: archivedIds });
    // Keep immutable verification rows for hash checks; user deletion/cancellation still invalidates evidence.
    await tx.experiment.updateMany({ where: { id: { in: ids }, user: input.user, deletedAt: null },
      data: { deletedAt: new Date(), watchMode: false, watchEnabledAt: null } });
    await tx.skillOptimizationRecord.update({ where: { id: record.id }, data: {
      sourceRefsJson: JSON.stringify(sourceRefs),
      ...(record.retestExperimentId && archivedIds.includes(record.retestExperimentId) ? { retestExperimentId: null } : {}),
    } });
    return ids.length;
  });
}

export async function verificationRowsHash(experimentId: string) {
  const rows = await prismaRaw.experimentCase.findMany({ where: { experimentId, deletedAt: null },
    orderBy: { id: 'asc' }, select: { id: true, executionId: true, datasetInput: true, input: true,
      referenceOutput: true, actualOutput: true, results: { orderBy: { evaluatorId: 'asc' },
        select: { evaluatorId: true, status: true, verdict: true, score: true, pointsJson: true, humanScore: true } } } });
  return verificationHash(rows);
}

export async function findCandidateVerification(input: {
  user: string; recordId: string; skillName: string; baseVersion: number;
  files: Record<string, string>; sourceExperimentId?: string | null;
}) {
  const record = await prismaRaw.skillOptimizationRecord.findFirst({ where: { id: input.recordId, user: input.user,
    skillName: input.skillName, baseVersion: input.baseVersion }, select: { sourceRefsJson: true } });
  const refs = JSON.parse(record?.sourceRefsJson || '[]') as VerificationRef[];
  const archivedIds = refs.filter((ref) => ref.type === 'verification-cleanup').flatMap((ref) => ref.experimentIds || []);
  const experiments = await prismaRaw.experiment.findMany({
    where: { user: input.user, optimizationRecordId: input.recordId, skillName: input.skillName,
      skillVersion: input.baseVersion, OR: [{ deletedAt: null }, { id: { in: archivedIds } }], status: { in: ['done', 'partial'] } },
    orderBy: { createdAt: 'desc' }, take: 10,
  });
  for (const experiment of experiments) {
    try {
      const snapshot = JSON.parse(experiment.configSnapshotJson || '{}');
      const proof = snapshot.verification;
      if (proof?.version !== 1 || proof.candidateHash !== verificationHash(input.files)
        || !experiment.sourceExperimentId || input.sourceExperimentId && input.sourceExperimentId !== experiment.sourceExperimentId) continue;
      const source = await prismaRaw.experiment.findFirst({ where: { id: experiment.sourceExperimentId,
        user: input.user, skillName: input.skillName, skillVersion: input.baseVersion, deletedAt: null,
        status: { in: ['done', 'partial'] } } });
      if (proof.candidateConfigHash !== verificationHash({ ...snapshot, verification: undefined })) continue;
      if (!source || source.evaluatorIdsJson !== experiment.evaluatorIdsJson || source.evaluatorConfigsJson !== experiment.evaluatorConfigsJson || proof.sourceHash !== verificationHash({ snapshot: source.configSnapshotJson,
        evaluators: source.evaluatorIdsJson, configs: source.evaluatorConfigsJson })) continue;
      if (proof.baselineHash !== await verificationRowsHash(source.id)
        || proof.resultsHash !== await verificationRowsHash(experiment.id)) continue;
      if (await prismaRaw.experimentCancellation.count({ where: { experimentId: { in: [source.id, experiment.id] } } })) continue;
      const dataset = await findAgentDataset(input.user, proof.datasetId);
      if (!dataset || !Array.isArray(proof.caseIds) || proof.inputHash !== verificationHash(proof.caseIds.map((id: string) => dataset.cases.find((item) => item.id === id)))) continue;
      const result = proof.result as BehavioralResult;
      if (!result || result.experimentId !== experiment.id || !Array.isArray(result.perCase)) continue;
      return { experimentId: experiment.id, sourceExperimentId: source.id, result, archived: Boolean(experiment.deletedAt) };
    } catch { continue; }
  }
  return null;
}

export async function linkCandidateVerification(input: Parameters<typeof findCandidateVerification>[0]) {
  const evidence = await findCandidateVerification(input);
  if (!evidence) return null;
  const result = evidence.result;
  const status = !result.ok ? 'retest_failed' : result.incomplete || !result.fullCoverage ? 'pending_retest' : 'retest_passed';
  const record = await prismaRaw.skillOptimizationRecord.findFirst({ where: { id: input.recordId, user: input.user } });
  if (!record || !['pending_retest', 'retesting', 'retest_failed', 'retest_passed', 'retest_cancelled'].includes(record.status)) return null;
  if (verificationHash(JSON.parse(record.candidateFilesJson)) !== verificationHash(input.files)) return null;
  const sourceRefs = JSON.parse(record.sourceRefsJson || '[]').filter((item: { type?: string }) => item.type !== 'verification-result');
  sourceRefs.push({ type: 'verification-result', experimentId: evidence.experimentId, fullCoverage: result.fullCoverage,
    experimentDeleted: evidence.archived,
    measured: result.measured, sourceScore: result.baseMean, candidateScore: result.candMean, passed: result.ok && !result.incomplete && result.fullCoverage });
  const updated = await prismaRaw.skillOptimizationRecord.updateMany({
    where: { id: record.id, status: record.status, candidateContentHash: record.candidateContentHash,
      candidateFilesJson: record.candidateFilesJson },
    data: { status, retestExperimentId: evidence.archived ? null : evidence.experimentId, sourceExperimentId: evidence.sourceExperimentId,
      sourceRefsJson: JSON.stringify(sourceRefs), errorMessage: result.ok ? null :
        `行为验证未通过：${result.baseMean} → ${result.candMean}；${result.targetFailures?.length ? '目标问题未解决' : '存在用例退步'}` },
  });
  return updated.count ? { ...evidence, status, sourceRefs, errorMessage: result.ok ? null : `行为验证未通过：${result.baseMean} → ${result.candMean}；${result.targetFailures?.length ? '目标问题未解决' : '存在用例退步'}` } : null;
}
