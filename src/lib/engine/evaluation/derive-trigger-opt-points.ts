/**
 * 触发评测产出 → Skill 优化点（写入 Evaluation + SkillIssue 两表）。
 *
 * 何时调用：触发评测 run 完成、`finalizeTriggerEvalRun({status:'done'})` 之后。
 *
 * 设计：跟 derive-skill-opt-points.ts 同形态，但有两个根本差异：
 *   1. 一整次评测只产 1 条 SkillIssue（不像 trajectory 那样 per-deviation 一条）——
 *      触发问题在语义上是整体的（"description 不够好"），per-query 反而灌水。
 *   2. 跑前先把同 (skillId, version, source='trigger', resolvedAt=null) 的旧 issue
 *      markResolved，避免聚合后还看到老评测的 prompt。同 version 同一 skill 同一时刻
 *      只有一条 active 的 trigger issue。
 *
 * 路由 / 调用方：src/app/api/skill-eval/trigger/[skillName]/run/route.ts
 *
 * passRate=100% 且无 competing 时**不写新 issue**——只把历史 trigger issue 收掉。
 */

import matter from 'gray-matter';
import { prismaRaw } from '@/lib/storage/prisma';
import { listTriggerEvalRuns, type TriggerRunResultItem } from '@/server/skill_trigger_eval_storage';

const GENERATOR = 'trigger-evaluator@1.0';

export interface DeriveTriggerOptPointsArgs {
  user: string;
  skillName: string;
  skillVersion: number;
  /** SkillTriggerEvalRun.id；落到 Evaluation.runId 让前端能跳回触发评测详情。 */
  triggerRunId: string;
  /**
   * 当前评测对应 SkillVersion.content（完整 SKILL.md 含 frontmatter）。
   * derive 内部 matter() 解析出 description 拼进 prompt——拿 Skill.description 容易跟
   * frontmatter 不同步，直接读 version content 才是 single source of truth。
   */
  skillVersionContent: string;
  results: TriggerRunResultItem[];
  passRate: number;
  truePositiveRate: number;
  falsePositiveRate: number;
  runsPerQuery: number;
  triggerThreshold: number;
}

type Severity = 'high' | 'medium' | 'low';

export async function deriveAndPersistTriggerOptPoints(
  args: DeriveTriggerOptPointsArgs,
): Promise<{ written: number; resolved: number; skillIssueId: string | null }> {
  const {
    user,
    skillName,
    skillVersion,
    triggerRunId,
    skillVersionContent,
    results,
    passRate,
    truePositiveRate,
    falsePositiveRate,
    runsPerQuery,
    triggerThreshold,
  } = args;

  // 解析 frontmatter 拿 description；parse 失败/缺字段时给空串兜底——prompt 模板对
  // 空 description 已有 "(空)" 占位，agent 仍能产出合理结果（相当于"从零写"）。
  let currentDescription = '';
  try {
    const parsed = matter(skillVersionContent || '');
    const raw = (parsed.data as { description?: unknown })?.description;
    if (typeof raw === 'string') currentDescription = raw.trim();
  } catch {
    // gray-matter 偶尔会因为奇怪的 YAML 抛错；兜底成空串即可
  }

  const skillRow = await prismaRaw.skill.findFirst({
    where: { name: skillName, OR: [{ user }, { user: null }] },
    select: { id: true },
  });
  if (!skillRow) return { written: 0, resolved: 0, skillIssueId: null };

  // 1) 先把旧 trigger issue 全 resolved——同 (skillId, version, source='trigger', resolvedAt=null)。
  //    历史 issue 仍在 DB（includeResolved=true 可翻），但默认列表只剩最新这次的。
  const resolvedRes = await prismaRaw.skillIssue.updateMany({
    where: {
      skillId: skillRow.id,
      version: skillVersion,
      source: 'trigger',
      resolvedAt: null,
    },
    data: {
      resolvedAt: new Date(),
      resolvedRunId: triggerRunId,
    },
  });
  const resolved = resolvedRes.count;

  // 2) 分类失败
  const missed = results.filter(r => r.shouldTrigger && !r.pass);
  const falseTriggers = results.filter(r => !r.shouldTrigger && !r.pass);
  const routeStolen = results.filter(r => r.shouldTrigger && !!r.competingSkill);

  // 3) 全部 pass 且无路由竞争 → 不写新 issue（只保留 markResolve 的效果）
  if (passRate >= 1.0 && routeStolen.length === 0) {
    return { written: 0, resolved, skillIssueId: null };
  }

  // 3.5) 历史尝试：本 skill 其他版本评测过的 (description, passRate)。
  //      对标 skill-creator improve_description.py 的 history——让优化者知道哪些
  //      description 试过、效果如何，别重复绕回老路。这是 suggestedFix 每条各不相同的
  //      关键来源之一（叠加本次失败清单）。
  const history = await loadTriggerHistory(skillRow.id, skillName, user, skillVersion);

  // 4) 建 Evaluation 父行 + 1 条 SkillIssue 子行
  const evaluation = await prismaRaw.evaluation.create({
    data: {
      type: 'trigger',
      skillId: skillRow.id,
      version: skillVersion,
      user,
      executionId: null,
      generator: GENERATOR,
      runId: triggerRunId,
      status: 'ok',
    },
  });

  const severity = pickSeverity(passRate, missed.length, falseTriggers.length);
  const passPct = Math.round(passRate * 100);
  const summary = buildSummary(passPct, missed.length, falseTriggers.length, routeStolen.length);
  const evidence = buildEvidence({
    passRate,
    tpr: truePositiveRate,
    fpr: falsePositiveRate,
    missed,
    falseTriggers,
    routeStolen,
    runsPerQuery,
    triggerThreshold,
  });
  const suggestedFix = buildPrompt({
    skillName,
    currentDescription,
    history,
    passRate,
    tpr: truePositiveRate,
    fpr: falsePositiveRate,
    missed,
    falseTriggers,
    routeStolen,
    runsPerQuery,
    triggerThreshold,
  });

  const issue = await prismaRaw.skillIssue.create({
    data: {
      evaluationId: evaluation.id,
      source: 'trigger',
      skillId: skillRow.id,
      version: skillVersion,
      user,
      // 同 (skillId, version) 下 trigger 类只有一条 active；用固定 key 让聚合自然合并。
      // 加 skillName 是兜底——理论上 skillId 已经唯一了，但读 dedupKey 时人眼能识别更友好。
      dedupKey: `trigger:${skillName}`,
      severity,
      summary,
      evidence,
      reasoning: null,
      suggestedFix,
      ruleId: null,
      dimension: null,
      category: '触发评测',
    },
  });

  return { written: 1, resolved, skillIssueId: issue.id };
}

