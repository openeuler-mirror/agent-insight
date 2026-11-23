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

import { useRef, useState, type ReactNode } from 'react'
import { useExecutionEnvironment } from '@/lib/client/use-execution-environment'
import { startSameConfigExperiment } from '@/lib/client/start-same-config-experiment'

export function SameConfigExperimentAction({ user, sourceExperimentId, disabled, onBusyChange, onStarted, children }: {
  user: string
  sourceExperimentId: string
  disabled: boolean
  onBusyChange: (busy: boolean) => void
  onStarted: (id: string) => void
  children?: ReactNode
}) {
  const environment = useExecutionEnvironment(user, { sourceExperimentId })
  const running = useRef(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const busy = environment.busy || starting
  const failed = Boolean(error) || environment.failed
  const message = (error || (environment.state === 'preparing' || environment.failed ? environment.message : '')).replaceAll('“下一步”', '“重试”')
  const label = environment.state === 'checking' ? '环境检查中…' : environment.state === 'preparing' ? '环境准备中…' : starting ? '启动中…' : failed ? '重试' : '同配置实验'

  const start = async () => {
    if (!user || disabled || running.current) return
    running.current = true
    onBusyChange(true)
    setError('')
    try {
      if (!await environment.check() || !environment.isCurrent()) return
      setStarting(true)
      const id = await startSameConfigExperiment(user, sourceExperimentId)
      if (environment.isCurrent()) onStarted(id)
    } catch (error) {
      setError(error instanceof Error ? error.message : '同配置实验启动失败，请重试。')
    } finally {
      running.current = false
      setStarting(false)
      onBusyChange(false)
    }
  }

  return <div>
    <div className="flex items-center gap-2">
      <button type="button" disabled={disabled || busy} onClick={() => void start()} className="text-primary disabled:opacity-50">{label}</button>
      {children}
    </div>
    {message && <p role={failed ? 'alert' : 'status'} aria-live="polite" className={`mt-2 max-w-sm whitespace-pre-wrap text-xs ${failed ? 'text-error' : 'text-foreground-muted'}`}>{message}</p>}
  </div>
}
