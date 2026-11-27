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

import {
  getModelAuthHeaders,
  getOpenAICompatibleClientConfig,
  resolveModelProtocol,
  type ModelConnectionConfig,
} from '@/lib/shared/model-connection';
import { ModelTestValidationError } from '@/lib/shared/model-connection-test';
import { getModelFetch, isClaudeFixedSamplingModel } from './model-fetch';

type JsonObject = Record<string, unknown>;

function objects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter((item): item is JsonObject => Boolean(item) && typeof item === 'object') : [];
}

function contentBlocks(content: unknown): JsonObject[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return objects(content).map(part => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image_url') {
      const url = (part.image_url as JsonObject)?.url;
      if (typeof url === 'string') {
        const data = /^data:([^;]+);base64,(.+)$/s.exec(url);
        return { type: 'image', source: data
          ? { type: 'base64', media_type: data[1], data: data[2] }
          : { type: 'url', url } };
      }
    }
    throw new ModelTestValidationError('Unsupported message content for Anthropic');
  });
}

function toAnthropicRequest(body: JsonObject): JsonObject {
  const system: JsonObject[] = [];
  const messages: JsonObject[] = [];
  for (const message of objects(body.messages)) {
    if (message.role === 'system' || message.role === 'developer') {
      system.push(...contentBlocks(message.content));
      continue;
    }
    const content = message.role === 'tool'
      ? [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }]
      : contentBlocks(message.content);
    for (const call of objects(message.tool_calls)) {
      const fn = call.function as JsonObject;
      content.push({ type: 'tool_use', id: call.id, name: fn.name, input: JSON.parse(String(fn.arguments || '{}')) });
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const previous = messages.at(-1);
    if (previous?.role === role) (previous.content as JsonObject[]).push(...content);
    else messages.push({ role, content });
  }
  const format = body.response_format as JsonObject | undefined;
  if (format?.type === 'json_object') system.push({ type: 'text', text: 'Return a valid JSON object only.' });
  const request: JsonObject = {
    model: body.model,
    max_tokens: body.max_completion_tokens ?? body.max_tokens ?? 4096,
    messages,
    ...(system.length ? { system } : {}),
  };
  if (!isClaudeFixedSamplingModel(String(body.model))) {
    if (body.temperature != null) request.temperature = body.temperature;
    else if (body.top_p != null) request.top_p = body.top_p;
  }
  if (body.stop) request.stop_sequences = typeof body.stop === 'string' ? [body.stop] : body.stop;
  if (format?.type === 'json_schema') {
    request.output_config = { format: { type: 'json_schema', schema: (format.json_schema as JsonObject)?.schema } };
  }
  const tools = objects(body.tools);
  if (tools.length) {
    request.tools = tools.map(tool => {
      const fn = tool.function as JsonObject;
      return { name: fn.name, description: fn.description, input_schema: fn.parameters ?? { type: 'object', properties: {} } };
    });
    const choice = body.tool_choice;
    if (choice === 'none') delete request.tools;
    else if (choice === 'auto' || choice === 'required') request.tool_choice = { type: choice === 'auto' ? 'auto' : 'any' };
    else if (choice && typeof choice === 'object') request.tool_choice = { type: 'tool', name: ((choice as JsonObject).function as JsonObject)?.name };
  }
  return request;
}

async function fromAnthropicResponse(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const invalid = () => Response.json({ error: { message: 'Invalid model response', type: 'agent_insight_invalid_response' } },
    { status: 502, headers: { 'x-should-retry': 'false' } });
  let message: JsonObject;
  try { message = await response.json() as JsonObject; }
  catch (error) {
    if (error instanceof SyntaxError) return invalid();
    throw error;
  }
  if (!message || message.type !== 'message' || !Array.isArray(message.content)) return invalid();
  const content = objects(message.content);
  const toolCalls = content.filter(block => block.type === 'tool_use').map(block => ({
    id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) },
  }));
  const usage = message.usage as JsonObject | undefined;
  const input = Number(usage?.input_tokens ?? 0) + Number(usage?.cache_read_input_tokens ?? 0) + Number(usage?.cache_creation_input_tokens ?? 0);
  const output = Number(usage?.output_tokens ?? 0);
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json');
  return Response.json({
    id: message.id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: message.model,
    choices: [{ index: 0, message: { role: 'assistant', content: content.filter(block => block.type === 'text').map(block => block.text).join(''),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
    finish_reason: message.stop_reason === 'tool_use' ? 'tool_calls' : message.stop_reason === 'max_tokens' ? 'length' : 'stop' }],
    usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output,
      prompt_tokens_details: { cached_tokens: Number(usage?.cache_read_input_tokens ?? 0) } },
  }, { status: response.status, headers });
}

export function getModelClientFetch(config: ModelConnectionConfig, fetcher?: typeof fetch): typeof fetch {
  const transport = getModelFetch(fetcher);
  const protocol = resolveModelProtocol(config);
  const configuredHeaders = getModelAuthHeaders(config);
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const headers = new Headers(init?.headers ?? request?.headers);
    for (const name of ['authorization', 'x-api-key', 'api-key']) headers.delete(name);
    for (const [name, value] of Object.entries(configuredHeaders)) headers.set(name, value);
    const options = { ...init, ...(request ? { method: init?.method ?? request.method } : {}), headers };
    const url = new URL(request?.url ?? String(input));
    if (protocol !== 'anthropic' || !url.pathname.endsWith('/chat/completions')) return transport(input, options);
    const body = JSON.parse(typeof options.body === 'string' ? options.body : await request!.text()) as JsonObject;
    // Agent streams use the native Anthropic client; this adapter serves existing single-response evaluators.
    if (body.stream) throw new ModelTestValidationError('Use the native Anthropic client for streaming');
    url.pathname = url.pathname.replace(/\/chat\/completions$/, '/messages');
    if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
    return fromAnthropicResponse(await transport(url.toString(), { ...options, body: JSON.stringify(toAnthropicRequest(body)) }));
  };
}

export function getModelClientConfig(config: ModelConnectionConfig, fetcher?: typeof fetch) {
  const options = getOpenAICompatibleClientConfig(config);
  if (resolveModelProtocol(config) === 'anthropic' && options.baseURL && !options.baseURL.endsWith('/v1')) options.baseURL += '/v1';
  return { ...options, adminAPIKey: null, organization: null, project: null, fetch: getModelClientFetch(config, fetcher) };
}
