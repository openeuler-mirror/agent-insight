/* eslint-disable @typescript-eslint/no-explicit-any -- OTLP fixtures intentionally exercise loosely typed external payloads. */
import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { buildAgentCallTree } from "@/lib/engine/observability/agent-trace"
import { getAdapter } from "@/lib/ingest/adapters/registry"
import { aggregateOtelTraceEvents } from "@/lib/ingest/otel/aggregate"
import { getOtelTraceAdapter, listOtelTraceAdapters } from "@/lib/ingest/otel/adapter-registry"
import { normalizeOtlpTraces } from "@/lib/ingest/otel/normalize"
import { normalizeInteractions } from "@/lib/shared/interaction-utils"
import {
  buildQoderOtlpPayload,
  collectQoderHook,
  detectQoderProduct,
  estimateQoderVisibleTokens,
  flushQoderProduct,
  normalizeQoderTranscriptRecords,
  readQoderLocalTokenUsage,
  readQoderExpertAgents,
  redactAndTruncate,
  resolveQoderLocalTokenDatabase,
} from "../scripts/qoder_trace_collector.mjs"
import {
  resolveTraceEndpoint,
  retryDelayMs,
  uploadPending,
} from "../scripts/qoder_uploader_client.mjs"
import {
  installQoderCollector,
  mergeQoderHooks,
  QODER_HOOK_EVENTS,
  removeQoderHooks,
  uninstallQoderCollector,
} from "../scripts/qoder_setup.mjs"
import {
  installQoderWorkCollector,
  mergeQoderWorkHooks,
  QODER_WORK_HOOK_EVENTS,
  removeQoderWorkHooks,
  uninstallQoderWorkCollector,
} from "../scripts/qoder_work_setup.mjs"
import {
  ensureQoderTokenUsageEnvironment,
  QODERCN_TOKEN_USAGE_ENV,
  releaseQoderTokenUsageEnvironment,
} from "../scripts/qoder_token_usage_env.mjs"

const SESSION_ID = "qoder-session-1"

function testProcessIsAlive(pid: number | undefined): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function hook(capturedAt: string, event: Record<string, unknown>): { capturedAt: string; event: Record<string, unknown> } {
  return { capturedAt, event: { session_id: SESSION_ID, ...event } }
}

function sampleCapture() {
  const hookEvents = [
    hook("2026-07-21T12:00:00.000Z", {
      hook_event_name: "UserPromptSubmit",
      prompt: "检查 package.json，然后运行测试",
      transcript_path: "C:\\Users\\tester\\.qoder-cn\\projects\\repo\\qoder-session-1.jsonl",
    }),
    hook("2026-07-21T12:00:01.000Z", {
      hook_event_name: "PreToolUse",
      tool_use_id: "tool-1",
      tool_name: "Bash",
      tool_input: { command: "node --version", api_key: "secret-value" },
    }),
    hook("2026-07-21T12:00:01.200Z", {
      hook_event_name: "PostToolUse",
      tool_use_id: "tool-1",
      tool_name: "Bash",
      tool_input: { command: "node --version", api_key: "secret-value" },
      tool_response: { stdout: "v24.0.0", exitCode: 0 },
    }),
    hook("2026-07-21T12:00:02.000Z", {
      hook_event_name: "PreToolUse",
      tool_use_id: "tool-2",
      tool_name: "Skill",
      tool_input: { skill: "repo-check", version: 3 },
    }),
    hook("2026-07-21T12:00:02.300Z", {
      hook_event_name: "PostToolUse",
      tool_use_id: "tool-2",
      tool_name: "Skill",
      tool_input: { skill: "repo-check", version: 3 },
      tool_response: { result: "loaded", exitCode: 0 },
    }),
    hook("2026-07-21T12:00:03.000Z", {
      hook_event_name: "PreToolUse",
      tool_use_id: "tool-3",
      tool_name: "Bash",
      tool_input: { command: "node -e \"process.exit(7)\"" },
    }),
    hook("2026-07-21T12:00:03.100Z", {
      hook_event_name: "PostToolUse",
      tool_use_id: "tool-3",
      tool_name: "Bash",
      tool_input: { command: "node -e \"process.exit(7)\"" },
      tool_response: { stdout: "", exitCode: 7, isError: true },
    }),
    hook("2026-07-21T12:00:03.200Z", {
      hook_event_name: "PreToolUse",
      tool_use_id: "tool-4",
      tool_name: "CallMcpTool",
      tool_input: { server_name: "repo-tools", tool_name: "echo", arguments: { message: "hello" } },
    }),
    hook("2026-07-21T12:00:03.250Z", {
      hook_event_name: "PostToolUse",
      tool_use_id: "tool-4",
      tool_name: "CallMcpTool",
      tool_input: { server_name: "repo-tools", tool_name: "echo", arguments: { message: "hello" } },
      tool_response: { content: "Echo: hello" },
    }),
    hook("2026-07-21T12:00:04.000Z", {
      hook_event_name: "Stop",
      last_assistant_message: "检查完成",
      parent_request_set_id: "request-set-1",
      parent_business_info: { product: "cli", version: "1.1.2" },
    }),
  ]
  const transcriptRecords = [
    {
      type: "user",
      uuid: "user-1",
      timestamp: "2026-07-21T12:00:00.000Z",
      sessionId: SESSION_ID,
      message: { role: "user", content: "检查 package.json，然后运行测试" },
      origin: { kind: "human" },
      version: "1.1.2",
    },
    {
      type: "assistant",
      uuid: "assistant-1",
      timestamp: "2026-07-21T12:00:01.000Z",
      sessionId: SESSION_ID,
      message: {
        id: "message-1",
        role: "assistant",
        model: "ultimate",
        content: [
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "node --version" } },
          { type: "tool_use", id: "tool-2", name: "Skill", input: { skill: "repo-check", version: 3 } },
          { type: "tool_use", id: "tool-3", name: "Bash", input: { command: "node -e \"process.exit(7)\"" } },
          { type: "tool_use", id: "tool-4", name: "CallMcpTool", input: { server_name: "repo-tools", tool_name: "echo", arguments: { message: "hello" } } },
        ],
      },
    },
    {
      type: "user",
      uuid: "result-1",
      timestamp: "2026-07-21T12:00:03.200Z",
      sessionId: SESSION_ID,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "v24.0.0" },
          { type: "tool_result", tool_use_id: "tool-2", content: "loaded" },
          { type: "tool_result", tool_use_id: "tool-3", content: "Exit Code: 7" },
          { type: "tool_result", tool_use_id: "tool-4", content: "Echo: hello" },
        ],
      },
    },
    {
      type: "assistant",
      uuid: "assistant-2",
      timestamp: "2026-07-21T12:00:04.000Z",
      sessionId: SESSION_ID,
      message: {
        id: "message-2",
        role: "assistant",
        model: "ultimate",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "检查完成" }],
      },
    },
  ]
  const diagnosticRecords = [
    {
      ts: "2026-07-21T12:00:00.100Z",
      type: "turn.started",
      turn_id: "turn-1",
      data: { model: "ultimate" },
    },
    {
      ts: "2026-07-21T12:00:00.200Z",
      type: "model.request.started",
      turn_id: "turn-1",
      loop_id: "turn-1:1",
      request_id: "llm-request-1",
      data: { request_index: 1, model: "ultimate" },
    },
    {
      ts: "2026-07-21T12:00:01.000Z",
      type: "model.response.completed",
      turn_id: "turn-1",
      loop_id: "turn-1:1",
      request_id: "llm-request-1",
      data: { request_index: 1, model: "ultimate", stop_reason: "tool_use", input_tokens: 20, output_tokens: 10 },
    },
    {
      ts: "2026-07-21T12:00:03.300Z",
      type: "model.request.started",
      turn_id: "turn-1",
      loop_id: "turn-1:2",
      request_id: "llm-request-2",
      data: { request_index: 2, model: "ultimate" },
    },
    {
      ts: "2026-07-21T12:00:04.000Z",
      type: "model.response.completed",
      turn_id: "turn-1",
      loop_id: "turn-1:2",
      request_id: "llm-request-2",
      data: { request_index: 2, model: "ultimate", stop_reason: "end_turn", input_tokens: 30, output_tokens: 5 },
    },
  ]
  return { hookEvents, transcriptRecords, diagnosticRecords }
}

function repeatedSampleCapture(run: number): ReturnType<typeof sampleCapture> {
  const replacements = new Map([
    [SESSION_ID, `qoder-repeat-session-${run}`],
    ["tool-1", `run-${run}-tool-1`],
    ["tool-2", `run-${run}-tool-2`],
    ["tool-3", `run-${run}-tool-3`],
    ["tool-4", `run-${run}-tool-4`],
    ["turn-1", `run-${run}-turn-1`],
    ["llm-request-1", `run-${run}-llm-request-1`],
    ["llm-request-2", `run-${run}-llm-request-2`],
    ["request-set-1", `run-${run}-request-set-1`],
    ["2026-07-21", `2026-07-${String(21 + run).padStart(2, "0")}`],
  ])
  let serialized = JSON.stringify(sampleCapture())
  for (const [source, target] of replacements) serialized = serialized.replaceAll(source, target)
  return JSON.parse(serialized)
}

function qoderTraceStructure(payload: any) {
  const resourceSpan = payload.resourceSpans[0]
  const scopeSpan = resourceSpan.scopeSpans[0]
  const spans = scopeSpan.spans as Array<any>
  const spanById = new Map(spans.map((span) => [span.spanId, span]))
  return {
    resourceAttributeKeys: resourceSpan.resource.attributes.map((attribute: any) => attribute.key).sort(),
    scope: scopeSpan.scope.name,
    spans: spans.map((span) => ({
      name: span.name,
      parentName: span.parentSpanId ? spanById.get(span.parentSpanId)?.name || "missing-parent" : null,
      kind: span.kind,
      status: span.status?.code,
      attributeKeys: span.attributes.map((attribute: any) => attribute.key).sort(),
      eventNames: (span.events || []).map((event: any) => event.name).sort(),
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  }
}

test("Qoder collector builds deterministic OTLP snapshots with LLM, tool, errors, and redaction", () => {
  const capture = sampleCapture()
  const first = buildQoderOtlpPayload(capture)
  const second = buildQoderOtlpPayload(capture)

  assert.equal(first.snapshotId, second.snapshotId)
  assert.equal(first.sessionId, SESSION_ID)
  const spans = first.resourceSpans[0].scopeSpans[0].spans as Array<{
    name: string
    status: { code: number }
    attributes: Array<{ key: string; value: { stringValue?: string } }>
  }>
  assert.equal(spans.length, 7)
  assert.equal(spans.filter((span) => span.name.startsWith("qoder.llm.")).length, 2)
  assert.equal(spans.filter((span) => span.name.startsWith("qoder.tool.")).length, 4)
  const failed = spans.find((span) => span.name === "qoder.tool.Bash" && span.status.code === 2)
  assert.ok(failed)
  const mcp = spans.find((span) => span.name === "qoder.tool.CallMcpTool")
  assert.ok(mcp)
  const mcpAttrs = Object.fromEntries(mcp.attributes.map((attribute) => [attribute.key, attribute.value.stringValue]))
  assert.equal(mcpAttrs["qoder.tool.type"], "mcp")
  assert.equal(mcpAttrs["mcp.server.name"], "repo-tools")
  assert.equal(mcpAttrs["mcp.tool.name"], "echo")
  const serialized = JSON.stringify(first)
  assert.doesNotMatch(serialized, /secret-value/)
  assert.match(serialized, /<redacted>/)
})

test("Qoder collector keeps authenticated ownership while retaining the API key hash for spool isolation", () => {
  const accountHash = "0123456789abcdef"
  const payload = buildQoderOtlpPayload({
    ...sampleCapture(),
    accountHash,
  })
  const rootSpan = payload.resourceSpans[0].scopeSpans[0].spans.find(
    (span: any) => span.name === "qoder.agent",
  )
  const rootAttributes = Object.fromEntries(
    rootSpan.attributes.map((attribute: any) => [
      attribute.key,
      attribute.value.stringValue ?? attribute.value.intValue ?? attribute.value.boolValue,
    ]),
  )
  assert.equal(rootAttributes["qoder.account.hash"], accountHash)

  const serviceEvents = normalizeOtlpTraces(payload, {
    receivedAt: "2026-07-21T12:00:04.000Z",
    authenticatedUser: "admin",
  })
  const serviceRecord = aggregateOtelTraceEvents(SESSION_ID, serviceEvents)
  assert.equal(serviceRecord?.user, "admin")
  assert.equal(serviceRecord?.authenticated_ingest, true)

  const userEvents = normalizeOtlpTraces(payload, {
    receivedAt: "2026-07-21T12:00:04.000Z",
    authenticatedUser: "alice",
  })
  const userRecord = aggregateOtelTraceEvents(SESSION_ID, userEvents)
  assert.equal(userRecord?.user, "alice")
  assert.equal(userRecord?.authenticated_ingest, true)

  const unauthenticatedEvents = normalizeOtlpTraces(payload, {
    receivedAt: "2026-07-21T12:00:04.000Z",
  })
  const unauthenticatedRecord = aggregateOtelTraceEvents(SESSION_ID, unauthenticatedEvents)
  assert.equal(unauthenticatedRecord?.user, "anonymous")
  assert.equal(unauthenticatedRecord?.authenticated_ingest, false)
})

test("Qoder tool duration falls back to transcript timestamps when async hooks collapse to zero", () => {
  const toolUseId = "mcp-zero-hook-duration"
  const payload = buildQoderOtlpPayload({
    product: "desktop",
    hookEvents: [
      hook("2026-07-26T08:08:18.690Z", {
        hook_event_name: "UserPromptSubmit",
        prompt: "Call trace_echo",
      }),
      hook("2026-07-26T08:08:38.845Z", {
        hook_event_name: "PreToolUse",
        tool_use_id: toolUseId,
        tool_name: "CallMcpTool",
        tool_input: {
          arguments: { message: "qoder-cn-mcp-trace-test" },
          server_name: "trace-echo",
          tool_name: "trace_echo",
        },
      }),
      hook("2026-07-26T08:08:38.845Z", {
        hook_event_name: "PostToolUse",
        tool_use_id: toolUseId,
        tool_name: "CallMcpTool",
        tool_response: { content: "{\"echo\":\"qoder-cn-mcp-trace-test\",\"length\":23}" },
      }),
      hook("2026-07-26T08:08:40.493Z", {
        hook_event_name: "Stop",
        last_assistant_message: "MCP completed",
        parent_business_info: { product: "desktop" },
      }),
    ],
    transcriptRecords: [
      {
        type: "user",
        sessionId: SESSION_ID,
        timestamp: "2026-07-26T08:08:18.690Z",
        message: { role: "user", content: "Call trace_echo" },
      },
      {
        type: "assistant",
        sessionId: SESSION_ID,
        timestamp: "2026-07-26T08:08:37.826Z",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: toolUseId,
            name: "CallMcpTool",
            input: {
              arguments: { message: "qoder-cn-mcp-trace-test" },
              server_name: "trace-echo",
              tool_name: "trace_echo",
            },
          }],
        },
      },
      {
        type: "user",
        sessionId: SESSION_ID,
        timestamp: "2026-07-26T08:08:37.834Z",
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: toolUseId,
            content: "{\"echo\":\"qoder-cn-mcp-trace-test\",\"length\":23}",
          }],
        },
      },
      {
        type: "assistant",
        sessionId: SESSION_ID,
        timestamp: "2026-07-26T08:08:40.493Z",
        message: { role: "assistant", content: [{ type: "text", text: "MCP completed" }] },
      },
    ],
    diagnosticRecords: [],
  })
  const mcp = (payload.resourceSpans[0].scopeSpans[0].spans as Array<any>)
    .find((span) => span.name === "qoder.tool.CallMcpTool")

  assert.ok(mcp)
  assert.equal(
    Number((BigInt(mcp.endTimeUnixNano) - BigInt(mcp.startTimeUnixNano)) / 1_000_000n),
    8,
  )
})

