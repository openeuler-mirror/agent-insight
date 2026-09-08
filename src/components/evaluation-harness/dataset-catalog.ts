import type { AgentDataset, DatasetField } from '@/lib/agent-dataset-model';
import type { EvalCase } from '@/lib/evaluation-harness/domain';
export interface VersionedDatasetAsset {
  id: string; kind: string; assetKey: string; name: string; version: number; archived?: boolean;
  createdAt?: string; content: { cases: EvalCase[] };
}
export function datasetCards(assets: VersionedDatasetAsset[], includeArchived = false) {
  const latest = new Map<string, VersionedDatasetAsset>();
  for (const asset of assets) {
    if (asset.kind !== 'dataset' || (asset.archived && !includeArchived)) continue;
    if (!latest.has(asset.assetKey) || latest.get(asset.assetKey)!.version < asset.version) latest.set(asset.assetKey, asset);
  }
  return [...latest.values()].map(asset => ({
    id: 'versioned-' + asset.id, name: asset.name, description: '逐轮输入、预期答案、Skill 路由与工具调用规则',
    targetAgent: '', targetSkill: '', datasetKind: 'trajectory' as const, tags: [...(asset.archived ? ['已删除'] : []), `v${asset.version}`, `${assets.filter(a => a.kind === 'dataset' && a.assetKey === asset.assetKey).length} 个版本`],
    fields: [{id:'turns',key:'turns',label:'逐轮输入与规则',type:'json'}] as DatasetField[],
    caseCount: asset.content.cases.length, createdAt: asset.createdAt || '', updatedAt: asset.createdAt || '', versionAssetId: asset.id, versionArchived: !!asset.archived,
  } satisfies Omit<AgentDataset, 'cases'> & {caseCount:number;versionAssetId:string;versionArchived:boolean}));
}
