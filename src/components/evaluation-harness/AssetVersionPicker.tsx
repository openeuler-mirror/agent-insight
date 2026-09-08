'use client';
import type {CatalogAsset} from './useEvaluationCatalog';
import styles from './Workspace.module.css';
export type AssetDimension='agent'|'skill'|'evaluator'|'dataset';
export const dimensionLabels:Record<AssetDimension,string>={agent:'Agent',skill:'Skill',evaluator:'评估器',dataset:'评测集'};
export const demoField='w-full min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm';
export function assetsFor(assets:CatalogAsset[],kind:AssetDimension){return assets.filter(a=>kind==='agent'||kind==='skill'?a.kind==='target'&&a.content.type===kind:a.kind===kind).sort((a,b)=>b.version-a.version);}
export default function AssetVersionPicker({assets,kind,value,onChange,prefix='',optional=false,disabled=false,assetKey}:{assets:CatalogAsset[];kind:AssetDimension;value:string;onChange:(id:string)=>void;prefix?:string;optional?:boolean;disabled?:boolean;assetKey?:string}){
 const versions=assetsFor(assets,kind).filter(a=>(!a.archived||a.id===value)&&(!assetKey||a.assetKey===assetKey));
 const selected=versions.find(a=>a.id===value),objects=versions.filter((a,i,all)=>all.findIndex(b=>b.assetKey===a.assetKey)===i),label=prefix+dimensionLabels[kind];
 return <div className={styles.assetPicker}><label>{dimensionLabels[kind]}<select aria-label={label} className={demoField} disabled={disabled} value={selected?.assetKey||''} onChange={e=>onChange(versions.find(a=>a.assetKey===e.target.value&&!a.archived)?.id||'')}><option value="">{optional?'不额外加载 Skill':'请选择'+dimensionLabels[kind]}</option>{objects.map(a=><option key={a.assetKey} value={a.assetKey} disabled={a.archived}>{a.name}{a.archived?(kind==='agent'||kind==='skill'?'（执行端已不再提供）':'（已删除）'):''}</option>)}</select></label><label>版本<select aria-label={label+'版本'} className={demoField} disabled={disabled||!selected} value={value} onChange={e=>onChange(e.target.value)}>{!selected&&<option value="">{optional&&!value?'沿用 Agent 内置':'请选择版本'}</option>}{versions.filter(a=>a.assetKey===selected?.assetKey).map(a=><option key={a.id} value={a.id} disabled={a.archived}>v{a.version}{a.archived?(kind==='agent'||kind==='skill'?'（执行端已不再提供）':'（已删除）'):''}</option>)}</select></label></div>;
}
