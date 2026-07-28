import test from "node:test"
import assert from "node:assert/strict"
import * as os from "os"
import * as fs from "fs"
import * as path from "path"
import { SpoolReader, SessionState } from "../scripts/trae-collector/src/uploader/spool"
import {
  traeAgentSessionStart,
  traeAgentPrompt,
  traeAgentResponse,
  traeSubagentStart,
  traeSubagentResponse,
  traeSkillCallStart,
  traeSkillCallEnd,
  traeToolCallStart,
  traeToolCallEnd,
  traeToolCallError,
  traeLlmCallFirst,
  traeLlmCallSwitched,
  traeMcpCallStart,
  traeMcpCallEnd,
  traeMcpCallError,
  traeCompleteSessionEvents,
} from "./fixtures/trae-collector-fixtures"

let tempDir: string

test.before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trae-spool-test-"))
})

test.after(() => {
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true })
  }
})

// ============================================================================
// AC5: Agent Session Trace 采集测试
// ============================================================================
test("AC5: builds session state from agent session events", () => {
  const events = [traeAgentSessionStart, traeAgentPrompt, traeAgentResponse]
  const reader = new SpoolReader(tempDir)
  const sessions = reader.buildSessionState(events)

  assert.equal(sessions.size, 1)
  const state = sessions.get("session-123")!
  assert.ok(state.start)
  assert.equal(state.start!.kind, "agent.session.start")
  assert.equal(state.prompts.length, 1)
  assert.equal(state.ends.length, 1)
  assert.equal(state.prompts[0].payload.query, "Write a hello world program")
  assert.ok(state.ends[0].payload.finalResult)
})

// ============================================================================
// AC6/AC7: Subagent Trace 采集测试
// ============================================================================
test("AC6/AC7: correctly links subagent to parent session", () => {
  const events = [traeAgentSessionStart, traeSubagentStart, traeSubagentResponse, traeAgentResponse]
  const reader = new SpoolReader(tempDir)
  const sessions = reader.buildSessionState(events)

  assert.equal(sessions.size, 2)
  
  const parent = sessions.get("session-123")!
  const child = sessions.get("subsession-456")!
  
  assert.equal(child.subagentOf, "session-123")
  assert.ok(parent.subSessions.includes("subsession-456"))
  assert.equal(child.start!.kind, "agent.subagent.start")
  assert.equal(child.start!.payload.subagent, true)
})

// ============================================================================
// AC8/AC9: Skill Call Trace 采集测试
// ============================================================================
test("AC8/AC9: collects skill call events", () => {
  const events = [traeAgentSessionStart, traeSkillCallStart, traeSkillCallEnd, traeAgentResponse]
  const reader = new SpoolReader(tempDir)
  const sessions = reader.buildSessionState(events)

  const state = sessions.get("session-123")!
  assert.equal(state.skills.length, 2)
  
  const start = state.skills.find(e => e.kind === "skill.call.start")!
  const end = state.skills.find(e => e.kind === "skill.call.end")!
  
  assert.equal(start.payload.skillName, "code-review")
  assert.equal(start.payload.skillVersion, "1.2.0")
  assert.equal(start.payload.triggerMode, "auto")
  assert.deepEqual(start.payload.params, { file: "src/main.ts", reviewMode: "deep" })
  
  assert.ok(end.payload.result)
  assert.equal(end.payload.latencyMs, 2000)
})

