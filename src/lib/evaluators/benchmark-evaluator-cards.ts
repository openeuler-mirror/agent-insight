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

import type { BenchmarkManifest, BenchmarkPresentation } from '../../../packages/benchmark-protocol/src/contracts';
import type { EvaluatorCard } from './custom-evaluator-model';

export interface BenchmarkEvaluatorCardSource {
  evaluatorKey: string;
  benchmarkName: string;
  presentation?: BenchmarkPresentation;
}

export function benchmarkEvaluatorCard(source: BenchmarkEvaluatorCardSource): EvaluatorCard {
  const evaluator = source.presentation?.evaluator;
  const primaryMetric = source.presentation?.result?.primaryMetric;

  return {
    id: `benchmark:${source.evaluatorKey}`,
    name: evaluator?.displayName || `${source.benchmarkName} Evaluator`,
    description: evaluator?.description || '使用 Benchmark 接入包声明的评测逻辑判定结果。',
    evaluatorType: 'Code',
    source: 'preset',
    category: 'res',
    targetTypes: ['Benchmark'],
    objectives: [primaryMetric?.label || 'Benchmark 评测'],
    scenarios: [source.benchmarkName],
    runMode: evaluator?.runMode || 'Benchmark Evaluator',
    scoreRange: primaryMetric?.type === 'boolean' ? 'Pass / Fail' : 'Benchmark 指标',
    popularity: 100,
    mappedMetrics: [primaryMetric?.label || '结果'],
    status: 'ready',
    outputDescription: evaluator?.outputDescription,
    runtimeNote: `仅适用于 ${source.benchmarkName} 数据集；选择数据集后自动绑定，隐藏评测数据不会发送给 Agent。`,
  };
}

export function benchmarkEvaluatorCardsFromManifests(
  manifests: readonly BenchmarkManifest[],
): EvaluatorCard[] {
  const cards = new Map<string, EvaluatorCard>();
  for (const manifest of manifests) {
    const card = benchmarkEvaluatorCard({
      evaluatorKey: manifest.evaluation.evaluatorKey,
      benchmarkName: manifest.displayName,
      presentation: manifest.presentation,
    });
    if (cards.has(card.id)) {
      throw new Error(`Benchmark evaluatorKey 重复：${manifest.evaluation.evaluatorKey}`);
    }
    cards.set(card.id, card);
  }
  return [...cards.values()];
}
