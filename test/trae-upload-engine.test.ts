import test from "node:test"
import assert from "node:assert/strict"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import Module, { createRequire } from "node:module"
import { SpoolReader } from "../scripts/trae-collector/src/uploader/spool"

// ============================================================================
// AC20/AC21/AC22/AC23: UploadEngine 上传循环（mock fetch，不依赖真实网络/TRAE）
//
// 既有测试只验证了 buildSignature / 退避数学；这里把 uploadAll() 的真身跑起来：
//   - AC20: 定时扫描触发上传（uploadAll 扫描 spool 并 POST /api/ingest/upload）
//   - AC22: checkpoint 去重 —— 内容不变不重复上传；内容变更后重传并更新 checkpoint
//   - AC23: 失败重试（指数退避）+ 全部失败时不写 checkpoint
//
// 隔离手段：
//   1. Module._load 拦截 'vscode'（upload-engine 顶层 import，node 环境无此模块）
//   2. process.env.HOME 指向临时目录 —— checkpoint 文件路径来自 os.homedir()
//   3. globalThis.fetch 替换为 stub，记录调用
// ============================================================================

// --- vscode stub：upload-engine 只在 loadDefaultConfig/getConfig 里读配置，
//    测试显式传 config，stub 的 get() 返回默认值即可（host/apiKey 用 `|| this.config.x` 保留）。 ---
const vscodeStub = {
  workspace: {
    getConfiguration: () => ({ get: (_key: string, def: unknown) => def }),
  },
  Disposable: class {
    dispose() {}
  },
}

const originalLoad = (Module as any)._load
;(Module as any)._load = function (this: any, request: string, parent: any, isMain: boolean) {
  if (request === "vscode") return vscodeStub
  return originalLoad.call(this, request, parent, isMain)
}

// 必须在 import upload-engine 之前拦截；upload-engine 走 CJS require → Module._load 生效。
const requireFromTest = createRequire(__filename)
const { UploadEngine } = requireFromTest("../scripts/trae-collector/src/uploader/upload-engine") as typeof import("../scripts/trae-collector/src/uploader/upload-engine")

const HOST = "http://test.local"

interface FetchCall {
  url: string
  init?: { method?: string; headers?: Record<string, string>; body?: string }
}

type FetchResponder = (call: FetchCall, index: number) => { ok: boolean; status: number }

function makeFetchStub(calls: FetchCall[], responder: FetchResponder) {
  return async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const call: FetchCall = { url, init }
    calls.push(call)
    const res = responder(call, calls.length - 1)
    return { ok: res.ok, status: res.status, text: async () => "{}" }
  }
}

function writeSessionSpool(spoolDir: string, extraLines: string[] = []): string {
  const file = path.join(spoolDir, "trae-otel-test.jsonl")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lines = [
    { t: "2026-01-01T00:00:00.000Z", kind: "agent.session.start", sessionID: "sess1", trace_id: "sess1", agent_id: "solo_agent", agent_type: "solo_agent", payload: { source: "startup" } },
    { t: "2026-01-01T00:00:01.000Z", kind: "agent.prompt", sessionID: "sess1", trace_id: "sess1", agent_id: "solo_agent", agent_type: "solo_agent", payload: { query: "hello" } },
    { t: "2026-01-01T00:00:02.000Z", kind: "agent.response", sessionID: "sess1", trace_id: "sess1", agent_id: "solo_agent", agent_type: "solo_agent", payload: { finalResult: "hi" } },
    { t: "2026-01-01T00:00:03.000Z", kind: "agent.session.stop", sessionID: "sess1", trace_id: "sess1", agent_id: "solo_agent", agent_type: "solo_agent", payload: { reason: "stop-hook" } },
    ...extraLines.map((l) => JSON.parse(l)),
  ]
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
  return file
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true, host: HOST, apiKey: "test-key",
    uploadIntervalMs: 30000, requestTimeoutMs: 1000, maxRetries: 3, retryBaseDelayMs: 1,
    llmEnabled: true, llmPollIntervalMs: 30000, logLevel: "error", spoolDir: "",
    heartbeatEnabled: true, heartbeatIntervalMs: 30000, modelName: "",
    ...overrides,
  }
}

