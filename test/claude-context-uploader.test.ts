// 客户端补传器(scripts/claude_context_uploader.js)的抽取逻辑测试。
// 用真实数据形状造夹具:raw body 的 metadata.user_id 是一段【JSON 字符串】,里面才有 session_id;
// transcript 里 hook 注入上下文是 type=attachment / attachment.type=hook_additional_context。
import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { spawn } from "node:child_process"
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

function writeScopedRequestBody(
  dir: string,
  file: string,
  sessionId: string,
  system: unknown,
  userText: string,
  mtimeMs: number,
) {
  const target = path.join(dir, file)
  fs.writeFileSync(
    target,
    JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
      system,
      metadata: { user_id: JSON.stringify({ device_id: "d", account_uuid: "a", session_id: sessionId }) },
    }),
    "utf8",
  )
  const mtime = new Date(mtimeMs)
  fs.utimesSync(target, mtime, mtime)
}

async function waitUntil(predicate: () => boolean, message: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(message)
}

function runUploaderChild(script: string, args: string[], payload: unknown, env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "ignore", "pipe"],
    })
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`uploader exited ${code}: ${stderr}`))
    })
    child.stdin.end(JSON.stringify(payload))
  })
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

test("uploader: 内部标题请求的 system prompt 全部隐藏", () => {
  const dir = tmpdir("rawbody-title")
  writeRequestBody(
    dir,
    "title.request.json",
    SESSION,
    [
      "x-anthropic-billing-header: cc_version=2.1.220.de9; cc_entrypoint=cli;",
      "You are Claude Code, Anthropic's official CLI for Claude.",
      "Generate a concise, sentence-case title (3-7 words) for this conversation.",
    ].join("\n"),
  )

  assert.deepEqual(uploader.collectSystemPrompts(dir, SESSION, uploader.LIMITS), [])
  fs.rmSync(dir, { recursive: true, force: true })
})

test("uploader: system prompt 按任务 prompt 精确归属 root 与两个子 Agent", async () => {
  const dir = tmpdir("rawbody-scopes")
  const transcript = path.join(dir, `${SESSION}.jsonl`)
  const now = Date.now()
  fs.writeFileSync(transcript, [
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{
        type: "tool_use",
        id: "call_child_1",
        name: "Agent",
        input: { prompt: "计算 3+3", subagent_type: "general-purpose" },
      }] },
    }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{
        type: "tool_use",
        id: "call_child_2",
        name: "Task",
        input: { prompt: "计算 4×5", subagent_type: "general-purpose" },
      }] },
    }),
  ].join("\n") + "\n", "utf8")

  const subDir = path.join(dir, SESSION, "subagents")
  fs.mkdirSync(subDir, { recursive: true })
  for (const [id, toolUseId, timestamp] of [
    ["a1", "call_child_1", now + 1_000],
    ["a2", "call_child_2", now + 2_000],
  ] as const) {
    const metaPath = path.join(subDir, `agent-${id}.meta.json`)
    fs.writeFileSync(metaPath, JSON.stringify({ agentType: "general-purpose", toolUseId }), "utf8")
    fs.utimesSync(metaPath, new Date(timestamp), new Date(timestamp))
    fs.writeFileSync(
      path.join(subDir, `agent-${id}.jsonl`),
      JSON.stringify({ type: "assistant", uuid: `uuid-${id}`, message: { role: "assistant", content: [] } }) + "\n",
      "utf8",
    )
  }

  writeScopedRequestBody(dir, "root.request.json", SESSION, "root system", "用户问题", now)
  writeScopedRequestBody(
    dir,
    "child-1.request.json",
    SESSION,
    "child system\ncc_is_subagent=true",
    "前置提醒\n计算 3+3",
    now + 1_000,
  )
  writeScopedRequestBody(
    dir,
    "child-2.request.json",
    SESSION,
    "child system\ncc_is_subagent=true",
    "前置提醒\n计算 4×5",
    now + 2_000,
  )

  const scan = await uploader.scanTranscript(transcript, uploader.LIMITS)
  const subagents = uploader.collectSubagentMaps(transcript, SESSION, uploader.LIMITS)
  const items = uploader.collectSystemPrompts(dir, SESSION, uploader.LIMITS, {
    agentCalls: scan.agentCalls,
    subagentScopes: subagents.scopes,
  })
  assert.equal(items.length, 3, "两个正文相同的 child system 也必须按 toolUseId 各传一份")
  const root = items.find((item: any) => !item.toolUseId)
  assert.equal(root?.text, "root system")
  const children = items.filter((item: any) => item.toolUseId).sort((a: any, b: any) => a.toolUseId.localeCompare(b.toolUseId))
  assert.deepEqual(children.map((item: any) => [item.toolUseId, item.agentType]), [
    ["call_child_1", "general-purpose"],
    ["call_child_2", "general-purpose"],
  ])
  fs.rmSync(dir, { recursive: true, force: true })
})

