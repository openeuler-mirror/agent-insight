/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const path = require("node:path");
const {
  DurableTraceUploader,
  DurableTraceWriter,
  safeContent,
  stableEventId,
  stableSpanId,
  stableTraceId,
} = require("../../shared/trace-transport.cjs");
const { classifyTool, parseMcpIdentity, usageFrom } = require("../../shared/pi-trace-helpers.cjs");
const { safeStableRead } = require("./gp-snapshot-parser.cjs");

function timestamp(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter(part => part?.type === "text" || part?.type === "thinking")
    .map(part => part.type === "thinking"
      ? `<thinking>\n${String(part.thinking || part.text || "")}\n</thinking>`
      : String(part.text || ""))
    .filter(Boolean)
    .join("\n");
}

function recordContextText(record) {
  if (record?.type === "custom_message") {
    const customType = record.customType || record.custom_type || "custom";
    const value = record.content ?? record.message?.content ?? record.details;
    const content = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
    return content ? `[custom:${customType}]\n${content}` : `[custom:${customType}]`;
  }
  if (record?.type === "compaction" || record?.type === "branch_summary") {
    const value = record.summary ?? record.content ?? record.message;
    const content = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
    return content ? `[${record.type}]\n${content}` : "";
  }
  return "";
}

function toolCalls(message) {
  if (!Array.isArray(message?.content)) return [];
  return message.content.filter(part => ["toolCall", "tool_call", "tool-use", "tool_use"].includes(part?.type));
}

function detectedSkill(args) {
  let value = args;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  const target = value?.path || value?.file_path || value?.filePath;
  if (typeof target !== "string" || !/(?:^|[\\/])SKILL\.md$/i.test(target)) return null;
  return path.basename(path.dirname(target.replaceAll("\\", "/"))) || "unknown";
}

function unwrapMessage(record) {
  if (record?.type === "message" && record.message) {
    return { ...record.message, timestamp: record.message.timestamp || record.timestamp };
  }
  if (record?.message?.role) return { ...record.message, timestamp: record.message.timestamp || record.timestamp };
  return record?.role ? record : null;
}