test("Qoder CN Desktop turns session_meta slash-command Skills into Skill Trace spans", () => {
  const hookEvents = [
    hook("2026-07-26T07:25:03.650Z", {
      hook_event_name: "UserPromptSubmit",
      transcript_path: "C:\\Users\\tester\\.qoder-cn\\projects\\repo\\transcript\\qoder-session-1.session.execution.jsonl",
    }),
    hook("2026-07-26T07:25:08.970Z", {
      hook_event_name: "Stop",
      last_assistant_message: "qoder-desktop-skill-test-done",
      parent_business_info: { product: "desktop" },
    }),
  ]
  const transcriptRecords = [
    {
      type: "session_meta",
      sessionId: SESSION_ID,
      timestamp: "2026-07-26T07:25:02.574Z",
      data: {
        meta_type: "slash_command",
        content: {
          name: "trace-probe",
          type: "skill",
          version: 1,
          filePath: "C:\\repo\\.qoder\\skills\\trace-probe\\SKILL.md",
        },
      },
    },
    {
      type: "assistant",
      sessionId: SESSION_ID,
      timestamp: "2026-07-26T07:25:05.342Z",
      message: {
        id: "skill-message-1",
        role: "assistant",
        model: "qwen",
        content: [{ type: "tool_use", id: "skill-read-1", name: "Read", input: { file_path: "package.json" } }],
      },
    },
    {
      type: "user",
      sessionId: SESSION_ID,
      timestamp: "2026-07-26T07:25:05.345Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "skill-read-1", content: "agent-insight 0.5.4" }],
      },
    },
    {
      type: "assistant",
      sessionId: SESSION_ID,
      timestamp: "2026-07-26T07:25:07.824Z",
      message: {
        id: "skill-message-2",
        role: "assistant",
        model: "qwen",
        content: [{ type: "text", text: "qoder-desktop-skill-test-done" }],
      },
    },
  ]

  const payload = buildQoderOtlpPayload({ hookEvents, transcriptRecords, product: "desktop" })
  const spans = payload.resourceSpans[0].scopeSpans[0].spans as Array<any>
  const attributes = (span: any) => Object.fromEntries(span.attributes.map((attribute: any) => [
    attribute.key,
    attribute.value.stringValue ?? attribute.value.intValue ?? attribute.value.boolValue,
  ]))
  const root = spans.find((span) => span.name === "qoder.agent")
  const skill = spans.find((span) => span.name === "qoder.tool.Skill")
  assert.ok(root)
  assert.ok(skill)
  assert.equal(attributes(root)["gen_ai.prompt"], "/trace-probe")
  assert.equal(attributes(skill)["qoder.tool.type"], "skill")
  assert.equal(attributes(skill)["qoder.skill.name"], "trace-probe")
  assert.equal(attributes(skill)["qoder.skill.version"], "1")
  assert.equal(attributes(skill)["qoder.skill.trigger_mode"], "manual")
  assert.match(attributes(skill)["qoder.skill.params"], /trace-probe/)
  assert.match(attributes(skill)["qoder.skill.result"], /qoder-desktop-skill-test-done/)

  const events = normalizeOtlpTraces(payload, { receivedAt: "2026-07-26T07:25:09.000Z", authenticatedUser: "skill-test" })
  const record = aggregateOtelTraceEvents(payload.sessionId, events)
  assert.ok(record)
  assert.equal(record.query, "/trace-probe")
  assert.equal(record.tool_call_count, 2)
  assert.deepEqual(getAdapter("qoder").extractSkills?.(normalizeInteractions(record.interactions)), [
    { name: "trace-probe", version: 1 },
  ])
})

test("Qoder CN CLI turns informational Skill activation into a Skill Trace span", () => {
  const hookEvents = [
    hook("2026-07-26T08:21:52.426Z", {
      hook_event_name: "UserPromptSubmit",
      prompt: "/trace-probe",
    }),
    hook("2026-07-26T08:21:58.551Z", {
      hook_event_name: "Stop",
      last_assistant_message: "qoder-desktop-skill-test-done",
      parent_business_info: { product: "cli", version: "1.1.5" },
    }),
  ]
  const transcriptRecords = [
    {
      type: "system",
      subtype: "informational",
      sessionId: SESSION_ID,
      timestamp: "2026-07-26T08:21:52.568Z",
      cwd: "C:\\repo",
      content: "Skill **trace-probe** activated.",
    },
    {
      type: "assistant",
      sessionId: SESSION_ID,
      timestamp: "2026-07-26T08:21:55.320Z",
      message: {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "cli-skill-read",
          name: "Read",
          input: { file_path: "package.json" },
        }],
      },
    },
    {
      type: "user",
      sessionId: SESSION_ID,
      timestamp: "2026-07-26T08:21:55.437Z",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "cli-skill-read",
          content: "agent-insight 0.5.4",
        }],
      },
    },
    {
      type: "assistant",
      sessionId: SESSION_ID,
      timestamp: "2026-07-26T08:21:58.448Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "qoder-desktop-skill-test-done" }],
      },
    },
  ]

  const payload = buildQoderOtlpPayload({ hookEvents, transcriptRecords, product: "cli" })
  const spans = payload.resourceSpans[0].scopeSpans[0].spans as Array<any>
  const skill = spans.find((span) => span.name === "qoder.tool.Skill")
  const attrs = Object.fromEntries(skill?.attributes.map((attribute: any) => [
    attribute.key,
    attribute.value.stringValue ?? attribute.value.intValue,
  ]) || [])

  assert.ok(skill)
  assert.equal(attrs["qoder.skill.name"], "trace-probe")
  assert.equal(attrs["qoder.skill.trigger_mode"], "manual")
  assert.equal(attrs["qoder.tool.type"], "skill")
  assert.match(String(attrs["qoder.skill.result"]), /qoder-desktop-skill-test-done/)
})

test("AC36 the same Qoder task produces an identical Trace structure across three runs", () => {
  const payloads = [1, 2, 3].map((run) => buildQoderOtlpPayload(repeatedSampleCapture(run)))
  assert.equal(new Set(payloads.map((payload) => payload.sessionId)).size, 3)
  assert.equal(new Set(payloads.map((payload) => payload.snapshotId)).size, 3)

  const structures = payloads.map(qoderTraceStructure)
  assert.deepEqual(structures[1], structures[0])
  assert.deepEqual(structures[2], structures[0])
  assert.equal(structures[0].spans.length, 7)
  assert.equal(structures[0].spans.filter((span: any) => span.name.startsWith("qoder.llm.")).length, 2)
  assert.equal(structures[0].spans.filter((span: any) => span.name.startsWith("qoder.tool.")).length, 4)
  assert.equal(structures[0].spans.filter((span: any) => span.parentName === "missing-parent").length, 0)

  const executionStructures = payloads.map((payload) => {
    const events = normalizeOtlpTraces(payload, { receivedAt: "2026-07-24T12:00:00.000Z", authenticatedUser: "ac36" })
    const record = aggregateOtelTraceEvents(payload.sessionId, events)
    assert.ok(record)
    return {
      framework: record.framework,
      agentName: record.agentName,
      llmCalls: record.llm_call_count,
      toolCalls: record.tool_call_count,
      toolErrors: record.tool_call_error_count,
      interactions: (record.interactions as Array<any>).map((interaction) => ({
        role: interaction.role,
        hasContent: Boolean(interaction.content),
        tools: (interaction.tool_calls || []).map((call: any) => ({
          name: call.function?.name,
          type: call.tool_type,
          hasError: Boolean(call.is_error),
        })),
      })),
    }
  })
  assert.deepEqual(executionStructures[1], executionStructures[0])
  assert.deepEqual(executionStructures[2], executionStructures[0])
})

test("AC33 one standardized Qoder task emits Agent, Subagent, Quest, Expert, Skill, Tool, and LLM traces", (context) => {
  const capture = structuredClone(sampleCapture()) as any
  capture.transcriptRecords.unshift({
    type: "session_meta",
    sessionId: SESSION_ID,
    timestamp: "2026-07-21T11:59:59.900Z",
    data: { meta_type: "session_info", content: { mode: "plan", session_type: "assistant" } },
  })

  const assistant = capture.transcriptRecords.find((record: any) => record.uuid === "assistant-1")
  assistant.message.content.push(
    {
      type: "tool_use",
      id: "ac33-goal",
      name: "createGoal",
      input: { objective: "Run the complete Qoder trace acceptance task" },
    },
    {
      type: "tool_use",
      id: "ac33-todos",
      name: "TodoWrite",
      input: { todos: [{ id: "1", content: "Collect all seven trace categories", status: "COMPLETE" }] },
    },
    {
      type: "tool_use",
      id: "ac33-subagent-tool",
      name: "Agent",
      input: { subagent_type: "Search", description: "Inspect package.json", prompt: "Read package.json" },
    },
    {
      type: "tool_use",
      id: "ac33-expert-tool",
      name: "Agent",
      input: {
        name: "Alex",
        subagent_type: "Research",
        role: "dependency reviewer",
        description: "Review the dependency metadata",
        prompt: "Review package.json dependencies",
      },
    },
  )
  const toolResults = capture.transcriptRecords.find((record: any) => record.uuid === "result-1")
  toolResults.message.content.push(
    {
      type: "tool_result",
      tool_use_id: "ac33-goal",
      content: JSON.stringify({ success: true, goalId: "ac33-quest", status: "complete" }),
    },
    { type: "tool_result", tool_use_id: "ac33-todos", content: "Todo list completed" },
    { type: "tool_result", tool_use_id: "ac33-subagent-tool", content: "agentId: ac33-subagent" },
    {
      type: "tool_result",
      tool_use_id: "ac33-expert-tool",
      content: "agentId: ac33-expert\nagentName: Alex\nagentRole: dependency reviewer",
    },
  )

  capture.hookEvents.splice(-1, 0,
    hook("2026-07-21T12:00:01.050Z", {
      hook_event_name: "PreToolUse",
      tool_use_id: "ac33-subagent-tool",
      tool_name: "Agent",
      tool_input: { subagent_type: "Search", description: "Inspect package.json" },
    }),
    hook("2026-07-21T12:00:01.100Z", {
      hook_event_name: "SubagentStart",
      tool_use_id: "ac33-subagent-tool",
      agent_id: "ac33-subagent",
      agent_type: "Search",
      description: "Inspect package.json",
    }),
    hook("2026-07-21T12:00:02.800Z", {
      hook_event_name: "SubagentStop",
      tool_use_id: "ac33-subagent-tool",
      agent_id: "ac33-subagent",
      agent_type: "Search",
      result: "package.json inspected",
      status: "completed",
      model: "qwen3.7-plus",
      provider: "qoder",
      token_usage: { input_tokens: 11, output_tokens: 4 },
    }),
    hook("2026-07-21T12:00:02.900Z", {
      hook_event_name: "PostToolUse",
      tool_use_id: "ac33-subagent-tool",
      tool_name: "Agent",
      tool_input: { subagent_type: "Search", description: "Inspect package.json" },
      tool_response: { agentId: "ac33-subagent", state: "completed" },
    }),
  )
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-ac33-"))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const qoderHome = path.join(root, ".qoder-cn")
  const transcriptDir = path.join(qoderHome, "projects", "repo", "transcript")
  const transcriptPath = path.join(transcriptDir, `${SESSION_ID}.jsonl`)
  fs.mkdirSync(transcriptDir, { recursive: true })
  fs.writeFileSync(transcriptPath, capture.transcriptRecords.map((record: any) => JSON.stringify(record)).join("\n"))
  const expertOutputDir = path.join(qoderHome, "cache", "experts", SESSION_ID, "agents")
  fs.mkdirSync(expertOutputDir, { recursive: true })
  fs.writeFileSync(path.join(expertOutputDir, "ac33-expert.output"), "Dependency review complete")
  capture.expertAgents = readQoderExpertAgents(qoderHome, transcriptPath, SESSION_ID, capture.transcriptRecords)
  assert.deepEqual(capture.expertAgents.map((agent: any) => agent.sessionId), ["ac33-expert"])

  const payload = buildQoderOtlpPayload({ ...capture, product: "desktop" })
  const spans = payload.resourceSpans[0].scopeSpans[0].spans as Array<any>
  const attrs = (span: any) => Object.fromEntries(span.attributes.map((attribute: any) => [
    attribute.key,
    attribute.value.stringValue ?? attribute.value.intValue ?? attribute.value.boolValue,
  ]))
  const byType = (type: string) => spans.filter((span) => attrs(span)["qoder.span.type"] === type)
  const subagents = byType("subagent")
  const expert = subagents.find((span) => attrs(span)["qoder.expert.name"] === "Alex")
  const ordinarySubagent = subagents.find((span) => attrs(span)["qoder.subagent.session_id"] === "ac33-subagent")
  const skill = spans.find((span) => span.name === "qoder.tool.Skill")
  const ordinaryTool = spans.find((span) => span.name === "qoder.tool.Bash")

  assert.equal(byType("agent").length, 1)
  assert.equal(subagents.length, 2)
  assert.ok(ordinarySubagent)
  assert.equal(attrs(ordinarySubagent)["qoder.expert.name"], undefined)
  assert.ok(expert)
  assert.equal(attrs(expert)["qoder.expert.role"], "dependency reviewer")
  assert.equal(byType("quest").length, 2)
  assert.ok(skill)
  assert.match(attrs(skill)["tool.arguments"], /repo-check/)
  assert.ok(ordinaryTool)
  assert.equal(byType("llm").length, 2)
  assert.equal(new Set(spans.map((span) => span.traceId)).size, 1)
  const spanIds = new Set(spans.map((span) => span.spanId))
  assert.ok(spans.every((span) => !span.parentSpanId || spanIds.has(span.parentSpanId)))

  const events = normalizeOtlpTraces(payload, {
    receivedAt: "2026-07-21T12:00:05.000Z",
    authenticatedUser: "ac33",
  })
  const record = aggregateOtelTraceEvents(SESSION_ID, events) as Record<string, any>
  assert.ok(record)
  assert.equal(record.framework, "qoder")
  assert.equal(record.agentName, "Qoder CN Desktop")
  assert.equal(record.llm_call_count, 2)
  assert.equal(record.tokens, 65)
  assert.equal(record.qoder_quest.goals[0].id, "ac33-quest")
  assert.deepEqual(record.qoder_quest.steps.map((step: any) => [step.id, step.status]), [["1", "COMPLETE"]])
  assert.deepEqual(record.qoder_experts.members.map((member: any) => [member.name, member.role]), [
    ["Alex", "dependency reviewer"],
  ])

  const tree = buildAgentCallTree(record.interactions as never[])
  assert.ok(tree)
  assert.deepEqual(tree.children.map((child) => child.agentName).sort(), ["Alex", "Search"])
  const calls = record.interactions.flatMap((interaction: any) => interaction.tool_calls || [])
  assert.ok(calls.some((call: any) => call.original_tool_name === "Bash"))
  assert.ok(calls.some((call: any) => call.original_tool_name === "Skill"))
  const qoderAdapter = getAdapter("qoder")
  assert.deepEqual(qoderAdapter.extractSkills?.(record.interactions), [{ name: "repo-check", version: 3 }])
})

