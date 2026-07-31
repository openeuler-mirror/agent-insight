/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_MAX_CONTENT_CHARS = 2000;
const DEFAULT_BATCH_EVENTS = 100;
const DEFAULT_BATCH_BYTES = 512 * 1024;
const DEFAULT_RETENTION_DAYS = 7;
const RETRYABLE_STATUS = new Set([409, 429, 500, 501, 502, 503, 504]);

const SENSITIVE_KEY_PATTERN =
  /(?:^|[-_.])(api[-_]?key|authorization|auth|token|secret|password|passwd|private[-_]?key|cookie|email|account[-_]?id|user[-_]?id)(?:$|[-_.])/i;
const TOKEN_USAGE_KEY_PATTERN =
  /(?:^|[-_.])(input|output|cached|cache[-_]?read|cache[-_]?write|reasoning|tool|total)[-_.]?tokens?(?:[-_.]?count)?(?:$|[-_.])/i;
const STRING_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi,
  /\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{12,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function stableHex(parts, length) {
  const input = Array.isArray(parts) ? parts.map((part) => String(part ?? "")).join("\u001f") : String(parts);
  return sha256(input).slice(0, length);
}

function stableTraceId(...parts) {
  return stableHex(parts, 32);
}

function stableSpanId(...parts) {
  return stableHex(parts, 16);
}

function stableEventId(...parts) {
  return stableHex(parts, 32);
}

function apiKeyHash(apiKey) {
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error("Agent Insight API key is required");
  }
  return sha256(String(apiKey)).slice(0, 12);
}

function collectorStateDir(framework, apiKey, homeDir = os.homedir()) {
  const safeFramework = String(framework || "").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(safeFramework)) {
    throw new Error(`Invalid collector framework: ${framework}`);
  }
  return path.join(homeDir, ".agent-insight", "otel_data", safeFramework, apiKeyHash(apiKey));
}

function truncateCodePoints(value, maxChars = DEFAULT_MAX_CONTENT_CHARS) {
  const text = String(value ?? "");
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, maxChars).join("")}...[TRUNCATED original_chars=${chars.length}]`;
}

function redactString(value) {
  let result = String(value);
  for (const pattern of STRING_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

function isSensitiveKey(value) {
  const normalized = String(value).replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return SENSITIVE_KEY_PATTERN.test(normalized) && !TOKEN_USAGE_KEY_PATTERN.test(normalized);
}

function redactValue(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactString(value);
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.map((item) => redactValue(item, seen));
    seen.delete(value);
    return result;
  }

  const sensitivePair =
    typeof value.key === "string" &&
    Object.prototype.hasOwnProperty.call(value, "value") &&
    isSensitiveKey(value.key);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      result[key] = "[REDACTED]";
    } else if (sensitivePair && key === "value") {
      result[key] = item && typeof item === "object"
        ? { stringValue: "[REDACTED]" }
        : "[REDACTED]";
    } else {
      result[key] = redactValue(item, seen);
    }
  }
  seen.delete(value);
  return result;
}

function safeContent(value, maxChars = DEFAULT_MAX_CONTENT_CHARS) {
  if (value === undefined || value === null) return undefined;
  const redacted = redactValue(value);
  const serialized = typeof redacted === "string" ? redacted : JSON.stringify(redacted);
  return truncateCodePoints(serialized, maxChars);
}

function utcDateName(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function spoolFileFor(stateDir, timestamp = Date.now()) {
  return path.join(stateDir, utcDateName(timestamp), "events.jsonl");
}

async function appendJsonl(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify(value)}\n`;
  await fsp.appendFile(filePath, line, { encoding: "utf8", mode: 0o600 });
  return Buffer.byteLength(line);
}

