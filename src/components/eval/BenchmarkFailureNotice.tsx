import { benchmarkFailurePresentation } from '@/lib/benchmark/failure-presentation';

export function BenchmarkFailureNotice({
  code,
  message,
  label,
  compact = false,
}: {
  code?: string | null;
  message?: string | null;
  label?: string;
  compact?: boolean;
}) {
  const failure = benchmarkFailurePresentation(code, message);
  if (!failure) return null;
  const displayedLabel = label || failure.label;
  const displayedCode = `${failure.code || 'EXECUTION_FAILED'}${failure.originalCode ? `（原始码：${failure.originalCode}）` : ''}`;

  if (compact) {
    return (
      <div title={`${displayedLabel}（${displayedCode}）：${failure.message}`} style={{ display: 'grid', gap: 2 }}>
        <span style={{ color: 'var(--error)', fontSize: 11, fontWeight: 600 }}>{displayedLabel}</span>
        <span style={{ color: 'var(--foreground-muted)', fontSize: 10.5, fontFamily: 'var(--font-mono, monospace)' }}>
          {displayedCode}
        </span>
        {(failure.code.startsWith('MODEL_') || failure.code === 'XGOVERNOR_REJECTED') && (
          <span style={{ color: 'var(--foreground-secondary)', fontSize: 11, lineHeight: 1.5, overflowWrap: 'anywhere' }}>
            {failure.message}
          </span>
        )}
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
        {displayedLabel}
      </span>
      <span style={{ color: 'var(--foreground-secondary)', fontSize: 12, lineHeight: 1.5, overflowWrap: 'anywhere' }}>
        {failure.message}
      </span>
      <span style={{ marginLeft: 'auto', color: 'var(--error)', fontSize: 10.5, fontFamily: 'var(--font-mono, monospace)', whiteSpace: 'nowrap' }}>
        {displayedCode}
      </span>
    </div>
  );
}
