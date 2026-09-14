import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

import {
  rasActionChannelLabel,
  rasActionLabel,
  rasEventKindBadgeLabel,
  rasMarkerBadgeLabel,
  rasSummaryLabel,
} from "@/lib/ingest/ras/normalize"

test("可靠性展示层为中文界面映射协议值", () => {
  assert.equal(rasEventKindBadgeLabel("zh"), "故障")
  assert.equal(rasEventKindBadgeLabel("en"), "RAS")
  assert.equal(
    rasMarkerBadgeLabel({ label: "工具重复调用", source: "ras" }, "zh"),
    "工具重复调用",
  )
  assert.equal(
    rasMarkerBadgeLabel({ label: "工具重复调用", source: "ras" }, "zh", true),
    "故障",
  )
  assert.equal(
    rasMarkerBadgeLabel({ label: "Fault injection", source: "fi" }, "zh"),
    "FI · Fault injection",
  )
  assert.equal(rasActionLabel("abort_stream", "zh"), "中断输出流")
  assert.equal(rasActionLabel("emit_notice", "zh"), "发送通知")
  assert.equal(rasActionLabel("push_steering", "zh"), "注入纠偏提示")
  assert.equal(rasActionLabel("custom_action", "zh"), "custom_action")
  assert.equal(rasActionLabel("abort_stream", "en"), "abort_stream")
  assert.equal(rasActionChannelLabel("session.abort", "zh"), "会话中断")
  assert.equal(rasActionChannelLabel("session.prompt.noReply", "zh"), "会话提示（无需回复）")
  assert.equal(
    rasActionChannelLabel("session.interrupt.api+tui.session.interrupt×2+session.abort.retry", "zh"),
    "会话中止（API） + 界面会话中止×2 + 会话中断重试",
  )
  assert.equal(rasActionChannelLabel("custom.channel", "zh"), "custom.channel")
  assert.equal(
    rasSummaryLabel(
      { kind: "repeat_tool_call", label: "工具重复调用", summary: "repeat_tool_call on read" },
      "zh",
    ),
    "工具重复调用：read",
  )
  assert.equal(
    rasSummaryLabel(
      { kind: "llm_thinking_loop", label: "思考循环", summary: "llm_thinking_loop (similar_clauses)" },
      "zh",
    ),
    "思考循环（逻辑死循环）",
  )
  assert.equal(
    rasSummaryLabel(
      { kind: "analysis_paralysis", label: "分析瘫痪", summary: "analysis_paralysis (refrain_gate)" },
      "zh",
    ),
    "分析瘫痪（分析瘫痪门控）",
  )
  assert.equal(
    rasSummaryLabel({ kind: "[", label: "未知故障", summary: "[ (custom_mode)" }, "zh"),
    "未知故障（custom_mode）",
  )
  assert.equal(
    rasSummaryLabel(
      { kind: "repeat_tool_call", label: "工具重复调用", summary: "已检测到异常" },
      "zh",
    ),
    "已检测到异常",
  )
})

test("链路详情使用慢节点、故障节点与可靠性展示映射", () => {
  const trace = fs.readFileSync(
    path.join(process.cwd(), "src/components/observe/AgentTraceView.tsx"),
    "utf8",
  )
  const details = fs.readFileSync(
    path.join(process.cwd(), "src/components/observe/RasReliabilityDetails.tsx"),
    "utf8",
  )

  assert.match(trace, /label: '慢节点'/)
  assert.match(trace, /label: '故障节点'/)
  assert.match(trace, /rasEventKindBadgeLabel\(locale\)/)
  assert.match(trace, /locale === 'zh' \? '来源：' : 'from: '/)
  assert.match(details, /rasMarkerBadgeLabel/)
  assert.match(details, /rasSummaryLabel/)
  assert.match(details, /rasActionLabel/)
  assert.match(details, /rasActionChannelLabel/)
  assert.doesNotMatch(details, /<code[^>]*>\{step\.action\.type\}<\/code>/)
  assert.doesNotMatch(details, /<code[^>]*>\{step\.result\.action\}<\/code>/)
})
