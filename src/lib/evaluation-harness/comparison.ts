import { z } from 'zod';
import type { EvalCase, Verdict } from './domain';
export const comparisonSchema = z.object({
  dimension: z.enum(['agent', 'skill', 'llm', 'evaluator', 'dataset']),
  targetBId: z.string().min(1).optional(),
  skillAId: z.string().min(1).optional(),
  skillBId: z.string().min(1).optional(),
  datasetBId: z.string().min(1).optional(),
  caseBIds: z.array(z.string().min(1)).min(1).max(500).refine(ids => new Set(ids).size === ids.length, 'Case ID 不能重复').optional(),
  modelA: z.string().trim().min(1).max(200).optional(),
  modelB: z.string().trim().min(1).max(200).optional(),
  evaluatorBIds: z.array(z.string()).min(1).max(10).refine(ids => new Set(ids).size === ids.length, '评估器不能重复').optional(),
}).strict().superRefine((config, context) => {
  const allowed: Record<string, string[]> = {agent:['targetBId'],skill:['targetBId','skillAId','skillBId'],llm:['modelA','modelB'],evaluator:['evaluatorBIds'],dataset:['datasetBId','caseBIds']};
  for (const key of Object.keys(config)) if (key !== 'dimension' && config[key as keyof typeof config] !== undefined && !allowed[config.dimension].includes(key)) context.addIssue({code:'custom',path:[key],message:'只允许改变本次选择的对比模块，其他配置必须共享'});
  if (config.dimension === 'skill' && (config.skillAId || config.skillBId) && (!config.skillAId || !config.skillBId || config.targetBId)) context.addIssue({code:'custom',message:'请选择 A/B 两个 Skill 版本，不能混用旧目标对比配置'});
  if (config.dimension === 'dataset' && !config.datasetBId) context.addIssue({code:'custom',path:['datasetBId'],message:'请选择 B 组评测集版本'});
});
export type ComparisonConfig = z.infer<typeof comparisonSchema>;
export const comparisonLabels = {single:'无变量 · 单组',agent:'Agent 对比',skill:'Skill 对比',llm:'LLM 对比',evaluator:'评估器对比',dataset:'评测集对比'};
export function validateComparison(config: ComparisonConfig, target: any, targetB: any, evaluatorIds: string[], dataset?: any, datasetB?: any, skillA?: any, skillB?: any) {
  comparisonSchema.parse(config);
  const boundSkill = config.dimension === 'skill' && Boolean(config.skillAId);
  if (boundSkill) {
    if (target.content.type !== 'agent') throw new Error('Skill 对比需要选择一个共享的执行 Agent');
    if (!skillA || !skillB || skillA.id === skillB.id) throw new Error('A/B 组请选择不同的 Skill 版本');
    if (skillA.content.type !== 'skill' || skillB.content.type !== 'skill' || skillA.assetKey !== skillB.assetKey || skillA.content.externalId !== skillB.content.externalId) throw new Error('请选择同一 Skill 的两个版本');
  }
  if (config.dimension === 'agent' || (config.dimension === 'skill' && !boundSkill)) {
    if (!targetB || target.id === targetB.id) throw new Error('A/B 组请选择不同的目标或版本');
    if (config.dimension === 'skill' && (target.content.type !== 'skill' || targetB.content.type !== 'skill' || target.assetKey !== targetB.assetKey)) throw new Error('请选择同一 Skill 的两个版本');
    if (config.dimension === 'agent' && (target.content.type !== 'agent' || targetB.content.type !== 'agent')) throw new Error('Agent 对比需要选择 Agent 目标');
    if (config.dimension === 'skill' && ['adapter','endpoint','externalId','credentialId'].some(key=>(target.content[key] || '') !== (targetB.content[key] || ''))) throw new Error('Skill 对比必须共享同一个执行接入');
    if ((target.content.model || '') !== (targetB.content.model || '')) throw new Error('本次对比的模型配置必须共享，请选择相同模型的目标版本');
    if (config.dimension === 'agent' && stable(target.content.skills || []) !== stable(targetB.content.skills || [])) throw new Error('Agent 对比的 Skill 配置必须共享，请选择相同 Skill 配置的目标版本');
  }
  if (config.dimension === 'dataset' && (!datasetB || dataset?.id === datasetB.id)) throw new Error('A/B 组请选择不同的评测集或版本');
  if (config.dimension === 'llm' && (!config.modelA || !config.modelB || config.modelA === config.modelB)) throw new Error('A/B 组请选择不同模型');
  if (config.dimension === 'evaluator' && (!config.evaluatorBIds?.length || [...config.evaluatorBIds].sort().join('\0') === [...evaluatorIds].sort().join('\0'))) throw new Error('A/B 组请选择不同的评估器或版本组合');
}
export function compareCaseVerdicts(a: Verdict, b: Verdict, dimension = 'agent') {
  if (a === 'unknown' || b === 'unknown') return {comparable:false,delta:null,label:'未评完整'};
  const delta = (b === 'pass' ? 100 : 0) - (a === 'pass' ? 100 : 0);
  return {comparable:true,delta,label:dimension==='evaluator' ? a===b?'判定一致':'判定不同' : delta>0?'B 改善':delta<0?'B 退化':'持平'};
}


