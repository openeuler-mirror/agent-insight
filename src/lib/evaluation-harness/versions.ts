export interface VersionRun {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  summary?: any;
  manifest: any;
}
export function buildVersionView(input: VersionRun[], target: string, dataset: string, axis: 'agent' | 'dataset', requestedFixed = '', requestedCondition = '') {
  const runs = input.filter(r => !r.manifest.comparison && r.manifest.target?.assetKey === target && r.manifest.dataset?.assetKey === dataset)
    .sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const varying = axis === 'agent' ? 'target' : 'dataset', fixedKey = axis === 'agent' ? 'dataset' : 'target';
  const groups = [...runs.reduce((map, r) => {
    const key = r.manifest.target.id + '/' + r.manifest.dataset.id;
    const group = map.get(key) || { key, runs: [] as VersionRun[] };
    group.runs.push(r); map.set(key, group); return map;
  }, new Map<string, {key:string;runs:VersionRun[]}>()).values()];
  const scored = runs.filter(r => r.status === 'done' && typeof r.summary?.score === 'number' && Number.isFinite(r.summary.score) && r.manifest.comparisonHash);
  const cohorts = [...scored.reduce((map, r) => {
    const fixed = String(r.manifest[fixedKey].version), condition = r.manifest.comparisonHash;
    const key = fixed + '/' + condition;
    const cohort = map.get(key) || { fixed, condition, runs: [] as VersionRun[] };
    cohort.runs.push(r); map.set(key, cohort); return map;
  }, new Map<string,{fixed:string;condition:string;runs:VersionRun[]}>()).values()]
    .sort((a,b) => new Set(b.runs.map(r=>r.manifest[varying].version)).size - new Set(a.runs.map(r=>r.manifest[varying].version)).size || b.runs[0].createdAt.localeCompare(a.runs[0].createdAt));
  const fixedOptions = [...new Set(runs.map(r=>String(r.manifest[fixedKey].version)))].sort((a,b)=>Number(b)-Number(a));
  const fixed = fixedOptions.includes(requestedFixed) ? requestedFixed : cohorts[0]?.fixed || fixedOptions[0] || '';
  const conditions = cohorts.filter(c=>c.fixed===fixed);
  const condition = conditions.some(c=>c.condition===requestedCondition) ? requestedCondition : conditions[0]?.condition || '';
  const points = (conditions.find(c=>c.condition===condition)?.runs || [])
    .filter((r,i,all)=>all.findIndex(x=>x.manifest[varying].version===r.manifest[varying].version)===i)
    .sort((a,b)=>a.manifest[varying].version-b.manifest[varying].version);
  return { runs, groups, fixedOptions, fixed, conditions, condition, points };
}
