interface ComparisonTargetAsset {
  id: string;
  kind: string;
  assetKey: string;
  name?: string;
  archived?: boolean;
  content: { type?: string };
}

export function resolveComparisonTargets(
  assets: readonly ComparisonTargetAsset[],
  targetId: string,
  targetBId: string,
  dimension: 'agent' | 'skill',
): { targetId: string; targetBId: string } {
  const matching = assets.filter(asset => asset.kind === 'target' && asset.content.type === dimension);
  const target = matching.find(asset => asset.id === targetId) || matching.find(asset => !asset.archived);
  if (!target) return { targetId: '', targetBId: '' };
  const candidatesB = matching.filter(asset => dimension !== 'skill' || asset.assetKey === target.assetKey);
  const targetB = candidatesB.find(asset => asset.id === targetBId) || candidatesB.find(asset => !asset.archived && asset.id !== target.id);
  return { targetId: target.id, targetBId: targetB?.id || '' };
}


export function resolveAgentFromNative(assets: readonly ComparisonTargetAsset[], targetId: string): string {
  if (!targetId.startsWith('native:')) return targetId;
  const name = targetId.slice(7).trim();
  if (!name) return targetId;
  const matching = assets.filter(asset => asset.kind === 'target' && asset.content.type === 'agent' && asset.name?.trim() === name);
  return (matching.find(asset => !asset.archived) || matching[0])?.id || targetId;
}
