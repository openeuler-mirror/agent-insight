/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  acquireProcessLock,
  atomicWriteJson,
  collectorStateDir,
  computeBackoffMs,
  releaseProcessLock,
  sha256,
  truncateCodePoints,
} = require("./trace-transport.cjs");

const KINDS = new Set(["session", "event"]);

function stableJson(value) {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function goalPlusCollaborationId(initialPiSessionId, goalPlusId) {
  return `gp.${sha256(`${initialPiSessionId}\0${goalPlusId}`).slice(0, 32)}`;
}

function goalPlusWorkerSessionId(runId, agentSessionId) {
  return `worker:${runId}:${agentSessionId}`;
}

function goalPlusWorkerEventId(runId, agentSessionId) {
  return `worker.${sha256(`${runId}\0${agentSessionId}`).slice(0, 32)}`;
}

function goalPlusMainBinding(initialPiSessionId, goalPlusId, traceSessionId) {
  return {
    collaborationId: goalPlusCollaborationId(initialPiSessionId, goalPlusId),
    sessionId: "main",
    traceSessionId,
    eventClock: "source_session",
  };
}

function goalPlusWorkerRelationship(initialPiSessionId, goalPlusId, descriptor) {
  const collaborationId = goalPlusCollaborationId(initialPiSessionId, goalPlusId);
  const sessionId = goalPlusWorkerSessionId(descriptor.runId, descriptor.agentSessionId);
  return {
    binding: {
      collaborationId,
      sessionId,
      traceSessionId: descriptor.canonicalSessionId,
      eventClock: "unknown",
    },
    event: {
      collaborationId,
      eventId: goalPlusWorkerEventId(descriptor.runId, descriptor.agentSessionId),
      fromSessionId: "main",
      toSessionId: sessionId,
      description: `Goal Plus worker ${descriptor.candidateId || descriptor.agentSessionId}`,
      fromLocator: { recordType: "tool", name: "goal_plus_session_run" },
    },
  };
}

function relationKey(kind, body) {
  if (!KINDS.has(kind)) throw new Error(`Unsupported collaboration record kind: ${kind}`);
  const logicalId = kind === "session"
    ? `${body.collaborationId}\0${body.sessionId}`
    : `${body.collaborationId}\0${body.eventId}`;
  return `${kind}-${sha256(logicalId).slice(0, 40)}.json`;
}

function relationshipStateDir(framework, apiKey, homeDir) {
  return path.join(collectorStateDir(framework, apiKey, homeDir), "relationships");
}

async function readRecord(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function countJson(directory) {
  return (await fsp.readdir(directory).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  })).filter((name) => name.endsWith(".json")).length;
}

class DurableCollaborationOutbox {
  constructor(options) {
    this.framework = options.framework;
    this.apiKey = options.apiKey;
    this.sessionsEndpoint = options.sessionsEndpoint;
    this.eventsEndpoint = options.eventsEndpoint;
    this.stateDir = options.stateDir || relationshipStateDir(
      options.framework,
      options.apiKey,
      options.homeDir,
    );
    this.fetch = options.fetch || globalThis.fetch;
    this.now = options.now || Date.now;
    this.retry = options.retry || {};
    this.maxPerFlush = Number.isSafeInteger(options.maxPerFlush) && options.maxPerFlush > 0
      ? options.maxPerFlush
      : 20;
    if (typeof this.fetch !== "function") throw new Error("A fetch implementation is required");
  }

  async enqueue(kind, body) {
    const name = relationKey(kind, body);
    const bodyJson = stableJson(body);
    for (const bucket of ["delivered", "rejected", "pending"]) {
      const existingPath = path.join(this.stateDir, bucket, name);
      const existing = await readRecord(existingPath);
      if (!existing) continue;
      if (stableJson(existing.body) === bodyJson) return { queued: bucket === "pending", state: bucket };
      const rejectedPath = path.join(this.stateDir, "rejected", `${name.slice(0, -5)}-conflict.json`);
      await atomicWriteJson(rejectedPath, {
        version: 1,
        kind,
        body,
        rejectedAt: new Date(this.now()).toISOString(),
        error: "local immutable collaboration record conflict",
      });
      return { queued: false, state: "rejected", conflict: true };
    }
    await atomicWriteJson(path.join(this.stateDir, "pending", name), {
      version: 1,
      kind,
      body,
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: new Date(this.now()).toISOString(),
    });
    return { queued: true, state: "pending" };
  }

