/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");

const { readJsonlBatch, readCheckpoint, atomicWriteJson, redactValue, stableEventId } = require("../shared/trace-transport.cjs");
const { classifyCodexSource } = require("./source-classifier.cjs");

function text(value) {
  if (value === undefined || value === null) return undefined;
  const result = String(value).trim();
  return result || undefined;
}

function number(value, fallback = Date.now()) {
  const result = Number(value);
  if (Number.isFinite(result) && result > 0) return result;
  if (typeof value === "string") {
    const parsed = Date.parse(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function payloadOf(record) {
  if (!record || typeof record !== "object") return {};
  return record.payload && typeof record.payload === "object" ? record.payload : record;
}

function recordType(record) {
  const payload = payloadOf(record);
  const outer = text(record?.type || record?.event);
  if (outer && /^(?:event_msg|event-message)$/i.test(outer)) {
    return text(payload.type || payload.event || payload.kind) || outer;
  }
  return outer || text(payload.type || payload.event || record?.kind);
}

function eventMessage(record) {
  const payload = payloadOf(record);
  return payload.msg && typeof payload.msg === "object" ? payload.msg : payload;
}

function sessionMeta(record) {
  const payload = payloadOf(record);
  return recordType(record) === "session_meta" || recordType(record) === "sessionMeta"
    ? payload
    : undefined;
}

function timestampOf(record) {
  const payload = payloadOf(record);
  return number(record.timestampMs || record.timestamp_ms || record.timestamp || payload.timestampMs || payload.timestamp_ms || payload.timestamp);
}

function taskIdOf(value) {
  const payload = payloadOf(value);
  return text(payload.turn_id || payload.turnId || payload.task_id || payload.taskId || payload.id);
}

function sourceEvent(base, eventType, record, extra = {}) {
  return {
    eventId: stableEventId("desktop-rollout", base.sourceThreadId, base.sourceExecutionId, base.sourceItemId, eventType, timestampOf(record), extra.sequence),
    eventType,
    source: "desktop_rollout",
    sourceKind: base.sourceKind,
    sourceThreadId: base.sourceThreadId,
    sourceExecutionId: extra.sourceExecutionId || base.sourceExecutionId,
    sourceItemId: extra.sourceItemId,
    timestampMs: extra.timestampMs || timestampOf(record),
    sequence: extra.sequence,
    inputKind: extra.inputKind,
    payload: redactValue(extra.payload || {}),
    provenance: { direct: true, confidence: "direct" },
  };
}

function classifyRolloutMetadata(meta) {
  return classifyCodexSource({
    originator: meta?.originator,
    source: meta?.source || meta?.thread_source,
    terminalType: meta?.terminal_type,
  });
}

function recordsToLifecycleEvents(record, context) {
  const type = recordType(record);
  const payload = eventMessage(record);
  const timestampMs = timestampOf(record);
  const base = {
    sourceKind: context.sourceKind,
    sourceThreadId: context.sourceThreadId,
    sourceExecutionId: context.activeExecutionId,
  };
  if (type === "session_meta" || type === "sessionMeta") {
    const meta = sessionMeta(record) || payload;
    const sourceThreadId = text(meta.id || meta.session_id || meta.sessionId || context.sourceThreadId);
    if (!sourceThreadId) return { events: [], context: { ...context, unknownRecords: context.unknownRecords + 1 } };
    const classification = classifyRolloutMetadata(meta);
    return {
      events: [{
        ...sourceEvent({ ...base, sourceThreadId, sourceKind: classification.sourceKind }, "thread_started", record, {
          payload: { originator: meta.originator, source: meta.source, threadSource: meta.thread_source, protocolVersion: meta.cli_version || meta.version },
        }),
      }],
      context: { ...context, sourceThreadId, sourceKind: classification.sourceKind, metadata: redactValue(meta) },
    };
  }
  if (!context.sourceThreadId) return { events: [], context: { ...context, unknownRecords: context.unknownRecords + 1 } };
  if (type === "task_started") {
    const id = taskIdOf(payload);
    if (!id) return { events: [], context: { ...context, unknownRecords: context.unknownRecords + 1 } };
    return { events: [], context: { ...context, activeExecutionId: id, activeTaskHadUserInput: false, taskStartedAt: timestampMs } };
  }
  if (type === "user_message" || type === "userMessage") {
    const id = taskIdOf(payload) || context.activeExecutionId;
    const content = text(payload.message || payload.content || payload.text || payload.prompt);
    if (!id || !content) return { events: [], context: { ...context, unknownRecords: context.unknownRecords + 1 } };
    const started = context.activeExecutionId === id && context.activeTaskHadUserInput
      ? []
      : [sourceEvent({ ...base, sourceExecutionId: id }, "execution_started", record, {
          sourceExecutionId: id,
          timestampMs: context.taskStartedAt || timestampMs,
          payload: { input: content },
        })];
    started.push(sourceEvent({ ...base, sourceExecutionId: id }, "user_input_accepted", record, {
      sourceExecutionId: id,
      inputKind: context.activeExecutionId === id && context.activeTaskHadUserInput ? "follow_up_unknown" : "initial",
      payload: { content },
    }));
    return { events: started, context: { ...context, activeExecutionId: id, activeTaskHadUserInput: true } };
  }
  if (type === "turn_aborted" || type === "turnAborted") {
    const id = taskIdOf(payload) || context.activeExecutionId;
    if (!id) return { events: [], context: { ...context, unknownRecords: context.unknownRecords + 1 } };
    return { events: [sourceEvent({ ...base, sourceExecutionId: id }, "execution_interrupted", record, {
      sourceExecutionId: id,
      payload: { reason: payload.reason || "interrupted" },
    })], context: { ...context, activeExecutionId: id } };
  }
  if (type === "task_complete" || type === "taskComplete") {
    const id = taskIdOf(payload) || context.activeExecutionId;
    if (!id || !context.activeTaskHadUserInput) return { events: [], context: { ...context, activeExecutionId: undefined } };
    const status = /fail|error/i.test(String(payload.status || payload.outcome || "")) ? "failed" : "completed";
    return { events: [sourceEvent({ ...base, sourceExecutionId: id }, "execution_completed", record, {
      sourceExecutionId: id,
      status,
      payload: { status, output: payload.last_assistant_message || payload.output || payload.result },
    })], context: { ...context, activeExecutionId: undefined, activeTaskHadUserInput: false } };
  }
  if (type === "compacted") {
    const item = text(payload.window_id || payload.windowId || payload.id) || stableEventId("desktop-window", context.sourceThreadId, timestampMs);
    const details = { window_id: payload.window_id, previous_window_id: payload.previous_window_id, window_number: payload.window_number };
    return { events: [
      sourceEvent({ ...base, sourceExecutionId: undefined }, "context_compaction_started", record, { sourceItemId: item, payload: details }),
      sourceEvent({ ...base, sourceExecutionId: undefined }, "context_compaction_completed", record, { sourceItemId: item, payload: details }),
    ], context };
  }
  if (type === "context_compacted" || type === "contextCompacted") {
    const item = text(payload.window_id || payload.windowId || payload.id);
    return { events: [sourceEvent({ ...base, sourceExecutionId: undefined }, "context_compaction_completed", record, {
      sourceItemId: item,
      payload: { legacy: true },
    })], context };
  }
  return { events: [], context: { ...context, unknownRecords: context.unknownRecords + 1 } };
}

async function listRolloutFiles(sessionsDir) {
  const result = [];
  async function walk(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(candidate);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) result.push(candidate);
    }
  }
  await walk(sessionsDir);
  return result.sort();
}

function defaultSessionsDir(homeDir) {
  return path.join(homeDir, ".codex", "sessions");
}

function createDesktopRolloutReader(options = {}) {
  const enabled = options.enabled === true;
  const sessionsDir = options.sessionsDir || defaultSessionsDir(options.homeDir || require("node:os").homedir());
  const checkpointPath = options.checkpointPath || path.join(options.stateDir || path.dirname(sessionsDir), "desktop-rollout-checkpoint.json");
  const onEvents = options.onEvents || (async () => undefined);
  const state = { version: 1, files: {}, unknownRecords: 0 };

  async function load() {
    if (!enabled) return;
    const stored = await readCheckpoint(checkpointPath);
    if (stored.version === 1 && stored.files) Object.assign(state, stored);
  }

  async function scanFile(filePath) {
    if (!enabled) return { events: 0, skipped: true };
    const relative = path.relative(sessionsDir, filePath).replaceAll(path.sep, "/");
    const cursor = Number(state.files[relative]?.bytes) || 0;
    const saved = state.files[relative] || {};
    const context = {
      sourceThreadId: saved.sourceThreadId,
      sourceKind: saved.sourceKind || "unknown",
      activeExecutionId: saved.activeExecutionId,
      activeTaskHadUserInput: saved.activeTaskHadUserInput === true,
      taskStartedAt: saved.taskStartedAt,
      unknownRecords: 0,
    };
    let offset = cursor;
    let emitted = 0;
    while (true) {
      const batch = await readJsonlBatch(filePath, offset, { maxEvents: 100, maxBytes: 512 * 1024 });
      if (batch.events.length === 0) break;
      let nextContext = context;
      const events = [];
      for (const record of batch.events) {
        const converted = recordsToLifecycleEvents(record, nextContext);
        nextContext = converted.context;
        events.push(...converted.events);
      }
      if (events.length > 0) {
        await onEvents(events, { filePath, relativePath: relative });
        emitted += events.length;
      }
      offset = batch.nextOffset;
      state.files[relative] = {
        bytes: offset,
        sourceThreadId: nextContext.sourceThreadId,
        sourceKind: nextContext.sourceKind,
        activeExecutionId: nextContext.activeExecutionId,
        activeTaskHadUserInput: nextContext.activeTaskHadUserInput === true,
        taskStartedAt: nextContext.taskStartedAt,
      };
      state.unknownRecords += nextContext.unknownRecords - context.unknownRecords;
      Object.assign(context, nextContext);
      await atomicWriteJson(checkpointPath, state);
      if (batch.tornTailBytes > 0) break;
    }
    return { events: emitted, offset, unknownRecords: state.unknownRecords };
  }

  async function scan() {
    if (!enabled) return { files: 0, events: 0, skipped: true };
    await load();
    const files = await listRolloutFiles(sessionsDir);
    let events = 0;
    for (const filePath of files) events += (await scanFile(filePath)).events;
    return { files: files.length, events, unknownRecords: state.unknownRecords };
  }

  return { enabled, sessionsDir, checkpointPath, load, scan, scanFile, state, listRolloutFiles: () => listRolloutFiles(sessionsDir) };
}

module.exports = {
  classifyRolloutMetadata,
  createDesktopRolloutReader,
  defaultSessionsDir,
  listRolloutFiles,
  recordsToLifecycleEvents,
};
