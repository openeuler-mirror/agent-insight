'use client';
import {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {apiFetch} from '@/lib/client/api';
import type {ContextRequest} from '@/lib/ingest/deepseek-harness-otel/context-view';

export function DshExistingDetails({request,taskId,zh,eventSeq}:{request:ContextRequest;taskId?:string|null;zh:boolean;eventSeq?:number}) {
 const details=request.dshContext?.details;
 const [body,setBody]=useState<{items:any[];expiresAt:number}|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 const pending=useRef<AbortController|null>(null);
 useEffect(()=>{pending.current?.abort();setBody(null);setError('');setLoading(false);return()=>pending.current?.abort();},[details?.bodyRef]);
 useEffect(()=>{if(!body)return;const timer=setTimeout(()=>setBody(null),Math.max(0,body.expiresAt-Date.now()));return()=>clearTimeout(timer);},[body]);
 if(details?.status!=='available')return <p className="text-xs text-foreground-secondary">{zh?'已有节点视图不可用；未重建请求正文。':'Existing node view unavailable; no request body reconstruction.'}</p>;
 const rows=details.items.filter((n:any)=>eventSeq===undefined||n.group==='archive'&&n.gone>eventSeq&&n.gone<=request.eventSequence||n.name==='compact-checkpoint'&&n.sourceEventSeq>eventSeq&&n.sourceEventSeq<request.eventSequence);
 const load=async()=>{
  if(!taskId||!details.bodyRef)return;pending.current?.abort();const controller=new AbortController();pending.current=controller;setLoading(true);setError('');
  try{const query=new URLSearchParams({taskId,view:'context-body',sourceSessionId:request.sourceSessionId,contextRequestId:details.bodyRef});const response=await apiFetch(`/api/observe/session?${query}`,{signal:controller.signal});const result=await response.json();if(controller.signal.aborted)return;
   const expiresAt=Date.parse(result.expiresAt);if(!response.ok||!Array.isArray(result.items)||!Number.isFinite(expiresAt)||expiresAt<=Date.now())throw Error(`${response.status} · ${result.error??'preview unavailable'}`);
   setBody({items:result.items,expiresAt});
  }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'preview unavailable');}finally{if(!controller.signal.aborted)setLoading(false);}
 };
 return <section className="min-w-0 space-y-2 border-t border-border pt-3" aria-label={zh?'dsh-context 已有节点与片段':'Existing dsh-context nodes and previews'}>
  <h4 className="text-sm font-medium">{zh?'已有节点与片段（近似投影）':'Existing nodes and previews (approximate)'}</h4>
  <p className="text-xs text-foreground-secondary">{zh?'来源：delta.viewNodes 与 facts.nodes.archive。正文仅为源插件最多 80 字符的首个文本块预览，不是完整请求或完整摘要。工具结果通常没有正文；缺失不重建。':'Source: delta.viewNodes and facts.nodes.archive. At most 80 characters from a first text block; not complete requests or summaries. Tool bodies are usually missing.'}</p>
  {eventSeq!==undefined&&<p className="text-xs text-foreground-secondary">{zh?'按事件区间列出归档替换点与 checkpoint 候选，属于近似定位，不保证是完整或精确的裁剪成员。':'Archive replacement points and checkpoint candidates in the event interval; approximate, incomplete attribution.'}</p>}
  <p className="text-xs">{zh?'片段存储状态':'Preview storage'}: {details.bodyStorageStatus} · {details.nodesLimited||details.archiveLimited?(zh?'已知窗口截断':'Known window truncation'):(zh?'未报告窗口截断，仍不保证完整':'No reported window truncation; completeness not guaranteed')}</p>
  <Button size="sm" variant="outline" disabled={loading||!taskId||!details.bodyRef} onClick={load}>{loading?(zh?'正在读取…':'Loading…'):(zh?'鉴权加载已有片段':'Load authorized existing previews')}</Button>
  {error&&<p role="alert" className="break-all text-xs">{error}</p>}
  <div className="space-y-1">{rows.map((n:any)=><details key={n.itemId} className="border-b border-border py-2"><summary className="cursor-pointer break-words text-xs">#{n.sourceEventSeq} · {n.category} · {n.name??n.tool??n.group}{n.gone?` · ${zh?'归档替换点':'replaced at'} #${n.gone}`:''}</summary><p className="text-xs">{zh?'估算 Token':'Estimated tokens'}: {n.estimatedTokens??'—'} · {n.bodyStatus}</p><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">{body?.items.find(i=>i.itemId===n.itemId)?.text??(zh?'片段未加载、源正文缺失或已到期；不代表空正文。':'Preview not loaded, missing at source, or expired; not an empty body.')}</pre></details>)}</div>
  {rows.length===0&&<p className="text-xs">{zh?'当前窗口没有可归属的节点或片段。':'No attributable nodes in this window.'}</p>}
  {eventSeq===undefined&&<details className="text-xs"><summary className="cursor-pointer">{zh?'系统与工具定义已有元数据':'Existing system and tool metadata'}</summary><p>{zh?'系统正文未提供；仅估算 Token':'System body unavailable; estimated tokens only'}: {details.header?.systemTokens??'—'}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(details.header?.tools??[],null,2)}</pre><p>{zh?'未提供完整工具 schema 或 description。':'Full tool schemas and descriptions unavailable.'}</p></details>}
 </section>;
}
