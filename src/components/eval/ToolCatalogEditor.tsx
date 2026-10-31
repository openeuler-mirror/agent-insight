/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { catalogParameterTypes, newCatalogParameter, newCatalogTool, readCatalogForm, serializeCatalogForm, type CatalogTool } from '@/lib/client/tool-catalog-form';

export function ToolCatalogEditor({ value, onChange, onValid }: {
  value: unknown;
  onChange: (value: unknown) => void;
  onValid: (valid: boolean) => void;
}) {
  const [draft, setDraft] = useState(() => readCatalogForm(value));
  const result = useMemo(() => {
    try { return { value: serializeCatalogForm(draft), error: '' }; }
    catch (error) { return { value: undefined, error: error instanceof Error ? error.message : '工具配置无效' }; }
  }, [draft]);
  useEffect(() => { onValid(!result.error); }, [result.error, onValid]);
  useEffect(() => {
    if (!result.error && JSON.stringify(result.value) !== JSON.stringify(value)) onChange(result.value);
  }, [result, value, onChange]);
  const update = (id: string, patch: Partial<CatalogTool>) => setDraft(prev => ({ ...prev, tools: prev.tools.map(tool => tool.id === id ? { ...tool, ...patch } : tool) }));
  return <div role="group" aria-label="可用工具配置" className="grid gap-3 rounded-md border border-border p-3 text-xs">
    <p className="text-foreground-muted">填写本 Case 中 Agent 可使用的工具，供评估器判断工具选择是否合理；这里不会安装工具或改变 Agent 权限。</p>
    {draft.error ? <div>
      <p role="alert" className="text-error">{draft.error}</p>
      <button type="button" className="ai-btn-s mt-2" onClick={() => setDraft({ provided: true, tools: [] })}>重新配置工具目录</button>
    </div> : <>
      <label className="flex items-center gap-2"><input type="checkbox" checked={draft.provided} onChange={event => setDraft({ ...draft, provided: event.target.checked })}/> 提供可用工具信息</label>
      {!draft.provided && <p className="text-foreground-muted">尚未提供工具信息。勾选后不添加工具，表示已确认本 Case 没有可用工具。</p>}
      {draft.provided && draft.tools.map((tool, index) => <section key={tool.id} aria-label={`可用工具 ${index + 1}`} className="grid gap-3 rounded-md border border-border p-3">
        <div className="flex items-center justify-between"><strong>工具 {index + 1}</strong><button type="button" className="ai-btn-s inline-flex items-center gap-1" aria-label={`删除可用工具 ${index + 1}`} onClick={() => setDraft({ ...draft, tools: draft.tools.filter(row => row.id !== tool.id) })}><Trash2 size={12}/>删除工具</button></div>
        <label className="grid gap-1">工具名称<Input aria-label={`可用工具 ${index + 1} 名称`} placeholder="如 read_file、search" value={tool.name} onChange={event => update(tool.id, { name: event.target.value })}/></label>
        <label className="grid gap-1">用途说明（可选）<Textarea aria-label={`可用工具 ${index + 1} 用途`} placeholder="说明什么情况下应使用该工具" value={tool.description} onChange={event => update(tool.id, { description: event.target.value })}/></label>
        {tool.schemaEditable ? <details>
          <summary className="cursor-pointer">参数定义（可选） · {tool.parameters.length} 项</summary>
          <div className="mt-2 grid gap-3">{tool.parameters.map((parameter, at) => {
            const opaque = !parameter.original || typeof parameter.original !== 'object' || Array.isArray(parameter.original);
            const change = (patch: Partial<typeof parameter>) => update(tool.id, { parameters: tool.parameters.map((row, i) => i === at ? { ...row, ...patch } : row) });
            return <div key={parameter.id} aria-label={`工具 ${index + 1} 参数 ${at + 1}`} className="grid gap-2 border-b border-border pb-3">
              <div className="grid grid-cols-2 gap-2">
                <label className="grid gap-1">参数名称<Input aria-label={`工具 ${index + 1} 参数 ${at + 1} 名称`} value={parameter.name} placeholder="如 file_path" onChange={event => change({ name: event.target.value })}/></label>
                <label className="grid gap-1">参数类型<>{opaque ? <Input aria-label={`工具 ${index + 1} 参数 ${at + 1} 类型`} value="保留复杂定义" disabled readOnly/> : <Select aria-label={`工具 ${index + 1} 参数 ${at + 1} 类型`} value={parameter.type} options={[{ value: '', label: '保留原定义' }, ...catalogParameterTypes.map(type => ({ value: type, label: ({ string: '文本', number: '数值', integer: '整数', boolean: '布尔', object: '对象', array: '数组' } as Record<string, string>)[type] }))]} onChange={type => change({ type })}/>}</></label>
              </div>
              <label className="grid gap-1">参数说明<Input aria-label={`工具 ${index + 1} 参数 ${at + 1} 说明`} value={parameter.description} disabled={opaque} onChange={event => change({ description: event.target.value })}/></label>
              {opaque && <p className="text-foreground-muted">已有复杂参数约束会原样保留，可修改名称、必填项或删除。</p>}
              <div className="flex items-center justify-between"><label className="flex items-center gap-2"><input type="checkbox" checked={parameter.required} onChange={event => change({ required: event.target.checked })}/>必填</label><button type="button" className="ai-btn-s" onClick={() => update(tool.id, { parameters: tool.parameters.filter(row => row.id !== parameter.id) })}>删除参数</button></div>
            </div>;
          })}
            <button type="button" className="ai-btn-s inline-flex w-fit items-center gap-1.5" onClick={() => update(tool.id, { parameters: [...tool.parameters, newCatalogParameter()] })}><Plus size={12}/>添加参数定义</button>
          </div>
        </details> : <p className="text-foreground-muted">已有复杂参数定义将原样保留，修改工具名称和说明不会清除它。</p>}
      </section>)}
      <button type="button" className="ai-btn-s inline-flex w-fit items-center gap-1.5" onClick={() => setDraft({ ...draft, provided: true, tools: [...draft.tools, newCatalogTool()] })}><Plus size={12}/>添加可用工具</button>
      {result.error && <p role="alert" className="text-error">{result.error}</p>}
    </>}
  </div>;
}
