'use client';

import {RequiredToolsEditor, OutputFieldsEditor} from './StructuredRules';
import { useEffect, useState } from 'react';
import type { EvalCase } from '@/lib/evaluation-harness/domain';
const field = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm';
const button = 'ai-btn-s';
function JsonField({
  label,
  value,
  onChange,
  onValid
}: {
  label: string;
  value: unknown;
  onChange: (v: any) => void;
  onValid: (v: boolean) => void;
}) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [error, setError] = useState('');
  const serialized = JSON.stringify(value, null, 2);
  useEffect(() => {
    setText(serialized);
    setError('');
  }, [serialized]);
  return <label className="block">{label}<textarea aria-label={label} className={field + ' min-h-24 font-mono'} value={text} onChange={e => {
      setText(e.target.value);
      try {
        const parsed = JSON.parse(e.target.value);
        if (!Array.isArray(parsed)) throw new Error('需要 JSON 数组');
        onChange(parsed);
        setError('');
        onValid(true);
      } catch {
        setError('请输入有效的 JSON 数组，修正后才能保存');
        onValid(false);
      }
    }} />{error && <span role="alert" className="text-error text-xs">{error}</span>}</label>;
}
export default function CaseEditor({
  cases,
  onChange,
  onValid,
  singleCase = false
}: {
  singleCase?: boolean;
  cases: EvalCase[];
  onChange: (v: EvalCase[]) => void;
  onValid: (v: boolean) => void;
}) {
  const [revision, setRevision] = useState(0);
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  function valid(key: string, ok: boolean) {
    const next = {
      ...invalid,
      [key]: !ok
    };
    setInvalid(next);
    onValid(!Object.values(next).some(Boolean));
  }
  function update(index: number, patch: Partial<EvalCase>) {
    onChange(cases.map((c, i) => i === index ? {
      ...c,
      ...patch
    } : c));
  }
  return <div className="space-y-4">{cases.map((c, index) => <details key={index} open className="rounded border border-border p-4 space-y-3"><summary>Case {index + 1} · {c.name}</summary>
    <div className="grid gap-3 md:grid-cols-2"><label>Case ID<input aria-label={`Case ${index + 1} ID`} className={field} value={c.id} readOnly={singleCase} onChange={e => update(index, {
            id: e.target.value
          })} /></label><label>名称<input aria-label={`Case ${index + 1} 名称`} className={field} value={c.name} onChange={e => update(index, {
            name: e.target.value
          })} /></label>
    <label>分类<select className={field} value={c.category || 'positive'} onChange={e => update(index, {
            category: e.target.value as EvalCase['category']
          })}><option value="positive">正常</option><option value="negative">反例</option><option value="boundary">边界</option></select></label><label>难度<select className={field} value={c.difficulty || 'medium'} onChange={e => update(index, {
            difficulty: e.target.value as EvalCase['difficulty']
          })}><option value="easy">简单</option><option value="medium">中等</option><option value="hard">困难</option></select></label></div>
    <label className="block">标签（逗号分隔）<input className={field} value={(c.tags || []).join(',')} onChange={e => update(index, {
          tags: e.target.value.split(',').map(x => x.trim()).filter(Boolean)
        })} /></label><label className="block">备注<input className={field} value={c.note || ''} onChange={e => update(index, {
          note: e.target.value
        })} /></label>
    {c.turns.map((t, turnIndex) => {
        const expectation = t.expectation || {};
        const change = (patch: any) => update(index, {
          turns: c.turns.map((v, i) => i === turnIndex ? {
            ...v,
            ...patch
          } : v)
        });
        const rule = (patch: any) => change({
          expectation: {
            ...expectation,
            ...patch
          }
        });
        return <div key={revision + '-' + turnIndex} className="space-y-3 border-t border-border pt-3"><h4>第 {turnIndex + 1} 轮</h4>
      <label className="block">用户输入<textarea aria-label={`Case ${index + 1} 第 ${turnIndex + 1} 轮输入`} className={field} value={t.input} onChange={e => change({
              input: e.target.value
            })} /></label><label className="block">预期输出（语义评估依据）<textarea className={field} value={t.expectedOutput || ''} onChange={e => change({
              expectedOutput: e.target.value
            })} /></label>
      <div className="grid gap-3 md:grid-cols-2">{[['contains', '输出必须包含'], ['pattern', '输出正则'], ['expectedSkill', '预期 Skill'], ['state', '预期结束状态']].map(([key, label]) => <label key={key}>{label}<input className={field} value={(expectation as any)[key] || ''} onChange={e => rule({
                [key]: e.target.value || undefined
              })} /></label>)}</div>
      <RequiredToolsEditor value={expectation.requiredTools || []} onChange={v=>rule({requiredTools:v})} onValid={ok=>valid(`${index}-${turnIndex}-tools`,ok)}/>
      <label className="block">禁止调用（逗号分隔）<input className={field} value={(expectation.forbiddenTools || []).join(',')} onChange={e => rule({
              forbiddenTools: e.target.value.split(',').map(x => x.trim()).filter(Boolean)
            })} /></label><label className="block">调用顺序（逗号分隔）<input className={field} value={(expectation.toolOrder || []).join(',')} onChange={e => rule({
              toolOrder: e.target.value.split(',').map(x => x.trim()).filter(Boolean)
            })} /></label>
      <OutputFieldsEditor value={expectation.fields||[]} onChange={v=>rule({fields:v})} onValid={ok=>valid(`${index}-${turnIndex}-fields`,ok)}/>
      <label className="flex gap-2"><input type="checkbox" checked={expectation.blocking !== false} onChange={e => rule({
              blocking: e.target.checked
            })} />本轮规则失败即阻止验收通过</label>
      {c.turns.length > 1 && <button className={button} onClick={() => {
            update(index, {
              turns: c.turns.filter((_, i) => i !== turnIndex)
            });
            setInvalid({});
            setRevision(v => v + 1);
            onValid(true);
          }}>移除此轮</button>}
    </div>;
      })}<button className={button} disabled={c.turns.length >= 20} onClick={() => update(index, {
        turns: [...c.turns, {
          input: '',
          expectedOutput: '',
          expectation: {
            requiredTools: [],
            forbiddenTools: [],
            toolOrder: [],
            fields: [],
            blocking: true
          }
        }]
      })}>添加一轮</button>
  {!singleCase && cases.length > 1 && <button className={button} onClick={() => {
        onChange(cases.filter((_, i) => i !== index));
        setInvalid({});
        setRevision(v => v + 1);
        onValid(true);
      }}>移除 Case</button>}</details>)}{!singleCase && <button className={button} onClick={() => onChange([...cases, {
      id: 'case-' + Date.now(),
      name: '新增 Case',
      category: 'positive',
      difficulty: 'medium',
      tags: [],
      note: '',
      turns: [{
        input: '',
        expectedOutput: '',
        expectation: {
          requiredTools: [],
          forbiddenTools: [],
          toolOrder: [],
          fields: [],
          blocking: true
        }
      }]
    }])}>添加 Case</button>}</div>;
}
