import { test } from "node:test"
import assert from "node:assert/strict"

import { aggregateJiuwenOtlpFromSpans, type JiuwenSpan } from "@/lib/ingest/otel/jiuwen/aggregate"

const sess = { "agentteam.session.id": "sess_perstep" }
const span = (p: Partial<JiuwenSpan> & { name: string; startNs: number; endNs: number }): JiuwenSpan => ({
  traceId: "t_" + p.startNs, spanId: p.name + "_" + p.startNs, parentSpanId: undefined, attrs: {}, ...p,
})
const llm = (startNs: number, pt: number, ct: number, content: string) =>
  span({ name: "llm.call", startNs, endNs: startNs + 50, attrs: { ...sess, "gen_ai.usage.prompt_tokens": pt, "gen_ai.usage.completion_tokens": ct, "gen_ai.usage.total_tokens": pt + ct, "gen_ai.request.model": "deepseek", "gen_ai.completion.0.content": content } })
const tool = (name: string, startNs: number, input: string, output: string) =>
  span({ name: `tool.${name}`, startNs, endNs: startNs + 10, attrs: { ...sess, "gen_ai.tool.name": name, "gen_ai.tool.input": input, "gen_ai.tool.output": output } })

// coordinator: llm1→list_files ; llm2→task,task (subagents return) ; llm3→skill_tool ; llm4 final
function spans(): JiuwenSpan[] {
  return [
    llm(100, 1000, 10, "规划：先看技能并派子代理"),
    tool("list_files", 110, '[[{"path":"/x/skills"}],{}]', "success=True data={'dirs': ['system-resource-check']} error=None"),
    llm(200, 1100, 20, "派发两个子代理"),
    tool("task_tool", 210, '[[{"subagent_type":"general-purpose","task_description":"算1+1"}],{}]', "success=True data={'output': '2'} error=None"),
    tool("task_tool", 215, '[[{"subagent_type":"general-purpose","task_description":"算1+1"}],{}]', "success=True data={'output': '2'} error=None"),
    llm(300, 1200, 30, "读一下技能"),
    tool("skill_tool", 310, '[[{"skill_name":"system-resource-check"}],{}]', "success=True data={'content': 'CPU/内存检查'} error=None"),
    llm(400, 1300, 40, "全部完成！结果如下"),
  ]
}

test("per-step: each coordinator llm turn carries its OWN usage", () => {
  const rec = aggregateJiuwenOtlpFromSpans(spans())!
  const coordTurns = rec.interactions.filter((it: any) => it.agent === "coordinator")
  assert.equal(coordTurns.length, 4, "one coordinator turn per llm.call")
  for (const t of coordTurns) {
    assert.ok(t.usage && typeof t.usage.total === "number" && t.usage.total > 0, `turn missing usage: ${JSON.stringify(t.usage)}`)
  }
  // per-step usages: 1010, 1120, 1230, 1340
  assert.deepEqual(coordTurns.map((t: any) => t.usage.total), [1010, 1120, 1230, 1340])
})

test("per-step: totals unchanged (sum of per-turn usage == record totals)", () => {
  const rec = aggregateJiuwenOtlpFromSpans(spans())!
  assert.equal(rec.llm_call_count, 4)
  assert.equal(rec.tool_call_count, 4) // list_files + task + task + skill_tool
  assert.equal(rec.input_tokens, 1000 + 1100 + 1200 + 1300)
  assert.equal(rec.output_tokens, 10 + 20 + 30 + 40)
  assert.equal(rec.tokens, 1010 + 1120 + 1230 + 1340)
  const sum = rec.interactions
    .filter((it: any) => it.usage)
    .reduce((n: number, it: any) => n + it.usage.total, 0)
  assert.equal(sum, rec.tokens)
})

test("per-step: subagent turns preserved; tools grouped under their llm call", () => {
  const rec = aggregateJiuwenOtlpFromSpans(spans())!
  const subs = rec.interactions.filter((it: any) => it.role === "subagent")
  assert.equal(subs.length, 2)
  assert.equal(rec.subagentCount, 2)
  const coordTurns = rec.interactions.filter((it: any) => it.agent === "coordinator")
  assert.deepEqual((coordTurns[0].tool_calls || []).map((t: any) => t.function.name), ["list_files"])
  assert.deepEqual((coordTurns[1].tool_calls || []).map((t: any) => t.function.name), ["task", "task"])
  assert.deepEqual((coordTurns[2].tool_calls || []).map((t: any) => t.function.name), ["skill_tool"])
})

test("per-step: render order — skill read precedes the final answer", () => {
  const rec = aggregateJiuwenOtlpFromSpans(spans())!
  const order: string[] = []
  for (const it of rec.interactions) {
    if (it.agent !== "coordinator") continue
    if (it.role === "assistant") order.push("llm:" + (it.content || "").slice(0, 4))
    for (const c of it.tool_calls || []) order.push("tool:" + c.function?.name)
  }
  const skillIdx = order.indexOf("tool:skill_tool")
  const finalIdx = order.findIndex((e) => e.startsWith("llm:全部完成"))
  assert.ok(skillIdx >= 0 && finalIdx >= 0)
  assert.ok(skillIdx < finalIdx, `skill (#${skillIdx}) must precede final answer (#${finalIdx}); ${order.join(", ")}`)
})

test("per-step: skill_tool input/output preserved on its turn", () => {
  const rec = aggregateJiuwenOtlpFromSpans(spans())!
  const calls = rec.interactions.flatMap((it: any) => it.tool_calls || [])
  const skill = calls.find((c: any) => c.function.name === "skill_tool")
  assert.match(skill.function.arguments, /system-resource-check/)
  assert.match(skill.output, /CPU\/内存检查/)
})
