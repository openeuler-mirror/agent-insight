export interface TraceTagCluster<T> {
  key: string;
  prefix: string | null;
  tags: T[];
  usageCount: number;
}

export interface TraceTagFitOptions {
  availableWidth: number;
  tagWidths: readonly number[];
  overflowWidths: readonly number[];
  gap?: number;
  minimumTagWidth?: number;
}

export function fitTraceTagCount({
  availableWidth,
  tagWidths,
  overflowWidths,
  gap = 4,
  minimumTagWidth = 48,
}: TraceTagFitOptions): number {
  const total = tagWidths.length;
  if (total === 0 || availableWidth <= 0) return 0;

  for (let visibleCount = total; visibleCount >= 0; visibleCount -= 1) {
    const hiddenCount = total - visibleCount;
    const tagWidth = tagWidths
      .slice(0, visibleCount)
      .reduce((sum, width) => sum + Math.min(Math.max(0, width), minimumTagWidth), 0);
    const overflowWidth = hiddenCount > 0 ? Math.max(0, overflowWidths[hiddenCount] ?? 0) : 0;
    const itemCount = visibleCount + (hiddenCount > 0 ? 1 : 0);
    const requiredWidth = tagWidth + overflowWidth + Math.max(0, itemCount - 1) * gap;

    if (requiredWidth <= availableWidth) return visibleCount;
  }

  return 0;
}

export function extractTraceTagPrefix(name: string): string | null {
  const normalized = name.trim();
  const separators = [normalized.indexOf('_'), normalized.indexOf('-')]
    .filter(index => index > 0);
  if (separators.length === 0) return null;
  const prefix = normalized.slice(0, Math.min(...separators)).trim();
  return prefix || null;
}

export function clusterTraceTagsByPrefix<T extends { name: string; usageCount?: number | null }>(
  tags: readonly T[],
  locale = 'zh',
): TraceTagCluster<T>[] {
  const clusters = new Map<string, TraceTagCluster<T>>();
  for (const tag of tags) {
    const prefix = extractTraceTagPrefix(tag.name);
    const key = prefix === null ? '__ungrouped__' : prefix;
    const cluster = clusters.get(key) ?? { key, prefix, tags: [], usageCount: 0 };
    cluster.tags.push(tag);
    cluster.usageCount += Number(tag.usageCount) || 0;
    clusters.set(key, cluster);
  }

  return Array.from(clusters.values())
    .map(cluster => ({
      ...cluster,
      tags: cluster.tags.slice().sort((left, right) => (
        left.name.replace(/[_-]/g, ' ').localeCompare(
          right.name.replace(/[_-]/g, ' '),
          locale,
          { numeric: true, sensitivity: 'base' },
        )
      )),
    }))
    .sort((left, right) => {
      if (left.prefix === null) return 1;
      if (right.prefix === null) return -1;
      return left.prefix.localeCompare(right.prefix, locale, { numeric: true, sensitivity: 'base' });
    });
}
