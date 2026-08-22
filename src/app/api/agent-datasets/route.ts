import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import {
  readUserAgentDatasets,
  readAgentDatasetReferences,
  readAgentDatasetSummaries,
  findAgentDataset,
  createAgentDatasetRecord,
  updateAgentDatasetRecord,
  normalizeDatasetKind,
  normalizeTags,
  normalizeFields,
  validateDatasetFieldKeysForWrite,
  duplicateDatasetFieldName,
  normalizeCases,
  prepareDatasetCasesForPersistence,
  validateCasesForKind,
  type AgentDatasetRecord,
} from '@/server/agent_datasets_storage';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { listFaultModeIds } from '@/lib/reliability/fault-modes';
import { ensureBuiltinReliabilityDataset } from '@/server/builtin-example/ensure-reliability-dataset';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const user = (searchParams.get('user') || '').trim();
    if (!user) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }

    await ensureBuiltinReliabilityDataset(user).catch(() => undefined);
    // 可选过滤：?targetSkill=<name> 拉挂在某 skill 上的；?targetSkill=__none__ 拉通用 agent eval（targetSkill === ''）。
    // 不传则全部。
    const targetSkillParam = searchParams.get('targetSkill');
    const wantedTargetSkill = targetSkillParam === null
      ? undefined
      : targetSkillParam === '__none__' ? '' : targetSkillParam.trim();
    const view = searchParams.get('view');
    if (view === 'summary') {
      return NextResponse.json(await readAgentDatasetSummaries(user, wantedTargetSkill));
    }
    if (view === 'reference') {
      return NextResponse.json(await readAgentDatasetReferences(user, wantedTargetSkill));
    }
    let datasets = await readUserAgentDatasets(user);
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
    const fieldKeyError = validateDatasetFieldKeysForWrite(body.fields);
    if (fieldKeyError) {
      return NextResponse.json({ error: fieldKeyError }, { status: 400 });
    }
    const fields = normalizeFields(body.fields, datasetKind);
    const duplicateFieldName = duplicateDatasetFieldName(fields);
    if (duplicateFieldName) {
      return NextResponse.json(
        { error: `field name ${duplicateFieldName} already exists` },
        { status: 400 },
      );
    }
    const normalizedCases = normalizeCases(body.cases);
    const allowedFaultModeIds =
      datasetKind === 'reliability' ? await listFaultModeIds() : undefined;
    const validationErrors = validateCasesForKind(normalizedCases, datasetKind, {
      allowedFaultModeIds,
    });
    if (validationErrors.length > 0) {
      return NextResponse.json(
        {
          error: validationErrors[0].message,
          details: validationErrors.map((item) => ({
            caseId: item.caseId,
            field: item.field,
          })),
        },
        { status: 422 },
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
      fields,
      cases,
      datasetKind,
      createdAt: now,
      updatedAt: now,
    };

    await createAgentDatasetRecord(dataset);

    recordUsageEvent({ user, featureKey: 'dataset', eventKey: 'dataset.create' });

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
    const fieldKeyError = validateDatasetFieldKeysForWrite(body.fields);
    if (fieldKeyError) {
      return NextResponse.json({ error: fieldKeyError }, { status: 400 });
    }
    const nextFields = body.fields !== undefined
      ? normalizeFields(body.fields, nextDatasetKind)
      : current.fields;
    const duplicateFieldName = duplicateDatasetFieldName(nextFields);
    if (duplicateFieldName) {
      return NextResponse.json(
        { error: `field name ${duplicateFieldName} already exists` },
        { status: 400 },
      );
    }
    const inputCases = body.cases !== undefined ? normalizeCases(body.cases) : current.cases;

    // datasetKind 或 cases 任一变化时都要重新校验：
    // 比如把已有 ideal_output 数据集改成 reliability，原 case 可能没有 fault_injection_type。
    if (body.cases !== undefined || body.datasetKind !== undefined) {
      const allowedFaultModeIds =
        nextDatasetKind === 'reliability' ? await listFaultModeIds() : undefined;
      const validationErrors = validateCasesForKind(inputCases, nextDatasetKind, {
        allowedFaultModeIds,
      });
      if (validationErrors.length > 0) {
        return NextResponse.json(
          {
            error: validationErrors[0].message,
            details: validationErrors.map((item) => ({
              caseId: item.caseId,
              field: item.field,
            })),
          },
          { status: 422 },
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
      fields: nextFields,
      cases: preparedCasesResult.cases,
      datasetKind: nextDatasetKind,
      updatedAt: new Date().toISOString(),
    };

    const ok = await updateAgentDatasetRecord(updated);
    if (!ok) {
      return NextResponse.json({ error: 'dataset not found' }, { status: 404 });
    }
    recordUsageEvent({ user, featureKey: 'dataset', eventKey: 'dataset.sample.update' });

    return NextResponse.json({ success: true, dataset: updated, warnings: preparedCasesResult.warnings });
  } catch (error) {
    console.error('agent-datasets PATCH error:', error);
    return NextResponse.json({ error: 'failed to update dataset' }, { status: 500 });
  }
}
