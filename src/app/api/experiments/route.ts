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
import { overallAverage } from '@/lib/engine/experiment/detail-agg';
import { createComparisonExperiment, autoPairGroups } from '@/lib/engine/experiment/comparison-runner';

export const dynamic = 'force-dynamic';

interface CaseInput {
  executionId?: string;
  taskId?: string;
  input?: string;
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

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = url.searchParams;
    const { username } = await resolveUser(req, q.get('user'));
    const userFilter = username ? { user: username } : {};
    const listFilter = { ...userFilter, status: { not: 'draft' } };

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
        status: r.status,
        watchMode: r.watchMode,
        caseCount: r._count.cases,
        evaluatorCount,
        overallScore: overallAverage(scoreRowsByExperiment.get(r.id) || []),
        createdAt: r.createdAt,
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

    const name = String(body.name || '').trim();
    const agentName = String(body.agentName || '').trim();
    const watchMode = body.watchMode === true;
    const type = String(body.type || 'single');
    const evaluatorIds: string[] = Array.isArray(body.evaluatorIds)
      ? body.evaluatorIds.map((id: unknown) => String(id)).filter(Boolean)
      : [];

    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (evaluatorIds.length < 1) {
      return NextResponse.json({ error: 'at least one evaluator is required' }, { status: 400 });
    }

    // 对比实验：type='llm' → createComparisonExperiment + autoPairGroups
    if (type === 'llm') {
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
        status: 'draft',
        watchMode,
        watchEnabledAt: watchMode ? new Date() : null,
        cases: {
          create: normalizedCases.map((c) => ({
            executionId: c.executionId ? String(c.executionId) : null,
            taskId: c.taskId ? String(c.taskId) : null,
            input: String(c.input ?? ''),
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
