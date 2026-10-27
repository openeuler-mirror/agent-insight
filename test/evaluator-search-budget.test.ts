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
import { prisma } from '@/lib/storage/prisma';
import { withEvaluatorExecution, runConfiguredEvaluationStage } from '@/lib/engine/experiment/evaluator-execution-policy';
import { gatherWebSearchEvidence } from '@/lib/engine/experiment/web-search-evidence';
import { runHallucinationPreset } from '@/lib/engine/experiment/hallucination-preset-evaluators';
import { setJudgeLlmCallerForTest } from '@/lib/engine/experiment/judge-llm';
import { setWebSearchEvidenceForTest } from '@/lib/engine/experiment/web-search-evidence';
import { experimentSignal } from '@/lib/engine/experiment/cancellation-context';

process.env.DATABASE_URL = process.env.AGENT_INSIGHT_TEST_DATABASE_URL || process.env.DATABASE_URL;

test('search failures degrade locally but the evaluation deadline cancels in-flight search', async () => {
  const originalFetch = globalThis.fetch;
  const user = `search-budget-${Date.now()}`;
  await prisma.userSettings.create({ data: { user, settingsJson: JSON.stringify({ searchProvider: 'tavily', searchApiKey: 'synthetic-test-key', configs: [] }) } });
  try {
    let searches = 0;
    globalThis.fetch = async () => {
      searches++;
      if (searches === 1) throw new Error('search network unavailable');
      return Response.json({ results: [{ title: 'local fixture', url: 'https://example.com', content: 'evidence' }] });
    };
    const evidence = await withEvaluatorExecution({ attemptTimeoutSeconds: 30, maxRetries: 0 }, new AbortController().signal,
      () => runConfiguredEvaluationStage(() => gatherWebSearchEvidence(user, 'question', '根据2024年研究调查的报告内容足够长。根据2025年研究调查的报告内容也足够长。')));
    assert.equal(searches, 2);
    assert.equal(evidence?.status, 'partial_failure');
    assert.equal(evidence?.hits.length, 1);
    let stopped = false;
    globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => { stopped = true; reject(options!.signal!.reason); }, { once: true });
    });
    await assert.rejects(withEvaluatorExecution({ attemptTimeoutSeconds: 0.02, maxRetries: 0 }, new AbortController().signal,
      () => runConfiguredEvaluationStage(() => gatherWebSearchEvidence(user, 'question', '2024年研究调查报告内容足够长。'))), /评估尝试超时/);
    assert.equal(stopped, true);
  } finally { globalThis.fetch = originalFetch; await prisma.userSettings.deleteMany({ where: { user } }); }
});

test('expired evidence lookup never starts the Judge; degraded evidence retains the knowledge fallback', async () => {
  let judges = 0;
  setJudgeLlmCallerForTest(async (_user, req) => { judges++; assert.match(req.system, /知识判断路径/); return '{"hallucinations":[],"catastrophic":false,"confidence":1}'; });
  const ctx = { caseInput: 'question', actualOutput: 'answer', referenceOutput: null, traceSummaryText: null, interactions: [], taskId: null, executionId: null };
  try {
    setWebSearchEvidenceForTest(async () => new Promise(resolve => experimentSignal()!.addEventListener('abort', () => resolve(null), { once: true })));
    await assert.rejects(withEvaluatorExecution({ attemptTimeoutSeconds: 0.01, maxRetries: 0 }, new AbortController().signal,
      () => runConfiguredEvaluationStage(() => runHallucinationPreset('preset-hallucination-text', 'search-test', ctx))), /评估尝试超时/);
    assert.equal(judges, 0);
    setWebSearchEvidenceForTest(async () => ({ queries: ['fixture'], hits: [], status: 'degraded' }));
    const output = await withEvaluatorExecution({ attemptTimeoutSeconds: 30, maxRetries: 0 }, new AbortController().signal,
      () => runConfiguredEvaluationStage(() => runHallucinationPreset('preset-hallucination-text', 'search-test', ctx)));
    assert.equal(judges, 1);
    assert.equal((output.evidence as { json: { webSearch: { status: string } } }).json.webSearch.status, 'degraded');
  } finally { setJudgeLlmCallerForTest(null); setWebSearchEvidenceForTest(null); }
});
