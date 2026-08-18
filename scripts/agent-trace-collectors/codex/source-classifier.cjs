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
  const evidence = { clientName, originator, source, terminalType };

  // The proxy's own client is stronger than the application that launched it.
  if (/^(?:agent[-_ ]insight|agent_insight)(?:$|[-_ ])/i.test(clientName)) {
    return { sourceKind: "app_server", confidence: "direct", evidence };
  }
  if (/codex\s*desktop/i.test(originator)) {
    return { sourceKind: "desktop", confidence: "direct", evidence };
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
