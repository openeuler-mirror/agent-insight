import test from "node:test"
import assert from "node:assert/strict"
import { execSync } from "node:child_process"
import * as crypto from "node:crypto"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

// ============================================================================
// AC3/AC4: spool 目录结构与多账号隔离（跑真实 session-start.sh）
//
//   AC3: 安装后 ~/.agent-insight/otel_data/trae/ 生成 spool 目录
//   AC4: 不同 API Key 的数据写入隔离子目录（sha256(apiKey)[0:16]）
//
// 与既有 trae-acceptance 相同的隔离手法：AGENT_INSIGHT_DIR 指向临时目录，
// 外加 HOME 指向临时目录，防止 common.sh 的 _load_trae_env 读到真实 .env。
// ============================================================================

const hooksDir = path.resolve(__dirname, "../scripts/trae-collector/hooks")
const scriptsDir = path.join(hooksDir, "scripts")

function keyHash(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 16)
}

function setup() {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "trae-iso-home-"))
  const tmpInsight = fs.mkdtempSync(path.join(os.tmpdir(), "trae-iso-insight-"))
  const stateFile = path.join(tmpInsight, "subagent-state.json")
  const toolStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "trae-iso-tool-"))
  return { tmpHome, tmpInsight, stateFile, toolStateDir }
}

function cleanup(t: { after(fn: () => void): void }, ...dirs: string[]) {
  t.after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  })
}

function runSessionStart(tmpHome: string, tmpInsight: string, stateFile: string, toolStateDir: string, apiKey: string, sessionId: string) {
  const input = JSON.stringify({
    session_id: sessionId, hook_event_name: "SessionStart",
    cwd: "/tmp/project", workspace_roots: ["/tmp/project"],
    agent_id: "solo_agent", agent_type: "solo_agent",
    source: "startup",
  })
  const envFile = path.join(os.tmpdir(), `trae-iso-env-${Math.random().toString(36).slice(2)}.sh`)
  const inputFile = path.join(os.tmpdir(), `trae-iso-input-${Math.random().toString(36).slice(2)}.json`)
  fs.writeFileSync(envFile, `
export HOME=${tmpHome}
export AGENT_INSIGHT_DIR=${tmpInsight}
export AGENT_INSIGHT_API_KEY=${apiKey}
export TRAE_SUBAGENT_STATE_FILE=${stateFile}
export TRAE_TOOL_STATE_DIR=${toolStateDir}
`)
  fs.writeFileSync(inputFile, input)
  try {
    execSync(`bash -c "source ${envFile} && cat ${inputFile} | bash ${path.join(scriptsDir, "session-start.sh")}"`, {
      stdio: ["pipe", "pipe", "pipe"], timeout: 10000,
    })
  } finally {
    fs.unlinkSync(envFile)
    fs.unlinkSync(inputFile)
  }
}

/** 返回 spool 下所有 jsonl 文件路径（递归） */
function listSpoolJsonl(tmpInsight: string): string[] {
  const base = path.join(tmpInsight, "otel_data", "trae")
  if (!fs.existsSync(base)) return []
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full)
    }
  }
  walk(base)
  return out
}

// ============================================================================
// AC3: session-start 触发后生成 spool 目录 + 会话事件
// ============================================================================
test("AC3: 采集事件后生成 spool 目录与 agent.session.start 事件", (t) => {
  const { tmpHome, tmpInsight, stateFile, toolStateDir } = setup()
  cleanup(t, tmpHome, tmpInsight, toolStateDir)
  const apiKey = "key-ac3-demo"

  runSessionStart(tmpHome, tmpInsight, stateFile, toolStateDir, apiKey, "ac3-session")

  const files = listSpoolJsonl(tmpInsight)
  assert.ok(files.length >= 1, "spool 下应生成 jsonl 文件")
  const content = fs.readFileSync(files[0], "utf8")
  const event = JSON.parse(content.trim().split("\n")[0])
  assert.equal(event.kind, "agent.session.start")
  assert.equal(event.sessionID, "ac3-session")
  assert.equal(event.payload.source, "startup")
})

// ============================================================================
// AC4: 不同 API Key → 不同隔离子目录；同一 Key 复用同一目录
// ============================================================================
test("AC4: 不同 API Key 写入隔离子目录", (t) => {
  const { tmpHome, tmpInsight, stateFile, toolStateDir } = setup()
  cleanup(t, tmpHome, tmpInsight, toolStateDir)
  const keyA = "api-key-aaaa"
  const keyB = "api-key-bbbb"

  runSessionStart(tmpHome, tmpInsight, stateFile, toolStateDir, keyA, "ac4-session-a")
  runSessionStart(tmpHome, tmpInsight, stateFile, toolStateDir, keyB, "ac4-session-b")
  runSessionStart(tmpHome, tmpInsight, stateFile, toolStateDir, keyA, "ac4-session-a2")

  const files = listSpoolJsonl(tmpInsight)
  const dirs = new Set(files.map((f) => path.dirname(f)))

  assert.equal(dirs.size, 2, "应恰好有 2 个隔离目录")
  assert.ok(files.some((f) => f.includes(`otel_data${path.sep}trae${path.sep}${keyHash(keyA)}`)), "keyA 事件应写入其 hash 子目录")
  assert.ok(files.some((f) => f.includes(`otel_data${path.sep}trae${path.sep}${keyHash(keyB)}`)), "keyB 事件应写入其 hash 子目录")
  assert.notEqual(keyHash(keyA), keyHash(keyB), "两个 key 的 hash 目录应不同")

  // 同一 key 的两次会话落在同一目录
  const dirA = new Set(files.filter((f) => f.includes(keyHash(keyA))).map((f) => path.dirname(f)))
  assert.equal(dirA.size, 1, "同一 API Key 应复用同一目录")
})

// ============================================================================
// AC4 边界: 未配置 API Key → 写入 default 目录（不崩溃、不混入真实环境）
// ============================================================================
test("AC4: 未配置 API Key 时写入 default 目录", (t) => {
  const { tmpHome, tmpInsight, stateFile, toolStateDir } = setup()
  cleanup(t, tmpHome, tmpInsight, toolStateDir)

  runSessionStart(tmpHome, tmpInsight, stateFile, toolStateDir, "", "ac4-default-session")

  const files = listSpoolJsonl(tmpInsight)
  assert.ok(files.length >= 1, "default 目录应生成 jsonl")
  assert.ok(files[0].includes(`otel_data${path.sep}trae${path.sep}default`), "应写入 default 子目录")
})
