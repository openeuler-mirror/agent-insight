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

import { csvParseRows } from 'd3-dsv';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { BenchmarkArtifactRenderer } from '@/lib/benchmark/presentation';

const previewRowLimit = 100;
const csvColumnLimit = 50;
const structuredPreviewSizeLimit = 1024 * 1024;
const htmlPreviewPolicy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
const cellClass = 'border border-[var(--border)] px-3 py-1.5 text-left align-top whitespace-pre-wrap';

function RawContent({ content }: { content: string }) {
  return (
    <pre style={{
      margin: 0, minHeight: '100%', padding: 14, border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)', background: 'var(--background-secondary)',
      color: 'var(--foreground)', fontFamily: 'var(--font-mono, monospace)',
      fontSize: 11.5, lineHeight: 1.65, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
    }}>
      {content || '文件为空'}
    </pre>
  );
}

function CsvPreview({ content }: { content: string }) {
  let truncatedColumns = false;
  const rows = csvParseRows(content.replace(/^\uFEFF/, ''), (row, index) => {
    if (index > previewRowLimit) return null;
    truncatedColumns ||= row.length > csvColumnLimit;
    return row.slice(0, csvColumnLimit);
  });
  const [head, ...records] = rows;
  if (!head) return <RawContent content="" />;
  const visibleRecords = records.slice(0, previewRowLimit - 1);
  const columnCount = Math.max(head.length, ...visibleRecords.map(row => row.length));

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead className="bg-[var(--background-secondary)]">
          <tr>
            {Array.from({ length: columnCount }, (_, index) => (
              <th key={index} scope="col" className={cellClass}>{head[index] ?? ''}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visibleRecords.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {Array.from({ length: columnCount }, (_, index) => (
                <td key={index} className={cellClass}>{row[index] ?? ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(rows.length > previewRowLimit || truncatedColumns) && (
        <p className="mt-2 text-xs text-[var(--foreground-muted)]">表格预览最多显示前 {previewRowLimit} 行、{csvColumnLimit} 列。</p>
      )}
    </div>
  );
}

export function BenchmarkArtifactContent({ content, filename, renderer }: {
  content: string;
  filename?: string;
  renderer: BenchmarkArtifactRenderer;
}) {
  if (!content) return <RawContent content="" />;
  if (renderer === 'image') {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={content} alt={filename} style={{ display: 'block', maxWidth: '100%', height: 'auto', margin: '0 auto' }} />;
  }
  if (renderer === 'pdf') {
    return <iframe title={filename} src={content} style={{ width: '100%', height: '100%', minHeight: 640, border: 0 }} />;
  }
  if (renderer === 'markdown') {
    return (
      <div className="ai-artifact-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{content}</ReactMarkdown>
      </div>
    );
  }
  if (renderer !== 'text' && content.length > structuredPreviewSizeLimit) {
    return <p className="text-xs text-[var(--foreground-muted)]">文件较大，可切换到原文或下载查看。</p>;
  }
  if (renderer === 'html') {
    return (
      <>
        <p className="mb-2 text-xs text-[var(--foreground-muted)]">HTML 报告在隔离窗口内显示，外部资源无法加载。</p>
        <iframe
          title={filename}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="${htmlPreviewPolicy}">${content}`}
          style={{ width: '100%', height: '100%', minHeight: 640, border: 0, background: 'white' }}
        />
      </>
    );
  }
  if (renderer === 'csv') return <CsvPreview content={content} />;
  return <RawContent content={content} />;
}
