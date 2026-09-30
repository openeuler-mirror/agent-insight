#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");

const READ_CHUNK_BYTES = 1024 * 1024;
const WRITE_BUFFER_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const MAX_UNIQUE_TARGET_KEYS = 1_000_000;
const KINDS = new Set(["collector", "server"]);
const EXPECTED_FILE = {
  collector: "events.jsonl",
  server: "traces.jsonl",
};
const CHECKPOINT_FILE = {
  collector: "uploader-checkpoint.json",
  server: "consumer-checkpoint.json",
};

function usage() {
  return `Usage:
  node scripts/repair-goal-plus-pi-spool.cjs --kind <collector|server> --path <file-or-directory>
  node scripts/repair-goal-plus-pi-spool.cjs --kind <collector|server> --path <file-or-directory> --apply --confirm-writers-stopped

Options:
  --kind                     collector scans events.jsonl; server scans traces.jsonl
  --path                     One JSONL file or a directory; directory files are compacted independently
  --apply                    Write compacted files (default is read-only dry-run)
  --confirm-writers-stopped  Required with --apply; collector/uploader/server must be stopped
  --json                     Print a machine-readable JSON report
  --help                     Show this help

Only framework=pi-agent records whose sessionId starts with "goal-plus:" are compacted.
Dry-run performs no writes. Apply writes and verifies a same-directory temporary file,
creates a non-overwriting timestamped hard-link backup, then atomically replaces the source.
Directory apply preflights every target before writing and reports each success immediately.
Inputs are bounded to 64 MiB per line and 1,000,000 unique target identities per file.
Uploader/consumer checkpoint files are never modified; the report identifies stale entries
and, when safely mappable, prints the replacement byte cursor. Preserve other entries and
restart the owning process after reconciling the reported entry.
Recovery: keep writers stopped, verify the reported .bak.<timestamp> file, replace the
compacted source with that backup, then reconcile the same checkpoint entry before restart.

Verification:
  node --import tsx --test test/goal-plus-pi-spool-repair.test.ts`;
}

