'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import CaseEditor from './CaseEditor';
import { caseRerunConfig } from '@/lib/evaluation-harness/case-rerun';
import type { EvalCase } from '@/lib/evaluation-harness/domain';
export default function CaseVersionActions({experimentId, caseId}: {experimentId:string;caseId:string}) {
  const {apiKey}=useAuth();
  const router=useRouter(); const [busy,setBusy]=useState(false), [error,setError]=useState(''), [draft,setDraft]=useState<EvalCase[]|null>(null), [valid,setValid]=useState(false), [saved,setSaved]=useState('');
  async function request(body?:unknown){const res=await apiFetch('/api/evaluation-harness'+(body?'':'?experimentId='+encodeURIComponent(experimentId)),{method:body?'POST':'GET',headers:{'Content-Type':'application/json','x-witty-api-key':apiKey||''},...(body?{body:JSON.stringify(body)}:{})});const d=await res.json();if(!res.ok)throw Error(d.error||'操作失败');return d;}
  async function perform(fn:()=>Promise<void>){setBusy(true);setError('');try{await fn();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <div className="mb-3 space-y-3"><div className="flex gap-2"><button className="ai-btn-s" disabled={busy} onClick={()=>perform(async()=>{const d=await request();const created=await request({action:'create',config:caseRerunConfig(d,caseId,experimentId)});await request({action:'run',id:created.id});router.push('/experiments/'+created.id);})}>重新执行此 Case</button><button className="ai-btn-s" disabled={busy} onClick={()=>perform(async()=>{const d=await request();const row=d.experiment.cases.find((c:{id:string})=>c.id===caseId);if(!row)throw Error('Case 不存在');setDraft([JSON.parse(row.caseValuesJson)]);setValid(true);})}>修改 Case / 加入回归版本</button></div>{error&&<p role="alert" className="text-error">{error}</p>}{saved&&<p role="status">已保存评测集新版本，历史实验保持原版本。<a href={'/dataset/versioned-'+saved}>查看新版本</a></p>}{draft&&<section className="rounded border border-border p-3" role="dialog" aria-label="修订 Case"><CaseEditor cases={draft} singleCase onChange={setDraft} onValid={setValid}/><button className="ai-btn-s" onClick={()=>setDraft(null)}>取消</button><button className="ai-btn-s" disabled={!valid||busy} onClick={()=>perform(async()=>{const d=await request({action:'revise',experimentId,caseId,case:draft[0]});setSaved(d.id);setDraft(null);})}>保存新版本</button></section>}</div>;
}
