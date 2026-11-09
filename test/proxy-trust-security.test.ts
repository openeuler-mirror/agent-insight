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
import { createRequire } from 'node:module';
import test from 'node:test';

const proxyAddress = createRequire(import.meta.url)('proxy-addr') as {
  compile(subnet: string): (address: string) => boolean;
};

test('short IPv4-mapped IPv6 trust prefixes cannot trust arbitrary forwarded clients', () => {
  const trust = proxyAddress.compile('::ffff:10.0.0.0/8');
  assert.equal(trust('203.0.113.5'), false);
});

test('valid IPv4 and IPv4-mapped proxy subnets retain their intended boundary', () => {
  for (const subnet of ['10.0.0.0/8', '::ffff:10.0.0.0/104']) {
    const trust = proxyAddress.compile(subnet);
    assert.equal(trust('10.1.2.3'), true);
    assert.equal(trust('203.0.113.5'), false);
  }
});
