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

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import { resolveUser } from '@/lib/auth/auth';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { addEvalExperimentCase, evaluateEvalExperimentCase } from '@/lib/engine/experiment/run-experiment';
import { assertExperimentActive } from '@/lib/engine/experiment/cancellation-context';
import { EvaluationAssetError } from '@/lib/evaluation-assets/types';
import { requireExperimentVersionActor } from '@/lib/evaluation-assets/experiment-versions';
import { appendVersionedCases, frozenAppendDataset, type CaseInput } from '@/lib/evaluation-assets/append-experiment-cases';
export const dynamic = 'force-dynamic';

/** 单次追加上限：与向导跨页全选的 SELECT_ALL_CAP 同量级，避免一次灌爆评测队列。 */
const MAX_CASES_PER_CALL = 200;

function parse(value: string | null): Record<string, unknown> {
  try { const parsed = JSON.parse(value || '{}'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const { username } = await resolveUser(req, body?.user);
    if (!username) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }

    const cases: CaseInput[] = Array.isArray(body?.cases) ? body.cases : [];
    if (!cases.length) {
      return NextResponse.json({ error: 'at least one case is required' }, { status: 400 });
    }
    if (cases.length > MAX_CASES_PER_CALL) {
      return NextResponse.json(
        { error: `一次最多追加 ${MAX_CASES_PER_CALL} 条 case` },
        { status: 400 },
      );
    }
    // 默认追加即评（用户在详情页点"新增"就是想看结果）；传 false 只入库不评。
    const autoRun = body?.autoRun !== false;

    const experiment = await prisma.experiment.findFirst({
      where: { id, user: username },
      select: { id: true, evaluatorIdsJson: true, agentName: true, configSnapshotJson: true, deletedAt: true, status: true },
    });
    if (!experiment) {
      return NextResponse.json({ error: 'experiment not found' }, { status: 404 });
    }
    let evaluatorIds: string[] = [];
    try {
      const parsed = JSON.parse(experiment.evaluatorIdsJson || '[]');
      if (Array.isArray(parsed)) evaluatorIds = parsed.map(String).filter(Boolean);
    } catch { /* 忽略脏数据 */ }
    const snapshot = parse(experiment.configSnapshotJson);
    if (snapshot.assetVersions) await requireExperimentVersionActor(req, username);
    const frozen = frozenAppendDataset(snapshot);
    if (frozen) {
      const outcome = await appendVersionedCases(username, experiment, cases, frozen, autoRun, evaluatorIds);
      if (outcome.evaluating) void (async () => {
        for (const caseId of outcome.newCaseIds) {
          try { await assertExperimentActive(experiment.id, caseId); await evaluateEvalExperimentCase(experiment.id, caseId, username); }
          catch (error) { console.warn('[experiment-cases] versioned evaluation stopped', error instanceof Error ? error.message : 'evaluation failed'); }
        }
      })();

      if (outcome.added) recordUsageEvent({ user: username, featureKey: 'experiments', eventKey: 'experiment.case.create' });
      return NextResponse.json(outcome);
    }
    if (autoRun && !evaluatorIds.length) {
      return NextResponse.json({ error: '该实验未配置评估器，无法评测新增 case' }, { status: 409 });
    }

    // 已在本实验里的 trace 会被 addEvalExperimentCase 按 taskId 复用而非新建，
    // 先记下来好如实回报"新增 N 条、复用 M 条"，别把复用也报成新增。
    const incomingTaskIds = cases.map((c) => (c.taskId ? String(c.taskId) : '')).filter(Boolean);
    const existingTaskIds = new Set(
      incomingTaskIds.length
        ? (await prisma.experimentCase.findMany({
            where: { experimentId: id, taskId: { in: incomingTaskIds } },
            select: { taskId: true },
          })).map((r: { taskId: string | null }) => r.taskId ?? '')
        : [],
    );

    const caseIds: string[] = [];
    for (const c of cases) {
      const caseId = await addEvalExperimentCase(id, {
        executionId: c.executionId ? String(c.executionId) : null,
        taskId: c.taskId ? String(c.taskId) : null,
        input: String(c.input ?? ''),
        datasetInput:
          c.datasetInput != null && String(c.datasetInput).trim() !== ''
            ? String(c.datasetInput)
            : null,
        actualOutput: String(c.actualOutput ?? ''),
        referenceOutput:
          c.referenceOutput != null && String(c.referenceOutput).trim() !== ''
            ? String(c.referenceOutput)
            : null,
      });
      caseIds.push(caseId);
    }
    const reused = incomingTaskIds.filter((t) => existingTaskIds.has(t)).length;

    if (autoRun) {
      // 先把全部新行建成 pending 再开跑：evaluateEvalExperimentCase 每评完一条都会调
      // settleExperimentStatus，若后续 case 的行还没建出来，它会看到"无待执行行"从而
      // 提前把实验落成 done，进度条在 done/running 之间来回跳。
      await prisma.$transaction(
        caseIds.flatMap((caseId) =>
          evaluatorIds.map((evaluatorId) =>
            prisma.experimentEvalResult.upsert({
              where: { caseId_evaluatorId: { caseId, evaluatorId } },
              create: { experimentId: id, caseId, evaluatorId, status: 'pending' },
              update: { status: 'pending' },
              select: { id: true },
            }),
          ),
        ),
      );
      await prisma.experiment.update({ where: { id }, data: { status: 'running' } });

      // 逐条串行评（evaluateEvalExperimentCase 内部本就是同步跑完一条），后台推进；
      // 单条失败不影响后续——executeResultRow 已把失败写成该行的终态。
      void (async () => {
        for (const caseId of caseIds) {
          try {
            await evaluateEvalExperimentCase(id, caseId, username);
          } catch (e) {
            console.warn(`[experiment-cases] eval failed exp=${id} case=${caseId}:`, (e as Error)?.message);
          }
        }
      })();
    }

    recordUsageEvent({ user: username, featureKey: 'experiments', eventKey: 'experiment.case.create' });

    return NextResponse.json({
      added: caseIds.length - reused,
      reused,
      caseIds,
      evaluating: autoRun,
    });
  } catch (error) {
    if (error instanceof EvaluationAssetError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    console.error('[Experiment Cases POST Error]', error);
    return NextResponse.json({ error: 'Failed to add cases' }, { status: 500 });
  }
}
