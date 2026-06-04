import { NextResponse } from 'next/server';
import {
  findLatestTriggerEvalSet,
  findTriggerEvalSetById,
  createTriggerEvalRun,
  finalizeTriggerEvalRun,
  findRunningRun,
} from '@/server/skill_trigger_eval_storage';
import { runTriggerEvalLive } from '@/lib/engine/skill-generation/evaluator/runners/triggerEval';
import { prismaRaw } from '@/lib/storage/prisma';
import { deriveAndPersistTriggerOptPoints } from '@/lib/engine/evaluation/derive-trigger-opt-points';
import { ensureSessionWorkspace } from '@/lib/engine/general-agent/workspace';
import {
  registerTriggerEvalRun,
  unregisterTriggerEvalRun,
} from '@/server/trigger_eval_run_registry';

export const dynamic = 'force-dynamic';

/**
 * 后台跑一次触发评测：执行 runner → finalize(done/failed) → 派生 skill-opt 可优化点。
 * 由 POST 以 fire-and-forget 方式调起，**绝不向外抛**——任何失败都落进 run 记录的
 * status=failed + errorMessage，前端轮询 /runs 时即可看到。评测可能耗时几十秒到几分钟，
 * 同步 await 会让请求一直挂着、用户一关页面就丢结果；改成后台跑后用户可随时离开。
 */
async function executeTriggerEvalRun(args: {
  runId: string;
  triggerSet: Parameters<typeof runTriggerEvalLive>[0]['triggerSet'];
  skillName: string;
  skillVersion: number;
  skillVersionContent: string;
  workspaceRoot: string;
  user: string;
  modelConfigId?: string;
  runsPerQuery: number;
  triggerThreshold: number;
  timeoutMs: number;
  concurrency: number;
  /** 终止信号：用户点「终止」时由 cancel 路由 abort 对应 controller。 */
  signal: AbortSignal;
}): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await runTriggerEvalLive({
      triggerSet: args.triggerSet,
      skillName: args.skillName,
      skillVersion: args.skillVersion,
      workspaceRoot: args.workspaceRoot,
      user: args.user,
      modelConfigId: args.modelConfigId,
      runsPerQuery: args.runsPerQuery,
      triggerThreshold: args.triggerThreshold,
      timeoutMs: args.timeoutMs,
      concurrency: args.concurrency,
      signal: args.signal,
    });
    const durationMs = Date.now() - startedAt;
    await finalizeTriggerEvalRun({
      id: args.runId,
      results: result.items,
      passRate: result.passRate,
      truePositiveRate: result.truePositiveRate,
      falsePositiveRate: result.falsePositiveRate,
      durationMs,
      status: 'done',
    });

    // 派生 skill-opt 可优化点（写入 Evaluation + SkillIssue）。失败不阻断——评测本身已经 done 了，
    // 派生只是锦上添花；DB 不可用 / matter() parse 失败这类不应该污染主结果。失败仅 warn 留痕。
    try {
      await deriveAndPersistTriggerOptPoints({
        user: args.user,
        skillName: args.skillName,
        skillVersion: args.skillVersion,
        triggerRunId: args.runId,
        skillVersionContent: args.skillVersionContent,
        results: result.items,
        passRate: result.passRate,
        truePositiveRate: result.truePositiveRate,
        falsePositiveRate: result.falsePositiveRate,
        runsPerQuery: args.runsPerQuery,
        triggerThreshold: args.triggerThreshold,
      });
    } catch (deriveErr) {
      console.warn(
        '[trigger-eval/run] deriveAndPersistTriggerOptPoints failed:',
        deriveErr instanceof Error ? deriveErr.message : String(deriveErr),
      );
    }
  } catch (runErr) {
    const durationMs = Date.now() - startedAt;
    // signal.aborted 只会因用户点「终止」而置真（per-item 的命中/超时 abort 走的是 runner 内部
    // 自己的 AbortController，不碰这个外部 signal）——所以据此区分 cancelled 与 failed。
    const cancelled = args.signal.aborted;
    const msg = cancelled ? '已手动终止' : runErr instanceof Error ? runErr.message : String(runErr);
    try {
      await finalizeTriggerEvalRun({
        id: args.runId,
        results: [],
        passRate: 0,
        truePositiveRate: 0,
        falsePositiveRate: 0,
        durationMs,
        status: cancelled ? 'cancelled' : 'failed',
        errorMessage: msg,
      });
    } catch (finErr) {
      console.error('[trigger-eval/run] failed to finalize cancelled/failed run:', finErr);
    }
  } finally {
    // 收尾后从内存登记表注销，避免 Map 无限增长。
    unregisterTriggerEvalRun(args.runId);
  }
}

