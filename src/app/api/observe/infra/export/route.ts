// 把一个 infra 源在指定时间段的时序数据导出，供用户拿去做离线分析 / 喂给大模型。
// 参数与 /api/observe/infra/history 对齐（sourceId / model / from / to），另加：
//   · format=csv|md   —— md 给大模型直读（口径说明能写成正经章节），csv 给 Excel/pandas
//   · metrics=a,b,c   —— 按面板分组挑指标，缺省全选
// 与画图路径的关键差别：不降采样，一行一个原始采样点。画图那条路的降采样对不同列
// 用了不同聚合（峰值 max、吞吐 avg），混进一张表会把跨列相关性分析带偏。

import { NextResponse } from 'next/server';

import { exportFileName, parseGroups, toCsv, toMarkdown, type ExportContext } from '@/lib/infra/export';
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
  const format = searchParams.get('format') === 'md' ? 'md' : 'csv';
  const groups = parseGroups(searchParams.get('metrics'));

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
  const rows = buildExportRows(samples, rateWindowMs);
  // BOM：说明文案是中文，没有 BOM 的话 Excel 双击打开 CSV 会显示成乱码。
  // pandas/大模型侧不受影响（pandas 认 utf-8-sig，读文本更是无所谓）。
  const body = format === 'md'
    ? toMarkdown(rows, ctx, groups)
    : `﻿${toCsv(rows, ctx, groups)}`;

  return new NextResponse(body, {
    headers: {
      'Content-Type': format === 'md' ? 'text/markdown; charset=utf-8' : 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${exportFileName(ctx, format)}"`,
      'Cache-Control': 'no-store',
    },
  });
}
