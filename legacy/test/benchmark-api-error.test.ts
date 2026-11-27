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

import { BenchmarkProtocolError } from '../packages/benchmark-protocol/src/errors'
import { benchmarkErrorResponse } from '../src/lib/benchmark/api-error'
import { EvaluatorSkillError } from '../src/lib/evaluators/evaluator-skill-store'

for (const status of [400, 403, 404, 410, 413]) {
  test(`Benchmark preserves evaluator Skill error details and HTTP ${status}`, async () => {
    const response = benchmarkErrorResponse(new EvaluatorSkillError('Skill 快照不可用', status), 'test')

    assert.equal(response.status, status)
    assert.deepEqual(await response.json(), {
      error: { code: 'EVALUATOR_SKILL_ERROR', message: 'Skill 快照不可用', retryable: false },
    })
  })
}

test('Benchmark protocol errors retain their code, retryability and details', async () => {
  const response = benchmarkErrorResponse(
    new BenchmarkProtocolError('EXECUTOR_BUSY', '客户端忙碌', 409, true, { clientId: 'test-client' }),
    'test',
  )

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    error: { code: 'EXECUTOR_BUSY', message: '客户端忙碌', retryable: true, details: { clientId: 'test-client' } },
  })
})

test('Unexpected Benchmark errors remain generic HTTP 500 responses', async (t) => {
  const log = t.mock.method(console, 'error', () => {})
  const error = new Error('private storage details')
  const response = benchmarkErrorResponse(error, 'test')

  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), {
    error: { code: 'INTERNAL_ERROR', message: 'Benchmark 服务内部错误', retryable: false },
  })
  assert.deepEqual(log.mock.calls[0].arguments, ['[test]', error])
})
