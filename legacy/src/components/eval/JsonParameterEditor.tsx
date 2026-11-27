/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use client'

import { useId, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Download, Plus, Trash2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatParameterJson } from '../../../packages/agent-runtime/index.cjs'
import {
  changeParameterType, diffParameterObjects, isParameterNumber, moveParameterNode, newParameterNode, parameterNodesFromObject,
  parameterEditorTypes, parameterPointer, readParameterDraft, removeParameterNode, serializeParameterNodes, updateParameterNode,
  type JsonEditorNode, type JsonEditorType,
} from '@/lib/client/json-parameter-editor'

const selectClass = 'h-9 w-full rounded-md border border-card-border bg-background px-2 text-sm text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20'
const textareaClass = 'w-full resize-y rounded-md border border-card-border bg-background p-3 font-mono text-sm text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20'
const typeLabels = { string: 'String', number: 'Number', boolean: 'Boolean', object: 'Object', array: 'Array', null: 'Null' }

function readTree(raw: string) {
  const { value } = readParameterDraft(raw)
  return { raw, nodes: value ? parameterNodesFromObject(value) : [], editable: !!value }
}

function displayValue(value: unknown): string {
  return value === undefined ? '（不存在）' : JSON.stringify(value)
}

export function JsonParameterEditor({ value, error, onChange }: {
  value: string
  error: string | null
  onChange: (value: string) => void
}) {
  const editorId = useId()
  const [tree, setTree] = useState(() => readTree(value))
  const [mode, setMode] = useState<'tree' | 'json'>(() => readParameterDraft(value).value ? 'tree' : 'json')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [fileError, setFileError] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const draft = useMemo(() => readParameterDraft(value), [value])
  const imported = useMemo(() => readParameterDraft(importText), [importText])
  const differences = useMemo(() => draft.value && imported.value ? diffParameterObjects(draft.value, imported.value) : [], [draft.value, imported.value])
  const problem = error || draft.error

  if (tree.raw !== value) setTree(readTree(value))

  function publish(nodes: JsonEditorNode[]) {
    const raw = serializeParameterNodes(nodes)
    setTree({ raw, nodes, editable: true })
    onChange(raw)
  }

  function changeNode(id: string, update: (node: JsonEditorNode) => JsonEditorNode) {
    publish(updateParameterNode(tree.nodes, id, update))
  }

  function addChild(node: JsonEditorNode) {
    changeNode(node.id, current => ({ ...current, children: [...current.children, newParameterNode('string', current.type === 'object' ? unusedKey(current.children) : '')] }))
    setCollapsed(current => { const next = new Set(current); next.delete(node.id); return next })
  }

  function exportJson() {
    if (!draft.value || problem) return
    const url = URL.createObjectURL(new Blob([formatParameterJson(draft.value)], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'agent-parameters.json'
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  function renderNodes(nodes: JsonEditorNode[], parentType: 'object' | 'array', parentPath: string, depth: number) {
    return <ul className="m-0 list-none p-0">
      {nodes.map((node, index) => {
        const path = parameterPointer(parentPath, parentType === 'array' ? String(index) : node.key)
        const container = node.type === 'object' || node.type === 'array'
        const open = !collapsed.has(node.id)
        return <li key={node.id}>
          <div className="grid items-center gap-3 border-b border-card-border px-3 py-2" style={{ gridTemplateColumns: `minmax(${200 + depth * 16}px, 1.2fr) 112px minmax(180px, 1.4fr) 208px`, minWidth: 760 + depth * 16 }}>
            <div className="flex min-w-0 items-center gap-1" style={{ paddingLeft: depth * 16 }}>
              {container ? <Button type="button" variant="ghost" size="sm" className="h-8 w-7 shrink-0 px-0"
                aria-label={`${open ? '折叠' : '展开'} ${path}`} aria-expanded={open}
                onClick={() => setCollapsed(current => { const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next })}>
                {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
              </Button> : <span className="w-7 shrink-0" />}
              {parentType === 'object' ? <Input value={node.key} aria-label={`参数名 ${path}`} placeholder="输入字段名" className="font-mono"
                onChange={event => changeNode(node.id, current => ({ ...current, key: event.target.value }))} />
                : <span className="font-mono text-sm text-foreground-secondary">[{index}]</span>}
            </div>
            <select className={selectClass} aria-label={`参数类型 ${path}`} value={node.type}
              onChange={event => changeNode(node.id, current => changeParameterType(current, event.target.value as JsonEditorType))}>
              {parameterEditorTypes.map(type => <option value={type} key={type}>{typeLabels[type]}</option>)}
            </select>
            {container ? <span className="text-xs text-foreground-muted">{node.children.length} 个{node.type === 'object' ? '字段' : '元素'}</span>
              : node.type === 'null' ? <span className="font-mono text-sm text-foreground-muted">null</span>
                : node.type === 'boolean' ? <select className={selectClass} aria-label={`参数值 ${path}`} value={node.text}
                  onChange={event => changeNode(node.id, current => ({ ...current, text: event.target.value }))}>
                  <option value="true">true · 开启</option><option value="false">false · 关闭</option>
                </select> : node.type === 'string' ? <textarea className={`${textareaClass} min-h-9 py-2`} rows={1} value={node.text}
                  aria-label={`参数值 ${path}`} placeholder="输入字符串"
                  onChange={event => changeNode(node.id, current => ({ ...current, text: event.target.value }))} />
                  : <Input type="text" inputMode="decimal" value={node.text} aria-invalid={!isParameterNumber(node.text)}
                    className="font-mono" aria-label={`参数值 ${path}`} placeholder="输入数字"
                    onChange={event => changeNode(node.id, current => ({ ...current, text: event.target.value }))} />}
            <div className="flex items-center justify-end gap-1">
              {container && <Button type="button" variant="ghost" size="sm" onClick={() => addChild(node)} aria-label={`${node.type === 'object' ? '添加子字段' : '添加元素'} ${path}`}>
                <Plus className="size-3" />{node.type === 'object' ? '添加子字段' : '添加元素'}
              </Button>}
              {parentType === 'array' && <>
                <Button type="button" variant="ghost" size="sm" className="h-8 w-7 px-0" title="上移" aria-label={`上移 ${path}`} disabled={index === 0}
                  onClick={() => publish(moveParameterNode(tree.nodes, node.id, -1))}><ArrowUp className="size-3" /></Button>
                <Button type="button" variant="ghost" size="sm" className="h-8 w-7 px-0" title="下移" aria-label={`下移 ${path}`} disabled={index === nodes.length - 1}
                  onClick={() => publish(moveParameterNode(tree.nodes, node.id, 1))}><ArrowDown className="size-3" /></Button>
              </>}
              <Button type="button" variant="ghost" size="sm" className="h-8 w-7 px-0 text-foreground-muted hover:text-error" title="删除" aria-label={`删除 ${path}`}
                onClick={() => publish(removeParameterNode(tree.nodes, node.id))}><Trash2 className="size-3" /></Button>
            </div>
          </div>
          {container && open && renderNodes(node.children, node.type as 'object' | 'array', path, depth + 1)}
        </li>
      })}
    </ul>
  }

  return <div className="overflow-hidden rounded-lg border border-card-border bg-card">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-card-border bg-background-secondary p-2">
      <div className="flex gap-1" role="group" aria-label="参数编辑模式">
        <Button type="button" size="sm" variant={mode === 'tree' ? 'secondary' : 'ghost'} aria-pressed={mode === 'tree'}
          disabled={!tree.editable && !draft.value} onClick={() => setMode('tree')}>树形编辑</Button>
        <Button type="button" size="sm" variant={mode === 'json' ? 'secondary' : 'ghost'} aria-pressed={mode === 'json'}
          onClick={() => setMode('json')}>JSON 编辑</Button>
      </div>
      <div className="flex gap-1">
        <Button type="button" size="sm" variant="outline" onClick={() => { setImportText(''); setFileError(null); setImportOpen(true) }}><Upload />导入 JSON</Button>
        <Button type="button" size="sm" variant="ghost" disabled={!!problem || !draft.value} onClick={exportJson}><Download />导出</Button>
      </div>
    </div>
    {mode === 'tree' ? tree.editable ? <>
      <p className="px-3 pt-2 text-xs text-foreground-muted">需要子字段时，将类型设为 Object；Array 可添加元素。配置结构需与执行端一致。</p>
      <p className="px-3 pt-2 text-xs text-foreground-muted md:hidden">左右滑动查看参数类型、值和操作。</p>
      <div className="max-h-[520px] overflow-auto">
        <div className="grid min-w-[760px] gap-3 border-b border-card-border px-3 py-2 text-xs font-medium text-foreground-muted" style={{ gridTemplateColumns: 'minmax(200px, 1.2fr) 112px minmax(180px, 1.4fr) 208px' }}>
          <span className="pl-8">参数 Key</span><span>类型</span><span>Value</span><span className="text-right">操作</span>
        </div>
        {renderNodes(tree.nodes, 'object', '', 0)}
        {!tree.nodes.length && <p className="p-4 text-sm text-foreground-muted">暂无参数，添加字段或导入 JSON 开始配置。</p>}
      </div>
      <div className="flex flex-wrap gap-1 p-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => publish([...tree.nodes, newParameterNode('string', unusedKey(tree.nodes))])}><Plus />添加字段</Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => publish([...tree.nodes, newParameterNode('object', unusedKey(tree.nodes))])}><Plus />添加对象</Button>
      </div>
    </> : <p className="p-4 text-sm text-foreground-muted">请在 JSON 编辑中按执行端要求修正配置后切换参数编辑。</p> : <div className="grid gap-2 p-3">
      <label htmlFor={`${editorId}-json`} className="sr-only">运行参数 JSON</label>
      <textarea id={`${editorId}-json`} className={textareaClass} rows={16} spellCheck={false} value={value} aria-invalid={!!problem}
        onChange={event => onChange(event.target.value)} />
      <div className="flex justify-end"><Button type="button" variant="ghost" size="sm" disabled={!draft.value}
        onClick={() => draft.value && onChange(formatParameterJson(draft.value))}>格式化</Button></div>
    </div>}
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-card-border px-3 py-2">
      {problem ? <p className="min-w-0 flex-1 break-words text-sm text-error" role="alert">{problem}</p>
        : <p className="text-xs text-foreground-muted" role="status">✓ JSON 格式正确 · 本次配置将完整保存并原样下发</p>}
      <Button type="button" variant="ghost" size="sm" disabled={!!problem || !draft.value} onClick={() => setPreviewOpen(true)}>查看最终配置</Button>
    </div>

    <Dialog open={importOpen} onOpenChange={setImportOpen}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader><DialogTitle>导入运行参数</DialogTitle><DialogDescription>粘贴 JSON 或上传 .json 文件。应用后将整体替换本次实验参数。</DialogDescription></DialogHeader>
        <div className="grid gap-2">
          <label htmlFor={`${editorId}-file`} className="text-sm font-medium">上传 JSON 文件</label>
          <Input id={`${editorId}-file`} type="file" accept=".json,application/json" onChange={async event => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (!file) return
            setFileError(null)
            try {
              if (file.size > 256 * 1024) throw new Error('JSON 文件不能超过 256 KiB')
              setImportText(await file.text())
            } catch (error) { setFileError(error instanceof Error ? error.message : '文件读取失败') }
          }} />
          <label htmlFor={`${editorId}-import`} className="mt-2 text-sm font-medium">粘贴或编辑 JSON</label>
          <textarea id={`${editorId}-import`} className={textareaClass} rows={9} value={importText} spellCheck={false} placeholder={'{\n  "参数原名": "参数值"\n}'}
            aria-invalid={!!importText && !!imported.error} onChange={event => { setImportText(event.target.value); setFileError(null) }} />
          {(fileError || (importText && imported.error)) && <p className="text-sm text-error" role="alert">{fileError || imported.error}</p>}
        </div>
        {imported.value && !imported.error && !fileError && <div className="grid gap-2">
          <p className="text-sm font-medium">变更预览{draft.value ? `（${differences.length} 项）` : ''}</p>
          {!draft.value ? <p className="text-sm text-foreground-muted">当前草稿格式不正确，导入将使用上面的完整 JSON 替换草稿。</p>
            : !differences.length ? <p className="text-sm text-foreground-muted">导入配置与当前配置相同。</p> : <div className="max-h-56 overflow-auto rounded-md border border-card-border">
              <table className="w-full text-left text-xs"><thead className="bg-background-secondary text-foreground-muted"><tr><th className="p-2 font-medium">参数路径</th><th className="p-2 font-medium">当前值</th><th className="p-2 font-medium">导入后</th></tr></thead>
                <tbody>{differences.slice(0, 200).map(change => <tr key={change.path} className="border-t border-card-border">
                  <td className="p-2 font-mono">{change.path}</td>
                  <td className="max-w-56 truncate p-2 font-mono" title={displayValue(change.before)}>{displayValue(change.before)}</td>
                  <td className="max-w-56 truncate p-2 font-mono" title={displayValue(change.after)}>{change.after === undefined ? '删除' : displayValue(change.after)}</td>
                </tr>)}</tbody></table>
            </div>}
          {differences.length > 200 && <p className="text-xs text-foreground-muted">预览前 200 项变更，应用时会替换完整配置。</p>}
        </div>}
        <DialogFooter><Button type="button" variant="outline" onClick={() => setImportOpen(false)}>取消</Button>
          <Button type="button" disabled={!imported.value || !!imported.error || !!fileError} onClick={() => {
            if (!imported.value || imported.error || fileError) return
            onChange(formatParameterJson(imported.value))
            setImportOpen(false)
          }}>应用导入配置</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
      <DialogContent className="max-w-3xl"><DialogHeader><DialogTitle>最终运行参数</DialogTitle><DialogDescription>以下完整 JSON 将作为本次实验的运行参数保存并下发。</DialogDescription></DialogHeader>
        <pre className="max-h-[60vh] overflow-auto whitespace-pre rounded-md border border-card-border bg-background-secondary p-3 font-mono text-sm">{draft.value ? JSON.stringify(draft.value, null, 2) : value}</pre>
        <DialogFooter><Button type="button" variant="outline" onClick={() => setPreviewOpen(false)}>关闭</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}

function unusedKey(nodes: JsonEditorNode[]): string {
  const keys = new Set(nodes.map(node => node.key))
  if (!keys.has('new_key')) return 'new_key'
  let index = 2
  while (keys.has(`new_key_${index}`)) index++
  return `new_key_${index}`
}
