import { createHash } from 'node:crypto';

export function datasetCaseContentHash(item: { input: string; expectedOutput?: string; values?: Record<string, unknown>; evaluationFocus?: string }) {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
    return value;
  }
  return createHash('sha256').update(JSON.stringify(canonical({
    schemaVersion: 1, input: item.input, expectedOutput: item.expectedOutput ?? '',
    values: item.values ?? {}, evaluationFocus: item.evaluationFocus ?? '',
  }))).digest('hex');
}

export function matchesLegacyDatasetText(stored: string, original: string) {
  // Older dataset imports stored exactly this lossy transformation.
  return stored === original || stored === original.trim().replace(/\s+/g, ' ');
}
