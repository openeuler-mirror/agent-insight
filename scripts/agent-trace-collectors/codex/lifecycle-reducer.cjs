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

const { stableEventId, redactValue, safeContent } = require("../shared/trace-transport.cjs");

const TERMINAL = new Set(["completed", "interrupted", "failed"]);
const STATUS_RANK = new Map([["in_progress", 0], ["completed", 1], ["interrupted", 2], ["failed", 2]]);
const COMPACTION_DEDUPE_WINDOW_MS = 5_000;

function asText(value) {
  if (value === undefined || value === null) return undefined;
  const result = String(value).trim();
  return result || undefined;
}

function asTimestamp(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function keyFor(event) {
  return asText(event.eventId) || stableEventId(
    "codex-lifecycle",
    event.source,
    event.sourceThreadId,
    event.sourceExecutionId,
    event.sourceItemId,
    event.eventType,
    event.timestampMs,
    event.sequence,
  );
}

function executionKey(event) {
  if (event.sourceExecutionId) {
    return `${event.sourceThreadId}:execution:${event.sourceExecutionId}`;
  }
  return `${event.sourceThreadId}:execution:unknown`;
}

function inputRecord(event, execution, index) {
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const content = asText(payload.content ?? payload.input ?? payload.prompt ?? event.input);
  if (!content) return undefined;
  const kind = event.inputKind || (index === 0 ? "initial" : "follow_up_unknown");
  const phaseId = asText(payload.phaseId) || `phase-${index}`;
  return {
    role: "user",
    content: safeContent(content),
    timestamp: new Date(event.timestampMs).toISOString(),
    turn_id: execution.sourceExecutionId,
    input_kind: kind,
    input_index: index,
    phase_id: phaseId,
    client_message_id: asText(event.clientMessageId || payload.clientMessageId),
    source: event.source,
    source_kind: event.sourceKind,
  };
}

function createCodexLifecycleReducer() {
  const state = {
    version: 1,
    threads: new Map(),
    executions: new Map(),
    events: new Map(),
    compactions: new Map(),
    transitions: [],
    counters: { accepted: 0, duplicate: 0, pending: 0, unknown: 0 },
  };

  function ensureThread(event) {
    const id = asText(event.sourceThreadId);
    if (!id) throw new Error("Codex lifecycle event is missing sourceThreadId");
    let thread = state.threads.get(id);
    if (!thread) {
      thread = {
        sourceThreadId: id,
        sourceKind: event.sourceKind || "unknown",
        source: event.source,
        startedAt: event.timestampMs,
        updatedAt: event.timestampMs,
        events: [],
      };
      state.threads.set(id, thread);
    }
    thread.updatedAt = Math.max(thread.updatedAt || event.timestampMs, event.timestampMs);
    if (thread.sourceKind === "unknown" && event.sourceKind) thread.sourceKind = event.sourceKind;
    return thread;
  }

  function ensureExecution(event, create = true) {
    if (!event.sourceExecutionId && !create) return undefined;
    const key = executionKey(event);
    let execution = state.executions.get(key);
    if (!execution && create) {
      execution = {
        key,
        sourceThreadId: event.sourceThreadId,
        sourceExecutionId: event.sourceExecutionId,
        sourceKind: event.sourceKind || "unknown",
        source: event.source,
        startedAt: event.timestampMs,
        updatedAt: event.timestampMs,
        status: "in_progress",
        query: undefined,
        inputs: [],
        phases: [],
        output: undefined,
      };
      state.executions.set(key, execution);
    }
    if (execution) {
      execution.updatedAt = Math.max(execution.updatedAt || event.timestampMs, event.timestampMs);
      if (execution.sourceKind === "unknown" && event.sourceKind) execution.sourceKind = event.sourceKind;
    }
    return execution;
  }

  function transitionTo(execution, status) {
    if (!status || !TERMINAL.has(status) && status !== "in_progress") return false;
    const currentRank = STATUS_RANK.get(execution.status) ?? 0;
    const nextRank = STATUS_RANK.get(status) ?? 0;
    if (TERMINAL.has(execution.status) && nextRank <= currentRank) return false;
    if (nextRank < currentRank) return false;
    if (execution.status === status) return false;
    execution.status = status;
    return true;
  }

  function recordTransition(previous, next, event) {
    if (!previous || !next || previous.key === next.key) return;
    const key = stableEventId("codex-transition", previous.key, next.key);
    if (state.transitions.some((item) => item.key === key)) return;
    state.transitions.push({
      key,
      sourceThreadId: previous.sourceThreadId,
      previousSourceExecutionId: previous.sourceExecutionId,
      nextSourceExecutionId: next.sourceExecutionId,
      previousExecutionKey: previous.key,
      nextExecutionKey: next.key,
      kind: event.payload?.transitionKind || `${previous.status === "interrupted" ? "interrupt" : previous.status}_followed_by_execution`,
      confidence: event.provenance?.confidence || "pending",
      timestampMs: event.timestampMs,
    });
  }

  function apply(rawEvent) {
    if (!rawEvent || typeof rawEvent !== "object") throw new Error("Codex lifecycle event must be an object");
    const event = {
      ...rawEvent,
      eventId: keyFor(rawEvent),
      sourceThreadId: asText(rawEvent.sourceThreadId),
      sourceExecutionId: asText(rawEvent.sourceExecutionId),
      sourceItemId: asText(rawEvent.sourceItemId),
      timestampMs: asTimestamp(rawEvent.timestampMs, Date.now()),
      sourceKind: asText(rawEvent.sourceKind) || "unknown",
      payload: redactValue(rawEvent.payload || {}),
    };
    if (!event.sourceThreadId || !event.eventType) throw new Error("Codex lifecycle event is incomplete");
    if (state.events.has(event.eventId)) {
      state.counters.duplicate += 1;
      return { duplicate: true, event, snapshots: [] };
    }
    state.events.set(event.eventId, event);
    const thread = ensureThread(event);
    thread.events.push(event.eventId);
    let execution;
    let previous;
    let changed = false;

    if (event.eventType === "thread_started") {
      changed = true;
    } else if (event.eventType === "execution_started") {
      previous = [...state.executions.values()]
        .filter((item) => item.sourceThreadId === event.sourceThreadId && TERMINAL.has(item.status))
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      execution = ensureExecution(event, true);
      changed = true;
      if (previous && previous.key !== execution.key) recordTransition(previous, execution, event);
    } else if (event.eventType === "user_input_accepted") {
      execution = ensureExecution(event, Boolean(event.sourceExecutionId));
      if (!execution) {
        state.counters.pending += 1;
        return { pending: true, event, snapshots: [] };
      }
      const input = inputRecord(event, execution, execution.inputs.length);
      if (input) {
        execution.inputs.push(input);
        if (input.input_kind === "initial" && !execution.query) execution.query = input.content;
        execution.phases.push({
          id: input.phase_id,
          inputKind: input.input_kind,
          startedAt: event.timestampMs,
          clientMessageId: input.client_message_id,
        });
        changed = true;
      }
      state.counters.accepted += 1;
    } else if (event.eventType === "execution_interrupted" || event.eventType === "execution_completed") {
      execution = ensureExecution(event, false);
      if (!execution) {
        state.counters.pending += 1;
        return { pending: true, event, snapshots: [] };
      }
      changed = transitionTo(execution, event.eventType === "execution_interrupted" ? "interrupted" : (event.status || "completed"));
      execution.output = asText(event.payload?.output ?? event.payload?.result) || execution.output;
    } else if (event.eventType === "context_compaction_started" || event.eventType === "context_compaction_completed") {
      const payload = event.payload || {};
      const explicitCompactionKey = asText(event.sourceItemId || payload.window_id || payload.windowId);
      let compactionKey = explicitCompactionKey ||
        stableEventId("codex-compaction", event.sourceThreadId, Math.floor(event.timestampMs / 1000));
      if (!explicitCompactionKey && payload.legacy) {
        const recent = [...state.compactions.values()]
          .filter((item) => item.sourceThreadId === event.sourceThreadId)
          .map((item) => ({ item, distance: Math.abs((item.completedAt || item.startedAt) - event.timestampMs) }))
          .filter((candidate) => candidate.distance <= COMPACTION_DEDUPE_WINDOW_MS)
          .sort((left, right) => left.distance - right.distance)[0];
        if (recent) compactionKey = recent.item.key;
      }
      let compaction = state.compactions.get(compactionKey);
      if (!compaction) {
        compaction = {
          key: compactionKey,
          sourceThreadId: event.sourceThreadId,
          sourceKind: event.sourceKind,
          startedAt: event.timestampMs,
          completedAt: undefined,
          status: "running",
          payload: {},
        };
        state.compactions.set(compactionKey, compaction);
      }
      if (event.eventType === "context_compaction_started") {
        compaction.startedAt = Math.min(compaction.startedAt, event.timestampMs);
        compaction.status = "running";
      } else {
        compaction.completedAt = event.timestampMs;
        compaction.status = "completed";
      }
      compaction.payload = { ...compaction.payload, ...payload };
      changed = true;
    } else {
      state.counters.unknown += 1;
    }
    return { duplicate: false, pending: false, event, thread, execution, changed, snapshots: changed ? snapshotEvents(state, event) : [] };
  }

  function snapshotEvents(current, sourceEvent) {
    const snapshots = [];
    const executions = [...current.executions.values()].filter((item) => item.sourceThreadId === sourceEvent.sourceThreadId);
    for (const execution of executions) {
      snapshots.push({
        eventId: stableEventId("codex-execution-snapshot", execution.key),
        eventType: "execution_snapshot",
        source: "lifecycle_reducer",
        sourceKind: execution.sourceKind,
        sourceThreadId: execution.sourceThreadId,
        sourceExecutionId: execution.sourceExecutionId,
        timestampMs: execution.updatedAt,
        payload: {
          startedAt: execution.startedAt,
          updatedAt: execution.updatedAt,
          status: execution.status,
          query: execution.query,
          inputs: execution.inputs,
          phases: execution.phases,
          output: execution.output,
        },
        provenance: { direct: true, confidence: "direct" },
      });
    }
    for (const compaction of [...current.compactions.values()].filter((item) => item.sourceThreadId === sourceEvent.sourceThreadId)) {
      snapshots.push({
        eventId: stableEventId("codex-compaction-snapshot", compaction.key),
        eventType: "compaction_snapshot",
        source: "lifecycle_reducer",
        sourceKind: compaction.sourceKind,
        sourceThreadId: compaction.sourceThreadId,
        sourceItemId: compaction.key,
        timestampMs: compaction.completedAt || compaction.startedAt,
        payload: {
          status: compaction.status,
          startedAt: compaction.startedAt,
          completedAt: compaction.completedAt,
          durationMs: compaction.completedAt ? Math.max(0, compaction.completedAt - compaction.startedAt) : undefined,
          ...compaction.payload,
        },
        provenance: { direct: true, confidence: "direct" },
      });
    }
    for (const transition of current.transitions.filter((item) => item.sourceThreadId === sourceEvent.sourceThreadId)) {
      snapshots.push({
        eventId: stableEventId("codex-transition-snapshot", transition.key),
        eventType: "thread_event_snapshot",
        source: "lifecycle_reducer",
        sourceKind: sourceEvent.sourceKind,
        sourceThreadId: transition.sourceThreadId,
        sourceItemId: transition.key,
        timestampMs: transition.timestampMs,
        payload: {
          kind: "execution_transition",
          previousSourceExecutionId: transition.previousSourceExecutionId,
          nextSourceExecutionId: transition.nextSourceExecutionId,
          transitionKind: transition.kind,
          confidence: transition.confidence,
        },
        provenance: { direct: transition.confidence === "direct", confidence: transition.confidence },
      });
    }
    return snapshots;
  }

  function snapshot() {
    return {
      version: 1,
      counters: { ...state.counters },
      threads: [...state.threads.values()].map((thread) => ({ ...thread, events: [...thread.events] })),
      executions: [...state.executions.values()].map((execution) => ({ ...execution, inputs: [...execution.inputs], phases: [...execution.phases] })),
      compactions: [...state.compactions.values()].map((compaction) => ({ ...compaction })),
      transitions: state.transitions.map((transition) => ({ ...transition })),
      eventIds: [...state.events.keys()],
    };
  }

  function restore(serialized) {
    if (!serialized || serialized.version !== 1) return;
    state.counters = { ...state.counters, ...(serialized.counters || {}) };
    for (const thread of serialized.threads || []) state.threads.set(thread.sourceThreadId, { ...thread, events: [...(thread.events || [])] });
    for (const execution of serialized.executions || []) state.executions.set(execution.key, { ...execution, inputs: [...(execution.inputs || [])], phases: [...(execution.phases || [])] });
    for (const compaction of serialized.compactions || []) state.compactions.set(compaction.key, { ...compaction });
    state.transitions = (serialized.transitions || []).map((item) => ({ ...item }));
    for (const eventId of serialized.eventIds || []) state.events.set(eventId, { eventId });
  }

  return { apply, restore, snapshot, state };
}

module.exports = { createCodexLifecycleReducer, TERMINAL };
