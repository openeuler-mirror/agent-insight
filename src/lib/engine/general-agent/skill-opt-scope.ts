import type {
  OptimizationScope,
  OpportunityScopeLimits,
} from '@/lib/engine/skill-optimization/opportunity-scope';
import {
  DEFAULT_SCOPE_LIMITS,
  buildOptimizationScope,
  deriveOpportunitiesFromAggregatedIssues,
  resolveOpportunityScopeLimits,
  type AggregatedSkillIssueInput,
} from '@/lib/engine/skill-optimization/opportunity-scope';
import type { SkillOptIssueLite } from './skill-opt-prompt';

export interface SkillOptScopeSummary {
  selectedIssueIds: string[];
  deferredIssueIds: string[];
  selectedOpportunityIds: string[];
  deferredOpportunityIds: string[];
  allowedFiles: string[];
  allowedRegions: OptimizationScope['allowedRegions'];
  selectedCount: number;
  deferredCount: number;
  limits: Required<OpportunityScopeLimits>;
}

export type SkillOptScopeLimitInput = {
  maxOpportunities?: unknown;
  maxFiles?: unknown;
} | null | undefined;

export function buildSkillOptIssueScope(
  issues: SkillOptIssueLite[],
  limits?: SkillOptScopeLimitInput,
  skillContent?: string | null,
): OptimizationScope {
  const opportunities = deriveOpportunitiesFromAggregatedIssues(
    issues.map(issueToAggregatedInput),
    { skillContent },
  );
  return buildOptimizationScope(opportunities, resolveSkillOptScopeLimits(limits));
}

export function selectSkillOptIssues(
  issues: SkillOptIssueLite[],
  scope: OptimizationScope,
): SkillOptIssueLite[] {
  const byId = new Map(issues.map(issue => [issue.id, issue]));
  return scope.issueIds
    .map(id => byId.get(id))
    .filter((issue): issue is SkillOptIssueLite => Boolean(issue));
}

export function summarizeSkillOptScope(scope: OptimizationScope): SkillOptScopeSummary {
  return {
    selectedIssueIds: scope.issueIds,
    deferredIssueIds: scope.deferred
      .map(item => item.issueId)
      .filter((id): id is string => Boolean(id)),
    selectedOpportunityIds: scope.selected.map(item => item.id),
    deferredOpportunityIds: scope.deferred.map(item => item.id),
    allowedFiles: scope.allowedFiles,
    allowedRegions: scope.allowedRegions,
    selectedCount: scope.selected.length,
    deferredCount: scope.deferred.length,
    limits: scope.limits,
  };
}

export function resolveSkillOptScopeLimits(
  overrides?: SkillOptScopeLimitInput,
  env: Record<string, string | undefined> = process.env,
): Required<OpportunityScopeLimits> {
  const envLimits: OpportunityScopeLimits = {
    maxOpportunities: envNumber(env.SKILL_OPT_MAX_OPPORTUNITIES),
    maxFiles: envNumber(env.SKILL_OPT_MAX_FILES),
  };
  const overrideLimits: OpportunityScopeLimits = overrides && typeof overrides === 'object'
    ? {
      maxOpportunities: normalizeLimitInput(overrides.maxOpportunities),
      maxFiles: normalizeLimitInput(overrides.maxFiles),
    }
    : {};

  return resolveOpportunityScopeLimits({
    maxOpportunities: overrideLimits.maxOpportunities ?? envLimits.maxOpportunities ?? DEFAULT_SCOPE_LIMITS.maxOpportunities,
    maxFiles: overrideLimits.maxFiles ?? envLimits.maxFiles ?? DEFAULT_SCOPE_LIMITS.maxFiles,
  });
}

function issueToAggregatedInput(issue: SkillOptIssueLite): AggregatedSkillIssueInput {
  return {
    id: issue.id,
    dedupKey: issue.dedupKey || issue.id,
    source: sourceFromIssue(issue),
    severity: issue.severity,
    summary: issue.summary,
    evidence: issue.evidence || null,
    reasoning: issue.reasoning || null,
    suggestedFix: issue.improvementSuggestion || null,
    category: issue.category || null,
    prevalenceCount: Math.max(1, Math.trunc(issue.occurrence ?? 1)),
  };
}

function sourceFromIssue(issue: SkillOptIssueLite): AggregatedSkillIssueInput['source'] {
  if (issue.sourceKind === 'static') return 'static';
  if (issue.sourceKind === 'log') return 'feedback';
  return 'dynamic';
}

function envNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  return normalizeLimitInput(value);
}

function normalizeLimitInput(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const numeric = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  const integer = Math.trunc(numeric);
  return integer >= 1 ? integer : undefined;
}
