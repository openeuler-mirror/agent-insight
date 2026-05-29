export interface TaskCompletionKeyPointFindingLike {
  score?: unknown;
  [key: string]: unknown;
}

export interface TaskCompletionScoreSummary {
  score: number;
  itemCount: number;
  findings: Record<string, unknown>[];
}

function normalizeExplicitScore(value: unknown): number | null {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : NaN;
  if (!Number.isFinite(numeric)) return null;
  if (numeric < 0 || numeric > 1) return null;
  return numeric;
}

export function deriveKeyPointItemScore(finding: TaskCompletionKeyPointFindingLike): number {
  const explicitScore = normalizeExplicitScore(finding.score);
  if (explicitScore == null) {
    throw new Error('Each key point finding must include an explicit score between 0 and 1.');
  }
  return explicitScore;
}

export function deriveTaskCompletionScoreFromFindings(rawFindings: unknown): TaskCompletionScoreSummary {
  const findings = (Array.isArray(rawFindings) ? rawFindings : [])
    .map(item => item && typeof item === 'object' ? item as TaskCompletionKeyPointFindingLike : null)
    .filter((item): item is TaskCompletionKeyPointFindingLike => Boolean(item))
    .map(item => {
      const score = deriveKeyPointItemScore(item);
      return {
        ...item,
        score,
      };
    });

  if (findings.length === 0) {
    throw new Error('Task completion evaluation must include key_point_findings with explicit scores.');
  }

  const total = findings.reduce((sum, item) => sum + deriveKeyPointItemScore(item), 0);
  return {
    score: Math.max(0, Math.min(1, total / findings.length)),
    itemCount: findings.length,
    findings,
  };
}
