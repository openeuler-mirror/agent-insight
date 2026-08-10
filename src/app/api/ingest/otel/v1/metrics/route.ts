// Path C 接收端：OTel Collector 把 vLLM 指标经 OTLP 推到这里。
// 归一到与 Path A 相同的 InfraMetricSample，并跑同一诊断内核给出即时 verdict。
// CodeAgent metrics 在解码后、归一化和持久化前按 resource 分区丢弃。

import { gunzipSync } from 'node:zlib';
import { NextResponse } from 'next/server';
import { aggregate, diagnose } from '@/lib/infra/diagnose';
import { ensureSource, saveSample } from '@/lib/infra/store';
import { partitionCodeAgentOtlpPayload } from '@/lib/ingest/codeagent-otel/detect';
import { normalizeEndpoint } from '@/lib/ingest/vllm/scrape';
import { normalizeOtlpMetrics } from '@/lib/ingest/vllm/otlp-metrics';
import type { OtlpMetricsPayload } from '@/lib/ingest/vllm/otlp-metrics';
import { decodeOtlpMetricsProto } from '@/lib/ingest/vllm/otlp-proto';
import { prismaRaw } from '@/lib/storage/prisma';

export async function POST(req: Request) {
  try {
    const contentType = req.headers.get('content-type') || '';
    const contentEncoding = req.headers.get('content-encoding') || '';

    // 原始字节；otlphttp exporter 默认 gzip 压缩，需先解压（魔数 1f 8b）。
    let raw = new Uint8Array(await req.arrayBuffer());
    if (contentEncoding.includes('gzip') || (raw[0] === 0x1f && raw[1] === 0x8b)) {
      raw = new Uint8Array(gunzipSync(raw));
    }

    let body: OtlpMetricsPayload;
    if (contentType.includes('application/json')) {
      body = JSON.parse(Buffer.from(raw).toString('utf8'));
    } else {
      // OTLP/HTTP 默认 application/x-protobuf；缺省/其它也按 protobuf 尝试解码。
      try {
        body = decodeOtlpMetricsProto(raw);
      } catch (decodeErr) {
        console.warn('[vLLM OTel Metrics] protobuf decode failed:', decodeErr instanceof Error ? decodeErr.message : decodeErr);
        return NextResponse.json(
          { error: 'Body 既非合法 OTLP/JSON 也非合法 OTLP/protobuf' },
          { status: 415 },
        );
      }
    }

    const codeAgentPartition = partitionCodeAgentOtlpPayload(body, 'metrics');
    if (codeAgentPartition.codeAgentResourceCount > 0 && !codeAgentPartition.hasRemainingResources) {
      return NextResponse.json({
        status: 'accepted',
        framework: 'codeagent',
        ignored: true,
        ignoredResourceMetrics: codeAgentPartition.codeAgentResourceCount,
      });
    }
    body = codeAgentPartition.remainingBody;

    const sample = normalizeOtlpMetrics(body, { tsMs: Date.now() });
    const diag = diagnose(aggregate(sample));

    // 持久化（best-effort）：优先挂到推送携带的真实源；DB 故障不影响 ack。
    let attachedTo: string | null = null;
    try {
      let endpoint: string | null = null;
      if (sample.target && sample.target.startsWith('http')) {
        try { endpoint = normalizeEndpoint(sample.target); } catch { endpoint = null; }
      }
      let src = endpoint ? await prismaRaw.infraSource.findUnique({ where: { endpoint } }) : null;
      if (!src) {
        // 推送带真实地址但未注册时自动登记；否则按 model 兜底。
        const fallback = endpoint ?? `push://${sample.model ?? 'unknown'}`;
        src = await ensureSource({ endpoint: fallback, scrapeUrl: '', kind: 'push', model: sample.model });
      }
      await saveSample(src.id, sample);
      attachedTo = src.endpoint;
    } catch (persistErr) {
      console.warn('[vLLM OTel Metrics] persist skipped:', persistErr instanceof Error ? persistErr.message : persistErr);
    }

    return NextResponse.json({
      status: 'accepted',
      model: sample.model,
      endpoint: sample.target,
      attachedTo,
      metrics: {
        gauges: Object.keys(sample.gauges).length,
        counters: Object.keys(sample.counters).length,
        histograms: Object.keys(sample.histograms).length,
      },
      verdict: diag.verdict,
      bottleneck: diag.bottleneck,
      ...(codeAgentPartition.codeAgentResourceCount > 0 ? {
        ignored: { codeagent: { resourceMetrics: codeAgentPartition.codeAgentResourceCount } },
      } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[vLLM OTel Metrics] Handler Error:', message);
    return NextResponse.json({ status: 'error', message }, { status: 500 });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-witty-api-key, baggage, traceparent, tracestate',
    },
  });
}
