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

import { NextResponse } from 'next/server';
import { listTriggerEvalRuns, findLatestDoneRun } from '@/server/skill_trigger_eval_storage';

export const dynamic = 'force-dynamic';

/**
 * GET /api/skill-eval/trigger/<skillName>/runs?user=<u>&skillVersion=<v>&limit=<n>&latestOnly=true
 *
 * latestOnly=true 时只返回最新一条 done 状态的 run（供分析页"触发分析"卡显示分数用）。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ skillName: string }> },
) {
  try {
    const { skillName } = await params;
    const { searchParams } = new URL(request.url);
    const user = (searchParams.get('user') || '').trim();
    if (!user) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }
    const decodedSkillName = decodeURIComponent(skillName);
    const skillVersionRaw = searchParams.get('skillVersion');
    const skillVersion = skillVersionRaw ? Number(skillVersionRaw) : undefined;
    const limitRaw = searchParams.get('limit');
    const limit = limitRaw ? Math.max(1, Math.min(200, Number(limitRaw))) : 50;
    const latestOnly = searchParams.get('latestOnly') === 'true';

    if (latestOnly) {
      const run = await findLatestDoneRun(user, decodedSkillName, skillVersion);
      return NextResponse.json({ run });
    }
    const runs = await listTriggerEvalRuns(user, decodedSkillName, { skillVersion, limit });
    return NextResponse.json({ runs });
  } catch (error) {
    console.error('skill-eval/trigger/runs GET error:', error);
    return NextResponse.json({ error: 'failed to load runs' }, { status: 500 });
  }
}
