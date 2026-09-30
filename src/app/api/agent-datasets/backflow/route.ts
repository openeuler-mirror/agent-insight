import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import {
  deduplicateTraceBackflowCases,
  mapBackflowCanonicalValues,
  normalizeBackflowValues,
  parseBackflowFieldMappings,
  parseBackflowFields,
  type BackflowFieldMapping,
} from '@/lib/agent-dataset-backflow';
import {
  createAgentDatasetRecord,
  findAgentDataset,
  normalizeCase,
  updateAgentDatasetRecord,
  type AgentDatasetRecord,
  type DatasetCase,
  type DatasetField,
} from '@/server/agent_datasets_storage';
import { isBuiltinReliabilityDataset } from '@/lib/agent-dataset-builtin';

export const dynamic = 'force-dynamic';

const FIELD_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

function inferLegacyFields(candidates: unknown[]): DatasetField[] {
  const keys = new Set<string>();
  candidates.forEach(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
    const values = (candidate as Record<string, unknown>).values;
    if (!values || typeof values !== 'object' || Array.isArray(values)) return;
    Object.keys(values as Record<string, unknown>).forEach(key => {
      if (FIELD_KEY_PATTERN.test(key)) keys.add(key);
    });
  });
  return parseBackflowFields(
    [...keys].map(key => ({ key, label: key, type: key === 'trace' ? 'json' : 'text' })),
  );
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const user = String(body.user || '').trim();
    const datasetId = String(body.datasetId || '').trim();
    const datasetName = String(body.datasetName || '').trim();
    const mode = body.mode === 'existing' || body.mode === 'new'
      ? body.mode as 'existing' | 'new'
      : datasetId ? 'existing' : datasetName ? 'new' : null;
    const candidates: unknown[] = Array.isArray(body.cases)
      ? body.cases as unknown[]
      : [{ values: body.values, traceSource: body.traceSource }];
    if (!user || !mode || candidates.length === 0) {
      return NextResponse.json({ error: 'user, target mode and cases are required' }, { status: 400 });
    }
    if (mode === 'existing' && !datasetId) {
      return NextResponse.json({ error: 'datasetId is required' }, { status: 400 });
    }
    if (mode === 'new' && !datasetName) {
      return NextResponse.json({ error: 'datasetName is required' }, { status: 400 });
    }

    let current: AgentDatasetRecord | null = null;
    let fields: DatasetField[];
    try {
      if (mode === 'existing') {
        current = await findAgentDataset(user, datasetId);
        if (!current) return NextResponse.json({ error: 'dataset not found' }, { status: 404 });
        if (isBuiltinReliabilityDataset(current)) {
          return NextResponse.json(
            { error: '内置可靠性评测集由系统维护，不可写入回流数据' },
            { status: 403 },
          );
        }
        const newFields = parseBackflowFields(body.newFields || [], {
          existingKeys: current.fields.map(field => field.key),
          existingLabels: current.fields.map(field => field.label),
          allowEmpty: true,
        });
        fields = [...current.fields, ...newFields];
      } else {
        fields = Array.isArray(body.fields) && body.fields.length > 0
          ? parseBackflowFields(body.fields)
          : inferLegacyFields(candidates);
      }
    } catch (reason) {
      return NextResponse.json(
        { error: reason instanceof Error ? reason.message : 'invalid fields' },
        { status: 400 },
      );
    }

    let fieldMappings: BackflowFieldMapping[];
    try {
      fieldMappings = parseBackflowFieldMappings(body.fieldMappings, fields);
    } catch (reason) {
      return NextResponse.json(
        { error: reason instanceof Error ? reason.message : 'invalid field mappings' },
        { status: 400 },
      );
    }

    const fieldKeys = new Set(fields.map(field => field.key));
    const rows: DatasetCase[] = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const item = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
        ? candidate as Record<string, unknown>
        : {};
      const values = item.values && typeof item.values === 'object' && !Array.isArray(item.values)
        ? item.values as Record<string, unknown>
        : null;
      if (!values) {
        return NextResponse.json({ error: `case ${index + 1} values are required` }, { status: 400 });
      }
      const unknownKey = Object.keys(values).find(key => !fieldKeys.has(key));
      if (unknownKey) {
        return NextResponse.json(
          { error: `case ${index + 1} field ${unknownKey} is not defined` },
          { status: 400 },
        );
      }
      try {
        const normalizedValues = normalizeBackflowValues(values, fields);
        rows.push(normalizeCase({
          id: randomUUID(),
          ...mapBackflowCanonicalValues(normalizedValues, fieldMappings),
          values: normalizedValues,
          source: 'trace-backflow',
          traceSource: item.traceSource,
        }));
      } catch (reason) {
        return NextResponse.json(
          { error: reason instanceof Error ? reason.message : `case ${index + 1} contains invalid JSON` },
          { status: 400 },
        );
      }
    }

    const deduplicated = deduplicateTraceBackflowCases(current?.cases || [], rows);
    const rowsToInsert = deduplicated.cases;
    let dataset: AgentDatasetRecord;
    if (mode === 'existing' && current) {
      dataset = {
        ...current,
        fields: rowsToInsert.length > 0 ? fields : current.fields,
        cases: [...current.cases, ...rowsToInsert],
        updatedAt: rowsToInsert.length > 0 ? new Date().toISOString() : current.updatedAt,
      };
      if (rowsToInsert.length > 0) {
        const updated = await updateAgentDatasetRecord(dataset);
        if (!updated) return NextResponse.json({ error: 'dataset not found' }, { status: 404 });
      }
    } else {
      const now = new Date().toISOString();
      dataset = {
        id: randomUUID(),
        user,
        name: datasetName,
        description: String(body.datasetDescription || '').trim() || '从 Trace 回流创建',
        targetAgent: '',
        targetSkill: '',
        tags: ['trace-backflow'],
        fields,
        cases: rowsToInsert,
        datasetKind: fields.some(field => field.key === 'trace' || field.key === 'trajectory')
          ? 'trajectory'
          : 'ideal_output',
        createdAt: now,
        updatedAt: now,
      };
      await createAgentDatasetRecord(dataset);
    }

    const caseIds = rowsToInsert.map(row => row.id);

    // 回流一次同时构成"链路追踪→回流"与"数据集→Trace 回流"两个功能的有效使用。
    recordUsageEvent({ user, featureKey: 'trace', eventKey: 'trace.backflow' });
    recordUsageEvent({ user, featureKey: 'dataset', eventKey: 'dataset.backflow' });

    return NextResponse.json({
      success: true,
      datasetId: dataset.id,
      caseId: caseIds[0],
      caseIds,
      inserted: caseIds.length,
      skippedDuplicates: deduplicated.skippedDuplicates,
      addedFields: mode === 'existing'
        ? rowsToInsert.length > 0 ? fields.length - (current?.fields.length || 0) : 0
        : fields.length,
    });
  } catch (error) {
    console.error('agent-datasets backflow POST error:', error);
    return NextResponse.json({ error: 'failed to save trace to dataset' }, { status: 500 });
  }
}
