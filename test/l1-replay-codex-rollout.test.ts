/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * L1 组件回放：Codex Desktop 真实单 turn rollout。
 *
 * cassette 本体放根管理仓 `test-cassettes/codex-desktop-0166/`（优先）或
 * `codex-desktop-0164/`；`manifest.json` 记录 usage 记录数与真值 token 总额。
 * 测试进程内直跑 rollout reader → CodexTraceCore → codex adapter 聚合，断言：
 *  - 该 turn 落成一次执行，带用户 query、带终态；
 *  - token 总额等于 manifest 的 expected_total_tokens（真值，取自原始
 *    `token_usage_record.usage.total_tokens` 之和）；
 *  - LLM span 数等于 usage 记录数（不虚增、不互相覆盖）。
 *
 * 为覆盖 0.164+ 的真实 `.jsonl.zst` 形态，plain cassette 会在测试内压缩；
 * Node 不支持 zstd 时退回 plain，仍保留真实数据回归。cassette 缺失时跳过：
 * fixture 属根仓资产，社区 clone 不应因缺它而失败。
 */
import assert from "node:assert/strict"
import fsp from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const zlib = require("node:zlib")
const { createDesktopRolloutReader } = require("../scripts/agent-trace-collectors/codex/rollout-reader.cjs")
const { CodexTraceCore } = require("../scripts/agent-trace-collectors/codex/codex-trace-core.cjs")
const {
  aggregateCodexTraceEvents,
  keepLatestCodexSpanSnapshots,
} = require("../src/lib/ingest/otel/adapters/codex.ts")

const CASSETTE_ROOT_BASE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../test-cassettes",
)
const CASSETTE_ROOTS = [
  path.join(CASSETTE_ROOT_BASE, "codex-desktop-0166"),
  path.join(CASSETTE_ROOT_BASE, "codex-desktop-0164"),
]
const ZSTD_AVAILABLE = typeof zlib.zstdCompressSync === "function"

class MemoryWriter {
  events: Array<Record<string, any>> = []

  async append(event: Record<string, any>) {
    this.events.push(structuredClone(event))
    return event
  }

  async flush() {}
}

async function resolveCassette(): Promise<{ root: string; source: string; compressed: boolean } | undefined> {
  for (const root of CASSETTE_ROOTS) {
    for (const name of ["parent-turn.jsonl.zst", "parent-turn.jsonl"]) {
      const source = path.join(root, name);
      if (await fsp.stat(source).then(() => true, () => false)) {
        return { root, source, compressed: name.endsWith(".zst") };
      }
    }
  }
  return undefined
}

test("L1 回放：真实 Desktop rollout 落成一次完整执行且 token 等于真值", async (t) => {
  const cassette = await resolveCassette()
  if (!cassette) {
    t.skip("cassette test-cassettes/codex-desktop-0166 或 0164 缺失，跳过 L1 回放")
    return
  }
  const manifest = JSON.parse(await fsp.readFile(path.join(cassette.root, "manifest.json"), "utf8"))
  const stateDir = await fsp.mkdtemp(path.join(process.env.TEMP || "/tmp", "codex-rollout-l1-"))
  const sessionsDir = path.join(stateDir, "sessions")
  await fsp.mkdir(sessionsDir, { recursive: true })
  t.after(() => fsp.rm(stateDir, { recursive: true, force: true }))

  // reader 按文件名里的 rollout 起始时间判断回填边界，保留真实文件名语义。
  const rolloutBase = manifest.rollout_name
    || "rollout-2026-10-25T11-58-43-01a17135-f417-7ce0-b5f9-56ad5e6805d0.jsonl"
  const useCompressed = cassette.compressed || ZSTD_AVAILABLE
  const target = path.join(sessionsDir, useCompressed ? `${rolloutBase}.zst` : rolloutBase)
  if (cassette.compressed) {
    await fsp.copyFile(cassette.source, target)
  } else if (ZSTD_AVAILABLE) {
    const plain = await fsp.readFile(cassette.source)
    await fsp.writeFile(target, zlib.zstdCompressSync(plain))
  } else {
    await fsp.copyFile(cassette.source, target)
  }

  const writer = new MemoryWriter()
  const core = new CodexTraceCore({
    writer,
    stateDir,
    now: () => manifest.records,
  })
  const reader = createDesktopRolloutReader({
    enabled: true,
    sessionsDir,
    stateDir,
    checkpointPath: path.join(stateDir, "checkpoint.json"),
    backfillAfterMs: 1,
    onEvents: async (events: any[]) => {
      for (const event of events) await core.processLifecycleEvent(event)
    },
  })
  await reader.scan()

  // 该 turn 的 sessionId 形如 `<threadId>:turn:<turnId>`；直接从事件里取唯一值。
  const executionSessionIds = [...new Set(
    writer.events
      .map((event: any) => event.sessionId)
      .filter((value: any) => typeof value === "string" && value.includes(":turn:")),
  )] as string[]
  assert.equal(executionSessionIds.length, 1, "单 turn 切片必须只产生一个执行 sessionId")
  const resolvedSessionId = executionSessionIds[0]
  assert.ok(resolvedSessionId.endsWith(`:turn:${manifest.turn_id}`), "sessionId 必须以 turn id 结尾")

  const turnEvents = writer.events.filter((event: any) => event.sessionId === resolvedSessionId)
  const llmEvents = turnEvents.filter((event: any) => event.kind === "llm")
  // 设计：正文落自己的 LLM 节点（Bug 56 契约），usage 也一条一节点（不互相覆盖）。
  const usageSpans = new Set(
    llmEvents.filter((event: any) => (event.usage?.total || 0) > 0).map((event: any) => event.spanId),
  )
  const textSpans = new Set(
    llmEvents.filter((event: any) => event.output).map((event: any) => event.spanId),
  )
  assert.equal(usageSpans.size, manifest.usage_records, "带 usage 的 LLM span 数必须等于 usage 记录数")
  assert.ok(textSpans.size > 0, "该 turn 有 assistant 正文，必须落正文 LLM 节点")
  assert.equal(
    usageSpans.size + textSpans.size,
    new Set(llmEvents.map((event: any) => event.spanId)).size,
    "LLM 节点只能是 usage 节点与正文节点之和，不得有第三种来源",
  )

  const aggregated = keepLatestCodexSpanSnapshots(turnEvents)
  const record = aggregateCodexTraceEvents(resolvedSessionId, aggregated)
  assert.ok(record, `真实 ${manifest.cli_version || "Codex"} turn 必须聚合成一条执行记录`)
  assert.equal(
    record.tokens,
    manifest.expected_total_tokens,
    `token 总额必须等于原始 usage 真值（${manifest.expected_total_tokens}）`,
  )
  assert.ok(record.query, "执行必须带用户 query")
  assert.match(String(record.query), /DIY ZCode|补丁/, "query 必须来自 0.164+ 的 item_completed(UserMessage)")
  assert.ok(record.executionStatus, "执行必须有终态")
})