function setup(): { tmpHome: string; spoolDir: string; checkpointFile: string; origHome: string | undefined } {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "trae-ue-home-"))
  const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "trae-ue-spool-"))
  const checkpointFile = path.join(tmpHome, ".agent-insight", "trae_uploader_checkpoint.json")
  const origHome = process.env.HOME
  process.env.HOME = tmpHome
  return { tmpHome, spoolDir, checkpointFile, origHome }
}

function cleanup(t: { after(fn: () => void): void }, tmpHome: string, spoolDir: string, origHome: string | undefined) {
  t.after(() => {
    process.env.HOME = origHome
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.rmSync(spoolDir, { recursive: true, force: true })
  })
}

/** 把文件 mtime 置为未来，确定性绕过 uploadAll 的 mtime fast-skip（同毫秒竞争防护） */
function bumpMtime(file: string) {
  const future = new Date(Date.now() + 5000)
  fs.utimesSync(file, future, future)
}

const originalFetch = (globalThis as any).fetch

// ============================================================================
// AC20: spool 有完整会话 → uploadAll 立即上传，URL/header/载荷正确
// ============================================================================
test("AC20: uploadAll 上传完整会话到 /api/ingest/upload（URL/header/载荷正确）", async (t) => {
  const { tmpHome, spoolDir, checkpointFile, origHome } = setup()
  const calls: FetchCall[] = []
  ;(globalThis as any).fetch = makeFetchStub(calls, () => ({ ok: true, status: 200 }))
  cleanup(t, tmpHome, spoolDir, origHome, calls)
  try {
    writeSessionSpool(spoolDir)
    const engine = new UploadEngine(new SpoolReader(spoolDir), () => {}, makeConfig())
    await engine.uploadAll()

    assert.equal(calls.length, 1, "完整会话应上传 1 次")
    assert.equal(calls[0].url, `${HOST}/api/ingest/upload`)
    assert.equal(calls[0].init?.method, "POST")
    assert.equal(calls[0].init?.headers?.["x-witty-api-key"], "test-key")
    assert.equal(calls[0].init?.headers?.["Content-Type"], "application/json")

    const body = JSON.parse(calls[0].init!.body!)
    assert.equal(body.framework, "trae")
    assert.equal(body.task_id, "sess1")
    assert.equal(body.query, "hello")
    assert.equal(body.completed, true)

    // checkpoint 已写入（AC22 的断点基础）
    assert.ok(fs.existsSync(checkpointFile), "checkpoint 文件应写入")
    const ckpt = JSON.parse(fs.readFileSync(checkpointFile, "utf8"))
    assert.ok(ckpt["sess1"]?.signature, "checkpoint 应记录 sess1 的 signature")
    assert.ok(ckpt["sess1"]?.uploadedAt, "checkpoint 应记录上传时间")
  } finally {
    ;(globalThis as any).fetch = originalFetch
  }
})

// ============================================================================
// AC22: 内容不变（仅 mtime 变化）→ 不重复上传（checkpoint 去重）
// ============================================================================
test("AC22: 会话内容不变时重复扫描不重复上传（checkpoint 去重）", async (t) => {
  const { tmpHome, spoolDir, checkpointFile, origHome } = setup()
  const calls: FetchCall[] = []
  ;(globalThis as any).fetch = makeFetchStub(calls, () => ({ ok: true, status: 200 }))
  cleanup(t, tmpHome, spoolDir, origHome, calls)
  try {
    const file = writeSessionSpool(spoolDir)
    const engine = new UploadEngine(new SpoolReader(spoolDir), () => {}, makeConfig())
    await engine.uploadAll()
    assert.equal(calls.length, 1)

    // 只更新 mtime（绕过 uploadAll 的 mtime fast-skip），内容不变 → checkpoint 去重
    bumpMtime(file)
    await engine.uploadAll()
    assert.equal(calls.length, 1, "内容不变不应重复上传")
    const ckpt = JSON.parse(fs.readFileSync(checkpointFile, "utf8"))
    assert.ok(ckpt["sess1"], "checkpoint 应保留记录")
  } finally {
    ;(globalThis as any).fetch = originalFetch
  }
})

