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

import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAI } from 'openai';
import { MockAgent, ProxyAgent } from 'undici';
import { probeModelConnection, classifyModelTestError } from '../src/lib/server/model-connection-test';
import { resolveModelTestTimeoutMs, formatModelTestResult } from '../src/lib/shared/model-connection-test';
import { GET as getSettings } from '../src/app/api/eval/settings/route';
import { POST } from '../src/app/api/eval/settings/test/route';
import { db } from '../src/lib/storage/prisma';
import { getActiveConfig, saveUserSettings, getUserSettings } from '../src/lib/storage/server-config';
import { getModelFetch } from '../src/lib/server/model-fetch';
import { getProvider, resolveCatalogProvider } from '../src/lib/llm-providers';
import { createModel } from '../src/lib/engine/skill-generation/shared/model';
import { resetProxyConfigCache } from '../src/lib/ingest/proxy-config';

const config = { provider: 'custom', baseUrl: 'https://model.test/v1', model: 'test-model' };
const completion = { choices: [{ message: { role: 'assistant', content: 'ok' } }] };

test('旧配置默认 60 秒，测试超时严格校验数值及上下界', () => {
  assert.equal(resolveModelTestTimeoutMs(undefined), 60_000);
  for (const value of [10_000, 90_000, 300_000]) assert.equal(resolveModelTestTimeoutMs(value), value);
  for (const value of [null, '60000', 0, 9999, 300001, Infinity, NaN, 10000.5]) {
    assert.throws(() => resolveModelTestTimeoutMs(value));
  }
});

