/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

export interface WizardAssetVersionRefs {
  agent?: string;
  dataset?: string;
  evaluators?: Record<string, string>;
}

export interface WizardDatasetVersionSelection {
  businessId: string;
  versionId: string;
  content: Record<string, unknown>;
}

export function mergeWizardDatasetVersion<T extends { id: string }>(source: T | null, selection: WizardDatasetVersionSelection | null): T | null {
  if (!source || source.id !== selection?.businessId) return source;
  return { ...source, ...selection.content, id: source.id };
}

export function readReusableAssetVersionRefs(value: unknown): WizardAssetVersionRefs {
  if (!value || typeof value !== 'object') return {};
  const source = value as Record<string, unknown>;
  const versionId = (ref: unknown): string | undefined => {
    if (typeof ref === 'string') return ref.trim() || undefined;
    if (!ref || typeof ref !== 'object') return undefined;
    const id = (ref as Record<string, unknown>).versionId;
    return typeof id === 'string' ? id.trim() || undefined : undefined;
  };
  const agent = versionId(source.agent), dataset = versionId(source.dataset);
  const evaluators = source.evaluators && typeof source.evaluators === 'object'
    ? Object.fromEntries(Object.entries(source.evaluators).flatMap(([key, value]) => {
      const id = versionId(value);
      return id ? [[key, id]] : [];
    })) : {};
  return { ...(agent ? { agent } : {}), ...(dataset ? { dataset } : {}), ...(Object.keys(evaluators).length ? { evaluators } : {}) };
}

export async function validateReusableTraceIds(ids: string[], load: (id: string) => Promise<readonly { id: string }[]>): Promise<void> {
  const remaining = Array.from(new Set(ids));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, remaining.length) }, async () => {
    while (next < remaining.length) {
      const id = remaining[next++];
      const rows = await load(id);
      if (!rows.some(row => row.id === id)) throw new Error(`原实验 Trace ${id} 已删除或无权访问，请重新确认 Case；不会替换为其他 Trace。`);
    }
  }));
}