test("Qoder Work unwraps lazy qw_mcp_call into the target MCP server, tool, and arguments", () => {
  const capture = sampleCapture() as any
  const callInput = {
    toolName: "mcp__trace-echo__trace_echo",
    arguments: { message: "qoderwork-mcp-trace-test" },
  }
  capture.hookEvents = [
    hook("2026-07-22T09:46:32.347Z", {
      hook_event_name: "UserPromptSubmit",
      prompt: "Call trace_echo",
      transcript_path: `C:\\Users\\tester\\.qoderworkcn\\projects\\repo\\${SESSION_ID}.jsonl`,
    }),
    hook("2026-07-22T09:46:36.169Z", {
      hook_event_name: "PreToolUse",
      tool_use_id: "mcp-get",
      tool_name: "mcp__qw-builtin__qw_mcp_get",
      tool_input: { toolName: "mcp__trace-echo__trace_echo" },
    }),
    hook("2026-07-22T09:46:37.020Z", {
      hook_event_name: "PostToolUse",
      tool_use_id: "mcp-get",
      tool_name: "mcp__qw-builtin__qw_mcp_get",
      tool_input: { toolName: "mcp__trace-echo__trace_echo" },
      tool_response: { content: "schema" },
    }),
    hook("2026-07-22T09:46:40.796Z", {
      hook_event_name: "PreToolUse",
      tool_use_id: "mcp-call",
      tool_name: "mcp__qw-builtin__qw_mcp_call",
      tool_input: callInput,
    }),
    hook("2026-07-22T09:46:41.544Z", {
      hook_event_name: "PostToolUse",
      tool_use_id: "mcp-call",
      tool_name: "mcp__qw-builtin__qw_mcp_call",
      tool_input: callInput,
      tool_response: { content: '{"echo":"qoderwork-mcp-trace-test","length":24}' },
    }),
    hook("2026-07-22T09:46:44.894Z", {
      hook_event_name: "Stop",
      last_assistant_message: "done",
      parent_business_info: { product: "qoder_work", version: "1.0.45" },
    }),
  ]
  capture.transcriptRecords = [
    {
      type: "user",
      uuid: "work-user",
      timestamp: "2026-07-22T09:46:32.347Z",
      sessionId: SESSION_ID,
      message: { role: "user", content: "Call trace_echo" },
      origin: { kind: "human" },
      version: "1.0.45",
    },
    {
      type: "assistant",
      uuid: "work-assistant-tools",
      timestamp: "2026-07-22T09:46:36.169Z",
      sessionId: SESSION_ID,
      message: {
        id: "work-message-tools",
        role: "assistant",
        model: "auto",
        content: [
          { type: "tool_use", id: "mcp-get", name: "mcp__qw-builtin__qw_mcp_get", input: { toolName: "mcp__trace-echo__trace_echo" } },
          { type: "tool_use", id: "mcp-call", name: "mcp__qw-builtin__qw_mcp_call", input: callInput },
        ],
      },
    },
    {
      type: "user",
      uuid: "work-results",
      timestamp: "2026-07-22T09:46:41.544Z",
      sessionId: SESSION_ID,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "mcp-get", content: "schema" },
          { type: "tool_result", tool_use_id: "mcp-call", content: '{"echo":"qoderwork-mcp-trace-test","length":24}' },
        ],
      },
    },
    {
      type: "assistant",
      uuid: "work-assistant-final",
      timestamp: "2026-07-22T09:46:44.894Z",
      sessionId: SESSION_ID,
      message: { id: "work-message-final", role: "assistant", model: "auto", content: [{ type: "text", text: "done" }] },
    },
  ]
  capture.diagnosticRecords = []

  const payload = buildQoderOtlpPayload({ ...capture, product: "work" })
  const spans = payload.resourceSpans[0].scopeSpans[0].spans as Array<{
    name: string
    attributes: Array<{ key: string; value: { stringValue?: string } }>
  }>
  const getSpan = spans.find((span) => span.name === "qoder.tool.mcp__qw-builtin__qw_mcp_get")
  const callSpan = spans.find((span) => span.name === "qoder.tool.mcp__qw-builtin__qw_mcp_call")
  assert.ok(getSpan)
  assert.ok(callSpan)
  const getAttrs = Object.fromEntries(getSpan.attributes.map((attribute) => [attribute.key, attribute.value.stringValue]))
  const callAttrs = Object.fromEntries(callSpan.attributes.map((attribute) => [attribute.key, attribute.value.stringValue]))
  assert.equal(getAttrs["qoder.tool.type"], "tool")
  assert.equal(callAttrs["qoder.tool.type"], "mcp")
  assert.equal(callAttrs["mcp.server.name"], "trace-echo")
  assert.equal(callAttrs["mcp.tool.name"], "trace_echo")
  assert.deepEqual(JSON.parse(callAttrs["tool.arguments"]), { message: "qoderwork-mcp-trace-test" })

  const events = normalizeOtlpTraces(payload, { receivedAt: "2026-07-22T09:46:45.000Z", authenticatedUser: "alice" })
  const record = aggregateOtelTraceEvents(SESSION_ID, events)
  const mcpCall = (record?.interactions as Array<any>)
    .flatMap((item) => Array.isArray(item.tool_calls) ? item.tool_calls : [])
    .find((call: any) => call.tool_type === "mcp")
  assert.equal(mcpCall?.original_tool_name, "mcp__qw-builtin__qw_mcp_call")
  assert.equal(mcpCall?.function?.name, "mcp__trace-echo__trace_echo")
  assert.equal(mcpCall?.mcp_server_name, "trace-echo")
  assert.equal(mcpCall?.mcp_tool_name, "trace_echo")
  assert.deepEqual(mcpCall?.function?.arguments, { message: "qoderwork-mcp-trace-test" })

  const browserCapture = structuredClone(capture)
  const browserInput = {
    toolName: "mcp__builtin_browser__navigate",
    arguments: { tabId: 742903215, url: "https://example.com" },
  }
  for (const item of browserCapture.hookEvents) {
    if (item.event.tool_use_id === "mcp-call") item.event.tool_input = browserInput
  }
  for (const item of browserCapture.transcriptRecords) {
    for (const block of Array.isArray(item.message?.content) ? item.message.content : []) {
      if (block.type === "tool_use" && block.id === "mcp-call") block.input = browserInput
    }
  }
  const browserPayload = buildQoderOtlpPayload({ ...browserCapture, product: "work" })
  const browserEvents = normalizeOtlpTraces(browserPayload, { receivedAt: "2026-07-22T10:00:00.000Z", authenticatedUser: "alice" })
  const browserRecord = aggregateOtelTraceEvents(SESSION_ID, browserEvents)
  const connectorCall = (browserRecord?.interactions as Array<any>)
    .flatMap((item) => Array.isArray(item.tool_calls) ? item.tool_calls : [])
    .find((call: any) => call.tool_type === "connector")
  assert.equal(connectorCall?.original_tool_name, "mcp__qw-builtin__qw_mcp_call")
  assert.equal(connectorCall?.function?.name, "connector__browser__navigate")
  assert.equal(connectorCall?.connector_name, "browser")
  assert.equal(connectorCall?.connector_tool_name, "navigate")
  assert.equal(connectorCall?.mcp_server_name, "builtin_browser")
  assert.deepEqual(connectorCall?.function?.arguments, { tabId: 742903215, url: "https://example.com" })

  const failedBrowserCapture = structuredClone(browserCapture)
  failedBrowserCapture.hookEvents = failedBrowserCapture.hookEvents.filter(
    (item: any) => item.event.tool_use_id !== "mcp-call",
  )
  for (const item of failedBrowserCapture.transcriptRecords) {
    for (const block of Array.isArray(item.message?.content) ? item.message.content : []) {
      if (block.type === "tool_result" && block.tool_use_id === "mcp-call") {
        block.is_error = true
        block.content = "Tool execution failed: V2 command timeout: tools/invoke"
      }
    }
  }
  const failedPayload = buildQoderOtlpPayload({ ...failedBrowserCapture, product: "work" })
  const failedSpan = failedPayload.resourceSpans[0].scopeSpans[0].spans.find(
    (span: any) => span.name === "qoder.tool.mcp__qw-builtin__qw_mcp_call",
  )
  assert.equal(failedSpan?.status?.code, 2)
  const failedAttrs = Object.fromEntries(failedSpan.attributes.map(
    (attribute: any) => [attribute.key, attribute.value.stringValue ?? attribute.value.boolValue],
  ))
  assert.equal(failedAttrs["qoder.tool.is_error"], true)
  assert.match(failedAttrs["output.value"], /command timeout/)
})

test("Qoder collector merges streamed assistant blocks before pairing diagnostic LLM durations", () => {
  const capture = sampleCapture() as any
  const firstAssistant = capture.transcriptRecords[1]
  const finalAssistant = capture.transcriptRecords[3]
  capture.transcriptRecords.splice(1, 1,
    {
      ...firstAssistant,
      uuid: "assistant-1-thinking",
      message: { ...firstAssistant.message, content: [{ type: "thinking", thinking: "checking" }] },
    },
    {
      ...firstAssistant,
      uuid: "assistant-1-tools",
    },
  )
  capture.transcriptRecords.splice(4, 1,
    {
      ...finalAssistant,
      uuid: "assistant-2-thinking",
      message: { ...finalAssistant.message, content: [{ type: "thinking", thinking: "summarizing" }] },
    },
    {
      ...finalAssistant,
      uuid: "assistant-2-text",
    },
  )

  const payload = buildQoderOtlpPayload(capture)
  const spans = payload.resourceSpans[0].scopeSpans[0].spans as Array<{
    spanId: string
    parentSpanId?: string
    name: string
    startTimeUnixNano: string
    endTimeUnixNano: string
  }>
  const llmSpans = spans.filter((span) => span.name.startsWith("qoder.llm."))
  const toolSpans = spans.filter((span) => span.name.startsWith("qoder.tool."))

  assert.equal(llmSpans.length, 2)
  assert.ok(llmSpans.every((span) => BigInt(span.endTimeUnixNano) > BigInt(span.startTimeUnixNano)))
  assert.ok(toolSpans.every((span) => llmSpans.some((llm) => llm.spanId === span.parentSpanId)))
})

test("Qoder Desktop groups id-less transcript blocks into turns and reports its product", () => {
  const hookEvents = [
    hook("2026-07-22T06:33:29.900Z", {
      hook_event_name: "UserPromptSubmit",
      prompt: "Read package.json",
      transcript_path: `C:\\Users\\tester\\.qoder-cn\\projects\\repo\\transcript\\${SESSION_ID}.jsonl`,
    }),
    hook("2026-07-22T06:33:35.500Z", {
      hook_event_name: "Stop",
      last_assistant_message: "agent-insight 0.5.4",
    }),
  ]
  const transcriptRecords = [
    { type: "user", sessionId: SESSION_ID, timestamp: "2026-07-22T06:33:29.900Z", message: { content: "Read package.json" } },
    { type: "assistant", sessionId: SESSION_ID, timestamp: "2026-07-22T06:33:33.000Z", message: { content: [{ type: "thinking", thinking: "Reading" }] } },
    { type: "assistant", sessionId: SESSION_ID, timestamp: "2026-07-22T06:33:33.010Z", message: { content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "package.json" } }] } },
    { type: "user", sessionId: SESSION_ID, timestamp: "2026-07-22T06:33:33.050Z", message: { content: [{ type: "tool_result", tool_use_id: "read-1", content: "0.5.4" }] } },
    { type: "assistant", sessionId: SESSION_ID, timestamp: "2026-07-22T06:33:35.300Z", message: { content: [{ type: "thinking", thinking: "Answering" }] } },
    { type: "assistant", sessionId: SESSION_ID, timestamp: "2026-07-22T06:33:35.400Z", message: { content: [{ type: "text", text: "agent-insight 0.5.4" }] } },
  ]

  const payload = buildQoderOtlpPayload({ hookEvents, transcriptRecords, product: "desktop" })
  const resourceAttrs = Object.fromEntries(payload.resourceSpans[0].resource.attributes.map(
    (attribute: { key: string; value: { stringValue?: string } }) => [attribute.key, attribute.value.stringValue],
  ))
  const spans = payload.resourceSpans[0].scopeSpans[0].spans as Array<{
    name: string
    startTimeUnixNano: string
    endTimeUnixNano: string
    attributes: Array<{ key: string; value: { stringValue?: string } }>
  }>
  const llmSpans = spans.filter((span) => span.name.startsWith("qoder.llm."))
  const rootAttrs = Object.fromEntries(spans[0].attributes.map((attribute) => [attribute.key, attribute.value.stringValue]))

  assert.equal(resourceAttrs["service.name"], "qoder-cn-desktop")
  assert.equal(resourceAttrs["qoder.product"], "desktop")
  assert.equal(rootAttrs["qoder.agent.name"], "Qoder CN Desktop")
  assert.equal(llmSpans.length, 2)
  assert.ok(llmSpans.every((span) => BigInt(span.endTimeUnixNano) > BigInt(span.startTimeUnixNano)))

  const events = normalizeOtlpTraces(payload, {
    receivedAt: "2026-07-22T06:33:36.000Z",
    authenticatedUser: "alice",
  })
  const record = aggregateOtelTraceEvents(SESSION_ID, events)
  assert.equal(record?.label, "Qoder CN Desktop")
  assert.equal(record?.agentName, "Qoder CN Desktop")
})

test("Qoder Desktop Quest emits a goal and stable step spans from plan transcripts", () => {
  const hookEvents = [
    hook("2026-07-22T06:45:00.000Z", { hook_event_name: "UserPromptSubmit", prompt: "Analyze the repository" }),
    hook("2026-07-22T06:45:10.000Z", { hook_event_name: "Stop", last_assistant_message: "done" }),
  ]
  const transcriptRecords = [
    { type: "session_meta", sessionId: SESSION_ID, timestamp: "2026-07-22T06:45:00.000Z", data: { meta_type: "session_info", content: { mode: "plan", session_type: "assistant" } } },
    { type: "user", sessionId: SESSION_ID, timestamp: "2026-07-22T06:45:00.100Z", message: { content: "Analyze the repository" } },
    { type: "assistant", sessionId: SESSION_ID, timestamp: "2026-07-22T06:45:01.000Z", message: { content: [
      { type: "tool_use", id: "goal-1", name: "createGoal", input: { objective: "Analyze repository" } },
      { type: "tool_use", id: "todos-1", name: "TodoWrite", input: { todos: [
        { id: "1", content: "Read package.json", status: "PENDING" },
        { id: "2", content: "Summarize README", status: "PENDING" },
      ] } },
    ] } },
    { type: "user", sessionId: SESSION_ID, timestamp: "2026-07-22T06:45:01.100Z", message: { content: [
      { type: "tool_result", tool_use_id: "goal-1", content: JSON.stringify({ success: true, goalId: "quest-goal-1", status: "active" }) },
      { type: "tool_result", tool_use_id: "todos-1", content: "Todo list updated" },
    ] } },
    { type: "assistant", sessionId: SESSION_ID, timestamp: "2026-07-22T06:45:03.000Z", message: { content: [
      { type: "tool_use", id: "todos-2", name: "TodoWrite", input: { todos: [
        { id: "1", content: "Read package.json", status: "COMPLETE" },
        { id: "2", content: "Summarize README", status: "COMPLETE" },
      ] } },
      { type: "tool_use", id: "goal-2", name: "updateGoal", input: { status: "complete" } },
    ] } },
    { type: "user", sessionId: SESSION_ID, timestamp: "2026-07-22T06:45:03.100Z", message: { content: [
      { type: "tool_result", tool_use_id: "todos-2", content: "Todo list completed" },
      { type: "tool_result", tool_use_id: "goal-2", content: "Goal completed successfully" },
    ] } },
    { type: "assistant", sessionId: SESSION_ID, timestamp: "2026-07-22T06:45:04.000Z", message: { content: [{ type: "text", text: "done" }] } },
  ]

  const payload = buildQoderOtlpPayload({ hookEvents, transcriptRecords, product: "desktop" })
  const rawSpans = payload.resourceSpans[0].scopeSpans[0].spans as Array<{
    name: string
    attributes: Array<{ key: string; value: { stringValue?: string } }>
  }>
  const questSpans = rawSpans.filter((span) => span.name.startsWith("qoder.quest."))
  assert.equal(questSpans.length, 3)
  assert.ok(questSpans.some((span) => span.name === "qoder.quest.goal"))
  assert.deepEqual(questSpans.filter((span) => span.name.startsWith("qoder.quest.step.")).map((span) => span.name), [
    "qoder.quest.step.1",
    "qoder.quest.step.2",
  ])

  const events = normalizeOtlpTraces(payload, {
    receivedAt: "2026-07-22T06:45:11.000Z",
    authenticatedUser: "alice",
  })
  const record = aggregateOtelTraceEvents(SESSION_ID, events) as Record<string, any>
  assert.ok(record.qoder_quest, JSON.stringify(events, null, 2))
  assert.equal(record.qoder_quest.mode, "plan")
  assert.equal(record.qoder_quest.goals[0].id, "quest-goal-1")
  assert.deepEqual(record.qoder_quest.steps.map((step: { id: string; status: string }) => [step.id, step.status]), [
    ["1", "COMPLETE"],
    ["2", "COMPLETE"],
  ])
  const calls = record.interactions.flatMap((interaction: { tool_calls?: Array<{ function?: { name?: string } }> }) => interaction.tool_calls || [])
  assert.deepEqual(calls.map((call: { function?: { name?: string } }) => call.function?.name).sort(), ["quest_goal", "quest_step", "quest_step"])
  assert.equal(record.tool_call_count, 3)
})

