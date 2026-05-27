import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import {
  readAllAgentDatasets,
  findAgentDataset,
  createAgentDatasetRecord,
  updateAgentDatasetRecord,
  normalizeDatasetKind,
  normalizeTags,
  normalizeCases,
  prepareDatasetCasesForPersistence,
  validateCasesForKind,
  type AgentDatasetRecord,
} from '@/server/agent_datasets_storage';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const user = (searchParams.get('user') || '').trim();
    if (!user) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }

    // 可选过滤：?targetSkill=<name> 拉挂在某 skill 上的；?targetSkill=__none__ 拉通用 agent eval（targetSkill === ''）。
    // 不传则全部。
    const targetSkillParam = searchParams.get('targetSkill');
    let datasets = (await readAllAgentDatasets()).filter(item => item.user === user);
    if (targetSkillParam !== null) {
      const wanted = targetSkillParam === '__none__' ? '' : targetSkillParam.trim();
      datasets = datasets.filter(d => (d.targetSkill ?? '') === wanted);
    }
    datasets.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    return NextResponse.json(datasets);
  } catch (error) {
    console.error('agent-datasets GET error:', error);
    return NextResponse.json({ error: 'failed to load datasets' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const user = String(body.user || '').trim();
    if (!user) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }

    const name = String(body.name || '').trim();
    if (!name) {
      return NextResponse.json({ error: 'dataset name is required' }, { status: 400 });
    }

    const datasetKind = normalizeDatasetKind(body.datasetKind);
    const normalizedCases = normalizeCases(body.cases);
    const validationErrors = validateCasesForKind(normalizedCases, datasetKind);
    if (validationErrors.length > 0) {
      return NextResponse.json(
        { error: validationErrors[0].message, details: validationErrors },
        { status: 400 },
      );
    }
    const { cases, warnings } = await prepareDatasetCasesForPersistence({
      nextCases: normalizedCases,
      user,
    });

    const now = new Date().toISOString();
    const dataset: AgentDatasetRecord = {
      id: randomUUID(),
      user,
      name,
      description: String(body.description || '').trim(),
      targetAgent: String(body.targetAgent || '').trim(),
      targetSkill: String(body.targetSkill || '').trim(),
      tags: normalizeTags(body.tags),
      cases,
      datasetKind,
      createdAt: now,
      updatedAt: now,
    };

    await createAgentDatasetRecord(dataset);

    return NextResponse.json({ success: true, dataset, warnings });
  } catch (error) {
    console.error('agent-datasets POST error:', error);
    return NextResponse.json({ error: 'failed to create dataset' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const user = String(body.user || '').trim();
    const id = String(body.id || '').trim();
    if (!user || !id) {
      return NextResponse.json({ error: 'user and id are required' }, { status: 400 });
    }

    const current = await findAgentDataset(user, id);
    if (!current) {
      return NextResponse.json({ error: 'dataset not found' }, { status: 404 });
    }

    const nextName = body.name !== undefined ? String(body.name || '').trim() : current.name;
    if (!nextName) {
      return NextResponse.json({ error: 'dataset name is required' }, { status: 400 });
    }

    const nextDatasetKind =
      body.datasetKind !== undefined ? normalizeDatasetKind(body.datasetKind) : current.datasetKind;
    const inputCases = body.cases !== undefined ? normalizeCases(body.cases) : current.cases;

    // datasetKind 或 cases 任一变化时都要重新校验：
    // 比如把已有 ideal_output 数据集改成 trajectory，原 case 可能没有 trajectory 字段。
    if (body.cases !== undefined || body.datasetKind !== undefined) {
      const validationErrors = validateCasesForKind(inputCases, nextDatasetKind);
      if (validationErrors.length > 0) {
        return NextResponse.json(
          { error: validationErrors[0].message, details: validationErrors },
          { status: 400 },
        );
      }
    }

    const preparedCasesResult =
      body.cases !== undefined
        ? await prepareDatasetCasesForPersistence({
            nextCases: inputCases,
            previousCases: current.cases,
            user,
          })
        : { cases: current.cases, warnings: [] };

    const updated: AgentDatasetRecord = {
      ...current,
      name: nextName,
      description: body.description !== undefined ? String(body.description || '').trim() : current.description,
      targetAgent: body.targetAgent !== undefined ? String(body.targetAgent || '').trim() : current.targetAgent,
      targetSkill: body.targetSkill !== undefined ? String(body.targetSkill || '').trim() : current.targetSkill,
      tags: body.tags !== undefined ? normalizeTags(body.tags) : current.tags,
      cases: preparedCasesResult.cases,
      datasetKind: nextDatasetKind,
      updatedAt: new Date().toISOString(),
    };

    const ok = await updateAgentDatasetRecord(updated);
    if (!ok) {
      return NextResponse.json({ error: 'dataset not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, dataset: updated, warnings: preparedCasesResult.warnings });
  } catch (error) {
    console.error('agent-datasets PATCH error:', error);
    return NextResponse.json({ error: 'failed to update dataset' }, { status: 500 });
  }
}
