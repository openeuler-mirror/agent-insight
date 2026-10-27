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

const fsp = require("node:fs/promises");
const path = require("node:path");
const { safeContent, sha256 } = require("../../shared/trace-transport.cjs");
const { goalPlusWorkerRelationship } = require("../../shared/collaboration-transport.cjs");

const FORMAT = "agent-insight.goal-plus-snapshot";
const VERSION = 1;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 240 * 1024;
const PATH_KEYS = /(?:^|_)(path|paths|workspace|session_file|transcript_path|log_paths|report_path|html_report_path|artifact_path)$/i;
const HIDDEN_KEYS = /(?:hidden|gold|standard_answer|reference_answer|secret|password|api_key|authorization|private_key)/i;

function isHiddenKey(key) {
  return HIDDEN_KEYS.test(key) || /^(?:token|auth|cookie)$/i.test(key);
}

function camel(key) {
  return String(key).replace(/_([a-z0-9])/g, (_match, letter) => letter.toUpperCase());
}

function normalize(value, options = {}, depth = 0) {
  if (depth > 8) return "[TRUNCATED]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return safeContent(value, options.maxChars || 4000);
  if (Array.isArray(value)) return value.slice(0, 256).map(item => normalize(item, options, depth + 1));
  if (typeof value !== "object") return String(value);
  const result = {};
  for (const [rawKey, item] of Object.entries(value).slice(0, 256)) {
    if (isHiddenKey(rawKey)) continue;
    if (PATH_KEYS.test(rawKey)) {
      if (options.keepRelativePaths && Array.isArray(item)) {
        result[camel(rawKey)] = item.slice(0, 256).map(relativePath);
      }
      continue;
    }
    result[camel(rawKey)] = normalize(item, options, depth + 1);
  }
  return result;
}

function relativePath(value) {
  const normalized = String(value || "").replaceAll("\\", "/");
  if (!normalized || path.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) {
    return "[PATH_REMOVED]";
  }
  return normalized.slice(0, 500);
}