async function readJsonlBatch(filePath, offset = 0, options = {}) {
  const maxEvents = options.maxEvents || DEFAULT_BATCH_EVENTS;
  const maxBytes = options.maxBytes || DEFAULT_BATCH_BYTES;
  const handle = await fsp.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (offset >= stat.size) {
      return { events: [], nextOffset: offset, fileSize: stat.size, tornTailBytes: 0 };
    }

    const bytesToRead = Math.min(stat.size - offset, Math.max(maxBytes + 64 * 1024, maxBytes * 2));
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
    const view = buffer.subarray(0, bytesRead);
    const events = [];
    let cursor = 0;
    let nextOffset = offset;

    while (cursor < view.length && events.length < maxEvents) {
      const newline = view.indexOf(0x0a, cursor);
      if (newline < 0) break;
      const lineBuffer = view.subarray(cursor, newline);
      const consumed = newline + 1 - cursor;
      if (events.length > 0 && nextOffset - offset + consumed > maxBytes) break;
      const text = lineBuffer.toString("utf8").trim();
      if (text) {
        try {
          events.push(JSON.parse(text));
        } catch (error) {
          throw new Error(`Invalid JSONL record at byte ${offset + cursor}: ${error.message}`);
        }
      }
      cursor = newline + 1;
      nextOffset = offset + cursor;
    }

    const reachedPhysicalEnd = offset + bytesRead >= stat.size;
    const tornTailBytes = reachedPhysicalEnd && view.length > cursor && view.indexOf(0x0a, cursor) < 0
      ? view.length - cursor
      : 0;
    return { events, nextOffset, fileSize: stat.size, tornTailBytes };
  } finally {
    await handle.close();
  }
}

async function atomicWriteJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fsp.open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tempPath, filePath);
}

