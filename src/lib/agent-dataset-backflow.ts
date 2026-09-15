import {
  defaultTraceBackflowSourceForField,
  type TraceBackflowArtifactSource,
} from '@/lib/agent-dataset-model';
import type { DatasetField, DatasetFieldType } from '@/server/agent_datasets_storage';

const FIELD_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const FIELD_TYPES = new Set<DatasetFieldType>(['text', 'number', 'boolean', 'json']);
const ARTIFACT_SOURCES = new Set<TraceBackflowArtifactSource>(['input', 'output', 'trace', 'none']);

export interface BackflowFieldMapping {
  key: string;
  source: TraceBackflowArtifactSource;
}

export function parseBackflowFields(
  value: unknown,
  options: {
    existingKeys?: Iterable<string>;
    existingLabels?: Iterable<string>;
    allowEmpty?: boolean;
  } = {},
): DatasetField[] {
  if (!Array.isArray(value)) throw new Error('fields are required');
  if (value.length === 0) {
    if (options.allowEmpty) return [];
    throw new Error('at least one field is required');
  }
  const seen = new Set(options.existingKeys || []);
  const seenLabels = new Set(
    [...(options.existingLabels || [])].map(label => label.trim().toLocaleLowerCase()),
  );
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
    const normalizedLabel = label.toLocaleLowerCase();
    if (seenLabels.has(normalizedLabel)) throw new Error(`field name ${label} already exists`);
    seen.add(key);
    seenLabels.add(normalizedLabel);
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

export function parseBackflowFieldMappings(
  value: unknown,
  fields: DatasetField[],
): BackflowFieldMapping[] {
  if (value === undefined || value === null) {
    return fields.map(field => ({
      key: field.key,
      source: defaultTraceBackflowSourceForField(field.key),
    }));
  }
  if (!Array.isArray(value)) throw new Error('fieldMappings must be an array');
  const fieldKeys = new Set(fields.map(field => field.key));
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`field mapping ${index + 1} is invalid`);
    }
    const raw = item as Record<string, unknown>;
    const key = String(raw.key || '').trim();
    const source = String(raw.source || 'none') as TraceBackflowArtifactSource;
    if (!fieldKeys.has(key)) throw new Error(`field mapping ${key || index + 1} is not defined`);
    if (seen.has(key)) throw new Error(`field mapping ${key} already exists`);
    if (!ARTIFACT_SOURCES.has(source)) throw new Error(`field mapping ${key} source is invalid`);
    seen.add(key);
    return { key, source };
  });
}

function firstMappedValue(
  values: Record<string, unknown>,
  mappings: BackflowFieldMapping[],
  source: Exclude<TraceBackflowArtifactSource, 'none'>,
): unknown {
  const mapping = mappings.find(item => item.source === source && Object.hasOwn(values, item.key));
  return mapping ? values[mapping.key] : undefined;
}

export function mapBackflowCanonicalValues(
  values: Record<string, unknown>,
  mappings: BackflowFieldMapping[],
): { input?: unknown; expectedOutput?: unknown; trajectory?: unknown } {
  const input = firstMappedValue(values, mappings, 'input');
  const expectedOutput = firstMappedValue(values, mappings, 'output');
  const trajectory = firstMappedValue(values, mappings, 'trace');
  return {
    ...(input !== undefined ? { input } : {}),
    ...(expectedOutput !== undefined ? { expectedOutput } : {}),
    ...(trajectory !== undefined ? { trajectory } : {}),
  };
}
