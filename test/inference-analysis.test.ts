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
import test, { describe } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { inferenceAnalysisTarget } from '@/lib/trace/inference-analysis';
import { InferenceAnalysisDetails } from '@/components/observe/InferenceAnalysisButton';
import { toTraceStructureInteractions } from '@/lib/trace/session-payload';
import { buildInferenceAnalysisUrl, resolveInferenceAnalysisConfig } from '@/lib/trace/inference-analysis-link';
import { type RawInteraction } from '@/lib/engine/observability/agent-trace';

describe("Agent identity and missing IDs", () => {
  test('Qoder child inference uses the wire root session and real response ID', () => {
      const [interaction] = toTraceStructureInteractions([{ role: 'subagent', subagent_session_id: 'child-agent', inference_session_id: 'wire-root', messageID: 'response-1', model: 'probe' }]);
      const target = inferenceAnalysisTarget({ framework: 'qoder', scope: 'llm', rootSessionId: 'current-root', interaction });
      assert.deepEqual(target.sessionIds, ['wire-root']);
      assert.equal(target.responseId, 'response-1');
      assert.equal(target.unavailableReason, undefined);
  });

  test('Qoder local errors and missing response IDs never become link targets', () => {
      for (const interaction of [
          { role: 'assistant' as const, messageID: 'local-error', model: '<synthetic>' },
          { role: 'assistant' as const, messageID: 'local-error', inference_response_unavailable: true },
          { role: 'assistant' as const, spanId: 'internal-span', traceId: 'internal-trace' },
      ]) {
          const target = inferenceAnalysisTarget({ framework: 'qoder', scope: 'llm', rootSessionId: 'wire-root', interaction });
          assert.equal(target.responseId, undefined);
          assert.equal(target.unavailableReason, 'response');
      }
  });

  test('OpenCode retains per-call session and retry attempts without substituting message IDs', () => {
      const target = inferenceAnalysisTarget({ framework: 'opencode', scope: 'llm', rootSessionId: 'root', interaction: {
          role: 'subagent', inference_session_id: 'child', messageID: 'message', inference_request_id: 'logical-call',
          inference_attempts: [{ request_id: 'logical-call', attempt_id: 'try-1', status_code: 503 }, { request_id: 'logical-call', attempt_id: 'try-2', status_code: 200 }, { request_id: 'other-call', attempt_id: 'unrelated' }],
      } });
      assert.deepEqual(target.sessionIds, ['child']);
      assert.equal(target.requestId, 'logical-call');
      assert.deepEqual(target.attemptIds, ['try-1', 'try-2']);
      assert.equal(target.responseId, undefined);
      assert.equal(inferenceAnalysisTarget({ framework: 'opencode', scope: 'llm', rootSessionId: 'root', interaction: { role: 'assistant' as const, messageID: 'message' } }).unavailableReason, 'request');
  });

  test('Trace target includes OpenCode child sessions and deduplicates Qoder wire sessions', () => {
      const interactions = [{ role: 'assistant' as const, inference_session_id: 'root' }, { role: 'assistant' as const, inference_session_id: 'child' }, { role: 'assistant' as const, inference_session_id: 'child' }];
      assert.deepEqual(inferenceAnalysisTarget({ framework: 'opencode', scope: 'trace', rootSessionId: 'root', interactions }).sessionIds, ['root', 'child']);
      assert.deepEqual(inferenceAnalysisTarget({ framework: 'qoder', scope: 'trace', rootSessionId: 'root' }).sessionIds, ['root']);
  });

  test('Inference entry explains unconfigured and missing-ID states without fabricating a URL', () => {
      const ready = renderToStaticMarkup(React.createElement(InferenceAnalysisDetails, { target: inferenceAnalysisTarget({ framework: 'qoder', scope: 'llm', rootSessionId: 'root', interaction: { role: 'assistant' as const, messageID: 'response' } }), locale: 'zh' }));
      assert.match(ready, /尚未配置推理分析页面地址/);
      assert.match(ready, /response/);
      assert.doesNotMatch(ready, /href=/);
      const missing = renderToStaticMarkup(React.createElement(InferenceAnalysisDetails, { target: inferenceAnalysisTarget({ framework: 'qoder', scope: 'llm', rootSessionId: 'root', interaction: { role: 'assistant', model: '<synthetic>', messageID: 'local-error' } }), locale: 'zh' }));
      assert.match(missing, /未采集到推理服务响应 ID/);
      assert.doesNotMatch(missing, /local-error/);
  });

  test('Mixed-framework collaboration uses each call identity instead of the root framework', () => {
      const openCodeChild = inferenceAnalysisTarget({ framework: 'qoder', scope: 'llm', rootSessionId: 'qoder-root', interaction: {
          role: 'subagent', messageID: 'opencode-local-message', inference_session_id: 'opencode-child', inference_request_id: 'actual-wire-request',
      } });
      assert.equal(openCodeChild.responseId, undefined);
      assert.equal(openCodeChild.requestId, 'actual-wire-request');
      const qoderChild = inferenceAnalysisTarget({ framework: 'opencode', scope: 'llm', rootSessionId: 'opencode-root', interaction: {
          role: 'subagent', messageID: 'service-response', inference_response_id: 'service-response', inference_session_id: 'qoder-child',
      } });
      assert.equal(qoderChild.responseId, 'service-response');
      assert.deepEqual(qoderChild.sessionIds, ['qoder-child']);
      assert.equal(qoderChild.unavailableReason, undefined);
      const foreignLegacy = inferenceAnalysisTarget({ framework: 'qoder', scope: 'llm', rootSessionId: 'qoder-root', interaction: {
          role: 'subagent', messageID: 'foreign-local-message', _collaboration: { taskId: 'other-task' },
      } });
      assert.equal(foreignLegacy.responseId, undefined);
  });
});

