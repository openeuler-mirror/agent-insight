/**
 * 评测产出 → Skill 优化点（写入 Evaluation + SkillIssue 两表）。
 *
 * 何时调用：trajectory/run 单条 case 评测完成、status 落库为 'done' 之后。
 *
 * 输入：
 *   - trajectory 评测产出（deviationSteps / rootCauseStep / reasonText / rawAnalysis）
 *   - 任务完成度评测产出（rawAnalysis.key_point_findings —— 来自 result-evaluation 子代理）
 *   - Execution 行（拿 invokedSkills + skillVersion + id）
 *
 * 写入分工（详见 docs/plans/2026-05-08-skill-opt-issues-api-design.md）：
 *   - 每个被评测涉及的 skill：建一行 Evaluation(type='dynamic', skillId, version, user,
 *     executionId, runId=evaluatorRunId, generator='trajectory-evaluator@1.0')
 *   - Evaluation 下挂 N 行 SkillIssue：source='dynamic', dedupKey=hash6(category+normSummary),
 *     category 直填业务分类，suggestedFix=improvementSuggestion
 *   - 同一 case 的多 skill = 多 Evaluation 并列；occurrence/聚合由读取侧 prevalenceCount 派生
 *
 * 重评懒删除：本函数永不删旧 Evaluation/SkillIssue，aggregator 按 dedupKey 跨 Evaluation 合并。
 */

import { createHash } from 'crypto';
import type { TrajectoryEvalResult } from '@prisma/client';
import { prismaRaw } from '@/lib/storage/prisma';

const GENERATOR = 'trajectory-evaluator@1.0';

type Severity = 'high' | 'medium' | 'low';

interface SkillTarget {
  name: string;
  version: number | null;
}

interface RawDeviation {
  stepIndex?: number;
  kind?: string;
  name?: string;
  deviation?: string;
  severity?: string;
  /** 兼容 snake_case (LLM 直接吐出的) 与 camelCase (parser 已规约的) 两种 key */
  is_skill_attributable?: boolean;
  isSkillAttributable?: boolean;
  improvement_suggestion?: string;
  improvementSuggestion?: string;
}

interface RawKeyPointFinding {
  content?: string;
  covered?: boolean;
  severity?: string;
  explanation?: string;
  is_skill_attributable?: boolean;
  isSkillAttributable?: boolean;
  improvement_suggestion?: string;
  improvementSuggestion?: string;
}

interface RawToolChoiceFinding {
  step_index?: number;
  stepIndex?: number;
  tool?: string;
  skill?: string;
  issue?: string;
  reason?: string;
  severity?: string;
  is_skill_attributable?: boolean;
  isSkillAttributable?: boolean;
  improvement_suggestion?: string;
  improvementSuggestion?: string;
}

interface RawResultIssue {
  /** format | extra_content | verbosity | incorrect_fact | other */
  kind?: string;
  summary?: string;
  severity?: string;
  is_skill_attributable?: boolean;
  isSkillAttributable?: boolean;
  improvement_suggestion?: string;
  improvementSuggestion?: string;
}

export interface DeriveOptPointsArgs {
  user: string;
  taskId: string | null;
  runId: string;
  trajectoryRow: Pick<
    TrajectoryEvalResult,
    'id' | 'deviationStepsJson' | 'rootCauseStep' | 'reasonText' | 'rawAnalysisJson'
  >;
  /** Execution.invokedSkills + skill + skills 合并去重后得到的 skill 列表 */
  skills: SkillTarget[];
}

export async function deriveAndPersistOptPoints(args: DeriveOptPointsArgs): Promise<number> {
  const { user, taskId, runId, trajectoryRow, skills } = args;
  if (skills.length === 0) return 0;

  const issues: DerivedIssue[] = [];
  for (const it of extractDeviationIssues(trajectoryRow)) issues.push(it);
  for (const it of extractKeyPointIssues(trajectoryRow)) issues.push(it);
  for (const it of extractToolChoiceIssues(trajectoryRow)) issues.push(it);
  for (const it of extractResultIssues(trajectoryRow)) issues.push(it);

  if (issues.length === 0) return 0;

  // taskId → Execution.id 反查（Evaluation.executionId 存的是 Execution.id 即 upload_id，
  // 而非 taskId）；缺失时降级为 null（Evaluation 仍可写，但前端跳 trace 链接拿不到）。
  let executionId: string | null = null;
  if (taskId) {
    try {
      const exec = await prismaRaw.execution.findFirst({
        where: { taskId },
        select: { id: true },
      });
      executionId = exec?.id ?? null;
    } catch {
      executionId = null;
    }
  }

  // 同一 case 的多 skill 各自起一行 Evaluation；同 skill 内 (category, normSummary) 去重避免
  // 单批同义条目灌水（aggregator 也会按 dedupKey 合，但这里去重让 DB 行数更少）。
  let written = 0;
  for (const skill of skills) {
    const skillRow = await resolveSkill(user, skill.name);
    if (!skillRow) continue;

    const version = skill.version ?? skillRow.activeVersion ?? 0;

    const seenInBatch = new Set<string>();
    const batch: DerivedIssue[] = [];
    for (const issue of issues) {
      const key = `${issue.category}::${normalizeSummary(issue.summary)}`;
      if (seenInBatch.has(key)) continue;
      seenInBatch.add(key);
      batch.push(issue);
    }
    if (batch.length === 0) continue;

    try {
      const evaluation = await prismaRaw.evaluation.create({
        data: {
          type: 'dynamic',
          skillId: skillRow.id,
          version,
          user,
          executionId,
          generator: GENERATOR,
          runId,
          status: 'ok',
        },
      });

      const rows = batch.map(issue => ({
        evaluationId: evaluation.id,
        source: 'dynamic',
        skillId: skillRow.id,
        version,
        user,
        dedupKey: dedupKeyFor(issue),
        severity: issue.severity,
        summary: issue.summary,
        evidence: issue.evidence || null,
        reasoning: null,
        suggestedFix: issue.improvementSuggestion || null,
        ruleId: null,
        dimension: null,
        category: issue.category,
      }));
      if (rows.length > 0) {
        await prismaRaw.skillIssue.createMany({ data: rows });
        written += rows.length;
      }
    } catch (e) {
      // 单 skill 失败不影响其它；评测主流程已经 done 落库了
      console.warn('[derive-skill-opt-points] write failed for skill', skill.name, ':', (e as Error).message);
    }
  }
  return written;
}

