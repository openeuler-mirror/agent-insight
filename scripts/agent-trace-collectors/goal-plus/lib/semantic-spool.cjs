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
} = require("../../shared/trace-transport.cjs");

const RETRYABLE = new Set([409, 429, 500, 502, 503, 504]);

function semanticStateDir(apiKey, homeDir) {
  return path.join(collectorStateDir("goal-plus", apiKey, homeDir), "semantic");
}

async function enqueueSemanticBatch(batch, options) {
  const stateDir = semanticStateDir(options.apiKey, options.homeDir);
  const payload = JSON.stringify(batch);
  const key = sha256(payload);
  const completed = Date.parse(batch.source?.semanticCheckpoint?.scanStartedAt || batch.source?.scanCompletedAt || "") || Date.now();
  const ordinal = Number(batch.source?.semanticCheckpoint?.batchOrdinal || 0);
  const prefix = `${String(completed).padStart(13, "0")}-${String(ordinal).padStart(4, "0")}`;
  const filePath = path.join(stateDir, "pending", `${prefix}-${key}.json`);
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await fsp.writeFile(filePath, `${payload}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return filePath;
}

async function listPending(stateDir) {
  const directory = path.join(stateDir, "pending");
  try {
    return (await fsp.readdir(directory))
      .filter(name => name.endsWith(".json"))
      .sort()
      .map(name => path.join(directory, name));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function uploadSemanticBatches(options) {
  const stateDir = semanticStateDir(options.apiKey, options.homeDir);
  const lock = await acquireProcessLock(path.join(stateDir, "uploader.lock"));
  if (!lock) return { acquired: false, uploadedBatches: 0, uploadedSnapshots: 0 };
  let uploadedBatches = 0;
  let uploadedSnapshots = 0;
  try {
    for (const filePath of await listPending(stateDir)) {
      const payload = await fsp.readFile(filePath, "utf8");
      let response;
      const maxAttempts = Math.max(1, options.maxAttempts || 3);
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          response = await (options.fetch || fetch)(options.endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-witty-api-key": options.apiKey,
            },
            body: payload,
            signal: AbortSignal.timeout(options.timeoutMs || 15000),
          });
        } catch (error) {
          error.retryable = true;
          if (attempt + 1 >= maxAttempts) throw error;
          const delay = computeBackoffMs(attempt, { baseMs: 250, maxMs: 4000, jitter: 0.2 });
          await (options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))))(delay);
          continue;
        }
        if (!RETRYABLE.has(response.status) || attempt + 1 >= maxAttempts) break;
        const delay = computeBackoffMs(attempt, { baseMs: 250, maxMs: 4000, jitter: 0.2 });
        await (options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))))(delay);
      }
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(`Goal Plus upload failed with HTTP ${response.status}`);
        error.retryable = RETRYABLE.has(response.status);
        if (!error.retryable) {
          await fsp.mkdir(path.join(stateDir, "rejected"), { recursive: true, mode: 0o700 });
          await fsp.rename(filePath, path.join(stateDir, "rejected", path.basename(filePath)));
          continue;
        }
        throw error;
      }
      const batch = JSON.parse(payload);
      const rejected = Array.isArray(result.rejected) ? result.rejected : [];
      if (rejected.length) {
        await fsp.mkdir(path.join(stateDir, "rejected"), { recursive: true, mode: 0o700 });
        await fsp.rename(filePath, path.join(stateDir, "rejected", path.basename(filePath)));
      } else {
        await fsp.unlink(filePath);
        await atomicWriteJson(path.join(stateDir, "checkpoint.json"), {
          version: 1,
          sourceId: batch.source?.sourceId,
          scanCompletedAt: batch.source?.scanCompletedAt,
          snapshotIds: batch.snapshots?.map(snapshot => snapshot.snapshotId) || [],
          acknowledgedAt: new Date().toISOString(),
        });
      }
      uploadedBatches += 1;
      uploadedSnapshots += Number(result.accepted || 0) + Number(result.duplicate || 0);
    }
    return { acquired: true, uploadedBatches, uploadedSnapshots };
  } finally {
    await releaseProcessLock(lock);
  }
}

module.exports = { enqueueSemanticBatch, semanticStateDir, uploadSemanticBatches };
