import type { EvaluatorCard } from '@/lib/evaluators/custom-evaluator-model';
import type { CatalogAsset } from './useEvaluationCatalog';

export const evaluatorRuleNames = ['路由', '结束状态', '文本包含', '正则匹配', '必须工具', '禁止工具', '工具参数', '工具顺序', 'JSON 结构', '字段校验'];
const presetKeys = new Set(['business-rules', 'skill-routing-rules', 'semantic-judge']);

export function evaluatorCards(assets: CatalogAsset[], selectedVersions: Record<string, string>): EvaluatorCard[] {
  const versions = assets.filter(asset => asset.kind === 'evaluator' && !asset.archived)
    .sort((a, b) => b.version - a.version);
  const keys = [...new Set(versions.map(asset => asset.assetKey))];
  return keys.map(key => {
    const asset = versions.find(item => item.assetKey === key && item.id === selectedVersions[key])
      || versions.find(item => item.assetKey === key)!;
    const rules = asset.content.type === 'rules';
    const points = rules ? asset.content.checkNames || evaluatorRuleNames : [];
    return {
      id: asset.id,
      name: asset.name,
      description: rules ? points.join('、') : asset.content.prompt || '根据 Case 预期答案与执行证据评分。',
      evaluatorType: rules ? 'Code' : 'LLM',
      source: presetKeys.has(key) ? 'preset' : 'custom',
      category: rules ? 'traj' : 'res',
      targetTypes: [rules ? '轨迹' : '结果'],
      objectives: [rules ? '业务规则' : '任务完成'],
      scenarios: ['单轮 / 多轮 Case'],
      runMode: rules ? '规则检查' : 'LLM Judge',
      scoreRange: '0-100',
      popularity: 0,
      mappedMetrics: points,
      status: 'ready',
      pointsDef: points.map((label: string) => ({ label })),
      ...(rules ? {} : { llmConfig: { model: '', systemPrompt: asset.content.prompt || '' } }),
    };
  });
}
