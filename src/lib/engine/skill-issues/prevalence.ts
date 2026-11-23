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
 * Prevalence-driven severity 抬升。
 *
 * 思路（借鉴 trace2skill）：dedupKey 跨 N 次 evaluation 检出 = 系统性问题，
 * 单纯按 DB 写入时的 severity 排会让"偶发的 high"压过"反复出现的 medium"，
 * 不符合用户对"哪个问题最值得先解决"的直觉。
 *
 * 阈值：
 *   count >= 10  → 任何 severity 一律抬到 high（极顽固）
 *   count >= 5   → medium 抬到 high；low 抬到 medium
 *   count >= 3   → low 抬到 medium
 *
 * 不调高 high（已经最高）。规则简单但保守——MVP 阶段用户对算法的预期是"看得懂"
 * 优于"最优"，未来要做更复杂权重（结合 match_score 等）再说。
 */

export type Severity = 'high' | 'medium' | 'low';

export function bumpSeverityByPrevalence(severity: Severity, count: number): Severity {
  if (count >= 10) return 'high';
  if (count >= 5) {
    if (severity === 'medium') return 'high';
    if (severity === 'low') return 'medium';
    return severity;
  }
  if (count >= 3) {
    if (severity === 'low') return 'medium';
    return severity;
  }
  return severity;
}
