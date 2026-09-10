'use client';
import {useState} from 'react';
import Link from 'next/link';
import {CartesianGrid,Line,LineChart,ResponsiveContainer,Tooltip,XAxis,YAxis} from 'recharts';
import {buildDemoVersionView,expandVersionRuns,versionDimensions,type VersionChoices,type VersionDimension} from '@/lib/evaluation-harness/demo-versions';
import {assetsFor,dimensionLabels} from './AssetVersionPicker';
import {PageHeader,PageToolbar} from '@/components/shell/PageContainer';
import {Select} from '@/components/ui/select';
import {VersionTableHeaderCell as Th,VersionTableCell as Td} from '@/components/observe/TraceVersionAnalysis';
const status:Record<string,string>={done:'已完成',running:'运行中',draft:'待执行',failed:'执行异常',cancelled:'已终止'};
export default function VersionExperiments({runs,assets,loaded}:{runs:any[];assets:any[];loaded:boolean}){
 const [selected,setSelected]=useState<Partial<VersionChoices>>({});
 const rows=expandVersionRuns(runs),first=rows.find(r=>r.score!==null&&r.manifest.comparison?.dimension==='agent')||rows.find(r=>r.score!==null)||rows[0];
 const catalog=(kind:VersionDimension)=>[...assetsFor(assets,kind),...rows.map(r=>r.assets[kind]).filter(Boolean)].filter((a,i,all)=>all.findIndex(b=>b.id===a.id)===i).sort((a,b)=>b.version-a.version);
 const choices=Object.fromEntries(versionDimensions.map(kind=>{const candidate=first?.assets[kind]||catalog(kind)[0];return [kind,selected[kind]||{assetKey:candidate?.assetKey||(kind==='skill'?'__embedded__':''),id:candidate?.id||(kind==='skill'?'__embedded__':''),vary:kind==='agent'}];})) as VersionChoices;
 const view=buildDemoVersionView(runs,choices),varying=versionDimensions.filter(kind=>choices[kind].vary);
 const chartForRecord=new Map(view.series.flatMap((series,index)=>series.records.map(row=>[row.key,index+1] as const)));
 const update=(kind:VersionDimension,patch:Partial<VersionChoices[VersionDimension]>)=>setSelected(old=>({...old,[kind]:{...choices[kind],...patch}}));
 const label=(row:any)=>varying.length?varying.map(kind=>dimensionLabels[kind]+' v'+(row.assets[kind]?.version||'内置')).join(' / '):versionDimensions.map(kind=>'v'+(row.assets[kind]?.version||'—')).join(' / ');
 if(!loaded)return <p role="status">正在加载版本记录…</p>;
 return <div className="min-w-0 space-y-4">
  <PageHeader title="版本分析" description="勾选要比较版本的对象；未勾选的对象固定为所选版本。"/>
  <section className="rounded-md border border-border bg-card px-4 py-3" aria-label="版本对比对象">
   {versionDimensions.map(kind=>{
    const versions=catalog(kind),objects=versions.filter((a,i,all)=>all.findIndex(x=>x.assetKey===a.assetKey)===i);
    const objectOptions=[...(kind==='skill'?[{value:'__embedded__',label:'Agent 内置 Skill（未单独登记）'}]:[]),...objects.map(a=>({value:a.assetKey,label:a.name}))];
    const versionOptions=choices[kind].vary?[{value:'all',label:'比较全部版本'}]:choices[kind].assetKey==='__embedded__'?[{value:'__embedded__',label:'Agent 内置'}]:versions.filter(a=>a.assetKey===choices[kind].assetKey).map(a=>({value:a.id,label:'v'+a.version}));
    return <PageToolbar key={kind} className="mb-2 items-center last:mb-0">
     <label className="flex w-24 shrink-0 items-center gap-2 text-xs font-medium text-foreground-secondary"><input type="checkbox" className="accent-primary" aria-label={'比较'+dimensionLabels[kind]+'版本'} checked={choices[kind].vary} onChange={e=>update(kind,{vary:e.target.checked})}/>{dimensionLabels[kind]}</label>
     <Select aria-label={'版本对比'+dimensionLabels[kind]} value={choices[kind].assetKey} options={objectOptions.length?objectOptions:[{value:'',label:'暂无记录'}]} className="min-w-[220px] justify-between" onChange={value=>update(kind,{assetKey:value,id:versions.find(a=>a.assetKey===value)?.id||'__embedded__'})}/>
     <Select aria-label={'版本对比'+dimensionLabels[kind]+'版本'} label="版本" disabled={choices[kind].vary} value={choices[kind].vary?'all':choices[kind].id} options={versionOptions} className="min-w-[160px] justify-between" onChange={value=>update(kind,{id:value})}/>
    </PageToolbar>;
   })}
  </section>
  <section className="rounded-md border border-border bg-card p-4" aria-label="版本趋势">
   <div className="mb-3 flex flex-wrap items-start justify-between gap-3"><h2 className="text-sm font-semibold text-foreground">实验通过率趋势</h2></div>
   {!view.series.length?<p className="text-sm text-foreground-muted">这个组合还没有已完成的有效评分。<Link href="/experiments/new" className="ml-2 text-primary">新建实验</Link></p>:view.series.map((series,i)=>{
    const data=series.points.map(row=>({label:label(row),score:row.score,name:row.name,key:row.key}));
    return <div key={series.key} id={'version-chart-'+(i+1)} className="scroll-mt-20 border-t border-border pt-4 first:border-t-0 first:pt-0">
     <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium text-foreground">图 {i+1} · {series.points.length} 个版本组合</h3><span className="text-xs text-foreground-muted">对应下方标为“图 {i+1}”的实验记录</span></div>
     <dl className="mb-3 grid grid-cols-1 gap-x-6 gap-y-2 rounded-md bg-background-secondary px-3 py-3 text-xs sm:grid-cols-2 xl:grid-cols-3" aria-label={'图 '+(i+1)+' 的实验配置'}>
      {series.configuration.map(field=><div key={field.label} className="min-w-0"><dt className="mb-1 text-foreground-muted">{field.label}</dt><dd className="break-words text-foreground">{field.value}{field.details&&<details className="mt-1"><summary className="cursor-pointer text-primary">查看选中的 Case</summary><p className="mt-2 whitespace-pre-wrap break-words">{field.details}</p></details>}</dd></div>)}
     </dl>
     <div className="h-72 min-w-0" role="img" aria-label={'通过率趋势：'+data.map(p=>p.label+' '+p.score+'%').join('，')}>
      <ResponsiveContainer width="100%" height="100%"><LineChart data={data} margin={{top:14,right:18,bottom:4,left:-4}}>
       <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false}/>
       <XAxis dataKey="label" tick={{fontSize:11,fill:'var(--foreground-muted)'}} interval={0} minTickGap={8}/>
       <YAxis domain={[0,100]} unit="%" width={64} tick={{fontSize:11,fill:'var(--foreground-muted)'}}/>
       <Tooltip cursor={{stroke:'var(--border-dark)',strokeDasharray:'4 4'}} labelStyle={{color:'var(--foreground)'}} contentStyle={{background:'var(--card-bg)',border:'1px solid var(--border)',borderRadius:6,color:'var(--foreground)'}} formatter={(value:any)=>[Number(value).toFixed(1)+'%','通过率']}/>
       <Line dataKey="score" type="linear" stroke="var(--primary)" strokeWidth={2.8} dot={{r:4,strokeWidth:2,stroke:'var(--card-bg)',fill:'var(--primary)'}} activeDot={{r:6}} isAnimationActive={false}/>
      </LineChart></ResponsiveContainer>
     </div>
    </div>;
   })}
   <p className="mt-3 text-xs text-foreground-muted">每个版本组合取相同执行条件下最近一次有效评分；不同模型、Case 范围和执行参数自动分开。多项勾选时展示组合变化，不归因于单个对象。未评完整不会计为 0 分。</p>
  </section>
  <section className="overflow-hidden rounded-md border border-border bg-card" aria-label="版本组合实验记录">
   <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3"><h2 className="text-sm font-semibold text-foreground">实验记录（{view.rows.length}）</h2></div>
   <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-sm">
    <thead className="bg-background-secondary text-xs text-foreground-muted"><tr>{['实验',...versionDimensions.map(k=>dimensionLabels[k]),'对应趋势图','状态','通过率'].map(t=><Th key={t}>{t}</Th>)}</tr></thead>
    <tbody>{view.rows.map(row=><tr key={row.key} className="border-t border-border hover:bg-background-secondary">
     <Td><Link href={'/experiments/'+row.runId} className="font-medium text-primary">{row.name}{row.group?' · '+row.group+' 组':''}</Link><p className="mt-1 text-xs text-foreground-muted">{new Date(row.createdAt).toLocaleString('zh-CN',{hour12:false})}</p></Td>
     {versionDimensions.map(kind=><Td key={kind}>{kind==='evaluator'?row.evaluators.map(e=>e.name+' v'+e.version).join('、'):row.assets[kind]?'v'+row.assets[kind].version:'Agent 内置'}</Td>)}
     <Td>{chartForRecord.has(row.key)?<a href={'#version-chart-'+chartForRecord.get(row.key)} className="text-primary">图 {chartForRecord.get(row.key)}</a>:<span className="text-foreground-muted">暂无有效评分</span>}</Td>
     <Td>{status[row.status]||row.status}</Td><Td>{row.score===null?'未评完整':row.score.toFixed(1)+'%'}</Td>
    </tr>)}{view.rows.length===0&&<tr><td colSpan={8} className="px-4 py-8 text-center text-sm text-foreground-muted">当前组合暂无实验记录</td></tr>}</tbody>
   </table></div>
  </section>
 </div>;
}
