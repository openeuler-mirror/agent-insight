'use client';

import { useState } from 'react';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { PageContainer } from '@/components/shell/PageContainer';
import Workspace from '@/components/evaluation-harness/Workspace';
export default function HarnessPage() {
  const [mode, setMode] = useState<'create' | 'datasets' | 'evaluators' | 'versions'>('create');
  return <><AppTopBar title="实验" /><PageContainer className="px-3 sm:px-6 [&>*]:shrink-0"><div className="mb-5 flex flex-wrap gap-3">{([['create', '新建实验'], ['datasets', '评测集版本'], ['evaluators', '评估器'], ['versions', '版本分析']] as const).map(([id, label]) => <button key={id} className="rounded border border-border px-3 py-2" onClick={() => setMode(id)} aria-pressed={mode === id}>{label}</button>)}</div><Workspace key={mode} mode={mode} /></PageContainer></>;
}
