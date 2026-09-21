/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  DurableTraceUploader,
  DurableTraceWriter,
  atomicWriteJson,
  collectorStateDir,
  safeContent,
  sha256,
  stableEventId,
  stableSpanId,
  stableTraceId,
} = require("../../shared/trace-transport.cjs");
const {
  DurableCollaborationOutbox,
  goalPlusMainBinding,
} = require("../../shared/collaboration-transport.cjs");
const {
  classifyTool,
  parseMcpIdentity,
  usageFrom,
} = require("../../shared/pi-trace-helpers.cjs");

const DEFAULT_ENDPOINT = "http://127.0.0.1:3000/api/ingest/otel/v1/traces";
const DEFAULT_COLLABORATION_SESSIONS_ENDPOINT = "http://127.0.0.1:3000/api/ingest/collaborations/sessions";
const DEFAULT_COLLABORATION_EVENTS_ENDPOINT = "http://127.0.0.1:3000/api/ingest/collaborations/events";
const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  ".agent-insight",
  "collectors",
  "pi-agent",
  "config.json",
);

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`Cannot read Pi collector config ${filePath}: ${error.message}`);
  }
}

function loadCollectorConfig(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || env.AGENT_INSIGHT_USER_HOME || os.homedir();
  const configPath = env.AGENT_INSIGHT_PI_CONFIG ||
    options.configPath ||
    path.join(homeDir, ".agent-insight", "collectors", "pi-agent", "config.json");
  const file = readJsonIfExists(configPath);
  const apiKey = env.AGENT_INSIGHT_API_KEY || file.apiKey;
  const endpoint = env.AGENT_INSIGHT_OTLP_ENDPOINT || file.endpoint || DEFAULT_ENDPOINT;
  const collaborationSessionsEndpoint = env.AGENT_INSIGHT_PI_COLLABORATION_SESSIONS_ENDPOINT
    || file.collaborationSessionsEndpoint
    || DEFAULT_COLLABORATION_SESSIONS_ENDPOINT;
  const collaborationEventsEndpoint = env.AGENT_INSIGHT_PI_COLLABORATION_EVENTS_ENDPOINT
    || file.collaborationEventsEndpoint
    || DEFAULT_COLLABORATION_EVENTS_ENDPOINT;
  const enabled = file.enabled !== false && Boolean(apiKey);
  return {
    enabled,
    apiKey,
    endpoint,
    collaborationSessionsEndpoint,
    collaborationEventsEndpoint,
    goalPlusObserverEnabled: file.goalPlusObserverEnabled === true,
    goalPlusObserverConfigPath: file.goalPlusObserverConfigPath,
    configPath,
    homeDir,
    uploadIntervalMs: Number(file.uploadIntervalMs) || 5 * 60 * 1000,
    shutdownTimeoutMs: Math.min(2500, Math.max(100, Number(file.shutdownTimeoutMs) || 2200)),
  };
}

function resolveGoalPlusRuntimeRoot(cwd, env = process.env) {
  const workingDirectory = path.resolve(String(cwd || process.cwd()));
  const configured = String(env.GOAL_PLUS_ROOT || "").trim();
  if (!configured) return path.join(workingDirectory, ".gp");
  return path.isAbsolute(configured)
    ? path.resolve(configured)
    : path.resolve(workingDirectory, configured);
}

async function activateGoalPlusObserver(request, config) {
  const collector = require("../../goal-plus/goal-plus-collector.cjs");
  const goalPlusConfig = await collector.loadConfig({
    homeDir: config.homeDir,
    configPath: config.goalPlusObserverConfigPath,
  });
  return collector.activateGoalPlusSource(request.root, {
    goalId: request.goalId,
    nativeSessionId: request.nativeSessionId,
  }, goalPlusConfig);
}

function messageText(message) {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" || part?.type === "thinking")
    .map((part) => String(part.text || part.thinking || ""))
    .filter(Boolean)
    .join("\n");
}

function normalizeFilePath(filePath) {
  if (!filePath) return "";
  return path.resolve(String(filePath)).replaceAll("\\", "/").toLowerCase();
}

function readToolPath(args) {
  return args?.path || args?.filePath || args?.file_path || args?.filename || args?.target;
}

