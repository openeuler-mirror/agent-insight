import { createHash } from 'crypto';

import { prismaRaw } from '@/lib/storage/prisma';

const GENERATOR = 'experiment-skill-issues@1.0';

type IssueSource = 'dynamic' | 'trigger';
type Severity = 'high' | 'medium' | 'low';

interface ExperimentPoint {
  label?: unknown;
  status?: unknown;
  score?: unknown;
  severity?: unknown;
  skillAttributable?: unknown;
  isSkillAttributable?: unknown;
  is_skill_attributable?: unknown;
  suggestion?: unknown;
  improvementSuggestion?: unknown;
  improvement_suggestion?: unknown;
  evidence?: unknown;
}

interface NormalizedExperimentIssue {
  severity: Severity;
  category: string;
  summary: string;
  evidence: string | null;
  reasoning: string | null;
  suggestedFix: string;
  dedupKey: string;
  evaluatorId: string;
  resultId: string;
  executionId: string | null;
}

function parseArray(value: string | null): ExperimentPoint[] {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
  } catch {
    return [];
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sourceForExperiment(preset: string | null, scope: string): IssueSource | null {
  if (preset === 'trigger') return 'trigger';
  if (preset === 'use-case' || scope === 'skill-case-analysis') return 'dynamic';
  return null;
}

function evidenceText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const markdown = text(record.md);
  if (markdown) return markdown;
  try {
    return JSON.stringify(record);
  } catch {
    return null;
  }
}

function normalizeSeverity(point: ExperimentPoint): Severity {
  const explicit = text(point.severity).toLowerCase();
  if (explicit === 'high' || explicit === 'medium' || explicit === 'low') return explicit;
  const status = text(point.status).toLowerCase();
  if (status === 'missing' || status === 'fail' || status === 'failed') return 'high';
  if (status === 'partial' || status === 'warn' || status === 'warning') return 'medium';
  const score = Number(point.score);
  if (Number.isFinite(score)) {
    if (score < 50) return 'high';
    if (score < 100) return 'medium';
  }
  return 'low';
}

function categoryFor(source: IssueSource, evaluatorId: string): string {
  if (source === 'trigger') return '触发评测';
  if (evaluatorId.includes('task-completion')) return '任务完成度';
  if (evaluatorId.includes('trace-quality')) return '轨迹偏差';
  if (evaluatorId.includes('result')) return '结果问题';
  return '用例评测';
}