function parseArgs(argv) {
  const options = {
    apply: false,
    confirmWritersStopped: false,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") options.apply = true;
    else if (token === "--dry-run") options.apply = false;
    else if (token === "--confirm-writers-stopped") options.confirmWritersStopped = true;
    else if (token === "--json") options.json = true;
    else if (token === "--help" || token === "-h") options.help = true;
    else if (token === "--kind") options.kind = argv[++index];
    else if (token === "--path") options.inputPath = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (options.help) return options;
  if (!KINDS.has(options.kind)) throw new Error("--kind must be collector or server");
  if (!options.inputPath) throw new Error("--path is required");
  if (options.apply && !options.confirmWritersStopped) {
    throw new Error("--apply requires --confirm-writers-stopped");
  }
  return options;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function semanticHash(record) {
  const semantic = { ...record };
  delete semantic.receivedAt;
  return sha256(canonicalJson(semantic));
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function targetIdentity(record, kind) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const attributes = record.attributes && typeof record.attributes === "object" && !Array.isArray(record.attributes)
    ? record.attributes
    : {};
  const directFramework = nonEmptyString(record.framework);
  const attributeFramework = nonEmptyString(attributes["agent.insight.framework"]);
  const frameworkClaims = kind === "collector"
    ? [directFramework]
    : [directFramework, attributeFramework].filter(Boolean);
  const framework = frameworkClaims.length > 0 && frameworkClaims.every((claim) => claim === "pi-agent")
    ? "pi-agent"
    : undefined;
  const sessionId = nonEmptyString(record.sessionId);
  if (framework !== "pi-agent" || !sessionId?.startsWith("goal-plus:")) return null;
  const directEventId = record.eventId;
  const attributeEventId = attributes["agent.insight.event_id"];
  const rawEventId = directEventId !== undefined && directEventId !== null
    ? directEventId
    : attributeEventId;
  const eventId = rawEventId !== undefined && rawEventId !== null && String(rawEventId).trim()
    ? String(rawEventId).trim()
    : undefined;
  const spanId = nonEmptyString(record.spanId);
  const identityKind = eventId ? "event" : spanId ? "span" : undefined;
  const identity = identityKind === "event" ? eventId : spanId;
  const owner = kind === "server" ? nonEmptyString(record.user) || "anonymous" : undefined;
  const key = kind === "server" && identityKind && identity
    ? sha256([owner, sessionId, identityKind, identity].join("\0"))
    : identity
      ? [sessionId, identity].join("\u001f")
      : undefined;
  return {
    sessionId,
    identity,
    identityKind,
    key,
  };
}

async function* rawLines(filePath, expectedSize) {
  const handle = await fsp.open(filePath, "r");
  let readOffset = 0;
  let lineStart = 0;
  let lineNumber = 0;
  let fragments = [];
  let fragmentBytes = 0;
  try {
    while (readOffset < expectedSize) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, expectedSize - readOffset));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, readOffset);
      if (bytesRead === 0) break;
      readOffset += bytesRead;
      const data = chunk.subarray(0, bytesRead);
      let segmentStart = 0;
      for (let index = 0; index < data.length; index += 1) {
        if (data[index] !== 0x0a) continue;
        const segment = data.subarray(segmentStart, index + 1);
        let raw;
        if (fragments.length === 0) {
          raw = segment;
        } else {
          fragments.push(segment);
          fragmentBytes += segment.length;
          if (fragmentBytes > MAX_LINE_BYTES) {
            throw new Error(`JSONL line exceeds ${MAX_LINE_BYTES} bytes: ${filePath}`);
          }
          raw = Buffer.concat(fragments, fragmentBytes);
          fragments = [];
          fragmentBytes = 0;
        }
        lineNumber += 1;
        const endOffset = lineStart + raw.length;
        yield { raw, lineNumber, startOffset: lineStart, endOffset, terminated: true };
        lineStart = endOffset;
        segmentStart = index + 1;
      }
      if (segmentStart < data.length) {
        const fragment = data.subarray(segmentStart);
        fragments.push(fragment);
        fragmentBytes += fragment.length;
        if (fragmentBytes > MAX_LINE_BYTES) {
          throw new Error(`JSONL line exceeds ${MAX_LINE_BYTES} bytes: ${filePath}`);
        }
      }
    }
    if (fragmentBytes > 0) {
      const raw = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, fragmentBytes);
      lineNumber += 1;
      yield {
        raw,
        lineNumber,
        startOffset: lineStart,
        endOffset: lineStart + raw.length,
        terminated: false,
      };
    }
  } finally {
    await handle.close();
  }
}

function inspectLine(raw, terminated, kind) {
  const body = terminated ? raw.subarray(0, raw.length - 1) : raw;
  const withoutCr = body.length > 0 && body[body.length - 1] === 0x0d
    ? body.subarray(0, body.length - 1)
    : body;
  const text = withoutCr.toString("utf8");
  if (!text.trim()) return { type: "blank" };
  let record;
  try {
    record = JSON.parse(text);
  } catch (error) {
    return { type: "malformed", error: error.message };
  }
  const target = targetIdentity(record, kind);
  return target ? { type: "target", record, target } : { type: "non-target", record };
}

