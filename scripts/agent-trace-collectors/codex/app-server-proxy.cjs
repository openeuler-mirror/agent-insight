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

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { once } = require("node:events");

const { stableEventId } = require("../shared/trace-transport.cjs");
const { classifyCodexSource } = require("./source-classifier.cjs");

function text(value) {
  if (value === undefined || value === null) return undefined;
  const result = String(value).trim();
  return result || undefined;
}

function inputText(value) {
  if (typeof value === "string") return text(value);
  if (!Array.isArray(value)) return text(value?.text || value?.content || value?.prompt);
  const parts = [];
  for (const item of value) {
    const candidate = inputText(item?.text ?? item?.content ?? item);
    if (candidate) parts.push(candidate);
  }
  return parts.join("\n") || undefined;
}

function resultTurnId(result) {
  return text(result?.turn?.id || result?.turnId || result?.id);
}

function eventFor(observer, eventType, request, extra = {}) {
  const params = request?.params || {};
  const sourceThreadId = text(extra.sourceThreadId || params.threadId || params.thread_id || observer.threadId);
  if (!sourceThreadId) return undefined;
  const sourceExecutionId = text(extra.sourceExecutionId || params.turnId || params.turn_id || params.expectedTurnId);
  return {
    eventId: stableEventId("codex-app-server", request?.id, eventType, sourceThreadId, sourceExecutionId, extra.sourceItemId),
    eventType,
    source: "app_server",
    sourceKind: observer.sourceKind,
    sourceThreadId,
    sourceExecutionId,
    sourceItemId: extra.sourceItemId,
    clientMessageId: text(params.clientMessageId || params.client_message_id),
    timestampMs: extra.timestampMs || observer.now(),
    inputKind: extra.inputKind,
    status: extra.status,
    payload: extra.payload || {},
    provenance: {
      direct: true,
      confidence: "direct",
      protocolVersion: observer.protocolVersion,
    },
  };
}

