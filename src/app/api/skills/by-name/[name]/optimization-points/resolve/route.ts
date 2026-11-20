import {withCoreControlRoute} from '@/lib/storage-core/control-route';
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

/**
 * PATCH /api/skills/by-name/[name]/optimization-points/resolve
 * body: { user, ids: string[], threadId?: string }
 *
 * 把指定 SkillIssue.id 列表的 resolvedAt 置为当前时间 + 标记 resolvedRunId=threadId。
 * skill-opt 完成一轮优化后回调，避免下次列表里再出现同一 issue。
 *
 * 写在 SkillIssue（不是已废弃的 SkillOptimizationPoint）。双保险：
 *   - user 必须匹配
 *   - path 上的 skillName 必须等于 SkillIssue 关联 Skill 的 name
 */

import { NextRequest, NextResponse } from 'next/server';
import { prismaRaw } from '@/lib/storage/prisma';
import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {handleCoreIssueResolution} from '@/lib/storage-core/issue-resolution-route';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  return withCoreControlRoute(req,async()=>{
  return handleCoreIssueResolution(req,(await ctx.params).name);

  },["write"]);
}
