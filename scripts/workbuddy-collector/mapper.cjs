/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * WorkBuddy (Windows 桌面版) trace → Agent Insight canonical events 映射。
 *
 * 纯函数模块，不做任何 I/O，便于单元测试。采集器（collector.mjs）负责读文件、
 * 关联 sessionId / mode / 用户原文，再把结果交给这里转换。
 *
 * WorkBuddy 本地 trace 文件结构（~/.workbuddy/traces/<pid>/trace_<uuid>.json）：
 *   { trace: { traceId, name, startedAt, endedAt, duration, status, ... },
 *     spans: [
 *       { type:"agent",      spanId, parentId, name, agentName, startedAt, endedAt, status },
 *       { type:"generation", spanId, parentId, toolInput(messages[]), toolOutput([{model,choices,usage}]) },
 *       { type:"function",   spanId, parentId, toolName, toolInput(args), toolOutput({title,content,renderer}) },
 *       { type:"custom",     spanId, parentId, name:"mcp_tools", ... },
 *     ] }
 *
 * 关键事实（均经真实样本验证）：
 * - 每个 generation span 的 toolOutput 内嵌模型 API 原始响应，含精确 usage
 *   （prompt_tokens / completion_tokens / total_tokens / cached_tokens / reasoning_tokens）
 *   与 model，因此逐轮 token 拆分是可获取的真实值，无需估算。
 * - function span 是真实工具调用；custom/mcp_tools 是无 I/O 的发现类 span。
 */

const crypto = require("node:crypto");

const FRAMEWORK = "workbuddy";

function sha256Hex(value, length) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, length);
}

