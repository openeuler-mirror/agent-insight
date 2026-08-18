/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const path = require("node:path");

function pathInfo(value) {
  if (!value) return undefined;
  const raw = String(value);
  const windows = /^[a-z]:[\\/]/i.test(raw) || raw.startsWith("\\\\");
  const api = windows ? path.win32 : raw.startsWith("/") ? path.posix : path;
  const normalized = api.resolve(raw);
  return {
    api,
    normalized: windows ? normalized.toLowerCase() : normalized,
    style: windows ? "windows" : api === path.posix ? "posix" : process.platform,
  };
}

function isSameOrDescendant(parent, child) {
  if (!parent || !child || parent.style !== child.style) return false;
  const prefix = parent.normalized.endsWith(parent.api.sep)
    ? parent.normalized
    : `${parent.normalized}${parent.api.sep}`;
  return parent.normalized === child.normalized || child.normalized.startsWith(prefix);
}

function pathsOverlap(left, right) {
  const a = pathInfo(left);
  const b = pathInfo(right);
  return isSameOrDescendant(a, b) || isSameOrDescendant(b, a);
}

function selectActiveTurn(status, workspaceFolders) {
  const folders = (workspaceFolders || []).filter((folder) => pathInfo(folder));
  const matches = (status?.activeTurns || []).filter((turn) => {
    const ide = /(?:vscode|cursor|windsurf|ide)/i.test(
      `${turn.originator || ""} ${turn.terminalType || ""}`,
    );
    return ide && folders.some((folder) => pathsOverlap(folder, turn.cwd));
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function relativeFilePath(filePath, workspaceFolders) {
  const file = pathInfo(filePath);
  if (!file) return undefined;
  const candidates = (workspaceFolders || [])
    .map(pathInfo)
    .filter((folder) => isSameOrDescendant(folder, file))
    .sort((left, right) => right.normalized.length - left.normalized.length);
  if (candidates.length === 0) return undefined;
  const workspace = candidates[0];
  return workspace.api.relative(workspace.normalized, file.normalized)
    .replaceAll(workspace.api.sep, "/");
}

function summarizeChanges(changes) {
  return (changes || []).map((change) => ({
    range: {
      start: {
        line: Number(change.range?.start?.line) || 0,
        character: Number(change.range?.start?.character) || 0,
      },
      end: {
        line: Number(change.range?.end?.line) || 0,
        character: Number(change.range?.end?.character) || 0,
      },
    },
    rangeLength: Number(change.rangeLength) || 0,
    insertedLength: Array.from(String(change.text || "")).length,
  }));
}

class EditAccumulator {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 500;
    this.now = options.now || Date.now;
    this.pending = new Map();
  }

  add(documentKey, event) {
    const existing = this.pending.get(documentKey);
    if (existing && this.now() - existing.lastAt <= this.windowMs) {
      existing.changes.push(...event.changes);
      existing.lastAt = this.now();
      return existing;
    }
    const item = {
      ...event,
      startedAt: event.startedAt || this.now(),
      lastAt: this.now(),
      changes: [...(event.changes || [])],
    };
    this.pending.set(documentKey, item);
    return item;
  }

  take(documentKey) {
    const item = this.pending.get(documentKey);
    this.pending.delete(documentKey);
    if (!item) return undefined;
    const { lastAt, ...result } = item;
    return { ...result, timestampMs: lastAt };
  }

  keys() {
    return [...this.pending.keys()];
  }
}

function terminalCommandLine(event) {
  const command = event?.execution?.commandLine;
  if (typeof command === "string") return command;
  return command?.value || command?.commandLine || undefined;
}

module.exports = {
  EditAccumulator,
  pathsOverlap,
  relativeFilePath,
  selectActiveTurn,
  summarizeChanges,
  terminalCommandLine,
};
