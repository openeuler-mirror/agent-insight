// 把一个 infra 源在指定时间段的时序数据导出成 CSV，供用户拿去做离线分析 / 喂给大模型。
// 参数与 /api/observe/infra/history 对齐（sourceId / model / from / to），差别是：
//   · 不降采样：一行一个原始采样点。画图那条路的降采样对不同列用了不同聚合
//     （峰值 max、吞吐 avg），混进一张表会把跨列分析带偏，见 history.buildExportRows。
//   · 多给 p50/p99，并附裸累计计数器，便于独立复核与算区间总量。

import { NextResponse } from 'next/server';

import { csvFileName, toCsv, type ExportContext } from '@/lib/infra/export-csv';
import { buildExportRows, DEFAULT_RATE_WINDOW_MS } from '@/lib/infra/history';
import { querySamples } from '@/lib/infra/store';
import { prismaRaw } from '@/lib/storage/prisma';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const sourceId = searchParams.get('sourceId');
  if (!sourceId) return NextResponse.json({ error: 'Missing sourceId' }, { status: 400 });

  const source = await prismaRaw.infraSource.findUnique({ where: { id: sourceId } });
  if (!source) return NextResponse.json({ error: 'Source not found' }, { status: 404 });

  const model = searchParams.get('model') || undefined;
  const toMs = Number(searchParams.get('to') || Date.now());
  const fromRaw = searchParams.get('from');
  // from 缺省时给最近 15 分钟，与页面默认时间段一致
  const fromMs = fromRaw ? Number(fromRaw) : toMs - 15 * 60_000;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    return NextResponse.json({ error: 'Invalid time range' }, { status: 400 });
  }
  const rateWindowMs = Math.min(300_000, Math.max(1000, Number(searchParams.get('rateWindowMs') || DEFAULT_RATE_WINDOW_MS)));

  const samples = await querySamples(sourceId, fromMs, toMs, model);
  const ctx: ExportContext = {
    endpoint: source.endpoint,
    model: model ?? source.model ?? null,
    hardwareName: source.hardwareName ?? null,
    memBandwidthGBs: source.memBandwidthGBs ?? null,
    fromMs,
    toMs,
    rateWindowMs,
    sampleCount: samples.length,
    generatedAtMs: Date.now(),
  };
  // BOM：_readme 列是中文，没有 BOM 的话 Excel 双击打开会显示成乱码。
  // pandas/LLM 侧不受影响（pandas 认 utf-8-sig，读文本更是无所谓）。
  const csv = `﻿${toCsv(buildExportRows(samples, rateWindowMs), ctx)}`;

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csvFileName(ctx)}"`,
      'Cache-Control': 'no-store',
    },
  });
}
