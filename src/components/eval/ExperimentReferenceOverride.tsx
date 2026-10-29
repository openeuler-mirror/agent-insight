/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
'use client';
import Link from 'next/link';

export function ExperimentReferenceOverride({values}:{values?:Record<string,unknown>|null}){
  const raw=values?.__agentInsightReferenceOverride;
  if(!raw||typeof raw!=='object')return null;
  const ref=raw as Record<string,unknown>;
  if(ref.schemaVersion!==1)return null;
  return <div className="mb-4 rounded-md border border-border bg-card p-3 text-xs">
    <p className="font-medium">本次实验覆盖了评测集 v{String(ref.baselineVersion)} 的原预期答案</p>
    <p className="mt-1 text-foreground-muted">{ref.source==='dataset-import'?'从其他评测集导入':'人工修改'}，仅影响本次实验；逐轮规则与工具目录仍沿用原版本。</p>
    <details className="mt-2"><summary className="cursor-pointer text-primary">查看原答案与来源</summary>
      <div className="mt-2 grid gap-2"><Link className="text-primary" href={`/dataset/${encodeURIComponent(String(ref.datasetId))}?version=${encodeURIComponent(String(ref.baselineVersionId))}&case=${encodeURIComponent(String(ref.caseId))}`}>原评测集版本与 Case ↗</Link>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border p-2">{String(ref.baseExpectedOutput??'（未标注）')}</pre>
        {typeof ref.sourceDatasetId==='string'&&<Link className="text-primary" href={`/dataset/${encodeURIComponent(ref.sourceDatasetId)}${typeof ref.sourceCaseId==='string'?'?case='+encodeURIComponent(ref.sourceCaseId):''}`}>导入答案的来源评测集 ↗</Link>}
      </div>
    </details>
  </div>;
}
