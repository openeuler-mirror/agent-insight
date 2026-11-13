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

import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAI } from 'openai';
import { probeModelConnection, classifyModelTestError } from '../src/lib/server/model-connection-test';
import { isModelConnectionReady, supportsCustomHeaders, type ModelConnectionConfig } from '../src/lib/shared/model-connection';
import { POST } from '../src/app/api/eval/settings/test/route';
import { db } from '../src/lib/storage/prisma';
import { saveUserSettings, getStoredUserSettings } from '../src/lib/storage/server-config';
import { resetProxyConfigCache } from '../src/lib/ingest/proxy-config';
import { createModel } from '../src/lib/engine/skill-generation/shared/model';
import { extractRootCausesFromExpected } from '../src/lib/engine/evaluation/root-cause-extractor';
import { loadDefaultModelConfigs } from '../src/lib/shared/default-model-config';

const base = { provider: 'custom', baseUrl: 'https://gateway.test/team/v1', model: 'test-model', apiKey: '' };
const chatReply = { id: 'chat-test', object: 'chat.completion', created: 1, model: base.model, usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] };
const nativeReply = { id: 'msg-test', type: 'message', role: 'assistant', model: base.model,
  content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 2, output_tokens: 1 } };

function setEnv(t: test.TestContext, key: string, value: string) {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
}

function mockTransport(t: test.TestContext, response: unknown = nativeReply) {
  for (const key of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) setEnv(t, key, '');
  resetProxyConfigCache();
  t.after(resetProxyConfigCache);
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    if (requests.at(-1)?.body.stream) {
      const chunk = { ...chatReply, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] };
      return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json(response);
  });
  return requests;
}

test('空 API Key 不发送占位鉴权，即使进程中存在供应商环境凭据', async t => {
  setEnv(t, 'OPENAI_API_KEY', 'environment-key-must-not-leak');
  for (const headers of [undefined, { 'X-Company-Key': 'company-token' }]) {
    await probeModelConnection({ ...base, headers }, {
      timeoutMs: 1000, signal: new AbortController().signal,
      fetch: async (_url, init) => {
        const sent = new Headers(init?.headers);
        assert.equal(sent.get('authorization'), null);
        assert.equal(sent.get('x-api-key'), null);
        assert.equal(sent.get('x-company-key'), headers?.['X-Company-Key'] ?? null);
        return Response.json(chatReply);
      },
    });
  }
});

test('自定义 Authorization 按大小写无关规则覆盖标准 API Key 鉴权', async () => {
  await probeModelConnection({ ...base, apiKey: 'standard-key', headers: { aUtHoRiZaTiOn: 'company-auth' } }, {
    timeoutMs: 1000, signal: new AbortController().signal,
    fetch: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'company-auth');
      return Response.json(chatReply);
    },
  });
});

test('Anthropic 支持仅自定义头及无鉴权配置', () => {
  assert.equal(supportsCustomHeaders({ provider: 'anthropic' }), true);
  assert.equal(isModelConnectionReady({ ...base, provider: 'anthropic', headers: { 'X-Company-Key': 'token' } }), true);
  assert.equal(isModelConnectionReady({ ...base, provider: 'anthropic' }), true);
  assert.equal(isModelConnectionReady({ ...base, model: '' }), false);
});

test('Anthropic Messages 连接测试发送原生协议和配置的请求头', async t => {
  const requests = mockTransport(t);
  const response = await POST(new Request('http://localhost/api/eval/settings/test', {
    method: 'POST', body: JSON.stringify({ ...base, provider: 'anthropic', protocol: 'anthropic',
      headers: { Authorization: 'company-token', 'X-Tenant': 'tenant' } }),
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).success, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://gateway.test/team/v1/messages');
  assert.equal(requests[0].headers.get('authorization'), 'company-token');
  assert.equal(requests[0].headers.get('x-api-key'), null);
  assert.equal(requests[0].headers.get('anthropic-version'), '2023-06-01');
  assert.equal(requests[0].body.max_tokens, 128);
  assert.deepEqual(requests[0].body.messages, [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }] }]);
});

test('非法协议在连接测试与保存时均被拒绝且不访问模型或写库', async t => {
  const requests = mockTransport(t);
  const response = await POST(new Request('http://localhost/api/eval/settings/test', {
    method: 'POST', body: JSON.stringify({ ...base, protocol: 'unknown-protocol' }),
  }));
  assert.equal(response.status, 400);
  assert.equal(requests.length, 0);
  t.mock.method(db, 'findUserSettings', async () => null);
  const writes = t.mock.method(db, 'upsertUserSettings', async () => {});
  await assert.rejects(saveUserSettings('test-only', { activeConfigId: 'test', configs: [
    { ...base, id: 'test', name: 'Test', protocol: 'unknown-protocol' } as never,
  ] }));
  assert.equal(writes.mock.callCount(), 0);
});

