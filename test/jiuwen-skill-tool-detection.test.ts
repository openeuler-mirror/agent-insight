import { test } from "node:test"
import assert from "node:assert/strict"

import {
  jiuwenSkillNameFromToolCall,
  extractSkillsWithVersionsFromJiuwenSession,
} from "@/lib/shared/interaction-utils"
import { extractInvokedSkillsFromSessionInteractions } from "@/lib/storage/data-service"
import { aggregateJiuwenOtlpFromSpans, type JiuwenSpan } from "@/lib/ingest/otel/jiuwen/aggregate"
import { buildAgentCallTree, walkTree } from "@/lib/engine/observability/agent-trace"

// OTLP serializes skill_tool input as a positional dump, not a clean top-level object.
const SKILL_TOOL_INPUT = '[[{"skill_name": "system-resource-check"}], {"session": "session:sess_x"}]'
const SKILL_PATH = "/Users/x/.jiuwenswarm/agent/workspace/skills/system-resource-check/SKILL.md"

test("jiuwenSkillNameFromToolCall: skill_tool -> skill_name (positional dump, object, clean json)", () => {
  assert.equal(jiuwenSkillNameFromToolCall("skill_tool", SKILL_TOOL_INPUT), "system-resource-check")
  assert.equal(jiuwenSkillNameFromToolCall("skill_tool", { skill_name: "system-resource-check" }), "system-resource-check")
  assert.equal(jiuwenSkillNameFromToolCall("skill_tool", '{"skill_name":"system-resource-check"}'), "system-resource-check")
})

test("jiuwenSkillNameFromToolCall: read_file is NOT a skill source (per product decision)", () => {
  assert.equal(jiuwenSkillNameFromToolCall("read_file", { file_path: SKILL_PATH }), null)
  assert.equal(jiuwenSkillNameFromToolCall("read_file", JSON.stringify({ file_path: SKILL_PATH })), null)
})

test("jiuwenSkillNameFromToolCall: other tools / malformed -> null", () => {
  assert.equal(jiuwenSkillNameFromToolCall("list_files", { path: "/x/skills" }), null)
  assert.equal(jiuwenSkillNameFromToolCall("skill_tool", { foo: "bar" }), null)
  assert.equal(jiuwenSkillNameFromToolCall("skill_tool", '[[{"skill_name": "bad name"}], {}]'), null) // space fails name pattern
})

// ---- end-to-end: a fan-out run whose coordinator calls skill_tool ----
const span = (p: Partial<JiuwenSpan> & { name: string; startNs: number; endNs: number }): JiuwenSpan => ({
  traceId: "trace_1", spanId: p.name + "_" + p.startNs, parentSpanId: undefined, attrs: {}, ...p,
})
const sess = { "agentteam.session.id": "sess_x" }
function fanoutWithSkillTool(): JiuwenSpan[] {
  return [
    span({ name: "llm.call", startNs: 100, endNs: 200, attrs: { ...sess, "gen_ai.prompt.1.content": "算 1+1 再读 skill", "gen_ai.completion.0.content": "好的", "gen_ai.request.model": "deepseek", "gen_ai.usage.total_tokens": 10 } }),
    span({ name: "tool.task_tool", startNs: 230, endNs: 400, attrs: { ...sess, "gen_ai.tool.name": "task_tool", "gen_ai.tool.input": JSON.stringify({ subagent_type: "general-purpose", task_description: "计算 1+1" }), "gen_ai.tool.output": "success=True data={'output': '2'} error=None" } }),
    span({ name: "tool.task_tool", startNs: 235, endNs: 410, attrs: { ...sess, "gen_ai.tool.name": "task_tool", "gen_ai.tool.input": JSON.stringify({ subagent_type: "general-purpose", task_description: "计算 1+1" }), "gen_ai.tool.output": "success=True data={'output': '2'} error=None" } }),
    span({ name: "tool.skill_tool", startNs: 500, endNs: 520, attrs: { ...sess, "gen_ai.tool.name": "skill_tool", "gen_ai.tool.input": SKILL_TOOL_INPUT, "gen_ai.tool.output": "success=True data={'content': '检查 CPU 与内存'} error=None" } }),
    span({ name: "llm.call", startNs: 530, endNs: 600, attrs: { ...sess, "gen_ai.completion.0.content": "全部完成", "gen_ai.request.model": "deepseek", "gen_ai.usage.total_tokens": 12 } }),
  ]
}

test("aggregate keeps skill_tool with full skill_name input; tool count includes it", () => {
  const rec = aggregateJiuwenOtlpFromSpans(fanoutWithSkillTool())!
  const calls = (rec.interactions || []).flatMap((it: any) => it.tool_calls || [])
  const skillCall = calls.find((c: any) => c.function?.name === "skill_tool")
  assert.ok(skillCall, "skill_tool must be present in interactions")
  assert.match(skillCall.function.arguments, /system-resource-check/)
  assert.equal(rec.tool_call_count, 3) // 2 task + 1 skill_tool
})

test("extractor + adapter dispatch surface the skill (feeds invokedSkills/ExecutionSkill + Skills tab)", () => {
  const rec = aggregateJiuwenOtlpFromSpans(fanoutWithSkillTool())!
  const viaExtractor = extractSkillsWithVersionsFromJiuwenSession(
    (rec.interactions || []).map((it: any) => ({ requestMessages: [it], responseMessage: null })),
  )
  assert.deepEqual(viaExtractor, [{ name: "system-resource-check", version: null }])
  // adapter dispatch (the server save path)
  const viaDispatch = extractInvokedSkillsFromSessionInteractions("jiuwenswarm", rec.interactions)
  assert.deepEqual(viaDispatch, [{ name: "system-resource-check", version: null }])
})

test("agent-trace classifies skill_tool as a skill call (feeds 概览 SKILL CALLS + 时间线)", () => {
  const rec = aggregateJiuwenOtlpFromSpans(fanoutWithSkillTool())!
  const root = buildAgentCallTree(rec.interactions as any)!
  let skillCalls = 0
  walkTree(root, (n) => { skillCalls += n.stats.skillCalls })
  assert.equal(skillCalls, 1)
})
