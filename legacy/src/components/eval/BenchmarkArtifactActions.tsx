/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { apiFetch } from '@/lib/client/api';
import { BenchmarkArtifactContent } from './BenchmarkArtifactContent';
import type { BenchmarkPresentation } from '../../../packages/benchmark-protocol/src/contracts';
import {
  benchmarkPresentationText,
  benchmarkArtifactTree,
  type BenchmarkArtifactTreeNode,
  canPreviewBenchmarkArtifact,
  presentBenchmarkArtifacts,
  resolveBenchmarkArtifactPreview,
} from '@/lib/benchmark/presentation';

export interface BenchmarkArtifactRef {
  artifactId?: string;
  name: string;
  kind: string;
  mediaType: string;
  sizeBytes: number;
  contentUrl: string;
  sha256?: string;
  evidenceSource?: string;
}

function withUser(url: string, user: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}user=${encodeURIComponent(user)}`;
}

function artifactFilename(name: string): string {
  return name.split('/').pop() || name;
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
    artifact: BenchmarkArtifactRef;
    content: string;
    objectUrl: string;
    preview: ReturnType<typeof resolveBenchmarkArtifactPreview>;
    loading: boolean;
    error: string;
  } | null>(null);
  const [downloading, setDownloading] = useState('');
  const [viewMode, setViewMode] = useState<'preview' | 'raw'>('preview');
  const viewerFilename = viewer ? artifactFilename(viewer.artifact.name) : '';

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

  const viewArtifact = useCallback(async (artifact: BenchmarkArtifactRef) => {
    const preview = resolveBenchmarkArtifactPreview(artifact);
    if (!preview.renderer) return;
    setViewMode('preview');
    setViewer({ artifact, content: '', objectUrl: '', preview, loading: true, error: '' });
    try {
      const response = await apiFetch(withUser(artifact.contentUrl, user));
      if (!response.ok) {
        const raw = await response.text();
        throw new Error(responseMessage(raw, '读取 Artifact 失败'));
      }
      if (preview.load === 'text') {
        const raw = await response.text();
        setViewer({ artifact, content: raw, objectUrl: '', preview, loading: false, error: '' });
      } else {
        const objectUrl = URL.createObjectURL(await response.blob());
        setViewer({ artifact, content: '', objectUrl, preview, loading: false, error: '' });
      }
    } catch (error) {
      setViewer({
        artifact,
        content: '',
        objectUrl: '',
        preview,
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
      anchor.download = artifactFilename(artifact.name);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      setViewer({
        artifact,
        content: '',
        objectUrl: '',
        preview: resolveBenchmarkArtifactPreview(artifact),
        loading: false,
        error: error instanceof Error ? error.message : '下载 Artifact 失败',
      });
    } finally {
      setDownloading('');
    }
  }, [downloading, user]);

  const renderArtifact = ({ source, label, artifact }: typeof artifacts[number], filename?: string) => (
    <div
      key={`${source}:${artifact.artifactId || artifact.kind}:${artifact.name}`}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, minWidth: 0,
        padding: '7px 9px', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)', background: 'var(--background-secondary)',
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--foreground)' }}>{filename || label}</div>
        <div
          title={`${artifact.name} · ${artifact.mediaType}${artifact.sha256 ? ` · ${artifact.sha256}` : ''}`}
          style={{ marginTop: 2, fontSize: 10.5, color: 'var(--foreground-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {source === 'submission' && `${artifact.name} · `}
          {benchmarkPresentationText(artifact.sizeBytes, { format: 'bytes' })}
          {source === 'evidence' && ` · ${({ 'official-file': '官方文件（接入声明）', 'official-return': '官方接口返回记录（接入声明）', 'runtime-output': '运行输出', platform: '平台诊断' } as Record<string, string>)[artifact.evidenceSource || ''] || '来源未声明'}`}
        </div>
      </div>
      {canPreviewBenchmarkArtifact(artifact) && (
        <button type="button" className="ai-btn-s" onClick={() => void viewArtifact(artifact)}>
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
  );

  const renderTree = (nodes: BenchmarkArtifactTreeNode<BenchmarkArtifactRef>[]): ReactNode => nodes.map(node => (
    node.children ? (
      <details key={`directory:${node.path}`} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
        <summary style={{ padding: '7px 9px', cursor: 'pointer', fontSize: 11.5, fontWeight: 600, color: 'var(--foreground)' }}>
          {node.name}/
        </summary>
        <div style={{ display: 'grid', gap: 6, margin: '0 9px 9px 18px' }}>
          {renderTree(node.children)}
        </div>
      </details>
    ) : renderArtifact(node.item, node.path.includes('/') ? node.name : undefined)
  ));

  const renderArtifactList = (
    title: string,
    items: typeof artifacts,
    tree = false,
  ) => (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
      <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--foreground-muted)', marginBottom: 7 }}>
        {title}
      </div>
      {items.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>暂无文件</div>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {tree ? renderTree(benchmarkArtifactTree(items)) : items.map(item => renderArtifact(item))}
        </div>
      )}
    </div>
  );

  return (
    <>
      {renderArtifactList('提交物', submissionArtifacts)}
      {renderArtifactList('评测证据', evidenceArtifacts, true)}

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
            <header className="flex flex-wrap items-center gap-3" style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
              <div className="min-w-0 flex-[1_1_12rem]">
                <div id="benchmark-artifact-title" className="truncate" title={viewerFilename} style={{ fontSize: 13, fontWeight: 650 }}>
                  {viewerFilename}
                </div>
                <div style={{ marginTop: 2, fontSize: 10.5, color: 'var(--foreground-muted)' }}>
                  {viewer.artifact.sizeBytes} bytes
                </div>
              </div>
              <div className="ml-auto flex max-w-full shrink-0 flex-wrap justify-end gap-2 whitespace-nowrap">
                {!viewer.error && viewer.preview.load === 'text' && viewer.preview.renderer !== 'text' && (
                  <div role="group" aria-label="文件显示方式" className="flex gap-1">
                    {(['preview', 'raw'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className="ai-btn-s"
                        aria-pressed={viewMode === mode}
                        style={viewMode === mode ? { color: 'var(--primary)', background: 'var(--background-secondary)' } : undefined}
                        onClick={() => setViewMode(mode)}
                      >
                        {mode === 'preview' ? '预览' : '原文'}
                      </button>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  className="ai-btn-s"
                  disabled={Boolean(downloading)}
                  onClick={() => void downloadArtifact(viewer.artifact)}
                >
                  下载
                </button>
                <button type="button" className="ai-btn-s" aria-label="关闭" onClick={closeViewer}>×</button>
              </div>
            </header>
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 18 }}>
              {viewer.loading ? (
                <div style={{ color: 'var(--foreground-muted)', fontSize: 12 }}>读取中…</div>
              ) : viewer.error ? (
                <div style={{ color: 'var(--error)', fontSize: 12 }}>{viewer.error}</div>
              ) : (
                <BenchmarkArtifactContent
                  content={viewer.objectUrl || viewer.content}
                  filename={viewerFilename}
                  renderer={viewMode === 'raw' ? 'text' : viewer.preview.renderer ?? 'text'}
                />
              )}
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
