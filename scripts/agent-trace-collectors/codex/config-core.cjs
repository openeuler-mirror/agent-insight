/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const { HOOK_EVENTS, MATCHER_EVENTS } = require("./codex-trace-core.cjs");

const OTEL_BEGIN = "# BEGIN AGENT INSIGHT CODEX OTEL";
const OTEL_END = "# END AGENT INSIGHT CODEX OTEL";

async function atomicWriteFile(filePath, source, mode = 0o600) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(tempPath, "wx", mode);
  try {
    await handle.writeFile(source, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tempPath, filePath);
}

function commandQuotes(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function buildHookHandler(handlerPath, nodePath = process.execPath) {
  const command = `${commandQuotes(nodePath)} ${commandQuotes(handlerPath)}`;
  return {
    type: "command",
    command,
    commandWindows: command,
    timeout: 5,
    statusMessage: "Recording Agent Insight trace",
  };
}

function normalizeComparablePath(value) {
  const normalized = path.resolve(String(value || ""));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function handlerMatches(handler, handlerPath) {
  if (!handler || handler.type !== "command") return false;
  const expected = normalizeComparablePath(handlerPath);
  const command = `${handler.command || ""} ${handler.commandWindows || handler.command_windows || ""}`;
  return command
    .replaceAll("\\\\", "\\")
    .toLowerCase()
    .includes(expected.replaceAll("\\\\", "\\").toLowerCase());
}

function installHooksDocument(document, options) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("hooks.json root must be a JSON object");
  }
  const result = structuredClone(document);
  if (result.hooks === undefined) result.hooks = {};
  if (!result.hooks || typeof result.hooks !== "object" || Array.isArray(result.hooks)) {
    throw new Error("hooks.json hooks must be a JSON object");
  }
  const handlerPath = options.handlerPath;
  const nodePath = options.nodePath || process.execPath;
  let added = 0;
  for (const eventName of HOOK_EVENTS) {
    const existing = result.hooks[eventName] ?? [];
    if (!Array.isArray(existing)) {
      throw new Error(`hooks.json hooks.${eventName} must be an array`);
    }
    const alreadyInstalled = existing.some((group) =>
      Array.isArray(group?.hooks) &&
      group.hooks.some((handler) => handlerMatches(handler, handlerPath)),
    );
    if (alreadyInstalled) continue;
    const handler = buildHookHandler(handlerPath, nodePath);
    if (eventName === "SessionEnd") handler.timeout = 3;
    const group = {
      ...(MATCHER_EVENTS.has(eventName) ? { matcher: "*" } : {}),
      hooks: [handler],
    };
    result.hooks[eventName] = [...existing, group];
    added += 1;
  }
  return { document: result, added };
}

function removeCollectorHooks(document, options) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("hooks.json root must be a JSON object");
  }
  const result = structuredClone(document);
  if (!result.hooks || typeof result.hooks !== "object" || Array.isArray(result.hooks)) {
    return { document: result, removed: 0 };
  }
  let removed = 0;
  for (const [eventName, groups] of Object.entries(result.hooks)) {
    if (!Array.isArray(groups)) continue;
    const nextGroups = [];
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) {
        nextGroups.push(group);
        continue;
      }
      const remainingHandlers = group.hooks.filter((handler) => {
        const matches = handlerMatches(handler, options.handlerPath);
        if (matches) removed += 1;
        return !matches;
      });
      if (remainingHandlers.length > 0) {
        nextGroups.push({ ...group, hooks: remainingHandlers });
      }
    }
    if (nextGroups.length > 0) result.hooks[eventName] = nextGroups;
    else delete result.hooks[eventName];
  }
  return { document: result, removed };
}

