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

import { prismaRaw } from '@/lib/storage/prisma';
import { findAgentDataset } from '@/server/agent_datasets_storage';
import { executeSkillCaseOnClient } from '@/lib/skill-workbench/client-execution';
import type { SkillExecutionTarget, SkillExecutionSnapshot } from '@/lib/skill-workbench/execution-target';
import { evaluateEvalExperimentCase } from '@/lib/engine/experiment/run-experiment';
import { verificationRowsHash } from '@/lib/skill-workbench/verification-evidence';
import { isTriggerCase, verificationHash } from './verification-policy';
import type { BehavioralResult, CaseVerdict } from './self-verify';

function parse<T>(value: string | null, fallback: T): T {
  try { return JSON.parse(value || '') as T; } catch { return fallback; }
}

export function incompleteBehavior(reason: string): BehavioralResult {
  return { ok: true, baseMean: null, candMean: null, delta: null, perCase: [], regressions: [], measured: 0, incomplete: reason };
}

export function summarizeBehavior(perCase: CaseVerdict[], expected: number, reused = 0): BehavioralResult {
  const both = perCase.filter((item) => item.base != null && item.cand != null);
  const mean = (side: 'base' | 'cand') => both.length ? Math.round(both.reduce((sum, item) => sum + item[side]!, 0) / both.length * 10) / 10 : null;
  const baseMean = mean('base'), candMean = mean('cand');
  const delta = baseMean != null && candMean != null ? Math.round((candMean - baseMean) * 10) / 10 : null;
  return {
    ok: !both.some((item) => item.delta! < 0 || item.targetMet === false), baseMean, candMean, delta, perCase,
    targetFailures: both.filter((item) => item.targetMet === false),
    regressions: both.filter((item) => item.delta! < 0), measured: both.length, reused,
    ...(both.length !== expected ? { incomplete: `仅完成 ${both.length}/${expected} 个有效对比，需实验复测` } : {}),
  };
}

