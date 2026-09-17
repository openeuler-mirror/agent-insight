import type {
  BenchmarkArtifactPresentation,
  BenchmarkPresentationColumn,
  BenchmarkPresentationFormat,
} from '../../../packages/benchmark-protocol/src/contracts';

export interface BenchmarkPresentationRecord {
  input?: unknown;
  externalCaseId?: unknown;
  values?: Record<string, unknown> | null;
  publicPayload?: unknown;
  primaryMetric?: { key?: string; value?: unknown } | null;
}

export interface BenchmarkArtifactLike {
  name: string;
  kind: string;
  mediaType: string;
  sizeBytes: number;
  contentUrl: string;
}

export interface PresentedBenchmarkArtifact<T extends BenchmarkArtifactLike = BenchmarkArtifactLike> {
  source: 'submission' | 'evidence';
  label: string;
  order: number;
  artifact: T;
}

function nestedValue(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split('.').filter(Boolean)) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function benchmarkPresentationValue(
  item: BenchmarkPresentationRecord,
  path: string,
): unknown {
  if (path === 'input') return item.input;
  if (path === 'externalCaseId') return item.externalCaseId;
  if (path.startsWith('values.')) {
    const nestedPath = path.slice('values.'.length);
    const projected = nestedValue(item.values, nestedPath);
    return projected === undefined ? nestedValue(item.publicPayload, nestedPath) : projected;
  }
  return nestedValue(item as unknown, path);
}

function compactNumber(value: number, precision?: number): string {
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: precision ?? 2,
    minimumFractionDigits: precision,
  }).format(value);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = Math.abs(value);
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  const signed = value < 0 ? -amount : amount;
  return `${compactNumber(signed, unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDuration(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return Math.abs(value) >= 1000
    ? `${compactNumber(value / 1000, 2)} s`
    : `${compactNumber(value, 0)} ms`;
}

export function benchmarkPresentationText(
  value: unknown,
  options: {
    format?: BenchmarkPresentationFormat | 'ratio';
    precision?: number;
    unit?: string;
    trueLabel?: string;
    falseLabel?: string;
    total?: number;
  } = {},
): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') {
    return value ? options.trueLabel || '是' : options.falseLabel || '否';
  }
  if (options.format === 'ratio' && options.total !== undefined) {
    return `${String(value)} / ${options.total}`;
  }
  if (typeof value === 'number') {
    let text: string;
    switch (options.format) {
      case 'percentage':
        text = `${compactNumber(value, options.precision)}%`;
        break;
      case 'bytes':
        text = formatBytes(value);
        break;
      case 'duration-ms':
        text = formatDuration(value);
        break;
      default:
        text = compactNumber(value, options.precision);
    }
    return options.unit ? `${text}${options.unit}` : text;
  }
  if (options.format === 'date-time') {
    const timestamp = new Date(String(value));
    if (!Number.isNaN(timestamp.getTime())) {
      return timestamp.toLocaleString('zh-CN', { hour12: false });
    }
  }
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function benchmarkColumnText(
  item: BenchmarkPresentationRecord,
  column: Pick<BenchmarkPresentationColumn, 'path' | 'format'>,
): string {
  return benchmarkPresentationText(benchmarkPresentationValue(item, column.path), {
    format: column.format,
  });
}

export function truncateBenchmarkText(value: string, limit?: number): string {
  if (!limit || limit < 1 || value.length <= limit) return value;
  return `${value.slice(0, limit)}…`;
}

function artifactRule(
  source: 'submission' | 'evidence',
  artifact: BenchmarkArtifactLike,
  rules: readonly BenchmarkArtifactPresentation[],
): BenchmarkArtifactPresentation | undefined {
  return rules.find((rule) => rule.source === source && rule.name === artifact.name)
    || rules.find((rule) => rule.source === source && !rule.name && rule.kind === artifact.kind);
}

export function presentBenchmarkArtifacts<T extends BenchmarkArtifactLike>(input: {
  submissions: readonly T[];
  evidence: readonly T[];
  rules?: readonly BenchmarkArtifactPresentation[];
}): PresentedBenchmarkArtifact<T>[] {
  const rules = input.rules || [];
  const artifacts = [
    ...input.submissions.map((artifact, index) => ({ source: 'submission' as const, artifact, index })),
    ...input.evidence.map((artifact, index) => ({ source: 'evidence' as const, artifact, index })),
  ];
  return artifacts
    .map((item) => {
      const rule = artifactRule(item.source, item.artifact, rules);
      return {
        source: item.source,
        artifact: item.artifact,
        label: rule?.label || item.artifact.name,
        order: rule?.order ?? Number.MAX_SAFE_INTEGER,
        index: item.index,
      };
    })
    .sort((left, right) => left.order - right.order
      || (left.source === right.source ? 0 : left.source === 'submission' ? -1 : 1)
      || left.index - right.index)
    .map((item) => ({
      source: item.source,
      label: item.label,
      order: item.order,
      artifact: item.artifact,
    }));
}

export function canPreviewBenchmarkArtifact(artifact: Pick<BenchmarkArtifactLike, 'mediaType' | 'name'>): boolean {
  return artifact.mediaType.startsWith('text/')
    || artifact.mediaType === 'application/json'
    || artifact.mediaType === 'application/pdf'
    || artifact.mediaType.startsWith('image/')
    || artifact.name.endsWith('.json')
    || artifact.name.endsWith('.diff')
    || artifact.name.endsWith('.patch');
}
