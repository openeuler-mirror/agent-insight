'use client';

import { DiffEditor } from '@monaco-editor/react';

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
  return (
    <DiffEditor
      key={`${path}::${mode}`}
      height={height}
      language={detectDiffLanguage(path)}
      original={before}
      modified={after}
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
