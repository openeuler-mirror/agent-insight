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

import { findCandidateVerification } from './verification-evidence';
import { prismaRaw } from '@/lib/storage/prisma';

function planIdsFromSourceRefs(sourceRefs: unknown[]): string[] {
  return sourceRefs.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const ref = value as Record<string, unknown>;
    return ref.type === 'plan' && typeof ref.id === 'string' && ref.id ? [ref.id] : [];
  });
}

function parseIssueIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && Boolean(item)) : [];
  } catch {
    return [];
  }
}

export async function applyCompletedOptimizationPlan(input: {
  user: string;
  workbenchSessionId: string;
  sourceRefs: unknown[];
  resolvedRunId: string;
  staticEvaluationId?: string;
  verificationExperimentId?: string;
}): Promise<{ planId: string | null; appliedItems: number; resolvedIssues: number }> {
  const planIds = planIdsFromSourceRefs(input.sourceRefs);
  const record = await prismaRaw.skillOptimizationRecord.findFirst({ where: { id: input.resolvedRunId, user: input.user, sessionId: input.workbenchSessionId } });
  const proof = record && input.verificationExperimentId ? await findCandidateVerification({ user: input.user, recordId: record.id,
    skillName: record.skillName, baseVersion: record.baseVersion, files: JSON.parse(record.candidateFilesJson), sourceExperimentId: record.sourceExperimentId }) : null;
  const verifiedIds = new Set(proof?.result.verifiedIssueIds || []);
  const quality = input.staticEvaluationId ? await prismaRaw.skillSnapshotEvaluation.findFirst({
    where: { id: input.staticEvaluationId, user: input.user, sessionId: input.workbenchSessionId, status: 'ok' } }) : null;
  const remainingRules = new Set<string>((JSON.parse(quality?.issuesJson || '[]') as Array<{ ruleId?: string }>).flatMap((issue) => issue.ruleId ? [issue.ruleId] : []));
  const requestedIds = input.sourceRefs.flatMap((item) => item && typeof item === 'object' && (item as { type?: string }).type === 'issue'
    && typeof (item as { id?: unknown }).id === 'string' ? [(item as { id: string }).id] : []);
  const canResolve = (issue: { id: string; source: string; ruleId: string | null }) => verifiedIds.has(issue.id)
    || Boolean(quality && record && quality.contentHash === record.candidateContentHash && issue.source === 'static' && issue.ruleId && !issue.ruleId.startsWith('dim:') && !remainingRules.has(issue.ruleId));
  if (!planIds.length) {
    if (!record) return { planId: null, appliedItems: 0, resolvedIssues: 0 };
    const issues = await prismaRaw.skillIssue.findMany({ where: { user: input.user, version: record.baseVersion,
      Skill: { name: record.skillName }, id: { in: [...new Set([...requestedIds, ...verifiedIds])] } } });
    const resolved = await prismaRaw.skillIssue.updateMany({ where: { id: { in: issues.filter(canResolve).map((issue) => issue.id) }, user: input.user, resolvedAt: null },
      data: { resolvedAt: new Date(), resolvedRunId: input.resolvedRunId } });
    return { planId: null, appliedItems: 0, resolvedIssues: resolved.count };
  }

  return prismaRaw.$transaction(async (tx) => {
    const session = await tx.skillWorkbenchSession.findFirst({
      where: { id: input.workbenchSessionId, user: input.user, optSessionId: { not: null } },
      select: { optSessionId: true },
    });
    if (!session?.optSessionId) return { planId: null, appliedItems: 0, resolvedIssues: 0 };

    const plan = await tx.skillOptPlan.findFirst({
      where: { id: { in: planIds }, sessionId: session.optSessionId },
      include: { items: true },
    });
    if (!plan) return { planId: null, appliedItems: 0, resolvedIssues: 0 };

    const appliedItems = plan.items.filter((item) => (
      (item.route === 'core' || item.route === 'reference')
      && (item.status === 'pending' || item.status === 'applied')
    ));
    const pendingItemIds = appliedItems.filter((item) => item.status === 'pending').map((item) => item.id);
    if (pendingItemIds.length) {
      await tx.skillOptPlanItem.updateMany({
        where: { id: { in: pendingItemIds }, planId: plan.id, status: 'pending' },
        data: { status: 'applied' },
      });
    }

    const sourceIssueIds = [...new Set(appliedItems.flatMap((item) => parseIssueIds(item.sourceIssueIds)))];
    const sourceIssues = sourceIssueIds.length
      ? await tx.skillIssue.findMany({
        where: {
          id: { in: sourceIssueIds },
          skillId: plan.skillId,
          version: plan.baseVersion,
          user: input.user,
        },
        select: { id: true, source: true, ruleId: true },
      })
      : [];
    const resolvedIds = sourceIssues.filter(canResolve).map((issue) => issue.id);
    const resolvedIssues = resolvedIds.length
      ? (await tx.skillIssue.updateMany({
        where: {
          skillId: plan.skillId,
          version: plan.baseVersion,
          user: input.user,
          id: { in: resolvedIds },
          resolvedAt: null,
        },
        data: { resolvedAt: new Date(), resolvedRunId: input.resolvedRunId },
      })).count
      : 0;

    const openItems = await tx.skillOptPlanItem.count({
      where: {
        planId: plan.id,
        route: { in: ['core', 'reference'] },
        status: { in: ['pending', 'conflict'] },
      },
    });
    if (openItems === 0 && plan.status !== 'applied') {
      await tx.skillOptPlan.update({ where: { id: plan.id }, data: { status: 'applied' } });
    }

    return { planId: plan.id, appliedItems: pendingItemIds.length, resolvedIssues };
  });
}
