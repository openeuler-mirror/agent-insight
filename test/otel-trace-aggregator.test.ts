import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { getAdapter } from "@/lib/ingest/adapters/registry"
import { appendOtelTraceEvents } from "@/lib/ingest/otel/spool"
import { aggregateOtelTraceEvents, aggregateOtelTraceSession } from "@/lib/ingest/otel/aggregate"
import { getOtelTraceAdapter, listOtelTraceAdapters } from "@/lib/ingest/otel/adapter-registry"
import type { OtelTraceEvent } from "@/lib/ingest/otel/types"
import { buildAgentCallTree } from "@/lib/engine/observability/agent-trace"

function traceEvent(overrides: Partial<OtelTraceEvent>): OtelTraceEvent {
  return {
    receivedAt: "2026-06-09T00:00:00.000Z",
    sessionId: "session-a",
    traceId: "trace-a",
    spanId: "span-a",
    name: "span",
    kind: "llm",
    serviceName: "opencode",
    user: "alice",
    model: "gpt-test",
    usage: {
      input_tokens: 1,
      output_tokens: 2,
      total_tokens: 3,
    },
    latencyMs: 100,
    startTimeMs: 1000,
    attributes: {},
    ...overrides,
  }
}

test("OTel traces: aggregates trace spool events into one execution record", () => {
  const events = [
    traceEvent({
      spanId: "span-tool",
      kind: "tool",
      name: "tool.call",
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 20,
      startTimeMs: 1200,
      attributes: { "tool.name": "Read", "tool.arguments": "{\"file\":\"README.md\"}" },
    }),
    traceEvent({
      spanId: "span-llm",
      name: "chat",
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      latencyMs: 1500,
      startTimeMs: 1500,
      attributes: { "gen_ai.prompt": "hello", "gen_ai.completion": "done" },
    }),
    traceEvent({
      spanId: "span-llm",
      name: "chat",
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      latencyMs: 1500,
      startTimeMs: 1500,
      attributes: { "gen_ai.prompt": "hello", "gen_ai.completion": "done" },
    }),
  ]

  const record = aggregateOtelTraceEvents("session-a", events)

  assert.ok(record)
  assert.equal(record.task_id, "session-a")
  assert.equal(record.framework, "opencode")
  assert.equal(record.query, "hello")
  assert.equal(record.final_result, "done")
  assert.equal(record.model, "gpt-test")
  assert.equal(record.tokens, 18)
  assert.equal(record.input_tokens, 11)
  assert.equal(record.output_tokens, 7)
  assert.equal(record.latency, 1520)
  assert.equal(record.interactions?.length, 1)
  assert.equal(record.interactions?.[0]?.role, "assistant")
  assert.equal(record.interactions?.[0]?.content, "done")
  assert.equal(record.interactions?.[0]?.usage.total, 18)
  assert.equal(record.interactions?.[0]?.tool_calls?.length, 1)
  assert.equal(record.interactions?.[0]?.tool_calls?.[0]?.function?.name, "Read")
  assert.equal(record.llm_call_count, 1)
  assert.equal(record.tool_call_count, 1)
})