function statIdentity(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

async function safeStableRead(root, filePath, options = {}) {
  const allowedRoots = [...new Set([root, ...(options.allowedRoots || [])])];
  const canonicalRoots = await Promise.all(allowedRoots.map(item => fsp.realpath(item)));
  const requested = path.resolve(filePath);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const initial = await fsp.lstat(requested);
    if (!initial.isFile() || initial.isSymbolicLink()) throw new Error("not a regular non-symlink file");
    const maxBytes = Object.prototype.hasOwnProperty.call(options, "maxBytes")
      ? options.maxBytes
      : MAX_FILE_BYTES;
    if (Number.isSafeInteger(maxBytes) && maxBytes > 0 && initial.size > maxBytes) {
      throw new Error("file exceeds collector size limit");
    }
    const canonical = await fsp.realpath(requested);
    const contained = canonicalRoots.some(canonicalRoot => (
      canonical === canonicalRoot || canonical.startsWith(`${canonicalRoot}${path.sep}`)
    ));
    if (!contained) {
      throw new Error("file resolves outside allowed collector roots");
    }
    const bytes = await fsp.readFile(canonical);
    const final = await fsp.stat(canonical);
    if (statIdentity(initial) === statIdentity(final)) return { bytes, stat: final };
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("file changed during read");
}

function contentHash(bytes) {
  return `sha256:${sha256(bytes)}`;
}

function snapshotId(sourceId, kind, objectKey, hash) {
  return `gpsnap_${sha256([sourceId, kind, objectKey, hash].join("\u001f"))}`;
}

function boundSnapshot(snapshot) {
  const bytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  if (bytes <= MAX_SNAPSHOT_BYTES) return snapshot;
  return {
    ...snapshot,
    payload: {
      parserStatus: "metadata-only",
      omittedPayloadBytes: bytes,
      availableKeys: Object.keys(snapshot.payload || {}).slice(0, 128),
    },
    redaction: {
      ...snapshot.redaction,
      contentMode: "metadata-only",
      truncatedFields: [...new Set([...(snapshot.redaction?.truncatedFields || []), "payload"])],
    },
  };
}

function objectKeyFor(kind, payload, relative) {
  if (kind === "goal") return payload.goal_plus_id || path.basename(path.dirname(relative));
  if (kind === "frozen_spec") return payload.frozen_spec_id || path.basename(path.dirname(relative));
  if (kind === "run" || kind === "best") return payload.run_id || relative.split("/")[1];
  if (kind === "report_meta") return `${payload.run_id || relative.split("/")[1]}:${path.basename(relative)}`;
  if (kind === "candidate") return payload.candidate_id || path.basename(path.dirname(relative));
  if (kind === "agent_session") return payload.agent_session_id || path.basename(relative, ".json");
  return relative;
}

function kindFor(relative) {
  if (/^goal-plus\/[^/]+\/goal\.json$/.test(relative)) return "goal";
  if (/^goal-plus\/[^/]+\/events\.jsonl$/.test(relative)) return "goal_event";
  if (/^specs\/[^/]+\/frozen_spec\.json$/.test(relative)) return "frozen_spec";
  if (/^runs\/[^/]+\/run\.json$/.test(relative)) return "run";
  if (/^runs\/[^/]+\/best\.json$/.test(relative)) return "best";
  if (/^runs\/[^/]+\/candidates\/[^/]+\/candidate\.json$/.test(relative)) return "candidate";
  if (/^runs\/[^/]+\/agent_sessions\/[^/]+\.json$/.test(relative)) return "agent_session";
  if (/^runs\/[^/]+\/report\.(?:md|html)$/.test(relative)) return "report_meta";
  return null;
}

function parentKeys(kind, payload, relative, context) {
  const parts = relative.split("/");
  const runId = payload.run_id || (parts[0] === "runs" ? parts[1] : undefined);
  const result = {};
  const goalId = payload.goal_plus_id || context.runGoals.get(runId);
  if (goalId) result.goalId = goalId;
  if (payload.goal_revision) result.goalRevision = payload.goal_revision;
  if (payload.frozen_spec_id) result.specId = payload.frozen_spec_id;
  if (runId) result.runId = runId;
  const candidateId = payload.candidate_id || (parts[2] === "candidates" ? parts[3] : undefined);
  if (candidateId) result.candidateId = candidateId;
  if (payload.agent_session_id) result.agentSessionId = payload.agent_session_id;
  return result;
}

function goalPayload(source) {
  return normalize({
    goal_plus_id: source.goal_plus_id,
    current_revision: source.goal_revision,
    status: source.status,
    phase: source.phase,
    goal_digest: sha256(String(source.raw_goal || "")),
    bounded_goal: source.raw_goal,
    policy: source.policy,
    triage: source.triage,
    revisions: source.goal_revisions,
    work_items: source.work_items,
    search_tasks: source.search_tasks,
    final_checks: source.final_checks,
    active_session: source.active_session,
    next_action: source.next_action,
    created_at: source.created_at,
    updated_at: source.updated_at,
  });
}

function runPayload(source, spec) {
  const metric = spec?.spec?.metric || {};
  return normalize({
    ...source,
    strategy: spec?.spec?.strategy,
    metric_name: metric.name,
    metric_direction: metric.direction,
  });
}

function candidatePayload(source) {
  return normalize({ ...source, iterations: source.iterations }, { keepRelativePaths: true });
}

function sessionPayload(source) {
  const metadata = source.session_handle.metadata || {};
  return normalize({
    agent_session_id: source.agent_session_id,
    run_id: source.run_id,
    candidate_id: source.candidate_id,
    agent_harness: source.agent_harness,
    runtime_provider: source.runtime_provider,
    execution_scope: source.execution_scope,
    role: source.directive?.role || source.launch?.role || "candidate-worker",
    native_session_id: source.session_handle.external_id,
    transcript_fingerprint: metadata.transcript_fingerprint,
    session_handle: {
      agent_harness: source.session_handle.agent_harness,
      runtime_provider: source.session_handle.runtime_provider,
      external_id: source.session_handle.external_id,
      nickname: source.session_handle.nickname,
    },
    selected_model: source.selected_model,
    usage: metadata.usage || metadata.pi_metrics?.usage,
    host_metadata: {
      dispatch_count: metadata.dispatch_count,
      terminal_state: metadata.terminal_state,
      pi_metrics: metadata.pi_metrics ? normalize(metadata.pi_metrics) : undefined,
    },
    counters: source.counters,
    created_at: source.created_at,
    updated_at: source.updated_at,
  });
}

async function existingRegularFile(root, candidate) {
  if (!candidate) return undefined;
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate);
  try {
    const stat = await fsp.lstat(resolved);
    return stat.isFile() && !stat.isSymbolicLink() ? candidate : undefined;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function thinkThreadArchive(root, source) {
  const diagnosticsRoot = path.join(root, "host-logs", "session-diagnostics");
  const externalId = source.session_handle.external_id;
  const direct = externalId ? path.join(diagnosticsRoot, externalId) : undefined;
  if (direct) {
    const index = path.join(direct, "index.json");
    if (await existingRegularFile(root, index)) return direct;
  }
  const entries = await fsp.readdir(diagnosticsRoot, { withFileTypes: true }).catch(error => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = path.join(diagnosticsRoot, entry.name);
    try {
      const index = JSON.parse((await safeStableRead(root, path.join(directory, "index.json"))).bytes.toString("utf8"));
      if (index?.identity?.agent_session_id === source.agent_session_id) return directory;
    } catch (error) {
      if (error?.code !== "ENOENT") continue;
    }
  }
  return undefined;
}

function locatorError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function verifyPiHeader(root, candidate, nativeSessionId) {
  const file = path.resolve(root, candidate);
  if (!await existingRegularFile(root, file)) return false;
  const canonical = await fsp.realpath(file);
  const canonicalRoot = await fsp.realpath(root);
  if (canonical !== path.resolve(canonicalRoot, path.relative(path.resolve(root), file)) || !canonical.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw locatorError("invalid_pi_session_path", "Pi session must be a non-symlink file inside the source root");
  }
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    if (end < 0 && bytesRead < buffer.length) {
      throw locatorError("pi_session_pending", "Pi session header is not complete yet");
    }
    if (end < 0) throw locatorError("invalid_pi_session_header", "Pi session header exceeds the size limit");
    let header;
    try { header = JSON.parse(buffer.subarray(0, end).toString("utf8")); }
    catch { throw locatorError("invalid_pi_session_header", "Pi session header is not valid JSON"); }
    if (header.type !== "session" || !nativeSessionId || header.id !== nativeSessionId) {
      throw locatorError("pi_session_identity_mismatch", "Pi session header does not match the worker native session id");
    }
    return true;
  } finally { await handle.close(); }
}

async function indexPiSessions(root) {
  const files = [];
  let visited = 0;
  const canonicalRoot = await fsp.realpath(root);
  async function visit(directory, depth) {
    let canonical;
    try { canonical = await fsp.realpath(directory); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (canonical !== path.resolve(canonicalRoot, path.relative(path.resolve(root), directory))
      || !canonical.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw locatorError("invalid_pi_session_path", "Pi session index must stay inside a non-symlink source directory");
    }
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (++visited > 10000) throw locatorError("pi_session_scan_limit", "Pi session index exceeded 10000 entries");
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth >= 4) throw locatorError("pi_session_scan_limit", "Pi session index exceeded four nested directories");
        await visit(file, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(file);
    }
  }
  await visit(path.join(root, "host-sessions", "pi"), 0);
  return files;
}

async function piWorkerSessionSource(root, source, sessionIndex = () => indexPiSessions(root)) {
  const metadata = source.session_handle.metadata || {};
  const declared = metadata.session_file || metadata.pi_metrics?.session_file;
  const externalId = source.session_handle.external_id;
  if (declared && await verifyPiHeader(root, declared, externalId)) {
    return { sessionFile: path.resolve(root, declared), sessionFormat: "pi-jsonl" };
  }
  const candidates = new Set();
  if (source.run_id && source.agent_session_id) {
    const legacy = path.join(root, "runs", source.run_id, "pi_sessions", `${source.agent_session_id}.jsonl`);
    if (await existingRegularFile(root, legacy)) candidates.add(legacy);
  }
  if (externalId) {
    for (const file of await sessionIndex()) {
      const name = path.basename(file);
      if (name === `${externalId}.jsonl` || name.endsWith(`_${externalId}.jsonl`)) candidates.add(file);
    }
  }
  if (candidates.size > 1) throw locatorError("ambiguous_pi_session_file", `Multiple Pi session files match ${externalId}`);
  for (const file of candidates) {
    if (await verifyPiHeader(root, file, externalId)) return { sessionFile: file, sessionFormat: "pi-jsonl" };
  }
  if (source.runtime_provider === "thinkthread") {
    const archive = await thinkThreadArchive(root, source);
    if (archive) return { sessionFile: archive, sessionFormat: "pi-diagnostic-archive" };
  }
  return undefined;
}

function initialPiStartInvocation(goal) {
  const invocations = invocationEntries(goal)
    .filter(item => item.agent_harness === "pi" && item.action === "start" && typeof item.session_id === "string")
    .sort((left, right) => String(left.invoked_at || "").localeCompare(String(right.invoked_at || "")));
  return invocations[0];
}

function hasCurrentAgentSessionSchema(source) {
  const expectedScope = source?.runtime_provider === "thinkthread" ? "thinkthread_private" : "native_root";
  return ["pi", "codex"].includes(source?.agent_harness)
    && ["direct", "thinkthread"].includes(source.runtime_provider)
    && source.execution_scope === expectedScope
    && source.session_handle
    && typeof source.session_handle === "object"
    && !Array.isArray(source.session_handle)
    && source.session_handle.agent_harness === source.agent_harness
    && source.session_handle.runtime_provider === source.runtime_provider;
}

function supportsCurrentAgentSession(source) {
  return source?.agent_harness === "pi" && hasCurrentAgentSessionSchema(source);
}

function frozenSpecPayload(source) {
  const spec = source.spec || {};
  return normalize({
    frozen_spec_id: source.frozen_spec_id,
    spec_hash: source.spec_hash,
    strategy: spec.strategy,
    metric: spec.metric,
    budget: spec.budget,
    edit_surface: spec.edit_surface,
    selected_models: spec.models,
    verifier_hashes: source.verifier_hashes,
    verifier_roles: spec.verifiers?.map(item => ({ name: item.name, role: item.role })),
    created_at: source.created_at,
  });
}

function reportMetaPayload(source, stat, relative) {
  return normalize({
    run_id: source.run_id,
    schema_version: source.schema_version,
    state: source.state,
    summary: source.summary,
    generated_at: source.generated_at,
    artifact: { relative_path: relativePath(relative), bytes: stat.size },
  });
}

async function walk(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(error => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!relative && !["goal-plus", "runs", "specs"].includes(entry.name)) continue;
      if (/^runs\/[^/]+$/.test(relative) && !["agent_sessions", "candidates"].includes(entry.name)) continue;
      if (relative.split("/").length >= 4) continue;
      files.push(...await walk(root, child));
    }
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

function invocationEntries(goal) {
  return Array.isArray(goal.host_command_invocations)
    ? goal.host_command_invocations.filter(item => item && typeof item === "object")
    : [];
}

async function parseGoalEvents(source, relative, bytes, stat) {
  const snapshots = [];
  const text = bytes.toString("utf8");
  const rawLines = text.split(/\r?\n/);
  if (!text.endsWith("\n")) rawLines.pop();
  const lines = rawLines.filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const record = JSON.parse(lines[index]);
    const eventId = String(record.event_id || `${path.basename(path.dirname(relative))}:${index}`);
    const hash = `sha256:${sha256(lines[index])}`;
    const payload = normalize({
      event_id: eventId,
      event_type: record.event_type,
      created_at: record.created_at,
      payload: record.payload,
    });
    snapshots.push(boundSnapshot({
      format: FORMAT,
      version: VERSION,
      snapshotId: snapshotId(source.sourceId, "goal_event", eventId, hash),
      sourceId: source.sourceId,
      kind: "goal_event",
      objectKey: eventId,
      parentKeys: { goalId: path.basename(path.dirname(relative)), ...(payload.payload?.goalRevision ? { goalRevision: payload.payload.goalRevision } : {}) },
      sourceSchemaVersion: 1,
      contentHash: hash,
      observedAt: new Date(stat.mtimeMs).toISOString(),
      payload,
      redaction: { contentMode: "bounded", truncatedFields: [], removedFields: ["paths", "secrets", "hidden-evaluation-content"] },
    }));
  }
  return snapshots;
}