async function readCheckpoint(filePath) {
  try {
    const parsed = JSON.parse(await fsp.readFile(filePath, "utf8"));
    if (parsed?.version === 1 && parsed.files && typeof parsed.files === "object") return parsed;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { version: 1, files: {} };
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function acquireProcessLock(lockPath) {
  await fsp.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = crypto.randomUUID();
  const record = {
    version: 1,
    pid: process.pid,
    host: os.hostname(),
    startedAt: new Date().toISOString(),
    token,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fsp.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.close();
      return { lockPath, token };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let existing;
      try {
        existing = JSON.parse(await fsp.readFile(lockPath, "utf8"));
      } catch {
        return null;
      }
      if (existing?.host !== os.hostname() || isPidAlive(Number(existing?.pid))) return null;
      await fsp.unlink(lockPath).catch((unlinkError) => {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      });
    }
  }
  return null;
}

async function releaseProcessLock(lock) {
  if (!lock) return false;
  try {
    const existing = JSON.parse(await fsp.readFile(lock.lockPath, "utf8"));
    if (existing?.token !== lock.token) return false;
    await fsp.unlink(lock.lockPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function computeBackoffMs(attempt, options = {}) {
  const baseMs = options.baseMs || 1000;
  const maxMs = options.maxMs || 60_000;
  const jitter = options.jitter === undefined ? 0.2 : options.jitter;
  const random = options.random || Math.random;
  const raw = Math.min(maxMs, baseMs * (2 ** Math.max(0, attempt)));
  const delta = raw * jitter * ((random() * 2) - 1);
  return Math.max(0, Math.round(raw + delta));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function otlpAnyValue(value) {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    if (Number.isInteger(value)) return { intValue: String(value) };
    return { doubleValue: value };
  }
  if (typeof value === "bigint") return { intValue: String(value) };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(otlpAnyValue) } };
  if (value && typeof value === "object") {
    return {
      kvlistValue: {
        values: Object.entries(value).map(([key, item]) => ({ key, value: otlpAnyValue(item) })),
      },
    };
  }
  return { stringValue: String(value ?? "") };
}

function otlpAttributes(attributes) {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ({ key, value: otlpAnyValue(value) }));
}

function toUnixNano(timestampMs) {
  return String(BigInt(Math.max(0, Math.round(Number(timestampMs) || Date.now()))) * 1_000_000n);
}

function canonicalSpanAttributes(event) {
  const kind = String(event.kind || "span");
  const spanKind = kind === "llm"
    ? "LLM"
    : kind === "tool" || kind === "mcp"
      ? "TOOL"
      : kind === "skill"
        ? "CHAIN"
        : "AGENT";
  const attrs = {
    "agent.insight.framework": event.framework || "unknown",
    "agent.insight.kind": kind,
    "agent.insight.event_id": event.eventId,
    "openinference.span.kind": spanKind,
    "session.id": event.sessionId,
    "input.value": safeContent(event.input),
    "output.value": safeContent(event.output),
    "llm.model_name": event.model,
    "llm.provider": event.provider,
    "llm.token_count.prompt": event.usage?.input,
    "llm.token_count.completion": event.usage?.output,
    "llm.token_count.reasoning": event.usage?.reasoning,
    "llm.token_count.total": event.usage?.total,
    "tool.name": event.tool?.name,
    "tool.type": event.tool?.type,
    "tool.arguments": safeContent(event.tool?.arguments),
    "tool.result": safeContent(event.tool?.result),
    "tool.outcome": event.status,
    "skill.name": event.skill?.name,
    "skill.version": event.skill?.version,
    "skill.trigger_mode": event.skill?.triggerMode,
    "mcp.server.name": event.mcp?.serverName,
    "mcp.tool.name": event.mcp?.toolName,
    ...(event.attributes || {}),
  };
  return attrs;
}

function canonicalEventsToOtlp(events, options = {}) {
  const framework = options.framework || events[0]?.framework || "unknown";
  const scopeName = options.scopeName || `agent-insight-${framework}`;
  const scopeVersion = options.scopeVersion || "0.1.0";
  const grouped = new Map();

  for (const rawEvent of events) {
    const event = redactValue(rawEvent);
    if (!event?.sessionId) throw new Error("Canonical event is missing sessionId");
    const list = grouped.get(event.sessionId) || [];
    list.push(event);
    grouped.set(event.sessionId, list);
  }

  return {
    resourceSpans: [...grouped.entries()].map(([sessionId, sessionEvents]) => ({
      resource: {
        attributes: otlpAttributes({
          "service.name": framework,
          "service.version": scopeVersion,
          "session.id": sessionId,
        }),
      },
      scopeSpans: [{
        scope: { name: scopeName, version: scopeVersion },
        spans: sessionEvents.map((event) => {
          const startedAt = Number(event.startTimeMs) || Date.now();
          const endedAt = Math.max(startedAt, Number(event.endTimeMs) || startedAt);
          const statusCode = event.status === "error" || event.status === "failed" ? 2 : 1;
          return {
            traceId: event.traceId || stableTraceId(framework, event.sessionId),
            spanId: event.spanId || stableSpanId(event.eventId || JSON.stringify(event)),
            ...(event.parentSpanId ? { parentSpanId: event.parentSpanId } : {}),
            name: event.name || `${event.kind || "span"}.${framework}`,
            kind: 1,
            startTimeUnixNano: toUnixNano(startedAt),
            endTimeUnixNano: toUnixNano(endedAt),
            attributes: otlpAttributes(canonicalSpanAttributes({ ...event, framework })),
            status: {
              code: statusCode,
              ...(event.error ? { message: truncateCodePoints(redactString(event.error)) } : {}),
            },
          };
        }),
      }],
    })),
  };
}

async function listSpoolFiles(stateDir) {
  const entries = await fsp.readdir(stateDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    const candidate = path.join(stateDir, entry.name, "events.jsonl");
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isFile()) files.push(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return files.sort();
}

async function cleanupRetention(stateDir, options = {}) {
  const retentionDays = options.retentionDays || DEFAULT_RETENTION_DAYS;
  const now = options.now || Date.now();
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const removed = [];
  for (const filePath of await listSpoolFiles(stateDir)) {
    const datePart = path.basename(path.dirname(filePath));
    const timestamp = Date.parse(`${datePart}T00:00:00.000Z`);
    if (!Number.isFinite(timestamp) || timestamp >= cutoff) continue;
    await fsp.unlink(filePath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await fsp.rmdir(path.dirname(filePath)).catch((error) => {
      if (!["ENOENT", "ENOTEMPTY"].includes(error?.code)) throw error;
    });
    removed.push(filePath);
  }
  return removed;
}

class DurableTraceWriter {
  constructor(options) {
    this.framework = options.framework;
    this.apiKey = options.apiKey;
    this.stateDir = options.stateDir || collectorStateDir(options.framework, options.apiKey, options.homeDir);
    this.maxContentChars = options.maxContentChars || DEFAULT_MAX_CONTENT_CHARS;
    this.pending = Promise.resolve();
  }

  append(event) {
    const timestamp = Number(event.startTimeMs) || Date.now();
    const normalized = redactValue({
      ...event,
      framework: this.framework,
      eventId: event.eventId || stableEventId(
        this.framework,
        event.sessionId,
        event.spanId,
        event.kind,
        event.name,
      ),
      input: safeContent(event.input, this.maxContentChars),
      output: safeContent(event.output, this.maxContentChars),
      tool: event.tool ? {
        ...event.tool,
        arguments: safeContent(event.tool.arguments, this.maxContentChars),
        result: safeContent(event.tool.result, this.maxContentChars),
      } : undefined,
    });
    const filePath = spoolFileFor(this.stateDir, timestamp);
    this.pending = this.pending.then(() => appendJsonl(filePath, normalized));
    return this.pending.then(() => normalized);
  }

  flush() {
    return this.pending;
  }
}

class DurableTraceUploader {
  constructor(options) {
    this.framework = options.framework;
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint;
    this.stateDir = options.stateDir || collectorStateDir(options.framework, options.apiKey, options.homeDir);
    this.fetch = options.fetch || globalThis.fetch;
    this.maxEvents = options.maxEvents || DEFAULT_BATCH_EVENTS;
    this.maxBytes = options.maxBytes || DEFAULT_BATCH_BYTES;
    this.maxRetries = options.maxRetries === undefined ? 4 : options.maxRetries;
    this.retry = options.retry || {};
    this.sleep = options.sleep || delay;
    this.timer = null;
    if (typeof this.fetch !== "function") throw new Error("A fetch implementation is required");
    if (!this.endpoint) throw new Error("Agent Insight OTLP endpoint is required");
  }

  async post(events) {
    const payload = canonicalEventsToOtlp(events, { framework: this.framework });
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.fetch(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-witty-api-key": this.apiKey,
          },
          body: JSON.stringify(payload),
        });
        if (response.status >= 200 && response.status < 300) return response;
        const message = truncateCodePoints(await response.text().catch(() => ""), 512);
        const error = new Error(`OTLP upload failed with HTTP ${response.status}${message ? `: ${message}` : ""}`);
        error.status = response.status;
        error.retryable = RETRYABLE_STATUS.has(response.status);
        if (!error.retryable) throw error;
        lastError = error;
      } catch (error) {
        if (error?.retryable === false) throw error;
        lastError = error;
      }
      if (attempt < this.maxRetries) {
        await this.sleep(computeBackoffMs(attempt, this.retry));
      }
    }
    throw lastError || new Error("OTLP upload failed");
  }

  async flushOnce() {
    await fsp.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const lockPath = path.join(this.stateDir, "uploader.lock");
    const checkpointPath = path.join(this.stateDir, "uploader-checkpoint.json");
    const lock = await acquireProcessLock(lockPath);
    if (!lock) return { acquired: false, uploadedEvents: 0 };

    let uploadedEvents = 0;
    try {
      const checkpoint = await readCheckpoint(checkpointPath);
      for (const filePath of await listSpoolFiles(this.stateDir)) {
        const relativePath = path.relative(this.stateDir, filePath).replaceAll(path.sep, "/");
        let cursor = Number(checkpoint.files[relativePath]?.bytes) || 0;
        while (true) {
          const batch = await readJsonlBatch(filePath, cursor, {
            maxEvents: this.maxEvents,
            maxBytes: this.maxBytes,
          });
          if (batch.events.length === 0) break;
          await this.post(batch.events);
          cursor = batch.nextOffset;
          const lastEvent = batch.events[batch.events.length - 1];
          checkpoint.files[relativePath] = {
            bytes: cursor,
            lastEventId: lastEvent.eventId,
          };
          await atomicWriteJson(checkpointPath, checkpoint);
          uploadedEvents += batch.events.length;
        }
      }
      await cleanupRetention(this.stateDir);
      return { acquired: true, uploadedEvents };
    } finally {
      await releaseProcessLock(lock);
    }
  }

  start(intervalMs = 5 * 60 * 1000) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flushOnce().catch(() => {});
    }, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = {
  DEFAULT_BATCH_BYTES,
  DEFAULT_BATCH_EVENTS,
  DEFAULT_MAX_CONTENT_CHARS,
  DEFAULT_RETENTION_DAYS,
  DurableTraceUploader,
  DurableTraceWriter,
  acquireProcessLock,
  apiKeyHash,
  appendJsonl,
  atomicWriteJson,
  canonicalEventsToOtlp,
  cleanupRetention,
  collectorStateDir,
  computeBackoffMs,
  isPidAlive,
  listSpoolFiles,
  readCheckpoint,
  readJsonlBatch,
  redactString,
  redactValue,
  releaseProcessLock,
  safeContent,
  sha256,
  spoolFileFor,
  stableEventId,
  stableSpanId,
  stableTraceId,
  truncateCodePoints,
  utcDateName,
};
