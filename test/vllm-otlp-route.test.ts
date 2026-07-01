import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { POST } from '@/app/api/ingest/otel/v1/metrics/route';
import { encodeOtlpMetricsProto } from '@/lib/ingest/vllm/otlp-proto';
import { prismaRaw } from '@/lib/storage/prisma';

const OTLP_RAW = readFileSync(
  join(import.meta.dirname, 'fixtures', 'vllm-otlp-metrics-sample.json'),
  'utf8',
);

test('Path C 路由：真实 OTLP/JSON 推送 → accepted + verdict', async () => {
  const req = new Request('http://localhost/api/ingest/otel/v1/metrics', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: OTLP_RAW,
  });
  const res = await POST(req);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'accepted');
  assert.equal(body.model, 'Qwen3-Coder-30B-A3B-Instruct-FP8');
  assert.ok(['idle', 'healthy', 'degraded', 'critical'].includes(body.verdict));
  assert.ok(body.metrics.gauges >= 0 && body.metrics.histograms >= 0);
  // 推送带了真实地址 → 自动登记为该地址的 push 源
  assert.equal(body.endpoint, 'http://vllm.test:8000');
  assert.equal(body.attachedTo, 'http://vllm.test:8000');
  // 清理 best-effort 持久化产生的源
  await prismaRaw.infraSource.deleteMany({ where: { endpoint: body.attachedTo } });
});

test('Path C 路由：OTLP/protobuf 推送 → accepted（collector 默认 protobuf）', async () => {
  const attr = [{ key: 'model_name', value: { stringValue: 'M' } }];
  const buf = encodeOtlpMetricsProto({
    resourceMetrics: [{
      resource: { attributes: [
        { key: 'server.address', value: { stringValue: 'proto-host.test' } },
        { key: 'server.port', value: { intValue: 8000 } },
        { key: 'url.scheme', value: { stringValue: 'http' } },
      ] },
      scopeMetrics: [{ metrics: [
        { name: 'vllm:num_requests_running', gauge: { dataPoints: [{ attributes: attr, asDouble: 2 }] } },
      ] }],
    }],
  });
  const req = new Request('http://localhost/api/ingest/otel/v1/metrics', {
    method: 'POST',
    headers: { 'content-type': 'application/x-protobuf' },
    body: buf,
  });
  const res = await POST(req);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'accepted');
  assert.equal(body.model, 'M');
  assert.equal(body.attachedTo, 'http://proto-host.test:8000');
  await prismaRaw.infraSource.deleteMany({ where: { endpoint: 'http://proto-host.test:8000' } });
});

test('Path C 路由：gzip 压缩的 protobuf 推送 → accepted（otlphttp 默认 gzip）', async () => {
  const attr = [{ key: 'model_name', value: { stringValue: 'M' } }];
  const proto = encodeOtlpMetricsProto({
    resourceMetrics: [{
      resource: { attributes: [
        { key: 'server.address', value: { stringValue: 'gz-host.test' } },
        { key: 'server.port', value: { intValue: 8000 } },
      ] },
      scopeMetrics: [{ metrics: [{ name: 'vllm:num_requests_running', gauge: { dataPoints: [{ attributes: attr, asDouble: 3 }] } }] }],
    }],
  });
  const req = new Request('http://localhost/api/ingest/otel/v1/metrics', {
    method: 'POST',
    headers: { 'content-type': 'application/x-protobuf', 'content-encoding': 'gzip' },
    body: gzipSync(Buffer.from(proto)),
  });
  const res = await POST(req);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'accepted');
  assert.equal(body.attachedTo, 'http://gz-host.test:8000');
  await prismaRaw.infraSource.deleteMany({ where: { endpoint: 'http://gz-host.test:8000' } });
});

test('Path C 路由：非法 body → 415', async () => {
  const req = new Request('http://localhost/api/ingest/otel/v1/metrics', {
    method: 'POST',
    headers: { 'content-type': 'application/x-protobuf' },
    body: new Uint8Array([0x00, 0x01, 0x02]),
  });
  const res = await POST(req);
  assert.equal(res.status, 415);
});
