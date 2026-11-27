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
const AZURE_RESPONSES_SAMPLING_FIELDS = ['temperature', 'top_p'];
const AZURE_CHAT_SAMPLING_FIELDS = [...AZURE_RESPONSES_SAMPLING_FIELDS, 'logprobs', 'top_logprobs', 'seed'];
const MAX_AZURE_COMPAT_RETRIES = 2;

type AzureEndpoint = 'v1-chat' | 'legacy-chat' | 'responses';

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

async function fetchAzure(
  fetcher: typeof fetch,
  input: string | URL,
  init: RequestInit,
  body: Record<string, unknown>,
  endpoint: AzureEndpoint,
): Promise<Response> {
  if (endpoint === 'v1-chat' && Object.hasOwn(body, 'max_tokens')) {
    replaceTokenLimit(body, 'max_tokens');
    init = { ...init, body: JSON.stringify(body) };
  }

  const samplingFields = endpoint === 'responses' ? AZURE_RESPONSES_SAMPLING_FIELDS : AZURE_CHAT_SAMPLING_FIELDS;
  let retriedTokenLimit = false;
  let response = await fetcher(input, init);
  for (let retries = 0; retries < MAX_AZURE_COMPAT_RETRIES && response.status === 400 && !init.signal?.aborted; retries++) {
    let payload;
    try {
      payload = await response.clone().json();
    } catch {
      return response;
    }
    const error = payload?.error ?? payload;
    let { param, code } = error ?? {};
    if ((code == null || param == null) && typeof error?.message === 'string') {
      const [, reason, , field] = /^(Unsupported parameter|Unsupported value|Unrecognized request argument supplied):\s+(['"]?)([a-z_]+)\2(?=[.,:]?(?:\s|$))/.exec(error.message) ?? [];
      if (field && (param == null || param === field)) {
        param ??= field;
        code ??= reason === 'Unsupported value' ? 'unsupported_value' : 'unsupported_parameter';
      }
    }
    if ((code !== 'unsupported_parameter' && code !== 'unsupported_value') || typeof param !== 'string'
      || !Object.hasOwn(body, param) || init.signal?.aborted) return response;

    if (samplingFields.includes(param)) {
      for (const field of samplingFields) delete body[field];
    } else if (endpoint !== 'responses' && !retriedTokenLimit && code === 'unsupported_parameter'
      && (param === 'max_tokens' || param === 'max_completion_tokens')) {
      replaceTokenLimit(body, param);
      retriedTokenLimit = true;
    } else {
      return response;
    }

    console.warn('[ModelFetch] Retrying Azure request with compatible parameters', { endpoint, parameter: param, retry: retries + 1 });
    void response.body?.cancel().catch(() => {});
    response = await fetcher(input, { ...init, body: JSON.stringify(body) });
  }
  return response;
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
    if (azure) {
      const path = pathname.replace(/\/$/, '');
      let endpoint: AzureEndpoint;
      if (path === '/openai/v1/chat/completions') endpoint = 'v1-chat';
      else if (path === '/openai/v1/responses') endpoint = 'responses';
      else if (azureDeployment && path.endsWith(CHAT_PATH)) endpoint = 'legacy-chat';
      else return fetcher(input, init);
      return fetchAzure(fetcher, input, init, JSON.parse(init.body), endpoint);
    }
    const openai = hostname === 'api.openai.com';
    const anthropic = hostname === ANTHROPIC_HOST;
    if (!(openai && (chat || pathname.endsWith('/responses'))) && !(anthropic && chat)) {
      return fetcher(input, init);
    }

    const body = JSON.parse(init.body);
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
