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
import { POST } from '@/app/api/skills/by-name/[name]/analysis-diagnosis/route';
import { resetProxyConfigCache } from '@/lib/ingest/proxy-config';
import { db } from '@/lib/storage/prisma';

import {
  buildFallbackDiagnosis,
  parseDiagnosisResponse,
  type SkillDiagnosisSnapshot,
} from '@/lib/skill-analysis/diagnosis';

function makeSnapshot(overrides?: Partial<SkillDiagnosisSnapshot>): SkillDiagnosisSnapshot {
  return {
    skillName: 'demo-skill',
    version: 1,
    overall: {
      weightedScore: 82,
      coveredCount: 4,
      totalCount: 4,
      missingDimensions: [],
      selectedDimensionsThisRun: [],
    },
    ab: {
      configured: true,
      hasResult: true,
      status: 'done',
      scoreA: 82,
      scoreB: 86,
      delta: 4,
      pValue: 0.2,
      sampleCount: 12,
      recommendation: 'flat',
    },
    trace: {
      configured: true,
      hasResult: true,
      status: 'done',
      score: 80,
      fullyEvaluatedCount: 3,
      totalTraceCount: 3,
      highDeviationCount: 1,
    },
    recall: {
      configured: true,
      hasResult: true,
      status: 'done',
      score: 78,
      passRate: 0.78,
      truePositiveRate: 0.8,
      falsePositiveRate: 0.1,
      itemCount: 18,
      positiveCount: 9,
    },
    static: {
      configured: true,
      hasResult: true,
      status: 'done',
      score: 90,
      passedCount: 6,
      totalCount: 6,
      issueCount: 0,
    },
    ...overrides,
  };
}

test('buildFallbackDiagnosis prioritizes A/B regression', () => {
  const result = buildFallbackDiagnosis(makeSnapshot({
    ab: {
      configured: true,
      hasResult: true,
      status: 'done',
      scoreA: 75,
      scoreB: 60,
      delta: -15,
      pValue: 0.01,
      sampleCount: 8,
      recommendation: 'down',
    },
  }));
  assert.match(result.problem, /不建议上线/);
});

test('buildFallbackDiagnosis reports coverage gaps before low-score dimensions', () => {
  const result = buildFallbackDiagnosis(makeSnapshot({
    overall: {
      weightedScore: 50,
      coveredCount: 3,
      totalCount: 4,
      missingDimensions: ['recall'],
      selectedDimensionsThisRun: [],
    },
    recall: {
      configured: false,
      hasResult: false,
      status: 'unconfigured',
      score: null,
      passRate: null,
      truePositiveRate: null,
      falsePositiveRate: null,
      itemCount: 0,
      positiveCount: 0,
    },
  }));
  assert.match(result.problem, /覆盖仍不完整/);
  assert.match(result.suggestion, /补齐可运行维度/);
});

test('buildFallbackDiagnosis points to recall when it is the weakest completed dimension', () => {
  const result = buildFallbackDiagnosis(makeSnapshot({
    recall: {
      configured: true,
      hasResult: true,
      status: 'done',
      score: 42,
      passRate: 0.42,
      truePositiveRate: 0.4,
      falsePositiveRate: 0.3,
      itemCount: 20,
      positiveCount: 10,
    },
  }));
  assert.match(result.problem, /召回分析/);
});

test('parseDiagnosisResponse tolerates fenced json', () => {
  const parsed = parseDiagnosisResponse('```json\n{"problem":"a","suggestion":"b"}\n```');
  assert.deepEqual(parsed, { problem: 'a', suggestion: 'b' });
});

test('analysis diagnosis requests structured Claude output and keeps JSON mode for gateways', async t => {
  const originalEnv = process.env;
  process.env = { ...originalEnv };
  for (const key of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'NODE_TLS_REJECT_UNAUTHORIZED']) {
    delete process.env[key];
  }
  resetProxyConfigCache();
  t.after(() => {
    process.env = originalEnv;
    resetProxyConfigCache();
  });

  const model = 'claude-sonnet-5-5';
  t.mock.method(db, 'findUserSettings', async (user: string) => ({
    settingsJson: JSON.stringify({
      activeConfigId: 'test-model',
      configs: [{
        id: 'test-model', name: 'Test model', provider: 'custom', apiKey: 'test-only', model,
        baseUrl: user === 'claude-test' ? 'https://api.anthropic.com' : 'https://model.test/v1',
      }],
    }),
  }));
  const diagnosis = { problem: 'A problem', suggestion: 'A fix' };
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({
    choices: [{ message: { role: 'assistant', content: JSON.stringify(diagnosis) } }],
  }));

  for (const user of ['claude-test', 'gateway-test']) {
    const response = await POST(new Request('http://localhost/analysis-diagnosis', {
      method: 'POST', body: JSON.stringify({ user, snapshot: makeSnapshot() }),
    }), { params: Promise.resolve({ name: 'demo-skill' }) });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).diagnosis, { ...diagnosis, mode: 'llm', modelLabel: 'Test model' });
  }

  assert.deepEqual(fetch.mock.calls.map(call => String(call.arguments[0])), [
    'https://api.anthropic.com/v1/chat/completions', 'https://model.test/v1/chat/completions',
  ]);
  const [claude, gateway] = fetch.mock.calls.map(call => JSON.parse(call.arguments[1]?.body as string).response_format);
  assert.equal(claude.type, 'json_schema');
  assert.equal(claude.json_schema.strict, true);
  assert.deepEqual(claude.json_schema.schema.required, ['problem', 'suggestion']);
  assert.equal(claude.json_schema.schema.additionalProperties, false);
  assert.deepEqual(gateway, { type: 'json_object' });
});
