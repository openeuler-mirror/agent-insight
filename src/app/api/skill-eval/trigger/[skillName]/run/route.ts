import { NextResponse } from 'next/server';
import {
  findLatestTriggerEvalSet,
  findTriggerEvalSetById,
  createTriggerEvalRun,
  finalizeTriggerEvalRun,
} from '@/server/skill_trigger_eval_storage';
import { runTriggerEvalLive } from '@/lib/engine/skill-generation/evaluator/runners/triggerEval';
import { prismaRaw } from '@/lib/storage/prisma';

export const dynamic = 'force-dynamic';

/**
 * POST /api/skill-eval/trigger/<skillName>/run
 *
 * 跑一次 opencode-live 触发评测。同步等评测完成才 200——典型耗时跟 query 数 × runsPerQuery 成正比，
 * 假设 18 条 query × 1 run × 平均 5s/run × concurrency=5 ≈ 18s。前端 spinner + 实时进度即可。
 *
 * body: {
 *   user,
 *   triggerSetId?,         // 跑哪个数据集版本；不传 = latest
 *   skillVersion?,         // 测哪个版本的 SKILL.md；不传 = latest。用户在 v2 分析页点
 *                          // 评测时必须显式传 2，否则 run 会被打成 latest 归档到错的版本下，
 *                          // 且 opencode 会拿 latest 的 SKILL.md 去测——见 issue:trigger-version-mismatch
 *   modelConfigId?, runsPerQuery?, triggerThreshold?, timeoutMs?, concurrency?
 * }
 *
 * 返回：{ success, run }
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

    // 1. 加载触发集（按 triggerSetId 选具体版本；不传则跑 latest）
    const triggerSetId = body.triggerSetId ? String(body.triggerSetId).trim() : null;
    let set = null;
    if (triggerSetId) {
      const found = await findTriggerEvalSetById(triggerSetId);
      // 防越权：必须属于同 user + 同 skillName
      if (found && found.user === user && found.skillName === decodedSkillName) {
        set = found;
      } else {
        return NextResponse.json(
          { error: 'triggerSetId not found for this user/skill' },
          { status: 404 },
        );
      }
    } else {
      set = await findLatestTriggerEvalSet(user, decodedSkillName);
    }
    if (!set) {
      return NextResponse.json({ error: 'trigger eval set not configured' }, { status: 404 });
    }
    if (set.items.length === 0) {
      return NextResponse.json({ error: 'trigger eval set has no items' }, { status: 400 });
    }

    // 2. 决定本次跑用哪个 skill 版本：
    //    - body 传了 skillVersion → 用它（须存在）
    //    - 没传 → 用 latest（向后兼容旧调用方）
    //    版本号同时决定：① run 记录里 skillVersion 字段（影响"哪个版本看得到这条 run"）
    //                   ② runner 物化到 .opencode/skills/<name>/SKILL.md 时取哪个版本的 content
    //    两者必须用同一个值，否则会出现「分数显示在 v2、但 v2 测的其实是 v3 的 SKILL.md」的对不上 bug。
    const skill = await prismaRaw.skill.findFirst({
      where: { user, name: decodedSkillName },
      include: {
        versions: { orderBy: { version: 'desc' } },
      },
    });
    if (!skill || skill.versions.length === 0) {
      return NextResponse.json({ error: 'skill not found or has no versions' }, { status: 404 });
    }
    const requestedVersionRaw = body.skillVersion;
    let targetSkillVersion: number;
    if (requestedVersionRaw === undefined || requestedVersionRaw === null) {
      targetSkillVersion = skill.versions[0].version;
    } else {
      const n = Number(requestedVersionRaw);
      if (!Number.isFinite(n) || !skill.versions.some(v => v.version === n)) {
        return NextResponse.json(
          { error: `skillVersion ${requestedVersionRaw} not found for ${decodedSkillName}` },
          { status: 404 },
        );
      }
      targetSkillVersion = n;
    }

    // 3. 参数化
    const runsPerQuery = Math.max(1, Math.min(10, Number(body.runsPerQuery ?? 1)));
    const triggerThreshold = Math.max(0, Math.min(1, Number(body.triggerThreshold ?? 0.5)));
    const timeoutMs = Math.max(5000, Math.min(120_000, Number(body.timeoutMs ?? 30_000)));
    const concurrency = Math.max(1, Math.min(10, Number(body.concurrency ?? 5)));
    const modelConfigId = body.modelConfigId ? String(body.modelConfigId).trim() : undefined;

    // 4. 起 run 记录（modelId 字段存为人类可读的 modelConfigId 标识，便于排障）
    const run = await createTriggerEvalRun({
      user,
      skillName: decodedSkillName,
      skillVersion: targetSkillVersion,
      triggerSetId: set.id,
      runsPerQuery,
      triggerThreshold,
      timeoutMs,
      modelId: modelConfigId ?? null,
      workspaceRoot: process.cwd(),
    });

    // 5. 跑评测
    const startedAt = Date.now();
    try {
      const result = await runTriggerEvalLive({
        triggerSet: set,
        skillName: decodedSkillName,
        skillVersion: targetSkillVersion,
        workspaceRoot: process.cwd(),
        user,
        modelConfigId,
        runsPerQuery,
        triggerThreshold,
        timeoutMs,
        concurrency,
      });
      const durationMs = Date.now() - startedAt;
      const finalized = await finalizeTriggerEvalRun({
        id: run.id,
        results: result.items,
        passRate: result.passRate,
        truePositiveRate: result.truePositiveRate,
        falsePositiveRate: result.falsePositiveRate,
        durationMs,
        status: 'done',
      });
      return NextResponse.json({ success: true, run: finalized });
    } catch (runErr) {
      const durationMs = Date.now() - startedAt;
      const msg = runErr instanceof Error ? runErr.message : String(runErr);
      await finalizeTriggerEvalRun({
        id: run.id,
        results: [],
        passRate: 0,
        truePositiveRate: 0,
        falsePositiveRate: 0,
        durationMs,
        status: 'failed',
        errorMessage: msg,
      });
      throw runErr;
    }
  } catch (error) {
    console.error('skill-eval/trigger/run POST error:', error);
    const msg = error instanceof Error ? error.message : 'failed to run trigger eval';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
