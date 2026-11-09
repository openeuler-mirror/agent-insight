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

import type { OpenAI } from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import type { AnyZodObject } from 'zod';
import { getProxyConfig } from '@/lib/ingest/proxy-config';

const ANTHROPIC_HOST = 'api.anthropic.com';
const CHAT_PATH = '/chat/completions';
const AZURE_DEPLOYMENT_PATH = /^\/openai\/deployments\/[^/]+(?:\/chat\/completions)?\/?$/;
const AZURE_SAMPLING_FIELDS = ['temperature', 'top_p', 'logprobs', 'top_logprobs', 'seed'];

export function getJsonResponseFormat(
  baseURL: string,
  name: string,
  schema: AnyZodObject,
): OpenAI.ResponseFormatJSONObject | OpenAI.ResponseFormatJSONSchema {
  // The Anthropic compatibility endpoint accepts only strict JSON Schema.
  return new URL(baseURL).hostname === ANTHROPIC_HOST
    ? zodResponseFormat(schema, name)
    : { type: 'json_object' };
}

function isModernOpenAIModel(model: string): boolean {
  return /^(?:gpt-[56](?:[.-]|$)|o[134](?:-|$))/i.test(model);
}

export function isClaudeFixedSamplingModel(model: string): boolean {
  // Claude 4.0 snapshot IDs put an eight-digit date after the major version.
  return /^claude-(?:mythos-|[a-z]+-(?:[5-9]|4-(?!\d{8}(?:-|$))(?:[7-9]|\d{2,}))(?:-|$))/i.test(model);
}

function replaceTokenLimit(body: Record<string, unknown>, from: 'max_tokens' | 'max_completion_tokens') {
  const to = from === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
  body[to] ??= body[from];
  delete body[from];
}

async function fetchAzureChat(
  fetcher: typeof fetch,
  input: string | URL,
  init: RequestInit,
  body: Record<string, unknown>,
  legacy: boolean,
): Promise<Response> {
  const tokenField = legacy ? 'max_tokens' : 'max_completion_tokens';
  if (!legacy && Object.hasOwn(body, 'max_tokens')) replaceTokenLimit(body, 'max_tokens');

  // Each retry removes its trigger field, allowing one token and one sampling adjustment.
  for (;;) {
    const response = await fetcher(input, { ...init, body: JSON.stringify(body) });
    if (response.status !== 400 || init.signal?.aborted) return response;

    const payload = await response.clone().json().catch(() => null);
    const { param, code, message } = payload?.error ?? payload ?? {};
    const rejection = typeof message === 'string'
      ? /^(?:Unsupported (?:parameter|value):|Unrecognized request argument supplied:)(?: '?([a-z_]+)\b)?/.exec(message)
      : null;
    const field = param ?? rejection?.[1];
    const unsupported = code === 'unsupported_parameter' || code === 'unsupported_value'
      || (code == null && rejection !== null);
    if (!unsupported || typeof field !== 'string' || !Object.hasOwn(body, field) || init.signal?.aborted) return response;

    if (field === tokenField) {
      replaceTokenLimit(body, tokenField);
    } else if (AZURE_SAMPLING_FIELDS.includes(field)) {
      for (const samplingField of AZURE_SAMPLING_FIELDS) delete body[samplingField];
    } else {
      return response;
    }
    await response.body?.cancel();
  }
}

export function getModelFetch(fetcher = getProxyConfig().customFetch ?? globalThis.fetch): typeof fetch {
  return async (input, init) => {
    if (init?.method?.toUpperCase() !== 'POST' || typeof init.body !== 'string' || input instanceof Request) {
      return fetcher(input, init);
    }

    const url = new URL(input);
    const { hostname } = url;
    const azure = hostname.endsWith('.openai.azure.com');
    const azureDeployment = azure && AZURE_DEPLOYMENT_PATH.test(url.pathname);
    const version = azureDeployment ? url.searchParams.get('api-version') : null;
    if (version?.endsWith(CHAT_PATH)) {
      // OpenAI's SDK concatenates the operation path after a query in baseURL.
      const path = url.pathname.replace(/\/$/, '');
      url.pathname = path.endsWith(CHAT_PATH) ? path : path + CHAT_PATH;
      url.searchParams.set('api-version', version.slice(0, -CHAT_PATH.length));
      input = url.toString();
    }
    const { pathname } = url;
    const chat = pathname.endsWith(CHAT_PATH);
    const azureV1Chat = azure && pathname === '/openai/v1/chat/completions';
    const openai = hostname === 'api.openai.com' || azure;
    const anthropic = hostname === ANTHROPIC_HOST;
    if (!(openai && (chat || pathname.endsWith('/responses'))) && !(anthropic && chat)) {
      return fetcher(input, init);
    }

    const body = JSON.parse(init.body);
    const azureLegacyChat = azureDeployment && chat;
    if (azureV1Chat || azureLegacyChat) {
      return fetchAzureChat(fetcher, input, init, body, azureLegacyChat);
    }
    if (openai) {
      if (!isModernOpenAIModel(body.model ?? '')) return fetcher(input, init);
      if (chat && 'max_tokens' in body) replaceTokenLimit(body, 'max_tokens');
      const effort = chat ? body.reasoning_effort : body.reasoning?.effort;
      const allowsSampling = effort === 'none' || (effort == null && /^gpt-5\.[1-4](?:-|$)/i.test(body.model));
      if (!allowsSampling) {
        delete body.temperature;
        delete body.top_p;
        delete body.logprobs;
        delete body.top_logprobs;
      }
      delete body.seed;
    } else {
      if (isClaudeFixedSamplingModel(body.model ?? '')) {
        delete body.temperature;
        delete body.top_p;
      } else if (body.temperature != null) {
        delete body.top_p;
      }
    }
    return fetcher(input, { ...init, body: JSON.stringify(body) });
  };
}
