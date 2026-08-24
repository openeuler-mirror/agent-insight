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
}): Promise<{ planId: string | null; appliedItems: number; resolvedIssues: number }> {
  const planIds = planIdsFromSourceRefs(input.sourceRefs);
  if (!planIds.length) return { planId: null, appliedItems: 0, resolvedIssues: 0 };

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
        select: { dedupKey: true },
      })
      : [];
    const dedupKeys = [...new Set(sourceIssues.map((issue) => issue.dedupKey))];
    const resolvedIssues = dedupKeys.length
      ? (await tx.skillIssue.updateMany({
        where: {
          skillId: plan.skillId,
          version: plan.baseVersion,
          user: input.user,
          dedupKey: { in: dedupKeys },
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
