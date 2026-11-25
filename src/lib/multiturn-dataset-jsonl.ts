/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { z } from 'zod';
import { conversationTurnSchema, turnExpectationSchema } from './evaluation-conversation';

const datasetHeader = z.object({
  type: z.literal('dataset'),
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1).max(50),
  description: z.string().trim().max(200).optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
}).strict();

const importedTurn = conversationTurnSchema.extend({
  id: conversationTurnSchema.shape.id.optional(),
  expectation: turnExpectationSchema.innerType().strict().pipe(turnExpectationSchema).optional(),
}).strict();

const datasetCase = z.object({
  type: z.literal('case'),
  id: z.string().trim().min(1).optional(),
  turns: z.array(importedTurn).min(2, '每个多轮用例至少需要 2 轮').max(20, '每个多轮用例最多支持 20 轮'),
}).strict();

export class DatasetJsonlError extends Error {
  constructor(public readonly line: number, public readonly field: string, message: string) {
    super(`第 ${line} 行（${field}）：${message}`);
    this.name = 'DatasetJsonlError';
  }
}

function readRecord<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, text: string, line: number): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new DatasetJsonlError(line, 'JSON', '每行必须是一个合法的 JSON 对象');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.code === 'unrecognized_keys' ? [...issue.path, issue.keys[0]] : issue.path;
    const field = path.reduce<string>((result, key) => typeof key === 'number'
      ? `${result}[${key + 1}]`
      : result ? `${result}.${key}` : key, '');
    throw new DatasetJsonlError(line, field || 'JSON', issue.message);
  }
  return parsed.data;
}

export function parseMultiturnDatasetJsonl(text: string) {
  let header: z.infer<typeof datasetHeader> | undefined;
  let headerLine = 1;
  const cases: Array<Omit<z.infer<typeof datasetCase>, 'type'>> = [];
  const caseIds = new Set<string>();

  for (const [index, raw] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const row = raw.trim();
    if (!row) continue;
    const line = index + 1;
    if (!header) {
      header = readRecord(datasetHeader, row, line);
      headerLine = line;
      continue;
    }

    const { id, turns } = readRecord(datasetCase, row, line);
    if (id && caseIds.has(id)) throw new DatasetJsonlError(line, 'id', 'Case ID 重复');
    if (id) caseIds.add(id);
    const turnIds = new Set<string>();
    for (const [turnIndex, turn] of turns.entries()) {
      const turnId = turn.id ?? `turn-${turnIndex + 1}`;
      if (turnIds.has(turnId)) throw new DatasetJsonlError(line, `turns[${turnIndex + 1}].id`, '轮次 ID 重复');
      turnIds.add(turnId);
    }
    cases.push({ id, turns });
  }

  if (!header) throw new DatasetJsonlError(1, 'type', '缺少数据集头记录');
  if (!cases.length) throw new DatasetJsonlError(headerLine, 'cases', '数据集头之后至少需要一条多轮 Case');
  const { name, description, tags } = header;
  return { name, description, tags, cases };
}
