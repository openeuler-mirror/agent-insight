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
