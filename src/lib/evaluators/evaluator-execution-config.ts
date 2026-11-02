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

import { EvaluatorRunConfigValidationError, serializeEvaluatorRunConfigs } from './evaluator-run-config';

export interface EvaluatorAttemptConfig {
  attemptTimeoutSeconds: number;
  maxRetries: number;
}

export interface EvaluatorExecutionConfig {
  mode: 'system' | 'uniform';
  uniform?: EvaluatorAttemptConfig;
  overrides: Record<string, EvaluatorAttemptConfig>;
}

export type EvaluatorExecutionCapabilities = Record<string, EvaluatorAttemptConfig & { scopeNote?: string }>;
export interface EvaluatorExecutionSnapshot {
  policyVersion: 1;
  config: EvaluatorExecutionConfig;
  resolved: Record<string, EvaluatorAttemptConfig & { source: 'system' | 'uniform' | 'override' }>;
}

export const EVALUATOR_TIMEOUT_RANGE = { min: 30, max: 3600 } as const;
export const EVALUATOR_MAX_RETRIES = 3;
export const INITIAL_UNIFORM_CONFIG: EvaluatorAttemptConfig = { attemptTimeoutSeconds: 600, maxRetries: 2 };

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EvaluatorRunConfigValidationError(`${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function knownFields(value: Record<string, unknown>, fields: string[], label: string) {
  if (Object.keys(value).some((key) => !fields.includes(key))) {
    throw new EvaluatorRunConfigValidationError(`${label} 包含不支持的配置字段`);
  }
}

export function normalizeEvaluatorAttemptConfig(value: unknown): EvaluatorAttemptConfig {
  const raw = record(value, '评估运行配置');
  knownFields(raw, ['attemptTimeoutSeconds', 'maxRetries'], '评估运行配置');
  const { attemptTimeoutSeconds, maxRetries } = raw;
  if (!Number.isInteger(attemptTimeoutSeconds) || Number(attemptTimeoutSeconds) < EVALUATOR_TIMEOUT_RANGE.min
    || Number(attemptTimeoutSeconds) > EVALUATOR_TIMEOUT_RANGE.max) {
    throw new EvaluatorRunConfigValidationError('评估超时必须为 30～3600 秒的整数');
  }
  if (!Number.isInteger(maxRetries) || Number(maxRetries) < 0 || Number(maxRetries) > EVALUATOR_MAX_RETRIES) {
    throw new EvaluatorRunConfigValidationError('评估重试次数必须为 0～3 的整数');
  }
  return { attemptTimeoutSeconds: Number(attemptTimeoutSeconds), maxRetries: Number(maxRetries) };
}

export function resolveEvaluatorExecutionConfig(
  value: unknown,
  selectedIds: readonly string[],
  capabilities: EvaluatorExecutionCapabilities,
): EvaluatorExecutionSnapshot {
  const raw = record(value, 'evaluatorExecutionConfig');
  knownFields(raw, ['mode', 'uniform', 'overrides'], 'evaluatorExecutionConfig');
  if (raw.mode !== 'system' && raw.mode !== 'uniform') {
    throw new EvaluatorRunConfigValidationError('评估运行配置 mode 必须为 system 或 uniform');
  }
  if (raw.mode === 'system' && raw.uniform !== undefined) {
    throw new EvaluatorRunConfigValidationError('系统默认模式不能提交统一配置');
  }
  const uniform = raw.mode === 'uniform' ? normalizeEvaluatorAttemptConfig(raw.uniform) : undefined;
  const overrides: Record<string, EvaluatorAttemptConfig> = {};
  for (const [id, config] of Object.entries(record(raw.overrides ?? {}, 'overrides'))) {
    if (!selectedIds.includes(id) || !Object.hasOwn(capabilities, id)) {
      throw new EvaluatorRunConfigValidationError(`评估器 ${id} 未选中或不支持运行配置`);
    }
    overrides[id] = normalizeEvaluatorAttemptConfig(config);
  }
  const resolved: EvaluatorExecutionSnapshot['resolved'] = {};
  for (const id of selectedIds) {
    if (!Object.hasOwn(capabilities, id)) continue;
    const source = Object.hasOwn(overrides, id) ? 'override' : uniform ? 'uniform' : 'system';
    const { attemptTimeoutSeconds, maxRetries } = overrides[id] ?? uniform ?? capabilities[id];
    resolved[id] = { attemptTimeoutSeconds, maxRetries, source };
  }
  if (uniform && !Object.keys(resolved).length) {
    throw new EvaluatorRunConfigValidationError('未选择支持运行配置的 LLM 评估器');
  }
  return { policyVersion: 1, config: { mode: raw.mode, ...(uniform ? { uniform } : {}), overrides }, resolved };
}

export function serializeExperimentEvaluatorConfigs(
  textConfigs: unknown,
  selectedIds: readonly string[],
  execution?: EvaluatorExecutionSnapshot,
): string {
  const stored = serializeEvaluatorRunConfigs(textConfigs, selectedIds);
  if (!execution) return stored;
  return JSON.stringify({ ...JSON.parse(stored), schemaVersion: 2, execution });
}

export function parseStoredEvaluatorExecutionConfig(
  stored: string | null | undefined,
): EvaluatorExecutionSnapshot | undefined {
  if (!stored) return undefined;
  const raw = record(JSON.parse(stored), '实验评估器配置');
  if (raw.schemaVersion !== 2) return undefined;
  const execution = record(raw.execution, 'execution');
  if (execution.policyVersion !== 1) throw new EvaluatorRunConfigValidationError('不支持的评估运行策略版本');
  const resolved = record(execution.resolved, 'resolved');
  const capabilities: EvaluatorExecutionCapabilities = {};
  for (const [id, item] of Object.entries(resolved)) {
    const config = record(item, id);
    capabilities[id] = normalizeEvaluatorAttemptConfig({ attemptTimeoutSeconds: config.attemptTimeoutSeconds, maxRetries: config.maxRetries });
  }
  const validated = resolveEvaluatorExecutionConfig(execution.config, Object.keys(resolved), capabilities);
  for (const [id, item] of Object.entries(resolved)) {
    if (JSON.stringify(validated.resolved[id]) !== JSON.stringify({ ...capabilities[id], source: record(item, id).source })) {
      throw new EvaluatorRunConfigValidationError('评估运行快照与配置不一致');
    }
  }
  return validated;
}
