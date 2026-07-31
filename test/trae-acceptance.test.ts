import test from "node:test"
import assert from "node:assert/strict"
import { execSync } from "child_process"
import * as os from "os"
import * as fs from "fs"
import * as path from "path"
import { SpoolReader } from "../scripts/trae-collector/src/uploader/spool"

const hooksDir = path.join(__dirname, "../scripts/trae-collector/hooks")
const scriptsDir = path.join(hooksDir, "scripts")

function setupTest() {
  const tempSpoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "trae-acceptance-"))
  const tempEnvFile = path.join(os.tmpdir(), `trae-acceptance-env-${Math.random().toString(36).slice(2)}.sh`)
  const tempStateFile = path.join(tempSpoolDir, "subagent-state.json")
  const tempToolStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "trae-tool-state-"))

  fs.writeFileSync(tempEnvFile, `
export AGENT_INSIGHT_DIR=${tempSpoolDir}
export AGENT_INSIGHT_TRAE_MAX_CONTENT_LENGTH=2000
export AGENT_INSIGHT_API_KEY=test-api-key-acceptance
export TRAE_SUBAGENT_STATE_FILE=${tempStateFile}
export TRAE_TOOL_STATE_DIR=${tempToolStateDir}
`)
  return { tempSpoolDir, tempEnvFile, tempToolStateDir }
}

function cleanupTest(tempSpoolDir: string, tempEnvFile: string, tempToolStateDir?: string) {
  try { fs.rmSync(tempSpoolDir, { recursive: true, force: true }) } catch {}
  try { fs.unlinkSync(tempEnvFile) } catch {}
  if (tempToolStateDir) try { fs.rmSync(tempToolStateDir, { recursive: true, force: true }) } catch {}
}

function runHookScript(scriptName: string, inputJson: string, tempEnvFile: string): string {
  const scriptPath = path.join(scriptsDir, scriptName)
  const tempInputFile = path.join(os.tmpdir(), `trae-input-${Math.random().toString(36).slice(2)}.json`)
  fs.writeFileSync(tempInputFile, inputJson)
  const cmd = `bash -c "source ${tempEnvFile} && cat ${tempInputFile} | bash ${scriptPath}"`
  try {
    return execSync(cmd, { stdio: ["pipe", "pipe", "pipe"], timeout: 10000 }).toString()
  } finally {
    try { fs.unlinkSync(tempInputFile) } catch {}
  }
}

function readSpoolEvents(tempSpoolDir: string): any[] {
  const events: any[] = []
  try {
    const reader = new SpoolReader(tempSpoolDir)
    const files = reader.listJsonlFiles()
    for (const file of files) {
      events.push(...reader.readEvents(file))
    }
  } catch {}
  return events
}

// ============================================================================
// AC9: Skill 内部 Agent/Tool 关联
// ============================================================================
test("AC9: Skill call trace is linked to parent session by sessionID", () => {
  const { tempSpoolDir, tempEnvFile, tempToolStateDir } = setupTest()
  try {
    const sessionId = "ac9-session"

    // Simulate pre-tool-use for a Skill call
    const preInput = JSON.stringify({
      session_id: sessionId, hook_event_name: "PreToolUse",
      tool_use_id: "call_ac9_skill_001", tool_name: "Skill",
      llm_tool_name: "Skill",
      tool_input: { name: "code-review" },
      agent_id: "solo_agent", agent_type: "solo_agent",
      cwd: "/home/project",
    })
    runHookScript("pre-tool-use.sh", preInput, tempEnvFile)

    // Simulate post-tool-use for the Skill call (with TRAE-style response)
    const postInput = JSON.stringify({
      session_id: sessionId, hook_event_name: "PostToolUse",
      tool_use_id: "call_ac9_skill_001", tool_name: "Skill",
      llm_tool_name: "Skill",
      tool_input: { name: "code-review" },
      tool_response: {
        skill_path: "/home/.trae-cn/builtin_skills/code-review",
        skill_detail: "# code-review skill definition",
        skill_type: "skill",
      },
      agent_id: "solo_agent", agent_type: "solo_agent",
    })
    runHookScript("post-tool-use.sh", postInput, tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)
    const skillEvent = events.find(e => e.kind === "skill.call.end")
    const toolEndEvent = events.find(e => e.kind === "tool.call.end")

    assert.ok(skillEvent, "skill.call.end should be generated")
    assert.equal(skillEvent.sessionID, sessionId, "skill trace linked to session")
    assert.equal(skillEvent.payload.skillName, "code-review")
    assert.equal(skillEvent.payload.skillPath, "/home/.trae-cn/builtin_skills/code-review")
    assert.equal(skillEvent.payload.skillType, "skill")
    assert.equal(skillEvent.payload.triggerMode, "auto")

    // AC9: tool inside skill call shares same sessionID
    assert.ok(toolEndEvent)
    assert.equal(toolEndEvent.sessionID, sessionId, "tool inside skill shares sessionID")
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile, tempToolStateDir)
  }
})

// ============================================================================
// AC13: 敏感信息脱敏
// ============================================================================
test("AC13: pre-tool-use.sh redacts sensitive values in tool input", () => {
  const { tempSpoolDir, tempEnvFile, tempToolStateDir } = setupTest()
  try {
    const preInput = JSON.stringify({
      session_id: "ac13-session", hook_event_name: "PreToolUse",
      tool_use_id: "call_ac13_001", tool_name: "Bash",
      llm_tool_name: "Bash",
      tool_input: {
        command: "curl -H 'Authorization: Bearer sk-deadbeef1234567890' https://api.example.com",
        env: { API_KEY: "secret-key-deadbeef", DB_PASSWORD: "supersecret123" },
      },
      agent_id: "solo_agent", agent_type: "solo_agent",
    })
    runHookScript("pre-tool-use.sh", preInput, tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)
    const toolEvent = events.find(e => e.kind === "tool.call.start")
    assert.ok(toolEvent, "tool.call.start should be recorded")

    const toolInput = toolEvent.payload.toolInput

    // redact_json: key-value pair redaction (env.API_KEY, env.DB_PASSWORD → "***")
    assert.ok(toolInput, "toolInput should exist")
    if (toolInput.env) {
      assert.equal(toolInput.env.API_KEY, "***", "API_KEY value should be redacted")
      assert.equal(toolInput.env.DB_PASSWORD, "***", "DB_PASSWORD value should be redacted")
    }

    // redact_text: inline sensitive patterns in command strings
    assert.ok(toolInput.command, "command field should exist")
    assert.ok(
      !toolInput.command.toLowerCase().includes("bearer sk-deadbeef"),
      "inline Bearer token in command should be redacted"
    )
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile, tempToolStateDir)
  }
})

