import { NextResponse } from 'next/server';
import { runGeneralAgent } from '@/lib/engine/general-agent';
import { prisma } from '@/lib/storage/prisma';

export const dynamic = 'force-dynamic';

/** In-memory job store. Lives in globalThis so it survives hot-reload in dev. */
declare global {
  // eslint-disable-next-line no-var
  var __debugJobStore: Map<string, DebugJob> | undefined;
}

export interface DebugJob {
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  output?: string;
  timeCost?: string;
  tokenUsage?: number;
  sessionId?: string;
  error?: string;
}

function getJobStore(): Map<string, DebugJob> {
  if (!globalThis.__debugJobStore) {
    globalThis.__debugJobStore = new Map();
  }
  return globalThis.__debugJobStore;
}

function makeJobId(): string {
  return `dbg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function persistJob(jobId: string, user: string, job: Omit<DebugJob, 'startedAt' | 'status'> & { status: 'completed' | 'failed' }) {
  try {
    await (prisma as any).debugJobResult.upsert({
      where: { id: jobId },
      create: { id: jobId, user, ...job },
      update: { ...job },
    });
  } catch (e) {
    console.error('[DEBUG_EXECUTE] Failed to persist job result:', e);
  }
}

/**
 * 把 grayscale A/B job 的最终结果直接落到对应 GrayscaleTask.caseStatesJson 上。
 *
 * 为什么要在后端做：之前 A/B 是「前端 setInterval 轮询 → 前端把 completed 状态
 * 写回 caseStatesJson」。问题是浏览器一旦关掉/网断/tab 后台被节流, 这条路径就断了,
 * 后端任务跑完也没人把 caseStatesJson 从 'running' 推到 'executed', UI 下次进来
 * 永远卡在 "执行中"。
 *
 * 现在: runGeneralAgent .then/.catch 主动写库, 浏览器在不在线都能正确落库。
 * 前端的 polling/local 写入保持不变作为 belt-and-suspenders, 反正 patchLatestRun
 * 是 idempotent 的, 重复写出相同终态没副作用。
 *
 * 注: 后端这里只需要 "patch latest run" 语义——前端在 runCaseSide 入口已经 push
 * 了一条 {status:'running'} 占位 run 并 PATCH 到 DB, 后端只是把最末尾那条推到
 * 终态。如果出现 runs[] 是空的极端情况(前端 PATCH 还没落或者全空), 兜底逻辑会
 * 现造一条。
 */
type CaseSideJson = {
  status?: string;
  jobId?: string;
  output?: string;
  score?: number;
  sessionId?: string;
  timeCost?: string;
  tokenUsage?: number;
  evaluatorRunId?: string;
  runs?: Array<Record<string, unknown>>;
  [k: string]: unknown;
};

function applyPatchToLatestRun(side: CaseSideJson | undefined, patch: Record<string, unknown>): CaseSideJson {
  const base: CaseSideJson = side ?? { status: 'pending' };
  const runs = Array.isArray(base.runs) ? base.runs.slice() : [];
  if (runs.length > 0) {
    runs[runs.length - 1] = { ...runs[runs.length - 1], ...patch };
  } else {
    runs.push({ runIndex: 1, roundIndex: 1, ...patch });
  }
  return {
    ...base,
    // side 顶层字段镜像最新 run, 跟前端 patchLatestRun 行为一致
    status: (patch.status as string) ?? base.status,
    jobId: (patch.jobId as string) ?? base.jobId,
    output: (patch.output as string) ?? base.output,
    score: (patch.score as number) ?? base.score,
    sessionId: (patch.sessionId as string) ?? base.sessionId,
    timeCost: (patch.timeCost as string) ?? base.timeCost,
    tokenUsage: (patch.tokenUsage as number) ?? base.tokenUsage,
    evaluatorRunId: (patch.evaluatorRunId as string) ?? base.evaluatorRunId,
    runs,
  };
}

async function patchGrayscaleTaskCaseSide(
  taskId: string,
  caseId: string,
  side: 'a' | 'b',
  patch: Record<string, unknown>,
) {
  try {
    const task = await (prisma as any).grayscaleTask.findUnique({
      where: { id: taskId },
      select: { id: true, caseStatesJson: true },
    });
    if (!task) {
      console.warn(`[DEBUG_EXECUTE] GrayscaleTask ${taskId} not found, skip caseStates patch`);
      return;
    }
    let parsed: Record<string, { a?: CaseSideJson; b?: CaseSideJson }> = {};
    try { parsed = task.caseStatesJson ? JSON.parse(task.caseStatesJson) : {}; } catch { parsed = {}; }
    const current = parsed[caseId] || {};
    const updatedSide = applyPatchToLatestRun(current[side], patch);
    parsed[caseId] = { ...current, [side]: updatedSide };
    await (prisma as any).grayscaleTask.update({
      where: { id: taskId },
      data: { caseStatesJson: JSON.stringify(parsed) },
    });
  } catch (e) {
    console.error(`[DEBUG_EXECUTE] Failed to patch GrayscaleTask ${taskId} case ${caseId}/${side}:`, e);
  }
}


/**
 * POST /api/debug/execute
 *
 * Fire-and-forget: starts a runGeneralAgent call in background, returns {jobId} immediately.
 *
 * Body: {
 *   user, query, skill?, skillVersion?,
 *   // 可选: A/B 灰度模式专用——传了这三个就让后端在 job 完成/失败时直接把结果
 *   // 写回 GrayscaleTask.caseStatesJson 对应 case 的对应 side, 不再依赖前端
 *   // 必须开着浏览器轮询才能落库。详见 patchGrayscaleTaskCaseSide 注释。
 *   grayscaleTaskId?, caseId?, side?
 * }
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const user = String(body.user || '').trim();
  const query = String(body.query || '').trim();

  if (!user) return NextResponse.json({ error: 'user is required' }, { status: 400 });
  if (!query) return NextResponse.json({ error: 'query is required' }, { status: 400 });

  const jobId = makeJobId();
  const store = getJobStore();
  const startedAt = Date.now();

  // 解析 grayscale 写回参数 (三个必须同时存在才写回, 否则跳过)
  const grayscaleTaskId = typeof body.grayscaleTaskId === 'string' && body.grayscaleTaskId.trim() ? body.grayscaleTaskId.trim() : null;
  const grayCaseId = typeof body.caseId === 'string' && body.caseId.trim() ? body.caseId.trim() : null;
  const graySide = body.side === 'a' || body.side === 'b' ? body.side as 'a' | 'b' : null;
  const shouldWriteBackToGrayscale = !!(grayscaleTaskId && grayCaseId && graySide);

  store.set(jobId, { status: 'running', startedAt });

  const mode = body.mode || 'batch';
  const isGrayscale = mode === 'grayscale';
  const skillName = typeof body.skill === 'string' && body.skill.trim() ? body.skill.trim() : undefined;
  // 灰度模式下根据是否带 Skill 拆成两条独立的 Agent 标签：
  //   - 候选侧 (B)：传 skill → grayscale-skill-agent，会部署 SKILL.md 并强制 load_skill
  //   - 基线侧 (A)：不传 skill → grayscale-baseline-agent，仅用模型自身知识直接作答
  // 这两个 Agent 共享同一个 runGeneralAgent 实现，差异只在 systemAgentName 标签 + system prompt。
  const isGrayscaleBaseline = isGrayscale && !skillName;
  const systemAgentName = isGrayscaleBaseline
    ? 'grayscale-baseline-agent'
    : isGrayscale
      ? 'grayscale-skill-agent'
      : 'skill-debug-executor';

  let systemInstruction: string | undefined;
  if (isGrayscaleBaseline) {
    systemInstruction =
      "你当前处于自动化灰度测评的【基线对照】环境（不加载任何 Skill）。请严格遵守：\n" +
      "1. 仅基于你自身的模型知识直接回答用户问题。\n" +
      "2. 严禁在运行过程中向用户提问或请求任何需人工干预的信息补充。\n" +
      "3. 若问题需要现场环境信息才能精确回答（如查询本机 CPU、磁盘、日志等），请按照你已有的常识给出最可能的通用答案，并明确说明这是在没有现场探测能力下的推断。\n" +
      "4. 直接给出最终答案，不要列计划、不要汇报你将要做什么。";
  } else if (isGrayscale) {
    systemInstruction =
      "你当前处于自动化灰度测评环境。请直接根据用户的原始输入给出最终结果。严禁在运行过程中向用户提问或请求任何需人工干预的信息补充。";
  }

  // Fire and forget — do NOT await
  runGeneralAgent({
    user,
    query,
    skill: skillName,
    skillVersion: typeof body.skillVersion === 'number' ? body.skillVersion : undefined,
    system: systemInstruction,
    interactionPolicy: 'auto-allow',
    systemAgentName: systemAgentName,
    sessionTitle: `${systemAgentName} · ${user} · dbg`,
  })
    .then((result) => {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      const completed: DebugJob = {
        status: 'completed',
        startedAt,
        output: result.output ?? '',
        timeCost: `${elapsed}s`,
        tokenUsage: result.stats?.toolCallCount ?? 0,
        sessionId: result.sessionId,
      };
      store.set(jobId, completed);
      persistJob(jobId, user, { status: 'completed', output: completed.output, timeCost: completed.timeCost, tokenUsage: completed.tokenUsage, sessionId: completed.sessionId });
      if (shouldWriteBackToGrayscale) {
        // 注: 不 await, 避免 promise 链阻塞 next 个调用; 内部已有 try/catch + console.error
        void patchGrayscaleTaskCaseSide(grayscaleTaskId, grayCaseId, graySide, {
          status: 'executed',
          jobId,
          output: completed.output,
          timeCost: completed.timeCost,
          tokenUsage: completed.tokenUsage,
          sessionId: completed.sessionId,
        });
      }
    })
    .catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      store.set(jobId, { status: 'failed', startedAt, error: errMsg });
      persistJob(jobId, user, { status: 'failed', error: errMsg });
      if (shouldWriteBackToGrayscale) {
        void patchGrayscaleTaskCaseSide(grayscaleTaskId, grayCaseId, graySide, {
          status: 'fail',
          jobId,
          output: errMsg,
        });
      }
    });

  return NextResponse.json({ jobId });
}
