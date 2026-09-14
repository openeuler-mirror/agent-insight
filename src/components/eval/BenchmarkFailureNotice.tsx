import { benchmarkFailurePresentation } from '@/lib/benchmark/failure-presentation';

export function BenchmarkFailureNotice({
  code,
  message,
  compact = false,
}: {
  code?: string | null;
  message?: string | null;
  compact?: boolean;
}) {
  const failure = benchmarkFailurePresentation(code, message);
  if (!failure) return null;

  if (compact) {
    return (
      <div title={`${failure.label}：${failure.message}`} style={{ display: 'grid', gap: 2 }}>
        <span style={{ color: 'var(--error)', fontSize: 11, fontWeight: 600 }}>{failure.label}</span>
        <span style={{ color: 'var(--foreground-muted)', fontSize: 10.5, fontFamily: 'var(--font-mono, monospace)' }}>
          {failure.code || 'EXECUTION_FAILED'}
        </span>
      </div>
    );
  }

  return (
    <div
      role="alert"
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 14, padding: '10px 12px',
        border: '1px solid var(--error-subtle-border)', borderRadius: 9, background: 'var(--error-subtle)',
      }}
    >
      <span style={{ color: 'var(--error)', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>
        {failure.label}
      </span>
      <span style={{ color: 'var(--foreground-secondary)', fontSize: 12, lineHeight: 1.5, overflowWrap: 'anywhere' }}>
        {failure.message}
      </span>
      <span style={{ marginLeft: 'auto', color: 'var(--error)', fontSize: 10.5, fontFamily: 'var(--font-mono, monospace)', whiteSpace: 'nowrap' }}>
        {failure.code || 'EXECUTION_FAILED'}
      </span>
    </div>
  );
}