test("Qoder Desktop Experts restores member names, roles, completion output, and mode", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-experts-"))
  try {
    const qoderHome = path.join(root, ".qoder-cn")
    const transcriptDir = path.join(qoderHome, "projects", "repo", "transcript")
    const transcriptPath = path.join(transcriptDir, `${SESSION_ID}.jsonl`)
    const agentId = "expert-agent-alex"
    const transcriptRecords = [
      { type: "session_meta", sessionId: SESSION_ID, timestamp: "2026-07-22T07:00:00.000Z", data: { meta_type: "session_info", content: { mode: "experts" } } },
      { type: "user", sessionId: SESSION_ID, timestamp: "2026-07-22T07:00:00.100Z", origin: { kind: "human" }, message: { role: "user", content: "Run experts" } },
      { type: "assistant", sessionId: SESSION_ID, timestamp: "2026-07-22T07:00:01.000Z", message: { id: "turn-1", role: "assistant", content: [{ type: "tool_use", id: "expert-tool-1", name: "Agent", input: { name: "Alex", role: "researcher", subagent_type: "Research", prompt: "Read package.json" } }] } },
      { type: "user", sessionId: SESSION_ID, timestamp: "2026-07-22T07:00:01.100Z", toolUseResult: "Async agent launched successfully.\nagentId: expert-agent-alex\nagentName: Alex\nagentRole: researcher", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "expert-tool-1" }] } },
      { type: "assistant", sessionId: SESSION_ID, timestamp: "2026-07-22T07:00:05.000Z", message: { id: "turn-2", role: "assistant", content: [{ type: "text", text: "Experts complete" }] } },
    ]
    fs.mkdirSync(transcriptDir, { recursive: true })
    fs.writeFileSync(transcriptPath, transcriptRecords.map((record) => JSON.stringify(record)).join("\n"))
    fs.writeFileSync(path.join(transcriptDir, `${agentId}.jsonl`), `${JSON.stringify({ type: "assistant", sessionId: agentId, timestamp: "2026-07-22T07:00:02.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "read-1", name: "Read" }] } })}\n`)
    const expertsDir = path.join(qoderHome, "cache", "experts", SESSION_ID)
    fs.mkdirSync(path.join(expertsDir, "agents"), { recursive: true })
    fs.mkdirSync(path.join(expertsDir, "inboxes"), { recursive: true })
    fs.writeFileSync(path.join(expertsDir, "agents", `${agentId}.output`), "agent-insight 0.5.4")
    fs.writeFileSync(path.join(expertsDir, "inboxes", "leader.json"), JSON.stringify({ messages: [{ from: "Alex", timestamp: "2026-07-22T07:00:04.000Z", text: `agentId: ${agentId}` }] }))

    const expertAgents = readQoderExpertAgents(qoderHome, transcriptPath, SESSION_ID, transcriptRecords)
    assert.equal(expertAgents.length, 1)
    assert.equal(expertAgents[0].name, "Alex")
    assert.equal(expertAgents[0].role, "researcher")
    assert.equal(expertAgents[0].output, "agent-insight 0.5.4")

    const payload = buildQoderOtlpPayload({
      hookEvents: [
        hook("2026-07-22T07:00:00.100Z", { hook_event_name: "UserPromptSubmit", prompt: "Run experts" }),
        hook("2026-07-22T07:00:05.000Z", { hook_event_name: "Stop", last_assistant_message: "Experts complete" }),
      ],
      transcriptRecords,
      expertAgents,
      product: "desktop",
    })
    const events = normalizeOtlpTraces(payload, { receivedAt: "2026-07-22T07:00:06.000Z", authenticatedUser: "alice" })
    const record = aggregateOtelTraceEvents(SESSION_ID, events)
    assert.ok(record)
    assert.equal((record.interactions as any[])[0].qoder_mode, "experts")
    assert.equal(record.qoder_experts?.members?.[0]?.name, "Alex")
    assert.equal(record.qoder_experts?.members?.[0]?.role, "researcher")
    const tree = buildAgentCallTree(record.interactions as never[])
    assert.ok(tree)
    assert.equal(tree.children[0].agentName, "Alex")
    assert.equal(tree.children[0].events[0].summary, "agent-insight 0.5.4")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("Qoder Desktop isolates reused-session turns and restores parallel Agent tools as child agents", () => {
  const hookEvents = [
    hook("2026-07-22T06:55:37.200Z", { hook_event_name: "UserPromptSubmit", prompt: "Run two agents" }),
    hook("2026-07-22T06:55:42.000Z", { hook_event_name: "PreToolUse", tool_use_id: "agent-readme", tool_name: "Agent" }),
    hook("2026-07-22T06:55:42.000Z", { hook_event_name: "PreToolUse", tool_use_id: "agent-package", tool_name: "Agent" }),
    hook("2026-07-22T06:55:43.000Z", { hook_event_name: "PreToolUse", tool_use_id: "read-readme", tool_name: "Read", tool_input: { file_path: "README.md" } }),
    hook("2026-07-22T06:55:43.100Z", { hook_event_name: "PostToolUse", tool_use_id: "read-readme", tool_name: "Read", tool_input: { file_path: "README.md" }, tool_response: { content: "title" } }),
    hook("2026-07-22T06:55:43.000Z", { hook_event_name: "PreToolUse", tool_use_id: "read-package", tool_name: "Read", tool_input: { file_path: "package.json" } }),
    hook("2026-07-22T06:55:43.100Z", { hook_event_name: "PostToolUse", tool_use_id: "read-package", tool_name: "Read", tool_input: { file_path: "package.json" }, tool_response: { content: "0.5.4" } }),
    hook("2026-07-22T06:55:46.400Z", { hook_event_name: "PostToolUse", tool_use_id: "agent-readme", tool_name: "Agent" }),
    hook("2026-07-22T06:55:46.500Z", { hook_event_name: "PostToolUse", tool_use_id: "agent-package", tool_name: "Agent" }),
    hook("2026-07-22T06:55:49.300Z", { hook_event_name: "Stop", last_assistant_message: "done" }),
  ]
  const transcriptRecords = [
    { type: "user", sessionId: SESSION_ID, timestamp: "2026-07-22T06:33:00.000Z", message: { content: "old prompt" } },
    { type: "assistant", sessionId: SESSION_ID, timestamp: "2026-07-22T06:33:03.000Z", message: { content: [{ type: "text", text: "old result" }] } },
    { type: "session_meta", sessionId: SESSION_ID, timestamp: "2026-07-22T06:55:37.100Z", data: { meta_type: "session_info", content: { mode: "agent" } } },
    { type: "user", sessionId: SESSION_ID, timestamp: "2026-07-22T06:55:37.200Z", message: { content: "Run two agents" } },
    { type: "assistant", sessionId: SESSION_ID, timestamp: "2026-07-22T06:55:42.000Z", message: { content: [
      { type: "tool_use", id: "agent-readme", name: "Agent", input: { subagent_type: "Search", description: "Read README.md", prompt: "Read README.md" } },
      { type: "tool_use", id: "agent-package", name: "Agent", input: { subagent_type: "Search", description: "Read package.json", prompt: "Read package.json" } },
    ] } },
    { type: "user", sessionId: SESSION_ID, timestamp: "2026-07-22T06:55:46.500Z", message: { content: [
      { type: "tool_result", tool_use_id: "agent-readme", content: "README title" },
      { type: "tool_result", tool_use_id: "agent-package", content: "agent-insight 0.5.4" },
    ] } },
    { type: "assistant", sessionId: SESSION_ID, timestamp: "2026-07-22T06:55:49.200Z", message: { content: [{ type: "text", text: "done" }] } },
  ]

  const payload = buildQoderOtlpPayload({ hookEvents, transcriptRecords, product: "desktop" })
  const rawSpans = payload.resourceSpans[0].scopeSpans[0].spans as Array<{
    name: string
    startTimeUnixNano: string
    endTimeUnixNano: string
    attributes: Array<{ key: string; value: { stringValue?: string } }>
  }>
  assert.equal(rawSpans.filter((span) => span.name.startsWith("qoder.llm.")).length, 2)
  assert.equal(rawSpans.filter((span) => span.name === "qoder.subagent.Search").length, 2)
  const root = rawSpans.find((span) => span.name === "qoder.agent")!
  assert.ok(Number((BigInt(root.endTimeUnixNano) - BigInt(root.startTimeUnixNano)) / 1_000_000n) < 15_000)
  const readOwners = rawSpans.filter((span) => span.name === "qoder.tool.Read").map((span) =>
    Object.fromEntries(span.attributes.map((attribute) => [attribute.key, attribute.value.stringValue]))["qoder.subagent.session_id"])
  assert.equal(new Set(readOwners).size, 2)
  assert.ok(readOwners.every(Boolean))

  const events = normalizeOtlpTraces(payload, {
    receivedAt: "2026-07-22T06:55:50.000Z",
    authenticatedUser: "alice",
  })
  const record = aggregateOtelTraceEvents(SESSION_ID, events)!
  const tree = buildAgentCallTree(record.interactions as never[])
  assert.equal(tree.children.length, 2, JSON.stringify(record.interactions, null, 2))
  assert.ok(tree.children.every((child) => child.agentName === "Search"))
})

test("Qoder collector truncates long content at the configured boundary", () => {
  const value = redactAndTruncate({ prompt: "x".repeat(30), authorization: "Bearer secret" }, 10)
  assert.match(value.prompt, /^x{10}…\[truncated 20 chars\]$/)
  assert.equal(value.authorization, "<redacted>")
})

