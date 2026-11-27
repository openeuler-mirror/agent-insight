/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
'use client';

import {useEffect,useState} from 'react';
import {useAuth} from '@/lib/auth/auth-context';
import {evaluationAssetRequest,type AssetVersionView,type PublishedAssetVersion} from '@/lib/client/evaluation-assets';
import type {EvaluatorCard} from '@/lib/evaluators/custom-evaluator-model';
import {compareEvaluatorVersions,evaluatorVersionFields} from '@/lib/evaluators/evaluator-version-details';
import {Select} from '@/components/ui/select';

function VersionValue({field,value}:{field:string;value:string}){
  if(field==='pointsDef'){
    try{
      const points=JSON.parse(value) as Array<{label:string;note?:string}>;
      if(Array.isArray(points)&&points.every(point=>point&&typeof point.label==='string'))return points.length?<ol className="grid list-decimal gap-2 pl-4">{points.map((point,index)=><li key={index} className="whitespace-pre-wrap break-words"><strong>{point.label}</strong>{point.note&&<p className="mt-1 text-foreground-muted">{point.note}</p>}</li>)}</ol>:<span className="text-foreground-muted">未配置评分点</span>;
    }catch{}
  }
  return <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all font-sans">{value}</pre>;
}

export function EvaluatorVersionDetails({view,loading=false}:{view:AssetVersionView;loading?:boolean}){
  const {apiKey}=useAuth();
  const [compare,setCompare]=useState(false),[compareId,setCompareId]=useState('');
  const [result,setResult]=useState<{key:string;version?:PublishedAssetVersion;error?:string}|null>(null);
  const current=view.selectedVersion;
  const others=view.versions.filter(version=>version.id!==current.id);
  const defaultOther=others.find(version=>version.version<current.version)||others[0];
  useEffect(()=>{setCompareId(defaultOther?.id||'');setResult(null);},[current.id,defaultOther?.id]);
  const resultKey=current.id+':'+compareId;
  useEffect(()=>{
    if(!compare||!compareId||!apiKey||loading)return;
    const controller=new AbortController();let active=true;
    setResult(null);
    const query=new URLSearchParams({kind:'evaluator',businessId:view.head.businessId,versionId:compareId});
    void evaluationAssetRequest<AssetVersionView>(apiKey,{query,signal:controller.signal}).then(next=>{
      if(active)setResult({key:resultKey,version:next.selectedVersion});
    }).catch(error=>{if(active)setResult({key:resultKey,error:error instanceof Error?error.message:'对比版本加载失败'});});
    return()=>{active=false;controller.abort();};
  },[apiKey,compare,compareId,loading,resultKey,view.head.businessId]);
  const selected=result?.key===resultKey?result:null;
  const changes=selected?.version?compareEvaluatorVersions(selected.version.content as unknown as EvaluatorCard,current.content as unknown as EvaluatorCard):[];
  const time=new Date(current.createdAt);
  return <section className="mb-4 grid gap-3 rounded-md border border-border p-3 text-xs" aria-label="版本信息与对比">
    <dl className="grid gap-1.5">
      <div><dt className="inline text-foreground-muted">当前查看：</dt><dd className="inline">v{current.version}{current.version===view.head.publishedVersion?' · 最新版':' · 历史版本（只读）'}</dd></div>
      <div><dt className="inline text-foreground-muted">记录时间：</dt><dd className="inline">{Number.isNaN(time.getTime())?'未记录':time.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</dd></div>
      <div><dt className="inline text-foreground-muted">版本说明：</dt><dd className="inline whitespace-pre-wrap break-words">{current.note||'未填写'}</dd></div>
    </dl>
    {others.length?<>
      <label className="flex w-fit items-center gap-2"><input type="checkbox" checked={compare} disabled={loading} onChange={event=>setCompare(event.target.checked)}/>与其他版本对比</label>
      {compare&&<div className="grid min-w-0 gap-3">
        <Select modal={false} contentClassName="z-[200]" aria-label="对比版本" label="对比版本" value={compareId} options={others.map(version=>({value:version.id,label:`v${version.version}${version.version===view.head.publishedVersion?' · 最新':''}`}))} onChange={setCompareId}/>
        {loading||!selected?<p className="text-foreground-muted" role="status">正在加载版本差异…</p>:selected.error?<p role="alert" className="text-error">对比加载失败：{selected.error}</p>:<>
          <p>v{selected.version!.version} → v{current.version}：{changes.length?`${changes.length} 项配置发生变化，仅展示变更项。`:'配置内容一致。'}</p>
          {changes.length>0&&<div className="overflow-x-auto"><table className="w-full table-fixed border-collapse text-xs" aria-label="评估器版本差异"><thead><tr className="bg-background-secondary text-left"><th className="w-24 border border-border p-2">配置项</th><th className="border border-border p-2">v{selected.version!.version}（对比版本）</th><th className="border border-border p-2">v{current.version}（当前查看）</th></tr></thead><tbody>{changes.map(change=><tr key={change.key}><th className="break-words border border-border p-2 text-left align-top font-medium" style={{whiteSpace:'normal',textTransform:'none'}}>{change.label}</th><td className="border border-border p-2 align-top"><VersionValue field={change.key} value={change.before}/></td><td className="border border-border p-2 align-top"><VersionValue field={change.key} value={change.after}/></td></tr>)}</tbody></table></div>}
        </>}
      </div>}
    </>:<p className="text-foreground-muted">目前只有一个已记录版本，后续保存的版本会出现在这里。</p>}
  </section>;
}

export function EvaluatorDefinitionDetails({card}:{card:EvaluatorCard}){
  const fields=evaluatorVersionFields(card).filter(field=>field.key==='pointsDef'||field.key.startsWith('llm.')||field.key.startsWith('code.'));
  const unavailable=card.evaluatorType==='LLM'&&!card.llmConfig||card.evaluatorType==='Code'&&!card.codeConfig;
  return <section className="mb-4 grid gap-3 text-xs" aria-label="评估器版本配置">
    <h3 className="font-semibold">配置内容（只读）</h3>
    {unavailable&&<p className="text-foreground-muted">此内置评估器未在版本记录中保存独立的提示词或代码正文。这里展示已记录的定义和实现说明，不能据此回滚内置运行代码。</p>}
    {fields.filter(field=>field.value!=='未配置'&&field.value!=='[]').map(field=><details key={field.key} className="rounded-md border border-border p-3" open={field.key==='pointsDef'}><summary className="cursor-pointer font-medium">{field.label}</summary>{field.key==='pointsDef'?<ol className="mt-2 grid list-decimal gap-2 pl-5">{card.pointsDef?.map((point,index)=><li key={index}><strong>{point.label}</strong>{point.note&&<p className="mt-1 whitespace-pre-wrap break-words text-foreground-muted">{point.note}</p>}</li>)}</ol>:<pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words font-sans">{field.value}</pre>}</details>)}
    {card.runtimeNote&&<p className="break-words text-foreground-muted">实现说明：{card.runtimeNote}</p>}
  </section>;
}
