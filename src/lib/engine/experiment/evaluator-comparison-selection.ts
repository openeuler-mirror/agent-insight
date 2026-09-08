import type { EvaluatorCard } from '@/lib/evaluators/custom-evaluator-model';
import { gateEvaluator, getEvaluatorMeta, type CaseGateInfo, type EvaluatorGateResult } from '@/lib/evaluators/registry';

export const RELIABILITY_EVALUATOR_IDS = new Set(['preset-ras-reliability-detection-recovery']);

interface EvaluatorComparisonInput {
  groupA: string;
  groupB: string;
  evaluators: readonly EvaluatorCard[];
  cases: CaseGateInfo[];
  isReliabilityDataset: boolean;
}

interface EvaluatorComparisonGroup {
  key: 'A' | 'B';
  id: string;
  card?: EvaluatorCard;
  gate: EvaluatorGateResult;
}

export function resolveEvaluatorComparison(input: EvaluatorComparisonInput): { groups: EvaluatorComparisonGroup[]; error: string | null } {
  const groups = (['A', 'B'] as const).map(key => {
    const id = (key === 'A' ? input.groupA : input.groupB).trim();
    const card = input.evaluators.find(card => card.id === id);
    const gate: EvaluatorGateResult = !id
      ? { usable: false, reason: '请先选择评估器' }
      : !card
        ? { usable: false, reason: '评估器不存在或不可访问，请重新选择' }
        : card.status !== 'ready'
          ? { usable: false, reason: '评估器尚未就绪，请重新选择' }
          : RELIABILITY_EVALUATOR_IDS.has(id) && !input.isReliabilityDataset
            ? { usable: false, reason: '该评估器仅适用于可靠性数据集' }
            : gateEvaluator(id, getEvaluatorMeta(card), input.cases, [id]);
    return { key, id, card, gate };
  });
  if (groups[0].id && groups[0].id === groups[1].id) return { groups, error: 'A/B 两组请选择不同的评估器' };
  const invalid = groups.find(group => !group.gate.usable);
  if (invalid) return { groups, error: `${invalid.key} 组：${invalid.gate.reason}` };
  return { groups, error: input.cases.length ? null : '请先关联两组共用的 Trace' };
}