function normalizeDedupPart(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function dedupKeyFor(source: IssueSource, category: string, summary: string, suggestedFix: string): string {
  return createHash('sha1')
    .update([
      source,
      normalizeDedupPart(category),
      normalizeDedupPart(summary),
      normalizeDedupPart(suggestedFix),
    ].join('::'))
    .digest('hex')
    .slice(0, 12);
}

function isSkillAttributable(point: ExperimentPoint): boolean {
  return point.skillAttributable === true
    || point.isSkillAttributable === true
    || point.is_skill_attributable === true;
}

function suggestionText(point: ExperimentPoint): string {
  return text(point.suggestion)
    || text(point.improvementSuggestion)
    || text(point.improvement_suggestion);
}

export async function syncExperimentSkillIssues(experimentId: string): Promise<{
  source: IssueSource | null;
  written: number;
  cleared: number;
}> {
  const experiment = await prismaRaw.experiment.findUnique({
    where: { id: experimentId },
    select: {
      id: true,
      user: true,
      name: true,
      status: true,
      scope: true,
      preset: true,
      skillName: true,
      skillVersion: true,
    },
  });
  const source = experiment ? sourceForExperiment(experiment.preset, experiment.scope) : null;
  if (
    !experiment
    || experiment.status !== 'done'
    || !source
    || !experiment.skillName
    || experiment.skillVersion == null
  ) {
    return { source, written: 0, cleared: 0 };
  }

  const skill = await prismaRaw.skill.findFirst({
    where: {
      name: experiment.skillName,
      OR: [{ user: experiment.user }, { user: null }, { visibility: 'public' }],
      versions: { some: { version: experiment.skillVersion } },
    },
    select: { id: true },
  });
  if (!skill) return { source, written: 0, cleared: 0 };

  const results = await prismaRaw.experimentEvalResult.findMany({
    where: { experimentId: experiment.id, status: 'done' },
    select: {
      id: true,
      evaluatorId: true,
      summary: true,
      pointsJson: true,
      case: { select: { executionId: true, taskId: true } },
    },
  });
  const taskIds = Array.from(new Set(results.map((result) => result.case.taskId).filter((id): id is string => Boolean(id))));
  const executions = taskIds.length
    ? await prismaRaw.execution.findMany({
      where: { taskId: { in: taskIds } },
      orderBy: { timestamp: 'desc' },
      select: { id: true, taskId: true },
    })
    : [];
  const executionByTask = new Map<string, string>();
  for (const execution of executions) {
    if (execution.taskId && !executionByTask.has(execution.taskId)) executionByTask.set(execution.taskId, execution.id);
  }

  const normalized: NormalizedExperimentIssue[] = [];
  for (const result of results) {
    for (const point of parseArray(result.pointsJson)) {
      const suggestedFix = suggestionText(point);
      if (!isSkillAttributable(point) || !suggestedFix) continue;
      const summary = text(point.label) || text(result.summary) || result.evaluatorId;
      const category = categoryFor(source, result.evaluatorId);
      normalized.push({
        severity: normalizeSeverity(point),
        category,
        summary,
        evidence: evidenceText(point.evidence),
        reasoning: text(result.summary) || null,
        suggestedFix,
        dedupKey: dedupKeyFor(source, category, summary, suggestedFix),
        evaluatorId: result.evaluatorId,
        resultId: result.id,
        executionId: result.case.executionId
          || (result.case.taskId ? executionByTask.get(result.case.taskId) || null : null),
      });
    }
  }

  const runPrefix = `experiment:${experiment.id}:`;
  return prismaRaw.$transaction(async (tx) => {
    const existingEvaluations = await tx.evaluation.findMany({
      where: {
        skillId: skill.id,
        version: experiment.skillVersion as number,
        generator: GENERATOR,
        runId: { startsWith: runPrefix },
      },
      include: { issues: true },
    });

    if (source === 'trigger') {
      await tx.skillIssue.updateMany({
        where: {
          skillId: skill.id,
          version: experiment.skillVersion as number,
          source: 'trigger',
          resolvedAt: null,
        },
        data: { resolvedAt: new Date(), resolvedRunId: `experiment:${experiment.id}:superseded` },
      });
    }

    const byResult = new Map<string, NormalizedExperimentIssue[]>();
    for (const issue of normalized) {
      const list = byResult.get(issue.resultId);
      if (list) list.push(issue);
      else byResult.set(issue.resultId, [issue]);
    }
    const desiredRunIds = new Set([...byResult.keys()].map((resultId) => `${runPrefix}${resultId}`));
    const staleEvaluations = existingEvaluations.filter((item) => !item.runId || !desiredRunIds.has(item.runId));
    let cleared = staleEvaluations.length
      ? (await tx.evaluation.deleteMany({ where: { id: { in: staleEvaluations.map((item) => item.id) } } })).count
      : 0;
    const existingByRunId = new Map(existingEvaluations
      .filter((item) => item.runId && desiredRunIds.has(item.runId))
      .map((item) => [item.runId as string, item]));

    let written = 0;
    for (const [resultId, issues] of byResult) {
      const representative = issues[0];
      const runId = `${runPrefix}${resultId}`;
      const existingEvaluation = existingByRunId.get(runId);
      const evaluation = existingEvaluation
        ? await tx.evaluation.update({
          where: { id: existingEvaluation.id },
          data: {
            type: source,
            executionId: representative.executionId,
            status: 'ok',
          },
        })
        : await tx.evaluation.create({ data: {
          type: source,
          skillId: skill.id,
          version: experiment.skillVersion as number,
          user: experiment.user,
          executionId: representative.executionId,
          generator: GENERATOR,
          runId,
          status: 'ok',
        } });
      const desiredIssues = new Map<string, NormalizedExperimentIssue>();
      for (const issue of issues) desiredIssues.set(issue.dedupKey, issue);
      const existingIssues = existingEvaluation?.issues || [];
      const keepIds = new Set<string>();

      for (const issue of desiredIssues.values()) {
        const matches = existingIssues.filter((item) => item.dedupKey === issue.dedupKey);
        const existingIssue = matches.find((item) => item.resolvedAt === null) || matches[0];
        if (existingIssue) {
          keepIds.add(existingIssue.id);
          const reactivatedByTrigger = source === 'trigger'
            && (existingIssue.resolvedAt === null || Boolean(existingIssue.resolvedRunId?.startsWith('experiment:')));
          await tx.skillIssue.update({
            where: { id: existingIssue.id },
            data: {
              source,
              severity: issue.severity,
              summary: issue.summary,
              evidence: issue.evidence,
              reasoning: issue.reasoning,
              suggestedFix: issue.suggestedFix,
              ruleId: 'experiment',
              dimension: issue.evaluatorId,
              category: issue.category,
              ...(reactivatedByTrigger ? { resolvedAt: null, resolvedRunId: null } : {}),
            },
          });
        } else {
          const created = await tx.skillIssue.create({
            data: {
              evaluationId: evaluation.id,
              source,
              skillId: skill.id,
              version: experiment.skillVersion as number,
              user: experiment.user,
              dedupKey: issue.dedupKey,
              severity: issue.severity,
              summary: issue.summary,
              evidence: issue.evidence,
              reasoning: issue.reasoning,
              suggestedFix: issue.suggestedFix,
              ruleId: 'experiment',
              dimension: issue.evaluatorId,
              category: issue.category,
            },
          });
          keepIds.add(created.id);
        }
      }
      const staleIssueIds = existingIssues.filter((item) => !keepIds.has(item.id)).map((item) => item.id);
      if (staleIssueIds.length) {
        cleared += (await tx.skillIssue.deleteMany({ where: { id: { in: staleIssueIds } } })).count;
      }
      written += desiredIssues.size;
    }
    return { source, written, cleared };
  });
}

export async function syncCompletedSkillExperimentIssues(input: {
  user: string;
  skillName: string;
  skillVersion: number;
}): Promise<{ experiments: number; written: number }> {
  const experiments = await prismaRaw.experiment.findMany({
    where: {
      user: input.user,
      skillName: input.skillName,
      skillVersion: input.skillVersion,
      status: 'done',
      OR: [
        { preset: { in: ['use-case', 'trigger'] } },
        { scope: 'skill-case-analysis' },
      ],
    },
    orderBy: { updatedAt: 'asc' },
    select: { id: true },
  });
  let written = 0;
  for (const experiment of experiments) {
    const synced = await syncExperimentSkillIssues(experiment.id);
    written += synced.written;
  }
  return { experiments: experiments.length, written };
}