async function parseGoalPlusRoot(source) {
  const root = source.root;
  const files = (await walk(root)).sort();
  const diagnostics = [];
  const coverage = { workers: 0, supported: 0, found: 0, pending: 0, failed: 0 };
  const context = { runGoals: new Map(), specs: new Map(), goals: new Map() };
  const rawRecords = new Map();
  for (const relative of files) {
    const kind = kindFor(relative);
    if (!kind || kind === "goal_event") continue;
    try {
      const read = await safeStableRead(root, path.join(root, relative));
      const raw = kind === "report_meta"
        ? { run_id: relative.split("/")[1], artifact_name: path.basename(relative) }
        : JSON.parse(read.bytes.toString("utf8"));
      rawRecords.set(relative, { kind, raw, ...read });
      if (kind === "goal") {
        context.goals.set(raw.goal_plus_id, raw);
        for (const task of raw.search_tasks || []) if (task.run_id) context.runGoals.set(task.run_id, raw.goal_plus_id);
      }
      if (kind === "frozen_spec") context.specs.set(raw.frozen_spec_id, raw);
    } catch (error) {
      if (kind === "agent_session") {
        coverage.workers += 1;
        coverage.failed += 1;
      }
      diagnostics.push({ relativePath: relative, code: "unreadable_state", message: error.message });
    }
  }
  const snapshots = [];
  const piSessions = [];
  const relationships = [];
  let sessionIndex;
  const getSessionIndex = () => sessionIndex ||= indexPiSessions(root);
  for (const relative of files) {
    const kind = kindFor(relative);
    if (!kind) continue;
    try {
      if (kind === "goal_event") {
        const read = await safeStableRead(root, path.join(root, relative));
        snapshots.push(...await parseGoalEvents(source, relative, read.bytes, read.stat));
        continue;
      }
      const record = rawRecords.get(relative);
      if (!record) continue;
      const { raw, bytes, stat } = record;
      if (kind === "agent_session" && raw.agent_harness !== "codex") coverage.workers += 1;
      if (kind === "agent_session" && !hasCurrentAgentSessionSchema(raw)) {
        if (raw.agent_harness !== "codex") coverage.failed += 1;
        diagnostics.push({
          relativePath: relative,
          code: "unsupported_goal_plus_schema",
          message: `Agent session ${raw.agent_session_id || path.basename(relative)} does not use the current agent_harness/runtime_provider/session_handle schema`,
        });
        continue;
      }
      if (kind === "agent_session" && !supportsCurrentAgentSession(raw)) continue;
      let payload;
      if (kind === "goal") payload = goalPayload(raw);
      else if (kind === "run") payload = runPayload(raw, context.specs.get(raw.frozen_spec_id));
      else if (kind === "candidate") payload = candidatePayload(raw);
      else if (kind === "agent_session") payload = sessionPayload(raw);
      else if (kind === "frozen_spec") payload = frozenSpecPayload(raw);
      else if (kind === "report_meta") payload = reportMetaPayload(raw, stat, relative);
      else payload = normalize(raw, { keepRelativePaths: true });
      const hash = contentHash(bytes);
      const objectKey = objectKeyFor(kind, raw, relative);
      snapshots.push(boundSnapshot({
        format: FORMAT,
        version: VERSION,
        snapshotId: snapshotId(source.sourceId, kind, objectKey, hash),
        sourceId: source.sourceId,
        kind,
        objectKey,
        parentKeys: parentKeys(kind, raw, relative, context),
        sourceSchemaVersion: Number(raw.schema_version) || 1,
        contentHash: hash,
        observedAt: new Date(stat.mtimeMs).toISOString(),
        payload,
        redaction: { contentMode: "bounded", truncatedFields: [], removedFields: ["absolute-paths", "logs", "secrets", "hidden-evaluation-content"] },
      }));
      if (kind === "agent_session") {
        coverage.supported += 1;
        const sessionSource = await piWorkerSessionSource(root, raw, getSessionIndex);
        if (sessionSource) {
          const metadata = raw.session_handle.metadata || {};
          const runnerFailed = metadata.runner_failed === true;
          const timedOut = metadata.timed_out === true;
          const progressStatus = String(metadata.terminal_state || metadata.progress_handoff?.status || "").toLowerCase() || undefined;
          const exitCode = metadata.pi_metrics?.exit_code ?? metadata.exit_code;
          const controlledTermination = !runnerFailed
            && !timedOut
            && progressStatus === "completed"
            && [-15, 143].includes(Number(exitCode));
          const descriptor = {
            sourceId: source.sourceId,
            agentSessionId: raw.agent_session_id,
            canonicalSessionId: `goal-plus:${source.sourceId}:${raw.agent_session_id}`,
            goalId: context.runGoals.get(raw.run_id),
            runId: raw.run_id,
            candidateId: raw.candidate_id,
            role: payload.role,
            agentHarness: raw.agent_harness,
            runtimeProvider: raw.runtime_provider,
            executionScope: raw.execution_scope,
            nativeSessionId: raw.session_handle.external_id,
            sessionFile: sessionSource.sessionFile,
            sessionFormat: sessionSource.sessionFormat,
            runnerFailed,
            timedOut,
            progressStatus,
            controlledTermination,
            runtimeBudgetSeconds: metadata.budget_control?.max_runtime_seconds
              ?? raw.launch?.budget_control?.max_runtime_seconds,
            terminalState: runnerFailed
              ? "failed"
              : timedOut
                ? "timed_out"
                : progressStatus === "completed"
                  ? "completed"
                  : metadata.pi_metrics?.stop_reason
                    || metadata.terminal_state,
            exitCode,
            errorMessage: metadata.model_failure || metadata.error,
          };
          coverage.found += 1;
          piSessions.push(descriptor);
          const goal = context.goals.get(descriptor.goalId);
          const invocation = goal && initialPiStartInvocation(goal);
          if (goal && invocation) {
            relationships.push(goalPlusWorkerRelationship(
              invocation.session_id,
              goal.goal_plus_id,
              descriptor,
            ));
          } else {
            diagnostics.push({
              relativePath: relative,
              code: "missing_pi_main_invocation",
              message: `No Pi start invocation identifies the main session for ${raw.agent_session_id}`,
            });
          }
        }
        else {
          coverage.pending += 1;
          diagnostics.push({
            relativePath: relative,
            code: "missing_pi_session_file",
            message: `No Pi native session file was recorded for ${raw.agent_session_id}; retrying on the next scan`,
          });
        }
      }
    } catch (error) {
      if (kind === "agent_session") {
        if (error.code === "pi_session_pending") coverage.pending += 1;
        else coverage.failed += 1;
      }
      diagnostics.push({ relativePath: relative, code: error.code || "parse_failed", message: error.message });
    }
  }
  return { snapshots, piSessions, relationships, diagnostics, coverage, scannedFiles: files.length };
}

module.exports = {
  contentHash,
  boundSnapshot,
  hasCurrentAgentSessionSchema,
  initialPiStartInvocation,
  parseGoalPlusRoot,
  piWorkerSessionSource,
  safeStableRead,
  supportsCurrentAgentSession,
  snapshotId,
};