test("OTel traces: aggregates Hermes agent spans without double-counting usage", () => {
  const events = [
    traceEvent({
      sessionId: "20260611_103002_288942",
      traceId: "trace-hermes",
      spanId: "span-agent",
      name: "agent",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 15694, output_tokens: 421, total_tokens: 16115 },
      latencyMs: 11697,
      startTimeMs: 1000,
      attributes: {
        "openinference.span.kind": "AGENT",
        "hermes.session.kind": "session",
        "hermes.agent.role": "root",
        "hermes.agent.name": "default",
        "hermes.profile.name": "default",
        "input.value": "Which subagents are available?",
        "output.value": "Here are the available subagents.",
      },
    }),
    traceEvent({
      sessionId: "20260611_103002_288942",
      traceId: "trace-hermes",
      spanId: "span-api",
      parentSpanId: "span-llm",
      name: "api.GLM-5.1",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 15694, output_tokens: 421, total_tokens: 16115 },
      latencyMs: 11682,
      startTimeMs: 1006,
      attributes: {
        "openinference.span.kind": "LLM",
        "llm.model_name": "GLM-5.1",
        "llm.token_count.prompt": 15694,
        "llm.token_count.completion": 421,
        "llm.token_count.total": 16115,
      },
    }),
    traceEvent({
      sessionId: "20260611_103002_288942",
      traceId: "trace-hermes",
      spanId: "span-llm",
      parentSpanId: "span-agent",
      name: "llm.GLM-5.1",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 11680,
      startTimeMs: 1005,
      attributes: {
        "openinference.span.kind": "LLM",
        "input.value": "Which subagents are available?",
        "output.value": "Here are the available subagents.",
      },
    }),
  ]

  const record = aggregateOtelTraceEvents("20260611_103002_288942", events)

  assert.ok(record)
  assert.equal(record.framework, "hermes")
  assert.equal(record.agentName, "hermes")
  assert.equal(record.agent, "hermes")
  assert.equal(record.model, "GLM-5.1")
  assert.equal(record.query, "Which subagents are available?")
  assert.equal(record.final_result, "Here are the available subagents.")
  assert.equal(record.trace_completed_at, "1970-01-01T00:00:12.697Z")
  assert.equal(record.tokens, 16115)
  assert.equal(record.input_tokens, 15694)
  assert.equal(record.output_tokens, 421)
  assert.equal(record.latency, 11697)
  assert.equal(record.llm_call_count, 1)
  assert.equal(record.interactions?.length, 2)
  assert.equal(record.interactions?.[0]?.role, "user")
  assert.equal(record.interactions?.[0]?.content, "Which subagents are available?")
  assert.equal(record.interactions?.[1]?.role, "assistant")
  assert.equal(record.interactions?.[1]?.content, "Here are the available subagents.")
  assert.equal(record.interactions?.[1]?.usage.total, 16115)
})

test("OTel traces: Hermes completion uses the latest root turn without hermes.session.kind", () => {
  const sessionId = "20260616_195101_0590e0";
  const rootAttrs = {
    "hermes.session_id": sessionId,
    "hermes.root_session_id": sessionId,
    "hermes.agent.role": "root",
    "hermes.agent.name": "root",
  };
  const events = [
    traceEvent({
      sessionId,
      traceId: "trace-hermes-real-shape",
      spanId: "agent-1",
      name: "agent",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 2223,
      startTimeMs: 1000,
      attributes: {
        ...rootAttrs,
        "openinference.span.kind": "AGENT",
        "input.value": "hello didi",
        "output.value": "Hi.",
      },
    }),
    traceEvent({
      sessionId,
      traceId: "trace-hermes-real-shape",
      spanId: "llm-1",
      parentSpanId: "agent-1",
      name: "llm.deepseek-v4-flash",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 2222,
      startTimeMs: 1000,
      attributes: {
        ...rootAttrs,
        "openinference.span.kind": "LLM",
        "input.value": "hello didi",
        "output.value": "Hi.",
      },
    }),
    traceEvent({
      sessionId,
      traceId: "trace-hermes-real-shape",
      spanId: "api-1",
      parentSpanId: "llm-1",
      name: "api.deepseek-v4-flash",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      latencyMs: 2210,
      startTimeMs: 1009,
      attributes: {
        ...rootAttrs,
        "openinference.span.kind": "LLM",
        "llm.response.finish_reason": "stop",
        "output.value": "Hi.",
      },
    }),
    traceEvent({
      sessionId,
      traceId: "trace-hermes-real-shape",
      spanId: "agent-2",
      name: "agent",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 15515,
      startTimeMs: 15000,
      attributes: {
        ...rootAttrs,
        "openinference.span.kind": "AGENT",
        "input.value": "帮我看看啊内存",
        "output.value": "Memory summary.",
      },
    }),
    traceEvent({
      sessionId,
      traceId: "trace-hermes-real-shape",
      spanId: "llm-2",
      parentSpanId: "agent-2",
      name: "llm.deepseek-v4-flash",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 15512,
      startTimeMs: 15000,
      attributes: {
        ...rootAttrs,
        "openinference.span.kind": "LLM",
        "input.value": "帮我看看啊内存",
        "output.value": "Memory summary.",
      },
    }),
    traceEvent({
      sessionId,
      traceId: "trace-hermes-real-shape",
      spanId: "api-2",
      parentSpanId: "llm-2",
      name: "api.deepseek-v4-flash",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
      latencyMs: 2380,
      startTimeMs: 28120,
      attributes: {
        ...rootAttrs,
        "openinference.span.kind": "LLM",
        "llm.response.finish_reason": "stop",
        "output.value": "Memory summary.",
      },
    }),
  ];

  const record = aggregateOtelTraceEvents(sessionId, events);

  assert.ok(record);
  assert.equal(record.query, "hello didi");
  assert.equal(record.final_result, "Memory summary.");
  assert.equal(record.trace_completed_at, "1970-01-01T00:00:30.515Z");
})