// ============================================================================
// AC22: 会话内容变更 → 重新上传并更新 checkpoint（断点续传的"续"）
// ============================================================================
test("AC22: 会话新增事件后重新上传并更新 checkpoint", async (t) => {
  const { tmpHome, spoolDir, checkpointFile, origHome } = setup()
  const calls: FetchCall[] = []
  ;(globalThis as any).fetch = makeFetchStub(calls, () => ({ ok: true, status: 200 }))
  cleanup(t, tmpHome, spoolDir, origHome, calls)
  try {
    writeSessionSpool(spoolDir)
    const engine = new UploadEngine(new SpoolReader(spoolDir), () => {}, makeConfig())
    await engine.uploadAll()
    assert.equal(calls.length, 1)
    const sigBefore = JSON.parse(fs.readFileSync(checkpointFile, "utf8"))["sess1"].signature

    // 追加一轮问答 → signature 变化 → 重传
    const file = writeSessionSpool(spoolDir, [
      JSON.stringify({ t: "2026-01-01T00:00:04.000Z", kind: "agent.prompt", sessionID: "sess1", trace_id: "sess1", payload: { query: "再来一轮" } }),
      JSON.stringify({ t: "2026-01-01T00:00:05.000Z", kind: "agent.response", sessionID: "sess1", trace_id: "sess1", payload: { finalResult: "好的" } }),
      JSON.stringify({ t: "2026-01-01T00:00:06.000Z", kind: "agent.session.stop", sessionID: "sess1", trace_id: "sess1", payload: { reason: "stop-hook" } }),
    ])
    bumpMtime(file)
    await engine.uploadAll()

    assert.equal(calls.length, 2, "内容变更后应重新上传")
    const body2 = JSON.parse(calls[1].init!.body!)
    assert.equal(body2.task_id, "sess1")
    const sigAfter = JSON.parse(fs.readFileSync(checkpointFile, "utf8"))["sess1"].signature
    assert.notEqual(sigAfter, sigBefore, "checkpoint signature 应随内容更新")
  } finally {
    ;(globalThis as any).fetch = originalFetch
  }
})

// ============================================================================
// AC5/AC14/AC15/AC16: 上传载荷的 model/tokens/latency/模型切换字段
// ============================================================================
test("AC5/AC14/AC15/AC16: 上传载荷包含 model/tokens/latency 与模型切换记录", async (t) => {
  const { tmpHome, spoolDir, checkpointFile, origHome } = setup()
  const calls: FetchCall[] = []
  ;(globalThis as any).fetch = makeFetchStub(calls, () => ({ ok: true, status: 200 }))
  cleanup(t, tmpHome, spoolDir, origHome, calls)
  try {
    writeSessionSpool(spoolDir, [
      JSON.stringify({ t: "2026-01-01T00:00:01.500Z", kind: "llm.call", sessionID: "sess1", trace_id: "llm_1", payload: { model: "gpt-4o", provider: "openai", promptTokens: 100, completionTokens: 50, tokens: 150, totalTokens: 150, latencyMs: 2000 } }),
      JSON.stringify({ t: "2026-01-01T00:00:02.500Z", kind: "llm.call", sessionID: "sess1", trace_id: "llm_2", payload: { model: "claude-3-5-sonnet", provider: "anthropic", promptTokens: 150, completionTokens: 80, tokens: 230, totalTokens: 230, latencyMs: 1500 } }),
    ])
    const engine = new UploadEngine(new SpoolReader(spoolDir), () => {}, makeConfig())
    await engine.uploadAll()

    assert.equal(calls.length, 1)
    const body = JSON.parse(calls[0].init!.body!)

    assert.equal(body.model, "gpt-4o", "AC5: model 应取首个 llm.call 的模型")
    assert.equal(body.tokens, 150, "AC5: totalTokens 应取首个 llm.call 的 totalTokens")
    assert.equal(body.latency, 2, "AC5: latency 应为 start→response 秒级差")
    assert.equal(body.final_result, "hi", "AC5: result 应包含最终结果")

    assert.equal(body.llm_call_count, 2, "AC14: llm_call_count 应为 2")
    assert.equal(body.input_tokens, 250, "AC15: input_tokens 应为两次调用求和")
    assert.equal(body.output_tokens, 130, "AC15: output_tokens 应为两次调用求和")
    assert.equal(body.llm_details.length, 2, "AC14: llm_details 应含两条")
    assert.equal(body.llm_details[0].provider, "openai", "AC14: provider 应记录")

    assert.deepEqual(body.model_sequence, ["gpt-4o", "claude-3-5-sonnet"], "AC16: model_sequence 应记录切换序列")
    assert.equal(body.model_switched, true, "AC16: model_switched 应为 true")
  } finally {
    ;(globalThis as any).fetch = originalFetch
  }
})