async function parsePiSession(root, descriptor) {
  const sessionPath = path.isAbsolute(descriptor.sessionFile)
    ? descriptor.sessionFile
    : path.resolve(root, descriptor.sessionFile);
  const read = await safeStableRead(root, sessionPath, {
    allowedRoots: descriptor.allowedRoots || [],
    maxBytes: null,
  });
  const text = read.bytes.toString("utf8");
  const lines = text.split(/\r?\n/);
  if (!text.endsWith("\n")) lines.pop();
  const records = [];
  const diagnostics = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]) continue;
    if (Number.isInteger(descriptor.startLine) && index < descriptor.startLine) continue;
    if (Number.isInteger(descriptor.endLine) && index >= descriptor.endLine) continue;
    try { records.push({ line: index, record: JSON.parse(lines[index]) }); }
    catch { diagnostics.push({ code: "invalid_pi_jsonl_record", line: index + 1 }); }
  }
  const messages = records.map(item => unwrapMessage(item.record)).filter(Boolean);
  if (!messages.length) return { events: [], fidelity: "summary-only", diagnostics };
  const fallback = read.stat.mtimeMs;
  const times = messages.map(message => timestamp(message.timestamp, fallback));
  const startedAt = times.reduce((lowest, value) => Math.min(lowest, value), fallback);
  const endedAt = times.reduce((highest, value) => Math.max(highest, value), startedAt);
  const sessionId = `goal-plus:${descriptor.sourceId}:${descriptor.agentSessionId}`;
  const traceId = stableTraceId("pi-agent", sessionId);
  const agentSpanId = stableSpanId(sessionId, "agent");
  const firstUser = messages.find(message => message.role === "user");
  const input = descriptor.input || (firstUser ? messageText(firstUser) : "");
  const lastAssistant = messages.filter(message => message.role === "assistant").at(-1);
  const events = [];
  const pendingTools = new Map();
  let llmIndex = 0;
  let previousTime = startedAt;
  let hasFailedLlm = false;
  const pendingContext = descriptor.input ? [descriptor.input] : [];

  const commonAttributes = {
    "goal_plus.source_id": descriptor.sourceId,
    "goal_plus.goal_id": descriptor.goalId,
    "goal_plus.run_id": descriptor.runId,
    "goal_plus.candidate_id": descriptor.candidateId,
    "goal_plus.agent_session_id": descriptor.agentSessionId,
    "goal_plus.native_session_id": descriptor.nativeSessionId,
    "goal_plus.role": descriptor.role,
    "goal_plus.session_kind": descriptor.sessionKind || "worker",
    "goal_plus.import_mode": "passive_pi_session",
    "goal_plus.timing_fidelity": "derived",
  };

  for (const item of records) {
    const message = unwrapMessage(item.record);
    if (!message) {
      const context = recordContextText(item.record);
      if (context) pendingContext.push(context);
      continue;
    }
    const completedAt = timestamp(message.timestamp, previousTime);
    if (message.role === "user") {
      const userText = messageText(message);
      if (userText && userText !== descriptor.input) pendingContext.push(`[user]\n${userText}`);
      previousTime = completedAt;
      continue;
    }
    if (message.role === "assistant") {
      const spanId = stableSpanId(sessionId, "llm", llmIndex);
      const output = messageText(message);
      const usage = usageFrom(message);
      const stopReason = String(message.stopReason || message.stop_reason || "").toLowerCase();
      const failed = ["error", "aborted", "cancelled", "canceled", "blocked"].includes(stopReason);
      hasFailedLlm ||= failed;
      events.push({
        eventId: stableEventId(sessionId, spanId),
        sessionId,
        traceId,
        spanId,
        parentSpanId: agentSpanId,
        kind: "llm",
        name: `llm.${message.responseModel || message.model || "unknown"}`,
        startTimeMs: previousTime,
        endTimeMs: completedAt,
        status: failed ? "error" : "success",
        error: message.errorMessage || (failed ? `Pi turn ended with ${stopReason}` : undefined),
        input: pendingContext.length ? pendingContext.join("\n\n") : undefined,
        output,
        model: message.responseModel || message.model,
        provider: message.provider,
        usage,
        attributes: { ...commonAttributes, "pi.stop_reason": stopReason || undefined },
      });
      pendingContext.length = 0;
      for (const call of toolCalls(message)) {
        const callId = String(call.id || call.toolCallId || `tool-${llmIndex}-${pendingTools.size}`);
        pendingTools.set(callId, {
          toolCallId: callId,
          toolName: call.name || call.toolName || "unknown",
          args: call.arguments || call.args || call.input,
          startedAt: completedAt,
          parentSpanId: spanId,
        });
      }
      llmIndex += 1;
      previousTime = completedAt;
      continue;
    }
    if (!["toolResult", "tool_result", "tool"].includes(message.role)) continue;
    const callId = String(message.toolCallId || message.tool_call_id || message.id || `result-${events.length}`);
    const pending = pendingTools.get(callId) || {
      toolCallId: callId,
      toolName: message.toolName || message.name || "unknown",
      args: undefined,
      startedAt: completedAt,
      parentSpanId: agentSpanId,
    };
    pendingTools.delete(callId);
    const spanId = stableSpanId(sessionId, "tool", callId);
    const mcp = parseMcpIdentity(pending.toolName, pending.args, message);
    events.push({
      eventId: stableEventId(sessionId, spanId),
      sessionId,
      traceId,
      spanId,
      parentSpanId: pending.parentSpanId,
      kind: mcp ? "mcp" : "tool",
      name: `tool.${pending.toolName}`,
      startTimeMs: pending.startedAt,
      endTimeMs: completedAt,
      status: message.isError ? "error" : "success",
      error: message.isError ? safeContent(message.content) : undefined,
      tool: {
        name: pending.toolName,
        type: classifyTool(pending.toolName),
        arguments: pending.args,
        result: message.content,
      },
      mcp,
      attributes: commonAttributes,
    });
    const skillName = pending.toolName.toLowerCase() === "read" ? detectedSkill(pending.args) : null;
    if (skillName) {
      const skillSpanId = stableSpanId(sessionId, "skill", callId);
      events.push({
        eventId: stableEventId(sessionId, skillSpanId),
        sessionId,
        traceId,
        spanId: skillSpanId,
        parentSpanId: pending.parentSpanId,
        kind: "skill",
        name: `skill.${skillName}`,
        startTimeMs: pending.startedAt,
        endTimeMs: completedAt,
        status: message.isError ? "error" : "success",
        skill: { name: skillName, version: "unknown", triggerMode: "automatic" },
        attributes: commonAttributes,
      });
    }
    previousTime = completedAt;
  }
  for (const pending of pendingTools.values()) {
    const spanId = stableSpanId(sessionId, "tool", pending.toolCallId);
    events.push({
      eventId: stableEventId(sessionId, spanId),
      sessionId,
      traceId,
      spanId,
      parentSpanId: pending.parentSpanId,
      kind: "tool",
      name: `tool.${pending.toolName}`,
      startTimeMs: pending.startedAt,
      endTimeMs: pending.startedAt,
      status: "running",
      tool: { name: pending.toolName, type: classifyTool(pending.toolName), arguments: pending.args },
    });
  }
  const terminalState = String(descriptor.terminalState || "").toLowerCase();
  const exitCode = descriptor.exitCode == null ? undefined : Number(descriptor.exitCode);
  const terminalFailure = hasFailedLlm
    || ["error", "failed", "aborted", "cancelled", "canceled", "blocked", "invalidated"].includes(terminalState)
    || (Number.isFinite(exitCode) && exitCode !== 0);
  events.push({
    eventId: stableEventId(sessionId, agentSpanId),
    sessionId,
    traceId,
    spanId: agentSpanId,
    kind: "agent",
    name: "agent.pi",
    startTimeMs: startedAt,
    endTimeMs: endedAt,
    status: terminalFailure ? "error" : pendingTools.size ? "running" : "success",
    error: terminalFailure
      ? descriptor.errorMessage || `Goal Plus Pi session ended with ${terminalState || `exit code ${exitCode}`}`
      : undefined,
    input,
    output: messageText(lastAssistant),
    model: lastAssistant?.responseModel || lastAssistant?.model,
    attributes: {
      ...commonAttributes,
      "goal_plus.terminal_state": terminalState || undefined,
      "goal_plus.exit_code": Number.isFinite(exitCode) ? exitCode : undefined,
    },
  });
  return { events, fidelity: "derived", diagnostics };
}

async function importPiSessions(root, sessions, options) {
  const writer = options.writer || new DurableTraceWriter({
    framework: "pi-agent",
    apiKey: options.apiKey,
    homeDir: options.homeDir,
  });
  const uploader = options.uploader || new DurableTraceUploader({
    framework: "pi-agent",
    apiKey: options.apiKey,
    endpoint: options.endpoint,
    homeDir: options.homeDir,
  });
  const diagnostics = [];
  let imported = 0;
  for (const session of sessions) {
    try {
      const parsed = await parsePiSession(root, session);
      for (const event of parsed.events) await writer.append(event);
      for (const diagnostic of parsed.diagnostics || []) diagnostics.push({ agentSessionId: session.agentSessionId, ...diagnostic });
      imported += parsed.events.length ? 1 : 0;
    } catch (error) {
      diagnostics.push({ agentSessionId: session.agentSessionId, code: "pi_import_failed", message: error.message });
    }
  }
  await writer.flush();
  const upload = options.upload === false ? { uploadedEvents: 0 } : await uploader.flushOnce();
  return { imported, uploadedEvents: upload.uploadedEvents || 0, diagnostics };
}

module.exports = { detectedSkill, importPiSessions, messageText, parsePiSession, toolCalls, unwrapMessage };