// ============================================================================
// AC10/AC11/AC12: Tool Call Trace 采集测试
// ============================================================================
test("AC10/AC11/AC12: collects tool call events with types and error info", () => {
  const events = [traeAgentSessionStart, traeToolCallStart, traeToolCallEnd, traeToolCallError, traeAgentResponse]
  const reader = new SpoolReader(tempDir)
  const sessions = reader.buildSessionState(events)

  const state = sessions.get("session-123")!
  assert.equal(state.tools.length, 3)
  
  const successToolStart = state.tools.find(t => t.trace_id === "tool-abc" && t.kind === "tool.call.start")!
  const successToolEnd = state.tools.find(t => t.trace_id === "tool-abc" && t.kind === "tool.call.end")!
  assert.equal(successToolStart.payload.toolName, "Write")
  assert.equal(successToolStart.payload.toolType, "file_write")
  assert.equal(successToolStart.payload.llm_tool_name, "WriteFile")
  assert.equal(successToolStart.payload.toolUseId, "call_001")
  assert.equal(successToolEnd.payload.exitCode, 0)
  
  const errorTool = state.tools.find(t => t.trace_id === "tool-def")!
  assert.equal(errorTool.payload.toolName, "RunCommand")
  assert.equal(errorTool.payload.toolType, "terminal")
  assert.equal(errorTool.payload.exitCode, 1)
  assert.equal(errorTool.payload.error, "Build failed: syntax error")
})

// ============================================================================
// AC14/AC15/AC16: LLM Call Trace 采集测试
// ============================================================================
test("AC14/AC15/AC16: collects LLM calls with model switching detection", () => {
  const events = [traeAgentSessionStart, traeLlmCallFirst, traeLlmCallSwitched, traeAgentResponse]
  const reader = new SpoolReader(tempDir)
  const sessions = reader.buildSessionState(events)

  const state = sessions.get("session-123")!
  assert.equal(state.llms.length, 2)
  assert.equal(state.modelSequence.length, 2)
  assert.ok(state.modelSequence.includes("gpt-4o"))
  assert.ok(state.modelSequence.includes("claude-3-5-sonnet"))
  
  const firstLlm = state.llms.find(l => l.payload.model === "gpt-4o")!
  assert.equal(firstLlm.payload.provider, "openai")
  assert.equal(firstLlm.payload.promptTokens, 100)
  assert.equal(firstLlm.payload.completionTokens, 50)
  assert.equal(firstLlm.payload.totalTokens, 150)
  assert.equal(firstLlm.payload.modelSwitched, false)
  
  const switchedLlm = state.llms.find(l => l.payload.model === "claude-3-5-sonnet")!
  assert.equal(switchedLlm.payload.provider, "anthropic")
  assert.equal(switchedLlm.payload.modelSwitched, true)
  assert.equal(switchedLlm.payload.previousModel, "gpt-4o")
})

// ============================================================================
// AC18/AC19: MCP Call Trace 采集测试
// ============================================================================
test("AC18/AC19: collects MCP calls with error handling", () => {
  const events = [traeAgentSessionStart, traeMcpCallStart, traeMcpCallEnd, traeMcpCallError, traeAgentResponse]
  const reader = new SpoolReader(tempDir)
  const sessions = reader.buildSessionState(events)

  const state = sessions.get("session-123")!
  assert.equal(state.mcps.length, 3)
  
  const successMcpStart = state.mcps.find(m => m.trace_id === "mcp-xyz" && m.kind === "mcp.call.start")!
  const successMcpEnd = state.mcps.find(m => m.trace_id === "mcp-xyz" && m.kind === "mcp.call.end")!
  assert.equal(successMcpStart.payload.serverName, "trae")
  assert.equal(successMcpStart.payload.toolName, "browser_navigate")
  assert.equal(successMcpEnd.payload.latency, 1000)
  assert.ok(successMcpEnd.payload.result)
  
  const errorMcp = state.mcps.find(m => m.trace_id === "mcp-err")!
  assert.equal(errorMcp.payload.toolName, "browser_click")
  assert.equal(errorMcp.payload.error, "Element not found")
})

