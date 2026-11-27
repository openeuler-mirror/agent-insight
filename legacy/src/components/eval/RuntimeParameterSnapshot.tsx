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

import type { AgentOptions, RuntimeDefinition } from '../../../packages/agent-runtime/index.cjs'

export function RuntimeParameterSnapshot({ definition, options }: {
  definition?: RuntimeDefinition | null
  options?: AgentOptions | null
}) {
  if (!definition || !options || definition.runtimeKey === 'opencode') return null
  if (options.version === 2) return <details className="mt-3 border-t border-card-border pt-3">
    <summary className="cursor-pointer font-semibold">{definition.displayName} 运行参数 · 查看配置快照</summary>
    <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md border border-card-border bg-background-secondary p-3 font-mono text-xs text-foreground">
      {JSON.stringify(options.values, null, 2)}
    </pre>
  </details>
  const fields = definition.parameters.filter(field => options.values[field.key] !== undefined)
  if (!fields.length) return null
  return <div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-2 border-t border-card-border pt-3">
    <span className="font-semibold">{definition.displayName} 运行参数</span>
    <dl className="flex flex-wrap gap-x-5 gap-y-2">
      {fields.map(field => <div key={field.key} className="flex">
        <dt className="text-foreground-muted">{field.label}：</dt>
        <dd>{String(options.values[field.key])}</dd>
      </div>)}
    </dl>
  </div>
}
