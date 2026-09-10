import { buildDatasetPairs } from './comparison';
import { caseSchema } from './domain';

type CaseRecord = { id: string; groupId: string | null; caseValuesJson: string | null };
export type CaseComparisonStatus = 'matched' | 'changed' | 'a-only' | 'b-only' | 'shared' | 'unmatched';
export type CaseComparisonPair = {
  key: string;
  caseIds: string[];
  status: CaseComparisonStatus;
  reason: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function buildCaseComparisonPairs(rows: CaseRecord[], snapshot: unknown): CaseComparisonPair[] | null {
  const config = record(snapshot);
  const dimension = record(config.comparison).dimension;
  if (config.kind !== 'evaluation-harness-v1' || typeof dimension !== 'string') return null;
  const groups = Array.isArray(config.groups) ? config.groups.map(record) : [];
  const groupA = groups.find(group => group.key === 'A');
  const groupB = groups.find(group => group.key === 'B');
  const datasetA = record(groupA?.dataset ?? config.dataset);
  const datasetB = record(groupB?.dataset ?? config.dataset);
  const sameDataset = dimension !== 'dataset' || Boolean(
    datasetA.assetKey && datasetA.assetKey === datasetB.assetKey
    || datasetA.id && datasetA.id === datasetB.id,
  );
  const parsed = rows.map(row => {
    let definition;
    try { definition = caseSchema.safeParse(JSON.parse(row.caseValuesJson || '{}')); } catch { /* 无法确认身份的历史记录单独保留。 */ }
    return { row, definition: definition?.success ? definition.data : null };
  });
  const counts = new Map<string, number>();
  for (const item of parsed) {
    if (!item.definition || !item.row.groupId) continue;
    const key = JSON.stringify([item.row.groupId, item.definition.id]);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const ambiguousIds = new Set(parsed.filter(item => item.definition && (
    (counts.get(JSON.stringify([groupA?.id, item.definition.id])) || 0) > 1
    || (counts.get(JSON.stringify([groupB?.id, item.definition.id])) || 0) > 1
  )).map(item => item.definition!.id));
  const special = new Map<string, CaseComparisonPair>();
  const valid = parsed.flatMap(item => {
    const shared = dimension === 'evaluator' && !item.row.groupId;
    const unknownGroup = item.row.groupId !== groupA?.id && item.row.groupId !== groupB?.id;
    const ambiguous = item.definition && ambiguousIds.has(item.definition.id);
    if (shared || !item.definition || unknownGroup || ambiguous) {
      special.set(item.row.id, {
        key: JSON.stringify([item.row.id]), caseIds: [item.row.id], status: shared ? 'shared' : 'unmatched',
        reason: shared ? 'A/B 组评估同一条 Trace' : ambiguous ? 'Case 标识重复，无法确定 A/B 对应关系' : '缺少有效的 Case 标识或分组，单独展示此记录',
      });
      return [];
    }
    return [{ rowId: item.row.id, groupId: item.row.groupId, case: item.definition, verdict: 'unknown' as const }];
  });
  const pairs = buildDatasetPairs(
    valid.filter(item => item.groupId === groupA?.id),
    valid.filter(item => item.groupId === groupB?.id),
    sameDataset,
  ).map(pair => {
    const caseIds = [pair.a?.rowId, pair.b?.rowId].filter((id): id is string => Boolean(id));
    return { key: JSON.stringify(caseIds), caseIds, status: pair.matchStatus as CaseComparisonStatus, reason: pair.reason };
  });
  const byCase = new Map(pairs.flatMap(pair => pair.caseIds.map(id => [id, pair] as const)));
  const ordered = new Map<string, CaseComparisonPair>();
  for (const row of rows) {
    const pair = special.get(row.id) || byCase.get(row.id)!;
    if (!ordered.has(pair.key)) ordered.set(pair.key, pair);
  }
  return [...ordered.values()];
}
