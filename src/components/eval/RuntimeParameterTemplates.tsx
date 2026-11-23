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

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { apiFetch } from '@/lib/client/api'
import { normalizeAgentOptions, type AgentOptions, type RuntimeDefinition } from '../../../packages/agent-runtime/index.cjs'
import { readRuntimeParameterTemplates, type RuntimeParameterTemplate } from '@/lib/engine/experiment/runtime-parameter-templates'

export function RuntimeParameterTemplates({ user, definition, options, error, onApply }: {
  user: string | null
  definition: RuntimeDefinition
  options?: AgentOptions
  error: string | null
  onApply: (options: AgentOptions) => void
}) {
  const [templates, setTemplates] = useState<RuntimeParameterTemplate[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  useEffect(() => {
    if (!user) return
    const controller = new AbortController()
    apiFetch(`/api/eval/settings?section=runtime-parameters&user=${encodeURIComponent(user)}`, { signal: controller.signal })
      .then(async response => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || '读取参数模板失败')
        if (!controller.signal.aborted) {
          setTemplates(readRuntimeParameterTemplates(result.templates))
          setLoadError('')
          setLoading(false)
        }
      }).catch(cause => {
        if (!controller.signal.aborted) {
          setLoadError(cause instanceof Error ? cause.message : '读取参数模板失败')
          setLoading(false)
        }
      })
    return () => controller.abort()
  }, [user])

  const available = templates.filter(template => template.runtimeKey === definition.runtimeKey).reverse()
  const selected = available.find(template => template.id === selectedId)
  const modified = selected && JSON.stringify(selected.values) !== JSON.stringify(options?.values)

  async function save() {
    if (!user || !options || error) return
    setSaving(true)
    setSaveError('')
    try {
      const response = await apiFetch('/api/eval/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, action: 'save-runtime-parameter-template', template: {
          name, runtimeKey: definition.runtimeKey, definitionDigest: definition.definitionDigest, values: options.values,
        } }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || '保存参数模板失败')
      const saved = readRuntimeParameterTemplates([result.template])[0]
      if (!saved) throw new Error('保存的模板格式不合法')
      setTemplates(current => [...current, saved])
      setSelectedId(saved.id)
      setOpen(false)
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : '保存参数模板失败')
    } finally { setSaving(false) }
  }

  return <div className="mb-3 grid gap-2">
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label className="flex items-center gap-2">
        参数模板
        <select aria-label="参数模板" value={selected?.id || ''} disabled={!user || loading}
          className="h-9 max-w-72 rounded-md border border-card-border bg-background px-3 text-foreground focus-visible:outline-primary"
          onChange={event => {
            const template = available.find(item => item.id === event.target.value)
            if (!template) { setSelectedId(''); return }
            try {
              const applied = normalizeAgentOptions({ version: 2, runtimeKey: definition.runtimeKey,
                definitionDigest: template.definitionDigest, values: template.values }, definition)
              if (applied) { onApply(applied); setSelectedId(template.id); setLoadError('') }
            } catch (cause) {
              setLoadError(cause instanceof Error ? cause.message : '模板参数不合法')
            }
          }}>
          <option value="">当前配置</option>
          {available.map(template => <option key={template.id} value={template.id}
            disabled={template.definitionDigest !== definition.definitionDigest}>
            {template.name} · v{template.revision}{template.definitionDigest !== definition.definitionDigest ? '（参数契约已变化）' : ''}
          </option>)}
        </select>
      </label>
      {modified && <span className="text-xs text-foreground-muted">已修改当前实验参数</span>}
      <Button type="button" size="sm" variant="outline" disabled={!user || !options || Boolean(error)}
        onClick={() => { setName(selected?.name || `${definition.displayName} 配置`); setSaveError(''); setOpen(true) }}>
        保存为模板
      </Button>
    </div>
    {loadError && <p role="alert" className="text-xs text-error">{loadError}</p>}
    <Dialog open={open} onOpenChange={next => { if (!saving) setOpen(next) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>保存参数模板</DialogTitle>
          <DialogDescription>保存当前完整配置。同名模板会新增一个版本，已创建的实验使用原参数快照。</DialogDescription>
        </DialogHeader>
        <label className="grid gap-2 text-sm">模板名称
          <Input aria-label="模板名称" maxLength={80} value={name} onChange={event => setName(event.target.value)} />
        </label>
        {saveError && <p role="alert" className="text-sm text-error">{saveError}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={() => setOpen(false)}>取消</Button>
          <Button type="button" disabled={saving || !name.trim() || Boolean(error)} onClick={save}>{saving ? '保存中…' : '保存模板'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}
