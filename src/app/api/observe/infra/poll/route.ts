// 手动触发一轮 Path A 拉取（也可由定时器调用 pollOnce）。

import { NextResponse } from 'next/server';

import { pollOnce } from '@/lib/infra/poller';

export const dynamic = 'force-dynamic';

export async function POST() {
  const result = await pollOnce();
  return NextResponse.json(result);
}