// ---- 字段构造 ----

function pickSeverity(passRate: number, missedCount: number, falseCount: number): Severity {
  if (passRate < 0.6) return 'high';
  if (passRate < 0.85) return 'medium';
  // 即使通过率高，如果有漏触发 + 误触发并存，也不算"小问题"
  if (missedCount > 0 && falseCount > 0) return 'medium';
  return 'low';
}

function buildSummary(
  passPct: number,
  missedCount: number,
  falseCount: number,
  stolenCount: number,
): string {
  const parts: string[] = [];
  if (missedCount > 0) parts.push(`漏 ${missedCount}`);
  if (falseCount > 0) parts.push(`误 ${falseCount}`);
  if (stolenCount > 0) parts.push(`抢路由 ${stolenCount}`);
  const detail = parts.length > 0 ? `（${parts.join(' · ')}）` : '';
  return `触发评测通过率 ${passPct}%${detail}`;
}

interface EvidenceArgs {
  passRate: number;
  tpr: number;
  fpr: number;
  missed: TriggerRunResultItem[];
  falseTriggers: TriggerRunResultItem[];
  routeStolen: TriggerRunResultItem[];
  runsPerQuery: number;
  triggerThreshold: number;
}

function buildEvidence(a: EvidenceArgs): string {
  const lines: string[] = [];
  lines.push(
    `通过率 ${pct(a.passRate)} · TPR ${pct(a.tpr)} · FPR ${pct(a.fpr)} · ` +
      `每条 query 跑 ${a.runsPerQuery} 次 · 阈值 ${a.triggerThreshold}`,
  );
  if (a.missed.length > 0) {
    lines.push('', '【漏触发】');
    for (const r of a.missed) {
      lines.push(`- ${truncate(r.query, 100)} → 触发 ${r.runsTriggered}/${r.runsTotal}`);
    }
  }
  if (a.falseTriggers.length > 0) {
    lines.push('', '【误触发】');
    for (const r of a.falseTriggers) {
      lines.push(`- ${truncate(r.query, 100)} → 触发 ${r.runsTriggered}/${r.runsTotal}`);
    }
  }
  if (a.routeStolen.length > 0) {
    lines.push('', '【路由被抢】');
    for (const r of a.routeStolen) {
      lines.push(
        `- ${truncate(r.query, 100)} → 被 ${r.competingSkill} 抢走（本 skill 触发 ${r.runsTriggered}/${r.runsTotal}）`,
      );
    }
  }
  return lines.join('\n');
}

interface PromptArgs extends EvidenceArgs {
  skillName: string;
  currentDescription: string;
  history: TriggerAttempt[];
}

/**
 * 组织一条「优化建议」（落到 SkillIssue.suggestedFix）。
 *
 * 设计：建议的主体是**本次评测的具体诊断 + 历史尝试**——这些数据每次评测、每个 skill
 * 都不同，所以建议天然各异，不会像写死的模板那样千篇一律。结构对标 skill-creator
 * improve_description.py 喂给 LLM 的输入（current_description + 漏/误触发 + history），
 * 差别是我们不在这里调 LLM 改写，而是把这份「诊断包」交给 skill-opt 页面的 agent 去落地。
 *
 * 历史尝试是关键一环：列出其他版本试过的 description + 评测分，提示优化者别绕回老路
 * （skill-creator 的 "do NOT repeat these" 同理）。
 *
 * 末尾只留一行精简方向，不再堆砌写死的「改写要求 1~6」——那段在每条建议里逐字重复，
 * 正是之前「优化建议都一样」的根源。
 */