test("Qoder collector writes account-isolated event files and a pending snapshot on Stop", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-collector-"))
  try {
    const transcriptPath = path.join(root, ".qoder-cn", "projects", "repo", `${SESSION_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true })
    fs.writeFileSync(transcriptPath, sampleCapture().transcriptRecords.map((record) => JSON.stringify(record)).join("\n") + "\n")
    const options = {
      homeDir: root,
      insightDir: path.join(root, ".agent-insight"),
      qoderHome: path.join(root, ".qoder-cn"),
      env: { AGENT_INSIGHT_API_KEY: "account-a" },
    }
    const first = await collectQoderHook({
      session_id: SESSION_ID,
      transcript_path: transcriptPath,
      hook_event_name: "UserPromptSubmit",
      prompt: "hello",
    }, { ...options, disableUploadKick: true })
    const result = await collectQoderHook({
      session_id: SESSION_ID,
      transcript_path: transcriptPath,
      hook_event_name: "Stop",
      last_assistant_message: "done",
    }, { ...options, disableUploadKick: true })

    assert.match(result.spoolDir, new RegExp(`qoder[\\\\/]cli[\\\\/]${result.apiKeyHash}$`))
    assert.ok(result.pendingFile)
    assert.ok(fs.existsSync(first.eventFile))
    assert.ok(fs.existsSync(result.eventFile))
    assert.equal(fs.readdirSync(path.dirname(result.eventFile)).filter((name) => name.endsWith(".json")).length, 2)
    assert.ok(fs.existsSync(result.pendingFile!))
    const pending = JSON.parse(fs.readFileSync(result.pendingFile!, "utf8"))
    assert.equal(pending.sessionId, SESSION_ID)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("Qoder Desktop hook events use an account-isolated desktop spool", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-desktop-collector-"))
  try {
    const transcriptPath = path.join(root, ".qoder-cn", "projects", "repo", "transcript", `${SESSION_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true })
    fs.writeFileSync(transcriptPath, sampleCapture().transcriptRecords.map((record) => JSON.stringify(record)).join("\n") + "\n")
    const options = {
      homeDir: root,
      insightDir: path.join(root, ".agent-insight"),
      qoderHome: path.join(root, ".qoder-cn"),
      env: {
        AGENT_INSIGHT_API_KEY: "account-a",
        AGENT_INSIGHT_QODER_ESTIMATE_VISIBLE_TOKENS: "1",
      },
      disableUploadKick: true,
    }
    await collectQoderHook({
      session_id: SESSION_ID,
      transcript_path: transcriptPath,
      hook_event_name: "UserPromptSubmit",
      prompt: "hello",
    }, options)
    const result = await collectQoderHook({
      session_id: SESSION_ID,
      transcript_path: transcriptPath,
      hook_event_name: "Stop",
      last_assistant_message: "done",
    }, options)

    assert.match(result.spoolDir, new RegExp(`qoder[\\\\/]desktop[\\\\/]${result.apiKeyHash}$`))
    const pending = JSON.parse(fs.readFileSync(result.pendingFile!, "utf8"))
    const resource = Object.fromEntries(pending.resourceSpans[0].resource.attributes.map(
      (attribute: { key: string; value: { stringValue?: string } }) => [attribute.key, attribute.value.stringValue],
    ))
    assert.equal(resource["service.name"], "qoder-cn-desktop")
    const llmSpan = pending.resourceSpans[0].scopeSpans[0].spans.find(
      (span: { name: string }) => span.name.startsWith("qoder.llm."),
    )
    const llmAttrs = Object.fromEntries(llmSpan.attributes.map(
      (attribute: any) => [attribute.key, attribute.value.stringValue ?? attribute.value.intValue ?? attribute.value.boolValue],
    ))
    assert.equal(llmAttrs["qoder.token_usage.estimated"], true)
    assert.ok(Number(llmAttrs["qoder.token_usage.estimated_total_tokens"]) > 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("Qoder JetBrains markers override the shared Desktop transcript layout", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-jetbrains-collector-"))
  try {
    const insightDir = path.join(root, ".agent-insight")
    const markerDir = path.join(insightDir, "qoder-jetbrains", "ide-processes")
    fs.mkdirSync(markerDir, { recursive: true })
    fs.writeFileSync(path.join(markerDir, "4242.json"), JSON.stringify({
      pid: 4242,
      updatedAt: "2026-07-22T08:00:00.000Z",
    }))
    const transcriptPath = path.join(root, ".qoder", "projects", "repo", "transcript", `${SESSION_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true })
    fs.writeFileSync(transcriptPath, sampleCapture().transcriptRecords.map((record) => JSON.stringify(record)).join("\n") + "\n")
    const event = {
      session_id: SESSION_ID,
      transcript_path: transcriptPath,
      hook_event_name: "Stop",
      last_assistant_message: "done",
    }
    assert.equal(detectQoderProduct(event, {
      insightDir,
      ancestorPids: [7777, 4242],
      nowMs: Date.parse("2026-07-22T08:00:30.000Z"),
    }), "jetbrains")
    assert.equal(detectQoderProduct(event, {
      insightDir,
      ancestorPids: [7777],
      nowMs: Date.parse("2026-07-22T08:00:30.000Z"),
    }), "desktop")

    const result = await collectQoderHook(event, {
      homeDir: root,
      insightDir,
      qoderHome: path.join(root, ".qoder"),
      env: { AGENT_INSIGHT_API_KEY: "account-a" },
      ancestorPids: [7777, 4242],
      nowMs: Date.parse("2026-07-22T08:00:30.000Z"),
      disableUploadKick: true,
    })
    assert.match(result.spoolDir, new RegExp(`qoder[\\\\/]jetbrains[\\\\/]${result.apiKeyHash}$`))
    const pending = JSON.parse(fs.readFileSync(result.pendingFile!, "utf8"))
    const resource = Object.fromEntries(pending.resourceSpans[0].resource.attributes.map(
      (attribute: { key: string; value: { stringValue?: string } }) => [attribute.key, attribute.value.stringValue],
    ))
    assert.equal(resource["service.name"], "qoder-jetbrains")
    assert.equal(resource["qoder.product"], "jetbrains")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("Qoder JetBrains session logs recover detached shared-client sessions and merge early events", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-jetbrains-session-log-"))
  try {
    const insightDir = path.join(root, ".agent-insight")
    const markerDir = path.join(insightDir, "qoder-jetbrains", "ide-processes")
    const ideLogPath = path.join(root, "jetbrains-log")
    fs.mkdirSync(markerDir, { recursive: true })
    fs.mkdirSync(ideLogPath, { recursive: true })
    fs.writeFileSync(path.join(markerDir, "4242.json"), JSON.stringify({
      pid: 4242,
      updatedAt: "2026-07-22T08:00:00.000Z",
      ideLogPath,
    }))
    fs.writeFileSync(path.join(ideLogPath, "idea.log"), "JetBrains startup\n")
    const qoderHome = path.join(root, ".qoder")
    const transcriptPath = path.join(qoderHome, "projects", "repo", "transcript", `${SESSION_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true })
    fs.writeFileSync(transcriptPath, sampleCapture().transcriptRecords.map((record) => JSON.stringify(record)).join("\n") + "\n")
    const options = {
      homeDir: root,
      insightDir,
      qoderHome,
      env: { AGENT_INSIGHT_API_KEY: "account-a" },
      ancestorPids: [7777],
      nowMs: Date.parse("2026-07-22T08:00:30.000Z"),
      disableUploadKick: true,
    }
    const first = await collectQoderHook({
      session_id: SESSION_ID,
      transcript_path: transcriptPath,
      hook_event_name: "UserPromptSubmit",
      prompt: "hello",
    }, options)
    assert.match(first.spoolDir, new RegExp(`qoder[\\\\/]desktop[\\\\/]${first.apiKeyHash}$`))

    fs.appendFileSync(path.join(ideLogPath, "idea.log"),
      `2026-07-22 INFO - #com.alibabacloud.intellij.qoder.core.lsp.LanguageClientImpl - Ask finish. sessionId=${SESSION_ID}\n`,
    )
    const result = await collectQoderHook({
      session_id: SESSION_ID,
      transcript_path: transcriptPath,
      hook_event_name: "Stop",
      last_assistant_message: "done",
    }, options)

    assert.match(result.spoolDir, new RegExp(`qoder[\\\\/]jetbrains[\\\\/]${result.apiKeyHash}$`))
    const eventDir = path.dirname(result.eventFile)
    const sessionKey = path.basename(eventDir)
    assert.equal(fs.readdirSync(eventDir).filter((name) => name.endsWith(".json")).length, 2)
    assert.equal(fs.existsSync(path.join(first.spoolDir, "events", sessionKey)), false)
    const pending = JSON.parse(fs.readFileSync(result.pendingFile!, "utf8"))
    const resource = Object.fromEntries(pending.resourceSpans[0].resource.attributes.map(
      (attribute: { key: string; value: { stringValue?: string } }) => [attribute.key, attribute.value.stringValue],
    ))
    assert.equal(resource["service.name"], "qoder-jetbrains")
    assert.equal(resource["qoder.product"], "jetbrains")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("Qoder Work uses its own home, diagnostics, product name, and account-isolated spool", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-work-collector-"))
  try {
    const insightDir = path.join(root, ".agent-insight")
    const qoderWorkHome = path.join(root, ".qoderworkcn")
    const projectKey = "C--Users-test--qoderworkcn-workspace-test"
    const transcriptPath = path.join(qoderWorkHome, "projects", projectKey, `${SESSION_ID}.jsonl`)
    const segmentsDir = path.join(qoderWorkHome, "logs", "sessions", projectKey, SESSION_ID, "segments")
    const capture = sampleCapture()
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true })
    fs.mkdirSync(segmentsDir, { recursive: true })
    fs.writeFileSync(transcriptPath, capture.transcriptRecords.map((record) => JSON.stringify(record)).join("\n") + "\n")
    fs.writeFileSync(path.join(segmentsDir, "segment.jsonl"), capture.diagnosticRecords.map((record) => JSON.stringify(record)).join("\n") + "\n")
    const options = {
      homeDir: root,
      insightDir,
      env: { AGENT_INSIGHT_API_KEY: "account-a" },
      disableUploadKick: true,
    }
    const first = await collectQoderHook({
      session_id: SESSION_ID,
      transcript_path: transcriptPath,
      hook_event_name: "UserPromptSubmit",
      prompt: "Analyze a document",
    }, options)
    assert.match(first.spoolDir, new RegExp(`qoder[\\\\/]work[\\\\/]${first.apiKeyHash}$`))
    const result = await collectQoderHook({
      session_id: SESSION_ID,
      transcript_path: transcriptPath,
      hook_event_name: "Stop",
      last_assistant_message: "done",
      parent_business_info: { product: "qoder_work", version: "1.0.45" },
    }, options)
    const pending = JSON.parse(fs.readFileSync(result.pendingFile!, "utf8"))
    const resource = Object.fromEntries(pending.resourceSpans[0].resource.attributes.map(
      (attribute: { key: string; value: { stringValue?: string } }) => [attribute.key, attribute.value.stringValue],
    ))
    const rootSpan = pending.resourceSpans[0].scopeSpans[0].spans[0]
    const rootAttrs = Object.fromEntries(rootSpan.attributes.map(
      (attribute: { key: string; value: { stringValue?: string; intValue?: string } }) => [attribute.key, attribute.value.stringValue ?? attribute.value.intValue],
    ))
    assert.equal(resource["service.name"], "qoder-work")
    assert.equal(resource["qoder.product"], "work")
    assert.equal(rootAttrs["qoder.agent.name"], "Qoder Work")
    const events = normalizeOtlpTraces(pending, { receivedAt: "2026-07-22T08:00:00.000Z", authenticatedUser: "alice" })
    const record = aggregateOtelTraceEvents(SESSION_ID, events)
    assert.equal(record?.agentName, "Qoder Work")
    assert.equal(record?.tokens, 65)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("Qoder uploader deletes acknowledged snapshots and persists exponential retry state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-uploader-"))
  try {
    const spoolDir = path.join(root, "spool")
    const pendingDir = path.join(spoolDir, "pending")
    fs.mkdirSync(pendingDir, { recursive: true })
    const successSessionKey = "a".repeat(32)
    const eventDir = path.join(spoolDir, "events", successSessionKey)
    fs.mkdirSync(eventDir, { recursive: true })
    fs.writeFileSync(path.join(eventDir, "event.json"), "{}")
    const successFile = path.join(pendingDir, `${successSessionKey}-success.json`)
    fs.writeFileSync(successFile, JSON.stringify({ resourceSpans: [] }))
    const requests: Array<{ url: string; init: { headers: Record<string, string> } }> = []
    const success = await uploadPending({
      spoolDir,
      endpoint: "http://localhost:3000/api/ingest/otel/v1/traces",
      apiKey: "test-key",
      fetch: async (url: string, init: { headers: Record<string, string> }) => {
        requests.push({ url, init })
        return { ok: true, status: 200 }
      },
    })
    assert.equal(success.uploaded, 1)
    assert.equal(fs.existsSync(successFile), false)
    assert.equal(fs.existsSync(eventDir), false)
    assert.equal(requests[0].init.headers["x-witty-api-key"], "test-key")

    const failedFile = path.join(pendingDir, "failed.json")
    fs.writeFileSync(failedFile, JSON.stringify({ resourceSpans: [] }))
    const failed = await uploadPending({
      spoolDir,
      endpoint: "http://localhost:3000/api/ingest/otel/v1/traces",
      fetch: async () => ({ ok: false, status: 503 }),
      retryBaseMs: 100,
      retryCapMs: 10_000,
      now: () => 1000,
    })
    assert.equal(failed.failed, 1)
    assert.ok(fs.existsSync(failedFile))
    const retry = JSON.parse(fs.readFileSync(`${failedFile}.retry.json`, "utf8"))
    assert.equal(retry.attempts, 1)
    assert.equal(retry.nextAttemptAt, 1100)
    assert.deepEqual([1, 2, 3, 4, 5].map((attempt) => retryDelayMs(attempt, 100, 10_000)), [100, 100, 100, 200, 400])
    assert.equal(resolveTraceEndpoint("http://localhost:3000/"), "http://localhost:3000/api/ingest/otel/v1/traces")

    const forced = await uploadPending({
      spoolDir,
      endpoint: "http://localhost:3000/api/ingest/otel/v1/traces",
      fetch: async () => ({ ok: true, status: 200 }),
      now: () => 1000,
      force: true,
    })
    assert.equal(forced.uploaded, 1)
    assert.equal(fs.existsSync(failedFile), false)

    fs.writeFileSync(path.join(spoolDir, "upload-run.lock"), JSON.stringify({ pid: process.pid }))
    let lockedRequestCount = 0
    const locked = await uploadPending({
      spoolDir,
      endpoint: "http://localhost:3000/api/ingest/otel/v1/traces",
      fetch: async () => {
        lockedRequestCount++
        return { ok: true, status: 200 }
      },
    })
    assert.equal(locked.locked, true)
    assert.equal(lockedRequestCount, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("Qoder deactivation flush snapshots active sessions and uploads pending data", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-flush-"))
  try {
    const insightDir = path.join(root, ".agent-insight")
    const spoolDir = path.join(insightDir, "otel_data", "qoder", "desktop", "account")
    const transcriptPath = path.join(root, ".qoder-cn", "projects", "repo", `${SESSION_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true })
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({ type: "user", sessionId: SESSION_ID, timestamp: "2026-07-24T08:00:00.000Z", message: { content: "flush active session" } }),
      JSON.stringify({ type: "assistant", sessionId: SESSION_ID, timestamp: "2026-07-24T08:00:01.000Z", message: { id: "assistant-1", model: "qmodel", content: [{ type: "text", text: "active result" }] } }),
    ].join("\n"))
    await collectQoderHook({
      session_id: SESSION_ID,
      transcript_path: transcriptPath,
      hook_event_name: "UserPromptSubmit",
      prompt: "flush active session",
      qoder_product: "desktop",
    }, {
      homeDir: root,
      insightDir,
      spoolDir,
      disableUploadKick: true,
    })
    const requests: Array<{ body: string }> = []
    const result = await flushQoderProduct({
      homeDir: root,
      insightDir,
      spoolDir,
      product: "desktop",
      env: {
        AGENT_INSIGHT_HOST: "http://localhost:3000",
        AGENT_INSIGHT_API_KEY: "account-a",
      },
      uploadPending,
      uploadOptions: {
        fetch: async (_url: string, init: { body: string }) => {
          requests.push({ body: init.body })
          return { ok: true, status: 200 }
        },
      },
    })
    assert.equal(result.snapshotted, 1)
    assert.equal(result.snapshotFailed, 0)
    assert.equal(result.uploaded, 1)
    assert.equal(requests.length, 1)
    const payload = JSON.parse(requests[0].body)
    const spans = payload.resourceSpans[0].scopeSpans[0].spans
    const rootSpan = spans.find((span: { name: string }) => span.name === "qoder.agent")
    const attributes = Object.fromEntries(rootSpan.attributes.map(
      (attribute: { key: string; value: { boolValue?: boolean; stringValue?: string } }) => [attribute.key, attribute.value.boolValue ?? attribute.value.stringValue],
    ))
    assert.equal(attributes["qoder.trace.completed"], true)
    assert.equal(attributes["output.value"], "active result")
    assert.equal(fs.existsSync(path.join(spoolDir, "events")), true)
    assert.deepEqual(fs.readdirSync(path.join(spoolDir, "events")), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("AC24 Qoder SessionEnd reaches the OTLP endpoint within three seconds", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-session-end-upload-"))
  const insightDir = path.join(root, ".agent-insight")
  const spoolDir = path.join(insightDir, "otel_data", "qoder", "desktop", "account")
  const transcriptPath = path.join(root, ".qoder-cn", "projects", "repo", `${SESSION_ID}.jsonl`)
  let resolveRequest: ((value: { receivedAt: number; body: string }) => void) | undefined
  let rejectRequest: ((reason?: unknown) => void) | undefined
  const requestReceived = new Promise<{ receivedAt: number; body: string }>((resolve, reject) => {
    resolveRequest = resolve
    rejectRequest = reject
  })
  const server = http.createServer((request, response) => {
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (chunk) => { body += chunk })
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end("{}")
      resolveRequest?.({ receivedAt: Date.now(), body })
    })
    request.on("error", rejectRequest)
  })

  try {
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true })
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({ type: "user", sessionId: SESSION_ID, timestamp: "2026-07-24T08:00:00.000Z", message: { content: "AC24 upload test" } }),
      JSON.stringify({ type: "assistant", sessionId: SESSION_ID, timestamp: "2026-07-24T08:00:01.000Z", message: { id: "assistant-ac24", model: "qmodel", content: [{ type: "text", text: "AC24 done" }] } }),
    ].join("\n"))
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const startedAt = Date.now()
    const result = await collectQoderHook({
      session_id: SESSION_ID,
      transcript_path: transcriptPath,
      hook_event_name: "SessionEnd",
      last_assistant_message: "AC24 done",
      qoder_product: "desktop",
    }, {
      homeDir: root,
      insightDir,
      spoolDir,
      uploaderPath: path.join(process.cwd(), "scripts", "qoder_uploader_client.mjs"),
      env: {
        AGENT_INSIGHT_HOST: `http://127.0.0.1:${address.port}`,
        AGENT_INSIGHT_API_KEY: "ac24-test-key",
      },
    })
    assert.ok(result.pendingFile)

    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("SessionEnd upload did not reach the server within 3000ms")), 3_000).unref()
    })
    const received = await Promise.race([requestReceived, timeout])
    const elapsedMs = received.receivedAt - startedAt
    assert.ok(elapsedMs < 3_000, `SessionEnd upload took ${elapsedMs}ms`)
    const payload = JSON.parse(received.body)
    assert.ok(Array.isArray(payload.resourceSpans))
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        fs.rmSync(root, { recursive: true, force: true })
        break
      } catch (error: any) {
        if (attempt === 19 || !["EBUSY", "ENOTEMPTY", "EPERM"].includes(error?.code)) throw error
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
  }
})

test("Qoder OTLP adapter converts the latest snapshot into an ExecutionRecord", () => {
  const payload = buildQoderOtlpPayload(sampleCapture())
  const events = normalizeOtlpTraces(payload, { receivedAt: "2026-07-21T12:00:05.000Z", authenticatedUser: "alice" })
  const adapter = getOtelTraceAdapter(events)
  const record = aggregateOtelTraceEvents(SESSION_ID, events)

  assert.equal(adapter.id, "qoder")
  assert.ok(record)
  assert.equal(record.framework, "qoder")
  assert.equal(record.query, "检查 package.json，然后运行测试")
  assert.equal(record.final_result, "检查完成")
  assert.equal(record.model, "ultimate")
  assert.equal(record.tokens, 65)
  assert.equal(record.input_tokens, 50)
  assert.equal(record.output_tokens, 15)
  assert.equal(record.latency, 4)
  assert.equal(record.llm_call_count, 2)
  assert.equal(record.tool_call_count, 4)
  assert.equal(record.tool_call_error_count, 1)
  const interactions = record.interactions as Array<Record<string, unknown>>
  assert.equal(interactions.filter((item) => item.role === "assistant").length, 2)
  assert.equal(interactions.flatMap((item) => Array.isArray(item.tool_calls) ? item.tool_calls : []).length, 4)
  const mcpCall = interactions
    .flatMap((item) => Array.isArray(item.tool_calls) ? item.tool_calls : [])
    .find((call: any) => call.tool_type === "mcp")
  assert.equal(mcpCall?.function?.name, "mcp__repo-tools__echo")
  assert.equal(mcpCall?.mcp_server_name, "repo-tools")
  assert.equal(mcpCall?.mcp_tool_name, "echo")
  assert.deepEqual(getAdapter("qoder").extractSkills?.(normalizeInteractions(interactions)), [
    { name: "repo-check", version: 3 },
  ])
})

test("Qoder OTLP adapter leaves token totals unavailable when Qoder reports no usage", () => {
  const capture = sampleCapture()
  capture.diagnosticRecords = []
  const payload = buildQoderOtlpPayload(capture)
  const events = normalizeOtlpTraces(payload, { receivedAt: "2026-07-21T12:00:05.000Z", authenticatedUser: "alice" })
  const record = aggregateOtelTraceEvents(SESSION_ID, events)

  assert.ok(record)
  assert.equal(record.tokens, undefined)
  assert.equal(record.input_tokens, undefined)
  assert.equal(record.output_tokens, undefined)
})

test("Qoder Desktop can opt into visible transcript estimates without presenting them as exact usage", () => {
  const capture = sampleCapture()
  capture.diagnosticRecords = []
  const payload = buildQoderOtlpPayload({ ...capture, product: "desktop", estimateVisibleTokens: true })
  const spans = payload.resourceSpans[0].scopeSpans[0].spans as Array<any>
  const llmSpans = spans.filter((span) => span.name.startsWith("qoder.llm."))
  const firstAttrs = Object.fromEntries(llmSpans[0].attributes.map((attribute: any) => [
    attribute.key,
    attribute.value.stringValue ?? attribute.value.intValue ?? attribute.value.boolValue,
  ]))

  assert.equal(firstAttrs["qoder.token_usage.available"], false)
  assert.equal(firstAttrs["qoder.token_usage.estimated"], true)
  assert.equal(firstAttrs["qoder.token_usage.source"], "local_visible_transcript")
  assert.equal(firstAttrs["qoder.token_usage.scope"], "visible_transcript")
  assert.equal(firstAttrs["qoder.token_usage.missing_context"], true)
  assert.ok(Number(firstAttrs["qoder.token_usage.estimated_input_tokens"]) > 0)
  assert.ok(Number(firstAttrs["qoder.token_usage.estimated_total_tokens"]) > 0)

  const events = normalizeOtlpTraces(payload, { receivedAt: "2026-07-21T12:00:05.000Z", authenticatedUser: "alice" })
  const record = aggregateOtelTraceEvents(SESSION_ID, events)
  assert.ok(record)
  assert.ok((record.tokens || 0) > 0)
  assert.equal(record.input_tokens, undefined)
  assert.equal(record.output_tokens, undefined)
  assert.equal(record.token_usage_estimated, true)
  const assistant = (record.interactions as Array<any>).find((interaction) => interaction.role === "assistant")
  assert.equal(assistant.usage.estimated, true)
  assert.equal(assistant.usage.source, "local_visible_transcript")
  assert.equal(assistant.usage.scope, "visible_transcript")
  assert.equal(assistant.usage.missing_context, true)
  assert.ok(assistant.usage.input > 0)
  assert.ok(assistant.usage.total > 0)
})

test("Qoder Desktop does not estimate hidden token usage by default", () => {
  const capture = sampleCapture()
  capture.diagnosticRecords = []
  const payload = buildQoderOtlpPayload({ ...capture, product: "desktop" })
  const events = normalizeOtlpTraces(payload, { receivedAt: "2026-07-21T12:00:05.000Z", authenticatedUser: "alice" })
  const record = aggregateOtelTraceEvents(SESSION_ID, events)

  assert.ok(record)
  assert.equal(record.tokens, undefined)
  assert.equal(record.token_usage_estimated, false)
})

test("Qoder Desktop keeps diagnostics usage exact when it is available", () => {
  const payload = buildQoderOtlpPayload({ ...sampleCapture(), product: "desktop" })
  const events = normalizeOtlpTraces(payload, { receivedAt: "2026-07-21T12:00:05.000Z", authenticatedUser: "alice" })
  const record = aggregateOtelTraceEvents(SESSION_ID, events)

  assert.ok(record)
  assert.equal(record.tokens, 65)
  assert.equal(record.input_tokens, 50)
  assert.equal(record.output_tokens, 15)
  assert.equal(record.token_usage_estimated, false)
  assert.ok((record.interactions as Array<any>)
    .filter((interaction) => interaction.role === "assistant")
    .every((interaction) => interaction.usage.estimated === false))
})

