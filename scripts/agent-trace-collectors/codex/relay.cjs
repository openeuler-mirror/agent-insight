/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { CodexTraceCore } = require("./codex-trace-core.cjs");
const {
  DurableTraceUploader,
  DurableTraceWriter,
  acquireProcessLock,
  appendJsonl,
  atomicWriteJson,
  collectorStateDir,
  readCheckpoint,
  readJsonlBatch,
  redactValue,
  releaseProcessLock,
} = require("../shared/trace-transport.cjs");

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function defaultCollectorDir(homeDir = os.homedir()) {
  return path.join(homeDir, ".agent-insight", "collectors", "codex");
}

function loadCollectorConfig(configPath = process.env.AGENT_INSIGHT_CODEX_CONFIG) {
  const resolved = configPath || path.join(defaultCollectorDir(), "config.json");
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!parsed.apiKey || !parsed.endpoint || !parsed.installSecret) {
    throw new Error("Codex collector config is missing apiKey, endpoint, or installSecret");
  }
  return {
    enabled: parsed.enabled !== false,
    apiKey: String(parsed.apiKey),
    endpoint: String(parsed.endpoint),
    installSecret: String(parsed.installSecret),
    relayPort: Number(parsed.relayPort) || 43191,
    uploadIntervalMs: Number(parsed.uploadIntervalMs) || 5 * 60 * 1000,
    homeDir: parsed.homeDir || os.homedir(),
    configPath: resolved,
  };
}

