'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { apiFetch } from '@/lib/client/api';
import type { BenchmarkPresentation } from '../../../packages/benchmark-protocol/src/contracts';
import {
  benchmarkPresentationText,
  canPreviewBenchmarkArtifact,
  presentBenchmarkArtifacts,
} from '@/lib/benchmark/presentation';

export interface BenchmarkArtifactRef {
  artifactId?: string;
  name: string;
  kind: string;
  mediaType: string;
  sizeBytes: number;
  contentUrl: string;
  sha256?: string;
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
  submissions,
  evidence,
  presentation,
}: {
  user: string;
  submissions: BenchmarkArtifactRef[];
  evidence: BenchmarkArtifactRef[];
  presentation?: Pick<BenchmarkPresentation, 'artifacts'> | null;
}) {
  const [viewer, setViewer] = useState<{
    title: string;
    artifact: BenchmarkArtifactRef;
    content: string;
    objectUrl: string;
    previewType: 'text' | 'image' | 'pdf';
    loading: boolean;
    error: string;
  } | null>(null);
  const [downloading, setDownloading] = useState('');

  const artifacts = useMemo(() => presentBenchmarkArtifacts({
    submissions,
    evidence,
    rules: presentation?.artifacts,
  }), [evidence, presentation?.artifacts, submissions]);
  const submissionArtifacts = artifacts.filter((item) => item.source === 'submission');
  const evidenceArtifacts = artifacts.filter((item) => item.source === 'evidence');

  const closeViewer = useCallback(() => setViewer(null), []);

  useEffect(() => {
    const objectUrl = viewer?.objectUrl;
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [viewer?.objectUrl]);

  useEffect(() => {
    if (!viewer) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeViewer();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewer, closeViewer]);

  const viewArtifact = useCallback(async (title: string, artifact: BenchmarkArtifactRef) => {
    const previewType = artifact.mediaType.startsWith('image/')
      ? 'image' as const
      : artifact.mediaType === 'application/pdf'
        ? 'pdf' as const
        : 'text' as const;
    setViewer({ title, artifact, content: '', objectUrl: '', previewType, loading: true, error: '' });
    try {
      const response = await apiFetch(withUser(artifact.contentUrl, user));
      if (!response.ok) {
        const raw = await response.text();
        throw new Error(responseMessage(raw, '读取 Artifact 失败'));
      }
      if (previewType === 'text') {
        const raw = await response.text();
        setViewer({ title, artifact, content: formattedContent(artifact, raw), objectUrl: '', previewType, loading: false, error: '' });
      } else {
        const objectUrl = URL.createObjectURL(await response.blob());
        setViewer({ title, artifact, content: '', objectUrl, previewType, loading: false, error: '' });
      }
    } catch (error) {
      setViewer({
        title,
        artifact,
        content: '',
        objectUrl: '',
        previewType,
        loading: false,
        error: error instanceof Error ? error.message : '读取 Artifact 失败',
      });
    }
  }, [user]);

  const downloadArtifact = useCallback(async (artifact: BenchmarkArtifactRef) => {
    if (downloading) return;
    setDownloading(artifact.name);
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
        objectUrl: '',
        previewType: 'text',
        loading: false,
        error: error instanceof Error ? error.message : '下载 Artifact 失败',
      });
    } finally {
      setDownloading('');
    }
  }, [downloading, user]);

  const renderArtifactList = (
    title: string,
    items: typeof artifacts,
  ) => (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
      <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--foreground-muted)', marginBottom: 7 }}>
        {title}
      </div>
      {items.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>暂无文件</div>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {items.map(({ source, label, artifact }) => (
            <div
              key={`${source}:${artifact.artifactId || artifact.kind}:${artifact.name}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, minWidth: 0,
                padding: '7px 9px', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)', background: 'var(--background-secondary)',
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--foreground)' }}>{label}</div>
                <div
                  title={`${artifact.name} · ${artifact.mediaType}${artifact.sha256 ? ` · ${artifact.sha256}` : ''}`}
                  style={{ marginTop: 2, fontSize: 10.5, color: 'var(--foreground-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {artifact.name} · {benchmarkPresentationText(artifact.sizeBytes, { format: 'bytes' })}
                </div>
              </div>
              {canPreviewBenchmarkArtifact(artifact) && (
                <button type="button" className="ai-btn-s" onClick={() => void viewArtifact(label, artifact)}>
                  查看
                </button>
              )}
              <button
                type="button"
                className="ai-btn-s"
                disabled={Boolean(downloading)}
                onClick={() => void downloadArtifact(artifact)}
              >
                {downloading === artifact.name ? '下载中…' : '下载'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <>
      {renderArtifactList('提交物', submissionArtifacts)}
      {renderArtifactList('评测证据', evidenceArtifacts)}

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
              ) : viewer.previewType === 'image' ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={viewer.objectUrl} alt={viewer.title} style={{ display: 'block', maxWidth: '100%', height: 'auto', margin: '0 auto' }} />
              ) : viewer.previewType === 'pdf' ? (
                <iframe title={viewer.title} src={viewer.objectUrl} style={{ width: '100%', height: '100%', minHeight: 640, border: 0 }} />
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
