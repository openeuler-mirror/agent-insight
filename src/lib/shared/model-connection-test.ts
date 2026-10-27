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

export const DEFAULT_MODEL_TEST_TIMEOUT_MS = 60_000;
export const MIN_MODEL_TEST_TIMEOUT_MS = 10_000;
export const MAX_MODEL_TEST_TIMEOUT_MS = 300_000;

export class ModelTestValidationError extends Error {}

export function resolveModelTestTimeoutMs(value: unknown): number {
  if (value === undefined) return DEFAULT_MODEL_TEST_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isInteger(value) ||
      value < MIN_MODEL_TEST_TIMEOUT_MS || value > MAX_MODEL_TEST_TIMEOUT_MS) {
    throw new ModelTestValidationError('Connection test timeout must be between 10 and 300 seconds');
  }
  return value;
}

export type ModelTestErrorCode = 'timeout' | 'cancelled' | 'authentication' | 'rate_limit' |
  'network' | 'invalid_request' | 'server' | 'invalid_response' | 'unknown';

export interface ModelTestResult {
  success: boolean;
  code?: ModelTestErrorCode;
  elapsedMs: number;
  timeoutMs: number;
  error?: string;
}

export function formatModelTestResult(result: ModelTestResult, locale: string): string {
  const zh = locale === 'zh';
  const seconds = (result.elapsedMs / 1000).toFixed(1);
  const limit = result.timeoutMs / 1000;
  if (result.success) return zh ? `测试通过，用时 ${seconds} 秒（上限 ${limit} 秒）。` : `Test passed in ${seconds}s (limit ${limit}s).`;
  const messages: Record<ModelTestErrorCode, [string, string]> = {
    timeout: ['本次测试超时，可能与服务排队或网络延迟有关。可延长超时后重试。', 'The test timed out. The service may be busy or the network slow. Increase the timeout and retry.'],
    cancelled: ['测试已取消，配置未保存。', 'Test cancelled. Configuration was not saved.'],
    authentication: ['鉴权失败，请检查 API Key 或自定义请求头。', 'Authentication failed. Check your API key or custom headers.'],
    rate_limit: ['模型服务当前限流，请稍后重试。', 'The model service is rate limiting requests. Retry later.'],
    network: ['无法访问模型服务，请检查服务地址、网络或代理配置。', 'Cannot reach the model service. Check the URL, network or proxy.'],
    invalid_request: ['请求参数无效，请检查模型名、接口地址及连接测试超时（10～300 秒）。', 'Invalid request. Check the model, endpoint and test timeout (10–300 seconds).'],
    server: ['模型服务暂时异常，请稍后重试。', 'The model service is temporarily unavailable. Retry later.'],
    invalid_response: ['模型服务返回了无效响应，请检查接口是否兼容 Chat Completions。', 'Invalid model response. Check Chat Completions compatibility.'],
    unknown: ['连接测试失败，请检查模型服务配置后重试。', 'Connection test failed. Check the model service configuration and retry.'],
  };
  const message = messages[result.code ?? 'unknown'][zh ? 0 : 1];
  return `${message} ${zh ? `用时 ${seconds} 秒，上限 ${limit} 秒。` : `Elapsed ${seconds}s, limit ${limit}s.`}`;
}
