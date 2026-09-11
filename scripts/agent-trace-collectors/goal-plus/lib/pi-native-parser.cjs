/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  DurableTraceUploader,
  DurableTraceWriter,
  acquireProcessLock,
  atomicWriteJson,
  collectorStateDir,
  redactValue,
  releaseProcessLock,
  safeContent,
  sha256,
  stableEventId,
  stableSpanId,
  stableTraceId,
} = require("../../shared/trace-transport.cjs");
const { classifyTool, parseMcpIdentity, usageFrom } = require("../../shared/pi-trace-helpers.cjs");
const { safeStableRead } = require("./gp-snapshot-parser.cjs");

const IMPORT_CHECKPOINT_VERSION = 1;
const OUTCOME_DERIVATION_VERSION = 2;
const GOAL_PLUS_UPLOAD_MAX_BATCHES_PER_FLUSH = 10;
const FAILURE_TERMINAL_STATES = new Set([
  "error",
  "failed",
  "aborted",
  "cancelled",
  "canceled",
  "blocked",
  "invalidated",
  "timed_out",
]);

function stableJson(value) {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function descriptorFingerprint(descriptor) {
  return `sha256:${sha256(stableJson({
    sourceId: descriptor.sourceId,
    agentSessionId: descriptor.agentSessionId,
    nativeSessionId: descriptor.nativeSessionId,
    goalId: descriptor.goalId,
    runId: descriptor.runId,
    candidateId: descriptor.candidateId,
    role: descriptor.role,
    sessionKind: descriptor.sessionKind,
    host: descriptor.host,
    runnerFailed: descriptor.runnerFailed,
    timedOut: descriptor.timedOut,
    progressStatus: descriptor.progressStatus,
    controlledTermination: descriptor.controlledTermination,
    runtimeBudgetSeconds: descriptor.runtimeBudgetSeconds,
    terminalState: descriptor.terminalState,
    businessState: descriptor.businessState,
    exitCode: descriptor.exitCode,
    errorMessage: descriptor.errorMessage,
    input: descriptor.input,
    startLine: descriptor.startLine,
    endLine: descriptor.endLine,
  }))}`;
}

function eventFingerprint(event) {
  return `sha256:${sha256(stableJson(redactValue(event)))}`;
}

function runtimeOutcome(descriptor, lastAssistantFailed, hasPendingTools) {
  const terminalState = String(descriptor.terminalState || "").toLowerCase();
  const progressStatus = String(descriptor.progressStatus || "").toLowerCase();
  const exitCode = descriptor.exitCode == null ? undefined : Number(descriptor.exitCode);
  const runnerFailed = descriptor.runnerFailed === true;
  const timedOut = descriptor.timedOut === true;
  const controlledExit = [-15, 143].includes(exitCode);
  const controlledEvidence = descriptor.controlledTermination === true
    || (descriptor.host === "pi-rpc" && progressStatus === "completed");
  const controlledTermination = controlledExit
    && !runnerFailed
    && !timedOut
    && controlledEvidence;
  const unexpectedExit = Number.isFinite(exitCode) && exitCode !== 0 && !controlledTermination;
  const failed = lastAssistantFailed
    || runnerFailed
    || timedOut
    || FAILURE_TERMINAL_STATES.has(terminalState)
    || unexpectedExit;

  let error;
  if (failed) {
    if (descriptor.errorMessage) error = descriptor.errorMessage;
    else if (timedOut || terminalState === "timed_out") {
      const budget = Number(descriptor.runtimeBudgetSeconds);
      error = Number.isFinite(budget) && budget > 0
        ? `Goal Plus Pi worker exceeded its ${budget}-second runtime budget`
        : "Goal Plus Pi worker exceeded its runtime budget";
    } else if (runnerFailed) error = "Goal Plus Pi worker runner failed";
    else if (lastAssistantFailed) error = "Goal Plus Pi worker's final assistant turn failed";
    else if (unexpectedExit) error = `Goal Plus Pi worker exited unexpectedly with code ${exitCode}`;
    else error = `Goal Plus Pi session ended with ${terminalState}`;
  }

  return {
    controlledTermination,
    error,
    exitCode,
    failed,
    progressStatus,
    runnerFailed,
    runtimeState: failed
      ? timedOut || terminalState === "timed_out" ? "timed_out" : "failed"
      : hasPendingTools ? "running" : "completed",
    terminalState,
    timedOut,
  };
}

function resolvedSessionPath(root, descriptor) {
  return path.isAbsolute(descriptor.sessionFile)
    ? descriptor.sessionFile
    : path.resolve(root, descriptor.sessionFile);
}

function sourceFingerprint(sessionPath, stat) {
  return {
    pathHash: `sha256:${sha256(path.resolve(sessionPath))}`,
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

async function statPiSession(root, descriptor) {
  const sessionPath = resolvedSessionPath(root, descriptor);
  const canonicalRoots = await Promise.all(
    [...new Set([root, ...(descriptor.allowedRoots || [])])].map(item => fsp.realpath(item)),
  );
  const initial = await fsp.lstat(sessionPath);
  if (!initial.isFile() || initial.isSymbolicLink()) throw new Error("not a regular non-symlink file");
  const canonical = await fsp.realpath(sessionPath);
  const contained = canonicalRoots.some(canonicalRoot => (
    canonical === canonicalRoot || canonical.startsWith(`${canonicalRoot}${path.sep}`)
  ));
  if (!contained) throw new Error("file resolves outside allowed collector roots");
  const final = await fsp.stat(canonical);
  const initialIdentity = [initial.dev, initial.ino, initial.size, initial.mtimeMs, initial.ctimeMs].join(":");
  const finalIdentity = [final.dev, final.ino, final.size, final.mtimeMs, final.ctimeMs].join(":");
  if (initialIdentity !== finalIdentity) throw new Error("file changed while checking import state");
  return sourceFingerprint(sessionPath, final);
}

function sameFingerprint(left, right) {
  return Boolean(left && right && stableJson(left) === stableJson(right));
}

function fileWasReset(previous, current, previousDescriptor, currentDescriptor) {
  if (!previous) return false;
  if (previous.pathHash !== current.pathHash || previous.dev !== current.dev || previous.ino !== current.ino) return true;
  if (Number(current.size) < Number(previous.size)) return true;
  if (previousDescriptor?.startLine !== currentDescriptor?.startLine) return true;
  if (Number.isInteger(previousDescriptor?.endLine)
    && Number.isInteger(currentDescriptor?.endLine)
    && currentDescriptor.endLine < previousDescriptor.endLine) return true;
  return false;
}

function defaultImportCheckpoint() {
  return { version: IMPORT_CHECKPOINT_VERSION, sessions: {} };
}

async function readImportCheckpoint(checkpointPath) {
  try {
    const parsed = JSON.parse(await fsp.readFile(checkpointPath, "utf8"));
    if (parsed?.version === IMPORT_CHECKPOINT_VERSION && parsed.sessions && typeof parsed.sessions === "object") {
      return { checkpoint: parsed };
    }
    return {
      checkpoint: defaultImportCheckpoint(),
      diagnostic: { code: "invalid_pi_import_checkpoint", message: "unsupported checkpoint format; rebuilding" },
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { checkpoint: defaultImportCheckpoint() };
    if (error instanceof SyntaxError) {
      return {
        checkpoint: defaultImportCheckpoint(),
        diagnostic: { code: "invalid_pi_import_checkpoint", message: "malformed checkpoint; rebuilding" },
      };
    }
    throw error;
  }
}

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
  const sessionPath = resolvedSessionPath(root, descriptor);
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
  const source = sourceFingerprint(sessionPath, read.stat);
  if (!messages.length) return { events: [], fidelity: "summary-only", diagnostics, source };
  const explicitTimes = messages
    .map(message => timestamp(message.timestamp, Number.NaN))
    .filter(Number.isFinite);
  const fallback = explicitTimes.length
    ? explicitTimes.reduce((lowest, value) => Math.min(lowest, value))
    : Number(read.stat.birthtimeMs) || read.stat.mtimeMs;
  const times = messages.map(message => timestamp(message.timestamp, fallback));
  const startedAt = times.reduce((lowest, value) => Math.min(lowest, value), fallback);
  const endedAt = times.reduce((highest, value) => Math.max(highest, value), startedAt);
  const sessionId = descriptor.canonicalSessionId || `goal-plus:${descriptor.sourceId}:${descriptor.agentSessionId}`;
  const traceId = stableTraceId("pi-agent", sessionId);
  const agentSpanId = stableSpanId(sessionId, "agent");
  const firstUser = messages.find(message => message.role === "user");
  const input = descriptor.input || (firstUser ? messageText(firstUser) : "");
  const lastAssistant = messages.filter(message => message.role === "assistant").at(-1);
  const events = [];
  const pendingTools = new Map();
  let llmIndex = 0;
  let previousTime = startedAt;
  let lastAssistantFailed = false;
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
    "goal_plus.business_state": descriptor.businessState,
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
      lastAssistantFailed = failed;
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
  const outcome = runtimeOutcome(descriptor, lastAssistantFailed, pendingTools.size > 0);
  events.push({
    eventId: stableEventId(sessionId, agentSpanId),
    sessionId,
    traceId,
    spanId: agentSpanId,
    kind: "agent",
    name: "agent.pi",
    startTimeMs: startedAt,
    endTimeMs: endedAt,
    status: outcome.failed ? "error" : pendingTools.size ? "running" : "success",
    error: outcome.error,
    input,
    output: messageText(lastAssistant),
    model: lastAssistant?.responseModel || lastAssistant?.model,
    attributes: {
      ...commonAttributes,
      "goal_plus.terminal_state": outcome.terminalState || undefined,
      "goal_plus.runtime_state": outcome.runtimeState,
      "goal_plus.progress_status": outcome.progressStatus || undefined,
      "goal_plus.runner_failed": descriptor.runnerFailed == null ? undefined : outcome.runnerFailed,
      "goal_plus.timed_out": descriptor.timedOut == null ? undefined : outcome.timedOut,
      "goal_plus.controlled_termination": outcome.controlledTermination || undefined,
      "goal_plus.exit_code": Number.isFinite(outcome.exitCode) ? outcome.exitCode : undefined,
    },
  });
  return { events, fidelity: "derived", diagnostics, source };
}

async function importPiSessions(root, sessions, options) {
  const stateDir = options.stateDir || collectorStateDir("pi-agent", options.apiKey, options.homeDir);
  const writer = options.writer || new DurableTraceWriter({
    framework: "pi-agent",
    apiKey: options.apiKey,
    homeDir: options.homeDir,
    stateDir,
  });
  const uploader = options.uploader || new DurableTraceUploader({
    framework: "pi-agent",
    apiKey: options.apiKey,
    endpoint: options.endpoint,
    homeDir: options.homeDir,
    stateDir,
    fileOrder: "newest-first",
    maxBatchesPerFlush: GOAL_PLUS_UPLOAD_MAX_BATCHES_PER_FLUSH,
  });
  const checkpointPath = options.checkpointPath || path.join(stateDir, "goal-plus-import-checkpoint.json");
  const lockPath = options.lockPath || path.join(stateDir, "goal-plus-import.lock");
  const lock = await acquireProcessLock(lockPath);
  const diagnostics = [];
  let imported = 0;
  let skipped = 0;
  let appendedEvents = 0;
  let unchangedEvents = 0;

  if (lock) {
    try {
      const loaded = await readImportCheckpoint(checkpointPath);
      const checkpoint = loaded.checkpoint;
      if (loaded.diagnostic) diagnostics.push(loaded.diagnostic);
      let checkpointPersisted = false;

      for (const session of sessions) {
        const sessionId = session.canonicalSessionId || `goal-plus:${session.sourceId}:${session.agentSessionId}`;
        let descriptorHash;
        let parsed;
        let previous;
        try {
          descriptorHash = descriptorFingerprint(session);
          const currentSource = await statPiSession(root, session);
          previous = checkpoint.sessions[sessionId];
          if (previous?.outcomeDerivationVersion === OUTCOME_DERIVATION_VERSION
            && previous?.descriptorHash === descriptorHash
            && sameFingerprint(previous.source, currentSource)) {
            skipped += 1;
            continue;
          }
          parsed = await parsePiSession(root, session);
          for (const diagnostic of parsed.diagnostics || []) {
            diagnostics.push({ agentSessionId: session.agentSessionId, ...diagnostic });
          }
        } catch (error) {
          diagnostics.push({ agentSessionId: session.agentSessionId, code: "pi_import_failed", message: error.message });
          continue;
        }

        const reset = fileWasReset(previous?.source, parsed.source, previous?.descriptor, session);
        const previousHashes = reset ? {} : previous?.events || {};
        const nextHashes = {};
        let sessionAppended = 0;
        for (const event of parsed.events) {
          const hash = eventFingerprint(event);
          nextHashes[event.eventId] = hash;
          if (previousHashes[event.eventId] === hash) {
            unchangedEvents += 1;
            continue;
          }
          await writer.append(event);
          sessionAppended += 1;
        }
        await writer.flush();
        checkpoint.sessions[sessionId] = {
          source: parsed.source,
          descriptorHash,
          descriptor: {
            startLine: session.startLine,
            endLine: session.endLine,
          },
          events: nextHashes,
          outcomeDerivationVersion: OUTCOME_DERIVATION_VERSION,
          generation: Number(previous?.generation || 0) + (reset ? 1 : 0),
          updatedAt: new Date().toISOString(),
        };
        await atomicWriteJson(checkpointPath, checkpoint);
        checkpointPersisted = true;
        appendedEvents += sessionAppended;
        imported += sessionAppended > 0 ? 1 : 0;
      }

      await writer.flush();
      if (loaded.diagnostic && !checkpointPersisted) await atomicWriteJson(checkpointPath, checkpoint);
    } finally {
      await releaseProcessLock(lock);
    }
  } else {
    diagnostics.push({ code: "pi_import_locked", message: "another Goal Plus Pi import is already running" });
  }

  const upload = options.upload === false ? { uploadedEvents: 0 } : await uploader.flushOnce();
  if (upload.acquired === false) {
    const state = upload.lockStatus?.state || "contended";
    const reason = upload.lockStatus?.reason ? ` (${upload.lockStatus.reason})` : "";
    diagnostics.push({
      code: ["invalid", "orphaned", "recovery-blocked"].includes(state)
        ? "pi_upload_blocked"
        : "pi_upload_deferred",
      message: `Goal Plus Pi uploader did not acquire its lock: ${state}${reason}`,
    });
  }
  return {
    examined: sessions.length,
    imported,
    skipped,
    appendedEvents,
    unchangedEvents,
    uploadedEvents: upload.uploadedEvents || 0,
    uploadStatus: upload,
    diagnostics,
  };
}

module.exports = {
  descriptorFingerprint,
  detectedSkill,
  eventFingerprint,
  importPiSessions,
  messageText,
  parsePiSession,
  readImportCheckpoint,
  runtimeOutcome,
  statPiSession,
  toolCalls,
  unwrapMessage,
};
