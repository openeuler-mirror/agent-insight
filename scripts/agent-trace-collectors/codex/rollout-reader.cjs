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
    // 446-8：终态事件的状态字段是事件顶层契约（reducer 读 event.status），
    // 只放 payload 会在组装层丢失，失败任务会被回退成 completed。
    status: extra.status,
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

function contentEvent(base, record, contentKind, payload) {
  return {
    eventId: stableEventId("desktop-rollout-content", base.sourceThreadId, base.sourceExecutionId, contentKind, payload.callId || payload.itemId || payload.text, timestampOf(record)),
    eventType: "rollout_content",
    contentKind,
    source: "desktop_rollout",
    sourceKind: base.sourceKind,
    sourceThreadId: base.sourceThreadId,
    sourceExecutionId: base.sourceExecutionId,
    sourceItemId: payload.callId || payload.itemId,
    timestampMs: timestampOf(record),
    payload: redactValue(payload),
    provenance: { direct: true, confidence: "direct" },
  };
}

function messageText(payload) {
  const content = Array.isArray(payload?.content) ? payload.content : [];
  const parts = content
    .map((item) => (item && typeof item === "object" ? text(item.text) : undefined))
    .filter(Boolean);
  if (parts.length > 0) return parts.join("\n") || undefined;
  return text(payload?.text ?? payload?.message);
}

function outputText(payload) {
  const raw = payload?.output;
  if (Array.isArray(raw)) {
    const parts = raw
      .map((item) => (item && typeof item === "object" ? text(item.text) : undefined))
      .filter(Boolean);
    if (parts.length > 0) return parts.join("\n") || undefined;
  }
  if (raw && typeof raw === "object") return text(JSON.stringify(raw));
  return text(raw);
}

/** 0.164 起 reasoning 正文从 summary 改名为 summary_text/raw_content。 */
function reasoningText(payload) {
  for (const key of ["summary_text", "raw_content", "summary", "text", "content"]) {
    const value = payload?.[key];
    if (Array.isArray(value)) {
      const parts = value
        .map((item) => (item && typeof item === "object" ? text(item.text ?? item.content) : text(item)))
        .filter(Boolean);
      if (parts.length > 0) return parts.join("\n") || undefined;
    } else if (typeof value === "string") {
      const single = text(value);
      if (single) return single;
    }
  }
  return undefined;
}

/** item_completed 的 item.content[].text（UserMessage/AgentMessage 同形）。 */
function itemContentText(item) {
  const content = Array.isArray(item?.content) ? item.content : [];
  const parts = content
    .map((part) => (part && typeof part === "object" ? text(part.text) : undefined))
    .filter(Boolean);
  if (parts.length > 0) return parts.join("\n") || undefined;
  return text(item?.text ?? item?.message);
}

function usageRecord(payload) {
  const usage = payload?.usage && typeof payload.usage === "object" ? payload.usage : undefined;
  if (!usage) return undefined;
  const pick = (...keys) => {
    for (const key of keys) {
      const value = Number(usage[key]);
      if (Number.isFinite(value)) return value;
    }
    return undefined;
  };
  const inputTokens = pick("input_tokens", "inputTokens", "prompt_tokens");
  const outputTokens = pick("output_tokens", "outputTokens", "completion_tokens");
  const reasoningTokens = pick("reasoning_output_tokens", "reasoning_tokens", "reasoningTokens");
  const cacheReadTokens = pick("cached_input_tokens", "cache_read_input_tokens", "cached_tokens");
  const cacheWriteTokens = pick("cache_write_input_tokens", "cache_creation_input_tokens");
  const totalTokens = pick("total_tokens", "totalTokens")
    ?? ((inputTokens || 0) + (outputTokens || 0) || undefined);
  if ([inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, totalTokens]
    .every((value) => value === undefined)) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    responseId: text(payload.response_id ?? payload.responseId),
    model: text(payload.model ?? payload.model_name),
  };
}

