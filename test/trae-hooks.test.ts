import test from "node:test"
import assert from "node:assert/strict"
import { execSync } from "child_process"
import * as os from "os"
import * as fs from "fs"
import * as path from "path"

const hooksDir = path.join(__dirname, "../scripts/trae-collector/hooks")
const scriptsDir = path.join(hooksDir, "scripts")

function setupTest() {
  const tempSpoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "trae-hooks-test-"))
  const tempEnvFile = path.join(os.tmpdir(), `trae-hooks-env-${Math.random().toString(36).slice(2)}.sh`)
  const tempStateFile = path.join(tempSpoolDir, "subagent-state.json")
  
  fs.writeFileSync(tempEnvFile, `
export AGENT_INSIGHT_DIR=${tempSpoolDir}
export AGENT_INSIGHT_TRAE_MAX_CONTENT_LENGTH=2000
export AGENT_INSIGHT_API_KEY=test-api-key-123
export TRAE_SUBAGENT_STATE_FILE=${tempStateFile}
`)
  
  return { tempSpoolDir, tempEnvFile }
}

function cleanupTest(tempSpoolDir: string, tempEnvFile: string) {
  if (fs.existsSync(tempSpoolDir)) {
    fs.rmSync(tempSpoolDir, { recursive: true })
  }
  if (fs.existsSync(tempEnvFile)) {
    fs.unlinkSync(tempEnvFile)
  }
}

function runHookScript(scriptName: string, inputJson: string, tempEnvFile: string): string {
  const scriptPath = path.join(scriptsDir, scriptName)
  const tempInputFile = path.join(os.tmpdir(), `trae-hooks-input-${Math.random().toString(36).slice(2)}.json`)
  fs.writeFileSync(tempInputFile, inputJson)
  const cmd = `bash -c "source ${tempEnvFile} && cat ${tempInputFile} | bash ${scriptPath}"`
  try {
    return execSync(cmd, { stdio: ["pipe", "pipe", "pipe"] }).toString()
  } finally {
    if (fs.existsSync(tempInputFile)) {
      fs.unlinkSync(tempInputFile)
    }
  }
}

function readSpoolEvents(tempSpoolDir: string): any[] {
  const events: any[] = []
  try {
    const files = fs.readdirSync(tempSpoolDir, { recursive: true, encoding: "utf8" }) as string[]
    for (const file of files.filter(f => f.endsWith(".jsonl"))) {
      const fullPath = path.join(tempSpoolDir, file)
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, "utf8")
        for (const line of content.trim().split("\n")) {
          if (line) {
            events.push(JSON.parse(line))
          }
        }
      }
    }
  } catch {}
  return events
}

test("session-start.sh generates session trace from TRAE Hook SessionStart event", () => {
  const { tempSpoolDir, tempEnvFile } = setupTest()
  try {
    const mainInput = JSON.stringify({
      session_id: "session-main-test",
      hook_event_name: "SessionStart",
      cwd: "/home/user/project",
      workspace_roots: ["/home/user/project"],
      agent_id: "solo_agent",
      agent_type: "solo_agent",
      source: "startup",
    })

    runHookScript("session-start.sh", mainInput, tempEnvFile)

    const subagentInput = JSON.stringify({
      session_id: "session-sub-test",
      hook_event_name: "SessionStart",
      cwd: "/home/user/project",
      workspace_roots: [],
      agent_id: "search",
      agent_type: "search_agent",
      source: "subagent",
    })

    runHookScript("session-start.sh", subagentInput, tempEnvFile)

    const events = readSpoolEvents(tempSpoolDir)
    const mainEvent = events.find(e => e.kind === "agent.session.start")
    const subEvent = events.find(e => e.kind === "agent.subagent.start")

    assert.ok(mainEvent)
    assert.equal(mainEvent.sessionID, "session-main-test")
    assert.equal(mainEvent.payload.source, "startup")
    assert.equal(mainEvent.payload.cwd, "/home/user/project")
    assert.ok(mainEvent.payload.workspace_roots)

    assert.ok(subEvent)
    assert.equal(subEvent.sessionID, "session-sub-test")
    assert.equal(subEvent.payload.subagent, true)
    assert.equal(subEvent.payload.parent_session_id, "session-main-test")
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile)
  }
})

test("pre-tool-use.sh generates tool trace with correct tool types", () => {
  const { tempSpoolDir, tempEnvFile } = setupTest()
  try {
    const fileWriteInput = JSON.stringify({
      session_id: "session-tool-test",
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      llm_tool_name: "WriteFile",
      tool_use_id: "call-001",
      tool_input: { file: "test.txt", content: "hello" },
      cwd: "/home/user/project",
      agent_id: "solo_agent",
      agent_type: "solo_agent",
    })

    runHookScript("pre-tool-use.sh", fileWriteInput, tempEnvFile)
    
    const events = readSpoolEvents(tempSpoolDir)
    const toolEvent = events.find(e => e.kind === "tool.call.start")
    
    assert.ok(toolEvent)
    assert.equal(toolEvent.payload.toolName, "Write")
    assert.equal(toolEvent.payload.toolType, "file_write")
    assert.equal(toolEvent.payload.llm_tool_name, "WriteFile")
    assert.equal(toolEvent.payload.toolUseId, "call-001")
    assert.equal(toolEvent.payload.cwd, "/home/user/project")
  } finally {
    cleanupTest(tempSpoolDir, tempEnvFile)
  }
})