// ============================================================================
// AC5/AC14: 真实链路形态 —— TRAE hook 的 llm.call 不含 model，
// model 只能来自 agentInsight.trae.modelName 配置兜底（与 stop.sh 真实输出对齐）
// ============================================================================
test("AC5/AC14: llm.call 无 model 时回退到配置 modelName（真实链路形态）", async (t) => {
  const { tmpHome, spoolDir, checkpointFile, origHome } = setup()
  const calls: FetchCall[] = []
  ;(globalThis as any).fetch = makeFetchStub(calls, () => ({ ok: true, status: 200 }))
  cleanup(t, tmpHome, spoolDir, origHome, calls)
  try {
    // llm.call 与 stop.sh 真实输出一致：无 model/provider 字段
    writeSessionSpool(spoolDir, [
      JSON.stringify({ t: "2026-01-01T00:00:01.500Z", kind: "llm.call", sessionID: "sess1", trace_id: "llm_1", payload: { promptTokens: 37, completionTokens: 75, tokens: 112, totalTokens: 112, latencyMs: 0, estimated: true } }),
    ])
    const engine = new UploadEngine(new SpoolReader(spoolDir), () => {}, makeConfig({ modelName: "deepseek-v3" }))
    await engine.uploadAll()

    assert.equal(calls.length, 1)
    const body = JSON.parse(calls[0].init!.body!)
    assert.equal(body.model, "deepseek-v3", "AC5: model 应回退到配置的 modelName")
    assert.equal(body.tokens, 112, "AC5: totalTokens 应透传 llm.call 估算值")
  } finally {
    ;(globalThis as any).fetch = originalFetch
  }
})

test("AC5/AC14: llm.call 无 model 且未配置时 model 为空（对齐真实 DB 记录）", async (t) => {
  const { tmpHome, spoolDir, checkpointFile, origHome } = setup()
  const calls: FetchCall[] = []
  ;(globalThis as any).fetch = makeFetchStub(calls, () => ({ ok: true, status: 200 }))
  cleanup(t, tmpHome, spoolDir, origHome, calls)
  try {
    writeSessionSpool(spoolDir, [
      JSON.stringify({ t: "2026-01-01T00:00:01.500Z", kind: "llm.call", sessionID: "sess1", trace_id: "llm_1", payload: { promptTokens: 37, completionTokens: 75, tokens: 112, totalTokens: 112, estimated: true } }),
    ])
    const engine = new UploadEngine(new SpoolReader(spoolDir), () => {}, makeConfig({ modelName: "" }))
    await engine.uploadAll()

    assert.equal(calls.length, 1)
    const body = JSON.parse(calls[0].init!.body!)
    assert.equal(body.model, "", "AC5: 未配置 modelName 时 model 应为空（与真实 DB 一致）")
  } finally {
    ;(globalThis as any).fetch = originalFetch
  }
})

