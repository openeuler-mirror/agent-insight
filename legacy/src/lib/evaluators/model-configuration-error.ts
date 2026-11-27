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

export const MISSING_EVALUATION_MODEL_MESSAGE = '未配置可用的评测模型，请前往「模型注册」添加模型、测试连接并设为默认后重评。';

const MISSING_MODEL_MESSAGES = new Set([
  MISSING_EVALUATION_MODEL_MESSAGE,
  '未配置可用的评测模型',
  '未配置可用的评测模型，请到「模型注册」页完善连接信息',
  '未配置评测模型',
  '未配置评测模型，请先在「模型配置」中激活一个模型。',
  '未配置评测模型，无法提取关键观点',
]);

export function isMissingEvaluationModelError(message: string | null | undefined): boolean {
  return Boolean(message && MISSING_MODEL_MESSAGES.has(message.trim().replace(/^Error:\s*/, '')));
}
