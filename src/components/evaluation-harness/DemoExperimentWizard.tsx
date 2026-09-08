'use client';
import {Suspense,useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {useRouter,useSearchParams} from 'next/navigation';
import {Stepper,ExpectedAnswersTable,experimentTableHeader as TH,experimentTableCell as TD} from '@/components/experiments/ExperimentWizard';
import AssetVersionPicker,{assetsFor,dimensionLabels,demoField,type AssetDimension} from './AssetVersionPicker';
import {useEvaluationCatalog} from './useEvaluationCatalog';
import CaseRulesDialog from './CaseRulesDialog';
import {caseSummary} from './dataset-draft';
import {caseSelectionForVersion} from '@/lib/evaluation-harness/demo-selection';
import type {EvalCase} from '@/lib/evaluation-harness/domain';
import styles from './Workspace.module.css';
const button='ai-btn-s';
const primary='ai-btn-s bg-primary text-primary-foreground';
const dimensions:AssetDimension[]=['agent','skill','evaluator','dataset'];
type Selection=Record<AssetDimension,string>;
const blank:Selection={agent:'',skill:'',evaluator:'',dataset:''};
function DemoExperimentWizardContent(){
 const router=useRouter(),search=useSearchParams();const {catalog,loaded,error,setError,request}=useEvaluationCatalog();
 const [a,setA]=useState<Selection>(blank),[b,setB]=useState<Selection>(blank),[extraEvals,setExtraEvals]=useState<string[]>([]),[extraEvalsB,setExtraEvalsB]=useState<string[]>([]);
 const [dimension,setDimension]=useState<'single'|AssetDimension>('single'),[name,setName]=useState('业务验收'),[step,setStep]=useState(1),[busy,setBusy]=useState(false);
 const [endpoint,setEndpoint]=useState(''),[model,setModel]=useState(''),[caseIds,setCaseIds]=useState<string[]>([]),[caseBIds,setCaseBIds]=useState<string[]>([]),[query,setQuery]=useState('');
 const [threshold,setThreshold]=useState(90),[concurrency,setConcurrency]=useState(2),[timeout,setTimeoutSeconds]=useState(60),[retries,setRetries]=useState(1);
 const initialized=useRef(false);const [restoring,setRestoring]=useState(Boolean(search?.get('sourceExperimentId')));
 const assets=catalog.assets,find=(id:string)=>assets.find(x=>x.id===id),dataset=find(a.dataset),datasetB=find(b.dataset),target=find(a.agent);
 const sourceId=search?.get('sourceExperimentId')||'';
 const update=(side:'A'|'B',kind:AssetDimension,id:string)=>{(side==='A'?setA:setB)(old=>({...old,[kind]:id}));if(kind==='dataset')(side==='A'?setCaseIds:setCaseBIds)(caseSelectionForVersion(find(id)));};
 useEffect(()=>{
  if(!loaded||initialized.current)return;initialized.current=true;
  const defaults=Object.fromEntries(dimensions.map(kind=>[kind,assetsFor(catalog.assets,kind).find(x=>!x.archived)?.id||''])) as Selection;
  defaults.dataset=search?.get('datasetId')||defaults.dataset;
  setA(defaults);setCaseIds(caseSelectionForVersion(catalog.assets.find(x=>x.id===defaults.dataset)));setEndpoint(catalog.assets.find(x=>x.id===defaults.agent)?.content.endpoint||catalog.executionOptions.demoEndpoint);
  if(!sourceId)return;
  void request(undefined,'?experimentId='+encodeURIComponent(sourceId)).then(d=>{
   const m=d.manifest,comparison=m.comparison;const dim=comparison?.dimension;
   if(dim==='llm')throw Error('本演示仅提供 Agent、Skill、评估器和评测集对比，请重新选择实验类型。');
   setDimension(dim||'single');setName(d.experiment.name+' · 回归');
   setA({agent:m.target.id,skill:m.skill?.id||comparison?.skillAId||'',dataset:search?.get('datasetId')||m.dataset.id,evaluator:m.evaluatorIds[0]});
   setExtraEvals(m.evaluatorIds.slice(1));setB({agent:comparison?.targetBId||'',skill:comparison?.skillBId||'',dataset:search?.get('datasetBId')||comparison?.datasetBId||'',evaluator:comparison?.evaluatorBIds?.[0]||''});setExtraEvalsB(comparison?.evaluatorBIds?.slice(1)||[]);
   const restoredA=search?.get('datasetId')||m.dataset.id,restoredB=search?.get('datasetBId')||comparison?.datasetBId;
   setCaseIds(caseSelectionForVersion(catalog.assets.find(x=>x.id===restoredA),{datasetId:m.dataset.id,caseIds:m.caseIds}));
   setCaseBIds(caseSelectionForVersion(catalog.assets.find(x=>x.id===restoredB),{datasetId:comparison?.datasetBId,caseIds:comparison?.caseBIds}));
   setEndpoint(m.execution?.endpoint||m.target.content.endpoint||catalog.executionOptions.demoEndpoint);setModel(m.execution?.model||m.target.content.model||'');
   setThreshold(m.threshold);setConcurrency(m.concurrency);setTimeoutSeconds(m.timeoutSeconds);setRetries(m.retries);
  }).catch(e=>setError(e.message)).finally(()=>setRestoring(false));
 },[loaded,catalog,request,search,sourceId,setError]);
 const evalA=[a.evaluator,...extraEvals].filter(Boolean),evalB=[b.evaluator,...extraEvalsB].filter(Boolean);
 const invalidAssets=[...dimensions.filter(k=>k!=='skill'||a.skill).map(k=>find(a[k])),...(dimension==='single'?[]:[find(b[dimension])]),...extraEvals.map(find),...(dimension==='evaluator'?extraEvalsB.map(find):[])];
 let invalid=invalidAssets.some(x=>!x||x.archived)?'请选择可用的对象和版本；已删除的评测集需先恢复。':'';
 if(!invalid&&dimension!=='single'&&dimension!=='evaluator'&&a[dimension]===b[dimension])invalid='A/B 组请选择不同的对象或版本。';
 if(!invalid&&dimension==='skill'&&find(a.skill)?.assetKey!==find(b.skill)?.assetKey)invalid='Skill 对比请选择同一 Skill 的两个版本。';
 if(!invalid&&(new Set(evalA).size!==evalA.length||new Set(evalB).size!==evalB.length))invalid='同组评估器不能重复选择。';
 if(!invalid&&dimension==='evaluator'&&[...evalA].sort().join() === [...evalB].sort().join())invalid='A/B 两组评估器组合需要不同。';
 if(!name.trim()||!endpoint.trim())invalid=invalid||'请填写实验名称并选择执行地址。';
 const selected=(side:'A'|'B')=>((side==='A'?dataset:datasetB)?.content.cases||[]).filter((c:EvalCase)=>(side==='A'?caseIds:caseBIds).includes(c.id));
 const casesValid=caseIds.length>0&&(dimension!=='dataset'||caseBIds.length>0);
 const setType=(kind:'single'|AssetDimension)=>{
  setDimension(kind);setError('');
  if(kind!=='single'){
   const choices=assetsFor(assets,kind).filter(x=>!x.archived&&x.id!==a[kind]&&(kind!=='skill'||x.assetKey===find(a.skill)?.assetKey));
   setB(old=>({...old,[kind]:choices[0]?.id||''}));if(kind==='dataset')setCaseBIds(caseSelectionForVersion(choices[0]));
  }
 };
 function evaluatorPicker(side:'A'|'B'){
  const values=side==='A'?extraEvals:extraEvalsB,setValues=side==='A'?setExtraEvals:setExtraEvalsB;
  return <div className="space-y-2"><AssetVersionPicker assets={assets} kind="evaluator" value={(side==='A'?a:b).evaluator} prefix={dimension==='evaluator'?side+' 组 ':''} onChange={id=>update(side,'evaluator',id)}/>{values.map((id,i)=><div className="flex items-end gap-2" key={i}><div className="flex-1"><AssetVersionPicker assets={assets} kind="evaluator" value={id} prefix={side+' 组附加'+(i+1)} onChange={value=>setValues(old=>old.map((v,index)=>index===i?value:v))}/></div><button className={button} onClick={()=>setValues(old=>old.filter((_,index)=>index!==i))}>移除</button></div>)}<button className={button} disabled={values.length>=9} onClick={()=>setValues(old=>[...old,assetsFor(assets,'evaluator').find(e=>!e.archived&&![(side==='A'?a:b).evaluator,...old].includes(e.id))?.id||''])}>＋ 添加评估器</button>{values.length>0&&<p className="text-xs text-foreground-muted">按顺序执行，共同判定；所有评估器通过才算通过。</p>}</div>;
 }
 function picker(kind:AssetDimension,side:'A'|'B'='A'){
  return kind==='evaluator'?evaluatorPicker(side):<AssetVersionPicker assets={assets} kind={kind} value={(side==='A'?a:b)[kind]} prefix={dimension===kind?side+' 组 ':''} optional={kind==='skill'&&dimension!=='skill'} assetKey={kind==='skill'&&side==='B'?find(a.skill)?.assetKey:undefined} onChange={id=>update(side,kind,id)}/>;
 }
 function cases(side:'A'|'B'){
  const data=side==='A'?dataset:datasetB,ids=side==='A'?caseIds:caseBIds,setIds=side==='A'?setCaseIds:setCaseBIds;
  const rows:EvalCase[]=(data?.content.cases||[]).filter((c:EvalCase)=>[c.name,c.turns[0].input,c.category,c.difficulty,...c.tags].join(' ').toLowerCase().includes(query.toLowerCase()));
  return <section className="space-y-3" aria-label={side+' 组 Case'}><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{dimension==='dataset'?side+' 组 · ':''}{data?.name} · v{data?.version} <span className="text-sm font-normal text-foreground-muted">已选 {ids.length} / {data?.content.cases.length||0}</span></h3><div className="flex gap-2"><button className={button} onClick={()=>setIds([...new Set([...ids,...rows.map(c=>c.id)])])}>全选</button><button className={button} onClick={()=>setIds([])}>取消全选</button></div></div><div className="max-h-96 overflow-auto rounded-lg border border-border"><table className="w-full text-left text-sm"><thead><tr>{['选择','Case','类别','首次输入','规则'].map(s=><th key={s} style={TH}>{s}</th>)}</tr></thead><tbody>{rows.map(c=><tr key={c.id}><td style={TD}><input type="checkbox" aria-label={side+' 组 Case '+c.name} checked={ids.includes(c.id)} onChange={()=>setIds(old=>old.includes(c.id)?old.filter(id=>id!==c.id):[...old,c.id])}/></td><td style={TD}>{c.name}</td><td style={TD}>{c.turns.length>1?'多轮':'单轮'}</td><td style={TD}>{c.turns[0].input}</td><td style={TD}><CaseRulesDialog value={c}/></td></tr>)}</tbody></table></div></section>;
 }
 function answers(side:'A'|'B'){
  return <div className="space-y-3">{dimension==='dataset'&&<h3>{side} 组 · {(side==='A'?dataset:datasetB)?.name}</h3>}<ExpectedAnswersTable><thead><tr>{['Case','首次输入','最终预期输出','逐轮规则'].map(t=><th style={TH} key={t}>{t}</th>)}</tr></thead><tbody>{selected(side).map((c:EvalCase)=><tr key={c.id}><td style={TD}>{c.name}</td><td style={TD}>{caseSummary(c).input}</td><td style={TD}>{caseSummary(c).output||'按逐轮规则判断'}</td><td style={TD}><CaseRulesDialog value={c}/></td></tr>)}</tbody></ExpectedAnswersTable></div>;
 }
 const endpoints=[...new Set([catalog.executionOptions.demoEndpoint,...assets.filter(x=>x.kind==='target').map(x=>x.content.endpoint),endpoint].filter(Boolean))];
 const models=endpoint===catalog.executionOptions.demoEndpoint?catalog.executionOptions.demoModels:[...new Set([catalog.executionOptions.publicModel,target?.content.model,model].filter(Boolean))];
 async function run(){
  if(invalid||!casesValid){setError(invalid||'至少选择一个 Case');return;}setBusy(true);setError('');
  try{
   const comparison=dimension==='single'?undefined:{dimension,...(dimension==='agent'?{targetBId:b.agent}:dimension==='skill'?{skillAId:a.skill,skillBId:b.skill}:dimension==='dataset'?{datasetBId:b.dataset,caseBIds}:{evaluatorBIds:evalB})};
   const result=await request({action:'create',config:{name,targetId:a.agent,...(a.skill?{skillId:a.skill}:{}),datasetId:a.dataset,evaluatorIds:evalA,comparison,execution:{endpoint,model},caseIds,threshold,concurrency,timeoutSeconds:timeout,retries,...(sourceId?{sourceExperimentId:sourceId}:{})}});
   await request({action:'run',id:result.id});router.push('/experiments/'+result.id);
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 if(!loaded||restoring)return <p role="status">{error||(restoring?'正在恢复原实验条件…':'正在加载对象与版本…')}</p>;
 return <div className={styles.root+' space-y-4 pb-6'}><Stepper labels={['实验设计','选择 Case','预期答案','确认并执行']} step={step} maxVisited={invalid?1:casesValid?4:2} summaries={[name,caseIds.length+' 个 Case',dataset?.name||'',dimension==='single'?'单组实验':dimensionLabels[dimension]+'对比']} optionalThird={false} onJump={setStep}/>
  {error&&<p role="alert" className="rounded-lg bg-error-subtle p-3 text-error">{error}</p>}
  <section className={styles.panel+' space-y-5'}>
   {step===1&&<><label className="block">实验名称<input aria-label="实验名称" className={demoField} value={name} onChange={e=>setName(e.target.value)}/></label><fieldset><legend className="mb-2">实验类型</legend><div className="flex flex-wrap gap-2">{(['single',...dimensions] as const).map(kind=><button key={kind} type="button" aria-pressed={dimension===kind} className={dimension===kind?primary:button} onClick={()=>setType(kind)}>{kind==='single'?'无变量 · 单组':dimensionLabels[kind]+'对比'}</button>)}</div></fieldset>
   {dimension!=='single'&&<section aria-label="对比项" className="space-y-3"><h3 className="font-semibold">对比项 · {dimensionLabels[dimension]}</h3><div className="grid gap-4 md:grid-cols-2">{(['A','B'] as const).map(side=><div key={side} className="rounded-lg border border-border p-4 space-y-3"><h4 className="font-semibold">{side} 组</h4>{picker(dimension,side)}</div>)}</div></section>}
   <section aria-label={dimension==='single'?'实验对象':'共享条件'} className="space-y-4">{dimension!=='single'&&<h3 className="font-semibold">共享条件</h3>}<div className="grid gap-5 lg:grid-cols-2">{dimensions.filter(kind=>kind!==dimension).map(kind=><div key={kind}>{picker(kind)}</div>)}</div></section>
   <section aria-label="执行位置与模型" className="space-y-3 border-t border-border pt-4"><h3 className="font-semibold">在哪里执行</h3><div className="grid gap-4 md:grid-cols-2"><label>执行地址 / IP<select aria-label="执行地址 / IP" className={demoField} value={endpoint} onChange={e=>{setEndpoint(e.target.value);setModel('');}}><option value="">请选择执行地址</option>{endpoints.map(value=><option key={value} value={value}>{value}{value===catalog.executionOptions.demoEndpoint?'（独立 Demo Agent）':''}</option>)}</select></label><label>Agent 执行模型<select aria-label="Agent 执行模型" className={demoField} value={model} onChange={e=>setModel(e.target.value)}><option value="">沿用 Agent 默认模型</option>{models.map(value=><option key={value} value={value}>{value}{value.startsWith('demo-')?'（规则模拟）':''}</option>)}</select></label></div><p className="text-xs text-foreground-muted">平台把所选 Case 发到这个地址执行，并收集实际输出、工具调用和 Trace。模型是传给 Agent 的执行参数，评估器的评分模型在评估器页面配置。</p></section>
   {invalid&&<p role="status" className="text-sm text-error">{invalid}</p>}
   </>}
   {step===2&&<><input className={demoField} aria-label="搜索 Case" placeholder="搜索 Case 名称、输入或标签" value={query} onChange={e=>setQuery(e.target.value)}/>{cases('A')}{dimension==='dataset'&&cases('B')}</>}
   {step===3&&<><div className="flex items-center justify-between"><h3 className="font-semibold">预期答案与逐轮规则</h3><Link className={button} href={'/dataset/versioned-'+a.dataset}>到评测集编辑</Link></div>{answers('A')}{dimension==='dataset'&&answers('B')}</>}
   {step===4&&<><h3 className="font-semibold">确认实验条件</h3><div className="overflow-auto"><table className="w-full text-left text-sm"><thead><tr>{['对象','A 组 / 共享条件',...(dimension==='single'?[]:['B 组'])].map(label=><th key={label} style={TH}>{label}</th>)}</tr></thead><tbody>{dimensions.map(kind=>{const display=(side:'A'|'B')=>{const ids=kind==='evaluator'?(side==='A'?evalA:evalB):[(side==='A'?a:b)[kind]];return ids.map(id=>{const x=find(id);return x?x.name+' · v'+x.version:'沿用 Agent 内置';}).join('、');};return <tr key={kind}><td style={TD}>{dimensionLabels[kind]}</td><td style={TD}>{display('A')}</td>{dimension!=='single'&&<td style={TD}>{dimension===kind?display('B'):'与 A 组相同'}</td>}</tr>;})}</tbody></table></div><p>执行地址：{endpoint}<br/>Agent 模型：{model||'沿用 Agent 默认模型'}<br/>Case：{caseIds.length} 条{dimension==='dataset'?' / B 组 '+caseBIds.length+' 条':''}</p><label className="block max-w-xs">通过率门槛（%）<input type="number" min="0" max="100" aria-label="通过率门槛" className={demoField} value={threshold} onChange={e=>setThreshold(Number(e.target.value))}/></label><details><summary className="cursor-pointer text-sm">并发、超时与重试</summary><div className="mt-3 grid gap-3 md:grid-cols-3">{[{label:'并发数',value:concurrency,set:setConcurrency,min:1,max:8},{label:'超时（秒）',value:timeout,set:setTimeoutSeconds,min:1,max:600},{label:'重试次数',value:retries,set:setRetries,min:0,max:3}].map(item=><label key={item.label}>{item.label}<input type="number" aria-label={item.label} className={demoField} min={item.min} max={item.max} value={item.value} onChange={e=>item.set(Number(e.target.value))}/></label>)}</div></details>{dimension==='evaluator'&&<p className="text-sm text-foreground-muted">Agent 只执行一次；A/B 评估器对同一份实际 Trace 分别评分。</p>}</>}
   <div className="flex justify-between border-t border-border pt-4"><button className={button} disabled={step===1||busy} onClick={()=>setStep(step-1)}>上一步</button>{step<4?<button className={primary} disabled={!!invalid||(step>=2&&!casesValid)} onClick={()=>setStep(step+1)}>下一步</button>:<button className={primary} disabled={busy||!!invalid||!casesValid} onClick={run}>{busy?'正在创建并启动…':'开始实验'}</button>}</div>
  </section>
 </div>;
}

export default function DemoExperimentWizard(){return <Suspense fallback={<p>正在加载实验设计…</p>}><DemoExperimentWizardContent/></Suspense>;}
