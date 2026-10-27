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

function usageFrom(value) {
  const usage = value?.usage || value || {};
  const input = Number(usage.input) || 0;
  const output = Number(usage.output) || 0;
  const reasoning = Number(usage.reasoning) || 0;
  const cacheRead = Number(usage.cacheRead) || 0;
  const cacheWrite = Number(usage.cacheWrite) || 0;
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total: Number(usage.totalTokens) || input + output,
  };
}

function classifyTool(toolName) {
  const name = String(toolName || "").toLowerCase();
  if (/^(bash|shell|terminal|exec|command)$/.test(name)) return "shell";
  if (/^(read|write|edit|ls|find|grep|glob|cat)$/.test(name)) return "file";
  if (/^(search|web_search|websearch|grep|find)$/.test(name)) return "search";
  if (name === "subagent") return "subagent";
  if (name.startsWith("mcp__")) return "mcp";
  return "custom";
}

function parseMcpIdentity(toolName, args, result) {
  const match = /^mcp__([^_]+(?:_[^_]+)*)__([^_].*)$/.exec(String(toolName || ""));
  const metadata = result?.details?.metadata || result?.details || args?.metadata || {};
  const serverName = metadata.serverName || metadata.server_name || match?.[1];
  const mcpToolName = metadata.toolName || metadata.tool_name || match?.[2];
  if (!serverName || !mcpToolName) return null;
  return { serverName: String(serverName), toolName: String(mcpToolName) };
}

module.exports = { classifyTool, parseMcpIdentity, usageFrom };
