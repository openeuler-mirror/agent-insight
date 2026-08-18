/**
 * similarity 族预置评估器：
 *
 *    1. preset-similarity-text          --TextSimilarityGrader 通用文本相似度评估器（LLM模式）
 *    2. preset-similarity-answer-match  --AnswerMatchGrader 客观答案匹配评估器
 *
 */
import type { EvaluatorOutput } from '../../evaluators/eval-output';
import { JudgeOutputParseError } from '../../evaluators/judge-assembly';
import type { SimilarityTextRunConfig } from '../../evaluators/evaluator-run-config';
import type { FaithfulPresetContext } from './faithful-preset-evaluators';
import { runTextSimilarity } from './similarity-text-evaluator'
import { runAnswerMatch } from './similarity-answer-match-evaluator'


export const SIMILARITY_PRESET_IDS = [
  'preset-similarity-text',
  'preset-similarity-answer-match',
] as const;
export type SimilarityPresetId = (typeof SIMILARITY_PRESET_IDS)[number];

export function isSimilarityPresetId(id: string): id is SimilarityPresetId {
  return (SIMILARITY_PRESET_IDS as readonly string[]).includes(id);
}

// ── 通用工具 ─────────────────────────────────────────────────────────────────

export class SimilarityJudgeParseError extends JudgeOutputParseError {
  constructor(message: string, rawText: string) {
    super(message, rawText);
    this.name = 'SimilarityJudgeParseError';
  }
}

export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new SimilarityJudgeParseError('LLM 输出未包含有效 JSON', text);
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    throw new SimilarityJudgeParseError(
      `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
      text,
    );
  }
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}


// ── 分发 ──────────────────────────────────────────────────────────────────────

export async function runSimilarityPreset(
  id: SimilarityPresetId,
  user: string,
  ctx: FaithfulPresetContext,
  config?: SimilarityTextRunConfig | null,
): Promise<EvaluatorOutput> {
  if (id === 'preset-similarity-text') return runTextSimilarity(user, ctx, config);
  return runAnswerMatch(user, ctx);
}

