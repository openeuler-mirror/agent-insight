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
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import {
  createTriggerEvalSetVersion,
  findLatestTriggerEvalSet,
  findTriggerEvalSetById,
  listTriggerEvalSetVersions,
  replaceTriggerEvalItemsById,
  deleteTriggerEvalSet,
  normalizeItems,
  type TriggerItem,
} from '@/server/skill_trigger_eval_storage';

export const dynamic = 'force-dynamic';

/**
 * GET /api/skill-eval/trigger/<skillName>?user=<u>&versionId=<id>?
 *
 * - 不传 versionId：返回 latest set。
 * - 传 versionId：返回那一个版本（必须属于同 user 且同 skillName，否则当无）。
 *
 * 始终返回 `versions` 列表（version desc）；前端用它渲染「历史数据集」面板。
 * 不存在任何版本时 set=null、versions=[]，前端能区分「未配置」。
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
    const versionId = (searchParams.get('versionId') || '').trim() || null;

    const versions = await listTriggerEvalSetVersions(user, decodedSkillName);

    let set = null;
    if (versionId) {
      const found = await findTriggerEvalSetById(versionId);
      // 防越权：versionId 必须属于同 user + 同 skillName
      if (found && found.user === user && found.skillName === decodedSkillName) {
        set = found;
      } else {
        set = await findLatestTriggerEvalSet(user, decodedSkillName);
      }
    } else {
      set = await findLatestTriggerEvalSet(user, decodedSkillName);
    }
    return NextResponse.json({ set, versions });
  } catch (error) {
    console.error('skill-eval/trigger GET error:', error);
    return NextResponse.json({ error: 'failed to load trigger eval set' }, { status: 500 });
  }
}

/**
 * POST /api/skill-eval/trigger/<skillName>
 *
 * 编辑器保存调这个——**只能在最新 ready 版本上原地改**。body: { user, versionId?, description?, items }
 * - drafting/failed 占位行不是保存目标：没有任何 ready 版本时新建一个 manual ready 版本。
 *   AI 起草失败会留下 failed 占位顶在 latest 位，旧「等于 latest」判断会让前端
 *   正在编辑的 ready 版本恒 409，手工编辑永远存不进去。
 * - 传 versionId：必须等于最新 ready 的 id，否则 409；无 ready 时忽略它直接新建。
 * - 不传 versionId：作用于最新 ready（兼容旧前端）。
 *
 * 想新建版本：走 /draft 或 /upload；不走这里。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ skillName: string }> },
) {
  try {
    const { skillName } = await params;
    const body = await request.json();
    const user = String(body.user || '').trim();
    if (!user) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }
    const decodedSkillName = decodeURIComponent(skillName);
    const items: TriggerItem[] = normalizeItems(body.items);
    const targetVersionId = body.versionId ? String(body.versionId).trim() : null;

    // 保存目标固定为最新 ready 版本：drafting/failed 占位行不是可编辑目标。
    const versions = await listTriggerEvalSetVersions(user, decodedSkillName);
    const latestReady = versions.find(v => v.status === 'ready') ?? null;

    if (latestReady && targetVersionId && targetVersionId !== latestReady.id) {
      return NextResponse.json(
        { error: 'only the latest ready version can be edited; switch to latest or create a new version' },
        { status: 409 },
      );
    }

    // 没有任何 ready 版本（只有占位或完全为空）→ 新建 manual ready 版本, 绝不写占位行：
    // 占位行会被下一次 AI 起草的 deletePlaceholderDraftingSets 整行删除, 写进去会静默丢手工数据。
    const updated = latestReady
      ? await replaceTriggerEvalItemsById(latestReady.id, items)
      : await createTriggerEvalSetVersion({
          user,
          skillName: decodedSkillName,
          items,
          versionSource: 'manual',
          description: body.description !== undefined ? String(body.description || '') : undefined,
        });
    if (!updated) {
      return NextResponse.json({ error: 'failed to update items' }, { status: 500 });
    }
    recordUsageEvent({ user, featureKey: 'skill-eval', eventKey: 'skill.eval.trigger.save' });

    return NextResponse.json({ success: true, set: updated });
  } catch (error) {
    console.error('skill-eval/trigger POST error:', error);
    return NextResponse.json({ error: 'failed to save trigger eval set' }, { status: 500 });
  }
}

/**
 * DELETE /api/skill-eval/trigger/<skillName>?user=<u>
 *
 * 删除 (user, skillName) 下**所有版本**。
 */
export async function DELETE(
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
    const ok = await deleteTriggerEvalSet(user, decodeURIComponent(skillName));
    if (!ok) {
      return NextResponse.json({ error: 'trigger eval set not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('skill-eval/trigger DELETE error:', error);
    return NextResponse.json({ error: 'failed to delete trigger eval set' }, { status: 500 });
  }
}