async function skillDetails(skill) {
  const source = await fsp.readFile(skill.filePath, "utf8");
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] || "";
  const version = /^\s*version\s*:\s*["']?([^"'\r\n]+)["']?\s*$/mi.exec(frontmatter)?.[1]?.trim();
  const baseDir = skill.baseDir || path.dirname(skill.filePath);
  return {
    version: version || sha256(source).slice(0, 12),
    output: [
      `Skill: ${skill.name}`,
      baseDir ? `Base directory: ${baseDir}` : "",
      "",
      source,
    ].filter(Boolean).join("\n"),
  };
}

async function skillVersion(skill) {
  return (await skillDetails(skill)).version;
}

function resultText(result) {
  return messageText(result) || safeContent(result?.content) || safeContent(result) || "";
}

function isGoalPlusStartCommand(value) {
  const match = /^\/(goal-plus|goal-plus-with-final-check)(?:\s+([\s\S]*))?$/i.exec(String(value || "").trim());
  if (!match) return false;
  const firstWord = String(match[2] || "").trim().split(/\s+/, 1)[0].toLowerCase();
  return !["edit", "summary", "pause", "resume", "clear"].includes(firstWord);
}

function structuredGoalPlusId(value, depth = 0, seen = new WeakSet()) {
  if (depth > 6 || value == null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
    try { return structuredGoalPlusId(JSON.parse(trimmed), depth + 1, seen); }
    catch { return undefined; }
  }
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  const direct = value.goal_plus_id || value.goalPlusId;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = structuredGoalPlusId(child, depth + 1, seen);
    if (found) return found;
  }
  return undefined;
}

function goalPlusIdFromStartPrompt(value) {
  const matches = [...String(value || "").matchAll(/^goal_plus_id:\s*([A-Za-z0-9_.:-]+)\s*$/gm)];
  return matches.length === 1 ? matches[0][1] : undefined;
}

function goalPlusStartIdFromContext(messages) {
  if (!Array.isArray(messages)) return undefined;
  let commandIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "custom" && messages[index]?.customType === "goal-plus-command-context") {
      commandIndex = index;
      break;
    }
  }
  if (commandIndex < 0 || messages.slice(commandIndex + 1).some(message => message?.role === "assistant")) {
    return undefined;
  }
  const goalPlusId = structuredGoalPlusId(messages[commandIndex]?.details);
  if (!goalPlusId) return undefined;
  let boundary = -1;
  for (let index = commandIndex - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant"
      || (messages[index]?.role === "custom" && messages[index]?.customType === "goal-plus-command-context")) {
      boundary = index;
      break;
    }
  }
  return messages.slice(boundary + 1, commandIndex).some(message => (
    message?.role === "custom"
      && message?.customType === "goal-plus-created"
      && structuredGoalPlusId(message.details) === goalPlusId
  )) ? goalPlusId : undefined;
}

function goalPlusCreatedIdFromCurrentContext(messages) {
  if (!Array.isArray(messages)) return undefined;
  let boundary = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      boundary = index;
      break;
    }
  }
  for (let index = messages.length - 1; index > boundary; index -= 1) {
    if (messages[index]?.role !== "custom" || messages[index]?.customType !== "goal-plus-created") continue;
    return structuredGoalPlusId(messages[index].details);
  }
  return undefined;
}

// Pi 的 subagent/skill 委派工具会 spawn 一个独立 `pi` 进程执行子任务：
//   pi --mode json -p --no-session [--model ..] [--tools ..] "Task: <task>"
// 该 worker 进程同样加载本采集器并独立上传一份事件，与主进程 subagent 事件的
// 派生记录重复（同一个 worker 被记成两条、且出现 "Task: " 前缀的假主记录）。
// 主进程的 subagent 事件已携带 worker 的完整 messages/usage，跳过 worker 进程
// 采集不影响数据完整性。识别条件用 worker 独有的组合：json 模式 + 非交互 +
// 不保存会话 + 以 "Task: " 前缀的 message 参数。
function isSubagentWorkerProcess(argv = process.argv) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  const hasFlag = (flag) => args.includes(flag);
  const modeIndex = args.indexOf("--mode");
  const jsonMode = modeIndex !== -1 && args[modeIndex + 1] === "json";
  const nonInteractive = hasFlag("-p") || hasFlag("--print");
  const noSession = hasFlag("--no-session");
  if (!(jsonMode && nonInteractive && noSession)) return false;
  return args.some((arg) => arg.startsWith("Task: "));
}

