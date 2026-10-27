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

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeReliabilityClientId,
  normalizeTraceClientMetadata,
  resolveTraceClientSnapshot,
} from '@/lib/reliability/trace-client'

test('trace client metadata accepts stable identity and host snapshot', () => {
  const metadata = normalizeTraceClientMetadata(
    {
      client_id: 'cli_12345678-1234-1234-1234-123456789abc',
      host: {
        hostname: 'dev-host',
        reported_ip: '10.20.30.40',
      },
      observedIp: '1.1.1.1',
    },
    '8.8.8.8',
  )

  assert.deepEqual(metadata, {
    clientId: 'cli_12345678-1234-1234-1234-123456789abc',
    hostIp: '10.20.30.40',
    hostName: 'dev-host',
    observedIp: '8.8.8.8',
  })
})

test('trace client metadata rejects malformed identity and IP values', () => {
  const metadata = normalizeTraceClientMetadata(
    {
      client_id: 'worker-1',
      host: {
        hostname: 'bad\nname',
        reported_ip: 'not-an-ip',
      },
    },
    'also-not-an-ip',
  )

  assert.deepEqual(metadata, {
    clientId: null,
    hostIp: null,
    hostName: null,
    observedIp: null,
  })
  assert.equal(normalizeReliabilityClientId('cli_x'), null)
})

test('trace client snapshot keeps the first non-empty value for every field', () => {
  assert.deepEqual(
    resolveTraceClientSnapshot(
      {
        clientId: 'cli_existing-12345678',
        hostIp: null,
        hostName: 'host-a',
        observedIp: '8.8.8.8',
      },
      {
        clientId: 'cli_incoming-12345678',
        hostIp: '10.20.30.40',
        hostName: 'host-b',
        observedIp: '1.1.1.1',
      },
    ),
    {
      clientId: 'cli_existing-12345678',
      hostIp: '10.20.30.40',
      hostName: 'host-a',
      observedIp: '8.8.8.8',
    },
  )
})
