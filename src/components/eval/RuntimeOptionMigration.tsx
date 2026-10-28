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

import { Button } from '@/components/ui/button'
import type { OptionMigration } from '../../../packages/agent-runtime/option-migration.cjs'

export function RuntimeOptionMigration({ migration, onConfirm }: { migration: OptionMigration; onConfirm: () => void }) {
  return <div className="mb-3 grid gap-3 rounded-lg border border-card-border bg-background-secondary p-3">
    <div className="grid gap-1">
      <p className="text-sm font-semibold">确认历史参数</p>
      <p className="text-xs text-foreground-muted">客户端参数契约已更新。以下字段名、层级和值将原样用于新实验，原实验快照不变。</p>
    </div>
    <pre className="max-h-64 overflow-auto rounded-md border border-card-border bg-background p-3 text-xs">{JSON.stringify(migration.options.values, null, 2)}</pre>
    <div><Button type="button" size="sm" onClick={onConfirm}>确认原配置并用于新实验</Button></div>
  </div>
}
