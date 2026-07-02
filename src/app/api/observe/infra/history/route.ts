// 单个源的历史趋势：取最近 limit 条采样 → 压成时序点序列，供前端画 Recharts 折线。

import { NextResponse } from 'next/server';

import { buildHistorySeries } from '@/lib/infra/history';
import { latestSamples, querySamples } from '@/lib/infra/store';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const sourceId = searchParams.get('sourceId');
  if (!sourceId) {
    return NextResponse.json({ error: 'Missing sourceId' }, { status: 400 });
  }
  const model = searchParams.get('model') || undefined;
  const fromRaw = searchParams.get('from');
  const toRaw = searchParams.get('to');
  // 服务端降采样目标点数：超过就按时间桶合并，前端无论选多大范围都只拿恒定量级的点（默认 500）。
  // 0 = 关闭降采样（取原始全量）。小范围本就 <500 点 → 无影响；24h 这类大范围才会被压。
  const maxPoints = Math.min(2000, Math.max(0, Number(searchParams.get('maxPoints') || 500)));

  let samples;
  if (fromRaw) {
    // 指定时间段：[from, to]（to 缺省=现在）
    const from = Number(fromRaw);
    const to = toRaw ? Number(toRaw) : Date.now();
    samples = await querySamples(sourceId, from, to, model);
  } else {
    // 默认：最近 limit 条
    const limit = Math.min(5000, Math.max(2, Number(searchParams.get('limit') || 200)));
    samples = await latestSamples(sourceId, limit, model);
  }
  return NextResponse.json({ points: buildHistorySeries(samples, maxPoints), count: samples.length });
}
