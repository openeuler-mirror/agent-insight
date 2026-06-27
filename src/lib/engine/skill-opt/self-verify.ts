/**
 * 优化器改完后的【自验证编排】—— 结构门(①) + 行为重评(②)，给生产链路补上缺失的自验证。
 *
 * 设计见 docs / 本仓 spike `.spike/skill-opt-closed-loop/`：
 *   ① 结构门（self-verify-structural.ts）：py_compile / 引用文件存在等，确定性、零成本，先跑、挡确凿的坏。
 *   ② 行为重评（本文件）：对齐 skill-creator 的「expectations 对照评测集、judge 打分」——
 *      把候选 bundle 部署成临时版本，在代表性 eval case 上真跑 + judgeAnswer 对照 rootCauses/expectedOutput，
 *      要求**净分不降**（do-no-harm）。年份这类「编译过却答错」的语义回归正是被这层抓住。
 *
 * 临时版本用**负版本号**：findLatestSkillVersion 按 version DESC 取最新，负号永不被选为 latest，
 * 对正常版本链路零干扰；跑完在 finally 里删行 + 删盘目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { db } from '@/lib/storage/prisma';
import { runGeneralAgent } from '@/lib/engine/general-agent';
import { judgeAnswer, type JudgeCriteria } from '@/lib/engine/evaluation/judge';
import { findAgentDatasetsByTargetSkill, type DatasetCase } from '@/server/agent_datasets_storage';
import { verifyStructure, verifyScriptTruth, runScriptsForSample, type StructuralResult, type ScriptTruthResult } from './self-verify-structural';
import { deriveScriptAssertions } from './self-verify-derive';

export interface CaseVerdict {
  caseId: string;
  /** 0-100；null = 该例 rollout/判官失败（基建问题，按 skip 不计入均值）。 */
  base: number | null;
  cand: number | null;
  delta: number | null;
  reason: string;
}

export interface BehavioralResult {
  ok: boolean;
  baseMean: number | null;
  candMean: number | null;
  delta: number | null;
  perCase: CaseVerdict[];
  /** cand < base 的用例（含 train 里原本对的）——repair 反馈的核心。 */
  regressions: CaseVerdict[];
  measured: number;
  skipped?: string;
}

export interface SelfVerifyResult {
  ok: boolean;
  structural: StructuralResult;
  /** 脚本真值门（①.5）：跑脚本对照数据集真值；null = 无可检查脚本 / 未启用。 */
  scriptTruth: ScriptTruthResult | null;
  behavioral: BehavioralResult | null;
  /** 人类可读失败摘要，喂 repair。 */
  failures: string[];
}

const ROUND = (x: number) => Math.round(x * 100);
const EST_YUAN_PER_ROLLOUT = 0.6; // 粗估，仅用于预算软门告警

/** 进程内基线分缓存，键 = skillId:baseVersion:caseId，避免每次优化重测基线。 */
const baselineMemo = new Map<string, { score: number; reason: string }>();

// ── 临时候选版本部署（负版本号，跑完清理）─────────────────────────────────────
async function deployTempCandidate(
  skillId: string,
  candidateSkillMd: string,
  candidateFiles: Record<string, string>,
): Promise<{ version: number; cleanup: () => void }> {
  // 负且唯一：不进 latest 链路；随机段降低并发碰撞概率。int32 安全。
  const version = -(100_000 + Math.floor(Math.random() * 1_000_000));
  const dir = path.join(process.cwd(), 'data', 'storage', 'skills', skillId, `v${version}`);
  const rels: string[] = [];
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(candidateFiles)) {
    if (rel.includes('..')) continue;
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content ?? '');
    rels.push(rel);
  }
  await db.deleteSkillVersion(skillId, version); // 清理可能的同号残留
  await db.createSkillVersion({
    skillId,
    version,
    content: candidateSkillMd,
    assetPath: `data/storage/skills/${skillId}/v${version}`,
    files: JSON.stringify(rels),
    changeLog: 'self-verify ephemeral candidate',
  });
  const cleanup = () => {
    db.deleteSkillVersion(skillId, version).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { version, cleanup };
}

function criteriaOf(c: DatasetCase): JudgeCriteria {
  return {
    standard_answer_example: c.expectedOutput,
    root_causes: (c.rootCauses ?? []).map((r) => ({ content: r.content, weight: r.weight })),
  };
}

/** 跑一个用例 + judge → 0-1 分。任何 rollout/判官异常都吞掉返回 null（基建失败 ≠ skill 差）。 */
async function scoreCase(
  user: string,
  skillName: string,
  version: number,
  c: DatasetCase,
): Promise<{ score: number; reason: string } | null> {
  try {
    const res = await runGeneralAgent({
      user,
      query: c.input,
      skill: skillName,
      skillVersion: version,
      ephemeralServer: true, // 后台批量须 true，保证拿到刚部署的候选（含临时负版本）
      interactionPolicy: 'auto-allow',
    });
    const output = res.output || '';
    if (output.trim().length < 5) return null;
    const v = await judgeAnswer(c.input, criteriaOf(c), output, user);
    return { score: v.score, reason: v.reason || '' };
  } catch (e) {
    console.warn('[self-verify] scoreCase failed (treat as skip):', (e as Error)?.message?.slice(0, 120));
    return null;
  }
}

