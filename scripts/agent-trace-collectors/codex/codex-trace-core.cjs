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
const { createCodexLifecycleReducer } = require("./lifecycle-reducer.cjs");
const { classifyCodexSource } = require("./source-classifier.cjs");

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
const SKILL_PATH_PATTERN = /(?:^|[\s"'`])((?:[A-Za-z]:)?[\\/]?(?:[^\\/"'`\s]+[\\/])*skills[\\/]([^\\/"'`\s]+)[\\/]SKILL\.md)(?=$|[\s"'`])/i;

/** 技能的真正执行以这些工具运行形态出现；读取 SKILL.md 的普通工具不在此列。 */
const SKILL_RUNNER_TOOLS = new Set(["skill", "skill_view", "load_skill", "load-skill", "run_skill", "run-skill", "skill.run", "skill_run"]);

function isSkillRunnerTool(toolName) {
  return SKILL_RUNNER_TOOLS.has(String(toolName || "").toLowerCase());
}
const DEFAULT_STATE_RETENTION_MS = 6 * 60 * 60 * 1000;

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
    const match = SKILL_PATH_PATTERN.exec(candidate);
    if (match) return { name: match[2], filePath: match[1] };
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

function executionId(sessionId, turnId) {
  return `${sessionId}:turn:${turnId}`;
}