export async function verifyFromSourceExperiment(input: {
  user: string; skillName: string; baseVersion: number; baseFiles: Record<string, string>;
  candidateFiles: Record<string, string>; optimizationRecordId?: string; sourceExperimentId?: string; maxCases: number; issueIds?: string[];
  budgetYuan?: number; signal?: AbortSignal; onProgress?: (message: string) => void; verificationPurpose?: 'optimization' | 'retest';
}): Promise<BehavioralResult | null> {
  const issues = input.issueIds?.length ? await prismaRaw.skillIssue.findMany({
    where: { id: { in: input.issueIds }, user: input.user, version: input.baseVersion, Evaluation: { Skill: { name: input.skillName } } },
    select: { id: true, Evaluation: { select: { runId: true, executionId: true } } },
  }) : [];
  const preferredIds = issues.flatMap((issue) => issue.Evaluation.runId ? [issue.Evaluation.runId.replace(/^experiment:([^:]+):.*$/, '$1')] : []);
  const sources = await prismaRaw.experiment.findMany({
    where: { id: input.sourceExperimentId, user: input.user, deletedAt: null, scope: 'skill-workbench', skillName: input.skillName,
      skillVersion: input.baseVersion, preset: { in: ['use-case', 'skill-ab'] }, status: { in: ['done', 'partial'] } },
    orderBy: { updatedAt: 'desc' }, take: 30,
  });
  const source = sources.find((row) => preferredIds.includes(row.id)) || sources[0];
  if (!source) return null;
  const snapshot = parse<{
    datasetId?: string; caseIds?: string[]; evaluatorIds?: string[]; grayscaleTaskId?: string;
    boundSide?: 'a' | 'b'; baselineSide?: 'a' | 'b'; executionTarget?: SkillExecutionTarget;
    customEvaluatorSnapshots?: { cards?: Record<string, unknown> };
    runtime?: { timeoutMs?: number };
  }>(source.configSnapshotJson, {});
  if (!snapshot.datasetId || !snapshot.caseIds?.length || !snapshot.grayscaleTaskId || !snapshot.executionTarget?.model) {
    return incompleteBehavior('来源实验缺少冻结的运行配置，请按原实验复测');
  }
  const task = await prismaRaw.grayscaleTask.findFirst({ where: { id: snapshot.grayscaleTaskId, user: input.user } });
  if (!task) return incompleteBehavior('来源实验的执行证据不存在');
  const config = parse<{ evalExperimentId?: string; boundSide?: 'a' | 'b'; skillSnapshots?: { a?: SkillExecutionSnapshot; b?: SkillExecutionSnapshot }; executionTarget?: SkillExecutionTarget }>(task.configJson, {});
  const side = snapshot.boundSide || config.boundSide || 'b';
  const original = config.skillSnapshots?.[side];
  if (config.evalExperimentId !== source.id || !original || original.name !== input.skillName || original.version !== input.baseVersion
    || verificationHash(original.files) !== verificationHash(input.baseFiles)
    || verificationHash(config.executionTarget) !== verificationHash(snapshot.executionTarget)) {
    return incompleteBehavior('旧版 Skill 或执行配置与来源实验不一致，无法复用基线');
  }
  const evaluatorIds = parse<string[]>(source.evaluatorIdsJson, []);
  if (!evaluatorIds.length || evaluatorIds.some((id) => id.startsWith('custom-') && !snapshot.customEvaluatorSnapshots?.cards?.[id])) {
    return incompleteBehavior('来源实验缺少冻结的评分规则');
  }
  const dataset = await findAgentDataset(input.user, snapshot.datasetId);
  if (!dataset || dataset.datasetKind !== 'ideal_output' || dataset.tags.includes('trigger') || dataset.fields.some((field) => field.key === 'should_trigger')) {
    return incompleteBehavior('来源数据集不适用于行为验证');
  }
  const states = parse<Record<string, Partial<Record<'a' | 'b', { runs?: Array<{ status?: string; experimentCaseId?: string; score?: number }> }>>>>(task.caseStatesJson, {});
  const affected = new Set(issues.flatMap((issue) => issue.Evaluation.executionId ? [issue.Evaluation.executionId] : []));
  const affectedRows = affected.size ? await prismaRaw.experimentCase.findMany({
    where: { experimentId: source.id, executionId: { in: [...affected] }, deletedAt: null }, select: { id: true },
  }) : [];
  const affectedRowIds = new Set(affectedRows.map((row) => row.id));
  const priority = (id: string) => states[id]?.[side]?.runs?.some((run) => run.experimentCaseId && affectedRowIds.has(run.experimentCaseId)) ? 0 : 1;
  const selected = [...new Set(snapshot.caseIds)].filter((id) => {
    const item = dataset.cases.find((item) => item.id === id);
    return !item || !isTriggerCase(item);
  }).sort((a, b) => priority(a) - priority(b)).slice(0, Math.max(0, Math.floor(input.maxCases)));
  const cancelledCases = await prismaRaw.experimentCancellation.count({ where: {
    experimentId: source.id, OR: [{ caseKey: '' }, { caseKey: { in: selected.map((id) => `dataset:${id}`) } }],
  } });
  if (cancelledCases) return incompleteBehavior('来源用例已取消，不能复用其结果');
  const sourceIssues = await prismaRaw.skillIssue.findMany({
    where: { user: input.user, version: input.baseVersion, source: 'dynamic',
      Evaluation: { Skill: { name: input.skillName }, runId: { startsWith: `experiment:${source.id}:` } } },
    select: { id: true, Evaluation: { select: { executionId: true } } },
  });
  const baselineHash = await verificationRowsHash(source.id);
  const prepared = [];
  for (const id of selected) {
    const item = dataset.cases.find((item) => item.id === id);
    const runs = states[id]?.[side]?.runs;
    if (!item || isTriggerCase(item) || !runs?.length || runs.some((run) => run.status !== 'pass' || !run.experimentCaseId)) {
      return incompleteBehavior('来源用例或旧版执行未完整完成，不能复用部分结果');
    }
    const rows = await prismaRaw.experimentCase.findMany({
      where: { id: { in: runs.map((run) => run.experimentCaseId!) }, experimentId: source.id, deletedAt: null },
      include: { results: true },
    });
    const scores: number[] = [];
    const targets = new Set<string>();
    const issueIds = new Set<string>();
    for (const run of runs) {
      const row = rows.find((row) => row.id === run.experimentCaseId);
      if (!row || (row.datasetInput || row.input) !== item.input || (row.referenceOutput || '') !== item.expectedOutput || !row.actualOutput.trim()) {
        return incompleteBehavior('用例输入或标准答案已变化，旧版结果不再可比');
      }
      const results = evaluatorIds.map((id) => row.results.find((result) => result.evaluatorId === id));
      if (results.some((result) => result?.status !== 'done' || result.score == null || !Number.isFinite(result.score))) {
        return incompleteBehavior('旧版评分未完整完成，不能复用失败或未计分结果');
      }
      for (const result of results) {
        if (result!.verdict === 'fail' || result!.score === 0) targets.add(result!.evaluatorId);
      }
      for (const issue of sourceIssues) {
        if (issue.Evaluation.executionId === row.executionId) issueIds.add(issue.id);
      }
      scores.push(results.reduce((sum, result) => sum + result!.score!, 0) / results.length);
    }
    if (issueIds.size) evaluatorIds.forEach((id) => targets.add(id));
    prepared.push({ item, scores, targets, issueIds });
  }
  if (!prepared.length) return incompleteBehavior('来源实验没有有效行为用例');
  input.signal?.throwIfAborted();
  const experiment = await prismaRaw.experiment.create({ data: {
    user: input.user, name: `${source.name} · 优化行为校验`, type: 'single', agentName: source.agentName,
    evaluatorIdsJson: source.evaluatorIdsJson, evaluatorConfigsJson: source.evaluatorConfigsJson,
    scope: 'skill-workbench', skillName: input.skillName, skillVersion: input.baseVersion,
    preset: 'retest', status: 'running', sourceExperimentId: source.id, optimizationRecordId: input.optimizationRecordId,
    configSnapshotJson: JSON.stringify({ ...snapshot, caseIds: selected, grayscaleTaskId: undefined, candidateHash: verificationHash(input.candidateFiles), verificationOnly: true, verificationPurpose: input.verificationPurpose || 'optimization' }),
  } });
  const perCase: CaseVerdict[] = [];
  let executions = 0;
  const verifiedIssueIds: string[] = [];
  try {
    for (const { item, scores, targets, issueIds } of prepared) {
      if (input.budgetYuan != null && (executions + scores.length) * 0.6 > input.budgetYuan) break;
      input.onProgress?.(`行为验证 ${perCase.length + 1}/${prepared.length}：复用旧版结果，仅运行候选（原客户端与评估器）`);
      const measured: number[] = [];
      let targetMet = true;
      const feedback: string[] = [];
      for (let round = 0; round < scores.length; round++) {
        input.signal?.throwIfAborted();
        const run = await executeSkillCaseOnClient({
          user: input.user, experimentId: experiment.id, datasetId: dataset.id, datasetCaseId: item.id,
          executionTarget: snapshot.executionTarget, skill: { name: input.skillName, version: input.baseVersion + 1, files: input.candidateFiles },
          query: item.input, referenceOutput: item.expectedOutput || null,
          timeoutMs: snapshot.runtime?.timeoutMs || 600_000,
          signal: input.signal || new AbortController().signal, onCaseCreated: async () => {},
        });
        executions++;
        input.signal?.throwIfAborted();
        const results = await evaluateEvalExperimentCase(experiment.id, run.experimentCaseId, input.user, { settleExperiment: false });
        input.signal?.throwIfAborted();
        if (evaluatorIds.some((id) => !results.some((row) => row.evaluatorId === id && row.status === 'done' && row.score != null && Number.isFinite(row.score)))) {
          throw new Error('候选评分未完整完成');
        }
        for (const row of results) {
          if (targets.has(row.evaluatorId) && row.verdict !== 'pass') targetMet = false;
          if (row.verdict === 'fail' || targets.has(row.evaluatorId) && row.verdict !== 'pass') {
            const points = parse<Array<{ status?: string; label?: string; suggestion?: unknown }>>(row.pointsJson, []);
            feedback.push(`${row.evaluatorId}: ${row.summary || '目标用例未获得明确 pass 判定'}；${points.filter((point) => point.status === 'missing').map((point) => `${point.label || ''} ${typeof point.suggestion === 'string' ? point.suggestion : ''}`).join('；')}`.slice(0, 2500));
          }
        }
        measured.push(evaluatorIds.reduce((sum, id) => sum + results.find((row) => row.evaluatorId === id)!.score!, 0) / evaluatorIds.length);
      }
      const base = scores.reduce((sum, score) => sum + score, 0) / scores.length;
      const cand = measured.reduce((sum, score) => sum + score, 0) / measured.length;
      if (targetMet && cand >= base) verifiedIssueIds.push(...issueIds);
      perCase.push({ caseId: item.id, base, cand, delta: cand - base, targetMet,
        reason: feedback.length ? feedback.join('\n') : `复用来源实验 ${source.id}；候选验证 ${experiment.id}` });
    }
    const result = summarizeBehavior(perCase, prepared.length, perCase.length);
    const requiredCaseIds = [...new Set(snapshot.caseIds)].filter((id) => {
      const item = dataset.cases.find((item) => item.id === id);
      return !item || !isTriggerCase(item);
    });
    const completed = { ...result, experimentId: experiment.id, verifiedIssueIds,
      fullCoverage: !result.incomplete && selected.length === requiredCaseIds.length };
    const candidateConfig = { ...snapshot, caseIds: selected, grayscaleTaskId: undefined, candidateHash: verificationHash(input.candidateFiles), verificationOnly: true, verificationPurpose: input.verificationPurpose || 'optimization' };
    const proof = {
      candidateConfigHash: verificationHash(candidateConfig),
      version: 1, baselineHash, resultsHash: await verificationRowsHash(experiment.id), candidateHash: verificationHash(input.candidateFiles),
      sourceHash: verificationHash({ snapshot: source.configSnapshotJson, evaluators: source.evaluatorIdsJson, configs: source.evaluatorConfigsJson }),
      datasetId: dataset.id, caseIds: requiredCaseIds,
      inputHash: verificationHash(requiredCaseIds.map((id) => dataset.cases.find((item) => item.id === id))),
      result: completed,
    };
    await prismaRaw.experiment.update({ where: { id: experiment.id }, data: {
      status: result.incomplete ? 'partial' : 'done',
      configSnapshotJson: JSON.stringify({ ...candidateConfig, verification: proof }),
    } });
    return completed;
  } catch (error) {
    await prismaRaw.experiment.update({ where: { id: experiment.id }, data: { status: 'failed' } });
    input.signal?.throwIfAborted();
    return { ...incompleteBehavior(error instanceof Error ? error.message : String(error)), experimentId: experiment.id };
  }
}
