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
import { GET as readSettings, POST as saveSettings } from '../src/app/api/eval/settings/route';
import { POST as testConnection } from '../src/app/api/eval/settings/test/route';
import { db } from '../src/lib/storage/prisma';
import { resetProxyConfigCache } from '../src/lib/ingest/proxy-config';
import type { ModelConfig } from '../src/lib/storage/server-config';

const USER = 'test-only';

const inlineAnthropic: ModelConfig = {
  id: 'anthropic-inline',
  name: 'Inline Anthropic',
  provider: 'anthropic',
  protocol: 'anthropic',
  baseUrl: 'https://llm.intra.test/team/v1',
  model: 'claude-sonnet-4-5',
  apiKey: '',
  headers: { Authorization: 'Bearer intra-token', 'X-Tenant-ID': 'team-a' },
};

const nativeReply = {
  id: 'msg-test', type: 'message', role: 'assistant', model: inlineAnthropic.model,
  content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 2, output_tokens: 1 },
};

function mockDb(t: test.TestContext) {
  let settingsJson = JSON.stringify({ activeConfigId: null, configs: [] });
  t.mock.method(db, 'findUserSettings', async () => ({ settingsJson }));
  t.mock.method(db, 'upsertUserSettings', async (_user: string, value: string) => { settingsJson = value; });
  return () => (JSON.parse(settingsJson) as { activeConfigId: string | null; configs: ModelConfig[] });
}

function mockTransport(t: test.TestContext) {
  for (const key of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) {
    const previous = process.env[key];
    process.env[key] = '';
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  resetProxyConfigCache();
  t.after(resetProxyConfigCache);
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return Response.json(nativeReply);
  });
  return requests;
}

function settingsRequest(settings: unknown) {
  return new Request('http://localhost/api/eval/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: USER, settings }),
  });
}

test('行内 Anthropic 模型：保存 → 掩码回读 → 连接测试全程保留自定义请求头', async t => {
  const readStored = mockDb(t);
  const requests = mockTransport(t);

  const saveResponse = await saveSettings(settingsRequest({ activeConfigId: inlineAnthropic.id, configs: [inlineAnthropic] }));
  assert.equal(saveResponse.status, 200);
  const stored = readStored().configs[0];
  assert.equal(stored.protocol, 'anthropic');
  assert.deepEqual(stored.headers, inlineAnthropic.headers);

  // 浏览器只拿到掩码后的配置，后续健康检查/保存都会把掩码值原样回传。
  const masked = (await saveResponse.json()).configs[0] as ModelConfig;
  assert.match(masked.headers?.Authorization ?? '', /•/);
  assert.notEqual(masked.headers?.Authorization, inlineAnthropic.headers?.Authorization);

  const testResponse = await testConnection(new Request('http://localhost/api/eval/settings/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: masked.provider, protocol: masked.protocol, apiKey: masked.apiKey,
      baseUrl: masked.baseUrl, model: masked.model, headers: masked.headers,
      user: USER, configId: masked.id,
    }),
  }));
  assert.equal(testResponse.status, 200);
  assert.equal((await testResponse.json()).success, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://llm.intra.test/team/v1/messages');
  assert.equal(requests[0].headers.get('authorization'), 'Bearer intra-token');
  assert.equal(requests[0].headers.get('x-tenant-id'), 'team-a');
  assert.equal(requests[0].headers.get('x-api-key'), null);
  assert.equal(requests[0].body.model, inlineAnthropic.model);
});

test('行内 Anthropic 模型：Custom 供应商显式选 Anthropic 协议同样可用自定义请求头', async t => {
  const readStored = mockDb(t);
  const requests = mockTransport(t);
  const customAnthropic: ModelConfig = { ...inlineAnthropic, id: 'custom-anthropic', provider: 'custom', name: 'Custom Anthropic' };

  const saveResponse = await saveSettings(settingsRequest({ activeConfigId: customAnthropic.id, configs: [customAnthropic] }));
  assert.equal(saveResponse.status, 200);
  assert.deepEqual(readStored().configs[0].headers, customAnthropic.headers);

  const masked = (await saveResponse.json()).configs[0] as ModelConfig;
  const testResponse = await testConnection(new Request('http://localhost/api/eval/settings/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: masked.provider, protocol: masked.protocol, apiKey: masked.apiKey,
      baseUrl: masked.baseUrl, model: masked.model, headers: masked.headers,
      user: USER, configId: masked.id,
    }),
  }));
  assert.equal(testResponse.status, 200);
  assert.equal((await testResponse.json()).success, true);
  assert.equal(requests[0].url, 'https://llm.intra.test/team/v1/messages');
  assert.equal(requests[0].headers.get('authorization'), 'Bearer intra-token');
  assert.equal(requests[0].headers.get('x-tenant-id'), 'team-a');
});

test('行内 Anthropic 模型：编辑页原样回存掩码设置不会把真实请求头写成掩码', async t => {
  const readStored = mockDb(t);
  mockTransport(t);
  await saveSettings(settingsRequest({ activeConfigId: inlineAnthropic.id, configs: [inlineAnthropic] }));

  const maskedSettings = await (await readSettings(new Request(`http://localhost/api/eval/settings?user=${USER}`))).json();
  const resaveResponse = await saveSettings(settingsRequest({
    activeConfigId: maskedSettings.activeConfigId, configs: maskedSettings.configs,
  }));
  assert.equal(resaveResponse.status, 200);

  const stored = readStored().configs.find(item => item.id === inlineAnthropic.id)!;
  assert.deepEqual(stored.headers, inlineAnthropic.headers);
  assert.equal(stored.protocol, 'anthropic');
  assert.equal(stored.baseUrl, inlineAnthropic.baseUrl);
});
