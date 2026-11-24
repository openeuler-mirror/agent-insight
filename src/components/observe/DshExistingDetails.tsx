'use client';
import {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {apiFetch} from '@/lib/client/api';
import type {ContextRequest,NativeContextBodyRef} from '@/lib/ingest/deepseek-harness-otel/context-view';

export function ContextBodyDisclosure({taskId,source,bodyRef,itemId,label,zh,preview=false,truncated=false,status}:{taskId?:string|null;source:string;bodyRef?:string;itemId:string;label:string;zh:boolean;preview?:boolean;truncated?:boolean;status?:string}) {
 const [body,setBody]=useState<{text:string;expiresAt:number;truncated:boolean}|null>(null);
 const [error,setError]=useState(''),[loading,setLoading]=useState(false);
 const pending=useRef<AbortController|null>(null);
 useEffect(()=>{setBody(null);setError('');setLoading(false);return()=>pending.current?.abort();},[taskId,source,bodyRef,itemId]);
 useEffect(()=>{if(!body)return;const timer=setTimeout(()=>setBody(null),Math.max(0,body.expiresAt-Date.now()));return()=>clearTimeout(timer);},[body]);
 const load=async()=>{
  if(!taskId||!bodyRef||loading||body)return;
  pending.current?.abort();const controller=new AbortController();pending.current=controller;setLoading(true);setError('');
  try{
   const query=new URLSearchParams({taskId,view:'context-body',sourceSessionId:source,contextRequestId:bodyRef});
   const response=await apiFetch(`/api/observe/session?${query}`,{signal:controller.signal});const result=await response.json();
   if(controller.signal.aborted)return;
   const expiresAt=Date.parse(result.expiresAt),item=Array.isArray(result.items)?result.items.find((i:any)=>i.itemId===itemId):null;
   if(!response.ok||!Number.isFinite(expiresAt)||expiresAt<=Date.now()||typeof item?.text!=='string')throw Error(zh?(response.status===410?'正文已过期或不可用':'正文加载失败，请重试'):(response.status===410?'Body expired or unavailable':'Unable to load body; retry'));
   setBody({text:item.text,expiresAt,truncated:item.bodyStatus==='truncated'});
  }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Unable to load body');}
  finally{if(!controller.signal.aborted)setLoading(false);}
 };
 return <details className="border-b border-border py-2" onToggle={event=>{if(event.currentTarget.open)void load();else {pending.current?.abort();setLoading(false);}}}>
  <summary className="cursor-pointer break-words text-xs">{label} · {preview?(zh?'预览':'Preview'):truncated?(zh?'正文已截断':'Truncated body'):(zh?'摘要正文':'Summary body')}</summary>
  {body?<><p className="my-2 text-xs text-foreground-secondary">{preview?(zh?'最多 80 字符预览':'Preview, at most 80 characters'):body.truncated?(zh?'脱敏正文已截断，未显示的内容不能据此判断丢失。':'Redacted body is truncated; hidden content may still exist.'):(zh?'完整脱敏文本；不代表最终模型请求报文。':'Complete redacted text; not a captured model wire request.')}</p><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{body.text}</pre></>:<p className="my-2 text-xs text-foreground-secondary">{loading?(zh?'正在加载…':'Loading…'):error||(!bodyRef?(status==='expired'?(zh?'正文已过期':'Body expired'):status==='quota-rejected'?(zh?'正文超过存储限额，未保存':'Body omitted by storage quota'):(zh?'正文未采集或不可用':'Body not collected or unavailable')):(zh?'展开后按需加载；到期后不可读取。':'Loaded on demand; unavailable after expiry.'))}</p>}
  {!body&&bodyRef&&!loading&&<Button size="sm" variant="outline" onClick={()=>void load()}>{zh?'重新加载':'Reload'}</Button>}
 </details>;
}

export function NativeContextBodies({bodies,taskId,zh}:{bodies:NativeContextBodyRef[];taskId?:string|null;zh:boolean}) {
 const unique=[...new Map(bodies.map(body=>[`${body.sourceSessionId}:${body.sourceEventSeq}:${body.kind}`,body])).values()];
 return <>{unique.map(body=><ContextBodyDisclosure key={`${body.sourceSessionId}:${body.sourceEventSeq}:${body.bodyRef}`} taskId={taskId} source={body.sourceSessionId} bodyRef={body.bodyRef} itemId={body.kind} zh={zh} truncated={body.truncated} status={body.bodyStorageStatus} label={`${body.kind==='checkpoint'?(zh?'压缩检查点':'Checkpoint'):zh?'压缩摘要':'Compaction summary'} #${body.sourceEventSeq}`}/>)}</>;
}

export function DshExistingDetails({request,taskId,zh,eventSeq,bodies=[]}:{request:ContextRequest;taskId?:string|null;zh:boolean;eventSeq?:number;bodies?:NativeContextBodyRef[]}) {
 const details=request.dshContext?.details;
 const rows=details?.status==='available'?details.items.filter((n:any)=>(eventSeq===undefined||n.group==='archive'&&n.gone>eventSeq&&n.gone<=request.eventSequence||n.name==='compact-checkpoint'&&n.sourceEventSeq>eventSeq&&n.sourceEventSeq<request.eventSequence)
   && !bodies.some(body=>body.kind==='checkpoint'&&body.sourceEventSeq===n.sourceEventSeq)):[];
 const names:Record<string,string>={'user':'用户消息','runtime-context':'运行上下文','skill-injection':'Skill 注入','assistant':'历史回复','tool':'工具结果'};
 return <section className="min-w-0 space-y-2 border-t border-border pt-3" aria-label={zh?'上下文内容':'Context content'}>
  <h4 className="text-sm font-medium">{zh?'上下文内容':'Context content'}</h4>
  {!!bodies.length&&<p className="text-xs text-foreground-secondary">{zh?'已记录的压缩正文；不代表本次请求的精确成员。':'Recorded compaction text; not exact membership of this request.'}</p>}
  <NativeContextBodies bodies={bodies} taskId={taskId} zh={zh}/>
  {rows.filter((n:any)=>n.group!=='archive').map((n:any)=><ContextBodyDisclosure key={`${request.sourceSessionId}:${details.bodyRef}:${n.itemId}`} taskId={taskId} source={request.sourceSessionId} bodyRef={n.bodyStatus==='source-preview'?details.bodyRef:undefined} itemId={n.itemId} zh={zh} preview status={details.bodyStorageStatus}
    label={`#${n.sourceEventSeq} · ${zh?names[n.category]??n.category:n.category}${n.name||n.tool?' · '+(n.name??n.tool):''}${n.group==='archive'?(zh?' · 已归档':' · Archived'):''}`}/>)}
  {!!rows.some((n:any)=>n.group==='archive')&&<details className="text-xs"><summary className="cursor-pointer">{zh?'历史归档':'Archived content'} · {rows.filter((n:any)=>n.group==='archive').length}</summary>{rows.filter((n:any)=>n.group==='archive').map((n:any)=><ContextBodyDisclosure key={`${request.sourceSessionId}:${details.bodyRef}:${n.itemId}`} taskId={taskId} source={request.sourceSessionId} bodyRef={n.bodyStatus==='source-preview'?details.bodyRef:undefined} itemId={n.itemId} zh={zh} preview status={details.bodyStorageStatus}
    label={`#${n.sourceEventSeq} · ${zh?names[n.category]??n.category:n.category}${n.name||n.tool?' · '+(n.name??n.tool):''}${n.group==='archive'?(zh?' · 已归档':' · Archived'):''}`}/>)}</details>}
  {!rows.length&&!bodies.length&&<p className="text-xs text-foreground-secondary">{zh?'没有可查看的上下文内容。':'No context content available.'}</p>}
  {eventSeq===undefined&&details?.header?.tools?.length>0&&<details className="text-xs"><summary className="cursor-pointer">{zh?'工具定义':'Tool definitions'} · {details.header.tools.length} · {zh?'仅名称':'Names only'}</summary><ul className="max-h-48 overflow-auto">{details.header.tools.map((tool:any,index:number)=><li key={index}>{tool.name}</li>)}</ul></details>}
  <details className="text-xs text-foreground-secondary"><summary className="cursor-pointer">{zh?'数据说明':'Data notes'}</summary><p>{zh?'分类与节点来自 dsh-context 投影；片段最多 80 字符，历史窗口可能不完整。原生摘要与 checkpoint 单独标注并按需读取；它们不是最终模型请求报文。系统提示词正文及完整工具 schema 未提供。':'Categories and nodes use dsh-context projections. Previews contain at most 80 characters; history may be incomplete. Native summaries and checkpoints are labeled separately and loaded on demand, not captured model wire requests.'}</p></details>
 </section>;
}