test('Anthropic 协议和脱敏请求头可保存回读，旧配置不隐式补协议', async t => {
  let settingsJson = JSON.stringify({ activeConfigId: 'old', configs: [{ ...base, id: 'old', name: 'Old' }] });
  t.mock.method(db, 'findUserSettings', async () => ({ settingsJson }));
  t.mock.method(db, 'upsertUserSettings', async (_user: string, value: string) => { settingsJson = value; });
  const old = (await getStoredUserSettings('test-only')).configs.find(c => c.id === 'old')!;
  assert.equal((old as ModelConnectionConfig & { protocol?: string }).protocol, undefined);
  await saveUserSettings('test-only', { activeConfigId: 'native', configs: [old, {
    ...base, id: 'native', name: 'Native', provider: 'anthropic', protocol: 'anthropic',
    headers: { Authorization: 'company-token' },
  } as never] });
  const saved = JSON.parse(settingsJson).configs;
  assert.equal(saved[0].protocol, undefined);
  assert.equal(saved[1].protocol, 'anthropic');
  assert.equal(saved[1].headers.Authorization, 'company-token');
});

test('Anthropic 原生生成客户端透传请求头且不泄漏环境鉴权', async t => {
  setEnv(t, 'ANTHROPIC_API_KEY', 'environment-key-must-not-leak');
  setEnv(t, 'ANTHROPIC_AUTH_TOKEN', 'environment-token-must-not-leak');
  const requests = mockTransport(t);
  const model = createModel({ provider: 'anthropic', protocol: 'anthropic', modelId: base.model,
    baseUrl: base.baseUrl, apiKey: '', headers: { 'X-Company-Key': 'company-token' } });
  assert.equal((await model.invoke('OK', { signal: AbortSignal.timeout(2000) })).content, 'OK');
  assert.equal(requests[0].url, 'https://gateway.test/team/v1/messages');
  assert.equal(requests[0].headers.get('x-company-key'), 'company-token');
  assert.equal(requests[0].headers.get('authorization'), null);
  assert.equal(requests[0].headers.get('x-api-key'), null);
});

test('Anthropic 供应商显式选择 OpenAI Compatible 时生成走兼容协议', async t => {
  const requests = mockTransport(t, chatReply);
  const model = createModel({ provider: 'anthropic', protocol: 'openai-compatible', modelId: base.model,
    baseUrl: base.baseUrl, apiKey: '', headers: { Authorization: 'company-token' } });
  const stream = await model.stream('OK', { signal: AbortSignal.timeout(2000) });
  let text = '';
  for await (const chunk of stream) text += chunk.content;
  assert.equal(text, 'OK');
  assert.equal(requests[0].url, 'https://gateway.test/team/v1/chat/completions');
  assert.equal(requests[0].headers.get('authorization'), 'company-token');
});

test('原生协议业务调用保留 system、结构化输出和 token 用量', async t => {
  const requests = mockTransport(t, { ...nativeReply, content: [{ type: 'text', text: '{"ok":true}' }] });
  const { getModelClientConfig } = await import('../src/lib/server/model-client');
  const client = new OpenAI(getModelClientConfig({ ...base, protocol: 'anthropic', apiKey: 'native-key' }));
  const result = await client.chat.completions.create({ model: base.model, max_tokens: 256,
    response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true,
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } },
    messages: [{ role: 'system', content: 'Evaluate.' }, { role: 'user', content: 'Run.' }],
  });
  assert.equal(requests[0].url, 'https://gateway.test/team/v1/messages');
  assert.equal(requests[0].headers.get('x-api-key'), 'native-key');
  assert.equal(requests[0].headers.get('authorization'), null);
  assert.deepEqual(requests[0].body.system, [{ type: 'text', text: 'Evaluate.' }]);
  assert.deepEqual(requests[0].body.output_config, { format: { type: 'json_schema', schema: {
    type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false,
  } } });
  assert.equal(result.choices[0].message.content, '{"ok":true}');
  assert.equal(result.usage?.prompt_tokens, 2);
  assert.equal(result.usage?.completion_tokens, 1);
});