// ============================================================================
// AC33: 父子 Trace 关联关系测试
// ============================================================================
test("AC33: parent-child trace relationships are correct", () => {
  const reader = new SpoolReader(tempDir)
  const sessions = reader.buildSessionState(traeCompleteSessionEvents)

  const parent = sessions.get("session-123")!
  const child = sessions.get("subsession-456")!
  
  // 验证子 Agent 关联
  assert.equal(child.subagentOf, "session-123")
  assert.ok(parent.subSessions.includes("subsession-456"))
  
  // 验证 Skill 关联
  const skillStart = parent.skills.find(s => s.kind === "skill.call.start")!
  assert.equal(skillStart.parent_id, "trace-123")
  
  // 验证 Tool 关联
  const toolStart = parent.tools.find(t => t.kind === "tool.call.start")!
  assert.equal(toolStart.parent_id, "trace-123")
  
  // 验证 MCP 关联
  const mcpStart = parent.mcps.find(m => m.kind === "mcp.call.start")!
  assert.equal(mcpStart.parent_id, "trace-123")
})

// ============================================================================
// 完整会话测试
// ============================================================================
test("builds complete session state with all event types", () => {
  const reader = new SpoolReader(tempDir)
  const sessions = reader.buildSessionState(traeCompleteSessionEvents)

  assert.equal(sessions.size, 2) // 主会话 + 子会话
  
  const mainSession = sessions.get("session-123")!
  assert.equal(mainSession.start!.kind, "agent.session.start")
  assert.equal(mainSession.prompts.length, 1)
  assert.equal(mainSession.ends.length, 1)
  assert.equal(mainSession.tools.length, 3)
  assert.equal(mainSession.llms.length, 2)
  assert.equal(mainSession.skills.length, 2)
  assert.equal(mainSession.mcps.length, 3)
  assert.equal(mainSession.subSessions.length, 1)
  assert.equal(mainSession.modelSequence.length, 2)
})

// ============================================================================
// 边界测试: 空数据 / 损坏数据 / 缺失事件
// ============================================================================
test("handles empty events list gracefully", () => {
  const reader = new SpoolReader(tempDir)
  const sessions = reader.buildSessionState([])
  assert.equal(sessions.size, 0)
})

test("handles empty spool directory", () => {
  const emptyDir = path.join(tempDir, "empty-dir")
  fs.mkdirSync(emptyDir, { recursive: true })
  const reader = new SpoolReader(emptyDir)
  assert.equal(reader.listJsonlFiles().length, 0)
})

test("handles corrupt JSONL lines without crashing", () => {
  const corruptDir = path.join(tempDir, "corrupt-test")
  fs.mkdirSync(corruptDir, { recursive: true })
  const corruptFile = path.join(corruptDir, "corrupt.jsonl")
  fs.writeFileSync(corruptFile, [
    "valid line 1",
    '{invalid json here',
    "valid line 3",
    "null",
    "",
  ].join("\n"))

  const reader = new SpoolReader(corruptDir)
  // readEvents silently skips unparseable lines
  const events = reader.readEvents(corruptFile)
  assert.equal(events.length, 0, "all lines are invalid JSON, should return empty")
})

test("buildSessionState skips events with empty sessionID", () => {
  const events: any[] = [
    { t: "2024-01-01T00:00:00Z", kind: "agent.session.start", sessionID: "s1", payload: {} },
    { t: "2024-01-01T00:00:01Z", kind: "orphan", sessionID: "", payload: {} },
    { t: "2024-01-01T00:00:02Z", kind: "agent.prompt", sessionID: "s1", payload: { query: "hi" } },
  ]
  const reader = new SpoolReader(tempDir)
  const sessions = reader.buildSessionState(events)
  assert.equal(sessions.size, 1)
  assert.equal(sessions.get("s1")!.prompts.length, 1)
})

test("session with prompts but no responses has zero ends", () => {
  const events: any[] = [
    { t: "2024-01-01T00:00:00Z", kind: "agent.session.start", sessionID: "s-early", trace_id: "t1", payload: {} },
    { t: "2024-01-01T00:00:01Z", kind: "agent.prompt", sessionID: "s-early", trace_id: "t1", payload: { query: "help" } },
  ]
  const reader = new SpoolReader(tempDir)
  const sessions = reader.buildSessionState(events)
  const state = sessions.get("s-early")!
  assert.equal(state.prompts.length, 1)
  assert.equal(state.ends.length, 0)
  assert.equal(state.events.length, 2)
})