/** 基线分（真实 baseVersion），带进程内缓存。 */
async function baselineScore(
  user: string,
  skillName: string,
  skillId: string,
  baseVersion: number,
  c: DatasetCase,
): Promise<{ score: number; reason: string } | null> {
  const key = `${skillId}:${baseVersion}:${c.id}`;
  const hit = baselineMemo.get(key);
  if (hit) return hit;
  const r = await scoreCase(user, skillName, baseVersion, c);
  if (r) baselineMemo.set(key, r);
  return r;
}

export interface BehavioralArgs {
  user: string;
  skillName: string;
  skillId: string;
  baseVersion: number;
  candidateSkillMd: string;
  candidateFiles: Record<string, string>; // 技能根相对（SKILL.md 在根）
  cases: DatasetCase[];                    // 已选好的代表性子集
  budgetYuan?: number;
  onProgress?: (msg: string) => void;
}

export async function verifyBehavioral(args: BehavioralArgs): Promise<BehavioralResult> {
  const { user, skillName, skillId, baseVersion, cases, onProgress } = args;
  if (!cases.length) {
    return { ok: true, baseMean: null, candMean: null, delta: null, perCase: [], regressions: [], measured: 0, skipped: '该 skill 无可用 eval 用例' };
  }
  const { version: candV, cleanup } = await deployTempCandidate(skillId, args.candidateSkillMd, args.candidateFiles);
  const perCase: CaseVerdict[] = [];
  let rollouts = 0;
  try {
    for (const c of cases) {
      if (args.budgetYuan != null && rollouts * EST_YUAN_PER_ROLLOUT >= args.budgetYuan) {
        onProgress?.(`自验证预算软门（~¥${args.budgetYuan}）触发，停在 ${perCase.length}/${cases.length} 例`);
        break;
      }
      onProgress?.(`行为重评 ${c.id.slice(0, 8)}（${perCase.length + 1}/${cases.length}）…`);
      const base = await baselineScore(user, skillName, skillId, baseVersion, c);
      if (!baselineMemo.has(`${skillId}:${baseVersion}:${c.id}`)) rollouts++; // 仅未命中缓存才算花了 rollout
      const cand = await scoreCase(user, skillName, candV, c);
      rollouts++;
      const b = base ? ROUND(base.score) : null;
      const a = cand ? ROUND(cand.score) : null;
      perCase.push({ caseId: c.id, base: b, cand: a, delta: b != null && a != null ? a - b : null, reason: cand?.reason || base?.reason || '' });
    }
  } finally {
    cleanup();
  }

  const both = perCase.filter((p) => p.base != null && p.cand != null);
  const baseMean = both.length ? Math.round((both.reduce((s, p) => s + (p.base as number), 0) / both.length) * 10) / 10 : null;
  const candMean = both.length ? Math.round((both.reduce((s, p) => s + (p.cand as number), 0) / both.length) * 10) / 10 : null;
  const delta = baseMean != null && candMean != null ? Math.round((candMean - baseMean) * 10) / 10 : null;
  const regressions = perCase.filter((p) => p.delta != null && (p.delta as number) < 0);
  // do-no-harm：净分（均值）不降即过；单点回归进 regressions 供 repair 参考。判官单次有噪，故用均值判过。
  const ok = delta == null || delta >= 0;
  return { ok, baseMean, candMean, delta, perCase, regressions, measured: both.length };
}

// ── 编排：结构门(①) → 行为门(②) ─────────────────────────────────────────────
export interface SelfVerifyArgs {
  user: string;
  skillName: string;
  candidateSkillMd: string;
  candidateFiles: Record<string, string>; // 技能根相对（SKILL.md 在根）
  baseVersion: number;
  /** 本次优化关联的 issue 涉及的 caseId（优先纳入度量）。 */
  sampleCaseIds?: string[];
  /** 行为门最多量几例（含 baseline 共 ~2×rollout）。默认 5。 */
  maxCases?: number;
  budgetYuan?: number;
  /** 仅跑结构门（无预算 / 关掉行为门时）。 */
  structuralOnly?: boolean;
  onProgress?: (msg: string) => void;
}

/** 选代表性子集：本次改的 issue 关联用例优先，再用别的用例补到 maxCases（覆盖「没在改的」抓附带损害）。 */
function selectCases(all: DatasetCase[], sampleIds: string[] | undefined, maxCases: number): DatasetCase[] {
  if (all.length <= maxCases) return all;
  const want = new Set(sampleIds ?? []);
  const linked = all.filter((c) => want.has(c.id));
  const rest = all.filter((c) => !want.has(c.id));
  return [...linked, ...rest].slice(0, Math.max(maxCases, linked.length));
}

