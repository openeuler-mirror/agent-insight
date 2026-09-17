// 评测「实验」API —— 列表 + 创建（单组 type='single' + LLM 对比 type='llm'）。
// 对比类型：createComparisonExperiment + autoPairGroups（跳过 case 校验，case 由配对产生）。
import { NextResponse } from 'next/server';
import type { Experiment } from '@prisma/client';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { prisma } from '@/lib/storage/prisma';
import { resolveUser } from '@/lib/auth/auth';
import {
  EvaluatorContextValidationError,
  serializeEvaluatorCaseContext,
} from '@/lib/evaluators/evaluator-case-context';
import {
  EvaluatorRunConfigValidationError,
  serializeEvaluatorRunConfigs,
} from '@/lib/evaluators/evaluator-run-config';
import {
  normalizeTerminalExperimentStatus,
  publishedOverallAverage,
} from '@/lib/engine/experiment/detail-agg';
import { createComparisonExperiment, autoPairGroups } from '@/lib/engine/experiment/comparison-runner';
import { benchmarkErrorResponse } from '@/lib/benchmark/api-error';
import { createBenchmarkExperiment } from '@/lib/benchmark/experiment-service';
import { presetEvaluators } from '@/lib/evaluators/preset-evaluators';
import { getEvaluatorMeta } from '@/lib/evaluators/registry';
import type { EvaluatorCard } from '@/lib/evaluators/custom-evaluator-model';
import { readUserCustomEvaluators } from '@/server/user_evaluators_storage';
import { cloneExperimentFromFrozenConfig } from '@/lib/engine/experiment/reuse-config';
import { benchmarkDatasetOwners } from '@/lib/benchmark/dataset-ownership';
import { benchmarkEvaluatorId } from '@/lib/benchmark/adapter-registry';

export const dynamic = 'force-dynamic';

interface CaseInput {
  executionId?: string;
  taskId?: string;
  input?: string;
  datasetInput?: string | null;
  actualOutput?: string;
  referenceOutput?: string | null;
  evaluatorContext?: unknown;
  /** IF-M02：可靠性 case 的故障模式 id，落盘到 ExperimentCase.faultInjectionType */
  faultInjectionType?: string;
  values?: Record<string, unknown>;
}

interface ExperimentScoreRow {
  experimentId: string
  caseId: string
  evaluatorId: string
  status: string
  score: number | null
  humanScore: number | null
}

