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

import { apiFetch } from './api'

async function responseBody(response: Response, fallback: string) {
  const value = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : value.error?.message || fallback)
  return value
}

export async function startSameConfigExperiment(user: string, sourceExperimentId: string) {
  const created = await responseBody(await apiFetch('/api/experiments', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user, createMode: 'same-config', sourceExperimentId }),
  }), '复制实验配置失败')
  const id = typeof created.id === 'string' ? created.id : ''
  if (!id) throw new Error('复制实验后未返回实验 ID')
  const taskId = typeof created.grayscaleTaskId === 'string' ? created.grayscaleTaskId : ''
  const response = await apiFetch(taskId ? `/api/debug/grayscale-tasks/${encodeURIComponent(taskId)}` : `/api/experiments/${encodeURIComponent(id)}/run?user=${encodeURIComponent(user)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: taskId ? JSON.stringify({ user, action: 'start', caseIds: created.caseIds || [], evaluators: created.evaluatorIds || [] }) : '{}',
  })
  if (!response.ok) {
    await apiFetch(`/api/experiments/${encodeURIComponent(id)}?user=${encodeURIComponent(user)}`, { method: 'DELETE' }).catch(() => undefined)
  }
  await responseBody(response, '启动实验失败')
  return id
}
