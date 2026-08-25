import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { POST } from '@/app/api/ingest/otel/v1/traces/route';
import { listSources } from '@/lib/ingest/otel-consumer/sources';
import { listOtelTraceSpoolFiles } from '@/lib/ingest/otel/spool';

const spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'actrail-otel-ingest-'));
const actrailSpoolDirectory = path.join(spoolRoot, 'actrail');
const genericSpoolDirectory = path.join(spoolRoot, 'traces');
process.env.AGENT_INSIGHT_ACTRAIL_OTEL_SPOOL_DIR = actrailSpoolDirectory;
process.env.AGENT_INSIGHT_OTEL_TRACE_SPOOL_DIR = genericSpoolDirectory;


function attr(key: string, value: string | number) {
  return {
    key,
    value: typeof value === 'number'
      ? { intValue: String(value) }
      : { stringValue: value },
  };
}

test('AcTrail OTLP endpoint appends events that aggregate into an execution record', async (context) => {
  context.after(() => fs.rmSync(spoolRoot, { recursive: true, force: true }));
  const traceId = '00000000000000000000000000000009';
  const requestActionId = 'trace:9:request';
  const responseActionId = 'trace:9:response';
  const body = {
    resourceSpans: [{
      resource: {
        attributes: [
          attr('service.name', 'default-full-monitor-ebpf-on-notify-on'),
          attr('actrail.trace.display_name', 'ingest-test'),
          attr('actrail.trace.id', 9),
        ],
      },
      scopeSpans: [{
        scope: { name: 'actrail.semantic_actions', version: '0.7.1' },
        spans: [
          {
            traceId,
            spanId: 'request',
            parentSpanId: 'call',
            name: 'LLM request test-model',
            startTimeUnixNano: '1000000000',
            endTimeUnixNano: '1000000000',
            attributes: [
              attr('actrail.action.id', requestActionId),
              attr('actrail.action.kind', 'llm.request'),
              attr('actrail.action.status', 'success'),
              attr('actrail.action.completeness', 'complete'),
              attr('llm.request.model', 'test-model'),
              attr('llm.request.message_preview', 'hello from AcTrail'),
            ],
          },
          {
            traceId,
            spanId: 'call',
            name: 'LLM call test-model',
            startTimeUnixNano: '1000000000',
            endTimeUnixNano: '3000000000',
            attributes: [
              attr('actrail.action.id', 'trace:9:call'),
              attr('actrail.action.kind', 'llm.call'),
              attr('actrail.action.status', 'success'),
              attr('actrail.action.completeness', 'complete'),
              attr('llm.call.model', 'test-model'),
              attr('llm.call.request_action_id', requestActionId),
              attr('llm.call.response_action_id', responseActionId),
            ],
          },
          {
            traceId,
            spanId: 'response',
            name: 'LLM response test-model',
            startTimeUnixNano: '1500000000',
            endTimeUnixNano: '3000000000',
            attributes: [
              attr('actrail.action.id', responseActionId),
              attr('actrail.action.kind', 'llm.response'),
              attr('actrail.action.status', 'success'),
              attr('actrail.action.completeness', 'complete'),
              attr('llm.response.model', 'test-model'),
              attr('llm.response.content_text', 'hello accepted'),
              attr('llm.response.prompt_tokens', 4),
              attr('llm.response.completion_tokens', 2),
              attr('llm.response.total_tokens', 6),
            ],
          },
        ],
      }],
    }],
  };

  const response = await POST(new Request('http://localhost/api/ingest/otel/v1/traces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, 'accepted');
  assert.equal(result.received, 3);
  assert.deepEqual(result.sessions, [traceId]);
  assert.equal('rawCaptured' in result, false);

  assert.equal(listOtelTraceSpoolFiles(actrailSpoolDirectory).length, 1);
  assert.equal(listOtelTraceSpoolFiles(genericSpoolDirectory).length, 0);

  const actrailSource = listSources().find((source) => source.id === 'actrail-otel-traces');
  assert.ok(actrailSource);
  assert.equal(actrailSource.spoolDir(), actrailSpoolDirectory);
  const aggregation = actrailSource.aggregate(traceId);
  assert.equal(aggregation.eventCount, 3);
  assert.ok(aggregation.record);
  assert.equal(aggregation.record.framework, 'actrail');
  assert.equal(aggregation.record.query, 'hello from AcTrail');
  assert.equal(aggregation.record.final_result, 'hello accepted');
  assert.equal(aggregation.record.tokens, 6);
});