function minMessageTime(messages, fallback) {
  const times = (Array.isArray(messages) ? messages : [])
    .map((message) => Number(message?.timestamp))
    .filter((value) => Number.isFinite(value) && value > 0);
  return times.length ? Math.min(...times) : fallback;
}

function maxMessageTime(messages, fallback) {
  const times = (Array.isArray(messages) ? messages : [])
    .map((message) => Number(message?.timestamp))
    .filter((value) => Number.isFinite(value) && value > 0);
  return times.length ? Math.max(...times) : fallback;
}

class PiTraceCollector {
  constructor(options) {
    this.config = options.config;
    this.writer = options.writer || new DurableTraceWriter({
      framework: "pi-agent",
      apiKey: this.config.apiKey,
      homeDir: this.config.homeDir,
    });
    this.uploader = options.uploader || new DurableTraceUploader({
      framework: "pi-agent",
      apiKey: this.config.apiKey,
      endpoint: this.config.endpoint,
      homeDir: this.config.homeDir,
    });
    this.relationshipOutbox = options.relationshipOutbox || new DurableCollaborationOutbox({
      framework: "pi-agent",
      apiKey: this.config.apiKey,
      homeDir: this.config.homeDir,
      sessionsEndpoint: this.config.collaborationSessionsEndpoint,
      eventsEndpoint: this.config.collaborationEventsEndpoint,
    });
    this.now = options.now || Date.now;
    this.sessionId = "";
    this.traceId = "";
    this.turnSequence = 0;
    this.messageSequence = 0;
    this.rawInput = "";
    this.currentAgent = null;
    this.currentModel = null;
    this.activeTools = new Map();
    this.activeSkills = [];
    this.loadedSkills = [];
    this.lastOutput = "";
    this.errors = [];
    this.relationshipPending = Promise.resolve();
    this.goalPlusActivator = options.goalPlusActivator || activateGoalPlusObserver;
    this.goalPlusActivationPending = Promise.resolve();
    this.goalPlusActivated = new Set();
    this.runtimeCwd = process.cwd();
  }

  updateRuntimeContext(ctx) {
    if (typeof ctx?.cwd === "string" && ctx.cwd.trim()) this.runtimeCwd = path.resolve(ctx.cwd);
  }

  startSession(sessionId, ctx) {
    // Pi 的 sessionId 在整个交互会话内保持不变；若多个 agent 任务共享同一
    // sessionId，服务端会把多任务事件聚合成一条 ExecutionRecord 并相互覆盖。
    // 这里保存基 sessionId，并在 beginAgent 时为每个任务派生独立子 sessionId。
    this.baseSessionId = String(sessionId);
    this.sessionId = String(sessionId);
    this.traceId = stableTraceId("pi-agent", this.sessionId);
    this.updateRuntimeContext(ctx);
    this.uploader.start(this.config.uploadIntervalMs);
  }

  recordInput(text, source) {
    if (source === "extension") return;
    this.rawInput = String(text || "");
  }

  recordContext(messages, ctx) {
    if (!this.currentAgent) return;
    this.updateRuntimeContext(ctx);
    const goalPlusId = goalPlusStartIdFromContext(messages)
      || (this.currentAgent.goalPlusStart ? goalPlusCreatedIdFromCurrentContext(messages) : undefined);
    if (!goalPlusId) return;
    this.currentAgent.goalPlusStart = true;
    this.queueGoalPlusMainBinding(goalPlusId);
  }

  setModel(model) {
    this.currentModel = model ? {
      id: model.id || model.model || model.name,
      provider: model.provider,
    } : null;
  }