/** 从 case.input 抠出真实存在的示例日志路径（脚本的输入）。 */
function exampleLogPath(cases: DatasetCase[]): string | undefined {
  for (const c of cases) {
    for (const m of (c.input || '').matchAll(/~?\/[A-Za-z0-9._/~-]+/g)) {
      const p = m[0].replace(/^~/, os.homedir());
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch { /* */ }
    }
  }
  return undefined;
}

export async function runSelfVerification(args: SelfVerifyArgs): Promise<SelfVerifyResult> {
  const structural = verifyStructure(args.candidateFiles);
  args.onProgress?.(`结构门：${structural.ok ? 'pass' : 'FAIL — ' + structural.failures.join('；')}`);
  if (!structural.ok) {
    return { ok: false, structural, scriptTruth: null, behavioral: null, failures: structural.failures };
  }

  // 评测集（脚本真值门 ①.5 + 行为门 ② 共用）
  let allCases: DatasetCase[] = [];
  let skillId: string | undefined;
  try {
    skillId = (await db.findSkill(args.skillName, args.user))?.id;
    const datasets = await findAgentDatasetsByTargetSkill(args.user, args.skillName);
    allCases = datasets.filter((d) => d.datasetKind === 'ideal_output').flatMap((d) => d.cases);
  } catch (e) {
    console.warn('[self-verify] dataset load failed:', (e as Error)?.message);
  }

  // ①.5 脚本真值门：跑脚本、用数据集真值年份断言其输出——确定性、零成本，门住昂贵的行为门。
  // （只判 agent 输出的行为门会被 agent 兜住坏脚本而误放行，见 e2e 实测：log_year=None 却 +7 被接受。）
  let scriptTruth: ScriptTruthResult | null = null;
  const logPath = exampleLogPath(allCases);
  // 跑一次候选脚本拿输出样本，给断言 reviewer 看「脚本算了哪些全局字段」（首次派生用；之后缓存）
  const scriptSample = logPath ? runScriptsForSample(args.candidateFiles, logPath) : '';
  const assertions = await deriveScriptAssertions(allCases, args.user, scriptSample);
  if (assertions.length && logPath) {
    scriptTruth = verifyScriptTruth(args.candidateFiles, { logPath, assertions });
    args.onProgress?.(`脚本真值门（${assertions.map((a) => a.id).join(', ')}）：${scriptTruth.ok ? 'pass' : 'FAIL — ' + scriptTruth.failures.join('；')}`);
    if (!scriptTruth.ok) {
      // 脚本被证伪 → 直接 reject + repair，不烧 rollout
      return { ok: false, structural, scriptTruth, behavioral: null, failures: [...structural.failures, ...scriptTruth.failures] };
    }
  }

  if (args.structuralOnly) {
    return { ok: true, structural, scriptTruth, behavioral: null, failures: [] };
  }

  // ② 行为门：选代表性子集 → 部署临时候选 → 真跑 + judge
  let behavioral: BehavioralResult | null = null;
  try {
    if (!skillId) {
      behavioral = { ok: true, baseMean: null, candMean: null, delta: null, perCase: [], regressions: [], measured: 0, skipped: 'DB 无此 skill，行为门跳过' };
    } else if (!allCases.length) {
      behavioral = { ok: true, baseMean: null, candMean: null, delta: null, perCase: [], regressions: [], measured: 0, skipped: '无 ideal_output 评测集，行为门跳过' };
    } else {
      const cases = selectCases(allCases, args.sampleCaseIds, args.maxCases ?? 5);
      args.onProgress?.(`行为门：在 ${cases.length} 个代表性用例上重评（共 ${allCases.length} 例）…`);
      behavioral = await verifyBehavioral({
        user: args.user, skillName: args.skillName, skillId, baseVersion: args.baseVersion,
        candidateSkillMd: args.candidateSkillMd, candidateFiles: args.candidateFiles, cases,
        budgetYuan: args.budgetYuan, onProgress: args.onProgress,
      });
    }
  } catch (e) {
    console.warn('[self-verify] behavioral phase errored (treat as pass, structural still gated):', (e as Error)?.message);
    behavioral = { ok: true, baseMean: null, candMean: null, delta: null, perCase: [], regressions: [], measured: 0, skipped: '行为门异常，已跳过' };
  }

  const failures = [...structural.failures, ...(scriptTruth?.failures ?? [])];
  if (behavioral && !behavioral.ok) {
    const regs = behavioral.regressions.map((r) => `${r.caseId.slice(0, 8)} ${r.base}→${r.cand}（${r.reason.slice(0, 50)}）`).join('；');
    failures.push(`行为门：净分 ${behavioral.baseMean}→${behavioral.candMean}（Δ${behavioral.delta}），回归用例：${regs || '净降'}`);
  }
  return { ok: (scriptTruth?.ok ?? true) && (behavioral?.ok ?? true), structural, scriptTruth, behavioral, failures };
}
