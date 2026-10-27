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
import { probeModelConnection, classifyModelTestError } from '../src/lib/server/model-connection-test';
import { resolveModelTestTimeoutMs, formatModelTestResult } from '../src/lib/shared/model-connection-test';
import { POST } from '../src/app/api/eval/settings/test/route';
import { db } from '../src/lib/storage/prisma';
import { saveUserSettings, getUserSettings } from '../src/lib/storage/server-config';

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

test('成功请求发送最小推理内容且不自动重试', async () => {
  let calls = 0;
  await probeModelConnection(config, {
    timeoutMs: 1000, signal: new AbortController().signal,
    fetch: async (_url, init) => {
      calls++;
      const body = JSON.parse(init?.body as string);
      assert.equal(body.max_tokens, 5);
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
