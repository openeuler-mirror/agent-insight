/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * similarity 族预置评估器：
 *
 *    1. preset-similarity-text          --TextSimilarityGrader 通用文本相似度评估器（LLM模式）
 *    2. preset-similarity-answer-match  --AnswerMatchGrader 客观答案匹配评估器
 *
 */
import type { EvaluatorOutput } from '../../evaluators/eval-output';
import { JudgeOutputParseError } from '../../evaluators/judge-assembly';
import {
  normalizeSimilarityTextRunConfig,
  type ConfigurableTextEvaluatorId,
  type EvaluatorRunConfigMap,
} from '../../evaluators/evaluator-run-config';
import type { FaithfulPresetContext } from './faithful-preset-evaluators';
import { runTextSimilarity } from './similarity-text-evaluator';
import { runAnswerMatch } from './similarity-answer-match-evaluator';


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
  config?: EvaluatorRunConfigMap[ConfigurableTextEvaluatorId] | null,
): Promise<EvaluatorOutput> {
  if (id === 'preset-similarity-text') {
    return runTextSimilarity(user, ctx, normalizeSimilarityTextRunConfig(config));
  }
  return runAnswerMatch(user, ctx);
}

