import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

export interface SpoolEvent {
  t: string; kind: string; sessionID: string
  trace_id?: string; parent_id?: string; payload: any; __sourceFile?: string
  agent_id?: string; agent_type?: string
  // AC8: Skill 调用相关字段
  skill_name?: string; skill_version?: string; trigger_mode?: string
  // AC18: MCP 调用相关字段
  mcp_server_name?: string; mcp_tool_name?: string
  // AC16: 模型切换相关
  model_name?: string; provider?: string
}

export interface CheckpointState {
  [sessionId: string]: { signature: string; uploadedAt: string }
}

export interface SessionState {
  start: SpoolEvent | null
  prompts: SpoolEvent[]
  ends: SpoolEvent[]
  tools: SpoolEvent[]
  llms: SpoolEvent[]
  subagentOf: string
  subSessions: string[]
  modelSequence: string[]
  // AC8: Skill 调用集合
  skills: SpoolEvent[]
  // AC18: MCP 调用集合
  mcps: SpoolEvent[]
  // AC7: 多层嵌套支持
  idleAt: number
  events: SpoolEvent[]
}

export class SpoolReader {
  private spoolDir: string

  constructor(spoolDir?: string) {
    this.spoolDir = spoolDir || path.join(os.homedir(), '.agent-insight', 'otel_data', 'trae')
  }

  getSpoolDir(): string { return this.spoolDir }

  listJsonlFiles(): string[] {
    const out: string[] = []
    try {
      if (!fs.existsSync(this.spoolDir)) return out
      const walkDir = (dir: string) => {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true })
          for (const e of entries) {
            const fullPath = path.join(dir, e.name)
            if (e.name.startsWith('_debug')) continue
            if (e.isDirectory()) walkDir(fullPath)
            else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(fullPath)
          }
        } catch {}
      }
      walkDir(this.spoolDir)
    } catch {}
    out.sort()
    return out
  }

  readEvents(filePath: string): SpoolEvent[] {
    const events: SpoolEvent[] = []
    try {
      const text = fs.readFileSync(filePath, 'utf8')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          const obj = JSON.parse(line)
          obj.__sourceFile = filePath
          events.push(obj as SpoolEvent)
        } catch {}
      }
    } catch {}
    return events
  }

  buildSessionState(events: SpoolEvent[]): Map<string, SessionState> {
    const sessions = new Map<string, SessionState>()
    for (const ev of events) {
      const sid = ev.sessionID
      if (!sid) continue
      if (!sessions.has(sid)) {
        sessions.set(sid, { start: null, prompts: [], ends: [], tools: [], llms: [], subagentOf: '', subSessions: [], modelSequence: [], skills: [], mcps: [], idleAt: 0, events: [] })
      }
      const state = sessions.get(sid)!
      // AC7: 记录所有事件用于会话完成检测
      state.events.push(ev)
      
      if (ev.kind === 'agent.session.start' || ev.kind === 'agent.subagent.start') {
        state.start = ev
        if (ev.payload?.parent_session_id) state.subagentOf = ev.payload.parent_session_id
        else if (ev.parent_id) state.subagentOf = ev.parent_id
      }
      else if (ev.kind === 'agent.subagent.end') {
        if (ev.payload?.parent_session_id) state.subagentOf = ev.payload.parent_session_id
      }
      else if (ev.kind === 'agent.prompt') state.prompts.push(ev)
      else if (ev.kind === 'agent.response') state.ends.push(ev)
      else if (ev.kind === 'tool.call.start' || ev.kind === 'tool.call.end') state.tools.push(ev)
      else if (ev.kind === 'llm.call') {
        state.llms.push(ev)
        if (ev.payload?.model && !state.modelSequence.includes(ev.payload.model)) {
          state.modelSequence.push(ev.payload.model)
        }
      }
      // AC8: Skill 调用事件
      else if (ev.kind === 'skill.call.start' || ev.kind === 'skill.call.end') state.skills.push(ev)
      // AC18: MCP 调用事件
      else if (ev.kind === 'mcp.call.start' || ev.kind === 'mcp.call.end') state.mcps.push(ev)
      // AC5: 会话空闲事件（用于检测轮次完成）
      else if (ev.kind === 'agent.session.idle') {
        const ts = new Date(ev.t).getTime()
        if (ts > state.idleAt) state.idleAt = ts
      }
    }
    for (const [sid, state] of sessions) {
      if (state.subagentOf && sessions.has(state.subagentOf)) {
        const parent = sessions.get(state.subagentOf)!
        if (!parent.subSessions.includes(sid)) {
          parent.subSessions.push(sid)
        }
      }
    }
    return sessions
  }
}
