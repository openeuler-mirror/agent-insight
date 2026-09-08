'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import CaseEditor from './CaseEditor';
import {NH_DEMO} from '@/lib/evaluation-harness/demo-profile';
import ComparisonResults from './ComparisonResults';
import EvaluatorComparisonGroups from '@/components/experiments/EvaluatorComparisonGroups';
import { type ExperimentChoice } from '@/components/experiments/ExperimentWizard';
import { presetEvaluators } from '@/lib/evaluators/preset-evaluators';
import { comparisonLabels, validateComparison } from '@/lib/evaluation-harness/comparison';
import { caseRerunConfig } from '@/lib/evaluation-harness/case-rerun';
import { resolveComparisonTargets, resolveAgentFromNative } from '@/lib/engine/experiment/comparison-target-selection';
import CaseRulesDialog from './CaseRulesDialog';
import {caseSummary} from './dataset-draft';
import VersionExperiments from './VersionExperiments';
import { type SelectedCase, ExperimentWizard, ExperimentTypeSelector, Stepper, GenerationCaseRow, TraceSourceSelector, ExpectedAnswersTable, ExperimentSummary, EvaluatorChoiceCard, experimentTableHeader as TH, experimentTableCell as TD } from '@/components/experiments/ExperimentWizard';
import styles from './Workspace.module.css';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import { isBuiltinReliabilityDataset } from '@/lib/agent-dataset-builtin';
import type { EvalCase, Target } from '@/lib/evaluation-harness/domain';
import type { CaseResult } from '@/lib/evaluation-harness/rules';
interface Asset {
  id: string;
  kind: string;
  assetKey: string;
  name: string;
  version: number;
  content: any;
  contentHash: string;
  archived?: boolean;
}
interface Run {
  summary?: any;
  id: string;
  name: string;
  status: string;
  manifest: any;
  createdAt: string;
}
const field = 'min-w-0 w-full rounded-md border border-border bg-background px-3 py-2 text-sm';
const btn = 'inline-flex items-center justify-center gap-2 leading-5 rounded-md border border-border px-3 py-2 text-sm hover:bg-background-secondary disabled:opacity-50';
const primary = btn + ' bg-primary text-primary-foreground ' + styles.primary;
const advice = (name: string) => name==='路由' ? '优先检查 Agent 路由提示词及 Skill 描述，明确触发和排除范围。' : /工具|结束状态/.test(name) ? '检查 Skill 的执行步骤、工具参数和审批条件；对照该轮 Trace 确认问题发生在哪一步。' : /字段|JSON|文本|正则/.test(name) ? '核对输出格式与业务约束；如果规则与业务定义不一致，修订 Case 并另存版本。' : '对照实际证据和预期逐轮复核，再决定修改目标实现、评估器还是 Case。';
const card = styles.panel + ' space-y-4';
const labels: Record<string, string> = { pass: '通过', fail: '失败', unknown: '未评完整' };
function datasetSelectionError(dataset: Pick<Asset, 'name' | 'version' | 'archived'> | undefined, datasetB: Pick<Asset, 'name' | 'version' | 'archived'> | undefined, comparing: boolean) {
  const groups = comparing ? [{ label: 'A 组', dataset }, { label: 'B 组', dataset: datasetB }] : [{ label: '', dataset }];
  return groups.flatMap(group => !group.dataset
    ? [`${group.label}请选择可用的评测集版本。`]
    : group.dataset.archived ? [`${group.label}评测集「${group.dataset.name}」v${group.dataset.version} 已删除，请先在评测数据集中恢复，或改选其他评测集。历史实验仍可查看。`] : []).join(' ');
}
export default function EvaluationWorkspace({
  mode = 'create',
  experimentId,
  detailSupplement = false,
  initialDatasetId,
  datasetToolsOnly = false
}: {
  mode?: 'create' | 'versions' | 'datasets' | 'evaluators';
  experimentId?: string;
  detailSupplement?: boolean;
  initialDatasetId?: string;
  datasetToolsOnly?: boolean;
}) {
  const {
    apiKey, user
  } = useAuth();
  const router = useRouter();
  const [nativeAgents, setNativeAgents] = useState<any[]>([]);
  const [ordinaryDatasets, setOrdinaryDatasets] = useState<any[]>([]);
  const [traceSource, setTraceSource] = useState<'generate' | 'existing'>('generate');
  const [pickedTraces, setPickedTraces] = useState<SelectedCase[]>([]);
  const [traceCases, setTraceCases] = useState<Record<string,string>>({});
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);
  const [traceBindings, setTraceBindings] = useState<Record<string, string>>({});
  const [availableTraces, setAvailableTraces] = useState<any[]>([]);
  const [tracePage, setTracePage] = useState(1);
  const [traceTotal, setTraceTotal] = useState(0);
  const [experimentType, setExperimentType] = useState<ExperimentChoice>('single');
  const [targetBId,setTargetB] = useState('');
  const [skillAId,setSkillA] = useState('');
  const [skillBId,setSkillB] = useState('');
  const [datasetBId,setDatasetB] = useState('');
  const [selectedCaseBIds,setSelectedCaseBIds] = useState<string[]>([]);
  const restoredSelections = useRef<{A?:{datasetId:string;ids:string[]};B?:{datasetId:string;ids:string[]}}>({});
  const [evalBIds,setEvalBIds] = useState<string[]>([]);
  const [comparisonSkills,setComparisonSkills] = useState<string[]>([]);
  const [nativeEvaluators,setNativeEvaluators] = useState<any[]>(presetEvaluators);
  const [comparisonModels, setComparisonModels] = useState<string[]>([]);
  const [groupA, setGroupA] = useState('');
  const [groupB, setGroupB] = useState('');
  useEffect(() => {
    if (!user) return;
    let active = true;
    const loadCatalog = () => Promise.all([
      apiFetch('/api/experiments/agents?user=' + encodeURIComponent(user)).then(r => { if (!r.ok) throw new Error('Agent 目录加载失败'); return r.json(); }),
      apiFetch('/api/user-evaluators?user='+encodeURIComponent(user)).then(r=>r.ok?r.json():[]).then(c=>{if(active)setNativeEvaluators([...presetEvaluators,...(Array.isArray(c)?c:[])]);}),
      apiFetch('/api/agent-datasets?view=summary&user=' + encodeURIComponent(user)).then(r => { if (!r.ok) throw new Error('评测集目录加载失败'); return r.json(); }),
    ]).then(([a, _evaluators, d]) => { if (active) { setNativeAgents(a.agents || []); setOrdinaryDatasets(Array.isArray(d) ? d : d.datasets || []); } }).catch(e => { if (active) setError(e.message); });
    void loadCatalog();
    const timer = window.setInterval(loadCatalog, 10_000);
    const handleFocus = () => { void loadCatalog(); };
    window.addEventListener('focus', handleFocus);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', handleFocus); };
  }, [user]);
  const casesRef = useRef<HTMLElement>(null);
  const analysisRef = useRef<HTMLElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [caseFilter, setCaseFilter] = useState('all');
  const [caseSearch, setCaseSearch] = useState('');
  useEffect(() => { setCaseFilter('all'); setCaseSearch(''); }, [experimentId]);
  const [creating, setCreating] = useState(false);
  const displayMode = creating ? 'create' : mode;
  const [formMode, setFormMode] = useState(true),
    [editorValid, setEditorValid] = useState(true),
    [legacyDatasets, setLegacyDatasets] = useState<any[]>([]),
    [comparison, setComparison] = useState(''),
    [showArchived, setShowArchived] = useState(false),
    [notice, setNotice] = useState(''),
    [revisedDatasetId, setRevisedDatasetId] = useState('');
  const [revisedDatasetSide,setRevisedDatasetSide]=useState<'A'|'B'>('A');
  const [assets, setAssets] = useState<Asset[]>([]),
    [credentials, setCredentials] = useState<any[]>([]),
    [runs, setRuns] = useState<Run[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [step, setStep] = useState(1),
    [targetId, setTarget] = useState(''),
    [datasetId, setDataset] = useState(initialDatasetId || ''),
    [evalIds, setEvals] = useState<string[]>([]),
    [name, setName] = useState('业务验收'),
    [threshold, setThreshold] = useState(90),
    [concurrency, setConcurrency] = useState(2),
    [timeout, setTimeoutSeconds] = useState(60),
    [retries, setRetries] = useState(1),
    [detail, setDetail] = useState<any>(null),
    [id, setId] = useState(experimentId || ''),
    [editor, setEditor] = useState<null | {
      kind: string;
      title: string;
      data: string;
      asset?: Asset;
      caseId?: string;
    }>(null),
    [analysis, setAnalysis] = useState<any>(null),
    [axis, setAxis] = useState('agent'),
    [fixed, setFixed] = useState(''),
    [filterTarget, setFilterTarget] = useState(''),
    [filterDataset, setFilterDataset] = useState(''),
    [credentialId, setCredential] = useState(''),
    [sourceId, setSource] = useState('');
  useEffect(() => {
    if (analysis) analysisRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [analysis]);
  const request = useCallback(async (body?: unknown, query = '') => {
    const r = await apiFetch('/api/evaluation-harness' + query, {
      method: body ? 'POST' : 'GET',
      headers: {
        'content-type': 'application/json',
        'x-witty-api-key': apiKey || ''
      },
      ...(body ? {
        body: JSON.stringify(body)
      } : {})
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '请求失败');
    return d;
  }, [apiKey]);
  const refresh = useCallback(async () => {
    const d = await request();
    setAssets(d.assets);
    setLegacyDatasets(d.legacyDatasets || []);
    setCredentials(d.credentials);
    setRuns(d.runs);
    setLoaded(true);
    setTarget(v => v || d.assets.find((x: Asset) => x.kind === 'target' && !x.archived)?.id || '');
    setDataset(v => v || new URLSearchParams(window.location.search).get('datasetId') || d.assets.find((x: Asset) => x.kind === 'dataset' && !x.archived)?.id || '');
    setEvals(v => v.length ? v : d.assets.filter((x: Asset) => x.kind === 'evaluator' && x.content.type === 'rules').slice(0, 1).map((x: Asset) => x.id));
  }, [request]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (apiKey) void refresh().catch(e => setError(e.message));
  }, [apiKey, refresh]);
  useEffect(() => {
    if (!apiKey || !id) return;
    let alive = true;
    const load = () => request(undefined, '?experimentId=' + encodeURIComponent(id)).then(d => {
      if (alive) {
        setDetail(d);
        if (!['draft', 'running'].includes(d.experiment.status)) window.clearInterval(timer);
      }
    }).catch(e => {
      if (alive) setError(e.message);
    });
    void load();
    const timer = window.setInterval(load, 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [id, apiKey, request]);
  const target = assets.find(a => a.id === targetId),
    dataset = assets.find(a => a.id === datasetId),
    list = (kind: string) => assets.filter(a => a.kind === kind && (showArchived || !a.archived)),
    assetOptions = (kind: string) => list(kind).map(a => <option key={a.id} value={a.id}>{a.name} · v{a.version}</option>);
  const nativeName = targetId.startsWith('native:') ? targetId.slice(7) : target?.name || '';
  const nativeFlow = experimentType!=='dataset' && (datasetId.startsWith('legacy:') || datasetId === 'none');
  const datasetB = assets.find(a=>a.id===datasetBId);
  const targetB = assets.find(a=>a.id===targetBId);
  const skillA=assets.find(a=>a.id===skillAId), skillB=assets.find(a=>a.id===skillBId);
  const comparisonValid = experimentType==='single' || (nativeFlow
    ? Boolean(groupA && groupB && groupA!==groupB)
    : experimentType==='dataset' ? Boolean(dataset && datasetB && dataset.id!==datasetB.id)
    : experimentType==='evaluator' ? true
    : experimentType==='llm' ? Boolean(groupA.trim() && groupB.trim() && groupA.trim()!==groupB.trim())
    : experimentType==='skill' ? Boolean(skillA && skillB && skillA.id!==skillB.id && skillA.assetKey===skillB.assetKey)
    : Boolean(target && targetB && target.id!==targetB.id && target.content.type==='agent' && targetB.content.type==='agent'));
  let sharedTargetError='';
  if(!nativeFlow && experimentType==='agent' && target && targetB) {
    try {validateComparison({dimension:'agent',targetBId},target,targetB,evalIds);} catch(e){sharedTargetError=(e as Error).message;}
  }
  const datasetError = nativeFlow ? '' : datasetSelectionError(dataset, datasetB, experimentType==='dataset');
  const selectionValid = !datasetError && !!name.trim() && !!nativeName && (!!target || nativeAgents.some(a => a.name === nativeName)) && !!datasetId && (nativeFlow || target?.content.type==='agent') && comparisonValid && !sharedTargetError;
  const evalComparisonValid = experimentType!=='evaluator' || nativeFlow || (evalIds.length>0 && evalBIds.length>0 && [...evalBIds].sort().join()!==[...evalIds].sort().join());
  const nativeComparisonOptions = experimentType==='agent' ? nativeAgents.map(a=>({value:a.name,label:a.name})) : experimentType==='skill' ? comparisonSkills.map(value=>({value,label:value==='__NONE__'?'无 Skill':value})) : experimentType==='evaluator' ? nativeEvaluators.filter(e=>e.status==='ready').map(e=>({value:e.id,label:e.name})) : undefined;
  function changeExperimentType(value:ExperimentChoice) {
    setExperimentType(value);setGroupA('');setGroupB('');setTargetB('');setDatasetB('');setEvalBIds([]);
    if(value==='dataset') {
      const chosen=dataset || list('dataset')[0];
      if(chosen) {setDataset(chosen.id);setDatasetB(list('dataset').find(d=>d.id!==chosen.id && d.assetKey===chosen.assetKey)?.id || list('dataset').find(d=>d.id!==chosen.id)?.id || '');}
    }
    if (value!=='single' && value!=='evaluator') setTraceSource('generate');
    if (nativeFlow && value==='agent') {setGroupA(nativeName);setGroupB(nativeAgents.find(a=>a.name!==nativeName)?.name || '');}
  }
  useEffect(() => {
    if(nativeFlow || !assets.length)return;
    const resolvedAgentId=resolveAgentFromNative(assets,targetId);
    const agentSelection=resolvedAgentId.startsWith('native:')?{targetId:resolvedAgentId,targetBId}:resolveComparisonTargets(assets,resolvedAgentId,targetBId,'agent');
    if(agentSelection.targetId!==targetId)setTarget(agentSelection.targetId);
    if(experimentType==='agent' && agentSelection.targetBId!==targetBId)setTargetB(agentSelection.targetBId);
    if(experimentType==='skill') {
      const skillSelection=resolveComparisonTargets(assets,skillAId,skillBId,'skill');
      if(skillSelection.targetId!==skillAId)setSkillA(skillSelection.targetId);
      if(skillSelection.targetBId!==skillBId)setSkillB(skillSelection.targetBId);
    }
  },[assets,experimentType,nativeFlow,targetId,targetBId,skillAId,skillBId]);
  const previousNativeFlow = useRef(nativeFlow);
  useEffect(() => {
    if(previousNativeFlow.current===nativeFlow)return;
    previousNativeFlow.current=nativeFlow;
    setGroupA('');setGroupB('');
    if(nativeFlow && experimentType==='agent') {setGroupA(nativeName);setGroupB(nativeAgents.find(a=>a.name!==nativeName)?.name || '');}
  },[nativeFlow,experimentType,nativeName,nativeAgents]);
  useEffect(() => {
    if (!user || !nativeName || !['llm','skill'].includes(experimentType)) return;
    let active = true;
    void apiFetch('/api/experiments/traces?user=' + encodeURIComponent(user) + '&agent=' + encodeURIComponent(nativeName) + '&pageSize=100')
      .then(r => r.ok ? r.json() : { items: [] })
      .then(d => { if (active) {setComparisonModels([...new Set<string>((d.items || []).map((t: any) => t.model).filter((m: any) => typeof m === 'string' && m))]);setComparisonSkills([...new Set<string>((d.items||[]).filter((t:any)=>typeof t.skillName==='string' && t.skillName.trim() && t.skillName!=='__NONE__' && !/^[\[{]/.test(t.skillName)).map((t:any)=>t.skillName+(t.skillVersion==null?'':'@v'+t.skillVersion)))]);} })
      .catch(() => { if (active) {setComparisonModels([]);setComparisonSkills([]);} });
    return () => { active = false; };
  }, [user, nativeName, experimentType]);
  useEffect(() => {
    if (!user || traceSource !== 'existing' || nativeFlow || !nativeName) return;
    let active = true;
    void apiFetch('/api/experiments/traces?user=' + encodeURIComponent(user) + '&agent=' + encodeURIComponent(nativeName) + '&page=' + tracePage + '&pageSize=100')
      .then(async r => { if (!r.ok) throw new Error('Trace 列表加载失败'); return r.json(); })
      .then(d => { if (active) { setAvailableTraces(d.items || []); setTraceTotal(d.total || 0); } }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [user, traceSource, nativeFlow, nativeName, tracePage]);
  useEffect(() => { setTraceBindings({}); setTracePage(1); setPickedTraces([]); setTraceCases({}); }, [targetId, datasetId]);
  useEffect(() => { if(!dataset)return; setSelectedCaseIds(restoredSelections.current.A?.datasetId===datasetId?restoredSelections.current.A.ids:dataset?.content.cases.map((c: EvalCase) => c.id) || []); delete restoredSelections.current.A;  }, [datasetId, dataset?.contentHash]);
  useEffect(() => { if(!datasetB)return; setSelectedCaseBIds(restoredSelections.current.B?.datasetId===datasetBId?restoredSelections.current.B.ids:datasetB?.content.cases.map((c: EvalCase) => c.id) || []); delete restoredSelections.current.B; }, [datasetBId, datasetB?.contentHash]);
  const selectedCasesB: EvalCase[] = (datasetB?.content.cases || []).filter((c:EvalCase)=>selectedCaseBIds.includes(c.id));
  const selectedCases: EvalCase[] = (dataset?.content.cases || []).filter((c: EvalCase) => traceSource === 'existing' ? pickedTraces.some(t => traceCases[t.executionId] === c.id) : selectedCaseIds.includes(c.id));
  const traceAssociationsValid = pickedTraces.length > 0 && pickedTraces.every(t => dataset?.content.cases.some((c: EvalCase) => c.id === traceCases[t.executionId]));

  function assetPicker(kind:'agent'|'skill'|'dataset',side?:'A'|'B') {
    const selected=kind==='agent'?(side==='B'?targetB:target):kind==='skill'?(side==='B'?skillB:skillA):(side==='B'?datasetB:dataset);
    const selectedId=kind==='agent'?(side==='B'?targetBId:targetId):kind==='skill'?(side==='B'?skillBId:skillAId):(side==='B'?datasetBId:datasetId);
    const select=kind==='agent'?(side==='B'?setTargetB:setTarget):kind==='skill'?(side==='B'?setSkillB:setSkillA):(side==='B'?setDatasetB:setDataset);
    const versions=assets.filter(a=>a.kind===(kind==='dataset'?'dataset':'target') && (!a.archived || a.id===selected?.id) && (kind==='dataset' || a.content.type===kind) && (kind!=='skill' || side!=='B' || a.assetKey===skillA?.assetKey)).sort((a,b)=>b.version-a.version);
    const objects=versions.filter((a,i,all)=>all.findIndex(x=>x.assetKey===a.assetKey)===i);
    const extras=kind==='agent' && nativeFlow?nativeAgents.filter(a=>!objects.some(x=>x.name===a.name)).map(a=>({id:'native:'+a.name,name:a.name})):kind==='dataset' && experimentType!=='dataset'?ordinaryDatasets.map(d=>({id:'legacy:'+d.id,name:d.name})):[];
    const label=kind==='agent'?'Agent':kind==='skill'?'Skill':'评测集';
    const aria=(side?side+' 组 ':'')+label;
    return <div className={styles.assetPicker}>
      <label className="min-w-0">{label}<select aria-label={aria} className={field} value={selected?.assetKey || selectedId} onChange={e=>{if(kind==='dataset')delete restoredSelections.current[side || 'A'];select(versions.find(a=>a.assetKey===e.target.value)?.id || e.target.value);}}>
        {!selectedId && <option value="">请选择{label}</option>}
        {kind==='agent' && !nativeFlow && selectedId.startsWith('native:') && <option value={selectedId}>{selectedId.slice(7)}（未登记版本）</option>}
        {objects.map(a=><option key={a.assetKey} value={a.assetKey} disabled={kind==='dataset' && a.archived}>{a.name}{kind==='dataset' && a.archived?'（已删除）':''}</option>)}
        {extras.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
        {kind==='dataset' && experimentType!=='dataset' && <option value="none">不选择数据集（使用 Trace 评估）</option>}
      </select></label>
      <label className="min-w-0">{label}版本<select aria-label={aria+'版本'} className={field} value={selected?.id || ''} disabled={!selected} onChange={e=>{if(kind==='dataset')delete restoredSelections.current[side || 'A'];select(e.target.value);}}>
        {!selected && <option value="">{selectedId && selectedId!=='none'?'当前内容（未登记版本）':'请选择版本'}</option>}
        {versions.filter(a=>a.assetKey===selected?.assetKey).map(a=><option key={a.id} value={a.id} disabled={kind==='dataset' && a.archived}>v{a.version}{a.archived?(kind==='dataset'?'（已删除）':'（已归档）'):''}</option>)}
      </select></label>
    </div>;
  }
  const sharedTitle = experimentType==='single' ? '' : ({agent:'评测集、Case 与预期答案、Skill 配置、模型、评估器和运行设置',skill:'Agent 与版本、模型、评测集、Case 与预期答案、评估器和运行设置',llm:'Agent 与版本、Skill 配置、评测集、Case 与预期答案、评估器和运行设置',dataset:'Agent 与版本、Skill 配置、模型、评估器和运行设置',evaluator:'Agent 与版本、Skill 配置、模型、评测集、Case 与预期答案和同一份 Trace'} as Record<string,string>)[experimentType];
  function comparisonGroups() {
    return <ExperimentTypeSelector groupsOnly value={experimentType} onChange={changeExperimentType} groupA={groupA} groupB={groupB} onGroupA={value=>{setGroupA(value);if(nativeFlow && experimentType==='agent')setTarget('native:'+value);}} onGroupB={setGroupB} models={comparisonModels} options={nativeFlow?nativeComparisonOptions:undefined}/>;
  }
  function groupedAssets(kind:'agent'|'skill'|'dataset') {
    return <div className="grid grid-cols-1 gap-3 md:grid-cols-2">{(['A','B'] as const).map(side=><div key={side} className="min-w-0 rounded-lg border border-border p-3 space-y-3"><h4 className="text-sm font-semibold">{side} 组</h4>{assetPicker(kind,side)}</div>)}</div>;
  }
  function agentSelection() {
    return <div className="space-y-2">{nativeFlow?<label>Agent<select aria-label="Agent" className={field} value={nativeName} onChange={e=>{setTarget('native:'+e.target.value);setGroupA('');setGroupB('');}}><option value="">请选择 Agent</option>{nativeName && !nativeAgents.some(a=>a.name===nativeName) && <option value={nativeName}>{nativeName}</option>}{nativeAgents.map(a=><option key={a.name} value={a.name}>{a.name}</option>)}</select></label>:assetPicker('agent')}</div>;
  }
  function evaluatorChoices(side:'A'|'B') {
    const selectedIds=side==='A'?evalIds:evalBIds;
    const setSelectedIds=side==='A'?setEvals:setEvalBIds;
    return list('evaluator').map(e=><EvaluatorChoiceCard key={e.id} name={e.name}
      description={e.content.type==='rules' ? (e.content.checkNames?.length ? `只检查：${e.content.checkNames.join('、')}；规则来自 Case 配置。` : '逐轮检查 Skill 路由、审批红线、工具参数与顺序、输出字段及结束状态。') : e.content.prompt || '使用模型评估实际输出与预期要求的符合程度。'}
      tags={[`v${e.version}`,e.content.type==='rules'?'业务规则':'LLM',...(e.content.criticalStop && experimentType!=='evaluator'?['关键失败停止后续评估']:[])]}
      checked={selectedIds.includes(e.id)} onToggle={()=>setSelectedIds(ids=>ids.includes(e.id)?ids.filter(id=>id!==e.id):[...ids,e.id])}/>);
  }
  function caseSelection(side:'A'|'B'='A') {
    const data=side==='A'?dataset:datasetB, ids=side==='A'?selectedCaseIds:selectedCaseBIds, setIds=side==='A'?setSelectedCaseIds:setSelectedCaseBIds;
    return <div className="space-y-3"><div className="flex flex-wrap items-center gap-3"><strong>{experimentType==='dataset'?side+' 组 · '+data?.name+' v'+data?.version:experimentType==='single'?'数据集 Case':'两组共用 Case'}（{ids.length}/{data?.content.cases.length || 0}）</strong><button className={btn} onClick={()=>setIds(data?.content.cases.map((c:EvalCase)=>c.id)||[])}>全选</button><button className={btn} onClick={()=>setIds([])}>取消全选</button></div><div className="max-h-80 overflow-auto rounded-lg border border-border">{data?.content.cases.map((c:EvalCase)=><GenerationCaseRow key={c.id} checked={ids.includes(c.id)} onChange={()=>setIds(values=>values.includes(c.id)?values.filter(v=>v!==c.id):[...values,c.id])}><strong>{c.name} · {c.turns.length} 轮</strong><div className="text-xs text-foreground-muted">{c.turns[0].input}</div></GenerationCaseRow>)}</div></div>;
  }
  function caseAnswers(cases:EvalCase[]) {
    return <ExpectedAnswersTable><thead><tr>{['Case','首次输入','最终预期输出','逐轮规则'].map(label=><th key={label} style={TH}>{label}</th>)}</tr></thead><tbody>{cases.map(c=><tr key={c.id}><td style={TD}>{c.name}<small className="block text-foreground-muted">{c.turns.length>1?'多轮':'单轮'}</small></td><td style={{...TD,whiteSpace:'pre-wrap'}}>{caseSummary(c).input}</td><td style={{...TD,whiteSpace:'pre-wrap'}}>{caseSummary(c).output||'未填写，按规则判断'}</td><td style={TD}><CaseRulesDialog value={c}/></td></tr>)}</tbody></ExpectedAnswersTable>;
  }
  function editAsset(kind: string, asset?: Asset) {
    setFormMode(true);
    setEditorValid(true);
    setEditor({
      kind,
      title: asset ? '保存为新版本' : '新增' + kind,
      asset,
      data: JSON.stringify(asset?.content || (kind === 'target' ? {
        type: 'agent',
        adapter: 'http',
        endpoint: 'https://example.com/agent',
        externalId: 'my-agent',
        prompt: '',
        skills: []
      } : kind === 'evaluator' ? {
        type: 'llm',
        prompt: '逐轮判断任务完成情况，返回 checks 数组，包含 turn、verdict 和 reason',
        criticalStop: false
      } : {
        cases: []
      }), null, 2)
    });
  }
  async function saveEditor() {
    if (!editor) return;
    const data = JSON.parse(editor.data);
    if (!editorValid) throw new Error('请先修正配置内容');
    if (editor.kind === 'case') {
      const revised = await request({
        action: 'revise',
        experimentId: id,
        caseId: editor.caseId,
        case: data
      });
      const sourceRow=detail.experiment.cases.find((row:any)=>row.id===editor.caseId);
      const sourceGroup=detail.manifest.groups?.find((group:any)=>group.id===sourceRow?.groupId);
      setRevisedDatasetSide(detail.manifest.comparison?.dimension==='dataset' && sourceGroup?.key==='B'?'B':'A');
      setRevisedDatasetId(revised.id);
      setNotice('已保存 ' + revised.name + ' v' + revised.version + '；本次实验仍保留原评测集版本。');
    } else {
      const created = await request({
        action: 'asset',
        kind: editor.kind,
        assetKey: editor.asset?.assetKey || 'asset-' + Date.now(),
        name: editor.asset?.name || editor.title,
        content: data
      });
      setNotice('已保存 ' + created.name + ' v' + created.version);
      if (editor.kind === 'dataset') {setDataset(created.id);if(NH_DEMO&&datasetToolsOnly)router.push('/dataset/versioned-'+created.id);}
      if (editor.kind === 'target') setTarget(created.id);
    }
    setEditor(null);
    await refresh();
  }
  function regression() {
    if(NH_DEMO){router.push('/experiments/new?sourceExperimentId='+encodeURIComponent(id)+(revisedDatasetId?(revisedDatasetSide==='B'?'&datasetBId=':'&datasetId=')+encodeURIComponent(revisedDatasetId):''));return;}
    setCreating(true);
    const m = detail.manifest;
    const idsA=m.caseIds || m.dataset.content.cases.map((c:EvalCase)=>c.id);
    const dataB=m.groups?.find((g:any)=>g.key==='B')?.dataset;
    const idsB=m.comparison?.caseBIds || dataB?.content.cases.map((c:EvalCase)=>c.id) || [];
    restoredSelections.current={A:{datasetId:m.dataset.id,ids:idsA},...(dataB?{B:{datasetId:dataB.id,ids:idsB}}:{})};
    setSelectedCaseIds(idsA);setSelectedCaseBIds(idsB);
    setTraceSource('generate');
    setTraceBindings({});
    setTarget(m.target.id);
    setDataset(m.dataset.id);
    setExperimentType(m.comparison?.dimension || 'single');
    setTargetB(m.comparison?.dimension==='agent'?m.comparison.targetBId || '':'');
    setSkillA(m.comparison?.skillAId || (m.comparison?.dimension==='skill'?m.target.id:''));
    setSkillB(m.comparison?.skillBId || (m.comparison?.dimension==='skill'?m.comparison?.targetBId || '':''));
    if(m.comparison?.dimension==='skill' && !m.comparison.skillAId)setNotice('原 Skill 实验没有登记执行 Agent，请为本次实验选择 Agent。');
    setDatasetB(m.comparison?.datasetBId || '');
    setGroupA(m.comparison?.modelA || '');setGroupB(m.comparison?.modelB || '');
    setEvalBIds(m.comparison?.evaluatorBIds || []);
    setEvals(m.evaluatorIds || m.evaluators.map((x: Asset) => x.id));
    setThreshold(m.threshold);
    setConcurrency(m.concurrency);
    setTimeoutSeconds(m.timeoutSeconds);
    setRetries(m.retries);
    setSource(id);
    setName(detail.experiment.name + ' · 回归');
    setId('');
    setDetail(null);
    setStep(1);
  }
  const unique = (kind: string) => list(kind).filter((a, i, all) => all.findIndex(x => x.assetKey === a.assetKey) === i);
  return <div className={styles.root + (!id && displayMode === 'create' ? ' ' + styles.createFlow : '') + " space-y-4 text-foreground"}>{(!detailSupplement || !id) && !datasetToolsOnly && <><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">{id ? '版本化实验详情' : displayMode === 'versions' ? '实验版本分析' : displayMode === 'datasets' ? '评测集版本' : displayMode === 'evaluators' ? '预置与版本化评估器' : '新建实验'}</h2><div className="flex flex-wrap gap-2">{creating && !id && <button className={btn} onClick={() => { setCreating(false); if (experimentId) { setId(experimentId); } }}>返回{experimentId ? '实验详情' : mode === 'datasets' ? '评测集' : '版本记录'}</button>}{id && <button className={btn} onClick={() => {
          if (experimentId) { router.push('/experiments'); return; }
          setId('');
          setDetail(null);
          setCreating(false);
          void action(refresh);
        }}>返回{experimentId ? '实验列表' : mode === 'versions' ? '版本记录' : '新建实验'}</button>}<button className={btn} onClick={() => action(async () => {
          await refresh();
          if (id) setDetail(await request(undefined, '?experimentId=' + encodeURIComponent(id)));
        })}>刷新</button>{loaded && !id && !assets.some(a => a.assetKey === "loan-agent") && <button className={primary} disabled={busy} onClick={() => action(async () => {
          await request({
            action: 'bootstrap'
          });
          await refresh();
        })}>初始化 Demo 目录</button>}</div></div></>}{notice && <p role="status" className="rounded border border-border p-3 text-sm">{notice}{revisedDatasetId && <button className={btn + ' ml-3'} onClick={() => {
        regression();
        const restored=restoredSelections.current[revisedDatasetSide];
        if(restored) restoredSelections.current[revisedDatasetSide]={...restored,datasetId:revisedDatasetId};
        if(revisedDatasetSide==='B') setDatasetB(revisedDatasetId); else setDataset(revisedDatasetId);
        setRevisedDatasetId('');
        setNotice('');
      }}>用修订版创建回归</button>}</p>}{error && <p role="alert" className="rounded-md bg-error-subtle p-3 text-error">{error}</p>}
 {!id && displayMode === 'create' && <><div className={styles.steps}><Stepper step={step} maxVisited={selectionValid ? 4 : 1} optionalThird={nativeFlow} summaries={[name, nativeFlow ? '选择或生成 Trace' : traceSource === 'existing' ? '使用已有 Trace' : '执行 Agent', dataset?.name || 'Case 标注', '选择评估器']} onJump={setStep}/></div><section className={card}>{step === 1 && <>
  <label className="block">实验名称<input aria-label="实验名称" className={field} value={name} onChange={e=>setName(e.target.value)}/></label>
  <div><label className={styles.fieldLabel}>实验类型</label><ExperimentTypeSelector allowDataset hideGroups value={experimentType} onChange={changeExperimentType} groupA={groupA} groupB={groupB} onGroupA={setGroupA} onGroupB={setGroupB}/></div>
  {experimentType!=='single' && <section aria-label="对比项" className="space-y-3">
    <h3 className="font-semibold">对比项</h3>
    {experimentType==='agent' && (nativeFlow?comparisonGroups():groupedAssets('agent'))}
    {experimentType==='skill' && (nativeFlow?comparisonGroups():groupedAssets('skill'))}
    {experimentType==='dataset' && groupedAssets('dataset')}
    {experimentType==='llm' && comparisonGroups()}
    {experimentType==='evaluator' && (nativeFlow?comparisonGroups():<div className="grid grid-cols-1 gap-3 md:grid-cols-2">{(['A','B'] as const).map(side=><div key={side} className="min-w-0 rounded-lg border border-border p-3 space-y-3"><h4 className="text-sm font-semibold">{side} 组</h4><div><span className={styles.fieldLabel}>评估器</span><p className="text-sm text-foreground-muted">在第四步选择评估器组合</p></div></div>)}</div>)}
    {sharedTargetError && <p role="alert" className="text-xs text-warning">{sharedTargetError}</p>}
    {!comparisonValid && <p role="alert" className="text-xs text-warning">{experimentType==='skill'?(nativeFlow?'请选择两种不同的 Skill 配置，可包含无 Skill':'请选择同一 Skill 的两个不同版本'):experimentType==='dataset'?'请选择两个不同的评测集或版本':'请选择不同的 A/B 配置'}</p>}
    <p className="text-xs text-foreground-muted">{experimentType==='skill'?'同一个 Agent 使用 A/B 两份 Skill 配置，其余条件保持一致。':experimentType==='dataset'?'每组使用自己的 Case 与验收要求；已发布版本可供选择。':experimentType==='evaluator'?'两组对同一份 Trace 独立评分。':experimentType==='llm'?'执行服务需支持指定模型，并确认实际使用的模型。':'两组使用相同评测集、模型及 Skill 配置。'}</p>
  </section>}
  <section aria-label={experimentType==='single'?'实验配置':'共享条件'} className="space-y-3">
    {experimentType!=='single' && <h3 className="font-semibold">共享条件</h3>}
    {experimentType!=='agent' && agentSelection()}
    {experimentType!=='dataset' && assetPicker('dataset')}
    <div className="flex flex-wrap gap-2"><button className={btn} disabled={!target || target.content.type!=='agent'} onClick={()=>editAsset('target',target)}>新增 Agent 版本</button><button className={btn} onClick={()=>editAsset('target')}>接入 Agent</button></div>
    <p className="text-xs text-foreground-muted">{experimentType==='single'?'版本由用户登记，执行服务需实际提供该版本。':'以上条件供两组共用；后续统一配置运行设置和评估器，开始实验后冻结。'}</p>
  </section>
  {!nativeFlow && targetId.startsWith('native:') && <p role="alert">该 Agent 尚未登记可执行版本。请先接入 Agent。</p>}
  {nativeFlow && experimentType==='skill' && <p className="text-xs">按已有 Trace 配对；实际有/无 Skill 执行可使用 <Link className="text-primary underline" href="/skills">Skill 工作台</Link>。</p>}
  {sourceId && <p className="text-xs text-foreground-muted">回归来源：{sourceId}。请核对本次执行条件。</p>}
 </>}
 {loaded && datasetError && <p role="alert" className="text-sm text-error">{datasetError}</p>}
 {step>1 && experimentType!=='single' && <div aria-label="共享条件" className="space-y-2 rounded-lg border border-border p-3 text-sm"><strong>共享条件</strong><p>{experimentType!=='agent'?`Agent：${target?.name || nativeName}${target && !nativeFlow?' v'+target.version:''}。`:''}{experimentType!=='dataset'?`评测集：${dataset?.name || ordinaryDatasets.find(d=>'legacy:'+d.id===datasetId)?.name || '未选择'}${dataset?' v'+dataset.version:''}。`:''}</p><p className="text-xs text-foreground-muted">两组共用{nativeFlow?sharedTitle.replace('Agent 与版本','Agent'):sharedTitle}；{nativeFlow?'从符合共同条件的已有 Trace 中配对。':'对象与版本沿用第一步选择。'}</p></div>}
 {nativeFlow && step > 1 && <ExperimentWizard embedded unified unifiedStep={step} onStepChange={setStep} initialSelection={{ name, agentName: nativeName, datasetId: datasetId.startsWith('legacy:') ? datasetId.slice(7) : '', type: experimentType, groupA, groupB }} />}
 {!nativeFlow && step === 2 && <><h3>选择 Trace 来源</h3>{experimentType==='single'||experimentType==='evaluator'?<TraceSourceSelector value={traceSource} onChange={setTraceSource}/>:<p className="text-sm">{experimentType==='dataset'?'同一个 Agent 分别执行 A/B 评测集，运行设置和评估器共用。':'A/B 两组分别执行同一批 Case，采集各自 Trace。'}</p>}{traceSource === 'existing' ? <><p>从下方列表多选待评估 Trace，下一步再关联 Case 和预期答案。支持跨页选择。</p><ExperimentWizard embedded unified unifiedStep={2} initialSelection={{name,agentName:nativeName,datasetId:''}} tracePicker={{values:pickedTraces,onChange:setPickedTraces}}/></> : <><h3>按 Case 轮数执行，自动采集 Trace</h3><p>每个 Case 独立会话，同一 Case 各轮使用此前真实执行历史；预期输出不发给目标。</p><p>目标：{target?.name} · {target?.content.adapter === 'demo' ? '独立 Demo 服务' : 'HTTP 服务'}；{experimentType==='dataset'?`A 组 ${selectedCaseIds.length} 个 Case，B 组 ${selectedCaseBIds.length} 个 Case`:`本次选择 ${selectedCaseIds.length} 个 Case`}。</p><div className="grid gap-3 md:grid-cols-3">{[['并发', concurrency, setConcurrency, 1, 8], ['超时秒', timeout, setTimeoutSeconds, 1, 600], ['基础设施重试', retries, setRetries, 0, 3]].map(([label, value, set, min, max]: any) => <label key={label}>{label}<input className={field} type="number" min={min} max={max} value={value} onChange={e => set(Number(e.target.value))} /></label>)}</div><p className="text-xs text-foreground-muted">错误答案和规则失败不会重试。单轮、多轮由 Case 内容决定。</p>{experimentType==='dataset'?<div className="grid gap-4 md:grid-cols-2">{caseSelection('A')}{caseSelection('B')}</div>:caseSelection()}</>}</>}
 {!nativeFlow && step === 3 && <><h3>检查数据集预期答案</h3>
 <ExperimentSummary items={(experimentType==='dataset'?[["A 组评测集", `${dataset?.name} · v${dataset?.version} · ${selectedCases.length} 个 Case`],["B 组评测集", `${datasetB?.name} · v${datasetB?.version} · ${selectedCasesB.length} 个 Case`]]:[["评测集", `${dataset?.name} · v${dataset?.version}`], ["已关联 / 选择的 Case", `${selectedCases.length} 个 Case`]])}/>
 {traceSource === 'existing' ? <><p>为每条 Trace 关联一个 Case，使用最终预期输出和逐轮规则评估。同一个 Case 可以关联多条 Trace。</p><ExpectedAnswersTable><thead><tr>{['Trace / 实际输入','关联 Case','最终预期输出','逐轮规则'].map(label=><th key={label} style={TH}>{label}</th>)}</tr></thead><tbody>{pickedTraces.map(t=>{const c:EvalCase|undefined=dataset?.content.cases.find((c:EvalCase)=>c.id===traceCases[t.executionId]);return <tr key={t.executionId}><td style={TD}><div>{t.input}</div><small>{t.executionId}</small></td><td style={TD}><select aria-label={'关联 Case '+t.executionId} className={field} value={traceCases[t.executionId]||''} onChange={e=>setTraceCases(v=>({...v,[t.executionId]:e.target.value}))}><option value="">请选择 Case</option>{dataset?.content.cases.map((c:EvalCase)=><option key={c.id} value={c.id}>{c.name} · {c.turns.length>1?'多轮':'单轮'}</option>)}</select></td><td style={{...TD,whiteSpace:'pre-wrap'}}>{c?caseSummary(c).output||'未填写，按规则判断':'关联 Case 后展示'}</td><td style={TD}>{c&&<CaseRulesDialog value={c}/>}</td></tr>;})}</tbody></ExpectedAnswersTable></> : <>{experimentType==='dataset' && <h4 className="font-semibold">A 组 · {dataset?.name} v{dataset?.version}</h4>}{caseAnswers(selectedCases)}{experimentType==='dataset' && <><h4 className="font-semibold">B 组 · {datasetB?.name} v{datasetB?.version}</h4>{caseAnswers(selectedCasesB)}</>}</>}
 <p className="text-sm text-foreground-muted">本次使用已发布的评测集版本。逐轮规则只读查看；需要修改时，请到评测数据集中编辑、发布新版本后重新选择。</p></>}
 {!nativeFlow && step === 4 && <><h3>{experimentType==='evaluator'?'对比项 · 评估器 A/B':experimentType==='single'?'评估器与执行':'评估器与执行'}</h3><ExperimentSummary items={[["实验", name], ["Agent", `${target?.name} · v${target?.version}`], [experimentType==='dataset'?"A 组评测集":"评测集", `${dataset?.name} · v${dataset?.version}`], ...(experimentType==='dataset'?[["B 组评测集", `${datasetB?.name} · v${datasetB?.version}`]]:[]), ["Trace 来源", traceSource === "existing" ? "选择 Trace" : "生成 Trace"]]}/><p className="text-sm">预置业务规则检查 Skill 路由、审批红线、工具参数与顺序、输出字段和结束状态，逐轮规则由 Case 配置。</p>{experimentType==='evaluator' ? <>
  <EvaluatorComparisonGroups groups={(['A','B'] as const).map(side=>({key:side,selectedCount:(side==='A'?evalIds:evalBIds).length,content:evaluatorChoices(side)}))}/>
  {!evalComparisonValid && <p role="alert" className="text-xs text-warning">A/B 两组均需选择评估器，且组合不能完全相同。</p>}
 </> : <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill, minmax(290px, 1fr))',gap:10}}>{evaluatorChoices('A')}</div>}
 <label className="block">通过率门槛 %<input className={field} type="number" min={0} max={100} value={threshold} onChange={e => setThreshold(Number(e.target.value))} /></label><p>关键规则失败时不放行；证据或模型服务异常不能当作通过。</p></>}
 {(!nativeFlow || step === 1) && <div className="flex justify-between"><button className={btn} disabled={step === 1} onClick={() => setStep(step - 1)}>上一步</button>{step < 4 ? <button className={primary} disabled={busy || !selectionValid || (experimentType==='dataset' && step>1 && !selectedCasesB.length) || (step > 1 && (traceSource === 'existing' ? (step === 2 ? !pickedTraces.length : !traceAssociationsValid) : !selectedCases.length))} onClick={() => setStep(step + 1)}>下一步</button> : <button className={primary} disabled={busy || !selectionValid || !evalComparisonValid || !evalIds.length || (experimentType==='dataset' && !selectedCasesB.length) || (traceSource === 'existing' ? !traceAssociationsValid : !selectedCases.length)} onClick={() => action(async () => {
            if (datasetError) throw new Error(datasetError);
            const r = await request({
              action: 'create',
              config: {
                name,
                targetId,
                datasetId,
                evaluatorIds: evalIds,
                ...(experimentType!=='single'?{comparison:{dimension:experimentType,...(experimentType==='evaluator'?{evaluatorBIds:evalBIds}:experimentType==='llm'?{modelA:groupA.trim(),modelB:groupB.trim()}:experimentType==='dataset'?{datasetBId,caseBIds:selectedCaseBIds}:experimentType==='skill'?{skillAId,skillBId}:{targetBId})}}:{}),
                ...(traceSource === 'generate' && selectedCaseIds.length !== dataset?.content.cases.length ? {caseIds:selectedCaseIds} : {}),
                traceSource,
                ...(traceSource === 'existing' ? {traceAssignments:pickedTraces.map(t=>({traceId:t.executionId,caseId:traceCases[t.executionId]}))} : {}),
                threshold,
                concurrency,
                timeoutSeconds: timeout,
                retries,
                ...(sourceId ? {
                  sourceExperimentId: sourceId
                } : {})
              }
            });
            setId(r.id);
            await request({
              action: 'run',
              id: r.id
            });
            router.push('/experiments/' + r.id);
            await refresh();
          })}>开始实验</button>}</div>}</section></>}
 {id && !detail && <p role="status">正在加载实验与 Case 列表…</p>}
 {id && detail && <><section className={card} aria-label="实验摘要">
   <div className={styles.toolbar} style={{alignItems:'flex-start'}}><div><h3 className="font-semibold">{detail.experiment.name}</h3><span className="text-sm text-foreground-muted">{({ done: '已完成', running: '运行中', draft: '待启动', failed: '执行异常', cancelled: '已终止' } as Record<string, string>)[detail.experiment.status] || detail.experiment.status}</span></div><div className={styles.actions} style={{marginLeft:'auto',justifyContent:'flex-end'}} aria-label="实验操作">
     <button className={primary} onClick={() => setAnalysis({ kind: 'dynamic', ...detail.summary })}>分析问题并优化</button>
     <button className={btn} onClick={regression}>按原条件创建回归</button>
     <button hidden={detailSupplement} className={btn} onClick={() => casesRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>查看 Case（{detail.results.length}）</button>
     <button className={btn} onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify(detail, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = id + '.json'; a.click(); URL.revokeObjectURL(url); }}>导出报告</button>
     {detail.experiment.status === 'draft' && <button className={primary} disabled={busy} onClick={() => action(async () => { await request({ action: 'run', id }); setDetail(await request(undefined, '?experimentId=' + encodeURIComponent(id))); })}>启动实验</button>}
     {['draft', 'running'].includes(detail.experiment.status) && <button className={btn} disabled={busy} onClick={() => action(async () => { await request({ action: 'cancel', id }); })}>终止实验</button>}
   </div></div>
   <p className="text-sm text-foreground-secondary">{detail.manifest.target.name} v{detail.manifest.target.version} × {detail.manifest.dataset.name} v{detail.manifest.dataset.version}{detail.comparison?.dimension==='dataset' && <> / {detail.manifest.groups[1].dataset.name} v{detail.manifest.groups[1].dataset.version}</>}</p>
   {NH_DEMO&&<div className="space-y-1 text-sm text-foreground-secondary"><p>Skill：{detail.manifest.skill?`${detail.manifest.skill.name} v${detail.manifest.skill.version}`:'沿用 Agent 内置'} · 评估器：{detail.manifest.evaluators.map((e:any)=>`${e.name} v${e.version}`).join('、')}</p><p>执行地址：{detail.manifest.execution?.endpoint||detail.manifest.target.content.endpoint||'未记录'} · Agent 模型：{detail.manifest.execution?.model||detail.manifest.target.content.model||'Agent 默认模型'}</p></div>}
   {!NH_DEMO&&<p className="text-sm">Trace 来源：{detail.manifest.traceSource === 'existing' ? '已有 Trace；评估引用原始记录' : '执行 Agent 生成'}</p>}
   {!detail.comparison && <div className={styles.metrics}>{[['通过率', detail.summary.score == null ? '—' : detail.summary.score.toFixed(1) + '%'], ['失败 Case', detail.summary.fail], ['未评完整 Case', detail.summary.incomplete ?? detail.summary.unknown], ['验收', ({ pass: '通过', blocked: '未通过', unknown: '无法判断' } as Record<string, string>)[detail.summary.gate]]].map(([k,v]:any)=><div key={k}><p className="text-xs text-foreground-muted">{k}</p><strong className="text-xl">{v}</strong></div>)}</div>}
   <details><summary className="text-sm text-foreground-secondary">更多指标与测试条件</summary><div className="space-y-3 pt-3 text-sm">
     <div className={styles.metrics}>{[['路由正确率',detail.summary.routing?.accuracy],['所选 Skill 触发准确率',detail.summary.skillTrigger?.accuracy],['工具规则正确率',detail.summary.tools?.accuracy]].map(([label,value]:any)=><div key={label}>{label}：{value == null ? '未取得有效证据' : value.toFixed(1) + '%'}</div>)}<div>单轮平均 / P95：{detail.summary.latency?.meanMs?.toFixed(0) ?? '—'} / {detail.summary.latency?.p95Ms?.toFixed(0) ?? '—'} ms</div></div>
     <p className="text-xs">路由、工具正确率仅统计已观测的检查项；未观测数：{detail.summary.routing?.unknown ?? 0} / {detail.summary.tools?.unknown ?? 0}。所选 Skill 触发检查：{detail.summary.skillTrigger?`应触发/不应触发与实际相符 ${detail.summary.skillTrigger.pass} 项，未标注或未观测 ${detail.summary.skillTrigger.unknown} 项`:'未单独选择 Skill'}。目标执行异常：{detail.summary.executionErrors ?? 0} 个 Case。</p>
     <details><summary>按评估器、类别、难度查看结果</summary>{[['评估器',detail.summary.byEvaluator],['类别',detail.summary.byCategory],['难度',detail.summary.byDifficulty]].map(([title,group]:any)=><div key={title} className="py-3"><h4>{title}</h4>{Object.entries(group||{}).map(([key,v]:any)=><p key={key}>{detail.manifest.evaluators.find((e:any)=>e.id===key)?.name || key}：通过 {v.pass} / {v.total}{v.unknown ? '，无法判断 '+v.unknown : ''}</p>)}</div>)}</details>
     <details><summary>本次测试条件与版本依据</summary><pre className="max-h-96 overflow-auto text-xs">{JSON.stringify(detail.manifest,null,2)}</pre></details>
   </div></details>
 </section>{detail.comparison && <ComparisonResults comparison={detail.comparison} experimentId={id}/>} {!detailSupplement && <section ref={casesRef} aria-label="Case 列表" className="space-y-3 scroll-mt-4">
   <div className={styles.toolbar}><h3 className="font-semibold">Case 列表（{detail.results.length}）</h3><span className="text-xs text-foreground-muted">点击 Case 展开逐轮输入、输出与检查证据</span></div>
   <div className={styles.filters}><input aria-label="搜索 Case" className={field} placeholder="搜索 Case 名称或 ID" value={caseSearch} onChange={e=>setCaseSearch(e.target.value)} /><select aria-label="Case 结果筛选" className={field} value={caseFilter} onChange={e=>setCaseFilter(e.target.value)}><option value="all">全部结果</option><option value="fail">失败</option><option value="unknown">未评完整</option><option value="pass">通过</option></select></div>
   {!detail.results.some((r:CaseResult)=>(caseFilter==='all'||r.verdict===caseFilter)&&(r.case.name+' '+r.case.id).toLowerCase().includes(caseSearch.toLowerCase())) && <p className={card}>没有符合筛选条件的 Case。</p>}
{detail.results.map((r: CaseResult, i: number) => {
        const row = detail.experiment.cases[i];
        if ((caseFilter !== 'all' && r.verdict !== caseFilter) || !(r.case.name+' '+r.case.id).toLowerCase().includes(caseSearch.toLowerCase())) return null;
        return <details className="rounded-lg border border-border bg-card" key={row.id}><summary className={styles.caseSummary}><div className={styles.toolbar}><strong className="text-sm">{r.case.name}</strong><span className={styles.caseStatus+' '+styles[r.verdict]}>{labels[r.verdict]}</span></div><p className="mt-1 text-xs text-foreground-muted">{r.case.turns.length} 轮 · {r.case.id} · {r.checks.filter(c=>c.verdict==='fail').length} 项检查失败</p></summary><div className={styles.caseBody}><p className="text-sm text-foreground-muted">{({positive:'正常',negative:'反例',boundary:'边界'} as Record<string,string>)[r.case.category || 'positive']} / {({easy:'简单',medium:'中等',hard:'困难'} as Record<string,string>)[r.case.difficulty || 'medium']} · {r.case.note}</p>{r.case.turns.map((turn, j) => <div key={j} className="space-y-2 border-t border-border py-3"><strong>第 {j + 1} 轮</strong><p>输入：{turn.input}</p><p>预期：{turn.expectedOutput || '按配置的业务规则判断'}</p><p>实际：{r.evidence[j]?.output || '未取得证据'}</p><pre className="overflow-auto text-xs">{JSON.stringify(r.evidence[j]?.tools || [], null, 2)}</pre>{r.checks.filter(c => c.turn === j + 1).map((c, k) => <p key={k}>{c.skipped ? '已跳过' : labels[c.verdict]} · {c.name}：{c.reason}</p>)}</div>)}{r.checks.filter(c => c.turn === 0).map((c, k) => <p key={k}>{c.skipped ? '已跳过' : labels[c.verdict]} · {c.name}：{c.reason}</p>)}<div className="flex flex-wrap gap-2">{row.executionId && <Link className={btn} href={'/trace?taskId=' + encodeURIComponent(row.executionId)}>查看真实 Trace</Link>}<button className={btn} disabled={busy} onClick={() => action(async () => {
              const created = await request({action:'create',config:caseRerunConfig(detail,row.id,id)});
              setId(created.id);
              await request({
                action: 'run',
                id: created.id
              });
              router.push('/experiments/' + created.id);
            })}>重新执行此 Case</button><button className={btn} onClick={() => setEditor({
              kind: 'case',
              title: '修改 Case 并另存评测集版本',
              caseId: row.id,
              data: JSON.stringify(r.case, null, 2)
            })}>修改 Case / 加入回归版本</button></div><p className="text-xs">运行尝试：{row.traceAttempts?.length || 0} 次，历史测试条件保留。</p></div></details>;
      })}</section>}</>}
 {!id && displayMode === 'datasets' && <>
 {!datasetToolsOnly && <> <div className={styles.toolbar}><p className="text-sm text-foreground-muted">共 {list('dataset').length} 个评测集版本。查看每轮输入和业务规则，修改后另存新版本。</p><button className={primary} onClick={() => editAsset('dataset')}>创建评测集</button></div>
 <label className="flex gap-2 text-sm"><input type="checkbox" checked={showArchived} onChange={e=>setShowArchived(e.target.checked)} />显示已删除评测集</label>
 <section aria-label="评测集版本列表" className="space-y-3">{list('dataset').map(d => <div className={card} key={d.id}><h3 className="font-semibold">{d.name} v{d.version}</h3><p className="text-sm text-foreground-muted">{d.content.cases.length} 个 Case · {d.content.cases.reduce((n:number,c:EvalCase)=>n+c.turns.length,0)} 轮输入 · {d.archived ? '已删除' : '可用于实验'}</p><div className={styles.actions}><Link className={primary} href={'/dataset/versioned-'+d.id}>{d.archived ? '查看 Case' : '查看 Case / 另存版本'}</Link><button className={btn} disabled={d.archived} onClick={()=>{ setDataset(d.id); setCreating(true); setStep(1); }}>使用此版本新建实验</button></div><details><summary className="text-sm text-foreground-muted">导出、复制与删除</summary><div className={styles.actions+" pt-3"}>{!isBuiltinReliabilityDataset(d) && <button className={btn} disabled={busy} onClick={() => action(async () => {
            if (!user) return;
            if (d.archived) await request({action:'archive',id:d.id,archived:false});
            else {
              if (!globalThis.confirm(`确定删除评测集「${d.name}」？该评测集的所有版本将从列表和新建实验中移除，历史实验记录保留。`)) return;
              const response=await apiFetch(`/api/agent-datasets/versioned-${encodeURIComponent(d.id)}?user=${encodeURIComponent(user)}`,{method:'DELETE'});
              const result=await response.json();
              if (!response.ok) throw new Error(result.error || '删除失败');
            }
            await refresh();
          })}>{d.archived ? '恢复评测集' : '删除评测集'}</button>}<button className={btn} onClick={() => {
            const url = URL.createObjectURL(new Blob([JSON.stringify(d.content, null, 2)], {
              type: 'application/json'
            }));
            const a = document.createElement('a');
            a.href = url;
            a.download = d.name + '-v' + d.version + '.json';
            a.click();
            URL.revokeObjectURL(url);
          }}>导出 JSON</button><button className={btn} onClick={() => setEditor({
            kind: 'dataset',
            title: d.name + ' · 副本',
            data: JSON.stringify(d.content, null, 2)
          })}>复制</button><button className={btn} onClick={() => action(async () => {
            const XLSX = await import('xlsx'),
              book = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(d.content.cases.map((c: EvalCase) => ({
              ...c,
              tags: JSON.stringify(c.tags),
              turns: JSON.stringify(c.turns)
            }))), 'Cases');
            XLSX.writeFile(book, d.name + '-v' + d.version + '.xlsx');
          })}>导出 Excel</button></div></details></div>)}{!loaded && <p role="status">正在加载评测集…</p>}{loaded && !list('dataset').length && <p className={card}>暂无多轮评测集。可以创建、导入，或初始化 Demo 目录。</p>}</section>
</>}
 <details className={card} open={datasetToolsOnly||undefined}><summary>生成或导入评测集</summary><div className="space-y-3 pt-3"><p className="text-sm text-foreground-muted">生成 Case 需要可用的真实模型配置，生成后先审阅再保存。</p><label className="block">用于生成的 Agent<select aria-label="用于生成的 Agent" className={field} value={targetId} onChange={e=>setTarget(e.target.value)}>{assetOptions('target')}</select></label><label className="block">生成模型<select className={field} aria-label="生成模型凭证" value={credentialId} onChange={e=>setCredential(e.target.value)}><option value="">当前模型配置</option>{credentials.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><button className={btn} disabled={busy || !target} onClick={()=>action(async()=>{ const generated=await request({action:'generate',targetId,credentialId:credentialId||undefined}); setEditor({kind:'dataset',title:'生成结果 · 审阅后保存',data:JSON.stringify(generated,null,2)}); })}>根据 Agent 定义生成 Case</button>{!NH_DEMO&&<label className="block">从现有评测集建立版本<select className={field} defaultValue="" onChange={e => {
          const d = legacyDatasets.find(x => x.id === e.target.value);
          if (d) void action(async () => {
            const content = await request({
              action: 'import-dataset',
              id: d.id
            });
            setEditor({
              kind: 'dataset',
              title: d.name,
              data: JSON.stringify(content, null, 2)
            });
          });
        }}><option value="">选择已有评测集</option>{legacyDatasets.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}<input type="file" aria-label="导入评测集 JSON 或 Excel" accept=".json,.xlsx" onChange={e => {
        const file = e.target.files?.[0];
        if (!file) return;
        void action(async () => {
          if (file.size > 5000000) throw new Error('文件不能超过 5 MB');
          let content;
          if (file.name.endsWith('.json')) content = JSON.parse(await file.text());else {
            const XLSX = await import('xlsx'),
              book = XLSX.read(await file.arrayBuffer(), {
                type: 'array'
              }),
              rows = XLSX.utils.sheet_to_json<any>(book.Sheets[book.SheetNames[0]]);
            content = {
              cases: rows.map(r => ({
                ...r,
                tags: JSON.parse(r.tags || '[]'),
                turns: JSON.parse(r.turns || '[]')
              }))
            };
          }
          setEditor({
            kind: 'dataset',
            title: file.name.replace(/\.[^.]+$/, ''),
            data: JSON.stringify(content, null, 2)
          });
        });
      }} /></div></details></>}
 {!id && displayMode === 'evaluators' && <section className={card}><p>规则评估器读取 Case 的逐轮条件；LLM 评估器使用下列固定版本提示词和凭证引用。已有评估器目录仍保留。</p>{list('evaluator').map(e => <div className="flex justify-between gap-2" key={e.id}><span>{e.name} v{e.version} · {e.content.type}</span><button className={btn} onClick={() => editAsset('evaluator', e)}>查看 / 新版本</button></div>)}<button className={btn} onClick={() => editAsset('evaluator')}>新增评估器</button><details><summary>添加加密私有模型凭证</summary><form className="space-y-3 pt-3" onSubmit={e => {
          e.preventDefault();
          const form = e.currentTarget,
            data = new FormData(form);
          void action(async () => {
            await request({
              action: 'credential',
              name: data.get('name'),
              config: {
                apiKey: data.get('key'),
                baseUrl: data.get('url'),
                model: data.get('model')
              }
            });
            form.reset();
            await refresh();
          });
        }}><input className={field} name="name" placeholder="凭证名称" required /><input className={field} name="url" type="url" placeholder="OpenAI 兼容 Base URL" required /><input className={field} name="model" placeholder="模型 ID" required /><input className={field} name="key" type="password" placeholder="API Key" autoComplete="off" required /><button className={btn} disabled={busy}>加密保存</button></form></details>{credentials.map(c => <p key={c.id}>{c.name} · 引用：{c.id}（在评估器 credentialId 中选择）</p>)}</section>}
 {!id && displayMode === 'versions' && <VersionExperiments runs={runs} assets={assets} loaded={loaded} />}
 {analysis && <section ref={analysisRef} className={card} aria-label="分析与优化"><div className="flex justify-between"><h3>{analysis.kind === 'static' ? 'Skill 静态风险' : '实验问题与优化依据'}</h3><button className={btn} onClick={() => setAnalysis(null)}>关闭</button></div>{analysis.kind === 'static' ? <><p>{analysis.note}</p>{analysis.findings.map((f: any, i: number) => <p key={i}>{f.type} · {f.skills.join('、')}：{f.reason}</p>)}</> : <><h4>按失败检查类型分组</h4>{!Object.keys(analysis.clusters || {}).length && <p>本次没有发现失败检查项。可以查看路由证据或继续增加边界 Case。</p>}{Object.entries(analysis.clusters || {}).map(([k, v]: any) => <div key={k} className="rounded border border-border p-3 my-2"><strong>{k} · {v.caseIds.length} 个 Case</strong><p>证据：{v.reason}</p><p>建议：{advice(k)}</p><div className="mt-2 flex flex-wrap gap-2">{detail.experiment.cases.filter((row:any)=>v.caseIds.includes(JSON.parse(row.caseValuesJson).id)).slice(0,3).map((row:any)=><Link key={row.id} className={btn} href={'/experiments/'+id+'/cases/'+row.id}>查看代表 Case：{JSON.parse(row.caseValuesJson).name}</Link>)}</div></div>)}<h4>观测路由混淆矩阵（预期 → 实际）</h4><div className="overflow-auto"><table className="w-full text-left text-sm"><thead><tr><th>预期 Skill / 实际 Skill</th>{[...new Set(Object.values(analysis.matrix).flatMap((row:any)=>Object.keys(row)))].map((key:any)=><th key={key}>{key}</th>)}</tr></thead><tbody>{Object.entries(analysis.matrix).map(([expected,row]:any)=><tr key={expected} className="border-t border-border"><th className="py-2">{expected}</th>{[...new Set(Object.values(analysis.matrix).flatMap((r:any)=>Object.keys(r)))].map((actual:any)=><td key={actual}>{row[actual]||0}</td>)}</tr>)}</tbody></table></div><p>优先检查失败轮次对应的工具、参数与路由配置；这里提供基于证据的排查方向，不自动修改外部 Agent。</p><button className={primary} onClick={() => {
          setAnalysis(null);
          regression();
        }}>修改外部 Agent 后创建回归</button></>}</section>}
 {editor && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"><section role="dialog" aria-label={editor.title} className="max-h-[90vh] w-full max-w-3xl space-y-4 overflow-auto rounded-lg bg-background p-5"><h3>{editor.title}</h3><p className="text-sm">保存会创建新版本，不覆盖历史实验。</p><input className={field} aria-label="名称" value={editor.title} onChange={e => setEditor({
          ...editor,
          title: e.target.value
        })} />{['dataset', 'case'].includes(editor.kind) && <button className={btn} disabled={!editorValid} onClick={() => {
          if (formMode) {
            setFormMode(false);
            setEditorValid(true);
          } else {
            try {
              const parsed = JSON.parse(editor.data);
              const cases = editor.kind === 'case' ? [parsed] : parsed.cases;
              if (!Array.isArray(cases) || cases.some((c: any) => !Array.isArray(c.turns))) throw new Error();
              setFormMode(true);
              setEditorValid(true);
            } catch {
              setError('请先修正 JSON：需要 cases 数组，每个 Case 包含 turns 数组');
            }
          }
        }}>切换到{formMode ? 'JSON' : '逐轮表单'}编辑</button>}{['dataset', 'case'].includes(editor.kind) && formMode ? <CaseEditor singleCase={editor.kind === 'case'} key={editor.asset?.id || editor.caseId || 'new'} cases={editor.kind === 'case' ? [JSON.parse(editor.data)] : JSON.parse(editor.data).cases} onChange={cases => setEditor({
          ...editor,
          data: JSON.stringify(editor.kind === 'case' ? cases[0] : {
            cases
          }, null, 2)
        })} onValid={setEditorValid} /> : <textarea className={field + ' min-h-80 font-mono text-xs'} aria-label="版本内容" value={editor.data} onChange={e => setEditor({
          ...editor,
          data: e.target.value
        })} />}{error && <p role="alert">{error}</p>}<div className="flex gap-2"><button className={btn} onClick={() => setEditor(null)}>取消</button><button className={primary} disabled={busy || !editorValid} onClick={() => action(saveEditor)}>保存新版本</button></div></section></div>}
 </div>;
}
