import type { SpoolEvent } from "../../scripts/trae-collector/src/uploader/spool"

// ============================================================================
// AC5: Agent Session Trace 测试数据
// ============================================================================
export const traeAgentSessionStart: SpoolEvent = {
  t: "2024-01-01T00:00:00.000Z",
  kind: "agent.session.start",
  sessionID: "session-123",
  trace_id: "trace-123",
  parent_id: "",
  agent_id: "trae-agent",
  agent_type: "trae",
  payload: {
    source: "agent",
    pid: 12345,
    cwd: "/home/user/project",
    workspace_roots: ["/home/user/project"],
  },
}

export const traeAgentPrompt: SpoolEvent = {
  t: "2024-01-01T00:00:01.000Z",
  kind: "agent.prompt",
  sessionID: "session-123",
  trace_id: "trace-123",
  parent_id: "",
  payload: {
    query: "Write a hello world program",
    length: 30,
    cwd: "/home/user/project",
  },
}

export const traeAgentResponse: SpoolEvent = {
  t: "2024-01-01T00:00:10.000Z",
  kind: "agent.response",
  sessionID: "session-123",
  trace_id: "trace-123",
  parent_id: "",
  payload: {
    finalResult: "Here's your hello world program...",
    latencyMs: 9000,
  },
}

// ============================================================================
// AC6/AC7: Subagent Trace 测试数据
// ============================================================================
export const traeSubagentStart: SpoolEvent = {
  t: "2024-01-01T00:00:02.000Z",
  kind: "agent.subagent.start",
  sessionID: "subsession-456",
  trace_id: "trace-456",
  parent_id: "trace-123",
  agent_id: "trae-subagent",
  agent_type: "trae-sub",
  payload: {
    source: "subagent",
    pid: 12346,
    parent_session_id: "session-123",
    subagent: true,
  },
}

export const traeSubagentResponse: SpoolEvent = {
  t: "2024-01-01T00:00:08.000Z",
  kind: "agent.response",
  sessionID: "subsession-456",
  trace_id: "trace-456",
  parent_id: "trace-123",
  payload: {
    finalResult: "Subagent task completed",
    latencyMs: 6000,
  },
}

// ============================================================================
// AC8/AC9: Skill Call Trace 测试数据
// ============================================================================
export const traeSkillCallStart: SpoolEvent = {
  t: "2024-01-01T00:00:03.000Z",
  kind: "skill.call.start",
  sessionID: "session-123",
  trace_id: "skill-789",
  parent_id: "trace-123",
  skill_name: "code-review",
  skill_version: "1.2.0",
  trigger_mode: "auto",
  payload: {
    skillName: "code-review",
    skillVersion: "1.2.0",
    triggerMode: "auto",
    params: { file: "src/main.ts", reviewMode: "deep" },
  },
}

export const traeSkillCallEnd: SpoolEvent = {
  t: "2024-01-01T00:00:05.000Z",
  kind: "skill.call.end",
  sessionID: "session-123",
  trace_id: "skill-789",
  parent_id: "trace-123",
  skill_name: "code-review",
  skill_version: "1.2.0",
  trigger_mode: "auto",
  payload: {
    skillName: "code-review",
    skillVersion: "1.2.0",
    triggerMode: "auto",
    params: { file: "src/main.ts", reviewMode: "deep" },
    result: { issues: 3, suggestions: ["Add error handling", "Simplify logic"] },
    latencyMs: 2000,
  },
}

// ============================================================================
// AC10/AC11/AC12: Tool Call Trace 测试数据
// ============================================================================
export const traeToolCallStart: SpoolEvent = {
  t: "2024-01-01T00:00:04.000Z",
  kind: "tool.call.start",
  sessionID: "session-123",
  trace_id: "tool-abc",
  parent_id: "trace-123",
  payload: {
    toolName: "Write",
    toolType: "file_write",
    llm_tool_name: "WriteFile",
    toolUseId: "call_001",
    cwd: "/home/user/project",
    toolInput: { file: "src/hello.ts", content: "console.log('Hello World')" },
  },
}

export const traeToolCallEnd: SpoolEvent = {
  t: "2024-01-01T00:00:04.500Z",
  kind: "tool.call.end",
  sessionID: "session-123",
  trace_id: "tool-abc",
  parent_id: "trace-123",
  payload: {
    toolName: "Write",
    toolType: "file_write",
    llm_tool_name: "WriteFile",
    toolUseId: "call_001",
    toolInput: { file: "src/hello.ts", content: "console.log('Hello World')" },
    toolOutput: { success: true, bytesWritten: 32 },
    latencyMs: 500,
    exitCode: 0,
  },
}

export const traeToolCallError: SpoolEvent = {
  t: "2024-01-01T00:00:06.000Z",
  kind: "tool.call.end",
  sessionID: "session-123",
  trace_id: "tool-def",
  parent_id: "trace-123",
  payload: {
    toolName: "RunCommand",
    toolType: "terminal",
    llm_tool_name: "Execute",
    toolUseId: "call_002",
    toolInput: { command: "npm run build", cwd: "/home/user/project" },
    toolOutput: null,
    latencyMs: 1500,
    exitCode: 1,
    error: "Build failed: syntax error",
  },
}

