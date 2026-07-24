import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as vscode from 'vscode'
import { SpoolReader, SpoolEvent, CheckpointState } from './spool'
import { TraeConfig } from '../extension'

export interface UploadResult { ok: boolean; status: number; body: string }

export class UploadEngine implements vscode.Disposable {
  private spoolReader: SpoolReader
  private log: (msg: string) => void
  private config: TraeConfig
  private checkpointFile: string
  private consecutiveFailures = 0
  private inFlight = new Set<string>()
  private disposed = false

  constructor(spoolReader: SpoolReader, log: (msg: string) => void, config?: TraeConfig) {
    this.spoolReader = spoolReader
    this.log = log
    this.config = config || this.loadDefaultConfig()
    this.checkpointFile = path.join(os.homedir(), '.agent-insight', 'trae_uploader_checkpoint.json')
  }

  private loadDefaultConfig(): TraeConfig {
    const cfg = vscode.workspace.getConfiguration('agentInsight.trae')
    return {
      enabled: true, host: cfg.get<string>('host', '') || '',
      apiKey: cfg.get<string>('apiKey', '') || '',
      uploadIntervalMs: 300000,
      requestTimeoutMs: cfg.get<number>('requestTimeoutMs', 15000),
      maxRetries: cfg.get<number>('maxRetries', 3),
      retryBaseDelayMs: cfg.get<number>('retryBaseDelayMs', 10000),
      llmEnabled: true, llmPollIntervalMs: 30000,
      logLevel: 'info', spoolDir: '',
    }
  }

  private getConfig() {
    // Refresh host/apiKey on each call (they may change via settings)
    const cfg = vscode.workspace.getConfiguration('agentInsight.trae')
    this.config.host = cfg.get<string>('host', '') || this.config.host
    this.config.apiKey = cfg.get<string>('apiKey', '') || this.config.apiKey
    this.config.requestTimeoutMs = cfg.get<number>('requestTimeoutMs', this.config.requestTimeoutMs)
    this.config.maxRetries = cfg.get<number>('maxRetries', this.config.maxRetries)
    this.config.retryBaseDelayMs = cfg.get<number>('retryBaseDelayMs', this.config.retryBaseDelayMs)
    return { host: this.config.host, apiKey: this.config.apiKey }
  }

  private loadCheckpoint(): CheckpointState {
    try { return fs.existsSync(this.checkpointFile) ? JSON.parse(fs.readFileSync(this.checkpointFile, 'utf8')) : {} } catch { return {} }
  }

  private saveCheckpoint(state: CheckpointState) {
    try { fs.mkdirSync(path.dirname(this.checkpointFile), { recursive: true }); fs.writeFileSync(this.checkpointFile, JSON.stringify(state, null, 2)) } catch {}
  }

  private buildSignature(events: SpoolEvent[]): string {
    return `${events.map(e => e.kind).join(',')}|${events.length > 0 ? events[events.length - 1].t : ''}|${events.length}`
  }

  private buildPayload(sessionId: string, events: SpoolEvent[]): any {
    const startEvent = events.find(e => e.kind === 'agent.session.start' || e.kind === 'agent.subagent.start')
    const promptEvent = events.find(e => e.kind === 'agent.prompt')
    const responseEvent = events.find(e => e.kind === 'agent.response')
    const toolCalls = events.filter(e => e.kind === 'tool.call.start')
    const toolResults = events.filter(e => e.kind === 'tool.call.end')
    const llmCalls = events.filter(e => e.kind === 'llm.call')
    let latency = 0
    if (startEvent && responseEvent) { const s = new Date(startEvent.t).getTime(); const e2 = new Date(responseEvent.t).getTime(); if (e2 > s) latency = e2 - s }

    // Build per-tool latencies from paired start/end events
    const toolLatencies: Record<string, number> = {}
    for (const ts of toolCalls) {
      const tId = ts.trace_id
      if (!tId) continue
      const te = toolResults.find(e => e.trace_id === tId)
      if (te) {
        const start = new Date(ts.t).getTime()
        const end = new Date(te.t).getTime()
        if (end > start) toolLatencies[tId] = end - start
      }
    }

    const interactions: any[] = []
    if (promptEvent) {
      interactions.push({ role: 'user', content: promptEvent.payload.query || '', timestamp: promptEvent.t })
    }
    if (responseEvent) {
      interactions.push({ role: 'assistant', content: responseEvent.payload.finalResult || '', timestamp: responseEvent.t })
    }

    return {
      task_id: sessionId, query: promptEvent?.payload?.query || '', framework: 'trae',
      model: llmCalls[0]?.payload?.model || '', tokens: llmCalls.reduce((s, l) => s + (l.payload.tokens || l.payload.totalTokens || 0), 0),
      latency: latency / 1000, final_result: responseEvent?.payload?.finalResult || '', timestamp: new Date().toISOString(),
      tool_call_count: toolCalls.length, tool_call_error_count: toolResults.filter(t => t.payload.error).length,
      llm_call_count: llmCalls.length, trace: { trace_id: sessionId },
      tool_latencies: toolLatencies,
      interactions,
    }
  }

