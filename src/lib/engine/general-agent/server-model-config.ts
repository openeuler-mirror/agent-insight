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

import { createHash } from 'node:crypto';
import { getActiveConfig, getUserSettings, type ModelConfig } from '@/lib/storage/server-config';
import type { ModelConfig as OpencodeModelConfig } from '@/lib/engine/skill-generation/opencode-agent-cli/opencode-client';
import { getModelAuthHeaders, isModelConnectionReady, normalizeModelBaseUrl, resolveModelConnection } from '@/lib/shared/model-connection';

/**
 * 服务端 ModelConfig（用户在 settings 里维护）→ opencode SDK 需要的 ModelConfig 形态。
 *
 * 字段映射：
 *   apiKey   → apiKey
 *   baseUrl  → baseURL
 *   model    → modelID
 *   provider/protocol → providerID（显式协议按配置独立注册；旧配置保留供应商映射）
 *
 * 如果用户没设置 active config，返回 null，由 caller 决定是否走 env 兜底。
 */
export async function loadServerModelForUser(
  user: string,
): Promise<OpencodeModelConfig | null> {
  const cfg = await getActiveConfig(user);
  return mapServerModelConfig(cfg);
}

/**
 * Resolve one explicitly frozen server-side model configuration. This is used by
 * reproducible background evaluations so changing the active model later does not
 * silently change an already-created experiment.
 */
export async function loadServerModelForUserById(
  user: string,
  configId: string,
): Promise<OpencodeModelConfig | null> {
  const settings = await getUserSettings(user);
  const cfg = settings.configs.find((item) => item.id === configId) || null;
  return mapServerModelConfig(cfg);
}

export function mapServerModelConfig(
  cfg: Awaited<ReturnType<typeof getActiveConfig>>,
): OpencodeModelConfig | null {
  if (!cfg || !isModelConnectionReady(cfg)) return null;

  const explicitProvider = cfg.provider;
  const providerID = cfg.protocol
    ? `insight-${createHash('sha256').update(cfg.id).digest('hex').slice(0, 16)}`
    : normalizeProviderID(explicitProvider || inferProviderFromBaseUrl(cfg.baseUrl));
  const connection = resolveModelConnection(cfg);
  const modelID = connection.model || defaultModelForProvider(providerID);

  return {
    providerID,
    modelID,
    apiKey: cfg.apiKey?.trim() ?? '',
    baseURL: connection.baseUrl || defaultBaseUrlForProvider(providerID),
    headers: cfg.headers,
  };
}

interface RuntimeProviderEntry {
  npm?: string;
  name?: string;
  options: { apiKey: string; baseURL?: string; headers: Record<string, string | null> };
  models: Record<string, { name: string; limit?: { context: number; output: number } }>;
}

export function buildRegisteredModelProviders(configs: ModelConfig[], activeConfigId: string) {
  const provider: Record<string, RuntimeProviderEntry> = {};
  const builtin = new Set(['deepseek', 'deepseek-official', 'openai', 'anthropic', 'google', 'qwen', 'moonshot']);
  let activeModel = '';
  // Register the active legacy connection last so same-provider legacy models keep its credentials.
  const ordered = [...configs.filter(c => c.id !== activeConfigId), ...configs.filter(c => c.id === activeConfigId)];
  for (const config of ordered) {
    const runtime = mapServerModelConfig(config);
    if (!runtime) continue;
    const native = config.protocol ? config.protocol === 'anthropic' : runtime.providerID === 'anthropic';
    const { baseUrl } = resolveModelConnection(config);
    let baseURL = normalizeModelBaseUrl(baseUrl ?? runtime.baseURL);
    if (native && baseURL && !baseURL.endsWith('/v1')) baseURL += '/v1';
    const entry: RuntimeProviderEntry = {
      options: { apiKey: config.apiKey?.trim() ?? '', baseURL,
        headers: { Authorization: null, authorization: null, 'x-api-key': null, 'api-key': null,
          ...getModelAuthHeaders(config, native ? 'anthropic' : 'openai-compatible') } },
      models: { ...provider[runtime.providerID]?.models, [runtime.modelID]: { name: runtime.modelID,
        ...(runtime.modelID.includes('reasoner') ? { limit: { context: 65536, output: 32768 } } : {}) } },
    };
    if (config.protocol || !builtin.has(runtime.providerID)) {
      entry.npm = native ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible';
      entry.name = config.name;
    }
    provider[runtime.providerID] = entry;
    if (config.id === activeConfigId) activeModel = `${runtime.providerID}/${runtime.modelID}`;
  }
  return { provider, model: activeModel, small_model: activeModel };
}

/**
 * 用户存的 providerID 别名 → opencode 实际注册的 providerID。
 * 例如 UI 里选 "deepseek" 存到 DB，但 opencode 只认识 "deepseek-official"。
 */
const PROVIDER_ALIAS: Record<string, string> = {
  'deepseek': 'deepseek-official',
};

export function normalizeProviderID(providerID: string): string {
  return PROVIDER_ALIAS[providerID] ?? providerID;
}

/** 从 baseUrl 推断 opencode providerID。未识别时返回 'deepseek-official' 兜底。 */
export function inferProviderFromBaseUrl(baseUrl?: string): string {
  if (!baseUrl) return 'deepseek-official';
  const lower = baseUrl.toLowerCase();
  if (lower.includes('api.deepseek.com')) return 'deepseek-official';
  if (lower.includes('api.openai.com')) return 'openai';
  if (lower.includes('api.anthropic.com')) return 'anthropic';
  if (lower.includes('generativelanguage.googleapis.com')) return 'google';
  if (lower.includes('dashscope')) return 'qwen';
  if (lower.includes('moonshot')) return 'moonshot';
  // 兜底：当作 deepseek-official（OpenAI 兼容协议），由 baseURL 强制路由
  return 'deepseek-official';
}

function defaultBaseUrlForProvider(providerID: string): string | undefined {
  switch (providerID) {
    case 'deepseek':
    case 'deepseek-official':
      return 'https://api.deepseek.com';
    case 'openai':
      return 'https://api.openai.com/v1';
    case 'anthropic':
      return 'https://api.anthropic.com';
    default:
      return undefined;
  }
}

function defaultModelForProvider(providerID: string): string {
  switch (providerID) {
    case 'deepseek':
    case 'deepseek-official':
      return 'deepseek-v4-flash';
    case 'openai':
      return 'gpt-4o-mini';
    case 'anthropic':
      return 'claude-haiku-4-5-20251001';
    default:
      return 'deepseek-v4-flash';
  }
}