function implicitAgentFromPrompt(prompt) {
  const text = asString(prompt)?.trim();
  if (!text) return undefined;
  // Codex emits this exact heading for its automatic memory consolidation unit.
  // It has an independent system-like prompt and a separate execution stream.
  if (/^##\s*Memory Writing Agent\s*:/i.test(text)) {
    return { name: "Memory Agent", promptKey: text };
  }
  // Keep the generic path deliberately narrow: a titled "* Agent:" prompt is
  // the strongest framework-visible boundary available when Codex does not emit
  // a SubagentStart hook. The title gives the tree a stable, non-user-role name.
  const match = /^##\s*([A-Za-z][A-Za-z0-9 _-]{0,72}?\s+Agent)\s*:/m.exec(text);
  if (!match) return undefined;
  return { name: match[1].replace(/\s+/g, " ").trim(), promptKey: text };
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
    this.callScopes = new Map();
    this.implicitPromptScopes = new Map();
    this.stateRetentionMs = options.stateRetentionMs ?? DEFAULT_STATE_RETENTION_MS;
    this.lifecycleReducer = createCodexLifecycleReducer();
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
        serviceName: metadata.serviceName,
        sourceKind: classifyCodexSource(metadata).sourceKind,
        input: undefined,
        output: undefined,
        closed: false,
        turns: new Map(),
        // A Hook turn id and native OTel's internal turn id frequently name the
        // same user execution. Keep those raw ids as aliases of one canonical
        // execution boundary instead of letting either transport create a root.
        turnAliases: new Map(),
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
    session.serviceName = metadata.serviceName || session.serviceName;
    const classified = classifyCodexSource({
      ...metadata,
      originator: metadata.originator || session.originator,
      terminalType: metadata.terminalType || session.terminalType,
      serviceName: metadata.serviceName || session.serviceName,
    });
    if (classified.sourceKind !== "unknown" || !session.sourceKind) {
      session.sourceKind = classified.sourceKind;
    }
    session.updatedAt = metadata.timestampMs || this.now();
    return session;
  }

  turnFor(session, turnId, create = false, metadata = {}) {
    const requestedId = asString(turnId);
    let resolvedId = requestedId && (session.turnAliases.get(requestedId) || requestedId);
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
        executionId: executionId(session.sessionId, resolvedId),
        rootSpanId: stableSpanId(session.sessionId, resolvedId, "root"),
        spanId: stableSpanId(session.sessionId, resolvedId, "turn"),
        startedAt,
        updatedAt: startedAt,
        input: metadata.input,
        output: undefined,
        closed: false,
        activeAgentId: "root",
        activeSkillSpanId: undefined,
        llmSequence: 0,
        // 上一条 sse_event 的到达时间。Codex 的 sse_event 不带 duration_ms，
        // 用相邻事件时间差推算 LLM span 时长（首条从 turn 开始算），避免恒 0。
        lastSseAt: undefined,
        parentScope: session.delegatedParent,
        unresolvedImplicit: Boolean(metadata.unresolvedImplicit),
        promptSources: new Set(metadata.promptSource ? [metadata.promptSource] : []),
      };
      session.turns.set(resolvedId, turn);
    }
    if (turn && requestedId) session.turnAliases.set(requestedId, turn.turnId);
    return turn;
  }

  linkTurnAlias(session, rawTurnId, turn) {
    const id = asString(rawTurnId);
    if (id && turn) session.turnAliases.set(id, turn.turnId);
    return turn;
  }

  promptTurn(session, rawTurnId, prompt, timestampMs, source) {
    const direct = this.turnFor(session, rawTurnId, false);
    if (direct) {
      direct.input = prompt || direct.input;
      direct.updatedAt = timestampMs;
      direct.promptSources ||= new Set();
      if (source) direct.promptSources.add(source);
      return direct;
    }

    // Hook and OTel report the same user prompt with different ids. Merge only
    // when the content, time window, and transport source all agree; repeated
    // identical user prompts from one transport remain distinct executions.
    const candidate = [...session.turns.values()].filter((turn) =>
      turn.input === prompt &&
      !turn.unresolvedImplicit &&
      Math.abs(timestampMs - turn.startedAt) <= 10_000 &&
      !(turn.promptSources || new Set()).has(source),
    );
    if (candidate.length === 1) {
      const turn = candidate[0];
      turn.updatedAt = timestampMs;
      turn.promptSources ||= new Set();
      if (source) turn.promptSources.add(source);
      return this.linkTurnAlias(session, rawTurnId, turn);
    }

    return this.turnFor(session, rawTurnId, true, {
      timestampMs,
      input: prompt,
      promptSource: source,
    });
  }

  resolveOtelTurn(session, rawTurnId, timestampMs, { createPending = false } = {}) {
    const direct = this.turnFor(session, rawTurnId, false);
    if (direct) return direct;

    const candidates = [...session.turns.values()].filter((turn) =>
      Boolean(turn.input) && !turn.unresolvedImplicit,
    );
    const active = candidates.filter((turn) => !turn.closed);
    if (active.length === 1) return active[0];
    if (active.length > 1) return undefined;

    // A native OTel end record can arrive shortly after Hook Stop. Use this
    // narrow recovery only when there is exactly one recent user execution.
    // Hook and OTel clocks are not guaranteed to be ordered, so a small clock
    // skew must not create a pending pseudo-task for the same completed turn.
    const recent = candidates.filter((turn) =>
      Math.abs(timestampMs - turn.updatedAt) <= 120_000,
    );
    if (recent.length === 1) return recent[0];
    if (!createPending) return undefined;

    // Preserve an otherwise uncorrelated native event durably, but never make
    // it a list-visible root. A later direct prompt/call correlation can replay
    // it safely without guessing between concurrent user executions.
    return this.turnFor(session, rawTurnId, true, {
      timestampMs,
      unresolvedImplicit: true,
    });
  }

  scopeFor(session, turn) {
    if (!turn) return undefined;
    if (turn.parentScope) return turn.parentScope;
    return {
      executionId: turn.executionId,
      rootSpanId: turn.rootSpanId,
      name: "codex",
      kind: "root",
    };
  }

  async append(session, turn, overrides) {
    const scope = this.scopeFor(session, turn);
    if (!scope) return undefined;
    const pendingAssociation = Boolean(turn.unresolvedImplicit && !turn.parentScope);
    return this.writer.append(eventBase(session, {
      ...overrides,
      sessionId: pendingAssociation ? `pending:${turn.executionId}` : scope.executionId,
      traceId: stableTraceId("codex", pendingAssociation ? `pending:${turn.executionId}` : scope.executionId),
      attributes: {
        "codex.execution.id": scope.executionId,
        "codex.conversation.id": session.sessionId,
        "codex.turn.id": turn.turnId,
        "codex.source.kind": session.sourceKind || "unknown",
        ...(pendingAssociation ? { "codex.association.pending": "true" } : {}),
        ...overrides.attributes,
      },
    }));
  }

  sessionsShareExecutionContext(candidate, source) {
    if (candidate.cwd && source.cwd && !pathsOverlap(candidate.cwd, source.cwd)) return false;
    if (candidate.originator && source.originator && candidate.originator !== source.originator) {
      return false;
    }
    if (candidate.terminalType && source.terminalType &&
      candidate.terminalType !== source.terminalType) return false;
    return true;
  }

  activeRootScopes(sourceSession, timestampMs) {
    const candidates = [];
    for (const session of this.sessions.values()) {
      if (session.sessionId === sourceSession.sessionId ||
        !this.sessionsShareExecutionContext(session, sourceSession)) continue;
      for (const turn of session.turns.values()) {
        if (!turn.input || turn.parentScope) continue;
        candidates.push({ session, turn });
      }
    }
    // A restored turn can be marked open forever when Codex exits without a
    // final lifecycle hook. Treat only recently-updated open turns as active;
    // otherwise stale state would make every later implicit agent ambiguous.
    const active = candidates.filter(({ turn }) =>
      !turn.closed && Math.abs(timestampMs - turn.updatedAt) <= 120_000,
    );
    if (active.length === 1) return this.scopeFor(active[0].session, active[0].turn);
    if (active.length > 1) return undefined;
    const recent = candidates.filter(({ turn }) =>
      Math.abs(timestampMs - turn.updatedAt) <= 120_000,
    );
    return recent.length === 1 ? this.scopeFor(recent[0].session, recent[0].turn) : undefined;
  }

  parentTurnForSubagent(session, rawTurnId, timestampMs) {
    const reported = this.turnFor(session, rawTurnId, false);
    if (reported?.input) return reported;
    // Codex may report a child-lifecycle turn id for SubagentStart/Stop rather
    // than the user's active parent turn. That id has no prompt and must never
    // become the execution boundary when one active root is unambiguous.
    const activeRoots = [...session.turns.values()].filter((turn) =>
      Boolean(turn.input) &&
      !turn.parentScope &&
      !turn.closed &&
      Math.abs(timestampMs - turn.updatedAt) <= 120_000,
    );
    if (activeRoots.length === 1) return activeRoots[0];
    return reported || this.turnFor(session, rawTurnId, true, { timestampMs });
  }

  bindImplicitPrompt(session, turn, prompt, timestampMs) {
    const implicit = implicitAgentFromPrompt(prompt);
    if (!implicit || turn.parentScope) return;
    const known = this.implicitPromptScopes.get(implicit.promptKey);
    if (known && timestampMs - known.timestampMs <= 120_000) {
      turn.parentScope = known.scope;
      turn.unresolvedImplicit = false;
      return;
    }
    const parent = this.activeRootScopes(session, timestampMs);
    if (!parent) {
      // Do not turn an uncorrelated automatic unit into a visible root task.
      // Its raw event remains durable under a pending execution key and can be
      // safely replayed when a later direct correlation becomes available.
      turn.unresolvedImplicit = true;
      return;
    }
    const scope = {
      executionId: parent.executionId,
      rootSpanId: stableSpanId(parent.executionId, "implicit", session.sessionId, turn.turnId),
      parentSpanId: parent.rootSpanId,
      name: implicit.name,
      kind: "implicit",
    };
    turn.parentScope = scope;
    turn.unresolvedImplicit = false;
    this.implicitPromptScopes.set(implicit.promptKey, { scope, timestampMs });
  }

  async emitRoot(session, turn, timestampMs, status = "ok") {
    if (!turn) return undefined;
    const scope = this.scopeFor(session, turn);
    if (scope?.kind === "explicit") return undefined;
    const implicit = scope?.kind === "implicit";
    return this.append(session, turn, {
      eventId: stableEventId("codex", session.sessionId, turn.turnId, implicit ? "implicit" : "root"),
      spanId: implicit ? scope.rootSpanId : turn.rootSpanId,
      parentSpanId: implicit ? scope.parentSpanId : undefined,
      kind: implicit ? "subagent" : "agent",
      name: implicit ? `agent.${scope.name}` : "agent.codex",
      // A conversation is context only; execution latency begins at this user
      // prompt (or its correlated automatic child), never at SessionStart.
      startTimeMs: turn.startedAt,
      endTimeMs: timestampMs,
      input: turn.input,
      output: turn.output,
      model: session.model,
      status,
      attributes: {
        "codex.agent.id": implicit ? scope.rootSpanId : "root",
        "codex.agent.name": implicit ? scope.name : "codex",
        "codex.originator": session.originator,
        "codex.terminal.type": session.terminalType,
        "codex.cwd": session.cwd,
        ...(implicit ? { "codex.subagent.implicit": "true" } : {}),
      },
    });
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
    await this.append(session, turn, {
      eventId: stableEventId("codex", session.sessionId, turn.turnId, "skill", skill.name),
      spanId: stored.spanId,
      parentSpanId: turn.parentScope?.rootSpanId || turn.rootSpanId,
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
    });
    return stored;
  }

  /** 技能完成：把宿主工具带回的输出补写到同一个 skill span（Bug 52）。
   *
   * emitSkill 在（Pre）ToolUse 时写入，此时技能结果尚未产生；技能结果随宿主工具
   * 的 PostToolUse tool_response 返回。这里以同一 spanId 追加一份带 output 的完成
   * 快照，endTimeMs 更新为宿主工具完成时刻。服务端 keepLatestCodexSpanSnapshots
   * 按 spanId 只保留 endTime 最新的一份，因此完成快照会覆盖 start 快照，UI 的
   * skill 节点能显示输出。宿主工具无输出时不追加，避免空快照。 */
  async completeActiveSkill(session, turn, output, timestampMs, isError) {
    const spanId = turn.activeSkillSpanId;
    if (!spanId) return;
    const stored = [...session.skills.values()].find((s) => s.spanId === spanId);
    if (!stored) return;
    if (output == null) return;
    await this.append(session, turn, {
      eventId: stableEventId("codex", session.sessionId, turn.turnId, "skill", stored.name),
      spanId,
      parentSpanId: turn.parentScope?.rootSpanId || turn.rootSpanId,
      kind: "skill",
      name: `skill.${stored.name}`,
      startTimeMs: stored.startedAt,
      endTimeMs: timestampMs,
      input: turn.input,
      output,
      status: isError ? "error" : "ok",
      skill: {
        name: stored.name,
        version: stored.version,
        triggerMode: stored.triggerMode,
      },
      attributes: {
        "codex.turn.id": turn.turnId,
      },
    });
  }

  toolParent(session, turn) {
    if (!turn) return session.rootSpanId;
    if (turn.activeSkillSpanId) return turn.activeSkillSpanId;
    if (turn.parentScope) return turn.parentScope.rootSpanId;
    const agent = session.agents.get(turn.activeAgentId);
    return agent?.spanId || turn.rootSpanId;
  }

  async emitTool(session, turn, tool, timestampMs) {
    const mcp = parseMcpIdentity(tool.name, tool.metadata);
    const status = tool.isError || tool.success === false ? "error" : "ok";
    this.callScopes.set(tool.callId, this.scopeFor(session, turn));
    return this.append(session, turn, {
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
    });
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
      // A conversation lifecycle is context, not a user execution. Wait for a
      // prompt boundary before emitting a root task.
    } else if (eventName === "UserPromptSubmit") {
      const prompt = asString(input.prompt || input.user_prompt || input.message) || "";
      const turn = this.promptTurn(session, input.turn_id, prompt, timestampMs, "hook");
      this.bindImplicitPrompt(session, turn, prompt, timestampMs);
      session.input ||= prompt;
      const explicitSkill = skillFromPrompt(prompt);
      if (explicitSkill) await this.emitSkill(session, turn, explicitSkill, timestampMs);
      await this.emitRoot(session, turn, timestampMs);
    } else if (eventName === "PreToolUse" || eventName === "PostToolUse") {
      const turn = this.turnFor(session, input.turn_id, true, { timestampMs });
      turn.updatedAt = timestampMs;
      const name = asString(input.tool_name || input.tool?.name) || "unknown";
      const callId = asString(
        input.tool_use_id ||
        input.call_id ||
        input.tool_call_id ||
        input.tool?.id,
      ) || stableEventId(session.sessionId, turn.turnId, name, timestampMs);
      const callScope = this.callScopes.get(callId);
      if (callScope && !turn.parentScope && callScope.executionId !== turn.executionId) {
        // A forked worker can report a Hook tool lifecycle back through the
        // parent conversation under a child-only turn id. The shared call id is
        // direct evidence that this event belongs to the worker TASK.
        turn.parentScope = callScope;
        turn.unresolvedImplicit = false;
      }
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
          turn.skillCarrierCallId = callId;
        }
      } else {
        tool.output = input.tool_response ?? input.tool_result ?? input.result ?? input.output;
        tool.isError = Boolean(input.is_error || input.error);
        tool.error = asString(input.error?.message || input.error);
        tool.exitCode = asNumber(input.exit_code ?? input.tool_response?.exit_code);
        // 技能宿主工具完成：结果并入 skill 完成快照，不再单独发 tool.skill 事件，
        // 避免同一技能在 UI 里被同时渲染成 SKILL 节点和 tool 节点（重复显示 Bug 52
        // 的配套整理）。其余普通工具照常发 tool 事件。
        const isSkillCarrierCompletion = turn.activeSkillSpanId
          && callId === turn.skillCarrierCallId
          && isSkillRunnerTool(name);
        if (isSkillCarrierCompletion) {
          await this.completeActiveSkill(session, turn, tool.output, timestampMs, tool.isError);
        } else {
          await this.emitTool(session, turn, tool, timestampMs);
        }
      }
    } else if (eventName === "SubagentStart" || eventName === "SubagentStop") {
      const agentId = asString(input.agent_id || input.subagent_id) ||
        stableEventId(session.sessionId, "subagent", timestampMs);
      let agent = session.agents.get(agentId);
      const turn = agent?.parentTurnId
        ? this.turnFor(session, agent.parentTurnId, false) ||
          this.parentTurnForSubagent(session, input.turn_id, timestampMs)
        : this.parentTurnForSubagent(session, input.turn_id, timestampMs);
      turn.updatedAt = timestampMs;
      if (!agent) {
        const parentId = asString(input.parent_agent_id) || turn.activeAgentId || "root";
        const parent = session.agents.get(parentId);
        agent = {
          agentId,
          parentId,
          name: asString(input.agent_type || input.subagent_type) || "subagent",
          spanId: stableSpanId(session.sessionId, "agent", agentId),
          parentSpanId: parent?.spanId || turn.rootSpanId,
          startedAt: timestampMs,
          input: input.prompt || input.task || input.description,
          parentTurnId: turn.turnId,
        };
        session.agents.set(agentId, agent);
      }
      if (eventName === "SubagentStart") {
        // Start 只更新 active agent，不 append——避免与 Stop 的同 spanId 事件重复
        // （服务端 keepLatest 虽能收口，但 spool 直接读会有两条）。
        // Hook may report a dedicated worker lifecycle turn instead of the
        // user turn. Once Start has resolved its unique parent, that turn id
        // is direct correlation evidence for later worker Tool hooks.
        this.linkTurnAlias(session, input.turn_id, turn);
        turn.activeAgentId = agentId;
        // agentId 是 fork session id。把明确的父 span 与当前执行边界写入内存关联；
        // fork 自身随后产生的 Hook/OTel 事件会直接流入这个 TASK 节点，而不再另起主任务。
        const delegatedSession = this.ensureSession(agentId, { timestampMs });
        const delegatedParent = {
          executionId: turn.executionId,
          rootSpanId: agent.spanId,
          parentSpanId: agent.parentSpanId,
          name: agent.name,
          kind: "explicit",
        };
        delegatedSession.delegatedParent = delegatedParent;
        for (const delegatedTurn of delegatedSession.turns.values()) {
          if (!delegatedTurn.parentScope) delegatedTurn.parentScope = delegatedParent;
        }
        return;
      }
      agent.output = input.last_assistant_message || input.result || input.output;
      agent.error = asString(input.error?.message || input.error);
      turn.activeAgentId = agent.parentId || "root";
      await this.append(session, turn, {
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
      });
    } else if (eventName === "Stop") {
      const turn = this.turnFor(session, input.turn_id, false);
      const output = input.last_assistant_message || input.result || input.output;
      if (turn) {
        turn.output = output;
        turn.closed = true;
        turn.updatedAt = timestampMs;
      }
      session.output = output || session.output;
      await this.emitRoot(session, turn, timestampMs, input.error ? "error" : "ok");
      flush = true;
    } else if (eventName === "SessionEnd") {
      for (const turn of session.turns.values()) {
        // A SessionEnd closes the conversation, not every historical user
        // execution. Re-emitting already closed turns would extend their
        // latency through all later prompts in the same conversation.
        if (turn.closed) continue;
        turn.closed = true;
        turn.output ||= input.last_assistant_message || input.result;
        await this.emitRoot(session, turn, timestampMs, input.error ? "error" : "ok");
      }
      session.closed = true;
      session.output = input.last_assistant_message || input.result || session.output;
      flush = true;
    } else {
      const turn = this.turnFor(session, input.turn_id, false);
      await this.append(session, turn, {
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
      });
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
        serviceName: asString(firstDefined(attrs, ["service.name", "service_name"])),
      });
      const turnId = asString(firstDefined(attrs, ["turn.id", "turn_id", "codex.turn.id"]));
      let turn = this.resolveOtelTurn(session, turnId, record.timestampMs);
      const cloudAgentId = asString(firstDefined(attrs, ["auth.agent_id", "auth.agent.id"]));
      const cloudTaskId = asString(firstDefined(attrs, ["auth.task_id", "auth.task.id"]));

      if (record.eventName === "codex.conversation_starts") {
        // Conversation starts are not user task boundaries. A following prompt
        // creates the root execution (or a child execution) deterministically.
      } else if (record.eventName === "codex.user_prompt") {
        const promptLength = asNumber(firstDefined(attrs, [
          "prompt_length",
          "prompt.length",
          "length",
        ]));
        const prompt = asString(firstDefined(attrs, ["prompt", "user_prompt"])) ||
          (promptLength === undefined ? undefined : `[REDACTED prompt length=${promptLength}]`);
        // The literal placeholder accompanies native lifecycle telemetry when
        // Hook already owns the real prompt. It is not a second user turn.
        if (prompt?.trim() !== "[REDACTED]") {
          const promptTurn = this.promptTurn(session, turnId, prompt, record.timestampMs, "otel");
          session.input ||= prompt;
          this.bindImplicitPrompt(session, promptTurn, prompt, record.timestampMs);
          await this.emitRoot(session, promptTurn, record.timestampMs);
          turn = promptTurn;
        }
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
          const resolvedTurn = turn || this.resolveOtelTurn(session, turnId, record.timestampMs, {
            createPending: true,
          });
          resolvedTurn.updatedAt = record.timestampMs;
          resolvedTurn.llmSequence += 1;
          const inputTokenValue = firstDefined(attrs, [
            "input_token_count",
            "input_tokens",
            "gen_ai.usage.input_tokens",
          ]);
          const outputTokenValue = firstDefined(attrs, [
            "output_token_count",
            "output_tokens",
            "gen_ai.usage.output_tokens",
          ]);
          const reasoningTokenValue = firstDefined(attrs, [
            "reasoning_token_count",
            "reasoning_tokens",
            "gen_ai.usage.reasoning_tokens",
          ]);
          const totalTokenValue = firstDefined(attrs, [
            "total_token_count",
            "total_tokens",
            "gen_ai.usage.total_tokens",
          ]);
          if ([inputTokenValue, outputTokenValue, reasoningTokenValue, totalTokenValue]
            .every((value) => asNumber(value) === undefined)) continue;
          const inputTokens = asNumber(inputTokenValue) || 0;
          const outputTokens = asNumber(outputTokenValue) || 0;
          const reasoningTokens = asNumber(reasoningTokenValue) || 0;
          const cacheTokens = asNumber(firstDefined(attrs, [
            "cached_input_token_count",
            "cached_token_count",
            "cache_read_token_count",
            "cached_tokens",
          ])) || 0;
          const total = asNumber(totalTokenValue) || inputTokens + outputTokens;
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
          // Codex 的 sse_event 不带 duration_ms（只有 ttft），若直接用
          // `timestampMs - duration` 会导致 start == end、LLM 时长恒 0。
          // 改用相邻 sse_event 时间差：本条 start = 上一条 sse_event 到达
          // （首条 = turn 开始），end = 本条到达，保证时长非 0 且覆盖整个 turn。
          const startTimeMs = resolvedTurn.lastSseAt ?? resolvedTurn.startedAt;
          resolvedTurn.lastSseAt = record.timestampMs;
          await this.append(session, resolvedTurn, {
            eventId: stableEventId("codex", session.sessionId, "llm", responseId),
            spanId,
            // 与 tool 事件一致：LLM 挂到当前 active agent（subagent 内 LLM 归 subagent，
            // 而非固定 root）。toolParent 依次取 activeSkillSpanId → activeAgentId → root。
            parentSpanId: this.toolParent(session, resolvedTurn),
            kind: "llm",
            name: `llm.${session.model || "codex"}`,
            startTimeMs,
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
              "codex.native.turn.id": turnId,
              "codex.ttft_ms": ttftMs,
              "codex.usage.cache_read": cacheTokens,
              "codex.cloud.agent_id": cloudAgentId,
              "codex.cloud.task_id": cloudTaskId,
              "codex.cloud.id_source": cloudAgentId || cloudTaskId ? "otel" : undefined,
              "codex.originator": session.originator,
            },
          });
        }
      } else if (record.eventName === "codex.tool_result") {
        const resolvedTurn = turn || this.resolveOtelTurn(session, turnId, record.timestampMs, {
          createPending: true,
        });
        resolvedTurn.updatedAt = record.timestampMs;
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
        const callScope = this.callScopes.get(callId);
        if (callScope && !resolvedTurn.parentScope &&
          callScope.executionId !== resolvedTurn.executionId) {
          resolvedTurn.parentScope = callScope;
          resolvedTurn.unresolvedImplicit = false;
          tool.parentSpanId = callScope.rootSpanId;
        }
        await this.emitTool(session, resolvedTurn, tool, record.timestampMs);
      } else if (record.eventName === "codex.api_request") {
        const resolvedTurn = turn || this.resolveOtelTurn(session, turnId, record.timestampMs);
        // Codex emits startup API telemetry before it has created a user turn.
        // It is lifecycle noise, not a task, and has no safe parent span.
        if (!resolvedTurn) continue;
        const requestId = asString(firstDefined(attrs, ["request.id", "request_id"])) ||
          stableEventId(session.sessionId, "api", record.timestampMs);
        await this.append(session, resolvedTurn, {
          eventId: stableEventId("codex", session.sessionId, "api", requestId),
          spanId: stableSpanId(session.sessionId, "api", requestId),
          parentSpanId: this.toolParent(session, resolvedTurn),
          kind: "api",
          name: "api.codex",
          startTimeMs: record.timestampMs -
            (asNumber(firstDefined(attrs, ["duration_ms", "duration.ms"])) || 0),
          endTimeMs: record.timestampMs,
          status: firstDefined(attrs, ["success"]) === false ? "error" : "ok",
          error: asString(firstDefined(attrs, ["error.message", "error"])),
          attributes: {
            "codex.turn.id": resolvedTurn?.turnId,
            "codex.native.turn.id": turnId,
            "codex.api.status_code": firstDefined(attrs, ["status_code", "http.status_code"]),
            "codex.cloud.agent_id": cloudAgentId,
            "codex.cloud.task_id": cloudTaskId,
            "codex.cloud.id_source": cloudAgentId || cloudTaskId ? "otel" : undefined,
          },
        });
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

  /** rollout 正文/工具结果写入 OTLP 同源 session（Bug 56）。
   *
   * rollout_content 事件来自 desktop rollout reader 的正文提取（llm_text /
   * tool_output / agent_message）。sessionId 必须与 OTLP 路径一致
   * （`{threadId}:turn:{turnId}`，由 executionId() 派生），否则 spool 按
   * sessionId 分目录后两路事件无法聚合：
   * - llm_text / agent_message：以 `stableSpanId(session,turn,'llm','msg-N')`
   *   独立 llm 事件写入（不与 OTLP usage llm span 抢 spanId；usage span 保持
   *   元数据快照，正文 span 提供内容，adapter 聚合时都成为 assistant 交互）。
   * - tool_output：以 `stableSpanId(sessionId,'tool',callId)` 与 OTLP
   *   tool_result 事件同 spanId 追加完成快照（同 Bug 52 skill 快照模式），
   *   服务端 keepLatestCodexSpanSnapshots 按 spanId 保留 endTime 最新一份，
   *   两路合一后 UI 工具节点显示 output。
   * - 事件去重：eventId 含内容摘要与时间戳，relay 重启重放 checkpoint 未推进
   *   的批次时由 stableEventId 幂等。 */
  async processRolloutContent(event) {
    const threadId = asString(event.sourceThreadId);
    const turnId = asString(event.sourceExecutionId);
    if (!threadId) return { attributed: false };
    const timestampMs = asNumber(event.timestampMs) || this.now();
    const session = this.ensureSession(threadId, {
      timestampMs,
      originator: "Codex Desktop",
    });
    // rollout 的 turn id 与 OTLP 同源（实测逐位一致）；有直接 id 即直接归属，
    // 不走 resolveOtelTurn 的 pending 降级。命中的 pending 伪任务同时被认领。
    const turn = this.turnFor(session, turnId, true, { timestampMs });
    if (!turn) return { attributed: false };
    if (turn.unresolvedImplicit && !turn.parentScope) turn.unresolvedImplicit = false;
    turn.updatedAt = timestampMs;
    const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
    const contentKind = asString(event.contentKind) || "llm_text";

    if (contentKind === "tool_output") {
      const callId = asString(payload.callId);
      if (!callId) return { attributed: false };
      let tool = session.tools.get(callId);
      if (!tool) {
        tool = {
          callId,
          name: asString(payload.toolName) || "unknown",
          spanId: stableSpanId(session.sessionId, "tool", callId),
          parentSpanId: this.toolParent(session, turn),
          startedAt: timestampMs,
          source: "rollout",
        };
        session.tools.set(callId, tool);
      }
      if (payload.toolName) tool.name = asString(payload.toolName) || tool.name;
      tool.output = asString(payload.output) ?? tool.output;
      tool.success = tool.success ?? true;
      tool.source = tool.source?.includes("rollout") ? tool.source : `${tool.source || "rollout"}+rollout`;
      await this.emitTool(session, turn, tool, timestampMs);
      return { attributed: true, sessionId: session.sessionId, turnId: turn.turnId };
    }

    // llm_text / agent_message → 独立 llm 正文事件
    const textValue = asString(payload.text);
    if (!textValue) return { attributed: false };
    turn.llmSequence += 1;
    const messageId = asString(payload.itemId) || `msg-${turn.llmSequence}`;
    await this.append(session, turn, {
      eventId: stableEventId("codex", session.sessionId, turn.turnId, "llm-content", messageId),
      spanId: stableSpanId(session.sessionId, turn.turnId, "llm", messageId),
      parentSpanId: this.toolParent(session, turn),
      kind: "llm",
      name: `llm.${session.model || "codex"}`,
      startTimeMs: timestampMs,
      endTimeMs: timestampMs,
      model: session.model,
      output: textValue,
      attributes: {
        "codex.turn.id": turn.turnId,
        "codex.source.kind": session.sourceKind || "desktop",
        "codex.content.source": "rollout",
      },
    });
    return { attributed: true, sessionId: session.sessionId, turnId: turn.turnId };
  }

  async processLifecycleEvent(event) {
    if (event?.eventType === "rollout_content") return this.processRolloutContent(event);
    const result = this.lifecycleReducer.apply(event);
    if (result.duplicate || result.pending) return result;
    const threadId = event.sourceThreadId;
    const session = this.ensureSession(threadId, {
      timestampMs: event.timestampMs,
      originator: event.payload?.originator,
      terminalType: event.payload?.terminalType,
    });
    for (const snapshot of result.snapshots || []) {
      const payload = snapshot.payload || {};
      if (snapshot.eventType === "execution_snapshot") {
        const executionId = `codex:${threadId}:turn:${snapshot.sourceExecutionId}`;
        await this.writer.append(eventBase(session, {
          sessionId: executionId,
          traceId: stableTraceId("codex", executionId),
          spanId: stableSpanId("codex-lifecycle", executionId),
          parentSpanId: undefined,
          kind: "agent",
          name: "agent.codex",
          input: payload.query,
          output: payload.output,
          status: payload.status === "failed" ? "error" : payload.status,
          startTimeMs: payload.startedAt || snapshot.timestampMs,
          endTimeMs: payload.updatedAt || snapshot.timestampMs,
          attributes: {
            "agent.insight.lifecycle": "execution",
            "codex.lifecycle.event_type": "execution_snapshot",
            "codex.execution.id": executionId,
            "codex.conversation.id": threadId,
            "codex.turn.id": snapshot.sourceExecutionId,
            "codex.source.kind": snapshot.sourceKind,
            "codex.source.thread_id": threadId,
            "codex.source.execution_id": snapshot.sourceExecutionId,
            "codex.execution.status": payload.status,
            "codex.input.history": JSON.stringify(payload.inputs || []),
            "codex.input.phases": JSON.stringify(payload.phases || []),
          },
        }));
      } else if (snapshot.eventType === "compaction_snapshot") {
        await this.writer.append(eventBase(session, {
          sessionId: threadId,
          traceId: stableTraceId("codex", threadId),
          spanId: stableSpanId("codex-lifecycle", "compaction", snapshot.sourceItemId),
          kind: "span",
          name: "context.compaction",
          input: undefined,
          output: undefined,
          startTimeMs: payload.startedAt || snapshot.timestampMs,
          endTimeMs: payload.completedAt || snapshot.timestampMs,
          attributes: {
            "agent.insight.lifecycle": "compaction",
            "codex.lifecycle.event_type": "compaction_snapshot",
            "codex.conversation.id": threadId,
            "codex.source.kind": snapshot.sourceKind,
            "codex.source.thread_id": threadId,
            "codex.compaction.item_id": snapshot.sourceItemId,
            "codex.compaction.status": payload.status,
            "codex.compaction.duration_ms": payload.durationMs,
            "codex.compaction.payload": JSON.stringify(payload),
          },
        }));
      } else if (snapshot.eventType === "thread_event_snapshot") {
        await this.writer.append(eventBase(session, {
          sessionId: threadId,
          traceId: stableTraceId("codex", threadId),
          spanId: stableSpanId("codex-lifecycle", "thread-event", snapshot.sourceItemId),
          parentSpanId: undefined,
          kind: "span",
          name: "thread.execution_transition",
          input: undefined,
          output: undefined,
          startTimeMs: snapshot.timestampMs,
          endTimeMs: snapshot.timestampMs,
          attributes: {
            "agent.insight.lifecycle": "thread_event",
            "codex.lifecycle.event_type": "thread_event_snapshot",
            "codex.conversation.id": threadId,
            "codex.source.kind": snapshot.sourceKind,
            "codex.source.thread_id": threadId,
            "codex.thread.event_id": snapshot.sourceItemId,
            "codex.thread.event_kind": payload.kind,
            "codex.thread.previous_execution_id": payload.previousSourceExecutionId,
            "codex.thread.next_execution_id": payload.nextSourceExecutionId,
            "codex.thread.transition_kind": payload.transitionKind,
            "codex.thread.confidence": payload.confidence,
          },
        }));
      }
    }
    return result;
  }

  updateLease(clientId, action) {
    if (!clientId) return;
    if (action === "release") this.leases.delete(clientId);
    else this.leases.set(clientId, this.now());
  }

  status() {
    this.pruneState();
    const activeTurns = [];
    const now = this.now();
    for (const session of this.sessions.values()) {
      for (const turn of session.turns.values()) {
        if (turn.closed || Math.abs(now - turn.updatedAt) > 120_000) continue;
        activeTurns.push({
          sessionId: session.sessionId,
          turnId: turn.turnId,
          originator: session.originator,
          terminalType: session.terminalType,
          sourceKind: session.sourceKind,
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

  pruneState(timestampMs = this.now()) {
    const cutoff = timestampMs - this.stateRetentionMs;
    const liveExecutionIds = new Set();

    for (const [sessionId, session] of this.sessions) {
      const hadTurns = session.turns.size > 0;
      for (const [turnId, turn] of session.turns) {
        if (Number(turn.updatedAt) < cutoff) session.turns.delete(turnId);
      }
      for (const [rawTurnId, canonicalTurnId] of session.turnAliases) {
        if (!session.turns.has(canonicalTurnId)) session.turnAliases.delete(rawTurnId);
      }
      for (const [agentId, agent] of session.agents) {
        if ((agent.parentTurnId && !session.turns.has(agent.parentTurnId)) ||
          Number(agent.startedAt) < cutoff) {
          session.agents.delete(agentId);
        }
      }
      for (const [key, tool] of session.tools) {
        if (Number(tool.startedAt) < cutoff) session.tools.delete(key);
      }
      for (const [key, skill] of session.skills) {
        if (Number(skill.startedAt) < cutoff) session.skills.delete(key);
      }
      for (const turnId of session.ttftByTurn.keys()) {
        if (!session.turns.has(turnId)) session.ttftByTurn.delete(turnId);
      }

      if (session.turns.size === 0 && (hadTurns || Number(session.updatedAt) < cutoff)) {
        this.sessions.delete(sessionId);
        continue;
      }
      for (const turn of session.turns.values()) {
        liveExecutionIds.add(turn.executionId);
        if (turn.parentScope?.executionId) liveExecutionIds.add(turn.parentScope.executionId);
      }
    }

    for (const [callId, scope] of this.callScopes) {
      if (!scope?.executionId || !liveExecutionIds.has(scope.executionId)) {
        this.callScopes.delete(callId);
      }
    }
    for (const [prompt, binding] of this.implicitPromptScopes) {
      if (Number(binding?.timestampMs) < cutoff ||
        !binding?.scope?.executionId ||
        !liveExecutionIds.has(binding.scope.executionId)) {
        this.implicitPromptScopes.delete(prompt);
      }
    }
  }

  snapshot() {
    this.pruneState();
    return {
      version: 4,
      unattributed: this.unattributed,
      callScopes: [...this.callScopes.entries()],
      implicitPromptScopes: [...this.implicitPromptScopes.entries()],
      sessions: [...this.sessions.values()].map((session) => ({
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        updatedAt: session.updatedAt,
        cwd: session.cwd,
        model: session.model,
        originator: session.originator,
        terminalType: session.terminalType,
        sourceKind: session.sourceKind,
        closed: session.closed,
        delegatedParent: session.delegatedParent,
        turnAliases: [...session.turnAliases.entries()],
        agents: [...session.agents.values()],
        turns: [...session.turns.values()].map((turn) => ({
          turnId: turn.turnId,
          input: turn.input,
          output: turn.output,
          startedAt: turn.startedAt,
          updatedAt: turn.updatedAt,
          closed: turn.closed,
          activeAgentId: turn.activeAgentId,
          activeSkillSpanId: turn.activeSkillSpanId,
          llmSequence: turn.llmSequence,
          lastSseAt: turn.lastSseAt,
          parentScope: turn.parentScope,
          unresolvedImplicit: turn.unresolvedImplicit,
          promptSources: [...(turn.promptSources || [])],
        })),
      })),
      lifecycle: this.lifecycleReducer.snapshot(),
    };
  }

  restore(snapshot) {
    if (!snapshot || ![1, 2, 3, 4].includes(snapshot.version) || !Array.isArray(snapshot.sessions)) return;
    this.unattributed = Number(snapshot.unattributed) || 0;
    this.callScopes = new Map(Array.isArray(snapshot.callScopes) ? snapshot.callScopes : []);
    this.implicitPromptScopes = new Map(
      Array.isArray(snapshot.implicitPromptScopes) ? snapshot.implicitPromptScopes : [],
    );
    this.lifecycleReducer.restore(snapshot.lifecycle);
    for (const item of snapshot.sessions) {
      if (!item?.sessionId) continue;
      const session = this.ensureSession(item.sessionId, item);
      session.sourceKind = item.sourceKind || session.sourceKind || "unknown";
      session.startedAt = Number(item.startedAt) || session.startedAt;
      session.updatedAt = Number(item.updatedAt) || session.updatedAt;
      session.closed = Boolean(item.closed);
      session.delegatedParent = item.delegatedParent;
      for (const [rawTurnId, canonicalTurnId] of item.turnAliases || []) {
        if (rawTurnId && canonicalTurnId) session.turnAliases.set(rawTurnId, canonicalTurnId);
      }
      for (const agent of item.agents || []) {
        if (agent?.agentId) session.agents.set(agent.agentId, agent);
      }
      for (const rawTurn of item.turns || []) {
        const turn = this.turnFor(session, rawTurn.turnId, true, rawTurn);
        turn.startedAt = Number(rawTurn.startedAt) || turn.startedAt;
        turn.updatedAt = Number(rawTurn.updatedAt) || turn.updatedAt;
        turn.input = rawTurn.input || turn.input;
        turn.output = rawTurn.output || turn.output;
        turn.closed = Boolean(rawTurn.closed);
        turn.activeAgentId = rawTurn.activeAgentId || "root";
        turn.activeSkillSpanId = rawTurn.activeSkillSpanId;
        turn.llmSequence = Number(rawTurn.llmSequence) || 0;
        turn.lastSseAt = Number(rawTurn.lastSseAt) || undefined;
        turn.parentScope = rawTurn.parentScope || session.delegatedParent;
        turn.unresolvedImplicit = Boolean(rawTurn.unresolvedImplicit);
        turn.promptSources = new Set(rawTurn.promptSources || []);
        // v1/v2 snapshots have no aliases; canonical ids remain valid aliases.
        session.turnAliases.set(turn.turnId, turn.turnId);
      }
    }
    this.pruneState();
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
