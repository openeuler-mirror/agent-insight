/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
'use client';

import Link from 'next/link';

type Ref={businessId:string;versionId:string;version:number;definition?:Record<string,unknown>};
function asset(value:unknown):Ref|null {
  if(!value||typeof value!=='object')return null;
  const ref=value as Ref;
  return typeof ref.businessId==='string'&&typeof ref.versionId==='string'&&Number.isInteger(ref.version)?ref:null;
}
export function ExperimentAssetVersions({snapshot}:{snapshot?:Record<string,unknown>|null}){
  const versions=snapshot?.assetVersions as Record<string,unknown>|undefined;
  if(!versions||versions.schemaVersion!==1)return null;
  const agent=asset(versions.agent),dataset=asset(versions.dataset);
  const evaluators=versions.evaluators&&typeof versions.evaluators==='object'?Object.entries(versions.evaluators).flatMap(([id,value])=>{const ref=asset(value);return ref?[{id,ref}]:[];}):[];
  return <div className="mt-3 grid gap-2 border-t border-border pt-3 text-xs">
    <div className="flex flex-wrap items-center gap-2"><span className="text-foreground-muted">本次使用的版本：</span>
      {agent&&<span className="ai-badge ai-badge-gr" title="用户登记的外部 Agent 版本，未对外部代码或加载版本自动核验">Agent v{agent.version} · 用户登记</span>}
      {dataset&&<Link className="ai-badge ai-badge-gr" href={`/dataset/${encodeURIComponent(dataset.businessId)}?version=${encodeURIComponent(dataset.versionId)}`}>{String(dataset.definition?.name||'评测集')} v{dataset.version} ↗</Link>}
      {evaluators.map(({id,ref})=>id.startsWith('custom-')?<Link key={id} className="ai-badge ai-badge-gr" href={`/metrics/evaluators/${encodeURIComponent(id)}?version=${encodeURIComponent(ref.versionId)}`}>{String(ref.definition?.name||id)} v{ref.version} ↗</Link>:<span key={id} className="ai-badge ai-badge-gr">{String(ref.definition?.name||id)} v{ref.version}</span>)}
    </div>
    {agent&&<span className="text-foreground-muted">Agent 版本由用户登记；实际执行位置、平台、模型和参数按本次运行配置记录。</span>}
  </div>;
}