function createAppServerProtocolObserver(options = {}) {
  const observer = {
    now: options.now || Date.now,
    onEvent: options.onEvent || (async () => undefined),
    sourceKind: "app_server",
    protocolVersion: undefined,
    threadId: undefined,
    pending: new Map(),
    diagnostics: { malformed: 0, protocolErrors: 0, unknownNotifications: 0, observeErrors: 0 },
  };

  async function emit(event) {
    if (event) await observer.onEvent(event);
    return event;
  }

  async function observeMessage(message, direction = "server") {
    if (!message || typeof message !== "object") return [];
    const emitted = [];
    if (direction === "client" && message.method === "initialize") {
      const info = message.params?.clientInfo || message.params?.client_info || {};
      const classified = classifyCodexSource({ clientName: info.name || info.clientName }).sourceKind;
      if (classified !== "unknown") observer.sourceKind = classified;
      observer.protocolVersion = text(message.params?.protocolVersion || message.params?.protocol_version);
    }
    if (direction === "client" && message.id !== undefined && message.method) {
      observer.pending.set(String(message.id), message);
      return emitted;
    }
    if (direction === "client" && message.method === "thread/start") {
      const threadId = text(message.params?.threadId || message.params?.thread_id);
      if (threadId) observer.threadId = threadId;
      return emitted;
    }
    if (direction === "client" && message.method === "thread/resume") {
      const threadId = text(message.params?.threadId || message.params?.thread_id);
      if (threadId) observer.threadId = threadId;
      return emitted;
    }
    if (direction === "server" && message.error) {
      observer.diagnostics.protocolErrors += 1;
      observer.pending.delete(String(message.id));
      return emitted;
    }
    if (direction === "server" && message.id !== undefined && observer.pending.has(String(message.id))) {
      const request = observer.pending.get(String(message.id));
      observer.pending.delete(String(message.id));
      const result = message.result || {};
      if (request.method === "thread/start" || request.method === "thread/resume") {
        observer.threadId = text(result.thread?.id || result.threadId || result.id || request.params?.threadId || observer.threadId);
        if (observer.threadId) emitted.push({
          eventId: stableEventId("codex-app-server", request.id, "thread_started", observer.threadId),
          eventType: "thread_started",
          source: "app_server",
          sourceKind: observer.sourceKind,
          sourceThreadId: observer.threadId,
          timestampMs: observer.now(),
          payload: { method: request.method },
          provenance: { direct: true, confidence: "direct", protocolVersion: observer.protocolVersion },
        });
      } else if (request.method === "turn/start") {
        const turnId = resultTurnId(result) || text(request.params?.turnId);
        if (turnId) {
          emitted.push(eventFor(observer, "execution_started", request, {
            sourceExecutionId: turnId,
            payload: { input: inputText(request.params?.input || request.params?.prompt) },
          }));
          emitted.push(eventFor(observer, "user_input_accepted", request, {
            sourceExecutionId: turnId,
            inputKind: "initial",
            payload: { content: inputText(request.params?.input || request.params?.prompt) },
          }));
        }
      } else if (request.method === "turn/steer") {
        const turnId = resultTurnId(result) || text(request.params?.expectedTurnId || request.params?.turnId);
        if (turnId) emitted.push(eventFor(observer, "user_input_accepted", request, {
          sourceExecutionId: turnId,
          inputKind: "steer",
          payload: { content: inputText(request.params?.input || request.params?.prompt) },
        }));
      } else if (request.method === "turn/interrupt") {
        const turnId = text(request.params?.expectedTurnId || request.params?.turnId);
        if (turnId) emitted.push(eventFor(observer, "execution_interrupted", request, {
          sourceExecutionId: turnId,
          payload: { reason: "interrupted" },
        }));
      }
      for (const event of emitted) await emit(event);
      return emitted.filter(Boolean);
    }
    if (direction === "server" && message.method) {
      const params = message.params || {};
      const item = params.item || params;
      const itemType = text(item.type || params.itemType);
      const itemId = text(item.id || params.itemId);
      if (message.method === "item/started" && itemType === "contextCompaction") {
        const event = eventFor(observer, "context_compaction_started", { params }, {
          sourceItemId: itemId,
          payload: { itemType },
        });
        await emit(event);
        return event ? [event] : [];
      }
      if (message.method === "item/completed" && itemType === "contextCompaction") {
        const event = eventFor(observer, "context_compaction_completed", { params }, {
          sourceItemId: itemId,
          payload: { itemType },
        });
        await emit(event);
        return event ? [event] : [];
      }
      if (message.method === "thread/compacted") {
        const event = eventFor(observer, "context_compaction_completed", { params }, {
          sourceItemId: itemId || text(params.windowId || params.window_id),
          payload: { legacy: true },
        });
        await emit(event);
        return event ? [event] : [];
      }
      // 446-6：turn/completed 是 proxy-only 部署（未启用 rollout）唯一的 turn 终态
      // 通知；不处理会让执行永远停留在 in_progress。turn.status 映射：
      // interrupt/cancel/abort → 中断；fail/error → 失败；其余（含缺省）→ 完成。
      if (message.method === "turn/completed") {
        const turn = params.turn || {};
        const turnId = text(turn.id || params.turnId || params.turn_id);
        const rawStatus = text(turn.status) || "completed";
        if (/interrupt|cancel|abort/i.test(rawStatus)) {
          const event = eventFor(observer, "execution_interrupted", { params }, {
            sourceExecutionId: turnId,
            payload: { reason: rawStatus },
          });
          await emit(event);
          return event ? [event] : [];
        }
        const failed = /fail|error/i.test(rawStatus);
        const event = eventFor(observer, "execution_completed", { params }, {
          sourceExecutionId: turnId,
          status: failed ? "failed" : "completed",
          payload: { status: failed ? "failed" : "completed" },
        });
        await emit(event);
        return event ? [event] : [];
      }
      observer.diagnostics.unknownNotifications += 1;
    }
    return emitted;
  }

  async function observeLine(line, direction) {
    // 446-2：JSON 解析错误在此计数；observeMessage 的异步 rejection 刻意留在
    // 返回的 Promise 上，由转发层（forwardJsonLines 的 observeSafely）兜住并
    // 计入 diagnostics，不上抛阻断协议转发。
    let message;
    try {
      message = JSON.parse(String(line));
    } catch {
      observer.diagnostics.malformed += 1;
      return [];
    }
    return observeMessage(message, direction);
  }

  return { ...observer, observeLine, observeMessage };
}

