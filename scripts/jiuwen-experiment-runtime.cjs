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

'use strict'

const { randomBytes } = require('node:crypto')
const { spawnSync } = require('node:child_process')

function endpoint() {
  const url = new URL(process.env.AGENT_INSIGHT_JIUWEN_WS_URL || 'ws://127.0.0.1:19000/ws')
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/ws') {
    throw new Error('JiuwenSwarm WebSocket 地址必须是可信的 /ws 端点')
  }
  return url
}

function probe() {
  let url
  try { url = endpoint() } catch (error) { return { ready: false, reason: error.message } }
  const script = 'const w=new WebSocket(process.argv[1]);const t=setTimeout(()=>process.exit(1),3500);w.onopen=()=>w.send(JSON.stringify({type:"req",id:"catalog",method:"models.list",params:{}}));w.onmessage=e=>{let x=JSON.parse(String(e.data));if(x.id!=="catalog")return;if(!x.ok)process.exit(2);clearTimeout(t);const names=(x.payload?.models||[]).map(m=>m.model_name).filter(Boolean);process.stdout.write(JSON.stringify({models:names.filter(n=>names.indexOf(n)===names.lastIndexOf(n)),activeModel:x.payload?.active_model||""}),()=>process.exit(0))};w.onerror=()=>process.exit(1)'
  const result = spawnSync(process.execPath, ['-e', script, url.href], { timeout: 4_000, encoding: 'utf8', maxBuffer: 64 * 1024 })
  if (result.status !== 0) return { ready: false, canResolveTraceId: false, reason: `JiuwenSwarm Gateway 或模型目录不可用：${url.origin}`, models: [] }
  try {
    const catalog = JSON.parse(result.stdout)
    return { ready: true, canResolveTraceId: true, models: [...new Set(catalog.models)], activeModel: catalog.activeModel }
  } catch { return { ready: false, canResolveTraceId: false, reason: 'JiuwenSwarm 模型目录响应无效', models: [] } }
}

async function run(input) {
  if (input.agent !== 'main_agent') throw Object.assign(new Error('当前 JiuwenSwarm 仅支持 main_agent'), { code: 'AGENT_RUNTIME_UNAVAILABLE' })
  const url = endpoint()
  const ws = new WebSocket(url)
  const token = `agent-insight-${randomBytes(16).toString('hex')}`
  let sessionId = ''
  let settled = false
  let cleanup = () => {}
  const finish = (resolve, reject, error) => {
    if (settled) return
    settled = true
    cleanup()
    try { ws.close() } catch { /* 连接尚在建立时也要保留原始执行错误 */ }
    if (error) reject(error)
    else resolve({ state: 'AGENT_EXITED', sessionId, exitCode: 0, timedOut: false, modelActivityObserved: true })
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(resolve, reject, Object.assign(new Error('JiuwenSwarm 执行超时'), { code: 'AGENT_TIMEOUT' })), Math.max(1, Number(input.timeoutSeconds) || 600) * 1000)
    cleanup = () => { clearTimeout(timer); input.signal?.removeEventListener('abort', abort) }
    const abort = () => {
      if (sessionId && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'req', id: `${token}-interrupt`, method: 'chat.interrupt', params: { session_id: sessionId } }))
      finish(resolve, reject, Object.assign(new Error('JiuwenSwarm 实验已取消'), { code: 'EXECUTION_CANCELLED' }))
    }
    const send = (id, method, params) => ws.send(JSON.stringify({ type: 'req', id, method, params }))
    input.signal?.addEventListener('abort', abort, { once: true })
    if (input.signal?.aborted) { abort(); cleanup(); return }
    ws.addEventListener('open', () => {
      if (input.model) send(`${token}-models`, 'models.list', {})
      else send(`${token}-create`, 'session.create', { create_token: token, mode: 'agent', persist_session: false, title: input.correlation?.caseRunId || 'Agent Insight experiment' })
    })
    ws.addEventListener('message', (event) => {
      if (settled) return
      let data
      try { data = JSON.parse(String(event.data)) } catch { return }
      if (data.type === 'res' && data.id === `${token}-models`) {
        const names = data.payload?.models?.map(item => item.model_name).filter(Boolean) || []
        if (!data.ok || !names.includes(input.model) || names.filter(name => name === input.model).length !== 1) {
          finish(resolve, reject, Object.assign(new Error('所选 JiuwenSwarm 模型已不可用，请刷新模型列表'), { code: 'MODEL_UNAVAILABLE' }))
          return
        }
        send(`${token}-create`, 'session.create', { create_token: token, mode: 'agent', persist_session: false, title: input.correlation?.caseRunId || 'Agent Insight experiment' })
      } else if (data.type === 'res' && data.id === `${token}-create`) {
        if (!data.ok) { finish(resolve, reject, new Error(data.payload?.error || 'JiuwenSwarm 创建会话失败')); return }
        sessionId = data.payload?.session_id || data.payload?.sessionId || ''
        if (!sessionId) { finish(resolve, reject, new Error('JiuwenSwarm 未返回会话 ID')); return }
        send(`${token}-send`, 'chat.send', { session_id: sessionId, content: input.input, mode: 'agent', ...(input.model ? { model_name: input.model } : {}) })
      } else if (data.type === 'res' && data.id === `${token}-send`) {
        if (!data.ok) finish(resolve, reject, new Error(data.payload?.error || 'JiuwenSwarm 拒绝任务'))
      } else if (data.type === 'event' && data.payload?.session_id === sessionId) {
        if (data.event === 'chat.error' || data.event === 'execution.error') finish(resolve, reject, new Error(data.payload?.error || data.event))
        else if (data.event === 'chat.final' && data.payload?.event_type !== 'runtime.accepted') finish(resolve, reject)
      }
    })
    ws.addEventListener('error', () => finish(resolve, reject, Object.assign(new Error('JiuwenSwarm WebSocket 连接失败'), { code: 'AGENT_RUNTIME_UNAVAILABLE' })))
    ws.addEventListener('close', () => { if (!settled) finish(resolve, reject, new Error('JiuwenSwarm 连接在任务完成前关闭')) })
    ws.addEventListener('close', cleanup, { once: true })
  })
}

module.exports = { endpoint, probe, run }
