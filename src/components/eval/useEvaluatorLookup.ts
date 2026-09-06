'use client';

// 评估器元数据查找（实验详情 / Trace 评测详情共用）：
// 卡片来源 = 预置（preset-evaluators.ts）+ 自建（GET /api/user-evaluators），
// 名称/标签/类目全部从卡片 + registry 派生；找不到卡片时名称回退原 id、类目回退 'res'。
import { useEffect, useMemo, useState } from 'react';

import { apiFetch } from '@/lib/client/api';
import type { EvaluatorCard } from '@/lib/evaluators/custom-evaluator-model';
import { legacyPresetEvaluators, presetEvaluators } from '@/lib/evaluators/preset-evaluators';
import { deriveEvaluatorTags, getEvaluatorMeta, type EvaluatorCategory } from '@/lib/evaluators/registry';

export interface EvaluatorLookup {
  nameOf: (evaluatorId: string) => string;
  tagsOf: (evaluatorId: string) => string[];
  categoryOf: (evaluatorId: string) => EvaluatorCategory;
  /** 是否依赖预期输出（新增 case 时据此提示"不标注会不记分"）；找不到卡片按 false。 */
  requiresReference: (evaluatorId: string) => boolean;
  /** 是否依赖确定性匹配的数据集输入快照。 */
  requiresDatasetInput: (evaluatorId: string) => boolean;
}

export function useEvaluatorLookup(user: string | null | undefined): EvaluatorLookup {
  const [customCards, setCustomCards] = useState<EvaluatorCard[]>([]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/user-evaluators?user=${encodeURIComponent(user)}`);
        const data = await res.json();
        if (!cancelled && res.ok && Array.isArray(data)) setCustomCards(data);
      } catch { /* 拉不到自建卡片不阻塞——名称回退原 id */ }
    })();
    return () => { cancelled = true; };
  }, [user]);

  return useMemo(() => {
    const byId = new Map<string, EvaluatorCard>();
    for (const card of [...presetEvaluators, ...legacyPresetEvaluators]) byId.set(card.id, card);
    for (const card of customCards) byId.set(card.id, card);
    return {
      nameOf: (id: string) => byId.get(id)?.name || id,
      tagsOf: (id: string) => {
        const card = byId.get(id);
        return card ? deriveEvaluatorTags(card) : [];
      },
      categoryOf: (id: string) => {
        const card = byId.get(id);
        return card ? getEvaluatorMeta(card).category : 'res';
      },
      requiresReference: (id: string) => {
        const card = byId.get(id);
        return card ? getEvaluatorMeta(card).requires.includes('reference') : false;
      },
      requiresDatasetInput: (id: string) => {
        const card = byId.get(id);
        return card ? getEvaluatorMeta(card).requires.includes('dataset_input') : false;
      },
    };
  }, [customCards]);
}
