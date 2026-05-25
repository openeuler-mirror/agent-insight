import { NextResponse } from 'next/server';
import {
  findLatestTriggerEvalSet,
  findTriggerEvalSetById,
  listTriggerEvalSetVersions,
  replaceTriggerEvalItemsById,
  deleteTriggerEvalSet,
  ensureTriggerEvalSet,
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
 * 编辑器保存调这个——**只能在 latest 版本上原地改**。body: { user, versionId?, description?, items }
 * - 不传 versionId：作用于 latest（兼容旧前端）；如果没有任何版本会建一个 v1（manual）。
 * - 传 versionId：必须等于 latest 的 id，否则 409。
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

    // 兜底建 v1 + 拿到 latest
    const latest = await ensureTriggerEvalSet({
      user,
      skillName: decodedSkillName,
      description: body.description !== undefined ? String(body.description || '') : undefined,
    });

    if (targetVersionId && targetVersionId !== latest.id) {
      return NextResponse.json(
        { error: 'only the latest version can be edited; switch to latest or create a new version' },
        { status: 409 },
      );
    }

    const updated = await replaceTriggerEvalItemsById(latest.id, items);
    if (!updated) {
      return NextResponse.json({ error: 'failed to update items' }, { status: 500 });
    }
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