function buildPrompt(a: PromptArgs): string {
  const sections: string[] = [];
  sections.push(
    `skill「${a.skillName}」触发评测发现可优化点，请据此优化 description（SKILL.md frontmatter）。`,
  );
  sections.push('', '【当前 description】', a.currentDescription || '(空)');
  sections.push(
    '',
    '【本次评测得分】',
    `通过率 ${pct(a.passRate)} · TPR ${pct(a.tpr)} · FPR ${pct(a.fpr)}（每条 query 跑 ${a.runsPerQuery} 次，阈值 ${a.triggerThreshold}）`,
  );

  if (a.missed.length > 0) {
    sections.push('', '【漏触发】（应触发但没触发）');
    for (const r of a.missed) {
      sections.push(`- "${truncate(r.query, 140)}" → 触发 ${r.runsTriggered}/${r.runsTotal}`);
    }
  }
  if (a.falseTriggers.length > 0) {
    sections.push('', '【误触发】（不该触发但触发了）');
    for (const r of a.falseTriggers) {
      sections.push(`- "${truncate(r.query, 140)}" → 触发 ${r.runsTriggered}/${r.runsTotal}`);
    }
  }
  if (a.routeStolen.length > 0) {
    sections.push('', '【路由被抢】（应触发但被兄弟 skill 拦走）');
    for (const r of a.routeStolen) {
      sections.push(
        `- "${truncate(r.query, 140)}" → 被 ${r.competingSkill} 抢走（本 skill 触发 ${r.runsTriggered}/${r.runsTotal}）`,
      );
    }
  }

  if (a.history.length > 0) {
    sections.push('', '【历史尝试】（这些版本的 description 已经试过，分数如下——别重复老路）');
    for (const h of a.history) {
      sections.push(`- v${h.version}「${truncate(h.description || '(空)', 80)}」→ 通过率 ${pct(h.passRate)}`);
    }
  }

  const competitorHint =
    a.routeStolen.length > 0
      ? `显式写出与 ${uniqueCompetitors(a.routeStolen).join('、')} 的区分边界；`
      : '';
  sections.push(
    '',
    `方向：从失败 case 抽象成更广的用户意图类（勿照抄 query，避免过拟合）；命令式、100-200 字；${competitorHint}漏+误触发并存时先扩边界、再用反例段（Do NOT trigger when...）收口。`,
  );
  return sections.join('\n');
}

// ---- 历史尝试 ----

interface TriggerAttempt {
  version: number;
  description: string;
  passRate: number;
}

/**
 * 拉本 skill「其他版本」最近一次 done 评测的 (description, passRate)，按版本升序。
 *
 * - 排除当前正在评测的版本（它已经在【当前 description】里，不算"历史尝试"）。
 * - 同一版本可能跑过多次 run，只取最新一次（listTriggerEvalRuns 按 createdAt desc，
 *   每个版本第一次遇到的即最新）。
 * - description 从该版本 SkillVersion.content 的 frontmatter 解析。
 *
 * 失败（DB 异常等）时返回空数组——历史尝试是锦上添花，不该阻断 issue 生成。
 */
async function loadTriggerHistory(
  skillId: string,
  skillName: string,
  user: string,
  currentVersion: number,
): Promise<TriggerAttempt[]> {
  try {
    const runs = await listTriggerEvalRuns(user, skillName, { limit: 50 });
    const latestPassByVersion = new Map<number, number>();
    for (const r of runs) {
      if (r.status !== 'done') continue;
      if (r.skillVersion === currentVersion) continue;
      if (latestPassByVersion.has(r.skillVersion)) continue; // desc 排序：首次遇到=最新
      latestPassByVersion.set(r.skillVersion, r.passRate);
    }
    if (latestPassByVersion.size === 0) return [];

    const versionRows = await prismaRaw.skillVersion.findMany({
      where: { skillId, version: { in: [...latestPassByVersion.keys()] } },
      select: { version: true, content: true },
    });

    const out: TriggerAttempt[] = [];
    for (const v of versionRows) {
      let desc = '';
      try {
        const raw = (matter(v.content || '').data as { description?: unknown })?.description;
        if (typeof raw === 'string') desc = raw.trim();
      } catch {
        // frontmatter parse 失败 → 该版本 description 留空，仍展示版本号 + 分数
      }
      out.push({
        version: v.version,
        description: desc,
        passRate: latestPassByVersion.get(v.version) ?? 0,
      });
    }
    out.sort((a, b) => a.version - b.version);
    return out;
  } catch {
    return [];
  }
}

// ---- helpers ----

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function uniqueCompetitors(items: TriggerRunResultItem[]): string[] {
  const set = new Set<string>();
  for (const r of items) if (r.competingSkill) set.add(r.competingSkill);
  return [...set];
}
