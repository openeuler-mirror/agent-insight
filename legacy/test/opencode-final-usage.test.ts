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

import { extractFinalUsageRecords } from '../scripts/opencode_plugin_otel'

test('opencode final usage: keeps assistant messages with non-zero usage and text parts', () => {
  const records = extractFinalUsageRecords([
    {
      info: {
        id: 'msg_answer', sessionID: 'ses_cli', role: 'assistant', modelID: 'mock',
        time: { created: 1, completed: 2 },
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 0 } },
      },
      parts: [
        { id: 'prt_text', messageID: 'msg_answer', sessionID: 'ses_cli', type: 'text', text: 'final answer' },
        { id: 'prt_reason', messageID: 'msg_answer', sessionID: 'ses_cli', type: 'reasoning', text: 'thinking' },
        { id: 'prt_tool', messageID: 'msg_answer', sessionID: 'ses_cli', type: 'tool' },
        { messageID: 'msg_answer', sessionID: 'ses_cli', type: 'text', text: 'no id is unusable' },
      ],
    },
    // User messages never carry the assistant usage we are recovering.
    { info: { id: 'msg_user', sessionID: 'ses_cli', role: 'user' }, parts: [] },
    // All-zero usage is the old uploader's placeholder, not real usage.
    {
      info: {
        id: 'msg_zero', sessionID: 'ses_cli', role: 'assistant',
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [{ id: 'prt_zero', messageID: 'msg_zero', sessionID: 'ses_cli', type: 'text', text: 'partial' }],
    },
  ])

  assert.equal(records.length, 1)
  assert.equal(records[0].info.id, 'msg_answer')
  assert.equal(records[0].info.role, 'assistant')
  assert.deepEqual(records[0].info.tokens, { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 0 } })
  assert.deepEqual(records[0].parts.map(part => part.id), ['prt_text', 'prt_reason'])
})

test('opencode final usage: accepts raw message-info entries and ignores malformed input', () => {
  const records = extractFinalUsageRecords([
    {
      id: 'msg_raw', sessionID: 'ses_cli', role: 'assistant',
      tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    null,
    { info: null },
  ])

  assert.equal(records.length, 1)
  assert.equal(records[0].info.id, 'msg_raw')
  assert.deepEqual(records[0].parts, [])
  assert.deepEqual(extractFinalUsageRecords([]), [])
  assert.deepEqual(extractFinalUsageRecords(null), [])
})
