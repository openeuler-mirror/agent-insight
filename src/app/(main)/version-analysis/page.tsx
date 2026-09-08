
'use client';
import { useState } from 'react';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { PageContainer } from '@/components/shell/PageContainer';
import { VersionWorkspaceTabs } from '@/components/observe/VersionWorkspaceTabs';
import TraceVersionAnalysis from '@/components/observe/TraceVersionAnalysis';
import Workspace from '@/components/evaluation-harness/Workspace';
export default function VersionAnalysisPage() {
  const [view,setView]=useState<'experiments'|'traces'>('experiments');
  return <><AppTopBar title="版本分析"/><VersionWorkspaceTabs/><div role="tablist" aria-label="版本分析方式" className="flex shrink-0 gap-2 border-b border-border px-4 py-3">{([['experiments','实验版本分析'],['traces','Trace 标签分析']] as const).map(([key,label])=><button key={key} role="tab" aria-selected={view===key} aria-controls="version-analysis-panel" className={'rounded-md px-3 py-2 text-sm '+(view===key?'bg-primary text-primary-foreground':'border border-border text-foreground-secondary')} onClick={()=>setView(key)}>{label}</button>)}</div>{view==='experiments'?<PageContainer className="px-3 sm:px-6 [&>*]:shrink-0"><div id="version-analysis-panel" role="tabpanel"><Workspace mode="versions"/></div></PageContainer>:<TraceVersionAnalysis/>}</>;
}