  beginAgent(event, ctx) {
    this.updateRuntimeContext(ctx);
    if (!this.sessionId) this.startSession(ctx.sessionManager.getSessionId());
    // 每个 agent 任务独立 sessionId（基于 Pi 会话 sessionId + agent 序号），
    // 使服务端按 session 聚合出独立 ExecutionRecord，避免多任务相互覆盖。
    if (this.baseSessionId) {
      this.sessionId = `${this.baseSessionId}__task${this.turnSequence}`;
      this.traceId = stableTraceId("pi-agent", this.sessionId);
    }
    const startedAt = this.now();
    const spanId = stableSpanId(this.sessionId, "agent", this.turnSequence);
    this.turnSequence += 1;
    this.messageSequence = 0;
    this.lastOutput = "";
    this.loadedSkills = Array.isArray(event.systemPromptOptions?.skills)
      ? event.systemPromptOptions.skills
      : [];
    this.currentAgent = {
      spanId,
      startedAt,
      input: event.prompt,
      model: ctx.model?.id || ctx.model?.model || this.currentModel?.id,
      provider: ctx.model?.provider || this.currentModel?.provider,
      goalPlusStart: isGoalPlusStartCommand(this.rawInput),
      goalPlusBindingQueued: false,
      goalPlusId: undefined,
    };
    if (this.currentAgent.goalPlusStart) {
      const goalPlusId = structuredGoalPlusId(event) || goalPlusIdFromStartPrompt(event.prompt);
      if (goalPlusId) this.queueGoalPlusMainBinding(goalPlusId);
    }

    const explicit = /^\/skill:([a-z0-9-]+)(?:\s|$)/i.exec(this.rawInput.trim());
    if (explicit) {
      const skill = this.loadedSkills.find((item) => item.name === explicit[1]);
      this.beginSkill(skill || { name: explicit[1] }, "explicit", startedAt);
    }
  }

  beginSkill(skill, triggerMode, startedAt = this.now()) {
    if (!this.currentAgent || !skill?.name) return null;
    const existing = this.activeSkills.find((item) => item.name === skill.name);
    if (existing) return existing;
    const span = {
      name: skill.name,
      filePath: skill.filePath,
      triggerMode,
      startedAt,
      spanId: stableSpanId(
        this.sessionId,
        this.currentAgent.spanId,
        "skill",
        skill.name,
        this.activeSkills.length,
      ),
      detailsPromise: skill.filePath
        ? skillDetails(skill).catch(() => ({ version: "unknown", output: "" }))
        : Promise.resolve({ version: "unknown", output: "" }),
    };
    this.activeSkills.push(span);
    // Skill 的版本解析可能读取磁盘，不能把「开始」事件拖到整个 Agent 收口时才写出。
    // 先以稳定 spanId 写入 running 快照；settleAgent 会用同一 eventId 写入完整快照，
    // 服务端按 spanId 收敛为最后状态，实时链路仍能保持真实的开始顺序。
    this.append({
      eventId: stableEventId(this.sessionId, span.spanId),
      sessionId: this.sessionId,
      traceId: this.traceId,
      spanId: span.spanId,
      parentSpanId: this.currentAgent.spanId,
      kind: "skill",
      name: `skill.${span.name}`,
      startTimeMs: span.startedAt,
      endTimeMs: span.startedAt,
      status: "running",
      input: this.currentAgent.input,
      output: "",
      skill: {
        name: span.name,
        version: "unknown",
        triggerMode: span.triggerMode,
      },
    });
    this.writer.flush()
      .then(() => this.uploader.flushOnce())
      .catch((error) => this.errors.push(error));
    return span;
  }

  detectAutomaticSkill(toolName, args, startedAt) {
    if (String(toolName).toLowerCase() !== "read") return null;
    const target = normalizeFilePath(readToolPath(args));
    if (!target) return null;
    const skill = this.loadedSkills.find((item) => normalizeFilePath(item.filePath) === target);
    return skill ? this.beginSkill(skill, "automatic", startedAt) : null;
  }

  ownerSpanId() {
    return this.activeSkills[this.activeSkills.length - 1]?.spanId || this.currentAgent?.spanId;
  }

