/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const {
  sha256,
  stableEventId,
  stableSpanId,
  stableTraceId,
} = require("../shared/trace-transport.cjs");

const HOOK_EVENTS = Object.freeze([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "PermissionRequest",
  "Stop",
]);

const MATCHER_EVENTS = new Set([
  "SessionStart",
  "SessionEnd",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "PermissionRequest",
]);

const IDE_ORIGINATORS = /(?:vscode|cursor|windsurf|ide)/i;
const SKILL_PROMPT_PATTERN = /(?:^|\s)(?:\/skill:|\$)([a-z0-9][a-z0-9._-]*)\b/i;
const SKILL_PATH_PATTERN = /(?:^|[\\/])skills[\\/]([^\\/]+)[\\/]SKILL\.md$/i;

function asString(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function asNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstDefined(source, keys) {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

function classifyTool(name) {
  const raw = String(name || "tool");
  const normalized = raw.toLowerCase();
  if (/^mcp__[^_]+__.+/.test(normalized)) return "mcp";
  if (["bash", "shellcommand", "exec_command", "write_stdin", "terminal"].includes(normalized)) {
    return "shell";
  }
  if (["apply_patch", "edit", "write", "fileedit"].includes(normalized)) {
    return normalized === "fileedit" ? "file_edit" : "apply_patch";
  }
  if (/search|grep|find|read_file|filesearch/.test(normalized)) return "file_search";
  if (/code.?interpreter/.test(normalized)) return "code_interpreter";
  if (["agent", "spawn_agent", "subagent"].includes(normalized)) return "subagent_tool";
  return "custom";
}

function parseMcpIdentity(name, metadata = {}) {
  const match = /^mcp__([^_]+)__(.+)$/i.exec(String(name || ""));
  const serverName = asString(
    metadata.serverName ||
    metadata.server_name ||
    metadata.mcpServer ||
    metadata["mcp.server.name"],
  ) || match?.[1];
  const metadataToolName = asString(
    metadata.toolName ||
    metadata.tool_name ||
    metadata["mcp.tool.name"],
  );
  const toolName = metadataToolName && !/^mcp__/i.test(metadataToolName)
    ? metadataToolName
    : match?.[2] || metadataToolName;
  return serverName && toolName ? { serverName, toolName } : undefined;
}

function skillFromPrompt(prompt) {
  const match = SKILL_PROMPT_PATTERN.exec(String(prompt || ""));
  return match ? { name: match[1], triggerMode: "explicit" } : undefined;
}

function collectStrings(value, result = [], seen = new WeakSet()) {
  if (typeof value === "string") {
    result.push(value);
    return result;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return result;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, result, seen);
  } else {
    for (const item of Object.values(value)) collectStrings(item, result, seen);
  }
  seen.delete(value);
  return result;
}

function skillPathFromToolInput(input) {
  for (const candidate of collectStrings(input)) {
    const normalized = candidate.replace(/[?#].*$/, "");
    const match = SKILL_PATH_PATTERN.exec(normalized);
    if (match) return { name: match[1], filePath: candidate };
  }
  return undefined;
}

async function skillVersion(filePath) {
  try {
    const source = await fs.readFile(filePath, "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] || "";
    const version = /^\s*version\s*:\s*["']?([^"'#\r\n]+)["']?\s*$/im.exec(frontmatter)?.[1]?.trim();
    return version || sha256(source).slice(0, 12);
  } catch {
    return undefined;
  }
}

function anyValueToJs(value) {
  if (!value || typeof value !== "object") return value;
  if ("stringValue" in value) return value.stringValue;
  if ("boolValue" in value) return Boolean(value.boolValue);
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("bytesValue" in value) return value.bytesValue;
  if (value.arrayValue?.values) return value.arrayValue.values.map(anyValueToJs);
  if (value.kvlistValue?.values) {
    return Object.fromEntries(
      value.kvlistValue.values.map((item) => [item.key, anyValueToJs(item.value)]),
    );
  }
  return value;
}

function attributesToObject(attributes) {
  if (!attributes) return {};
  if (!Array.isArray(attributes)) return { ...attributes };
  return Object.fromEntries(
    attributes
      .filter((item) => item && typeof item.key === "string")
      .map((item) => [item.key, anyValueToJs(item.value)]),
  );
}

function bodyToObject(body) {
  const value = anyValueToJs(body);
  if (typeof value !== "string") return value && typeof value === "object" ? value : {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : { message: value };
  } catch {
    return { message: value };
  }
}

function unixNanoToMs(value) {
  if (value === undefined || value === null || value === "") return undefined;
  try {
    return Number(BigInt(String(value)) / 1_000_000n);
  } catch {
    return undefined;
  }
}

function extractOtlpLogRecords(payload) {
  const records = [];
  for (const resourceLog of payload?.resourceLogs || []) {
    const resource = attributesToObject(resourceLog.resource?.attributes);
    for (const scopeLog of resourceLog.scopeLogs || resourceLog.instrumentationLibraryLogs || []) {
      const scope = {
        name: scopeLog.scope?.name || scopeLog.instrumentationLibrary?.name,
        version: scopeLog.scope?.version || scopeLog.instrumentationLibrary?.version,
      };
      for (const logRecord of scopeLog.logRecords || []) {
        const body = bodyToObject(logRecord.body);
        const attributes = {
          ...resource,
          ...attributesToObject(logRecord.attributes),
          ...body,
        };
        const eventName = asString(firstDefined(attributes, [
          "event.name",
          "event_name",
          "name",
          "eventName",
        ])) || (
          typeof body.message === "string" && body.message.startsWith("codex.")
            ? body.message
            : undefined
        );
        records.push({
          eventName,
          attributes,
          resource,
          scope,
          timestampMs: unixNanoToMs(logRecord.timeUnixNano || logRecord.observedTimeUnixNano) ||
            Date.now(),
          severity: logRecord.severityText,
        });
      }
    }
  }
  return records;
}

function normalizeHookInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Codex Hook input must be a JSON object");
  }
  const eventName = asString(input.hook_event_name);
  const sessionId = asString(input.session_id);
  if (!eventName || !HOOK_EVENTS.includes(eventName)) {
    throw new Error(`Unsupported Codex Hook event: ${eventName || "<missing>"}`);
  }
  if (!sessionId) throw new Error("Codex Hook input is missing session_id");
  return {
    ...input,
    hook_event_name: eventName,
    session_id: sessionId,
  };
}

function normalizePath(value) {
  if (!value) return "";
  const resolved = path.resolve(String(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathsOverlap(left, right) {
  const a = normalizePath(left);
  const b = normalizePath(right);
  if (!a || !b) return false;
  const withSeparator = (value) => value.endsWith(path.sep) ? value : `${value}${path.sep}`;
  return a === b || withSeparator(a).startsWith(withSeparator(b)) ||
    withSeparator(b).startsWith(withSeparator(a));
}

function eventBase(session, overrides) {
  return {
    framework: "codex",
    sessionId: session.sessionId,
    traceId: session.traceId,
    startTimeMs: overrides.startTimeMs,
    endTimeMs: overrides.endTimeMs ?? overrides.startTimeMs,
    ...overrides,
  };
}

class CodexTraceCore {
  constructor(options = {}) {
    if (!options.writer || typeof options.writer.append !== "function") {
      throw new Error("CodexTraceCore requires a durable writer");
    }
    this.writer = options.writer;
    this.now = options.now || Date.now;
    this.sessions = new Map();
    this.unattributed = 0;
    this.leases = new Map();
  }

  ensureSession(sessionId, metadata = {}) {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const startedAt = metadata.timestampMs || this.now();
      session = {
        sessionId,
        traceId: stableTraceId("codex", sessionId),
        rootSpanId: stableSpanId(sessionId, "root"),
        startedAt,
        updatedAt: startedAt,
        cwd: metadata.cwd,
        model: metadata.model,
        originator: metadata.originator,
        terminalType: metadata.terminalType,
        input: undefined,
        output: undefined,
        closed: false,
        turns: new Map(),
        agents: new Map(),
        tools: new Map(),
        skills: new Map(),
        ttftByTurn: new Map(),
        sequence: 0,
      };
      this.sessions.set(sessionId, session);
    }
    session.cwd = metadata.cwd || session.cwd;
    session.model = metadata.model || session.model;
    session.originator = metadata.originator || session.originator;
    session.terminalType = metadata.terminalType || session.terminalType;
    session.updatedAt = metadata.timestampMs || this.now();
    return session;
  }

  turnFor(session, turnId, create = false, metadata = {}) {
    let resolvedId = asString(turnId);
    if (!resolvedId) {
      const active = [...session.turns.values()].filter((turn) => !turn.closed);
      if (active.length === 1) return active[0];
      if (!create) return undefined;
      resolvedId = stableEventId(session.sessionId, "turn", metadata.timestampMs || this.now());
    }
    let turn = session.turns.get(resolvedId);
    if (!turn && create) {
      const startedAt = metadata.timestampMs || this.now();
      turn = {
        turnId: resolvedId,
        spanId: stableSpanId(session.sessionId, resolvedId, "turn"),
        startedAt,
        updatedAt: startedAt,
        input: metadata.input,
        output: undefined,
        closed: false,
        activeAgentId: "root",
        activeSkillSpanId: undefined,
        llmSequence: 0,
      };
      session.turns.set(resolvedId, turn);
    }
    return turn;
  }

  async emitRoot(session, timestampMs, status = "ok") {
    return this.writer.append(eventBase(session, {
      eventId: stableEventId("codex", session.sessionId, "root"),
      spanId: session.rootSpanId,
      kind: "agent",
      name: "agent.codex",
      startTimeMs: session.startedAt,
      endTimeMs: timestampMs,
      input: session.input,
      output: session.output,
      model: session.model,
      status,
      attributes: {
        "codex.agent.id": "root",
        "codex.agent.name": "codex",
        "codex.originator": session.originator,
        "codex.terminal.type": session.terminalType,
        "codex.cwd": session.cwd,
      },
    }));
  }

  async emitSkill(session, turn, skill, timestampMs) {
    const key = `${turn.turnId}:${skill.name}`;
    let stored = session.skills.get(key);
    if (!stored) {
      stored = {
        ...skill,
        spanId: stableSpanId(session.sessionId, turn.turnId, "skill", skill.name),
        startedAt: timestampMs,
      };
      session.skills.set(key, stored);
    } else {
      stored = { ...stored, ...skill };
      session.skills.set(key, stored);
    }
    turn.activeSkillSpanId = stored.spanId;
    await this.writer.append(eventBase(session, {
      eventId: stableEventId("codex", session.sessionId, turn.turnId, "skill", skill.name),
      spanId: stored.spanId,
      parentSpanId: session.rootSpanId,
      kind: "skill",
      name: `skill.${skill.name}`,
      startTimeMs: stored.startedAt,
      endTimeMs: timestampMs,
      input: turn.input,
      skill: {
        name: skill.name,
        version: skill.version,
        triggerMode: skill.triggerMode,
      },
      attributes: {
        "codex.turn.id": turn.turnId,
      },
    }));
    return stored;
  }

  toolParent(session, turn) {
    if (!turn) return session.rootSpanId;
    if (turn.activeSkillSpanId) return turn.activeSkillSpanId;
    const agent = session.agents.get(turn.activeAgentId);
    return agent?.spanId || session.rootSpanId;
  }

  async emitTool(session, turn, tool, timestampMs) {
    const mcp = parseMcpIdentity(tool.name, tool.metadata);
    const status = tool.isError || tool.success === false ? "error" : "ok";
    return this.writer.append(eventBase(session, {
      eventId: stableEventId("codex", session.sessionId, "tool", tool.callId),
      spanId: tool.spanId,
      parentSpanId: tool.parentSpanId || this.toolParent(session, turn),
      kind: mcp ? "mcp" : "tool",
      name: `tool.${tool.name || "unknown"}`,
      startTimeMs: tool.startedAt || timestampMs,
      endTimeMs: timestampMs,
      status,
      error: tool.error,
      tool: {
        name: tool.name || "unknown",
        type: mcp ? "mcp" : classifyTool(tool.name),
        arguments: tool.input,
        result: tool.output,
      },
      mcp,
      attributes: {
        "codex.turn.id": turn?.turnId,
        "codex.call.id": tool.callId,
        "codex.tool.exit_code": tool.exitCode,
        "codex.tool.source": tool.source || "hook",
        "codex.cloud.agent_id": tool.cloudAgentId,
        "codex.cloud.task_id": tool.cloudTaskId,
        "codex.cloud.id_source": tool.cloudIdSource,
      },
    }));
  }

  async processHook(rawInput) {
    const input = normalizeHookInput(rawInput);
    const timestampMs = asNumber(input.timestamp_ms) || this.now();
    const session = this.ensureSession(input.session_id, {
      timestampMs,
      cwd: asString(input.cwd),
      model: asString(input.model),
    });
    const eventName = input.hook_event_name;
    let flush = false;

    if (eventName === "SessionStart") {
      await this.emitRoot(session, timestampMs);
    } else if (eventName === "UserPromptSubmit") {
      const prompt = asString(input.prompt || input.user_prompt || input.message) || "";
      const turn = this.turnFor(session, input.turn_id, true, {
        timestampMs,
        input: prompt,
      });
      turn.input = prompt;
      turn.updatedAt = timestampMs;
      session.input = prompt || session.input;
      const explicitSkill = skillFromPrompt(prompt);
      if (explicitSkill) await this.emitSkill(session, turn, explicitSkill, timestampMs);
      await this.emitRoot(session, timestampMs);
    } else if (eventName === "PreToolUse" || eventName === "PostToolUse") {
      const turn = this.turnFor(session, input.turn_id, true, { timestampMs });
      const name = asString(input.tool_name || input.tool?.name) || "unknown";
      const callId = asString(
        input.tool_use_id ||
        input.call_id ||
        input.tool_call_id ||
        input.tool?.id,
      ) || stableEventId(session.sessionId, turn.turnId, name, timestampMs);
      let tool = session.tools.get(callId);
      if (!tool) {
        tool = {
          callId,
          name,
          spanId: stableSpanId(session.sessionId, "tool", callId),
          parentSpanId: this.toolParent(session, turn),
          startedAt: timestampMs,
          input: input.tool_input || input.arguments || input.tool?.input,
          metadata: input.metadata || input.tool?.metadata || {},
          source: "hook",
        };
        session.tools.set(callId, tool);
      }
      tool.name = name || tool.name;
      tool.input = input.tool_input || input.arguments || tool.input;
      tool.metadata = { ...tool.metadata, ...(input.metadata || input.tool?.metadata || {}) };

      if (eventName === "PreToolUse") {
        const detected = skillPathFromToolInput(tool.input);
        if (detected) {
          detected.triggerMode = "automatic";
          detected.version = await skillVersion(detected.filePath);
          await this.emitSkill(session, turn, detected, timestampMs);
          tool.parentSpanId = turn.activeSkillSpanId;
        }
      } else {
        tool.output = input.tool_response ?? input.tool_result ?? input.result ?? input.output;
        tool.isError = Boolean(input.is_error || input.error);
        tool.error = asString(input.error?.message || input.error);
        tool.exitCode = asNumber(input.exit_code ?? input.tool_response?.exit_code);
        await this.emitTool(session, turn, tool, timestampMs);
      }
    } else if (eventName === "SubagentStart" || eventName === "SubagentStop") {
      const turn = this.turnFor(session, input.turn_id, true, { timestampMs });
      const agentId = asString(input.agent_id || input.subagent_id) ||
        stableEventId(session.sessionId, "subagent", timestampMs);
      let agent = session.agents.get(agentId);
      if (!agent) {
        const parentId = asString(input.parent_agent_id) || turn.activeAgentId || "root";
        const parent = session.agents.get(parentId);
        agent = {
          agentId,
          parentId,
          name: asString(input.agent_type || input.subagent_type) || "subagent",
          spanId: stableSpanId(session.sessionId, "agent", agentId),
          parentSpanId: parent?.spanId || session.rootSpanId,
          startedAt: timestampMs,
          input: input.prompt || input.task || input.description,
        };
        session.agents.set(agentId, agent);
      }
      if (eventName === "SubagentStart") {
        turn.activeAgentId = agentId;
      } else {
        agent.output = input.last_assistant_message || input.result || input.output;
        agent.error = asString(input.error?.message || input.error);
        turn.activeAgentId = agent.parentId || "root";
      }
      await this.writer.append(eventBase(session, {
        eventId: stableEventId("codex", session.sessionId, "agent", agentId),
        spanId: agent.spanId,
        parentSpanId: agent.parentSpanId,
        kind: "subagent",
        name: `agent.${agent.name}`,
        startTimeMs: agent.startedAt,
        endTimeMs: timestampMs,
        input: agent.input,
        output: agent.output,
        status: agent.error ? "error" : "ok",
        error: agent.error,
        model: session.model,
        attributes: {
          "codex.turn.id": turn.turnId,
          "codex.agent.id": agent.agentId,
          "codex.agent.name": agent.name,
          "codex.agent.parent_id": agent.parentId,
          "codex.agent.parent_source": input.parent_agent_id
            ? "hook"
            : "current_active_agent",
        },
      }));
    } else if (eventName === "Stop") {
      const turn = this.turnFor(session, input.turn_id, false);
      const output = input.last_assistant_message || input.result || input.output;
      if (turn) {
        turn.output = output;
        turn.closed = true;
        turn.updatedAt = timestampMs;
      }
      session.output = output || session.output;
      await this.emitRoot(session, timestampMs, input.error ? "error" : "ok");
      flush = true;
    } else if (eventName === "SessionEnd") {
      for (const turn of session.turns.values()) turn.closed = true;
      session.closed = true;
      session.output = input.last_assistant_message || input.result || session.output;
      await this.emitRoot(session, timestampMs, input.error ? "error" : "ok");
      flush = true;
    } else {
      const turn = this.turnFor(session, input.turn_id, false);
      await this.writer.append(eventBase(session, {
        eventId: stableEventId(
          "codex",
          session.sessionId,
          eventName,
          turn?.turnId,
          timestampMs,
        ),
        spanId: stableSpanId(
          session.sessionId,
          "lifecycle",
          eventName,
          turn?.turnId,
          timestampMs,
        ),
        parentSpanId: turn ? this.toolParent(session, turn) : session.rootSpanId,
        kind: "lifecycle",
        name: `lifecycle.${eventName}`,
        startTimeMs: timestampMs,
        attributes: {
          "codex.turn.id": turn?.turnId,
          "codex.hook.event": eventName,
          "codex.permission.mode": input.permission_mode,
        },
      }));
    }
    return { eventName, sessionId: session.sessionId, flush };
  }

  async processOtel(payload) {
    const results = [];
    for (const record of extractOtlpLogRecords(payload)) {
      if (!record.eventName?.startsWith("codex.")) continue;
      const attrs = record.attributes;
      const sessionId = asString(firstDefined(attrs, [
        "conversation.id",
        "conversation_id",
        "session.id",
      ]));
      if (!sessionId) continue;
      const session = this.ensureSession(sessionId, {
        timestampMs: record.timestampMs,
        cwd: asString(firstDefined(attrs, ["cwd", "codex.cwd"])),
        model: asString(firstDefined(attrs, ["model", "gen_ai.request.model"])),
        originator: asString(firstDefined(attrs, ["originator", "codex.originator"])),
        terminalType: asString(firstDefined(attrs, ["terminal.type", "terminal_type"])),
      });
      const turnId = asString(firstDefined(attrs, ["turn.id", "turn_id", "codex.turn.id"]));
      const turn = this.turnFor(session, turnId, false) ||
        this.turnFor(session, undefined, false);
      const cloudAgentId = asString(firstDefined(attrs, ["auth.agent_id", "auth.agent.id"]));
      const cloudTaskId = asString(firstDefined(attrs, ["auth.task_id", "auth.task.id"]));

      if (record.eventName === "codex.conversation_starts") {
        await this.emitRoot(session, record.timestampMs);
      } else if (record.eventName === "codex.user_prompt") {
        const promptLength = asNumber(firstDefined(attrs, [
          "prompt_length",
          "prompt.length",
          "length",
        ]));
        const prompt = asString(firstDefined(attrs, ["prompt", "user_prompt"])) ||
          (promptLength === undefined ? undefined : `[REDACTED prompt length=${promptLength}]`);
        const promptTurn = turn || this.turnFor(session, turnId, true, {
          timestampMs: record.timestampMs,
          input: prompt,
        });
        promptTurn.input = prompt || promptTurn.input;
        session.input ||= prompt;
        await this.emitRoot(session, record.timestampMs);
      } else if (record.eventName === "codex.turn_ttft") {
        if (turn) {
          const ttft = asNumber(firstDefined(attrs, [
            "duration_ms",
            "ttft_ms",
            "turn_ttft_ms",
          ]));
          if (ttft !== undefined) session.ttftByTurn.set(turn.turnId, ttft);
        }
      } else if (record.eventName === "codex.sse_event") {
        const sseKind = asString(firstDefined(attrs, [
          "event.kind",
          "sse.event.kind",
          "kind",
          "type",
        ]));
        if (sseKind === "response.completed") {
          const resolvedTurn = turn || this.turnFor(session, turnId, true, {
            timestampMs: record.timestampMs,
          });
          resolvedTurn.llmSequence += 1;
          const inputTokens = asNumber(firstDefined(attrs, [
            "input_token_count",
            "input_tokens",
            "gen_ai.usage.input_tokens",
          ])) || 0;
          const outputTokens = asNumber(firstDefined(attrs, [
            "output_token_count",
            "output_tokens",
            "gen_ai.usage.output_tokens",
          ])) || 0;
          const reasoningTokens = asNumber(firstDefined(attrs, [
            "reasoning_token_count",
            "reasoning_tokens",
            "gen_ai.usage.reasoning_tokens",
          ])) || 0;
          if (outputTokens === 0 && reasoningTokens === 0) continue;
          const cacheTokens = asNumber(firstDefined(attrs, [
            "cached_input_token_count",
            "cached_token_count",
            "cache_read_token_count",
            "cached_tokens",
          ])) || 0;
          const total = asNumber(firstDefined(attrs, [
            "total_token_count",
            "total_tokens",
            "gen_ai.usage.total_tokens",
          ])) || inputTokens + outputTokens;
          const responseId = asString(firstDefined(attrs, [
            "response.id",
            "response_id",
          ])) || resolvedTurn.llmSequence;
          const spanId = stableSpanId(
            session.sessionId,
            resolvedTurn.turnId,
            "llm",
            responseId,
          );
          const ttftMs = asNumber(firstDefined(attrs, [
            "ttft_ms",
            "turn_ttft_ms",
          ])) ?? session.ttftByTurn.get(resolvedTurn.turnId);
          await this.writer.append(eventBase(session, {
            eventId: stableEventId("codex", session.sessionId, "llm", responseId),
            spanId,
            parentSpanId: resolvedTurn.activeSkillSpanId || session.rootSpanId,
            kind: "llm",
            name: `llm.${session.model || "codex"}`,
            startTimeMs: record.timestampMs -
              (asNumber(firstDefined(attrs, ["duration_ms", "duration.ms"])) || 0),
            endTimeMs: record.timestampMs,
            model: session.model,
            provider: asString(firstDefined(attrs, ["provider", "model_provider"])) || "openai",
            output: firstDefined(attrs, ["response.output_text", "output"]),
            usage: {
              input: inputTokens,
              output: outputTokens,
              reasoning: reasoningTokens,
              total,
            },
            attributes: {
              "codex.turn.id": resolvedTurn.turnId,
              "codex.ttft_ms": ttftMs,
              "codex.usage.cache_read": cacheTokens,
              "codex.cloud.agent_id": cloudAgentId,
              "codex.cloud.task_id": cloudTaskId,
              "codex.cloud.id_source": cloudAgentId || cloudTaskId ? "otel" : undefined,
              "codex.originator": session.originator,
            },
          }));
        }
      } else if (record.eventName === "codex.tool_result") {
        const resolvedTurn = turn || this.turnFor(session, turnId, true, {
          timestampMs: record.timestampMs,
        });
        const name = asString(firstDefined(attrs, [
          "tool.name",
          "tool_name",
          "name",
        ])) || "unknown";
        const callId = asString(firstDefined(attrs, [
          "call_id",
          "tool.call_id",
          "tool_use_id",
        ])) || stableEventId(session.sessionId, resolvedTurn.turnId, name, record.timestampMs);
        let tool = session.tools.get(callId);
        if (!tool) {
          tool = {
            callId,
            name,
            spanId: stableSpanId(session.sessionId, "tool", callId),
            parentSpanId: this.toolParent(session, resolvedTurn),
            startedAt: record.timestampMs -
              (asNumber(firstDefined(attrs, ["duration_ms", "duration.ms"])) || 0),
            source: "otel",
          };
          session.tools.set(callId, tool);
        }
        tool.name = name || tool.name;
        tool.output = firstDefined(attrs, ["output", "tool.output", "result", "output_snippet"]) ??
          tool.output;
        tool.success = firstDefined(attrs, ["success", "tool.success"]) ?? tool.success;
        tool.error = asString(firstDefined(attrs, ["error.message", "error"]));
        tool.metadata = { ...tool.metadata, ...attrs };
        tool.cloudAgentId = cloudAgentId;
        tool.cloudTaskId = cloudTaskId;
        tool.cloudIdSource = cloudAgentId || cloudTaskId ? "otel" : undefined;
        await this.emitTool(session, resolvedTurn, tool, record.timestampMs);
      } else if (record.eventName === "codex.api_request") {
        const resolvedTurn = turn || this.turnFor(session, turnId, false);
        const requestId = asString(firstDefined(attrs, ["request.id", "request_id"])) ||
          stableEventId(session.sessionId, "api", record.timestampMs);
        await this.writer.append(eventBase(session, {
          eventId: stableEventId("codex", session.sessionId, "api", requestId),
          spanId: stableSpanId(session.sessionId, "api", requestId),
          parentSpanId: resolvedTurn?.activeSkillSpanId || session.rootSpanId,
          kind: "api",
          name: "api.codex",
          startTimeMs: record.timestampMs -
            (asNumber(firstDefined(attrs, ["duration_ms", "duration.ms"])) || 0),
          endTimeMs: record.timestampMs,
          status: firstDefined(attrs, ["success"]) === false ? "error" : "ok",
          error: asString(firstDefined(attrs, ["error.message", "error"])),
          attributes: {
            "codex.turn.id": resolvedTurn?.turnId,
            "codex.api.status_code": firstDefined(attrs, ["status_code", "http.status_code"]),
            "codex.cloud.agent_id": cloudAgentId,
            "codex.cloud.task_id": cloudTaskId,
            "codex.cloud.id_source": cloudAgentId || cloudTaskId ? "otel" : undefined,
          },
        }));
      }
      results.push({ eventName: record.eventName, sessionId });
    }
    return results;
  }

  resolveIdeTurn(event) {
    const workspaceFolders = event.workspaceFolders || (
      event.workspaceFolder ? [event.workspaceFolder] : []
    );
    const candidates = [];
    for (const session of this.sessions.values()) {
      if (!IDE_ORIGINATORS.test(`${session.originator || ""} ${session.terminalType || ""}`)) {
        continue;
      }
      if (!workspaceFolders.some((folder) => pathsOverlap(folder, session.cwd))) continue;
      for (const turn of session.turns.values()) {
        if (!turn.closed) candidates.push({ session, turn });
      }
    }
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  async processIdeEvent(event) {
    const resolved = this.resolveIdeTurn(event);
    if (!resolved) {
      this.unattributed += 1;
      return { attributed: false };
    }
    const { session, turn } = resolved;
    const timestampMs = asNumber(event.timestampMs) || this.now();
    const type = event.type === "file_edit" ? "FileEdit" : "Terminal";
    const callId = asString(event.eventId) ||
      stableEventId(session.sessionId, turn.turnId, type, timestampMs, event.relativePath);
    const tool = {
      callId,
      name: type,
      spanId: stableSpanId(session.sessionId, "ide", callId),
      parentSpanId: this.toolParent(session, turn),
      startedAt: asNumber(event.startedAt) || timestampMs,
      input: event.type === "file_edit"
        ? {
            relativePath: event.relativePath,
            languageId: event.languageId,
            changes: event.changes,
          }
        : {
            commandLine: event.commandLine,
            terminalName: event.terminalName,
            cwd: event.cwd,
          },
      output: event.type === "file_edit"
        ? { changed: true }
        : { exitCode: event.exitCode },
      exitCode: asNumber(event.exitCode),
      isError: event.exitCode !== undefined && Number(event.exitCode) !== 0,
      source: "ide",
      cloudAgentId: asString(event.cloudAgentId),
      cloudIdSource: event.cloudAgentId ? "user" : undefined,
    };
    await this.emitTool(session, turn, tool, timestampMs);
    return { attributed: true, sessionId: session.sessionId, turnId: turn.turnId };
  }

  updateLease(clientId, action) {
    if (!clientId) return;
    if (action === "release") this.leases.delete(clientId);
    else this.leases.set(clientId, this.now());
  }

  status() {
    const activeTurns = [];
    for (const session of this.sessions.values()) {
      for (const turn of session.turns.values()) {
        if (turn.closed) continue;
        activeTurns.push({
          sessionId: session.sessionId,
          turnId: turn.turnId,
          originator: session.originator,
          terminalType: session.terminalType,
          cwd: session.cwd,
        });
      }
    }
    return {
      connected: true,
      activeTurns,
      unattributed: this.unattributed,
      leases: this.leases.size,
    };
  }

  snapshot() {
    return {
      version: 1,
      unattributed: this.unattributed,
      sessions: [...this.sessions.values()].map((session) => ({
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        updatedAt: session.updatedAt,
        cwd: session.cwd,
        model: session.model,
        originator: session.originator,
        terminalType: session.terminalType,
        closed: session.closed,
        turns: [...session.turns.values()].map((turn) => ({
          turnId: turn.turnId,
          startedAt: turn.startedAt,
          updatedAt: turn.updatedAt,
          closed: turn.closed,
          activeAgentId: turn.activeAgentId,
          activeSkillSpanId: turn.activeSkillSpanId,
          llmSequence: turn.llmSequence,
        })),
      })),
    };
  }

  restore(snapshot) {
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.sessions)) return;
    this.unattributed = Number(snapshot.unattributed) || 0;
    for (const item of snapshot.sessions) {
      if (!item?.sessionId) continue;
      const session = this.ensureSession(item.sessionId, item);
      session.startedAt = Number(item.startedAt) || session.startedAt;
      session.closed = Boolean(item.closed);
      for (const rawTurn of item.turns || []) {
        const turn = this.turnFor(session, rawTurn.turnId, true, rawTurn);
        turn.startedAt = Number(rawTurn.startedAt) || turn.startedAt;
        turn.updatedAt = Number(rawTurn.updatedAt) || turn.updatedAt;
        turn.closed = Boolean(rawTurn.closed);
        turn.activeAgentId = rawTurn.activeAgentId || "root";
        turn.activeSkillSpanId = rawTurn.activeSkillSpanId;
        turn.llmSequence = Number(rawTurn.llmSequence) || 0;
      }
    }
  }
}

module.exports = {
  CodexTraceCore,
  HOOK_EVENTS,
  MATCHER_EVENTS,
  anyValueToJs,
  attributesToObject,
  classifyTool,
  extractOtlpLogRecords,
  normalizeHookInput,
  parseMcpIdentity,
  pathsOverlap,
  skillFromPrompt,
  skillPathFromToolInput,
  skillVersion,
};