test('测试 API 在调用模型前拒绝非法超时', async () => {
  const response = await POST(new Request('http://localhost/api/eval/settings/test', {
    method: 'POST', body: JSON.stringify({ ...config, testTimeoutMs: '90000' }),
  }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'invalid_request');
});

test('模型超时随设置保存并回读，非法值不会落库', async t => {
  let settingsJson: string | undefined;
  t.mock.method(db, 'findUserSettings', async () => settingsJson ? { settingsJson } : null);
  const write = t.mock.method(db, 'upsertUserSettings', async (_user: string, json: string) => { settingsJson = json; });
  const settings = { activeConfigId: 'timeout-test', configs: [{ ...config, id: 'timeout-test', name: 'Test', apiKey: '', testTimeoutMs: 90000 }] };
  await saveUserSettings('test-only', settings);
  assert.equal((await getUserSettings('test-only')).configs.find(c => c.id === 'timeout-test')?.testTimeoutMs, 90000);
  await assert.rejects(saveUserSettings('test-only', { ...settings, configs: [{ ...settings.configs[0], testTimeoutMs: 300001 }] }));
  assert.equal(write.mock.callCount(), 1);
});

test('切换默认模型不会把目录默认值写入设置', async t => {
  const config = { id: 'implicit', name: 'Test', provider: 'xai', apiKey: 'test-only' };
  let settingsJson = JSON.stringify({ activeConfigId: null, configs: [config] });
  t.mock.method(db, 'findUserSettings', async () => ({ settingsJson }));
  t.mock.method(db, 'upsertUserSettings', async (_user: string, json: string) => { settingsJson = json; });

  const response = await getSettings(new Request('http://localhost/api/eval/settings?user=test-only'));
  await saveUserSettings('test-only', { ...await response.json(), activeConfigId: config.id });
  const [saved] = JSON.parse(settingsJson).configs;
  assert.equal(saved.baseUrl, undefined);
  assert.equal(saved.model, undefined);

  const active = await getActiveConfig('test-only');
  assert.equal(active?.baseUrl, 'https://api.x.ai/v1');
  assert.equal(active?.model, 'grok-4.7');
});

test('成功请求发送最小推理内容且不自动重试', async () => {
  let calls = 0;
  await probeModelConnection(config, {
    timeoutMs: 1000, signal: new AbortController().signal,
    fetch: async (_url, init) => {
      calls++;
      const body = JSON.parse(init?.body as string);
      assert.equal(body.max_tokens, 128);
      assert.equal(body.model, 'test-model');
      return Response.json(completion);
    },
  });
  assert.equal(calls, 1);
});

test('超时会取消底层传输，且只请求一次', async () => {
  let calls = 0;
  let aborted = false;
  const probe = probeModelConnection(config, {
    timeoutMs: 30, signal: new AbortController().signal,
    fetch: async (_url, init) => {
      calls++;
      return new Promise<Response>((_, reject) => {
        init!.signal!.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    },
  });
  await assert.rejects(probe, { name: 'TimeoutError' });
  assert.equal(aborted, true);
  assert.equal(calls, 1);
});

test('新旧 xAI 配置均走 Grok 的 Chat Completions 端点', async () => {
  const legacyConfig = { provider: 'custom', baseUrl: ' https://api.x.ai/v1/chat/completions/ ', model: 'grok-4.7' };
  assert.equal(resolveCatalogProvider('custom', legacyConfig.baseUrl.trim())?.id, 'xai');
  for (const connection of [{ provider: 'xai' }, legacyConfig, { ...legacyConfig, baseUrl: 'https://api.x.ai/v1/responses' }]) {
    await probeModelConnection({ ...connection, apiKey: 'fake-key' }, {
      timeoutMs: 1000,
      signal: new AbortController().signal,
      fetch: async (url, init) => {
        assert.equal(String(url), 'https://api.x.ai/v1/chat/completions');
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fake-key');
        const body = JSON.parse(init?.body as string);
        assert.equal(body.model, 'grok-4.7');
        assert.equal(body.max_tokens, 128);
        return Response.json(completion);
      },
    });
  }
});

test('缺少可用模型名或自定义端点时不会发送请求', async t => {
  const fetch = t.mock.fn(async () => Response.json(completion));
  for (const connection of [
    { provider: 'custom', model: 'test-model' },
    { provider: 'custom', baseUrl: config.baseUrl },
    { provider: 'legacy-gateway', baseUrl: config.baseUrl },
    { provider: 'legacy-gateway', baseUrl: config.baseUrl, model: '  ' },
  ]) {
    await assert.rejects(probeModelConnection(connection, {
      timeoutMs: 1000,
      signal: new AbortController().signal,
      fetch,
    }), error => classifyModelTestError(error).code === 'invalid_request');
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('OpenAI 推理模型探测使用 max_completion_tokens', async () => {
  await probeModelConnection({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-astra' }, {
    timeoutMs: 1000,
    signal: new AbortController().signal,
    fetch: async (url, init) => {
      assert.equal(String(url), 'https://api.openai.com/v1/chat/completions');
      const body = JSON.parse(init?.body as string);
      assert.equal(body.model, 'gpt-6-astra');
      assert.equal(body.max_completion_tokens, 128);
      assert.equal('max_tokens' in body, false);
      return Response.json(completion);
    },
  });
});

test('Azure OpenAI 要求填写部署名并将它发给对应资源', async t => {
  const preset = getProvider('azure-openai');
  assert.equal(preset?.defaultModel, '');
  assert.deepEqual(preset?.suggestedModels, []);

  const connection = { provider: 'azure-openai', baseUrl: 'https://example.openai.azure.com/openai' };
  const fetch = t.mock.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(url), 'https://example.openai.azure.com/openai/v1/chat/completions');
    const body = JSON.parse(init?.body as string);
    assert.equal(body.model, 'evaluation-deployment');
    assert.equal(body.max_completion_tokens, 128);
    assert.equal('max_tokens' in body, false);
    return Response.json(completion);
  });
  const options = { timeoutMs: 1000, signal: new AbortController().signal, fetch };
  await assert.rejects(probeModelConnection(connection, options),
    error => classifyModelTestError(error).code === 'invalid_request');
  assert.equal(fetch.mock.callCount(), 0);

  await probeModelConnection({ ...connection, model: ' evaluation-deployment ' }, options);
  assert.equal(fetch.mock.callCount(), 1);
});

test('Azure v1 按部署返回的错误调整 token 上限或采样', async () => {
  const url = 'https://example.openai.azure.com/openai/v1/chat/completions';
  const base = { model: 'evaluation-deployment', response_format: { type: 'json_object' } };
  const sampling = { temperature: 0, top_p: 1, seed: 42 };
  const init = { method: 'POST', body: JSON.stringify({ ...base, ...sampling, max_tokens: 512 }) };
  const expected = { ...base, max_completion_tokens: 512 };
  for (const [error, retryBody] of [
    [undefined, undefined],
    [{ param: 'temperature', code: 'unsupported_value' }, expected],
    [{ param: 'top_p', code: null, message: "Unsupported parameter: 'top_p' is not supported with this model." }, expected],
    [{ param: null, code: null, message: 'Unrecognized request argument supplied: max_completion_tokens' },
      { ...base, ...sampling, max_tokens: 512 }],
    [{ param: 'response_format', code: 'unsupported_parameter' }, undefined],
  ] as const) {
    const bodies: unknown[] = [];
    const fetch = getModelFetch(async (_url, request) => {
      bodies.push(JSON.parse(request?.body as string));
      return error && bodies.length === 1 ? Response.json({ error }, { status: 400 }) : Response.json(completion);
    });
    const response = await fetch(url, init);
    assert.deepEqual(bodies, retryBody ? [{ ...expected, ...sampling }, retryBody] : [{ ...expected, ...sampling }]);
    assert.equal(response.status, error && !retryBody ? 400 : 200);
    assert.deepEqual(await response.json(), error && !retryBody ? { error } : completion);
  }
});

test('Azure 旧版连接测试保留部署路径和 API 版本，按部署兼容 token 上限', async () => {
  for (const [model, apiVersion, reasoning] of [
    ['gpt-5-legacy-alias', '2024-06-01', false],
    ['evaluation-deployment', '2025-04-01-preview', true],
  ] as const) {
    const deployment = `https://example.openai.azure.com/openai/deployments/${model}`;
    const endpoint = `${deployment}/chat/completions?api-version=${apiVersion}`;
    const tokenLimits: unknown[][] = [];
    await probeModelConnection({
      provider: 'custom', model, baseUrl: reasoning ? endpoint : `${deployment}?api-version=${apiVersion}`,
      headers: { 'api-key': 'test-only' },
    }, {
      timeoutMs: 1000, signal: new AbortController().signal,
      fetch: async (url, init) => {
        assert.equal(String(url), endpoint);
        assert.equal(new Headers(init?.headers).get('api-key'), 'test-only');
        const body = JSON.parse(init?.body as string);
        assert.equal(body.model, model);
        tokenLimits.push([body.max_tokens, body.max_completion_tokens]);
        if (reasoning && 'max_tokens' in body) {
          return Response.json({ error: { param: 'max_tokens', code: 'unsupported_parameter' } }, { status: 400 });
        }
        return Response.json(completion);
      },
    });
    assert.deepEqual(tokenLimits, reasoning ? [[128, undefined], [undefined, 128]] : [[128, undefined]]);
  }
});

test('Azure 旧版评测可分别处理采样和 token 上限拒绝，保留结构化输出', async () => {
  const url = 'https://example.openai.azure.com/openai/deployments/eval/chat/completions?api-version=2025-04-01-preview';
  const base = { model: 'eval', response_format: { type: 'json_object' } };
  const sampling = { temperature: 0, top_p: 1, seed: 42 };
  const bodies: unknown[] = [];
  const fetch = getModelFetch(async (target, init) => {
    assert.equal(String(target), url);
    const body = JSON.parse(init?.body as string);
    bodies.push(body);
    if ('temperature' in body) {
      return Response.json({ error: { param: 'temperature', code: 'unsupported_value' } }, { status: 400 });
    }
    if ('max_tokens' in body) {
      return Response.json({ error: {
        message: "Unsupported parameter: 'max_tokens' is not supported with this model.",
      } }, { status: 400 });
    }
    return Response.json(completion);
  });
  const response = await fetch(url, { method: 'POST', body: JSON.stringify({ ...base, ...sampling, max_tokens: 512 }) });
  assert.deepEqual(await response.json(), completion);
  assert.deepEqual(bodies, [
    { ...base, ...sampling, max_tokens: 512 },
    { ...base, max_tokens: 512 },
    { ...base, max_completion_tokens: 512 },
  ]);
});

test('技能生成的 Anthropic 客户端使用代理和原生 Messages 路径', async t => {
  const originalEnv = process.env;
  process.env = { ...originalEnv, https_proxy: 'http://proxy.test:3128', no_proxy: 'proxy.test' };
  resetProxyConfigCache();
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  t.after(async () => {
    process.env = originalEnv;
    resetProxyConfigCache();
    await mockAgent.close();
  });

  const modelId = 'claude-sonnet-5-5';
  const reply = {
    id: 'msg-test', type: 'message', role: 'assistant', model: modelId,
    content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  mockAgent.get(/.*/).intercept({ path: /.*/, method: 'POST' })
    .reply(200, reply, { headers: { 'content-type': 'application/json' } }).persist();
  const dispatch = t.mock.method(ProxyAgent.prototype, 'dispatch', mockAgent.dispatch.bind(mockAgent));
  t.mock.method(globalThis, 'fetch', async () => Response.json(reply));

  for (const baseUrl of ['https://api.anthropic.com/v1', ' https://gateway.test/team/v1/messages/ ']) {
    const model = createModel({ provider: 'anthropic', modelId, apiKey: 'test-only', baseUrl });
    assert.equal((await model.invoke('Reply with OK.')).content, 'OK');
  }
  assert.deepEqual(dispatch.mock.calls.map(({ arguments: [request] }) => `${request.origin}${request.path}`), [
    'https://api.anthropic.com/v1/messages',
    'https://gateway.test/team/v1/messages',
  ]);
});

test('共享传输按官方端点转换参数，自定义端点保留原始请求', async () => {
  const sampling = { temperature: 0, top_p: 1, seed: 42 };
  const format = { response_format: {
    type: 'json_schema',
    json_schema: {
      name: 'evaluation',
      strict: true,
      schema: {
        type: 'object', properties: { passed: { type: 'boolean' } }, required: ['passed'], additionalProperties: false,
      },
    },
  } };
  const gatewayFormat = { response_format: { type: 'json_object' } };
  const cases = [
    ['https://api.openai.com/v1/chat/completions',
      { model: 'gpt-6-astra', max_tokens: 1000, ...sampling },
      { model: 'gpt-6-astra', max_completion_tokens: 1000 }],
    ['https://api.openai.com/v1/responses',
      { model: 'gpt-6-luna', ...sampling },
      { model: 'gpt-6-luna' }],
    ...['claude-sonnet-5-5', 'claude-opus-4-7'].map(model => [
      'https://api.anthropic.com/v1/chat/completions',
      { model, ...sampling, ...format },
      { model, seed: 42, ...format },
    ] as const),
    ...[
      'claude-3-5-sonnet-20241022',
      'claude-3-5-sonnet-20240620',
      'claude-3-7-sonnet-20250219',
      'claude-sonnet-4-20250514',
      'claude-opus-4-20250514',
    ].map(model => [
      'https://api.anthropic.com/v1/chat/completions',
      { model, ...sampling, ...format },
      { model, temperature: 0, seed: 42, ...format },
    ] as const),
    ['https://api.anthropic.com/v1/chat/completions',
      { model: 'claude-sonnet-4-20250514', top_p: 0.8 },
      { model: 'claude-sonnet-4-20250514', top_p: 0.8 }],
    ['https://model.test/v1/chat/completions',
      { model: 'gpt-6-astra', ...sampling, ...gatewayFormat },
      { model: 'gpt-6-astra', ...sampling, ...gatewayFormat }],
  ] as const;
  for (const [url, request, expected] of cases) {
    const fetcher = getModelFetch(async (_url, init) => {
      assert.deepEqual(JSON.parse(init?.body as string), expected);
      return Response.json(completion);
    });
    await fetcher(url, { method: 'POST', body: JSON.stringify(request) });
  }
});

test('响应头已经返回但响应体未结束时仍受总截止时间约束', async () => {
  let aborted = false;
  await assert.rejects(probeModelConnection(config, {
    timeoutMs: 30, signal: new AbortController().signal,
    fetch: async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"choices":'));
        init!.signal!.addEventListener('abort', () => {
          aborted = true;
          controller.error(new DOMException('Aborted', 'AbortError'));
        });
      },
    }), { headers: { 'Content-Type': 'application/json' } }),
  }), { name: 'TimeoutError' });
  assert.equal(aborted, true);
});