function readJsonBody(request, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        reject(Object.assign(new Error("Request body is too large"), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(Object.assign(new Error(`Invalid JSON: ${error.message}`), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function writeJson(response, status, body) {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
  });
  response.end(data);
}

async function listRawFiles(stateDir) {
  const dates = await fsp.readdir(stateDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const result = [];
  for (const entry of dates) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    const candidate = path.join(stateDir, entry.name, "raw-otel.jsonl");
    try {
      if ((await fsp.stat(candidate)).isFile()) result.push(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return result.sort();
}

function rawFileFor(stateDir, timestamp = Date.now()) {
  const date = new Date(timestamp).toISOString().slice(0, 10);
  return path.join(stateDir, date, "raw-otel.jsonl");
}

async function replayRawOtel(stateDir, core) {
  const checkpointPath = path.join(stateDir, "raw-checkpoint.json");
  const checkpoint = await readCheckpoint(checkpointPath);
  let replayed = 0;
  for (const filePath of await listRawFiles(stateDir)) {
    const relative = path.relative(stateDir, filePath).replaceAll(path.sep, "/");
    let cursor = Number(checkpoint.files[relative]?.bytes) || 0;
    while (true) {
      const batch = await readJsonlBatch(filePath, cursor, {
        maxEvents: 25,
        maxBytes: 4 * 1024 * 1024,
      });
      if (batch.events.length === 0) break;
      for (const event of batch.events) {
        await core.processOtel(event.payload || event);
      }
      await core.writer.flush();
      cursor = batch.nextOffset;
      checkpoint.files[relative] = { bytes: cursor };
      await atomicWriteJson(checkpointPath, checkpoint);
      replayed += batch.events.length;
    }
  }
  return replayed;
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  if (a.length !== b.length) return false;
  return require("node:crypto").timingSafeEqual(a, b);
}

function authorized(request, secret) {
  return constantTimeEqual(request.headers["x-agent-insight-relay"], secret);
}

async function createRelay(options = {}) {
  const config = options.config || loadCollectorConfig(options.configPath);
  const stateDir = options.stateDir || collectorStateDir("codex", config.apiKey, config.homeDir);
  const writer = options.writer || new DurableTraceWriter({
    framework: "codex",
    apiKey: config.apiKey,
    stateDir,
  });
  const uploader = options.uploader || new DurableTraceUploader({
    framework: "codex",
    apiKey: config.apiKey,
    endpoint: config.endpoint,
    stateDir,
    fetch: options.fetch,
    maxRetries: options.maxRetries,
    sleep: options.sleep,
    retry: options.retry,
  });
  const core = options.core || new CodexTraceCore({ writer, now: options.now });
  const sessionStatePath = path.join(stateDir, "relay-session-state.json");
  const processStatePath = path.join(stateDir, "relay-state.json");
  const lockPath = path.join(stateDir, "relay.lock");
  let lock;
  let server;
  let rawPending = Promise.resolve();

  try {
    core.restore(JSON.parse(await fsp.readFile(sessionStatePath, "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }

  const persistState = async () => {
    await atomicWriteJson(sessionStatePath, core.snapshot());
  };

  const flushSoon = () => {
    uploader.flushOnce().catch(() => {});
  };

  const handler = async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    try {
      if (!authorized(request, config.installSecret)) {
        writeJson(response, 401, { error: "Unauthorized relay request" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/status") {
        writeJson(response, 200, core.status());
        return;
      }

      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const body = await readJsonBody(request);
      if (url.pathname === "/hook") {
        const result = await core.processHook(body);
        await writer.flush();
        await persistState();
        if (result.flush) flushSoon();
        writeJson(response, 200, {});
        return;
      }

      if (url.pathname === "/v1/logs") {
        const processRaw = async () => {
          const filePath = rawFileFor(stateDir);
          await appendJsonl(filePath, {
            receivedAt: new Date().toISOString(),
            payload: redactValue(body),
          });
          await core.processOtel(body);
          await writer.flush();
          const stat = await fsp.stat(filePath);
          const checkpointPath = path.join(stateDir, "raw-checkpoint.json");
          const checkpoint = await readCheckpoint(checkpointPath);
          const relative = path.relative(stateDir, filePath).replaceAll(path.sep, "/");
          checkpoint.files[relative] = { bytes: stat.size };
          await atomicWriteJson(checkpointPath, checkpoint);
          await persistState();
        };
        // Keep serialization, but do not let one malformed native batch poison
        // the relay permanently. The failed request remains a 500; its successor
        // starts after the rejection has been observed and can be persisted.
        const processing = rawPending.catch(() => undefined).then(processRaw);
        rawPending = processing.catch(() => undefined);
        await processing;
        writeJson(response, 200, { partialSuccess: {} });
        return;
      }

      if (url.pathname === "/ide-event") {
        const result = await core.processIdeEvent(body);
        await writer.flush();
        await persistState();
        writeJson(response, 200, result);
        return;
      }

      if (url.pathname === "/lease") {
        core.updateLease(body.clientId, body.action);
        writeJson(response, 200, core.status());
        return;
      }

      if (url.pathname === "/flush") {
        await writer.flush();
        const result = await uploader.flushOnce();
        writeJson(response, 200, result);
        return;
      }

      writeJson(response, 404, { error: "Not found" });
    } catch (error) {
      if (!response.headersSent) {
        writeJson(response, error?.status || 500, {
          error: error?.message || "Relay request failed",
        });
      } else {
        response.end();
      }
    }
  };

  return {
    config,
    core,
    stateDir,
    uploader,
    writer,
    async start() {
      await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
      lock = await acquireProcessLock(lockPath);
      if (!lock) throw new Error("Codex relay is already running");
      await replayRawOtel(stateDir, core);
      await writer.flush();
      server = http.createServer((request, response) => {
        handler(request, response).catch((error) => {
          if (!response.headersSent) writeJson(response, 500, { error: error.message });
        });
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(
          options.port === undefined ? config.relayPort : options.port,
          "127.0.0.1",
          resolve,
        );
      });
      const address = server.address();
      await atomicWriteJson(processStatePath, {
        version: 1,
        pid: process.pid,
        port: address.port,
        startedAt: new Date().toISOString(),
      });
      uploader.start(config.uploadIntervalMs);
      return address;
    },
    address() {
      return server?.address();
    },
    async stop({ flush = false } = {}) {
      uploader.stop();
      await writer.flush();
      if (flush) {
        await Promise.race([
          uploader.flushOnce().catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 2500)),
        ]);
      }
      if (server) {
        await new Promise((resolve) => server.close(resolve));
        server = undefined;
      }
      await fsp.unlink(processStatePath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      await releaseProcessLock(lock);
      lock = undefined;
    },
  };
}

async function main() {
  const relay = await createRelay();
  await relay.start();
  const shutdown = async () => {
    await relay.stop({ flush: true }).catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Agent Insight Codex relay failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  createRelay,
  defaultCollectorDir,
  listRawFiles,
  loadCollectorConfig,
  rawFileFor,
  replayRawOtel,
};
