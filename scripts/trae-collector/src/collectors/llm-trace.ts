import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { TraeConfig } from '../extension'

/**
 * LLM Trace Collector
 *
 * Captures LLM model calls from TRAE by:
 * 1. Polling TRAE's internal SQLite DB (~/.icube/ai-agent/database.db) for token usage
 * 2. Writing llm.call events to spool so UploadEngine picks them up
 *
 * Configurable via llmEnabled (switch) and llmPollIntervalMs (poll frequency).
 */
export class LlmTraceCollector implements vscode.Disposable {
  private disposables: vscode.Disposable[] = []
  private log: (msg: string) => void
  private config: TraeConfig
  private pollTimer: NodeJS.Timeout | undefined
  private dbPath: string

  constructor(log: (msg: string) => void, config?: TraeConfig) {
    this.log = log
    this.config = config || this.loadDefaultConfig()
    this.dbPath = path.join(os.homedir(), '.icube', 'ai-agent', 'database.db')
    this.initialize()
  }

  private loadDefaultConfig(): TraeConfig {
    return {
      enabled: true, host: '', apiKey: '', uploadIntervalMs: 300000,
      requestTimeoutMs: 15000,
      maxRetries: 3, retryBaseDelayMs: 10000, llmEnabled: true,
      llmPollIntervalMs: 30000, logLevel: 'info',
      spoolDir: '',
    }
  }

  private initialize() {
    if (!this.config.llmEnabled) {
      this.log('LLM Trace collector disabled by config')
      return
    }
    try {
      this.pollDbForLlmUsage()
      this.log('LLM Trace collector initialized (pollInterval=' + this.config.llmPollIntervalMs + 'ms)')
    } catch (err) {
      this.log(`LLM init: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Compute spool base dir matching Hook script's get_spool_base() logic */
  private getSpoolBase(): string {
    const insightDir = process.env.AGENT_INSIGHT_DIR || path.join(os.homedir(), '.agent-insight')
    const apiKey = this.config.apiKey || ''
    let keyHash = ''
    if (apiKey) {
      try {
        keyHash = crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 16)
      } catch {}
    }
    const subDir = keyHash ? `trae/${keyHash}` : 'trae/default'
    return path.join(insightDir, 'otel_data', subDir)
  }

  /** Get today's spool file for LLM data */
  private getSpoolFile(): string {
    const base = this.getSpoolBase()
    const dayDir = path.join(base, new Date().toISOString().slice(0, 10))
    try { fs.mkdirSync(dayDir, { recursive: true }) } catch {}
    return path.join(dayDir, 'trae-llm.jsonl')
  }

  /** Write an llm.call event to spool */
  private writeLlmCall(sessionId: string, model: string, provider: string,
    promptTokens: number, completionTokens: number) {
    try {
      const entry = {
        t: new Date().toISOString(),
        kind: 'llm.call',
        sessionID: sessionId,
        trace_id: sessionId,
        parent_id: '',
        payload: {
          model: model || 'unknown',
          provider: provider || '',
          promptTokens: promptTokens || 0,
          completionTokens: completionTokens || 0,
          tokens: (promptTokens || 0) + (completionTokens || 0),
          totalTokens: (promptTokens || 0) + (completionTokens || 0),
        },
      }
      const filePath = this.getSpoolFile()
      fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8')
      this.log(`LLM spool: session=${sessionId.slice(0, 16)} model=${model} tokens=${(promptTokens||0)+(completionTokens||0)}`)
    } catch (err) {
      this.log(`LLM spool write error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private pollDbForLlmUsage() {
    const pollInterval = this.config.llmPollIntervalMs
    const poll = () => {
      if (!fs.existsSync(this.dbPath)) return
      try {
        const { execSync } = require('child_process') as typeof import('child_process')
        const result = execSync(
          `sqlite3 "${this.dbPath}" "SELECT session_id, model, prompt_tokens, completion_tokens FROM sessions ORDER BY created_at DESC LIMIT 10" 2>/dev/null`,
          { encoding: 'utf8', timeout: 5000 }
        ).toString().trim()
        if (result) {
          for (const line of result.split('\n')) {
            const parts = line.split('|')
            if (parts.length >= 4) {
              const sessionId = parts[0]
              const model = parts[1]
              const pTokens = parseInt(parts[2], 10) || 0
              const cTokens = parseInt(parts[3], 10) || 0
              this.writeLlmCall(sessionId, model, '', pTokens, cTokens)
            }
          }
        }
      } catch {}
    }
    poll()
    this.pollTimer = setInterval(poll, pollInterval)
  }

  recordLlmCall(sessionId: string, model: string, provider: string,
    promptTokens?: number, completionTokens?: number, latency?: number) {
    this.writeLlmCall(sessionId, model, provider, promptTokens || 0, completionTokens || 0)
  }

  dispose() {
    if (this.pollTimer) clearInterval(this.pollTimer)
    for (const d of this.disposables) d.dispose()
    this.disposables = []
  }
}