test("Qoder Desktop uses exact local SQLite usage before visible transcript estimates", () => {
  const capture = sampleCapture()
  capture.diagnosticRecords = []
  const localTokenUsage = [
    {
      messageId: "db-message-1",
      requestId: "db-request-1",
      timestampMs: Date.parse("2026-07-21T12:00:01.000Z"),
      model: "qwen-local-db",
      inputTokens: 120,
      outputTokens: 10,
      reasoningTokens: 0,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
    },
    {
      messageId: "db-message-2",
      requestId: "db-request-1",
      timestampMs: Date.parse("2026-07-21T12:00:04.000Z"),
      model: "qwen-local-db",
      inputTokens: 150,
      outputTokens: 20,
      reasoningTokens: 0,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
    },
  ]
  const payload = buildQoderOtlpPayload({
    ...capture,
    product: "desktop",
    localTokenUsage,
    estimateVisibleTokens: true,
  })
  const spans = payload.resourceSpans[0].scopeSpans[0].spans as Array<any>
  const llmSpans = spans.filter((span) => span.name.startsWith("qoder.llm."))
  assert.equal(llmSpans.length, 2)
  const attributes = llmSpans.map((span) => Object.fromEntries(span.attributes.map(
    (attribute: any) => [attribute.key, attribute.value.stringValue ?? attribute.value.intValue ?? attribute.value.boolValue],
  )))
  assert.ok(attributes.every((attrs) => attrs["qoder.token_usage.available"] === true))
  assert.ok(attributes.every((attrs) => attrs["qoder.token_usage.estimated"] === false))
  assert.ok(attributes.every((attrs) => attrs["qoder.token_usage.source"] === "local_sqlite"))
  assert.deepEqual(attributes.map((attrs) => Number(attrs["gen_ai.usage.input_tokens"])), [120, 150])
  assert.deepEqual(attributes.map((attrs) => Number(attrs["gen_ai.usage.output_tokens"])), [10, 20])
  assert.deepEqual(attributes.map((attrs) => Number(attrs["qoder.cache_read_input_tokens"])), [40, 80])
  assert.notEqual(llmSpans[0].spanId, llmSpans[1].spanId)

  const events = normalizeOtlpTraces(payload, { receivedAt: "2026-07-21T12:00:05.000Z", authenticatedUser: "alice" })
  const record = aggregateOtelTraceEvents(SESSION_ID, events)
  assert.ok(record)
  assert.equal(record.tokens, 300)
  assert.equal(record.input_tokens, 270)
  assert.equal(record.output_tokens, 30)
  assert.equal(record.token_usage_estimated, false)
})

test("Qoder local SQLite reader extracts only exact usage for the requested session", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-token-db-"))
  const databasePath = path.join(root, "local.db")
  try {
    const sqlite: any = await import("node:sqlite")
    const database = new sqlite.DatabaseSync(databasePath)
    database.exec(`
      CREATE TABLE chat_message (
        id TEXT, session_id TEXT, request_id TEXT, role TEXT,
        token_info TEXT, model_info TEXT, gmt_create INTEGER
      )
    `)
    const insert = database.prepare("INSERT INTO chat_message VALUES (?, ?, ?, ?, ?, ?, ?)")
    insert.run("message-1", SESSION_ID, "request-1", "assistant", JSON.stringify({
      prompt_tokens: 321,
      completion_tokens: 45,
      cached_tokens: 123,
      max_input_tokens: 180000,
    }), JSON.stringify({ model_key: "qwen-test" }), Date.parse("2026-07-21T12:00:01.000Z"))
    insert.run("message-2", "another-session", "request-2", "assistant", JSON.stringify({
      prompt_tokens: 999,
      completion_tokens: 999,
    }), JSON.stringify({ model_key: "other" }), Date.parse("2026-07-21T12:00:02.000Z"))
    database.close()

    const usage = await readQoderLocalTokenUsage("desktop", SESSION_ID, { databasePath, sqliteModule: sqlite })
    assert.deepEqual(usage, [{
      messageId: "message-1",
      sessionId: SESSION_ID,
      requestId: "request-1",
      timestampMs: Date.parse("2026-07-21T12:00:01.000Z"),
      model: "qwen-test",
      inputTokens: 321,
      outputTokens: 45,
      reasoningTokens: 0,
      cacheReadTokens: 123,
      cacheWriteTokens: 0,
    }])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("AC35 exact Qoder token usage stays below five percent error across all four products", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-ac35-token-db-"))
  const databasePath = path.join(root, "local.db")
  try {
    const sqlite: any = await import("node:sqlite")
    const database = new sqlite.DatabaseSync(databasePath)
    database.exec(`
      CREATE TABLE chat_message (
        id TEXT, session_id TEXT, request_id TEXT, role TEXT,
        token_info TEXT, model_info TEXT, gmt_create INTEGER
      )
    `)
    const insert = database.prepare("INSERT INTO chat_message VALUES (?, ?, ?, ?, ?, ?, ?)")
    insert.run("ac35-message-1", SESSION_ID, "ac35-request-1", "assistant", JSON.stringify({
      prompt_tokens: 28_070,
      completion_tokens: 17,
      cached_tokens: 25_600,
      max_input_tokens: 180_000,
    }), JSON.stringify({ model_key: "qwen3.7-plus" }), Date.parse("2026-07-21T12:00:01.000Z"))
    insert.run("ac35-message-2", SESSION_ID, "ac35-request-2", "assistant", JSON.stringify({
      prompt_tokens: 25_701,
      completion_tokens: 58,
      cached_tokens: 17_408,
      max_input_tokens: 180_000,
    }), JSON.stringify({ model_key: "qwen3.7-plus" }), Date.parse("2026-07-21T12:00:04.000Z"))
    database.close()

    const expectedLocal = {
      input: 53_771,
      output: 75,
      total: 53_846,
      cached: 43_008,
    }
    const expectedDiagnostics = { input: 50, output: 15, total: 65 }
    const results: Array<{
      product: string
      source: string
      expected: typeof expectedDiagnostics
      record: Record<string, any>
      llmAttributes: Array<Record<string, any>>
    }> = []

    for (const product of ["desktop", "jetbrains"]) {
      const capture = sampleCapture()
      capture.diagnosticRecords = []
      const localTokenUsage = await readQoderLocalTokenUsage(product, SESSION_ID, {
        databasePath,
        sqliteModule: sqlite,
      })
      const payload = buildQoderOtlpPayload({ ...capture, product, localTokenUsage, estimateVisibleTokens: true })
      const llmSpans = payload.resourceSpans[0].scopeSpans[0].spans.filter(
        (span: any) => span.name.startsWith("qoder.llm."),
      )
      const events = normalizeOtlpTraces(payload, {
        receivedAt: "2026-07-21T12:00:05.000Z",
        authenticatedUser: "ac35",
      })
      const record = aggregateOtelTraceEvents(SESSION_ID, events)
      assert.ok(record)
      results.push({
        product,
        source: "local_sqlite",
        expected: expectedLocal,
        record,
        llmAttributes: llmSpans.map((span: any) => Object.fromEntries(span.attributes.map(
          (attribute: any) => [attribute.key, attribute.value.stringValue ?? attribute.value.intValue ?? attribute.value.boolValue],
        ))),
      })
    }

    for (const product of ["cli", "work"]) {
      const payload = buildQoderOtlpPayload({ ...sampleCapture(), product })
      const llmSpans = payload.resourceSpans[0].scopeSpans[0].spans.filter(
        (span: any) => span.name.startsWith("qoder.llm."),
      )
      const events = normalizeOtlpTraces(payload, {
        receivedAt: "2026-07-21T12:00:05.000Z",
        authenticatedUser: "ac35",
      })
      const record = aggregateOtelTraceEvents(SESSION_ID, events)
      assert.ok(record)
      results.push({
        product,
        source: "diagnostics",
        expected: expectedDiagnostics,
        record,
        llmAttributes: llmSpans.map((span: any) => Object.fromEntries(span.attributes.map(
          (attribute: any) => [attribute.key, attribute.value.stringValue ?? attribute.value.intValue ?? attribute.value.boolValue],
        ))),
      })
    }

    const relativeError = (actual: number, expected: number) => Math.abs(actual - expected) / expected
    for (const result of results) {
      assert.ok(relativeError(Number(result.record.input_tokens), result.expected.input) < 0.05, result.product)
      assert.ok(relativeError(Number(result.record.output_tokens), result.expected.output) < 0.05, result.product)
      assert.ok(relativeError(Number(result.record.tokens), result.expected.total) < 0.05, result.product)
      assert.equal(result.record.token_usage_estimated, false)
      assert.ok(result.llmAttributes.every((attrs) => attrs["qoder.token_usage.available"] === true))
      assert.ok(result.llmAttributes.every((attrs) => attrs["qoder.token_usage.estimated"] === false))
      assert.ok(result.llmAttributes.every((attrs) => attrs["qoder.token_usage.source"] === result.source))
    }

    const localAttributes = results.find((result) => result.product === "desktop")!.llmAttributes
    assert.equal(localAttributes.reduce((total, attrs) => total + Number(attrs["qoder.cache_read_input_tokens"]), 0), expectedLocal.cached)
    assert.notEqual(expectedLocal.total, expectedLocal.input + expectedLocal.output + expectedLocal.cached)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("Qoder CN Desktop normalizes conversation-history rows and joins exact SQLite usage", () => {
  const localTokenUsage = [
    {
      messageId: "cn-db-message-1",
      requestId: "cn-request-1",
      timestampMs: Date.parse("2026-07-26T05:00:02.000Z"),
      model: "auto",
      inputTokens: 27_969,
      outputTokens: 79,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    {
      messageId: "cn-db-message-2",
      requestId: "cn-request-2",
      timestampMs: Date.parse("2026-07-26T05:00:04.000Z"),
      model: "auto",
      inputTokens: 28_235,
      outputTokens: 34,
      reasoningTokens: 0,
      cacheReadTokens: 27_963,
      cacheWriteTokens: 0,
    },
  ]
  const transcriptRecords = normalizeQoderTranscriptRecords([
    {
      role: "user",
      message: { content: [{ type: "text", text: "读取 package.json，返回 name 和 version" }] },
    },
    {
      role: "assistant",
      message: { content: [{ type: "text", text: "name: agent-insight; version: 0.5.4" }] },
    },
  ], SESSION_ID, localTokenUsage)
  const payload = buildQoderOtlpPayload({
    product: "desktop",
    hookEvents: [
      hook("2026-07-26T05:00:00.000Z", {
        hook_event_name: "UserPromptSubmit",
        prompt: "读取 package.json，返回 name 和 version",
        transcript_path: `C:\\Users\\tester\\.qoder-cn\\cache\\projects\\repo\\conversation-history\\2603d13c\\2603d13c.jsonl`,
      }),
      hook("2026-07-26T05:00:05.000Z", {
        hook_event_name: "Stop",
        last_assistant_message: "name: agent-insight; version: 0.5.4",
      }),
    ],
    transcriptRecords,
    localTokenUsage,
  })
  const resourceAttrs = Object.fromEntries(payload.resourceSpans[0].resource.attributes.map(
    (attribute: any) => [attribute.key, attribute.value.stringValue],
  ))
  const llmSpans = payload.resourceSpans[0].scopeSpans[0].spans
    .filter((span: any) => span.name.startsWith("qoder.llm."))
  const usage = llmSpans.map((span: any) => Object.fromEntries(span.attributes.map(
    (attribute: any) => [attribute.key, attribute.value.stringValue ?? attribute.value.intValue ?? attribute.value.boolValue],
  )))

  assert.equal(resourceAttrs["service.name"], "qoder-cn-desktop")
  assert.equal(resourceAttrs["qoder.distribution"], "cn")
  assert.equal(llmSpans.length, 2)
  assert.deepEqual(usage.map((item) => Number(item["gen_ai.usage.input_tokens"])), [27_969, 28_235])
  assert.deepEqual(usage.map((item) => Number(item["gen_ai.usage.output_tokens"])), [79, 34])
  assert.ok(usage.every((item) => item["qoder.token_usage.source"] === "local_sqlite"))

  const events = normalizeOtlpTraces(payload, {
    receivedAt: "2026-07-26T05:00:06.000Z",
    authenticatedUser: "alice",
  })
  const record = aggregateOtelTraceEvents(SESSION_ID, events)
  assert.equal(record?.agentName, "Qoder CN Desktop")
  assert.equal(record?.tokens, 56_317)
  assert.equal(record?.final_result, "name: agent-insight; version: 0.5.4")
})

test("Qoder local SQLite paths distinguish Desktop and JetBrains", () => {
  const homeDir = path.join("C:", "Users", "tester")
  const appDataDir = path.join(homeDir, "AppData", "Roaming")
  assert.equal(
    resolveQoderLocalTokenDatabase("desktop", { homeDir, appDataDir, platform: "win32" }),
    path.join(appDataDir, "QoderCN", "SharedClientCache", "cache", "db", "local.db"),
  )
  assert.equal(
    resolveQoderLocalTokenDatabase("jetbrains", { homeDir, appDataDir, platform: "win32" }),
    path.join(homeDir, ".qoder", "shared_client", "cache", "db", "local.db"),
  )
  assert.equal(resolveQoderLocalTokenDatabase("cli", { homeDir, appDataDir, platform: "win32" }), undefined)
})

test("Qoder visible token estimator is deterministic for Chinese, source, and tool payloads", () => {
  const sample = [
    { type: "text", text: "读取 package.json 并返回 name 和 version" },
    { type: "tool_use", name: "Read", input: { file_path: "package.json" } },
  ]
  const first = estimateQoderVisibleTokens(sample)
  const second = estimateQoderVisibleTokens(structuredClone(sample))

  assert.equal(first, second)
  assert.ok(first >= 15)
})

test("Qoder OTLP adapter replaces an older session snapshot with the latest completed snapshot", () => {
  const older = sampleCapture()
  const newer = structuredClone(older)
  const newerStop = newer.hookEvents.find((entry) => entry.event.hook_event_name === "Stop")!
  newerStop.capturedAt = "2026-07-21T12:01:00.000Z"
  newerStop.event.last_assistant_message = "第二次完成"
  newerStop.event.parent_request_set_id = "request-set-2"

  const events = [
    ...normalizeOtlpTraces(buildQoderOtlpPayload(older), {
      receivedAt: "2026-07-21T12:00:05.000Z",
      authenticatedUser: "alice",
    }),
    ...normalizeOtlpTraces(buildQoderOtlpPayload(newer), {
      receivedAt: "2026-07-21T12:01:01.000Z",
      authenticatedUser: "alice",
    }),
  ]
  const record = aggregateOtelTraceEvents(SESSION_ID, events)

  assert.ok(record)
  assert.equal(record.final_result, "第二次完成")
  assert.equal(record.latency, 60)
  assert.equal(record.force_query_update, true)
  assert.equal(record.allow_snapshot_shrink, true)
})

test("Qoder Task and Subagent hooks restore multi-level parent-child relationships", () => {
  const capture = {
    hookEvents: [
      hook("2026-07-21T12:00:00.000Z", {
        hook_event_name: "UserPromptSubmit",
        prompt: "让 reviewer 检查代码",
      }),
      hook("2026-07-21T12:00:01.000Z", {
        hook_event_name: "PreToolUse",
        tool_use_id: "task-1",
        tool_name: "Agent",
        tool_input: { subagent_type: "Reviewer", description: "检查代码" },
      }),
      hook("2026-07-21T12:00:01.100Z", {
        hook_event_name: "PostToolUse",
        tool_use_id: "task-1",
        tool_name: "Agent",
        tool_input: { subagent_type: "Reviewer", description: "检查代码" },
        tool_response: { agentId: "subagent-1", agentType: "reviewer", state: "completed" },
      }),
      hook("2026-07-21T12:00:01.200Z", {
        hook_event_name: "SubagentStart",
        agent_id: "subagent-1",
        agent_type: "reviewer",
        description: "检查代码",
      }),
      hook("2026-07-21T12:00:01.300Z", {
        hook_event_name: "PreToolUse",
        tool_use_id: "task-2",
        tool_name: "Agent",
        agent_id: "subagent-1",
        agent_type: "reviewer",
        tool_input: { subagent_type: "Worker", description: "运行检查" },
      }),
      hook("2026-07-21T12:00:01.400Z", {
        hook_event_name: "PostToolUse",
        tool_use_id: "task-2",
        tool_name: "Agent",
        agent_id: "subagent-1",
        agent_type: "reviewer",
        tool_input: { subagent_type: "Worker", description: "运行检查" },
        tool_response: { agentId: "subagent-2", agentType: "worker", state: "completed" },
      }),
      hook("2026-07-21T12:00:01.500Z", {
        hook_event_name: "SubagentStart",
        agent_id: "subagent-2",
        parent_agent_id: "subagent-1",
        agent_type: "worker",
        description: "运行检查",
      }),
      hook("2026-07-21T12:00:01.800Z", {
        hook_event_name: "SubagentStop",
        agent_id: "subagent-2",
        parent_agent_id: "subagent-1",
        agent_type: "worker",
        result: "检查通过",
        status: "completed",
      }),
      hook("2026-07-21T12:00:02.000Z", {
        hook_event_name: "SubagentStop",
        agent_id: "subagent-1",
        agent_type: "reviewer",
        result: "没有发现问题",
        status: "completed",
        model: "qwen3-coder",
        provider: "qoder",
        token_usage: { input_tokens: 7, output_tokens: 3 },
      }),
      hook("2026-07-21T12:00:03.000Z", {
        hook_event_name: "Stop",
        last_assistant_message: "检查结束",
      }),
    ],
    transcriptRecords: [
      {
        type: "user",
        timestamp: "2026-07-21T12:00:00.000Z",
        sessionId: SESSION_ID,
        message: { role: "user", content: "让 reviewer 检查代码" },
        origin: { kind: "human" },
      },
      {
        type: "assistant",
        uuid: "assistant-task",
        timestamp: "2026-07-21T12:00:01.000Z",
        sessionId: SESSION_ID,
        message: {
          id: "assistant-task",
          role: "assistant",
          model: "auto",
          content: [{
            type: "tool_use",
            id: "task-1",
            name: "Agent",
            input: { subagent_type: "Reviewer", description: "检查代码" },
          }],
        },
      },
      {
        type: "user",
        timestamp: "2026-07-21T12:00:01.100Z",
        sessionId: SESSION_ID,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "task-1", content: "session_id: subagent-1" }],
        },
      },
      {
        type: "assistant",
        uuid: "assistant-final",
        timestamp: "2026-07-21T12:00:03.000Z",
        sessionId: SESSION_ID,
        message: {
          id: "assistant-final",
          role: "assistant",
          model: "auto",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "检查结束" }],
        },
      },
    ],
    diagnosticRecords: [],
  }
  const payload = buildQoderOtlpPayload(capture)
  const rawSpans = payload.resourceSpans[0].scopeSpans[0].spans as Array<{ name: string }>
  assert.ok(rawSpans.some((span) => span.name === "qoder.subagent.reviewer"), rawSpans.map((span) => span.name).join(", "))
  assert.ok(rawSpans.some((span) => span.name === "qoder.subagent.worker"), rawSpans.map((span) => span.name).join(", "))
  const events = normalizeOtlpTraces(payload, {
    receivedAt: "2026-07-21T12:00:04.000Z",
    authenticatedUser: "alice",
  })
  assert.ok(events.some((event) => event.attributes?.["qoder.span.type"] === "subagent"), JSON.stringify(events, null, 2))
  const record = aggregateOtelTraceEvents(SESSION_ID, events)

  assert.ok(record)
  const tree = buildAgentCallTree(record.interactions as never[])
  assert.ok(tree)
  assert.equal(tree.children.length, 1, JSON.stringify(record.interactions, null, 2))
  assert.equal(tree.children[0].agentName, "reviewer")
  assert.equal(tree.children[0].sessionId, "subagent-1")
  assert.equal(tree.children[0].parentId, tree.id)
  assert.equal(tree.children[0].stats.totalTokens, 10)
  assert.equal(tree.children[0].children.length, 1)
  assert.equal(tree.children[0].children[0].agentName, "worker")
  assert.equal(tree.children[0].children[0].sessionId, "subagent-2")
  assert.equal(tree.children[0].children[0].parentId, tree.children[0].id)
})

