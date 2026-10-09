export interface RuntimeModelOption {
  id: string;
  label: string;
}

export function normalizeRuntimeModels(models: RuntimeModelOption[]): RuntimeModelOption[] {
  const normalized = new Map<string, RuntimeModelOption>();
  for (const model of models) {
    const id = model.id.trim();
    if (!id || normalized.has(id)) continue;
    normalized.set(id, { id, label: model.label.trim() || id });
  }
  return Array.from(normalized.values());
}

export function filterRuntimeModels(models: RuntimeModelOption[], query: string): RuntimeModelOption[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return models;
  return models.filter((model) => model.id.toLocaleLowerCase().includes(normalizedQuery)
    || model.label.toLocaleLowerCase().includes(normalizedQuery));
}