test("OTel traces: Hermes adapter builds user, tool, and final output from span tree", () => {
  const events = [
    traceEvent({
      sessionId: "20260611_141826_808e5a",
      traceId: "trace-hermes-tree",
      spanId: "span-agent",
      name: "agent",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 44033, output_tokens: 323, total_tokens: 44356 },
      latencyMs: 12731,
      startTimeMs: 1000,
      attributes: {
        "openinference.span.kind": "AGENT",
        "hermes.session.kind": "session",
        "input.value": "Show me the skill.",
        "output.value": "Final answer.",
      },
    }),
    traceEvent({
      sessionId: "20260611_141826_808e5a",
      traceId: "trace-hermes-tree",
      spanId: "span-llm",
      parentSpanId: "span-agent",
      name: "llm.GLM-5.1",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 12727,
      startTimeMs: 1004,
      attributes: {
        "openinference.span.kind": "LLM",
        "input.value": "Show me the skill.",
        "output.value": "Final answer.",
        "llm.model_name": "GLM-5.1",
      },
    }),
    traceEvent({
      sessionId: "20260611_141826_808e5a",
      traceId: "trace-hermes-tree",
      spanId: "span-api-1",
      parentSpanId: "span-llm",
      name: "api.GLM-5.1",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 15699, output_tokens: 44, total_tokens: 15743 },
      latencyMs: 3941,
      startTimeMs: 1008,
      attributes: {
        "openinference.span.kind": "LLM",
        "llm.model_name": "GLM-5.1",
      },
    }),
    traceEvent({
      sessionId: "20260611_141826_808e5a",
      traceId: "trace-hermes-tree",
      spanId: "span-tool",
      parentSpanId: "span-llm",
      kind: "tool",
      name: "tool.skill_view",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 23,
      startTimeMs: 4950,
      attributes: {
        "openinference.span.kind": "TOOL",
        "tool.name": "skill_view",
        "input.value": "{\"skill\":\"demo\"}",
        "output.value": "Tool output.",
        "hermes.tool.outcome": "completed",
      },
    }),
    traceEvent({
      sessionId: "20260611_141826_808e5a",
      traceId: "trace-hermes-tree",
      spanId: "span-api-2",
      parentSpanId: "span-llm",
      name: "api.GLM-5.1",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 28334, output_tokens: 279, total_tokens: 28613 },
      latencyMs: 8735,
      startTimeMs: 5000,
      attributes: {
        "openinference.span.kind": "LLM",
        "llm.model_name": "GLM-5.1",
      },
    }),
  ]

  const record = aggregateOtelTraceEvents("20260611_141826_808e5a", events)

  assert.ok(record)
  assert.equal(record.framework, "hermes")
  assert.equal(record.model, "GLM-5.1")
  assert.equal(record.query, "Show me the skill.")
  assert.equal(record.final_result, "Final answer.")
  assert.equal(record.trace_completed_at, "1970-01-01T00:00:13.731Z")
  assert.equal(record.tokens, 44356)
  assert.equal(record.input_tokens, 44033)
  assert.equal(record.output_tokens, 323)
  assert.equal(record.latency, 12731)
  assert.equal(record.llm_call_count, 2)
  assert.equal(record.tool_call_count, 1)
  assert.equal(record.interactions?.length, 3)
  assert.equal(record.interactions?.[0]?.role, "user")
  assert.equal(record.interactions?.[0]?.content, "Show me the skill.")
  assert.equal(record.interactions?.[1]?.role, "assistant")
  assert.equal(record.interactions?.[1]?.name, "tool.skill_view")
  assert.equal(record.interactions?.[1]?.tool_calls?.[0]?.function?.name, "skill_view")
  assert.equal(record.interactions?.[1]?.tool_calls?.[0]?.result, "Tool output.")
  assert.equal(record.interactions?.[2]?.role, "assistant")
  assert.equal(record.interactions?.[2]?.content, "Final answer.")
  assert.equal(record.interactions?.[2]?.usage.total, 44356)
})