  enqueueSession(body) {
    return this.enqueue("session", body);
  }

  enqueueEvent(body) {
    return this.enqueue("event", body);
  }

  async enqueueRelationships(relationships) {
    let queued = 0;
    let rejected = 0;
    for (const relationship of relationships || []) {
      for (const [kind, body] of [["session", relationship.binding], ["event", relationship.event]]) {
        const result = await this.enqueue(kind, body);
        if (result.queued) queued += 1;
        if (result.state === "rejected") rejected += 1;
      }
    }
    return { queued, rejected };
  }

  endpoint(kind) {
    return kind === "session" ? this.sessionsEndpoint : this.eventsEndpoint;
  }

  async post(record) {
    const endpoint = this.endpoint(record.kind);
    if (!endpoint) throw new Error(`Agent Insight collaboration ${record.kind} endpoint is required`);
    const response = await this.fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-witty-api-key": this.apiKey,
      },
      body: JSON.stringify(record.body),
    });
    const message = truncateCodePoints(await response.text().catch(() => ""), 512);
    return { status: response.status, message };
  }

  async flushOnce() {
    await fsp.mkdir(path.join(this.stateDir, "pending"), { recursive: true, mode: 0o700 });
    const lock = await acquireProcessLock(path.join(this.stateDir, "uploader.lock"));
    if (!lock) return { acquired: false, uploaded: 0, retried: 0, rejected: 0, deferred: 0 };
    let uploaded = 0;
    let retried = 0;
    let rejected = 0;
    let deferred = 0;
    try {
      const names = (await fsp.readdir(path.join(this.stateDir, "pending")))
        .filter((name) => name.endsWith(".json"))
        .sort();
      let attempted = 0;
      for (const name of names) {
        if (attempted >= this.maxPerFlush) {
          deferred += 1;
          continue;
        }
        const pendingPath = path.join(this.stateDir, "pending", name);
        const record = await readRecord(pendingPath);
        if (!record) continue;
        if (Number(record.nextAttemptAt || 0) > this.now()) {
          deferred += 1;
          continue;
        }
        attempted += 1;
        let response;
        let networkError;
        try {
          response = await this.post(record);
        } catch (error) {
          networkError = error;
        }
        if (response && response.status >= 200 && response.status < 300) {
          await fsp.mkdir(path.join(this.stateDir, "delivered"), { recursive: true, mode: 0o700 });
          await atomicWriteJson(path.join(this.stateDir, "delivered", name), {
            ...record,
            deliveredAt: new Date(this.now()).toISOString(),
          });
          await fsp.unlink(pendingPath).catch(() => undefined);
          uploaded += 1;
          continue;
        }
        const retryable = networkError || response?.status === 429 || Number(response?.status) >= 500;
        if (retryable) {
          const attempts = Number(record.attempts || 0) + 1;
          await atomicWriteJson(pendingPath, {
            ...record,
            attempts,
            nextAttemptAt: this.now() + computeBackoffMs(attempts - 1, this.retry),
            lastError: truncateCodePoints(networkError?.message || `HTTP ${response?.status}: ${response?.message || ""}`, 512),
          });
          retried += 1;
          continue;
        }
        await fsp.mkdir(path.join(this.stateDir, "rejected"), { recursive: true, mode: 0o700 });
        await atomicWriteJson(path.join(this.stateDir, "rejected", name), {
          ...record,
          rejectedAt: new Date(this.now()).toISOString(),
          status: response?.status,
          error: truncateCodePoints(response?.message || "deterministic collaboration upload failure", 512),
        });
        await fsp.unlink(pendingPath).catch(() => undefined);
        rejected += 1;
      }
      return { acquired: true, uploaded, retried, rejected, deferred };
    } finally {
      await releaseProcessLock(lock);
    }
  }

  async status() {
    return {
      pending: await countJson(path.join(this.stateDir, "pending")),
      rejected: await countJson(path.join(this.stateDir, "rejected")),
      delivered: await countJson(path.join(this.stateDir, "delivered")),
    };
  }
}

module.exports = {
  DurableCollaborationOutbox,
  goalPlusCollaborationId,
  goalPlusMainBinding,
  goalPlusWorkerEventId,
  goalPlusWorkerRelationship,
  goalPlusWorkerSessionId,
  relationKey,
  relationshipStateDir,
  stableJson,
};