  private async postJson(host: string, apiKey: string, payload: any): Promise<UploadResult> {
    const base = host.replace(/\/+$/, '')
    const fullUrl = base + '/api/ingest/upload'
    const body = JSON.stringify(payload)
    const timeoutMs = this.config.requestTimeoutMs
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      const res = await fetch(fullUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'x-witty-api-key': apiKey } : {}) },
        body, signal: controller.signal,
      })
      clearTimeout(timeout)
      const resBody = await res.text()
      return { ok: res.ok, status: res.status, body: resBody.slice(0, 1000) }
    } catch (err) {
      return { ok: false, status: 0, body: err instanceof Error ? err.message : String(err) }
    }
  }

  async uploadAll(): Promise<void> {
    if (this.disposed) return
    const cfg = this.getConfig()
    if (!cfg.host || !cfg.apiKey) { this.log('uploadAll skipped: missing host or apiKey'); return }
    const files = this.spoolReader.listJsonlFiles()
    if (files.length === 0) { this.log('uploadAll: no spool files found'); return }
    this.log(`uploadAll: scanning ${files.length} files...`)
    const allEvents: SpoolEvent[] = []
    for (const f of files) allEvents.push(...this.spoolReader.readEvents(f))
    const sessions = this.spoolReader.buildSessionState(allEvents)
    this.log(`uploadAll: found ${sessions.size} sessions`)
    const ckpt = this.loadCheckpoint()
    const maxRetries = this.config.maxRetries
    const baseDelayMs = this.config.retryBaseDelayMs
    for (const [sessionId, state] of sessions.entries()) {
      if (this.disposed) break
      const events: SpoolEvent[] = [state.start, state.prompt, ...state.tools, state.end].filter((e): e is SpoolEvent => e !== null)
      if (events.length === 0) continue
      
      // Skip sessions that haven't received a response yet
      if (!state.end && !state.prompt) continue
      
      const sig = this.buildSignature(events)
      if (ckpt[sessionId]?.signature === sig) continue
      this.inFlight.add(sessionId)
      const payload = this.buildPayload(sessionId, events)
      let lastError = ''
      let success = false
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        if (attempt > 1) { const d = baseDelayMs * Math.pow(3, attempt - 2); this.log(`retry ${attempt}/${maxRetries} for ${sessionId} after ${d}ms`); await new Promise(r => setTimeout(r, d)) }
        const result = await this.postJson(cfg.host, cfg.apiKey, payload)
        if (result.ok) { success = true; ckpt[sessionId] = { signature: sig, uploadedAt: new Date().toISOString() }; this.saveCheckpoint(ckpt); this.log(`uploaded session=${sessionId}`); this.consecutiveFailures = 0; break }
        else { lastError = `status=${result.status}`; this.log(`upload failed session=${sessionId} attempt=${attempt} ${lastError}`) }
      }
      this.inFlight.delete(sessionId)
      if (!success) { this.consecutiveFailures++; this.log(`upload failed after ${maxRetries} retries for ${sessionId}: ${lastError}`) }
    }
    this.log(`uploadAll completed: ${sessions.size} sessions processed`)
  }

  dispose() {
    this.disposed = true
    this.log('UploadEngine disposed')
  }
}
