// InfraMetricSample / InfraSource 的存取层。gauges/counters/histograms 以 JSON 落库。
// 序列化/反序列化是纯函数（单测覆盖）；DB 包装薄封装 prismaRaw。

import { prismaRaw } from '@/lib/storage/prisma';
import type { Histogram, InfraMetricSample } from '@/lib/infra/types';

export interface InfraSourceInput {
  endpoint: string;
  scrapeUrl: string;
  kind?: 'pull' | 'push';
  model?: string | null;
  hardwareName?: string | null;
  memBandwidthGBs?: number | null;
  scrapeIntervalMs?: number;
}

export interface InfraSampleRow {
  sourceId: string;
  tsMs: number;
  via: string;
  model: string | null;
  gauges: string;
  counters: string;
  histograms: string;
  waitingByReason: string | null;
}

/** InfraMetricSample → 可落库的行（JSON 编码各分区）。 */
export function serializeSample(sourceId: string, s: InfraMetricSample): InfraSampleRow {
  return {
    sourceId,
    tsMs: s.tsMs,
    via: s.source.includes('push') ? 'push' : 'pull',
    model: s.model,
    gauges: JSON.stringify(s.gauges),
    counters: JSON.stringify(s.counters),
    histograms: JSON.stringify(s.histograms),
    waitingByReason: s.waitingByReason ? JSON.stringify(s.waitingByReason) : null,
  };
}

/** 落库行 → InfraMetricSample（与 serialize 互逆）。 */
export function deserializeRow(row: {
  tsMs: number;
  model: string | null;
  gauges: string;
  counters: string;
  histograms: string;
  waitingByReason: string | null;
  source?: { endpoint?: string } | null;
}): InfraMetricSample {
  return {
    tsMs: row.tsMs,
    source: 'db',
    target: row.source?.endpoint ?? '',
    model: row.model,
    gauges: JSON.parse(row.gauges) as Record<string, number>,
    counters: JSON.parse(row.counters) as Record<string, number>,
    histograms: JSON.parse(row.histograms) as Record<string, Histogram>,
    waitingByReason: row.waitingByReason ? (JSON.parse(row.waitingByReason) as Record<string, number>) : {},
  };
}

/** 按 endpoint upsert 一个 infra 源。 */
export async function ensureSource(input: InfraSourceInput) {
  const data = {
    scrapeUrl: input.scrapeUrl,
    kind: input.kind ?? 'pull',
    model: input.model ?? null,
    hardwareName: input.hardwareName ?? null,
    memBandwidthGBs: input.memBandwidthGBs ?? null,
    scrapeIntervalMs: input.scrapeIntervalMs ?? 1000,
  };
  return prismaRaw.infraSource.upsert({
    where: { endpoint: input.endpoint },
    update: data,
    create: { endpoint: input.endpoint, ...data },
  });
}

/** 落一条采样。 */
export async function saveSample(sourceId: string, s: InfraMetricSample): Promise<void> {
  await prismaRaw.infraMetricSample.create({ data: serializeSample(sourceId, s) });
}

/** 取一个源最近 n 条采样（按时间升序返回，便于算 rate）。可按 model 过滤。 */
export async function latestSamples(sourceId: string, n = 5, model?: string): Promise<InfraMetricSample[]> {
  const rows = await prismaRaw.infraMetricSample.findMany({
    where: { sourceId, ...(model ? { model } : {}) },
    orderBy: { tsMs: 'desc' },
    take: n,
    include: { source: { select: { endpoint: true } } },
  });
  return rows.reverse().map(deserializeRow);
}

/** 查一个源在 [fromMs, toMs] 窗口内的采样（升序）。可按 model 过滤。 */
export async function querySamples(sourceId: string, fromMs: number, toMs: number, model?: string): Promise<InfraMetricSample[]> {
  const rows = await prismaRaw.infraMetricSample.findMany({
    where: { sourceId, tsMs: { gte: fromMs, lte: toMs }, ...(model ? { model } : {}) },
    orderBy: { tsMs: 'asc' },
    include: { source: { select: { endpoint: true } } },
  });
  return rows.map(deserializeRow);
}

/** 该源最近一条「推送」样本的时刻（没有则 null）。用于检测 collector 是否在推。 */
export async function lastPushAtMs(sourceId: string): Promise<number | null> {
  const row = await prismaRaw.infraMetricSample.findFirst({
    where: { sourceId, via: 'push' },
    orderBy: { tsMs: 'desc' },
    select: { tsMs: true },
  });
  return row?.tsMs ?? null;
}

/** 一个源出现过的所有 model（按最近采样去重）。 */
export async function listSourceModels(sourceId: string, lookback = 200): Promise<string[]> {
  const rows = await prismaRaw.infraMetricSample.findMany({
    where: { sourceId },
    orderBy: { tsMs: 'desc' },
    take: lookback,
    select: { model: true },
  });
  const seen = new Set<string>();
  for (const r of rows) if (r.model) seen.add(r.model);
  return [...seen];
}