async function benchmarkEvaluatorIds(user: string, rawIds: unknown, adapterKey: string): Promise<string[]> {
  const requested = Array.isArray(rawIds)
    ? rawIds.map(String).map((id) => id.trim()).filter(Boolean)
    : [];
  const catalog = new Map<string, EvaluatorCard>();
  for (const card of presetEvaluators) catalog.set(card.id, card);
  for (const card of await readUserCustomEvaluators(user) as EvaluatorCard[]) {
    if (card && typeof card === 'object' && card.id) catalog.set(card.id, card);
  }
  const officialEvaluatorId = benchmarkEvaluatorId(adapterKey);
  const selected = new Set<string>([officialEvaluatorId]);
  for (const id of requested) {
    if (id === officialEvaluatorId) continue;
    if (id.startsWith('benchmark:')) {
      throw new Error(`Benchmark 实验不支持评估器 ${id}`);
    }
    const card = catalog.get(id);
    if (!card || card.status !== 'ready') throw new Error(`评估器 ${id} 不存在或未就绪`);
    if (getEvaluatorMeta(card).requires.includes('reference')) {
      throw new Error(`评估器「${card.name}」依赖预期输出，不能用于 Benchmark 数据集`);
    }
    selected.add(id);
  }
  return Array.from(selected);
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = url.searchParams;
    const { username } = await resolveUser(req, q.get('user'));
    const skillName = String(q.get('skillName') || '').trim();
    const userFilter = username ? { user: username } : {};
    const listFilter = {
      ...userFilter,
      ...(skillName ? { skillName } : {}),
      scope: { notIn: ['skill-workbench', 'skill-case-analysis', 'grayscale-ab'] },
      status: { not: 'draft' },
    };

    const limit = Math.min(Math.max(Number(q.get('limit')) || 20, 1), 100);
    const offset = Math.max(Number(q.get('offset')) || 0, 0);

    const [total, rawRows] = await Promise.all([
      prisma.experiment.count({ where: listFilter }),
      prisma.experiment.findMany({
        where: listFilter,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: { _count: { select: { cases: true } } },
      }),
    ]);
    const rows = rawRows as Array<Experiment & { _count: { cases: number } }>;
    const experimentIds = rows.map((row) => row.id);
    const scoreRows = (experimentIds.length
      ? await prisma.experimentEvalResult.findMany({
          where: { experimentId: { in: experimentIds } },
          select: {
            experimentId: true,
            caseId: true,
            evaluatorId: true,
            status: true,
            score: true,
            humanScore: true,
          },
        })
      : []) as ExperimentScoreRow[];
    const scoreRowsByExperiment = new Map<string, ExperimentScoreRow[]>();
    for (const row of scoreRows) {
      const list = scoreRowsByExperiment.get(row.experimentId) || [];
      list.push(row);
      scoreRowsByExperiment.set(row.experimentId, list);
    }

    const items = rows.map((r) => {
      const resultRows = scoreRowsByExperiment.get(r.id) || [];
      const status = normalizeTerminalExperimentStatus(r.status, resultRows);
      let evaluatorCount = 0;
      try {
        const ids = JSON.parse(r.evaluatorIdsJson || '[]');
        evaluatorCount = Array.isArray(ids) ? ids.length : 0;
      } catch { /* 忽略脏数据 */ }
      return {
        id: r.id,
        name: r.name,
        type: r.type,
        agentName: r.agentName,
        status,
        watchMode: r.watchMode,
        scope: r.scope,
        skillName: r.skillName,
        skillVersion: r.skillVersion,
        preset: r.preset,
        caseCount: r._count.cases,
        evaluatorCount,
        overallScore: publishedOverallAverage(status, resultRows),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });

    return NextResponse.json({ items, total, limit, offset });
  } catch (error) {
    console.error('[Experiments GET Error]', error);
    return NextResponse.json({ error: 'Failed to load experiments' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { username } = await resolveUser(req, body.user);
    if (!username) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }

    if (body.createMode === 'same-config') {
      const sourceExperimentId = String(body.sourceExperimentId || '').trim();
      if (!sourceExperimentId) {
        return NextResponse.json({ error: 'sourceExperimentId is required' }, { status: 400 });
      }
      try {
        const cloned = await cloneExperimentFromFrozenConfig({ sourceExperimentId, user: username });
        recordUsageEvent({ user: username, featureKey: 'experiments', eventKey: 'experiment.create' });
        return NextResponse.json(cloned, { status: 201 });
      } catch (error) {
        const message = error instanceof Error ? error.message : '复制实验配置失败';
        return NextResponse.json({ error: message }, { status: message === 'source experiment not found' ? 404 : 409 });
      }
    }

    const agentEvalDatasetId = String(body.datasetId || '').trim();
    const publicBenchmarkDataset = agentEvalDatasetId
      ? await prisma.agentEvalDataset.findFirst({
          where: {
            id: agentEvalDatasetId,
            user: { in: benchmarkDatasetOwners(username) },
            datasetKind: 'benchmark',
          },
          include: { benchmarkDataset: true },
        })
      : null;
    if (publicBenchmarkDataset) {
      try {
        if (!publicBenchmarkDataset.benchmarkDataset || publicBenchmarkDataset.benchmarkDataset.status !== 'ready') {
          return NextResponse.json({ error: 'Benchmark 数据集尚未就绪' }, { status: 409 });
        }
        if (body.traceSource !== 'generate' || body.watchMode === true || body.type === 'llm') {
          return NextResponse.json(
            { error: 'Benchmark 数据集只支持单组实验并生成新 Trace' },
            { status: 400 },
          );
        }
        const executionTarget = body.executionTarget && typeof body.executionTarget === 'object'
          ? body.executionTarget as Record<string, unknown>
          : {};
        const agentName = String(body.agentName || '').trim();
        const evaluatorIds = await benchmarkEvaluatorIds(
          username,
          body.evaluatorIds,
          publicBenchmarkDataset.benchmarkDataset.adapterKey,
        );
        const caseIds = Array.isArray(body.datasetCaseIds)
          ? body.datasetCaseIds.map(String).filter(Boolean)
          : [];
        const result = await createBenchmarkExperiment({
          user: username,
          name: String(body.name || ''),
          agentName,
          datasetId: publicBenchmarkDataset.benchmarkDataset.id,
          agentEvalDatasetId,
          caseSelection: caseIds.length
            ? { mode: 'explicit', caseIds }
            : { mode: 'all' },
          clientId: String(executionTarget.workerId || ''),
          evaluatorIds,
          runConfig: {
            platform: String(executionTarget.platform || ''),
            agent: agentName,
            model: executionTarget.model ? String(executionTarget.model) : undefined,
            agentTimeoutSeconds: body.agentTimeoutSeconds == null
              ? undefined
              : Number(body.agentTimeoutSeconds),
            maxParallelAgentCases: 1,
          },
        });
        recordUsageEvent({ user: username, featureKey: 'experiments', eventKey: 'experiment.create' });
        return NextResponse.json(result, { status: 201 });
      } catch (error) {
        if (error instanceof Error && !('code' in error)) {
          return NextResponse.json({ error: error.message }, { status: 400 });
        }
        return benchmarkErrorResponse(error, 'benchmark/experiments/create-shared');
      }
    }

    if (body.scope === 'benchmark') {
      try {
        const benchmark = body.benchmark && typeof body.benchmark === 'object'
          ? body.benchmark as Record<string, unknown>
          : {};
        const executionTarget = benchmark.executionTarget
          && typeof benchmark.executionTarget === 'object'
          ? benchmark.executionTarget as Record<string, unknown>
          : {};
        const runConfig = benchmark.runConfig && typeof benchmark.runConfig === 'object'
          ? benchmark.runConfig as Record<string, unknown>
          : {};
        const rawSelection = benchmark.caseSelection && typeof benchmark.caseSelection === 'object'
          ? benchmark.caseSelection as Record<string, unknown>
          : { mode: 'all' };
        if (!['all', 'explicit'].includes(String(rawSelection.mode || ''))) {
          return NextResponse.json(
            { error: { code: 'CASE_SELECTION_INVALID', message: 'caseSelection.mode 只支持 all 或 explicit' } },
            { status: 400 },
          );
        }
        const caseSelection = rawSelection.mode === 'explicit'
          ? {
              mode: 'explicit' as const,
              caseIds: Array.isArray(rawSelection.caseIds)
                ? rawSelection.caseIds.map((id) => String(id))
                : [],
            }
          : { mode: 'all' as const };
        const result = await createBenchmarkExperiment({
          user: username,
          name: String(body.name || ''),
          agentName: body.agentName ? String(body.agentName) : undefined,
          datasetId: String(benchmark.datasetId || ''),
          caseSelection,
          clientId: String(executionTarget.clientId || ''),
          runConfig: {
            platform: String(runConfig.platform || ''),
            agent: String(runConfig.agent || ''),
            model: runConfig.model ? String(runConfig.model) : undefined,
            agentTimeoutSeconds: runConfig.agentTimeoutSeconds == null
              ? undefined
              : Number(runConfig.agentTimeoutSeconds),
            maxParallelAgentCases: runConfig.maxParallelAgentCases == null
              ? undefined
              : Number(runConfig.maxParallelAgentCases),
          },
          evaluatorIds: Array.isArray(body.evaluatorIds) ? body.evaluatorIds.map(String) : undefined,
        });
        recordUsageEvent({ user: username, featureKey: 'experiments', eventKey: 'experiment.create' });
        return NextResponse.json(result, { status: 201 });
      } catch (error) {
        return benchmarkErrorResponse(error, 'benchmark/experiments/create');
      }
    }

    const name = String(body.name || '').trim();
    const agentName = String(body.agentName || '').trim();
    const watchMode = body.watchMode === true;
    const type = String(body.type || 'single');
    const evaluatorIds: string[] = Array.isArray(body.evaluatorIds)
      ? body.evaluatorIds.map((id: unknown) => String(id)).filter(Boolean)
      : [];
    const scope = body.scope === 'skill-workbench' ? 'skill-workbench' : '';
    const skillName = scope ? String(body.skillName || '').trim() : '';
    const skillVersion = scope && Number.isInteger(Number(body.skillVersion))
      ? Number(body.skillVersion)
      : null;
    const preset = scope && ['trigger', 'use-case'].includes(String(body.preset || ''))
      ? String(body.preset)
      : null;
    const skillContext = body.skillContext && typeof body.skillContext === 'object' && !Array.isArray(body.skillContext)
      ? body.skillContext
      : null;
    const configSnapshot = body.configSnapshot && typeof body.configSnapshot === 'object' && !Array.isArray(body.configSnapshot)
      ? body.configSnapshot
      : null;

    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (evaluatorIds.length < 1) {
      return NextResponse.json({ error: 'at least one evaluator is required' }, { status: 400 });
    }
    if (evaluatorIds.some((id) => id.startsWith('benchmark:'))) {
      return NextResponse.json(
        { error: 'Benchmark Evaluator 只能用于 Benchmark 数据集' },
        { status: 400 },
      );
    }
    if (scope && (!skillName || skillVersion == null || !preset)) {
      return NextResponse.json({ error: 'Skill 实验缺少 Skill、版本或预设上下文' }, { status: 400 });
    }

    // 对比实验：type='llm' → createComparisonExperiment + autoPairGroups
    if (type === 'llm') {
      if (scope) {
        return NextResponse.json({ error: 'Skill 实验不支持通用 LLM 对比类型' }, { status: 400 });
      }
      if (watchMode) {
        return NextResponse.json({ error: 'comparison experiment does not support watchMode' }, { status: 400 });
      }
      const groups = Array.isArray(body.groups) ? body.groups : [];
      if (groups.length < 2) {
        return NextResponse.json({ error: 'comparison experiment requires at least 2 groups' }, { status: 400 });
      }
      try {
        const { id } = await createComparisonExperiment({
          user: username, name, agentName,
          variableDimension: String(body.variableDimension || 'llm'),
          groups: groups.map((g: { key?: unknown; value?: unknown }) => ({
            key: String(g.key ?? ''),
            value: String(g.value ?? ''),
          })),
          evaluatorIds,
        });
        if (configSnapshot) {
          await prisma.experiment.update({
            where: { id },
            data: { configSnapshotJson: JSON.stringify(configSnapshot) },
          });
        }
        // autoPairGroups 查候选 trace + 为可比配对创建 case
        await autoPairGroups(id);
        return NextResponse.json({ id });
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'comparison creation failed';
        return NextResponse.json({ error: msg }, { status: 400 });
      }
    }

    // 单组实验（type 缺省='single'）
    const cases: CaseInput[] = Array.isArray(body.cases) ? body.cases : [];
    // 监听模式允许 0 条 case 起步（纯监听，后续该 Agent 新 trace 自动进来评）
    if (!watchMode && cases.length < 1) {
      return NextResponse.json({ error: 'at least one case is required' }, { status: 400 });
    }
    if (watchMode && !agentName) {
      return NextResponse.json({ error: 'watch mode requires agentName' }, { status: 400 });
    }

    let evaluatorConfigsJson: string;
    try {
      evaluatorConfigsJson = serializeEvaluatorRunConfigs(body.evaluatorConfigs, evaluatorIds);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid evaluatorConfigs';
      return NextResponse.json(
        { error: error instanceof EvaluatorRunConfigValidationError ? message : 'invalid evaluatorConfigs' },
        { status: 400 },
      );
    }

    let normalizedCases: Array<Omit<CaseInput, 'faultInjectionType'> & {
      evaluatorContextJson: string | null
      faultInjectionType: string | null
      caseValuesJson: string | null
    }>;
    try {
      normalizedCases = cases.map((item) => {
        const evaluatorContextJson = serializeEvaluatorCaseContext(item.evaluatorContext);
        const fault =
          (typeof item.faultInjectionType === 'string' && item.faultInjectionType.trim()) ||
          (typeof item.values?.fault_injection_type === 'string'
            ? String(item.values.fault_injection_type).trim()
            : '') ||
          null;
        const caseValuesJson =
          item.values && typeof item.values === 'object'
            ? JSON.stringify({
                ...item.values,
                ...(fault ? { fault_injection_type: fault } : {}),
              })
            : null;
        const { faultInjectionType: _ignoredFault, ...rest } = item;
        void _ignoredFault;
        return {
          ...rest,
          evaluatorContextJson,
          faultInjectionType: fault,
          caseValuesJson,
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid evaluatorContext';
      return NextResponse.json(
        { error: error instanceof EvaluatorContextValidationError ? message : 'invalid evaluatorContext' },
        { status: 400 },
      );
    }

    const experiment = await prisma.experiment.create({
      data: {
        user: username,
        name,
        type: 'single',
        agentName,
        evaluatorIdsJson: JSON.stringify(evaluatorIds),
        evaluatorConfigsJson,
        status: 'draft',
        scope,
        skillName,
        skillVersion,
        preset,
        skillContextJson: skillContext ? JSON.stringify(skillContext) : null,
        configSnapshotJson: configSnapshot ? JSON.stringify(configSnapshot) : null,
        watchMode,
        watchEnabledAt: watchMode ? new Date() : null,
        cases: {
          create: normalizedCases.map((c) => ({
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
            evaluatorContextJson: c.evaluatorContextJson,
            faultInjectionType: c.faultInjectionType,
            caseValuesJson: c.caseValuesJson,
          })),
        },
      },
      select: { id: true },
    });

    recordUsageEvent({ user: username, featureKey: 'experiments', eventKey: 'experiment.create' });

    return NextResponse.json({ id: experiment.id });
  } catch (error) {
    console.error('[Experiments POST Error]', error);
    return NextResponse.json({ error: 'Failed to create experiment' }, { status: 500 });
  }
}