describe("Call selection and external links", () => {
  const failedId = 'c5ea737b-a040-4b64-b5f5-99981e24be28';
  const successId = '95e2b0dc-90dd-4baa-92ae-270b71edb4e7';
  const childId = 'd4227636-69bc-4b13-9cec-d74feb5ccc25';
  const unknownId = '9792e667-98c7-410c-a67e-53b0c60349cb';

  function retryInteraction(): RawInteraction {
      return {
          role: 'assistant', model: 'probe-model', messageID: 'msg-answer',
          inference_session_id: 'session-root', inference_request_id: 'request-answer',
          inference_call_ids: [failedId, successId],
          inference_attempts: [
              { request_id: 'request-answer', attempt_id: 'attempt-failed', call_id: failedId, started_at: '2026-10-15T01:00:00.000Z', status_code: 503 },
              { request_id: 'request-answer', attempt_id: 'attempt-success', call_id: successId, started_at: '2026-10-15T01:00:01.000Z', status_code: 200 },
          ],
      };
  }

  function llm(interaction: RawInteraction) {
      return inferenceAnalysisTarget({ framework: 'opencode', scope: 'llm', rootSessionId: 'session-root', interaction });
  }

  test('LLM analysis retains failed and successful retry metadata and recommends the latest attempt', () => {
      const target = llm(retryInteraction());
      assert.deepEqual(target.calls, [
          { callId: failedId, startedAt: '2026-10-15T01:00:00.000Z', statusCode: 503, model: 'probe-model', messageId: 'msg-answer', sessionId: 'session-root' },
          { callId: successId, startedAt: '2026-10-15T01:00:01.000Z', statusCode: 200, model: 'probe-model', messageId: 'msg-answer', sessionId: 'session-root' },
      ]);
      assert.equal(target.preferredCallId, successId);
  });

  test('latest retry selection uses start time instead of array order or success status', () => {
      const interaction = retryInteraction();
      interaction.inference_call_ids?.reverse();
      interaction.inference_attempts?.reverse();
      assert.equal(llm(interaction).preferredCallId, successId);
      interaction.inference_attempts![0].status_code = 503;
      interaction.inference_attempts![1].status_code = 200;
      assert.equal(llm(interaction).preferredCallId, successId);
  });

  test('ambiguous or missing retry timestamps require explicit selection', () => {
      for (const timestamp of [undefined, 'invalid', '2026-10-15T01:00:00.000Z']) {
          const interaction = retryInteraction();
          interaction.inference_attempts![1].started_at = timestamp;
          const target = llm(interaction);
          assert.equal(target.calls?.length, 2);
          assert.equal(target.preferredCallId, undefined);
      }
  });

  test('equivalent timestamp offsets do not create an arbitrary latest attempt', () => {
      const interaction = retryInteraction();
      interaction.inference_attempts![1].started_at = '2026-10-15T09:00:00+08:00';
      assert.equal(llm(interaction).preferredCallId, undefined);
  });

  test('a single failed call is selectable without a timestamp', () => {
      const interaction = retryInteraction();
      interaction.inference_call_ids = [failedId];
      interaction.inference_attempts = [{ request_id: 'request-answer', attempt_id: 'failed', call_id: failedId, status_code: 503 }];
      assert.equal(llm(interaction).preferredCallId, failedId);
      assert.equal(llm(interaction).calls?.[0].statusCode, 503);
  });

  test('recorded attempt state is retained without inferring completion from an HTTP status', () => {
      const interaction = retryInteraction();
      interaction.inference_attempts![1] = { ...interaction.inference_attempts![1], state: 'cancelled' };
      assert.equal(llm(interaction).calls?.find(call => call.callId === successId)?.state, 'cancelled');
  });

  test('matching attempt call IDs are usable even when the redundant call ID list is missing', () => {
      const interaction = retryInteraction();
      delete interaction.inference_call_ids;
      interaction.inference_attempts!.push({ request_id: 'different-request', attempt_id: 'foreign', call_id: childId, started_at: '2026-10-15T02:00:00Z' });
      assert.deepEqual(llm(interaction).callIds, [failedId, successId]);
      assert.equal(llm(interaction).preferredCallId, successId);
  });

  test('attempts from another request cannot supply metadata for an explicitly owned call', () => {
      const interaction = retryInteraction();
      interaction.inference_attempts![1].request_id = 'different-request';
      const target = llm(interaction);
      assert.deepEqual(target.callIds, [failedId, successId]);
      assert.equal(target.calls?.find(call => call.callId === successId)?.startedAt, undefined);
      assert.equal(target.preferredCallId, undefined);
  });

  test('Trace includes child and unassigned calls but never recommends one ID as a multi-call Trace', () => {
      const interactions: RawInteraction[] = [retryInteraction(), {
          role: 'subagent', model: 'child-model', messageID: 'msg-child', inference_session_id: 'session-child', inference_call_ids: [childId],
      }, {
          role: 'system', inference_session_id: 'session-root',
          inference_unassigned_calls: [{ call_id: unknownId, status_code: 503, state: 'completed', started_at: '2026-10-15T01:00:02Z', reason: 'missing_response_id' }],
      }];
      const target = inferenceAnalysisTarget({ framework: 'qoder', scope: 'trace', rootSessionId: 'session-root', interactions });
      assert.deepEqual(target.callIds, [failedId, successId, childId, unknownId]);
      assert.deepEqual(target.unassignedCallIds, [unknownId]);
      assert.equal(target.calls?.length, 4);
      assert.deepEqual(target.calls?.find(call => call.callId === unknownId), {
          callId: unknownId, statusCode: 503, state: 'completed', startedAt: '2026-10-15T01:00:02Z', unassigned: true, sessionId: 'session-root',
      });
      assert.equal(target.calls?.find(call => call.callId === childId)?.messageId, 'msg-child');
      assert.equal(target.preferredCallId, undefined);
  });

  test('LLM targets do not absorb unassigned calls from their interaction or neighboring nodes', () => {
      const interaction = retryInteraction();
      interaction.inference_unassigned_calls = [{ call_id: unknownId, status_code: 503 }];
      const target = inferenceAnalysisTarget({ framework: 'opencode', scope: 'llm', interaction, interactions: [{ role: 'assistant', inference_call_ids: [childId] }] });
      assert.deepEqual(target.calls?.map(call => call.callId), [failedId, successId]);
      assert.equal(target.unassignedCallIds, undefined);
  });

  test('Trace deduplicates repeated snapshots while retaining richer metadata', () => {
      const interactions: RawInteraction[] = [
          { role: 'assistant', inference_call_ids: [failedId], inference_session_id: 'session-root' },
          retryInteraction(), retryInteraction(),
      ];
      const target = inferenceAnalysisTarget({ scope: 'trace', rootSessionId: 'session-root', interactions });
      assert.equal(target.calls?.length, 2);
      assert.equal(target.calls?.[0].statusCode, 503);
      assert.equal(target.calls?.[0].model, 'probe-model');
  });

  test('a single unassigned Trace call remains available and explicitly marked', () => {
      const target = inferenceAnalysisTarget({ scope: 'trace', interactions: [{ role: 'system', inference_unassigned_calls: [{ call_id: unknownId, state: 'failed' }] }] });
      assert.equal(target.preferredCallId, unknownId);
      assert.equal(target.calls?.[0].unassigned, true);
  });

  test('legacy session, response, message, request and attempt IDs never become unified call IDs', () => {
      for (const framework of ['qoder', 'opencode']) {
          const target = inferenceAnalysisTarget({ framework, scope: 'llm', rootSessionId: 'legacy-root', interaction: {
              role: 'assistant', messageID: 'legacy-message', inference_response_id: 'legacy-response', inference_request_id: 'legacy-request', inference_session_id: 'legacy-session',
              inference_attempts: [{ request_id: 'legacy-request', attempt_id: 'legacy-attempt', started_at: '2026-10-15T00:00:00Z' }],
          } });
          assert.equal(target.callIds, undefined);
          assert.equal(target.calls, undefined);
          assert.equal(target.preferredCallId, undefined);
          assert.equal(target.responseId, 'legacy-response');
      }
  });

  test('an absent inference origin is explicitly unconfigured', () => {
      for (const raw of [undefined, null, '', '  ']) {
          assert.deepEqual(resolveInferenceAnalysisConfig(raw), { status: 'unconfigured' });
      }
  });

  test('inference origins support HTTP, HTTPS, IPv4, IPv6 and ports', () => {
      for (const [raw, origin] of [
          ['http://192.0.2.10:8080', 'http://192.0.2.10:8080'],
          [' https://Analysis.Example.com:8443/ ', 'https://analysis.example.com:8443'],
          ['http://[::1]:3088/', 'http://[::1]:3088'],
      ]) {
          assert.deepEqual(resolveInferenceAnalysisConfig(raw), { status: 'ready', origin });
      }
  });

  test('unsafe or non-origin configuration is invalid', () => {
      for (const raw of [
          'javascript:alert(1)', 'file:///tmp/model-performance', '//example.com', 'example.com:8080',
          'http://user:secret@example.com', 'http://example.com/path', 'http://example.com/..',
          'http://example.com?x=1', 'http://example.com#part', 'http://example.com?', 'http://example.com#',
          'http://example.com:999999', 'http://example.com\\path', 'http:/example.com', 'https://exa\nmple.com',
      ]) {
          assert.deepEqual(resolveInferenceAnalysisConfig(raw), { status: 'invalid' }, raw);
      }
  });

  test('a configured link uses the fixed path and exactly one encoded GlobalTrackNO', () => {
      const callId = 'call/?#&= +汉字';
      const link = buildInferenceAnalysisUrl(resolveInferenceAnalysisConfig('http://192.0.2.10:8080/'), callId);
      assert.ok(link);
      const url = new URL(link);
      assert.equal(url.origin, 'http://192.0.2.10:8080');
      assert.equal(url.pathname, '/model-performance');
      assert.equal(url.searchParams.get('GlobalTrackNO'), callId);
      assert.deepEqual([...url.searchParams.keys()], ['GlobalTrackNO']);
      assert.equal(url.hash, '');
      assert.ok(!link.includes('汉字'));
  });

  test('missing or invalid configuration and blank IDs never produce an external URL', () => {
      assert.equal(buildInferenceAnalysisUrl({ status: 'unconfigured' }, failedId), undefined);
      assert.equal(buildInferenceAnalysisUrl({ status: 'invalid' }, failedId), undefined);
      assert.equal(buildInferenceAnalysisUrl({ status: 'ready', origin: 'javascript:alert(1)' }, failedId), undefined);
      for (const id of [undefined, null, '', '  ']) {
          assert.equal(buildInferenceAnalysisUrl(resolveInferenceAnalysisConfig('https://analysis.example.com'), id), undefined);
      }
  });

  test('the link contract accepts only the selected single unified call ID', () => {
      const config = resolveInferenceAnalysisConfig('https://analysis.example.com');
      const target = llm(retryInteraction());
      const url = new URL(buildInferenceAnalysisUrl(config, target.preferredCallId)!);
      assert.equal(url.searchParams.get('GlobalTrackNO'), successId);
      assert.ok(!url.href.includes(failedId));
      const legacy = llm({ role: 'assistant', inference_session_id: 'legacy-session', inference_request_id: 'legacy-request', messageID: 'legacy-message' });
      assert.equal(buildInferenceAnalysisUrl(config, legacy.preferredCallId), undefined);
  });
});

