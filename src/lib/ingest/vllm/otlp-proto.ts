// OTLP/HTTP 默认用 protobuf 传输（collector 的 otlphttp exporter 常忽略 encoding:json 仍发 protobuf）。
// 这里用 protobufjs + 最小 OTLP metrics schema 解码 ExportMetricsServiceRequest，产出与 JSON 路径
// 同形的对象交给 normalizeOtlpMetrics。字段号取自 opentelemetry-proto v1（只声明本服务消费的字段）。

import protobuf from 'protobufjs';

import type { OtlpMetricsPayload } from '@/lib/ingest/vllm/otlp-metrics';

const PROTO = `
syntax = "proto3";
package otlpmin;
message MetricsData { repeated ResourceMetrics resource_metrics = 1; }
message ResourceMetrics { Resource resource = 1; repeated ScopeMetrics scope_metrics = 2; }
message Resource { repeated KeyValue attributes = 1; }
message ScopeMetrics { repeated Metric metrics = 2; }
message Metric { string name = 1; Gauge gauge = 5; Sum sum = 7; Histogram histogram = 9; }
message Gauge { repeated NumberDataPoint data_points = 1; }
message Sum { repeated NumberDataPoint data_points = 1; }
message Histogram { repeated HistogramDataPoint data_points = 1; }
message NumberDataPoint {
  repeated KeyValue attributes = 7;
  double as_double = 4;
  sfixed64 as_int = 6;
}
message HistogramDataPoint {
  repeated KeyValue attributes = 9;
  fixed64 count = 4;
  double sum = 5;
  repeated fixed64 bucket_counts = 6;
  repeated double explicit_bounds = 7;
}
message KeyValue { string key = 1; AnyValue value = 2; }
message AnyValue {
  string string_value = 1;
  int64 int_value = 3;
  double double_value = 4;
}
`;

const root = protobuf.parse(PROTO).root;
const MetricsData = root.lookupType('otlpmin.MetricsData');

/** OTLP protobuf（ExportMetricsServiceRequest / MetricsData）→ 与 JSON 路径同形的对象。 */
export function decodeOtlpMetricsProto(buf: Uint8Array): OtlpMetricsPayload {
  const msg = MetricsData.decode(buf);
  // longs:Number 把 fixed64/sfixed64 转成 JS number；keepCase 默认 false → camelCase 字段名。
  return MetricsData.toObject(msg, { longs: Number, defaults: false, arrays: true }) as unknown as OtlpMetricsPayload;
}

/** 给编码（测试/工具用）。 */
export function encodeOtlpMetricsProto(payload: OtlpMetricsPayload): Uint8Array {
  const err = MetricsData.verify(payload as unknown as Record<string, unknown>);
  if (err) throw new Error(`OTLP encode verify failed: ${err}`);
  return MetricsData.encode(MetricsData.fromObject(payload as unknown as Record<string, unknown>)).finish();
}