test("uploader: 子 Agent system prompt 仅在有界 mtime 内兜底且不误挂 root", () => {
  const dir = tmpdir("rawbody-scope-fallback")
  const now = Date.now()
  writeScopedRequestBody(
    dir,
    "near.request.json",
    SESSION,
    "near child\ncc_is_subagent=true",
    "没有可精确匹配的正文",
    now + 5_000,
  )
  writeScopedRequestBody(
    dir,
    "far.request.json",
    SESSION,
    "far child\ncc_is_subagent=true",
    "仍然无法匹配",
    now + 120_000,
  )

  const items = uploader.collectSystemPrompts(dir, SESSION, uploader.LIMITS, {
    agentCalls: new Map(),
    subagentScopes: [{ toolUseId: "call_near", agentType: "Explore", mtimeMs: now }],
  })
  assert.deepEqual(items.map((item: any) => [item.text, item.toolUseId]), [
    ["near child\ncc_is_subagent=true", "call_near"],
  ])
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

test("uploader: 安装四类 hook 且幂等,升级旧 SessionEnd 时不覆盖用户 hook", () => {
  const dir = tmpdir("hooks")
  const settingsPath = path.join(dir, "settings.json")
  fs.writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      Stop: [{ matcher: "user", hooks: [{ type: "command", command: "echo user-stop" }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: "node /old/claude_context_uploader.js", timeout: 30 }] }],
    },
  }), "utf8")

  const command = '"/usr/bin/node" "/tmp/claude_context_uploader.cjs"'
  assert.equal(uploader.installHook({ settingsPath, command, quiet: true }), true)

  const installed = JSON.parse(fs.readFileSync(settingsPath, "utf8"))
  for (const event of ["Stop", "SubagentStop", "StopFailure"]) {
    const ours = installed.hooks[event]
      .flatMap((matcher: any) => matcher.hooks || [])
      .filter((hook: any) => hook.command?.includes("claude_context_uploader"))
    assert.equal(ours.length, 1, `${event} 应只有一条补传 hook`)
    assert.equal(ours[0].command, `${command} --enqueue`)
    assert.equal(ours[0].timeout, 5)
  }
  const finalHooks = installed.hooks.SessionEnd
    .flatMap((matcher: any) => matcher.hooks || [])
    .filter((hook: any) => hook.command?.includes("claude_context_uploader"))
  assert.equal(finalHooks.length, 1)
  assert.equal(finalHooks[0].command, command)
  assert.equal(finalHooks[0].timeout, 30)
  assert.ok(installed.hooks.Stop.some((matcher: any) =>
    (matcher.hooks || []).some((hook: any) => hook.command === "echo user-stop")))

  assert.equal(uploader.installHook({ settingsPath, command, quiet: true }), false, "重复安装必须零改动")

  assert.equal(uploader.uninstallHook({ settingsPath, quiet: true }), true)
  const uninstalled = JSON.parse(fs.readFileSync(settingsPath, "utf8"))
  assert.ok(uninstalled.hooks.Stop.some((matcher: any) =>
    (matcher.hooks || []).some((hook: any) => hook.command === "echo user-stop")))
  for (const event of ["Stop", "SubagentStop", "StopFailure", "SessionEnd"]) {
    const commands = (uninstalled.hooks[event] || [])
      .flatMap((matcher: any) => matcher.hooks || [])
      .map((hook: any) => hook.command || "")
    assert.equal(commands.some((value: string) => value.includes("claude_context_uploader")), false)
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

test("uploader: 实时 hook 只做本地原子入队,同 session 合并为最新任务", () => {
  const dir = tmpdir("queue")
  let spawned = 0
  const options = { queueDir: dir, spawnWorker: () => { spawned += 1 } }

  assert.equal(uploader.enqueuePayload({
    session_id: SESSION,
    transcript_path: "/tmp/old.jsonl",
    hook_event_name: "Stop",
  }, options), true)
  assert.equal(uploader.enqueuePayload({
    session_id: SESSION,
    transcript_path: "/tmp/new.jsonl",
    hook_event_name: "SubagentStop",
    last_assistant_message: "不应复制进队列".repeat(1000),
  }, options), true)

  const jobs = fs.readdirSync(dir).filter((name) => name.endsWith(".json"))
  assert.equal(jobs.length, 1)
  const payload = JSON.parse(fs.readFileSync(path.join(dir, jobs[0]), "utf8"))
  assert.equal(payload.session_id, SESSION)
  assert.equal(payload.transcript_path, "/tmp/new.jsonl")
  assert.equal(payload.hook_event_name, "SubagentStop")
  assert.equal("last_assistant_message" in payload, false)
  assert.equal(spawned, 1)
  assert.equal(fs.readdirSync(dir).some((name) => name.includes(".tmp-")), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("uploader: 300 次 burst 入队只启动一个 worker 且保留每个 Session 最新任务", () => {
  const dir = tmpdir("queue-burst")
  let spawned = 0
  const options = { queueDir: dir, spawnWorker: () => { spawned += 1; return true } }

  for (let i = 0; i < 300; i++) {
    const sessionId = `burst-session-${i}`
    uploader.enqueuePayload({ session_id: sessionId, transcript_path: `/tmp/${i}-old.jsonl` }, options)
    uploader.enqueuePayload({ session_id: sessionId, transcript_path: `/tmp/${i}-latest.jsonl` }, options)
  }

  assert.equal(spawned, 1)
  const jobs = fs.readdirSync(dir).filter((name) => /^job-.*\.json$/.test(name))
  assert.equal(jobs.length, 300)
  const paths = jobs.map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")).transcript_path)
  assert.ok(paths.every((value: string) => value.endsWith("-latest.jsonl")))
  fs.rmSync(dir, { recursive: true, force: true })
})

test("uploader: worker 结束释放启动令牌后新 enqueue 可再次启动", async () => {
  const dir = tmpdir("queue-worker-release")
  let spawned = 0
  const spawnWorker = () => { spawned += 1; return true }
  uploader.enqueuePayload({ session_id: SESSION, transcript_path: "/tmp/first.jsonl" }, { queueDir: dir, spawnWorker })
  assert.equal(spawned, 1)

  const drained = await uploader.drainQueue({ queueDir: dir, processPayload: async () => true, spawnWorker })
  assert.equal(drained.processed, 1)
  assert.equal(fs.existsSync(path.join(dir, ".worker-starting")), false)

  uploader.enqueuePayload({ session_id: SESSION, transcript_path: "/tmp/second.jsonl" }, { queueDir: dir, spawnWorker })
  assert.equal(spawned, 2)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("uploader: 新鲜 worker 启动令牌不可抢占,超时令牌可恢复", () => {
  const freshDir = tmpdir("queue-worker-fresh")
  fs.writeFileSync(path.join(freshDir, ".worker-starting"), "{}", "utf8")
  let freshSpawns = 0
  uploader.enqueuePayload({ session_id: SESSION, transcript_path: "/tmp/fresh.jsonl" }, {
    queueDir: freshDir,
    spawnWorker: () => { freshSpawns += 1; return true },
  })
  assert.equal(freshSpawns, 0)
  fs.rmSync(freshDir, { recursive: true, force: true })

  const staleDir = tmpdir("queue-worker-stale")
  const token = path.join(staleDir, ".worker-starting")
  fs.writeFileSync(token, "{}", "utf8")
  const staleTime = new Date(Date.now() - 60_000)
  fs.utimesSync(token, staleTime, staleTime)
  let staleSpawns = 0
  uploader.enqueuePayload({ session_id: SESSION, transcript_path: "/tmp/stale.jsonl" }, {
    queueDir: staleDir,
    spawnWorker: () => { staleSpawns += 1; return true },
  })
  assert.equal(staleSpawns, 1)
  assert.ok(fs.statSync(token).mtimeMs > staleTime.getTime())
  fs.rmSync(staleDir, { recursive: true, force: true })
})

test("uploader: worker spawn 失败立即释放令牌,下一次 hook 能重试", () => {
  const dir = tmpdir("queue-worker-spawn-failure")
  let attempts = 0
  const spawnWorker = () => {
    attempts += 1
    return attempts > 1
  }

  uploader.enqueuePayload({ session_id: SESSION, transcript_path: "/tmp/failed.jsonl" }, { queueDir: dir, spawnWorker })
  assert.equal(fs.existsSync(path.join(dir, ".worker-starting")), false)
  uploader.enqueuePayload({ session_id: SESSION, transcript_path: "/tmp/retry.jsonl" }, { queueDir: dir, spawnWorker })
  assert.equal(attempts, 2)
  assert.equal(fs.existsSync(path.join(dir, ".worker-starting")), true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("uploader: worker 成功删除任务,失败保留并可由下一次 drain 重试", async () => {
  const dir = tmpdir("drain-retry")
  const enqueueOptions = { queueDir: dir, spawnWorker: () => {} }
  uploader.enqueuePayload({ session_id: SESSION, transcript_path: "/tmp/a.jsonl" }, enqueueOptions)

  let attempts = 0
  const failed = await uploader.drainQueue({
    queueDir: dir,
    processPayload: async () => {
      attempts += 1
      return false
    },
    spawnWorker: () => {},
  })
  assert.equal(failed.failed, 1)
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith(".json")).length, 1)

  const succeeded = await uploader.drainQueue({
    queueDir: dir,
    processPayload: async () => {
      attempts += 1
      return true
    },
    spawnWorker: () => {},
  })
  assert.equal(succeeded.processed, 1)
  assert.equal(succeeded.failed, 0)
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith(".json")).length, 0)
  assert.equal(attempts, 2)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("uploader: 旧任务上传失败时并发到达的新 Stop 会补起 worker,不会卡到再下一轮", async () => {
  const dir = tmpdir("drain-failure-race")
  uploader.enqueuePayload({ session_id: SESSION, transcript_path: "/tmp/old.jsonl" }, {
    queueDir: dir,
    spawnWorker: () => {},
  })
  let spawned = 0
  const result = await uploader.drainQueue({
    queueDir: dir,
    processPayload: async () => {
      uploader.enqueuePayload({ session_id: SESSION, transcript_path: "/tmp/new.jsonl" }, {
        queueDir: dir,
        spawnWorker: () => {}, // 模拟它起的 worker 看到当前锁后立即退出
      })
      return false
    },
    spawnWorker: () => { spawned += 1 },
  })

  assert.equal(result.failed, 1)
  assert.equal(spawned, 1, "持锁 worker 释放锁后必须为并发新任务补起 worker")
  const jobs = fs.readdirSync(dir).filter((name) => name.endsWith(".json"))
  assert.equal(jobs.length, 1)
  const payload = JSON.parse(fs.readFileSync(path.join(dir, jobs[0]), "utf8"))
  assert.equal(payload.transcript_path, "/tmp/new.jsonl")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("uploader: SessionEnd 也走同一队列锁,不会与 Stop worker 并发覆盖 checkpoint", async () => {
  const dir = tmpdir("session-end-lock")
  uploader.enqueuePayload({ session_id: SESSION, transcript_path: "/tmp/old.jsonl" }, {
    queueDir: dir,
    spawnWorker: () => {},
  })

  let releaseFirst: (() => void) | undefined
  let markStarted: (() => void) | undefined
  const firstStarted = new Promise<void>((resolve) => { markStarted = resolve })
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  let active = 0
  let maxActive = 0
  let followupSpawns = 0
  const firstDrain = uploader.drainQueue({
    queueDir: dir,
    processPayload: async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      markStarted!()
      await firstGate
      active -= 1
      return true
    },
    spawnWorker: () => { followupSpawns += 1 },
  })
  await firstStarted

  let sessionEndUploads = 0
  const sessionEnd = await uploader.handleSessionEnd({
    session_id: SESSION,
    transcript_path: "/tmp/final.jsonl",
  }, {
    queueDir: dir,
    processPayload: async () => {
      sessionEndUploads += 1
      return true
    },
    spawnWorker: () => { followupSpawns += 1 },
  })
  assert.equal(sessionEnd.locked, true)
  assert.equal(sessionEndUploads, 0, "持锁 worker 未结束时 SessionEnd 不得并发上传")

  releaseFirst!()
  await firstDrain
  assert.equal(maxActive, 1)
  assert.equal(followupSpawns, 1, "原 worker 释放锁后应为已落盘的 SessionEnd 任务补 worker")

  const finalDrain = await uploader.drainQueue({
    queueDir: dir,
    processPayload: async (payload: any) => {
      sessionEndUploads += 1
      assert.equal(payload.transcript_path, "/tmp/final.jsonl")
      return true
    },
    spawnWorker: () => {},
  })
  assert.equal(finalDrain.processed, 1)
  assert.equal(sessionEndUploads, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("uploader: worker 能回收已退出进程留下的陈旧锁", async () => {
  const dir = tmpdir("drain-stale-lock")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, ".drain.lock"), JSON.stringify({
    pid: 99999999,
    createdAt: "2000-01-01T00:00:00.000Z",
  }), "utf8")
  uploader.enqueuePayload({ session_id: SESSION, transcript_path: "/tmp/a.jsonl" }, {
    queueDir: dir,
    spawnWorker: () => {},
  })

  const result = await uploader.drainQueue({
    queueDir: dir,
    processPayload: async () => true,
    spawnWorker: () => {},
  })
  assert.equal(result.processed, 1)
  assert.equal(fs.existsSync(path.join(dir, ".drain.lock")), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("uploader: worker 崩溃后遗留的 processing 任务会被下一任 worker 回收", async () => {
  const dir = tmpdir("drain-orphan")
  uploader.enqueuePayload({ session_id: SESSION, transcript_path: "/tmp/a.jsonl" }, {
    queueDir: dir,
    spawnWorker: () => {},
  })
  const job = fs.readdirSync(dir).find((name) => name.endsWith(".json"))
  assert.ok(job)
  fs.renameSync(path.join(dir, job), path.join(dir, `${job}.processing-dead-worker`))

  const result = await uploader.drainQueue({
    queueDir: dir,
    processPayload: async () => true,
    spawnWorker: () => {},
  })
  assert.equal(result.processed, 1)
  assert.equal(fs.readdirSync(dir).some((name) => name.includes(".processing-")), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("uploader: checkpoint 字节偏移后只扫描 transcript 新增 JSONL", async () => {
  const dir = tmpdir("incremental")
  const file = path.join(dir, "session.jsonl")
  const initial = [
    JSON.stringify({
      type: "attachment",
      timestamp: "2026-07-29T10:00:01.000Z",
      attachment: { type: "hook_additional_context", content: ["中文注入"], hookEvent: "SessionStart" },
    }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "完成" }] } }),
  ].join("\n") + "\n"
  fs.writeFileSync(file, initial, "utf8")

  const first = await uploader.scanTranscript(file, uploader.LIMITS)
  assert.equal(first.hookContexts.length, 1)
  assert.equal(first.nextOffset, Buffer.byteLength(initial))

  const appended = JSON.stringify({
    type: "user",
    timestamp: "2026-07-29T10:00:02.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_new", content: "新增输出" }] },
  }) + "\n"
  fs.appendFileSync(file, appended, "utf8")

  const second = await uploader.scanTranscript(file, uploader.LIMITS, { startOffset: first.nextOffset })
  assert.equal(second.hookContexts.length, 0, "旧 hook 不应被重复扫描")
  assert.equal(second.outputs.size, 1)
  assert.equal(second.outputs.get("toolu_new")?.text, "新增输出")
  assert.equal(second.nextOffset, Buffer.byteLength(initial + appended))
  fs.rmSync(dir, { recursive: true, force: true })
})

test("uploader: transcript 尾部正在写的半条 JSON 不推进 checkpoint", async () => {
  const dir = tmpdir("partial-jsonl")
  const file = path.join(dir, "session.jsonl")
  const complete = JSON.stringify({ type: "assistant", message: { role: "assistant", content: "完成" } }) + "\n"
  const finalLine = JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_partial", content: "完整输出" }] },
  })
  const split = Math.floor(finalLine.length / 2)
  fs.writeFileSync(file, complete + finalLine.slice(0, split), "utf8")

  const whileWriting = await uploader.scanTranscript(file, uploader.LIMITS)
  assert.equal(whileWriting.nextOffset, Buffer.byteLength(complete))
  assert.equal(whileWriting.outputs.size, 0)

  fs.appendFileSync(file, finalLine.slice(split) + "\n", "utf8")
  const afterWrite = await uploader.scanTranscript(file, uploader.LIMITS, { startOffset: whileWriting.nextOffset })
  assert.equal(afterWrite.outputs.get("toolu_partial")?.text, "完整输出")
  assert.equal(afterWrite.nextOffset, fs.statSync(file).size)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("uploader: --enqueue 子进程不等待网络,detached worker 每轮上传且第二轮只发增量", async (t) => {
  const dir = tmpdir("worker-e2e")
  let server: ReturnType<typeof http.createServer> | undefined
  t.after(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const insightDir = path.join(dir, ".agent-insight")
  const rawDir = path.join(insightDir, "claude_raw_bodies")
  const transcript = path.join(dir, `${SESSION}.jsonl`)
  fs.mkdirSync(rawDir, { recursive: true })
  writeRequestBody(rawDir, "turn-1.request.json", SESSION, [{ type: "text", text: "实时 system" }])
  fs.writeFileSync(transcript, [
    JSON.stringify({
      type: "attachment",
      timestamp: "2026-07-29T10:00:01.000Z",
      attachment: { type: "hook_additional_context", content: ["实时 hook"], hookEvent: "UserPromptSubmit" },
    }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_turn_1", name: "Read", input: {} }] },
    }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_turn_1", content: "第一轮输出" }] },
    }),
  ].join("\n") + "\n", "utf8")

  const requests: any[] = []
  let releaseFirstResponse: (() => void) | undefined
  const firstResponseGate = new Promise<void>((resolve) => { releaseFirstResponse = resolve })
  server = http.createServer((req, res) => {
    let body = ""
    req.setEncoding("utf8")
    req.on("data", (chunk) => { body += chunk })
    req.on("end", async () => {
      requests.push(JSON.parse(body))
      if (requests.length === 1) await firstResponseGate
      res.statusCode = 200
      res.end("{}")
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const mockHost = `http://127.0.0.1:${address.port}`
  fs.writeFileSync(path.join(insightDir, ".env"), [
    `AGENT_INSIGHT_HOST=${mockHost}`,
    "AGENT_INSIGHT_API_KEY=test-key",
    `AGENT_INSIGHT_CLAUDE_OTEL_RAW_API_BODIES=file:${rawDir}`,
  ].join("\n") + "\n", "utf8")

  const script = path.join(process.cwd(), "scripts", "claude_context_uploader.js")
  // conf() 优先读 process.env；本地/CI 常已注入 AGENT_INSIGHT_HOST（如 localhost:3000），
  // 若不在 childEnv 覆盖，detached worker 会打到真实服务而测试 mock server 收不到请求。
  const childEnv = {
    ...process.env,
    HOME: dir,
    USERPROFILE: dir,
    AGENT_INSIGHT_HOST: mockHost,
    AGENT_INSIGHT_API_KEY: "test-key",
    AGENT_INSIGHT_CLAUDE_OTEL_RAW_API_BODIES: `file:${rawDir}`,
  }
  const hookPayload = { session_id: SESSION, transcript_path: transcript, hook_event_name: "Stop" }

  // 服务端故意不响应;若 --enqueue 仍同步等网络,这个子进程就不会先退出。
  await runUploaderChild(script, ["--enqueue"], hookPayload, childEnv)
  await waitUntil(() => requests.length === 1, "detached worker 未收到第一轮任务")
  releaseFirstResponse!()
  const queueDir = path.join(insightDir, "claude_context_queue")
  await waitUntil(
    () => fs.existsSync(queueDir)
      && fs.readdirSync(queueDir).filter((name) => name.endsWith(".json") || name.includes(".processing-")).length === 0,
    "第一轮成功后队列任务未删除",
  )

  const firstKinds = requests[0].items.map((item: any) => item.kind).sort()
  assert.deepEqual(firstKinds, ["hook_context", "system_prompt", "tool_output"])
  const checkpointName = fs.readdirSync(insightDir).find((name) => name.startsWith("claude_context_checkpoint_"))
  assert.ok(checkpointName)
  assert.equal(fs.statSync(path.join(insightDir, checkpointName)).mode & 0o777, 0o600)

  fs.appendFileSync(transcript, [
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_turn_2", name: "Bash", input: {} }] },
    }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_turn_2", content: "第二轮输出" }] },
    }),
  ].join("\n") + "\n", "utf8")
  await runUploaderChild(script, ["--enqueue"], hookPayload, childEnv)
  await waitUntil(() => requests.length === 2, "detached worker 未收到第二轮任务")
  assert.deepEqual(requests[1].items.map((item: any) => item.kind), ["tool_output"])
  assert.equal(requests[1].items[0].toolUseId, "toolu_turn_2")
  await waitUntil(
    () => fs.readdirSync(queueDir).filter((name) => name.endsWith(".json") || name.includes(".processing-")).length === 0,
    "第二轮 worker 未完成 checkpoint 与队列收尾",
  )
  const finalCheckpoint = JSON.parse(fs.readFileSync(path.join(insightDir, checkpointName), "utf8"))
  assert.equal(finalCheckpoint.sessions[SESSION].transcriptOffset, fs.statSync(transcript).size)

  await new Promise<void>((resolve) => server!.close(() => resolve()))
})
