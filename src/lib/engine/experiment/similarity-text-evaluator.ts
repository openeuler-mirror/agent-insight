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
 * 通用文本相似度评估器（preset-similarity-text），LLM 模式
 *
 * 直接调用 LLM 进行五档锚定打分
 */
import { callJudgeLlm } from './judge-llm';
import { SimilarityJudgeParseError, extractJson, str } from './similarity-preset-evaluators';
import { normalizeEvaluatorOutput, type EvaluatorOutput, type EvalPoint } from '../../evaluators/eval-output';
import {
  DEFAULT_SIMILARITY_TEXT_RUN_CONFIG,
  type SimilarityTextRunConfig,
} from '../../evaluators/evaluator-run-config';
import type { FaithfulPresetContext } from './faithful-preset-evaluators';

/** 五档锚定（离散判断 + 确定性汇总） */
const SIMILARITY_LEVELS: Record<string, { score: number; label: string }> = {
  semantically_same: { score: 100, label: '完全同义' },
  mostly_similar: { score: 85, label: '高度相似' },
  partially_similar: { score: 65, label: '部分相似' },
  slightly_similar: { score: 30, label: '略微相似' },
  not_similar: { score: 0, label: '完全不同' },
};
const SIMILARITY_KEYS = Object.keys(SIMILARITY_LEVELS);

const TEXT_SIMILARITY_SYSTEM = [
  '你是一个专业的文本语义相似度评估器。你的任务是判断「生成文本」与「参考文本」是否表达了相同的含义。',
  '',
  '【相似度判据】',
  '- 同义改写视为高度相似：如「提高效率」vs「提升效能」、「增加收益」vs「提升利润」',
  '- 语序变换不影响语义的视为高度相似',
  '- 细节增减但不影响核心含义的视为高度相似',
  '- 只有部分信息重合、其余不同的视为部分相似',
  '- 仅词汇有重叠但核心语义不同（如「苹果很好吃」vs「苹果手机很好用」）不得判为相似',
  '',
  '【level 判定标准】',
  '- semantically_same：两段文本含义完全相同',
  '- mostly_similar：含义高度重合，仅表达方式不同（同义改写 / 语序变化 / 细节微调）',
  '- partially_similar：核心含义部分重合、部分不同',
  '- slightly_similar：仅有少量词汇重叠、语义差异明显',
  '- not_similar：含义完全不同',
  '',
  '【输出格式】只输出一个 JSON 对象，不要额外文字：',
  '{',
  '  "level": "semantically_same|mostly_similar|partially_similar|slightly_similar|not_similar",',
  '  "reason": "相似/不相似的原因说明（中文，引用关键差异点，说明判为该档位的依据）"',
  '}',
  'level 必须使用上述五个取值之一，不得自创。',
].join('\n');

function buildSimilarityPoints(
  levelDef: { score: number; label: string },
  reason: string,
  passed: boolean,
  deviation: number,
  threshold: number,
): EvalPoint[] {
  return [
    {
      label: `语义相似度（${levelDef.label}）`,
      score: levelDef.score,
      status: levelDef.score >= 65 ? 'covered' : levelDef.score >= 30 ? 'partial' : 'missing',
      evidence: reason ? { md: reason } : undefined,
    },
    {
      label: `阈值判定（≥${threshold} 通过）`,
      score: passed ? 100 : 0,
      status: passed ? 'covered' : 'missing',
      evidence: {
        md: `${passed ? 'PASS' : 'FAIL'}：相似度 ${levelDef.score} ${passed ? '≥' : '<'} ${threshold}，偏差 ${deviation >= 0 ? '+' : ''}${deviation}`,
      },
    },
  ];
}

export async function runTextSimilarity(
  user: string,
  ctx: FaithfulPresetContext,
  config?: SimilarityTextRunConfig | null,
): Promise<EvaluatorOutput> {
  const generated = (ctx.actualOutput ?? '').trim();
  const reference = (ctx.referenceOutput ?? '').trim();
  if (!generated || !reference) {
    const reason = !generated ? '生成文本为空' : '参考文本为空';
    // 不给分：无分的结果只展示原因，不计入综合分与类目均分。
    return normalizeEvaluatorOutput({
      summary: `${reason}，无法计算相似度——不记分。`,
      evidence: { md: `${reason}，无法进行语义相似度比较，本次不记分（不计入综合分与类目均分）。` },
    });
  }

  const text = await callJudgeLlm(user, {
    system: TEXT_SIMILARITY_SYSTEM,
    user: `【生成文本】\n\`\`\`\n${generated}\n\`\`\`\n\n【参考文本】\n\`\`\`\n${reference}\n\`\`\`\n`,
    sessionTitle: 'exp-judge-preset-similarity-text',
  });

  const raw = extractJson(text) as Record<string, unknown>;
  const level = str(raw.level).toLowerCase();
  const levelDef = SIMILARITY_LEVELS[level];
  if (!levelDef) {
    throw new SimilarityJudgeParseError(
      `LLM 返回了未知的相似度档位「${raw.level}」，合法值为 ${SIMILARITY_KEYS.join('|')}`,
      text,
    );
  }
  const reason = str(raw.reason).trim();
  const score = levelDef.score;
  const threshold = (config ?? DEFAULT_SIMILARITY_TEXT_RUN_CONFIG).threshold;
  const passed = score >= threshold;
  const deviation = score - threshold;

  const summary = passed
    ? `生成与参考文本语义${levelDef.label}（相似度 ${score}），达到阈值 ${threshold}（偏差 +${deviation}）——PASS。`
    : `生成与参考文本${levelDef.label}（相似度 ${score}），未达阈值 ${threshold}（偏差 ${deviation}）——FAIL。`;

  return normalizeEvaluatorOutput({
    verdict: passed ? 'pass' : 'fail',
    summary,
    score,
    points: buildSimilarityPoints(levelDef, reason, passed, deviation, threshold),
    evidence: reason
      ? { md: `档位：${levelDef.label}（${score} 分）\n\n原因：${reason}\n\n阈值判定（≥${threshold}）：${passed ? 'PASS' : 'FAIL'}，偏差 ${deviation >= 0 ? '+' : ''}${deviation}` }
      : undefined,
  });
}
