'use client';
import {Dialog,DialogTrigger,DialogContent,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import type {EvalCase} from '@/lib/evaluation-harness/domain';
const valueText=(value:unknown)=>typeof value==='string'?value:JSON.stringify(value);
export default function CaseRulesDialog({value:c}:{value:EvalCase}) {
  return <Dialog><DialogTrigger asChild><button className="ai-btn-s">逐轮规则 · {c.turns.length} 轮</button></DialogTrigger><DialogContent className="max-w-3xl max-h-[85vh] overflow-auto"><DialogTitle>{c.name} · 逐轮规则</DialogTitle><DialogDescription>只读查看。需要调整时，请到评测数据集中编辑并发布新版本。</DialogDescription>
    {c.turns.map((t,i)=>{const e=t.expectation;return <section key={i} className="rounded-lg border border-border p-4 space-y-3"><h3 className="font-semibold">第 {i+1} 轮{i===0?' · 开始':i===c.turns.length-1?' · 最终回复':''}</h3><div className="grid gap-3 sm:grid-cols-2"><div><p className="text-xs text-foreground-muted">用户输入</p><p className="whitespace-pre-wrap">{t.input}</p></div><div><p className="text-xs text-foreground-muted">预期输出</p><p className="whitespace-pre-wrap">{t.expectedOutput||'未填写，按规则判断'}</p></div></div>
      <dl className="text-sm space-y-2">{[['预期 Skill',e.expectedSkill],['输出必须包含',e.contains],['输出正则',e.pattern],['结束状态',e.state]].map(([label,value])=>value&&<div key={label}><dt className="font-medium">{label}</dt><dd className="break-words">{value}</dd></div>)}
        {!!e.requiredTools?.length&&<div><dt className="font-medium">必须调用的工具</dt><dd>{e.requiredTools.map((tool,j)=><div key={j} className="mt-1 rounded border border-border p-2"><strong>{tool.name}</strong>{Object.entries(tool.arguments||{}).map(([key,value])=><p key={key} className="break-words">{key} = {valueText(value)}</p>)}</div>)}</dd></div>}
        {!!e.forbiddenTools?.length&&<div><dt className="font-medium">禁止调用</dt><dd>{e.forbiddenTools.join('、')}</dd></div>}
        {!!e.toolOrder?.length&&<div><dt className="font-medium">调用顺序</dt><dd>{e.toolOrder.join(' → ')}</dd></div>}
        {!!e.fields?.length&&<div><dt className="font-medium">输出字段约束</dt><dd>{e.fields.map((f,j)=><p key={j} className="break-words">{f.path}：{f.required?'必填':'可选'}{f.type&&` · 类型 ${f.type}`}{f.min!==undefined&&` · 最小值 ${f.min}`}{f.max!==undefined&&` · 最大值 ${f.max}`}{f.equals!==undefined&&` · 等于 ${valueText(f.equals)}`}{f.enum&&` · 允许值 ${f.enum.map(valueText).join('、')}`}</p>)}</dd></div>}
        <div><dt className="font-medium">未满足本轮规则时</dt><dd>{e.blocking!==false?'阻止验收通过':'记录检查结果，不作为阻断条件'}</dd></div>
      </dl></section>;})}
  </DialogContent></Dialog>;
}
