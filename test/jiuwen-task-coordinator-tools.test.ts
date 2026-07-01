import { test } from "node:test"
import assert from "node:assert/strict"

import { aggregateJiuwenOtlpFromSpans, type JiuwenSpan } from "@/lib/ingest/otel/jiuwen/aggregate"

const SKILL_PATH = "/Users/x/.jiuwenswarm/agent/workspace/skills/system-resource-check/SKILL.md"
const SESSION = "sess_test_fanout"

const span = (p: Partial<JiuwenSpan> & { name: string; startNs: number; endNs: number }): JiuwenSpan => ({
  traceId: "trace_1",
  spanId: p.name + "_" + p.startNs,
  parentSpanId: undefined,
  attrs: {},
  ...p,
})

// A task fan-out run where the coordinator ALSO calls its own tools:
// list_files (before spawning), task x2 (spawn subagents), read_file (after).
function fanoutSpans(): JiuwenSpan[] {
  const sess = { "agentteam.session.id": SESSION }
  return [
    span({
      name: "llm.call", startNs: 100, endNs: 200,
      attrs: { ...sess, "gen_ai.prompt.1.content": "算两次 1+1，再读一下我配的 skill", "gen_ai.completion.0.content": "好的，先看 skills 并并行算 1+1", "gen_ai.request.model": "deepseek", "gen_ai.usage.prompt_tokens": 10, "gen_ai.usage.completion_tokens": 5, "gen_ai.usage.total_tokens": 15 },
    }),
    span({
      name: "tool.list_files", startNs: 210, endNs: 220,
      attrs: { ...sess, "gen_ai.tool.name": "list_files", "gen_ai.tool.input": JSON.stringify({ path: "/Users/x/.jiuwenswarm/agent/workspace/skills" }), "gen_ai.tool.output": "success=True data={'files': ['skills_state.json'], 'dirs': ['system-resource-check']} error=None" },
    }),
    span({
      name: "tool.task_tool", startNs: 230, endNs: 400,
      attrs: { ...sess, "gen_ai.tool.name": "task_tool", "gen_ai.tool.input": JSON.stringify({ subagent_type: "general-purpose", task_description: "计算 1+1" }), "gen_ai.tool.output": "success=True data={'output': '2', 'agent_id': 'a1'} error=None" },
    }),
    span({
      name: "tool.task_tool", startNs: 235, endNs: 410,
      attrs: { ...sess, "gen_ai.tool.name": "task_tool", "gen_ai.tool.input": JSON.stringify({ subagent_type: "general-purpose", task_description: "计算 1+1" }), "gen_ai.tool.output": "success=True data={'output': '2', 'agent_id': 'a2'} error=None" },
    }),
    span({
      name: "tool.read_file", startNs: 500, endNs: 520,
      attrs: { ...sess, "gen_ai.tool.name": "read_file", "gen_ai.tool.input": JSON.stringify({ file_path: SKILL_PATH }), "gen_ai.tool.output": "success=True data={'content': '---\\nname: system-resource-check\\n---\\n检查 CPU 与内存占用率'} error=None" },
    }),
    span({
      name: "llm.call", startNs: 530, endNs: 600,
      attrs: { ...sess, "gen_ai.completion.0.content": "全部完成：1+1=2，skill 用于检查 CPU/内存占用", "gen_ai.request.model": "deepseek", "gen_ai.usage.prompt_tokens": 20, "gen_ai.usage.completion_tokens": 8, "gen_ai.usage.total_tokens": 28 },
    }),
  ]
}

const allToolCalls = (rec: any) =>
  (rec.interactions || []).flatMap((it: any) => it.tool_calls || [])

test("transformTask: counts coordinator's own tools (was task-only)", () => {
  const rec = aggregateJiuwenOtlpFromSpans(fanoutSpans())
  assert.ok(rec)
  // 2 task spawns + list_files + read_file = 4
  assert.equal(rec!.tool_call_count, 4)
  assert.equal(rec!.agentName, "coordinator")
  assert.equal(rec!.subagentCount, 2)
})

test("transformTask: coordinator tools preserved with full input AND output", () => {
  const rec = aggregateJiuwenOtlpFromSpans(fanoutSpans())!
  const calls = allToolCalls(rec)
  const names = calls.map((c: any) => c.function?.name)
  assert.ok(names.includes("list_files"), `expected list_files, got ${names}`)
  assert.ok(names.includes("read_file"), `expected read_file, got ${names}`)

  const readFile = calls.find((c: any) => c.function?.name === "read_file")
  // input preserved (full path argument)
  assert.match(readFile.function.arguments, /system-resource-check\/SKILL\.md/)
  // output preserved (unwrapped tool data, not dropped)
  assert.match(readFile.output, /检查 CPU 与内存占用率/)

  const listFiles = calls.find((c: any) => c.function?.name === "list_files")
  assert.match(listFiles.function.arguments, /workspace\/skills/)
  assert.match(listFiles.output, /system-resource-check/)
})

test("transformTask: tools attach to their llm-call turn; final answer turn has no tools", () => {
  const rec = aggregateJiuwenOtlpFromSpans(fanoutSpans())!
  const coordTurns = (rec.interactions || []).filter((it: any) => it.agent === "coordinator")
  // This fixture has two llm.calls; every tool ran under the first one (no llm between the
  // tools and the spawns), so they all attach to that turn in time order.
  const planNames = (coordTurns[0].tool_calls || []).map((c: any) => c.function?.name)
  assert.deepEqual(planNames, ["list_files", "task", "task", "read_file"])

  // The final answer turn (last llm.call) carries the wrap-up text and no tools.
  const wrapTurn = coordTurns[coordTurns.length - 1]
  assert.match(wrapTurn.content, /全部完成/)
  assert.deepEqual(wrapTurn.tool_calls ?? [], [])

  // Per-step tokens: each coordinator turn carries its own usage.
  for (const t of coordTurns) {
    assert.ok(t.usage && t.usage.total > 0, `coordinator turn missing usage: ${JSON.stringify(t.usage)}`)
  }
})

test("transformTask: render order — read_file comes BEFORE the final answer (not after)", () => {
  const rec = aggregateJiuwenOtlpFromSpans(fanoutSpans())!
  // Emulate agent-trace emission for the coordinator: per assistant turn, the LLM step is
  // emitted before its tool events, and node.events render in array order (no re-sort).
  const order: string[] = []
  for (const it of rec.interactions || []) {
    if (it.agent !== "coordinator") continue
    if (it.role === "assistant") order.push("llm:" + ((it.content || "").slice(0, 8) || "∅"))
    for (const c of it.tool_calls || []) order.push("tool:" + (c.function?.name ?? c.name))
  }
  const readIdx = order.indexOf("tool:read_file")
  const answerIdx = order.findIndex((e) => e.startsWith("llm:全部完成"))
  assert.ok(readIdx >= 0 && answerIdx >= 0, `missing events: ${order.join(", ")}`)
  assert.ok(readIdx < answerIdx, `read_file (#${readIdx}) must precede final answer (#${answerIdx}); got ${order.join(", ")}`)
})
