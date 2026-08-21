/** Shared identity for the builtin reliability evaluation dataset. */
export const BUILTIN_RELIABILITY_DATASET_NAME = '可靠性故障注入评测集（内置）'

export function isBuiltinReliabilityDataset(dataset: {
  name?: string | null
  tags?: string[] | null
}): boolean {
  if (String(dataset.name || '').trim() === BUILTIN_RELIABILITY_DATASET_NAME) return true
  const tags = Array.isArray(dataset.tags) ? dataset.tags.map((t) => String(t)) : []
  return tags.includes('内置') && tags.includes('reliability')
}
