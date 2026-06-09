import { NextResponse } from 'next/server';
import { findTriggerEvalRun, markRunCancelled } from '@/server/skill_trigger_eval_storage';
import { abortTriggerEvalRun } from '@/server/trigger_eval_run_registry';

export const dynamic = 'force-dynamic';

/**
 * POST /api/skill-eval/trigger/<skillName>/run/<runId>/cancel
 * body: { user }
 *
 * 终止一次正在跑的触发评测：
 *   1) abort 内存登记表里的 AbortController —— 让后台 runner 停掉 in-flight 的模型调用、不再领新任务；
 *   2) DB 里把这条 run **条件性**置 cancelled（只在它仍是 running 时）—— 兼顾「即时反馈」+「进程重启后
 *      controller 已丢失的僵尸 run 也能终止」。
 *
 * 返回 { success, aborted, run }：
 *   - aborted: 进程内是否真的找到了 controller（false 多半是重启后的僵尸，走 DB 兜底）；
 *   - run: 置 cancelled 后的记录；若它其实已 done/failed（终止请求和后台 finalize 擦肩而过），原样返回。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ skillName: string; runId: string }> },
) {
  try {
    const { skillName, runId } = await params;
    const body = await request.json().catch(() => ({}));
    const user = String(body.user || '').trim();
    if (!user) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }

    const existing = await findTriggerEvalRun(user, runId);
    if (!existing) {
      return NextResponse.json({ error: 'run not found' }, { status: 404 });
    }
    // 防越权：run 的 skillName 必须与路径一致
    const decodedSkillName = decodeURIComponent(skillName);
    if (existing.skillName !== decodedSkillName) {
      return NextResponse.json({ error: 'run does not belong to this skill' }, { status: 404 });
    }

    // 1) 通知后台 runner 停（有 controller 才有效；重启后没有，靠下面的 DB 兜底）
    const aborted = abortTriggerEvalRun(runId);
    // 2) DB 置 cancelled（只动仍是 running 的那条）
    const cancelled = await markRunCancelled(runId, user);

    return NextResponse.json({
      success: true,
      aborted,
      run: cancelled ?? existing,
    });
  } catch (error) {
    console.error('skill-eval/trigger/run/cancel POST error:', error);
    const msg = error instanceof Error ? error.message : 'failed to cancel run';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