test("OTel traces: Hermes adapter emits intermediate LLM messages from api spans", () => {
  const events = [
    traceEvent({
      sessionId: "20260611_172750_1af360",
      traceId: "trace-hermes-steps",
      spanId: "span-agent",
      name: "agent",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 300, output_tokens: 80, total_tokens: 380 },
      latencyMs: 7000,
      startTimeMs: 1000,
      attributes: {
        "openinference.span.kind": "AGENT",
        "hermes.session.kind": "session",
      },
    }),
    traceEvent({
      sessionId: "20260611_172750_1af360",
      traceId: "trace-hermes-steps",
      spanId: "span-llm",
      parentSpanId: "span-agent",
      name: "llm.GLM-5.1",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 6990,
      startTimeMs: 1001,
      attributes: {
        "openinference.span.kind": "LLM",
        "input.value": "我的电脑很卡，检查 3000 端口服务。",
        "llm.model_name": "GLM-5.1",
      },
    }),
    traceEvent({
      sessionId: "20260611_172750_1af360",
      traceId: "trace-hermes-steps",
      spanId: "span-api-1",
      parentSpanId: "span-llm",
      name: "api.GLM-5.1",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      latencyMs: 900,
      startTimeMs: 1010,
      attributes: {
        "openinference.span.kind": "LLM",
        "llm.model_name": "GLM-5.1",
        "llm.response.finish_reason": "tool_calls",
        "output.value": JSON.stringify({
          choices: [{ message: { content: "好的，让我先加载 server-troubleshooter 技能。" } }],
        }),
      },
    }),
    traceEvent({
      sessionId: "20260611_172750_1af360",
      traceId: "trace-hermes-steps",
      spanId: "span-tool-1",
      parentSpanId: "span-llm",
      kind: "tool",
      name: "tool.skill_view",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 40,
      startTimeMs: 1915,
      attributes: {
        "openinference.span.kind": "TOOL",
        "tool.name": "skill_view",
        "input.value": "{\"skill\":\"server-troubleshooter\"}",
        "output.value": "技能已加载。",
      },
    }),
    traceEvent({
      sessionId: "20260611_172750_1af360",
      traceId: "trace-hermes-steps",
      spanId: "span-api-2",
      parentSpanId: "span-llm",
      name: "api.GLM-5.1",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      latencyMs: 800,
      startTimeMs: 2000,
      attributes: {
        "openinference.span.kind": "LLM",
        "llm.model_name": "GLM-5.1",
        "llm.response.finish_reason": "tool_calls",
        "output.value": JSON.stringify({
          choices: [{ message: { content: "技能已加载。按照步骤执行诊断流程。" } }],
        }),
      },
    }),
    traceEvent({
      sessionId: "20260611_172750_1af360",
      traceId: "trace-hermes-steps",
      spanId: "span-tool-2",
      parentSpanId: "span-llm",
      kind: "tool",
      name: "tool.terminal",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 60,
      startTimeMs: 2810,
      attributes: {
        "openinference.span.kind": "TOOL",
        "tool.name": "terminal",
        "input.value": "ps aux",
        "output.value": "next-server rss 2.38GB",
      },
    }),
    traceEvent({
      sessionId: "20260611_172750_1af360",
      traceId: "trace-hermes-steps",
      spanId: "span-api-3",
      parentSpanId: "span-llm",
      name: "api.GLM-5.1",
      serviceName: "hermes",
      model: undefined,
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      latencyMs: 1200,
      startTimeMs: 2900,
      attributes: {
        "openinference.span.kind": "LLM",
        "llm.model_name": "GLM-5.1",
        "llm.response.finish_reason": "stop",
        "output.value": JSON.stringify({
          choices: [{ message: { content: "诊断完成：3000 端口服务存在内存增长风险。" } }],
        }),
      },
    }),
  ];

  const record = aggregateOtelTraceEvents("20260611_172750_1af360", events);

  assert.ok(record);
  assert.equal(record.framework, "hermes");
  assert.equal(record.final_result, "诊断完成：3000 端口服务存在内存增长风险。");
  assert.equal(record.llm_call_count, 3);
  assert.equal(record.tool_call_count, 2);
  assert.deepEqual(record.interactions?.map((interaction: any) => interaction.role), [
    "user",
    "assistant",
    "assistant",
    "assistant",
    "assistant",
    "assistant",
  ]);
  assert.equal(record.interactions?.[1]?.content, "好的，让我先加载 server-troubleshooter 技能。");
  assert.equal(record.interactions?.[2]?.tool_calls?.[0]?.function?.name, "skill_view");
  assert.equal(record.interactions?.[3]?.content, "技能已加载。按照步骤执行诊断流程。");
  assert.equal(record.interactions?.[4]?.tool_calls?.[0]?.function?.name, "terminal");
  assert.equal(record.interactions?.[5]?.content, "诊断完成：3000 端口服务存在内存增长风险。");
  assert.equal(record.interactions?.[5]?.usage.total, 150);
});

