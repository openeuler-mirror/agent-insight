import { NextResponse } from 'next/server';
import { createTriggerEvalSetVersion } from '@/server/skill_trigger_eval_storage';
import { draftTriggerEvalSet } from '@/lib/engine/skill-generation/evaluator/runners/draftTriggerEvalSet';

export const dynamic = 'force-dynamic';

/**
 * POST /api/skill-eval/trigger/<skillName>/draft
 *
 * 触发 LLM 起草，**结果落到一个新版本**（不再覆盖旧版本）。同步调用——典型耗时 5-15s。
 *
 * body: { user, modelConfigId? }
 *   - modelConfigId: 用户在 /modelconfig 注册的 ModelConfig.id；不传则用 active config，
 *     仍没有就退回环境变量兜底。
 *
 * 返回：{ success, set }（set 即新建的最新版本）
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
    const decodedSkillName = decodeURIComponent(skillName);
    const modelConfigId = body.modelConfigId ? String(body.modelConfigId).trim() : undefined;

    // 新版本是干净的 LLM 输出——不再跟旧版本合并 user-edited 条目（这种合并语义
    // 跟「每次起草建一个版本」相互冲突；用户想沿用旧条目就回旧版本看 / 复制即可）。
    const { items, draftedFromSkillHash } = await draftTriggerEvalSet({
      user,
      skillName: decodedSkillName,
      modelConfigId,
      replaceUserEdited: true,
    });

    const set = await createTriggerEvalSetVersion({
      user,
      skillName: decodedSkillName,
      items,
      versionSource: 'llm-draft',
      versionNote: modelConfigId ? `model=${modelConfigId}` : null,
      draftedFromSkillHash,
      status: 'ready',
    });
    return NextResponse.json({ success: true, set });
  } catch (error) {
    console.error('skill-eval/trigger/draft POST error:', error);
    const msg = error instanceof Error ? error.message : 'failed to draft trigger eval set';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