interface DerivedIssue {
  severity: Severity;
  category: string;
  summary: string;
  evidence: string;
  /** 评估器给出的"在 SKILL.md 哪段加什么"具体改进建议；可空 */
  improvementSuggestion?: string;
}

function dedupKeyFor(issue: DerivedIssue): string {
  return createHash('sha1')
    .update(`${issue.category}::${normalizeSummary(issue.summary)}`)
    .digest('hex')
    .slice(0, 6);
}

async function resolveSkill(user: string, skillName: string): Promise<{ id: string; activeVersion: number | null } | null> {
  try {
    const row = await prismaRaw.skill.findFirst({
      where: {
        name: skillName,
        OR: [{ user }, { user: null }],
      },
      select: { id: true, activeVersion: true },
    });
    return row;
  } catch {
    return null;
  }
}

function extractDeviationIssues(
  row: Pick<TrajectoryEvalResult, 'deviationStepsJson' | 'rootCauseStep'>,
): DerivedIssue[] {
  const list = parseJsonArray<RawDeviation>(row.deviationStepsJson);
  const out: DerivedIssue[] = [];
  for (const d of list) {
    // 评估器子代理输出的"是否归因到 SKILL"；缺省（旧数据 / 子代理漏字段）按 true 兜底，
    // 用户在 skill-opt 页可以手动忽略；显式 false 的过滤掉，不进 skill 优化点。
    if (resolveSkillAttributable(d.is_skill_attributable, d.isSkillAttributable) === false) continue;
    const sev = normalizeSeverity(d.severity);
    if (sev === 'low') continue; // 噪音过滤——low 级别偏差信号不足以作为优化输入
    const summary = String(d.deviation || '').trim();
    if (!summary) continue;
    const stepIdx = typeof d.stepIndex === 'number' ? d.stepIndex : null;
    const isRootCause = String(row.rootCauseStep || '').includes(`#${stepIdx}`);
    const suggestion = pickSuggestion(d.improvement_suggestion, d.improvementSuggestion);
    out.push({
      severity: isRootCause ? 'high' : sev, // 根因步骤强制 high
      category: '轨迹偏差',
      summary,
      evidence: stepIdx != null
        ? `Step #${stepIdx}${d.name ? ` · ${d.name}` : ''}`
        : (d.name || ''),
      improvementSuggestion: suggestion,
    });
  }
  return out;
}

function extractKeyPointIssues(
  row: Pick<TrajectoryEvalResult, 'rawAnalysisJson'>,
): DerivedIssue[] {
  const raw = parseJsonObject(row.rawAnalysisJson);
  if (!raw) return [];
  // 兼容两种位置：rawAnalysis.resultEvaluation.key_point_findings 或 rawAnalysis.key_point_findings
  const direct = arrayOrEmpty<RawKeyPointFinding>(raw.key_point_findings);
  const nested = arrayOrEmpty<RawKeyPointFinding>(
    raw.resultEvaluation && typeof raw.resultEvaluation === 'object'
      ? (raw.resultEvaluation as Record<string, unknown>).key_point_findings
      : undefined,
  );
  const findings = direct.length > 0 ? direct : nested;
  const out: DerivedIssue[] = [];
  for (const f of findings) {
    if (f.covered === true) continue;
    if (resolveSkillAttributable(f.is_skill_attributable, f.isSkillAttributable) === false) continue;
    const summary = String(f.content || '').trim();
    if (!summary) continue;
    out.push({
      severity: normalizeSeverity(f.severity),
      category: '关键观点遗漏',
      summary,
      evidence: String(f.explanation || '').trim(),
      improvementSuggestion: pickSuggestion(f.improvement_suggestion, f.improvementSuggestion),
    });
  }
  return out;
}

