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

import { appendFileSync } from 'node:fs'
import diagnostics from './agent-run-diagnostics.cjs'

export async function setup(context) {
  const token = process.env.AGENT_INSIGHT_EVENT_TOKEN
  if (!token) return
  const abort = new AbortController()
  const rootSession = process.env.AGENT_INSIGHT_EXPERIMENT_SESSION_ID
  let sessionReported = false
  const tools = new Map()
  const send = value => {
    try { appendFileSync(process.env.AGENT_INSIGHT_EVENT_FILE, JSON.stringify({ protocol: 1, token, ...value }) + '\n') } catch {}
  }
  const signal = value => send({ kind: 'event', sessionId: rootSession, signal: value })
  const events = (async () => {
    try {
      for await (const event of context.event.subscribe({ signal: abort.signal })) {
        const d = event.data || {}
        if (!rootSession || d.sessionID !== rootSession) continue
        if (!sessionReported) {
          sessionReported = true
          send({ kind: 'session', sessionId: rootSession })
          signal({ type: 'session.status', properties: { status: { type: 'busy' } } })
        }
        if (event.type === 'session.step.started' && d.model?.id) {
          send({ kind: 'model', sessionId: rootSession, model: `${d.model.providerID}/${d.model.id}` })
        }
        if (/^session\.(text|reasoning)\.(delta|ended)$/.test(event.type) && (d.delta || d.text)) {
          signal({ type: 'text', part: { text: '[activity]' } })
        } else if (event.type === 'session.tool.called') {
          tools.set(d.id, { name: d.name || tools.get(d.id)?.name, input: d.input })
          signal({ type: 'tool_use' })
        } else if (event.type === 'session.tool.input.started') {
          tools.set(d.id, { name: d.name })
        } else if (event.type === 'session.tool.success') {
          const tool = tools.get(d.id) || {}
          const input = tool.input || {}
          const skill = ['skill', 'load_skill'].includes(tool.name) ? input.skill || input.name
            : ['read', 'read_file'].includes(tool.name) ? String(input.path || input.filePath || '').match(/(?:^|[\\/])skills[\\/]([^\\/]+)[\\/]SKILL\.md$/i)?.[1] : null
          if (typeof skill === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(skill)) {
            send({ kind: 'trigger', sessionId: rootSession, skillName: skill })
          }
          tools.delete(d.id)
        } else if (event.type === 'session.retry.scheduled') {
          signal({ type: 'session.status', properties: { status: {
            type: 'retry', attempt: Math.max(1, Number(d.attempt) - 1),
            message: diagnostics.sanitizeAgentDiagnostic(d.message || d.error?.message || 'OpenCode 模型请求重试'),
          } } })
        } else if (event.type === 'session.execution.failed') {
          signal({ type: 'session.error', error: { message: diagnostics.sanitizeAgentDiagnostic(
            diagnostics.extractStructuredAgentError(d) || d.error?.message || 'OpenCode v2 会话执行失败') } })
        } else if (event.type === 'session.execution.interrupted') {
          signal({ type: 'session.error', error: { message: 'OpenCode v2 会话执行被中断' } })
        } else if (event.type === 'session.execution.succeeded') {
          send({ kind: 'finished', sessionId: rootSession })
        }
      }
    } catch (error) {
      if (!abort.signal.aborted && rootSession) signal({ type: 'session.error', error: { message: diagnostics.sanitizeAgentDiagnostic(error.message) } })
    }
  })()
  send({ kind: 'ready' })
  return async () => { abort.abort(); await events }
}

export default { id: 'agent-insight.experiment-events', setup }
