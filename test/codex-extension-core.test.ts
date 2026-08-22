import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const {
  EditAccumulator,
  relativeFilePath,
  selectActiveTurn,
  summarizeChanges,
  terminalCommandLine,
} = require("../scripts/agent-trace-collectors/codex/vscode-extension/ide-trace-core.cjs")

test("IDE active turn gate rejects no turn, CLI turns, and ambiguous IDE turns", () => {
  const workspace = [path.resolve("repo")]
  assert.equal(selectActiveTurn({ activeTurns: [] }, workspace), undefined)
  assert.equal(selectActiveTurn({
    activeTurns: [{
      sessionId: "cli",
      turnId: "turn",
      originator: "codex_cli",
      cwd: workspace[0],
    }],
  }, workspace), undefined)
  const single = selectActiveTurn({
    activeTurns: [{
      sessionId: "ide",
      turnId: "turn",
      originator: "codex_vscode",
      cwd: workspace[0],
    }],
  }, workspace)
  assert.equal(single?.sessionId, "ide")
  assert.equal(selectActiveTurn({
    activeTurns: [
      { sessionId: "a", turnId: "a", originator: "codex_vscode", cwd: workspace[0] },
      { sessionId: "b", turnId: "b", originator: "codex_vscode", cwd: workspace[0] },
    ],
  }, workspace), undefined)
})

test("IDE path projection emits only workspace-relative file paths", () => {
  const workspace = [path.resolve("repo")]
  assert.equal(
    relativeFilePath(path.join(workspace[0], "src", "app.ts"), workspace),
    "src/app.ts",
  )
  assert.equal(relativeFilePath(path.resolve("other", "secret.txt"), workspace), undefined)
  assert.equal(relativeFilePath("D:\\repo\\src\\app.ts", ["D:\\repo"]), "src/app.ts")
  assert.equal(relativeFilePath("D:\\other\\secret.txt", ["D:\\repo"]), undefined)
  assert.equal(relativeFilePath("/repo/src/app.ts", ["/repo"]), "src/app.ts")
  assert.equal(relativeFilePath("/repo", ["/repo/src"]), undefined)
})

test("FileEdit summary records ranges and Unicode code-point lengths without text", () => {
  const summary = summarizeChanges([{
    range: {
      start: { line: 1, character: 2 },
      end: { line: 1, character: 4 },
    },
    rangeLength: 2,
    text: "a🙂",
  }])
  assert.deepEqual(summary, [{
    range: {
      start: { line: 1, character: 2 },
      end: { line: 1, character: 4 },
    },
    rangeLength: 2,
    insertedLength: 2,
  }])
  assert.equal(JSON.stringify(summary).includes("a🙂"), false)
})

test("FileEdit accumulator merges a document only inside the 500ms window", () => {
  let now = 1000
  const accumulator = new EditAccumulator({ now: () => now, windowMs: 500 })
  accumulator.add("doc", { changes: [{ insertedLength: 1 }] })
  now = 1300
  accumulator.add("doc", { changes: [{ insertedLength: 2 }] })
  assert.deepEqual(accumulator.take("doc").changes, [
    { insertedLength: 1 },
    { insertedLength: 2 },
  ])
  now = 2000
  accumulator.add("doc", { changes: [{ insertedLength: 3 }] })
  assert.equal(accumulator.take("doc").changes.length, 1)
})

test("Terminal Shell Execution command extraction uses only the public event shape", () => {
  assert.equal(terminalCommandLine({
    execution: { commandLine: { value: "npm test" } },
  }), "npm test")
  assert.equal(terminalCommandLine({
    execution: { commandLine: "pwd" },
  }), "pwd")
})

test("VSIX manifest exposes required settings, status commands, and supported editor engine", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(
    process.cwd(),
    "scripts",
    "agent-trace-collectors",
    "codex",
    "vscode-extension",
    "package.json",
  ), "utf8"))
  assert.equal(manifest.engines.vscode, "^1.93.0")
  for (const setting of [
    "enabled",
    "endpoint",
    "apiKey",
    "relayPort",
    "captureFileEdits",
    "captureTerminal",
    "cloudAgentId",
  ]) {
    assert.ok(manifest.contributes.configuration.properties[`agentInsight.codexTrace.${setting}`])
  }
  const commands = manifest.contributes.commands.map((item: { command: string }) => item.command)
  assert.ok(commands.includes("agentInsight.codexTrace.flush"))
  assert.ok(commands.includes("agentInsight.codexTrace.linkCloudAgent"))
  assert.ok(commands.includes("agentInsight.codexTrace.unlinkCloudAgent"))
})