  beginTool(event) {
    if (!this.currentAgent) return;
    const startedAt = this.now();
    this.detectAutomaticSkill(event.toolName, event.args, startedAt);
    const tool = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
      startedAt,
      parentSpanId: this.ownerSpanId(),
      spanId: stableSpanId(this.sessionId, "tool", event.toolCallId),
    };
    this.activeTools.set(event.toolCallId, tool);
  }

  endTool(event) {
    if (!this.currentAgent) return;
    const started = this.activeTools.get(event.toolCallId) || {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: undefined,
      startedAt: this.now(),
      parentSpanId: this.ownerSpanId(),
      spanId: stableSpanId(this.sessionId, "tool", event.toolCallId),
    };
    this.activeTools.delete(event.toolCallId);
    const endedAt = this.now();
    const toolType = classifyTool(started.toolName);
    const mcp = parseMcpIdentity(started.toolName, started.args, event.result);
    this.append({
      eventId: stableEventId(this.sessionId, started.spanId),
      sessionId: this.sessionId,
      traceId: this.traceId,
      spanId: started.spanId,
      parentSpanId: started.parentSpanId,
      kind: mcp ? "mcp" : "tool",
      name: `tool.${started.toolName}`,
      startTimeMs: started.startedAt,
      endTimeMs: endedAt,
      status: event.isError ? "error" : "success",
      error: event.isError ? resultText(event.result) : undefined,
      tool: {
        name: started.toolName,
        type: toolType,
        arguments: started.args,
        result: event.result,
      },
      mcp,
    });
    if (String(started.toolName).toLowerCase() === "subagent") {
      this.emitSubagentResults(event.result?.details, started.spanId, event.toolCallId, started.startedAt);
    }
    if (this.currentAgent.goalPlusStart
      && String(started.toolName).toLowerCase().startsWith("goal_plus")) {
      const goalPlusId = structuredGoalPlusId(started.args) || structuredGoalPlusId(event.result);
      if (goalPlusId) this.queueGoalPlusMainBinding(goalPlusId);
    }
  }

  queueGoalPlusMainBinding(goalPlusId) {
    if (!this.currentAgent?.goalPlusStart || !this.baseSessionId) return;
    this.currentAgent.goalPlusId = goalPlusId;
    this.queueGoalPlusActivation(goalPlusId);
    if (this.currentAgent.goalPlusBindingQueued) return;
    this.currentAgent.goalPlusBindingQueued = true;
    const binding = goalPlusMainBinding(this.baseSessionId, goalPlusId, this.sessionId);
    this.relationshipPending = this.relationshipPending
      .then(() => this.relationshipOutbox.enqueueSession(binding))
      .catch((error) => this.errors.push(error));
  }

  queueGoalPlusActivation(goalPlusId) {
    if (this.config.goalPlusObserverEnabled !== true || !this.baseSessionId || !goalPlusId) return;
    const root = resolveGoalPlusRuntimeRoot(this.runtimeCwd);
    const key = [root, goalPlusId, this.baseSessionId].join("\0");
    if (this.goalPlusActivated.has(key)) return;
    this.goalPlusActivationPending = this.goalPlusActivationPending
      .then(async () => {
        if (this.goalPlusActivated.has(key)) return;
        await this.goalPlusActivator({
          root,
          goalId: goalPlusId,
          nativeSessionId: this.baseSessionId,
        }, this.config);
        this.goalPlusActivated.add(key);
      })
      .catch((error) => this.errors.push(error));
  }

  recordMessage(message) {
    if (!this.currentAgent || message?.role !== "assistant") return;
    const startedAt = Number(message.timestamp) || this.now();
    const content = messageText(message);
    if (content) this.lastOutput = content;
    const model = message.responseModel || message.model || this.currentAgent.model;
    const usage = usageFrom(message);
    const spanId = stableSpanId(
      this.sessionId,
      this.currentAgent.spanId,
      "llm",
      this.messageSequence,
    );
    this.messageSequence += 1;
    this.append({
      eventId: stableEventId(this.sessionId, spanId),
      sessionId: this.sessionId,
      traceId: this.traceId,
      spanId,
      parentSpanId: this.ownerSpanId(),
      kind: "llm",
      name: `llm.${model || "unknown"}`,
      startTimeMs: startedAt,
      endTimeMs: this.now(),
      status: message.stopReason === "error" ? "error" : "success",
      error: message.errorMessage,
      input: this.rawInput,
      output: content,
      model,
      provider: message.provider || this.currentAgent.provider,
      usage,
      attributes: {
        "pi.stop_reason": message.stopReason,
        "pi.usage.cache_read": usage.cacheRead,
        "pi.usage.cache_write": usage.cacheWrite,
      },
    });
  }

  recordAgentEnd(event) {
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role !== "assistant") continue;
      const text = messageText(messages[index]);
      if (text) this.lastOutput = text;
      break;
    }
  }

  emitSubagentResults(details, parentSpanId, toolCallId, fallbackStartedAt, ancestry = []) {
    const results = Array.isArray(details?.results) ? details.results : [];
    results.forEach((result, index) => {
      const discriminator = [toolCallId, index, result?.step, result?.agent].join(":");
      if (ancestry.includes(discriminator)) return;
      const messages = Array.isArray(result?.messages) ? result.messages : [];
      const startedAt = minMessageTime(messages, fallbackStartedAt);
      const endedAt = maxMessageTime(messages, this.now());
      const childSpanId = stableSpanId(
        this.sessionId,
        "subagent",
        toolCallId,
        index,
        result?.step,
        result?.agent,
      );
      const usage = usageFrom(result);
      this.append({
        eventId: stableEventId(this.sessionId, childSpanId),
        sessionId: this.sessionId,
        traceId: this.traceId,
        spanId: childSpanId,
        parentSpanId,
        kind: "subagent",
        name: `agent.${result?.agent || "subagent"}`,
        startTimeMs: startedAt,
        endTimeMs: endedAt,
        status: Number(result?.exitCode) === 0 ? "success" : "error",
        error: result?.errorMessage || result?.stderr,
        input: result?.task,
        output: this.lastAssistantText(messages),
        model: result?.model,
        usage,
        attributes: {
          "pi.subagent.name": result?.agent,
          "pi.subagent.step": result?.step,
          "pi.subagent.exit_code": result?.exitCode,
        },
      });

      let lastLlmSpanId = childSpanId;
      let assistantIndex = 0;
      // worker 的 assistant 消息只有完成时间戳、没有独立的开始时间。用相邻消息
      // 时间戳推算 LLM 时长：第 i 条 LLM 的 [start, end] = [上一条 assistant 的
      // 完成时刻, 本条完成时刻]；首条从工具开始时刻（fallbackStartedAt）算起，
      // 保证早于首条消息完成时刻、时长非 0。多条 LLM 时长合起来覆盖整个 span。
      let prevAssistantTs = fallbackStartedAt;
      for (const message of messages) {
        if (message?.role === "assistant") {
          const llmSpanId = stableSpanId(childSpanId, "llm", assistantIndex);
          assistantIndex += 1;
          const assistantUsage = usageFrom(message);
          const completedAt = Number(message.timestamp) || endedAt;
          this.append({
            eventId: stableEventId(this.sessionId, llmSpanId),
            sessionId: this.sessionId,
            traceId: this.traceId,
            spanId: llmSpanId,
            parentSpanId: childSpanId,
            kind: "llm",
            name: `llm.${message.responseModel || message.model || result?.model || "unknown"}`,
            startTimeMs: prevAssistantTs,
            endTimeMs: completedAt,
            status: message.stopReason === "error" ? "error" : "success",
            error: message.errorMessage,
            output: messageText(message),
            model: message.responseModel || message.model || result?.model,
            provider: message.provider,
            usage: assistantUsage,
            attributes: {
              "pi.usage.cache_read": assistantUsage.cacheRead,
              "pi.usage.cache_write": assistantUsage.cacheWrite,
            },
          });
          lastLlmSpanId = llmSpanId;
          prevAssistantTs = completedAt;
          continue;
        }
        if (message?.role !== "toolResult") continue;
        const nestedSpanId = stableSpanId(childSpanId, "tool", message.toolCallId);
        const nestedMcp = parseMcpIdentity(message.toolName, undefined, message);
        this.append({
          eventId: stableEventId(this.sessionId, nestedSpanId),
          sessionId: this.sessionId,
          traceId: this.traceId,
          spanId: nestedSpanId,
          parentSpanId: lastLlmSpanId,
          kind: nestedMcp ? "mcp" : "tool",
          name: `tool.${message.toolName}`,
          startTimeMs: Number(message.timestamp) || startedAt,
          endTimeMs: Number(message.timestamp) || endedAt,
          status: message.isError ? "error" : "success",
          tool: {
            name: message.toolName,
            type: classifyTool(message.toolName),
            result: message,
          },
          mcp: nestedMcp,
        });
        if (String(message.toolName).toLowerCase() === "subagent") {
          this.emitSubagentResults(
            message.details,
            nestedSpanId,
            message.toolCallId,
            Number(message.timestamp) || startedAt,
            [...ancestry, discriminator],
          );
        }
      }
    });
  }

  lastAssistantText(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "assistant") return messageText(messages[index]);
    }
    return "";
  }

  async settleAgent() {
    if (!this.currentAgent) return;
    const endedAt = this.now();
    const agent = this.currentAgent;
    if (agent.goalPlusId) this.queueGoalPlusActivation(agent.goalPlusId);
    for (const skill of this.activeSkills) {
      const details = await skill.detailsPromise;
      this.append({
        eventId: stableEventId(this.sessionId, skill.spanId),
        sessionId: this.sessionId,
        traceId: this.traceId,
        spanId: skill.spanId,
        parentSpanId: agent.spanId,
        kind: "skill",
        name: `skill.${skill.name}`,
        startTimeMs: skill.startedAt,
        endTimeMs: endedAt,
        status: "success",
        input: agent.input,
        output: details.output,
        skill: {
          name: skill.name,
          version: details.version,
          triggerMode: skill.triggerMode,
        },
      });
    }
    this.append({
      eventId: stableEventId(this.sessionId, agent.spanId),
      sessionId: this.sessionId,
      traceId: this.traceId,
      spanId: agent.spanId,
      kind: "agent",
      name: "agent.pi",
      startTimeMs: agent.startedAt,
      endTimeMs: endedAt,
      status: "success",
      input: agent.input,
      output: this.lastOutput,
      model: agent.model,
      provider: agent.provider,
    });
    this.activeSkills = [];
    this.activeTools.clear();
    this.currentAgent = null;
    await this.writer.flush();
    await this.relationshipPending;
    this.uploader.flushOnce().catch((error) => this.errors.push(error));
    this.relationshipOutbox.flushOnce().catch((error) => this.errors.push(error));
  }

  append(event) {
    this.writer.append(event).catch((error) => this.errors.push(error));
  }

  async shutdown() {
    this.uploader.stop();
    if (this.currentAgent) await this.settleAgent();
    await this.writer.flush();
    await this.relationshipPending;
    await Promise.race([
      this.goalPlusActivationPending,
      new Promise((resolve) => setTimeout(resolve, this.config.shutdownTimeoutMs)),
    ]);
    const upload = Promise.all([
      this.uploader.flushOnce(),
      this.relationshipOutbox.flushOnce(),
    ]).catch((error) => {
      this.errors.push(error);
    });
    await Promise.race([
      upload,
      new Promise((resolve) => setTimeout(resolve, this.config.shutdownTimeoutMs)),
    ]);
  }
}

