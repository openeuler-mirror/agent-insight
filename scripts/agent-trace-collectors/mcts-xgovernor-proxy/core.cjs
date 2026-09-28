/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const { createHmac } = require("node:crypto");

const {
  atomicWriteJson,
  sha256,
  stableSpanId,
  stableTraceId,
} = require("../shared/trace-transport.cjs");

const FRAMEWORK = "mcts-xgovernor";
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function text(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function runKeyFromClientId(clientId) {
  return `run.${sha256(String(clientId || "unknown")).slice(0, 32)}`;
}

function runtimeKey(runtimeId) {
  return `runtime.${sha256(String(runtimeId || "unknown")).slice(0, 40)}`;
}

function checkpointKey(runKey, checkpointId) {
  return createHmac("sha256", runKey).update(String(checkpointId)).digest("hex");
}

function parseProfileSignature(body) {
  const ext = object(body?.ext);
  const namespace = object(ext.runtime_pi).profile_id !== undefined || ext.runtime_pi
    ? "runtime_pi"
    : ext.xiaoo ? "xiaoo" : undefined;
  const profile = object(namespace ? ext[namespace] : undefined);
  const maxTurns = Number(profile.max_turns);
  return {
    namespace,
    profileId: text(profile.profile_id) || text(profile.id),
    toolsEnabled: typeof profile.tools_enabled === "boolean" ? profile.tools_enabled : undefined,
    maxTurns: Number.isFinite(maxTurns) ? maxTurns : undefined,
    systemPromptHash: text(profile.system_prompt)
      ? `sha256:${sha256(profile.system_prompt)}`
      : undefined,
  };
}

function roleFor(runtime) {
  if (runtime.openType === "load" && runtime.hasTurn) return "solver-child";
  if (runtime.profile.toolsEnabled === false && runtime.profile.maxTurns === 1) return "memory-helper";
  if (runtime.profile.toolsEnabled === false && runtime.profile.maxTurns === 2) return "selector";
  if (runtime.fileReads > 0 && runtime.openType === "open" && runtime.hasTurn && !runtime.hasCheckpoint) return "author";
  if (runtime.openType === "open" && runtime.hasTurn && runtime.hasCheckpoint) return "solver-initial";
  return "unknown";
}

function usageOf(event) {
  const usage = object(event?.usage);
  const input = Number(usage.input_tokens ?? usage.prompt_tokens) || 0;
  const output = Number(usage.output_tokens ?? usage.completion_tokens) || 0;
  const reasoning = Number(usage.reasoning_tokens) || 0;
  return { input, output, reasoning, total: Number(usage.total_tokens) || input + output + reasoning };
}

function modelOf(body) {
  const llm = object(body?.llm);
  return text(llm.model) || text(llm.model_id);
}

function appendBounded(current, delta, maximum) {
  const next = `${current || ""}${delta || ""}`;
  if (next.length <= maximum) return { value: next, truncated: false };
  return { value: next.slice(0, maximum), truncated: true };
}

class MctsStdoutParser {
  parse(rawLine) {
    const line = String(rawLine || "").replace(ANSI_RE, "").trimEnd();
    let match = /^▶\s+startup(?:\s+(.*))?$/.exec(line);
    if (match) return { type: "startup", fields: this.fields(match[1]) };
    match = /^▶\s+choose\s+iter=(\d+)\s+node=(\S+)\s*$/.exec(line);
    if (match) return { type: "choose", iteration: Number(match[1]), node: match[2] };
    match = /^\s*(root(?:\/c\d+)*)\s+score=(-?\d+(?:\.\d+)?)\s+timing=(before|after)(?:\s+testcases=v(\d+))?\s*$/.exec(line);
    if (match) return { type: "node-score", node: match[1], score: Number(match[2]), timing: match[3], testcasesVersion: match[4] ? Number(match[4]) : undefined };
    match = /^▶\s+final tree\s+(root)\s+visits=(\d+)\s+value=(-?\d+(?:\.\d+)?)\s*$/.exec(line);
    if (match) return { type: "tree-node", final: true, node: match[1], visits: Number(match[2]), value: Number(match[3]) };
    match = /^[\s│]*(?:├──|└──)\s+(root(?:\/c\d+)*)\s+visits=(\d+)\s+value=(-?\d+(?:\.\d+)?)\s*$/.exec(line);
    if (match) return { type: "tree-node", final: false, node: match[1], visits: Number(match[2]), value: Number(match[3]) };
    match = /^OFFICIAL TEST (PASS|FAIL)\s+node=(\S+)\s*$/.exec(line);
    if (match) return { type: "official-result", passed: match[1] === "PASS", node: match[2] };
    return undefined;
  }

  fields(raw) {
    const result = {};
    for (const pair of String(raw || "").split(/\s+/)) {
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const key = pair.slice(0, separator);
      if (["mode", "task"].includes(key)) result[key] = pair.slice(separator + 1);
    }
    return result;
  }
}

class MctsProxyCore {
  constructor(options) {
    this.writer = options.writer;
    this.collaborationOutbox = options.collaborationOutbox;
    this.now = options.now || Date.now;
    this.captureReasoning = options.captureReasoning === true;
    this.statePath = options.statePath;
    this.maxQueuedObservations = Number.isSafeInteger(options.maxQueuedObservations)
      ? options.maxQueuedObservations
      : 10_000;
    this.maxTextChars = Number.isSafeInteger(options.maxTextChars) ? options.maxTextChars : 1_000_000;
    this.runs = new Map();
    this.requests = new Map();
    this.stdout = new MctsStdoutParser();
    this.pendingStdout = [];
    this.pending = Promise.resolve();
    this.background = Promise.resolve();
    this.queuedObservations = 0;
    this.droppedObservations = 0;
  }

  queue(operation) {
    this.queuedObservations += 1;
    this.pending = this.pending
      .then(operation)
      .catch(() => undefined)
      .finally(() => { this.queuedObservations -= 1; });
    return this.pending;
  }

  observeRequest(request) {
    return this.queue(() => this.onRequest(request));
  }

  observeResponse(response) {
    return this.queue(() => this.onResponse(response));
  }

  observeSse(message) {
    const kind = text(object(message.event).kind);
    const priority = kind === "turn_completed" || kind === "turn_failed";
    if (!priority && this.queuedObservations >= this.maxQueuedObservations) {
      this.droppedObservations += 1;
      return Promise.resolve(undefined);
    }
    return this.queue(() => this.onSse(message));
  }

  observeStdoutLine(line) {
    const parsed = this.stdout.parse(line);
    if (!parsed) return Promise.resolve(undefined);
    return this.queue(async () => {
      const run = [...this.runs.values()].at(-1);
      if (!run) this.pendingStdout.push(parsed);
      else await this.emitStdout(run, parsed);
      return parsed;
    });
  }

  backgroundTask(operation) {
    this.background = this.background.then(operation).catch(() => undefined);
  }

  ensureRun(clientId, startedAt) {
    const runKey = runKeyFromClientId(clientId);
    let run = this.runs.get(runKey);
    if (run) return run;
    const sessionId = `mcts.${runKey}`;
    run = {
      runKey,
      clientIdHash: `sha256:${sha256(clientId)}`,
      sessionId,
      collaborationId: `mcts.${sha256(clientId).slice(0, 48)}`,
      startedAt,
      updatedAt: startedAt,
      runtimes: new Map(),
      checkpoints: new Map(),
      taskEdges: new Map(),
      summaryCount: 0,
      boundRuntimeCount: 0,
      projectionTruncated: false,
      stdout: [],
    };
    this.runs.set(runKey, run);
    void this.emitAgent(run, undefined);
    this.backgroundTask(() => this.collaborationOutbox?.enqueueSession({
      collaborationId: run.collaborationId,
      sessionId: "coordinator",
      traceSessionId: run.sessionId,
      eventClock: "source_session",
    }));
    const pending = this.pendingStdout.splice(0);
    for (const event of pending) void this.emitStdout(run, event);
    return run;
  }

  ensureRuntime(run, runtimeId, attributes = {}) {
    const key = runtimeKey(runtimeId);
    let runtime = run.runtimes.get(key);
    if (!runtime) {
      runtime = {
        key,
        sessionId: `mcts.${run.runKey}.${key}`,
        startedAt: attributes.startedAt || this.now(),
        updatedAt: attributes.startedAt || this.now(),
        openType: attributes.openType || "unknown",
        profile: {},
        turns: new Map(),
        fileReads: 0,
        hasTurn: false,
        hasCheckpoint: false,
        closed: false,
      };
      run.runtimes.set(key, runtime);
    }
    Object.assign(runtime, attributes);
    runtime.updatedAt = Math.max(runtime.updatedAt, attributes.updatedAt || this.now());
    return runtime;
  }

  activateRuntime(run, runtime) {
    if (runtime.bindingQueued) return true;
    if (run.boundRuntimeCount >= 180) {
      run.projectionTruncated = true;
      return false;
    }
    runtime.bindingQueued = true;
    run.boundRuntimeCount += 1;
    this.backgroundTask(() => this.collaborationOutbox?.enqueueSession({
      collaborationId: run.collaborationId,
      sessionId: runtime.key,
      traceSessionId: runtime.sessionId,
      eventClock: "source_session",
    }));
    return true;
  }

  async onRequest(request) {
    const body = object(request.body);
    const clientId = text(object(body.lease).client_id);
    if (!clientId) return;
    const run = this.ensureRun(clientId, request.startedAt || this.now());
    const path = String(request.path || "");
    const operation = path.replace(/^.*\/api\/v1\/sessions\//, "");
    const runtimeId = text(body.runtime_id);
    const context = { runKey: run.runKey, operation, runtimeId, body, startedAt: request.startedAt || this.now() };
    this.requests.set(request.id, context);

    if ((operation === "open" || operation === "load") && runtimeId) {
      if (operation === "open" && text(body.runtime_kind)) run.runtimeKind = body.runtime_kind;
      this.ensureRuntime(run, runtimeId, {
        openType: operation,
        parentCheckpointHash: operation === "load" && text(body.checkpoint_id)
          ? checkpointKey(run.runKey, body.checkpoint_id)
          : undefined,
        profile: parseProfileSignature(body),
        model: modelOf(body),
        runtimeKind: text(body.runtime_kind) || run.runtimeKind,
        startedAt: context.startedAt,
      });
    } else if (operation === "turns" && runtimeId) {
      const runtime = this.ensureRuntime(run, runtimeId);
      runtime.hasTurn = true;
      runtime.runtimeKind = runtime.runtimeKind || run.runtimeKind;
      runtime.profile = { ...runtime.profile, ...parseProfileSignature(body) };
      runtime.model = modelOf(body) || runtime.model;
      context.input = text(body.text);
      this.activateRuntime(run, runtime);
      await this.emitAgent(run, runtime);
      await this.maybeEmitParentEdge(run, runtime, context.startedAt);
    } else if (operation === "files/read" && runtimeId) {
      const runtime = this.ensureRuntime(run, runtimeId);
      runtime.fileReads += 1;
      if (runtime.hasTurn) {
        await this.emitAgent(run, runtime);
        await this.maybeEmitParentEdge(run, runtime, runtime.updatedAt);
      }
    } else if ((operation === "close" || operation === "cancel") && runtimeId) {
      const runtime = this.ensureRuntime(run, runtimeId);
      runtime.closed = true;
      if (runtime.hasTurn) await this.emitAgent(run, runtime);
    }
    await this.persist();
  }

  async onResponse(response) {
    const context = this.requests.get(response.id);
    if (!context) return;
    this.requests.delete(response.id);
    if (Number(response.status) < 200 || Number(response.status) >= 300) return;
    const run = this.runs.get(context.runKey);
    if (!run) return;
    const body = object(response.body);
    if (context.operation === "checkpoint" && context.runtimeId && text(body.checkpoint_id)) {
      const runtime = this.ensureRuntime(run, context.runtimeId);
      runtime.hasCheckpoint = true;
      runtime.updatedAt = response.endedAt || this.now();
      run.checkpoints.set(checkpointKey(run.runKey, body.checkpoint_id), runtime.key);
      if (runtime.hasTurn) {
        await this.emitAgent(run, runtime);
        await this.maybeEmitParentEdge(run, runtime, runtime.updatedAt);
      }
    } else if (context.operation === "turns" && context.runtimeId && text(body.turn_id)) {
      const runtime = this.ensureRuntime(run, context.runtimeId);
      const turnKey = `turn.${sha256(`${runtime.key}\0${body.turn_id}`).slice(0, 32)}`;
      runtime.turns.set(turnKey, {
        key: turnKey,
        turnIdHash: sha256(`${runtime.key}\0${body.turn_id}`),
        input: context.input,
        startedAt: context.startedAt,
        output: "",
        reasoning: "",
        sequences: new Set(),
        tools: new Map(),
        terminal: false,
      });
    }
    await this.persist();
  }

  findTurn(run, runtimeId, turnId) {
    const runtime = run.runtimes.get(runtimeKey(runtimeId));
    if (!runtime) return {};
    const turnKey = `turn.${sha256(`${runtime.key}\0${turnId}`).slice(0, 32)}`;
    return { runtime, turn: runtime.turns.get(turnKey) };
  }

  async onSse(message) {
    const event = object(message.event);
    if (text(event.runtime_id) && text(message.runtimeId) && event.runtime_id !== message.runtimeId) return;
    if (text(event.turn_id) && text(message.turnId) && event.turn_id !== message.turnId) return;
    const runtimeId = text(event.runtime_id) || text(message.runtimeId);
    const turnId = text(event.turn_id) || text(message.turnId);
    if (!runtimeId || !turnId) return;
    const run = [...this.runs.values()].find(candidate => candidate.runtimes.has(runtimeKey(runtimeId)));
    if (!run) return;
    const { runtime, turn } = this.findTurn(run, runtimeId, turnId);
    if (!runtime || !turn) return;
    const kind = text(event.kind);
    if (kind === "output_delta") {
      const sequence = event.sequence;
      const sequenceKey = sequence === undefined ? undefined : `${event.stream_id || "unknown"}:${sequence}`;
      if (sequenceKey && turn.sequences.has(sequenceKey)) return;
      if (sequenceKey) turn.sequences.add(sequenceKey);
      if (event.stream_id === "assistant") {
        const appended = appendBounded(turn.output, event.delta, this.maxTextChars);
        turn.output = appended.value;
        turn.degraded = turn.degraded || appended.truncated;
      } else if (event.stream_id === "thinking" && this.captureReasoning) {
        const appended = appendBounded(turn.reasoning, event.delta, this.maxTextChars);
        turn.reasoning = appended.value;
        turn.degraded = turn.degraded || appended.truncated;
      }
    } else if (kind === "extension" && event.namespace === "xiaoo" && object(event.payload).kind === "reasoning_delta" && this.captureReasoning) {
      const appended = appendBounded(turn.reasoning, object(event.payload).delta, this.maxTextChars);
      turn.reasoning = appended.value;
      turn.degraded = turn.degraded || appended.truncated;
    } else if (kind === "tool_activity") {
      const activityId = text(event.activity_id) || `activity-${turn.tools.size}`;
      const key = sha256(`${turn.key}\0${activityId}`).slice(0, 32);
      const previous = turn.tools.get(key) || { key, startedAt: message.receivedAt || this.now() };
      turn.tools.set(key, {
        ...previous,
        name: text(event.name) || previous.name || "tool",
        status: text(event.status) || previous.status,
        summary: event.phase === "end" ? text(event.summary) : previous.summary,
        endedAt: event.phase === "end" ? message.receivedAt || this.now() : previous.endedAt,
      });
      if (event.phase === "end") await this.emitTool(run, runtime, turn, turn.tools.get(key));
    } else if (kind === "interaction_requested") {
      turn.degraded = true;
      turn.error = "xGovernor requested unsupported interactive input";
    } else if (kind === "turn_completed" || kind === "turn_failed") {
      turn.terminal = true;
      turn.status = kind === "turn_failed" ? "error" : event.outcome === "cancelled" ? "error" : "success";
      turn.usage = usageOf(event);
      turn.endedAt = message.receivedAt || this.now();
      if (kind === "turn_failed") turn.error = JSON.stringify(object(event.error)).slice(0, 2_000);
      await this.emitTurn(run, runtime, turn);
      await this.emitAgent(run, runtime);
    }
    await this.persist();
  }

  async maybeEmitParentEdge(run, runtime, observedAt) {
    if (!runtime.bindingQueued) return;
    const parentKey = runtime.parentCheckpointHash
      ? run.checkpoints.get(runtime.parentCheckpointHash)
      : runtime.openType === "open" ? "coordinator" : undefined;
    if (!parentKey || parentKey === runtime.key) return;
    const edgeKey = `${parentKey}->${runtime.key}`;
    const parent = parentKey === "coordinator"
      ? { key: "coordinator", sessionId: run.sessionId }
      : run.runtimes.get(parentKey);
    if (!parent || (parentKey !== "coordinator" && !parent.bindingQueued)) return;
    const spanId = stableSpanId(`${run.runKey}\0${edgeKey}`);
    const role = roleFor(runtime);
    const previous = run.taskEdges.get(edgeKey);
    if (previous?.role === role) return;
    const edgeStartedAt = previous?.startedAt || observedAt;
    run.taskEdges.set(edgeKey, { role, startedAt: edgeStartedAt });
    await this.writer.append({
      sessionId: parent.sessionId,
      traceId: stableTraceId(FRAMEWORK, parent.sessionId),
      spanId,
      parentSpanId: stableSpanId(`${parent.sessionId}\0agent`),
      kind: "tool",
      name: "tool.task",
      status: "success",
      startTimeMs: edgeStartedAt,
      endTimeMs: edgeStartedAt,
      tool: {
        name: "task",
        type: "subagent",
        arguments: { session_id: runtime.key, subagent_type: role },
        result: { session_id: runtime.key },
      },
      attributes: { "mcts.synthetic": true, "mcts.child.session_id": runtime.key },
    });
    if (!previous) {
      await this.collaborationOutbox?.enqueueEvent({
        collaborationId: run.collaborationId,
        eventId: `edge.${sha256(edgeKey).slice(0, 40)}`,
        fromSessionId: parent.key,
        toSessionId: runtime.key,
        description: role === "unknown" ? "MCTS root runtime" : `MCTS ${role} runtime`,
        observedAt: new Date(edgeStartedAt).toISOString(),
        content: `evidence=${runtime.parentCheckpointHash ? "checkpoint-lineage" : "open-turn"}; role=${role}`,
        fromLocator: { recordType: "tool", name: "task" },
      });
    }
  }

  async emitAgent(run, runtime, terminal = false) {
    const sessionId = runtime?.sessionId || run.sessionId;
    const startedAt = runtime?.startedAt || run.startedAt;
    const endedAt = runtime?.updatedAt || run.updatedAt || startedAt;
    await this.writer.append({
      sessionId,
      traceId: stableTraceId(FRAMEWORK, sessionId),
      spanId: stableSpanId(`${sessionId}\0agent`),
      kind: "agent",
      name: runtime ? "agent.mcts.runtime" : "agent.mcts.coordinator",
      status: terminal && ((run.exitCode ?? 0) !== 0 || run.signal) ? "error" : "success",
      startTimeMs: startedAt,
      endTimeMs: Math.max(startedAt, endedAt),
      input: runtime ? undefined : run.stdout.find(item => item.type === "startup")?.fields,
      output: terminal ? { exit_code: run.exitCode, signal: run.signal } : undefined,
      attributes: {
        "agent.insight.trace.completed": terminal || runtime?.closed === true,
        "mcts.role": runtime ? roleFor(runtime) : "coordinator",
        "mcts.runtime.key": runtime?.key,
        "mcts.runtime.open_type": runtime?.openType,
        "mcts.runtime.kind": runtime?.runtimeKind || (runtime ? "unknown" : "synthetic"),
        "mcts.profile.id": runtime?.profile.profileId,
        "mcts.profile.namespace": runtime?.profile.namespace,
        "mcts.profile.tools_enabled": runtime?.profile.toolsEnabled,
        "mcts.profile.max_turns": runtime?.profile.maxTurns,
        "mcts.profile.system_prompt_hash": runtime?.profile.systemPromptHash,
        "mcts.run.client_id_hash": run.clientIdHash,
        "mcts.capture.mode": "reverse-proxy",
        "mcts.capture.fidelity": this.droppedObservations > 0 ? "degraded" : "xgovernor-sse",
        "mcts.runtime.relation": "checkpoint-lineage",
        "mcts.node.correlation": "unavailable",
        "mcts.internal.backprop": "unavailable",
        "mcts.memory_pool.events": "unavailable",
        "mcts.projection.truncated": run.projectionTruncated,
        "mcts.observer.dropped": this.droppedObservations,
      },
    });
  }

  async emitTurn(run, runtime, turn) {
    await this.writer.append({
      sessionId: runtime.sessionId,
      traceId: stableTraceId(FRAMEWORK, runtime.sessionId),
      spanId: stableSpanId(`${runtime.sessionId}\0${turn.key}`),
      parentSpanId: stableSpanId(`${runtime.sessionId}\0agent`),
      kind: "llm",
      name: "llm.xgovernor.turn",
      status: turn.status || "success",
      error: turn.error,
      startTimeMs: turn.startedAt,
      endTimeMs: turn.endedAt || this.now(),
      input: turn.input,
      output: turn.output,
      model: runtime.model,
      usage: turn.usage,
      attributes: {
        "mcts.role": roleFor(runtime),
        "mcts.capture.mode": "reverse-proxy",
        "mcts.capture.fidelity": turn.degraded || this.droppedObservations > 0 ? "degraded" : "xgovernor-sse",
        "mcts.turn.incomplete": turn.terminal !== true,
        ...(this.captureReasoning && turn.reasoning ? { "mcts.reasoning": turn.reasoning } : {}),
      },
    });
  }

  async emitTool(run, runtime, turn, tool) {
    await this.writer.append({
      sessionId: runtime.sessionId,
      traceId: stableTraceId(FRAMEWORK, runtime.sessionId),
      spanId: stableSpanId(`${runtime.sessionId}\0${turn.key}\0${tool.key}`),
      parentSpanId: stableSpanId(`${runtime.sessionId}\0${turn.key}`),
      kind: "tool",
      name: `tool.${tool.name}`,
      status: tool.status === "succeeded" ? "success" : "error",
      startTimeMs: tool.startedAt,
      endTimeMs: tool.endedAt || tool.startedAt,
      tool: { name: tool.name, type: "xgovernor", arguments: {}, result: tool.summary },
      attributes: { "mcts.role": roleFor(runtime) },
    });
  }

  async emitStdout(run, parsed) {
    run.stdout.push(parsed);
    run.updatedAt = this.now();
    if (parsed.type === "startup") await this.emitAgent(run, undefined);
    const index = run.summaryCount++;
    await this.writer.append({
      sessionId: run.sessionId,
      traceId: stableTraceId(FRAMEWORK, run.sessionId),
      spanId: stableSpanId(`${run.sessionId}\0summary\0${index}`),
      parentSpanId: stableSpanId(`${run.sessionId}\0agent`),
      kind: "tool",
      name: `mcts.summary.${parsed.type}`,
      status: parsed.type === "official-result" && !parsed.passed ? "error" : "success",
      startTimeMs: run.updatedAt,
      endTimeMs: run.updatedAt,
      tool: { name: `mcts.summary.${parsed.type}`, type: "stdout-summary", arguments: parsed, result: parsed },
      attributes: { "mcts.summary.unbound": true, "mcts.synthetic": true },
    });
  }

  async persist() {
    if (!this.statePath) return;
    const runs = [...this.runs.values()].map(run => ({
      runKey: run.runKey,
      clientIdHash: run.clientIdHash,
      sessionId: run.sessionId,
      collaborationId: run.collaborationId,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      checkpoints: [...run.checkpoints.entries()],
      taskEdges: [...run.taskEdges.entries()],
      runtimes: [...run.runtimes.values()].map(runtime => ({
        key: runtime.key,
        sessionId: runtime.sessionId,
        startedAt: runtime.startedAt,
        updatedAt: runtime.updatedAt,
        openType: runtime.openType,
        parentCheckpointHash: runtime.parentCheckpointHash,
        profile: runtime.profile,
        model: runtime.model,
        runtimeKind: runtime.runtimeKind,
        fileReads: runtime.fileReads,
        hasTurn: runtime.hasTurn,
        hasCheckpoint: runtime.hasCheckpoint,
        closed: runtime.closed,
        turns: [...runtime.turns.values()].map(turn => ({
          key: turn.key,
          turnIdHash: turn.turnIdHash,
          startedAt: turn.startedAt,
          endedAt: turn.endedAt,
          terminal: turn.terminal,
          status: turn.status,
          usage: turn.usage,
          tools: [...turn.tools.values()].map(tool => ({
            key: tool.key,
            name: tool.name,
            status: tool.status,
            startedAt: tool.startedAt,
            endedAt: tool.endedAt,
          })),
        })),
      })),
    }));
    await atomicWriteJson(this.statePath, { version: 1, runs });
  }

  async finish(exitCode, signal) {
    return this.queue(async () => {
      const endedAt = this.now();
      for (const run of this.runs.values()) {
        run.updatedAt = endedAt;
        run.exitCode = exitCode;
        run.signal = signal;
        for (const runtime of run.runtimes.values()) {
          if (!runtime.hasTurn) continue;
          runtime.updatedAt = endedAt;
          for (const turn of runtime.turns.values()) {
            if (turn.terminal) continue;
            turn.status = "error";
            turn.error = turn.error || "xGovernor turn ended without a terminal event";
            turn.degraded = true;
            turn.endedAt = endedAt;
            await this.emitTurn(run, runtime, turn);
          }
          await this.emitAgent(run, runtime, true);
        }
        await this.emitAgent(run, undefined, true);
      }
      await this.background;
      await this.persist();
      await this.writer.flush?.();
    });
  }
}

module.exports = {
  FRAMEWORK,
  checkpointKey,
  MctsProxyCore,
  MctsStdoutParser,
  parseProfileSignature,
  roleFor,
  runKeyFromClientId,
  runtimeKey,
};
