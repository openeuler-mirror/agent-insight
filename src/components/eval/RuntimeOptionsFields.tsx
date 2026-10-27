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

import { useId, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { JsonParameterEditor } from './JsonParameterEditor'
import { formatParameterJson } from '../../../packages/agent-runtime/index.cjs'
import { optionsToInputs, type RuntimeDefinition, type RuntimeOptionInputs } from '@/lib/engine/experiment/runtime-options'

export function RuntimeOptionsFields({ definition, value, error, onChange, templateControls }: {
  definition: RuntimeDefinition
  value: RuntimeOptionInputs
  error: string | null
  onChange: (value: RuntimeOptionInputs) => void
  templateControls?: ReactNode
}) {
  const contentId = useId()
  const [expanded, setExpanded] = useState(true)

  return <section className="mb-4 grid gap-3" aria-label={`${definition.displayName} 运行参数`}>
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="text-sm font-semibold">{definition.displayName} 运行参数</h3>
      <Button type="button" variant="ghost" size="sm" onClick={() => onChange(optionsToInputs(definition))}>恢复默认</Button>
      <Button type="button" variant="ghost" size="sm" className="ml-auto text-foreground-muted"
        aria-label={`${expanded ? '收起' : '展开'} ${definition.displayName} 运行参数`}
        aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(current => !current)}>
        {expanded ? '收起' : '展开'}
        <ChevronDown aria-hidden="true" className={`size-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </Button>
    </div>
    {!expanded && error && <p className="text-sm text-error" role="alert">{error}</p>}
    <div id={contentId} hidden={!expanded} className={expanded ? 'grid gap-3' : undefined}>
      {templateControls}
      {definition.configuration?.version === 2 ? <JsonParameterEditor
        value={value.__json ?? formatParameterJson(definition.configuration.defaults)}
        error={error}
        onChange={raw => onChange({ __json: raw })} /> : <>{definition.parameterGroups.map(group => <div key={group.key} className="grid gap-3">
        <h4 className="text-sm font-semibold">{group.label}</h4>
        {group.description && <p className="text-xs text-foreground-muted">{group.description}</p>}
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          {definition.parameters.filter(field => field.group === group.key).map(field => <label key={field.key} className="grid gap-1 text-xs">
            {field.label}
            {field.type === 'boolean' || field.type === 'enum' ? <select className="h-9 w-full min-w-0 rounded-md border border-card-border bg-background px-3 py-1 text-sm text-foreground shadow-xs outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20" aria-label={field.label}
              value={value[field.key] ?? ''} required={field.required}
              onChange={event => onChange({ ...value, [field.key]: event.target.value })}>
              <option value="">请选择</option>
              {(field.type === 'boolean' ? [true, false] : field.choices || []).map(choice => <option key={String(choice)} value={String(choice)}>{String(choice)}</option>)}
            </select> : <Input className="border-card-border placeholder:text-foreground-muted focus-visible:border-primary focus-visible:ring-primary/20"
              type={field.type === 'string' ? 'text' : 'number'} min={field.minimum} max={field.maximum}
              minLength={field.minLength} maxLength={field.maxLength} step={field.type === 'integer' ? 1 : 'any'}
              required={field.required} aria-label={field.label} value={value[field.key] ?? ''}
              onChange={event => onChange({ ...value, [field.key]: event.target.value })} />}
            {field.description && <span className="text-foreground-muted">{field.description}</span>}
          </label>)}
        </div>
      </div>)}
      {error && <p className="text-sm text-error" role="alert">{error}</p>}</>}
    </div>
  </section>
}
