import { writeSync } from 'node:fs'
import diagnostics from './agent-run-diagnostics.cjs'

export default async function InsightExperimentEvents() {
  const token = process.env.AGENT_INSIGHT_EVENT_TOKEN
  if (!token) return {}
  let rootSession = null
  const assistantMessages = new Set()
  const observedTools = new Set()
  let modelReported = false
  let routeCompleted = false
  const send = (value) => {
    try { writeSync(3, JSON.stringify({ protocol: 1, token, ...value }) + '\n') } catch {}
  }
  send({ kind: 'ready' })
  return {
    event: async ({ event }) => {
      const p = event.properties || {}
      if (event.type === 'session.created' && !p.info?.parentID && !rootSession && p.info?.id) {
        rootSession = p.info.id
        send({ kind: 'session', sessionId: rootSession })
      }
      const sid = p.sessionID || p.part?.sessionID || p.info?.sessionID
      if (!rootSession || sid !== rootSession) return
      if (!routeCompleted && (event.type === 'session.idle'
        || (event.type === 'session.status' && p.status?.type === 'idle'))) {
        routeCompleted = true
        send({ kind: 'finished', sessionId: rootSession })
      }
      if (event.type === 'message.updated' && p.info?.role === 'assistant') {
        assistantMessages.add(p.info.id)
        if (!modelReported && typeof p.info.modelID === 'string' && p.info.modelID) {
          modelReported = true
          send({ kind: 'model', sessionId: rootSession, model: p.info.providerID
            ? `${p.info.providerID}/${p.info.modelID}` : p.info.modelID })
        }
      }
      let signal = null
      if (event.type === 'session.status' && p.status?.type === 'retry') {
        signal = { type: 'session.status', properties: { status: {
          type: 'retry', attempt: p.status.attempt,
          message: diagnostics.sanitizeAgentDiagnostic(p.status.message),
        } } }
      } else if (event.type === 'session.error' || (event.type === 'message.updated' && p.info?.error)) {
        signal = { type: 'session.error', error: { message: diagnostics.sanitizeAgentDiagnostic(
          diagnostics.extractStructuredAgentError(event) || 'OpenCode 会话错误',
        ) } }
      } else if (event.type === 'message.part.delta' && assistantMessages.has(p.messageID) && typeof p.delta === 'string' && p.delta.length > 0) {
        signal = { type: 'text', part: { text: '[activity]' } }
      } else if (event.type === 'message.part.updated' && assistantMessages.has(p.part?.messageID)) {
        const part = p.part || {}
        if (part.type === 'tool' && part.state?.status === 'completed' && (!part.id || !observedTools.has(part.id))) {
          if (part.id) observedTools.add(part.id)
          const tool = String(part.tool || '').toLowerCase()
          const input = part.state.input || {}
          let skillName = null
          if (tool === 'skill' || tool === 'load_skill') {
            skillName = input.skill || input.name
          } else if (tool === 'read' || tool === 'read_file') {
            const file = String(input.path || input.filePath || '')
            skillName = file.match(/(?:^|[\\/])skills[\\/]([^\\/]+)[\\/]SKILL\.md$/i)?.[1]
          }
          if (typeof skillName === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(skillName)) {
            send({ kind: 'trigger', sessionId: rootSession, skillName })
          }
        }
        if (['text', 'reasoning'].includes(part.type) && part.text?.length > 0) {
          signal = { type: 'text', part: { text: '[activity]' } }
        } else if (part.type === 'tool' && ['running', 'completed'].includes(part.state?.status)) {
          signal = { type: 'tool_use' }
        }
      }
      if (signal) send({ kind: 'event', sessionId: rootSession, signal })
    },
  }
}
