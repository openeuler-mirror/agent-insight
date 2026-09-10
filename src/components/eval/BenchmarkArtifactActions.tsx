'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { apiFetch } from '@/lib/client/api';

export interface BenchmarkArtifactRef {
  name: string;
  kind: string;
  mediaType: string;
  sizeBytes: number;
  contentUrl: string;
}

function withUser(url: string, user: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}user=${encodeURIComponent(user)}`;
}

function formattedContent(artifact: BenchmarkArtifactRef, raw: string): string {
  if (artifact.mediaType !== 'application/json' && !artifact.name.endsWith('.json')) return raw;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function responseMessage(raw: string, fallback: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: string | { message?: string } };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error && typeof parsed.error.message === 'string') return parsed.error.message;
  } catch {
    return raw.trim() || fallback;
  }
  return fallback;
}

export function BenchmarkArtifactActions({
  user,
  submission,
  evidence,
}: {
  user: string;
  submission: BenchmarkArtifactRef | null;
  evidence: BenchmarkArtifactRef[];
}) {
  const [viewer, setViewer] = useState<{
    title: string;
    artifact: BenchmarkArtifactRef;
    content: string;
    loading: boolean;
    error: string;
  } | null>(null);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [downloading, setDownloading] = useState('');

  const report = useMemo(
    () => evidence.find((artifact) => artifact.kind === 'official-report' || artifact.name === 'report.json') || null,
    [evidence],
  );
  const testOutput = useMemo(
    () => evidence.find((artifact) => artifact.kind === 'test-output' || artifact.name === 'test_output.txt') || null,
    [evidence],
  );
  const runLog = useMemo(
    () => evidence.find((artifact) => artifact.kind === 'harness-log' || artifact.name === 'run_instance.log') || null,
    [evidence],
  );
  const artifacts = useMemo(
    () => [submission, report, testOutput, runLog].filter((artifact): artifact is BenchmarkArtifactRef => Boolean(artifact)),
    [submission, report, testOutput, runLog],
  );

  const closeViewer = useCallback(() => setViewer(null), []);

  useEffect(() => {
    if (!viewer) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeViewer();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewer, closeViewer]);

  const viewArtifact = useCallback(async (title: string, artifact: BenchmarkArtifactRef | null) => {
    if (!artifact) return;
    setDownloadOpen(false);
    setViewer({ title, artifact, content: '', loading: true, error: '' });
    try {
      const response = await apiFetch(withUser(artifact.contentUrl, user));
      const raw = await response.text();
      if (!response.ok) throw new Error(responseMessage(raw, '读取 Artifact 失败'));
      setViewer({ title, artifact, content: formattedContent(artifact, raw), loading: false, error: '' });
    } catch (error) {
      setViewer({
        title,
        artifact,
        content: '',
        loading: false,
        error: error instanceof Error ? error.message : '读取 Artifact 失败',
      });
    }
  }, [user]);

  const downloadArtifact = useCallback(async (artifact: BenchmarkArtifactRef) => {
    if (downloading) return;
    setDownloading(artifact.name);
    setDownloadOpen(false);
    try {
      const response = await apiFetch(withUser(artifact.contentUrl, user));
      if (!response.ok) {
        const raw = await response.text();
        throw new Error(responseMessage(raw, '下载 Artifact 失败'));
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = artifact.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      setViewer({
        title: `下载 ${artifact.name}`,
        artifact,
        content: '',
        loading: false,
        error: error instanceof Error ? error.message : '下载 Artifact 失败',
      });
    } finally {
      setDownloading('');
    }
  }, [downloading, user]);

  const actions: Array<{ label: string; title: string; artifact: BenchmarkArtifactRef | null }> = [
    { label: '查看 Patch', title: 'Agent Patch', artifact: submission },
    { label: '查看官方报告', title: 'SWE-bench 官方报告', artifact: report },
    { label: '查看测试输出', title: 'SWE-bench 测试输出', artifact: testOutput },
    { label: '查看运行日志', title: 'SWE-bench 运行日志', artifact: runLog },
  ];

  return (
    <>
      <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
        <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--foreground-muted)', marginBottom: 7 }}>
          评测文件
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className="ai-btn-s"
              disabled={!action.artifact}
              onClick={() => void viewArtifact(action.title, action.artifact)}
              title={action.artifact ? `${action.artifact.name} · ${action.artifact.sizeBytes} bytes` : '文件尚不可用'}
              style={!action.artifact ? { cursor: 'not-allowed', opacity: 0.5 } : undefined}
            >
              {action.label}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="ai-btn-s"
              disabled={!artifacts.length || Boolean(downloading)}
              onClick={() => setDownloadOpen((open) => !open)}
              style={!artifacts.length ? { cursor: 'not-allowed', opacity: 0.5 } : undefined}
            >
              {downloading ? `下载 ${downloading}…` : '↓ 下载原始文件'}
            </button>
            {downloadOpen && (
              <div
                role="menu"
                aria-label="下载原始文件"
                style={{
                  position: 'absolute', right: 0, bottom: 'calc(100% + 5px)', zIndex: 30,
                  minWidth: 190, padding: 5, border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)', background: 'var(--card-bg)', boxShadow: 'var(--shadow)',
                }}
              >
                {artifacts.map((artifact) => (
                  <button
                    key={`${artifact.kind}:${artifact.name}`}
                    type="button"
                    role="menuitem"
                    onClick={() => void downloadArtifact(artifact)}
                    style={{
                      display: 'flex', width: '100%', justifyContent: 'space-between', gap: 12,
                      padding: '7px 8px', border: 'none', borderRadius: 'var(--radius-sm)',
                      background: 'transparent', color: 'var(--foreground)', fontSize: 11,
                      textAlign: 'left', cursor: 'pointer',
                    }}
                  >
                    <span>{artifact.name}</span>
                    <span style={{ color: 'var(--foreground-muted)', whiteSpace: 'nowrap' }}>
                      {artifact.sizeBytes} B
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {viewer && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="benchmark-artifact-title"
          onClick={closeViewer}
          style={{ position: 'fixed', inset: 0, zIndex: 120, display: 'flex', justifyContent: 'flex-end' }}
        >
          <div style={{ position: 'absolute', inset: 0, background: 'var(--overlay-bg)' }} />
          <aside
            onClick={(event) => event.stopPropagation()}
            style={{
              position: 'relative', width: 'min(760px, 100%)', height: '100%',
              display: 'flex', flexDirection: 'column', background: 'var(--card-bg)',
              borderLeft: '1px solid var(--card-border)', boxShadow: 'var(--shadow)',
            }}
          >
            <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ minWidth: 0 }}>
                <div id="benchmark-artifact-title" style={{ fontSize: 13, fontWeight: 650 }}>{viewer.title}</div>
                <div style={{ marginTop: 2, fontSize: 10.5, color: 'var(--foreground-muted)' }}>
                  {viewer.artifact.name} · {viewer.artifact.sizeBytes} bytes
                </div>
              </div>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                className="ai-btn-s"
                disabled={Boolean(downloading)}
                onClick={() => void downloadArtifact(viewer.artifact)}
              >
                下载
              </button>
              <button type="button" className="ai-btn-s" aria-label="关闭" onClick={closeViewer}>×</button>
            </header>
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 18 }}>
              {viewer.loading ? (
                <div style={{ color: 'var(--foreground-muted)', fontSize: 12 }}>读取中…</div>
              ) : viewer.error ? (
                <div style={{ color: 'var(--error)', fontSize: 12 }}>{viewer.error}</div>
              ) : (
                <pre style={{
                  margin: 0, minHeight: '100%', padding: 14, border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)', background: 'var(--background-secondary)',
                  color: 'var(--foreground)', fontFamily: 'var(--font-mono, monospace)',
                  fontSize: 11.5, lineHeight: 1.65, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
                }}>
                  {viewer.content || '文件为空'}
                </pre>
              )}
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