test("Framework adapter registry marks Hermes as plugin onboarding with snapshot replacement", () => {
  const adapter = getAdapter("hermes");

  assert.equal(adapter.descriptor.onboard, "plugin");
  assert.equal(adapter.sessionMergeStrategy, "snapshot-replace");
  assert.equal(adapter.capabilities?.skills, true);
  assert.equal(adapter.capabilities?.subagentTree, true);
});

test("OTel trace adapter registry selects Hermes before the generic fallback", () => {
  const hermesEvent = traceEvent({ serviceName: "hermes" });
  const genericEvent = traceEvent({ serviceName: "another-agent" });

  assert.deepEqual(listOtelTraceAdapters().map(adapter => adapter.id), ["hermes", "generic"]);
  assert.equal(getOtelTraceAdapter([hermesEvent]).id, "hermes");
  assert.equal(getOtelTraceAdapter([genericEvent]).id, "generic");
});

test("OTel traces: Hermes adapter preserves subagent ownership and builds a child tree", () => {
  const rootSessionId = "hermes-root";
  const childSessionId = "hermes-child";
  const rootAttrs = {
    "hermes.session_id": rootSessionId,
    "hermes.root_session_id": rootSessionId,
    "hermes.agent.role": "root",
    "hermes.agent.name": "planner",
    "hermes.profile.name": "planner",
  };
  const childAttrs = {
    "hermes.session_id": childSessionId,
    "hermes.root_session_id": rootSessionId,
    "hermes.parent_session_id": rootSessionId,
    "hermes.agent.role": "researcher",
    "hermes.agent.name": "researcher",
  };
  const events = [
    traceEvent({
      sessionId: rootSessionId,
      traceId: "trace-hermes-subagent",
      spanId: "root-agent",
      name: "agent",
      serviceName: "hermes",
      startTimeMs: 1000,
      latencyMs: 5000,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      attributes: { ...rootAttrs, "openinference.span.kind": "AGENT", "input.value": "Delegate this task." },
    }),
    traceEvent({
      sessionId: rootSessionId,
      traceId: "trace-hermes-subagent",
      spanId: "root-llm",
      parentSpanId: "root-agent",
      name: "llm.GLM-5.1",
      serviceName: "hermes",
      startTimeMs: 1001,
      latencyMs: 4990,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      attributes: { ...rootAttrs, "openinference.span.kind": "LLM", "input.value": "Delegate this task.", "output.value": "Root final." },
    }),
    traceEvent({
      sessionId: rootSessionId,
      traceId: "trace-hermes-subagent",
      spanId: "task-span",
      parentSpanId: "root-llm",
      kind: "tool",
      name: "tool.task",
      serviceName: "hermes",
      startTimeMs: 1100,
      latencyMs: 3000,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      attributes: {
        ...rootAttrs,
        "openinference.span.kind": "TOOL",
        "tool.name": "task",
        "input.value": JSON.stringify({ subagent_type: "researcher", description: "Inspect logs", session_id: childSessionId }),
        "output.value": JSON.stringify({ session_id: childSessionId, result: "Child final." }),
      },
    }),
    traceEvent({
      sessionId: rootSessionId,
      traceId: "trace-hermes-subagent",
      spanId: "child-agent",
      parentSpanId: "task-span",
      name: "agent.subagent.researcher",
      serviceName: "hermes",
      startTimeMs: 1200,
      latencyMs: 2500,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      attributes: { ...childAttrs, "openinference.span.kind": "AGENT", "input.value": "Inspect logs", "output.value": "Child final." },
    }),
    traceEvent({
      sessionId: rootSessionId,
      traceId: "trace-hermes-subagent",
      spanId: "child-llm",
      parentSpanId: "child-agent",
      name: "llm.GLM-5.1",
      serviceName: "hermes",
      startTimeMs: 1201,
      latencyMs: 2400,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      attributes: { ...childAttrs, "openinference.span.kind": "LLM", "input.value": "Inspect logs", "output.value": "Child final." },
    }),
    traceEvent({
      sessionId: rootSessionId,
      traceId: "trace-hermes-subagent",
      spanId: "child-api",
      parentSpanId: "child-llm",
      name: "api.GLM-5.1",
      serviceName: "hermes",
      startTimeMs: 1300,
      latencyMs: 2000,
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
      attributes: { ...childAttrs, "openinference.span.kind": "LLM", "llm.response.finish_reason": "stop", "output.value": "Child final." },
    }),
  ];

  const record = aggregateOtelTraceEvents(rootSessionId, events);
  assert.ok(record);
  assert.equal(record.agentName, "planner");
  assert.equal(record.agent, "planner");
  assert.equal(record.interactions?.find((interaction: any) => interaction.role === "user")?.agent, "planner");
  assert.equal(record.interactions?.filter((interaction: any) => interaction.role === "subagent").length, 2);
  assert.equal(record.interactions?.find((interaction: any) => interaction.role === "subagent")?.subagent_session_id, childSessionId);

  const tree = buildAgentCallTree(record.interactions as any[]);
  assert.ok(tree);
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0]?.sessionId, childSessionId);
  assert.equal(tree.children[0]?.subagentType, "researcher");
  assert.equal(tree.children[0]?.agentName, "researcher");
});

