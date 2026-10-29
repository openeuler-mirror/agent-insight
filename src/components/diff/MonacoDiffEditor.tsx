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

import { useEffect, useRef } from 'react';
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';

export type DiffViewMode = 'side' | 'inline';

export function detectDiffLanguage(path: string): string {
  if (path.endsWith('.py')) return 'python';
  if (path.endsWith('.sh')) return 'shell';
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
  if (path.endsWith('.js') || path.endsWith('.jsx')) return 'javascript';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.md')) return 'markdown';
  if (path.endsWith('.yaml') || path.endsWith('.yml')) return 'yaml';
  return 'plaintext';
}

export function MonacoDiffEditor({
  path,
  before,
  after,
  mode,
  height = '100%',
}: {
  path: string;
  before: string;
  after: string;
  mode: DiffViewMode;
  height?: string | number;
}) {
  const editorRef = useRef<Parameters<DiffOnMount>[0] | null>(null);
  useEffect(() => () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (editor && model) {
      // Detach before the React wrapper disposes the models on unmount.
      editor.setModel(null);
      model.original.dispose();
      model.modified.dispose();
    }
    editorRef.current = null;
  }, []);
  return (
    <DiffEditor
      height={height}
      language={detectDiffLanguage(path)}
      original={before}
      modified={after}
      onMount={(editor) => { editorRef.current = editor; }}
      theme="light"
      options={{
        fontSize: 12,
        readOnly: true,
        renderSideBySide: mode === 'side',
        useInlineViewWhenSpaceIsLimited: false,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        wordWrap: 'on',
        renderOverviewRuler: false,
        scrollbar: { useShadows: false },
      }}
    />
  );
}