// ============================================================================
// AC23: 首次失败 → 重试成功（指数退避路径），checkpoint 最终写入
// ============================================================================
test("AC23: 上传失败后重试，成功即写 checkpoint", async (t) => {
  const { tmpHome, spoolDir, checkpointFile, origHome } = setup()
  const calls: FetchCall[] = []
  let attempts = 0
  ;(globalThis as any).fetch = makeFetchStub(calls, () => {
    attempts++
    // 第 1 次 500，第 2 次成功 → 验证重试路径
    return attempts === 1 ? { ok: false, status: 500 } : { ok: true, status: 200 }
  })
  cleanup(t, tmpHome, spoolDir, origHome, calls)
  try {
    writeSessionSpool(spoolDir)
    const engine = new UploadEngine(new SpoolReader(spoolDir), () => {}, makeConfig({ retryBaseDelayMs: 1 }))
    await engine.uploadAll()

    assert.equal(calls.length, 2, "失败后应重试 1 次")
    const ckpt = JSON.parse(fs.readFileSync(checkpointFile, "utf8"))
    assert.ok(ckpt["sess1"], "重试成功后应写 checkpoint")
  } finally {
    ;(globalThis as any).fetch = originalFetch
  }
})

// ============================================================================
// AC23: 连续失败超过 maxRetries → 放弃本次，不写 checkpoint（下次扫描仍会尝试）
// ============================================================================
test("AC23: 重试全部失败时不写 checkpoint，数据保留待下次上传", async (t) => {
  const { tmpHome, spoolDir, checkpointFile, origHome } = setup()
  const calls: FetchCall[] = []
  ;(globalThis as any).fetch = makeFetchStub(calls, () => ({ ok: false, status: 503 }))
  cleanup(t, tmpHome, spoolDir, origHome, calls)
  try {
    writeSessionSpool(spoolDir)
    const engine = new UploadEngine(new SpoolReader(spoolDir), () => {}, makeConfig({ maxRetries: 3, retryBaseDelayMs: 1 }))
    await engine.uploadAll()

    assert.equal(calls.length, 3, "maxRetries=3 应尝试 3 次")
    assert.ok(!fs.existsSync(checkpointFile), "全部失败不应写 checkpoint")
  } finally {
    ;(globalThis as any).fetch = originalFetch
  }
})

// ============================================================================
// 中断会话兜底: 有工具调用但无 response/stop（对话中断/异常终止）时，
// 工具必须进入 interactions（此前只挂在有 end 的轮次，中断轮工具丢失）
// ============================================================================
test("中断会话: 无 response 时工具仍进入上传载荷（合成 interrupted turn）", async (t) => {
  const { tmpHome, spoolDir, checkpointFile, origHome } = setup()
  const calls: FetchCall[] = []
  ;(globalThis as any).fetch = makeFetchStub(calls, () => ({ ok: true, status: 200 }))
  cleanup(t, tmpHome, spoolDir, origHome, calls)
  try {
    const file = path.join(spoolDir, "trae-otel-interrupt.jsonl")
    const now = Date.now()
    const events = [
      { t: new Date(now - 120000).toISOString(), kind: "agent.session.start", sessionID: "s-int", trace_id: "s-int", payload: { source: "startup" } },
      { t: new Date(now - 118000).toISOString(), kind: "agent.prompt", sessionID: "s-int", trace_id: "s-int", payload: { query: "中断测试" } },
      { t: new Date(now - 117000).toISOString(), kind: "tool.call.start", sessionID: "s-int", trace_id: "tool_1", payload: { toolName: "Read", toolType: "file_read", toolInput: { file_path: "/tmp/a" } } },
      { t: new Date(now - 116000).toISOString(), kind: "tool.call.end", sessionID: "s-int", trace_id: "tool_1", payload: { toolName: "Read", toolType: "file_read", exitCode: 0 } },
    ]
    fs.writeFileSync(file, events.map((l) => JSON.stringify(l)).join("\n") + "\n")

    const engine = new UploadEngine(new SpoolReader(spoolDir), () => {}, makeConfig())
    await engine.uploadAll()

    assert.equal(calls.length, 1)
    const body = JSON.parse(calls[0].init!.body!)
    assert.equal(body.completed, false, "中断会话 completed 应为 false")
    const toolCallsInInteractions = body.interactions.reduce((n: number, it: any) => n + (it.tool_calls?.length || 0), 0)
    assert.equal(toolCallsInInteractions, 1, "中断会话的工具必须进入 interactions")
    const interruptedTurn = body.interactions.find((it: any) => it.finish_reason === "interrupted")
    assert.ok(interruptedTurn, "应有合成 interrupted turn")
    assert.equal(interruptedTurn.tool_calls[0].function.name, "Read")
  } finally {
    ;(globalThis as any).fetch = originalFetch
  }
})

