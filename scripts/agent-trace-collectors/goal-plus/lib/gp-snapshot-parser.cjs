/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const { safeContent, sha256 } = require("../../shared/trace-transport.cjs");

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

async function safeStableRead(root, filePath) {
  const canonicalRoot = await fsp.realpath(root);
  const requested = path.resolve(filePath);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const initial = await fsp.lstat(requested);
    if (!initial.isFile() || initial.isSymbolicLink()) throw new Error("not a regular non-symlink file");
    if (initial.size > MAX_FILE_BYTES) throw new Error("file exceeds collector size limit");
    const canonical = await fsp.realpath(requested);
    if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new Error("file resolves outside attached .gp root");
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
  const metadata = source.host_handle?.metadata || {};
  return normalize({
    agent_session_id: source.agent_session_id,
    run_id: source.run_id,
    candidate_id: source.candidate_id,
    host: source.host,
    role: source.directive?.role || source.launch?.role || "candidate-worker",
    native_session_id: source.host_handle?.external_id || metadata.native_session_id,
    task_name: source.host_handle?.task_name || source.launch?.task_name,
    transcript_fingerprint: metadata.transcript_fingerprint,
    host_handle: {
      host: source.host_handle?.host,
      external_id: source.host_handle?.external_id,
      task_name: source.host_handle?.task_name,
      nickname: source.host_handle?.nickname,
    },
    selected_model: source.selected_model,
    usage: metadata.usage || metadata.pi_metrics?.usage,
    host_metadata: {
      continuation: metadata.continuation || source.launch?.continuation,
      pi_metrics: metadata.pi_metrics ? normalize(metadata.pi_metrics) : undefined,
      codex_conversation_id: metadata.codex_conversation_id || metadata.conversation_id,
      codex_turn_id: metadata.codex_turn_id || metadata.turn_id,
      codex_execution_id: metadata.codex_execution_id || metadata.execution_id,
    },
    counters: source.counters,
    created_at: source.created_at,
    updated_at: source.updated_at,
  });
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
    if (entry.isDirectory()) files.push(...await walk(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

async function parseGoalEvents(source, relative, bytes, stat, context) {
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
  const context = { runGoals: new Map(), specs: new Map() };
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
        for (const task of raw.search_tasks || []) if (task.run_id) context.runGoals.set(task.run_id, raw.goal_plus_id);
      }
      if (kind === "frozen_spec") context.specs.set(raw.frozen_spec_id, raw);
    } catch (error) {
      diagnostics.push({ relativePath: relative, code: "unreadable_state", message: error.message });
    }
  }
  const snapshots = [];
  const piSessions = [];
  for (const relative of files) {
    const kind = kindFor(relative);
    if (!kind) continue;
    try {
      if (kind === "goal_event") {
        const read = await safeStableRead(root, path.join(root, relative));
        snapshots.push(...await parseGoalEvents(source, relative, read.bytes, read.stat, context));
        continue;
      }
      const record = rawRecords.get(relative);
      if (!record) continue;
      const { raw, bytes, stat } = record;
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
      if (kind === "agent_session" && raw.host === "pi-rpc") {
        const sessionFile = raw.host_handle?.metadata?.session_file || raw.host_handle?.metadata?.pi_metrics?.session_file;
        if (sessionFile) piSessions.push({
          sourceId: source.sourceId,
          agentSessionId: raw.agent_session_id,
          runId: raw.run_id,
          candidateId: raw.candidate_id,
          role: payload.role,
          sessionFile,
        });
      }
    } catch (error) {
      diagnostics.push({ relativePath: relative, code: "parse_failed", message: error.message });
    }
  }
  return { snapshots, piSessions, diagnostics, scannedFiles: files.length };
}

module.exports = {
  contentHash,
  boundSnapshot,
  parseGoalPlusRoot,
  safeStableRead,
  snapshotId,
};