function createCollector(options = {}) {
  const config = options.config || loadCollectorConfig(options);
  if (!config.enabled) return null;
  if (isSubagentWorkerProcess(options.argv)) return null;
  return new PiTraceCollector({ ...options, config });
}

async function selfCheck(options = {}) {
  const config = options.config || loadCollectorConfig(options);
  if (!config.enabled) {
    return { ok: false, checks: { configured: false }, configPath: config.configPath };
  }
  const stateDir = collectorStateDir("pi-agent", config.apiKey, config.homeDir);
  await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const probe = path.join(stateDir, ".self-check");
  await atomicWriteJson(probe, { checkedAt: new Date().toISOString() });
  await fsp.unlink(probe);
  const relationshipOutbox = new DurableCollaborationOutbox({
    framework: "pi-agent",
    apiKey: config.apiKey,
    homeDir: config.homeDir,
    sessionsEndpoint: config.collaborationSessionsEndpoint,
    eventsEndpoint: config.collaborationEventsEndpoint,
  });
  const relationshipStatus = await relationshipOutbox.status();
  return {
    ok: relationshipStatus.rejected === 0,
    checks: {
      configured: true,
      endpoint: /^https?:\/\//.test(config.endpoint),
      collaborationSessionsEndpoint: /^https?:\/\//.test(config.collaborationSessionsEndpoint),
      collaborationEventsEndpoint: /^https?:\/\//.test(config.collaborationEventsEndpoint),
      spoolWritable: true,
      relationshipRejected: relationshipStatus.rejected === 0,
    },
    configPath: config.configPath,
    stateDir,
    endpoint: config.endpoint,
    relationshipStatus,
  };
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  DEFAULT_ENDPOINT,
  DEFAULT_COLLABORATION_EVENTS_ENDPOINT,
  DEFAULT_COLLABORATION_SESSIONS_ENDPOINT,
  PiTraceCollector,
  classifyTool,
  createCollector,
  isSubagentWorkerProcess,
  isGoalPlusStartCommand,
  loadCollectorConfig,
  messageText,
  parseMcpIdentity,
  resolveGoalPlusRuntimeRoot,
  selfCheck,
  structuredGoalPlusId,
  goalPlusIdFromStartPrompt,
  goalPlusCreatedIdFromCurrentContext,
  goalPlusStartIdFromContext,
  skillVersion,
  usageFrom,
};
