import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import {
  createAgentDatasetRecord,
  findAgentDataset,
  normalizeCase,
  updateAgentDatasetRecord,
  type AgentDatasetRecord,
  type DatasetCase,
  type DatasetField,
  type DatasetFieldType,
} from '@/server/agent_datasets_storage';

export const dynamic = 'force-dynamic';

const FIELD_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const FIELD_TYPES = new Set<DatasetFieldType>(['text', 'number', 'boolean', 'json']);

export function parseBackflowFields(
  value: unknown,
  options: { existingKeys?: Iterable<string>; allowEmpty?: boolean } = {},
): DatasetField[] {
  if (!Array.isArray(value)) throw new Error('fields are required');
  if (value.length === 0) {
    if (options.allowEmpty) return [];
    throw new Error('at least one field is required');
  }
  const seen = new Set(options.existingKeys || []);
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`field ${index + 1} is invalid`);
    }
    const raw = item as Record<string, unknown>;
    const key = String(raw.key || '').trim();
    const label = String(raw.label || '').trim();
    const type = String(raw.type || 'text') as DatasetFieldType;
    if (!FIELD_KEY_PATTERN.test(key)) throw new Error(`field ${index + 1} key is invalid`);
    if (!label) throw new Error(`field ${index + 1} label is required`);
    if (!FIELD_TYPES.has(type)) throw new Error(`field ${index + 1} type is invalid`);
    if (seen.has(key)) throw new Error(`field key ${key} already exists`);
    seen.add(key);
    return {
      id: String(raw.id || key).trim() || key,
      key,
      label,
      type,
      description: String(raw.description || '').trim() || undefined,
      system: Boolean(raw.system),
    };
  });
}

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

export function normalizeBackflowValues(
  values: Record<string, unknown>,
  fields: DatasetField[],
): Record<string, unknown> {
  const fieldByKey = new Map(fields.map(field => [field.key, field]));
  return Object.fromEntries(Object.entries(values).map(([key, value]) => {
    if (fieldByKey.get(key)?.type !== 'json' || typeof value !== 'string' || !value.trim()) {
      return [key, value];
    }
    try {
      return [key, JSON.parse(value)];
    } catch {
      throw new Error(`field ${key} must be valid JSON`);
    }
  }));
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
        const newFields = parseBackflowFields(body.newFields || [], {
          existingKeys: current.fields.map(field => field.key),
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
        rows.push(normalizeCase({
          id: randomUUID(),
          values: normalizeBackflowValues(values, fields),
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

    let dataset: AgentDatasetRecord;
    if (mode === 'existing' && current) {
      dataset = {
        ...current,
        fields,
        cases: [...current.cases, ...rows],
        updatedAt: new Date().toISOString(),
      };
      const updated = await updateAgentDatasetRecord(dataset);
      if (!updated) return NextResponse.json({ error: 'dataset not found' }, { status: 404 });
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
        cases: rows,
        datasetKind: fields.some(field => field.key === 'trace' || field.key === 'trajectory')
          ? 'trajectory'
          : 'ideal_output',
        createdAt: now,
        updatedAt: now,
      };
      await createAgentDatasetRecord(dataset);
    }

    const caseIds = rows.map(row => row.id);
    return NextResponse.json({
      success: true,
      datasetId: dataset.id,
      caseId: caseIds[0],
      caseIds,
      inserted: caseIds.length,
      addedFields: mode === 'existing' ? fields.length - (current?.fields.length || 0) : fields.length,
    });
  } catch (error) {
    console.error('agent-datasets backflow POST error:', error);
    return NextResponse.json({ error: 'failed to save trace to dataset' }, { status: 500 });
  }
}
