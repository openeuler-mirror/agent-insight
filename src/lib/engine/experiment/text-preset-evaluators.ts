import type { EvaluatorOutput } from '../../evaluators/eval-output';
import type { FaithfulPresetContext } from './faithful-preset-evaluators';
import { runTextAiFlavorPreset, TEXT_AI_FLAVOR_PRESET_ID } from './text-ai-flavor-preset-evaluator';
import { runTextConcisenessPreset, TEXT_CONCISENESS_PRESET_ID } from './text-conciseness-preset-evaluator';
import { runTextFormatPreset, TEXT_FORMAT_PRESET_ID } from './text-format-preset-evaluator';
import {
  runTextLanguageConsistencyPreset,
  TEXT_LANGUAGE_CONSISTENCY_PRESET_ID,
} from './text-language-consistency-preset-evaluator';

export const TEXT_PRESET_IDS = [
  TEXT_AI_FLAVOR_PRESET_ID,
  TEXT_FORMAT_PRESET_ID,
  TEXT_LANGUAGE_CONSISTENCY_PRESET_ID,
  TEXT_CONCISENESS_PRESET_ID,
] as const;

export type TextPresetId = (typeof TEXT_PRESET_IDS)[number];

export function isTextPresetId(id: string): id is TextPresetId {
  return (TEXT_PRESET_IDS as readonly string[]).includes(id);
}

export function runTextPreset(id: TextPresetId, user: string, ctx: FaithfulPresetContext): Promise<EvaluatorOutput> {
  switch (id) {
    case TEXT_AI_FLAVOR_PRESET_ID: return runTextAiFlavorPreset(user, ctx);
    case TEXT_FORMAT_PRESET_ID: return runTextFormatPreset(user, ctx);
    case TEXT_LANGUAGE_CONSISTENCY_PRESET_ID: return runTextLanguageConsistencyPreset(user, ctx);
    case TEXT_CONCISENESS_PRESET_ID: return runTextConcisenessPreset(user, ctx);
  }
}
