import type { EvalCase } from './domain';

export function caseRerunConfig(detail:any,rowId:string,experimentId:string) {
  const row=detail.experiment.cases.find((value:{id:string})=>value.id===rowId);
  if(!row)throw new Error('Case 不存在');
  const original=JSON.parse(row.caseValuesJson) as EvalCase;
  const m=detail.manifest;
  const group=m.groups?.find((value:{id:string})=>value.id===row.groupId);
  const pairedComparison=['agent','skill','llm','evaluator'].includes(m.comparison?.dimension);
  return {
    name:detail.experiment.name+' · '+original.name,
    targetId:pairedComparison?m.target.id:group?.target?.id || m.target.id,
    datasetId:pairedComparison?m.dataset.id:group?.dataset?.id || m.dataset.id,
    evaluatorIds:pairedComparison?m.evaluatorIds:group?.evaluatorIds || m.evaluatorIds || m.evaluators.map((e:{id:string})=>e.id),
    ...(pairedComparison?{comparison:m.comparison}:{}),
    threshold:m.threshold,concurrency:1,timeoutSeconds:m.timeoutSeconds,retries:m.retries,
    caseIds:[original.id],sourceExperimentId:experimentId,
  };
}