function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+stable(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
type DatasetResultRow = {rowId?: string;case: Pick<EvalCase,'id'|'name'> & Partial<Pick<EvalCase,'note'|'category'|'difficulty'|'tags'>> & {turns: Array<{input:string;expectedOutput?:string;expectation?:unknown}>};verdict: Verdict};
export function buildDatasetPairs<T extends DatasetResultRow>(rowsA: T[], rowsB: T[], sameDataset: boolean) {
  const remaining = new Set(rowsB);
  const inputs = (row:T) => stable(row.case.turns.map(t=>t.input));
  const definition = (row:T) => stable({name:row.case.name,note:row.case.note || '',category:row.case.category || 'positive',difficulty:row.case.difficulty || 'medium',tags:row.case.tags || [],turns:row.case.turns.map(t=>({input:t.input,expectedOutput:t.expectedOutput || '',expectation:t.expectation || {}}))});
  const pair = (a:T | undefined,b:T | undefined) => {
    const row = a || b!;
    const matchStatus = !a ? 'b-only' : !b ? 'a-only' : definition(a) === definition(b) ? 'matched' : 'changed';
    const reason = matchStatus === 'b-only' ? 'B 组独有 Case，无 A 组对应项' : matchStatus === 'a-only' ? 'A 组独有 Case，无 B 组对应项' : matchStatus === 'changed' ? '输入、预期输出、逐轮规则、评估说明或 Case 标注不同，不计算改善或退化' : '逐轮输入、预期输出、规则、评估说明与 Case 标注相同';
    return {pairId:`${a?.rowId || a?.case.id || '-'}:${b?.rowId || b?.case.id || '-'}`,caseId:row.case.id,name:row.case.name,input:row.case.turns[0].input,a,b,matchStatus,reason,
      ...(matchStatus === 'matched' ? compareCaseVerdicts(a!.verdict,b!.verdict,'evaluator') : {comparable:false,delta:null,label:matchStatus === 'changed' ? '输入或规则已变化' : !a ? '仅 B 组' : '仅 A 组'})};
  };
  const exactMatches = new Map<T,T>();
  if (!sameDataset) for (const a of rowsA) {
    const b = [...remaining].find(b=>definition(a) === definition(b));
    if (b) { exactMatches.set(a,b); remaining.delete(b); }
  }
  const pairs = rowsA.map(a=>{
    const b = exactMatches.get(a) || [...remaining].find(b=>sameDataset ? b.case.id === a.case.id : inputs(b) === inputs(a));
    if (b) remaining.delete(b);
    return pair(a,b);
  });
  return [...pairs,...[...remaining].map(b=>pair(undefined,b))];
}
