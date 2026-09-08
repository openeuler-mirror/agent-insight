'use client';
import {useCallback, useEffect, useState} from 'react';
import Link from 'next/link';
import {useRouter,useSearchParams} from 'next/navigation';
import {apiFetch} from '@/lib/client/api';
import {useAuth} from '@/lib/auth/auth-context';
import {isBuiltinReliabilityDataset} from '@/lib/agent-dataset-builtin';
import CaseEditor from './CaseEditor';
import EvaluationWorkspace from './Workspace';
import {applyCaseDrafts, updateCaseDraft, caseSummary, type CaseDrafts} from './dataset-draft';
import type {VersionedDatasetAsset} from './dataset-catalog';
import type {EvalCase} from '@/lib/evaluation-harness/domain';
import styles from '@/components/DatasetItemsPage.module.css';
const primary = `${styles.addSplit} ${styles.addSplitPrimary}`;
export default function VersionedDatasetDetail({assetId}: {assetId:string}) {
  const {apiKey,user}=useAuth(), router=useRouter(), search=useSearchParams();
  const [assets,setAssets]=useState<VersionedDatasetAsset[]>([]), [selected,setSelected]=useState(assetId);
  const [error,setError]=useState(''), [loaded,setLoaded]=useState(false), [busy,setBusy]=useState(false), [confirmDelete,setConfirmDelete]=useState(false);
  const [drafts,setDrafts]=useState<CaseDrafts>({}), [readyKey,setReadyKey]=useState('');
  const [editing,setEditing]=useState<EvalCase|null>(null), [valid,setValid]=useState(true);
  const [name,setName]=useState('新评测集'), [query,setQuery]=useState(''), [page,setPage]=useState(1);
  const draftKey=user?`evaluation-case-drafts:${encodeURIComponent(user)}:${selected}`:'';
  const request=useCallback(async(body?:unknown)=>{
    const r=await apiFetch('/api/evaluation-harness',{method:body?'POST':'GET',headers:{'Content-Type':'application/json','x-witty-api-key':apiKey||''},...(body?{body:JSON.stringify(body)}:{})});
    const d=await r.json(); if(!r.ok)throw Error(d.error||'操作失败'); return d;
  },[apiKey]);
  const load=useCallback(async()=>{try{const d=await request();setAssets(d.assets.filter((a:VersionedDatasetAsset)=>a.kind==='dataset'));setLoaded(true);}catch(e){setError((e as Error).message);}},[request]);
  useEffect(()=>{if(apiKey)void load();},[apiKey,load]);
  useEffect(()=>{
    if(!draftKey)return;
    setDrafts({}); setReadyKey(''); setEditing(null); setPage(1);
    try {const saved=JSON.parse(localStorage.getItem(draftKey)||'{}');
      if(!saved||Array.isArray(saved)||typeof saved!=='object'||Object.entries(saved).some(([id,c]:any)=>c!==null&&(!c||c.id!==id||!Array.isArray(c.turns))))throw Error('草稿格式无效');
      setDrafts(saved);setReadyKey(draftKey);
    } catch {setError('无法读取当前浏览器草稿，请检查浏览器存储后重试。');}
  },[draftKey]);
  const anchor=assets.find(a=>a.id===assetId), versions=assets.filter(a=>a.assetKey===anchor?.assetKey).sort((a,b)=>b.version-a.version);
  const dataset=versions.find(a=>a.id===selected), base=dataset?.content.cases||[];
  const activeDrafts=readyKey===draftKey?drafts:{};
  const current=applyCaseDrafts(base,activeDrafts), changed=Object.keys(activeDrafts).length;
  const rows=[...base,...current.filter(c=>!base.some(b=>b.id===c.id))].map(c=>({original:c,value:activeDrafts[c.id]||c,deleted:Object.hasOwn(activeDrafts,c.id)&&activeDrafts[c.id]===null}));
  const filtered=rows.filter(({value:c})=>[c.name,c.id,caseSummary(c).input,caseSummary(c).output].join(' ').toLowerCase().includes(query.toLowerCase()));
  const pages=Math.max(1,Math.ceil(filtered.length/20)), currentPage=Math.min(page,pages);
  function persist(next:CaseDrafts){
    if(dataset?.archived||!draftKey||readyKey!==draftKey)return false;
    try{if(Object.keys(next).length)localStorage.setItem(draftKey,JSON.stringify(next));else localStorage.removeItem(draftKey);setDrafts(next);setError('');return true;}
    catch{setError('草稿保存失败，可能是浏览器存储空间不足。当前编辑仍保留，请勿关闭。');return false;}
  }
  function revert(id:string){const next={...activeDrafts};delete next[id];persist(next);}
  async function publish(){
    if(dataset?.archived){setError('评测集已删除，请先恢复后再发布新版本。');return;}
    setBusy(true);setError('');
    try{
      const d=await request({action:'asset',kind:'dataset',assetKey:anchor?.assetKey||'dataset-'+crypto.randomUUID(),name:anchor?.name||name,content:{cases:current}});
      try{localStorage.removeItem(draftKey);}catch{}
      setDrafts({});setSelected(d.id);await load();router.push('/dataset/versioned-'+d.id);
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function archiveDataset(){
    if(!dataset||!user)return;setBusy(true);setError('');
    try{
      if(dataset.archived){await request({action:'archive',id:dataset.id,archived:false});await load();}
      else{const response=await apiFetch(`/api/agent-datasets/versioned-${encodeURIComponent(dataset.id)}?user=${encodeURIComponent(user)}`,{method:'DELETE'});const result=await response.json();if(!response.ok)throw Error(result.error||'删除失败');router.push('/dataset');}
      setConfirmDelete(false);
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  function download(){if(!dataset)return;const url=URL.createObjectURL(new Blob([JSON.stringify(dataset.content,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`${dataset.name}-v${dataset.version}.json`;a.click();URL.revokeObjectURL(url);}
  function add(){setValid(true);setEditing({id:'case-'+crypto.randomUUID(),name:'新增 Case',category:'positive',difficulty:'medium',tags:[],note:'',turns:[{input:'',expectedOutput:'',expectation:{requiredTools:[],forbiddenTools:[],toolOrder:[],fields:[],blocking:true}}]});}
  return <div style={{flex:1,minHeight:0,overflow:'auto'}}>
    <div style={{padding:'14px 22px',borderBottom:'1px solid var(--border)'}}>
      <div className="flex flex-wrap items-center gap-3"><Link href="/dataset" className="ai-btn-s">← 返回</Link><h1 className="text-lg font-semibold">{dataset?.name||anchor?.name||'新建评测集'}</h1>
        {versions.length>0&&<label>版本 <select aria-label="评测集版本" disabled={busy} value={selected} onChange={e=>{setSelected(e.target.value);setError('');}} className="ai-input">{versions.map(v=><option key={v.id} value={v.id}>v{v.version}{v.archived?' · 已删除':''}</option>)}</select></label>}
        {assetId==='new'&&<input aria-label="评测集名称" className="ai-input" value={name} onChange={e=>setName(e.target.value)}/>}
      </div><p className="mt-2 text-xs text-foreground-muted">{current.length} 条数据项 · 输入为用户首次输入，预期输出为 Agent 最终应返回的答案；每轮规则在编辑中配置。</p>
    </div>
    <div style={{padding:'12px 22px'}}>{error&&<p role="alert" className="text-error">{error}</p>}{!loaded&&<p>加载中…</p>}{loaded&&!dataset&&assetId!=='new'&&<p>评测集不存在或无权访问。</p>}
    {(dataset||assetId==='new')&&<>
      {dataset?.archived&&<p role="status" className="mb-3 text-sm text-foreground-muted">评测集已删除，当前仅查看保留的版本。恢复后可编辑、发布新版本或新建实验；历史实验仍可查看。</p>}
      <div className={styles.tableShell}>
        <div className={styles.tableToolbar}><div className={styles.tabList}><span className={`${styles.tabButton} ${styles.tabButtonActive}`}>数据项 <span className={styles.toolbarMeta}>{current.length} 条</span></span></div>
          <div className={styles.toolbarRight}>
            <button className="ai-btn-s" disabled={busy||dataset?.archived||readyKey!==draftKey||current.length>=500} onClick={add}>添加 Case</button>
            <button className={primary} disabled={busy||dataset?.archived||!changed||!current.length||!name.trim()||readyKey!==draftKey} onClick={publish}>{busy?'发布中…':'发布新版本'}</button>
            {dataset&&<><button className={styles.refreshGhost} onClick={download}>导出 JSON</button><button className={styles.refreshGhost} onClick={async()=>{try{const XLSX=await import('xlsx'),book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(base.map(c=>({...c,tags:JSON.stringify(c.tags),turns:JSON.stringify(c.turns)}))),'Cases');XLSX.writeFile(book,`${dataset.name}-v${dataset.version}.xlsx`);}catch(e){setError((e as Error).message);}}}>导出 Excel</button>
            <button className="ai-btn-s" disabled={busy} onClick={async()=>{setBusy(true);try{const copy=await request({action:'asset',kind:'dataset',assetKey:'dataset-'+crypto.randomUUID(),name:dataset.name+' · 副本',content:dataset.content});setSelected(copy.id);await load();router.push('/dataset/versioned-'+copy.id);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>复制评测集</button>
            {!dataset.archived&&<Link className={primary} href={'/experiments/new?datasetId='+dataset.id}>新建实验</Link>}
            {!isBuiltinReliabilityDataset(dataset)&&<button className="ai-btn-s" disabled={busy} onClick={()=>dataset.archived?void archiveDataset():setConfirmDelete(true)}>{dataset.archived?'恢复评测集':'删除评测集'}</button>}</>}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 p-3"><input className="ai-input" aria-label="搜索 Case" placeholder="搜索 Case、输入或预期输出" value={query} onChange={e=>{setQuery(e.target.value);setPage(1);}}/><span role="status" className="text-xs text-foreground-muted">{changed?`${changed} 条待发布改动 · 草稿已保存至当前浏览器`:'当前无待发布改动'}</span></div>
        <div className={styles.tableScroll}><table className={styles.dataTable}><thead><tr>{['Case 名称','场景 / 难度','类别','输入','预期输出','操作'].map(t=><th key={t}>{t}</th>)}</tr></thead><tbody>
          {filtered.slice((currentPage-1)*20,currentPage*20).map(({original,value:c,deleted})=><tr key={c.id} style={{opacity:deleted?0.6:1}}><td>{c.name}{Object.hasOwn(activeDrafts,c.id)&&<small className="block text-foreground-muted">{deleted?'待删除':base.some(b=>b.id===c.id)?'已修改 · 待发布':'已新增 · 待发布'}</small>}</td><td>{({positive:'正常',negative:'反例',boundary:'边界'})[c.category]} / {({easy:'简单',medium:'中等',hard:'困难'})[c.difficulty]}</td><td>{c.turns.length>1?'多轮':'单轮'}</td><td style={{whiteSpace:'pre-wrap'}}>{caseSummary(c).input}</td><td style={{whiteSpace:'pre-wrap'}}>{caseSummary(c).output||'未填写'}</td><td><div className="flex gap-2">
            {!deleted&&<><button className={styles.refreshGhost} disabled={busy||dataset?.archived||readyKey!==draftKey} onClick={()=>{setEditing(structuredClone(c));setValid(true);}}>编辑</button><button className={styles.refreshGhost} disabled={busy||dataset?.archived||readyKey!==draftKey} onClick={()=>persist(updateCaseDraft(base,activeDrafts,c.id,null))}>删除</button></>}
            {Object.hasOwn(activeDrafts,original.id)&&<button className={styles.refreshGhost} disabled={busy||dataset?.archived} onClick={()=>revert(original.id)}>{deleted?'恢复':'撤销修改'}</button>}
          </div></td></tr>)}
          {!filtered.length&&<tr><td colSpan={6}>没有匹配的 Case</td></tr>}
        </tbody></table></div>
        <div className="flex items-center justify-end gap-3 p-3"><span>共 {filtered.length} 条 · 第 {currentPage} / {pages} 页</span><button className="ai-btn-s" disabled={currentPage===1} onClick={()=>setPage(currentPage-1)}>上一页</button><button className="ai-btn-s" disabled={currentPage===pages} onClick={()=>setPage(currentPage+1)}>下一页</button></div>
      </div>
      <p className="mt-3 text-xs text-foreground-muted">逐条保存草稿后，统一发布为新版本。撤销修改恢复到所选版本；历史版本始终保留。草稿仅保存在当前浏览器，导出、复制和实验使用已发布版本。</p>
    </>}
    {confirmDelete&&<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"><section role="dialog" aria-modal="true" aria-label="删除评测集" className="max-w-md rounded-xl border border-border bg-background p-5 space-y-4"><h2>删除评测集「{dataset?.name}」？</h2><p>所有版本将从可选列表中移除，历史实验保留。删除后可以恢复。</p><div className="flex justify-end gap-2"><button className="ai-btn-s" disabled={busy} onClick={()=>setConfirmDelete(false)}>取消</button><button className="ai-btn-s" disabled={busy} onClick={()=>void archiveDataset()}>确认删除</button></div></section></div>}
    {editing&&<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"><section role="dialog" aria-modal="true" aria-label="编辑 Case" className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-xl border border-border bg-background p-5 shadow-xl space-y-3"><h2>编辑 Case · {editing.name}</h2><p className="text-xs text-foreground-muted">保存只更新这一条 Case 的浏览器草稿，发布新版本后才可用于实验。</p><CaseEditor key={editing.id} singleCase cases={[editing]} onChange={next=>setEditing(next[0])} onValid={setValid}/><div className="flex gap-2"><button className="ai-btn-s" onClick={()=>setEditing(null)}>取消</button><button className={primary} disabled={dataset?.archived||!valid||!editing.name.trim()||editing.turns.some(t=>!t.input.trim())} onClick={()=>{if(persist(updateCaseDraft(base,activeDrafts,editing.id,editing)))setEditing(null);}}>保存草稿</button></div>{error&&<p role="alert" className="text-error">{error}</p>}</section></div>}
    <details className="mt-4" open={search?.get('tools')==='1'?true:undefined}><summary>生成或导入数据项</summary><EvaluationWorkspace mode="datasets" datasetToolsOnly/></details>
    </div>
  </div>;
}
