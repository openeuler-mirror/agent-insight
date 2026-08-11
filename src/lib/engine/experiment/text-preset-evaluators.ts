/**
 * 文本质量预置评估器族入口（preset-fluency-text / preset-hallucination-text）。
 * 归属判断 + 分发转发；实现分别在 fluency-preset-evaluators.ts /
 * hallucination-preset-evaluators.ts，共享 judge 引擎在 text-judge-common.ts。
 */
import type { EvaluatorOutput } from '@/lib/evaluators/eval-output';
import type { FaithfulPresetContext } from './faithful-preset-evaluators';
import {
  FLUENCY_PRESET_IDS,
  isFluencyPresetId,
  runFluencyPreset,
} from './fluency-preset-evaluators';
import {
  HALLUCINATION_PRESET_IDS,
  isHallucinationPresetId,
  runHallucinationPreset,
} from './hallucination-preset-evaluators';

export const TEXT_PRESET_IDS = [...FLUENCY_PRESET_IDS, ...HALLUCINATION_PRESET_IDS] as const;
export type TextPresetId = (typeof TEXT_PRESET_IDS)[number];

export function isTextPresetId(id: string): id is TextPresetId {
  return (TEXT_PRESET_IDS as readonly string[]).includes(id);
}

export async function runTextPreset(
  id: TextPresetId,
  user: string,
  ctx: FaithfulPresetContext,
): Promise<EvaluatorOutput> {
  if (isFluencyPresetId(id)) return runFluencyPreset(id, user, ctx);
  if (isHallucinationPresetId(id)) return runHallucinationPreset(id, user, ctx);
  throw new Error(`未知文本质量评估器 id: ${id}`);
}