function extractRolloutContentEvents(record, context) {
  const type = recordType(record);
  const payload = payloadOf(record);
  const base = {
    sourceKind: context.sourceKind,
    sourceThreadId: context.sourceThreadId,
    sourceExecutionId: context.activeExecutionId,
  };
  const events = [];
  if (!context.sourceThreadId) return { events, context };
  if (type === "response_item" || type === "responseItem") {
    const itemType = text(payload.type);
    if (itemType === "message" && text(payload.role) === "assistant") {
      const body = messageText(payload);
      if (body) {
        events.push(contentEvent(base, record, "llm_text", {
          itemId: text(payload.id),
          text: body,
        }));
      }
    } else if (itemType === "message" && text(payload.role) === "user") {
      // user 正文由 user_message lifecycle 事件承担（同内容、带 turn id），不重复提取。
    } else if (itemType === "function_call" || itemType === "custom_tool_call") {
      // 记录 call_id → 工具名映射，供 tool_output content 事件回填 toolName。
      const callId = text(payload.call_id ?? payload.callId);
      const name = text(payload.name);
      if (callId && name) context.toolNames.set(callId, name);
    } else if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
      const callId = text(payload.call_id ?? payload.callId);
      const output = outputText(payload);
      if (callId && output) {
        events.push(contentEvent(base, record, "tool_output", {
          callId,
          toolName: context.toolNames.get(callId),
          output,
        }));
      }
    }
  } else if (type === "item_completed" || type === "itemCompleted") {
    // 0.164 把助手消息搬到 item_completed。UserMessage 由 lifecycle 分支承担
    // （带 turn id，不重复提取）；工具执行已由 response_item 工具通道覆盖。
    // reasoning 在 0.164 只有 encrypted_content / 空 summary_text，无可采正文。
    const item = payload.item && typeof payload.item === "object" ? payload.item : {};
    if (text(item.type) === "AgentMessage") {
      const body = itemContentText(item);
      if (body) {
        events.push(contentEvent(base, record, "llm_text", {
          itemId: text(item.id),
          text: body,
        }));
      }
    }
  } else if (type === "agent_message" || type === "agentMessage") {
    const body = messageText(payload);
    if (body) {
      events.push(contentEvent(base, record, "agent_message", {
        text: body,
      }));
    }
  }
  return { events, context };
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
  // 0.164：用户输入改由 item_completed 的 UserMessage 条目承载，rollout 不再写
  // user_message。缺失时整轮没有 execution_started，随后 task_complete 因
  // activeTaskHadUserInput=false 被丢弃 → 桌面 trace 完全不落库（Bug 446-9）。
  if (type === "item_completed" || type === "itemCompleted") {
    const item = payload.item && typeof payload.item === "object" ? payload.item : {};
    if (text(item.type) !== "UserMessage") return { events: [], context };
    const id = text(payload.turn_id || payload.turnId) || context.activeExecutionId;
    const content = itemContentText(item);
    if (!id || !content) return { events: [], context: { ...context, unknownRecords: context.unknownRecords + 1 } };
    const isFollowUp = context.activeExecutionId === id && context.activeTaskHadUserInput;
    return {
      events: [
        ...(isFollowUp ? [] : [sourceEvent({ ...base, sourceExecutionId: id }, "execution_started", record, {
          sourceExecutionId: id,
          timestampMs: context.taskStartedAt || timestampMs,
          payload: { input: content },
        })]),
        sourceEvent({ ...base, sourceExecutionId: id }, "user_input_accepted", record, {
          sourceExecutionId: id,
          inputKind: isFollowUp ? "follow_up_unknown" : "initial",
          payload: { content },
        }),
      ],
      context: { ...context, activeExecutionId: id, activeTaskHadUserInput: true },
    };
  }
  // 0.164：每轮 LLM 调用的 token 用量记在顶层 token_usage_record（含 cached/
  // reasoning 分项），旧 reader 完全忽略 → LLM 节点全部无 usage。
  if (type === "token_usage_record" || type === "tokenUsageRecord") {
    const usage = usageRecord(payload);
    if (!usage) return { events: [], context: { ...context, unknownRecords: context.unknownRecords + 1 } };
    const id = text(payload.turn_id || payload.turnId || payload.root_turn_id) || context.activeExecutionId;
    if (!id) return { events: [], context: { ...context, unknownRecords: context.unknownRecords + 1 } };
    return {
      events: [sourceEvent({ ...base, sourceExecutionId: id }, "rollout_usage", record, {
        sourceExecutionId: id,
        payload: usage,
      })],
      context,
    };
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
  // 回填窗口：文件名里的 rollout 起始时间早于该时刻的历史文件直接跳过（标记
  // 已消费到 EOF），避免首次启用 ingress 时一次性回灌全部历史会话。
  // 446-3：显式 backfillAfterMs（>0）优先；缺省/非正数不再解释为「无截止」，
  // 而是首次启用时把边界持久化进 checkpoint（state.backfillBoundaryMs），
  // 此后沿用——旧配置升级也不会回灌启用前的历史。
  const explicitBackfillAfterMs = Number(options.backfillAfterMs) > 0 ? Number(options.backfillAfterMs) : undefined;
  const state = { version: 1, files: {}, unknownRecords: 0 };

  function rolloutStartMs(filePath) {
    const match = /rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(path.basename(filePath));
    if (!match) return undefined;
    const parsed = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  async function load() {
    if (!enabled) return;
    const stored = await readCheckpoint(checkpointPath);
    if (stored.version === 1 && stored.files) Object.assign(state, stored);
    if (explicitBackfillAfterMs === undefined && !Number.isFinite(state.backfillBoundaryMs)) {
      state.backfillBoundaryMs = Date.now();
      await atomicWriteJson(checkpointPath, state);
    }
  }

  function backfillCutoffMs() {
    return explicitBackfillAfterMs ?? (Number.isFinite(state.backfillBoundaryMs) ? state.backfillBoundaryMs : undefined);
  }

  // 446-7：跳过历史回填文件时仍读取文件头部的 session_meta，保留 thread 归属
  // 与分类——用户恢复旧会话继续对话时，EOF 之后的新增记录才能正确归属。
  async function readSkippedMetadata(filePath) {
    const batch = await readJsonlBatch(filePath, 0, { maxEvents: 100, maxBytes: 512 * 1024 })
      .catch(() => ({ events: [] }));
    for (const record of batch.events || []) {
      const type = recordType(record);
      if (type !== "session_meta" && type !== "sessionMeta") continue;
      const meta = sessionMeta(record) || payloadOf(record);
      const sourceThreadId = text(meta.id || meta.session_id || meta.sessionId);
      if (!sourceThreadId) break;
      return { sourceThreadId, sourceKind: classifyRolloutMetadata(meta).sourceKind };
    }
    return {};
  }

  async function scanFile(filePath) {
    if (!enabled) return { events: 0, skipped: true };
    const relative = path.relative(sessionsDir, filePath).replaceAll(path.sep, "/");
    const cutoff = backfillCutoffMs();
    if (cutoff !== undefined && !state.files[relative]) {
      const startedAt = rolloutStartMs(filePath);
      if (startedAt !== undefined && startedAt < cutoff) {
        const stat = await fsp.stat(filePath).catch(() => undefined);
        const metadata = await readSkippedMetadata(filePath);
        state.files[relative] = {
          bytes: stat?.size || 0,
          skippedBackfill: true,
          sourceThreadId: metadata.sourceThreadId,
          sourceKind: metadata.sourceKind,
        };
        // 446-7：跳过决策必须立即持久化，否则只有被跳过文件时 checkpoint 不落盘，
        // 下一次扫描无法恢复归属元数据。
        await atomicWriteJson(checkpointPath, state);
        return { events: 0, skipped: true, backfilled: false };
      }
    }
    const cursor = Number(state.files[relative]?.bytes) || 0;
    const saved = state.files[relative] || {};
    const context = {
      sourceThreadId: saved.sourceThreadId,
      sourceKind: saved.sourceKind || "unknown",
      activeExecutionId: saved.activeExecutionId,
      activeTaskHadUserInput: saved.activeTaskHadUserInput === true,
      taskStartedAt: saved.taskStartedAt,
      unknownRecords: 0,
      toolNames: new Map(saved.toolNames || []),
    };
    let offset = cursor;
    let emitted = 0;
    while (true) {
      const batch = await readJsonlBatch(filePath, offset, { maxEvents: 100, maxBytes: 512 * 1024 });
      if (batch.events.length === 0) break;
      let nextContext = context;
      const events = [];
      for (const record of batch.events) {
        const lifecycle = recordsToLifecycleEvents(record, nextContext);
        nextContext = lifecycle.context;
        events.push(...lifecycle.events);
        // Bug 56：response_item/agent_message 正文记录此前落入 unknownRecords；这里
        // 以 rollout_content 事件提取正文与工具结果，与 lifecycle 事件同批上报。
        const content = extractRolloutContentEvents(record, nextContext);
        nextContext = content.context;
        events.push(...content.events);
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
        toolNames: [...nextContext.toolNames.entries()].slice(-500),
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
  extractRolloutContentEvents,
  listRolloutFiles,
  recordsToLifecycleEvents,
};
