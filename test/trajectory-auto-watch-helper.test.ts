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

import {
  autoWatchAgentNamesMatch,
  isAutoWatchWindowMatch,
  mergeWatchedAgentIntoRawAnalysis,
  normalizeAutoWatchEnabledAt,
  resolveTrajectoryCandidateExecutionAgent,
  resolveWatchedAgentForRunRows,
} from '@/lib/engine/evaluation/trajectory-auto-watch-helper';

test('resolveTrajectoryCandidateExecutionAgent keeps the same execution agent rule as 发起新评测', () => {
  assert.equal(
    resolveTrajectoryCandidateExecutionAgent({
      agentName: 'build',
      agent: 'build',
      agents: ['build'],
    }),
    'build',
  );
});

test('resolveTrajectoryCandidateExecutionAgent rejects evaluator traces', () => {
  assert.equal(
    resolveTrajectoryCandidateExecutionAgent({
      agentName: 'trace-quality-evaluator',
      agent: 'trace-quality-evaluator',
      agents: ['trace-quality-evaluator'],
    }),
    '',
  );
});

test('mergeWatchedAgentIntoRawAnalysis writes watchedAgent while keeping existing autoWatch metadata', () => {
  assert.deepEqual(
    JSON.parse(mergeWatchedAgentIntoRawAnalysis('{"autoWatch":true,"taskMeta":{"title":"x"}}', 'build')),
    {
      autoWatch: true,
      taskMeta: { title: 'x' },
      watchedAgent: 'build',
    },
  );
});

test('mergeWatchedAgentIntoRawAnalysis removes watchedAgent when given an empty value', () => {
  assert.deepEqual(
    JSON.parse(mergeWatchedAgentIntoRawAnalysis('{"autoWatch":true,"watchedAgent":"build"}', '')),
    {
      autoWatch: true,
    },
  );
});

test('autoWatchAgentNamesMatch is case-insensitive', () => {
  assert.equal(autoWatchAgentNamesMatch('Build', 'build'), true);
});

test('normalizeAutoWatchEnabledAt keeps valid iso timestamps and rejects invalid values', () => {
  assert.equal(
    normalizeAutoWatchEnabledAt('2026-05-27T03:00:00.000Z'),
    '2026-05-27T03:00:00.000Z',
  );
  assert.equal(normalizeAutoWatchEnabledAt('not-a-date'), '');
});

test('isAutoWatchWindowMatch only accepts traces completed after auto-watch was enabled', () => {
  assert.equal(
    isAutoWatchWindowMatch('2026-05-27T03:00:00.000Z', '2026-05-27T03:00:00.000Z'),
    true,
  );
  assert.equal(
    isAutoWatchWindowMatch('2026-05-27T03:00:00.000Z', '2026-05-27T02:59:59.999Z'),
    false,
  );
  assert.equal(
    isAutoWatchWindowMatch('', '2026-05-27T03:00:00.000Z'),
    false,
  );
});

test('resolveWatchedAgentForRunRows keeps an explicit non-evaluator watchedAgent', async () => {
  assert.equal(
    await resolveWatchedAgentForRunRows(null, [
      {
        id: 'row-1',
        taskId: null,
        executionId: null,
        rawAnalysisJson: '{"autoWatch":true,"watchedAgent":"build"}',
      },
    ]),
    'build',
  );
});
