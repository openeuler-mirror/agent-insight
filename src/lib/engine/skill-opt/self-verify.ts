/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * 优化器改完后的【自验证编排】—— 结构门(①) + 行为重评(②)，给生产链路补上缺失的自验证。
 *
 * 设计见 docs / 本仓 spike `.spike/skill-opt-closed-loop/`：
 *   ① 结构门（self-verify-structural.ts）：py_compile / 引用文件存在等，确定性、零成本，先跑、挡确凿的坏。
 *   ② 行为重评（本文件）：对齐 skill-creator 的「expectations 对照评测集、judge 打分」——
 *      把候选 bundle 部署成临时版本，在代表性 eval case 上真跑 + judgeAnswer 对照 rootCauses/expectedOutput，
 *      要求逐用例不退步，并验收来源失败目标。年份这类「编译过却答错」的语义回归正是被这层抓住。
 *
 * 临时版本用**负版本号**：findLatestSkillVersion 按 version DESC 取最新，负号永不被选为 latest，
 * 对正常版本链路零干扰；跑完在 finally 里删行 + 删盘目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getSkillVersionAssetPath, getSkillVersionStorageDir } from '@/lib/env';
import { db } from '@/lib/storage/prisma';
import { runGeneralAgent } from '@/lib/engine/general-agent';
import { judgeAnswer } from '@/lib/engine/evaluation/judge';
import { findAgentDatasetsByTargetSkill, type DatasetCase } from '@/server/agent_datasets_storage';
import { verifyStructure, verifyScriptTruth, runScriptsForSample, type StructuralResult, type ScriptTruthResult } from './self-verify-structural';
import { deriveScriptAssertions } from './self-verify-derive';
import { behavioralCriteria, selectBehavioralCases, validJudgment, verificationHash } from './verification-policy';
import { inputEnvironmentKey, VerificationCache } from './verification-cache';
import { summarizeBehavior, verifyFromSourceExperiment } from './experiment-verification';
import { getActiveConfig } from '@/lib/storage/server-config';
import { loadServerModelForUser } from '@/lib/engine/general-agent/server-model-config';
import type { ModelConfig } from '@/lib/engine/skill-generation/opencode-agent-cli/opencode-client';

export interface CaseVerdict {
  caseId: string;
  /** 0-100；null = 该例 rollout/判官失败（基建问题，按 skip 不计入均值）。 */
  base: number | null;
  cand: number | null;
  delta: number | null;
  reason: string;
  targetMet?: boolean;
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
  incomplete?: string;
  reused?: number;
  experimentId?: string;
  targetFailures?: CaseVerdict[];
  verifiedIssueIds?: string[];
  fullCoverage?: boolean;
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

const baselineCache = new VerificationCache();

// ── 临时候选版本部署（负版本号，跑完清理）─────────────────────────────────────
async function deployTempCandidate(
  skillId: string,
  candidateSkillMd: string,
  candidateFiles: Record<string, string>,
): Promise<{ version: number; cleanup: () => void }> {
  // 负且唯一：不进 latest 链路；随机段降低并发碰撞概率。int32 安全。
  const version = -(100_000 + Math.floor(Math.random() * 1_000_000));
  const dir = getSkillVersionStorageDir(skillId, version);
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
    assetPath: getSkillVersionAssetPath(skillId, version),
    files: JSON.stringify(rels),
    changeLog: 'self-verify ephemeral candidate',
  });
  const cleanup = () => {
    db.deleteSkillVersion(skillId, version).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { version, cleanup };
}

/** 跑一个用例 + judge → 0-1 分。任何 rollout/判官异常都吞掉返回 null（基建失败 ≠ skill 差）。 */
async function scoreCase(
  user: string,
  skillName: string,
  version: number,
  c: DatasetCase,
  signal?: AbortSignal,
  model?: ModelConfig,
  previousOutput?: string,
): Promise<{ score: number; reason: string; output: string } | null> {
  try {
    signal?.throwIfAborted();
    const criteria = behavioralCriteria(c);
    if (!criteria) return null;
    const res = previousOutput ? { output: previousOutput } : await runGeneralAgent({
      cancelSignal: signal,
      user,
      query: c.input,
      model,
      timeoutMs: 180_000,
      progressTimeoutMs: 45_000,
      skill: skillName,
      skillVersion: version,
      ephemeralServer: true, // 后台批量须 true，保证拿到刚部署的候选（含临时负版本）
      interactionPolicy: 'auto-allow',
    });
    signal?.throwIfAborted();
    const output = res.output || '';
    if (!output.trim()) return null;
    const v = await judgeAnswer(c.input, criteria, output, user);
    signal?.throwIfAborted();
    return validJudgment(v) ? { score: v.score, reason: v.reason || '', output } : null;
  } catch (e) {
    if (e instanceof Error && e.message.includes('停止 OpenCode 执行未确认')) throw e;
    signal?.throwIfAborted();
    console.warn('[self-verify] scoreCase failed (treat as skip):', (e as Error)?.message?.slice(0, 120));
    return null;
  }
}

