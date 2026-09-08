'use client';
import { useState } from 'react';
import Link from 'next/link';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { buildVersionView, type VersionRun } from '@/lib/evaluation-harness/versions';
import styles from './Workspace.module.css';
const field='w-full min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm';
const button='inline-flex items-center rounded-md border border-border px-3 py-2 text-sm hover:bg-background-secondary';
const status:Record<string,string>={done:'已完成',running:'运行中',draft:'待启动',failed:'执行异常',cancelled:'已终止'};
const score=(r:VersionRun)=>r.status==='done'&&typeof r.summary?.score==='number'?r.summary.score.toFixed(1)+'%':'暂无有效评分';
const source=(r:VersionRun)=>r.manifest.traceSource==='existing'?'已有 Trace':'执行 Agent';
const date=(r:VersionRun)=>new Date(r.createdAt).toLocaleString('zh-CN',{hour12:false});
export default function VersionExperiments({runs,assets,loaded}:{runs:VersionRun[];assets:any[];loaded:boolean}) {
  const [targetChoice,setTarget]=useState(''),[datasetChoice,setDataset]=useState('');
  const [axis,setAxis]=useState<'agent'|'dataset'>('agent'),[fixed,setFixed]=useState(''),[condition,setCondition]=useState('');
  const catalog=(kind:string)=>[...assets.filter(a=>a.kind===kind),...runs.map(r=>r.manifest[kind==='target'?'target':'dataset'])].filter((a,i,all)=>a&&all.findIndex(x=>x?.assetKey===a.assetKey)===i);
  const targets=catalog('target'),datasets=catalog('dataset');
  const target=targetChoice||runs[0]?.manifest.target.assetKey||targets[0]?.assetKey||'';
  const dataset=datasetChoice||runs.find(r=>r.manifest.target.assetKey===target)?.manifest.dataset.assetKey||datasets[0]?.assetKey||'';
  const view=buildVersionView(runs,target,dataset,axis,fixed,condition);
  const points=view.points.map(r=>({version:'v'+r.manifest[axis==='agent'?'target':'dataset'].version,score:r.summary.score,name:r.name,id:r.id}));
  const change=points.length>1?points.at(-1)!.score-points[0].score:null;
  const clearTrend=()=>{setFixed('');setCondition('');};
  if(!loaded) return <p role="status">正在加载实验版本记录…</p>;
  return <div className="space-y-4">
    <p className="text-sm text-foreground-secondary">先选择 Agent 和评测集，查看它们不同版本的实验结果。每个版本组合一行，重复执行保留完整历史。</p>
    <section className={styles.panel+' grid gap-4 md:grid-cols-2'} aria-label="版本分析对象">
      <label>待测对象（Agent / Skill）<select aria-label="版本分析 Agent" className={field} value={target} onChange={e=>{setTarget(e.target.value);setDataset('');clearTrend();}}>{!targets.length&&<option value="">暂无待测对象</option>}{targets.map(a=><option key={a.assetKey} value={a.assetKey}>{a.name}</option>)}</select></label>
      <label>评测集<select aria-label="版本分析评测集" className={field} value={dataset} onChange={e=>{setDataset(e.target.value);clearTrend();}}>{!datasets.length&&<option value="">暂无评测集</option>}{datasets.map(a=><option key={a.assetKey} value={a.assetKey}>{a.name}</option>)}</select></label>
    </section>
    {!view.runs.length ? <section className={styles.panel+' space-y-3'}><h3 className="font-semibold">这个组合还没有实验记录</h3><p>请选择其他 Agent 或评测集，也可以新建实验。这里展示已登记版本的实验；Trace 标签记录可切换到“Trace 标签分析”查看。</p><Link className={button} href="/experiments/new">新建实验</Link></section> : <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="版本概览">{[['版本组合',view.groups.length],['实验记录',view.runs.length],['Agent 版本',new Set(view.runs.map(r=>r.manifest.target.version)).size],['评测集版本',new Set(view.runs.map(r=>r.manifest.dataset.version)).size]].map(([label,value])=><div className={styles.panel} key={label}><p className="text-sm text-foreground-muted">{label}</p><strong className="text-2xl">{value}</strong></div>)}</div>
      <section className={styles.panel+' space-y-4'} aria-label="版本趋势">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">版本通过率趋势</h3><span className="text-sm">{change===null?'至少两个可比较版本才计算变化':`v${view.points[0].manifest[axis==='agent'?'target':'dataset'].version} → v${view.points.at(-1)!.manifest[axis==='agent'?'target':'dataset'].version}：${change>0?'+':''}${change.toFixed(1)} 个百分点`}</span></div>
        <div className="grid gap-3 md:grid-cols-2"><label>比较方式<select aria-label="版本比较方式" className={field} value={axis} onChange={e=>{setAxis(e.target.value as 'agent'|'dataset');clearTrend();}}><option value="agent">固定评测集，比较 Agent 版本</option><option value="dataset">固定 Agent，比较评测集版本</option></select></label><label>{axis==='agent'?'固定评测集版本':'固定 Agent 版本'}<select aria-label="趋势固定版本" className={field} value={view.fixed} onChange={e=>{setFixed(e.target.value);setCondition('');}}>{view.fixedOptions.map(v=><option key={v} value={v}>v{v}</option>)}</select></label></div>
        <label className="block">比较条件<select aria-label="版本趋势比较条件" className={field} value={view.condition} onChange={e=>setCondition(e.target.value)}>{!view.conditions.length&&<option value="">暂无可比较的评分</option>}{view.conditions.map(c=>{const r=c.runs[0];return <option key={c.condition} value={c.condition}>{source(r)} · {r.manifest.evaluators?.map((e:any)=>e.name+' v'+e.version).join('、')} · {r.manifest.caseIds? r.manifest.caseIds.length+' 个 Case':'全部 Case'} · 并发 {r.manifest.concurrency} / 超时 {r.manifest.timeoutSeconds}s / 重试 {r.manifest.retries} / 门槛 {r.manifest.threshold}% · {c.condition.slice(0,6)}</option>;})}</select></label>
        <p className="text-xs text-foreground-muted">默认选取可比较版本最多的一组条件。每个版本取该条件下最近一次已完成且有评分的实验；执行异常和缺少评分不会算成 0 分。不同评估器、模型、Case 范围和执行参数分开比较。</p>
        {!points.length?<p>当前固定版本尚无有效评分，可先查看下方实验状态。</p>:<><div className="h-56 w-full min-w-0" role="img" aria-label={'通过率趋势：'+points.map(p=>p.version+' '+p.score+'%').join('，')}><ResponsiveContainer width="100%" height="100%"><LineChart data={points} margin={{left:0,right:24,top:12,bottom:0}}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3"/><XAxis dataKey="version" stroke="var(--foreground-muted)"/><YAxis domain={[0,100]} unit="%" stroke="var(--foreground-muted)" width={48}/><Tooltip formatter={(value:any)=>[value+'%','通过率']} contentStyle={{background:'var(--card-bg)',borderColor:'var(--border)',color:'var(--foreground)'}}/><Line dataKey="score" type="linear" stroke="var(--primary)" strokeWidth={2} dot={{r:5}} isAnimationActive={false}/></LineChart></ResponsiveContainer></div><div className="flex flex-wrap gap-2">{points.map(p=><Link key={p.id} href={'/experiments/'+p.id} className={button}>{p.version} · {p.score.toFixed(1)}% · 查看实验</Link>)}</div></>}
      </section>
      <section className={styles.panel+' space-y-3'} aria-label="版本组合实验记录"><h3 className="font-semibold">版本组合实验记录</h3><p className="text-xs text-foreground-muted">显示所选 Agent × 评测集的全部版本组合，不受上方趋势条件隐藏。摘要取最近一次运行；展开历史可查看每次实验的条件与结果。</p><div className="overflow-x-auto"><table className="w-full min-w-[680px] text-left text-sm"><thead><tr className="border-b border-border text-foreground-muted">{['Agent 版本','评测集版本','最近实验 / 时间','状态 / 通过率','运行历史','操作'].map(t=><th className="p-3 font-medium" key={t}>{t}</th>)}</tr></thead><tbody>{view.groups.map(g=>{const r=g.runs[0];return <tr key={g.key} className="border-b border-border align-top"><td className="p-3 font-medium">v{r.manifest.target.version}</td><td className="p-3 font-medium">v{r.manifest.dataset.version}</td><td className="p-3"><p>{r.name}</p><p className="text-xs text-foreground-muted">{date(r)} · {source(r)}</p></td><td className="p-3"><p>{status[r.status]||r.status}</p><strong>{score(r)}</strong>{r.summary?.gate&&<p className="text-xs">{({pass:'验收通过',blocked:'未达验收要求',incomplete:'证据不完整'} as Record<string,string>)[r.summary.gate]||r.summary.gate}</p>}</td><td className="p-3"><details><summary className="cursor-pointer">{g.runs.length} 次运行</summary><div className="min-w-52 space-y-3 pt-3">{g.runs.map(h=><div key={h.id} className="border-t border-border pt-2"><Link className="text-primary underline" href={'/experiments/'+h.id}>{h.name}</Link><p>{status[h.status]||h.status} · {score(h)}</p><p className="text-xs text-foreground-muted">{date(h)} · {source(h)} · {h.manifest.caseIds?h.manifest.caseIds.length+' 个 Case':'全部 Case'} · 条件 {h.manifest.comparisonHash?.slice(0,6)||'未记录'}</p></div>)}</div></details></td><td className="p-3"><Link className={button} href={'/experiments/'+r.id}>实验详情</Link></td></tr>;})}</tbody></table></div></section>
    </>}
    <p className="text-xs text-foreground-muted">当前展示最近 100 条版本化实验中的记录。原生 Trace 标签统计保留在“Trace 标签分析”，不混入版本化实验评分。</p>
  </div>;
}
