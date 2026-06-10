import { NextResponse } from 'next/server';
import {
  createTriggerEvalSetVersion,
  findFreshDraftingSet,
  deletePlaceholderDraftingSets,
  markDraftingSetReady,
  markDraftingSetFailed,
} from '@/server/skill_trigger_eval_storage';
import { draftTriggerEvalSet } from '@/lib/engine/skill-generation/evaluator/runners/draftTriggerEvalSet';

export const dynamic = 'force-dynamic';

/**
 * 后台跑一次 LLM 起草：执行 runner → 成功就把占位版本填上 items 并 flip 成 ready；
 * 失败就把它 flip 成 failed（原因落 versionNote）。由 POST 以 fire-and-forget 方式调起，
 * **绝不向外抛**——任何失败都落进占位版本的 status=failed，前端轮询 /trigger 时即可看到。
 * 起草耗时 5-15s，同步 await 会让请求一直挂着、用户一刷新就以为没在跑又点一次重复起草；
 * 改成后台跑后占位版本落在 DB 里，用户随时离开 / 回来都能接着看「起草中」。
 */
async function executeDraft(args: {
  setId: string;
  user: string;
  skillName: string;
  modelConfigId?: string;
  versionNote: string | null;
}): Promise<void> {
  try {
    // 新版本是干净的 LLM 输出——不再跟旧版本合并 user-edited 条目（这种合并语义跟
    // 「每次起草建一个版本」相互冲突；用户想沿用旧条目就回旧版本看 / 复制即可）。
    const { items, draftedFromSkillHash } = await draftTriggerEvalSet({
      user: args.user,
      skillName: args.skillName,
      modelConfigId: args.modelConfigId,
      replaceUserEdited: true,
    });
    const ready = await markDraftingSetReady(args.setId, {
      items,
      draftedFromSkillHash,
      versionNote: args.versionNote,
    });
    if (!ready) {
      // 占位版本已被并发清理（多半用户期间又点了一次起草，旧占位被 deletePlaceholderDraftingSets 删了）。
      // 不是错误，安静返回——新的那次起草会自己 finalize。
      console.warn('[trigger-eval/draft] placeholder gone before finalize, skipping', {
        setId: args.setId,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[trigger-eval/draft] background draft failed:', msg);
    try {
      await markDraftingSetFailed(args.setId, msg);
    } catch (finErr) {
      console.error('[trigger-eval/draft] failed to mark placeholder failed:', finErr);
    }
  }
}

/**
 * POST /api/skill-eval/trigger/<skillName>/draft
 *
 * 触发 LLM 起草，**结果落到一个新版本**（不再覆盖旧版本）。**异步**：先建一个
 * status=drafting 的占位版本立刻 200 返回，LLM 在后台 fire-and-forget 跑（典型 5-15s），
 * 跑完就地 flip 成 ready。前端据返回的占位 set 轮询 /trigger 拿最终结果，刷新页面也不丢状态。
 *
 * body: { user, modelConfigId? }
 *   - modelConfigId: 用户在 /modelconfig 注册的 ModelConfig.id；不传则用 active config，
 *     仍没有就退回环境变量兜底。
 *
 * 返回：
 *   - 200 { success, set }（set 即 status=drafting 的占位版本）
 *   - 409 { error, set } —— 同一 skill 已有一次起草在跑（防重入），set 是那条占位版本
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

    // 1. 防重入：同一 skill 已有一条新鲜的 drafting 占位就别再起一个。把它连同 409 回给前端——
    //    前端据此关掉「起草中」的二次点击、继续轮询同一条占位的进度即可。
    const existing = await findFreshDraftingSet(user, decodedSkillName);
    if (existing) {
      return NextResponse.json(
        { error: '该 Skill 已有一次 AI 起草正在进行，等它结束再发起', set: existing },
        { status: 409 },
      );
    }

    // 2. 清掉上次失败的 failed 占位 + 僵尸 drafting（确保版本号最大位是即将新建的占位）。
    await deletePlaceholderDraftingSets(user, decodedSkillName);

    // 3. 建占位版本（status=drafting，items 暂空），立刻返回。
    const versionNote = modelConfigId ? `model=${modelConfigId}` : null;
    const placeholder = await createTriggerEvalSetVersion({
      user,
      skillName: decodedSkillName,
      items: [],
      versionSource: 'llm-draft',
      versionNote,
      status: 'drafting',
    });

    // 4. 后台跑起草，不 await——app 是长驻 node 进程（npm start），响应返回后后台 promise 会继续跑到 flip。
    void executeDraft({
      setId: placeholder.id,
      user,
      skillName: decodedSkillName,
      modelConfigId,
      versionNote,
    }).catch(err => {
      console.error('[trigger-eval/draft] background draft crashed:', err);
    });

    return NextResponse.json({ success: true, set: placeholder });
  } catch (error) {
    console.error('skill-eval/trigger/draft POST error:', error);
    const msg = error instanceof Error ? error.message : 'failed to draft trigger eval set';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