async function fileIdentity(filePath) {
  const stat = await fsp.lstat(filePath);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to scan a symbolic link: ${filePath}`);
  if (!stat.isFile()) throw new Error(`Not a regular file: ${filePath}`);
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameFileDataIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function publicSummary(scan) {
  const { stats } = scan;
  return {
    file: scan.file,
    kind: scan.kind,
    totalRows: stats.totalRows,
    totalBytes: stats.totalBytes,
    blankRows: stats.blankRows,
    malformedRows: stats.malformedRows,
    unterminatedRows: stats.unterminatedRows,
    nonTargetRows: stats.nonTargetRows,
    targetRows: stats.targetRows,
    keyedTargetRows: stats.keyedTargetRows,
    unkeyedTargetRows: stats.unkeyedTargetRows,
    uniqueTargetKeys: scan.keys.size,
    exactDuplicateRows: stats.exactDuplicateRows,
    semanticRevisionRows: stats.semanticRevisionRows,
    removableTargetRows: stats.keyedTargetRows - scan.keys.size,
    duplicateRate: stats.keyedTargetRows === 0
      ? 0
      : (stats.keyedTargetRows - scan.keys.size) / stats.keyedTargetRows,
    projectedBytes: scan.projectedBytes,
    projectedSavedBytes: stats.totalBytes - scan.projectedBytes,
    safeToApply: stats.malformedRows === 0 && stats.unterminatedRows === 0,
  };
}

async function analyzeFile(filePath, kind, options = {}) {
  if (!KINDS.has(kind)) throw new Error(`Unsupported kind: ${kind}`);
  const resolved = path.resolve(filePath);
  if (!options.allowUnexpectedName && path.basename(resolved) !== EXPECTED_FILE[kind]) {
    throw new Error(`${kind} input must be named ${EXPECTED_FILE[kind]}: ${resolved}`);
  }
  const identity = await fileIdentity(resolved);
  const keys = new Map();
  const sourceDigest = crypto.createHash("sha256");
  const nonTargetDigest = crypto.createHash("sha256");
  const unkeyedTargetDigest = crypto.createHash("sha256");
  const stats = {
    totalRows: 0,
    totalBytes: identity.size,
    blankRows: 0,
    malformedRows: 0,
    unterminatedRows: 0,
    nonTargetRows: 0,
    nonTargetBytes: 0,
    targetRows: 0,
    keyedTargetRows: 0,
    unkeyedTargetRows: 0,
    unkeyedTargetBytes: 0,
    exactDuplicateRows: 0,
    semanticRevisionRows: 0,
  };

  for await (const line of rawLines(resolved, identity.size)) {
    sourceDigest.update(line.raw);
    stats.totalRows += 1;
    if (!line.terminated) stats.unterminatedRows += 1;
    const inspected = inspectLine(line.raw, line.terminated, kind);
    if (inspected.type === "blank") stats.blankRows += 1;
    if (inspected.type === "malformed") stats.malformedRows += 1;
    if (inspected.type !== "target") {
      stats.nonTargetRows += 1;
      stats.nonTargetBytes += line.raw.length;
      nonTargetDigest.update(line.raw);
      continue;
    }

    stats.targetRows += 1;
    if (!inspected.target.key) {
      stats.unkeyedTargetRows += 1;
      stats.unkeyedTargetBytes += line.raw.length;
      unkeyedTargetDigest.update(line.raw);
      continue;
    }

    stats.keyedTargetRows += 1;
    const hash = semanticHash(inspected.record);
    const previous = keys.get(inspected.target.key);
    if (previous) {
      if (previous.lastSemanticHash === hash) stats.exactDuplicateRows += 1;
      else stats.semanticRevisionRows += 1;
      previous.lastLine = line.lineNumber;
      previous.lastSemanticHash = hash;
      previous.lastRawHash = sha256(line.raw);
      previous.lastBytes = line.raw.length;
    } else {
      if (keys.size >= MAX_UNIQUE_TARGET_KEYS) {
        throw new Error(`Target identity count exceeds ${MAX_UNIQUE_TARGET_KEYS}: ${resolved}`);
      }
      keys.set(inspected.target.key, {
        lastLine: line.lineNumber,
        lastSemanticHash: hash,
        lastRawHash: sha256(line.raw),
        lastBytes: line.raw.length,
      });
    }
  }

  const projectedBytes = stats.nonTargetBytes
    + stats.unkeyedTargetBytes
    + [...keys.values()].reduce((sum, item) => sum + item.lastBytes, 0);
  const scan = {
    file: resolved,
    kind,
    identity,
    keys,
    stats,
    projectedBytes,
    sourceDigest: sourceDigest.digest("hex"),
    nonTargetDigest: nonTargetDigest.digest("hex"),
    unkeyedTargetDigest: unkeyedTargetDigest.digest("hex"),
  };
  return { ...scan, summary: publicSummary(scan) };
}

async function collectFiles(inputPath, kind) {
  if (!KINDS.has(kind)) throw new Error(`Unsupported kind: ${kind}`);
  const root = path.resolve(inputPath);
  const stat = await fsp.lstat(root);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to scan a symbolic link: ${root}`);
  if (stat.isFile()) {
    if (path.basename(root) !== EXPECTED_FILE[kind]) {
      throw new Error(`${kind} input must be named ${EXPECTED_FILE[kind]}: ${root}`);
    }
    return [root];
  }
  if (!stat.isDirectory()) throw new Error(`Not a file or directory: ${root}`);

  const files = [];
  const walk = async (dir) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile() && entry.name === EXPECTED_FILE[kind]) files.push(fullPath);
    }
  };
  await walk(root);
  return files;
}