test('清空已保存的 API Key 不会在测试时恢复旧 Key', async t => {
  const requests = mockTransport(t, chatReply);
  t.mock.method(db, 'findUserSettings', async () => ({ settingsJson: JSON.stringify({ activeConfigId: 'saved',
    configs: [{ ...base, id: 'saved', name: 'Saved', apiKey: 'old-key' }] }) }));
  const response = await POST(new Request('http://localhost/api/eval/settings/test', {
    method: 'POST', body: JSON.stringify({ ...base, user: 'test-only', configId: 'saved', apiKey: '' }),
  }));
  assert.equal(response.status, 200);
  assert.equal(requests[0].headers.get('authorization'), null);
});

test('根因提取业务实际使用已注册的 Anthropic 协议与自定义鉴权', async t => {
  const requests = mockTransport(t, { ...nativeReply, content: [{ type: 'text', text: '{"root_causes":[]}' }] });
  t.mock.method(db, 'findUserSettings', async () => ({ settingsJson: JSON.stringify({ activeConfigId: 'native',
    configs: [{ ...base, id: 'native', name: 'Native', provider: 'anthropic', protocol: 'anthropic', headers: { 'X-Company-Key': 'token' } }] }) }));
  assert.deepEqual(await extractRootCausesFromExpected('Task', 'Expected', 'test-only'), []);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://gateway.test/team/v1/messages');
  assert.equal(requests[0].headers.get('x-company-key'), 'token');
  assert.equal(requests[0].headers.get('authorization'), null);
  assert.equal(requests[0].headers.get('x-api-key'), null);
});

test('环境默认模型允许空 API Key 并可明确选择协议', t => {
  for (const [key, value] of Object.entries({ NAME: 'Fixture', PROVIDER: 'anthropic', API_KEY: '',
    MODEL: 'test-model', BASE_URL: 'https://gateway.test/v1', PROTOCOL: 'anthropic', HEADERS: '{"X-Tenant":"fixture"}' })) setEnv(t, `DEFAULT_MODEL_1_${key}`, value);
  setEnv(t, 'DEFAULT_MODEL_2_NAME', '');
  const configs = loadDefaultModelConfigs();
  assert.equal(configs.length, 1);
  assert.equal(configs[0].apiKey, '');
  assert.deepEqual(configs[0].headers, { 'X-Tenant': 'fixture' });
  assert.equal((configs[0] as ModelConnectionConfig).protocol, 'anthropic');
});

test('原生端点的无效 JSON 或错误协议响应归类为响应格式错误', async () => {
  for (const payload of ['not-json', JSON.stringify(chatReply), JSON.stringify({ type: 'message', content: null })]) {
    await assert.rejects(probeModelConnection({ ...base, protocol: 'anthropic' }, {
      timeoutMs: 1000, signal: new AbortController().signal,
      fetch: async () => new Response(payload, { headers: { 'content-type': 'application/json' } }),
    }), error => classifyModelTestError(error).code === 'invalid_response');
  }
});

test('业务 SDK 不重试已完成推理的无效原生响应', async () => {
  const { getModelClientConfig } = await import('../src/lib/server/model-client');
  let calls = 0;
  const client = new OpenAI({ ...getModelClientConfig({ ...base, protocol: 'anthropic' }, async () => {
    calls++;
    return Response.json(chatReply);
  }), maxRetries: 2 });
  await assert.rejects(client.chat.completions.create({ model: base.model, messages: [{ role: 'user', content: 'OK' }] }),
    error => classifyModelTestError(error).code === 'invalid_response');
  assert.equal(calls, 1);
});

test('原生响应体读取失败保留取消与网络错误语义', async () => {
  const { getModelClientConfig } = await import('../src/lib/server/model-client');
  for (const kind of ['cancelled', 'network'] as const) {
    const controller = new AbortController();
    const client = new OpenAI({ ...getModelClientConfig({ ...base, protocol: 'anthropic' }, async (_url, init) => {
      return new Response(new ReadableStream({ start(stream) {
        if (kind === 'network') stream.error(new TypeError('Connection closed'));
        else {
          init?.signal?.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')), { once: true });
          setTimeout(() => controller.abort(), 10);
        }
      } }), { headers: { 'content-type': 'application/json' } });
    }), maxRetries: 0 });
    await assert.rejects(client.chat.completions.create({ model: base.model, messages: [{ role: 'user', content: 'OK' }] },
      { signal: controller.signal }), error => classifyModelTestError(error).code === kind);
  }
});
