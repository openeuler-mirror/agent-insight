/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
export interface FrozenAppendCase {
  id: string;
  input: string;
  expectedOutput: string;
}

export interface FrozenAppendDataset {
  businessId: string;
  versionId: string;
  version: number;
  name: string;
  cases: FrozenAppendCase[];
  error?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

const normalized = (value: string) => value.trim().replace(/\s+/g, ' ');

export function readFrozenAppendDataset(snapshot: unknown): FrozenAppendDataset | undefined {
  const refs = record(record(snapshot).assetVersions);
  if (refs.dataset === undefined || refs.dataset === null) return undefined;
  const ref = record(refs.dataset);
  const definition = record(ref.definition);
  const rawCases = Array.isArray(definition.cases) ? definition.cases : [];
  const cases = rawCases.flatMap((item) => {
    const c = record(item);
    return typeof c.id === 'string' && c.id && typeof c.input === 'string' && normalized(c.input)
      ? [{ id: c.id, input: c.input, expectedOutput: typeof c.expectedOutput === 'string' ? c.expectedOutput : '' }]
      : [];
  });
  const valid = refs.schemaVersion === 1
    && typeof ref.businessId === 'string' && !!ref.businessId
    && typeof ref.versionId === 'string' && !!ref.versionId
    && Number.isInteger(ref.version) && Number(ref.version) > 0
    && Array.isArray(definition.cases) && cases.length === rawCases.length
    && new Set(cases.map((c) => c.id)).size === cases.length;
  return {
    businessId: String(ref.businessId || ''),
    versionId: String(ref.versionId || ''),
    version: Number(ref.version) || 0,
    name: typeof definition.name === 'string' ? definition.name : '评测集',
    cases: valid ? cases : [],
    ...(!valid ? { error: '无法读取实验固定版本，请复用配置重新确认。' } : {}),
  };
}

export function frozenAppendCandidates(dataset: FrozenAppendDataset, input: string): FrozenAppendCase[] {
  const query = normalized(input);
  return query && !dataset.error ? dataset.cases.filter((c) => normalized(c.input) === query) : [];
}

export function frozenAppendPayload(dataset: FrozenAppendDataset, selected: {
  executionId: string;
  taskId: string | null;
  input: string;
  actualOutput: string;
  referenceOutput: string | null;
  datasetCaseId?: string;
}) {
  if (!selected.datasetCaseId) throw new Error('请选择固定版本中的 Case');
  const source = dataset.cases.find((c) => c.id === selected.datasetCaseId);
  if (dataset.error || !source) throw new Error('只能追加本实验固定版本已有的 Case');
  if (!frozenAppendCandidates(dataset, selected.input).some((c) => c.id === source.id)) {
    throw new Error('Trace 输入与所选 Case 不匹配');
  }
  return {
    ...selected,
    datasetId: dataset.businessId,
    ...((selected.referenceOutput ?? '') !== source.expectedOutput
      ? { referenceOverride: { value: selected.referenceOutput, source: 'manual' as const } }
      : {}),
  };
}
