import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

export interface SpoolEvent {
  t: string; kind: string; sessionID: string
  trace_id?: string; parent_id?: string; payload: any; __sourceFile?: string
}

export interface CheckpointState {
  [sessionId: string]: { signature: string; uploadedAt: string }
}

export interface SessionState {
  start: SpoolEvent | null
  prompt: SpoolEvent | null
  end: SpoolEvent | null
  tools: SpoolEvent[]
  llms: SpoolEvent[]
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
        sessions.set(sid, { start: null, prompt: null, end: null, tools: [], llms: [] })
      }
      const state = sessions.get(sid)!
      if (ev.kind === 'agent.session.start' || ev.kind === 'agent.subagent.start') state.start = ev
      else if (ev.kind === 'agent.prompt') state.prompt = ev
      else if (ev.kind === 'agent.response') state.end = ev
      else if (ev.kind === 'tool.call.start' || ev.kind === 'tool.call.end') state.tools.push(ev)
      else if (ev.kind === 'llm.call') state.llms.push(ev)
    }
    return sessions
  }
}
