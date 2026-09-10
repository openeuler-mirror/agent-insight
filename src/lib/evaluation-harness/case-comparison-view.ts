import { caseScore, type CaseScore, type CategoryOf, type ResultRowLike } from '@/lib/engine/experiment/detail-agg';

export interface ComparisonCaseIdentity {
  id: string;
  groupKey?: string | null;
  comparisonKey?: string;
  comparisonStatus?: string;
}

export function buildComparisonCaseRows<T extends ComparisonCaseIdentity>(
  cases: T[],
  results: ResultRowLike[],
  groups: Array<{ key: string; evaluatorIds: string[] }>,
  categoryOf: CategoryOf,
) {
  type Side = T & { scores: CaseScore };
  const pairs = new Map<string, { key: string; a?: Side; b?: Side; unassigned?: Side }>();
  for (const item of cases) {
    const key = item.comparisonKey || item.id;
    const pair = pairs.get(key) || { key };
    if (item.comparisonStatus !== 'shared' && item.groupKey !== 'A' && item.groupKey !== 'B') {
      pair.unassigned = { ...item, scores: caseScore(results.filter((r) => r.caseId === item.id), categoryOf) };
      pairs.set(key, pair);
      continue;
    }
    for (const side of ['A', 'B'] as const) {
      if (item.groupKey && item.groupKey !== side) continue;
      const group = groups.find((group) => group.key === side);
      const sideResults = results.filter((r) => r.caseId === item.id && (!group || group.evaluatorIds.includes(r.evaluatorId)));
      pair[side === 'A' ? 'a' : 'b'] = { ...item, scores: caseScore(sideResults, categoryOf) };
    }
    pairs.set(key, pair);
  }
  return [...pairs.values()];
}
