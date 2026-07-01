// 实测接口：对一个 vLLM 源即时拉取 + 诊断，返回 verdict / SLIs / findings。
// 给 infra 面板用；持久化时序留作后续，这里走「即时拉取」最短路。

import { NextResponse } from 'next/server';

import { diagnoseTarget } from '@/lib/infra/probe';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const target = searchParams.get('target');
    if (!target) {
      return NextResponse.json({ error: 'Missing target (e.g. ?target=http://host:8000)' }, { status: 400 });
    }
    const samples = Number(searchParams.get('samples') || 1);
    const intervalMs = Number(searchParams.get('intervalMs') || 2000);
    const model = searchParams.get('model') || undefined;

    const summary = await diagnoseTarget(target, { samples, intervalMs, model });
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ status: 'error', message }, { status: 502 });
  }
}
