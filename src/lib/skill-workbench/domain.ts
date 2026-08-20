import { createHash } from 'crypto';

export const WORKBENCH_ACTIVE_VIEWS = [
  'detail',
  'evaluation',
  'experiment',
  'optimization',
] as const;

export type SkillWorkbenchActiveView = (typeof WORKBENCH_ACTIVE_VIEWS)[number];

export const WORKBENCH_STAGES = ['empty', 'preparing', 'ready', 'busy'] as const;
export type SkillWorkbenchStage = (typeof WORKBENCH_STAGES)[number];

export const WORKBENCH_SOURCES = ['generated', 'uploaded', 'management'] as const;
export type SkillWorkbenchSource = (typeof WORKBENCH_SOURCES)[number];

export const WORKBENCH_TASK_TYPES = [
  'generation',
  'evaluation',
  'experiment',
  'optimization',
  'retest',
  'publish',
] as const;

export type SkillWorkbenchTaskType = (typeof WORKBENCH_TASK_TYPES)[number];

export const WORKBENCH_TASK_STATUSES = [
  'pending',
  'running',
  'done',
  'failed',
  'cancelled',
] as const;

export type SkillWorkbenchTaskStatus = (typeof WORKBENCH_TASK_STATUSES)[number];

export const OPTIMIZATION_STATUSES = [
  'optimizing',
  'pending_retest',
  'retesting',
  'retest_passed',
  'retest_failed',
  'retest_cancelled',
  'published',
  'abandoned',
  'optimization_failed',
  'optimization_cancelled',
] as const;

export type SkillOptimizationStatus = (typeof OPTIMIZATION_STATUSES)[number];

const OPTIMIZATION_TRANSITIONS: Record<SkillOptimizationStatus, ReadonlySet<SkillOptimizationStatus>> = {
  optimizing: new Set(['pending_retest', 'optimization_failed', 'optimization_cancelled']),
  pending_retest: new Set(['retesting', 'abandoned']),
  retesting: new Set(['retest_passed', 'retest_failed', 'retest_cancelled']),
  retest_passed: new Set(['published', 'optimizing', 'abandoned']),
  retest_failed: new Set(['optimizing', 'retesting', 'abandoned']),
  retest_cancelled: new Set(['retesting', 'abandoned']),
  published: new Set(),
  abandoned: new Set(),
  optimization_failed: new Set(),
  optimization_cancelled: new Set(),
};

export function isWorkbenchActiveView(value: unknown): value is SkillWorkbenchActiveView {
  return typeof value === 'string' && WORKBENCH_ACTIVE_VIEWS.includes(value as SkillWorkbenchActiveView);
}

export function isWorkbenchStage(value: unknown): value is SkillWorkbenchStage {
  return typeof value === 'string' && WORKBENCH_STAGES.includes(value as SkillWorkbenchStage);
}

export function isWorkbenchSource(value: unknown): value is SkillWorkbenchSource {
  return typeof value === 'string' && WORKBENCH_SOURCES.includes(value as SkillWorkbenchSource);
}

export function isWorkbenchTaskType(value: unknown): value is SkillWorkbenchTaskType {
  return typeof value === 'string' && WORKBENCH_TASK_TYPES.includes(value as SkillWorkbenchTaskType);
}

export function isOptimizationStatus(value: unknown): value is SkillOptimizationStatus {
  return typeof value === 'string' && OPTIMIZATION_STATUSES.includes(value as SkillOptimizationStatus);
}

export function canTransitionOptimization(
  from: SkillOptimizationStatus,
  to: SkillOptimizationStatus,
): boolean {
  return OPTIMIZATION_TRANSITIONS[from].has(to);
}

export function assertOptimizationTransition(
  from: SkillOptimizationStatus,
  to: SkillOptimizationStatus,
): void {
  if (!canTransitionOptimization(from, to)) {
    throw new Error(`Invalid skill optimization transition: ${from} -> ${to}`);
  }
}

export function makeWorkbenchTaskIdempotencyKey(input: {
  type: SkillWorkbenchTaskType;
  skillName?: string | null;
  version?: number | null;
  targetRef?: string | null;
}): string {
  const payload = JSON.stringify({
    type: input.type,
    skillName: input.skillName?.trim() || null,
    version: input.version ?? null,
    targetRef: input.targetRef?.trim() || null,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 24);
}

export function computeSkillSnapshotHash(files: Record<string, string>): string {
  const normalized = Object.entries(files)
    .map(([filePath, content]) => [filePath.replaceAll('\\', '/'), content] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
}

export function isBlockingStaticQualityIssue(issue: {
  severity?: unknown;
  evidence?: unknown;
  reasoning?: unknown;
}): boolean {
  if (issue.severity !== 'high') return false;
  return [issue.evidence, issue.reasoning].some((value) => (
    typeof value === 'string' && value.trim().length > 0
  ));
}

export function displayStaticQualitySeverity(issue: {
  severity?: unknown;
  evidence?: unknown;
  reasoning?: unknown;
}): string {
  if (issue.severity === 'high' && !isBlockingStaticQualityIssue(issue)) return 'medium';
  return typeof issue.severity === 'string' ? issue.severity : 'low';
}
