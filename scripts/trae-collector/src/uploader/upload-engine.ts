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
  private lastScanMtime = 0
  private maxBackoffMs = 300000
  // AC17: 内容截断长度
  private maxContentLength = 2000

  constructor(spoolReader: SpoolReader, log: (msg: string) => void, config?: TraeConfig) {
    this.spoolReader = spoolReader
    this.log = log
    this.config = config || this.loadDefaultConfig()
    this.checkpointFile = path.join(os.homedir(), '.agent-insight', 'trae_uploader_checkpoint.json')
    this.maxContentLength = parseInt(process.env.AGENT_INSIGHT_TRAE_MAX_CONTENT_LENGTH || '2000', 10)
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
      llmEnabled: true, llmPollIntervalMs: 30000, heartbeatEnabled: true, heartbeatIntervalMs: 30000,
      logLevel: 'info', spoolDir: '', modelName: '',
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

  // AC17: 内容截断 - 超过 maxContentLength 的内容自动截断
  private truncateContent(content: string, maxLength?: number): string {
    const len = maxLength || this.maxContentLength
    if (!content || content.length <= len) return content
    return content.slice(0, len - 3) + '...'
  }

  // AC17: JSON 对象内容截断
  private truncateJsonContent(obj: any, maxLength?: number): any {
    if (!obj) return obj
    const len = maxLength || this.maxContentLength
    const keys = Object.keys(obj)
    for (const key of keys) {
      if (typeof obj[key] === 'string') {
        if (obj[key].length > len) {
          obj[key] = this.truncateContent(obj[key], len)
        }
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        this.truncateJsonContent(obj[key], len)
      }
    }
    return obj
  }

  /** 
   * Build a content signature for checkpoint comparison
   * Reference: opencode_uploader_client.js buildSignature
   * 
   * The signature includes:
   * - interactionCount: number of interactions
   * - finalResultLength: length of final result
   * - lastTs: timestamp of last event
   * - traceCompletedAt: completion timestamp (if completed)
   * - completed: whether session is completed
   * - toolCallCount: number of tool calls (monotonic counter for tool loops)
   * - tokens: total tokens (monotonic counter)
   * - recordCount: total event count (monotonic counter)
   */
  private buildSignature(events: SpoolEvent[], state?: any): string {
    const allPrompts = (state?.prompts && state.prompts.length > 0)
      ? state.prompts : events.filter(e => e.kind === 'agent.prompt')
    const allEnds = (state?.ends && state.ends.length > 0)
      ? state.ends : events.filter(e => e.kind === 'agent.response')
    const toolCalls = events.filter(e => e.kind === 'tool.call.start')
    const llmCalls = events.filter(e => e.kind === 'llm.call')
    
    const interactionCount = allPrompts.length + allEnds.length
    const lastEnd = allEnds[allEnds.length - 1]
    const finalResultLength = lastEnd ? (String(lastEnd.payload?.finalResult || '').length) : 0
    
    let lastTs = 0
    for (const e of events) {
      const t = new Date(e.t).getTime()
      if (t > lastTs) lastTs = t
    }
    
    const isCompleted = allEnds.length > 0 && this.isRoundCompleted(state, lastEnd, lastTs)
    const traceCompletedAt = isCompleted ? new Date(lastTs).toISOString() : ''
    
    const toolCallCount = toolCalls.length
    let tokens = 0
    for (const lc of llmCalls) {
      tokens += lc.payload?.tokens || lc.payload?.totalTokens || 0
    }
    const recordCount = events.length
    
    const base = [interactionCount, finalResultLength, lastTs, traceCompletedAt, isCompleted ? '1' : '0']
    // For completed sessions, use only base signature to avoid re-uploading
    if (isCompleted) return base.join('|')
    // For in-progress sessions, add monotonic counters to detect tool loops
    return [...base, toolCallCount, tokens, recordCount].join('|')
  }

  /**
   * Check if a round is completed (has final result and idle time after last activity)
   * Reference: opencode_uploader_client.js isRoundCompleted
   */
  private isRoundCompleted(state: any, lastEnd: SpoolEvent, lastTs: number): boolean {
    const finalResult = lastEnd?.payload?.finalResult
    if (!finalResult) return false

    // Check for explicit session.stop event (AC5 completion marker)
    const hasStopEvent = state?.events?.some((e: SpoolEvent) => e.kind === 'agent.session.stop')
    if (hasStopEvent) return true

    // Check for idle event
    if (state?.idleAt && state.idleAt > 0) {
      const idleMs = state.idleAt
      const tolerance = 2000
      return idleMs + tolerance >= lastTs
    }

    return false
  }

  /** Language-aware token estimation */
  private estimateTokens(text: string): number {
    if (!text) return 0
    const cjkCount = (text.match(/[\u3400-\u9fff]/g) || []).length
    const nonCjk = text.replace(/[\u3400-\u9fff]/g, '')
    const latinWordCount = (nonCjk.match(/[A-Za-z0-9_]+/g) || []).length
    const otherChars = nonCjk.replace(/[A-Za-z0-9_\s]/g, '').length
    return Math.max(1, Math.ceil(cjkCount * 1.2 + latinWordCount * 1.3 + otherChars * 0.5))
  }

  private buildPayload(sessionId: string, events: SpoolEvent[], state?: any): any {
    const startEvent = events.find(e => e.kind === 'agent.session.start' || e.kind === 'agent.subagent.start')
    // Multi-turn support: use arrays from SessionState, fall back to filtering events
    const allPrompts = (state?.prompts && state.prompts.length > 0)
      ? state.prompts : events.filter(e => e.kind === 'agent.prompt')
    const allEnds = (state?.ends && state.ends.length > 0)
      ? state.ends : events.filter(e => e.kind === 'agent.response')
    const firstPrompt = allPrompts[0] || null
    const lastEnd = allEnds[allEnds.length - 1] || null
    const toolCalls = events.filter(e => e.kind === 'tool.call.start')
    const toolResults = events.filter(e => e.kind === 'tool.call.end')
    const llmCalls = events.filter(e => e.kind === 'llm.call')
    let latency = 0
    if (startEvent && lastEnd) { const s = new Date(startEvent.t).getTime(); const e2 = new Date(lastEnd.t).getTime(); if (e2 > s) latency = e2 - s }

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
    // Build interactions for ALL turns (multi-turn support)
    const interactions: any[] = []
    const toolCallsForAssistant = toolCalls.map((ts, i) => {
      const te = toolResults.find(r => r.trace_id === ts.trace_id)
      const dur = te && ts.t ? toolLatencies[ts.trace_id || ''] : undefined
      return {
        id: ts.trace_id || '',
        type: 'function',
        function: {
          name: ts.payload?.toolName || te?.payload?.toolName || '',
          arguments: JSON.stringify(ts.payload?.toolInput || {}),
        },
        state: te?.payload?.error ? 'error' : 'success',
        output: te?.payload?.toolResponse || null,
        error: te?.payload?.error || null,
        duration_ms: dur || undefined,
        timing: { started_at: ts.t, completed_at: te?.t || ts.t },
      }
    })
    // Token estimation for ALL turns combined
    const firstLlm = llmCalls[0]?.payload
    const configModel = this.config?.modelName || ''
    const allPromptTexts = allPrompts.map((p: any) => p.payload?.query || '').filter(Boolean)
    const allResponseTexts = allEnds.map((e: any) => e.payload?.finalResult || '').filter(Boolean)
    const combinedPrompt = allPromptTexts.join(' ')
    const combinedResponse = allResponseTexts.join(' ')
    const hasLlmData = llmCalls.length > 0 && (firstLlm?.tokens || firstLlm?.totalTokens)
    const estimatedTokens = hasLlmData ? undefined : {
      input: this.estimateTokens(combinedPrompt),
      output: this.estimateTokens(combinedResponse),
      total: this.estimateTokens(combinedPrompt) + this.estimateTokens(combinedResponse),
      estimated: true,
    }
    const usageTokens = firstLlm ? {
      input: firstLlm.promptTokens || 0,
      output: firstLlm.completionTokens || 0,
      total: firstLlm.totalTokens || (firstLlm.promptTokens || 0) + (firstLlm.completionTokens || 0),
    } : estimatedTokens
    const totalTokens = firstLlm ? (firstLlm.tokens || firstLlm.totalTokens || 0) : (estimatedTokens?.total || 0)

    // Agent name for interactions
    const sessionAgent = startEvent?.agent_id || allPrompts.find((p: any) => p?.agent_id)?.agent_id || allEnds.find((e: any) => e?.agent_id)?.agent_id || 'solo_agent'

    // Build user+assistant pairs for each turn
    // Reference: opencode_uploader_client.js buildMessagesForSession
    const maxTurns = Math.max(allPrompts.length, allEnds.length)
    for (let i = 0; i < maxTurns; i++) {
      if (allPrompts[i]) {
        interactions.push({ 
          role: 'user', 
          content: allPrompts[i].payload?.query || '',
          timeInfo: { created: new Date(allPrompts[i].t).getTime(), completed: new Date(allPrompts[i].t).getTime() },
          timestamp: allPrompts[i].t,
          agent: sessionAgent, 
          agentName: sessionAgent,
          cwd: allPrompts[i].payload?.cwd || undefined,
        })
      }
      // 工具时间窗口：本轮 prompt ~ 本轮 end；无 end（中断轮）时延伸到下一轮 prompt 或最后事件
      const ttt = toolCallsForAssistant.filter(tc => {
        const ts = toolCalls.find(s => s.trace_id === tc.id)
        if (!ts) return false
        const s2 = allPrompts[i]?.t || '0001-01-01'
        const e2 = allEnds[i]?.t || allPrompts[i + 1]?.t || '9999-12-31'
        return ts.t >= s2 && ts.t <= e2
      })

      if (allEnds[i]) {
        // Separate main agent tools from subagent tools
        const mainTools: any[] = []
        const subagentTools = new Map<string, { subagentId: string; subagentType: string; tools: any[] }>()
        for (const tc of ttt) {
          const ts = toolCalls.find(s => s.trace_id === tc.id)
          const sai = ts?.payload?.subagentId
          if (sai) {
            if (!subagentTools.has(sai)) {
              subagentTools.set(sai, { subagentId: sai, subagentType: ts?.payload?.subagentType || '', tools: [] })
            }
            subagentTools.get(sai)!.tools.push(tc)
          } else {
            mainTools.push(tc)
          }
        }

        // Add synthetic TASK tool calls for each subagent (creates TASK spawn nodes)
        for (const [sai, sg] of subagentTools) {
          const childSessionId = `${sessionId}__${sg.subagentId}`
          mainTools.push({
            id: `task_${sai}`,
            type: 'function',
            function: { name: 'task', arguments: JSON.stringify({ subagent_type: sg.subagentType, description: sg.subagentId }) },
            state: 'success',
            output: JSON.stringify({ subagent_session_id: childSessionId }),
            timing: { started_at: sg.tools[0]?.timing?.started_at || allEnds[i].t, completed_at: sg.tools[sg.tools.length - 1]?.timing?.completed_at || allEnds[i].t },
            trace_split_parallel_task: true,
          })
        }

        interactions.push({
          role: 'assistant',
          content: allEnds[i].payload?.finalResult || '',
          timeInfo: { created: new Date(allPrompts[i]?.t || allEnds[i].t).getTime(), completed: new Date(allEnds[i].t).getTime() },
          timestamp: allEnds[i].t,
          parts: [{ type: 'text', text: allEnds[i].payload?.finalResult || '' }],
          agent: sessionAgent,
          agentName: sessionAgent,
          model: firstLlm?.model || configModel || sessionAgent,
          usage: usageTokens,
          finish_reason: 'stop',
          tool_calls: mainTools.length > 0 ? mainTools : undefined,
          tool_call_count: ttt.length,
          tool_call_error_count: ttt.filter(t => t.state === 'error').length,
        })

        // Create subagent interactions (each becomes a child AGENT node)
        for (const [sai, sg] of subagentTools) {
          const childSessionId = `${sessionId}__${sg.subagentId}`
          // Estimate subagent token usage from tool I/O via gpt-tokenizer
          let subInput = 0, subOutput = 0
          for (const tc of sg.tools) {
            subInput += this.estimateTokens(tc.function?.arguments || '')
            subOutput += this.estimateTokens(tc.output ? JSON.stringify(tc.output) : '')
          }
          // +30 protocol overhead per tool message
          const protoOverhead = sg.tools.length * 30
          interactions.push({
            role: 'subagent',
            content: `Executed ${sg.tools.length} tool(s): ${sg.tools.map(t => t.function?.name).join(', ')}`,
            timeInfo: {
              created: new Date(sg.tools[0]?.timing?.started_at || allEnds[i].t).getTime(),
              completed: new Date(sg.tools[sg.tools.length - 1]?.timing?.completed_at || allEnds[i].t).getTime(),
            },
            timestamp: sg.tools[0]?.timing?.started_at || allEnds[i].t,
            parts: [{ type: 'text', text: `Executed ${sg.tools.length} tool(s): ${sg.tools.map(t => t.function?.name).join(', ')}` }],
            agent: sessionAgent,
            subagent_name: sg.subagentType,
            subagent_session_id: childSessionId,
            model: firstLlm?.model || configModel || sessionAgent,
            usage: { input: subInput + protoOverhead, output: subOutput, total: subInput + subOutput + protoOverhead },
            tool_calls: sg.tools,
            tool_call_count: sg.tools.length,
            tool_call_error_count: sg.tools.filter(t => t.state === 'error').length,
          })
        }
      } else if (ttt.length > 0) {
        // 中断轮兜底：无 response 但本轮有工具调用（对话中断/异常终止）时，
        // 合成"进行中"的 assistant turn 承载工具，避免工具信息丢失（此前 tools 只挂在有 end 的轮次）
        interactions.push({
          role: 'assistant',
          content: '',
          timeInfo: {
            created: new Date(allPrompts[i]?.t || ttt[0]?.timing?.started_at || Date.now()).getTime(),
            completed: new Date(ttt[ttt.length - 1]?.timing?.completed_at || Date.now()).getTime(),
          },
          timestamp: ttt[0]?.timing?.started_at || allPrompts[i]?.t,
          parts: [{ type: 'text', text: '' }],
          agent: sessionAgent,
          agentName: sessionAgent,
          model: firstLlm?.model || configModel || sessionAgent,
          usage: usageTokens,
          finish_reason: 'interrupted',
          tool_calls: ttt,
          tool_call_count: ttt.length,
          tool_call_error_count: ttt.filter(t => t.state === 'error').length,
        })
      }
    }
    // Detect Skill calls from tool events
    const skillCalls = toolResults.filter(t => {
      const startMatch = toolCalls.find(s => s.trace_id === t.trace_id)
      return (t.payload?.toolType === 'skill' ||
              t.payload?.toolName === 'Skill' ||
              startMatch?.payload?.toolName === 'Skill' ||
              (t.payload?.toolName && t.payload.toolName.startsWith('skill')))
    })

    // Track model sequence for model switching
    const modelSeq: string[] = []
    for (const lc of llmCalls) {
      const m = lc.payload?.model
      if (m && !modelSeq.includes(m)) modelSeq.push(m)
    }

    // Extract agent_id/agent_type from event metadata
    const allEvents_forMeta = [startEvent, ...allPrompts, ...allEnds].filter(Boolean)
    const agentId = allEvents_forMeta.find((e: any) => e?.agent_id)?.agent_id || startEvent?.agent_id || ''
    const agentType = allEvents_forMeta.find((e: any) => e?.agent_type)?.agent_type || startEvent?.agent_type || ''

    let totalInputTokens = 0
    let totalOutputTokens = 0
    for (const lc of llmCalls) {
      totalInputTokens += lc.payload?.promptTokens || 0
      totalOutputTokens += lc.payload?.completionTokens || 0
    }
    if (totalInputTokens === 0 && totalOutputTokens === 0 && estimatedTokens) {
      totalInputTokens = estimatedTokens.input || 0
      totalOutputTokens = estimatedTokens.output || 0
    }

    const skillNames = skillCalls.map(s => {
      const startEvent = toolCalls.find(ts => ts.trace_id === s.trace_id)
      return s.payload?.skillName || startEvent?.payload?.skillName || ''
    }).filter(Boolean)

    // Use latest event time as timestamp so dashboard reflects last activity
    let latestTs = 0
    for (const e of events) { const t = new Date(e.t).getTime(); if (t > latestTs) latestTs = t }
    const activityTime = latestTs > 0 ? new Date(latestTs).toISOString() : new Date().toISOString()

    return {
      task_id: sessionId, query: combinedPrompt, framework: 'trae',
      agent_id: agentId, agent_type: agentType,
      agent: sessionAgent, agentName: sessionAgent,
      model: firstLlm?.model || configModel || '', tokens: totalTokens,
      input_tokens: totalInputTokens, output_tokens: totalOutputTokens,
      latency: latency / 1000, final_result: combinedResponse, timestamp: activityTime,
      completed: allEnds.length > 0,
      trace_completed_at: allEnds.length > 0 ? new Date().toISOString() : undefined,
      tool_call_count: toolCalls.length, tool_call_error_count: toolResults.filter(t => t.payload.error).length,
      llm_call_count: llmCalls.length, trace: { trace_id: sessionId },
      tool_latencies: toolLatencies,
      interactions,
      skill: skillNames[0] || undefined,
      skills: skillNames.length > 0 ? skillNames : undefined,
      parent_session_id: startEvent?.payload?.parent_session_id || startEvent?.parent_id || '',
      subagent: startEvent?.kind === 'agent.subagent.start',
      sub_sessions: [],
      skill_calls: skillCalls.map(s => {
        const startEvent_ = toolCalls.find(ts => ts.trace_id === s.trace_id)
        return {
          skillName: s.payload?.skillName || startEvent_?.payload?.skillName || s.payload?.toolName || '',
          toolType: 'skill',
          error: !!s.payload?.error,
        }
      }),
      model_sequence: modelSeq,
      model_switched: modelSeq.length > 1,
      llm_details: llmCalls.map(l => ({
        model: l.payload?.model || '',
        provider: l.payload?.provider || '',
        promptTokens: l.payload?.promptTokens || 0,
        completionTokens: l.payload?.completionTokens || 0,
        latencyMs: l.payload?.latencyMs || 0,
      })),
      mcp_calls: toolResults.filter(t => t.payload?.toolType === 'mcp' || toolCalls.find(s => s.trace_id === t.trace_id)?.payload?.toolType === 'mcp').map(t => {
        const startCall = toolCalls.find(s => s.trace_id === t.trace_id)
        return {
          toolName: t.payload?.toolName || startCall?.payload?.toolName || '',
          serverName: t.payload?.mcpServerName || startCall?.payload?.mcpServerName || 'trae',
          params: startCall?.payload?.toolInput || null,
          latency: toolLatencies[t.trace_id || ''] || 0,
          error: !!t.payload?.error,
        }
      }),
    }

}
  private async postJson(host: string, apiKey: string, payload: any): Promise<UploadResult> {
    const base = (host.match(/^https?:\/\//) ? host : `http://${host}`).replace(/\/+$/, '')
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

    // Fast-skip: exit if no spool file changed since last scan (~5ms when idle)
    let newestMtime = 0
    const files = this.spoolReader.listJsonlFiles()
    for (const f of files) {
      try { const s = fs.statSync(f); if (s.mtimeMs > newestMtime) newestMtime = s.mtimeMs } catch {}
    }
    if (newestMtime > 0 && newestMtime <= this.lastScanMtime) {
      return
    }
    this.lastScanMtime = Math.max(newestMtime, Date.now())
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
      const allEvents: SpoolEvent[] = [state.start, ...state.prompts, ...state.tools, ...state.ends, ...state.llms].filter((e): e is SpoolEvent => e !== null)
      if (allEvents.length === 0) continue
      
      // Skip sessions without content
      if (state.prompts.length === 0 && state.ends.length === 0) continue
      
      const sig = this.buildSignature(allEvents, state)
      if (ckpt[sessionId]?.signature === sig) continue
      this.inFlight.add(sessionId)
      const payload = this.buildPayload(sessionId, allEvents, state)
      // Enrich with subagent relationships
      if (state.subSessions.length > 0) {
        payload.sub_sessions = state.subSessions
      }
      if (state.modelSequence.length > 0) {
        payload.model_sequence = state.modelSequence
        payload.model_switched = state.modelSequence.length > 1
      }

      let lastError = ''
      let success = false
      // AC23: 连续3次失败后进入指数退避
      const useBackoff = this.consecutiveFailures >= 3
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        if (attempt > 1) {
          // AC23: 指数退避重试，带随机抖动
          let delayMs = baseDelayMs * Math.pow(2, attempt - 2)
          if (useBackoff) {
            // 连续失败后使用更长的退避
            delayMs = Math.min(delayMs * Math.pow(2, this.consecutiveFailures), this.maxBackoffMs)
          }
          // 添加随机抖动避免惊群效应
          const jitter = Math.random() * delayMs * 0.1
          delayMs = delayMs + jitter
          this.log(`retry ${attempt}/${maxRetries} for ${sessionId} after ${Math.round(delayMs)}ms${useBackoff ? ' [backoff]' : ''}`)
          await new Promise(r => setTimeout(r, delayMs))
        }
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