test("Qoder CN CLI Agent tool results create child Agent spans from camelCase metadata", () => {
  const toolUseId = "call-cli-subagent"
  const agentId = "aExplore-123"
  const capture = {
    product: "cli",
    hookEvents: [
      hook("2026-07-21T12:00:00.000Z", {
        hook_event_name: "UserPromptSubmit",
        prompt: "Launch one Explore agent",
      }),
      hook("2026-07-21T12:00:01.000Z", {
        hook_event_name: "PreToolUse",
        tool_use_id: toolUseId,
        tool_name: "Agent",
        tool_input: { subagent_type: "Explore", description: "Read package.json" },
      }),
      hook("2026-07-21T12:00:03.000Z", {
        hook_event_name: "PostToolUse",
        tool_use_id: toolUseId,
        tool_name: "Agent",
        tool_input: { subagent_type: "Explore", description: "Read package.json" },
      }),
      hook("2026-07-21T12:00:04.000Z", {
        hook_event_name: "Stop",
        last_assistant_message: "Done",
      }),
    ],
    transcriptRecords: [
      {
        type: "user",
        timestamp: "2026-07-21T12:00:00.000Z",
        sessionId: SESSION_ID,
        message: { role: "user", content: "Launch one Explore agent" },
        origin: { kind: "human" },
      },
      {
        type: "assistant",
        uuid: "assistant-cli-agent",
        timestamp: "2026-07-21T12:00:01.000Z",
        sessionId: SESSION_ID,
        message: {
          role: "assistant",
          model: "auto",
          content: [{
            type: "tool_use",
            id: toolUseId,
            name: "Agent",
            input: { subagent_type: "Explore", description: "Read package.json" },
          }],
        },
      },
      {
        type: "user",
        timestamp: "2026-07-21T12:00:03.000Z",
        sessionId: SESSION_ID,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolUseId, content: "agent complete" }],
        },
        toolUseResult: {
          kind: "agent-result",
          agentId,
          agentType: "Explore",
          content: "agent result",
          state: "completed",
          transcriptPath: `C:\\qoder\\subagents\\agent-${agentId}.jsonl`,
        },
      },
      {
        type: "assistant",
        uuid: "assistant-cli-final",
        timestamp: "2026-07-21T12:00:04.000Z",
        sessionId: SESSION_ID,
        message: { role: "assistant", model: "auto", content: [{ type: "text", text: "Done" }] },
      },
    ],
    diagnosticRecords: [],
  }

  const payload = buildQoderOtlpPayload(capture)
  const spans = payload.resourceSpans[0].scopeSpans[0].spans as Array<any>
  const subagent = spans.find((span) => span.name === "qoder.subagent.Explore")
  assert.ok(subagent, spans.map((span) => span.name).join(", "))
  const attrs = Object.fromEntries(subagent.attributes.map((attribute: any) => [
    attribute.key,
    attribute.value.stringValue ?? attribute.value.boolValue ?? attribute.value.intValue,
  ]))
  assert.equal(attrs["qoder.subagent.session_id"], agentId)
  assert.equal(attrs["qoder.subagent.status"], "completed")
  assert.equal(attrs["output.value"], "agent result")
  assert.match(attrs["qoder.subagent.transcript_path"], new RegExp(agentId))

  const events = normalizeOtlpTraces(payload, {
    receivedAt: "2026-07-21T12:00:05.000Z",
    authenticatedUser: "alice",
  })
  const record = aggregateOtelTraceEvents(SESSION_ID, events)
  assert.ok(record)
  const tree = buildAgentCallTree(record.interactions as never[])
  assert.ok(tree)
  assert.equal(tree.children.length, 1, JSON.stringify(record.interactions, null, 2))
  assert.equal(tree.children[0].sessionId, agentId)
  assert.equal(tree.children[0].agentName, "Explore")
})

test("Qoder framework and OTLP registries expose plugin onboarding and snapshot replacement", () => {
  const framework = getAdapter("qoder-cli")
  assert.equal(framework.descriptor.id, "qoder")
  assert.equal(framework.descriptor.onboard, "plugin")
  assert.equal(framework.sessionMergeStrategy, "snapshot-replace")
  assert.equal(framework.capabilities?.skills, true)
  assert.equal(framework.capabilities?.subagentTree, true)
  assert.deepEqual(listOtelTraceAdapters().map((adapter) => adapter.id), ["langfuse-langgraph", "hermes", "openclaw", "qoder", "generic"])
})

test("Qoder setup merges idempotently and removes only Agent Insight hooks", () => {
  const original = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "custom-check", name: "custom-hook" }] }],
    },
    permissions: { allow: ["Bash(git status)"] },
  }
  const first = mergeQoderHooks(original, { nodePath: "node", collectorPath: "collector.mjs" })
  const second = mergeQoderHooks(first, { nodePath: "node", collectorPath: "collector.mjs" })
  for (const eventName of QODER_HOOK_EVENTS) {
    const handlers = second.hooks[eventName].flatMap((group: { hooks?: Array<{ name?: string; command?: string; args?: string[] }> }) => group.hooks || [])
    assert.equal(handlers.filter((handler: { name?: string }) => handler.name === "agent-insight-qoder").length, 1)
    const handler = handlers.find((item: { name?: string }) => item.name === "agent-insight-qoder")
    assert.match(handler?.command || "", /node.*collector\.mjs/)
    assert.equal(handler?.args, undefined)
  }
  assert.equal(second.hooks.StopFailure, undefined)
  assert.equal(second.hooks.TaskCreated, undefined)
  assert.equal(second.hooks.TaskCompleted, undefined)
  assert.equal(second.hooks.UserPromptSubmit[0].hooks[0].name, "custom-hook")
  assert.deepEqual(second.permissions, original.permissions)

  const removed = removeQoderHooks(second)
  assert.equal(removed.hooks.UserPromptSubmit.length, 1)
  assert.equal(removed.hooks.UserPromptSubmit[0].hooks[0].name, "custom-hook")
  assert.equal(removed.hooks.PreToolUse, undefined)
  assert.deepEqual(removed.permissions, original.permissions)
})