function serializeHooksDocument(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function escapeTomlString(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
}

function managedOtelBlock(options) {
  const endpoint = `http://127.0.0.1:${Number(options.relayPort)}/v1/logs`;
  return [
    OTEL_BEGIN,
    "[otel]",
    'environment = "agent-insight"',
    "log_user_prompt = false",
    `exporter = { otlp-http = { endpoint = "${escapeTomlString(endpoint)}", protocol = "json", headers = { "x-agent-insight-relay" = "${escapeTomlString(options.installSecret)}" } } }`,
    OTEL_END,
  ].join("\n");
}

function findTopLevelSection(source, name) {
  const heading = new RegExp(`^\\s*\\[${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*(?:#.*)?$`, "m");
  const match = heading.exec(source);
  if (!match) return undefined;
  const start = match.index;
  const afterHeading = start + match[0].length;
  const next = /^\s*\[[^\]\r\n]+\]\s*(?:#.*)?$/gm;
  next.lastIndex = afterHeading;
  const nextMatch = next.exec(source);
  return {
    start,
    end: nextMatch?.index ?? source.length,
    text: source.slice(start, nextMatch?.index ?? source.length),
  };
}

function installOtelBlock(source, options) {
  const input = String(source || "");
  if (input.includes(OTEL_BEGIN) || input.includes(OTEL_END)) {
    if (input.includes(OTEL_BEGIN) && input.includes(OTEL_END)) {
      return { source: input, changed: false, previousBlock: undefined, conflict: false };
    }
    throw new Error("Codex config contains an incomplete Agent Insight OTel managed block");
  }
  const block = managedOtelBlock(options);
  const section = findTopLevelSection(input, "otel");
  if (!section) {
    const separator = input && !input.endsWith("\n") ? "\n" : "";
    return {
      source: `${input}${separator}${block}\n`,
      changed: true,
      previousBlock: undefined,
      conflict: false,
    };
  }
  if (/^\s*\[otel\.[^\]]+\]/m.test(input)) {
    return {
      source: input,
      changed: false,
      conflict: true,
      reason: "existing nested [otel.*] exporter configuration",
    };
  }
  const exporter = /^\s*exporter\s*=\s*(.+?)\s*(?:#.*)?$/m.exec(section.text)?.[1]?.trim();
  const safeExporter = exporter === undefined || /^["']none["']$/.test(exporter);
  if (!safeExporter) {
    return {
      source: input,
      changed: false,
      conflict: true,
      reason: `existing exporter ${exporter}`,
    };
  }
  const prefix = input.slice(0, section.start);
  const suffix = input.slice(section.end);
  const beforeBlock = prefix && !prefix.endsWith("\n") ? `${prefix}\n` : prefix;
  const afterBlock = suffix && !suffix.startsWith("\n") ? `\n${suffix}` : suffix;
  return {
    source: `${beforeBlock}${block}\n${afterBlock}`.replace(/\n{3,}/g, "\n\n"),
    changed: true,
    previousBlock: section.text,
    conflict: false,
  };
}

function uninstallOtelBlock(source, previousBlock) {
  const input = String(source || "");
  const begin = input.indexOf(OTEL_BEGIN);
  const endMarker = input.indexOf(OTEL_END);
  if (begin < 0 && endMarker < 0) return { source: input, changed: false };
  if (begin < 0 || endMarker < begin) {
    throw new Error("Codex config contains an incomplete Agent Insight OTel managed block");
  }
  const section = findTopLevelSection(input, "otel");
  if (!section || section.start <= begin || section.start >= endMarker) {
    throw new Error("Codex config does not contain the managed Agent Insight OTel section");
  }
  let end = endMarker + OTEL_END.length;
  if (input[end] === "\r" && input[end + 1] === "\n") end += 2;
  else if (input[end] === "\n") end += 1;
  const replacement = previousBlock || "";
  const prefix = input.slice(0, begin);
  const preservedAfterSection = input.slice(
    Math.min(section.end, endMarker),
    endMarker,
  );
  const suffix = input.slice(end);
  let output = `${prefix}${replacement}${preservedAfterSection}${suffix}`;
  output = output.replace(/\n{3,}/g, "\n\n");
  if (output && !output.endsWith("\n")) output += "\n";
  return { source: output, changed: true };
}

module.exports = {
  OTEL_BEGIN,
  OTEL_END,
  atomicWriteFile,
  buildHookHandler,
  findTopLevelSection,
  handlerMatches,
  installHooksDocument,
  installOtelBlock,
  managedOtelBlock,
  removeCollectorHooks,
  serializeHooksDocument,
  uninstallOtelBlock,
};