/**
 * POST /api/skill-eval/trigger/<skillName>/run
 *
 * 起一次 opencode-live 触发评测。**异步**：建好 run 记录（status=running）后立刻 200 返回，
 * 评测在后台 fire-and-forget 跑（典型几十秒～几分钟）。前端据返回的 run.id 轮询 /runs 拿最终结果；
 * 用户可以关掉页面，回来照样能看到——run 落在 DB 里，跟请求生命周期解耦。
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
    // 评测后给 skill-opt 拼 description 优化 prompt 用——必须取 targetSkillVersion 对应版本的
    // content，跟实际被测版本一致；否则会出现「测 v2 但 prompt 里塞 v3 的 description」的错配。
    let targetSkillContent: string;
    if (requestedVersionRaw === undefined || requestedVersionRaw === null) {
      targetSkillVersion = skill.versions[0].version;
      targetSkillContent = skill.versions[0].content;
    } else {
      const n = Number(requestedVersionRaw);
      const match = skill.versions.find(v => v.version === n);
      if (!Number.isFinite(n) || !match) {
        return NextResponse.json(
          { error: `skillVersion ${requestedVersionRaw} not found for ${decodedSkillName}` },
          { status: 404 },
        );
      }
      targetSkillVersion = n;
      targetSkillContent = match.content;
    }

    // 2.5 防重入：同一 (user, skill, version) 已有新鲜的 running run，就不再起新的。
    //     评测异步化后一次 POST 立刻返回，连点 / 多标签页极易并发发起，最后 done 的那条抢成 latest，
    //     既浪费算力又让人困惑。这里直接把正在跑的那条连同 409 回给前端——前端据此关掉对话框、
    //     继续轮询同一条 run 的进度即可（见 page.tsx startRun 对 409 的处理）。
    const existingRunning = await findRunningRun(user, decodedSkillName, targetSkillVersion);
    if (existingRunning) {
      return NextResponse.json(
        { error: '该版本已有一次评测正在运行，等它结束再发起', run: existingRunning },
        { status: 409 },
      );
    }

    // 3. 参数化
    const runsPerQuery = Math.max(1, Math.min(10, Number(body.runsPerQuery ?? 1)));
    const triggerThreshold = Math.max(0, Math.min(1, Number(body.triggerThreshold ?? 0.5)));
    const timeoutMs = Math.max(5000, Math.min(120_000, Number(body.timeoutMs ?? 30_000)));
    const concurrency = Math.max(1, Math.min(10, Number(body.concurrency ?? 5)));
    const modelConfigId = body.modelConfigId ? String(body.modelConfigId).trim() : undefined;

    // 3.5 每次评测切一个 repo 之外、本次专属的干净 workspace。
    //     以前这里传 process.cwd()（共享的 repo checkout），所有 user / 所有 run 共用同一个
    //     .opencode/skills/，物化又只写不清——别的 user 的近义 skill 残留会抢路由，把目标 skill
    //     的触发率压成 0。改用 ensureSessionWorkspace（跟 general-agent 评测同款隔离原语）后，
    //     每个 run 一个独立目录，materialize 只往里放本 user 当下的 skill。
    const workspaceRoot = ensureSessionWorkspace(
      user,
      `trigger-eval-${decodedSkillName}-v${targetSkillVersion}-${Date.now()}`,
    );

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
      workspaceRoot,
    });

    // 5. 登记一个 AbortController（供「终止」用），把它的 signal 穿进后台评测。
    const controller = registerTriggerEvalRun(run.id);

    // 6. 后台跑评测，不 await——立刻把 status=running 的 run 返回给前端。
    //    评测在本进程后台 fire-and-forget 跑（与 eval/trajectory/run 同款 detached promise + .catch 兜底）；
    //    app 是长驻 node 进程（npm start），响应返回后后台 promise 会继续跑到 finalize。
    //    用户可以关掉页面，回来轮询 /runs 即可看到结果；中途也可调 /run/<id>/cancel 终止。
    void executeTriggerEvalRun({
      runId: run.id,
      triggerSet: set,
      skillName: decodedSkillName,
      skillVersion: targetSkillVersion,
      skillVersionContent: targetSkillContent,
      workspaceRoot,
      user,
      modelConfigId,
      runsPerQuery,
      triggerThreshold,
      timeoutMs,
      concurrency,
      signal: controller.signal,
    }).catch(err => {
      console.error('[trigger-eval/run] background run crashed:', err);
    });

    return NextResponse.json({ success: true, run });
  } catch (error) {
    console.error('skill-eval/trigger/run POST error:', error);
    const msg = error instanceof Error ? error.message : 'failed to run trigger eval';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