function extractToolChoiceIssues(
  row: Pick<TrajectoryEvalResult, 'rawAnalysisJson'>,
): DerivedIssue[] {
  const raw = parseJsonObject(row.rawAnalysisJson);
  if (!raw) return [];
  const subagent = raw.raw_subagent_outputs;
  const toolChoice =
    subagent && typeof subagent === 'object'
      ? (subagent as Record<string, unknown>).tool_choice
      : undefined;
  const issues = arrayOrEmpty<RawToolChoiceFinding>(
    toolChoice && typeof toolChoice === 'object'
      ? (toolChoice as Record<string, unknown>).issues
      : undefined,
  );
  const out: DerivedIssue[] = [];
  for (const it of issues) {
    if (resolveSkillAttributable(it.is_skill_attributable, it.isSkillAttributable) === false) continue;
    const sev = normalizeSeverity(it.severity);
    if (sev === 'low') continue;
    const summary = String(it.issue || it.reason || '').trim();
    if (!summary) continue;
    const stepIdx = it.step_index ?? it.stepIndex;
    out.push({
      severity: sev,
      category: '工具误用',
      summary,
      evidence: [
        stepIdx != null ? `Step #${stepIdx}` : '',
        it.tool ? `tool=${it.tool}` : '',
        it.skill ? `skill=${it.skill}` : '',
      ].filter(Boolean).join(' · '),
      improvementSuggestion: pickSuggestion(it.improvement_suggestion, it.improvementSuggestion),
    });
  }
  return out;
}

/**
 * 结果评测产出的 result_issues —— key_point_findings 覆盖不到的另外几类 skill-attributable
 * 问题（格式 / 多余内容 / 啰嗦 / 事实错误）。同样按 is_skill_attributable 过滤；low severity
 * 噪音过滤跟其他 extractor 一致。
 */
const RESULT_ISSUE_KIND_TO_CATEGORY: Record<string, string> = {
  format: '格式偏差',
  extra_content: '多余内容',
  verbosity: '表达问题',
  incorrect_fact: '事实错误',
  other: '结果问题',
};

function extractResultIssues(
  row: Pick<TrajectoryEvalResult, 'rawAnalysisJson'>,
): DerivedIssue[] {
  const raw = parseJsonObject(row.rawAnalysisJson);
  if (!raw) return [];
  // 兼容两种位置：rawAnalysis.resultEvaluation.result_issues 和顶层 rawAnalysis.result_issues
  const direct = arrayOrEmpty<RawResultIssue>(raw.result_issues);
  const nested = arrayOrEmpty<RawResultIssue>(
    raw.resultEvaluation && typeof raw.resultEvaluation === 'object'
      ? (raw.resultEvaluation as Record<string, unknown>).result_issues
      : undefined,
  );
  const list = direct.length > 0 ? direct : nested;
  const out: DerivedIssue[] = [];
  for (const it of list) {
    if (resolveSkillAttributable(it.is_skill_attributable, it.isSkillAttributable) === false) continue;
    const sev = normalizeSeverity(it.severity);
    if (sev === 'low') continue;
    const summary = String(it.summary || '').trim();
    if (!summary) continue;
    const rawKind = String(it.kind || 'other').toLowerCase().trim();
    const category = RESULT_ISSUE_KIND_TO_CATEGORY[rawKind] || RESULT_ISSUE_KIND_TO_CATEGORY.other;
    out.push({
      severity: sev,
      category,
      summary,
      // result_issues 不带 step_index；evidence 带原始 kind 标签便于查询反查
      evidence: rawKind && rawKind !== category ? `kind=${rawKind}` : '',
      improvementSuggestion: pickSuggestion(it.improvement_suggestion, it.improvementSuggestion),
    });
  }
  return out;
}

/**
 * 解析 is_skill_attributable / isSkillAttributable 两种 key（snake / camel 兼容）。
 * 返回 true / false / null（表示子代理没给——历史数据 / parse 失败）。
 * 调用方决定 null 时怎么兜底（这里我们当 true 处理，避免漏报）。
 */
function resolveSkillAttributable(snake?: boolean, camel?: boolean): boolean | null {
  if (snake === false || camel === false) return false;
  if (snake === true || camel === true) return true;
  return null;
}

function pickSuggestion(snake?: string, camel?: string): string | undefined {
  const v = String(snake ?? camel ?? '').trim();
  return v ? v : undefined;
}

// ---- helpers ----

function normalizeSeverity(s: unknown): Severity {
  const t = String(s || 'medium').toLowerCase().trim();
  if (t === 'high' || t === 'critical') return 'high';
  if (t === 'low' || t === 'minor') return 'low';
  return 'medium';
}

function normalizeSummary(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 200);
}

function parseJsonObject(s: string | null | undefined): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseJsonArray<T>(s: string | null | undefined): T[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function arrayOrEmpty<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
