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

export function verificationDisplay(payload: {
  message?: string;
  structural?: boolean;
  behavioral?: { ok?: boolean; fullCoverage?: boolean; targetFailures?: unknown[]; measured?: number; skipped?: string; incomplete?: string; reused?: number; baseMean?: number | null; candMean?: number | null } | null;
}) {
  const behavior = payload.behavioral;
  if (payload.structural === false) return { status: 'warning', text: payload.message || '结构检查未通过' };
  if (behavior?.ok === false) return { status: 'warning', text: `行为验证未通过：${behavior.baseMean} → ${behavior.candMean} 分；${behavior.targetFailures?.length ? '目标问题未解决' : '存在用例退步'}` };
  if (behavior?.incomplete) return { status: 'warning', text: `结构检查已完成；行为验证未完成：${behavior.incomplete}` };
  if (behavior?.fullCoverage === false) return { status: 'warning', text: `已验证 ${behavior.measured || 0} 个用例；未覆盖全部来源用例，需完整复测` };
  if (behavior?.skipped) return { status: 'warning', text: `结构检查已完成；行为验证跳过：${behavior.skipped}` };
  if (behavior?.measured) return { status: 'ok', text: `行为验证完成：${behavior.measured} 个用例，${behavior.baseMean} → ${behavior.candMean} 分；复用 ${behavior.reused || 0} 个旧版结果` };
  return { status: 'warning', text: payload.message || '结构检查已完成；尚无有效行为对比，请通过实验复测确认效果' };
}
