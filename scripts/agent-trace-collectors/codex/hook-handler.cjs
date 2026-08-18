/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { loadCollectorConfig } = require("./relay.cjs");

const MAX_STDIN_BYTES = 1024 * 1024;

function readStdin(limit = MAX_STDIN_BYTES, input = process.stdin) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    input.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        reject(new Error("Codex Hook payload exceeds 1 MiB"));
        input.destroy();
        return;
      }
      chunks.push(chunk);
    });
    input.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(new Error(`Invalid Codex Hook JSON: ${error.message}`));
      }
    });
    input.on("error", reject);
  });
}

function postHook(config, payload, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = http.request({
      hostname: "127.0.0.1",
      port: config.relayPort,
      path: "/hook",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-agent-insight-relay": config.installSecret,
      },
      timeout: timeoutMs,
    }, (response) => {
      response.resume();
      response.on("end", () => {
        if (response.statusCode >= 200 && response.statusCode < 300) resolve();
        else reject(new Error(`Relay returned HTTP ${response.statusCode}`));
      });
    });
    request.on("timeout", () => request.destroy(new Error("Relay request timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

function startRelay(config) {
  const relayPath = path.join(path.dirname(config.configPath), "relay.cjs");
  const child = spawn(process.execPath, [relayPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      AGENT_INSIGHT_CODEX_CONFIG: config.configPath,
    },
  });
  child.unref();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deliverHook(config, payload, options = {}) {
  const attempts = options.attempts || 3;
  const waitMs = options.waitMs || 75;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await postHook(config, payload, options.timeoutMs || 500);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 0 && options.startRelay !== false) startRelay(config);
      if (attempt + 1 < attempts) await delay(waitMs);
    }
  }
  throw lastError || new Error("Unable to deliver Codex Hook");
}

async function limitedLog(config, error) {
  const logPath = path.join(path.dirname(config.configPath), "collector.log");
  try {
    const stat = await fsp.stat(logPath).catch(() => undefined);
    if (stat && Date.now() - stat.mtimeMs < 60_000) return;
    const message = String(error?.message || error).replace(/[\r\n]+/g, " ").slice(0, 300);
    await fsp.appendFile(logPath, `${new Date().toISOString()} ${message}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {}
}

async function main() {
  let config;
  try {
    config = loadCollectorConfig();
    if (!config.enabled) return;
    const payload = await readStdin();
    await deliverHook(config, payload);
  } catch (error) {
    if (config) await limitedLog(config, error);
  }
}

if (require.main === module) {
  main().finally(() => {
    process.exitCode = 0;
  });
}

module.exports = {
  MAX_STDIN_BYTES,
  deliverHook,
  postHook,
  readStdin,
  startRelay,
};
