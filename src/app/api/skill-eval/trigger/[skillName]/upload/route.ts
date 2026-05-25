import { NextResponse } from 'next/server';
import {
  createTriggerEvalSetVersion,
  normalizeItems,
  type TriggerItem,
} from '@/server/skill_trigger_eval_storage';

export const dynamic = 'force-dynamic';

/**
 * POST /api/skill-eval/trigger/<skillName>/upload
 *
 * 用户上传一份数据集 → **新建一个版本**。前端先把文件读成 JSON 数组再 POST，本路由
 * 不直接吃 multipart——避免大文件解析负担，也方便前端做基础校验。
 *
 * body: {
 *   user: string;
 *   items: Array<{ query: string; shouldTrigger: boolean; rationale?: string }>;
 *   note?: string;          // 可选备注，常用是原文件名
 * }
 *
 * 返回：{ success, set }（set = 新建的最新版本）
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ skillName: string }> },
) {
  try {
    const { skillName } = await params;
    const body = await request.json().catch(() => ({}));
    const user = String(body.user || '').trim();
    if (!user) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }
    if (!Array.isArray(body.items)) {
      return NextResponse.json({ error: 'items must be an array' }, { status: 400 });
    }
    // 上传来源的 source 一律标记 'user-added'（既不是 LLM 起草也不是历史轨迹）
    const rawItems = (body.items as unknown[]).map((it: unknown) => {
      const obj = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>;
      return { ...obj, source: 'user-added' };
    });
    const items: TriggerItem[] = normalizeItems(rawItems);
    if (items.length === 0) {
      return NextResponse.json({ error: 'no valid items in upload' }, { status: 400 });
    }
    const note = body.note ? String(body.note).slice(0, 200) : null;

    const set = await createTriggerEvalSetVersion({
      user,
      skillName: decodeURIComponent(skillName),
      items,
      versionSource: 'user-upload',
      versionNote: note,
      status: 'ready',
    });
    return NextResponse.json({ success: true, set });
  } catch (error) {
    console.error('skill-eval/trigger/upload POST error:', error);
    const msg = error instanceof Error ? error.message : 'failed to upload trigger eval set';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