describe("Inference analysis dialog", () => {
  const target = {
      scope: 'llm' as const,
      sessionIds: ['session'],
      callIds: ['failed-call', 'final-call'],
      preferredCallId: 'final-call',
      calls: [
          { callId: 'failed-call', statusCode: 503, startedAt: '2026-10-15T08:00:00Z' },
          { callId: 'final-call', statusCode: 200, startedAt: '2026-10-15T08:00:01Z' },
      ],
  };

  test('Inference dialog offers separate single-ID links for failed and final model requests', () => {
      const html = renderToStaticMarkup(React.createElement(InferenceAnalysisDetails, {
          target, locale: 'zh', config: { status: 'ready', origin: 'http://127.0.0.1:19090' },
      }));
      assert.match(html, /href="http:\/\/127.0.0.1:19090\/model-performance\?GlobalTrackNO=failed-call"/);
      assert.match(html, /href="http:\/\/127.0.0.1:19090\/model-performance\?GlobalTrackNO=final-call"/);
      assert.match(html, /HTTP 503/);
      assert.match(html, /HTTP 200/);
      assert.match(html, /最近一次请求/);
      assert.match(html, /target="_blank"/);
      assert.match(html, /rel="noopener noreferrer"/);
      assert.doesNotMatch(html, /GlobalTrackNO=failed-call[,\u0026]/);
  });

  test('Inference dialog keeps legacy identities visible but never uses them as GlobalTrackNO', () => {
      const html = renderToStaticMarkup(React.createElement(InferenceAnalysisDetails, {
          target: { scope: 'llm', sessionIds: ['legacy-session'], responseId: 'legacy-response' },
          locale: 'zh', config: { status: 'ready', origin: 'https://inference.example.com' },
      }));
      assert.match(html, /legacy-response/);
      assert.match(html, /未采集到统一模型调用 ID/);
      assert.doesNotMatch(html, /href=/);
  });

  test('Inference dialog explains invalid or missing service configuration without external links', () => {
      for (const status of ['invalid', 'unconfigured'] as const) {
          const html = renderToStaticMarkup(React.createElement(InferenceAnalysisDetails, {
              target, locale: 'zh', config: { status },
          }));
          assert.doesNotMatch(html, /href=/);
          assert.match(html, status === 'invalid' ? /推理分析页面地址配置无效/ : /尚未配置推理分析页面地址/);
      }
  });

  test('Trace dialog labels unassigned calls and never presents them as an LLM result', () => {
      const html = renderToStaticMarkup(React.createElement(InferenceAnalysisDetails, {
          target: { scope: 'trace', sessionIds: ['session'], callIds: ['unassigned'], calls: [{ callId: 'unassigned', unassigned: true, statusCode: 503 }] },
          locale: 'zh', config: { status: 'ready', origin: 'http://127.0.0.1:19090' },
      }));
      assert.match(html, /未确定所属 LLM/);
      assert.match(html, /GlobalTrackNO=unassigned/);
      assert.doesNotMatch(html, /最近一次请求/);
  });
});