test("中断会话: 多轮场景（第一轮完成 + 第二轮中断）两轮工具都上传", async (t) => {
  const { tmpHome, spoolDir, checkpointFile, origHome } = setup()
  const calls: FetchCall[] = []
  ;(globalThis as any).fetch = makeFetchStub(calls, () => ({ ok: true, status: 200 }))
  cleanup(t, tmpHome, spoolDir, origHome, calls)
  try {
    const file = path.join(spoolDir, "trae-otel-interrupt2.jsonl")
    const now = Date.now()
    const events = [
      { t: new Date(now - 120000).toISOString(), kind: "agent.session.start", sessionID: "s-int2", trace_id: "s-int2", payload: { source: "startup" } },
      { t: new Date(now - 118000).toISOString(), kind: "agent.prompt", sessionID: "s-int2", trace_id: "s-int2", payload: { query: "第一轮" } },
      { t: new Date(now - 117000).toISOString(), kind: "tool.call.start", sessionID: "s-int2", trace_id: "t1", payload: { toolName: "Grep", toolType: "search", toolInput: { pattern: "a" } } },
      { t: new Date(now - 116000).toISOString(), kind: "tool.call.end", sessionID: "s-int2", trace_id: "t1", payload: { toolName: "Grep", toolType: "search", exitCode: 0 } },
      { t: new Date(now - 115000).toISOString(), kind: "agent.response", sessionID: "s-int2", trace_id: "s-int2", payload: { finalResult: "第一轮完成" } },
      { t: new Date(now - 114000).toISOString(), kind: "agent.session.stop", sessionID: "s-int2", trace_id: "s-int2", payload: { reason: "stop-hook" } },
      { t: new Date(now - 113000).toISOString(), kind: "agent.prompt", sessionID: "s-int2", trace_id: "s-int2", payload: { query: "第二轮（中断）" } },
      { t: new Date(now - 112000).toISOString(), kind: "tool.call.start", sessionID: "s-int2", trace_id: "t2", payload: { toolName: "Read", toolType: "file_read", toolInput: { file_path: "/tmp/b" } } },
      { t: new Date(now - 111000).toISOString(), kind: "tool.call.end", sessionID: "s-int2", trace_id: "t2", payload: { toolName: "Read", toolType: "file_read", exitCode: 0 } },
    ]
    fs.writeFileSync(file, events.map((l) => JSON.stringify(l)).join("\n") + "\n")

    const engine = new UploadEngine(new SpoolReader(spoolDir), () => {}, makeConfig())
    await engine.uploadAll()

    assert.equal(calls.length, 1)
    const body = JSON.parse(calls[0].init!.body!)
    const toolNames = body.interactions.flatMap((it: any) => (it.tool_calls || []).map((tc: any) => tc.function.name))
    assert.ok(toolNames.includes("Grep"), "第一轮工具应上传")
    assert.ok(toolNames.includes("Read"), "第二轮中断的工具也应上传")
    const interruptedTurn = body.interactions.find((it: any) => it.finish_reason === "interrupted")
    assert.equal(interruptedTurn?.tool_calls?.[0]?.function?.name, "Read")
  } finally {
    ;(globalThis as any).fetch = originalFetch
  }
})
