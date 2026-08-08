import test from "node:test"
import assert from "node:assert/strict"
import * as fs from "fs"
import * as path from "path"

// ============================================================================
// AC1/AC2: VSIX 插件元数据静态断言
//
// 保证打包产物（package.json 声明）满足验收前提：安装后可发现、状态栏命令、
// 14 个 Settings 配置项、延迟激活（性能 AC24 的前提）、卸载钩子齐全。
// 这是纯静态断言，不依赖真实 TRAE 环境。
// ============================================================================

const pluginDir = path.resolve(__dirname, "../scripts/trae-collector")
const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"))

const EXPECTED_CONFIG_KEYS = [
  "agentInsight.trae.enabled",
  "agentInsight.trae.host",
  "agentInsight.trae.apiKey",
  "agentInsight.trae.uploadIntervalMs",
  "agentInsight.trae.requestTimeoutMs",
  "agentInsight.trae.maxRetries",
  "agentInsight.trae.retryBaseDelayMs",
  "agentInsight.trae.llmEnabled",
  "agentInsight.trae.llmPollIntervalMs",
  "agentInsight.trae.logLevel",
  "agentInsight.trae.spoolDir",
  "agentInsight.trae.heartbeatEnabled",
  "agentInsight.trae.heartbeatIntervalMs",
  "agentInsight.trae.modelName",
]

test("AC1: 插件元数据完整（main/engines/激活事件/标识）", () => {
  assert.equal(pkg.name, "agent-insight-trae-collector")
  assert.equal(pkg.publisher, "agent-insight")
  assert.ok(pkg.version, "应有版本号")
  assert.equal(pkg.main, "./dist/extension.js", "main 应指向打包产物")
  assert.ok(pkg.engines?.vscode, "应声明 engines.vscode")
  assert.ok(pkg.activationEvents?.includes("onStartupFinished"), "应延迟激活（onStartupFinished）")
  assert.equal(pkg.extensionKind?.[0], "workspace")
})

test("AC1: dist/extension.js 构建产物存在且非空（可被打包安装）", () => {
  const distFile = path.join(pluginDir, "dist", "extension.js")
  assert.ok(fs.existsSync(distFile), `构建产物 ${distFile} 应存在（npm run build）`)
  assert.ok(fs.statSync(distFile).size > 10000, "构建产物不应为空")
})

test("AC1: VSIX 打包产物存在（若已构建）", () => {
  const vsixFile = path.join(pluginDir, `${pkg.name}-${pkg.version}.vsix`)
  if (fs.existsSync(vsixFile)) {
    assert.ok(fs.statSync(vsixFile).size > 10000, "VSIX 不应为空")
  } else {
    // VSIX 在 .gitignore 中，CI 可能未构建 —— 仅提示，不失败
    console.log("  (VSIX 未构建，跳过产物断言 — 演示前需 npm run build)")
  }
})

test("AC2: Settings 配置项 14 项齐全", () => {
  const configProps = pkg.contributes?.configuration?.properties ?? {}
  const actual = Object.keys(configProps)
  for (const key of EXPECTED_CONFIG_KEYS) {
    assert.ok(actual.includes(key), `缺少配置项 ${key}`)
  }
  assert.equal(actual.length, EXPECTED_CONFIG_KEYS.length, "配置项数量应一致")
})

test("AC2: 状态栏相关命令齐全（showStatus/flushNow/openSpoolDir/openLogs）", () => {
  const commands: string[] = pkg.contributes?.commands ?? []
  const ids = commands.map((c: { command: string }) => c.command)
  for (const id of [
    "agent-insight-trae.showStatus",
    "agent-insight-trae.flushNow",
    "agent-insight-trae.openSpoolDir",
    "agent-insight-trae.openLogs",
  ]) {
    assert.ok(ids.includes(id), `缺少命令 ${id}`)
  }
})

test("AC29(前置): vscode:uninstall 卸载钩子声明且脚本存在", () => {
  const uninstallScript = pkg.scripts?.["vscode:uninstall"]
  assert.ok(uninstallScript?.includes("uninstall-cleanup.js"), "应声明 vscode:uninstall 钩子")
  assert.ok(fs.existsSync(path.join(pluginDir, "scripts", "uninstall-cleanup.js")), "卸载脚本应存在")
})