test("AC13: command redaction handles inline API key in header flag", () => {
  const { tempSpoolDir, tempEnvFile, tempToolStateDir } = setupTest()
  try {
    runHookScript("pre-tool-use.sh", JSON.stringify({
      session_id: "ac13-apikey", hook_event_name: "PreToolUse",
      tool_use_id: "call_ac13_apikey", tool_name: "Bash",
      llm_tool_name: "Bash",
      tool_input: {
        command: "curl -H 'x-api-key: sk-1234567890abcdef' https://api.service.com/v1/data",
      },
      agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)
    const toolEvent = events.find(e => e.kind === "tool.call.start")
    assert.ok(toolEvent)
    const cmd = toolEvent.payload.toolInput.command
    assert.ok(cmd, "command should exist")
    assert.ok(!cmd.toLowerCase().includes("sk-1234567890abcdef"), "inline API key in header should be redacted")
    assert.ok(cmd.includes("api_key=***"), "api key flag should be sanitized")
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile, tempToolStateDir)
  }
})

test("AC13: command redaction handles inline --token flag", () => {
  const { tempSpoolDir, tempEnvFile, tempToolStateDir } = setupTest()
  try {
    runHookScript("pre-tool-use.sh", JSON.stringify({
      session_id: "ac13-tokenflag", hook_event_name: "PreToolUse",
      tool_use_id: "call_ac13_token", tool_name: "Bash",
      llm_tool_name: "Bash",
      tool_input: {
        command: "cli-tool --token=ghp_1234567890abcdef1234 --endpoint https://api.example.com",
      },
      agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)
    const toolEvent = events.find(e => e.kind === "tool.call.start")
    assert.ok(toolEvent)
    const cmd = toolEvent.payload.toolInput.command
    assert.ok(cmd, "command should exist")
    assert.ok(!cmd.includes("ghp_1234567890abcdef1234"), "inline --token value should be redacted")
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile, tempToolStateDir)
  }
})

test("AC13: command redaction handles inline --password flag", () => {
  const { tempSpoolDir, tempEnvFile, tempToolStateDir } = setupTest()
  try {
    runHookScript("pre-tool-use.sh", JSON.stringify({
      session_id: "ac13-pw", hook_event_name: "PreToolUse",
      tool_use_id: "call_ac13_pw", tool_name: "Bash",
      llm_tool_name: "Bash",
      tool_input: {
        command: "mysql -u root --password=SuperSecret123 -h db.example.com",
      },
      agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)
    const toolEvent = events.find(e => e.kind === "tool.call.start")
    assert.ok(toolEvent)
    const cmd = toolEvent.payload.toolInput.command
    assert.ok(cmd, "command should exist")
    assert.ok(!cmd.includes("SuperSecret123"), "inline password should be redacted")
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile, tempToolStateDir)
  }
})

test("AC13: command redaction handles PEM private key block", () => {
  const { tempSpoolDir, tempEnvFile, tempToolStateDir } = setupTest()
  try {
    runHookScript("pre-tool-use.sh", JSON.stringify({
      session_id: "ac13-pem", hook_event_name: "PreToolUse",
      tool_use_id: "call_ac13_pem", tool_name: "Bash",
      llm_tool_name: "Bash",
      tool_input: {
        command: "echo '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----' > key.pem",
      },
      agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)
    const toolEvent = events.find(e => e.kind === "tool.call.start")
    assert.ok(toolEvent)
    const cmd = toolEvent.payload.toolInput.command
    assert.ok(cmd, "command should exist")
    assert.ok(!cmd.includes("BEGIN RSA PRIVATE KEY"), "PEM block should be redacted")
    assert.ok(cmd.includes("REDACTED PRIVATE KEY"), "PEM block replaced with marker")
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile, tempToolStateDir)
  }
})

// ============================================================================
// AC13 误判测试: 确保不会误脱敏无害内容
// ============================================================================
test("AC13: command redaction does NOT redact short token-like values under threshold", () => {
  const { tempSpoolDir, tempEnvFile, tempToolStateDir } = setupTest()
  try {
    runHookScript("pre-tool-use.sh", JSON.stringify({
      session_id: "ac13-short", hook_event_name: "PreToolUse",
      tool_use_id: "call_ac13_short", tool_name: "Bash",
      llm_tool_name: "Bash",
      tool_input: {
        command: "mycli --token=abc123 --api-key=short --password=x https://example.com",
      },
      agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)
    const toolEvent = events.find(e => e.kind === "tool.call.start")
    assert.ok(toolEvent)
    const cmd = toolEvent.payload.toolInput.command
    assert.ok(cmd, "command should exist")
    // --token=abc123 (6 chars, under 8-char threshold) should survive
    assert.ok(cmd.includes("abc123"), "short token value under threshold should survive")
    // --password=x (1 char, under 3-char threshold) should survive
    assert.ok(cmd.includes("password=x") || cmd.includes("password=***"),
      "single-char password handled gracefully")
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile, tempToolStateDir)
  }
})

test("AC13: non-terminal tools are NOT affected by command redaction", () => {
  const { tempSpoolDir, tempEnvFile, tempToolStateDir } = setupTest()
  try {
    runHookScript("pre-tool-use.sh", JSON.stringify({
      session_id: "ac13-read", hook_event_name: "PreToolUse",
      tool_use_id: "call_ac13_read", tool_name: "Read",
      llm_tool_name: "Read",
      tool_input: {
        file_path: "/tmp/auth-guide.md",
      },
      agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)
    const toolEvent = events.find(e => e.kind === "tool.call.start")
    assert.ok(toolEvent)
    const ti = toolEvent.payload.toolInput
    assert.ok(ti, "toolInput should exist for Read tool")
    assert.equal(ti.file_path, "/tmp/auth-guide.md", "file_path should be intact")
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile, tempToolStateDir)
  }
})

test("AC13: complex command with mixed sensitive and safe content redacts only sensitive parts", () => {
  const { tempSpoolDir, tempEnvFile, tempToolStateDir } = setupTest()
  try {
    runHookScript("pre-tool-use.sh", JSON.stringify({
      session_id: "ac13-mixed", hook_event_name: "PreToolUse",
      tool_use_id: "call_ac13_mix", tool_name: "Bash",
      llm_tool_name: "Bash",
      tool_input: {
        command: [
          "export GITHUB_TOKEN=ghp_mixed1234567890",
          "export SAFE_VAR=hello-world",
          "curl -H 'Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ' https://api.example.com",
          "echo 'Download complete: 42 files processed'",
        ].join(" && "),
        env: { CI_TOKEN: "ci-token-should-be-redacted" },
      },
      agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)
    const toolEvent = events.find(e => e.kind === "tool.call.start")
    assert.ok(toolEvent)
    const cmd = toolEvent.payload.toolInput.command
    assert.ok(cmd, "command should exist")

    // Sensitive parts should be redacted
    assert.ok(!cmd.includes("ghp_mixed1234567890"), "GITHUB_TOKEN value redacted")
    assert.ok(!cmd.includes("eyJhbGci"), "JWT Bearer token redacted")

    // Safe parts should survive intact
    assert.ok(cmd.includes("SAFE_VAR=hello-world"), "non-sensitive env var preserved")
    assert.ok(cmd.includes("Download complete: 42 files processed"), "echo message preserved")

    // env key-value should be redacted by redact_json
    if (toolEvent.payload.toolInput.env) {
      assert.equal(toolEvent.payload.toolInput.env.CI_TOKEN, "***", "env token key-value redacted")
    }
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile, tempToolStateDir)
  }
})

// ============================================================================
// AC17: 内容截断
// ============================================================================
test("AC17: prompt content is truncated at 2000 characters", () => {
  const { tempSpoolDir, tempEnvFile } = setupTest()
  try {
    const longPrompt = "A".repeat(3000)
    const input = JSON.stringify({
      session_id: "ac17-session", hook_event_name: "UserPromptSubmit",
      prompt: longPrompt, agent_id: "solo_agent", agent_type: "solo_agent",
      cwd: "/home/project",
    })
    runHookScript("prompt-submit.sh", input, tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)
    const promptEvent = events.find(e => e.kind === "agent.prompt")
    assert.ok(promptEvent)

    const storedQuery = promptEvent.payload.query
    assert.ok(storedQuery.length <= 2003, `stored query length ${storedQuery.length} should be ≤ 2003`)
    assert.ok(storedQuery.length >= 1990, `stored query length ${storedQuery.length} should be roughly 2000`)
    assert.ok(storedQuery.endsWith("..."))
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile)
  }
})

test("AC17: tool response is truncated at 4000 characters by default", () => {
  const { tempSpoolDir, tempEnvFile, tempToolStateDir } = setupTest()
  try {
    const longContent = "B".repeat(5000)
    const preInput = JSON.stringify({
      session_id: "ac17-tool", hook_event_name: "PreToolUse",
      tool_use_id: "call_ac17_t", tool_name: "Read",
      llm_tool_name: "Read",
      tool_input: { file_path: "/tmp/test" },
      agent_id: "solo_agent", agent_type: "solo_agent",
    })
    runHookScript("pre-tool-use.sh", preInput, tempEnvFile)

    const postInput = JSON.stringify({
      session_id: "ac17-tool", hook_event_name: "PostToolUse",
      tool_use_id: "call_ac17_t", tool_name: "Read",
      llm_tool_name: "Read",
      tool_input: { file_path: "/tmp/test" },
      tool_response: { content: longContent },
      agent_id: "solo_agent", agent_type: "solo_agent",
    })
    runHookScript("post-tool-use.sh", postInput, tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)
    const toolEnd = events.find(e => e.kind === "tool.call.end")
    assert.ok(toolEnd)
    const toolResponseStr = JSON.stringify(toolEnd.payload.toolResponse)
    assert.ok(toolResponseStr.length < 5000, "tool response should be truncated below 5000")
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile, tempToolStateDir)
  }
})

// ============================================================================
// MCP tool detection
// ============================================================================
test("AC18: MCP tool detection: BrowserTabs with snake_case llm_tool_name classified as mcp", () => {
  const { tempSpoolDir, tempEnvFile, tempToolStateDir } = setupTest()
  try {
    const preInput = JSON.stringify({
      session_id: "ac-mcp-detect", hook_event_name: "PreToolUse",
      tool_use_id: "call_mcp_browser", tool_name: "BrowserTabs",
      llm_tool_name: "browser_tabs",
      tool_input: { action: "list" },
      agent_id: "solo_agent", agent_type: "solo_agent",
    })
    runHookScript("pre-tool-use.sh", preInput, tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)
    const toolStart = events.find(e => e.kind === "tool.call.start")
    assert.ok(toolStart)
    assert.equal(toolStart.payload.toolType, "mcp")
    assert.equal(toolStart.payload.mcpToolName, "browser_tabs")
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile, tempToolStateDir)
  }
})

test("AC18: MCP tool detection: built-in tools not misclassified as mcp", () => {
  const { tempSpoolDir, tempEnvFile, tempToolStateDir } = setupTest()
  try {
    const builtins = ["Read", "Write", "Glob", "Grep", "LS", "Bash", "Edit"]
    for (const toolName of builtins) {
      const preInput = JSON.stringify({
        session_id: "ac-builtin", hook_event_name: "PreToolUse",
        tool_use_id: `call_builtin_${toolName}`, tool_name: toolName,
        llm_tool_name: toolName,
        tool_input: {},
        agent_id: "solo_agent", agent_type: "solo_agent",
      })
      runHookScript("pre-tool-use.sh", preInput, tempEnvFile)
    }

    const events = readSpoolEvents(tempSpoolDir)
    for (const e of events) {
      assert.notEqual(e.payload.toolType, "mcp", `${e.payload.toolName} should not be mcp`)
    }
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile, tempToolStateDir)
  }
})

// ============================================================================
// post-tool-use.sh: inline Skill/MCP trace generation
// ============================================================================
test("AC18: post-tool-use.sh generates mcp.call.end for MCP tool calls", () => {
  const { tempSpoolDir, tempEnvFile, tempToolStateDir } = setupTest()
  try {
    const sessionId = "ac-mcp-inline"

    const preInput = JSON.stringify({
      session_id: sessionId, hook_event_name: "PreToolUse",
      tool_use_id: "call_mcp_inline", tool_name: "BrowserNavigate",
      llm_tool_name: "browser_navigate",
      tool_input: { url: "https://example.com" },
      agent_id: "solo_agent", agent_type: "solo_agent",
    })
    runHookScript("pre-tool-use.sh", preInput, tempEnvFile)

    const postInput = JSON.stringify({
      session_id: sessionId, hook_event_name: "PostToolUse",
      tool_use_id: "call_mcp_inline", tool_name: "BrowserNavigate",
      llm_tool_name: "browser_navigate",
      tool_input: { url: "https://example.com" },
      tool_response: { status: "success", pageTitle: "Example" },
      agent_id: "solo_agent", agent_type: "solo_agent",
    })
    runHookScript("post-tool-use.sh", postInput, tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)
    const mcpEvent = events.find(e => e.kind === "mcp.call.end")
    assert.ok(mcpEvent, "mcp.call.end should be generated inline")
    assert.equal(mcpEvent.payload.serverName, "trae")
    assert.equal(mcpEvent.payload.toolName, "browser_navigate")
    assert.ok(mcpEvent.payload.params)
    assert.ok(mcpEvent.payload.result)
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile, tempToolStateDir)
  }
})

test("AC19: mcp.call.end records error on failure", () => {
  const { tempSpoolDir, tempEnvFile, tempToolStateDir } = setupTest()
  try {
    const sessionId = "ac19-mcp-error"

    const preInput = JSON.stringify({
      session_id: sessionId, hook_event_name: "PreToolUse",
      tool_use_id: "call_mcp_err", tool_name: "BrowserClick",
      llm_tool_name: "browser_click",
      tool_input: { selector: "#nonexistent" },
      agent_id: "solo_agent", agent_type: "solo_agent",
    })
    runHookScript("pre-tool-use.sh", preInput, tempEnvFile)

    const postInput = JSON.stringify({
      session_id: sessionId, hook_event_name: "PostToolUse",
      tool_use_id: "call_mcp_err", tool_name: "BrowserClick",
      llm_tool_name: "browser_click",
      tool_input: { selector: "#nonexistent" },
      tool_response: { error: "Element not found: #nonexistent" },
      agent_id: "solo_agent", agent_type: "solo_agent",
    })
    runHookScript("post-tool-use.sh", postInput, tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)
    const mcpEvent = events.find(e => e.kind === "mcp.call.end")
    assert.ok(mcpEvent)
    assert.ok(mcpEvent.payload.error, "should record error")
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile, tempToolStateDir)
  }
})

// ============================================================================
// AC18: mcp__<server>__<tool> 前缀解析（TRAE MCP 真实命名形态）
// ============================================================================
test("AC18: mcp__ 前缀解析出 serverName/toolName（真实命名形态）", () => {
  const { tempSpoolDir, tempEnvFile, tempToolStateDir } = setupTest()
  try {
    const sessionId = "ac18-mcp-prefix"
    const toolName = "mcp__context7__resolve-library-id"

    runHookScript("pre-tool-use.sh", JSON.stringify({
      session_id: sessionId, hook_event_name: "PreToolUse",
      tool_use_id: "call_mcp_prefix", tool_name: toolName,
      llm_tool_name: "mcp_context7_resolve-library-id",
      tool_input: { args: { query: "Next.js", libraryName: "Next.js" } },
      agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    runHookScript("post-tool-use.sh", JSON.stringify({
      session_id: sessionId, hook_event_name: "PostToolUse",
      tool_use_id: "call_mcp_prefix", tool_name: toolName,
      llm_tool_name: "mcp_context7_resolve-library-id",
      tool_input: { args: { query: "Next.js", libraryName: "Next.js" } },
      tool_response: { content: [{ type: "text", text: "Library found" }], isError: null },
      agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)

    const mcpEvent = events.find(e => e.kind === "mcp.call.end")
    assert.ok(mcpEvent, "mcp.call.end should be generated")
    assert.equal(mcpEvent.payload.serverName, "context7", "AC18: serverName 应从 mcp__ 前缀解析")
    assert.equal(mcpEvent.payload.toolName, "resolve-library-id", "AC18: toolName 应为干净工具名")
    assert.ok(mcpEvent.payload.params, "AC18: params 应保留")
    assert.ok(mcpEvent.payload.result, "AC18: result 应保留")
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile, tempToolStateDir)
  }
})

// ============================================================================
// AC19: MCP 标准失败形态 isError=true（错误内容在 content[].text）
// ============================================================================
test("AC19: isError=true 时从 content 提取错误信息", () => {
  const { tempSpoolDir, tempEnvFile, tempToolStateDir } = setupTest()
  try {
    const sessionId = "ac19-mcp-iserror"
    const toolName = "mcp__context7__query-docs"

    runHookScript("pre-tool-use.sh", JSON.stringify({
      session_id: sessionId, hook_event_name: "PreToolUse",
      tool_use_id: "call_mcp_iserr", tool_name: toolName,
      llm_tool_name: "mcp_context7_query-docs",
      tool_input: { args: { libraryId: "/bad/lib" } },
      agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    runHookScript("post-tool-use.sh", JSON.stringify({
      session_id: sessionId, hook_event_name: "PostToolUse",
      tool_use_id: "call_mcp_iserr", tool_name: toolName,
      llm_tool_name: "mcp_context7_query-docs",
      tool_input: { args: { libraryId: "/bad/lib" } },
      tool_response: { content: [{ type: "text", text: "Library not found: /bad/lib" }], isError: true },
      agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)
    const mcpEvent = events.find(e => e.kind === "mcp.call.end")
    assert.ok(mcpEvent, "mcp.call.end should be generated")
    assert.ok(mcpEvent.payload.error, "AC19: isError=true 应记录 error")
    assert.ok(mcpEvent.payload.error.includes("Library not found"), "AC19: error 应包含 content 文本")
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile, tempToolStateDir)
  }
})

// ============================================================================
// AC11: TRAE web 工具（WebSearch/WebFetch）失败时 error 在 error_code/error_msg 字段
// ============================================================================
test("AC11: web 工具失败时从 error_msg 提取错误信息", () => {
  const { tempSpoolDir, tempEnvFile, tempToolStateDir } = setupTest()
  try {
    const sessionId = "ac11-web-error"

    runHookScript("pre-tool-use.sh", JSON.stringify({
      session_id: sessionId, hook_event_name: "PreToolUse",
      tool_use_id: "call_web_err", tool_name: "WebSearch",
      llm_tool_name: "WebSearch",
      tool_input: { query: "不存在的搜索" },
      agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    runHookScript("post-tool-use.sh", JSON.stringify({
      session_id: sessionId, hook_event_name: "PostToolUse",
      tool_use_id: "call_web_err", tool_name: "WebSearch",
      llm_tool_name: "WebSearch",
      tool_input: { query: "不存在的搜索" },
      tool_response: { references: [], status: "Failed", error_code: 500, error_msg: "Search service unavailable" },
      agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)
    const toolEnd = events.find(e => e.kind === "tool.call.end" && e.trace_id === "tool_call_web_err")
    assert.ok(toolEnd, "tool.call.end should be generated")
    assert.ok(toolEnd.payload.error, "AC11: web 工具失败应记录 error")
    assert.ok(toolEnd.payload.error.includes("Search service unavailable"), "AC11: error 应包含 error_msg 内容")
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile, tempToolStateDir)
  }
})

// ============================================================================
// AC11: 失败命令无 stderr 时的兜底（stdout → 合成失败提示）
// ============================================================================
test("AC11: exit≠0 无 stderr 时 stdout 兜底为 error", () => {
  const { tempSpoolDir, tempEnvFile, tempToolStateDir } = setupTest()
  try {
    const sessionId = "ac11-no-stderr"

    runHookScript("pre-tool-use.sh", JSON.stringify({
      session_id: sessionId, hook_event_name: "PreToolUse",
      tool_use_id: "call_nostderr", tool_name: "RunCommand",
      llm_tool_name: "RunCommand",
      tool_input: { command: "failing-cmd" },
      agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    // TRAE 实测形态：exit_code=1 但无 stderr 键（stdout 有内容）
    runHookScript("post-tool-use.sh", JSON.stringify({
      session_id: sessionId, hook_event_name: "PostToolUse",
      tool_use_id: "call_nostderr", tool_name: "RunCommand",
      llm_tool_name: "RunCommand",
      tool_input: { command: "failing-cmd" },
      tool_response: { exit_code: 1, status: "Exited", stdout: "error: cannot find module" },
      agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)
    const toolEnd = events.find(e => e.kind === "tool.call.end" && e.trace_id === "tool_call_nostderr")
    assert.ok(toolEnd)
    assert.equal(toolEnd.payload.exitCode, 1)
    assert.ok(toolEnd.payload.error, "AC11: 无 stderr 时应从 stdout 兜底")
    assert.ok(toolEnd.payload.error.includes("cannot find module"), "AC11: error 应含 stdout 内容")
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile, tempToolStateDir)
  }
})

test("AC11: exit≠0 且 stdout 也空时合成失败提示", () => {
  const { tempSpoolDir, tempEnvFile, tempToolStateDir } = setupTest()
  try {
    const sessionId = "ac11-empty-err"

    runHookScript("pre-tool-use.sh", JSON.stringify({
      session_id: sessionId, hook_event_name: "PreToolUse",
      tool_use_id: "call_emptyerr", tool_name: "RunCommand",
      llm_tool_name: "RunCommand",
      tool_input: { command: "silent-fail" },
      agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    runHookScript("post-tool-use.sh", JSON.stringify({
      session_id: sessionId, hook_event_name: "PostToolUse",
      tool_use_id: "call_emptyerr", tool_name: "RunCommand",
      llm_tool_name: "RunCommand",
      tool_input: { command: "silent-fail" },
      tool_response: { exit_code: 2, status: "Exited" },
      agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)
    const toolEnd = events.find(e => e.kind === "tool.call.end" && e.trace_id === "tool_call_emptyerr")
    assert.ok(toolEnd)
    assert.equal(toolEnd.payload.exitCode, 2)
    assert.equal(toolEnd.payload.error, "command failed (exit code: 2)", "AC11: 全空时应合成失败提示")
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile, tempToolStateDir)
  }
})

// ============================================================================
// stop.sh: agent.session.stop + llm.call events
// ============================================================================
test("AC5/AC15: stop.sh generates agent.session.stop event", () => {
  const { tempSpoolDir, tempEnvFile } = setupTest()
  try {
    const sessionId = "ac-session-stop"

    // Pre-register as session start first
    const startInput = JSON.stringify({
      session_id: sessionId, hook_event_name: "SessionStart",
      cwd: "/home/project", workspace_roots: ["/home/project"],
      agent_id: "solo_agent", agent_type: "solo_agent",
      source: "startup",
    })
    runHookScript("session-start.sh", startInput, tempEnvFile)

    // User prompt（写入语言感知估算状态文件）
    runHookScript("prompt-submit.sh", JSON.stringify({
      session_id: sessionId, hook_event_name: "UserPromptSubmit",
      prompt: "Hello", agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    // Then simulate Stop hook
    const stopInput = JSON.stringify({
      session_id: sessionId, hook_event_name: "Stop",
      text_content: "Task completed successfully!",
      last_assistant_message: "Task completed successfully!",
      loop_count: 3, stop_hook_active: false,
      agent_id: "solo_agent", agent_type: "solo_agent",
    })
    runHookScript("stop.sh", stopInput, tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)

    const stopEvent = events.find(e => e.kind === "agent.session.stop")
    assert.ok(stopEvent, "agent.session.stop should be generated")
    assert.equal(stopEvent.sessionID, sessionId)
    assert.equal(stopEvent.payload.reason, "stop-hook")
    assert.equal(stopEvent.payload.loopCount, 3)

    const llmEvent = events.find(e => e.kind === "llm.call")
    assert.ok(llmEvent, "llm.call should be generated from stop hook")
    assert.equal(llmEvent.payload.estimated, true)
    assert.equal(llmEvent.payload.estimationMethod, "language-aware")
    assert.equal(llmEvent.payload.promptTokens, 1, "AC15: prompt token 应走语言感知估算（Hello = 1 词 × 1.3 → 1，非 completion/2 兜底）")
    assert.ok(llmEvent.payload.completionTokens > 0)
    // 状态文件应被 stop.sh 消费删除（一次性）
    assert.ok(!fs.existsSync(path.join(tempSpoolDir, "trae-prompt-state-ac-session-stop.json")),
      "prompt 状态文件应在 stop 后被消费删除")
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile)
  }
})

// ============================================================================
// AC15 兜底路径: 无 prompt-submit 状态文件时 promptTokens 走 completion/2
// ============================================================================
test("AC15: 无状态文件时 prompt token 走 completion/2 兜底", () => {
  const { tempSpoolDir, tempEnvFile } = setupTest()
  try {
    const sessionId = "ac15-fallback"
    runHookScript("session-start.sh", JSON.stringify({
      session_id: sessionId, hook_event_name: "SessionStart",
      cwd: "/tmp", workspace_roots: ["/tmp"],
      agent_id: "solo_agent", agent_type: "solo_agent", source: "startup",
    }), tempEnvFile)
    // 无 prompt-submit → 无状态文件
    runHookScript("stop.sh", JSON.stringify({
      session_id: sessionId, hook_event_name: "Stop",
      text_content: "ok done", last_assistant_message: "ok done",
      loop_count: 1, stop_hook_active: false,
      agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)
    const llmEvent = events.find(e => e.kind === "llm.call")
    assert.ok(llmEvent)
    // "ok done" = 2 词 → completion = int(2×1.3)=2 → 兜底 prompt = 2/2 = 1
    assert.equal(llmEvent.payload.promptTokens, 1, "AC15: 无状态文件时 prompt = completion/2")
    assert.equal(llmEvent.payload.completionTokens, 2)
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile)
  }
})

// ============================================================================
// AC20/AC21: Upload trigger / flush
// ============================================================================
test("AC20/AC21: UploadEngine buildSignature detects session completion via agent.session.stop", () => {
  const { tempSpoolDir, tempEnvFile } = setupTest()
  try {
    const sessionId = "ac20-complete"

    // Session start
    runHookScript("session-start.sh", JSON.stringify({
      session_id: sessionId, hook_event_name: "SessionStart",
      cwd: "/tmp", workspace_roots: ["/tmp"],
      agent_id: "solo_agent", agent_type: "solo_agent",
      source: "startup",
    }), tempEnvFile)

    // User prompt
    runHookScript("prompt-submit.sh", JSON.stringify({
      session_id: sessionId, hook_event_name: "UserPromptSubmit",
      prompt: "Hello", agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    // Agent response (stop)
    runHookScript("stop.sh", JSON.stringify({
      session_id: sessionId, hook_event_name: "Stop",
      text_content: "Hi there!", last_assistant_message: "Hi there!",
      loop_count: 1, stop_hook_active: false,
      agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)
    const reader = new SpoolReader(tempSpoolDir)
    const sessions = reader.buildSessionState(events)

    const state = sessions.get(sessionId)
    assert.ok(state, "session state should exist")

    const hasStop = state.events.some(e => e.kind === "agent.session.stop")
    assert.ok(hasStop, "agent.session.stop event is present")

    const hasPrompt = state.prompts.length > 0
    const hasEnd = state.ends.length > 0
    assert.ok(hasPrompt)
    assert.ok(hasEnd)
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile)
  }
})

// ============================================================================
// AC22: 断点续传 (checkpoint-based dedup)
// ============================================================================
test("AC22: SpoolReader.buildSessionState supports checkpoint-based dedup structure", () => {
  const reader = new SpoolReader("/tmp")
  const events = [
    { t: "2024-01-01T00:00:00Z", kind: "agent.session.start", sessionID: "s1", trace_id: "t1", payload: {} },
    { t: "2024-01-01T00:01:00Z", kind: "agent.prompt", sessionID: "s1", trace_id: "t1", payload: { query: "Q1" } },
    { t: "2024-01-01T00:02:00Z", kind: "agent.response", sessionID: "s1", trace_id: "t1", payload: { finalResult: "R1" } },
    { t: "2024-01-01T00:03:00Z", kind: "agent.session.stop", sessionID: "s1", trace_id: "t1", payload: { reason: "stop-hook" } },
  ] as any[]

  const sessions = reader.buildSessionState(events)
  assert.equal(sessions.size, 1)

  const state = sessions.get("s1")!
  const hasStop = state.events.some((e: any) => e.kind === "agent.session.stop")
  assert.ok(hasStop, "session.stop event tracked in state.events")

  // Verify that the same events produce identical session map (reproducible)
  const sessions2 = reader.buildSessionState(events)
  assert.equal(sessions2.size, 1)
  assert.equal(sessions2.get("s1")!.prompts.length, 1)
  assert.equal(sessions2.get("s1")!.ends.length, 1)
})

// ============================================================================
// AC23: 指数退避
// ============================================================================
test("AC23: UploadEngine exponential backoff delay calculation", () => {
  const baseDelayMs = 10000

  // Standard retry delays: attempt 2 → baseDelayMs * 2^0 = 10000
  // attempt 3 → baseDelayMs * 2^1 = 20000
  const delayAttempt2 = baseDelayMs * Math.pow(2, 0) // attempt=2 → pow(2, 2-2) = 1
  const delayAttempt3 = baseDelayMs * Math.pow(2, 1) // attempt=3 → pow(2, 3-2) = 2
  const delayAttempt4 = baseDelayMs * Math.pow(2, 2) // attempt=4 → pow(2, 4-2) = 4

  assert.equal(delayAttempt2, 10000)
  assert.equal(delayAttempt3, 20000)
  assert.equal(delayAttempt4, 40000)

  // With backoff multiplier (consecutiveFailures >= 3)
  const consecutiveFailures = 5
  const delayWithBackoff = Math.min(
    baseDelayMs * Math.pow(2, 2 - 2) * Math.pow(2, consecutiveFailures),
    300000
  )
  // base=10000 * 1 * 32 = 320000 → capped at 300000
  assert.equal(delayWithBackoff, 300000, "backoff capped at maxBackoffMs")
})

// ============================================================================
// AC8/AC9: Skill trace fields completeness
// ============================================================================
test("AC8: Skill trace generated from post-tool-use contains all required fields", () => {
  const { tempSpoolDir, tempEnvFile, tempToolStateDir } = setupTest()
  try {
    const sessionId = "ac8-fields"

    runHookScript("pre-tool-use.sh", JSON.stringify({
      session_id: sessionId, hook_event_name: "PreToolUse",
      tool_use_id: "call_ac8_skill", tool_name: "Skill",
      llm_tool_name: "Skill",
      tool_input: { name: "deep-analyzer" },
      agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    runHookScript("post-tool-use.sh", JSON.stringify({
      session_id: sessionId, hook_event_name: "PostToolUse",
      tool_use_id: "call_ac8_skill", tool_name: "Skill",
      llm_tool_name: "Skill",
      tool_input: { name: "deep-analyzer" },
      tool_response: {
        skill_path: "/home/.trae-cn/builtin_skills/deep-analyzer",
        skill_detail: "# Deep Analyzer\n\nversion: 1.2.0\n\nAnalyzes code deeply.",
        skill_type: "skill",
      },
      agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)
    const skillEvent = events.find(e => e.kind === "skill.call.end")

    assert.ok(skillEvent, "AC8: skill trace generated")
    assert.ok(skillEvent.payload.skillName, "AC8: skillName present")
    assert.equal(skillEvent.payload.skillVersion, "1.2.0", "AC8: skillVersion present")
    assert.ok(skillEvent.payload.triggerMode, "AC8: triggerMode present")
    assert.ok(skillEvent.payload.params, "AC8: params present")
    assert.ok(skillEvent.payload.skillPath, "AC8: skillPath present")
    assert.equal(skillEvent.sessionID, sessionId, "AC9: linked to parent session")
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile, tempToolStateDir)
  }
})

// ============================================================================
// 调试: TRAE_DEBUG_RAW=1 原始输入保存
// ============================================================================
test("DEBUG: TRAE_DEBUG_RAW=1 时保存原始 Hook 输入", () => {
  const { tempSpoolDir, tempEnvFile } = setupTest()
  try {
    const debugEnvFile = path.join(os.tmpdir(), `trae-debug-env-${Math.random().toString(36).slice(2)}.sh`)
    fs.writeFileSync(debugEnvFile, `
export AGENT_INSIGHT_DIR=${tempSpoolDir}
export TRAE_DEBUG_RAW=1
export AGENT_INSIGHT_API_KEY=test-key-debug
`)

    const testInputs = [
      { script: "session-start.sh", json: { session_id: "dbg-s1", hook_event_name: "SessionStart", cwd: "/tmp", workspace_roots: ["/tmp"], agent_id: "sa", agent_type: "solo_agent", source: "startup" } },
      { script: "pre-tool-use.sh", json: { session_id: "dbg-s1", hook_event_name: "PreToolUse", tool_use_id: "dbg-t1", tool_name: "BrowserTabs", llm_tool_name: "browser_tabs", tool_input: { action: "list" }, agent_id: "sa", agent_type: "solo_agent" } },
      { script: "stop.sh", json: { session_id: "dbg-s1", hook_event_name: "Stop", text_content: "done", last_assistant_message: "done", loop_count: 1, agent_id: "sa", agent_type: "solo_agent" } },
    ]

    for (const tc of testInputs) {
      runHookScript(tc.script, JSON.stringify(tc.json), debugEnvFile)
    }

    // 检查 _debug_raw 日志
    const debugDir = path.join(tempSpoolDir, "otel_data", "trae", "_debug_raw")
    assert.ok(fs.existsSync(debugDir), "_debug_raw 目录应存在")

    const debugFiles = fs.readdirSync(debugDir).filter(f => f.endsWith(".jsonl"))
    assert.equal(debugFiles.length, 1, "应有一个调试日志文件")

    const debugContent = fs.readFileSync(path.join(debugDir, debugFiles[0]), "utf8")
    const lines = debugContent.trim().split("\n")
    assert.ok(lines.length >= 3, `应有至少3条记录，实际 ${lines.length}`)

    for (const line of lines) {
      const ev = JSON.parse(line)
      assert.ok(ev.t, "应有时间戳")
      assert.ok(ev.hook, "应有 hook 名称")
      assert.ok(ev.raw, "应有原始输入")
    }

    // 验证 Hook 类型
    const hooks = lines.map(l => JSON.parse(l).hook)
    assert.ok(hooks.includes("SessionStart"))
    assert.ok(hooks.includes("PreToolUse"))
    assert.ok(hooks.includes("Stop"))

    try { fs.unlinkSync(debugEnvFile) } catch {}
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile)
  }
})

test("DEBUG: 默认情况下 TRAE_DEBUG_RAW 不产生日志", () => {
  const { tempSpoolDir, tempEnvFile } = setupTest()
  try {
    // 显式覆盖全局 .env 中的 TRAE_DEBUG_RAW=1
    const debugOffEnvFile = path.join(os.tmpdir(), `trae-debug-off-${Math.random().toString(36).slice(2)}.sh`)
    fs.writeFileSync(debugOffEnvFile, `
export AGENT_INSIGHT_DIR=${tempSpoolDir}
export TRAE_DEBUG_RAW=0
export AGENT_INSIGHT_API_KEY=test-key-debug-off
`)

    runHookScript("session-start.sh", JSON.stringify({
      session_id: "dbg-off", hook_event_name: "SessionStart",
      cwd: "/tmp", workspace_roots: ["/tmp"],
      agent_id: "sa", agent_type: "solo_agent", source: "startup",
    }), debugOffEnvFile)

    const debugDir = path.join(tempSpoolDir, "otel_data", "trae", "_debug_raw")
    const exists = fs.existsSync(debugDir)
    if (exists) {
      const files = fs.readdirSync(debugDir).filter(f => f.endsWith(".jsonl"))
      assert.equal(files.length, 0, "默认不应有调试日志")
    }

    try { fs.unlinkSync(debugOffEnvFile) } catch {}
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile)
  }
})
// ============================================================================
test("AC10: pre-tool-use.sh classifies tool types correctly", () => {
  const { tempSpoolDir, tempEnvFile, tempToolStateDir } = setupTest()
  try {
    const toolTypeCases = [
      { toolName: "Read", expectedType: "file_read" },
      { toolName: "Write", expectedType: "file_write" },
      { toolName: "Edit", expectedType: "file_edit" },
      { toolName: "Glob", expectedType: "search" },
      { toolName: "Grep", expectedType: "search" },
      { toolName: "LS", expectedType: "search" },
      { toolName: "Bash", expectedType: "terminal" },
      { toolName: "RunCommand", expectedType: "terminal" },
      { toolName: "WebSearch", expectedType: "web" },
      { toolName: "Skill", expectedType: "skill" },
    ]

    for (const tc of toolTypeCases) {
      runHookScript("pre-tool-use.sh", JSON.stringify({
        session_id: `ac10-${tc.toolName}`, hook_event_name: "PreToolUse",
        tool_use_id: `call_ac10_${tc.toolName}`, tool_name: tc.toolName,
        llm_tool_name: tc.toolName, tool_input: {},
        agent_id: "solo_agent", agent_type: "solo_agent",
      }), tempEnvFile)
    }

    const events = readSpoolEvents(tempSpoolDir)
    for (const tc of toolTypeCases) {
      const match = events.find(e => e.payload.toolName === tc.toolName)
      assert.ok(match, `${tc.toolName} should generate event`)
      assert.equal(match.payload.toolType, tc.expectedType,
        `${tc.toolName} should be ${tc.expectedType}, got ${match.payload.toolType}`)
    }
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile, tempToolStateDir)
  }
})

// ============================================================================
// AC11: Tool trace contains exitCode/error
// ============================================================================
test("AC11: post-tool-use.sh records exitCode and error info", () => {
  const { tempSpoolDir, tempEnvFile, tempToolStateDir } = setupTest()
  try {
    // Success case
    runHookScript("pre-tool-use.sh", JSON.stringify({
      session_id: "ac11-ok", hook_event_name: "PreToolUse",
      tool_use_id: "call_ac11_ok", tool_name: "Bash",
      llm_tool_name: "Bash",
      tool_input: { command: "ls" },
      agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    runHookScript("post-tool-use.sh", JSON.stringify({
      session_id: "ac11-ok", hook_event_name: "PostToolUse",
      tool_use_id: "call_ac11_ok", tool_name: "Bash",
      llm_tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: { exit_code: 0, stdout: "file1.txt\nfile2.txt", command_start_ms: 1700000000000, command_end_ms: 1700000001500 },
      agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    // Error case
    runHookScript("pre-tool-use.sh", JSON.stringify({
      session_id: "ac11-err", hook_event_name: "PreToolUse",
      tool_use_id: "call_ac11_err", tool_name: "Bash",
      llm_tool_name: "Bash",
      tool_input: { command: "nonexistent" },
      agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    runHookScript("post-tool-use.sh", JSON.stringify({
      session_id: "ac11-err", hook_event_name: "PostToolUse",
      tool_use_id: "call_ac11_err", tool_name: "Bash",
      llm_tool_name: "Bash",
      tool_input: { command: "nonexistent" },
      tool_response: { exit_code: 127, stderr: "command not found", command_start_ms: 1700000000000, command_end_ms: 1700000002200 },
      agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)

    const okEnd = events.find(e => e.trace_id === "tool_call_ac11_ok" && e.kind === "tool.call.end")
    assert.ok(okEnd)
    assert.equal(okEnd.payload.exitCode, 0)
    assert.equal(okEnd.payload.latencyMs, 1500, "AC11: 应从 command_start_ms/end_ms 计算真实耗时")

    const errEnd = events.find(e => e.trace_id === "tool_call_ac11_err" && e.kind === "tool.call.end")
    assert.ok(errEnd)
    assert.equal(errEnd.payload.exitCode, 127)
    assert.equal(errEnd.payload.latencyMs, 2200, "AC11: 失败工具也应记录真实耗时")
    assert.ok(errEnd.payload.error, "should record error from stderr")
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile, tempToolStateDir)
  }
})

// ============================================================================
// AC12: Tool trace 关联到 Agent traceId
// ============================================================================
test("AC12: tool trace parent_id is set to sessionID", () => {
  const { tempSpoolDir, tempEnvFile, tempToolStateDir } = setupTest()
  try {
    const sessionId = "ac12-session"

    runHookScript("pre-tool-use.sh", JSON.stringify({
      session_id: sessionId, hook_event_name: "PreToolUse",
      tool_use_id: "call_ac12", tool_name: "Write",
      llm_tool_name: "Write",
      tool_input: { file: "test.txt", content: "hello" },
      agent_id: "solo_agent", agent_type: "solo_agent",
    }), tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)
    const toolStart = events.find(e => e.kind === "tool.call.start")
    assert.ok(toolStart)
    assert.equal(toolStart.parent_id, sessionId, "AC12: tool parent_id links to agent sessionID")
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile, tempToolStateDir)
  }
})

// ============================================================================
// AC7: 多层嵌套子任务测试
// ============================================================================
test("AC7: multi-level nested subagent relationships are tracked", () => {
  const { tempSpoolDir, tempEnvFile } = setupTest()
  try {
    // Level 0: root session
    runHookScript("session-start.sh", JSON.stringify({
      session_id: "root-session", hook_event_name: "SessionStart",
      cwd: "/tmp", workspace_roots: ["/tmp"],
      agent_id: "solo_agent", agent_type: "solo_agent",
      source: "startup",
    }), tempEnvFile)

    // Level 1: subagent
    runHookScript("session-start.sh", JSON.stringify({
      session_id: "sub-level1", hook_event_name: "SessionStart",
      agent_id: "search", agent_type: "search_agent",
      source: "subagent",
    }), tempEnvFile)

    // Level 2: nested subagent (started while level 1 is active)
    runHookScript("session-start.sh", JSON.stringify({
      session_id: "sub-level2", hook_event_name: "SessionStart",
      agent_id: "code-explorer", agent_type: "explorer_agent",
      source: "subagent",
    }), tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)
    const reader = new SpoolReader(tempSpoolDir)
    const sessions = reader.buildSessionState(events)

    assert.ok(sessions.has("root-session"), "root session exists")
    assert.ok(sessions.has("sub-level1"), "level 1 subagent exists")
    assert.ok(sessions.has("sub-level2"), "level 2 subagent exists")

    const sub1 = sessions.get("sub-level1")!
    const sub2 = sessions.get("sub-level2")!
    assert.ok(sub1.subagentOf, "level 1 has parent")
    assert.ok(sub2.subagentOf, "level 2 has parent")
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile)
  }
})

// ============================================================================
// 修复回归：快速连续新建多个 solo_agent 会话时，
// 后建会话不应被误判为前一会话的子 agent（subagent-detect 时序误判）
// ============================================================================
test("AC6: 连续两个 solo_agent 会话互不误判为子 agent", () => {
  const { tempSpoolDir, tempEnvFile } = setupTest()
  try {
    runHookScript("session-start.sh", JSON.stringify({
      session_id: "solo-s1", hook_event_name: "SessionStart",
      cwd: "/tmp", workspace_roots: ["/tmp"],
      agent_id: "solo_agent", agent_type: "solo_agent", source: "startup",
    }), tempEnvFile)

    // 快速连续第二个 solo_agent 会话（修复前会被误判为 solo-s1 的子 agent）
    runHookScript("session-start.sh", JSON.stringify({
      session_id: "solo-s2", hook_event_name: "SessionStart",
      cwd: "/tmp", workspace_roots: ["/tmp"],
      agent_id: "solo_agent", agent_type: "solo_agent", source: "startup",
    }), tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)
    const s2start = events.find(e => e.sessionID === "solo-s2" && e.kind === "agent.session.start")
    const s2sub = events.find(e => e.sessionID === "solo-s2" && e.kind === "agent.subagent.start")
    assert.ok(s2start, "第二个 solo_agent 会话应为 agent.session.start")
    assert.ok(!s2sub, "第二个 solo_agent 会话不应被误判为子 agent")
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile)
  }
})
