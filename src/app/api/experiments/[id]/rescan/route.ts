/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// 增量重扫：重算配对 → 找新可比配对 → 创建 case + pending 行 + 增量评测。
// 运行中返回 409 互斥；无新配对返回 newPairsCount=0。
import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { rescanComparison } from '@/lib/engine/experiment/comparison-runner';

export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const { username } = await resolveUser(req, body?.user);
    if (!username) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }

    const result = await rescanComparison(id, username);
    return NextResponse.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to rescan';
    // 运行中互斥 → 409
    if (/409|running|互斥/i.test(msg)) {
      return NextResponse.json({ error: 'experiment is running' }, { status: 409 });
    }
    console.error('[Experiment Rescan Error]', error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