// ============================================================================
// AC14/AC15/AC16: LLM Call Trace 测试数据
// ============================================================================
export const traeLlmCallFirst: SpoolEvent = {
  t: "2024-01-01T00:00:01.500Z",
  kind: "llm.call",
  sessionID: "session-123",
  trace_id: "trace-123",
  parent_id: "",
  model_name: "gpt-4o",
  provider: "openai",
  payload: {
    model: "gpt-4o",
    provider: "openai",
    promptTokens: 100,
    completionTokens: 50,
    tokens: 150,
    totalTokens: 150,
    latencyMs: 2000,
    modelSwitched: false,
  },
}

export const traeLlmCallSwitched: SpoolEvent = {
  t: "2024-01-01T00:00:07.000Z",
  kind: "llm.call",
  sessionID: "session-123",
  trace_id: "trace-123",
  parent_id: "",
  model_name: "claude-3-5-sonnet",
  provider: "anthropic",
  payload: {
    model: "claude-3-5-sonnet",
    provider: "anthropic",
    promptTokens: 150,
    completionTokens: 80,
    tokens: 230,
    totalTokens: 230,
    latencyMs: 1500,
    modelSwitched: true,
    previousModel: "gpt-4o",
  },
}

// ============================================================================
// AC18/AC19: MCP Call Trace 测试数据
// ============================================================================
export const traeMcpCallStart: SpoolEvent = {
  t: "2024-01-01T00:00:05.500Z",
  kind: "mcp.call.start",
  sessionID: "session-123",
  trace_id: "mcp-xyz",
  parent_id: "trace-123",
  mcp_server_name: "trae",
  mcp_tool_name: "browser_navigate",
  payload: {
    serverName: "trae",
    toolName: "browser_navigate",
    params: { url: "https://example.com" },
  },
}

export const traeMcpCallEnd: SpoolEvent = {
  t: "2024-01-01T00:00:06.500Z",
  kind: "mcp.call.end",
  sessionID: "session-123",
  trace_id: "mcp-xyz",
  parent_id: "trace-123",
  mcp_server_name: "trae",
  mcp_tool_name: "browser_navigate",
  payload: {
    serverName: "trae",
    toolName: "browser_navigate",
    params: { url: "https://example.com" },
    result: { status: "success" },
    latency: 1000,
  },
}

export const traeMcpCallError: SpoolEvent = {
  t: "2024-01-01T00:00:07.500Z",
  kind: "mcp.call.end",
  sessionID: "session-123",
  trace_id: "mcp-err",
  parent_id: "trace-123",
  mcp_server_name: "trae",
  mcp_tool_name: "browser_click",
  payload: {
    serverName: "trae",
    toolName: "browser_click",
    params: { selector: "#nonexistent" },
    error: "Element not found",
    latency: 200,
  },
}

// ============================================================================
// 完整会话事件序列
// ============================================================================
export const traeCompleteSessionEvents: SpoolEvent[] = [
  traeAgentSessionStart,
  traeAgentPrompt,
  traeLlmCallFirst,
  traeSubagentStart,
  traeSkillCallStart,
  traeSkillCallEnd,
  traeToolCallStart,
  traeToolCallEnd,
  traeToolCallError,
  traeMcpCallStart,
  traeMcpCallEnd,
  traeMcpCallError,
  traeLlmCallSwitched,
  traeSubagentResponse,
  traeAgentResponse,
]

// ============================================================================
// AC17: 长内容截断测试数据
// ============================================================================
export const traeLongContentPrompt: SpoolEvent = {
  t: "2024-01-01T00:00:01.000Z",
  kind: "agent.prompt",
  sessionID: "session-long",
  trace_id: "trace-long",
  parent_id: "",
  payload: {
    query: "Write a very long prompt ".repeat(100), // 约 2500 字符
    length: 2500,
  },
}

export const traeLongContentResponse: SpoolEvent = {
  t: "2024-01-01T00:00:10.000Z",
  kind: "agent.response",
  sessionID: "session-long",
  trace_id: "trace-long",
  parent_id: "",
  payload: {
    finalResult: "Here's a very long response ".repeat(100), // 约 3100 字符
    latencyMs: 9000,
  },
}

// ============================================================================
// AC12: 敏感信息脱敏测试数据
// ============================================================================
export const traeSensitiveDataTool: SpoolEvent = {
  t: "2024-01-01T00:00:04.000Z",
  kind: "tool.call.start",
  sessionID: "session-sensitive",
  trace_id: "tool-sensitive",
  parent_id: "trace-sensitive",
  payload: {
    toolName: "RunCommand",
    toolType: "terminal",
    toolInput: {
      command: "curl -H 'Authorization: Bearer sk-xxxxxxxxxxxxxxxxxxxxxxxx' https://api.example.com",
      env: {
        API_KEY: "secret-api-key-12345",
        DB_PASSWORD: "supersecret",
      },
    },
  },
}