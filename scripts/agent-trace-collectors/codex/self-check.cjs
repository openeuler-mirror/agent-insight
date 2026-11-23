#!/usr/bin/env node
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

const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const { HOOK_EVENTS } = require("./codex-trace-core.cjs");
const { COLLECTOR_VERSION, handlerMatches, OTEL_BEGIN, OTEL_END } = require("./config-core.cjs");
const { loadCollectorConfig } = require("./relay.cjs");
const { sha256 } = require("../shared/trace-transport.cjs");

function relayStatus(config) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: config.relayPort,
      path: "/status",
      method: "GET",
      headers: {
        "x-agent-insight-relay": config.installSecret,
      },
      timeout: 500,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Relay returned HTTP ${response.statusCode}`));
          return;
        }
        resolve({ ...JSON.parse(Buffer.concat(chunks).toString("utf8")), connected: true });
      });
    });
    request.on("timeout", () => request.destroy(new Error("Relay status timed out")));
    request.on("error", reject);
    request.end();
  });
}

function relayDesktopStatus(config) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: config.relayPort,
      path: "/desktop/status",
      method: "GET",
      headers: { "x-agent-insight-relay": config.installSecret },
      timeout: 500,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Relay desktop status returned HTTP ${response.statusCode}`));
          return;
        }
        resolve({ ...JSON.parse(Buffer.concat(chunks).toString("utf8")), connected: true });
      });
    });
    request.on("timeout", () => request.destroy(new Error("Relay desktop status timed out")));
    request.on("error", reject);
    request.end();
  });
}

function zstdSupported() {
  return typeof zlib.zstdDecompressSync === "function" || typeof zlib.zstdDecompress === "function";
}

async function countDesktopSessions(directory) {
  let plain = 0;
  let compressed = 0;
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(candidate);
      else if (entry.isFile()) {
        if (/^rollout-.*\.jsonl\.zst$/i.test(entry.name)) compressed += 1;
        else if (/^rollout-.*\.jsonl$/i.test(entry.name)) plain += 1;
      }
    }
  }
  await walk(directory);
  return { dir: directory, plain, compressed, total: plain + compressed };
}

function hookTrustSummary(codexConfig, hooksPath) {
  const prefix = `${hooksPath}:`;
  const trusted = new Set();
  let currentKey;
  for (const rawLine of String(codexConfig).split(/\r?\n/)) {
    const line = rawLine.trim();
    const table = /^\[hooks\.state\.'(.*)'\]$/.exec(line) || /^\[hooks\.state\."(.*)"\]$/.exec(line);
    if (table) {
      currentKey = table[1].replaceAll("\\\\", "\\");
      continue;
    }
    if (line.startsWith("[")) {
      currentKey = undefined;
      continue;
    }
    if (currentKey && /^trusted_hash\s*=\s*".+"/.test(line)) trusted.add(currentKey);
  }
  const expectedEvents = HOOK_EVENTS.map((event) =>
    event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase());
  const missingEvents = expectedEvents.filter((event) =>
    ![...trusted].some((key) => key.startsWith(`${prefix}${event}:`)));
  return { trustedEntries: trusted.size, expectedEvents: expectedEvents.length, missingEvents };
}

async function check(configPath) {
  const config = loadCollectorConfig(configPath);
  const collectorDir = path.dirname(config.configPath);
  const state = JSON.parse(
    await fs.readFile(path.join(collectorDir, "install-state.json"), "utf8"),
  );
  const hooks = JSON.parse(await fs.readFile(state.hooksPath, "utf8"));
  const missingHooks = HOOK_EVENTS.filter((eventName) => !(
    Array.isArray(hooks.hooks?.[eventName]) &&
    hooks.hooks[eventName].some((group) =>
      Array.isArray(group?.hooks) &&
      group.hooks.some((handler) => handlerMatches(handler, state.handlerPath)),
    )
  ));
  const handlerHash = sha256(await fs.readFile(state.handlerPath));
  const codexConfig = await fs.readFile(state.codexConfigPath, "utf8");
  const otelConfigured = codexConfig.includes(OTEL_BEGIN) && codexConfig.includes(OTEL_END);
  const status = await relayStatus(config).catch((error) => ({ connected: false, error: error.message }));
  const desktopStatus = await relayDesktopStatus(config).catch((error) => ({ connected: false, error: error.message }));
  const appServerProxyPath = path.join(collectorDir, "app-server-proxy.cjs");
  const rolloutReaderPath = path.join(collectorDir, "rollout-reader.cjs");
  const desktopAssetsPresent = await Promise.all([
    fs.access(appServerProxyPath),
    fs.access(rolloutReaderPath),
  ]).then(() => true).catch(() => false);
  const zstd = zstdSupported();
  const desktopSessionsDir = config.desktopSessionsDir
    || path.join(config.homeDir || os.homedir(), ".codex", "sessions");
  const desktopSessions = await countDesktopSessions(desktopSessionsDir)
    .catch((error) => ({ dir: desktopSessionsDir, error: error.message, plain: 0, compressed: 0, total: 0 }));
  const hookTrust = hookTrustSummary(codexConfig, state.hooksPath);
  const warnings = [];
  if (config.desktopRolloutIngress && !zstd) {
    warnings.push("Desktop rollout is enabled but this Node.js does not support zstd; compressed rollout sessions will be skipped. Upgrade Node.js to >= 22.15.");
  }
  if (desktopSessions.compressed > 0 && !zstd) {
    warnings.push(`Found ${desktopSessions.compressed} compressed rollout file(s), but zstd is unavailable in ${process.version}.`);
  }
  if (hookTrust.missingEvents.length > 0) {
    warnings.push(`Codex hook trust is missing for ${hookTrust.missingEvents.length} event(s); run /hooks in Codex and trust the Agent Insight handlers.`);
  }
  return {
    ok: missingHooks.length === 0 &&
      handlerHash === state.handlerSha256 &&
      (otelConfigured || Boolean(state.otelConflict)) &&
      status.connected === true &&
      desktopStatus.connected === true &&
      desktopAssetsPresent &&
      (zstd || !config.desktopRolloutIngress),
    collectorVersion: COLLECTOR_VERSION,
    installedCollectorVersion: state.collectorVersion,
    nodeVersion: process.version,
    zstdSupported: zstd,
    desktopSessions,
    hookTrust,
    warnings,
    missingHooks,
    handlerHashMatches: handlerHash === state.handlerSha256,
    otelConfigured,
    otelConflict: state.otelConflict,
    relay: status,
    desktop: desktopStatus,
    desktopAssetsPresent,
  };
}

async function main() {
  const result = await check(process.argv[2]);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.warnings?.length) {
    process.stdout.write(`Warnings:\n${result.warnings.map((warning) => ` - ${warning}`).join("\n")}\n`);
  }
  process.stdout.write([
    "Hook trust is maintained by Codex and cannot be written by this installer.",
    "Start Codex, run /hooks, review the Agent Insight command path, choose Trust,",
    "restart Codex, and run a test prompt before checking Agent Insight.",
  ].join(" ") + "\n");
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Agent Insight Codex self-check failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { check, relayStatus, relayDesktopStatus };
