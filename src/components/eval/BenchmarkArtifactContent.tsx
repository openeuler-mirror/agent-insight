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

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function BenchmarkArtifactContent({ content, markdown }: { content: string; markdown: boolean }) {
  if (markdown && content) {
    return (
      <div className="ai-artifact-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{content}</ReactMarkdown>
      </div>
    );
  }
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
