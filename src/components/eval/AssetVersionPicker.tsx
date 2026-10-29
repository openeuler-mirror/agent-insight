/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import {useAuth} from '@/lib/auth/auth-context';
import {evaluationAssetRequest,type AssetKind,type AssetVersionView,type PublishedAssetVersion} from '@/lib/client/evaluation-assets';
import {Select} from '@/components/ui/select';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter} from '@/components/ui/dialog';
import {safeUUID} from '@/lib/safe-uuid';

export function AssetVersionPicker({kind,businessId,value,onChange,onLoad,onError,onStatus,revision=0,allowNewAgent=false}: {
  kind:AssetKind;businessId?:string;value?:string;revision?:number;allowNewAgent?:boolean;
  onChange?:(version:PublishedAssetVersion,view:AssetVersionView)=>void;
  onLoad?:(view:AssetVersionView)=>void;
  onError?:(error:Error & {status?:number})=>void;
  onStatus?:(status:'loading'|'ready'|'unsupported'|'error')=>void;
}){
  const {apiKey}=useAuth();
  const [view,setView]=useState<AssetVersionView|null>(null),[error,setError]=useState(''),[unsupported,setUnsupported]=useState(false);
  const [open,setOpen]=useState(false),[note,setNote]=useState(''),[externalVersion,setExternalVersion]=useState(''),[saving,setSaving]=useState(false);
  const callbacks=useRef({onChange,onLoad,onError,onStatus});callbacks.current={onChange,onLoad,onError,onStatus};
  const sequence=useRef(0);
  const label={agent:'Agent 版本',dataset:'评测集版本',evaluator:'评估器版本'}[kind];
  const load=useCallback(async(versionId?:string,select=false)=>{
    if(!apiKey||!businessId)return;
    const id=++sequence.current;
    setError('');setUnsupported(false);callbacks.current.onStatus?.('loading');
    try{
      const query=new URLSearchParams({kind,businessId,...(versionId?{versionId}:{})});
      const next=await evaluationAssetRequest<AssetVersionView>(apiKey,{query});
      if(sequence.current!==id)return;
      setView(next);setError('');setUnsupported(false);
      callbacks.current.onStatus?.('ready');
      callbacks.current.onLoad?.(next);
      if(select)callbacks.current.onChange?.(next.selectedVersion,next);
    }catch(e){if(sequence.current===id){setError(e instanceof Error?e.message:'版本加载失败');setUnsupported((e as {status?:number}).status===501);callbacks.current.onStatus?.((e as {status?:number}).status===501?'unsupported':'error');callbacks.current.onError?.(e instanceof Error?e:new Error('版本加载失败'));}}
  },[apiKey,businessId,kind]);
  useEffect(()=>{setView(null);void load(value);return()=>{sequence.current++;};},[load,value,revision]);
  if(!businessId)return <span className="text-xs text-foreground-muted">确定执行目标后选择{label}</span>;
  if(unsupported)return null;
  const register=async()=>{
    if(!apiKey||saving)return;
    setSaving(true);setError('');
    try{
      const [platform,agentName]=JSON.parse(businessId) as string[];
      const result=await evaluationAssetRequest<{version:PublishedAssetVersion}>(apiKey,{body:{action:'agent-publish',kind,platform,agentName,note,externalVersion,requestId:safeUUID()}});
      await load(result.version.id,true);setOpen(false);setNote('');setExternalVersion('');
    }catch(e){setError(e instanceof Error?e.message:'登记失败');}finally{setSaving(false);}
  };
  return <div className="flex flex-wrap items-center gap-2">
    {view?<Select aria-label={label} label={label} value={view.selectedVersion.id} options={view.versions.map(v=>({value:v.id,label:`v${v.version}${v.version===view.head.publishedVersion?' · 最新':''}`}))} onChange={id=>void load(id,true)}/>:<span className="text-xs text-foreground-muted">{label}加载中…</span>}
    {allowNewAgent&&view&&!view.readOnly&&<Button type="button" variant="outline" size="sm" onClick={()=>setOpen(true)}>新增版本</Button>}
    {view?.selectedVersion.note&&<span className="max-w-xs truncate text-xs text-foreground-muted" title={view.selectedVersion.note}>{view.selectedVersion.note}</span>}
    {error&&<span role="alert" className="text-xs text-error">{error}</span>}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>登记 Agent 新版本</DialogTitle><DialogDescription>记录外部 Agent 的变化。本操作登记版本，不修改外部 Agent 的代码。</DialogDescription></DialogHeader>
      <label className="grid gap-2 text-sm">外部版本号（可选）<Input value={externalVersion} onChange={e=>setExternalVersion(e.target.value)} /></label>
      <label className="grid gap-2 text-sm">本次变更说明<Textarea value={note} onChange={e=>setNote(e.target.value)} placeholder="例如：更新审批提示词与工具配置" /></label>
      <DialogFooter><Button type="button" variant="outline" onClick={()=>setOpen(false)}>取消</Button><Button type="button" disabled={!note.trim()||saving} onClick={()=>void register()}>{saving?'登记中…':'登记新版本'}</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}
