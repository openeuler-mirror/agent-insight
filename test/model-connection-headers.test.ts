import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getOpenAICompatibleClientConfig,
  isModelConnectionReady,
  normalizeCustomHeaders,
  supportsCustomHeaders,
} from '../src/lib/shared/model-connection';
import {
  maskUserSettings,
  restoreMaskedHeaders,
} from '../src/lib/storage/server-config';
import { resetProxyConfigCache } from '../src/lib/ingest/proxy-config';
import { POST as testModelConnection } from '../src/app/api/eval/settings/test/route';

test('Custom OpenAI Compatible 支持 headers-only 和无鉴权连接', () => {
  const headersOnly = {
    provider: 'custom',
    apiKey: '',
    baseUrl: 'https://example.test/v1',
    model: 'qwen',
    headers: { Authorization: 'internal-token' },
  };
  const noAuth = {
    provider: 'custom',
    apiKey: '',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen',
  };

  assert.equal(supportsCustomHeaders(headersOnly), true);
  assert.equal(isModelConnectionReady(headersOnly), true);
  assert.equal(isModelConnectionReady(noAuth), true);
  assert.equal(isModelConnectionReady({ ...noAuth, model: '' }), false);
  assert.equal(isModelConnectionReady({ provider: 'openai', apiKey: '' }), false);
});

test('自定义请求头会校验名称、值和传输层保留字段', () => {
  assert.deepEqual(
    normalizeCustomHeaders({
      Authorization: 'Bearer token',
      'X-Tenant-ID': 'team-a',
    }),
    {
      Authorization: 'Bearer token',
      'X-Tenant-ID': 'team-a',
    },
  );
  assert.throws(
    () => normalizeCustomHeaders({ Host: 'example.test' }),
    /managed by the transport/,
  );
  assert.throws(
    () => normalizeCustomHeaders({ 'X-Test': 'bad\nvalue' }),
    /Invalid value/,
  );
});

test('OpenAI Compatible 客户端参数透传 headers 且允许空 API Key', () => {
  assert.deepEqual(
    getOpenAICompatibleClientConfig({
      provider: 'custom',
      apiKey: '',
      baseUrl: 'https://example.test/v1',
      headers: { Authorization: 'token' },
    }),
    {
      apiKey: 'no-api-key-required',
      baseURL: 'https://example.test/v1',
      defaultHeaders: { Authorization: 'token' },
    },
  );
});

test('模型设置返回浏览器前会掩码所有 Header 值', () => {
  const masked = maskUserSettings({
    activeConfigId: 'custom-1',
    configs: [{
      id: 'custom-1',
      name: 'Internal Qwen',
      provider: 'custom',
      apiKey: '',
      baseUrl: 'https://example.test/v1',
      model: 'qwen',
      headers: {
        Authorization: 'internal-secret-token',
        'X-Tenant-ID': 'team-a-secret',
      },
    }],
  });

  assert.equal(masked.configs[0].apiKey, '');
  assert.notEqual(masked.configs[0].headers?.Authorization, 'internal-secret-token');
  assert.match(masked.configs[0].headers?.Authorization ?? '', /•/);
  assert.match(masked.configs[0].headers?.['X-Tenant-ID'] ?? '', /•/);
});

test('编辑已保存配置时只恢复仍存在的掩码 Header', () => {
  assert.deepEqual(
    restoreMaskedHeaders(
      {
        authorization: '••••••••',
        'X-New-Header': 'new-value',
      },
      {
        Authorization: 'old-secret',
        'X-Removed-Header': 'removed-secret',
      },
    ),
    {
      authorization: 'old-secret',
      'X-New-Header': 'new-value',
    },
  );
});

test('连接测试会把 Authorization 等自定义 Header 发送给模型端点', async () => {
  let receivedAuthorization = '';
  const originalFetch = globalThis.fetch;
  const proxyEnvNames = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY'] as const;
  const oldProxyEnv = Object.fromEntries(proxyEnvNames.map(name => [name, process.env[name]]));
  for (const name of proxyEnvNames) delete process.env[name];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    receivedAuthorization = new Headers(init?.headers).get('authorization') ?? '';
    return new Response(JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1,
      model: 'qwen',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  resetProxyConfigCache();

  try {
    const response = await testModelConnection(new Request('http://localhost/api/eval/settings/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'custom',
        apiKey: '',
        baseUrl: 'https://model-gateway.test/v1',
        model: 'qwen',
        headers: { Authorization: 'internal-header-token' },
      }),
    }));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(receivedAuthorization, 'internal-header-token');
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of proxyEnvNames) {
      const oldValue = oldProxyEnv[name];
      if (oldValue === undefined) delete process.env[name];
      else process.env[name] = oldValue;
    }
    resetProxyConfigCache();
  }
});