test("OTel traces: aggregateOtelTraceSession reads traces spool files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-trace-agg-"))
  try {
    appendOtelTraceEvents([
      traceEvent({
        spanId: "span-llm",
        attributes: { "gen_ai.prompt": "hello", "gen_ai.completion": "done" },
      }),
    ], dir)

    const result = aggregateOtelTraceSession("session-a", dir)
    assert.equal(result.eventCount, 1)
    assert.equal(result.record?.framework, "opencode")
    assert.equal(result.record?.task_id, "session-a")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("OTel traces: Hermes parses provider candidate content and preserves API errors", () => {
  const events = [
    traceEvent({
      sessionId: "hermes-provider-shapes",
      traceId: "trace-provider-shapes",
      spanId: "llm",
      name: "llm.GLM-5.1",
      serviceName: "hermes",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      attributes: {
        "openinference.span.kind": "LLM",
        "input.value": "hello",
      },
    }),
    traceEvent({
      sessionId: "hermes-provider-shapes",
      traceId: "trace-provider-shapes",
      spanId: "api-error",
      parentSpanId: "llm",
      name: "api.GLM-5.1",
      serviceName: "hermes",
      startTimeMs: 1100,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      attributes: {
        "openinference.span.kind": "LLM",
        "llm.response.finish_reason": "error",
        "error.message": "provider temporarily unavailable",
      },
    }),
    traceEvent({
      sessionId: "hermes-provider-shapes",
      traceId: "trace-provider-shapes",
      spanId: "api-success",
      parentSpanId: "llm",
      name: "api.GLM-5.1",
      serviceName: "hermes",
      startTimeMs: 1200,
      usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
      attributes: {
        "openinference.span.kind": "LLM",
        "llm.response.finish_reason": "stop",
        "output.value": JSON.stringify({ candidates: [{ content: { parts: [{ text: "candidate answer" }] } }] }),
      },
    }),
  ];

  const record = aggregateOtelTraceEvents("hermes-provider-shapes", events);
  assert.ok(record);
  assert.equal(record.llm_call_count, 2);
  assert.equal(record.final_result, "candidate answer");
  const errorInteraction = record.interactions?.find((interaction: any) => interaction.status === "error");
  assert.equal(errorInteraction?.content, "API request failed: provider temporarily unavailable");
  assert.equal(errorInteraction?.error?.message, "provider temporarily unavailable");
});
