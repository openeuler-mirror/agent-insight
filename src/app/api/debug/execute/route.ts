import { NextResponse } from 'next/server';
import { runGeneralAgent } from '@/lib/engine/general-agent';
import { extractDebugJobTokenUsage } from '@/lib/skill-analysis/grayscale-utils';
import { withBackgroundOpencodeSlot } from '@/lib/engine/general-agent/concurrency-limiter';
import { prisma } from '@/lib/storage/prisma';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';

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
 * POST /api/debug/execute
 *
 * Fire-and-forget: starts a runGeneralAgent call in background, returns {jobId} immediately.
 *
 * Body: {
 *   user, query, skill?, skillVersion?, mode?
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

  store.set(jobId, { status: 'running', startedAt });

  const mode = body.mode || 'batch';
  const isGrayscale = mode === 'grayscale';
  const skillName = typeof body.skill === 'string' && body.skill.trim() ? body.skill.trim() : undefined;
  // 纯 trace 归属标签 (区别于上面 skillName: 后者会 deploySkillToWorkspace 加载 SKILL.md)。
  // A/B 行级 retry-execution 调用此接口时, baseline 那侧 skill=undefined 但需要标记
  // "这条 trace 归属对照的 B 侧 skill", 否则"从 Trace"按 skill 过滤就搜不到。
  const tagSkillName = typeof body.tagSkill === 'string' && body.tagSkill.trim() ? body.tagSkill.trim() : undefined;
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

  // Fire and forget — do NOT await。
  // 全部包一层 withBackgroundOpencodeSlot 进 dashboard 监控, 但是否真占 slot
  // 按调用方区分:
  //   - mode='grayscale' (A/B 行级 retry-execution): 纯后台批量, 占 slot,
  //     跟 A/B start / evaluator 共享 5-slot 池, 防止用户连点多个 retry 把 opencode 打爆。
  //   - mode='batch' (默认, 用例分析卡 → "从数据集" → 执行): 用户在前台等结果,
  //     displayOnly=true, 仅 dashboard 可见不占 slot, 不被后台批量任务卡住。
  // 跟 skill-generator / skill-opt / fault-diagnosis / agent-stream/run 一致策略。
  const slotLabel = isGrayscale
    ? `grayscale-retry-${user}-${jobId.slice(0, 8)}`
    : `debug-${user}-${jobId.slice(0, 8)}`;
  const slotTaskType = isGrayscale ? 'grayscale-ab' : 'skill-debug';
  void withBackgroundOpencodeSlot(
    () => runGeneralAgent({
      user,
      query,
      skill: skillName,
      skillVersion: typeof body.skillVersion === 'number' ? body.skillVersion : undefined,
      // baseline retry 走这里: skillName=undefined, tagSkill=对照 skill 名,
      // 让 trace.skill 字段填入对照 skill, "从 Trace"按 skill 过滤能搜到。
      tagSkill: tagSkillName,
      system: systemInstruction,
      interactionPolicy: 'auto-allow',
      systemAgentName: systemAgentName,
      sessionTitle: `${systemAgentName} · ${user} · dbg`,
      // 强制 ephemeralServer=true → runWithEphemeralOpencodeServer({ isolateHome: true }):
      // 起独立 opencode 进程跑完即杀, 看不到 user HOME 下 ~/.claude/skills + ~/.agents/skills,
      // 跟 A/B 主流程 (executeSingleAgentRun) / 评测器 行为对齐, 只测 input.skill 指定那一份,
      // 不被 user HOME 下其他 skill 污染。
      //   - mode='grayscale' (A/B 行级 retry): 之前漏传, 导致 retry 结果跟主流程不可比 —— 修复。
      //   - mode='batch' (用例分析卡): 同样需要隔离, 用户只想测当前选中的 skill。
      ephemeralServer: true,
    }),
    {
      taskType: slotTaskType,
      user,
      label: slotLabel,
      skill: skillName,
      skillVersion: typeof body.skillVersion === 'number' ? body.skillVersion : null,
      displayOnly: !isGrayscale,
    },
  )
    .then((result) => {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      const completed: DebugJob = {
        status: 'completed',
        startedAt,
        output: result.output ?? '',
        timeCost: `${elapsed}s`,
        tokenUsage: extractDebugJobTokenUsage(result.stats),
        sessionId: result.sessionId,
      };
      store.set(jobId, completed);
      persistJob(jobId, user, { status: 'completed', output: completed.output, timeCost: completed.timeCost, tokenUsage: completed.tokenUsage, sessionId: completed.sessionId });
    })
    .catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      store.set(jobId, { status: 'failed', startedAt, error: errMsg });
      persistJob(jobId, user, { status: 'failed', error: errMsg });
    });

  recordUsageEvent({ user, featureKey: 'skill-eval', eventKey: 'skill.eval.debug.run' });

  return NextResponse.json({ jobId });
}
