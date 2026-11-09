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

import { getProvider } from '@/lib/llm-providers';

export interface ModelConnectionConfig {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  headers?: Record<string, string>;
}

export function normalizeModelBaseUrl(baseUrl?: string): string | undefined {
  const base = baseUrl?.trim().replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/^(https:\/\/(?:api\.openai\.com|(?:[a-z-]+\.)?api\.x\.ai)\/v1)\/responses$/i, '$1');
  if (base && /^https:\/\/(?:api\.(?:openai\.com|anthropic\.com|x\.ai)|[a-z-]+\.api\.x\.ai)$/i.test(base)) {
    return base + '/v1';
  }
  if (base && /^https:\/\/[^/]+\.openai\.azure\.com\/openai$/i.test(base)) return base + '/v1';
  return base || undefined;
}

export function resolveModelConnection(config: ModelConnectionConfig) {
  const provider = getProvider(config.provider === 'deepseek' ? 'deepseek-official' : config.provider);
  return {
    baseUrl: normalizeModelBaseUrl(config.baseUrl) || provider?.baseUrl || undefined,
    model: config.model?.trim() || provider?.defaultModel || undefined,
  };
}

const FORBIDDEN_CUSTOM_HEADERS = new Set([
  '__proto__',
  'connection',
  'constructor',
  'content-length',
  'host',
  'prototype',
  'transfer-encoding',
]);

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function supportsCustomHeaders(config: ModelConnectionConfig): boolean {
  return config.provider === 'custom';
}

export function isModelConnectionReady(
  config: ModelConnectionConfig | null | undefined,
): boolean {
  if (!config) return false;
  if (supportsCustomHeaders(config)) {
    return Boolean(config.baseUrl?.trim() && config.model?.trim());
  }
  return Boolean(config.apiKey?.trim());
}

export function normalizeCustomHeaders(
  headers: Record<string, string> | null | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (Array.isArray(headers) || typeof headers !== 'object') {
    throw new Error('Custom headers must be a JSON object');
  }
  const normalized: Record<string, string> = {};
  const seen = new Set<string>();

  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim();
    const value = typeof rawValue === 'string' ? rawValue : '';
    if (!name && !value) continue;
    if (!name || !HEADER_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid HTTP header name: ${rawName || '(empty)'}`);
    }
    if (!value.trim() || /[\r\n]/.test(value)) {
      throw new Error(`Invalid value for HTTP header: ${name}`);
    }
    const lowerName = name.toLowerCase();
    if (FORBIDDEN_CUSTOM_HEADERS.has(lowerName)) {
      throw new Error(`HTTP header is managed by the transport and cannot be configured: ${name}`);
    }
    if (seen.has(lowerName)) {
      throw new Error(`Duplicate HTTP header name: ${name}`);
    }
    seen.add(lowerName);
    normalized[name] = value;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function getOpenAICompatibleClientConfig(config: ModelConnectionConfig): {
  apiKey: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
} {
  const { baseUrl } = resolveModelConnection(config);
  return {
    apiKey: config.apiKey?.trim() || 'no-api-key-required',
    ...(baseUrl ? { baseURL: baseUrl } : {}),
    ...(config.headers && Object.keys(config.headers).length > 0
      ? { defaultHeaders: config.headers }
      : {}),
  };
}
