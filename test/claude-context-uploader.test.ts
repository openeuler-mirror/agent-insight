// 客户端补传器(scripts/claude_context_uploader.js)的抽取逻辑测试。
// 用真实数据形状造夹具:raw body 的 metadata.user_id 是一段【JSON 字符串】,里面才有 session_id;
// transcript 里 hook 注入上下文是 type=attachment / attachment.type=hook_additional_context。
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createRequire } from "node:module"

const requireCjs = createRequire(path.join(process.cwd(), "package.json"))
const uploader = requireCjs(path.join(process.cwd(), "scripts", "claude_context_uploader.js"))

const SESSION = "sess-uploader-1"

function tmpdir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ai-${name}-`))
}

function writeRequestBody(dir: string, file: string, sessionId: string, system: unknown) {
  fs.writeFileSync(
    path.join(dir, file),
    JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [],
      system,
      metadata: { user_id: JSON.stringify({ device_id: "d", account_uuid: "a", session_id: sessionId }) },
    }),
    "utf8",
  )
}

test("uploader: 按 metadata.session_id 精确捞 system prompt,并按内容去重", () => {
  const dir = tmpdir("rawbody")
  writeRequestBody(dir, "a.request.json", SESSION, [{ type: "text", text: "系统提示词 A" }])
  writeRequestBody(dir, "b.request.json", SESSION, [{ type: "text", text: "系统提示词 A" }])  // 同一份,应去重
  writeRequestBody(dir, "c.request.json", "别的会话", [{ type: "text", text: "别人的系统提示词" }])
  fs.writeFileSync(path.join(dir, "d.response.json"), "{}", "utf8")  // 响应体不参与

  const items = uploader.collectSystemPrompts(dir, SESSION, uploader.LIMITS)
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, "system_prompt")
  assert.equal(items[0].text, "系统提示词 A")
  assert.ok(items[0].hash)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("uploader: 扫描文件数与 system 份数都有上限(长会话不会被拖垮)", () => {
  const dir = tmpdir("rawbody-cap")
  for (let i = 0; i < 12; i++) {
    writeRequestBody(dir, `f${i}.request.json`, SESSION, [{ type: "text", text: `系统提示词 ${i}` }])
  }
  const capped = uploader.collectSystemPrompts(dir, SESSION, { ...uploader.LIMITS, systemPrompts: 2 })
  assert.equal(capped.length, 2)

  const scanCapped = uploader.collectSystemPrompts(dir, SESSION, { ...uploader.LIMITS, rawBodyFiles: 3, systemPrompts: 99 })
  assert.equal(scanCapped.length, 3)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("uploader: 目录不存在 / 文件损坏都不抛异常(hook 绝不能弄挂会话)", () => {
  assert.deepEqual(uploader.collectSystemPrompts("/nope/not/here", SESSION, uploader.LIMITS), [])

  const dir = tmpdir("rawbody-broken")
  fs.writeFileSync(path.join(dir, "broken.request.json"), "{not json", "utf8")
  writeRequestBody(dir, "ok.request.json", SESSION, "字符串形式的系统提示词")
  const items = uploader.collectSystemPrompts(dir, SESSION, uploader.LIMITS)
  assert.equal(items.length, 1)
  assert.equal(items[0].text, "字符串形式的系统提示词")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("uploader: 从 transcript 抽 hook additionalContext(带 hookEvent/hookName)", async () => {
  const dir = tmpdir("transcript")
  const file = path.join(dir, "session.jsonl")
  fs.writeFileSync(file, [
    JSON.stringify({ type: "user", message: { role: "user", content: "你好" }, timestamp: "2026-07-29T10:00:00.000Z" }),
    JSON.stringify({
      type: "attachment",
      timestamp: "2026-07-29T10:00:01.000Z",
      attachment: {
        type: "hook_additional_context",
        content: ["注入的上下文第一段", "第二段"],
        hookName: "my-hook",
        hookEvent: "UserPromptSubmit",
      },
    }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "好" }] } }),
  ].join("\n"), "utf8")

  const items = await uploader.collectHookContexts(file, uploader.LIMITS)
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, "hook_context")
  assert.equal(items[0].text, "注入的上下文第一段\n第二段")
  assert.equal(items[0].hookEvent, "UserPromptSubmit")
  assert.equal(items[0].hookName, "my-hook")
  assert.equal(items[0].capturedAt, "2026-07-29T10:00:01.000Z")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("uploader: hook 上下文条数与单条长度都有上限;transcript 不存在时静默返回", async () => {
  const dir = tmpdir("transcript-cap")
  const file = path.join(dir, "session.jsonl")
  const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({
    type: "attachment",
    timestamp: "2026-07-29T10:00:01.000Z",
    attachment: { type: "hook_additional_context", content: [`ctx-${i}-${"x".repeat(100)}`], hookEvent: "SessionStart" },
  }))
  fs.writeFileSync(file, lines.join("\n"), "utf8")

  const capped = await uploader.collectHookContexts(file, { ...uploader.LIMITS, hookItems: 3, textChars: 20 })
  assert.equal(capped.length, 3)
  assert.equal(capped[0].text.length, 20)

  assert.deepEqual(await uploader.collectHookContexts(path.join(dir, "missing.jsonl"), uploader.LIMITS), [])
  fs.rmSync(dir, { recursive: true, force: true })
})

test("uploader: 从 transcript 抽工具输出(tool_result 块为主,toolUseResult 兜底)", async () => {
  const dir = tmpdir("tool-output")
  const file = path.join(dir, "session.jsonl")
  fs.writeFileSync(file, [
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.txt" } }] },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-29T10:00:02.000Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "文件内容" }] }] },
    }),
    // 没有 tool_result 块、只有结构化 toolUseResult 的形状(Bash 之类)
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-29T10:00:03.000Z",
      toolUseID: "toolu_2",
      toolUseResult: { stdout: "hello\n", stderr: "", durationMs: 12 },
      message: { role: "user", content: [] },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-29T10:00:04.000Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_3", is_error: true, content: "boom" }] },
    }),
  ].join("\n"), "utf8")

  const items = await uploader.collectToolOutputs(file, uploader.LIMITS)
  const byId = Object.fromEntries(items.map((item: any) => [item.toolUseId, item]))
  assert.equal(items.length, 3)
  assert.equal(byId.toolu_1.text, "文件内容")
  assert.equal(byId.toolu_1.kind, "tool_output")
  assert.equal(byId.toolu_1.capturedAt, "2026-07-29T10:00:02.000Z")
  assert.equal(byId.toolu_2.text, "hello\n")
  assert.equal(byId.toolu_3.text, "boom")
  assert.equal(byId.toolu_3.isError, true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("uploader: 工具输出超上限时优先保留 Task 调用(否则子 agent 子树建不出来)", async () => {
  const dir = tmpdir("tool-output-cap")
  const file = path.join(dir, "session.jsonl")
  const lines: string[] = []
  // 先 10 个普通工具,最后才是 Task —— 若按出现顺序截断,Task 会被挤掉
  for (let i = 0; i < 10; i++) {
    lines.push(JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${i}`, name: "Read", input: {} }] },
    }))
    lines.push(JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: `out-${i}` }] },
    }))
  }
  lines.push(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_task", name: "Agent", input: { subagent_type: "Explore" } }] },
  }))
  lines.push(JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_task", content: "子 agent 的结论" }] },
  }))
  fs.writeFileSync(file, lines.join("\n"), "utf8")

  const items = await uploader.collectToolOutputs(file, { ...uploader.LIMITS, toolOutputs: 2 })
  assert.equal(items.length, 2)
  assert.equal(items[0].toolUseId, "toolu_task")

  const capped = await uploader.collectToolOutputs(file, { ...uploader.LIMITS, toolOutputChars: 3 })
  assert.equal(capped[0].text.length, 3)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("uploader: 一趟扫描同时拿到 hook 上下文与工具输出", async () => {
  const dir = tmpdir("scan-both")
  const file = path.join(dir, "session.jsonl")
  fs.writeFileSync(file, [
    JSON.stringify({
      type: "attachment",
      timestamp: "2026-07-29T10:00:01.000Z",
      attachment: { type: "hook_additional_context", content: ["注入"], hookEvent: "SessionStart" },
    }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "输出" }] },
    }),
  ].join("\n"), "utf8")

  const scan = await uploader.scanTranscript(file, uploader.LIMITS)
  assert.equal(scan.hookContexts.length, 1)
  assert.equal(scan.outputs.size, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("uploader: 工具输出各种形状都能拍平", () => {
  assert.equal(uploader.flattenToolOutput("纯字符串"), "纯字符串")
  assert.equal(uploader.flattenToolOutput([{ type: "text", text: "块1" }, { type: "text", text: "块2" }]), "块1\n块2")
  assert.equal(uploader.flattenToolOutput({ stdout: "标准输出" }), "标准输出")
  assert.equal(uploader.flattenToolOutput({ stdout: "", stderr: "报错了" }), "报错了")
  assert.equal(uploader.flattenToolOutput({ content: [{ type: "text", text: "嵌套" }] }), "嵌套")
  assert.equal(uploader.flattenToolOutput(null), "")
  // 认不出正文字段时整体带走,不静默丢数据
  assert.equal(uploader.flattenToolOutput({ weird: 1 }), '{"weird":1}')
})

test("uploader: host 归一化(补协议 / 去尾斜杠)", () => {
  assert.equal(uploader.normalizeHost("127.0.0.1:3000"), "http://127.0.0.1:3000")
  assert.equal(uploader.normalizeHost("https://example.com/"), "https://example.com")
  assert.equal(uploader.normalizeHost(""), "http://127.0.0.1:3000")
})

test("uploader: 子 agent 归属映射——meta.toolUseId 连父侧,uuid/内部工具都采齐,内部输出并入", () => {
  const dir = tmpdir("subagents")
  const transcript = path.join(dir, `${SESSION}.jsonl`)
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "问题" } }) + "\n", "utf8")
  const subDir = path.join(dir, SESSION, "subagents")
  fs.mkdirSync(subDir, { recursive: true })
  // 真实形状:agent-<id>.meta.json 的 toolUseId 直连父侧那条 Agent tool_use
  fs.writeFileSync(path.join(subDir, "agent-a1.meta.json"),
    JSON.stringify({ agentType: "Explore", description: "查配置", toolUseId: "call_task_1", spawnDepth: 1 }), "utf8")
  fs.writeFileSync(path.join(subDir, "agent-a1.jsonl"), [
    JSON.stringify({ type: "user", uuid: "u-sub-0", isSidechain: true, message: { role: "user", content: "找配置" } }),
    JSON.stringify({ type: "assistant", uuid: "u-sub-1", isSidechain: true, message: { role: "assistant", content: [
      { type: "text", text: "我先看目录" },
      { type: "tool_use", id: "call_inner_ls", name: "Bash", input: { command: "ls" } },
    ] } }),
    JSON.stringify({ type: "user", uuid: "u-sub-2", isSidechain: true, timestamp: "2026-07-29T12:00:03.000Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_inner_ls", content: "port.txt timeout.txt" }] } }),
    JSON.stringify({ type: "assistant", uuid: "u-sub-3", isSidechain: true, message: { role: "assistant", content: [
      { type: "text", text: "结论:端口 8931" },
    ] } }),
  ].join("\n") + "\n", "utf8")
  // 没有 toolUseId 的 meta:挂不回任何调用,应跳过
  fs.writeFileSync(path.join(subDir, "agent-a2.meta.json"), JSON.stringify({ agentType: "Explore" }), "utf8")
  fs.writeFileSync(path.join(subDir, "agent-a2.jsonl"),
    JSON.stringify({ type: "assistant", uuid: "u-orphan", message: { role: "assistant", content: [] } }) + "\n", "utf8")

  const result = uploader.collectSubagentMaps(transcript, SESSION, uploader.LIMITS)
  assert.equal(result.items.length, 1)
  const item = result.items[0]
  assert.equal(item.kind, "subagent_map")
  assert.equal(item.toolUseId, "call_task_1")
  const payload = JSON.parse(item.text)
  assert.deepEqual(payload.messageUuids, ["u-sub-1", "u-sub-3"])
  assert.deepEqual(payload.toolUseIds, ["call_inner_ls"])
  assert.equal(payload.agentType, "Explore")
  assert.equal(payload.spawnDepth, 1)
  // 内部工具输出只在子 agent jsonl 里,主 transcript 扫不到 —— 必须从这里带出
  assert.equal(result.outputs.get("call_inner_ls")?.text, "port.txt timeout.txt")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("uploader: 没有 subagents 目录时安静返回空(绝不抛错影响会话)", () => {
  const dir = tmpdir("nosub")
  const transcript = path.join(dir, `${SESSION}.jsonl`)
  fs.writeFileSync(transcript, "", "utf8")
  const result = uploader.collectSubagentMaps(transcript, SESSION, uploader.LIMITS)
  assert.equal(result.items.length, 0)
  assert.equal(result.outputs.size, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})
