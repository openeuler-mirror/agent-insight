import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildProviderEndpointMap,
  normalizeEndpointUrl,
  resolveRecordEndpoint,
} from '@/lib/infra/endpoint-resolve';

const events = [
  {
    kind: 'event',
    payload: {
      type: 'config.redacted',
      config: {
        provider: {
          gx10: { options: { baseURL: 'http://vllm-a.test:8000/v1' } },
          'huawei-glm': { options: { baseURL: 'http://vllm-b.test:8080/v1' } },
          legacy: { baseURL: 'http://legacy:8000' }, // 兼容无 options 的形态
        },
      },
    },
  },
  { kind: 'chat.message', payload: { type: 'whatever' } }, // 非 config 事件忽略
];

test('buildProviderEndpointMap 从 config.redacted 取 providerID→baseURL', () => {
  const map = buildProviderEndpointMap(events);
  assert.equal(map.gx10, 'http://vllm-a.test:8000/v1');
  assert.equal(map['huawei-glm'], 'http://vllm-b.test:8080/v1');
  assert.equal(map.legacy, 'http://legacy:8000');
});

test('resolveRecordEndpoint 按 providerID 盖归一后的关联键', () => {
  const map = buildProviderEndpointMap(events);
  assert.equal(resolveRecordEndpoint({ providerID: 'gx10' }, map), 'http://vllm-a.test:8000');
  assert.equal(resolveRecordEndpoint({ providerID: 'huawei-glm' }, map), 'http://vllm-b.test:8080');
  // 未知 provider / 无 providerID → null（不编造）
  assert.equal(resolveRecordEndpoint({ providerID: 'unknown' }, map), null);
  assert.equal(resolveRecordEndpoint({ providerID: null }, map), null);
});

test('normalizeEndpointUrl 剔除 path/query/凭证；非法 → null', () => {
  assert.equal(normalizeEndpointUrl('http://u:p@h:8000/v1?k=1'), 'http://h:8000');
  assert.equal(normalizeEndpointUrl('not-a-url'), null);
  assert.equal(normalizeEndpointUrl(null), null);
});
