import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

// ============================================================================
// AC29/AC30: uninstall-cleanup.js（vscode:uninstall 钩子真身）隔离执行测试
//
// 隔离：HOME + AGENT_INSIGHT_DIR 双环境变量指向临时目录 —— 脚本的路径计算
// 全部落在 /tmp，真实 ~/.agent-insight 与 ~/.trae-cn 不会被碰（os.homedir()
// 读 $HOME，AGENT_INSIGHT_DIR 是脚本自身的隔离入口）。
// ============================================================================

const cleanupScript = path.resolve(__dirname, "../scripts/trae-collector/scripts/uninstall-cleanup.js")

function setup() {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "trae-uni-home-"))
  const tmpInsight = fs.mkdtempSync(path.join(os.tmpdir(), "trae-uni-insight-"))
  return { tmpHome, tmpInsight }
}

function runCleanup(tmpHome: string, tmpInsight: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [cleanupScript], {
      env: { ...process.env, HOME: tmpHome, AGENT_INSIGHT_DIR: tmpInsight },
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    })
    return { stdout, exitCode: 0 }
  } catch (e: any) {
    return { stdout: e.stdout?.toString() ?? "", exitCode: e.status ?? -1 }
  }
}

/** 预置 4 类采集器产物：hooks 脚本、hooks.json、checkpoint、spool 数据 */
function seedArtifacts(tmpHome: string, tmpInsight: string, hooksJsonContent: string) {
  const hooksDir = path.join(tmpInsight, "trae-hooks", "scripts")
  fs.mkdirSync(hooksDir, { recursive: true })
  fs.writeFileSync(path.join(hooksDir, "session-start.sh"), "#!/bin/bash\n")
  fs.writeFileSync(path.join(tmpHome, ".trae-cn", "hooks.json"), hooksJsonContent, { flag: "wx" })
  fs.mkdirSync(path.join(tmpInsight, "otel_data", "trae", "deadbeef", "2026-07-30"), { recursive: true })
  fs.writeFileSync(path.join(tmpInsight, "otel_data", "trae", "deadbeef", "2026-07-30", "trae-otel-test.jsonl"), "{}\n")
  fs.writeFileSync(path.join(tmpInsight, "trae_uploader_checkpoint.json"), '{"s1":{"signature":"x","uploadedAt":"2026-07-30T00:00:00Z"}}\n')
}

function assertCleaned(tmpHome: string, tmpInsight: string) {
  assert.ok(!fs.existsSync(path.join(tmpInsight, "trae-hooks")), "trae-hooks 应被删除")
  assert.ok(!fs.existsSync(path.join(tmpHome, ".trae-cn", "hooks.json")), "hooks.json 应被删除")
  assert.ok(!fs.existsSync(path.join(tmpInsight, "trae_uploader_checkpoint.json")), "checkpoint 应被删除")
  assert.ok(!fs.existsSync(path.join(tmpInsight, "otel_data", "trae")), "trae spool 应被删除")
}

// ============================================================================
// AC29: 卸载清理删除全部采集器产物
// ============================================================================
test("AC29: uninstall-cleanup 删除 hooks/hooks.json/checkpoint/spool", (t) => {
  const { tmpHome, tmpInsight } = setup()
  t.after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.rmSync(tmpInsight, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(tmpHome, ".trae-cn"), { recursive: true })
  seedArtifacts(tmpHome, tmpInsight, '{"hooks":[{"hook":"SessionStart","cmd":"trae-hooks/scripts/session-start.sh"}]}')

  const { exitCode, stdout } = runCleanup(tmpHome, tmpInsight)

  assert.equal(exitCode, 0)
  assert.ok(stdout.includes("[DEL]"), "应输出删除记录")
  assertCleaned(tmpHome, tmpInsight)
})

// ============================================================================
// AC29: 二次执行幂等（已清理完的目录不报错）
// ============================================================================
test("AC29: 二次执行幂等，无产物时正常退出", (t) => {
  const { tmpHome, tmpInsight } = setup()
  t.after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.rmSync(tmpInsight, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(tmpHome, ".trae-cn"), { recursive: true })
  seedArtifacts(tmpHome, tmpInsight, '{"hooks":[{"cmd":"trae-hooks/scripts/session-start.sh"}]}')
  runCleanup(tmpHome, tmpInsight)
  assertCleaned(tmpHome, tmpInsight)

  const second = runCleanup(tmpHome, tmpInsight)
  assert.equal(second.exitCode, 0, "二次执行应正常退出")
  assert.ok(second.stdout.includes("(not found)") || second.stdout.includes("(none found)"), "二次执行应报告无产物")
})

// ============================================================================
// AC30: 其他框架（opencode）产物不受影响
// ============================================================================
test("AC30: 清理不影响其他框架采集器数据", (t) => {
  const { tmpHome, tmpInsight } = setup()
  t.after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.rmSync(tmpInsight, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(tmpHome, ".trae-cn"), { recursive: true })
  seedArtifacts(tmpHome, tmpInsight, '{"hooks":[{"cmd":"trae-hooks/scripts/session-start.sh"}]}')
  const opencodeFiles = [
    path.join(tmpInsight, "opencode_uploader_client.js"),
    path.join(tmpInsight, "start_opencode_uploader.sh"),
    path.join(tmpInsight, "otel_data", "opencode", "2026-07-30", "sessions", "s1", "traces.jsonl"),
  ]
  for (const f of opencodeFiles) {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, "opencode data\n")
  }

  const { stdout } = runCleanup(tmpHome, tmpInsight)

  for (const f of opencodeFiles) {
    assert.ok(fs.existsSync(f), `${path.basename(f)} 应保留`)
  }
  assert.ok(stdout.includes("[KEEP]"), "应输出保留记录")
})

// ============================================================================
// AC30: hooks.json 保护 —— 非本插件生成的 hooks.json 不删除
// ============================================================================
test("AC30: 不含 trae-hooks 的 hooks.json 不被删除", (t) => {
  const { tmpHome, tmpInsight } = setup()
  t.after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.rmSync(tmpInsight, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(tmpHome, ".trae-cn"), { recursive: true })
  // 其他插件/框架写的 hooks.json（不含 trae-hooks 路径）
  fs.writeFileSync(path.join(tmpHome, ".trae-cn", "hooks.json"), '{"hooks":[{"hook":"PreToolUse","cmd":"/other/framework/hook.sh"}]}')
  fs.mkdirSync(path.join(tmpInsight, "trae-hooks"), { recursive: true })

  const { stdout } = runCleanup(tmpHome, tmpInsight)

  assert.ok(fs.existsSync(path.join(tmpHome, ".trae-cn", "hooks.json")), "外部 hooks.json 应保留")
  assert.ok(stdout.includes("[SKIP]"), "应输出跳过记录")
  assert.ok(!fs.existsSync(path.join(tmpInsight, "trae-hooks")), "自有 hooks 仍应删除")
})