test('用户取消会终止底层请求，后续测试可独立成功', async () => {
  const controller = new AbortController();
  let aborted = false;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const probe = probeModelConnection(config, {
    timeoutMs: 1000, signal: controller.signal,
    fetch: async (_url, init) => new Promise<Response>((_, reject) => {
      init!.signal!.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('Aborted', 'AbortError'));
      });
      started();
    }),
  });
  await ready;
  controller.abort();
  await assert.rejects(probe, { name: 'AbortError' });
  assert.equal(aborted, true);
  await probeModelConnection(config, {
    timeoutMs: 1000, signal: new AbortController().signal, fetch: async () => Response.json(completion),
  });
});

test('已取消的请求不会访问模型', async () => {
  await assert.rejects(probeModelConnection(config, {
    timeoutMs: 1000, signal: AbortSignal.abort(),
    fetch: async () => { assert.fail('Must not send a request'); },
  }), { name: 'AbortError' });
});

test('鉴权、限流和服务端错误分类且不重试、不透传服务端敏感消息', async () => {
  for (const [status, code] of [[401, 'authentication'], [403, 'authentication'], [429, 'rate_limit'], [400, 'invalid_request'], [404, 'invalid_request'], [503, 'server']] as const) {
    let calls = 0;
    try {
      await probeModelConnection(config, {
        timeoutMs: 1000, signal: new AbortController().signal,
        fetch: async () => {
          calls++;
          return Response.json({ error: { message: 'secret-token-and-private-url' } }, { status });
        },
      });
      assert.fail('Expected a provider error');
    } catch (error) {
      const classified = classifyModelTestError(error);
      assert.equal(classified.code, code);
      assert.doesNotMatch(classified.error, /secret/);
      assert.equal(calls, 1);
    }
  }
  assert.equal(classifyModelTestError(new OpenAI.APIConnectionError({})).code, 'network');
  assert.equal(classifyModelTestError(new OpenAI.APIConnectionTimeoutError()).code, 'timeout');
  assert.equal(classifyModelTestError(new OpenAI.APIUserAbortError()).code, 'cancelled');
});

test('无有效 choices 不应标记连接成功', async () => {
  await assert.rejects(probeModelConnection(config, {
    timeoutMs: 1000, signal: new AbortController().signal, fetch: async () => Response.json({ choices: [] }),
  }), error => classifyModelTestError(error).code === 'invalid_response');
});

test('非 JSON 响应归类为无效模型响应', async () => {
  await assert.rejects(probeModelConnection(config, {
    timeoutMs: 1000, signal: new AbortController().signal,
    fetch: async () => new Response('invalid JSON', { headers: { 'Content-Type': 'application/json' } }),
  }), error => classifyModelTestError(error).code === 'invalid_response');
});

test('超时和成功结果展示实际耗时、配置预算及操作建议', () => {
  assert.match(formatModelTestResult({ success: false, code: 'timeout', elapsedMs: 60001, timeoutMs: 60000 }, 'zh'), /延长超时/);
  assert.match(formatModelTestResult({ success: true, elapsedMs: 15001, timeoutMs: 90000 }, 'zh'), /15.0 秒（上限 90 秒）/);
});