async function writeLine(output, line) {
  if (output.write(`${line}\n`)) return;
  await once(output, "drain");
}

async function forwardJsonLines(input, output, direction, observer) {
  const reader = createInterface({ input, crlfDelay: Infinity });
  // 446-2：转发先于观测，观测在串行后台链上执行且异常不向协议通道传播——
  // relay 掉线/超时最多拖慢上报（deliverLifecycleEvent 自带 2s 超时），不能
  // 阻断或打断 App Server 的 JSON-RPC 通信。返回的 Promise 在输入结束且观测
  // 链排空后 resolve，保证进程退出前事件有机会送达。
  let observed = Promise.resolve();
  const observeSafely = (line) => {
    observed = observed.then(async () => {
      try {
        await observer.observeLine(line, direction);
      } catch (error) {
        observer.diagnostics.observeErrors = (observer.diagnostics.observeErrors || 0) + 1;
        if (observer.diagnostics.observeErrors === 1) {
          process.stderr.write(`Agent Insight Codex observation failed: ${error?.message || error}\n`);
        }
      }
    });
  };
  for await (const line of reader) {
    await writeLine(output, line);
    observeSafely(line);
  }
  await observed;
}

function readProxyConfig(configPath = process.env.AGENT_INSIGHT_CODEX_CONFIG) {
  const resolved = configPath || path.join(os.homedir(), ".agent-insight", "collectors", "codex", "config.json");
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!parsed.installSecret || !parsed.relayPort) throw new Error("Codex proxy config is missing installSecret or relayPort");
  return parsed;
}

function deliverLifecycleEvent(event, config) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(event);
    const request = http.request({
      hostname: "127.0.0.1",
      port: Number(config.relayPort),
      path: "/lifecycle-event",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-agent-insight-relay": config.installSecret,
      },
      timeout: 2000,
    }, (response) => {
      response.resume();
      response.on("end", () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) resolve();
        else reject(new Error(`Codex relay returned HTTP ${response.statusCode}`));
      });
    });
    request.on("timeout", () => request.destroy(new Error("Codex relay lifecycle request timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

function runAppServerProxy(options = {}) {
  const config = options.config || readProxyConfig(options.configPath);
  const command = options.command || "codex";
  const args = options.args || ["app-server"];
  const child = options.child || spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
    env: options.env || process.env,
  });
  const observer = options.observer || createAppServerProtocolObserver({
    onEvent: async (event) => deliverLifecycleEvent(event, config),
  });
  const clientInput = options.clientInput || process.stdin;
  const clientOutput = options.clientOutput || process.stdout;
  const clientToServer = forwardJsonLines(clientInput, child.stdin, "client", observer)
    .finally(() => child.stdin.end());
  const serverToClient = forwardJsonLines(child.stdout, clientOutput, "server", observer);
  const completion = Promise.all([clientToServer, serverToClient]).then(() => new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      if (child.exitCode === 0) resolve(child.exitCode);
      else reject(new Error(`Codex app-server exited with code ${child.exitCode}`));
      return;
    }
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(code) : reject(new Error(`Codex app-server exited with code ${code}`)));
  }));
  return { child, observer, completion };
}

async function main() {
  const proxy = runAppServerProxy({ args: ["app-server", ...process.argv.slice(2)] });
  await proxy.completion;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Agent Insight Codex App Server proxy failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  createAppServerProtocolObserver,
  deliverLifecycleEvent,
  forwardJsonLines,
  inputText,
  readProxyConfig,
  resultTurnId,
  runAppServerProxy,
};