test("Qoder CN Desktop hook command executes successfully through Windows cmd", {
  skip: process.platform !== "win32",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-cn-hook-"))
  try {
    assert.doesNotMatch(root, /\s/)
    const probe = path.join(root, "probe.mjs")
    fs.writeFileSync(probe, "process.stdin.resume()")
    const settings = mergeQoderHooks({}, {
      nodePath: process.execPath,
      collectorPath: probe,
    })
    const command = settings.hooks.UserPromptSubmit.at(-1).hooks[0].command
    assert.match(command, /^node(?:\.exe)? --no-warnings [^"]/i)
    const execution = spawnSync("cmd.exe", ["/c", command], {
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
      encoding: "utf8",
      timeout: 5_000,
    })
    assert.equal(execution.status, 0, execution.stderr)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("Qoder setup installs account-isolated files and supports scoped purge", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-setup-"))
  try {
    const qoderDir = path.join(root, ".qoder-cn")
    fs.mkdirSync(qoderDir, { recursive: true })
    fs.writeFileSync(path.join(qoderDir, "settings.json"), JSON.stringify({ permissions: { allow: ["Read"] } }))
    const insightDir = path.join(root, ".agent-insight")
    const installed = installQoderCollector({
      homeDir: root,
      insightDir,
      sourceDir: path.join(process.cwd(), "scripts"),
      host: "http://localhost:3000/",
      apiKey: "account-a",
      startUploader: false,
    })
    assert.ok(fs.existsSync(installed.collectorPath))
    assert.ok(fs.existsSync(installed.uploaderPath))
    assert.match(installed.spoolDir, new RegExp(`qoder[\\\\/]cli[\\\\/]${installed.accountHash}$`))
    assert.equal(installed.spoolDir, path.join(insightDir, "otel_data", "qoder", "cli", installed.accountHash))
    const settings = JSON.parse(fs.readFileSync(installed.settingsPath, "utf8"))
    assert.deepEqual(settings.permissions, { allow: ["Read"] })
    assert.equal(settings.hooks.Stop.at(-1).hooks[0].name, "agent-insight-qoder")
    const config = fs.readFileSync(path.join(insightDir, "config"), "utf8")
    assert.match(config, /^AGENT_INSIGHT_HOST=http:\/\/localhost:3000$/m)
    assert.match(config, /^AGENT_INSIGHT_API_KEY=account-a$/m)
    const installedFromConfig = installQoderCollector({
      homeDir: root,
      insightDir,
      sourceDir: path.join(process.cwd(), "scripts"),
      fromConfig: true,
      startUploader: false,
    })
    assert.equal(installedFromConfig.accountHash, installed.accountHash)
    assert.equal(installedFromConfig.spoolDir, installed.spoolDir)

    const legacySpoolRoot = path.join(insightDir, "otel_data", "qoder-cli")
    fs.mkdirSync(path.join(legacySpoolRoot, installed.accountHash), { recursive: true })
    const removed = uninstallQoderCollector({ homeDir: root, insightDir, purge: true })
    assert.equal(removed.purged, true)
    assert.equal(fs.existsSync(installed.spoolDir), false)
    assert.equal(fs.existsSync(legacySpoolRoot), false)
    assert.equal(fs.existsSync(installed.collectorPath), false)
    const uninstalledSettings = JSON.parse(fs.readFileSync(installed.settingsPath, "utf8"))
    assert.deepEqual(uninstalledSettings, { permissions: { allow: ["Read"] } })
    const uninstalledConfig = fs.readFileSync(path.join(insightDir, "config"), "utf8")
    assert.doesNotMatch(uninstalledConfig, /AGENT_INSIGHT_QODER/)
    assert.match(uninstalledConfig, /^AGENT_INSIGHT_HOST=http:\/\/localhost:3000$/m)
    assert.match(uninstalledConfig, /^AGENT_INSIGHT_API_KEY=account-a$/m)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("Qoder CN CLI and Work share the managed exact-token environment without clobbering the user value", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-token-env-"))
  let storedValue: string | undefined = "user-value"
  const adapter = {
    read: () => storedValue,
    set: (_name: string, value: string) => { storedValue = value },
    restore: (_name: string, value: string | undefined) => { storedValue = value },
  }
  try {
    const cli = ensureQoderTokenUsageEnvironment({
      homeDir: root,
      insightDir: path.join(root, ".agent-insight"),
      owner: "cli",
      adapter,
    })
    assert.equal(cli.name, QODERCN_TOKEN_USAGE_ENV)
    assert.equal(storedValue, "1")
    assert.deepEqual(cli.owners, ["cli"])

    const work = ensureQoderTokenUsageEnvironment({
      homeDir: root,
      insightDir: path.join(root, ".agent-insight"),
      owner: "work",
      adapter,
    })
    assert.deepEqual(work.owners, ["cli", "work"])

    const cliRemoved = releaseQoderTokenUsageEnvironment({
      homeDir: root,
      insightDir: path.join(root, ".agent-insight"),
      owner: "cli",
      adapter,
    })
    assert.deepEqual(cliRemoved.owners, ["work"])
    assert.equal(cliRemoved.restored, false)
    assert.equal(storedValue, "1")

    const workRemoved = releaseQoderTokenUsageEnvironment({
      homeDir: root,
      insightDir: path.join(root, ".agent-insight"),
      owner: "work",
      adapter,
    })
    assert.deepEqual(workRemoved.owners, [])
    assert.equal(workRemoved.restored, true)
    assert.equal(storedValue, "user-value")
    assert.equal(fs.existsSync(workRemoved.statePath), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("Qoder CN CLI and Work installers register shared exact-token environment owners", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-token-env-install-"))
  const insightDir = path.join(root, ".agent-insight")
  const sourceDir = path.join(process.cwd(), "scripts")
  const workHome = path.join(root, ".qoderworkcn")
  let storedValue: string | undefined
  const adapter = {
    read: () => storedValue,
    set: (_name: string, value: string) => { storedValue = value },
    restore: (_name: string, value: string | undefined) => { storedValue = value },
  }
  try {
    fs.mkdirSync(workHome, { recursive: true })
    fs.writeFileSync(path.join(workHome, "settings.json"), "{}")
    const cli = installQoderCollector({
      homeDir: root,
      insightDir,
      sourceDir,
      host: "http://localhost:3000",
      apiKey: "account-a",
      product: "cli",
      owner: "cli",
      startUploader: false,
      configureTokenUsageEnvironment: true,
      tokenUsageEnvironmentAdapter: adapter,
    })
    assert.deepEqual(cli.tokenUsageEnvironment?.owners, ["cli"])
    assert.equal(storedValue, "1")

    const work = installQoderWorkCollector({
      homeDir: root,
      insightDir,
      qoderWorkHome: workHome,
      sourceDir,
      startUploader: false,
      configureTokenUsageEnvironment: true,
      tokenUsageEnvironmentAdapter: adapter,
    })
    assert.deepEqual(work.tokenUsageEnvironment?.owners, ["cli", "work"])

    const cliRemoved = uninstallQoderCollector({
      homeDir: root,
      insightDir,
      product: "cli",
      owner: "cli",
      tokenUsageEnvironmentAdapter: adapter,
    })
    assert.deepEqual(cliRemoved.tokenUsageEnvironment?.owners, ["work"])
    assert.equal(storedValue, "1")

    const workRemoved = uninstallQoderWorkCollector({
      homeDir: root,
      insightDir,
      qoderWorkHome: workHome,
      tokenUsageEnvironmentAdapter: adapter,
    })
    assert.equal(workRemoved.tokenUsageEnvironment?.restored, true)
    assert.equal(storedValue, undefined)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("Qoder shared setup keeps CLI active when the Desktop owner is uninstalled", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-owner-setup-"))
  try {
    const insightDir = path.join(root, ".agent-insight")
    const sourceDir = path.join(process.cwd(), "scripts")
    const cli = installQoderCollector({
      homeDir: root,
      insightDir,
      sourceDir,
      host: "http://localhost:3000",
      apiKey: "account-a",
      product: "cli",
      owner: "cli",
      startUploader: false,
    })
    const desktop = installQoderCollector({
      homeDir: root,
      insightDir,
      sourceDir,
      host: "http://localhost:3000",
      apiKey: "account-a",
      product: "desktop",
      owner: "desktop",
      startUploader: false,
    })
    assert.match(cli.spoolDir, /qoder[\\/]cli/)
    assert.match(desktop.spoolDir, /qoder[\\/]desktop/)
    assert.equal(fs.existsSync(cli.markerPath), true)
    assert.equal(fs.existsSync(desktop.markerPath), true)

    const desktopRemoved = uninstallQoderCollector({
      homeDir: root,
      insightDir,
      product: "desktop",
      owner: "desktop",
      purge: true,
    })
    assert.deepEqual(desktopRemoved.remainingOwners, ["cli"])
    assert.equal(fs.existsSync(desktop.spoolDir), false)
    assert.equal(fs.existsSync(cli.collectorPath), true)
    const sharedSettings = JSON.parse(fs.readFileSync(cli.settingsPath, "utf8"))
    assert.equal(sharedSettings.hooks.Stop.at(-1).hooks[0].name, "agent-insight-qoder")
    assert.match(fs.readFileSync(path.join(insightDir, "config"), "utf8"), /AGENT_INSIGHT_QODER_UPLOADER=/)

    const cliRemoved = uninstallQoderCollector({
      homeDir: root,
      insightDir,
      product: "cli",
      owner: "cli",
      purge: true,
    })
    assert.deepEqual(cliRemoved.remainingOwners, [])
    assert.equal(fs.existsSync(cli.collectorPath), false)
    const cleanedSettings = JSON.parse(fs.readFileSync(cli.settingsPath, "utf8"))
    assert.equal(cleanedSettings.hooks, undefined)
    assert.doesNotMatch(fs.readFileSync(path.join(insightDir, "config"), "utf8"), /AGENT_INSIGHT_QODER/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("Qoder JetBrains uninstaller removes the empty product runtime root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-jetbrains-uninstall-"))
  try {
    const runtimeDir = path.join(root, ".agent-insight", "qoder-jetbrains", "runtime")
    fs.mkdirSync(runtimeDir, { recursive: true })
    execFileSync(process.execPath, [
      path.join(process.cwd(), "integrations", "qoder-jetbrains", "src", "main", "resources", "collector", "qoder_jetbrains_uninstall.mjs"),
      runtimeDir,
    ])
    assert.equal(fs.existsSync(path.dirname(runtimeDir)), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("Qoder Work setup preserves unrelated hooks and isolates install and uninstall from Qoder CLI", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-work-setup-"))
  try {
    const insightDir = path.join(root, ".agent-insight")
    const workHome = path.join(root, ".qoderworkcn")
    const cliSettings = path.join(root, ".qoder-cn", "settings.json")
    fs.mkdirSync(insightDir, { recursive: true })
    fs.mkdirSync(workHome, { recursive: true })
    fs.mkdirSync(path.dirname(cliSettings), { recursive: true })
    fs.writeFileSync(path.join(insightDir, "config"), "AGENT_INSIGHT_HOST=http://localhost:3000\nAGENT_INSIGHT_API_KEY=account-a\n")
    fs.writeFileSync(cliSettings, JSON.stringify({ cliOnly: true }))
    const original = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "custom-work-hook" }] }] }, workOnly: true }
    fs.writeFileSync(path.join(workHome, "settings.json"), JSON.stringify(original))

    const merged = mergeQoderWorkHooks(original, { collectorPath: path.join(insightDir, "qoder-work", "qoder_trace_collector.mjs") })
    assert.equal(merged.hooks.UserPromptSubmit[0].hooks[0].command, "custom-work-hook")
    for (const eventName of QODER_WORK_HOOK_EVENTS) {
      const handlers = merged.hooks[eventName].flatMap((group: { hooks?: Array<{ command?: string; async?: boolean }> }) => group.hooks || [])
      assert.equal(handlers.length >= 1, true)
      const collectorHandler = handlers.find((handler: { command?: string }) => String(handler.command).includes("qoder_trace_collector.mjs"))
      assert.equal(collectorHandler?.async, true, `${eventName} must not block Qoder Work startup or first-token response`)
    }
    assert.deepEqual(removeQoderWorkHooks(merged), original)

    const installed = installQoderWorkCollector({
      homeDir: root,
      insightDir,
      qoderWorkHome: workHome,
      sourceDir: path.join(process.cwd(), "scripts"),
      startUploader: false,
    })
    assert.match(installed.spoolDir, new RegExp(`qoder[\\\\/]work[\\\\/]${installed.accountHash}$`))
    assert.equal(installed.spoolDir, path.join(insightDir, "otel_data", "qoder", "work", installed.accountHash))
    assert.equal(fs.existsSync(installed.collectorPath), true)
    assert.equal(fs.existsSync(installed.uploaderPath), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(cliSettings, "utf8")), { cliOnly: true })

    const legacySpoolRoot = path.join(insightDir, "otel_data", "qoder-work")
    fs.mkdirSync(path.join(legacySpoolRoot, installed.accountHash), { recursive: true })
    const removed = uninstallQoderWorkCollector({
      homeDir: root,
      insightDir,
      qoderWorkHome: workHome,
      purge: true,
    })
    assert.equal(removed.purged, true)
    assert.equal(fs.existsSync(installed.spoolDir), false)
    assert.equal(fs.existsSync(legacySpoolRoot), false)
    assert.equal(fs.existsSync(installed.collectorPath), false)
    assert.deepEqual(JSON.parse(fs.readFileSync(cliSettings, "utf8")), { cliOnly: true })
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workHome, "settings.json"), "utf8")), original)
    assert.match(fs.readFileSync(path.join(insightDir, "config"), "utf8"), /AGENT_INSIGHT_API_KEY=account-a/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("AC30 uninstall stops CLI, Desktop, JetBrains, and Work uploader processes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-four-product-stop-"))
  const insightDir = path.join(root, ".agent-insight")
  const sourceDir = path.join(process.cwd(), "scripts")
  const workHome = path.join(root, ".qoderworkcn")
  const startedPids: number[] = []
  let oneShotPid: number | undefined
  try {
    fs.mkdirSync(insightDir, { recursive: true })
    fs.mkdirSync(workHome, { recursive: true })
    fs.writeFileSync(path.join(insightDir, "config"), "AGENT_INSIGHT_HOST=http://127.0.0.1:9\nAGENT_INSIGHT_API_KEY=account-a\n")
    fs.writeFileSync(path.join(workHome, "settings.json"), "{}")

    const cli = installQoderCollector({ homeDir: root, insightDir, sourceDir, host: "http://127.0.0.1:9", apiKey: "account-a", product: "cli", owner: "cli" })
    const desktop = installQoderCollector({ homeDir: root, insightDir, sourceDir, host: "http://127.0.0.1:9", apiKey: "account-a", product: "desktop", owner: "desktop" })
    const jetbrains = installQoderCollector({ homeDir: root, insightDir, sourceDir, host: "http://127.0.0.1:9", apiKey: "account-a", product: "jetbrains", owner: "jetbrains" })
    const work = installQoderWorkCollector({ homeDir: root, insightDir, qoderWorkHome: workHome, sourceDir })
    const products = [cli, desktop, jetbrains, work]
    for (const installed of products) {
      assert.ok(installed.uploaderPid)
      startedPids.push(Number(installed.uploaderPid))
      await waitForCondition(() => fs.existsSync(path.join(installed.spoolDir, "uploader.lock")))
      assert.equal(testProcessIsAlive(installed.uploaderPid), true)
    }

    const oneShot = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true })
    oneShotPid = oneShot.pid
    assert.ok(oneShotPid)
    fs.writeFileSync(path.join(desktop.spoolDir, "upload-run.lock"), JSON.stringify({ pid: oneShotPid }))

    const desktopRemoved = uninstallQoderCollector({ homeDir: root, insightDir, product: "desktop", owner: "desktop", purge: true })
    assert.ok(desktopRemoved.stoppedUploaderPids.includes(Number(desktop.uploaderPid)))
    assert.ok(desktopRemoved.stoppedUploaderPids.includes(Number(oneShotPid)))
    assert.equal(testProcessIsAlive(desktop.uploaderPid), false)
    assert.equal(testProcessIsAlive(oneShotPid), false)
    assert.equal(testProcessIsAlive(cli.uploaderPid), true)
    assert.equal(testProcessIsAlive(jetbrains.uploaderPid), true)
    assert.equal(testProcessIsAlive(work.uploaderPid), true)

    const jetbrainsRemoved = uninstallQoderCollector({ homeDir: root, insightDir, product: "jetbrains", owner: "jetbrains", purge: true })
    assert.ok(jetbrainsRemoved.stoppedUploaderPids.includes(Number(jetbrains.uploaderPid)))
    assert.equal(testProcessIsAlive(jetbrains.uploaderPid), false)
    assert.equal(testProcessIsAlive(cli.uploaderPid), true)
    assert.equal(testProcessIsAlive(work.uploaderPid), true)

    const cliRemoved = uninstallQoderCollector({ homeDir: root, insightDir, product: "cli", owner: "cli", purge: true })
    assert.ok(cliRemoved.stoppedUploaderPids.includes(Number(cli.uploaderPid)))
    assert.equal(testProcessIsAlive(cli.uploaderPid), false)
    assert.equal(testProcessIsAlive(work.uploaderPid), true)

    const workRemoved = uninstallQoderWorkCollector({ homeDir: root, insightDir, qoderWorkHome: workHome, purge: true })
    assert.ok(workRemoved.stoppedUploaderPids.includes(Number(work.uploaderPid)))
    assert.equal(testProcessIsAlive(work.uploaderPid), false)
  } finally {
    for (const pid of [...startedPids, Number(oneShotPid)].filter((value) => Number.isInteger(value) && value > 0)) {
      if (testProcessIsAlive(pid)) try { process.kill(pid, "SIGKILL") } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test("AC31 and AC32 uninstall clean only Qoder state and all four products reinstall normally", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-four-product-reinstall-"))
  const insightDir = path.join(root, ".agent-insight")
  const sourceDir = path.join(process.cwd(), "scripts")
  const qoderHome = path.join(root, ".qoder-cn")
  const workHome = path.join(root, ".qoderworkcn")
  const configPath = path.join(insightDir, "config")
  const qoderSettingsPath = path.join(qoderHome, "settings.json")
  const workSettingsPath = path.join(workHome, "settings.json")
  const originalQoderSettings = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", name: "other-collector", command: "other-collector-hook" }] }] }, permissions: { allow: ["Read"] } }
  const originalWorkSettings = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-work-hook" }] }] }, workOnly: true }
  const unrelatedFiles = [
    path.join(insightDir, "opencode", "collector.keep"),
    path.join(insightDir, "claude", "collector.keep"),
    path.join(insightDir, "hermes", "collector.keep"),
  ]
  try {
    fs.mkdirSync(qoderHome, { recursive: true })
    fs.mkdirSync(workHome, { recursive: true })
    for (const file of unrelatedFiles) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, "keep")
    }
    fs.writeFileSync(configPath, [
      "AGENT_INSIGHT_HOST=http://localhost:3000",
      "AGENT_INSIGHT_API_KEY=account-a",
      "OPENCODE_CONFIG_DIR=C:/opencode",
      "CLAUDE_CODE_ENABLE_TELEMETRY=1",
      "HERMES_HOME=C:/hermes",
      "",
    ].join("\n"))
    fs.writeFileSync(qoderSettingsPath, JSON.stringify(originalQoderSettings))
    fs.writeFileSync(workSettingsPath, JSON.stringify(originalWorkSettings))

    const installAll = () => ({
      cli: installQoderCollector({ homeDir: root, insightDir, sourceDir, fromConfig: true, product: "cli", owner: "cli", startUploader: false }),
      desktop: installQoderCollector({ homeDir: root, insightDir, sourceDir, fromConfig: true, product: "desktop", owner: "desktop", startUploader: false }),
      jetbrains: installQoderCollector({ homeDir: root, insightDir, sourceDir, fromConfig: true, product: "jetbrains", owner: "jetbrains", startUploader: false }),
      work: installQoderWorkCollector({ homeDir: root, insightDir, qoderWorkHome: workHome, sourceDir, startUploader: false }),
    })
    const first = installAll()
    for (const [product, installed] of Object.entries(first)) {
      fs.writeFileSync(path.join(installed.spoolDir, `${product}.sentinel`), "remove")
      const legacyRoot = path.join(insightDir, "otel_data", `qoder-${product}`)
      fs.mkdirSync(path.join(legacyRoot, "legacy-account"), { recursive: true })
      fs.writeFileSync(path.join(legacyRoot, "legacy-account", "sentinel"), "remove")
    }

    uninstallQoderCollector({ homeDir: root, insightDir, product: "desktop", owner: "desktop", purge: true })
    uninstallQoderCollector({ homeDir: root, insightDir, product: "jetbrains", owner: "jetbrains", purge: true })
    uninstallQoderCollector({ homeDir: root, insightDir, product: "cli", owner: "cli", purge: true })
    uninstallQoderWorkCollector({ homeDir: root, insightDir, qoderWorkHome: workHome, purge: true })

    for (const product of ["cli", "desktop", "jetbrains", "work"]) {
      assert.equal(fs.existsSync(path.join(insightDir, "otel_data", "qoder", product)), false)
      assert.equal(fs.existsSync(path.join(insightDir, "otel_data", `qoder-${product}`)), false)
    }
    assert.equal(fs.existsSync(path.join(insightDir, "qoder_trace_collector.mjs")), false)
    assert.equal(fs.existsSync(path.join(insightDir, "qoder_uploader_client.mjs")), false)
    assert.equal(fs.existsSync(path.join(insightDir, "qoder-work")), false)
    assert.equal(fs.existsSync(path.join(insightDir, "qoder-owners")), false)
    assert.deepEqual(JSON.parse(fs.readFileSync(qoderSettingsPath, "utf8")), originalQoderSettings)
    assert.deepEqual(JSON.parse(fs.readFileSync(workSettingsPath, "utf8")), originalWorkSettings)
    const cleanedConfig = fs.readFileSync(configPath, "utf8")
    assert.doesNotMatch(cleanedConfig, /AGENT_INSIGHT_QODER_/)
    assert.match(cleanedConfig, /OPENCODE_CONFIG_DIR=C:\/opencode/)
    assert.match(cleanedConfig, /CLAUDE_CODE_ENABLE_TELEMETRY=1/)
    assert.match(cleanedConfig, /HERMES_HOME=C:\/hermes/)
    for (const file of unrelatedFiles) assert.equal(fs.readFileSync(file, "utf8"), "keep")

    const second = installAll()
    const reinstalled = Object.entries(second) as Array<[string, { spoolDir: string; collectorPath: string }]>
    for (const [product, installed] of reinstalled) {
      assert.equal(fs.existsSync(installed.collectorPath), true)
      const collected = await collectQoderHook({
        session_id: `reinstall-${product}`,
        hook_event_name: "SessionEnd",
        last_assistant_message: `${product} reinstall ok`,
        qoder_product: product,
      }, {
        homeDir: root,
        insightDir,
        spoolDir: installed.spoolDir,
        disableUploadKick: true,
      })
      assert.ok(collected.pendingFile && fs.existsSync(collected.pendingFile))
    }
    const reinstalledSettings = JSON.parse(fs.readFileSync(qoderSettingsPath, "utf8"))
    assert.equal(reinstalledSettings.hooks.Stop.at(-1).hooks[0].name, "agent-insight-qoder")
    const reinstalledWorkSettings = JSON.parse(fs.readFileSync(workSettingsPath, "utf8"))
    assert.ok(reinstalledWorkSettings.hooks.Stop.length > 0)

    uninstallQoderCollector({ homeDir: root, insightDir, product: "desktop", owner: "desktop", purge: true })
    uninstallQoderCollector({ homeDir: root, insightDir, product: "jetbrains", owner: "jetbrains", purge: true })
    uninstallQoderCollector({ homeDir: root, insightDir, product: "cli", owner: "cli", purge: true })
    uninstallQoderWorkCollector({ homeDir: root, insightDir, qoderWorkHome: workHome, purge: true })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