async function inspectCheckpoint(filePath, kind) {
  const checkpointName = CHECKPOINT_FILE[kind];
  let current = path.dirname(filePath);
  while (true) {
    const candidate = path.join(current, checkpointName);
    try {
      const stat = await fsp.lstat(candidate);
      if (stat.isFile() && !stat.isSymbolicLink()) {
        let parsed;
        try {
          parsed = JSON.parse(await fsp.readFile(candidate, "utf8"));
        } catch (error) {
          return {
            path: candidate,
            relativePath: path.relative(current, filePath).split(path.sep).join("/"),
            parseError: error.message,
            entryFound: false,
            totalEntries: 0,
          };
        }
        const relativePath = path.relative(current, filePath).split(path.sep).join("/");
        const files = parsed?.files && typeof parsed.files === "object" ? parsed.files : {};
        const entry = files[relativePath];
        return {
          path: candidate,
          relativePath,
          entryFound: Boolean(entry),
          cursorBytes: Number.isFinite(Number(entry?.bytes)) ? Number(entry.bytes) : undefined,
          totalEntries: Object.keys(files).length,
          untouchedEntries: Math.max(0, Object.keys(files).length - (entry ? 1 : 0)),
        };
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return {
    path: null,
    relativePath: null,
    entryFound: false,
    totalEntries: 0,
    untouchedEntries: 0,
  };
}

class BufferedWriter {
  constructor(handle) {
    this.handle = handle;
    this.buffers = [];
    this.bufferedBytes = 0;
    this.bytesWritten = 0;
  }

  async write(buffer) {
    this.buffers.push(buffer);
    this.bufferedBytes += buffer.length;
    if (this.bufferedBytes >= WRITE_BUFFER_BYTES) await this.flush();
  }

  async flush() {
    if (this.bufferedBytes === 0) return;
    const combined = this.buffers.length === 1
      ? this.buffers[0]
      : Buffer.concat(this.buffers, this.bufferedBytes);
    let offset = 0;
    while (offset < combined.length) {
      const { bytesWritten } = await this.handle.write(combined, offset, combined.length - offset);
      if (bytesWritten <= 0) throw new Error("Failed to make progress while writing compacted spool");
      offset += bytesWritten;
    }
    this.bytesWritten += combined.length;
    this.buffers = [];
    this.bufferedBytes = 0;
  }
}

function tempPathFor(filePath) {
  return `${filePath}.repair-${process.pid}-${crypto.randomUUID()}.tmp`;
}

function timestampSuffix(now = new Date()) {
  return new Date(now).toISOString().replace(/[-:.]/g, "");
}

async function createBackupLink(filePath, now) {
  const base = `${filePath}.bak.${timestampSuffix(now)}`;
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix}`;
    try {
      await fsp.link(filePath, candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Could not allocate a unique backup name for ${filePath}`);
}

function checkpointCursorMapper(cursorBytes, sourceBytes) {
  if (!Number.isFinite(cursorBytes) || cursorBytes < 0 || cursorBytes > sourceBytes) {
    return { mappedBytes: null, valid: false, reason: "checkpoint cursor is outside the source file" };
  }
  return { mappedBytes: cursorBytes === 0 ? 0 : null, valid: true, reason: null };
}

async function rewriteFile(scan, tempPath, checkpoint) {
  const current = await fileIdentity(scan.file);
  if (!sameFileIdentity(scan.identity, current)) {
    throw new Error(`Source changed after analysis; stop all writers and retry: ${scan.file}`);
  }
  const handle = await fsp.open(tempPath, "wx", scan.identity.mode & 0o777);
  const writer = new BufferedWriter(handle);
  const sourceDigest = crypto.createHash("sha256");
  const cursor = checkpointCursorMapper(checkpoint.cursorBytes, scan.identity.size);
  let backupCleanupNeeded = false;
  try {
    for await (const line of rawLines(scan.file, scan.identity.size)) {
      sourceDigest.update(line.raw);
      if (cursor.valid && cursor.mappedBytes === null) {
        if (checkpoint.cursorBytes === line.startOffset) cursor.mappedBytes = writer.bytesWritten + writer.bufferedBytes;
        else if (checkpoint.cursorBytes > line.startOffset && checkpoint.cursorBytes < line.endOffset) {
          cursor.valid = false;
          cursor.reason = `checkpoint cursor falls inside line ${line.lineNumber}`;
        }
      }
      const inspected = inspectLine(line.raw, line.terminated, scan.kind);
      const keep = inspected.type !== "target"
        || !inspected.target.key
        || scan.keys.get(inspected.target.key)?.lastLine === line.lineNumber;
      if (keep) await writer.write(line.raw);
      if (cursor.valid && cursor.mappedBytes === null && checkpoint.cursorBytes === line.endOffset) {
        cursor.mappedBytes = writer.bytesWritten + writer.bufferedBytes;
      }
    }
    await writer.flush();
    if (sourceDigest.digest("hex") !== scan.sourceDigest) {
      throw new Error(`Source content changed during rewrite; stop all writers and retry: ${scan.file}`);
    }
    if (cursor.valid && cursor.mappedBytes === null && checkpoint.cursorBytes === scan.identity.size) {
      cursor.mappedBytes = writer.bytesWritten;
    }
    await handle.sync();
    await handle.chmod(scan.identity.mode & 0o777);
    backupCleanupNeeded = true;
    return {
      outputBytes: writer.bytesWritten,
      checkpointCursor: cursor,
    };
  } finally {
    await handle.close().catch(() => undefined);
    if (!backupCleanupNeeded) await fsp.unlink(tempPath).catch(() => undefined);
  }
}

function assertCompaction(scan, compacted, rewrite) {
  const before = scan.summary;
  const after = compacted.summary;
  if (rewrite.outputBytes !== scan.projectedBytes || after.totalBytes !== scan.projectedBytes) {
    throw new Error("Compacted byte count does not match the dry-run projection");
  }
  if (after.totalRows !== before.totalRows - before.removableTargetRows) {
    throw new Error("Compacted row count does not match the dry-run projection");
  }
  if (after.nonTargetRows !== before.nonTargetRows || compacted.nonTargetDigest !== scan.nonTargetDigest) {
    throw new Error("Non-target rows changed during compaction");
  }
  if (after.unkeyedTargetRows !== before.unkeyedTargetRows
    || compacted.unkeyedTargetDigest !== scan.unkeyedTargetDigest) {
    throw new Error("Unkeyed target rows changed during compaction");
  }
  if (after.keyedTargetRows !== scan.keys.size || after.uniqueTargetKeys !== scan.keys.size) {
    throw new Error("Compacted target key count is invalid");
  }
  if (after.removableTargetRows !== 0) throw new Error("Compacted file still contains duplicate target keys");
  for (const [key, expected] of scan.keys) {
    const actual = compacted.keys.get(key);
    if (!actual
      || actual.lastSemanticHash !== expected.lastSemanticHash
      || actual.lastRawHash !== expected.lastRawHash) {
      throw new Error("Latest target semantic versions were not preserved");
    }
  }
}

async function syncDirectory(dir) {
  let handle;
  try {
    handle = await fsp.open(dir, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EBADF"].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function checkpointReport(checkpoint, mode, changed, cursor) {
  const status = checkpoint.parseError
    ? "unreadable"
    : !changed
    ? "unchanged"
    : mode === "apply"
      ? "stale-after-apply"
      : "would-become-stale-on-apply";
  let recommendation = "No checkpoint entry was found for this file.";
  if (checkpoint.parseError) {
    recommendation = `Checkpoint is unreadable (${checkpoint.parseError}); do not resume its owner until it is repaired without discarding unrelated entries.`;
  } else if (changed && checkpoint.entryFound && mode === "dry-run") {
    recommendation = "Applying compaction will invalidate this byte cursor; stop writers and reconcile only this file entry afterward.";
  } else if (changed && checkpoint.entryFound && mode === "apply") {
    recommendation = cursor?.valid && Number.isFinite(cursor.mappedBytes)
      ? `Checkpoint was not modified. Set only this file entry to bytes=${cursor.mappedBytes}, preserve all other entries, then restart the owning process.`
      : `Checkpoint was not modified and could not be mapped safely (${cursor?.reason || "unknown cursor"}); rebuild only this file entry from its backup/current file before restart.`;
  } else if (changed && !checkpoint.path) {
    recommendation = "No checkpoint file was discovered; verify uploader/consumer initialization before resuming writers.";
  }
  return {
    ...checkpoint,
    status,
    suggestedCursorBytes: mode === "apply" && cursor?.valid ? cursor.mappedBytes : undefined,
    modifiedByTool: false,
    recommendation,
  };
}

async function compactFile(filePath, kind, options = {}) {
  if (!options.confirmWritersStopped) {
    throw new Error("Applying spool compaction requires explicit confirmation that all writers are stopped");
  }
  const scan = await analyzeFile(filePath, kind);
  const checkpoint = await inspectCheckpoint(scan.file, kind);
  if (!scan.summary.safeToApply) {
    throw new Error(`Refusing to modify malformed or unterminated JSONL: ${scan.file}`);
  }
  if (scan.summary.removableTargetRows === 0) {
    return {
      mode: "apply",
      applied: false,
      backup: null,
      ...scan.summary,
      checkpoint: checkpointReport(checkpoint, "apply", false),
    };
  }

  const tempPath = tempPathFor(scan.file);
  let backupPath;
  try {
    const rewrite = await rewriteFile(scan, tempPath, checkpoint);
    const compacted = await analyzeFile(tempPath, kind, { allowUnexpectedName: true }).catch(async (error) => {
      throw new Error(`Compacted-file verification could not run: ${error.message}`);
    });
    assertCompaction(scan, compacted, rewrite);

    const beforeBackup = await fileIdentity(scan.file);
    if (!sameFileIdentity(scan.identity, beforeBackup)) {
      throw new Error(`Source changed during rewrite; stop all writers and retry: ${scan.file}`);
    }
    backupPath = await createBackupLink(scan.file, options.now || new Date());
    const beforeReplace = await fileIdentity(scan.file);
    if (!sameFileDataIdentity(scan.identity, beforeReplace)) {
      await fsp.unlink(backupPath).catch(() => undefined);
      backupPath = undefined;
      throw new Error(`Source changed before replacement; stop all writers and retry: ${scan.file}`);
    }
    await fsp.rename(tempPath, scan.file);
    await syncDirectory(path.dirname(scan.file));
    return {
      mode: "apply",
      applied: true,
      backup: backupPath,
      ...scan.summary,
      finalBytes: rewrite.outputBytes,
      checkpoint: checkpointReport(checkpoint, "apply", true, rewrite.checkpointCursor),
    };
  } catch (error) {
    await fsp.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function dryRunFile(filePath, kind) {
  const scan = await analyzeFile(filePath, kind);
  const checkpoint = await inspectCheckpoint(scan.file, kind);
  return {
    mode: "dry-run",
    applied: false,
    backup: null,
    ...scan.summary,
    checkpoint: checkpointReport(checkpoint, "dry-run", scan.summary.removableTargetRows > 0),
  };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "n/a";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let index = 0;
  while (Math.abs(value) >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function formatReport(report) {
  const percent = (report.duplicateRate * 100).toFixed(2);
  const lines = [
    `[${report.mode.toUpperCase()}] ${report.file}`,
    `  kind=${report.kind} rows=${report.totalRows} bytes=${formatBytes(report.totalBytes)}`,
    `  target=${report.targetRows} unique_keys=${report.uniqueTargetKeys} removable=${report.removableTargetRows} duplicate_rate=${percent}%`,
    `  exact_duplicates=${report.exactDuplicateRows} semantic_revisions=${report.semanticRevisionRows} unkeyed=${report.unkeyedTargetRows}`,
    `  projected=${formatBytes(report.projectedBytes)} saved=${formatBytes(report.projectedSavedBytes)} safe_to_apply=${report.safeToApply}`,
  ];
  if (report.applied) lines.push(`  backup=${report.backup}`);
  const checkpoint = report.checkpoint;
  lines.push(`  checkpoint=${checkpoint.path || "not found"} status=${checkpoint.status} entry=${checkpoint.entryFound ? checkpoint.relativePath : "not found"}`);
  if (Number.isFinite(checkpoint.suggestedCursorBytes)) {
    lines.push(`  checkpoint_suggested_bytes=${checkpoint.suggestedCursorBytes} (not written)`);
  }
  lines.push(`  checkpoint_action=${checkpoint.recommendation}`);
  return lines.join("\n");
}

async function run(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const options = parseArgs(argv);
  if (options.help) {
    stdout.write(`${usage()}\n`);
    return { mode: "help", reports: [] };
  }
  const files = await collectFiles(options.inputPath, options.kind);
  if (files.length === 0) {
    throw new Error(`No ${EXPECTED_FILE[options.kind]} files found under ${path.resolve(options.inputPath)}`);
  }
  const reports = [];
  if (options.apply) {
    for (const file of files) {
      const preflight = await dryRunFile(file, options.kind);
      if (!preflight.safeToApply) {
        throw new Error(`Preflight rejected malformed or unterminated JSONL before any file was changed: ${file}`);
      }
    }
    try {
      for (const file of files) {
        const report = await compactFile(file, options.kind, { confirmWritersStopped: true });
        reports.push(report);
        if (!options.json) stdout.write(`${formatReport(report)}\n`);
      }
    } catch (error) {
      if (options.json && reports.length > 0) {
        stdout.write(`${JSON.stringify({
          mode: "apply",
          status: "partial-failure",
          error: error.message,
          reports,
        }, null, 2)}\n`);
      }
      throw error;
    }
  } else {
    for (const file of files) reports.push(await dryRunFile(file, options.kind));
  }
  const result = { mode: options.apply ? "apply" : "dry-run", reports };
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (!options.apply) stdout.write(`${reports.map(formatReport).join("\n\n")}\n`);
  return result;
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Goal Plus Pi spool repair failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  analyzeFile,
  collectFiles,
  compactFile,
  dryRunFile,
  formatReport,
  inspectCheckpoint,
  parseArgs,
  run,
  semanticHash,
  targetIdentity,
  usage,
};
