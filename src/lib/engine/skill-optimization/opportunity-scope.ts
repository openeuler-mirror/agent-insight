import {
  resolveSkillEditRegionsForIssue,
  type SkillEditRegion,
} from './skill-edit-regions';

export interface AggregatedSkillIssueInput {
  id: string;
  dedupKey: string;
  source: 'static' | 'dynamic' | 'feedback';
  severity: 'high' | 'medium' | 'low';
  summary: string;
  evidence: string | null;
  reasoning: string | null;
  suggestedFix: string | null;
  category: string | null;
  prevalenceCount: number;
  evaluationType?: 'static' | 'dynamic' | null;
  executionTaskId?: string | null;
  evaluationRunId?: string | null;
}

export interface OptimizationOpportunity {
  id: string;
  source: 'skill-issue';
  issueId?: string;
  dedupKey?: string;
  category: string;
  severity: 'high' | 'medium' | 'low';
  content: string;
  evidence?: string;
  reasoning?: string;
  suggestedFix?: string;
  prevalenceCount?: number;
  targetFiles: string[];
  targetRegions?: SkillEditRegion[];
}

export interface OpportunityScopeLimits {
  maxOpportunities?: number;
  maxFiles?: number;
}

export interface OpportunityDerivationOptions {
  skillContent?: string | null;
}

export interface OptimizationScope {
  selected: OptimizationOpportunity[];
  deferred: OptimizationOpportunity[];
  issueIds: string[];
  allowedFiles: string[];
  allowedRegions: SkillEditRegion[];
  limits: Required<OpportunityScopeLimits>;
}

export const DEFAULT_SCOPE_LIMITS: Required<OpportunityScopeLimits> = {
  maxOpportunities: 5,
  maxFiles: 5,
};

export function deriveOpportunitiesFromAggregatedIssues(
  issues: AggregatedSkillIssueInput[],
  options: OpportunityDerivationOptions = {},
): OptimizationOpportunity[] {
  return issues
    .map(issue => {
      const category = issue.category || categoryFromIssueSource(issue);
      const targetRegions = options.skillContent != null
        ? resolveSkillEditRegionsForIssue(options.skillContent, {
          category,
          summary: issue.summary,
          evidence: issue.evidence,
          reasoning: issue.reasoning,
          suggestedFix: issue.suggestedFix,
        })
        : undefined;
      return {
        id: `issue:${issue.id}`,
        source: 'skill-issue' as const,
        issueId: issue.id,
        dedupKey: issue.dedupKey,
        category,
        severity: issue.severity,
        content: issue.summary,
        evidence: issue.evidence || undefined,
        reasoning: issue.reasoning || undefined,
        suggestedFix: issue.suggestedFix || undefined,
        prevalenceCount: issue.prevalenceCount,
        targetFiles: ['SKILL.md'],
        targetRegions,
      };
    })
    .sort(compareOpportunities);
}

export function buildOptimizationScope(
  opportunities: OptimizationOpportunity[],
  limits: OpportunityScopeLimits = {},
): OptimizationScope {
  const resolvedLimits = resolveOpportunityScopeLimits(limits);
  const ranked = [...opportunities].sort(compareOpportunities);
  const selected: OptimizationOpportunity[] = [];
  const regionScoped = ranked.some(opportunity => opportunity.targetRegions !== undefined);
  const files = new Set<string>(regionScoped ? [] : ['SKILL.md']);
  const regions = new Map<string, SkillEditRegion>();

  for (const opportunity of ranked) {
    if (selected.length >= resolvedLimits.maxOpportunities) break;
    if (regionScoped && (!opportunity.targetRegions || opportunity.targetRegions.length === 0)) {
      continue;
    }
    const nextFiles = new Set(files);
    for (const file of opportunity.targetFiles) nextFiles.add(file);
    for (const region of opportunity.targetRegions ?? []) nextFiles.add(region.file);
    if (nextFiles.size > resolvedLimits.maxFiles) continue;
    selected.push(opportunity);
    nextFiles.forEach(file => files.add(file));
    for (const region of opportunity.targetRegions ?? []) {
      regions.set(regionKey(region), region);
    }
  }

  const selectedIds = new Set(selected.map(item => item.id));
  const deferred = ranked.filter(item => !selectedIds.has(item.id));

  return {
    selected,
    deferred,
    issueIds: selected.map(item => item.issueId).filter((id): id is string => Boolean(id)),
    allowedFiles: [...files].sort(),
    allowedRegions: [...regions.values()].sort(compareRegions),
    limits: resolvedLimits,
  };
}

export function resolveOpportunityScopeLimits(
  limits: OpportunityScopeLimits = {},
): Required<OpportunityScopeLimits> {
  return {
    maxOpportunities: normalizePositiveInteger(limits.maxOpportunities) ?? DEFAULT_SCOPE_LIMITS.maxOpportunities,
    maxFiles: normalizePositiveInteger(limits.maxFiles) ?? DEFAULT_SCOPE_LIMITS.maxFiles,
  };
}

export function compareOpportunities(a: OptimizationOpportunity, b: OptimizationOpportunity): number {
  const severityDiff = severityRank(b.severity) - severityRank(a.severity);
  if (severityDiff !== 0) return severityDiff;

  const prevalenceDiff = (b.prevalenceCount ?? 1) - (a.prevalenceCount ?? 1);
  if (prevalenceDiff !== 0) return prevalenceDiff;

  return a.id.localeCompare(b.id);
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const numeric = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  const integer = Math.trunc(numeric);
  return integer >= 1 ? integer : undefined;
}

function severityRank(severity: 'high' | 'medium' | 'low'): number {
  if (severity === 'high') return 3;
  if (severity === 'medium') return 2;
  return 1;
}

function categoryFromIssueSource(issue: AggregatedSkillIssueInput): string {
  if (issue.source === 'static' || issue.evaluationType === 'static') return '静态扫描';
  if (issue.source === 'dynamic' || issue.evaluationType === 'dynamic') return '轨迹偏差';
  return '其它';
}

function regionKey(region: SkillEditRegion): string {
  return [
    region.file,
    region.kind,
    region.label,
    region.startLine,
    region.endLine,
  ].join('\0');
}

function compareRegions(a: SkillEditRegion, b: SkillEditRegion): number {
  if (a.file !== b.file) return a.file.localeCompare(b.file);
  return a.startLine - b.startLine || a.endLine - b.endLine || a.label.localeCompare(b.label);
}