function toMs(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asText(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim() ? value : undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/** 从 generation.toolOutput 里抽取模型 API 响应对象（兼容数组 / 单对象两种形态）。 */
function firstResponseObject(toolOutput) {
  const parsed = parseMaybeJson(toolOutput);
  if (Array.isArray(parsed)) {
    return parsed.find((item) => item && typeof item === "object") || undefined;
  }
  if (parsed && typeof parsed === "object") return parsed;
  return undefined;
}

/**
 * 归一化 usage：
 *   input     ← prompt_tokens
 *   output    ← completion_tokens
 *   reasoning ← completion_tokens_details.reasoning_tokens（顶层 reasoning_tokens 常为 0）
 *   total     ← total_tokens（缺失时回退 input+output）
 *   cache     ← prompt_tokens_details.cached_tokens
 * 返回 undefined 表示该 span 没有可用 usage（不编造 0）。
 */
function normalizeUsage(rawUsage) {
  if (!rawUsage || typeof rawUsage !== "object") return undefined;
  const num = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  const input = num(rawUsage.prompt_tokens ?? rawUsage.input_tokens);
  const output = num(rawUsage.completion_tokens ?? rawUsage.output_tokens);
  const promptDetails = rawUsage.prompt_tokens_details || {};
  const completionDetails = rawUsage.completion_tokens_details || {};
  const reasoning = num(completionDetails.reasoning_tokens ?? rawUsage.reasoning_tokens);
  const cache = num(promptDetails.cached_tokens ?? rawUsage.cached_tokens);
  const totalRaw = rawUsage.total_tokens;
  const total = Number.isFinite(Number(totalRaw)) ? Number(totalRaw) : input + output;
  if (!input && !output && !total) return undefined;
  return { input, output, reasoning: reasoning || undefined, total, cache: cache || undefined };
}

/** 从 generation.toolInput 的 messages[] 里取最后一条 user 文本，作为兜底用户提问。 */
function lastUserTextFromMessages(toolInput) {
  const parsed = parseMaybeJson(toolInput);
  if (!Array.isArray(parsed)) return undefined;
  for (let i = parsed.length - 1; i >= 0; i -= 1) {
    const message = parsed[i];
    if (!message || message.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const textPart = content.find((part) => part && part.type === "text" && part.text);
      if (textPart) return textPart.text;
    }
  }
  return undefined;
}

function completionTextFromResponse(responseObject) {
  const choice = responseObject?.choices?.[0];
  const message = choice?.message;
  if (message && typeof message.content === "string") return message.content;
  if (typeof responseObject?.output_text === "string") return responseObject.output_text;
  return undefined;
}

/**
 * @param {object} traceDoc  解析后的 WorkBuddy trace 文件对象 { trace, spans }
 * @param {object} enrichment
 *   - sessionId    {string}  必填：WorkBuddy 会话 id（归并键 / task_id）
 *   - mode         {string=} 会话模式 ask/craft/work（来自 D3 sdk 会话日志）
 *   - userPrompt   {string=} 用户原始提问（来自 D3；缺失时回退 generation.toolInput）
 *   - workbuddyVersion {string=} WorkBuddy 版本（来自 D2 心跳）
 *   - sessionTotals {object=} 来自 D4 session_usage：{ used, size } —— 会话级上下文占用快照
 *   - sessionResolution {string=} 'exact' | 'degraded'（心跳缺失兜底时标记）
 * @returns {Array<object>} canonical events（可直接交给 DurableTraceWriter.append）
 */
function mapWorkBuddyTrace(traceDoc, enrichment) {
  const sessionId = enrichment && enrichment.sessionId;
  if (!sessionId) throw new Error("mapWorkBuddyTrace: sessionId is required");
  const trace = (traceDoc && traceDoc.trace) || {};
  const spans = Array.isArray(traceDoc && traceDoc.spans) ? traceDoc.spans : [];
  const traceId = trace.traceId || `trace_${sha256Hex(JSON.stringify(traceDoc || {}), 24)}`;
  const traceStart = toMs(trace.startedAt) || Date.now();
  const traceEnd = toMs(trace.endedAt) || traceStart;

  const events = [];

  // 合成根 chain 事件：承载该轮的用户原文、模式、会话级 token 快照，
  // 并作为所有 parentId=null 顶层 span 的父节点，保持调用树完整。
  const rootSpanId = `wb_root_${sha256Hex(traceId, 20)}`;
  const userPrompt = asText(enrichment.userPrompt) ||
    lastUserTextFromMessages(spans.find((s) => s && s.type === "generation")?.toolInput);
  const sessionTotals = enrichment.sessionTotals || {};
  // mcp_tools 等 custom span 是无 I/O 的发现类基础设施 span（单条 trace 常有几十个），
  // 属于噪声，不作为工具调用逐条上报；仅在根节点记一个计数，保持 trace 清爽。
  const mcpToolsSpanCount = spans.filter((s) => s && s.type === "custom").length;
  const rootAttributes = {
    "workbuddy.span.type": "workflow",
    "workbuddy.trace_id": traceId,
    "workbuddy.mode": asText(enrichment.mode),
    "workbuddy.version": asText(enrichment.workbuddyVersion),
    "workbuddy.session_resolution": asText(enrichment.sessionResolution) || "exact",
    // 会话级上下文占用快照（当前占用 / 上下文窗口上限），非逐轮消耗。
    "workbuddy.session.total_tokens": Number.isFinite(Number(sessionTotals.used))
      ? Number(sessionTotals.used) : undefined,
    "workbuddy.context_window": Number.isFinite(Number(sessionTotals.size))
      ? Number(sessionTotals.size) : undefined,
    "workbuddy.mcp_tools_span_count": mcpToolsSpanCount || undefined,
  };
  if (userPrompt) {
    rootAttributes["workbuddy.user_prompt"] = userPrompt;
    rootAttributes["input.value"] = userPrompt;
    rootAttributes["gen_ai.prompt"] = userPrompt;
  }
  events.push({
    sessionId,
    traceId,
    spanId: rootSpanId,
    kind: "chain",
    name: asText(trace.name) || "Agent workflow",
    input: userPrompt,
    status: trace.status === "error" ? "error" : "ok",
    startTimeMs: traceStart,
    endTimeMs: traceEnd,
    attributes: rootAttributes,
  });

  for (const span of spans) {
    if (!span || typeof span !== "object") continue;
    const spanId = span.spanId || `wb_span_${sha256Hex(JSON.stringify(span), 16)}`;
    const parentSpanId = span.parentId || rootSpanId;
    const startTimeMs = toMs(span.startedAt) || traceStart;
    const endTimeMs = toMs(span.endedAt) || startTimeMs;
    const status = span.status === "error" || span.error ? "error" : "ok";
    const error = asText(span.error);
    const base = {
      sessionId,
      traceId,
      spanId,
      parentSpanId,
      startTimeMs,
      endTimeMs,
      status,
      error,
    };

    if (span.type === "agent") {
      events.push({
        ...base,
        kind: "agent",
        name: asText(span.agentName) || asText(span.name) || "agent",
        attributes: {
          "workbuddy.span.type": "agent",
          "workbuddy.agent.name": asText(span.agentName) || asText(span.name),
        },
      });
      continue;
    }

    if (span.type === "generation") {
      const responseObject = firstResponseObject(span.toolOutput);
      const usage = normalizeUsage(responseObject && responseObject.usage);
      const model = asText(responseObject && responseObject.model);
      const completion = completionTextFromResponse(responseObject);
      const prompt = lastUserTextFromMessages(span.toolInput);
      events.push({
        ...base,
        kind: "llm",
        name: asText(span.name) || "generation",
        model,
        provider: FRAMEWORK,
        input: prompt || asText(span.toolInput),
        output: completion || asText(span.toolOutput),
        usage: usage
          ? { input: usage.input, output: usage.output, reasoning: usage.reasoning, total: usage.total }
          : undefined,
        attributes: {
          "workbuddy.span.type": "generation",
          "workbuddy.cache_read_tokens": usage ? usage.cache : undefined,
        },
      });
      continue;
    }

    if (span.type === "custom") {
      // 无 I/O 的发现类 span：跳过逐条上报（计数已记在根节点）。
      continue;
    }

    if (span.type === "function") {
      const toolName = asText(span.toolName) || asText(span.name) || "tool";
      const args = parseMaybeJson(span.toolInput);
      const outputParsed = parseMaybeJson(span.toolOutput);
      const resultText = outputParsed && typeof outputParsed === "object"
        ? asText(outputParsed.content ?? outputParsed)
        : asText(outputParsed);
      events.push({
        ...base,
        kind: "tool",
        name: toolName,
        input: asText(span.toolInput),
        output: resultText,
        tool: {
          name: toolName,
          type: "function",
          arguments: args,
          result: resultText,
        },
        attributes: {
          "workbuddy.span.type": "function",
          "tool.name": toolName,
        },
      });
      continue;
    }

    // 其它未知 span 类型：保守保留为 mcp kind，避免静默丢数据。
    events.push({
      ...base,
      kind: "mcp",
      name: asText(span.name) || asText(span.type) || "span",
      tool: { name: asText(span.name) || asText(span.type) || "span", type: "mcp" },
      attributes: {
        "workbuddy.span.type": asText(span.type) || "unknown",
        "tool.name": asText(span.name) || asText(span.type) || "span",
      },
    });
  }

  return events;
}

module.exports = {
  FRAMEWORK,
  mapWorkBuddyTrace,
  // 导出内部工具，便于单测
  normalizeUsage,
  firstResponseObject,
  lastUserTextFromMessages,
  completionTextFromResponse,
};
