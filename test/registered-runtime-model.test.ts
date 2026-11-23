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
import { buildRegisteredModelProviders, mapServerModelConfig } from '../src/lib/engine/general-agent/server-model-config';
import type { ModelConfig } from '../src/lib/storage/server-config';

const config: ModelConfig = { id: 'native', name: 'Native', provider: 'anthropic', protocol: 'anthropic',
  model: 'same-model', apiKey: '', baseUrl: 'https://gateway.test/team/v1', headers: { 'X-Company-Auth': 'company-token' } };

test('同供应商同模型的两种协议使用独立运行连接且不继承默认鉴权', () => {
  const compatible: ModelConfig = { ...config, id: 'compatible', protocol: 'openai-compatible', baseUrl: 'https://other.test/v1' };
  const native = mapServerModelConfig(config)!;
  const other = mapServerModelConfig(compatible)!;
  assert.notEqual(native.providerID, other.providerID);
  assert.equal(mapServerModelConfig({ ...config, apiKey: 'changed' })?.providerID, native.providerID);
  const runtime = buildRegisteredModelProviders([config, compatible], config.id);
  assert.equal(runtime.model, `${native.providerID}/same-model`);
  assert.equal(runtime.small_model, runtime.model);
  assert.equal(runtime.provider[native.providerID].npm, '@ai-sdk/anthropic');
  assert.equal(runtime.provider[other.providerID].npm, '@ai-sdk/openai-compatible');
  for (const pid of [native.providerID, other.providerID]) {
    const options = runtime.provider[pid].options;
    assert.equal(options.apiKey, '');
    assert.equal(options.headers['x-api-key'], null);
    assert.equal(options.headers.authorization, null);
    assert.equal(options.headers['x-company-auth'], 'company-token');
  }
  assert.equal(runtime.provider[other.providerID].options.baseURL, 'https://other.test/v1');
});

test('旧配置保留供应商映射，显式自定义鉴权覆盖运行时默认值', () => {
  const legacy: ModelConfig = { ...config, protocol: undefined };
  assert.equal(mapServerModelConfig(legacy)?.providerID, 'anthropic');
  const withKey = { ...config, apiKey: 'standard-key', headers: { 'X-API-Key': 'custom-key', AUTHORIZATION: 'custom-auth' } };
  const runtime = buildRegisteredModelProviders([withKey], config.id);
  const pid = mapServerModelConfig(withKey)!.providerID;
  assert.equal(runtime.provider[pid].options.headers['x-api-key'], 'custom-key');
  assert.equal(runtime.provider[pid].options.headers.authorization, 'custom-auth');
});

test('静态配置包含非默认连接的协议和鉴权变更', () => {
  const secondary: ModelConfig = { ...config, id: 'secondary', protocol: 'openai-compatible' };
  const runtime = buildRegisteredModelProviders([config, secondary], config.id);
  for (const changed of [{ ...secondary, apiKey: 'changed' }, { ...secondary, protocol: 'anthropic' as const },
    { ...secondary, headers: { 'X-Company-Auth': 'changed' } }]) {
    assert.notDeepEqual(buildRegisteredModelProviders([config, changed], config.id), runtime);
  }
});
