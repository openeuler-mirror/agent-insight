import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { aggregate, diagnose } from '@/lib/infra/diagnose';
import { histQuantile, normalize, parsePromText } from '@/lib/ingest/vllm/prom-text';
import { endpointFromResource, normalizeOtlpMetrics } from '@/lib/ingest/vllm/otlp-metrics';
import type { OtlpMetricsPayload } from '@/lib/ingest/vllm/otlp-metrics';
import { decodeOtlpMetricsProto, encodeOtlpMetricsProto } from '@/lib/ingest/vllm/otlp-proto';

// 夹具 = 真实 otelcol-contrib（prometheus receiver 抓 GX10 vLLM）的一条 OTLP/JSON 导出。
const OTLP: OtlpMetricsPayload = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'vllm-otlp-metrics-sample.json'), 'utf8'),
);

test('normalizeOtlpMetrics 从真实 OTLP 导出归一出 InfraMetricSample', () => {
  const snap = normalizeOtlpMetrics(OTLP, { tsMs: 1000 });
  assert.equal(snap.model, 'Qwen3-Coder-30B-A3B-Instruct-FP8');
  assert.equal(snap.source, 'vllm-otlp-push');
  // 三个分区都应被填充
  assert.ok(Object.keys(snap.gauges).length > 0, 'gauges 应非空');
  assert.ok(Object.keys(snap.counters).length > 0, 'counters 应非空');
  assert.ok(snap.histograms['vllm:time_to_first_token_seconds']?.count >= 0, 'TTFT 直方图应存在');
});

test('endpointFromResource 从 resource attrs 还原真实源地址', () => {
  assert.equal(
    endpointFromResource({ resource: { attributes: [
      { key: 'server.address', value: { stringValue: '1.2.3.4' } },
      { key: 'server.port', value: { stringValue: '8000' } },
      { key: 'url.scheme', value: { stringValue: 'http' } },
    ] } }),
    'http://1.2.3.4:8000',
  );
  // 回退到 service.instance.id
  assert.equal(
    endpointFromResource({ resource: { attributes: [{ key: 'service.instance.id', value: { stringValue: '5.6.7.8:9000' } }] } }),
    'http://5.6.7.8:9000',
  );
  assert.equal(endpointFromResource({}), null);
});

test('normalizeOtlpMetrics 从真实导出还原 target=源地址', () => {
  // 夹具的 resource attrs 已脱敏为 vllm.test:8000
  assert.equal(normalizeOtlpMetrics(OTLP).target, 'http://vllm.test:8000');
});

test('OTLP protobuf 解码 ≡ JSON 解码（含 int 型 server.port）', () => {
  const attr = [{ key: 'model_name', value: { stringValue: 'M' } }];
  const payload: OtlpMetricsPayload = {
    resourceMetrics: [{
      resource: { attributes: [
        { key: 'server.address', value: { stringValue: 'h' } },
        { key: 'server.port', value: { intValue: 8000 } },
        { key: 'url.scheme', value: { stringValue: 'http' } },
      ] },
      scopeMetrics: [{ metrics: [
        { name: 'vllm:num_requests_running', gauge: { dataPoints: [{ attributes: attr, asDouble: 10 }] } },
        { name: 'vllm:generation_tokens_total', sum: { dataPoints: [{ attributes: attr, asInt: 5000 }] } },
        { name: 'vllm:time_to_first_token_seconds', histogram: { dataPoints: [{ attributes: attr, explicitBounds: [0.5, 1.0], bucketCounts: [1, 2, 0], sum: 2.0, count: 3 }] } },
      ] }],
    }],
  };
  const decoded = decodeOtlpMetricsProto(encodeOtlpMetricsProto(payload));
  const fromProto = normalizeOtlpMetrics(decoded, { tsMs: 0 });
  const fromJson = normalizeOtlpMetrics(payload, { tsMs: 0 });

  assert.equal(fromProto.model, 'M');
  assert.equal(fromProto.gauges['vllm:num_requests_running'], 10);
  assert.equal(fromProto.counters['vllm:generation_tokens_total'], 5000);
  assert.equal(fromProto.target, 'http://h:8000'); // int 型 port 也能还原
  assert.deepEqual(fromProto.gauges, fromJson.gauges);
  assert.deepEqual(fromProto.counters, fromJson.counters);
  assert.equal(fromProto.histograms['vllm:time_to_first_token_seconds'].count, 3);
});

test('Path C 归一结果能直接喂给同一诊断内核', () => {
  // 关键性质：A 和 C 产出同一 InfraMetricSample 形状 → 共用 aggregate/diagnose。
  const snap = normalizeOtlpMetrics(OTLP, { tsMs: 1000 });
  const res = diagnose(aggregate(snap));
  assert.ok(['idle', 'healthy', 'degraded', 'critical'].includes(res.verdict));
  assert.ok(Array.isArray(res.findings));
});

test('A≡C：同一份指标经 Prom 文本 / OTLP 两路归一应数值一致', () => {
  const promText = [
    '# TYPE vllm:num_requests_running gauge',
    'vllm:num_requests_running{model_name="M"} 10',
    '# TYPE vllm:generation_tokens_total counter',
    'vllm:generation_tokens_total{model_name="M"} 5000',
    '# TYPE vllm:time_to_first_token_seconds histogram',
    'vllm:time_to_first_token_seconds_bucket{model_name="M",le="0.5"} 1',
    'vllm:time_to_first_token_seconds_bucket{model_name="M",le="1.0"} 3',
    'vllm:time_to_first_token_seconds_bucket{model_name="M",le="+Inf"} 3',
    'vllm:time_to_first_token_seconds_sum{model_name="M"} 2.0',
    'vllm:time_to_first_token_seconds_count{model_name="M"} 3',
  ].join('\n');

  const attr = [{ key: 'model_name', value: { stringValue: 'M' } }];
  const otlp: OtlpMetricsPayload = {
    resourceMetrics: [{
      scopeMetrics: [{
        metrics: [
          { name: 'vllm:num_requests_running', gauge: { dataPoints: [{ attributes: attr, asDouble: 10 }] } },
          { name: 'vllm:generation_tokens_total', sum: { dataPoints: [{ attributes: attr, asDouble: 5000 }] } },
          {
            name: 'vllm:time_to_first_token_seconds',
            histogram: {
              dataPoints: [{
                attributes: attr,
                explicitBounds: [0.5, 1.0],
                bucketCounts: [1, 2, 0], // 每桶计数；累计 → 1,3,3
                sum: 2.0,
                count: 3,
              }],
            },
          },
        ],
      }],
    }],
  };

  const a = normalize(parsePromText(promText), { tsMs: 0 });
  const c = normalizeOtlpMetrics(otlp, { tsMs: 0 });

  assert.equal(a.model, c.model);
  assert.deepEqual(a.gauges, c.gauges);
  assert.deepEqual(a.counters, c.counters);
  // 直方图分位数两路一致
  const h = 'vllm:time_to_first_token_seconds';
  assert.equal(a.histograms[h].count, c.histograms[h].count);
  assert.equal(a.histograms[h].sum, c.histograms[h].sum);
  for (const q of [0.5, 0.95, 0.99]) {
    assert.equal(histQuantile(a.histograms[h], q), histQuantile(c.histograms[h], q), `p${q} 不一致`);
  }
});
