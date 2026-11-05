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

"use strict";

const SOURCE_KINDS = Object.freeze([
  "cli",
  "desktop",
  "ide",
  "app_server",
  "unknown",
]);

function text(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function classifyCodexSource(input = {}) {
  const clientName = text(input.clientName || input.client_name || input["clientInfo.name"]);
  const originator = text(input.originator || input["codex.originator"]);
  const source = text(input.source || input.threadSource || input.thread_source);
  const terminalType = text(input.terminalType || input.terminal_type || input["codex.terminal.type"]);
  const serviceName = text(input.serviceName || input.service_name || input["service.name"]);
  const evidence = { clientName, originator, source, terminalType, serviceName };

  // The proxy's own client is stronger than the application that launched it.
  if (/^(?:agent[-_ ]insight|agent_insight)(?:$|[-_ ])/i.test(clientName)) {
    return { sourceKind: "app_server", confidence: "direct", evidence };
  }
  if (/codex[-_\s]*desktop/i.test(originator)) {
    return { sourceKind: "desktop", confidence: "direct", evidence };
  }
  // Desktop 会话的 OTel 日志不带 originator/clientName，但 resource 的
  // service.name=codex-app-server 在真实数据中稳定（21878/21879 实证）；CLI 路径
  // 的 service.name=codex_cli_rs 不得误归类。
  if (/^codex[-_ ]app[-_ ]server$/i.test(serviceName)) {
    return { sourceKind: "app_server", confidence: "direct", evidence };
  }
  if (/(?:vscode|cursor|windsurf|ide)/i.test(`${originator} ${terminalType}`)) {
    return { sourceKind: "ide", confidence: "direct", evidence };
  }
  if (/(?:codex_tui|codex_exec|codex-cli|codex\s+cli)/i.test(`${originator} ${source} ${terminalType}`)) {
    return { sourceKind: "cli", confidence: "direct", evidence };
  }
  if (/^(?:exec|tui|cli)$/i.test(source) && /codex/i.test(`${originator} ${terminalType}`)) {
    return { sourceKind: "cli", confidence: "correlated", evidence };
  }
  return { sourceKind: "unknown", confidence: "pending", evidence };
}

function isSourceKind(value) {
  return SOURCE_KINDS.includes(String(value || ""));
}

module.exports = { SOURCE_KINDS, classifyCodexSource, isSourceKind };