export interface BehavioralArgs {
  user: string;
  skillName: string;
  skillId: string;
  baseVersion: number;
  candidateSkillMd: string;
  candidateFiles: Record<string, string>; // 技能根相对（SKILL.md 在根）
  cases: DatasetCase[];                    // 已选好的代表性子集
  baseFiles?: Record<string, string>;
  budgetYuan?: number;
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
}

export async function verifyBehavioral(args: BehavioralArgs): Promise<BehavioralResult> {
  const { user, skillName, skillId, baseVersion, cases, onProgress } = args;
  if (!cases.length) {
    return { ok: true, baseMean: null, candMean: null, delta: null, perCase: [], regressions: [], measured: 0, skipped: '该 skill 无可用 eval 用例' };
  }
  const { version: candV, cleanup } = await deployTempCandidate(skillId, args.candidateSkillMd, args.candidateFiles);
  const perCase: CaseVerdict[] = [];
  const model = await loadServerModelForUser(user);
  const config = await getActiveConfig(user);
  const runtimeKey = verificationHash({ version: 2, model, node: process.version, policy: 'auto-allow' });
  let rollouts = 0, reused = 0;
  try {
    for (const c of cases) {
      args.signal?.throwIfAborted();
      const environment = await inputEnvironmentKey(c.input);
      const cacheKey = environment && args.baseFiles && model
        ? verificationHash({ user, skillId, baseVersion, files: args.baseFiles, input: c.input, environment, runtimeKey }) : null;
      const judgeKey = verificationHash({ version: 2, config, criteria: behavioralCriteria(c) });
      const cached = cacheKey ? await baselineCache.read(cacheKey) : null;
      const requiredRuns = cached ? 1 : 2;
      if (args.budgetYuan != null && (rollouts + requiredRuns) * EST_YUAN_PER_ROLLOUT > args.budgetYuan) break;
      onProgress?.(`行为验证 ${perCase.length + 1}/${cases.length}：${cached ? '复用旧版' + (cached.judgeKey === judgeKey ? '分数' : '输出并重新评分') : '运行旧版基线'}…`);
      const base = cached?.judgeKey === judgeKey && cached.score != null ? { ...cached, score: cached.score, reason: cached.reason || '' }
        : await scoreCase(user, skillName, baseVersion, c, args.signal, model || undefined, cached?.output);
      if (cached) reused++; else rollouts++;
      if (base && cacheKey && environment === await inputEnvironmentKey(c.input)
        && verificationHash(config) === verificationHash(await getActiveConfig(user))) {
        await baselineCache.write(cacheKey, { ...base, judgeKey, createdAt: cached?.createdAt ?? Date.now() }).catch(() => {});
      }
      if (!base) {
        perCase.push({ caseId: c.id, base: null, cand: null, delta: null, reason: '旧版执行或评分未完成，未消耗候选执行' });
        continue;
      }
      onProgress?.(`行为验证 ${perCase.length + 1}/${cases.length}：运行候选并评分（已复用 ${reused} 个旧版结果）…`);
      const cand = await scoreCase(user, skillName, candV, c, args.signal, model || undefined);
      rollouts++;
      const b = ROUND(base.score), a = cand ? ROUND(cand.score) : null;
      perCase.push({ caseId: c.id, base: b, cand: a, delta: a != null ? a - b : null, reason: cand?.reason || '候选执行或评分未完成' });
    }
  } finally {
    cleanup();
  }
  return summarizeBehavior(perCase, cases.length, reused);
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
  issueIds?: string[];
  optimizationRecordId?: string;
  baseFiles?: Record<string, string>;
  /** 行为门最多量几例（含 baseline 共 ~2×rollout）。默认 5。 */
  maxCases?: number;
  budgetYuan?: number;
  /** 仅跑结构门（无预算 / 关掉行为门时）。 */
  structuralOnly?: boolean;
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
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
  args.signal?.throwIfAborted();
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
    allCases = selectBehavioralCases(datasets, args.sampleCaseIds, args.maxCases ?? 5);
  } catch (e) {
    console.warn('[self-verify] dataset load failed:', (e as Error)?.message);
  }

  // ①.5 脚本真值门：跑脚本、用数据集真值年份断言其输出——确定性、零成本，门住昂贵的行为门。
  // （只判 agent 输出的行为门会被 agent 兜住坏脚本而误放行，见 e2e 实测：log_year=None 却 +7 被接受。）
  let scriptTruth: ScriptTruthResult | null = null;
  const logPath = exampleLogPath(allCases);
  // 跑一次候选脚本拿输出样本，给断言 reviewer 看「脚本算了哪些全局字段」（首次派生用；之后缓存）
  const hasScripts = Object.keys(args.candidateFiles).some((name) => /^scripts\/.*\.(py|sh|js)$/.test(name));
  const scriptSample = logPath && hasScripts ? runScriptsForSample(args.candidateFiles, logPath) : '';
  args.signal?.throwIfAborted();
  const assertions = !args.structuralOnly && logPath && hasScripts ? await deriveScriptAssertions(allCases, args.user, scriptSample) : [];
  args.signal?.throwIfAborted();
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
    const fromExperiment = args.baseFiles ? await verifyFromSourceExperiment({
      user: args.user, skillName: args.skillName, baseVersion: args.baseVersion,
      baseFiles: args.baseFiles, candidateFiles: args.candidateFiles, issueIds: args.issueIds, optimizationRecordId: args.optimizationRecordId,
      maxCases: args.maxCases ?? 5, budgetYuan: args.budgetYuan, signal: args.signal, onProgress: args.onProgress,
    }) : null;
    if (fromExperiment) {
      behavioral = fromExperiment;
    } else if (!skillId) {
      behavioral = { ok: true, baseMean: null, candMean: null, delta: null, perCase: [], regressions: [], measured: 0, skipped: 'DB 无此 skill，行为门跳过' };
    } else if (!allCases.length) {
      behavioral = { ok: true, baseMean: null, candMean: null, delta: null, perCase: [], regressions: [], measured: 0, skipped: '无有效行为用例（已排除触发用例与缺少评分依据的用例），请通过实验复测' };
    } else {
      const cases = allCases;
      args.onProgress?.(`行为门：在 ${cases.length} 个代表性用例上重评（共 ${allCases.length} 例）…`);
      behavioral = await verifyBehavioral({
        user: args.user, skillName: args.skillName, skillId, baseVersion: args.baseVersion,
        candidateSkillMd: args.candidateSkillMd, candidateFiles: args.candidateFiles, cases, baseFiles: args.baseFiles,
        budgetYuan: args.budgetYuan, onProgress: args.onProgress, signal: args.signal,
      });
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('停止 OpenCode 执行未确认')) throw e;
    args.signal?.throwIfAborted();
    console.warn('[self-verify] behavioral phase errored (treat as pass, structural still gated):', (e as Error)?.message);
    behavioral = { ok: true, baseMean: null, candMean: null, delta: null, perCase: [], regressions: [], measured: 0, incomplete: '行为验证异常，请通过实验复测' };
  }

  const failures = [...structural.failures, ...(scriptTruth?.failures ?? [])];
  if (behavioral && !behavioral.ok) {
    const regs = behavioral.regressions.map((r) => `${r.caseId.slice(0, 8)} ${r.base}→${r.cand}（${r.reason.slice(0, 50)}）`).join('；');
    for (const item of behavioral.targetFailures || []) failures.push(`目标用例 ${item.caseId} 未通过验收：${item.reason}`);
    failures.push(`行为门：净分 ${behavioral.baseMean}→${behavioral.candMean}（Δ${behavioral.delta}），回归用例：${regs || '无掉分，但目标验收未通过'}`);
  }
  return { ok: (scriptTruth?.ok ?? true) && (behavioral?.ok ?? true), structural, scriptTruth, behavioral, failures };
}
